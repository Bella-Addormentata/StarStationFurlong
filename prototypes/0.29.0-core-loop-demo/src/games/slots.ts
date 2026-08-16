/**
 * 🎰 Slot Machine — the pure engine (issue #109).
 *
 * A classic three-reel, single-payline slot machine. This module is PURE —
 * no doc access and no DOM — so payout math is console-testable and a Chia
 * commit-reveal / block-beacon fairness upgrade slots in around it
 * untouched, exactly like games/craps.ts.
 *
 * SYMBOL STRIP
 * Each reel carries REEL_STRIP_SIZE virtual stops. Random stops are sampled
 * without modulo bias, then mapped to a symbol index via `REEL_STRIP`.
 * The strip distribution controls the house edge directly — rarer symbols
 * appear on fewer stops.
 *
 * ODDS & PAYTABLE
 * Vegas-typical 3-reel machines return roughly 85–98% RTP depending on
 * denomination (higher-coin machines pay more). Our default achieves 83.31%
 * over the strip distribution below. The room owner can override the odds
 * via `SlotOddsConfig` stored in the casino doc; `resolveSlot` accepts a
 * custom paytable, letting the owner increase or decrease the house edge and
 * display the odds on the machine face.
 *
 * PAYOUT CONVENTION
 * Stakes are deducted at play time (before the spin). `resolveSlot` returns:
 *   `credited` — chips RETURNED to the player (0 on a loss, stake+win on a win).
 *   `outcome`  — label for narration / UI.
 *   `multiplier` — the raw payout multiple (0 = loss, 1 = push, 2+ = win).
 *
 * STATE MACHINE
 *   idle → spinning → settled → idle
 * The machine owner (or croupier bot) writes the settled state; every client
 * reads it and animates the reels independently from the published result.
 *
 * FAIRNESS TRANSCRIPT
 * Reuses the same `FairnessTranscript` + `FairnessMode` types as craps so the
 * same commit-reveal / multiparty / block-beacon plumbing can drive slot
 * entropy without additional infrastructure.
 */

import type { FairnessMode, FairnessTranscript } from './craps';
import { isFairnessTranscript } from './craps';

// ── Symbols ──────────────────────────────────────────────────────────────────

/** The seven classic reel symbols, rarest last. */
export type SlotSymbol =
  | 'cherry'
  | 'lemon'
  | 'orange'
  | 'plum'
  | 'bell'
  | 'bar'
  | 'seven';

export const SLOT_SYMBOLS: readonly SlotSymbol[] = [
  'cherry', 'lemon', 'orange', 'plum', 'bell', 'bar', 'seven',
];

/** Symbol index — position in SLOT_SYMBOLS array. */
export type SymbolIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// ── Reel strip ────────────────────────────────────────────────────────────────

/**
 * 22-stop virtual strip (typical for a physical 3-reel machine). Each entry
 * is a SymbolIndex. Distribution:
 *   cherry  6 stops  (27%)
 *   lemon   5 stops  (23%)
 *   orange  4 stops  (18%)
 *   plum    3 stops  (14%)
 *   bell    2 stops  (9%)
 *   bar     1 stop   (5%)
 *   seven   1 stop   (5%)
 *
 * All three reels share the same strip; a real machine would stagger them, but
 * this distribution yields 83.31% RTP with the default paytable.
 */
export const REEL_STRIP: readonly SymbolIndex[] = [
  0, 0, 1, 2, 0, 3, 1, 2, 0, 4, 1, 2, 0, 3, 1, 0, 5, 2, 1, 4, 6, 3,
] as const;
export const REEL_STRIP_SIZE = REEL_STRIP.length; // 22

/** Resolve an unbiased reel stop (0–21) to its symbol. */
export function seedToSymbol(stop: number): SlotSymbol {
  if (!Number.isInteger(stop) || stop < 0 || stop >= REEL_STRIP_SIZE) {
    throw new RangeError(`Slot reel stop must be an integer from 0 to ${REEL_STRIP_SIZE - 1}`);
  }
  return SLOT_SYMBOLS[REEL_STRIP[stop]];
}

/** Draw three unbiased reel stops from browser/Node Web Crypto. */
export function randomReelStops(): [number, number, number] {
  const stops: number[] = [];
  const words = new Uint32Array(1);
  const limit = 2 ** 32 - ((2 ** 32) % REEL_STRIP_SIZE);
  while (stops.length < 3) {
    crypto.getRandomValues(words);
    if (words[0] < limit) stops.push(words[0] % REEL_STRIP_SIZE);
  }
  return stops as [number, number, number];
}

// ── Paytable ──────────────────────────────────────────────────────────────────

