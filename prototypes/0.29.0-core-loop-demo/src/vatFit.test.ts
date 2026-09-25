// vatFit.ts tests: the clone vat's hourglass mouth as a HARD LIMIT (#165).
//
// The module is deliberately pure arithmetic — no three.js, no DOM — precisely
// so the fit can be proved here rather than eyeballed in the browser. The
// central test is not "the numbers match a golden value" (they would rot the
// first time the sculpt or the glass changed) but the CONTRACT: whatever
// fitVatSqueeze returns, the squeezed silhouette actually passes the mouth.

import { describe, expect, it } from 'vitest';
import {
  apertureHalfWidth,
  apertureHalfWidthAtY,
  fitVatSqueeze,
  lerpSqueeze,
  minApertureHalfWidth,
  vatSqueezeWeight,
  MIN_SQUEEZE,
  NO_SQUEEZE,
} from './vatFit';
import type { RigSilhouette, SilhouetteBand, VatAperture } from './vatFit';

/** A plain hourglass with round numbers — every expectation below is legible
 *  against it by hand, which a copy of the real VAT_APERTURE would not be. */
const AP: VatAperture = {
  height: 2,
  lobeHalfWidth: 1,
  waistHalfWidth: 0.5,
  waistAt: 0.5,
  curve: 2,
  doorPlaneRadius: 0.8,
  innerRadius: 0.75,
};

/** Bands of uniform width/radius from 0 to `height` — the simplest rig that
 *  still exercises the per-band loop. */
function uniformRig(
  height: number,
  halfWidth: number,
  maxRadius: number,
  band = 0.1,
): RigSilhouette {
  const bands: SilhouetteBand[] = [];
  for (let y = 0; y < height - 1e-9; y += band) {
    bands.push({
      y0: y,
      y1: Math.min(y + band, height),
      halfWidth,
      maxRadius,
    });
  }
  return { height, bands };
}

/**
 * The contract, stated once and reused: a fit is CORRECT when the squeezed
 * rig passes. Every band must clear the mouth at the height it will actually
 * occupy (so the vertical factor has to be applied to the band bounds before
 * the mouth is sampled) and must also fit inside the glass tube, and the
 * whole rig must be no taller than the mouth.
 */
function expectPasses(rig: RigSilhouette, ap: VatAperture): void {
  const fit = fitVatSqueeze(rig, ap);
  const EPS = 1e-9;
  expect(rig.height * fit.vertical).toBeLessThanOrEqual(ap.height + EPS);
  for (const band of rig.bands) {
    const limit = minApertureHalfWidth(
      ap,
      band.y0 * fit.vertical,
      band.y1 * fit.vertical,
    );
    expect(band.halfWidth * fit.horizontal).toBeLessThanOrEqual(limit + EPS);
    expect(band.maxRadius * fit.horizontal).toBeLessThanOrEqual(
      ap.innerRadius + EPS,
    );
  }
}

describe('apertureHalfWidth — the hourglass profile', () => {
  it('is widest at both lobes and narrowest at the waist', () => {
    expect(apertureHalfWidth(AP, 0)).toBeCloseTo(AP.lobeHalfWidth, 12);
    expect(apertureHalfWidth(AP, 1)).toBeCloseTo(AP.lobeHalfWidth, 12);
    expect(apertureHalfWidth(AP, AP.waistAt)).toBeCloseTo(
      AP.waistHalfWidth,
      12,
    );
  });

  it('narrows monotonically toward the waist from both sides', () => {
    let prev = apertureHalfWidth(AP, 0);
    for (let t = 0.02; t <= AP.waistAt + 1e-9; t += 0.02) {
      const w = apertureHalfWidth(AP, t);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    prev = apertureHalfWidth(AP, AP.waistAt);
    for (let t = AP.waistAt + 0.02; t <= 1 + 1e-9; t += 0.02) {
      const w = apertureHalfWidth(AP, t);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = w;
    }
  });

  it('clamps outside [0,1] instead of running negative', () => {
    expect(apertureHalfWidth(AP, -5)).toBeCloseTo(AP.lobeHalfWidth, 12);
    expect(apertureHalfWidth(AP, 5)).toBeCloseTo(AP.lobeHalfWidth, 12);
  });

  it('survives the degenerate waists (0 and 1) without NaN', () => {
    for (const waistAt of [0, 1]) {
      const cone = { ...AP, waistAt };
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        expect(Number.isFinite(apertureHalfWidth(cone, t))).toBe(true);
      }
    }
  });

  it('maps absolute heights through `height`, and a zero-height mouth to the waist', () => {
    expect(apertureHalfWidthAtY(AP, AP.height / 2)).toBeCloseTo(
      AP.waistHalfWidth,
      12,
    );
    expect(apertureHalfWidthAtY({ ...AP, height: 0 }, 1)).toBeCloseTo(
      AP.lobeHalfWidth,
      12,
    );
  });
});

