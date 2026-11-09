"use strict";
const VALID_URL = /^https:\/\/(?:www\.)?parroto\.app\//i;
const PARROTO_PAGES = ["https://parroto.app/*", "https://www.parroto.app/*"];
const VERSION = chrome.runtime.getManifest().version;
const activeCaptures = new Set();
const captureMetrics = new Map();
const tabOperations = new Map();
let captureOperations = Promise.resolve();
// TTS online trả MP3/PCM và được giải mã trong trang để cấp vào microphone ảo.
let documentCreation = null;

// Phần TTS trực tuyến được phát triển từ ý tưởng / hàm fetchTts của
// edge-tts-mic-v1.2.0 do người dùng cung cấp. Nguồn Google Translate không
// phải API được bảo đảm; HTTP 403/429, thay đổi endpoint hoặc thiếu mạng sẽ
// báo lỗi rõ ràng. Không cần API key và không gửi dữ liệu cho bên thứ ba khác.
const CHUNK_LIMIT = 170;
const FETCH_TIMEOUT = 12000;
const WAIT_BETWEEN_RETRIES = 250;

function splitTtsText(original) {
  const text = String(original || '').replace(/\s+/g, ' ').trim();
  if (text.length < 2 || text.length > 1200) throw Error('Văn bản phải dài 2–1200 ký tự.');
  const words = text.split(' ');
  const chunks=[];
  let line='';
  for (const word of words) {
    if (word.length > CHUNK_LIMIT) throw Error('Có một từ dài hơn 170 ký tự; không thể gửi tới TTS.');
    if (!line) line=word;
    else if (line.length+1+word.length<=CHUNK_LIMIT) line+=' '+word;
    else {chunks.push(line);line=word;}
  }
  if(line) chunks.push(line);
  return chunks;
}

function encodeBytes(buf) {
  const bytes=new Uint8Array(buf);
  let value='';
  for(let p=0;p<bytes.length;p+=0x6000)
    value+=String.fromCharCode(...bytes.subarray(p,p+0x6000));
  return btoa(value);
}

async function fetchOneTts(url) {
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),FETCH_TIMEOUT);
  try {
    const response=await fetch(url,{credentials:'omit',signal:ctl.signal,cache:'no-store'});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    const type=(response.headers.get('content-type')||'').toLowerCase();
    const data=await response.arrayBuffer();
    if(data.byteLength<350 || data.byteLength>2_000_000)
      throw Error('TTS không trả về âm thanh hợp lệ ('+data.byteLength+' bytes)');
    if(type.includes('text/html') || type.includes('application/json'))
      throw Error('TTS trả HTML/JSON thay cho file audio.');
    return data;
  } finally {clearTimeout(timer);}
}

