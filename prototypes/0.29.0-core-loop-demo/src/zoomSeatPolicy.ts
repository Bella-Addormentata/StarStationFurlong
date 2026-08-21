/**
 * 🧭 #102 T5 — seatFaceOverride ARMING POLICY.
 *
 * Pure, framework-free, DOM-free. Kept in its own tiny module so the
 * regression test can import it without pulling in the browser-only zoom
 * runtime (zoom.ts loads three.js and reads `window.location` via
 * exteriorView on module init).
 *
 * ── What the flag is for ─────────────────────────────────────────────────
 * `seatFaceOverride` (zoom.ts) is a one-shot flag that pins a seat's world-
 * face angle through the 2→1 zoomIn dive's rig-inherit yaw seed. Consumed
 * and cleared exclusively by `zoomIn`, which only runs on that dive.
 *
 * ── Why arming needs a guard ────────────────────────────────────────────
 * Pre-fix, `requestFirstPerson` set the flag whenever a faceAngle was
 * supplied, regardless of current level. A sit-down that fires while
 * already at level 1 (world.ts:472-473 `onSeatSettled → onFirstPersonSeat?.
 * (seat.faceAngle)`) armed the flag with no zoomIn to clear it. The flag
 * then persisted across the stand-up, zoom-out to 2, and the NEXT dive —
 * silently defeating that dive's rig-inherit seed and re-opening the exact
 * R2 continuity gap this flag was written to close (the round-1 audit's
 * "T5 stale flag" finding).
 *
 * The fix is to arm ONLY when a zoomIn will actually consume the flag:
 * `currentLevel === 2` (the only level a dive proceeds FROM).
 */

/**
 * True when `requestFirstPerson` should ARM the one-shot seatFaceOverride
 * flag. Callers still set the yaw directly whenever a faceAngle is present —
 * only the flag is guarded here.
 *
 * Contract:
 *   - Level 2 + defined angle ⇒ true (normal dive; flag must pin the seat's
 *     face through zoomIn's rig-inherit seed).
 *   - Level 1 + defined angle ⇒ false (already at 1; yaw is written
 *     directly, no zoomIn to consume the flag ⇒ arming strands it).
 *   - Undefined angle       ⇒ false (nothing to pin, regardless of level).
 *   - Any other level        ⇒ false (only 2→1 fires zoomIn).
 */
export function shouldPinSeatFaceOverride(
  currentLevel: number,
  faceAngle: number | undefined,
): boolean {
  return faceAngle !== undefined && currentLevel === 2;
}
