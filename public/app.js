// Floor-control prototype client.
// Audio path:  mic -> [VAD worklet]            (detects speech on the raw mic)
//              mic -> gain -> WebRTC to peers  (gain is what gets muted/ducked when held)

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);

const store = {
  get(k, d) { try { const v = localStorage.getItem('floor.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('floor.' + k, JSON.stringify(v)); } catch {} },
};

const local = {
  mode: store.get('mode', 'mute'),
  thresholdDb: store.get('thresholdDb', -45),
  beep: store.get('beep', true),
};

const state = {
  ws: null, myId: null, myName: '', room: '',
  peers: new Map(),       // id -> { name, pc, audio, queue }
  settings: {},
  floorId: null,
  speaking: new Set(),
  heldPeers: new Set(),
  selfMuted: false,
  iAmSpeaking: false,
  holdUntil: 0, holdTimer: null,
  clock: { offset: 0, rtt: Infinity, samples: [] },
};

let ctx, mic, gain, dest, vad;

// ---------- clock sync (so onsets from different machines can be compared) ----------
const epochNow = () => performance.timeOrigin + performance.now();
function ping() { send({ type: 'ping', t0: epochNow() }); }
function onPong({ t0, ts }) {
  const t1 = epochNow();
  const s = state.clock.samples;
  s.push({ rtt: t1 - t0, offset: ts - (t0 + t1) / 2 });
  if (s.length > 8) s.shift();
  const best = s.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  state.clock.offset = best.offset;
  state.clock.rtt = best.rtt;
  renderStatus();
}

// ---------- join ----------
$('nameInput').value = store.get('name', '');
$('roomInput').value = params.get('room') || store.get('room', 'team');
$('joinBtn').onclick = join;
$('roomInput').onkeydown = $('nameInput').onkeydown = e => { if (e.key === 'Enter') join(); };

async function join() {
  const name = $('nameInput').value.trim() || 'Guest';
  const room = $('roomInput').value.trim() || 'team';
  store.set('name', name); store.set('room', room);
  $('joinBtn').disabled = true;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('vad-worklet.js');
    const src = ctx.createMediaStreamSource(mic);
    gain = ctx.createGain();
    dest = ctx.createMediaStreamDestination();
    src.connect(gain).connect(dest);
    vad = new AudioWorkletNode(ctx, 'vad');
    src.connect(vad);
    // Keep the worklet in the rendered graph without making it audible.
    const sink = ctx.createGain(); sink.gain.value = 0;
    vad.connect(sink).connect(ctx.destination);
    vad.port.onmessage = e => onVad(e.data);
    pushVadParams();
  } catch (err) {
    $('joinBtn').disabled = false;
    $('joinError').hidden = false;
    $('joinError').textContent = 'Could not use the microphone: ' + err.message +
      (isSecureContext ? '' : ' (the page must be opened over https:// or on localhost)');
    return;
  }

  state.myName = name; state.room = room;
  history.replaceState(null, '', '?room=' + encodeURIComponent(room));
  $('joinView').hidden = true;
  $('callView').hidden = false;
  $('roomTitle').textContent = 'Room: ' + room;
  initLocalSettings();
  connect();
}

function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  state.ws = ws;
  ws.onopen = () => {
    send({ type: 'join', room: state.room, name: state.myName });
    for (let i = 0; i < 5; i++) setTimeout(ping, i * 300);
    setInterval(ping, 5000);
  };
  ws.onclose = () => { $('status').textContent = 'Disconnected — reload the page to rejoin.'; };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
}

function send(msg) { if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg)); }

function onMessage(m) {
  switch (m.type) {
    case 'pong': return onPong(m);
    case 'welcome':
      state.myId = m.id;
      state.floorId = m.floor;
      applySettings(m.settings);
      for (const p of m.peers) addPeer(p.id, p.name, true);
      break;
    case 'peer_joined':
      if (m.id !== state.myId) addPeer(m.id, m.name, false);
      break;
    case 'peer_left': removePeer(m.id); break;
    case 'signal': onSignal(m.from, m.data); break;
    case 'floor': state.floorId = m.id; break;
    case 'speaking': m.on ? state.speaking.add(m.id) : state.speaking.delete(m.id); break;
    case 'peer_held': m.ms ? state.heldPeers.add(m.id) : state.heldPeers.delete(m.id); break;
    case 'held': startHold(m); break;
    case 'released': endHold(false); break;
    case 'settings': applySettings(m.settings); break;
    case 'event': addLog(m.at, m.text); break;
  }
  renderTiles();
}

