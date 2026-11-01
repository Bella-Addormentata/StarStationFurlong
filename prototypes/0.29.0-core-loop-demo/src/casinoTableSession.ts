/**
 * 🎲🎡 Craps and roulette on the 3D table (#226) — the live layer between the
 * casino doc and the table pieces (casinoTable3d.ts), and the focused-table
 * controls that replace the old 2D popups.
 *
 * TWO HALVES:
 *  - casinoTablesFrame (every client, every frame): reads each table's synced
 *    record, bets, seats and the last dice throw from the casino map and lays
 *    them onto the table — every chip on the felt in front of its owner, the
 *    dice (resting at the shooter, flying, landing on the settled faces), the
 *    ON/OFF pucks, the roulette wheel and ball, the winning boxes lit, and
 *    once a craps roll's dice are down, the losing chips swept into the
 *    house in front of the stickman and the winners paid out of it onto
 *    their rails (crapsSettleShow). There is no separate game surface:
 *    spectators watch the same pieces the players touch (the
 *    diegetic-display rule air hockey set).
 *  - createCasinoTableUI (the focused player): a full-screen capture layer
 *    that turns pointer input into table actions, a slim status bar, and the
 *    ⚙️ settings card. Press and drag across the chips in your rail to pick
 *    some up; click a box on the felt to bet them (each further click bets
 *    the same chips again); click your own chips on the felt to pick back up
 *    what you put down this round (or a bet that may come down any time);
 *    the round ↶ button at the end of your rail (or C) takes every bet of
 *    yours that may come down back at once; right-click puts the hand back. When the
 *    dice come to you, grab them and fling them across the table.
 *
 * THE RULES OF MONEY: a chip on the felt stays yours, held there by your bet
 * list, until the round settles (casinoDoc STAKES ON THE FELT); the hand is
 * a local view of chips still in your balance. The settle, the payouts and the
 * shooter rotation stay with the elected operator (croupier.ts /
 * crapsCroupier.ts). The fling is cosmetic: the dice faces come from the
 * table's fairness mode, and every client animates the same throw from the
 * synced `throw:<tableId>` record.
 *
 * 🧮 A COMPUTED roulette table (computedTable.ts) has no operator: its
 * state, felt and verdict come from the fold of the players' records on
 * this page's clock, a felt goes down as a signed slip, and the wheel spins
 * once per result (its spin key). Every branch asks isComputedFor live, so
 * a switch mid-visit turns the table under the player's hands.
 *
 * 🎲 A computed CRAPS table the same way, its felt one amount per spot (a
 * slip's), bets riding from roll to roll. The shooter's page offers the
 * fling, and closes the roll at it, from its own fling only; the throw
 * record is animation, and each page shows one flight a roll: the
 * shooter's throw when it came before the roll's close (by casinoDoc's
 * arrival stamps), else the stickman's toss at the close, on the shooter's
 * own page only its own fling. The dice land on the fold's faces.
 */