/** One paytable entry: three symbols + the payout multiplier on stake. */
export interface SlotPayEntry {
  /** Symbols required on reels [left, middle, right].
   *  `null` in any position means "any symbol". */
  symbols: [SlotSymbol | null, SlotSymbol | null, SlotSymbol | null];
  /** Payout multiplier: 0 = lose, 1 = break-even, 2+ = profit. */
  multiplier: number;
  /** Short display label shown on the paytable face, e.g. "JACKPOT". */
  label: string;
}

/**
 * Default paytable — classic Vegas-style 3-reel single-line odds.
 * Displayed on the machine face and editable by the room owner.
 *
 * RTP with the default strip: 83.31%.
 */
export const DEFAULT_PAYTABLE: readonly SlotPayEntry[] = [
  // JACKPOT
  { symbols: ['seven', 'seven', 'seven'], multiplier: 100, label: 'JACKPOT' },
  // Triple bar
  { symbols: ['bar', 'bar', 'bar'], multiplier: 50, label: 'TRIPLE BAR' },
  // Triple bell
  { symbols: ['bell', 'bell', 'bell'], multiplier: 20, label: 'TRIPLE BELL' },
  // Triple plum
  { symbols: ['plum', 'plum', 'plum'], multiplier: 14, label: 'TRIPLE PLUM' },
  // Triple orange
  { symbols: ['orange', 'orange', 'orange'], multiplier: 10, label: 'TRIPLE ORANGE' },
  // Triple lemon
  { symbols: ['lemon', 'lemon', 'lemon'], multiplier: 8, label: 'TRIPLE LEMON' },
  // Any bar / seven mix
  { symbols: ['bar', null, null], multiplier: 5, label: 'BAR' },
  // Triple cherry
  { symbols: ['cherry', 'cherry', 'cherry'], multiplier: 4, label: 'TRIPLE CHERRY' },
  // Any two cherries on left+middle
  { symbols: ['cherry', 'cherry', null], multiplier: 2, label: 'TWO CHERRIES' },
  // Any single cherry on the left reel
  { symbols: ['cherry', null, null], multiplier: 1, label: 'CHERRY' },
];

// ── Owner-configurable odds ───────────────────────────────────────────────────

/** Room-owner override for a machine's paytable. Stored in the casino doc as
 *  `slot-odds:<machineId>`. An absent or invalid config falls back to
 *  DEFAULT_PAYTABLE so legacy machines always work. */
export interface SlotOddsConfig {
  paytable: SlotPayEntry[];
}

const PAYTABLE_MAX_ENTRIES = 32;
const SYMBOL_VALUES: readonly string[] = SLOT_SYMBOLS;

function isSlotPayEntry(v: unknown): v is SlotPayEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<SlotPayEntry>;
  if (!Array.isArray(e.symbols) || e.symbols.length !== 3) return false;
  if (!e.symbols.every((s) => s === null || SYMBOL_VALUES.includes(s as string))) return false;
  if (!Number.isInteger(e.multiplier) || (e.multiplier as number) < 0) return false;
  if (typeof e.label !== 'string' || (e.label as string).length > 32) return false;
  return true;
}

export function isSlotOddsConfig(v: unknown): v is SlotOddsConfig {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Partial<SlotOddsConfig>;
  return Array.isArray(c.paytable)
    && c.paytable.length <= PAYTABLE_MAX_ENTRIES
    && c.paytable.every(isSlotPayEntry);
}

// ── State ─────────────────────────────────────────────────────────────────────

/** The per-machine shared state (casino doc key `slot:<machineId>`).
 *  Whole-value LWW; only the machine owner (or their croupier bot) writes it. */
export interface SlotMachineState {
  kind: 'slot';
  phase: 'idle' | 'spinning' | 'settled';
  /** Increments once per play (drives the UI's "new spin" edge-detect). */
  round: number;
  /** playerId who pulled the lever for this round (null on idle). */
  player: string | null;
  /** Bet amount for this round in chips (null on idle). */
  bet: number | null;
  /** The three settled reel seeds (each 0–N); null while idle/spinning. */
  seeds: [number, number, number] | null;
  /** Resolved symbols for the settled spin; null until settled. */
  result: [SlotSymbol, SlotSymbol, SlotSymbol] | null;
  /** Chips CREDITED to the player this round (0 = loss); null until settled. */
  credited: number | null;
  /** Owner-clock ms timestamp of the settle write. */
  settledAt: number;
  /** 🎰🔒 Verifiable entropy transcript (absent for 'rng'). */
  fairness?: FairnessTranscript;
}

