const RATE = 24000, FRAME = 480, FRAME_US = 20000, JITTER = 0.02, MAX_LAG = 0.25;; // seconds

const $ = (id) => document.getElementById(id);
const errorEl = $('error');
const showError = (m) => { errorEl.textContent = m; };

let ws, playCtx;
let isYou = false;       // from server LINE_STATE
let mic = null;          // active capture resources
let decoder = null, decTs = 0, nextTime = 0;

// ---------- Join ----------
$('joinBtn').onclick = join;
$('name').onkeydown = (e) => { if (e.key === 'Enter') join(); };

function join() {
  const name = $('name').value.trim();
  if (!name) return showError('Enter a name');
  if (!window.AudioEncoder || !window.AudioDecoder || !window.AudioWorklet || !navigator.mediaDevices) {
    return showError('Browser not supported (need Chrome 110+ / Firefox 130+ over HTTPS).');
  }
  showError('');
  playCtx = new AudioContext({ sampleRate: RATE }); // created in a click = playback allowed
  playCtx.resume();

  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'JOIN', name }));
    $('me').textContent = name;
    $('join').hidden = true;
    $('main').hidden = false;
    render({ state: 'IDLE' });
  };
  ws.onerror = () => showError('Could not connect to server.');
  ws.onclose = () => { stopMic(); showError('Disconnected. Refresh the page to rejoin.'); $('talk').disabled = $('stop').disabled = true; };
  ws.onmessage = onMessage;
}

// ---------- Messages ----------
function onMessage(e) {
  if (e.data instanceof ArrayBuffer) return playChunk(e.data);
  const msg = JSON.parse(e.data);

  if (msg.type === 'LINE_STATE') {
    isYou = msg.isYou;
    resetPlayback(); // new speaker (or idle): fresh decoder/timeline
    if (!isYou) stopMic();
    render(msg);
  } else if (msg.type === 'GRANTED') {
    startMic();
  } else if (msg.type === 'REJECTED') {
    showError(msg.reason || 'Line busy');
  } else if (msg.type === 'ERROR') {
    showError(msg.message);
  }
}

function render(s) {
  const idle = s.state === 'IDLE';
  $('talk').disabled = !idle;
  $('stop').disabled = !isYou;
  $('status').textContent = idle ? 'Line idle' : isYou ? 'You are talking' : `${s.ownerName} is talking`;
}

$('talk').onclick = () => { showError(''); ws.send(JSON.stringify({ type: 'REQUEST_LINE' })); };
$('stop').onclick = () => { ws.send(JSON.stringify({ type: 'STOP' })); stopMic(); };

// ---------- Sending: mic -> worklet -> AudioEncoder -> WebSocket ----------
async function startMic() {
  const m = { closed: false };
  mic = m;
  try {
    m.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    m.ctx = new AudioContext(); // native rate; worklet resamples to 24 kHz
    await m.ctx.audioWorklet.addModule('/worklet.js');
    if (m.closed) return cleanup(m); // stopped while starting

    let ts = 0;
    m.encoder = new AudioEncoder({
      output: (chunk) => {
        if (m.closed || ws.readyState !== WebSocket.OPEN) return;
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        ws.send(buf);
      },
      error: (err) => fail(m, 'Encoder error: ' + err.message),
    });
    m.encoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 24000 });

    const src = m.ctx.createMediaStreamSource(m.stream);
    m.node = new AudioWorkletNode(m.ctx, 'capture');
    m.node.port.onmessage = (ev) => {
      if (m.closed || m.encoder.state !== 'configured') return;
      const data = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: ts, data: ev.data });
      ts += FRAME_US;
      m.encoder.encode(data);
      data.close();
    };
    src.connect(m.node);
    m.stream.getAudioTracks()[0].onended = () => fail(m, 'Microphone stopped');
  } catch (err) {
    fail(m, 'Microphone error: ' + err.message);
  }
}

function fail(m, message) {
  if (mic !== m || m.closed) return;
  showError(message);
  stopMic();
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'STOP' }));
}

function stopMic() {
  if (!mic) return;
  const m = mic;
  mic = null;
  m.closed = true;
  cleanup(m);
}

function cleanup(m) {
  m.closed = true;
  try { m.node && m.node.disconnect(); } catch {}
  try { m.stream && m.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { m.ctx && m.ctx.close(); } catch {}
  try { m.encoder && m.encoder.state !== 'closed' && m.encoder.close(); } catch {}
}

// ---------- Receiving: WebSocket -> AudioDecoder -> scheduled playback ----------
function resetPlayback() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  decTs = 0;
  nextTime = 0;
}

function playChunk(buf) {
  if (isYou) return;
  if (!decoder) {
    decoder = new AudioDecoder({
      output: playAudioData,
      error: (err) => showError('Decoder error: ' + err.message),
    });
    decoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
  }
  if (decoder.state !== 'configured') return;
  decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: decTs, data: buf }));
  decTs += FRAME_US;
}

function playAudioData(ad) {
  const now = playCtx.currentTime;
  if (nextTime < now) nextTime = now + JITTER;   // (re)start with a small cushion

  if (nextTime - now > MAX_LAG) {                // queue too far ahead: drop this frame
    ad.close();
    return;
  }

  const samples = new Float32Array(ad.numberOfFrames);
  ad.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
  const ab = playCtx.createBuffer(1, samples.length, ad.sampleRate);
  ad.close();
  ab.copyToChannel(samples, 0);
  const src = playCtx.createBufferSource();
  src.buffer = ab;
  src.connect(playCtx.destination);
  src.start(nextTime);
  nextTime += ab.duration;
}
