/**
 * 🪐 A planet with more station summaries than orbit slots: every install
 * lists the same learned stations there, whatever order the summaries came
 * in, owned ones first, and leaves room for its own stations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setStationTrimResolver } from './orbits';
import { registerLearnedStations, unbindPlanetSummaryForTest } from './planetSummary';
import type { StationSummary } from './planetSummary';
import { MAX_ORBIT_SLOTS, listStations, registerStation } from './stations';

// Each "install" is its own localStorage.
let store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const ARIS = 'planet-aris';
const T0 = Date.UTC(2026, 9, 3, 22, 0, 0);
const room = (i: number) => `room-${String(i).padStart(2, '0')}`;

const summary = (i: number, over: Partial<StationSummary> = {}): StationSummary => ({
  welcomeRoomId: room(i),
  name: `STATION ${i}`,
  planetId: ARIS,
  orbitSlot: i % MAX_ORBIT_SLOTS,
  updatedAt: T0 + i,
  ...over,
});

/** The welcome rooms of the learned stations this install lists at ARIS. */
const learnedAtAris = (): string[] => listStations()
  .filter((s) => s.planetId === ARIS && s.id.startsWith('shared:'))
  .map((s) => s.welcomeRoomId)
  .sort();

const rooms = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, k) => room(from + k));

beforeEach(() => {
  store = new Map();
  unbindPlanetSummaryForTest();
  setStationTrimResolver(null);
});
afterEach(() => {
  unbindPlanetSummaryForTest();
  setStationTrimResolver(null);
});

describe('a planet with more stations than slots', () => {
  const all = Array.from({ length: MAX_ORBIT_SLOTS + 2 }, (_, i) => summary(i));

  it('lists the same learned stations whatever order their summaries came in', () => {
    registerLearnedStations(ARIS, all);
    const first = learnedAtAris();
    store = new Map();
    registerLearnedStations(ARIS, [...all].reverse());
    expect(learnedAtAris()).toEqual(first);
    expect(first).toEqual(rooms(0, MAX_ORBIT_SLOTS));
  });

  it('drops a learned station an earlier order let in once higher-ranked ones arrive', () => {
    registerLearnedStations(ARIS, all.slice(MAX_ORBIT_SLOTS));
    expect(learnedAtAris()).toEqual(rooms(MAX_ORBIT_SLOTS, MAX_ORBIT_SLOTS + 2));
    expect(registerLearnedStations(ARIS, all)).toBeGreaterThan(0);
    expect(learnedAtAris()).toEqual(rooms(0, MAX_ORBIT_SLOTS));
    // Settled: nothing left to change.
    expect(registerLearnedStations(ARIS, all)).toBe(0);
  });

  it("ranks owned stations first and leaves room for this install's own", () => {
    registerStation({ id: 'own-a', name: 'OWN A', planetId: ARIS, orbitSlot: 0, welcomeRoomId: 'room-own-a' });
    registerStation({ id: 'own-b', name: 'OWN B', planetId: ARIS, orbitSlot: 1, welcomeRoomId: 'room-own-b' });
    const owned = [summary(80, { ownerId: 'x-80' }), summary(81, { ownerId: 'x-81' })];
    registerLearnedStations(ARIS, [...all, ...owned]);
    expect(learnedAtAris()).toEqual([...rooms(0, MAX_ORBIT_SLOTS - 4), room(80), room(81)]);
  });
});
