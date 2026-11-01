/**
 * 🦊👁 #345: nobody stands in your view of what you are playing. While the
 * camera is focused on a device (deviceFocus.ts), another player's fox whose
 * body reaches across the line from the camera to what it looks at is
 * hidden from you: at the double-wide arcade cabinet the players beside you,
 * whose heads the camera would otherwise sit inside; at a table, whoever
 * stands at your shoulder. Anyone off that line, or beyond what you look at
 * (across a table), stays in sight. Pure, so it can be tested.
 */

/** Half a fox's width: its cheek tufts, the widest part of the chibi head
 *  (voxelCharacter.ts; sightline.test.ts measures the rig against it). */
export const FOX_HALF_WIDTH_M = 0.88;

/** A fox standing closer than this to the line of sight (on the floor) has
 *  part of its body across it, or so near it that it crowds the view: half
 *  a fox and a hand's width more. */
export const SIGHT_CLEAR_M = FOX_HALF_WIDTH_M + 0.22;

interface Xz {
  x: number;
  z: number;
}

/**
 * Whether a fox standing at `at` blocks the view from `eye` to `anchor`: it
 * stands within `clear` of the segment between them, measured on the floor
 * (a fox is taller than any focus camera is high, so height never clears
 * it). Behind the eye counts from the eye, beyond the anchor from the anchor.
 */
export function blocksSight(eye: Xz, anchor: Xz, at: Xz, clear: number = SIGHT_CLEAR_M): boolean {
  const dx = anchor.x - eye.x;
  const dz = anchor.z - eye.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((at.x - eye.x) * dx + (at.z - eye.z) * dz) / len2)) : 0;
  return Math.hypot(at.x - (eye.x + t * dx), at.z - (eye.z + t * dz)) < clear;
}
