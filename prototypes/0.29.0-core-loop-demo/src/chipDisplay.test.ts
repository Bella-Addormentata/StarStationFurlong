/**
 * The table rail's chips (#226): always the exact balance, and always some
 * small chips to bet with once the balance can spare them.
 */

import { describe, expect, it, vi } from 'vitest';

// chipDisplay.ts hangs a console debug handle on window when it loads.
vi.stubGlobal('window', {});
const { chipsFor, railChipCounts } = await import('./chipDisplay');

const total = (cs: Array<{ denom: number; count: number }>) => cs.reduce((a, c) => a + c.denom * c.count, 0);
const flat = (cs: Array<{ denom: number; count: number }>) => cs.flatMap((c) => new Array<number>(c.count).fill(c.denom));

describe('railChipCounts', () => {
  it('adds up to the balance exactly', () => {
    for (let b = 0; b <= 3000; b += 7) expect(total(railChipCounts(b))).toBe(b);
    expect(total(railChipCounts(123456))).toBe(123456);
  });

  it('stays exact, and one entry per denomination, for an enormous balance', () => {
    const big = railChipCounts(1e12 + 37);
    expect(total(big)).toBe(1e12 + 37);
    expect(big.length).toBeLessThanOrEqual(6);
  });

  it('breaks a single big chip into chips you can bet with', () => {
    expect(chipsFor(100)).toEqual([100]);
    const rail = flat(railChipCounts(100));
    expect(rail).toContain(5);
    expect(rail).toContain(1);
    expect(rail).toContain(25);
  });

  it('keeps small balances as they are', () => {
    expect(flat(railChipCounts(7))).toEqual([5, 1, 1]);
    expect(railChipCounts(0)).toEqual([]);
  });

  it('is largest first', () => {
    const rail = railChipCounts(2468).map((c) => c.denom);
    expect([...rail].sort((a, b) => b - a)).toEqual(rail);
  });

  it('does not flood the rail for a big balance', () => {
    expect(flat(railChipCounts(50000)).length).toBeLessThan(80);
  });
});
