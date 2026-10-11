/**
 * The table rail's chips (#226): always the exact balance, and always some
 * small chips to bet with once the balance can spare them.
 */

import { describe, expect, it, vi } from 'vitest';

// chipDisplay.ts hangs a console debug handle on window when it loads.
vi.stubGlobal('window', {});
const { chipsFor, railChips } = await import('./chipDisplay');

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('railChips', () => {
  it('adds up to the balance exactly', () => {
    for (let b = 0; b <= 3000; b += 7) expect(sum(railChips(b))).toBe(b);
    expect(sum(railChips(123456))).toBe(123456);
  });

  it('breaks a single big chip into chips you can bet with', () => {
    expect(chipsFor(100)).toEqual([100]);
    const rail = railChips(100);
    expect(rail).toContain(5);
    expect(rail).toContain(1);
    expect(rail).toContain(25);
  });

  it('keeps small balances as they are', () => {
    expect(railChips(7)).toEqual([5, 1, 1]);
    expect(railChips(0)).toEqual([]);
  });

  it('is largest first', () => {
    const rail = railChips(2468);
    expect([...rail].sort((a, b) => b - a)).toEqual(rail);
  });

  it('does not flood the rail for a big balance', () => {
    expect(railChips(50000).length).toBeLessThan(80);
  });
});
