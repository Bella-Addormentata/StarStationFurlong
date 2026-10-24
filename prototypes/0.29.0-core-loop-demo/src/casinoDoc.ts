/**
 * 🎰 `casino` map binding — chips, the cage ledger, and roulette table state
 * (#69 G1/G2).
 *
 * The room doc carries a `casino` Y.Map. CHIPS are room-doc records in this
 * phase — the plain-language rule applies everywhere (chips / cashier / the
 * cage; never token jargon). The G4 upgrade anchors the same ledger on the
 * Registry (issuer-mintable chip asset under the house's authority) without
 * changing this module's read/write shape.
 *
 * Key layout (all values plain JSON, whole-value transacted writes, LWW):
 *   bal:<playerId>            → number   chips as builds before the chip
 *                                        ledger stored them (read-only here:
 *                                        the opening balance, see CHIP LEDGER)
 *   bought:<playerId>         → number   lifetime chips issued, ditto
 *   cashed:<playerId>         → number   lifetime chips returned, ditto
 *   table:<tableId>           → RouletteTableState (croupier-written)
 *   bets:<tableId>:<playerId> → { round, held: RouletteBet[], inc, taken? }
 *                                        (owner-written; craps: { kind, held,
 *                                        inc, base, taken? }; an earlier
 *                                        build's: { round?, kind?, bets },
 *                                        and the stickman's prune of one adds
 *                                        inc, pruned; see STAKES ON THE FELT)
 *   kept:<tableId>:<playerId> → { round, kept: CrapsBet[], inc, taken? }
 *                                        what a craps settle left up
 *                                        (stickman-written)
 *   gone:<tableId>:<inc>      → 1        that incarnation of the table was
 *                                        removed (clearTableKeys); the bare
 *                                        `gone:<tableId>:` counts removals
 *   seat:<tableId>:<playerId> → TableSeat (owner-written while at the table)
 *   throw:<tableId>           → DiceThrow (the shooter's fling, or the
 *                                        stickman's when it throws for them)
 *
 * Every player-scoped key is written by exactly one writer in normal play, so
 * per-key LWW is safe. The one exception is an earlier build's craps list,
 * which the stickman prunes where it lies, as earlier builds' stickman did:
 * that page writing its list at the very moment of a roll's settle can lose
 * the write, as it could before (see STAKES ON THE FELT).
 *
 * 🧾 CHIP LEDGER: a player's chips are no longer one stored number that the
 * player (bets, buy-in, cash-out) and every operator (payouts, slots, the
 * coin pusher) all overwrite, where two writes at once kept only one. They
 * are records in the doc's `casinoChips` map: each page keeps one record per
 * player it has paid or charged (`<writer>:<playerId>` →
 * ChipRecord: whose chips, the net change, how much of it was bought or
 * cashed at the cage), and only that page writes it. A player's chips = their
 * stored `bal:` (what builds before the ledger left there, read as the opening
 * balance and never written again) + the sum of every page's record for them.
 * A sum doesn't care about order, so two pages paying or charging one player
 * at once both count, on every page. One writer per record means a record is
 * only ever overwritten by the binding that holds its last value (a fresh
 * writer id each bind), so no change is lost, and the doc grows by a record
 * per page per player, not per bet. What a roulette or craps table pays a
 * player is the one exception: it rides one record per table (each time it
 * is set up) and player, which names the outcome it paid last, so a round
 * settled on one page while another removed the table pays one of the two
 * (creditTableOutcome). Sums
 * are exact (bigint), so every page gets the same one whatever order records
 * arrive in. A slot machine's own bankroll is an account in the same ledger,
 * named by its `slot-bankroll:` key, whose stored value is its opening
 * balance. It is the first step of the computed tables (see the "Computed
 * casino tables" design). Trust is unchanged: honest clients, as before;
 * signed records come with the computed tables.
 *
 * 🪙 STAKES ON THE FELT: chips bet at roulette or craps are not taken from
 * the player when they go down. They stay the player's, held on the felt by
 * the bet list itself: a player's chips = their ledger total − every held
 * list on a live round (a roulette list of the table's current round before
 * it settles, any craps list on a table that is up). The settle turns a
 * round's stakes into one ledger change per bettor (won − staked, in the
 * table's outcome record) in the same transaction that ends the round, so
 * no page ever counts a stake both held and paid. Taking a bet down,
 * removing the table, or a round that leaves a list behind (a late bet)
 * hands its chips back with no credit at all: the list stops holding them.
 * The bet list is one whole value per player, and so is what it holds: two
 * tabs of one player placing at once keep one list and its chips, a
 * take-down and a removal at once hand them back once. Only the player
 * writes their list: what a craps roll leaves up the stickman writes as
 * `kept`, which plays until the player writes a list after that roll, so a
 * list written before the roll settled never brings back bets it resolved
 * (crapsFelt). An earlier build's list the stickman also prunes where it
 * lies, as earlier builds did, so that page reads the felt as the roll left
 * it; the prune is marked as the stickman's (`pruned`), so it plays only as
 * the `kept` record of the settle the doc kept. A list goes down only on a
 * table that is up.
 *
 * A list an earlier build put down (under `bets`) took its chips as it went
 * down. What it took rides with it as `taken`, through the player's rewrites
 * too: the list holds only the rest (FeltStake `net`, below 0 when the
 * player took more down than it took), the settle pays its wins in full, and
 * a removal refunds what it took, in the table's outcome record. Nothing is
 * handed back on a rewrite, so two tabs, or a tab and a removal, can't hand
 * it back twice. A craps settle at the very moment of the removal can win
 * that record over the refund: what the bets it kept up had taken is then
 * owed back by the `kept` record it left (keptOwed), and paid as the
 * removal's outcome when that record goes.
 *
 * A write at the very moment of a removal (a settle, a bet) outlives the
 * removal's delete, as a concurrent write does in the doc. So the removal
 * leaves `gone:<tableId>:<inc>` behind: a state of a removed incarnation
 * reads as no table and holds nothing, and a list belongs to the incarnation
 * it was put down on (its `inc`), so a table put back under the same id
 * starts clean. A list this build put down on an earlier build's state
 * carries none, and plays on until the table is first removed, which also
 * leaves `gone:<tableId>:`.
 *
 * The HOUSE keeps no stored record at all — everything about the cage is
 * DERIVED: issued = Σ buy-ins, outstanding = Σ chips, house net = issued −
 * cashed − outstanding. Nothing to inflate, nothing to desync; issuance is
 * public on the cashier screen (the fiction's "trust the casino, verify the
 * ledger").
 *
 * REBIND PER JOIN (T0 seam): main.ts joinRoomAtEpoch calls bindCasinoDoc
 * beside the games/furniture bindings. OFFLINE FALLBACK mirrors gamesDoc —
 * a page-local doc binds lazily so the casino works solo; a later real join
 * rebinds and the practice chips vanish with the local doc.
 */

import * as Y from 'yjs';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { isRouletteBet, isRouletteTableState } from './games/roulette';
import type { RouletteBet, RouletteTableState } from './games/roulette';
import { isCrapsBet, isCrapsTableState, isTableIncField, MAX_BET_AMOUNT, MAX_BETS_PER_PLAYER } from './games/craps';
import type { CrapsBet, CrapsTableState, FairnessMode } from './games/craps';
import {
  isSlotMachineState, isSlotOddsConfig, isSlotPlayRequest, isSlotReveal,
  isSlotFundingConfig,
} from './games/slots';
import type {
  SlotMachineState, SlotOddsConfig, SlotPlayRequest, SlotReveal,
  SlotFundingConfig,
} from './games/slots';
import {
  chipsInMachine, computeConservation, isCoinPusherState, isPusherDoorResult,
  isPusherEmptyRequest, isPusherInsertRequest, isPusherResult, normalizeCoinPusherState,
  PUSHER_ANTE,
} from './games/coinPusher';
import type {
  CoinPusherState, PusherDoorResult, PusherEmptyRequest, PusherInsertRequest,
  PusherRefusalReason, PusherResult,
} from './games/coinPusher';

/** One player's open bets on one table (round-stamped: stale rounds ignore).
 *  This build writes them under `held`: the chips stay the player's, held on
 *  the felt, until the round settles (see STAKES ON THE FELT). A list under
 *  `bets` is an earlier build's, whose chips were taken when it went down. */
export type TableBets =
  | { round: number; held: RouletteBet[]; inc?: string }
  | { round: number; bets: RouletteBet[] };

/** 🎲 One player's craps bets. Unlike roulette these PERSIST across rolls (a
 *  pass line rides its point; a place bet stays working), so there is no round
 *  stamp — the stickman prunes the list at each settle (see games/craps.ts).
 *  `held` or an earlier build's `bets`, as for roulette. */
export type CrapsTableBets =
  | { kind: 'craps'; held: CrapsBet[]; inc?: string }
  | { kind: 'craps'; bets: CrapsBet[] };

let boundDoc: Y.Doc | null = null;
let casinoMap: Y.Map<unknown> | null = null;
let bindingEpoch = 0;
const listeners = new Set<() => void>();
const keyListeners = new Map<string, Set<() => void>>();

function notify(changedKeys?: ReadonlySet<string>): void {
  // Copy + isolate (the furnitureDoc/gamesDoc guard): a listener may
  // unsubscribe mid-notify, and one throwing render must not kill the rest
  // or Yjs's transaction cleanup.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[casino] listener threw during doc notify:', err);
    }
  }
  for (const [key, keyed] of keyListeners) {
    if (changedKeys && !changedKeys.has(key)) continue;
    for (const listener of [...keyed]) {
      try {
        listener();
      } catch (err) {
        console.error(`[casino] listener for '${key}' threw during doc notify:`, err);
      }
    }
  }
}

function docAlive(): boolean {
  return boundDoc !== null
    && (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true;
}

/** The bound room's stable id ('' for the page-local practice doc): the
 *  fair tables bind their seed commitments to it. */
let boundRoomId = '';

export function bindCasinoDoc(doc: Y.Doc, roomId = ''): void {
  bindingEpoch += 1;
  boundRoomId = roomId;
  boundDoc = doc;
  pinPlayerKeys(doc);
  casinoMap = doc.getMap('casino');
  bindChipLedger(doc);
  bindHeldStakes(doc, casinoMap);
  // 🪙 Index the coin pushers' requests now, outside any operator poll, and
  // observe ahead of notify() so listeners never see a stale index.
  pusherRequestIndex(casinoMap);
  casinoMap.observe((event) => {
    if (heldTouched.size === 0) {
      notify(event.keysChanged);
      return;
    }
    const keys = new Set(event.keysChanged);
    for (const pid of heldTouched) keys.add(`bal:${pid}`);
    heldTouched.clear();
    notify(keys);
  });
  indexLegacySlotLeases(casinoMap);
  notify(); // repaint subscribers from the fresh doc
}

export function casinoDocEpoch(): number {
  return bindingEpoch;
}

export function casinoRoomId(): string {
  return boundRoomId;
}

/** Bound map, lazily falling back to a page-local doc (offline practice). */
function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !casinoMap) bindCasinoDoc(new Y.Doc());
  return casinoMap!;
}

export function subscribeCasino(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to one casino-map key instead of repainting on every casino write. */
export function subscribeCasinoKey(key: string, listener: () => void): () => void {
  let keyed = keyListeners.get(key);
  if (!keyed) {
    keyed = new Set();
    keyListeners.set(key, keyed);
  }
  keyed.add(listener);
  return () => {
    keyed!.delete(listener);
    if (keyed!.size === 0) keyListeners.delete(key);
  };
}

// ── Chips: the chip ledger (see CHIP LEDGER above) ──────────────────────────

/** One page's running total of what it has done to one account since it
 *  bound the room. Only the page that made it ever writes it. */
export interface ChipRecord {
  /** whose chips: a player id, or a slot bankroll's key (isBankrollAccount) */
  p: string;
  /** net chips added (negative: taken) */
  d: number;
  /** chips bought at the cage, part of `d` */
  b: number;
  /** chips cashed out at the cage, part of `d` */
  c: number;
  /** writer-clock ms of the last change, for reading the history only */
  at: number;
  /** a table's record only (creditTableOutcome): the last outcome it paid */
  ev?: string;
}

/** A slot machine's own bankroll is a ledger account too, named by its key
 *  (`slot-bankroll:machine:<mid>`, the legacy `slot-bankroll:shared`), so two
 *  pages moving chips in or out of it at once both count, as for a player. */
const BANKROLL_PREFIX = 'slot-bankroll:machine:';
const SHARED_BANKROLL_KEY = 'slot-bankroll:shared';

function isBankrollAccount(account: string): boolean {
  return account.startsWith(BANKROLL_PREFIX) || account === SHARED_BANKROLL_KEY;
}

export function isChipRecord(value: unknown): value is ChipRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<ChipRecord>;
  return typeof r.p === 'string' && r.p.length > 0 && r.p.length <= 256
    && Number.isSafeInteger(r.d)
    && Number.isSafeInteger(r.b) && (r.b as number) >= 0
    && Number.isSafeInteger(r.c) && (r.c as number) >= 0
    && typeof r.at === 'number' && Number.isFinite(r.at)
    && (r.ev === undefined || (typeof r.ev === 'string' && r.ev.length <= 64));
}

let chipsMap: Y.Map<unknown> | null = null;
/** This binding's prefix for the records it writes: a fresh one each bind, so
 *  a record is only ever overwritten by the binding that holds its last value. */
let chipWriter = '';
/** This binding's current record key per account, and how many records it has
 *  started afresh because one was full (a total past the safe-integer range). */
let chipKeys = new Map<string, string>();
let chipRolls = 0;
/** The bound ledger, summed exactly (bigint, so every page gets the same sum
 *  whatever order the records came in): account → Σ records, and the cage
 *  totals. */
