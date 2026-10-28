/**
 * 🧪🎲🌐 Computed craps in the simulation (computedSim.ts) — for specs only;
 * no app code imports it. computedSim hands every craps table of a room to
 * this file: its players, its checker and its oracles. A room with no craps
 * table never comes here (Sim.craps is null), so the roulette runs draw, load
 * and check exactly what they did before craps.
 *
 * THE PLAYERS. A craps page plays as the table's UI lets a person play
 * (casinoTableSession): only while betting is open on its clock (the view's
 * phase 'betting', before its deadline) and only while its player is at the
 * table (a stand, or the device front); it reads its felt and the stamp it
 * builds on (readMyComputedCrapsBets) in the same frame as it writes
 * (writeComputedCrapsSlip), and counts every answer. It bets any of the 19
 * bet types where the felt's own checks let it (canPlaceBet; odds within
 * oddsRoom; come odds behind a come bet that travelled), keeping the felt's
 * caps; it takes one spot down as the felt's take-back does (the whole spot
 * where it may come down any time, else this window's chips), or everything
 * that may come down (the ↶); it moves between stands, the device front and
 * off the table; and as the shooter, offered the dice during the wait for the
 * throw, it throws at a time drawn into the 20 s wait (some past it: TIME'S
 * UP), as sendThrow does: the throw record, then its own fling noted. Now and
 * then it tries, through the honest API, what the table must refuse: a felt
 * built on a table that has since changed ('changed'), a contract bet taken
 * down or a pass line put down with a point on ('rules'), more chips than its
 * player has ('chips'), a 32nd player ('full'); an 'ok' to any of them is a
 * violation. Its stand is page-local (localStands, as a mounted table marks
 * it), marked again on every load.
 *
 * THE CHECKER replays every decided roll each page folds, as a chain from
 * the session's base, with TODAY's owner-run rules (games/craps: the
 * payouts, the point, the shooter's ring) and its own reading of the design
 * for what computed craps adds: the stamp, the rule check, the room at the
 * table, what a late seed costs, a void, who holds the dice. It never
 * imports computedCraps.ts nor calls the fold's play. Each roll's inputs come
 * from the session's records (the frozen slips, the reveals that open them);
 * the dice from the counted seeds by the async draw a Fair table makes
 * (diceFairness combineSeeds); the money from ONE resolveCrapsRound call over
 * every player's felt split into chips (so a merged felt is held, live, to
 * pay what a per-chip one does). It compares every figure the fold gives
 * (stakes, payouts, deltas, fates, credited, lost, amounts, pushes, the point
 * before and after, the seven-out, the carry in and out) and holds the
 * carries to the invariants a craps table keeps (a contract bet leaves the
 * felt only by winning or losing; no one-roll or box bet rides; odds ride
 * with their flat; nothing rides past a seven-out; the shooter rules). A
 * checkpoint's carry and nets are checked against what the checker played at
 * the close it names.
 */

import * as Y from 'yjs';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { CHIP_DENOMS } from './chipDisplay';
import { canon, parseKey, seedTable, slipCommit } from './computedFold';
import type { CloseRec, CrapsSlipRec, FoldCtx, FoldResult, RoundView } from './computedFold';
import type { ComputedCrapsState, ComputedSlipWrite } from './computedTable';
import type { Shown, Sim, SimPage, FlipKind } from './computedSim';
import { snapshot } from './computedTestKit';
import {
  canPlaceBet, canTakeDown, isOddsType, maxOddsStake, nextPoint, oddsFlat, oddsRoom, pickShooter, resolveCrapsBet, resolveCrapsRound,
  resolveOddsStack, shooterHandOver,
} from './games/craps';
import type { CrapsBet, CrapsBetType } from './games/craps';
import { combineSeeds } from './games/diceFairness';

// ── The felt's own numbers (copied: casinoTableSession keeps them private) ──

/** casinoTableSession MAX_STACK_CHIPS: chips the felt draws of one box. */
const MAX_STACK_CHIPS = 60;
/** casinoTableSession MAX_BETS_DRAWN_PER_PLAYER: chips the felt draws of one player. */
const MAX_BETS_DRAWN_PER_PLAYER = 400;
/** casinoDoc / fairTableSeeds MAX_TABLE_BETTORS: the felt's newcomer check. */
const MAX_TABLE_BETTORS = 31;

/** The design's numbers the checker plays by (computedCraps has its own;
 *  this file reads none of them from there). */
const MAX_RIDERS = 31;
/** The slips one close freezes at most (computedFold MAX_FROZEN). */
const MAX_FROZEN = 31;
const MAX_SHOOTER_PID = 128;
/** A pid as a record may carry one (1–256 characters, never __proto__). */
const MAX_PID = 256;
/** A canonical felt: at most 49 spots, 1e12 chips in all and a spot. */
const MAX_SPOTS = 49;
const MAX_FELT_CHIPS = 1e12;
const CARRY_POINTS = new Set([0, 4, 5, 6, 8, 9, 10]);
const POINTS = new Set([4, 5, 6, 8, 9, 10]);
const HARDS = new Set([4, 6, 8, 10]);
/** How far before the end of betting a rider's page at the table must
 *  have seen the roll open for its ride slip to be in every close: the
 *  duty's tick (TICK_MS) and a frame, the network's delay, and room to
 *  spare (the rider oracle). */
const RIDER_MARGIN_MS = 2_000;
/** How long the page that closes a roll must have been up and hearing the
 *  room before a rider's look for the rider oracle to hold it to the ride
 *  slip: a resync (5 s) and a frame. */
const RIDER_SETTLE_MS = 5_500;

/** The 19 bet types. */
export const BET_TYPES: readonly CrapsBetType[] = [
  'pass', 'dontpass', 'come', 'dontcome', 'field', 'place', 'big6', 'big8', 'hard', 'anyseven', 'anycraps', 'two', 'three', 'yo',
  'twelve', 'passodds', 'dontpassodds', 'comeodds', 'dontcomeodds',
];
const ONE_ROLL = new Set<CrapsBetType>(['field', 'anyseven', 'anycraps', 'two', 'three', 'yo', 'twelve']);

// ── 🤖 The craps player ──────────────────────────────────────────────────────

/** Where a player is at a craps table: a stand 1–7, null for the device
 *  front (the table's UI up with no stand: it bets and throws, its slips
 *  carry no stand), 'off' for off the table (no UI: it bets nothing, and
 *  its page joins only rolls others play). */
export type Place = number | null | 'off';

export interface CrapsBotSpec {
  /** Chance per frame, while betting is open and its player at the table,
   *  of a move (a bet, a take-down). */
  move: number;
  /** Weights of the moves: each bet type (default 1), one spot taken down,
   *  everything that may come down taken down. */
  weights?: Partial<Record<CrapsBetType, number>>;
  /** A bet type no roll of the run has won or lost yet weighs this many
   *  times its weight (1: none): a run reaches all 19 sooner. */
  seek: number;
  /** It takes no spot down on its own of a type no roll of the run has won
   *  or lost yet (the ↶ takes everything that may come down, as ever): a run
   *  sees all 19 decided sooner. */
  keep: boolean;
  takeOne: number;
  takeAll: number;
  /** Chips a bet. */
  amount: [number, number];
  /** Odds: this percentage of the room oddsRoom gives, drawn. */
  odds: [number, number];
  /** The shooter throws this many ms into the wait for the throw (20 s:
   *  a draw past it is TIME'S UP). */
  fling: [number, number];
  /** Every this-many-th offer of the dice in the room (0: none) draws its
   *  throw past the 20 s wait (from 20.25 s to fling's top): a run is sure
   *  to have some. */
  lateEvery: number;
  /** Chance per frame, during another holder's wait, of a fake throw record. */
  fake: number;
  /** Chance per frame (betting or not, not in the quiet period) of moving,
   *  and where to. */
  standMove: number;
  places: Place[];
  /** Chance per betting frame of a deliberate try the table must refuse. */
  tries: number;
  /** Buy this many chips in when the player has fewer than `low`. */
  low: number;
  topUp: number;
}

/** The baseline player: every bet type (the don't side and the odds drawn
 *  more, as they need a point and a flat bet first; a type no roll has
 *  decided yet more again, and kept on the felt), take-downs, odds,
 *  stand moves, throws over the whole wait and a little past it (every
 *  sixth offer past it). */
export const CRAPS_BOT: CrapsBotSpec = {
  move: 0.06,
  weights: { dontcome: 4, come: 4, comeodds: 14, dontcomeodds: 14, passodds: 3, dontpassodds: 4, dontpass: 2, pass: 2 },
  seek: 6,
  keep: true,
  takeOne: 1.5,
  takeAll: 1,
  amount: [1, 30],
  odds: [20, 100],
  fling: [0, 22_000],
  lateEvery: 6,
  fake: 0.004,
  standMove: 1 / 400,
  places: [1, 2, 3, 4, 5, 6, 7, null, 'off'],
  tries: 0.01,
  low: 150,
  topUp: 1_000,
};

/** A whole number from lo to hi, both in (computedSim between). */
const between = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

// ── 🧮 Felts, as the checker reads them ──────────────────────────────────────

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const spotOf = (b: { type: string; pick?: number }): string => `${b.type}:${b.pick ?? ''}`;
/** The pick a bet type takes (games/craps isCrapsBet): a come or don't
 *  come in the box (none) or on its number. (In a carry too: a void hands
 *  on the felt as it was frozen, a come just put down in the box with it,
 *  the design's "every bet stands as the players left it"; a roll with dice
 *  moves every come off the box, which the checker's own carry checks.) */
function pickOk(b: CrapsBet): boolean {
  const p = b.pick;
  if (b.type === 'come' || b.type === 'dontcome') return p === undefined || (Number.isInteger(p) && POINTS.has(p));
  if (b.type === 'place' || b.type === 'comeodds' || b.type === 'dontcomeodds') return Number.isInteger(p) && POINTS.has(p!);
  if (b.type === 'hard') return Number.isInteger(p) && HARDS.has(p!);
  return p === undefined;
}
const entry = (type: CrapsBetType, pick: number | undefined, amount: number): CrapsBet =>
  pick === undefined ? { type, amount } : { type, pick, amount };

/** Any list of bets as one entry a spot, summed, empties dropped, by spot
 *  key as a string (the felt's own order). */
export function canonList(list: readonly CrapsBet[]): CrapsBet[] {
  const sums = new Map<string, CrapsBet>();
  for (const b of list) {
    const k = spotOf(b);
    sums.set(k, entry(b.type, b.pick, (sums.get(k)?.amount ?? 0) + b.amount));
  }
  return [...sums.keys()].sort().map((k) => sums.get(k)!).filter((b) => b.amount > 0);
}

const sumOf = (f: readonly CrapsBet[]): number => f.reduce((n, b) => n + b.amount, 0);
const bySpot = (f: readonly CrapsBet[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const b of f) m.set(spotOf(b), (m.get(spotOf(b)) ?? 0) + b.amount);
  return m;
};
/** Per spot the smaller of B and C: what of B stood on the felt before. */
function minPer(B: readonly CrapsBet[], C: readonly CrapsBet[]): CrapsBet[] {
  const c = bySpot(C);
  return canonList(B.map((b) => entry(b.type, b.pick, Math.min(b.amount, c.get(spotOf(b)) ?? 0))));
}
/** Chips B adds over C, spot by spot. */
function addedOver(B: readonly CrapsBet[], C: readonly CrapsBet[]): number {
  const c = bySpot(C);
  return B.reduce((n, b) => n + Math.max(0, b.amount - (c.get(spotOf(b)) ?? 0)), 0);
}

/** The stamp a slip built on point `p` and riding felt C carries (the
 *  design: the first 32 hex of sha256 of 'ssf-ct-basis-v1|' and the
 *  canonical {p, w}). */
export function stampOf(p: number, C: readonly CrapsBet[]): string {
  return bytesToHex(sha256(utf8ToBytes(`ssf-ct-basis-v1|${canon({ p, w: C })}`))).slice(0, 32);
}

/** The table rules for a felt B following C with `point` on (the felt's own
 *  buttons' rules, the design's "every page checks the table rules"): a spot
 *  goes up only where a bet of its type may be placed, and never on a come
 *  or don't come that has travelled; it comes down only where the bet may
 *  be taken down. */
function rulesOk(C: readonly CrapsBet[], B: readonly CrapsBet[], point: number | null): boolean {
  const before = bySpot(C);
  const after = bySpot(B);
  const all = new Map<string, CrapsBet>();
  for (const b of [...C, ...B]) all.set(spotOf(b), b);
  for (const [k, b] of all) {
    const was = before.get(k) ?? 0;
    const is = after.get(k) ?? 0;
    if (is > was && (!canPlaceBet(b.type, point) || ((b.type === 'come' || b.type === 'dontcome') && b.pick !== undefined))) return false;
    if (is < was && !canTakeDown(b, point)) return false;
  }
  return true;
}

/** A contract bet with point `p` on (0: a come-out): a pass on its point, a
 *  come bet that travelled. */
const isContract = (b: CrapsBet, p: number): boolean => (b.type === 'pass' && p !== 0) || (b.type === 'come' && b.pick !== undefined);

/** The chips the felt draws an amount as (casinoTableSession drawnChips). */
function drawnChips(amount: number): number {
  let left = Math.max(0, Math.floor(amount));
  let n = 0;
  for (const d of CHIP_DENOMS) {
    n += Math.floor(left / d);
    left %= d;
  }
  return n;
}

/** A spot's chips as the felt draws them, a record a chip. */
function chipsOf(b: CrapsBet): CrapsBet[] {
  const out: CrapsBet[] = [];
  let left = b.amount;
  for (const d of CHIP_DENOMS) {
    for (; left >= d; left -= d) out.push(entry(b.type, b.pick, d));
  }
  return out;
}

/** A small hash of a string, for the chip splits (the same every run). */
function hashInt(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** A felt as records a chip (up to 20 chips a spot), else in 2–7 parts:
 *  what the checker hands resolveCrapsRound, so a merged felt is held to
 *  pay what a felt of chips does. */
function splitChips(felt: readonly CrapsBet[], salt: string): CrapsBet[] {
  const out: CrapsBet[] = [];
  for (const b of felt) {
    if (b.amount <= 20) {
      for (let i = 0; i < b.amount; i++) out.push(entry(b.type, b.pick, 1));
      continue;
    }
    const parts = 2 + (hashInt(`${salt}|${spotOf(b)}`) % 6);
    const base = Math.floor(b.amount / parts);
    for (let i = 0; i < parts; i++) out.push(entry(b.type, b.pick, base + (i < b.amount - base * parts ? 1 : 0)));
  }
  return hashInt(salt) % 2 === 1 ? out.reverse() : out;
}

// ── The carry, as the checker keeps it ───────────────────────────────────────

/** What one roll hands the next: the point (0: a come-out), every rider's
 *  felt, who holds the dice, the last shooter, and whether the holder is in
 *  play. */
interface K {
  p: number;
  w: Map<string, CrapsBet[]>;
  h?: string;
  a?: string;
  i?: 1;
}

/** A carry as the fold spells it (null-prototype `w` read by own keys). */
interface CarryLike { p: number; w: Record<string, CrapsBet[]>; h?: string; a?: string; i?: 1 }

function fromCarry(c: CarryLike | null | undefined): K {
  if (!c) return { p: 0, w: new Map() };
  const w = new Map<string, CrapsBet[]>();
  for (const pid of Object.keys(c.w)) w.set(pid, [...c.w[pid]]);
  return { p: c.p, w, ...(c.h !== undefined ? { h: c.h } : {}), ...(c.a !== undefined ? { a: c.a } : {}), ...(c.i !== undefined ? { i: c.i } : {}) };
}

function plainOf(k: K): object {
  const w: Record<string, CrapsBet[]> = {};
  for (const pid of [...k.w.keys()].sort()) Object.defineProperty(w, pid, { value: k.w.get(pid), enumerable: true, writable: true, configurable: true });
  return { p: k.p, w, h: k.h, a: k.a, i: k.i };
}

const carryText = (k: K): string => canon(plainOf(k)) ?? 'junk';
const textOf = (c: CarryLike | null | undefined): string => (c ? canon(c) ?? 'junk' : 'null');
const netsText = (m: ReadonlyMap<string, bigint>): string =>
  JSON.stringify([...m].filter(([, n]) => n !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => [k, n.toString()]));
const mapText = (m: ReadonlyMap<string, bigint | number>): string =>
  JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => [k, n.toString()]));

