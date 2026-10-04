/**
 * 🛰️ Station keeping — which face the helm shows, the trimmed circular orbit
 * (Kepler stays honest: lower is faster), the burn planner's refusal ladder,
 * the burn log and its replay, the doc's guards, burns from two tabs (one of
 * them offline) both landing, a burn's fuel surviving a REFUEL or DEPART
 * from another tab or another consumer's draw, the burns the tanks cannot
 * cover dropped the same way everywhere, and level writes settling the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { DoorPairing, DoorRecord } from './doorsDoc';
import { ORBIT_EPOCH_MS, angleAt, orbitForSlot, setStationTrimResolver, stationOrbit, wrapAngle } from './orbits';
import {
  FUEL_METER_MAX,
  bindShipDoc,
  clampFuelToCapacity,
  fuelCeiling,
  fuelDrawDeficit,
  readFuelLevel,
  readFuelSettlement,
  setFuelDrawMeter,
  subscribeShip,
  writeFuelLevel,
} from './shipDoc';
import type { FuelRecord } from './shipDoc';
import { roomIdFromSeed } from './stationAtlas';
import type { AtlasDoor, AtlasEntry } from './stationAtlas';
import { DEFAULT_PLANET_ID } from './stations';
import type { StationRecord } from './stations';
import {
  BURN_MS,
  MAX_LOG,
  MAX_TRIM_KM,
  PHASE_STEP_RAD,
  TRIM_FUEL,
  TRIM_STEP_KM,
  applyBurn,
  bindStationKeepingDoc,
  describeTrimStatus,
  helmTrim,
  isBoltedIntoStation,
  isBurnLogFull,
  isBurning,
  isNewerTrim,
  isKeepingSettlement,
  isOnStation,
  isOrbitTrim,
  isTrimBurn,
  planTrim,
  readBurnFiring,
  readFuelDrawn,
  readHelmFiring,
  readOrbitTrim,
  readSharedTrim,
  replayBurns,
  setSharedTrimSource,
  signedAngle,
  slotDriftPerHour,
  slotOffsetAt,
  slotOrbit,
  steersStation,
  subscribeStationKeeping,
  trimFor,
  trimmedOrbit,
  writeTrimBurn,
} from './stationKeeping';
import type { KeepingSettlement, OrbitTrim, TrimBurn, TrimContext, TrimDirection } from './stationKeeping';

const SOV = DEFAULT_PLANET_ID;
const STATION = { id: 'furlong-station', planetId: SOV, orbitSlot: 0 };
const T0 = Date.UTC(2026, 8, 27, 5, 0, 0);
const HOUR = 3600 * 1000;
const DEG = Math.PI / 180;
const SK = 'stationKeeping';

const trim = (over: Partial<OrbitTrim> = {}): OrbitTrim => ({
  planetId: SOV,
  slot: 0,
  dRadiusKm: 0,
  dPhase: 0,
  at: T0,
  last: 'raise',
  ...over,
});

const burnAt = (at: number, dir: TrimDirection, over: Partial<TrimBurn> = {}): TrimBurn => ({
  planetId: SOV,
  slot: 0,
  dir,
  at,
  fuel: TRIM_FUEL,
  ...over,
});

const ctx = (over: Partial<TrimContext> = {}): TrimContext => ({
  bolted: true,
  station: STATION,
  trim: null,
  commander: true,
  engines: 1,
  fuel: 100,
  now: T0,
  ...over,
});

/** Plan one burn and return the trim it leaves (fails the test on a refusal). */
function burn(c: TrimContext, dir: TrimDirection): OrbitTrim {
  const plan = planTrim(c, dir);
  if (!plan.ok) throw new Error(`refused: ${plan.refusal}`);
  return plan.trim;
}

/** Fire one burn in the bound room the way the helm does: plan against what
 *  the room reads now, then write the burn. */
function press(dir: TrimDirection, now: number): TrimBurn {
  const plan = planTrim(ctx({
    trim: readOrbitTrim(), fuel: readFuelLevel(), now, firing: readBurnFiring(now, STATION), logFull: isBurnLogFull(),
  }), dir);
  if (!plan.ok) throw new Error(`refused: ${plan.refusal}`);
  expect(writeTrimBurn(plan.burn)).toBe(true);
  return plan.burn;
}

/** Bind a room doc the way main.ts does. */
function bindRoom(doc: Y.Doc): void {
  bindShipDoc(doc);
  bindStationKeepingDoc(doc);
}

/** The bound room's log key for a burn this tab wrote. */
const keyOf = (doc: Y.Doc, b: TrimBurn) => `burn:${doc.clientID}:${b.at}`;

/** A burn as a settlement keeps it among the last that fired. */
const firedOf = (b: TrimBurn) => ({ planetId: b.planetId, slot: b.slot, dir: b.dir, at: b.at });

/** Two tabs trade everything they have. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

describe('which face the helm shows', () => {
  /** A pass in the real format the atlas reads: base64(JSON{roomId}). */
  const seedFor = (roomId: string) => btoa(JSON.stringify({ roomId }));
  const gangway: DoorRecord = { paired: true, connectedRoomAddress: seedFor('room-a') };
  const dock: DoorRecord = {
    paired: true,
    connectedRoomAddress: seedFor('room-b'),
    segments: [
      { kind: 'dock' } as never,
      { kind: 'dock' } as never,
    ],
  };
  const guestBerth: DoorRecord = { paired: true, connectedRoomAddress: seedFor('room-c'), transient: true };
  const retired: DoorRecord = { paired: false, retiredAddress: seedFor('room-d') };

  it('a gangway bolts the module into a station', () => {
    expect(isBoltedIntoStation([gangway])).toBe(true);
    expect(isBoltedIntoStation([dock, gangway])).toBe(true);
  });

  it('docks, guest berths and retired doors leave it a ship', () => {
    expect(isBoltedIntoStation([])).toBe(false);
    expect(isBoltedIntoStation([dock])).toBe(false);
    expect(isBoltedIntoStation([guestBerth, retired, dock])).toBe(false);
  });

  it('a pairing that names no room joins nothing, as in the atlas', () => {
    const unaddressed: DoorRecord = { paired: true, connectedRoomAddress: '' };
    expect(isBoltedIntoStation([unaddressed])).toBe(false);
    expect(isBoltedIntoStation([unaddressed, dock])).toBe(false);
    expect(isBoltedIntoStation([unaddressed, gangway])).toBe(true);
  });

  it('a pairing whose address the atlas cannot read joins nothing either', () => {
    // Copilot's review of #173: a peer could write junk that the atlas
    // decodes to no room, and the lone module still opened the station helm.
    const junk = ['not-a-seed', 'ssf://join#room=', btoa(JSON.stringify({ roomId: 7 })), btoa('{}'), '#room=%'];
    // The last one makes the parser throw, as it does for the atlas.
    expect(() => roomIdFromSeed('#room=%')).toThrow();
    for (const address of junk) {
      const door: DoorRecord = { paired: true, connectedRoomAddress: address };
      expect(isBoltedIntoStation([door])).toBe(false);
      expect(isBoltedIntoStation([door, dock])).toBe(false);
      expect(isBoltedIntoStation([door, gangway])).toBe(true);
    }
    // Every form the atlas reads a room from still bolts it in.
    for (const address of [seedFor('room-a'), `https://ssf.example/join?seed=${seedFor('room-a')}`, 'ssf://join#room=room-a']) {
      expect(roomIdFromSeed(address)).toBe('room-a');
      expect(isBoltedIntoStation([{ paired: true, connectedRoomAddress: address }])).toBe(true);
    }
  });

  it('a berth flagged only at the far end is a berth, and a gangway beside it still bolts the module', () => {
    // Copilot's review of #173: the atlas calls a connection a berth when
    // either end says so, and the module still opened the station helm on
    // the strength of its own unflagged record.
    const here = 'room-ship';
    const there = 'room-station';
    const atlasWith = (doors: Record<string, Partial<AtlasDoor>>): Record<string, AtlasEntry> => ({
      [there]: {
        roomId: there,
        name: 'Station',
        lastSeen: 0,
        doors: Object.fromEntries(Object.entries(doors).map(([id, d]) => [id, { targetSeed: seedFor(here), targetRoomId: here, ...d }])),
      },
    });
    const toStation = (over: Partial<DoorPairing> = {}): DoorRecord => ({ paired: true, connectedRoomAddress: seedFor(there), ...over });
    // The station's record is a guest berth; the module's own (an older
    // client's) carries no flag.
    const lone = new Map([['west', toStation()]]);
    expect(isBoltedIntoStation(lone, here, atlasWith({ east: { transient: true } }))).toBe(false);
    // Without the room's id only its own flags count, and so they do when
    // the atlas holds nothing of the far room.
    expect(isBoltedIntoStation(lone.values())).toBe(true);
    expect(isBoltedIntoStation(lone, here, {})).toBe(true);
    // A gangway between the same two rooms, beside the berth, still joins
    // them: matched by flag...
    const both = new Map([['west', toStation()], ['north', toStation({ transient: false })]]);
    expect(isBoltedIntoStation(both, here, atlasWith({ east: { transient: true }, south: { transient: false } }))).toBe(true);
    // ...or by the far doors the records name.
    const named = new Map([['west', toStation({ farDoor: 'east' })], ['north', toStation({ farDoor: 'south' })]]);
    const namedAtlas = atlasWith({ east: { transient: true, farDoor: 'west' }, south: { farDoor: 'north' } });
    expect(isBoltedIntoStation(named, here, namedAtlas)).toBe(true);
    // Take the gangway down, and the berth alone joins nothing.
    expect(isBoltedIntoStation(new Map([['west', toStation({ farDoor: 'east' })]]), here, namedAtlas)).toBe(false);
  });

  it('a pairing addressed back to the room itself joins nothing', () => {
    // Copilot's review of #173: the atlas still finds such a room alone, so
    // its helm must not trim a station's orbit.
    const here = 'room-ship';
    const self = new Map<string, DoorRecord>([['west', { paired: true, connectedRoomAddress: seedFor(here) }]]);
    expect(isBoltedIntoStation(self, here, {})).toBe(false);
    expect(steersStation(here, self, {}, [])).toBe(false);
    // A gangway to another room beside it still bolts the module.
    const both = new Map<string, DoorRecord>([...self, ['north', { paired: true, connectedRoomAddress: seedFor('room-station') }]]);
    expect(isBoltedIntoStation(both, here, {})).toBe(true);
  });

  it('a station\'s own welcome room steers the station even standing alone; any other lone room flies', () => {
    // Dorkmo's "Fly and park" (free flight, #203): a one-module station
    // keeps its orbit with the trim stick too, its ship face a tab away.
    const stations: StationRecord[] = [
      { id: 'my-station', name: 'Mine', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'room-w' },
      { id: 'station:room-x', name: 'Module', planetId: SOV, orbitSlot: 3, welcomeRoomId: 'room-x', derived: true },
    ];
    expect(steersStation('room-w', new Map(), {}, stations)).toBe(true);
    // A module the list only derives a station from is a ship.
    expect(steersStation('room-x', new Map(), {}, stations)).toBe(false);
    expect(steersStation('room-y', new Map(), {}, stations)).toBe(false);
    expect(steersStation('', new Map(), {}, stations)).toBe(false);
    // Bolted in, any room steers its station.
    expect(steersStation('room-y', new Map([['north', gangway]]), {}, stations)).toBe(true);
    expect(steersStation('room-y', new Map([['north', guestBerth]]), {}, stations)).toBe(false);
  });
});

describe('the trimmed orbit', () => {
  const base = slotOrbit(STATION);

  it('is measured from the untrimmed slot orbit', () => {
    expect(base).toEqual(orbitForSlot(SOV, 0));
  });

  it('no trim is the slot orbit itself', () => {
    expect(trimmedOrbit(base, null)).toBe(base);
    expect(slotOffsetAt(base, null, T0)).toBe(0);
    expect(slotDriftPerHour(base, null)).toBe(0);
  });

  it('a raised orbit is higher, slower and longer — Kepler, not a sticker', () => {
    const up = trimmedOrbit(base, trim({ dRadiusKm: 10 }));
    expect(up.radiusKm).toBeCloseTo(base.radiusKm + 10, 9);
    expect(up.altitudeKm).toBeCloseTo(base.altitudeKm + 10, 9);
    expect(up.speedKmS).toBeLessThan(base.speedKmS);
    expect(up.periodS).toBeGreaterThan(base.periodS);
    // T² ∝ r³ holds for the trimmed circle too.
    expect((up.periodS / base.periodS) ** 2).toBeCloseTo((up.radiusKm / base.radiusKm) ** 3, 9);
  });

  it('puts the station dPhase from its slot at the burn, whatever the clock', () => {
    const t = trim({ dRadiusKm: -6, dPhase: 0.3, at: T0 + 12_345 });
    const o = trimmedOrbit(base, t);
    const gap = signedAngle(angleAt(o, t.at) - angleAt(base, t.at));
    expect(gap).toBeCloseTo(0.3, 9);
    expect(slotOffsetAt(base, t, t.at)).toBeCloseTo(0.3, 9);
  });

  it('slotOffsetAt agrees with the two orbits drawn side by side', () => {
    const t = trim({ dRadiusKm: 4, dPhase: -0.1 });
    const o = trimmedOrbit(base, t);
    for (const later of [0, 60_000, HOUR, 5 * HOUR]) {
      const now = T0 + later;
      expect(slotOffsetAt(base, t, now)).toBeCloseTo(signedAngle(angleAt(o, now) - angleAt(base, now)), 9);
    }
  });

  it('lower drifts ahead, higher falls behind — about 6° an hour for 2 km at Furlong', () => {
    const low = trim({ dRadiusKm: -2 });
    const high = trim({ dRadiusKm: 2 });
    expect(slotDriftPerHour(base, low)).toBeGreaterThan(0);
    expect(slotDriftPerHour(base, high)).toBeLessThan(0);
    expect(slotDriftPerHour(base, low) / DEG).toBeCloseTo(6.2, 1);
    expect(slotOffsetAt(base, low, T0 + HOUR) / DEG).toBeCloseTo(6.2, 1);
    expect(slotOffsetAt(base, high, T0 + HOUR)).toBeLessThan(0);
  });

  it('at the slot radius nothing drifts', () => {
    const parked = trim({ dPhase: 2 * DEG });
    expect(slotDriftPerHour(base, parked)).toBe(0);
    expect(slotOffsetAt(base, parked, T0 + 10 * HOUR)).toBeCloseTo(2 * DEG, 12);
  });

  it('stays finite and exact far from the epoch', () => {
    const late = trim({ dRadiusKm: -20, dPhase: 1, at: ORBIT_EPOCH_MS + 40 * 365 * 24 * HOUR });
    const o = trimmedOrbit(base, late);
    expect(Number.isFinite(o.phase0)).toBe(true);
    expect(slotOffsetAt(base, late, late.at)).toBeCloseTo(1, 6);
  });

  it('works around every planet and slot orbits.ts knows', () => {
    const aris = { id: 'aris-3', planetId: 'planet-aris', orbitSlot: 3 };
    const b = slotOrbit(aris);
    expect(b).toEqual(orbitForSlot('planet-aris', 3));
    const t = trim({ planetId: 'planet-aris', slot: 3, dRadiusKm: -8 });
    expect(trimFor(aris, t)).toBe(t);
    expect(trimmedOrbit(b, t).meanMotion).toBeGreaterThan(b.meanMotion);
  });
});