async function fetchOnlineSpeech(original) {
  const parts=splitTtsText(original);
  const mp3=[];
  let totalBytes=0;
  for(const part of parts) {
    const q=encodeURIComponent(part);
    const urls=[
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${q}`,
      `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=en&q=${q}`
    ];
    let output=null, reason='unknown';
    for(const url of urls) {
      try {output=await fetchOneTts(url);break;}
      catch(err){reason=String(err?.message||err);await new Promise(r=>setTimeout(r,WAIT_BETWEEN_RETRIES));}
    }
    if(!output)throw Error('Không tải được âm thanh tiếng Anh online ('+reason+'). Kiểm tra mạng hoặc TTS đang giới hạn truy cập.');
    totalBytes+=output.byteLength;
    if(totalBytes>5_000_000)throw Error('File âm thanh vượt giới hạn 5MB.');
    mp3.push(encodeBytes(output));
  }
  return {ok:true,engine:'google_translate_tts_online',chunks:mp3,segments:parts.length,totalBytes};
}


async function verifyTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Không xác định được tab Parroto.");
  const tab = await chrome.tabs.get(tabId);
  if (!VALID_URL.test(tab?.url || "")) throw new Error("Chỉ hoạt động trên parroto.app.");
  return tab;
}

async function readTabState(tabId, target) {
  const status = await chrome.tabs.sendMessage(tabId, { type: "GET_STATE" }, target).catch(() => null);
  return status?.ok && status.version === VERSION ? status : null;
}

async function connectTab(tabId) {
  const tab = await verifyTab(tabId);
  if (tab.discarded || tab.frozen) throw new Error("Hãy mở tab Parroto để tiếp tục.");
  const status = await readTabState(tabId, { frameId: 0 });
  if (status) return status;

  // Nạp bridge trước, sau đó nạp điều khiển vào đúng tài liệu đã nhận bridge.
  const [bridge] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: "MAIN", files: ["bridge-main.js"], injectImmediately: true
  });
  if (!bridge?.documentId) throw new Error("Không xác định được trang Parroto đang mở.");
  const documentId = bridge.documentId;
  await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] }, world: "ISOLATED", files: ["content.js"]
  });
  const connected = await readTabState(tabId, { documentId });
  if (!connected) throw new Error("Chưa kết nối được với trang Parroto đang mở.");
  return connected;
}

async function ensureOffscreen() {
  if (documentCreation) return documentCreation;
  documentCreation = (async () => {
    const url = chrome.runtime.getURL("offscreen.html");
    const clients = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (!clients.length) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Phân tích chuyển động hình tab tối đa 10 FPS và chuyển âm thanh cục bộ cho bài shadowing."
      });
    }
  })();
  try { return await documentCreation; }
  finally { documentCreation = null; }
}

async function startCapture(tabId) {
  await verifyTab(tabId);
  await ensureOffscreen();
  if (activeCaptures.has(tabId)) return { ok: true, alreadyRunning: true };
  for (const previous of [...activeCaptures]) await stopCapture(previous);
  // Bắt buộc gọi từ thao tác trực tiếp trên popup extension (user gesture).
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  if (!streamId) throw new Error("Không lấy được luồng tabCapture.");
  const result = await chrome.runtime.sendMessage({ target: "offscreen", type: "CAPTURE_START", tabId, streamId });
  if (!result?.ok) throw new Error(result?.error || "Không mở được luồng video/audio tab.");
  activeCaptures.add(tabId);
  return { ok: true };
}

async function stopCapture(tabId) {
  activeCaptures.delete(tabId);
  captureMetrics.delete(tabId);
  try { await chrome.runtime.sendMessage({ target: "offscreen", type: "CAPTURE_STOP", tabId }); } catch { /* offscreen có thể đã đóng */ }
  return { ok: true };
}

const autoKey = tabId => `parrotoAuto:${tabId}`;

function queueTabOperation(tabId, operation) {
  const previous = tabOperations.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  tabOperations.set(tabId, next);
  return next.finally(() => {
    if (tabOperations.get(tabId) === next) tabOperations.delete(tabId);
  });
}

function queueCapture(operation) {
  const next = captureOperations.then(operation);
  captureOperations = next.catch(() => {});
  return next;
}

async function finishAuto(tabId, runId) {
  const key = autoKey(tabId);
  const run = (await chrome.storage.session.get(key))[key];
  if (!run || (runId && run.id !== runId)) return { ok: true };

  await queueCapture(() => stopCapture(tabId));
  if (run.restoreDiscardable) {
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: true });
    } catch (error) {
      // Nếu tab còn tồn tại, giữ thông tin để có thể khôi phục ở lần dọn tiếp theo.
      if (await chrome.tabs.get(tabId).catch(() => null)) throw error;
    }
  }
  await chrome.storage.session.remove(key);
  return { ok: true };
}

async function startAuto(tabId) {
  const status = await connectTab(tabId);
  if (status.running || status.previewing) throw new Error("Tab này đang có một lượt đọc.");

  await finishAuto(tabId);
  const tab = await verifyTab(tabId);
  const run = { id: crypto.randomUUID(), restoreDiscardable: tab.autoDiscardable === true };
  await chrome.storage.session.set({ [autoKey(tabId)]: run });
  try {
    if (run.restoreDiscardable) await chrome.tabs.update(tabId, { autoDiscardable: false });
    // Quét hình là bổ trợ. Điều khiển câu và phát giọng vẫn chạy nếu capture lỗi.
    await queueCapture(() => startCapture(tabId)).catch(() => {});
    const current = await verifyTab(tabId);
    if (new URL(tab.url).pathname !== new URL(current.url).pathname) {
      throw new Error("Tab Parroto đã chuyển sang bài khác trước khi bắt đầu.");
    }
    const result = await chrome.tabs.sendMessage(tabId, { type: "START", runId: run.id });
    if (!result?.ok) throw new Error(result?.error || "Không bật được START AUTO.");
    return result;
  } catch (error) {
    await finishAuto(tabId, run.id);
    throw error;
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  queueTabOperation(tabId, () => finishAuto(tabId)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.discarded === true) {
    queueTabOperation(tabId, () => finishAuto(tabId)).catch(() => {});
  }
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== "install" && reason !== "update") return;
  chrome.tabs.query({ url: PARROTO_PAGES }).then(tabs => Promise.allSettled(
    tabs.map(({ id }) => queueTabOperation(id, () => connectTab(id)))
  )).catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  queueTabOperation(tabId, () => connectTab(tabId)).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message !== "object" || message.target === "offscreen") return false;
  const run = async () => {
    if (message.type === "ONLINE_TTS_FETCH") {
      if (!sender.tab?.id) throw new Error("Chỉ tab Parroto được lấy giọng TTS.");
      await verifyTab(sender.tab.id);
      return fetchOnlineSpeech(message.text);
    }
    if (message.type === "START_AUTO") {
      if (sender.tab) throw new Error("Hãy bấm START trong popup của extension trên thanh công cụ.");
      return queueTabOperation(message.tabId, () => startAuto(message.tabId));
    }
    if (message.type === "CONNECT_TAB" && !sender.tab) {
      return queueTabOperation(message.tabId, () => connectTab(message.tabId));
    }
    if (message.type === "FINISH_AUTO" && sender.tab?.id && typeof message.runId === "string") {
      const tabId = sender.tab.id;
      return queueTabOperation(tabId, () => finishAuto(tabId, message.runId));
    }
    if (message.type === "AUTO_WAIT" && sender.tab?.id && VALID_URL.test(sender.url || sender.tab.url || "")) {
      // Một lần chờ ngắn từ worker, không cần đánh thức tab bằng setTimeout của trang nền.
      const delay = Math.min(1000, Math.max(0, Number(message.delay) || 0));
      await new Promise(resolve => setTimeout(resolve, delay));
      return { ok: true };
    }
    if (message.type === "VIDEO_METRICS") {
      if (!sender.url?.startsWith(chrome.runtime.getURL("offscreen.html"))) return {ok:false};
      if (!activeCaptures.has(message.tabId)) return {ok:false};
      captureMetrics.set(message.tabId, {fps:message.fps, motion:message.motion, width:message.width, height:message.height,
        blueRegions:Array.isArray(message.blueRegions)?message.blueRegions.slice(0,12):[]});
      try {await chrome.tabs.sendMessage(message.tabId, {type:"VIDEO_METRICS",...captureMetrics.get(message.tabId)});} catch{}
      return {ok:true};
    }
    if (message.type === "GET_VIDEO_METRICS") return {ok:true,...(captureMetrics.get(message.tabId)||{fps:0,motion:0})};
    return { ok: false, error: "Unknown request" };
  };
  run().then(reply, error => reply({ ok: false, error: String(error?.message || error) }));
  return true;
});