type Fate = 'rider' | 'basis' | 'illegal' | 'full' | 'ok';

/** A frozen (or latest) slip as the session holds it. */
interface SlipIn { b: CrapsBet[]; o: string; t?: number; c: string; l?: 1 }

/** What a roll's felts are, before the dice: each player's fate and the
 *  felt that stood for it (B), riders first for the room, newcomers in pid
 *  order (the design's room rule: riders count, gone ones too). */
function feltsOf(k: K, slips: ReadonlyMap<string, SlipIn>): { pids: string[]; fate: Map<string, Fate>; B: Map<string, CrapsBet[]> } {
  const point = k.p === 0 ? null : k.p;
  const pids = [...new Set([...k.w.keys(), ...slips.keys()])].sort();
  let room = MAX_RIDERS - k.w.size;
  const fate = new Map<string, Fate>();
  const B = new Map<string, CrapsBet[]>();
  for (const pid of pids) {
    const C = k.w.get(pid) ?? [];
    const s = slips.get(pid);
    let f: Fate;
    if (!s) f = 'rider';
    else if (s.o !== stampOf(k.p, C)) f = 'basis';
    else if (!rulesOk(C, s.b, point)) f = 'illegal';
    else if (C.length === 0 && s.b.length > 0) f = room-- > 0 ? 'ok' : 'full';
    else f = 'ok';
    fate.set(pid, f);
    B.set(pid, f === 'ok' ? canonList(s!.b) : C);
  }
  return { pids, fate, B };
}

/** What a craps roll a page showed looks like on its screen: the dice, the
 *  point after, the seven-out, what it hands on (the riding bets, the dice's
 *  hands), and what it paid each player (credited) and moved their chips by;
 *  and, beside what it showed, the table it played from (sIn: a roll paid
 *  again on the same dice is one whose table before it changed). */
export function crapsShownOf(v: RoundView): Shown {
  const pay = [...v.deltas.keys()].sort().map((pid) => [pid, (v.payouts.get(pid) ?? 0n).toString(), v.deltas.get(pid)!.toString()]);
  const roll = v.craps;
  return {
    seen: JSON.stringify([roll?.dice ?? null, roll?.pointAfter ?? null, roll?.sevenOut ?? false, roll ? textOf(roll.sOut) : null, pay]),
    close: v.close, decided: v.decided ?? 'undecided',
    ...(v.forfeit ? { fk: v.forfeit.rec.k } : {}),
    ...(roll ? { sIn: textOf(roll.sIn) } : {}),
  };
}

/** What took a roll a page showed from `was` to `is` (both decided, not
 *  alike): computedSim changeKind's kinds, and 'repaid' for the same close
 *  decided the same way on the same dice from another table before it (an
 *  earlier roll changed, and this one played again from the state it left).
 *  The same roll on the same dice from the same table paying otherwise is
 *  no replay: 'other'. */
export function crapsChangeKind(was: Shown, is: Shown): FlipKind {
  const dice = (s: Shown): string => JSON.stringify((JSON.parse(s.seen) as unknown[])[0]);
  if (is.close === was.close && is.decided === was.decided && is.fk === was.fk && dice(is) === dice(was)) {
    return is.sIn !== undefined && was.sIn !== undefined && is.sIn !== was.sIn ? 'repaid' : 'other';
  }
  if (is.close !== was.close) return 'rival close';
  if (was.decided === 'void') return 'void undone';
  if (was.decided === 'reveals' && is.decided === 'forfeit') return 'forfeit over reveals';
  return was.decided === 'forfeit' && is.decided === 'forfeit' ? 'answer forfeit' : 'other';
}

// ── Per page ─────────────────────────────────────────────────────────────────

/** A deliberate try: its kind, the answer it must get, the list and stamp. */
interface Try { kind: string; want: string; list: CrapsBet[]; basis: string }

/** A planned throw: its offer's key, when, the wait's end (D) as offered. */
interface Plan { key: string; inc: string; r: number; at: number; D: number; done: boolean; missed: boolean }

/** computedSim SIM_STEP: one frame of the room (copied, as computedSim
 *  imports this file). */
const FRAME_MS = 250;

interface CrapsPage {
  /** By table: where its player is (its intent, kept across loads). */
  place: Map<string, Place>;
  /** Of this load (the table UI's, lost on reload): by table, this window's
   *  chips by spot (`<inc>|<round>`), the take-back's ledger. */
  added: Map<string, { key: string; spots: Map<string, number> }>;
  /** Of this load: the felt and stamp its last move was built on (a draft
   *  kept across frames: a try once the table moved on). */
  built: Map<string, { basis: string; felt: CrapsBet[] }>;
  /** Of this load: its planned throw by table, and the UI's offer. */
  plan: Map<string, Plan>;
  offered: Map<string, { inc: string; r: number }>;
  forms: number;
  /** Of this load: its goodbye (the time, and its own slip keys then). */
  bye: { at: number; keys: Set<string> } | null;
  /** Of this load: crapsCroupier (the stickman's tick, markLocalSeat). */
  croupier: typeof import('./crapsCroupier') | null;
  /** Of every load: the deliberate tries this page made for certain, once
   *  each, the first frame each could be made (no draw taken for them). */
  sure: Set<string>;
  /** While its player's own write runs (writeComputedCrapsSlip, or a
   *  press on its mounted table UI): the felt and stamp it asked for at
   *  table t (null: a press the UI must refuse, which writes nothing).
   *  While its goodbye runs (leaveComputedTables): true. A slip version its
   *  page writes is held to these, or to what its duties may write on their
   *  own (ownSlip). */
  writing: { t: string; felt: CrapsBet[] | null; basis: string } | null;
  saying: boolean;
  /** Of this load, by table: the last felt its player's write was answered
   *  'ok' for (written, or held back for the flush to write). */
  lastOk: Map<string, { r: number; felt: CrapsBet[]; basis: string }>;
  /** Of this load: the slip keys of its player's it has seen its own
   *  transactions write (a re-put or a trim's copy writes one again). */
  slipKeys: Set<string>;
  /** Of this load, by table: its own fling (the time it noted it). */
  flungAt: Map<string, { inc: string; r: number; at: number }>;
  /** Of this load, by table: the end of betting (W) and of the wait for the
   *  throw (D) its view last gave for the open roll (the close oracle). */
  waitOf: Map<string, { inc: string; r: number; W?: number; D?: number }>;
  /** Of this load: when it loaded (the room's time), its frames run, and by
   *  table the rider look waiting for its next frame (riderLook). */
  loadedT: number;
  frames: number;
  riderPending: Map<string, { key: string; frames: number; T: number }>;
}

/** A goodbye due at table t as a page leaves: the felt it must write
 *  (null: none due). */
export interface Goodbye { t: string; felt: CrapsBet[] | null }

/** What a seed's run of the craps side counted. */
export interface CrapsStats {
  moves: number;
  places: number;
  takeOne: number;
  takeAll: number;
  odds: number;
  perChipLists: number;
  offers: number;
  flings: number;
  timesUp: number;
  fakes: number;
  standMoves: number;
  goodbyes: number;
  /** The planned throws' delays into the wait, ms. */
  delays: number[];
  /** Rolls worked out afresh, bases checked and not, invariant checks. */
  rollsChecked: number;
  basesChecked: number;
  basesUnchecked: number;
  heldChecked: number;
  /** Rolls the memo answered (each compared with what it held). */
  memoHits: number;
  /** Walks that stopped at a record the session lacked (by what). */
  stops: Record<string, number>;
  /** A move's 'chips' over a felt the page held back (the writer counts
   *  its chips, the UI's own check doesn't: NOT ENOUGH CHIPS). */
  chipsHeldBack: number;
  /** Planned throws a close of their roll cut short, the wait not over
   *  (none on a table that waits its 20 s); offers cut short so on a page
   *  that loaded or woke since the show before the roll's window (its own
   *  window and wait come later than the room's: the design's reloaded
   *  shooter, "can't throw that roll while another player's page closes
   *  it"); offers its own page's view took back with no close in (a wake's
   *  hold of the last forfeit, a re-show); and offers left by the shooter's
   *  own move off the table. */
  preempted: number;
  cutAfterReturn: number;
  offersBack: number;
  walkedOff: number;
  /** Closes timed against the wait for the throw, and closes of a roll
   *  waiting for one the page hadn't seen the wait of (just loaded). */
  closesChecked: number;
  closesUnchecked: number;
  /** Settled views and round checks compared with the checker's roll, and
   *  views of a roll the checker had no figures for. */
  viewsChecked: number;
  viewsUnchecked: number;
  /** Slip versions pages wrote on their own (ride slips, stand rewrites,
   *  flushes, re-commits, goodbye put-backs), held to what they must say. */
  ownSlips: number;
  /** Riders seen at the table with betting open (the rider oracle), and
   *  honest felts' odds held to the table's cap. */
  ridersSeen: number;
  oddsCapped: number;
  /** Rolls worked out afresh: each player's fate, by fate; forfeited
   *  players who lost chips they added (lost > 0), who lost nothing (their
   *  felt only rode), and whose bets from before the roll played on the
   *  dice (what an owner-run forfeit, the whole felt, would take); voided
   *  felts that changed on the roll (kept: the design's "a void keeps this
   *  roll's changes"). */
  fates: Record<string, number>;
  forfeitLost: number;
  forfeitRode: number;
  forfeitPlayed: number;
  voidChanged: number;
  /** Ended incarnations' final checkpoints held to the checker's nets. */
  endedChecked: number;
}

/** A roll as the checker played it: what a page's screen must show of it
 *  while settled (its view) and in the ⚙ card (computedRoundCheck.roll). */
interface Exp {
  r: number;
  close: string;
  decided: string;
  /** The fold's dice (held to the counted seeds' draw on its own). */
  dice: [number, number] | null;
  pointBefore: number | null;
  pointAfter: number | null;
  sevenOut: boolean;
  hIn?: string;
  hOut?: string;
  /** Every rider's felt after it, canonical, by pid; and how many. */
  wOut: string;
  riders: number;
  credited: Map<string, bigint>;
  amounts: Map<string, bigint>;
  pushes: string[];
  /** The carry it played from (a roll played again from another reads
   *  otherwise). */
  sIn: string;
}

/** The riding felts of a carry as one string (pid order). */
const ridingText = (w: ReadonlyMap<string, CrapsBet[]> | Record<string, CrapsBet[]>): string => {
  const m = w instanceof Map ? w : new Map(Object.entries(w));
  return JSON.stringify([...m].filter(([, f]) => f.length > 0).sort(([a], [b]) => (a < b ? -1 : 1)).map(([pid, f]) => [pid, canon(canonList(f))]));
};

/** The fold's figures of one roll, as one string: what a memo hit must
 *  find again. */
function rollDigest(v: RoundView): string {
  const roll = v.craps;
  const m = (map: ReadonlyMap<string, bigint>): [string, string][] => [...map.keys()].sort().map((k) => [k, map.get(k)!.toString()]);
  return JSON.stringify({
    counted: v.counted, stakes: m(v.stakes), payouts: m(v.payouts), deltas: m(v.deltas),
    roll: roll ? {
      dice: roll.dice, pointBefore: roll.pointBefore, pointAfter: roll.pointAfter, sevenOut: roll.sevenOut,
      fates: [...roll.fates].sort(([a], [b]) => (a < b ? -1 : 1)), credited: m(roll.credited), lost: m(roll.lost),
      amounts: m(roll.amounts), pushes: [...roll.pushes].sort(), sIn: textOf(roll.sIn as CarryLike), sOut: textOf(roll.sOut as CarryLike),
    } : null,
  });
}

// ── The harness ──────────────────────────────────────────────────────────────

export class CrapsHarness {
  private readonly pages = new Map<SimPage, CrapsPage>();
  /** Of each close the checker played, every carry and nets it handed on
   *  (a close's carry can change with an earlier roll): a checkpoint naming
   *  the close must carry one of them; and the nets alone (a final
   *  checkpoint carries no table). */
  private readonly expectAt = new Map<string, Set<string>>();
  private readonly expectNetsAt = new Map<string, Set<string>>();
  /** Rolls worked out, by page, close, decision, count and the carry they
   *  played from: what they handed on, their deltas, the fold's figures of
   *  the roll then (a hit must find them again) and what its screen shows. */
  private readonly memo = new Map<string, { k: K; deltas: Map<string, bigint>; digest: string; exp: Exp }>();
  private readonly walked = new WeakSet<FoldResult>();
  /** Of each fold result walked to its end: every decided roll's figures, by
   *  roll; and by page and table, the last of each roll seen (a trim takes
   *  the roll on screen out of the session). */
  private readonly exps = new WeakMap<FoldResult, Map<number, Exp>>();
  private readonly lastExp = new Map<string, Map<number, Exp>>();
  /** `<t>|<inc>|<roll>|<pid>`: a rider whose page was at the table, up and
   *  awake, with the roll taking bets well before its end (the rider
   *  oracle: such a rider's ride slip is in the close). */
  private readonly riderSeen = new Map<string, number>();
  /** By player: the last time a page of theirs said goodbye (sim T). */
  private readonly byeT = new Map<string, number>();
  /** `<t>|<inc>|<close>|<pid>`: a felt a forfeit didn't count on a roll with
   *  dice, as the checker played it: the chips it lost (added this roll)
   *  and the chips of it that played (from before the roll). */
  readonly forfeitOf = new Map<string, { lost: number; played: number }>();
  /** The room's times the network lost or cut off anything (a partition, a
   *  deaf page, a lossy or slow link), as runs of ticks; and the last tick
   *  looked at. */
  private readonly dirty: [number, number][] = [];
  private netT = -Infinity;
  /** `<t>|<inc>|<roll>|<pid>`: what the ⚙ card flagged (any page's). */
  readonly flagged = new Set<string>();
  private readonly counted = new Set<string>();
  private readonly baseSeen = new Set<string>();
  /** The 19 types: placed (chips added on a roll that played them) and
   *  decided (won or lost, not a push nor riding on). */
  readonly coverage = new Map<CrapsBetType, { placed: number; decided: number }>(BET_TYPES.map((t) => [t, { placed: 0, decided: 0 }]));
  /** The deliberate tries the table refused, by kind (and any other answer). */
  readonly tries: Record<string, number> = {};
  readonly stats: CrapsStats = {
    moves: 0, places: 0, takeOne: 0, takeAll: 0, odds: 0, perChipLists: 0, offers: 0, flings: 0, timesUp: 0, fakes: 0, standMoves: 0,
    goodbyes: 0, delays: [], rollsChecked: 0, basesChecked: 0, basesUnchecked: 0, heldChecked: 0, memoHits: 0, stops: {},
    chipsHeldBack: 0, preempted: 0, cutAfterReturn: 0, offersBack: 0, walkedOff: 0, closesChecked: 0, closesUnchecked: 0, viewsChecked: 0, viewsUnchecked: 0, ownSlips: 0,
    ridersSeen: 0, oddsCapped: 0, fates: {}, forfeitLost: 0, forfeitRode: 0, forfeitPlayed: 0, voidChanged: 0, endedChecked: 0,
  };
  /** The craps table's stands (FURNITURE_DEFS, read on the first load). */
  private stands: { x: number; z: number }[] = [];

