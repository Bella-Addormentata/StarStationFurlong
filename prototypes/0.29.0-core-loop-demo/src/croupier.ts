/**
 * 🎰🤖 The auto-croupier (#77 Phase B) — the owner's robot runs a roulette
 * table on a timed betting cycle so a table plays itself, calling "place your
 * bets" / "no more bets" and paying out on a rhythm.
 *
 * THE SPLIT that makes this safe (see the #77B design):
 *   • The ROBOT is local ambience — every client renders its own walking to the
 *     wheel-head and narrating; nothing about the robot crosses the wire.
 *   • The GAME STATE is the synced `casino` Y.Map (`table:<id>`), whole-value
 *     LWW, written by ONE elected client. So the TIMER + roll + credit run on a
 *     single operator; the visuals run everywhere.
 *
 * ELECTION = the room's DEED HOLDER (main.ts currentRoomDeedIsMine — the raw
 * at-most-one owner, NOT the shareholder-extended `isHouse`). A personal or solo
 * room has exactly one deed holder, and of their open pages only the one holding
 * the `table-operator` lease drives (takeTableTurn) ⇒ no double-settle. Venture
 * rooms (every shareholder is house) are NOT auto-driven — they keep the
 * manual SPIN button. Legacy 'Local-Clone' rooms are not auto-driven either,
 * but 🔒 #141 changed WHY: they used to make everyone the deed holder; now
 * they make no one. main.ts registers the predicate at boot.
 *
 * NO SHARED CLOCK: the operator's Date.now() is the reference. It stamps an
 * absolute `phaseDeadline` into the record and is the only client that advances
 * the phase; everyone else renders `deadline − localNow` as a display-only
 * countdown (the offers.ts expiresAt precedent, single-writer for seconds-scale).
 *
 * ⚖️ FAIRNESS: by default the pocket comes from the house's seed mixed with
 * every bettor's (fairTableSeeds.ts) — committed at open, frozen at "no more
 * bets", revealed at the settle — so the operator can't pick the number. A
 * table the owner sets to plain RNG still spins from the operator's client.
 *
 * 🧮 COMPUTED TABLES (computedTable.ts) have no operator: the robot opens no
 * round there and posts no heartbeat. It only sweeps away an owner-run round
 * an earlier build's lease holder opened on one (sweepLegacyRound), and drops
 * a switch nothing stands behind, a peer's forgery (dropBareSwitch); the
 * stickman does both at a computed craps table (crapsCroupier). And the
 * lease says which build drives (`build`), so the house can't switch a table
 * to computed while an earlier build runs the room's tables.
 */

import {
  casinoDocEpoch,
  casinoWhole,
  clearTableKeys,
  COMPUTED_MIN_BUILD,
  computedIncOf,
  computedSwitchBare,
  computedSwitchLost,
  creditTableOutcome,
  feltStake,
  isComputedTable,
  putTableBack,
  readAllBets,
  readCroupierBeat,
  readEmptiedLists,
  readFeltStakes,
  readTableOperatorLease,
  readTableState,
  rouletteListLost,
  setTablesAwakeCheck,
  TABLE_BUILD,
  tableEndingStakes,
  tableIncOf,
  tableOpening,
  tableWritable,
  transactCasino,
  writeComputedOff,
  writeCroupierBeat,
  writeSettledState,
  writeTableOperatorLease,
  writeTableState,
  whenCasinoWhole,
} from './casinoDoc';
import type { TableClosing, TableOperatorLease } from './casinoDoc';
import { getPlayerId } from './identity';
import { pocketColor, resolveRound } from './games/roulette';
import type { RouletteTableState } from './games/roulette';
import { settleParties } from './games/diceFairness';
import type { FairnessTranscript } from './games/craps';
// ⚖️ Fair by default: the house + bettors' seed exchange (fairTableSeeds.ts).
import {
  freezeCommits, frozenFields, frozenPartiesSigned, frozenWagers, gatherRound, heldAtClose, isFairTable, newHouseCommit,
  settledRound,
} from './fairTableSeeds';

/** Betting window once the first chip lands (the clock arms on a real bet, so a
 *  quiet table never spins nothing). */
export const BET_WINDOW_MS = 18_000;
/** "No more bets" beat before the wheel resolves. */
export const CLOSING_MS = 3_000;
/** How long the settled result + payouts stay up before the next round opens
 *  (≥ the 4 s local wheel animation, so the number lingers after it stops). */
export const SHOW_MS = 9_000;
/** 🎲 A craps table's betting window once the first chip lands (the clock
 *  arms on a real bet, so a quiet come-out table never throws to an empty
 *  felt; crapsCroupier.ts, and a computed craps table). */
export const CRAPS_BET_WINDOW_MS = 16_000;
/** How long a settled roll + payouts stay up before the next window opens
 *  (≥ the local dice-tumble animation, so the number lingers after it stops). */
export const CRAPS_SHOW_MS = 6_000;
/** 🎲 #226: how long a shooter has to pick the dice up and fling them before
 *  the stickman throws for them. */