describe('on station and burning', () => {
  const base = slotOrbit(STATION);

  it('on station means at the slot radius and within a degree of it', () => {
    expect(isOnStation(base, null, T0)).toBe(true);
    expect(isOnStation(base, trim({ dPhase: 0.5 * DEG }), T0)).toBe(true);
    expect(isOnStation(base, trim({ dPhase: 1.5 * DEG }), T0)).toBe(false);
    expect(isOnStation(base, trim({ dRadiusKm: 2 }), T0)).toBe(false);
  });

  it('a burn fires for BURN_MS from its stamp, and a stamp ahead of our clock never blocks', () => {
    const t = trim({ at: T0 });
    expect(isBurning(t, T0)).toBe(true);
    expect(isBurning(t, T0 + BURN_MS - 1)).toBe(true);
    expect(isBurning(t, T0 + BURN_MS)).toBe(false);
    expect(isBurning(t, T0 - 1)).toBe(false);
    expect(isBurning(null, T0)).toBe(false);
  });
});

describe('trimFor', () => {
  it('applies to whatever the station is called, while it flies the planet and slot the trim names', () => {
    const t = trim();
    expect(trimFor(STATION, t)).toBe(t);
    // Station records are per install: another client may know this station
    // by another id. The orbit basis is what must agree.
    const renamed = { ...STATION, id: 'station:home-abc' };
    expect(trimFor(renamed, t)).toBe(t);
    expect(trimFor({ planetId: 'planet-aris', orbitSlot: 0 }, t)).toBeNull();
    expect(trimFor({ planetId: SOV, orbitSlot: 1 }, t)).toBeNull();
    expect(trimFor(null, t)).toBeNull();
    expect(trimFor(STATION, null)).toBeNull();
  });

  it('resolves the planet the way orbits.ts does: an unknown id orbits the default planet', () => {
    expect(trimFor({ planetId: 'planet-nowhere', orbitSlot: 0 }, trim())).not.toBeNull();
    expect(trimFor({ planetId: 'planet-nowhere', orbitSlot: 0 }, trim({ planetId: 'planet-nowhere' }))).toBeNull();
  });
});

describe('planTrim — the stick', () => {
  const base = slotOrbit(STATION);

  it('refuses in the helm\'s order: bolted, station, commander, thrusters, fuel, log, burning, limit', () => {
    expect(planTrim(ctx({ bolted: false, station: null }), 'raise')).toEqual({ ok: false, refusal: 'not-bolted' });
    expect(planTrim(ctx({ station: null, commander: false }), 'raise')).toEqual({ ok: false, refusal: 'no-station' });
    expect(planTrim(ctx({ commander: false, engines: 0 }), 'raise')).toEqual({ ok: false, refusal: 'not-commander' });
    expect(planTrim(ctx({ engines: 0, fuel: 0 }), 'raise')).toEqual({ ok: false, refusal: 'no-thrusters' });
    expect(planTrim(ctx({ fuel: TRIM_FUEL - 0.5 }), 'raise')).toEqual({ ok: false, refusal: 'no-fuel' });
    expect(planTrim(ctx({ fuel: Number.NaN }), 'raise')).toEqual({ ok: false, refusal: 'no-fuel' });
    expect(planTrim(ctx({ logFull: true, trim: trim({ at: T0 - 100 }) }), 'raise'))
      .toEqual({ ok: false, refusal: 'log-full' });
    expect(planTrim(ctx({ trim: trim({ at: T0 - 100 }) }), 'raise')).toEqual({ ok: false, refusal: 'burning' });
    expect(planTrim(ctx({ trim: trim({ dRadiusKm: MAX_TRIM_KM, at: T0 - BURN_MS }) }), 'raise'))
      .toEqual({ ok: false, refusal: 'at-limit' });
  });

  it('the room\'s burn firing now holds the stick, whichever burn the trim ends on', () => {
    // A peer's burn stamped an hour ahead of our clock sorts last, so the
    // trim ends on it; the burn this tab just fired is what is firing.
    const ahead = trim({ at: T0 + HOUR });
    expect(planTrim(ctx({ trim: ahead, firing: burnAt(T0 - 100, 'raise') }), 'raise'))
      .toEqual({ ok: false, refusal: 'burning' });
    expect(planTrim(ctx({ trim: ahead, firing: null }), 'raise').ok).toBe(true);
    // A burn on an orbit this install does not place the station in is not
    // this stick's to wait for, as the dashboard does not show it.
    expect(planTrim(ctx({ trim: ahead, firing: burnAt(T0 - 100, 'raise', { slot: 2 }) }), 'raise').ok).toBe(true);
    expect(describeTrimStatus(base, ahead, T0, burnAt(T0 - 100, 'raise'))).toMatch(/^BURNING: raising/);
    expect(describeTrimStatus(base, trim({ at: T0 - 100, last: 'back' }), T0)).toMatch(/^BURNING: sliding/);
  });

  it('stamps the burn with what the tanks hold, when the helm says', () => {
    const plan = planTrim(ctx({ capacity: 300 }), 'raise');
    expect(plan.ok && plan.burn).toEqual(burnAt(T0, 'raise', { cap: 300 }));
    expect(plan.ok && isTrimBurn(plan.burn)).toBe(true);
  });

  it('plans the burn to log and the trim it leaves', () => {
    const plan = planTrim(ctx({ now: T0 + 7 }), 'lower');
    expect(plan).toEqual({ ok: true, burn: burnAt(T0 + 7, 'lower'), trim: applyBurn(null, burnAt(T0 + 7, 'lower')) });
  });

  it('RAISE and LOWER step the radius and keep the station where it is', () => {
    const t1 = burn(ctx(), 'raise');
    expect(t1).toMatchObject({ planetId: SOV, slot: 0, dRadiusKm: TRIM_STEP_KM, at: T0, last: 'raise' });
    expect(t1.dPhase).toBe(0);
    // An hour later the raised station has fallen behind; lowering keeps that offset.
    const later = T0 + HOUR;
    const behind = slotOffsetAt(base, t1, later);
    expect(behind).toBeLessThan(0);
    const t2 = burn(ctx({ trim: t1, now: later }), 'lower');
    expect(t2.dRadiusKm).toBe(0);
    expect(t2.dPhase).toBeCloseTo(behind, 12);
    // No jump in position across the burn.
    const before = angleAt(trimmedOrbit(base, t1), later);
    const after = angleAt(trimmedOrbit(base, t2), later);
    expect(signedAngle(after - before)).toBeCloseTo(0, 9);
  });

  it('AHEAD and BACK slide the station a step along its orbit', () => {
    const t1 = burn(ctx(), 'ahead');
    expect(t1.dPhase).toBeCloseTo(PHASE_STEP_RAD, 12);
    expect(t1.dRadiusKm).toBe(0);
    const t2 = burn(ctx({ trim: t1, now: T0 + BURN_MS }), 'back');
    expect(t2.dPhase).toBeCloseTo(0, 12);
    expect(t2.last).toBe('back');
  });

  it('lowering to the band floor then refusing — never past ±MAX_TRIM_KM', () => {
    let t: OrbitTrim | null = null;
    let now = T0;
    for (let i = 0; i < MAX_TRIM_KM / TRIM_STEP_KM; i++) {
      t = burn(ctx({ trim: t, now }), 'lower');
      now += BURN_MS;
    }
    expect(t!.dRadiusKm).toBe(-MAX_TRIM_KM);
    expect(planTrim(ctx({ trim: t, now }), 'lower')).toEqual({ ok: false, refusal: 'at-limit' });
    expect(planTrim(ctx({ trim: t, now }), 'raise').ok).toBe(true);
  });

  it('a trim on another planet or slot is ignored — the burn starts from the slot', () => {
    for (const stray of [
      trim({ planetId: 'planet-aris', dRadiusKm: 10, dPhase: 1, at: T0 - BURN_MS }),
      trim({ slot: 2, dRadiusKm: 10, dPhase: 1, at: T0 - BURN_MS }),
    ]) {
      const t = burn(ctx({ trim: stray }), 'raise');
      expect(t).toMatchObject({ planetId: SOV, slot: 0, dRadiusKm: TRIM_STEP_KM, dPhase: 0 });
    }
  });

  it('names the planet as orbits.ts resolves it', () => {
    const plan = planTrim(ctx({ station: { planetId: 'planet-nowhere', orbitSlot: 0 } }), 'raise');
    expect(plan.ok && plan.burn.planetId).toBe(SOV);
    expect(plan.ok && plan.trim.planetId).toBe(SOV);
  });

  it('wraps the phase offset into (−π, π]', () => {
    const t = burn(ctx({ trim: trim({ dPhase: Math.PI - PHASE_STEP_RAD / 2, at: T0 - BURN_MS }) }), 'ahead');
    expect(t.dPhase).toBeLessThan(0);
    expect(wrapAngle(t.dPhase)).toBeCloseTo(Math.PI + PHASE_STEP_RAD / 2, 12);
  });

  it('every planned burn and trim passes the doc guards', () => {
    let t: OrbitTrim | null = null;
    let now = T0;
    for (const dir of ['raise', 'ahead', 'lower', 'back', 'lower', 'lower'] as TrimDirection[]) {
      const plan = planTrim(ctx({ trim: t, now }), dir);
      if (!plan.ok) throw new Error(plan.refusal);
      expect(isTrimBurn(plan.burn)).toBe(true);
      expect(isOrbitTrim(plan.trim)).toBe(true);
      t = plan.trim;
      now += BURN_MS + 30 * 60_000;
    }
  });
});

describe('replaying the burns', () => {
  const run = [
    burnAt(T0, 'raise'),
    burnAt(T0 + 20 * 60_000, 'ahead'),
    burnAt(T0 + 45 * 60_000, 'raise'),
    burnAt(T0 + HOUR, 'back'),
    burnAt(T0 + 2 * HOUR, 'lower'),
  ];

  it('is each burn in time order, and the fuel of them all', () => {
    let t: OrbitTrim | null = null;
    for (const b of run) t = applyBurn(t, b);
    expect(replayBurns(run)).toEqual({ trim: t, trims: [t], fuelDrawn: run.length * TRIM_FUEL, fired: run });
    expect(t).toMatchObject({ dRadiusKm: TRIM_STEP_KM, at: T0 + 2 * HOUR, last: 'lower' });
  });

  it('comes out the same whatever order the burns arrive in', () => {
    const want = replayBurns(run);
    expect(replayBurns([...run].reverse())).toEqual(want);
    expect(replayBurns([run[3], run[0], run[4], run[2], run[1]])).toEqual(want);
    // Two burns stamped the same millisecond still order the same way everywhere.
    const tie = [burnAt(T0, 'raise'), burnAt(T0, 'ahead'), burnAt(T0, 'raise', { slot: 1 })];
    expect(replayBurns([...tie].reverse())).toEqual(replayBurns(tie));
  });

  it('a burn past the band changes nothing but still pays, and the trim dates from it', () => {
    const start = trim({ dRadiusKm: MAX_TRIM_KM - TRIM_STEP_KM, at: T0 - HOUR });
    const edge = applyBurn(start, burnAt(T0, 'raise'))!;
    const out = replayBurns([burnAt(T0, 'raise'), burnAt(T0 + 1_000, 'raise')], start, 5);
    expect(out.trim).toMatchObject({ dRadiusKm: MAX_TRIM_KM, at: T0 + 1_000, last: 'raise' });
    // The same orbit, only dated from the later burn.
    const base = slotOrbit(STATION);
    for (const at of [T0, T0 + 1_000, T0 + HOUR]) {
      expect(slotOffsetAt(base, out.trim, at)).toBeCloseTo(slotOffsetAt(base, edge, at), 12);
    }
    expect(out.fuelDrawn).toBe(5 + 2 * TRIM_FUEL);
  });

  it('a burn that arrives late never makes an earlier one free: the fuel only grows', () => {
    const start = trim({ dRadiusKm: MAX_TRIM_KM - TRIM_STEP_KM, at: T0 - HOUR });
    const later = burnAt(T0 + 1_000, 'raise');
    const late = burnAt(T0, 'raise');
    expect(replayBurns([later], start).trim!.at).toBe(later.at);
    // The late one takes the last step, so the later one is now past the
    // band: it changes nothing, but the trim dates from it.
    const both = replayBurns([later, late], start);
    expect(both.trim).toMatchObject({ dRadiusKm: MAX_TRIM_KM, at: later.at });
    expect(both.fuelDrawn).toBe(2 * TRIM_FUEL);
  });

  it('a burn stamped before a settled burn at the band edge applies after it', () => {
    // Two tabs RAISE one step below the edge: the first takes the last step,
    // the second pays and changes nothing. A level write settles both.
    const start = trim({ dRadiusKm: MAX_TRIM_KM - TRIM_STEP_KM, at: T0 - HOUR });
    const first = burnAt(T0, 'raise');
    const second = burnAt(T0 + 1_000, 'raise');
    const settled = replayBurns([first, second], start).trim!;
    // A LOWER from a tab that was offline, stamped between them, applies at
    // the settled run's last burn.
    const late = burnAt(T0 + 500, 'lower');
    const out = replayBurns([late], settled);
    expect(out.trim).toEqual(applyBurn(settled, { ...late, at: second.at }));
    expect(out.trim).toMatchObject({ dRadiusKm: MAX_TRIM_KM - TRIM_STEP_KM, at: second.at });
  });

  it('drops the burns the tanks cannot cover: they neither move the orbit nor take fuel', () => {
    const out = replayBurns(run, null, 0, 3 * TRIM_FUEL);
    expect(out.fired).toEqual(run.slice(0, 3));
    expect(out.fuelDrawn).toBe(3 * TRIM_FUEL);
    expect(out.trim).toEqual(replayBurns(run.slice(0, 3)).trim);
    // The fuel drawn before the run counts against the ceiling too, and a
    // burn that fits after a dropped one still fires.
    const big = burnAt(T0 + 10 * 60_000, 'raise', { fuel: 5 });
    expect(replayBurns([run[0], big, run[1]], null, 2, 4).fired).toEqual([run[0], run[1]]);
  });

  it('a burn stamped before the start applies at the start\'s last burn, with no jump there', () => {
    const start = trim({ dRadiusKm: -4, dPhase: 0.01, at: T0 + HOUR });
    const early = burnAt(T0, 'raise');
    const out = replayBurns([early], start);
    expect(out.trim).toEqual(applyBurn(start, { ...early, at: start.at }));
    expect(out.trim).toMatchObject({ dRadiusKm: -4 + TRIM_STEP_KM, at: start.at });
    const base = slotOrbit(STATION);
    expect(slotOffsetAt(base, out.trim, start.at)).toBeCloseTo(slotOffsetAt(base, start, start.at), 12);
    // It fires when it applies.
    expect(out.fired).toEqual([{ ...early, at: start.at }]);
  });

  it('holds each burn to the ceiling for the capacity it was made against', () => {
    const burns = [burnAt(T0, 'raise', { cap: 200 }), burnAt(T0 + 1_000, 'ahead', { cap: 100 }), burnAt(T0 + 2_000, 'back')];
    const ceiling = (cap: number) => (cap === 100 ? 1 : 5);
    expect(replayBurns(burns, null, 0, ceiling).fired).toEqual([burns[0], burns[2]]);
  });

  it('a burn on another planet or slot starts from that orbit\'s own trim, and leaves this one\'s alone', () => {
    // Copilot's review of #173: the room kept one trim, so a burn on another
    // orbit (from a tab that places the room in another slot) undid this
    // one's, while the fuel of the burns undone stayed spent.
    const aris = burnAt(T0 + 1_000, 'raise', { planetId: 'planet-aris', slot: 3 });
    const out = replayBurns([burnAt(T0, 'raise'), aris, burnAt(T0 + 2_000, 'lower')]);
    expect(out.trim).toMatchObject({ planetId: SOV, slot: 0, dRadiusKm: 0, at: T0 + 2_000, last: 'lower' });
    expect(out.trims).toEqual([applyBurn(null, aris), out.trim]);
    expect(out.fuelDrawn).toBe(3 * TRIM_FUEL);
  });
});

