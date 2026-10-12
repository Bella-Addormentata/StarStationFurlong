// The helm's in-flight figures (helmRoute.ts helmFlightFigures): the helm tick
// writes these numbers into the open panel in place and redraws only when the
// phase flips, so the ferry's in-flight buttons (TAKE THE HELM, HAND TO ROBOT,
// STOP ROUTE) are not swapped out from under a click four times a second.

import { describe, expect, it } from 'vitest';
import { helmFlightFigures } from './helmRoute';
import type { FlightRecord } from './shipDoc';

const flight = (departedAt: number, etaAt: number): FlightRecord => ({
  status: 'in-flight', locationId: 'a', destinationId: 'b', departedAt, etaAt,
});

describe('helmFlightFigures', () => {
  it('holds for the launch window before the burn', () => {
    const f = helmFlightFigures(flight(10_000, 70_000), 2_500);
    expect(f).toEqual({ phase: 'hold', wait: 8, remaining: 68, pct: 0 });
  });

  it('counts down and fills the bar in flight', () => {
    const f = helmFlightFigures(flight(10_000, 70_000), 40_000);
    expect(f.phase).toBe('fly');
    expect(f.remaining).toBe(30);
    expect(f.pct).toBe(50);
  });

  it('says arrived at the ETA', () => {
    expect(helmFlightFigures(flight(10_000, 70_000), 70_000).phase).toBe('arrived');
    expect(helmFlightFigures(flight(10_000, 70_000), 90_000).remaining).toBe(0);
  });

  it('keeps one phase while only the numbers move', () => {
    const phases = new Set<string>();
    for (let t = 10_000; t < 70_000; t += 250) phases.add(helmFlightFigures(flight(10_000, 70_000), t).phase);
    expect([...phases]).toEqual(['fly']);
  });
});
