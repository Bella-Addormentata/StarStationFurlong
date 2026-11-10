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
 *   bets:<tableId>:<playerId> → { round, held: RouletteBet[], inc, bk?, taken? }
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
 *   cfg:computed:<tableId>    → { v: 1, inc } the table is a computed one,
 *                                        on incarnation `inc` (`c` + 24 hex);
 *                                        anything else there reads as none
 *                                        (see COMPUTED TABLES)
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
 * 🧮 COMPUTED TABLES: a computed roulette table has no operator. Its players
 * write signed, write-once records (computedFold.ts) into the doc's
 * `casinoComputed` map: `ses:<tableId>:<inc>:<sid>`, a nested map holding
 * one session's records, and `sum:<tableId>:<inc>`, the checkpoint a trim
 * leaves of the sessions before it. Every page folds the same records into
 * the same rounds (one TableFold per incarnation, over the session the
 * checkpoint names), and what they decide is two more terms of the chip sum,
 * which nobody writes: each bettor's decided net, in the ledger beside the
 * books (counted for every incarnation with a session or a checkpoint, live
 * or ended, as a book is), and what their felt holds now, beside the lists'
 * (only while the incarnation is live: the switch `cfg:computed:<tableId>`
 * names it, no `gone:` mark ends it, and its checkpoint doesn't say it
 * ended; so a forged or deleted switch moves no decided chip, it only hands
 * open stakes back). Both come from one fold result in one recount, before
 * any observer runs, so a decided round moves its stake from held to paid at
 * once, as a settle does. A trim swaps a session for its checkpoint and the
 * open round's felts in one transaction (writeCheckpointAndTrim), so on a
 * page whose fold agreed nothing moves; an ended incarnation's sessions go
 * later, under a checkpoint saying it ended (finalizeComputed), after which
 * no session of it counts, and its nets count on. A page holding part of
 * an update keeps what it last counted of a table it can't read whole
 * (casinoWhole, which also reads the table as not whole when a session or
 * checkpoint it counted is gone with nothing naming it: frozen, as a table
 * whose book is lost, while the rest of the casino goes on), and spends
 * nothing while any table waits for the rest, or for its signatures to be
 * checked (computedSettled): the checks run 40 ms a pass at most, the rest
 * in empty transactions after, which send nothing to the room.
 *
 * 🏠 A computed table opened by this build is a HOUSE TABLE (computedFold
 * THE HOUSE): the owner's node may add a seed of its own to its rounds. The
 * fold asks this file which keys are houses (houseOkOf: delegated by the
 * room's deed holder, `hk:` records, computedHouse.ts), and the ⚙ card and
 * the duties ask whether one is heard (`hb:` heartbeats) and what the owner
 * set (`hf:` settings), all three at the top level of `casinoComputed`.
 *
 * The cage keeps no stored record at all — everything about the cage is
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
import { asCheckpointFor, asHouseSumFor, compareHouseSum, gameOfInc, houseSumDigest, MAX_SESSION_ROUNDS, MAX_TABLE_PIDS, nextSid, nextSid3, parseKey, recHash, signBytes, TableFold, utf8Length } from './computedFold';
import type { Checkpoint, FoldCtx, FoldResult, GameName, HouseCheck, HouseSum, RedecideCandidate, SigCheck } from './computedFold';
import { asFin, asXf, finKey, isFairOnlyInc, MAX_SMALL_RECORD_BYTES, parseFairOnlyKey, readCk, weightOf, xfId, xfKey } from './computedFairOnly';
import type { CkRead, CkRec } from './computedFairOnly';
import { resolveGame, sigId, tableGame } from './computedFairOnlyAuth';
import type { Resolution } from './computedFairOnlyAuth';
import {
  asBeat, asDelegation, asFairSetting, beatKey, commitHouses, committingHouse, delegationKey, fairAfter, fairSettingKey, HOUSE_HEARD_MS, houseKeyParts,
  houseOfCommit, roomSignBytes,
} from './computedHouse';
import type { DelegationRec, FairSettingRec, RoomKind } from './computedHouse';
import { legacyOwnerMarker } from './roomOwner';
import { getPlayerId } from './identity';
import { fastStrictCheck, fastStrictChecksOn, getIdentityPub, verifyIdentityStrict } from './keypair';
import { forgetRoomHeard, noteRoomHeard } from './roomHearing';

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
  // 👂 Every update this doc applies from the room (not this page's own
  // writes) is the room heard, for the computed tables' forfeits
  // (roomHearing.ts); Yjs tells of one only when it changed something. A doc
  // bound afresh has heard nothing yet.
  forgetRoomHeard();
  doc.on('update', (_u: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
    if (boundDoc === doc && !tr.local) noteRoomHeard();
  });
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
  bindComputed(doc, casinoMap);
  // 🪙 Index the coin pushers' requests now, outside any operator poll, and
  // observe ahead of notify() so listeners never see a stale index.
  pusherRequestIndex(casinoMap);
  casinoMap.observe((event) => {
    if (!touchedAny()) {
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
  /** each computed incarnation's (`<tableId>:<inc>`) decided nets as counted: bettor → chips */
  computed: Map<string, Map<string, bigint>>;
  bought: bigint;
  cashed: bigint;
}
function newChipIndex(): ChipIndex {
  return {
    byAccount: new Map(), counted: new Map(), books: new Map(), ends: new Map(), endsOf: new Map(),
    parked: new Set(), booksOf: new Map(), computed: new Map(), bought: 0n, cashed: 0n,
  };
}
let chipIndex: ChipIndex = newChipIndex();
/** Accounts whose chips changed since the last notify. */
const chipsTouched = new Set<string>();

function addToAccount(ix: ChipIndex, account: string, delta: bigint, touched = chipsTouched): void {
  if (delta === 0n) return;
  ix.byAccount.set(account, (ix.byAccount.get(account) ?? 0n) + delta);
  touched.add(account);
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
 *  resync), at most every RESYNC_ASK_MS whoever asks; none for a page-local
 *  doc. */
let askResync: (() => void) | null = null;
let askedResyncAt = -Infinity;
const RESYNC_ASK_MS = 5_000;

/** Ask the room for what this page is missing, unless it was asked less than
 *  RESYNC_ASK_MS ago, by anyone: one ask brings everything the room has
 *  that this page lacks, so it serves every reason to ask (a part held here,
 *  a seed a computed table waits for), and none starves another — a reason
 *  held back asks once that lapses. Only an ask at `since` or later holds
 *  this one back (every ask so held when left out): one from before brought
 *  nothing written since. Whether it asked now. */
function askRoom(now: number, since = -Infinity): boolean {
  if (!askResync) return false;
  if (now - askedResyncAt < RESYNC_ASK_MS && now >= askedResyncAt && askedResyncAt >= since) return false;
  askedResyncAt = now;
  try { askResync(); } catch (err) { console.warn('[casino] resync failed:', err); }
  return true;
}

/** Ask the room for what this page is missing (computedTable askDuty: a seed
 *  still missing near the end of its grace), under casinoWhole's rate limit
 *  (askRoom), held back only by an ask at `since` or later (the close the
 *  seed is for came in then: an ask from before it, casinoWhole's for a part
 *  it held, brought no seed for it, and waiting out its 5 s would let the
 *  forfeit fall due first). Whether that is done with: asked now, or no
 *  room to ask (a page-local doc); false while a recent ask holds it back
 *  (ask again). The duty asks once per close, so this adds one ask a round
 *  at most to casinoWhole's, and casinoWhole's next waits RESYNC_ASK_MS
 *  from it. */
export function askRoomForMissing(now = Date.now(), since = -Infinity): boolean {
  return askRoom(now, since) || !askResync;
}

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
 *  deletes one), so nothing of that table builds on its absence either. So
 *  is a computed table's session or checkpoint this page counted and the
 *  doc no longer has (computedLost). */
export function casinoWhole(tableId?: string): boolean {
  if (!docHoldsPart() && (tableId === undefined || !tableLost(tableId))) return true;
  askRoom(Date.now());
  return false;
}

/** Whether the bound doc holds part of an update it can't apply yet. */
function docHoldsPart(): boolean {
  // (Deletes Yjs holds back, store.pendingDs, are of writes this page hasn't
  // got at all, which read as not here yet whatever comes: no part read.)
  const store = boundDoc?.store as { pendingStructs: unknown } | undefined;
  return store !== undefined && store.pendingStructs !== null;
}

/** Whether something of table `tableId` this page read is gone from the doc
 *  with nothing in its place: a book, or a computed table's session or
 *  checkpoint (computedLost). The table then reads as not whole for good
 *  (casinoWhole), and only that table. */
function tableLost(tableId: string): boolean {
  return (chipsMap !== null
    && [...(chipIndex.booksOf.get(tableId) ?? [])].some((inc) => !chipsMap!.has(`book:${tableId}:${inc}`)))
    || computedLost(tableId);
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
  // What kept bets owe can end with a transaction of this map alone. When
  // only a computed table moved anything and the transaction changed the
  // casino map too, that map's observer tells it all instead: PR 1 tells
  // such a transaction once, from there (a settle nobody bet on writes a
  // book that moves no chip), and computed records beside it add no notify.
  const casino = doc.getMap<unknown>('casino') as unknown as Y.AbstractType<Y.YEvent<any>>;
  map.observe((_event, tr) => {
    if (chipIndex !== ix || !touchedAny()) return;
    if (chipsTouched.size === 0 && heldTouched.size === 0 && tr.changed.has(casino)) return;
    notify(takeTouched(new Set()));
  });
  // Chips a transaction of neither map moved (what read as gone, counted
  // again as the rest of an update comes in another map's write), and all a
  // transaction of casinoComputed alone moved (bindComputed).
  doc.on('afterTransaction', () => {
    if (chipIndex !== ix || !touchedAny()) return;
    notify(takeTouched(new Set()));
  });
}

/** `keys` with the chip keys of what this transaction's recounts moved
 *  (chipsTouched, heldTouched; computedTouched, the bettors a computed
 *  table's recount moved) and the computed tables whose fold it moved
 *  (viewTouched, `computed:<tableId>`), which are then told: once, by
 *  whichever of the casino maps' observers runs first (the casino map's
 *  when only a computed table moved anything and it changed too), or after
 *  the transaction. */
function takeTouched(keys: Set<string>): Set<string> {
  for (const account of chipsTouched) keys.add(isBankrollAccount(account) ? account : `bal:${account}`);
  for (const pid of heldTouched) keys.add(`bal:${pid}`);
  for (const pid of computedTouched) keys.add(`bal:${pid}`);
  for (const key of viewTouched) keys.add(key);
  chipsTouched.clear();
  heldTouched.clear();
  computedTouched.clear();
  viewTouched.clear();
  return keys;
}

/** Whether this transaction's recounts moved anything to tell (takeTouched). */
function touchedAny(): boolean {
  return chipsTouched.size > 0 || heldTouched.size > 0 || computedTouched.size > 0 || viewTouched.size > 0;
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
 *  comes (heldStake), so chips on a felt would read as free. Nor while a
 *  computed table waits for the rest, or for its signatures to be checked
 *  (computedSettled): a slip not checked yet holds nothing so far. */
function spendableChips(playerId: string): number {
  return casinoWhole() && computedSettled() ? readChips(playerId) : 0;
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
 *  a state or list written at the same moment stays ended. One transact.
 *  🧮 A computed table's incarnation ends with it (its switch goes, a
 *  `gone:` mark ends it: COMPUTED TABLES), unless `keepComputed`: the sweep
 *  of an owner-run round an earlier build opened on a computed table ends
 *  only that round's incarnation. 🔀 `keepConfig`: the table stays (the
 *  switch to computed, that sweep), and so do the house's settings for it. */
export function clearTableKeys(
  tableId: string, closing: TableClosing = 'heard', opts: { keepComputed?: boolean; keepConfig?: boolean } = {},
): void {
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
    // not leave orphaned settings behind (roulette writes only the
    // fairness one). 🔀 A table that stays keeps them: switched to computed
    // (which hides them), its owner-run table comes back on the house's
    // WHEEL or DICE FAIRNESS and SETTLEMENT, not on the defaults.
    if (!opts.keepConfig) {
      map.delete(`cfg:backend:${tableId}`);
      map.delete(`cfg:fairness:${tableId}`);
      map.delete(`cfg:ownerrun:${tableId}`);
    }
    // 🧮 And a computed table's incarnation is over (marked as a removed
    // one is, so a switch written at the same moment stays ended): its
    // decided nets count on, its open felts stop holding (nothing to
    // refund: they took nothing), and its sessions stay until a page
    // compacts them (computedTable). A table put back is owner-run, on a
    // fresh incarnation (tableIncFor counts the mark). (A switch that is
    // junk names nothing to end: it goes as any orphan setting does.) So too
    // every incarnation of it whose session the doc holds live and nothing
    // has ended, the switch naming it or not: one an earlier build's removal
    // took the switch from alone (PR 2's reads a craps name as junk, and
    // marks nothing of it), which a page that ran it would otherwise put
    // back on the table put back under the same id (putComputedSwitchBack).
    if (!opts.keepComputed) {
      const cinc = switchIncOf(tableId);
      // (Not a FAIR ONLY game, one the switch names or not: a removal marks
      // nothing of one, S7. Its end is its authority's.)
      if (cinc !== null && !isFairOnlyInc(cinc)) markRemoved(map, tableId, cinc);
      for (const inc of computedIncsOf.get(tableId) ?? []) {
        const other = computedIncs.get(`${tableId}:${inc}`)!;
        if (inc !== cinc && !other.fo && other.live && !computedIncEnded(tableId, inc)) markRemoved(map, tableId, inc);
      }
      map.delete(`cfg:computed:${tableId}`);
    }
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
//
// 🧮 The lease also says which build drives (`build`): this one writes
// TABLE_BUILD on every claim and renewal, and a build before it renews only
// what it read (page, player, beat), so a lease without one is an earlier
// build's. A computed table can't be switched on while one drives
// (computedTable switchComputedOn): it would go on opening owner-run rounds
// on the table, reading none of the computed records.

/** The build this page's lease carries: 2 knows computed roulette, 3
 *  computed craps. */
export const TABLE_BUILD = 3;
/** The first build that knows each computed game: a table can't switch to
 *  one while an earlier build drives (croupier leaseIsOldBuild). */
export const COMPUTED_MIN_BUILD = { roulette: 2, craps: 3 } as const;

export interface TableOperatorLease {
  /** the driving page (croupier.ts ROULETTE_PAGE_ID) */
  page: string;
  /** its player, the deed holder when it claimed */
  player: string;
  /** bumped on each renewal, so other pages see it is alive */
  beat: number;
  /** the driving page's build (TABLE_BUILD), absent on an earlier build's */
  build?: number;
}

export const TABLE_OPERATOR_KEY = 'table-operator';

export function readTableOperatorLease(): TableOperatorLease | null {
  const v = ensureMap().get(TABLE_OPERATOR_KEY);
  if (typeof v !== 'object' || v === null) return null;
  const l = v as Partial<TableOperatorLease>;
  if (!(typeof l.page === 'string' && l.page.length > 0 && l.page.length <= 256
    && typeof l.player === 'string' && l.player.length > 0 && l.player.length <= 128
    && Number.isSafeInteger(l.beat))) return null;
  // (A build that is no small whole number reads as none: an earlier build's.)
  const build = Number.isSafeInteger(l.build) && l.build! >= 1 && l.build! <= 1000 ? l.build : undefined;
  return { page: l.page, player: l.player, beat: l.beat as number, ...(build !== undefined ? { build } : {}) };
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

/** ⚖️ Whether no list of a bettor's reads for round `round` of the opening
 *  the table's state goes on from: the doc kept the write of it from the
 *  other side of a split (another opening, or another round). A Fair settle
 *  hands back what such a bettor put down, as an RNG one does, rather than
 *  take the list for one rewritten after the close: a write that crossed the
 *  close names the very opening and round it read, so it reads here. */
export function rouletteListLost(tableId: string, playerId: string, round: number): boolean {
  const map = ensureMap();
  const s = readTableState(tableId);
  return rouletteList(map.get(`bets:${tableId}:${playerId}`), incarnationOf(tableId, s), s?.bk)?.round !== round;
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

/** What the book of a table's incarnation `at` kept up of a player's bets. */
function keptEntry(chips: Y.Map<unknown>, tableId: string, playerId: string, at: Incarnation) {
  return at === undefined ? undefined : entryOf(bookAt(chips, `${tableId}:${at}`)?.kept, playerId);
}

/** Whether this build's list of a player's plays over what the book kept up
 *  of their bets (crapsFelt): written after the settle that kept them, over
 *  that very write of them, or over none where the book kept none. */
function ownListPlays(own: { base?: number; over?: string }, kept: { round: number; w: string } | undefined): boolean {
  if (!kept) return own.over === undefined;
  return own.base !== undefined && own.base > kept.round && own.over === kept.w;
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
  const kept = keptEntry(chips, tableId, playerId, at);
  // (A list written over kept bets the doc's book doesn't have at all was
  // written over a roll it doesn't keep.)
  if (!kept) return own && !ownListPlays(own, kept) ? null : own;
  const keep = { bets: kept.kept, taken: kept.taken ?? 0, over: kept.w };
  if (!own) return keep;
  if (!own.legacy) return ownListPlays(own, kept) ? own : keep;
  // (An earlier build's list newer than the kept bets: a list written over
  // it is over them too.)
  return own.pruned ? keep : { ...own, over: kept.w };
}

export function readMyCrapsBets(tableId: string, playerId: string): CrapsBet[] {
  return crapsFelt(ensureMap(), tableId, playerId, incarnationOf(tableId, readCrapsTableState(tableId)))?.bets ?? [];
}

/** ⚖️ Whether a bettor's own craps list is in the doc but doesn't play
 *  (crapsFelt): it was written over a roll the doc doesn't keep, on the other
 *  side of a split, and the book's kept bets (or none) play instead. A Fair
 *  settle then plays the felt as the doc has it, as an RNG roll does, rather
 *  than take the list for one rewritten after the close: a write that crossed
 *  the close was written over the felt it read, so it plays. */
export function crapsListLost(tableId: string, playerId: string): boolean {
  const at = incarnationOf(tableId, readCrapsTableState(tableId));
  const own = crapsOwnList(ensureMap().get(`bets:${tableId}:${playerId}`), at);
  return !!own && !own.legacy && !ownListPlays(own, keptEntry(ensureChips(), tableId, playerId, at));
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

/** Chips each player has held on felts (and, below 0, what the kept bets in
 *  a removed incarnation's book owe them back: keptOwed). */
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
  // 🧮 And what computed felts hold: a running total (recountComputedHeld).
  return (heldStakes.get(playerId) ?? 0n) + (computedHeldBy.get(playerId) ?? 0n);
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

// ── 🧮 Computed tables (see COMPUTED TABLES above) ───────────────────────────

/** The bound doc's computed records (`casinoComputed`): `ses:<tableId>:<inc>:
 *  <sid>` → one session's records, a nested map; `sum:<tableId>:<inc>` → the
 *  checkpoint of the sessions before it. */
let computedMap: Y.Map<unknown> | null = null;

/** A computed incarnation's name: `c` or `r` (roulette), `k` or `d` (craps)
 *  + 24 hex, never one a PR 1 table takes (tableIncFor's 24 hex), so an
 *  earlier build opening a round on the table can't end the computed one by
 *  removing its own. The first letter is the game (computedFold gameOfInc);
 *  a build that reads only `c` names (computed roulette's) sees a craps
 *  switch as junk. This build opens `r` and `d`, house tables (computedFold
 *  houseRules), which a build before it (v0.49 and older) reads as junk too
 *  and leaves alone, rather than play them by rules without the house.
 *
 *  🔒 FAIR ONLY games (`p` roulette, `q` craps: computedFairOnly) are named
 *  apart, by isFairOnlyInc, and only where their records live: the sessions of
 *  one (`ses:`, its first never `g`) and its own top-level records (`ck:`,
 *  `xf:`, `fin:`). A `sum:`, an `hs:` or a `g` session of one is junk to this
 *  build: a page-signed checkpoint is nothing of theirs. A table's switch may
 *  name one (computedCfgInc), as a hint to the game the table plays
 *  (computedIncOf, design S9). */
const COMPUTED_INC = /^[ckrd][0-9a-f]{24}$/;
/** A session's id: `g` for an incarnation's first, else nextSid's 24 hex. */
const COMPUTED_SID = /^(?:g|[0-9a-f]{24})$/;

/** One computed incarnation (`<tableId>:<inc>`) the doc has a session or a
 *  checkpoint of, and what this page counted of it. Kept while the binding
 *  lasts, as a table's books are (booksOf). */
interface ComputedInc {
  t: string;
  inc: string;
  /** `<t>:<inc>` */
  key: string;
  ctx: FoldCtx;
  fold: TableFold;
  /** As last read whole: the checkpoint, the sid it opens, and that
   *  session's map (null for none: no other map of the incarnation counts). */
  cp: Checkpoint | null;
  sid: string;
  live: Y.Map<unknown> | null;
  /** nextSid of the last checkpoint asked about (liveSidOf). */
  sidOf: { cp: Checkpoint | null; sid: string };
  /** Read it whole at its next count: it was parked meanwhile, and what
   *  changed then wasn't applied. */
  stale: boolean;
  /** What computedLost goes by: the session this page last counted from
   *  (null for none). */
  countedSid: string | null;
  /** The last CHAIN_KEPT checkpoints this page counted of it, each as the
   *  doc held it, oldest first: the last is its head (heldBase). One that
   *  reads as a rewind or a jump of the head (recoveryTrigger) never
   *  becomes one, so the head is only ever followed forward. */
  chain: Counted[];
  /** ⚠ The rounds this page gave up on when the session they were decided
   *  in was deleted with nothing in its place (giveUpComputed), until the
   *  next checkpoint. */
  gaveUp: { sid: string; from: number; to: number } | null;
  /** How many counts found the doc's checkpoint of it putting no restore in
   *  motion (recoveryTrigger null): a restore's wait starts afresh once one
   *  did, though the recovery duty never looked at the doc meanwhile (the
   *  head put back by another page, then junk again in one tick). */
  calm: number;
  /** The result last counted (null: none yet), and whether its felts held
   *  then (the incarnation was live). */
  last: FoldResult | null;
  liveHeld: boolean;
  /** When this page first saw each record key in the live session
   *  (Date.now()): computedSeenAt. */
  seen: Map<string, number>;
  /** The sessions of the jumps this page refuted (recoveryTrigger 'jump'),
   *  and of every checkpoint it saw built on one, the last REFUTED_KEPT:
   *  no honest page writes a jump, so nothing built on one is honest, and
   *  a trim of a jump's session (by a page that counted it: an earlier
   *  build's, or one that came while it stood) is restored over too. */
  refuted: string[];
  /** 🩹 The sessions of the heads this page gave way over (noteCounted: it
   *  took them at load, and the pages that counted the head put theirs
   *  back), the last REFUTED_KEPT: one of them written again is taken as
   *  at load again (Counted firmAt), not as the head it once was. */
  dropped: string[];
  /** 🩹 The hashes of slips whose players may have let them go, seeds and
   *  all, as a page of an earlier build does when the table moves on from
   *  their session (noteDoubted), the last DOUBTED_KEPT: should that session
   *  come back, this page's closes freeze none of them but its own
   *  player's (computedTable closeDuty), and their stakes go back instead
   *  of being forfeited. */
  doubted: Set<string>;
  /** Whether a rewind or a jump stood at this page's last count
   *  (recoveryTrigger): its head back, noteDoubted. */
  forged: boolean;
  /** 🔒 The page-signed incarnation the switch named since it last named this
   *  one (as this page counted it): another of this table's game that the doc
   *  held and nothing had ended. This one is over then, a FAIR ONLY game played
   *  or not, and for good: its pages let go of its slips and put that other's
   *  state in its place (switchLeft, switchLeftFor, computedTable supersede),
   *  and a FAIR ONLY name the switch carries afterwards is S9's hint to the
   *  game the table plays, not a way back to this one (switchHoldsFelts,
   *  computedEndedIncs), so its stakes stay free and compaction goes on, even
   *  if the other ends. Only the switch naming this one again undoes it (null).
   *  (An incarnation the switch never named is counted as left from its first
   *  count with the switch on another: nothing will return to it.)
   *  The doc keeps no history of its switch: this is this page's own reading of
   *  it; a page that never counted the switch naming the other (the writes
   *  reached it in one batch, or it was bound after) still reads such a hint as
   *  holding this one, as before. */
  leftFor: string | null;
  /** 🔒 Whether this incarnation takes a place when the switch names it, as this
   *  page last read it: the doc holds it and nothing has ended it
   *  (computedIncEnded). False until it is first tracked; read where the doc is
   *  bound, and again whenever its records move (countTransaction). When it
   *  turns, in either direction (it is counted for the first time, its removal's
   *  mark is deleted or written, its end checkpoint is written over or comes),
   *  and the switch names it, the table's other page-signed incarnations are
   *  counted again: the switch naming it takes their places (`leftFor`), or holds
   *  their felts beside a live game (otherGameStands), or no longer does. */
  takesPlace: boolean;
  /** 🔒 What this page holds of a FAIR ONLY game (PR 6c-4a): null at every
   *  other table. Such a game has no chain, no recovery and no doubt: its
   *  checkpoints are the house's and its authority's, and the authority
   *  resolver (computedFairOnlyAuth) says which stands. */
  fo: FairOnlyState | null;
}

/** 🔒 A delegation a page holds of a FAIR ONLY game's house (FairOnlyState
 *  heldHks): the value as the doc held it, its hash, and its signer's place in
 *  the game's chain of holders (its last, of a key that held the game twice). */
interface HeldDelegation {
  value: unknown;
  hash: string;
  at: number;
}

/** What a page holds of one FAIR ONLY game (ComputedInc fo). */
interface FairOnlyState {
  /** The game's records as the doc holds them now, by doc key: kept from the
   *  keys each transaction changed, never read by scanning the doc. */
  cks: Map<string, unknown>;
  xfs: Map<string, unknown>;
  fin: unknown;
  /** The resolver's answer as last made (null before the first). */
  res: Resolution | null;
  /** The checkpoint this page last counted from, as the doc held it (design
   *  §8.3 S4's X): offered to the resolver as if the doc still held it, so a
   *  checkpoint deleted from the doc, or an older one put in its place, moves
   *  nothing. Replaced when a resolution names another base, and never given
   *  up while the doc is bound: the record proves itself, so a peer that goes
   *  on deleting it takes it from the doc and from no page that counted it
   *  (the put-back duty stands down meanwhile: computedTable fairKeepDuty). */
  held: { key: string; value: CkRec } | null;
  /** 🔒 …and the one it last counted from under a resolution that waited for
   *  no check (the same record as `held` after such a count; null before the
   *  first). A resolution that waits may have stopped its chain short of the
   *  holder that signed the held base (a transfer whose check was put off cuts
   *  the chain there, and a forged one costs a peer nothing), and names the
   *  best base of the holders before: an older checkpoint a peer wrote again,
   *  say. The page counts from that one meanwhile and holds it, and holds
   *  this one beside it: both are offered to the resolver, so the answer that
   *  has every check names its base from them and the doc's, whatever the doc
   *  lost while the page waited. Replaced only at a count whose resolution
   *  waited for nothing. (A base that only counts that waited went by is held
   *  until a count names another: a page is sure of none it never counted
   *  whole.) */
  heldWhole: { key: string; value: CkRec } | null;
  /** 🔒 What else the page's count stands on, as the doc held it (PR 6c-4b-2;
   *  keepStanding, settleStanding, keepHouses): the transfers of the game's
   *  chain, by their keys (`xf:`; one found only inside a checkpoint, by the
   *  key that is its own); the end order standing, as a resolution handed it
   *  back (the `fin:` key's value, or the one inside an end checkpoint;
   *  undefined: none). Every resolution adds what it stands on (each transfer
   *  of its chain; its end order when the page holds none), and what an answer
   *  stands on no more is let go of only where the page counts from the base
   *  of one that waited for no check: an answer is no count yet, and until the
   *  page holds the base it names the game may be back at the base the page
   *  does hold, on what that one stood on. And the delegations (by their houses' keys, `hk:`) of the houses whose records
   *  the fold of its live session counted (`houseUsed`: every key its
   *  HouseCheck answered true for since the game was last resolved, when the
   *  fold asks them all again, each with the delegations the resolution went by
   *  for it then, Resolution houseBy, by their hashes): the ones the count went
   *  by, wherever the resolution found them (under the house's key, in an older
   *  checkpoint of the game, among the ones this page offered it), but for one
   *  the base carries, which the page holds with the base; and each good one by
   *  a holder of the game that this page has seen under the house's key. The
   *  latest holder's last (a key holds one value, and after a hand-over the
   *  buyer may delegate the node the seller did).
   *  Offered to the resolver as if the doc held them still, as the base is: a
   *  transfer, an end order and a delegation each prove themselves and nothing
   *  takes one back, so one a peer deleted, or wrote something else over, moves
   *  nothing on a page that counted it, and the page puts it back
   *  (computedFairOnlyRecoveries, putBackFairOnlyRecords). */
  heldXfs: Map<string, unknown>;
  heldFin: unknown;
  heldHks: Map<string, HeldDelegation[]>;
  houseUsed: Map<string, Map<string, DelegationRec>>;
  /** …and, by the key of each house whose delegations are held, the keys of
   *  the bases they are kept for (null: an answer that named no base): the
   *  base of each count that went by a record of the house (keepHouses), and
   *  the base each answer named while the game was not counted, its table not
   *  whole (noteHousesParked). While the game counts from one of them, the
   *  delegation of a house no record of the live session is of now stays
   *  held: the rounds it decided are in no checkpoint yet, and its records are
   *  on their way back (a session's map a peer deleted, opened again empty; a
   *  record a peer deleted and its author puts back). A count that waited for
   *  nothing settles it: the houses it keeps are kept for its base alone from
   *  there, and a house no record is of that is not kept for that base is let
   *  go of (the game moved on), and kept again from the resolution itself if
   *  a record of its house counts after that: a count goes by nothing this
   *  page does not hold. */
  hkUnder: Map<string, (string | null)[]>;
  /** 🔒 Under the keys of the delegations held, the values the last look found
   *  there that are no good delegation of the house by a holder of the game (a
   *  stranger's, or one whose signature fails): the held one is written over
   *  them (fairOnlyLacks). Looked at after each count, and while the game is
   *  not counted because its table is not whole (keepHouses). And whether one
   *  waited for its check then (`hkWaits`: it is left for now, and the slice
   *  that checks it looks again). */
  hkOver: Map<string, unknown>;
  hkWaits: boolean;
  /** 🔒 Whether the doc lacked something this page holds of the game (or, of
   *  the game its table plays, the table's switch or the table) when that
   *  was last told (noteFairOnlyLacks: after each count, and while the game is
   *  not counted because its table is not whole), and how many times since the
   *  doc was bound all of it was found there again after it was not: a
   *  put-back, this page's or another's (computedFairOnlyReturns; the put-back
   *  duty counts the ones that do not last). */
  lacking: boolean;
  returns: number;
  /** 🔒 How many times, since the doc was bound, a transaction changed the key
   *  of a session of the game (a map came, went, or was written over): each
   *  time the map of the session its base opens goes is a disappearance of its
   *  own for the page that waits to open it again, though it came and went
   *  between two of its looks. The key of ANY session of the game counts, the
   *  base read or not: while a check is waited for the game names no base
   *  (fairOnlySessionOf is null), and which session a change was of cannot be
   *  told then. So the wait is for the game's sessions at rest, and a key of
   *  another session that comes or goes starts it again
   *  (computedFairOnlyRecoveries sesMoves; computedTable openStep). */
  sesMoves: number;
  /** The base the fold was last pointed at (null: none; undefined: never). */
  folded: CkRec | null | undefined;
  /** nextSid3 of the checkpoint last asked about (sid3Of). */
  sidFor: CkRec | null;
  sid: string;
  /** 🔒 The keys this page hears as the game's houses (noteBeat; PR 6c-4b-1b): the
   *  ones a close of the open round could name the commitment of (computedHouse
   *  commitHouses): the committing house and the signers of the joins the open round
   *  lists (at most MAX_CLOSES_PER_ROUND). Empty while the game is not live. A
   *  stranger gets a key in only by signing a join the fold counted. */
  houses: ReadonlySet<string>;
  /** …of them, the house that holds the seed behind the commitment a close must
   *  name, while it is one of the game's for the open round (computedHouse
   *  committingHouse), or undefined. Found where the game is counted, not at each
   *  tick: the resolution's houseAt scans the room's delegations. */
  committing: string | undefined;
  /** …and whether that search waited: a delegation's signature was put off (houseAt
   *  answered undefined), so `committing` may be a house not found yet. The slice
   *  that checks it counts the game again (countTransaction), as it does a result
   *  whose fold waited. */
  committingWaits: boolean;
}

/** A checkpoint this page counted: the value the doc held (put back as it
 *  is: every page that counted it writes the same bytes), as read, the
 *  session it opens, and the signers of every felt this page counted in
 *  that session (at most MAX_TABLE_PIDS): the players who take turns at
 *  putting it back, though a rewind or a jump has the page counting
 *  another session meanwhile (computedRecoveries pubs). */
interface Counted {
  value: object;
  cp: Checkpoint;
  sid: string;
  pubs: Set<string>;
  /** 🩹 From when this page puts it back over a rewind (its time, as
   *  counted): 0 for a checkpoint it saw come, built on the session it was
   *  counting from, or after one it put back so; TAKEN_WAIT_MS after it
   *  took one it never saw come (at load, mostly), for it and what comes
   *  after it meanwhile. Until then a rewind the page can't tell from the
   *  head others counted gives way (noteCounted). */
  firmAt: number;
  /** 🩹 Whether this page SAW this checkpoint come — built on the session it
   *  was counting from, or extending one it saw come — rather than taking it
   *  at load. A seen head is grounded: a rewind of it is a forgery (its
   *  session refuted, noteCounted; it is defended, never given way). An
   *  unseen head (load-taken) can't be told from a peer's replay, so it gives
   *  way — within TAKEN_WAIT_MS of load (firmAt), and, past that (a
   *  partition outlasting the window), once its restore keeps losing to a
   *  persistent rival the room puts back over it (computedTable restoreStep →
   *  giveWayComputed), which no fixed timeout can cover. */
  seen: boolean;
}

/** Checkpoints of an incarnation kept to put back (ComputedInc chain). */
export const CHAIN_KEPT = 8;
/** Refuted sessions kept per incarnation (ComputedInc refuted), and the
 *  sessions of heads given way over (ComputedInc dropped). */
const REFUTED_KEPT = 64;
/** 🩹 How long a checkpoint this page never saw come (it was there when the
 *  page loaded) gives way to a rewind (Counted firmAt): longer than the
 *  longest a page that counted the head before a peer's jump waits to put
 *  it back (computedTable RESTORE_WAIT_MS + RECOVERY_PLACES × STAGGER_MS +
 *  OUTSIDER_WAIT_MS), so the head such a page puts back is never fought
 *  over by a page that took the jump. */
export const TAKEN_WAIT_MS = 45_000;
/** Doubted slips kept per incarnation (ComputedInc doubted). */
const DOUBTED_KEPT = 1_024;

/** What sets a checkpoint's restore going (recoveryTrigger). */
export type RecoveryTrigger = 'junk' | 'rewind' | 'jump' | 'end';

/** 🧪 Whether this page holds its base, and the recovery duties run
 *  (computedTable recoverDuty): off, it reads as v0.50 pages do, a deleted
 *  checkpoint freezing the table (computedLost). The sims' older pages. */
let recoveryOn = true;

/** 🧪 Hold the base and recover (true, the default), or read as v0.50 does. */
export function setComputedRecoveryForTests(on: boolean | null): void {
  recoveryOn = on ?? true;
}

/** Whether this page holds its base and runs the recovery duties. */
export function computedRecoveryOn(): boolean {
  return recoveryOn;
}

let computedIncs = new Map<string, ComputedInc>();
/** tableId → the incarnations of it tracked. */
let computedIncsOf = new Map<string, Set<string>>();
/** 🔒 The page-signed incarnations tracked since the last transaction was
 *  counted, whichever record brought each (trackComputed): countTransaction
 *  reads each (ComputedInc.takesPlace) with the ones the transaction changed,
 *  and counts the table's others again when the switch names one that has come
 *  to take a place. */
let newlyTracked: ComputedInc[] = [];
/** What each incarnation's felts hold, as counted (none while it isn't
 *  live): bettor → chips. */
let computedHeld = new Map<string, Map<string, bigint>>();
/** Σ computedHeld per bettor, what heldStake adds: a running total, so no
 *  read walks the tables. */
let computedHeldBy = new Map<string, bigint>();
/** Incarnations whose last counted values stand until the doc holds them
 *  whole again (casinoWhole), as parked chip keys do. */
const computedParked = new Set<string>();
/** Each incarnation's signature verdicts, by record hash. */
let computedVerdicts = new Map<string, Map<string, boolean>>();
/** 🔒 The room's delegations the resolver can use (`hk:<pub>` → value, those
 *  fedDelegation takes) as the doc holds them, kept from the keys each
 *  transaction changed: a FAIR ONLY game's house may be delegated there as well
 *  as in its checkpoints (the resolver reads both). Anything else a guest writes
 *  under an `hk:` key is nothing to a game and is not kept. */
let hkRaw = new Map<string, unknown>();
/** …of them, as a list for the resolver; null when it is to be made again (hkFeedOf). */
let hkFeed: unknown[] | null = null;
/** 🔒 The FAIR ONLY games to resolve again before anything is counted
 *  (refreshFairOnly): a record of one or a delegation of the room moved, a
 *  check that waited may be done, or the game is new. */
let staleGames = new Set<ComputedInc>();
/** 🔒 The FAIR ONLY games that may have something to put back (PR 6c-4b-2;
 *  computedFairOnlyRecoveries): the ones resolved since the duty last found
 *  them whole (a record of theirs, or a delegation of the room, moved), the
 *  ones a count found lacking, and those whose session's key moved. A game
 *  leaves when the doc holds all the page holds of it, so a tick looks at no
 *  game nothing happened to. */
let foCheck = new Set<ComputedInc>();
/** 🔒 How many FAIR ONLY games this page tracks: with none, the game a table
 *  plays is its switch's, as it always was (computedIncOf), at no cost. */
let foGames = 0;
/** 🔒 The game each table with a FAIR ONLY game played as last looked at
 *  (notePlayedGames; null: none), and where S9's choice moved from one FAIR
 *  ONLY game to another since this page bound the doc (the ⚙ card's 🚩 THE
 *  TABLE'S GAME MOVED: computedGameMovedOf). */
let foPlayed = new Map<string, string | null>();
let foMoved = new Map<string, { from: string; to: string }>();
/** 🔒 Which games have a live FAIR ONLY game at each table as last looked at (bit 1:
 *  roulette, bit 2: craps; a table with none has no entry): a name of the other game
 *  holds a page-signed incarnation's felts beside a live game of its own game only
 *  (otherGameStands), and a second game of the other letter opening or ending moves
 *  that though the game played does not (S9 goes by the holder, the switch and the
 *  lowest name, and no letter). */
let foLivesOf = new Map<string, number>();
/** 🔒 How many times, by table, the game it plays moved to or from a live FAIR ONLY
 *  game since this page bound the doc: one opened, one ended, or S9's choice went from
 *  one to another (computedGameMovesOf). */
let foMoves = new Map<string, number>();
/** 🔒 The tables with a FAIR ONLY game this page tracks, and the ones
 *  notePlayedGames is to look at next: a table a game of which was resolved
 *  again, or whose switch changed, or all of them when the deed holder's key
 *  did (foLookAll): S9's choice goes by nothing else. Not every table of the
 *  doc on every transaction (junk under a well-formed key tracks a game, and a
 *  guest can write many). */
let foTables = new Set<string>();
let foLook = new Set<string>();
let foLookAll = false;
/** 🔒 The live games of each table (their resolutions, by incarnation): what S9 chooses
 *  among (computedIncOf), kept where a game is resolved (resolveFairOnly), so that a
 *  table with many games that are not live (junk under well-formed keys starts one each)
 *  costs a call no more than a table with none. */
let foLive = new Map<string, Map<string, Resolution>>();
/** 🔒 The room's layout (the doc's `furniture` map, furnitureDoc's: a table's
 *  placement under its id), and of each table with a FAIR ONLY game this page
 *  tracks the last placement it saw there, since the doc was bound, of a
 *  roulette table and of a craps table: what the pages put back when the table
 *  of a live game is taken out of the room (design §8.4 P5: fairOnlyTableOut,
 *  putBackFairOnlyTable). Each game's kind of table is kept apart: a table of
 *  the other game written under the id is not the game's table, and takes
 *  nothing from what is held of it. And how many times, by table, a
 *  transaction changed the layout's key of it: a table that came back and went
 *  again between two looks of a page is another disappearance (FairOnlyRecovery
 *  tableMoves). */
let layoutMap: Y.Map<unknown> | null = null;
let tableSeen = new Map<string, Map<GameName, unknown>>();
let tableMoves = new Map<string, number>();
/** 🔒 The verdicts on the signatures a FAIR ONLY game's resolution asks about
 *  (authCheck), by sigId: one map for every game of the room, since an id
 *  binds what it covers (a record copied into another game is another thing
 *  to check there). The latest AUTH_VERDICTS_MAX, the oldest going first, as
 *  houseVerdicts: the verdicts of the fold's records are per incarnation and
 *  let go of what a new session doesn't hold (readComputedWhole), but these
 *  are of checkpoints and chains, which no session holds. */
let authVerdicts = new Map<string, boolean>();
const AUTH_VERDICTS_MAX = 2_048;
let authVerdictsMax = AUTH_VERDICTS_MAX;
/** The computed tables (`computed:<tableId>`) whose fold moved since the
 *  last notify (takeTouched). */
const viewTouched = new Set<string>();
/** The bettors whose chips a computed recount moved since the last notify
 *  (nets or felts): apart from PR 1's chipsTouched and heldTouched, so the
 *  chips map's observer can tell what PR 1 would have told from there. */
const computedTouched = new Set<string>();
/** A player's key was pinned since the last recount: every felt is read
 *  again (pinPlayerKeys). */
let computedKeysMoved = false;
const NO_COMPUTED_HELD: ReadonlyMap<string, bigint> = new Map();
/** The page's clock as a transaction began (onComputedTransaction), or null
 *  outside one: every arrival it brings is stamped with the same time, so a
 *  throw and a close that came in one update read as having come together. */
let txNow: number | null = null;
/** 🎲 When this page first saw each dice throw (`throw:<tableId>` values,
 *  by table, then `<round>|<by>|<seed>`): a computed craps table plays a
 *  throw only if it came before the roll's close (computedThrowSeenAt). The
 *  last THROWS_KEPT per table. */
let throwSeen = new Map<string, Map<string, number>>();
const THROWS_KEPT = 8;

/** The incarnation a casinoComputed key is of: `ses:<t>:<inc>:<sid>` (with
 *  its sid) or `sum:<t>:<inc>`, parsed from the right (an incarnation and a
 *  sid hold no ':', a table id may). Null for any other key. */
function computedKeyParts(key: string): { t: string; inc: string; sid?: string } | null {
  let rest: string;
  let sid: string | undefined;
  if (key.startsWith('ses:')) {
    const cut = key.lastIndexOf(':');
    sid = key.slice(cut + 1);
    if (cut <= 'ses:'.length || !COMPUTED_SID.test(sid)) return null;
    rest = key.slice('ses:'.length, cut);
  } else if (key.startsWith('sum:')) {
    rest = key.slice('sum:'.length);
  } else {
    return null;
  }
  const cut = rest.lastIndexOf(':');
  const inc = rest.slice(cut + 1);
  // (A FAIR ONLY game has sessions and nothing else here: no `g`, no `sum:`.)
  const named = COMPUTED_INC.test(inc) || (sid !== undefined && sid !== 'g' && isFairOnlyInc(inc));
  return cut > 0 && named ? { t: rest.slice(0, cut), inc, ...(sid !== undefined ? { sid } : {}) } : null;
}

/** The FAIR ONLY game a top-level key is a record of: `ck:<t>:<inc>:<id>`
 *  (a checkpoint), `xf:<t>:<inc>:<id>` (a transfer) or `fin:<t>:<inc>` (an end
 *  order). Null for any other key, a malformed one, and `do:<nonce>` (a deed
 *  offer belongs to no game until a transfer carries it). */
function fairOnlyKeyParts(key: string): { kind: 'ck' | 'xf' | 'fin'; t: string; inc: string } | null {
  const at = parseFairOnlyKey(key);
  return at !== null && at.kind !== 'do' ? { kind: at.kind, t: at.t, inc: at.inc } : null;
}

const sessionKey = (t: string, inc: string, sid: string): string => `ses:${t}:${inc}:${sid}`;

/** The top-level key an incarnation's owner-signed checkpoint is stored under
 *  (`hs:<t>:<inc>`, PR 6a-2). Not a `computedKeyParts` key: v0.50 pages and
 *  the node neither read nor write it, and a change to it never re-folds the
 *  incarnation (an hs: is checked, not played). */
const houseSumKey = (t: string, inc: string): string => `hs:${t}:${inc}`;

/** The incarnation an `hs:<t>:<inc>` key is of, parsed from the right (an
 *  incarnation holds no ':', a table id may), or null for any other key. */
function houseSumKeyParts(key: string): { t: string; inc: string } | null {
  if (!key.startsWith('hs:')) return null;
  const rest = key.slice('hs:'.length);
  const cut = rest.lastIndexOf(':');
  const inc = rest.slice(cut + 1);
  return cut > 0 && COMPUTED_INC.test(inc) ? { t: rest.slice(0, cut), inc } : null;
}

const checkpointCache = new WeakMap<object, { inc: string; cp: Checkpoint | null }>();
const houseSumCache = new WeakMap<object, { inc: string; hs: HouseSum | null }>();

/** The value stored at `hs:<t>:<inc>` read for its shape (asHouseSumFor, design
 *  §6.1a steps 1–4; once per value), null for none or junk. The checker's key
 *  authority (step 5) and the `'hsum'` signature (step 6) are applied by the
 *  caller (authorityOkHouseSum, houseSumOk). */
function houseSumAt(map: Y.Map<unknown>, t: string, inc: string): HouseSum | null {
  const value = map.get(houseSumKey(t, inc));
  if (typeof value !== 'object' || value === null) return null;
  let hit = houseSumCache.get(value);
  if (hit?.inc !== inc) {
    hit = { inc, hs: asHouseSumFor({ inc })(value) };
    houseSumCache.set(value, hit);
  }
  return hit.hs;
}

/** An incarnation's checkpoint as stored (its game's asCheckpoint, once per
 *  value: up to 4,096 nets to check); null for none, or junk. */
function checkpointAt(map: Y.Map<unknown>, t: string, inc: string): Checkpoint | null {
  const value = map.get(`sum:${t}:${inc}`);
  if (typeof value !== 'object' || value === null) return null;
  let hit = checkpointCache.get(value);
  if (hit?.inc !== inc) {
    hit = { inc, cp: asCheckpointFor({ inc })(value) };
    checkpointCache.set(value, hit);
  }
  return hit.cp;
}

/** The sid of the session checkpoint `cp` opens (nextSid, hashed once per
 *  checkpoint: casinoWhole asks every frame). */
function liveSidOf(c: ComputedInc, cp: Checkpoint | null): string {
  if (cp !== c.sidOf.cp) c.sidOf = { cp, sid: nextSid(c.ctx, cp) };
  return c.sidOf.sid;
}

/** The checkpoint incarnation `c` counts from: the doc's, or while the doc
 *  holds none (deleted, or junk in its place: no build writes either) the
 *  head this page counted (the held base). The page folds from it, and
 *  writes into the session it opens, while the recovery duty puts it back
 *  (computedTable recoverDuty), so a peer's delete or junk loop stops no
 *  table on it: its counts are the ones every page reaches once the head
 *  is back. A page that never counted one reads the doc as it is. */
function heldBase(c: ComputedInc, map: Y.Map<unknown>): Checkpoint | null {
  const cp = checkpointAt(map, c.t, c.inc);
  if (cp !== null || !recoveryOn || c.chain.length === 0) return cp;
  return c.chain[c.chain.length - 1].cp;
}

/** heldBase of incarnation `inc` of table `tableId`: the doc's checkpoint
 *  for one this page doesn't track. 🔒 A FAIR ONLY game's is the one its
 *  resolution names (null for none, or a game this page doesn't track): a
 *  `sum:` of its name is junk, never read. */
function baseOf(tableId: string, inc: string): Checkpoint | null {
  const c = computedIncs.get(`${tableId}:${inc}`);
  if (isFairOnlyInc(inc)) return c?.fo?.res?.base?.ck ?? null;
  return c ? heldBase(c, computedMap!) : checkpointAt(computedMap!, tableId, inc);
}

/** The tracked incarnation `inc` of table `tableId` if its checkpoints are a
 *  page's to sign, else undefined: not a FAIR ONLY game (a `p…` or `q…` name),
 *  whose checkpoints are its house's and its authority's, and which the
 *  recovery, the finalising and the switch below have no part in. */
function ordinaryInc(tableId: string, inc: string): ComputedInc | undefined {
  const c = computedIncs.get(`${tableId}:${inc}`);
  return c && !c.fo ? c : undefined;
}

/** 🏛️ The owner-signed checkpoint that takes part in incarnation `c`'s
 *  restores (design §6.2 F): the best valid `hs:` this page counted
 *  (bestHouseSum), by a checker whose authority stands — unless this page saw
 *  the deed change hands during its visit (B1 fix 3: a holder it watched take
 *  the deed could be a cheat writing `roomInfo.owner`; a page that loads after
 *  trusts the deed holder it finds, as PR 5 does). The label still shows it. */
function houseSumTakesPart(c: ComputedInc): HouseSum | null {
  if (deedChangedSeen) return null;
  const a = houseSumSeen.get(c.key);
  return a !== undefined && authorityOkHouseSum(a) ? a : null;
}

/** 🏛️ An owner-signed checkpoint as the value a restore of it writes into
 *  the checkpoint key (B14.1): its checkpoint fields {v,b,u,l,n,e?,s?,h?}
 *  with its own `k` and `g` — byte-identical on every page that restores it
 *  (no build verifies a checkpoint signature, so a value whose `g` is an
 *  'hsum' signature reads like any other). One object per record, so a
 *  restore in motion keeps its identity across counts (computedTable
 *  restoreStep tracks its last write). */
const houseSumAsCheckpoint = new WeakMap<HouseSum, object>();
function cpValueOfHouseSum(a: HouseSum): object {
  let v = houseSumAsCheckpoint.get(a);
  if (!v) {
    v = {
      v: a.v,
      b: a.b,
      u: a.u,
      l: a.l,
      n: a.n,
      ...(a.e !== undefined ? { e: a.e } : {}),
      ...(a.s !== undefined ? { s: a.s } : {}),
      ...(a.h !== undefined ? { h: a.h } : {}),
      k: a.k,
      g: a.g,
    };
    houseSumAsCheckpoint.set(a, v);
  }
  return v;
}

/** 🩹 What this page's own counted chain puts in motion at incarnation `c`
 *  (6a-1, unchanged), read from the doc's checkpoint `cp` (null: none, or
 *  junk) against this page's head:
 *  - 'junk': none, though this page counted one (put back at once, in turn);
 *  - 'rewind': a live one below the head (a replay, or the lower of two
 *    rival trims: no honest trim goes back);
 *  - 'jump': a live one on the session of a checkpoint this page counted
 *    (any in its chain) more than MAX_SESSION_ROUNDS past it (no session
 *    reaches further, so no honest trim does), or one built on a session
 *    this page refuted so (ComputedInc refuted).
 *  Null for the head itself, for anything else, an end above all (no
 *  restore touches an `e: 1`) and an extension of the head no page can
 *  tell from an honest one. */
function chainTrigger(c: ComputedInc, cp: Checkpoint | null): RecoveryTrigger | null {
  const head = c.chain[c.chain.length - 1];
  if (!head) return null;
  if (cp === null) return 'junk';
  if (cp.e === 1) return null;
  if (cp.u < head.cp.u) return 'rewind';
  if (liveSidOf(c, cp) === head.sid) return null;
  if (c.refuted.includes(cp.b) || c.chain.some((e) => jumpsOver(cp, e))) return 'jump';
  return null;
}

/** 🏛️ What the owner-signed checkpoint A puts in motion at incarnation `c`
 *  (design §6.2 F), when one takes part (houseSumTakesPart):
 *  - 'end' (F4): A is an end (`e: 1`), whatever the doc holds short of its own
 *    end — a live checkpoint (the end turned live again), or none/junk. No
 *    honest page reopens an ended table, so a live head over A is forged;
 *  - 'junk' (F1): A is live and the doc holds none, or junk — even on a page
 *    that counted none itself (a late page restores the owner's check);
 *  - 'rewind' (F2b): a live checkpoint at or below A's round that A does not
 *    check (another close, or a replay the owner saw past).
 *  Null for an end in the doc (no restore touches an `e: 1`), for A's own
 *  checkpoint, and for anything above a live A (an extension A can't refute). */
function houseSumTrigger(c: ComputedInc, cp: Checkpoint | null): RecoveryTrigger | null {
  const A = houseSumTakesPart(c);
  if (!A) return null;
  // An end already in the doc is final: no restore touches it (checked before
  // A so the doc's own end wins over the owner's counted one).
  if (cp !== null && cp.e === 1) return null;
  // 🏛️ An owner-signed end outranks any live head, so F4 restores it even when
  // the doc's checkpoint is absent or junk — not only when a live checkpoint
  // sits over it. Else a forged live head this page counted is restored in its
  // place, again each time a peer deletes the `sum:`.
  if (A.e === 1) return 'end';
  if (cp === null) return 'junk';
  if (cp.u <= A.u && liveSidOf(c, cp) !== houseSumDigest(c.ctx, A)) return 'rewind';
  return null;
}

/** What puts a recovery in motion at incarnation `c`, read from the doc's
 *  checkpoint `cp` (null: none, or junk): this page's own chain first
 *  (chainTrigger), then the owner-signed checkpoint (houseSumTrigger) — except
 *  an owner-signed end, which outranks the chain (F4). With no owner's
 *  checkpoint taking part this reads exactly as 6a-1 did. */
function recoveryTrigger(c: ComputedInc, cp: Checkpoint | null): RecoveryTrigger | null {
  const house = houseSumTrigger(c, cp);
  // 🏛️ An owner-signed end outranks this page's own chain recovery: no honest
  // page plays past an end, so a live head above it (a chain 'rewind' or 'jump')
  // is a forged extension the owner's end undoes (F4).
  if (house === 'end') return 'end';
  return chainTrigger(c, cp) ?? house;
}

/** 🏛️ What a restore of incarnation `c` writes back (B14.2), for `trigger`:
 *  for 'end' the owner's checkpoint A; else the higher by round of this
 *  page's head and A, A on a tie (its bytes are the same on every page, the
 *  head's value only on the pages that counted it). Null with neither. */
function restoreTargetOf(
  c: ComputedInc,
  trigger: RecoveryTrigger | null,
): { value: object; sid: string; u: number; end: boolean } | null {
  const head = c.chain[c.chain.length - 1];
  const A = houseSumTakesPart(c);
  const ofA = (a: HouseSum) => ({
    value: cpValueOfHouseSum(a),
    sid: houseSumDigest(c.ctx, a),
    u: a.u,
    end: a.e === 1,
  });
  if (trigger === 'end') return A ? ofA(A) : null;
  if (A && (!head || A.u >= head.cp.u)) return ofA(A);
  return head ? { value: head.value, sid: head.sid, u: head.cp.u, end: head.cp.e === 1 } : null;
}

/** Whether `cp` is a jump over counted checkpoint `e`: on the session `e`
 *  opens, more than MAX_SESSION_ROUNDS past it. */
function jumpsOver(cp: Checkpoint, e: Counted): boolean {
  return cp.b === e.sid && cp.u - e.cp.u > MAX_SESSION_ROUNDS;
}

/** Refute session `sid` of incarnation `c` (ComputedInc refuted). */
function refute(c: ComputedInc, sid: string): void {
  if (c.refuted.includes(sid)) return;
  c.refuted.push(sid);
  if (c.refuted.length > REFUTED_KEPT) c.refuted.shift();
}

/** 🩹 Note the head of session `sid` as given way over (ComputedInc
 *  dropped). */
function drop(c: ComputedInc, sid: string): void {
  if (c.dropped.includes(sid)) return;
  c.dropped.push(sid);
  if (c.dropped.length > REFUTED_KEPT) c.dropped.shift();
}

/** Note the doc's checkpoint of `c` as counted (`watched`: the session
 *  this page counted from before it, `now` its time): the head from now on,
 *  unless it is the head already, or would put a recovery in motion. A
 *  jump's session is refuted, and so stays whatever is built on it. A
 *  rewind below a checkpoint in the chain that jumps over it (this page
 *  took a jump as its head: it came while the jump stood) is the honest
 *  line coming back: the jump and what came after it in the chain go, and
 *  the rewind is the head (so two pages that each hold another head stop
 *  putting theirs back over each other's).
 *
 *  🩹 So too a rewind of a head this page took without seeing it come
 *  (Counted firmAt), within TAKEN_WAIT_MS: a page that loaded while a jump
 *  over an older checkpoint stood, its head the jump, can't tell the head
 *  the pages that counted it put back from a peer's replay. It gives way
 *  (what it took goes from its chain, to be taken as at load again should
 *  it come back: ComputedInc dropped), unless the rewind is the checkpoint
 *  one in its chain was built on, a replay it can tell. */
function noteCounted(c: ComputedInc, map: Y.Map<unknown>, watched: string | null, now: number): void {
  const value = map.get(`sum:${c.t}:${c.inc}`);
  const cp = checkpointAt(map, c.t, c.inc);
  let trigger = recoveryTrigger(c, cp);
  // 🏛️ The chain's adjustments below (a jump giving way to the honest line, an
  // unseen head giving way, a seen head's rewind refuted) read what this
  // page's OWN chain says (chainTrigger): a rewind only the owner's checkpoint
  // names (houseSumTrigger) drops no head and refutes no session — the page
  // restores the owner's checkpoint over it (restoreTargetOf), and that is
  // all. (An hs: that outruns the trim it checks would otherwise refute the
  // session of this page's own head, and the trim, when it came, read as a
  // jump.)
  if (chainTrigger(c, cp) === 'rewind' && cp !== null) {
    const sid = liveSidOf(c, cp);
    const i = c.chain.findIndex((e) => e.cp.b === sid && e.cp.u - cp.u > MAX_SESSION_ROUNDS);
    if (i >= 0) {
      for (const e of c.chain.slice(i)) if (e === c.chain[i] || c.refuted.includes(e.cp.b)) refute(c, e.sid);
      c.chain.length = i;
      trigger = recoveryTrigger(c, cp);
    } else if (!c.chain.some((e) => e.cp.b === sid)) {
      // (firmAt never falls along the chain: what gives way is its end.)
      let j = c.chain.length;
      while (j > 0 && now < c.chain[j - 1].firmAt) j--;
      if (j < c.chain.length) {
        for (const e of c.chain.slice(j)) drop(c, e.sid);
        c.chain.length = j;
        trigger = recoveryTrigger(c, cp);
      }
    }
  }
  if (trigger === null) c.calm++;
  if (trigger === 'jump' && cp !== null) refute(c, liveSidOf(c, cp));
  // 🩹 A rewind of a SEEN head is a forgery (this page is grounded in its
  // head): refute the session that rewind opens, so a checkpoint the forger
  // then builds on it, above the head, puts a restore in motion too instead
  // of slipping in as a new head (an extension of a forged rewind). Only a
  // rewind that stayed one through the adoption/give-way above is refuted. An
  // UNSEEN (load-taken) head can't tell the honest head coming back from a
  // replay, so its rewind is NOT refuted here — it gives way to it (firmAt
  // within the window, giveWayComputed past it).
  if (chainTrigger(c, cp) === 'rewind' && cp !== null && c.chain[c.chain.length - 1]?.seen) {
    // Exempt a session the counted chain is built on: a rewind that replays a
    // checkpoint in the chain opens the chain's OWN next session, and refuting
    // it would reject a legitimate higher trim of that session as a jump (a
    // same-base trim race — two seen heads restoring different checkpoints).
    // The forger's rewind of the F2 case is on an unrelated base no chain
    // entry continues from, so it is still refuted.
    const rewoundSid = liveSidOf(c, cp);
    if (!c.chain.some((e) => e.cp.b === rewoundSid)) refute(c, rewoundSid);
  }
  if (cp === null || typeof value !== 'object' || value === null) return;
  const head = c.chain[c.chain.length - 1];
  const sid = liveSidOf(c, cp);
  // (🏛️ A checkpoint the owner's checkpoint refutes is no head either, on a
  // page that counted none yet: a late page restores the owner's over it.)
  if ((head && head.sid === sid) || trigger !== null) return;
  const taken = now + TAKEN_WAIT_MS;
  // A checkpoint inherits the head's firmAt only when it EXTENDS the head
  // (built on the session the head opens): then it is as firm as the head it
  // carries on from. A checkpoint on any other base is a fresh take, not an
  // extension — a jump this page can't classify as one (it never counted a
  // checkpoint of the session the jump overshoots, so recoveryTrigger let it
  // through) must not borrow the head's possibly-elapsed firmAt, or it is
  // firm at once and no rewind can give way to the honest head coming back.
  // It waits afresh (taken), unless it is built on the very session this page
  // was counting from, a plain forward move it saw come (firm now, 0).
  // 🩹 A base this page gave way over (dropped) is not a session it counted
  // from: a checkpoint built on it is a fresh take, not a seen extension, even
  // when `watched` still points there (a page that took a jump J, adopted a
  // lower checkpoint R on J's session, then dropped J — R and anything built
  // on it must not inherit `seen`/firm-now, or an extension of R above the
  // honest head would be firm at once and never give way).
  const firmAt = c.dropped.includes(sid)
    ? taken
    : head && cp.b === head.sid
      ? head.firmAt
      : cp.b === watched && !c.dropped.includes(cp.b)
        ? 0
        : taken;
  // `seen` mirrors firmAt's branches: a head given way over is unseen again,
  // an extension inherits the head's, one on the session this page was
  // counting from (and did not give way over) was seen come, anything else (a
  // fresh take, mostly at load) is unseen.
  const seen = c.dropped.includes(sid)
    ? false
    : head && cp.b === head.sid
      ? head.seen
      : cp.b === watched && !c.dropped.includes(cp.b);
  c.chain.push({ value, cp, sid, pubs: new Set(), firmAt, seen });
  if (c.chain.length > CHAIN_KEPT) c.chain.shift();
  if (c.gaveUp && c.gaveUp.sid !== sid) c.gaveUp = null;
}

/**
 * 🩹 Doubt the slips a page of the build before v0.51 may have let go of,
 * seeds and all, as that build does when the table moves on from their
 * session (computedTable movedOn) to a base past the round before theirs:
 * - on a move past the round after the new base, every slip on an open felt
 *   of the session moved from (`was`) that the new one (`res`) doesn't
 *   hold;
 * - and on the head's return after a rewind or a jump stood, every slip its
 *   session holds then: they were there before the forgery, which that
 *   build counted as a move (a jump's past every round they were on), and
 *   this page may not have counted them before it came (one update brought
 *   both).
 * Counted on every count, as the doc changes, so a page that ran no frame
 * between a felt and the forgery doubts it all the same.
 */
function noteDoubted(c: ComputedInc, was: FoldResult | null, res: FoldResult, map: Y.Map<unknown>): void {
  const trigger = recoveryTrigger(c, checkpointAt(map, c.t, c.inc));
  const forged = trigger !== null && trigger !== 'junk';
  const back = c.forged && !forged;
  c.forged = forged;
  if (!was || was.base.sid === res.base.sid) return;
  const doubt = (h: string): void => {
    c.doubted.delete(h);
    c.doubted.add(h);
  };
  if (was.open > res.base.u + 1) {
    for (const s of was.felts.values()) if (res.felts.get(s.rec.p)?.hash !== s.hash) doubt(s.hash);
  }
  if (back) for (const s of res.felts.values()) doubt(s.hash);
  for (const h of c.doubted) {
    if (c.doubted.size <= DOUBTED_KEPT) break;
    c.doubted.delete(h);
  }
}

/** 🩹 Whether this page doubts slip `hash` at table `tableId`'s
 *  switched-on incarnation, or at `inc` (ComputedInc doubted): its closes
 *  freeze it only for its own player. */
export function computedSlipDoubted(tableId: string, hash: string, inc: string | null = computedIncOf(tableId)): boolean {
  return inc !== null && computedIncs.get(`${tableId}:${inc}`)?.doubted.has(hash) === true;
}

/** The incarnation a switch names: exactly {v: 1, inc}, `inc` a computed
 *  one's name, 🔒 or a FAIR ONLY game's (a hint to the game the table plays:
 *  computedIncOf). Null for none, or anything else (no timestamp: identical
 *  switches written at once merge). (Exported for the house's test
 *  vectors: the owner's node reads switches as this does, and reads a
 *  FAIR ONLY name as none until its half of PR 6c.) */
export function computedCfgInc(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const cfg = value as { v?: unknown; inc?: unknown };
  return Object.keys(cfg).length === 2 && cfg.v === 1 && typeof cfg.inc === 'string' && (COMPUTED_INC.test(cfg.inc) || isFairOnlyInc(cfg.inc))
    ? cfg.inc : null;
}

/** The incarnation table `tableId`'s switch names, as written, or null: the
 *  switch API's (put it back, take it away, drop one nothing stands behind)
 *  and every page-signed duty's, which have no part in the game a table plays
 *  when that is a FAIR ONLY one (computedIncOf). */
export function switchIncOf(tableId: string): string | null {
  return computedCfgInc(ensureMap().get(`cfg:computed:${tableId}`));
}

/** The incarnation table `tableId` plays, or null: the one its switch names,
 *  as it always was, 🔒 unless the table has a live FAIR ONLY game, when it
 *  is S9's choice among them (computedFairOnlyAuth tableGame: the game the
 *  deed holder holds, else the one the switch names, else the only live one,
 *  else the lowest name), the switch being a hint. A page never plays the
 *  switch's game against it for a reason of its own: only the games' state
 *  and the deed move this. */
export function computedIncOf(tableId: string): string | null {
  const named = switchIncOf(tableId);
  if (foGames === 0) return named;
  const live = foLive.get(tableId);
  if (!live || live.size === 0) return named;
  return tableGame([...live.values()], deedHolderKey(), named)?.inc ?? named;
}

/** Whether FAIR ONLY game `inc` of table `tableId` is live (S7): its
 *  resolution names a base that doesn't end it. The table's switch, `gone:`
 *  marks and a removal have no part in it. */
function fairOnlyLive(tableId: string, inc: string): boolean {
  return computedIncs.get(`${tableId}:${inc}`)?.fo?.res?.live === true;
}

/** Whether table `tableId` is a computed one now: it plays an incarnation no
 *  removal has ended (`gone:`) and whose checkpoint doesn't say it ended.
 *  (Its decided nets count either way: the ledger.) 🔒 A FAIR ONLY game is
 *  one while it is live, which its base alone says (S7): a game nothing has
 *  opened (no base) is no table, whatever the switch says (S4). */
export function isComputedTable(tableId: string): boolean {
  const inc = computedIncOf(tableId);
  return inc !== null && isComputedInc(tableId, inc);
}

/** isComputedTable of incarnation `inc` of table `tableId`, the one the table
 *  plays or another it keeps (a FAIR ONLY game the table has left, whose duties a
 *  page goes on with: computedTable tickComputedTables): nothing has ended it
 *  (`gone:`, its checkpoint), or, for a FAIR ONLY game, it is live. */
export function isComputedInc(tableId: string, inc: string): boolean {
  if (isFairOnlyInc(inc)) return fairOnlyLive(tableId, inc);
  return !casinoMap!.has(goneKey(tableId, inc)) && baseOf(tableId, inc)?.e !== 1;
}

/** Whether table `tableId` is a computed table of `game` now
 *  (isComputedTable, the incarnation's name that game's: computedFold
 *  gameOfInc). A switch naming the other game's incarnation leaves this
 *  game's owner-run play going (unless this game's own is lost under it:
 *  computedSwitchLost): no page of this build plays it there; it ends a
 *  minute on when the doc holds its records (computedTable awayDuty), and
 *  the lease holder drops it a lapse on when it holds none (croupier
 *  dropBareSwitch). */
export function isComputedFor(tableId: string, game: GameName): boolean {
  return isComputedTable(tableId) && gameOfInc(computedIncOf(tableId)!) === game;
}

/** Whether incarnation `inc` of table `tableId` is over for good: a removal
 *  marked it (`gone:`), or its checkpoint says it ended (finalizeComputed
 *  writes both). A switch that is missing, or junk, ends nothing yet: a
 *  peer's delete the room's pages put back (computedTable), and the
 *  incarnation goes on. */
export function computedIncEnded(tableId: string, inc: string): boolean {
  const casino = ensureMap();
  // (🔒 A FAIR ONLY game's end is its base's alone: S7.)
  if (isFairOnlyInc(inc)) return baseOf(tableId, inc)?.e === 1;
  return casino.has(goneKey(tableId, inc)) || baseOf(tableId, inc)?.e === 1;
}

/** The name a table's next computed incarnation takes: `r` (roulette) or
 *  `d` (craps), house tables, + 24 hex of the table's removals (its `gone:`
 *  marks), as tableIncFor names an owner-run one, under a domain of each
 *  game's own (and not PR 2–4's: `c` and `k` names are never opened again),
 *  so none of them ever meet. Not at random:
 *  two of the house's pages switching the table on at once name it alike,
 *  and their sessions meet on one key. Past any name the doc already holds
 *  a session or a checkpoint of (a switch-off that ended it on a page whose
 *  mark the doc didn't keep): that one is marked ended, and the next tried,
 *  as freshIncFor does. In the caller's transaction. */
export function computedIncFor(tableId: string, game: GameName = 'roulette'): string {
  const casino = ensureMap();
  const map = computedMap!;
  const prefix = `gone:${tableId}:`;
  for (;;) {
    const removals = [...casino.entries()].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]): [string, unknown] => [key.slice(prefix.length), value])
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    const named = `${game === 'craps' ? 'ssf-computed-house-craps-inc-v1' : 'ssf-computed-house-inc-v1'}|${tableId}|${JSON.stringify(removals)}`;
    const inc = (game === 'craps' ? 'd' : 'r') + bytesToHex(sha256(new TextEncoder().encode(named))).slice(0, 24);
    const used = map.has(`sum:${tableId}:${inc}`) || [...map.keys()].some((key) => {
      const at = computedKeyParts(key);
      return at?.sid !== undefined && at.t === tableId && at.inc === inc;
    });
    if (!used) return inc;
    markRemoved(casino, tableId, inc);
  }
}

/** 🔀 Whether the house switched table `tableId` back to owner-run (the ⚙
 *  card's BACK TO THE OWNER: computedTable switchComputedOff), so its page
 *  doesn't switch it on again by itself (autoSwitchComputed). Its RUN
 *  WITHOUT THE OWNER clears it, and so does taking the table out of the
 *  room. A plain `1` under `cfg:ownerrun:<tableId>`. */
export function ownerRunChosen(tableId: string): boolean {
  return ensureMap().get(`cfg:ownerrun:${tableId}`) === 1;
}

/** 🔀 Mark or clear the house's choice of owner-run play at table `tableId`
 *  (ownerRunChosen), in the caller's transaction. */
export function writeOwnerRunChosen(tableId: string, chosen: boolean): void {
  const casino = ensureMap();
  boundDoc!.transact(() => {
    if (chosen) casino.set(`cfg:ownerrun:${tableId}`, 1);
    else if (casino.has(`cfg:ownerrun:${tableId}`)) casino.delete(`cfg:ownerrun:${tableId}`);
  });
}

/** 🔀 Switch table `tableId` on as computed incarnation `inc`, in the
 *  caller's transaction (the house's switch: computedTable
 *  switchComputedOn): its switch, and the incarnation's first session, unless
 *  the doc holds a session of it already (one written at the same moment by
 *  another of the house's pages is the same session: the doc keeps one map,
 *  and the records lost with the other are put back by their authors). */
export function writeComputedOn(tableId: string, inc: string): void {
  const casino = ensureMap();
  const map = computedMap!;
  boundDoc!.transact(() => {
    casino.set(`cfg:computed:${tableId}`, { v: 1, inc });
    if (sessionKeysOf(map, tableId, inc).some((key) => map.get(key) instanceof Y.Map)) return;
    map.set(sessionKey(tableId, inc, 'g'), new Y.Map<unknown>());
  });
}

/** 🔀 Put table `tableId`'s switch back on incarnation `inc` (computedTable,
 *  the page that runs it): when a peer took it away, or wrote junk, a name
 *  the doc holds nothing of, or one that has ended (an earlier incarnation
 *  of the table, say) in its place. No build takes a switch away
 *  but in the transaction that ends its incarnation (the house's switch-off,
 *  a removal: both mark it), so one gone with its incarnation unended is a
 *  peer's doing. 🔒 A FAIR ONLY name holds the switch only while its game is
 *  live (S7): one nothing opened, one the doc holds only junk records of (no
 *  base) or one that ended is a dead hint, put back over as a made-up
 *  page-signed name is, since the table plays nothing under it while `inc` is
 *  live; a live game's name is left, whichever game the table plays (S9: the
 *  switch is its hint). Only while the doc holds the incarnation's live
 *  session, and nothing has ended it; false (nothing written) otherwise. The
 *  same bytes from every page: whichever write the doc keeps, it is the same. */
export function putComputedSwitchBack(tableId: string, inc: string): boolean {
  const casino = ensureMap();
  const c = ordinaryInc(tableId, inc);
  if (!c?.live || computedIncEnded(tableId, inc) || switchIncOf(tableId) === inc) return false;
  const now = switchIncOf(tableId);
  if (now !== null && (isFairOnlyInc(now) ? fairOnlyLive(tableId, now) : computedIncs.has(`${tableId}:${now}`) && !computedIncEnded(tableId, now))) return false;
  boundDoc!.transact(() => {
    casino.set(`cfg:computed:${tableId}`, { v: 1, inc });
  });
  return true;
}

/** Whether table `tableId`'s switch is lost: it names no incarnation (gone,
 *  or junk), or one that has ended (a peer's write of a name and its mark),
 *  while the doc holds the live session of one nothing has ended
 *  (putComputedSwitchBack: a peer's doing, put back by the room's pages);
 *  given `game`, one of that game's, and a switch naming the other game's
 *  incarnation names none of this game's (a peer's write over it, put back
 *  the same way when the doc holds nothing of the name it wrote). The robot
 *  runs no owner-run round there meanwhile (croupier, crapsCroupier): the
 *  table's players are mid-round on the computed one. 🔒 A FAIR ONLY name
 *  counts as an incarnation while its game is live (S7): one nothing opened,
 *  or that ended, names none, as an ended name doesn't, so a live page-signed
 *  incarnation beside it makes the switch lost (the robot must not run its
 *  round over that one's, and the page that runs it puts the switch back). A
 *  live game's name is never lost. */
export function computedSwitchLost(tableId: string, game?: GameName): boolean {
  const named = switchIncOf(tableId);
  const open = named !== null && (isFairOnlyInc(named) ? fairOnlyLive(tableId, named) : !computedIncEnded(tableId, named));
  if (open && (game === undefined || gameOfInc(named!) === game)) return false;
  for (const inc of computedIncsOf.get(tableId) ?? []) {
    if (game !== undefined && gameOfInc(inc) !== game) continue;
    // (A FAIR ONLY game isn't the switch's to lose: the table plays S9's choice
    // of them, the switch a hint, and none makes the switch lost by being in
    // the doc: only a live page-signed incarnation does, beside a switch that
    // names no open one.)
    const c = computedIncs.get(`${tableId}:${inc}`)!;
    if (!c.fo && c.live && !computedIncEnded(tableId, inc)) return true;
  }
  return false;
}

/** 🔀 Take table `tableId`'s switch away (the house's switch-off, in the
 *  transaction that finalises the incarnation: computedTable
 *  switchComputedOff), the incarnation it names marked ended if it isn't
 *  (one the doc holds nothing of, no session and no checkpoint, has nothing
 *  to finalise: a switch a peer wrote alone). The table is owner-run again
 *  from its next round. */
export function writeComputedOff(tableId: string): void {
  const casino = ensureMap();
  boundDoc!.transact(() => {
    const inc = switchIncOf(tableId);
    // (🔒 Nothing is marked ended of a FAIR ONLY game a switch names: its end is
    // its authority's, by its checkpoint; the switch is a hint and goes alone.)
    if (inc !== null && !isFairOnlyInc(inc) && !casino.has(goneKey(tableId, inc))) casino.set(goneKey(tableId, inc), 1);
    casino.delete(`cfg:computed:${tableId}`);
  });
}

/** Whether table `tableId`'s switch is bare: it names an incarnation nothing
 *  has ended, of which the doc holds no session map and no checkpoint. No
 *  build writes one so (the switch-on writes the first session with it, in
 *  one update, a trim writes the checkpoint with the next session, and only
 *  an end deletes the last one: a doc holding part of an update isn't
 *  whole), so on a whole doc it is a peer's forgery, or what is left after a
 *  peer deleted the only session (no checkpoint yet) on a doc that never
 *  held it. Nobody can run such a table: no felt goes down (there is no
 *  session to write into) and the robot stands down. The lease holder drops
 *  it a lapse on (croupier), and the house's switch-off drops it at once
 *  (computedTable). */
export function computedSwitchBare(tableId: string): boolean {
  const inc = switchIncOf(tableId);
  // (🔒 A FAIR ONLY name nothing stands behind is no table (S4: it is not open, and
  // the table goes on as it was), so there is no stopped table to free.)
  if (inc === null || isFairOnlyInc(inc) || computedIncEnded(tableId, inc)) return false;
  const map = computedMap!;
  return baseOf(tableId, inc) === null && !sessionKeysOf(map, tableId, inc).some((key) => map.get(key) instanceof Y.Map);
}

/** 🧮 End computed incarnation `inc` of table `tableId` as a removal of the
 *  table ends it (clearTableKeys' computed branch), in one transaction: its
 *  `gone:` mark, and its switch deleted. Its decided nets count on, its open
 *  felts stop holding (nothing to refund: they took nothing), and its
 *  sessions stay until a page compacts them (computedTable). For a table no
 *  longer in the room whose removal this page never ran (computedTable
 *  awayDuty): an earlier build's removal deletes the table's keys but not the
 *  switch, which it knows nothing of, and a switch written at the moment of
 *  a removal outlives the removal's delete of a key that wasn't there yet.
 *  Only while the switch names `inc` and nothing has ended it; false (nothing
 *  written) otherwise. */
export function writeComputedGone(tableId: string, inc: string): boolean {
  const casino = ensureMap();
  // (🔒 No removal marks a FAIR ONLY game ended: S7.)
  if (isFairOnlyInc(inc) || switchIncOf(tableId) !== inc || computedIncEnded(tableId, inc)) return false;
  boundDoc!.transact(() => {
    markRemoved(casino, tableId, inc);
    casino.delete(`cfg:computed:${tableId}`);
  });
  return true;
}

// ⚖️ Signatures: strict noble, about 2 ms a check, so a page joining a busy
// table can't check a session's records in one go without a stall. Each
// recount spends at most COMPUTED_VERIFY_MS on them, shared by every table;
// what is left reads as not checked yet (the fold's result is pending, and
// nobody spends meanwhile: computedSettled), and an empty transaction of its
// own (CT_VERIFY) checks on: Yjs emits no update for a transaction with
// nothing in it, so nothing goes to the room, and its listeners are told
// once, as for any transaction. A verdict is kept per incarnation by record
// hash, so a record copied into the next session is never checked again.

const COMPUTED_VERIFY_MS = 40;
const CT_VERIFY = Symbol('casino-computed-verify');

function defaultVerifyNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** The check (null: keypair.verifyIdentityStrict, read at call time), the
 *  budget and its clock: tests may swap them (setComputedVerifyForTests). */
let verifyWith: ((pub: string, bytes: Uint8Array, sig: string) => boolean) | null = null;
let verifyBudgetMs = COMPUTED_VERIFY_MS;
let verifyNow: () => number = defaultVerifyNow;
/** ms of checks this recount has spent. */
let verifySpent = 0;
/** A slice is queued on this binding. */
let verifyQueued = false;

// 🏎 Past a recount's budget, a check goes to WebCrypto when the page's fast
// path is on (keypair fastStrictCheck, enabled at the app's boot): its yes
// lands in the verdicts and queues a slice that reads it, and its "can't
// say" (a torsion component noble's equation forgives) leaves the check to
// noble in a later recount (fastToNoble). A check in flight isn't made again
// meanwhile. A yes from WebCrypto is noble's yes and a refusal by the byte
// checks noble's refusal, so every page counts the same records whichever
// path checked them. Sending costs about 0.1 ms a check (the byte checks),
// at most COMPUTED_FAST_MS of each recount; the checks themselves run off
// the page's thread.
const COMPUTED_FAST_MS = 20;
/** ms this recount has spent sending checks to WebCrypto. */
let fastSpent = 0;
/** The checks in flight on WebCrypto, by verdict id (fastId). */
let fastInFlight = new Set<string>();
/** The checks WebCrypto didn't say yes to: noble's (the latest FAST_TO_NOBLE_MAX). */
let fastToNoble = new Set<string>();
const FAST_TO_NOBLE_MAX = 4_096;

/** A verdict's id across the kinds of check: a fold's record by its
 *  incarnation and hash, a room record by its own id (roomRecOk), a FAIR ONLY
 *  game's signature by its sigId (authCheck). */
function fastId(kind: 'fold' | 'room' | 'auth', id: string): string {
  return `${kind}|${id}`;
}

/** Send check `id` (`pub`'s signature `sig` over `bytes()`) to WebCrypto:
 *  'sent' while it is in flight (`onYes` sets the verdict when WebCrypto
 *  says yes; either answer queues a slice), false when the byte checks
 *  refuse it (a verdict: verifyIdentityStrict refuses it too), null when it
 *  can't go (the fast path off or swapped out for a spec's check, this
 *  recount's sending budget spent, or WebCrypto couldn't say before): noble
 *  checks it, now or in a slice. */
function sendFast(id: string, pub: string, bytes: () => Uint8Array, sig: string, onYes: () => void): 'sent' | false | null {
  if (fastInFlight.has(id)) return 'sent';
  if (verifyWith !== null || verifyBudgetMs <= 0 || fastSpent >= COMPUTED_FAST_MS || fastToNoble.has(id) || !fastStrictChecksOn()) return null;
  const from = verifyNow();
  let answer: ReturnType<typeof fastStrictCheck>;
  try {
    answer = fastStrictCheck(pub, bytes(), sig);
  } catch {
    answer = false;
  }
  fastSpent += Math.max(0, verifyNow() - from);
  if (answer === null || answer === false) return answer;
  const epoch = bindingEpoch;
  fastInFlight.add(id);
  void answer.then((yes) => {
    if (bindingEpoch !== epoch) return; // a binding we've moved off (its sets are new)
    fastInFlight.delete(id);
    if (yes) {
      onYes();
    } else {
      fastToNoble.add(id);
      if (fastToNoble.size > FAST_TO_NOBLE_MAX) fastToNoble.delete(fastToNoble.keys().next().value as string);
    }
    queueVerifySlice();
  });
  return 'sent';
}

/** 🧪 Swap the signature check, the budget per recount, its clock or how
 *  many verdicts of a FAIR ONLY game's signatures are kept (any left out,
 *  and all with no argument, go back to the real ones). A budget of 0 checks
 *  nothing and so queues nothing: the next call queues the slice that checks
 *  what waited. */
export function setComputedVerifyForTests(opts: {
  verify?: (pub: string, bytes: Uint8Array, sig: string) => boolean;
  budgetMs?: number;
  now?: () => number;
  authMax?: number;
} = {}): void {
  verifyWith = opts.verify ?? null;
  verifyBudgetMs = opts.budgetMs ?? COMPUTED_VERIFY_MS;
  authVerdictsMax = opts.authMax ?? AUTH_VERDICTS_MAX;
  fastToNoble = new Set();
  verifyNow = opts.now ?? defaultVerifyNow;
  if (roomWaiting.size > 0) queueVerifySlice();
  for (const c of computedIncs.values()) {
    if (c.last?.pending || c.fo?.res?.pending || c.fo?.committingWaits || c.fo?.hkWaits) {
      queueVerifySlice();
      break;
    }
  }
}

function verdictsOf(incKey: string): Map<string, boolean> {
  let verdicts = computedVerdicts.get(incKey);
  if (!verdicts) computedVerdicts.set(incKey, verdicts = new Map());
  return verdicts;
}

/** The SigCheck of one incarnation's fold: a cached verdict, else a check
 *  while this recount's budget lasts, else "not checked yet": on WebCrypto
 *  if it can go (sendFast), and a slice for what can't. */
function computedCheck(incKey: string): SigCheck {
  return (hash, _kind, pub, bytes, sig) => {
    const verdicts = verdictsOf(incKey);
    const known = verdicts.get(hash);
    if (known !== undefined) return known;
    const id = fastId('fold', `${incKey}:${hash}`);
    if (fastInFlight.has(id)) return undefined;
    if (verifySpent >= verifyBudgetMs) {
      const fast = sendFast(id, pub, bytes, sig, () => verdicts.set(hash, true));
      if (fast === false) {
        verdicts.set(hash, false);
        return false;
      }
      if (fast === null) queueVerifySlice();
      return undefined;
    }
    const from = verifyNow();
    let ok: boolean;
    try {
      ok = (verifyWith ?? verifyIdentityStrict)(pub, bytes(), sig) === true;
    } catch {
      ok = false;
    }
    verifySpent += Math.max(0, verifyNow() - from);
    verdicts.set(hash, ok);
    return ok;
  };
}

/** Run the next recount's checks in an empty transaction, once the page has
 *  drawn a frame, on the binding that queued it if it is bound still (a
 *  binding since queues its own: bindComputed clears the flag). */
function queueVerifySlice(): void {
  if (verifyQueued || verifyBudgetMs <= 0) return;
  verifyQueued = true;
  const epoch = bindingEpoch;
  setTimeout(() => {
    if (bindingEpoch !== epoch) return; // a binding we've moved off
    verifyQueued = false;
    boundDoc!.transact(() => {}, CT_VERIFY);
  }, 0);
}

/** 🔒 The SigCheckFn of a FAIR ONLY game's resolution (computedFairOnlyAuth):
 *  a cached verdict, else a check while this recount's budget lasts, else "not
 *  checked yet" (the resolution is pending, and the slice that queues, or
 *  WebCrypto's answer, resolves it again: countTransaction). The same strict
 *  check as every other signature of the room, under an id that binds what the
 *  signature covers (sigId). */
function authCheck(id: string, pub: string, bytes: () => Uint8Array, sig: string): boolean | undefined {
  const known = authVerdicts.get(id);
  if (known !== undefined) return known;
  const fid = fastId('auth', id);
  if (fastInFlight.has(fid)) return undefined;
  if (verifySpent >= verifyBudgetMs) {
    const fast = sendFast(fid, pub, bytes, sig, () => setAuthVerdict(id, true));
    if (fast === false) {
      setAuthVerdict(id, false);
      return false;
    }
    if (fast === null) queueVerifySlice();
    return undefined;
  }
  const from = verifyNow();
  let ok: boolean;
  try {
    ok = (verifyWith ?? verifyIdentityStrict)(pub, bytes(), sig) === true;
  } catch {
    ok = false;
  }
  verifySpent += Math.max(0, verifyNow() - from);
  setAuthVerdict(id, ok);
  return ok;
}

/** Keep a FAIR ONLY signature's verdict, the oldest going first past AUTH_VERDICTS_MAX. */
function setAuthVerdict(id: string, ok: boolean): void {
  if (!authVerdicts.has(id) && authVerdicts.size >= authVerdictsMax) authVerdicts.delete(authVerdicts.keys().next().value as string);
  authVerdicts.set(id, ok);
}

/** The writing page's own record checks out: it signed it (it never checks
 *  its own records). Of table `tableId`'s live incarnation, or of `inc`. */
export function markComputedVerdict(tableId: string, hash: string, inc: string | null = computedIncOf(tableId)): void {
  if (inc !== null) verdictsOf(`${tableId}:${inc}`).set(hash, true);
}

/** What this page knows of record `hash`'s signature in incarnation `inc` of
 *  table `tableId`: true (checked, or its own), false (checked and forged),
 *  undefined (never asked: the fold checks only what it counts). Read-only:
 *  nothing is checked here, so no read spends a recount's budget. */
export function computedVerdictOf(tableId: string, inc: string, hash: string): boolean | undefined {
  return computedVerdicts.get(`${tableId}:${inc}`)?.get(hash);
}

/** The key a computed felt must be signed with to count (TableFold's
 *  keyOf): this page's own for its own player, else the one pinned when this
 *  page first saw the player in the room (as fairTableSeeds keyFor reads). */
function computedPinOf(pid: string): string | undefined {
  return pid === getPlayerId() ? getIdentityPub() : readPlayerKey(pid);
}

// ── 🏠 The house (computedHouse.ts: its room records) ───────────────────────

/** House keys this page has seen delegated, each with the deed holder's key
 *  that signed it: a house while that key holds the deed, so a delete can't
 *  stall a round it decides. A handover ends the old holder's houses on every
 *  page alike: a deed's history isn't signed, so nothing in the doc can tell
 *  a page loaded later that the old holder held it when a round was decided. */
let housePinned = new Map<string, string>();
/** The delegations this page counted, to put back if they go (putBackHouseRecords). */
let houseDelegations = new Map<string, DelegationRec>();
/** Verdicts on the room records' signatures, by kind, room, table and
 *  recHash (the signed bytes are bound to each: a copy elsewhere is checked
 *  anew): the latest HOUSE_VERDICTS_MAX, the oldest going first (a page in
 *  a room for hours hears a beat every 5 s). What a verdict let in stays in
 *  without it (housePinned, houseBeats, fairSeen), so one that goes costs at
 *  most a check of a record read again. */
let houseVerdicts = new Map<string, boolean>();
const HOUSE_VERDICTS_MAX = 2_048;
/** The room records (by doc key: `hk:<pub>`, `hf:<t>`, `hb:<pub>`) whose
 *  check a recount's budget put off: the slice it queued reads each again
 *  (recheckRoomRecords). */
let roomWaiting = new Set<string>();
/** Each house's highest heartbeat seen, and when (this page's clock): null
 *  once that is forgotten (forgetBeat), the count alone staying. */
let houseBeats = new Map<string, { n: number; at: number | null }>();
/** 🔒 How many of the doc's live FAIR ONLY games hear each key as a house now
 *  (FairOnlyState.houses): a beat counts from such a key as from a house the deed
 *  holder pinned (noteBeat), for what a game asks of it (houseHeardFrom) and no
 *  more: the room's own questions (houseHeardAt, houseOnline) still read the
 *  pinned houses only. */
let gameHouseRefs = new Map<string, number>();
/** What a FAIR ONLY game that is not live hears. */
const NO_HOUSES: ReadonlySet<string> = new Set();
/** The newest Fair setting by the deed holder this page has seen, per table. */
let fairSeen = new Map<string, FairSettingRec>();
/** The best valid owner-signed checkpoint (`hs:`) this page has counted, per
 *  `<t>:<inc>` (compareHouseSum order; it only ever rises). D2 writes its own
 *  into it, and a page that only reads one counts it here; D3 puts the best
 *  back when the doc's goes, is junk or is worse. */
let houseSumSeen = new Map<string, HouseSum>();
/** B12 backoff per `<t>:<inc>`: the times this page's hs: put-back was
 *  overwritten by a worse value, and until when it stands down (⚙ shows
 *  PAGES DISAGREE). */
let houseSumBackoff = new Map<string, { hits: number[]; until: number }>();
const BACKOFF_COUNT = 3;
const BACKOFF_WINDOW_MS = 60_000;
const BACKOFF_MS = 600_000;
/** The deed holder's key the houses were last read under (deedHolderKey):
 *  they read otherwise only as it changes (onComputedTransaction). */
let houseDeedKey: string | null | undefined;
/** B1: whether this page saw the room's deed change hands during its visit
 *  (an established holder's key gave way to another's, or to none). The ⚙
 *  card names it (checkpointLabelOf), and an owner-signed checkpoint by the
 *  new holder takes no part in restores (§6.2 F, 6a-2 C3 F). The owner's key
 *  merely arriving (undefined/null → a key) is no handover. */
let deedChangedSeen = false;

/** The room's deed holder's identity key, as this page pinned it: null when
 *  the room names no owner (or the legacy marker: nobody's), undefined while
 *  their key hasn't shown up. The marker is refused before any lookup
 *  (roomOwner.ts #141). */
function deedHolderKey(): string | null | undefined {
  const owner = boundDoc?.getMap('roomInfo').get('owner');
  if (typeof owner !== 'string' || legacyOwnerMarker(owner)) return null;
  return computedPinOf(owner);
}

/** A room record's signature (computedHouse roomSignBytes), checked once
 *  for its kind and table, out of the recount's budget as the fold's are
 *  (computedCheck): past it, undefined, and the record under doc key
 *  `key` waits for the slice that queues (recheckRoomRecords). A peer's
 *  flood of records naming the deed holder's key, every signature bad,
 *  costs a page no more a recount than one of slips. */
function roomRecOk(kind: RoomKind, t: string, rec: { k: string; g: string }, key: string): boolean | undefined {
  const hash = recHash(rec);
  if (hash === null) return false;
  const id = JSON.stringify([kind, boundRoomId, t, hash]);
  const known = houseVerdicts.get(id);
  if (known !== undefined) return known;
  const fid = fastId('room', id);
  if (fastInFlight.has(fid)) {
    roomWaiting.add(key);
    return undefined;
  }
  if (verifySpent >= verifyBudgetMs) {
    const room = boundRoomId;
    const fast = sendFast(fid, rec.k, () => roomSignBytes(kind, room, t, rec), rec.g, () => setHouseVerdict(id, true));
    if (fast === false) {
      setHouseVerdict(id, false);
      return false;
    }
    roomWaiting.add(key);
    if (fast === null) queueVerifySlice();
    return undefined;
  }
  const from = verifyNow();
  let ok: boolean;
  try {
    ok = (verifyWith ?? verifyIdentityStrict)(rec.k, roomSignBytes(kind, boundRoomId, t, rec), rec.g) === true;
  } catch {
    ok = false;
  }
  verifySpent += Math.max(0, verifyNow() - from);
  setHouseVerdict(id, ok);
  return ok;
}

/** Keep a room record's verdict, the oldest going first past HOUSE_VERDICTS_MAX. */
function setHouseVerdict(id: string, ok: boolean): void {
  if (!houseVerdicts.has(id) && houseVerdicts.size >= HOUSE_VERDICTS_MAX) houseVerdicts.delete(houseVerdicts.keys().next().value as string);
  houseVerdicts.set(id, ok);
}

/** Read again each room record whose check waited (roomWaiting), now the
 *  budget is fresh: the delegations first, as a beat counts only from a
 *  house. Those the budget puts off again wait for the next slice. The
 *  keys of houses pinned now (the folds ask their HouseCheck again). */
function recheckRoomRecords(): string[] {
  const keys = [...roomWaiting].sort((a, b) => Number(!a.startsWith('hk:')) - Number(!b.startsWith('hk:')));
  roomWaiting = new Set();
  const pinned: string[] = [];
  for (const key of keys) {
    const at = houseKeyParts(key);
    if (at?.kind === 'hkey') {
      if (!pinnedHouse(at.of) && houseOkOf(at.of) === true) pinned.push(at.of);
    } else if (at?.kind === 'hfair') {
      noteFairSetting(at.of);
    } else if (at?.kind === 'hbeat') {
      noteBeat(at.of);
    } else {
      const hs = houseSumKeyParts(key);
      if (hs) noteHouseSum(hs.t, hs.inc);
    }
  }
  return pinned;
}

/** 🏠 Whether `pub` is a house of the bound room (computedFold HouseCheck): its
 *  delegation (`hk:<pub>`) is there, signed by the deed holder's pinned key.
 *  True from then on while that key holds the deed (housePinned). "Not
 *  known yet" (undefined) only while the check of its signature waits for
 *  a slice (roomRecOk), which comes once the page has drawn a frame, and a
 *  record is checked once: never for as long as something stays in the
 *  doc. While the deed holder's key hasn't shown up it is false, and
 *  countTransaction asks again when it does, or when the deed moves
 *  (houseChangedAll): a pending answer would hold every spend in the casino
 *  (computedSettled) for as long as a forged delegation and a key that
 *  never comes stayed in the doc. */
export function houseOkOf(pub: string): boolean | undefined {
  const owner = deedHolderKey();
  if (!owner) return false;
  if (housePinned.get(pub) === owner) return true;
  const rec = asDelegation(computedMap?.get(delegationKey(pub)));
  if (!rec || rec.h !== pub || rec.k !== owner) return false;
  const ok = roomRecOk('hkey', '', rec, delegationKey(pub));
  if (ok !== true) return ok;
  housePinned.set(pub, owner);
  houseDelegations.set(pub, rec);
  return true;
}

/** Whether `pub` is pinned as a house under the deed holder as they are now. */
function pinnedHouse(pub: string, owner = deedHolderKey()): boolean {
  return !!owner && housePinned.get(pub) === owner;
}

/** Every fold asks its HouseCheck again (a delegation, or the deed holder's
 *  key, came or changed), and the settings are read again under the key. */
function houseChangedAll(dirty?: Set<ComputedInc>): void {
  for (const c of computedIncs.values()) {
    c.fold.houseChanged();
    dirty?.add(c);
  }
  const map = computedMap;
  if (!map) return;
  // A new deed holder's checks count afresh; an old holder's this page kept
  // are no longer theirs to put back (B1: the deed changed hands).
  for (const key of [...houseSumSeen.keys()]) {
    if (!authorityOkHouseSum(houseSumSeen.get(key)!)) houseSumSeen.delete(key);
  }
  for (const key of map.keys()) {
    const at = houseKeyParts(key);
    // (Each delegation counted now is pinned, and kept to put back.)
    if (at?.kind === 'hkey') houseOkOf(at.of);
    else if (at?.kind === 'hfair') noteFairSetting(at.of);
    else {
      const hs = houseSumKeyParts(key);
      if (hs) noteHouseSum(hs.t, hs.inc);
    }
  }
}

/** Note table `t`'s Fair setting as the doc holds it now, if the deed holder
 *  signed it and it stands over any this page saw of theirs (fairAfter). */
function noteFairSetting(t: string): void {
  const rec = asFairSetting(computedMap?.get(fairSettingKey(t)));
  if (!rec) return;
  const owner = deedHolderKey();
  if (!owner || rec.k !== owner) return;
  const seen = fairOf(t);
  if (seen && !fairAfter(rec, seen)) return;
  if (roomRecOk('hfair', t, rec, fairSettingKey(t)) === true) fairSeen.set(t, rec);
}

/** The newest Fair setting of table `t` this page saw by the deed holder as
 *  they are now (a new holder's settings count afresh), or undefined. */
function fairOf(t: string): FairSettingRec | undefined {
  const rec = fairSeen.get(t);
  return rec && rec.k === deedHolderKey() ? rec : undefined;
}

/** Note a house's heartbeat as the doc holds it now: by a house, newer than
 *  any this page saw of it, its signature good. 🔒 A house is a key the deed
 *  holder delegated, or one a live FAIR ONLY game hears (FairOnlyState.houses):
 *  a game's houses are its authority's delegations, which the deed holder's pin
 *  stands for nowhere. A beat of any other key is dropped before its signature
 *  is looked at, so a flood of them signed by strangers costs a lookup each. */
function noteBeat(pub: string): void {
  const rec = asBeat(computedMap?.get(beatKey(pub)));
  if (!rec || rec.k !== pub) return;
  const house = houseOkOf(pub);
  // (Its delegation's check put off: the beat is read again after it.)
  if (house === undefined) roomWaiting.add(beatKey(pub));
  if (house !== true && !gameHouseRefs.has(pub)) return;
  const was = houseBeats.get(pub);
  if (was && was.n >= rec.n) return;
  if (roomRecOk('hbeat', '', rec, beatKey(pub)) === true) houseBeats.set(pub, { n: rec.n, at: txNow ?? Date.now() });
}

/** 🏛️ An owner-signed checkpoint's `'hsum'` signature (step 6), checked once
 *  for its room, incarnation and recHash out of the recount's budget as a
 *  room record's is (roomRecOk), on WebCrypto if it can go past the budget,
 *  a slice for what can't: undefined while it waits (the key under `key`,
 *  `hs:<t>:<inc>`, is read again by the slice, recheckRoomRecords). `hs:` is
 *  signed in the fold domain (signBytes), not the room domain. */
function houseSumOk(t: string, inc: string, rec: HouseSum, key: string): boolean | undefined {
  const hash = recHash(rec);
  if (hash === null) return false;
  const id = JSON.stringify(['hsum', boundRoomId, `${t}:${inc}`, hash]);
  const known = houseVerdicts.get(id);
  if (known !== undefined) return known;
  const ctx: FoldCtx = { room: boundRoomId, t, inc };
  const fid = fastId('room', id);
  if (fastInFlight.has(fid)) {
    roomWaiting.add(key);
    return undefined;
  }
  if (verifySpent >= verifyBudgetMs) {
    const fast = sendFast(fid, rec.k, () => signBytes('hsum', ctx, rec), rec.g, () => setHouseVerdict(id, true));
    if (fast === false) {
      setHouseVerdict(id, false);
      return false;
    }
    roomWaiting.add(key);
    if (fast === null) queueVerifySlice();
    return undefined;
  }
  const from = verifyNow();
  let ok: boolean;
  try {
    ok = (verifyWith ?? verifyIdentityStrict)(rec.k, signBytes('hsum', ctx, rec), rec.g) === true;
  } catch {
    ok = false;
  }
  verifySpent += Math.max(0, verifyNow() - from);
  setHouseVerdict(id, ok);
  return ok;
}

/** 🏛️ Whether `rec`'s key is one that may check a checkpoint (design §6.1a
 *  step 5): the room's deed holder, or a house it delegated (houseOkOf). A
 *  delegation whose check waits reads as not-yet (undefined → false): the
 *  record is counted on a later pass, as the deed key or the delegation lands. */
function authorityOkHouseSum(rec: HouseSum): boolean {
  return rec.k === deedHolderKey() || houseOkOf(rec.k) === true;
}

/** 🏛️ Count the owner-signed checkpoint the doc holds for an incarnation: its
 *  shape (houseSumAt), its checker's authority and the `'hsum'` signature. The
 *  best valid one by order (compareHouseSum) is kept to put back (houseSumSeen,
 *  D3). A worse valid one, or junk, is left for D3 to overwrite. */
function noteHouseSum(t: string, inc: string): void {
  const map = computedMap;
  if (!map) return;
  const hs = houseSumAt(map, t, inc);
  if (!hs || !authorityOkHouseSum(hs)) return;
  // 🏛️ The ⚙ card's checkpoint label reads whether a valid-looking owner-signed
  // checkpoint is still being checked (CHECKING…, L-2) and this page's best one
  // (bestHouseSum): a shape- and authority-valid hs: arriving, or its check
  // landing, changes the label — so wake the card's listeners without a refold
  // (the label reads the doc fresh: computedTable computedCheckpointView).
  viewTouched.add(`computed:${t}`);
  if (houseSumOk(t, inc, hs, houseSumKey(t, inc)) !== true) return;
  // Register the incarnation so recovery can put the owner's checkpoint back:
  // computedRecoveries iterates the tracked incs, and this valid hs: may be the
  // only key the incarnation has left (every sum:/ses: deleted before this page
  // joined) — without this, F1 has nothing to find the incarnation by.
  trackComputed(t, inc);
  const key = `${t}:${inc}`;
  const ctx: FoldCtx = { room: boundRoomId, t, inc };
  const seen = houseSumSeen.get(key);
  if (!seen || compareHouseSum(ctx, hs, seen) > 0) houseSumSeen.set(key, hs);
}

/** 🏛️ The raw checkpoint the doc holds for an incarnation (computedTable's D2
 *  reads it to vouch for its own `b` and whether an end is its own). */
export function computedCheckpointOf(t: string, inc: string): Checkpoint | null {
  return computedMap ? checkpointAt(computedMap, t, inc) : null;
}

/** 🏛️ The best valid owner-signed checkpoint this page has counted for an
 *  incarnation (the ⚙ card's checkpoint label, C3; D3's put-back). */
export function bestHouseSum(t: string, inc: string): HouseSum | null {
  return houseSumSeen.get(`${t}:${inc}`) ?? null;
}

/** 🏛️ Whether this page has backed off putting an incarnation's `hs:` back
 *  (B12: two pages disagreeing on the owner's key; the ⚙ card says so). */
export function houseSumBackedOff(t: string, inc: string, now = Date.now()): boolean {
  const bo = houseSumBackoff.get(`${t}:${inc}`);
  return bo !== undefined && now < bo.until;
}

/** 🏛️ B1: whether this page saw the room's deed change hands during its visit
 *  (an established holder's key gave way). The ⚙ card adds · THE DEED CHANGED
 *  HANDS WHILE YOU WERE HERE to the label of a checkpoint signed by the new
 *  holder, and an owner-signed checkpoint by that holder takes no part in
 *  restores (§6.2 F). */
export function houseDeedChanged(): boolean {
  return deedChangedSeen;
}

/** 🏛️ Whether the doc holds a shape- and authority-valid owner-signed
 *  checkpoint for an incarnation whose `'hsum'` signature this page hasn't
 *  checked yet (the ⚙ card shows CHECKING… while it waits, label L-2). Reads
 *  the verdict cache only: it never spends a recount's budget or queues a
 *  slice, so a label read can't move the count forward. */
export function houseSumPending(t: string, inc: string): boolean {
  const map = computedMap;
  if (!map) return false;
  const hs = houseSumAt(map, t, inc);
  if (!hs || !authorityOkHouseSum(hs)) return false;
  const hash = recHash(hs);
  if (hash === null) return false;
  return !houseVerdicts.has(JSON.stringify(['hsum', boundRoomId, `${t}:${inc}`, hash]));
}

/** 🏛️ The ⚙ card's checkpoint label for an incarnation (design §6.2 D):
 *  display only. It sets the owner-signed checkpoint this page counted (A =
 *  bestHouseSum) against the checkpoint the live fold opened from — the
 *  session id it opens, `liveSid`, and its round `u`. The first row that
 *  applies wins (L-0..L-7); null is no label. The checker reads OWNER when it
 *  signed with the deed holder's own key, else a HOUSE it delegated (6b+).
 *  B1: a deed handover seen during the visit is named on a checkpoint the new
 *  holder signed. */
export function checkpointLabelOf(t: string, inc: string, liveSid: string, u: number): string | null {
  if (!deedHolderKey()) return null; // L-0: no deed holder (or a venture marker)
  if (u === 0) return null; // L-1: the genesis base — no checkpoint to label
  const head = `CHECKPOINT · ROUND ${u} · `;
  const A = bestHouseSum(t, inc);
  if (!A) return head + (houseSumPending(t, inc) ? 'CHECKING…' : 'NOT CHECKED BY THE OWNER'); // L-2 / L-3
  const who = A.k === deedHolderKey() ? 'OWNER' : 'HOUSE';
  const annot = deedChangedSeen ? ' · THE DEED CHANGED HANDS WHILE YOU WERE HERE' : '';
  const ctx: FoldCtx = { room: boundRoomId, t, inc };
  if (houseSumDigest(ctx, A) === liveSid) {
    // L-4 / L-5: A checks the very checkpoint the fold opened from.
    return head + (A.a === 0 ? `CHECKED BY THE ${who}` : `CHECKED BY THE ${who} FROM ROUND ${A.a + 1}`) + annot;
  }
  if (u > A.u) return `${head}NOT CHECKED SINCE ROUND ${A.u}${annot}`; // L-6
  return `🚩 THIS ISN'T THE CHECKPOINT THE ${who} CHECKED AT ROUND ${A.u}${annot}`; // L-7
}

/** 🏛️ D2's write: the deed holder's page stores its signed checkpoint at
 *  `hs:<t>:<inc>`. Its own signature is never re-checked, and it counts at once
 *  as the best this page has (so D3 puts it back if a peer takes it away). */
export function writeHouseSum(t: string, inc: string, rec: HouseSum): void {
  ensureMap();
  const map = computedMap!;
  const hash = recHash(rec);
  if (hash !== null) setHouseVerdict(JSON.stringify(['hsum', boundRoomId, `${t}:${inc}`, hash]), true);
  const key = `${t}:${inc}`;
  const ctx: FoldCtx = { room: boundRoomId, t, inc };
  const seen = houseSumSeen.get(key);
  if (!seen || compareHouseSum(ctx, rec, seen) > 0) houseSumSeen.set(key, rec);
  boundDoc!.transact(() => {
    map.set(houseSumKey(t, inc), rec);
  });
}

/** 🏠 Whether this page holds the room's deed (its key is the deed holder's,
 *  as deedHolderKey reads it: roomOwner isDeedHolder's rule): the page that
 *  delegates its node's house key and sets each table Fair or Friendly. */
export function holdsDeed(): boolean {
  const owner = deedHolderKey();
  return typeof owner === 'string' && owner === getIdentityPub();
}

/** 🏠 The order number (`s`) of the newest Fair setting of table `tableId`
 *  this page has seen by the deed holder, or 0: a new one must pass it. */
export function fairSettingSeq(tableId: string): number {
  return fairOf(tableId)?.s ?? 0;
}

/** 🏠 The owner's Fair setting for table `tableId`: 'friendly' when the
 *  newest one the deed holder signed (as this page has seen them) says so,
 *  else 'fair' (no record: Fair while the house is online). */
export function readFairSetting(tableId: string): 'fair' | 'friendly' {
  return fairOf(tableId)?.m === 1 ? 'friendly' : 'fair';
}

/** 🏠 When this page last heard any house of the room (its clock), or null. */
export function houseHeardAt(): number | null {
  const owner = deedHolderKey();
  let at: number | null = null;
  // (The keys the deed holder pinned, not every beat counted: houseBeats also holds
  // those of the keys live games hear, which strangers' games add to without a cap.)
  for (const pub of housePinned.keys()) {
    const b = houseBeats.get(pub);
    if (b && b.at !== null && pinnedHouse(pub, owner) && (at === null || b.at > at)) at = b.at;
  }
  return at;
}

/** 🏠 Whether a house of the room was heard in the last HOUSE_HEARD_MS (a
 *  clock that went back reads as heard: it can't say for how long it wasn't). */
export function houseOnline(now = Date.now()): boolean {
  const at = houseHeardAt();
  return at !== null && now - at <= HOUSE_HEARD_MS;
}

/** 🔒 Whether house `pub` was heard in the last HOUSE_HEARD_MS (a clock that went
 *  back reads as heard, as houseOnline's does): a beat counted from it as a
 *  house the deed holder pins now, or one a live FAIR ONLY game hears
 *  (FairOnlyState.houses), and not forgotten since (forgetBeat: one counted
 *  under a former deed holder's pin is not a game's to go by). A key that is
 *  neither now was heard by nothing:
 *  the answer a FAIR ONLY game's close or abandon asks of the house whose
 *  commitment it names (computedTable closePaused, abandonWait), which the room's
 *  houseOnline (the deed holder's houses) can't give for a game of another
 *  authority. */
export function houseHeardFrom(pub: string, now = Date.now()): boolean {
  const at = houseBeats.get(pub)?.at ?? null;
  return at !== null && now - at <= HOUSE_HEARD_MS && (gameHouseRefs.has(pub) || pinnedHouse(pub));
}

/** 🔒 The keys this page hears as the houses of FAIR ONLY game `inc` of table
 *  `tableId` (FairOnlyState.houses; none for a game that is not live or not
 *  tracked). Read-only. */
export function computedGameHouses(tableId: string, inc: string): ReadonlySet<string> {
  return computedIncs.get(`${tableId}:${inc}`)?.fo?.houses ?? NO_HOUSES;
}

/** 🔒 The house a close that names commitment `h` for the open round of FAIR
 *  ONLY game `inc` of table `tableId` depends on, as this page counted the game
 *  (computedHouse houseOfCommit): the one house that holds the seed behind `h`.
 *  Undefined for none a page can tell, which is no house to wait for. Read-only. */
export function computedCommitHouse(tableId: string, inc: string, h: string | undefined): string | undefined {
  const c = computedIncs.get(`${tableId}:${inc}`);
  return c?.last && c.fo ? houseOfCommit(c.last, c.fo.committing, h) : undefined;
}

/** The house that signed a game's base when the base is a house's trim: the one
 *  that holds the seed behind the commitment `h` it carries (a house trims only
 *  after its own reveal decided the round, design N3). A sweep, which any house
 *  of the holder may sign over the same content, carries another's commitment,
 *  and an adoption is signed by a buyer with no house: none either. */
function baseHouseOf(resolved: Resolution): string | undefined {
  const ck = resolved.base?.ck;
  return ck !== undefined && ck.w === undefined ? ck.dl?.h : undefined;
}

/** Whether a key is a house of the game for the round `res` has open (the
 *  resolution's houseAt: delegated by the key that holds the game then). One whose
 *  delegation is not checked yet is none for now, and `onWait` is told. */
function houseOfOpen(resolved: Resolution, res: FoldResult, onWait: () => void): (pub: string) => boolean {
  return (pub) => {
    const at = resolved.houseAt(pub, res.open);
    if (at === undefined) onWait();
    return at === true;
  };
}

/** Forget when `pub` was last heard: it is heard again from the next beat that
 *  comes in. A key some deed holder pinned keeps its count (housePinned holds
 *  it anyway), so the record it was counted from is no beat when a peer writes
 *  it again, or when a new holder's delegation has the doc's beat read again
 *  (countTransaction: a house pinned now). Any other key's goes whole: a
 *  stranger's game adds keys without a cap. */
function forgetBeat(pub: string): void {
  const beat = houseBeats.get(pub);
  if (!beat) return;
  if (housePinned.has(pub)) houseBeats.set(pub, { n: beat.n, at: null });
  else houseBeats.delete(pub);
}

/** Hear the keys `keys` (and no others) as FAIR ONLY game `fo`'s houses: a key
 *  new to the game counts from the next beat that comes in (the one already in
 *  the doc may be any age, and the doc keeps no time: a peer's writing it again
 *  is the next that comes in, for a beat proves the house signed it, not when),
 *  one it no longer hears has its beat forgotten (forgetBeat). Both unless the
 *  deed holder pins the key now (a handover leaves the old holder's pin in
 *  housePinned, and a beat counted under it is that holder's), and the first
 *  only for the first game to hear the key (a beat counted for another that
 *  hears it is the key's). */
function setGameHouses(fo: FairOnlyState, keys: readonly string[]): void {
  const was = fo.houses;
  if (keys.length === was.size && keys.every((k) => was.has(k))) return;
  const next = new Set(keys);
  for (const k of next) {
    if (was.has(k)) continue;
    const refs = gameHouseRefs.get(k) ?? 0;
    if (refs === 0 && !pinnedHouse(k)) forgetBeat(k);
    gameHouseRefs.set(k, refs + 1);
  }
  for (const k of was) {
    if (next.has(k)) continue;
    const left = (gameHouseRefs.get(k) ?? 1) - 1;
    if (left > 0) {
      gameHouseRefs.set(k, left);
      continue;
    }
    gameHouseRefs.delete(k);
    if (!pinnedHouse(k)) forgetBeat(k);
  }
  fo.houses = next;
}

/** 🏠 Whether the room has a house at all: a delegation this page counted.
 *  (Pinned once counted, which each delegation is as it comes, as the deed
 *  holder's key does or the deed moves, or after its check waited: the
 *  plaque asks every frame, and reads no record.) */
export function houseSetUp(): boolean {
  const owner = deedHolderKey();
  for (const pub of housePinned.keys()) if (pinnedHouse(pub, owner)) return true;
  return false;
}

/** 🏠 Whether `pub`'s delegation is in the doc now, as its deed holder signed
 *  it: undefined while its check waits (roomRecOk). */
export function delegationHeld(pub: string): boolean | undefined {
  const rec = asDelegation(computedMap?.get(delegationKey(pub)));
  if (rec === null || rec.h !== pub || rec.k !== deedHolderKey()) return false;
  return roomRecOk('hkey', '', rec, delegationKey(pub));
}

/** 🏠 Write a delegation the deed holder's page signed (computedHouse). */
export function writeDelegation(rec: DelegationRec): void {
  ensureMap();
  const map = computedMap!;
  boundDoc!.transact(() => {
    map.set(delegationKey(rec.h), rec);
  });
}

/** 🏠 Write a Fair setting the deed holder's page signed, for table `tableId`. */
export function writeFairSetting(tableId: string, rec: FairSettingRec): void {
  ensureMap();
  const map = computedMap!;
  boundDoc!.transact(() => {
    map.set(fairSettingKey(tableId), rec);
  });
}

/** 🏠 Put back what a delete or an older copy took away: each delegation this
 *  page counted by the deed holder as they are now, each table's newest Fair
 *  setting, and (D3) the best owner-signed checkpoint this page counted. Returns
 *  how many. */
export function putBackHouseRecords(now = Date.now()): number {
  if (!docAlive() || !computedMap) return 0;
  const map = computedMap;
  const back: [string, unknown][] = [];
  for (const pub of houseDelegations.keys()) {
    // A previous holder's delegation would stand over the new holder's own
    // (houseOkOf takes the new holder's of the same key, if the doc holds it).
    if (!houseOkOf(pub)) continue;
    const rec = houseDelegations.get(pub)!;
    const cur = asDelegation(map.get(delegationKey(pub)));
    if (!cur || recHash(cur) !== recHash(rec)) back.push([delegationKey(pub), rec]);
  }
  for (const t of fairSeen.keys()) {
    const rec = fairOf(t);
    if (!rec) continue;
    const cur = asFairSetting(map.get(fairSettingKey(t)));
    if (cur && recHash(cur) === recHash(rec)) continue;
    // A newer one by the deed holder that this page hasn't noted yet stands
    // (one whose check waits, until it is checked); anything else goes, a
    // forged one with a higher count included.
    if (cur && cur.k === rec.k && fairAfter(cur, rec)) {
      const ok = roomRecOk('hfair', t, cur, fairSettingKey(t));
      if (ok === undefined) continue;
      if (ok) {
        fairSeen.set(t, cur);
        continue;
      }
    }
    back.push([fairSettingKey(t), rec]);
  }
  // 🏛️ D3: the owner-signed checkpoints. The best one this page counted goes
  // back when the doc's is gone, junk, or worse by order (§6.1). A present
  // worse value is an overwrite; three in a minute (B12) and this page stands
  // down for ten (houseSumBackoff, houseSumBackedOff → ⚙ PAGES DISAGREE).
  let woke = false;
  for (const key of houseSumSeen.keys()) {
    const seen = houseSumSeen.get(key)!;
    // A handover ended the checker's authority: not this page's to defend.
    if (!authorityOkHouseSum(seen)) continue;
    const bo = houseSumBackoff.get(key);
    if (bo && now < bo.until) continue;
    const cut = key.lastIndexOf(':');
    const t = key.slice(0, cut);
    const inc = key.slice(cut + 1);
    const ctx: FoldCtx = { room: boundRoomId, t, inc };
    const doc = houseSumAt(map, t, inc);
    // The present value's authority and 'hsum' signature, read as the
    // Fair-setting loop above reads a newer record's: true valid, false junk,
    // undefined while its check is queued.
    const docOk = doc !== null && authorityOkHouseSum(doc)
      ? houseSumOk(t, inc, doc, houseSumKey(t, inc))
      : false;
    // A newer or better attestation this page hasn't finished checking yet:
    // leave it for the recheck to count, as the Fair loop waits on `undefined`
    // — don't overwrite it with our older best, nor count it a B12 overwrite.
    if (docOk === undefined && compareHouseSum(ctx, doc!, seen) > 0) continue;
    if (docOk === true && compareHouseSum(ctx, seen, doc!) <= 0) continue;
    // A present value worse than ours (not a bare delete) counts toward B12.
    if (doc !== null && recHash(doc) !== recHash(seen)) {
      const hits = (bo?.hits ?? []).filter((at) => now - at < BACKOFF_WINDOW_MS);
      hits.push(now);
      if (hits.length >= BACKOFF_COUNT) {
        houseSumBackoff.set(key, { hits, until: now + BACKOFF_MS });
        // 🏛️ Wake the ⚙ card to show PAGES DISAGREE now: entering backoff writes
        // no put-back, so without this the card holds its green label until an
        // unrelated casino update. The touch is flushed below (woke) when no
        // put-back transaction carries it.
        viewTouched.add(`computed:${t}`);
        woke = true;
        continue;
      }
      houseSumBackoff.set(key, { hits, until: 0 });
    }
    back.push([houseSumKey(t, inc), seen]);
  }
  // 🏛️ Backoff touched the view but may have nothing to put back: with no
  // transaction to fire the afterTransaction flush, tell the card now.
  if (back.length === 0) {
    if (woke) notify(takeTouched(new Set()));
    return 0;
  }
  boundDoc!.transact(() => {
    for (const [key, value] of back) map.set(key, value);
  });
  return back.length;
}

function trackComputed(t: string, inc: string): ComputedInc {
  const key = `${t}:${inc}`;
  let c = computedIncs.get(key);
  if (c) return c;
  const ctx: FoldCtx = { room: boundRoomId, t, inc };
  // 🔒 A FAIR ONLY game's houses are the ones its resolution says decide a round.
  const fo: FairOnlyState | null = isFairOnlyInc(inc)
    ? { cks: new Map(), xfs: new Map(), fin: undefined, res: null, held: null, heldWhole: null, heldXfs: new Map(), heldFin: undefined, heldHks: new Map(), houseUsed: new Map(), hkUnder: new Map(), hkOver: new Map(), hkWaits: false, lacking: false, returns: 0, sesMoves: 0, folded: undefined, sidFor: null, sid: '', houses: NO_HOUSES, committing: undefined, committingWaits: false }
    : null;
  // (…and the page keeps which keys it answered were, and the delegation the
  // resolution went by for each: they are what the fold's counts stand on,
  // keepHouses. Where the resolution found one, the room's key, an older
  // checkpoint or this page's own offer, may hold it no more the next time the
  // game is resolved.)
  const houses: HouseCheck = fo
    ? (pub, round) => {
      // (Asked once: a second asking may find the verdict let go of, and this count's time spent.)
      const by = fo.res?.houseBy(pub, round);
      if (!by) return by === null ? false : undefined;
      let used = fo.houseUsed.get(pub);
      if (!used) fo.houseUsed.set(pub, used = new Map());
      used.set(by.hash, by.value);
      return true;
    }
    : houseOkOf;
  c = {
    t, inc, key, ctx, fold: new TableFold(ctx, computedCheck(key), computedPinOf, undefined, houses),
    cp: null, sid: fo ? '' : 'g', live: null, sidOf: { cp: null, sid: 'g' }, stale: true,
    countedSid: null, chain: [], gaveUp: null, calm: 0, last: null, liveHeld: false, seen: new Map(), refuted: [], dropped: [], doubted: new Set(), forged: false, leftFor: null, takesPlace: false, fo,
  };
  computedIncs.set(key, c);
  if (fo) {
    foGames += 1;
    // (The placement of its table, as the layout holds it now: noteTableRecord.)
    if (!foTables.has(t)) noteTableRecord(t);
    foTables.add(t);
    staleGames.add(c);
  }
  let incs = computedIncsOf.get(t);
  if (!incs) computedIncsOf.set(t, incs = new Set());
  incs.add(inc);
  if (!fo) newlyTracked.push(c);
  return c;
}

/** Whether something of table `tableId` this page counted is gone from the
 *  doc, nothing having closed it (casinoWhole): the live session's map
 *  while the checkpoint still opens it (sessionLost). A checkpoint this page
 *  counted gone, or junk in its place, is no longer one: the page holds its
 *  head meanwhile (heldBase). (An older build, or this one with recovery
 *  off, reads that as lost too: no build deletes a checkpoint.) */
function computedLost(tableId: string): boolean {
  const incs = computedIncsOf.get(tableId);
  const map = computedMap;
  if (!incs || !map) return false;
  for (const inc of incs) if (incLost(computedIncs.get(`${tableId}:${inc}`)!, map)) return true;
  return false;
}

/** computedLost of one incarnation. A trim deletes the session in the
 *  transaction that writes the checkpoint closing it, so the session reads
 *  as lost only on a doc holding part of that (whose deletes Yjs applies
 *  first), or after a page deleted it with nothing in its place: its decided
 *  rounds would read as never played. The recovery duty opens it again, and
 *  past GIVE_UP_MS gives those rounds up (giveUpComputed). */
function incLost(c: ComputedInc, map: Y.Map<unknown>): boolean {
  if (c.fo) return fairOnlySessionLost(c, map);
  const cp = heldBase(c, map);
  if (c.chain.length > 0 && cp === null) return true;
  return sessionLost(c, map, cp);
}

/** 🔒 incLost of a FAIR ONLY game: the live session this page counted is gone
 *  from the doc while the base that opens it stands. (The base itself is never
 *  lost: the page holds it, and offers it to the resolver whatever the doc
 *  does with it. Nor is a game that has ended: its nets stand from its end
 *  checkpoint, and no session of it counts, so compaction may delete them.) */
function fairOnlySessionLost(c: ComputedInc, map: Y.Map<unknown>): boolean {
  const base = c.fo!.res?.base?.ck;
  return c.countedSid !== null && base !== undefined && base.e !== 1 && sid3Of(c, base) === c.countedSid
    && !(map.get(sessionKey(c.t, c.inc, c.countedSid)) instanceof Y.Map);
}

/** The sid of the session FAIR ONLY checkpoint `ck` opens (nextSid3, hashed
 *  once per checkpoint: casinoWhole asks every frame). */
function sid3Of(c: ComputedInc, ck: CkRec): string {
  const fo = c.fo!;
  if (fo.sidFor !== ck) {
    fo.sid = nextSid3(c.ctx, ck);
    fo.sidFor = ck;
  }
  return fo.sid;
}

function sessionLost(c: ComputedInc, map: Y.Map<unknown>, cp: Checkpoint | null): boolean {
  return c.countedSid !== null && liveSidOf(c, cp) === c.countedSid
    && !(map.get(sessionKey(c.t, c.inc, c.countedSid)) instanceof Y.Map);
}

/** Stamp the record keys this page sees in an incarnation's live session
 *  for the first time. */
function stampArrivals(c: ComputedInc, keys: Iterable<string>): void {
  let now: number | undefined;
  for (const key of keys) {
    if (c.seen.has(key) || !parseKey(key)) continue;
    c.seen.set(key, now ??= txNow ?? Date.now());
  }
}

/** Stamp the dice throw table `tableId`'s `throw:` key holds now, if this
 *  page hasn't seen it before. */
function stampThrow(casino: Y.Map<unknown>, tableId: string): void {
  const v = casino.get(`throw:${tableId}`);
  if (!isDiceThrow(v)) return;
  let m = throwSeen.get(tableId);
  if (!m) throwSeen.set(tableId, m = new Map());
  const key = `${v.round}|${v.by}|${v.seed}`;
  if (m.has(key)) return;
  m.set(key, txNow ?? Date.now());
  while (m.size > THROWS_KEPT) m.delete(m.keys().next().value as string);
}

/** 🎲 When this page first saw dice throw `thr` at table `tableId` (its own
 *  Date.now() as the update that brought it began, the same as a close in
 *  that update carries: computedSeenAt), or undefined: a throw from before
 *  this doc was bound, or from before a computed table was up. */
export function computedThrowSeenAt(tableId: string, thr: DiceThrow): number | undefined {
  return throwSeen.get(tableId)?.get(`${thr.round}|${thr.by}|${thr.seed}`);
}

/** What a key the live session holds holds, as the fold reads it. Yjs keeps
 *  a key set to undefined (the doc grows by it, as by any junk), which the
 *  fold would read as gone, never weighing it (rawBytes): it goes as null,
 *  junk like any other. */
const heldValue = (value: unknown): unknown => (value === undefined ? null : value);

/** Read an incarnation whole: its checkpoint, and every record of the
 *  session that opens (a session map made in this very transaction reports
 *  nothing of its own). The stamps of keys it no longer holds go (a record
 *  copied into the next session keeps its stamp: same key), and once it is
 *  another session, the verdicts of records it doesn't hold. 🔒 A FAIR ONLY
 *  game's checkpoint is the resolver's choice (resolveFairOnly), and with none
 *  it has no session and counts nothing (S4: the table is not open). */
function readComputedWhole(c: ComputedInc, map: Y.Map<unknown>): void {
  const fo = c.fo;
  const base = fo ? fo.res!.base?.ck ?? null : null;
  const cp = fo ? null : heldBase(c, map);
  const sid = fo ? (base === null ? '' : sid3Of(c, base)) : liveSidOf(c, cp);
  const raw = sid === '' ? undefined : map.get(sessionKey(c.t, c.inc, sid));
  const live = raw instanceof Y.Map ? (raw as Y.Map<unknown>) : null;
  const entries = live ? [...live.entries()].map(([key, value]): [string, unknown] => [key, heldValue(value)]) : [];
  if (fo) {
    c.fold.setFairOnlyBase(base);
    fo.folded = base;
  } else {
    c.fold.setBase(cp);
  }
  c.fold.reset(entries);
  const keys = new Set(entries.map(([key]) => key));
  for (const key of [...c.seen.keys()]) if (!keys.has(key)) c.seen.delete(key);
  stampArrivals(c, keys);
  if (live !== c.live) {
    const hashes = new Set<string>();
    for (const key of keys) {
      const h = parseKey(key)?.h;
      if (h) hashes.add(h);
    }
    const verdicts = verdictsOf(c.key);
    for (const h of [...verdicts.keys()]) if (!hashes.has(h)) verdicts.delete(h);
  }
  c.cp = cp;
  c.sid = sid;
  c.live = live;
}

/** Index the keys a transaction changed in an incarnation's live session.
 *  A key deleted loses its stamp at once: put back, it arrives anew. */
function applyComputed(c: ComputedInc, keys: Iterable<string>): void {
  const live = c.live!;
  const changes: [string, unknown][] = [];
  for (const key of keys) changes.push([key, live.has(key) ? heldValue(live.get(key)) : undefined]);
  c.fold.apply(changes);
  const arrived: string[] = [];
  for (const [key, value] of changes) {
    if (value === undefined) c.seen.delete(key);
    else arrived.push(key);
  }
  stampArrivals(c, arrived);
}

/** An incarnation's decided nets in the ledger, as its fold reads them now
 *  (recountBook's diff). A slot bankroll's account is never a bettor. */
function recountComputed(ix: ChipIndex, incKey: string, nets: ReadonlyMap<string, bigint>): void {
  const before = ix.computed.get(incKey);
  for (const pid of new Set([...(before?.keys() ?? []), ...nets.keys()])) {
    if (!isBankrollAccount(pid)) addToAccount(ix, pid, (nets.get(pid) ?? 0n) - (before?.get(pid) ?? 0n), computedTouched);
  }
  if (nets.size > 0) ix.computed.set(incKey, new Map(nets));
  else ix.computed.delete(incKey);
}

/** What an incarnation's felts hold, in the running total heldStake adds,
 *  noting whose changed for their listeners. */
function recountComputedHeld(incKey: string, held: ReadonlyMap<string, bigint>): void {
  const before = computedHeld.get(incKey);
  for (const pid of new Set([...(before?.keys() ?? []), ...held.keys()])) {
    const d = (held.get(pid) ?? 0n) - (before?.get(pid) ?? 0n);
    if (d === 0n || isBankrollAccount(pid)) continue;
    const total = (computedHeldBy.get(pid) ?? 0n) + d;
    if (total === 0n) computedHeldBy.delete(pid);
    else computedHeldBy.set(pid, total);
    computedTouched.add(pid);
  }
  if (held.size > 0) computedHeld.set(incKey, new Map(held));
  else computedHeld.delete(incKey);
}

/** Whether the switch of table `c.t` stands behind page-signed incarnation
 *  `c` as far as its felts go: it names `c`, or a FAIR ONLY game, live or not,
 *  or an incarnation of the other game beside a live game (otherGameStands).
 *  A FAIR ONLY name is S9's hint to the game the table plays, not another
 *  incarnation taking `c`'s place (computedIncOf): while the game is live the
 *  page-signed incarnation only waits, its frozen slips still to settle when
 *  the game ends (computedEndedIncs, computedTable tableOf), and where it is
 *  not live the pages that ran `c` put the switch back over the name
 *  (putComputedSwitchBack), so the felts go on holding what their players
 *  staked either way. (Nothing here ends an incarnation: that is a `gone:`
 *  mark, a checkpoint that says so, or compaction after the wait.) A hint
 *  holds by the name alone, not by the game's liveness: no recount is due for
 *  it when a game opens or ends, and none flickers the stake free between the
 *  game's end and the put-back. A name of the other game holds with a live game
 *  of `c`'s own game and not without one, so the table's incarnations are
 *  counted again when the game played moves from or to a game, and when the set
 *  of live letters moves (notePlayedGames). Neither holds once the switch has
 *  named another page-signed incarnation of `c`'s game since (`c.leftFor`):
 *  then `c` is over, and its pages let go of its slips, so a name that comes
 *  after holds nothing of it. */
function switchHoldsFelts(named: string | null, c: ComputedInc): boolean {
  return named === c.inc || (named !== null && c.leftFor === null && (isFairOnlyInc(named) || otherGameStands(c, named)));
}

/** Whether `named`, the name in the switch of table `c.t`, is an incarnation of the
 *  other game that the doc holds and nothing has ended, while a FAIR ONLY game of `c`'s
 *  game is live at the table: page-signed incarnation `c`'s game cannot play it, so it
 *  is a peer's doing (or a forgery), and it is no successor of `c` and no hint to the
 *  game either. The table plays the game and `c` waits, as it waits under a hint: its
 *  players are mid-round, its seeds and its state are kept, so the stakes of its felts
 *  stay held (the chips are not there to spend while the round can still settle) and
 *  compaction leaves it be. The room takes the name away a minute on (computedTable
 *  awayDuty ends a name of another game than the table's, as a removal ends it, and
 *  names the incarnation its pages run in the same write); a table out of the room's
 *  list has no such page, and compaction ends the abandoned incarnation, its open round
 *  void. Where the game live is not of `c`'s game, `c` waits for nothing: the table
 *  cannot play it, so the name of the table's own game in the switch (written after `c`
 *  was named, or beside a session of `c` that nothing named) holds none of its stakes,
 *  and compaction ends it after its wait. A name
 *  the doc holds nothing of, or one that has ended, is a lost switch instead, which those
 *  pages put back at their next look. With no live game it is the same lost switch, as on
 *  main: the stakes free, and compaction ending the incarnation after its wait unless the
 *  name goes first (a name deleted within seconds is put over by the pages that ran the
 *  incarnation: putSwitchBack, pinned by computedRobotPages.test.ts). */
function otherGameStands(c: ComputedInc, named: string): boolean {
  return gameOfInc(named) !== gameOfInc(c.inc) && liveGameOf(c.t, gameOfInc(c.inc))
    && ordinaryInc(c.t, named) !== undefined && !computedIncEnded(c.t, named);
}

/** Whether table `t` has a live FAIR ONLY game of `game`. */
function liveGameOf(t: string, game: GameName): boolean {
  const live = foLive.get(t);
  if (live === undefined) return false;
  for (const name of live.keys()) if (gameOfInc(name) === game) return true;
  return false;
}

/** Whether the switch of table `tableId` has left page-signed incarnation `inc`
 *  for another, as this page counted it (`ComputedInc.leftFor`): `inc` is over,
 *  and a page that ran it lets go of its slips (computedTable supersede), even
 *  when the switch names a FAIR ONLY game's hint now. */
export function switchLeft(tableId: string, inc: string): boolean {
  return (ordinaryInc(tableId, inc)?.leftFor ?? null) !== null;
}

/** The page-signed incarnation the switch of table `tableId` has left `inc`
 *  for, if nothing has ended it; else null. (The latch holds only a name this
 *  page counts, and a counted incarnation stays counted until the doc is bound
 *  afresh, which resets the latch too.) The state of a page that ran `inc` is
 *  put by it (computedTable supersede); if it ended meanwhile nothing takes
 *  `inc`'s place, which stays over. */
export function switchLeftFor(tableId: string, inc: string): string | null {
  const to = ordinaryInc(tableId, inc)?.leftFor ?? null;
  return to !== null && !computedIncEnded(tableId, to) ? to : null;
}

/** Count one incarnation as its fold reads now: its nets in the ledger, and
 *  what its felts hold while it is live, both from one result. On a doc
 *  holding part of an update, or missing what this page counted of the
 *  table (casinoWhole), its last values stand instead (parked) until it is
 *  whole, when it is read whole again. */
function countComputed(c: ComputedInc, map: Y.Map<unknown>, casino: Y.Map<unknown>, whole: boolean, keys?: Set<string>): void {
  if (!casinoWhole(c.t)) {
    computedParked.add(c.key);
    c.stale = true;
    // 🔒 (A game's put-backs are counted while it is not, noteFairOnlyLacks,
    // and what stands under the keys of the delegations it holds is looked at
    // as after a count, with no house let go of for want of a record: the
    // fold asked of none, keepHouses. Neither on a doc that holds part of an
    // update, where nothing is judged; the base the answer names is noted for
    // the houses held there too, which judges nothing: noteHousesParked.)
    if (c.fo) {
      noteHousesParked(c.fo);
      if (!docHoldsPart()) {
        keepHouses(c, c.fo.res!.pending, true);
        noteFairOnlyLacks(c, map);
      }
    }
    return;
  }
  if (c.fo) {
    countFairOnly(c, map, whole, keys);
    return;
  }
  if (whole || c.stale) readComputedWhole(c, map);
  else if (keys) applyComputed(c, keys);
  computedParked.delete(c.key);
  c.stale = false;
  const res = c.fold.result();
  const named = computedCfgInc(casino.get(`cfg:computed:${c.t}`));
  // (🔒 Another page-signed incarnation of this table's game, one the doc holds,
  // took the switch: this one is over, whatever FAIR ONLY name the switch
  // carries later. Read on a whole doc only, as above: a doc holding part of
  // an update can read a switch that a parked write overwrites. The switch
  // naming this one again undoes it. A name of the table's other game (a peer's
  // doing, no incarnation this table can play) is none of that: beside a live game
  // the felts wait under it when the doc holds the name and nothing has ended it,
  // and are free otherwise (switchHoldsFelts, otherGameStands). A FAIR ONLY name is
  // none either, and ordinaryInc has none of those: the test is belt and braces.)
  if (named === c.inc) c.leftFor = null;
  else if (named !== null && !isFairOnlyInc(named) && gameOfInc(named) === gameOfInc(c.inc)
    && ordinaryInc(c.t, named) !== undefined && !computedIncEnded(c.t, named)) c.leftFor = named;
  const live = switchHoldsFelts(named, c)
    && !casino.has(goneKey(c.t, c.inc)) && !res.base.ended;
  recountComputed(chipIndex, c.key, res.nets);
  recountComputedHeld(c.key, live ? res.held : NO_COMPUTED_HELD);
  if (res !== c.last || live !== c.liveHeld) viewTouched.add(`computed:${c.t}`);
  const was = c.last;
  c.last = res;
  c.liveHeld = live;
  const watched = c.countedSid;
  c.countedSid = c.live ? c.sid : null;
  noteCounted(c, map, watched, txNow ?? Date.now());
  if (recoveryOn) noteDoubted(c, was, res, map);
  const head = c.chain[c.chain.length - 1];
  if (head && head.sid === c.sid) {
    for (const s of res.felts.values()) {
      if (head.pubs.size >= MAX_TABLE_PIDS) break;
      if (s.rec.b.length > 0) head.pubs.add(s.rec.k);
    }
  }
}

// ── 🔒 FAIR ONLY games (computedFairOnly; PR 6c-4a-1) ────────────────────────
// A FAIR ONLY game (letters `p` roulette, `q` craps) is a house table whose
// authority is bound into its name and which keeps its checkpoints at the top
// level of `casinoComputed` (`ck:`), beside its transfers (`xf:`) and its end
// order (`fin:`). The page keeps those records as the doc holds them, asks the
// authority resolver (computedFairOnlyAuth) which checkpoint stands, and folds
// the session that checkpoint opens, where an ordinary table's page-signed
// chain of checkpoints, its recovery and its doubt have no part. Its nets go
// into the ledger whenever it has a base, and its felts hold chips while it is
// live (a base that isn't an end): the table's switch and a removal's `gone:`
// mark are not in it (design §8.3 S7, S8). Nothing here writes a record, and
// until PR 6c-5 nothing writes a name this reads.

/** Keep the value the doc holds at FAIR ONLY record `key` (gone: none) of the
 *  game `c`, and read the game again before it is counted — unless the record
 *  was nothing to the resolver before and is nothing now. */
function noteFairOnlyRecord(c: ComputedInc, kind: 'ck' | 'xf' | 'fin', key: string, map: Y.Map<unknown>): void {
  const fo = c.fo!;
  const value = map.get(key);
  let was: unknown;
  if (kind === 'fin') {
    was = fo.fin;
    fo.fin = value;
  } else {
    const records = kind === 'ck' ? fo.cks : fo.xfs;
    was = records.get(key);
    if (value === undefined) records.delete(key);
    else records.set(key, value);
  }
  if (!staleGames.has(c) && (!inertFairOnly(kind, key, was) || !inertFairOnly(kind, key, value))) staleGames.add(c);
}

/** Whether a value at a FAIR ONLY record key is nothing to the resolver: none,
 *  or what its own readers take for junk (readCk; asXf under its key's id;
 *  asFin). A guest can write any value under a well-formed key, so junk
 *  written, changed or deleted resolves nothing again. (A rules version this
 *  build doesn't know is not junk: it reads UPDATE TO PLAY.) */
function inertFairOnly(kind: 'ck' | 'xf' | 'fin', key: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (kind === 'ck') return readCkMemo(key, value).kind === 'junk';
  if (kind === 'fin') return asFin(value) === null;
  const xf = asXf(value, boundRoomId);
  const at = parseFairOnlyKey(key);
  return xf === null || at === null || at.kind !== 'xf' || xfId(xf) !== at.id;
}

/** Whether `value` at room key `key` is a delegation the resolver can use: a
 *  delegation's shape, light enough (it is a few short fields: one padded past
 *  MAX_SMALL_RECORD_BYTES is junk to the resolver, as a padded transfer is,
 *  and asDelegation does not weigh it), under its own house's key (as an
 *  honest writer stores one). */
function fedDelegation(key: string, value: unknown): boolean {
  if (weightOf(value, MAX_SMALL_RECORD_BYTES) === null) return false;
  const d = asDelegation(value);
  return d !== null && key === delegationKey(d.h);
}

/** Keep the value the doc holds at room delegation `key` (`hk:<pub>`; gone:
 *  none) if the resolver can use it, and read every FAIR ONLY game again if it
 *  was one or is: a house of theirs may be delegated there. Junk under an `hk:`
 *  key, written, changed or deleted, moves nothing. */
function noteDelegation(key: string, map: Y.Map<unknown>): void {
  const value = map.get(key);
  const was = hkRaw.has(key);
  const now = value !== undefined && fedDelegation(key, value);
  if (now) hkRaw.set(key, value);
  else hkRaw.delete(key);
  if (!was && !now) return;
  hkFeed = null;
  for (const c of computedIncs.values()) if (c.fo) staleGames.add(c);
}

/** The room's delegations as a resolution reads them, made once per change. */
function hkFeedOf(): unknown[] {
  hkFeed ??= [...hkRaw.values()];
  return hkFeed;
}

/** readCk, once per value (a checkpoint weighs up to MAX_CHECKPOINT_BYTES and a
 *  resolution reads every one the game has): the same value at the same key in
 *  the same room reads the same. */
const ckReads = new WeakMap<object, { room: string; key: string; read: CkRead }>();
function readCkMemo(key: string, value: unknown): CkRead {
  if (typeof value !== 'object' || value === null) return readCk(boundRoomId, key, value);
  const hit = ckReads.get(value);
  if (hit && hit.room === boundRoomId && hit.key === key) return hit.read;
  const read = readCk(boundRoomId, key, value);
  ckReads.set(value, { room: boundRoomId, key, read });
  return read;
}

/** 🔒 Keep what the resolution just made stands on, of the records it was given
 *  (FairOnlyState heldXfs, heldFin): the transfers of its chain, and the end
 *  order standing, each wherever the resolution found it. A transfer that has
 *  a key is kept as that key's value (`xfs`: the doc's and the held ones). One
 *  found only inside a checkpoint (its `x`: Step has no key then) is kept
 *  under the key that is its own (xfKey of its id), as the checkpoint carries
 *  it, whichever checkpoint that is: one that is not the base is held by no
 *  one, a peer may delete it and compaction will, and the chain that stood on
 *  its copy alone would go back to the holder before (the seller's last
 *  checkpoint the base, at the round of the sale, and the buyer's first
 *  carrying the transfer); and the base a resolution names is held only once
 *  the page has counted from it, which it does not while its table is not
 *  whole. Held under its key, the transfer is offered to the next resolution
 *  there and put back there (fairOnlyLacks; design §8.4 P2: the `xf:` values
 *  the chain uses), where the pages that come later find it. The order is
 *  kept as the resolution hands it back (asFin gives the value it read: the
 *  `fin:` key's, the held one itself, or the one inside the base, which is an
 *  end checkpoint then), when the page holds none: one the base carries is
 *  held for the same reason, and is put back only if the game is live again,
 *  its end checkpoint gone before this page counted from it (of an ended game
 *  nothing but its base is put back).
 *
 *  A resolution lets go of nothing: it adds. What the page holds is what its
 *  count stands on, and a resolution is no count yet. One that waits for a
 *  check may have stopped short of a record whose verdict the cache let go,
 *  and a chain cut short at a transfer not checked yet is the holders' before
 *  it, whose own end order stands there where the held one's signer is not
 *  reached. And one that waits for nothing is not counted while the game's
 *  table is not whole (countComputed): the base it names is one the page does
 *  not hold then, and with that base deleted before the page counts from it
 *  the game is at the base the page holds again, on what that one stood on:
 *  the seller's end order, say, which stands no more at the buyer's
 *  checkpoint and stands at the seller's. What an answer does not stand on is
 *  let go of where the page counts from it (settleStanding). */
function keepStanding(fo: FairOnlyState, xfs: ReadonlyMap<string, unknown>): void {
  const res = fo.res!;
  for (const { step } of res.chain) {
    if (!step) continue;
    if (step.key === undefined) fo.heldXfs.set(xfKey(res.t, res.inc, step.id), step.xf);
    else if (xfs.has(step.key)) fo.heldXfs.set(step.key, xfs.get(step.key));
  }
  if (fo.heldFin === undefined && res.fin !== null) fo.heldFin = res.fin;
}

/** 🔒 Let go of what the page holds of the game's transfers and end order that
 *  the resolution it now counts from does not stand on (FairOnlyState heldXfs,
 *  heldFin): a transfer that is not of its chain, and the order held when
 *  another stands, or none. At a count from the base of an answer that waited
 *  for no check (countFairOnly), where the base held is replaced too: what
 *  the base before stood on is needed no more once the page holds this one,
 *  and not before. Each transfer of the chain is held already (keepStanding,
 *  when the answer was made); the order is the one the answer handed back. */
function settleStanding(fo: FairOnlyState): void {
  const res = fo.res!;
  const steps = new Map<string, unknown>();
  for (const { step } of res.chain) {
    if (!step) continue;
    const key = step.key ?? xfKey(res.t, res.inc, step.id);
    if (fo.heldXfs.has(key)) steps.set(key, fo.heldXfs.get(key));
  }
  fo.heldXfs = steps;
  fo.heldFin = res.fin ?? undefined;
}

/** 🔒 Keep the delegations the game's houses stand on (FairOnlyState heldHks),
 *  and say what stands under their houses' keys now (`hkOver`, `hkWaits`). For
 *  each key the fold counted a record of as a house's (`houseUsed`: a join, a
 *  reveal or a step-down of the live session, of a round decided or not: one
 *  that stopped counting would undo the round):
 *  - the ones held before, while their signers are holders of the game (each
 *    was checked when it was first kept, and a verdict the cache has let go
 *    since takes nothing back);
 *  - the ones the count went by (the resolution's houseBy, noted as the fold
 *    asked: checked there), wherever the resolution found them: under the
 *    house's key, in a checkpoint of the game that is not its base (an older
 *    one, which a peer may delete and compaction will), or among the ones this
 *    page offered it. So a count goes by no delegation the page does not hold,
 *    whatever was let go of before and whatever the doc loses after. But for
 *    the one the base carries: the page holds the base, and that one needs no
 *    key. A house that plays on under the delegation an older checkpoint
 *    carries, after a base that carries another, has it put under its key;
 *  - and the value at `hk:<house>`, when it is a delegation of the house that a
 *    holder of the game signed and its check passes: the resolver's own check
 *    (the same id: one verdict), made here because the resolver asks only of a
 *    delegation whose signer holds the round a record is of. The key holds one
 *    value, and after a hand-over the buyer may delegate the node the seller
 *    did: this page keeps both, and offers the resolver the one the doc lost.
 *  Anything else a peer wrote under the key of one held, a stranger's
 *  delegation of the house or one whose signature fails, would leave the pages
 *  that come later without the house: the held one is written over it
 *  (fairOnlyLacks). One whose check waits is left for now, and the slice that
 *  checks it counts the game again. While the fold or the resolution waits for
 *  a check (`waits`), what was held stays: the fold has not asked of every
 *  house then, or the chain is not whole (a holder not told yet is no
 *  stranger).
 *
 *  And while the game counts from a base a house is kept for (`hkUnder`), the
 *  house is gone through with the ones the fold counted a record of: a
 *  session's map a peer deleted comes back empty (the put-back duty opens it,
 *  and the records' authors and witnesses put them back into it after), so the
 *  fold of that moment counts no house's record, and a delegation let go of
 *  then, with its key deleted too, would leave the rounds its house decided
 *  undecided once the records are back. A house no record is of is let go of
 *  when the game moves on to another base: its rounds are in a checkpoint
 *  then. (Should a record of its house count in the new base's session after
 *  that, under a resolution made while the page held the delegation still, it
 *  is kept again from that resolution.)
 *
 *  Which bases a house is kept for is noted where the page learns it, by
 *  house, and nowhere worked out after the fact from what else the page holds
 *  (the base it counted from last may be one that a count that waited went
 *  by, short of the chain: a forged transfer not checked yet):
 *  - a count whose answer and fold waited for nothing settles it: every house
 *    it keeps is kept for its base, and for that one alone from there;
 *  - a count that waited adds its base for the houses it went by a record of
 *    (and lets go of nothing, so it takes no base from any house either: the
 *    game may be back at the one before, on what stood there);
 *  - and while the game is not counted because its table is not whole
 *    (noteHousesParked), the base each answer names is added for every house
 *    held.
 *  While the game is not counted (`parked`: the map of the session this page
 *  counted from its base is gone, or something else of the table this page
 *  read is, casinoWhole: a table is whole or not as one) the keys of all the
 *  delegations held are looked at all the same (every house held is kept for
 *  the base the answer names by then), and no house is let go of for want of
 *  a record: the fold asked of none. A peer that deletes the session's map
 *  and writes a stranger's delegation over a held one has the held one put
 *  back at once, which waits for nobody to open the session again.
 *  A held one whose signer holds the game no more is let go of there as at any
 *  whole count: the chain is the resolution's, not the fold's. */
function keepHouses(c: ComputedInc, waits: boolean, parked = false): void {
  const fo = c.fo!;
  const chain = fo.res!.chain;
  const placeOf = (k: string): number => {
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].k === k) return i;
    return -1;
  };
  const base = fo.res!.base?.key ?? null;
  const carried = fo.res!.base?.ck.dl === undefined ? null : recHash(fo.res!.base.ck.dl);
  const pubs = new Set(fo.houseUsed.keys());
  for (const key of fo.heldHks.keys()) if (fo.hkUnder.get(key)?.includes(base)) pubs.add(houseKeyParts(key)!.of);
  const kept = new Map<string, HeldDelegation[]>();
  const over = new Map<string, unknown>();
  let hkWaits = false;
  for (const pub of pubs) {
    const key = delegationKey(pub);
    const good = new Map<string, HeldDelegation>();
    for (const h of fo.heldHks.get(key) ?? []) {
      const at = placeOf(asDelegation(h.value)!.k);
      if (at >= 0) good.set(h.hash, { ...h, at });
      else if (waits) good.set(h.hash, h);
    }
    // (One held before is the same record: the resolution was given the value this page holds, or the room's.)
    for (const [hash, value] of fo.houseUsed.get(pub) ?? []) {
      if (hash !== carried) good.set(hash, { value, hash, at: placeOf(value.k) });
    }
    const raw = hkRaw.get(key);
    const d = raw === undefined ? null : asDelegation(raw);
    if (d) {
      const at = d.h === pub ? placeOf(d.k) : -1;
      const hash = recHash(d);
      let ok: boolean | undefined;
      if (hash !== null && good.has(hash)) ok = true;
      else if (hash === null || at < 0) ok = waits && hash !== null && d.h === pub ? undefined : false;
      else {
        ok = authCheck(sigId('hkey', c.t, c.inc, hash), d.k, () => roomSignBytes('hkey', boundRoomId, '', d), d.g);
        if (ok === undefined) hkWaits = true;
      }
      // (The doc's value stands for the record from here: what is put back is compared with it.)
      if (ok === true) good.set(hash!, { value: raw, hash: hash!, at: at >= 0 ? at : good.get(hash!)!.at });
      else if (ok === false) over.set(key, raw);
    }
    // (The latest holder's last; two of one holder's, by their hashes: every page that holds both names the same.)
    if (good.size > 0) kept.set(key, [...good.values()].sort((x, y) => x.at - y.at || (x.hash < y.hash ? -1 : 1)));
  }
  if (!waits) fo.heldHks = kept;
  else for (const [key, list] of kept) fo.heldHks.set(key, list);
  // (The bases each house held is kept for: a count that waited for nothing
  // settles on its own, and one that waited adds its own for the houses it
  // went by. Nothing while the game is not counted: noteHousesParked.)
  const under = new Map<string, (string | null)[]>();
  for (const key of fo.heldHks.keys()) {
    const was = fo.hkUnder.get(key) ?? [];
    if (!parked && !waits) under.set(key, [base]);
    else under.set(key, !parked && kept.has(key) && !was.includes(base) ? [...was, base] : was);
  }
  fo.hkUnder = under;
  fo.hkOver = over;
  fo.hkWaits = hkWaits;
}

/** 🔒 While a game is not counted because its table is not whole, note the
 *  base its answer names for every house whose delegations this page holds
 *  (FairOnlyState hkUnder). The page reads nothing of that base's session
 *  then, and its first count from it may find an empty map a peer put in the
 *  session's place: a house let go of there for want of a record would leave
 *  its rounds undecided once the records are back. An answer is no count, so
 *  this adds and takes nothing away: should that base be gone again before the
 *  page counts from it (a checkpoint that comes while a book of the table's
 *  chips is away, deleted in the write that brings the book back), the game is
 *  at a base the houses were kept for before, and they are kept still. On a
 *  doc that holds part of an update too: a table is as little counted there,
 *  and noting a base judges nothing of what such a doc holds. */
function noteHousesParked(fo: FairOnlyState): void {
  if (!fo.res) return;
  const base = fo.res.base?.key ?? null;
  for (const [key, was] of fo.hkUnder) if (!was.includes(base)) fo.hkUnder.set(key, [...was, base]);
}

/** Resolve FAIR ONLY game `c` from the records it has now (design §8.3): the
 *  doc's, and the checkpoint this page counted last as if the doc held it still
 *  (S4), so that one deleted from the doc, or an older one put in its place,
 *  can't take the table back; and the one it last counted from under an answer
 *  that waited for no check, when a count that waited has named another since
 *  (FairOnlyState heldWhole). The fold asks the answer for its houses, and asks
 *  again for as long as it was made without a check that waited (pending). */
function resolveFairOnly(c: ComputedInc): void {
  const fo = c.fo!;
  let cks = fo.cks;
  if (fo.held) {
    cks = new Map(fo.cks).set(fo.held.key, fo.held.value);
    if (fo.heldWhole) cks.set(fo.heldWhole.key, fo.heldWhole.value);
  }
  // (What the page holds stands in for what the doc has lost of it: a held
  // transfer at its key, whatever the key holds now; a held end order beside
  // the doc's; a held delegation beside the room's.)
  let xfs = fo.xfs;
  for (const [key, value] of fo.heldXfs) {
    // (The key names the record: one the doc holds there whole is the same one.)
    if (fo.xfs.get(key) === value || !inertFairOnly('xf', key, fo.xfs.get(key))) continue;
    if (xfs === fo.xfs) xfs = new Map(fo.xfs);
    xfs.set(key, value);
  }
  const lostHks: unknown[] = [];
  for (const [key, list] of fo.heldHks) for (const h of list) if (hkRaw.get(key) !== h.value) lostHks.push(h.value);
  fo.res = resolveGame(
    { room: boundRoomId, sig: authCheck, liveSid: c.sid === '' ? undefined : c.sid, read: readCkMemo },
    c.t, c.inc, {
      cks, xfs, fin: fo.fin,
      ...(fo.heldFin !== undefined && fo.heldFin !== fo.fin ? { fins: [fo.heldFin] } : {}),
      delegations: lostHks.length > 0 ? [...hkFeedOf(), ...lostHks] : hkFeedOf(),
    },
  );
  keepStanding(fo, xfs);
  foCheck.add(c);
  let live = foLive.get(c.t);
  if (fo.res.live) {
    if (!live) foLive.set(c.t, live = new Map());
    live.set(c.inc, fo.res);
  } else live?.delete(c.inc);
  // (The fold asks about every house record again: the keys it counts are found anew.)
  fo.houseUsed.clear();
  c.fold.houseChanged();
}

/** Resolve again every FAIR ONLY game whose records, or the room's delegations,
 *  changed, or whose answer waited for a check (staleGames): before anything
 *  counts, since what counts (and whether a table is lost: incLost) goes by the
 *  answer. The games it did are `dirty`, and so are the page-signed incarnations
 *  of a table whose game opened or ended (notePlayedGames). */
function refreshFairOnly(dirty?: Set<ComputedInc>): void {
  for (const c of staleGames) {
    staleGames.delete(c);
    resolveFairOnly(c);
    dirty?.add(c);
    foLook.add(c.t);
  }
  notePlayedGames(dirty);
}

/** Look at the game each table with a FAIR ONLY game plays now (computedIncOf:
 *  S9) after anything that may move it: tell the table's view when it moved,
 *  keep that it went from one FAIR ONLY game to another, for the ⚙ card
 *  (computedGameMovedOf), and count its moves to or from a live one, for the
 *  page-signed duties that wait meanwhile (computedGameMovesOf). A game opening
 *  or ending also puts the table's page-signed incarnations in `dirty`, to be
 *  counted again: a name of the table's other game holds their felts only beside
 *  a live game of their own game (switchHoldsFelts), so a game of the other letter
 *  opening or ending beside the game played does too (foLivesOf), though it moves
 *  neither the view nor the count of moves. Only the tables that may have moved (foLook:
 *  a game of theirs resolved again, or their switch changed), or all of them when
 *  the deed holder did (foLookAll): S9 reads the table's games, the deed holder's
 *  key and the switch, and nothing else. The first look at a table (a new
 *  binding, or its first FAIR ONLY game) moves neither the view nor the count of
 *  moves: the view is painted from what is there; the page-signed incarnations
 *  are counted again all the same. A FAIR ONLY name that is not live is no game
 *  played (the switch's hint, where nothing is open), so a game that ended and
 *  then another that opened is an opening, not a move between them. */
function notePlayedGames(dirty?: Set<ComputedInc>): void {
  if (foGames === 0) return;
  const tables = foLookAll ? [...foTables] : [...foLook];
  foLookAll = false;
  foLook = new Set();
  for (const t of tables) {
    const played = computedIncOf(t);
    const now = played !== null && isFairOnlyInc(played) && !fairOnlyLive(t, played) ? null : played;
    const was = foPlayed.get(t);
    foPlayed.set(t, now);
    // (🔒 The table's games are counted again when the one it plays is another:
    // the switch and the table are put back for that one alone, so what the doc
    // lacks of each goes by it: noteFairOnlyLacks.)
    if (was !== now && dirty) for (const inc of computedIncsOf.get(t) ?? []) {
      const c = computedIncs.get(`${t}:${inc}`);
      if (c?.fo) dirty.add(c);
    }
    const lives = (liveGameOf(t, 'roulette') ? 1 : 0) | (liveGameOf(t, 'craps') ? 2 : 0);
    const livesMoved = lives !== (foLivesOf.get(t) ?? 0);
    if (lives === 0) foLivesOf.delete(t);
    else foLivesOf.set(t, lives);
    if (was === now && !livesMoved) continue;
    const from = was !== undefined && was !== null && isFairOnlyInc(was);
    const to = now !== null && isFairOnlyInc(now);
    // (A game opening or ending, the table's first included, moves what the table's
    // page-signed incarnations wait under: a name of the other game holds their
    // felts only beside a live game of their own game. So does a game of the other
    // letter opening or ending beside the game played, which moves no view and
    // counts no move.)
    if ((from || to || livesMoved) && dirty) for (const inc of computedIncsOf.get(t) ?? []) {
      const c = computedIncs.get(`${t}:${inc}`);
      if (c && !c.fo) dirty.add(c);
    }
    if (was === now || was === undefined) continue; // (the first look at a table touches no view and counts no move)
    viewTouched.add(`computed:${t}`);
    if (from || to) foMoves.set(t, (foMoves.get(t) ?? 0) + 1);
    if (from && to) foMoved.set(t, { from: was!, to: now! });
  }
}

/** 🔒 Where S9's choice of table `tableId`'s game moved from one FAIR ONLY game to
 *  another during this visit (the deed holder changed, a switch named another,
 *  the game it played ended): the ⚙ card's 🚩 THE TABLE'S GAME MOVED TO THE HOUSE
 *  OF <name> (PR 6c-4c). Null for none. Read-only. */
export function computedGameMovedOf(tableId: string): { from: string; to: string } | null {
  const moved = foMoved.get(tableId);
  return moved ? { ...moved } : null;
}

/** 🔒 How many times table `tableId`'s game moved to or from a live FAIR ONLY one
 *  since this page bound the doc (a game opened at it, ended, or S9's choice went from
 *  one to another), 0 for none. No duty of the table's page-signed incarnation runs
 *  while a game is played, so a page that serves it again goes by this to know a game
 *  was played since it last did, a frame having looked at the table meanwhile or not
 *  (computedTable tableOf). The first look at a table moves nothing, so a page bound
 *  while a game is played counts its end. Read-only. */
export function computedGameMovesOf(tableId: string): number {
  return foMoves.get(tableId) ?? 0;
}

/** countComputed of a FAIR ONLY game (its table is whole): the fold follows the
 *  base the resolution names, its nets go into the ledger, and its felts hold
 *  while the game is live.
 *
 *  Whoever opened the game, it counts: its name binds its opener's key, and a
 *  page has no verified owner to admit an opener against until the ownership
 *  root (TODO; design §2.2, owner question 13). So a game a guest opens with
 *  its own key counts as the owner's does, as a chip record a guest writes does
 *  (the ledger is unsigned); `holder` says whose it is. Nothing writes a game
 *  yet, and a signed ledger must count only games opened by the verified owner. */
function countFairOnly(c: ComputedInc, map: Y.Map<unknown>, whole: boolean, keys?: Set<string>): void {
  const fo = c.fo!;
  const resolved = fo.res!;
  if (whole || c.stale || (resolved.base?.ck ?? null) !== fo.folded) readComputedWhole(c, map);
  else if (keys) applyComputed(c, keys);
  computedParked.delete(c.key);
  c.stale = false;
  const res = c.fold.result();
  const live = resolved.live;
  recountComputed(chipIndex, c.key, res.nets);
  recountComputedHeld(c.key, live ? res.held : NO_COMPUTED_HELD);
  if (res !== c.last || live !== c.liveHeld) viewTouched.add(`computed:${c.t}`);
  c.last = res;
  c.liveHeld = live;
  c.countedSid = c.live ? c.sid : null;
  // (The houses a close of the open round would name the commitment of: the
  // beats a page hears for the game, houseHeardFrom. None while it is not live. A
  // delegation put off leaves the committing house unknown for now: the slice that
  // checks it counts the game again, committingWaits.)
  let waits = false;
  fo.committing = live ? committingHouse(res, baseHouseOf(resolved), houseOfOpen(resolved, res, () => { waits = true; })) : undefined;
  fo.committingWaits = waits;
  setGameHouses(fo, live ? commitHouses(res, fo.committing) : []);
  // (A house whose answer was put off, or a base not told yet, is no house let go.)
  keepHouses(c, res.pending || resolved.pending);
  // What the page counted from is what it goes on from if the doc loses it
  // (and none named: the table is not open, but the page keeps what it held).
  // An answer that waits for a check takes the place of none that did not:
  // the base that one named is held beside its own (FairOnlyState heldWhole).
  // And what the page held of transfers and end order for the base before is
  // let go of here, with it, and nowhere else (settleStanding).
  if (resolved.base !== null) {
    fo.held = { key: resolved.base.key, value: resolved.base.ck };
    if (!resolved.pending) {
      fo.heldWhole = fo.held;
      settleStanding(fo);
    }
  }
  noteFairOnlyLacks(c, map);
}

/** 🔒 Tell whether the doc lacks something of game `c` now (FairOnlyState
 *  lacking), and count a put-back when what it lacked is all there again
 *  (returns). Every change of a record a game stands on counts the game
 *  again, so no put-back goes by unseen, whichever page made it and however
 *  soon it was deleted: after each count (countFairOnly), and when the game is
 *  not counted because its table is not whole (countComputed: its live
 *  session's map is gone, say, which a peer that deletes the base can delete
 *  as well; the put-backs made meanwhile are counted as any others, or the
 *  pages would never stand down from them). Not on a doc that holds part of an
 *  update: a trim's delete of the checkpoint it replaces is applied before the
 *  write of the next, and a base that reads as gone between the two has not
 *  come back when the write lands. A game found lacking is one the put-back
 *  duty looks at (a count that was no resolution finds one too: what stood
 *  under a held delegation's key, checked by a slice). What the doc lacks of
 *  the game its table plays is also the table's switch, off the game
 *  (fairOnlySwitchOff), and the table, out of the room's layout
 *  (fairOnlyTableOut): the game is counted again when the switch or the
 *  layout's record of the table changes (countTransaction) and when the table
 *  plays another game (notePlayedGames), so one of them coming back is a
 *  put-back counted as a record's is. */
function noteFairOnlyLacks(c: ComputedInc, map: Y.Map<unknown>): void {
  const fo = c.fo!;
  const lacking = fairOnlyLacks(c, map).length > 0 || fairOnlySwitchOff(c) || fairOnlyTableOut(c);
  if (fo.lacking && !lacking) fo.returns += 1;
  fo.lacking = lacking;
  if (lacking) foCheck.add(c);
}

/** 🔒 What this page's resolution says of FAIR ONLY game `inc` of table
 *  `tableId` (who holds it, which checkpoint stands, whether it is live, what
 *  is still to be checked), or null for a game this page doesn't track.
 *  Read-only. */
export function computedResolutionOf(tableId: string, inc: string): Resolution | null {
  return computedIncs.get(`${tableId}:${inc}`)?.fo?.res ?? null;
}

/** Track every computed incarnation the doc holds, count each, and recount
 *  before any observer runs whenever a transaction touches one: a listener
 *  of a casino key changed in the same transaction reads the new chips, and
 *  a decided round's stake moves from held to paid in one recount. */
function bindComputed(doc: Y.Doc, casino: Y.Map<unknown>): void {
  const map = doc.getMap<unknown>('casinoComputed');
  computedMap = map;
  layoutMap = doc.getMap<unknown>('furniture');
  tableSeen = new Map();
  tableMoves = new Map();
  computedIncs = new Map();
  computedIncsOf = new Map();
  newlyTracked = [];
  computedHeld = new Map();
  computedHeldBy = new Map();
  computedParked.clear();
  computedVerdicts = new Map();
  computedKeysMoved = false;
  verifyQueued = false;
  verifySpent = 0;
  fastSpent = 0;
  fastInFlight = new Set();
  fastToNoble = new Set();
  throwSeen = new Map();
  housePinned = new Map();
  houseDelegations = new Map();
  houseVerdicts = new Map();
  hkRaw = new Map();
  hkFeed = null;
  authVerdicts = new Map();
  staleGames = new Set();
  foCheck = new Set();
  foGames = 0;
  foPlayed = new Map();
  foMoved = new Map();
  foLivesOf = new Map();
  foMoves = new Map();
  foTables = new Set();
  foLook = new Set();
  foLookAll = false;
  foLive = new Map();
  roomWaiting = new Set();
  houseBeats = new Map();
  gameHouseRefs = new Map();
  fairSeen = new Map();
  houseSumSeen = new Map();
  houseSumBackoff = new Map();
  houseDeedKey = deedHolderKey();
  deedChangedSeen = false;
  for (const key of map.keys()) {
    const at = computedKeyParts(key);
    if (at) trackComputed(at.t, at.inc);
    const fk = fairOnlyKeyParts(key);
    if (fk) noteFairOnlyRecord(trackComputed(fk.t, fk.inc), fk.kind, key, map);
    const house = houseKeyParts(key);
    if (house?.kind === 'hkey') {
      const value = map.get(key);
      if (fedDelegation(key, value)) hkRaw.set(key, value);
      houseOkOf(house.of);
    } else if (house?.kind === 'hfair') noteFairSetting(house.of);
    else {
      const hs = houseSumKeyParts(key);
      if (hs) noteHouseSum(hs.t, hs.inc);
    }
  }
  refreshFairOnly();
  for (const c of computedIncs.values()) countComputed(c, map, casino, true);
  // (🔒 What each page-signed incarnation takes as the doc holds it: a turn is read
  // against this, so one that ends after the bind is a turn, and not a first read.)
  for (const c of computedIncs.values()) c.takesPlace = !c.fo && !computedIncEnded(c.t, c.inc);
  newlyTracked = [];
  // (bindCasinoDoc's own notify repaints every listener from the fresh doc.)
  chipsTouched.clear();
  heldTouched.clear();
  computedTouched.clear();
  viewTouched.clear();
  doc.on('beforeObserverCalls', (tr: Y.Transaction) => {
    if (computedMap !== map) return; // a binding we've moved off
    onComputedTransaction(tr, map, casino);
  });
}

/** Count what a transaction changed of the computed tables, every arrival
 *  it brought stamped with one time (txNow). */
function onComputedTransaction(tr: Y.Transaction, map: Y.Map<unknown>, casino: Y.Map<unknown>): void {
  txNow = Date.now();
  try {
    countTransaction(tr, map, casino);
  } finally {
    txNow = null;
  }
}

function countTransaction(tr: Y.Transaction, map: Y.Map<unknown>, casino: Y.Map<unknown>): void {
  verifySpent = 0;
  fastSpent = 0;
  const dirty = new Set<ComputedInc>();
  const whole = new Set<ComputedInc>();
  const changed = new Map<ComputedInc, Set<string>>();
  // A session or checkpoint key moved (one added, replaced or deleted): its
  // incarnation is read whole.
  const top = tr.changed.get(map as unknown as Y.AbstractType<Y.YEvent<any>>);
  let houseMoved = false;
  // 🏠 The room records whose checks waited first, then what came: each
  // delegation that came is checked alone (a flood of them is checked in
  // slices, and never read again whole), and a house pinned now has every
  // fold ask its HouseCheck again, and its beat read.
  const pinned = roomWaiting.size > 0 ? recheckRoomRecords() : [];
  if (top) {
    for (const key of top) {
      const house = key === null ? null : houseKeyParts(key);
      if (house?.kind === 'hkey') {
        noteDelegation(key!, map);
        if (!pinnedHouse(house.of) && houseOkOf(house.of) === true) pinned.push(house.of);
      } else if (house?.kind === 'hbeat') noteBeat(house.of);
      else if (house?.kind === 'hfair') noteFairSetting(house.of);
      else if (key !== null) {
        const hs = houseSumKeyParts(key);
        if (hs) noteHouseSum(hs.t, hs.inc);
      }
      // 🔒 A record of a FAIR ONLY game: the game is read again (its base may
      // be another's), and counted.
      const fk = key === null ? null : fairOnlyKeyParts(key);
      if (fk) {
        const c = computedIncs.get(`${fk.t}:${fk.inc}`) ?? (map.has(key!) ? trackComputed(fk.t, fk.inc) : undefined);
        if (c) noteFairOnlyRecord(c, fk.kind, key!, map);
        continue;
      }
      const at = key === null ? null : computedKeyParts(key);
      if (!at) continue;
      let c = computedIncs.get(`${at.t}:${at.inc}`);
      if (!c && map.has(key!)) c = trackComputed(at.t, at.inc);
      if (!c) continue;
      whole.add(c);
      dirty.add(c);
      // (🔒 A game's session gone is the put-back duty's to open again, and each
      // time the map of one of its sessions comes or goes is told: sesMoves. Of
      // any of them, not only of the one its base opens now: while a check is
      // waited for the game names no base, and a map that came and went then
      // is a disappearance all the same.)
      if (c.fo) {
        foCheck.add(c);
        c.fo.sesMoves += 1;
      }
    }
  }
  // A key pinned in this transaction counts for its player's felt in it.
  const players = playersMap ? tr.changed.get(playersMap as unknown as Y.AbstractType<Y.YEvent<any>>) : undefined;
  if (players && pinPlayer) for (const pid of players) if (pid !== null) pinPlayer(pid, playersMap!.get(pid));
  // 🏠 The houses may read otherwise: a delegation came or changed, or the
  // deed holder's key did (the room names another owner, or the owner's key
  // showed up). Not as the owner's player entry is merely written again: a
  // key is pinned once, and every delegation and Fair setting read again
  // each time would ask again for checks the verdict cache let go (a flood
  // of forged ones past its 2,048).
  const deedKey = deedHolderKey();
  if (deedKey !== houseDeedKey) {
    // B1: an established holder's key giving way (to another's or to none) is
    // a handover; the owner's key merely arriving (undefined/null → a key) is
    // not. Once seen, it stays for the visit (the ⚙ card names it).
    if (typeof houseDeedKey === 'string') deedChangedSeen = true;
    houseDeedKey = deedKey;
    houseMoved = true;
    // (🔒 S9 plays the deed holder's game: every table with one is looked at.)
    if (foGames > 0) foLookAll = true;
  }
  if (houseMoved) {
    houseChangedAll(dirty);
    if (top) for (const key of top) if (key !== null && key.startsWith('hb:')) noteBeat(key.slice(3));
  } else if (pinned.length > 0) {
    for (const c of computedIncs.values()) {
      c.fold.houseChanged();
      dirty.add(c);
    }
  }
  // (A beat that came before its house was pinned: read now.)
  for (const pub of pinned) noteBeat(pub);
  // 🔒 The room's layout: the table of a FAIR ONLY game placed, moved, taken out
  // or put back. Its games are counted again (what the doc lacks of the one the
  // table plays goes by it: noteFairOnlyLacks).
  const laid = layoutMap ? tr.changed.get(layoutMap as unknown as Y.AbstractType<Y.YEvent<any>>) : undefined;
  if (laid) {
    for (const t of laid) {
      if (t === null || !foTables.has(t)) continue;
      tableMoves.set(t, (tableMoves.get(t) ?? 0) + 1);
      noteTableRecord(t);
      for (const inc of computedIncsOf.get(t) ?? []) {
        const c = computedIncs.get(`${t}:${inc}`)!;
        if (c.fo) dirty.add(c);
      }
    }
  }
  if (computedIncs.size === 0) return;
  if (computedKeysMoved) {
    computedKeysMoved = false;
    for (const c of computedIncs.values()) dirty.add(c);
  }
  // Records written into an incarnation's live session: only those keys.
  // (Another session map of it counts nothing.) And junk growing inside a
  // Y type stored in the live session, at any depth: the key it is stored
  // under there weighs more (rawBytes), and only a read of that key again
  // sees it, the session's own keys being as they were.
  for (const [type, keys] of tr.changed) {
    // Up from the changed type to the session map it is, or is stored in.
    let session: Y.AbstractType<any> = type;
    let inner: Y.AbstractType<any> | null = null;
    while (session._item && session._item.parent !== map && session._item.parent instanceof Y.AbstractType) {
      inner = session;
      session = session._item.parent;
    }
    const item = session._item;
    if (!item || item.parent !== map || typeof item.parentSub !== 'string') continue;
    const at = computedKeyParts(item.parentSub);
    const c = at ? computedIncs.get(`${at.t}:${at.inc}`) : undefined;
    if (!c || whole.has(c) || c.live !== (session as unknown as Y.Map<unknown>)) continue;
    let ks = changed.get(c);
    if (!ks) changed.set(c, ks = new Set());
    if (inner === null) {
      for (const key of keys) if (key !== null) ks.add(key);
    } else if (typeof inner._item?.parentSub === 'string') {
      ks.add(inner._item.parentSub);
    }
    dirty.add(c);
  }
  // A switch, or a removal: whether the felts hold.
  const switched = tr.changed.get(casino as unknown as Y.AbstractType<Y.YEvent<any>>);
  if (switched) {
    for (const key of switched) {
      if (key === null) continue;
      if (key.startsWith('cfg:computed:')) {
        const t = key.slice('cfg:computed:'.length);
        for (const inc of computedIncsOf.get(t) ?? []) dirty.add(computedIncs.get(`${t}:${inc}`)!);
        // (🔒 The switch is S9's hint: the table's game may be another now.)
        if (foTables.has(t)) foLook.add(t);
      } else if (key.startsWith('gone:')) {
        const c = computedIncs.get(key.slice('gone:'.length));
        if (c) dirty.add(c);
      } else if (key.startsWith('throw:')) {
        stampThrow(casino, key.slice('throw:'.length));
      }
    }
  }
  // A slice: what waited for its checks. (A FAIR ONLY game's resolution that
  // waited is made again, and a game whose committing house waited for a
  // delegation's check, or what stands under a held delegation's key for its
  // own, is counted again.)
  if (tr.origin === CT_VERIFY) {
    for (const c of computedIncs.values()) {
      if (c.last?.pending || c.fo?.committingWaits || c.fo?.hkWaits) dirty.add(c);
      if (c.fo?.res?.pending) staleGames.add(c);
    }
  }
  // A recount asked for (giveUpComputed): read whole.
  if (tr.origin === CT_RECOUNT) {
    for (const c of recountWhole) {
      whole.add(c);
      dirty.add(c);
    }
    recountWhole.clear();
  }
  // (🔒 An incarnation the switch names that a name in the switch takes the
  // table's others' places for now and did not when this page last looked (or
  // the reverse): it is counted for the first time (a session or a checkpoint of
  // it having come, or an owner-signed `hs:` that registers it) after the switch
  // that names it, or it is no longer ended (its `gone:` mark deleted, its end
  // checkpoint written over by one that does not end it), or it is now (a mark
  // written, an end checkpoint). The table's others count again then: one the
  // switch has left for it is told so (`leftFor`), which a FAIR ONLY name that
  // comes next must find set, and one that waits under a name of the other game
  // holds or lets go of its stakes (otherGameStands). Only then: the switch
  // naming another is a count of its own, and a flood of made-up names counts
  // nothing again.)
  for (const y of new Set([...newlyTracked, ...dirty])) {
    if (y.fo) continue;
    const takes = !computedIncEnded(y.t, y.inc);
    if (takes === y.takesPlace) continue;
    y.takesPlace = takes;
    if (computedCfgInc(casino.get(`cfg:computed:${y.t}`)) !== y.inc) continue;
    // (And the table's FAIR ONLY games: the switch is theirs to put back or not
    // by whether the incarnation it names stands, fairOnlySwitchFree.)
    for (const inc of computedIncsOf.get(y.t) ?? []) {
      const sibling = computedIncs.get(`${y.t}:${inc}`);
      if (sibling && sibling !== y) dirty.add(sibling);
    }
  }
  newlyTracked = [];
  // 🔒 The FAIR ONLY games whose records changed are resolved before any is
  // counted: what counts, and whether a table is lost (casinoWhole), goes by
  // the answer.
  refreshFairOnly(dirty);
  for (const c of dirty) countComputed(c, map, casino, whole.has(c), changed.get(c));
  // The rest of an update came: what waited reads as it is.
  if (computedParked.size > 0 && casinoWhole()) {
    for (const key of [...computedParked]) {
      const c = computedIncs.get(key)!;
      if (!dirty.has(c)) countComputed(c, map, casino, true);
    }
  }
}

/** False while a computed table (table `tableId`'s, when named) waits: for
 *  the rest of an update, or for the doc to hold what it counted (parked),
 *  or for its records' signatures to be checked (its result pending: a slip
 *  not checked yet holds nothing so far; 🔒 a FAIR ONLY game's too, whose
 *  resolution may wait for a checkpoint's or a transfer's). Nothing is spent meanwhile
 *  (spendableChips). Asked of every table, one frozen for good doesn't
 *  count: on a doc holding every update whole, a table missing something
 *  this page counted of it (tableLost) waits for nothing that will come.
 *  Its last counts stand, and it stops only itself, as a table whose book
 *  is lost does, or any peer could stop every spend in the casino by
 *  making a session map and deleting it. (Except for a FAIR ONLY game's
 *  resolution waiting for a check: that will be made.) */
export function computedSettled(tableId?: string): boolean {
  const settled = (key: string): boolean => {
    const c = computedIncs.get(key);
    return !computedParked.has(key) && c?.last?.pending !== true && c?.fo?.res?.pending !== true;
  };
  if (tableId !== undefined) return [...(computedIncsOf.get(tableId) ?? [])].every((inc) => settled(`${tableId}:${inc}`));
  const whole = !docHoldsPart();
  for (const c of computedIncs.values()) {
    if (settled(c.key)) continue;
    // 🔒 A FAIR ONLY game whose resolution waits for a check is not frozen for
    // good, whatever became of the session this page counted: the check will
    // be made, and the checkpoint it waits for (a trim deletes that very
    // session as it writes it) may take what the table was counted to hold.
    // Nothing is spent until it is.
    if (whole && tableLost(c.t) && c.fo?.res?.pending !== true) continue;
    return false;
  }
  return true;
}

/** The fold of table `tableId`'s switched-on incarnation as last counted
 *  (null for none, or one parked before it was ever counted). Read-only.
 *  🔒 Of incarnation `inc` when one is given: the duties of a page's state of
 *  a game read the game's own fold, which is not the table's when the table
 *  has moved to another (computedTable). */
export function computedFoldOf(tableId: string, inc: string | null = computedIncOf(tableId)): FoldResult | null {
  return inc === null ? null : computedIncs.get(`${tableId}:${inc}`)?.last ?? null;
}

/** 🔁 The round-u view (§6.2 C) of table `tableId`'s switched-on incarnation
 *  (or of `inc`): the candidate decisions for round u (the base's) that
 *  reproduce the counted checkpoint's nets and craps carry, in the fold's
 *  order — the page shows the first in place of its own when it differs (the
 *  L7 fix). Empty with no prior evidence (a new page, or a split). Read-only;
 *  no count or spend reads it. */
export function computedRedecide(tableId: string, inc: string | null = computedIncOf(tableId)): RedecideCandidate[] {
  const c = inc === null ? null : computedIncs.get(`${tableId}:${inc}`);
  return c ? c.fold.redecide() : [];
}

/** When this page first saw record `key` in the live session of table
 *  `tableId`'s switched-on incarnation (or of `inc`; its own Date.now(), raw: a
 *  duty clamps it to its own clock), or undefined. */
export function computedSeenAt(tableId: string, key: string, inc: string | null = computedIncOf(tableId)): number | undefined {
  return inc === null ? undefined : computedIncs.get(`${tableId}:${inc}`)?.seen.get(key);
}

/** The live session map of a computed table (its switched-on incarnation, or
 *  `inc`) to write records into, read afresh on every call (a trim replaces it,
 *  and a write through an old one vanishes), or null when the table isn't
 *  computed or has none. */
export function computedSessionForWrite(tableId: string, inc: string | null = computedIncOf(tableId)): Y.Map<unknown> | null {
  if (inc === null || !isComputedInc(tableId, inc)) return null;
  const map = computedMap!;
  // (🔒 A FAIR ONLY game's session is the one the base its resolution names
  // opens, which a table that is computed has.)
  const c = computedIncs.get(`${tableId}:${inc}`);
  const base = c?.fo?.res?.base?.ck ?? null;
  const sid = c?.fo ? (base === null ? null : sid3Of(c, base)) : nextSid({ room: boundRoomId, t: tableId, inc }, baseOf(tableId, inc));
  if (sid === null) return null;
  const live = map.get(sessionKey(tableId, inc, sid));
  return live instanceof Y.Map ? (live as Y.Map<unknown>) : null;
}

/** Tell listeners a computed table's view moved with no transaction behind
 *  it (a phase its clock ran out), as `computed:<tableId>`. */
export function notifyCasinoView(tableId: string): void {
  notify(new Set([`computed:${tableId}`]));
}

/** Every session map the doc holds of incarnation `inc` of table `tableId`
 *  (the live one, and any a rival trim left: two sides of a split each open
 *  their own), by key. Parsed, so another table whose id runs on past this
 *  one's (`<tableId>:<inc>…`) keeps its own. */
function sessionKeysOf(map: Y.Map<unknown>, tableId: string, inc: string): string[] {
  const out: string[] = [];
  for (const key of map.keys()) {
    const at = computedKeyParts(key);
    if (at && at.sid !== undefined && at.t === tableId && at.inc === inc) out.push(key);
  }
  return out;
}

/**
 * 🧹 Trim computed table `tableId`'s live session to checkpoint `cp`, in ONE
 * transaction: `cp` becomes the incarnation's checkpoint, every session map
 * of it goes (deleting the whole map is what frees the doc's space; deleting
 * its keys one by one leaves most of it), and the session `cp` opens
 * (nextSid) is created holding `copies`, byte for byte under their keys (the
 * open round's felts: they hold as they did). On a page whose fold agreed,
 * the recount reads the checkpoint's nets for the rounds it took away and
 * the copies' stakes for what they held: no balance moves, and listeners are
 * told once (the view moved). A write into the old session at the same
 * moment, through any reference to it, vanishes everywhere; its author puts
 * it back (computedTable's re-put).
 *
 * Refused (false) unless `inc` is the table's live incarnation, the doc holds
 * the table whole, and `cp` is a checkpoint (not an end: finalizeComputed)
 * closing the session live now: a caller holding a fold from before another
 * page's trim reached it trims nothing.
 */
export function writeCheckpointAndTrim(
  tableId: string, inc: string, cp: Checkpoint, copies: readonly (readonly [key: string, value: unknown])[],
): boolean {
  ensureMap();
  const map = computedMap!;
  if (!ordinaryInc(tableId, inc) || !isComputedTable(tableId) || computedIncOf(tableId) !== inc || !casinoWhole(tableId)) return false;
  const ok = asCheckpointFor({ inc })(cp);
  const ctx: FoldCtx = { room: boundRoomId, t: tableId, inc };
  if (!ok || ok.e === 1 || ok.b !== nextSid(ctx, baseOf(tableId, inc))) return false;
  const next = nextSid(ctx, ok);
  boundDoc!.transact(() => {
    map.set(`sum:${tableId}:${inc}`, cp);
    for (const key of sessionKeysOf(map, tableId, inc)) map.delete(key);
    const ses = new Y.Map<unknown>();
    map.set(sessionKey(tableId, inc, next), ses);
    for (const [key, value] of copies) ses.set(key, value);
  });
  return true;
}

/**
 * 🧹 Finalise incarnation `inc` of computed table `tableId`, in ONE
 * transaction: its final checkpoint `cp` (`e: 1`, the fold's nets: they go
 * on counting, as a removed table's book does), every session map of it
 * gone, and `gone:<tableId>:<inc>` marked if it isn't. A session map anyone
 * writes after that counts nothing (an ended checkpoint's session is junk to
 * the fold). `cp` null keeps the checkpoint already there, which must say the
 * incarnation ended (a stray session after the end: only the maps go).
 *
 * Refused (false) unless the doc holds the table whole, this page tracks the
 * incarnation, and `cp` ends the session live now. The caller decides when:
 * an ended incarnation (computedEndedIncs) is compacted by the room's pages
 * in turn; a switch-off ends a live one (and deletes the switch).
 */
export function finalizeComputed(tableId: string, inc: string, cp: Checkpoint | null): boolean {
  const casino = ensureMap();
  const map = computedMap!;
  const c = ordinaryInc(tableId, inc);
  if (!c || !casinoWhole(tableId)) return false;
  const was = heldBase(c, map);
  if (cp !== null) {
    const ok = asCheckpointFor({ inc })(cp);
    if (!ok || ok.e !== 1 || ok.b !== liveSidOf(c, was)) return false;
  } else if (was?.e !== 1) {
    return false;
  }
  boundDoc!.transact(() => {
    if (cp !== null) map.set(`sum:${tableId}:${inc}`, cp);
    for (const key of sessionKeysOf(map, tableId, inc)) map.delete(key);
    if (!casino.has(goneKey(tableId, inc))) casino.set(goneKey(tableId, inc), 1);
  });
  return true;
}

// ── 🩹 Recovery: what a peer deleted or rewound, put back ───────────────────

/** One computed incarnation as the recovery duty reads it (computedTable
 *  recoverDuty). */
export interface ComputedRecovery {
  t: string;
  inc: string;
  ctx: FoldCtx;
  /** What puts its checkpoint's restore in motion now (null: nothing), and
   *  how many counts found nothing that did (ComputedInc calm): a change of
   *  it starts a restore's wait afresh. */
  trigger: RecoveryTrigger | null;
  calm: number;
  /** The value a restore writes (restoreTargetOf): this page's head as the
   *  doc held it, or 🏛️ the owner-signed checkpoint when that is the higher
   *  by round (or the trigger is an end turned live); its round. Null with
   *  neither. */
  head: object | null;
  headU: number;
  /** Live: its switch names it and nothing ended it. */
  live: boolean;
  /** The session the base this page counts from opens has no map in the
   *  doc (the recovery duty opens one), and whether that is a session this
   *  page counted from (computedLost: given up past GIVE_UP_MS). */
  sessionMissing: boolean;
  lost: boolean;
  /** The base's round (0 for none). */
  u: number;
  /** The keys that take turns at it: every staked felt's this page counted
   *  in the session its head opens (Counted pubs) and the head's; 🏛️ the
   *  owner-signed checkpoint's checker when it takes part; and, unless the
   *  doc's checkpoint puts a restore in motion, the base's and its open
   *  felts' signers as last counted (a forger, and the felts of the session
   *  a forged checkpoint opens, take no turn). */
  pubs: string[];
}

/** Every incarnation this page tracks, as the recovery duty reads it. */
export function computedRecoveries(): ComputedRecovery[] {
  const map = computedMap;
  const casino = casinoMap;
  if (!map || !casino) return [];
  const out: ComputedRecovery[] = [];
  for (const c of computedIncs.values()) {
    if (c.fo) continue;
    const base = heldBase(c, map);
    const doc = checkpointAt(map, c.t, c.inc);
    const head = c.chain[c.chain.length - 1];
    const sid = liveSidOf(c, base);
    const pubs = new Set<string>();
    for (const k of head?.pubs ?? []) pubs.add(k);
    // (A checkpoint that puts a restore in motion gives its signer no turn,
    // nor the felts of the session it opens: the forger wrote those too.)
    const trigger = recoveryOn ? recoveryTrigger(c, doc) : null;
    if (trigger === null) {
      for (const s of c.last?.felts.values() ?? []) if (s.rec.b.length > 0) pubs.add(s.rec.k);
      if (base) pubs.add(base.k);
    }
    if (head) pubs.add(head.cp.k);
    const A = houseSumTakesPart(c);
    if (A) pubs.add(A.k);
    const target = restoreTargetOf(c, trigger);
    out.push({
      t: c.t, inc: c.inc, ctx: c.ctx,
      trigger, calm: c.calm,
      head: target?.value ?? null, headU: target?.u ?? 0,
      live: computedCfgInc(casino.get(`cfg:computed:${c.t}`)) === c.inc && !casino.has(goneKey(c.t, c.inc)) && base?.e !== 1,
      sessionMissing: !(map.get(sessionKey(c.t, c.inc, sid)) instanceof Y.Map),
      lost: sessionLost(c, map, base),
      u: base?.u ?? 0,
      pubs: [...pubs].sort(),
    });
  }
  return out;
}

/** 🩹 Whether table `tableId`'s switched-on incarnation (or incarnation
 *  `inc` of it) counts from a checkpoint that puts its restore in motion: a
 *  live one rewound below this page's head or the owner's checkpoint, jumped
 *  past the head, or 🏛️ live where the owner's checkpoint is an end
 *  (recoveryTrigger 'rewind', 'jump', 'end'). The page counts it as every
 *  build does while the head comes back; nothing builds on it meanwhile (no
 *  trim, no end: computedTable). */
export function computedRestorePending(tableId: string, inc: string | null = switchIncOf(tableId)): boolean {
  const c = inc === null ? undefined : ordinaryInc(tableId, inc);
  if (!c || !computedMap || !recoveryOn) return false;
  const trigger = recoveryTrigger(c, checkpointAt(computedMap, tableId, c.inc));
  return trigger === 'rewind' || trigger === 'jump' || trigger === 'end';
}

/**
 * 🩹 Give way to the rival the room keeps putting back, when this page's head
 * is one it took at LOAD (unseen) and its restore of it keeps losing. The
 * firmAt window (TAKEN_WAIT_MS) converges a load-taken head to the honest one
 * while the page hears the room soon after loading; but a partition that
 * outlasts the window leaves the load-taken head looking firm by the clock,
 * and no longer a timeout can tell a late-arriving honest head from a replay.
 * So, driven by the restore duty once this page's restore of an unseen head
 * has been written over again and again by a rewind or a jump the page can't
 * classify (computedTable restoreStep: the room backs the rival — a lone
 * forger can't keep a value in the doc against the pages that counted the
 * honest head), the page drops the unseen head and what it extends, and takes
 * the doc's value as every build reads it. A SEEN head never gives way (a
 * grounded page defends it against a cheat), and nothing happens unless a
 * rewind or a jump stands now, so an honest trim that moved the head on is
 * untouched. Converges two honest pages that each hold a different head after
 * any partition; the one-honest-page-vs-forger case still needs the house's
 * signed head (PR 6a-2). Returns whether it gave way.
 */
export function giveWayComputed(tableId: string, inc: string): boolean {
  const c = ordinaryInc(tableId, inc);
  if (!c || !computedMap || !recoveryOn) return false;
  const head = c.chain[c.chain.length - 1];
  if (!head || head.seen) return false;
  const cp = checkpointAt(computedMap, c.t, c.inc);
  const trigger = recoveryTrigger(c, cp);
  // 🩹 Give way only to a rewind this page cannot otherwise reject — a lower
  // checkpoint it took at load and can't tell from the honest head coming
  // back. NEVER to a jump: a jump is always a checkpoint over a counted chain
  // entry more than MAX_SESSION_ROUNDS past it, or one on a refuted base — the
  // page has proved it impossible, so it defends its head against it rather
  // than adopting it. Nor to a rewind that is itself on a refuted base or
  // jumps a chain entry. Were the chain dropped for one of these, the recount
  // below would take the impossible value as the new head and the forged
  // balances would stick even when every honest page still holds the head.
  if (trigger !== 'rewind') return false;
  if (cp === null || c.refuted.includes(cp.b) || c.chain.some((e) => jumpsOver(cp, e))) return false;
  // 🏛️ Nor when the owner's checkpoint reaches the head: the restore writes
  // that checkpoint (restoreTargetOf), not the unseen head, and the house's
  // signed head is what the one-honest-page-vs-forger case was waiting for —
  // the page defends it (the backoff, B12, is the only way it stands down).
  const A = houseSumTakesPart(c);
  if (A && A.u >= head.cp.u) return false;
  // Drop every trailing unseen entry (a load-taken head and what extends it,
  // never a seen one along the chain): the page stops defending the line it
  // took at load and adopts the doc's value on the next count.
  let j = c.chain.length;
  while (j > 0 && !c.chain[j - 1].seen) j--;
  if (j >= c.chain.length) return false;
  for (const e of c.chain.slice(j)) drop(c, e.sid);
  c.chain.length = j;
  // 🩹 Recount at once (as giveUpComputed does): dropping every trailing
  // unseen entry can empty the chain, leaving no head and so no held base, and
  // a delete of sum: before any other table write would then lose the restored
  // checkpoint's balances. The recount counts the doc's value afresh into the
  // chain, giving the page a head to hold the base from.
  c.countedSid = null;
  recountWhole.add(c);
  boundDoc!.transact(() => {}, CT_RECOUNT);
  return true;
}

/** 🩹 Whether any incarnation this page tracks has recovery work outstanding
 *  — a restore in motion, a session to reopen, or one to give up. World keeps
 *  marking its table frames while this is true (computedTable
 *  computedCompactionPending's caller, the croupier noteTablesRunning), as it
 *  does while the room has a table, so that after the room's last table is
 *  gone and an ended incarnation's checkpoint or session was deleted the page
 *  doesn't read as asleep a lapse on and leave the recovery stuck. Reads the
 *  doc only; the real sleep guard (tablesAwake) still gates the duty. */
export function computedRecoveryPending(): boolean {
  const map = computedMap;
  const casino = casinoMap;
  if (!map || !casino || !recoveryOn) return false;
  for (const c of computedIncs.values()) {
    if (c.fo) continue;
    const base = heldBase(c, map);
    if (recoveryTrigger(c, checkpointAt(map, c.t, c.inc)) !== null) return true;
    const live = computedCfgInc(casino.get(`cfg:computed:${c.t}`)) === c.inc
      && !casino.has(goneKey(c.t, c.inc)) && base?.e !== 1;
    if (live && !(map.get(sessionKey(c.t, c.inc, liveSidOf(c, base))) instanceof Y.Map)) return true;
    if (sessionLost(c, map, base)) return true;
  }
  return false;
}

/**
 * 🩹 Put back the checkpoint of incarnation `inc` of table `tableId` — this
 * page's head, byte for byte as the doc held it, or 🏛️ the owner-signed one
 * (restoreTargetOf; every page that counted it writes the same bytes, so
 * whichever write the doc keeps is the same checkpoint) — in ONE transaction
 * with an empty map for the session it opens if the doc has none. Only
 * while what the doc holds now still puts the restore in motion
 * (recoveryTrigger: an honest trim that came in meanwhile moved the
 * checkpoint on, and nothing is written), and `head` is still the value that
 * restore writes; on a doc holding every update whole. False (nothing
 * written) otherwise. The only write of a checkpoint besides a trim's and
 * an end's: no page signs one again in place.
 */
export function restoreComputedCheckpoint(tableId: string, inc: string, head: object): boolean {
  const map = computedMap;
  const c = ordinaryInc(tableId, inc);
  if (!map || !c || !recoveryOn || docHoldsPart()) return false;
  const trigger = recoveryTrigger(c, checkpointAt(map, tableId, inc));
  if (trigger === null) return false;
  const target = restoreTargetOf(c, trigger);
  if (!target || target.value !== head) return false;
  boundDoc!.transact(() => {
    map.set(`sum:${tableId}:${inc}`, target.value);
    // (An end opens no session: compaction would only delete it again.)
    const key = sessionKey(tableId, inc, target.sid);
    if (!target.end && !(map.get(key) instanceof Y.Map)) map.set(key, new Y.Map<unknown>());
  });
  return true;
}

/**
 * 🩹 Open again the session incarnation `inc` of table `tableId` counts
 * from, deleted with nothing in its place (no build does that: a trim
 * writes the next one as it deletes the last, an end deletes them all as it
 * ends): one empty map, where the room's pages put their records back
 * (computedTable reputDuty, witnessDuty). Only the session the base this
 * page counts from opens (never a base chosen from what maps the doc
 * holds), of a live incarnation, on a doc holding every update whole, and
 * while its checkpoint puts no restore in motion. False (nothing written)
 * otherwise.
 */
export function reopenComputedSession(tableId: string, inc: string): boolean {
  const map = computedMap;
  const casino = casinoMap;
  const c = ordinaryInc(tableId, inc);
  if (!map || !casino || !c || !recoveryOn || docHoldsPart()) return false;
  const base = heldBase(c, map);
  if (base?.e === 1 || computedCfgInc(casino.get(`cfg:computed:${tableId}`)) !== inc || casino.has(goneKey(tableId, inc))) return false;
  if (recoveryTrigger(c, checkpointAt(map, tableId, inc)) !== null) return false;
  const key = sessionKey(tableId, inc, liveSidOf(c, base));
  if (map.get(key) instanceof Y.Map) return false;
  boundDoc!.transact(() => {
    map.set(key, new Y.Map<unknown>());
  });
  return true;
}

// ── 🔒 What a FAIR ONLY game stands on, put back, and the switch and the table of the game played (design §8.4 P2, P4, P5; PR 6c-4b-2) ──

/** One FAIR ONLY game the doc has lost something of, as the put-back duty reads
 *  it (computedTable fairKeepDuty). */
export interface FairOnlyRecovery {
  t: string;
  inc: string;
  ctx: FoldCtx;
  /** The round of the base this page counts the game from. */
  u: number;
  /** How many of the records this page holds of the game the doc lacks, the
   *  table's switch counted as one when the game is the one the table plays and
   *  the switch names another or none (putBackFairOnlyRecords writes them). */
  missing: number;
  /** The game is the one its table plays, no end order stands, and the table
   *  is out of the room's layout, where this page saw it placed
   *  (putBackFairOnlyTable puts it back, and the switch with it); and how many
   *  times a transaction changed the layout's key of the table since the doc
   *  was bound: the wait for the table is one disappearance's. */
  tableMissing: boolean;
  tableMoves: number;
  /** The game is live and the session its base opens has no map in the doc
   *  (reopenFairOnlySession makes one). */
  sessionMissing: boolean;
  /** The session the game's base opens (null: it has no base, or has ended),
   *  and how many times a transaction changed the key of a session of the game
   *  since the doc was bound (FairOnlyState sesMoves): the wait for its map is
   *  one disappearance's, and one session's. */
  sid: string | null;
  sesMoves: number;
  /** The keys that take turns at it: the signers of the staked felts this page
   *  last counted in the game (none: every page waits as an outsider). */
  pubs: string[];
  /** computedFairOnlyReturns of the game. */
  returns: number;
}

/** What this page holds of game `c` that the doc lacks, as [key, value] to
 *  write: the base it counts from, when its key is empty or holds junk (the key
 *  names the record, so one read whole there is the same one), of a game that
 *  has ended too (its nets stand on its end checkpoint); and, while the game is
 *  live, the transfers it holds (the same test), the end order it holds
 *  when that is the one the answer stands on and the `fin:` key holds anything
 *  else (a resolution takes the doc's order before the held one, so the two
 *  differ only when the doc's is none, junk or a forgery; not while a check
 *  waits, which may be the doc's order's; and not an order the answer does not
 *  stand on: while the page does not count the game it keeps the order it
 *  holds, the doc's may be that order written again or another that stands,
 *  and the page writes its own over neither), and of each house's delegations
 *  the latest holder's, when the `hk:` key holds no
 *  delegation, or one the last count found to be no good delegation of the
 *  house by a holder of the game (keepHouses), or one of an earlier holder's
 *  that this page holds too (written back over the later one, an old record
 *  anyone can write again, it would leave the pages that come later without
 *  the house for the rounds since the hand-over). Nothing while the resolution
 *  names a base other than the one this page last counted from: a base named
 *  while the game is not counted (its table not whole) is one the page does
 *  not hold yet, and the one it holds is the game's no more, or is again only
 *  once the count has gone by it (the base of the last count that waited for
 *  no check, FairOnlyState heldWhole, named again after one that did). */
function fairOnlyLacks(c: ComputedInc, map: Y.Map<unknown>): [string, unknown][] {
  const fo = c.fo!;
  const res = fo.res;
  const back: [string, unknown][] = [];
  if (!res || !res.base || !fo.held || fo.held.key !== res.base.key) return back;
  const cur = map.get(fo.held.key);
  if (cur !== fo.held.value && readCkMemo(fo.held.key, cur).kind !== 'ok') back.push([fo.held.key, fo.held.value]);
  if (!res.live) return back;
  for (const [key, value] of fo.heldXfs) {
    const at = map.get(key);
    if (at !== value && inertFairOnly('xf', key, at)) back.push([key, value]);
  }
  if (fo.heldFin !== undefined && !res.pending && res.fin === fo.heldFin && map.get(finKey(c.t, c.inc)) !== fo.heldFin) back.push([finKey(c.t, c.inc), fo.heldFin]);
  for (const [key, list] of fo.heldHks) {
    const best = list[list.length - 1].value;
    const at = hkRaw.get(key);
    if (at === undefined || fo.hkOver.get(key) === at || (at !== best && list.some((h) => h.value === at))) back.push([key, best]);
  }
  return back;
}

/** 🔒 The game a layout record's table plays, when the value is a casino
 *  table's placement as furnitureDoc reads one (isFurnitureRecord: its kind,
 *  where it stands, how it is turned): 'roulette' for a roulette table, 'craps'
 *  for a craps table. Null for anything else: no record, junk, or furniture of
 *  another kind. */
export function tableRecordGame(value: unknown): GameName | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as { kind?: unknown; x?: unknown; z?: unknown; rot?: unknown; movable?: unknown; mountParent?: unknown };
  const game = r.kind === 'roulette-table' ? 'roulette' : r.kind === 'craps-table' ? 'craps' : null;
  if (game === null || !Number.isFinite(r.x) || !Number.isFinite(r.z)) return null;
  if (r.rot !== 0 && r.rot !== 1 && r.rot !== 2 && r.rot !== 3) return null;
  if (typeof r.movable !== 'boolean' || (r.mountParent !== undefined && typeof r.mountParent !== 'string')) return null;
  return game;
}

