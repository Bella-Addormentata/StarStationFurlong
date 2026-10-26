/**
 * 🧮🎡 Computed roulette — this page's part (PR 2 of "Computed casino tables").
 *
 * A computed table has nobody in charge. Every page folds the same records
 * into the same rounds (computedFold.ts, counted by casinoDoc), and each one
 * does its share of moving the table along, on its own clock, from what it
 * has seen: it writes its player's slips, closes betting in its turn,
 * reveals its seeds, forfeits seeds that came too late, voids a round nobody
 * can finish, and puts back its own records when they go missing, and those
 * of rounds it played whose authors may have left (tickComputedTables). It
 * also reads the table's phase off the fold and its own clock, in the shape
 * the felt already draws (readComputedRoulette): no page writes a phase, so
 * no two pages can disagree about one for long, and none can stall the table
 * by leaving.
 *
 * THIS PAGE'S CLOCK. Every timer here runs from when this page first saw
 * something (seen): casinoDoc stamps each record as it arrives, and the first
 * time a duty or the view asks, the stamp is clamped to the page's clock as
 * it is now (a stamp later than now reads as now) and to its last wake (a
 * stamp from before the computer slept reads as the wake), then kept. A wake
 * (croupier tablesWakeCount), or a clock gone back by a second or more,
 * forgets every first-seen time, so a timer whose wait spanned a sleep starts
 * again from the wake: no page forfeits a seed it might have heard while it
 * slept, nor closes a window it never watched. The other side of that: what
 * a page found on waking (or on loading) reads as seen all at once, so of a
 * round decided meanwhile it can't tell which seeds came in time. It answers
 * no forfeit of a close it didn't watch come in, forfeits no void of one,
 * and flags no seed dropped (watchedClose): a seed that came minutes late
 * must not undo a round every page has shown.
 *
 * THE PHASES, first that applies: a chosen close still undecided is
 * "closing" (no more bets, waiting for seeds); a round a forfeit decided is
 * still "closing" until every page could have seen the late seeds (the grace
 * and a second more); a decided round is "settled" for SHOW_MS from when this
 * page saw it decided; then "betting" on the next round, whose window arms on
 * the first chip seen and runs BET_WINDOW_MS from then (or from the end of
 * the show, if later). A window that runs out with nothing on the felt
 * (every chip taken down) arms again on the next chip.
 *
 * THE DUTIES take turns by dutyRank: each due time adds STAGGER_MS per page
 * ranked ahead, so the best-ranked page online acts first and the rest stand
 * down once its record arrives (the fold picks one among rivals anyway).
 * Only a reveal runs on a doc holding part of an update, or on a page waiting
 * out a wake: a seed never hurts, and a page that holds one back forfeits.
 * Everything else waits for a whole doc, an awake page and checked
 * signatures (casinoWhole, tablesAwake, computedSettled), as a PR 1 settle
 * does. Every record this page signs is marked checked before it is written
 * (markComputedVerdict), so the recount never spends time on it.
 *
 * WHEN THE AUTHOR HAS LEFT. Any page can delete any record (the honest-client
 * model), and on a table players come and go, the author of a record is
 * often gone. Two things follow, and each has its answer. A round's close
 * deleted after its seeds went out leaves no page able to close the round
 * again (a seed out stands the close down): the stand-down lasts ABANDON_MS
 * from when this page first saw it (seedOutAt), then the round closes
 * afresh in turn, on fresh seeds (no commitment out is frozen again; the old
 * reveals open nothing the new close froze). And a record a decided round's
 * count rests on deleted after its result showed would undo the round, or
 * decide it otherwise, chips moving after the result was shown: so a page
 * whose player played the round keeps a copy of what it rests on (a WITNESS
 * copy), puts it back in its turn after the author's, and decides nothing
 * of the round again meanwhile (no forfeit, no answer, no abandon, nor a
 * trim past it); a page that only watched it trims nothing short of it for
 * MISSING_WAIT_MS, its witnesses' turns. Of a round still closing, or one
 * whose result waits (a forfeit's hold), only the frozen slips: nothing the
 * table decides moves past a slip its close froze, and one lost takes its
 * bettor out of the round, or undoes a forfeit that counted it (none comes
 * twice: the abandon would void it). The rest is the table's to decide
 * until the result shows, deletes and all (the seed-out stand-down, the
 * forfeit, the answer), and a copy taken then could only bring back what
 * the table has moved past. A trim makes what it covers final, copies and
 * all, and what a page saw played that the room didn't keep, it lets go of.
 *
 * TRIMS keep the doc small: once the last decided round shows, a page that
 * played it swaps the session (when it is long, heavy, or idle) for a
 * checkpoint of the nets so far and a fresh session holding the open
 * round's felts, in one transaction, so nobody's chips move. What this page
 * wrote of rounds the checkpoint covers it lets go of, seeds and all, and so
 * of rounds it saw played past it that the new session doesn't hold (the
 * other side of a split, or a trim that hadn't heard of them): those are
 * void, and put back they would only be played again. A table's ended
 * incarnation (removed, or switched off) is compacted the same way into a
 * checkpoint that says it ended, whose nets go on counting.
 *
 * THE SWITCH. The house, with the dev flag (computedTablesEnabled), turns a
 * roulette table computed from its ⚙ card at a quiet point: one transaction
 * ends the owner-run incarnation as a removal does and opens the computed
 * one (switchComputedOn); not while an earlier build drives the room's
 * tables (the lease's `build`), which would go on opening owner-run rounds
 * there. Back once no round is under way (switchComputedOff): a final
 * checkpoint ends the incarnation, its nets count on, and open felts are
 * free again. A page leaving the room first takes its player's felts down
 * (leaveComputedTables): a felt left behind is frozen, and forfeited. Only
 * those two (and a removal) end an incarnation: a switch a peer takes away
 * the pages running the table put back (putSwitchBack), and one a peer
 * writes alone, naming nothing the doc holds, the house switches off.
 */

import {
  casinoDocEpoch,
  casinoRoomId,
  casinoWhole,
  computedEndedIncs,
  computedFoldOf,
  computedIncEnded,
  computedIncFor,
  computedIncOf,
  computedRoomBytes,
  computedSeenAt,
  computedSessionForWrite,
  computedSettled,
  computedVerdictOf,
  finalizeComputed,
  isComputedTable,
  markComputedVerdict,
  notifyCasinoView,
  putComputedSwitchBack,
  readAllBets,
  readChips,
  readCrapsTableState,
  readSeat,
  readSeats,
  readTableState,
  transactCasino,
  writeCheckpointAndTrim,
  writeComputedOff,
  writeComputedOn,
} from './casinoDoc';
import type { EndedComputed } from './casinoDoc';
import {
  abandonKey, asAbandon, asClose, asForfeit, asReveal, asSlip, canon, closeKey, dutyRank, forfeitKey, MAX_CHECKPOINT_PIDS,
  MAX_FROZEN, MAX_SLIP_BETS, parseKey, recHash, revealKey, seedTable, signBytes, slipCommit, slipKey,
} from './computedFold';
import type {
  AbandonRec, Checkpoint, CloseRec, Decision, FoldCtx, FoldResult, ForfeitRec, RecKind, RevealRec, RoundView, SignedKind,
  SlipRec,
} from './computedFold';
import {
  BET_WINDOW_MS, leaseIsOldBuild, refundAndClear, roomStateIn, SHOW_MS, TABLE_CLOCK_SLACK_MS, tablesAwake, tablesWakeCount,
} from './croupier';
import { forgetSeed, keepSeed, keyFor, REVEAL_GRACE_MS, seedFor } from './fairTableSeeds';
import type { TableSeedContext } from './games/diceFairness';
import { randomSeedHex } from './games/fairDice';
import { isRouletteBet } from './games/roulette';
import type { RouletteBet, RouletteTableState } from './games/roulette';
import { getPlayerId } from './identity';
import { getIdentityPub, signIdentity } from './keypair';

// ── ⏱ Timing ─────────────────────────────────────────────────────────────────

/** The betting window once the first chip is seen, and the show beat after a
 *  decided round: the owner-run table's (croupier.ts). */
export { BET_WINDOW_MS, SHOW_MS };
/** The least a frozen bettor's seed is waited for (fairTableSeeds.ts). */
export { REVEAL_GRACE_MS };
/** The most it is waited for, however late the seeds before it came. */
export const GRACE_MAX_MS = 10_000;
/** A seed seen inside the grace stretches it to this long after that seed. */
export const GRACE_PAD_MS = 1_500;
/** Each page ranked ahead for a duty puts this much on this page's turn. */
export const STAGGER_MS = 1_500;
/** A close nothing has decided for this long is voided (an abandon). */
export const ABANDON_MS = 30_000;
/** Felt changes within this of the last slip written are held, then one
 *  version goes for all of them. */
export const COALESCE_MS = 300;
/** A held felt goes at once from this long before the window's deadline. */
export const FLUSH_BEFORE_MS = 1_000;
/** How often this page looks for its own records gone missing. */
export const REPUT_MS = 1_000;
/** A table's duties run at most this often. */
export const TICK_MS = 200;
/** Trim pressure: rounds since the checkpoint, bytes of the session, of the
 *  room's sessions, and the least a session must weigh to be trimmed for the
 *  room's sake. */
export const TRIM_ROUNDS = 20;
export const TRIM_BYTES = 96 * 1024;
export const ROOM_BYTES = 384 * 1024;
export const ROOM_MIN_BYTES = 24 * 1024;
/** No new record for this long is pressure to trim too. */
export const IDLE_MS = 60_000;
/** A page none of the last round's bettors is on trims after this idle. */
export const TRIM_FALLBACK_MS = 240_000;
/** A frozen slip missing this long no longer holds a trim back, nor does a
 *  round this page saw decided that a delete took off the chain (its
 *  witnesses, if any are left, have put it back by then). */
export const MISSING_WAIT_MS = 30_000;
/** An ended incarnation's sessions are compacted this long after the end is
 *  seen, or after the fallback on a page with no slip in them. */
export const COMPACT_MS = 10_000;
export const COMPACT_FALLBACK_MS = 60_000;

/** A round a forfeit decided shows its result this long after the grace on
 *  this page ran out: every page has seen the seeds it was going to see. */
const RESULT_AFTER_GRACE_MS = 1_000;
/** The first in line trims this long after it saw the round decided (once
 *  its result shows): the decision has reached the room by then. */
const TRIM_AFTER_DECIDED_MS = 1_000;
/** The close a final checkpoint names when the incarnation ended before any
 *  round of it was decided (the fold counts no round after an end anyway). */
const NO_CLOSE = '0'.repeat(32);

// ── 🕰 This page's clock ─────────────────────────────────────────────────────

/** What this page has written, by key: put back byte for byte when it goes
 *  missing from the live session (the re-put). */
interface Mine {
  r: number;
  kind: RecKind;
  rec: object;
  /** canon(rec): what the session must hold under its key to hold it (a
   *  peer can write anything under any key). */
  bytes: string;
}

/** One cached view of a table, valid for one fold result and one clock
 *  generation until `validUntil` (the next phase boundary on this clock). */
interface ViewEntry {
  res: FoldResult;
  gen: number;
  builtAt: number;
  validUntil: number;
  view: ComputedRouletteState;
  /** What a phase change looks like: phase, round, deadline, spin key. */
  key: string;
  /** The key of the first view built for this fold result: what listeners
   *  told of the result read (tellPhase). */
  firstKey: string;
  /** The last decided round (null for none), and whether it is on the live
   *  session's chain or only this page's copy from before a trim. */
  D: RoundView | null;
  onChain: boolean;
  /** The round whose frozen felts the view shows while closing. */
  holding: RoundView | null;
  bets?: Record<string, RouletteBet[]>;
  /** This page's player's part in the round shown (computedMine). */
  mine?: ComputedMine;
}

/** The session's keys, by kind, round and (slips, reveals) pid, read once per
 *  fold result: the duties look up records by them. */
interface Scan {
  res: FoldResult;
  gen: number;
  ses: Session | null;
  /** r → pid → keys */
  slips: Map<number, Map<string, string[]>>;
  reveals: Map<number, Map<string, string[]>>;
  /** r → keys */
  closes: Map<number, string[]>;
  forfeits: Map<number, string[]>;
  abandons: Map<number, string[]>;
  /** When this page first saw the newest record in the session (lastSeenOf;
   *  undefined until asked, null for none). */
  last?: number | null;
  /** Whether a seed of the open round is out (seedOut; undefined until asked). */
  seedOut?: boolean;
  /** The pubs of the session's checked slips (checkedSlipPubs). */
  slipPubs?: Set<string>;
}

/** A copy this page keeps of a record a round's count rests on (a witness
 *  copy): the value as the session held it, its bytes once asked for, and
 *  when this page first saw the session lose it (null while it holds it). */
interface Copy {
  v: object;
  bytes?: string;
  missingAt: number | null;
}

/** A round this page's player is frozen in (noteWitness): the records its
 *  count rests on, to put back. */
interface Witnessed {
  r: number;
  /** The pubs that signed its present frozen slips: the turn order. */
  pubs: Set<string>;
  /** key → copy: each present bettor's frozen slip, and once its result has
   *  shown, the close, the seed counted for each revealed one, the deciding
   *  forfeit or abandon; at most 2 × MAX_FROZEN + 2. */
  copies: Map<string, Copy>;
  /** Which copy is the deciding forfeit's or abandon's (one at a time). */
  decider: string | null;
  /** The round as last noted whole: nothing new while it reads the same. */
  noted: string;
}

/** For one close: when this page first saw, for each frozen bettor, the
 *  reveal that opens their frozen slip (revealsSeen), kept once seen — a
 *  peer's delete at the moment a forfeit falls due doesn't make a seed seen
 *  in time a late one — and the scan it last looked at. */
interface Opened {
  r: number;
  at: Map<string, number>;
  sc: Scan | null;
}

type Session = NonNullable<ReturnType<typeof computedSessionForWrite>>;