export const CRAPS_SHOOTER_MS = 20_000;
/** 🎡 A house member's SPIN lease is honoured this long before another page
 *  (a house member's SPIN, or the robot) may take the round over: the reveal
 *  wait plus a margin. Measured on the taking page's own clock. */
export const SPIN_TAKEOVER_MS = 15_000;
/** Operator heartbeat cadence — how often the driver refreshes `croupier:<id>`. */
export const HEARTBEAT_MS = 3_000;
/** A beat older than this ⇒ the operator is gone; fall back to manual controls. */
const HEARTBEAT_STALE_MS = 9_000;

// ── Operator election seam (mirrors editMode.canEditRoom) ────────────────────

/** Offline default: no sync ⇒ we are the only client ⇒ we operate. main.ts
 *  swaps in the real deed-holder check at boot. */
let solePredicate: () => boolean = () => true;

export function setSoleCroupierPredicate(fn: () => boolean): void {
  solePredicate = fn;
}

/** Is a table of this id in the room's furniture? main.ts registers the
 *  real check at boot (a removal heard on a doc not yet whole waits, and is
 *  dropped if the table is back by then: closeWhenWhole). */
let tableInRoom: (tableId: string) => boolean = () => false;

export function setTableInRoomPredicate(fn: (tableId: string) => boolean): void {
  tableInRoom = fn;
}

/** May THIS client drive the auto-croupier here? True on the deed holder's
 *  pages in a personal/solo room; false in venture / legacy shared rooms
 *  (manual). Of those pages, only the one taking the table turn
 *  (takeTableTurn) drives the tables. */
export function canRunCroupier(): boolean {
  return solePredicate();
}

// ── One page drives the tables (the `table-operator` lease) ──────────────────

/** A lease not seen to change for this long has lapsed (its page is gone).
 *  Timed on this page's clock from the last change it saw, so pages whose
 *  clocks disagree still agree. */
export const TABLE_LEASE_LAPSE_MS = 6_000;
/** The holder rewrites the lease this often. */
export const TABLE_LEASE_RENEW_MS = 2_000;
/** A page that has just claimed the lease waits this long before it drives,
 *  so a rival claim made at the same moment has arrived and one has won. */
export const TABLE_LEASE_SETTLE_MS = 1_500;

let leaseEpoch = -1;
/** The lease as this page last saw it change, and when. */
let leaseSeen: { page: string; beat: number; at: number } | null = null;
/** When this page claimed the lease it holds (null: it holds none it claimed). */
let leaseClaimedAt: number | null = null;
/** Since when, by this page's clock, its doc has held part of an update (null: whole). */
let wholeSince: number | null = null;
let leaseRenewedAt = 0;

function noteLease(lease: TableOperatorLease | null, now: number): void {
  const epoch = casinoDocEpoch();
  if (epoch !== leaseEpoch) {
    leaseEpoch = epoch;
    leaseSeen = null;
    leaseClaimedAt = null;
  }
  if (!lease) leaseSeen = null;
  else if (!leaseSeen || leaseSeen.page !== lease.page || leaseSeen.beat !== lease.beat) {
    leaseSeen = { page: lease.page, beat: lease.beat, at: now };
  } else if (now < leaseSeen.at) {
    // The clock went back: the watch runs from now, not from when the clock
    // comes round to where it was.
    leaseSeen.at = now;
  }
}

/** Nobody of this player's is driving: no lease, a lapsed one, or one an
 *  earlier deed holder's page left. */
function leaseIsFree(lease: TableOperatorLease | null, now: number, playerId: string): boolean {
  return !lease || lease.player !== playerId
    || (leaseSeen !== null && now - leaseSeen.at >= TABLE_LEASE_LAPSE_MS);
}

/** 🧮 Does a build before `min` drive this room's tables: a lease whose
 *  `build` is below it (or that has none: a build before 2) that this page
 *  hasn't watched sit still for a lapse? Watched on this page's clock, as
 *  takeTableTurn watches it (the house's page may be one that never drives),
 *  so a lease left by a page that has gone reads as nobody's once it has sat
 *  for a lapse. The house's switch to a computed table waits for it: that
 *  page would go on opening owner-run rounds there. `min` is the first build
 *  that knows the table's game (casinoDoc COMPUTED_MIN_BUILD; roulette's by
 *  default). */
export function leaseIsOldBuild(now = Date.now(), min: number = COMPUTED_MIN_BUILD.roulette): boolean {
  const lease = readTableOperatorLease();
  noteLease(lease, now);
  if (!lease || (lease.build ?? 0) >= min) return false;
  return !(leaseSeen !== null && now - leaseSeen.at >= TABLE_LEASE_LAPSE_MS);
}

/** When this page last ran its tables, in this room doc, and the earliest it
 *  may act on them again after it stopped running them for a lapse. */
let tablesEpoch = -1;
let tablesRanAt: number | null = null;
let tablesFrom = 0;
/** How many times this page has woken from not running its tables. */
let tablesWakes = 0;