  constructor(private readonly sim: Sim) {}

  private page(sp: SimPage): CrapsPage {
    let c = this.pages.get(sp);
    if (!c) {
      const idx = this.sim.pages.includes(sp) ? this.sim.pages.indexOf(sp) : this.sim.pages.length;
      const first: Place = sp.spec.place !== undefined ? sp.spec.place : (idx % 7) + 1;
      c = {
        place: new Map(this.crapsTables().map((t) => [t, first])), added: new Map(), built: new Map(), plan: new Map(),
        offered: new Map(), forms: idx, bye: null, croupier: null, sure: new Set(), writing: null, saying: false, lastOk: new Map(),
        slipKeys: new Set(), flungAt: new Map(), waitOf: new Map(), loadedT: this.sim.T, frames: 0, riderPending: new Map(),
      };
      this.pages.set(sp, c);
    }
    return c;
  }

  private crapsTables(): string[] {
    return this.sim.tables.filter((t) => this.sim.gameOf(t) === 'craps');
  }

  private botOf(sp: SimPage): CrapsBotSpec {
    return sp.spec.crapsBot ?? this.sim.opts.crapsBot ?? CRAPS_BOT;
  }

  /** Where page sp's player is at table t. */
  placeOf(sp: SimPage, t: string): Place {
    return this.page(sp).place.get(t) ?? 'off';
  }

  /** The angle of stand n around the table (atan2(z, x) in the table's
   *  frame: pickShooter's ring order), from the furniture's own stands. */
  private angleOf(n: number): number {
    const s = this.stands[n];
    return Math.atan2(s.z, s.x);
  }

  // ── Loads, stands, the stickman ──

  /** A load of page sp: its craps modules (this load's generation), and what
   *  a table UI keeps only while loaded forgotten. */
  async loaded(sp: SimPage): Promise<void> {
    const c = this.page(sp);
    c.croupier = await import('./crapsCroupier');
    if (this.stands.length === 0) {
      const { FURNITURE_DEFS } = await import('./furniture');
      this.stands = (FURNITURE_DEFS['craps-table'].stands ?? []).map((s) => ({ x: s.stand.x, z: s.stand.z }));
    }
    c.added.clear();
    c.built.clear();
    c.plan.clear();
    c.offered.clear();
    c.bye = null;
    c.writing = null;
    c.saying = false;
    c.lastOk.clear();
    c.slipKeys.clear();
    c.flungAt.clear();
    c.waitOf.clear();
    c.loadedT = this.sim.T;
    c.frames = 0;
    c.riderPending.clear();
  }

  /** A frame of page sp ran (its tables' duties with it). */
  framed(sp: SimPage): void {
    this.page(sp).frames += 1;
  }

  /** Page sp's player where it is at table t: its stand marked page-local
   *  (markLocalSeat, as a mounted table marks it) and its seat beaten; at
   *  the device front or off the table, no stand and no seat. */
  sit(sp: SimPage, t: string, now: number): void {
    if (sp.leaving) return;
    this.apply(sp, t, this.placeOf(sp, t), now);
  }

  private apply(sp: SimPage, t: string, at: Place, now: number): void {
    const c = this.page(sp);
    const { casino, stands } = sp.p;
    if (typeof at === 'number') {
      if (c.croupier) c.croupier.markLocalSeat(t, sp.pid, true, at);
      else stands.setLocalStand(t, sp.pid, true, at);
      casino.writeMySeat(t, sp.pid, { stand: at, angle: this.angleOf(at), at: now });
    } else {
      if (c.croupier) c.croupier.markLocalSeat(t, sp.pid, false);
      else stands.setLocalStand(t, sp.pid, false);
      casino.clearMySeat(t, sp.pid);
    }
  }

  /** Page sp's player goes to `at` at table t (a spec's move, or the bot's). */
  moveTo(sp: SimPage, t: string, at: Place, now: number): void {
    this.page(sp).place.set(t, at);
    this.stats.standMoves += 1;
    this.apply(sp, t, at, now);
  }

  /** The house's turn at craps table t: the stickman's tick (World's). */
  stickman(sp: SimPage, t: string): void {
    this.page(sp).croupier?.tickAutoStickman(t);
  }

  // ── The player ──

  /** One frame of page sp's player at craps table t, betting on. */
  bot(sp: SimPage, t: string, now: number): void {
    const bot = this.botOf(sp);
    if (bot.standMove > 0 && sp.rand() < bot.standMove) {
      const cur = this.placeOf(sp, t);
      const to = bot.places.filter((x) => x !== cur);
      if (to.length > 0) this.moveTo(sp, t, to[between(sp.rand, 0, to.length - 1)], now);
    }
    this.shooter(sp, t, now, bot, true);
    this.bet(sp, t, now, bot);
  }

  /** One frame of page sp's player with betting off (the quiet period): it
   *  still throws the dice it is offered. */
  idle(sp: SimPage, now: number): void {
    const bot = this.botOf(sp);
    for (const t of sp.spec.botTables ?? this.sim.tables) {
      if (sp.inRoom.has(t) && this.sim.gameOf(t) === 'craps') this.shooter(sp, t, now, bot, false);
    }
  }

  /** The shooter's throw, as the table UI offers it (myThrowPending: the wait
   *  for the throw, this player the shooter, no fling of its own for the roll
   *  yet, its player at the table) and sendThrow makes it, at a time drawn
   *  into the wait; and now and then a fake throw record during another's. */
  private shooter(sp: SimPage, t: string, now: number, bot: CrapsBotSpec, betting: boolean): void {
    const c = this.page(sp);
    const { casino, croupier, table } = sp.p;
    const v = table.readComputedCraps(t, now);
    if (!v) return;
    const at = this.placeOf(sp, t);
    let plan = c.plan.get(t);
    const pending = v.phase === 'closing' && v.shooter === sp.pid && v.phaseDeadline !== undefined && at !== 'off'
      && table.computedFlungFor(t, now)?.r !== v.round;
    if (!pending) {
      // The offer gone with no throw: TIME'S UP once the wait ran out; the
      // shooter's own doing when its player went off the table; before
      // either, the offer was taken away early (preempted).
      if (plan && !plan.done && !plan.missed) {
        plan.missed = true;
        this.missed(sp, t, plan, at === 'off', v.round !== plan.r, now, `${sp.name} ${t} roll ${v.round} (${v.phase}${v.phaseDeadline !== undefined ? ` to ${v.phaseDeadline}` : ''})`);
      }
      if (betting && bot.fake > 0 && v.phase === 'closing' && v.phaseDeadline !== undefined && v.shooter !== undefined && v.shooter !== sp.pid
        && sp.rand() < bot.fake) {
        casino.writeDiceThrow(t, this.throwOf(sp, t, v.round, v.shooter));
        this.stats.fakes += 1;
      }
      return;
    }
    c.offered.set(t, { inc: v.inc, r: v.round });
    const key = `${v.inc}|${v.round}|${v.showEnd}|${v.rearmAt ?? ''}`;
    if (!plan || plan.key !== key) {
      if (plan && !plan.done && !plan.missed) this.missed(sp, t, plan, false, true, now, `${sp.name} ${t} roll ${v.round} offered again (${key})`);
      const W = v.phaseDeadline! - croupier.CRAPS_SHOOTER_MS;
      const late = bot.lateEvery > 0 && (this.stats.offers + 1) % bot.lateEvery === 0 && bot.fling[1] > 20_250;
      const delay = between(sp.rand, late ? 20_250 : bot.fling[0], bot.fling[1]);
      plan = { key, inc: v.inc, r: v.round, at: W + delay, D: v.phaseDeadline!, done: false, missed: false };
      c.plan.set(t, plan);
      this.stats.offers += 1;
      this.stats.delays.push(delay);
    }
    if (now < plan.at || plan.done) return;
    const thr = this.throwOf(sp, t, v.round, sp.pid);
    casino.writeDiceThrow(t, thr);
    // (It must read back: a throw readDiceThrow drops animates nowhere.)
    if (JSON.stringify(casino.readDiceThrow(t)) !== JSON.stringify(thr)) {
      this.sim.violate(`${sp.name}'s throw at ${t} roll ${v.round} at ${this.sim.elapsed} ms doesn't read back: ${JSON.stringify(thr)}`);
    }
    table.noteComputedFling(t, v.round, thr.seed, now);
    c.flungAt.set(t, { inc: v.inc, r: v.round, at: now });
    plan.done = true;
    this.stats.flings += 1;
  }

  /** The first few offers taken away early, as they read. */
  readonly preemptLog: string[] = [];

  /** A planned throw of page sp's at table t whose offer went, unthrown:
   *  its own move off the table, TIME'S UP (the wait over, or within a frame
   *  of its end), or taken away early: by a close of its roll (preempted,
   *  unless the page loaded or woke since the show before the roll's
   *  window, cutAfterReturn), or with no close in by its own view going
   *  `back` (to another roll: a wake's hold of the last forfeit, a re-show;
   *  or offered again after one: offersBack). An offer gone with no close in
   *  and the view still on its roll is preempted too. */
  private missed(sp: SimPage, t: string, plan: Plan, off: boolean, back: boolean, now: number, what: string): void {
    if (off) this.stats.walkedOff += 1;
    else if (now < plan.D - FRAME_MS) {
      const res = sp.p.casino.computedFoldOf(t);
      const closed = !!res && sp.p.casino.computedIncOf(t) === plan.inc
        && (res.tip?.r === plan.r || res.openCloses.some((o) => o.rec.r === plan.r) || res.rounds.some((x) => x.r === plan.r));
      if (!closed && back) {
        this.stats.offersBack += 1;
        return;
      }
      // (A page back since the room's show before this roll's window ended
      // shows that roll again from its return and runs its own window and
      // wait after it: the design's reloaded shooter, whose page stamps
      // every record at load. The room closes in its own window, at most a
      // show, a window, a wait and every turn after the return.)
      const { croupier, table } = sp.p;
      const span = croupier.CRAPS_SHOW_MS + croupier.CRAPS_BET_WINDOW_MS + croupier.CRAPS_SHOOTER_MS
        + (2 * this.sim.pages.length + 1) * table.STAGGER_MS + 1_000;
      const from = now - sp.p.skew - span;
      if (closed && (this.page(sp).loadedT >= from || sp.away.some(([, b]) => b >= from))) {
        this.stats.cutAfterReturn += 1;
        return;
      }
      this.stats.preempted += 1;
      if (this.preemptLog.length < 10) this.preemptLog.push(`${what} at ${this.sim.elapsed} ms: planned ${plan.at}, the wait to ${plan.D}, now ${now}`);
    } else {
      this.stats.timesUp += 1;
    }
  }

  /** A throw record as the UI's key throw makes one: from its stand toward
   *  the table, a power and a tumble seed. */
  private throwOf(sp: SimPage, t: string, round: number, by: string): { round: number; by: string; sx: number; sz: number; dx: number; dz: number; power: number; seed: number } {
    const at = this.placeOf(sp, t);
    const s = typeof at === 'number' ? this.stands[at] : { x: 0, z: -1.5 };
    const len = Math.hypot(s.x, s.z) || 1;
    const spread = (sp.rand() - 0.5) * 0.4;
    const ix = -s.x / len;
    const iz = -s.z / len;
    const dx = ix - iz * spread;
    const dz = iz + ix * spread;
    const d = Math.hypot(dx, dz) || 1;
    return {
      round, by, sx: s.x * 0.4, sz: s.z * 0.3, dx: dx / d, dz: dz / d, power: 0.6 + sp.rand() * 0.3, seed: between(sp.rand, 0, 2 ** 31 - 1),
    };
  }

  /** This window's chips ledger of page sp at table t (the UI's `added`,
   *  forgotten when the roll moves on). */
  private ledger(c: CrapsPage, t: string, inc: string, round: number): Map<string, number> {
    const key = `${inc}|${round}`;
    let l = c.added.get(t);
    if (!l || l.key !== key) c.added.set(t, l = { key, spots: new Map() });
    return l.spots;
  }

