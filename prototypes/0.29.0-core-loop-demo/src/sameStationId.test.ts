/**
 * 🪐 Station ids are each install's own, so two installs can save one place
 * under one id and still disagree about it. Which install's record of a
 * place stands is settled by the installs' own ids (ownerInstall), never by
 * that shared station id; and a station id from before ids were portable
 * names a place only when every record known under it is of that place.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setStationTrimResolver } from './orbits';
import {
  bindPlanetSummaryDoc,
  cleanStationSummary,
  mergeStation,
  publishPlanetSummary,
  registerLearnedStations,
  resolveStationAlias,
  unbindPlanetSummaryForTest,
} from './planetSummary';
import type { StationSummary } from './planetSummary';
import { DEFAULT_PLANET_ID, listStations, registerStation } from './stations';
import type { StationRecord } from './stations';

// Each install is its own localStorage.
let store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const SOV = DEFAULT_PLANET_ID;
const T0 = Date.UTC(2026, 9, 3, 23, 0, 0);

const summary = (over: Partial<StationSummary> = {}): StationSummary => ({
  welcomeRoomId: 'room-hab', name: 'HAB', planetId: SOV, orbitSlot: 2, ownerId: 'hab', updatedAt: T0, ...over,
});

const hab = (over: Partial<StationRecord> = {}): StationRecord => ({
  id: 'hab', name: 'HAB', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'room-hab', ...over,
});

beforeEach(() => {
  store = new Map();
  unbindPlanetSummaryForTest();
  setStationTrimResolver(null);
});
afterEach(() => {
  unbindPlanetSummaryForTest();
  setStationTrimResolver(null);
});

describe('two installs that saved one place under one station id', () => {
  it('settle by install: the smaller one stands in either order, past any newer republish', () => {
    const a = summary({ ownerInstall: 'install-a', orbitSlot: 2 });
    const b = summary({ ownerInstall: 'install-b', orbitSlot: 5, updatedAt: T0 + 50 });
    expect((mergeStation(a, b) ?? a).orbitSlot).toBe(2);
    const settled = mergeStation(b, a)!;
    expect(settled.orbitSlot).toBe(2);
    expect(mergeStation(settled, { ...b, updatedAt: T0 + 5000 })).toBeNull();
  });

  it("let one install's newer record stand, whatever station id it now goes by", () => {
    const old = summary({ ownerInstall: 'install-a', name: 'OLD' });
    const renamed = summary({ ownerInstall: 'install-a', ownerId: 'hab-2', name: 'NEW', updatedAt: T0 + 1 });
    const next = mergeStation(old, renamed);
    expect(next?.name).toBe('NEW');
    // Its earlier id stays known for the place.
    expect(next?.ownerAliases).toEqual(['hab']);
  });

  it('keep the install beside the station id, and nowhere else', () => {
    const b = summary({ ownerInstall: 'install-b' });
    const merged = mergeStation(b, summary({ ownerInstall: 'install-a' })) ?? b;
    expect(merged.ownerInstall).toBe('install-a');
    expect(JSON.stringify(cleanStationSummary(merged, T0))).toBe(JSON.stringify(merged));
    expect(cleanStationSummary({ ...summary({ ownerId: undefined }), ownerInstall: 'install-a' }, T0)).not.toHaveProperty('ownerInstall');
    expect(cleanStationSummary({ ...merged, ownerInstall: 7 }, T0)).not.toHaveProperty('ownerInstall');
  });

  it('register the same station and stop republishing, whichever visits the room first', () => {
    for (const aFirst of [true, false]) {
      const a = { store: new Map<string, string>(), id: 'install-a' };
      const b = { store: new Map<string, string>(), id: 'install-b' };
      store = a.store;
      registerStation(hab({ name: 'HAB A', orbitSlot: 2 }));
      store = b.store;
      registerStation(hab({ name: 'HAB B', orbitSlot: 5 }));
      const room = new Y.Doc();
      // One visit: the install's own storage and a fresh copy of the room
      // doc, bound (it pulls, then publishes), and a later heartbeat
      // publish; what it wrote goes back to the room.
      const visit = (i: typeof a, at?: number) => {
        unbindPlanetSummaryForTest();
        store = i.store;
        const replica = new Y.Doc();
        Y.applyUpdate(replica, Y.encodeStateAsUpdate(room));
        bindPlanetSummaryDoc(replica, {
          currentStation: () => listStations().find((s) => s.id === 'hab') ?? null,
          localTrim: () => null,
          ship: () => null,
          installId: () => i.id,
        });
        if (at !== undefined) publishPlanetSummary(at);
        Y.applyUpdate(room, Y.encodeStateAsUpdate(replica));
      };
      const listed = (i: typeof a) => {
        store = i.store;
        const st = listStations().find((s) => s.id === 'hab');
        return { name: st?.name, orbitSlot: st?.orbitSlot };
      };
      const [x, y] = aFirst ? [a, b] : [b, a];
      visit(x);
      visit(y);
      visit(x);
      const settled = room.getMap('stationSummaries').toJSON();
      for (let round = 1; round <= 3; round++) {
        visit(y, Date.now() + round * 2000);
        visit(x, Date.now() + round * 2000 + 1000);
      }
      expect(room.getMap('stationSummaries').toJSON()).toEqual(settled);
      expect(listed(a)).toEqual(listed(b));
      expect(listed(a).name).toBe((settled['room-hab'] as StationSummary).name);
      expect((settled['room-hab'] as StationSummary).ownerInstall).toBe('install-a');
    }
  });
});

describe('a station id from before ids were portable', () => {
  const learn = (...summaries: StationSummary[]) => {
    store.set('ssf-planet-summary', JSON.stringify({
      stations: Object.fromEntries(summaries.map((s) => [s.welcomeRoomId, s])), ships: {},
    }));
    registerLearnedStations(SOV, summaries);
  };

  it('stays unresolved when records of two places carry it', () => {
    learn(
      summary({ welcomeRoomId: 'room-a', ownerInstall: 'install-a' }),
      summary({ welcomeRoomId: 'room-b', ownerInstall: 'install-b', orbitSlot: 3 }),
    );
    expect(listStations().map((s) => s.id)).toEqual(expect.arrayContaining(['shared:room-a', 'shared:room-b']));
    expect(resolveStationAlias('hab')).toBeNull();
  });

  it("stays unresolved when this install's own station of another place has it", () => {
    registerStation(hab({ welcomeRoomId: 'room-b', orbitSlot: 3 }));
    learn(summary({ welcomeRoomId: 'room-a', ownerInstall: 'install-a' }));
    expect(listStations().some((s) => s.id === 'shared:room-a')).toBe(true);
    expect(resolveStationAlias('hab')).toBeNull();
  });

  it('resolves when every record known under it is of one place', () => {
    registerStation(hab());
    learn(
      summary({ ownerInstall: 'install-a' }),
      summary({ welcomeRoomId: 'room-c', ownerId: 'yard', ownerAliases: ['old-yard'], orbitSlot: 4 }),
    );
    expect(resolveStationAlias('hab')).toBe('hab');
    expect(resolveStationAlias('yard')).toBe('shared:room-c');
    expect(resolveStationAlias('old-yard')).toBe('shared:room-c');
    expect(resolveStationAlias('nobody')).toBeNull();
  });
});