/** Has the room's state come in since this page joined it (main.ts wires
 *  routeRoomReady)? Until it has, the doc may be the room cache's copy from
 *  before this page left, its own lease in it: tables driven on that copy
 *  would undo the rounds another page settled meanwhile, and slots or a coin
 *  pusher run on it would refund or settle again what another page has.
 *  Yes with no room sync. */
let roomStateArrived: () => boolean = () => true;
/** How long a page waits for the room's state before it runs its tables, slots
 *  and coin pushers on the copy it has (a room whose host never answers): a
 *  split then, the doc keeping one side's book (casinoDoc THE TABLE'S BOOK). */
export const ROOM_STATE_WAIT_MS = 30_000;

export function setRoomStateArrivedCheck(check: () => boolean): void {
  roomStateArrived = check;
}

/** When this page first looked for the room's state in this room doc. */
let roomEpoch = -1;
let roomSince = 0;

/** May this page act on the room's casino on the doc it has: has the room's
 *  state come in this visit, or has it waited ROOM_STATE_WAIT_MS for it? A
 *  clock gone back counts the wait from then. The tables ask (tablesAwake),
 *  and so do the slots' and the coin pusher's elections before a take. */
export function roomStateIn(now = Date.now()): boolean {
  if (casinoDocEpoch() !== roomEpoch) {
    roomEpoch = casinoDocEpoch();
    roomSince = now;
  }
  if (now < roomSince) roomSince = now;
  return roomStateArrived() || now - roomSince >= ROOM_STATE_WAIT_MS;
}
/** A clock gone back by less than this (a time sync's correction) is no
 *  sleep: what this page waits on moves back with it (noteTablesRunning). */
export const TABLE_CLOCK_SLACK_MS = 1_000;

/**
 * This page is running its tables this frame (World calls it every frame the
 * room has tables, whoever drives them; takeTableTurn calls it too). A page
 * that stopped for a lapse or more (the computer slept, the tab froze) may
 * wake on a doc that hasn't heard another page take its tables over
 * meanwhile, and a settle written on that doc would undo the other page's
 * rounds when the two meet (the doc keeps one write of a table's book). So
 * it waits out a lapse again, acting on no table, for the doc to catch up
 * (tablesAwake). A page cut off from the room while it keeps running can't
 * tell: the doc keeps one side's book whole (casinoDoc THE TABLE'S BOOK).
 */
export function noteTablesRunning(now = Date.now()): void {
  const epoch = casinoDocEpoch();
  if (epoch !== tablesEpoch) {
    tablesEpoch = epoch;
    tablesRanAt = null;
    tablesFrom = 0;
  }
  // A clock gone back (a correction as the computer wakes, a manual change)
  // says nothing of how long the page was away: it wakes as from a sleep,
  // its wait a lapse from now, not until the clock comes round again. One
  // gone back by under a second is a time sync's step: a wait under way
  // moves back with it, and the page runs on.
  if (tablesRanAt !== null && now < tablesRanAt && tablesRanAt - now < TABLE_CLOCK_SLACK_MS) {
    tablesFrom -= tablesRanAt - now;
  } else if (tablesRanAt !== null && (now - tablesRanAt >= TABLE_LEASE_LAPSE_MS || now < tablesRanAt)) {
    tablesFrom = now + TABLE_LEASE_LAPSE_MS;
    tablesWakes += 1;
  }
  tablesRanAt = now;
}

/** What a house press says while this page waits out a wake (tablesAwake). */
export const RECONNECTING_NOTICE = 'RECONNECTING — PRESS AGAIN IN A MOMENT';

/** How many times this page has woken after not running its tables for a
 *  lapse (noteTablesRunning). A watch over another page's turn started
 *  before a wake starts again: the time asleep wasn't spent watching. */
export function tablesWakeCount(): number {
  return tablesWakes;
}

/** May this page act on its tables now (drive them, settle a round)? Not
 *  before the room's state has come in this visit (for ROOM_STATE_WAIT_MS
 *  at most), nor while it waits out a lapse after it stopped running them,
 *  nor once a lapse has gone by since it last ran them, or its clock has
 *  gone back since: a settle resuming from its awaits after a sleep, before
 *  the page's next frame. A page that hasn't run them in this doc yet may,
 *  once the room's state is in. */
export function tablesAwake(now = Date.now()): boolean {
  if (!roomStateIn(now)) return false;
  const ran = casinoDocEpoch() === tablesEpoch ? tablesRanAt : null;
  if (ran === null) return true;
  return now >= tablesFrom && ran - now < TABLE_CLOCK_SLACK_MS && now - ran < TABLE_LEASE_LAPSE_MS;
}
// Nor does it write a table's book back up meanwhile (casinoDoc tableWritable).
setTablesAwakeCheck(() => tablesAwake());

