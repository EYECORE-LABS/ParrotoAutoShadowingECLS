"use strict";
const $ = id => document.getElementById(id);
const version = chrome.runtime.getManifest().version;
const DEFAULT_OUTPUT = "speaker-and-mic";
let activeTabId = null;
let launching = false;
$("version").textContent = `EYECORE LABS / v${version}`;
function setInfo(data) {
  if (!data) return;
  $("indicator").textContent = data.running || data.previewing ? "RUNNING" : data.stage === "error" ? "ERROR" : data.stage === "done" ? "DONE" : "IDLE";
  $("indicator").className = "indicator " + (data.stage === "error" ? "error" : data.running ? "running" : "");
  $("score").textContent = Number.isFinite(data.score) ? String(data.score) : "--";
  $("counter").textContent = `${data.index || 0}/${data.total || 0}`;
  $("mode").textContent = (data.stage || "ready").toUpperCase().slice(0, 11);
  $("notice").textContent = data.message || "Mở bài Shadowing trong tab parroto.app.";
  const busy = launching || data.running || data.previewing;
  $("start").disabled = $("manual").disabled = $("test").disabled = !!busy || !activeTabId;
  $("stop").disabled = !data.running || !activeTabId;
}
async function refresh() {
  if (!activeTabId) return;
  try { setInfo(await connect()); }
  catch (error) {
    setInfo({ running: false, stage: "error", message: "Kết nối tab Parroto chưa thành công. " + error.message });
  }
}
async function connect() {
  const status = await chrome.tabs.sendMessage(activeTabId, { type: "GET_STATE" }, { frameId: 0 }).catch(() => null);
  if (status?.ok && status.version === version) return status;
  $("notice").textContent = "Đang kết nối với bài Parroto đang mở...";
  const result = await chrome.runtime.sendMessage({ type: "CONNECT_TAB", tabId: activeTabId });
  if (!result?.ok) throw new Error(result?.error || "Hãy mở lại popup để kết nối.");
  return result;
}
async function send(type) {
  if (!activeTabId) return;
  try {
    if (type !== "STOP") await connect();
    const res = await chrome.tabs.sendMessage(activeTabId, { type });
    if (!res?.ok) throw new Error(res?.error || "Không gửi được lệnh.");
    await refresh();
  } catch (error) { $("notice").textContent = String(error?.message || error); }
}
$("start").addEventListener("click", async () => {
  if (!activeTabId || launching) return;
  launching = true;
  $("start").disabled = $("manual").disabled = $("test").disabled = true;
  $("notice").textContent = "Đang khởi tạo nhận diện tab và micro ảo...";
  let failure;
  try {
    const response = await chrome.runtime.sendMessage({ type: "START_AUTO", tabId: activeTabId });
    if (!response?.ok) throw new Error(response?.error || "Không gửi được lệnh START.");
  } catch (error) {
    failure = `Không thể bắt đầu. ${error?.message || error}`;
  } finally {
    launching = false;
    await refresh();
    if (failure) $("notice").textContent = failure;
  }
});
$("stop").addEventListener("click", () => send("STOP"));
$("test").addEventListener("click", () => send("TEST_CURRENT_TEXT"));
$("manual").addEventListener("click", () => send("START_MANUAL"));
$("audioOutput").addEventListener("change", async event => {
  try {
    await chrome.storage.local.set({ parrotoAudioOutput: event.target.value });
  } catch (error) {
    $("notice").textContent = `Không lưu được đầu ra giọng đọc: ${error?.message || error}`;
  }
});
$("autoAds").addEventListener("change", async event => {
  const enabled = !!event.target.checked;
  await chrome.storage.local.set({ parrotoAutoCloseAds: enabled });
  if (activeTabId) await chrome.tabs.sendMessage(activeTabId, { type: "ADS_SETTING", enabled }).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.parrotoShadowingStatus) refresh();
});
(async () => {
  const settings = await chrome.storage.local.get({ parrotoAutoCloseAds: true, parrotoAudioOutput: DEFAULT_OUTPUT });
  $("autoAds").checked = settings.parrotoAutoCloseAds;
  $("audioOutput").value = settings.parrotoAudioOutput === "mic-only" ? "mic-only" : DEFAULT_OUTPUT;
  $("audioOutput").disabled = false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && /^https:\/\/(?:www\.)?parroto\.app\//i.test(tab.url || "")) {
    activeTabId = tab.id;
    await refresh();
  } else {
    setInfo({ running: false, stage: "idle", message: "Chỉ hoạt động trên parroto.app." });
  }
})();

$("diagnostics").addEventListener("click", async () => {
  if (!activeTabId) return;
  try {
    const details = await chrome.tabs.sendMessage(activeTabId, { type: "GET_DIAGNOSTICS" });
    if (!details?.ok) throw new Error(details?.error || "Không nhận được nhật ký");
    const text = [
      `ECLS PARROTO v${version} – DIAGNOSTICS`,
      `stage=${details.stage}, index=${details.index}/${details.total}`,
      `bridge=${details.bridgeReady}, micReady=${details.micReady}, onlinePCM=${details.micQueuedChunks}, micHasSound=${details.micQueuedLoud}, micContext=${details.micContext}`,
      `voiceStarted=${details.voiceStarted}, voiceEngine=${details.voiceEngine}, segments=${details.ttsSegments}, bytes=${details.ttsBytes}, output=${details.audioOutput}`,
      `audioWarning=${details.audioWarning||"none"}`,
      `speechErrors=${details.speechErrors}, retryReason=${details.retryReason||"none"}`,
      `controls=${details.controls}`,
      `video=${details.videoFps}fps; dom=${details.domFps}fps; motion=${details.motion}`,
      `activeText=${details.activeText}`,
      `textSource=${details.textSource}`,
      `clickStrategy=${JSON.stringify(details.clickStrategy)}`,
      "EVENTS:", ...(details.history || [])
    ].join("\n");
    await navigator.clipboard.writeText(text);
    $("notice").textContent = "Đã chép nhật ký chẩn đoán.";
  } catch (error) {
    $("notice").textContent = `Không chép được nhật ký: ${error?.message || error}`;
  }
});

setInterval(async()=>{
  if (!activeTabId) return;
  try {
    const result=await chrome.tabs.sendMessage(activeTabId,{type:'GET_FRAME_STATUS'});
    if (result?.ok) { $('fps').textContent=`${result.videoFps||0} / ${result.domFps||0} FPS`; $('phrase').textContent=result.activeText||'Chưa nhận diện'; }
  }catch{}
},1200);
