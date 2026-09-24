/**
 * ⚓ Docking-adapter rules (#163) — pure, no DOM, no Three, no bound doc.
 *
 * A DOCK PORT is one half of a round docking adapter fitted to a door (stored
 * as the door's `doorPolicy.adapter` flag, which outlives any connection). A
 * DOCK is two halves mated: a pairing whose chain is exactly two `dock`
 * segments, always transient. UNDOCK leaves a tombstone that remembers the
 * berth; DOCK makes the same connection again.
 *
 * Every surface that touches a dock — the door panel, the helm's docking
 * computer, the transit mirror, and the far-room write — decides through
 * here, so the two ends of one connection are always judged by one set of
 * rules. Pinned by dockRules.test.ts.
 */

import { dockChain, isDockChain, type ConnectorSegment } from './adapter';
import {
  buildDoorPairing, buildDoorTombstone,
  type DockBerthMemory, type DoorPairing, type DoorRecord, type DoorTombstone,
} from './doorsDoc';
import type { DoorWall } from './doorLayoutDoc';
import { roomIdFromSeed } from './stationAtlas';

// ── What a door is, as far as docking goes ───────────────────────────────────

export type DockPortState =
  /** Two halves mated — the connection is live. */
  | { kind: 'docked'; address: string; roomId: string; record: DoorPairing }
  /** Released, with a berth on record: DOCK re-makes it. */
  | { kind: 'undocked'; address: string; roomId: string; memory: DockBerthMemory }
  /** A port with nothing on the other side and no berth to return to. */
  | { kind: 'free' }
  /** Connected, but by a GANGWAY (a legacy connection on a door that also
   *  wears a port): not a dock, so neither DOCK nor UNDOCK applies. */
  | { kind: 'gangway' };

/** Classify one door from its (sanitized) record. */
export function classifyDockPort(record: DoorRecord | undefined): DockPortState {
  if (!record) return { kind: 'free' };
  if (record.paired) {
    if (!record.connectedRoomAddress) return { kind: 'free' };
    return isDockChain(record.segments)
      ? {
          kind: 'docked',
          address: record.connectedRoomAddress,
          roomId: roomIdFromSeed(record.connectedRoomAddress),
          record,
        }
      : { kind: 'gangway' };
  }
  return record.dock && record.retiredAddress
    ? {
        kind: 'undocked',
        address: record.retiredAddress,
        roomId: roomIdFromSeed(record.retiredAddress),
        memory: record.dock,
      }
    : { kind: 'free' };
}

/** A door wears a port when its policy says so — or when it is docked right
 *  now (a dock always has both halves, whatever a lagging policy map says). */
export function isPortDoor(adapterFlag: boolean, record: DoorRecord | undefined): boolean {
  return adapterFlag || (!!record?.paired && isDockChain(record.segments));
}

// ── The +DOCK vestibule option ───────────────────────────────────────────────

export type DockStep =
  | { kind: 'fit-port' }
  | { kind: 'stage-mate' }
  | { kind: 'refuse'; reason: string };

/**
 * What the next `+DOCK` press does at a door: the first fits THIS door's port,
 * the second stages the MATING half the connection brings to the far door.
 */
export function nextDockStep(s: {
  hasPort: boolean;
  record: DoorRecord | undefined;
  staged: readonly ConnectorSegment[] | undefined;
}): DockStep {
  if (s.record?.paired && s.record.connectedRoomAddress) {
    return isDockChain(s.record.segments)
      ? { kind: 'refuse', reason: 'Docked — both halves are already fitted. UNDOCK first to change anything.' }
      : { kind: 'refuse', reason: 'This door already has a vestibule — UNDOCK it before fitting a dock port.' };
  }
  const staged = s.staged ?? [];
  if (staged.some((seg) => seg.kind !== 'dock')) {
    return { kind: 'refuse', reason: 'A dock port connects directly — CLEAR the gangway chain first.' };
  }
  if (!s.hasPort) return { kind: 'fit-port' };
  if (isDockChain(staged)) {
    return {
      kind: 'refuse',
      reason: 'Both halves are staged — PROVISION NEW MODULE, or pick a target and INITIATE.',
    };
  }
  return { kind: 'stage-mate' };
}

