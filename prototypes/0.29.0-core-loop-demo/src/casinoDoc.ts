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
 *   table:<tableId>           → RouletteTableState (croupier-written;
 *                                        `bk`: the book it goes on from)
 *   bets:<tableId>:<playerId> → { round, held: RouletteBet[], inc, taken? }
 *                                        (owner-written; craps: { kind, held,
 *                                        inc, base, taken?, over? }; an
 *                                        earlier build's: { round?, kind?,
 *                                        bets }, and the stickman's prune of
 *                                        one adds inc, pruned; see STAKES ON
 *                                        THE FELT)
 *   gone:<tableId>:<inc>      → 1        that incarnation of the table was
 *                                        removed (clearTableKeys); the bare
 *                                        `gone:<tableId>:`, that the table
 *                                        has been removed under this id
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
 * per page per player, not per bet. What a roulette or craps table pays is
 * the one exception: it is in the table's book (below). Sums are exact
 * (bigint), so every page gets the same one whatever order records arrive
 * in. A slot machine's own bankroll is an account in the same ledger,
 * named by its `slot-bankroll:` key, whose stored value is its opening
 * balance. It is the first step of the computed tables (see the "Computed
 * casino tables" design). Trust is unchanged: honest clients, as before;
 * signed records come with the computed tables.
 *
 * 📒 THE TABLE'S BOOK: one page settles a table's rounds at a time (the
 * lease, or a manual SPIN or ROLL's operator), but a page cut off from the
 * room keeps settling them as it runs while another takes over, and when
 * the two meet the doc keeps one write of each key. So everything a settle
 * decides about the table (each time it is set up: its incarnation) is one
 * value under one key, `book:<tableId>:<inc>` in `casinoChips`, which every
 * settle writes whole: the round, what the table has paid each bettor in all
 * and the round it last settled for them (`recs`), what a craps roll left up
 * of each bettor's bets (`kept`), and the settled state (`st`). The doc keeps
 * one write of the key, so it holds one settle's book, whole: the chips of
 * every bettor follow one run of rounds, however many pages settled on
 * either side, never some of one and some of the other.
 *
 * A table state names the write of the book it goes on from (`bk`): a
 * settle's state its own, and every state made from one (the next opening,
 * the close, a takeover's stamp) carries it on; a round that goes on from
 * no settle (a first round) names FIRST_OPENING, alike on every page. A
 * state that doesn't go on from the book (the doc kept the other side's, a
 * takeover's stamp written as a settle wrote, or a cut-off page's state of
 * an incarnation the room removed) reads as the book's settled state at
 * once (tableStateOf), and the next write of the table's state puts that up
 * first, in a fresh write of the book (putTableBack), so no round settles
 * twice and none is renumbered. A roulette list names the opening it was
 * put down on (`bk`) and plays only there, so one put down on the side the
 * doc dropped never plays, nor holds chips; a craps list plays over the
 * book's `kept` only if it was written over that very write of it (`over`).
 * No round number of one side is read against the other's: a list's round
 * counts only where the list plays (readEmptiedLists too).
 *
 * What a removal refunds is apart, one record per bettor (`end:<tableId>:
 * <inc>:<pid>`), which counts only while the book still has the bettor's
 * record as its writer saw it: a settle at the very moment of the removal
 * resolved the list the refund was for (creditTableOutcome). No list is
 * refunded for a round the book has settled for its bettor.
 *
 * A page holding part of another page's update (Yjs parks what it can't
 * apply yet, and applies its deletes at once, so a rewritten key reads as
 * gone) settles, opens, takes bets on and refunds the removal of no table
 * until the rest comes, keeps the held chips it last counted, and asks the
 * room again for what it is missing (casinoWhole, whenCasinoWhole); after a
 * lapse of it the page lets the tables' lease go, so one that holds it all
 * can drive. Nor does a page waiting out a wake (croupier tablesAwake) put
 * a table's state or book back up (tableWritable). Not covered: what an
 * earlier build's page settles (it pays as it always did).
 *
 * 🪙 STAKES ON THE FELT: chips bet at roulette or craps are not taken from
 * the player when they go down. They stay the player's, held on the felt by
 * the bet list itself: a player's chips = their ledger total − every held
 * list on a live round (a roulette list of the table's current round before
 * it settles, any craps list on a table that is up). The settle turns a
 * round's stakes into one ledger change per bettor (won − staked, in the
 * table's book) in the same transaction that ends the round, so
 * no page ever counts a stake both held and paid. Taking a bet down,
 * removing the table, or a round that leaves a list behind (a late bet)
 * hands its chips back with no credit at all: the list stops holding them.
 * The bet list is one whole value per player, and so is what it holds: two
 * tabs of one player placing at once keep one list and its chips, a
 * take-down and a removal at once hand them back once. Only the player
 * writes their list: what a craps roll leaves up the stickman writes in the
 * book (`kept`), which plays until the player writes a list over it, so a
 * list written before the roll settled never brings back bets it resolved
 * (crapsFelt). An earlier build's list the stickman also prunes where it
 * lies, as earlier builds did, so that page reads the felt as the roll left
 * it; the prune is marked as the stickman's (`pruned`), so it plays only as
 * the book's `kept`. A list goes down only on a table that is up.
 *
 * A list an earlier build put down (under `bets`) took its chips as it went
 * down. What it took rides with it as `taken`, through the player's rewrites
 * too: the list holds only the rest (FeltStake `net`, below 0 when the
 * player took more down than it took), the settle pays its wins in full, and
 * a removal refunds what it took, in the bettor's `end:` record: every page
 * that hears of it, from the table's state as the doc has it, one the
 * removal ended too, since the page removing it may not have seen that round
 * (tableEndingStakes). Nothing is handed back on a rewrite, so two tabs, or
 * a tab and a removal, can't hand it back twice. A craps settle at the very
 * moment of the removal voids the refund of a bettor it settled: what the
 * bets it kept up had taken is then owed back by the book's `kept` (keptOwed),
 * and paid as the bettor's refund when the table's leftovers are swept.
 *
 * A write at the very moment of a removal (a settle, a bet) outlives the
 * removal's delete, as a concurrent write does in the doc. So the removal
 * leaves `gone:<tableId>:<inc>` behind: a state of a removed incarnation
 * reads as no table and holds nothing, and a list belongs to the incarnation
 * it was put down on (its `inc`), so a table put back under the same id
 * starts clean. An earlier build's state carries none: it is the
 * incarnation the table's first round takes (tableIncOf), so a page giving
 * it its `inc` and a page removing it name it alike. A page that removes a
 * table it saw no round on marks the incarnation a page that hasn't heard
 * would open it on, and a table put back never reopens a name whose records
 * a removal left unmarked (tableOpening).
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

