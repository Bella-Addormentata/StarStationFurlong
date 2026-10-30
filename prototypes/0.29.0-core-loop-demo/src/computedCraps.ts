/**
 * 🎲🧮 Computed craps — the rules a computed craps table's rolls are played
 * by (PR 3 of "Computed casino tables").
 *
 * PURE, like computedFold.ts: no Yjs, no Date, no Math.random, no
 * localStorage. The craps rules themselves are games/craps.ts's, untouched:
 * this file only says what a roll does to the table's carried state.
 *
 * A computed craps round is ONE ROLL. Roulette forgets everything after a
 * spin; craps can't: the point, every bet that rides and who holds the dice
 * carry from roll to roll. That carried state (CrapsCarry) is what the fold
 * hands from one decided roll to the next, and what a checkpoint stores as
 * `s` when it trims mid-hand.
 *
 * A SLIP at a craps table holds the player's WHOLE felt this roll as a
 * canonical list, one entry per spot (isCanonFelt), plus a stamp of what it
 * was built on (basisOf): the point and the player's own riding bets as their
 * page saw them. A slip whose stamp no longer matches (an earlier roll changed
 * under it) has none of its changes applied: its seed still counts and the
 * player's bets play as they stood. Every page checks each slip's change
 * against the felt's own rules (changeOk: canPlaceBet, canTakeDown) and plays
 * the bets as they stood when it breaks one.
 *
 * What a roll does (playRoll):
 *   - riders (players with bets in the carry) play their riding bets, whether
 *     or not they wrote a slip;
 *   - a frozen slip whose changes apply plays its felt; a newcomer takes a
 *     place only while the table has one (MAX_RIDERS, gone riders included);
 *   - a frozen player whose seed missed the forfeit loses only the chips it
 *     ADDED this roll: its take-downs stand and its riding bets play;
 *   - a void moves nothing: the point stays and every felt with chips stands
 *     as its player left it, this roll's changes included;
 *   - whatever doesn't win or lose rides on in the carry, and the dice pass
 *     by the shooter rules (shooterStep).
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  canPlaceBet, canTakeDown, isCrapsBet, isOddsType, nextPoint, oddsFlat, pickShooter, resolveCrapsBet,
  resolveCrapsRound, resolveOddsStack, shooterHandOver,
} from './games/craps';
import type { CrapsBet } from './games/craps';
import { diceFromMaterialSync } from './games/fairDice';

// ── Limits ───────────────────────────────────────────────────────────────────

/** Spots a craps felt has, so entries one canonical felt may hold: 13 without
 *  a pick, place ×6, hard ×4, come odds ×6, don't come odds ×6, come and
 *  don't come ×7 each (the box and six numbers). */
export const MAX_CRAPS_SPOTS = 49;
/** The most chips one canonical felt, and so one spot, may hold (casinoDoc
 *  MAX_LIST_STAKE). The largest return, 31 × this on a two or a twelve,
 *  stays inside the safe-integer range. */
export const MAX_FELT_STAKE = 1e12;
/** Players with chips on one roll, riders included, even gone riders:
 *  computedFold MAX_FROZEN, so every rider fits in one close. */
export const MAX_RIDERS = 31;
/** A longer pid never holds the dice: the seat record and the throw record
 *  (casinoDoc readSeats, readDiceThrow) both stop at 128. */
export const MAX_SHOOTER_PID = 128;
/** A seven-out trims once this many rolls have passed since the base. */
export const TRIM_SEVEN_OUT_MIN = 8;
/** The craps table's player stands (1–7) in clockwise order, the order of
 *  their atan2(z, x) in the table's frame (furniture.ts). */
export const RING: readonly number[] = [3, 4, 5, 7, 2, 1, 6];
/** The points a carry may hold; 0 is a come-out. */
export const CARRY_POINTS: ReadonlySet<number> = new Set([0, 4, 5, 6, 8, 9, 10]);

// ── The carried state ────────────────────────────────────────────────────────

/**
 * What one decided roll hands the next. Every object in it is built here
 * with a null prototype and read only through `own`: a pid like
 * 'constructor' is a valid player id, and a prototype read would hand the
 * rules a function.
 */
export interface CrapsCarry {
  /** The point for the next roll; 0 = a come-out. */ p: number;
  /** Rider pid → its canonical, NON-EMPTY felt; at most MAX_RIDERS pids. */ w: Record<string, CrapsBet[]>;
  /** The player holding the dice; absent = the stickman's hand. */ h?: string;
  /** The last shooter whose hand ended: the ring starts after them. */ a?: string;
  /** 1 = the shooter is in play: `h` was counted at their stand on the last
   *  roll that had dice. Only with `h`. */ i?: 1;
}

