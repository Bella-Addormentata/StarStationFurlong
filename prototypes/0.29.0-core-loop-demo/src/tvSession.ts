/**
 * 📺 tvSession — the room-level duties around the TVs, ticked by World
 * every half second (the coin pusher's tickCoinPusherRoom idiom) and
 * DOM-free so they can be tested:
 *
 *  - a holder renews its remote lease every TV_LEASE_RENEW_MS;
 *  - a holder whose theatre is closed still keeps the room's clock alive:
 *    a HEADLESS heartbeat free-runs the record's own position, so viewers
 *    never lose the sample they anchor to (the theatre, when open, registers
 *    its controller as the player of record and takes over);
 *  - leaving the room puts every remote this client holds back on the set
 *    (the coin pusher's lease hand-back on leave).
 *
 * Also the seam for "who is in the room" (HAND TO… needs names and pubs):
 * main.ts registers the players-map reader; the panels never touch the doc.
 */

import {
  claimRemote, iHoldRemote, markTvPageAwake, putDownRemote, readPlayback, readPower, readProgramme, readTv, renewRemote,
  scheduleStarted,
  subscribeTv, tvDocEpoch, tvHeartbeat, tvNoteEnd, tvNow, tvPause, tvStop, TV_HEARTBEAT_MS, TV_LEASE_RENEW_MS,
} from './tvDoc';

/** The furniture kinds that are a TV set, and what each is called in the
 *  panels, the chip and the theatre — one place for both, so a third
 *  mounting is a one-line change (world.ts, main.ts and the theatre all
 *  read these). */
const TV_KINDS: ReadonlySet<string> = new Set(['smart-tv', 'tv-stand']);
export function isTvKind(kind: string | undefined): boolean {
  return kind !== undefined && TV_KINDS.has(kind);
}
export function tvLabel(kind: string | undefined): string {
  return kind === 'tv-stand' ? 'TV ON THE STAND' : 'WALL TV';
}

export interface RoomPlayer {
  pub: string;
  name: string;
}

let roomPlayersProvider: () => RoomPlayer[] = () => [];
export function setTvRoomPlayersProvider(fn: () => RoomPlayer[]): void {
  roomPlayersProvider = fn;
}
/** Everyone the room's players map names with a key, except me. */
export function tvRoomPlayers(myPub: string): RoomPlayer[] {
  return roomPlayersProvider().filter((p) => p.pub && p.pub !== myPub);
}

/** What the phone's transport asks a live player: where it is (the record's
 *  extrapolation runs on while a player buffers) and whether it can seek
 *  (a live stream cannot, whatever the source kind promised). */
export interface LivePlayer {
  positionMs: () => number;
  canSeek: () => boolean;
  /** The programme this player is mounted for (the record's `started`): an
   *  end it reports is that programme's alone. The theatre remounts on its
   *  own timer after a source change, and a tick between the record's change
   *  and the remount must not file the old player's length under the new
   *  programme — a live stream after a short film would otherwise be stopped
   *  at the film's length once the theatre closed. */
  started?: () => number;
  /** Where the media ends, in ms — ONLY when the player knows the media to
   *  be finite (an HTML element's finite `duration`); null for a live
   *  stream, before the player knows, and from a player that cannot tell
   *  (YouTube's API never says whether a video is live, and its duration on
   *  a live event is elapsed time). Remembered here while the player is
   *  registered, so the holder's headless beat still ends the programme
   *  where the media does after the theatre is closed (a viewer's player
   *  ending stops nothing, by design); never inferred from readings. */
  endMs?: () => number | null;
}

/** TVs whose playback clock a live player (the theatre) is driving. */
const playersOfRecord = new Map<string, LivePlayer | null>();
export function registerTvPlayerOfRecord(itemId: string, live?: LivePlayer): () => void {
  const stored = live ?? null;
  playersOfRecord.set(itemId, stored);
  return () => {
    if (playersOfRecord.get(itemId) !== stored) return; // a later registration owns the slot
    // The player's last word on where its media ends, taken as it goes: a
    // theatre closed between the metadata's arrival and the next room tick
    // would otherwise take the only duration report with it, and the
    // headless beat would run the programme past its end for good.
    if (driveArmed && stored) noteKnownEnd(itemId, stored, readTv(itemId));
    playersOfRecord.delete(itemId);
  };
}
export function hasTvPlayerOfRecord(itemId: string): boolean {
  return playersOfRecord.has(itemId);
}
/** The live player's position for a set, or null when no player of record
 *  is mounted here (then the record's estimate is all there is). */
