/**
 * 🛬 Ship departure + arrival docking (#30 SH3).
 *
 * The flight record says WHERE the ship is; the doors doc says WHAT it is
 * docked to. These helpers join the two at the two moments they meet:
 *
 *   - DEPART: remember the berth at the station being left (so the ship can
 *     come back to it), then UNDOCK every docked port with the shipped
 *     UNDOCK (tombstone + far-room write).
 *   - ARRIVAL: pick the berth at the destination — the station's public berth
 *     from the directory, else the berth this ship remembers there — point a
 *     free port at it, and run the shipped DOCK (docking.ts redockPort). The
 *     dock therefore obeys every existing rule: the far berth is asked first
 *     (still free, still a port), module overlap is refused, and a refusal is
 *     reported on the port like any other DOCK.
 *
 * planArrivalDock is pure (pinned by shipArrival.test.ts); the two effectful
 * wrappers take the docking system through a small interface so neither this
 * file nor its tests touch Three or the DOM.
 */

import { stampAfter, type DockPortState } from './dockRules';
import { writeDoorTombstone, type DockBerthMemory } from './doorsDoc';
import { roomIdFromSeed } from './stationAtlas';
import {
  findDestination,
  readBerthMemory,
  readFlightRecord,
  readStationBerth,
  writeFlightRecord,
  writeStationBerth,
  type BerthMemoryRecord,
  type FlightRecord,
} from './shipDoc';
import { isKnownStation, stationHere, type StationBerth, type StationDestination } from './stationDirectory';

/** The slice of a dock port the planner reads (docking.ts DockPortView). */
export interface ArrivalPort {
  doorId: string;
  state: DockPortState;
}

/** The docking system as departure/arrival drive it (world.ts wires it). */
export interface ShipDockingApi {
  ports: () => ArrivalPort[];
  undock: (doorId: string) => void;
  dock: (doorId: string) => void;
}

export type ArrivalPlan =
  | {
      kind: 'dock';
      doorId: string;
      /** The berth being docked to. */
      address: string;
      /** Re-point the port's tombstone here before DOCK; null when the port
       *  already remembers exactly this berth. */
      retarget: DockBerthMemory | null;
    }
  | { kind: 'none'; reason: 'no-berth' | 'no-port' | 'already-docked' };

/**
 * Decide how an arriving ship docks. The station's own berth wins (the station
 * says where visitors dock); otherwise the ship's memory of its last berth
 * there. The port used is the remembered one when it is free, else the first
 * port that is not docked.
 */
export function planArrivalDock(input: {
  station: Pick<StationDestination, 'berth'>;
  remembered: BerthMemoryRecord | null;
  ports: readonly ArrivalPort[];
  now?: number;
}): ArrivalPlan {
  const { station, remembered, ports } = input;
  // The station's berth wins; the ship's own memory fills in when the station
  // names none, or names the same room without saying which door (the memory
  // knows the door and its geometry — a dock that can ask the far side).
  const stationBerth = station.berth ?? null;
  const berth: StationBerth | null =
    remembered &&
    (!stationBerth ||
      (!stationBerth.farDoor && sameRoom(stationBerth.address, remembered.address)))
      ? remembered
      : stationBerth;
  if (!berth) return { kind: 'none', reason: 'no-berth' };
  if (ports.some((p) => p.state.kind === 'docked' && sameRoom(p.state.address, berth.address))) {
    return { kind: 'none', reason: 'already-docked' };
  }
  const open = (p: ArrivalPort) => p.state.kind === 'undocked' || p.state.kind === 'free';
  const preferred = remembered ? ports.find((p) => p.doorId === remembered.doorId && open(p)) : undefined;
  const port = preferred ?? ports.find(open);
  if (!port) return { kind: 'none', reason: 'no-port' };
  const st = port.state;
  if (
    st.kind === 'undocked' &&
    sameRoom(st.address, berth.address) &&
    (berth.farDoor === undefined || st.memory.farDoor === berth.farDoor)
  ) {
    return { kind: 'dock', doorId: port.doorId, address: berth.address, retarget: null };
  }
  const memory: DockBerthMemory = {
    undockedAt: stampAfter(st.kind === 'undocked' ? st.memory.undockedAt : undefined, input.now),
  };
  if (berth.farDoor !== undefined) memory.farDoor = berth.farDoor;
  if (berth.farWall !== undefined) memory.farWall = berth.farWall;
  if (berth.farLateral !== undefined) memory.farLateral = berth.farLateral;
  return { kind: 'dock', doorId: port.doorId, address: berth.address, retarget: memory };
}