  /** A betting frame of page sp's player at table t: a deliberate try now
   *  and then, else a move with its chance. */
  private bet(sp: SimPage, t: string, now: number, bot: CrapsBotSpec): void {
    const c = this.page(sp);
    const { casino, table } = sp.p;
    const r = sp.rand;
    if (this.placeOf(sp, t) === 'off') return;
    const v = table.readComputedCraps(t, now);
    if (!v || v.phase !== 'betting' || (v.phaseDeadline !== undefined && now >= v.phaseDeadline)) return;
    const { felt, basis } = table.readMyComputedCrapsBets(t, sp.pid, v.round, now);
    // Every kind of try the felt allows now that this page hasn't made yet,
    // for certain, once a page each: a 1% draw a frame can miss a kind for a
    // whole seed (the stale one above all: SIM_SEED=3000's seed 3 drew none).
    // No draw is taken for them, and a try refused writes nothing, so the
    // run goes on as drawn.
    if (bot.tries > 0) for (const k of this.triesFor(sp, t, now, felt, basis, false)) if (!c.sure.has(k.kind)) this.attempt(sp, t, now, v.round, k, true);
    if (r() < bot.tries) {
      const kinds = this.triesFor(sp, t, now, felt, basis, true);
      const k = kinds[between(sp.rand, 0, kinds.length - 1)];
      if (this.attempt(sp, t, now, v.round, k, false) && k.kind === 'stale') c.built.delete(t);
      return;
    }
    if (r() >= bot.move) return;
    const point = v.point;
    const ledger = this.ledger(c, t, v.inc, v.round);
    const w = bot.weights ?? {};
    // The moves the felt allows now, weighted.
    const moves: { w: number; go: () => { list: CrapsBet[]; kind: 'place' | 'odds' | 'takeOne' | 'takeAll'; key?: string; amount?: number; back?: string[] } | null }[] = [];
    const comePicks = (type: 'come' | 'dontcome'): number[] => felt.filter((b) => b.type === type && b.pick !== undefined).map((b) => b.pick!);
    for (const type of BET_TYPES) {
      const weight = (w[type] ?? 1) * (this.coverage.get(type)!.decided === 0 ? bot.seek : 1);
      if (weight <= 0) continue;
      if (isOddsType(type)) {
        const picks = type === 'comeodds' ? comePicks('come') : type === 'dontcomeodds' ? comePicks('dontcome') : [undefined];
        for (const pick of picks) {
          if (oddsRoom(felt, type, pick, point).room <= 0) continue;
          moves.push({
            w: weight / picks.length,
            go: () => {
              const room = oddsRoom(felt, type, pick, point).room;
              const amount = Math.max(1, Math.min(room, Math.floor((room * between(r, bot.odds[0], bot.odds[1])) / 100)));
              return this.placing(sp, t, felt, entry(type, pick, amount), bot, 'odds');
            },
          });
        }
        continue;
      }
      if (!canPlaceBet(type, point)) continue;
      const picks = type === 'place' ? [4, 5, 6, 8, 9, 10] : type === 'hard' ? [4, 6, 8, 10] : [undefined];
      moves.push({ w: weight, go: () => this.placing(sp, t, felt, entry(type, picks[between(r, 0, picks.length - 1)], between(r, bot.amount[0], bot.amount[1])), bot, 'place') });
    }
    // One spot back, as the felt's take-back does it: the whole spot where it
    // may come down any time (not the don't side, which only ↶ takes whole),
    // else this window's chips. (Not of a type the run hasn't seen decided,
    // with `keep`.)
    const kept = (b: CrapsBet): boolean => bot.keep && this.coverage.get(b.type)!.decided === 0;
    const backs = felt.filter((b) => !kept(b)).map((b) => {
      const anyTime = canTakeDown(b, point) && b.type !== 'dontpass' && b.type !== 'dontcome';
      return { b, back: anyTime ? b.amount : Math.min(b.amount, ledger.get(spotOf(b)) ?? 0) };
    }).filter((x) => x.back > 0);
    if (backs.length > 0 && bot.takeOne > 0) {
      moves.push({
        w: bot.takeOne,
        go: () => {
          const { b, back } = backs[between(r, 0, backs.length - 1)];
          const list = felt.flatMap((x) => (spotOf(x) !== spotOf(b) ? [x] : x.amount > back ? [entry(x.type, x.pick, x.amount - back)] : []));
          return { list, kind: 'takeOne', key: spotOf(b) };
        },
      });
    }
    // Everything that may come down (the ↶: splitTakeDown's keep list, its
    // rule canTakeDown).
    const down = felt.filter((b) => canTakeDown(b, point));
    if (down.length > 0 && bot.takeAll > 0) {
      moves.push({ w: bot.takeAll, go: () => ({ list: felt.filter((b) => !canTakeDown(b, point)), kind: 'takeAll', back: down.map(spotOf) }) });
    }
    if (moves.length === 0) return;
    let x = r() * moves.reduce((n, m) => n + m.w, 0);
    let pick = moves[moves.length - 1];
    for (const m of moves) {
      x -= m.w;
      if (x < 0) {
        pick = m;
        break;
      }
    }
    const move = pick.go();
    if (!move) return;
    const res = this.write(sp, t, v.round, move.list, basis, now);
    this.stats.moves += 1;
    // Built from the felt and the stamp read this frame, by the felt's own
    // rules and caps, within the player's chips, never a 32nd player: the
    // stamp, the rules, the chip check and the room may not refuse it (a
    // page catching up, or a window just shut, may: 'reconnecting',
    // 'closed'). Nor may the chip check, but for one case: a felt the page
    // holds back (coalesced: readMyComputedCrapsBets shows it, the fold holds
    // only what was written) has chips the fold doesn't hold yet, which the
    // writer counts and the felt's own check (readChips against the hand, as
    // placeHand's) doesn't: the UI says NOT ENOUGH CHIPS there too.
    if (res !== 'ok' && res !== 'closed' && res !== 'reconnecting') {
      const held = Number(casino.computedFoldOf(t)?.held.get(sp.pid) ?? 0n);
      const heldBack = res === 'chips' && (move.kind === 'place' || move.kind === 'odds') && sumOf(felt) > held
        && sumOf(canonList(move.list)) - held > casino.readChips(sp.pid);
      if (heldBack) this.stats.chipsHeldBack += 1;
      else this.sim.violate(`${sp.name}'s ${move.kind} at ${t} roll ${v.round} at ${this.sim.elapsed} ms answered ${res} (${JSON.stringify(canonList(move.list))} over ${JSON.stringify(felt)}, point ${point})`);
    }
    if (res !== 'ok') return;
    if (casino.readChips(sp.pid) < 0) this.sim.violate(`${sp.name} reads ${casino.readChips(sp.pid)} chips`);
    c.built.set(t, { basis, felt: canonList(move.list) });
    if (move.kind === 'place' || move.kind === 'odds') {
      ledger.set(move.key!, (ledger.get(move.key!) ?? 0) + move.amount!);
      this.stats[move.kind === 'place' ? 'places' : 'odds'] += 1;
    } else if (move.kind === 'takeOne') {
      ledger.delete(move.key!);
      this.stats.takeOne += 1;
    } else {
      for (const k of move.back ?? []) ledger.delete(k);
      this.stats.takeAll += 1;
    }
  }

  /** A bet `add` on felt `felt`, by the felt's own checks (its caps, the
   *  newcomer's place, the chips in hand), as one of three lists in turn:
   *  merged, the UI's (the felt merged, the hand a chip a record), or every
   *  chip a record. Null when the felt wouldn't take it. */
  private placing(sp: SimPage, t: string, felt: CrapsBet[], add: CrapsBet, bot: CrapsBotSpec, kind: 'place' | 'odds') {
    const { casino } = sp.p;
    const key = spotOf(add);
    const at = felt.filter((b) => spotOf(b) === key).reduce((n, b) => n + b.amount, 0);
    const inBox = drawnChips(at + add.amount);
    if (inBox > MAX_STACK_CHIPS) return null;
    if (felt.filter((b) => spotOf(b) !== key).reduce((n, b) => n + drawnChips(b.amount), 0) + inBox > MAX_BETS_DRAWN_PER_PLAYER) return null;
    // (A felt held back to go counts as none yet: the writer counts what
    // the fold holds.)
    if (this.fullFor(sp, t)) return null;
    if (bot.low > 0 && casino.readChips(sp.pid) < bot.low) this.sim.buyIn(sp, sp.pid, bot.topUp);
    if (casino.readChips(sp.pid) < add.amount) return null;
    const c = this.page(sp);
    const form = c.forms++ % 3;
    let list: CrapsBet[];
    if (form === 0) list = canonList([...felt, add]);
    else if (form === 1) list = [...felt, ...chipsOf(add)];
    else list = [...felt.flatMap(chipsOf), ...chipsOf(add)].reverse();
    if (form !== 0) this.stats.perChipLists += 1;
    return { list, kind, key, amount: add.amount };
  }

  /** The tries the table must refuse that page sp's felt allows now, through
   *  the honest API: a felt built on the table before it moved on
   *  ('changed'); a contract bet taken down whole or in part, a pass or a
   *  don't pass put up with a point on, a come or don't come bet put up on
   *  a number (only a box bet travels there) ('rules'); more chips than the
   *  player has ('chips'); a 32nd player ('full'). With `draw`, the chips
   *  over are drawn (a random try), else one over. */
  private triesFor(sp: SimPage, t: string, now: number, felt: CrapsBet[], basis: string, draw: boolean): Try[] {
    const c = this.page(sp);
    const { casino, table } = sp.p;
    const v = table.readComputedCraps(t, now)!;
    const point = v.point;
    const p = point ?? 0;
    const kinds: Try[] = [];
    const built = c.built.get(t);
    if (built && built.basis !== basis) kinds.push({ kind: 'stale', want: 'changed', list: built.felt, basis: built.basis });
    const contract = felt.find((b) => isContract(b, p));
    if (contract) kinds.push({ kind: 'contract', want: 'rules', list: felt.filter((b) => b !== contract), basis });
    const part = felt.find((b) => isContract(b, p) && b.amount >= 2);
    if (part) kinds.push({ kind: 'contract-part', want: 'rules', list: felt.map((b) => (b === part ? entry(b.type, b.pick, Math.floor(b.amount / 2)) : b)), basis });
    if (point !== null) {
      kinds.push({ kind: 'line', want: 'rules', list: [...felt, { type: 'pass', amount: 5 }], basis });
      // (Past what rides: a don't pass taken down this roll may go back up
      // to what rode into it, which the rules allow, computedCraps changeOk.)
      const rode = (fromCarry(casino.computedFoldOf(t)?.carry as CarryLike).w.get(sp.pid) ?? [])
        .filter((b) => b.type === 'dontpass').reduce((n, b) => n + b.amount, 0);
      kinds.push({ kind: 'dontpass-up', want: 'rules', list: [...felt.filter((b) => b.type !== 'dontpass'), { type: 'dontpass', amount: rode + 5 }], basis });
    }
    const n = point ?? 6;
    kinds.push({ kind: 'come-number', want: 'rules', list: [...felt, { type: 'come', pick: n, amount: 5 }], basis });
    kinds.push({ kind: 'dontcome-number', want: 'rules', list: [...felt, { type: 'dontcome', pick: n, amount: 5 }], basis });
    const held = Number(casino.computedFoldOf(t)?.held.get(sp.pid) ?? 0n);
    const over = casino.readChips(sp.pid) + held + 1 + (draw ? between(sp.rand, 0, 50) : 0);
    // (The room comes before the chips: a newcomer at a full table is
    // refused 'full' whatever it puts down.)
    const full = this.fullFor(sp, t);
    kinds.push({ kind: 'over', want: full ? 'full' : 'chips', list: [...felt, { type: 'field', amount: Math.min(1e9, over) }], basis });
    if (full) kinds.push({ kind: 'full', want: 'full', list: [{ type: 'field', amount: 1 }], basis });
    return kinds;
  }

  /** Whether page sp's player comes to table t as a newcomer (no bets
   *  riding, no chips on the open roll) with no place left: every rider at
   *  the start of the roll (gone ones, and ones who took everything down,
   *  too) and every other newcomer with chips on it, 31 of them (the
   *  design's room). */
  fullFor(sp: SimPage, t: string): boolean {
    const res = sp.p.casino.computedFoldOf(t);
    if (!res) return false;
    const k = fromCarry(res.carry as CarryLike);
    const mine = res.felts.get(sp.pid);
    if (k.w.has(sp.pid) || (mine && mine.rec.b.length > 0)) return false;
    let n = k.w.size;
    for (const [pid, f] of res.felts) if (pid !== sp.pid && !k.w.has(pid) && f.rec.b.length > 0) n += 1;
    return n >= MAX_TABLE_BETTORS;
  }

  /** Try k through the writer; it must answer k.want ('closed' and
   *  'reconnecting' leave it for later). `sure`: this page's one try of the
   *  kind for certain. Whether it was answered at all. */
  private attempt(sp: SimPage, t: string, now: number, round: number, k: Try, sure: boolean): boolean {
    const c = this.page(sp);
    const res = this.write(sp, t, round, k.list, k.basis, now);
    if (res === 'closed' || res === 'reconnecting') return false;
    if (sure) c.sure.add(k.kind);
    if (res === k.want) {
      this.tries[k.kind] = (this.tries[k.kind] ?? 0) + 1;
      return true;
    }
    this.tries[`${k.kind}:${res}`] = (this.tries[`${k.kind}:${res}`] ?? 0) + 1;
    this.sim.violate(`${sp.name}'s ${k.kind} try at ${t} roll ${round} at ${this.sim.elapsed} ms answered ${res}, not ${k.want} (${JSON.stringify(k.list)})`);
    return true;
  }

  /** A press on page sp's mounted table UI at table t (fn: its keys and
   *  clicks, at the page's clock): the slip version it writes, if any, held
   *  to `felt` (canonical) on `basis` at the page's stand with no goodbye
   *  mark, or to none at all (null: a press the UI must refuse); a felt it
   *  leaves on the table (read back) is the last one answered 'ok', which a
   *  flush may write later (ownSlip). The scenario reads what the UI said. */
  press<R>(sp: SimPage, t: string, round: number, felt: CrapsBet[] | null, basis: string, fn: () => R): R {
    const c = this.page(sp);
    c.writing = { t, felt: felt === null ? null : canonList(felt), basis };
    let out: R;
    try {
      out = fn();
    } finally {
      c.writing = null;
    }
    if (felt !== null) {
      const now = sp.p.table.readMyComputedCrapsBets(t, sp.pid, round, Date.now());
      if (canon(canonList(now.felt)) === canon(canonList(felt))) c.lastOk.set(t, { r: round, felt: canonList(felt), basis });
    }
    return out;
  }

  /** A throw through page sp's mounted table UI at table t (fn: its key or
   *  its fling, at the page's clock): when the page now has a fling of its
   *  own for the roll on screen that it didn't have before, it counts as the
   *  shooter's own throw, as the player's planned one does (the close
   *  oracle's fling, the plan done). Whether it threw. */
  uiFling(sp: SimPage, t: string, fn: () => void): boolean {
    const c = this.page(sp);
    const { table } = sp.p;
    const now = Date.now();
    const v = table.readComputedCraps(t, now);
    const before = table.computedFlungFor(t, now);
    fn();
    const f = table.computedFlungFor(t, now);
    if (!v || !f || f.r !== v.round || (before !== null && before.r === f.r && before.seed === f.seed)) return false;
    c.flungAt.set(t, { inc: v.inc, r: v.round, at: now });
    const plan = c.plan.get(t);
    if (plan && plan.inc === v.inc && plan.r === v.round) plan.done = true;
    this.stats.flings += 1;
    return true;
  }

  /** Page sp's player's own write at table t (the felt's write, as a press
   *  makes it): counted, the felt it asked for kept while it runs (ownSlip),
   *  and the last one answered 'ok' (a flush may write it later). */
  private write(sp: SimPage, t: string, round: number, list: CrapsBet[], basis: string, now: number): ComputedSlipWrite {
    const c = this.page(sp);
    c.writing = { t, felt: canonList(list), basis };
    let res: ComputedSlipWrite;
    try {
      res = sp.p.table.writeComputedCrapsSlip(t, list, basis, now);
    } finally {
      c.writing = null;
    }
    sp.writes[res] = (sp.writes[res] ?? 0) + 1;
    if (res === 'ok') c.lastOk.set(t, { r: round, felt: canonList(list), basis });
    return res;
  }

  // ── Leaving ──

  /** The goodbyes page sp must write as it leaves now, by table (the design's
   *  "Leaving"): where its doc may be written from (awake, whole, checked),
   *  no close of the roll in, its latest version this load's own and not a
   *  goodbye already, with chips on it or bets riding: a goodbye, `l: 1`, no
   *  stand, this roll's new chips back (the felt per spot no more than what
   *  rode in), or the riding bets when its stamp is out of date. */
  goodbyeDue(sp: SimPage, now: number): Goodbye[] {
    const { casino, croupier } = sp.p;
    const out: Goodbye[] = [];
    for (const t of this.crapsTables()) {
      const res = casino.computedFoldOf(t);
      const inc = casino.computedIncOf(t);
      if (!res || !inc || inc[0] !== 'k' || !casino.isComputedTable(t)) continue;
      const able = croupier.tablesAwake(now) && casino.casinoWhole(t) && casino.computedSettled(t);
      const latest = res.felts.get(sp.pid);
      const rec = latest?.rec as CrapsSlipRec | undefined;
      const k = fromCarry(res.carry as CarryLike);
      const C = k.w.get(sp.pid) ?? [];
      const closeIn = res.tip !== null || res.openCloses.some((x) => x.state !== 'invalid');
      const due = able && rec !== undefined && sp.myFelts.has(latest!.hash) && rec.l !== 1 && !closeIn && (rec.b.length > 0 || C.length > 0);
      out.push({ t, felt: due ? (rec!.o === stampOf(k.p, C) ? minPer(rec!.b, C) : C) : null });
    }
    return out;
  }

