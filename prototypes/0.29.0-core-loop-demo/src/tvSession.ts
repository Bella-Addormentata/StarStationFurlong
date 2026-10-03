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
  claimRemote, iHoldRemote, putDownRemote, readPlayback, readPower, readProgramme, readTv, renewRemote,
  tvDocEpoch, tvHeartbeat, tvPause, TV_HEARTBEAT_MS, TV_LEASE_RENEW_MS,
} from './tvDoc';

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
}

/** TVs whose playback clock a live player (the theatre) is driving. */
const playersOfRecord = new Map<string, LivePlayer | null>();
export function registerTvPlayerOfRecord(itemId: string, live?: LivePlayer): () => void {
  playersOfRecord.set(itemId, live ?? null);
  return () => { playersOfRecord.delete(itemId); };
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
  jump: number;
  epoch: number;
}
const lastPower = new Map<string, SeenPower>();
function seePower(id: string): SeenPower | undefined {
  const seen = { on: readPower(id).on, jump: readProgramme(id).jump, epoch: tvDocEpoch() };
  const was = lastPower.get(id);
  lastPower.set(id, seen);
  return was && was.epoch === seen.epoch ? was : undefined;
}

/** Drive every TV in the room (ids of the smart-tv / tv-stand items). */
export function tickTvRoom(itemIds: readonly string[], now = Date.now()): void {
  const live = new Set(itemIds);
  for (const id of [...lastRenew.keys()]) if (!live.has(id)) lastRenew.delete(id);
  for (const id of [...lastHeadlessBeat.keys()]) if (!live.has(id)) lastHeadlessBeat.delete(id);
  for (const id of [...lastPower.keys()]) if (!live.has(id)) lastPower.delete(id);
  for (const id of itemIds) {
    // A remote handed to my identity is nobody's page yet: this page takes
    // it (two tabs, one key — the first to tick wins, the other stays a
    // viewer). The claim refreshes the lease, so it is this tick's renewal
    // too, and `by` stays the giver until the next one: the phone's cue.
    if (claimRemote(id, now)) lastRenew.set(id, now);
    if (!iHoldRemote(id)) {
      lastRenew.delete(id);
      lastHeadlessBeat.delete(id);
      seePower(id);
      continue;
    }
    // POWER back on with the programme still 'playing' from before the set
    // went off, and untouched since (its `jump` where it was — PLAY NOW
    // turns the set on too, and that is a new programme): the holder parks
    // it where it was. The body button lives in its own key and never
    // touches the programme's slot — that write is the holder's, here.
    const was = seePower(id);
    const programme = readProgramme(id);
    if (was && !was.on && readPower(id).on && programme.jump === was.jump && programme.state === 'playing') {
      tvPause(id, programme.positionMs);
    }
    if (now - (lastRenew.get(id) ?? -Infinity) >= TV_LEASE_RENEW_MS) {
      renewRemote(id, now);
      lastRenew.set(id, now);
    }
    if (playersOfRecord.has(id)) {
      lastHeadlessBeat.delete(id);
      continue;
    }
    const rec = readTv(id);
    // Headless: free-run the clock so the room keeps a sample to anchor to.
    // A scheduled programme flips to playing at T0 the same way the theatre
    // would: readPlayback reports 'playing' past T0 to the HOLDER, and this
    // beat is the write everyone else starts on.
    const pb = readPlayback(id, now);
    if (pb.state !== 'playing' || !rec.source) {
      lastHeadlessBeat.delete(id);
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
  for (const id of itemIds) {
    if (iHoldRemote(id)) putDownRemote(id);
  }
  lastRenew.clear();
  lastHeadlessBeat.clear();
  lastPower.clear();
}

/** A set removed from the room: this client lets go of its remote and of the
 *  cadence it kept for it (World.removeFurnitureVisuals; the theatre, if it
 *  was on that set, closes beside this). */
export function forgetTv(itemId: string): void {
  if (iHoldRemote(itemId)) putDownRemote(itemId);
  lastRenew.delete(itemId);
  lastHeadlessBeat.delete(itemId);
  lastPower.delete(itemId);
}
