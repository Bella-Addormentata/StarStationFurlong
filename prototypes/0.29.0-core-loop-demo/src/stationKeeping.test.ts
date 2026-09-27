/**
 * 🛰️ Station keeping — which face the helm shows, the trimmed circular orbit
 * (Kepler stays honest: lower is faster), the burn planner's refusal ladder,
 * the doc record's guards, and two owners burning at once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DoorRecord } from './doorsDoc';
import { ORBIT_EPOCH_MS, angleAt, orbitForSlot, wrapAngle } from './orbits';
import { bindShipDoc, readFuelLevel, writeFuelLevel } from './shipDoc';
import { DEFAULT_PLANET_ID } from './stations';
import {
  BURN_MS,
  MAX_TRIM_KM,
  PHASE_STEP_RAD,
  TRIM_FUEL,
  TRIM_STEP_KM,
  bindStationKeepingDoc,
  isBoltedIntoStation,
  isBurning,
  isOnStation,
  isOrbitTrim,
  planTrim,
  readOrbitTrim,
  signedAngle,
  slotDriftPerHour,
  slotOffsetAt,
  slotOrbit,
  subscribeStationKeeping,
  trimFor,
  trimmedOrbit,
  writeOrbitTrim,
} from './stationKeeping';
import type { OrbitTrim, TrimContext, TrimDirection } from './stationKeeping';

const SOV = DEFAULT_PLANET_ID;
const STATION = { id: 'furlong-station', planetId: SOV, orbitSlot: 0 };
const T0 = Date.UTC(2026, 8, 27, 5, 0, 0);
const HOUR = 3600 * 1000;
const DEG = Math.PI / 180;

const trim = (over: Partial<OrbitTrim> = {}): OrbitTrim => ({
  planetId: SOV,
  slot: 0,
  dRadiusKm: 0,
  dPhase: 0,
  at: T0,
  last: 'raise',
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

/** Apply one burn and return its record (fails the test on a refusal). */
function burn(c: TrimContext, dir: TrimDirection): OrbitTrim {
  const plan = planTrim(c, dir);
  if (!plan.ok) throw new Error(`refused: ${plan.refusal}`);
  return plan.trim;
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

  it('a record for another planet or slot is ignored — the burn starts from the slot', () => {
    for (const stray of [
      trim({ planetId: 'planet-aris', dRadiusKm: 10, dPhase: 1, at: T0 - BURN_MS }),
      trim({ slot: 2, dRadiusKm: 10, dPhase: 1, at: T0 - BURN_MS }),
    ]) {
      const t = burn(ctx({ trim: stray }), 'raise');
      expect(t).toMatchObject({ planetId: SOV, slot: 0, dRadiusKm: TRIM_STEP_KM, dPhase: 0 });
    }
  });

  it('writes the planet as orbits.ts resolves it', () => {
    const t = burn(ctx({ station: { planetId: 'planet-nowhere', orbitSlot: 0 } }), 'raise');
    expect(t.planetId).toBe(SOV);
  });

  it('wraps the phase offset into (−π, π]', () => {
    const t = burn(ctx({ trim: trim({ dPhase: Math.PI - PHASE_STEP_RAD / 2, at: T0 - BURN_MS }) }), 'ahead');
    expect(t.dPhase).toBeLessThan(0);
    expect(wrapAngle(t.dPhase)).toBeCloseTo(Math.PI + PHASE_STEP_RAD / 2, 12);
  });

  it('every planned record passes the doc guard', () => {
    let t: OrbitTrim | null = null;
    let now = T0;
    for (const dir of ['raise', 'ahead', 'lower', 'back', 'lower', 'lower'] as TrimDirection[]) {
      t = burn(ctx({ trim: t, now }), dir);
      expect(isOrbitTrim(t)).toBe(true);
      now += BURN_MS + 30 * 60_000;
    }
  });
});

describe('the doc record', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = new Y.Doc();
    bindStationKeepingDoc(doc);
  });

  it('round-trips a burn and notifies subscribers', () => {
    let calls = 0;
    const off = subscribeStationKeeping(() => { calls++; });
    const t = trim({ dRadiusKm: 4, dPhase: 0.01 });
    expect(writeOrbitTrim(t)).toBe(true);
    expect(readOrbitTrim()).toEqual(t);
    expect(calls).toBeGreaterThan(0);
    off();
  });

  it('runs the fuel debit in the same transaction as the burn', () => {
    const seen: string[][] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      seen.push([...tr.changed.keys()].map((m) => ((m as unknown) === doc.getMap('ship') ? 'ship' : 'keep')));
    });
    writeOrbitTrim(trim(), () => { doc.getMap('ship').set('fuel', { level: 9 }); });
    expect(seen).toHaveLength(1);
    expect(seen[0].sort()).toEqual(['keep', 'ship']);
  });

  it('reads nothing hostile', () => {
    const map = doc.getMap('stationKeeping');
    const hostile: unknown[] = [
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
    ];
    for (const value of hostile) {
      map.set('trim', value);
      expect(readOrbitTrim()).toBeNull();
    }
  });

  it('strips unknown fields on read and refuses to write a malformed record', () => {
    doc.getMap('stationKeeping').set('trim', { ...trim(), extra: 'x'.repeat(10) });
    expect(readOrbitTrim()).toEqual(trim());
    expect(writeOrbitTrim({ ...trim(), dRadiusKm: 99 })).toBe(false);
    expect(readOrbitTrim()).toEqual(trim());
  });

  it('reads null from a destroyed doc', () => {
    writeOrbitTrim(trim());
    doc.destroy();
    expect(readOrbitTrim()).toBeNull();
    expect(writeOrbitTrim(trim())).toBe(false);
  });
});

describe('two owners burning at once', () => {
  it('converge on one burn and that burn\'s debit: nothing lands free', () => {
    // Both clients start from the same room state: 5 fuel, no trim yet.
    const a = new Y.Doc();
    const b = new Y.Doc();
    bindShipDoc(a);
    writeFuelLevel(5, 100);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Each burns without having seen the other's burn.
    const fire = (doc: Y.Doc, dir: TrimDirection, now: number): OrbitTrim => {
      bindShipDoc(doc);
      bindStationKeepingDoc(doc);
      const c = ctx({ fuel: readFuelLevel(), now });
      const t = burn(c, dir);
      expect(writeOrbitTrim(t, () => writeFuelLevel(c.fuel - TRIM_FUEL, 100))).toBe(true);
      return t;
    };
    const ta = fire(a, 'raise', T0);
    const tb = fire(b, 'ahead', T0 + 40);

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const settled = (doc: Y.Doc) => {
      bindShipDoc(doc);
      bindStationKeepingDoc(doc);
      return { trim: readOrbitTrim(), fuel: readFuelLevel() };
    };
    const sa = settled(a);
    const sb = settled(b);
    // Both replicas agree, the trim is one whole burn (not a blend of two),
    // and exactly one burn's fuel is gone.
    expect(sa).toEqual(sb);
    expect([ta, tb]).toContainEqual(sa.trim);
    expect(sa.fuel).toBe(5 - TRIM_FUEL);
  });
});