describe('minApertureHalfWidth — exact, not sampled', () => {
  it('returns the waist for any interval that straddles it', () => {
    expect(minApertureHalfWidth(AP, 0.9, 1.1)).toBeCloseTo(
      AP.waistHalfWidth,
      12,
    );
    // The reason this is solved rather than sampled: a band far wider than
    // the waist's neighbourhood must still see the pinch.
    expect(minApertureHalfWidth(AP, 0, 2)).toBeCloseTo(AP.waistHalfWidth, 12);
  });

  it('returns the end nearest the waist when the interval is on one side', () => {
    expect(minApertureHalfWidth(AP, 0.2, 0.8)).toBeCloseTo(
      apertureHalfWidthAtY(AP, 0.8),
      12,
    );
    expect(minApertureHalfWidth(AP, 1.2, 1.8)).toBeCloseTo(
      apertureHalfWidthAtY(AP, 1.2),
      12,
    );
  });

  it('is indifferent to argument order', () => {
    expect(minApertureHalfWidth(AP, 1.8, 1.2)).toBeCloseTo(
      minApertureHalfWidth(AP, 1.2, 1.8),
      12,
    );
  });
});

describe('fitVatSqueeze', () => {
  it('leaves a rig that already fits alone — we shrink, never inflate', () => {
    const fit = fitVatSqueeze(uniformRig(1, 0.2, 0.3), AP);
    expect(fit).toEqual(NO_SQUEEZE);
  });

  it('fits the height exactly when height is the only problem', () => {
    const rig = uniformRig(4, 0.2, 0.3);
    const fit = fitVatSqueeze(rig, AP);
    expect(fit.vertical).toBeCloseTo(AP.height / rig.height, 12);
    expect(rig.height * fit.vertical).toBeCloseTo(AP.height, 12);
  });

  it('lets the WAIST bind the width when a band sits across the pinch', () => {
    // One band, centred on the waist, twice as wide as the pinch allows.
    const rig: RigSilhouette = {
      height: 2,
      bands: [{ y0: 0.9, y1: 1.1, halfWidth: 1, maxRadius: 0.1 }],
    };
    // height already fits, so the band stays on the waist after the fit.
    expect(fitVatSqueeze(rig, AP).horizontal).toBeCloseTo(
      AP.waistHalfWidth / 1,
      12,
    );
    expectPasses(rig, AP);
  });

  it('lets the TUBE bind the width independently of the hourglass', () => {
    // Narrow head-on (the mouth is happy) but a long tail: only innerRadius
    // can catch this, which is why the fit checks both.
    const rig: RigSilhouette = {
      height: 1,
      bands: [{ y0: 0, y1: 0.1, halfWidth: 0.1, maxRadius: 1.5 }],
    };
    expect(fitVatSqueeze(rig, AP).horizontal).toBeCloseTo(
      AP.innerRadius / 1.5,
      12,
    );
    expectPasses(rig, AP);
  });

  it('never goes below MIN_SQUEEZE, even for an absurd rig', () => {
    const fit = fitVatSqueeze(uniformRig(40, 12, 14), AP);
    expect(fit.horizontal).toBe(MIN_SQUEEZE);
    expect(fit.vertical).toBe(MIN_SQUEEZE);
  });

  it('ignores empty bands rather than dividing by zero', () => {
    const rig: RigSilhouette = {
      height: 1,
      bands: [
        { y0: 0, y1: 0.1, halfWidth: 0, maxRadius: 0 },
        { y0: 0.1, y1: 0.2, halfWidth: 0.2, maxRadius: 0.2 },
      ],
    };
    const fit = fitVatSqueeze(rig, AP);
    expect(Number.isFinite(fit.horizontal)).toBe(true);
    expect(fit).toEqual(NO_SQUEEZE);
  });

  it('survives a zero-height rig', () => {
    expect(fitVatSqueeze({ height: 0, bands: [] }, AP)).toEqual(NO_SQUEEZE);
  });

  it('produces a passing fit across a sweep of rig shapes', () => {
    // The property, not a golden number: whatever comes back must pass. The
    // sweep deliberately includes rigs that only the vertical fit rescues
    // (tall + narrow) and rigs the waist catches (short + wide).
    for (const height of [0.5, 1, 2, 3, 5]) {
      for (const halfWidth of [0.1, 0.4, 0.9, 1.4]) {
        for (const maxRadius of [0.1, 0.5, 1.2]) {
          const rig = uniformRig(height, halfWidth, maxRadius);
          const fit = fitVatSqueeze(rig, AP);
          expect(fit.horizontal).toBeLessThanOrEqual(1);
          expect(fit.vertical).toBeLessThanOrEqual(1);
          expect(fit.horizontal).toBeGreaterThanOrEqual(MIN_SQUEEZE);
          expect(fit.vertical).toBeGreaterThanOrEqual(MIN_SQUEEZE);
          // Only assert the pass where MIN_SQUEEZE did not have to override
          // the arithmetic — the floor is explicitly "an honest clip beats a
          // deformed fox", so those cases are allowed not to fit.
          if (fit.horizontal > MIN_SQUEEZE && fit.vertical > MIN_SQUEEZE) {
            expectPasses(rig, AP);
          }
        }
      }
    }
  });
});

