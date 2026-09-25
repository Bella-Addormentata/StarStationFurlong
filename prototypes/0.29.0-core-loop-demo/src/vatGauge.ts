/**
 * 🧬⏳ Clone-vat clearance gauge (#165) — the one authority for the tank's
 * dimensions and for the hourglass-shaped HARD LIMIT the avatar is squeezed
 * to while it is held in the tank and while it walks out of it.
 *
 * Why a gauge at all: the chibi fox is ~3.2 m tall and ~1.75 m across the
 * cheek ruffs, far bigger than any tank that still reads as furniture, so a
 * full-size avatar always poked through the glass and the door. Instead the
 * spawn choreography scales the avatar (plan-uniform in x/z, separately in y)
 * to the largest size whose whole silhouette fits the gauge at its current
 * position — a hard limit, never exceeded, sampled every frame.
 *
 * The gauge, in plan along the exit axis (q = metres from the vat's axis
 * toward the door; the door faces +q):
 *
 *        tank bulb           neck        room bulb
 *      ╭───────────╮                 ╱
 *     (   round     )═══════════════(    flares back out to full size
 *      ╰───────────╯                 ╲
 *     −R           q_neck  ↔  q_lip
 *
 *  - TANK BULB (q < Q_NECK): the round glass interior — half-width is the
 *    circle's chord at q — under the cap; a funnel of the neck's size
 *    narrowing toward the door is intersected in so the limit is continuous.
 *  - NECK (Q_NECK ≤ q ≤ Q_LIP): the doorway, from the chord line between the
 *    two door-edge rails out to the transom glass on the arc. Half-width is
 *    the rail gap, height is the door leaf's (a fixed transom sits above it).
 *  - ROOM BULB (q > Q_LIP): a cone opening at FLARE_W / FLARE_H per metre, so
 *    the avatar eases back to full size instead of popping.
 *
 * Every dimension below also drives the mesh (furniture.ts buildCloneVat),
 * so the gauge and the glass can never drift apart.
 */

// ── Tank geometry (local frame: door faces +z, origin on the floor) ──────────

/** Glass tube radius — the tank fills the 2×2 footprint (±1 m). */
export const VAT_GLASS_R = 0.8;
/** Glass tube bottom (it sits just inside the plinth). */
export const VAT_GLASS_BASE_Y = 0.08;
/** Glass tube height; the cap sits on its top edge. */
export const VAT_GLASS_H = 2.7;
/** Plinth outer radius — the lip the avatar steps down from. */
export const VAT_PLINTH_R = 0.92;
/**
 * The interior floor pad the avatar stands on while inside. Kept LOW on
 * purpose: the clone steps off it with its heels and drooping tail (~0.13 m
 * off the floor) still over the plinth, so a tall plinth would swallow them
 * on the way down.
 */
export const VAT_PAD_Y = 0.1;
/** Front door leaf arc (the rest of the tube is the fixed back shell). */
export const VAT_DOOR_ARC = (Math.PI * 7) / 9; // 140°
/** Top of the door leaf; the fixed transom band fills the tube above it. */
export const VAT_DOOR_TOP_Y = 2.49;
/** Radius the spinning door leaf (and its edge rails) sweep around the axis. */
export const VAT_DOOR_SWEEP_R = VAT_GLASS_R + 0.04;

/** Margin the avatar's silhouette keeps from the glass, rails and cap. */
export const VAT_CLEARANCE = 0.05;

// ── Avatar silhouette ─────────────────────────────────────────────────────────

/**
 * One 0.1 m slice of the avatar along its facing axis (+z = muzzle, −z =
 * tail): the widest |x| and the highest point of that slice.
 */
export interface AvatarSlice {
  z0: number;
  z1: number;
  halfWidth: number;
  top: number;
}

/**
 * Plan silhouette of the fox rig (voxelCharacter.ts), MEASURED from its mesh
 * vertices over the idle and walk cycles (walk bob, tail sway and arm swing
 * included) and rounded up. Re-measure if the rig's proportions change.
 * The tail plume trails behind (z < −0.7); the head is widest at z ≈ 0.05 and
 * the ear tips are highest at z ≈ −0.2.
 */
