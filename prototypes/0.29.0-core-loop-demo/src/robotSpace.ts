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

/** A move is polite when, for every avatar, the robot ends up outside their
 *  personal space, or at least no closer than it already was (so a player who
 *  walks right up to the robot doesn't freeze it, it just won't step nearer). */
function polite(from: XZ, to: XZ, avatars: readonly XZ[], space: number): boolean {
  for (const a of avatars) {
    const after = Math.hypot(a.x - to.x, a.z - to.z);
    if (after >= space) continue;
    const before = Math.hypot(a.x - from.x, a.z - from.z);
    if (after < before - 1e-6) return false;
  }
  return true;
}

/**
 * Steer one walking step. `dir` is the unit direction the route wants;
 * returns the unit direction to actually walk, or null to stand and wait.
 * Straight ahead is kept when it doesn't run into anyone within LOOKAHEAD;
 * otherwise the robot swerves (away from the person first) up to 90°, taking
 * only swerves that land on free floor (`isFree`). Straight ahead skips the
 * floor check, so a robot off the walk grid still follows its route.
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
  const near = nearestAvatar(pos, avatars)!;
  const cross = dir.x * (near.avatar.z - pos.z) - dir.z * (near.avatar.x - pos.x);
  const away = cross > 0 ? -1 : 1;
  for (const angle of SWERVES) {
    for (const side of [away, -away]) {
      const a = angle * side;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const d = { x: dir.x * c + dir.z * s, z: -dir.x * s + dir.z * c };
      const to = ahead(d);
      if (!isFree(to.x, to.z)) continue;
      if (polite(pos, to, avatars, space)) return d;
    }
  }
  return null;
}

/**
 * While serving: the unit direction to step back along when the served
 * player is nearer than `standoff`, or null when the robot is far enough.
 * Never backs onto blocked floor (`isFree`) — it then just stays put.
 */
export function backOffStep(
  pos: XZ,
  from: XZ,
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
  // Probe a little past the step so the robot doesn't back into a table edge.
  const probe = Math.max(step, 0.3);
  if (!isFree(pos.x + dir.x * probe, pos.z + dir.z * probe)) return null;
  return dir;
}