  /** After leaveComputedTables: each goodbye due is the latest version, as
   *  due; and a write from the page now answers 'closed'. From now on, a new
   *  slip version from this load is a violation (ownWrite). */
  goodbyeSaid(sp: SimPage, byes: Goodbye[], now: number, leaving: boolean): void {
    const c = this.page(sp);
    const { casino, table } = sp.p;
    for (const { t, felt } of byes) {
      const res = casino.computedFoldOf(t);
      if (felt !== null) {
        const rec = res?.felts.get(sp.pid)?.rec as CrapsSlipRec | undefined;
        if (!rec || rec.l !== 1 || rec.t !== undefined || canon(rec.b) !== canon(canonList(felt))) {
          this.sim.violate(`${sp.name}'s goodbye at ${t} at ${this.sim.elapsed} ms reads ${JSON.stringify(rec ?? null)}, not ${JSON.stringify(canonList(felt))} (l:1, no stand)`);
        } else {
          this.stats.goodbyes += 1;
        }
      }
      const v = table.readComputedCraps(t, now);
      if (v) {
        const { basis } = table.readMyComputedCrapsBets(t, sp.pid, v.round, now);
        const after = table.writeComputedCrapsSlip(t, [], basis, now);
        if (after !== 'closed' && after !== 'reconnecting') this.sim.violate(`${sp.name}'s write at ${t} after its goodbye answered ${after}`);
      }
      if (leaving) {
        if (c.croupier) c.croupier.markLocalSeat(t, sp.pid, false);
        else sp.p.stands.setLocalStand(t, sp.pid, false);
      }
    }
    c.bye = { at: this.sim.T, keys: this.ownKeys(sp) };
    this.byeT.set(sp.pid, this.sim.T);
  }

  /** Page sp's own slip keys in every craps session its doc holds. */
  private ownKeys(sp: SimPage): Set<string> {
    const out = new Set<string>();
    for (const [k, ses] of sp.p.doc.getMap<unknown>('casinoComputed').entries()) {
      if (!k.startsWith('ses:') || !(ses instanceof Y.Map) || !this.isCrapsSession(k)) continue;
      for (const key of (ses as Y.Map<unknown>).keys()) if (parseKey(key)?.kind === 's' && parseKey(key)!.pid === sp.pid) out.add(key);
    }
    return out;
  }

  private isCrapsSession(sesKey: string): boolean {
    const cut = sesKey.lastIndexOf(':');
    const rest = sesKey.slice(0, cut);
    return rest.slice(rest.lastIndexOf(':') + 1)[0] === 'k';
  }

  /** A reload's pagehide: the goodbye, held to its oracle. */
  async goodbye(sp: SimPage): Promise<void> {
    await this.sim.as(sp, (now) => {
      const byes = this.goodbyeDue(sp, now);
      this.saying(sp, true);
      try {
        sp.p.table.leaveComputedTables(now);
      } finally {
        this.saying(sp, false);
      }
      this.goodbyeSaid(sp, byes, now, false);
    });
  }

  /** Page sp's leaving second: frames with no bot while the room's last
   *  writes go out (main.ts LEAVE_FLUSH_MS), then gone. */
  leavingSecond(sp: SimPage): void {
    sp.leaving = true;
    const load = sp.loads;
    this.sim.at(this.sim.elapsed + 1_000, () => {
      if (!sp.leaving || sp.loads !== load) return;
      sp.leaving = false;
      sp.mode = 'gone';
      sp.awayFrom = this.sim.T;
    });
  }

  /** Page sp's own transaction tr (`was`: each table's fold before it). At
   *  a craps table:
   *  - once it said goodbye, no new slip version of its player (a key it
   *    didn't hold then); its reveals, closes and forfeits go on, and a
   *    re-put puts a record back under its own key;
   *  - every new slip version of its player says what it may: what its
   *    player asked for (writing), its goodbye (saying), or what its duties
   *    write on their own (ownSlip);
   *  - a close of a roll that waits for the holder's throw comes no sooner
   *    than the wait allows (ownClose). */
  ownWrite(sp: SimPage, tr: Y.Transaction, computed: Y.Map<unknown>, was: ReadonlyMap<string, { inc: string | null; res: FoldResult | null }>): void {
    const c = this.page(sp);
    for (const [type, keys] of tr.changed) {
      const item = (type as Y.AbstractType<unknown>)._item;
      if (!item || item.parent !== (computed as unknown) || typeof item.parentSub !== 'string' || !this.isCrapsSession(item.parentSub)) continue;
      const ses = type as unknown as Y.Map<unknown>;
      const t = this.crapsTables().find((x) => sp.p.casino.computedSessionForWrite(x) === ses);
      for (const k of keys) {
        if (k === null || !ses.has(k)) continue;
        const pk = parseKey(k);
        if (!pk) continue;
        if (pk.kind === 's' && pk.pid === sp.pid) {
          if (c.bye && !c.bye.keys.has(k)) {
            this.sim.violate(`${sp.name} wrote slip ${k} at ${this.sim.elapsed} ms, ${this.sim.T - c.bye.at} ms after its goodbye`);
          }
          if (t !== undefined && !sp.cheats && !c.slipKeys.has(k)) this.ownSlip(sp, c, t, k, ses.get(k) as CrapsSlipRec, was.get(t));
        } else if (pk.kind === 'c' && t !== undefined && !sp.cheats && !c.slipKeys.has(k)) {
          this.ownClose(sp, c, t, ses.get(k) as CloseRec, was.get(t));
        }
        c.slipKeys.add(k);
      }
    }
  }

  /** A new slip version of page sp's player at table t (`w`: the fold
   *  before it). While its player's write runs, exactly what it asked for
   *  (the canonical felt, its stamp, the stand the page stands at, no
   *  goodbye mark); while its goodbye runs, the goodbye (l: 1, no stand,
   *  this roll's new chips back, or the riding bets when its stamp is out
   *  of date); else what its duties write on their own, and nothing else:
   *  - the latest version again, felt, stamp and mark the same, at its
   *    stand or the page's (a stand rewrite, a re-commit);
   *  - the riding bets, under the stamp of the table as it stands, at the
   *    page's stand (a ride slip, or a version on an old stamp written
   *    again);
   *  - the felt its player's last write was answered 'ok' for, on its
   *    stamp, at the page's stand (the coalescing's flush);
   *  - over a goodbye, the goodbye's felt when its stamp is current, else
   *    the riding bets, under the current stamp at the page's stand (a
   *    goodbye put back as the player is here);
   *  the last two only from a page at a stand, or for a roll another
   *  player's latest version with chips that isn't a goodbye is on (a rider
   *  off the table joins only a roll someone else plays).
   *  A re-put and a trim's copy write no new version (a key seen before, or
   *  the latest's). */
  private ownSlip(sp: SimPage, c: CrapsPage, t: string, key: string, rec: CrapsSlipRec, w: { inc: string | null; res: FoldResult | null } | undefined): void {
    const pres = w?.res;
    if (!pres || !w!.inc || w!.inc !== sp.p.casino.computedIncOf(t)) return;
    const prevInfo = pres.felts.get(sp.pid);
    // (A record put back: the latest's own key, an older version, or one of
    // a roll already played, as a re-put or a witness puts them back. No
    // duty writes a new version but on the open roll, past every version.)
    if (prevInfo?.key === key || rec.r < pres.open || (prevInfo && prevInfo.rec.r === rec.r && rec.v <= prevInfo.rec.v)) return;
    this.stats.ownSlips += 1;
    const K = fromCarry(pres.carry as CarryLike);
    const C = K.w.get(sp.pid) ?? [];
    const stamp = stampOf(K.p, C);
    const prev = prevInfo?.rec as CrapsSlipRec | undefined;
    const stand = sp.p.stands.localStandOf(t, sp.pid);
    const b = canon(rec.b);
    const same = (f: readonly CrapsBet[]): boolean => b === canon(canonList(f));
    let ok: boolean;
    let what: string;
    if (rec.r !== pres.open) {
      ok = false;
      what = `a version for roll ${rec.r}, roll ${pres.open} open`;
    } else if (c.writing && c.writing.t === t) {
      const want = c.writing.felt;
      ok = want !== null && same(want) && rec.o === c.writing.basis && rec.t === stand && rec.l === undefined;
      what = want === null ? 'nothing (a press its table UI must refuse)'
        : `its player's write of ${JSON.stringify(want)} on ${c.writing.basis === stamp ? 'the current stamp' : c.writing.basis}`;
    } else if (c.saying) {
      ok = rec.l === 1 && rec.t === undefined && rec.o === stamp && same(prev && prev.o === stamp ? minPer(prev.b, C) : C);
      what = 'its goodbye';
    } else {
      const last = c.lastOk.get(t);
      const again = prev !== undefined && same(prev.b) && rec.o === prev.o && (rec.t === prev.t || rec.t === stand) && rec.l === prev.l;
      // (The ride slip and the goodbye's put-back only from a page at the
      // table, or for a roll someone else plays: another player's latest
      // version with chips that isn't a goodbye. A rider off the table
      // joins only those; a gone rider's goodbye is no one playing.)
      const others = [...pres.felts.values()].some((s) => s.rec.p !== sp.pid && s.rec.b.length > 0 && (s.rec as CrapsSlipRec).l !== 1);
      const due = stand !== undefined || others;
      const ride = due && rec.l === undefined && same(C) && rec.o === stamp && rec.t === stand;
      const flush = rec.l === undefined && last !== undefined && last.r === rec.r && same(last.felt) && rec.o === last.basis && rec.t === stand;
      const putBack = due && rec.l === undefined && prev?.l === 1 && same(prev.o === stamp ? prev.b : C) && rec.o === stamp && rec.t === stand;
      ok = again || ride || flush || putBack;
      what = `its duties' own (the latest ${prev ? `${JSON.stringify(prev.b)} stamp ${prev.o === stamp ? 'current' : 'old'} stand ${prev.t ?? '-'}${prev.l ? ' goodbye' : ''}` : 'none'}, `
        + `riding ${JSON.stringify(C)}, its last write ${last ? `${JSON.stringify(last.felt)} of roll ${last.r}` : 'none'}, stand ${stand ?? '-'}${due ? '' : ', nobody else playing the roll'})`;
    }
    if (!ok) {
      this.sim.violate(`${sp.name} wrote ${key} at ${t} at ${this.sim.elapsed} ms: ${JSON.stringify(rec.b)} stamp ${rec.o === stamp ? 'current' : rec.o} `
        + `stand ${rec.t ?? '-'}${rec.l ? ' goodbye' : ''}, not ${what}`);
    }
  }

  /** A close page sp wrote of table t's open roll (`w`: the fold before
   *  it), while that roll waits for the holder's throw (the holder counted
   *  at their stand on the last roll with dice): from any page but the
   *  holder's, never before the wait ends (D, the end of betting plus
   *  CRAPS_SHOOTER_MS, as its own view gave it); from the holder's own,
   *  before D only at or after its own fling of the roll, and never before
   *  betting ended. A throw record closes nothing. */
  private ownClose(sp: SimPage, c: CrapsPage, t: string, rec: CloseRec, w: { inc: string | null; res: FoldResult | null } | undefined): void {
    const pres = w?.res;
    if (!pres || !w!.inc || rec.k !== sp.p.pub || rec.r !== pres.open) return;
    const K = fromCarry(pres.carry as CarryLike);
    if (K.h === undefined || K.i !== 1) return;
    const obs = c.waitOf.get(t);
    const shooterMs = sp.p.croupier.CRAPS_SHOOTER_MS;
    if (!obs || obs.inc !== w!.inc || obs.r !== rec.r || (obs.W === undefined && obs.D === undefined)) {
      this.stats.closesUnchecked += 1;
      return;
    }
    const D = obs.D ?? obs.W! + shooterMs;
    const W = D - shooterMs;
    const now = Date.now();
    this.stats.closesChecked += 1;
    if (now >= D) return;
    if (sp.pid !== K.h) {
      this.sim.violate(`${sp.name} closed ${t} roll ${rec.r} at ${this.sim.elapsed} ms, ${D - now} ms before the wait for ${K.h}'s throw ends`);
      return;
    }
    const f = c.flungAt.get(t);
    if (!(f && f.inc === w!.inc && f.r === rec.r && f.at <= now && now >= W)) {
      this.sim.violate(`${sp.name}, the holder, closed ${t} roll ${rec.r} at ${this.sim.elapsed} ms, ${D - now} ms before the wait ends, `
        + `${f && f.r === rec.r ? `its fling at ${f.at}, betting to ${W}, now ${now}` : 'with no fling of its own'}`);
    }
  }

  /** Page sp's goodbye as it runs (leaveComputedTables): what its page
   *  writes meanwhile is the goodbye (ownSlip). */
  saying(sp: SimPage, on: boolean): void {
    this.page(sp).saying = on;
  }

  // ── What the room reads ──

  /** The players whose latest version on the open roll puts anything to it
   *  (chips, or everything taken down over bets riding), not a goodbye: who
   *  a roll that sits waits on (stallOf). A rider off the table or gone, with
   *  nobody else playing, waits by design ("riding bets wait for the next
   *  roll"), so riding bets alone aren't counted. */
  stakedOf(res: FoldResult): string[] {
    const k = fromCarry(res.carry as CarryLike);
    return [...res.felts.values()].filter((s) => {
      const rec = s.rec as CrapsSlipRec;
      return rec.l !== 1 && (rec.b.length > 0 || (k.w.get(rec.p) ?? []).length > 0);
    }).map((s) => s.rec.p);
  }

  /** Craps table t settled on page sp now (no tip, checked by the caller):
   *  betting, past the show and with no wait for a throw (the view's phase
   *  'betting'), and no player whose page is up has anything on the open
   *  roll but what rides (new chips, or bets taken down, roll first).
   *  Riders' bets ride on (a pass waits for its point, which can take many
   *  rolls), and ride slips keep a table with a rider at it rolling, so a
   *  felt that only states what rides is allowed. */
  settledAt(sp: SimPage, t: string, now: number): boolean {
    const v = sp.p.table.readComputedCraps(t, now);
    if (v && v.phase !== 'betting') return false;
    const res = sp.p.casino.computedFoldOf(t);
    if (!res) return true;
    const k = fromCarry(res.carry as CarryLike);
    const up = new Set(this.sim.pages.filter((q) => q.mode === 'up').map((q) => q.pid));
    return [...res.felts.values()].every((f) => !up.has(f.rec.p) || canon(canonList((f.rec as CrapsSlipRec).b)) === canon(k.w.get(f.rec.p) ?? []));
  }