/** A chain may take a gangway part (FLEX/EXT) only on a door without a port. */
export function gangwayPartRefusal(hasPort: boolean): string | null {
  return hasPort
    ? 'This door wears a dock port — it connects by docking. Remove the port (✕ on its chip) to build a gangway.'
    : null;
}

// ── Dock and undock, near side ───────────────────────────────────────────────

/**
 * A stamp for a new DOCK or UNDOCK that is causally AFTER the event it
 * replaces (`after`: the dock being undocked, or the undock being re-docked):
 * the local clock, or one past `after` when this clock trails the client that
 * wrote it. Every stamp comparison (the mirror's re-dock rule, the far
 * undock's newer-dock guard) then agrees with the order things happened in,
 * whatever the two clients' clocks say.
 */
export function stampAfter(after: number | undefined, now = Date.now()): number {
  // Only a safe integer can be stepped past (the sanitizer admits no other);
  // at the very top of that range the stamp can only hold, never overflow.
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < now) return now;
  return Math.min(after + 1, Number.MAX_SAFE_INTEGER);
}

/** What an UNDOCK remembers of the berth it releases. */
export function berthMemoryFrom(record: DoorPairing, undockedAt: number): DockBerthMemory {
  const memory: DockBerthMemory = { undockedAt };
  if (record.farDoor) memory.farDoor = record.farDoor;
  if (record.farWall) memory.farWall = record.farWall;
  if (record.farLateral !== undefined) memory.farLateral = record.farLateral;
  return memory;
}

/** The near record a DOCK (re-)writes toward a remembered berth. */
export function redockRecord(
  state: Extract<DockPortState, { kind: 'undocked' }>,
  dockedAt: number,
): DoorPairing {
  return buildDoorPairing(state.address, {
    segments: dockChain(),
    farDoor: state.memory.farDoor,
    farWall: state.memory.farWall,
    farLateral: state.memory.farLateral,
    transient: true,
    dockedAt,
  });
}

/**
 * A DOCK asked its berth, and THIS port changed while it waited: does the port
 * now hold the very dock that DOCK made? Only that berth under that DOCK's own
 * stamp counts — the walk-through mirror of our far write, or a crew member
 * here joining it. The same berth under ANOTHER stamp is the far side's own
 * DOCK crossing ours (its far write landed on this door while ours landed on
 * its door): keeping both would leave the two ends holding different stamps,
 * so the port changed like any other, and our far write is taken back — as
 * the far side, finding our claim on its own door, takes back its own.
 */
export function holdsOurRedock(
  now: DockPortState | null,
  berth: { roomId: string; farDoor: string },
  dockedAt: number,
): boolean {
  return (
    now?.kind === 'docked' &&
    now.roomId === berth.roomId &&
    (!now.record.farDoor || now.record.farDoor === berth.farDoor) &&
    now.record.dockedAt === dockedAt
  );
}

// ── The transit mirror ───────────────────────────────────────────────────────

/**
 * May the first walk-through write the arrival door's mirror record?
 *
 * Never over a live pairing (one vestibule per door). A tombstone naming the
 * departure ROOM refuses — that connection was deliberately taken down, and
 * re-creating it would undo someone's undock — with one exception: a DOCK
 * made after that door's own undock is a deliberate re-dock, so it may.
 * Compared by room id, never by seed string: two passes to the same module
 * are different strings and used to slip straight past a tombstone.
 */
export function mirrorMayWrite(
  existing: DoorRecord | undefined,
  departureRoomId: string,
  departure: { isDock: boolean; dockedAt?: number },
): boolean {
  if (!existing) return true;
  if (existing.paired) return false;
  const retiredRoom = roomIdFromSeed(existing.retiredAddress);
  if (!retiredRoom || retiredRoom !== departureRoomId) return true;
  return (
    departure.isDock &&
    existing.dock !== undefined &&
    typeof departure.dockedAt === 'number' &&
    departure.dockedAt > existing.dock.undockedAt
  );
}

