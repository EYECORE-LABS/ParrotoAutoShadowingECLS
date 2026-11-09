"use strict";
// Âm thanh tab chỉ được chuyển lại loa trong lúc quét hình.
let state = null;
// Lấy mẫu hình tab ở độ phân giải thấp.
// Không chụp/mã hoá/đẩy ảnh lên mạng: chỉ tính chênh lệch pixel để nhận ra UI đổi.
const TARGET_FPS = 10;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
function stopVideo(local) {
  local.videoActive = false;
  if (local.videoTimer) clearTimeout(local.videoTimer);
  if (local.video) { try {local.video.pause();local.video.srcObject=null;}catch{} }
}
// Tìm các vùng màu xanh hình nút trên ảnh tab ở độ phân giải 80×45.
// Không nhận dạng chữ từ pixel; phải đối chiếu nhãn HTML và hit-test mới click.
function detectBlueRegions(pix) {
  const w=80,h=45, mask=new Uint8Array(w*h),seen=new Uint8Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=((y*2+1)*160+(x*2+1))*4;
    const r=pix[i],g=pix[i+1],b=pix[i+2];
    mask[y*w+x]=(g>78&&b>125&&b>g+12&&b>r+38)?1:0;
  }
  const regions=[];
  for(let idx=0;idx<mask.length;idx++){
    if(!mask[idx]||seen[idx])continue;
    const stack=[idx];seen[idx]=1;
    let area=0,minX=w,maxX=0,minY=h,maxY=0;
    while(stack.length){
      const at=stack.pop(),x=at%w,y=Math.floor(at/w);area++;
      minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
      const next=[at-1,at+1,at-w,at+w];
      for(const n of next){
        if(n<0||n>=mask.length||seen[n]||!mask[n])continue;
        if((n===at-1&&x===0)||(n===at+1&&x===w-1))continue;
        seen[n]=1;stack.push(n);
      }
    }
    const ww=maxX-minX+1,hh=maxY-minY+1;
    if(area<8||ww<5||hh<2||ww/hh<1.45||ww>72||hh>20)continue;
    regions.push({x:minX/w,y:minY/h,w:ww/w,h:hh/h,area});
  }
  return regions.sort((a,b)=>b.area-a.area).slice(0,12).map(({x,y,w,h})=>({x,y,w,h}));
}
function startVideo(local) {
  if (!local.stream.getVideoTracks().length) return;
  const video = document.createElement('video');
  video.autoplay = true; video.muted = true; video.playsInline = true;
  video.srcObject = local.stream;
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 90;
  const ctx2 = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx2) return;
  Object.assign(local, {video, videoActive:true, videoTimer:null});
  let prev=null, motion=0, frames=0, tick=performance.now(), blueRegions=[];
  function sample() {
    if (!local.videoActive || state !== local) return;
    const started=performance.now();
    if (video.readyState>=2 && video.videoWidth>0) {
      try {
        ctx2.drawImage(video,0,0,160,90);
        const pix=ctx2.getImageData(0,0,160,90).data;
        blueRegions=detectBlueRegions(pix);
        // Lấy 400 điểm pixel để không gây lag trên thiết bị yếu.
        const brief=new Uint8Array(400);
        let k=0;
        for(let y=2;y<90 && k<400;y+=5) for(let x=2;x<160 && k<400;x+=7) {
          const j=(y*160+x)*4;
          brief[k++]=(pix[j]*3+pix[j+1]*6+pix[j+2])/10;
        }
        if(prev){let changed=0; for(let i=0;i<k;i++) if(Math.abs(brief[i]-prev[i])>18) changed++;motion+=changed/k;}
        prev=brief;frames++;
      } catch { /* capture frame unavailable */ }
    }
    const now=performance.now();
    if(now-tick>=1000){
      chrome.runtime.sendMessage({type:'VIDEO_METRICS', tabId:local.tabId,
        fps:Math.round(frames*1000/(now-tick)*10)/10,
        motion:frames?Math.round(motion/frames*1000)/1000:0,
        width:video.videoWidth,height:video.videoHeight,blueRegions}).catch(()=>{});
      frames=0;motion=0;tick=now;
    }
    local.videoTimer=setTimeout(sample,Math.max(0,Math.ceil(FRAME_INTERVAL_MS-(performance.now()-started))));
  }
  const beginSampling = () => {
    if (local.videoActive && state === local) local.videoTimer = setTimeout(sample, FRAME_INTERVAL_MS);
  };
  video.play().then(beginSampling, beginSampling);
}

async function stop(tabId) {
  if (!state || (tabId && state.tabId !== tabId)) return;
  const cur = state;
  state = null;
  stopVideo(cur);
  try { cur.source.disconnect(); } catch {}
  try { cur.speaker.disconnect(); } catch {}
  for (const t of cur.stream.getTracks()) t.stop();
  try { await cur.ctx.close(); } catch {}
}

async function start(tabId, streamId) {
  await stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxFrameRate: TARGET_FPS } }
  });
  const ctx = new AudioContext({ latencyHint: "interactive" });
  let timer;
  try {
    await Promise.race([ctx.resume(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Không mở được đầu ra âm thanh của luồng quét tab.")), 3000);
    })]);
    const source = ctx.createMediaStreamSource(stream);
    // tabCapture chặn tiếng trực tiếp của tab, nên chuyển tiếng đã thu về loa một lần.
    const speaker = ctx.createGain();
    source.connect(speaker).connect(ctx.destination);
    state = { tabId, stream, ctx, source, speaker };
    startVideo(state);
    stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => stop(tabId)));
  } catch (error) {
    if (state?.stream === stream) await stop(tabId);
    else {
      stream.getTracks().forEach(track => track.stop());
      await ctx.close().catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "offscreen") return false;
  (async () => {
    switch (message.type) {
      case "CAPTURE_START": await start(message.tabId, message.streamId); return { ok: true };
      case "CAPTURE_STOP": await stop(message.tabId); return { ok: true };
      default: return { ok: false, error: "Unknown offscreen request" };
    }
  })().then(reply, e => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});
