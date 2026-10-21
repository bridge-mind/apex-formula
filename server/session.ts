/** Builds an authoritative race session for N human players (no AI). Reuses the game's own physics unchanged. */
import { KINGSMERE } from '../src/core/circuits';
import { DRIVERS, DRIVER_BY_ID, TEAMS, TEAM_BY_ID } from '../src/core/teams';
import { TrackSpline } from '../src/core/track/TrackSpline';
import type { Assists, CarEntryConfig, CarState, DriverInput, RaceState, SessionConfig, World } from '../src/core/types';
import { createDefaultInput, createEnvironment } from '../src/core/world';
import { VehiclePhysics } from '../src/physics/VehiclePhysics';

export const MAX_PLAYERS = Math.min(20, DRIVERS.length);

/** Fixed rule set for every human: same assists for everybody keeps the race fair. */
export const RACE_ASSISTS: Assists = {
  tractionControl: 'medium',
  abs: true,
  autoGears: true,
  steeringAssist: false,
  brakingAssist: false,
  racingLine: 'off',
  pitAssist: false,
  ersAssist: false,
  drsAssist: false,
};

export interface Session {
  world: World;
  physics: VehiclePhysics;
  cars: CarState[];
  inputs: DriverInput[];
}

export function createSession(playerCount: number, laps = 3): Session {
  const def = KINGSMERE;
  const track = new TrackSpline(def);
  const config: SessionConfig = {
    mode: 'quick-race',
    sessionType: 'race',
    circuitId: def.id,
    laps,
    playerDriverId: DRIVERS[0].id,
    aiDifficulty: 0.8,
    aiCount: 0,
    weather: 'dry',
    timeOfDay: -1,
    assists: RACE_ASSISTS,
    startingCompound: 'soft',
    gridOrder: 'performance',
    randomEvents: false,
  };
  const entries: CarEntryConfig[] = [];
  for (let i = 0; i < playerCount; i++) {
    const d = DRIVERS[i];
    entries.push({ carId: i, driverId: d.id, teamId: d.teamId, isPlayer: true, compound: 'soft', gridPosition: i + 1 });
  }
  const physics = new VehiclePhysics();
  const partial = { trackDef: def, track, teams: TEAMS, drivers: DRIVERS, teamById: TEAM_BY_ID, driverById: DRIVER_BY_ID, config };
  const cars = physics.createSession(partial, entries);
  for (const c of cars) {
    physics.setAssists(c.id, RACE_ASSISTS);
    physics.placeOnGridSlot(c.id, c.id);
    physics.holdCar(c.id, true);
    c.wheels.forEach((w) => (w.temp = 95));
  }
  const race = { sessionType: 'race', phase: 'formation', time: 0, timeRemaining: -1, lightsOn: 0, totalLaps: laps, leaderLap: 0, entries: [], entryByCar: [], sectorFlags: ['green', 'green', 'green'], globalFlag: 'green', drsEnabled: false, fastestLap: null, messages: [], safetyCarSpeed: 0, results: null } as RaceState;
  const world: World = {
    mode: 'live', config, trackDef: def, track, cars, race, env: createEnvironment(14), playerCarId: 0, time: 0, realTime: 0, paused: false, racingLine: null,
    teams: TEAMS, drivers: DRIVERS, teamById: TEAM_BY_ID, driverById: DRIVER_BY_ID,
  };
  return { world, physics, cars, inputs: cars.map(() => createDefaultInput()) };
}
