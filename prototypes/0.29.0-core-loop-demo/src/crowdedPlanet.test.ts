/**
 * 🪐 A planet with more station summaries than orbit slots: every install
 * lists the same learned stations there, whatever order the summaries came
 * in, owned ones first, and leaves room for its own stations. That holds
 * when there are more than the install keeps, too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setStationTrimResolver } from './orbits';
import { bindPlanetSummaryDoc, registerLearnedStations, unbindPlanetSummaryForTest } from './planetSummary';
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

describe('a planet with more summaries than this install keeps', () => {
  it('lists the highest-ranked stations even when their stamps are the oldest', () => {
    registerStation({ id: 'own-aris', name: 'OWN', planetId: ARIS, orbitSlot: 0, welcomeRoomId: 'room-own' });
    // Another install's room doc: 80 summaries at ARIS (more than the 64 a
    // store keeps), the 20 highest-ranked heard an hour ago, the rest just now.
    const now = Date.now();
    const peer = new Y.Doc();
    for (let i = 0; i < 80; i++) {
      peer.getMap('stationSummaries').set(room(i), summary(i, { updatedAt: i < 20 ? now - 3_600_000 + i : now - 60_000 + i }));
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    bindPlanetSummaryDoc(doc, {
      currentStation: () => listStations().find((s) => s.id === 'own-aris') ?? null,
      localTrim: () => null,
      ship: () => null,
    });
    // This install's own station takes one slot.
    expect(learnedAtAris()).toEqual(rooms(0, MAX_ORBIT_SLOTS - 1));
    // The room doc keeps them too, for the next install to hear.
    for (const r of rooms(0, MAX_ORBIT_SLOTS - 1)) expect(doc.getMap('stationSummaries').has(r)).toBe(true);
  });

  it("drops a learned station whose summary is gone once its planet's summaries are the whole set", () => {
    const all = Array.from({ length: 3 }, (_, i) => summary(i));
    registerLearnedStations(ARIS, all);
    expect(learnedAtAris()).toEqual(rooms(0, 3));
    // Not the whole set (this client's planet unknown): it stays.
    registerLearnedStations(ARIS, all.slice(1));
    expect(learnedAtAris()).toEqual(rooms(0, 3));
    expect(registerLearnedStations(ARIS, all.slice(1), { prune: true })).toBe(1);
    expect(learnedAtAris()).toEqual(rooms(1, 3));
  });
});