/** Keep the placement the layout holds of table `t` now, when it is a casino
 *  table's, as the last one seen of a table of its game (tableSeen): what is
 *  put back. A table moved is held where it stands now; one taken out, or
 *  written over by junk, by other furniture or by a table of the other game,
 *  stays held as it last stood. */
function noteTableRecord(t: string): void {
  const value = layoutMap?.get(t);
  const game = tableRecordGame(value);
  if (game === null) return;
  let seen = tableSeen.get(t);
  if (!seen) tableSeen.set(t, seen = new Map());
  seen.set(game, value);
}

/** Whether game `c` is the one its table plays (S9: computedIncOf), live. */
function fairOnlyPlays(c: ComputedInc): boolean {
  return c.fo!.res?.live === true && computedIncOf(c.t) === c.inc;
}

/** Whether the table of game `c` is out of the room's layout: this page saw a
 *  table of the game's kind placed under its id, and the layout holds none
 *  there now (no record, junk, furniture of another kind, or a table of the
 *  other game). A table this page never saw placed is not out: there is
 *  nothing to put back. */
function fairOnlyLayoutOut(c: ComputedInc): boolean {
  const game = gameOfInc(c.inc);
  return tableSeen.get(c.t)?.has(game) === true && tableRecordGame(layoutMap?.get(c.t)) !== game;
}