/**
 * Where the ship is. While it sits docked into a station, its docks say so
 * (the directory's `here`) — a ship docked by hand at a new station is AT that
 * station, whatever the last flight wrote. Otherwise the flight record's
 * location stands.
 */
export function shipLocationId(rec: FlightRecord, hasLiveDock: boolean): string {
  if (rec.status === 'docked' && hasLiveDock) {
    const here = stationHere();
    if (here) return here;
  }
  return rec.locationId;
}

/** Two pass seeds reach the same room (a seed's hints may differ). */
function sameRoom(a: string, b: string): boolean {
  if (a === b) return true;
  // Peer-written seeds: a malformed one (e.g. `#room=%`) makes the parser
  // throw — fail closed, as two different rooms.
  try {
    const ra = roomIdFromSeed(a);
    return ra !== '' && ra === roomIdFromSeed(b);
  } catch {
    return false;
  }
}

/** The berth to remember at the station being left: the first docked port. */
export function berthToRemember(ports: readonly ArrivalPort[]): BerthMemoryRecord | null {
  for (const p of ports) {
    if (p.state.kind !== 'docked') continue;
    const rec = p.state.record;
    const out: BerthMemoryRecord = { doorId: p.doorId, address: p.state.address };
    if (rec.farDoor) out.farDoor = rec.farDoor;
    if (rec.farWall) out.farWall = rec.farWall;
    if (rec.farLateral !== undefined) out.farLateral = rec.farLateral;
    return out;
  }
  return null;
}

/** DEPART's cast-off: remember the berth here (evicting the oldest other
 *  station when memory is full), then UNDOCK every docked port. Returns
 *  whether the berth here is remembered (true when there was none to keep). */
export function castOffForDeparture(stationId: string, docking: ShipDockingApi): boolean {
  const ports = docking.ports();
  const berth = berthToRemember(ports);
  let remembered = berth === null;
  if (berth) {
    remembered = writeStationBerth(stationId, berth);
    if (!remembered) {
      // Memory full: forget the oldest other station so the berth we are
      // leaving (the one a return trip needs) is never the one dropped.
      const oldest = Object.keys(readBerthMemory()).find((id) => id !== stationId);
      if (oldest !== undefined && writeStationBerth(oldest, null)) {
        remembered = writeStationBerth(stationId, berth);
      }
    }
    if (!remembered) console.warn(`[ship] could not remember the berth at ${stationId}`);
  }
  for (const p of ports) {
    if (p.state.kind === 'docked') docking.undock(p.doorId);
  }
  return remembered;
}

/** What the last arrival did — the helm shows it. */
export type ArrivalOutcome =
  | { kind: 'docking'; stationName: string }
  | {
      kind: 'none';
      stationName: string;
      reason: 'no-berth' | 'no-port' | 'already-docked' | 'unlisted-station';
    };

/**
 * Finish a flight: `redocking → docked` at the destination, then DOCK at its
 * berth. The flight write comes FIRST so the dock's flight gate (docking.ts
 * redockPort refuses while not docked) lets it through. Returns null when the
 * ship is not redocking (another commander finished it already).
 */
export function completeArrival(docking: ShipDockingApi | null): ArrivalOutcome | null {
  const rec = readFlightRecord();
  if (rec.status !== 'redocking') return null;
  writeFlightRecord({ status: 'docked', locationId: rec.locationId });
  // A destination that left the directory mid-flight is NOT home: arrive
  // there undocked rather than docking at findDestination's fallback.
  if (!isKnownStation(rec.locationId)) {
    return { kind: 'none', stationName: rec.locationId, reason: 'unlisted-station' };
  }
  const station = findDestination(rec.locationId);
  if (!docking) return { kind: 'none', stationName: station.name, reason: 'no-port' };
  const plan = planArrivalDock({
    station,
    remembered: readStationBerth(station.id),
    ports: docking.ports(),
  });
  if (plan.kind === 'none') return { kind: 'none', stationName: station.name, reason: plan.reason };
  if (plan.retarget) writeDoorTombstone(plan.doorId, plan.address, plan.retarget);
  docking.dock(plan.doorId);
  return { kind: 'docking', stationName: station.name };
}