describe('the burn log in the room doc', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(10, 100);
  });

  it('round-trips a burn and notifies subscribers', () => {
    let calls = 0;
    const off = subscribeStationKeeping(() => { calls++; });
    const b = burnAt(T0, 'raise');
    expect(writeTrimBurn(b)).toBe(true);
    expect(readOrbitTrim()).toEqual(applyBurn(null, b));
    expect(readFuelDrawn()).toBe(TRIM_FUEL);
    expect(calls).toBeGreaterThan(0);
    off();
  });

  it('writes each burn once, under its own key, with its fuel: the tank reads one burn less', () => {
    const fuelRecord = doc.getMap('ship').get('fuel');
    let gauge = 0;
    const off = subscribeShip(() => { gauge++; });
    const seen: string[][] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      seen.push([...tr.changed.keys()].map((m) => ((m as unknown) === doc.getMap('ship') ? 'ship' : 'keep')));
    });
    const b = press('raise', T0);
    expect(seen).toEqual([['keep']]);
    expect([...doc.getMap('stationKeeping').entries()]).toEqual([[`burn:${doc.clientID}:${T0}`, b]]);
    expect(doc.getMap('ship').get('fuel')).toBe(fuelRecord);
    expect(readFuelDrawn()).toBe(TRIM_FUEL);
    expect(readFuelLevel()).toBe(10 - TRIM_FUEL);
    // The ship helm's gauge hears about it too.
    expect(gauge).toBeGreaterThan(0);
    off();
    // A later REFUEL or DEPART folds the draws it saw into the level, once.
    writeFuelLevel(readFuelLevel() - 3, 100);
    expect(readFuelLevel()).toBe(10 - TRIM_FUEL - 3);
    const b2 = press('lower', T0 + BURN_MS);
    expect(readFuelLevel()).toBe(10 - 2 * TRIM_FUEL - 3);
    expect(readOrbitTrim()).toMatchObject({ dRadiusKm: 0, last: 'lower' });
    // That write settled the first burn, and this one cleared it.
    expect([...doc.getMap('stationKeeping').keys()]).toEqual([keyOf(doc, b2)]);
  });

  it('refuses a malformed burn, and a second one from this tab in the same millisecond', () => {
    expect(writeTrimBurn(burnAt(T0, 'raise', { fuel: 0 }))).toBe(false);
    expect(writeTrimBurn(burnAt(T0, 'raise', { dir: 'sideways' as TrimDirection }))).toBe(false);
    expect(writeTrimBurn(burnAt(T0, 'raise'))).toBe(true);
    expect(writeTrimBurn(burnAt(T0, 'lower'))).toBe(false);
    expect(readOrbitTrim()).toMatchObject({ dRadiusKm: TRIM_STEP_KM });
    expect(readFuelDrawn()).toBe(TRIM_FUEL);
  });

  it('skips anything hostile, on the record from before the log and in the log', () => {
    const map = doc.getMap('stationKeeping');
    const hostileTrims: unknown[] = [
      null,
      'trim',
      { ...trim(), dRadiusKm: MAX_TRIM_KM + 1 },
      { ...trim(), dRadiusKm: Number.POSITIVE_INFINITY },
      { ...trim(), dPhase: 4 },
      { ...trim(), at: 0 },
      { ...trim(), at: Number.MAX_VALUE },
      { ...trim(), slot: 99 },
      { ...trim(), slot: 1.5 },
      { ...trim(), planetId: '' },
      { ...trim(), planetId: 'x'.repeat(200) },
      { ...trim(), planetId: 7 },
      { ...trim(), last: 'sideways' },
      { ...trim(), fuelDrawn: -1 },
      { ...trim(), fuelDrawn: Number.NaN },
      { ...trim(), fuelDrawn: Number.POSITIVE_INFINITY },
      { ...trim(), fuelDrawn: 1e13 },
      { ...trim(), fuelDrawn: '3' },
    ];
    for (const value of hostileTrims) {
      map.set('trim', value);
      expect(readOrbitTrim()).toBeNull();
      expect(readFuelDrawn()).toBe(0);
    }
    map.delete('trim');
    const hostileBurns: unknown[] = [
      null,
      'burn',
      { ...burnAt(T0, 'raise'), fuel: 0 },
      { ...burnAt(T0, 'raise'), fuel: -1 },
      { ...burnAt(T0, 'raise'), fuel: Number.NaN },
      { ...burnAt(T0, 'raise'), fuel: 1e6 },
      { ...burnAt(T0, 'raise'), fuel: '1' },
      { ...burnAt(T0, 'raise'), dir: 'sideways' },
      { ...burnAt(T0, 'raise'), at: 0 },
      { ...burnAt(T0, 'raise'), at: Number.POSITIVE_INFINITY },
      { ...burnAt(T0, 'raise'), slot: -1 },
      { ...burnAt(T0, 'raise'), planetId: '' },
      { ...burnAt(T0, 'raise'), cap: -1 },
      { ...burnAt(T0, 'raise'), cap: Number.NaN },
      { ...burnAt(T0, 'raise'), cap: '100' },
      { ...burnAt(T0, 'raise'), cap: 1e13 },
    ];
    hostileBurns.forEach((value, i) => map.set(`burn:hostile:${i}`, value));
    // A well-formed burn under a key outside the log is not a burn either.
    map.set('notaburn', burnAt(T0, 'raise'));
    expect(readOrbitTrim()).toBeNull();
    expect(readFuelDrawn()).toBe(0);
  });

  it('strips unknown fields on read', () => {
    doc.getMap('stationKeeping').set('trim', { ...trim(), fuelDrawn: 2, extra: 'x'.repeat(10) });
    expect(readOrbitTrim()).toEqual(trim());
    doc.getMap('stationKeeping').set('burn:peer:1', { ...burnAt(T0 + BURN_MS, 'ahead'), extra: 'x'.repeat(10) });
    expect(readOrbitTrim()).toEqual(applyBurn(trim(), burnAt(T0 + BURN_MS, 'ahead')));
    expect(readFuelDrawn()).toBe(2 + TRIM_FUEL);
  });

  it('a room trimmed before the log starts from its record, and its fuel still counts', () => {
    bindShipDoc(doc);
    const before = trim({ dRadiusKm: 4, dPhase: 0.01, fuelDrawn: 3 });
    doc.getMap('stationKeeping').set('trim', before);
    const { fuelDrawn: _fuel, ...orbit } = before;
    expect(readOrbitTrim()).toEqual(orbit);
    expect(readFuelDrawn()).toBe(3);
    writeFuelLevel(20, 100);
    press('raise', T0 + BURN_MS);
    expect(readOrbitTrim()).toMatchObject({ dRadiusKm: 6, last: 'raise' });
    expect(readFuelDrawn()).toBe(3 + TRIM_FUEL);
    expect(readFuelLevel()).toBe(20 - TRIM_FUEL);
  });

  it('reads null from a destroyed doc', () => {
    writeTrimBurn(burnAt(T0, 'raise'));
    doc.destroy();
    expect(readOrbitTrim()).toBeNull();
    expect(readFuelDrawn()).toBe(0);
    expect(writeTrimBurn(burnAt(T0 + BURN_MS, 'raise'))).toBe(false);
  });
});

describe('two owners burning at once', () => {
  it('both burns land and both pay, the same on every replica', () => {
    // Both tabs start from the same room state: 5 fuel, no trim yet.
    const a = new Y.Doc();
    const b = new Y.Doc();
    bindShipDoc(a);
    writeFuelLevel(5, 100);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Each burns without having seen the other's burn.
    bindRoom(a);
    const ba = press('raise', T0);
    bindRoom(b);
    const bb = press('ahead', T0 + 40);
    sync(a, b);

    const settled = (doc: Y.Doc) => {
      bindRoom(doc);
      return { trim: readOrbitTrim(), fuel: readFuelLevel() };
    };
    const sa = settled(a);
    expect(settled(b)).toEqual(sa);
    expect(sa.trim).toEqual(replayBurns([ba, bb]).trim);
    expect(sa.trim).toMatchObject({ dRadiusKm: TRIM_STEP_KM, last: 'ahead' });
    expect(sa.fuel).toBe(5 - 2 * TRIM_FUEL);
  });

  it('a burn from a tab that was offline never rolls the room\'s burns back', () => {
    // Copilot's review of #173: with one record per room, the offline tab's
    // record (written from the older state) could win the merge and take
    // the online burns, and their fuel, back with it.
    for (const [online, offline] of [[900, 100], [100, 900]]) {
      const a = new Y.Doc();
      const x = new Y.Doc();
      a.clientID = online;
      x.clientID = offline;
      bindRoom(a);
      writeFuelLevel(50, 100);
      let now = T0;
      for (let i = 0; i < 2; i++, now += BURN_MS) press('raise', now);
      Y.applyUpdate(x, Y.encodeStateAsUpdate(a));
      // The room burns on while tab X is offline...
      for (let i = 0; i < 3; i++, now += BURN_MS) press('raise', now);
      expect(readFuelLevel()).toBe(50 - 5 * TRIM_FUEL);
      // ...and X, still seeing two burns, fires one of its own.
      bindRoom(x);
      press('ahead', now);
      sync(a, x);
      for (const doc of [a, x]) {
        bindRoom(doc);
        expect(readOrbitTrim()).toMatchObject({ dRadiusKm: 5 * TRIM_STEP_KM, last: 'ahead' });
        expect(readFuelDrawn()).toBe(6 * TRIM_FUEL);
        expect(readFuelLevel()).toBe(50 - 6 * TRIM_FUEL);
      }
    }
  });
});

describe('a burn racing a REFUEL or DEPART from another tab', () => {
  /** Tab A burns while tab B (neither having seen the other) writes the fuel
   *  level: a DEPART's debit, or a REFUEL. Client ids pick which write Yjs
   *  keeps on a shared key, so every race runs both ways round. */
  const race = (burner: number, other: number, otherWrite: (fuel: number) => number) => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.clientID = burner;
    b.clientID = other;
    bindRoom(a);
    writeFuelLevel(50, 100);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    press('raise', T0);
    bindRoom(b);
    writeFuelLevel(otherWrite(readFuelLevel()), 100);

    sync(a, b);
    const settled = (doc: Y.Doc) => {
      bindRoom(doc);
      return { fuel: readFuelLevel(), trimmed: readOrbitTrim() !== null };
    };
    const sa = settled(a);
    expect(settled(b)).toEqual(sa);
    expect(sa.trimmed).toBe(true);
    return sa.fuel;
  };

  it('a DEPART\'s debit and the burn\'s both come off, whichever tab Yjs favours', () => {
    const depart = (fuel: number) => fuel - 12;
    expect(race(900, 100, depart)).toBe(50 - 12 - TRIM_FUEL);
    expect(race(100, 900, depart)).toBe(50 - 12 - TRIM_FUEL);
  });

  it('a REFUEL and the burn settle as refuel-then-burn, whichever tab Yjs favours', () => {
    const refuel = () => 100;
    expect(race(900, 100, refuel)).toBe(100 - TRIM_FUEL);
    expect(race(100, 900, refuel)).toBe(100 - TRIM_FUEL);
  });

  it('a burn comes out of the tanks fitted now, not fuel stranded by a removed tank', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(100, 100);
    // A tank comes off: the other 50 is stranded, not burnable.
    const fuel = clampFuelToCapacity(readFuelLevel(50), 50);
    expect(fuel).toBe(50);
    const plan = planTrim(ctx({ fuel }), 'raise');
    expect(plan.ok && writeTrimBurn(plan.burn)).toBe(true);
    expect(clampFuelToCapacity(readFuelLevel(50), 50)).toBe(50 - TRIM_FUEL);
    // The tank goes back on, and its fuel with it.
    expect(clampFuelToCapacity(readFuelLevel(100), 100)).toBe(100 - TRIM_FUEL);
  });
});

