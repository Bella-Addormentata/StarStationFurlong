/**
 * 🕹️ A cabinet's SHARED game in the room doc (the `games` map, keyed by the
 * cabinet's furniture id, gamesDoc.ts). Pure: what a match record holds and
 * the transitions on it; arcadeSession.ts does the reading and writing.
 *
 * The record says who runs the reference copy (the host's page) and who, if
 * anyone, plays player 2 from the cabinet's other stand. The game itself
 * never touches the doc: its button presses ride the tick lane
 * (arcadeNet.ts). The one exception is a SAVE STATE for a copy that joins
 * late, written under its own key so it never races a match write.
 *
 * Only bundled games are shared: everyone's copy needs the ROM, and a
 * player's own cartridge never leaves their device.
 */

export interface ArcadeMatch {
  kind: 'arcade';
  /** Tags this match's ticks and save states: 1–65535, fresh per match. */
  id: number;
  /** The bundled game (ARCADE_GAMES id). */
  game: string;
  /** The host's player id, and the page (tab) running the reference copy. */
  host: string;
  hostPage: string;
  /** The stand the host plays from: 0 is player 1, 1 is player 2. */
  hostSeat: 0 | 1;
  /** Player 2 over the network: their player id and page, or null. */
  guest: string | null;
  guestPage: string | null;
  /** The guest's ticks carry this, so a stale or rival guest page can't
   *  drive the pad: 1–65535 while there is a guest, else 0. */
  guestToken: number;
  startedAt: number;
}

/** A save state for copies that join late (arcadeNet.encodeSnapshot). */
export interface ArcadeSnapshot {
  kind: 'arcade-snapshot';
  /** The match it belongs to. */
  id: number;
  /** The u16 frame the state continues at (the next frame to run). */
  next: number;
  data: Uint8Array;
}

/** The doc key a cabinet's save state lives under. */
export function snapshotKey(cabinetId: string): string {
  return `${cabinetId}#arcade-snapshot`;
}

const isU16 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

export function isArcadeMatch(v: unknown): v is ArcadeMatch {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return m.kind === 'arcade'
    && isU16(m.id) && m.id !== 0
    && isStr(m.game) && isStr(m.host) && isStr(m.hostPage)
    && (m.hostSeat === 0 || m.hostSeat === 1)
    // A guest is all there (player, page, token) or not there at all.
    && ((m.guest === null && m.guestPage === null && m.guestToken === 0)
      || (isStr(m.guest) && isStr(m.guestPage) && isU16(m.guestToken) && m.guestToken !== 0))
    && typeof m.startedAt === 'number' && Number.isFinite(m.startedAt);
}

/** The largest save state a reader accepts (a real one is 10–20 KB). */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;

export function isArcadeSnapshot(v: unknown): v is ArcadeSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return s.kind === 'arcade-snapshot'
    && isU16(s.id) && s.id !== 0
    && isU16(s.next)
    && s.data instanceof Uint8Array && s.data.byteLength > 0 && s.data.byteLength <= MAX_SNAPSHOT_BYTES;
}

/** A random u16 that isn't 0 (0 means "none" on the wire). */
export function randomU16(random: () => number = Math.random): number {
  return 1 + Math.floor(random() * 0xffff);
}

/**
 * A match id no other cabinet's match in the room holds. Ticks carry only
 * the id, so two live matches sharing one would feed each other's pads.
 */
export function freshMatchId(taken: ReadonlySet<number>, random: () => number = Math.random): number {
  const start = randomU16(random);
  for (let i = 0; i < 0xffff; i++) {
    const id = ((start - 1 + i) % 0xffff) + 1;
    if (!taken.has(id)) return id;
  }
  return start; // every id taken: a room can't hold that many cabinets
}

/**
 * Two cabinets claimed the same id at once (neither had seen the other's
 * record): the later claim, by start time and then cabinet id, takes a new
 * one. Every page agrees on which, so exactly one host moves.
 */
export function yieldsMatchId(
  mine: { cabinet: string; match: ArcadeMatch },
  other: { cabinet: string; match: ArcadeMatch },
): boolean {
  if (mine.match.id !== other.match.id || mine.cabinet === other.cabinet) return false;
  if (mine.match.startedAt !== other.match.startedAt) return mine.match.startedAt > other.match.startedAt;
  return mine.cabinet > other.cabinet;
}

export function newMatch(args: {
  game: string;
  host: string;
  hostPage: string;
  hostSeat: 0 | 1;
  now: number;
  /** Ids the room's other matches hold. */
  taken?: ReadonlySet<number>;
  random?: () => number;
}): ArcadeMatch {
  return {
    kind: 'arcade',
    id: freshMatchId(args.taken ?? new Set(), args.random),
    game: args.game,
    host: args.host,
    hostPage: args.hostPage,
    hostSeat: args.hostSeat,
    guest: null,
    guestPage: null,
    guestToken: 0,
    startedAt: args.now,
  };
}

/** Take the guest seat, or null if another page already holds it. */
export function withGuest(
  m: ArcadeMatch,
  guest: string,
  guestPage: string,
  random?: () => number,
): ArcadeMatch | null {
  if (m.guestPage && m.guestPage !== guestPage) return null;
  if (m.hostPage === guestPage) return null;
  if (m.guestPage === guestPage) return m;
  return { ...m, guest, guestPage, guestToken: randomU16(random) };
}

/** Give the guest seat back (only the page that holds it). */
export function withoutGuest(m: ArcadeMatch, guestPage: string): ArcadeMatch {
  if (m.guestPage !== guestPage) return m;
  return { ...m, guest: null, guestPage: null, guestToken: 0 };
}