  /** What every page up must agree on at craps table t: the fold with its
   *  carry and every roll's craps fields; the view's incarnation, roll key,
   *  roll, point, holder, whether the holder is in play, riders, and while
   *  settled what it shows of the roll (dice, payouts, amounts, pushes, the
   *  dice's hands before and after, the point before, a void, a seven-out);
   *  the ⚙ card's last roll; the felts it shows on the roll on screen. */
  agreement(sp: SimPage, t: string, res: FoldResult | null, now: number): unknown {
    const { table } = sp.p;
    const view = table.readComputedCraps(t, now);
    let D: RoundView | null = null;
    for (const v of res?.rounds ?? []) if (v.decided) D = v;
    const rc = table.computedRoundCheck(t, now);
    // With no decided roll past the checkpoint, the last roll on screen and
    // on the card is the one the checkpoint covers, which it doesn't carry
    // (design: a checkpoint holds the nets, the point, the riding bets and
    // the shooter, not the dice): a page that saw it decided shows it, one
    // that never did (it was apart, or away) shows none, and neither is
    // wrong. So there either reads as the checkpoint's roll ('base'). A
    // page that shows another roll there, its own dropped branch's say,
    // still differs.
    let rollKey: string | null = view?.rollKey ?? null;
    let card: unknown = rc ? { round: rc.round, decided: rc.decided, roll: rc.roll ?? null } : null;
    if (res && view && D === null && res.base.l !== null) {
      const kept = this.keptExp(t, view.inc, res.base.u, res.base.l);
      const keyOf = (e: Exp): string => (e.dice ? `${e.r}:${e.dice[0]}${e.dice[1]}` : '');
      if (rollKey === '' || (kept && rollKey === keyOf(kept) && rollKey.startsWith(`${res.base.u}:`))) rollKey = 'base';
      const same = (x: { dice: [number, number] | null; pointBefore: number | null; pointAfter: number | null; sevenOut: boolean }, e: Exp): boolean =>
        JSON.stringify([x.dice, x.pointBefore, x.pointAfter, x.sevenOut]) === JSON.stringify([e.dice, e.pointBefore, e.pointAfter, e.sevenOut]);
      if (rc === null || (kept && rc.round === res.base.u && rc.decided === kept.decided && rc.roll && same(rc.roll, kept))) card = 'base';
    }
    return {
      fold: res ? crapsSnapshot(res) : null,
      view: view ? {
        inc: view.inc, rollKey, round: view.round, point: view.point, holder: view.holder ?? null, shooterInPlay: view.shooterInPlay,
        riders: view.riders, decided: D?.r ?? null, dice: D?.craps?.dice ?? null, shown: settledOf(view),
        bets: ridingText(table.readComputedCrapsBets(t, view.round, now)),
      } : null,
      card,
    };
  }

  /** Roll r of craps table t's incarnation inc as the checker played it on
   *  the close a checkpoint names (any page's walk). */
  private keptExp(t: string, inc: string, r: number, close: string): Exp | undefined {
    for (const [key, m] of this.lastExp) {
      if (!key.endsWith(`|${t}|${inc}`)) continue;
      const e = m.get(r);
      if (e && e.close === close) return e;
    }
    return undefined;
  }

  /** A trim page sp wrote moves no carry: the point, the riding bets, the
   *  dice's hands the checkpoint hands on are the fold's before it. */
  checkTrimCarry(sp: SimPage, t: string, was: FoldResult, res: FoldResult): void {
    const a = textOf(was.carry as CarryLike);
    const b = textOf(res.carry as CarryLike);
    if (a !== b) this.sim.violate(`${sp.name}'s trim of ${t} at ${this.sim.elapsed} ms moved the carry ${a} → ${b}`);
  }

  /** What page sp shows of craps table ctx.t at the end of each tick (its
   *  fold res just checked): the wait's times its view gives (the close
   *  oracle), its screen against the checker's rolls, a rider at the table
   *  (the rider oracle). */
  observeCraps(sp: SimPage, ctx: FoldCtx, res: FoldResult, now: number): void {
    this.netLook();
    const c = this.page(sp);
    const view = sp.p.table.readComputedCraps(ctx.t, now);
    if (!view || view.inc !== ctx.inc) return;
    if (view.round === res.open && view.phaseDeadline !== undefined && (view.phase === 'betting' || view.phase === 'closing')) {
      let w = c.waitOf.get(ctx.t);
      if (!w || w.inc !== ctx.inc || w.r !== view.round) c.waitOf.set(ctx.t, w = { inc: ctx.inc, r: view.round });
      if (view.phase === 'betting') {
        // (Betting again past an earlier wait: a re-arm; its wait comes after.)
        if (w.D !== undefined && w.D < view.phaseDeadline) delete w.D;
        w.W = view.phaseDeadline;
      } else {
        w.D = view.phaseDeadline;
      }
    }
    this.viewCheck(sp, ctx, res, view, now);
    this.riderLook(sp, ctx, res, view, now);
  }

