/**
 * 🧭 #102 T2 — Vestibule proximity-fade TARGET math.
 *
 * Pure, framework-free: given the avatar's distance to a door front, whether
 * the vestibule is CURRENTLY opaque enough to be "materialising" (opacity >
 * 0.5), and the three fade thresholds, return the opacity value the fade
 * chase-lerp should aim for THIS frame. The chase itself lives in world.ts
 * where it can hold live meshes and delta-time.
 *
 * Extracted so:
 *   - the three-band hysteresis is unit-testable without a live scene, and
 *   - the fix for the round-1 audit note ("target-value discontinuity at
 *     dist = FADE_HOLD") is asserted by tests instead of by eyeballing the
 *     compiled game.
 *
 * ── The three thresholds ─────────────────────────────────────────────────
 *   FADE_IN_AT   (near):  closer than this ⇒ fully material (target = 1.0)
 *   FADE_HOLD    (mid):   the hysteresis band — a small jitter around a 45°
 *                         camera detent does NOT restart the current fade.
 *                         Solid stays solid inside FADE_HOLD; faded stays
 *                         faded outside FADE_HOLD.
 *   FADE_OUT_AT  (far):   farther than this ⇒ fully faded (target = BASE)
 *
 *   FADE_IN_AT < FADE_HOLD < FADE_OUT_AT.
 *
 * ── Continuity (audit round 1) ───────────────────────────────────────────
 * Pre-fix, both ramps used the FULL range (FADE_OUT_AT − FADE_IN_AT), which
 * produced a target-value jump at the FADE_HOLD boundary — the flat hold
 * branch returned 1.0 (or BASE), and the fall-through ramp returned
 * ~BASE + 0.4*(1−BASE), a discontinuity the per-frame lerp then chased
 * across many frames. The lerp hid the jump on slow walks but not on fast
 * ones. Fixed here: each side's ramp spans only its HALF of the hysteresis
 * band (FADE_HOLD → FADE_OUT_AT for fade-out, FADE_IN_AT → FADE_HOLD for
 * fade-in), so the target value is continuous with the flat region on both
 * sides. See vestibuleFade.test.ts for the boundary assertions.
 */

/** The three-threshold contract, all in metres. */
export interface VestibuleFadeThresholds {
  fadeInAt: number;
  fadeHold: number;
  fadeOutAt: number;
}

/**
 * Distance-derived fade target with hysteresis. `baseOpacity` is the resting
 * far value (0 in production — vestibules are invisible far from the door).
 * `isMaterialising` is the hysteresis bit: true when the vestibule is
 * currently solid enough (opacity > 0.5) that the hold band should PIN it
 * solid rather than start a fade-out from a jitter around a camera detent.
 */
export function computeVestibuleFadeTarget(
  dist: number,
  isMaterialising: boolean,
  thresholds: VestibuleFadeThresholds,
  baseOpacity: number,
): number {
  const { fadeInAt, fadeHold, fadeOutAt } = thresholds;
  // Flat regions: inside FADE_IN_AT and outside FADE_OUT_AT are unconditional.
  if (dist <= fadeInAt) return 1.0;
  if (dist >= fadeOutAt) return baseOpacity;
  if (isMaterialising) {
    // Already solid; stay solid across the material band, then ramp down on
    // ONLY the far half (FADE_HOLD → FADE_OUT_AT) — so at dist = FADE_HOLD
    // the ramp reads 1.0, continuous with the flat solid region.
    if (dist <= fadeHold) return 1.0;
    const range = fadeOutAt - fadeHold;
    const t = clamp01(1 - (dist - fadeHold) / range);
    return baseOpacity + t * (1 - baseOpacity);
  }
  // Already faded; stay faded across the far half, then ramp up on ONLY the
  // near half (FADE_IN_AT → FADE_HOLD) — so at dist = FADE_HOLD the ramp
  // reads baseOpacity, continuous with the flat faded region.
  if (dist >= fadeHold) return baseOpacity;
  const range = fadeHold - fadeInAt;
  const t = clamp01(1 - (dist - fadeInAt) / range);
  return baseOpacity + t * (1 - baseOpacity);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