export function bindCasinoDoc(doc: Y.Doc, roomId = '', resync?: () => void): void {
  bindingEpoch += 1;
  boundRoomId = roomId;
  boundDoc = doc;
  askResync = resync ?? null;
  askedResyncAt = -Infinity;
  pinPlayerKeys(doc);
  casinoMap = doc.getMap('casino');
  waitingWhole.clear();
  // (After the transaction, so what waits writes in one of its own.)
  doc.on('afterTransaction', () => {
    if (boundDoc !== doc || waitingWhole.size === 0 || drainQueued) return;
    drainQueued = true;
    queueMicrotask(drainWaitingWhole);
  });
  bindChipLedger(doc);
  bindHeldStakes(doc, casinoMap);
  // 🪙 Index the coin pushers' requests now, outside any operator poll, and
  // observe ahead of notify() so listeners never see a stale index.
  pusherRequestIndex(casinoMap);
  casinoMap.observe((event) => {
    if (heldTouched.size === 0 && chipsTouched.size === 0) {
      notify(event.keysChanged);
      return;
    }
    notify(takeTouched(new Set(event.keysChanged)));
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
    && typeof r.at === 'number' && Number.isFinite(r.at);
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
  /** each table book as counted: bettor → chips */
  books: Map<string, Map<string, bigint>>;
  /** each removal refund as counted (none while it doesn't count) */
  ends: Map<string, { p: string; d: bigint }>;
  /** the refunds of each table incarnation (`<tableId>:<inc>`), recounted with its book */
  endsOf: Map<string, Set<string>>;
  /** keys read as gone while the doc held part of an update (casinoWhole), still counted */
  parked: Set<string>;
  /** each table's incarnations with a book (no build deletes one) */
  booksOf: Map<string, Set<string>>;
  bought: bigint;
  cashed: bigint;
}
function newChipIndex(): ChipIndex {
  return {
    byAccount: new Map(), counted: new Map(), books: new Map(), ends: new Map(), endsOf: new Map(),
    parked: new Set(), booksOf: new Map(), bought: 0n, cashed: 0n,
  };
}
let chipIndex: ChipIndex = newChipIndex();
/** Accounts whose chips changed since the last notify. */
const chipsTouched = new Set<string>();

function addToAccount(ix: ChipIndex, account: string, delta: bigint): void {
  if (delta === 0n) return;
  ix.byAccount.set(account, (ix.byAccount.get(account) ?? 0n) + delta);
  chipsTouched.add(account);
}

function countChipRecord(ix: ChipIndex, rec: ChipRecord, sign: 1n | -1n): void {
  addToAccount(ix, rec.p, sign * BigInt(rec.d));
  ix.bought += sign * BigInt(rec.b);
  ix.cashed += sign * BigInt(rec.c);
  chipsTouched.add(rec.p);
}

/** Bring one key's record in the index in line with the map. A key that
 *  reads as gone while the doc holds part of an update stays counted as it
 *  was: Yjs applies the update's deletes at once and the writes they make
 *  room for once the rest comes, and no chip key is ever deleted otherwise. */
function recountChipKey(ix: ChipIndex, map: Y.Map<unknown>, key: string): void {
  if (!map.has(key) && !casinoWhole()) {
    ix.parked.add(key);
    return;
  }
  ix.parked.delete(key);
  if (key.startsWith('book:')) recountBook(ix, map, key);
  else if (key.startsWith('end:')) recountEnd(ix, map, key);
  else recountRecord(ix, map, key);
}

function recountRecord(ix: ChipIndex, map: Y.Map<unknown>, key: string): void {
  const before = ix.counted.get(key);
  const value = map.get(key);
  const now = isChipRecord(value) ? value : undefined;
  if (before === now) return;
  if (before) { countChipRecord(ix, before, -1n); ix.counted.delete(key); }
  if (now) { countChipRecord(ix, now, 1n); ix.counted.set(key, now); }
}

/** A table book's bettors in the index, as the book now reads; and its
 *  incarnation's refunds, which count by it. */
function recountBook(ix: ChipIndex, map: Y.Map<unknown>, key: string): void {
  const at = key.slice('book:'.length);
  const book = bookAt(map, at);
  const before = ix.books.get(key);
  const cut = at.lastIndexOf(':');
  if (map.has(key) && cut > 0) {
    const tableId = at.slice(0, cut);
    let incs = ix.booksOf.get(tableId);
    if (!incs) ix.booksOf.set(tableId, incs = new Set());
    incs.add(at.slice(cut + 1));
  }
  const now = new Map<string, bigint>();
  if (book) for (const [pid, rec] of Object.entries(book.recs)) now.set(pid, BigInt(rec.d));
  for (const pid of new Set([...(before?.keys() ?? []), ...now.keys()])) {
    addToAccount(ix, pid, (now.get(pid) ?? 0n) - (before?.get(pid) ?? 0n));
  }
  if (now.size > 0) ix.books.set(key, now);
  else ix.books.delete(key);
  for (const end of ix.endsOf.get(at) ?? []) recountEnd(ix, map, end);
}

/** A removal refund in the index: what it refunds while it counts (isEnd). */
function recountEnd(ix: ChipIndex, map: Y.Map<unknown>, key: string): void {
  const value = map.get(key);
  const rec = isEndRecord(value) && key.endsWith(`:${value.p}`) ? value : null;
  const at = rec ? key.slice('end:'.length, key.length - rec.p.length - 1) : null;
  if (rec && at) {
    let ends = ix.endsOf.get(at);
    if (!ends) ix.endsOf.set(at, ends = new Set());
    ends.add(key);
  }
  const d = rec && at && endCounts(bookAt(map, at), rec) ? BigInt(rec.d) : 0n;
  const before = ix.ends.get(key);
  if (before?.p === rec?.p && (before?.d ?? 0n) === d) return;
  if (before) addToAccount(ix, before.p, -before.d);
  ix.ends.delete(key);
  if (rec && d !== 0n) {
    addToAccount(ix, rec.p, d);
    ix.ends.set(key, { p: rec.p, d });
  }
}

/** Calls back to ask the room for what this page is missing (YjsSync
 *  resync), at most every few seconds; none for a page-local doc. */
let askResync: (() => void) | null = null;
let askedResyncAt = -Infinity;

/** Whether the bound doc holds every update it has been given whole (and,
 *  for table `tableId`, every book of it this page has read): Yjs parks the
 *  part of an update it can't apply yet (what it builds on hasn't come),
 *  and applies its deletes at once, so a key it rewrites reads as gone
 *  until the rest comes. A settle, a refund, or a count of held chips made
 *  then would build on that: nothing that reads the doc to write chips does
 *  it before then (and the room is asked again for what this page is
 *  missing). The room hands on each page's own updates and state-vector
 *  diffs, never an update re-encoded on the way (one can carry another
 *  page's write and its overwrite without the write that won, and the doc
 *  reads whole); a table's book this page has read and the doc no longer
 *  has is such a key too, whatever the doc's own record says (no build
 *  deletes one), so nothing of that table builds on its absence either. */
export function casinoWhole(tableId?: string): boolean {
  // (Deletes Yjs holds back, store.pendingDs, are of writes this page hasn't
  // got at all, which read as not here yet whatever comes: no part read.)
  const store = boundDoc?.store as { pendingStructs: unknown } | undefined;
  const pending = store !== undefined && store.pendingStructs !== null;
  const lost = tableId !== undefined && chipsMap !== null
    && [...(chipIndex.booksOf.get(tableId) ?? [])].some((inc) => !chipsMap!.has(`book:${tableId}:${inc}`));
  if (!pending && !lost) return true;
  const now = Date.now();
  if (askResync && !(now - askedResyncAt < 5_000 && now >= askedResyncAt)) {
    askedResyncAt = now;
    try { askResync(); } catch (err) { console.warn('[casino] resync failed:', err); }
  }
  return false;
}

/** What waits for the doc to hold every update whole (casinoWhole), by key:
 *  one per key (the last), on the binding it was asked on. */
const waitingWhole = new Map<string, { epoch: number; tableId?: string; run: () => void }>();
let drainQueued = false;

/** Run `run` now if the doc holds every update whole (casinoWhole, of table
 *  `tableId` when named), else once it does, if the room doc is the same
 *  one then. */
export function whenCasinoWhole(key: string, run: () => void, tableId?: string): void {
  if (casinoWhole(tableId)) {
    waitingWhole.delete(key);
    run();
    return;
  }
  waitingWhole.set(key, { epoch: bindingEpoch, tableId, run });
}

function drainWaitingWhole(): void {
  drainQueued = false;
  for (const [key, wait] of [...waitingWhole]) {
    if (wait.epoch !== bindingEpoch) waitingWhole.delete(key);
    else if (casinoWhole(wait.tableId)) {
      waitingWhole.delete(key);
      try {
        wait.run();
      } catch (err) {
        console.error('[casino] a write waiting for the whole doc failed:', err);
      }
    }
  }
}

function bindChipLedger(doc: Y.Doc): void {
  const map = doc.getMap<unknown>('casinoChips');
  const ix = newChipIndex();
  chipsMap = map;
  chipIndex = ix;
  for (const key of map.keys()) recountChipKey(ix, map, key);
  chipWriter = `${doc.clientID.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  chipKeys = new Map();
  chipRolls = 0;
  bookWrites = 0;
  chipsTouched.clear();
  // Recount BEFORE any observer runs, so a casino-map listener firing in the
  // same transaction (a settle that writes a machine and a payout together)
  // already reads the new chips.
  doc.on('beforeObserverCalls', (tr: Y.Transaction) => {
    if (chipIndex !== ix) return; // a binding we've moved off
    const keys = tr.changed.get(map as unknown as Y.AbstractType<Y.YEvent<any>>);
    if (keys) for (const key of keys) if (key !== null) recountChipKey(ix, map, key);
    // The rest of an update came: what read as gone meanwhile reads as it is.
    if (ix.parked.size > 0 && casinoWhole()) for (const key of [...ix.parked]) recountChipKey(ix, map, key);
  });
  // What kept bets owe can end with a transaction of this map alone.
  map.observe(() => {
    if (chipIndex !== ix || (chipsTouched.size === 0 && heldTouched.size === 0)) return;
    notify(takeTouched(new Set()));
  });
  // Chips a transaction of neither map moved (what read as gone, counted
  // again as the rest of an update comes in another map's write).
  doc.on('afterTransaction', () => {
    if (chipIndex !== ix || (chipsTouched.size === 0 && heldTouched.size === 0)) return;
    notify(takeTouched(new Set()));
  });
}

/** `keys` with the chip keys of what this transaction's recounts moved
 *  (chipsTouched, heldTouched), which are then told: once, by whichever of
 *  the casino maps' observers runs first (or after the transaction). */
function takeTouched(keys: Set<string>): Set<string> {
  for (const account of chipsTouched) keys.add(isBankrollAccount(account) ? account : `bal:${account}`);
  for (const pid of heldTouched) keys.add(`bal:${pid}`);
  chipsTouched.clear();
  heldTouched.clear();
  return keys;
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

/** The chips a player may spend now: readChips, or none while the doc holds
 *  part of an update (casinoWhole). A list held on a felt may read as gone
 *  there, and a hold heard whole meanwhile isn't counted until the rest
 *  comes (heldStake), so chips on a felt would read as free. */
function spendableChips(playerId: string): number {
  return casinoWhole() ? readChips(playerId) : 0;
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

/** Cashier CASH-OUT: chips go back to the cage. Returns chips returned:
 *  none while the doc holds part of an update (spendableChips). */
export function cashOutChips(playerId: string, amount: number): number {
  const bal = spendableChips(playerId);
  const n = Math.min(bal, Math.max(0, Math.floor(amount)));
  if (n <= 0) return 0;
  addChips(playerId, -n, 'cashout');
  return n;
}

/** Take chips from a player now. False when the balance is short, or the
 *  doc holds part of an update (spendableChips). (A table
 *  bet doesn't: its list holds the chips, see STAKES ON THE FELT.) */
export function spendChips(playerId: string, amount: number): boolean {
  if (!Number.isInteger(amount) || amount <= 0) return false;
  const bal = spendableChips(playerId);
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

// ── 📒 The table's book (see THE TABLE'S BOOK above) ────────────────────────

/** What a table has paid one bettor in all, on one incarnation of it. */
interface BookRec {
  /** chips, exactly (a bigint in decimal): won − staked, round after round */
  d: string;
  /** the last round that wrote it */
  r: number;
  /** the write of the book that last wrote it (a refund names it: EndRecord) */
  w: string;
  /** writer-clock ms of that write, for reading the history only */
  at: number;
}

/** What a craps roll left up of one bettor's bets, and what of them an
 *  earlier build took (`taken`). */
interface BookKept {
  round: number;
  kept: CrapsBet[];
  taken?: number;
  /** the write of the book that left it: a list written over it names it (`over`) */
  w: string;
}

/** A table incarnation's book, as its last settle wrote it, whole. */
export interface TableBook {
  /** this write of it (`<writer>.<n>`): no two alike */
  id: string;
  /** the round it settled */
  round: number;
  recs: Record<string, BookRec>;
  kept: Record<string, BookKept>;
  /** the state that round settled in */
  st: RouletteTableState | CrapsTableState;
}

/** A removal's refund to one bettor of a table incarnation
 *  (`end:<tableId>:<inc>:<pid>`). */
interface EndRecord {
  p: string;
  d: number;
  /** the bettor's record in the book as the refund's writer saw it (its
   *  `w`; '' for none) */
  seen: string;
}

const BOOK_TOTAL = /^-?(0|[1-9]\d{0,39})$/;

function isBookId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64;
}

function isPlayerKey(pid: string): boolean {
  return pid.length > 0 && pid.length <= 256 && pid !== '__proto__';
}

/** An entry of a book's map, its own (never one an object has from its prototype). */
function entryOf<T>(entries: Record<string, T> | undefined, pid: string): T | undefined {
  return entries && Object.prototype.hasOwnProperty.call(entries, pid) ? entries[pid] : undefined;
}

function isBookRec(v: unknown): v is BookRec {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<BookRec>;
  return typeof r.d === 'string' && BOOK_TOTAL.test(r.d)
    && Number.isSafeInteger(r.r) && (r.r as number) >= 1
    && isBookId(r.w) && typeof r.at === 'number' && Number.isFinite(r.at);
}

function isBookKept(v: unknown): v is BookKept {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Partial<BookKept>;
  return Number.isSafeInteger(k.round) && (k.round as number) >= 1
    && Array.isArray(k.kept) && k.kept.length <= MAX_BETS_PER_PLAYER && k.kept.every(isCrapsBet)
    && (k.taken === undefined
      || (Number.isSafeInteger(k.taken) && (k.taken as number) > 0 && (k.taken as number) <= MAX_LIST_STAKE))
    && isBookId(k.w);
}

function isEndRecord(v: unknown): v is EndRecord {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<EndRecord>;
  return typeof e.p === 'string' && e.p.length > 0 && e.p.length <= 256
    && Number.isSafeInteger(e.d) && (e.d as number) > 0
    && typeof e.seen === 'string' && e.seen.length <= 64;
}

/** Whether a refund counts: the book still has the bettor's record as the
 *  refund's writer saw it. A settle it hadn't heard of (one at the very
 *  moment of the removal) wrote the bettor's record afresh: it resolved the
 *  list the refund was for. */
function endCounts(book: TableBook | null, end: EndRecord): boolean {
  return (entryOf(book?.recs, end.p)?.w ?? '') === end.seen;
}

const bookCache = new WeakMap<object, TableBook | null>();

/** The book of a table incarnation (`<tableId>:<inc>`) as stored; null for
 *  none, or junk. A bettor's junk entry reads as no entry. */
function bookAt(chips: Y.Map<unknown>, at: string): TableBook | null {
  const value = chips.get(`book:${at}`);
  if (typeof value !== 'object' || value === null) return null;
  let book = bookCache.get(value);
  if (book === undefined) {
    book = parseBook(value, at);
    bookCache.set(value, book);
  }
  return book;
}

function parseBook(value: object, at: string): TableBook | null {
  const v = value as { id?: unknown; round?: unknown; recs?: unknown; kept?: unknown; st?: unknown };
  if (!isBookId(v.id) || !Number.isSafeInteger(v.round) || (v.round as number) < 1) return null;
  const st = v.st;
  if (!(isRouletteTableState(st) || isCrapsTableState(st)) || st.phase !== 'settled' || st.round !== v.round) return null;
  const cut = at.lastIndexOf(':');
  if (cut <= 0 || tableIncOf(at.slice(0, cut), st) !== at.slice(cut + 1)) return null;
  const isMap = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!isMap(v.recs) || (v.kept !== undefined && !isMap(v.kept))) return null;
  const recs: Record<string, BookRec> = {};
  for (const [pid, rec] of Object.entries(v.recs)) if (isPlayerKey(pid) && isBookRec(rec)) recs[pid] = rec;
  const kept: Record<string, BookKept> = {};
  if (st.kind === 'craps' && v.kept) {
    for (const [pid, k] of Object.entries(v.kept)) if (isPlayerKey(pid) && isBookKept(k)) kept[pid] = k;
  }
  return { id: v.id, round: v.round as number, recs, kept, st };
}

/** The book of incarnation `inc` of a table (null: no round settled on it yet). */
export function readTableBook(tableId: string, inc: string): TableBook | null {
  return bookAt(ensureChips(), `${tableId}:${inc}`);
}

/** How many writes of a book this binding has made (their ids). */
let bookWrites = 0;

function writeBook(chips: Y.Map<unknown>, at: string, book: TableBook): void {
  boundDoc!.transact(() => {
    chips.set(`book:${at}`, book);
    recountChipKey(chipIndex, chips, `book:${at}`);
    heldDirty = true;
  });
}

/**
 * A settle's write of its round's settled state: the table's state, and a
 * fresh write of its book with it, which each bettor's outcome
 * (creditTableOutcome) and craps felt (pruneCrapsBets) then go on. Call it
 * first in the settle's transaction. The state names the write (`bk`), so a
 * state that goes on from it says so.
 */
export function writeSettledState(tableId: string, state: RouletteTableState | CrapsTableState): void {
  if (state.phase !== 'settled') return;
  const chips = ensureChips();
  const map = ensureMap();
  const at = `${tableId}:${tableIncOf(tableId, state)}`;
  const was = bookAt(chips, at);
  bookWrites += 1;
  const id = `${chipWriter}.${bookWrites}`;
  const st = { ...state, bk: id };
  boundDoc!.transact(() => {
    writeBook(chips, at, { id, round: state.round, recs: was?.recs ?? {}, kept: was?.kept ?? {}, st });
    map.set(`table:${tableId}`, st);
  });
}

/** This page's write of a table incarnation's book for the settle of
 *  `round` (writeSettledState), when it is the book the doc has. */
function openBook(chips: Y.Map<unknown>, tableId: string, inc: string, round: number): TableBook | null {
  const book = bookAt(chips, `${tableId}:${inc}`);
  return book && book.round === round && book.id.startsWith(`${chipWriter}.`) ? book : null;
}

/**
 * Move `amount` chips to `playerId` (negative: from them) for one outcome of
 * one table incarnation (`inc`, tableIncFor: a table set up again under the
 * same id is a new one). A settled round (`outcome` its number: what it paid
 * less what it took off the felt) goes on the bettor's record in this
 * page's write of the book (writeSettledState), once: a round writes its
 * outcome for every bettor, even one that moves nothing, so its write of
 * the book holds every bettor it saw. The table's removal (`end`: what an
 * earlier build's stakes took, refunded) is the bettor's refund record,
 * which every page hearing of the removal writes (the doc keeps one): it
 * counts while the book's record of the bettor is the one its writer saw
 * (endCounts), and once it counts, nothing more is paid them from that
 * table.
 */
export function creditTableOutcome(
  tableId: string, inc: string, outcome: number | 'end', playerId: string, amount: number,
): void {
  if (!Number.isSafeInteger(amount) || !isPlayerKey(playerId)) return;
  const chips = ensureChips();
  const at = `${tableId}:${inc}`;
  const endKey = `end:${at}:${playerId}`;
  const end = chips.get(endKey);
  const refunded = isEndRecord(end) && end.p === playerId && endCounts(bookAt(chips, at), end);
  if (outcome === 'end') {
    if (amount <= 0 || refunded) return;
    const seen = entryOf(bookAt(chips, at)?.recs, playerId)?.w ?? '';
    boundDoc!.transact(() => {
      chips.set(endKey, { p: playerId, d: amount, seen });
      recountChipKey(chipIndex, chips, endKey);
      heldDirty = true; // a refund ends what kept bets owe (keptOwed)
    });
    return;
  }
  const book = openBook(chips, tableId, inc, outcome);
  if (!book || refunded) return;
  const was = entryOf(book.recs, playerId);
  if (was && was.r >= outcome) return; // (paid already)
  const rec: BookRec = { d: (BigInt(was?.d ?? '0') + BigInt(amount)).toString(), r: outcome, w: book.id, at: Date.now() };
  writeBook(chips, at, { ...book, recs: { ...book.recs, [playerId]: rec } });
}

/** The incarnation a table takes when its first round opens: it names the
 *  table's book and the lists put down on it. It is drawn from the table and
 *  the record of its removals (its `gone:` marks), not at random: two pages
 *  opening the same table at once, before either hears of the other, name it
 *  alike, so what each settles meets on one book, as their states meet on
 *  one key; a table put back after a removal is a new one. */
export function tableIncFor(tableId: string): string {
  const map = ensureMap();
  const prefix = `gone:${tableId}:`;
  const removals = [...map.entries()].filter(([key]) => key.startsWith(prefix))
    .map(([key, value]): [string, unknown] => [key.slice(prefix.length), value])
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return incName(tableId, removals);
}

function incName(tableId: string, removals: [string, unknown][]): string {
  const named = `ssf-table-inc-v1|${tableId}|${JSON.stringify(removals)}`;
  return bytesToHex(sha256(new TextEncoder().encode(named))).slice(0, 24);
}

const firstIncs = new Map<string, string>();

/** The incarnation a table's state is of. An earlier build's state carries
 *  none, and is the incarnation the table's first round takes (tableIncFor
 *  before any removal): it can only be up until the table's first removal,
 *  so every page names it alike, before and after this build gives it its
 *  `inc` at its next round, and what it settles meets on one book. */
export function tableIncOf(tableId: string, s: { inc?: string }): string {
  if (s.inc !== undefined) return s.inc;
  let first = firstIncs.get(tableId);
  if (first === undefined) {
    first = incName(tableId, []);
    if (firstIncs.size >= 256) firstIncs.clear();
    firstIncs.set(tableId, first);
  }
  return first;
}

/** The name the table's next first round takes (tableIncFor), once any
 *  incarnation of that name that a removal left unmarked (an earlier
 *  build's, which marks nothing) is marked ended: its book or refunds, or
 *  lists carrying it, are still in the doc. Every page reads the same doc,
 *  so pages opening the table at once still name it alike. */
function freshIncFor(map: Y.Map<unknown>, tableId: string): string {
  const chips = ensureChips();
  for (;;) {
    const name = tableIncFor(tableId);
    const refunds = `end:${tableId}:${name}:`;
    const used = chips.has(`book:${tableId}:${name}`) || [...chips.keys()].some((key) => key.startsWith(refunds))
      || [...map.entries()].some(([key, value]) =>
        key.startsWith(`bets:${tableId}:`) && (value as { inc?: unknown } | null)?.inc === name);
    if (!used) return name;
    markRemoved(map, tableId, name);
  }
}

/** Where a table's next round opens: on the incarnation of the state up
 *  there (the book's put back first when that state doesn't go on from it:
 *  putTableBack), going on from the write of the book that state goes on
 *  from (its `bk`); or on a new one (freshIncFor), which first clears what
 *  removed ones left (sweepRemoved). A first round goes on from no settle
 *  and names FIRST_OPENING, alike on every page. In the caller's
 *  transaction. */
export function tableOpening(tableId: string): { inc: string; bk: string } {
  const map = ensureMap();
  putTableBack(tableId);
  const raw = map.get(`table:${tableId}`);
  const up = (isRouletteTableState(raw) || isCrapsTableState(raw)) && !removed(map, tableId, raw) ? raw : null;
  if (up) {
    // An earlier build's state names no book: it goes on from the table's
    // book, if it has one (a state that didn't was put back just now).
    const inc = tableIncOf(tableId, up);
    return { inc, bk: up.bk ?? bookAt(ensureChips(), `${tableId}:${inc}`)?.id ?? FIRST_OPENING };
  }
  const inc = freshIncFor(map, tableId);
  sweepRemoved(map, tableId);
  return { inc, bk: FIRST_OPENING };
}

/** The `bk` of a round that goes on from no settle of its table (its first),
 *  alike on every page, as two pages' openings of a later round from one
 *  settle are: the bets put down on either play in the one the doc keeps.
 *  (No write of a book is named so: those are `<writer>.<n>`.) */
const FIRST_OPENING = '-';

/** Delete the lists of a table's removed incarnations, and refund what the
 *  kept bets of their books still owe (payRemovedOwed). Written at the
 *  moment of the removal, the lists outlived its delete. They hold nothing
 *  here, but an earlier build's page reads a list by its key alone: the
 *  stickman's prune of its list left behind would stand on the table put
 *  back there, and its take-down would hand back again what the kept bets
 *  owe. */
function sweepRemoved(map: Y.Map<unknown>, tableId: string): void {
  for (const key of [...map.keys()]) {
    if (!key.startsWith(`bets:${tableId}:`)) continue;
    const inc = (map.get(key) as { inc?: unknown } | null)?.inc;
    if (typeof inc === 'string' && map.has(goneKey(tableId, inc))) map.delete(key);
  }
  payRemovedOwed(map, tableId);
}

/** Refund, as the removal would have, what the kept bets in the books of a
 *  table's removed incarnations still owe (keptOwed). */
function payRemovedOwed(map: Y.Map<unknown>, tableId: string): void {
  const chips = ensureChips();
  const prefix = `book:${tableId}:`;
  for (const key of [...chips.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const inc = key.slice(prefix.length);
    if (inc.includes(':') || !map.has(goneKey(tableId, inc))) continue;
    for (const pid of Object.keys(bookAt(chips, `${tableId}:${inc}`)?.kept ?? {})) payKeptOwed(map, tableId, inc, pid);
  }
}

/** Every chip record in the bound room (one per page per account, and what
 *  each table's book has paid each bettor), oldest change first (the
 *  history behind a balance; debugging). */
export function readChipRecords(account?: string): ChipRecord[] {
  const chips = ensureChips();
  const out = [...chipIndex.counted.values()].filter((r) => account === undefined || r.p === account);
  for (const key of chipIndex.books.keys()) {
    for (const [p, rec] of Object.entries(bookAt(chips, key.slice('book:'.length))?.recs ?? {})) {
      if (account === undefined || p === account) out.push({ p, d: clampSafe(BigInt(rec.d)), b: 0, c: 0, at: rec.at });
    }
  }
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
  const s = tableStateOf(ensureMap(), tableId);
  return s?.kind === 'roulette' ? s : null;
}

/** `gone:` key of a table's incarnation (see STAKES ON THE FELT). */
function goneKey(tableId: string, inc: string): string {
  return `gone:${tableId}:${inc}`;
}

/** A state of an incarnation the table's removal has ended (written at the
 *  moment of the removal, it outlived the delete). A state an earlier build
 *  wrote has no incarnation and is up only until the table's first removal
 *  (`gone:<tableId>:`), which ended the incarnation it is (tableIncOf): one
 *  written after that is an earlier build's page putting the table back,
 *  and a round this build opens there starts an incarnation of its own. */
function removed(map: Y.Map<unknown>, tableId: string, s: RouletteTableState | CrapsTableState): boolean {
  return map.has(goneKey(tableId, s.inc ?? ''));
}

/** Whether incarnation `inc` of a table has been removed. */
export function tableIncRemoved(tableId: string, inc: string): boolean {
  return ensureMap().has(goneKey(tableId, inc));
}

/** Mark incarnation `inc` of a table ended, and the table removed once. */
function markRemoved(map: Y.Map<unknown>, tableId: string, inc: string): void {
  map.set(goneKey(tableId, inc), 1);
  if (!map.has(goneKey(tableId, ''))) map.set(goneKey(tableId, ''), 1);
}

/** Croupier-only in practice (the UI gates on the house predicate). A
 *  settle writes its settled state with writeSettledState. */
export function writeTableState(tableId: string, state: RouletteTableState): void {
  const map = ensureMap();
  // 📒 Not over a state that doesn't go on from the table's book: that goes
  // back up instead, and the caller writes again from it (putTableBack).
  if (putTableBack(tableId)) return;
  boundDoc!.transact(() => {
    map.set(`table:${tableId}`, state);
    heldDirty = true;
  });
}

/** The settled state in the table's book, to put back over the doc's state
 *  `s` when `s` doesn't go on from the book (THE TABLE'S BOOK): a write of
 *  the round's closing state that isn't a settle (a SPIN or ROLL takeover's
 *  stamp, a deadline cut back) beat a settle made at the same moment on
 *  `table:`, or a page cut off from the room and one that took over both
 *  settled, and the doc kept the state of one and the book of the other.
 *  The table reads as that state at once (tableStateOf), its own round, and
 *  goes up in a fresh write of the book (putTableBack), so no list put down
 *  on an earlier opening of the next round from that book plays on the one
 *  opened from it now. A state an earlier build wrote names no book: it goes on
 *  from the book unless the book has settled its round. Null when `s` goes
 *  on from the book, or there is none. (One of a removed incarnation is of
 *  no state `s` read: those read as no table.) */
function settledAlready<S extends RouletteTableState | CrapsTableState>(tableId: string, s: S): S | null {
  const book = bookAt(ensureChips(), `${tableId}:${tableIncOf(tableId, s)}`);
  if (!book || book.st.kind !== s.kind) return null;
  if (s.bk !== undefined ? s.bk === book.id : book.round < s.round) return null;
  return { ...book.st, bk: book.id } as S;
}

/** The book of a table's incarnation no removal has ended, when the doc's
 *  state is of one a removal ended: a page cut off from the room wrote its
 *  state of the incarnation removed over that of the one the table was put
 *  back on (tableStateOf). */
function liveBook(map: Y.Map<unknown>, tableId: string, kind: 'roulette' | 'craps'): TableBook | null {
  const chips = ensureChips();
  for (const inc of chipIndex.booksOf.get(tableId) ?? []) {
    if (map.has(goneKey(tableId, inc))) continue;
    const book = bookAt(chips, `${tableId}:${inc}`);
    if (book?.st.kind === kind) return book;
  }
  return null;
}

/** The state to put back over the doc's state `raw` of a table (null when
 *  it goes on from the table's book): the book's settled state when `raw`
 *  doesn't go on from it (settledAlready), or the book of the incarnation
 *  the table was put back on when `raw` is of one a removal ended
 *  (liveBook). */
function putBackOver(
  map: Y.Map<unknown>, tableId: string, raw: RouletteTableState | CrapsTableState,
): RouletteTableState | CrapsTableState | null {
  if (!removed(map, tableId, raw)) return settledAlready(tableId, raw);
  const book = liveBook(map, tableId, raw.kind);
  return book ? { ...book.st, bk: book.id } : null;
}

/** 📒 A table's state as it plays: the doc's (`table:`), or the one to put
 *  back over it (putBackOver), which the next write of the table's state
 *  writes (putTableBack). Null for none, or a removed table's. So no round
 *  the book has settled plays again meanwhile, nor holds its lists' chips.
 *  (A removal refunds from the doc's own state, skipping each bettor the
 *  book has settled for that round: tableEndingStakes.) */
function tableStateOf(map: Y.Map<unknown>, tableId: string): RouletteTableState | CrapsTableState | null {
  const raw = map.get(`table:${tableId}`);
  if (!(isRouletteTableState(raw) || isCrapsTableState(raw))) return null;
  const back = putBackOver(map, tableId, raw);
  return back ?? (removed(map, tableId, raw) ? null : raw);
}

/** Put the state to put back over the doc's (putBackOver) up as the
 *  table's, in a fresh write of the book (writeSettledState), so a round
 *  opened from it goes on from a write no list was put down on. True when
 *  it did. Every write of a table's state does it first (and is made again,
 *  if need be, from what went up), and so does a settle, instead of
 *  settling. */
export function putTableBack(tableId: string): boolean {
  const map = ensureMap();
  const raw = map.get(`table:${tableId}`);
  if (!(isRouletteTableState(raw) || isCrapsTableState(raw))) return false;
  const back = putBackOver(map, tableId, raw);
  if (!back) return false;
  // (Not written, and nothing goes on from the state up there either, on a
  // page that may not write the table now: tableWritable.)
  if (tableWritable(tableId)) writeSettledState(tableId, back);
  return true;
}

/** What says this page may write its tables now (croupier's tablesAwake:
 *  not while it waits out a wake). */
let tablesAwakeNow: () => boolean = () => true;
export function setTablesAwakeCheck(check: () => boolean): void {
  tablesAwakeNow = check;
}

/** May this page write table `tableId`'s state and book now? Not on a page
 *  just woken from a sleep (its doc may not have heard the page that took
 *  its tables over meanwhile), nor on one holding part of another page's
 *  update (casinoWhole): a book it wrote then, from what it holds, would
 *  meet the room's as a cut-off page's does, and the doc might keep it. */
export function tableWritable(tableId: string): boolean {
  return tablesAwakeNow() && casinoWhole(tableId);
}

/** How a page comes to close a table: it removes the table itself
 *  (`local`), hears another page remove it (`heard`), or reconciles away a
 *  table of the room it left, which the doc it joined never had
 *  (`elsewhere`). */
export type TableClosing = 'local' | 'heard' | 'elsewhere';

/** 🎰 Wipe every casino key for a table (its state, croupier heartbeat, and all
 *  per-player bets) — the removal teardown so a deleted table leaves no orphan
 *  records. Held stakes go back with their lists; refunding an earlier build's
 *  lists is the CALLER's job (croupier.closeTable), done before this so the
 *  bet records are still readable. Leaves the incarnation's `gone:` mark, so
 *  a state or list written at the same moment stays ended. One transact. */
export function clearTableKeys(tableId: string, closing: TableClosing = 'heard'): void {
  const map = ensureMap();
  const betPrefix = `bets:${tableId}:`;
  boundDoc!.transact(() => {
    // The incarnation removed (an earlier build's state up is the one its
    // next round takes, tableIncOf). With none up here, the one a page that
    // hasn't heard would open the table on (freshIncFor, alike on every
    // page: past any a removal left unmarked, which it marks), so a round
    // opened at the moment of the removal is ended too: when this page
    // removes the table, or hears of a removal that marked nothing (an
    // earlier build's, of a table never removed before). Not when a removal
    // this build made has marked it already: a page that hears of it late
    // changes nothing a table put back is named by. Nor for a table of the
    // room this page left.
    const was = map.get(`table:${tableId}`);
    const up = (isRouletteTableState(was) || isCrapsTableState(was)) && !removed(map, tableId, was) ? was : null;
    if (up) markRemoved(map, tableId, tableIncOf(tableId, up));
    else if (closing === 'local' || (closing === 'heard' && !map.has(goneKey(tableId, '')))) {
      markRemoved(map, tableId, freshIncFor(map, tableId));
    }
    // What kept bets in the books of removed incarnations still owe is
    // refunded (keptOwed), this one's marked ended now. (The books stay:
    // they hold what the table paid.)
    payRemovedOwed(map, tableId);
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
      if (key.startsWith(betPrefix) || key.startsWith(seatPrefix) || key.startsWith(seedPrefix)) map.delete(key);
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
 *  and craps' `base` and `over`), or an earlier build's `bets`, all taken.
 *  Null for junk, or a list put down on another incarnation of the table
 *  than `inc`. */
function storedList<B extends { amount: number }>(
  value: unknown, isBet: (b: unknown) => boolean, at: Incarnation,
): { bets: B[]; taken: number; legacy: boolean; base?: number; pruned?: boolean; over?: string; bk?: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const t = value as {
    held?: unknown; bets?: unknown; inc?: unknown; taken?: unknown; base?: unknown; pruned?: unknown; over?: unknown;
    bk?: unknown;
  };
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
  if ((t.over !== undefined && !isBookId(t.over)) || (t.bk !== undefined && !isBookId(t.bk))) return null;
  return {
    bets, taken: (t.taken as number | undefined) ?? 0, legacy: false,
    ...(t.base !== undefined ? { base: t.base as number } : {}),
    ...(t.over !== undefined ? { over: t.over as string } : {}),
    ...(t.bk !== undefined ? { bk: t.bk as string } : {}),
  };
}

/** The incarnation of a table its lists must carry to play there: the up
 *  state's (tableIncOf), undefined with no table up. */
type Incarnation = string | undefined;

function incarnationOf(tableId: string, s: { inc?: string } | null): Incarnation {
  return s ? tableIncOf(tableId, s) : undefined;
}

/** Whether a stored list was put down on the incarnation `at` of its table.
 *  This build's lists carry the incarnation they were put down on (an
 *  earlier build's state's too, tableIncOf), and so do the stickman's
 *  prunes. An earlier build's own list carries none and goes with whichever
 *  is up: such a page may still be betting. */
function ofIncarnation(t: { inc?: unknown }, held: boolean, at: Incarnation): boolean {
  if (t.inc === undefined) return !held;
  return typeof t.inc === 'string' && isTableIncField(t.inc) && t.inc === at;
}

const stakeOf = (l: { bets: readonly { amount: number }[]; taken: number }): FeltStake => ({
  net: l.bets.reduce((n, b) => n + b.amount, 0) - l.taken,
  taken: l.taken,
});

/** A stored roulette list for its round (see storedList), of the round the
 *  table's state `bk` goes on from: this build's list names the book its
 *  round went on from (`bk`), so a list put down at a round the doc doesn't
 *  keep (on a page cut off from the room, over a run of rounds the doc
 *  dropped) never plays a round of the same number here. An earlier build's
 *  names none, and goes with whichever is up. */
function rouletteList(
  value: unknown, at: Incarnation, bk: string | undefined,
): { round: number; bets: RouletteBet[]; taken: number } | null {
  const round = (value as { round?: unknown } | null)?.round;
  if (!Number.isInteger(round) || (round as number) < 1) return null;
  const list = storedList<RouletteBet>(value, isRouletteBet, at);
  if (!list || list.base !== undefined || (!list.legacy && list.bk !== bk)) return null;
  return { round: round as number, bets: list.bets, taken: list.taken };
}

/** A roulette list that plays the table's current round: that round's, before
 *  it settles. */
function liveRouletteList(
  map: Y.Map<unknown>, tableId: string, playerId: string, s: RouletteTableState | null,
): { bets: RouletteBet[]; taken: number } | null {
  if (!s || s.phase === 'settled') return null;
  const list = rouletteList(map.get(`bets:${tableId}:${playerId}`), incarnationOf(tableId, s), s.bk);
  return list && list.round === s.round ? list : null;
}

export function readMyBets(tableId: string, playerId: string, round: number): RouletteBet[] {
  const map = ensureMap();
  const s = readTableState(tableId);
  const list = rouletteList(map.get(`bets:${tableId}:${playerId}`), incarnationOf(tableId, s), s?.bk);
  return list && list.round === round ? list.bets : [];
}

/** The bettor's own write of their list for `round`, its chips held on the
 *  felt. What an earlier build's list (or one rewritten from it) took goes on
 *  with the rewrite, so nothing is handed back twice. Only while the table
 *  is up (a list on no table would hold nothing), on a doc holding every
 *  update whole, and for a newcomer only while the table has a place
 *  (MAX_TABLE_BETTORS). False when nothing was written. */
export function writeMyBets(tableId: string, playerId: string, round: number, bets: RouletteBet[]): boolean {
  const map = ensureMap();
  const s = readTableState(tableId);
  // (Nor on a doc holding part of an update: the list it rewrites may read
  // as gone. casinoWhole)
  if (!s || !casinoWhole(tableId)) return false;
  if (bets.length > 0 && tableFullFor(readAllBets(tableId, round), playerId)) return false;
  const was = rouletteList(map.get(`bets:${tableId}:${playerId}`), incarnationOf(tableId, s), s.bk);
  const taken = was && was.round === round ? was.taken : 0;
  boundDoc!.transact(() => {
    map.set(`bets:${tableId}:${playerId}`, {
      round, held: bets, inc: tableIncOf(tableId, s),
      ...(s.bk !== undefined ? { bk: s.bk } : {}),
      ...(taken > 0 ? { taken } : {}),
    });
    heldDirty = true;
  });
  return true;
}

/** Most distinct bettors one round of a table takes (what a Fair round's
 *  transcript carries: fairTableSeeds), Fair or not: the close freezes who
 *  is in a round, and a bettor past it would sit the round out. */
export const MAX_TABLE_BETTORS = 31;

/** Is the table full for a newcomer `playerId`, its bets now `all`? (A
 *  bettor already on the felt may go on.) */
function tableFullFor(all: Record<string, unknown>, playerId: string): boolean {
  if (Object.prototype.hasOwnProperty.call(all, playerId)) return false;
  return Object.keys(all).length >= MAX_TABLE_BETTORS;
}

/** Every player's bets for THIS round of one table (the croupier's settle
 *  read; also drives the "on the felt" spectator totals). */
export function readAllBets(tableId: string, round: number): Record<string, RouletteBet[]> {
  const prefix = `bets:${tableId}:`;
  const out: Record<string, RouletteBet[]> = {};
  const map = ensureMap();
  const s = readTableState(tableId);
  const at = incarnationOf(tableId, s);
  for (const [key, value] of map.entries()) {
    if (!key.startsWith(prefix)) continue;
    const list = rouletteList(value, at, s?.bk);
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
  const list = craps ? crapsFelt(map, tableId, playerId, incarnationOf(tableId, craps)) : null;
  return list ? stakeOf(list) : NO_STAKE;
}

/** feltStake for every player with a list on the table (empty ones too: a
 *  list emptied by a rewrite can still carry what it took). */
export function readFeltStakes(tableId: string): Record<string, FeltStake> {
  const map = ensureMap();
  const out: Record<string, FeltStake> = {};
  const s = readTableState(tableId) ?? readCrapsTableState(tableId);
  for (const pid of feltPlayers(map, tableId, incarnationOf(tableId, s))) {
    const stake = feltStake(tableId, pid);
    if (stake.net !== 0 || stake.taken !== 0) out[pid] = stake;
  }
  return out;
}

/** Every player with a list on a table, or craps bets the book of its
 *  incarnation `at` keeps up. */
function feltPlayers(map: Y.Map<unknown>, tableId: string, at: Incarnation): Set<string> {
  const prefix = `bets:${tableId}:`;
  const pids = new Set<string>();
  for (const key of map.keys()) if (key.startsWith(prefix)) pids.add(key.slice(prefix.length));
  if (at !== undefined) for (const pid of Object.keys(bookAt(ensureChips(), `${tableId}:${at}`)?.kept ?? {})) pids.add(pid);
  return pids;
}

/** What a removal hands back, of what an earlier build's lists on the table
 *  took, and on which incarnation: its state's as the doc has it, even one a
 *  removal at the same moment ended already (the page that removed it may
 *  not have seen this round, nor the bets on it). So each page that hears
 *  of the removal refunds what it sees, and each bettor's refund record
 *  pays one refund (creditTableOutcome). Not a roulette list of a round the
 *  incarnation's book has settled for its bettor: a settle the doc's state
 *  doesn't show (a takeover's stamp written as it settled, or the other
 *  side's state after a split) resolved it. Null without a state this build
 *  can name (an earlier build's put back after a removal). */
export function tableEndingStakes(tableId: string): { inc: string; taken: Record<string, number> } | null {
  const map = ensureMap();
  const raw = map.get(`table:${tableId}`);
  if (!(isRouletteTableState(raw) || isCrapsTableState(raw))) return null;
  if (raw.inc === undefined && removed(map, tableId, raw)) return null;
  const inc = tableIncOf(tableId, raw);
  const taken: Record<string, number> = {};
  if (raw.kind === 'craps') {
    for (const pid of feltPlayers(map, tableId, inc)) {
      const list = crapsFelt(map, tableId, pid, inc);
      if (list && list.taken > 0) taken[pid] = list.taken;
    }
  } else if (raw.phase !== 'settled') {
    const book = bookAt(ensureChips(), `${tableId}:${inc}`);
    const prefix = `bets:${tableId}:`;
    for (const [key, value] of map.entries()) {
      if (!key.startsWith(prefix)) continue;
      const pid = key.slice(prefix.length);
      const list = rouletteList(value, inc, raw.bk);
      if (!list || list.round !== raw.round || list.taken <= 0) continue;
      if ((entryOf(book?.recs, pid)?.r ?? 0) >= list.round) continue;
      taken[pid] = list.taken;
    }
  }
  return { inc, taken };
}

// ── 🎲 Craps table state + bets (#69 G3) ─────────────────────────────────────
// Same casino-map keys as roulette (`table:<id>`, `bets:<id>:<pid>`) — a given
// table is one game, so the shapes never collide, and clearTableKeys / the
// table's book / the croupier heartbeat are already game-agnostic. Craps bets are
// NOT round-stamped: they carry across rolls. The player writes `bets:`; at
// each settle the stickman writes what stays up in the table's book (`kept`),
// so the two never write one key (see crapsFelt).

export function readCrapsTableState(tableId: string): CrapsTableState | null {
  const s = tableStateOf(ensureMap(), tableId);
  return s?.kind === 'craps' ? s : null;
}

/** Stickman-only in practice (the UI gates on the house predicate). */
export function writeCrapsTableState(tableId: string, state: CrapsTableState): void {
  const map = ensureMap();
  if (putTableBack(tableId)) return; // (see writeTableState)
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

/** What the kept bets in the book of a removed table incarnation still owe a
 *  player back: what an earlier build took of them, when the settle that
 *  kept them up came at the very moment of the removal and the doc kept it,
 *  so the removal's refund of them doesn't count (endCounts). Owed, in the
 *  player's chips, until it is refunded as the removal would have
 *  (payKeptOwed). */
function keptOwed(map: Y.Map<unknown>, chips: Y.Map<unknown>, tableId: string, inc: string, playerId: string): number {
  if (!map.has(goneKey(tableId, inc))) return 0;
  const book = bookAt(chips, `${tableId}:${inc}`);
  const taken = entryOf(book?.kept, playerId)?.taken ?? 0;
  if (taken === 0) return 0;
  const end = chips.get(`end:${tableId}:${inc}:${playerId}`);
  return isEndRecord(end) && end.p === playerId && endCounts(book, end) ? 0 : taken;
}

/** Refund what a player's kept bets on a removed incarnation owe (keptOwed).
 *  Once refunded, they owe nothing: two pages refunding at once write one
 *  record. */
function payKeptOwed(map: Y.Map<unknown>, tableId: string, inc: string, playerId: string): void {
  const owed = keptOwed(map, ensureChips(), tableId, inc, playerId);
  if (owed > 0) creditTableOutcome(tableId, inc, 'end', playerId, owed);
}

/** 🎲 A player's craps bets as they play, of the two keys: their own list,
 *  unless the stickman has settled a roll since they wrote it, when what that
 *  settle left up (the book's `kept`) plays instead. A list counts as
 *  written after the settle of roll `base - 1` (writeMyCrapsBets), over the
 *  kept bets it names (`over`): it plays only over those very ones, so a
 *  list written before a roll settled (a take-down that crossed the dice),
 *  or on a page cut off from the room over a roll the doc doesn't keep,
 *  never brings back bets the doc's roll resolved: the edit is dropped, the
 *  felt stays as the roll left it. An earlier build's list, which has
 *  neither, plays unless it is the stickman's prune of it (pruneCrapsBets),
 *  which plays only as the book's kept bets: two pages settling one roll can
 *  each prune it, and the doc may keep one page's prune with the other's
 *  book. */
function crapsFelt(
  map: Y.Map<unknown>, tableId: string, playerId: string, at: Incarnation, chips = ensureChips(),
): { bets: CrapsBet[]; taken: number; over?: string } | null {
  const own = crapsOwnList(map.get(`bets:${tableId}:${playerId}`), at);
  const kept = at === undefined ? undefined : entryOf(bookAt(chips, `${tableId}:${at}`)?.kept, playerId);
  // (A list written over kept bets the doc's book doesn't have at all was
  // written over a roll it doesn't keep.)
  if (!kept) return own?.over !== undefined ? null : own;
  const keep = { bets: kept.kept, taken: kept.taken ?? 0, over: kept.w };
  if (!own) return keep;
  if (!own.legacy) return own.base !== undefined && own.base > kept.round && own.over === kept.w ? own : keep;
  // (An earlier build's list newer than the kept bets: a list written over
  // it is over them too.)
  return own.pruned ? keep : { ...own, over: kept.w };
}

export function readMyCrapsBets(tableId: string, playerId: string): CrapsBet[] {
  return crapsFelt(ensureMap(), tableId, playerId, incarnationOf(tableId, readCrapsTableState(tableId)))?.bets ?? [];
}

/** The bettor's own write of their craps list, its chips held on the felt.
 *  `base` is the roll it is for (the next one once a roll has settled), and
 *  `over` the kept bets it was written over (crapsFelt); what an earlier
 *  build's list took goes on with it, as for writeMyBets. Only as for
 *  writeMyBets; false when nothing was written. */
export function writeMyCrapsBets(tableId: string, playerId: string, bets: CrapsBet[]): boolean {
  const map = ensureMap();
  const s = readCrapsTableState(tableId);
  if (!s || !casinoWhole(tableId)) return false; // (see writeMyBets)
  if (bets.length > 0 && tableFullFor(readAllCrapsBets(tableId), playerId)) return false;
  const inc = tableIncOf(tableId, s);
  const felt = crapsFelt(map, tableId, playerId, inc);
  const taken = felt?.taken ?? 0;
  const base = s.phase === 'settled' ? s.round + 1 : s.round;
  boundDoc!.transact(() => {
    map.set(`bets:${tableId}:${playerId}`, {
      kind: 'craps', held: bets, base, inc,
      ...(taken > 0 ? { taken } : {}),
      ...(felt?.over !== undefined ? { over: felt.over } : {}),
    });
    heldDirty = true;
  });
  return true;
}

/** The stickman's record, at the settle of `round`, of a player's bets that
 *  stay up (none: the roll resolved them all), held on the felt from then:
 *  in this page's write of the book (writeSettledState). This build's
 *  player's own list is never written: what an earlier build's list took is
 *  handed back, and the kept bets hold their chips. An earlier build's list
 *  is pruned where it lies, as earlier builds did, so its page reads the
 *  felt as the roll left it, and what it took of the bets that stay stays
 *  taken (`taken`); the prune is marked (`pruned`), and that page's own next
 *  write, which never is, plays as a new list. */
export function pruneCrapsBets(tableId: string, playerId: string, round: number, bets: CrapsBet[]): void {
  if (!isPlayerKey(playerId)) return;
  const map = ensureMap();
  const chips = ensureChips();
  const s = readCrapsTableState(tableId);
  if (!s) return;
  const inc = tableIncOf(tableId, s);
  const book = openBook(chips, tableId, inc, round);
  if (!book) return;
  const key = `bets:${tableId}:${playerId}`;
  const own = crapsOwnList(map.get(key), inc);
  const taken = own?.legacy ? bets.reduce((n, b) => n + b.amount, 0) : 0;
  const kept: BookKept = { round, kept: bets, ...(taken > 0 ? { taken } : {}), w: book.id };
  boundDoc!.transact(() => {
    if (own?.legacy) map.set(key, { kind: 'craps', bets, inc, pruned: round });
    writeBook(chips, `${tableId}:${inc}`, { ...book, kept: { ...book.kept, [playerId]: kept } });
  });
}

/** Every player's standing craps bets on one table (the stickman's settle read;
 *  also drives the "on the felt" spectator view). Empty lists are omitted. */
export function readAllCrapsBets(tableId: string): Record<string, CrapsBet[]> {
  const map = ensureMap();
  const out: Record<string, CrapsBet[]> = {};
  const inc = incarnationOf(tableId, readCrapsTableState(tableId));
  for (const pid of feltPlayers(map, tableId, inc)) {
    const list = crapsFelt(map, tableId, pid, inc);
    if (list && list.bets.length > 0) out[pid] = list.bets;
  }
  return out;
}

/** The players who took every bet down for `round` of the table: their own
 *  list for it (roulette's for the round, a craps list for that roll or an
 *  earlier build's the stickman hasn't pruned) is there, on the table's
 *  incarnation, and empty, and at craps it is the felt that plays. A settle
 *  writes each a record all the same, of nothing, so its book names every
 *  bettor whose list it saw (for the removal refunds: endCounts,
 *  tableEndingStakes). */
export function readEmptiedLists(tableId: string, round: number): string[] {
  const map = ensureMap();
  const roulette = readTableState(tableId);
  const craps = roulette ? null : readCrapsTableState(tableId);
  const at = incarnationOf(tableId, roulette ?? craps);
  const prefix = `bets:${tableId}:`;
  const out: string[] = [];
  for (const [key, value] of map.entries()) {
    if (!key.startsWith(prefix)) continue;
    const pid = key.slice(prefix.length);
    if (roulette) {
      const list = rouletteList(value, at, roulette.bk);
      if (list && list.round === round && list.bets.length === 0) out.push(pid);
    } else if (craps) {
      // (Only a list that is the felt: across a split, one written over the
      // other side's roll can name this roll too, and the doc's kept bets
      // play instead. crapsFelt)
      const own = crapsOwnList(value, at);
      if (own && own.bets.length === 0 && (own.legacy ? !own.pruned : own.base === round)
        && crapsFelt(map, tableId, pid, at)?.bets.length === 0) out.push(pid);
    }
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
 *  that fits, should one id begin with another's), found at its colons, so
 *  a room's removal history doesn't slow every recount. */
function tableOf(ids: { has(id: string): boolean }, rest: string): string | null {
  for (let at = rest.lastIndexOf(':'); at > 0; at = rest.lastIndexOf(':', at - 1)) {
    if (ids.has(rest.slice(0, at))) return rest.slice(0, at);
  }
  return null;
}

/** Chips each player has held on felts (and, below 0, what kept records left
 *  by a removal owe them back: keptOwed). */
function countHeldStakes(map: Y.Map<unknown>, chips: Y.Map<unknown>): Map<string, bigint> {
  const tables = new Map<string, RouletteTableState | CrapsTableState>();
  let gone = false;
  for (const [key, value] of map.entries()) {
    if (key.startsWith('gone:')) gone = true;
    if (!key.startsWith('table:')) continue;
    if (!(isRouletteTableState(value) || isCrapsTableState(value))) continue;
    const tableId = key.slice('table:'.length);
    const s = tableStateOf(map, tableId);
    if (s) tables.set(tableId, s);
  }
  const out = new Map<string, bigint>();
  const add = (pid: string, n: bigint): void => { if (n !== 0n) out.set(pid, (out.get(pid) ?? 0n) + n); };
  if (gone) {
    for (const key of chips.keys()) {
      if (!key.startsWith('book:')) continue;
      const at = key.slice('book:'.length);
      const cut = at.lastIndexOf(':');
      if (cut <= 0 || !map.has(goneKey(at.slice(0, cut), at.slice(cut + 1)))) continue;
      for (const pid of Object.keys(bookAt(chips, at)?.kept ?? {})) {
        add(pid, -BigInt(keptOwed(map, chips, at.slice(0, cut), at.slice(cut + 1), pid)));
      }
    }
  }
  if (tables.size === 0) return out;
  // A craps player's list and kept bets make one felt: count it once.
  const seen = new Set<string>();
  const count = (tableId: string, pid: string): void => {
    if (seen.has(`${tableId}:${pid}`)) return;
    seen.add(`${tableId}:${pid}`);
    const s = tables.get(tableId)!;
    const list = s.kind === 'craps'
      ? crapsFelt(map, tableId, pid, tableIncOf(tableId, s), chips) : liveRouletteList(map, tableId, pid, s);
    if (list) add(pid, BigInt(stakeOf(list).net));
  };
  for (const key of map.keys()) {
    if (!key.startsWith('bets:')) continue;
    const rest = key.slice('bets:'.length);
    const tableId = tableOf(tables, rest);
    if (tableId !== null) count(tableId, rest.slice(tableId.length + 1));
  }
  for (const [tableId, s] of tables) {
    if (s.kind !== 'craps') continue;
    for (const pid of Object.keys(bookAt(chips, `${tableId}:${tableIncOf(tableId, s)}`)?.kept ?? {})) count(tableId, pid);
  }
  return out;
}

function heldStake(playerId: string): bigint {
  // (Counted again only on a doc holding every update whole: a table read
  // as gone there holds nothing, and its bettors' chips would read as free.
  // casinoWhole)
  if (heldDirty && casinoWhole()) {
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
  // (A doc bound holding part of an update, a snapshot the room cache kept
  // of one: counted again once whole. Nothing spends meanwhile:
  // spendableChips)
  heldDirty = !casinoWhole();
  heldTouched.clear();
  doc.on('beforeObserverCalls', (tr: Y.Transaction) => {
    if (casinoMap !== map) return; // a binding we've moved off
    const keys = tr.changed.get(map as unknown as Y.AbstractType<Y.YEvent<any>>);
    const counts = (k: string | null): boolean =>
      k !== null && (k.startsWith('table:') || k.startsWith('bets:') || k.startsWith('gone:'));
    // A table's book too (its kept bets), and a refund: one ends what kept
    // bets owe.
    const books = tr.changed.get(chips as unknown as Y.AbstractType<Y.YEvent<any>>);
    const felts = (k: string | null): boolean => k !== null && (k.startsWith('book:') || k.startsWith('end:'));
    if ((keys && [...keys].some(counts)) || (books && [...books].some(felts))) heldDirty = true;
    // (Not on a doc holding part of an update: the count waits for the rest,
    // and the transaction it comes in counts it. casinoWhole)
    if (!heldDirty || !casinoWhole()) return;
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
  const ownerBalance = spendableChips(ownerId);
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
  const playerBalance = spendableChips(playerId);
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
  const balance = spendableChips(request.player);
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
