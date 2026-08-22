/**
 * Tests for the shared 52-card deck primitives — the foundation on which
 * war/solitaire/poker all depend, so the invariants here are load-bearing.
 */

import { describe, expect, it } from 'vitest';
import {
  cardLabel, cardOf, createRng, deal, freshDeck, isCard, isDeck, isRed,
  rankOf, shuffled, shuffledDeck, suitOf,
} from './cards';

describe('cards: encoding', () => {
  it('freshDeck returns 52 unique cards 0..51', () => {
    const deck = freshDeck();
    expect(deck.length).toBe(52);
    expect(new Set(deck).size).toBe(52);
    expect(Math.min(...deck)).toBe(0);
    expect(Math.max(...deck)).toBe(51);
  });

  it('suitOf/rankOf/cardOf are inverse', () => {
    for (let c = 0; c < 52; c++) {
      const s = suitOf(c);
      const r = rankOf(c);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(4);
      expect(r).toBeGreaterThanOrEqual(2);
      expect(r).toBeLessThanOrEqual(14);
      expect(cardOf(s, r)).toBe(c);
    }
  });

  it('isRed matches diamonds+hearts, black for clubs+spades', () => {
    for (let c = 0; c < 52; c++) {
      const s = suitOf(c);
      const red = s === 1 || s === 2;
      expect(isRed(c)).toBe(red);
    }
  });

  it('cardLabel produces standard notation', () => {
    // A♠ = suit 3, rank 14 → cardOf(3,14)=(14-2)*4+3=51
    expect(cardLabel(51)).toBe('A♠');
    // 2♣ = suit 0, rank 2 → cardOf(0,2)=0
    expect(cardLabel(0)).toBe('2♣');
    // 10♥ = suit 2, rank 10 → (10-2)*4+2=34
    expect(cardLabel(34)).toBe('10♥');
  });

  it('isCard/isDeck reject malformed input', () => {
    expect(isCard(-1)).toBe(false);
    expect(isCard(52)).toBe(false);
    expect(isCard(3.5)).toBe(false);
    expect(isCard('7')).toBe(false);
    expect(isCard(null)).toBe(false);
    expect(isDeck([0, 1, 2])).toBe(true);
    expect(isDeck([0, 1, 'x'])).toBe(false);
    expect(isDeck('deck')).toBe(false);
  });
});

describe('cards: RNG', () => {
  it('same seed produces the same sequence', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('different seeds diverge quickly', () => {
    const a = createRng(1);
    const b = createRng(2);
    const firstEqual = a.next() === b.next();
    // Extremely unlikely to be exactly equal on first draw.
    expect(firstEqual).toBe(false);
  });

  it('nextInt(n) stays in [0, n) and is roughly uniform', () => {
    const r = createRng(42);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const v = r.nextInt(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
      buckets[v]++;
    }
    for (const b of buckets) {
      // With 10k samples and 10 buckets each mean=1000, wide margin.
      expect(b).toBeGreaterThan(700);
      expect(b).toBeLessThan(1300);
    }
  });

  it('nextInt(0) throws', () => {
    const r = createRng(7);
    expect(() => r.nextInt(0)).toThrow();
    expect(() => r.nextInt(-1)).toThrow();
    expect(() => r.nextInt(1.5)).toThrow();
  });

  it('seed 0 does not degenerate (splitmix32 fixed point handled)', () => {
    const r = createRng(0);
    const a = r.next();
    const b = r.next();
    expect(a).not.toBe(b);
  });
});

describe('cards: shuffle', () => {
  it('shuffled returns a permutation and does not mutate input', () => {
    const deck = freshDeck();
    const before = deck.slice();
    const rng = createRng(999);
    const out = shuffled(deck, rng);
    expect(deck).toEqual(before); // no mutation
    expect(out.length).toBe(52);
    expect(new Set(out).size).toBe(52);
    expect(out).not.toEqual(before); // extremely unlikely to be identity
  });

  it('same seed shuffledDeck is reproducible', () => {
    const a = shuffledDeck(2025);
    const b = shuffledDeck(2025);
    expect(a).toEqual(b);
    const c = shuffledDeck(2026);
    expect(c).not.toEqual(a);
  });

  it('shuffledDeck is a valid 52-card deck', () => {
    const d = shuffledDeck(1);
    expect(isDeck(d)).toBe(true);
    expect(d.length).toBe(52);
    expect(new Set(d).size).toBe(52);
  });
});

describe('cards: deal', () => {
  it('splits into piles round-robin, preserving order within pile', () => {
    const deck = [0, 1, 2, 3, 4, 5, 6, 7];
    const { piles, rest } = deal(deck, 2, 3);
    // Round-robin: pile[0] = [0,2,4], pile[1] = [1,3,5], rest = [6,7]
    expect(piles).toEqual([[0, 2, 4], [1, 3, 5]]);
    expect(rest).toEqual([6, 7]);
  });

  it('throws when deck too small', () => {
    expect(() => deal(freshDeck(), 4, 20)).toThrow();
  });

  it('throws on invalid counts', () => {
    expect(() => deal(freshDeck(), 0, 5)).toThrow();
    expect(() => deal(freshDeck(), 2, -1)).toThrow();
    expect(() => deal(freshDeck(), 2.5, 3)).toThrow();
  });
});