export const AVATAR_SILHOUETTE: readonly AvatarSlice[] = [
  { z0: -1.2, z1: -1.1, halfWidth: 0.15, top: 1.13 },
  { z0: -1.1, z1: -1.0, halfWidth: 0.42, top: 1.25 },
  { z0: -1.0, z1: -0.9, halfWidth: 0.55, top: 1.39 },
  { z0: -0.9, z1: -0.8, halfWidth: 0.6, top: 1.4 },
  { z0: -0.8, z1: -0.7, halfWidth: 0.61, top: 2.08 },
  { z0: -0.7, z1: -0.6, halfWidth: 0.61, top: 2.3 },
  { z0: -0.6, z1: -0.5, halfWidth: 0.59, top: 3.03 },
  { z0: -0.5, z1: -0.4, halfWidth: 0.58, top: 3.08 },
  { z0: -0.4, z1: -0.3, halfWidth: 0.65, top: 3.11 },
  { z0: -0.3, z1: -0.2, halfWidth: 0.72, top: 3.23 },
  { z0: -0.2, z1: -0.1, halfWidth: 0.72, top: 3.23 },
  { z0: -0.1, z1: 0.0, halfWidth: 0.78, top: 3.23 },
  { z0: 0.0, z1: 0.1, halfWidth: 0.88, top: 2.84 },
  { z0: 0.1, z1: 0.2, halfWidth: 0.86, top: 2.77 },
  { z0: 0.2, z1: 0.3, halfWidth: 0.74, top: 2.73 },
  { z0: 0.3, z1: 0.4, halfWidth: 0.65, top: 2.55 },
  { z0: 0.4, z1: 0.5, halfWidth: 0.53, top: 2.45 },
  { z0: 0.5, z1: 0.6, halfWidth: 0.34, top: 2.01 },
  { z0: 0.6, z1: 0.7, halfWidth: 0.08, top: 1.97 },
];

/** Tail tip — the silhouette's rearmost point (door-clearance test). */
const AVATAR_BACK = -AVATAR_SILHOUETTE[0].z0;

/** The silhouette's horizontal reach from its root in ANY direction (the
 *  tail tip) — the door-clearance test once the clone may face anywhere. */
export const AVATAR_REACH = Math.max(
  ...AVATAR_SILHOUETTE.map((s) =>
    Math.hypot(s.halfWidth, Math.max(Math.abs(s.z0), Math.abs(s.z1))),
  ),
);

// ── The hourglass ─────────────────────────────────────────────────────────────

const R_IN = VAT_GLASS_R - VAT_CLEARANCE;
/** Chord line between the two door-edge rails — where the neck begins. */
export const VAT_Q_NECK = VAT_GLASS_R * Math.cos(VAT_DOOR_ARC / 2);
/** Outer face of the transom/door arc — where the neck ends. */
export const VAT_Q_LIP = VAT_DOOR_SWEEP_R;
/** Neck half-width: the tank's chord at the rail line (inside the rails). */
export const VAT_NECK_HALF_W = Math.sqrt(R_IN * R_IN - VAT_Q_NECK * VAT_Q_NECK);
/** Neck height above the pad: under the transom. */
export const VAT_NECK_H = VAT_DOOR_TOP_Y - VAT_PAD_Y - VAT_CLEARANCE;
/** Tank bulb height above the pad: under the cap. */
export const VAT_TANK_H = VAT_GLASS_BASE_Y + VAT_GLASS_H - VAT_PAD_Y - VAT_CLEARANCE;
/** Half-width the gauge gains per metre away from the neck (both bulbs). */
export const VAT_FLARE_W = 0.5;
/** Height the gauge gains per metre away from the neck (both bulbs). */
export const VAT_FLARE_H = 1.2;

export interface VatGauge {
  /** Max |x| (metres) any part of the avatar may reach at this q. */
  halfWidth: number;
  /** Max height above the surface the avatar stands on at this q. */
  height: number;
}

/** The hourglass hard limit at q (metres from the vat axis toward the door). */
export function vatGaugeAt(q: number): VatGauge {
  if (q < VAT_Q_NECK) {
    const into = VAT_Q_NECK - q;
    return {
      halfWidth: Math.min(
        Math.sqrt(Math.max(0, R_IN * R_IN - q * q)),
        VAT_NECK_HALF_W + VAT_FLARE_W * into,
      ),
      height: Math.min(VAT_TANK_H, VAT_NECK_H + VAT_FLARE_H * into),
    };
  }
  if (q <= VAT_Q_LIP) return { halfWidth: VAT_NECK_HALF_W, height: VAT_NECK_H };
  const out = q - VAT_Q_LIP;
  return {
    halfWidth: VAT_NECK_HALF_W + VAT_FLARE_W * out,
    height: VAT_NECK_H + VAT_FLARE_H * out,
  };
}