/**
 * May this page drive the auto tables this frame? Call it every frame from a
 * page that canRunCroupier(), and drive only on true. It claims a free lease,
 * keeps renewing its own, and leaves one another of the deed holder's pages
 * holds alone. A fresh claim drives only after TABLE_LEASE_SETTLE_MS. A page
 * waking from a sleep claims and renews nothing until it is awake again
 * (noteTablesRunning): by then its doc shows the other page's lease, or its
 * own.
 */
export function takeTableTurn(
  now = Date.now(),
  playerId = getPlayerId(),
  pageId = ROULETTE_PAGE_ID,
): boolean {
  const lease = readTableOperatorLease();
  noteLease(lease, now);
  noteTablesRunning(now);
  if (!tablesAwake(now)) return false;
  // 📒 A page whose doc has held part of an update for a lease's lapse
  // settles nothing (casinoWhole), so it renews nothing either: another of
  // the owner's pages takes the tables (the room is asked again meanwhile
  // for what this one is missing).
  if (casinoWhole()) wholeSince = null;
  else {
    if (wholeSince === null || now < wholeSince) wholeSince = now;
    if (now - wholeSince >= TABLE_LEASE_LAPSE_MS) return false;
  }
  // (Its clock gone back, its claim and renewal count from now.)
  if (leaseClaimedAt !== null && now < leaseClaimedAt) leaseClaimedAt = now;
  if (now < leaseRenewedAt) leaseRenewedAt = now - TABLE_LEASE_RENEW_MS;
  if (lease?.page !== pageId) {
    // Nor a fresh claim on a doc holding part of an update at all: the
    // driver's renewal parked there reads as no lease.
    if (!casinoWhole() || !leaseIsFree(lease, now, playerId)) return false;
    writeTableOperatorLease({ page: pageId, player: playerId, beat: 1, build: TABLE_BUILD });
    leaseClaimedAt = now;
    leaseRenewedAt = now;
    return false;
  }
  if (leaseClaimedAt === null) leaseClaimedAt = now;
  if (now - leaseRenewedAt >= TABLE_LEASE_RENEW_MS) {
    // 🧮 The build, every time: an earlier build's page that takes the lease
    // over renews only what it read, so its lease reads without one.
    writeTableOperatorLease({ ...lease, beat: lease.beat + 1, build: TABLE_BUILD });
    leaseRenewedAt = now;
  }
  return now - leaseClaimedAt >= TABLE_LEASE_SETTLE_MS;
}

/** Does this page still drive the auto tables (no lease at all, or its own)?
 *  An auto settle checks it again after its awaits, so a page that lost the
 *  lease meanwhile writes no result and pays nothing. */
export function stillDrivesTables(pageId = ROULETTE_PAGE_ID): boolean {
  const lease = readTableOperatorLease();
  return lease === null || lease.page === pageId;
}

// ── Random pocket (operator-side; an RNG table, or nobody revealed) ──────────

/** Uniform pocket 0–36 via rejection sampling (no modulo bias). */
function spinPocket(): number {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4294967289) return buf[0] % 37; // floor(2^32/37)*37
  }
}

// ── Phase transitions (the single settle/open implementation) ─────────────────

/** Tables mid-settle — the Fair settle hashes (async) and may wait on reveals,
 *  while the operator's tick calls every frame. */
const settling = new Set<string>();

/**
 * Spin, resolve, publish the settled record, and credit winners. Called by the
 * operator's timer (with `autoShowMs` so it auto-opens the next round) AND by
 * the manual SPIN (no `autoShowMs` — the house clicks NEW ROUND). FIRE-AND-
 * FORGET: on a Fair table it settles once the frozen bettors have revealed
 * (or REVEAL_GRACE_MS ran out); until then a call does nothing and the caller
 * simply calls again. Only a 'closing' table at `round` settles.
 */
export function rollAndSettle(tableId: string, round: number, autoShowMs?: number): void {
  if (settling.has(tableId)) return;
  settling.add(tableId);
  settleRoulette(tableId, round, autoShowMs)
    .catch((err) => console.error('[roulette] settle failed:', err))
    .finally(() => settling.delete(tableId));
}

/** This page, as a manual SPIN's settlement lease holder (see `operator`). */
export const ROULETTE_PAGE_ID = `${getPlayerId()}:${Math.random().toString(36).slice(2, 10)}`;