describe('vatSqueezeWeight — release by distance, not by time', () => {
  it('is at full strength anywhere inside the door plane', () => {
    expect(vatSqueezeWeight(0, 0.8, 2)).toBe(1);
    expect(vatSqueezeWeight(0.8, 0.8, 2)).toBe(1);
  });

  it('reaches zero exactly at the exit point', () => {
    expect(vatSqueezeWeight(2, 0.8, 2)).toBe(0);
  });

  it('decreases monotonically across the doorway', () => {
    let prev = 1;
    for (let d = 0.8; d <= 2 + 1e-9; d += 0.05) {
      const w = vatSqueezeWeight(d, 0.8, 2);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      prev = w;
    }
  });

  it('releases immediately when the exit is inside the door plane', () => {
    expect(vatSqueezeWeight(0.9, 0.8, 0.5)).toBe(0);
  });

  it('clamps past the exit rather than inverting the squeeze', () => {
    expect(vatSqueezeWeight(10, 0.8, 2)).toBe(0);
  });
});

describe('lerpSqueeze', () => {
  const FIT = { horizontal: 0.7, vertical: 0.9 };

  it('is the identity at weight 0 and the fit at weight 1', () => {
    expect(lerpSqueeze(FIT, 0)).toEqual(NO_SQUEEZE);
    expect(lerpSqueeze(FIT, 1)).toEqual(FIT);
  });

  it('interpolates in between', () => {
    const half = lerpSqueeze(FIT, 0.5);
    expect(half.horizontal).toBeCloseTo(0.85, 12);
    expect(half.vertical).toBeCloseTo(0.95, 12);
  });

  it('clamps out-of-range weights', () => {
    expect(lerpSqueeze(FIT, -1)).toEqual(NO_SQUEEZE);
    expect(lerpSqueeze(FIT, 5)).toEqual(FIT);
  });
});
