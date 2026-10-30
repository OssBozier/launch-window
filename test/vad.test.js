// Runs the real detector (public/vad-worklet.js) in Node against simulated rooms.
const path = require('path').join(__dirname, '..', 'public', 'vad-worklet.js');
const SR = 48000;
let Proc;
global.sampleRate = SR;
global.currentTime = 0;
global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: m => this.events.push(m), onmessage: null }; this.events = []; } };
global.registerProcessor = (_, c) => { Proc = c; };
require(path);

// Voice-like buzz with a given pitch, on during [t0, t1).
function voice(t, t0, t1, pitch, gainDb, am = pitch === 120 ? 4 : 3.1) {
  if (t < t0 || t >= t1) return 0;
  const f0 = pitch + 20 * Math.sin(2 * Math.PI * 1.3 * t);
  let v = 0;
  for (let h = 1; h < 12; h++) v += Math.sin(2 * Math.PI * f0 * h * t + h) / h;
  return v * 0.25 * (0.6 + 0.4 * Math.sin(2 * Math.PI * am * t + pitch)) * 10 ** (gainDb / 20);
}

function run(name, { secs = 6, far, mic, guard = true, expect }) {
  const p = new Proc();
  p.p.echoGuard = guard;
  const N = secs * SR, B = 128;
  const farBuf = new Float32Array(N), micBuf = new Float32Array(N);
  for (let i = 0; i < N; i++) { const t = i / SR; farBuf[i] = far(t); }
  for (let i = 0; i < N; i++) { const t = i / SR; micBuf[i] = mic(t, farBuf, i) + (Math.random() - 0.5) * 0.002; }
  for (let i = 0; i + B <= N; i += B) {
    global.currentTime = i / SR;
    p.process([[micBuf.subarray(i, i + B)], [farBuf.subarray(i, i + B)]]);
  }
  const starts = p.events.filter(e => e.type === 'start').map(e => e.onset.toFixed(2) + 's');
  const echoes = p.events.filter(e => e.type === 'echo').length;
  const ok = starts.length === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      starts: [${starts.join(', ')}] (want ${expect}), echo reports: ${echoes}, learnt coupling ${p.couplingDb.toFixed(1)} dB`);
  return ok;
}

// Echo = playback delayed by `lagMs` and scaled by `db`.
const echo = (lagMs, db) => (t, far, i) => { const j = i - Math.round(lagMs * SR / 1000); return j >= 0 ? far[j] * 10 ** (db / 20) : 0; };
const other = t => voice(t, 1, 3, 120, 0) + voice(t, 3.6, 5, 120, 0);   // someone else talking twice
const silent = () => 0;

let all = true;
all &= run('Quiet speakers (echo -20 dB, 60 ms late): nobody else counts as you', { far: other, mic: echo(60, -20), expect: 0 });
all &= run('Loud laptop speakers, no echo cancelling (echo 0 dB, 120 ms late)', { far: other, mic: echo(120, 0), expect: 0 });
all &= run('Very loud speakers (echo +6 dB, 200 ms late)', { far: other, mic: echo(200, 6), expect: 0 });
all &= run('Same loud echo with the guard OFF (shows the old problem)', { far: other, mic: echo(120, 0), guard: false, expect: 2 });
all &= run('You talk, nothing playing', { far: silent, mic: t => voice(t, 1, 2.5, 180, -6), expect: 1 });
all &= run('You talk in the gap right after them, with echo on (the collision case)',
  { far: other, mic: (t, f, i) => echo(120, 0)(t, f, i) + voice(t, 3.2, 4.5, 180, -6), expect: 1 });
all &= run('You both start at the same instant, echo 10 dB below you', {
  far: t => voice(t, 1, 3, 120, 0),
  mic: (t, f, i) => echo(120, -10)(t, f, i) + voice(t, 1, 3, 180, 0), expect: 1 });
all &= run('You start while their echo is already LOUDER than you (known limit: you are missed)', {
  far: t => voice(t, 1, 4, 120, 0),
  mic: (t, f, i) => echo(120, 0)(t, f, i) + voice(t, 2, 3.5, 180, -6), expect: 0 });
all &= run('You interrupt loudly while they talk (+12 dB over echo)',
  { far: t => voice(t, 0.5, 5, 120, -6), mic: (t, f, i) => echo(80, -6)(t, f, i) + voice(t, 2.5, 4, 180, 0), expect: 1 });
console.log(all ? '\nAll passed' : '\nSome failed');
process.exit(all ? 0 : 1);
