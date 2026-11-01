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
 * A PAGE THAT CAN'T HEAR THE ROOM doesn't forfeit for it. A forfeit beats a
 * full set of reveals, so one from a page that missed seeds only because its
 * own link stalled after a close (a wifi blip, the node's link to the host)
 * rewrites, as the link comes back, a round every other page showed. Such a
 * page hears nobody: no tick from any page, no update into its doc
 * (roomHearing.ts, which main.ts and casinoDoc tell). So a forfeit, and an
 * answer to one, goes only from a page that has heard the room all the way
 * from a lapse before the close to its write (heardAround: a close that
 * came in the burst as its link came back was not heard live, even if its
 * stamp is fresh); the rest is the others' to forfeit, or the abandon's to
 * void. And a page still missing a seed near the end of its grace asks the
 * room once for what it lacks (askDuty): an update lost on its way comes
 * back before the forfeit would drop it. In a room of two, a page whose
 * only peer sleeps hears nobody, so the round waits for the sleeper's seed
 * or the abandon. The seed is the other side of it: a full set of reveals
 * beats a void, so a seed that lands after the room voided the round
 * undoes a void every other page showed. So a page reveals for a void round
 * only when it watched that round's close live, hearing the room around it
 * (voidHolds, watchedLive); and a page back from a sleep, or from a spell
 * hearing nobody, holds its seed for a round it slept through with another
 * player's stake in it until it has heard the room again (wakeHolds), so
 * that a void it hadn't heard of yet stands. A round only its own player
 * bets in is a room of one: nobody else is there to void it, and its seed
 * goes at once.
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
 * writes alone, naming nothing the doc holds, the house's robot drops a
 * lapse on (croupier dropBareSwitch), or the house switches off at once
 * (the way back shows on its ⚙ card with or without the flag). A removal
 * ends the incarnation on the pages that run it; a table out of the room
 * whose switch is still on (an earlier build removed it, or no page of this
 * build heard the removal) every page ends a minute on (awayDuty).
 *
 * AT A CRAPS TABLE (PR 3) a round is one roll, and the fold carries the
 * table's state from roll to roll (computedCraps.ts: the point, every bet
 * that rides, who holds the dice). The incarnation's name says the game
 * (`k…`; roulette's are `c…`), and every slip read here goes through that
 * game's own reader (st.slipOf, st.keyOf). A slip holds the player's whole
 * felt, stamped with the state it was built on (basisOf) and the stand this
 * page's table session stands at (localStandOf), never the doc's seat
 * record. Riders put their riding bets down each roll someone plays
 * (rideDuty), and a page leaving writes a goodbye (`l: 1`) that lets the
 * window let go of it (leaveComputedTables), then writes nothing more. When
 * the dice's holder is in play, betting is followed by the wait for the
 * throw: their page closes the roll at its own fling (noteComputedFling),
 * every other page only once the wait is over (closeDue), and the closes,
 * the re-commits and the burned re-puts run whenever the roll's window has
 * started and no close is in (crapsDutyOn), not only while betting reads
 * open. A roll everyone on it has left, or one nobody closes, takes bets
 * again (build: the re-arms).
 */

import {
  askRoomForMissing,
  casinoDocEpoch,
  casinoRoomId,
  casinoWhole,
  computedCheckpointOf,
  computedEndedIncs,
  computedFoldOf,
  computedIncEnded,
  computedIncFor,
  computedIncOf,
  computedLiveTables,
  computedRecoveries,
  computedRestorePending,
  computedRecoveryOn,
  computedRoomBytes,
  computedSeenAt,
  computedSessionForWrite,
  computedSettled,
  computedSlipDoubted,
  computedSwitchLost,
  computedTablePids,
  COMPUTED_MIN_BUILD,
  computedVerdictOf,
  delegationHeld,
  fairSettingSeq,
  finalizeComputed,
  giveUpComputed,
  giveWayComputed,
  holdsDeed,
  houseOnline,
  houseSetUp,
  isComputedTable,
  markComputedVerdict,
  notifyCasinoView,
  ownerRunChosen,
  putBackHouseRecords,
  putComputedSwitchBack,
  readAllBets,
  readAllCrapsBets,
  readChips,
  readCrapsTableState,
  readFairSetting,
  readSeat,
  readSeats,
  readTableState,
  reopenComputedSession,
  restoreComputedCheckpoint,
  transactCasino,
  writeCheckpointAndTrim,
  writeComputedGone,
  writeComputedOff,
  writeComputedOn,
  writeDelegation,
  writeFairSetting,
  writeHouseSum,
  writeOwnerRunChosen,
} from './casinoDoc';
import type { ComputedRecovery, EndedComputed, RecoveryTrigger } from './casinoDoc';
import {
  abandonKey, asAbandon, asClose, asForfeit, asHouseCommit, asHouseReveal, asReveal, asSlipFor, canon, closeKey, dutyRank,
  forfeitKey, gameOfInc, houseCommitKey, houseRevealKey, houseRules, isPub, MAX_CHECKPOINT_PIDS, MAX_FROZEN, MAX_SLIP_BETS, MAX_TABLE_PIDS, nextSid, parseKey,
  recHash, revealKey, seedTable, signBytes, slipCommit, slipKeyFor,
} from './computedFold';
import type {
  AbandonRec, AnySlipRec, Checkpoint, CloseRec, CrapsSlipRec, Decision, Duty, FoldCtx, FoldResult, ForfeitRec, GameName, HouseSum, RecKind,
  RevealRec, RoundView, SignedKind, SlipInfo,
} from './computedFold';
import {
  addedOver, basisOf, canonFelt, CARRY_POINTS, changeOk, EMPTY_CARRY, feltSum, isCanonFelt, MAX_RIDERS, minPerSpot, own, spotKey, TRIM_SEVEN_OUT_MIN,
} from './computedCraps';
import type { CrapsCarry, RollFate } from './computedCraps';
import { HOUSE_HEARD_MS, roomSignBytes } from './computedHouse';
import {
  BET_WINDOW_MS, canRunCroupier, CRAPS_BET_WINDOW_MS, CRAPS_SHOOTER_MS, CRAPS_SHOW_MS, leaseIsOldBuild, refundAndClear, roomStateIn, SHOW_MS,
  TABLE_CLOCK_SLACK_MS, TABLE_LEASE_LAPSE_MS, tablesAwake, tablesWakeCount,
} from './croupier';
import { forgetSeed, keepSeed, keyFor, REVEAL_GRACE_MS, seedFor } from './fairTableSeeds';
import { isCrapsBet, MAX_BETS_PER_PLAYER } from './games/craps';
import type { CrapsBet, CrapsTableState } from './games/craps';
import type { TableSeedContext } from './games/diceFairness';
import { randomSeedHex } from './games/fairDice';
import { isRouletteBet } from './games/roulette';
import type { RouletteBet, RouletteTableState } from './games/roulette';
import { getPlayerId } from './identity';
import { getIdentityPub, signIdentity } from './keypair';
import { localStandOf } from './localStands';
import { heardThrough, noteClockRead } from './roomHearing';

// ── ⏱ Timing ─────────────────────────────────────────────────────────────────

/** The betting window once the first chip is seen, and the show beat after a
 *  decided round: the owner-run table's (croupier.ts). */
export { BET_WINDOW_MS, SHOW_MS };
/** The least a frozen bettor's seed is waited for (fairTableSeeds.ts). */
export { REVEAL_GRACE_MS };
/** Whether this page hears the room (roomHearing.ts: main.ts turns it on and
 *  tells it of each tick it hears; the specs reach it here, in each page's
 *  own load of the modules). */
export { HEARD_GAP_MS, listenToRoom, noteRoomHeard } from './roomHearing';
/** The most it is waited for, however late the seeds before it came. */
export const GRACE_MAX_MS = 10_000;
/** A seed seen inside the grace stretches it to this long after that seed. */
export const GRACE_PAD_MS = 1_500;
/** Each page ranked ahead for a duty puts this much on this page's turn. */
export const STAGGER_MS = 1_500;
/** A seed still missing this long before the least grace runs out is asked
 *  of the room (askDuty): the room's answer is in before the forfeit falls
 *  due. */
export const ASK_AHEAD_MS = 1_500;
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
/** A table whose switch is on, out of the room's tables this long on this
 *  page (awake, its doc whole and checked), is ended as its removal would
 *  have ended it (awayDuty). */
export const AWAY_MS = 60_000;
/** 🩹 A rewound or jumped checkpoint is put back this long after this page
 *  first saw it so (a deleted one, or junk, at once), in turn; a deleted
 *  session is opened again this long after, in turn; and the rounds of a
 *  session deleted for this long are given up (recoverDuty). */
export const RESTORE_WAIT_MS = 5_000;
export const OPEN_WAIT_MS = 5_000;
export const GIVE_UP_MS = 60_000;
/** A page whose key isn't among an incarnation's (ComputedRecovery pubs)
 *  waits this much more for its turn at a restore or a reopen; and no page
 *  waits more than RECOVERY_PLACES places (restores of one head write the
 *  same bytes, so pages writing at once cost the room only bandwidth). So a
 *  reopen comes well inside GIVE_UP_MS, whoever is listed. */
export const OUTSIDER_WAIT_MS = 15_000;
export const RECOVERY_PLACES = 8;
/** A put-back of a deleted or junk checkpoint waits this long after this
 *  page's last restore of it: a peer writing junk on every tick costs the
 *  room a checkpoint a second, not five. */
export const JUNK_GAP_MS = 1_000;
/** 🚩 A page whose restores of an incarnation's checkpoint are written over
 *  CONTESTED_COUNT times in a row by values that put a restore in motion
 *  again, with no CONTESTED_CALM_MS between them, says so on its ⚙ card
 *  until that long passes with none. It never stops restoring: no honest
 *  page writes a rewind or a jump over a restore for long (one that took a
 *  jump as its head drops it once the head it jumped over is back:
 *  casinoDoc noteCounted), so what keeps writing them over is a cheat, and
 *  a page that stopped would leave the table to it. */
export const CONTESTED_COUNT = 3;
export const CONTESTED_CALM_MS = 60_000;

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
  view: ComputedRouletteState | ComputedCrapsState;
  /** What a phase change looks like: phase, round, deadline, spin key (at
   *  craps the roll key, the shooter and the stall). */
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
  bets?: Record<string, RouletteBet[]> | Record<string, CrapsBet[]>;
  /** This page's player's part in the round shown (computedMine). */
  mine?: ComputedMine;
  /** At craps, while the open roll's window has started: its end of
   *  betting, W (crapsDutyOn: the close turns take it from the view). */
  betEnd?: number;
}

/** The session's keys, by kind, round and (slips, reveals) pid, read once per
 *  fold result: the duties look up records by them. */
interface Scan {
  res: FoldResult;
  gen: number;
  ses: Session | null;
  /** The incarnation's slip reader (TableState slipOf). */
  slipOf: (v: unknown) => AnySlipRec | null;
  /** r → pid → keys */
  slips: Map<number, Map<string, string[]>>;
  reveals: Map<number, Map<string, string[]>>;
  /** r → keys */
  closes: Map<number, string[]>;
  forfeits: Map<number, string[]>;
  abandons: Map<number, string[]>;
  /** r → keys of the house's reveals and join records (a house table's). */
  houses: Map<number, string[]>;
  joins: Map<number, string[]>;
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
  /** The game its name says (gameOfInc), and that game's slip reader and
   *  slip key: every slip this page reads or writes of it goes through
   *  them, so no roulette reader ever reads a craps slip. */
  game: GameName;
  slipOf: (v: unknown) => AnySlipRec | null;
  keyOf: (rec: unknown) => string | null;
  /** When this page first saw each session key, on its clock (seen). */
  seen: Map<string, number>;
  /** By `<close>|<decision>`: when this page saw that round decided, and for
   *  a forfeit, when its result may show (showStart). */
  decided: Map<string, { r: number; at: number; show?: number }>;
  mine: Map<string, Mine>;
  /** Commitments this page has revealed or seen revealed (→ their round):
   *  never frozen again, nor reused for a slip. */
  burned: Map<string, number>;
  /** A felt held back by the coalescing, for round r; at craps with the
   *  stamp it was built on, and `ride` for rideDuty's stand rewrite (the
   *  felt as written, only the stand new: no change of the player's). */
  pending: { r: number; felt: RouletteBet[] | CrapsBet[]; basis?: string; ride?: true } | null;
  /** The last round whose close came while a felt of this page's was held
   *  back, and froze another (the status bar's "too late"), with the slip
   *  of this page's it froze ('' for none): a close of that round played
   *  again (past a checkpoint) that froze a felt written since is not; at
   *  craps, whether that felt added chips over what rode in (the ⚙ card's
   *  words). */
  lateFelt: { r: number; frozen: string } | null;
  lateAdded: boolean;
  /** This page's last slip written: round and when. */
  lastSlip: { r: number; at: number } | null;
  /** A window that ran out with nothing on the felt arms again only on a
   *  chip seen from `at` on. */
  rearm: { r: number; at: number } | null;
  /** When round r's window started on this page (windowOf), kept for the
   *  round: a version that left the session (a trim) or one counted late
   *  doesn't move it. Gone with a re-arm, with every first-seen time, and
   *  with a checkpoint, unless it is for the round after it and this page
   *  never saw that round closed (noteResult). */
  window: { r: number; at: number } | null;
  /** At craps: this page's own fling for round r (noteComputedFling), when
   *  and with which seed; never from the throw record. A re-show of the
   *  roll before forgets one made before it (buildCraps); a checkpoint, any
   *  but one for the roll after it that this page never saw closed
   *  (noteResult). */
  flung: { r: number; at: number; seed: number } | null;
  /** At craps: this page has said goodbye (leaveComputedTables), and
   *  writes no slip again until the doc is bound afresh or the page comes
   *  back from the back-forward cache. */
  left: boolean;
  /** At craps: how many times this page dropped changes of its player's
   *  because the roll before changed under them, held (flushDuty) or gone in
   *  (rideDuty writes the riding bets over them); the table's notice. Once
   *  for the changes since the last (noteUndone): `changes` counts the ones
   *  this page took for its player (held or written, or a goodbye's felt put
   *  back, or a version this page didn't write taken on as its own),
   *  `changesTold` what `changes` was at the last notice; `toldOver` the
   *  versions this page didn't write that it has told of or taken on (→
   *  their round); `undoneAway` a notice due once this page is back (it
   *  came as the page left). */
  undone: number;
  changes: number;
  changesTold: number;
  toldOver: Map<string, number>;
  undoneAway: boolean;
  /** At craps: what each decided roll on the chain came to as this page
   *  last saw it, and whether this page's player's slip on it was built on
   *  another state; and the last earlier roll this page saw change
   *  (noteChanged: the table's notice, counted by `seq`). */
  rolled: Map<number, { key: string; basis: boolean }>;
  changed: { seq: number; round: number; undid: [number, number] | null };
  tickedAt: number | null;
  reputAt: number | null;
  /** The last decided round this page saw on the chain: what the felt
   *  shows once a trim has taken the round out of the session, when it is
   *  the round the checkpoint kept (its close). */
  lastD: RoundView | null;
  lastRes: FoldResult | null;
  /** By how many chips the checkpoint that opened session `sid` differs
   *  from what this page had folded of those rounds (`chips`); of that, by
   *  how many in the nets, and at craps whether the table it hands on
   *  differs (its riding bets, point or dice's hands). */
  cpDiff: { sid: string; chips: number; nets: number; carry: boolean } | null;
  /** 🩹 While the table counts a checkpoint that puts a restore in motion
   *  (noteResult): the head's session, the fold of it, and the keys of what
   *  this page had written into it; and the session the table last moved to
   *  meanwhile, with the keys this page held then (what it wrote since went
   *  into that session). */
  forged: { sid: string; res: FoldResult; mine: Set<string>; on: string; since: Set<string> } | null;
  /** 🏛️ D2: the owner-signed checkpoint this page last wrote for this table —
   *  the sid it opens (so the next trim of it carries the attestation's `a`
   *  on), and that `a` (how far back the checker has folded every round in).
   *  Null when this page isn't the deed holder, or the last trim failed a
   *  vouch condition (a fresh chain starts from the next base's `u`). */
  attested: { sid: string; a: number } | null;
  scan: Scan | null;
  view: ViewEntry | null;
  /** The phase listeners were last told of, for one fold result. */
  told: { res: FoldResult; key: string } | null;
  /** The ⚙ card's verdict; and each one it gave in the session, by its
   *  round's close: a trim that takes the rounds out of the session keeps
   *  the one on the round the checkpoint kept (noteResult). */
  check: { res: FoldResult; gen: number; out: ComputedRoundCheck | null } | null;
  checks: Map<string, ComputedRoundCheck>;
  /** By close hash: when this page first saw that decided round with a
   *  frozen slip missing (a trim waits MISSING_WAIT_MS for it). */
  missingAt: Map<string, number>;
  /** By close hash: the seeds seen opening its frozen slips (revealsSeen). */
  opened: Map<string, Opened>;
  /** When this page first saw round r's close stand down for a seed out
   *  (seedOut, with no tip and no close in): it closes ABANDON_MS on. */
  seedOutAt: { r: number; at: number } | null;
  /** The close this page last asked the room about (askDuty: once per close). */
  askedFor: string | null;
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
 *  the doc held by then came all at once), and the end of the lapse the
 *  page waits out after its last wake or clock gone back (croupier
 *  tablesAwake: its doc catching up; what came by then came all at once,
 *  and stamps up to the latest time read before it were taken before it). */
const clock = {
  epoch: -1, wakes: 0, last: null as number | null, wakeAt: 0, gen: 0, inAt: null as number | null, realFrom: 0,
};
const tables = new Map<string, TableState>();
/** 🏛️ The sids of the final checkpoints this page itself wrote (switch-off or
 *  compaction, finalizeComputed): D2 vouches for an end only when it is one of
 *  these (its own; a cheat's forged `e:1` carrying this page's key is not).
 *  Of the binding, so cleared when the doc rebinds (lookAtClock). */
const endedByMe = new Set<string>();
/** By `<tableId>:<inc>`: when this page first saw that incarnation ended
 *  with its sessions still in the doc (computedEndedIncs), on its clock. */
const endedAt = new Map<string, number>();
/** When compaction last looked (at most every TICK_MS). */
let compactedAt: number | null = null;
/** By `<tableId>:<inc>`: the live incarnations whose table was out of the
 *  room's tables at this page's last tick (awayDuty), and when this page
 *  first saw each so, awake, its doc whole and checked, on its clock. */
const away = new Set<string>();
const awayAt = new Map<string, number>();

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
    endedByMe.clear();
    endedAt.clear();
    compactedAt = null;
    away.clear();
    awayAt.clear();
    // 🩹 The recovery duty's waits and contest counts were of that binding
    // too: rejoining the same table must not reuse an expired reopen/give-up
    // wait or show a stale 🚩 contested warning from the old document.
    recovering.clear();
    recoveredAt = null;
    recoveryRanks.clear();
    clock.gen += 1;
    clock.inAt = null;
  }
  if (wakes !== clock.wakes || (clock.last !== null && clock.last - now >= TABLE_CLOCK_SLACK_MS)) {
    clock.wakeAt = now;
    // (Gone back: stamps up to the last time read were taken before it. And
    // a doc that slept too hears what the room wrote meanwhile only now, as
    // it catches up: stamped after the wake, a close and its seeds minutes
    // old read as just in. What comes while the page waits out the lapse
    // came all at once. Never earlier than it was: one step back can come
    // here twice — a read sees the clock gone back, then the frame's run of
    // its tables counts the wake — and the second look, its last time read
    // already the step's, would take stamps from before the step for ones
    // this page watched come in.)
    clock.realFrom = Math.max(clock.realFrom, now + TABLE_LEASE_LAPSE_MS, clock.last ?? now);
    clock.gen += 1;
    for (const st of tables.values()) {
      st.seen.clear();
      st.decided.clear();
      st.rearm = null;
      st.window = null;
      st.flung = null;
      st.missingAt.clear();
      st.opened.clear();
      st.seedOutAt = null;
      st.askedFor = null;
      st.shortAt = null;
      // (A copy keeps its value: only when it went missing starts again.)
      for (const w of st.witness.values()) for (const copy of w.copies.values()) copy.missingAt = null;
    }
    endedAt.clear();
    awayAt.clear();
  }
  // What came with the room's state, or from the cache before it, came at
  // once; what comes from the first look with it in, as it happens.
  if (clock.inAt === null && roomStateIn(now)) clock.inAt = now;
  clock.wakes = wakes;
  clock.last = now;
}