  /** Page sp's screen of table ctx.t against the checker's rolls: while it
   *  shows a roll settled, everything it shows of it (settledOf) and the
   *  felts riding on after it; at any time the ⚙ card's last roll. A roll
   *  the checker has no figures for (its walk stopped) goes unchecked. */
  private viewCheck(sp: SimPage, ctx: FoldCtx, res: FoldResult, view: ComputedCrapsState, now: number): void {
    const { table } = sp.p;
    const last = this.lastExp.get(`${sp.name}|${ctx.t}|${ctx.inc}`);
    const mine = this.exps.get(res);
    // The roll a screen shows decided: on the fold's chain (walked to its
    // end), or the one a trim just covered (the checkpoint names its close).
    const expOf = (r: number): Exp | undefined => {
      const v = res.rounds.find((x) => x.r === r && x.decided !== null);
      if (v) {
        const e = mine?.get(r);
        return e && v.close === e.close && v.decided === e.decided ? e : undefined;
      }
      const e = last?.get(r);
      return e && r === res.base.u && res.base.l === e.close ? e : undefined;
    };
    const wrong = (why: string): void => this.sim.violate(`${sp.name} ${ctx.t} at ${this.sim.elapsed} ms: ${why}`);
    if (view.phase === 'settled') {
      const e = expOf(view.round);
      if (!e) {
        this.stats.viewsUnchecked += 1;
      } else {
        this.stats.viewsChecked += 1;
        const want = {
          dice: e.dice, result: e.dice ? e.dice[0] + e.dice[1] : null, point: e.pointAfter, pointBefore: e.pointBefore, sevenOut: e.sevenOut,
          voided: e.decided === 'void', shooterAfter: e.hOut ?? null, holderBefore: e.hIn ?? null,
          payouts: [...e.credited].filter(([, n]) => n > 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, n]) => [p, Number(n)]),
          amounts: [...e.amounts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, n]) => [p, Number(n)]),
          pushes: e.pushes, riders: e.riders, rollKey: e.dice ? `${e.r}:${e.dice[0]}${e.dice[1]}` : '',
        };
        const got = settledOf(view);
        const bets = ridingText(table.readComputedCrapsBets(ctx.t, view.round, now));
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong(`shows roll ${view.round} as ${JSON.stringify(got)}, the checker's ${JSON.stringify(want)}`);
        if (bets !== e.wOut) wrong(`shows ${bets} riding after roll ${view.round}, the checker's ${e.wOut}`);
      }
    }
    const rc = table.computedRoundCheck(ctx.t, now);
    if (rc?.roll) {
      const e = expOf(rc.round);
      if (e) {
        const got = JSON.stringify([rc.roll.dice, rc.roll.pointBefore, rc.roll.pointAfter, rc.roll.sevenOut]);
        const want = JSON.stringify([e.dice, e.pointBefore, e.pointAfter, e.sevenOut]);
        if (got !== want) wrong(`the card shows roll ${rc.round} as ${got}, the checker's ${want}`);
      }
    }
  }

  /** The rider oracle's look: page sp's player rides at table ctx.t, its
   *  page up, awake, whole, checked, not leaving nor said goodbye, at the
   *  table (a stand) or with someone else playing the roll (rideDuty's own
   *  gate), and the roll takes bets RIDER_MARGIN_MS or more before its end,
   *  over a network that loses nothing and cuts nobody off. Seen so at the
   *  end of two frames of its in a row (the duty ran between them, its gates
   *  open), its ride slip is out, and every close freezes it. */
  private riderLook(sp: SimPage, ctx: FoldCtx, res: FoldResult, view: ComputedCrapsState, now: number): void {
    const c = this.page(sp);
    const key = `${ctx.t}|${ctx.inc}|${res.open}|${sp.pid}`;
    const open = this.riderGate(sp, ctx, res, view, now);
    const was = c.riderPending.get(ctx.t);
    if (!open) {
      c.riderPending.delete(ctx.t);
      return;
    }
    if (was && was.key === key && c.frames > was.frames) {
      if (!this.riderSeen.has(key)) {
        this.riderSeen.set(key, was.T);
        this.stats.ridersSeen += 1;
      }
      return;
    }
    if (!was || was.key !== key) c.riderPending.set(ctx.t, { key, frames: c.frames, T: this.sim.T });
  }

  private riderGate(sp: SimPage, ctx: FoldCtx, res: FoldResult, view: ComputedCrapsState, now: number): boolean {
    if (!sp.honest || sp.cheats || sp.mode !== 'up' || sp.leaving || !sp.roomIn || sp.partial || this.sim.T < sp.pauseUntil) return false;
    if (this.page(sp).bye || res.tip || view.phase !== 'betting' || view.round !== res.open || view.phaseDeadline === undefined) return false;
    if (now > view.phaseDeadline - RIDER_MARGIN_MS) return false;
    const { casino, croupier } = sp.p;
    if (!croupier.tablesAwake(now) || !casino.casinoWhole(ctx.t) || !casino.computedSettled(ctx.t) || !this.sim.net.clean()) return false;
    if (!fromCarry(res.carry as CarryLike).w.has(sp.pid)) return false;
    const others = [...res.felts.values()].some((s) => s.rec.p !== sp.pid && s.rec.b.length > 0 && (s.rec as CrapsSlipRec).l !== 1);
    return sp.p.stands.localStandOf(ctx.t, sp.pid) !== undefined || others;
  }

  /** The network as it is this tick: lossless and whole, or not (dirty). */
  private netLook(): void {
    const T = this.sim.T;
    if (T === this.netT) return;
    const prev = this.netT;
    this.netT = T;
    if (this.sim.net.clean()) return;
    const last = this.dirty[this.dirty.length - 1];
    if (last && last[1] >= prev) last[1] = T;
    else this.dirty.push([T, T]);
  }

  /** Whether the network was dirty at any tick in [a, b], a frame's
   *  slack either side. */
  private dirtyIn(a: number, b: number): boolean {
    return this.dirty.some(([x, y]) => x <= b + FRAME_MS && y >= a - FRAME_MS);
  }

  /** Once the run is over (healed, quiet, synced): every up page's fold of
   *  each craps table walked to its end by the checker now (a fold deciding
   *  a roll on a record its session lacks would stop the walk: then it is
   *  named here), and its screen checked. The caller awaits the dice checks
   *  (Sim pocketChecks). */
  finalCheck(): string[] {
    const out: string[] = [];
    for (const sp of this.sim.pages.filter((q) => q.mode === 'up')) {
      const now = this.sim.enter(sp);
      const { casino } = sp.p;
      for (const t of this.crapsTables()) {
        const res = casino.computedFoldOf(t);
        const inc = casino.computedIncOf(t);
        if (!res || !inc || inc[0] !== 'k') continue;
        const ctx = this.sim.ctxOf(t, inc);
        this.check(sp, ctx, res);
        if (!this.walked.has(res)) out.push(`${sp.name}'s fold of ${t} isn't walked to its end (stops ${JSON.stringify(this.stats.stops)})`);
        else this.observeCraps(sp, ctx, res, now);
      }
    }
    return out;
  }

  /** An ended incarnation's fold page sp holds (a switch-off, a removal, an
   *  ended table tidied up): its final checkpoint carries no table, but its
   *  nets are those the checker handed on at the close it names. */
  checkEnded(sp: SimPage, ctx: FoldCtx, res: FoldResult): void {
    if (!res.base.ended || res.base.l === null || this.walked.has(res)) return;
    this.walked.add(res);
    const at = this.expectNetsAt.get(res.base.l);
    const mine = netsText(res.base.n);
    if (at && !at.has(mine)) this.sim.violate(`${sp.name} ${ctx.t} at ${this.sim.elapsed} ms: the final checkpoint ${res.base.sid} nets ${mine}, the checker handed on ${[...at].join(' or ')} at ${res.base.l}`);
    if (at) this.stats.endedChecked += 1;
    this.countBase(sp, ctx, res, at !== undefined);
  }

  /** A base seen (once a page and session): checked against the checker's
   *  own figures at its close, or not (a close no page walked). */
  private countBase(sp: SimPage, ctx: FoldCtx, res: FoldResult, known: boolean): void {
    const seenKey = `${sp.name}|${ctx.t}:${ctx.inc}|${res.base.sid}`;
    if (this.baseSeen.has(seenKey)) return;
    this.baseSeen.add(seenKey);
    if (known) this.stats.basesChecked += 1;
    else this.stats.basesUnchecked += 1;
  }

  /** A walk stopped at a record the session lacks. */
  private stop(why: string): null {
    this.stats.stops[why] = (this.stats.stops[why] ?? 0) + 1;
    return null;
  }

  // ── 🔎 The checker ──

  /** Page sp's fold of craps table ctx.t, worked out afresh as a chain from
   *  its base (once a fold result). `card`: the ⚙ card's flag checked too
   *  (not from inside a transaction). */
  check(sp: SimPage, ctx: FoldCtx, res: FoldResult, card = true): void {
    if (this.walked.has(res)) return;
    const { casino, table } = sp.p;
    const ses = casino.computedSessionForWrite(ctx.t);
    if (casino.computedIncOf(ctx.t) !== ctx.inc) return;
    // (An ended incarnation's final checkpoint, its sessions compacted away
    // or not: an end mark ends it with its switch still naming it.)
    if (res.base.ended) {
      this.checkEnded(sp, ctx, res);
      return;
    }
    if (!ses) return;
    const wrong = (why: string): void => this.sim.violate(`${sp.name} ${ctx.t} at ${this.sim.elapsed} ms: ${why}`);
    let k = fromCarry(res.base.state as CarryLike | null);
    let N = new Map<string, bigint>(res.base.n);
    this.carryShape(k, (why) => wrong(`the base ${res.base.sid}'s carry ${why}`));
    // The base: the carry and nets the checker handed on at the close it
    // names, if it played it (one of them: a close's carry can change with
    // an earlier roll, which is a checkpoint flip, counted apart).
    if (res.base.l !== null) {
      const at = this.expectAt.get(res.base.l);
      const mine = `${carryText(k)}|${netsText(N)}`;
      if (at && !at.has(mine)) wrong(`the checkpoint ${res.base.sid} carries ${mine}, the checker handed on ${[...at].join(' or ')} at ${res.base.l}`);
      this.countBase(sp, ctx, res, at !== undefined);
    }
    const exps = new Map<number, Exp>();
    for (const v of res.rounds) {
      if (v.decided === null) {
        if (!this.tipOk(sp, ctx, ses, v, k, res, wrong)) return;
        continue;
      }
      const out = this.roll(sp, ctx, ses, v, k, N, wrong);
      if (!out) return;
      k = out.k;
      N = out.N;
      exps.set(v.r, out.exp);
    }
    // The carry the open roll plays from, the nets, and what the felts hold.
    if (textOf(res.carry as CarryLike) !== carryText(k)) wrong(`carries ${textOf(res.carry as CarryLike)}, the rolls hand on ${carryText(k)}`);
    if (netsText(res.nets) !== netsText(N)) wrong(`nets ${netsText(res.nets)}, the rolls give ${netsText(N)}`);
    if (!res.tip) {
      const held = new Map<string, bigint>();
      const point = k.p === 0 ? null : k.p;
      for (const pid of [...new Set([...k.w.keys(), ...res.felts.keys()])].sort()) {
        const C = k.w.get(pid) ?? [];
        const s = res.felts.get(pid)?.rec as CrapsSlipRec | undefined;
        const B = s && s.o === stampOf(k.p, C) && rulesOk(C, s.b, point) ? s.b : C;
        if (sumOf(B) > 0) held.set(pid, BigInt(sumOf(B)));
      }
      if (netsText(held) !== netsText(res.held)) wrong(`holds ${netsText(res.held)}, the felts standing hold ${netsText(held)}`);
      this.stats.heldChecked += 1;
    }
    // No honest player's slip broke a table rule (the ⚙ card's flag).
    if (card) {
      const rc = table.computedRoundCheck(ctx.t, Date.now());
      const honest = new Set(this.sim.pages.filter((q) => q.honest && !q.cheats).map((q) => q.pid));
      const flagged = (rc?.illegal ?? []).filter((pid) => honest.has(pid));
      if (flagged.length > 0) wrong(`the card flags ${flagged.join(',')} for a broken table rule at roll ${rc!.round}`);
      for (const pid of rc?.illegal ?? []) this.flagged.add(`${ctx.t}|${ctx.inc}|${rc!.round}|${pid}`);
    }
    this.walked.add(res);
    this.exps.set(res, exps);
    const lk = `${sp.name}|${ctx.t}|${ctx.inc}`;
    let last = this.lastExp.get(lk);
    if (!last) this.lastExp.set(lk, last = new Map());
    for (const [r, e] of exps) last.set(r, e);
  }

  /** The open roll's tip: its stakes are the felts that stand from carry k
   *  (the stamp, the rules, the room), and what the felts hold is them. */
  private tipOk(sp: SimPage, ctx: FoldCtx, ses: Y.Map<unknown>, v: RoundView, k: K, res: FoldResult, wrong: (why: string) => void): boolean {
    const slips = new Map<string, SlipIn>();
    for (const pid of v.present) {
      const s = ses.get(`s:${v.r}:${pid}:${v.frozen[pid]}`) as SlipIn | undefined;
      if (!s || !Array.isArray(s.b)) return false;
      slips.set(pid, s);
    }
    const { pids, fate, B } = feltsOf(k, slips);
    const stakes = new Map(pids.map((pid) => [pid, BigInt(sumOf(B.get(pid)!))]));
    if (mapText(stakes) !== mapText(v.stakes)) wrong(`roll ${v.r}'s tip stakes ${mapText(v.stakes)}, the felts standing ${mapText(stakes)}`);
    if (v.craps && mapText(new Map([...fate].map(([p, f]) => [p, f as unknown as number]))) !== mapText(new Map([...v.craps.fates].map(([p, f]) => [p, f as unknown as number])))) {
      wrong(`roll ${v.r}'s tip fates ${JSON.stringify([...v.craps.fates])}, the checker's ${JSON.stringify([...fate])}`);
    }
    const held = new Map([...stakes].filter(([, n]) => n !== 0n));
    if (netsText(held) !== netsText(res.held)) wrong(`holds ${netsText(res.held)} with roll ${v.r} closed, its stakes ${netsText(held)}`);
    void sp;
    void ctx;
    return true;
  }

  /** One decided roll v, played from carry k with nets N: worked out afresh
   *  and compared with the fold's; what it hands on. Null (and the walk
   *  stops, nothing kept) while a record it rests on isn't in the session. */
  private roll(
    sp: SimPage, ctx: FoldCtx, ses: Y.Map<unknown>, v: RoundView, k: K, N: Map<string, bigint>, wrong: (why: string) => void,
  ): { k: K; N: Map<string, bigint>; exp: Exp } | null {
    const at = (why: string): void => wrong(`roll ${v.r} (${v.decided}): ${why}`);
    // What decided it, from the session's own records: the close the fold
    // names and the slips it froze; the forfeit or the abandon it took (for
    // this close and roll), or every reveal in with nothing missing.
    const cKey = `c:${v.r}:${v.close}`;
    const cRec = ses.get(cKey);
    if (cRec === undefined) return this.stop('close');
    if (canon(cRec) !== canon(v.closeRec)) at(`its close ${cKey} reads ${canon(cRec)}, the fold's ${canon(v.closeRec)}`);
    if (canon(v.frozen) !== canon(v.closeRec.f)) at(`frozen ${canon(v.frozen)}, the close freezes ${canon(v.closeRec.f)}`);
    const pm = [...v.present, ...v.missing].sort();
    if (JSON.stringify(pm) !== JSON.stringify(Object.keys(v.closeRec.f).sort())) at(`present ${v.present} and missing ${v.missing}, the close freezes ${Object.keys(v.closeRec.f).sort()}`);
    if (v.decided === 'reveals') {
      if (v.forfeit || v.abandon) at('decided by the reveals, naming a forfeit or an abandon');
      if (v.missing.length > 0) at(`decided by the reveals with ${v.missing.join(',')} missing`);
    } else {
      const d = v.decided === 'forfeit' ? v.forfeit : v.abandon;
      if (!d || (v.decided === 'forfeit' ? v.abandon : v.forfeit)) {
        at(`no ${v.decided} record named (or both)`);
        return null;
      }
      const dKey = `${v.decided === 'forfeit' ? 'f' : 'z'}:${v.r}:${d.hash}`;
      const rec = ses.get(dKey);
      if (rec === undefined) return this.stop('decision');
      if (canon(rec) !== canon(d.rec)) at(`its ${dKey} reads ${canon(rec)}, the fold's ${canon(d.rec)}`);
      if (d.rec.r !== v.r || d.rec.x !== v.close) at(`its ${v.decided} ${dKey} is for roll ${d.rec.r}, close ${d.rec.x}`);
      if (v.forfeit && !v.forfeit.rec.n.every((pid) => v.present.includes(pid))) at(`its forfeit counts ${v.forfeit.rec.n}, not all frozen and present`);
    }
    const kText = carryText(k);
    const id = `${sp.name}|${ctx.t}:${ctx.inc}:${v.close}|${v.decided}|${v.forfeit?.hash ?? v.abandon?.hash ?? ''}|${v.counted.join(',')}|${bytesToHex(sha256(utf8ToBytes(kText))).slice(0, 16)}`;
    const memo = this.memo.get(id);
    if (memo) {
      // The same roll from the same table: the fold's figures as they were
      // when the checker played it, and the table handed on again.
      const digest = rollDigest(v);
      if (!v.craps || textOf(v.craps.sIn as CarryLike) !== kText) at(`plays from ${v.craps ? textOf(v.craps.sIn as CarryLike) : 'nothing'}, the roll before handed on ${kText}`);
      if (digest !== memo.digest) at(`reads ${digest}, where the checker played it as ${memo.digest}`);
      const N2 = new Map(N);
      for (const [pid, d] of memo.deltas) N2.set(pid, (N2.get(pid) ?? 0n) + d);
      this.handOn(v.close, memo.k, N2);
      this.stats.memoHits += 1;
      return { k: memo.k, N: N2, exp: memo.exp };
    }
    // Who is counted: the reveals every frozen bettor present, a forfeit its
    // own list, a void nobody.
    const counted = v.decided === 'reveals' ? v.present : v.decided === 'forfeit' ? [...(v.forfeit?.rec.n ?? [])].sort() : [];
    if (JSON.stringify(v.counted) !== JSON.stringify(counted)) at(`counted ${v.counted.join(',')}, not ${counted.join(',')}`);
    const inCount = new Set(counted);
    // The inputs, from the session's records.
    const slips = new Map<string, SlipIn>();
    const seeds: string[] = [];
    for (const pid of v.present) {
      const s = ses.get(`s:${v.r}:${pid}:${v.frozen[pid]}`) as SlipIn | undefined;
      if (s === undefined) return this.stop('slip');
      if (!Array.isArray(s.b) || typeof s.c !== 'string' || typeof s.o !== 'string') {
        at(`${pid}'s frozen slip reads ${canon(s)}`);
        return null;
      }
      slips.set(pid, s);
      if (!inCount.has(pid)) continue;
      const x = [...ses.keys()].filter((key) => key.startsWith(`x:${v.r}:${pid}:`)).map((key) => ses.get(key) as { r?: unknown; p?: unknown; s?: unknown })
        .find((rec) => rec?.r === v.r && rec.p === pid && typeof rec.s === 'string' && slipCommit(ctx, v.r, pid, rec.s) === s.c);
      if (!x) return this.stop('reveal');
      seeds.push(x.s as string);
    }
    // (A forfeit's writer counts itself: its key signed a slip of a pid it
    // counts.)
    if (v.forfeit && !v.forfeit.rec.n.some((pid) => (ses.get(`s:${v.r}:${pid}:${v.frozen[pid]}`) as { k?: unknown } | undefined)?.k === v.forfeit!.rec.k)) {
      at(`its forfeit's writer ${v.forfeit.rec.k.slice(0, 8)} counts no slip of its own`);
    }
    const roll = v.craps;
    if (!roll) {
      at('no craps roll on a craps table');
      return null;
    }
    const point = k.p === 0 ? null : k.p;
    const { pids, fate, B } = feltsOf(k, slips);
    const fateText = (m: ReadonlyMap<string, string>): string => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : 1)));
    if (fateText(fate) !== fateText(roll.fates)) at(`fates ${fateText(roll.fates)}, the checker's ${fateText(fate)}`);
    this.riderOracle(ctx, v, k, fate, at);
    this.oddsCap(k, fate, B, at);
    const rolled = v.decided === 'reveals' || v.decided === 'forfeit';
    // The dice: the fold's, held to the counted seeds' async draw (at the end
    // of the tick), and nothing on a void.
    const dice = roll.dice;
    if (rolled) {
      if (!dice || !dice.every((d) => Number.isInteger(d) && d >= 1 && d <= 6)) {
        at(`dice ${JSON.stringify(dice)}`);
        return null;
      }
      this.sim.pocketChecks.push(combineSeeds(seeds, seedTable(ctx), v.r).then((want) => {
        if (want[0] !== dice[0] || want[1] !== dice[1]) at(`dice ${dice.join('')}, the counted seeds draw ${want.join('')}`);
      }));
    } else if (dice !== null) {
      at(`a void with dice ${dice.join('')}`);
    }
    const [d1, d2] = dice ?? [0, 0];
    const sum = d1 + d2;
    // The money: every player's felt split into chips, in one call of
    // today's resolver, as owner-run craps settles a roll (crapsBackend). A
    // player the forfeit didn't count plays what was on the felt before and
    // loses what it added (the design's "a missing seed costs only new
    // chips"); a void moves nothing.
    const played = new Map<string, CrapsBet[]>();
    const lost = new Map<string, number>();
    for (const pid of pids) {
      const forfeited = slips.has(pid) && !inCount.has(pid) && fate.get(pid) === 'ok';
      const C = k.w.get(pid) ?? [];
      played.set(pid, forfeited && rolled ? minPer(B.get(pid)!, C) : B.get(pid)!);
      lost.set(pid, forfeited && rolled ? addedOver(B.get(pid)!, C) : 0);
      this.stats.fates[fate.get(pid)!] = (this.stats.fates[fate.get(pid)!] ?? 0) + 1;
      if (forfeited && rolled && sumOf(B.get(pid)!) > 0) this.stats[lost.get(pid)! > 0 ? 'forfeitLost' : 'forfeitRode'] += 1;
      if (forfeited && rolled && sumOf(played.get(pid)!) > 0) this.stats.forfeitPlayed += 1;
      if (forfeited && rolled) this.forfeitOf.set(`${ctx.t}|${ctx.inc}|${v.close}|${pid}`, { lost: lost.get(pid)!, played: sumOf(played.get(pid)!) });
      if (!rolled && fate.get(pid) === 'ok' && canon(B.get(pid)!) !== canon(C)) this.stats.voidChanged += 1;
    }
    const credited = new Map<string, number>();
    const rem = new Map<string, CrapsBet[]>();
    if (rolled) {
      const res = resolveCrapsRound(Object.fromEntries(pids.map((pid) => [pid, splitChips(played.get(pid)!, `${v.close}|${pid}`)])), d1, d2, point);
      for (const pid of pids) {
        credited.set(pid, hasOwn(res.payouts, pid) ? res.payouts[pid] : 0);
        rem.set(pid, canonList(hasOwn(res.remaining, pid) ? res.remaining[pid] : []));
      }
    } else {
      for (const pid of pids) {
        credited.set(pid, 0);
        rem.set(pid, B.get(pid)!);
      }
    }
    const deltas = new Map<string, bigint>();
    const amounts = new Map<string, bigint>();
    const pushes = new Set<string>();
    for (const pid of pids) {
      const P = played.get(pid)!;
      const delta = rolled ? credited.get(pid)! + sumOf(rem.get(pid)!) - sumOf(P) - lost.get(pid)! : 0;
      deltas.set(pid, BigInt(delta));
      if (!rolled) continue;
      // What was decided on it: each spot on its own (odds against the flat
      // as it stood).
      const outcomes: string[] = [];
      for (const b of P) {
        const o = isOddsType(b.type) ? resolveOddsStack(b.type, b.pick, b.amount, oddsFlat(P, b.type, b.pick), d1, d2, point) : resolveCrapsBet(b, d1, d2, point);
        if (o.outcome !== 'stay') outcomes.push(o.outcome);
        // (Coverage: a bet won or lost, once a close and decision.)
        if ((o.outcome === 'win' || o.outcome === 'lose') && !this.counted.has(`${v.close}|${v.decided}|${v.counted.join(',')}|${pid}|${spotOf(b)}`)) {
          this.counted.add(`${v.close}|${v.decided}|${v.counted.join(',')}|${pid}|${spotOf(b)}`);
          this.coverage.get(b.type)!.decided += 1;
        }
      }
      if (outcomes.length > 0 || lost.get(pid)! > 0) amounts.set(pid, BigInt(delta));
      if (outcomes.length > 0 && lost.get(pid) === 0 && outcomes.every((o) => o === 'push')) pushes.add(pid);
    }
    // Coverage: chips added to a type on a roll its felt played.
    for (const pid of pids) {
      if (fate.get(pid) !== 'ok') continue;
      const C = bySpot(k.w.get(pid) ?? []);
      for (const b of B.get(pid)!) {
        const ck = `${v.close}|${v.decided}|${v.counted.join(',')}|${pid}|${spotOf(b)}|placed`;
        if (b.amount > (C.get(spotOf(b)) ?? 0) && !this.counted.has(ck)) {
          this.counted.add(ck);
          this.coverage.get(b.type)!.placed += 1;
        }
      }
    }
    // The fold's figures, every one.
    const stakes = new Map(pids.map((pid) => [pid, BigInt(sumOf(B.get(pid)!))]));
    const big = (m: ReadonlyMap<string, number>): Map<string, bigint> => new Map([...m].map(([p, n]) => [p, BigInt(n)]));
    const cmp = (what: string, fold: ReadonlyMap<string, bigint>, mine: ReadonlyMap<string, bigint>): void => {
      if (mapText(fold) !== mapText(mine)) at(`${what} ${mapText(fold)}, the checker's ${mapText(mine)}`);
    };
    cmp('stakes', v.stakes, stakes);
    cmp('payouts', v.payouts, big(credited));
    cmp('deltas', v.deltas, deltas);
    cmp('credited', roll.credited, big(credited));
    cmp('lost', roll.lost, big(lost));
    cmp('amounts', roll.amounts, amounts);
    if (JSON.stringify([...roll.pushes].sort()) !== JSON.stringify([...pushes].sort())) at(`pushes ${[...roll.pushes]}, the checker's ${[...pushes]}`);
    const pointAfter = rolled ? nextPoint(point, sum) : point;
    const sevenOut = rolled ? shooterHandOver(point, sum) : false;
    if (roll.pointBefore !== point || roll.pointAfter !== pointAfter || roll.sevenOut !== sevenOut) {
      at(`point ${roll.pointBefore} → ${roll.pointAfter}, seven-out ${roll.sevenOut}; the checker's ${point} → ${pointAfter}, ${sevenOut}`);
    }
    // Who holds the dice: the players counted at their stand (counted, a
    // stand on the slip, chips on the felt that stood, a pid short enough);
    // the dice pass clockwise after the old shooter at a seven-out, at once
    // from the stickman's hand, or from a holder not counted at their stand
    // on a come-out or on the roll that makes the point.
    let h = k.h;
    let a = k.a;
    let i = k.i;
    if (rolled) {
      const seated = new Map<string, number>();
      for (const pid of v.present) {
        const s = slips.get(pid)!;
        if (inCount.has(pid) && s.t !== undefined && sumOf(B.get(pid)!) > 0 && pid.length <= MAX_SHOOTER_PID) seated.set(pid, s.t);
      }
      const ring = [...seated].map(([pid, t]) => ({ pid, angle: this.angleOf(t) }));
      const old = k.h ?? k.a;
      const pass = sevenOut || k.h === undefined || (!seated.has(k.h) && (point === null || pointAfter === null));
      h = pass ? pickShooter(ring, () => true, old) ?? undefined : k.h;
      a = pass ? old : k.a;
      i = h !== undefined && seated.has(h) ? 1 : undefined;
    }
    const w = new Map<string, CrapsBet[]>();
    for (const pid of pids) if (rem.get(pid)!.length > 0) w.set(pid, rem.get(pid)!);
    const k2: K = { p: pointAfter ?? 0, w, ...(h !== undefined ? { h } : {}), ...(a !== undefined ? { a } : {}), ...(h !== undefined && i === 1 ? { i: 1 as const } : {}) };
    if (textOf(roll.sIn as CarryLike) !== kText) at(`plays from ${textOf(roll.sIn as CarryLike)}, the roll before handed on ${kText}`);
    if (textOf(roll.sOut as CarryLike) !== carryText(k2)) at(`hands on ${textOf(roll.sOut as CarryLike)}, the checker's ${carryText(k2)}`);
    this.invariants(k, k2, rolled, sum, pids, fate, B, played, at);
    const N2 = new Map(N);
    for (const [pid, d] of deltas) N2.set(pid, (N2.get(pid) ?? 0n) + d);
    this.handOn(v.close, k2, N2);
    const exp: Exp = {
      r: v.r, close: v.close, decided: v.decided!, dice: dice ? [dice[0], dice[1]] : null, pointBefore: point, pointAfter, sevenOut,
      ...(k.h !== undefined ? { hIn: k.h } : {}), ...(h !== undefined ? { hOut: h } : {}),
      wOut: ridingText(w), riders: w.size, credited: big(credited), amounts, pushes: [...pushes].sort(), sIn: kText,
    };
    this.memo.set(id, { k: k2, deltas, digest: rollDigest(v), exp });
    this.sim.checkedRounds.add(id);
    this.stats.rollsChecked += 1;
    return { k: k2, N: N2, exp };
  }

  /** What the checker handed on at close x: the carry and nets (a
   *  checkpoint naming it holds one of them), and the nets alone (a final
   *  checkpoint, which carries no table). */
  private handOn(x: string, k2: K, N2: ReadonlyMap<string, bigint>): void {
    let seen = this.expectAt.get(x);
    if (!seen) this.expectAt.set(x, seen = new Set());
    seen.add(`${carryText(k2)}|${netsText(N2)}`);
    let nets = this.expectNetsAt.get(x);
    if (!nets) this.expectNetsAt.set(x, nets = new Set());
    nets.add(netsText(N2));
  }

  /** The rider oracle: a rider the checker saw at the table with betting
   *  open well before its end (riderLook) has its ride slip in every close
   *  of the roll an honest page wrote that was up and hearing the room since
   *  before then, over a network that lost nothing from a little before the
   *  look to RIDER_MARGIN_MS after it (riding bets otherwise ride anyway:
   *  fate 'rider' is no loss, but the slip states the stand the dice go
   *  by); while the rider's own pages stay as they were seen: up, not
   *  loaded again, never away, no goodbye (a close leaves out a goodbye
   *  that only rides: the design's "Leaving"). */
  private riderOracle(ctx: FoldCtx, v: RoundView, k: K, fate: ReadonlyMap<string, Fate>, at: (why: string) => void): void {
    const closer = this.sim.pages.find((q) => q.loads > 0 && q.p.pub === v.closeRec.k);
    if (!closer || !closer.honest || closer.cheats) return;
    // (A close freezes MAX_FROZEN at most, the earliest seen first: a full
    // table's leaves some out.)
    if (Object.keys(v.closeRec.f).length >= MAX_FROZEN) return;
    const cc = this.page(closer);
    for (const pid of k.w.keys()) {
      if (fate.get(pid) !== 'rider') continue;
      const T0 = this.riderSeen.get(`${ctx.t}|${ctx.inc}|${v.r}|${pid}`);
      if (T0 === undefined) continue;
      const from = T0 - RIDER_SETTLE_MS;
      if (cc.loadedT > from || closer.awayFrom !== null || closer.away.some(([, b]) => b >= from) || this.dirtyIn(from, T0 + RIDER_MARGIN_MS)) continue;
      const own = this.sim.pages.filter((q) => q.pid === pid && q.loads > 0);
      const moved = (q: SimPage): boolean => q.mode !== 'up' || this.page(q).loadedT > from || q.awayFrom !== null || q.away.some(([, b]) => b >= from);
      if (own.length === 0 || own.some(moved) || (this.byeT.get(pid) ?? -Infinity) >= from) continue;
      at(`${pid} rode at the table (seen ${T0 - (this.sim.T - this.sim.elapsed)} ms in, betting open), but ${closer.name}'s close ${v.close.slice(0, 8)} froze no slip of theirs`);
    }
  }

  /** An honest player's felt that played: its odds within the table's cap
   *  (maxOddsStake over the flat they ride on; the felt's own check,
   *  oddsRoom, and the table UI's ODDS MAX). */
  private oddsCap(k: K, fate: ReadonlyMap<string, Fate>, B: ReadonlyMap<string, CrapsBet[]>, at: (why: string) => void): void {
    const honest = new Set(this.sim.pages.filter((q) => q.honest && !q.cheats).map((q) => q.pid));
    for (const [pid, f] of fate) {
      if (f !== 'ok' || !honest.has(pid)) continue;
      const felt = B.get(pid)!;
      for (const b of felt) {
        if (!isOddsType(b.type)) continue;
        const n = b.type === 'passodds' || b.type === 'dontpassodds' ? k.p : b.pick ?? 0;
        const cap = maxOddsStake(b.type, n, oddsFlat(felt, b.type, b.pick));
        this.stats.oddsCapped += 1;
        if (b.amount > cap) at(`${pid}'s ${spotOf(b)} ${b.amount} is over the odds cap ${cap} (point ${k.p})`);
      }
    }
  }

  /** A carry's shape (isCarry's rules, held apart from it): the point one
   *  a carry may hold; at most 31 riders, each a pid a slip may name, its
   *  felt canonical (spot order, one entry a spot), with chips on it, at
   *  most 49 spots of whole chips (1 to 1e12 each, 1e12 at most in all),
   *  each a bet type with the pick it takes; shooters that can hold the
   *  dice; `i` only with a holder. */
  private carryShape(k: K, wrong: (why: string) => void): void {
    if (!CARRY_POINTS.has(k.p)) wrong(`point ${k.p}`);
    if (k.w.size > MAX_RIDERS) wrong(`${k.w.size} riders`);
    for (const [pid, f] of k.w) {
      if (pid.length === 0 || pid.length > MAX_PID) wrong(`rider ${JSON.stringify(pid)}`);
      if (!Array.isArray(f) || f.length === 0 || f.length > MAX_SPOTS) {
        wrong(`${pid}'s felt of ${Array.isArray(f) ? f.length : typeof f} spots`);
        continue;
      }
      let total = 0;
      for (const b of f) {
        const keys = Object.keys(b).sort().join(',');
        if (keys !== 'amount,type' && keys !== 'amount,pick,type') wrong(`${pid}'s bet ${JSON.stringify(b)} has fields ${keys}`);
        if (!(BET_TYPES as readonly string[]).includes(b.type)) wrong(`${pid}'s bet type ${JSON.stringify(b.type)}`);
        if (!Number.isSafeInteger(b.amount) || b.amount < 1 || b.amount > MAX_FELT_CHIPS) wrong(`${pid}'s ${spotOf(b)} amount ${b.amount}`);
        if (!pickOk(b)) wrong(`${pid}'s ${b.type} with pick ${b.pick}`);
        total += b.amount;
      }
      if (total > MAX_FELT_CHIPS) wrong(`${pid}'s felt holds ${total}`);
      if (canon(f) !== canon(canonList(f)) || new Set(f.map(spotOf)).size !== f.length) wrong(`${pid}'s felt ${JSON.stringify(f)} isn't canonical`);
    }
    for (const x of [k.h, k.a]) if (x !== undefined && (typeof x !== 'string' || x.length === 0 || x.length > MAX_SHOOTER_PID)) wrong(`shooter ${x}`);
    if (k.i !== undefined && (k.i !== 1 || k.h === undefined)) wrong(`in play ${k.i} with holder ${k.h}`);
  }

  /** The invariants a craps table keeps from carry k to k2 (map-rules §7:
   *  1, 2, 3, 5, 6 and 7 here; 8 to 11, the chain of carries and the
   *  shooter, by the checker's own carry compared with the fold's in roll and
   *  check; 4, the switch-off's refusal, is a switch scenario's). */
  private invariants(
    k: K, k2: K, rolled: boolean, sum: number, pids: string[], fate: ReadonlyMap<string, Fate>, B: ReadonlyMap<string, CrapsBet[]>,
    played: ReadonlyMap<string, CrapsBet[]>, at: (why: string) => void,
  ): void {
    const amountIn = (f: readonly CrapsBet[] | undefined, key: string): number => (f ? bySpot(f).get(key) ?? 0 : 0);
    for (const pid of pids) {
      const C = k.w.get(pid) ?? [];
      const out = k2.w.get(pid);
      for (const c of C) {
        if (!isContract(c, k.p)) continue;
        // 1. A contract bet stays as it was, unless this roll decided it.
        const decided = rolled && (c.type === 'pass' ? sum === k.p || sum === 7 : sum === c.pick || sum === 7);
        if (!decided && amountIn(out, spotOf(c)) !== c.amount) at(`${pid}'s contract ${spotOf(c)} ${c.amount} left the felt (${amountIn(out, spotOf(c))})`);
        // 2. A felt that played never moves it (nor raises a line bet
        // mid-point, nor a come or don't come on its number: below).
        if (fate.get(pid) === 'ok' && amountIn(B.get(pid), spotOf(c)) !== c.amount) at(`${pid}'s felt moved its contract ${spotOf(c)}`);
      }
      if (fate.get(pid) === 'ok') {
        const b = B.get(pid)!;
        for (const x of b) {
          const raised = x.amount > amountIn(C, spotOf(x));
          if (raised && (((x.type === 'pass' || x.type === 'dontpass') && k.p !== 0) || ((x.type === 'dontcome' || x.type === 'come') && x.pick !== undefined))) {
            at(`${pid}'s felt raised ${spotOf(x)} with point ${k.p}`);
          }
        }
      }
      if (!rolled || !out) continue;
      for (const x of out) {
        // 3. A pass rides on its point unchanged, or came up on the come-out
        // that set it; a come bet on a number rode in, or moved there now.
        if (x.type === 'pass') {
          const rode = k.p !== 0 && amountIn(C, 'pass:') === x.amount && k2.p === k.p;
          const set = k.p === 0 && POINTS.has(sum) && k2.p === sum && amountIn(played.get(pid), 'pass:') === x.amount;
          if (!rode && !set) at(`${pid}'s pass ${x.amount} rides on point ${k2.p} from ${k.p}, sum ${sum}`);
        }
        if (x.type === 'come' && x.pick !== undefined) {
          const rode = amountIn(C, spotOf(x)) === x.amount && sum !== x.pick && sum !== 7;
          const moved = sum === x.pick && amountIn(played.get(pid), 'come:') === x.amount;
          if (!rode && !moved) at(`${pid}'s ${spotOf(x)} ${x.amount} neither rode in nor moved there (sum ${sum})`);
        }
        // 5. No box bet nor one-roll bet rides past a roll with dice, and
        // odds ride only with their flat bet.
        if ((x.type === 'come' || x.type === 'dontcome') && x.pick === undefined) at(`${pid}'s ${x.type} rides in the box`);
        if (ONE_ROLL.has(x.type)) at(`${pid}'s one-roll ${x.type} rides on`);
        if (isOddsType(x.type)) {
          const flat = x.type === 'passodds' ? 'pass:' : x.type === 'dontpassodds' ? 'dontpass:' : `${x.type === 'comeodds' ? 'come' : 'dontcome'}:${x.pick}`;
          if (amountIn(out, flat) <= 0) at(`${pid}'s ${spotOf(x)} rides with no ${flat} behind it`);
        }
        // 6. The line and its odds only with a point on.
        if ((x.type === 'pass' || x.type === 'dontpass' || x.type === 'passodds' || x.type === 'dontpassodds') && k2.p === 0) at(`${pid}'s ${x.type} rides on a come-out`);
      }
    }
    // 6. Nothing rides past a seven-out.
    if (rolled && k.p !== 0 && sum === 7 && k2.w.size > 0) at(`bets ride past a seven-out: ${[...k2.w.keys()].join(',')}`);
    // 7. The carry's shape.
    this.carryShape(k2, (why) => at(`the carry handed on: ${why}`));
  }
}