describe('the tanks cover every burn that fires', () => {
  // Copilot's review of #173: two tabs could each see the last unit and both
  // burn, or a burn could race a DEPART that took the rest, and every burn
  // was charged whatever the tanks held.
  const pair = (first: number, second: number, level: number) => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.clientID = first;
    b.clientID = second;
    bindRoom(a);
    writeFuelLevel(level, 100);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    return [a, b] as const;
  };

  it('two tabs spending the last unit at once: the first burn fires, the other is dropped', () => {
    for (const [first, second] of [[900, 100], [100, 900]]) {
      const [a, b] = pair(first, second, TRIM_FUEL);
      const ba = press('raise', T0);
      bindRoom(b);
      press('ahead', T0 + 40);
      sync(a, b);
      for (const doc of [a, b]) {
        bindRoom(doc);
        expect(readOrbitTrim()).toEqual(applyBurn(null, ba));
        expect(readFuelDrawn()).toBe(TRIM_FUEL);
        expect(readFuelLevel()).toBe(0);
      }
    }
  });

  it('a burn racing a DEPART that takes the rest is dropped, whichever tab Yjs favours', () => {
    for (const [burner, other] of [[900, 100], [100, 900]]) {
      const [a, b] = pair(burner, other, 12);
      press('raise', T0);
      bindRoom(b);
      writeFuelLevel(readFuelLevel() - 12, 100);
      sync(a, b);
      for (const doc of [a, b]) {
        bindRoom(doc);
        expect(readOrbitTrim()).toBeNull();
        expect(readFuelDrawn()).toBe(0);
        expect(readFuelLevel()).toBe(0);
      }
    }
  });

  it('a dropped burn stays dropped when a REFUEL brings the fuel it lacked', () => {
    for (const [first, second] of [[900, 100], [100, 900]]) {
      const [a, b] = pair(first, second, TRIM_FUEL);
      const ba = press('raise', T0);
      bindRoom(b);
      press('ahead', T0 + 40);
      sync(a, b);
      writeFuelLevel(100, 100);
      sync(a, b);
      for (const doc of [a, b]) {
        bindRoom(doc);
        expect(readOrbitTrim()).toEqual(applyBurn(null, ba));
        expect(readFuelDrawn()).toBe(TRIM_FUEL);
        expect(readFuelLevel()).toBe(100);
      }
    }
  });

  it('two tabs racing for the last unit the tanks fitted now hold: stranded fuel never pays', () => {
    // Copilot's review of #173: 180 in two tanks and 99 drawn, then one tank
    // comes off, leaving 1 unit to burn; both tabs see it.
    for (const [first, second] of [[900, 100], [100, 900]]) {
      const [a, b] = pair(first, second, 180);
      writeFuelLevel(180, 200);
      a.transact(() => {
        for (let i = 0; i < 99; i++) {
          a.getMap('stationKeeping').set(`burn:earlier:${i}`, burnAt(T0 - HOUR + i * BURN_MS, i % 2 ? 'ahead' : 'back', { cap: 200 }));
        }
      });
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      const fire = (now: number): TrimBurn => {
        const fuel = clampFuelToCapacity(readFuelLevel(100), 100);
        expect(fuel).toBe(TRIM_FUEL);
        const plan = planTrim(ctx({
          trim: readOrbitTrim(), fuel, capacity: 100, now, firing: readBurnFiring(now), logFull: isBurnLogFull(),
        }), 'raise');
        if (!plan.ok) throw new Error(`refused: ${plan.refusal}`);
        expect(writeTrimBurn(plan.burn)).toBe(true);
        return plan.burn;
      };
      const ba = fire(T0);
      bindRoom(b);
      fire(T0 + 40);
      sync(a, b);
      for (const doc of [a, b]) {
        bindRoom(doc);
        expect(readFuelDrawn()).toBe(100 * TRIM_FUEL);
        expect(clampFuelToCapacity(readFuelLevel(100), 100)).toBe(0);
        expect(readOrbitTrim()).toMatchObject({ at: ba.at, last: 'raise' });
      }
    }
  });

  it('holds each burn to the tanks it fired with, whatever is fitted later', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(150, 200);
    const log = doc.getMap('stationKeeping');
    // 120 burns fired with two tanks fitted...
    doc.transact(() => {
      for (let i = 0; i < 120; i++) log.set(`burn:two:${i}`, burnAt(T0 + i * BURN_MS, i % 2 ? 'ahead' : 'back', { cap: 200 }));
    });
    expect(readFuelDrawn()).toBe(120 * TRIM_FUEL);
    const t = readOrbitTrim();
    // ...all stand once one comes off, and the gauge has nothing left.
    expect(clampFuelToCapacity(readFuelLevel(100), 100)).toBe(0);
    // A burn fired with one tank fitted draws only on what that one holds.
    log.set('burn:one:0', burnAt(T0 + 200 * BURN_MS, 'raise', { cap: 100 }));
    expect(readFuelDrawn()).toBe(120 * TRIM_FUEL);
    expect(readOrbitTrim()).toEqual(t);
    // One from a build before the stamp draws on the level as written.
    log.set('burn:old:0', burnAt(T0 + 201 * BURN_MS, 'raise'));
    expect(readFuelDrawn()).toBe(121 * TRIM_FUEL);
  });

  it('station keeping yields to another draw that leaves too little', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(3, 100);
    const b1 = press('raise', T0);
    press('raise', T0 + BURN_MS);
    expect(readFuelDrawn()).toBe(2 * TRIM_FUEL);
    // Another consumer's draw of 2 lands (from a tab that saw no burns).
    const map = doc.getMap('other');
    setFuelDrawMeter('test-other', {
      read: () => (map.get('drawn') as number | undefined) ?? 0,
      subscribe: (listener) => {
        map.observe(listener);
        return () => map.unobserve(listener);
      },
    });
    try {
      map.set('drawn', 2);
      expect(readOrbitTrim()).toEqual(applyBurn(null, b1));
      expect(readFuelDrawn()).toBe(TRIM_FUEL);
      expect(readFuelLevel()).toBe(0);
    } finally {
      setFuelDrawMeter('test-other', null);
    }
  });
});