interface ChipIndex {
  byAccount: Map<string, bigint>;
  /** each counted record as counted (so an overwrite or delete is undone exactly) */
  counted: Map<string, ChipRecord>;
  bought: bigint;
  cashed: bigint;
}
let chipIndex: ChipIndex = { byAccount: new Map(), counted: new Map(), bought: 0n, cashed: 0n };
/** Accounts whose chips changed since the last notify. */
const chipsTouched = new Set<string>();

function countChipRecord(ix: ChipIndex, rec: ChipRecord, sign: 1n | -1n): void {
  ix.byAccount.set(rec.p, (ix.byAccount.get(rec.p) ?? 0n) + sign * BigInt(rec.d));
  ix.bought += sign * BigInt(rec.b);
  ix.cashed += sign * BigInt(rec.c);
  chipsTouched.add(rec.p);
}

/** Bring one key's record in the index in line with the map. */
function recountChipKey(ix: ChipIndex, map: Y.Map<unknown>, key: string): void {
  const before = ix.counted.get(key);
  const value = map.get(key);
  const now = isChipRecord(value) ? value : undefined;
  if (before === now) return;
  if (before) { countChipRecord(ix, before, -1n); ix.counted.delete(key); }
  if (now) { countChipRecord(ix, now, 1n); ix.counted.set(key, now); }
}