/** Everything this page keeps of one computed incarnation of a table. */
interface TableState {
  t: string;
  inc: string;
  ctx: FoldCtx;
  /** When this page first saw each session key, on its clock (seen). */
  seen: Map<string, number>;
  /** By `<close>|<decision>`: when this page saw that round decided, and for
   *  a forfeit, when its result may show (showStart). */
  decided: Map<string, { r: number; at: number; show?: number }>;
  mine: Map<string, Mine>;
  /** Commitments this page has revealed or seen revealed (→ their round):
   *  never frozen again, nor reused for a slip. */
  burned: Map<string, number>;
  /** A felt held back by the coalescing, for round r. */
  pending: { r: number; felt: RouletteBet[] } | null;
  /** The last round whose close came while a felt of this page's was held
   *  back, and froze another (the status bar's "too late"). */
  lateFelt: number | null;
  /** This page's last slip written: round and when. */
  lastSlip: { r: number; at: number } | null;
  /** A window that ran out with nothing on the felt arms again only on a
   *  chip seen from `at` on. */
  rearm: { r: number; at: number } | null;
  tickedAt: number | null;
  reputAt: number | null;
  /** The last decided round this page saw on the chain: what the felt
   *  shows once a trim has taken the round out of the session. */
  lastD: RoundView | null;
  lastRes: FoldResult | null;
  /** By how many chips the checkpoint that opened session `sid` differs
   *  from what this page had folded of those rounds. */
  cpDiff: { sid: string; chips: number } | null;
  scan: Scan | null;
  view: ViewEntry | null;
  /** The phase listeners were last told of, for one fold result. */
  told: { res: FoldResult; key: string } | null;
  /** The ⚙ card's verdict, kept for a round a trim takes out of the session. */
  check: { res: FoldResult; gen: number; out: ComputedRoundCheck | null } | null;
  lastCheck: ComputedRoundCheck | null;
  /** By close hash: when this page first saw that decided round with a
   *  frozen slip missing (a trim waits MISSING_WAIT_MS for it). */
  missingAt: Map<string, number>;
  /** By close hash: the seeds seen opening its frozen slips (revealsSeen). */
  opened: Map<string, Opened>;
  /** When this page first saw round r's close stand down for a seed out
   *  (seedOut, with no tip and no close in): it closes ABANDON_MS on. */
  seedOutAt: { r: number; at: number } | null;
  /** By close hash: the rounds this page witnesses (noteWitness), and a
   *  count bumped whenever a copy comes or goes. */
  witness: Map<string, Witnessed>;
  witnessVer: number;
  /** By close: the keys of the copies the live session has lost, as of one
   *  fold result (witnessLost). */
  lost: { res: FoldResult; gen: number; ver: number; out: Map<string, string[]> } | null;
  /** The last round this page saw decided on the chain of session `sid`,
   *  and when it first saw the chain fall short of it since (noteChain): a
   *  delete took a round it saw played off the chain, and a trim waits. */
  decidedTo: { sid: string; r: number } | null;
  shortAt: number | null;
  /** By round: the close this page last saw decide it on the live
   *  session's chain; and the last round this page saw that close replaced
   *  by one that came after the round's seeds were out (the ⚙ card's flag:
   *  a modified game rewriting a round it has seen the seeds of). */
  chainClose: Map<number, string>;
  replaced: number | null;
}

/** The binding the per-table state belongs to, the wake count and clock
 *  last looked at, the time of the last wake (0 before any), and a
 *  generation every cached view and scan carries (bumped on a wake). And
 *  from when casinoDoc's arrival stamps are arrivals this page watched: the
 *  first look with the room's state in on this binding (null before; what
 *  the doc held by then came all at once), and the last wake or clock gone
 *  back (the latest time stamped before it). */
const clock = {
  epoch: -1, wakes: 0, last: null as number | null, wakeAt: 0, gen: 0, inAt: null as number | null, realFrom: 0,
};
const tables = new Map<string, TableState>();
/** By `<tableId>:<inc>`: when this page first saw that incarnation ended
 *  with its sessions still in the doc (computedEndedIncs), on its clock. */
const endedAt = new Map<string, number>();
/** When compaction last looked (at most every TICK_MS). */
let compactedAt: number | null = null;

/** Look at this page's clock: a new binding starts every table afresh; a
 *  wake, or a clock gone back by TABLE_CLOCK_SLACK_MS or more, forgets every
 *  first-seen time (a timer whose wait spanned it starts again). */
function lookAtClock(now: number): void {
  const epoch = casinoDocEpoch();
  const wakes = tablesWakeCount();
  if (epoch !== clock.epoch) {
    // Another room's doc (or the same room's, bound again): what this page
    // wrote, saw and kept was of that binding.
    clock.epoch = epoch;
    tables.clear();
    endedAt.clear();
    compactedAt = null;
    clock.gen += 1;
    clock.inAt = null;
  }
  if (wakes !== clock.wakes || (clock.last !== null && clock.last - now >= TABLE_CLOCK_SLACK_MS)) {
    clock.wakeAt = now;
    // (Gone back: stamps up to the last time read were taken before it.)
    clock.realFrom = Math.max(now, clock.last ?? now);
    clock.gen += 1;
    for (const st of tables.values()) {
      st.seen.clear();
      st.decided.clear();
      st.rearm = null;
      st.missingAt.clear();
      st.opened.clear();
      st.seedOutAt = null;
      st.shortAt = null;
      // (A copy keeps its value: only when it went missing starts again.)
      for (const w of st.witness.values()) for (const copy of w.copies.values()) copy.missingAt = null;
    }
    endedAt.clear();
  }
  // What came with the room's state, or from the cache before it, came at
  // once; what comes from the first look with it in, as it happens.
  if (clock.inAt === null && roomStateIn(now)) clock.inAt = now;
  clock.wakes = wakes;
  clock.last = now;
}

/** Whether this page watched round's close come in: casinoDoc stamped it
 *  after the room's state was in on this binding, and after this page last
 *  woke or saw its clock go back. Only then are its first-seen times of the
 *  round's seeds the times they came. A page that slept through the close,
 *  or loaded after it, reads every record it found as seen at once, a seed
 *  that came minutes late as in time: from it, a forfeit counting that seed
 *  would rewrite a round every page has shown (and its own seed's lateness
 *  would choose, the result known, whether it counts). */
function watchedClose(st: TableState, round: RoundView): boolean {
  const raw = computedSeenAt(st.t, `c:${round.r}:${round.close}`);
  return raw !== undefined && clock.inAt !== null && raw > Math.max(clock.realFrom, clock.inAt);
}

/** When this page first saw session key `key` of table st, on its clock:
 *  casinoDoc's arrival stamp, read as now if later than now and as the last
 *  wake if before it, kept from the first ask on. */
function seen(st: TableState, key: string, now: number): number {
  let at = st.seen.get(key);
  if (at === undefined) {
    const raw = computedSeenAt(st.t, key);
    at = Math.min(now, Math.max(raw ?? now, clock.wakeAt));
    st.seen.set(key, at);
  }
  return at;
}

function newTable(t: string, inc: string): TableState {
  return {
    t, inc, ctx: { room: casinoRoomId(), t, inc },
    seen: new Map(), decided: new Map(), mine: new Map(), burned: new Map(),
    pending: null, lateFelt: null, lastSlip: null, rearm: null, tickedAt: null, reputAt: null,
    lastD: null, lastRes: null, cpDiff: null, scan: null, view: null, told: null, check: null, lastCheck: null,
    missingAt: new Map(), opened: new Map(), seedOutAt: null, witness: new Map(), witnessVer: 0, lost: null,
    decidedTo: null, shortAt: null, chainClose: new Map(), replaced: null,
  };
}

/** Table t's state and fold result, when it is a computed table casinoDoc
 *  has a result for. */
function tableOf(t: string): { st: TableState; res: FoldResult } | null {
  if (!isComputedTable(t)) return null;
  const inc = computedIncOf(t)!;
  const res = computedFoldOf(t);
  if (!res) return null;
  let st = tables.get(t);
  if (!st || st.inc !== inc) {
    // (A new incarnation: nothing of the last one's will be revealed now.)
    if (st) letGo(st, () => false);
    tables.set(t, st = newTable(t, inc));
  }
  noteResult(st, res);
  return { st, res };
}

/** The fold's result now, noted (the state of a duty after another wrote). */
function resultOf(st: TableState): FoldResult | null {
  const res = computedFoldOf(st.t);
  if (res) noteResult(st, res);
  return res;
}

/** The last decided round on the live session's chain, or null. */
function lastDecided(res: FoldResult): RoundView | null {
  for (let i = res.rounds.length - 1; i >= 0; i--) if (res.rounds[i].decided) return res.rounds[i];
  return null;
}

/** Keep what the fold said that a trim takes away: the last decided round
 *  (the felt shows it through the trim), and, when the session moves on, by
 *  how much the checkpoint differs from what this page had folded; what
 *  this page kept of rounds the checkpoint covers goes. */
function noteResult(st: TableState, res: FoldResult): void {
  const was = st.lastRes;
  if (was === res) return;
  if (was && was.base.sid !== res.base.sid) {
    st.cpDiff = { sid: res.base.sid, chips: checkpointDiff(was, res) };
    const u = res.base.u;
    for (const key of [...st.seen.keys()]) if ((parseKey(key)?.r ?? 0) <= u) st.seen.delete(key);
    for (const [id, e] of [...st.decided]) if (e.r < u) st.decided.delete(id);
    for (const [h, e] of [...st.opened]) if (e.r <= u) st.opened.delete(h);
    if (st.pending && st.pending.r <= u) st.pending = null;
    st.missingAt.clear();
    st.seedOutAt = null;
    // What a checkpoint covers is final, and what the next session doesn't
    // hold of the rounds it saw past it is void (below): no copy of any of
    // it goes into the next session, nor is a stand-down timed from it.
    if (st.witness.size > 0) {
      st.witness.clear();
      st.witnessVer += 1;
    }
    // Of what this page wrote, only its felt for the round after the
    // checkpoint goes on, and only if this page never saw that round closed
    // or the session holds it (the trim's copy): anything else is of a round
    // the checkpoint covers, or of one this page saw played past it that the
    // room didn't keep (the other side of a split, or a trim that hadn't
    // heard of it: void, its stakes back), and put back it would only be
    // played again. Closed: on the chain as this page last read it, or
    // decided on it at any time since the last checkpoint (playedTo) — a
    // peer's delete may have taken the round off the chain before the trim
    // came, and its seeds are out all the same.
    const lastClosed = Math.max(was.rounds.length > 0 ? was.rounds[was.rounds.length - 1].r : was.base.u, playedTo(st, was));
    const ses = computedSessionForWrite(st.t);
    letGo(st, (m, key) => m.r === u + 1 && (m.r > lastClosed || ses?.has(key) === true));
  }
  const D = lastDecided(res);
  if (D) st.lastD = D;
  st.lastRes = res;
  noteReplaced(st, res, was !== null && was.base.sid !== res.base.sid);
  // Every commitment this page has seen a reveal open stays burned for it,
  // the reveal gone or not (a peer's delete, a trim): its seed is out.
  let fresh: Set<string> | null = null;
  for (const c of res.revealedCommits) if (!st.burned.has(c)) (fresh ??= new Set()).add(c);
  if (fresh) {
    const sc = scanOf(st, res);
    for (const [r, byPid] of sc.slips) {
      for (const keys of byPid.values()) {
        for (const key of keys) {
          const s = asSlip(sc.ses?.get(key));
          if (s && fresh.has(s.c)) st.burned.set(s.c, r);
        }
      }
    }
  }
}

/** Note which close decides each round on the chain, and a round whose
 *  close this page saw decide it is replaced by one this page watched come
 *  in (watchedClose) after a seed that opens one of its frozen slips: a
 *  close no honest page writes (a closer stands down once a seed of the
 *  round is out), but the documented lever of a modified game, which
 *  outgrows the chain with a round it chose knowing the seeds. Flagged on
 *  the ⚙ card only. A session change starts the record afresh (what a
 *  checkpoint covers is final); the flag stays. */
function noteReplaced(st: TableState, res: FoldResult, moved: boolean): void {
  if (moved) st.chainClose.clear();
  let sc: Scan | null = null;
  for (const v of res.rounds) {
    if (!v.decided) continue;
    const was = st.chainClose.get(v.r);
    st.chainClose.set(v.r, v.close);
    if (was === undefined || was === v.close || !watchedClose(st, v)) continue;
    const closeAt = computedSeenAt(st.t, `c:${v.r}:${v.close}`)!;
    sc ??= scanOf(st, res);
    for (const pid of v.revealed) {
      const slip = frozenSlip(sc, v, pid);
      const out = slip !== null && (sc.reveals.get(v.r)?.get(pid) ?? []).some((key) => {
        const x = asReveal(sc!.ses?.get(key));
        const at = computedSeenAt(st.t, key);
        return x !== null && at !== undefined && at < closeAt && revealKey(x) === key && slipCommit(st.ctx, x.r, x.p, x.s) === slip.c;
      });
      if (out) {
        st.replaced = v.r;
        break;
      }
    }
  }
}

/** Σ |checkpoint net − what `was` had for the rounds it covers| over every
 *  player; 0 when `was` hadn't folded as far as the checkpoint goes (this
 *  page can't tell). */
function checkpointDiff(was: FoldResult, res: FoldResult): number {
  const u = res.base.u;
  if (!was.rounds.some((v) => v.decided && v.r === u)) return 0;
  const expect = new Map(was.base.n);
  for (const v of was.rounds) {
    if (!v.decided || v.r > u) continue;
    for (const [pid, d] of v.deltas) expect.set(pid, (expect.get(pid) ?? 0n) + d);
  }
  let diff = 0n;
  for (const pid of new Set([...expect.keys(), ...res.base.n.keys()])) {
    const d = (res.base.n.get(pid) ?? 0n) - (expect.get(pid) ?? 0n);
    diff += d < 0n ? -d : d;
  }
  return clampSafe(diff);
}

/** Let go of what this page wrote that `keep` doesn't keep, and of the seeds
 *  behind those slips but a kept one's (a slip's versions share one): nothing
 *  will reveal them now, and the seed store holds 256. */
function letGo(st: TableState, keep: (m: Mine, key: string) => boolean): void {
  const me = getPlayerId();
  const gone = new Map<string, number>();
  for (const [key, m] of [...st.mine]) {
    if (keep(m, key)) continue;
    st.mine.delete(key);
    if (m.kind === 's') gone.set((m.rec as SlipRec).c, m.r);
  }
  for (const m of st.mine.values()) if (m.kind === 's') gone.delete((m.rec as SlipRec).c);
  for (const [c, r] of gone) forgetSeed(c, seedCtx(st, r, me));
}

