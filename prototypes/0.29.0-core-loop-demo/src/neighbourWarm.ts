/**
 * 🚪🔥 Warm neighbours — the rooms next door, kept loaded in the background
 * (step 1 of design/walk-between-modules.md).
 *
 * A door crossing used to dial the next room from nothing and wait behind the
 * fade, up to SYNC_GATE_MS, for its state to arrive. This keeps a background
 * session (roomSession.ts, the same one the gate keeper holds to ferries) open
 * to each room behind a PUBLIC paired door of the room we stand in, so the
 * join can start from that room's synced replica instead: applied before the
 * join's sync starts, exactly like the room-cache restore, so the gate opens
 * as soon as the channel is up and the host ships only what changed since.
 *
 * Read-only: nothing here ever writes to a neighbour's doc. One hop only, and
 * at most `max` sessions open or dialling at once (an open that is no longer
 * wanted still counts until it finishes, since it cannot be called off). A
 * room whose access mode is or becomes KEYED is hung up. A failed or refused
 * open is retried RETRY_MS later while the room is still next door. Never
 * throws.
 */

import * as Y from 'yjs';
import type { RoomSession } from './roomSession';

/** One room behind a public door: its id and the pass the door holds. */
export interface WarmNeighbour {
  roomId: string;
  address: string;
}

export interface NeighbourWarmerDeps {
  /** Open a background session (roomSession.openRoomSession). */
  open: (address: string) => Promise<RoomSession | null>;
}

export interface NeighbourWarmer {
  /** The rooms to keep warm now (the current room's public neighbours).
   *  Rooms no longer listed are hung up; new ones are dialled. */
  setNeighbours(neighbours: readonly WarmNeighbour[], currentRoomId: string | null): void;
  /** The warm replica's full state for `roomId`, or null when that room has
   *  no open, synced session. */
  warmStateFor(roomId: string): Uint8Array | null;
  /** Apply `roomId`'s warm state to `doc` (a join's fresh doc, BEFORE its
   *  sync starts, like the room-cache restore). True when it did. */
  seedDoc(doc: Y.Doc, roomId: string): boolean;
  /** Is a session to `roomId` open OR still dialling? Either way this node
   *  may already be linked to that room's host. */
  isWarming(roomId: string): boolean;
  /** The rooms with an open session (diagnostics, tests). */
  warmRoomIds(): string[];
  /** Hang up everything. */
  closeAll(): void;
}

/** How many neighbours are kept warm at once. */
export const MAX_WARM_NEIGHBOURS = 4;
/** How long a room whose open failed (or that is keyed) is left alone. */
export const RETRY_MS = 60_000;

interface Entry {
  roomId: string;
  address: string;
  session: RoomSession | null;
  opening: boolean;
  /** When the last open failed or was refused, else null. */
  failedAt: number | null;
  /** The pending retry, while one is scheduled. */
  retry: ReturnType<typeof setTimeout> | null;
  /** Stops watching the session's access mode. */
  unwatch: (() => void) | null;
}

/** Is this replica's room set to KEYED entry (roomInfo.accessMode)? */
function isKeyed(doc: Y.Doc): boolean {
  try {
    return doc.getMap('roomInfo').get('accessMode') === 'keyed';
  } catch {
    return false;
  }
}

