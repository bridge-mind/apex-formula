/**
 * Authoritative multiplayer server. Clients send ONLY inputs; the server runs the real vehicle physics
 * (120 Hz, identical to the browser game) and broadcasts snapshots at 20 Hz. Clients cannot teleport or cheat speed.
 *
 * Protocol (JSON):
 *   C→S {t:'join', name}            S→C {t:'welcome', id, host, players}
 *   C→S {t:'start'}   (host only)   S→C {t:'lobby', players} / {t:'countdown', n} / {t:'go'}
 *   C→S {t:'input', seq, steer, throttle, brake, gearUp, gearDown, drs, ers, pitLimiter, reset}
 *   S→C {t:'snap', tick, time, cars:[...]}   S→C {t:'finish', results}
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { PHYSICS_DT } from '../src/core/constants';
import { clamp } from '../src/core/math';
import type { DriverInput, ErsMode } from '../src/core/types';
import { createDefaultInput } from '../src/core/world';
import { createSession, MAX_PLAYERS, type Session } from './session';

const PORT = Number(process.env.PORT ?? 8080);
const SNAPSHOT_EVERY = 6; // 120 Hz / 6 = 20 Hz
const MAX_STEPS_PER_TICK = 8;
const COUNTDOWN_SECONDS = 5;
const LAPS = Number(process.env.LAPS ?? 3);
const MAX_MSG_PER_SEC = 120;

interface Player {
  ws: WebSocket;
  id: number; // lobby slot, becomes carId when the race starts
  name: string;
  input: DriverInput;
  lastSeq: number;
  lastRecv: number;
  msgCount: number;
  finished: boolean;
}

type Phase = 'lobby' | 'countdown' | 'racing' | 'finished';

class Room {
  phase: Phase = 'lobby';
  players: (Player | null)[] = new Array(MAX_PLAYERS).fill(null);
  session: Session | null = null;
  tick = 0;
  acc = 0;
  last = performance.now();
  finishOrder: number[] = [];
  timer: ReturnType<typeof setInterval> | null = null;

  get count(): number { return this.players.filter(Boolean).length; }
  get hostId(): number { return this.players.findIndex(Boolean); }

  add(ws: WebSocket, name: string): Player | null {
    if (this.phase !== 'lobby') return null;
    const id = this.players.findIndex((p) => p === null);
    if (id < 0) return null;
    const p: Player = { ws, id, name: name.slice(0, 20) || `Player${id + 1}`, input: createDefaultInput(), lastSeq: 0, lastRecv: 0, msgCount: 0, finished: false };
    this.players[id] = p;
    return p;
  }

  remove(p: Player): void {
    this.players[p.id] = null;
    if (this.session && this.phase !== 'lobby') {
      this.session.physics.retireCar(p.id);
      this.session.physics.holdCar(p.id, true);
    }
    if (this.count === 0) this.reset();
    else if (this.phase === 'lobby') this.broadcastLobby();
  }

  broadcast(msg: unknown): void {
    const s = JSON.stringify(msg);
    for (const p of this.players) if (p && p.ws.readyState === 1) p.ws.send(s);
  }

  roster(): { id: number; name: string; host: boolean }[] {
    return this.players.flatMap((p) => (p ? [{ id: p.id, name: p.name, host: p.id === this.hostId }] : []));
  }

  broadcastLobby(): void { this.broadcast({ t: 'lobby', players: this.roster() }); }

  start(): void {
    if (this.phase !== 'lobby' || this.count < 1) return;
    // Compact the slots so car ids are 0..N-1 (physics createSession needs contiguous entries).
    const active = this.players.filter((p): p is Player => p !== null);
    this.players = new Array(MAX_PLAYERS).fill(null);
    active.forEach((p, i) => { p.id = i; this.players[i] = p; });
    this.session = createSession(active.length, LAPS);
    this.finishOrder = [];
    this.phase = 'countdown';
    this.session.world.race.phase = 'lights';
    this.broadcast({ t: 'start', trackId: this.session.world.trackDef.id, laps: LAPS, players: this.roster() });
    let n = COUNTDOWN_SECONDS;
    this.broadcast({ t: 'countdown', n });
    const cd = setInterval(() => {
      n--;
      if (n > 0) { this.broadcast({ t: 'countdown', n }); return; }
      clearInterval(cd);
      if (!this.session) return;
      this.session.world.race.phase = 'racing'; // physics freezes cars while phase is formation/lights
      this.session.world.race.lightsOn = 0;
      for (const c of this.session.cars) if (this.players[c.id]) this.session.physics.holdCar(c.id, false);
      this.phase = 'racing';
      this.broadcast({ t: 'go' });
    }, 1000);
    this.last = performance.now();
    this.acc = 0;
    this.timer = setInterval(() => this.loop(), 4);
  }

  reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.session?.physics.dispose();
    this.session = null;
    this.phase = 'lobby';
    this.tick = 0;
    for (const p of this.players) if (p) { p.finished = false; p.lastSeq = 0; p.input = createDefaultInput(); }
    if (this.count > 0) this.broadcastLobby();
  }

  loop(): void {
    const s = this.session;
    if (!s) return;
    const now = performance.now();
    this.acc += Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    let steps = 0;
    while (this.acc >= PHYSICS_DT && steps < MAX_STEPS_PER_TICK) {
      this.acc -= PHYSICS_DT;
      steps++;
      for (const p of this.players) if (p) s.physics.setInput(p.id, p.input);
      s.physics.step(s.world, PHYSICS_DT);
      s.world.time += PHYSICS_DT;
      this.tick++;
      for (const p of this.players) if (p) { p.input.gearUp = false; p.input.gearDown = false; p.input.reset = false; }
      if (this.tick % SNAPSHOT_EVERY === 0) this.snapshot(s);
      if (this.phase === 'racing') this.checkFinish(s);
    }
    if (steps === MAX_STEPS_PER_TICK) this.acc = 0; // fell behind: drop time instead of spiralling
  }

  checkFinish(s: Session): void {
    for (const p of this.players) {
      if (!p || p.finished) continue;
      if (s.cars[p.id].track.lap > s.world.config.laps) {
        p.finished = true;
        this.finishOrder.push(p.id);
      }
    }
    if (this.finishOrder.length > 0 && this.finishOrder.length === this.count) {
      this.phase = 'finished';
      this.broadcast({ t: 'finish', results: this.finishOrder.map((id, i) => ({ pos: i + 1, id, name: this.players[id]?.name })) });
      setTimeout(() => this.reset(), 15000);
    }
  }

  snapshot(s: Session): void {
    const r = (n: number, d = 100): number => Math.round(n * d) / d;
    const cars = s.cars.flatMap((c) => {
      const p = this.players[c.id];
      if (!p) return [];
      return [{
        id: c.id, ack: p.lastSeq, age: r(Math.max(0, performance.now() / 1000 - p.lastRecv), 1000),
        p: [r(c.position.x), r(c.position.y), r(c.position.z)],
        q: [r(c.quaternion.x, 1e4), r(c.quaternion.y, 1e4), r(c.quaternion.z, 1e4), r(c.quaternion.w, 1e4)],
        v: [r(c.velocity.x), r(c.velocity.y), r(c.velocity.z)],
        av: [r(c.angularVelocity.x, 1e3), r(c.angularVelocity.y, 1e3), r(c.angularVelocity.z, 1e3)],
        w: c.wheels.map((w) => [r(w.steerAngle, 1e3), r(w.spinAngle, 10), r(w.slip, 1e3)]),
        spd: r(c.speed, 10), rpm: Math.round(c.engine.rpm), gear: c.engine.gear,
        lap: c.track.lap, s: r(c.track.s, 10), surf: c.track.surface,
        in: [r(c.engine.throttle, 100), r(c.engine.brake, 100), r(c.engine.steer, 100)], drs: c.drs.open, dmg: r(c.damage.total, 1e3), fin: this.players[c.id]?.finished ?? false,
      }];
    });
    this.broadcast({ t: 'snap', tick: this.tick, time: r(s.world.time, 1000), cars });
  }
}

const room = new Room();
const ERS: ErsMode[] = ['harvest', 'balanced', 'overtake'];
const num = (v: unknown, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : 0);

const wss = new WebSocketServer({ port: PORT, maxPayload: 2048 });
wss.on('connection', (ws) => {
  let me: Player | null = null;
  const rate = setInterval(() => { if (me) me.msgCount = 0; }, 1000);
  ws.on('message', (raw) => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (me && ++me.msgCount > MAX_MSG_PER_SEC) return; // simple flood guard
    if (m.t === 'join' && !me) {
      me = room.add(ws, String(m.name ?? ''));
      if (!me) { ws.send(JSON.stringify({ t: 'error', msg: 'room full or race in progress' })); ws.close(); return; }
      ws.send(JSON.stringify({ t: 'welcome', id: me.id, host: me.id === room.hostId, players: room.roster() }));
      room.broadcastLobby();
    } else if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', ts: m.ts }));
    } else if (m.t === 'start' && me && me.id === room.hostId) {
      room.start();
    } else if (m.t === 'input' && me && room.phase !== 'lobby') {
      const seq = num(m.seq, 0, 2 ** 31);
      if (seq <= me.lastSeq) return; // drop stale/out-of-order packets
      me.lastSeq = seq;
      me.lastRecv = performance.now() / 1000;
      const i = me.input;
      i.steer = num(m.steer, -1, 1);
      i.throttle = num(m.throttle, 0, 1);
      i.brake = num(m.brake, 0, 1);
      i.gearUp = i.gearUp || m.gearUp === true;
      i.gearDown = i.gearDown || m.gearDown === true;
      i.drs = m.drs === true;
      i.pitLimiter = m.pitLimiter === true;
      i.reset = i.reset || m.reset === true;
      if (typeof m.ers === 'string' && (ERS as string[]).includes(m.ers)) i.ersMode = m.ers as ErsMode;
    }
  });
  ws.on('close', () => { clearInterval(rate); if (me) room.remove(me); });
});
console.log(`apex-formula server listening on :${PORT} (max ${MAX_PLAYERS} players, ${LAPS} laps)`);
