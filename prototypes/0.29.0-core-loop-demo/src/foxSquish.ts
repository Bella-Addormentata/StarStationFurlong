/**
 * 🦊🦊 #345: foxes standing side by side squish to fit (Dorkmo's idea, like
 * the clone vat's squeeze, vatGauge.ts). A fox is about 1.75 m across its
 * cheeks, wider than most spaces players stand in next to each other (the
 * double-wide arcade cabinet's stands are a metre apart), so two side by
 * side stood merged into one. Now each grows narrower toward a fox beside
 * it, taking half the space between them: on that side only, so it leans
 * away into the free side, and from both sides when it stands between two.
 * Only the drawing changes; where the player is, and so what they bump
 * into, does not. Pure, so it can be tested.
 */

import { FOX_HALF_WIDTH_M } from './sightline';

/** The narrowest a fox is squished to: half its width, the clone vat's
 *  floor too (VAT_MIN_SCALE). */
export const FOX_SQUISH_MIN = 0.5;

/** A fox counts as beside another when it is less than this far ahead of
 *  or behind it: their heads (the widest part) are level enough to meet. */
export const FOX_BESIDE_DEPTH_M = 1.0;

/** …and within this of its height (not on the bunk above it). */
const FOX_BESIDE_HEIGHT_M = 1.5;

/** Closer than this across, a fox is in front of or behind the other, not
 *  to either side, and squishing would not part them. */
const FOX_BESIDE_MIN_M = 0.1;

export interface FoxSquish {
  /** Its width, as a part of its full width: FOX_SQUISH_MIN to 1. */
  width: number;
  /** How far its middle moves toward its own +x (metres): toward the side
   *  with more room. */
  shift: number;
}

/**
 * How a fox standing at `me` (its feet), facing `facing` (the yaw it is drawn
 * at), is squished by the foxes at `others` (not itself): it keeps no more
 * than half the space across to the nearest one beside it on each side.
 */
export function foxSquish(
  me: { x: number; y: number; z: number },
  facing: number,
  others: ReadonlyArray<{ x: number; y: number; z: number }>,
): FoxSquish {
  // Its own +x across the floor, and the way it faces (+z), at that yaw.
  const ax = Math.cos(facing);
  const az = -Math.sin(facing);
  const fx = Math.sin(facing);
  const fz = Math.cos(facing);
  let plus = FOX_HALF_WIDTH_M;
  let minus = FOX_HALF_WIDTH_M;
  for (const o of others) {
    if (Math.abs(o.y - me.y) >= FOX_BESIDE_HEIGHT_M) continue;
    const dx = o.x - me.x;
    const dz = o.z - me.z;
    const across = dx * ax + dz * az;
    const ahead = dx * fx + dz * fz;
    if (Math.abs(ahead) >= FOX_BESIDE_DEPTH_M || Math.abs(across) < FOX_BESIDE_MIN_M) continue;
    const room = Math.abs(across) / 2;
    if (across > 0) plus = Math.min(plus, room);
    else minus = Math.min(minus, room);
  }
  return {
    width: Math.max(FOX_SQUISH_MIN, (plus + minus) / (2 * FOX_HALF_WIDTH_M)),
    shift: (plus - minus) / 2,
  };
}