// ── The far side ─────────────────────────────────────────────────────────────

/** Which of the far room's doors holds its end of OUR connection. The near
 *  record's `farDoor` when it names one; otherwise the far door whose own
 *  record points back at us through our door (the mirror writes exactly
 *  that), else the only far door pointing at our room without naming one of
 *  our OTHER doors — a record that names another door of ours is that other
 *  connection's end, never this one's. */
export function findFarDoor(
  farDoors: ReadonlyMap<string, DoorRecord>,
  nearRoomId: string,
  nearDoorId: string,
  hint?: string,
): string | null {
  if (hint) return hint;
  const ours = [...farDoors.entries()].filter(
    ([, r]) => r.paired && roomIdFromSeed(r.connectedRoomAddress) === nearRoomId,
  );
  const exact = ours.find(([, r]) => r.paired && r.farDoor === nearDoorId);
  if (exact) return exact[0];
  const unnamed = ours.filter(([, r]) => r.paired && !r.farDoor);
  return unnamed.length === 1 ? unnamed[0][0] : null;
}

export interface NearEnd {
  roomId: string;
  /** An address the far room can reach us by (pass / ledger / minted). */
  address: string;
  doorId: string;
  wall?: DoorWall;
  lateral?: number;
}

export type FarUndock =
  | { action: 'write'; record: DoorTombstone }
  | {
      action: 'skip';
      reason: 'absent' | 'already' | 'not-ours' | 'newer-dock' | 'not-this-dock';
    };

/** Does a far record that points at our room name ANOTHER of our doors? Then
 *  it is that other connection's end (two modules may dock more than once),
 *  and nothing done through `nearDoorId` may touch it. An unnamed record is
 *  taken as ours, as findFarDoor does. */
function namesAnotherNearDoor(record: DoorPairing, nearDoorId: string): boolean {
  return !!record.farDoor && record.farDoor !== nearDoorId;
}

/** UNDOCK's far end: tombstone the far record only while it still describes
 *  THIS dock — ours (our room AND our door), still a dock, and not a dock made
 *  after this undock (a late write from a quick undock→dock must never undo
 *  the newer dock). `onlyDockedAt` narrows it to exactly one dock: the
 *  take-back of a far DOCK this client wrote, which must never undo anyone
 *  else's. */
export function farUndockPatch(
  farRecord: DoorRecord | undefined,
  near: NearEnd,
  undockedAt: number,
  onlyDockedAt?: number,
): FarUndock {
  if (!farRecord) return { action: 'skip', reason: 'absent' };
  if (!farRecord.paired) return { action: 'skip', reason: 'already' };
  if (
    roomIdFromSeed(farRecord.connectedRoomAddress) !== near.roomId ||
    namesAnotherNearDoor(farRecord, near.doorId)
  ) {
    return { action: 'skip', reason: 'not-ours' };
  }
  // Only a DOCK is undocked. A delayed UNDOCK must never take down a gangway
  // that has since re-connected these very two doors (it carries no dock
  // stamp for the newer-dock guard below to catch).
  if (!isDockChain(farRecord.segments)) {
    return { action: 'skip', reason: 'not-this-dock' };
  }
  if (typeof farRecord.dockedAt === 'number' && farRecord.dockedAt > undockedAt) {
    return { action: 'skip', reason: 'newer-dock' };
  }
  if (onlyDockedAt !== undefined && farRecord.dockedAt !== onlyDockedAt) {
    return { action: 'skip', reason: 'not-this-dock' };
  }
  return {
    action: 'write',
    record: buildDoorTombstone(near.address, {
      farDoor: near.doorId,
      farWall: near.wall,
      farLateral: near.lateral,
      undockedAt,
    }),
  };
}

