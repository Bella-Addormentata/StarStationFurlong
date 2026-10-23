/**
 * ↶ "Take me down": the round button beside your rail chips (and C) returns
 * every bet that may come off, and leaves craps' contract bets on the felt.
 */

import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', { location: { search: '' }, addEventListener: () => undefined, removeEventListener: () => undefined });

const { railFor, railWithTakeDown, splitTakeDown } = await import('./casinoTableSession');
const { RAIL_PITCH, railStacks, TAKE_DOWN_R } = await import('./casinoTable3d');
const { railChipCounts } = await import('./chipDisplay');
const { canTakeDown } = await import('./games/craps');
type CrapsBet = import('./games/craps').CrapsBet;

describe('canTakeDown (craps)', () => {
  it('keeps a pass line bet once the point is on, frees it on the come-out', () => {
    expect(canTakeDown({ type: 'pass' }, null)).toBe(true);
    expect(canTakeDown({ type: 'pass' }, 6)).toBe(false);
  });

  it('keeps a come bet that has travelled, frees one still in the come box', () => {
    expect(canTakeDown({ type: 'come' }, 6)).toBe(true);
    expect(canTakeDown({ type: 'come', pick: 9 }, 6)).toBe(false);
  });

  it('lets everything else come down', () => {
    for (const type of ['dontpass', 'dontcome', 'place', 'big6', 'big8', 'hard', 'field', 'yo',
      'passodds', 'dontpassodds', 'comeodds', 'dontcomeodds'] as const) {
      expect(canTakeDown({ type, pick: 6 }, 6)).toBe(true);
    }
  });
});

describe('splitTakeDown', () => {
  it('craps: returns odds and place bets, the flat line bet stays', () => {
    const bets: CrapsBet[] = [
      { type: 'pass', amount: 10 },
      { type: 'passodds', amount: 20 },
      { type: 'place', pick: 8, amount: 6 },
      { type: 'come', pick: 5, amount: 5 },
      { type: 'comeodds', pick: 5, amount: 10 },
      { type: 'dontcome', pick: 4, amount: 5 },
    ];
    const { back, keep } = splitTakeDown('craps', bets, 6);
    expect(keep).toEqual([{ type: 'pass', amount: 10 }, { type: 'come', pick: 5, amount: 5 }]);
    expect(back.map((b) => b.type)).toEqual(['passodds', 'place', 'comeodds', 'dontcome']);
  });

  it('craps come-out: everything comes down', () => {
    const bets: CrapsBet[] = [{ type: 'pass', amount: 5 }, { type: 'field', amount: 1 }];
    expect(splitTakeDown('craps', bets, null).keep).toEqual([]);
  });

  it('roulette: every bet comes down', () => {
    const bets = [{ type: 'straight', pick: 17, amount: 5 }, { type: 'red', amount: 25 }];
    const { back, keep } = splitTakeDown('roulette', bets, null);
    expect(back).toEqual(bets);
    expect(keep).toEqual([]);
  });
});

describe('railWithTakeDown', () => {
  const halfX = 0.9;
  const halfZ = 0.48;
  const cases = [
    // Stand on the −z end facing +z: your right hand is −x.
    { stand: { x: 0.2, z: -0.7 }, inward: { x: 0, z: 1 }, right: { x: -1, z: 0 } },
    // Stand on the +z end facing −z: right is +x.
    { stand: { x: -0.3, z: 0.7 }, inward: { x: 0, z: -1 }, right: { x: 1, z: 0 } },
    // Stand on the +x side facing −x: right is −z.
    { stand: { x: 1.1, z: 0 }, inward: { x: -1, z: 0 }, right: { x: 0, z: -1 } },
  ];

  for (const c of cases) {
    it(`puts the button at your right-hand end, clear of your chips (${c.stand.x}, ${c.stand.z})`, () => {
      const rail = railFor(c.stand, halfX, halfZ);
      const { chips, button } = railWithTakeDown(rail, c.inward);
      const along = (p: { x: number; z: number }) => (rail.axis === 'x' ? p.x - rail.x : p.z - rail.z);
      const sideSign = rail.axis === 'x' ? c.right.x : c.right.z;
      // On your right, inside the rail's own length.
      expect(Math.sign(along(button))).toBe(sideSign);
      expect(Math.abs(along(button)) + TAKE_DOWN_R).toBeLessThanOrEqual(rail.len / 2 + 1e-9);
      // A full rail of stacks never reaches the button.
      const stacks = railStacks(chips, railChipCounts(987654));
      expect(stacks.length).toBeGreaterThan(0);
      for (const s of stacks) {
        expect(Math.abs(along(s) - along(button))).toBeGreaterThanOrEqual(TAKE_DOWN_R + RAIL_PITCH / 2 - 0.004);
      }
    });
  }
});

describe('departedChips (the slide back to the rail)', () => {
  it('sends only my chips that left, from the top of each stack', async () => {
    const { departedChips } = await import('./casinoTable3d');
    const before = [
      { x: 0.1, z: 0.2, chips: [25, 5, 1], dim: false },
      { x: 0.3, z: 0.2, chips: [5], dim: false },
      { x: 0.5, z: 0.2, chips: [100], dim: true },
    ];
    const after = [
      { x: 0.1, z: 0.2, chips: [25], dim: false },
      { x: 0.5, z: 0.2, chips: [100], dim: true },
    ];
    expect(departedChips(before, after)).toEqual([
      { x: 0.1, z: 0.2, chips: [5, 1], dim: false, lift: 1 },
      { x: 0.3, z: 0.2, chips: [5], dim: false, lift: 0 },
    ]);
    // Someone else's stack leaving is not mine to slide.
    expect(departedChips(before.slice(2), [])).toEqual([]);
  });
});

describe('departedChips with odds on a flat bet', () => {
  it('slides the odds that left, not the flat bet that stays under them', async () => {
    const { departedChips } = await import('./casinoTable3d');
    const flat = { x: 0.2, z: 0.1, chips: [5], dim: false };
    const odds = { x: 0.2, z: 0.1, chips: [5], dim: false, lift: 1 };
    expect(departedChips([flat, odds], [flat])).toEqual([{ ...odds, lift: 1 }]);
  });
});
