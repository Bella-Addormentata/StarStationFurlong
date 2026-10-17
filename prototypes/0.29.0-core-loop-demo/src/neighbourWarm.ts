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
 * Read-only: nothing here ever writes to a neighbour's doc. One hop only and
 * at most `max` rooms; a room whose access mode is KEYED is hung up at once.
 * A failed open is retried no sooner than RETRY_MS later. Never throws.
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
  /** The clock (tests). */
  now?: () => number;
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
  wanted: boolean;
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
  const now = deps.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const drop = (entry: Entry): void => {
    entry.session?.close();
    entry.session = null;
    entries.delete(entry.roomId);
  };

  const dial = (entry: Entry): void => {
    entry.opening = true;
    let opened: Promise<RoomSession | null>;
    try {
      opened = deps.open(entry.address);
    } catch {
      opened = Promise.resolve(null);
    }
    void opened
      .catch(() => null)
      .then((session) => {
        entry.opening = false;
        // No longer next door (or the warmer was cleared) while it dialled.
        if (!entry.wanted || entries.get(entry.roomId) !== entry) {
          session?.close();
          if (entries.get(entry.roomId) === entry) entries.delete(entry.roomId);
          return;
        }
        if (!session || session.closed || isKeyed(session.doc)) {
          session?.close();
          entry.failedAt = now();
          return;
        }
        entry.session = session;
      });
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
        if (!next) {
          entry.wanted = false;
          if (!entry.opening) drop(entry);
          else entries.delete(entry.roomId);
          continue;
        }
        // The door now holds a different pass for the same room: redial.
        if (next.address !== entry.address) {
          entry.wanted = false;
          if (!entry.opening) drop(entry);
          else entries.delete(entry.roomId);
        }
      }
      for (const n of wanted.values()) {
        const entry = entries.get(n.roomId);
        if (entry) {
          // A session the far end hung up, or a failure old enough: retry.
          if (entry.session?.closed) entry.session = null;
          if (!entry.session && !entry.opening && (entry.failedAt === null || now() - entry.failedAt >= RETRY_MS)) dial(entry);
          continue;
        }
        const fresh: Entry = { ...n, session: null, opening: false, failedAt: null, wanted: true };
        entries.set(n.roomId, fresh);
        dial(fresh);
      }
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

    warmRoomIds() {
      return [...entries.values()].filter((e) => e.session && !e.session.closed).map((e) => e.roomId);
    },

    closeAll() {
      for (const entry of [...entries.values()]) {
        entry.wanted = false;
        drop(entry);
      }
    },
  };
}