function clampSafe(n: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(n > max ? max : n < -max ? -max : n);
}

// ── 🔎 Reading the session ───────────────────────────────────────────────────

function pushIn<K>(m: Map<K, string[]>, k: K, key: string): void {
  const list = m.get(k);
  if (list) list.push(key);
  else m.set(k, [key]);
}

/** The live session's keys, sorted into kinds (one walk per fold result:
 *  any change to the session's keys is a new result). */
function scanOf(st: TableState, res: FoldResult): Scan {
  if (st.scan && st.scan.res === res && st.scan.gen === clock.gen) return st.scan;
  const ses = computedSessionForWrite(st.t);
  const sc: Scan = {
    res, gen: clock.gen, ses,
    slips: new Map(), reveals: new Map(), closes: new Map(), forfeits: new Map(), abandons: new Map(),
  };
  if (ses) {
    for (const key of ses.keys()) {
      const pk = parseKey(key);
      if (!pk) continue;
      if (pk.kind === 's' || pk.kind === 'x') {
        const at = pk.kind === 's' ? sc.slips : sc.reveals;
        let byPid = at.get(pk.r);
        if (!byPid) at.set(pk.r, byPid = new Map());
        pushIn(byPid, pk.pid!, key);
      } else {
        pushIn(pk.kind === 'c' ? sc.closes : pk.kind === 'f' ? sc.forfeits : sc.abandons, pk.r, key);
      }
    }
  }
  st.scan = sc;
  return sc;
}

/** When this page first saw the newest record in the session (null for an
 *  empty one): the table is idle from then on. Every record counts, of any
 *  kind, a rival's or one that reads invalid alike: a session growing is not
 *  an idle one. */
function lastSeenOf(st: TableState, sc: Scan, now: number): number | null {
  if (sc.last !== undefined) return sc.last;
  let last: number | null = null;
  const take = (keys: readonly string[]): void => {
    for (const key of keys) {
      const at = seen(st, key, now);
      if (last === null || at > last) last = at;
    }
  };
  for (const at of [sc.slips, sc.reveals]) for (const byPid of at.values()) for (const keys of byPid.values()) take(keys);
  for (const at of [sc.closes, sc.forfeits, sc.abandons]) for (const keys of at.values()) take(keys);
  sc.last = last;
  return last;
}

/** The slip a round froze for `pid`, as the session holds it. */
function frozenSlip(sc: Scan, round: RoundView, pid: string): SlipRec | null {
  const hash = round.frozen[pid];
  return hash === undefined ? null : asSlip(sc.ses?.get(`s:${round.r}:${pid}:${hash}`));
}

/** When this page first saw, for each frozen bettor whose seed has been in
 *  (round.revealed, now or on an earlier look), the reveal that opens their
 *  frozen slip — the one the fold counts (under its own key: one seed, one
 *  record, one key); a junk reveal beside it counts for nothing, nor
 *  stretches a grace. Kept once seen (a wake starts it again, as every
 *  first-seen time; a trim lets it go): a seed seen in time stays in time
 *  when a peer deletes it just as a forfeit falls due — the forfeit names
 *  it, and counts once its author puts it back. Looked at once per scan. */
function revealsSeen(st: TableState, sc: Scan, round: RoundView, now: number): Map<string, number> {
  let e = st.opened.get(round.close);
  if (!e) st.opened.set(round.close, e = { r: round.r, at: new Map(), sc: null });
  if (e.sc === sc) return e.at;
  e.sc = sc;
  const byPid = sc.reveals.get(round.r);
  for (const pid of round.revealed) {
    if (e.at.has(pid)) continue;
    const slip = frozenSlip(sc, round, pid);
    if (!slip) continue;
    for (const key of byPid?.get(pid) ?? []) {
      const x = asReveal(sc.ses!.get(key));
      if (!x || revealKey(x) !== key || slipCommit(st.ctx, x.r, x.p, x.s) !== slip.c) continue;
      e.at.set(pid, seen(st, key, now));
      break;
    }
  }
  return e.at;
}

/**
 * How long a close's seeds are waited for: REVEAL_GRACE_MS, stretched by
 * each seed seen inside it to GRACE_PAD_MS past that seed, GRACE_MAX_MS at
 * most. A seed seen once the grace has run out stretches nothing, so the
 * grace never reopens: a forfeit written at its end counted what it could.
 */
function graceOf(closeSeen: number, times: Iterable<number>): number {
  let grace = REVEAL_GRACE_MS;
  for (const at of [...times].sort((a, b) => a - b)) {
    if (at - closeSeen > grace) break;
    grace = Math.min(GRACE_MAX_MS, Math.max(grace, at - closeSeen + GRACE_PAD_MS));
  }
  return grace;
}

/** The frozen bettors of `round` a forfeit written now counts: those whose
 *  seed this page saw by the end of the grace, and always its writer. */
function countedBy(round: RoundView, times: ReadonlyMap<string, number>, until: number, me: string): string[] {
  return round.present.filter((pid) => pid === me || (times.get(pid) ?? Infinity) <= until);
}

/** This page's place for a duty among `pubs` (deduplicated), by dutyRank:
 *  the number of pubs when it isn't among them. */
function placeOf(duty: 'close' | 'forfeit' | 'abandon' | 'trim', ctx: FoldCtx, r: number, pubs: Iterable<string>, pub: string): number {
  const ranked = [...new Set(pubs)].map((k) => [dutyRank(duty, ctx, r, k), k] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const i = ranked.findIndex(([, k]) => k === pub);
  return i < 0 ? ranked.length : i;
}

/** The pubs that signed a round's present frozen slips. */
function frozenPubs(sc: Scan, round: RoundView): string[] {
  const out: string[] = [];
  for (const pid of round.present) {
    const s = frozenSlip(sc, round, pid);
    if (s) out.push(s.k);
  }
  return out;
}

/** Whether the session holds a record of `kind` at round r that this
 *  page's key signed and that `matches` (one of mine: the doc's word, so a
 *  reload knows too). A record: in its shape, of round r, under its own key,
 *  signed by `pub` (signedByMe). Junk that only carries the pub, or a record
 *  in shape that another key signed, is nobody's: taken for this page's own,
 *  one cheap write per pub would stand a duty down for good, and the table
 *  with it. */
function signedIn<R extends { r: number; k: string; g: string }>(
  st: TableState, sc: Scan, kind: 'close' | 'forfeit' | 'abandon', read: (v: unknown) => R | null,
  keys: Map<number, string[]>, r: number, pub: string, matches: (rec: R) => boolean,
): boolean {
  for (const key of keys.get(r) ?? []) {
    const v = sc.ses?.get(key);
    const rec = read(v);
    if (rec && rec.r === r && rec.k === pub && matches(rec) && signedByMe(st, kind, key, v as object, rec)) return true;
  }
  return false;
}

/** By session value: whether this page's key signed it (signedByMe). */
const ownSigned = new WeakMap<object, boolean>();

/** Whether this page's key signed `rec`, the value `v` under `key`: one this
 *  page wrote, or one that hashes to its key and whose signature by this
 *  page's pub checks out (casinoDoc's verdict when it has one, else this
 *  page signs the body again: an Ed25519 signature is deterministic, so its
 *  own key gives the same one). Once per value. */
function signedByMe(st: TableState, kind: SignedKind, key: string, v: object, rec: { k: string; g: string }): boolean {
  const m = st.mine.get(key);
  if (m && (m.rec === v || canon(v) === m.bytes)) return true;
  let ok = ownSigned.get(v);
  if (ok === undefined) {
    const h = parseKey(key)?.h;
    ok = h !== undefined && recHash(rec) === h
      && (computedVerdictOf(st.t, st.inc, h) ?? signIdentity(signBytes(kind, st.ctx, rec)) === rec.g);
    ownSigned.set(v, ok);
  }
  return ok;
}

/** Whether the slip `s` under `key` of incarnation `inc` of table `t` is a
 *  checked one: it hashes to its key and its signature checked out
 *  (casinoDoc's verdict: the fold checks what it counts, and this page's own
 *  records are marked). */
function checkedSlip(t: string, inc: string, key: string, s: SlipRec): boolean {
  const h = parseKey(key)?.h;
  return h !== undefined && computedVerdictOf(t, inc, h) === true && slipKey(s) === key;
}

/** The pubs of every checked slip in table st's session, of any round and
 *  any version (one a close left out too), once per scan. */
function checkedSlipPubs(st: TableState, sc: Scan): Set<string> {
  if (sc.slipPubs) return sc.slipPubs;
  const out = new Set<string>();
  for (const byPid of sc.slips.values()) {
    for (const keys of byPid.values()) {
      for (const key of keys) {
        const s = asSlip(sc.ses?.get(key));
        if (s && !out.has(s.k) && checkedSlip(st.t, st.inc, key, s)) out.add(s.k);
      }
    }
  }
  sc.slipPubs = out;
  return out;
}

/** Whether a seed of the open round o is out: a reveal of round o in the
 *  session opens one of the round's slips, a checked one signed by its
 *  player's pinned key — some close this page hasn't seen froze it. A reveal
 *  that opens nothing, or only junk, proves nothing, nor does a slip
 *  carrying another round's commitment (a revealed one is anyone's to copy):
 *  taken for proof, any of them would stall the table for anyone who wrote
 *  one. Once per scan. */
function seedOut(st: TableState, sc: Scan, o: number): boolean {
  if (sc.seedOut !== undefined) return sc.seedOut;
  sc.seedOut = false;
  const opened = new Set<string>();
  for (const [pid, keys] of sc.reveals.get(o) ?? []) {
    for (const key of keys) {
      const x = asReveal(sc.ses?.get(key));
      if (x && x.r === o && x.p === pid && revealKey(x) === key) opened.add(slipCommit(st.ctx, o, pid, x.s));
    }
  }
  if (opened.size === 0) return false;
  for (const [pid, keys] of sc.slips.get(o) ?? []) {
    const pin = keyFor(pid);
    for (const key of keys) {
      const s = asSlip(sc.ses?.get(key));
      if (s && opened.has(s.c) && s.k === pin && checkedSlip(st.t, st.inc, key, s)) return (sc.seedOut = true);
    }
  }
  return false;
}

/** A commitment no close of this page's may freeze: a reveal in the session
 *  opens it, or this page revealed it or saw it revealed. */
function burnedCommit(st: TableState, res: FoldResult, c: string): boolean {
  return res.revealedCommits.has(c) || st.burned.has(c);
}

/** The context this page's seed for round r opens under (slipCommit's bytes). */
function seedCtx(st: TableState, r: number, me: string): TableSeedContext {
  return { room: st.ctx.room, table: seedTable(st.ctx), round: r, party: me, house: '' };
}

// ── 🎡 Phases and the view ───────────────────────────────────────────────────

/** A computed table's state in the shape the felt draws a PR 1 table's in,
 *  plus its incarnation and the wheel's spin key: `<round>:<pocket>` of the
 *  last decided round once its result may show, '' otherwise. The wheel
 *  spins again only when the key changes, so an honest rival close with the
 *  same pocket spins nothing, and a rewritten round does. */
export interface ComputedRouletteState extends RouletteTableState {
  inc: string;
  spinKey: string;
}

/**
 * When the result of decided round D shows on this page: when it saw D
 * decided (the latest first-seen of the records that decided it: the close,
 * each counted slip and seed, the forfeit or abandon), or for a round a
 * forfeit decided, not before the grace on this page's clock and a second
 * more. Kept per close and decision; for D taken out of the session by a
 * trim (`onChain` false), what was kept, or now.
 */
function showStart(st: TableState, sc: Scan, D: RoundView, onChain: boolean, now: number): number {
  const id = `${D.close}|${D.decided}`;
  let e = st.decided.get(id);
  if (!e) {
    let at = now;
    if (onChain) {
      const opened = revealsSeen(st, sc, D, now);
      at = seen(st, `c:${D.r}:${D.close}`, now);
      for (const pid of D.counted) {
        at = Math.max(at, seen(st, `s:${D.r}:${pid}:${D.frozen[pid]}`, now), opened.get(pid) ?? at);
      }
      if (D.forfeit) at = Math.max(at, seen(st, `f:${D.r}:${D.forfeit.hash}`, now));
      if (D.abandon) at = Math.max(at, seen(st, `z:${D.r}:${D.abandon.hash}`, now));
    }
    st.decided.set(id, e = { r: D.r, at });
  }
  if (D.decided !== 'forfeit') return e.at;
  if (onChain) {
    const closeSeen = seen(st, `c:${D.r}:${D.close}`, now);
    const grace = graceOf(closeSeen, revealsSeen(st, sc, D, now).values());
    e.show = Math.max(e.at, closeSeen + grace + RESULT_AFTER_GRACE_MS);
  }
  return e.show ?? e.at;
}

/** When round o's betting window started on this page: the first chip seen
 *  (a version with something on it, signed by its player's pinned key; from
 *  a re-arm on, only one seen since), or the end of the last round's show if
 *  later. Null before any chip: the window isn't armed. */
function windowStart(st: TableState, sc: Scan, o: number, showEnd: number, now: number): number | null {
  const from = st.rearm && st.rearm.r === o ? st.rearm.at : -Infinity;
  let first = Infinity;
  for (const [pid, keys] of sc.slips.get(o) ?? []) {
    const pin = keyFor(pid);
    for (const key of keys) {
      const s = asSlip(sc.ses?.get(key));
      if (!s || s.b.length === 0 || s.k !== pin) continue;
      const at = seen(st, key, now);
      if (at >= from && at < first) first = at;
    }
  }
  return first === Infinity ? null : Math.max(first, showEnd);
}

function payoutsOf(D: RoundView): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pid, paid] of D.payouts) if (paid > 0n) out[pid] = clampSafe(paid);
  return out;
}