export function tvPlayerPositionMs(itemId: string): number | null {
  const live = playersOfRecord.get(itemId);
  return live ? live.positionMs() : null;
}
/** Whether the live player can seek, or null when none is mounted here. */
export function tvPlayerCanSeek(itemId: string): boolean | null {
  const live = playersOfRecord.get(itemId);
  return live ? live.canSeek() : null;
}

const lastRenew = new Map<string, number>();
const lastHeadlessBeat = new Map<string, number>();
/** The switch as this page last saw it, per set, with the programme's
 *  revision beside it: a flip from off to on with the programme UNCHANGED
 *  since and still 'playing' is what the holder parks — PLAY NOW turns the
 *  set on too, and that is a new programme, not one coming back. A rebind
 *  (another room, another doc) forgets it all. */
interface SeenPower {
  on: boolean;
  epoch: number;
  /** An off→on flip still owed its park: the programme's `jump` as the
   *  switch came back, kept until a holder parks it or the programme moves
   *  on. The page that sees the flip may not hold the remote yet (a
   *  presser's pickup lands beside the switch's write, a set may be turned
   *  on with nobody holding), and a flip seen once and let go would leave
   *  the programme running across the whole off interval. */
  owed: number | null;
}
const lastPower = new Map<string, SeenPower>();

/** POWER back on with the programme still 'playing' from before the set
 *  went off, and untouched since (its `jump` where it was — PLAY NOW turns
 *  the set on too, and that is a new programme): the holder parks it where
 *  it was. The body button lives in its own key and never touches the
 *  programme's slot — that write is the holder's, here. Run from the doc's
 *  own notify as the switch's write lands (below), not only from the tick:
 *  the theatre's controller runs every 400 ms on its own, and between the
 *  write and this page's next tick it would seek to a sample extrapolated
 *  across the whole off interval and beat that position over the saved one
 *  — a minute off would have parked at 63 s, not 3 s. */
function parkIfPowerReturned(id: string): void {
  const power = readPower(id);
  const on = power.on;
  const epoch = tvDocEpoch();
  const was = lastPower.get(id);
  const same = was !== undefined && was.epoch === epoch;
  const programme = readProgramme(id);
  // Running as the set went off: playing, or a schedule past its T0 —
  // playing by the clock, its record never flipped (tvDoc scheduleStarted)
  // — where the switch carries a reading of it: a schedule that STARTED
  // while the set was off carries none (a countdown still ahead is nothing
  // to read) and is not parked, playing from the clock's reading at the
  // holder's first tick past T0 as it did, and as a room whose remote
  // lapsed does.
  const running = programme.state === 'playing' || (scheduleStarted(programme) && power.parkMs !== null);
  let owed = same ? was.owed : null;
  if (same && !was.on && on && running) owed = programme.jump;
  if (owed !== null && (!on || !running || programme.jump !== owed)) owed = null;
  if (owed !== null && iHoldRemote(id)) {
    lastPower.set(id, { on, epoch, owed: null }); // before the write: its notify re-enters here
    // Where the room WAS switched off: the presser's own reading, carried
    // by the switch (tvDoc `parkMs`; a reading of 0 is a reading) — not
    // this page's last heartbeat, which a holder asleep before the press
    // would have left minutes behind the room. The heartbeat is the
    // fallback for a switch that carried no reading (null: a record from
    // before the field, nothing running when it went off).
    tvPause(id, power.parkMs ?? programme.positionMs);
    return;
  }
  lastPower.set(id, { on, epoch, owed });
}