/** 🔒 Whether the table of game `c` is to be put back (design §8.4 P5): the
 *  game is the one the table plays, the table is out of the layout, and no end
 *  order stands (B14.3: the game's authority takes its table out by ending the
 *  game, and a removal with the order standing is its own). Whether a check
 *  waits is not asked here: a resolution that waits for a moment is no return
 *  of the table, and putBackFairOnlyTable writes nothing meanwhile. */
function fairOnlyTableOut(c: ComputedInc): boolean {
  return c.fo!.res?.fin === null && fairOnlyPlays(c) && fairOnlyLayoutOut(c);
}

/** 🔒 Whether the table's switch is to be put back on game `c` (design §8.4
 *  P4): the game is the one the table plays, and the switch names another
 *  incarnation or none. The switch is S9's hint, and S9's choice with the hint
 *  on the game it chose is that game still, so the write moves no table. Not
 *  over the name of a page-signed incarnation the doc holds that nothing has
 *  ended (fairOnlySwitchFree): that one waits beside the game, and its name in
 *  the switch is what makes the table its again the moment the game ends. Not
 *  while the table is out of the layout: a removal takes the switch with the
 *  table on every page that hears it (clearTableKeys), and the switch goes
 *  back with the table (putBackFairOnlyTable), or not at all. */