function build(st: TableState, res: FoldResult, now: number): ViewEntry {
  const sc = scanOf(st, res);
  const chain = lastDecided(res);
  const D = chain ?? (st.lastD && st.lastD.r === res.base.u ? st.lastD : null);
  const onChain = chain !== null;
  // The ⚙ card's verdict on D while its records are in the session: a trim
  // that takes them away leaves it (roundCheck), the card opened or not.
  if (onChain) checkOf(st, res, now);
  const show = D ? showStart(st, sc, D, onChain, now) : 0;
  // A forfeit's result waits out every page's grace.
  const held = D !== null && D.decided === 'forfeit' && now < show;
  let phase: RouletteTableState['phase'];
  let round: number;
  let holding: RoundView | null = null;
  let validUntil = Infinity;
  let deadline: number | undefined;
  if (res.tip) {
    phase = 'closing';
    round = res.tip.r;
    holding = res.tip;
  } else if (D && held) {
    phase = 'closing';
    round = D.r;
    holding = D;
    validUntil = show;
  } else if (D && now < show + SHOW_MS) {
    phase = 'settled';
    round = D.r;
    validUntil = show + SHOW_MS;
  } else {
    phase = 'betting';
    round = res.open;
    const showEnd = D ? show + SHOW_MS : 0;
    let start = windowStart(st, sc, round, showEnd, now);
    // Run out with every chip taken down: arm again on the next one, as an
    // owner-run table opens a fresh round after an empty one.
    if (start !== null && now >= start + BET_WINDOW_MS && ![...res.felts.values()].some((s) => s.rec.b.length > 0)) {
      st.rearm = { r: round, at: now };
      start = windowStart(st, sc, round, showEnd, now);
    }
    if (start !== null) {
      deadline = start + BET_WINDOW_MS;
      if (now < deadline) validUntil = deadline;
    }
  }
  const settled = phase === 'settled' && D !== null;
  const view: ComputedRouletteState = {
    kind: 'roulette',
    phase,
    round,
    result: settled ? D!.pocket : null,
    resultAt: settled ? show : 0,
    payouts: settled ? payoutsOf(D!) : null,
    ...(deadline !== undefined ? { phaseDeadline: deadline } : {}),
    ...(settled && D!.decided === 'void' ? { voided: true } : {}),
    inc: st.inc,
    spinKey: D && D.pocket !== null && !held ? `${D.r}:${D.pocket}` : '',
  };
  const key = `${phase}|${round}|${deadline ?? ''}|${view.spinKey}`;
  return { res, gen: clock.gen, builtAt: now, validUntil, view, key, firstKey: key, D, onChain, holding };
}

/** Table st's view at `now`: the cached one while the fold result and the
 *  clock generation are the same and no phase boundary has passed. */
function viewOf(st: TableState, res: FoldResult, now: number): ViewEntry {
  const e = st.view;
  if (e && e.res === res && e.gen === clock.gen && now >= e.builtAt && now < e.validUntil) return e;
  const next = build(st, res, now);
  if (e && e.res === res) next.firstKey = e.firstKey;
  st.view = next;
  return next;
}

/**
 * The state of computed table `t` on this page's clock, shaped as a
 * RouletteTableState (plus `inc` and `spinKey`): null when t isn't a
 * computed table or casinoDoc has counted nothing of it yet. Cached: O(1)
 * until the fold moves or the next phase boundary passes.
 */
export function readComputedRoulette(t: string, now = Date.now()): ComputedRouletteState | null {
  lookAtClock(now);
  const at = tableOf(t);
  return at ? viewOf(at.st, at.res, now).view : null;
}

/**
 * Each bettor's chips on the felt of round `round` as this page shows them:
 * while closing, the felts the close froze (the tip's, or a forfeit's round
 * while its result waits); while betting, each player's latest felt with
 * something on it; while settled, none (the felt reads empty, as an
 * owner-run table's does). Empty for any other round.
 */
export function readComputedBets(t: string, round: number, now = Date.now()): Record<string, RouletteBet[]> {
  lookAtClock(now);
  const at = tableOf(t);
  if (!at) return {};
  const e = viewOf(at.st, at.res, now);
  if (e.view.round !== round) return {};
  if (!e.bets) {
    const out: Record<string, RouletteBet[]> = {};
    if (e.view.phase === 'closing' && e.holding) {
      const sc = scanOf(at.st, e.res);
      for (const pid of e.holding.present) {
        const s = frozenSlip(sc, e.holding, pid);
        if (s) out[pid] = s.b;
      }
    } else if (e.view.phase === 'betting') {
      for (const [pid, s] of e.res.felts) if (s.rec.b.length > 0) out[pid] = s.rec.b;
    }
    e.bets = out;
  }
  return e.bets;
}

/** Player `me`'s chips on round `round`'s felt (readComputedBets), with the
 *  felt this page holds back to write (the coalescing) laid over it. */
export function readMyComputedBets(t: string, me: string, round: number, now = Date.now()): RouletteBet[] {
  const bets = readComputedBets(t, round, now);
  const st = tables.get(t);
  const p = st?.pending;
  if (p && p.r === round && me === getPlayerId() && st!.view?.view.phase === 'betting' && st!.view.view.round === round) {
    return p.felt;
  }
  return bets[me] ?? [];
}

/** What became of this page's player's slip in a decided round: frozen (it
 *  played, or a void handed it back), left out (the close didn't take the
 *  felt they had chips on, or named one the room never had: chips back),
 *  late (its seed came after the grace: forfeited), forfeited (no seed at
 *  all). A felt taken down before the close is none of these. */
export type MySlipFate = 'frozen' | 'left-out' | 'late' | 'forfeited';

/** What the ⚙ card says of the last decided round: how it was decided,
 *  whose seeds counted, and what this page saw that the room should know. */
export interface ComputedRoundCheck {
  round: number;
  decided: Decision;
  /** Seeds counted, of the bettors the close froze. */
  counted: number;
  of: number;
  /** Frozen bettors whose slip the room never had (never staked). */
  missing: string[];
  /** The forfeit's writer, as this page knows the key (display only). */
  forfeitBy: string | null;
  /** This page's player's slip, or null with none in the round. */
  mine: MySlipFate | null;
  /** 🚩 Bettors a forfeit left out whose seed this page saw in the grace. */
  dropped: string[];
  /** 🚩 Bettors whose frozen slip a key other than their pinned one signed. */
  pinMismatch: string[];
  /** 🚩 Chips by which the checkpoint opening this session differs from what
   *  this page had folded of those rounds (0: it agrees, or can't tell). */
  checkpointDiff: number;
  /** 🚩 The last round this page saw decided and then replaced by a close
   *  that came after its seeds were out (noteReplaced); absent for none. */
  replaced?: number;
}

const replacedOf = (st: TableState): { replaced?: number } => (st.replaced !== null ? { replaced: st.replaced } : {});

function roundCheck(st: TableState, res: FoldResult, now: number): ComputedRoundCheck | null {
  const D = lastDecided(res);
  const diff = st.cpDiff && st.cpDiff.sid === res.base.sid ? st.cpDiff.chips : 0;
  if (!D) {
    // A trim took the round out of the session: what this page said of it.
    const kept = st.lastCheck && st.lastCheck.round === res.base.u ? st.lastCheck : null;
    return kept ? { ...kept, checkpointDiff: diff, ...replacedOf(st) } : null;
  }
  const sc = scanOf(st, res);
  const me = getPlayerId();
  const F = D.forfeit?.rec;
  let mine: MySlipFate | null = null;
  if (D.present.includes(me)) {
    mine = D.decided === 'void' || D.counted.includes(me) ? 'frozen' : D.revealed.includes(me) ? 'late' : 'forfeited';
  } else if (D.frozen[me] !== undefined || (latestOwnSlip(st, sc, D.r, me, getIdentityPub())?.b.length ?? 0) > 0) {
    // (Left out: the close named a slip of theirs the room never had, or
    // left out the felt they had down. Not a felt they took down before it:
    // a close freezes felts with chips on, and theirs had none.)
    mine = 'left-out';
  }
  let dropped: string[] = [];
  // Only of a close stamped as it came (not before a wake: a load stamps it
  // with everything else) and seen before the forfeit: otherwise every seed
  // reads as seen with it, in time or not.
  const closeAt = computedSeenAt(st.t, `c:${D.r}:${D.close}`);
  if (F && closeAt !== undefined && closeAt > clock.realFrom) {
    const closeSeen = seen(st, `c:${D.r}:${D.close}`, now);
    if (closeSeen < seen(st, `f:${D.r}:${D.forfeit!.hash}`, now)) {
      const times = revealsSeen(st, sc, D, now);
      const until = closeSeen + graceOf(closeSeen, times.values());
      dropped = D.present.filter((pid) => !F.n.includes(pid) && (times.get(pid) ?? Infinity) <= until);
    }
  }
  const pinMismatch = D.present.filter((pid) => {
    const pin = keyFor(pid);
    const s = frozenSlip(sc, D, pid);
    return pin !== undefined && s !== null && s.k !== pin;
  });
  const out: ComputedRoundCheck = {
    round: D.r,
    decided: D.decided!,
    counted: D.counted.length,
    of: Object.keys(D.frozen).length,
    missing: D.missing,
    forfeitBy: F ? D.present.find((pid) => keyFor(pid) === F.k) ?? null : null,
    mine,
    dropped,
    pinMismatch,
    checkpointDiff: diff,
    ...replacedOf(st),
  };
  st.lastCheck = out;
  return out;
}

/**
 * The ⚙ card's verdict on computed table `t`'s last decided round (null for
 * none): how it was decided, seeds counted n of m, who was missing, the
 * forfeit's writer, what became of this page's slip, and the flags — a
 * forfeit dropped a seed this page saw in time, a frozen slip isn't signed
 * by its player's pinned key, the checkpoint differs from what this page saw,
 * a round this page saw decided was replaced after its seeds were out.
 */
export function computedRoundCheck(t: string, now = Date.now()): ComputedRoundCheck | null {
  lookAtClock(now);
  const at = tableOf(t);
  return at ? checkOf(at.st, at.res, now) : null;
}

/** Table st's round check for fold result `res`, once per result and clock
 *  generation. */
function checkOf(st: TableState, res: FoldResult, now: number): ComputedRoundCheck | null {
  if (!st.check || st.check.res !== res || st.check.gen !== clock.gen) {
    st.check = { res, gen: clock.gen, out: roundCheck(st, res, now) };
  }
  return st.check.out;
}

// ── ✍️ Writing ───────────────────────────────────────────────────────────────

/** Sign `body` (k already this page's pub) for the table and incarnation of `ctx`. */
function signed<T extends { k: string }>(ctx: FoldCtx, kind: SignedKind, body: T): T & { g: string } {
  return { ...body, g: signIdentity(signBytes(kind, ctx, body)) };
}

/** Write one record into the live session (looked up afresh: a trim replaces
 *  it), in a transaction of its own, and keep it to put back. A record this
 *  page signed is marked checked first, so the recount never checks it. */
function put(st: TableState, key: string, rec: object, r: number, isSigned: boolean): boolean {
  const ses = computedSessionForWrite(st.t);
  const pk = parseKey(key);
  if (!ses || !pk) return false;
  if (isSigned) markComputedVerdict(st.t, pk.h);
  transactCasino(() => ses.set(key, rec));
  st.mine.set(key, { r, kind: pk.kind, rec, bytes: canon(rec)! });
  return true;
}

/** Whether `ses` holds this page's record m under `key`, byte for byte. */
function holds(ses: Session, key: string, m: { rec: object; bytes: string }): boolean {
  const v = ses.get(key);
  return v === m.rec || (v !== undefined && canon(v) === m.bytes);
}

/** Write a version of this page's player's felt on round o: the commitment
 *  of their latest one when this page holds its seed and it isn't burned
 *  (unless `fresh`), else a new seed's; v one past every version of theirs
 *  the session holds (another tab's too, under the same key: the felt the
 *  fold counts is the highest checked one), and past every one this page
 *  wrote (a trim may have taken them out of the session: a version put back
 *  later must not read as newer than this one). */
function writeSlip(st: TableState, res: FoldResult, o: number, felt: RouletteBet[], fresh: boolean, now: number): boolean {
  const ses = computedSessionForWrite(st.t);
  if (!ses) return false;
  const me = getPlayerId();
  const pub = getIdentityPub();
  const cur = res.felts.get(me);
  let c: string | null = null;
  if (!fresh && cur && !burnedCommit(st, res, cur.rec.c) && seedFor(cur.rec.c, seedCtx(st, o, me)) !== null) c = cur.rec.c;
  if (c === null) {
    const seed = randomSeedHex();
    c = slipCommit(st.ctx, o, me, seed);
    keepSeed(c, seed);
  }
  // Only checked versions under this page's key: a version someone else
  // signed under this pid, or junk carrying this page's pub, can't push v
  // past the safe range and stop every write.
  let v = cur && cur.rec.r === o ? cur.rec.v : 0;
  for (const m of st.mine.values()) if (m.kind === 's' && m.r === o && (m.rec as SlipRec).v > v) v = (m.rec as SlipRec).v;
  const rec = signed(st.ctx, 'slip', { r: o, p: me, v: v + 1, b: felt, c, k: pub });
  const key = slipKey(rec);
  if (!key || !put(st, key, rec, o, true)) return false;
  st.lastSlip = { r: o, at: now };
  return true;
}

/** Whether a felt goes at once: the round's first from this page, past the
 *  coalescing since the last, or inside the last second of the window. */
function slipDue(st: TableState, o: number, deadline: number | undefined, now: number): boolean {
  const last = st.lastSlip;
  return !last || last.r !== o || now < last.at || now - last.at >= COALESCE_MS
    || (deadline !== undefined && now >= deadline - FLUSH_BEFORE_MS);
}

const sameFelt = (a: readonly RouletteBet[], b: readonly RouletteBet[]): boolean => canon(a) === canon(b);

/** The felt in the exact shape a slip carries: {type, amount}, plus `pick`
 *  for the bets that have one. Throws on anything a slip can't carry. */
function cleanFelt(felt: readonly RouletteBet[]): RouletteBet[] {
  if (!Array.isArray(felt) || felt.length > MAX_SLIP_BETS) throw new TypeError('writeComputedSlip: not a felt');
  return felt.map((b) => {
    if (!isRouletteBet(b)) throw new TypeError('writeComputedSlip: not a roulette bet');
    return b.type === 'straight' || b.type === 'dozen' || b.type === 'column'
      ? { type: b.type, pick: b.pick, amount: b.amount }
      : { type: b.type, amount: b.amount };
  });
}