// ---------- WebRTC mesh ----------
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

function addPeer(id, name, initiator) {
  if (state.peers.has(id)) return;
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const audio = new Audio();
  audio.autoplay = true;
  $('audios').append(audio);
  const peer = { name, pc, audio, queue: Promise.resolve() };
  state.peers.set(id, peer);

  pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
  pc.onicecandidate = e => { if (e.candidate) send({ type: 'signal', to: id, data: { candidate: e.candidate } }); };
  pc.ontrack = e => { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); };
  pc.onconnectionstatechange = renderTiles;
  if (initiator) {
    pc.onnegotiationneeded = async () => {
      await pc.setLocalDescription();
      send({ type: 'signal', to: id, data: { sdp: pc.localDescription } });
    };
  }
}

function onSignal(from, data) {
  const peer = state.peers.get(from);
  if (!peer) return;
  const { pc } = peer;
  // Handle signals strictly in order: a candidate must not be added before its description.
  peer.queue = peer.queue.then(async () => {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }).catch(err => console.warn('signal error', err));
}

function removePeer(id) {
  const p = state.peers.get(id);
  if (!p) return;
  p.pc.close();
  p.audio.remove();
  state.peers.delete(id);
  state.speaking.delete(id);
  state.heldPeers.delete(id);
}

// ---------- voice detection ----------
function pushVadParams() { vad?.port.postMessage({ thresholdDb: local.thresholdDb }); }

function ctxToEpoch(t) { return epochNow() - (ctx.currentTime - t) * 1000; }

function onVad(m) {
  if (m.type === 'level') return renderMeter(m);
  if (m.type === 'start') {
    if (state.selfMuted) return;
    state.iAmSpeaking = true;
    send({ type: 'speech_start', onset: ctxToEpoch(m.onset) + state.clock.offset });
  } else if (m.type === 'end') {
    if (!state.iAmSpeaking) return;
    state.iAmSpeaking = false;
    send({ type: 'speech_end', lastVoiced: ctxToEpoch(m.lastVoiced) + state.clock.offset });
  }
  $('vadState').textContent = state.iAmSpeaking ? 'speaking' : 'quiet';
  $('vadState').className = 'pill' + (state.iAmSpeaking ? ' talk' : '');
}

function renderMeter({ db, voiced }) {
  const pct = v => Math.max(0, Math.min(100, ((v + 70) / 60) * 100));
  $('meterFill').style.width = pct(db) + '%';
  $('meterFill').className = voiced && !state.selfMuted ? 'voiced' : '';
  $('meterMark').style.left = pct(local.thresholdDb) + '%';
}

// ---------- being held ----------
function applyGain() {
  if (!gain) return;
  const held = Date.now() < state.holdUntil;
  const target = state.selfMuted ? 0 : held ? (local.mode === 'duck' ? 0.2 : 0) : 1;
  gain.gain.setTargetAtTime(target, ctx.currentTime, 0.008);
}

function startHold({ ms, byName, marginMs }) {
  clearTimeout(state.holdTimer);
  state.holdUntil = Date.now() + ms;
  state.holdTotal = ms;
  applyGain();
  if (local.beep) beep();
  $('heldTitle').textContent = byName === 'Test bot'
    ? 'Hold on — the test bot got there first'
    : `Hold on — ${byName} got there first` + (marginMs > 0 ? ` (by ${Math.round(marginMs)} ms)` : '');
  $('heldBar').hidden = false;
  document.body.classList.add('is-held');
  state.holdTimer = setTimeout(() => endHold(false), ms);
  requestAnimationFrame(tickHold);
}

function tickHold() {
  const left = state.holdUntil - Date.now();
  if (left <= 0 || $('heldBar').hidden) return;
  $('heldCount').textContent = (left / 1000).toFixed(1);
  $('heldFill').style.width = (left / state.holdTotal) * 100 + '%';
  requestAnimationFrame(tickHold);
}

function endHold(override) {
  if ($('heldBar').hidden && !override) return;
  clearTimeout(state.holdTimer);
  state.holdUntil = 0;
  applyGain();
  $('heldBar').hidden = true;
  document.body.classList.remove('is-held');
  if (override) send({ type: 'override' });
}

