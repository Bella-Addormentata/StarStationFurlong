/**
 * 🛰️ Station keeping — which face the helm shows, the trimmed circular orbit
 * (Kepler stays honest: lower is faster), the burn planner's refusal ladder,
 * the burn log and its replay, the doc's guards, burns from two tabs (one of
 * them offline) both landing, and a burn's fuel surviving a REFUEL or DEPART
 * from another tab or another consumer's draw.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DoorRecord } from './doorsDoc';
import { ORBIT_EPOCH_MS, angleAt, orbitForSlot, setStationTrimResolver, stationOrbit, wrapAngle } from './orbits';
import {
  bindShipDoc,
  clampFuelToCapacity,
  fuelDrawDeficit,
  readFuelLevel,
  setFuelDrawMeter,
  subscribeShip,
  writeFuelLevel,
} from './shipDoc';
import type { FuelRecord } from './shipDoc';
import { DEFAULT_PLANET_ID } from './stations';
import {
  BURN_MS,
  MAX_TRIM_KM,
  PHASE_STEP_RAD,
  TRIM_FUEL,
  TRIM_STEP_KM,
  applyBurn,
  bindStationKeepingDoc,
  isBoltedIntoStation,
  isBurning,
  isOnStation,
  isOrbitTrim,
  isTrimBurn,
  planTrim,
  readFuelDrawn,
  readOrbitTrim,
  replayBurns,
  signedAngle,
  slotDriftPerHour,
  slotOffsetAt,
  slotOrbit,
  subscribeStationKeeping,
  trimFor,
  trimmedOrbit,
  writeTrimBurn,
} from './stationKeeping';
import type { OrbitTrim, TrimBurn, TrimContext, TrimDirection } from './stationKeeping';

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
  const plan = planTrim(ctx({ trim: readOrbitTrim(), fuel: readFuelLevel(), now }), dir);
  if (!plan.ok) throw new Error(`refused: ${plan.refusal}`);
  expect(writeTrimBurn(plan.burn)).toBe(true);
  return plan.burn;
}

/** Bind a room doc the way main.ts does. */
function bindRoom(doc: Y.Doc): void {
  bindShipDoc(doc);
  bindStationKeepingDoc(doc);
}

/** Two tabs trade everything they have. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

describe('which face the helm shows', () => {
  const gangway: DoorRecord = { paired: true, connectedRoomAddress: 'seed-a' };
  const dock: DoorRecord = {
    paired: true,
    connectedRoomAddress: 'seed-b',
    segments: [
      { kind: 'dock' } as never,
      { kind: 'dock' } as never,
    ],
  };
  const guestBerth: DoorRecord = { paired: true, connectedRoomAddress: 'seed-c', transient: true };
  const retired: DoorRecord = { paired: false, retiredAddress: 'seed-d' };

  it('a gangway bolts the module into a station', () => {
    expect(isBoltedIntoStation([gangway])).toBe(true);
    expect(isBoltedIntoStation([dock, gangway])).toBe(true);
  });

  it('docks, guest berths and retired doors leave it a ship', () => {
    expect(isBoltedIntoStation([])).toBe(false);
    expect(isBoltedIntoStation([dock])).toBe(false);
    expect(isBoltedIntoStation([guestBerth, retired, dock])).toBe(false);
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

  it('refuses in the helm\'s order: bolted, station, commander, thrusters, fuel, burning, limit', () => {
    expect(planTrim(ctx({ bolted: false, station: null }), 'raise')).toEqual({ ok: false, refusal: 'not-bolted' });
    expect(planTrim(ctx({ station: null, commander: false }), 'raise')).toEqual({ ok: false, refusal: 'no-station' });
    expect(planTrim(ctx({ commander: false, engines: 0 }), 'raise')).toEqual({ ok: false, refusal: 'not-commander' });
    expect(planTrim(ctx({ engines: 0, fuel: 0 }), 'raise')).toEqual({ ok: false, refusal: 'no-thrusters' });
    expect(planTrim(ctx({ fuel: TRIM_FUEL - 0.5 }), 'raise')).toEqual({ ok: false, refusal: 'no-fuel' });
    expect(planTrim(ctx({ fuel: Number.NaN }), 'raise')).toEqual({ ok: false, refusal: 'no-fuel' });
    expect(planTrim(ctx({ trim: trim({ at: T0 - 100 }) }), 'raise')).toEqual({ ok: false, refusal: 'burning' });
    expect(planTrim(ctx({ trim: trim({ dRadiusKm: MAX_TRIM_KM, at: T0 - BURN_MS }) }), 'raise'))
      .toEqual({ ok: false, refusal: 'at-limit' });
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
    expect(replayBurns(run)).toEqual({ trim: t, fuelDrawn: run.length * TRIM_FUEL });
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

  it('a burn past the band changes nothing but still pays', () => {
    const start = trim({ dRadiusKm: MAX_TRIM_KM - TRIM_STEP_KM, at: T0 - HOUR });
    const out = replayBurns([burnAt(T0, 'raise'), burnAt(T0 + 1_000, 'raise')], start, 5);
    expect(out.trim).toEqual(applyBurn(start, burnAt(T0, 'raise')));
    expect(out.trim!.dRadiusKm).toBe(MAX_TRIM_KM);
    expect(out.fuelDrawn).toBe(5 + 2 * TRIM_FUEL);
  });

  it('a burn that arrives late never makes an earlier one free: the fuel only grows', () => {
    const start = trim({ dRadiusKm: MAX_TRIM_KM - TRIM_STEP_KM, at: T0 - HOUR });
    const later = burnAt(T0 + 1_000, 'raise');
    const late = burnAt(T0, 'raise');
    expect(replayBurns([later], start).trim!.at).toBe(later.at);
    // The late one takes the last step, so the later one is now past the band.
    const both = replayBurns([later, late], start);
    expect(both.trim!.at).toBe(late.at);
    expect(both.fuelDrawn).toBe(2 * TRIM_FUEL);
  });

  it('a burn on another planet or slot starts from its slot, and the next one back starts over', () => {
    const out = replayBurns([
      burnAt(T0, 'raise'),
      burnAt(T0 + 1_000, 'raise', { planetId: 'planet-aris', slot: 3 }),
      burnAt(T0 + 2_000, 'lower'),
    ]);
    expect(out.trim).toMatchObject({ planetId: SOV, slot: 0, dRadiusKm: -TRIM_STEP_KM });
    expect(out.fuelDrawn).toBe(3 * TRIM_FUEL);
  });
});

describe('the burn log in the room doc', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = new Y.Doc();
    bindStationKeepingDoc(doc);
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
    bindShipDoc(doc);
    writeFuelLevel(10, 100);
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
    press('lower', T0 + BURN_MS);
    expect(readFuelLevel()).toBe(10 - 2 * TRIM_FUEL - 3);
    expect(readOrbitTrim()).toMatchObject({ dRadiusKm: 0, last: 'lower' });
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
    press('raise', T0);
    press('raise', T0 + BURN_MS);
    writeFuelLevel(readFuelLevel(), 100);
    expect(fuelRecord(doc)).toEqual({ level: 30 - 2 * TRIM_FUEL, meters: { [SK]: 2 * TRIM_FUEL }, meter: 2 * TRIM_FUEL });
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

  it('refuses a meter name the record could not keep', () => {
    expect(() => setFuelDrawMeter('not a name', null)).toThrow();
    expect(() => setFuelDrawMeter('__proto__', null)).toThrow();
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