function fairOnlySwitchOff(c: ComputedInc): boolean {
  return fairOnlyPlays(c) && fairOnlySwitchFree(c) && !fairOnlyLayoutOut(c);
}

/** 🔒 Whether the switch of game `c`'s table is off the game and the game's
 *  pages' to write: it names none, a name nothing stands behind, one that has
 *  ended, or another game, and not a page-signed incarnation the doc holds that
 *  nothing has ended (switchedPageSignedInc). A game defers such an
 *  incarnation's duties, never its end nor the switch's moving (PR 6c-4a-2):
 *  with the game's name written over its own, the switch would name an ended
 *  game when the game ends, which only a page that ran the incarnation puts
 *  back (computedTable putSwitchBack), a frame late there and never on a page
 *  loaded meanwhile. S9 plays the game without the hint while it is the deed
 *  holder's, the only live one or the lowest name. When that incarnation ends
 *  with the switch still on it the game is counted again (countTransaction),
 *  and the switch is the game's from then. */
function fairOnlySwitchFree(c: ComputedInc): boolean {
  return switchIncOf(c.t) !== c.inc && switchedPageSignedInc(c.t) === null;
}

/** The session game `c`'s base opens while the game is live, or null (no base,
 *  or one that ends it). */
function fairOnlySessionOf(c: ComputedInc): string | null {
  const base = c.fo!.res?.base?.ck;
  return base !== undefined && base.e !== 1 ? sid3Of(c, base) : null;
}

