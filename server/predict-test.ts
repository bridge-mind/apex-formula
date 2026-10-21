/** Headless check of client-side prediction: server + predictor in one process with simulated latency/jitter. */
import { PHYSICS_DT } from '../src/core/constants';
import { TrackSpline } from '../src/core/track/TrackSpline';
import { createDefaultInput, createEnvironment } from '../src/core/world';
import { Predictor, type SentInput } from '../src/net/predictor';
import { followerInput } from '../src/physics/bench';
import { createSession, RACE_ASSISTS } from './session';

interface Msg { at: number; payload: unknown }

function run(oneWay: number, jitter: number, reconcileOn: boolean): void {
  const srv = createSession(1, 3);
  srv.world.race.phase = 'racing';
  srv.physics.holdCar(0, false);
  const w = srv.world;
  const pred = new Predictor(w.trackDef, new TrackSpline(w.trackDef), w.config, RACE_ASSISTS, createEnvironment(14), 0);
  const car = srv.cars[0];
  const body = (): { p: number[]; q: number[]; v: number[]; av: number[] } => ({
    p: [car.position.x, car.position.y, car.position.z], q: [car.quaternion.x, car.quaternion.y, car.quaternion.z, car.quaternion.w],
    v: [car.velocity.x, car.velocity.y, car.velocity.z], av: [car.angularVelocity.x, car.angularVelocity.y, car.angularVelocity.z],
  });
  pred.start(body());
  const hist: SentInput[] = [];
  const inbox: Msg[] = [];
  const snaps: Msg[] = [];
  let lastIn = 0, lastOut = 0;
  const truth: number[][] = [];
  const predLog: { t: number; p: number[] }[] = [];
  let lastSeq = 0, lastRecv = 0, seq = 0;
  const jumps: number[] = [];
  let hits = 0;
  const rng = (() => { let x = 12345; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); })();
  const input = createDefaultInput();
  const scratch = createDefaultInput();
  const T = 60;
  let tick = 0;
  for (let t = 0; t < T; t += PHYSICS_DT) {
    // client frame every 2 ticks (60 fps / 60 Hz input)
    if (tick % 2 === 0) {
      // a 'human': follows the racing line from what the PREDICTED car shows, weaving a little
      const d = followerInput(pred.car, pred.world.track, 40, 1.0 * Math.sin(t * 0.7), scratch, 2.5);
      const cur: SentInput = { seq, t, steer: d.steer, throttle: d.throttle, brake: d.brake, drs: false, ers: 'balanced', pitLimiter: false };
      seq++;
      hist.push({ ...cur, seq });
      lastIn = Math.max(lastIn, t + oneWay + (rng() - 0.5) * 2 * jitter);
      inbox.push({ at: lastIn, payload: { ...cur, seq } });
      pred.update(PHYSICS_DT * 2, cur);
      predLog.push({ t, p: [pred.car.position.x, pred.car.position.y, pred.car.position.z] });
    }
    // server receives
    while (inbox.length && inbox[0].at <= t) {
      const m = inbox.shift()!.payload as SentInput;
      input.steer = m.steer; input.throttle = m.throttle; input.brake = m.brake; lastSeq = m.seq; lastRecv = t;
    }
    srv.physics.setInput(0, input);
    srv.physics.step(srv.world, PHYSICS_DT);
    truth.push([car.position.x, car.position.y, car.position.z]);
    if (car.collision.active) hits++;
    tick++;
    if (tick % 6 === 0) {
      lastOut = Math.max(lastOut, t + oneWay + (rng() - 0.5) * 2 * jitter);
      snaps.push({ at: lastOut, payload: { ...body(), ack: lastSeq, age: Math.max(0, t - lastRecv) } });
    }
    // client receives snapshot
    while (snaps.length && snaps[0].at <= t) {
      const s = snaps.shift()!.payload as { p: number[]; q: number[]; v: number[]; av: number[]; ack: number; age: number };
      if (!reconcileOn) continue;
      const before = pred.car.position.clone();
      while (hist.length && hist[0].seq < s.ack) hist.shift();
      pred.reconcile(s, hist, s.ack === 0 ? 0 : s.age, t);
      jumps.push(before.distanceTo(pred.car.position));
    }
  }
  // error: predicted position at client time t vs server truth at server time t + oneWay (where the input will have taken effect)
  const errs: number[] = [];
  for (const e of predLog) {
    if (e.t < 8) continue; // skip launch
    const idx = Math.min(truth.length - 1, Math.round((e.t + oneWay) / PHYSICS_DT));
    const tp = truth[idx];
    errs.push(Math.hypot(e.p[0] - tp[0], e.p[1] - tp[1], e.p[2] - tp[2]));
  }
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const pct = (a: number[], q: number): number => [...a].sort((x, y) => x - y)[Math.floor(a.length * q)] ?? 0;
  const speed = Math.hypot(car.velocity.x, car.velocity.z) * 3.6;
  console.log(`one-way ${oneWay * 1000}ms jitter ±${jitter * 1000}ms reconcile=${reconcileOn}: pred-vs-server error avg ${avg(errs).toFixed(2)} m, p95 ${pct(errs, 0.95).toFixed(2)} m, max ${Math.max(...errs).toFixed(2)} m` + (jumps.length ? ` | correction jump avg ${avg(jumps).toFixed(3)} m, p95 ${pct(jumps, 0.95).toFixed(3)} m, max ${Math.max(...jumps).toFixed(2)} m` : '') + ` | server speed at end ${speed.toFixed(0)} km/h, lap ${car.track.lap}, wall hits ${hits}`);
}

run(0.04, 0.01, false);
run(0.04, 0.01, true);
run(0.1, 0.02, true);
run(0.01, 0.003, true);