/**
 * The tightest gauge anywhere in [q0, q1]. Both profiles only ever narrow
 * toward the neck (the tank bulb's back wall aside, which the endpoints
 * catch), so the minimum sits at an endpoint or at the neck point nearest
 * the span.
 */
function tightestIn(q0: number, q1: number): VatGauge {
  const a = vatGaugeAt(q0);
  const b = vatGaugeAt(q1);
  const n = vatGaugeAt(Math.min(Math.max(VAT_Q_NECK, q0), q1));
  return {
    halfWidth: Math.min(a.halfWidth, b.halfWidth, n.halfWidth),
    height: Math.min(a.height, b.height, n.height),
  };
}

/** The smallest the avatar is ever squeezed to — a floor the walk-out never
 *  reaches (tests pin that); only a root placed behind the vat's axis, where
 *  the tail would have to leave the tank, could hit it. */
export const VAT_MIN_SCALE = 0.5;

export interface VatSqueeze {
  /** Plan scale — applied to x and z alike. */
  horizontal: number;
  /** Height scale — applied to y. */
  vertical: number;
}

/** Does the whole silhouette, plan-scaled by `s`, fit the gauge's width? */
function fitsWidth(along: number, s: number): boolean {
  for (const slice of AVATAR_SILHOUETTE) {
    const g = tightestIn(along + s * slice.z0, along + s * slice.z1);
    if (s * slice.halfWidth > g.halfWidth) return false;
  }
  return true;
}

/**
 * The avatar's scale with its root at `along` (metres from the vat axis
 * toward the door, avatar facing the door): the LARGEST plan scale whose
 * silhouette fits the gauge's half-width everywhere it reaches, then the
 * largest height scale that fits the gauge's height over that same footprint.
 */
export function vatSqueezeAt(along: number): VatSqueeze {
  // Coarse scan down from full size, then bisect the boundary so the scale
  // varies smoothly with position instead of in 2 % steps.
  const STEP = 0.02;
  let horizontal = VAT_MIN_SCALE;
  for (let s = 1; s >= VAT_MIN_SCALE; s -= STEP) {
    if (fitsWidth(along, s)) {
      let lo = s;
      let hi = Math.min(1, s + STEP);
      if (hi > lo && !fitsWidth(along, hi)) {
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (fitsWidth(along, mid)) lo = mid;
          else hi = mid;
        }
      } else {
        lo = hi;
      }
      horizontal = lo;
      break;
    }
  }
  let vertical = 1;
  for (const slice of AVATAR_SILHOUETTE) {
    const g = tightestIn(
      along + horizontal * slice.z0,
      along + horizontal * slice.z1,
    );
    vertical = Math.min(vertical, g.height / slice.top);
  }
  return { horizontal, vertical: Math.max(VAT_MIN_SCALE, vertical) };
}

/** Is every part of the (plan-scaled) avatar outside the door leaf's sweep —
 *  i.e. may the door spin shut without cutting through the tail? */
export function vatDoorClear(along: number, horizontal: number): boolean {
  return along - horizontal * AVATAR_BACK > VAT_DOOR_SWEEP_R + VAT_CLEARANCE;
}

/** A released clone `distance` metres from the vat axis, plan-scaled by
 *  `horizontal` and facing anywhere: is all of it past the door's sweep? */
export function vatClearOfDoorAt(distance: number, horizontal: number): boolean {
  return distance - horizontal * AVATAR_REACH > VAT_DOOR_SWEEP_R + VAT_CLEARANCE;
}

/** An axis-aligned floor box (structurally furniture.ts's Box). */
export interface VatFloorBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Half the vat's 2×2 footprint (furniture.ts FURNITURE_DEFS["clone-vat"]). */
export const VAT_FOOTPRINT_HALF = 1;

/** Is (x, z) off-limits for a player of collision radius `radius`: outside
 *  the walkable box, or inside an obstacle inflated by the radius? */
function spotBlocked(
  x: number,
  z: number,
  obstacles: readonly VatFloorBox[],
  bounds: { boundX: number; boundZ: number },
  radius: number,
  skip?: (b: VatFloorBox) => boolean,
): boolean {
  if (Math.abs(x) > bounds.boundX + 1e-9 || Math.abs(z) > bounds.boundZ + 1e-9) {
    return true;
  }
  return obstacles.some(
    (b) =>
      !skip?.(b) &&
      x > b.x0 - radius &&
      x < b.x1 + radius &&
      z > b.z0 - radius &&
      z < b.z1 + radius,
  );
}