/** The end of the media as the player of record reported it, per set, with
 *  the programme it belongs to (`started`). Only an end the player KNOWS to
 *  be finite is ever reported (LivePlayer.endMs) — finiteness is never
 *  inferred from readings, since a live event's elapsed time can repeat
 *  between polls before it grows. And should a reported end still move
 *  within one programme, the programme is unbounded from then on (`endMs:
 *  null`, sticky until the programme changes): the headless beat stops
 *  nothing on a value that was true once. An UNKNOWN reading changes
 *  nothing known of the programme — a player before its metadata, a
 *  remount of the same source, a stream — neither a finite end (the same
 *  file's) nor the unbounded marker (a decision, not a reading: a finite
 *  value after it would otherwise pass as the end again); only a new
 *  programme, or a player mounted for another one, clears the slate. */
interface KnownEnd {
  started: number;
  endMs: number | null;
  /** The doc it was read in: `started` counts from zero in every doc, so a
   *  rebind (another room) must never find an old end under a new number. */
  epoch: number;
}
const knownEnds = new Map<string, KnownEnd>();

/** The known end for THIS programme in THIS doc, or undefined. */
function knownEndFor(id: string, started: number): KnownEnd | undefined {
  const known = knownEnds.get(id);
  return known !== undefined && known.epoch === tvDocEpoch() && known.started === started ? known : undefined;
}

/** File what a live player says about where the current programme ends. */
function noteKnownEnd(id: string, live: LivePlayer, rec: { started: number }): void {
  const prev = knownEndFor(id, rec.started);
  if (!prev) knownEnds.delete(id); // another programme's end is never carried over
  if (live.started && live.started() !== rec.started) return; // mounted for a programme that has moved on
  const end = live.endMs?.();
  if (typeof end === 'number' && Number.isFinite(end) && end > 0) {
    const moved = prev !== undefined && prev.endMs !== end;
    knownEnds.set(id, { started: rec.started, endMs: moved ? null : end, epoch: tvDocEpoch() });
  }
}

/** The end this page knows for the programme, filed in the record for the
 *  next holder (tvNoteEnd): a remote handed to a page with no theatre open,
 *  one that never watched the file, would otherwise beat on past the
 *  media's end for good, with nobody left who could close the programme.
 *  Idempotent: written when the record does not carry it yet. */
function publishEnd(id: string, rec: { started: number; endMs: number }): void {
  const known = knownEndFor(id, rec.started);
  if (!known) return;
  if (rec.endMs !== (known.endMs ?? 0)) tvNoteEnd(id, known.endMs);
}

/** Whether this page drives its room's TVs at all. Cleared SYNCHRONOUSLY as
 *  a room is left (leaveTvRoom, from main.ts leaveRoomNow) and armed again
 *  only once the next room's docs and layout are bound (main.ts joinRoom):
 *  World keeps ticking through the leave's awaited flush, with the old
 *  furniture and the old TV doc still here, and a tick in that window would
 *  claim a hand-over into a room being left, beat its clock, or put the
 *  departed room's WATCH chip back up with its theatre a click away. */
let driveArmed = true;
export function armTvDrive(on: boolean): void {
  driveArmed = on;
}
export function tvDriveArmed(): boolean {
  return driveArmed;
}

/** The sets the last tick drove: what the doc listener below parks for. */
let liveIds: readonly string[] = [];
subscribeTv(() => {
  if (!driveArmed) return;
  for (const id of liveIds) parkIfPowerReturned(id);
});

