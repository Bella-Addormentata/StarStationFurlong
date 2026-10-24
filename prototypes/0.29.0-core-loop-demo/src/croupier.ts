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
 */

import {
  casinoDocEpoch,
  clearTableKeys,
  creditTableOutcome,
  feltStake,
  readAllBets,
  readCroupierBeat,
  readFeltStakes,
  readTableOperatorLease,
  readTableState,
  tableIncFor,
  transactCasino,
  writeCroupierBeat,
  writeTableOperatorLease,
  writeTableState,
} from './casinoDoc';
import type { TableOperatorLease } from './casinoDoc';
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
  }
}

/** Nobody of this player's is driving: no lease, a lapsed one, or one an
 *  earlier deed holder's page left. */
function leaseIsFree(lease: TableOperatorLease | null, now: number, playerId: string): boolean {
  return !lease || lease.player !== playerId
    || (leaseSeen !== null && now - leaseSeen.at >= TABLE_LEASE_LAPSE_MS);
}

/** When this page last ran its tables, in this room doc, and the earliest it
 *  may act on them again after it stopped running them for a lapse. */
let tablesEpoch = -1;
let tablesRanAt: number | null = null;
let tablesFrom = 0;
/** How many times this page has woken from not running its tables. */
let tablesWakes = 0;

/**
 * This page is running its tables this frame (World calls it every frame the
 * room has tables, whoever drives them; takeTableTurn calls it too). A page
 * that stopped for a lapse or more (the computer slept, the tab froze) may
 * wake on a doc that hasn't heard another page take its tables over
 * meanwhile, and a settle written on that doc would overwrite the other
 * page's rounds when the two meet (creditTableOutcome keeps one running
 * record per table and player). So it waits out a lapse again, acting on no
 * table, for the doc to catch up (tablesAwake). A page cut off from the room
 * while it keeps running can't tell, and the computed tables end that case.
 */
export function noteTablesRunning(now = Date.now()): void {
  const epoch = casinoDocEpoch();
  if (epoch !== tablesEpoch) {
    tablesEpoch = epoch;
    tablesRanAt = null;
    tablesFrom = 0;
  }
  if (tablesRanAt !== null && now - tablesRanAt >= TABLE_LEASE_LAPSE_MS) {
    tablesFrom = now + TABLE_LEASE_LAPSE_MS;
    tablesWakes += 1;
  } else if (tablesRanAt !== null && now < tablesRanAt) {
    // The clock went back (a correction after a jump ahead, a manual
    // change): the wait it set runs a lapse from now at most, not until the
    // clock comes round again.
    tablesFrom = Math.min(tablesFrom, now + TABLE_LEASE_LAPSE_MS);
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
 *  while it waits out a lapse after it stopped running them, nor once a
 *  lapse has gone by since it last ran them: a settle resuming from its
 *  awaits after a sleep, before the page's next frame. A page that hasn't
 *  run them in this doc yet may. */
export function tablesAwake(now = Date.now()): boolean {
  if (tablesRanAt === null || casinoDocEpoch() !== tablesEpoch) return true;
  return now >= tablesFrom && now - tablesRanAt < TABLE_LEASE_LAPSE_MS;
}

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
  if (lease?.page !== pageId) {
    if (!leaseIsFree(lease, now, playerId)) return false;
    writeTableOperatorLease({ page: pageId, player: playerId, beat: 1 });
    leaseClaimedAt = now;
    leaseRenewedAt = now;
    return false;
  }
  if (leaseClaimedAt === null) leaseClaimedAt = now;
  if (now - leaseRenewedAt >= TABLE_LEASE_RENEW_MS) {
    writeTableOperatorLease({ ...lease, beat: lease.beat + 1 });
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
  // The hashing yielded: settle only the very round this call was for, in the
  // same room doc (a removed or recreated table, or a rival settle, is not).
  const before = readTableState(tableId);
  if (casinoDocEpoch() !== epoch || before?.phase !== 'closing' || before.round !== round) return;
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
  // (A void round produced no pocket, so nobody's reveal mattered: no forfeits.)
  if (!voided) for (const pid of forfeited) delete bets[pid];
  const payouts = result === null ? {} : resolveRound(bets, result);
  // 🪙 What the round does to each bettor's chips (casinoDoc STAKES ON THE
  // FELT). A list stops holding its chips as the round ends, so the settle
  // takes what it held and pays what it won. What an earlier build's list
  // took isn't held: its win is paid in full, and a stake the round gives
  // back is refunded.
  // Every bettor, and every list that hands back what an earlier build took
  // (one taken all down holds below 0 and isn't among the live bets).
  const owed: Record<string, number> = {};
  for (const pid of new Set([...Object.keys(live), ...rewritten, ...Object.keys(readFeltStakes(tableId))])) {
    const held = heldAtClose(tableId, before, pid);
    let delta: number;
    // A bet that missed the freeze (it arrived just after "no more bets"),
    // or any bet on a void round, goes back to its bettor: what it held is
    // released as the round ends, and what was taken of it is refunded.
    if (omitted.includes(pid) || (voided && !rewritten.includes(pid))) delta = feltStake(tableId, pid).taken;
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
    writeTableState(tableId, {
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
    // One change per bettor for the round, counted once however many pages
    // settle it (creditTableOutcome).
    for (const [pid, amount] of Object.entries(owed)) creditTableOutcome(tableId, before.inc ?? '', round, pid, amount);
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
  writeTableState(tableId, {
    kind: 'roulette',
    phase: 'betting',
    round,
    result: null,
    resultAt: 0,
    payouts: null,
    ...(isFairTable(tableId) ? { houseCommit: newHouseCommit(tableId, round) } : {}),
    inc: readTableState(tableId)?.inc ?? tableIncFor(tableId),
  });
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
    && seen.operator === operator) {
    return seen.at;
  }
  spinSeen.set(tableId, { epoch, wake, inc: s.inc, round: s.round, operator, at: now });
  return now;
}

/**
 * One operator tick for one table. Idempotent per frame — only writes on a real
 * transition. The window ARMS on the first bet (so an empty table stays quiet),
 * then betting → closing → settled → next round on the deadlines. Call ONLY when
 * canRunCroupier() and takeTableTurn() (the caller gates), else two clients
 * race the settle.
 */
export function tickAutoCroupier(tableId: string): void {
  const now = Date.now();
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
export function closeTable(tableId: string): void {
  // One transaction: no page sees the refunds without the table gone.
  transactCasino(() => {
    const s = readTableState(tableId);
    if (s && s.phase !== 'settled') {
      for (const [pid, { taken }] of Object.entries(readFeltStakes(tableId))) {
        // A held stake goes back with its list. What an earlier build's list
        // took, each page refunds, whichever heard of the removal first, and
        // the page driving it may be settling this very round: the table's
        // one outcome per bettor pays one.
        if (taken > 0) creditTableOutcome(tableId, s.inc ?? '', 'end', pid, taken);
      }
    }
    clearTableKeys(tableId);
  });
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