/** Whether game `c` is live and the session its base opens has no map. */
function fairOnlySessionMissing(c: ComputedInc, map: Y.Map<unknown>): boolean {
  const sid = fairOnlySessionOf(c);
  return sid !== null && !(map.get(sessionKey(c.t, c.inc, sid)) instanceof Y.Map);
}

/** 🔒 The FAIR ONLY games the doc has lost something of that this page holds
 *  (FairOnlyState held, heldXfs, heldFin, heldHks), or whose live session has
 *  no map. Only the games something happened to since they were last found
 *  whole are looked at (foCheck), and one found whole is let go until
 *  something does. Read-only but for that. */
export function computedFairOnlyRecoveries(): FairOnlyRecovery[] {
  const map = computedMap;
  if (!map || foCheck.size === 0) return [];
  const out: FairOnlyRecovery[] = [];
  for (const c of [...foCheck]) {
    const missing = fairOnlyLacks(c, map).length + (fairOnlySwitchOff(c) ? 1 : 0);
    const sessionMissing = fairOnlySessionMissing(c, map);
    const tableMissing = fairOnlyTableOut(c);
    if (missing === 0 && !sessionMissing && !tableMissing) {
      foCheck.delete(c);
      continue;
    }
    const pubs = new Set<string>();
    for (const s of c.last?.felts.values() ?? []) if (s.rec.b.length > 0) pubs.add(s.rec.k);
    out.push({
      t: c.t, inc: c.inc, ctx: c.ctx, u: c.fo!.res?.base?.ck.u ?? 0, missing, tableMissing, tableMoves: tableMoves.get(c.t) ?? 0, sessionMissing,
      sid: fairOnlySessionOf(c), sesMoves: c.fo!.sesMoves, pubs: [...pubs].sort(), returns: c.fo!.returns,
    });
  }
  return out;
}