import * as THREE from 'three';
import {
  casinoDocEpoch, casinoWhole, clearMySeat, computedIncEnded, computedSettled, computedThrowSeenAt, isComputedFor, readAllBets,
  readAllCrapsBets, readChips, readSeedRecord, readCrapsBackendPref, readCrapsFairnessPref, readCrapsTableState,
  readDiceThrow, readMyBets, readMyCrapsBets, readSeat, readSeats, readTableState,
  subscribeCasino, writeCrapsBackendPref, writeCrapsFairnessPref,
  writeDiceThrow, writeMyBets, writeMyCrapsBets, writeMySeat, writeTableState,
} from './casinoDoc';
import type { DiceThrow, TableSeat } from './casinoDoc';
import { railStacks, RAIL_PITCH, TAKE_DOWN_R } from './casinoTable3d';
import type { CasinoTableVisualHandle, FeltStack, RailSpec, RailStack } from './casinoTable3d';
import { CHIP_DENOMS, railChipCounts } from './chipDisplay';
import {
  closeBetting, isCroupierLive, openBetting, RECONNECTING_NOTICE, rollAndSettle, ROULETTE_PAGE_ID, spinSeenAt,
  SPIN_TAKEOVER_MS, tablesAwake,
} from './croupier';
import {
  computedCrapsClose, computedDecidedTo, computedFlungFor, computedMine, computedOldBuildDriving, computedRollChange,
  computedHouseState, computedRoundCheck, computedSwitchState, computedTally, computedUndoneCount, computedUnknownRiders, CRAPS_SWITCH_OFF_REFUSED,
  CRAPS_SWITCH_ON_CONFIRM, CRAPS_SWITCH_ON_REFUSED, noteComputedFling, readComputedBets, readComputedCraps,
  readComputedCrapsBets, readComputedRoulette, readMyComputedBets, readMyComputedCrapsBets, SWITCH_OFF_REFUSED,
  setComputedFairness, SWITCH_ON_CONFIRM, SWITCH_ON_REFUSED, switchComputedOff, switchComputedOn, writeComputedCrapsSlip,
  writeComputedSlip,
} from './computedTable';
import type { ComputedCrapsState, ComputedRouletteState, ComputedSlipWrite } from './computedTable';
import { noteComputedToss } from './computedRobot';
import { crapsBackend } from './crapsBackend';
import { crapsSettleMoves } from './crapsSettleShow';
import type { SettleVerdict } from './crapsSettleShow';
import {
  markLocalSeat, NO_HAND_ROLL, openCrapsBetting, pressManualRoll, STICKMAN_DICE_SPOT,
} from './crapsCroupier';
import { deviceFocus } from './deviceFocus';
import type { DeviceUI } from './devices';
import { FURNITURE, FURNITURE_DEFS } from './furniture';
import {
  assignClearSlots, chipSlots, crapsChipRect, crapsDealerPlaced, CRAPS_HOUSE_SPOT, crapsOddsBaseRect, crapsSideFor, CRAPS_LAYOUT,
  CHIP_RADIUS, dealerSpot, hitRegion, hitSettings, LAY_PAYS, nearestInDirection, ODDS_PAYS, regionCenter,
  rouletteChipColors, ROULETTE_LAYOUT, spotKey,
} from './games/casinoLayout';
import type { CrapsSpot, FeltLayout, FeltPoint, FeltRect, FeltRegion } from './games/casinoLayout';
import {
  canPlaceBet, canTakeDown, crapsBetLabel, isOddsType, MAX_LAY_MULTIPLE, MAX_ODDS_MULTIPLE, oddsFlat, oddsRoom, pointWasOn,
  rollCall,
} from './games/craps';
import type { CrapsBet, CrapsTableState, FairnessMode } from './games/craps';
import { FAIRNESS_MODES, getCrapsFairnessMode, verifyTranscript } from './games/diceFairness';
import { isFairTable, MAX_TABLE_BETTORS, REVEAL_GRACE_MS, roundIsFair, tickFairSeeds, verifySettledRound } from './fairTableSeeds';
import { readPlayerDisplayName } from './games/gamesDoc';
import { betLabel, payoutFor, pocketColor } from './games/roulette';
import { escapeHtml } from './htmlEscape';
import { showHint } from './hud';
import type { RouletteBet, RouletteTableState } from './games/roulette';
import { getPlayerId } from './identity';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** ⚖️ The plaque line for the round on a table: Fair (the round runs the
 *  seed exchange) or Friendly (you are trusting the owner's client). It names
 *  the mode, not the outcome: whether a given result really took bettors'
 *  seeds is the ⚙ card's verdict line, which warns on house-seed-only. */
export function fairnessBadge(tableId: string, game: 'craps' | 'roulette'): { text: string; color: string; fair: boolean } {
  // 🧮 A computed table has no owner to trust. 🏠 Its round is Fair when the
  // house adds a seed to it (the owner's node: nobody, a bettor alone at the
  // table included, knows the result before it is decided); else the seeds
  // are the players' only. A table PR 2–4 opened, or one in a room with no
  // house, never has the house's.
  if (isComputedFor(tableId, game)) {
    const h = computedHouseState(tableId);
    if (!h?.setUp) return { text: "PLAYERS' TABLE · NO OPERATOR · SEEDS FROM THE PLAYERS", color: FRIENDLY_RED, fair: false };
    if (h.openFair) return { text: "✔ FAIR · PLAYERS' TABLE · THE HOUSE AND EVERY BETTOR ADD A SEED", color: '#7CF5B0', fair: true };
    const why = h.fairness === 'friendly' ? 'FRIENDLY · THE OWNER CHOSE NO HOUSE SEED'
      : !h.online ? 'FRIENDLY · THE HOUSE IS OFFLINE'
        : `FRIENDLY THIS ${game === 'craps' ? 'ROLL' : 'ROUND'} · THE HOUSE JOINS THE NEXT`;
    return { text: `PLAYERS' TABLE · ${why}`, color: FRIENDLY_RED, fair: false };
  }
  return roundIsFair(tableId, game)
    ? { text: '✔ FAIR TABLE · EVERY BETTOR ADDS A SEED · CHECK EACH RESULT ON ⚙', color: '#7CF5B0', fair: true }
    : { text: "🤝 FRIENDLY TABLE · YOU'RE TRUSTING THE OWNER", color: FRIENDLY_RED, fair: false };
}

/** The Friendly plaque's red. */
const FRIENDLY_RED = '#F28B87';

/** How long a fresh lease write gets to converge before its page settles. */
const LEASE_SETTLE_MS = 600;

/** 🧮 What a press that runs a round says at a computed table. */
const NO_HAND_SPIN = "NOBODY SPINS THIS TABLE BY HAND — IT SPINS ONCE THE BETTORS' SEEDS ARE IN";
/** 🎲 A computed craps slip built on a table that changed under it. */
const CHANGES_UNDONE = 'THE LAST ROLL CHANGED — YOUR CHANGES WERE UNDONE · PLACE THEM AGAIN';
/** 🎲 Riding bets the leave notice names before `· AND N MORE`. */
const LEAVE_LIST_MAX = 4;
/** 🎲 How long the walk-off notice stays up (it names up to four bets). */
const LEAVE_HINT_MS = 5_000;
/** 🎲 How long the status bar calls a flight rolling: past it the dice lie
 *  on the felt, faceless, until the seeds are in. */
const ROLLING_MS = 3_200;

/** Friendly tables this page has already warned about (once per table). */
const friendlyWarned = new Set<string>();

/** How often a focused player refreshes their seat (the operator's liveness). */
const SEAT_BEAT_MS = 5_000;
/** Rail pickup: first repeat while you hold over one stack, then faster. */
const PICKUP_REPEAT_MS = 420;
const PICKUP_REPEAT_MIN_MS = 140;
/** A fling slower than this (m/s across the felt) just drops the dice. */
const FLING_MIN_SPEED = 0.7;
/** …and this fast or more is a full-power throw. */
const FLING_FULL_SPEED = 4.5;
/** How far back the fling velocity is measured over. */
const FLING_WINDOW_MS = 120;
/** Most chips one hand holds (a fistful — and the pool has room for it). */
const HAND_MAX = 40;

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#7C8794';
const PINK = '#FF2D95';
const WIN = '#00E676';

// ── Stands → table-local positions ───────────────────────────────────────────

type TableKind = 'craps-table' | 'roulette-table';

function tableItem(tableId: string) {
  return FURNITURE.find((i) => i.id === tableId && (i.kind === 'craps-table' || i.kind === 'roulette-table'));
}

/** A stand's position in the table's own frame (the stand templates are
 *  authored there, which is the frame every felt coordinate uses). */
function standLocal(kind: TableKind, stand: number): FeltPoint | null {
  const t = FURNITURE_DEFS[kind].stands?.[stand];
  return t ? { x: t.stand.x, z: t.stand.z } : null;
}

/** Each seated player's stand position (chip anchors, the shooter's spot). */
function seatAnchors(kind: TableKind, seats: Record<string, TableSeat>): Map<string, FeltPoint> {
  const out = new Map<string, FeltPoint>();
  for (const [pid, seat] of Object.entries(seats)) {
    const p = standLocal(kind, seat.stand);
    if (p) out.set(pid, p);
  }
  return out;
}

/** The rail in front of a stand: along the near long side, or across an end. */
export function railFor(stand: FeltPoint, halfX: number, halfZ: number): RailSpec {
  if (Math.abs(stand.z) > halfZ) {
    const len = 0.62;
    const lim = halfX - len / 2 - 0.04;
    return { x: Math.max(-lim, Math.min(lim, stand.x)), z: Math.sign(stand.z) * halfZ, axis: 'x', len };
  }
  return { x: Math.sign(stand.x || 1) * halfX, z: 0, axis: 'z', len: Math.min(0.62, halfZ * 2 - 0.12) };
}

/** Your rail split for the ↶ take-down button: the chips keep all but the
 *  last pitch at your right-hand end, where the button sits (`inward`: the
 *  way you face across the table). */
export function railWithTakeDown(rail: RailSpec, inward: FeltPoint): { chips: RailSpec; button: FeltPoint } {
  // Your right hand, facing `inward` with up toward you: (−inward.z, inward.x).
  const right = rail.axis === 'x' ? Math.sign(-inward.z) || 1 : Math.sign(inward.x) || 1;
  const slot = Math.max(RAIL_PITCH, TAKE_DOWN_R * 2 + 0.01);
  const len = Math.max(RAIL_PITCH, rail.len - slot);
  const shift = right * (slot / 2);
  const end = right * (rail.len / 2 - slot / 2);
  return rail.axis === 'x'
    ? { chips: { ...rail, x: rail.x - shift, len }, button: { x: rail.x + end, z: rail.z } }
    : { chips: { ...rail, z: rail.z - shift, len }, button: { x: rail.x, z: rail.z + end } };
}

/** The bets "take me down" returns, and the ones that stay: roulette's all
 *  come off while betting is open; craps keeps its contract bets (a pass
 *  line bet with a point on, a come bet that has travelled). */
export function splitTakeDown<B extends { type: string; pick?: number; amount: number }>(
  game: 'craps' | 'roulette',
  bets: readonly B[],
  point: number | null,
): { back: B[]; keep: B[] } {
  const back: B[] = [];
  const keep: B[] = [];
  for (const b of bets) {
    if (game === 'roulette' || canTakeDown(b as unknown as CrapsBet, point)) back.push(b);
    else keep.push(b);
  }
  return { back, keep };
}

/** Where the dice rest in front of a shooter's stand, on the felt. */
function diceSpotFor(stand: FeltPoint, felt: FeltRect): FeltPoint {
  const clampX = (x: number) => Math.max(felt.x0 + 0.15, Math.min(felt.x1 - 0.15, x));
  const clampZ = (z: number) => Math.max(felt.z0 + 0.1, Math.min(felt.z1 - 0.1, z));
  if (Math.abs(stand.z) > (felt.z1 - felt.z0) / 2) {
    return { x: clampX(stand.x), z: Math.sign(stand.z) * ((felt.z1 - felt.z0) / 2 - 0.09) };
  }
  return { x: Math.sign(stand.x || 1) * ((felt.x1 - felt.x0) / 2 - 0.1), z: clampZ(stand.z) };
}

// ── Per-table runtime (every client) ─────────────────────────────────────────

interface TableRuntime {
  /** The room doc this runtime was built in (casinoDocEpoch): another room
   *  can hold a table with the same id at the same round, so its state never
   *  carries over a rebind. */
  epoch: number;
  /** First frame done — history seen before that is never animated. */
  primed: boolean;
  /** Seed of the last dice throw this client started animating. */
  thrownSeed: number | null;
  /** Craps: the settled round whose faces were handed to the dice. */
  landedRound: number;
  /** Roulette: the settled round whose spin was started. */
  spunRound: number;
  /** 🧮 A computed table: the incarnation the runtime was primed on (null
   *  while the table is owner-run); whether it has seen the table counted
   *  and checked yet (`counted`: what showed by then showed before it
   *  looked); and by round, the pocket whose spin it last started, or found
   *  showing then: a round's pocket changes only with a rewrite. */
  computed: string | null;
  counted: boolean;
  spun: Map<number, number>;
  /** 🎲 A computed craps table: the flight this page started for a roll
   *  (the shooter's throw or the stickman's toss, one a roll: `at` −Infinity
   *  for one that showed before this page looked), and whether it got its
   *  faces or was called off; `close` when it stands for the roll's close
   *  (the toss, or a close in before this page looked), not a throw. `spun`
   *  holds each roll's dice (`d1d2`). */
  flight: { r: number; at: number; done: boolean; close?: true } | null;
  /** …and by roll, the dice it handed it, the decision they came from
   *  (rollBy) and its close, kept through a hold, which forgets them in
   *  `spun`: the roll held again under that close flies nothing, nor does
   *  the same decision shown again. */
  landed: Map<number, { dice: number; by: string; close: string }>;
  /** …and the end of the show before the open roll's window, as the view
   *  last had it while that roll was open (a throw from before it doesn't
   *  play, even once the roll has settled). */
  openShow: { r: number; end: number } | null;
  /** …and the last re-arm the view has shown for a roll (rearmAt), kept
   *  here through a wake, which forgets the view's: a throw seen by then
   *  doesn't play once the roll closes again. */
  reopened: { r: number; at: number } | null;
  /** 💰 Craps: the felt as last laid for a roll (each bettor's bets, the
   *  stacks drawn, the point in force, and whether it was the roll's
   *  result), the settle whose chip moves were played last (paidKey), and
   *  whether the roll on screen is closed with its result still to show
   *  here (crapsRollInPlay). */
  played: { round: number; settled: boolean; bets: Record<string, CrapsBet[]>; stacks: FeltStack[]; point: number | null } | null;
  paidKey: string;
  inPlay: boolean;
  /** Doc changed since the felt was last laid out. */
  dirty: boolean;
}

const runtimes = new Map<string, TableRuntime>();
let unsubscribeDoc: (() => void) | null = null;

function runtime(tableId: string): TableRuntime {
  let rt = runtimes.get(tableId);
  if (!rt || rt.epoch !== casinoDocEpoch()) {
    rt = {
      epoch: casinoDocEpoch(), primed: false, thrownSeed: null, landedRound: 0, spunRound: 0, computed: null, counted: false,
      spun: new Map(), flight: null, landed: new Map(), openShow: null, reopened: null, played: null, paidKey: '', inPlay: false,
      dirty: true,
    };
    runtimes.set(tableId, rt);
  }
  return rt;
}

function markAllDirty(): void {
  for (const rt of runtimes.values()) rt.dirty = true;
}

/** Lay the table's felt out again on its next frame: a computed felt held
 *  back to write (the coalescing) shows at once, with no transaction to say
 *  so. */
function markDirty(tableId: string): void {
  const rt = runtimes.get(tableId);
  if (rt) rt.dirty = true;
}

/** 🧮 What this page has shown of a computed table's results: the pocket of
 *  each round whose spin key it saw (at craps the dice of each roll, by its
 *  roll key), a later key for one of those rounds with another pocket being
 *  a rewrite (counted, for the focused table's notice), and the last round
 *  it showed decided (one no longer on the chain is undone). Per table, for
 *  one room doc and incarnation. */
interface ComputedShown {
  epoch: number;
  inc: string;
  pockets: Map<number, number>;
  shown: number;
  rewrites: number;
  rewrittenRound: number;
}

const computedShown = new Map<string, ComputedShown>();
/** Rounds of a table's pockets kept (a rewrite reaches back no further
 *  than the session, TRIM_ROUNDS). */
const SHOWN_ROUNDS = 64;

/** The round and pocket of a spin key (`<round>:<pocket>`), or null; of a
 *  craps roll key (`<roll>:<d1><d2>`), the roll and its dice as d1d2. */
function spinKeyParts(key: string): { round: number; pocket: number } | null {
  const m = /^(\d+):(\d+)$/.exec(key);
  return m ? { round: Number(m[1]), pocket: Number(m[2]) } : null;
}

/** Note what computed table `tableId` shows now: its incarnation, and its
 *  view's spin key (at craps its roll key). */
function seeComputed(tableId: string, inc: string, key: string): ComputedShown {
  let c = computedShown.get(tableId);
  if (!c || c.epoch !== casinoDocEpoch() || c.inc !== inc) {
    c = { epoch: casinoDocEpoch(), inc, pockets: new Map(), shown: 0, rewrites: 0, rewrittenRound: 0 };
    computedShown.set(tableId, c);
  }
  const k = spinKeyParts(key);
  if (k) {
    const was = c.pockets.get(k.round);
    if (was !== undefined && was !== k.pocket) {
      c.rewrites += 1;
      c.rewrittenRound = k.round;
    }
    c.pockets.delete(k.round);
    c.pockets.set(k.round, k.pocket);
    while (c.pockets.size > SHOWN_ROUNDS) c.pockets.delete(c.pockets.keys().next().value as number);
    if (k.round > c.shown) c.shown = k.round;
  }
  return c;
}

/** Tables whose dice the LOCAL shooter is holding — the frame driver leaves
 *  those dice alone (the focused UI moves them under the cursor). */
const localHold = new Set<string>();

/** Render bounds on what peers wrote to the room doc: the bet guards accept
 *  any positive stake and any list length, and the felt must never expand one
 *  wild record into millions of chips. Settlement still sees the real bets. */
const MAX_BETS_DRAWN_PER_PLAYER = 400;
const MAX_STACK_CHIPS = 60;
/** And a table-wide chip budget, so many modest peer records can't grow the
 *  GPU pools without limit either. The budget is spent in player-id order,
 *  the same on every client, so everyone draws the same chips of everyone
 *  else; your own bets are always drawn for you (you need them to take them
 *  back), spending the budget exactly as they would on anyone's screen. */
const MAX_TABLE_CHIPS = 2400;

/** chipsFor, stopping at `max` chips (largest first) without looping per chip. */
function chipsUpTo(amount: number, max: number): number[] {
  const out: number[] = [];
  let left = Math.max(0, Math.floor(amount));
  for (const d of CHIP_DENOMS) {
    const n = Math.min(Math.floor(left / d), max - out.length);
    for (let i = 0; i < n; i++) out.push(d);
    left -= n * d;
    if (out.length >= max) break;
  }
  return out;
}

/** How many chips the felt draws `amount` as (chipsUpTo's, with no cap),
 *  counted without making them: a merged stake can be any size. */
function drawnChips(amount: number): number {
  let left = Math.max(0, Math.floor(amount));
  let n = 0;
  for (const d of CHIP_DENOMS) {
    const k = Math.floor(left / d);
    n += k;
    left -= k * d;
  }
  return n;
}

/** Where one bet's chips go. */
export interface ChipPlan {
  /** The chip area. */
  rect: FeltRect;
  /** The fixed spot a dealer sets this player's stack at (by where they
   *  stand). Every stand's spot in a box clears every other's. */
  spot?: FeltPoint;
  /** Otherwise, a box too small for a spot per stand: take the free slot
   *  nearest `anchor`, in stand order (`rank`). Absent for a bet the player
   *  sets in front of themselves (nearest their stand, in player order). */
  near?: { anchor: FeltPoint; rank: number };
  /** In a box with a spot per stand: every stand's spot, the first places a
   *  bettor without a spot (they left the table) looks for room. */
  spare?: readonly FeltPoint[];
  /** Odds riding squarely on a flat bet: that bet's spotKey (same rect). A
   *  heel would push into a neighbour's stack (the spots sit a chip apart). */
  rideOn?: string;
}

/** Bets laid out as stacks: one per player per box, bottom chip the largest.
 *  A dealer-set bet goes at its owner's spot; any other bet takes the room
 *  nearest its owner clear of the stacks already down (assignClearSlots).
 *  Odds sit on top of their flat bet. */
function layoutStacks<B extends { type: string; pick?: number; amount: number }>(
  betsByPlayer: Record<string, B[]>,
  anchors: Map<string, FeltPoint>,
  planFor: (bet: B, pid: string) => ChipPlan | null,
  me: string,
  colorFor: (pid: string) => string | undefined = () => undefined,
): FeltStack[] {
  const groupKey = (key: string, r: FeltRect) => `${key}|${r.x0.toFixed(3)},${r.z0.toFixed(3)}`;
  const groups = new Map<string, {
    rect: FeltRect;
    spot: string;
    chips: Map<string, number[]>;
    spots: Map<string, FeltPoint>;
    near: Map<string, NonNullable<ChipPlan['near']>>;
    spare: readonly FeltPoint[];
    rideOn?: string;
  }>();
  const pidOrder = Object.keys(betsByPlayer).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let budget = MAX_TABLE_CHIPS;
  for (const pid of pidOrder) {
    const bets = betsByPlayer[pid];
    const mine = pid === me;
    if (budget <= 0 && !mine) continue;
    for (const b of bets.slice(0, MAX_BETS_DRAWN_PER_PLAYER)) {
      if (budget <= 0 && !mine) break;
      const plan = planFor(b, pid);
      if (!plan) continue;
      const key = groupKey(spotKey(b), plan.rect);
      let g = groups.get(key);
      if (!g) {
        g = {
          rect: plan.rect, spot: spotKey(b), chips: new Map(), spots: new Map(), near: new Map(), spare: plan.spare ?? [], rideOn: plan.rideOn,
        };
        groups.set(key, g);
      }
      if (plan.spot) g.spots.set(pid, plan.spot);
      else if (plan.near) g.near.set(pid, plan.near);
      const list = g.chips.get(pid) ?? [];
      if (list.length >= MAX_STACK_CHIPS) continue;
      // One chip per bet record when it's a real chip; any other stake (an
      // older client's 10 or 250) shows as the chips it breaks into.
      const room = MAX_STACK_CHIPS - list.length;
      const add = chipsUpTo(b.amount, mine ? room : Math.min(room, budget));
      budget -= Math.min(add.length, Math.max(0, budget));
      list.push(...add);
      g.chips.set(pid, list);
    }
  }
  // Where each group's stacks stand: dealer spots as given, the rest one by
  // one in the room nearest their owners (spare stand spots first, then the
  // grid), each a chip's width clear of every stack already down (a bettor
  // who left the table keeps their bets, but not a spot). A box with no
  // room left shares rather than hide a live bet.
  const placed = new Map<string, Map<string, FeltPoint>>();
  for (const [key, g] of groups) {
    // One player per spot: two seated at one stand (the table's fallback
    // when none is free) means the first, in player order, keeps it and the
    // other looks for room like a bettor without a spot.
    const at = new Map<string, FeltPoint>();
    for (const pid of [...g.spots.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const q = g.spots.get(pid)!;
      if ([...at.values()].every((f) => Math.hypot(q.x - f.x, q.z - f.z) >= CHIP_RADIUS * 2)) at.set(pid, q);
    }
    const loose = [...g.chips.keys()].filter((pid) => !at.has(pid));
    if (loose.length > 0) {
      const got = assignClearSlots([...g.spare, ...chipSlots(g.rect)], [...at.values()], loose.map((pid) => {
        const n = g.near.get(pid);
        return { pid, anchor: n?.anchor ?? anchors.get(pid) ?? null, rank: n?.rank };
      }));
      for (const [pid, p] of got) at.set(pid, p);
    }
    placed.set(key, at);
  }
  const out: FeltStack[] = [];
  for (const [key, g] of groups) {
    const at = placed.get(key)!;
    const under = g.rideOn ? groups.get(groupKey(g.rideOn, g.rect)) : undefined;
    const underAt = g.rideOn ? placed.get(groupKey(g.rideOn, g.rect)) : undefined;
    for (const [pid, chips] of g.chips) {
      let p = at.get(pid);
      let lift = 0;
      const base = underAt?.get(pid);
      if (base) {
        p = base;
        lift = under!.chips.get(pid)?.length ?? 0;
      }
      if (!p) continue;
      const stack: FeltStack = { x: p.x, z: p.z, chips: [...chips].sort((a, b) => b - a), dim: pid !== me, pid, spot: g.spot };
      if (lift > 0) stack.lift = lift;
      const color = colorFor(pid);
      if (color) stack.color = color;
      out.push(stack);
    }
  }
  return out;
}

/** Where a craps bet's chips go for a player at stand number `standNo`
 *  (or none). The crew sets the number boxes at the player's position (a
 *  spot per stand); the centre boxes are too small for one per stand, so
 *  there each bettor takes the free slot nearest their position, in stand
 *  order. Odds on a travelled come / don't come ride on it. */
export function crapsChipPlan(b: CrapsSpot, standNo: number | null): ChipPlan | null {
  const stand = standNo !== null ? standLocal('craps-table', standNo) : null;
  const side = crapsSideFor(stand?.x ?? 1);
  const spare = (r: FeltRect) => crapsStandSpots(r, side);
  const base = crapsOddsBaseRect(b, side);
  if (base) {
    const flat = { type: b.type === 'comeodds' ? 'come' : 'dontcome', pick: b.pick } as CrapsSpot;
    return { rect: base, spot: stand ? dealerSpot(base, stand, side) : undefined, spare: spare(base), rideOn: spotKey(flat) };
  }
  const rect = crapsChipRect(b, side);
  if (!rect || !crapsDealerPlaced(b)) return rect ? { rect } : null;
  const centre = CRAPS_LAYOUT.regions.some((r) => r.side === 0 && spotKey(r.bet) === spotKey(b));
  if (centre) return stand && standNo !== null ? { rect, near: { anchor: dealerSpot(rect, stand, 0), rank: standNo } } : { rect };
  return { rect, spot: stand ? dealerSpot(rect, stand, side) : undefined, spare: spare(rect) };
}

/** Every craps stand's dealer spot in a number-box area on end `side`. */
function crapsStandSpots(r: FeltRect, side: -1 | 1): FeltPoint[] {
  return (FURNITURE_DEFS['craps-table'].stands ?? [])
    .filter((t) => crapsSideFor(t.stand.x) === side)
    .map((t) => dealerSpot(r, { x: t.stand.x, z: t.stand.z }, side));
}

/** Felt boxes a settled craps roll paid (lit once the dice are down). Place
 *  and hardway bets are off on the come-out, so they light only with a point
 *  on. */
function crapsWinners(d1: number, d2: number, working: boolean): Set<string> {
  const sum = d1 + d2;
  const ids = new Set<string>();
  for (const rg of CRAPS_LAYOUT.regions) {
    const b = rg.bet;
    const hit =
      (b.type === 'place' && working && b.pick === sum)
      || (b.type === 'big6' && sum === 6)
      || (b.type === 'big8' && sum === 8)
      || (b.type === 'hard' && working && b.pick === sum && d1 === d2)
      || (b.type === 'field' && [2, 3, 4, 9, 10, 11, 12].includes(sum))
      || (b.type === 'anyseven' && sum === 7)
      || (b.type === 'anycraps' && (sum === 2 || sum === 3 || sum === 12))
      || (b.type === 'two' && sum === 2)
      || (b.type === 'three' && sum === 3)
      || (b.type === 'yo' && sum === 11)
      || (b.type === 'twelve' && sum === 12);
    if (hit) ids.add(rg.id);
  }
  return ids;
}

function rouletteWinners(result: number): Set<string> {
  const ids = new Set<string>();
  for (const rg of ROULETTE_LAYOUT.regions) {
    if (payoutFor({ ...rg.bet, amount: 1 }, result) > 0) ids.add(rg.id);
  }
  return ids;
}

const NO_HIGHLIGHT: ReadonlySet<string> = new Set();

function driveCraps(id: string, h: CasinoTableVisualHandle, rt: TableRuntime, me: string): void {
  if (isComputedFor(id, 'craps')) {
    driveComputedCraps(id, h, rt, me);
    return;
  }
  if (rt.computed !== null) {
    // Switched back to owner-run: start afresh, as on walking up.
    rt.computed = null;
    rt.primed = false;
    rt.landedRound = 0;
    rt.flight = null;
  }
  const s = readCrapsTableState(id);
  const t = readDiceThrow(id);
  h.setFairBadge(roundIsFair(id, 'craps'));
  if (!rt.primed) {
    // Walking in mid-game (or a room rebind): clear whatever the pieces still
    // show, then show where things stand, animating nothing old.
    rt.primed = true;
    h.reset();
    rt.played = null;
    rt.thrownSeed = t?.seed ?? null;
    if (s?.phase === 'settled' && s.dice) {
      rt.landedRound = s.round;
      h.diceLand(s.dice);
    }
    h.setPuck(s?.point ?? null);
  }
  if (!s) {
    rt.inPlay = false;
    return;
  }
  // A fresh throw for the roll in progress: every client animates it.
  if (t && t.round === s.round && t.seed !== rt.thrownSeed && (s.phase === 'closing' || s.phase === 'settled')) {
    rt.thrownSeed = t.seed;
    localHold.delete(id);
    h.diceThrow({ x: t.sx, z: t.sz }, { x: t.dx, z: t.dz }, t.power, t.seed);
    // The settle can reach this client before the throw (two writers): the
    // roll already landed here, so give the new flight its faces at once.
    if (s.phase === 'settled' && s.dice && rt.landedRound === s.round) h.diceLand(s.dice);
  }
  if (s.phase === 'settled' && s.dice && rt.landedRound !== s.round) {
    rt.landedRound = s.round;
    if (h.diceState() !== 'flying') {
      // Settled with no throw seen (a manual roll from an older client):
      // the stickman's toss, so the dice still travel.
      h.diceThrow(STICKMAN_DICE_SPOT, { x: 0, z: -1 }, 0.5, s.round * 7919);
    }
    h.diceLand(s.dice);
  }
  const animating = h.diceState() === 'flying' || h.diceState() === 'settling';
  const kind: TableKind = 'craps-table';
  if (!animating) {
    h.setPuck(s.point);
    if (s.phase !== 'settled' && !localHold.has(id)) {
      // The stickman keeps the dice through the betting countdown and only
      // pushes them over to the shooter once betting closes (the shooter's
      // throw window); until then nobody has dice in front of them.
      const shooterSeat = s.phase === 'closing' && s.shooter !== undefined ? readSeat(id, s.shooter) : null;
      const stand = shooterSeat ? standLocal(kind, shooterSeat.stand) : null;
      h.diceRestAt(stand ? diceSpotFor(stand, CRAPS_LAYOUT.felt) : STICKMAN_DICE_SPOT);
    }
    if (rt.dirty) {
      rt.dirty = false;
      layCrapsFelt(id, h, rt, me, s, readAllCrapsBets(id), {
        key: `${s.round}:${s.resultAt}`,
        // The settle's record: what it credited each bettor.
        agrees: (pid, r) => (s.payouts?.[pid] ?? 0) === r.credited,
        paidNothing: (pid) => !((s.payouts?.[pid] ?? 0) > 0),
      });
    }
  }
  rt.inPlay = s.phase === 'closing' || animating || h.payingMe();
}

/** 💰 How a craps table's shared record settled a roll, for its chip moves:
 *  a key naming that settle (its moves play once), the point in force before
 *  it when the record says (else the felt's as last laid), and its verdict. */
interface SettleRecord extends SettleVerdict {
  key: string;
  pointBefore?: number | null;
}

/** Where a bettor's chips land on their rail: the chip part of the rail in
 *  front of their stand (railWithTakeDown), or for a bettor with no place at
 *  the table, the rail nearest their chips (`near`). */
function railSpotFor(h: CasinoTableVisualHandle, seats: Record<string, TableSeat>, pid: string, near: FeltPoint): FeltPoint {
  const seat = seats[pid];
  const stand = seat ? standLocal('craps-table', seat.stand) : null;
  if (stand) {
    const r = railWithTakeDown(railFor(stand, h.halfX, h.halfZ), inwardFrom(stand, h.halfZ)).chips;
    return { x: r.x, z: r.z };
  }
  const lim = h.halfX - 0.1;
  return { x: Math.max(-lim, Math.min(lim, near.x)), z: (near.z > 0 ? 1 : -1) * h.halfZ };
}

/**
 * 🎲💰 Lay a craps felt (owner-run or computed: `bets`, every bettor's chips
 * as the table shows them now) and light the boxes the dice paid. The first
 * lay of a roll's result after the felt was laid for that roll before it
 * (the dice are down) plays the settle's chip moves first: losers into the
 * house, then the pay-out (crapsSettleMoves), from the felt as it played to
 * the felt as it stands, so every page shows the same. Once per settle
 * (`rec.key`), and never for one this page didn't see the roll before (it
 * walked up during the show).
 */
function layCrapsFelt(
  id: string, h: CasinoTableVisualHandle, rt: TableRuntime, me: string, s: CrapsTableState,
  bets: Record<string, CrapsBet[]>, rec: SettleRecord,
): void {
  const seats = readSeats(id);
  const stacks = layoutStacks(
    bets,
    seatAnchors('craps-table', seats),
    (b: CrapsBet, pid) => crapsChipPlan(b, seats[pid]?.stand ?? null),
    me,
  );
  const was = rt.played;
  if (s.phase === 'settled' && s.dice && was && !was.settled && was.round === s.round && rt.paidKey !== rec.key) {
    rt.paidKey = rec.key;
    const moves = crapsSettleMoves({
      before: was.bets,
      after: bets,
      stacks: was.stacks,
      dice: s.dice,
      pointBefore: rec.pointBefore !== undefined ? rec.pointBefore : was.point,
      verdict: rec,
      railOf: (pid, near) => railSpotFor(h, seats, pid, near),
      house: CRAPS_HOUSE_SPOT,
      me,
    });
    if (moves.lost.length + moves.back.length + moves.paid.length > 0) h.settleChips(moves);
  }
  h.setFeltChips(stacks);
  h.setHighlight(s.phase === 'settled' && s.dice ? crapsWinners(s.dice[0], s.dice[1], pointWasOn(s)) : NO_HIGHLIGHT);
  rt.played = { round: s.round, settled: s.phase === 'settled', bets, stacks, point: s.point };
}

/** 💰 Is the roll on screen at craps table `tableId` closed with its result
 *  still to show on this page: betting closed for it, its dice still out,
 *  or chips still on their way to this player's rail? The focused table's
 *  rail holds back what the roll pays meanwhile, so it grows as they land. */
export function crapsRollInPlay(tableId: string): boolean {
  return runtimes.get(tableId)?.inPlay ?? false;
}

/** 🎲 A roll's dice, from the d1d2 a roll key carries. */
const diceOfKey = (n: number): [number, number] => [Math.floor(n / 10), n % 10];

/** 🎲 The stickman's toss at a computed table (local, never written): from
 *  his spot, as owner-run's stand-in, its tumble from the roll's close. */
function tossDice(h: CasinoTableVisualHandle, close: string): void {
  h.diceThrow(STICKMAN_DICE_SPOT, { x: 0, z: -1 }, 0.5, parseInt(close.slice(0, 8), 16) % 2 ** 31);
}

/** 🎲 Every felt's chips of a computed craps roll as this page shows them
 *  (its own held-back felt laid over its written one), and the boxes the
 *  dice paid lit once they are down. */
function layComputedCrapsFelt(id: string, h: CasinoTableVisualHandle, rt: TableRuntime, me: string, s: ComputedCrapsState): void {
  const bets = { ...readComputedCrapsBets(id, s.round) };
  const mine = readMyComputedCrapsBets(id, me, s.round).felt;
  if (mine.length > 0) bets[me] = mine;
  else delete bets[me];
  const amounts = s.amounts ?? {};
  const pushes = s.pushes ?? [];
  layCrapsFelt(id, h, rt, me, s, bets, {
    // (A rewrite of the roll, or a new decision of it, settles again.)
    key: `${s.round}:${s.rollKey}:${s.rollBy}`,
    ...(s.pointBefore !== undefined ? { pointBefore: s.pointBefore } : {}),
    // The fold's verdict: what each bettor won or lost on the roll (only
    // bettors with a decision are named).
    agrees: (pid, r) => (Object.prototype.hasOwnProperty.call(amounts, pid) ? amounts[pid] === r.net : !r.decided),
    paidNothing: (pid) => (amounts[pid] ?? 0) < 0 && !pushes.includes(pid),
  });
}

/**
 * 🎲 A computed craps table's frame. One flight a roll on each page: on the
 * shooter's own page its own fling (startComputedFling, at the fling) and
 * nothing else; on every other page the throw record for the roll by the
 * player who held the dice when it came no earlier than the end of the show
 * before the roll's window and no later than the roll's first close (one
 * update brings both alike), else the stickman's toss when the close comes.
 * The dice land on the roll key's faces (a rewrite tosses again, and so
 * does a new decision of the roll on the same faces; the same decision
 * shown again flies nothing) and lie where the flight left them while the
 * roll is on screen; a flight whose roll gets no faces (a void, a roll
 * taken back to betting) is called off, as is a toss whose close is no
 * longer in (forged, or deleted), the dice back where the roll is thrown
 * from; none starts for a roll first seen void. Primed like roulette's:
 * what showed by the first view counted whole and checked showed before
 * this page looked, and doesn't fly.
 */
function driveComputedCraps(id: string, h: CasinoTableVisualHandle, rt: TableRuntime, me: string): void {
  const s = readComputedCraps(id);
  // 🏠 The table's own plaque says what the line under it says (fairnessBadge).
  h.setFairBadge(fairnessBadge(id, 'craps').fair);
  if (!rt.primed || rt.computed !== (s?.inc ?? '')) {
    rt.primed = true;
    rt.computed = s?.inc ?? '';
    rt.counted = false;
    rt.spun = new Map();
    rt.flight = null;
    rt.landed = new Map();
    rt.openShow = null;
    rt.reopened = null;
    rt.played = null;
    rt.dirty = true;
    h.reset();
  }
  if (!s) {
    rt.inPlay = false;
    return;
  }
  seeComputed(id, s.inc, s.rollKey);
  const k = spinKeyParts(s.rollKey);
  // (A roll settled with no faces: void.)
  const faceless = s.phase === 'settled' && !k;
  const now = Date.now();
  if (s.phase !== 'settled') {
    // (Kept once the roll's close is in: a rewrite of the roll before then
    // shows nothing again, and the window the close ended came after the
    // show as it was.)
    if (rt.openShow?.r !== s.round || computedCrapsClose(id, s.round) === null) rt.openShow = { r: s.round, end: s.showEnd };
    // A roll back before its result (taken back to betting, or held for a
    // forfeit's show) has no faces yet: they travel again when they come,
    // unless they come on the decision they landed for (rt.landed).
    rt.spun.delete(s.round);
  }
  // (One the clock has gone back past is another clock's, and goes: the
  // wake that saw the step shows the last roll again, which keeps out the
  // throws from before it.)
  if (rt.reopened && rt.reopened.at > now) rt.reopened = null;
  if (s.rearmAt !== undefined) rt.reopened = { r: s.round, at: s.rearmAt };
  if (!rt.counted) {
    if (casinoWhole(id) && computedSettled(id)) {
      rt.counted = true;
      if (k) {
        rt.spun.set(k.round, k.pocket);
        h.diceLand(diceOfKey(k.pocket));
      }
      if (s.phase !== 'betting' && (k?.round === s.round || computedCrapsClose(id, s.round) !== null)) {
        rt.flight = { r: s.round, at: -Infinity, done: k?.round === s.round, close: true };
      }
    }
  } else {
    // (A roll showing again whose faces already landed here flies nothing,
    // nor does one held again first that comes back on the decision they
    // landed for (a wake shows the last roll again, held for its forfeit's
    // grace): it shows as any roll shown again does. A new decision of it
    // flies, even on the same faces; a rewrite of them tosses again below.)
    const was = k ? rt.landed.get(k.round) : undefined;
    if (s.phase === 'settled' && k?.round === s.round && !rt.spun.has(k.round) && was?.dice === k.pocket && was.by === s.rollBy) {
      rt.spun.set(k.round, k.pocket);
      if (rt.flight?.r !== k.round && h.diceState() === 'rest') {
        // Another roll's dice since, come down: its faces turn where they
        // lie. (Ones still in the air are called off below.)
        h.diceLand(diceOfKey(k.pocket));
        rt.flight = { r: k.round, at: -Infinity, done: true };
      }
    }
    const landed = s.phase === 'settled' && k?.round === s.round && rt.spun.has(s.round);
    // (Nor while one is held again under the close its faces landed here
    // for, as for a forfeit's grace: its dice lie as they came down, and a
    // new decision of it tosses again when it shows, below.)
    const kept = rt.landed.get(s.round);
    const heldAgain = s.phase === 'closing' && kept !== undefined && kept.close === computedCrapsClose(id, s.round)?.hash;
    // (Nor for a roll first seen void: its flight would be called off below
    // in this same frame, the dice left where the throw starts, off the
    // felt, through the void's show.)
    if ((s.phase === 'closing' || s.phase === 'settled') && rt.flight?.r !== s.round && !landed && !heldAgain && !faceless) {
      const close = computedCrapsClose(id, s.round);
      const thr = readDiceThrow(id);
      const by = s.phase === 'settled' ? s.holderBefore : s.holder;
      let fling: DiceThrow | null = null;
      if (thr && thr.round === s.round && by !== undefined) {
        if (by === me) {
          const own = computedFlungFor(id);
          if (own && own.r === s.round && own.seed === thr.seed) fling = thr;
        } else if (thr.by === by) {
          const at = computedThrowSeenAt(id, thr);
          // (Seen by a re-arm's instant, as a throw in the update whose
          // goodbyes took the roll back: before it.)
          const after = rt.reopened?.r === s.round ? rt.reopened.at : -Infinity;
          const from = rt.openShow?.r === s.round ? rt.openShow.end : 0;
          if (at !== undefined && at >= from && at > after && (close === null || at <= close.at)) fling = thr;
        }
      }
      if (fling) {
        h.diceThrow({ x: fling.sx, z: fling.sz }, { x: fling.dx, z: fling.dz }, fling.power, fling.seed);
        rt.flight = { r: s.round, at: now, done: false };
      } else if (close) {
        tossDice(h, close.hash);
        // (The robot stickman says time's up for a wait it saw run out.)
        noteComputedToss(id, s.inc, s.round, true, now);
        rt.flight = { r: s.round, at: now, done: false, close: true };
      }
    }
    if (k && rt.spun.get(k.round) !== k.pocket) {
      const rewrite = rt.spun.has(k.round);
      rt.spun.delete(k.round);
      rt.spun.set(k.round, k.pocket);
      if (rt.spun.size > SHOWN_ROUNDS) rt.spun.delete(rt.spun.keys().next().value as number);
      if (s.round === k.round) {
        // A rewrite tosses again, so the new faces travel; so does a roll
        // whose result came with no flight seen for it.
        if (rewrite || rt.flight?.r !== k.round || rt.flight.done) {
          const close = computedCrapsClose(id, k.round);
          if (close) {
            tossDice(h, close.hash);
            noteComputedToss(id, s.inc, k.round, false, now);
          }
        }
        h.diceLand(diceOfKey(k.pocket));
        rt.flight = { r: k.round, at: rt.flight?.r === k.round ? rt.flight.at : now, done: true };
      } else if (rt.flight?.r === k.round && !rt.flight.done) {
        // Its show went by while its dice flew: they land on its faces.
        h.diceLand(diceOfKey(k.pocket));
        rt.flight = { r: k.round, at: rt.flight.at, done: true };
      } else if (h.diceState() === 'rest') {
        // An earlier roll, its show over: the faces turn where the dice lie.
        // Not on dice in the air or in a hand: they're a later roll's.
        h.diceLand(diceOfKey(k.pocket));
      }
    }
  }
  if (k && rt.spun.get(k.round) === k.pocket) {
    // Which decision the roll's faces came from (a rival one on the same
    // faces moves nothing, and takes its place).
    const was = rt.landed.get(k.round);
    if (was?.dice !== k.pocket || was.by !== s.rollBy) {
      rt.landed.delete(k.round);
      rt.landed.set(k.round, { dice: k.pocket, by: s.rollBy, close: computedCrapsClose(id, k.round)?.hash ?? '' });
      if (rt.landed.size > SHOWN_ROUNDS) rt.landed.delete(rt.landed.keys().next().value as number);
    }
  }
  if (rt.flight && s.phase === 'betting' && rt.flight.r === s.round) {
    // Taken back to betting (a re-arm): no faces for the flight, and the
    // roll flies again once it closes again (from no throw seen by the
    // re-arm, above).
    if (!rt.flight.done) h.diceCancel();
    rt.flight = null;
  } else if (rt.flight && !rt.flight.done && (s.phase === 'betting' || s.round !== rt.flight.r || faceless)) {
    // A flight that will get no faces: the roll void, or no longer the one
    // on screen. A re-show of an earlier roll shows its faces where the
    // dice stop; a void's dice, perhaps still in the air, go back to the
    // stickman (nothing below moves them while the void shows).
    h.diceCancel();
    if (s.phase === 'settled' && k?.round === s.round) {
      h.diceLand(diceOfKey(k.pocket));
      rt.flight = { r: s.round, at: -Infinity, done: true };
    } else {
      rt.flight.done = true;
      if (faceless) h.diceRestAt(STICKMAN_DICE_SPOT);
    }
  } else if (
    rt.flight?.close && !rt.flight.done && s.phase === 'closing' && s.round > (computedDecidedTo(id) ?? 0)
    && computedCrapsClose(id, s.round) === null
  ) {
    // The close it stood for is no longer in: counted while its signature
    // was still to check, then found forged, or deleted. The roll waits for
    // its throw again, so the dice go back where it is thrown from (below),
    // and fly again for the throw or the close that ends it. (Not a roll
    // decided and held for its show, whose close a checkpoint now names
    // alone: its faces come where the dice are.)
    h.diceCancel();
    rt.flight = null;
  }
  const animating = h.diceState() === 'flying' || h.diceState() === 'settling';
  if (!animating) {
    h.setPuck(s.point);
    // (Not while the roll on screen has had its flight here: the dice lie
    // where it left them, through a forfeit's wait for the faces, which
    // turn there when they come, and through a hold of the roll again.)
    if (s.phase !== 'settled' && !localHold.has(id) && rt.flight?.r !== s.round) {
      const seat = s.phase === 'closing' && s.shooter !== undefined ? readSeat(id, s.shooter) : null;
      const stand = seat ? standLocal('craps-table', seat.stand) : null;
      h.diceRestAt(stand ? diceSpotFor(stand, CRAPS_LAYOUT.felt) : STICKMAN_DICE_SPOT);
    }
    if (rt.dirty) {
      rt.dirty = false;
      layComputedCrapsFelt(id, h, rt, me, s);
    }
  }
  rt.inPlay = s.phase === 'closing' || animating || h.payingMe();
}

/** 🎲 The shooter's own fling at a computed craps table, flown at once on
 *  this page (and only there: no other throw plays on it for the roll). */
function startComputedFling(id: string, h: CasinoTableVisualHandle, thr: DiceThrow): void {
  const rt = runtime(id);
  h.diceThrow({ x: thr.sx, z: thr.sz }, { x: thr.dx, z: thr.dz }, thr.power, thr.seed);
  rt.flight = { r: thr.round, at: Date.now(), done: false };
}

/** 🎲 How long ago the flight of roll `round` started on this page (for the
 *  status bar's ROLLING), or Infinity: none, or one that showed before. */
function flightAge(id: string, round: number): number {
  const f = runtimes.get(id)?.flight;
  return f && f.r === round ? Date.now() - f.at : Infinity;
}

function driveRoulette(id: string, h: CasinoTableVisualHandle, rt: TableRuntime, me: string): void {
  if (isComputedFor(id, 'roulette')) {
    driveComputedRoulette(id, h, rt, me);
    return;
  }
  if (rt.computed !== null) {
    // Switched back to owner-run: start afresh, as on walking up (its rounds
    // count from 1 again, on a fresh incarnation: a round 1 spun before the
    // switch is not this one).
    rt.computed = null;
    rt.primed = false;
    rt.spunRound = 0;
  }
  const s = readTableState(id);
  h.setFairBadge(roundIsFair(id, 'roulette'));
  if (!rt.primed) {
    rt.primed = true;
    h.reset();
    if (s?.phase === 'settled' && s.result !== null) rt.spunRound = s.round;
  }
  if (!s) return;
  if (s.phase === 'settled' && s.result !== null && rt.spunRound !== s.round) {
    rt.spunRound = s.round;
    h.wheelSpin(s.result, s.round * 7919 + 13);
  }
  const animating = h.wheelSpinning();
  if (!animating) {
    h.wheelRest(s.phase === 'settled' ? s.result : null);
    if (rt.dirty) {
      rt.dirty = false;
      layRouletteFelt(id, h, me, readAllBets(id, s.round), s.phase === 'settled' ? s.result : null);
    }
  }
}

/** Every bettor's chips on a roulette felt, and the winning boxes lit
 *  (`result`: the settled pocket, null for none). */
function layRouletteFelt(
  id: string, h: CasinoTableVisualHandle, me: string, bets: Record<string, RouletteBet[]>, result: number | null,
): void {
  const seats = readSeats(id);
  const anchors = seatAnchors('roulette-table', seats);
  const regionFor = new Map(ROULETTE_LAYOUT.regions.map((r) => [spotKey(r.bet), r.chipRect]));
  const colors = rouletteChipColors(seats);
  // Roulette players set their own chips, often in the same box, so each
  // plays chips of their stand's own colour rather than a dealer's spot.
  h.setFeltChips(layoutStacks(
    bets,
    anchors,
    (b: RouletteBet) => {
      const rect = regionFor.get(spotKey(b));
      return rect ? { rect } : null;
    },
    me,
    (pid) => colors.get(pid),
  ));
  // Your rail and hand are your colour chips, the colour your bets show.
  h.setOwnChipColor(colors.get(me) ?? null);
  h.setHighlight(result !== null ? rouletteWinners(result) : NO_HIGHLIGHT);
}

/** 🧮 A computed roulette table's frame: the view off the fold (on this
 *  page's clock), the felt as this page shows it (its own held-back felt
 *  laid over its written one), and the wheel spun once per result: when the
 *  spin key names a round this runtime hasn't spun, or one it spun with
 *  another pocket (a rewrite, which ROUND n WAS REWRITTEN tells: back to a
 *  pocket it showed before too). Not for a round whose result is showing
 *  again only because a later one was undone: its pocket is the one spun.
 *  Primed like an owner-run table's, so a page walking up mid-show spins
 *  nothing old: on the first view counted whole and checked (computedSettled),
 *  since one read before the checks are done shows none of what is decided
 *  (they run in slices: casinoDoc), and the result they find would read as
 *  new. */
function driveComputedRoulette(id: string, h: CasinoTableVisualHandle, rt: TableRuntime, me: string): void {
  const s = readComputedRoulette(id);
  // 🏠 The table's own plaque says what the line under it says (fairnessBadge).
  h.setFairBadge(fairnessBadge(id, 'roulette').fair);
  if (!rt.primed || rt.computed !== (s?.inc ?? '')) {
    rt.primed = true;
    rt.computed = s?.inc ?? '';
    rt.counted = false;
    rt.spun = new Map();
    rt.dirty = true;
    h.reset();
  }
  if (!s) return;
  seeComputed(id, s.inc, s.spinKey);
  const k = spinKeyParts(s.spinKey);
  if (!rt.counted) {
    if (casinoWhole(id) && computedSettled(id)) {
      rt.counted = true;
      if (k) rt.spun.set(k.round, k.pocket);
    }
  } else if (k && rt.spun.get(k.round) !== k.pocket) {
    rt.spun.delete(k.round);
    rt.spun.set(k.round, k.pocket);
    if (rt.spun.size > SHOWN_ROUNDS) rt.spun.delete(rt.spun.keys().next().value as number);
    h.wheelSpin(k.pocket, k.round * 7919 + 13);
  }
  const animating = h.wheelSpinning();
  if (!animating) {
    h.wheelRest(s.phase === 'settled' ? s.result : null);
    if (rt.dirty) {
      rt.dirty = false;
      const bets = { ...readComputedBets(id, s.round) };
      const mine = readMyComputedBets(id, me, s.round);
      if (mine.length > 0) bets[me] = mine;
      else delete bets[me];
      layRouletteFelt(id, h, me, bets, s.phase === 'settled' ? s.result : null);
    }
  }
}

/**
 * Drive every craps and roulette table in the room for one frame (all
 * clients). World calls this from its update with its filed handles.
 */
export function casinoTablesFrame(dt: number, visuals: ReadonlyMap<string, CasinoTableVisualHandle>): void {
  if (!unsubscribeDoc) unsubscribeDoc = subscribeCasino(markAllDirty);
  const me = getPlayerId();
  for (const [id, h] of visuals) {
    if (!tableItem(id)) continue;
    const rt = runtime(id);
    if (h.game === 'craps') driveCraps(id, h, rt, me);
    else driveRoulette(id, h, rt, me);
    h.update(dt);
  }
  for (const id of runtimes.keys()) if (!visuals.has(id)) runtimes.delete(id);
}

/** Forget a removed table's runtime (World.removeFurnitureVisuals). */
export function forgetCasinoTable(tableId: string): void {
  runtimes.delete(tableId);
  localHold.delete(tableId);
  computedShown.delete(tableId);
}

// ── The focused table (the local player) ─────────────────────────────────────

export interface CasinoTableUIDeps {
  itemId: string;
  game: 'craps' | 'roulette';
  /** Owner-equivalent predicate: may change the table's settings + roll. */
  isHouse: () => boolean;
  /** Index of the stand the player took (null: the device front). */
  stand: number | null;
  /** The table's 3D pieces (null if the item has none — nothing to drive). */
  visual: CasinoTableVisualHandle | null;
}

type AnyBet = { type: string; pick?: number; amount: number };

const sumOf = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Each table's take-back ledger for this player (the chips they put down
 *  this betting window, by spot), outliving the focused UI. One entry per
 *  table visited; tagged with the room doc and round it belongs to. */
const takeBackLedgers = new Map<string, { epoch: number; round: number; added: Map<string, number[]> }>();

/** 🎲 Where each player stood at a computed craps table when they walked
 *  off it with bets riding (computedTally): their incarnation, the last roll
 *  decided and their net then, in this room doc. Coming back reads what the
 *  table did meanwhile; a reload forgets it. */
const awayMarks = new Map<string, { epoch: number; inc: string; roll: number; net: number }>();

/** 🎲 A win or loss as the status bar writes it: +22, −40, ±0. */
const signedChips = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

/** 🎲 A computed craps roll's call as the stickman makes it: `3 + 4 = 7 —
 *  SEVEN OUT` (games/craps rollCall). */
const callOf = (dice: readonly [number, number], pointBefore: number | null, pointAfter: number | null): string =>
  `${dice[0]} + ${dice[1]} = ${rollCall(dice[0] + dice[1], pointBefore, pointAfter)}`;

/** 🎲 The rules block's last line at a computed craps table. */
const COMPUTED_SHOOTER_RULE = 'The dice go clockwise to players counted at their stand on the last roll: they had a bet down at their stand, '
  + 'with their seed in on time. A shooter keeps them until a seven-out; on a come-out, and on the roll that makes the point, '
  + 'they must be counted at their stand to keep them.';

/** The throw a fling of the held dice makes, from the cursor samples taken
 *  while they were held (felt metres, page-clock ms), or null when the flick
 *  was too slow and the dice are just dropped. Any direction counts: a shooter
 *  facing the table often flicks sideways, and the dice bounce off the rails
 *  wherever they're sent. */
export function readFling(
  samples: ReadonlyArray<{ t: number; p: FeltPoint }>,
  now: number,
): { from: FeltPoint; dir: FeltPoint; power: number } | null {
  if (samples.length === 0) return null;
  const b = samples[samples.length - 1];
  const a = samples.find((x) => now - x.t <= FLING_WINDOW_MS) ?? b;
  const dt = Math.max(1, b.t - a.t) / 1000;
  const vx = (b.p.x - a.p.x) / dt;
  const vz = (b.p.z - a.p.z) / dt;
  const speed = Math.hypot(vx, vz);
  if (speed < FLING_MIN_SPEED) return null;
  return {
    from: b.p,
    dir: { x: vx / speed, z: vz / speed },
    power: Math.min(1, (speed - FLING_MIN_SPEED) / (FLING_FULL_SPEED - FLING_MIN_SPEED)),
  };
}

/** "Forward" for a player at `stand` (table-local): away from their own
 *  rail, toward the far side. */
function inwardFrom(stand: FeltPoint, halfZ: number): FeltPoint {
  const endRail = Math.abs(stand.z) > halfZ;
  return { x: -Math.sign(endRail ? 0 : stand.x), z: -Math.sign(endRail ? stand.z : 0) };
}

/**
 * The focused craps / roulette table: no panel, the table is the game. Mounts
 * a capture layer over the 3D view, a status bar and (on ⚙️) the settings
 * card; registers the player's seat; drives the rail and the hand.
 */
export function createCasinoTableUI(deps: CasinoTableUIDeps): DeviceUI {
  const { itemId, game } = deps;
  const kind: TableKind = game === 'craps' ? 'craps-table' : 'roulette-table';
  type Spot = { type: string; pick?: number };
  const layout: FeltLayout<Spot> = game === 'craps' ? CRAPS_LAYOUT : ROULETTE_LAYOUT;
  const me = getPlayerId();
  const h = deps.visual;
  const stand = deps.stand !== null ? standLocal(kind, deps.stand) : null;
  const rail = h && stand ? railFor(stand, h.halfX, h.halfZ) : null;
  /** ↶ Your rail's chips, and the take-down button at its right-hand end. */
  const railSplit = h && stand && rail ? railWithTakeDown(rail, inwardFrom(stand, h.halfZ)) : null;
  const toward = h && stand ? (() => { const f = inwardFrom(stand, h.halfZ); return { x: -f.x, z: -f.z }; })() : null;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let bar: HTMLDivElement | null = null;
  let capture: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let seatTimer: number | null = null;
  /** The manual SPIN's settle poll: one per focused table. */
  let spinPoll: number | null = null;
  const stopSpinPoll = (): void => {
    if (spinPoll !== null) window.clearInterval(spinPoll);
    spinPoll = null;
  };

  /** Chips in hand (denominations). Held on the felt by my list once they
   *  land; nothing is taken. */
  let hand: number[] = [];
  /** The rail as laid out right now (frozen while a pickup drag runs). */
  let railView: RailStack[] = [];
  /** 💰 Craps: while the roll on screen is in play (crapsRollInPlay), the
   *  most the rail shows: what I had when it closed. What the roll pays
   *  joins the rail as its chips land there, not when the settle comes. */
  let railCap: number | null = null;
  let pickup: { stack: number; nextAt: number; interval: number } | null = null;
  let cursor: FeltPoint | null = null;
  /** Dice in the shooter's hand: recent cursor samples for the fling. */
  let held: Array<{ t: number; p: FeltPoint }> | null = null;
  let flash = '';
  let flashUntil = 0;
  /** What the screen-reader live region says (notices and keyboard play). */
  let liveText = '';
  let liveTick = false;
  /** Keyboard play's selected box (an index into layout.regions), -1: none. */
  let focusIdx = -1;
  /** Chips I put down this betting window, by spot (what a click on a box
   *  takes back, beside the bets that may come down any time — canTakeDown). */
  let added = new Map<string, number[]>();
  let windowRound = -1;
  // Kept across focus: stepping away and back mid-round keeps what you may
  // take back (this room doc, this table, this round only).
  const ledgerKey = `${itemId}|${me}`;
  const saveLedger = (): void => {
    takeBackLedgers.set(ledgerKey, { epoch: casinoDocEpoch(), round: windowRound, added });
  };
  {
    const saved = takeBackLedgers.get(ledgerKey);
    if (saved && saved.epoch === casinoDocEpoch()) {
      added = saved.added;
      windowRound = saved.round;
    }
  }
  /** Fingerprint of a settled result (epoch, round, outcome, transcript and
   *  commitments) → its check's verdict line: the card re-hashes only when
   *  something it checked changes, never shows a stale verdict if it does. */
  const verdicts = new Map<string, { text: string; color: string }>();
  /** `epoch:round` checks in flight, so re-renders don't start them again. */
  const verifying = new Set<string>();
  /** 🔀 The card asks the house to confirm a switch-on. */
  let confirming = false;
  /** 🧮 The computed incarnation this table was last seen on here (null:
   *  owner-run), whether my felt held chips on it then, and the rewrites of
   *  its results told (ComputedShown.rewrites; −1: none counted yet). 🎲 At
   *  craps also: whether my owner-run felt had chips on the last run (the
   *  switch-on hands them back), and the earlier rolls' changes and the
   *  undone changes told (computedRollChange, computedUndoneCount). */
  let watchedInc: string | null = null;
  let watchedStake = false;
  let rewritesTold = -1;
  let ownerStake = false;
  let changesTold = 0;
  let undoneTold = 0;
  /** 🎲 The last roll the computed view offered me the fling for, on its
   *  incarnation (TIME'S UP when it went by unthrown), and a switch-off whose
   *  first press warned of contract bets riding (the next hands them back). */
  let offered: { inc: string; r: number } | null = null;
  let offArmed = false;
  /** 🏠 The house as the open card last drew it: a heartbeat isn't a casino
   *  change, and going quiet is no change at all, so the frame redraws the
   *  card when it differs. */
  let houseDrawn = '';
  /** Tell the player what the table did that no status line says: a round
   *  it showed rewritten, and a switch-off handing their felt back. On a
   *  whole doc only (one holding part of an update can read the switch as
   *  gone). Nor while the incarnation watched goes on, its switch lost (a
   *  peer took it away, and the room's pages put it back on their next
   *  frame: computedTable putSwitchBack): the felt is back in play then. */
  const noteComputed = (): void => {
    if (!casinoWhole(itemId)) return;
    if (game === 'craps') {
      noteComputedCraps();
      return;
    }
    const s = computed() ? readComputedRoulette(itemId) : null;
    if (s) {
      const seen = seeComputed(itemId, s.inc, s.spinKey);
      if (watchedInc !== s.inc) rewritesTold = seen.rewrites;
      else if (seen.rewrites > rewritesTold) {
        rewritesTold = seen.rewrites;
        say(`ROUND ${seen.rewrittenRound} WAS REWRITTEN`);
      }
      watchedInc = s.inc;
      watchedStake = readMyComputedBets(itemId, me, s.round).length > 0;
      return;
    }
    if (watchedInc !== null && !computedIncEnded(itemId, watchedInc)) return;
    if (watchedInc !== null && watchedStake) say('TABLE SWITCHED — YOUR BETS ARE BACK');
    watchedInc = null;
    watchedStake = false;
    rewritesTold = -1;
  };
  /** 🎲 noteComputed at craps: a roll on screen rewritten, an earlier one
   *  changed, a held change dropped because the roll before changed, and the
   *  table switched either way with my bets on it. The switch-on hands back
   *  every felt (switchComputedOn), so the notice goes to a player whose
   *  owner-run felt had chips on the run before the computed table first
   *  showed here; a page mounted on a computed table says nothing of it. */
  const noteComputedCraps = (): void => {
    if (computed()) {
      const s = readComputedCraps(itemId);
      // (Nothing counted of it yet: what the switch did shows once it is.)
      if (!s) return;
      const seen = seeComputed(itemId, s.inc, s.rollKey);
      const change = computedRollChange(itemId);
      const undone = computedUndoneCount(itemId);
      if (watchedInc !== s.inc) {
        offered = null;
        rewritesTold = seen.rewrites;
        changesTold = change.seq;
        undoneTold = undone;
        if (watchedInc === null && ownerStake) say('TABLE SWITCHED — YOUR BETS ARE BACK');
      } else {
        if (seen.rewrites > rewritesTold) {
          rewritesTold = seen.rewrites;
          say(`ROLL ${seen.rewrittenRound} WAS REWRITTEN — NEW DICE`);
        }
        if (change.seq > changesTold) {
          changesTold = change.seq;
          const u = change.undid;
          say(u
            ? `ROLL ${change.round} CHANGED — YOUR BETS ON ${u[0] === u[1] ? `ROLL ${u[0]}` : `ROLLS ${u[0]}–${u[1]}`} CAME BACK`
            : `ROLL ${change.round} CHANGED — THE ROLLS AFTER IT PAID AGAIN ON THE SAME DICE`);
        }
        if (undone > undoneTold) {
          undoneTold = undone;
          say(CHANGES_UNDONE);
        }
      }
      watchedInc = s.inc;
      watchedStake = readMyComputedCrapsBets(itemId, me, s.round).felt.length > 0;
      ownerStake = false;
      return;
    }
    if (watchedInc !== null && !computedIncEnded(itemId, watchedInc)) return;
    if (watchedInc !== null && watchedStake) say('TABLE SWITCHED — YOUR BETS ARE BACK');
    watchedInc = null;
    watchedStake = false;
    rewritesTold = -1;
    ownerStake = readMyCrapsBets(itemId, me).length > 0;
  };
  /** 🎲 Walking off a computed craps table with bets riding: say which
   *  (they play on the rolls the table's other players play), and mark where
   *  the table stood, so coming back can say what it did meanwhile. */
  const noteLeaving = (): void => {
    const tally = computed() ? computedTally(itemId) : null;
    const felt = tally ? myCrapsFelt().felt : [];
    if (!tally || felt.length === 0) return;
    const named = felt.slice(0, LEAVE_LIST_MAX).map((b) => `${crapsBetLabel(b)} ${b.amount}`);
    const more = felt.length > LEAVE_LIST_MAX ? ` · AND ${felt.length - LEAVE_LIST_MAX} MORE` : '';
    showHint(`YOUR BETS RIDE WHILE YOU'RE AWAY — ${named.join(' · ')}${more}`, LEAVE_HINT_MS);
    awayMarks.set(ledgerKey, { epoch: casinoDocEpoch(), inc: tally.inc, roll: tally.roll, net: tally.net });
  };
  /** 🎲 Back at the table walked off: the rolls decided meanwhile (a void
   *  counts) and what they won or lost, on the same incarnation and room doc
   *  only. */
  const noteBack = (): void => {
    const mark = awayMarks.get(ledgerKey);
    if (!mark) return;
    awayMarks.delete(ledgerKey);
    const tally = computed() ? computedTally(itemId) : null;
    if (!tally || mark.epoch !== casinoDocEpoch() || mark.inc !== tally.inc || tally.roll <= mark.roll) return;
    const n = tally.roll - mark.roll;
    say(`WHILE YOU WERE AWAY — ${n} ROLL${n === 1 ? '' : 'S'} · ${signedChips(tally.net - mark.net)}`);
  };
  /** The room doc this focus began in: rounds and bets from another room's
   *  table with the same id must not count as this window's. */
  let mountEpoch = casinoDocEpoch();
  const syncEpoch = (): void => {
    if (mountEpoch === casinoDocEpoch()) return;
    mountEpoch = casinoDocEpoch();
    windowRound = -1;
    added = new Map();
    saveLedger();
    verdicts.clear();
    hand = [];
    pickup = null;
    held = null;
    localHold.delete(itemId);
  };

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** 🧮 Is this a computed table now, under a name for its game (asked
   *  live: the house may switch it while the player stands here)? */
  const computed = (): boolean => isComputedFor(itemId, game);
  /** 🎲 The computed craps table's view (null: owner-run, or nothing of it
   *  counted yet). */
  const computedCraps = (): ComputedCrapsState | null => (game === 'craps' && computed() ? readComputedCraps(itemId) : null);
  const crapsState = (): CrapsTableState | null => (game === 'craps' && computed() ? readComputedCraps(itemId) : readCrapsTableState(itemId));
  const rouletteState = (): RouletteTableState | null => (computed() ? readComputedRoulette(itemId) : readTableState(itemId));
  const round = (): number => (game === 'craps' ? crapsState()?.round : rouletteState()?.round) ?? 1;
  const phase = (): 'betting' | 'closing' | 'settled' =>
    (game === 'craps' ? crapsState()?.phase : rouletteState()?.phase) ?? 'betting';
  const deadline = (): number | undefined =>
    game === 'craps' ? crapsState()?.phaseDeadline : rouletteState()?.phaseDeadline;
  /** 🎲 My felt at a computed craps table (one amount a spot), and the stamp
   *  a change of it is built on: an action reads both once and hands the
   *  stamp to its write, so a change built before the roll before changed
   *  never goes over the new felt. */
  const myCrapsFelt = (): { felt: CrapsBet[]; basis: string } => readMyComputedCrapsBets(itemId, me, round());
  // (A computed felt this page holds back to write shows as mine at once.)
  const myBets = (): AnyBet[] => (game === 'craps'
    ? computed() ? myCrapsFelt().felt : readMyCrapsBets(itemId, me)
    : computed() ? readMyComputedBets(itemId, me, round()) : readMyBets(itemId, me, round()));
  /** 🧮 Put my felt down on a computed table as a slip (at craps built on
   *  `basis`); false (and the bettor told why) when it didn't go down. */
  const writeSlip = (bets: AnyBet[], basis: string): boolean => {
    let wrote: ComputedSlipWrite;
    try {
      wrote = game === 'craps'
        ? writeComputedCrapsSlip(itemId, bets as CrapsBet[], basis)
        : writeComputedSlip(itemId, bets as RouletteBet[]);
    } catch {
      // (A felt a slip can't carry: never one this table built. Nothing goes.)
      wrote = 'reconnecting';
    }
    if (wrote === 'ok') {
      markDirty(itemId);
      return true;
    }
    say(wrote === 'closed' ? 'NO MORE BETS'
      : wrote === 'full' ? 'THE TABLE IS FULL — WAIT FOR A PLACE'
        : wrote === 'chips' ? 'NOT ENOUGH CHIPS — VISIT THE CASHIER'
          : wrote === 'rules' ? "THE TABLE RULES DON'T ALLOW THAT BET NOW"
            : wrote === 'changed' ? CHANGES_UNDONE
              : RECONNECTING_NOTICE);
    return false;
  };
  /** Write my list (at a computed craps table, built on `basis`); false (and
   *  the bettor told why) when it didn't go down: the table full, or the doc
   *  holding part of an update (casinoWhole). */
  const writeBets = (bets: AnyBet[], basis = ''): boolean => {
    if (computed()) return writeSlip(bets, basis);
    const wrote = game === 'craps'
      ? writeMyCrapsBets(itemId, me, bets as CrapsBet[])
      : writeMyBets(itemId, me, round(), bets as RouletteBet[]);
    if (!wrote) say(casinoWhole(itemId) ? 'THE TABLE IS FULL — WAIT FOR A PLACE' : RECONNECTING_NOTICE);
    return wrote;
  };
  const animating = (): boolean => {
    if (!h) return false;
    return game === 'craps' ? h.diceState() === 'flying' || h.diceState() === 'settling' : h.wheelSpinning();
  };
  /** Betting is closed once the phase leaves 'betting' OR the auto-croupier's
   *  deadline has passed (no chip lands after "no more bets"). */
  const bettingOpen = (): boolean => {
    if (phase() !== 'betting' || animating()) return false;
    const d = deadline();
    return d == null || Date.now() < d;
  };
  const myThrowPending = (): boolean => {
    if (game !== 'craps') return false;
    const s = crapsState();
    if (!s || s.phase !== 'closing' || s.shooter !== me) return false;
    if (computed()) {
      // 🎲 From this page's own fling only: the throw record is anyone's
      // to write, and neither blocks my fling nor stands for it.
      const pending = computedFlungFor(itemId)?.r !== s.round;
      if (pending) offered = { inc: (s as ComputedCrapsState).inc, r: s.round };
      return pending;
    }
    const t = readDiceThrow(itemId);
    return !(t && t.round === s.round);
  };

  const syncWindow = (): void => {
    syncEpoch();
    // (Not on a doc holding part of an update, where the table may read as
    // gone and its round as 1: this window's chips would be forgotten.)
    if (!casinoWhole(itemId)) return;
    const r = round();
    if (r !== windowRound) {
      windowRound = r;
      added = new Map();
    }
    saveLedger();
  };

  /** Tell a screen reader, without the on-screen notice. A trailing
   *  zero-width space alternates so the same words are read again. */
  const announce = (text: string): void => {
    liveTick = !liveTick;
    liveText = text + (liveTick ? '\u200b' : '');
    renderBar();
  };

  const say = (text: string): void => {
    flash = text;
    flashUntil = performance.now() + 2600;
    announce(text);
  };

  // ── Rail + hand ───────────────────────────────────────────────────────────

  const refreshRail = (): void => {
    if (!h) return;
    const balance = readChips(me);
    if (hand.length > 0 && sumOf(hand) > balance) {
      // Can't cover the same stake again: drop the hand rather than quietly
      // betting a different amount on the next click.
      hand = [];
      say('NOT ENOUGH CHIPS FOR THAT STAKE AGAIN — PICK UP FROM YOUR RAIL');
    }
    const shown = railCap !== null ? Math.min(balance, railCap) : balance;
    if (!pickup) railView = railSplit ? railStacks(railSplit.chips, railChipCounts(Math.max(0, shown - sumOf(hand)))) : [];
    h.setRailStacks(railView);
    h.setHand(cursor, hand);
    syncTakeDown(true);
  };

  /** Lit while I have bets that may come down right now, dimmed otherwise
   *  (betting closes on a clock, so update() checks it too). */
  let takeDownShown = '';
  const syncTakeDown = (force = false): void => {
    if (!h) return;
    const ready = !!railSplit && bettingOpen() && splitTakeDown(game, myBets(), crapsState()?.point ?? null).back.length > 0;
    const key = railSplit ? (ready ? 'ready' : 'dim') : 'none';
    if (!force && key === takeDownShown) return;
    takeDownShown = key;
    h.setTakeDown(railSplit && toward ? { p: railSplit.button, toward } : null, ready);
  };

  const stackAt = (p: FeltPoint): number => {
    let best = -1;
    let bd = Infinity;
    railView.forEach((s, i) => {
      const along = rail?.axis === 'x' ? Math.abs(p.x - s.x) : Math.abs(p.z - s.z);
      const across = rail?.axis === 'x' ? Math.abs(p.z - s.z) : Math.abs(p.x - s.x);
      if (along <= RAIL_PITCH * 0.6 && across < 0.08 && along < bd) {
        bd = along;
        best = i;
      }
    });
    return best;
  };

  const takeFromStack = (i: number): void => {
    const s = railView[i];
    if (!s || s.count <= 0 || hand.length >= HAND_MAX) return;
    s.count -= 1;
    hand.push(s.denom);
    refreshRail();
  };

  // ── Betting ───────────────────────────────────────────────────────────────

  const labelOf = (b: { type: string; pick?: number }): string =>
    game === 'craps'
      ? crapsBetLabel({ ...(b as CrapsBet), amount: 1 })
      : betLabel({ ...(b as RouletteBet), amount: 1 });

  const placeHand = (rg: FeltRegion<Spot>): void => {
    syncWindow();
    // 📒 Not on a doc holding part of an update (casinoWhole): the table may
    // read as gone there, or a list as empty, and no bet goes down anyway.
    if (!casinoWhole(itemId)) {
      say(RECONNECTING_NOTICE);
      return;
    }
    // 🪙 Bets hold their chips on a table that is up (casinoDoc STAKES ON THE
    // FELT): until the house (or its robot) opens this one, nothing goes down.
    // (A computed table is always open: nobody opens its rounds.)
    const comp = computed();
    if (!comp && !(game === 'craps' ? crapsState() : rouletteState())) {
      say(deps.isHouse()
        ? `PRESS ${game === 'craps' ? 'ROLL' : 'SPIN'} ON ⚙ TO OPEN THE TABLE`
        : "THE TABLE ISN'T OPEN YET — WAIT FOR THE HOUSE");
      return;
    }
    if (!bettingOpen()) {
      say(phase() === 'settled' ? 'WAIT FOR THE NEXT ROUND' : 'NO MORE BETS');
      return;
    }
    // 🎲 At a computed craps table my felt and the stamp it is built on, read
    // once for this action: the riding bets odds go up behind are in it.
    const crapsFelt = game === 'craps' && comp ? myCrapsFelt() : null;
    if (game === 'craps') {
      const s = crapsState();
      const type = rg.bet.type as CrapsBet['type'];
      if (isOddsType(type)) {
        // 🎲 Odds ride on a flat bet, up to the table's multiple of it.
        const o = oddsRoom(crapsFelt?.felt ?? readMyCrapsBets(itemId, me), type, rg.bet.pick, s?.point ?? null);
        if (o.reason) {
          say(o.reason);
          return;
        }
        if (sumOf(hand) > o.room) {
          say(`ODDS MAX — ${o.room} MORE FITS HERE`);
          return;
        }
      } else if (!canPlaceBet(type, s?.point ?? null)) {
        say(type === 'come' || type === 'dontcome'
          ? 'THE COME BOX OPENS ONCE A POINT IS ON'
          : 'THE LINE IS CLOSED WHILE A POINT IS ON');
        return;
      }
    }
    const chips = [...hand];
    // The felt draws at most MAX_STACK_CHIPS of yours per box and
    // MAX_BETS_DRAWN_PER_PLAYER chips in all: say so at the table rather than
    // take a chip nobody would see. (🎲 A computed craps felt holds one
    // amount a spot: its chips are counted as the felt draws them, the
    // spot's amount and the hand's together.)
    const mine = crapsFelt?.felt ?? myBets();
    const key0 = spotKey(rg.bet);
    const spotNow = sumOf(mine.filter((b) => spotKey(b) === key0).map((b) => b.amount));
    const inBox = crapsFelt ? drawnChips(spotNow + sumOf(chips)) : mine.filter((b) => spotKey(b) === key0).length + chips.length;
    if (inBox > MAX_STACK_CHIPS) {
      say(`THAT BOX IS FULL — ${MAX_STACK_CHIPS} CHIPS A BOX`);
      return;
    }
    const drawn = crapsFelt
      ? sumOf(mine.filter((b) => spotKey(b) !== key0).map((b) => drawnChips(b.amount))) + inBox
      : mine.length + chips.length;
    if (drawn > MAX_BETS_DRAWN_PER_PLAYER) {
      say(`YOU HAVE ${MAX_BETS_DRAWN_PER_PLAYER} CHIPS DOWN — THE TABLE LIMIT`);
      return;
    }
    // ⚖️ A round carries at most MAX_TABLE_BETTORS bettors (a Fair round's
    // transcript, and the close's freeze of who is in it): a newcomer past
    // that would be left out of the settle, so they wait. (🎲 At a computed
    // craps table the felt counts every rider, gone ones too.)
    if (mine.length === 0) {
      const all = game === 'craps'
        ? comp ? readComputedCrapsBets(itemId, round()) : readAllCrapsBets(itemId)
        : comp ? readComputedBets(itemId, round()) : readAllBets(itemId, round());
      if (Object.keys(all).filter((pid) => pid !== me).length >= MAX_TABLE_BETTORS) {
        say('THE TABLE IS FULL — WAIT FOR A PLACE');
        return;
      }
    }
    // 🪙 The chips stay yours, held on the felt by the list, until the round
    // settles (casinoDoc STAKES ON THE FELT): nothing is taken here.
    if (readChips(me) < sumOf(chips)) {
      say('NOT ENOUGH CHIPS — VISIT THE CASHIER');
      refreshRail();
      return;
    }
    const placed = chips.map((amount) => ({ ...rg.bet, amount }));
    if (!writeBets([...mine, ...placed], crapsFelt?.basis)) return;
    const warnKey = `${casinoDocEpoch()}:${itemId}${comp ? ':computed' : ''}`;
    // Commit this bet's seed now, not on the next tick: a quick close must
    // still find it. (A computed slip carries its own commitment.)
    if (!comp) tickFairSeeds(itemId, game, me, Date.now(), true);
    if (!fairnessBadge(itemId, game).fair && !friendlyWarned.has(warnKey)) {
      friendlyWarned.add(warnKey);
      say(comp
        ? '🤝 FRIENDLY TABLE — SEEDS COME FROM THE PLAYERS ONLY · A MODIFIED GAME CAN STEER OR REWRITE A ROUND'
        : "🤝 FRIENDLY TABLE — THE OWNER COULD STEER RESULTS · BET WITH PEOPLE YOU TRUST");
    }
    const key = spotKey(rg.bet);
    added.set(key, [...(added.get(key) ?? []), ...chips]);
    // The hand stays loaded: the next box you click takes the same chips.
    refreshRail();
  };

  /** Pick my chips put down this window back off a box (back to my rail: the
   *  list stops holding them; into the hand when it is empty). */
  const takeBack = (rg: FeltRegion<Spot>): boolean => {
    syncWindow();
    if (!casinoWhole(itemId)) { // (as placeHand)
      say(RECONNECTING_NOTICE);
      return true;
    }
    const key = spotKey(rg.bet);
    // Odds, place, big 6 / 8 and hardways may come down any time the betting
    // is open, not only this window's chips (the flat bet under odds stays).
    // The don't side may too, but only with ↶, which takes its odds with it.
    const anyTime = game === 'craps' && canTakeDown(rg.bet as CrapsBet, crapsState()?.point ?? null)
      && rg.bet.type !== 'dontpass' && rg.bet.type !== 'dontcome';
    if (game === 'craps' && computed()) return takeBackSpot(key, anyTime);
    const mine = anyTime
      ? myBets().filter((b) => spotKey(b) === key).map((b) => b.amount)
      : added.get(key) ?? [];
    if (mine.length === 0) return false;
    if (!bettingOpen()) {
      say('NO MORE BETS — THOSE CHIPS STAY');
      return true;
    }
    const bets = myBets();
    let left = mine.length;
    const back: number[] = [];
    // This window's chips are the newest records: take from the end.
    const keep: AnyBet[] = [];
    for (let i = bets.length - 1; i >= 0; i--) {
      if (left > 0 && spotKey(bets[i]) === key) {
        back.push(bets[i].amount);
        left -= 1;
      } else {
        keep.unshift(bets[i]);
      }
    }
    if (back.length === 0) return false;
    // Off the list, the chips are no longer held: they're back on your rail.
    if (!writeBets(keep)) return true;
    added.delete(key);
    // An empty hand picks them up; a loaded hand is already the stake you're
    // betting with, so they just go back to the rail.
    if (hand.length === 0) hand = back.slice(0, HAND_MAX);
    refreshRail();
    return true;
  };

  /** 🎲 takeBack at a computed craps table, by amount (the felt holds one a
   *  spot): the whole spot when it may come down any time, else what I put
   *  there this window, the rest left on it. An empty hand picks the chips
   *  up as the felt draws them. */
  const takeBackSpot = (key: string, anyTime: boolean): boolean => {
    const { felt, basis } = myCrapsFelt();
    const at = sumOf(felt.filter((b) => spotKey(b) === key).map((b) => b.amount));
    const back = anyTime ? at : Math.min(at, sumOf(added.get(key) ?? []));
    if (back <= 0) return false;
    if (!bettingOpen()) {
      say('NO MORE BETS — THOSE CHIPS STAY');
      return true;
    }
    const keep = felt.flatMap((b) => (spotKey(b) !== key ? [b] : b.amount > back ? [{ ...b, amount: b.amount - back }] : []));
    if (!writeBets(keep, basis)) return true;
    added.delete(key);
    if (hand.length === 0) hand = chipsUpTo(back, HAND_MAX);
    refreshRail();
    return true;
  };

  /** ↶ "Take me down": every bet of mine that may come off goes back to the
   *  rail at once (contract bets stay — see splitTakeDown). */
  const takeDownAll = (): void => {
    syncWindow();
    h?.pressTakeDown();
    if (!casinoWhole(itemId)) { // (as placeHand)
      say(RECONNECTING_NOTICE);
      return;
    }
    const crapsFelt = game === 'craps' && computed() ? myCrapsFelt() : null;
    const bets = crapsFelt?.felt ?? myBets();
    if (bets.length === 0) {
      say('NO BETS OF YOURS ON THE TABLE');
      return;
    }
    if (!bettingOpen()) {
      say('NO MORE BETS — THOSE CHIPS STAY');
      return;
    }
    const { back, keep } = splitTakeDown(game, bets, crapsState()?.point ?? null);
    if (back.length === 0) {
      say('LINE AND COME BETS WITH A POINT STAY UP UNTIL THEY WIN OR LOSE');
      return;
    }
    // The list stops holding them: back on your rail. The chips slide back
    // across the felt as they come off.
    if (!writeBets(keep, crapsFelt?.basis)) return;
    if (railSplit) h?.sweepToRail({ x: railSplit.chips.x, z: railSplit.chips.z });
    const total = sumOf(back.map((b) => b.amount));
    for (const b of back) added.delete(spotKey(b));
    saveLedger();
    say(keep.length > 0
      ? `TAKEN DOWN — ${total} BACK TO YOUR RAIL · YOUR LINE BETS STAY UP`
      : `TAKEN DOWN — ${total} BACK TO YOUR RAIL`);
    refreshRail();
  };

  // ── The shooter ───────────────────────────────────────────────────────────

  const throwDice = (): void => {
    if (!held || !h) return;
    const s = crapsState();
    const samples = held;
    held = null;
    localHold.delete(itemId);
    const fling = readFling(samples, performance.now());
    if (!s || !myThrowPending() || !fling) {
      say('FLICK THE DICE HARDER TO THROW THEM');
      return; // the frame driver slides them back to your spot
    }
    sendThrow({
      round: s.round,
      by: me,
      sx: fling.from.x,
      sz: fling.from.z,
      dx: fling.dir.x,
      dz: fling.dir.z,
      power: fling.power,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
  };

  /** The throw goes out for every page to animate. 🎲 At a computed table
   *  this page notes its own fling too (it closes the roll at it, and offers
   *  no fling again for it) and flies it at once: no throw record plays here.
   *  The offer it took is gone (no TIME'S UP for it, even once a wake has
   *  forgotten the fling); one made again comes as any does. */
  const sendThrow = (thr: DiceThrow): void => {
    writeDiceThrow(itemId, thr);
    if (!computed()) return;
    offered = null;
    noteComputedFling(itemId, thr.round, thr.seed);
    if (h) startComputedFling(itemId, h, thr);
  };

  // ── Pointer ───────────────────────────────────────────────────────────────

  const aim = (e: PointerEvent): boolean => {
    const cam = deviceFocus.getCamera();
    if (!cam) return false;
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    return true;
  };

  /** The dice in my hand once they're no longer mine to throw (the shooter's
   *  time ran out and the stickman threw): let go, and put the settled faces
   *  back where the landing left them. */
  const dropStaleHold = (): void => {
    if (!held || myThrowPending()) return;
    held = null;
    localHold.delete(itemId);
    const s = crapsState();
    if (h && s?.phase === 'settled' && s.dice) h.diceLand(s.dice);
  };

  /** A click on an odds band with no bet there to back is meant for the box
   *  around it, as it was before the odds bands: the number box's place bet,
   *  or (come-out) the line. Keyboard play keeps the band, and hears why. */
  const pointerTarget = (rg: FeltRegion<Spot>): FeltRegion<Spot> => {
    if (game !== 'craps' || !isOddsType(rg.bet.type)) return rg;
    const point = crapsState()?.point ?? null;
    const t = rg.bet.type;
    if (oddsFlat(myBets() as CrapsBet[], t, rg.bet.pick) > 0 && !(point === null && (t === 'passodds' || t === 'dontpassodds'))) return rg;
    const tag = rg.side > 0 ? '+' : '-';
    const to = t === 'comeodds' || t === 'dontcomeodds'
      ? `place:${rg.bet.pick}@${tag}`
      : point === null ? `${t === 'passodds' ? 'pass' : 'dontpass'}@${tag}` : null;
    return (to && layout.regions.find((r) => r.id === to)) || rg;
  };

  const onMove = (e: PointerEvent): void => {
    if (pinching() || !h || !aim(e)) return;
    dropStaleHold();
    cursor = h.projectToFelt(ray);
    const hit = h.pick(ray, myThrowPending());
    h.setSettingsHot(hit?.kind === 'settings');
    h.setTakeDownHot(hit?.kind === 'takedown');
    if (capture) capture.style.cursor = hit && hit.kind !== 'felt' ? 'pointer' : hit && hitRegion(layout, hit.p) ? 'pointer' : 'default';
    if (held && cursor) {
      held.push({ t: performance.now(), p: cursor });
      if (held.length > 40) held.shift();
      h.diceHold(cursor);
    }
    if (pickup) {
      const i = hit?.kind === 'rail' ? stackAt(hit.p) : -1;
      // Off the rail (or between stacks) the pickup pauses; over a new stack
      // it takes from that one.
      if (i < 0) pickup.stack = -1;
      else if (i !== pickup.stack) {
        pickup.stack = i;
        pickup.interval = PICKUP_REPEAT_MS;
        pickup.nextAt = performance.now() + pickup.interval;
        takeFromStack(i);
      }
    }
    // Only a held hand follows the cursor; an empty one is already cleared,
    // and setHand would rebuild every chip instance on each move.
    if (hand.length > 0) h.setHand(cursor, hand);
  };

  /** 🔍 Fingers down on the felt. A second one makes the touch a pinch that
   *  zooms the view (firstPersonZoom.ts), never a bet, a pickup or a throw. */
  const touches = new Set<number>();
  const pinching = (): boolean => touches.size >= 2;

  const onDown = (e: PointerEvent): void => {
    e.stopPropagation();
    if (e.pointerType === 'touch') {
      touches.add(e.pointerId);
      if (pinching()) {
        dropGesture();
        return;
      }
    }
    if (!h || !aim(e)) return;
    if (e.button === 2) {
      if (hand.length) {
        hand = [];
        refreshRail();
      }
      return;
    }
    if (e.button !== 0) return;
    const hit = h.pick(ray, myThrowPending());
    if (!hit) {
      deviceFocus.release(); // click away steps back, like every device
      return;
    }
    if (hit.kind === 'settings') {
      toggleCard();
      return;
    }
    if (hit.kind === 'takedown') {
      takeDownAll();
      return;
    }
    if (hit.kind === 'dice') {
      const p = h.projectToFelt(ray);
      if (!p) return;
      held = [{ t: performance.now(), p }];
      localHold.add(itemId);
      h.diceHold(p);
      capture?.setPointerCapture(e.pointerId);
      return;
    }
    if (hit.kind === 'rail') {
      const i = stackAt(hit.p);
      if (i < 0) return;
      pickup = { stack: i, nextAt: performance.now() + PICKUP_REPEAT_MS, interval: PICKUP_REPEAT_MS };
      takeFromStack(i);
      capture?.setPointerCapture(e.pointerId);
      return;
    }
    if (hitSettings(layout, hit.p)) {
      toggleCard();
      return;
    }
    // A click on your own stack takes this round's chips back from the box
    // that stack stands in (a tall stack can hide felt several boxes away);
    // anywhere else in a box, the hand bets.
    const stackAtPt = h.onMyStack(ray, hit.p);
    const stackRg = stackAtPt ? hitRegion(layout, stackAtPt) : null;
    if (stackRg && takeBack(stackRg)) return;
    const hitRg = hitRegion(layout, hit.p);
    if (!hitRg) return;
    const rg = pointerTarget(hitRg);
    if (hand.length > 0) placeHand(rg);
    else say(`${labelOf(rg.bet)} — PICK UP CHIPS FROM YOUR RAIL FIRST`);
  };

  /** The browser dropped the gesture (lost capture, a touch interrupted):
   *  put down what's held without acting on it — no throw, no more pickup. */
  const onCancel = (e: PointerEvent): void => {
    e.stopPropagation();
    touches.delete(e.pointerId);
    if (capture?.hasPointerCapture(e.pointerId)) capture.releasePointerCapture(e.pointerId);
    dropGesture();
  };

  /** Put down what's held without acting on it: no throw, no more pickup. */
  function dropGesture(): void {
    if (pickup) {
      pickup = null;
      refreshRail();
    }
    if (held) {
      held = null;
      localHold.delete(itemId); // the frame driver slides the dice back
    }
  }

  const onUp = (e: PointerEvent): void => {
    e.stopPropagation();
    touches.delete(e.pointerId);
    if (capture?.hasPointerCapture(e.pointerId)) capture.releasePointerCapture(e.pointerId);
    if (pickup) {
      pickup = null;
      refreshRail();
    }
    if (held) throwDice();
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // The same game without a pointer: arrows pick a box on the felt (ringed,
  // and read out), number keys pick chips off the rail, Enter bets them.

  const KEY_HELP = `${game === 'craps' ? 'Craps' : 'Roulette'} table. Arrow keys choose a box on the felt. `
    + '1 to 6 pick up a 1, 5, 25, 100, 500 or 1000 chip. Enter or Space bets your hand on the box. '
    + 'Delete takes back the chips you put there this round, or your odds there. '
    + 'C takes all your bets down, as the round button by your rail does. 0 puts your hand back. '
    + `${game === 'craps' ? 'R throws the dice when they are yours. ' : ''}`
    + 'I reads the table. S opens the table card. Escape steps away.';

  const handLine = (): string => (hand.length
    ? `Holding ${sumOf(hand)} in ${hand.length} chip${hand.length === 1 ? '' : 's'}.`
    : 'Your hand is empty.');

  const describeRegion = (rg: FeltRegion<Spot>): string => {
    const key = spotKey(rg.bet);
    const mine = myBets().filter((b) => spotKey(b) === key).reduce((a, b) => a + b.amount, 0);
    const pays = game === 'craps' && isOddsType(rg.bet.type) ? `, ${oddsLine(rg.bet)}` : rg.sub ? `, pays ${rg.sub}` : '';
    return `${labelOf(rg.bet)}${pays}. ${mine > 0 ? `Your chips here: ${mine}.` : 'None of your chips here.'} ${handLine()}`;
  };

  /** An odds box read aloud: what it pays on the number it backs, and how
   *  much more of your flat bet's odds it can take right now. */
  const oddsLine = (b: Spot): string => {
    const t = b.type as CrapsBet['type'];
    const lay = t === 'dontpassodds' || t === 'dontcomeodds';
    const point = crapsState()?.point ?? null;
    const n = t === 'passodds' || t === 'dontpassodds' ? point : b.pick ?? null;
    const pays = n === null
      ? `pays ${lay ? 'lay odds: 1 to 2 on 4 and 10, 2 to 3 on 5 and 9, 5 to 6 on 6 and 8' : 'true odds: 2 to 1 on 4 and 10, 3 to 2 on 5 and 9, 6 to 5 on 6 and 8'}`
      : `pays ${(lay ? LAY_PAYS : ODDS_PAYS)[n]?.toLowerCase() ?? ''} on the ${n}`;
    const o = oddsRoom(myBets() as CrapsBet[], t, b.pick, point);
    const room = o.reason ? o.reason.toLowerCase() : `you can add up to ${o.room}`;
    const off = t === 'comeodds' && point === null ? ', off on the come-out' : '';
    return `${pays}${off}; ${room}`;
  };

  const selectRegion = (i: number): void => {
    const rg = layout.regions[i];
    if (!rg || !h) return;
    focusIdx = i;
    h.setFocusRegion(rg.id);
    cursor = regionCenter(rg);
    h.setHand(cursor, hand);
    announce(describeRegion(rg));
  };

  const moveFocus = (dx: number, dy: number): void => {
    const cam = deviceFocus.getCamera();
    if (!h || !cam || layout.regions.length === 0) return;
    const pts = layout.regions.map((rg) => h.toScreen(regionCenter(rg), cam));
    if (focusIdx < 0) {
      // First press: the box nearest the middle of the view.
      let best = 0;
      let bd = Infinity;
      pts.forEach((q, i) => {
        const d = q ? Math.hypot(q.x, q.y) : Infinity;
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      selectRegion(best);
      return;
    }
    const j = nearestInDirection(pts, focusIdx, dx, dy);
    if (j < 0) announce(`Edge of the table. ${labelOf(layout.regions[focusIdx].bet)}.`);
    else selectRegion(j);
  };

  const pickDenom = (d: number): void => {
    const i = railView.findIndex((st) => st.denom === d && st.count > 0);
    if (i < 0) {
      announce(`No ${d} chips in your rail. ${handLine()}`);
      return;
    }
    if (hand.length >= HAND_MAX) {
      announce(`Your hand is full. ${handLine()}`);
      return;
    }
    takeFromStack(i);
    announce(handLine());
  };

  const keyThrow = (): void => {
    const s = crapsState();
    if (!s || !myThrowPending() || !h) {
      announce('The dice are not yours to throw.');
      return;
    }
    const inward = stand ? inwardFrom(stand, h.halfZ) : { x: 0, z: 1 };
    const from = rail
      ? { x: rail.x + inward.x * 0.12, z: rail.z + inward.z * 0.12 }
      : { x: 0, z: 0 };
    const spread = (Math.random() - 0.5) * 0.4;
    const dx = inward.x - inward.z * spread, dz = inward.z + inward.x * spread;
    const len = Math.hypot(dx, dz) || 1;
    sendThrow({
      round: s.round,
      by: me,
      sx: from.x,
      sz: from.z,
      dx: dx / len,
      dz: dz / len,
      power: 0.6 + Math.random() * 0.3,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    announce('You throw the dice.');
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    let handled = true;
    if (k === 'ArrowLeft') moveFocus(-1, 0);
    else if (k === 'ArrowRight') moveFocus(1, 0);
    else if (k === 'ArrowUp') moveFocus(0, 1);
    else if (k === 'ArrowDown') moveFocus(0, -1);
    else if (k === 'Enter' || k === ' ') {
      const rg = layout.regions[focusIdx];
      if (!rg) moveFocus(0, 0);
      else if (hand.length > 0) {
        placeHand(rg);
        announce(describeRegion(rg));
      } else say(`${labelOf(rg.bet)} — PICK UP CHIPS FROM YOUR RAIL FIRST`);
    } else if (k === 'Delete' || k === 'Backspace') {
      const rg = layout.regions[focusIdx];
      if (rg && takeBack(rg)) announce(describeRegion(rg));
      else announce('Nothing of yours to take back here this round.');
    } else if (k === 'c' || k === 'C') {
      takeDownAll();
    } else if (k >= '1' && k <= '6') {
      pickDenom([...CHIP_DENOMS].sort((a, b) => a - b)[Number(k) - 1]);
    } else if (k === '0') {
      hand = [];
      refreshRail();
      announce('Your chips are back in your rail.');
    } else if ((k === 'r' || k === 'R') && game === 'craps') keyThrow();
    else if (k === 'i' || k === 'I') {
      announce(`${status().line}. You have ${readChips(me)} chips. ${handLine()}`);
    } else if (k === 's' || k === 'S') {
      toggleCard();
    } else if (k === '?' || k === 'h' || k === 'H') announce(KEY_HELP);
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // ── Status bar ────────────────────────────────────────────────────────────

  const status = (): { line: string; color: string } => {
    const remain = (): string => {
      const d = deadline();
      return d != null ? ` · ${Math.max(0, Math.ceil((d - Date.now()) / 1000))}s` : '';
    };
    const staked = myBets().length > 0;
    if (game === 'craps') {
      const cs = computedCraps();
      if (cs) return computedCrapsStatus(cs, remain, staked);
      const s = crapsState();
      if (animating()) return { line: '🎲 THE DICE ARE ROLLING…', color: PINK };
      if (!s) return { line: '🎲 COME OUT — PLACE YOUR BETS', color: GOLD_BRIGHT };
      if (s.phase === 'closing') {
        if (myThrowPending()) return { line: `🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM ACROSS THE TABLE${remain()}`, color: WIN };
        if (s.shooter && s.shooter !== me) return { line: `✋ NO MORE BETS — ${readPlayerDisplayName(s.shooter).toUpperCase()} IS SHOOTING${remain()}`, color: PINK };
        return { line: '✋ NO MORE BETS — THE STICKMAN THROWS', color: PINK };
      }
      if (s.phase === 'settled' && s.voided) {
        return { line: '⚠ ROLL VOID — IT COULD NOT BE SETTLED FAIRLY · BETS STAND FOR THE NEXT ROLL', color: GOLD_BRIGHT };
      }
      if (s.phase === 'settled' && s.dice && s.result !== null) {
        const won = (s.payouts?.[me] ?? 0) > 0;
        const call = s.sevenOut ? ' — SEVEN OUT' : s.point !== null && s.point === s.result ? '' : '';
        return {
          line: `● ${s.dice[0]} + ${s.dice[1]} = ${s.result}${call}${won ? ' — YOU WIN' : ''}`,
          color: won ? WIN : GOLD_BRIGHT,
        };
      }
      const head = s.point === null ? 'COME OUT — PLACE YOUR BETS' : `THE POINT IS ${s.point} — PLACE YOUR BETS`;
      const shooting = s.shooter === me ? ' · YOU HAVE THE DICE' : '';
      const late = deadline() != null && Date.now() >= deadline()! ? '✋ NO MORE BETS' : head;
      return { line: `🎲 ${late}${shooting}${remain()}${readChips(me) <= 0 && !staked ? ' · VISIT THE CASHIER FOR CHIPS' : ''}`, color: GOLD_BRIGHT };
    }
    const s = rouletteState();
    if (animating()) return { line: '🎡 NO MORE BETS — THE BALL IS ROLLING…', color: PINK };
    if (computed()) {
      const c = computedStatus(s as ComputedRouletteState | null, remain);
      if (c) return c;
    }
    if (s?.phase === 'closing') return { line: '✋ NO MORE BETS', color: PINK };
    if (s?.phase === 'settled' && s.voided) {
      return { line: '⚠ SPIN VOID — IT COULD NOT BE SETTLED FAIRLY · STAKES RETURNED', color: GOLD_BRIGHT };
    }
    if (s?.phase === 'settled' && s.result !== null) {
      const won = (s.payouts?.[me] ?? 0) > 0;
      return { line: `● ${s.result} ${pocketColor(s.result).toUpperCase()}${won ? ' — YOU WIN' : ''}`, color: won ? WIN : GOLD_BRIGHT };
    }
    return { line: `🎡 ROUND ${round()} — PLACE YOUR BETS${remain()}${readChips(me) <= 0 && !staked ? ' · VISIT THE CASHIER FOR CHIPS' : ''}`, color: GOLD_BRIGHT };
  };

  /** 🎲 A computed craps table's status line, in this order: rolls undone;
   *  my fling's time gone by (until the dice land); a change too late for
   *  the close, or new bets that missed it; the dice in the air (a flight
   *  under ROLLING_MS old, or settling on their faces); my seed awaited, the
   *  seeds awaited; the wait for the shooter's throw, by what the shooter's
   *  slip says; my roll; another's; a roll the bettors' pages left; the
   *  stickman's throw; then the void, the settled roll (its call, my win or
   *  loss, the dice changing hands, what became of my felt), and betting
   *  (the dice's holder, and what they need to throw). */
  const computedCrapsStatus = (s: ComputedCrapsState, remain: () => string, staked: boolean): { line: string; color: string } => {
    const now = Date.now();
    const name = (pid: string): string => readPlayerDisplayName(pid).toUpperCase();
    const secs = (at: number): string => `${Math.max(0, Math.ceil((at - now) / 1000))}s`;
    const shown = seeComputed(itemId, s.inc, s.rollKey).shown;
    const to = computedDecidedTo(itemId);
    if (to !== null && shown > to) {
      const rolls = to + 1 === shown ? `ROLL ${shown}` : `ROLLS ${to + 1}–${shown}`;
      return { line: `⚠ ${rolls} UNDONE — BETS AS THE ROOM NOW HAS THEM`, color: GOLD_BRIGHT };
    }
    const mine = computedMine(itemId);
    const pending = myThrowPending();
    const moving = animating();
    // (An offer lasts while its roll is on screen, taken back to betting
    // or shown again no longer; and only for a roll whose dice I held.)
    if (offered && (offered.inc !== s.inc || offered.r !== s.round || s.phase === 'betting')) offered = null;
    const held = s.phase === 'closing' ? s.holder === me : s.holderBefore === me;
    if (offered && held && !pending && computedFlungFor(itemId)?.r !== s.round
      && (s.phase === 'closing' || (s.phase === 'settled' && moving))) {
      return { line: "✋ TIME'S UP — THE STICKMAN THREW", color: PINK };
    }
    if (s.phase === 'closing' && mine?.tooLate) return { line: '✋ TOO LATE — THE CLOSE HAD YOUR EARLIER BETS', color: PINK };
    // (A felt left out that added nothing plays as it rode in: nothing missed.)
    if (s.phase === 'closing' && mine?.leftOut && mine.added) {
      return { line: `✋ YOUR NEW BETS MISSED THE CLOSE — CHIPS BACK${mine.riding ? ' · THE REST PLAY' : ''}`, color: GOLD_BRIGHT };
    }
    if (moving && (s.phase === 'settled' || flightAge(itemId, s.round) < ROLLING_MS)) return { line: '🎲 THE DICE ARE ROLLING…', color: PINK };
    const wait = s.phase === 'closing' ? houseWait() : null;
    if (s.phase === 'closing' && mine) {
      if (mine.frozen && !mine.revealed) return { line: '✋ NO MORE BETS — STAY UNTIL THE DICE LAND', color: PINK };
      return wait ?? { line: '✋ NO MORE BETS — WAITING FOR SEEDS', color: PINK };
    }
    if (s.phase === 'closing') {
      if (s.shooterSlip !== undefined && s.phaseDeadline !== undefined) {
        const throwsIn = `THE STICKMAN THROWS IN ${secs(s.phaseDeadline)}`;
        if (s.holder === me && s.shooter === undefined) return { line: `✋ NO MORE BETS — YOU HAVE NO BET DOWN · ${throwsIn}`, color: PINK };
        if (s.holder !== undefined && s.holder !== me) {
          const who = name(s.holder);
          const why = s.shooterSlip === 'gone' ? `${who} HAS GONE`
            : s.shooterSlip === 'absent' ? `${who} ISN'T HERE`
              : s.shooterSlip === 'none' ? `${who} HAS NO BET DOWN`
                : s.shooterSlip === 'away' ? `WAITING FOR ${who}` : null;
          if (why) return { line: `✋ NO MORE BETS — ${why} · ${throwsIn}`, color: PINK };
        }
      }
      if (pending) return { line: `🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM ACROSS THE TABLE${remain()}`, color: WIN };
      if (s.shooter && s.shooter !== me) return { line: `✋ NO MORE BETS — ${name(s.shooter)} IS SHOOTING${remain()}`, color: PINK };
      if (s.stallUntil !== undefined) {
        return { line: `✋ NO MORE BETS — THE BETTORS HAVE GONE QUIET · BETTING REOPENS IN ${secs(s.stallUntil)}`, color: PINK };
      }
      return wait ?? { line: '✋ NO MORE BETS — THE STICKMAN THROWS', color: PINK };
    }
    if (s.phase === 'settled' && s.voided) {
      return { line: '⚠ ROLL VOID — NOBODY COULD FINISH IT · BETS STAND FOR THE NEXT ROLL', color: GOLD_BRIGHT };
    }
    if (s.phase === 'settled' && s.dice) {
      const parts = [`● ${callOf(s.dice, s.pointBefore ?? null, s.point)}`];
      const amount = s.amounts?.[me];
      if (s.pushes?.includes(me)) parts.push('PUSH');
      else if (amount !== undefined) parts.push(signedChips(amount));
      const before = s.holderBefore;
      const after = s.shooterAfter;
      if (s.sevenOut && before === me && after === me) parts.push('THE DICE COME BACK TO YOU');
      else if (after !== before) {
        parts.push(after === undefined ? 'THE STICKMAN HAS THE DICE' : after === me ? 'THE DICE PASS TO YOU' : `THE DICE PASS TO ${name(after)}`);
      }
      const check = computedRoundCheck(itemId);
      const fate = check?.round === s.round ? check.mine : null;
      const rest = mine?.riding ? ' · THE REST PLAYED' : '';
      const lost = (mine?.lost ?? 0) > 0;
      if (mine?.tooLate) parts.push('TOO LATE — THE CLOSE HAD YOUR EARLIER BETS');
      else if (fate === 'left-out') {
        if (mine?.added) parts.push(`YOUR NEW BETS MISSED THE CLOSE — CHIPS BACK${rest}`);
      }
      else if (fate === 'late') parts.push(lost ? `YOUR SEED CAME IN LATE — NEW BETS FORFEITED${rest}` : 'YOUR SEED CAME IN LATE — YOUR BETS PLAYED WITHOUT IT');
      else if (fate === 'forfeited') parts.push(lost ? `YOUR SEED NEVER CAME — NEW BETS FORFEITED${rest}` : 'YOUR SEED NEVER CAME — YOUR BETS PLAYED WITHOUT IT');
      else if (mine?.fate === 'full') parts.push('THE TABLE WAS FULL — YOUR NEW BETS CAME BACK');
      else if (mine?.undone) parts.push('THE LAST ROLL CHANGED — YOUR CHANGES WERE UNDONE · BETS AS THEY STOOD');
      return { line: parts.join(' · '), color: (amount ?? 0) > 0 ? WIN : GOLD_BRIGHT };
    }
    const head = s.point === null ? 'COME OUT' : `THE POINT IS ${s.point}`;
    const cashier = readChips(me) <= 0 && !staked ? ' · VISIT THE CASHIER FOR CHIPS' : '';
    const d = s.phaseDeadline;
    if (d === undefined && s.riders > 0) return { line: `🎲 ${head} — BETS RIDE · PLACE A BET TO START THE NEXT ROLL${cashier}`, color: GOLD_BRIGHT };
    let dice = '';
    if (s.holder === me) {
      dice = ' · YOU HAVE THE DICE';
      if (!s.shooterInPlay) dice += ' · THE STICKMAN THROWS THIS ONE';
      else if (!staked) dice += s.point === null ? ' · PUT A BET DOWN TO THROW AND KEEP THE DICE' : ' · PUT A BET DOWN TO THROW';
    } else if (s.holder !== undefined) {
      dice = ` · ${name(s.holder)} HAS THE DICE${s.shooterInPlay ? '' : ' · THE STICKMAN THROWS THIS ONE'}`;
    }
    const late = d !== undefined && now >= d ? '✋ NO MORE BETS' : `${head} — PLACE YOUR BETS`;
    return { line: `🎲 ${late}${dice}${remain()}${cashier}`, color: GOLD_BRIGHT };
  };

  /** 🏠 What a Fair round closed and undecided waits on, as the status line
   *  says it (null: the bettors' seeds, or no Fair round): the house's seed,
   *  once every bettor's is in; or nobody's, the house unheard. */
  const houseWait = (): { line: string; color: string } | null => {
    const w = computedHouseState(itemId)?.waiting ?? null;
    if (w === 'offline') {
      return { line: `⚠ THE HOUSE WENT OFFLINE · THIS ${game === 'craps' ? 'ROLL' : 'ROUND'} GOES VOID UNLESS IT COMES BACK · THEN THE TABLE RUNS FRIENDLY`, color: GOLD_BRIGHT };
    }
    return w === 'house' ? { line: "✋ NO MORE BETS — WAITING FOR THE HOUSE'S SEED", color: PINK } : null;
  };

  /** 🧮 The status lines only a computed table has (null: the owner-run
   *  table's line says it): a round undone, the seeds awaited, and what
   *  became of my felt in the round closing or shown. */
  const computedStatus = (s: ComputedRouletteState | null, remain: () => string): { line: string; color: string } | null => {
    if (!s) return null;
    const shown = seeComputed(itemId, s.inc, s.spinKey).shown;
    const to = computedDecidedTo(itemId);
    if (to !== null && shown > to) return { line: `⚠ ROUND ${shown} UNDONE — BETS BACK${remain()}`, color: GOLD_BRIGHT };
    const mine = computedMine(itemId);
    if (s.phase === 'closing') {
      if (mine?.tooLate) return { line: '✋ TOO LATE — THE CLOSE HAD YOUR EARLIER BETS', color: PINK };
      if (mine?.leftOut) return { line: '✋ YOUR BET MISSED THE CLOSE — CHIPS BACK', color: GOLD_BRIGHT };
      if (mine?.frozen && !mine.revealed) return { line: '✋ NO MORE BETS — STAY UNTIL THE SPIN', color: PINK };
      return houseWait() ?? { line: '✋ NO MORE BETS — WAITING FOR SEEDS', color: PINK };
    }
    if (s.phase === 'settled' && s.voided) return { line: '⚠ SPIN VOID — NOBODY COULD FINISH IT · STAKES RETURNED', color: GOLD_BRIGHT };
    if (s.phase === 'settled' && s.result !== null) {
      const check = computedRoundCheck(itemId);
      const fate = check?.round === s.round ? check.mine : null;
      const note = mine?.tooLate ? 'TOO LATE — THE CLOSE HAD YOUR EARLIER BETS'
        : fate === 'left-out' ? 'YOUR BET MISSED THE CLOSE — CHIPS BACK'
          : fate === 'late' ? 'YOUR SEED CAME IN LATE — BETS FORFEITED'
            : fate === 'forfeited' ? 'YOUR SEED NEVER CAME — BETS FORFEITED'
              : '';
      if (note) {
        const won = (s.payouts?.[me] ?? 0) > 0;
        return { line: `● ${s.result} ${pocketColor(s.result).toUpperCase()}${won ? ' — YOU WIN' : ''} · ${note}`, color: GOLD_BRIGHT };
      }
    }
    return null;
  };

  const renderBar = (): void => {
    if (!bar) return;
    const st = status();
    const badge = fairnessBadge(itemId, game);
    const fairLine = bar.querySelector<HTMLDivElement>('[data-fair]')!;
    if (fairLine.textContent !== badge.text) fairLine.textContent = badge.text;
    fairLine.style.color = badge.color;
    const line = bar.querySelector<HTMLDivElement>('[data-status]')!;
    line.textContent = st.line;
    line.style.color = st.color;
    const fl = bar.querySelector<HTMLDivElement>('[data-flash]')!;
    const showFlash = flash && performance.now() < flashUntil;
    fl.textContent = showFlash ? flash : '';
    fl.style.display = showFlash ? 'block' : 'none';
    // Screen readers hear each notice once (the status line ticks every
    // second, so it stays out of the live region).
    const live = bar.querySelector<HTMLDivElement>('[data-live]')!;
    if (live.textContent !== liveText) live.textContent = liveText;
  };

  // ── ⚙️ settings card ──────────────────────────────────────────────────────

  const rulesHtml = (): string => game === 'craps'
    ? `<div>PASS / DON'T PASS — 1:1, come-out only (12 pushes don't pass)</div>
       <div>COME / DON'T COME — 1:1, once a point is on; travels to its number</div>
       <div>PLACE 4 · 10 — 9:5 &nbsp; 5 · 9 — 7:5 &nbsp; 6 · 8 — 7:6 (off on the come-out)</div>
       <div>FIELD — 1:1, 2 and 12 pay 2:1 &nbsp; BIG 6 / BIG 8 — 1:1</div>
       <div>HARD 6 · 8 — 9:1 &nbsp; HARD 4 · 10 — 7:1 (off on the come-out)</div>
       <div>ODDS behind PASS / COME — true odds, no house edge: 4 · 10 — 2:1 &nbsp; 5 · 9 — 3:2 &nbsp; 6 · 8 — 6:5; up to ${MAX_ODDS_MULTIPLE[4]}× · ${MAX_ODDS_MULTIPLE[5]}× · ${MAX_ODDS_MULTIPLE[6]}× the flat bet</div>
       <div>LAY ODDS behind DON'T PASS / DON'T COME — 4 · 10 — 1:2 &nbsp; 5 · 9 — 2:3 &nbsp; 6 · 8 — 5:6; up to ${MAX_LAY_MULTIPLE}× the flat bet</div>
       <div>Come odds are off on the come-out (returned if the come bet is decided then); lay odds always work. Odds come down any time bets are open.</div>
       <div>ANY 7 — 4:1 &nbsp; ANY CRAPS — 7:1 &nbsp; 2 · 12 — 30:1 &nbsp; 3 · 11 — 15:1</div>
       <div>${computed() ? COMPUTED_SHOOTER_RULE : 'The dice go clockwise to players with a line bet; a shooter keeps them until a seven-out.'}</div>`
    : `<div>SINGLE-ZERO WHEEL — straight up 35:1</div>
       <div>DOZENS and COLUMNS — 2:1</div>
       <div>RED / BLACK · ODD / EVEN · 1–18 / 19–36 — 1:1 (zero loses them)</div>`;

  const btn = (id: string, label: string, enabled: boolean): string =>
    `<button data-act="${id}" ${enabled ? '' : 'disabled'} style="padding:6px 10px;background:rgba(212,168,75,${enabled ? 0.12 : 0.04});border:1px solid rgba(212,168,75,${enabled ? 0.5 : 0.18});border-radius:6px;color:${enabled ? GOLD_BRIGHT : DIM};font:inherit;font-size:10px;font-weight:800;letter-spacing:1.2px;cursor:${enabled ? 'pointer' : 'not-allowed'};">${label}</button>`;

  /** The card's line for the last settled result's fairness check (async the
   *  first time; cached per checked content). null when there is nothing to check. */
  const lastResultCheck = (): { text: string; color: string } | null => {
    const cs = game === 'craps' ? crapsState() : null;
    const rs = game === 'roulette' ? rouletteState() : null;
    const s = cs ?? rs;
    if (s?.phase !== 'settled') return null;
    const what = game === 'craps' ? 'LAST ROLL' : 'LAST SPIN';
    if (s.voided) {
      // A void is only the canonical no-outcome shape: no result, no payouts,
      // no transcript. `voided` stamped on a played round is a failed check.
      const played = s.result !== null || (cs?.dice ?? null) !== null || !!s.fairness
        || Object.keys(s.payouts ?? {}).length > 0;
      if (played) return { text: `✗ ${what} · CHECK FAILED (A PLAYED ROUND MARKED VOID)`, color: '#FF8A80' };
      return {
        text: `⚠ ${what} VOIDED · A SEED WAS MISSING OR UNSIGNED · ${game === 'craps' ? 'EVERY BET STANDS' : 'STAKES RETURNED'}`,
        color: '#F5C26B',
      };
    }
    const outcome = cs ? (cs.dice ? { dice: cs.dice } : null) : (rs?.result != null ? { pocket: rs.result } : null);
    if (!outcome) return null;
    const fx = s.fairness;
    if (!fx) {
      return s.houseCommit ? { text: `⚠ ${what} · UNPROVEN (NO SEEDS WERE REVEALED)`, color: '#F5C26B' } : null;
    }
    const forRound = s.round;
    const forEpoch = casinoDocEpoch();
    // Everything the verdict reads goes in the key: a late reveal landing in a
    // forfeited party's seed record can change "a revealed seed was left out".
    const records = Object.keys(s.commits ?? {}).sort().map((pid) => readSeedRecord(itemId, pid));
    const inFlight = JSON.stringify([
      forEpoch, forRound, outcome, fx, s.houseCommit ?? null, s.commits ?? null, s.unseeded ?? null, s.wagers ?? null, s.sigs ?? null,
      records,
    ]);
    const v = verdicts.get(inFlight);
    if (v) return v;
    if (!verifying.has(inFlight)) {
      verifying.add(inFlight);
      const check: Promise<{ text: string; color: string }> = fx.parties
        ? verifySettledRound(game, itemId, s, outcome, me).then((r) => {
          if (r.kind === 'failed') return { text: `✗ ${what} · CHECK FAILED`, color: '#FF8A80' };
          if (r.kind === 'unproven') return { text: `⚠ ${what} · UNPROVEN`, color: '#F5C26B' };
          const n = r.forfeited.length;
          const mixed = fx.seeds!.filter((x) => x !== '').length;
          const parts = [`🔒 ${what} · ✓ VERIFIED · ${mixed} SEED${mixed === 1 ? '' : 'S'} MIXED`];
          if (n > 0) parts.push(`${n} WITHHELD (BETS FORFEITED)`);
          const u = r.unseeded.length;
          if (u > 0) parts.push(`⚠ ${u} BETTOR${u === 1 ? '' : 'S'} ADDED NO SEED`);
          // With chips down but no bettor seed in the mix, the house alone
          // made this result: checkable, but not something it couldn't steer.
          const houseOnly = r.bettorSeeds === 0 && (u > 0 || n > 0);
          if (houseOnly) parts.push('⚠ HOUSE SEED ONLY');
          if (r.houseMissing) parts.push('⚠ HOUSE SEED MISSING');
          if (r.droppedReveal) parts.push('✗ A REVEALED SEED WAS LEFT OUT');
          // Your own part is the check that matters most to you: with your
          // seed in, nobody could have steered the result against you.
          // A page that only saw the round after it settled can't tell
          // whether the operator dropped a party from both the frozen set
          // and the transcript: checkable maths, unwitnessed party set.
          if (!r.watchedClose) parts.push('⚠ PARTY SET NOT WITNESSED (OPENED AFTER BETS CLOSED)');
          if (r.mine === 'in') parts.push('✓ YOUR SEED IS IN');
          if (r.mine === 'left-out') parts.push('✗ YOUR SEED WAS LEFT OUT');
          if (r.mine === 'replaced') parts.push('✗ YOUR SEED WAS SWAPPED FOR ONE YOU DID NOT MAKE');
          const bad = r.droppedReveal || r.mine === 'left-out' || r.mine === 'replaced';
          return {
            text: parts.join(' · '),
            color: bad ? '#FF8A80' : r.houseMissing || houseOnly || u > 0 || !r.watchedClose ? '#F5C26B' : '#7CF5B0',
          };
        })
        : verifyTranscript(fx, itemId, forRound, cs?.dice ?? [0, 0]).then((ok) => ({
          text: `🔒 ${what} · ${fx.mode.toUpperCase()}${fx.simulated ? ' (dev-simulated)' : ''} · ${ok ? '✓ verified' : '✗ FAILED'}`,
          color: ok ? '#7CF5B0' : '#FF8A80',
        }));
      check.then((line) => {
        verifying.delete(inFlight);
        // A check started in another room's doc says nothing about this one.
        if (forEpoch !== casinoDocEpoch()) return;
        if (verdicts.size > 32) verdicts.clear();
        verdicts.set(inFlight, line);
        renderCard();
      }, () => verifying.delete(inFlight));
    }
    return { text: `🔒 ${what} · verifying…`, color: '#7CF5B0' };
  };

  /** 🧮 The ⚙ card's lines for a computed table's last decided round: how
   *  it was decided (the fold's own verdict, no transcript to re-hash), what
   *  became of my slip, and what this page saw that the room should know. */
  const computedCheckLines = (): { text: string; color: string }[] => {
    const out: { text: string; color: string }[] = [];
    const c = computedRoundCheck(itemId);
    // 🎲 At craps a roll, its call, and bets that ride on: a missing or
    // left-out slip leaves a rider's bets playing as they stood, and a late
    // seed costs only the chips added that roll.
    const craps = game === 'craps';
    const many = (n: number, one: string, more: string): string => `${n} ${n === 1 ? one : more}`;
    if (c) {
      const parts = [craps ? `🔓 LAST ROLL · ROLL ${c.round}` : `🔓 LAST SPIN · ROUND ${c.round}`];
      if (craps && c.roll?.dice) parts.push(callOf(c.roll.dice, c.roll.pointBefore, c.roll.pointAfter));
      if (c.decided === 'void') parts.push(craps ? 'VOID — NOBODY COULD FINISH IT · EVERY BET STANDS' : 'VOID — NOBODY COULD FINISH IT · STAKES RETURNED');
      else {
        // 🏠 (A Fair round's: the bettors' seeds counted, and the house's.)
        parts.push(`${c.counted} OF ${c.of} SEED${c.of === 1 ? '' : 'S'} ${c.decided === 'house' ? "+ THE HOUSE'S" : 'COUNTED'}`);
        // (Named by the key this page pins for the player: display only. A
        // name is the player's own to set, and any peer's to rewrite: it goes
        // into the card's markup escaped, as text.)
        parts.push(c.decided === 'reveals' ? 'DECIDED BY ALL REVEALS'
          : c.decided === 'house' ? "DECIDED BY THE HOUSE'S REVEAL"
            : `DECIDED BY A FORFEIT BY ${c.forfeitBy ? escapeHtml(readPlayerDisplayName(c.forfeitBy).toUpperCase()) : 'A KEY THIS PAGE DOESN\'T KNOW'}`);
        // (Who held a seed back: a rider can take a second look at the dice
        // that way, at no cost.)
        const late = craps ? c.uncounted ?? [] : [];
        if (late.length > 0) {
          const named = late.slice(0, LEAVE_LIST_MAX).map((pid) => escapeHtml(readPlayerDisplayName(pid).toUpperCase()));
          const more = late.length > LEAVE_LIST_MAX ? ` AND ${late.length - LEAVE_LIST_MAX} MORE` : '';
          parts.push(`NO SEED IN TIME FROM ${named.join(', ')}${more}`);
        }
      }
      if (c.missing.length > 0) {
        parts.push(`${many(c.missing.length, 'FROZEN SLIP', 'FROZEN SLIPS')} NEVER CAME (${craps ? 'NEW BETS NOT STAKED' : 'NOT STAKED'})`);
      }
      if (craps && (c.unseeded ?? 0) > 0) parts.push(`${many(c.unseeded!, "PLAYER'S", "PLAYERS'")} BETS RODE WITHOUT A SEED`);
      const without = craps && !c.mineAdded;
      const forfeited = craps ? ((c.mineLost ?? 0) > 0 ? 'NEW BETS FORFEITED' : 'YOUR BETS PLAYED WITHOUT IT') : 'BETS FORFEITED';
      if (c.mine === 'frozen') parts.push('✓ YOUR SLIP WAS FROZEN');
      if (c.mine === 'left-out') parts.push(`YOUR SLIP WAS LEFT OUT — ${without ? 'YOUR BETS PLAYED WITHOUT IT' : craps ? 'NEW BETS BACK' : 'CHIPS BACK'}`);
      if (c.mine === 'late') parts.push(`✗ YOUR SEED CAME IN LATE — ${forfeited}`);
      if (c.mine === 'forfeited') parts.push(`✗ YOUR SEED NEVER CAME — ${forfeited}`);
      const bad = c.mine === 'late' || c.mine === 'forfeited';
      out.push({ text: parts.join(' · '), color: bad ? '#FF8A80' : c.decided === 'reveals' || c.decided === 'house' ? '#7CF5B0' : '#F5C26B' });
      if (c.houseVoid) out.push({ text: 'THE HOUSE NEVER REVEALED ITS SEED · VOID', color: '#F5C26B' });
      if (c.houseWaited.length > 0) {
        // (Its reveal counts seeds this page never had: whose. Names as
        // forfeitBy's: display only, escaped.)
        const named = c.houseWaited.slice(0, LEAVE_LIST_MAX).map((pid) => escapeHtml(readPlayerDisplayName(pid).toUpperCase()));
        const more = c.houseWaited.length > LEAVE_LIST_MAX ? ` AND ${c.houseWaited.length - LEAVE_LIST_MAX} MORE` : '';
        const seeds = c.houseWaited.length === 1 ? 'A SEED' : 'SEEDS';
        out.push({ text: `THE HOUSE REVEALED ITS SEED · IT COUNTED ${seeds} FROM ${named.join(', ')}${more} THAT NEVER CAME HERE · VOID`, color: '#F5C26B' });
      }
      if (c.dropped.length > 0) out.push({ text: '🚩 A FORFEIT DROPPED A SEED THIS PAGE SAW IN TIME', color: '#FF8A80' });
      if (c.houseDropped.length > 0) out.push({ text: '🚩 THE HOUSE LEFT OUT A SEED THIS PAGE SAW IN TIME', color: '#FF8A80' });
      // (At craps the nets apart from the table the checkpoint hands on.)
      const chips = craps ? c.checkpointNets ?? 0 : c.checkpointDiff;
      if (chips > 0) out.push({ text: `🚩 THE CHECKPOINT DIFFERS FROM THIS PAGE BY ${many(chips, 'CHIP', 'CHIPS')}`, color: '#FF8A80' });
      if (craps && c.checkpointCarry) out.push({ text: "🚩 THE CHECKPOINT'S POINT OR RIDING BETS DIFFER FROM THIS PAGE'S", color: '#FF8A80' });
      if (c.pinMismatch.length > 0) out.push({ text: "🚩 A FROZEN SLIP'S KEY ISN'T ITS PLAYER'S", color: '#FF8A80' });
      if (c.replaced !== undefined) {
        out.push({ text: `🚩 ${craps ? 'ROLL' : 'ROUND'} ${c.replaced} REPLACED AFTER ITS SEEDS WERE OUT`, color: '#FF8A80' });
      }
      if (craps && c.decided !== 'void' && c.counted === 1 && (c.unseeded ?? 0) > 0) {
        out.push({ text: `🚩 ONE PLAYER'S SEED SETTLED ROLL ${c.round} WHILE ${many(c.unseeded!, 'OTHER', 'OTHERS')} HAD BETS RIDING`, color: '#FF8A80' });
      }
      if (craps && (c.illegal?.length ?? 0) > 0) out.push({ text: '🚩 A SLIP BROKE THE TABLE RULES — ITS CHANGES WERE IGNORED', color: '#FF8A80' });
    }
    if (craps) {
      // (Named as this page knows them, escaped: a name is anyone's to set.)
      const unknown = computedUnknownRiders(itemId);
      if (unknown.length > 0) {
        const named = unknown.slice(0, LEAVE_LIST_MAX).map((pid) => escapeHtml(readPlayerDisplayName(pid).toUpperCase()));
        const more = unknown.length > LEAVE_LIST_MAX ? ` · AND ${unknown.length - LEAVE_LIST_MAX} MORE` : '';
        const n = unknown.length === 1 ? '1 RIDER HAS' : `${unknown.length} RIDERS HAVE`;
        out.push({ text: `🚩 ${n} A KEY THIS ROOM HAS NEVER SEEN · ${named.join(' · ')}${more}`, color: '#FF8A80' });
      }
    }
    if (computedOldBuildDriving(itemId)) out.push({ text: '⚠ AN OLDER GAME VERSION IS ALSO RUNNING THIS TABLE', color: '#F5C26B' });
    return out;
  };

  /** 🎲 The ⚙ card's line for a computed craps table as it stands: the
   *  point, how many have bets riding, and who has the dice. */
  const computedCrapsLine = (): string | null => {
    const s = computedCraps();
    if (!s) return null;
    const head = s.point === null ? 'COME OUT' : `THE POINT IS ${s.point}`;
    const riders = s.riders === 0 ? 'NO BETS RIDING' : s.riders === 1 ? '1 PLAYER HAS BETS RIDING' : `${s.riders} PLAYERS HAVE BETS RIDING`;
    const who = s.holder === undefined ? 'THE STICKMAN HAS THE DICE'
      : `${s.holder === me ? 'YOU HAVE' : `${escapeHtml(readPlayerDisplayName(s.holder).toUpperCase())} HAS`} THE DICE${s.shooterInPlay ? '' : ' · THE STICKMAN THROWS NEXT'}`;
    return `${head} · ${riders} · ${who}`;
  };

  /** 🔀 The house's switch row (computedSwitchState: the house, at a
   *  roulette table, with the dev flag, or without it on a computed one),
   *  owner-run or computed: the press, or why it can't go now; a switch-on
   *  asks first. */
  const switchRows = (house: boolean): string[] => {
    const sw = computedSwitchState(itemId, game, house);
    if (!sw.show) return [];
    const rows: string[] = [];
    if (confirming && !sw.on) {
      rows.push(`<div style="font-size:9.5px;font-weight:800;color:${FRIENDLY_RED};">${SWITCH_ON_CONFIRM}</div>`);
      // 🎲 At craps the switch takes every bet down.
      if (game === 'craps') rows.push(`<div style="font-size:9.5px;font-weight:800;color:${FRIENDLY_RED};">${CRAPS_SWITCH_ON_CONFIRM}</div>`);
      rows.push(`<div style="display:flex;gap:8px;justify-content:flex-end;">${btn('computed-cancel', 'CANCEL', true)}${btn('computed-confirm', 'CONFIRM', sw.can)}</div>`);
    } else {
      rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:9px;color:${DIM};letter-spacing:1.2px;">${sw.on ? "PLAYERS' TABLE · ON" : "PLAYERS' TABLE · OFF"}</span>
        ${sw.on ? btn('computed-off', 'BACK TO THE OWNER', sw.can) : btn('computed-on', 'RUN WITHOUT THE OWNER (FRIENDLY)', sw.can)}</div>`);
    }
    if (sw.reason) rows.push(`<div style="font-size:9px;color:#F5C26B;">${sw.reason}</div>`);
    return rows;
  };

  /** 🏠 The ⚙ card's house rows at a house table (none at a table PR 2–4
   *  opened): whether the room's house is online, and the owner's FAIRNESS
   *  (a press for the deed holder, a line for everyone else) while the room
   *  has a house. */
  const houseRows = (house: boolean): string[] => {
    const h = computedHouseState(itemId);
    houseDrawn = h ? `${h.setUp}|${h.online}|${h.fairness}|${h.openFair}` : '';
    if (!h) return [];
    const rows: string[] = [];
    const state = !h.setUp ? `NOT SET UP${h.canSet ? ' · YOUR NODE ADDS IT WHEN IT RUNS THIS ROOM' : ''}`
      : h.online ? 'ONLINE' : `OFFLINE · ${game === 'craps' ? 'ROLLS' : 'ROUNDS'} RUN FRIENDLY`;
    rows.push(`<div style="font-size:9px;color:${h.setUp && h.online ? '#7CF5B0' : DIM};letter-spacing:1.2px;">THE HOUSE · ${state}</div>`);
    if (!h.setUp) return rows;
    const label = h.fairness === 'fair' ? 'FAIR WHILE THE HOUSE IS ONLINE' : 'FRIENDLY';
    rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <span style="font-size:9px;color:${DIM};letter-spacing:1.2px;">FAIRNESS</span>
      ${h.canSet && house ? btn('house-fair', label, true) : `<span style="font-size:10px;color:${GOLD_BRIGHT};">${label}</span>`}</div>`);
    if (h.online && (h.fairness === 'fair') !== h.openFair) {
      rows.push(`<div style="font-size:9px;color:${DIM};">THE NEW SETTING STARTS WITH THE NEXT ${game === 'craps' ? 'ROLL' : 'ROUND'}</div>`);
    }
    return rows;
  };

  const renderCard = (): void => {
    if (!card) return;
    const house = deps.isHouse();
    const live = isCroupierLive(itemId);
    const p = phase();
    const comp = computed();
    const rows: string[] = [];
    rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:12px;font-weight:900;letter-spacing:1px;color:${GOLD_BRIGHT};">⚙️ ${game === 'craps' ? 'CRAPS' : 'ROULETTE'} TABLE</span>
      <button data-act="close" aria-label="Close the table card" style="background:none;border:none;color:${GOLD};font-size:16px;cursor:pointer;">✕</button></div>`);
    // (A players' table's badge below says who runs it: nobody. Its robot,
    // if one stands there, only calls the round, computedRobot.)
    if (!comp) rows.push(`<div style="font-size:9px;color:${DIM};letter-spacing:1px;">${house ? 'YOU RUN THIS TABLE' : 'THE OWNER SETS THIS TABLE · ANYONE CAN LOOK'}</div>`);
    rows.push(`<div style="font-size:10px;line-height:1.7;color:${GOLD};border-top:1px solid rgba(212,168,75,0.18);padding-top:8px;">${rulesHtml()}</div>`);
    // ⚖️ Fair / Friendly, how the result is made, and the last result's check.
    const badge = fairnessBadge(itemId, game);
    rows.push(`<div style="font-size:10px;font-weight:900;letter-spacing:1px;color:${badge.color};">${badge.text}</div>`);
    if (comp) {
      // 🧮 No robot line (the robot runs nothing here), nothing to press but
      // the owner's: 🏠 the house and its FAIRNESS, the fold's verdict, the
      // switch, and how the round goes on (🎲 and at craps where the table
      // stands).
      rows.push(...houseRows(house));
      const table = game === 'craps' ? computedCrapsLine() : null;
      if (table) rows.push(`<div style="font-size:9.5px;color:${GOLD};">${table}</div>`);
      for (const line of computedCheckLines()) rows.push(`<div style="font-size:9px;color:${line.color};">${line.text}</div>`);
      rows.push(...switchRows(house));
      const seeds = badge.fair ? "THE BETTORS' SEEDS AND THE HOUSE'S ARE IN" : "THE BETTORS' SEEDS ARE IN";
      rows.push(`<div style="font-size:9.5px;color:${DIM};">${game === 'craps'
        ? `BETS CLOSE ON THE TIMER · THE ROLL IS DECIDED ONCE ${seeds} · STAY UNTIL THE DICE LAND`
        : `BETS CLOSE ON THE TIMER · THE WHEEL SPINS ONCE ${seeds} · STAY UNTIL THE SPIN`}</div>`);
      pushHelp(rows);
      return;
    }
    const mode = readCrapsFairnessPref(itemId) ?? getCrapsFairnessMode();
    const info = game === 'craps' || mode === 'multiparty' ? FAIRNESS_MODES[mode] : FAIRNESS_MODES.rng;
    rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <span style="font-size:9px;color:${DIM};letter-spacing:1.2px;">${game === 'craps' ? 'DICE' : 'WHEEL'} FAIRNESS</span>
      ${house ? btn('fairness', info.label.toUpperCase(), true) : `<span style="font-size:10px;color:${GOLD_BRIGHT};">${info.label.toUpperCase()}</span>`}</div>`);
    rows.push(`<div style="font-size:9px;color:${DIM};">${info.blurb}${game === 'craps' && (mode === 'commit-reveal' || mode === 'block-beacon') ? ' (dev-simulated, so not Fair yet)' : ''}</div>`);
    if (isFairTable(itemId, game) !== badge.fair) {
      rows.push(`<div style="font-size:9px;color:${DIM};">THE NEW SETTING STARTS WITH THE NEXT ${game === 'craps' ? 'ROLL' : 'ROUND'}</div>`);
    }
    if (game === 'craps') {
      const backend = crapsBackend(readCrapsBackendPref(itemId));
      const pref = readCrapsBackendPref(itemId);
      rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:9px;color:${DIM};letter-spacing:1.2px;">SETTLEMENT</span>
        ${house ? btn('backend', `${backend.label.toUpperCase()}${pref === 'chia' && !backend.isAvailable() ? ' · FALLS BACK TO LOCAL' : ''}`, true) : `<span style="font-size:10px;color:${GOLD_BRIGHT};">${backend.label.toUpperCase()}</span>`}</div>`);
    }
    const lastLine = lastResultCheck();
    if (lastLine) rows.push(`<div style="font-size:9px;color:${lastLine.color};">${lastLine.text}</div>`);
    if (live) {
      rows.push(`<div style="font-size:9.5px;color:${GOLD};">🤖 THE ROBOT ${game === 'craps' ? 'STICKMAN' : 'CROUPIER'} RUNS THIS TABLE ON A TIMER</div>`);
    } else if (house) {
      rows.push(`<div style="display:flex;gap:8px;justify-content:flex-end;">${
        game === 'craps'
          ? (p === 'settled' ? btn('next', 'NEXT ROLL', !animating()) : btn('roll', '🎲 THROW THE DICE', !animating()))
          : (p === 'settled' ? btn('next', 'NEW ROUND', !animating()) : btn('spin', '🎡 SPIN', !animating()))
      }</div>`);
    } else {
      rows.push(`<div style="font-size:9.5px;color:${DIM};">THE HOUSE ${game === 'craps' ? 'THROWS' : 'SPINS'} WHEN THE BETS ARE DOWN</div>`);
    }
    // 🔀 The house's switch to a computed table (the dev flag only; the way
    // back shows on a computed table without it).
    rows.push(...switchRows(house));
    pushHelp(rows);
  };

  /** The card's help lines, then the card drawn. */
  const pushHelp = (rows: string[]): void => {
    if (!card) return;
    rows.push(`<div style="font-size:9px;color:#56606C;border-top:1px solid rgba(212,168,75,0.12);padding-top:8px;line-height:1.6;">
      DRAG ACROSS THE CHIPS IN YOUR RAIL TO PICK THEM UP · CLICK A BOX TO BET THEM · CLICK AGAIN ELSEWHERE TO BET THE SAME ·
      CLICK YOUR OWN CHIPS TO TAKE THEM BACK · RIGHT-CLICK PUTS YOUR HAND BACK · ESC STEPS AWAY<br>
      KEYS: ARROWS CHOOSE A BOX · 1–6 PICK UP CHIPS · ENTER BETS · DELETE TAKES BACK · 0 HAND BACK${game === 'craps' ? ' · R THROWS' : ''} · I READS THE TABLE</div>`);
    // The card re-renders on every room change: keep keyboard focus on the
    // same control across it.
    const act = (document.activeElement as HTMLElement | null)?.closest?.('[data-act]');
    const focusedAct = act && card.contains(act) ? (act as HTMLElement).dataset.act : null;
    card.innerHTML = rows.join('');
    if (focusedAct) card.querySelector<HTMLElement>(`[data-act="${focusedAct}"]`)?.focus();
  };

  const onCardClick = (e: MouseEvent): void => {
    e.stopPropagation();
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    const house = deps.isHouse();
    if (act === 'close') {
      toggleCard();
      capture?.focus({ preventScroll: true });
      return;
    }
    if (!house) return;
    if (act === 'computed-on' || act === 'computed-cancel' || act === 'computed-confirm' || act === 'computed-off') {
      pressSwitch(act);
      renderCard();
      return;
    }
    offArmed = false;
    // 🏠 The owner's FAIRNESS at a house table: Fair while the house is
    // online, or Friendly (the house steps down from the table).
    if (act === 'house-fair') {
      const h = computedHouseState(itemId);
      if (h) {
        const done = setComputedFairness(itemId, h.fairness === 'fair' ? 'friendly' : 'fair');
        if (done === 'reconnecting') say(RECONNECTING_NOTICE);
        else if (done === 'owner') say("ONLY THE ROOM'S OWNER SETS THE HOUSE");
      }
      renderCard();
      return;
    }
    // 🧮 Nothing to set or press on a computed table (none of it is shown):
    // nobody runs its rounds. (SPIN says so itself: spinByHand; ROLL too,
    // pressManualRoll.)
    if (computed() && (act === 'fairness' || act === 'next' || act === 'backend')) {
      say(game === 'craps' ? NO_HAND_ROLL : NO_HAND_SPIN);
      renderCard();
      return;
    }
    if (act === 'fairness') {
      // Roulette is Fair or plain RNG; craps also has its two dev modes. The
      // change applies from the next window the house opens.
      const order: FairnessMode[] = game === 'craps'
        ? ['multiparty', 'rng', 'commit-reveal', 'block-beacon']
        : ['multiparty', 'rng'];
      const cur = readCrapsFairnessPref(itemId) ?? getCrapsFairnessMode();
      const at = order.indexOf(cur);
      writeCrapsFairnessPref(itemId, order[(at < 0 ? 0 : at + 1) % order.length]);
    } else if (act === 'backend') {
      writeCrapsBackendPref(itemId, readCrapsBackendPref(itemId) === 'chia' ? 'local' : 'chia');
    } else if (act === 'roll') {
      // Manual ROLL takes the same close as the robot: the dice go to a
      // seated shooter with a line bet first; a second press (or nobody to
      // shoot) has the stickman throw. See pressManualRoll for who may.
      const notice = pressManualRoll(itemId);
      if (notice) say(notice);
    } else if (act === 'spin') {
      spinByHand();
    } else if (act === 'next') {
      // 💤 Just woken: the doc may not have heard the room yet. 📒 Nor while
      // it holds part of an update: the table may read as gone (casinoWhole),
      // its round as not settled.
      if (!tablesAwake() || !casinoWhole(itemId)) {
        say(RECONNECTING_NOTICE);
        return;
      }
      if (phase() !== 'settled') return;
      if (game === 'craps') {
        const s = crapsState();
        openCrapsBetting(itemId, round() + 1, s?.point ?? null, s);
      } else {
        openBetting(itemId, round() + 1);
      }
    }
    renderCard();
  };

  /** 🔀 The house's switch row pressed: a switch-on asks first (the room's
   *  default is Fair, a computed table Friendly), then goes or says why not;
   *  a switch-off goes or says why not. Only where the row shows. */
  const pressSwitch = (act: string): void => {
    const sw = computedSwitchState(itemId, game, deps.isHouse());
    const armed = offArmed;
    offArmed = false;
    if (!sw.show) {
      confirming = false;
      return;
    }
    const craps = game === 'craps';
    if (act === 'computed-on') confirming = !sw.on;
    else if (act === 'computed-cancel') confirming = false;
    else if (act === 'computed-confirm') {
      confirming = false;
      if (sw.on) return;
      const r = switchComputedOn(itemId, game);
      say(r === 'ok' ? "THE PLAYERS RUN THIS TABLE NOW — NO OPERATOR · FRIENDLY" : (craps ? CRAPS_SWITCH_ON_REFUSED : SWITCH_ON_REFUSED)[r]);
    } else if (act === 'computed-off') {
      confirming = false;
      if (!sw.on) return;
      // 🎲 With contract bets riding the first press warns; the next hands
      // them back with the rest and switches.
      const r = switchComputedOff(itemId, Date.now(), armed);
      offArmed = r === 'contract';
      say(r === 'ok' ? `THE OWNER RUNS THIS TABLE AGAIN FROM ITS NEXT ${craps ? 'ROLL' : 'ROUND'}`
        : (craps ? CRAPS_SWITCH_OFF_REFUSED : SWITCH_OFF_REFUSED)[r]);
    }
  };

  /** The house's manual SPIN: close the window (freezing the round's seed
   *  commitments), then settle as soon as the bettors have revealed. */
  const spinByHand = (): void => {
    // 🧮 Never on a computed table: it spins once the bettors' seeds are in.
    if (computed()) {
      say(NO_HAND_SPIN);
      return;
    }
    // 💤 Just woken: the doc may not have heard the room yet, and a SPIN
    // written on it could take over a round another page has since settled.
    // 📒 Nor while it holds part of an update (casinoWhole): a bet list
    // rewritten in the part still to come reads as gone, and "no more bets"
    // would freeze the round without it.
    if (!tablesAwake() || !casinoWhole(itemId)) {
      say(RECONNECTING_NOTICE);
      return;
    }
    const s = rouletteState();
    // A manual table nobody has run yet: this press opens round 1, so its
    // house commitment is out before a later press freezes the bets.
    if (!s) {
      openBetting(itemId, 1);
      return;
    }
    if (s.phase === 'settled') return;
    if (spinPoll !== null) return; // already settling this round
    if (s.phase === 'betting') closeBetting(itemId, s, undefined, ROULETTE_PAGE_ID);
    else if (s.operator !== undefined && s.operator !== ROULETTE_PAGE_ID) {
      // Another house member's SPIN holds this round. Take it over only once
      // they've had time to settle it (they may have left mid-round).
      if (Date.now() - spinSeenAt(itemId, s, s.operator, Date.now()) < SPIN_TAKEOVER_MS) {
        say('THE WHEEL IS SPINNING — ANOTHER HOUSE MEMBER IS RUNNING THIS ROUND');
        return;
      }
      writeTableState(itemId, { ...s, operator: ROULETTE_PAGE_ID });
    } else if (s.operator === undefined) {
      // An unleased closing round (the robot closed it, then went away):
      // claim it, so only this page publishes and pays.
      writeTableState(itemId, { ...s, operator: ROULETTE_PAGE_ID });
    }
    const r = s.round;
    // Let a rival's lease write converge before this page may publish.
    let settleFrom = Date.now() + LEASE_SETTLE_MS;
    const epoch = casinoDocEpoch();
    let until = Date.now() + REVEAL_GRACE_MS + 6_000;
    let polledAt = Date.now();
    spinPoll = window.setInterval(() => {
      // ⏱ The poll's window counts only time this page could settle in:
      // asleep, frozen, waiting out a wake (tablesAwake) or holding part of
      // an update (casinoWhole), it waits on, or a wait longer than its
      // window would leave the round closing until a second press. A clock
      // gone back mid-poll takes the window back with it, the time left
      // kept: by under a second (a time sync's step) the page runs on, by
      // more it waits out a wake.
      const t = Date.now();
      const step = t - polledAt;
      const whole = casinoWhole(itemId);
      if (step < 0 || !tablesAwake() || !whole) {
        settleFrom += step;
        until += step;
      }
      polledAt = t;
      // Another room's table can share this id and round: stop on a rebind.
      if (casinoDocEpoch() !== epoch) {
        stopSpinPoll();
        return;
      }
      // 📒 The table's own state may be in the part still to come, reading
      // as gone or as the book's: the round is read again once it comes.
      if (!whole) return;
      const now = rouletteState();
      if (now?.phase !== 'closing' || now.round !== r || t > until
        || (now.operator !== undefined && now.operator !== ROULETTE_PAGE_ID)) {
        stopSpinPoll();
        return;
      }
      if (t >= settleFrom) rollAndSettle(itemId, r);
    }, 150);
  };

  const toggleCard = (): void => {
    if (card) {
      card.remove();
      card = null;
      confirming = false;
      offArmed = false;
      return;
    }
    const host = bar?.parentElement;
    if (!host) return;
    card = document.createElement('div');
    card.id = 'casino-table-settings';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', `${game === 'craps' ? 'Craps' : 'Roulette'} table card`);
    card.style.cssText = `
      position:absolute; top:76px; right:24px; width:340px; max-height:80vh; overflow-y:auto;
      background:rgba(4,8,22,0.94); border:1px solid rgba(212,168,75,0.3); border-radius:10px;
      box-shadow:0 10px 48px rgba(0,0,0,0.85); padding:14px; display:flex; flex-direction:column; gap:10px;
      font-family:'SF Mono','Monaco','Consolas',monospace; color:${GOLD}; pointer-events:auto; box-sizing:border-box;`;
    card.addEventListener('click', onCardClick);
    card.addEventListener('keydown', (e) => {
      // Esc closes the card back to the table, not the whole table.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        toggleCard();
        capture?.focus({ preventScroll: true });
      } else if (e.key !== 'Tab') {
        e.stopPropagation();
      }
    });
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup'] as const) {
      card.addEventListener(ev, (e) => e.stopPropagation());
    }
    host.appendChild(card);
    renderCard();
    // Into the dialog, however it was opened: its Esc closes it, and a screen
    // reader follows focus there.
    card.querySelector<HTMLElement>('button')?.focus();
  };

  // ── Seat ──────────────────────────────────────────────────────────────────

  const beatSeat = (): void => {
    if (deps.stand === null || !stand) return;
    writeMySeat(itemId, me, { stand: deps.stand, angle: Math.atan2(stand.z, stand.x), at: Date.now() });
    if (game === 'craps') markLocalSeat(itemId, me, true, deps.stand);
  };

  // ── DeviceUI ──────────────────────────────────────────────────────────────

  return {
    mount(host: HTMLElement): void {
      syncWindow();
      capture = document.createElement('div');
      capture.id = 'casino-table-capture';
      capture.style.cssText = 'position:absolute; inset:0; pointer-events:auto; touch-action:none; outline:none;';
      // Keyboard + screen-reader play: the table itself takes focus (the
      // ringed box on the felt is the focus indicator).
      capture.tabIndex = 0;
      capture.setAttribute('role', 'application');
      capture.setAttribute('aria-roledescription', `${game} table`);
      capture.setAttribute('aria-label', KEY_HELP);
      capture.addEventListener('keydown', onKey);
      capture.addEventListener('pointermove', onMove);
      capture.addEventListener('pointerdown', onDown);
      capture.addEventListener('pointerup', onUp);
      capture.addEventListener('pointercancel', onCancel);
      capture.addEventListener('contextmenu', (e) => e.preventDefault());
      // Never a click-away release: the table owns every click on it.
      for (const ev of ['click', 'mousedown', 'mouseup'] as const) {
        capture.addEventListener(ev, (e) => e.stopPropagation());
      }
      host.appendChild(capture);
      capture.focus({ preventScroll: true });

      bar = document.createElement('div');
      bar.id = 'casino-table-bar';
      bar.style.cssText = `
        position:absolute; top:14px; left:50%; transform:translateX(-50%); max-width:min(92vw, 760px);
        background:rgba(4,8,22,0.82); border:1px solid rgba(212,168,75,0.28); border-radius:10px;
        padding:8px 14px; text-align:center; pointer-events:none;
        font-family:'SF Mono','Monaco','Consolas',monospace; box-sizing:border-box;`;
      bar.innerHTML = `
        <div data-fair style="font-size:9px;font-weight:800;letter-spacing:1.2px;margin-bottom:3px;"></div>
        <div data-status style="font-size:12px;font-weight:900;letter-spacing:1px;"></div>
        <div data-flash style="display:none;font-size:10px;font-weight:800;color:#FF8A80;letter-spacing:1px;margin-top:3px;"></div>
        <div data-live role="status" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;"></div>
        <div style="font-size:9px;color:rgba(212,168,75,0.55);letter-spacing:1px;margin-top:4px;">
          DRAG ACROSS YOUR RAIL TO PICK UP CHIPS · CLICK THE FELT TO BET · RIGHT-CLICK TO PUT THEM BACK · ⚙️ TABLE · ESC TO STEP BACK<br>
          ↶ BY YOUR CHIPS TAKES YOUR BETS DOWN · OR KEYS: ARROWS · 1–6 · ENTER · C TAKE DOWN · H FOR HELP</div>`;
      host.appendChild(bar);

      beatSeat();
      seatTimer = window.setInterval(beatSeat, SEAT_BEAT_MS);
      unsubscribe = subscribeCasino(() => {
        syncWindow();
        noteComputed();
        refreshRail();
        renderBar();
        if (card) renderCard();
      });
      noteComputed();
      if (game === 'craps') noteBack();
      refreshRail();
      renderBar();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      if (seatTimer !== null) window.clearInterval(seatTimer);
      seatTimer = null;
      stopSpinPoll();
      if (game === 'craps') noteLeaving();
      clearMySeat(itemId, me);
      markLocalSeat(itemId, me, false);
      localHold.delete(itemId);
      held = null;
      pickup = null;
      hand = [];
      cursor = null;
      railCap = null;
      h?.setRailStacks([]);
      h?.setHand(null, []);
      h?.setSettingsHot(false);
      h?.setTakeDownHot(false);
      h?.setTakeDown(null, false);
      takeDownShown = '';
      h?.setFocusRegion(null);
      focusIdx = -1;
      card?.remove();
      card = null;
      bar?.remove();
      bar = null;
      capture?.remove();
      capture = null;
    },
    update(): void {
      syncEpoch();
      dropStaleHold();
      if (game === 'craps') {
        const inPlay = crapsRollInPlay(itemId);
        if (inPlay && railCap === null) railCap = readChips(me);
        else if (!inPlay && railCap !== null) {
          railCap = null;
          refreshRail();
        }
      }
      // Holding over one stack keeps picking chips off it, a little faster each time.
      if (pickup && pickup.stack >= 0 && performance.now() >= pickup.nextAt) {
        takeFromStack(pickup.stack);
        pickup.interval = Math.max(PICKUP_REPEAT_MIN_MS, pickup.interval * 0.8);
        pickup.nextAt = performance.now() + pickup.interval;
      }
      noteComputed();
      syncTakeDown();
      renderBar();
      if (card) {
        const h = computedHouseState(itemId);
        const drawn = h ? `${h.setUp}|${h.online}|${h.fairness}|${h.openFair}` : '';
        if (drawn !== houseDrawn) renderCard();
      }
    },
  };
}
