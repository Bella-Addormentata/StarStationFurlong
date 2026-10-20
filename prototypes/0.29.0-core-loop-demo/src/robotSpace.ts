/**
 * 🤖↔🦊 Robot personal space (owner request 2026-10-20).
 *
 * Robots used to follow their A* route straight through whoever stood on it —
 * at the craps rail the drink server walked into the shooter's avatar and
 * filled the camera. These pure helpers keep a robot out of every avatar's
 * personal space: steer round a player in the way (or wait if there's no
 * room), skip route points somebody is standing on, and back off to a polite
 * hand-over distance while serving. Pure so the rules are testable without a
 * scene; poolWaiter.ts applies them every frame.
 */

export interface XZ {
  x: number;
  z: number;
}

/** Closest a walking robot comes to an avatar (centre to centre). The fox is
 *  PLAYER_R 0.38 wide and the ×1.4 robot about 0.35, so this leaves a clear
 *  gap of about a quarter metre even when brushing past. */
export const PERSONAL_SPACE = 1.0;
/** How far ahead a walking robot looks for someone in its way, so it starts
 *  to swing round early instead of stopping nose to nose. */
export const LOOKAHEAD = 0.6;
/** Distance the robot holds while a drink is handed over and sipped. */
export const SERVE_STANDOFF = 1.3;

/** Turns tried when the way ahead is blocked, in radians (≈30°, 60°, 90°). */
const SWERVES = [Math.PI / 6, Math.PI / 3, Math.PI / 2];

/** Nearest avatar to `p`, or null when there are none. */
export function nearestAvatar(
  p: XZ,
  avatars: readonly XZ[],
): { avatar: XZ; dist: number } | null {
  let best: { avatar: XZ; dist: number } | null = null;
  for (const a of avatars) {
    const d = Math.hypot(a.x - p.x, a.z - p.z);
    if (!best || d < best.dist) best = { avatar: a, dist: d };
  }
  return best;
}

/** True when somebody stands within `radius` of `p` — a route point or goal
 *  there can't be reached without walking over them. */
export function occupied(p: XZ, avatars: readonly XZ[], radius = PERSONAL_SPACE): boolean {
  const n = nearestAvatar(p, avatars);
  return !!n && n.dist < radius;
}

/** Closest distance from `a` to the segment `from`→`to`. */
function segmentDist(a: XZ, from: XZ, to: XZ): number {
  const vx = to.x - from.x;
  const vz = to.z - from.z;
  const len2 = vx * vx + vz * vz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((a.x - from.x) * vx + (a.z - from.z) * vz) / len2)) : 0;
  return Math.hypot(a.x - (from.x + vx * t), a.z - (from.z + vz * t));
}

/** A move is polite when, for every avatar, the robot stays outside their
 *  personal space along the WHOLE move, or at least never gets closer than
 *  it already was (so a player who walks right up to the robot doesn't
 *  freeze it, it just won't step nearer). */
function polite(from: XZ, to: XZ, avatars: readonly XZ[], space: number): boolean {
  for (const a of avatars) {
    const closest = segmentDist(a, from, to);
    if (closest >= space) continue;
    const before = Math.hypot(a.x - from.x, a.z - from.z);
    if (closest < before - 1e-6) return false;
  }
  return true;
}

/** Spacing of the floor samples along a move — well under a 0.5 m walk-grid
 *  cell, so a swerve can't skip over a blocked cell or clip a table corner. */
const FLOOR_SAMPLE = 0.1;

/** True when every floor sample from `from` to `to` (excluding the start,
 *  where the robot already stands) is free. */
export function segmentFree(
  from: XZ,
  to: XZ,
  isFree: (x: number, z: number) => boolean,
): boolean {
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  const n = Math.max(1, Math.ceil(len / FLOOR_SAMPLE));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!isFree(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)) return false;
  }
  return true;
}

/**
 * Steer one walking step. `dir` is the unit direction the route wants;
 * returns the unit direction to actually walk, or null to stand and wait.
 * Straight ahead is kept when it doesn't run into anyone within LOOKAHEAD;
 * otherwise the robot swerves (away from the person first) up to 90°, taking
 * only swerves whose whole lookahead runs over free floor (`isFree`).
 * Straight ahead skips the floor check, so a robot off the walk grid still
 * follows its route.
 */
export function steerStep(
  pos: XZ,
  dir: XZ,
  avatars: readonly XZ[],
  isFree: (x: number, z: number) => boolean,
  space = PERSONAL_SPACE,
): XZ | null {
  if (avatars.length === 0) return dir;
  const ahead = (d: XZ): XZ => ({ x: pos.x + d.x * LOOKAHEAD, z: pos.z + d.z * LOOKAHEAD });
  if (polite(pos, ahead(dir), avatars, space)) return dir;

  // Swerve away from whoever is nearest first: the side they are NOT on.
  // cross > 0 ⇒ the avatar is on the side a NEGATIVE angle below turns
  // toward, so the away side is the positive angle.
  const near = nearestAvatar(pos, avatars)!;
  const cross = dir.x * (near.avatar.z - pos.z) - dir.z * (near.avatar.x - pos.x);
  const away = cross > 0 ? 1 : -1;
  for (const angle of SWERVES) {
    for (const side of [away, -away]) {
      const a = angle * side;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const d = { x: dir.x * c + dir.z * s, z: -dir.x * s + dir.z * c };
      const to = ahead(d);
      if (!segmentFree(pos, to, isFree)) continue;
      if (polite(pos, to, avatars, space)) return d;
    }
  }
  return null;
}

/**
 * While serving: the unit direction to step back along when the served
 * player (`from`) is nearer than `standoff`, or null when the robot is far
 * enough. Stays put rather than back onto blocked floor (`isFree`) or into
 * anyone else's personal space (`avatars`, which may include `from`).
 */
export function backOffStep(
  pos: XZ,
  from: XZ,
  avatars: readonly XZ[],
  isFree: (x: number, z: number) => boolean,
  step: number,
  standoff = SERVE_STANDOFF,
): XZ | null {
  const dx = pos.x - from.x;
  const dz = pos.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d >= standoff) return null;
  // Exactly on top: any consistent direction will do.
  const dir = d > 1e-4 ? { x: dx / d, z: dz / d } : { x: 0, z: 1 };
  // Probe a little past the step so the robot doesn't back into a table edge
  // or towards somebody standing behind it.
  const probe = Math.max(step, 0.3);
  const to = { x: pos.x + dir.x * probe, z: pos.z + dir.z * probe };
  if (!segmentFree(pos, to, isFree)) return null;
  if (!polite(pos, to, avatars, PERSONAL_SPACE)) return null;
  return dir;
}