/** 🔒 How many times, since the doc was bound, the records this page holds of
 *  FAIR ONLY game `inc` of table `tableId` were all in the doc again after the
 *  doc had lacked one (FairOnlyState returns), the table's switch and the
 *  table counted with them while the table plays the game (noteFairOnlyLacks):
 *  the put-backs of the game this page saw, its own and other pages'. 0 for a
 *  game it doesn't track. Read-only. */
export function computedFairOnlyReturns(tableId: string, inc: string): number {
  return computedIncs.get(`${tableId}:${inc}`)?.fo?.returns ?? 0;
}

/** 🔒 How many FAIR ONLY games the put-back duty is to look at next
 *  (computedFairOnlyRecoveries; foCheck): what a tick of it costs. Read-only. */
export function computedFairOnlyChecking(): number {
  return foCheck.size;
}

/**
 * 🔒 Put back what this page holds of FAIR ONLY game `inc` of table `tableId`
 * and the doc lacks (fairOnlyLacks), in one transaction: each value as the doc
 * held it, so every page that counted it writes the same record under the same
 * key, and whichever write the doc keeps is the same. On a doc holding every
 * update whole (a trim deletes the checkpoint it replaces in the update that
 * writes the next, and Yjs applies the deletes of an update it holds part of
 * first). With them, in the same transaction, the table's switch on the game
 * when the table plays it and the switch names another incarnation or none
 * (design §8.4 P4; fairOnlySwitchOff says when): `{ v: 1, inc }`, the value
 * every page writes. Returns how many it wrote, the switch counted as one (0:
 * nothing lacks, or the doc holds part). No page signs anything here, and none
 * of it is a record this page made.
 */