async function settleRoulette(tableId: string, round: number, autoShowMs?: number): Promise<void> {
  const epoch = casinoDocEpoch();
  const live0 = readTableState(tableId);
  if (live0?.phase !== 'closing' || live0.round !== round) return;
  // Fair or not goes by the house commit this page froze, when it froze one:
  // erasing the live field after the close mustn't downgrade the round.
  const frozenHouse = frozenFields(tableId, live0).houseCommit;
  const closing: RouletteTableState = frozenHouse ? { ...live0, houseCommit: frozenHouse } : live0;
  let result: number | null;
  let fairness: FairnessTranscript | undefined;
  let forfeited: string[] = [];
  let voided = false;
  // A round opened Fair (it carries a house commit) settles Fair, whatever the
  // owner switched the table to since; the switch takes effect next round.
  if (closing.houseCommit && !frozenPartiesSigned(tableId, closing)) {
    // ⚖️ A frozen party without its own signature (this page didn't freeze
    // the round, and the closing fields were rewritten): never mixed or paid.
    voided = true;
    result = null;
  } else if (closing.houseCommit) {
    const gathered = gatherRound(tableId, closing);
    if (!gathered) return; // reveals still due
    forfeited = gathered.forfeited;
    if (!gathered.parties[0].seed) {
      // ⚖️ No house seed to reveal (this page lost it): the house has seen
      // every bettor's reveal, so settling without its seed would let it pick
      // between outcomes. The round is void and every stake goes back.
      voided = true;
      result = null;
    } else {
      const mixed = await settleParties('roulette', gathered.parties, tableId, round);
      result = mixed!.pocket!;
      fairness = mixed!.transcript;
    }
  } else {
    result = spinPocket();
  }
  // The hashing yielded: settle only in the same room doc, and 📒 not on a
  // doc holding part of another page's update: what it rewrote reads as
  // gone until the rest comes (casinoWhole). The caller calls again.
  if (casinoDocEpoch() !== epoch || !casinoWhole(tableId)) return;
  // Settled already, and a takeover's stamp written as it settled came back
  // over it, or the doc kept another page's book: the round stands as the
  // book has it, put back up (putTableBack).
  if (putTableBack(tableId)) return;
  // Only the very round this call was for, on the same table (a table
  // removed and put back, which can reach the same round meanwhile on a new
  // incarnation, or a rival settle, is not).
  const before = readTableState(tableId);
  if (before?.phase !== 'closing' || before.round !== round) return;
  if (tableIncOf(tableId, before) !== tableIncOf(tableId, live0)) return;
  // Nor another write of its book's (the other side's round of that number,
  // which the doc kept while this one hashed): this one's spin was for it.
  if (before.bk !== live0.bk) return;
  // 🎡 A manual round settles only on the page holding its lease: two house
  // members pressing SPIN must not both publish and pay.
  if (before.operator !== undefined && before.operator !== ROULETTE_PAGE_ID) return;
  // 🤖 An auto round settles only on the page still driving the tables: the
  // hashing can outlive its lease (another of the owner's pages took over).
  if (before.operator === undefined && !stillDrivesTables()) return;
  // 💤 Nor, a manual round either, on a page that slept since it last ran
  // its tables: its doc may not have heard who took them over meanwhile.
  if (!tablesAwake()) return;
  // ⚖️ Only the wagers frozen at "no more bets" settle (the reveals made the
  // pocket computable; a rewritten list is void), and a bettor who committed
  // but never revealed forfeits this round's bets.
  const live = readAllBets(tableId, round);
  const { bets, omitted, voided: rewritten } = frozenWagers(tableId, before, live);
  // (Nor is a bettor whose list the doc kept from the other side of a split
  // one who rewrote it: it plays nothing here. rouletteListLost)
  const lost = new Set(rewritten.filter((pid) => rouletteListLost(tableId, pid, round)));
  // (A void round produced no pocket, so nobody's reveal mattered: no forfeits.)
  if (!voided) for (const pid of forfeited) delete bets[pid];
  const payouts = result === null ? {} : resolveRound(bets, result);
  // 🪙 What the round does to each bettor's chips (casinoDoc STAKES ON THE
  // FELT). A list stops holding its chips as the round ends, so the settle
  // takes what it held and pays what it won. What an earlier build's list
  // took isn't held: its win is paid in full, and a stake the round gives
  // back is refunded.
  // Every bettor, and every list that hands back what an earlier build took
  // (one taken all down holds below 0 and isn't among the live bets), and
  // every list taken all down this round (readEmptiedLists), and every
  // bettor the close named (an RNG round's): a record of nothing all the
  // same, so the settle's book names every bettor whose list it saw (the
  // removal refunds skip what it settled: endCounts, tableEndingStakes).
  const owed: Record<string, number> = {};
  const pids = [
    ...Object.keys(live), ...rewritten, ...Object.keys(readFeltStakes(tableId)), ...readEmptiedLists(tableId, round),
    ...(before.bettors ?? []),
  ];
  for (const pid of new Set(pids)) {
    const held = heldAtClose(tableId, before, pid);
    let delta: number;
    // A bet that missed the freeze (it arrived just after "no more bets"),
    // one the doc lost in a split, or any bet on a void round, goes back to
    // its bettor: what it held is released as the round ends, and what was
    // taken of it is refunded.
    if (omitted.includes(pid) || lost.has(pid) || (voided && !rewritten.includes(pid))) {
      delta = feltStake(tableId, pid).taken;
    }
    // A list rewritten (or emptied) after the close is lost as it was
    // frozen (the rewrite could shrink it), and never paid.
    else if (rewritten.includes(pid)) delta = -held;
    // (A forfeit wins nothing.)
    else delta = (payouts[pid] ?? 0) - held;
    owed[pid] = delta;
  }
  const now = Date.now();
  // One transaction: a page sees the settled round and what it paid together.
  transactCasino(() => {
    writeSettledState(tableId, {
      kind: 'roulette',
      phase: 'settled',
      round,
      result,
      resultAt: now,
      payouts,
      ...(voided ? { voided: true } : {}),
      ...(fairness ? { fairness } : {}),
      ...(before.houseCommit !== undefined ? { houseCommit: before.houseCommit } : {}),
      // The commits and wagers as this page froze them, not as the shared
      // state reads now (anyone can rewrite it after the reveals).
      ...frozenFields(tableId, before),
      ...(before.unseeded !== undefined ? { unseeded: before.unseeded } : {}),
      ...(before.inc !== undefined ? { inc: before.inc } : {}),
      ...(autoShowMs != null ? { phaseDeadline: now + autoShowMs } : {}),
    });
    settledRound(tableId, before);
    // One change per bettor for the round, in this settle's write of the
    // table's book (creditTableOutcome).
    for (const [pid, amount] of Object.entries(owed)) creditTableOutcome(tableId, tableIncOf(tableId, before), round, pid, amount);
  });
}

