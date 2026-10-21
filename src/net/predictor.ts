/**
 * Client-side prediction for the local player's own car.
 * Runs the SAME VehiclePhysics as the server (single car, same track, assists and driver/team) so controls feel instant,
 * then reconciles against authoritative snapshots: overwrite the body state with the server's, and replay every input the
 * server has not acknowledged yet. Tyres/suspension/drivetrain remain local, so corrections stay small.
 */
import * as THREE from 'three';
import { PHYSICS_DT } from '../core/constants';
import { DRIVERS, DRIVER_BY_ID, TEAMS, TEAM_BY_ID } from '../core/teams';
import type { TrackSpline } from '../core/track/TrackSpline';
import type { Assists, CarState, DriverInput, EnvironmentState, ErsMode, RaceState, SessionConfig, TrackDefinition, World } from '../core/types';
import { createDefaultInput } from '../core/world';
import { VehiclePhysics } from '../physics/VehiclePhysics';

export interface SentInput {
  seq: number;
  /** seconds (performance.now()/1000) when the input was sent */
  t: number;
  steer: number;
  throttle: number;
  brake: number;
  drs: boolean;
  ers: ErsMode;
  pitLimiter: boolean;
}

export interface AuthoritativeBody {
  p: number[];
  q: number[];
  v: number[];
  av: number[];
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class Predictor {
  readonly physics = new VehiclePhysics();
  readonly world: World;
  readonly car: CarState;
  private readonly input: DriverInput = createDefaultInput();
  private acc = 0;
  private active = false;

  constructor(trackDef: TrackDefinition, track: TrackSpline, config: SessionConfig, assists: Assists, env: EnvironmentState, driverIndex: number) {
    const d = DRIVERS[driverIndex];
    const partial = { trackDef, track, teams: TEAMS, drivers: DRIVERS, teamById: TEAM_BY_ID, driverById: DRIVER_BY_ID, config };
    const cars = this.physics.createSession(partial, [{ carId: 0, driverId: d.id, teamId: d.teamId, isPlayer: true, compound: 'soft', gridPosition: driverIndex + 1 }]);
    this.car = cars[0];
    this.physics.setAssists(0, assists);
    this.car.wheels.forEach((w) => (w.temp = 95));
    this.physics.holdCar(0, true);
    const race = { sessionType: 'race', phase: 'lights', time: 0, timeRemaining: -1, lightsOn: 0, totalLaps: config.laps, leaderLap: 0, entries: [], entryByCar: [], sectorFlags: ['green', 'green', 'green'], globalFlag: 'green', drsEnabled: false, fastestLap: null, messages: [], safetyCarSpeed: 0, results: null } as RaceState;
    this.world = { mode: 'live', config, trackDef, track, cars, race, env, playerCarId: 0, time: 0, realTime: 0, paused: false, racingLine: null, teams: TEAMS, drivers: DRIVERS, teamById: TEAM_BY_ID, driverById: DRIVER_BY_ID };
  }

  get isActive(): boolean { return this.active; }

  /** Lights out: release the car at the server's current pose and start predicting. */
  start(from: AuthoritativeBody): void {
    this.setBody(from);
    this.world.race.phase = 'racing';
    this.physics.holdCar(0, false);
    this.acc = 0;
    this.active = true;
  }

  private setBody(b: AuthoritativeBody): void {
    _p.set(b.p[0], b.p[1], b.p[2]);
    _q.set(b.q[0], b.q[1], b.q[2], b.q[3]);
    _v.set(b.v[0], b.v[1], b.v[2]);
    _w.set(b.av[0], b.av[1], b.av[2]);
    this.physics.setBodyState(0, _p, _q, _v, _w);
  }

  private apply(i: { steer: number; throttle: number; brake: number; drs: boolean; ers: ErsMode; pitLimiter: boolean }): void {
    const x = this.input;
    x.steer = i.steer; x.throttle = i.throttle; x.brake = i.brake; x.drs = i.drs; x.ersMode = i.ers; x.pitLimiter = i.pitLimiter;
    x.gearUp = x.gearDown = x.reset = false;
    this.physics.setInput(0, x);
  }

  private stepOnce(): void {
    this.physics.step(this.world, PHYSICS_DT);
    this.world.time += PHYSICS_DT;
  }

  /** Per-frame: advance the prediction with the player's current input at the fixed 120 Hz. */
  update(dt: number, current: SentInput): void {
    if (!this.active) return;
    this.acc += dt;
    let n = 0;
    while (this.acc >= PHYSICS_DT && n < 8) {
      this.apply(current);
      this.stepOnce();
      this.acc -= PHYSICS_DT;
      n++;
    }
    if (n === 8) this.acc = 0;
  }

  /**
   * Authoritative state arrived: rewind to it and replay what the server has not simulated yet.
   * `pending` = sent inputs with seq >= ack (oldest first). The server had already run input `ack` for `ackAge` seconds
   * when it took the snapshot, so that input only needs the remainder; every later input is replayed up to `now`.
   */
  reconcile(server: AuthoritativeBody, pending: SentInput[], ackAge: number, now: number): void {
    if (!this.active) return;
    this.setBody(server);
    if (pending.length === 0) { this.acc = 0; return; }
    const base = pending[0].t + ackAge;
    let carry = 0;
    for (let k = 0; k < pending.length; k++) {
      const e = pending[k];
      const end = k + 1 < pending.length ? pending[k + 1].t : now;
      const ticks = Math.max(0, (end - Math.max(e.t, base)) / PHYSICS_DT) + carry;
      const n = Math.min(Math.floor(ticks), 60);
      carry = ticks - n;
      this.apply(e);
      for (let i = 0; i < n; i++) this.stepOnce();
    }
    this.acc = 0;
  }

  dispose(): void { this.physics.dispose(); }
}
