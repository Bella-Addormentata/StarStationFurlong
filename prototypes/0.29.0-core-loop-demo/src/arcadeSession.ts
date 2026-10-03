/**
 * 🕹 arcadeSession — the room-level duties around the cabinets, ticked by
 * World every half second (the TV's tickTvRoom idiom) and DOM-free so they
 * can be tested:
 *
 *  - the P1 page renews its seat every ARCADE_SEAT_RENEW_MS, so the seat
 *    lapses on every other page when this one goes away;
 *  - leaving the room stands up from every cabinet this page holds (the
 *    TV remote's hand-back on leave).
 */

import { iAmP1, renewSeat, standUp, ARCADE_SEAT_RENEW_MS } from './arcadeDoc';

const lastRenew = new Map<string, number>();

/** Drive every cabinet in the room (ids of the arcade-cabinet items). */
export function tickArcadeRoom(itemIds: readonly string[], now = Date.now()): void {
  const live = new Set(itemIds);
  for (const id of [...lastRenew.keys()]) if (!live.has(id)) lastRenew.delete(id);
  for (const id of itemIds) {
    if (!iAmP1(id)) {
      lastRenew.delete(id);
      continue;
    }
    if (now - (lastRenew.get(id) ?? -Infinity) >= ARCADE_SEAT_RENEW_MS) {
      renewSeat(id, now);
      lastRenew.set(id, now);
    }
  }
}

/** Stand up from every cabinet this page holds — called as the room is
 *  left, before its doc goes (main.ts leaveRoomNow). */
export function leaveArcadeRoom(itemIds: readonly string[]): void {
  for (const id of itemIds) {
    if (iAmP1(id)) standUp(id);
  }
  lastRenew.clear();
}