/** "No more bets": close the window and freeze the round's commitments.
 *  `deadlineMs` set ⇒ the robot's beat before the spin. */
export function closeBetting(tableId: string, s: RouletteTableState, deadlineMs?: number, operator?: string): void {
  const next: RouletteTableState = {
    ...s, phase: 'closing', ...freezeCommits(tableId, 'roulette', s), ...(operator ? { operator } : {}),
  };
  if (deadlineMs != null) next.phaseDeadline = Date.now() + deadlineMs;
  else delete next.phaseDeadline;
  writeTableState(tableId, next);
}

/** Open a fresh betting round (idle — no timer until a first bet arms it). */
export function openBetting(tableId: string, round: number): void {
  // 📒 Not on a doc holding part of an update, where a table read as gone
  // would open anew, nor on a page just woken (tableWritable).
  if (!tableWritable(tableId)) return;
  // 🧮 Nor on a computed table: nobody runs its rounds (computedTable). Nor
  // while its switch is lost (a peer took it away, the room puts it back):
  // its players are mid-round there.
  if (isComputedTable(tableId) || computedSwitchLost(tableId)) return;
  // One transaction: a name a removal left unmarked is marked as it opens.
  transactCasino(() => writeTableState(tableId, {
    kind: 'roulette',
    phase: 'betting',
    round,
    result: null,
    resultAt: 0,
    payouts: null,
    ...(isFairTable(tableId) ? { houseCommit: newHouseCommit(tableId, round) } : {}),
    ...tableOpening(tableId),
  }));
}

/** When this page first saw each table's current SPIN lease (its epoch,
 *  incarnation, round and holder, since this page last woke), by this page's
 *  clock. */
const spinSeen = new Map<string, {
  epoch: number; wake: number; inc: string | undefined; round: number; operator: string; at: number;
}>();

/** Since when this page has watched the SPIN lease `operator` holds on round
 *  `s`: the robot and this page's own SPIN take it over only after
 *  SPIN_TAKEOVER_MS of it. */
export function spinSeenAt(tableId: string, s: RouletteTableState, operator: string, now: number): number {
  const epoch = casinoDocEpoch();
  const wake = tablesWakeCount();
  const seen = spinSeen.get(tableId);
  if (seen && seen.epoch === epoch && seen.wake === wake && seen.inc === s.inc && seen.round === s.round
    && seen.operator === operator && seen.at <= now) {
    return seen.at;
  }
  spinSeen.set(tableId, { epoch, wake, inc: s.inc, round: s.round, operator, at: now });
  return now;
}

/** When this page first saw each computed table's owner-run round (its
 *  epoch, incarnation and round, since this page last woke), by this
 *  page's clock. */
const legacySeen = new Map<string, { epoch: number; wake: number; inc: string; round: number; at: number }>();

/**
 * 🧮 An earlier build's lease holder knows nothing of computed tables, and
 * opens an owner-run round on one as on any table (its players bet there,
 * its own pages settle it into its own book, under an incarnation name that
 * never meets the computed one's). Once this build holds the lease and has
 * watched such a round sit for a lapse (its driver gone), it ends that
 * round's incarnation alone, as a removal would (refundAndClear,
 * keepComputed): its lists stop holding, what an earlier build's lists took
 * is refunded, its book counts on, and the computed incarnation, its switch
 * and its sessions are as they were. Only on a whole doc (the caller). At
 * craps the same, its state read by `read` (readCrapsTableState): the bets
 * still on its felt go back, riding ones too, and what its rolls already
 * paid stands.
 */
