// Launch Window server.
// - Serves the web client from ./public
// - Relays WebRTC signalling so browsers can connect to each other directly (mesh audio)
// - Decides who "has the floor" when people start talking, and holds back whoever
//   jumped into the same gap second.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const DEFAULT_SETTINGS = {
  holdMs: 3000,        // how long the second speaker is held back
  windowMs: 1200,      // starting this soon after someone else took the floor counts as a collision
  arbitrateMs: 80,     // wait this long after the first start to collect near-simultaneous starts
  falseStartMs: 400,   // if the winner stops talking within this, it was a cough/false start: release holds
  fairness: true,      // whoever lost the last collision wins the next one
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
let nextId = 1;

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, {
      name,
      peers: new Map(),          // id -> { id, name, ws }
      settings: { ...DEFAULT_SETTINGS },
      floor: null,               // { id, name, onset, takenAt }
      speaking: new Map(),       // id -> onset (server time)
      held: new Map(),           // id -> { until, timer }
      pending: null,             // { cands: [{ peer, onset }], timer }
      lastLoser: null,
      botTimer: null,
    });
  }
  return rooms.get(name);
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { for (const p of room.peers.values()) send(p.ws, msg); }
function log(room, text) { broadcast(room, { type: 'event', at: Date.now(), text }); }
function nameOf(room, id) { return id === 'bot' ? 'Test bot' : room.peers.get(id)?.name ?? '?'; }

function setFloor(room, floor) {
  room.floor = floor;
  broadcast(room, { type: 'floor', id: floor?.id ?? null });
}

function hold(room, peer, byId, marginMs) {
  const ms = room.settings.holdMs;
  clearHold(room, peer.id, false);
  const timer = setTimeout(() => clearHold(room, peer.id, false), ms);
  room.held.set(peer.id, { until: Date.now() + ms, timer });
  send(peer.ws, { type: 'held', ms, by: byId, byName: nameOf(room, byId), marginMs });
  broadcast(room, { type: 'peer_held', id: peer.id, ms });
  room.lastLoser = peer.id;
  const by = nameOf(room, byId);
  const how = marginMs >= 0
    ? `started ${Math.round(marginMs)} ms after ${by}`
    : `started ${Math.round(-marginMs)} ms before ${by}, but the floor went to ${by}`;
  log(room, `${peer.name} ${how} — on hold for ${(ms / 1000).toFixed(1)} s`);
}

function clearHold(room, id, notify) {
  const h = room.held.get(id);
  if (!h) return;
  clearTimeout(h.timer);
  room.held.delete(id);
  if (notify) send(room.peers.get(id)?.ws, { type: 'released' });
  broadcast(room, { type: 'peer_held', id, ms: 0 });
}

function resolvePending(room) {
  const { cands } = room.pending;
  room.pending = null;
  // Drop anyone who disconnected or stopped talking while we waited.
  const live = cands.filter(c => room.peers.has(c.peer.id) && room.speaking.has(c.peer.id));
  if (!live.length) return;
  live.sort((a, b) => a.onset - b.onset);
  let winner = live[0];
  if (room.settings.fairness && live.length > 1) {
    const owed = live.find(c => c.peer.id === room.lastLoser);
    if (owed && owed !== winner) {
      winner = owed;
      log(room, `${owed.peer.name} lost the last collision, so gets this one`);
    }
  }
  setFloor(room, { id: winner.peer.id, onset: winner.onset, takenAt: Date.now() });
  if (room.lastLoser === winner.peer.id) room.lastLoser = null;
  for (const c of live) if (c !== winner) hold(room, c.peer, winner.peer.id, c.onset - winner.onset);
}

function onSpeechStart(room, peer, onset) {
  // Never trust a client clock that claims to be in the future.
  onset = Math.min(onset, Date.now());
  room.speaking.set(peer.id, onset);
  broadcast(room, { type: 'speaking', id: peer.id, on: true });
  if (room.held.has(peer.id)) return;
  const f = room.floor;
  if (f && f.id === peer.id) return;
  if (f) {
    const margin = onset - f.onset;
    // Only a collision if they started soon after the floor was taken. Later than that is
    // an ordinary interruption, which we leave alone.
    if (margin <= room.settings.windowMs) hold(room, peer, f.id, margin);
    return;
  }
  if (!room.pending) {
    room.pending = { cands: [], timer: setTimeout(() => resolvePending(room), room.settings.arbitrateMs) };
  }
  room.pending.cands.push({ peer, onset });
}

