/**
 * 🔒 A station's extra fields never carry a room's dial-in credentials,
 * whatever they are called: a pass (base64 JSON, as main.ts writes one), a
 * link with a seed in it, or a field named for a room key goes, at any
 * depth, both in what arrives and in what this install sends.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setStationTrimResolver } from './orbits';
import { bindPlanetSummaryDoc, cleanStationSummary, unbindPlanetSummaryForTest } from './planetSummary';
import type { StationSummary } from './planetSummary';
import { DEFAULT_PLANET_ID, listStations, registerStation } from './stations';

let store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const SOV = DEFAULT_PLANET_ID;
const T0 = Date.UTC(2026, 9, 3, 22, 30, 0);
const ROOM_KEY = '9cFoJclYIhraidhP4jdVH8G9uY2kcVCp8edFcPURP58';
/** A pass in the shape main.ts's encodeBootstrapSeed writes. */
const PASS = btoa(JSON.stringify({ v: 2, roomId: 'home-hab', roomKeyB64: ROOM_KEY, wtUrl: 'https://127.0.0.1:4443' }));
const LINK = `ssf://room?seed=${encodeURIComponent(PASS)}`;

const summary = (ext: Record<string, unknown>): StationSummary => ({
  welcomeRoomId: 'room-hab', name: 'HAB RING', planetId: SOV, orbitSlot: 2, ext, updatedAt: T0,
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

describe("a station's extra fields", () => {
  it('lose a pass under any name, at any depth, in a list or as a key', () => {
    const s = cleanStationSummary(summary({
      address: PASS,
      padded: ` ${PASS.replace(/=+$/, '')} `,
      list: ['ok', PASS],
      rooms: { [PASS]: 1, plain: 2 },
      // Not credentials: a gate's access mode, a hex id, a plain word.
      access: 'pass',
      hash: 'deadbeefcafef00d',
      mode: 'tug',
    }), T0);
    expect(s?.ext).toEqual({ list: ['ok'], rooms: { plain: 2 }, access: 'pass', hash: 'deadbeefcafef00d', mode: 'tug' });
  });

  it('lose a link or a line carrying a seed or key, JSON text holding one, and a field named for a room key', () => {
    const s = cleanStationSummary(summary({
      note: `come aboard: ${LINK}`,
      dock: { gate: 3, via: LINK },
      line: `roomKey=${ROOM_KEY}`,
      json: JSON.stringify({ roomId: 'home-hab', roomKeyB64: ROOM_KEY }),
      roomKeyB64: ROOM_KEY,
      // Not credentials: an ordinary link, JSON text without one.
      site: 'https://example.com/station?view=map',
      layout: JSON.stringify({ gates: [1, 2] }),
    }), T0);
    expect(s?.ext).toEqual({
      dock: { gate: 3 }, site: 'https://example.com/station?view=map', layout: JSON.stringify({ gates: [1, 2] }),
    });
  });

  it("never go out carrying this install's pass", () => {
    registerStation({ id: 'hab', name: 'HAB RING', planetId: SOV, orbitSlot: 2, welcomeRoomId: 'room-hab', address: PASS, beacon: { color: 'amber' } } as Parameters<typeof registerStation>[0]);
    const doc = new Y.Doc();
    bindPlanetSummaryDoc(doc, {
      currentStation: () => listStations().find((st) => st.id === 'hab') ?? null,
      localTrim: () => null,
      ship: () => null,
    });
    const sent = JSON.stringify(doc.getMap('stationSummaries').toJSON());
    expect(sent).toContain('amber');
    expect(sent).not.toContain(PASS.slice(0, 24));
  });
});