/**
 * How far out (metres from the vat axis) the scripted walk-out can go in
 * this room: VAT_EXIT_ALONG when the whole path is free, else the last free
 * spot (5 cm steps) before the path leaves the walkable box or comes within
 * `radius` of another obstacle — a movable vat can face a wall or furniture.
 * The vat's own footprint is where the walk starts, so it is ignored along
 * the way; but the end must clear it too (VAT_FOOTPRINT_HALF + radius out)
 * to be a genuinely collision-free spot. null when the path is blocked
 * before that — no walk-out can end anywhere valid (vatFallbackRelease).
 */
export function vatFreeExitAlong(
  centre: { x: number; z: number },
  facing: number,
  obstacles: readonly VatFloorBox[],
  bounds: { boundX: number; boundZ: number },
  radius: number,
): number | null {
  const dirX = Math.sin(facing);
  const dirZ = Math.cos(facing);
  const isOwn = (b: VatFloorBox) =>
    centre.x > b.x0 && centre.x < b.x1 && centre.z > b.z0 && centre.z < b.z1;
  let free: number | null = null;
  for (let along = VAT_PLINTH_R; ; along = Math.min(VAT_EXIT_ALONG, along + 0.05)) {
    const x = centre.x + dirX * along;
    const z = centre.z + dirZ * along;
    if (spotBlocked(x, z, obstacles, bounds, radius, isOwn)) break;
    free = along;
    if (along >= VAT_EXIT_ALONG) break;
  }
  return free !== null && free >= VAT_FOOTPRINT_HALF + radius ? free : null;
}

/**
 * Where a clone steps out when its door path is blocked (vatFreeExitAlong
 * gave null): the nearest collision-free spot around the vat — rings from
 * just clear of its footprint outward, door side first — or null when the
 * room has no free spot within 4 m.
 */
export function vatFallbackRelease(
  centre: { x: number; z: number },
  facing: number,
  obstacles: readonly VatFloorBox[],
  bounds: { boundX: number; boundZ: number },
  radius: number,
): { x: number; z: number } | null {
  for (let r = VAT_FOOTPRINT_HALF + radius + 0.05; r <= 4; r += 0.25) {
    for (let k = 0; k < 16; k++) {
      const turn = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const x = centre.x + Math.sin(facing + turn) * r;
      const z = centre.z + Math.cos(facing + turn) * r;
      if (!spotBlocked(x, z, obstacles, bounds, radius)) return { x, z };
    }
  }
  return null;
}

/** Root height while walking out: on the pad inside, easing down off the
 *  plinth lip from when the front foot reaches it until the heels are past
 *  it, on the floor beyond. */
export function vatFloorY(along: number): number {
  const from = VAT_PLINTH_R - 0.12;
  const to = VAT_PLINTH_R + 0.3;
  if (along <= from) return VAT_PAD_Y;
  if (along >= to) return 0;
  const t = (along - from) / (to - from);
  return VAT_PAD_Y * (1 - t * t * (3 - 2 * t));
}

/** Where the held clone stands (metres toward the door): the spot inside the
 *  tank that lets it be held largest. Scanned once at module load, on a
 *  centimetre grid. */
export const VAT_HOLD_ALONG: number = (() => {
  let best = 0;
  let bestSize = -1;
  for (let cm = 0; cm <= 50; cm++) {
    const s = vatSqueezeAt(cm / 100);
    const size = s.horizontal * s.vertical;
    if (size > bestSize + 1e-9) {
      bestSize = size;
      best = cm / 100;
    }
  }
  return best;
})();

/** Where the scripted walk-out ends (metres toward the door): the first spot
 *  at which the avatar is back to full size AND clear of the door's sweep, so
 *  the door can close behind it and control returns with no pop. Scanned
 *  once at module load, on a centimetre grid. */
export const VAT_EXIT_ALONG: number = (() => {
  for (let cm = Math.ceil(VAT_Q_LIP * 100); cm < 400; cm++) {
    const a = cm / 100;
    const s = vatSqueezeAt(a);
    if (s.horizontal >= 1 && s.vertical >= 1 && vatDoorClear(a, 1)) return a;
  }
  return 4;
})();