export const EMPTY_CARRY: CrapsCarry = Object.freeze({ p: 0, w: Object.freeze(Object.create(null)) as Record<string, CrapsBet[]> });

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** A pid's riding felt ([] when it has none). */
export function own(w: Record<string, CrapsBet[]>, pid: string): CrapsBet[] {
  return hasOwn(w, pid) ? w[pid] : [];
}

/** `w`'s own keys copied into a null-prototype object (a `w` read from the
 *  doc, or from `{}`, has Object.prototype). */
export function nullProtoCopy(w: Record<string, CrapsBet[]>): Record<string, CrapsBet[]> {
  const out: Record<string, CrapsBet[]> = Object.create(null);
  for (const pid of Object.keys(w)) out[pid] = w[pid];
  return out;
}

/** The carry's riders, in pid order. */
export function ridersOf(s: CrapsCarry): string[] {
  return Object.keys(s.w).sort();
}

/** The carry as a carry with only its present fields (h, a, i dropped when
 *  undefined), so two equal states spell the same. */
function carry(p: number, w: Record<string, CrapsBet[]>, h: string | undefined, a: string | undefined, i: 1 | undefined): CrapsCarry {
  const out: CrapsCarry = { p, w };
  if (h !== undefined) out.h = h;
  if (a !== undefined) out.a = a;
  if (h !== undefined && i === 1) out.i = 1;
  return out;
}

// ── The canonical felt ───────────────────────────────────────────────────────

/** A spot's key: the felt's own (games/casinoLayout spotKey, and craps.ts's
 *  private spotOf). Kept here so the fold's imports stay free of the felt's
 *  layout code; a spec checks they agree on every spot. */
