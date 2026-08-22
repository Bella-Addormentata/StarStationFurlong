/**
 * WAR engine tests — proves round resolution, tie escalation (war), and
 * under-supply endgames. Uses handcrafted decks (not the shuffle) to keep
 * the ranking assertions unambiguous.
 */

import { describe, expect, it } from 'vitest';
import { cardOf } from './cards';
import { beginWar, initialWarState, isWarState, playWarRound } from './war';
import type { WarState } from './war';

// Helpers to build decks by rank+suit — cards.ts encoding: cardOf(suit, rank).
const c = (suit: 0 | 1 | 2 | 3, rank: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14) => cardOf(suit, rank);

/** Build a fresh WarState with explicit left/right decks (top-first). */
function stateWithDecks(left: number[], right: number[]): WarState {
  return {
    kind: 'war',
    players: { left: 'L', right: 'R' },
    status: 'playing',
    leftDeck: left,
    rightDeck: right,
    lastRound: null,
    roundsPlayed: 0,
    seed: 1,
    bot: false,
  };
}

describe('war: setup', () => {
  it('initialWarState is a valid waiting state', () => {
    const s = initialWarState(42);
    expect(s.status).toBe('waiting');
    expect(s.leftDeck.length).toBe(0);
    expect(s.rightDeck.length).toBe(0);
    expect(isWarState(s)).toBe(true);
  });

  it('beginWar deals 26/26 deterministically', () => {
    const s = beginWar({ ...initialWarState(7), players: { left: 'L', right: 'R' } });
    expect(s.leftDeck.length).toBe(26);
    expect(s.rightDeck.length).toBe(26);
    // Full deck coverage, no dupes.
    const all = new Set([...s.leftDeck, ...s.rightDeck]);
    expect(all.size).toBe(52);
    // Reproducible.
    const t = beginWar({ ...initialWarState(7), players: { left: 'L', right: 'R' } });
    expect(t.leftDeck).toEqual(s.leftDeck);
    expect(t.rightDeck).toEqual(s.rightDeck);
  });
});

describe('war: quiet round resolution', () => {
  it('higher rank wins both cards', () => {
    // Left: 5♣ on top; Right: 3♦ on top; Left wins → left gets [5♣, 3♦] at bottom
    const s = stateWithDecks([c(0, 5), c(0, 6)], [c(1, 3), c(1, 4)]);
    const next = playWarRound(s);
    expect(next.status).toBe('playing');
    // Left: [6♣, 5♣, 3♦]; Right: [4♦]
    expect(next.leftDeck).toEqual([c(0, 6), c(0, 5), c(1, 3)]);
    expect(next.rightDeck).toEqual([c(1, 4)]);
    expect(next.lastRound?.warDepth).toBe(0);
    expect(next.lastRound?.winner).toBe('left');
  });

  it('right also wins fair and square', () => {
    const s = stateWithDecks([c(0, 2), c(0, 6)], [c(1, 14), c(1, 4)]); // 2 vs Ace
    const next = playWarRound(s);
    expect(next.lastRound?.winner).toBe('right');
    // Right gets [A♦, 2♣] at bottom of their deck
    expect(next.rightDeck).toEqual([c(1, 4), c(1, 14), c(0, 2)]);
    expect(next.leftDeck).toEqual([c(0, 6)]);
  });
});

