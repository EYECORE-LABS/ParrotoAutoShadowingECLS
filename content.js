(() => {
  "use strict";
  if (!/^https:\/\/(?:www\.)?parroto\.app$/.test(location.origin)) return;
  const version = chrome.runtime.getManifest().version;
  const extensionId = chrome.runtime.id;
  const previous = window.__ECLS_PSA_CONTENT;
  if (previous?.version === version && previous.isCurrent?.()) return;
  const clientId = crypto.randomUUID();
  const instance = { version, isCurrent };
  window.__ECLS_PSA_CONTENT = instance;
  function isCurrent() {
    try { return window.__ECLS_PSA_CONTENT === instance && chrome.runtime.id === extensionId; }
    catch { return false; }
  }

  const CHANNEL = "__ECLS_PSA_V2";
  const DEFAULT_OUTPUT = "speaker-and-mic";
  const SCAN_INTERVAL_MS = 100;
  // Không lưu selector/tọa độ: mọi vị trí được tìm lại theo trạng thái DOM hiện tại.
  const OPTIONS = {
    videoWaitMs: 10000,
    maxAttemptsPerTranscript: 5,
    targetScore: 100,
    processingTimeoutMs: 45000,
    recordTransitionTimeoutMs: 11000,
    micTimeoutMs: 8000,
    voiceRate: 0.93,
    autoCloseAds: true,
    audioOutput: DEFAULT_OUTPUT
  };
  const state = {
    running: false, previewing: false, stopping: false, stage: "idle", index: 0,
    total: 0, score: null, micReady: false, bridgeReady: false,
    audioChunks: 0, loudChunks: 0, micQueuedChunks: 0, micQueuedLoud: 0, micContext: 'unknown', voiceStarted: false, voiceEngine: "none", ttsSegments:0, ttsBytes:0,
    audioWarning: "", speechErrors: 0, retryReason: "", history: [],
    message: "Mở bài Shadowing rồi nhấn START trong popup."
  };
  let panel = null, stageLabel = null, toggleBtn = null;
  let lastMessageAt = 0, lastDismissAt = 0;
  let cancelManualRecordWait = null;
  let nativeSpeechError = false;
  let autoRunId = null, autoPath = null;
  let microphoneRequest = 0;

  let controlInfo = { strategy: "unknown", details: "" };
  function sleep(ms) {
    if (!autoRunId) return new Promise(resolve => setTimeout(resolve, ms));
    const deadline = performance.now() + ms;
    const remaining = () => Math.max(0, Math.ceil(deadline - performance.now()));
    return new Promise(resolve => {
      let timer;
      function finish() {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", useWorkerClock);
        resolve();
      }
      async function useWorkerClock() {
        if (!document.hidden) return;
        document.removeEventListener("visibilitychange", useWorkerClock);
        clearTimeout(timer);
        if (isCurrent()) {
          try {
            const result = await chrome.runtime.sendMessage({ type: "AUTO_WAIT", delay: remaining() });
            if (result?.ok) { finish(); return; }
          } catch {}
        }
        timer = setTimeout(finish, remaining());
      }
      if (document.hidden) useWorkerClock();
      else {
        document.addEventListener("visibilitychange", useWorkerClock);
        timer = setTimeout(finish, ms);
      }
    });
  }
  const clean = text => String(text || "").replace(/\s+/g, " ").trim();
  const normalize = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toUpperCase();
  const controlText = value => normalize(value).replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, "").replace(/\s+/g, " ");
  const abortCheck = () => {
    if (!isCurrent()) throw new Error("Phiên extension đã đổi.");
    if (state.stopping) throw new Error("Đã dừng theo yêu cầu.");
    if (autoRunId && autoPath !== location.pathname) throw new Error("Đã chuyển sang trang khác trong tab Parroto.");
  };
  const isVisible = el => {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0" &&
      !el.closest('[aria-hidden="true"],[inert]');
  };
  function dispatch(type, other = {}) {
    if (isCurrent()) window.postMessage({ [CHANNEL]: true, channel: "CONTENT", clientId, type, ...other }, location.origin);
  }
  function enableBridge() {
    dispatch("ATTACH");
    dispatch("SET_ENABLED", { value: true });
  }

  function log(message) {
    const line = `${new Date().toLocaleTimeString("vi-VN", { hour12: false })} | ${state.stage} | ${message}`;
    state.history.push(line);
    if (state.history.length > 65) state.history.shift();
  }
  function showStatus(stage, message, extra = {}) {
    if (!isCurrent()) return;
    const changed = stage !== state.stage || message !== state.message;
    Object.assign(state, { stage, message, ...extra });
    if (changed) log(message);
    if (stageLabel) stageLabel.textContent = `${state.index}/${state.total} · ${message}`;
    if (toggleBtn) toggleBtn.textContent = state.running ? "■ DỪNG" : "↗ MỞ POPUP ĐỂ START";
    if (panel) panel.dataset.mode = stage === "error" ? "error" : state.running ? "running" : "idle";
    const now = Date.now();
    if (changed || "running" in extra || "previewing" in extra || now - lastMessageAt >= 300) {
      lastMessageAt = now;
      chrome.storage.local.set({ parrotoShadowingStatus: {
        running: state.running, previewing: state.previewing, stage, index: state.index, total: state.total,
        score: state.score, message, time: now
      }}).catch(() => {});
    }
  }

  function handleBridgeMessage(event) {
    if (!isCurrent() || event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.[CHANNEL] !== true || data.channel !== "PAGE" || data.clientId !== clientId) return;
    if (data.type === "MODE") {
      state.bridgeReady = !!data.enabled;
      state.micContext = data.audioContextState || "unknown";
      log(`Bridge: ${state.bridgeReady ? "enabled" : "disabled"}`);
    }
    if (data.type === 'SPEECH_ERROR_NATIVE') {nativeSpeechError=true;log('Parroto: cửa sổ lỗi native alert đã được chặn an toàn.');}
    if (data.type === "MIC_READY") {
      microphoneRequest++;
      state.micReady = data.subscriberTracks > 0;
      log(`Parroto đã nhận micro ảo. AudioContext=${data.audioContextState || "unknown"}.`);
    }
    if (data.type === "MIC_TRACKS") state.micReady = data.count > 0;
    if (data.type === 'AUDIO_CONTEXT') {state.micContext=data.state;log('AudioContext ảo: ' + data.state);}
    if (data.type === 'AUDIO_QUEUED') {
      state.micQueuedChunks++;
      if (data.rms > 0.003) state.micQueuedLoud++;
      if (data.audioContextState) state.micContext=data.audioContextState;
    }
    if (data.type === 'ONLINE_TTS_EVENT') {
      if(data.event==='start') {
        state.voiceStarted=true;
        state.voiceEngine='googleTTS_pcm';
        state.micContext=data.audioContextState || state.micContext;
        state.audioChunks = data.segments;
        state.loudChunks = data.rms >= .004 ? data.segments : 0;
        if (data.micTracks > 0) {
          state.micQueuedChunks = state.audioChunks;
          state.micQueuedLoud = state.loudChunks;
        }
        log(`TTS bắt đầu: RMS=${data.rms}, mic=${data.micTracks}, loa=${data.speaker}, AudioContext=${data.audioContextState}`);
      }
      if(data.event==='prepared')log(`TTS MP3 decoded: ${data.segments} segments, rms=${data.rms}, duration=${data.duration}s`);
      if(data.event==='end')log('TTS đã phát xong.');
      if(onlineSpeechWaiter?.id===data.id)onlineSpeechWaiter.onEvent(data);
    }
    if (data.type === "MIC_ERROR" || data.type === "BRIDGE_ERROR") {
      log(`Lỗi bridge: ${String(data.error || "unknown").slice(0, 160)}`);
      if (state.running) {
        state.stopping = true;
        showStatus("error", data.error || "Lỗi luồng micro ảo.");
      }
    }
  }
  window.addEventListener("message", handleBridgeMessage);

  // Không bấm bằng tọa độ cố định: Parroto có thể co giãn bố cục, chèn quảng cáo hoặc re-render.
  const REPLAY = /\b(PHAT LAI|REPLAY|PLAYBACK|NGHE LAI)\b/;
  const MATCH = {
    begin: /^(BAT DAU|START|START LESSON|BEGIN|BAT DAU BAI HOC)$/,
    record: /^(GHI AM|BAT DAU GHI AM|THU AM|RECORD|START RECORDING|START RECORD)$/,
    stop: /^(DUNG GHI AM|NGUNG GHI AM|DUNG THU AM|KET THUC GHI AM|STOP RECORDING|STOP RECORD)$/,
    stopShort: /^(STOP|DUNG)$/,
    processing: /^(DANG XU LY|PROCESSING|ANALYZING|TRANSCRIBING|DANG CHAM DIEM|DANG CHUYEN DOI)$/
  };
  const BUTTON_SELECTOR = 'button,[role="button"],input[type="button"],input[type="submit"]';
  const recordingPane = button => button?.closest("div.rounded-duo") || null;
  const canClick = el => isCurrent() && isVisible(el) && !el.disabled && !el.matches(":disabled") &&
    !el.closest('[aria-disabled="true"]');
  class RetryTranscriptError extends Error {}
  function deepQueryAll(selector, root = document, depth = 0) {
    if (depth > 4) return [];
    const nodes = [...root.querySelectorAll(selector)];
    for (const node of root.querySelectorAll("*")) {
      if (node.shadowRoot) nodes.push(...deepQueryAll(selector, node.shadowRoot, depth + 1));
    }
    return nodes;
  }
  function elementLabels(el) {
    if (!el) return [];
    const text = clean(el.innerText || el.textContent || "");
    return [text, el.getAttribute?.("aria-label"), el.getAttribute?.("title"), el.getAttribute?.("value")]
      .filter(Boolean).map(controlText).filter(Boolean);
  }
  function isRecordLabel(el) {
    const labels = elementLabels(el);
    return !labels.some(label => REPLAY.test(label)) && labels.some(label => MATCH.record.test(label));
  }
  function candidateControls(includeDisabled = false) {
    const set = new Set();
    const available = el => !panel?.contains(el) && (includeDisabled ? isVisible(el) : canClick(el));
    for (const el of deepQueryAll(BUTTON_SELECTOR)) {
      if (available(el)) set.add(el);
    }
    // Hỗ trợ trang dùng span/div bên trong phần tử có handler hoặc cursor:pointer.
    for (const leaf of deepQueryAll("span,div")) {
      if (leaf.children.length || !isVisible(leaf) || panel?.contains(leaf)) continue;
      const label = controlText(leaf.innerText || leaf.textContent);
      if (!Object.values(MATCH).some(re => re.test(label))) continue;
      const button = leaf.closest(BUTTON_SELECTOR);
      if (button) {
        if (available(button)) set.add(button);
        continue;
      }
      for (let node = leaf, depth = 0; depth < 5 && node && node !== document.body; depth++, node = node.parentElement) {
        if (getComputedStyle(node).cursor === "pointer" && available(node)) {
          set.add(node);
          break;
        }
      }
    }
    return [...set];
  }
  function matchesControl(el, type, reference = null) {
    const labels = elementLabels(el);
    if (labels.some(label => REPLAY.test(label))) return false;
    if (type === "stop") return labels.some(label => MATCH.stop.test(label) ||
      (MATCH.stopShort.test(label) && reference &&
        (el === reference || (el.parentElement && el.parentElement === reference.parentElement))));
    return labels.some(label => MATCH[type].test(label));
  }
  function controlScore(el, type) {
    const r = el.getBoundingClientRect();
    const labels = elementLabels(el);
    let n = 0;
    if (labels.some(label => MATCH[type]?.test(label))) n += 80;
    if (el.matches?.("button")) n += 12;
    if (el.matches?.('[role="button"]')) n += 7;
    // Không cộng điểm theo tọa độ tỷ lệ cố định của màn hình.
    if (r.width >= 48 && r.height >= 22) n += 8;
    if (el.closest('nav,header,footer')) n -= 10;
    const parentText = controlText(el.parentElement?.innerText || "").slice(0, 200);
    if (/PHAT LAI GHI AM|REPLAY/.test(parentText) && parentText.length < 60) n -= 15;
    return n;
  }
  function findControl(type, reference = null) {
    const scope = reference?.isConnected ? recordingPane(reference) : null;
    const controls = candidateControls(type === "processing").filter(el =>
      matchesControl(el, type, reference) && !el.closest('[role="dialog"],[role="alertdialog"],#transcript-container') &&
      (!scope || scope.contains(el)));
    if (controls.includes(reference)) return reference;
    if (type === "stop" && reference?.isConnected && controls.length > 1) {
      // Nút STOP cùng vị trí với nút START đáng tin cậy hơn các STOP khác trên trang.
      const r = reference.getBoundingClientRect();
      controls.sort((a,b) => {
        const distance = el => {
          const q = el.getBoundingClientRect();
          return Math.hypot((q.left+q.width/2)-(r.left+r.width/2), (q.top+q.height/2)-(r.top+r.height/2));
        };
        return distance(a)-distance(b);
      });
      return controls[0] || null;
    }
    if (type === "record") {
      const rank = el => controlScore(el, type) + (recordingPane(el) ? 25 : 0) + (hitCheck(el).ok ? 15 : 0);
      controls.sort((a, b) => rank(b) - rank(a));
      controlInfo = { strategy: "text", details: controls[0] ? elementLabels(controls[0]).join(", ").slice(0, 100) : "none" };
    } else {
      controls.sort((a, b) => controlScore(b, type) - controlScore(a, type));
    }
    return controls[0] || null;
  }
  function clickableSummary() {
    return candidateControls().map(el => controlText(el.innerText || el.textContent || el.getAttribute("aria-label")))
      .filter(Boolean).slice(0, 25).join(" | ").slice(0, 350);
  }
  function targetAtPoint(x, y, root = document) {
    let item = root.elementFromPoint(x, y);
    while (item?.shadowRoot) {
      const nested = item.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === item) break;
      item = nested;
    }
    return item;
  }
  function hitCheck(el) {
    if (!isVisible(el)) return { ok: false, reason: "Phần tử bị ẩn hoặc đã biến mất." };
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return { ok: false, reason: "Kích thước nút quá nhỏ." };
    const points = [[.5,.5],[.27,.5],[.73,.5],[.5,.28],[.5,.72]];
    for (const [px,py] of points) {
      const x = r.left+r.width*px, y = r.top+r.height*py;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const top = targetAtPoint(x,y);
      for (let node = top; node; node = node.getRootNode().host) {
        if (el === node || el.contains(node)) return { ok: true, x, y };
      }
    }
    return { ok: false, reason: "Nút bị lớp khác che, hoặc vị trí click nằm ngoài phần hiển thị." };
  }
  async function click(el, { type, reference, verify, pointer = false } = {}) {
    if (!canClick(el)) throw new RetryTranscriptError("Không tìm thấy nút điều khiển khả dụng.");
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await sleep(SCAN_INTERVAL_MS);
    verify?.();
    if (!canClick(el) || (type && !matchesControl(el, type, reference))) {
      throw new RetryTranscriptError("Nút điều khiển đã thay đổi trước khi nhấn.");
    }
    const hit = hitCheck(el);
    if (!hit.ok) throw new RetryTranscriptError(hit.reason);
    if (!pointer) {
      el.click();
      return;
    }
    // Một số nút bắt sự kiện pointer trước click. Dừng chuỗi ngay khi nút đổi trạng thái.
    for (const eventType of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      if (!canClick(el) || !matchesControl(el, type, reference)) break;
      verify?.();
      const Ctor = eventType.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(eventType, {
        bubbles: true, cancelable: true, composed: true, clientX: hit.x, clientY: hit.y,
        button: 0, buttons: eventType.endsWith("down") ? 1 : 0, pointerId: 1, pointerType: "mouse"
      }));
    }
  }
  const AD_HINT = /\b(advertisement|advert|sponsored|promotion|ads?|popup-ad|ad-modal|ad-overlay|adbanner)\b|quảng\s*cáo|quang\s*cao|tài\s*trợ|tai\s*tro/i;
  const CLOSE_HINT = /^(?:×|✕|✖|x|close|dismiss|skip\s*ad(?:s)?|close\s*ad|bỏ\s*qua\s*quảng\s*cáo|đóng|tắt|bỏ\s*qua)$/i;
  function isAdContainer(el) {
    const attr = [el.id, typeof el.className === "string" ? el.className : "", el.getAttribute("aria-label") || "", el.getAttribute("data-testid") || ""].join(" ");
    return AD_HINT.test(attr) || AD_HINT.test(clean(el.innerText || "").slice(0, 220));
  }
  function closeAdPopups() {
    const now = Date.now();
    if (!isCurrent() || !state.running || state.stopping || !OPTIONS.autoCloseAds || now - lastDismissAt < 750) return;
    lastDismissAt = now;
    const boxes = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="popup"],[class*="advert"],[class*="sponsor"],[id*="advert"],[id*="ad-"],[class*="ad-"]')]
      .filter(box => isVisible(box) && isAdContainer(box)).slice(0, 25);
    for (const box of boxes) {
      const controls = [...box.querySelectorAll('button,[role="button"],[aria-label],[title]')].slice(0, 30);
      const dismiss = controls.find(button => {
        if (!canClick(button) || !hitCheck(button).ok) return false;
        const labels = [button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText || button.textContent].filter(Boolean).map(clean);
        return labels.some(text => text.length < 65 && CLOSE_HINT.test(text));
      });
      if (dismiss) {
        dismiss.click();
        log("Đã đóng popup quảng cáo có nút đóng hợp lệ.");
        return;
      }
    }
  }
  const normalizeOutput = value => value === "mic-only" ? value : DEFAULT_OUTPUT;
  const settingsReady = chrome.storage.local.get({
    parrotoAutoCloseAds: true,
    parrotoAudioOutput: DEFAULT_OUTPUT
  }).then(settings => {
    OPTIONS.autoCloseAds = !!settings.parrotoAutoCloseAds;
    OPTIONS.audioOutput = normalizeOutput(settings.parrotoAudioOutput);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (isCurrent() && area === "local" && changes.parrotoAudioOutput) {
      settingsReady.then(() => {
        OPTIONS.audioOutput = normalizeOutput(changes.parrotoAudioOutput.newValue);
      });
    }
  });
  const mutationObserver = new MutationObserver(() => {
    if (Date.now() - lastDismissAt > 750) closeAdPopups();
  });
  mutationObserver.observe(document.documentElement, { subtree: true, childList: true });
  const adTimer = setInterval(() => {
    if (isCurrent()) { closeAdPopups(); return; }
    clearInterval(adTimer);
    mutationObserver.disconnect();
    domUpdates.disconnect();
    window.removeEventListener("message", handleBridgeMessage);
    cancelManualRecordWait?.();
  }, 1700);

  // Thông báo Parroto thật: "Chúng tôi không thể hiểu được giọng nói của bạn"
  // Không nhầm với điểm thấp hoặc cửa sổ quảng cáo. Chỉ kiểm tra text thật
  // trong những phần tử đang hiển thị của DOM (không đọc màn hình Windows).
  const UNRECOGNIZED = /CHUNG TOI KHONG THE HIEU DUOC GIONG NOI CUA BAN|VUI LONG NOI RO RANG VA THU LAI|WE (?:COULD NOT|CANNOT|CAN'T) UNDERSTAND YOUR (?:VOICE|SPEECH)/;
  const SAFE_CLOSE_TEXT = /^(?:DONG|DONG THONG BAO|TAT|THOAT|CLOSE|DISMISS|GOT IT|OK|X|×|✕|✖)$/;
  const SAFE_RETRY_TEXT = /^(?:THU LAI|THU LAI NGAY|TRY AGAIN|RETRY|RECORD AGAIN)$/;
  let retryButtonTriggeredRecording = false;
  const errorVisibleText = el => normalize(clean(el?.innerText || el?.textContent || ''));
  function speechErrorNode() {
    // Hầu hết thư viện modal vẽ nội dung vào portal, không nhất thiết dùng role=dialog.
    const candidates = deepQueryAll('[role="alertdialog"],[role="alert"],h1,h2,h3,h4,p,span,div');
    let best = null, bestLen = Infinity;
    for (const el of candidates.slice(0,12000)) {
      if (!isVisible(el) || panel?.contains(el)) continue;
      const t = errorVisibleText(el);
      if (!t || t.length > 850 || !UNRECOGNIZED.test(t)) continue;
      if (t.length < bestLen) { best = el; bestLen = t.length; }
    }
    return best;
  }
  function dialogContainer(target) {
    if (!target) return null;
    const semantic = target.closest('[role="alertdialog"],[role="dialog"],[aria-modal="true"]');
    if (semantic) return semantic;
    let e = target;
    let best = null;
    for (let depth=0; depth<12 && e && e !== document.documentElement; depth++,e=e.parentElement) {
      if (!isVisible(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width > innerWidth*0.98 && r.height > innerHeight*0.98) continue;
      const attr=[e.className,e.id,e.getAttribute?.('data-state'),e.getAttribute?.('data-testid')].join(' ');
      if (/modal|dialog|toast|popup|alert|overlay/i.test(attr)) return e;
      const buttons=e.querySelectorAll('button,[role="button"],input[type="button"]');
      if (!best && buttons.length > 0 && buttons.length <= 5 && r.width > 120 && r.height>55)
        best=e;
    }
    return best || target.parentElement;
  }
  function buttonLabel(el) {
    const fields=[el.getAttribute?.('aria-label'),el.getAttribute?.('title'),el.getAttribute?.('data-testid'),el.id,el.innerText,el.textContent];
    return fields.map(controlText).filter(Boolean);
  }
  function dialogButtons(dialog) {
    const found = new Set();
    const searchRoot = dialog?.getRootNode?.() || document;
    for (const el of dialog?.querySelectorAll('button,[role="button"],input[type="button"],[aria-label]') || []) {
      const button = el.closest('button,[role="button"],input[type="button"]') || (getComputedStyle(el).cursor === 'pointer' ? el : null);
      if (button && isVisible(button)) found.add(button);
    }
    // Radix/Ant Design có thể render icon đóng trong portal ngang cấp với nội dung.
    if (found.size === 0 && dialog?.parentElement) {
      for (const el of dialog.parentElement.querySelectorAll('button,[role="button"]')) {
        if (isVisible(el)) found.add(el);
      }
    }
    return [...found].filter(el=>!el.disabled && el.getAttribute('aria-disabled')!=='true');
  }
  function rankErrorDismissButton(button, dialog) {
    const labels=buttonLabel(button);
    if (labels.some(t=>MATCH.record.test(t)||MATCH.stop.test(t)||REPLAY.test(t)||MATCH.begin.test(t))) return -10000;
    const rawAttrs=[button.id,button.className,button.getAttribute('data-testid'),button.getAttribute('aria-label')].join(' ').toLowerCase();
    const exactClose=labels.some(t=>SAFE_CLOSE_TEXT.test(t)) || /^[×✕✖x]$/i.test(clean(button.textContent));
    const exactRetry=labels.some(t=>SAFE_RETRY_TEXT.test(t));
    const iconHint=/close|dismiss|cross|times|cancel|modal-close|dialog-close/.test(rawAttrs);
    const hasSvg=!!button.querySelector('svg,path,[data-lucide="x"],.lucide-x');
    const br=button.getBoundingClientRect(),dr=dialog.getBoundingClientRect();
    const isCompact=br.width>6&&br.width<=70&&br.height>6&&br.height<=70;
    const rightSide=(br.left+br.width/2)>dr.left+dr.width*0.63;
    const nearTop=(br.top+br.height/2)<dr.top+Math.min(115,dr.height*.42);
    const iconOnly=isCompact&&hasSvg&&rightSide&&nearTop&&labels.every(t=>t.length<20);
    if (exactClose) return 300;
    if (iconHint) return 250;
    if (iconOnly) return 190;
    if (exactRetry) return 120;
    return -100;
  }
  async function dismissSpeechError() {
    if(nativeSpeechError) {nativeSpeechError=false;return true;}
    const target=speechErrorNode();
    if (!target) return true;
    const dialog=dialogContainer(target);
    if (!dialog) return false;
    const buttons=dialogButtons(dialog).map(el=>({el,rank:rankErrorDismissButton(el,dialog)}))
      .filter(x=>x.rank>0).sort((a,b)=>b.rank-a.rank);
    const attempted=new Set();
    for (const {el,rank} of buttons) {
      if (attempted.has(el)) continue;
      attempted.add(el);
      if (!canClick(el) || !hitCheck(el).ok) continue;
      // Chỉ thao tác nút trong vùng thông báo, không nhấn bất kỳ nút record ở nền.
      try {
        const label=buttonLabel(el).join('|').slice(0,60);
        log(`Đóng thông báo lỗi: rank=${rank} nhãn=${label||'(SVG)'}; popup=${String(dialog.className).slice(0,50)}`);
        const retryButton=rank===120;
        el.click();
        if (retryButton) retryButtonTriggeredRecording=true;
        for (let n=0;n<12;n++) {
          abortCheck();
          if (!speechErrorNode()) return true;
          await sleep(160);
        }
        // Frameworks listening to pointerdown rather than click are retried once.
        // Only the already-ranked control INSIDE the error dialog may be used.
        const hit=hitCheck(el);
        if(hit.ok && canClick(el) && speechErrorNode()) {
          for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
            const Ctor=type.startsWith('pointer')?PointerEvent:MouseEvent;
            el.dispatchEvent(new Ctor(type,{bubbles:true,cancelable:true,composed:true,
              clientX:hit.x,clientY:hit.y,button:0,pointerId:1,pointerType:'mouse'}));
          }
          for(let n=0;n<9;n++){if(!speechErrorNode())return true;await sleep(150);}
        }
      } catch (err) {log('Không click được nút đóng: '+String(err?.message||err));}
    }
    // Dự phòng cho modal dùng phím Esc. Synthetic KeyboardEvent có thể bị web từ chối.
    if (speechErrorNode()) {
      const escInit={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true,composed:true};
      for (const el of [document.activeElement,dialog,document]) {
        try {el?.dispatchEvent(new KeyboardEvent('keydown',escInit));}catch{}
      }
      for(let i=0;i<8;i++){
        abortCheck();
        if (!speechErrorNode()) {log('Đã đóng thông báo bằng Escape.');return true;}
        await sleep(160);
      }
    }
    log(`Không thể đóng thông báo bằng nút an toàn. Tìm thấy ${buttons.length} nút ứng viên.`);
    return false;
  }

  // Truy xuất chữ trong vùng NGAY PHÍA TRÊN nút GHI ÂM hiện tại, không dùng tọa độ màn hình cố định.
  const UI_BAD = /^(?:ghi am|dung ghi am|record|stop recording|phat lai ghi am|play|pause|trans|ipa|copy|ban chep|shadowing|tu dong dung|video kich thuoc lon|bat dau|start|luyen|anh|vietnamese|comments?|tu vung|xem|pro|login|easy english conversations episode \d+)$/i;
  const TRANSCRIPT_CARD = '#transcript-container > [id^="transcript-segment-"]';
  const SELECTED_CARD = '[aria-selected="true"],[aria-current]:not([aria-current="false"]),[data-state="active"]';
  const transcriptText = card => clean(card?.querySelector(":scope > p")?.textContent);
  const asciiWords = t => (t.match(/[a-zA-Z]+(?:'[a-zA-Z]+)?/g)||[]);
  function englishQuality(t) {
    const value=clean(t);
    if (!value || value.length<2 || value.length>340 || UI_BAD.test(normalize(value).toLowerCase())) return -100;
    if (/[\u00c0-\u1ef9]/.test(value) || /(?:\/[^/]+\/|\[[\w\sˈˌəɪʊʃŋæðθː]+\])/.test(value)) return -55;
    const words=asciiWords(value), alpha=(value.match(/[A-Za-z]/g)||[]).length;
    if (!words.length || alpha/value.length<.55) return -100;
    if (/^(?:#\s*\d+|\d+[%:]?|http|https)/i.test(value)) return -100;
    return Math.min(65, words.length*9)+Math.min(30,alpha*.45)+(value.endsWith('.')||value.endsWith('?')?9:0);
  }
  function extractCenterSentence(recordElement) {
    if (!recordElement || !recordElement.isConnected) return null;
    const rr=recordElement.getBoundingClientRect();
    if (rr.width<5) return null;
    const cx=rr.left+rr.width/2, lower=rr.top-5;
    const left=cx-Math.max(260,rr.width*2);
    // Cột BẢN CHÉP chứa các câu khác; không lấy nhầm câu trong danh sách bên phải.
    let transcriptEdge=Infinity;
    for(const heading of document.querySelectorAll('h1,h2,h3,h4,span,div,strong')){
      if(heading.childElementCount>2 || !isVisible(heading))continue;
      const label=controlText(heading.textContent);
      if(label==='BAN CHEP'||label==='TRANSCRIPT'){
        const q=heading.getBoundingClientRect();
        if(q.left>cx+30 && q.left<transcriptEdge)transcriptEdge=q.left;
      }
    }
    const right=Math.min(cx+Math.max(260,rr.width*2), transcriptEdge-10);
    const upper=rr.top-260;
    if (upper>innerHeight || lower<0) return null;
    const texts=[];
    const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);
    let node,iterations=0;
    while((node=walker.nextNode()) && iterations++<15000){
      const value=clean(node.nodeValue);
      if (!value || value.length>240 || englishQuality(value)<0) continue;
      const parent=node.parentElement;
      if (!parent || !isVisible(parent) || panel?.contains(parent) || parent.closest('script,style,nav,header,footer,[aria-hidden="true"]')) continue;
      const range=document.createRange();range.selectNodeContents(node);
      const rects=[...range.getClientRects()];
      for(const r of rects){
        if (r.width<1||r.height<1||r.top<upper||r.bottom>lower||r.right<left||r.left>right) continue;
        if (parent.closest('button,[role="button"]')) continue;
        texts.push({text:value,x:r.left,y:r.top,quality:englishQuality(value)});
      }
    }
    const groups=[];
    for(const item of texts.sort((a,b)=>a.y-b.y||a.x-b.x)){
      let group=groups.find(g=>Math.abs(g.y-item.y)<Math.max(8,innerHeight*.011));
      if(!group){group={y:item.y,parts:[]};groups.push(group)}
      if(!group.parts.some(p=>p.x===item.x&&p.text===item.text))group.parts.push(item);
    }
    const options=groups.map(group=>{
      const text=clean(group.parts.sort((a,b)=>a.x-b.x).map(v=>v.text).join(' '));
      const quality=englishQuality(text),dist=Math.max(0,lower-group.y);
      return {text,quality:quality-Math.min(60,dist*.10),distance:dist,source:'center-dom'};
    }).filter(o=>o.quality>1).sort((a,b)=>b.quality-a.quality);
    return options[0]||null;
  }
  function currentSpokenSentence(row, recordButton = null){
    const rows=transcriptRows();
    const selected=row?.number ? rows.find(item=>item.number===row.number)||row :
      rows.find(item=>item.selected) ||
      (rows.length===1 ? rows[0] : null);
    const fallback=clean(selected?.text||'');
    if (selected?.exact && fallback) return { text: fallback, source: "transcript-sidebar" };
    const button=recordButton||findControl('record')||findControl('stop');
    const center=extractCenterSentence(button);
    // Nếu câu trung tâm không trùng bản chép được chọn, không đọc nhầm câu khác.
    if(center&&center.quality>12){
      if(!fallback) return center;
      const words=v=>new Set(asciiWords(v.toLowerCase()).filter(w=>w.length>1));
      const a=words(center.text), b=words(fallback), shared=[...a].filter(w=>b.has(w)).length;
      if(!a.size||!b.size||shared/Math.max(a.size,b.size)>=0.50) return center;
    }
    if(englishQuality(fallback)>0)return {text:fallback,source:'transcript-sidebar',quality:englishQuality(fallback)};
    return center&&center.quality>12?center:null;
  }

  const dynamicScan={activeText:'',textSource:'',domFrames:0,domFps:0,
    fpsAt:performance.now(),lastSemanticAt:0,videoFps:0,motion:0,videoSize:'',blueRegions:[]};
  // Quét tối đa 10 lần/giây. Thao tác nhấn luôn kiểm tra lại DOM tại thời điểm thực hiện.
  let dirty=true;
  const domUpdates=new MutationObserver(()=>{dirty=true;});
  domUpdates.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','disabled','aria-label']});
  function scanSemanticFrame(){
    if (!isCurrent()) return;
    if(document.hidden){setTimeout(scanSemanticFrame,SCAN_INTERVAL_MS);return;}
    const now=performance.now();
    dynamicScan.domFrames++;
    if(now-dynamicScan.fpsAt>=1000){dynamicScan.domFps=Math.round(dynamicScan.domFrames*1000/(now-dynamicScan.fpsAt));dynamicScan.domFrames=0;dynamicScan.fpsAt=now;}
    if(dirty || now-dynamicScan.lastSemanticAt>=200){
      dirty=false;dynamicScan.lastSemanticAt=now;
      const selectedCard = document.querySelector(TRANSCRIPT_CARD + ".border-primary");
      const text = isVisible(selectedCard) ? transcriptText(selectedCard) : "";
      const current = text ? { text, source: "transcript-sidebar" } :
        extractCenterSentence(findControl("record") || findControl("stop"));
      dynamicScan.activeText = current?.text || "";
      dynamicScan.textSource = current?.source || "";
    }
    setTimeout(scanSemanticFrame,Math.max(0,Math.ceil(SCAN_INTERVAL_MS-(performance.now()-now))));
  }
  setTimeout(scanSemanticFrame,SCAN_INTERVAL_MS);

  function findNumberLabels() {
    // Không giả định cột BẢN CHÉP phải ở nửa phải; chỉ dựa vào nhãn thực tế.
    return [...document.querySelectorAll("span,div,p,small,strong,button")].filter(el=>{
      if(!isVisible(el) || el.children.length>1 || panel?.contains(el))return false;
      const t=clean(el.textContent);
      return /^#\s*\d{1,3}$/.test(t) && el.getBoundingClientRect().width>0;
    });
  }
  function findCard(label) {
    let node = label, choice = null;
    for (let d = 0; d < 6 && node; d++, node = node.parentElement) {
      const text = clean(node.innerText);
      if (text.length >= 7 && text.length < 480 && [...text.matchAll(/#\s*\d+/g)].length === 1) {
        choice = node;
        if (node.matches('button,[role="button"]') || /rounded|border|cursor|transcript|segment/i.test(String(node.className))) break;
      }
    }
    return choice || label.parentElement;
  }
  function textFromCard(card, number) {
    const raw=(card?.innerText||card?.textContent||'').split(/\r?\n/).map(clean).filter(Boolean);
    const options=raw.filter(t=>!new RegExp(`^#\\s*${number}$`).test(t))
      .map(text=>({text,score:englishQuality(text)})).filter(v=>v.score>0).sort((a,b)=>b.score-a.score);
    return options[0]?.text||'';
  }
  function transcriptRows() {
    const map = new Map();
    // Trang Shadowing có toàn bộ câu trong đoạn đầu của thẻ bản chép.
    // Ưu tiên đoạn này để giữ nguyên câu khi phần hiển thị bên video tách từng từ và IPA.
    for (const card of document.querySelectorAll(TRANSCRIPT_CARD)) {
      if (!isVisible(card)) continue;
      const index = /^transcript-segment-(\d+)$/.exec(card.id);
      const text = transcriptText(card);
      if (!index) continue;
      const number = Number(index[1]) + 1;
      map.set(number, { number, card, text, exact: true,
        selected: card.classList.contains("border-primary") || card.matches(SELECTED_CARD) });
    }
    if (map.size) return [...map.values()].sort((a, b) => a.number - b.number);
    for (const label of findNumberLabels()) {
      const n = Number(clean(label.textContent).replace(/\D/g, ""));
      if (!n || map.has(n)) continue;
      const card = findCard(label);
      if (card) map.set(n, { number: n, card, text: textFromCard(card, n), selected: card.matches(SELECTED_CARD) });
    }
    return [...map.values()].sort((a, b) => a.number - b.number);
  }
  function isCompleted(row) {
    const card = row?.card;
    if (!card?.isConnected) return false;
    const status = card.getAttribute("data-status") || card.getAttribute("data-state");
    if (status === "skipped") return false;
    return ["correct", "completed", "passed"].includes(status) ||
      card.classList.contains("completed") || (row.exact && card.classList.contains("!border-green-500"));
  }
  function readScore(pane) {
    const result = pane?.querySelector(":scope > div.rounded-duo.mt-5");
    if (!isVisible(result)) return null;
    const arc = result.querySelector('svg[viewBox="0 0 36 36"]');
    const value = clean(arc?.nextElementSibling?.textContent);
    return /^(100|\d{1,2})$/.test(value) ? { value: Number(value), text: clean(result.textContent) } : null;
  }

  function isTranscriptActive(row, rows = transcriptRows()) {
    if (!row || row.virtual) return true;
    const selected = rows.filter(item => item.selected);
    if (selected.length) return selected.length === 1 && selected[0].number === row.number;
    if (row.exact) return false;
    if (rows.length === 1) return rows[0].number === row.number;
    const expected = controlText(row.text);
    const current = extractCenterSentence(findControl("record") || findControl("stop"));
    return !!expected && controlText(current?.text) === expected &&
      rows.filter(item => controlText(item.text) === expected).length === 1;
  }
  function verifyActiveTranscript(row, text) {
    abortCheck();
    if (!row || row.virtual) return;
    const rows = transcriptRows();
    const current = rows.find(item => item.number === row.number);
    if (!current || !isTranscriptActive(row, rows) || (text && row.exact && current.text !== text)) {
      throw new RetryTranscriptError(`Parroto đã rời câu #${row.number} hoặc đổi nội dung.`);
    }
    return current;
  }
  async function waitForTranscript(number) {
    const until = Date.now() + 5500;
    while (Date.now() < until) {
      abortCheck();
      const row = transcriptRows().find(item => item.number === number);
      if (row?.text || isCompleted(row)) return row;
      await sleep(SCAN_INTERVAL_MS);
    }
    throw new Error(`Chưa thấy nội dung của câu #${number}. Đã dừng tại câu này.`);
  }
  function ownedStopButton(session) {
    if (session.micRequest !== null && (!state.micReady || session.micRequest !== microphoneRequest)) return null;
    const button = session.stopButton;
    if (canClick(button) && matchesControl(button, "stop", button)) return button;
    if (session.micRequest === null || !session.pane?.isConnected) return null;
    const replacement = findControl("stop", button);
    return replacement && session.pane.contains(replacement) ? replacement : null;
  }
  async function selectTranscript(row, recording = null) {
    if (row.virtual) return row;
    const until = Date.now() + 5500;
    let stable = false, clickCount = 0, nextClickAt = 0, lastIssue = "";
    const verifyRecording = () => {
      if (recording && !ownedStopButton(recording)) {
        throw new RetryTranscriptError(`Lượt ghi của câu #${row.number} đã thay đổi.`);
      }
    };
    const busy = () => findControl("processing") || (!recording && findControl("stop"));
    while (Date.now() < until) {
      abortCheck();
      verifyRecording();
      const rows = transcriptRows();
      const current = rows.find(item => item.number === row.number);
      if (current?.text && isTranscriptActive(current, rows)) {
        if (stable) return current;
        stable = true;
      } else {
        stable = false;
        if (current?.text && clickCount < 2 && Date.now() >= nextClickAt &&
          !busy()) {
          nextClickAt = Date.now() + 700;
          try {
            await click(current.card, { verify() {
              abortCheck();
              verifyRecording();
              const latest = transcriptRows().find(item => item.number === row.number);
              if (latest?.card !== current.card) throw new Error("Thẻ bản chép vừa được dựng lại.");
              if (busy()) throw new Error("Parroto đang ghi hoặc chấm.");
            }});
            clickCount++;
            nextClickAt = Date.now() + 1200;
            log(`Đã nhấn thẻ câu #${row.number}, đang xác nhận câu được mở.`);
          } catch (error) {
            abortCheck();
            lastIssue = error.message;
          }
        }
      }
      await sleep(SCAN_INTERVAL_MS);
    }
    throw new RetryTranscriptError(`Chưa xác nhận được câu #${row.number} đã mở.${lastIssue ? " " + lastIssue : ""}`);
  }
  async function restoreRecordingTranscript(row, session) {
    if (!ownedStopButton(session)) throw new RetryTranscriptError("Parroto đã kết thúc hoặc thay lượt ghi.");
    if (row && !isTranscriptActive(row)) {
      showStatus("recover", `Đang quay lại câu #${row.number} để hoàn tất lượt ghi.`);
      pauseLessonVideo();
      await selectTranscript(row, session);
      pauseLessonVideo();
    }
    verifyActiveTranscript(row);
    const stopButton = ownedStopButton(session);
    if (!stopButton) throw new RetryTranscriptError("Parroto đã kết thúc hoặc thay lượt ghi.");
    return stopButton;
  }
  async function waitControl(type, timeoutMs, reference = null) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      abortCheck();
      const found = findControl(type, reference);
      if (found) return found;
      await sleep(220);
    }
    log(`Không thấy ${type}. Nút hiện có: ${clickableSummary()}`);
    throw new Error(type === "record"
      ? "Không phát hiện nút GHI ÂM đang hiển thị. Hãy kiểm tra giao diện Parroto, nhật ký nhận diện và các iframe."
      : `Không thấy nút ${type === "stop" ? "DỪNG GHI ÂM" : type} phù hợp. Xem nhật ký để kiểm tra HTML thực tế.`);
  }
  async function waitBridgeReady() {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      abortCheck();
      if (state.bridgeReady) return;
      await sleep(110);
    }
    throw new Error("Không kết nối được micro ảo. Hãy mở lại popup rồi thử lại.");
  }
  async function waitAudioReady() {
    if (state.micContext === "running") return;
    showStatus("audio_wait", "Nhấn một lần vào trang Parroto để trình duyệt cho phép phát âm thanh.");
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      abortCheck();
      if (state.micContext === "running") return;
      await sleep(110);
    }
    throw new Error("Trình duyệt chưa cho phép phát âm thanh. Nhấn vào trang Parroto rồi thử lại.");
  }
  async function waitMicReady() {
    const until = Date.now() + OPTIONS.micTimeoutMs;
    while (Date.now() < until) {
      abortCheck();
      if (state.micReady) return;
      await sleep(125);
    }
    throw new Error("Parroto chưa nhận mic ảo. Hãy kết thúc lượt ghi đang mở rồi thử lại.");
  }
  async function waitRecordingTransition(recordButton, timeoutMs = OPTIONS.recordTransitionTimeoutMs) {
    const until = Date.now() + timeoutMs;
    let previousStop = null;
    while (Date.now() < until) {
      abortCheck();
      const currentStop = findControl("stop", recordButton);
      if (currentStop && currentStop === previousStop) {
        log("Nút ghi âm đã chuyển thành DỪNG GHI ÂM.");
        return currentStop;
      }
      previousStop = currentStop;
      await sleep(170);
    }
    return null;
  }
  async function startRecordSafely(button, row, text) {
    const verify = () => verifyActiveTranscript(row, text);
    await click(button, { type: "record", verify });
    log(`Đã nhấn GHI ÂM ở câu #${row.number}.`);
    let stopButton = await waitRecordingTransition(button, 3200);
    if (stopButton) return stopButton;
    // Không thử lại khi getUserMedia đã được gọi: Parroto có thể đang mở popup quyền micro.
    if (!state.micReady && !findControl("stop", button)) {
      log("Click() không đổi trạng thái. Kiểm tra lại nút trước khi thử pointer events.");
      const replacement = findControl("record", button);
      if (replacement) {
        await click(replacement, { type: "record", verify, pointer: true });
        button = replacement;
      }
    }
    stopButton = await waitRecordingTransition(button, OPTIONS.recordTransitionTimeoutMs);
    if (stopButton) return stopButton;
    if (state.micReady) {
      log("Micro đã được yêu cầu nhưng chưa thấy nút DỪNG GHI ÂM; có thể UI thay đổi.");
      throw new Error("Parroto đã yêu cầu micro nhưng nút DỪNG không xuất hiện. Không đọc để tránh ghi âm không kiểm soát.");
    }
    // Đường thoát: cho phép người dùng bấm NÚT THẬT nếu website yêu cầu event.isTrusted.
    showStatus("manual_record", "Chưa bật ghi âm tự động. Hãy nhấn nút GHI ÂM thủ công một lần trên Parroto.");
    stopButton = await waitRecordingTransition(button, 22000);
    if (stopButton) {
      log("Nhận diện thành công ghi âm được bật thủ công.");
      return stopButton;
    }
    log(`Nút GHI ÂM không phản hồi: ${clickableSummary()}`);
    throw new Error("Không xác nhận được ghi âm sau khi bấm nút đang hiển thị. Có thể website yêu cầu click tin cậy từ người dùng.");
  }
  function waitForManualRecord() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Đã hết thời gian chờ nút GHI ÂM.")), 120000);
      function finish(error, record) {
        clearTimeout(timer);
        window.removeEventListener("click", onClick, true);
        cancelManualRecordWait = null;
        if (error) reject(error);
        else resolve(record);
      }
      function onClick(event) {
        if (!isCurrent() || !event.isTrusted) return;
        const button = event.composedPath().find(el => el instanceof Element && canClick(el) &&
          (el.matches(BUTTON_SELECTOR) || getComputedStyle(el).cursor === "pointer") && isRecordLabel(el));
        if (button) finish(null, { button, sentence: currentSpokenSentence(null, button) });
      }
      cancelManualRecordWait = () => finish(new Error("Đã dừng theo yêu cầu."));
      window.addEventListener("click", onClick, true);
    });
  }
  function pauseLessonVideo() {
    for (const video of document.querySelectorAll("video")) {
      try { if (!video.paused) video.pause(); } catch {}
    }
    for (const frame of document.querySelectorAll('iframe[src*="youtube.com/embed"],iframe[src*="youtube-nocookie.com/embed"]')) {
      try {
        const origin = new URL(frame.src).origin;
        frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "pauseVideo", args: [] }), origin);
      } catch {}
    }
  }
  function stopAllVoices() {
    dispatch("ONLINE_CANCEL");
    onlineSpeechWaiter?.onEvent({ event: "cancel" });
  }
  let onlineSpeechWaiter=null, speechId=0, speechCache=null;
  // Chuẩn bị âm thanh TRƯỚC khi nhấn GHI ÂM, để Parroto không thu phải nhiều giây im lặng.
  async function prepareOnlineSpeech(text){
    const cleanText=clean(text);
    if(speechCache?.text===cleanText)return speechCache;
    if(onlineSpeechWaiter)throw Error('Một yêu cầu âm thanh khác vẫn đang chạy.');
    showStatus(state.running?'tts_fetch':'test','Đang tải tiếng Anh từ Google TTS (không API key)...');
    const result=await chrome.runtime.sendMessage({type:'ONLINE_TTS_FETCH',text:cleanText});
    if(!result?.ok||!result.chunks?.length)throw Error('TTS online: '+(result?.error||'Không tải được MP3.'));
    abortCheck();
    const id=++speechId;
    const eventData=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>done(Error('Quá thời gian giải mã MP3 TTS trong tab.')),20000);
      function done(error,data){clearTimeout(timer);if(onlineSpeechWaiter?.id===id)onlineSpeechWaiter=null;error?reject(error):resolve(data);}
      onlineSpeechWaiter={id,onEvent(data){
        if(data.event==='prepared')done(null,data);
        else if(data.event==='error'||data.event==='cancel')done(Error(data.error||'TTS bị hủy.'));
      }};
      dispatch('ONLINE_PREPARE',{id,chunks:result.chunks});
    });
    if(eventData.rms<.003)throw Error('Google TTS trả âm thanh không có tiếng.');
    state.ttsSegments=result.segments;
    state.ttsBytes=result.totalBytes;
    speechCache={text:cleanText,id,duration:eventData.duration};
    return speechCache;
  }
  async function playOnlineSpeech(info, requireMic) {
    abortCheck();
    if(onlineSpeechWaiter)throw Error('Trình đọc đang bận.');
    return await new Promise((resolve,reject)=>{
      let started=false,finished=false;
      const id=info.id;
      const timer=setTimeout(()=>finish(Error('TTS đã hết thời gian phát; kiểm tra quyền âm thanh của Parroto.')),
        Math.min(160000,Math.ceil(info.duration / OPTIONS.voiceRate *1000)+18000));
      function finish(error){
        if(finished)return;
        finished=true;clearTimeout(timer);
        if(onlineSpeechWaiter?.id===id)onlineSpeechWaiter=null;
        if(error){dispatch('ONLINE_CANCEL');reject(error);}
        else if(!started)reject(Error('TTS chưa bắt đầu phát vào micro ảo.'));
        else resolve();
      }
      onlineSpeechWaiter={id,onEvent(data){
        if(data.event==='start'){
          started=true;
          if(requireMic && data.micTracks<1)return finish(Error('Micro ảo chưa được Parroto yêu cầu.'));
          if(data.rms<.004)return finish(Error('Dữ liệu giọng TTS có mức âm thanh quá thấp.'));
        }else if(data.event==='end')finish();
        else if(data.event==='error'||data.event==='cancel')finish(Error('TTS: '+(data.error||data.event)));
      }};
      dispatch("ONLINE_PLAY", { id, rate: OPTIONS.voiceRate, requireMic, output: OPTIONS.audioOutput });
    });
  }
  async function previewSpeech(text) {
    state.previewing = true;
    state.stopping = false;
    state.voiceStarted = false;
    state.bridgeReady = false;
    showStatus("test", "Đang chuẩn bị đọc thử.");
    try {
      await settingsReady;
      enableBridge();
      await waitBridgeReady();
      const speech = await prepareOnlineSpeech(text);
      await waitAudioReady();
      const micOnly = OPTIONS.audioOutput === "mic-only";
      await playOnlineSpeech(speech, false);
      showStatus("idle", micOnly ? "Đã đọc thử ở chế độ chỉ mic ảo." : "Đã đọc thử câu đang hiển thị.");
    } catch (error) {
      showStatus("error", "Lỗi TTS: " + String(error?.message || error));
    } finally {
      stopAllVoices();
      dispatch("SET_ENABLED", { value: false });
      speechCache = null;
      showStatus(state.stage, state.message, { previewing: false });
    }
  }
  async function readAndRecordOnce(row, manual = false) {
    abortCheck();
    const session = { stopButton: null, pane: null, micRequest: null, stopClicked: false };
    const label = row ? `#${row.number} · ` : "";
    state.audioChunks = 0;
    state.loudChunks = 0;
    state.micQueuedChunks=0;state.micQueuedLoud=0;
    state.voiceStarted = false;
    state.audioWarning = "";
    try {
      let speech;
      if (manual) {
        showStatus("manual_record", "Nhấn GHI ÂM trên Parroto để đọc câu đang hiển thị.");
        const { button, sentence } = await waitForManualRecord();
        session.stopButton = await waitRecordingTransition(button);
        if (!session.stopButton) throw new Error("Chưa thấy Parroto bắt đầu ghi âm.");
        if (!sentence?.text) throw new Error("Chưa nhận diện được câu tiếng Anh khi nhấn GHI ÂM.");
        speech = await prepareOnlineSpeech(sentence.text);
      } else {
        if ((speechErrorNode() || nativeSpeechError) && !(await dismissSpeechError())) {
          throw new Error("Thông báo không hiểu giọng nói vẫn che nút ghi âm.");
        }
        const recording = findControl("stop");
        if (recording && !retryButtonTriggeredRecording) {
          throw new Error("Hãy kết thúc lần ghi âm đang mở trước khi dùng START AUTO.");
        }
        if (recording) {
          log("Nút THỬ LẠI của Parroto đã tự bật ghi âm.");
          session.stopButton = recording;
        } else {
          row = await selectTranscript(row);
        }
        retryButtonTriggeredRecording = false;
        pauseLessonVideo();
        const recordButton = recording || await waitControl("record", 9500);
        const sentence = currentSpokenSentence(row, recordButton);
        if (!sentence?.text) throw new Error("Không tìm thấy câu tiếng Anh để chuẩn bị TTS.");
        speech = await prepareOnlineSpeech(sentence.text);
        await waitAudioReady();
        if (!recording) {
          showStatus("record_click", `${label}Bấm GHI ÂM và chờ phản hồi`);
          const button = await waitControl("record", 9500);
          session.stopButton = await startRecordSafely(button, row, speech.text);
        }
      }
      session.pane = recordingPane(session.stopButton);
      showStatus("mic_wait", `${label}Đang xác nhận mic ảo`);
      await waitMicReady();
      session.micRequest = microphoneRequest;
      await waitAudioReady();
      await restoreRecordingTranscript(row, session);
      showStatus("speaking", `${label}Đọc: ${speech.text.slice(0, 85)}`);
      await playOnlineSpeech(speech, true);
      if (!state.voiceStarted || state.micQueuedLoud === 0) {
        throw new Error("Chưa xác nhận có giọng đọc trong luồng mic ảo.");
      }
      // Chừa thời gian cho đoạn PCM cuối đi vào bản ghi.
      await sleep(450);
      showStatus("stop_click", `${label}Đã đọc xong, đang nhấn DỪNG GHI ÂM`);
      const stopButton = await restoreRecordingTranscript(row, session);
      const pane = recordingPane(stopButton);
      let previousScore = null, wasCompleted = false;
      await click(stopButton, { type: "stop", reference: stopButton, verify() {
        const current = verifyActiveTranscript(row);
        if (ownedStopButton(session) !== stopButton) throw new RetryTranscriptError("Nút dừng của lượt ghi đã thay đổi.");
        if (!manual) {
          previousScore = readScore(pane);
          wasCompleted = isCompleted(current);
        }
      }});
      session.stopClicked = true;
      log(`Đã nhấn DỪNG GHI ÂM sau khi phát xong ${state.micQueuedLoud} đoạn vào mic ảo.`);
      if (manual) return;
      showStatus("processing", `#${row.number} · Chờ Parroto chấm điểm`);
      const started = Date.now();
      const until = started + OPTIONS.processingTimeoutMs;
      let observedProcessing = false;
      while (Date.now() < until) {
        abortCheck();
        if (speechErrorNode() || nativeSpeechError) {
          state.speechErrors++;
          state.retryReason = 'Parroto không hiểu giọng nói';
          log('Parroto: Chúng tôi không thể hiểu được giọng nói của bạn.');
          showStatus('speech_retry', `#${row.number} · Parroto không hiểu giọng, sẽ ghi âm lại`);
          const dismissed = await dismissSpeechError();
          if (!dismissed) throw new Error('Parroto báo không hiểu giọng nhưng không thể đóng popup. Hãy chép nhật ký chẩn đoán để xác định nút đóng thực tế.');
          return { retry:true, reason:'Parroto không hiểu giọng nói' };
        }
        const processing = !!findControl("processing", stopButton);
        observedProcessing ||= processing;
        if (!processing && !findControl("stop", stopButton)) {
          const rows = transcriptRows();
          const latest = rows.find(item => item.number === row.number);
          const active = isTranscriptActive(row, rows);
          const score = active ? readScore(pane) : null;
          const freshScore = score && score.text !== previousScore?.text;
          if (!row.virtual && !wasCompleted && isCompleted(latest)) {
            return { passed: true, score: freshScore ? score.value : null };
          }
          if (freshScore || (score && observedProcessing && score.value < OPTIONS.targetScore)) {
            return { passed: score.value >= OPTIONS.targetScore, score: score.value };
          }
          if (!active && rows.some(item => item.selected) && Date.now() - started >= 1500) {
            return { retry: true, reason: `Parroto đã chuyển câu khi #${row.number} chưa có kết quả` };
          }
        }
        await sleep(220);
      }
      throw new Error(`Chưa xác nhận được kết quả mới của câu #${row.number}. Đã dừng tại câu này.`);
    } catch (error) {
      if (!manual && error instanceof RetryTranscriptError) return { retry: true, reason: error.message };
      throw error;
    } finally {
      if (!session.stopClicked && ownedStopButton(session) && (!autoRunId || autoPath === location.pathname)) {
        try {
          if (!state.stopping && row && !isTranscriptActive(row)) await restoreRecordingTranscript(row, session);
          const stopButton = ownedStopButton(session);
          await click(stopButton, { type: "stop", reference: stopButton, verify() {
            if (ownedStopButton(session) !== stopButton || !isTranscriptActive(row)) {
              throw new Error("Lượt ghi hoặc câu đang mở đã đổi.");
            }
          }});
          log("Đã kết thúc lượt ghi dang dở.");
        } catch (error) {
          log("Chưa kết thúc được lượt ghi dang dở: " + error.message);
        }
      }
    }
  }

  async function start(manual, runId) {
    autoRunId = manual ? null : runId;
    autoPath = autoRunId ? location.pathname : null;
    state.running = true;
    state.stopping = false;
    state.bridgeReady = false;
    state.micReady = false;
    state.micContext = 'unknown';
    state.index = state.total = 0;
    state.score = null;
    state.speechErrors = 0; state.retryReason = "";
    nativeSpeechError=false;
    retryButtonTriggeredRecording = false;
    state.history = [];
    let completedMessage = "";
    try {
      showStatus("bridge", "Đang kích hoạt luồng microphone ảo");
      await settingsReady;
      abortCheck();
      enableBridge();
      await waitBridgeReady();
      if (manual) {
        if (findControl("stop")) throw new Error("Hãy kết thúc lần ghi âm đang mở rồi bật đọc khi bấm GHI ÂM.");
        state.index = state.total = 1;
        await readAndRecordOnce(null, true);
        completedMessage = "Đã đọc câu và kết thúc ghi âm.";
        return;
      }
      showStatus("start", "Đang tìm nút BẮT ĐẦU của bài học");
      const begin = findControl("begin");
      if (begin) {
        await click(begin, { type: "begin", verify: abortCheck });
        showStatus("video", "Chờ video chạy 10 giây");
        for (let i = 0; i < OPTIONS.videoWaitMs / 200; i++) { abortCheck(); await sleep(200); }
      } else await sleep(750);
      abortCheck();
      closeAdPopups();
      const rows = transcriptRows();
      const current = rows.length ? null : currentSpokenSentence(null);
      const virtualRow = current?.text ? { number: 1, card: null, text: current.text, virtual: true } : null;
      if (!rows.length && !virtualRow) throw new Error("Không đọc được văn bản Shadowing từ trang.");
      const first = rows[0]?.exact ? 1 : rows[0]?.number ?? 1;
      let last = rows.at(-1)?.number ?? 1;
      state.total = last - first + 1;
      for (let number = first; ; number++) {
        abortCheck();
        if (number > last) {
          const latestLast = virtualRow ? last : transcriptRows().at(-1)?.number ?? last;
          if (latestLast <= last) break;
          last = latestLast;
          state.total = last - first + 1;
        }
        state.index = number - first + 1;
        showStatus("select", `Kiểm tra bản chép #${number}`, { score: null });
        const row = virtualRow || await waitForTranscript(number);
        if (isCompleted(row)) {
          showStatus("passed", `#${number} đã được Parroto đánh dấu hoàn thành.`);
          continue;
        }
        let passed = false;
        for (let attempt = 1; attempt <= OPTIONS.maxAttemptsPerTranscript; attempt++) {
          abortCheck();
          showStatus("attempt", `#${row.number} · Lần ${attempt}/${OPTIONS.maxAttemptsPerTranscript}`);
          const result = await readAndRecordOnce(row);
          if (result.retry) {
            state.retryReason = result.reason;
            showStatus('retry', `#${row.number} · ${result.reason}${attempt < OPTIONS.maxAttemptsPerTranscript ? ` — đọc lại lần ${attempt+1}` : ' — hết số lần thử'}`);
            if (attempt < OPTIONS.maxAttemptsPerTranscript) await sleep(900);
            continue;
          }
          const { score } = result;
          if (result.passed) {
            passed = true;
            state.retryReason = '';
            showStatus("passed", score === null ? `Parroto xác nhận #${row.number} đã đạt.` : `#${row.number} đạt ${score}%`, { score });
            break;
          }
          showStatus("retry", `#${row.number} được ${score}%, thử đọc lại`, { score });
          await sleep(850);
        }
        if (!passed) throw new Error(`#${row.number} vẫn chưa hoàn thành sau ${OPTIONS.maxAttemptsPerTranscript} lần${state.retryReason ? ' (gần nhất: ' + state.retryReason + ')' : ''}. Kiểm tra micReady và loudChunks trong nhật ký.`);
      }
      completedMessage = `Đã hoàn thành ${state.total}/${state.total} câu. Auto đã dừng.`;
    } catch (error) {
      log(`Kết thúc vì ${String(error?.message || error)}`);
      showStatus(state.stopping && state.stage !== "error" ? "idle" : "error",
        state.stopping && state.stage !== "error" ? "Đã dừng." : String(error?.message || error));
    } finally {
      state.stopping = true;
      stopAllVoices();
      speechCache=null;
      dispatch("SET_ENABLED", { value: false });
      if (autoRunId && isCurrent()) {
        try {
          const result = await chrome.runtime.sendMessage({ type: "FINISH_AUTO", runId: autoRunId });
          if (!result?.ok) throw new Error(result?.error || "Không xác nhận được dừng phiên.");
        } catch (error) {
          log("Lỗi dọn phiên nền: " + error.message);
        }
      }
      autoRunId = autoPath = null;
      showStatus(completedMessage ? "done" : state.stage, completedMessage || state.message, { running: false });
    }
  }
  function stop() {
    if (!state.running) return;
    state.stopping = true;
    cancelManualRecordWait?.();
    stopAllVoices();
    // Không bấm DỪNG ngay khi chưa từng xác nhận bấm GHI ÂM.
    // Việc kết thúc phiên đã xác nhận được thực hiện bởi readAndRecordOnce.finally.
    showStatus("stopping", "Đang dừng an toàn...");
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!isCurrent()) return false;
    if (message?.type === "START" || message?.type === "START_MANUAL") {
      if (state.running || state.previewing) {
        reply({ ok: false, error: "Đang có một lượt đọc." });
      } else if (message.type === "START" && typeof message.runId !== "string") {
        reply({ ok: false, error: "Hãy bật START AUTO từ popup." });
      } else {
        start(message.type === "START_MANUAL", message.runId);
        reply({ ok: true });
      }
      return false;
    }
    if (message?.type === "STOP") { stop(); reply({ ok: true }); return false; }
    if (message?.type === "ADS_SETTING") { OPTIONS.autoCloseAds = !!message.enabled; reply({ ok: true }); return false; }
    if (message?.type === "TEST_CURRENT_TEXT" || message?.type === "TEST_VOICE") {
      if (state.running || state.previewing) {
        reply({ ok: false, error: "Đang có một lượt đọc." });
        return false;
      }
      const current = message.type === "TEST_VOICE"
        ? { text: "Hello! Welcome to Parroto. This is the online voice." }
        : currentSpokenSentence(null);
      if (!current?.text) {
        reply({ ok: false, error: "Chưa tìm được câu tiếng Anh trong vùng Shadowing." });
        return false;
      }
      previewSpeech(current.text);
      reply({ ok: true, text: current.text, source: current.source });
      return false;
    }
    if(message?.type==='GET_FRAME_STATUS'){
      reply({ok:true,domFps:dynamicScan.domFps,videoFps:dynamicScan.videoFps,
        motion:dynamicScan.motion,activeText:dynamicScan.activeText});return false;
    }
    if(message?.type==='VIDEO_METRICS'){
      dynamicScan.videoFps=message.fps||0;dynamicScan.motion=message.motion||0;
      dynamicScan.videoSize=`${message.width||0}x${message.height||0}`;
      dynamicScan.blueRegions=Array.isArray(message.blueRegions)?message.blueRegions.slice(0,12):[];
      dirty=true;
      reply({ok:true});return false;
    }
    if (message?.type === "GET_STATE") {
      reply({ ok: true, version, running: state.running, previewing: state.previewing, stage: state.stage,
        index: state.index, total: state.total, score: state.score, message: state.message });
      return false;
    }
    if (message?.type === "GET_DIAGNOSTICS") {
      reply({ ok: true, version, stage: state.stage, running: state.running,
        index: state.index, total: state.total, micReady: state.micReady, bridgeReady: state.bridgeReady,
        audioChunks: state.audioChunks, loudChunks: state.loudChunks,
        micQueuedChunks:state.micQueuedChunks,micQueuedLoud:state.micQueuedLoud,micContext:state.micContext,
        voiceStarted: state.voiceStarted, voiceEngine: state.voiceEngine, audioOutput: OPTIONS.audioOutput,
        audioWarning: state.audioWarning, speechErrors: state.speechErrors, retryReason: state.retryReason, ttsSegments:state.ttsSegments,ttsBytes:state.ttsBytes, controls: clickableSummary(), clickStrategy: controlInfo,
        videoFps: dynamicScan.videoFps, domFps: dynamicScan.domFps,
        motion: dynamicScan.motion, blueRegions:dynamicScan.blueRegions.length,
        activeText: dynamicScan.activeText, textSource: dynamicScan.textSource,
        history: state.history.slice(-50) });
      return false;
    }
    return false;
  });
  dispatch("ATTACH");
})();
