/**
 * 🕹🕹🕹🕹 The double-wide arcade cabinet's stations: which one a player
 * means when they click the cabinet. Each station (a stick, two buttons and
 * a coin door, lit in its player's colour) has a stand a pace back from it,
 * and the stand's index is the seat: station 1 is player 1 in the game.
 * Pure (World passes in the free stands, where the player is and where the
 * click met the cabinet), so it can be tested.
 */

import type { StandSlot } from './furniture';

/** Within this of a station's stand, a player has walked up to that
 *  station: its seat is theirs when they click the screens. */
export const WIDE_STAND_AT_M = 0.6;

/** Where a click met the cabinet, and the station it was on (its seat), or
 *  null for the screens or the body. */
export interface WideClick {
  x: number;
  z: number;
  station: number | null;
}

/** A click that met the cabinet at world `point` on `mesh`: on a station
 *  when the mesh is one of a station's (buildWideArcadeCabinet tags each
 *  stick, button and coin door with `userData.arcadeStation`). */
export function wideClick(
  point: { x: number; z: number },
  mesh: { userData: Record<string, unknown> },
): WideClick {
  const station = mesh.userData.arcadeStation;
  return { x: point.x, z: point.z, station: typeof station === 'number' ? station : null };
}

/** A stand's seat, from its id (`${itemId}:s${n}`). */
const standSeat = (s: StandSlot): number => Number(s.id.slice(s.id.lastIndexOf(':s') + 2));

/**
 * Of the cabinet's stands (`all`, its four; `free`, those a player may take),
 * the one a player at `me` means: the station they clicked (its stick,
 * buttons or coin door), by its seat, wherever its stand had to be moved to
 * be walkable; else, clicking the screens, the station they have walked up
 * to (its stand within WIDE_STAND_AT_M of them); else the free one nearest
 * the click, or them. A station clicked or walked up to that is taken gives
 * the free one nearest the click. Null when none is free.
 */
export function wideStationFor(
  all: readonly StandSlot[],
  free: readonly StandSlot[],
  me: { x: number; z: number },
  click?: WideClick,
): StandSlot | null {
  const dist = (s: StandSlot, p: { x: number; z: number }) => Math.hypot(s.front.x - p.x, s.front.z - p.z);
  const nearest = (of: readonly StandSlot[], p: { x: number; z: number }) =>
    of.reduce<StandSlot | null>((best, s) => (best === null || dist(s, p) < dist(best, p) ? s : best), null);
  if (click && click.station !== null) {
    return free.find((s) => standSeat(s) === click.station) ?? nearest(free, click);
  }
  const here = nearest(all, me);
  if (here && dist(here, me) < WIDE_STAND_AT_M && free.includes(here)) return here;
  return nearest(free, click ?? me);
}