/** Does this far record hold a DOCK to exactly this near end — our room,
 *  through our door? (What a DOCK's far write must still find once concurrent
 *  writes have had time to arrive: the CRDT keeps one claim per berth.) */
export function holdsDockTo(record: DoorRecord | undefined, near: NearEnd): boolean {
  return (
    !!record?.paired &&
    isDockChain(record.segments) &&
    roomIdFromSeed(record.connectedRoomAddress) === near.roomId &&
    record.farDoor === near.doorId
  );
}

export type FarDock =
  | { action: 'write'; record: DoorPairing }
  | {
      action: 'refuse';
      reason: 'gone' | 'occupied' | 'closed' | 'superseded';
      /** With `superseded`: the stamp of the dock of this port the berth holds. */
      stamp?: number;
    };

/** Player-facing words for a refused far berth. */
export const FAR_DOCK_REFUSAL: Record<Extract<FarDock, { action: 'refuse' }>['reason'], string> = {
  gone: 'That berth no longer exists — its door was removed.',
  occupied: 'That berth is occupied by another module now.',
  closed: 'That berth was closed — its dock port was removed.',
  superseded: 'A newer DOCK of this port already holds that berth.',
};

/**
 * DOCK's far end: the berth must still exist and be free.
 *  - Paired to another module, or to ANOTHER of our doors: OCCUPIED.
 *  - Paired to THIS end already: only two such records may be written over —
 *    our own claim (the same stamp: a retry), or a leftover of the very dock
 *    this DOCK re-makes (stamped no later than the undock it follows, or
 *    unstamped), whose undock never reached this side. A GANGWAY between the
 *    two doors is another connection (OCCUPIED); a dock stamped after that
 *    undock is a newer claim on this port (SUPERSEDED) — overwriting it would
 *    leave the two ends holding different stamps.
 *  - A tombstone on a door that no longer wears a port: CLOSED — its port was
 *    removed (the removal's policy write can even land before its tombstone),
 *    and a dock must never re-fit a port someone took off. A plain tombstone
 *    naming US is closed too: removing a port drops its berth memory
 *    precisely to say so.
 *  - Otherwise free: a dock tombstone (anyone's) on a port, a plain tombstone
 *    for another module on a port — or no record at all, a door that never
 *    had a connection, which the dock brings its half to.
 * `far.portFlag` is the far door's own doorPolicy `adapter` flag;
 * `replacesUndockedAt` is the undock this DOCK re-makes the dock after.
 */
export function farDockPatch(
  farRecord: DoorRecord | undefined,
  far: { exists: boolean; portFlag: boolean },
  near: NearEnd,
  dockedAt: number,
  replacesUndockedAt?: number,
): FarDock {
  if (!far.exists) return { action: 'refuse', reason: 'gone' };
  if (farRecord?.paired) {
    if (
      roomIdFromSeed(farRecord.connectedRoomAddress) !== near.roomId ||
      namesAnotherNearDoor(farRecord, near.doorId) ||
      !isDockChain(farRecord.segments)
    ) {
      return { action: 'refuse', reason: 'occupied' };
    }
    const stamp = farRecord.dockedAt;
    const ours = stamp === dockedAt;
    const leftover =
      stamp === undefined || (replacesUndockedAt !== undefined && stamp <= replacesUndockedAt);
    if (!ours && !leftover) return { action: 'refuse', reason: 'superseded', stamp };
  }
  if (
    farRecord &&
    !farRecord.paired &&
    (!far.portFlag ||
      (!farRecord.dock && roomIdFromSeed(farRecord.retiredAddress) === near.roomId))
  ) {
    return { action: 'refuse', reason: 'closed' };
  }
  return {
    action: 'write',
    record: buildDoorPairing(near.address, {
      segments: dockChain(),
      farDoor: near.doorId,
      farWall: near.wall,
      farLateral: near.lateral,
      transient: true,
      dockedAt,
    }),
  };
}