describe('level writes settle the log', () => {
  const log = (doc: Y.Doc) => doc.getMap('stationKeeping');

  it('a level write settles the burns so far, and the next burn clears them: nothing moves', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    const burns = [press('raise', T0), press('ahead', T0 + BURN_MS), press('raise', T0 + 2 * BURN_MS)];
    const t = readOrbitTrim();
    const gauge = readFuelLevel();
    writeFuelLevel(gauge, 100);
    const settled = readFuelSettlement(SK);
    expect(isKeepingSettlement(settled)).toBe(true);
    expect(settled).toEqual({
      trim: t,
      trims: [t],
      fuelDrawn: 3 * TRIM_FUEL,
      burns: burns.map((b) => keyOf(doc, b)),
      fired: [firedOf(burns[2])],
    });
    expect(readOrbitTrim()).toEqual(t);
    expect(readFuelLevel()).toBe(gauge);
    expect(log(doc).size).toBe(3);
    const next = press('lower', T0 + 3 * BURN_MS);
    expect([...log(doc).keys()]).toEqual([keyOf(doc, next)]);
    expect(readOrbitTrim()).toEqual(applyBurn(t, next));
    expect(readFuelDrawn()).toBe(4 * TRIM_FUEL);
    expect(readFuelLevel()).toBe(gauge - TRIM_FUEL);
  });

  it('the log holds only the burns since the last level write, and a reload reads the same', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(100, 100);
    const all: TrimBurn[] = [];
    const dirs: TrimDirection[] = ['raise', 'ahead', 'lower', 'ahead', 'raise', 'back'];
    let now = T0;
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const dir of dirs) {
        all.push(press(dir, now));
        now += BURN_MS;
      }
      expect(log(doc).size).toBeLessThanOrEqual(6 + 1);
      writeFuelLevel(100, 100);
      expect(readFuelLevel()).toBe(100);
    }
    const t = readOrbitTrim();
    expect(t).toEqual(replayBurns(all).trim);
    expect(readFuelDrawn()).toBe(all.length * TRIM_FUEL);
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
    bindRoom(reload);
    expect(readOrbitTrim()).toEqual(t);
    expect(readFuelDrawn()).toBe(all.length * TRIM_FUEL);
    expect(readFuelLevel()).toBe(100);
  });

  it('a burn from a tab that was offline across a level write and a burn is still paid', () => {
    for (const [online, offline] of [[900, 100], [100, 900]]) {
      const a = new Y.Doc();
      const x = new Y.Doc();
      a.clientID = online;
      x.clientID = offline;
      bindRoom(a);
      writeFuelLevel(50, 100);
      const early = [press('raise', T0), press('raise', T0 + BURN_MS)];
      Y.applyUpdate(x, Y.encodeStateAsUpdate(a));
      // The room burns on, REFUELs (settling five burns), and burns again,
      // clearing them...
      const later = [press('ahead', T0 + 2 * BURN_MS), press('ahead', T0 + 3 * BURN_MS), press('ahead', T0 + 4 * BURN_MS)];
      writeFuelLevel(50, 100);
      const last = press('lower', T0 + 5 * BURN_MS);
      // ...while tab X, still seeing two burns, fires one stamped before the
      // REFUEL: a change of radius, which changes the drift from then on.
      bindRoom(x);
      const offlineBurn = press('lower', T0 + 2 * BURN_MS + 10);
      sync(a, x);
      for (const doc of [a, x]) {
        bindRoom(doc);
        // X's burn is stamped before the burns the REFUEL settled, so it
        // applies at the time of the last of them.
        const settledTrim = replayBurns([...early, ...later]).trim!;
        expect(readOrbitTrim()).toEqual(applyBurn(applyBurn(settledTrim, { ...offlineBurn, at: settledTrim.at }), last));
        expect(readFuelDrawn()).toBe(7 * TRIM_FUEL);
        expect(readFuelLevel()).toBe(50 - 2 * TRIM_FUEL);
      }
    }
  });

  it('a level write keeps a burn at the band edge firing: the stick still waits for it', () => {
    for (const [first, second] of [[900, 100], [100, 900]]) {
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.clientID = first;
      b.clientID = second;
      bindRoom(a);
      writeFuelLevel(50, 100);
      let now = T0;
      for (let i = 0; i < MAX_TRIM_KM / TRIM_STEP_KM - 1; i++, now += BURN_MS) press('raise', now);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      // Both tabs RAISE from one step below the edge: A takes the last step,
      // and B's burn pays and changes nothing.
      press('raise', now);
      bindRoom(b);
      const edge = press('raise', now + 2_000);
      sync(a, b);
      bindRoom(a);
      expect(readOrbitTrim()).toMatchObject({ dRadiusKm: MAX_TRIM_KM, at: edge.at });
      // A REFUEL settles both while B's burn still fires...
      writeFuelLevel(50, 100);
      const then = edge.at + 1_000;
      expect(readBurnFiring(then, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'raise', at: edge.at });
      // ...so the next press waits for it to end.
      const c = ctx({ trim: readOrbitTrim(), fuel: readFuelLevel(), now: then, firing: readBurnFiring(then, STATION) });
      expect(planTrim(c, 'lower')).toEqual({ ok: false, refusal: 'burning' });
      expect(press('lower', edge.at + BURN_MS).at).toBe(edge.at + BURN_MS);
    }
  });

  it('a late burn on another orbit fires when it applies, so the stick there still waits for it', () => {
    const OTHER = { ...STATION, orbitSlot: 1 };
    const a = new Y.Doc();
    const x = new Y.Doc();
    bindRoom(a);
    writeFuelLevel(50, 100);
    Y.applyUpdate(x, Y.encodeStateAsUpdate(a));
    // The room burns on its slot and REFUELs, settling that burn...
    const settled = press('raise', T0 + 5_000);
    writeFuelLevel(50, 100);
    // ...while tab X, offline, places the room in another slot and fires
    // there before it.
    bindRoom(x);
    const plan = planTrim(ctx({ station: OTHER, trim: readOrbitTrim(), fuel: readFuelLevel(), now: T0 }), 'ahead');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(writeTrimBurn(plan.burn)).toBe(true);
    sync(a, x);
    bindRoom(a);
    // X's burn applies at the settled burn's time, and fires then too.
    const now = settled.at + 1_000;
    expect(readOrbitTrim()).toMatchObject({ slot: 1, at: settled.at, last: 'ahead' });
    expect(readBurnFiring(now, OTHER)).toEqual({ planetId: SOV, slot: 1, dir: 'ahead', at: settled.at });
    const c = ctx({ station: OTHER, trim: readOrbitTrim(), fuel: readFuelLevel(), now, firing: readBurnFiring(now, OTHER) });
    expect(planTrim(c, 'ahead')).toEqual({ ok: false, refusal: 'burning' });
  });

  it('a level write keeps the last burns on every orbit firing, not only the last one', () => {
    const OTHER = { ...STATION, orbitSlot: 1 };
    const a = new Y.Doc();
    const x = new Y.Doc();
    bindRoom(a);
    writeFuelLevel(50, 100);
    Y.applyUpdate(x, Y.encodeStateAsUpdate(a));
    // This tab burns on slot 0, and a tab that places the room in slot 1
    // burns there 100 ms later...
    const mine = press('raise', T0);
    bindRoom(x);
    const plan = planTrim(ctx({ station: OTHER, trim: readOrbitTrim(), fuel: readFuelLevel(), now: T0 + 100 }), 'ahead');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(writeTrimBurn(plan.burn)).toBe(true);
    sync(a, x);
    // ...and a REFUEL settles both while both still fire.
    bindRoom(a);
    writeFuelLevel(50, 100);
    const now = T0 + 1_000;
    const firing = [
      { planetId: SOV, slot: 0, dir: 'raise', at: mine.at },
      { planetId: SOV, slot: 1, dir: 'ahead', at: plan.burn.at },
    ];
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(a));
    for (const doc of [a, reload]) {
      bindRoom(doc);
      expect(readBurnFiring(now, STATION)).toEqual(firing[0]);
      expect(readBurnFiring(now, OTHER)).toEqual(firing[1]);
      const c = ctx({ trim: readOrbitTrim(), fuel: readFuelLevel(), now, firing: readBurnFiring(now, STATION) });
      expect(planTrim(c, 'raise')).toEqual({ ok: false, refusal: 'burning' });
    }
    // The next burn clears the settled entries; the settlement still has them.
    bindRoom(a);
    press('lower', mine.at + BURN_MS);
    expect(log(a).has(keyOf(a, mine))).toBe(false);
    expect(readBurnFiring(now, OTHER)).toEqual(firing[1]);
  });

  it('a level write keeps the last burn on each orbit, however many fired on another', () => {
    // Copilot's review of #173: the settlement kept the last 16 burns on any
    // orbit, so 16 burns on slot 1 pushed slot 0's still-firing one out.
    const OTHER = { ...STATION, orbitSlot: 1 };
    const a = new Y.Doc();
    const x = new Y.Doc();
    bindRoom(a);
    writeFuelLevel(50, 100);
    const mine = press('raise', T0);
    // Tabs that place the room in slot 1 burn there 20 times, and write one
    // burn on a planet this build doesn't know.
    Y.applyUpdate(x, Y.encodeStateAsUpdate(a));
    bindRoom(x);
    const theirs = Array.from({ length: 20 }, (_, i) => burnAt(T0 + 1 + i, 'ahead', { slot: 1 }));
    for (const b of theirs) expect(writeTrimBurn(b)).toBe(true);
    expect(writeTrimBurn(burnAt(T0 + 50, 'back', { planetId: 'planet-nowhere' }))).toBe(true);
    sync(a, x);
    // A REFUEL settles them all while slot 0's burn still fires.
    bindRoom(a);
    writeFuelLevel(readFuelLevel(), 100);
    const last = theirs[theirs.length - 1];
    expect((readFuelSettlement(SK) as KeepingSettlement).fired).toEqual([firedOf(mine), firedOf(last)]);
    // A burn from slot 1 clears the settled entries.
    sync(a, x);
    bindRoom(x);
    expect(writeTrimBurn(burnAt(T0 + 600, 'back', { slot: 1 }))).toBe(true);
    sync(a, x);
    bindRoom(a);
    expect(log(a).size).toBe(1);
    const now = T0 + 1_000;
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(a));
    for (const doc of [a, reload]) {
      bindRoom(doc);
      expect(readBurnFiring(now, STATION)).toEqual(firedOf(mine));
      expect(planTrim(ctx({ trim: readOrbitTrim(), fuel: readFuelLevel(), now, firing: readBurnFiring(now, STATION) }), 'raise'))
        .toEqual({ ok: false, refusal: 'burning' });
      expect(readBurnFiring(now, OTHER)).toEqual({ planetId: SOV, slot: 1, dir: 'back', at: T0 + 600 });
    }
  });

  it('each orbit keeps its own trim through burns from two slots, a REFUEL and the cleanup after it', () => {
    // Copilot's review of #173: with one trim for the room, two owner tabs
    // that place it in different slots undid each other's trim burn by burn,
    // and a REFUEL kept only the last orbit's, while every burn stayed paid.
    const OTHER = { ...STATION, orbitSlot: 1 };
    const a = new Y.Doc();
    const x = new Y.Doc();
    bindRoom(a);
    writeFuelLevel(50, 100);
    Y.applyUpdate(x, Y.encodeStateAsUpdate(a));
    /** One burn from a tab, planned as its helm plans it, then a sync. */
    const fire = (doc: Y.Doc, station: typeof STATION, dir: TrimDirection, now: number): TrimBurn => {
      bindRoom(doc);
      const plan = planTrim(ctx({
        station, trim: readOrbitTrim(station), fuel: readFuelLevel(), now, firing: readBurnFiring(now, station),
      }), dir);
      if (!plan.ok) throw new Error(`refused: ${plan.refusal}`);
      expect(writeTrimBurn(plan.burn)).toBe(true);
      sync(a, x);
      return plan.burn;
    };
    // This tab (slot 0) RAISEs, tab X (slot 1) slides AHEAD, and this tab
    // slides AHEAD from its raised orbit.
    const raise = fire(a, STATION, 'raise', T0);
    const theirAhead = fire(x, OTHER, 'ahead', T0 + BURN_MS);
    const ahead = fire(a, STATION, 'ahead', T0 + 2 * BURN_MS);
    const mine = applyBurn(applyBurn(null, raise), ahead)!;
    const theirs = applyBurn(null, theirAhead)!;
    expect(mine).toMatchObject({ slot: 0, dRadiusKm: TRIM_STEP_KM, last: 'ahead' });
    for (const doc of [a, x]) {
      bindRoom(doc);
      expect(readOrbitTrim(STATION)).toEqual(mine);
      expect(readOrbitTrim(OTHER)).toEqual(theirs);
      expect(readOrbitTrim(null)).toBeNull();
      expect(readFuelDrawn()).toBe(3 * TRIM_FUEL);
    }
    // X REFUELs: the settlement keeps both orbits' trims.
    bindRoom(x);
    writeFuelLevel(readFuelLevel(), 100);
    sync(a, x);
    expect((readFuelSettlement(SK) as KeepingSettlement).trims).toEqual([theirs, mine]);
    // X's next burn clears the settled entries; this tab's trim stays, here,
    // in X and after a reload.
    const theirBack = fire(x, OTHER, 'back', T0 + 3 * BURN_MS);
    expect(log(a).size).toBe(1);
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(a));
    for (const doc of [a, x, reload]) {
      bindRoom(doc);
      expect(readOrbitTrim(STATION)).toEqual(mine);
      expect(readOrbitTrim(OTHER)).toEqual(applyBurn(theirs, theirBack));
    }
    // This tab's LOWER starts from its raised orbit, and every burn paid once.
    const lower = fire(a, STATION, 'lower', T0 + 4 * BURN_MS);
    bindRoom(a);
    expect(readOrbitTrim(STATION)).toEqual(applyBurn(mine, lower));
    expect(readOrbitTrim(STATION)).toMatchObject({ dRadiusKm: 0, last: 'lower' });
    expect(readFuelDrawn()).toBe(5 * TRIM_FUEL);
    expect(readFuelLevel()).toBe(50 - 5 * TRIM_FUEL);
  });

  it('a level write leaves the stick on the burn it showed, even for two in the same millisecond', () => {
    const a = new Y.Doc();
    const x = new Y.Doc();
    bindRoom(a);
    writeFuelLevel(50, 100);
    Y.applyUpdate(x, Y.encodeStateAsUpdate(a));
    expect(writeTrimBurn(burnAt(T0, 'raise'))).toBe(true);
    bindRoom(x);
    expect(writeTrimBurn(burnAt(T0, 'ahead'))).toBe(true);
    sync(a, x);
    bindRoom(a);
    const now = T0 + 1_000;
    const shown = readBurnFiring(now, STATION);
    expect(shown).not.toBeNull();
    writeFuelLevel(readFuelLevel(), 100);
    expect((readFuelSettlement(SK) as KeepingSettlement).fired).toEqual([shown]);
    press('back', T0 + BURN_MS);
    expect(log(a).size).toBe(1);
    expect(readBurnFiring(now, STATION)).toEqual(shown);
  });

  it('ignores a hostile settlement: every burn in the log still counts', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    const b1 = press('raise', T0);
    const b2 = press('ahead', T0 + BURN_MS);
    const keys = [keyOf(doc, b1), keyOf(doc, b2)];
    const want = replayBurns([b1, b2]).trim;
    const hostile: unknown[] = [
      null,
      'settled',
      [keys],
      { trim: { ...trim(), dRadiusKm: MAX_TRIM_KM + 1 }, fuelDrawn: 0, burns: keys },
      { trim: 'trim', fuelDrawn: 0, burns: keys },
      { trim: null, fuelDrawn: -1, burns: keys },
      { trim: null, fuelDrawn: Number.NaN, burns: keys },
      { trim: null, fuelDrawn: 1e13, burns: keys },
      { trim: null, fuelDrawn: 0, burns: 'burn:' },
      { trim: null, fuelDrawn: 0, burns: [...keys, 7] },
      { trim: null, fuelDrawn: 0, burns: [...keys, 'trim'] },
      { trim: null, fuelDrawn: 0, burns: [...keys, `burn:${'x'.repeat(100)}`] },
      { trim: null, fuelDrawn: 0, burns: [...keys, ...Array.from({ length: 2 * MAX_LOG }, (_, i) => `burn:x:${i}`)] },
      { trim: null, fuelDrawn: 0, burns: keys, fired: 'fired' },
      { trim: null, fuelDrawn: 0, burns: keys, fired: [{ planetId: SOV, slot: 0, dir: 'up', at: T0 }] },
      { trim: null, fuelDrawn: 0, burns: keys, fired: [{ planetId: SOV, slot: -1, dir: 'raise', at: T0 }] },
      // Past the 256 a settlement may carry.
      { trim: null, fuelDrawn: 0, burns: keys, fired: Array.from({ length: 257 }, () => ({ planetId: SOV, slot: 0, dir: 'raise', at: T0 })) },
      { trim: null, fuelDrawn: 0, burns: keys, trims: 'trims' },
      { trim: null, fuelDrawn: 0, burns: keys, trims: [{ ...trim(), dRadiusKm: MAX_TRIM_KM + 1 }] },
      { trim: null, fuelDrawn: 0, burns: keys, trims: Array.from({ length: 257 }, () => trim()) },
    ];
    for (const value of hostile) {
      expect(isKeepingSettlement(value)).toBe(false);
      doc.getMap('ship').set('fuel', { level: 50, settled: { [SK]: value } });
      expect(readOrbitTrim()).toEqual(want);
      expect(readFuelDrawn()).toBe(2 * TRIM_FUEL);
    }
    for (const settled of ['x', [1], null]) {
      doc.getMap('ship').set('fuel', { level: 50, settled });
      expect(readOrbitTrim()).toEqual(want);
    }
  });

  it('keeps another build\'s settlement, and drops none of this build\'s', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    const theirs = { any: ['plain', 'json'] };
    doc.getMap('ship').set('fuel', { level: 40, meters: { stationMove: 3 }, settled: { stationMove: theirs } });
    press('raise', T0);
    writeFuelLevel(readFuelLevel(), 100);
    const rec = doc.getMap('ship').get('fuel') as FuelRecord;
    expect(rec.settled?.stationMove).toEqual(theirs);
    expect(isKeepingSettlement(rec.settled?.[SK])).toBe(true);
    // A room whose log never held a burn keeps no settlement for it.
    const fresh = new Y.Doc();
    bindRoom(fresh);
    writeFuelLevel(40, 100);
    expect((fresh.getMap('ship').get('fuel') as FuelRecord).settled).toBeUndefined();
  });

  it('a level write keeps the settlement the record had when station keeping hands none', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    press('raise', T0);
    writeFuelLevel(readFuelLevel(), 100);
    const settled = readFuelSettlement(SK);
    expect(isKeepingSettlement(settled)).toBe(true);
    // Station keeping's doc is gone (a rebind half done), the ship doc's is not.
    const gone = new Y.Doc();
    bindStationKeepingDoc(gone);
    gone.destroy();
    writeFuelLevel(40, 100);
    expect(readFuelSettlement(SK)).toEqual(settled);
    bindRoom(doc);
    expect(readOrbitTrim()).toEqual((settled as KeepingSettlement).trim);
  });

  it('never takes the meter past what a reading can hold', () => {
    // Copilot's review of #173: a reading past FUEL_METER_MAX counts as none,
    // so one more burn refunded every burn before it and voided the
    // settlement.
    const doc = new Y.Doc();
    bindRoom(doc);
    doc.getMap('stationKeeping').set('trim', trim({ fuelDrawn: FUEL_METER_MAX }));
    doc.getMap('ship').set('fuel', { level: 1e15 });
    const gauge = readFuelLevel();
    expect(gauge).toBe(1e15 - FUEL_METER_MAX);
    doc.getMap('stationKeeping').set('burn:peer:1', burnAt(T0 + HOUR, 'raise'));
    expect(readFuelDrawn()).toBe(FUEL_METER_MAX);
    expect(readOrbitTrim()).toEqual(trim());
    expect(readFuelLevel()).toBe(gauge);
    writeFuelLevel(readFuelLevel(), 1e15);
    expect(isKeepingSettlement(readFuelSettlement(SK))).toBe(true);
  });

  it('leaves out a burn whose key no settlement could name', () => {
    // Copilot's review of #173: settling it voided the settlement, so the
    // burns it dropped came back and the log never cleared.
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    doc.getMap('stationKeeping').set(`burn:${'x'.repeat(100)}`, burnAt(T0, 'raise'));
    expect(readOrbitTrim()).toBeNull();
    expect(readFuelDrawn()).toBe(0);
    const b = press('ahead', T0 + BURN_MS);
    writeFuelLevel(readFuelLevel(), 100);
    const settled = readFuelSettlement(SK);
    expect(isKeepingSettlement(settled)).toBe(true);
    expect((settled as KeepingSettlement).burns).toEqual([keyOf(doc, b)]);
    expect(readFuelLevel()).toBe(50 - TRIM_FUEL);
  });

  it('takes the same burns out of a flood whatever order it was written in', () => {
    const flood = Array.from({ length: 3 * MAX_LOG }, (_, i) => burnAt(T0 + i * BURN_MS, i % 3 ? 'ahead' : 'back'));
    const junk = Array.from({ length: 2 * MAX_LOG + 10 }, (_, i) => `burn:junk:${i}`);
    const settle = (reversed: boolean) => {
      const doc = new Y.Doc();
      bindRoom(doc);
      writeFuelLevel(5_000, 5_000);
      const entries = flood.map((b, i) => [`burn:peer:${i}`, b] as const);
      doc.transact(() => {
        for (const [key, b] of reversed ? [...entries].reverse() : entries) log(doc).set(key, b);
        for (const key of reversed ? [...junk].reverse() : junk) log(doc).set(key, 'junk');
      });
      const before = { trim: readOrbitTrim(), drawn: readFuelDrawn() };
      writeFuelLevel(5_000, 5_000);
      return { before, settled: readFuelSettlement(SK) };
    };
    const forward = settle(false);
    expect(settle(true)).toEqual(forward);
    expect(forward.before.drawn).toBe(MAX_LOG * TRIM_FUEL);
    expect(forward.before.trim).toEqual(replayBurns(flood.slice(0, MAX_LOG)).trim);
    const settled = forward.settled as KeepingSettlement;
    expect(isKeepingSettlement(settled)).toBe(true);
    expect(settled.burns.slice(0, MAX_LOG)).toEqual(flood.slice(0, MAX_LOG).map((_, i) => `burn:peer:${i}`));
    expect(settled.burns).toHaveLength(2 * MAX_LOG);
  });

  it('holds the stick once MAX_LOG burns wait, and takes no more than that until a level write', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(5_000, 5_000);
    // A peer floods the log: MAX_LOG + 5 burns, one transaction.
    const flood = Array.from({ length: MAX_LOG + 5 }, (_, i) => burnAt(T0 + i * BURN_MS, 'ahead'));
    doc.transact(() => flood.forEach((b, i) => log(doc).set(`burn:peer:${i}`, b)));
    expect(isBurnLogFull()).toBe(true);
    const now = T0 + flood.length * BURN_MS;
    expect(planTrim(ctx({ fuel: readFuelLevel(), now, logFull: isBurnLogFull() }), 'raise'))
      .toEqual({ ok: false, refusal: 'log-full' });
    expect(writeTrimBurn(burnAt(now, 'raise'))).toBe(false);
    // The replay takes the first MAX_LOG; the last five wait.
    expect(readFuelDrawn()).toBe(MAX_LOG * TRIM_FUEL);
    expect(readOrbitTrim()).toEqual(replayBurns(flood.slice(0, MAX_LOG)).trim);
    // A REFUEL settles those, and the five come in after them.
    writeFuelLevel(5_000, 5_000);
    const settled = readFuelSettlement(SK) as KeepingSettlement;
    expect(settled.burns).toHaveLength(MAX_LOG);
    expect(isBurnLogFull()).toBe(false);
    expect(readFuelDrawn()).toBe((MAX_LOG + 5) * TRIM_FUEL);
    const b = press('raise', now);
    expect(log(doc).size).toBe(5 + 1);
    expect(readOrbitTrim()).toEqual(replayBurns([...flood.slice(MAX_LOG), b], settled.trim).trim);
    expect(readFuelLevel()).toBe(5_000 - 6 * TRIM_FUEL);
  });
});

