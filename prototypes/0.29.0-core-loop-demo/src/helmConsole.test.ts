// devices.ts tests: what the HELM console (createHelmUI) shows a commander,
// and what one render reads to show it. The panel is only a string of
// markup, so a stand-in for the little of the DOM render() touches is
// enough; DEPART is clicked through the listener render() wired to it.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { FURNITURE } from './furniture';
import type { FurnitureItem } from './furniture';
import { dockChain } from './adapter';
import { classifyDockPort } from './dockRules';
import { bindDoorLayoutDoc, seedDoorLayoutEmpty, seedDoorLayoutSingle } from './doorLayoutDoc';
import {
  bindDoorsDoc, buildDoorPairing, buildDoorTombstone, readDoor, writeDoorPairing, writeDoorRecordTo,
  type DoorRecord,
} from './doorsDoc';
import { bindShipDoc, readFlightRecord, writeFuelLevel } from './shipDoc';
import {
  DEFAULT_STATIONS, TRAVEL_MS_MIN, directoryFromStationRecords, setStationDirectory, setStationRoomCheck,
} from './stationDirectory';
import { DEFAULT_PLANET_ID, registerStation, setStationRoomSource } from './stations';
import type { HelmDockingDeps } from './devices';

// devices.ts hangs debug handles on window as it loads.
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
let createHelmUI: typeof import('./devices').createHelmUI;
let noteShipArrival: typeof import('./devices').noteShipArrival;
let clearShipArrivalNote: typeof import('./devices').clearShipArrivalNote;
beforeAll(async () => {
  ({ createHelmUI, noteShipArrival, clearShipArrivalNote } = await import('./devices'));
  vi.stubGlobal('document', { activeElement: null, createElement: () => (panel = fakePanel()) });
});

/** The helm's panel: its markup as a string. An element exists when its id
 *  is in the markup, and the listeners render() wires are kept by selector,
 *  so a test can click them. */
function fakePanel() {
  const wired = new Map<string, () => void>();
  const p = {
    id: '',
    style: { cssText: '' },
    innerHTML: '',
    addEventListener: () => {},
    contains: () => false,
    remove: () => {},
    querySelectorAll: () => [],
    querySelector: (sel: string) => p.innerHTML.includes(`id="${sel.slice(1)}"`)
      ? { addEventListener: (_type: string, fn: () => void) => { wired.set(sel, fn); }, getContext: () => null }
      : null,
    click: (sel: string) => wired.get(sel)?.(),
  };
  return p;
}
let panel: ReturnType<typeof fakePanel>;

/** Open the helm (it renders once), hand its panel to `use`, close it. */
function withHelm<T>(use: (p: typeof panel) => T, docking?: HelmDockingDeps): T {
  const ui = createHelmUI(docking);
  ui.mount({ appendChild: () => {} } as unknown as HTMLElement);
  try {
    return use(panel);
  } finally {
    ui.unmount();
  }
}
const renderHelm = (docking?: HelmDockingDeps) => withHelm((p) => p.innerHTML, docking);
const departDisabled = (html: string) => html.includes('id="helm-depart-btn" disabled');

const STATION_CORE = 'ssf://room#room=station-core';
const VISITOR = 'ssf://room#room=visitor';
const JUNK = 'ssf://room#room=junk';

/** doorsDoc's read cap (MAX_PAIRINGS): its snapshot keeps the first 64 valid
 *  records, in the order they were written. */
const READ_CAP = 64;

const fitting = (kind: string): FurnitureItem =>
  ({ id: kind, kind: kind as FurnitureItem['kind'], pos: { x: 0, z: 0 }, rot: 0, movable: true });
let saved: FurnitureItem[] = [];
let doc: Y.Doc;

// Saved station records live in localStorage.
let store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

/** A peer's flood: READ_CAP valid records, written ahead of anything real. */
function flood(record: DoorRecord): void {
  for (let i = 0; i < READ_CAP; i++) writeDoorRecordTo(doc, `d:flood-${i}`, record);
}

/** A visiting ship's dock: a guest berth, never structure. */
const DOCKED = { segments: dockChain(), transient: true, dockedAt: 1000 };

beforeEach(() => {
  // A fitted ship, tanks full, docked at home (the static table).
  saved = FURNITURE.splice(0, FURNITURE.length, fitting('engine-block'), fitting('fuel-tank'), fitting('helm-console'));
  doc = new Y.Doc();
  bindShipDoc(doc);
  bindDoorsDoc(doc);
  bindDoorLayoutDoc(doc); // unseeded: the four default doors
  writeFuelLevel(100, 100);
});
afterEach(() => {
  FURNITURE.splice(0, FURNITURE.length, ...saved);
  setStationDirectory(null);
  setStationRoomCheck(null);
  setStationRoomSource(() => '');
  store = new Map();
  clearShipArrivalNote();
});