/** Why `felt` may not go down for this page's player now, or null: a felt
 *  with chips when 31 other players have some on and this one has none
 *  ('full'), or more chips than they have past what their felt holds
 *  ('chips': readChips already takes that hold off). */
function refusal(res: FoldResult, me: string, felt: readonly RouletteBet[], holding: boolean): 'full' | 'chips' | null {
  const stake = felt.reduce((n, b) => n + b.amount, 0);
  if (stake > 0 && !holding) {
    let others = 0;
    for (const [pid, s] of res.felts) if (pid !== me && s.rec.b.length > 0) others += 1;
    if (others >= MAX_FROZEN) return 'full';
  }
  return stake - Number(res.held.get(me) ?? 0n) > readChips(me) ? 'chips' : null;
}

export type ComputedSlipWrite = 'ok' | 'reconnecting' | 'closed' | 'full' | 'chips';

/**
 * Put this page's player's whole felt down on computed table `t`'s open
 * round (an empty felt takes everything down). 'reconnecting' while the page
 * may not act on the table (asleep, a doc holding part of an update,
 * signatures to check, no live session to write into: a felt answered 'ok'
 * is written or held), 'closed' outside betting, 'full' and 'chips' as the
 * owner-run table refuses. The first felt of a round goes at once; changes
 * within COALESCE_MS of the last go as one version when the tick flushes
 * them (readMyComputedBets shows them meanwhile), and at once in the last
 * second of the window. Throws on a felt a slip can't carry.
 */
export function writeComputedSlip(t: string, felt: readonly RouletteBet[], now = Date.now()): ComputedSlipWrite {
  lookAtClock(now);
  if (!tablesAwake(now) || !casinoWhole(t) || !computedSettled(t)) return 'reconnecting';
  // (Not a computed table, or nothing counted of it yet: nothing to write to.)
  const at = tableOf(t);
  if (!at) return 'reconnecting';
  const { st, res } = at;
  const e = viewOf(st, res, now);
  if (e.view.phase !== 'betting') return 'closed';
  const o = e.view.round;
  const clean = cleanFelt(felt);
  // (A peer deleted the session, or junk sits in its place: neither this
  // felt nor a held one would land.)
  if (!computedSessionForWrite(t)) return 'reconnecting';
  const me = getPlayerId();
  const cur = res.felts.get(me);
  // A place at a full table is a written felt with chips on it: a held one
  // isn't on the table yet (the flush asks again).
  const refused = refusal(res, me, clean, (cur?.rec.b.length ?? 0) > 0);
  if (refused) return refused;
  if (!slipDue(st, o, e.view.phaseDeadline, now)) {
    st.pending = { r: o, felt: clean };
    return 'ok';
  }
  st.pending = null;
  if (!sameFelt(cur?.rec.b ?? [], clean) && !writeSlip(st, res, o, clean, false, now)) return 'reconnecting';
  return 'ok';
}

// ── 🧹 Duties ─────────────────────────────────────────────────────────────────

/**
 * Move computed tables `tableIds` along from this page (world.ts calls it
 * every frame with the room's roulette tables; each table runs at most every
 * TICK_MS): a switch a peer took away put back first (every frame), then its
 * reveals as soon as the room's state is in, then, on a whole doc, awake and
 * with every signature checked, the held felt, a burned commitment renewed,
 * the close, a forfeit, an answer to a forfeit, an abandon, the re-put and
 * the trim, each in its turn; and the compaction of any ended incarnation,
 * of these tables or not. A phase this page's clock alone moved on tells the
 * table's listeners once.
 */
export function tickComputedTables(tableIds: Iterable<string>, now = Date.now()): void {
  lookAtClock(now);
  for (const t of tableIds) {
    putSwitchBack(t, now);
    const at = tableOf(t);
    if (!at) continue;
    const { st } = at;
    if (st.tickedAt !== null && now >= st.tickedAt && now - st.tickedAt < TICK_MS) continue;
    st.tickedAt = now;
    tickTable(st, now);
    tellPhase(st, now);
  }
  // Ended incarnations, whatever tables were passed (a removed one isn't).
  compactDuty(getIdentityPub(), now);
}

/**
 * 🔀 Put back the switch of the incarnation this page runs at table `t` when
 * a peer has taken it away (or written junk, or a name the doc holds nothing
 * of, in its place) with nothing having ended the incarnation: no build does
 * that (the house's switch-off and a removal end it as the switch goes), and
 * while it lasts no page runs any duty there (tableOf), its reveals and
 * forfeits among them. A delete around a close would hold an honest seed
 * back past its grace (forfeited), or spare a withholder's stake (no forfeit
 * comes, and compaction voids the round). So every page that ran it puts it
 * back on its next frame (the same bytes from each), before any duty and
 * before compaction looks; on a whole doc, awake (casinoDoc
 * putComputedSwitchBack has the rest). A switch naming another incarnation
 * the doc holds records of stays: two of the house's pages switching on at
 * once, on docs that disagreed on the table's removals, name two, and the
 * doc keeps one (the other is compacted). Of the tables passed only: a
 * removed one is ended, and this page runs it no more.
 */
function putSwitchBack(t: string, now: number): void {
  const st = tables.get(t);
  if (!st || computedIncOf(t) === st.inc || !tablesAwake(now) || !casinoWhole(t)) return;
  transactCasino(() => putComputedSwitchBack(t, st.inc));
}

function tickTable(st: TableState, now: number): void {
  // Nothing at all before the room's state is in: the doc may be the room
  // cache's copy, and a seed revealed for a close the room has since
  // dropped is a seed out for nothing.
  if (!roomStateIn(now)) return;
  const me = getPlayerId();
  const pub = getIdentityPub();
  revealDuty(st, me);
  noteMissing(st, now);
  if (!casinoWhole(st.t) || !tablesAwake(now) || !computedSettled(st.t)) return;
  // (First: what a round rests on is kept before any duty reads it lost.)
  noteChain(st, now);
  noteWitness(st, me, now);
  flushDuty(st, me, now);
  recommitDuty(st, me, now);
  noteSeedOut(st, now);
  closeDuty(st, me, pub, now);
  forfeitDuty(st, me, pub, now);
  answerDuty(st, me, pub, now);
  abandonDuty(st, me, pub, now);
  reputDuty(st, me, now);
  witnessDuty(st, pub, now);
  // (The incarnation is live, and the table among those passed: tableOf.)
  trimDuty(st, pub, now);
}

/** Tell table st's listeners once of a phase this page's clock moved on: the
 *  view now against the one they were told of (the first built for this
 *  fold result, which casinoDoc told them of; or the last this told them). */
function tellPhase(st: TableState, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  const e = viewOf(st, res, now);
  if (!st.told || st.told.res !== res) st.told = { res, key: e.firstKey };
  if (e.key === st.told.key) return;
  st.told.key = e.key;
  notifyCasinoView(st.t);
}

/** 3. Reveal the seed behind every slip of this page's player a chosen close
 *  froze, decided or not, once and as soon as this page holds it: the round
 *  can't be counted without it, and a page that holds it back forfeits. The
 *  commitment is burned from then on. Runs on a partial doc too (the record
 *  is looked for in the session itself, so a stale count writes it once),
 *  and again whenever the session lacks it, deleted or written over. */
function revealDuty(st: TableState, me: string): void {
  const res = resultOf(st);
  const ses = computedSessionForWrite(st.t);
  if (!res || !ses) return;
  const sc = scanOf(st, res);
  for (const round of res.rounds) {
    if (!round.present.includes(me)) continue;
    const slip = frozenSlip(sc, round, me);
    const seed = slip && seedFor(slip.c, seedCtx(st, round.r, me));
    if (!slip || !seed) continue;
    st.burned.set(slip.c, round.r);
    if (round.revealed.includes(me)) continue;
    const rec: RevealRec = { r: round.r, p: me, s: seed };
    const key = revealKey(rec);
    // (In the session already, uncounted: a count that's stale. Anything
    // else under its key — a peer's junk — is no reveal: it goes again.)
    if (!key || holds(ses, key, { rec, bytes: canon(rec)! })) continue;
    put(st, key, rec, round.r, false);
  }
}

/** Whether table st reads betting on its open round now (the view: a show
 *  restarted by a wake holds writes back too). */
function bettingOn(st: TableState, res: FoldResult, now: number): ViewEntry | null {
  const e = viewOf(st, res, now);
  return !res.tip && e.view.phase === 'betting' && e.view.round === res.open ? e : null;
}

/** 1. Write the felt the coalescing held back, once COALESCE_MS have passed
 *  since the last, or in the window's last second; one for a round that has
 *  moved on is dropped, as is one the chip check now refuses. */
function flushDuty(st: TableState, me: string, now: number): void {
  const p = st.pending;
  const res = resultOf(st);
  if (!p || !res) return;
  if (res.tip || res.open !== p.r) {
    st.pending = null;
    // (The close came first, and froze the felt before it: too late.)
    const closed = res.rounds.find((v) => v.r === p.r);
    if (closed) {
      const frozen = closed.present.includes(me) ? frozenSlip(scanOf(st, res), closed, me)?.b ?? [] : [];
      if (!sameFelt(frozen, p.felt)) {
        st.lateFelt = p.r;
        if (st.view) st.view.mine = undefined;
      }
    }
    return;
  }
  const e = bettingOn(st, res, now);
  if (!e || !slipDue(st, p.r, e.view.phaseDeadline, now)) return;
  st.pending = null;
  const cur = res.felts.get(me);
  if (sameFelt(cur?.rec.b ?? [], p.felt)) return;
  if (refusal(res, me, p.felt, (cur?.rec.b.length ?? 0) > 0) !== null) return;
  writeSlip(st, res, p.r, p.felt, false, now);
}

/** 2. A felt of this page's player on the open round whose commitment is out
 *  (revealed for a close that didn't stand) goes again under a fresh seed:
 *  frozen again, its seed would be known before betting ends. Not on a
 *  round this page saw decided (noteChain), open again only because a
 *  peer's delete took a record it rests on: that felt was played, and goes
 *  back with the round (its witnesses' put-back) or nowhere (a trim past
 *  it voids it, and this page lets go of it: noteResult); under a fresh
 *  seed it would only be played again, by the re-close, or by the next
 *  session it was copied into. */
function recommitDuty(st: TableState, me: string, now: number): void {
  const res = resultOf(st);
  if (!res || res.open <= playedTo(st, res) || !bettingOn(st, res, now)) return;
  const cur = res.felts.get(me);
  if (!cur || cur.rec.b.length === 0 || !burnedCommit(st, res, cur.rec.c)) return;
  writeSlip(st, res, res.open, cur.rec.b, true, now);
}

/** When this page first saw the open round's close stand down for a seed
 *  out (seedOut, no tip, no close of the round in), on its clock: the
 *  stand-down's start, kept for that round (a close put back and deleted
 *  again doesn't start it over), and gone with every first-seen time on a
 *  wake or a clock gone back, and on a session change. Only while this page
 *  could close (the close duty's gates): its wait is a wait it watched. */
function noteSeedOut(st: TableState, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  const o = res.open;
  if (st.seedOutAt && st.seedOutAt.r !== o) st.seedOutAt = null;
  if (st.seedOutAt || res.tip || res.openCloses.some((c) => c.state !== 'invalid')) return;
  if (seedOut(st, scanOf(st, res), o)) st.seedOutAt = { r: o, at: now };
}

/**
 * 4. Close the open round's betting, in this page's turn among the players
 * with chips on it (dutyRank), BET_WINDOW_MS after the window started.
 * Stands down for a close of the round already in (valid, or still being
 * checked), or a close this page's key already signed on this parent (in
 * the doc, so a reload knows: signedIn); and for a seed of the round
 * already out (some close this page hasn't seen froze it: seedOut), until
 * ABANDON_MS after this page first saw it so (seedOutAt): a close deleted
 * after its seeds went out, by a peer, with its author gone, would else
 * hold the round and every felt on it for good. The round then closes
 * afresh, in the same turns: no commitment that is out is frozen again (its
 * player's felt goes under a fresh seed first: the re-commit), so the seeds
 * that came for the deleted close open nothing this one froze, and it
 * decides on fresh ones. Should the deleted close come back (its author
 * back, or a witness's copy), the fold picks one of the two by its chain
 * rule, and chips may move once: the split a delete makes, as a cut-off
 * room's. Freezes each player's latest felt with chips on it, but no burned
 * commitment, at most MAX_FROZEN, its own always, the rest earliest seen
 * first.
 */
function closeDuty(st: TableState, me: string, pub: string, now: number): void {
  const res = resultOf(st);
  const e = res && bettingOn(st, res, now);
  if (!res || !e || e.view.phaseDeadline === undefined) return;
  const o = res.open;
  const own = res.felts.get(me);
  if (!own || own.rec.b.length === 0 || burnedCommit(st, res, own.rec.c)) return;
  if (res.openCloses.some((c) => c.state !== 'invalid')) return;
  const sc = scanOf(st, res);
  if (signedIn<CloseRec>(st, sc, 'close', asClose, sc.closes, o, pub, (c) => c.q === res.parent)) return;
  const staked = [...res.felts.values()].filter((s) => s.rec.b.length > 0);
  const idx = placeOf('close', st.ctx, o, staked.map((s) => s.rec.k), pub);
  if (now < e.view.phaseDeadline + idx * STAGGER_MS) return;
  // (Seen just now, as this tick noted it: noteSeedOut.)
  if (seedOut(st, sc, o) && now < (st.seedOutAt?.at ?? now) + ABANDON_MS + idx * STAGGER_MS) return;
  const others = staked
    .filter((s) => s.rec.p !== me && !burnedCommit(st, res, s.rec.c))
    .map((s) => ({ s, at: seen(st, s.key, now) }))
    .sort((a, b) => a.at - b.at || (a.s.rec.p < b.s.rec.p ? -1 : 1));
  const f: Record<string, string> = { [me]: own.hash };
  for (const { s } of others.slice(0, MAX_FROZEN - 1)) f[s.rec.p] = s.hash;
  const rec = signed(st.ctx, 'close', { r: o, q: res.parent, f, k: pub });
  const key = closeKey(rec);
  if (key) put(st, key, rec, o, true);
}

/** This page's forfeit of `round`'s close, written now: n the bettors whose
 *  seed it saw in the grace, itself always. */
