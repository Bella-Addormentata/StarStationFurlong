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
 * last time heard, when hearing last began (the first note, or the first
 * after a silence longer than HEARD_GAP_MS or a clock gone back), and the
 * time the page's clock read at the last note or read of it. A page has
 * heard the room since a moment when it has heard it within HEARD_GAP_MS,
 * with no longer silence from that moment on.
 *
 * A clock gone back (a note, or a read of the clock, HEARING_CLOCK_SLACK_MS
 * or more before the last) reads as a silence: deaf until the next note,
 * and hearing from that note on. (By less, a time sync's correction: the
 * last time heard moves back with it, so a silence under way counts on,
 * however often the clock is corrected.) Nothing waits for the clock to
 * come round again, and what was heard before the step is no hearing once
 * it does: a page cut off since heard nobody for the step's length as well,
 * however near its clock reads to its last note. computedTable reads the
 * clock every frame (noteClockRead), and every look at the hearing is a
 * read, so a step is seen even while no duty asks. Not seen: a step the
 * clock comes round from before any note or read (no frame runs in a
 * hidden tab, and a cut-off page hears nothing), which Date.now() can't
 * tell from a page that was frozen; croupier's wake check (tablesAwake)
 * misses it the same way. A casino doc bound afresh (another room, or the
 * same one joined again) starts afresh: deaf until the next note.
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
/** A clock gone back by less than this is no step but a time sync's
 *  correction: the last time heard moves back with it, as croupier's waits
 *  do under TABLE_CLOCK_SLACK_MS, so a silence under way counts in full (but
 *  for the moment between the reads either side of it). */
export const HEARING_CLOCK_SLACK_MS = 250;

let wired = false;
/** When this page last heard the room (null: not since it bound the doc, or
 *  since its clock went back). */
let last: number | null = null;
/** When it last began hearing the room: the first note, or the first after a
 *  silence longer than HEARD_GAP_MS (or a clock gone back). */
let heardFrom = 0;
/** The time the page's clock read at the last note or read of it: one
 *  earlier is the clock gone back. */
let readAt = -Infinity;

/** Turn the gate on: from now on a page hears the room only by what it
 *  is told (main.ts, at startup; computedPageKit for the specs that play a
 *  room over a network). */
export function listenToRoom(): void {
  wired = true;
}

/** This page heard the room at `now`: a tick from another page (main.ts
 *  onTick, any lane), or an update its doc applied from the room (casinoDoc).
 *  A read of the clock too (noteClockRead). */
export function noteRoomHeard(now = Date.now()): void {
  noteClockRead(now);
  if (last === null || now - last > HEARD_GAP_MS) heardFrom = now;
  last = now;
}

/** This page's clock read `now` (computedTable, every frame; each note, and
 *  each look at the hearing once wired): HEARING_CLOCK_SLACK_MS or more
 *  before the last read, its clock went back, and what it heard before is no
 *  hearing: deaf until the next note. By less, the last time heard moves
 *  back with it. */
export function noteClockRead(now = Date.now()): void {
  const back = readAt - now;
  if (back >= HEARING_CLOCK_SLACK_MS) {
    last = null;
    heardFrom = 0;
  } else if (back > 0 && last !== null) {
    last -= back;
  }
  readAt = now;
}

/** Whether this page has heard the room from `since` to `now`: within
 *  HEARD_GAP_MS now, and with no longer silence since `since`. `now` is the
 *  page's clock now, and the look a read of it (noteClockRead): one gone back
 *  wipes what was heard before. Always true while nothing wired the gate. */
export function heardThrough(since: number, now = Date.now()): boolean {
  if (!wired) return true;
  noteClockRead(now);
  return last !== null && now - last <= HEARD_GAP_MS && heardFrom <= since;
}

/** The casino doc was bound afresh (casinoDoc bindCasinoDoc): deaf until the
 *  next note. */
export function forgetRoomHeard(): void {
  last = null;
  heardFrom = 0;
}
