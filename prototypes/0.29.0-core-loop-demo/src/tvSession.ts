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
  iHoldRemote, putDownRemote, readPlayback, readTv, renewRemote, tvHeartbeat,
  TV_HEARTBEAT_MS, TV_LEASE_RENEW_MS,
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

/** TVs whose playback clock a live player (the theatre) is driving. */
const playersOfRecord = new Set<string>();
export function registerTvPlayerOfRecord(itemId: string): () => void {
  playersOfRecord.add(itemId);
  return () => playersOfRecord.delete(itemId);
}
export function hasTvPlayerOfRecord(itemId: string): boolean {
  return playersOfRecord.has(itemId);
}

const lastRenew = new Map<string, number>();
const lastHeadlessBeat = new Map<string, number>();

/** Drive every TV in the room (ids of the smart-tv / tv-stand items). */
export function tickTvRoom(itemIds: readonly string[], now = Date.now()): void {
  const live = new Set(itemIds);
  for (const id of [...lastRenew.keys()]) if (!live.has(id)) lastRenew.delete(id);
  for (const id of [...lastHeadlessBeat.keys()]) if (!live.has(id)) lastHeadlessBeat.delete(id);
  for (const id of itemIds) {
    if (!iHoldRemote(id)) {
      lastRenew.delete(id);
      lastHeadlessBeat.delete(id);
      continue;
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
}

/** A set removed from the room: this client lets go of its remote and of the
 *  cadence it kept for it (World.removeFurnitureVisuals; the theatre, if it
 *  was on that set, closes beside this). */
export function forgetTv(itemId: string): void {
  if (iHoldRemote(itemId)) putDownRemote(itemId);
  lastRenew.delete(itemId);
  lastHeadlessBeat.delete(itemId);
}