function writeForfeit(st: TableState, round: RoundView, n: string[], pub: string): void {
  const rec = signed(st.ctx, 'forfeit', { r: round.r, x: round.close, n, k: pub });
  const key = forfeitKey(rec);
  if (key) put(st, key, rec, round.r, true);
}

/**
 * 5. Forfeit the seeds that didn't come: for the undecided tip, and for a
 * round an abandon voided (any valid forfeit beats an abandon, so one
 * written early, by anyone, can't stop it) whose close this page watched
 * come in (watchedClose: back from a sleep or a load, the void stands — its
 * stakes are back, and a seed that came minutes late is no seed in time),
 * when this page's player is frozen in it with their seed in. Due at the end
 * of the grace on this page's clock plus its turn among the frozen bettors
 * (dutyRank); counts the seeds this page saw by then, there now or not.
 * Not when every seed is in with nothing missing (the reveals decide it),
 * nor twice for one close, nor for a round whose result this page showed
 * that reads otherwise only because a peer deleted what it rests on
 * (heldBack): decided again, it might count fewer seeds than it did, and a
 * forfeit outlives the put-back (it beats the reveals).
 */
function forfeitDuty(st: TableState, me: string, pub: string, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  const sc = scanOf(st, res);
  for (const round of res.rounds) {
    if (round.decided !== null && round.decided !== 'void') continue;
    if (!round.present.includes(me) || !round.revealed.includes(me)) continue;
    if (round.missing.length === 0 && round.revealed.length === round.present.length) continue;
    if (round.decided === 'void' && !watchedClose(st, round)) continue;
    if (heldBack(st, res, round.close, now)) continue;
    if (signedIn<ForfeitRec>(st, sc, 'forfeit', asForfeit, sc.forfeits, round.r, pub, (f) => f.x === round.close)) continue;
    const closeSeen = seen(st, `c:${round.r}:${round.close}`, now);
    const times = revealsSeen(st, sc, round, now);
    const until = closeSeen + graceOf(closeSeen, times.values());
    const idx = placeOf('forfeit', st.ctx, round.r, frozenPubs(sc, round), pub);
    if (now < until + idx * STAGGER_MS) continue;
    writeForfeit(st, round, countedBy(round, times, until, me), pub);
  }
}

/** 5b. Answer a forfeit that left out a seed this page saw in the grace,
 *  when its writer ranks after this page's player: this page's own forfeit
 *  with the fuller count — the forfeit's seeds and the ones it dropped —
 *  which then ranks first. Only when that count has this page's own seed in
 *  it (the forfeit counted it, or it was seen in time): a seed that came
 *  late would choose, the result known, whether it counts. Only of a close
 *  this page watched come in, and saw before the forfeit (watchedClose): a
 *  page back from a sleep or a load, or one that heard the close, its seeds
 *  and the forfeit all at once, can't tell a seed in time from one minutes
 *  late. Once the grace on this page's clock is over (its count is final),
 *  once per close. Not to a forfeit that decides a round this page showed
 *  only because a peer deleted the one that decided it (heldBack): that one
 *  goes back, and an answer to the other could outrank it. */
function answerDuty(st: TableState, me: string, pub: string, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  const sc = scanOf(st, res);
  for (const round of res.rounds) {
    const F = round.decided === 'forfeit' ? round.forfeit?.rec : undefined;
    if (!F || F.k === pub) continue;
    if (dutyRank('forfeit', st.ctx, round.r, F.k) <= dutyRank('forfeit', st.ctx, round.r, pub)) continue;
    if (heldBack(st, res, round.close, now)) continue;
    if (signedIn<ForfeitRec>(st, sc, 'forfeit', asForfeit, sc.forfeits, round.r, pub, (f) => f.x === round.close)) continue;
    if (!watchedClose(st, round)) continue;
    const closeSeen = seen(st, `c:${round.r}:${round.close}`, now);
    if (closeSeen >= seen(st, `f:${round.r}:${round.forfeit!.hash}`, now)) continue;
    const times = revealsSeen(st, sc, round, now);
    const until = closeSeen + graceOf(closeSeen, times.values());
    if (now < until) continue;
    const dropped = round.present.filter((pid) => !F.n.includes(pid) && (times.get(pid) ?? Infinity) <= until);
    if (dropped.length === 0) continue;
    const n = [...new Set([...F.n, ...dropped])].sort();
    if (n.includes(me)) writeForfeit(st, round, n, pub);
  }
}

/**
 * 6. Void the tip when nothing has decided it ABANDON_MS after this page saw
 * its close (every frozen bettor who could forfeit has gone): any page with
 * a record in the session or a seat at the table, in its turn among the
 * pubs of the session's checked slips (any round, any version: one a close
 * left out too) and the seated players' pinned keys (last when it is among
 * neither). Once per close. Not while a record the round rests on that this
 * page keeps a copy of is gone (heldBack: a round it showed that reads
 * undecided only because a peer deleted what it rests on, or a tip whose
 * frozen slip went): the copy goes back in a few seconds, and voided
 * meanwhile, the result shown would read void and back, and the abandon
 * would stay in the session to void the round at the next delete.
 */
function abandonDuty(st: TableState, me: string, pub: string, now: number): void {
  const res = resultOf(st);
  const tip = res?.tip;
  if (!res || !tip) return;
  const closeSeen = seen(st, `c:${tip.r}:${tip.close}`, now);
  if (now < closeSeen + ABANDON_MS) return;
  let wrote = false;
  for (const m of st.mine.values()) if (m.r > res.base.u) wrote = true;
  if (!wrote && readSeat(st.t, me) === null) return;
  if (heldBack(st, res, tip.close, now)) return;
  const sc = scanOf(st, res);
  if (signedIn<AbandonRec>(st, sc, 'abandon', asAbandon, sc.abandons, tip.r, pub, (z) => z.x === tip.close)) return;
  const pubs = new Set(checkedSlipPubs(st, sc));
  for (const pid of Object.keys(readSeats(st.t))) {
    const k = keyFor(pid);
    if (k) pubs.add(k);
  }
  const idx = placeOf('abandon', st.ctx, tip.r, pubs, pub);
  if (now < closeSeen + ABANDON_MS + idx * STAGGER_MS) return;
  const rec = signed(st.ctx, 'abandon', { r: tip.r, x: tip.close, k: pub });
  const key = abandonKey(rec);
  if (key) put(st, key, rec, tip.r, true);
}

/**
 * 7. Every REPUT_MS: put back, byte for byte, each record this page wrote
 * for a round past the checkpoint that the live session has lost (a peer's
 * delete or junk written over it, a write at the moment of a trim). Of its
 * slips, only the ones that still matter: its latest version of the round,
 * or one a close in the session froze; a latest version whose seed is out
 * goes again under a fresh seed instead (as the re-commit writes it), while
 * its round takes bets: put back as it was, a close that never saw the seed
 * could freeze it (a trim leaves its reveal behind). But not of a round
 * this page saw decided (the re-commit's rule: it was played). What a
 * checkpoint covers was let go of as it came (noteResult), seeds and all.
 */
function reputDuty(st: TableState, me: string, now: number): void {
  if (st.reputAt !== null && now >= st.reputAt && now - st.reputAt < REPUT_MS) return;
  st.reputAt = now;
  const res = resultOf(st);
  const ses = computedSessionForWrite(st.t);
  if (!res || !ses) return;
  const u = res.base.u;
  for (const [c, r] of [...st.burned]) if (r <= u) st.burned.delete(c);
  const latest = new Map<number, { v: number; key: string }>();
  for (const [key, m] of st.mine) {
    if (m.kind !== 's') continue;
    const v = (m.rec as SlipRec).v;
    const best = latest.get(m.r);
    if (!best || v > best.v || (v === best.v && key > best.key)) latest.set(m.r, { v, key });
  }
  const frozen = new Set<string>();
  for (const round of res.rounds) if (round.frozen[me] !== undefined) frozen.add(`s:${round.r}:${me}:${round.frozen[me]}`);
  for (const c of res.openCloses) if (c.rec.f[me] !== undefined) frozen.add(`s:${c.rec.r}:${me}:${c.rec.f[me]}`);
  for (const [key, m] of [...st.mine]) {
    // (Missing, or written over: junk under its key holds nothing of it.)
    if (holds(ses, key, m)) continue;
    if (m.kind === 's' && !frozen.has(key)) {
      if (latest.get(m.r)?.key !== key) continue;
      const slip = m.rec as SlipRec;
      if (burnedCommit(st, res, slip.c)) {
        if (m.r === res.open && m.r > playedTo(st, res) && bettingOn(st, res, now)) writeSlip(st, res, m.r, slip.b, true, now);
        continue;
      }
    }
    put(st, key, m.rec, m.r, m.kind !== 'x');
  }
}

// ── 👁 Witnesses ─────────────────────────────────────────────────────────────

/** Whether `ses` holds `copy` under `key`, byte for byte. The same bytes
 *  in a fresh value (another page's put-back, decoded here) are the record
 *  too: the copy takes that value, so the next look is a reference's. */
function heldIn(ses: Session, key: string, copy: Copy): boolean {
  const v = ses.get(key);
  if (v === copy.v) return true;
  if (v === undefined) return false;
  copy.bytes ??= canon(copy.v)!;
  if (canon(v) !== copy.bytes) return false;
  copy.v = v as object;
  return true;
}

/** Copy into `w` the value under `key` when it is the record the key names
 *  (`rec`: its kind's shape, under its own key). Inside the duties' gates
 *  the count is the doc as it is, so a counted key holds what was counted;
 *  looked at all the same, as junk is no record to put back, nor to mark
 *  checked. Whether `w` has it now. */
function keepCopy(w: Witnessed, ses: Session, key: string, rec: (v: unknown) => string | null): boolean {
  if (w.copies.has(key)) return true;
  const v = ses.get(key);
  if (rec(v) !== key) return false;
  w.copies.set(key, { v: v as object, missingAt: null });
  return true;
}

const closeOf = (v: unknown): string | null => { const c = asClose(v); return c && closeKey(c); };
const slipOf = (v: unknown): string | null => { const s = asSlip(v); return s && slipKey(s); };
const forfeitOf = (v: unknown): string | null => { const f = asForfeit(v); return f && forfeitKey(f); };
const abandonOf = (v: unknown): string | null => { const z = asAbandon(v); return z && abandonKey(z); };

/**
 * Keep a witness copy of what each round this page's player is frozen in
 * rests on, as the session held it (so only what the fold counted): each
 * present bettor's frozen slip from the round's close on, decided or not —
 * the close fixed it, and nothing the table decides moves past it, while
 * lost it takes its bettor out of the round (unstaked, its seed uncounted)
 * or undoes a forfeit that counted it, which no page writes twice (the
 * abandon would void it); and once the round's result has shown here
 * (showStart), the rest: the close, the seed the fold counts for each
 * revealed bettor (the one revealsSeen finds: under its own key, opening the
 * frozen slip), and the forfeit or abandon that decided it. Its own records
 * among them too: what goes back of those is its own re-put's (witnessDuty
 * skips them), but a round missing one is a round a delete moved all the
 * same (heldBack). Copies only gather: a record the round rested on that a
 * delete took away still goes back, though the round reads otherwise
 * without it. Only the decider changes hands, and only from one still in
 * the session (a better forfeit came, or a forfeit beat the void): one gone
 * is why the round reads otherwise, and it stays to go back. Not the close
 * of a round still closing, nor a seed or a decider before its result shows
 * (a forfeit's hold): until then the table decides it, deletes and all (a
 * close deleted with its seeds out closes afresh; a seed gone moves the
 * forfeit, and an answer may follow), and a copy would bring back what it
 * moved past.
 */
function noteWitness(st: TableState, me: string, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  let sc: Scan | null = null;
  for (const round of res.rounds) {
    if (!round.present.includes(me)) continue;
    sc ??= scanOf(st, res);
    const ses = sc.ses;
    if (!ses) return;
    let w = st.witness.get(round.close);
    const shown = round.decided !== null && now >= showStart(st, sc, round, true, now);
    const decider = !shown ? null
      : round.forfeit ? `f:${round.r}:${round.forfeit.hash}` : round.abandon ? `z:${round.r}:${round.abandon.hash}` : null;
    const noted = shown ? `${round.decided}|${round.present.length}|${round.revealed.length}|${decider ?? ''}` : `-|${round.present.length}`;
    if (w && w.noted === noted) continue;
    if (!w) st.witness.set(round.close, w = { r: round.r, pubs: new Set(), copies: new Map(), decider: null, noted: '' });
    const had = { size: w.copies.size, decider: w.decider };
    let whole = true;
    for (const pid of round.present) {
      const key = `s:${round.r}:${pid}:${round.frozen[pid]}`;
      if (keepCopy(w, ses, key, slipOf)) w.pubs.add((w.copies.get(key)!.v as SlipRec).k);
      else whole = false;
    }
    if (shown) {
      if (!keepCopy(w, ses, `c:${round.r}:${round.close}`, closeOf)) whole = false;
      for (const pid of round.revealed) {
        const keys = sc.reveals.get(round.r)?.get(pid) ?? [];
        if (keys.some((key) => w!.copies.has(key))) continue;
        const slip = w.copies.get(`s:${round.r}:${pid}:${round.frozen[pid]}`)?.v as SlipRec | undefined;
        const key = slip && keys.find((k) => {
          const x = asReveal(ses.get(k));
          return x !== null && revealKey(x) === k && slipCommit(st.ctx, x.r, x.p, x.s) === slip.c;
        });
        if (!key || !keepCopy(w, ses, key, (v) => { const x = asReveal(v); return x && revealKey(x); })) whole = false;
      }
      if (decider !== null && decider !== w.decider) {
        const old = w.decider === null ? undefined : w.copies.get(w.decider);
        if (!old || heldIn(ses, w.decider!, old)) {
          if (keepCopy(w, ses, decider, decider[0] === 'f' ? forfeitOf : abandonOf)) {
            if (w.decider !== null) w.copies.delete(w.decider);
            w.decider = decider;
          } else {
            whole = false;
          }
        }
      }
    }
    if (w.copies.size !== had.size || w.decider !== had.decider) st.witnessVer += 1;
    // (A record not found as counted is looked for again next time.)
    if (whole) w.noted = noted;
  }
}

