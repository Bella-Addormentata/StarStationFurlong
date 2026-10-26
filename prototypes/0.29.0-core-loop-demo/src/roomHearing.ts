/**
 * 👂 Whether this page hears the room now, and has since a given moment
 * (computedTable's forfeit and answer duties ask, PR 2 of "Computed casino
 * tables").
 *
 * A forfeit beats a full set of reveals (pr2-verdict.md Q4). Written by a
 * page that missed a seed only because its own link stalled — a wifi blip,
 * the node's link to the host stalling for longer than the grace right after
 * a close — it lands on every page as the link comes back and rewrites a
 * round they all showed, the stakes of the players it dropped with it. Such
 * a page hears no seeds, and nobody: the node prunes a silent peer only
 * long after, and tells the page nothing. But every page in a room sends a
 * position tick every 50 ms while its player is in it (main.ts), and the
 * room's updates come into the doc: a page that hears neither for
 * HEARD_GAP_MS is cut off, or alone, or every other page in the room is
 * asleep. What it counts as seen in time then is no count of the room's.
 *
 * main.ts tells this module of every tick it hears from another page
 * (noteRoomHeard, its onTick handler) and casinoDoc of every update the
 * bound doc applies from the room (Yjs tells of one only when it changed
 * something: a resync that brings nothing is no sign of the room). Kept: the
 * last time heard, and when hearing last began (the first note, or the first
 * after a silence longer than HEARD_GAP_MS). A page has heard the room since
 * a moment when it has heard it within HEARD_GAP_MS, with no longer silence
 * from that moment on. A clock gone back reads as a silence: deaf until the
 * next note, and hearing from that note on (nothing waits for the clock to
 * come round again). A casino doc bound afresh (another room, or the same
 * one joined again) starts afresh: deaf until the next note.
 *
 * Only main.ts turns the gate on (listenToRoom, at startup): a page that
 * never heard anyone counts as deaf in the app, while a page nothing wired
 * (offline practice, the specs that hand docs over by hand) hears the room
 * always, and forfeits as it did.
 *
 * Every note is O(1) and allocates nothing: it runs 20 times a second per
 * peer.
 */

/** A silence longer than this is a deaf spell (40 ticks' worth). */
export const HEARD_GAP_MS = 2_000;

let wired = false;
/** When this page last heard the room (null: not since it bound the doc). */
let last: number | null = null;
/** When it last began hearing the room: the first note, or the first after a
 *  silence longer than HEARD_GAP_MS (or a clock gone back). */
let heardFrom = 0;

/** Turn the gate on: from now on a page hears the room only by what it
 *  is told (main.ts, at startup; computedPageKit for the specs that play a
 *  room over a network). */
export function listenToRoom(): void {
  wired = true;
}

/** This page heard the room at `now`: a tick from another page (main.ts
 *  onTick, any lane), or an update its doc applied from the room (casinoDoc). */
export function noteRoomHeard(now = Date.now()): void {
  if (last === null || now < last || now - last > HEARD_GAP_MS) heardFrom = now;
  last = now;
}

/** Whether this page has heard the room from `since` to `now`: within
 *  HEARD_GAP_MS now, and with no longer silence since `since`. Always true
 *  while nothing wired the gate. */
export function heardThrough(since: number, now = Date.now()): boolean {
  if (!wired) return true;
  return last !== null && now >= last && now - last <= HEARD_GAP_MS && heardFrom <= since;
}

/** The casino doc was bound afresh (casinoDoc bindCasinoDoc): deaf until the
 *  next note. */
export function forgetRoomHeard(): void {
  last = null;
  heardFrom = 0;
}