export function createNeighbourWarmer(deps: NeighbourWarmerDeps, max = MAX_WARM_NEIGHBOURS): NeighbourWarmer {
  /** The rooms wanted warm, by id. */
  const entries = new Map<string, Entry>();
  /** Opens not yet finished, wanted or not. */
  let inFlight = 0;

  const hangUp = (entry: Entry): void => {
    entry.unwatch?.();
    entry.unwatch = null;
    entry.session?.close();
    entry.session = null;
  };

  const drop = (entry: Entry): void => {
    if (entry.retry !== null) clearTimeout(entry.retry);
    entry.retry = null;
    hangUp(entry);
    if (entries.get(entry.roomId) === entry) entries.delete(entry.roomId);
  };

  const failed = (entry: Entry): void => {
    hangUp(entry);
    entry.failedAt = Date.now();
    if (entry.retry !== null) clearTimeout(entry.retry);
    entry.retry = setTimeout(() => {
      entry.retry = null;
      pump();
    }, RETRY_MS);
  };

  const accept = (entry: Entry, session: RoomSession): void => {
    entry.session = session;
    entry.failedAt = null;
    // A room that turns KEYED while warm is hung up like one that was keyed.
    const roomInfo = session.doc.getMap('roomInfo');
    const watch = (): void => {
      if (!isKeyed(session.doc)) return;
      // Out of the doc's own transaction before the session is torn down.
      queueMicrotask(() => {
        if (entry.session === session) failed(entry);
      });
    };
    roomInfo.observe(watch);
    entry.unwatch = () => {
      try {
        roomInfo.unobserve(watch);
      } catch {
        /* doc destroyed */
      }
    };
  };

  const dial = (entry: Entry): void => {
    entry.opening = true;
    inFlight++;
    let opened: Promise<RoomSession | null>;
    try {
      opened = deps.open(entry.address);
    } catch {
      opened = Promise.resolve(null);
    }
    void opened
      .catch(() => null)
      .then((session) => {
        inFlight--;
        entry.opening = false;
        if (entries.get(entry.roomId) !== entry) {
          // No longer next door (or the warmer was cleared) while it dialled.
          session?.close();
        } else if (!session || session.closed || isKeyed(session.doc)) {
          session?.close();
          failed(entry);
        } else {
          accept(entry, session);
        }
        pump();
      });
  };

  /** Dial the wanted rooms that need it, within the cap. */
  const pump = (): void => {
    for (const entry of entries.values()) {
      if (entry.session?.closed) hangUp(entry);
      if (entry.session || entry.opening) continue;
      if (entry.failedAt !== null && Date.now() - entry.failedAt < RETRY_MS) continue;
      const open = [...entries.values()].filter((e) => e.session).length;
      if (open + inFlight >= max) return;
      dial(entry);
    }
  };

  return {
    setNeighbours(neighbours, currentRoomId) {
      const wanted = new Map<string, WarmNeighbour>();
      for (const n of neighbours) {
        if (wanted.size >= max) break;
        if (!n.roomId || !n.address || n.roomId === currentRoomId || wanted.has(n.roomId)) continue;
        wanted.set(n.roomId, n);
      }
      for (const entry of [...entries.values()]) {
        const next = wanted.get(entry.roomId);
        // Gone, or the door now holds a different pass for it: hang up.
        if (!next || next.address !== entry.address) drop(entry);
      }
      for (const n of wanted.values()) {
        if (!entries.has(n.roomId)) {
          entries.set(n.roomId, { ...n, session: null, opening: false, failedAt: null, retry: null, unwatch: null });
        }
      }
      pump();
    },

    warmStateFor(roomId) {
      const session = entries.get(roomId)?.session;
      if (!session || session.closed) return null;
      try {
        if (isKeyed(session.doc)) return null;
        return Y.encodeStateAsUpdate(session.doc);
      } catch {
        return null;
      }
    },

    seedDoc(doc, roomId) {
      const state = this.warmStateFor(roomId);
      if (!state) return false;
      try {
        Y.applyUpdate(doc, state, 'warm-neighbour');
        return true;
      } catch {
        return false;
      }
    },

    isWarming(roomId) {
      const entry = entries.get(roomId);
      return !!entry && (entry.opening || (!!entry.session && !entry.session.closed));
    },

    warmRoomIds() {
      return [...entries.values()].filter((e) => e.session && !e.session.closed).map((e) => e.roomId);
    },

    closeAll() {
      for (const entry of [...entries.values()]) drop(entry);
    },
  };
}