/** Note the last round this page has seen decided on the live session's
 *  chain (inside the duties' gates: the doc whole, every signature checked),
 *  and when it first saw the chain fall short of it since. Without a delete
 *  it never does — records only come, and a rival chain takes the table only
 *  by outgrowing this one — so a round this page saw played has lost a
 *  record it rests on, and its witnesses put it back in their turns: until
 *  then no trim makes the shorter chain final (trimDuty), MISSING_WAIT_MS at
 *  most, and no felt of the round goes again (the re-commit). Timed on this
 *  page's clock (a wake starts it again); a session of its own (the next
 *  one starts from its checkpoint's round). */
function noteChain(st: TableState, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  const to = lastDecided(res)?.r ?? res.base.u;
  if (to >= playedTo(st, res)) {
    st.decidedTo = { sid: res.base.sid, r: to };
    st.shortAt = null;
  } else {
    st.shortAt ??= now;
  }
}

/** The last round this page saw decided on the chain of the session `res`
 *  reads (noteChain), or its checkpoint's. */
function playedTo(st: TableState, res: FoldResult): number {
  return st.decidedTo !== null && st.decidedTo.sid === res.base.sid ? st.decidedTo.r : res.base.u;
}

/** By close: the keys of the witness copies the live session has lost, or
 *  holds junk in the place of, each timed from when this page first saw it
 *  so (on its clock; a wake starts it again). Once per fold result: inside
 *  the duties' gates the session can't lose or regain a record without the
 *  fold moving. */
function witnessLost(st: TableState, res: FoldResult, now: number): Map<string, string[]> {
  const was = st.lost;
  if (was && was.res === res && was.gen === clock.gen && was.ver === st.witnessVer) return was.out;
  const ses = computedSessionForWrite(st.t);
  const out = new Map<string, string[]>();
  for (const [close, w] of st.witness) {
    for (const [key, copy] of w.copies) {
      if (ses && heldIn(ses, key, copy)) {
        copy.missingAt = null;
        continue;
      }
      copy.missingAt ??= now;
      pushIn(out, close, key);
    }
  }
  st.lost = { res, gen: clock.gen, ver: st.witnessVer, out };
  return out;
}

/** Whether this page holds back from deciding `close`'s round again: it
 *  showed its result, and the session has lost a record it rests on, which
 *  goes back (its author's re-put, or a witness's). */
function heldBack(st: TableState, res: FoldResult, close: string, now: number): boolean {
  return witnessLost(st, res, now).has(close);
}

/**
 * 7b. Put back, byte for byte, each witness copy the live session has lost
 * (a peer's delete, or junk over it), in this page's turn: REPUT_MS and
 * (1 + its place) × STAGGER_MS after it first saw it missing, its place
 * among the round's bettors by dutyRank('forfeit') — so the author, who
 * puts back its own within REPUT_MS, goes first, and the witnesses take
 * turns after (each stands down once one's write is in: it is held again).
 * Marked checked first, as the fold checked it when it counted it. Not a
 * record of its own (its re-put's), and only into the session it saw the
 * record in (a session change lets every copy go: noteResult). Every tick,
 * not on the re-put's beat: a turn is a tick late at most. With nothing
 * lost, a round off the chain that the chain has run past lost to a rival
 * chain outright (no delete moved it: none of what this page keeps is
 * missing), or to a close of its round made afresh (its own close, never
 * kept while it was closing, deleted with its seeds out), and its copies
 * go; a round off the chain because one before it
 * is gone, or for as long as anything this page keeps is, keeps them. Its
 * own records aside, there: they go back by its re-put, which lets go of
 * one the chain has stopped resting on (a burned felt off it), and copies
 * kept for one that never comes back would hold every trim back for good.
 */
function witnessDuty(st: TableState, pub: string, now: number): void {
  const res = resultOf(st);
  const ses = computedSessionForWrite(st.t);
  if (!res || !ses || st.witness.size === 0) return;
  const lost = witnessLost(st, res, now);
  if (![...lost.values()].some((keys) => keys.some((key) => !st.mine.has(key)))) {
    const on = new Set(res.rounds.map((v) => v.close));
    for (const [close, w] of [...st.witness]) {
      if (on.has(close) || res.open <= w.r) continue;
      st.witness.delete(close);
      st.witnessVer += 1;
    }
    return;
  }
  // (A record two rival rounds rest on goes once.)
  const done = new Set<string>();
  for (const [close, keys] of lost) {
    const w = st.witness.get(close)!;
    const turn = REPUT_MS + (1 + placeOf('forfeit', st.ctx, w.r, w.pubs, pub)) * STAGGER_MS;
    for (const key of keys) {
      const copy = w.copies.get(key)!;
      if (done.has(key) || st.mine.has(key) || now < copy.missingAt! + turn) continue;
      const pk = parseKey(key)!;
      if (pk.kind !== 'x') markComputedVerdict(st.t, pk.h);
      transactCasino(() => ses.set(key, copy.v));
      done.add(key);
    }
  }
}

/**
 * 8. Trim the session to a checkpoint, once its last decided round D shows
 * here, nothing is closed past it (no tip: a valid close for the open round
 * is the tip or decided, one still being checked leaves the table unsettled,
 * and one that reads invalid is junk the trim drops), and every frozen slip
 * of the session's rounds is in or has been missing MISSING_WAIT_MS — when
 * the session is long (TRIM_ROUNDS), heavy (TRIM_BYTES, or ROOM_MIN_BYTES
 * while the room's sessions pass ROOM_BYTES) or idle (IDLE_MS). In turn
 * among D's frozen bettors (dutyRank), from a second after this page saw D
 * decided; a page none of them is on only after TRIM_FALLBACK_MS idle. The
 * checkpoint holds the nets as the fold reads them, so on every page that
 * agreed nothing moves; the open round's felts go into the next session byte
 * for byte, but not one whose seed this page knows is out: in the next
 * session its reveal is gone, and a page that never saw it would freeze it
 * (its player puts the felt back under a fresh seed: the re-put). Two pages
 * trimming the same rounds write the same checkpoint but for its signer, so
 * they open the same session (nextSid leaves k and g out). Not while a
 * record a round rests on whose result this page showed is gone from the
 * session (witnessLost): trimmed then, the round would be final without it
 * (a close deleted, the round before it trimmed to, and the round itself
 * void), where its witness puts it back in a few seconds. Nor, for
 * MISSING_WAIT_MS, while the chain reads short of a round this page saw
 * decided (noteChain), copies or none: a page that only watched the round
 * keeps none, and trimmed by it the round would be void for good while its
 * witnesses wait their turns; if none of them is left by then, nobody can
 * put it back.
 */
function trimDuty(st: TableState, pub: string, now: number): void {
  // (Again: a round this tick's duties decided is seen missing now.)
  noteMissing(st, now);
  const res = resultOf(st);
  if (!res || res.tip) return;
  if (witnessLost(st, res, now).size > 0) return;
  if (st.shortAt !== null && now - st.shortAt < MISSING_WAIT_MS) return;
  for (const round of res.rounds) {
    const at = st.missingAt.get(round.close);
    if (round.missing.length > 0 && (at === undefined || now - at < MISSING_WAIT_MS)) return;
  }
  const D = lastDecided(res);
  if (!D) return;
  const sc = scanOf(st, res);
  // (Neither turn comes before D shows: the fallback's wait runs from the
  // last record, and D's show starts at most a grace after its close.)
  const show = showStart(st, sc, D, true, now);
  const last = lastSeenOf(st, sc, now) ?? now;
  const pressed = D.r - res.base.u >= TRIM_ROUNDS
    || res.rawBytes >= TRIM_BYTES
    || (res.rawBytes >= ROOM_MIN_BYTES && computedRoomBytes() >= ROOM_BYTES)
    || now - last >= IDLE_MS;
  if (!pressed) return;
  const pubs = frozenPubs(sc, D);
  if (pubs.includes(pub)) {
    const seenDecided = st.decided.get(`${D.close}|${D.decided}`)!.at;
    const idx = placeOf('trim', st.ctx, D.r, pubs, pub);
    if (now < Math.max(show, seenDecided + TRIM_AFTER_DECIDED_MS) + idx * STAGGER_MS) return;
  } else if (now - last < TRIM_FALLBACK_MS) {
    return;
  }
  const n = netsOf(res);
  if (Object.keys(n).length > MAX_CHECKPOINT_PIDS) return;
  const cp: Checkpoint = signed(st.ctx, 'sum', { v: 1 as const, b: res.base.sid, u: D.r, l: D.close, n, k: pub });
  const copies: [string, unknown][] = [];
  for (const s of res.felts.values()) if (!burnedCommit(st, res, s.rec.c)) copies.push([s.key, sc.ses?.get(s.key)]);
  // Refused if the checkpoint moved on meanwhile (another page's trim). What
  // it covers is let go of, seeds and all, as the page next reads the table
  // (noteResult: tellPhase, right after).
  writeCheckpointAndTrim(st.t, st.inc, cp, copies);
}

/** When this page first saw each decided round of table st with a frozen
 *  slip missing, for the trim's wait: timed from the room's state in, asleep
 *  or awake (a wake starts it again, as every timer), whatever else holds
 *  the trim back meanwhile. */
function noteMissing(st: TableState, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  for (const round of res.rounds) {
    if (!round.decided || round.missing.length === 0) st.missingAt.delete(round.close);
    else if (!st.missingAt.has(round.close)) st.missingAt.set(round.close, now);
  }
}

/** A fold's nets as a checkpoint carries them: decimal (the fold has
 *  dropped the zeros). */
function netsOf(res: FoldResult): Record<string, string> {
  const n: Record<string, string> = {};
  for (const [pid, net] of res.nets) n[pid] = net.toString();
  return n;
}

/** By fold result: sessionPubs. */
const sessionPubsOf = new WeakMap<FoldResult, Set<string>>();

/** The pubs that signed an ended incarnation's checked slips: the open
 *  round's felts, and every checked slip its session holds, of any round
 *  and any version (one a close left out too). Once per fold result. */
function sessionPubs(e: EndedComputed): Set<string> {
  let out = sessionPubsOf.get(e.res);
  if (out) return out;
  out = new Set<string>();
  for (const s of e.res.felts.values()) out.add(s.rec.k);
  for (const key of e.session?.keys() ?? []) {
    if (parseKey(key)?.kind !== 's') continue;
    const s = asSlip(e.session!.get(key));
    if (s && !out.has(s.k) && checkedSlip(e.t, e.inc, key, s)) out.add(s.k);
  }
  sessionPubsOf.set(e.res, out);
  return out;
}

/**
 * 9. Compact an ended incarnation (removed, switched off or over, its
 * sessions still in the doc): a final checkpoint saying it ended, its nets
 * the fold's (they go on counting, as a removed table's book does), and
 * every session map of it gone, in one transaction (finalizeComputed). Due
 * COMPACT_MS after this page first saw it ended, in turn (dutyRank) among
 * the pubs of its checked slips; a page with none of them, after
 * COMPACT_FALLBACK_MS (a wake starts the wait again, as it does every
 * other). An incarnation whose checkpoint already says it ended only loses
 * its maps (a session someone opened after the end). Ended incarnations come
 * from casinoDoc, not the tables passed in: a removed table isn't among
 * them. And what this page wrote for an incarnation that is over is let go
 * of, seeds and all, on every page: one ended for good (computedIncEnded),
 * or one whose switch names another incarnation. Not one whose switch is
 * only missing (a peer's delete, put back a second later, ends nothing until
 * compaction makes it final), nor anything on a frame whose doc was bound
 * afresh since this page looked at its clock (leaving the room destroys the
 * doc, and the next read binds an empty one): the seeds behind its open felts
 * are what it reveals when the incarnation goes on.
 */
function compactDuty(pub: string, now: number): void {
  if (compactedAt !== null && now >= compactedAt && now - compactedAt < TICK_MS) return;
  compactedAt = now;
  // (Of another binding: the next look at the clock starts afresh.)
  if (casinoDocEpoch() !== clock.epoch) return;
  // What this page wrote for an incarnation that is over goes, seeds and
  // all: no duty runs for it now, so nothing of it will be revealed.
  for (const st of tables.values()) {
    if (st.mine.size === 0 || !casinoWhole(st.t)) continue;
    const inc = computedIncOf(st.t);
    if (computedIncEnded(st.t, st.inc) || (inc !== null && inc !== st.inc)) letGo(st, () => false);
  }
  // (Timed from when this page saw it ended, or woke: asleep or not.)
  const awake = tablesAwake(now);
  const listed = new Set<string>();
  for (const e of computedEndedIncs()) {
    const key = `${e.t}:${e.inc}`;
    listed.add(key);
    let at = endedAt.get(key);
    if (at === undefined) endedAt.set(key, at = now);
    if (!awake || !casinoWhole(e.t) || !computedSettled(e.t)) continue;
    const ctx: FoldCtx = { room: casinoRoomId(), t: e.t, inc: e.inc };
    const pubs = sessionPubs(e);
    const idx = placeOf('trim', ctx, e.res.open, pubs, pub);
    if (now < at + (idx < pubs.size ? COMPACT_MS + idx * STAGGER_MS : COMPACT_FALLBACK_MS)) continue;
    let cp: Checkpoint | null = null;
    if (!e.res.base.ended) {
      const D = lastDecided(e.res);
      const u = D ? D.r : Math.max(1, e.res.base.u);
      const l = D ? D.close : e.res.base.l ?? NO_CLOSE;
      cp = signed(ctx, 'sum', { v: 1 as const, b: e.res.base.sid, u, l, n: netsOf(e.res), e: 1 as const, k: pub });
    }
    finalizeComputed(e.t, e.inc, cp);
  }
  for (const key of [...endedAt.keys()]) if (!listed.has(key)) endedAt.delete(key);
}

/** Whether compaction has an ended incarnation to finalise (computedEndedIncs:
 *  its sessions still in the doc), the room's tables or none: a removed
 *  table's is, after the room's last table goes. World marks its frames as
 *  running tables while there is one (croupier noteTablesRunning), as it
 *  does while the room has a table: a page that stops marking them reads as
 *  asleep a lapse later (tablesAwake), for good, and compaction waits for an
 *  awake page. Only asked in a room with no table (World's frame), and never
 *  throws out of it (a throw is the computed tick's to tell: it reads the
 *  same). */
export function computedCompactionPending(): boolean {
  try {
    return computedEndedIncs().length > 0;
  } catch {
    return false;
  }
}