export function putBackFairOnlyRecords(tableId: string, inc: string): number {
  const map = computedMap;
  const c = computedIncs.get(`${tableId}:${inc}`);
  if (!map || !c?.fo || !docAlive() || docHoldsPart()) return 0;
  const back = fairOnlyLacks(c, map);
  const hint = fairOnlySwitchOff(c);
  if (back.length === 0 && !hint) return 0;
  const casino = ensureMap();
  boundDoc!.transact(() => {
    for (const [key, value] of back) map.set(key, value);
    if (hint) casino.set(`cfg:computed:${tableId}`, { v: 1, inc });
  });
  return back.length + (hint ? 1 : 0);
}

/**
 * 🔒 Put the table of FAIR ONLY game `inc` back into the room's layout as this
 * page last saw it placed, and the table's switch on the game with it, in one
 * transaction (design §8.4 P5; fairOnlyTableOut says when): a table taken out
 * by a peer while its game is live, which the removal's teardown took the
 * switch of on every page that heard it (clearTableKeys; it marks nothing of
 * the game, S7; a switch that names a page-signed incarnation nothing has
 * ended is left, as fairOnlySwitchOff leaves it: fairOnlySwitchFree). The
 * placement is the layout's own value, so every page that
 * saw the table where it last stood writes the same record. Not while a check
 * of the game's resolution waits (an end order may be what waits), nor on a
 * doc that holds part of an update. False (nothing written) otherwise.
 */