/** What a craps view shows of the roll while settled (null otherwise): the
 *  dice and their sum, the point after and before, a seven-out, a void, the
 *  dice's hands after and before, the payouts, the amounts and pushes, how
 *  many ride on, the roll key. */
export function settledOf(view: ComputedCrapsState | null): unknown {
  if (!view || view.phase !== 'settled') return null;
  const ent = (r: Record<string, number> | null | undefined): [string, number][] => Object.entries(r ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    dice: view.dice, result: view.result, point: view.point, pointBefore: view.pointBefore ?? null, sevenOut: view.sevenOut === true,
    voided: view.voided === true, shooterAfter: view.shooterAfter ?? null, holderBefore: view.holderBefore ?? null,
    payouts: ent(view.payouts), amounts: ent(view.amounts), pushes: view.pushes ?? [], riders: view.riders, rollKey: view.rollKey,
  };
}

/** The fold's whole output with its carry and every roll's craps fields,
 *  as one canonical string (computedTestKit snapshot has neither). */
export function crapsSnapshot(res: FoldResult): string {
  const m = (map: ReadonlyMap<string, bigint>) => [...map.keys()].sort().map((k) => [k, map.get(k)!.toString()]);
  return JSON.stringify({
    fold: snapshot(res),
    carry: textOf(res.carry as CarryLike),
    rolls: res.rounds.map((v) => (v.craps ? {
      r: v.r, dice: v.craps.dice, pointBefore: v.craps.pointBefore, pointAfter: v.craps.pointAfter, sevenOut: v.craps.sevenOut,
      fates: [...v.craps.fates].sort(([a], [b]) => (a < b ? -1 : 1)), credited: m(v.craps.credited), lost: m(v.craps.lost),
      amounts: m(v.craps.amounts), pushes: [...v.craps.pushes].sort(), sIn: textOf(v.craps.sIn as CarryLike), sOut: textOf(v.craps.sOut as CarryLike),
    } : null)),
  });
}
