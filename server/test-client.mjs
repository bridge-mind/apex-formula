// Smoke test: 2 fake players join, host starts, both drive full throttle, we check snapshots + anti-cheat clamping.
import WebSocket from 'ws';
const URL = process.env.URL ?? 'ws://localhost:8080';
const mk = (name) => new Promise((res) => { const ws = new WebSocket(URL); ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', name })); res(ws); }); });
const a = await mk('Yuni'), b = await mk('Budi');
const log = { snaps: 0, last: null, events: [], bytes: 0 };
a.on('message', (d) => { const m = JSON.parse(d); log.bytes += d.length; if (m.t === 'snap') { log.snaps++; log.last = m; } else log.events.push(m.t + (m.n ? ':' + m.n : '')); });
await new Promise((r) => setTimeout(r, 300));
a.send(JSON.stringify({ t: 'start' }));
let seq = 0;
const drive = setInterval(() => {
  seq++;
  a.send(JSON.stringify({ t: 'input', seq, steer: 0, throttle: 1, brake: 0 }));
  b.send(JSON.stringify({ t: 'input', seq, steer: 0, throttle: 9999, brake: -5, steer2: 1 })); // cheat attempt: out-of-range values get clamped
}, 16);
await new Promise((r) => setTimeout(r, 12000));
clearInterval(drive);
const c = log.last.cars;
console.log('events:', log.events.join(' '));
console.log('snapshots received:', log.snaps, '≈', (log.snaps / 12).toFixed(1), 'Hz over ~12 s, avg', Math.round(log.bytes / log.snaps), 'B/msg');
for (const x of c) console.log(`car ${x.id}: speed ${(x.spd * 3.6).toFixed(0)} km/h, gear ${x.gear}, rpm ${x.rpm}, s=${x.s} m, lap ${x.lap}, ack seq ${x.ack}`);
process.exit(0);
