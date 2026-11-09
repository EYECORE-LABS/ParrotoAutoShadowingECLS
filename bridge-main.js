/* EYECORE LABS · Parroto (online TTS -> AudioContext -> mic ảo, loa tùy chọn)
 * Cơ chế getUserMedia và giải mã MP3 dựa trên edge-tts-mic-v1.2.0 do người dùng cung cấp.
 * Nội dung âm thanh đi trực tiếp trong tab; không sửa dữ liệu điểm của website.
 */
(() => {
  'use strict';
  if (!/^https:\/\/(?:www\.)?parroto\.app$/.test(location.origin) || window.__ECLS_PSA_BRIDGE_V2) return;
  window.__ECLS_PSA_BRIDGE_V2 = true;
  if (window.__ECLS_PSA_BRIDGE) {
    // Phiên bản trước còn tồn tại trong trang đã mở. Kết thúc mic của phiên đó.
    window.postMessage({ __ECLS_PSA: true, channel: 'CONTENT', type: 'SET_ENABLED', value: false }, location.origin);
  }
  const CHANNEL='__ECLS_PSA_V2';
  let clientId = null;
  const notify=(type,extra={})=>window.postMessage({[CHANNEL]:true,channel:'PAGE',clientId,type,...extra},location.origin);
  let enabled=false, ctx=null, micOut=null, prepared=null, playing=null;
  let playbackGeneration = 0;
  let micGeneration = 0;
  const servedTracks=new Set();
  const wrappedMethods = new WeakSet();

  // Chỉ nhận diện thông báo lỗi phát âm cụ thể, không bỏ qua những alert khác.
  const originalAlert=window.alert.bind(window);
  window.alert=function(message){
    const s=String(message||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    if(enabled && (/chung toi khong the hieu duoc giong noi cua ban/.test(s) ||
      /vui long noi ro rang va thu lai/.test(s) || /could not understand your (voice|speech)/.test(s))){
      notify('SPEECH_ERROR_NATIVE',{message:String(message).slice(0,240)});return;
    }
    return originalAlert(message);
  };

  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) {
    notify('BRIDGE_ERROR', { error: 'Trình duyệt không có navigator.mediaDevices.getUserMedia.' });
    return;
  }
  const mediaPrototype = window.MediaDevices?.prototype;
  const nativeGUM = mediaPrototype?.getUserMedia || devices.getUserMedia;
  const virtualDevice = { deviceId: 'ecls-parroto-virtual-mic', groupId: '', kind: 'audioinput', label: 'Parroto Virtual Mic' };

  function ensureAudio(){
    if(ctx && ctx.state!=='closed')return ctx;
    const C=window.AudioContext||window.webkitAudioContext;
    if(!C)throw Error('Web Audio API không được hỗ trợ.');
    const audio = ctx = new C({ latencyHint: 'playback' });
    micOut=ctx.createMediaStreamDestination();
    audio.addEventListener('statechange', () => {
      if (enabled && ctx === audio) notify('AUDIO_CONTEXT', { state: audio.state });
    });
    return ctx;
  }
  function unlockAudio(event) {
    if (!enabled || (event && !event.isTrusted) || ctx?.state !== 'suspended') return;
    ctx.resume().catch(() => {});
  }
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);

  async function resumeAudio(){
    const a=ensureAudio();
    if(a.state==='suspended') {
      let timer;
      try {
        await Promise.race([a.resume(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Âm thanh chưa được mở. Hãy nhấn vào trang Parroto rồi thử lại.')), 5000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
    if(a.state!=='running')throw Error('AudioContext chưa chạy: '+a.state);
    return a;
  }
  function trackIt(track) {
    servedTracks.add(track);
    const nativeStop = track.stop.bind(track);
    const nativeClone = track.clone.bind(track);
    const forget = () => {
      if (servedTracks.delete(track)) notify('MIC_TRACKS', { count: servedTracks.size });
    };
    track.stop = function () {
      try { return nativeStop(); } finally { forget(); }
    };
    track.clone = function () {
      const copy = nativeClone();
      if (copy.readyState === 'live') trackIt(copy);
      return copy;
    };
    track.addEventListener('ended', forget, { once: true });
    notify('MIC_TRACKS', { count: servedTracks.size });
  }
  async function getVirtualStream(receiver, constraints) {
    const generation = micGeneration;
    const camera = constraints.video ? await nativeGUM.call(receiver, { video: constraints.video, audio: false }) : null;
    if (!enabled || generation !== micGeneration) {
      camera?.getTracks().forEach(track => track.stop());
      throw new DOMException('Phiên micro ảo đã kết thúc.', 'AbortError');
    }
    const audio = ensureAudio();
    const mic = micOut.stream.getAudioTracks()[0].clone();
    trackIt(mic);
    unlockAudio();
    notify('MIC_READY', { audioContextState: audio.state, subscriberTracks: servedTracks.size });
    return new MediaStream([mic, ...(camera?.getVideoTracks() || [])]);
  }
  function wrapMediaMethod(target, name, wrap) {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const original = descriptor?.value;
    if (typeof original !== 'function' || wrappedMethods.has(original)) return;
    const replacement = wrap(original);
    try {
      Object.defineProperty(target, name, { ...descriptor, value: replacement });
      wrappedMethods.add(replacement);
    } catch { /* Website có thể khóa thuộc tính riêng của nó. */ }
  }
  function installMediaHooks(target) {
    wrapMediaMethod(target, 'getUserMedia', original => function (constraints) {
      if (enabled && constraints?.audio) return getVirtualStream(this, constraints);
      return original.call(this, constraints);
    });
    wrapMediaMethod(target, 'enumerateDevices', original => async function () {
      const list = await original.call(this);
      if (!enabled || list.some(device => device.deviceId === virtualDevice.deviceId)) return list;
      const info = Object.create(window.MediaDeviceInfo?.prototype || Object.prototype, {
        deviceId: { value: virtualDevice.deviceId, enumerable: true },
        groupId: { value: virtualDevice.groupId, enumerable: true },
        kind: { value: virtualDevice.kind, enumerable: true },
        label: { value: virtualDevice.label, enumerable: true },
        toJSON: { value: () => ({ ...virtualDevice }) }
      });
      return [...list, info];
    });
  }
  // Theo bản mic ảo v1.2.0: bọc cả prototype lẫn hàm riêng do trang gán.
  installMediaHooks(mediaPrototype);
  installMediaHooks(devices);

  function cancelPlayback(){
    playbackGeneration++;
    if(!playing)return;
    const old=playing;playing=null;
    for(const s of old.sources){try{s.onended=null;s.stop();s.disconnect();}catch{}}
    try{old.mixer.disconnect();}catch{}
    notify('ONLINE_TTS_EVENT',{id:old.id,event:'cancel'});
  }
  function decode64(base64){
    if(typeof base64!=='string'||base64.length>3_200_000)throw Error('Đoạn MP3 quá lớn hoặc không hợp lệ.');
    const b=atob(base64),bytes=new Uint8Array(b.length);
    for(let i=0;i<b.length;i++)bytes[i]=b.charCodeAt(i);
    return bytes.buffer;
  }
  function bounds(buffer){
    const samples=buffer.getChannelData(0),len=samples.length,threshold=.004;
    let start=0,end=len-1;
    while(start<len&&Math.abs(samples[start])<threshold)start++;
    if(start>=len)return {offset:0,duration:buffer.duration};
    while(end>start&&Math.abs(samples[end])<threshold)end--;
    start=Math.max(0,start-Math.round(buffer.sampleRate*.015));
    end=Math.min(len-1,end+Math.round(buffer.sampleRate*.02));
    return {offset:start/buffer.sampleRate,duration:(end-start+1)/buffer.sampleRate};
  }
  async function prepareOnline(msg){
    cancelPlayback();prepared=null;
    const generation = playbackGeneration;
    const {id,chunks}=msg;
    if(!enabled)throw Error('Micro ảo chưa được bật.');
    if(!Number.isInteger(id)||!Array.isArray(chunks)||!chunks.length||chunks.length>20)throw Error('Đoạn giọng TTS không hợp lệ.');
    const a=ensureAudio(),buffers=[];
    let peak=0,energy=0,count=0,total=0;
    for(const data of chunks){
      const buffer=await a.decodeAudioData(decode64(data));
      if (!enabled || generation !== playbackGeneration) return;
      if(buffer.length<256||buffer.duration>25)throw Error('MP3 bị lỗi hoặc thời lượng bất thường.');
      const samples=buffer.getChannelData(0);
      // Lấy mẫu đều để kiểm tra dữ liệu không rỗng, không tốn CPU đọc toàn bộ.
      for(let n=0;n<samples.length;n+=19){const x=samples[n];peak=Math.max(peak,Math.abs(x));energy+=x*x;count++;}
      buffers.push(buffer);total+=buffer.duration;
    }
    const rms=Math.sqrt(energy/Math.max(1,count));
    if(rms<.003||peak<.02)throw Error('Audio TTS nhận được nhưng không có giọng nói (RMS thấp).');
    if(total>140)throw Error('Câu đọc quá dài.');
    prepared={id,buffers,rms,peak,duration:total};
    notify('ONLINE_TTS_EVENT',{id,event:'prepared',rms,peak,duration:total,segments:buffers.length});
  }
  async function playOnline(msg){
    cancelPlayback();
    const generation = playbackGeneration;
    const id=msg.id;
    const speech = prepared;
    if(!enabled || !speech || speech.id!==id)throw Error('Chưa tải/giải mã TTS cho bản chép này.');
    const a=await resumeAudio();
    if (!enabled || generation !== playbackGeneration) return;
    const micTracks=[...servedTracks].filter(t=>t.readyState==='live').length;
    if(msg.requireMic && !micTracks)throw Error('Parroto chưa yêu cầu micro ảo. Không phát bản ghi rỗng.');
    const mixer=a.createGain();
    mixer.gain.value=.94;
    const speaker = msg.output !== 'mic-only';
    mixer.connect(micOut);
    if (speaker) mixer.connect(a.destination);
    const sources=[];
    const rate=Math.min(1.25,Math.max(.8,Number(msg.rate)||.95));
    let when=a.currentTime+.18;
    const duration=speech.buffers.reduce((s,b)=>s+b.duration/rate+.11,0);
    const job={id,mixer,sources,ended:0};playing=job;
    const total=speech.buffers.length;
    for(const buffer of speech.buffers){
      const {offset,duration:span}=bounds(buffer);
      const source=a.createBufferSource();
      source.buffer=buffer;source.playbackRate.value=rate;
      source.connect(mixer);
      sources.push(source);
      const delta=span/rate;
      source.onended=()=>{
        job.ended++;
        try{source.disconnect();}catch{}
        if(job.ended===total&&playing===job){
          playing=null;try{mixer.disconnect();}catch{}
          notify('ONLINE_TTS_EVENT',{id,event:'end',duration,micTracks});
        }
      };
      source.start(when,offset,span);when+=delta+.11;
    }
    notify('ONLINE_TTS_EVENT',{id,event:'start',rms:speech.rms,peak:speech.peak,
      duration,micTracks,speaker,audioContextState:a.state,segments:total});
  }
  function setBridgeEnabled(value) {
    enabled = value;
    micGeneration++;
    if (enabled) {
      installMediaHooks(mediaPrototype);
      installMediaHooks(devices);
      const audio = ensureAudio();
      notify('MODE', { enabled: true, audioContextState: audio.state });
      unlockAudio();
    } else {
      cancelPlayback();
      prepared = null;
      for (const track of servedTracks) { try { track.stop(); } catch {} }
      servedTracks.clear();
      const audio = ctx;
      ctx = micOut = null;
      if (audio) audio.close().catch(() => {});
      notify('MODE', { enabled: false });
    }
    try { devices.dispatchEvent(new Event('devicechange')); } catch {}
  }
  window.addEventListener('message',async event=>{
    if(event.source!==window||event.origin!==location.origin)return;
    const m=event.data;
    if (!m || m[CHANNEL] !== true || m.channel !== 'CONTENT' || typeof m.clientId !== 'string') return;
    if (m.type === 'ATTACH') {
      if (clientId !== null && clientId !== m.clientId) setBridgeEnabled(false);
      clientId = m.clientId;
      return;
    }
    if (m.clientId !== clientId) return;
    try{
      switch(m.type){
        case 'SET_ENABLED': setBridgeEnabled(!!m.value);break;
        case 'ONLINE_PREPARE': await prepareOnline(m);break;
        case 'ONLINE_PLAY': await playOnline(m);break;
        case 'ONLINE_CANCEL': cancelPlayback();break;
      }
    }catch(e){
      if (m.clientId !== clientId) return;
      if(m.type==='ONLINE_PREPARE'||m.type==='ONLINE_PLAY')notify('ONLINE_TTS_EVENT',{id:m.id,event:'error',error:String(e?.message||e)});
      else notify('BRIDGE_ERROR',{error:String(e?.message||e)});
    }
  });
})();