export function sweepLegacyRound(
  tableId: string, now: number, read: (tableId: string) => { round: number; inc?: string } | null = readTableState,
): void {
  const s = read(tableId);
  if (!s) {
    legacySeen.delete(tableId);
    return;
  }
  const epoch = casinoDocEpoch();
  const wake = tablesWakeCount();
  const inc = tableIncOf(tableId, s);
  let seen = legacySeen.get(tableId);
  // (A wake, or a clock gone back, starts the watch again: the time away
  // wasn't spent watching.)
  if (!seen || seen.epoch !== epoch || seen.wake !== wake || seen.inc !== inc || seen.round !== s.round || seen.at > now) {
    legacySeen.set(tableId, seen = { epoch, wake, inc, round: s.round, at: now });
  }
  if (now - seen.at < TABLE_LEASE_LAPSE_MS) return;
  legacySeen.delete(tableId);
  transactCasino(() => refundAndClear(tableId, 'local', { keepComputed: true }));
}

/** When this page first saw each table's switch bare (its epoch, the
 *  incarnation named, since this page last woke), by this page's clock. */
const bareSeen = new Map<string, { epoch: number; wake: number; inc: string; at: number }>();

/**
 * 🧮 A switch nothing stands behind (casinoDoc computedSwitchBare: it names
 * an incarnation the doc holds no session and no checkpoint of) is a peer's
 * forgery: no build writes one so. Yet every page of this build reads the
 * table as computed: the robot runs no round there (an owner-run one under
 * way is swept a lapse on), and no felt can go down, there being no session
 * to write into. Once this build holds the lease and has watched the switch
 * stay bare for a lapse, on a whole doc (the caller), it drops it as the
 * house's switch-off drops a forged one (writeComputedOff: its incarnation
 * marked ended, so a session of it turning up later is compacted, its nets
 * counted, nothing held), and the table is owner-run again: the round under
 * way goes on, as before the forgery. Before the sweep, whose lapse is the
 * same: the round under way is this build's own, not an earlier build's.
 * True when it dropped it (the caller's tick is over).
 */
export function dropBareSwitch(tableId: string, now: number): boolean {
  const inc = computedSwitchBare(tableId) ? computedIncOf(tableId) : null;
  if (inc === null) {
    bareSeen.delete(tableId);
    return false;
  }
  const epoch = casinoDocEpoch();
  const wake = tablesWakeCount();
  let seen = bareSeen.get(tableId);
  // (A wake, or a clock gone back, starts the watch again.)
  if (!seen || seen.epoch !== epoch || seen.wake !== wake || seen.inc !== inc || seen.at > now) {
    bareSeen.set(tableId, seen = { epoch, wake, inc, at: now });
  }
  if (now - seen.at < TABLE_LEASE_LAPSE_MS) return false;
  bareSeen.delete(tableId);
  // (The sweep's watch of the round under way, started as the forgery came,
  // goes too: a forgery again in the same round is watched afresh.)
  legacySeen.delete(tableId);
  transactCasino(() => writeComputedOff(tableId));
  return true;
}

/**
 * One operator tick for one table. Idempotent per frame — only writes on a real
 * transition. The window ARMS on the first bet (so an empty table stays quiet),
 * then betting → closing → settled → next round on the deadlines. Call ONLY when
 * canRunCroupier() and takeTableTurn() (the caller gates), else two clients
 * race the settle.
 */
export function tickAutoCroupier(tableId: string): void {
  // 📒 Not on a doc holding part of another page's update (casinoWhole): a
  // state it rewrote reads as gone, and a table read as gone opens anew.
  if (!casinoWhole(tableId)) return;
  const now = Date.now();
  // 🧮 A computed table runs itself: the robot only clears away an owner-run
  // round an earlier build opened there (sweepLegacyRound). So too while its
  // switch is lost, until the room puts it back (or compaction ends it). A
  // switch nothing stands behind it drops (dropBareSwitch).
  if (isComputedTable(tableId) || computedSwitchLost(tableId)) {
    if (!dropBareSwitch(tableId, now)) sweepLegacyRound(tableId, now);
    return;
  }
  // A state that doesn't go on from the table's book: the book's goes back
  // up first (putTableBack).
  if (putTableBack(tableId)) return;
  const s = readTableState(tableId);
  if (!s) {
    openBetting(tableId, 1);
    return;
  }
  if (s.phase === 'closing' && s.operator !== undefined && s.operator !== ROULETTE_PAGE_ID) {
    // A SPIN another page pressed: that page settles it. Only once the round
    // has sat for SPIN_TAKEOVER_MS (that page is gone) does the robot take it
    // over and finish it.
    if (now - spinSeenAt(tableId, s, s.operator, now) >= SPIN_TAKEOVER_MS) {
      writeTableState(tableId, { ...s, operator: ROULETTE_PAGE_ID });
    }
    return;
  }
  const span = s.phase === 'betting' ? BET_WINDOW_MS : s.phase === 'closing' ? CLOSING_MS : SHOW_MS;
  const deadline = timerOnThisClock(s, span, now);
  if (deadline !== s.phaseDeadline) {
    writeTableState(tableId, { ...s, phaseDeadline: deadline });
    return;
  }
  if (s.phase === 'betting') {
    if (s.phaseDeadline == null) {
      // Arm the clock the moment the first chip is on the felt.
      if (Object.keys(readAllBets(tableId, s.round)).length > 0) {
        writeTableState(tableId, { ...s, phaseDeadline: now + BET_WINDOW_MS });
      }
    } else if (now >= s.phaseDeadline) {
      closeBetting(tableId, s, CLOSING_MS);
    }
  } else if (s.phase === 'closing') {
    if (now >= (s.phaseDeadline ?? now)) rollAndSettle(tableId, s.round, SHOW_MS);
  } else if (s.phase === 'settled') {
    if (s.phaseDeadline != null && now >= s.phaseDeadline) {
      openBetting(tableId, s.round + 1);
    }
  }
}