describe('war: tie escalation (war)', () => {
  it('single war resolves — 8 cards to winner', () => {
    // Left: 5♣, X, X, X (down), 9♣ (up); Right: 5♦, X, X, X (down), 6♦ (up)
    const leftDown = [c(0, 2), c(0, 3), c(0, 4)];
    const rightDown = [c(1, 2), c(1, 3), c(1, 4)];
    const left = [c(0, 5), ...leftDown, c(0, 9)];
    const right = [c(1, 5), ...rightDown, c(1, 6)];
    const s = stateWithDecks(left, right);
    const next = playWarRound(s);
    expect(next.lastRound?.warDepth).toBe(1);
    expect(next.lastRound?.winner).toBe('left');
    // Winner (left) receives: leftUp + rightUp + leftDown + rightDown
    // leftUp = [5♣, 9♣]; rightUp = [5♦, 6♦]
    expect(next.leftDeck).toEqual([
      c(0, 5), c(0, 9),
      c(1, 5), c(1, 6),
      c(0, 2), c(0, 3), c(0, 4),
      c(1, 2), c(1, 3), c(1, 4),
    ]);
    expect(next.rightDeck).toEqual([]);
    expect(next.status).toBe('left-won');
  });

  it('nested war-in-war escalates warDepth', () => {
    // First reveal ties (5=5), first war reveal ties again (7=7), second war
    // reveal breaks (9 > 4).
    const leftDown1 = [c(0, 2), c(0, 3), c(0, 4)];
    const rightDown1 = [c(1, 2), c(1, 3), c(1, 4)];
    const leftDown2 = [c(0, 5), c(0, 6), c(0, 7)];
    const rightDown2 = [c(1, 5), c(1, 6), c(1, 7)];
    const left = [c(0, 5), ...leftDown1, c(0, 7), ...leftDown2, c(0, 9)];
    const right = [c(1, 5), ...rightDown1, c(1, 7), ...rightDown2, c(1, 4)];
    const s = stateWithDecks(left, right);
    const next = playWarRound(s);
    expect(next.lastRound?.warDepth).toBe(2);
    expect(next.lastRound?.winner).toBe('left');
    // Left picks up EVERYTHING — 18 cards total (9 each side).
    expect(next.leftDeck.length).toBe(18);
    expect(next.rightDeck.length).toBe(0);
    expect(next.status).toBe('left-won');
  });
});

describe('war: under-supply during a war', () => {
  it('side that runs out mid-war loses the game', () => {
    // Left: 5♣ (up), 2♣, 3♣ (down — only 2 available), 9♣ (up)
    // Right: 5♦ (up), 2♦ (down), 4♦ (would-be up but not there)
    // Wait — I need right to run out. Let's give right only 2 cards total.
    const left = [c(0, 5), c(0, 2), c(0, 3), c(0, 9)];
    const right = [c(1, 5), c(1, 4)]; // only 2 cards — tie, then war can't reveal
    const s = stateWithDecks(left, right);
    const next = playWarRound(s);
    expect(next.status).toBe('left-won');
    expect(next.lastRound?.winner).toBe('left');
    expect(next.rightDeck).toEqual([]);
  });

  it('empty deck at round start ends the game', () => {
    const s = stateWithDecks([c(0, 5)], []);
    const next = playWarRound(s);
    expect(next.status).toBe('left-won');
  });

  it('finished games return unchanged', () => {
    const s: WarState = { ...stateWithDecks([c(0, 5)], []), status: 'right-won' };
    const next = playWarRound(s);
    expect(next).toBe(s);
  });
});

describe('war: shape guard', () => {
  it('rejects malformed values', () => {
    expect(isWarState(null)).toBe(false);
    expect(isWarState({})).toBe(false);
    expect(isWarState({ kind: 'checkers' })).toBe(false);
  });

  it('accepts freshly-dealt state', () => {
    const s = beginWar({ ...initialWarState(11), players: { left: 'L', right: 'R' } });
    expect(isWarState(s)).toBe(true);
  });

  it('rejects a state with a bad card in the deck', () => {
    const s = beginWar({ ...initialWarState(1), players: { left: 'L', right: 'R' } });
    const bad = { ...s, leftDeck: [...s.leftDeck.slice(0, -1), 99] };
    expect(isWarState(bad)).toBe(false);
  });
});

describe('war: determinism across peers', () => {
  it('two independent state advances produce identical results', () => {
    const s = beginWar({ ...initialWarState(2027), players: { left: 'L', right: 'R' } });
    const a = playWarRound(s);
    const b = playWarRound(s);
    expect(a).toEqual(b);
  });
});
