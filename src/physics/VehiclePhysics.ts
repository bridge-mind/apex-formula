/**
 * Vehicle dynamics for up to 20 cars — Agent 4. Implements IVehiclePhysics (and therefore ICarService).
 * Fixed-step (PHYSICS_DT) with SUBSTEPS internal substeps; zero allocations in step().
 */
import * as THREE from 'three';
import { CAR, GRAVITY, GRID_SIZE, WHEEL_LOCAL_POSITIONS, type TyreCompound } from '../core/constants';
import { events } from '../core/events';
import type { TrackProjection, TrackSpline } from '../core/track/TrackSpline';
import type { Assists, CarEntryConfig, CarState, DriverInput, IVehiclePhysics, World } from '../core/types';
import { copyInput, createEmptyCarState } from '../core/world';
import { finishCar, makeScratchSample, originOf, prepareCar, substepCar, updateAxes, type SimContext } from './CarSim';
import { resolveCarPair, resolveWalls } from './Collisions';
import { PhysCar } from './PhysCar';
import { AERO, COM_HEIGHT, COM_Z, ENGINE, MISC, SUBSTEPS, SUSP } from './tuning';

type SessionWorld = Pick<World, 'trackDef' | 'track' | 'teams' | 'drivers' | 'teamById' | 'driverById' | 'config'>;

const DEFAULT_ASSISTS: Assists = {
  tractionControl: 'off',
  abs: false,
  autoGears: true,
  steeringAssist: false,
  brakingAssist: false,
  racingLine: 'off',
  pitAssist: false,
  ersAssist: true,
  drsAssist: true,
};

const _sample = makeScratchSample();
const _proj: TrackProjection = { s: 0, lateral: 0, distance: 0 };
const _up = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _pt = new THREE.Vector3();
const _nm = new THREE.Vector3();

export class VehiclePhysics implements IVehiclePhysics {
  private cars: PhysCar[] = [];
  private states: CarState[] = [];
  private world: SessionWorld | null = null;
  private track: TrackSpline | null = null;
  private ctx: SimContext | null = null;
  private readonly pairCooldown = new Float64Array(GRID_SIZE * GRID_SIZE);
  private time = 0;

  /* ─────────────────────────────── session ─────────────────────────────── */

  createSession(world: SessionWorld, entries: CarEntryConfig[]): CarState[] {
    this.world = world;
    this.track = world.track;
    this.time = 0;
    this.pairCooldown.fill(-1e9);
    this.ctx = {
      track: world.track,
      wetness: 0,
      trackTemp: 38,
      time: 0,
      phaseFrozen: false,
      fuelFloor: world.config.laps > 70 ? 0 : 0.5,
    };
    const isRace = world.config.sessionType === 'race';
    this.cars = [];
    this.states = [];
    for (const e of entries) {
      const st = createEmptyCarState(e.carId, e.driverId, e.teamId, e.isPlayer, e.compound);
      st.gridPosition = e.gridPosition;
      st.fuel = isRace ? 105 : 30;
      for (const w of st.wheels) w.temp = 85; // out of the blankets
      const team = world.teamById[e.teamId] ?? world.teams[0];
      const driver = world.driverById[e.driverId] ?? world.drivers[0];
      const car = new PhysCar(st, team, driver, DEFAULT_ASSISTS);
      car.aeroFactor = 1 - AERO.aeroPerfSlope * (1 - team.performance.aero);
      car.powerFactor = 1 - ENGINE.powerPerfSlope * (1 - team.performance.power);
      const weight = car.mass * GRAVITY;
      for (let i = 0; i < 4; i++) car.preload[i] = weight * (i < 2 ? SUSP.frontShare : 1 - SUSP.frontShare) * 0.5;
      this.cars[e.carId] = car;
      this.states[e.carId] = st;
      this.placeAt(car, world.track.wrapS(-20 - 8 * e.carId), 0, true);
    }
    return this.states;
  }

