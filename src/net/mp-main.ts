/**
 * Multiplayer browser client. Sends ONLY inputs to the authoritative server (server/index.ts) and renders the
 * cars it reports, reusing the game's own render / track / car / camera / input / audio / vfx systems.
 * Other drivers are interpolated 100 ms in the past; your own car is shown at the latest server state + short extrapolation.
 */
import * as THREE from 'three';
import { CORE_CIRCUITS } from '../core/circuits';
import { DRIVERS, DRIVER_BY_ID, TEAMS, TEAM_BY_ID } from '../core/teams';
import { TrackSpline } from '../core/track/TrackSpline';
import type { Assists, CarState, DriverInput, IAudioSystem, ICameraSystem, ICarVisuals, IInputSystem, IRenderSystem, ITrackBuilder, IVFXSystem, InputCommand, RaceState, SessionConfig, TrackDefinition, World } from '../core/types';
import { copyCarState, createEmptyCarState, createEnvironment } from '../core/world';
import { RenderSystem } from '../render/RenderSystem';
import { TrackBuilder } from '../track/TrackBuilder';
import { CIRCUITS as TRACK_CIRCUITS } from '../track/circuits';
import { CarVisuals } from '../car/CarVisuals';
import { AudioSystem } from '../audio/AudioSystem';
import { InputSystem } from '../input/InputSystem';
import { CameraSystem } from '../camera/CameraSystem';
import { VFXSystem } from '../vfx/VFXSystem';
import { Predictor, type SentInput } from './predictor';

const CIRCUITS: TrackDefinition[] = [...CORE_CIRCUITS, ...TRACK_CIRCUITS.filter((c) => !CORE_CIRCUITS.some((k) => k.id === c.id))];
const INTERP_DELAY = 0.1; // s: remote cars are rendered this far in the past (2 snapshots at 20 Hz)
const MAX_EXTRAPOLATION = 0.25; // s
const INPUT_HZ = 60;
const CORRECTION_TAU = 0.1; // s: visual smoothing of prediction corrections
const RACE_ASSISTS: Assists = { tractionControl: 'medium', abs: true, autoGears: true, steeringAssist: false, brakingAssist: false, racingLine: 'off', pitAssist: false, ersAssist: false, drsAssist: false };

interface SnapCar {
  id: number; ack: number; age: number; p: number[]; q: number[]; v: number[]; av: number[]; w: number[][]; spd: number; rpm: number; gear: number;
  lap: number; s: number; surf: string; in: number[]; drs: boolean; dmg: number; fin: boolean;
}
interface Snap { time: number; cars: Map<number, SnapCar> }
interface RosterEntry { id: number; name: string; host: boolean }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

class MultiplayerGame {
  private readonly render: IRenderSystem;
  private readonly cameraSys: ICameraSystem;
  private readonly input: IInputSystem;
  private readonly audio: IAudioSystem;
  private track: ITrackBuilder | null = null;
  private cars: ICarVisuals | null = null;
  private vfx: IVFXSystem | null = null;
  private world: World | null = null;
  private predictor: Predictor | null = null;
  private hist: SentInput[] = [];
  private curInput: SentInput = { seq: 0, t: 0, steer: 0, throttle: 0, brake: 0, drs: false, ers: 'balanced', pitLimiter: false };
  private readonly errPos = new THREE.Vector3();
  private readonly errQuat = new THREE.Quaternion();
  private readonly idQuat = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();

  private ws: WebSocket | null = null;
  private myId = -1;
  private roster: RosterEntry[] = [];
  private snaps: Snap[] = [];
  private offset = NaN;
  private seq = 0;
  private sendAcc = 0;
  private pend = { gearUp: false, gearDown: false, reset: false };
  private pingMs = 0;
  private lastFrame = performance.now();
  private cockpitView = false;
  private hudVisible = true;
  private building = false;
  private racing = false;
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();