function bindChipLedger(doc: Y.Doc): void {
  const map = doc.getMap<unknown>('casinoChips');
  const ix: ChipIndex = { byAccount: new Map(), counted: new Map(), bought: 0n, cashed: 0n };
  for (const key of map.keys()) recountChipKey(ix, map, key);
  chipsMap = map;
  chipIndex = ix;
  chipWriter = `${doc.clientID.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  chipKeys = new Map();
  chipRolls = 0;
  chipsTouched.clear();
  // Recount BEFORE any observer runs, so a casino-map listener firing in the
  // same transaction (a settle that writes a machine and a payout together)
  // already reads the new chips.
  doc.on('beforeObserverCalls', (tr: Y.Transaction) => {
    if (chipIndex !== ix) return; // a binding we've moved off
    const keys = tr.changed.get(map as unknown as Y.AbstractType<Y.YEvent<any>>);
    if (keys) for (const key of keys) if (key !== null) recountChipKey(ix, map, key);
  });
  map.observe(() => {
    if (chipIndex !== ix || chipsTouched.size === 0) return;
    const changed = new Set([...chipsTouched].map(
      (account) => (isBankrollAccount(account) ? account : `bal:${account}`),
    ));
    chipsTouched.clear();
    notify(changed);
  });
}

function ensureChips(): Y.Map<unknown> {
  ensureMap();
  return chipsMap!;
}

function clampSafe(n: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(n > max ? max : n < -max ? -max : n);
}

/** An account's chips, exactly: its opening balance (what a build before the
 *  ledger stored under `bal:<pid>`, or under the bankroll's own key) + Σ
 *  records. Below 0 when two pages spent the same chips at once. */
function ledgerTotal(account: string): bigint {
  const map = ensureMap();
  const opening = legacyCount(map, isBankrollAccount(account) ? account : `bal:${account}`);
  return opening + (chipIndex.byAccount.get(account) ?? 0n);
}

/** A count an earlier build stored (`bal:`, `bought:`, `cashed:`, a
 *  bankroll), exactly: those builds kept any non-negative integer, even past
 *  the safe range. Anything else reads as 0. */
function legacyCount(map: Y.Map<unknown>, key: string): bigint {
  const value = map.get(key);
  return Number.isInteger(value) && (value as number) >= 0 ? BigInt(value as number) : 0n;
}

/** An account's chips as a number: never below 0, never past the safe range. */
function readLedgerAccount(account: string): number {
  return Math.max(0, clampSafe(ledgerTotal(account)));
}

/** A player's chips to play with: their ledger total less what they have
 *  held on felts. Never below 0, never past the safe range. */
export function readChips(playerId: string): number {
  return Math.max(0, clampSafe(ledgerTotal(playerId) - heldStake(playerId)));
}

function nextChipRecord(was: ChipRecord | null, account: string, delta: number, cage?: 'buy' | 'cashout'): ChipRecord {
  return {
    p: account,
    d: (was?.d ?? 0) + delta,
    b: (was?.b ?? 0) + (cage === 'buy' && delta > 0 ? delta : 0),
    c: (was?.c ?? 0) + (cage === 'cashout' && delta < 0 ? -delta : 0),
    at: Date.now(),
  };
}

function isWholeRecord(rec: ChipRecord): boolean {
  return Number.isSafeInteger(rec.d) && Number.isSafeInteger(rec.b) && Number.isSafeInteger(rec.c);
}

/**
 * Add `delta` chips to `account` (negative takes them): this page's record
 * for it, with the change added (or, when that record's total would leave the
 * safe-integer range, a fresh record beside it). Counted at once, so later
 * reads in the same transaction see it. Call it inside the transaction that
 * makes the change it pays for. `cage` marks a buy-in or a cash-out.
 */
function addChips(account: string, delta: number, cage?: 'buy' | 'cashout'): void {
  if (!Number.isSafeInteger(delta) || delta === 0 || account.length === 0 || account.length > 256) return;
  const map = ensureChips();
  let key = chipKeys.get(account) ?? `${chipWriter}:${account}`;
  const stored = map.get(key);
  let rec = nextChipRecord(isChipRecord(stored) && stored.p === account ? stored : null, account, delta, cage);
  if (!isWholeRecord(rec)) {
    chipRolls += 1;
    key = `${chipWriter}~${chipRolls}:${account}`;
    rec = nextChipRecord(null, account, delta, cage);
  }
  chipKeys.set(account, key);
  boundDoc!.transact(() => {
    map.set(key, rec);
    recountChipKey(chipIndex, map, key);
  });
}

/** A money key's balance: a player's chips (`bal:<pid>`), a slot bankroll's
 *  ledger account, or a stored count. */
function readAccount(map: Y.Map<unknown>, key: string): number {
  if (key.startsWith('bal:')) return readChips(key.slice(4));
  if (isBankrollAccount(key)) return readLedgerAccount(key);
  return safeCount(map, key);
}

/** Move a money key from `before` (as just read) to `after`: a chip record
 *  for a ledger account, a plain write for any other stored count. */
function writeAccount(map: Y.Map<unknown>, key: string, before: number, after: number): void {
  if (key.startsWith('bal:')) addChips(key.slice(4), after - before);
  else if (isBankrollAccount(key)) addChips(key, after - before);
  else map.set(key, after);
}

/** Cashier BUY-IN: the cage issues chips to the player. */
export function buyInChips(playerId: string, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  addChips(playerId, amount, 'buy');
}

/** Cashier CASH-OUT: chips go back to the cage. Returns chips returned. */
export function cashOutChips(playerId: string, amount: number): number {
  const bal = readChips(playerId);
  const n = Math.min(bal, Math.max(0, Math.floor(amount)));
  if (n <= 0) return 0;
  addChips(playerId, -n, 'cashout');
  return n;
}

/** Take chips from a player now. False when the balance is short. (A table
 *  bet doesn't: its list holds the chips, see STAKES ON THE FELT.) */
export function spendChips(playerId: string, amount: number): boolean {
  if (!Number.isInteger(amount) || amount <= 0) return false;
  const bal = readChips(playerId);
  if (bal < amount) return false;
  addChips(playerId, -amount);
  return true;
}

/** Return chips to a player (bet refund by its owner, payout by the croupier).
 *  Always lands: the ledger holds any total; reads stop at the safe range. */
export function creditChips(playerId: string, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  addChips(playerId, amount);
}

/** A table's chip record past this total (either way) takes no more
 *  (creditTableOutcome), and one outcome moves at most the rest of the safe
 *  range, so a record never leaves it. No table comes near either: a bet
 *  list returns at most 3.6e13 (games/craps MAX_BET_AMOUNT). */
const TABLE_RECORD_FULL = 2 ** 52;
const MAX_TABLE_OUTCOME = Number.MAX_SAFE_INTEGER - TABLE_RECORD_FULL;

/**
 * Move `amount` chips to `playerId` (negative: from them) for one outcome of
 * one table: a settled round (`outcome` its number: what it paid less what it
 * took off the felt) or the table's removal ('end': what an earlier build's
 * stakes took, refunded). A round writes its outcome for every bettor, even
 * one that moves nothing, so it competes with another page's settle of the
 * same round on the same record, as the state and the kept bets do. Two
 * pages can each carry out the same outcome (both refund a removed
 * table), or two that exclude each other (one settles a round while the other
 * removes the table), before either hears of the other. So what a table pays a
 * player rides one record per table incarnation and player,
 * `tbl:<tableId>:<inc>:<pid>`, naming the outcome it paid last: a write adds
 * to it unless it already names this outcome, and of two written at once the
 * doc keeps one, so the player is paid for one outcome, never both. The
 * removal is the last outcome: once paid, nothing more from that table is.
 * `inc` is the table's incarnation (tableIncFor), so a table set up again
 * under the same id has a record of its own. A record whose stored total has
 * reached TABLE_RECORD_FULL takes no more: the next outcome goes on in the
 * next record of the chain (`~1`, `~2`…). Full is read from the stored total
 * alone, never the amount, so two pages paying different amounts at once
 * still write the same record, and the last record is always where the last
 * outcome (and a removal) was paid. Two pages that each go on settling
 * rounds without hearing of the other (one cut off from the room) build two
 * chains on one record, and the doc keeps one of them, with its table state:
 * the one table lease keeps that to a page that never hears the room
 * (croupier.takeTableTurn), and the computed tables end it.
 */
export function creditTableOutcome(
  tableId: string, inc: string, outcome: number | 'end', playerId: string, amount: number,
): void {
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > MAX_TABLE_OUTCOME) return;
  if (playerId.length === 0 || playerId.length > 256) return;
  const map = ensureChips();
  const { base, link, was } = lastOutcome(map, tableId, inc, playerId);
  const ev = String(outcome);
  if (was?.ev === ev || was?.ev === 'end') return;
  const full = was !== null && Math.abs(was.d) >= TABLE_RECORD_FULL;
  const last = link === 0 ? base : `${base}~${link}`;
  const key = full ? `${base}~${link + 1}` : last;
  const d = (full ? 0 : was?.d ?? 0) + amount;
  const rec: ChipRecord = { p: playerId, d, b: 0, c: 0, at: Date.now(), ev };
  boundDoc!.transact(() => {
    map.set(key, rec);
    recountChipKey(chipIndex, map, key);
    heldDirty = true; // a removal's outcome ends what kept bets owe (keptOwed)
  });
}

/** The last record of a table's outcome chain for a player (see
 *  creditTableOutcome): its base key, which link it is, and what it holds. */
function lastOutcome(
  chips: Y.Map<unknown>, tableId: string, inc: string, playerId: string,
): { base: string; link: number; was: ChipRecord | null } {
  const base = `tbl:${tableId}:${inc}:${playerId}`;
  let link = 0;
  while (chips.has(`${base}~${link + 1}`)) link += 1;
  const stored = chips.get(link === 0 ? base : `${base}~${link}`);
  return { base, link, was: isChipRecord(stored) && stored.p === playerId ? stored : null };
}

/** The incarnation a table takes when its first round opens (and a table
 *  from an earlier build at its next): it names the table's outcomes for
 *  creditTableOutcome and the lists put down on it. It is drawn from the
 *  table and the record of its removals (its `gone:` marks), not at random:
 *  two pages opening the same table at once, before either hears of the
 *  other, name it alike, so what each pays meets on one record, as their
 *  states meet on one key; a table put back after a removal is a new one. */
export function tableIncFor(tableId: string): string {
  const map = ensureMap();
  const prefix = `gone:${tableId}:`;
  const removals = [...map.entries()].filter(([key]) => key.startsWith(prefix))
    .map(([key, value]): [string, unknown] => [key.slice(prefix.length), value])
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const named = `ssf-table-inc-v1|${tableId}|${JSON.stringify(removals)}`;
  return bytesToHex(sha256(new TextEncoder().encode(named))).slice(0, 24);
}

/** Every chip record in the bound room (one per page per account), oldest
 *  change first (the history behind a balance; debugging). */
export function readChipRecords(account?: string): ChipRecord[] {
  ensureChips();
  const out = [...chipIndex.counted.values()].filter((r) => account === undefined || r.p === account);
  return out.sort((a, b) => a.at - b.at);
}

// ── The cage ledger (all DERIVED — see module header) ────────────────────────

export interface CageLedger {
  issued: number;
  cashed: number;
  outstanding: number;
  /** issued − cashed − outstanding: + = the house is up, − = the house owes. */
  houseNet: number;
  /** playerId → current chips, every non-zero balance (public floor ledger). */
  balances: Record<string, number>;
}

export function readCageLedger(): CageLedger {
  const map = ensureMap();
  ensureChips();
  let issued = chipIndex.bought, cashed = chipIndex.cashed, outstanding = 0n;
  const players = new Set<string>(
    [...chipIndex.byAccount.keys()].filter((account) => !isBankrollAccount(account)),
  );
  for (const [key, value] of map.entries()) {
    if (!Number.isInteger(value) || (value as number) < 0) continue;
    const n = BigInt(value as number);
    if (key.startsWith('bought:')) issued += n;
    else if (key.startsWith('cashed:')) cashed += n;
    else if (key.startsWith('bal:')) players.add(key.slice(4));
  }
  const balances: Record<string, number> = {};
  for (const pid of players) {
    // (Chips held on a felt are in play, not out with the player.)
    const total = ledgerTotal(pid) - heldStake(pid);
    if (total <= 0n) continue;
    outstanding += total;
    balances[pid] = clampSafe(total);
  }
  return {
    issued: clampSafe(issued),
    cashed: clampSafe(cashed),
    outstanding: clampSafe(outstanding),
    houseNet: clampSafe(issued - cashed - outstanding),
    balances,
  };
}

// ── Roulette table state + bets ──────────────────────────────────────────────

export function readTableState(tableId: string): RouletteTableState | null {
  const map = ensureMap();
  const value = map.get(`table:${tableId}`);
  return isRouletteTableState(value) && !removed(map, tableId, value) ? value : null;
}

/** `gone:` key of a table's incarnation (see STAKES ON THE FELT). */
function goneKey(tableId: string, inc: string): string {
  return `gone:${tableId}:${inc}`;
}

/** A state of an incarnation the table's removal has ended (written at the
 *  moment of the removal, it outlived the delete). A state an earlier build
 *  wrote has no incarnation: its removal marks `gone:<tableId>:`, and a table
 *  put back after it starts an incarnation of its own (openBetting). */
function removed(map: Y.Map<unknown>, tableId: string, s: RouletteTableState | CrapsTableState): boolean {
  return map.has(goneKey(tableId, s.inc ?? ''));
}

/** Whether incarnation `inc` of a table (undefined: an earlier build's,
 *  which has none) has been removed. */
export function tableIncRemoved(tableId: string, inc: string | undefined): boolean {
  return ensureMap().has(goneKey(tableId, inc ?? ''));
}

/** Croupier-only in practice (the UI gates on the house predicate). */
export function writeTableState(tableId: string, state: RouletteTableState): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`table:${tableId}`, state);
    heldDirty = true;
  });
}

/** 🎰 Wipe every casino key for a table (its state, croupier heartbeat, and all
 *  per-player bets) — the removal teardown so a deleted table leaves no orphan
 *  records. Held stakes go back with their lists; refunding an earlier build's
 *  lists is the CALLER's job (croupier.closeTable), done before this so the
 *  bet records are still readable. Leaves the incarnation's `gone:` mark, so
 *  a state or list written at the same moment stays ended. One transact. */
export function clearTableKeys(tableId: string): void {
  const map = ensureMap();
  const betPrefix = `bets:${tableId}:`;
  const keptPrefix = `kept:${tableId}:`;
  boundDoc!.transact(() => {
    // What kept bets left by an earlier removal still owe is paid before
    // they go (keptOwed).
    for (const key of [...map.keys()]) {
      if (key.startsWith(keptPrefix)) payKeptOwed(map, tableId, key.slice(keptPrefix.length));
    }
    // The incarnation removed, and any before it that had none: a list this
    // build put down on one of those carries none either (ofIncarnation). No
    // mark for a table this page never saw up (a page leaving a room for one
    // without it reconciles the old room's tables away), nor for a state of
    // an incarnation a removal already ended (a write at its moment left it
    // behind). An earlier build's state up has no incarnation, so the mark
    // is the one a page that hasn't heard of the removal gives it at its next
    // round (tableIncFor, alike on every page): that round, opened at the
    // moment of the removal, is ended too. The bare mark counts the
    // removals, an earlier build's state too though it reads as ended (that
    // page may have rewritten it after a removal), so a table put back
    // always names a new incarnation.
    const was = map.get(`table:${tableId}`);
    if (isRouletteTableState(was) || isCrapsTableState(was)) {
      const up = !removed(map, tableId, was);
      if (up) map.set(goneKey(tableId, was.inc ?? tableIncFor(tableId)), 1);
      if (up || was.inc === undefined) {
        const count = map.get(goneKey(tableId, ''));
        map.set(goneKey(tableId, ''), (Number.isSafeInteger(count) ? count as number : 0) + 1);
      }
    }
    map.delete(`table:${tableId}`);
    map.delete(`croupier:${tableId}`);
    // 🎲 The per-table config keys ride the same map — a removed table must
    // not leave orphaned settings behind (harmless no-op for roulette, which
    // never writes them).
    map.delete(`cfg:backend:${tableId}`);
    map.delete(`cfg:fairness:${tableId}`);
    map.delete(`throw:${tableId}`);
    const seatPrefix = `seat:${tableId}:`;
    const seedPrefix = `fseed:${tableId}:`;
    for (const key of [...map.keys()]) {
      if (key.startsWith(betPrefix) || key.startsWith(keptPrefix) || key.startsWith(seatPrefix)
        || key.startsWith(seedPrefix)) map.delete(key);
    }
    heldDirty = true;
  });
}

// ── 🤖 #77B croupier heartbeat ───────────────────────────────────────────────
// The elected operator (deed holder) refreshes `croupier:<tableId>` while it is
// auto-running a table. A FRESH beat is how every client tells "a robot croupier
// is live on this table" (→ show the countdown, hide the manual controls, let
// the robot narrate) from "no operator here" (→ the legacy manual house buttons).
// It is a bare ms timestamp; the cage ledger ignores it (no bought:/cashed:/bal:
// prefix), and it never collides with the table: / bets: keys.

export function readCroupierBeat(tableId: string): number | null {
  const v = ensureMap().get(`croupier:${tableId}`);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function writeCroupierBeat(tableId: string, beatAt: number): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`croupier:${tableId}`, beatAt);
  });
}

// ── 🎰 The table operator lease ──────────────────────────────────────────────
// The deed holder can have the room open on several pages (tabs, devices), and
// every one of them may run the croupier. Only the page holding
// `table-operator` drives the auto tables, so a round is settled and paid once
// (chip records add up, so two settles would pay twice). Its holder rewrites it
// every few seconds (`beat`); croupier.ts takeTableTurn has the rules.

export interface TableOperatorLease {
  /** the driving page (croupier.ts ROULETTE_PAGE_ID) */
  page: string;
  /** its player, the deed holder when it claimed */
  player: string;
  /** bumped on each renewal, so other pages see it is alive */
  beat: number;
}

export const TABLE_OPERATOR_KEY = 'table-operator';

export function readTableOperatorLease(): TableOperatorLease | null {
  const v = ensureMap().get(TABLE_OPERATOR_KEY);
  if (typeof v !== 'object' || v === null) return null;
  const l = v as Partial<TableOperatorLease>;
  return typeof l.page === 'string' && l.page.length > 0 && l.page.length <= 256
    && typeof l.player === 'string' && l.player.length > 0 && l.player.length <= 128
    && Number.isSafeInteger(l.beat)
    ? { page: l.page, player: l.player, beat: l.beat as number }
    : null;
}

export function writeTableOperatorLease(lease: TableOperatorLease): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(TABLE_OPERATOR_KEY, lease);
  });
}

/** One player's bets on a table as they play, and the chips of them already
 *  taken from the player (`taken`: an earlier build's list took its chips as
 *  it went down, and a list rewritten from one carries what it took). The
 *  rest, `net`, is held on the felt: off the player's chips until the round
 *  settles (see STAKES ON THE FELT). `net` is below 0 when a rewrite left
 *  fewer bets than were taken: the difference is back with the player. */
export interface FeltStake {
  net: number;
  taken: number;
}

const NO_STAKE: FeltStake = { net: 0, taken: 0 };

/** Most chips one list can take or hold (bets × the largest stake). */
const MAX_LIST_STAKE = MAX_BETS_PER_PLAYER * MAX_BET_AMOUNT;

/** A stored list's bets and what of them was taken, either shape: this
 *  build's `held` (with `taken` when rewritten from an earlier build's list,
 *  and craps' `base`), or an earlier build's `bets`, all taken. Null for junk,
 *  or a list put down on another incarnation of the table than `inc`. */
function storedList<B extends { amount: number }>(
  value: unknown, isBet: (b: unknown) => boolean, at: Incarnation,
): { bets: B[]; taken: number; legacy: boolean; base?: number; pruned?: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  const t = value as { held?: unknown; bets?: unknown; inc?: unknown; taken?: unknown; base?: unknown; pruned?: unknown };
  const held = t.held !== undefined;
  const list = held ? t.held : t.bets;
  if (held && t.bets !== undefined) return null;
  if (!Array.isArray(list) || list.length > MAX_BETS_PER_PLAYER || !list.every(isBet)) return null;
  if (!ofIncarnation(t, held, at)) return null;
  const bets = list as B[];
  if (!held) {
    // The stickman's prune of an earlier build's list (pruneCrapsBets) says
    // so; that build writes its own lists afresh, never with the mark.
    if (t.pruned !== undefined && !(Number.isSafeInteger(t.pruned) && (t.pruned as number) >= 1)) return null;
    return {
      bets, taken: bets.reduce((n, b) => n + b.amount, 0), legacy: true,
      ...(t.pruned !== undefined ? { pruned: true } : {}),
    };
  }
  if (t.taken !== undefined && !(Number.isSafeInteger(t.taken) && (t.taken as number) > 0 && (t.taken as number) <= MAX_LIST_STAKE)) {
    return null;
  }
  if (t.base !== undefined && !(Number.isSafeInteger(t.base) && (t.base as number) >= 0)) return null;
  return {
    bets, taken: (t.taken as number | undefined) ?? 0, legacy: false,
    ...(t.base !== undefined ? { base: t.base as number } : {}),
  };
}

/** The incarnation of a table its lists must carry to play there: the live
 *  state's (none: no table up), and whether this build's lists carrying none
 *  still belong (`bare`: until the table has been removed under this id once,
 *  the only time a state with no incarnation, an earlier build's, can have
 *  been live while this build put lists down on it). */
interface Incarnation {
  inc: string | undefined;
  bare: boolean;
}

function incarnationOf(map: Y.Map<unknown>, tableId: string, s: { inc?: string } | null): Incarnation {
  return { inc: s?.inc, bare: !map.has(goneKey(tableId, '')) };
}

/** Whether a stored list was put down on the incarnation `at` of its table. A
 *  held list put down on a table that had one carries it, and one put down on
 *  an earlier build's state, which had none, goes with whichever is up until
 *  the table is removed. An earlier build's own list carries none and goes
 *  with whichever is up: such a page may still be betting. One this build's
 *  stickman pruned carries the incarnation it was pruned on. */
function ofIncarnation(t: { inc?: unknown }, held: boolean, at: Incarnation): boolean {
  if (t.inc === undefined) return held ? at.bare : true;
  return isTableIncField(t.inc) && t.inc === at.inc;
}

const stakeOf = (l: { bets: readonly { amount: number }[]; taken: number }): FeltStake => ({
  net: l.bets.reduce((n, b) => n + b.amount, 0) - l.taken,
  taken: l.taken,
});

/** A stored roulette list for its round (see storedList). */
function rouletteList(value: unknown, at: Incarnation): { round: number; bets: RouletteBet[]; taken: number } | null {
  const round = (value as { round?: unknown } | null)?.round;
  if (!Number.isInteger(round) || (round as number) < 1) return null;
  const list = storedList<RouletteBet>(value, isRouletteBet, at);
  if (!list || list.base !== undefined) return null;
  return { round: round as number, bets: list.bets, taken: list.taken };
}

/** A roulette list that plays the table's current round: that round's, before
 *  it settles. */
function liveRouletteList(
  map: Y.Map<unknown>, tableId: string, playerId: string, s: RouletteTableState | null,
): { bets: RouletteBet[]; taken: number } | null {
  if (!s || s.phase === 'settled') return null;
  const list = rouletteList(map.get(`bets:${tableId}:${playerId}`), incarnationOf(map, tableId, s));
  return list && list.round === s.round ? list : null;
}

export function readMyBets(tableId: string, playerId: string, round: number): RouletteBet[] {
  const map = ensureMap();
  const list = rouletteList(map.get(`bets:${tableId}:${playerId}`), incarnationOf(map, tableId, readTableState(tableId)));
  return list && list.round === round ? list.bets : [];
}

/** The bettor's own write of their list for `round`, its chips held on the
 *  felt. What an earlier build's list (or one rewritten from it) took goes on
 *  with the rewrite, so nothing is handed back twice. Only while the table
 *  is up: a list on no table would hold nothing. */
export function writeMyBets(tableId: string, playerId: string, round: number, bets: RouletteBet[]): void {
  const map = ensureMap();
  const s = readTableState(tableId);
  if (!s) return;
  const was = rouletteList(map.get(`bets:${tableId}:${playerId}`), incarnationOf(map, tableId, s));
  const taken = was && was.round === round ? was.taken : 0;
  boundDoc!.transact(() => {
    map.set(`bets:${tableId}:${playerId}`, {
      round, held: bets,
      ...(s.inc !== undefined ? { inc: s.inc } : {}),
      ...(taken > 0 ? { taken } : {}),
    });
    heldDirty = true;
  });
}

/** Every player's bets for THIS round of one table (the croupier's settle
 *  read; also drives the "on the felt" spectator totals). */
export function readAllBets(tableId: string, round: number): Record<string, RouletteBet[]> {
  const prefix = `bets:${tableId}:`;
  const out: Record<string, RouletteBet[]> = {};
  const map = ensureMap();
  const at = incarnationOf(map, tableId, readTableState(tableId));
  for (const [key, value] of map.entries()) {
    if (!key.startsWith(prefix)) continue;
    const list = rouletteList(value, at);
    if (!list || list.round !== round || list.bets.length === 0) continue;
    out[key.slice(prefix.length)] = list.bets;
  }
  return out;
}

/** What a player's list on a table holds on the felt and what of it was
 *  taken already, as it plays now (NO_STAKE when it doesn't): the settle
 *  charges the one and the removal refunds the other. */
export function feltStake(tableId: string, playerId: string): FeltStake {
  const map = ensureMap();
  const roulette = readTableState(tableId);
  if (roulette) {
    const list = liveRouletteList(map, tableId, playerId, roulette);
    return list ? stakeOf(list) : NO_STAKE;
  }
  const craps = readCrapsTableState(tableId);
  const list = craps ? crapsFelt(map, tableId, playerId, craps.inc) : null;
  return list ? stakeOf(list) : NO_STAKE;
}

/** feltStake for every player with a list on the table (empty ones too: a
 *  list emptied by a rewrite can still carry what it took). */
export function readFeltStakes(tableId: string): Record<string, FeltStake> {
  const map = ensureMap();
  const out: Record<string, FeltStake> = {};
  for (const prefix of [`bets:${tableId}:`, `kept:${tableId}:`]) {
    for (const key of map.keys()) {
      if (!key.startsWith(prefix)) continue;
      const pid = key.slice(prefix.length);
      if (out[pid]) continue;
      const stake = feltStake(tableId, pid);
      if (stake.net !== 0 || stake.taken !== 0) out[pid] = stake;
    }
  }
  return out;
}

// ── 🎲 Craps table state + bets (#69 G3) ─────────────────────────────────────
// Same casino-map keys as roulette (`table:<id>`, `bets:<id>:<pid>`) — a given
// table is one game, so the shapes never collide, and clearTableKeys /
// creditChips / the croupier heartbeat are already game-agnostic. Craps bets are
// NOT round-stamped: they carry across rolls. The player writes `bets:`; at
// each settle the stickman writes what stays up as `kept:<id>:<pid>`, so the
// two never write one key (see crapsFelt).

export function readCrapsTableState(tableId: string): CrapsTableState | null {
  const map = ensureMap();
  const value = map.get(`table:${tableId}`);
  return isCrapsTableState(value) && !removed(map, tableId, value) ? value : null;
}

/** Stickman-only in practice (the UI gates on the house predicate). */
export function writeCrapsTableState(tableId: string, state: CrapsTableState): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`table:${tableId}`, state);
    heldDirty = true;
  });
}

/** A player's own stored craps list (see storedList). */
function crapsOwnList(value: unknown, at: Incarnation): ReturnType<typeof storedList<CrapsBet>> {
  if ((value as { kind?: unknown } | null)?.kind !== 'craps') return null;
  return storedList<CrapsBet>(value, isCrapsBet, at);
}

/** What the stickman's settle of `round` left up of a player's list, and what
 *  of it an earlier build took (`taken`). */
function keptList(value: unknown, at: Incarnation): { round: number; bets: CrapsBet[]; taken: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const t = value as { round?: unknown; kept?: unknown; inc?: unknown; taken?: unknown };
  if (!Number.isSafeInteger(t.round) || (t.round as number) < 1) return null;
  if (!Array.isArray(t.kept) || t.kept.length > MAX_BETS_PER_PLAYER || !t.kept.every(isCrapsBet)) return null;
  if (t.inc === undefined ? !at.bare : t.inc !== at.inc) return null;
  if (t.taken !== undefined && !(Number.isSafeInteger(t.taken) && (t.taken as number) > 0 && (t.taken as number) <= MAX_LIST_STAKE)) {
    return null;
  }
  return { round: t.round as number, bets: t.kept as CrapsBet[], taken: (t.taken as number | undefined) ?? 0 };
}

/** What a craps settle's `kept` record still owes its player back: what an
 *  earlier build's bets it kept up had taken, once their table's removal
 *  came at the same moment as the settle and the doc kept the settle's
 *  outcome over the removal's (which refunded them). The record left behind
 *  owes it, in the player's chips, until the table's outcome record pays it
 *  as the removal would have (payKeptOwed), when the kept record goes. */
function keptOwed(
  map: Y.Map<unknown>, chips: Y.Map<unknown>, tableId: string, playerId: string, value: unknown,
): { inc: string; owed: number } | null {
  const inc = (value as { inc?: unknown } | null)?.inc;
  if (inc !== undefined && (typeof inc !== 'string' || !isTableIncField(inc))) return null;
  const kept = keptList(value, { inc, bare: inc === undefined });
  if (!kept || kept.taken === 0) return null;
  const at = inc ?? '';
  if (!map.has(goneKey(tableId, at))) return null;
  if (lastOutcome(chips, tableId, at, playerId).was?.ev === 'end') return null;
  return { inc: at, owed: kept.taken };
}

/** Pay what a player's kept record owes (keptOwed) as the removal's outcome,
 *  before the record is overwritten or deleted. Once paid, it owes nothing:
 *  two pages paying it at once pay one outcome. */
function payKeptOwed(map: Y.Map<unknown>, tableId: string, playerId: string): void {
  const due = keptOwed(map, ensureChips(), tableId, playerId, map.get(`kept:${tableId}:${playerId}`));
  if (due) creditTableOutcome(tableId, due.inc, 'end', playerId, due.owed);
}

/** 🎲 A player's craps bets as they play, of the two keys: their own list,
 *  unless the stickman has settled a roll since they wrote it, when what that
 *  settle left up (`kept`) plays instead. A list counts as written after the
 *  settle of roll `base - 1` (writeMyCrapsBets); an earlier build's list,
 *  which has no `base`, plays unless it is the stickman's prune of it
 *  (pruneCrapsBets), which plays only as the kept record: two pages settling
 *  one roll can each prune it, and the doc may keep one page's prune with
 *  the other's kept record and outcome. So a list written before a roll
 *  settled (a take-down that crossed the dice) never brings back bets the
 *  roll resolved: the edit is dropped, the felt stays as the roll left it. */
function crapsFelt(
  map: Y.Map<unknown>, tableId: string, playerId: string, inc: string | undefined,
): { bets: CrapsBet[]; taken: number } | null {
  const at = incarnationOf(map, tableId, { inc });
  const own = crapsOwnList(map.get(`bets:${tableId}:${playerId}`), at);
  const kept = keptList(map.get(`kept:${tableId}:${playerId}`), at);
  if (!kept) return own;
  const keep = { bets: kept.bets, taken: kept.taken };
  if (!own) return keep;
  if (!own.legacy) return own.base !== undefined && own.base > kept.round ? own : keep;
  return own.pruned ? keep : own;
}

export function readMyCrapsBets(tableId: string, playerId: string): CrapsBet[] {
  return crapsFelt(ensureMap(), tableId, playerId, readCrapsTableState(tableId)?.inc)?.bets ?? [];
}

/** The bettor's own write of their craps list, its chips held on the felt.
 *  `base` is the roll it is for (the next one once a roll has settled), and
 *  what an earlier build's list took goes on with it, as for writeMyBets.
 *  Only while the table is up. */
export function writeMyCrapsBets(tableId: string, playerId: string, bets: CrapsBet[]): void {
  const map = ensureMap();
  const s = readCrapsTableState(tableId);
  if (!s) return;
  const taken = crapsFelt(map, tableId, playerId, s.inc)?.taken ?? 0;
  const base = s.phase === 'settled' ? s.round + 1 : s.round;
  boundDoc!.transact(() => {
    map.set(`bets:${tableId}:${playerId}`, {
      kind: 'craps', held: bets, base,
      ...(s.inc !== undefined ? { inc: s.inc } : {}),
      ...(taken > 0 ? { taken } : {}),
    });
    heldDirty = true;
  });
}

/** The stickman's record, at the settle of `round`, of a player's bets that
 *  stay up (none: the roll resolved them all), held on the felt from then.
 *  This build's player's own list is never written: what an earlier build's
 *  list took is handed back, and the kept bets hold their chips. An earlier
 *  build's list is pruned where it lies, as earlier builds did, so its page
 *  reads the felt as the roll left it, and what it took of the bets that stay
 *  stays taken (`taken`); the prune is marked (`pruned`), and that page's
 *  own next write, which never is, plays as a new list. */
export function pruneCrapsBets(tableId: string, playerId: string, round: number, bets: CrapsBet[]): void {
  const map = ensureMap();
  const inc = readCrapsTableState(tableId)?.inc;
  const key = `bets:${tableId}:${playerId}`;
  const own = crapsOwnList(map.get(key), incarnationOf(map, tableId, { inc }));
  const taken = own?.legacy ? bets.reduce((n, b) => n + b.amount, 0) : 0;
  boundDoc!.transact(() => {
    payKeptOwed(map, tableId, playerId); // a record an earlier removal left
    if (own?.legacy) map.set(key, { kind: 'craps', bets, ...(inc !== undefined ? { inc } : {}), pruned: round });
    map.set(`kept:${tableId}:${playerId}`, {
      round, kept: bets,
      ...(inc !== undefined ? { inc } : {}),
      ...(taken > 0 ? { taken } : {}),
    });
    heldDirty = true;
  });
}

/** Every player's standing craps bets on one table (the stickman's settle read;
 *  also drives the "on the felt" spectator view). Empty lists are omitted. */
export function readAllCrapsBets(tableId: string): Record<string, CrapsBet[]> {
  const map = ensureMap();
  const out: Record<string, CrapsBet[]> = {};
  const inc = readCrapsTableState(tableId)?.inc;
  const pids = new Set<string>();
  for (const prefix of [`bets:${tableId}:`, `kept:${tableId}:`]) {
    for (const key of map.keys()) if (key.startsWith(prefix)) pids.add(key.slice(prefix.length));
  }
  for (const pid of pids) {
    const list = crapsFelt(map, tableId, pid, inc);
    if (list && list.bets.length > 0) out[pid] = list.bets;
  }
  return out;
}

// ── 🪙 Stakes on the felt (see STAKES ON THE FELT above) ─────────────────────

/** Chips each player has held on felts, summed from the lists themselves
 *  (countHeldStakes). */
let heldStakes = new Map<string, bigint>();
/** The sums as listeners last heard them (what a recount is compared with). */
let heldHeard = new Map<string, bigint>();
/** A local write to a table or a list since the last count. */
let heldDirty = true;
/** Players whose held chips changed since the last notify. */
const heldTouched = new Set<string>();

/** The table whose id a key carries after its prefix (the longest of `ids`
 *  that fits, should one id begin with another's). */
function tableOf(ids: Iterable<string>, rest: string): string | null {
  let tableId: string | null = null;
  for (const id of ids) {
    if (rest.startsWith(`${id}:`) && (tableId === null || id.length > tableId.length)) tableId = id;
  }
  return tableId;
}

/** Chips each player has held on felts (and, below 0, what kept records left
 *  by a removal owe them back: keptOwed). */
function countHeldStakes(map: Y.Map<unknown>, chips: Y.Map<unknown>): Map<string, bigint> {
  const tables = new Map<string, RouletteTableState | CrapsTableState>();
  const gone = new Set<string>();
  for (const [key, value] of map.entries()) {
    if (key.startsWith('gone:') && key.endsWith(':')) gone.add(key.slice('gone:'.length, -1));
    if (!key.startsWith('table:')) continue;
    const tableId = key.slice('table:'.length);
    if ((isRouletteTableState(value) || isCrapsTableState(value)) && !removed(map, tableId, value)) {
      tables.set(tableId, value);
    }
  }
  const out = new Map<string, bigint>();
  if (tables.size === 0 && gone.size === 0) return out;
  const seen = new Set<string>();
  for (const [key, value] of map.entries()) {
    const prefix = key.startsWith('bets:') ? 'bets:' : key.startsWith('kept:') ? 'kept:' : null;
    if (prefix === null) continue;
    const rest = key.slice(prefix.length);
    const removedId = prefix === 'kept:' ? tableOf(gone, rest) : null;
    if (removedId !== null) {
      const pid = rest.slice(removedId.length + 1);
      const due = keptOwed(map, chips, removedId, pid, value);
      if (due) out.set(pid, (out.get(pid) ?? 0n) - BigInt(due.owed));
    }
    const tableId = tableOf(tables.keys(), rest);
    if (tableId === null) continue;
    const pid = rest.slice(tableId.length + 1);
    // A craps player's two keys make one felt: count it once.
    if (seen.has(`${tableId}:${pid}`)) continue;
    seen.add(`${tableId}:${pid}`);
    const s = tables.get(tableId)!;
    const list = s.kind === 'craps' ? crapsFelt(map, tableId, pid, s.inc) : liveRouletteList(map, tableId, pid, s);
    if (!list) continue;
    const net = stakeOf(list).net;
    if (net !== 0) out.set(pid, (out.get(pid) ?? 0n) + BigInt(net));
  }
  return out;
}

function heldStake(playerId: string): bigint {
  if (heldDirty) {
    heldStakes = countHeldStakes(ensureMap(), ensureChips());
    heldDirty = false;
  }
  return heldStakes.get(playerId) ?? 0n;
}

/** Recount the held chips before any observer runs whenever a transaction
 *  touched a table or a list, and note whose changed for their listeners. */
function bindHeldStakes(doc: Y.Doc, map: Y.Map<unknown>): void {
  const chips = doc.getMap<unknown>('casinoChips');
  heldStakes = countHeldStakes(map, chips);
  heldHeard = heldStakes;
  heldDirty = false;
  heldTouched.clear();
  doc.on('beforeObserverCalls', (tr: Y.Transaction) => {
    if (casinoMap !== map) return; // a binding we've moved off
    const keys = tr.changed.get(map as unknown as Y.AbstractType<Y.YEvent<any>>);
    const counts = (k: string | null): boolean =>
      k !== null && (k.startsWith('table:') || k.startsWith('bets:') || k.startsWith('kept:') || k.startsWith('gone:'));
    // A table's outcome record too: a removal's ends what kept bets owe.
    const outcomes = tr.changed.get(chips as unknown as Y.AbstractType<Y.YEvent<any>>);
    const ends = (k: string | null): boolean => k !== null && k.startsWith('tbl:');
    if (!(keys && [...keys].some(counts)) && !(outcomes && [...outcomes].some(ends))) return;
    const fresh = countHeldStakes(map, chips);
    for (const pid of new Set([...fresh.keys(), ...heldHeard.keys()])) {
      if ((fresh.get(pid) ?? 0n) !== (heldHeard.get(pid) ?? 0n)) heldTouched.add(pid);
    }
    heldStakes = fresh;
    heldHeard = fresh;
    heldDirty = false;
  });
}

// ── 🎲🎡 #226: who stands where, and the shooter's throw ─────────────────────
// A player at a table writes `seat:<tableId>:<pid>` while they are focused
// there: which stand they took (so their chips sit in front of them on every
// client) and the stand's angle round the table (the clockwise order the dice
// travel in). `at` is refreshed every few seconds — the operator treats a seat
// whose `at` stops changing as gone, on ITS OWN clock (see crapsCroupier), so
// a crashed page cannot hold the dice forever.

export interface TableSeat {
  /** Index into the table's stand list. */
  stand: number;
  /** atan2(z, x) of the stand in the table's local frame. */
  angle: number;
  /** The writer's clock at the last refresh (only ever compared to itself). */
  at: number;
}

function isTableSeat(v: unknown): v is TableSeat {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<TableSeat>;
  return Number.isInteger(s.stand) && (s.stand as number) >= 0 && (s.stand as number) < 32
    && typeof s.angle === 'number' && Number.isFinite(s.angle)
    && typeof s.at === 'number' && Number.isFinite(s.at);
}

export function writeMySeat(tableId: string, playerId: string, seat: TableSeat): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`seat:${tableId}:${playerId}`, seat);
  });
}

export function clearMySeat(tableId: string, playerId: string): void {
  const map = ensureMap();
  if (!map.has(`seat:${tableId}:${playerId}`)) return;
  boundDoc!.transact(() => {
    map.delete(`seat:${tableId}:${playerId}`);
  });
}

/** One player's seat on one table (a keyed read — no scan). */
export function readSeat(tableId: string, playerId: string): TableSeat | null {
  const v = ensureMap().get(`seat:${tableId}:${playerId}`);
  return isTableSeat(v) ? v : null;
}

/** Every seat record on one table, playerId → seat (freshness is the
 *  reader's call — the operator's, or the renderer's "anyone here?"). */
export function readSeats(tableId: string): Record<string, TableSeat> {
  const prefix = `seat:${tableId}:`;
  const out: Record<string, TableSeat> = {};
  for (const [key, value] of ensureMap().entries()) {
    if (!key.startsWith(prefix) || !isTableSeat(value)) continue;
    const pid = key.slice(prefix.length);
    // The key is peer-written too: a seat whose player id the table state
    // can't hold (isCrapsTableState's 1–128 chars) could never be the
    // shooter, so it isn't a seat.
    if (pid.length === 0 || pid.length > 128) continue;
    out[pid] = value;
  }
  return out;
}

/** 🎲 One throw of the dice: who threw on which roll, from where and how hard
 *  (table-local felt coords, a unit direction, power 0..1) and the tumble
 *  seed. COSMETIC — the dice faces come from the table's fairness mode at the
 *  settle; this only lets every client animate the same fling. */
export interface DiceThrow {
  round: number;
  /** The shooter's player id, or 'stickman'. */
  by: string;
  sx: number;
  sz: number;
  dx: number;
  dz: number;
  power: number;
  seed: number;
}

function isDiceThrow(v: unknown): v is DiceThrow {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Partial<DiceThrow>;
  const fin = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100;
  return Number.isInteger(t.round) && (t.round as number) >= 1
    && typeof t.by === 'string' && t.by.length > 0 && t.by.length <= 128
    && fin(t.sx) && fin(t.sz) && fin(t.dx) && fin(t.dz)
    && typeof t.power === 'number' && t.power >= 0 && t.power <= 1
    && Number.isInteger(t.seed);
}

export function readDiceThrow(tableId: string): DiceThrow | null {
  const v = ensureMap().get(`throw:${tableId}`);
  return isDiceThrow(v) ? v : null;
}

export function writeDiceThrow(tableId: string, t: DiceThrow): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`throw:${tableId}`, t);
  });
}

// ── 🎲🔗 Craps settlement backend preference (#69 G5 seam) ────────────────────
// Which backend settles a craps table — 'local' (crypto RNG + these room-doc
// chips, the default) or 'chia' (per-player↔house state channels + a shared
// beacon-anchored dice; see brainstorming/craps-chia-backend-plan.md). Owner-set,
// synced so every client agrees which backend the elected operator runs. Plain
// string in the casino map (`cfg:backend:<tableId>`); a bad/absent value reads as
// 'local', so legacy tables and un-set tables behave exactly as before.

export type CrapsBackendKind = 'local' | 'chia';

export function readCrapsBackendPref(tableId: string): CrapsBackendKind {
  return ensureMap().get(`cfg:backend:${tableId}`) === 'chia' ? 'chia' : 'local';
}

export function writeCrapsBackendPref(tableId: string, kind: CrapsBackendKind): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`cfg:backend:${tableId}`, kind === 'chia' ? 'chia' : 'local');
  });
}

// 🎲🔀 Per-table dice-fairness MODE override (dev phase, plan §fairness modes) —
// which strategy produces this table's dice (see games/diceFairness.ts). Owner-set
// + synced so every client agrees. Absent ⇒ the global default (getCrapsFairnessMode).

const FAIRNESS_MODES: readonly FairnessMode[] = [
  'rng', 'commit-reveal', 'multiparty', 'block-beacon',
];

export function readCrapsFairnessPref(tableId: string): FairnessMode | null {
  const v = ensureMap().get(`cfg:fairness:${tableId}`);
  return typeof v === 'string' && (FAIRNESS_MODES as readonly string[]).includes(v)
    ? (v as FairnessMode)
    : null;
}

export function writeCrapsFairnessPref(tableId: string, mode: FairnessMode): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`cfg:fairness:${tableId}`, mode);
  });
}

// ── ⚖️ Fair-table seed records (craps + roulette multiparty) ──────────────────
// Each bettor's own `fseed:<tableId>:<pid>` (only that player's client writes
// it): its commitment for one round, bound to the round number AND the house
// commit so it can never be replayed into another round, plus the revealed
// seed once "no more bets" froze the commit set. See fairTableSeeds.ts.

export interface TableSeedRecord {
  round: number;
  /** The table's houseCommit this commitment answers. */
  house: string;
  commit: string;
  /** The revealed seed — absent until the commit set is frozen. */
  seed?: string;
  /** The bettor's identity-key signature over the commitment (base64url,
   *  fairTableSeeds.seedSigBytes): a record without a valid one is no party. */
  sig?: string;
}

function isTableSeedRecord(v: unknown): v is TableSeedRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<TableSeedRecord>;
  const hex = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 128;
  return Number.isInteger(r.round) && (r.round as number) >= 1
    && hex(r.house) && hex(r.commit)
    && (r.seed === undefined || hex(r.seed))
    && (r.sig === undefined || hex(r.sig));
}

export function readSeedRecord(tableId: string, playerId: string): TableSeedRecord | null {
  const v = ensureMap().get(`fseed:${tableId}:${playerId}`);
  return isTableSeedRecord(v) ? v : null;
}

// ⚖️ Each player's identity key as THIS page first saw it in the bound room
// (trust on first use): pinned the moment the players map shows it — at bind,
// then as entries sync or arrive — so a later rewrite of players[pid].keyB64
// can't hand a player's seat to another key. Pins last as long as the doc
// binding and are never evicted; past the cap, new players simply go unpinned
// (and so can't add a signed seed) rather than unseat anyone.
const MAX_PINNED_KEYS = 4096;
let pinnedKeys = new Map<string, string>();

function entryKey(v: unknown): string | undefined {
  const k = (v as { keyB64?: unknown } | undefined)?.keyB64;
  return typeof k === 'string' && k.length > 0 && k.length <= 128 ? k : undefined;
}

function pinPlayerKeys(doc: Y.Doc): void {
  const pins = new Map<string, string>();
  pinnedKeys = pins;
  const players = doc.getMap('players');
  const pin = (pid: string, v: unknown): void => {
    if (pins.has(pid) || pins.size >= MAX_PINNED_KEYS || pid.length === 0 || pid.length > 128) return;
    const k = entryKey(v);
    if (k) pins.set(pid, k);
  };
  players.forEach((v, pid) => pin(pid, v));
  players.observe((e) => {
    for (const pid of e.keysChanged) pin(pid, players.get(pid));
  });
}

/** A player's identity key as this page first saw it in the room's players
 *  map (the same base64url string keypair.getIdentityPub writes), or
 *  undefined while none has shown up. */
export function readPlayerKey(playerId: string): string | undefined {
  if (!docAlive() || !boundDoc) return undefined;
  return pinnedKeys.get(playerId);
}

export function writeMySeedRecord(tableId: string, playerId: string, rec: TableSeedRecord): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`fseed:${tableId}:${playerId}`, rec);
  });
}

// ── 🎰 Slot machine state + odds (#109) ──────────────────────────────────────
// Each slot machine has an independent state (`slot:<machineId>`) and an
// optional owner-override paytable (`slot-odds:<machineId>`). Both are
// whole-value LWW keys on the casino map — the same discipline as roulette /
// craps. The machine owner (or their croupier bot) writes the state; any player
// reads it. An absent odds config falls back to DEFAULT_PAYTABLE (see
// games/slots.ts) so un-configured machines work immediately on placement.

export function readSlotMachineState(machineId: string): SlotMachineState | null {
  const value = ensureMap().get(`slot:${machineId}`);
  return isSlotMachineState(value) ? value : null;
}

/** Machine owner / croupier bot only. */
export function writeSlotMachineState(machineId: string, state: SlotMachineState): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`slot:${machineId}`, state);
  });
}

/**
 * Run several casino writes as one transaction, so a peer sees all of them or
 * none (the writes' own transactions nest inside it). Returns what `writes`
 * returns.
 */
export function transactCasino<T>(writes: () => T): T {
  ensureMap();
  let result!: T;
  boundDoc!.transact(() => {
    result = writes();
  });
  return result;
}

export function readSlotPlayRequests(machineId: string): SlotPlayRequest[] {
  const prefix = `slot-request:${machineId}:`;
  const requests: SlotPlayRequest[] = [];
  for (const [key, value] of ensureMap().entries()) {
    if (!key.startsWith(prefix) || !isSlotPlayRequest(value)) continue;
    if (value.player !== key.slice(prefix.length)) continue;
    requests.push(value);
  }
  return requests.sort((a, b) => a.requestId.localeCompare(b.requestId));
}

export function writeSlotPlayRequest(machineId: string, request: SlotPlayRequest): void {
  ensureMap().set(`slot-request:${machineId}:${request.player}`, request);
}

export function clearSlotPlayRequest(machineId: string, playerId: string): void {
  ensureMap().delete(`slot-request:${machineId}:${playerId}`);
}

export function readSlotReveal(machineId: string, playerId: string): SlotReveal | null {
  const value = ensureMap().get(`slot-reveal:${machineId}:${playerId}`);
  return isSlotReveal(value) ? value : null;
}

export function writeSlotReveal(machineId: string, playerId: string, reveal: SlotReveal): void {
  ensureMap().set(`slot-reveal:${machineId}:${playerId}`, reveal);
}

export function clearSlotReveal(machineId: string, playerId: string): void {
  ensureMap().delete(`slot-reveal:${machineId}:${playerId}`);
}

export function readSlotOddsConfig(machineId: string): SlotOddsConfig | null {
  const value = ensureMap().get(`slot-odds:${machineId}`);
  return isSlotOddsConfig(value) ? value : null;
}

/** Room owner only — sets the paytable shown on the machine face. */
export function writeSlotOddsConfig(machineId: string, config: SlotOddsConfig): void {
  if (!isSlotOddsConfig(config)) return;
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`slot-odds:${machineId}`, config);
  });
}

export function readSlotFundingConfig(machineId: string): SlotFundingConfig | null {
  const value = ensureMap().get(`slot-funding:${machineId}`);
  return isSlotFundingConfig(value) ? value : null;
}

/** Room owner only — selects which chip bankroll backs this machine. */
export function writeSlotFundingConfig(
  machineId: string,
  config: SlotFundingConfig,
): void {
  if (!isSlotFundingConfig(config)) return;
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`slot-funding:${machineId}`, config);
  });
}

export interface SlotOperatorLease {
  playerId: string;
  sessionId: string;
  expiresAt: number;
  /** The room's lease only: a fresh token each time a session takes it, kept
   *  across its renewals, so a peer tells a new take from a renewal even when
   *  it never saw the lease go. Earlier builds' per-machine leases have none. */
  tenure?: string;
}

function isSlotOperatorLease(value: unknown): value is SlotOperatorLease {
  if (typeof value !== 'object' || value === null) return false;
  const lease = value as Partial<SlotOperatorLease>;
  return typeof lease.playerId === 'string' && lease.playerId.length > 0
    && lease.playerId.length <= 128
    && typeof lease.sessionId === 'string' && lease.sessionId.length > 0
    && lease.sessionId.length <= 128
    && typeof lease.expiresAt === 'number' && Number.isFinite(lease.expiresAt)
    && (lease.tenure === undefined
      || (typeof lease.tenure === 'string' && lease.tenure.length > 0 && lease.tenure.length <= 64));
}

/** 🎰 The room's slot operator lease: ONE session operates every slot machine
 *  in the room (slotCroupier.ts), so each machine has one writer. */
export const SLOT_OPERATOR_KEY = 'slot-operator';

export function readSlotOperatorLease(): SlotOperatorLease | null {
  const value = ensureMap().get(SLOT_OPERATOR_KEY);
  return isSlotOperatorLease(value) ? value : null;
}

export function writeSlotOperatorLease(lease: SlotOperatorLease): void {
  if (!isSlotOperatorLease(lease)) return;
  ensureMap().set(SLOT_OPERATOR_KEY, lease);
}

export function clearSlotOperatorLease(): void {
  ensureMap().delete(SLOT_OPERATOR_KEY);
}

/** The per-machine lease (`slot-operator:<mid>`) that builds before the
 *  room's lease took. This build never writes one: while one is being
 *  renewed, an earlier build is operating that machine (slotCroupier.ts,
 *  EARLIER BUILDS). */
export function readLegacySlotOperatorLease(machineId: string): SlotOperatorLease | null {
  const value = ensureMap().get(`slot-operator:${machineId}`);
  return isSlotOperatorLease(value) ? value : null;
}

export function clearLegacySlotOperatorLease(machineId: string): void {
  ensureMap().delete(`slot-operator:${machineId}`);
}

/** The machines each bound map holds an earlier build's per-machine lease
 *  for, kept current from the keys each transaction changed. The slot
 *  operator asks before every write whether an earlier build is operating in
 *  the room, whatever machines the room's layout listed at the last frame,
 *  and never walks the map to find out. Only a key holding a lease record
 *  counts: anything else under the prefix is no lease (as
 *  readLegacySlotOperatorLease reads it), so it neither holds the room off
 *  nor takes a place under the read cap. */
const legacySlotLeaseMachines = new WeakMap<Y.Map<unknown>, Set<string>>();

/** Build a map's index in one pass (when it is bound, while a joined doc is
 *  usually still empty), then keep it by an observer. */
function indexLegacySlotLeases(map: Y.Map<unknown>): void {
  if (legacySlotLeaseMachines.has(map)) return;
  const prefix = `${SLOT_OPERATOR_KEY}:`;
  const machines = new Set<string>();
  const file = (key: string): void => {
    const machineId = key.slice(prefix.length);
    if (isSlotOperatorLease(map.get(key))) machines.add(machineId);
    else machines.delete(machineId);
  };
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) file(key);
  }
  legacySlotLeaseMachines.set(map, machines);
  map.observe((event) => {
    for (const key of event.keysChanged) {
      if (key.startsWith(prefix)) file(key);
    }
  });
}

/** How many of the earlier builds' leases one read returns. Any peer can
 *  write `slot-operator:` keys, so this bounds the work they can make each
 *  frame do. A room holding more is kept off anyway (slotCroupier.ts, EARLIER
 *  BUILDS): one of those left unread may be live. */
export const LEGACY_SLOT_LEASE_READ_CAP = 64;

/** The machines an earlier build's lease (`slot-operator:<mid>`) is held for
 *  in the bound map, read from the index built when it was bound: at most
 *  LEGACY_SLOT_LEASE_READ_CAP of them, in the order their records appeared,
 *  and whether the map holds more. */
export function readLegacySlotOperatorMachineIds(): { machineIds: string[]; more: boolean } {
  const machineIds: string[] = [];
  for (const machineId of legacySlotLeaseMachines.get(ensureMap()) ?? []) {
    if (machineIds.length === LEGACY_SLOT_LEASE_READ_CAP) return { machineIds, more: true };
    machineIds.push(machineId);
  }
  return { machineIds, more: false };
}

/** Whether a round's reserve is locked on this machine (`slot-escrow:<mid>`). */
export function hasSlotEscrow(machineId: string): boolean {
  return ensureMap().has(`slot-escrow:${machineId}`);
}

/** Whether a machine still holds chips a teardown would pay out: a round's
 *  escrow, or its own bankroll (`slot-bankroll:machine:<mid>`). */
export function slotMachineHoldsChips(machineId: string): boolean {
  const map = ensureMap();
  return map.has(`slot-escrow:${machineId}`)
    || readAccount(map, `slot-bankroll:machine:${machineId}`) > 0;
}

export interface SlotSharedBankrollLease {
  machineId: string;
  token: string;
  expiresAt: number;
}

const SHARED_BANKROLL_LEASE_KEY = 'slot-bankroll:shared-lease';
const SHARED_BANKROLL_LEASE_MS = 45_000;
const SHARED_BANKROLL_LEASE_SETTLE_MS = 2_000;

function isSlotSharedBankrollLease(value: unknown): value is SlotSharedBankrollLease {
  if (typeof value !== 'object' || value === null) return false;
  const lease = value as Partial<SlotSharedBankrollLease>;
  return typeof lease.machineId === 'string' && lease.machineId.length > 0
    && lease.machineId.length <= 128
    && typeof lease.token === 'string' && lease.token.length > 0
    && lease.token.length <= 384
    && typeof lease.expiresAt === 'number' && Number.isFinite(lease.expiresAt);
}

export function readSlotSharedBankrollLease(): SlotSharedBankrollLease | null {
  const value = ensureMap().get(SHARED_BANKROLL_LEASE_KEY);
  return isSlotSharedBankrollLease(value) ? value : null;
}

export function ownsSlotSharedBankrollLease(machineId: string, token: string): boolean {
  const lease = readSlotSharedBankrollLease();
  return lease?.machineId === machineId
    && lease.token === token
    && lease.expiresAt > Date.now();
}

/**
 * Legacy shared-bankroll lease record retained only to inspect/clear persisted
 * pre-gate rounds. It is NOT a distributed mutex and never authorizes money
 * mutation; shared reserve/settle/refund paths are disabled below.
 */
export async function acquireSlotSharedBankrollLease(
  machineId: string,
  token: string,
): Promise<boolean> {
  const current = readSlotSharedBankrollLease();
  if (current && current.expiresAt > Date.now() && current.token !== token) return false;
  ensureMap().set(SHARED_BANKROLL_LEASE_KEY, {
    machineId,
    token,
    expiresAt: Date.now() + SHARED_BANKROLL_LEASE_MS,
  } satisfies SlotSharedBankrollLease);
  await new Promise<void>((resolve) => setTimeout(resolve, SHARED_BANKROLL_LEASE_SETTLE_MS));
  return ownsSlotSharedBankrollLease(machineId, token);
}

export function releaseSlotSharedBankrollLease(machineId: string, token: string): void {
  if (ownsSlotSharedBankrollLease(machineId, token)) {
    ensureMap().delete(SHARED_BANKROLL_LEASE_KEY);
  }
}

function slotFundingBalanceKey(
  machineId: string,
  config: SlotFundingConfig,
): string {
  if (config.mode === 'owner') return `bal:${config.ownerId}`;
  if (config.mode === 'machine') return `${BANKROLL_PREFIX}${machineId}`;
  return SHARED_BANKROLL_KEY;
}

function safeCount(map: Y.Map<unknown>, key: string): number {
  const value = map.get(key);
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

export function readSlotFundingBalance(
  machineId: string,
  config: SlotFundingConfig,
): number {
  if (!isSlotFundingConfig(config)) return 0;
  return readAccount(ensureMap(), slotFundingBalanceKey(machineId, config));
}

/** Move the owner's chips into a dedicated/shared bankroll. */
export function depositSlotFunding(
  machineId: string,
  ownerId: string,
  amount: number,
): boolean {
  const config = readSlotFundingConfig(machineId);
  if (!config || config.ownerId !== ownerId || config.mode === 'owner'
    || !Number.isSafeInteger(amount) || amount <= 0) return false;
  // A Y.Map lease cannot serialize money during a partition. Keep legacy
  // shared balances withdrawable, but do not allow new shared funding.
  if (config.mode === 'shared') return false;
  const map = ensureMap();
  const fundingKey = slotFundingBalanceKey(machineId, config);
  const ownerBalance = readChips(ownerId);
  const fundingBalance = readAccount(map, fundingKey);
  if (ownerBalance < amount || !Number.isSafeInteger(fundingBalance + amount)) return false;
  boundDoc!.transact(() => {
    addChips(ownerId, -amount);
    writeAccount(map, fundingKey, fundingBalance, fundingBalance + amount);
  });
  return true;
}

/** Return chips from a dedicated/shared bankroll to its owner. */
export function withdrawSlotFunding(
  machineId: string,
  ownerId: string,
  amount: number,
): boolean {
  const config = readSlotFundingConfig(machineId);
  if (!config || config.ownerId !== ownerId || config.mode === 'owner'
    || !Number.isSafeInteger(amount) || amount <= 0) return false;
  const sharedLease = config.mode === 'shared' ? readSlotSharedBankrollLease() : null;
  if (sharedLease && sharedLease.expiresAt > Date.now()) return false;
  const map = ensureMap();
  const fundingKey = slotFundingBalanceKey(machineId, config);
  const ownerBalance = readChips(ownerId);
  const fundingBalance = readAccount(map, fundingKey);
  if (fundingBalance < amount || !Number.isSafeInteger(ownerBalance + amount)) return false;
  boundDoc!.transact(() => {
    writeAccount(map, fundingKey, fundingBalance, fundingBalance - amount);
    addChips(ownerId, amount);
  });
  return true;
}

export type SlotReserveResult =
  | 'ok'
  | 'insufficient-player-funds'
  | 'insufficient-bankroll'
  | 'shared-funding-unavailable';

/**
 * Debit the stake, add it to the selected bankroll, and lock the round's
 * maximum payout in a per-machine escrow. Shared bankrolls additionally require
 * the room-wide lease so reservations and settlements cannot lose CRDT updates.
 */
export function reserveSlotWager(
  machineId: string,
  playerId: string,
  bet: number,
  config: SlotFundingConfig,
  maximumPayout: number,
): SlotReserveResult {
  if (config.mode === 'shared') return 'shared-funding-unavailable';
  if (!isSlotFundingConfig(config)
    || !Number.isSafeInteger(bet) || bet <= 0
    || !Number.isSafeInteger(maximumPayout) || maximumPayout < 0) {
    return 'insufficient-bankroll';
  }
  const map = ensureMap();
  const playerKey = `bal:${playerId}`;
  const fundingKey = slotFundingBalanceKey(machineId, config);
  const escrowKey = `slot-escrow:${machineId}`;
  const playerBalance = readChips(playerId);
  if (playerBalance < bet) return 'insufficient-player-funds';
  if (safeCount(map, escrowKey) > 0) return 'insufficient-bankroll';
  // A bankroll in overdraft (two withdrawals of the same chips at once) takes
  // no spin until it is refilled, whatever the paytable.
  const fundingAccount = fundingKey.startsWith('bal:') ? fundingKey.slice(4) : fundingKey;
  if (ledgerTotal(fundingAccount) < 0n) return 'insufficient-bankroll';

  const sameAccount = playerKey === fundingKey;
  const fundingBalance = readAccount(map, fundingKey);
  const afterStake = sameAccount ? fundingBalance : fundingBalance + bet;
  if (!Number.isSafeInteger(afterStake) || afterStake < maximumPayout) {
    return 'insufficient-bankroll';
  }

  boundDoc!.transact(() => {
    if (!sameAccount) addChips(playerId, -bet);
    writeAccount(map, fundingKey, fundingBalance, afterStake - maximumPayout);
    map.set(escrowKey, maximumPayout);
  });
  return 'ok';
}

/**
 * Pay a settled result from escrow and return the unused reserve to the
 * selected bankroll. Returns false for shared funding or if peer-written state
 * exceeds the reserve.
 */
export function settleSlotWager(
  machineId: string,
  playerId: string,
  config: SlotFundingConfig,
  payout: number,
  _sharedLeaseToken?: string,
): boolean {
  if (config.mode === 'shared') return false;
  if (!isSlotFundingConfig(config)
    || !Number.isSafeInteger(payout) || payout < 0
  ) return false;
  const map = ensureMap();
  const escrowKey = `slot-escrow:${machineId}`;
  if (!map.has(escrowKey)) return false;
  const escrow = safeCount(map, escrowKey);
  if (payout > escrow) return false;
  const fundingKey = slotFundingBalanceKey(machineId, config);
  const playerKey = `bal:${playerId}`;
  const fundingBalance = readAccount(map, fundingKey);
  const playerBalance = readChips(playerId);
  const returned = escrow - payout;
  const sameAccount = fundingKey === playerKey;
  const nextFunding = fundingBalance + returned + (sameAccount ? payout : 0);
  const nextPlayer = playerBalance + payout;
  if (!Number.isSafeInteger(nextFunding)
    || (!sameAccount && !Number.isSafeInteger(nextPlayer))) return false;
  boundDoc!.transact(() => {
    map.delete(escrowKey);
    writeAccount(map, fundingKey, fundingBalance, nextFunding);
    if (!sameAccount && payout > 0) addChips(playerId, payout);
  });
  return true;
}

/** Cancel a non-shared round and return both its reserve and stake. */
export function refundSlotWager(
  machineId: string,
  playerId: string,
  bet: number,
  config: SlotFundingConfig,
  _sharedLeaseToken?: string,
): boolean {
  if (config.mode === 'shared') return false;
  if (!isSlotFundingConfig(config) || !Number.isSafeInteger(bet) || bet <= 0
  ) return false;
  const map = ensureMap();
  const escrowKey = `slot-escrow:${machineId}`;
  if (!map.has(escrowKey)) return false;
  const escrow = safeCount(map, escrowKey);
  const fundingKey = slotFundingBalanceKey(machineId, config);
  const playerKey = `bal:${playerId}`;
  const fundingBalance = readAccount(map, fundingKey);
  const playerBalance = readChips(playerId);
  const sameAccount = fundingKey === playerKey;
  if (!sameAccount && fundingBalance + escrow < bet) return false;
  const nextFunding = sameAccount
    ? fundingBalance + escrow
    : fundingBalance + escrow - bet;
  const nextPlayer = sameAccount ? nextFunding : playerBalance + bet;
  if (!Number.isSafeInteger(nextFunding) || !Number.isSafeInteger(nextPlayer)) return false;
  boundDoc!.transact(() => {
    map.delete(escrowKey);
    writeAccount(map, fundingKey, fundingBalance, nextFunding);
    if (!sameAccount) addChips(playerId, bet);
  });
  return true;
}

/** Return a removed machine's private bankroll to the configured owner.
 *  False when it holds chips that can't be paid out (no owner to pay, more
 *  than the safe range, or the owner's balance can't take them): nothing is
 *  written then. */
export function drainSlotMachineFunding(machineId: string): boolean {
  const fundingKey = `${BANKROLL_PREFIX}${machineId}`;
  const total = ledgerTotal(fundingKey);
  if (total <= 0n) return true;
  const config = readSlotFundingConfig(machineId);
  if (!config || total > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const amount = Number(total);
  const ownerBalance = readChips(config.ownerId);
  if (!Number.isSafeInteger(ownerBalance + amount)) return false;
  boundDoc!.transact(() => {
    addChips(fundingKey, -amount);
    addChips(config.ownerId, amount);
  });
  return true;
}

/** Remove all casino-map keys for a slot machine (teardown on item removal). */
export function clearSlotMachineKeys(machineId: string): void {
  const map = ensureMap();
  const requestPrefix = `slot-request:${machineId}:`;
  const revealPrefix = `slot-reveal:${machineId}:`;
  boundDoc!.transact(() => {
    map.delete(`slot:${machineId}`);
    map.delete(`slot-odds:${machineId}`);
    map.delete(`slot-funding:${machineId}`);
    map.delete(`slot-operator:${machineId}`);
    // The bankroll's stored value stays: it is its ledger account's opening
    // balance, which the records already drawn against it assume.
    map.delete(`slot-escrow:${machineId}`);
    const sharedLease = readSlotSharedBankrollLease();
    if (sharedLease?.machineId === machineId) map.delete(SHARED_BANKROLL_LEASE_KEY);
    for (const key of [...map.keys()]) {
      if (key.startsWith(requestPrefix) || key.startsWith(revealPrefix)) map.delete(key);
    }
  });
}

// ── 🪙 Coin pusher (#135) ────────────────────────────────────────────────────
// Each machine is one operator-written record plus small request keys — the
// slot-croupier pattern (pusherCroupier.ts is the operator):
//
//   pusher:<mid>            → CoinPusherState   (operator-written only)
//   pusher-req:<mid>:<pid>  → PusherInsertRequest (the player's own key: hole +
//                             the pusher phase they saw; carries NO chips)
//   pusher-result:<mid>:<pid> → PusherResult    (the operator's answer to that
//                             player's latest request — durable, unlike the
//                             machine-wide lastDrop the next drop overwrites)
//   pusher-empty:<mid>      → PusherEmptyRequest (the owner's door request)
//   pusher-door:<mid>       → PusherDoorResult  (the operator's answer to it)
//   pusher-operator         → the room's operator lease (ONE browser session
//                             operates every coin pusher in the room, so a
//                             player's balance has a single pusher writer)
//
// In the per-player keys each id is escaped (`%` → `%25`, `:` → `%3A`; see
// coinPusherRequestKey), so a key splits one way only whatever the ids hold:
// `(a, b:p)` and `(a:b, p)` are different keys, and no machine's keys start
// with another's prefix. Ids with neither character (the UUID player ids,
// `<kind>-<n>` item ids) are written as they are.
//
// MONEY: a request is a wish, not a payment. The operator debits the player's
// one chip, credits exactly what the drop paid out, publishes the new machine
// and clears the request in ONE transaction (settleCoinPusherInsert). The
// owner's empty is the same shape (commitCoinPusherEmpty). Nothing is escrowed
// and nothing is claimed afterwards, so no peer-written record is ever taken
// as proof that chips moved, and a cancelled or abandoned request costs
// nothing. Every commit re-reads the stored machine and refuses when it is not
// the state the operator computed from (a lost update never double-counts).
//
// TRUST: the same dev-phase honest-client model as the rest of this map — the
// operator (the room's deed holder) is trusted to run the physics honestly;
// every read shape-guards so junk in these keys reads as "no machine". Chips
// only ever leave the machine to the player whose drop pushed them or to the
// operator itself (the door, a removed cabinet) — never to a party named in a
// peer-writable record, so forging the machine can't pay the forger. Nor are
// the requests authenticated: like every key in this map, a peer can write a
// request naming another player (a drop at that player's cost, paid to that
// player) or a door request naming the owner (the owner's own chips, back to
// the owner). That is no more than writing a chip record for that
// player, which any peer can already do; authenticated accounts come with the
// Registry chips.
//
// PARTITIONS: the operator lease is a Y.Map record, not a mutex; see
// pusherCroupier.ts for how a second session of the same deed holder is kept
// from operating while the first may only be cut off.

/** The room's coin-pusher operator lease: one for every cabinet in the room. */
export const COIN_PUSHER_OPERATOR_KEY = 'pusher-operator';

/** The slot operator's record, plus the holder's tenure: a fresh token each
 *  time a session takes the lease, kept across its renewals. A peer that
 *  never saw the lease go (a release and a retake between two of its frames)
 *  still tells a new tenure, with its settling wait, from a renewal. */
export interface CoinPusherOperatorLease extends SlotOperatorLease {
  tenure?: string;
}

function isCoinPusherOperatorLease(value: unknown): value is CoinPusherOperatorLease {
  if (!isSlotOperatorLease(value)) return false;
  const tenure = (value as { tenure?: unknown }).tenure;
  return tenure === undefined
    || (typeof tenure === 'string' && tenure.length > 0 && tenure.length <= 64);
}

export function readCoinPusherState(machineId: string): CoinPusherState | null {
  // Normalized, so a machine stored before the drop board reads with every
  // pile on the centre line.
  return normalizeCoinPusherState(ensureMap().get(`pusher:${machineId}`));
}

/** True when something is stored under `pusher:<mid>` that isn't a machine
 *  the guard accepts (junk, or a ledger that doesn't balance), which the
 *  panel reports rather than taking it for no machine at all. */
export function isCoinPusherRecordUnreadable(machineId: string): boolean {
  const map = ensureMap();
  const key = `pusher:${machineId}`;
  return map.has(key) && !isCoinPusherState(map.get(key));
}

/** Operator only (pusherCroupier.ts): create or re-own a machine. Writes the
 *  normalized state (unknown fields dropped); false when the shape guard
 *  rejects it. Drops and empties go through the settle helpers below. */
export function writeCoinPusherState(machineId: string, state: CoinPusherState): boolean {
  const normalized = normalizeCoinPusherState(state);
  if (!normalized) return false;
  ensureMap().set(`pusher:${machineId}`, normalized);
  return true;
}

/** How many of a machine's requests one read looks at. A player files one
 *  request per machine, so honest play stays far below it and is read exactly
 *  oldest first; a flood is worked through this many at a time, in arrival
 *  order, so none is starved. */
export const PUSHER_REQUEST_SCAN = 64;

// The operator polls a machine's requests ten times a second, and removing a
// cabinet deletes all of its per-player keys, so both go through an index
// rather than walking the casino map, which any peer can grow. Each bound map
// gets one index, built by a single pass when the map is bound (bindCasinoDoc
// — a join, where the doc is usually still empty, or the offline fallback)
// and from then on kept current by an observer that looks only at the keys
// each transaction changed, local or remote. No poll, and no removal, ever
// walks the map. The keys escape their ids, so each is filed under exactly
// one machine: the one it names.
interface PusherRequestIndex {
  /** machineId → the keys holding its well-formed requests, in arrival order,
   *  each with when this page filed it (Date.now(): its arrival here, on this
   *  page's clock). */
  byMachine: Map<string, Map<string, number>>;
  /** machineId → every per-player key naming that machine, whatever it holds
   *  (a removal sweeps them from here — see startCoinPusherKeySweep). */
  playerKeys: Map<string, Set<string>>;
}

const pusherRequestIndexes = new WeakMap<Y.Map<unknown>, PusherRequestIndex>();
const PUSHER_REQUEST_PREFIX = 'pusher-req:';
const PUSHER_RESULT_PREFIX = 'pusher-result:';
/** The per-player key families, each with how many ids follow it, the
 *  machine's first (`pusher-esc:<mid>:<pid>:<requestId>` is an earlier
 *  revision's escrow, still cleared with its machine). */
const PUSHER_PLAYER_FAMILIES: readonly (readonly [family: string, ids: number])[] = [
  [PUSHER_REQUEST_PREFIX, 2],
  [PUSHER_RESULT_PREFIX, 2],
  ['pusher-esc:', 3],
];

/** One id as a key component: `%` and `:` escaped, so the colons between
 *  components are the only ones in a key. */
function pusherKeyPart(id: string): string {
  return id.replace(/[%:]/g, (c) => (c === '%' ? '%25' : '%3A'));
}

/** The id a key component stands for, or null unless pusherKeyPart writes it
 *  exactly so (non-empty, every `%` starting `%25` or `%3A`). */
function pusherIdOf(part: string): string | null {
  const id = part.replace(/%(25|3A)/g, (_escape, code: string) => (code === '25' ? '%' : ':'));
  return id !== '' && pusherKeyPart(id) === part ? id : null;
}

/** `pusher-req:<mid>:<pid>`, the ids escaped: a player's request key. */
export function coinPusherRequestKey(machineId: string, playerId: string): string {
  return `${PUSHER_REQUEST_PREFIX}${pusherKeyPart(machineId)}:${pusherKeyPart(playerId)}`;
}

/** `pusher-result:<mid>:<pid>`, the ids escaped: the operator's answer to
 *  that player. */
export function coinPusherResultKey(machineId: string, playerId: string): string {
  return `${PUSHER_RESULT_PREFIX}${pusherKeyPart(machineId)}:${pusherKeyPart(playerId)}`;
}

/** A per-player key's family and ids (the machine's first). Null for any other
 *  key, and for one that isn't its family and exactly that many escaped ids:
 *  such a key names no machine, and nothing reads it. */
function parsePusherPlayerKey(key: string): { family: string; ids: string[] } | null {
  for (const [family, count] of PUSHER_PLAYER_FAMILIES) {
    if (!key.startsWith(family)) continue;
    // One part past the count is enough to reject a key, however long.
    const parts = key.slice(family.length).split(':', count + 1);
    if (parts.length !== count) return null;
    const ids: string[] = [];
    for (const part of parts) {
      const id = pusherIdOf(part);
      if (id === null) return null;
      ids.push(id);
    }
    return { family, ids };
  }
  return null;
}

/** Keys a sweep deletes per batch (continueCoinPusherKeySweep). */
export const PUSHER_SWEEP_BATCH = 64;

/**
 * A removed machine's per-player keys (requests, answers, and `pusher-esc:`
 * escrows an earlier revision left), deleted a batch at a time after the
 * drain, so a flood of them can't stall a frame. None of them carries chips.
 * It walks the keys the index files under the machine, and no other
 * machine's, with a live iterator: a key deleted meanwhile is skipped, and
 * one written meanwhile is deleted too, by this pass or, if it lands after
 * the pass went by, the next. The sweep ends when the index files no key
 * under the machine.
 */
export interface CoinPusherKeySweep {
  readonly machineId: string;
  /** The map it was started on — a sweep never touches another room's. */
  readonly map: Y.Map<unknown>;
  /** This pass's iterator (null between passes). */
  cursor: Iterator<string> | null;
}

export function startCoinPusherKeySweep(machineId: string): CoinPusherKeySweep {
  return { machineId, map: ensureMap(), cursor: null };
}

/**
 * Delete up to `max` more of the machine's keys, in one transaction. True
 * once the index files none under it, or when the bound doc is no longer the
 * one it started on (nothing is touched then).
 */
export function continueCoinPusherKeySweep(
  sweep: CoinPusherKeySweep,
  max: number = PUSHER_SWEEP_BATCH,
): boolean {
  if (!docAlive() || casinoMap !== sweep.map) return true;
  const doomed: string[] = [];
  let finished = false;
  while (doomed.length < max) {
    if (sweep.cursor === null) {
      // A pass over what the index files under the machine now: none means
      // none of its keys is left in the map.
      const keys = pusherRequestIndex(sweep.map).playerKeys.get(sweep.machineId);
      if (!keys || keys.size === 0) {
        finished = true;
        break;
      }
      sweep.cursor = keys.values();
    }
    const next = sweep.cursor.next();
    if (next.done) {
      // The pass is over; the next starts once this batch's deletions are in
      // (until then the index still files them).
      sweep.cursor = null;
      if (doomed.length > 0) break;
      continue;
    }
    doomed.push(next.value);
  }
  if (doomed.length > 0) {
    boundDoc!.transact(() => {
      for (const key of doomed) sweep.map.delete(key);
    });
  }
  return finished;
}

/** File a request key afresh under its machine: any change is a new arrival,
 *  so it goes to the back, stamped with this page's clock. One that no longer
 *  holds a well-formed request of the player its key names (the cross-key
 *  guard) is unfiled. */
function reindexPusherRequest(
  index: PusherRequestIndex,
  key: string,
  machineId: string,
  playerId: string,
  value: unknown,
): void {
  let keys = index.byMachine.get(machineId);
  keys?.delete(key);
  if (isPusherInsertRequest(value) && value.player === playerId) {
    if (!keys) {
      keys = new Map();
      index.byMachine.set(machineId, keys);
    }
    keys.set(key, Date.now());
  } else if (keys?.size === 0) {
    index.byMachine.delete(machineId);
  }
}

/** Re-file one changed key of the casino map (a no-op for other keys). */
function reindexPusherKey(index: PusherRequestIndex, map: Y.Map<unknown>, key: string): void {
  const parsed = parsePusherPlayerKey(key);
  if (parsed === null) return;
  const [machineId, playerId] = parsed.ids;
  if (parsed.family === PUSHER_REQUEST_PREFIX) {
    reindexPusherRequest(index, key, machineId, playerId, map.get(key));
  }
  let keys = index.playerKeys.get(machineId);
  if (map.has(key)) {
    if (!keys) {
      keys = new Set();
      index.playerKeys.set(machineId, keys);
    }
    keys.add(key);
  } else if (keys) {
    keys.delete(key);
    if (keys.size === 0) index.playerKeys.delete(machineId);
  }
}

/** The bound map's request index (built by bindCasinoDoc). */
function pusherRequestIndex(map: Y.Map<unknown>): PusherRequestIndex {
  const existing = pusherRequestIndexes.get(map);
  if (existing) return existing;
  const index: PusherRequestIndex = { byMachine: new Map(), playerKeys: new Map() };
  for (const key of map.keys()) reindexPusherKey(index, map, key);
  map.observe((event) => {
    for (const key of event.keysChanged) reindexPusherKey(index, map, key);
  });
  pusherRequestIndexes.set(map, index);
  return index;
}

/** Up to `limit` of this machine's insert requests, in arrival order: first
 *  come, first served. A request that changes (refused and filed again, or
 *  rewritten) goes to the back, and a `requestId` is the player's to choose,
 *  so it never decides the order. It reads the machine's index, never the
 *  whole map, and looks at no more than PUSHER_REQUEST_SCAN, so its cost grows
 *  neither with what peers write elsewhere nor with a flood of requests.
 *  Shape- and cross-key-guarded: a request whose `player` disagrees with the
 *  `<pid>` in its key is ignored. */
export function readCoinPusherRequests(
  machineId: string,
  limit = PUSHER_REQUEST_SCAN,
): PusherInsertRequest[] {
  const map = ensureMap();
  const keys = pusherRequestIndex(map).byMachine.get(machineId);
  const out: PusherInsertRequest[] = [];
  let looked = 0;
  for (const key of keys?.keys() ?? []) {
    if (looked++ === PUSHER_REQUEST_SCAN) break;
    const value = map.get(key);
    if (isPusherInsertRequest(value)) out.push(value);
  }
  return out.slice(0, Math.max(0, limit));
}

/** When a player's pending request on this machine arrived in this page's
 *  doc, on this page's clock (Date.now() when the index filed it; a doc bound
 *  with the request already in it counts from the bind), or null when none is
 *  pending. The operator ages every request from here, however deep in the
 *  queue it waits, never from its `requestedAt`, which is the player's clock. */
export function readCoinPusherRequestArrival(machineId: string, playerId: string): number | null {
  const key = coinPusherRequestKey(machineId, playerId);
  return pusherRequestIndex(ensureMap()).byMachine.get(machineId)?.get(key) ?? null;
}

/** One player's pending request on this machine (null when none). */
export function readCoinPusherRequest(
  machineId: string,
  playerId: string,
): PusherInsertRequest | null {
  const value = ensureMap().get(coinPusherRequestKey(machineId, playerId));
  return isPusherInsertRequest(value) && value.player === playerId ? value : null;
}

/** Player side: ask the operator to drop a chip. No chips move here — the
 *  operator debits the chip when it settles the drop. One pending request per
 *  player per machine; false when one is already pending or the shape guard
 *  rejects the request. */
export function writeCoinPusherRequest(
  machineId: string,
  request: PusherInsertRequest,
): boolean {
  if (!isPusherInsertRequest(request)) return false;
  // A guarded read, not map.has: junk under the key must not lock the player out.
  if (readCoinPusherRequest(machineId, request.player)) return false;
  ensureMap().set(coinPusherRequestKey(machineId, request.player), request);
  return true;
}

/** Withdraw a request if it is still `requestId` (the player's cancel, or the
 *  operator dropping one it cannot process). Safe to race the operator's
 *  settle: the request carries no chips, so whichever lands first wins and
 *  nothing is lost or paid twice. */
export function cancelCoinPusherRequest(
  machineId: string,
  playerId: string,
  requestId: string,
): boolean {
  if (readCoinPusherRequest(machineId, playerId)?.requestId !== requestId) return false;
  ensureMap().delete(coinPusherRequestKey(machineId, playerId));
  return true;
}

/** The operator's answer to `playerId`'s latest request (null before the first). */
export function readCoinPusherResult(machineId: string, playerId: string): PusherResult | null {
  const value = ensureMap().get(coinPusherResultKey(machineId, playerId));
  return isPusherResult(value) ? value : null;
}

export function readCoinPusherEmptyRequest(machineId: string): PusherEmptyRequest | null {
  const value = ensureMap().get(`pusher-empty:${machineId}`);
  return isPusherEmptyRequest(value) ? value : null;
}

/** Owner side: ask the operator to open the door and empty the machine into
 *  the owner's chips. The operator checks the requester is the owner. */
export function writeCoinPusherEmptyRequest(
  machineId: string,
  request: PusherEmptyRequest,
): boolean {
  if (!isPusherEmptyRequest(request)) return false;
  ensureMap().set(`pusher-empty:${machineId}`, request);
  return true;
}

/** The operator's answer to the latest door request (null before the first). */
export function readCoinPusherDoorResult(machineId: string): PusherDoorResult | null {
  const value = ensureMap().get(`pusher-door:${machineId}`);
  return isPusherDoorResult(value) ? value : null;
}

/**
 * Operator: turn a door request down (its requester does not own the
 * machine) — answer it and clear it in one transaction, moving nothing.
 * False when the request is no longer pending.
 */
export function refuseCoinPusherEmpty(
  machineId: string,
  request: PusherEmptyRequest,
  atMs: number,
): boolean {
  if (readCoinPusherEmptyRequest(machineId)?.requestId !== request.requestId) return false;
  const answer: PusherDoorResult = { kind: 'refused', requestId: request.requestId, atMs };
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`pusher-door:${machineId}`, answer);
    map.delete(`pusher-empty:${machineId}`);
  });
  return true;
}

/** The room's coin-pusher operator lease (one for every cabinet). */
export function readCoinPusherOperatorLease(): CoinPusherOperatorLease | null {
  const value = ensureMap().get(COIN_PUSHER_OPERATOR_KEY);
  return isCoinPusherOperatorLease(value) ? value : null;
}

export function writeCoinPusherOperatorLease(lease: CoinPusherOperatorLease): void {
  if (!isCoinPusherOperatorLease(lease)) return;
  ensureMap().set(COIN_PUSHER_OPERATOR_KEY, lease);
}

export function clearCoinPusherOperatorLease(): void {
  ensureMap().delete(COIN_PUSHER_OPERATOR_KEY);
}

/** The fields that change on every operator write — two states that agree on
 *  all of them are the same machine revision. */
function sameCoinPusherRevision(a: CoinPusherState, b: CoinPusherState): boolean {
  return a.tick === b.tick
    && a.ownerId === b.ownerId
    && a.nextChipId === b.nextChipId
    && a.totalInserted === b.totalInserted
    && a.totalPaid === b.totalPaid
    && a.totalEmptied === b.totalEmptied;
}

export type CoinPusherSettleResult =
  | 'ok'
  /** The stored machine is not `base` (another write landed first). */
  | 'stale-state'
  /** The player's request is gone or was replaced. */
  | 'stale-request'
  /** The player no longer holds PUSHER_ANTE chips. */
  | 'no-chips'
  /** The player's balance can't take what the drop paid (it would leave the
   *  safe-integer range). */
  | 'balance-full'
  /** `next` is not a legal one-chip drop from `base` for this request. */
  | 'invalid';

/**
 * Operator: settle one drop in ONE transaction — debit the player's
 * PUSHER_ANTE chip, credit what the drop paid, publish `next`, answer the
 * player (their PusherResult), clear the request. `next` must be
 * processInsert's result on `base` for this request, and the credit is read
 * off that transition (next.totalPaid − base.totalPaid, which must equal
 * next.lastDrop.paid), never passed in separately. Nothing is written unless
 * every check passes.
 */
export function settleCoinPusherInsert(
  machineId: string,
  base: CoinPusherState,
  next: CoinPusherState,
  request: PusherInsertRequest,
): CoinPusherSettleResult {
  const stored = readCoinPusherState(machineId);
  if (!stored || !sameCoinPusherRevision(stored, base)) return 'stale-state';
  if (readCoinPusherRequest(machineId, request.player)?.requestId !== request.requestId) {
    return 'stale-request';
  }
  const normalized = normalizeCoinPusherState(next);
  if (!normalized) return 'invalid';
  const paid = normalized.totalPaid - base.totalPaid;
  const drop = normalized.lastDrop;
  if (normalized.ownerId !== base.ownerId
    || normalized.tick <= base.tick
    || normalized.nextChipId !== base.nextChipId + 1
    || normalized.totalInserted !== base.totalInserted + PUSHER_ANTE
    || normalized.totalEmptied !== base.totalEmptied
    || paid < 0
    || !computeConservation(normalized).balanced
    || drop?.requestId !== request.requestId
    || drop.player !== request.player
    || drop.hole !== request.hole
    || drop.paid !== paid) {
    return 'invalid';
  }
  const map = ensureMap();
  const balance = readChips(request.player);
  if (balance < PUSHER_ANTE) return 'no-chips';
  const nextBalance = balance - PUSHER_ANTE + paid;
  if (!Number.isSafeInteger(nextBalance)) return 'balance-full';
  const result: PusherResult = {
    kind: 'drop', requestId: request.requestId, paid, honored: drop.honored, atMs: drop.atMs,
  };
  boundDoc!.transact(() => {
    map.set(`pusher:${machineId}`, normalized);
    addChips(request.player, nextBalance - balance);
    map.set(coinPusherResultKey(machineId, request.player), result);
    map.delete(coinPusherRequestKey(machineId, request.player));
  });
  return 'ok';
}

/**
 * Operator: turn a request down without moving any chips — answer the player
 * with why (their PusherResult) and clear the request, in one transaction.
 * The machine itself is untouched. False when the request is no longer
 * pending.
 */
export function refuseCoinPusherInsert(
  machineId: string,
  request: PusherInsertRequest,
  reason: PusherRefusalReason,
  atMs: number,
): boolean {
  if (readCoinPusherRequest(machineId, request.player)?.requestId !== request.requestId) {
    return false;
  }
  const result: PusherResult = { kind: 'refused', requestId: request.requestId, reason, atMs };
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(coinPusherResultKey(machineId, request.player), result);
    map.delete(coinPusherRequestKey(machineId, request.player));
  });
  return true;
}

/**
 * Operator: carry out the owner's door request in ONE transaction — publish
 * the emptied `next`, credit the owner exactly the chips that were inside
 * `base`, answer the request (its PusherDoorResult) and clear it. The
 * operator must be the machine's owner and the one who asked (the operator
 * re-owns every machine it runs, so this is the deed holder emptying their
 * own machine), and `next` must be emptyMachine's result on `base`. Returns
 * the chips credited, or null when nothing was written.
 */
export function commitCoinPusherEmpty(
  machineId: string,
  base: CoinPusherState,
  next: CoinPusherState,
  request: PusherEmptyRequest,
  operatorId: string,
  atMs: number,
): number | null {
  const stored = readCoinPusherState(machineId);
  if (!stored || !sameCoinPusherRevision(stored, base)) return null;
  if (readCoinPusherEmptyRequest(machineId)?.requestId !== request.requestId) return null;
  if (base.ownerId !== operatorId || request.requester !== operatorId) return null;
  const normalized = normalizeCoinPusherState(next);
  if (!normalized) return null;
  const emptied = chipsInMachine(base);
  if (normalized.ownerId !== base.ownerId
    || normalized.tick <= base.tick
    || chipsInMachine(normalized) !== 0
    || normalized.totalEmptied !== base.totalEmptied + emptied
    || normalized.totalInserted !== base.totalInserted
    || normalized.totalPaid !== base.totalPaid
    || !computeConservation(normalized).balanced) {
    return null;
  }
  const map = ensureMap();
  const ownerBalance = readChips(base.ownerId);
  if (!Number.isSafeInteger(ownerBalance + emptied)) return null;
  const answer: PusherDoorResult = { kind: 'opened', requestId: request.requestId, emptied, atMs };
  boundDoc!.transact(() => {
    map.set(`pusher:${machineId}`, normalized);
    if (emptied > 0) addChips(base.ownerId, emptied);
    map.set(`pusher-door:${machineId}`, answer);
    map.delete(`pusher-empty:${machineId}`);
  });
  return emptied;
}

/**
 * Teardown for a removed cabinet, run only by the room's operator past its
 * settling wait (pusherCroupier.closeCoinPusher), so it never merges with a
 * drop another session is still settling: credit the chips still inside to
 * `recipientId`, the deed holder running it, and delete every key the machine
 * used, in ONE transaction. The recipient is the caller's own identity, never
 * the `ownerId` stored in the peer-writable machine, so a forged machine can
 * only ever pay the deed holder (the operator re-owns every machine it runs,
 * so in honest play they are the same). This transaction touches only the
 * machine's own keys, a fixed few. Its per-player keys carry no chips and are
 * deleted afterwards, a batch at a time (startCoinPusherKeySweep). Returns the
 * chips credited, or null when nothing was written: chips inside that can't be
 * credited (the recipient's balance would leave the safe-integer range) stay
 * in the machine, as the door leaves them, and the caller tries again later.
 */
export function drainAndClearCoinPusher(machineId: string, recipientId: string): number | null {
  const map = ensureMap();
  const state = readCoinPusherState(machineId);
  const inside = state ? chipsInMachine(state) : 0;
  const ownerBalance = readChips(recipientId);
  if (inside > 0 && (recipientId.length === 0 || recipientId.length > 128
    || !Number.isSafeInteger(ownerBalance + inside))) return null;
  const credit = inside;
  boundDoc!.transact(() => {
    if (credit > 0) addChips(recipientId, credit);
    map.delete(`pusher:${machineId}`);
    map.delete(`pusher-empty:${machineId}`);
    map.delete(`pusher-door:${machineId}`);
    // A per-machine lease an earlier revision wrote. The room's lease stays:
    // it covers the room's other cabinets.
    map.delete(`pusher-operator:${machineId}`);
  });
  return credit;
}

// Permanent debug handle (the __ssfGames precedent) — console verification of
// balances, table state and settle math without UI plumbing. Guard for Node
// tooling / tests: importing this module must stay pure, with browser-only
// debug handles attached only when a DOM exists.
if (typeof window !== 'undefined') {
  (window as unknown as { __ssfCasino: unknown }).__ssfCasino = {
    readChips, buyInChips, cashOutChips, spendChips, creditChips, readChipRecords,
    readCageLedger, readTableState, writeTableState, readMyBets, writeMyBets, readAllBets,
    readCroupierBeat, writeCroupierBeat, readTableOperatorLease,
    readCrapsTableState, writeCrapsTableState, readMyCrapsBets, writeMyCrapsBets, readAllCrapsBets,
    readCrapsBackendPref, writeCrapsBackendPref,
    readCrapsFairnessPref, writeCrapsFairnessPref,
    readSlotMachineState, writeSlotMachineState,
    readSlotPlayRequests, writeSlotPlayRequest, readSlotReveal, writeSlotReveal,
    readSlotOddsConfig, writeSlotOddsConfig, clearSlotMachineKeys,
    readSlotFundingConfig, writeSlotFundingConfig, readSlotFundingBalance,
    depositSlotFunding, withdrawSlotFunding,
    readSlotSharedBankrollLease, acquireSlotSharedBankrollLease,
    releaseSlotSharedBankrollLease,
    readCoinPusherState, readCoinPusherRequests, readCoinPusherRequest,
    readCoinPusherResult, readCoinPusherEmptyRequest, readCoinPusherDoorResult,
    readCoinPusherOperatorLease, coinPusherRequestKey, coinPusherResultKey,
  };
}