  setInput(carId: number, input: DriverInput): void {
    const c = this.cars[carId];
    if (c) copyInput(input, c.state.input);
  }

  setAssists(carId: number, assists: Assists): void {
    const c = this.cars[carId];
    if (c) Object.assign(c.assists, assists);
  }

  dispose(): void {
    this.cars = [];
    this.states = [];
    this.world = null;
    this.track = null;
    this.ctx = null;
  }

  /* ─────────────────────────────── step ─────────────────────────────── */

  step(world: World, dt: number): void {
    const ctx = this.ctx;
    const track = this.track;
    if (!ctx || !track) return;
    const cars = this.cars;
    const n = cars.length;
    this.time += dt;
    ctx.time = this.time;
    ctx.wetness = world.env.weather.wetness;
    ctx.trackTemp = world.env.weather.trackTempC;
    const phase = world.race ? world.race.phase : 'idle';
    ctx.phaseFrozen = phase === 'formation' || phase === 'lights';

    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (!car) continue;
      if (ctx.phaseFrozen && !car.state.chassis.held) car.state.chassis.held = true;
      if (car.state.input.reset) this.resetCar(i);
    }

    this.computeNeighbours();

    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (car) prepareCar(car, ctx, dt);
    }
    const h = dt / SUBSTEPS;
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      for (let i = 0; i < n; i++) {
        const car = cars[i];
        if (car && !car.frozen) substepCar(car, h);
      }
    }
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (car && !car.frozen) resolveWalls(car, track);
    }
    for (let i = 0; i < n; i++) {
      const a = cars[i];
      if (!a || a.parked || a.ghostTimer > 0) continue;
      for (let j = i + 1; j < n; j++) {
        const b = cars[j];
        if (!b || b.parked || b.ghostTimer > 0) continue;
        const impulse = resolveCarPair(a, b);
        if (impulse > 400) this.emitCollision(a, b, impulse);
      }
    }
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (car) finishCar(car, ctx, dt);
    }
  }

  private emitCollision(a: PhysCar, b: PhysCar, impulse: number): void {
    const key = a.state.id * GRID_SIZE + b.state.id;
    if (key < 0 || key >= this.pairCooldown.length) return;
    if (this.time - this.pairCooldown[key] < 0.4) return;
    this.pairCooldown[key] = this.time;
    const ca = a.state.collision;
    const cb = b.state.collision;
    events.emit('car:collision', { carId: a.state.id, withCar: b.state.id, impulse, point: ca.point.clone(), normal: ca.normal.clone() });
    events.emit('car:collision', { carId: b.state.id, withCar: a.state.id, impulse, point: cb.point.clone(), normal: cb.normal.clone() });
  }

  /** Slipstream (drag reduction directly behind a car) and dirty air (front downforce loss following through corners). */
  private computeNeighbours(): void {
    const cars = this.cars;
    const track = this.track!;
    const n = cars.length;
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (!car) continue;
      updateAxes(car);
    }
    const range = AERO.slipstreamRange;
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (!car) continue;
      car.slipstream = 0;
      car.dirtyAir = 0;
      const st = car.state;
      const speed = st.speed;
      if (car.frozen || speed < 10) continue;
      const curv = Math.abs(track.sample(st.track.s, _sample).curvature);
      const cornering = curv > 0.003 ? Math.min(1, curv / 0.012) : 0;
      const gapDist = speed * AERO.dirtyAirTime;
      let slip = 0;
      let dirty = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const other = cars[j];
        if (!other || other.parked || other.ghostTimer > 0) continue;
        const dx = other.com.x - car.com.x;
        const dz = other.com.z - car.com.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < range * range) {
          const along = dx * car.fwd.x + dz * car.fwd.z;
          if (along > 3) {
            const latOff = Math.abs(dx * car.left.x + dz * car.left.z);
            const overlap = Math.min(1, Math.max(0, (2.6 - latOff) / 1.6));
            const f = (1 - along / range) * overlap;
            if (f > slip) slip = f;
          }
        }
        if (cornering > 0) {
          const ds = track.deltaS(st.track.s, other.state.track.s);
          if (ds > 0 && ds < gapDist && Math.abs(other.state.track.lateral - st.track.lateral) < 6) {
            const f = (1 - ds / gapDist) * cornering;
            if (f > dirty) dirty = f;
          }
        }
      }
      car.slipstream = slip * AERO.slipstreamMax;
      car.dirtyAir = dirty * AERO.dirtyAirMax;
    }
  }

  /* ─────────────────────────────── ICarService ─────────────────────────────── */

  holdCar(carId: number, held: boolean): void {
    const c = this.cars[carId];
    if (!c) return;
    c.state.chassis.held = held;
    if (held) {
      c.state.velocity.set(0, 0, 0);
      c.state.angularVelocity.set(0, 0, 0);
      c.prevVel.set(0, 0, 0);
    }
  }

  serviceCar(carId: number, opts: { compound?: TyreCompound; repair?: boolean }): void {
    const c = this.cars[carId];
    if (!c) return;
    const st = c.state;
    if (opts.compound) {
      st.tyres.compound = opts.compound;
      st.tyres.age = 0;
      st.tyres.wear = 0;
      st.tyres.gripFactor = 1;
      for (const w of st.wheels) {
        w.wear = 0;
        w.temp = 85;
      }
    }
    if (opts.repair) {
      const d = st.damage;
      d.frontWing = 0;
      d.rearWing = 0;
      d.floor = 0;
      d.suspension[0] = d.suspension[1] = d.suspension[2] = d.suspension[3] = 0;
      d.total = 0;
      st.engine.health = 1;
      c.failed = false;
    }
    if (this.world && this.world.config.sessionType !== 'race') st.fuel = Math.max(st.fuel, 30);
  }

  resetCar(carId: number, s?: number): void {
    const c = this.cars[carId];
    const track = this.track;
    if (!c || !track) return;
    let at = s;
    if (at === undefined) {
      track.project(c.state.position.x, c.state.position.z, c.hintS, _proj);
      at = track.wrapS(_proj.s + 6);
    }
    this.placeAt(c, track.wrapS(at), 0, false);
    c.state.engine.gear = 1;
    c.ghostTimer = MISC.resetGhostSeconds;
    events.emit('car:reset', { carId });
  }

  retireCar(carId: number): void {
    const c = this.cars[carId];
    if (!c) return;
    c.state.status = 'retired';
    c.state.drs.open = false;
  }

  placeOnGridSlot(carId: number, slot: number): void {
    const c = this.cars[carId];
    const track = this.track;
    if (!c || !track) return;
    const g = track.gridSlot(slot);
    this.placePose(c, g.position, g.quaternion, g.s, g.lateral, true);
    c.state.engine.gear = 1;
  }

  placeInPitBox(carId: number, boxIndex: number): void {
    const c = this.cars[carId];
    const track = this.track;
    if (!c || !track) return;
    const g = track.pitBox(boxIndex);
    this.placePose(c, g.position, g.quaternion, g.s, g.lateral, true);
    c.state.engine.gear = 1;
  }

  /**
   * Network reconciliation (multiplayer client): overwrite the rigid-body state of a car with an authoritative one.
   * Tyre, suspension and drivetrain state stay as simulated locally; only pose and velocities are replaced.
   */
  setBodyState(carId: number, position: THREE.Vector3, quaternion: THREE.Quaternion, velocity: THREE.Vector3, angularVelocity: THREE.Vector3): void {
    const c = this.cars[carId];
    if (!c) return;
    const st = c.state;
    st.position.copy(position);
    st.quaternion.copy(quaternion);
    updateAxes(c);
    c.com.copy(position).addScaledVector(c.up, COM_HEIGHT).addScaledVector(c.fwd, COM_Z);
    st.velocity.copy(velocity);
    st.angularVelocity.copy(angularVelocity);
    c.prevVel.copy(velocity);
    c.frameValid = false;
  }

  setDrsAvailable(carId: number, available: boolean): void {
    const c = this.cars[carId];
    if (c) c.state.drs.available = available;
  }

  /* ─────────────────────────────── placement ─────────────────────────────── */

  private placeAt(car: PhysCar, s: number, lateral: number, resetLap: boolean): void {
    const track = this.track!;
    track.sample(s, _sample);
    _pos.copy(_sample.position).addScaledVector(_sample.left, lateral);
    _quat.setFromAxisAngle(_up, _sample.heading);
    this.placePose(car, _pos, _quat, s, lateral, resetLap);
  }

  private placePose(car: PhysCar, position: THREE.Vector3, quaternion: THREE.Quaternion, s: number, lateral: number, resetLap: boolean): void {
    const track = this.track!;
    const st = car.state;
    st.position.copy(position);
    st.quaternion.copy(quaternion);
    updateAxes(car);
    car.com.copy(position).addScaledVector(car.up, COM_HEIGHT).addScaledVector(car.fwd, COM_Z);
    st.velocity.set(0, 0, 0);
    st.angularVelocity.set(0, 0, 0);
    car.prevVel.set(0, 0, 0);
    car.accelSmooth.set(0, 0, 0);
    st.localAccel.set(0, 0, 0);
    st.speed = 0;
    st.speedAbs = 0;
    car.travel.fill(0);
    car.travelRate.fill(0);
    car.wheelOmega.fill(0);
    car.wheelSteer.fill(0);
    car.slipPower.fill(0);
    car.absFactor.fill(1);
    car.steer = 0;
    car.shiftTimer = 0;
    car.tcFactor = 1;
    car.brakeHold = 0;
    car.minClearance = 1;
    car.kerbWheels = 0;
    car.anyContact = true;
    car.parked = false;
    car.hintS = s;
    car.prevS = s;
    car.frameValid = false;
    const tr = st.track;
    tr.s = s;
    tr.lateral = lateral;
    if (resetLap) tr.lap = 0;
    tr.progress = tr.lap * track.length + s;
    tr.sector = track.sectorOf(s);
    tr.surface = track.surfaceAt(s, lateral);
    tr.inPitLane = track.isInPitLane(s, lateral);
    tr.forwardSpeed = 0;
    tr.wheelsOff = 0;
    st.drs.open = false;
    st.chassis.airborne = false;
    st.chassis.bottoming = 0;
    st.chassis.kerbRumble = 0;
    st.collision.active = false;
    st.collision.impulse = 0;
    st.engine.rpm = ENGINE.idle;
    st.engine.limiter = false;
    st.engine.powerKw = 0;
    originOf(car, _pt);
    for (let i = 0; i < 4; i++) {
      const w = st.wheels[i];
      const wl = WHEEL_LOCAL_POSITIONS[i];
      w.worldPos.copy(_pt).addScaledVector(car.left, wl[0]).addScaledVector(car.fwd, wl[2]).addScaledVector(car.up, CAR.wheelRadius);
      w.suspensionTravel = 0;
      w.spinRate = 0;
      w.steerAngle = 0;
      w.slipRatio = 0;
      w.slipAngle = 0;
      w.slip = 0;
      w.load = car.preload[i];
      w.contact = true;
      w.locked = false;
      w.spinning = false;
      car.wheelS[i] = s;
      car.wheelLat[i] = lateral + wl[0];
      car.wheelSurface[i] = track.surfaceAt(s, lateral + wl[0]);
      w.surface = car.wheelSurface[i];
      car.groundY[i] = position.y;
      car.groundNormal[i].copy(_nm.set(0, 1, 0));
    }
  }
}