describe('a burn stamped ahead of our clock', () => {
  // Copilot's review of #173: a peer's burn stamped in the future sorts last,
  // so the trim ends on it and the stick read "not burning" right after a
  // burn of its own.
  it('never lets the next push skip the lockout, and fires when its time comes', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    const b = press('raise', T0);
    // The peer's burn reaches us after ours, so it sorts last.
    const ahead = burnAt(T0 + HOUR, 'back');
    doc.getMap('stationKeeping').set('burn:peer:1', ahead);
    expect(readOrbitTrim()).toMatchObject({ at: ahead.at, last: 'back' });
    expect(readBurnFiring(T0 + 10)).toEqual({ planetId: SOV, slot: 0, dir: 'raise', at: T0 });
    expect(() => press('lower', T0 + 10)).toThrow('refused: burning');
    expect(readBurnFiring(T0 + BURN_MS)).toBeNull();
    press('lower', T0 + BURN_MS);
    expect(readBurnFiring(ahead.at + 10)).toMatchObject({ dir: 'back', at: ahead.at });
    expect(readFuelDrawn()).toBe(3 * TRIM_FUEL);
    expect(b.at).toBe(T0);
  });

  it('picks the burn firing on the station\'s own orbit, whatever fired since on another', () => {
    // Copilot's review of #173: an install that puts the room in another slot
    // burns on that orbit. Its newer burn must not hide ours, or the stick
    // would skip the lockout and the dashboard would miss the burn.
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    const ours = press('raise', T0);
    doc.getMap('stationKeeping').set('burn:peer:1', burnAt(T0 + 100, 'back', { slot: 1 }));
    const now = T0 + 200;
    expect(readBurnFiring(now)).toMatchObject({ slot: 1, at: T0 + 100 });
    expect(readBurnFiring(now, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'raise', at: ours.at });
    expect(readBurnFiring(now, { planetId: SOV, orbitSlot: 1 })).toMatchObject({ dir: 'back', at: T0 + 100 });
    expect(readBurnFiring(now, null)).toBeNull();
    expect(() => press('lower', now)).toThrow('refused: burning');
    expect(readBurnFiring(T0 + BURN_MS, STATION)).toBeNull();
    press('lower', T0 + BURN_MS);
  });

  it('a REFUEL keeps the burn firing now, and the next press fires at its own time', () => {
    // Copilot's review of #173: a REFUEL that settled a peer burn stamped an
    // hour ahead dated the trim then and kept only that burn's firing. The
    // burn firing now lost its lockout, and every press after the REFUEL
    // applied, and fired, an hour on, so the stick never waited.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const doc = new Y.Doc();
      bindRoom(doc);
      writeFuelLevel(50, 100);
      const mine = press('raise', T0);
      // The peer's burn reaches us after ours, so the trim ends on it.
      doc.getMap('stationKeeping').set('burn:peer:1', burnAt(T0 + HOUR, 'back'));
      const base = slotOrbit(STATION);
      const before = readOrbitTrim();
      vi.setSystemTime(T0 + 1_000);
      writeFuelLevel(readFuelLevel(), 100);
      const settled = readFuelSettlement(SK) as KeepingSettlement;
      // Nothing it keeps is dated past the write: the trim is re-dated on
      // the same orbit, and the burn it keeps firing is the one firing now.
      expect(settled.trim).toMatchObject({ dRadiusKm: TRIM_STEP_KM, at: T0 + 1_000, last: 'back', seq: 2 });
      expect(settled.trims).toEqual([settled.trim]);
      for (const t of [T0, T0 + HOUR, T0 + 30 * HOUR]) {
        expect(signedAngle(angleAt(trimmedOrbit(base, settled.trim), t) - angleAt(trimmedOrbit(base, before), t))).toBeCloseTo(0, 9);
      }
      expect(settled.fired).toEqual([firedOf(mine)]);
      const reload = new Y.Doc();
      Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
      for (const d of [doc, reload]) {
        bindRoom(d);
        expect(readBurnFiring(T0 + 1_000, STATION)).toEqual(firedOf(mine));
        expect(() => press('lower', T0 + 1_000)).toThrow('refused: burning');
      }
      // The next press fires at its own time, and holds the stick in turn.
      bindRoom(doc);
      const next = press('lower', T0 + BURN_MS);
      expect(readOrbitTrim()).toMatchObject({ at: next.at, last: 'lower' });
      expect(readBurnFiring(T0 + BURN_MS + 10, STATION)).toEqual(firedOf(next));
      expect(() => press('ahead', T0 + BURN_MS + 10)).toThrow('refused: burning');
      // Every burn applied once and paid once.
      expect(readFuelDrawn()).toBe(3 * TRIM_FUEL);
      expect(readFuelLevel()).toBe(50 - 3 * TRIM_FUEL);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a press made after a burn stamped ahead replays after it, as it was planned, and fires at its own time', () => {
    // Copilot's review of #173: sorted by time alone, a press made after a
    // peer's burn stamped ahead replayed before it, so the orbit it left was
    // not the one it was planned on.
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    const ahead = burnAt(T0 + HOUR, 'back');
    doc.getMap('stationKeeping').set('burn:peer:1', ahead);
    const plan = planTrim(ctx({ trim: readOrbitTrim(), fuel: readFuelLevel(), now: T0, firing: readBurnFiring(T0, STATION) }), 'raise');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(writeTrimBurn(plan.burn)).toBe(true);
    const log = doc.getMap('stationKeeping');
    expect(log.get(keyOf(doc, plan.burn))).toEqual({ ...plan.burn, order: ahead.at + 1 });
    expect(readOrbitTrim()).toEqual(plan.trim);
    expect(readOrbitTrim()).toMatchObject({ at: T0, last: 'raise', seq: 2 });
    // It fires at its own time, and the next press goes after it in turn.
    expect(readBurnFiring(T0 + 10, STATION)).toEqual(firedOf(plan.burn));
    expect(() => press('lower', T0 + 10)).toThrow('refused: burning');
    const next = press('lower', T0 + BURN_MS);
    expect(log.get(keyOf(doc, next))).toMatchObject({ at: next.at, order: ahead.at + 2 });
    expect(readOrbitTrim()).toMatchObject({ dRadiusKm: 0, at: next.at, last: 'lower', seq: 3 });
    expect(readFuelDrawn()).toBe(3 * TRIM_FUEL);
    // One written in the same millisecond as a burn the log holds goes after it too.
    const twin = new Y.Doc();
    bindRoom(twin);
    writeFuelLevel(50, 100);
    twin.getMap('stationKeeping').set('burn:peer:1', burnAt(T0, 'raise'));
    const same = burnAt(T0, 'ahead');
    expect(writeTrimBurn(same)).toBe(true);
    expect(twin.getMap('stationKeeping').get(keyOf(twin, same))).toEqual({ ...same, order: T0 + 1 });
    expect(readOrbitTrim()).toMatchObject({ last: 'ahead', seq: 2 });
    // The place is only ever past the burn's own time, and bounded.
    expect(isTrimBurn({ ...burnAt(T0, 'raise'), order: T0 + 1 })).toBe(true);
    for (const order of [T0, T0 - 1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, String(T0 + 1)]) {
      expect(isTrimBurn({ ...burnAt(T0, 'raise'), order })).toBe(false);
    }
  });

  it('a dropped burn never fires', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(0, 100);
    doc.getMap('stationKeeping').set('burn:peer:1', burnAt(T0, 'raise'));
    expect(readBurnFiring(T0 + 10)).toBeNull();
    expect(readOrbitTrim()).toBeNull();
  });
});

