/**
 * Shared 52-card deck utilities — foundation of the #45 card-felt games
 * (WAR, SOLITAIRE, TWO-PLAYER POKER). Pure functions over plain-JSON
 * primitives so every consumer stays doc-friendly: cards are integers, decks
 * are integer arrays, and the deterministic shuffle takes a seed so tests are
 * reproducible AND two clients starting a hand from the same seed will land
 * on the same deck (a small step toward the phase-5 commit-reveal scheme
 * documented in brainstorming/games-plan.md — full hidden-hand play still
 * needs the chia-gaming integration).
 *
 * ENCODING
 *   card ∈ [0, 51]
 *   suit = card mod 4          → 0 = ♣ CLUBS, 1 = ♦ DIAMONDS,
 *                                2 = ♥ HEARTS, 3 = ♠ SPADES
 *   rank = 2 + (card div 4)    → 2..14 with 11=J, 12=Q, 13=K, 14=A (ace HIGH;
 *                                games that need low-ace treat it locally)
 *   colour = suit is ♦/♥ (RED) vs ♣/♠ (BLACK) — solitaire alternating-colour
 *   rule reads it directly (isRed).
 *
 * RNG
 *   splitmix32 (a single-word variant of Steele/Vigna's splitmix64) — small,
 *   deterministic, zero-dependency, and uniform enough for card shuffles.
 *   Fisher-Yates over a fresh 0..51 array; the same seed reproduces the same
 *   deck byte-for-byte across TS and any faithful port.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** A card is a compact integer 0..51 (see header). Runtime guard: isCard. */
export type Card = number;

/** Suit index: 0=♣, 1=♦, 2=♥, 3=♠ (deterministic per header). */
export type Suit = 0 | 1 | 2 | 3;

/** Card rank: 2..10 = pip; 11=J, 12=Q, 13=K, 14=A (ace HIGH). */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export const SUIT_GLYPH = ['♣', '♦', '♥', '♠'] as const; // ♣ ♦ ♥ ♠
export const SUIT_NAME = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const RANK_GLYPH = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;

// ── Card helpers ─────────────────────────────────────────────────────────────

export function suitOf(card: Card): Suit {
  return (card % 4) as Suit;
}

export function rankOf(card: Card): Rank {
  return (2 + Math.floor(card / 4)) as Rank;
}

/** True when suit ∈ {♦, ♥} — the alternating-colour rule for solitaire. */
export function isRed(card: Card): boolean {
  const s = suitOf(card);
  return s === 1 || s === 2;
}

/** Compact display like "A♠" or "10♥" — used by tests and the DOM canvas. */
export function cardLabel(card: Card): string {
  return `${RANK_GLYPH[rankOf(card)]}${SUIT_GLYPH[suitOf(card)]}`;
}

/** Encode (suit, rank) → card. Useful for hand-built test hands. */
export function cardOf(suit: Suit, rank: Rank): Card {
  return (rank - 2) * 4 + suit;
}

/** Runtime guard — every doc read crosses a trust boundary (peers write it). */
export function isCard(value: unknown): value is Card {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 51;
}

/** Runtime guard for a plain-JSON deck (Array of cards, may be empty). */
export function isDeck(value: unknown): value is Card[] {
  return Array.isArray(value) && value.every(isCard);
}

// ── Deterministic RNG (splitmix32) ───────────────────────────────────────────

/**
 * Small deterministic PRNG. State is a single 32-bit word. `next()` returns
 * a uniform 32-bit unsigned integer; `nextFloat()` returns [0, 1).
 * Seed must be in [1, 2^32-1]; 0 is disallowed (would be a fixed point) —
 * `randomSeed()` never returns 0.
 */
export interface Rng {
  next(): number;
  nextFloat(): number;
  /** Uniform integer in [0, n). Rejection-sampled to avoid modulo bias. */
  nextInt(n: number): number;
  /** Current internal state (for snapshot/restore in tests). */
  state(): number;
}

export function createRng(seed: number): Rng {
  // Normalize: keep in u32, avoid the 0 fixed point.
  let s = ((seed >>> 0) || 0x9e3779b9) >>> 0;

  const step = (): number => {
    // splitmix32 mixer (Steele/Vigna).
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };

  const rng: Rng = {
    next: step,
    nextFloat: () => step() / 0x100000000,
    nextInt: (n: number) => {
      if (!Number.isInteger(n) || n <= 0) throw new RangeError('nextInt(n) needs n > 0');
      // Rejection sampling — the top (2^32 mod n) values are rejected so the
      // remaining span is an exact multiple of n. Guarantees uniform output.
      const limit = 0x100000000 - (0x100000000 % n);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = step();
        if (r < limit) return r % n;
      }
    },
    state: () => s,
  };
  return rng;
}

/** A non-zero 32-bit seed built from Math.random() (call sites needing tests
 *  should thread an explicit seed instead — this is the runtime default). */
export function randomSeed(): number {
  let s = Math.floor(Math.random() * 0x100000000) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return s;
}

// ── Deck construction / shuffle / deal ───────────────────────────────────────

/** Fresh ordered deck [0..51]. Not shuffled — callers pass through shuffle. */
export function freshDeck(): Card[] {
  const deck: Card[] = new Array(52);
  for (let i = 0; i < 52; i++) deck[i] = i;
  return deck;
}

/**
 * Return a NEW shuffled copy of `deck` using Fisher-Yates driven by `rng`.
 * The input array is not mutated (games/*.ts prefer pure inputs so the CRDT's
 * "previous value" reference stays live during the transacted whole-value
 * write — same discipline as checkers.ts / chess.ts).
 */
export function shuffled(deck: Card[], rng: Rng): Card[] {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Shuffled 52-card deck seeded by `seed`. Convenience for game initializers. */
export function shuffledDeck(seed: number): Card[] {
  return shuffled(freshDeck(), createRng(seed));
}

/**
 * Split a deck into `count` piles as evenly as possible, dealing top-first
 * one card at a time (like a real deal). Returns a fresh array of arrays; the
 * remaining undealt deck is the last slot. Kept general for war (2 piles,
 * whole deck) and future poker sub-deals if needed.
 */
export function deal(deck: Card[], count: number, perPile: number): {
  piles: Card[][]; rest: Card[];
} {
  if (!Number.isInteger(count) || count <= 0) throw new RangeError('count > 0');
  if (!Number.isInteger(perPile) || perPile < 0) throw new RangeError('perPile ≥ 0');
  if (count * perPile > deck.length) throw new RangeError('deck too small');
  const piles: Card[][] = Array.from({ length: count }, () => []);
  let idx = 0;
  for (let r = 0; r < perPile; r++) {
    for (let p = 0; p < count; p++) piles[p].push(deck[idx++]);
  }
  return { piles, rest: deck.slice(idx) };
}
