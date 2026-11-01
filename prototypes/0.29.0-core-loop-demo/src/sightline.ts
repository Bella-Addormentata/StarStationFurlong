/**
 * 🦊👁 #345: nobody stands in your view of what you are playing. While the
 * camera flies in to a device or is focused on it (deviceFocus.ts), another
 * player's fox whose body reaches across the line from the camera to what
 * it looks at is hidden from you: at the double-wide arcade cabinet the players beside you,
 * whose heads the camera would otherwise sit inside; at a table, whoever
 * stands at your shoulder. Anyone off that line, or beyond what you look at
 * (across a table), stays in sight. Pure, so it can be tested.
 */

/** Half a fox's width: its cheek tufts, the widest part of the chibi head
 *  (voxelCharacter.ts; sightline.test.ts measures the rig against it). */
export const FOX_HALF_WIDTH_M = 0.88;

/** A fox's height from its feet to its ear tips (voxelCharacter.ts;
 *  sightline.test.ts measures the rig against it). */
export const FOX_HEIGHT_M = 3.2;

/** A fox standing closer than this to the line of sight (on the floor) has
 *  part of its body across it, or so near it that it crowds the view: half
 *  a fox and a hand's width more. */
export const SIGHT_CLEAR_M = FOX_HALF_WIDTH_M + 0.22;

interface Xyz {
  x: number;
  y: number;
  z: number;
}

/**
 * Whether a fox standing at `at` (its feet) blocks the view from `eye` to
 * `anchor`: some point of the segment between them is within `clear` of
 * the fox across the floor, at a height between its feet and its ear tips.
 * The fox is an upright cylinder, `clear` round and FOX_HEIGHT_M tall, so a
 * camera at a device (always lower than a fox is tall) is judged on the
 * floor alone, while a camera high above, flying in from the room view
 * (#347 review), passes over foxes below its line until it comes down to
 * them. Behind the eye counts from the eye, beyond the anchor from the
 * anchor.
 */
export function blocksSight(eye: Xyz, anchor: Xyz, at: Xyz, clear: number = SIGHT_CLEAR_M): boolean {
  // The part of the segment (0 = eye, 1 = anchor) at the fox's heights.
  let t0 = 0;
  let t1 = 1;
  const dy = anchor.y - eye.y;
  if (Math.abs(dy) < 1e-9) {
    if (eye.y < at.y || eye.y > at.y + FOX_HEIGHT_M) return false;
  } else {
    const feet = (at.y - eye.y) / dy;
    const ears = (at.y + FOX_HEIGHT_M - eye.y) / dy;
    t0 = Math.max(0, Math.min(feet, ears));
    t1 = Math.min(1, Math.max(feet, ears));
    if (t0 > t1) return false;
  }
  // Across the floor the distance to the fox only falls then rises along
  // the segment, so its nearest point in that part is the nearest point of
  // the whole line, held within it.
  const dx = anchor.x - eye.x;
  const dz = anchor.z - eye.z;
  const len2 = dx * dx + dz * dz;
  const along = len2 > 0 ? ((at.x - eye.x) * dx + (at.z - eye.z) * dz) / len2 : t0;
  const t = Math.max(t0, Math.min(t1, along));
  return Math.hypot(at.x - (eye.x + t * dx), at.z - (eye.z + t * dz)) < clear;
}