/** Whether this page watched round's close come in: casinoDoc stamped it
 *  after the room's state was in on this binding, and after the lapse this
 *  page waited out when it last woke or saw its clock go back (its doc
 *  catching up). Only then are its first-seen times of the round's seeds the
 *  times they came. A page that slept through the close (its doc too, or
 *  not), or loaded after it, reads every record it found as seen at once, a
 *  seed that came minutes late as in time: from it, a forfeit counting that
 *  seed would rewrite a round every page has shown (and its own seed's
 *  lateness would choose, the result known, whether it counts). */
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
  const ctx: FoldCtx = { room: casinoRoomId(), t, inc };
  return {
    t, inc, ctx, game: gameOfInc(inc), slipOf: asSlipFor(ctx), keyOf: slipKeyFor(ctx),
    seen: new Map(), decided: new Map(), mine: new Map(), burned: new Map(),
    pending: null, lateFelt: null, lateAdded: false, lastSlip: null, rearm: null, window: null, flung: null, left: false, undone: 0, changes: 0, changesTold: 0, toldOver: new Map(), undoneAway: false,
    rolled: new Map(), changed: { seq: 0, round: 0, undid: null },
    tickedAt: null, reputAt: null,
    lastD: null, lastRes: null, cpDiff: null, forged: null, attested: null, scan: null, view: null, told: null, check: null, checks: new Map(),
    missingAt: new Map(), opened: new Map(), seedOutAt: null, askedFor: null, witness: new Map(), witnessVer: 0, lost: null,
    decidedTo: null, shortAt: null, chainClose: new Map(), replaced: null,
  };
}

/** Table t's state and fold result, when it is a computed table casinoDoc
 *  has a result for; given a game, only when the incarnation's name says
 *  that game (a craps name under a roulette table runs nothing here, nor a
 *  roulette one under a craps table: awayDuty ends it). */