// ── 🔀 The switch ────────────────────────────────────────────────────────────

/** 🧪 The dev flag as a spec sets it (null: read the page's own). */
let enabledForTests: boolean | null = null;

/** 🧪 Set the dev flag for a spec (null: the page's own again). */
export function setComputedTablesEnabledForTests(on: boolean | null): void {
  enabledForTests = on;
}

/** The dev flag: may this page's house switch a table to computed? Set by
 *  `localStorage['ssf-dev-computed'] = '1'` or `?computed=1` on the page's
 *  address (false where neither can be read). It gates only who may switch:
 *  a table switched already runs on every page of this build, flag or not. */
export function computedTablesEnabled(): boolean {
  if (enabledForTests !== null) return enabledForTests;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('ssf-dev-computed') === '1') return true;
  } catch {
    /* storage blocked: no flag there */
  }
  try {
    const search = typeof window !== 'undefined' ? window.location?.search : undefined;
    if (typeof search === 'string' && new URLSearchParams(search).get('computed') === '1') return true;
  } catch {
    /* no address to read */
  }
  return false;
}

/** Why the house's switch can't go now: this page asleep or waiting out a
 *  wake ('asleep'), its doc holding part of an update or signatures to check
 *  ('reconnecting'), a round under way ('busy'), an earlier build driving
 *  the room's tables ('old-build'), or not a roulette table ('craps'). */
export type ComputedSwitchRefusal = 'asleep' | 'reconnecting' | 'busy' | 'old-build' | 'craps';
export type ComputedSwitchResult = 'ok' | ComputedSwitchRefusal;

const SWITCH_RECONNECTING = 'RECONNECTING — TRY AGAIN IN A MOMENT';

/** What the ⚙ card says of a refused switch-on. */
export const SWITCH_ON_REFUSED: Readonly<Record<ComputedSwitchRefusal, string>> = {
  asleep: SWITCH_RECONNECTING,
  reconnecting: SWITCH_RECONNECTING,
  busy: 'FINISH THIS ROUND FIRST',
  'old-build': "AN OLDER VERSION OF THE GAME RUNS THIS ROOM'S TABLES — UPDATE IT FIRST",
  craps: 'ONLY A ROULETTE TABLE CAN RUN WITHOUT THE OWNER',
};

/** …and of a refused switch-off (a round under way: its spin first). */
export const SWITCH_OFF_REFUSED: Readonly<Record<ComputedSwitchRefusal, string>> = {
  ...SWITCH_ON_REFUSED,
  busy: 'WAIT FOR THE SPIN TO FINISH',
};

/** What the ⚙ card says before a switch-on: the room's default is Fair, and
 *  a computed table isn't. */
export const SWITCH_ON_CONFIRM = 'THIS TABLE WILL RUN FRIENDLY: SEEDS FROM THE PLAYERS ONLY';

/** Whether this page may switch anything now: awake, its doc whole, every
 *  computed table's signatures checked (as a spend waits: computedSettled). */
function switchGate(t: string, now: number): ComputedSwitchRefusal | null {
  if (!tablesAwake(now)) return 'asleep';
  if (!casinoWhole(t) || !computedSettled()) return 'reconnecting';
  return null;
}

/** Why owner-run table t can't be switched on now, or null. Quiet: no round
 *  up, or one settled, or one betting with no list on it (a SPIN pressed is
 *  a closing round: never quiet). */
function onRefusal(t: string, game: 'craps' | 'roulette', now: number): ComputedSwitchRefusal | null {
  if (game !== 'roulette' || readCrapsTableState(t) !== null) return 'craps';
  const gate = switchGate(t, now);
  if (gate) return gate;
  if (leaseIsOldBuild(now)) return 'old-build';
  const s = readTableState(t);
  const quiet = s === null || s.phase === 'settled' || (s.phase === 'betting' && Object.keys(readAllBets(t, s.round)).length === 0);
  return quiet ? null : 'busy';
}

/** Why computed table t can't be switched off now, or null: not while a
 *  close of the open round is in (its seeds would go out for nothing), nor
 *  while a forfeit's result waits: the view reads closing for both (the tip,
 *  or the hold before the result's show). A close of the open round that
 *  checks out is the tip, or decided (then the round is no longer open);
 *  one still being checked leaves the table unsettled (the gate); one that
 *  reads invalid is junk, which holds nothing back. A switch whose
 *  incarnation a whole, checked doc holds nothing of (no session, no
 *  checkpoint: tableOf finds no count) has no round under way either: no
 *  build writes one so (the switch-on writes its first session with it, in
 *  one update, and a doc holding part of one isn't whole), so it is a peer's
 *  forgery, and it goes. Waiting for a session that never comes would leave
 *  the table with nobody to run it, the robot standing down for good. */
function offRefusal(t: string, now: number): ComputedSwitchRefusal | null {
  const gate = switchGate(t, now);
  if (gate) return gate;
  const at = tableOf(t);
  if (!at) return null;
  return viewOf(at.st, at.res, now).view.phase === 'closing' ? 'busy' : null;
}

/**
 * 🔀 The house switches roulette table `t` to computed (the ⚙ card, after
 * its confirmation): in ONE transaction, the owner-run incarnation ends as a
 * removal ends it (refundAndClear: its lists stop holding, what an earlier
 * build's took is refunded, its book counts on), and the computed one starts
 * under a name every page computes alike (computedIncFor: two of the house's
 * pages pressing at once open one table), with its first session. Refused
 * while the owner-run table has a round under way, while an earlier build
 * drives the room's tables (it would go on opening owner-run rounds on this
 * one), on a page asleep or not whole, and on a craps table. 'ok' for a
 * table that is computed already.
 */
export function switchComputedOn(t: string, game: 'craps' | 'roulette' = 'roulette', now = Date.now()): ComputedSwitchResult {
  lookAtClock(now);
  const refused = onRefusal(t, game, now);
  if (refused) return refused;
  if (isComputedTable(t)) return 'ok';
  transactCasino(() => {
    refundAndClear(t, 'local');
    writeComputedOn(t, computedIncFor(t));
  });
  return 'ok';
}

/**
 * 🔀 The house switches computed table `t` back to owner-run: in ONE
 * transaction, the incarnation's final checkpoint (it ended; its nets the
 * fold's, which go on counting), every session map of it gone, its `gone:`
 * mark (finalizeComputed), and the switch. Open felts stop holding (their
 * chips are back), and the robot opens the table's next round on a fresh
 * owner-run incarnation (tableIncFor counts the new mark). Refused while a
 * round is under way (a close in, or a result still to show), and on a page
 * asleep or not whole. 'ok' for a table that isn't computed. A switch whose
 * incarnation the doc holds nothing of (a peer's forgery) only goes, marked
 * ended.
 */
export function switchComputedOff(t: string, now = Date.now()): ComputedSwitchResult {
  lookAtClock(now);
  if (!isComputedTable(t)) return 'ok';
  const refused = offRefusal(t, now);
  if (refused) return refused;
  const at = tableOf(t);
  if (!at) {
    // (Nothing of it to finalise: the switch goes, its incarnation marked
    // ended, so a session of it turning up later is compacted as a removed
    // table's is, its nets counted, nothing held.)
    transactCasino(() => writeComputedOff(t));
    return 'ok';
  }
  const { st, res } = at;
  const D = lastDecided(res);
  const u = D ? D.r : Math.max(1, res.base.u);
  const l = D ? D.close : res.base.l ?? NO_CLOSE;
  const cp: Checkpoint = signed(st.ctx, 'sum', { v: 1 as const, b: res.base.sid, u, l, n: netsOf(res), e: 1 as const, k: getIdentityPub() });
  const done = transactCasino(() => {
    if (!finalizeComputed(t, st.inc, cp)) return false;
    writeComputedOff(t);
    return true;
  });
  return done ? 'ok' : 'reconnecting';
}

/** What the ⚙ card shows of the switch: the row at all (`show`: the house,
 *  with the dev flag, at a roulette table), which way it is (`on`), whether
 *  a press would go now (`can`), and if not, why (`reason`, the card's
 *  words). */
export interface ComputedSwitchState {
  show: boolean;
  on: boolean;
  can: boolean;
  reason?: string;
}

export function computedSwitchState(t: string, game: 'craps' | 'roulette', house: boolean, now = Date.now()): ComputedSwitchState {
  const on = game === 'roulette' && isComputedTable(t);
  const show = game === 'roulette' && house && computedTablesEnabled();
  if (!show) return { show, on, can: false };
  lookAtClock(now);
  const refused = on ? offRefusal(t, now) : onRefusal(t, game, now);
  return refused ? { show, on, can: false, reason: (on ? SWITCH_OFF_REFUSED : SWITCH_ON_REFUSED)[refused] } : { show, on, can: true };
}

/** Whether an earlier build drives computed table `t` too: an owner-run
 *  round is up on it (that build's lease holder opened it; this build's
 *  sweeps it once its driver has gone, croupier sweepLegacyRound). */
export function computedOldBuildDriving(t: string): boolean {
  return isComputedTable(t) && readTableState(t) !== null;
}

// ── 🙋 This page's player at the table ───────────────────────────────────────

/** What became of this page's player's felt in the round the table shows
 *  (the one closing, or the one whose result shows), for the status bar. */
export interface ComputedMine {
  round: number;
  /** A close froze a felt of theirs in it, and the room has that felt. */
  frozen: boolean;
  /** …and their seed is in. */
  revealed: boolean;
  /** The close left out the felt they had chips on (written, or held back
   *  to go), or named one the room never had: it holds nothing, its chips
   *  are back. */
  leftOut: boolean;
  /** They put down a later felt than the one the close froze (a version
   *  that crossed the close on its way): the close had the earlier bets. */
  tooLate: boolean;
}

function mineIn(st: TableState, res: FoldResult, R: RoundView): ComputedMine {
  const me = getPlayerId();
  const pub = getIdentityPub();
  const sc = scanOf(st, res);
  const frozenHash = R.frozen[me];
  const frozen = R.present.includes(me);
  const v0 = frozen ? frozenSlip(sc, R, me)?.v ?? 0 : 0;
  let later = false;
  if (frozen) {
    for (const key of sc.slips.get(R.r)?.get(me) ?? []) {
      const s = asSlip(sc.ses?.get(key));
      if (!s || s.k !== pub || !checkedSlip(st.t, st.inc, key, s)) continue;
      if (s.v > v0 && parseKey(key)?.h !== frozenHash) later = true;
    }
  }
  // Left out only with chips down: the latest felt (a close freezes each
  // player's latest with chips on it), or one held back that the close
  // came before. A felt taken down before the close missed nothing.
  const staked = !frozen && (latestOwnSlip(st, sc, R.r, me, pub)?.b.length ?? 0) > 0;
  return {
    round: R.r,
    frozen,
    revealed: frozen && R.revealed.includes(me),
    leftOut: !frozen && (frozenHash !== undefined || staked || st.lateFelt === R.r),
    tooLate: frozen && (later || st.lateFelt === R.r),
  };
}

/** This page's player's latest felt of round r in the session: the version
 *  with the highest v (then hash), as the fold reads a felt, of those
 *  checked and signed by this page's key; null for none. */
function latestOwnSlip(st: TableState, sc: Scan, r: number, me: string, pub: string): SlipRec | null {
  let best: { s: SlipRec; h: string } | null = null;
  for (const key of sc.slips.get(r)?.get(me) ?? []) {
    const s = asSlip(sc.ses?.get(key));
    if (!s || s.k !== pub || !checkedSlip(st.t, st.inc, key, s)) continue;
    const h = parseKey(key)!.h;
    if (!best || s.v > best.s.v || (s.v === best.s.v && h > best.h)) best = { s, h };
  }
  return best?.s ?? null;
}

/** This page's player's part in the round computed table `t` shows (null
 *  while it takes bets, or when it isn't one). Once per view. */
export function computedMine(t: string, now = Date.now()): ComputedMine | null {
  lookAtClock(now);
  const at = tableOf(t);
  if (!at) return null;
  const e = viewOf(at.st, at.res, now);
  const R = e.view.phase === 'closing' ? e.holding : e.view.phase === 'settled' && e.onChain ? e.D : null;
  if (!R) return null;
  if (e.mine === undefined || e.mine.round !== R.r) e.mine = mineIn(at.st, e.res, R);
  return e.mine;
}

/** The last round of computed table `t`'s live chain that is decided (its
 *  checkpoint's, with none since), or null: a round this page showed decided
 *  past it is undone (a delete took what it rests on, or the room kept the
 *  other side of a split). */
export function computedDecidedTo(t: string): number | null {
  const at = tableOf(t);
  return at ? lastDecided(at.res)?.r ?? at.res.base.u : null;
}

// ── 🚪 Leaving ───────────────────────────────────────────────────────────────

/**
 * Take this page's felt down from every computed table it has chips on, as
 * the page leaves the room (main.ts leaveRoomNow, before the doc goes) or
 * closes (pagehide): best effort, a refusal left as it is (a round closing
 * holds the felt it froze; a page that may not write now writes nothing). A
 * felt left behind is frozen by the next close, and with this page gone
 * nobody reveals its seed: the round's forfeit takes it. So it does for a
 * tab closed with no pagehide (a crash, a killed browser): leaving mid-round
 * forfeits the stake. Only this page's felt: the one it wrote that the
 * table counts now, or one it holds back to write. Its player's other tab
 * (same player, same key) may have put the felt down, and that tab is still
 * at the table, its seed with it: an empty version over it would take the
 * bet away from under it.
 */
export function leaveComputedTables(now = Date.now()): void {
  const me = getPlayerId();
  for (const st of [...tables.values()]) {
    if (computedIncOf(st.t) !== st.inc || !isComputedTable(st.t)) continue;
    const held = computedFoldOf(st.t)?.felts.get(me);
    // (Nothing waits for a flush now, nor is one held to go later: the page
    // won't tick here again. A felt held back was never on the table.)
    st.pending = null;
    if (!held || held.rec.b.length === 0 || !st.mine.has(held.key)) continue;
    st.lastSlip = null;
    try {
      writeComputedSlip(st.t, [], now);
    } catch {
      /* best effort */
    }
  }
}

// Best effort on page close: the write may not flush.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => leaveComputedTables());
}