export function putBackFairOnlyTable(tableId: string, inc: string): boolean {
  const layout = layoutMap;
  const c = computedIncs.get(`${tableId}:${inc}`);
  if (!layout || !c?.fo || !docAlive() || docHoldsPart() || c.fo.res?.pending !== false || !fairOnlyTableOut(c)) return false;
  const placed = tableSeen.get(tableId)!.get(gameOfInc(inc));
  const casino = ensureMap();
  boundDoc!.transact(() => {
    layout.set(tableId, placed);
    if (fairOnlySwitchFree(c)) casino.set(`cfg:computed:${tableId}`, { v: 1, inc });
  });
  return true;
}

/**
 * 🔒 Open again the session FAIR ONLY game `inc` of table `tableId` counts from
 * (the one its base opens), gone from the doc with the game live: one empty
 * map, where the room's pages put their records back (computedTable reputDuty,
 * witnessDuty), as reopenComputedSession does at a page-signed table. Whatever
 * the switch names (a game is live by its base alone, S7), and whether the doc
 * holds the base or only this page does. On a doc holding every update whole.
 * `waited`: the session the caller waited to open and the count of the game's
 * session keys' changes it waited through (FairOnlyRecovery sid, sesMoves, as
 * the put-back duty read them at its look). Nothing is opened when either is
 * another now: a write the caller made since its look (a put-back, whose
 * transaction makes a check that waited) may have moved the game to a base
 * that opens another session, and that one's map has a wait and a turn of its
 * own. False (nothing written) otherwise.
 */
export function reopenFairOnlySession(tableId: string, inc: string, waited?: { sid: string | null; sesMoves: number }): boolean {
  const map = computedMap;
  const c = computedIncs.get(`${tableId}:${inc}`);
  if (!map || !c?.fo || !docAlive() || docHoldsPart() || !fairOnlySessionMissing(c, map)) return false;
  if (waited && (waited.sid !== fairOnlySessionOf(c) || waited.sesMoves !== c.fo.sesMoves)) return false;
  const key = sessionKey(tableId, inc, fairOnlySessionOf(c)!);
  boundDoc!.transact(() => {
    map.set(key, new Y.Map<unknown>());
  });
  return true;
}

/** Recounts asked for outside any transaction of the doc's own: the
 *  incarnations to read whole (giveUpComputed). */
const CT_RECOUNT = Symbol('casino-computed-recount');
const recountWhole = new Set<ComputedInc>();

/**
 * ⚠ Give up the rounds incarnation `inc` of table `tableId` decided in a
 * session that was deleted with nothing in its place (computedLost, held so
 * for GIVE_UP_MS: computedTable recoverDuty): this page reads it whole again
 * as a page that never counted that session does, so its counts are theirs
 * (the table counts from its checkpoint, and is whole again: casinoWhole).
 * Its ⚙ card says which rounds went (computedGaveUp). False when it isn't
 * lost, or the doc holds part of an update.
 */
export function giveUpComputed(tableId: string, inc: string): boolean {
  const map = computedMap;
  const c = ordinaryInc(tableId, inc);
  if (!map || !c || !recoveryOn || docHoldsPart() || !sessionLost(c, map, heldBase(c, map))) return false;
  const res = c.last;
  const to = res ? Math.max(res.base.u, ...res.rounds.filter((r) => r.decided !== null).map((r) => r.r)) : 0;
  if (res && to > res.base.u) c.gaveUp = { sid: c.countedSid!, from: res.base.u + 1, to };
  c.countedSid = null;
  recountWhole.add(c);
  boundDoc!.transact(() => {}, CT_RECOUNT);
  return true;
}

/** ⚠ The rounds of table `tableId`'s switched-on incarnation this page gave
 *  up on (giveUpComputed), until the next checkpoint; null for none. */
export function computedGaveUp(tableId: string): { from: number; to: number } | null {
  const inc = computedIncOf(tableId);
  const g = inc === null ? null : computedIncs.get(`${tableId}:${inc}`)?.gaveUp;
  return g ? { from: g.from, to: g.to } : null;
}

/** ⚠ Whether table `tableId`'s switched-on incarnation counts from a
 *  checkpoint no round can follow (its round + 1 no safe integer) that
 *  nothing this page counted refutes (no restore in motion: a jump past its
 *  head is put back): switching the table off and on is the way out. */
export function computedCheckpointBroken(tableId: string): boolean {
  const inc = computedIncOf(tableId);
  // (🔒 Never a FAIR ONLY game: its base's round is U_MAX at most, readCk.)
  const base = inc === null ? null : baseOf(tableId, inc);
  if (base === null || base.e === 1 || Number.isSafeInteger(base.u + 1)) return false;
  const c = computedIncs.get(`${tableId}:${inc}`);
  return !(c && computedMap && recoveryOn && recoveryTrigger(c, checkpointAt(computedMap, tableId, c.inc)) !== null);
}

/** The players table `tableId`'s switched-on incarnation (or `inc`) counts as
 *  at the table, as last counted: its base's nets, and every one a close froze
 *  in its session (an upper bound on the next checkpoint's nets: closeDuty
 *  freezes no newcomer once it holds MAX_TABLE_PIDS). */
export function computedTablePids(tableId: string, inc: string | null = computedIncOf(tableId)): ReadonlySet<string> {
  const res = inc === null ? null : computedIncs.get(`${tableId}:${inc}`)?.last;
  if (!res) return EMPTY_PIDS;
  let out = tablePids.get(res);
  if (!out) {
    out = new Set(res.base.n.keys());
    for (const round of res.rounds) for (const pid of Object.keys(round.frozen)) out.add(pid);
    // 🎲 A craps checkpoint carries its riders in base.state (CrapsCarry.w):
    // pids whose felt rides across the checkpoint that no net entry and no
    // frozen round names. They carry into the next checkpoint, so they are
    // at the table — counting them keeps a rider from being read as a
    // newcomer with no place (crowdedOut), which would deny their own slips.
    const riders = (res.base.state as { w?: Record<string, unknown> } | null)?.w;
    if (riders) for (const pid of Object.keys(riders)) out.add(pid);
    tablePids.set(res, out);
  }
  return out;
}
const EMPTY_PIDS: ReadonlySet<string> = new Set();
const tablePids = new WeakMap<FoldResult, Set<string>>();

/** The UTF-8 bytes the ids of computedTablePids(tableId) take: what a FAIR ONLY
 *  game's close weighs against MAX_TABLE_PID_BYTES (S6 e), kept with the set. */
export function computedTablePidBytes(tableId: string, inc: string | null = computedIncOf(tableId)): number {
  const pids = computedTablePids(tableId, inc);
  let bytes = tablePidBytes.get(pids);
  if (bytes === undefined) {
    bytes = 0;
    for (const pid of pids) bytes += utf8Length(pid);
    tablePidBytes.set(pids, bytes);
  }
  return bytes;
}
const tablePidBytes = new WeakMap<ReadonlySet<string>, number>();

/** What the room's computed sessions weigh: Σ rawBytes (computedFold: every
 *  key, junk included) over each incarnation's live session as last counted,
 *  ended ones too until they are compacted. A session past ROOM_MIN_BYTES is
 *  trimmed for the room's sake once this passes ROOM_BYTES (computedTable). */
export function computedRoomBytes(): number {
  let total = 0;
  for (const c of computedIncs.values()) if (c.live && c.last) total += c.last.rawBytes;
  return total;
}

/** 🔒 What the room's FAIR ONLY games weigh in kept bytes (FoldResult
 *  keptBytes: the records each pass used, which junk can't raise; less the
 *  felts of the open round no close froze, feltBytes, which anyone can put
 *  down), over every game that is live, as last counted (design §8.4 P3:
 *  pages close nothing while this passes ROOM_BYTES, as no page trims a game). */
export function computedFairOnlyBytes(): number {
  let total = 0;
  for (const c of computedIncs.values()) if (c.fo?.res?.live === true && c.last) total += c.last.keptBytes - c.last.feltBytes;
  return total;
}

/** A computed incarnation that has ended and whose sessions are still in
 *  the doc: what compaction finalises (computedTable). */
export interface EndedComputed {
  t: string;
  inc: string;
  /** Its fold as last counted (its decided nets: the final checkpoint's). */
  res: FoldResult;
  /** The session map its checkpoint opens, to read its records by (null:
   *  only another of its session maps is left). Read-only. */
  session: Y.Map<unknown> | null;
}

/** Every incarnation this page counts that has ended (a `gone:` mark, a
 *  switch that is missing or names another incarnation, or a checkpoint
 *  saying it ended) and still has a session map in the doc, by key. A table
 *  a removal took out isn't among the room's tables any more, so this, not
 *  the tables passed in, is what compaction goes by. 🔒 A switch naming a
 *  live FAIR ONLY game (S7) is a hint, not another incarnation taking a
 *  page-signed one's place: while a game is live the table plays it (S9) and
 *  the page-signed incarnations only wait, their frozen slips still to reveal
 *  when the game ends or the deed moves (computedIncOf). Compaction would
 *  make that wait final: the end checkpoint, the sessions, then the seeds.
 *  (The wait is kept by the pages that ran them: they put the switch back
 *  when the game ends. With none left, nothing does, and the incarnation is
 *  an abandoned one, compacted after the wait, its open round void.) The same
 *  goes for a switch naming an incarnation of the table's other game that the
 *  doc holds and nothing has ended, beside a live game (otherGameStands): a peer's
 *  doing or a forgery, no successor, and the incarnation waits as under a hint
 *  while the game is live, until the room clears the name (computedTable awayDuty);
 *  if the game ends first nothing puts the switch back over that name (a dead FAIR
 *  ONLY name is put back over, an incarnation of the other game that the doc holds is
 *  not), so the incarnation is listed from then and compacted after its wait, as on
 *  main. Not one the switch
 *  has left for another page-signed incarnation the doc holds (`leftFor`): that
 *  one is over, a game played or not, and a name that comes afterwards, a hint
 *  that names the game again or one of the other game, does not bring it back. */
export function computedEndedIncs(): EndedComputed[] {
  const casino = ensureMap();
  const map = computedMap!;
  const withSession = new Set<string>();
  for (const key of map.keys()) {
    const at = computedKeyParts(key);
    if (at && at.sid !== undefined && map.get(key) instanceof Y.Map) withSession.add(`${at.t}:${at.inc}`);
  }
  const out: EndedComputed[] = [];
  for (const key of [...withSession].sort()) {
    const c = computedIncs.get(key);
    // (A FAIR ONLY game is compacted by its own rules: PR 6c-4b.)
    if (!c?.last || c.fo) continue;
    const named = computedCfgInc(casino.get(`cfg:computed:${c.t}`));
    const live = (named === c.inc || (named !== null && c.leftFor === null && (isFairOnlyInc(named) ? fairOnlyLive(c.t, named) : otherGameStands(c, named))))
      && !casino.has(goneKey(c.t, c.inc)) && heldBase(c, map)?.e !== 1;
    if (!live) out.push({ t: c.t, inc: c.inc, res: c.last, session: c.live });
  }
  return out;
}

/** Every table whose switch names an incarnation this page counts (it has
 *  a session or a checkpoint in the doc) that nothing has ended
 *  (switchedPageSignedInc: the switch's own name, not the game the table
 *  plays), with that incarnation: what computedTable's awayDuty looks for
 *  among the room's tables. A table a removal took out ends here,
 *  but only on a page that ran the removal (clearTableKeys); this is how a
 *  page finds one whose removal it never ran. */
export function computedLiveTables(): { t: string; inc: string }[] {
  const out: { t: string; inc: string }[] = [];
  for (const t of computedIncsOf.keys()) {
    const inc = switchedPageSignedInc(t);
    if (inc !== null) out.push({ t, inc });
  }
  return out;
}

/** The page-signed incarnation table `tableId`'s switch names, when this page
 *  counts it (the doc holds a key of a session or a checkpoint of it, whatever
 *  its value: a peer's junk under one is a name this page counts, as the table
 *  plays the name a switch carries) and nothing has ended it; else null. The
 *  switch's, not the game played: the incarnation awayDuty watches. (The state
 *  a page keeps beside a FAIR ONLY game waits for the incarnation it ran, and
 *  the successor of one the switch has left is switchLeftFor.) 🔒 A FAIR ONLY
 *  game's end is its authority's, and its name is a hint, not this. */
export function switchedPageSignedInc(tableId: string): string | null {
  const inc = switchIncOf(tableId);
  return inc !== null && ordinaryInc(tableId, inc) !== undefined && !computedIncEnded(tableId, inc) ? inc : null;
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
/** The bound room's players map, and the binding's pin (pinPlayerKeys). */
let playersMap: Y.Map<unknown> | null = null;
let pinPlayer: ((pid: string, v: unknown) => void) | null = null;

function entryKey(v: unknown): string | undefined {
  const k = (v as { keyB64?: unknown } | undefined)?.keyB64;
  return typeof k === 'string' && k.length > 0 && k.length <= 128 ? k : undefined;
}

function pinPlayerKeys(doc: Y.Doc): void {
  const pins = new Map<string, string>();
  pinnedKeys = pins;
  const players = doc.getMap('players');
  // 🧮 A computed felt counts only under its player's pinned key, so a new
  // pin can make one count (TableFold keysChanged). The computed recount
  // pins a transaction's players itself first, so the felt counts in that
  // very transaction (onComputedTransaction); here it is pinned already.
  const pin = (pid: string, v: unknown): void => {
    if (pins.has(pid) || pins.size >= MAX_PINNED_KEYS || pid.length === 0 || pid.length > 128) return;
    const k = entryKey(v);
    if (!k) return;
    pins.set(pid, k);
    if (pinnedKeys !== pins || computedIncs.size === 0) return;
    for (const c of computedIncs.values()) c.fold.keysChanged();
    computedKeysMoved = true;
  };
  playersMap = players;
  pinPlayer = pin;
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