function tableOf(t: string, game?: GameName): { st: TableState; res: FoldResult } | null {
  if (!isComputedTable(t)) return null;
  const inc = computedIncOf(t)!;
  if (game !== undefined && gameOfInc(inc) !== game) return null;
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
 *  this page kept of rounds the checkpoint covers goes.
 *
 *  🩹 A checkpoint that puts a restore in motion (a peer's rewind or jump,
 *  casinoDoc computedRestorePending) is counted as every build counts it,
 *  but is no trim here: what this page wrote and witnessed of the head's
 *  session stays (`forged`), for when the head is back, or for putting it
 *  back should that session go. The head back, what it wrote meanwhile
 *  goes; the table moved on from it instead (an honest trim that came in
 *  meanwhile), the move is the head's session's. (Which slips this page's
 *  closes leave out after such a move: casinoDoc noteDoubted.) */
function noteResult(st: TableState, res: FoldResult): void {
  const was = st.lastRes;
  if (was === res) return;
  const moved = was !== null && was.base.sid !== res.base.sid;
  if (forgedStands(st)) {
    if (moved) {
      const keys = new Set(st.mine.keys());
      st.forged ??= { sid: was!.base.sid, res: was!, mine: keys, on: res.base.sid, since: keys };
      st.forged.on = res.base.sid;
      st.forged.since = keys;
    }
  } else if (st.forged) {
    endForged(st, res);
  } else if (moved) {
    movedOn(st, was!, res);
  }
  // 🏛️ D2: the deed holder's page vouches for the trim it just folded (never
  // for a forgery a restore is undoing: forgedStands). It signs the checkpoint
  // only when every one of attestDuty's conditions holds.
  if (moved && !forgedStands(st)) attestDuty(st, was!, res);
  const D = lastDecided(res);
  if (D) st.lastD = D;
  st.lastRes = res;
  noteReplaced(st, res, moved);
  noteChanged(st, res, moved);
  // Every commitment this page has seen a reveal open stays burned for it,
  // the reveal gone or not (a peer's delete, a trim): its seed is out.
  let fresh: Set<string> | null = null;
  for (const c of res.revealedCommits) if (!st.burned.has(c)) (fresh ??= new Set()).add(c);
  if (fresh) {
    const sc = scanOf(st, res);
    for (const [r, byPid] of sc.slips) {
      for (const keys of byPid.values()) {
        for (const key of keys) {
          const s = st.slipOf(sc.ses?.get(key));
          if (s && fresh.has(s.c)) st.burned.set(s.c, r);
        }
      }
    }
  }
}

/** 🏛️ D2: the deed holder's page vouches for the checkpoint `res` folds from
 *  (P = the doc's `sum:`, which this fold's session opens) by writing a signed
 *  `hs:` over it — but only when it is sure of it, by every condition of design
 *  §6.3. On any failure it writes nothing and forgets its chain (st.attested).
 *  Not a hot path: once per trim this page folds, about a signature's worth. */
function attestDuty(st: TableState, was: FoldResult, res: FoldResult): void {
  if (!holdsDeed()) {
    st.attested = null;
    return;
  }
  const now = clock.last ?? Date.now();
  // A page that hasn't heard the room for a minute can't vouch (its view may
  // be stale): wait, without forgetting the chain.
  if (!heardThrough(now - IDLE_MS, now)) return;
  const P = computedCheckpointOf(st.t, st.inc);
  if (!P) {
    st.attested = null;
    return;
  }
  // The doc's checkpoint raced ahead of what this fold read: wait for the fold
  // of it, keeping the chain (nextSid leaves k and g out).
  if (nextSid(st.ctx, P) !== res.base.sid) return;
  const fail = (): void => {
    st.attested = null;
  };
  // 1. P trims the session this page folded.
  if (P.b !== was.base.sid) return fail();
  // 2. `was` has round P.u decided, with the close P names (covered).
  const at = was.rounds.find((v) => v.decided !== null && v.r === P.u && v.close === P.l);
  if (!at) return fail();
  // 3. The checkpoint's nets and craps carry are what this page folded.
  const diff = checkpointDiff(was, res);
  if (diff.nets !== 0n || diff.carry !== 0n) return fail();
  // 4. At a house table, P's `h` is the commitment this page saw round u carry
  //    (both absent counts as equal), and no step-down it saw past u lifted it.
  if ((P.h ?? null) !== (at.house?.rec.c ?? null)) return fail();
  if (was.rounds.some((v) => v.r > P.u && v.house !== undefined && v.house.rec.x.length === 0)) return fail();
  // 5. P isn't an end, or it is this page's own (a switch-off or compaction it
  //    wrote: endedByMe; never a cheat's `e:1` carrying this page's key).
  if (res.base.ended && !endedByMe.has(res.base.sid)) return fail();
  // 6. Round u's verdicts were all checked, and the doc was whole.
  if (was.pending || !casinoWhole(st.t)) return fail();
  // 7. (B10) `was` decided no round past P.u on its chain: an honest trim cuts
  //    at the last decided round, so a later one is a premature cut or a race.
  if (was.rounds.some((v) => v.decided !== null && v.r > P.u)) return fail();
  // How round u was decided, when this page is sure: its own house reveal, the
  // one decision no unseen record can beat (the copies-carried case is 6a-3).
  let decided: { d: string; o: number | [number, number] } | undefined;
  if (at.decided === 'house' && at.house) {
    const o = st.game === 'craps' ? at.craps?.dice : at.pocket;
    if (o !== null && o !== undefined) decided = { d: `h:${at.house.hash}`, o };
  }
  // `a`: how far back the checker has folded every round itself. Consecutive
  // attestations chain (the new P trims the session the last one opened); else
  // it starts at this base's u (a base of `g` gives 0).
  const a = st.attested && st.attested.sid === P.b ? st.attested.a : was.base.u;
  const body = {
    v: 1 as const,
    b: P.b,
    u: P.u,
    l: P.l,
    n: P.n,
    ...(P.e !== undefined ? { e: P.e } : {}),
    ...(P.s !== undefined ? { s: P.s } : {}),
    ...(P.h !== undefined ? { h: P.h } : {}),
    ...(decided !== undefined ? { d: decided.d, o: decided.o } : {}),
    a,
    k: getIdentityPub(),
  };
  const rec: HouseSum = signed(st.ctx, 'hsum', body);
  writeHouseSum(st.t, st.inc, rec);
  st.attested = { sid: res.base.sid, a };
}

/** Whether the checkpoint table st counts puts a restore in motion. */
function forgedStands(st: TableState): boolean {
  return computedRestorePending(st.t, st.inc);
}

/** 🩹 The forged checkpoint gone: the head back, what this page wrote
 *  meanwhile goes (its seeds kept: the same forged checkpoint may be
 *  written again, and a close of that session then freezes its slips);
 *  else the table moved on from the head's session. What this page wrote
 *  since into the session that now stands goes on. */
function endForged(st: TableState, res: FoldResult): void {
  const f = st.forged!;
  st.forged = null;
  // 🩹 A felt the player queued while the forgery stood was composed against
  // the forged view, so drop it: flushDuty must never write it into the
  // restored session (the window is still open, so it is re-placed on the true
  // view). Only the forged-ending path clears it here; a plain move keeps the
  // round-after felt through movedOn's own r <= u rule.
  st.pending = null;
  if (res.base.sid === f.sid) {
    letGo(st, (_m, key) => f.mine.has(key), () => false);
    return;
  }
  const since = res.base.sid === f.on ? new Set([...st.mine.keys()].filter((key) => !f.since.has(key))) : null;
  movedOn(st, f.res, res, since, true);
}

/** The session moved on from `was`'s to `res`'s (a trim): by how much the
 *  checkpoint differs from what this page had folded, and what this page
 *  kept of the rounds it covers goes (noteResult); but for `since`, what it
 *  wrote into `res`'s session since (endForged). */
function movedOn(st: TableState, was: FoldResult, res: FoldResult, since: ReadonlySet<string> | null = null, fromForged = false): void {
  const d = checkpointDiff(was, res);
  st.cpDiff = { sid: res.base.sid, chips: clampSafe(d.nets + d.carry), nets: clampSafe(d.nets), carry: d.carry > 0n };
  const u = res.base.u;
  for (const key of [...st.seen.keys()]) if ((parseKey(key)?.r ?? 0) <= u) st.seen.delete(key);
  for (const [id, e] of [...st.decided]) if (e.r < u) st.decided.delete(id);
  for (const [h, e] of [...st.opened]) if (e.r <= u) st.opened.delete(h);
  if (st.pending && st.pending.r <= u) st.pending = null;
  st.missingAt.clear();
  st.seedOutAt = null;
  st.askedFor = null;
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
  //
  // (Their seeds go only for the rounds the checkpoint covers: the session
  // moved from may come back, the lower of two rival trims restored over
  // by the page that counted the higher, and a close of it then freezes
  // them. The seed store holds 256. An earlier build forgot them all.)
  const lastClosed = Math.max(was.rounds.length > 0 ? was.rounds[was.rounds.length - 1].r : was.base.u, playedTo(st, was));
  const ses = computedSessionForWrite(st.t);
  // 🩹 The "round after, never seen closed" keep is for a plain trim, where
  // this page's own round-(u+1) slip was composed against the session that
  // the trim carried forward. Ending a forgery is not that: the round-(u+1)
  // slip was composed against the forged view, so it is kept only where the
  // surviving session actually holds it (`ses`) or this page wrote it there
  // since (`since`) — never reput into the honest session on `m.r > lastClosed`
  // alone, which would copy the forged slip across.
  letGo(st, (m, key) => since?.has(key) === true || (m.r === u + 1 && (ses?.has(key) === true || (!fromForged && m.r > lastClosed))), (r) => !computedRecoveryOn() || r <= u);
  // So too this page's window and fling: kept for the round after the
  // checkpoint if this page never saw it closed, else of a round the room
  // may not have kept, whose number the chain plays again. Kept, the
  // window would end betting on that round at once, and the fling would
  // close it at W with no fling offered its shooter.
  if (st.window && (st.window.r !== u + 1 || st.window.r <= lastClosed)) st.window = null;
  if (st.flung && (st.flung.r !== u + 1 || st.flung.r <= lastClosed)) st.flung = null;
  // The round the checkpoint kept, as this page last read it, if it did,
  // and its verdict: what the felt and the card show through the trim,
  // even once this page decided a round past it that the room didn't keep.
  const kept = was.rounds.find((v) => v.decided !== null && v.r === u && v.close === res.base.l);
  if (kept) st.lastD = kept;
  const check = res.base.l !== null ? st.checks.get(res.base.l) : undefined;
  st.checks.clear();
  if (check) st.checks.set(res.base.l!, check);
}

/** 🎲 Note an earlier roll on the chain that came to something else since
 *  this page last saw it (a late seed, a better forfeit, the other side of
 *  a split): one before the last decided roll, whose dice, the table it
 *  handed on or its wins and losses changed. The rolls after it paid again
 *  on their own dice; a slip of this page's player on one of them that was
 *  built on the table as it stood, and no longer is, had its changes undone
 *  (`undid`: the first and last such roll; a ride slip, which changed
 *  nothing, had none). For the table's notice. A session change starts the
 *  record afresh. */
function noteChanged(st: TableState, res: FoldResult, moved: boolean): void {
  if (st.game !== 'craps') return;
  if (moved) st.rolled.clear();
  const me = getPlayerId();
  const D = lastDecided(res);
  const on = new Set<number>();
  let first: number | null = null;
  const undid: number[] = [];
  let sc: Scan | null = null;
  for (const v of res.rounds) {
    if (!v.decided || !v.craps) continue;
    on.add(v.r);
    const o = v.craps.sOut;
    const key = JSON.stringify([
      v.craps.dice, o.p, o.h ?? null, o.a ?? null, o.i ?? 0, Object.keys(o.w).sort().map((pid) => [pid, own(o.w, pid)]),
      [...v.deltas].map(([pid, d]) => `${pid}:${d}`).sort(),
    ]);
    const basis = v.craps.fates.get(me) === 'basis' && !rodeAsBuilt(frozenSlip(sc ??= scanOf(st, res), v, me));
    const was = st.rolled.get(v.r);
    st.rolled.set(v.r, { key, basis });
    if (!was) continue;
    if (first === null && was.key !== key && D !== null && v.r < D.r) first = v.r;
    else if (first !== null && basis && !was.basis) undid.push(v.r);
  }
  for (const r of [...st.rolled.keys()]) if (!on.has(r)) st.rolled.delete(r);
  if (first !== null) {
    st.changed = { seq: st.changed.seq + 1, round: first, undid: undid.length > 0 ? [undid[0], undid[undid.length - 1]] : null };
  }
}

/** 🎲 Whether a craps slip changed nothing on the table it was built on:
 *  its felt is the one its stamp names (a ride slip, which a seated rider's
 *  page writes each roll). The stamp hides the point it was built on, so
 *  any point. No slip: not known to (a change, as the fold's fate says). */
function rodeAsBuilt(rec: AnySlipRec | null): boolean {
  if (!rec) return false;
  const s = rec as CrapsSlipRec;
  const w: Record<string, CrapsBet[]> = Object.create(null);
  w[s.p] = s.b;
  return [...CARRY_POINTS].some((p) => basisOf({ p, w }, s.p) === s.o);
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
 *  player (`nets`); 0 when `was` hadn't folded as far as the checkpoint goes
 *  (this page can't tell). At craps also what the checkpoint hands on
 *  against the table's state this page had after round u (`carry`:
 *  carryDiff). */
function checkpointDiff(was: FoldResult, res: FoldResult): { nets: bigint; carry: bigint } {
  const u = res.base.u;
  const at = was.rounds.find((v) => v.decided && v.r === u);
  if (!at) return { nets: 0n, carry: 0n };
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
  return { nets: diff, carry: at.craps ? carryDiff(at.craps.sOut, res.base.state as CrapsCarry) : 0n };
}

/** By how many chips two craps states' riding bets differ, spot by spot;
 *  at least one when only the point or the dice's hands differ. */
function carryDiff(a: CrapsCarry, b: CrapsCarry): bigint {
  let d = 0n;
  for (const pid of new Set([...Object.keys(a.w), ...Object.keys(b.w)])) {
    const x = new Map(own(a.w, pid).map((e) => [spotKey(e), e.amount]));
    const y = new Map(own(b.w, pid).map((e) => [spotKey(e), e.amount]));
    for (const k of new Set([...x.keys(), ...y.keys()])) d += BigInt(Math.abs((x.get(k) ?? 0) - (y.get(k) ?? 0)));
  }
  return d === 0n && (a.p !== b.p || a.h !== b.h || a.a !== b.a || a.i !== b.i) ? 1n : d;
}

/** Let go of what this page wrote that `keep` doesn't keep, and of the seeds
 *  behind those slips but a kept one's (a slip's versions share one) of the
 *  rounds `forget` gives up: nothing will reveal them now, and the seed
 *  store holds 256. */
function letGo(st: TableState, keep: (m: Mine, key: string) => boolean, forget: (r: number) => boolean = () => true): void {
  const me = getPlayerId();
  const gone = new Map<string, number>();
  for (const [key, m] of [...st.mine]) {
    if (keep(m, key)) continue;
    st.mine.delete(key);
    if (m.kind === 's' && forget(m.r)) gone.set((m.rec as AnySlipRec).c, m.r);
  }
  for (const m of st.mine.values()) if (m.kind === 's') gone.delete((m.rec as AnySlipRec).c);
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
    res, gen: clock.gen, ses, slipOf: st.slipOf,
    slips: new Map(), reveals: new Map(), closes: new Map(), forfeits: new Map(), abandons: new Map(), houses: new Map(), joins: new Map(),
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
        const at = pk.kind === 'c' ? sc.closes : pk.kind === 'f' ? sc.forfeits : pk.kind === 'z' ? sc.abandons
          : pk.kind === 'h' ? sc.houses : sc.joins;
        pushIn(at, pk.r, key);
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
  for (const at of [sc.closes, sc.forfeits, sc.abandons, sc.houses, sc.joins]) for (const keys of at.values()) take(keys);
  sc.last = last;
  return last;
}

/** The slip a round froze for `pid`, as the session holds it. */
function frozenSlip(sc: Scan, round: RoundView, pid: string): AnySlipRec | null {
  const hash = round.frozen[pid];
  return hash === undefined ? null : sc.slipOf(sc.ses?.get(`s:${round.r}:${pid}:${hash}`));
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
function placeOf(duty: Duty, ctx: FoldCtx, r: number, pubs: Iterable<string>, pub: string, memo?: Map<string, string>): number {
  const rank = (k: string): string => {
    if (!memo) return dutyRank(duty, ctx, r, k);
    const key = `${duty}|${ctx.room}|${ctx.t}|${ctx.inc}|${r}|${k}`;
    let v = memo.get(key);
    if (v === undefined) {
      if (memo.size >= RANKS_KEPT) memo.clear();
      memo.set(key, v = dutyRank(duty, ctx, r, k));
    }
    return v;
  };
  const ranked = [...new Set(pubs)].map((k) => [rank(k), k] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const i = ranked.findIndex(([, k]) => k === pub);
  return i < 0 ? ranked.length : i;
}

const RANKS_KEPT = 16_384;

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
 *  checked one: it hashes to its key (`keyOf`, the incarnation's game's)
 *  and its signature checked out (casinoDoc's verdict: the fold checks what
 *  it counts, and this page's own records are marked). */
function checkedSlip(t: string, inc: string, key: string, s: AnySlipRec, keyOf: (rec: unknown) => string | null): boolean {
  const h = parseKey(key)?.h;
  return h !== undefined && computedVerdictOf(t, inc, h) === true && keyOf(s) === key;
}

/** The pubs of every checked slip in table st's session, of any round and
 *  any version (one a close left out too), once per scan. */
function checkedSlipPubs(st: TableState, sc: Scan): Set<string> {
  if (sc.slipPubs) return sc.slipPubs;
  const out = new Set<string>();
  for (const byPid of sc.slips.values()) {
    for (const keys of byPid.values()) {
      for (const key of keys) {
        const s = st.slipOf(sc.ses?.get(key));
        if (s && !out.has(s.k) && checkedSlip(st.t, st.inc, key, s, st.keyOf)) out.add(s.k);
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
      const s = st.slipOf(sc.ses?.get(key));
      if (s && opened.has(s.c) && s.k === pin && checkedSlip(st.t, st.inc, key, s, st.keyOf)) return (sc.seedOut = true);
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
 * each counted slip and seed, the forfeit, abandon or house reveal), or for
 * a round a forfeit decided, not before the grace on this page's clock and
 * a second more. Kept per close and decision; for D taken out of the
 * session by a trim (`onChain` false), what was kept, or now.
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
      if (D.house) at = Math.max(at, seen(st, `h:${D.r}:${D.house.hash}`, now));
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
 *  later. Null before any chip: the window isn't armed. At craps a goodbye
 *  never starts one, nor does any version of a player whose latest one on
 *  the roll is a goodbye: a page leaving opens no roll (and a re-arm because
 *  everyone on the roll left isn't followed by a window the goodbye that
 *  made it opens, or a version before it that came in with it). */
function windowStart(st: TableState, sc: Scan, o: number, showEnd: number, now: number): number | null {
  const from = st.rearm && st.rearm.r === o ? st.rearm.at : -Infinity;
  const craps = st.game === 'craps' && o === sc.res.open;
  let first = Infinity;
  for (const [pid, keys] of sc.slips.get(o) ?? []) {
    if (craps && (sc.res.felts.get(pid)?.rec as CrapsSlipRec | undefined)?.l === 1) continue;
    const pin = keyFor(pid);
    for (const key of keys) {
      const s = st.slipOf(sc.ses?.get(key));
      if (!s || s.b.length === 0 || s.k !== pin || (s as CrapsSlipRec).l === 1) continue;
      const at = seen(st, key, now);
      if (at >= from && at < first) first = at;
    }
  }
  return first === Infinity ? null : Math.max(first, showEnd);
}

/**
 * When round o's window started on this page: the first start windowStart
 * gave for the round, kept (st.window) so a version that left the session
 * (a trim copies only latest versions) or one counted later at its arrival
 * stamp doesn't move it; but never before the end of the show on screen
 * (`showEnd`), so a late rewrite of the round before, shown again, gives
 * every player a full window after it. A re-arm clears what was kept
 * (build), and so does a wake.
 */
function windowOf(st: TableState, sc: Scan, o: number, showEnd: number, now: number): number | null {
  const w = st.window;
  if (w && w.r === o) return Math.max(w.at, showEnd);
  const at = windowStart(st, sc, o, showEnd, now);
  if (at !== null) st.window = { r: o, at };
  return at;
}

function payoutsOf(D: RoundView): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pid, paid] of D.payouts) if (paid > 0n) out[pid] = clampSafe(paid);
  return out;
}

function build(st: TableState, res: FoldResult, now: number): ViewEntry {
  const sc = scanOf(st, res);
  const chain = lastDecided(res);
  // (Past a trim, the round the checkpoint kept, if this page saw it: not
  // one it saw decided at that round on the other side of a split, which
  // the checkpoint dropped. The close is all the checkpoint names of it, so
  // a page that hears a forfeit beat the reveals it saw only with the trim
  // still shows the reveals' result, its card flagging the checkpoint.)
  const D = chain ?? (st.lastD && st.lastD.r === res.base.u && st.lastD.close === res.base.l ? st.lastD : null);
  const onChain = chain !== null;
  // The ⚙ card's verdict on D while its records are in the session: a trim
  // that takes them away leaves it (roundCheck), the card opened or not.
  if (onChain) checkOf(st, res, now);
  const show = D ? showStart(st, sc, D, onChain, now) : 0;
  // A forfeit's result waits out every page's grace.
  const held = D !== null && D.decided === 'forfeit' && now < show;
  if (st.game === 'craps') return buildCraps(st, res, sc, D, onChain, show, held, now);
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
    let start = windowOf(st, sc, round, showEnd, now);
    // Run out with every chip taken down: arm again on the next one, as an
    // owner-run table opens a fresh round after an empty one.
    if (start !== null && now >= start + BET_WINDOW_MS && ![...res.felts.values()].some((s) => s.rec.b.length > 0)) {
      st.rearm = { r: round, at: now };
      st.window = null;
      start = windowOf(st, sc, round, showEnd, now);
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
  const at = tableOf(t, 'roulette');
  return at ? viewOf(at.st, at.res, now).view as ComputedRouletteState : null;
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
  const at = tableOf(t, 'roulette');
  if (!at) return {};
  const e = viewOf(at.st, at.res, now);
  if (e.view.round !== round) return {};
  if (!e.bets) {
    const out: Record<string, RouletteBet[]> = {};
    if (e.view.phase === 'closing' && e.holding) {
      const sc = scanOf(at.st, e.res);
      for (const pid of e.holding.present) {
        const s = frozenSlip(sc, e.holding, pid);
        if (s) out[pid] = rouletteFelt(s);
      }
    } else if (e.view.phase === 'betting') {
      for (const [pid, s] of e.res.felts) if (s.rec.b.length > 0) out[pid] = rouletteFelt(s.rec);
    }
    e.bets = out;
  }
  return e.bets as Record<string, RouletteBet[]>;
}

/** Player `me`'s chips on round `round`'s felt (readComputedBets), with the
 *  felt this page holds back to write (the coalescing) laid over it. */
export function readMyComputedBets(t: string, me: string, round: number, now = Date.now()): RouletteBet[] {
  const bets = readComputedBets(t, round, now);
  const st = tables.get(t);
  const p = st?.pending;
  if (p && p.r === round && me === getPlayerId() && st!.view?.view.phase === 'betting' && st!.view.view.round === round) {
    return p.felt as RouletteBet[];
  }
  return bets[me] ?? [];
}

// ── 🎲 The craps table's phases and view ─────────────────────────────────────

/** What the holder's latest version on the roll says during the wait for
 *  the throw (display only: no turn reads it): a goodbye ('gone'); none,
 *  with riding bets ('absent': gone between rolls, or their page asleep);
 *  none and no riding bets, or an empty felt ('none': no bet down); chips
 *  and no stand ('away'); chips at a stand ('here'). */
export type ShooterSlip = 'gone' | 'absent' | 'none' | 'away' | 'here';

/**
 * A computed craps table's state in the shape the felt draws a PR 1 craps
 * table's in (phase, roll, point, dice, the shooter while one throws), plus
 * its incarnation and the dice's roll key: `<roll>:<d1><d2>` of the last
 * decided roll once its result may show, '' otherwise (the dice land again
 * only when it changes, so an honest rival close with the same dice moves
 * nothing, and a rewritten roll does). And what the table's own lines read.
 */
export interface ComputedCrapsState extends CrapsTableState {
  inc: string;
  rollKey: string;
  /** With the roll key, the record that decided its roll: the forfeit's
   *  hash, else the close's (a void has no faces, so no key). A roll held
   *  again for a forfeit's show that comes back on the decision whose faces
   *  already landed (a wake shows the last roll again) flies nothing; a new
   *  decision of it flies, even on the same faces. '' with no key. */
  rollBy: string;
  /** Who holds the dice now (absent: the stickman's hand). */
  holder?: string;
  /** The holder was counted at their stand on the last roll that had dice:
   *  the roll waits for their throw. */
  shooterInPlay: boolean;
  /** During the wait for the throw: the holder's latest version on the roll
   *  (ShooterSlip), and whether it says no bet down. */
  shooterSlip?: ShooterSlip;
  shooterNoBet?: boolean;
  /** Closing with no close in, on a page with no felt of its own on the
   *  roll, once every close turn has passed: when betting opens again (the
   *  re-arm after a crash, a hidden tab or a dead link). */
  stallUntil?: number;
  /** The end of the show before this roll's window (0 with none): a throw
   *  from before a re-show of the last roll doesn't play after it. */
  showEnd: number;
  /** When this page last took this roll back to betting (a re-arm), if it
   *  did: a throw seen by then doesn't play once the roll closes again. */
  rearmAt?: number;
  /** Settled: pid → won (or lost, negative) this roll, for pids with a bet
   *  decided on it; the pids whose only decided bets pushed; who holds the
   *  dice after the roll. */
  amounts?: Record<string, number>;
  pushes?: string[];
  shooterAfter?: string;
  /** Settled: who held the dice before the roll (absent: the stickman), and
   *  the point before it (null: a come-out). */
  holderBefore?: string;
  pointBefore?: number | null;
  /** How many players have bets riding on the table as it shows: into the
   *  roll on screen while one is held, else into the next. */
  riders: number;
}

/** The view of a craps incarnation (build, after its common part: the last
 *  decided roll D, when its result shows, whether a forfeit holds it). The
 *  same phases as roulette's, with the craps beats, then, once the window
 *  runs out, the wait for the throw while the holder is in play, and the
 *  re-arms that let a roll everyone left, or one nobody closes, take bets
 *  again. */
function buildCraps(
  st: TableState, res: FoldResult, sc: Scan, D: RoundView | null, onChain: boolean, show: number, held: boolean, now: number,
): ViewEntry {
  const me = getPlayerId();
  const carry = res.carry as CrapsCarry;
  const showEnd = D ? show + CRAPS_SHOW_MS : 0;
  // (A fling of this page's made before the show on screen ends came before
  // a re-show of the roll before: the shooter throws again.)
  if (st.flung && st.flung.at < showEnd) st.flung = null;
  let phase: CrapsTableState['phase'];
  let round: number;
  let holding: RoundView | null = null;
  let validUntil = Infinity;
  let deadline: number | undefined;
  let point: number | null = carry.p === 0 ? null : carry.p;
  let holder = carry.h;
  let inPlay = carry.i === 1;
  let shooter: string | undefined;
  let shooterSlip: ShooterSlip | undefined;
  let stallUntil: number | undefined;
  let betEnd: number | undefined;
  if (res.tip) {
    phase = 'closing';
    round = res.tip.r;
    holding = res.tip;
  } else if (D && held) {
    // (The roll before its result: the point and the dice's holder as they
    // stood when it was thrown.)
    phase = 'closing';
    round = D.r;
    holding = D;
    validUntil = show;
    point = D.craps?.pointBefore ?? null;
    holder = D.craps?.sIn.h;
    inPlay = D.craps?.sIn.i === 1;
  } else if (D && now < showEnd) {
    phase = 'settled';
    round = D.r;
    validUntil = showEnd;
  } else {
    round = res.open;
    const waits = carry.h !== undefined && carry.i === 1;
    // (A close of the roll still being checked: no tip yet, but no more
    // turns, and no wait.)
    const closeIn = res.openCloses.some((c) => c.state !== 'invalid');
    const chips = [...res.felts.values()].filter((s) => s.rec.b.length > 0);
    const mine = res.felts.get(me);
    const ownChips = mine !== undefined && mine.rec.b.length > 0 && (mine.rec as CrapsSlipRec).l !== 1;
    const n = new Set(chips.map((s) => s.rec.k)).size;
    // W: the end of betting; then the wait; `stall`, once every ordinary
    // close turn has passed.
    const timesOf = (start: number): { W: number; stall: number } => {
      const W = start + CRAPS_BET_WINDOW_MS;
      return { W, stall: (waits ? W + CRAPS_SHOOTER_MS : W) + (n + 1) * STAGGER_MS };
    };
    let start = windowOf(st, sc, round, showEnd, now);
    if (start !== null) {
      const { W, stall } = timesOf(start);
      // Run out with every chip taken down (roulette's rule); everyone with
      // chips on the roll has said goodbye (at once: the window lets go of
      // the gone); or, on a page with no felt of its own, nobody closed it
      // well past every turn (the bettors' pages crashed, hid or lost their
      // link), so a newcomer can bet.
      if ((now >= W && chips.length === 0)
        || (chips.length > 0 && chips.every((s) => (s.rec as CrapsSlipRec).l === 1))
        || (!ownChips && !closeIn && now >= stall + GRACE_MAX_MS)) {
        st.rearm = { r: round, at: now };
        st.window = null;
        start = windowOf(st, sc, round, showEnd, now);
      }
    }
    if (start === null) {
      phase = 'betting';
    } else {
      const { W, stall } = timesOf(start);
      const end = W + CRAPS_SHOOTER_MS;
      betEnd = W;
      if (now < W) {
        phase = 'betting';
        deadline = W;
      } else if (waits && !closeIn && now < end) {
        // The wait for the throw. No fling offered on the holder's own page
        // while their player has no felt of their own down (the stickman
        // throws when it ends): the wait itself is the room's.
        phase = 'closing';
        deadline = end;
        shooter = carry.h === me && !ownChips ? undefined : carry.h;
        const hl = res.felts.get(carry.h!);
        const rec = hl?.rec as CrapsSlipRec | undefined;
        shooterSlip = !rec ? (own(carry.w, carry.h!).length > 0 ? 'absent' : 'none')
          : rec.l === 1 ? 'gone' : rec.b.length === 0 ? 'none' : rec.t === undefined ? 'away' : 'here';
      } else {
        phase = 'closing';
        if (!ownChips && !closeIn && now >= stall) stallUntil = stall + GRACE_MAX_MS;
      }
      for (const at of [W, end, stall, stall + GRACE_MAX_MS]) if (at > now && at < validUntil) validUntil = at;
    }
  }
  const settled = phase === 'settled' && D !== null;
  const roll = D?.craps;
  const dice = settled && roll?.dice ? roll.dice : null;
  const view: ComputedCrapsState = {
    kind: 'craps',
    phase,
    round,
    point: settled ? roll?.pointAfter ?? null : point,
    dice,
    result: dice ? dice[0] + dice[1] : null,
    resultAt: settled ? show : 0,
    payouts: settled ? payoutsOf(D!) : null,
    ...(settled && roll?.sevenOut ? { sevenOut: true } : {}),
    ...(settled && D!.decided === 'void' ? { voided: true } : {}),
    ...(deadline !== undefined ? { phaseDeadline: deadline } : {}),
    ...(phase === 'betting' && holder !== undefined ? { shooter: holder } : shooter !== undefined ? { shooter } : {}),
    inc: st.inc,
    rollKey: D && roll?.dice && !held ? `${D.r}:${roll.dice[0]}${roll.dice[1]}` : '',
    rollBy: D && roll?.dice && !held ? D.forfeit?.hash ?? D.close : '',
    ...(holder !== undefined ? { holder } : {}),
    shooterInPlay: inPlay,
    ...(shooterSlip !== undefined ? { shooterSlip, shooterNoBet: shooterSlip === 'none' } : {}),
    ...(stallUntil !== undefined ? { stallUntil } : {}),
    showEnd,
    ...(st.rearm?.r === round ? { rearmAt: st.rearm.at } : {}),
    ...(settled && roll ? {
      amounts: amountsOf(roll.amounts),
      pushes: [...roll.pushes].sort(),
      ...(roll.sOut.h !== undefined ? { shooterAfter: roll.sOut.h } : {}),
      ...(roll.sIn.h !== undefined ? { holderBefore: roll.sIn.h } : {}),
      pointBefore: roll.pointBefore,
    } : {}),
    riders: Object.keys((holding === D && roll ? roll.sIn : carry).w).length,
  };
  const key = `${phase}|${round}|${deadline ?? ''}|${view.rollKey}|${view.shooter ?? ''}|${stallUntil ?? ''}`;
  return { res, gen: clock.gen, builtAt: now, validUntil, view, key, firstKey: key, D, onChain, holding, ...(betEnd !== undefined ? { betEnd } : {}) };
}

function amountsOf(m: ReadonlyMap<string, bigint>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pid, n] of m) out[pid] = clampSafe(n);
  return out;
}

/**
 * The state of computed craps table `t` on this page's clock, shaped as a
 * CrapsTableState (ComputedCrapsState): null when t isn't a computed craps
 * table or casinoDoc has counted nothing of it yet. Cached, as roulette's.
 */
export function readComputedCraps(t: string, now = Date.now()): ComputedCrapsState | null {
  lookAtClock(now);
  const at = tableOf(t, 'craps');
  return at ? viewOf(at.st, at.res, now).view as ComputedCrapsState : null;
}

/** The felt pid's latest version on the open roll stands for while no close
 *  is in: its own when its stamp matches and the table rules allow the
 *  change, else the riding bets (computedCraps standingOf's rule). */
function standingFelt(carry: CrapsCarry, pid: string, s: SlipInfo | undefined): CrapsBet[] {
  const C = own(carry.w, pid);
  const rec = s?.rec as CrapsSlipRec | undefined;
  return rec && rec.o === basisOf(carry, pid) && changeOk(C, rec.b, carry.p === 0 ? null : carry.p) ? rec.b : C;
}

/**
 * Each player's chips on computed craps table `t`'s felt for roll `round`
 * as this page shows them: while betting, during the wait for the throw and
 * while nobody has closed the roll, each player's standing felt (their
 * latest version's if it was built on the table as it stands, else their
 * riding bets) and every rider with no version at their riding bets; while
 * a close holds the roll (the tip, or a forfeit's roll before its result),
 * each player's felt as the roll plays it; while settled, what rides on.
 * Empty for any other roll.
 */
export function readComputedCrapsBets(t: string, round: number, now = Date.now()): Record<string, CrapsBet[]> {
  lookAtClock(now);
  const at = tableOf(t, 'craps');
  if (!at) return {};
  const e = viewOf(at.st, at.res, now);
  if (e.view.round !== round) return {};
  if (!e.bets) {
    const out: Record<string, CrapsBet[]> = {};
    const carry = e.res.carry as CrapsCarry;
    const roll = e.holding?.craps;
    if (e.holding && roll) {
      const sc = scanOf(at.st, e.res);
      for (const [pid, fate] of roll.fates) {
        const s = fate === 'ok' ? frozenSlip(sc, e.holding, pid) : null;
        const B = s ? s.b as CrapsBet[] : own(roll.sIn.w, pid);
        if (B.length > 0) out[pid] = B;
      }
    } else if (e.view.phase === 'settled') {
      for (const pid of Object.keys(carry.w)) out[pid] = own(carry.w, pid);
    } else {
      for (const pid of new Set([...Object.keys(carry.w), ...e.res.felts.keys()])) {
        const B = standingFelt(carry, pid, e.res.felts.get(pid));
        if (B.length > 0) out[pid] = B;
      }
    }
    e.bets = out;
  }
  return e.bets as Record<string, CrapsBet[]>;
}

/**
 * Player `me`'s felt on computed craps table `t`'s roll `round`, and the
 * stamp a change of it is built on (basisOf the table as this page has it):
 * the felt this page holds back to write when it was built on that state
 * and betting is open on the roll (a held felt never goes once betting
 * ends, so it isn't shown then), else the felt readComputedCrapsBets shows.
 * A write passes the stamp back (writeComputedCrapsSlip): a felt built
 * before the roll before changed is refused, not written over the new one.
 */
export function readMyComputedCrapsBets(t: string, me: string, round: number, now = Date.now()): { felt: CrapsBet[]; basis: string } {
  const bets = readComputedCrapsBets(t, round, now);
  const st = tables.get(t);
  const carry = (st?.lastRes?.carry as CrapsCarry | undefined) ?? EMPTY_CARRY;
  const basis = basisOf(carry, me);
  const p = st?.pending;
  const v = st?.view?.view;
  if (p && p.r === round && p.basis === basis && me === getPlayerId() && v?.phase === 'betting' && v.round === round) {
    return { felt: p.felt as CrapsBet[], basis };
  }
  return { felt: bets[me] ?? [], basis };
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
  /** 🏠 Whether the round was a Fair one (its close named a house
   *  commitment); `decided` is 'house' when the house's reveal decided it. */
  fair: boolean;
  /** 🚩 Bettors the house's reveal left out whose seed this page saw in the
   *  grace, before it saw the house's reveal. */
  houseDropped: string[];
  /** A Fair round an abandon voided, no house reveal listing its close
   *  (this page has): the house never revealed its seed. */
  houseVoid: boolean;
  /** A Fair round an abandon voided while the house's reveal listing it
   *  waited on seeds this page never had: those bettors (sorted). The house
   *  revealed; the round went void for want of theirs. */
  houseWaited: string[];
  /** 🚩 Bettors whose frozen slip a key other than their pinned one signed. */
  pinMismatch: string[];
  /** 🚩 Chips by which the checkpoint opening this session differs from what
   *  this page had folded of those rounds (0: it agrees, or can't tell); at
   *  craps its riding bets too, spot by spot, and one for a point or a
   *  holder that differs. */
  checkpointDiff: number;
  /** 🚩 The last round this page saw decided and then replaced by a close
   *  that came after its seeds were out (noteReplaced); absent for none. */
  replaced?: number;
  /** 🚩 At craps: players whose slip broke a table rule on the roll (its
   *  changes didn't apply). A slip built on a table that changed under it,
   *  or a newcomer at a full table, is no rule broken. */
  illegal?: string[];
  /** At craps, on a roll a forfeit decided: the other bettors the close
   *  froze whose seed didn't count (it never came, or came late), sorted. A
   *  rider who adds nothing can hold its seed back once it has seen the
   *  others' and have the forfeit draw again without it: the card names
   *  them. */
  uncounted?: string[];
  /** At craps: the roll as it went (no dice on a void), the point after it
   *  and whether it sevened out; how many players' bets rode on it with no
   *  slip of theirs frozen, so no seed of theirs in the dice; this page's
   *  player's part (crapsMine: the chips they added and lost, whether they
   *  added any); and the checkpoint's difference split, the nets by chips
   *  and whether the table it hands on differs (riding bets, point, the
   *  dice's hands). */
  roll?: { dice: [number, number] | null; pointBefore: number | null; pointAfter: number | null; sevenOut: boolean };
  unseeded?: number;
  mineLost?: number;
  mineAdded?: boolean;
  checkpointNets?: number;
  checkpointCarry?: boolean;
}

/** At craps: the checkpoint's difference split (ComputedRoundCheck). */
const cpPartsOf = (st: TableState, res: FoldResult): { checkpointNets?: number; checkpointCarry?: boolean } => {
  if (st.game !== 'craps') return {};
  const d = st.cpDiff && st.cpDiff.sid === res.base.sid ? st.cpDiff : null;
  return { checkpointNets: d?.nets ?? 0, checkpointCarry: d?.carry ?? false };
};

const replacedOf = (st: TableState): { replaced?: number } => (st.replaced !== null ? { replaced: st.replaced } : {});

/** The craps fields of decided roll D's check (ComputedRoundCheck). */
function crapsCheck(st: TableState, sc: Scan, res: FoldResult, D: RoundView, me: string): Partial<ComputedRoundCheck> {
  const roll = D.craps!;
  const mine = crapsMine(st, sc, D, me, getIdentityPub());
  return {
    illegal: [...roll.fates].filter(([, f]) => f === 'illegal').map(([pid]) => pid).sort(),
    uncounted: D.decided === 'forfeit' || D.decided === 'house' ? D.present.filter((pid) => pid !== me && !D.counted.includes(pid)) : [],
    roll: { dice: roll.dice, pointBefore: roll.pointBefore, pointAfter: roll.pointAfter, sevenOut: roll.sevenOut },
    unseeded: [...roll.fates.values()].filter((f) => f === 'rider').length,
    mineLost: mine.lost,
    mineAdded: mine.added,
    ...cpPartsOf(st, res),
  };
}

function roundCheck(st: TableState, res: FoldResult, now: number): ComputedRoundCheck | null {
  const D = lastDecided(res);
  const diff = st.cpDiff && st.cpDiff.sid === res.base.sid ? st.cpDiff.chips : 0;
  if (!D) {
    // A trim took the round out of the session: what this page said of it,
    // if it is the round the checkpoint kept.
    const kept = res.base.l !== null ? st.checks.get(res.base.l) : undefined;
    return kept?.round === res.base.u ? { ...kept, checkpointDiff: diff, ...replacedOf(st), ...cpPartsOf(st, res) } : null;
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
  let houseDropped: string[] = [];
  // Only of a close stamped as it came (not before a wake: a load stamps it
  // with everything else) and seen before the forfeit, or the house's
  // reveal: otherwise every seed reads as seen with it, in time or not. (Of
  // the house's, only a seed seen before its reveal: one that crossed it on
  // the way counts nothing, and the house can't have had it.)
  const closeAt = computedSeenAt(st.t, `c:${D.r}:${D.close}`);
  const H = D.decided === 'house' ? D.house : undefined;
  if ((F || H) && closeAt !== undefined && closeAt > clock.realFrom) {
    const closeSeen = seen(st, `c:${D.r}:${D.close}`, now);
    const byAt = F ? seen(st, `f:${D.r}:${D.forfeit!.hash}`, now) : seen(st, `h:${D.r}:${H!.hash}`, now);
    if (closeSeen < byAt) {
      const times = revealsSeen(st, sc, D, now);
      const until = closeSeen + graceOf(closeSeen, times.values());
      const inTime = (pid: string): boolean => (times.get(pid) ?? Infinity) <= until;
      if (F) dropped = D.present.filter((pid) => !F.n.includes(pid) && inTime(pid));
      else houseDropped = D.present.filter((pid) => !D.counted.includes(pid) && inTime(pid) && times.get(pid)! < byAt);
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
    fair: D.closeRec.h !== undefined,
    houseDropped,
    houseVoid: D.decided === 'void' && D.closeRec.h !== undefined && D.house === undefined && D.houseWaits === undefined,
    houseWaited: D.decided === 'void' ? D.houseWaits ?? [] : [],
    pinMismatch,
    checkpointDiff: diff,
    ...replacedOf(st),
    ...(D.craps ? crapsCheck(st, sc, res, D, me) : {}),
  };
  st.checks.set(D.close, out);
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

/** A craps slip's fields besides its felt: the stamp of the table it was
 *  built on, the stand its page stands at (none: that page has no table
 *  session there), and the goodbye mark. */
interface CrapsExtra {
  o: string;
  t?: number;
  l?: 1;
}

/** A craps slip's own fields, as a re-commit writes them again: only the
 *  seed, the commitment and the version change. Nothing at roulette. */
function extraOf(st: TableState, rec: AnySlipRec): CrapsExtra | undefined {
  if (st.game !== 'craps') return undefined;
  const c = rec as CrapsSlipRec;
  return { o: c.o, t: c.t, l: c.l };
}

/** Write a version of this page's player's felt on round o: the commitment
 *  of their latest one when this page holds its seed and it isn't burned
 *  (unless `fresh`), else a new seed's; v one past every version of theirs
 *  the session holds (another tab's too, under the same key: the felt the
 *  fold counts is the highest checked one), and past every one this page
 *  wrote (a trim may have taken them out of the session: a version put back
 *  later must not read as newer than this one). At craps with `extra`, the
 *  slip's other fields, signed with the felt (a craps slip without them is
 *  no slip: its key reads null, and nothing is written). */
function writeSlip(
  st: TableState, res: FoldResult, o: number, felt: RouletteBet[] | CrapsBet[], fresh: boolean, now: number, extra?: CrapsExtra,
): boolean {
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
  for (const m of st.mine.values()) if (m.kind === 's' && m.r === o && (m.rec as AnySlipRec).v > v) v = (m.rec as AnySlipRec).v;
  const more = extra
    ? { o: extra.o, ...(extra.t !== undefined ? { t: extra.t } : {}), ...(extra.l === 1 ? { l: 1 as const } : {}) }
    : {};
  const rec = signed(st.ctx, 'slip', { r: o, p: me, v: v + 1, b: felt, ...more, c, k: pub });
  const key = st.keyOf(rec);
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

/** The same felt, of either game (a craps felt is canonical, one spelling). */
const sameFelt = (a: readonly (RouletteBet | CrapsBet)[], b: readonly (RouletteBet | CrapsBet)[]): boolean => canon(a) === canon(b);

/** A roulette slip's felt: the fold reads a roulette incarnation's slips
 *  with asSlip, so every felt these roulette paths see is a roulette one. */
const rouletteFelt = (rec: AnySlipRec): RouletteBet[] => rec.b as RouletteBet[];

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

/** …and at craps, a change the table rules don't allow now ('rules'), or
 *  one built before the roll before changed ('changed': the felt it was
 *  built on is gone, so nothing of it is written); and chips from a
 *  newcomer at a table holding MAX_TABLE_PIDS players ('crowded': no close
 *  freezes them, until the table is switched off and on). */
export type ComputedSlipWrite = 'ok' | 'reconnecting' | 'closed' | 'full' | 'chips' | 'rules' | 'changed' | 'crowded';

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
  // (Not a computed roulette table, or nothing counted of it yet: nothing
  // to write to.)
  const at = tableOf(t, 'roulette');
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
  if (clean.length > 0 && crowdedOut(t, me)) return 'crowded';
  // A place at a full table is a written felt with chips on it: a held one
  // isn't on the table yet (the flush asks again).
  const refused = refusal(res, me, clean, (cur?.rec.b.length ?? 0) > 0);
  if (refused) return refused;
  if (!slipDue(st, o, e.view.phaseDeadline, now)) {
    st.pending = { r: o, felt: clean };
    return 'ok';
  }
  st.pending = null;
  if (!sameFelt(cur ? rouletteFelt(cur.rec) : [], clean) && !writeSlip(st, res, o, clean, false, now)) return 'reconnecting';
  return 'ok';
}

/** A list of chips (a bet a chip, as the felt draws them) as the canonical
 *  felt a craps slip carries: summed per spot, sorted. Throws on anything a
 *  slip can't carry. */
function cleanCrapsFelt(perChip: readonly CrapsBet[]): CrapsBet[] {
  if (!Array.isArray(perChip) || perChip.length > MAX_BETS_PER_PLAYER) throw new TypeError('writeComputedCrapsSlip: not a felt');
  for (const b of perChip) if (!isCrapsBet(b)) throw new TypeError('writeComputedCrapsSlip: not a craps bet');
  const felt = canonFelt(perChip);
  if (!isCanonFelt(felt)) throw new TypeError('writeComputedCrapsSlip: more than a slip can carry');
  return felt;
}

/** Why craps felt `felt` may not go down for this page's player now, or
 *  null: chips from a newcomer (no riding bets, and no felt with chips on
 *  the roll yet) when the table has no place left as the fold counts it —
 *  every rider at the start of the roll, gone ones and ones who took
 *  everything down since included, and every other newcomer with chips on
 *  it ('full'); or more chips than they have past what the felt holds now
 *  ('chips': readChips already takes that hold off). */
function crapsRefusal(res: FoldResult, me: string, felt: readonly CrapsBet[]): 'full' | 'chips' | null {
  const carry = res.carry as CrapsCarry;
  const stake = feltSum(felt);
  const cur = res.felts.get(me);
  if (stake > 0 && own(carry.w, me).length === 0 && !(cur && cur.rec.b.length > 0)) {
    let n = Object.keys(carry.w).length;
    for (const [pid, s] of res.felts) if (pid !== me && own(carry.w, pid).length === 0 && s.rec.b.length > 0) n += 1;
    if (n >= MAX_RIDERS) return 'full';
  }
  return stake - Number(res.held.get(me) ?? 0n) > readChips(me) ? 'chips' : null;
}

/** Whether `cur` (this page's player's latest version on the roll) already
 *  says `felt`, built on `basis`, at `stand`: nothing to write. */
function crapsSlipStands(cur: SlipInfo | undefined, felt: readonly CrapsBet[], basis: string, stand: number | undefined): boolean {
  const rec = cur?.rec as CrapsSlipRec | undefined;
  return rec !== undefined && rec.o === basis && rec.l !== 1 && rec.t === stand && sameFelt(rec.b, felt);
}

/**
 * Put this page's player's whole felt down on computed craps table `t`'s
 * open roll, as a list of chips (canonicalised here), built on `basis`
 * (readMyComputedCrapsBets: the table as this page had it when the change
 * was made). 'changed' when the roll before changed since (a late seed, a
 * rewritten roll: the felt it was built on is gone); 'rules' for a change
 * the table rules don't allow now (a contract bet taken down, a line bet
 * with a point on); else as writeComputedSlip, the stand this page's table
 * session stands at signed in with it (none off the table).
 */
export function writeComputedCrapsSlip(t: string, perChip: readonly CrapsBet[], basis: string, now = Date.now()): ComputedSlipWrite {
  lookAtClock(now);
  if (!tablesAwake(now) || !casinoWhole(t) || !computedSettled(t)) return 'reconnecting';
  const at = tableOf(t, 'craps');
  if (!at) return 'reconnecting';
  const { st, res } = at;
  const e = viewOf(st, res, now);
  // (A page that said goodbye writes nothing more: leaveComputedTables.)
  if (e.view.phase !== 'betting' || st.left) return 'closed';
  const o = e.view.round;
  const clean = cleanCrapsFelt(perChip);
  const me = getPlayerId();
  const carry = res.carry as CrapsCarry;
  if (basis !== basisOf(carry, me)) return 'changed';
  if (!changeOk(own(carry.w, me), clean, carry.p === 0 ? null : carry.p)) return 'rules';
  if (!computedSessionForWrite(t)) return 'reconnecting';
  if (feltSum(clean) > 0 && own(carry.w, me).length === 0 && crowdedOut(t, me)) return 'crowded';
  const refused = crapsRefusal(res, me, clean);
  if (refused) return refused;
  if (!slipDue(st, o, e.view.phaseDeadline, now)) {
    st.pending = { r: o, felt: clean, basis };
    st.changes += 1;
    return 'ok';
  }
  st.pending = null;
  const stand = localStandOf(t, me);
  if (!crapsSlipStands(res.felts.get(me), clean, basis, stand)) {
    if (!writeSlip(st, res, o, clean, false, now, { o: basis, t: stand })) return 'reconnecting';
    st.changes += 1;
  }
  return 'ok';
}

// ── 🧹 Duties ─────────────────────────────────────────────────────────────────

/** A table World passes the computed duties: its id and its game (a bare id
 *  is a roulette table's, as World passed them before craps). */
export type ComputedTableRef = string | { id: string; game: GameName };

/**
 * Move computed tables `tables` along from this page (world.ts calls it
 * every frame with the room's tables; each table runs at most every
 * TICK_MS): a switch a peer took away put back first (every frame), then its
 * reveals as soon as the room's state is in, then, on a whole doc, awake and
 * with every signature checked, the held felt, the riding bets (at craps),
 * a burned commitment renewed, the close, an ask for a seed still missing, a
 * forfeit, an answer to a forfeit, an abandon, the re-put and the trim, each
 * in its turn; the end of a computed table no longer among them, or whose
 * incarnation's name says another game than the table's (awayDuty:
 * `tables` are all the room's tables of the games World passes, with their
 * games); and the compaction of any ended incarnation, of these tables or
 * not. A phase this page's clock alone moved on tells the table's listeners
 * once.
 */
export function tickComputedTables(tables: Iterable<ComputedTableRef>, now = Date.now()): void {
  lookAtClock(now);
  // (The hearing's read too: a clock gone back is a deaf spell, seen though
  // no duty asks before the clock comes round again.)
  noteClockRead(now);
  const inRoom = new Map<string, GameName>();
  for (const ref of tables) {
    const t = typeof ref === 'string' ? ref : ref.id;
    const game = typeof ref === 'string' ? 'roulette' : ref.game;
    inRoom.set(t, game);
    putSwitchBack(t, now);
    const at = tableOf(t, game);
    if (!at) continue;
    const { st } = at;
    if (st.tickedAt !== null && now >= st.tickedAt && now - st.tickedAt < TICK_MS) continue;
    st.tickedAt = now;
    tickTable(st, now);
    tellPhase(st, now);
  }
  // A live table out of the room ends; ended incarnations, whatever tables
  // were passed (a removed one isn't), are compacted.
  awayDuty(inRoom, now);
  compactDuty(getIdentityPub(), now);
  recoverDuty(getIdentityPub(), now);
  houseDuty(now);
}

/**
 * 🚪 End a computed table that is out of the room's tables (`inRoom`) while
 * its switch is still on, or whose incarnation's name says another game
 * than the table it is under (no duty runs on it: tableOf), as its removal
 * would have ended it (casinoDoc
 * writeComputedGone: its `gone:` mark, its switch deleted), once this page
 * has seen it so for AWAY_MS, awake, its room's state in, its doc whole and
 * checked all the while (a wake, a frame that isn't, or the table back in
 * the room starts the wait again). A removal ends the table on every page
 * that runs it (clearTableKeys), but only there: a page that wasn't in the
 * room then, or joined after, never does, and an earlier build's removal
 * leaves the switch (it knows nothing of it), as does a switch-on at the
 * moment of a removal, the removal's delete reaching a key not written yet.
 * Left so, the incarnation would read live for good on every page that came
 * later: its open felts holding their players' chips, casino-wide, with no
 * table left to take them down at, nor anything for compaction to end. Once
 * it ends, they hold nothing, its decided nets count on, and compaction
 * finalises its sessions in turn. The wait covers the room's layout
 * catching up after a join (World's tables are the layout's), and the
 * moment between a removal and its teardown on the page removing it. Every
 * page writes the same few keys, and only until one of them lands. Not on a
 * frame whose doc was bound afresh since this page looked at its clock.
 */
function awayDuty(inRoom: ReadonlyMap<string, GameName>, now: number): void {
  if (casinoDocEpoch() !== clock.epoch) return;
  away.clear();
  const watching = new Set<string>();
  const ready = tablesAwake(now);
  for (const { t, inc } of computedLiveTables()) {
    if (inRoom.get(t) === gameOfInc(inc)) continue;
    const key = `${t}:${inc}`;
    away.add(key);
    if (!ready || !casinoWhole(t) || !computedSettled(t)) continue;
    watching.add(key);
    let at = awayAt.get(key);
    if (at === undefined || at > now) awayAt.set(key, at = now);
    if (now - at < AWAY_MS) continue;
    if (transactCasino(() => writeComputedGone(t, inc))) away.delete(key);
  }
  for (const key of [...awayAt.keys()]) if (!watching.has(key)) awayAt.delete(key);
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
  revealDuty(st, me, now);
  noteMissing(st, now);
  if (!casinoWhole(st.t) || !tablesAwake(now) || !computedSettled(st.t)) return;
  // 🩹 While a peer's rewind or jump stands, in its restore's wait, nothing
  // of the head's session goes into the session it opens, nor does a trim
  // build on it, nor does what this page saw played of the head's session
  // give way to the forged one's (noteChain: put back over a deleted
  // session, the head's rounds are held until they come back); the rest
  // plays on, as on every build (noteResult). Gated on the LIVE trigger
  // (forgedStands → computedRestorePending), not st.forged: a rewind read
  // before this table's first fold had a `was` to move from leaves st.forged
  // null though the restore is pending, and the duties must still stand off
  // the forged session. st.forged carries only the what-this-page-wrote
  // bookkeeping; the live trigger decides whether the forgery stands.
  const forged = forgedStands(st);
  // (First: what a round rests on is kept before any duty reads it lost.)
  if (!forged) noteChain(st, now);
  if (!forged) noteWitness(st, me, now);
  flushDuty(st, me, now);
  rideDuty(st, me, now);
  recommitDuty(st, me, now);
  noteSeedOut(st, now);
  closeDuty(st, me, pub, now);
  askDuty(st, me, now);
  forfeitDuty(st, me, pub, now);
  answerDuty(st, me, pub, now);
  abandonDuty(st, me, pub, now);
  if (forged) return;
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
 *  and again whenever the session lacks it, deleted or written over. Not
 *  for a round an abandon voided whose close this page didn't watch come in
 *  hearing the room (voidHolds); nor, back from a sleep or a load, for an
 *  undecided round the room may have voided meanwhile (wakeHolds). */
function revealDuty(st: TableState, me: string, now: number): void {
  const res = resultOf(st);
  const ses = computedSessionForWrite(st.t);
  if (!res || !ses) return;
  const sc = scanOf(st, res);
  for (const round of res.rounds) {
    if (!round.present.includes(me)) continue;
    if (round.decided === 'void' && voidHolds(st, round, now)) continue;
    if (wakeHolds(st, round, me, now)) continue;
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

/** Whether this page has heard the room without a break from
 *  TABLE_LEASE_LAPSE_MS before `at` (when it saw a close) to now
 *  (roomHearing heardThrough). Not across a deaf spell since; nor when the
 *  spell ended less than that before the close came: its link back, the
 *  room's ticks come at once and its doc catches up a moment later (a
 *  resync), the close in that catch-up all at once with the seeds, the
 *  forfeit or the void that followed it, every one of them read as just
 *  come — as on a doc that slept, which waits out the same lapse (croupier
 *  tablesAwake). What the page saw "in time" of such a close is no count of
 *  the room's. Always true while nothing wired the hearing. */
function heardAround(at: number, now: number): boolean {
  return heardThrough(at - TABLE_LEASE_LAPSE_MS, now);
}

/** Whether this page watched round's close come in (watchedClose) hearing
 *  the room around it (heardAround): one that came with the catch-up as its
 *  link came back after a deaf spell came all at once with what followed it
 *  (its seeds, its void), as one that came as the page woke. */
function watchedLive(st: TableState, round: RoundView, now: number): boolean {
  const raw = computedSeenAt(st.t, `c:${round.r}:${round.close}`);
  return raw !== undefined && watchedClose(st, round) && heardAround(raw, now);
}

/**
 * Whether the void of `round` holds this page's seed back: always, the
 * round's close one this page didn't watch come in hearing the room
 * (watchedLive: back from a sleep or a load, or its link back after a deaf
 * spell, as no forfeit of its own goes for it: forfeitDuty). Its seed comes
 * late, and with every other frozen bettor's in (each gone before its
 * reveal, all back now, or out before the void reached them), the reveals
 * would beat the void every page has shown, and the round would pay out
 * long after its stakes went back. Which seed would make the set whole no
 * page back can tell: another's may be on its way to it, or written on a doc
 * the void hadn't reached yet. Holding back only that one, and the rest each
 * in its turn (STAGGER_MS apart), lost the race to slower links: two back at
 * once on a 2-3 s handshake each put theirs out before the other's came
 * (stale-cache, SIM_SEED=800). So none goes, and the void stands. (What it
 * gives up: a griefer's abandon at once voids a round, and a bettor back
 * within the grace, its seed in time for the forfeit that a page that
 * watched the close writes, is dropped by that forfeit; a page that watched
 * the close still reveals its seed, void or not.)
 */
function voidHolds(st: TableState, round: RoundView, now: number): boolean {
  return !watchedLive(st, round, now);
}

/**
 * Whether this page holds its seed back for an undecided round whose close
 * it didn't watch come in (watchedClose: back from a sleep or a load), as
 * the room may have voided the round meanwhile: in a room of two, the page
 * left awake heard nobody and forfeited nothing (forfeitDuty's
 * heardAround), and its abandon is the round's end. A seed that reaches
 * the room after that void would beat it (every reveal in beats an abandon)
 * and pay out a round whose stakes went back long before.
 *
 * While the page waits out the lapse after a wake (croupier tablesAwake),
 * its doc catching up: the seed of a close it first saw ABANDON_MS ago or
 * more (a second's slack aside, on its own clock). A younger close can't
 * have been voided yet, and its seed goes at once, as before (in a grace
 * still running it may count in time) — but not, for a round it slept
 * through with another player's stake in it, while it hears nobody
 * (heardThrough): a seed written then reaches the room only as its link
 * comes back, however long that takes (a laptop's lid opened: the page runs
 * at once, its node's link to the room dials again), maybe after the void.
 * And past the lapse, such a round's older close waits until this page has
 * heard the room for as long again (its link back later than its wake: the
 * doc catches up from then). By then the void is in, if there is one, and
 * voidHolds decides; a round still undecided gets the seed. Hearing nobody
 * for good (every other page gone), the round ends by this page's own
 * abandon, ABANDON_MS from its wake. A round only this page's player bets
 * in waits for no hearing: nobody else's chips are in it, and in a room of
 * one nobody else voids it.
 */
function wakeHolds(st: TableState, round: RoundView, me: string, now: number): boolean {
  if (round.decided !== null || watchedClose(st, round)) return false;
  const raw = computedSeenAt(st.t, `c:${round.r}:${round.close}`);
  if (raw === undefined) return false;
  const old = now - raw >= ABANDON_MS - TABLE_CLOCK_SLACK_MS;
  if (old && !tablesAwake(now)) return true;
  // (At craps a rider's riding bets are in the roll, slip or none.)
  const riders = round.craps ? Object.keys(round.craps.sIn.w) : [];
  if (raw >= clock.wakeAt || (!round.present.some((pid) => pid !== me) && !riders.some((pid) => pid !== me))) return false;
  return !heardThrough(old ? now - TABLE_LEASE_LAPSE_MS : now, now);
}

/** Whether table st reads betting on its open round now (the view: a show
 *  restarted by a wake holds writes back too). */
function bettingOn(st: TableState, res: FoldResult, now: number): ViewEntry | null {
  const e = viewOf(st, res, now);
  return !res.tip && e.view.phase === 'betting' && e.view.round === res.open ? e : null;
}

/**
 * At craps: W, the end of betting on the open roll, while its window has
 * started and no close of it is in, whatever the view's phase (betting, the
 * wait for the throw, or closing after it); else null. The close, the
 * re-commit and the burned re-put run under it: past W they are the roll's
 * only way to close (a close deleted after its seeds went out closes afresh
 * on fresh seeds then too). W is the view's own (betEnd), so after a re-show
 * of the roll before the turns move with the screen; during the re-show the
 * view shows that roll, and the gate is shut.
 */
function crapsDutyOn(st: TableState, res: FoldResult, now: number): number | null {
  if (res.tip) return null;
  const e = viewOf(st, res, now);
  return e.view.round === res.open && st.window?.r === res.open && e.betEnd !== undefined ? e.betEnd : null;
}

/** Whether the re-commit's and the burned re-put's gate is open: betting at
 *  roulette, crapsDutyOn at craps. */
function recommitOn(st: TableState, res: FoldResult, now: number): boolean {
  return st.game === 'craps' ? crapsDutyOn(st, res, now) !== null : bettingOn(st, res, now) !== null;
}

/** 🎲 Tell this page's player that a change of the roll before undid their
 *  changes on round `o`: once for the changes this page took since it last
 *  said so, so a held one it dropped and a sent one written over later are
 *  one notice, through any number of rewrites. A version this page didn't
 *  write (`theirs`, its key: from before a reload with no goodbye, or
 *  another tab's) is told once, whatever this page took. */
function noteUndone(st: TableState, o: number, theirs?: string): void {
  for (const [k, r] of st.toldOver) if (r < o) st.toldOver.delete(k);
  const other = theirs !== undefined && !st.toldOver.has(theirs);
  if (st.changes <= st.changesTold && !other) return;
  if (other) st.toldOver.set(theirs, o);
  st.changesTold = st.changes;
  // (One that comes as the page leaves is said once it is back: said now,
  // it would flash on a page going into the back-forward cache.)
  if (st.left) {
    st.undoneAway = true;
    return;
  }
  st.undone += 1;
  notifyCasinoView(st.t);
}

/** 🎲 A version of the player's on round o taken on as this page's own (put
 *  back from a goodbye, or written again): its changes are the player's from
 *  here, for the table's notice (noteUndone), and a version this page didn't
 *  write (`theirs`, its key) is told of by them, not again on its own. */
function tookOn(st: TableState, o: number, theirs?: string): void {
  st.changes += 1;
  if (theirs !== undefined) st.toldOver.set(theirs, o);
}

/** 1. Write the felt the coalescing held back, once COALESCE_MS have passed
 *  since the last, or in the window's last second; one for a round that has
 *  moved on is dropped, as is one the chip check now refuses. */
function flushDuty(st: TableState, me: string, now: number): void {
  const p = st.pending;
  const res = resultOf(st);
  if (!p || !res || st.left) return;
  if (res.tip || res.open !== p.r) {
    st.pending = null;
    // (The close came first, and froze the felt before it: too late.)
    const closed = res.rounds.find((v) => v.r === p.r);
    if (closed) {
      const frozen = closed.present.includes(me) ? frozenSlip(scanOf(st, res), closed, me)?.b ?? [] : [];
      if (!sameFelt(frozen, p.felt)) {
        st.lateFelt = { r: p.r, frozen: closed.frozen[me] ?? '' };
        st.lateAdded = closed.craps !== undefined && addedOver(p.felt as CrapsBet[], own(closed.craps.sIn.w, me)) > 0;
        if (st.view) st.view.mine = undefined;
      }
    }
    return;
  }
  if (st.game === 'craps' && p.basis !== basisOf(res.carry as CrapsCarry, me)) {
    // (The roll before changed under it: a late seed, a rewritten roll. It
    // never went in, and built on the old table it would play as nothing.
    // A stand rewrite held back undid no change of the player's: its felt
    // went in, and rideDuty writes it again as the riding bets.)
    st.pending = null;
    if (!p.ride) noteUndone(st, p.r);
    return;
  }
  const e = bettingOn(st, res, now);
  if (!e || !slipDue(st, p.r, e.view.phaseDeadline, now)) return;
  st.pending = null;
  const cur = res.felts.get(me);
  if (st.game === 'craps') {
    // The stand as it is now: a felt held back goes with it (a shooter's
    // last chips, flushed in the window's last second, count them there).
    const felt = p.felt as CrapsBet[];
    const stand = localStandOf(st.t, me);
    if (crapsSlipStands(cur, felt, p.basis!, stand) || crapsRefusal(res, me, felt) !== null) return;
    writeSlip(st, res, p.r, felt, false, now, { o: p.basis!, t: stand });
    return;
  }
  const felt = p.felt as RouletteBet[];
  if (sameFelt(cur ? rouletteFelt(cur.rec) : [], felt)) return;
  if (refusal(res, me, felt, (cur?.rec.b.length ?? 0) > 0) !== null) return;
  writeSlip(st, res, p.r, felt, false, now);
}

/**
 * 1b. At craps: keep this page's player's felt on the open roll true to the
 * table, while no close is in. Only from a page at the table (its table
 * session stands at a stand), or for a roll someone else plays (another
 * player's latest version has chips and isn't a goodbye): a rider off the
 * table joins only those. Never once this page has said goodbye.
 * - A goodbye of this player's, whoever wrote it, goes at once, whatever the
 *   view shows (the show, betting, the wait, closing after it): this page
 *   is here, so it no longer holds. Written again as its own felt when its
 *   stamp is current (its take-downs stand), else the riding bets, with this
 *   page's stand. No chip moves: either is already set aside.
 * - While betting: a rider with no version on the roll puts their riding
 *   bets down (the ride slip), so their seed counts and their stand with it;
 *   a version built on a table that has since changed goes again as the
 *   riding bets, under the current stamp.
 * - While betting or past it (crapsDutyOn): a version without this page's
 *   stand goes again with it, felt and stamp unchanged (held back with the
 *   coalescing while betting; at once after), so a shooter back at their
 *   stand during the wait is counted there. A page with no stand never takes
 *   one off.
 * A version this page didn't write (its player's other tab did) waits
 * GRACE_MAX_MS from when this page first saw it before it is written over,
 * so two tabs don't take turns rewriting each other's. Nothing on a roll
 * this page saw decided, open again only because a peer's delete took a
 * record it rests on (as the re-commit): its versions were played, and go
 * back with the roll's put-back.
 */
function rideDuty(st: TableState, me: string, now: number): void {
  if (st.game !== 'craps' || st.left) return;
  const res = resultOf(st);
  if (!res || res.tip || res.open <= playedTo(st, res)) return;
  const o = res.open;
  const stand = localStandOf(st.t, me);
  const others = [...res.felts.values()].some((s) => s.rec.p !== me && s.rec.b.length > 0 && (s.rec as CrapsSlipRec).l !== 1);
  if (stand === undefined && !others) return;
  const carry = res.carry as CrapsCarry;
  const C = own(carry.w, me);
  const basis = basisOf(carry, me);
  const latest = res.felts.get(me);
  const rec = latest?.rec as CrapsSlipRec | undefined;
  const ours = (s: SlipInfo): boolean => st.mine.has(s.key) || now >= seen(st, s.key, now) + GRACE_MAX_MS;
  if (rec && rec.l === 1) {
    // (A goodbye's changes put back are its player's again, for the table's
    // notice; one on a table that is no more gives way to the riding bets,
    // its changes undone: noteUndone.)
    const theirs = st.mine.has(latest!.key) ? undefined : latest!.key;
    if (!writeSlip(st, res, o, rec.o === basis ? rec.b : C, false, now, { o: basis, t: stand }) || rodeAsBuilt(rec)) return;
    if (rec.o === basis) tookOn(st, o, theirs);
    else if (!sameFelt(rec.b, C)) noteUndone(st, o, theirs);
    return;
  }
  const e = bettingOn(st, res, now);
  if (e) {
    if (!rec) {
      if (C.length > 0) writeSlip(st, res, o, C, false, now, { o: basis, t: stand });
      return;
    }
    if (rec.o !== basis) {
      // (Built on the table before the roll before changed under it: it
      // plays as nothing, so the riding bets go in its place. A change of
      // the player's it carried is undone, and the table says so, as for a
      // held one: flushDuty.)
      const theirs = st.mine.has(latest!.key) ? undefined : latest!.key;
      if (ours(latest!) && writeSlip(st, res, o, C, false, now, { o: basis, t: stand }) && !rodeAsBuilt(rec) && !sameFelt(rec.b, C)) {
        noteUndone(st, o, theirs);
      }
      return;
    }
  }
  if (stand === undefined || !rec || rec.t === stand || (!e && crapsDutyOn(st, res, now) === null)) return;
  // (While betting a held change goes with the stand: flushDuty. Past it a
  // held felt never goes, so it no longer holds the stand back: a page whose
  // frames stopped across W with one held is counted at its stand from its
  // first tick of the wait. The held felt stays, so a close that froze the
  // felt before it is too late for it.)
  if (e && st.pending && st.pending.r === o) return;
  if (!ours(latest!)) return;
  // (A change in a version this page didn't write is its own from here,
  // for the table's notice: noteUndone.)
  const adopted = !st.mine.has(latest!.key) && !rodeAsBuilt(rec);
  if (e && !slipDue(st, o, e.view.phaseDeadline, now)) {
    st.pending = { r: o, felt: rec.b, basis: rec.o, ride: true };
    if (adopted) tookOn(st, o, latest!.key);
    return;
  }
  if (writeSlip(st, res, o, rec.b, false, now, { o: rec.o, t: stand }) && adopted) tookOn(st, o, latest!.key);
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
  if (!res || st.left || res.open <= playedTo(st, res) || !recommitOn(st, res, now)) return;
  const cur = res.felts.get(me);
  if (!cur || !feltCounts(st, res, cur) || !burnedCommit(st, res, cur.rec.c)) return;
  // (At craps with its own stamp, stand and goodbye mark: a felt built on an
  // older table stays one, and plays as the riding bets. One this page
  // didn't write is its own from here, for the table's notice.)
  const adopted = st.game === 'craps' && !st.mine.has(cur.key) && !rodeAsBuilt(cur.rec);
  if (writeSlip(st, res, res.open, cur.rec.b as RouletteBet[] | CrapsBet[], true, now, extraOf(st, cur.rec)) && adopted) tookOn(st, res.open, cur.key);
}

/** Whether a felt of the open round is anything to freeze: chips on it, or
 *  at craps an empty one over riding bets (everything taken down). */
function feltCounts(st: TableState, res: FoldResult, s: SlipInfo): boolean {
  return s.rec.b.length > 0 || (st.game === 'craps' && own((res.carry as CrapsCarry).w, s.rec.p).length > 0);
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
 * first. Its turn moves back for a felt of its own that changed late, or
 * that its player's other tab wrote (closeDue).
 *
 * At craps it runs whenever the roll's window has started and no close is
 * in (crapsDutyOn), W the end of betting; its turns while the roll waits
 * for the throw are crapsCloseDue's. It also freezes an empty felt over
 * riding bets (a rider who took everything down), but no goodbye that only
 * rides, nor one built on a table that has since changed: either plays as
 * the riding bets anyway, and its page, gone, would never send its seed.
 *
 * At a house table it names the house commitment the round asks for (the
 * fold's `required`), else the first of the house's join records for it
 * (`joins`), else none (a Friendly round). A close in already, Friendly or
 * Fair, stands it down as any close does: none is written to take a round
 * the house joined late from one already closed Friendly (the house reveals
 * for no close of a round another close of names nothing: house.rs).
 */
function closeDuty(st: TableState, me: string, pub: string, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  const craps = st.game === 'craps';
  const deadline = craps ? crapsDutyOn(st, res, now) ?? undefined : bettingOn(st, res, now)?.view.phaseDeadline;
  if (deadline === undefined) return;
  const o = res.open;
  const own = res.felts.get(me);
  if (!own || own.rec.b.length === 0 || burnedCommit(st, res, own.rec.c)) return;
  if (res.openCloses.some((c) => c.state !== 'invalid')) return;
  // (A table holding MAX_TABLE_PIDS players freezes no newcomer: its next
  // checkpoint couldn't carry them all. This page's own player either.)
  if (crowdedOut(st.t, me)) return;
  const sc = scanOf(st, res);
  if (signedIn<CloseRec>(st, sc, 'close', asClose, sc.closes, o, pub, (c) => c.q === res.parent)) return;
  const staked = [...res.felts.values()].filter((s) => s.rec.b.length > 0);
  const pubs = staked.map((s) => s.rec.k);
  const idx = placeOf('close', st.ctx, o, pubs, pub);
  const n = new Set(pubs).size;
  const due = craps ? crapsCloseDue(st, res, own, pubs, deadline, idx, n, me, pub, now) : closeDue(st, own, deadline, idx, n, now);
  if (now < due) return;
  // (Seen just now, as this tick noted it: noteSeedOut.)
  if (seedOut(st, sc, o) && now < (st.seedOutAt?.at ?? now) + ABANDON_MS + idx * STAGGER_MS) return;
  const others = (craps ? [...res.felts.values()].filter((s) => crapsFreezable(res.carry as CrapsCarry, s)) : staked)
    .filter((s) => s.rec.p !== me && !burnedCommit(st, res, s.rec.c) && !crowdedOut(st.t, s.rec.p) && !computedSlipDoubted(st.t, s.hash))
    .map((s) => ({ s, at: seen(st, s.key, now) }))
    .sort((a, b) => a.at - b.at || (a.s.rec.p < b.s.rec.p ? -1 : 1));
  const f: Record<string, string> = { [me]: own.hash };
  for (const { s } of others.slice(0, MAX_FROZEN - 1)) f[s.rec.p] = s.hash;
  const h = res.required ?? res.joins[0]?.rec.c;
  const rec = signed(st.ctx, 'close', { r: o, q: res.parent, f, ...(h !== undefined ? { h } : {}), k: pub });
  const key = closeKey(rec);
  if (key) put(st, key, rec, o, true);
}

/**
 * When this page's close of the open round falls due: in its turn among the
 * felts with chips on (`idx` of `n` pubs), STAGGER_MS apart from the
 * window's deadline — unless the felt it would freeze for its player (`own`)
 * came late, or isn't its own. Every page ranks the felts it sees, so a peer
 * that hadn't heard a felt come (or change) by its own turn reads the table
 * without it, and may be first in that view; two closes of one round then
 * freeze two felts, each decided as its seeds come in, and the one shown
 * first is rewritten when the other, better ranked, decides too. So:
 * - a felt this page saw last change STAGGER_MS or less before its turn, or
 *   after it (taken down and put back at the deadline: the view reads
 *   betting until a close comes), gives its turn away: after every other
 *   page's turn, and STAGGER_MS past the change at least. A close a peer
 *   wrote meanwhile from the felts as they were reaches this page first, and
 *   it stands down; the felt missed the close, and holds nothing.
 * - a felt this page didn't write (its player's other tab did: one key, so
 *   one turn, and each tab freezes the felt as it last heard it) is that
 *   tab's to close, from the newest view of it: this page closes only once
 *   GRACE_MAX_MS more have passed with no close in (that tab gone, or a link
 *   slower than any grace waits for).
 */
function closeDue(st: TableState, own: { key: string }, deadline: number, idx: number, n: number, now: number): number {
  const turn = deadline + idx * STAGGER_MS;
  const changed = seen(st, own.key, now);
  const mine = st.mine.has(own.key);
  if (mine && changed <= turn - STAGGER_MS) return turn;
  const after = Math.max(deadline + (n + idx) * STAGGER_MS, changed + STAGGER_MS);
  return mine ? after : after + GRACE_MAX_MS;
}

/** Whether a close at craps freezes `s`, another player's latest version on
 *  the open roll: chips on it, or an empty one over riding bets; not a
 *  goodbye built on a table that has since changed, nor one that only
 *  rides (its felt is its riding bets), as either plays as them anyway. */
function crapsFreezable(carry: CrapsCarry, s: SlipInfo): boolean {
  const rec = s.rec as CrapsSlipRec;
  const C = own(carry.w, rec.p);
  if (rec.b.length === 0 && C.length === 0) return false;
  return !(rec.l === 1 && (rec.o !== basisOf(carry, rec.p) || sameFelt(rec.b, C)));
}

/**
 * When this page's close of the open craps roll falls due (`W` the end of
 * betting, `idx` this page's place among the `pubs` with chips on the roll,
 * `n` of them). With nobody in play to throw it, closeDue's rule from W.
 * While the roll waits for the holder's throw (they were counted at their
 * stand on the last roll), up to D = W + CRAPS_SHOOTER_MS:
 * - the holder's own page closes at its own fling (noteComputedFling, never
 *   the throw record), or at D with none; and no sooner than STAGGER_MS
 *   after its own felt last changed, so a close never freezes a felt the
 *   others haven't heard. A change it first saw within STAGGER_MS of D, or
 *   after D, gives its turn away to every other page's (they close first,
 *   from what they heard): a late stand rewrite can't race them. A felt its
 *   player's other tab wrote, GRACE_MAX_MS later, as closeDue.
 * - every other page closes only once the wait is over: from D, one turn
 *   after the holder's, in its place among the other pubs, with closeDue's
 *   rules for a felt of its own that changed late or isn't its own.
 */
function crapsCloseDue(
  st: TableState, res: FoldResult, own: SlipInfo, pubs: string[], W: number, idx: number, n: number, me: string, pub: string, now: number,
): number {
  const carry = res.carry as CrapsCarry;
  if (carry.h === undefined || carry.i !== 1) return closeDue(st, own, W, idx, n, now);
  const D = W + CRAPS_SHOOTER_MS;
  if (me === carry.h) {
    const T = st.flung && st.flung.r === res.open ? Math.max(W, st.flung.at) : D;
    const changed = seen(st, own.key, now);
    const turn = changed <= D - STAGGER_MS
      ? Math.max(T, changed + STAGGER_MS)
      : Math.max(D + n * STAGGER_MS, changed + STAGGER_MS);
    return st.mine.has(own.key) ? turn : turn + GRACE_MAX_MS;
  }
  const hl = res.felts.get(carry.h);
  const holderPub = hl && hl.rec.b.length > 0 ? hl.rec.k : null;
  const after = placeOf('close', st.ctx, res.open, pubs.filter((k) => k !== holderPub), pub);
  return closeDue(st, own, D, 1 + after, n, now);
}

/**
 * 4b. Ask the room, once per close, for what this page is missing, when a
 * frozen bettor's seed (or slip) still isn't in ASK_AHEAD_MS before the
 * least grace runs out on this page's clock (REVEAL_GRACE_MS from when it
 * saw the close): the tip undecided (so a seed or a slip is missing: with
 * every one in, the reveals decide it), this page's player frozen in it
 * with their seed in. An update lost on its way here (a message dropped, a
 * link that blinked) comes back before the forfeit falls due — one that
 * would drop the seed, and beat the full set every page that had it showed.
 * casinoDoc's resync, under casinoWhole's rate limit (askRoomForMissing):
 * one ask serves both, and held back by a recent one, this one goes once
 * that lapses, still once per close; but not held back by one from before
 * the close came, which brought none of its seeds. Harmless when the seed
 * is only being withheld: the room has nothing to send. Asked whether this
 * page hears the room or not: an ask that reaches nobody brings nothing.
 */
function askDuty(st: TableState, me: string, now: number): void {
  const tip = resultOf(st)?.tip;
  if (!tip || st.askedFor === tip.close || !tip.present.includes(me) || !tip.revealed.includes(me)) return;
  const closeSeen = seen(st, `c:${tip.r}:${tip.close}`, now);
  if (now < closeSeen + REVEAL_GRACE_MS - ASK_AHEAD_MS) return;
  if (askRoomForMissing(now, closeSeen)) st.askedFor = tip.close;
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
 * forfeit outlives the put-back (it beats the reveals). Nor from a page that
 * hasn't heard the room all the way from the close to now (heardAround: a
 * silence of HEARD_GAP_MS since, or now, or one that ended just before the
 * close came, which came with the room's catch-up): the seeds it missed may
 * be its own link's loss, and its forfeit, landing as the link comes back,
 * would beat the full set every other page showed. The pages that heard
 * the room forfeit what truly didn't come; with none, the abandon voids the
 * round. Never of a Fair round (its close names a house commitment): only
 * the house's reveal decides one, counting the seeds it saw (computedFold
 * THE HOUSE), and a forfeit there decides nothing.
 */
function forfeitDuty(st: TableState, me: string, pub: string, now: number): void {
  const res = resultOf(st);
  if (!res) return;
  const sc = scanOf(st, res);
  for (const round of res.rounds) {
    if (round.decided !== null && round.decided !== 'void') continue;
    if (round.closeRec.h !== undefined) continue;
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
    if (!heardAround(closeSeen, now)) continue;
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
 *  goes back, and an answer to the other could outrank it. Nor from a page
 *  that hasn't heard the room all the way from the close (heardAround, as
 *  the forfeit): across a deaf spell, or of a close that came with the
 *  catch-up after one (its own seed with it, late in the room: lone-stall,
 *  SIM_SEED=3000), its count of seeds seen in time is no count of the
 *  room's. */
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
    if (n.includes(me) && heardAround(closeSeen, now)) writeForfeit(st, round, n, pub);
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
 * would stay in the session to void the round at the next delete. Nor, on
 * a page that keeps no copy of it (it only watched the round), while the
 * chain falls short of a round it saw decided (noteChain), MISSING_WAIT_MS
 * at most, as the trim waits: the round's witnesses put it back meanwhile.
 * A Fair tip (its close names a house commitment) waits for the house as
 * long, or only HOUSE_HEARD_MS once this page hasn't heard the house for
 * that long (abandonWait): the house has gone, and the round is voided
 * sooner. Its next round is joinable, and Friendly while no house joins it.
 */
function abandonDuty(st: TableState, me: string, pub: string, now: number): void {
  const res = resultOf(st);
  const tip = res?.tip;
  if (!res || !tip) return;
  const closeSeen = seen(st, `c:${tip.r}:${tip.close}`, now);
  if (now < closeSeen + (tip.closeRec.h !== undefined ? HOUSE_HEARD_MS : ABANDON_MS)) return;
  let wrote = false;
  for (const m of st.mine.values()) if (m.r > res.base.u) wrote = true;
  if (!wrote && readSeat(st.t, me) === null) return;
  if (heldBack(st, res, tip.close, now)) return;
  if (st.shortAt !== null && now - st.shortAt < MISSING_WAIT_MS) return;
  const sc = scanOf(st, res);
  if (signedIn<AbandonRec>(st, sc, 'abandon', asAbandon, sc.abandons, tip.r, pub, (z) => z.x === tip.close)) return;
  const pubs = new Set(checkedSlipPubs(st, sc));
  for (const pid of Object.keys(readSeats(st.t))) {
    const k = keyFor(pid);
    if (k) pubs.add(k);
  }
  const idx = placeOf('abandon', st.ctx, tip.r, pubs, pub);
  if (now < closeSeen + abandonWait(tip, now) + idx * STAGGER_MS) return;
  const rec = signed(st.ctx, 'abandon', { r: tip.r, x: tip.close, k: pub });
  const key = abandonKey(rec);
  if (key) put(st, key, rec, tip.r, true);
}

/** How long after its close the abandon waits to void tip: ABANDON_MS, or
 *  at a Fair round HOUSE_HEARD_MS while this page hasn't heard the house for
 *  that long (casinoDoc houseOnline) — unless the house's reveal of the
 *  close is in, as the fold counts it (verified, a house's: RoundView
 *  houseWaits): it waits on a seed it counted, which the room has (one this
 *  page hasn't heard yet), and voided meanwhile the round would read void,
 *  then decided as the seed came. A forged one holds nothing. */
function abandonWait(tip: RoundView, now: number): number {
  if (tip.closeRec.h === undefined || houseOnline(now) || tip.houseWaits !== undefined) return ABANDON_MS;
  return HOUSE_HEARD_MS;
}

/**
 * 7. Every REPUT_MS: put back, byte for byte, each record this page wrote
 * for a round past the checkpoint that the live session has lost (a peer's
 * delete or junk written over it, a write at the moment of a trim). Of its
 * slips, only the ones that still matter: its latest version of the round,
 * or one frozen by a close on the chain as the fold reads it now, or open
 * there (of a round off the chain because a record before it is gone too,
 * the slip waits for the chain to come back, then goes at the next beat); a
 * latest version whose seed is out goes again under a fresh seed instead
 * (as the re-commit writes it), while its round takes bets: put back as it
 * was, a close that never saw the seed could freeze it (a trim leaves its
 * reveal behind). But not of a round this page saw decided (the
 * re-commit's rule: it was played). What a checkpoint covers was let go of
 * as it came (noteResult), seeds and all.
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
    const v = (m.rec as AnySlipRec).v;
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
      const slip = m.rec as AnySlipRec;
      if (burnedCommit(st, res, slip.c)) {
        // (At craps, as the re-commit: its own stamp, stand and mark; never
        // once this page has said goodbye.)
        if (m.r === res.open && m.r > playedTo(st, res) && !st.left && recommitOn(st, res, now)) {
          writeSlip(st, res, m.r, slip.b as RouletteBet[] | CrapsBet[], true, now, extraOf(st, slip));
        }
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
const forfeitOf = (v: unknown): string | null => { const f = asForfeit(v); return f && forfeitKey(f); };
const abandonOf = (v: unknown): string | null => { const z = asAbandon(v); return z && abandonKey(z); };
const houseRevealOf = (v: unknown): string | null => { const x = asHouseReveal(v); return x && houseRevealKey(x); };
const houseJoinOf = (v: unknown): string | null => { const o = asHouseCommit(v); return o && houseCommitKey(o); };

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
 * frozen slip), and the forfeit, abandon or house reveal that decided it; at
 * a house table also the house records its close rests on, as the fold
 * counted them (RoundView restsOn: the join it names, the step-down that
 * lifted the commitment its parent asked for, or both): verified, a house's,
 * so a forged copy of one is never what goes back. Its own records
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
      : round.forfeit ? `f:${round.r}:${round.forfeit.hash}` : round.abandon ? `z:${round.r}:${round.abandon.hash}`
      : round.house ? `h:${round.r}:${round.house.hash}` : null;
    const noted = shown ? `${round.decided}|${round.present.length}|${round.revealed.length}|${decider ?? ''}` : `-|${round.present.length}`;
    if (w && w.noted === noted) continue;
    if (!w) st.witness.set(round.close, w = { r: round.r, pubs: new Set(), copies: new Map(), decider: null, noted: '' });
    const had = { size: w.copies.size, decider: w.decider };
    let whole = true;
    for (const pid of round.present) {
      const key = `s:${round.r}:${pid}:${round.frozen[pid]}`;
      if (keepCopy(w, ses, key, st.keyOf)) w.pubs.add((w.copies.get(key)!.v as AnySlipRec).k);
      else whole = false;
    }
    if (shown) {
      if (!keepCopy(w, ses, `c:${round.r}:${round.close}`, closeOf)) whole = false;
      for (const key of round.restsOn ?? []) if (!keepCopy(w, ses, key, key[0] === 'h' ? houseRevealOf : houseJoinOf)) whole = false;
      for (const pid of round.revealed) {
        const keys = sc.reveals.get(round.r)?.get(pid) ?? [];
        if (keys.some((key) => w!.copies.has(key))) continue;
        const slip = w.copies.get(`s:${round.r}:${pid}:${round.frozen[pid]}`)?.v as AnySlipRec | undefined;
        const key = slip && keys.find((k) => {
          const x = asReveal(ses.get(k));
          return x !== null && revealKey(x) === k && slipCommit(st.ctx, x.r, x.p, x.s) === slip.c;
        });
        if (!key || !keepCopy(w, ses, key, (v) => { const x = asReveal(v); return x && revealKey(x); })) whole = false;
      }
      if (decider !== null && decider !== w.decider) {
        const old = w.decider === null ? undefined : w.copies.get(w.decider);
        if (!old || heldIn(ses, w.decider!, old)) {
          if (keepCopy(w, ses, decider, decider[0] === 'f' ? forfeitOf : decider[0] === 'z' ? abandonOf : houseRevealOf)) {
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
 * for byte (at a house table with the house's join records of it, and the
 * checkpoint names the commitment the open round must name: `h`, the fold's
 * `required`), but not one whose seed this page knows is out: in the next
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
 * put it back. And "idle" only from a page that has heard the room for all
 * of IDLE_MS (roomHearing heardThrough), the fallback's turn too: no record
 * in for a minute on a page whose link stalled, or that runs on the room
 * cache's copy with the room not answering (croupier ROOM_STATE_WAIT_MS),
 * is its own silence, not the table's. Its checkpoint would be the only one
 * (the room, busy, trims nothing on idle), so it would win the split, and
 * every round the room decided meanwhile would void as the link came back.
 * The rounds and the bytes are pressure of records this page holds, deaf or
 * not (a room of one hears nobody, and still trims on them).
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
  const heard = heardThrough(now - IDLE_MS, now);
  // (At craps a seven-out too, once the hand has run long: every bet on it
  // resolved, so its checkpoint is small, and no late change reaches back
  // past the hand.)
  const pressed = D.r - res.base.u >= TRIM_ROUNDS
    || res.rawBytes >= TRIM_BYTES
    || (res.rawBytes >= ROOM_MIN_BYTES && computedRoomBytes() >= ROOM_BYTES)
    || (D.craps?.sevenOut === true && D.r - res.base.u >= TRIM_SEVEN_OUT_MIN)
    || (now - last >= IDLE_MS && heard);
  if (!pressed) return;
  const pubs = frozenPubs(sc, D);
  if (pubs.includes(pub)) {
    const seenDecided = st.decided.get(`${D.close}|${D.decided}`)!.at;
    const idx = placeOf('trim', st.ctx, D.r, pubs, pub);
    if (now < Math.max(show, seenDecided + TRIM_AFTER_DECIDED_MS) + idx * STAGGER_MS) return;
  } else if (now - last < TRIM_FALLBACK_MS || !heard) {
    return;
  }
  const n = netsOf(res);
  if (Object.keys(n).length > MAX_CHECKPOINT_PIDS) return;
  // (At craps with the table's state after D: the point, every bet riding,
  // the dice's holder. The open felts' stamps were made from it, so they
  // stay current in the next session.)
  const carried = st.game === 'craps' ? { s: res.carry as CrapsCarry } : {};
  // (At a house table with the commitment the next round must name, and
  // the house's join records of it: the next session's first round asks
  // what this one's open round did.)
  const house = res.required !== null ? { h: res.required } : {};
  const cp: Checkpoint = signed(st.ctx, 'sum', { v: 1 as const, b: res.base.sid, u: D.r, l: D.close, n, ...carried, ...house, k: pub });
  const copies: [string, unknown][] = [];
  for (const s of res.felts.values()) if (!burnedCommit(st, res, s.rec.c)) copies.push([s.key, sc.ses?.get(s.key)]);
  for (const j of res.joins) {
    const v = sc.ses?.get(`o:${res.open}:${j.hash}`);
    if (v !== undefined) copies.push([`o:${res.open}:${j.hash}`, v]);
  }
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
  const read = asSlipFor(e);
  const keyOf = slipKeyFor(e);
  for (const key of e.session?.keys() ?? []) {
    if (parseKey(key)?.kind !== 's') continue;
    const s = read(e.session!.get(key));
    if (s && !out.has(s.k) && checkedSlip(e.t, e.inc, key, s, keyOf)) out.add(s.k);
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
  // all: no duty runs for it now, so nothing of it will be revealed. (A
  // switch naming an incarnation that has ended is a lost one, as a missing
  // switch is: computedSwitchLost. It is put back, and the seeds go only if
  // the incarnation ends.)
  for (const st of tables.values()) {
    if (st.mine.size === 0 || !casinoWhole(st.t)) continue;
    const inc = computedIncOf(st.t);
    if (computedIncEnded(st.t, st.inc) || (inc !== null && inc !== st.inc && !computedIncEnded(st.t, inc))) letGo(st, () => false);
  }
  // (Timed from when this page saw it ended, or woke: asleep or not.)
  const awake = tablesAwake(now);
  const listed = new Set<string>();
  for (const e of computedEndedIncs()) {
    const key = `${e.t}:${e.inc}`;
    listed.add(key);
    let at = endedAt.get(key);
    if (at === undefined) endedAt.set(key, at = now);
    // (Nor on a rewind or a jump a peer wrote over its checkpoint: the end
    // would make it final. The recovery duty puts the head back first.)
    if (!awake || !casinoWhole(e.t) || !computedSettled(e.t) || computedRestorePending(e.t, e.inc)) continue;
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
    if (cp) endedByMe.add(nextSid(ctx, cp));
    finalizeComputed(e.t, e.inc, cp);
  }
  for (const key of [...endedAt.keys()]) if (!listed.has(key)) endedAt.delete(key);
}

// ── 🩹 Recovery ──────────────────────────────────────────────────────────────

/** What the recovery duty waits out at one incarnation, on this page's
 *  clock (by `<tableId>:<inc>`). */
interface Recovering {
  /** The restore trigger in motion, and when this page first saw one in
   *  motion since the doc was last calm (ComputedRecovery calm: found calm
   *  so many times before). */
  trigger: RecoveryTrigger | null;
  at: number;
  calm: number;
  /** When this page first saw the session its base opens missing (D5), and
   *  a session it counted from lost (D6). */
  missingAt: number | null;
  lostAt: number | null;
  /** The value this page last put back, while the doc may still hold it,
   *  and when; how many of its restores in a row were written over by
   *  values that put one in motion again, and when the last was
   *  (computedContested). */
  wrote: object | null;
  wroteAt: number | null;
  overwrites: number;
  overAt: number | null;
}
const recovering = new Map<string, Recovering>();
/** When the recovery duty last looked (at most every TICK_MS). */
let recoveredAt: number | null = null;

/**
 * 11. 🩹 Put back what a peer deleted or rewound of a computed incarnation,
 * of every one this page tracks (ended ones too: an ended one's checkpoint
 * holds the nets that go on counting), on an awake page with the room's
 * state in and its doc whole (no build deletes a checkpoint or a session
 * with nothing in its place, nor writes one back, nor rewinds one):
 * - **Restore** (casinoDoc restoreComputedCheckpoint): this page's head,
 *   byte for byte, when the doc's checkpoint is gone or junk (at once, in
 *   turn), or rewound below it, or jumped past where any session reaches
 *   (RESTORE_WAIT_MS on, in turn). Turns go by dutyRank('restore') among the
 *   incarnation's keys (ComputedRecovery pubs), STAGGER_MS apart; a page
 *   with none of them waits OUTSIDER_WAIT_MS more. Never over an end, nor
 *   over an extension of the head (no page can tell one from an honest
 *   trim). The page counts from its head meanwhile (casinoDoc heldBase).
 * - **Reopen** (reopenComputedSession): the session the base opens, when its
 *   map is missing, OPEN_WAIT_MS on, in turn (dutyRank('open')), with the
 *   room heard all the while: the records' authors and witnesses put them
 *   back into it (reputDuty, witnessDuty).
 * - **Give up** (giveUpComputed): the rounds of a session this page counted
 *   from, deleted for GIVE_UP_MS with the room heard all the while: it reads
 *   the incarnation as a page that never counted them does.
 * A wake, a frame that isn't ready, or another trigger starts its wait
 * again. Not on a frame whose doc was bound afresh since this page looked
 * at its clock. No signature waits on any of it: what is put back is what
 * this page counted, or an empty map.
 */
function recoverDuty(pub: string, now: number): void {
  if (!computedRecoveryOn()) return;
  if (recoveredAt !== null && now >= recoveredAt && now - recoveredAt < TICK_MS) return;
  recoveredAt = now;
  if (casinoDocEpoch() !== clock.epoch) return;
  const ready = roomStateIn(now) && tablesAwake(now) && casinoWhole();
  const listed = new Set<string>();
  for (const r of computedRecoveries()) {
    const key = `${r.t}:${r.inc}`;
    listed.add(key);
    let w = recovering.get(key);
    if (!w) recovering.set(key, w = { trigger: null, at: now, calm: r.calm, missingAt: null, lostAt: null, wrote: null, wroteAt: null, overwrites: 0, overAt: null });
    if (!ready) {
      w.trigger = null;
      w.missingAt = null;
      w.lostAt = null;
      continue;
    }
    restoreStep(w, r, pub, now);
    reopenStep(w, r, pub, now);
    giveUpStep(w, r, now);
  }
  for (const key of [...recovering.keys()]) if (!listed.has(key)) recovering.delete(key);
}

/** This page's turn for a duty among an incarnation's keys: STAGGER_MS a
 *  place (RECOVERY_PLACES at most), and OUTSIDER_WAIT_MS more for a page
 *  with none of them. */
function turnOf(duty: Duty, r: ComputedRecovery, round: number, pub: string): number {
  const idx = placeOf(duty, r.ctx, round, r.pubs, pub, recoveryRanks);
  return Math.min(idx, RECOVERY_PLACES) * STAGGER_MS + (idx >= r.pubs.length ? OUTSIDER_WAIT_MS : 0);
}
/** The recovery duties' ranks, by duty, incarnation, round and key: the
 *  duty looks every tick, at up to MAX_TABLE_PIDS keys, while a wait runs. */
const recoveryRanks = new Map<string, string>();

function restoreStep(w: Recovering, r: ComputedRecovery, pub: string, now: number): void {
  // This page's last restore written over by a value that puts one in
  // motion again: a peer writing a rewind or a jump over it, in a row
  // unless CONTESTED_CALM_MS passed since the last (computedContested).
  // (Once this page's head moves on, its last restore is behind it. Junk or
  // a delete over it isn't counted: no page writes either, and the first in
  // turn puts the head back at once each time.)
  if (w.wrote !== null && w.wrote !== r.head) w.wrote = null;
  if (w.wrote !== null && (r.trigger === 'rewind' || r.trigger === 'jump')) {
    w.wrote = null;
    if (w.overAt === null || w.overAt > now || now - w.overAt > CONTESTED_CALM_MS) w.overwrites = 0;
    w.overwrites += 1;
    w.overAt = now;
  }
  // 🩹 An unseen head that keeps losing the contest — this page's restore of
  // it written over again and again by a rewind or a jump it can't classify,
  // the room backing that rival — gives way to it, converging a page that
  // took its head at load after a partition the firmAt window couldn't cover
  // (no fixed timeout can). Only an UNSEEN head gives way (giveWayComputed
  // self-gates on `seen`): a page grounded in its head defends it against a
  // cheat and flies the 🚩 instead. Gated on hearing the room now, so stale
  // cached forgeries this page can't yet see the room answer don't count.
  if (w.overwrites >= CONTESTED_COUNT && w.overAt !== null && now - w.overAt <= CONTESTED_CALM_MS
      && heardThrough(now - RESTORE_WAIT_MS, now) && giveWayComputed(r.t, r.inc)) {
    w.trigger = null;
    w.wrote = null;
    w.overwrites = 0;
    w.overAt = null;
    return;
  }
  if (r.trigger === null || r.head === null) {
    w.trigger = null;
    return;
  }
  // (A restore in motion keeps its wait until the doc is calm again,
  // whatever triggers it meanwhile: values written again and again, rewinds
  // and jumps of any bytes in turn, start nothing afresh. The doc calm since,
  // though this page never looked then, or this page's clock back: they do.)
  if (w.trigger === null || w.at > now || w.calm !== r.calm) {
    w.at = now;
    w.calm = r.calm;
  }
  w.trigger = r.trigger;
  const due = r.trigger === 'junk'
    ? Math.max(w.at + turnOf('restore', r, r.headU, pub), w.wroteAt !== null && w.wroteAt <= now ? w.wroteAt + JUNK_GAP_MS : -Infinity)
    : w.at + RESTORE_WAIT_MS + turnOf('restore', r, r.headU, pub);
  if (now < due) return;
  const head = r.head;
  if (transactCasino(() => restoreComputedCheckpoint(r.t, r.inc, head))) {
    w.wrote = head;
    w.wroteAt = now;
    w.trigger = null;
  }
}

function reopenStep(w: Recovering, r: ComputedRecovery, pub: string, now: number): void {
  if (!r.live || !r.sessionMissing || r.trigger !== null) {
    w.missingAt = null;
    return;
  }
  if (w.missingAt === null || w.missingAt > now) w.missingAt = now;
  if (now < w.missingAt + OPEN_WAIT_MS + turnOf('open', r, r.u, pub) || !heardThrough(now - OPEN_WAIT_MS, now)) return;
  if (transactCasino(() => reopenComputedSession(r.t, r.inc))) w.missingAt = null;
}

function giveUpStep(w: Recovering, r: ComputedRecovery, now: number): void {
  if (!r.lost) {
    w.lostAt = null;
    return;
  }
  if (w.lostAt === null || w.lostAt > now) w.lostAt = now;
  if (now - w.lostAt < GIVE_UP_MS || !heardThrough(now - GIVE_UP_MS, now)) return;
  if (giveUpComputed(r.t, r.inc)) w.lostAt = null;
}

/** 🚩 Whether this page's restores of table `t`'s checkpoint keep being
 *  written over: CONTESTED_COUNT in a row, the last CONTESTED_CALM_MS ago at
 *  most. It goes on putting the head back all the same. */
export function computedContested(t: string, now = Date.now()): boolean {
  const inc = computedIncOf(t);
  const w = inc === null ? undefined : recovering.get(`${t}:${inc}`);
  return !!w && w.overAt !== null && w.overwrites >= CONTESTED_COUNT && w.overAt <= now && now - w.overAt <= CONTESTED_CALM_MS;
}

/** Whether pid `me` would join table `t` as a newcomer it has no place for
 *  (MAX_TABLE_PIDS: computedTablePids). */
function crowdedOut(t: string, me: string): boolean {
  if (!computedRecoveryOn()) return false;
  const pids = computedTablePids(t);
  return pids.size >= MAX_TABLE_PIDS && !pids.has(me);
}

// ── 🏠 The house ─────────────────────────────────────────────────────────────

/** The house key of this page's own node (its fingerprint's `house`:
 *  main.ts setLocalHouse), or null without one. */
let localHouse: string | null = null;
/** When the house duty last looked (at most every REPUT_MS). */
let houseDutyAt: number | null = null;

/** 🏠 The house key this page's own node answers with (ssf-p2p-node's
 *  fingerprint `house`), or null: main.ts, on every fingerprint read. A
 *  key not in base64url's 43 characters reads as none. */
export function setLocalHouse(pub: string | null): void {
  localHouse = typeof pub === 'string' && isPub(pub) ? pub : null;
}

/**
 * 10. The house's room records: every REPUT_MS, on an awake page with its
 * doc whole, each page puts back what it counted of them that the doc lost
 * (casinoDoc putBackHouseRecords: the delegations, each table's newest Fair
 * setting), so a peer's delete can't take the house away; and the page of
 * the room's deed holder (holdsDeed) delegates its own node's house key
 * (`hk:<house>`, computedHouse) while the doc doesn't hold that delegation
 * as it signed it. That node is the house from then on: it commits to a
 * seed for each round of the room's house tables set Fair (house.rs), and a
 * close names it (closeDuty). A deed holder with no node of its own (a
 * browser alone) delegates nothing, and its tables play Friendly.
 */
function houseDuty(now: number): void {
  if (houseDutyAt !== null && now >= houseDutyAt && now - houseDutyAt < REPUT_MS) return;
  houseDutyAt = now;
  if (!tablesAwake(now) || !casinoWhole()) return;
  putBackHouseRecords(now);
  // (Held, or its check waiting: it is read again REPUT_MS on.)
  if (localHouse === null || !holdsDeed() || delegationHeld(localHouse) !== false) return;
  const body = { v: 1 as const, h: localHouse, k: getIdentityPub() };
  writeDelegation({ ...body, g: signIdentity(roomSignBytes('hkey', casinoRoomId(), '', body)) });
}

/** What setComputedFairness did: 'ok', or 'owner' from a page that isn't
 *  the deed holder's, or 'reconnecting' on a doc not whole. */
export type ComputedFairnessResult = 'ok' | 'owner' | 'reconnecting';

/**
 * 🏠 The deed holder sets house table `t` Fair (the house adds its seed while
 * it is online) or Friendly (seeds from the players only): its signed
 * setting (`hf:<t>`, computedHouse), ordered past the newest one this page
 * has seen. The house reads it (it steps down from a table set Friendly,
 * and joins one set Fair again); the fold never does. The ⚙ card's FAIRNESS.
 */
export function setComputedFairness(t: string, mode: 'fair' | 'friendly', now = Date.now()): ComputedFairnessResult {
  if (!holdsDeed()) return 'owner';
  if (!casinoWhole(t)) return 'reconnecting';
  const body = { v: 1 as const, m: mode === 'friendly' ? 1 as const : 0 as const, s: Math.max(Math.floor(now), fairSettingSeq(t) + 1), k: getIdentityPub() };
  writeFairSetting(t, { ...body, g: signIdentity(roomSignBytes('hfair', casinoRoomId(), t, body)) });
  return 'ok';
}

/** What the ⚙ card and the plaque show of the house at table t (null at a
 *  table PR 2–4 opened, which no house plays): whether the room has a house
 *  at all (`setUp`: a delegation this page counted), whether it is heard now
 *  (`online`), the owner's setting (`fairness`), whether this page may set
 *  it (`canSet`: the deed holder's), whether the open round is a Fair one
 *  (`openFair`: its close names a house commitment; before the close, one
 *  must name the commitment the last round carried, or will name a house
 *  join of this round), and what a Fair round closed and undecided waits on
 *  (`waiting`): 'house' once every bettor's seed is in, 'offline' when no
 *  house is heard (nobody can reveal its seed: an abandon will void the
 *  round, and the next one runs Friendly); null otherwise. */
export interface ComputedHouseState {
  setUp: boolean;
  online: boolean;
  fairness: 'fair' | 'friendly';
  canSet: boolean;
  openFair: boolean;
  waiting: 'house' | 'offline' | null;
}

export function computedHouseState(t: string, now = Date.now()): ComputedHouseState | null {
  const inc = computedIncOf(t);
  if (inc === null || !houseRules(inc)) return null;
  const res = computedFoldOf(t);
  const tip = res?.tip ?? null;
  const online = houseOnline(now);
  const openFair = tip ? tip.closeRec.h !== undefined : res !== null && (res.required !== null || res.joins.length > 0);
  const waiting = !tip || tip.closeRec.h === undefined ? null
    : !online ? 'offline'
      : tip.revealed.length === tip.present.length ? 'house' : null;
  return { setUp: houseSetUp(), online, fairness: readFairSetting(t), canSet: holdsDeed(), openFair, waiting };
}

/**
 * 🏠 Move a table PR 2–4 opened (a `c` or `k` name: no house plays it) onto
 * a house table, once the room has a house (casinoDoc houseSetUp) and the
 * table is quiet: betting with no chip held (nothing on any felt, nothing
 * riding), no close in, the last result shown. In ONE transaction the old
 * incarnation ends as a switch-off ends it (its final checkpoint: its nets
 * count on, finalizeComputed) and the house table opens under the name
 * every page computes alike (computedIncFor: `r` or `d`). The house's
 * choice of owner-run play is untouched (the table stays computed). The
 * driving page's, with the automatic switch-on (autoSwitchComputed). True
 * when it moved the table.
 */
function migrateComputed(t: string, game: GameName, now: number): boolean {
  const inc = computedIncOf(t);
  if (inc === null || houseRules(inc) || gameOfInc(inc) !== game || !houseSetUp() || switchGate(t, now)) return false;
  const at = tableOf(t, game);
  if (!at) return false;
  const { st, res } = at;
  if (res.tip || res.held.size > 0 || res.openCloses.some((c) => c.state !== 'invalid')) return false;
  const e = viewOf(st, res, now);
  if (e.view.phase !== 'betting' || e.holding !== null) return false;
  const D = lastDecided(res);
  const u = D ? D.r : Math.max(1, res.base.u);
  const l = D ? D.close : res.base.l ?? NO_CLOSE;
  const cp: Checkpoint = signed(st.ctx, 'sum', { v: 1 as const, b: res.base.sid, u, l, n: netsOf(res), e: 1 as const, k: getIdentityPub() });
  endedByMe.add(nextSid(st.ctx, cp));
  return transactCasino(() => {
    if (!finalizeComputed(t, st.inc, cp)) return false;
    writeComputedOn(t, computedIncFor(t, game));
    return true;
  });
}

/** Whether compaction has an ended incarnation to finalise (computedEndedIncs:
 *  its sessions still in the doc), the room's tables or none: a removed
 *  table's is, after the room's last table goes; or one still to end, its
 *  table out of the room at this page's last tick (awayDuty), compacted
 *  after. World marks its frames as running tables while there is one
 *  (croupier noteTablesRunning), as it does while the room has a table: a
 *  page that stops marking them reads as asleep a lapse later (tablesAwake),
 *  for good, and both duties wait for an awake page. Only asked in a room
 *  with no table (World's frame), and never throws out of it (a throw is the
 *  computed tick's to tell: it reads the same). */
export function computedCompactionPending(): boolean {
  try {
    return away.size > 0 || computedEndedIncs().length > 0;
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

/** The dev flag as this page's address or storage sets it: `?computed=1`
 *  or `localStorage['ssf-dev-computed'] = '1'` on, `0` off (the address
 *  first), null where neither says (or a spec's setting). */
function devFlag(): boolean | null {
  if (enabledForTests !== null) return enabledForTests;
  try {
    const search = typeof window !== 'undefined' ? window.location?.search : undefined;
    const v = typeof search === 'string' ? new URLSearchParams(search).get('computed') : null;
    if (v === '0' || v === '1') return v === '1';
  } catch {
    /* no address to read */
  }
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('ssf-dev-computed') : null;
    if (v === '0' || v === '1') return v === '1';
  } catch {
    /* storage blocked: no flag there */
  }
  return null;
}

/** The dev flag: may this page's house switch a table to computed, and
 *  does its driving page switch the room's tables on by itself
 *  (autoSwitchComputed)? On unless turned off (devFlag: `0`). It gates only
 *  who may switch: a table switched already runs on every page of this
 *  build, flag or not. In a venture room the ⚙ card offers the way on only
 *  with the flag turned on by hand (computedSwitchState). */
export function computedTablesEnabled(): boolean {
  return devFlag() ?? true;
}

/** How often the driving page tries a table's switch by itself, at most. */
const AUTO_SWITCH_MS = 1_000;
const autoTriedAt = new Map<string, number>();

/**
 * 🔀 Tables run computed by default: the house's driving page (world
 * updateCroupier) switches each owner-run roulette and craps table on by
 * itself, as the ⚙ card's RUN WITHOUT THE OWNER would, once the switch may
 * go (switchComputedOn's own refusals: a round under way, a point on or a
 * come bet on a number, an earlier build driving the room, a page asleep or
 * not whole, a computed incarnation's switch taken away). Not with the dev
 * flag off, not at a table the house switched back (ownerRunChosen), and
 * not while a settled round's result shows: the switch goes where the
 * robot would open the next window (its deadline passed), so the wheel's
 * ball lands and the dice stop on every page first. At craps nor over a
 * window's bets or a don't come bet on its number (crapsBetsWait). At most
 * every AUTO_SWITCH_MS a table. True when it switched the table on. A table
 * already computed under a name PR 2–4 gave it, it moves onto a house table
 * once the room has a house (migrateComputed).
 */
export function autoSwitchComputed(t: string, game: GameName, now = Date.now()): boolean {
  if (!computedTablesEnabled() || ownerRunChosen(t)) return false;
  if (!isComputedTable(t) && resultShowing(t, game, now)) return false;
  const at = autoTriedAt.get(t);
  if (at !== undefined && now >= at && now - at < AUTO_SWITCH_MS) return false;
  autoTriedAt.set(t, now);
  if (isComputedTable(t)) return migrateComputed(t, game, now);
  if (game === 'craps' && crapsBetsWait(t)) return false;
  return switchComputedOn(t, game, now) === 'ok';
}

/** At craps, bets the automatic switch leaves up where the house's own
 *  press (after its warning) would hand them back, nobody having chosen
 *  it: a window's once any is down (the roll goes on: the switch comes at
 *  a show's end, as at roulette), and a don't come bet on its number,
 *  which stands in its player's favour (the switch waits for it to win or
 *  lose). */
function crapsBetsWait(t: string): boolean {
  const lists = Object.values(readAllCrapsBets(t));
  if (readCrapsTableState(t)?.phase === 'betting' && lists.length > 0) return true;
  return lists.some((bets) => bets.some((b) => b.type === 'dontcome' && b.pick !== undefined));
}

/** Whether owner-run table t shows a settled round's result still: until
 *  the deadline the robot opens the next window at (croupier
 *  tickAutoCroupier, crapsCroupier tickAutoStickman: the robot arms it on
 *  this page's clock first, timerOnThisClock). */
function resultShowing(t: string, game: GameName, now: number): boolean {
  const s = game === 'craps' ? readCrapsTableState(t) : readTableState(t);
  return s?.phase === 'settled' && !(s.phaseDeadline != null && now >= s.phaseDeadline);
}

/** Why the house's switch can't go now: this page asleep or waiting out a
 *  wake ('asleep'), its doc holding part of an update or signatures to check
 *  ('reconnecting'), a round under way ('busy'), an earlier build driving
 *  the room's tables ('old-build'), the table's records another game's
 *  ('craps': the other game's state up under its id, or a computed name for
 *  the other game), or at craps contract bets on the felt ('contract': a
 *  point on or a come bet on a number, before a switch-on; riding, before a
 *  switch-off, which a second press makes anyway). */
export type ComputedSwitchRefusal = 'asleep' | 'reconnecting' | 'busy' | 'old-build' | 'craps' | 'contract';
export type ComputedSwitchResult = 'ok' | ComputedSwitchRefusal;

const SWITCH_RECONNECTING = 'RECONNECTING — TRY AGAIN IN A MOMENT';

/** What the ⚙ card says of a refused switch-on. */
export const SWITCH_ON_REFUSED: Readonly<Record<ComputedSwitchRefusal, string>> = {
  asleep: SWITCH_RECONNECTING,
  reconnecting: SWITCH_RECONNECTING,
  busy: 'FINISH THIS ROUND FIRST',
  'old-build': "AN OLDER VERSION OF THE GAME RUNS THIS ROOM'S TABLES — UPDATE IT FIRST",
  craps: 'ONLY A ROULETTE TABLE CAN RUN WITHOUT THE OWNER',
  contract: 'WAIT FOR A COME-OUT WITH NO COME BETS ON A NUMBER',
};

/** …and of a refused switch-off (a round under way: its spin first). */
export const SWITCH_OFF_REFUSED: Readonly<Record<ComputedSwitchRefusal, string>> = {
  ...SWITCH_ON_REFUSED,
  busy: 'WAIT FOR THE SPIN TO FINISH',
  contract: 'PASS LINE AND COME BETS STILL RIDE — PRESS AGAIN TO HAND THEM BACK AND SWITCH',
};

/** …at a craps table: a roll, not a round or a spin. */
export const CRAPS_SWITCH_ON_REFUSED: Readonly<Record<ComputedSwitchRefusal, string>> = {
  ...SWITCH_ON_REFUSED,
  busy: 'FINISH THIS ROLL FIRST',
  craps: "THIS TABLE'S RECORDS ARE ANOTHER GAME'S",
};
export const CRAPS_SWITCH_OFF_REFUSED: Readonly<Record<ComputedSwitchRefusal, string>> = {
  ...SWITCH_OFF_REFUSED,
  busy: 'WAIT FOR THE ROLL TO FINISH',
  craps: "THIS TABLE'S RECORDS ARE ANOTHER GAME'S",
};

/** What the ⚙ card says before a switch-on: the room's default is Fair, and
 *  a computed table isn't. */
export const SWITCH_ON_CONFIRM = 'THIS TABLE WILL RUN FRIENDLY: SEEDS FROM THE PLAYERS ONLY';
/** …and at craps beside it: the switch takes every bet down. */
export const CRAPS_SWITCH_ON_CONFIRM = 'BETS ON THE FELT GO BACK TO THEIR PLAYERS';

/** Whether this page may switch anything now: awake, its doc whole, every
 *  computed table's signatures checked (as a spend waits: computedSettled). */
function switchGate(t: string, now: number): ComputedSwitchRefusal | null {
  if (!tablesAwake(now)) return 'asleep';
  if (!casinoWhole(t) || !computedSettled()) return 'reconnecting';
  // 🩹 (Nor while a peer's rewind or jump stands, in its restore's wait: an
  // end, or a migration's, would make the forged checkpoint final, as a
  // trim would, and nothing restores an end.)
  if (computedRestorePending(t)) return 'reconnecting';
  return null;
}

/** Why owner-run table t can't be switched on now, or null. Quiet at
 *  roulette: no round up, or one settled, or one betting with no list on it
 *  (a SPIN pressed is a closing round: never quiet). At craps: no roll up,
 *  or one betting or settled on a come-out ('busy' for a roll closing, its
 *  settle in flight; 'contract' for a point on, unless no felt has a bet),
 *  with no come bet on a number on any felt; the bets on it go back. Not
 *  where the table's records are the other game's, nor while a build older
 *  than the game's least drives the room's tables, nor while a computed
 *  incarnation of the table is live with its switch taken away
 *  ('reconnecting': it comes back). */
function onRefusal(t: string, game: GameName, now: number): ComputedSwitchRefusal | null {
  if (game === 'roulette' ? readCrapsTableState(t) !== null : readTableState(t) !== null) return 'craps';
  const inc = computedIncOf(t);
  if (inc !== null && isComputedTable(t) && gameOfInc(inc) !== game) return 'craps';
  const gate = switchGate(t, now);
  if (gate) return gate;
  // (A computed incarnation still live whose switch a peer took away: a
  // page that ran it puts it back by its next frame, putSwitchBack. A
  // switch-on now would end that incarnation, its open round void.)
  if (computedSwitchLost(t)) return 'reconnecting';
  if (leaseIsOldBuild(now, COMPUTED_MIN_BUILD[game])) return 'old-build';
  if (game === 'craps') {
    const c = readCrapsTableState(t);
    if (c?.phase === 'closing') return 'busy';
    const lists = Object.values(readAllCrapsBets(t));
    // (A point on with nothing on the felt holds nothing back: the computed
    // table starts on a come-out.)
    if (c && c.point !== null && lists.length > 0) return 'contract';
    return lists.some((bets) => bets.some((b) => b.type === 'come' && b.pick !== undefined)) ? 'contract' : null;
  }
  const s = readTableState(t);
  const quiet = s === null || s.phase === 'settled' || (s.phase === 'betting' && Object.keys(readAllBets(t, s.round)).length === 0);
  return quiet ? null : 'busy';
}

/** Whether a craps state's riding bets hold a contract bet: a pass with a
 *  point on, or a come bet on a number. */
function contractRides(carry: CrapsCarry): boolean {
  for (const pid of Object.keys(carry.w)) {
    for (const b of own(carry.w, pid)) {
      if ((b.type === 'pass' && carry.p !== 0) || (b.type === 'come' && b.pick !== undefined)) return true;
    }
  }
  return false;
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
function offRefusal(t: string, now: number, again = false): ComputedSwitchRefusal | null {
  const gate = switchGate(t, now);
  if (gate) return gate;
  const at = tableOf(t);
  if (!at) return null;
  const e = viewOf(at.st, at.res, now);
  if (e.holding !== null) return 'busy';
  if (at.st.game !== 'craps') return null;
  // At craps: during the wait for the throw while the holder's page can
  // still close the roll at its fling (their latest version on it has chips
  // and isn't a goodbye), so a press from a page whose link lags doesn't
  // finalise without a roll other pages already show. Once the wait is over,
  // or with the holder gone, it goes, so a table a gone shooter holds is
  // still freed. Then contract bets riding warn first: the second press
  // hands them back with the rest.
  const view = e.view as ComputedCrapsState;
  if (view.phase === 'closing' && view.phaseDeadline !== undefined && (view.shooterSlip === 'here' || view.shooterSlip === 'away')) {
    return 'busy';
  }
  return !again && contractRides(at.res.carry as CrapsCarry) ? 'contract' : null;
}

/**
 * 🔀 The house switches roulette table `t` to computed (the ⚙ card, after
 * its confirmation): in ONE transaction, the owner-run incarnation ends as a
 * removal ends it (refundAndClear: its lists stop holding, what an earlier
 * build's took is refunded, its book counts on; the house's settings for the
 * table stay, hidden while it is computed, for when it is owner-run again:
 * keepConfig), and the computed one starts under a name every page computes
 * alike (computedIncFor: two of the house's pages pressing at once open one
 * table), with its first session. Refused while the owner-run table has a
 * round under way, while an earlier build drives the room's tables (it would
 * go on opening owner-run rounds on this one), and on a page asleep or not
 * whole. At craps also while a point is on or a come bet sits on a number
 * (contract bets: they can't come down), and the bets on the felt go back to
 * their players, as a take-down would; its name is a craps one (`k…`), so
 * every page plays it as craps. 'ok' for a table that is computed already.
 * It clears the house's choice of owner-run play (ownerRunChosen).
 */
export function switchComputedOn(t: string, game: GameName = 'roulette', now = Date.now()): ComputedSwitchResult {
  lookAtClock(now);
  const refused = onRefusal(t, game, now);
  if (refused) return refused;
  if (isComputedTable(t)) return 'ok';
  transactCasino(() => {
    refundAndClear(t, 'local', { keepConfig: true });
    writeComputedOn(t, computedIncFor(t, game));
    writeOwnerRunChosen(t, false);
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
 * ended. At craps (offRefusal) not during the wait for the throw while the
 * holder can still throw; and while contract bets ride, only on the second
 * press (`again`): every riding bet goes back, the final checkpoint carrying
 * none of them. It marks the house's choice (ownerRunChosen), so the driving
 * page doesn't switch the table on again by itself (autoSwitchComputed).
 */
export function switchComputedOff(t: string, now = Date.now(), again = false): ComputedSwitchResult {
  lookAtClock(now);
  if (!isComputedTable(t)) return 'ok';
  const refused = offRefusal(t, now, again);
  if (refused) return refused;
  const at = tableOf(t);
  if (!at) {
    // (Nothing of it to finalise: the switch goes, its incarnation marked
    // ended, so a session of it turning up later is compacted as a removed
    // table's is, its nets counted, nothing held.)
    transactCasino(() => {
      writeComputedOff(t);
      writeOwnerRunChosen(t, true);
    });
    return 'ok';
  }
  const { st, res } = at;
  const D = lastDecided(res);
  const u = D ? D.r : Math.max(1, res.base.u);
  const l = D ? D.close : res.base.l ?? NO_CLOSE;
  const cp: Checkpoint = signed(st.ctx, 'sum', { v: 1 as const, b: res.base.sid, u, l, n: netsOf(res), e: 1 as const, k: getIdentityPub() });
  endedByMe.add(nextSid(st.ctx, cp));
  const done = transactCasino(() => {
    if (!finalizeComputed(t, st.inc, cp)) return false;
    writeComputedOff(t);
    writeOwnerRunChosen(t, true);
    return true;
  });
  return done ? 'ok' : 'reconnecting';
}

/** What the ⚙ card shows of the switch: the row at all (`show`: the house,
 *  with the dev flag, or without it on a table that is computed now), which
 *  way it is (`on`), whether a press would go now (`can`), and if not, why
 *  (`reason`, the card's words). At craps a switch-off with contract bets
 *  riding can go, its reason the warning its first press gives. */
export interface ComputedSwitchState {
  show: boolean;
  on: boolean;
  can: boolean;
  reason?: string;
}

/** The ⚙ card's switch row (ComputedSwitchState). The dev flag gates only
 *  the way on: a table that is computed shows the house the way back flag
 *  or not. A table runs computed on every page of this build once its
 *  switch is on, whoever wrote it, and a peer can write one (a forgery
 *  naming nothing the doc holds: the robot stands down, and no felt goes
 *  down); a house without the flag, shown no row, could only take the table
 *  out of the room and put it back. In a venture room (every shareholder the
 *  house, no page driving the tables: canRunCroupier) the way on shows only
 *  with the flag turned on by hand: no table lease is written there, so an
 *  earlier build's shareholder driving the tables by hand can't be told
 *  (leaseIsOldBuild), and would go on opening owner-run rounds on the
 *  table. */
export function computedSwitchState(t: string, game: 'craps' | 'roulette', house: boolean, now = Date.now()): ComputedSwitchState {
  // (Under any game's name: a name for the other game, forged or a peer's,
  // is the house's to take away too.)
  const on = isComputedTable(t);
  const show = house && (on || (canRunCroupier() ? computedTablesEnabled() : devFlag() === true));
  if (!show) return { show, on, can: false };
  lookAtClock(now);
  const refused = on ? offRefusal(t, now) : onRefusal(t, game, now);
  const words = game === 'craps' ? (on ? CRAPS_SWITCH_OFF_REFUSED : CRAPS_SWITCH_ON_REFUSED) : (on ? SWITCH_OFF_REFUSED : SWITCH_ON_REFUSED);
  if (!refused) return { show, on, can: true };
  return { show, on, can: on && refused === 'contract', reason: words[refused] };
}

/** Whether an earlier build drives computed table `t` too: an owner-run
 *  round (a roll, at craps) is up on it (that build's lease holder opened
 *  it; this build's sweeps it once its driver has gone, croupier
 *  sweepLegacyRound). */
export function computedOldBuildDriving(t: string): boolean {
  if (!isComputedTable(t)) return false;
  return gameOfInc(computedIncOf(t)!) === 'craps' ? readCrapsTableState(t) !== null : readTableState(t) !== null;
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
  /** At craps: how the roll took their felt (computedCraps RollFate), when
   *  they had one on it or bets riding; and, for a felt built on another
   *  table ('basis'), whether it changed anything there (its changes were
   *  undone: a ride slip had none). */
  fate?: RollFate;
  undone?: boolean;
  /** At craps (crapsMine): the chips they added on the roll and lost to a
   *  late or missing seed; whether their felt on it added chips over what
   *  rode in, a felt the close left out included; whether they had bets
   *  riding into it. */
  lost?: number;
  added?: boolean;
  riding?: boolean;
}

/** This page's player's part in craps roll R (ComputedMine's craps fields). */
function crapsMine(st: TableState, sc: Scan, R: RoundView, me: string, pub: string): { lost: number; added: boolean; riding: boolean } {
  const roll = R.craps!;
  const C = own(roll.sIn.w, me);
  const lost = clampSafe(roll.lost.get(me) ?? 0n);
  const B = R.present.includes(me) ? frozenSlip(sc, R, me)?.b : latestOwnSlip(st, sc, R.r, me, pub)?.b;
  const added = lost > 0 || (B !== undefined && addedOver(B as CrapsBet[], C) > 0) || (lateFor(st, R, me) && st.lateAdded);
  return { lost, added, riding: C.length > 0 };
}

/** Whether round R's close is the one a felt of this page's held back came
 *  too late for (lateFelt): it froze the same slip of this page's. */
const lateFor = (st: TableState, R: RoundView, me: string): boolean => st.lateFelt?.r === R.r && (R.frozen[me] ?? '') === st.lateFelt.frozen;

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
      const s = st.slipOf(sc.ses?.get(key));
      if (!s || s.k !== pub || !checkedSlip(st.t, st.inc, key, s, st.keyOf)) continue;
      if (s.v > v0 && parseKey(key)?.h !== frozenHash) later = true;
    }
  }
  // Left out only with chips down: the latest felt (a close freezes each
  // player's latest with chips on it), or one held back that the close
  // came before. A felt taken down before the close missed nothing.
  const staked = !frozen && (latestOwnSlip(st, sc, R.r, me, pub)?.b.length ?? 0) > 0;
  const fate = R.craps?.fates.get(me);
  return {
    round: R.r,
    frozen,
    revealed: frozen && R.revealed.includes(me),
    leftOut: !frozen && (frozenHash !== undefined || staked || lateFor(st, R, me)),
    tooLate: frozen && (later || lateFor(st, R, me)),
    ...(fate !== undefined ? { fate } : {}),
    ...(fate === 'basis' ? { undone: !rodeAsBuilt(frozenSlip(sc, R, me)) } : {}),
    ...(R.craps ? crapsMine(st, sc, R, me, pub) : {}),
  };
}

/** This page's player's latest felt of round r in the session: the version
 *  with the highest v (then hash), as the fold reads a felt, of those
 *  checked and signed by this page's key; null for none. */
function latestOwnSlip(st: TableState, sc: Scan, r: number, me: string, pub: string): AnySlipRec | null {
  let best: { s: AnySlipRec; h: string } | null = null;
  for (const key of sc.slips.get(r)?.get(me) ?? []) {
    const s = st.slipOf(sc.ses?.get(key));
    if (!s || s.k !== pub || !checkedSlip(st.t, st.inc, key, s, st.keyOf)) continue;
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

/** 🎲 This page's own fling for roll `round` of computed craps table `t`,
 *  with the seed it wrote in the throw record (the table session's two
 *  fling paths call it): the holder's page closes the roll at it, and its
 *  view offers no fling again for that roll. Never the throw record, which
 *  anyone can write. */
export function noteComputedFling(t: string, round: number, seed: number, now = Date.now()): void {
  lookAtClock(now);
  const st = tables.get(t);
  if (!st || st.game !== 'craps' || computedIncOf(t) !== st.inc) return;
  st.flung = { r: round, at: now, seed };
}

/** This page's own fling at computed craps table `t` (noteComputedFling),
 *  or null: its roll and seed. A re-show of the roll before forgets one made
 *  before it (the view, built here when the table moved), as do a wake
 *  and a checkpoint (noteResult). */
export function computedFlungFor(t: string, now = Date.now()): { r: number; seed: number } | null {
  lookAtClock(now);
  const at = tableOf(t, 'craps');
  if (!at) return null;
  viewOf(at.st, at.res, now);
  const f = at.st.flung;
  return f ? { r: f.r, seed: f.seed } : null;
}

/** 🎲 The last earlier roll of computed craps table `t` this page saw
 *  change (noteChanged), counted: seq 0 for none. */
export function computedRollChange(t: string): { seq: number; round: number; undid: [number, number] | null } {
  return tables.get(t)?.changed ?? { seq: 0, round: 0, undid: null };
}

/** 🎲 How many held changes this page has dropped at computed craps table
 *  `t` because the roll before changed under them (THE LAST ROLL CHANGED:
 *  the table's notice, once per change). */
export function computedUndoneCount(t: string): number {
  return tables.get(t)?.undone ?? 0;
}

/** The last round of computed table `t`'s live chain that is decided (its
 *  checkpoint's, with none since), or null: a round this page showed decided
 *  past it is undone (a delete took what it rests on, or the room kept the
 *  other side of a split). So is one it showed decided at the checkpoint's
 *  round that the checkpoint didn't keep (the other side of a split): the
 *  checkpoint's round is then not counted. With `game`, null too while
 *  the switch names the other game's incarnation (as every per-frame read:
 *  a game-blind read there would let go of this page's state for the live
 *  one, its seeds among it, for the other's). */
export function computedDecidedTo(t: string, game?: GameName): number | null {
  const at = tableOf(t, game);
  if (!at) return null;
  const D = lastDecided(at.res);
  if (D) return D.r;
  const { u, l } = at.res.base;
  return at.st.lastD && at.st.lastD.r === u && at.st.lastD.close !== l ? u - 1 : u;
}

/** 🎲 The close of roll `round` of computed craps table `t` this page saw
 *  first (its arrival stamp, computedSeenAt, and hash), of those the fold
 *  doesn't hold invalid: the roll's close on the chain once it is decided,
 *  else every close of the open roll naming its parent. Null for none. A
 *  dice throw counts as before the close when its stamp is no later
 *  (computedThrowSeenAt: one update stamps both alike). */
export function computedCrapsClose(t: string, round: number): { at: number; hash: string } | null {
  const at = tableOf(t, 'craps');
  if (!at) return null;
  const { res } = at;
  const hashes = round === res.open
    ? res.openCloses.filter((c) => c.state !== 'invalid').map((c) => c.hash)
    : res.rounds.filter((v) => v.r === round).map((v) => v.close);
  let best: { at: number; hash: string } | null = null;
  for (const hash of hashes) {
    const seenAt = computedSeenAt(t, `c:${round}:${hash}`);
    if (seenAt !== undefined && (!best || seenAt < best.at)) best = { at: seenAt, hash };
  }
  return best;
}

/** 🎲 The players with bets riding on computed craps table `t` whose key
 *  this room has never shown (no players-map entry has carried one): a
 *  rider who left before this page came, or one a modified page made up to
 *  fill the table. Display only, in pid order. */
export function computedUnknownRiders(t: string): string[] {
  const at = tableOf(t, 'craps');
  if (!at) return [];
  return Object.keys((at.res.carry as CrapsCarry).w).filter((pid) => keyFor(pid) === undefined).sort();
}

/** 🎲 Where this page's player stands at computed craps table `t`: its
 *  incarnation, the last roll decided on the chain, their net in it (the
 *  fold's, across trims), and whether they have bets riding. For the
 *  table's "while you were away" (page-local: a reload forgets it). */
export function computedTally(t: string): { inc: string; roll: number; net: number; riding: boolean } | null {
  const at = tableOf(t, 'craps');
  if (!at) return null;
  const me = getPlayerId();
  return {
    inc: at.st.inc,
    roll: lastDecided(at.res)?.r ?? at.res.base.u,
    net: clampSafe(at.res.nets.get(me) ?? 0n),
    riding: own((at.res.carry as CrapsCarry).w, me).length > 0,
  };
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
    if (st.game === 'craps') {
      leaveCraps(st, me, now);
      continue;
    }
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

/**
 * Say goodbye at craps table st: the riding bets can't come down (a pass on
 * its point, a come bet on a number), and a rider's bets play on whether or
 * not their page is there, so leaving writes a goodbye (`l: 1`) instead of
 * an empty felt — the felt as it was before this roll's new chips (they go
 * back: minPerSpot of the latest felt and the riding bets), or the riding
 * bets themselves when the latest felt was built on a table that has since
 * changed; and no stand. Written even when it only rides: the mark is what
 * lets the window let go of the gone (build), and a close leaves out a
 * goodbye that only rides. From then on this page writes no slip at the
 * table (st.left) while its frames run on for the leave's last writes, so it
 * can't undo its own goodbye. Only over a version this page wrote (another
 * tab of its player's is still at the table, its seed with it), and not
 * while a close of the roll is in (it holds what it froze).
 */
function leaveCraps(st: TableState, me: string, now: number): void {
  st.left = true;
  st.pending = null;
  if (!tablesAwake(now) || !casinoWhole(st.t) || !computedSettled(st.t)) return;
  const res = computedFoldOf(st.t);
  const latest = res?.felts.get(me);
  const rec = latest?.rec as CrapsSlipRec | undefined;
  if (!res || !latest || !rec || !st.mine.has(latest.key) || rec.l === 1) return;
  if (res.tip || res.openCloses.some((c) => c.state !== 'invalid')) return;
  const carry = res.carry as CrapsCarry;
  const C = own(carry.w, me);
  if (rec.b.length === 0 && C.length === 0) return;
  const basis = basisOf(carry, me);
  st.lastSlip = null;
  // (One built on a table that is no more goes as the riding bets, its
  // changes undone, as rideDuty would have written them after the show: not
  // on a roll this page saw played, open again only by a peer's delete.)
  if (res.open > playedTo(st, res) && rec.o !== basis && !rodeAsBuilt(rec) && !sameFelt(rec.b, C)) noteUndone(st, res.open);
  try {
    writeSlip(st, res, res.open, rec.o === basis ? minPerSpot(rec.b, C) : C, false, now, { o: basis, l: 1 });
  } catch {
    /* best effort */
  }
}

/** Back in the room without a new binding (the back-forward cache): this
 *  page's goodbyes no longer hold, and its slip writers run again (rideDuty
 *  writes each goodbye again as the felt it was); changes undone as it left
 *  are said now (noteUndone). */
export function backAtComputedTables(): void {
  for (const st of tables.values()) {
    st.left = false;
    if (!st.undoneAway) continue;
    st.undoneAway = false;
    st.undone += 1;
    notifyCasinoView(st.t);
  }
}

// Best effort on page close: the write may not flush.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => leaveComputedTables());
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) backAtComputedTables();
  });
}