/** Drive every TV in the room (ids of the smart-tv / tv-stand items). */
export function tickTvRoom(itemIds: readonly string[], now = tvNow()): void {
  // This page is awake: a lease landing now is seen now. A gap in these
  // marks is a sleep, and what lands on waking is stamped from before it
  // (tvDoc markTvPageAwake) — a hand-over the network held through a closed
  // lid is not claimed on waking as if it had just been written.
  markTvPageAwake(now);
  if (!driveArmed) return;
  liveIds = itemIds;
  const live = new Set(itemIds);
  for (const id of [...lastRenew.keys()]) if (!live.has(id)) lastRenew.delete(id);
  for (const id of [...lastHeadlessBeat.keys()]) if (!live.has(id)) lastHeadlessBeat.delete(id);
  for (const id of [...lastPower.keys()]) if (!live.has(id)) lastPower.delete(id);
  for (const id of [...knownEnds.keys()]) if (!live.has(id)) knownEnds.delete(id);
  for (const id of itemIds) {
    // A remote handed to my identity is nobody's page yet: this page takes
    // it (two tabs, one key — the first to tick wins, the other stays a
    // viewer). The claim refreshes the lease, so it is this tick's renewal
    // too, and `by` stays the giver until the next one: the phone's cue.
    if (claimRemote(id, now)) lastRenew.set(id, now);
    // The switch, for a flip the doc listener did not see (this page's
    // first tick on the set; a listener call before the tick named it).
    parkIfPowerReturned(id);
    if (!iHoldRemote(id)) {
      lastRenew.delete(id);
      lastHeadlessBeat.delete(id);
      continue;
    }
    if (now - (lastRenew.get(id) ?? -Infinity) >= TV_LEASE_RENEW_MS) {
      renewRemote(id, now);
      lastRenew.set(id, now);
    }
    const rec = readTv(id);
    if (playersOfRecord.has(id)) {
      lastHeadlessBeat.delete(id);
      // Where the media ends, while a player can say: the headless beat
      // below closes the programme there once the theatre is gone. Only
      // from a player mounted for THIS programme, only an end the player
      // knows to be finite, and never one that moved within the programme
      // (noteKnownEnd; the player's unregistration files its last word too).
      const live = playersOfRecord.get(id);
      if (live) noteKnownEnd(id, live, rec);
      else if (!knownEndFor(id, rec.started)) knownEnds.delete(id);
      publishEnd(id, rec); // for whoever holds the remote next
      continue;
    }
    // Headless: free-run the clock so the room keeps a sample to anchor to.
    // A scheduled programme flips to playing at T0 the same way the theatre
    // would: readPlayback reports 'playing' past T0 to the HOLDER, and this
    // beat is the write everyone else starts on.
    const pb = readPlayback(id, now);
    if (pb.state !== 'playing' || !rec.source) {
      lastHeadlessBeat.delete(id);
      continue;
    }
    // The media ran out while nobody here was watching: over, once — as
    // the theatre's controller ends it when the holder's player ends. A
    // viewer's player ending stops nothing; without this the room would
    // read "playing" for good after the holder closed the theatre.
    const known = knownEndFor(id, rec.started);
    publishEnd(id, rec); // an end learned just before the theatre closed, not yet filed
    // What this page's own player said, else what the record carries: the
    // previous holder's player said where this programme ends, and this
    // page — handed the remote with no theatre open, never having watched
    // the file — has no player to ask. This page's own word wins, the
    // unbounded marker included.
    const end = known ? known.endMs : rec.endMs > 0 ? rec.endMs : null;
    if (end !== null && pb.positionMs >= end) {
      tvStop(id);
      lastHeadlessBeat.delete(id);
      knownEnds.delete(id);
      continue;
    }
    if (now - (lastHeadlessBeat.get(id) ?? -Infinity) >= TV_HEARTBEAT_MS) {
      tvHeartbeat(id, pb.positionMs);
      lastHeadlessBeat.set(id, now);
    }
  }
}

/** Put down every remote this client holds — called as the room is left,
 *  before its doc goes (main.ts leaveRoomNow). */
export function leaveTvRoom(itemIds: readonly string[]): void {
  driveArmed = false; // synchronously: the next tick, mid-leave, does nothing
  liveIds = [];
  for (const id of itemIds) {
    if (iHoldRemote(id)) putDownRemote(id);
  }
  lastRenew.clear();
  lastHeadlessBeat.clear();
  lastPower.clear();
  knownEnds.clear();
}

/** A set removed from the room: this client lets go of its remote and of the
 *  cadence it kept for it (World.removeFurnitureVisuals; the theatre, if it
 *  was on that set, closes beside this). */
export function forgetTv(itemId: string): void {
  if (iHoldRemote(itemId)) putDownRemote(itemId);
  lastRenew.delete(itemId);
  lastHeadlessBeat.delete(itemId);
  lastPower.delete(itemId);
  knownEnds.delete(itemId);
}