export function initialSlotMachineState(): SlotMachineState {
  return {
    kind: 'slot', phase: 'idle', round: 1,
    player: null, bet: null, seeds: null, result: null, credited: null, settledAt: 0,
  };
}

function isSlotSymbol(v: unknown): v is SlotSymbol {
  return typeof v === 'string' && SYMBOL_VALUES.includes(v);
}

function isSymbolTriple(v: unknown): v is [SlotSymbol, SlotSymbol, SlotSymbol] {
  return Array.isArray(v) && v.length === 3 && v.every(isSlotSymbol);
}

function isSeedTriple(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3
    && v.every((s) => Number.isInteger(s) && (s as number) >= 0
      && (s as number) < REEL_STRIP_SIZE);
}

/** Shape guard — state crosses the room-doc trust boundary (peer writes). */
export function isSlotMachineState(v: unknown): v is SlotMachineState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<SlotMachineState>;
  return s.kind === 'slot'
    && (s.phase === 'idle' || s.phase === 'spinning' || s.phase === 'settled')
    && Number.isInteger(s.round) && (s.round as number) >= 1
    && (s.player === null || typeof s.player === 'string')
    && (s.bet === null || (Number.isInteger(s.bet) && (s.bet as number) > 0))
    && (s.seeds === null || isSeedTriple(s.seeds))
    && (s.result === null || isSymbolTriple(s.result))
    && (s.credited === null || (Number.isInteger(s.credited) && (s.credited as number) >= 0))
    && typeof s.settledAt === 'number' && Number.isFinite(s.settledAt as number)
    && (s.fairness === undefined || isFairnessTranscript(s.fairness));
}

// ── Pure spin logic ───────────────────────────────────────────────────────────

/**
 * Derive three symbols from three unbiased 0–21 reel stops.
 */
export function spinReels(
  seeds: [number, number, number],
): [SlotSymbol, SlotSymbol, SlotSymbol] {
  return [seedToSymbol(seeds[0]), seedToSymbol(seeds[1]), seedToSymbol(seeds[2])];
}

export interface SlotResolution {
  /** Chips returned to the player (0 = loss, stake+win otherwise). */
  credited: number;
  /** The paytable entry that matched, or null (loss). */
  entry: SlotPayEntry | null;
  /** The multiplier applied (0 = loss). */
  multiplier: number;
  /** Human-readable outcome for narration/UI. */
  outcome: string;
}

/**
 * Resolve a spin result against a paytable. Paytable entries are checked in
 * order; the FIRST match wins (higher multipliers should sort first, as in
 * DEFAULT_PAYTABLE). Stakes were already deducted at play time.
 */
export function resolveSlot(
  symbols: [SlotSymbol, SlotSymbol, SlotSymbol],
  stake: number,
  paytable: readonly SlotPayEntry[] = DEFAULT_PAYTABLE,
): SlotResolution {
  for (const entry of paytable) {
    const [s0, s1, s2] = entry.symbols;
    if ((s0 === null || s0 === symbols[0])
      && (s1 === null || s1 === symbols[1])
      && (s2 === null || s2 === symbols[2])) {
      const m = entry.multiplier;
      if (m === 0) break; // explicit loss entry
      return {
        credited: stake * m,
        entry,
        multiplier: m,
        outcome: entry.label,
      };
    }
  }
  return { credited: 0, entry: null, multiplier: 0, outcome: 'NO WIN' };
}

/**
 * Compute the theoretical Return-To-Player (%) of a paytable against the
 * default reel strip distribution — used to display odds on the machine face
 * and in the owner's odds editor.
 *
 * Iterates all 22^3 = 10 648 stop combinations (cheap at build time, not
 * hot-path). Returns a value in [0, 100].
 */
export function computeRTP(paytable: readonly SlotPayEntry[] = DEFAULT_PAYTABLE): number {
  const N = REEL_STRIP_SIZE;
  let totalReturn = 0;
  const total = N * N * N;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) {
        const symbols = spinReels([i, j, k]);
        const { multiplier } = resolveSlot(symbols, 1, paytable);
        totalReturn += multiplier;
      }
    }
  }
  return Math.round((totalReturn / total) * 10000) / 100; // two decimal places
}

// Re-export the fairness types so the device UI can import everything from one place.
export type { FairnessMode, FairnessTranscript };

// Debug handle (the __ssfGames/__ssfCasino/__ssfChips precedent).
if (typeof window !== 'undefined') {
  (window as unknown as { __ssfSlots: unknown }).__ssfSlots = {
    spinReels, resolveSlot, computeRTP, randomReelStops, DEFAULT_PAYTABLE, REEL_STRIP,
  };
}
