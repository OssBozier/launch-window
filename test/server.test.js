// Starts the real server and checks the floor decisions using fake clients.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const wait = ms => new Promise(r => setTimeout(r, ms));
const got = (c, type) => c.msgs.filter(m => m.type === type);

function client(name, room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c = { name, ws, msgs: [], send: m => ws.send(JSON.stringify(m)) };
    ws.on('error', rej);
    ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'welcome') { c.id = m.id; res(c); } });
    ws.on('open', () => c.send({ type: 'join', room, name }));
  });
}

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`);
}

async function room(...names) {
  const r = 'r' + Math.random();
  const cs = [];
  for (const n of names) cs.push(await client(n, r));
  return cs;
}

async function main() {
  {
    const [a, b, c] = await room('Alice', 'Bob', 'Cara');
    const now = Date.now();
    // Bob's message arrives first, but Alice really started 30 ms earlier.
    b.send({ type: 'speech_start', onset: now });
    await wait(10);
    a.send({ type: 'speech_start', onset: now - 30 });
    await wait(150);
    check('Earliest real start wins, not earliest message', got(c, 'floor').at(-1)?.id === a.id);
    check('Second speaker is held', got(b, 'held').length === 1, `margin ${got(b, 'held')[0]?.marginMs} ms`);
    check('Winner is not held', got(a, 'held').length === 0);

    await wait(400);
    c.send({ type: 'speech_start', onset: Date.now() });
    await wait(30);
    check('Starting within the collision window is held', got(c, 'held').length === 1);

    b.send({ type: 'override' });
    await wait(30);
    check('Space override is logged', got(a, 'event').some(e => /launch anyway/.test(e.text)));
  }
  {
    const [a, c] = await room('Alice', 'Cara');
    let t = Date.now();
    // Start times are in the past: the server caps future ones at "now", which would make a tie.
    a.send({ type: 'speech_start', onset: t - 40 }); c.send({ type: 'speech_start', onset: t - 20 });
    await wait(150);
    a.send({ type: 'speech_end', lastVoiced: Date.now() }); c.send({ type: 'speech_end', lastVoiced: Date.now() });
    await wait(3100);
    t = Date.now();
    a.send({ type: 'speech_start', onset: t - 40 }); c.send({ type: 'speech_start', onset: t - 20 });
    await wait(150);
    check('Fairness: last collision\'s loser wins the next', got(a, 'floor').at(-1)?.id === c.id);
  }
  {
    const [a, b] = await room('Alice', 'Bob');
    const t = Date.now();
    a.send({ type: 'speech_start', onset: t - 60 }); b.send({ type: 'speech_start', onset: t - 10 });
    await wait(150);
    a.send({ type: 'speech_end', lastVoiced: t + 150 });
    await wait(30);
    check('False start by the winner releases the held person', got(b, 'released').length === 1);
  }
  {
    const [a, b] = await room('Alice', 'Bob');
    a.send({ type: 'speech_start', onset: Date.now() });
    await wait(1500);
    b.send({ type: 'speech_start', onset: Date.now() });
    await wait(50);
    check('A late interruption is not held', got(b, 'held').length === 0);
  }
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
server.stdout.once('data', async () => {
  try { await main(); } catch (err) { failures++; console.error(err); }
  server.kill();
  console.log(failures ? `\n${failures} failed` : '\nAll passed');
  process.exit(failures ? 1 : 0);
});
