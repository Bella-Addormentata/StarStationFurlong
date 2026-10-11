/**
 * The `cap` envelope payload the browser hands its LOCAL node over loopback
 * (ChiaHub Slice 3; #231 N8 + D3). The node needs the room key to derive the
 * room's chain lookup hint and to seal presence records; the two flags say what
 * it may do with it.
 *
 *  - `chiaMode`   the per-room "publish my presence here" toggle. Publishing
 *                 only; the node reads the chain for every room regardless (D3).
 *  - `publicRoom` N8: this room is PUBLIC SPACE — its seed ships inside every
 *                 build (the welcome room) or its passage policy lets anyone walk
 *                 in, so anyone can derive its hint. The node never publishes an
 *                 address under such a key, armed or not, and never reads under
 *                 it either (D6). The node also recognises the bundled key on its
 *                 own (`chia_rooms.rs`), so this flag is belt, that is braces.
 */
export interface RoomCapPayload {
  roomKeyB64: string;
  chiaMode: boolean;
  publicRoom: boolean;
  /** Monotonic within a browser session (the ms clock, bumped past the last
   *  one sent). Every cap rides its own stream and streams may land out of
   *  order, so the node keeps the highest `seq` it has seen per room and drops
   *  anything older; a stale PRIVATE can then never overwrite a fresh PUBLIC. */
  seq: number;
}

export function buildRoomCapPayload(
  roomKeyB64: string,
  chiaMode: boolean,
  publicRoom: boolean,
  seq: number,
): RoomCapPayload {
  return { roomKeyB64, chiaMode: !!chiaMode, publicRoom: !!publicRoom, seq: Math.max(0, Math.floor(seq)) || 0 };
}

/** The next cap's `seq`: the clock, but never at or below the last one sent,
 *  so two caps in the same millisecond still order. */
export function nextCapSeq(last: number, nowMs: number = Date.now()): number {
  return Math.max(nowMs, last + 1);
}

/** N8's two reasons a room is public space, in one predicate. `bundled` is
 *  "this is the room whose pass ships in the build"; `passagePublic` is the
 *  door-policy reading main.ts already uses to decide whether a room's seed may
 *  ride in the shared atlas. Unknown (undefined) passage counts as PUBLIC: fail
 *  closed — a key is only ever published under once the doc has said it is
 *  private. */
export function roomIsPublicSpace(bundled: boolean, passagePublic: boolean | undefined): boolean {
  return bundled || passagePublic !== false;
}

/** The per-room chia-mode flag (`ssf-chia-mode-<roomId>`), tolerant of privacy
 *  mode where localStorage throws. */
export function readChiaMode(roomId: string): boolean {
  try {
    return localStorage.getItem(`ssf-chia-mode-${roomId}`) === '1';
  } catch {
    return false;
  }
}