describe('a station with several helm rooms: the shared trim', () => {
  // Copilot's review of #176: every room bolted into a station steers it,
  // each with its own burn log, so a burn from a second helm room started
  // from that room's own trim (often none) and replaced the orbit the first
  // one left, instead of going on from it.
  afterEach(() => setSharedTrimSource(null));

  /** Fire one burn in the bound room the way the helm does, the station's
   *  shared trim included. */
  function pressShared(dir: TrimDirection, now: number): TrimBurn {
    const plan = planTrim(ctx({
      trim: readOrbitTrim(STATION), shared: readSharedTrim(STATION), fuel: readFuelLevel(), now,
      firing: readBurnFiring(now, STATION),
    }), dir);
    if (!plan.ok) throw new Error(`refused: ${plan.refusal}`);
    expect(writeTrimBurn(plan.burn)).toBe(true);
    return plan.burn;
  }

  it('the newer of two trims is the one further along its line, then the later, then the greater by content', () => {
    // Copilot's review of #173: two helm rooms burning in one millisecond
    // each kept their own trim, and the replay kept its own over a carried
    // trim as new, so the rooms flew different orbits.
    const ahead = trim({ dRadiusKm: TRIM_STEP_KM, at: T0, seq: 3 });
    const later = trim({ dRadiusKm: 2 * TRIM_STEP_KM, at: T0 + HOUR, seq: 2 });
    // Further along beats later: a burn that went on from a trim stamped
    // ahead of its own clock is still the newer.
    expect(isNewerTrim(ahead, later)).toBe(true);
    expect(isNewerTrim(later, ahead)).toBe(false);
    expect(isNewerTrim({ ...later, seq: 3 }, ahead)).toBe(true);
    // A trim from before the count counts none.
    expect(isNewerTrim(trim({ at: T0 + HOUR }), trim({ seq: 1 }))).toBe(false);
    expect(isNewerTrim(trim({ at: T0 + HOUR }), trim())).toBe(true);
    // As far along and as new: the greater by content, one way round only,
    // so the helm flies the same trim whichever room's own it is.
    const twin = { ...ahead, dRadiusKm: -TRIM_STEP_KM };
    expect(isNewerTrim(ahead, twin)).toBe(!isNewerTrim(twin, ahead));
    expect(helmTrim(STATION, ahead, twin)).toBe(helmTrim(STATION, twin, ahead));
    // A trim is not newer than itself, whatever else it carries.
    expect(isNewerTrim(ahead, { ...ahead })).toBe(false);
    expect(isNewerTrim({ ...ahead, fuelDrawn: 3 }, ahead)).toBe(false);
  });

  it('the helm goes on from the newer of the room\'s own trim and the shared one, on the station\'s orbit only', () => {
    const own = trim({ dRadiusKm: TRIM_STEP_KM, at: T0 });
    const newer = trim({ dRadiusKm: 2 * TRIM_STEP_KM, at: T0 + 1_000 });
    expect(helmTrim(STATION, own, newer)).toBe(newer);
    expect(helmTrim(STATION, newer, own)).toBe(newer);
    expect(helmTrim(STATION, null, newer)).toBe(newer);
    expect(helmTrim(STATION, own, null)).toBe(own);
    // The room's own coming back through the summary: the room's own.
    expect(helmTrim(STATION, own, { ...own })).toBe(own);
    // Another orbit's is not the station's.
    expect(helmTrim(STATION, own, { ...newer, slot: 1 })).toBe(own);
    expect(helmTrim(null, own, newer)).toBeNull();
  });

  it('reads the shared trim through the installed source, on the station\'s orbit, and nothing malformed', () => {
    expect(readSharedTrim(STATION)).toBeNull();
    const t = trim({ dRadiusKm: TRIM_STEP_KM });
    setSharedTrimSource((st) => (st.id === STATION.id ? { ...t, fuelDrawn: 3 } : null));
    expect(readSharedTrim(STATION)).toEqual(t);
    expect(readSharedTrim({ ...STATION, id: 'elsewhere' })).toBeNull();
    expect(readSharedTrim({ ...STATION, orbitSlot: 1 })).toBeNull();
    expect(readSharedTrim(null)).toBeNull();
    const hostile = [
      () => { throw new Error('summary gone'); },
      () => 'trim',
      () => ({ ...t, dRadiusKm: Number.NaN }),
      () => ({ ...t, at: 0 }),
    ];
    for (const source of hostile) {
      setSharedTrimSource(source as never);
      expect(readSharedTrim(STATION)).toBeNull();
    }
  });

  it('a press goes on from a newer shared trim and carries it, and the burn firing there holds the stick', () => {
    const own = trim({ at: T0 - HOUR });
    const shared = trim({ dRadiusKm: TRIM_STEP_KM, at: T0, last: 'raise' });
    const now = T0 + BURN_MS;
    const plan = planTrim(ctx({ trim: own, shared, now, firing: null }), 'ahead');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.burn.from).toEqual(shared);
    expect(plan.trim).toEqual(applyBurn(shared, plan.burn));
    expect(plan.trim).toMatchObject({ dRadiusKm: TRIM_STEP_KM, last: 'ahead' });
    // The room's own as new or newer, or the shared one on another orbit: nothing to carry.
    for (const c of [ctx({ trim: shared, shared: own, now }), ctx({ trim: own, shared: { ...shared, slot: 1 }, now })]) {
      const p = planTrim(c, 'ahead');
      expect(p.ok).toBe(true);
      expect(p.ok && 'from' in p.burn).toBe(false);
    }
    // The shared trim's last burn, still firing, holds this stick too.
    expect(planTrim(ctx({ trim: own, shared, now: T0 + 10, firing: null }), 'ahead')).toEqual({ ok: false, refusal: 'burning' });
  });

  it('the burn the helm shows firing is the shared trim\'s last one while the helm flies from that, else this room\'s own', () => {
    // Copilot's review of #173: the knob, the box and the console's stick read
    // this room's burns alone, so they stood still while the dashboard said
    // another helm room's burn was firing.
    bindRoom(new Y.Doc());
    writeFuelLevel(10, 100);
    const shared = trim({ dRadiusKm: TRIM_STEP_KM, at: T0, last: 'raise', seq: 1 });
    setSharedTrimSource(() => shared);
    expect(readHelmFiring(T0 + 100, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'raise', at: T0 });
    expect(readHelmFiring(T0 + 100, { ...STATION, orbitSlot: 1 })).toBeNull();
    expect(readHelmFiring(T0 + BURN_MS, STATION)).toBeNull();
    // Once this room has gone on from it, its own burn.
    const mine = pressShared('ahead', T0 + BURN_MS);
    const now = T0 + BURN_MS + 10;
    expect(readHelmFiring(now, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'ahead', at: mine.at });
    expect(readHelmFiring(now, null)).toBeNull();
    // A later burn on a shared trim this room's own is further along than
    // shows nothing here; one on a shared trim further along shows.
    setSharedTrimSource(() => trim({ at: T0 + BURN_MS + 5, last: 'back', seq: 1 }));
    expect(readHelmFiring(now, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'ahead', at: mine.at });
    setSharedTrimSource(() => trim({ at: T0 + BURN_MS + 5, last: 'back', seq: 3 }));
    expect(readHelmFiring(now, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'back', at: T0 + BURN_MS + 5 });
    // Fired in the same millisecond as this room's, the shared trim's burn
    // shows while the helm flies that trim (Copilot's review of #173).
    setSharedTrimSource(() => trim({ at: mine.at, last: 'back', seq: 3 }));
    expect(readHelmFiring(now, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'back', at: mine.at });
    setSharedTrimSource(() => trim({ at: mine.at, last: 'back', seq: 1 }));
    expect(readHelmFiring(now, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'ahead', at: mine.at });
  });

  it('a burn that carries the shared trim replays from it, unless the room\'s own is newer by then', () => {
    const shared = trim({ dRadiusKm: TRIM_STEP_KM, at: T0, last: 'raise' });
    const carried = burnAt(T0 + BURN_MS, 'ahead', { from: shared });
    expect(replayBurns([carried]).trim).toEqual(applyBurn(shared, carried));
    // This room burned after the shared trim was left: its own is newer.
    const mine = burnAt(T0 + 1_000, 'lower');
    expect(replayBurns([mine, carried]).trim).toEqual(applyBurn(applyBurn(null, mine), carried));
    // Two burns the same but for what they carry still replay in one order.
    const other = burnAt(T0 + BURN_MS, 'ahead', { from: { ...shared, dRadiusKm: -TRIM_STEP_KM } });
    expect(replayBurns([other, carried])).toEqual(replayBurns([carried, other]));
  });

  it('a burn that goes on from a shared trim stamped ahead of this room\'s clock fires at its own time, one burn further along, and the stick still waits', () => {
    // Copilot's review of #173: dating such a burn from the shared trim let
    // the next press skip the lockout.
    const shared = trim({ dRadiusKm: TRIM_STEP_KM, at: T0 + HOUR, last: 'raise', seq: 4 });
    setSharedTrimSource(() => shared);
    bindRoom(new Y.Doc());
    writeFuelLevel(10, 100);
    const first = pressShared('raise', T0);
    expect(first.from).toEqual(shared);
    // It applies, and fires, at its own time, one burn further along the
    // shared trim's line, so the helm flies from it, not from the shared trim
    // stamped later.
    const left = readOrbitTrim(STATION)!;
    expect(left).toEqual(applyBurn(shared, first));
    expect(left).toMatchObject({ dRadiusKm: 2 * TRIM_STEP_KM, at: T0, seq: 5 });
    expect(helmTrim(STATION, left, readSharedTrim(STATION))).toBe(left);
    // A press at once waits for it.
    const now = T0 + 10;
    expect(readHelmFiring(now, STATION)).toEqual({ planetId: SOV, slot: 0, dir: 'raise', at: T0 });
    expect(planTrim(ctx({
      trim: left, shared: readSharedTrim(STATION), fuel: readFuelLevel(), now, firing: readBurnFiring(now, STATION),
    }), 'raise')).toEqual({ ok: false, refusal: 'burning' });
    // Once it has fired, the next goes on from this room's own, carrying nothing.
    const second = pressShared('raise', T0 + BURN_MS);
    expect('from' in second).toBe(false);
    expect(readOrbitTrim(STATION)).toMatchObject({ dRadiusKm: 3 * TRIM_STEP_KM, at: T0 + BURN_MS, seq: 6 });
  });

  it('two helm rooms burning in one millisecond settle on one trim, in either room and in the replay', () => {
    const start = trim({ dRadiusKm: TRIM_STEP_KM, at: T0, seq: 2 });
    setSharedTrimSource(() => start);
    const now = T0 + BURN_MS;
    const a = new Y.Doc();
    bindRoom(a);
    writeFuelLevel(10, 100);
    pressShared('raise', now);
    const inA = readOrbitTrim(STATION)!;
    const b = new Y.Doc();
    bindRoom(b);
    writeFuelLevel(10, 100);
    pressShared('ahead', now);
    const inB = readOrbitTrim(STATION)!;
    // As far along and as new: they differ by content alone.
    expect(inA).toMatchObject({ at: now, seq: 3 });
    expect(inB).toMatchObject({ at: now, seq: 3 });
    // Whoever shares them picks the newer, and each room's helm flies that one.
    const won = isNewerTrim(inA, inB) ? inA : inB;
    setSharedTrimSource(() => won);
    for (const doc of [a, b]) {
      bindRoom(doc);
      expect(helmTrim(STATION, readOrbitTrim(STATION), readSharedTrim(STATION))).toEqual(won);
    }
    // The other room's next press goes on from it, and its replay agrees.
    bindRoom(won === inA ? b : a);
    const next = pressShared('lower', now + BURN_MS);
    expect(next.from).toEqual(won);
    expect(readOrbitTrim(STATION)).toEqual(applyBurn(won, next));
    expect(readOrbitTrim(STATION)).toMatchObject({ seq: 4, last: 'lower' });
  });

  it('a trim carried back into the room past a burn of its own stamped ahead lands that burn once', () => {
    // Copilot's review of #173: room A's tab running an hour fast raised the
    // orbit; room B went on from that with AHEAD; room A's other tab went on
    // from B's with LOWER. Sorted by time, A's LOWER replayed before its own
    // RAISE, so the RAISE landed again on top of the trim that held it.
    const a = new Y.Doc();
    bindRoom(a);
    writeFuelLevel(50, 100);
    const raise = burnAt(T0 + HOUR, 'raise');
    expect(writeTrimBurn(raise)).toBe(true);
    const inA = readOrbitTrim(STATION)!;
    setSharedTrimSource(() => inA);
    const b = new Y.Doc();
    bindRoom(b);
    writeFuelLevel(50, 100);
    const ahead = pressShared('ahead', T0);
    expect(ahead.from).toEqual(inA);
    const inB = readOrbitTrim(STATION)!;
    expect(inB).toMatchObject({ dRadiusKm: TRIM_STEP_KM, at: T0, last: 'ahead', seq: 2 });
    setSharedTrimSource(() => inB);
    bindRoom(a);
    const lower = pressShared('lower', T0 + 3_000);
    expect(lower.from).toEqual(inB);
    // A's LOWER replays after A's RAISE, as A's tab saw them, so it goes on
    // from B's trim and the RAISE lands once: back at the slot's height,
    // three burns along.
    const want = applyBurn(inB, lower);
    expect(want).toMatchObject({ dRadiusKm: 0, at: T0 + 3_000, last: 'lower', seq: 3 });
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(a));
    for (const doc of [a, reload]) {
      bindRoom(doc);
      expect(readOrbitTrim(STATION)).toEqual(want);
      expect(readFuelDrawn()).toBe(2 * TRIM_FUEL);
    }
    // The same after a REFUEL settles it.
    writeFuelLevel(readFuelLevel(), 100);
    expect(readOrbitTrim(STATION)).toEqual(want);
  });

  it('each trim counts the burns along its line, through the band\'s edge, a REFUEL and a reload, and takes no count it cannot hold', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    const steps = Math.round(MAX_TRIM_KM / TRIM_STEP_KM);
    for (let i = 0; i < steps; i++) pressShared('raise', T0 + i * BURN_MS);
    expect(readOrbitTrim(STATION)).toMatchObject({ dRadiusKm: MAX_TRIM_KM, seq: steps });
    // At the band's edge a burn changes nothing, but it counts.
    const edge = burnAt(T0 + steps * BURN_MS, 'raise');
    expect(writeTrimBurn(edge)).toBe(true);
    expect(readOrbitTrim(STATION)).toMatchObject({ dRadiusKm: MAX_TRIM_KM, at: edge.at, seq: steps + 1 });
    // A REFUEL settles it with its count, which a reload keeps.
    writeFuelLevel(readFuelLevel(), 100);
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
    bindRoom(reload);
    expect(readOrbitTrim(STATION)).toMatchObject({ seq: steps + 1 });
    pressShared('lower', T0 + (steps + 1) * BURN_MS);
    expect(readOrbitTrim(STATION)).toMatchObject({ dRadiusKm: MAX_TRIM_KM - TRIM_STEP_KM, seq: steps + 2 });
    // The guard takes a whole count from none up, and no more than it can add one to.
    expect(isOrbitTrim(trim({ seq: 0 }))).toBe(true);
    for (const seq of [-1, 1.5, Number.NaN, 2 ** 53, '3']) expect(isOrbitTrim({ ...trim(), seq })).toBe(false);
  });

  it('a burn carries only a well-formed trim on its own orbit', () => {
    expect(isTrimBurn(burnAt(T0, 'raise', { from: trim() }))).toBe(true);
    expect(isTrimBurn(burnAt(T0, 'raise', { from: trim({ slot: 1 }) }))).toBe(false);
    expect(isTrimBurn(burnAt(T0, 'raise', { from: trim({ planetId: 'planet-aris' }) }))).toBe(false);
    expect(isTrimBurn(burnAt(T0, 'raise', { from: { ...trim(), dRadiusKm: MAX_TRIM_KM + 1 } }))).toBe(false);
    expect(isTrimBurn({ ...burnAt(T0, 'raise'), from: 'trim' })).toBe(false);
    // What it publishes is the orbit alone.
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(10, 100);
    const b = burnAt(T0, 'ahead', { from: trim({ fuelDrawn: 4 }) });
    expect(writeTrimBurn(b)).toBe(true);
    expect(doc.getMap('stationKeeping').get(keyOf(doc, b))).toEqual({ ...b, from: trim() });
  });

  it('a burn from a second helm room goes on from the orbit the first left, through a REFUEL and a reload', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    bindRoom(a);
    writeFuelLevel(50, 100);
    const raise = press('raise', T0);
    const left = readOrbitTrim(STATION)!;
    // The summary shares room A's trim with room B, a room of the same station.
    setSharedTrimSource(() => left);
    bindRoom(b);
    writeFuelLevel(50, 100);
    const now = T0 + BURN_MS;
    const plan = planTrim(ctx({
      trim: readOrbitTrim(STATION), shared: readSharedTrim(STATION), fuel: readFuelLevel(), now,
      firing: readBurnFiring(now, STATION),
    }), 'ahead');
    if (!plan.ok) throw new Error(plan.refusal);
    expect(writeTrimBurn(plan.burn)).toBe(true);
    const went = applyBurn(applyBurn(null, raise), plan.burn)!;
    expect(went).toMatchObject({ dRadiusKm: TRIM_STEP_KM, last: 'ahead' });
    expect(readOrbitTrim(STATION)).toEqual(went);
    // The burn carries the orbit it went on from, so room B's log replays
    // the same with no summary, after a REFUEL settles it, and after a reload.
    setSharedTrimSource(null);
    expect(readOrbitTrim(STATION)).toEqual(went);
    writeFuelLevel(readFuelLevel(), 100);
    const next = press('lower', T0 + 2 * BURN_MS);
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(b));
    bindRoom(reload);
    expect(readOrbitTrim(STATION)).toEqual(applyBurn(went, next));
    expect(readOrbitTrim(STATION)).toMatchObject({ dRadiusKm: 0, last: 'lower' });
    expect(readFuelDrawn()).toBe(2 * TRIM_FUEL);
  });
});