function onSpeechEnd(room, peer, lastVoiced) {
  const onset = room.speaking.get(peer.id);
  room.speaking.delete(peer.id);
  broadcast(room, { type: 'speaking', id: peer.id, on: false });
  if (room.floor?.id !== peer.id) return;
  const talked = Math.min(lastVoiced, Date.now()) - (onset ?? room.floor.onset);
  setFloor(room, null);
  if (talked < room.settings.falseStartMs && room.held.size) {
    log(room, `${peer.name} only spoke for ${Math.max(0, Math.round(talked))} ms (false start) — releasing holds`);
    for (const id of [...room.held.keys()]) clearHold(room, id, true);
  }
  handOver(room);
}

// When the floor frees up while someone else is already talking (an interrupter, or a
// held person who overrode), give it to whoever has been talking longest.
function handOver(room) {
  if (room.floor) return;
  let best = null;
  for (const [id, onset] of room.speaking) {
    if (room.held.has(id)) continue;
    if (!best || onset < best.onset) best = { id, onset };
  }
  if (best) setFloor(room, { id: best.id, onset: best.onset, takenAt: Date.now() });
}

wss.on('connection', ws => {
  let room = null;
  let me = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') return send(ws, { type: 'pong', t0: msg.t0, ts: Date.now() });

    if (msg.type === 'join' && !room) {
      room = getRoom(String(msg.room || 'lobby').slice(0, 40));
      me = { id: String(nextId++), name: String(msg.name || 'Guest').slice(0, 30), ws };
      send(ws, {
        type: 'welcome', id: me.id, settings: room.settings, floor: room.floor?.id ?? null,
        peers: [...room.peers.values()].map(p => ({ id: p.id, name: p.name })),
      });
      room.peers.set(me.id, me);
      broadcast(room, { type: 'peer_joined', id: me.id, name: me.name });
      return log(room, `${me.name} joined`);
    }
    if (!room) return;

    switch (msg.type) {
      case 'signal': {
        const to = room.peers.get(msg.to);
        if (to) send(to.ws, { type: 'signal', from: me.id, data: msg.data });
        break;
      }
      case 'speech_start': onSpeechStart(room, me, Number(msg.onset) || Date.now()); break;
      case 'speech_end': onSpeechEnd(room, me, Number(msg.lastVoiced) || Date.now()); break;
      case 'override':
        if (room.held.has(me.id)) {
          clearHold(room, me.id, false);
          log(room, `${me.name} pressed Space to launch anyway`);
          handOver(room);
        }
        break;
      case 'settings': {
        const s = room.settings;
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
          if (!(k in msg.settings)) continue;
          s[k] = typeof s[k] === 'boolean' ? !!msg.settings[k] : Math.max(0, Math.min(10000, Number(msg.settings[k]) || 0));
        }
        broadcast(room, { type: 'settings', settings: s });
        log(room, `${me.name} changed the room settings`);
        break;
      }
      case 'test_bot': {
        if (room.floor) break;
        clearTimeout(room.botTimer);
        setFloor(room, { id: 'bot', onset: Date.now(), takenAt: Date.now() });
        broadcast(room, { type: 'speaking', id: 'bot', on: true });
        log(room, `Test bot launched — start talking now to see what being on hold feels like`);
        room.botTimer = setTimeout(() => {
          broadcast(room, { type: 'speaking', id: 'bot', on: false });
          if (room.floor?.id === 'bot') { setFloor(room, null); handOver(room); }
        }, 2500);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    room.peers.delete(me.id);
    room.speaking.delete(me.id);
    clearHold(room, me.id, false);
    if (room.lastLoser === me.id) room.lastLoser = null;
    broadcast(room, { type: 'peer_left', id: me.id });
    log(room, `${me.name} left`);
    if (room.floor?.id === me.id) { setFloor(room, null); handOver(room); }
    if (!room.peers.size) { clearTimeout(room.botTimer); rooms.delete(room.name); }
  });
});

server.listen(PORT, () => console.log(`Launch Window running at http://localhost:${PORT}`));