/**
 * ⏱ A phase deadline is the clock of the page that wrote it, and the page
 * driving now may run far behind it (another of the owner's devices took the
 * tables over): one further off than the whole phase is cut back to the
 * phase's length on this clock, so no round waits on another clock. A round
 * settled by hand (a SPIN on a page not driving, before the robot's first
 * beat) gets its show beat, so the robot opens the next. Otherwise the
 * deadline as it is (none on an idle betting window).
 */
export function timerOnThisClock(
  s: { phase: 'betting' | 'closing' | 'settled'; phaseDeadline?: number },
  spanMs: number,
  now: number,
): number | undefined {
  if (s.phaseDeadline != null && s.phaseDeadline > now + spanMs) return now + spanMs;
  if (s.phase === 'settled' && s.phaseDeadline == null) return now + spanMs;
  return s.phaseDeadline;
}

// ── Heartbeat (operator liveness, for the UI + narration) ─────────────────────

/**
 * Tear a table down cleanly on removal from a room. Safe to call on any client.
 * Stakes held on the felt go back to their players as the lists go. The REFUND
 * of what an earlier build's lists took on an unresolved round (once the
 * records vanish there is no other credit-back path) runs on every page that
 * hears of the removal, manual rooms too, and counts once however many run it
 * (creditTableOutcome); every client then wipes the table's casino keys
 * (idempotent LWW delete) so no orphan records survive.
 */
export function closeTable(tableId: string, closing: TableClosing = 'heard'): void {
  // One transaction: no page sees the refunds without the table gone.
  closeWhenWhole(tableId, () => transactCasino(() => refundAndClear(tableId, closing)));
}

/** 📒 A table's removal, on a doc holding every update whole (casinoWhole):
 *  its refunds read the table's lists and book, and a table read as gone
 *  there would end an incarnation that isn't up. One heard meanwhile waits
 *  for the rest, and is dropped if the table is back in the room by then
 *  (put back: its opening clears what the removal left, tableOpening). */
export function closeWhenWhole(tableId: string, close: () => void): void {
  let now = true;
  whenCasinoWhole(`close:${tableId}`, () => {
    if (now || !tableInRoom(tableId)) close();
  }, tableId);
  now = false;
}

/** A table's removal: each list's held stake goes back with it, and what an
 *  earlier build's list took, each page refunds (tableEndingStakes),
 *  whichever heard of the removal first, while the page driving it may be
 *  settling this very round: a bettor's refund counts unless the doc kept
 *  that settle's book, which settled their list (creditTableOutcome). Then
 *  the keys go (clearTableKeys; `keepComputed`: a computed table's own
 *  incarnation stays, for the sweep of an owner-run round on it). */
export function refundAndClear(tableId: string, closing: TableClosing, opts: { keepComputed?: boolean } = {}): void {
  const end = tableEndingStakes(tableId);
  for (const [pid, taken] of Object.entries(end?.taken ?? {})) creditTableOutcome(tableId, end!.inc, 'end', pid, taken);
  clearTableKeys(tableId, closing, opts);
}

export function beatCroupier(tableId: string): void {
  writeCroupierBeat(tableId, Date.now());
}

/** Is a robot croupier actively running this table right now? */
export function isCroupierLive(tableId: string): boolean {
  const beat = readCroupierBeat(tableId);
  return beat != null && Date.now() - beat < HEARTBEAT_STALE_MS;
}

// ── Narration ─────────────────────────────────────────────────────────────────

/** The croupier's call for the current state, plus a once-per-round-per-phase
 *  `key` for edge-detection (so each beat pops exactly one bubble per client).
 *  null between beats (idle betting, mid-animation nothing-new). */
export function croupierBeatLine(
  s: RouletteTableState,
): { key: string; text: string } | null {
  if (s.phase === 'betting' && s.phaseDeadline != null) {
    return { key: `${s.round}:open`, text: '🎲 Place your bets!' };
  }
  if (s.phase === 'closing') {
    return { key: `${s.round}:close`, text: '✋ No more bets!' };
  }
  if (s.phase === 'settled' && s.result != null) {
    const paid = s.payouts != null && Object.keys(s.payouts).length > 0;
    const col = pocketColor(s.result).toUpperCase();
    return {
      key: `${s.round}:settle`,
      text: `🎡 ${s.result} ${col} — ${paid ? 'winners paid!' : 'house wins'}`,
    };
  }
  return null;
}