describe('the fuel record: one reading per meter', () => {
  const fuelRecord = (doc: Y.Doc) => doc.getMap('ship').get('fuel') as FuelRecord;

  it('a room with no meters reads its level as written', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    doc.getMap('ship').set('fuel', { level: 25 });
    doc.getMap('stationKeeping').set('trim', trim());
    expect(readFuelDrawn()).toBe(0);
    expect(readFuelLevel()).toBe(25);
    expect(fuelDrawDeficit(SK)).toBe(0);
    writeFuelLevel(20, 100);
    expect(fuelRecord(doc)).toEqual({ level: 20 });
  });

  it('a level write keeps each meter\'s reading, and their sum for builds from before them', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(30, 100);
    const b1 = press('raise', T0);
    const b2 = press('raise', T0 + BURN_MS);
    writeFuelLevel(readFuelLevel(), 100);
    expect(fuelRecord(doc)).toEqual({
      level: 30 - 2 * TRIM_FUEL,
      meters: { [SK]: 2 * TRIM_FUEL },
      meter: 2 * TRIM_FUEL,
      settled: {
        [SK]: {
          trim: readOrbitTrim(),
          trims: [readOrbitTrim()],
          fuelDrawn: 2 * TRIM_FUEL,
          burns: [keyOf(doc, b1), keyOf(doc, b2)],
          fired: [firedOf(b2)],
        },
      },
    });
    expect(readFuelLevel()).toBe(30 - 2 * TRIM_FUEL);
  });

  it('a record from before per-meter readings is read against their sum, and owes nothing', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    doc.getMap('stationKeeping').set('trim', trim({ fuelDrawn: 12 }));
    doc.getMap('ship').set('fuel', { level: 40, meter: 10 });
    expect(readFuelLevel()).toBe(40 - 2);
    // Its one reading cannot say whose meter went back.
    doc.getMap('ship').set('fuel', { level: 40, meter: 15 });
    expect(readFuelLevel()).toBe(40);
    expect(fuelDrawDeficit(SK)).toBe(0);
    // The next level write keeps a reading per meter.
    writeFuelLevel(readFuelLevel(), 100);
    expect(fuelRecord(doc)).toEqual({ level: 40, meters: { [SK]: 12 }, meter: 12 });
    press('raise', T0 + BURN_MS);
    expect(readFuelLevel()).toBe(40 - TRIM_FUEL);
  });

  it('a hostile reading on the fuel record counts as none', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    doc.getMap('stationKeeping').set('trim', trim({ fuelDrawn: 3 }));
    const hostile: Record<string, unknown>[] = [
      { meter: 1e300 }, { meter: Number.POSITIVE_INFINITY }, { meter: Number.NaN }, { meter: -5 }, { meter: '7' },
      { meters: { [SK]: 1e300 } }, { meters: { [SK]: -5 } }, { meters: { [SK]: '7' } }, { meters: { [SK]: Number.NaN } },
      { meters: 'x' }, { meters: [3] }, { meters: null }, { meters: { 'not a name': 3 } },
    ];
    for (const fields of hostile) {
      doc.getMap('ship').set('fuel', { level: 25, ...fields });
      expect(readFuelLevel()).toBe(25 - 3);
      expect(fuelDrawDeficit(SK)).toBe(0);
    }
  });

  it('keeps at most 16 readings, this build\'s meters first', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    doc.getMap('stationKeeping').set('trim', trim({ fuelDrawn: 3 }));
    const junk = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`junk${i}`, 1]));
    doc.getMap('ship').set('fuel', { level: 25, meters: junk });
    writeFuelLevel(readFuelLevel(), 100);
    const { meters } = fuelRecord(doc);
    expect(Object.keys(meters!)).toHaveLength(16);
    expect(meters![SK]).toBe(3);
    expect(readFuelLevel()).toBe(22);
  });

  it('reads a peer\'s long meters and settlements once per record, and only their first 16 keys', () => {
    // Copilot's review of #173: every gauge or ceiling read walked the whole
    // peer-written object.
    const doc = new Y.Doc();
    bindRoom(doc);
    let gets = 0;
    const counted = <T extends object>(o: T): T => new Proxy(o, {
      get: (t, k, r) => {
        gets += 1;
        return Reflect.get(t, k, r);
      },
    });
    const long = (value: unknown) => Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`peer${i}`, value]));
    doc.getMap('ship').set('fuel', { level: 40, meters: counted({ ...long(1), [SK]: 9 }), settled: counted(long('x')) });
    for (let i = 0; i < 3; i++) {
      expect(readFuelLevel()).toBe(40);
      expect(fuelCeiling(SK)).toBe(40);
      expect(readFuelSettlement('peer0')).toBe('x');
      // Past the first 16 keys, nothing is read: not even this meter's own.
      expect(readFuelSettlement('peer16')).toBeUndefined();
    }
    expect(gets).toBeLessThanOrEqual(2 * 16);
  });

  it('tells ship subscribers when a meter is installed, replaced or removed', () => {
    // Copilot's review of #173: a gauge kept showing the fuel a removed
    // meter had drawn until something else changed.
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    let heard = 0;
    const unsubscribe = subscribeShip(() => {
      heard += 1;
    });
    const meter = (reading: number) => ({ read: () => reading, subscribe: () => () => {} });
    try {
      setFuelDrawMeter('test-other', meter(4));
      expect(heard).toBeGreaterThan(0);
      expect(readFuelLevel()).toBe(46);
      heard = 0;
      setFuelDrawMeter('test-other', meter(6));
      expect(heard).toBeGreaterThan(0);
      expect(readFuelLevel()).toBe(44);
      heard = 0;
      setFuelDrawMeter('test-other', null);
      expect(heard).toBeGreaterThan(0);
      expect(readFuelLevel()).toBe(50);
    } finally {
      unsubscribe();
      setFuelDrawMeter('test-other', null);
    }
  });

  it('refuses a meter name the record could not keep', () => {
    expect(() => setFuelDrawMeter('not a name', null)).toThrow();
    expect(() => setFuelDrawMeter('__proto__', null)).toThrow();
  });

  it('installs no more meters than the record keeps readings for, so none is charged twice', () => {
    // Copilot's review of #173: a 17th meter's reading was never recorded,
    // so every level write charged it again.
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(100, 100);
    press('raise', T0);
    const one = { read: () => 1, subscribe: () => () => {} };
    const names: string[] = [];
    try {
      // Station keeping's meter is one of the 16...
      for (let i = 0; i < 16; i++) {
        try {
          setFuelDrawMeter(`cap-${i}`, one);
        } catch {
          break;
        }
        names.push(`cap-${i}`);
      }
      expect(names).toHaveLength(15);
      // ...so the next is refused, while replacing one is not.
      expect(() => setFuelDrawMeter('cap-extra', one)).toThrow();
      expect(() => setFuelDrawMeter(names[0], one)).not.toThrow();
      // Every meter keeps a reading, so level writes charge each draw once.
      const gauge = readFuelLevel();
      expect(gauge).toBe(100 - 16);
      writeFuelLevel(gauge, 100);
      writeFuelLevel(readFuelLevel(), 100);
      expect(readFuelLevel()).toBe(gauge);
    } finally {
      for (const name of names) setFuelDrawMeter(name, null);
    }
  });

  it('a level write from a build from before the meters charges no draw twice', () => {
    // Copilot's review of #173: such a build writes the level alone, which
    // dropped the readings the level was written against.
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    press('raise', T0);
    press('ahead', T0 + BURN_MS);
    writeFuelLevel(readFuelLevel(), 100);
    const { level, ...parts } = fuelRecord(doc);
    expect(doc.getMap('ship').get('fuelCopy')).toEqual(parts);
    const settled = readFuelSettlement(SK);
    // Its DEPART takes a 10-unit trip off the level as written.
    doc.getMap('ship').set('fuel', { level: level - 10 });
    expect(readFuelLevel()).toBe(level - 10);
    expect(readFuelSettlement(SK)).toEqual(settled);
    expect(fuelCeiling(SK)).toBe(2 * TRIM_FUEL + level - 10);
  });

  it('keeps the settled orbit and every draw through level writes from a build from before the meters', () => {
    // Copilot's review of #173: once the next burn had cleared the burns a
    // level write settled, the settlement was their only account, and such
    // a write dropped it.
    const doc = new Y.Doc();
    const old = new Y.Doc(); // a tab on that build, fully synced
    bindRoom(doc);
    writeFuelLevel(50, 100);
    press('raise', T0);
    press('ahead', T0 + BURN_MS);
    writeFuelLevel(readFuelLevel(), 100);
    press('lower', T0 + 2 * BURN_MS);
    expect(doc.getMap('stationKeeping').size).toBe(1);
    const t = readOrbitTrim();
    const { level } = fuelRecord(doc);
    expect(readFuelLevel()).toBe(level - TRIM_FUEL);
    // That tab DEPARTs on a 10-unit trip, off the level as written...
    sync(doc, old);
    old.getMap('ship').set('fuel', { level: (old.getMap('ship').get('fuel') as FuelRecord).level - 10 });
    sync(doc, old);
    expect(readOrbitTrim()).toEqual(t);
    expect(readFuelDrawn()).toBe(3 * TRIM_FUEL);
    expect(readFuelLevel()).toBe(level - 10 - TRIM_FUEL);
    // ...and REFUELs: the burn since the last level write here comes off the
    // full tanks too (never a refund)...
    old.getMap('ship').set('fuel', { level: 100 });
    sync(doc, old);
    expect(readOrbitTrim()).toEqual(t);
    expect(readFuelLevel()).toBe(100 - TRIM_FUEL);
    // ...until a level write here records it, and keeps the readings again.
    writeFuelLevel(readFuelLevel(), 100);
    expect(fuelRecord(doc)).toMatchObject({ level: 100 - TRIM_FUEL, meters: { [SK]: 3 * TRIM_FUEL }, meter: 3 * TRIM_FUEL });
    expect(readOrbitTrim()).toEqual(t);
    expect(readFuelLevel()).toBe(100 - TRIM_FUEL);
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
    bindRoom(reload);
    expect(readOrbitTrim()).toEqual(t);
    expect(readFuelDrawn()).toBe(3 * TRIM_FUEL);
    expect(readFuelLevel()).toBe(100 - TRIM_FUEL);
  });

  it('reads a record that keeps readings of its own with them, and a copy that is no object as none', () => {
    const doc = new Y.Doc();
    bindRoom(doc);
    writeFuelLevel(50, 100);
    press('raise', T0);
    writeFuelLevel(readFuelLevel(), 100);
    // Another build's meter only: station keeping's whole reading comes off.
    doc.getMap('ship').set('fuel', { level: 30, meters: { stationMove: 4 } });
    expect(readFuelLevel()).toBe(30 - TRIM_FUEL);
    expect(readFuelSettlement(SK)).toBeUndefined();
    // A record from before per-meter readings is read against its sum.
    doc.getMap('ship').set('fuel', { level: 30, meter: TRIM_FUEL / 2 });
    expect(readFuelLevel()).toBe(30 - TRIM_FUEL / 2);
    for (const copy of ['x', [1], null, 5]) {
      doc.getMap('ship').set('fuelCopy', copy);
      doc.getMap('ship').set('fuel', { level: 30 });
      expect(readFuelLevel()).toBe(30 - TRIM_FUEL);
      expect(readFuelSettlement(SK)).toBeUndefined();
    }
  });
});

describe('another consumer drawing through its own meter (a station move, say)', () => {
  // It keeps its own running total under one key that each draw rewrites
  // whole, so an older total can win a merge; the tank reads each meter
  // against its own recorded reading.
  const OTHER = 'test-other';
  const bindAll = (doc: Y.Doc) => {
    bindRoom(doc);
    const map = doc.getMap('other');
    setFuelDrawMeter(OTHER, {
      read: () => (map.get('drawn') as number | undefined) ?? 0,
      subscribe: (listener) => {
        const f = () => listener();
        map.observe(f);
        return () => map.unobserve(f);
      },
    });
  };
  /** The other consumer draws `amount`: its own total, plus what its own
   *  meter owes the level, plus the draw. */
  const otherDraws = (doc: Y.Doc, amount: number) => {
    const map = doc.getMap('other');
    map.set('drawn', ((map.get('drawn') as number | undefined) ?? 0) + fuelDrawDeficit(OTHER) + amount);
  };
  afterEach(() => setFuelDrawMeter(OTHER, null));

  it('a trim burn after its draw counts only the burn', () => {
    const doc = new Y.Doc();
    bindAll(doc);
    writeFuelLevel(50, 100);
    otherDraws(doc, 7);
    expect(readFuelLevel()).toBe(50 - 7);
    press('raise', T0);
    expect(readFuelDrawn()).toBe(TRIM_FUEL);
    expect(readFuelLevel()).toBe(50 - 7 - TRIM_FUEL);
    writeFuelLevel(readFuelLevel(), 100);
    expect((doc.getMap('ship').get('fuel') as FuelRecord).meters).toEqual({ [SK]: TRIM_FUEL, [OTHER]: 7 });
  });

  it('a trim burn and its draw at once from two tabs both come off, whichever tab Yjs favours', () => {
    for (const [burner, other] of [[900, 100], [100, 900]]) {
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.clientID = burner;
      b.clientID = other;
      bindAll(a);
      writeFuelLevel(50, 100);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

      press('raise', T0);
      bindAll(b);
      otherDraws(b, 7);

      sync(a, b);
      expect(readFuelLevel()).toBe(50 - 7 - TRIM_FUEL);
      bindAll(a);
      expect(readFuelLevel()).toBe(50 - 7 - TRIM_FUEL);
    }
  });

  it('its meter going back neither refunds fuel nor lets its next draw go free', () => {
    const doc = new Y.Doc();
    bindAll(doc);
    // The level was written after 10 fuel of its draws; then an older total
    // (4) won a merge.
    doc.getMap('ship').set('fuel', { level: 40, meters: { [OTHER]: 10 } });
    doc.getMap('other').set('drawn', 4);
    expect(readFuelLevel()).toBe(40);
    expect(fuelDrawDeficit(OTHER)).toBe(10 - 4);
    otherDraws(doc, 7);
    expect(readFuelLevel()).toBe(40 - 7);
    expect(fuelDrawDeficit(OTHER)).toBe(0);
  });

  it('only the consumer whose meter went back owes it, so a trim burn beside it pays just the burn', () => {
    // Copilot's review of #173: with one reading for all meters, the trim
    // burn and the other draw each added the whole catch-up, and the tank
    // paid it twice.
    for (const [burner, other] of [[900, 100], [100, 900]]) {
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.clientID = burner;
      b.clientID = other;
      bindAll(a);
      a.getMap('ship').set('fuel', { level: 40, meters: { [OTHER]: 10 } });
      a.getMap('other').set('drawn', 4);
      expect(fuelDrawDeficit(SK)).toBe(0);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

      press('raise', T0);
      bindAll(b);
      otherDraws(b, 7);

      sync(a, b);
      expect(readFuelLevel()).toBe(40 - TRIM_FUEL - 7);
      bindAll(a);
      expect(readFuelLevel()).toBe(40 - TRIM_FUEL - 7);
    }
  });

  it('the ceiling on a meter is what the level covers beyond every other meter\'s draws since', () => {
    const doc = new Y.Doc();
    bindAll(doc);
    doc.getMap('ship').delete('fuel');
    expect(fuelCeiling(SK)).toBe(0);
    doc.getMap('ship').set('fuel', { level: 10, meters: { [SK]: 3, [OTHER]: 2 } });
    doc.getMap('other').set('drawn', 6);
    expect(fuelCeiling(SK)).toBe(3 + 10 - 4);
    expect(fuelCeiling(OTHER)).toBe(2 + 10);
    doc.getMap('other').set('drawn', 20);
    expect(fuelCeiling(SK)).toBe(3);
    // A record from before per-meter readings is read against their sum.
    doc.getMap('ship').set('fuel', { level: 10, meter: 5 });
    doc.getMap('other').set('drawn', 2);
    expect(fuelCeiling(SK)).toBe(5 + 10 - 2);
  });

  it('a meter only another build draws through keeps its recorded reading', () => {
    const doc = new Y.Doc();
    bindAll(doc);
    doc.getMap('ship').set('fuel', { level: 40, meters: { stationMove: 30 } });
    writeFuelLevel(35, 100);
    expect((doc.getMap('ship').get('fuel') as FuelRecord).meters).toEqual({ stationMove: 30 });
  });
});

describe('with a trim resolver installed (orbits.setStationTrimResolver)', () => {
  afterEach(() => setStationTrimResolver(null));

  it('stationOrbit flies the trim, and burns are still measured from the slot — never twice', () => {
    const t = trim({ dRadiusKm: -4, dPhase: 0.2 });
    const plan = () => planTrim(ctx({ trim: t, now: T0 + HOUR }), 'raise');
    const without = plan();
    setStationTrimResolver((station, slot) => (trimFor(station, t) ? trimmedOrbit(slot, t) : null));
    const want = trimmedOrbit(slotOrbit(STATION), t);
    expect(stationOrbit(STATION).radiusKm).toBeCloseTo(want.radiusKm, 9);
    expect(stationOrbit(STATION).phase0).toBeCloseTo(want.phase0, 9);
    expect(plan()).toEqual(without);
  });
});