describe('the helm, its doors map flooded past the read cap', () => {
  it('still refuses DEPART for a gangway on one of the default doors', () => {
    // The flood alone never stops a departure.
    flood(buildDoorPairing(JUNK, { transient: true }));
    expect(departDisabled(renderHelm())).toBe(false);
    writeDoorPairing('north', STATION_CORE);
    const html = renderHelm();
    expect(html).toContain('1 permanent link — cannot fly');
    expect(departDisabled(html)).toBe(true);
    // The status says what holds it too, never how to depart.
    expect(html).toContain('ALL SYSTEMS FITTED — but this module is chained to 1 permanent connector');
    expect(html).not.toContain('Pick a destination and DEPART');
  });

  it('still refuses DEPART for a gangway on a placed door', () => {
    seedDoorLayoutSingle('x+', 0, 'd:gangway');
    flood(buildDoorPairing(JUNK, { transient: true }));
    writeDoorPairing('d:gangway', STATION_CORE);
    const html = renderHelm();
    expect(html).toContain('1 permanent link — cannot fly');
    expect(departDisabled(html)).toBe(true);
  });

  it("releases a real door's dock at DEPART", async () => {
    vi.useFakeTimers();
    try {
      flood(buildDoorPairing(JUNK, { transient: true }));
      writeDoorPairing('north', VISITOR, DOCKED);
      withHelm((p) => p.click('#helm-depart-btn'));
      // DEPART casts off first, under the shared cast-off hold, and departs
      // once every berth has let go (each a tombstone of its release).
      await vi.advanceTimersByTimeAsync(5_000);
      expect(readFlightRecord().status).toBe('in-flight');
      expect(readDoor('north')).toMatchObject({ paired: false, retiredAddress: VISITOR });
      // The flood's pairings, on doors the room lacks, went with it.
      expect(readDoor('d:flood-0')).toMatchObject({ paired: false, retiredAddress: JUNK });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still sees a live dock on a real door, and so where the ship is', () => {
    // The docks lead into High Orbit; the flight record still says home.
    setStationDirectory({ stations: () => DEFAULT_STATIONS, here: () => 'high-orbit' });
    flood(buildDoorTombstone(JUNK));
    writeDoorPairing('north', VISITOR, DOCKED);
    expect(renderHelm()).toContain('LOCATION</span><span>High Orbit</span>');
  });
});

describe('the helm, on doors the room does not have', () => {
  it('never counts a gangway or a dock on a door the room does not have', () => {
    // A doorless room (its owner removed every door): no record holds it.
    seedDoorLayoutEmpty();
    writeDoorPairing('d:ghost', STATION_CORE);
    writeDoorPairing('north', STATION_CORE);
    const html = renderHelm();
    expect(departDisabled(html)).toBe(false);
    expect(html).not.toContain('permanent link');
    // Nor is it docked anywhere: a dock on no door leads nowhere.
    setStationDirectory({ stations: () => DEFAULT_STATIONS, here: () => 'high-orbit' });
    writeDoorPairing('d:ghost-dock', VISITOR, DOCKED);
    expect(renderHelm()).not.toContain('LOCATION</span><span>High Orbit</span>');
  });
});

describe('one render of the helm', () => {
  it('reads the station list once, however many hops it plans', () => {
    // A full planet: sixteen stations, so fifteen hops to plan.
    const records = Array.from({ length: 16 }, (_, i) => ({
      id: `st-${i}`, name: `ST ${i}`, planetId: 'planet-sovereign', orbitSlot: i, welcomeRoomId: `room-${i}`,
    }));
    let reads = 0;
    setStationDirectory(directoryFromStationRecords(() => { reads++; return records; }, () => undefined, () => null));
    const html = renderHelm();
    expect(reads).toBe(1);
    // …and still shows every hop it planned.
    expect(html.match(/<option /g)).toHaveLength(15);
    expect(html).not.toContain('no transfer from here');
    // Read afresh on the next render, never kept from the last.
    renderHelm();
    expect(reads).toBe(2);
  });
});

describe("the helm's arrival note", () => {
  it('names every reason no dock port could dock, not only a missing port', () => {
    noteShipArrival({ kind: 'none', stationName: 'High Orbit', reason: 'no-port' });
    const note = /Arrived at High Orbit — [^<]*/.exec(renderHelm())?.[0] ?? '';
    expect(note).toMatch(/fit/i);
    expect(note).toMatch(/busy/);
    expect(note).toMatch(/not yours/);
  });
});

describe("a fitted station room's helm", () => {
  /** A docking computer with one port, a visiting ship docked at it. */
  const shipDocked: HelmDockingDeps = {
    ports: () => [{
      doorId: 'north', label: 'DOOR 1', partnerName: 'VISITOR', canOperate: true, busy: false,
      state: classifyDockPort(buildDoorPairing(VISITOR, DOCKED)),
    }],
    connected: () => [],
    subscribe: () => () => {},
    undock: () => {},
    dock: () => {},
  };

  it("is placed at its own station, never at an empty ship record's default", () => {
    // A one-module station wearing ship fittings: its room is its station's,
    // as the holotable and the room resolver place it (followsFlightRecord).
    registerStation({ id: 'aris', name: 'ARIS', planetId: DEFAULT_PLANET_ID, orbitSlot: 3, welcomeRoomId: 'room-aris' });
    setStationRoomSource(() => 'room-aris');
    setStationDirectory({
      stations: () => [...DEFAULT_STATIONS, { id: 'aris', name: 'ARIS', planetId: DEFAULT_PLANET_ID, fuelCost: 0, travelMs: TRAVEL_MS_MIN }],
    });
    setStationRoomCheck(() => 'lone-station');
    const html = renderHelm();
    expect(html).toContain('LOCATION</span><span>ARIS</span>');
    expect(html).not.toContain('LOCATION</span><span>Furlong Station</span>');
  });

  it('says why it stays, as its DEPART line does, and never how to depart', () => {
    for (const why of ['lone-station', 'welcome-room'] as const) {
      setStationRoomCheck(() => why);
      for (const docking of [undefined, shipDocked]) {
        const html = renderHelm(docking);
        expect(departDisabled(html)).toBe(true);
        expect(html).not.toContain('Pick a destination and DEPART');
        expect(html).not.toContain('DEPART undocks it and flies');
        expect(html).toContain('ALL SYSTEMS FITTED — but this is the station\'s own room');
        expect(html).toContain('This is the station\'s own room');
      }
    }
  });
});
