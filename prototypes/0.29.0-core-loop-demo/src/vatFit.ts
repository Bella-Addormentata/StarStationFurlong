// ── 🧬 Clone-vat aperture geometry + the avatar squeeze it implies ──────────
//
// WHAT THIS IS
//   The clone vat's doorway is not a plain rectangle: it is an HOURGLASS —
//   wide at the floor, pinched at the waist, wide again at the top. That shape
//   is a HARD LIMIT on the avatar that walks out of it (owner request, #165):
//   the fox is scaled down just far enough to pass through the pinch, then
//   eased back to full size once it has cleared the door.
//
// WHY IT LIVES IN ITS OWN MODULE
//   The same numbers have to drive two very different things: the glass shell
//   that furniture.ts BUILDS (the hole you can see) and the scale player.ts
//   APPLIES (the limit you can feel). If either side owned the shape the two
//   would drift apart and the avatar would clip a hole it nominally fits.
//   Everything here is pure arithmetic — no three.js, no DOM — so the fit is
//   unit-testable in a plain node environment and provable in isolation.
//
// FRAME
//   All lengths are metres in the vat's local frame with the tube axis at
//   (x=0, z=0) and y=0 at the floor the avatar stands on. The vat is a
//   walk-in chamber: its floor IS the room floor, so an avatar's own y=0
//   (feet) maps straight onto the aperture's y=0 and no offset is needed.

/**
 * The hourglass mouth of a clone vat, as a hard limit.
 *
 * `lobeHalfWidth` is reached at y=0 and y=`height`; `waistHalfWidth` at
 * `waistAt`·`height`. Between them the profile eases with `curve`.
 */
export interface VatAperture {
  /** Height of the mouth above the vat floor (m). Nothing taller may pass. */
  readonly height: number;
  /** Half-width at the two lobes — the mouth's widest points (m). */
  readonly lobeHalfWidth: number;
  /** Half-width at the pinched waist (m) — the limit that actually bites. */
  readonly waistHalfWidth: number;
  /** Where the waist sits as a fraction of `height` (0 = floor, 1 = top). */
  readonly waistAt: number;
  /** Lobe curvature: 1 = straight taper, >1 = a rounder, more generous waist. */
  readonly curve: number;
  /** Distance from the tube axis out to the door plane (m). The squeeze is
   *  still at full strength here and only releases beyond it. */
  readonly doorPlaneRadius: number;
  /** Largest radius the squeezed avatar may reach while it stands INSIDE the
   *  tube (m) — the glass's inner surface less a skin margin. The tail is
   *  what this constrains in practice, not the shoulders. */
  readonly innerRadius: number;
}

/** One horizontal slice of a measured rig silhouette. */
export interface SilhouetteBand {
  /** Band floor / ceiling in the rig's own frame, feet at y=0 (m). */
  readonly y0: number;
  readonly y1: number;
  /** Largest |x| (left-right half-width) anywhere in the band (m). */
  readonly halfWidth: number;
  /** Largest hypot(x, z) anywhere in the band (m) — tail included. */
  readonly maxRadius: number;
}

/** A rig measured band by band, feet at y=0. See VoxelCharacter.silhouette(). */
export interface RigSilhouette {
  /** Topmost vertex (m) — ear tips included, because they clip too. */
  readonly height: number;
  readonly bands: readonly SilhouetteBand[];
}

/** Anisotropic scale applied to the avatar while it passes the aperture. */
export interface VatSqueeze {
  /** Uniform x/z factor. Isotropic on purpose: an anisotropic horizontal
   *  squash would shear the muzzle and tail into a different creature. */
  readonly horizontal: number;
  /** y factor. Feet sit at the rig's y=0, so this shortens from the top. */
  readonly vertical: number;
}

/** Identity — no squeeze at all. */
export const NO_SQUEEZE: VatSqueeze = { horizontal: 1, vertical: 1 };

/**
 * Hard floor on either factor. A pathological aperture (or a rig that grows a
 * hat the size of the room) must never be able to collapse the avatar into a
 * sliver: we would rather show a small, honest clip than a deformed fox.
 */
export const MIN_SQUEEZE = 0.5;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Half-width of the mouth at normalised height `t` (0 = floor, 1 = top).
 * Outside [0,1] the profile is clamped to the nearest lobe — callers are
 * expected to have fitted the height first, and a clamp is safer than a
 * negative width.
 */