$('overrideBtn').onclick = () => endHold(true);
addEventListener('keydown', e => {
  if (e.code !== 'Space' || $('heldBar').hidden) return;
  if (e.target.matches('input, select, textarea')) return;
  e.preventDefault();
  endHold(true);
});

function beep() {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const t = ctx.currentTime;
  o.frequency.setValueAtTime(660, t);
  o.frequency.exponentialRampToValueAtTime(440, t + 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.16);
}

// ---------- controls ----------
$('muteBtn').onclick = () => {
  state.selfMuted = !state.selfMuted;
  $('muteBtn').textContent = state.selfMuted ? 'Unmute' : 'Mute';
  $('muteBtn').classList.toggle('on', state.selfMuted);
  if (state.selfMuted && state.iAmSpeaking) {
    state.iAmSpeaking = false;
    send({ type: 'speech_end', lastVoiced: epochNow() + state.clock.offset });
  }
  applyGain();
  renderTiles();
};
$('copyBtn').onclick = async () => {
  const link = location.origin + location.pathname + '?room=' + encodeURIComponent(state.room);
  try { await navigator.clipboard.writeText(link); $('copyBtn').textContent = 'Copied!'; }
  catch { prompt('Invite link', link); }
  setTimeout(() => ($('copyBtn').textContent = 'Copy invite link'), 1500);
};
$('botBtn').onclick = () => send({ type: 'test_bot' });

const SETTING_KEYS = ['holdMs', 'windowMs', 'arbitrateMs', 'falseStartMs', 'fairness'];
function applySettings(s) {
  state.settings = s;
  for (const k of SETTING_KEYS) {
    const el = $('s_' + k);
    if (el.type === 'checkbox') el.checked = s[k]; else el.value = s[k];
  }
}
$('saveSettings').onclick = () => {
  const s = {};
  for (const k of SETTING_KEYS) {
    const el = $('s_' + k);
    s[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  send({ type: 'settings', settings: s });
};

function initLocalSettings() {
  $('l_mode').value = local.mode;
  $('l_threshold').value = local.thresholdDb;
  $('l_thresholdVal').textContent = local.thresholdDb;
  $('l_beep').checked = local.beep;
  $('l_mode').onchange = e => { local.mode = e.target.value; store.set('mode', local.mode); applyGain(); };
  $('l_threshold').oninput = e => {
    local.thresholdDb = Number(e.target.value);
    $('l_thresholdVal').textContent = local.thresholdDb;
    store.set('thresholdDb', local.thresholdDb);
    pushVadParams();
  };
  $('l_beep').onchange = e => { local.beep = e.target.checked; store.set('beep', local.beep); };
}

// ---------- rendering ----------
function renderStatus() {
  const n = state.peers.size;
  const rtt = Number.isFinite(state.clock.rtt) ? `${Math.round(state.clock.rtt)} ms round trip to server` : 'measuring…';
  $('status').textContent = `${n === 0 ? 'Nobody else here yet' : n === 1 ? '1 other person' : n + ' other people'} · ${rtt}`;
}

function renderTiles() {
  const people = [{ id: state.myId, name: state.myName + ' (you)', self: true }];
  for (const [id, p] of state.peers) people.push({ id, name: p.name, conn: p.pc.connectionState });
  if (state.floorId === 'bot' || state.speaking.has('bot')) people.push({ id: 'bot', name: 'Test bot' });

  $('tiles').replaceChildren(...people.map(p => {
    const tile = document.createElement('div');
    const speaking = state.speaking.has(p.id);
    const held = state.heldPeers.has(p.id);
    tile.className = 'tile' + (speaking ? ' speaking' : '') + (held ? ' held' : '');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name;
    const badges = document.createElement('div');
    badges.className = 'badges';
    const pill = (text, cls) => { const s = document.createElement('span'); s.className = 'pill ' + cls; s.textContent = text; badges.append(s); };
    if (state.floorId === p.id) pill('has the floor', 'floor');
    if (held) pill('held', 'held');
    if (speaking && !held) pill('talking', 'talk');
    if (p.self && state.selfMuted) pill('muted', '');
    if (p.conn && p.conn !== 'connected') pill(p.conn, '');
    tile.append(name, badges);
    return tile;
  }));
  renderStatus();
}

function addLog(at, text) {
  const li = document.createElement('li');
  if (/held for/.test(text)) li.className = 'hit';
  const t = document.createElement('time');
  t.textContent = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.append(t, text);
  $('log').append(li);
  $('log').scrollTop = $('log').scrollHeight;
}