  constructor() {
    const canvas = $<HTMLCanvasElement>('game-canvas');
    this.render = new RenderSystem(canvas);
    this.cameraSys = new CameraSystem(innerWidth / innerHeight);
    this.render.setCamera(this.cameraSys.camera);
    this.input = new InputSystem();
    this.audio = new AudioSystem();
    this.render.setMenuMode(true);
    this.cameraSys.setCinematic('menu-orbit');
    this.input.setDrivingEnabled(false);
    addEventListener('resize', () => { this.render.resize(innerWidth, innerHeight); this.cameraSys.resize(innerWidth / innerHeight); });
    this.render.resize(innerWidth, innerHeight);

    $('name').setAttribute('value', localStorage.getItem('mp-name') ?? '');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ($<HTMLInputElement>('url')).value = localStorage.getItem('mp-url') ?? `${proto}://${location.hostname}:8080`;
    $('join').addEventListener('click', () => this.join());
    $('start').addEventListener('click', () => this.ws?.send(JSON.stringify({ t: 'start' })));
    setInterval(() => this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 2000);
    requestAnimationFrame((t) => this.frame(t));
  }

  /* ─────────────────────────────── network ─────────────────────────────── */

  private say(text: string): void { $('msg').textContent = text; }

  private join(): void {
    const name = ($<HTMLInputElement>('name')).value.trim() || 'Pembalap';
    const url = ($<HTMLInputElement>('url')).value.trim();
    localStorage.setItem('mp-name', name);
    localStorage.setItem('mp-url', url);
    void this.audio.resume();
    this.ws?.close();
    this.say('Menghubungkan…');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name }));
    ws.onerror = () => this.say('Gagal terhubung ke server.');
    ws.onclose = () => { this.say('Koneksi terputus.'); $('lobby').style.display = 'block'; this.endSession(); };
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)));
  }

  private onMessage(m: { t: string; [k: string]: unknown }): void {
    switch (m.t) {
      case 'welcome':
        this.myId = m.id as number;
        this.say('Terhubung. Menunggu host memulai…');
        ($<HTMLButtonElement>('join')).disabled = true;
        this.setRoster(m.players as RosterEntry[]);
        break;
      case 'lobby':
        if (this.world) this.endSession();
        $('lobby').style.display = 'block';
        $('results').style.display = 'none';
        this.setRoster(m.players as RosterEntry[]);
        break;
      case 'start':
        this.setRoster(m.players as RosterEntry[]);
        void this.buildSession(m.trackId as string, m.laps as number);
        break;
      case 'countdown': this.big(String(m.n)); break;
      case 'go': this.big('GO!', 1200); this.racing = true; this.tryStartPredictor(); break;
      case 'snap': this.onSnap(m as unknown as { time: number; cars: SnapCar[] }); break;
      case 'pong': this.pingMs = performance.now() - (m.ts as number); break;
      case 'finish': this.showResults(m.results as { pos: number; name: string }[]); break;
      case 'error': this.say(String(m.msg)); break;
    }
  }

  private setRoster(players: RosterEntry[]): void {
    this.roster = players;
    $('players').innerHTML = players.map((p) => `${p.id === this.myId ? '▶ ' : ''}${p.name.replace(/</g, '&lt;')}${p.host ? ' (host)' : ''}`).join('<br>');
    const me = players.find((p) => p.id === this.myId);
    $('start').style.display = me?.host ? 'block' : 'none';
  }

  private onSnap(m: { time: number; cars: SnapCar[] }): void {
    const x = performance.now() / 1000 - m.time;
    this.offset = Number.isNaN(this.offset) ? x : x < this.offset ? x : this.offset + (x - this.offset) * 0.02;
    this.snaps.push({ time: m.time, cars: new Map(m.cars.map((c) => [c.id, c])) });
    if (this.snaps.length > 40) this.snaps.shift();
    const mine = this.snaps[this.snaps.length - 1].cars.get(this.myId);
    if (!mine || !this.predictor) return;
    if (!this.predictor.isActive) { this.tryStartPredictor(); return; }
    this.reconcile(mine);
  }

  private tryStartPredictor(): void {
    if (!this.racing || !this.predictor || this.predictor.isActive || !this.snaps.length) return;
    const mine = this.snaps[this.snaps.length - 1].cars.get(this.myId);
    if (mine) { this.predictor.start(mine); this.errPos.set(0, 0, 0); this.errQuat.identity(); }
  }

  /** Rewind the local prediction to the server's state and replay unacknowledged inputs; hide the jump by decaying an offset. */
  private reconcile(mine: SnapCar): void {
    const pr = this.predictor;
    if (!pr) return;
    const car = pr.car;
    // what the player currently sees (prediction + residual offset), to keep it continuous across the correction
    this.tmpV.copy(car.position).add(this.errPos);
    this.tmpQ.copy(this.errQuat).multiply(car.quaternion);
    while (this.hist.length && this.hist[0].seq < mine.ack) this.hist.shift();
    pr.reconcile(mine, this.hist, mine.ack === 0 ? 0 : mine.age, performance.now() / 1000);
    this.errPos.copy(this.tmpV).sub(car.position);
    this.errQuat.copy(this.tmpQ).multiply(this.qb.copy(car.quaternion).invert()); // offset = displayed * inverse(new predicted)
    if (this.errPos.length() > 10) { this.errPos.set(0, 0, 0); this.errQuat.identity(); }
  }

  /* ─────────────────────────────── session ─────────────────────────────── */

  private async buildSession(trackId: string, laps: number): Promise<void> {
    if (this.building) return;
    this.building = true;
    this.endSession();
    $('lobby').style.display = 'none';
    this.big('Memuat sirkuit…');
    const trackDef = CIRCUITS.find((c) => c.id === trackId) ?? CIRCUITS[0];
    const spline = new TrackSpline(trackDef);
    const env = createEnvironment(14);
    this.render.setEnvironment(trackDef, env);
    const config: SessionConfig = { mode: 'quick-race', sessionType: 'race', circuitId: trackDef.id, laps, playerDriverId: DRIVERS[Math.max(0, this.myId)].id, aiDifficulty: 0.8, aiCount: 0, weather: 'dry', timeOfDay: -1, assists: RACE_ASSISTS, startingCompound: 'soft', gridOrder: 'performance', randomEvents: false };
    const cars: CarState[] = this.roster.map((r) => {
      const d = DRIVERS[r.id];
      const c = createEmptyCarState(r.id, d.id, d.teamId, r.id === this.myId, 'soft');
      c.gridPosition = r.id + 1;
      return c;
    });
    const race = { sessionType: 'race', phase: 'lights', time: 0, timeRemaining: -1, lightsOn: 0, totalLaps: laps, leaderLap: 0, entries: [], entryByCar: [], sectorFlags: ['green', 'green', 'green'], globalFlag: 'green', drsEnabled: false, fastestLap: null, messages: [], safetyCarSpeed: 0, results: null } as RaceState;
    const world: World = { mode: 'live', config, trackDef, track: spline, cars, race, env, playerCarId: this.myId, time: 0, realTime: 0, paused: false, racingLine: null, teams: TEAMS, drivers: DRIVERS, teamById: TEAM_BY_ID, driverById: DRIVER_BY_ID };
    this.world = world;
    this.track = new TrackBuilder();
    this.cars = new CarVisuals();
    this.vfx = new VFXSystem();
    const noop = (): void => {};
    await this.track.build(trackDef, spline, this.render.sessionGroup, noop);
    await this.cars.build(world, this.render.sessionGroup, noop);
    this.vfx.createSession(world, this.render.sessionGroup);
    this.audio.createSession(world);
    this.predictor = new Predictor(trackDef, spline, config, RACE_ASSISTS, env, this.myId);
    this.hist = [];
    this.errPos.set(0, 0, 0);
    this.errQuat.identity();
    this.render.setMenuMode(false);
    this.audio.setMenuMusic(false);
    this.cameraSys.setTarget(this.myId);
    this.cameraSys.setCinematic(null);
    this.cameraSys.setMode('chase');
    this.cameraSys.snap();
    this.input.setDrivingEnabled(true);
    this.building = false;
    $('hud').style.display = 'block';
    $('tower').style.display = 'block';
    this.big('');
  }

  private endSession(): void {
    this.racing = false;
    this.snaps = [];
    this.offset = NaN;
    if (!this.world) return;
    this.input.setDrivingEnabled(false);
    this.predictor?.dispose();
    this.predictor = null;
    this.vfx?.dispose();
    this.audio.endSession();
    this.cars?.dispose();
    this.track?.dispose();
    this.render.clearSession();
    this.vfx = null; this.cars = null; this.track = null; this.world = null;
    this.render.setMenuMode(true);
    this.cameraSys.setCinematic('menu-orbit');
    $('hud').style.display = 'none';
    $('tower').style.display = 'none';
  }

  private big(text: string, hideAfterMs = 0): void {
    const el = $('big');
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
    if (hideAfterMs) setTimeout(() => { if (el.textContent === text) el.style.display = 'none'; }, hideAfterMs);
  }

  private showResults(results: { pos: number; name: string }[]): void {
    const el = $('results');
    el.innerHTML = '<h2 style="margin-top:0">Hasil</h2>' + results.map((r) => `${r.pos}. ${String(r.name).replace(/</g, '&lt;')}`).join('<br>') + '<p style="opacity:.7;font-size:13px">Kembali ke lobi sebentar lagi…</p>';
    el.style.display = 'block';
  }

  /* ─────────────────────────────── per frame ─────────────────────────────── */

  private sendInput(raw: DriverInput, dt: number): void {
    this.pend.gearUp ||= raw.gearUp;
    this.pend.gearDown ||= raw.gearDown;
    this.pend.reset ||= raw.reset;
    this.curInput = { seq: this.seq, t: 0, steer: raw.steer, throttle: raw.throttle, brake: raw.brake, drs: raw.drs, ers: raw.ersMode, pitLimiter: raw.pitLimiter };
    this.sendAcc += dt;
    if (this.sendAcc < 1 / INPUT_HZ) return;
    this.sendAcc = Math.min(this.sendAcc - 1 / INPUT_HZ, 1 / INPUT_HZ);
    if (this.ws?.readyState !== 1) return;
    const seq = ++this.seq;
    this.hist.push({ ...this.curInput, seq, t: performance.now() / 1000 });
    if (this.hist.length > 240) this.hist.shift();
    this.ws.send(JSON.stringify({ t: 'input', seq, steer: raw.steer, throttle: raw.throttle, brake: raw.brake, gearUp: this.pend.gearUp, gearDown: this.pend.gearDown, drs: raw.drs, ers: raw.ersMode, pitLimiter: raw.pitLimiter, reset: this.pend.reset }));
    this.pend.gearUp = this.pend.gearDown = this.pend.reset = false;
  }

  private writeCar(car: CarState, a: SnapCar, b: SnapCar | null, t: number, extra: number): void {
    const pick = (i: number, k: 'p' | 'v'): number => (b ? lerp(a[k][i], b[k][i], t) : a[k][i]);
    car.velocity.set(pick(0, 'v'), pick(1, 'v'), pick(2, 'v'));
    car.position.set(pick(0, 'p') + car.velocity.x * extra, pick(1, 'p') + car.velocity.y * extra, pick(2, 'p') + car.velocity.z * extra);
    this.qa.set(a.q[0], a.q[1], a.q[2], a.q[3]);
    if (b) { this.qb.set(b.q[0], b.q[1], b.q[2], b.q[3]); this.qa.slerp(this.qb, t); }
    car.quaternion.copy(this.qa);
    car.speed = b ? lerp(a.spd, b.spd, t) : a.spd;
    car.speedAbs = Math.abs(car.speed);
    car.track.forwardSpeed = car.speed;
    const s = b ?? a;
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      w.steerAngle = lerp(a.w[i][0], s.w[i][0], b ? t : 0);
      w.spinAngle = lerp(a.w[i][1], s.w[i][1], b ? t : 0);
      w.slip = lerp(a.w[i][2], s.w[i][2], b ? t : 0);
    }
    car.engine.rpm = s.rpm; car.engine.gear = s.gear;
    car.engine.throttle = s.in[0]; car.engine.brake = s.in[1]; car.engine.steer = s.in[2];
    car.drs.open = s.drs;
    car.damage.total = s.dmg;
    car.track.lap = s.lap; car.track.s = s.s;
    car.track.surface = s.surf as CarState['track']['surface'];
    car.status = s.fin ? 'finished' : 'racing';
  }

  private applySnapshots(): void {
    const world = this.world;
    if (!world || !this.snaps.length || Number.isNaN(this.offset)) return;
    const serverNow = performance.now() / 1000 - this.offset;
    const renderT = serverNow - INTERP_DELAY;
    while (this.snaps.length > 2 && this.snaps[1].time < renderT) this.snaps.shift();
    const last = this.snaps[this.snaps.length - 1];
    const [s0, s1] = [this.snaps[0], this.snaps[1] ?? null];
    for (const car of world.cars) {
      if (car.id === this.myId) {
        const l = last.cars.get(car.id);
        if (this.predictor?.isActive) {
          copyCarState(this.predictor.car, car);
          car.id = this.myId;
          car.position.add(this.errPos);
          car.quaternion.premultiply(this.errQuat);
          if (l) { car.track.lap = l.lap; car.track.s = l.s; car.status = l.fin ? 'finished' : 'racing'; car.damage.total = l.dmg; }
        } else if (l) this.writeCar(car, l, null, 0, Math.min(Math.max(serverNow - last.time, 0), MAX_EXTRAPOLATION));
        continue;
      }
      const a = s0.cars.get(car.id);
      const b = s1?.cars.get(car.id) ?? null;
      if (!a) continue;
      if (b && s1 && renderT >= s0.time && renderT <= s1.time) this.writeCar(car, a, b, (renderT - s0.time) / Math.max(1e-6, s1.time - s0.time), 0);
      else if (renderT < s0.time) this.writeCar(car, a, null, 0, 0);
      else { const l = last.cars.get(car.id); if (l) this.writeCar(car, l, null, 0, Math.min(Math.max(renderT - last.time, 0), MAX_EXTRAPOLATION)); }
    }
  }

  private updateHud(): void {
    const world = this.world;
    if (!world) return;
    const me = world.cars[this.myId];
    const L = world.track.length;
    const order = [...world.cars].sort((x, y) => y.track.lap * L + y.track.s - (x.track.lap * L + x.track.s));
    const pos = order.findIndex((c) => c.id === this.myId) + 1;
    $('speed').innerHTML = `${Math.round(me.speedAbs * 3.6)} <small>km/h</small>`;
    $('info').innerHTML = `Gigi ${me.engine.gear} · ${Math.round(me.engine.rpm)} rpm<br>Lap ${Math.min(Math.max(me.track.lap, 1), world.config.laps)}/${world.config.laps} · P${pos}/${world.cars.length}<br>Ping ${Math.round(this.pingMs)} ms`;
    $('tower').innerHTML = order.map((c, i) => `${i + 1}. ${c.id === this.myId ? '<b>' : ''}${(this.roster.find((r) => r.id === c.id)?.name ?? '?').replace(/</g, '&lt;')}${c.id === this.myId ? '</b>' : ''}${c.status === 'finished' ? ' 🏁' : ''}`).join('<br>');
  }

  private handle(cmd: InputCommand): void {
    if (cmd.type === 'cycle-camera') this.cameraSys.cycle();
    else if (cmd.type === 'look-back') this.cameraSys.setLookBack(cmd.active);
    else if (cmd.type === 'toggle-mute') { this.muted = !this.muted; this.audio.setMuted(this.muted); }
    else if (cmd.type === 'toggle-hud') { this.hudVisible = !this.hudVisible; $('hud').style.display = $('tower').style.display = this.hudVisible && this.world ? 'block' : 'none'; }
  }
  private muted = false;

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const world = this.world;
    if (world) {
      world.realTime += dt;
      world.time += dt;
      this.input.setSpeedHint?.(world.cars[this.myId]?.speedAbs ?? 0);
    }
    this.input.update(dt);
    for (const cmd of this.input.consumeCommands()) this.handle(cmd);
    if (world && !this.building) {
      const raw = this.input.getDriverInput();
      this.sendInput(raw, dt);
      if (this.predictor?.isActive) {
        this.predictor.update(dt, this.curInput);
        const k = 1 - Math.exp(-dt / CORRECTION_TAU);
        this.errPos.multiplyScalar(1 - k);
        this.errQuat.slerp(this.idQuat, k);
      }
      this.applySnapshots();
    }
    const camera = this.cameraSys.camera;
    this.cameraSys.update(world, dt);
    if (world && !this.building) {
      const cockpit = this.cameraSys.getCinematic() === null && this.cameraSys.getMode() === 'cockpit';
      if (cockpit !== this.cockpitView) { this.cockpitView = cockpit; this.cars?.setCockpitView(this.myId, cockpit); }
      this.track?.update(world, camera, dt);
      this.cars?.update(world, camera, dt);
      this.vfx?.update(world, camera, dt);
      this.updateHud();
    }
    this.render.update(world, camera, dt);
    this.audio.update(world, camera, dt);
    this.render.render();
  }
}

new MultiplayerGame();