export function spotKey(b: { type: string; pick?: number }): string {
  return `${b.type}:${b.pick ?? ''}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** One canonical felt entry: exactly {type, amount} or {type, pick, amount},
 *  the shape and pick craps.ts allows for the type, and a whole amount from 1
 *  to MAX_FELT_STAKE (isCrapsBet stops at 1e9 a record; a spot sums chips). */
function isFeltEntry(v: unknown): v is CrapsBet {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    if (v[k] !== undefined && k !== 'type' && k !== 'pick' && k !== 'amount') return false;
  }
  const amount = v.amount;
  if (!Number.isSafeInteger(amount) || (amount as number) < 1 || (amount as number) > MAX_FELT_STAKE) return false;
  return isCrapsBet({ type: v.type, pick: v.pick, amount: 1 });
}

/** A whole felt as a slip and a carry hold it: canonical entries, strictly
 *  ascending by spotKey (so each spot once, and one spelling per felt), at
 *  most MAX_CRAPS_SPOTS of them, MAX_FELT_STAKE in all. */
export function isCanonFelt(v: unknown): v is CrapsBet[] {
  if (!Array.isArray(v) || v.length > MAX_CRAPS_SPOTS) return false;
  let sum = 0;
  let last = '';
  for (let i = 0; i < v.length; i++) {
    const e = v[i];
    if (!isFeltEntry(e)) return false;
    const k = spotKey(e);
    if (i > 0 && !(last < k)) return false;
    last = k;
    sum += e.amount;
    if (sum > MAX_FELT_STAKE) return false;
  }
  return true;
}

/** One entry of a canonical felt, with no stray field. */
const entry = (type: CrapsBet['type'], pick: number | undefined, amount: number): CrapsBet =>
  pick === undefined ? { type, amount } : { type, pick, amount };

/** Any list of bets (one chip a record, as the felt draws them) as a
 *  canonical felt: summed per spot, empty spots dropped, sorted. */
export function canonFelt(list: readonly CrapsBet[]): CrapsBet[] {
  const sums = new Map<string, CrapsBet>();
  for (const b of list) {
    const k = spotKey(b);
    const was = sums.get(k);
    sums.set(k, entry(b.type, b.pick, (was?.amount ?? 0) + b.amount));
  }
  return [...sums.keys()].sort().map((k) => sums.get(k)!).filter((b) => b.amount > 0);
}

/** Chips on a felt. */
export function feltSum(f: readonly CrapsBet[]): number {
  let n = 0;
  for (const b of f) n += b.amount;
  return n;
}

const bySpot = (f: readonly CrapsBet[]): Map<string, CrapsBet> => new Map(f.map((b) => [spotKey(b), b]));

/** Per spot, the smaller of B and C (empty spots dropped): what of B was
 *  already on the felt in C. */
export function minPerSpot(B: readonly CrapsBet[], C: readonly CrapsBet[]): CrapsBet[] {
  const c = bySpot(C);
  const out: CrapsBet[] = [];
  for (const b of B) {
    const n = Math.min(b.amount, c.get(spotKey(b))?.amount ?? 0);
    if (n > 0) out.push(entry(b.type, b.pick, n));
  }
  return out;
}

/** Chips B adds over C, spot by spot (take-downs count nothing). */
export function addedOver(B: readonly CrapsBet[], C: readonly CrapsBet[]): number {
  const c = bySpot(C);
  let n = 0;
  for (const b of B) n += Math.max(0, b.amount - (c.get(spotKey(b))?.amount ?? 0));
  return n;
}

/** The same canonical felt. */
export function sameFelt(a: readonly CrapsBet[], b: readonly CrapsBet[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type || a[i].pick !== b[i].pick || a[i].amount !== b[i].amount) return false;
  }
  return true;
}

// ── The stamp ────────────────────────────────────────────────────────────────

/** computedFold canon of a canonical felt, spelled out (sorted keys: amount,
 *  pick, type), so this file needs nothing from the fold. A spec checks it
 *  against canon. */
export function feltCanon(f: readonly CrapsBet[]): string {
  return `[${f.map((b) => (b.pick === undefined
    ? `{"amount":${b.amount},"type":${JSON.stringify(b.type)}}`
    : `{"amount":${b.amount},"pick":${b.pick},"type":${JSON.stringify(b.type)}}`)).join(',')}]`;
}

/**
 * The stamp a slip carries: first 32 hex of sha256(utf8('ssf-ct-basis-v1|' +
 * canon({p: S.p, w: own(S.w, pid)}))), where S is the carry the felt was
 * BUILT on. Made when the felt is built, never at send: a felt built before
 * an earlier roll changed must read as built on the old state.
 */
export function basisOf(S: CrapsCarry, pid: string): string {
  const c = `{"p":${S.p},"w":${feltCanon(own(S.w, pid))}}`;
  return bytesToHex(sha256(utf8ToBytes(`ssf-ct-basis-v1|${c}`))).slice(0, 32);
}

// ── The table rules ──────────────────────────────────────────────────────────

/**
 * Whether felt B may follow felt C (both canonical) with `point` in force:
 * the felt's own buttons' rules, unchanged (games/craps canPlaceBet and
 * canTakeDown). A spot may go up only where a new bet of its type may be
 * placed, and never on a come or don't come that has travelled to a number;
 * it may come down only where the bet may be taken down. So line bets go up
 * only on a come-out, come bets only in the box with a point on, line odds
 * only with a point on, and a pass on its point or a travelled come never
 * moves. Odds over the table's cap, or with nothing behind them, stay
 * resolveOddsStack's (they are paid back, never paid out).
 */
export function changeOk(C: readonly CrapsBet[], B: readonly CrapsBet[], point: number | null): boolean {
  const before = bySpot(C);
  const after = bySpot(B);
  for (const [k, b] of after) {
    const c = before.get(k)?.amount ?? 0;
    if (b.amount > c && (!canPlaceBet(b.type, point) || ((b.type === 'come' || b.type === 'dontcome') && b.pick !== undefined))) {
      return false;
    }
    if (b.amount < c && !canTakeDown(b, point)) return false;
  }
  for (const [k, c] of before) if (!after.has(k) && !canTakeDown(c, point)) return false;
  return true;
}

// ── The dice ─────────────────────────────────────────────────────────────────

/** The two dice from the counted seeds: the same bytes as
 *  diceFairness.combineSeeds(seeds, table, r), synchronously. `table` is
 *  computedFold seedTable(ctx). A house table's Fair roll adds the house's
 *  seed, `|house:<seed>` last (as computedFold pocketOf). */
export function diceOf(table: string, r: number, seeds: readonly string[], house?: string): [number, number] {
  const tail = house === undefined ? '' : `|house:${house}`;
  return diceFromMaterialSync(`ssf-craps-combine-v1|${[...seeds].sort().join('|')}|${table}|${r}${tail}`);
}

// ── The shooter ──────────────────────────────────────────────────────────────

/**
 * Who holds the dice after a roll that had dice. `seated` is everyone
 * counted at their stand on it (seed in on time, a stand on the slip, a bet
 * down), pid → stand. The dice pass clockwise after the old shooter:
 *   - at a seven-out (the hand ends);
 *   - when nobody held them (a new table, or the stickman's hand), at once,
 *     even with a point on;
 *   - when the shooter wasn't counted at their stand and the roll was a
 *     come-out, or made the point (the next roll is a come-out).
 * Otherwise the shooter keeps them: a point is on and stays on, even while
 * they are away. A lone player keeps the dice (pickShooter puts `after`
 * last). `i` says the holder was counted at their stand on this roll.
 */
export function shooterStep(
  sIn: CrapsCarry,
  seated: ReadonlyMap<string, number>,
  sevenOut: boolean,
  pointBefore: number | null,
  pointAfter: number | null,
): { h?: string; a?: string; i?: 1 } {
  const ring = [...seated.keys()].sort().map((pid) => ({ pid, angle: RING.indexOf(seated.get(pid)!) }));
  const old = sIn.h ?? sIn.a;
  const pass = sevenOut
    || sIn.h === undefined
    || (!seated.has(sIn.h) && (pointBefore === null || pointAfter === null));
  const h = pass ? pickShooter(ring, () => true, old) ?? undefined : sIn.h;
  const a = pass ? old : sIn.a;
  return { h, a, i: h !== undefined && seated.has(h) ? 1 : undefined };
}

// ── One roll ─────────────────────────────────────────────────────────────────

/** Why a pid's felt stood as it did on a roll. */
export type RollFate =
  /** No slip frozen: a rider's bets played as they stood. */ | 'rider'
  /** The slip was built on another state: its changes didn't apply. */ | 'basis'
  /** The slip broke a table rule: its changes didn't apply. */ | 'illegal'
  /** A newcomer with no place left: its new bets came back. */ | 'full'
  /** The slip's felt played. */ | 'ok';

/** A frozen slip as a roll reads it. */
export interface RollSlip {
  /** The slip's whole felt (canonical). */ b: readonly CrapsBet[];
  /** Its stamp is basisOf(sIn, pid). */ basisOk: boolean;
  /** Its stand, 1–7, if it has one. */ t?: number;
}

export interface RollIn {
  /** The carry the roll plays from. */ sIn: CrapsCarry;
  /** P: the frozen slips present, by pid. */ slips: ReadonlyMap<string, RollSlip>;
  /** How the close was decided; null while it isn't. A house reveal
   *  (`house`) counts some seeds, as a forfeit does. */ decided: 'reveals' | 'forfeit' | 'house' | 'void' | null;
  /** The pids whose seeds made the dice. */ counted: readonly string[];
  /** The dice, when decided by reveals, a forfeit or the house. */ dice: readonly [number, number] | null;
}

export interface RollOut {
  /** pid → the felt that stood for it (B). Every rider and every pid in P. */ felts: Map<string, CrapsBet[]>;
  fates: Map<string, RollFate>;
  /** pid → chips on the felt this roll (ΣB): held while undecided. */ stakes: Map<string, number>;
  /** Decided only: pid → chips returned to it (a void: 0). */ credited: Map<string, number>;
  /** Decided only: pid → the chips it added this roll and lost to a late seed. */ lost: Map<string, number>;
  /** Decided only: pid → its net for the roll (credited + what rides on − what stood). */ deltas: Map<string, number>;
  /** Decided only: pid → won or lost this roll, for pids with a bet decided on it (or chips lost). */ amounts: Map<string, number>;
  /** Pids whose only bets decided this roll were pushes. */ pushes: Set<string>;
  pointBefore: number | null;
  /** The point after the roll (the same as before on a void, or undecided). */ pointAfter: number | null;
  sevenOut: boolean;
  /** The next roll's carry (sIn while undecided). */ sOut: CrapsCarry;
}

/**
 * Play one roll. Riders with no slip play as they stood; a slip's changes
 * apply only when its stamp matches and the table rules allow them, and a
 * newcomer only while the table has a place (riders first, then newcomers in
 * pid order). A frozen player the decision didn't count (a late or missing
 * seed under a forfeit) plays only what was already on the felt and loses
 * what it added (a seed the house didn't count, likewise). Riders' bets with
 * no decision ride on in the carry.
 */
export function playRoll(input: RollIn): RollOut {
  const { sIn, slips, decided, counted, dice } = input;
  const point = sIn.p === 0 ? null : sIn.p;
  const riders = Object.keys(sIn.w);
  const pids = [...new Set([...riders, ...slips.keys()])].sort();
  let room = MAX_RIDERS - riders.length;
  const inCount = new Set(counted);

  const out: RollOut = {
    felts: new Map(), fates: new Map(), stakes: new Map(), credited: new Map(), lost: new Map(), deltas: new Map(),
    amounts: new Map(), pushes: new Set(), pointBefore: point, pointAfter: point, sevenOut: false, sOut: sIn,
  };
  const w: Record<string, CrapsBet[]> = Object.create(null);
  const rolled = decided === 'reveals' || decided === 'forfeit' || decided === 'house';
  if (rolled && !dice) throw new TypeError('playRoll: a roll decided by seeds needs its dice');
  const [d1, d2] = dice ?? [0, 0];
  const seated = new Map<string, number>();

  for (const pid of pids) {
    const C = own(sIn.w, pid);
    const s = slips.get(pid);
    let fate: RollFate;
    if (!s) fate = 'rider';
    else if (!s.basisOk) fate = 'basis';
    else if (!changeOk(C, s.b, point)) fate = 'illegal';
    else if (C.length === 0 && s.b.length > 0) {
      if (room > 0) { room -= 1; fate = 'ok'; } else fate = 'full';
    } else fate = 'ok';
    const B = fate === 'ok' ? [...s!.b] : C;
    out.felts.set(pid, B);
    out.fates.set(pid, fate);
    out.stakes.set(pid, feltSum(B));
    if (!decided) continue;
    if (decided === 'void') {
      if (B.length > 0) w[pid] = B;
      out.credited.set(pid, 0);
      out.lost.set(pid, 0);
      out.deltas.set(pid, 0);
      continue;
    }
    const forfeited = s !== undefined && !inCount.has(pid);
    const played = forfeited && fate === 'ok' ? minPerSpot(B, C) : B;
    const lost = forfeited && fate === 'ok' ? addedOver(B, C) : 0;
    const res = resolveCrapsRound({ bettor: played }, d1, d2, point);
    const credited = res.payouts.bettor ?? 0;
    const rem = canonFelt(res.remaining.bettor ?? []);
    const delta = credited + feltSum(rem) - feltSum(played) - lost;
    out.credited.set(pid, credited);
    out.lost.set(pid, lost);
    out.deltas.set(pid, delta);
    // What was decided on it: each spot's own resolution (one entry a spot,
    // so the same as the round's; odds against the flat as it stood).
    const outcomes: string[] = [];
    for (const b of played) {
      const r = isOddsType(b.type)
        ? resolveOddsStack(b.type, b.pick, b.amount, oddsFlat(played, b.type, b.pick), d1, d2, point)
        : resolveCrapsBet(b, d1, d2, point);
      if (r.outcome !== 'stay') outcomes.push(r.outcome);
    }
    if (outcomes.length || lost > 0) out.amounts.set(pid, delta);
    if (outcomes.length && lost === 0 && outcomes.every((o) => o === 'push')) out.pushes.add(pid);
    if (rem.length > 0) w[pid] = rem;
    if (s !== undefined && inCount.has(pid) && s.t !== undefined && feltSum(B) > 0 && pid.length <= MAX_SHOOTER_PID) {
      seated.set(pid, s.t);
    }
  }
  if (Object.keys(w).length > MAX_RIDERS) throw new Error('playRoll: more riders than the table holds');
  if (!decided) return out;
  if (decided === 'void') {
    out.sOut = carry(sIn.p, w, sIn.h, sIn.a, sIn.i);
    return out;
  }
  const sum = d1 + d2;
  const after = nextPoint(point, sum);
  out.pointAfter = after;
  out.sevenOut = shooterHandOver(point, sum);
  const { h, a, i } = shooterStep(sIn, seated, out.sevenOut, point, after);
  out.sOut = carry(after ?? 0, w, h, a, i);
  return out;
}

/**
 * What each player holds on the felt while no close is in: a pid with a
 * latest version on the open round holds that version's felt if its stamp
 * matches and the rules allow the change (a newcomer's place isn't decided
 * until the close), else its riding bets; a rider with no version holds its
 * riding bets.
 */
export function standingOf(sIn: CrapsCarry, latest: ReadonlyMap<string, RollSlip>): Map<string, number> {
  const point = sIn.p === 0 ? null : sIn.p;
  const held = new Map<string, number>();
  for (const pid of [...new Set([...Object.keys(sIn.w), ...latest.keys()])].sort()) {
    const C = own(sIn.w, pid);
    const s = latest.get(pid);
    const B = s && s.basisOk && changeOk(C, s.b, point) ? s.b : C;
    const n = feltSum(B);
    if (n > 0) held.set(pid, n);
  }
  return held;
}