export function apertureHalfWidth(ap: VatAperture, t: number): number {
  const u = clamp(t, 0, 1);
  // Distance from the waist, normalised to 1 at whichever lobe we are nearest.
  // Guard both divisions: waistAt 0 or 1 degenerates the hourglass into a
  // single cone, which is still a legal (if dull) shape.
  const below = ap.waistAt > 0 ? (ap.waistAt - u) / ap.waistAt : 1;
  const above = ap.waistAt < 1 ? (u - ap.waistAt) / (1 - ap.waistAt) : 1;
  const d = clamp(u <= ap.waistAt ? below : above, 0, 1);
  const span = ap.lobeHalfWidth - ap.waistHalfWidth;
  return ap.waistHalfWidth + span * Math.pow(d, ap.curve);
}

/** Half-width of the mouth at an absolute height above the vat floor (m). */
export function apertureHalfWidthAtY(ap: VatAperture, y: number): number {
  return apertureHalfWidth(ap, ap.height > 0 ? y / ap.height : 0);
}

/**
 * Tightest half-width the mouth offers anywhere in [y0, y1] (m).
 *
 * Solved exactly rather than sampled: the profile is monotonic on each side
 * of the waist, so the minimum is AT the waist when the interval straddles
 * it, and at the interval end nearest the waist otherwise. Sampling would
 * have to be dense enough to not step over a narrow waist — this cannot.
 */
export function minApertureHalfWidth(
  ap: VatAperture,
  y0: number,
  y1: number,
): number {
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  const yWaist = ap.waistAt * ap.height;
  if (lo <= yWaist && yWaist <= hi) return ap.waistHalfWidth;
  return apertureHalfWidthAtY(ap, hi < yWaist ? hi : lo);
}

/**
 * Largest scale that fits `rig` through `ap` — the whole point of the module.
 *
 * Two independent limits, both of which must hold:
 *   • the HOURGLASS, band by band, after the vertical fit has moved each band
 *     to the height it will actually occupy; and
 *   • the TUBE, because the squeezed avatar also has to stand inside the
 *     glass before the door opens (the tail is 1.1 m of lever arm).
 * The result is never above 1 (we shrink to fit, never inflate to fill) and
 * never below MIN_SQUEEZE.
 */
export function fitVatSqueeze(
  rig: RigSilhouette,
  ap: VatAperture,
): VatSqueeze {
  const vertical = clamp(
    rig.height > 0 ? ap.height / rig.height : 1,
    MIN_SQUEEZE,
    1,
  );
  let horizontal = 1;
  for (const band of rig.bands) {
    if (band.halfWidth > 0) {
      const limit = minApertureHalfWidth(
        ap,
        band.y0 * vertical,
        band.y1 * vertical,
      );
      horizontal = Math.min(horizontal, limit / band.halfWidth);
    }
    if (band.maxRadius > 0) {
      horizontal = Math.min(horizontal, ap.innerRadius / band.maxRadius);
    }
  }
  return { horizontal: clamp(horizontal, MIN_SQUEEZE, 1), vertical };
}

/**
 * How much of the squeeze applies at `distFromAxis` metres out from the tube
 * axis, during the walk-out: 1 (full squeeze) anywhere up to the door plane,
 * easing to 0 (natural size) exactly as the avatar reaches its exit tile.
 *
 * Distance-driven, not time-driven, so a slower walk does not change where
 * the fox regains its shape — it always happens in the doorway.
 */
export function vatSqueezeWeight(
  distFromAxis: number,
  doorPlaneRadius: number,
  exitDist: number,
): number {
  if (distFromAxis <= doorPlaneRadius) return 1;
  const span = exitDist - doorPlaneRadius;
  if (span <= 0) return 0; // degenerate: exit inside the door plane
  return clamp((exitDist - distFromAxis) / span, 0, 1);
}

/** Blend between no squeeze and a fitted one. weight 1 = fully squeezed. */
export function lerpSqueeze(fit: VatSqueeze, weight: number): VatSqueeze {
  const w = clamp(weight, 0, 1);
  return {
    horizontal: 1 + (fit.horizontal - 1) * w,
    vertical: 1 + (fit.vertical - 1) * w,
  };
}
