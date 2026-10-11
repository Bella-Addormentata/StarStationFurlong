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
 *    ON/OFF pucks, the roulette wheel and ball, the winning boxes lit. There
 *    is no separate game surface: spectators watch the same pieces the
 *    players touch (the diegetic-display rule air hockey set).
 *  - createCasinoTableUI (the focused player): a full-screen capture layer
 *    that turns pointer input into table actions, a slim status bar, and the
 *    ⚙️ settings card. Press and drag across the chips in your rail to pick
 *    some up; click a box on the felt to bet them (each further click bets
 *    the same chips again); click your own chips on the felt to pick back up
 *    what you put down this round; right-click puts the hand back. When the
 *    dice come to you, grab them and fling them across the table.
 *
 * THE RULES OF MONEY DO NOT CHANGE: a chip is spent (casinoDoc.spendChips)
 * the moment it lands on the felt, exactly as the popups did; the hand is a
 * local view of chips still in your balance. The settle, the payouts and the
 * shooter rotation stay with the elected operator (croupier.ts /
 * crapsCroupier.ts). The fling is cosmetic: the dice faces come from the
 * table's fairness mode, and every client animates the same throw from the
 * synced `throw:<tableId>` record.
 */

import * as THREE from 'three';
import {
  casinoDocEpoch, clearMySeat, creditChips, readAllBets, readAllCrapsBets, readChips, readSeedRecord,
  readCrapsBackendPref, readCrapsFairnessPref, readCrapsTableState,
  readDiceThrow, readMyBets, readMyCrapsBets, readSeat, readSeats, readTableState,
  spendChips, subscribeCasino, writeCrapsBackendPref, writeCrapsFairnessPref,
  writeDiceThrow, writeMyBets, writeMyCrapsBets, writeMySeat, writeTableState,
} from './casinoDoc';
import type { TableSeat } from './casinoDoc';
import { railStacks, RAIL_PITCH } from './casinoTable3d';
import type { CasinoTableVisualHandle, FeltStack, RailSpec, RailStack } from './casinoTable3d';
import { CHIP_DENOMS, railChipCounts } from './chipDisplay';
import { closeBetting, isCroupierLive, openBetting, rollAndSettle, ROULETTE_PAGE_ID } from './croupier';
import { crapsBackend } from './crapsBackend';
import {
  markLocalSeat, openCrapsBetting, pressManualRoll, STICKMAN_DICE_SPOT,
} from './crapsCroupier';
import { deviceFocus } from './deviceFocus';
import type { DeviceUI } from './devices';
import { FURNITURE, FURNITURE_DEFS } from './furniture';
import {
  assignSlots, chipSlots, crapsChipRect, crapsSideFor, CRAPS_LAYOUT, hitRegion,
  hitSettings, LAY_PAYS, nearestInDirection, ODDS_PAYS, regionCenter, ROULETTE_LAYOUT, spotKey,
} from './games/casinoLayout';
import type { FeltLayout, FeltPoint, FeltRect, FeltRegion } from './games/casinoLayout';
import {
  canPlaceBet, crapsBetLabel, isOddsType, MAX_LAY_MULTIPLE, MAX_ODDS_MULTIPLE, oddsFlat, oddsRoom, pointWasOn,
} from './games/craps';
import type { CrapsBet, CrapsTableState, FairnessMode } from './games/craps';
import { FAIRNESS_MODES, getCrapsFairnessMode, verifyTranscript } from './games/diceFairness';
import { isFairTable, MAX_TABLE_BETTORS, REVEAL_GRACE_MS, roundIsFair, tickFairSeeds, verifySettledRound } from './fairTableSeeds';
import { readPlayerDisplayName } from './games/gamesDoc';
import { betLabel, payoutFor, pocketColor } from './games/roulette';
import type { RouletteBet, RouletteTableState } from './games/roulette';
import { getPlayerId } from './identity';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** ⚖️ The plaque line for the round on a table: Fair (the round runs the
 *  seed exchange) or Friendly (you are trusting the owner's client). It names
 *  the mode, not the outcome: whether a given result really took bettors'
 *  seeds is the ⚙ card's verdict line, which warns on house-seed-only. */
export function fairnessBadge(tableId: string, game: 'craps' | 'roulette'): { text: string; color: string; fair: boolean } {
  return roundIsFair(tableId, game)
    ? { text: '✔ FAIR TABLE · EVERY BETTOR ADDS A SEED · CHECK EACH RESULT ON ⚙', color: '#7CF5B0', fair: true }
    : { text: "🤝 FRIENDLY TABLE · YOU'RE TRUSTING THE OWNER", color: '#F28B87', fair: false };
}

/** 🎡 A rival house member's SPIN lease is honoured this long before this
 *  page may take the round over (the reveal wait plus a margin). */
const SPIN_TAKEOVER_MS = 15_000;
/** How long a fresh lease write gets to converge before its page settles. */
const LEASE_SETTLE_MS = 600;

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
  /** Doc changed since the felt was last laid out. */
  dirty: boolean;
}

const runtimes = new Map<string, TableRuntime>();
let unsubscribeDoc: (() => void) | null = null;

function runtime(tableId: string): TableRuntime {
  let rt = runtimes.get(tableId);
  if (!rt || rt.epoch !== casinoDocEpoch()) {
    rt = { epoch: casinoDocEpoch(), primed: false, thrownSeed: null, landedRound: 0, spunRound: 0, dirty: true };
    runtimes.set(tableId, rt);
  }
  return rt;
}

function markAllDirty(): void {
  for (const rt of runtimes.values()) rt.dirty = true;
}

/** Tables whose dice the LOCAL shooter is holding — the frame driver leaves
 *  those dice alone (the focused UI moves them under the cursor). */
const localHold = new Set<string>();

/** Bets laid out as stacks: one per player per box, each in front of its
 *  owner (assignSlots), bottom chip the largest. */
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

function layoutStacks<B extends { type: string; pick?: number; amount: number }>(
  betsByPlayer: Record<string, B[]>,
  anchors: Map<string, FeltPoint>,
  rectFor: (bet: B, pid: string) => FeltRect | null,
  me: string,
): FeltStack[] {
  const groups = new Map<string, { rect: FeltRect; chips: Map<string, number[]> }>();
  const pidOrder = Object.keys(betsByPlayer).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let budget = MAX_TABLE_CHIPS;
  for (const pid of pidOrder) {
    const bets = betsByPlayer[pid];
    const mine = pid === me;
    if (budget <= 0 && !mine) continue;
    for (const b of bets.slice(0, MAX_BETS_DRAWN_PER_PLAYER)) {
      if (budget <= 0 && !mine) break;
      const rect = rectFor(b, pid);
      if (!rect) continue;
      const key = `${spotKey(b)}|${rect.x0.toFixed(3)},${rect.z0.toFixed(3)}`;
      let g = groups.get(key);
      if (!g) {
        g = { rect, chips: new Map() };
        groups.set(key, g);
      }
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
  const out: FeltStack[] = [];
  for (const g of groups.values()) {
    const pids = [...g.chips.keys()];
    const at = assignSlots(chipSlots(g.rect), pids.map((pid) => ({ pid, anchor: anchors.get(pid) ?? null })));
    for (const pid of pids) {
      const slot = at.get(pid);
      if (!slot) continue;
      out.push({ x: slot.x, z: slot.z, chips: [...g.chips.get(pid)!].sort((a, b) => b - a), dim: pid !== me });
    }
  }
  return out;
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
  const s = readCrapsTableState(id);
  const t = readDiceThrow(id);
  h.setFairBadge(roundIsFair(id, 'craps'));
  if (!rt.primed) {
    // Walking in mid-game (or a room rebind): clear whatever the pieces still
    // show, then show where things stand, animating nothing old.
    rt.primed = true;
    h.reset();
    rt.thrownSeed = t?.seed ?? null;
    if (s?.phase === 'settled' && s.dice) {
      rt.landedRound = s.round;
      h.diceLand(s.dice);
    }
    h.setPuck(s?.point ?? null);
  }
  if (!s) return;
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
      const shooterSeat = s.shooter !== undefined ? readSeat(id, s.shooter) : null;
      const stand = shooterSeat ? standLocal(kind, shooterSeat.stand) : null;
      h.diceRestAt(stand ? diceSpotFor(stand, CRAPS_LAYOUT.felt) : STICKMAN_DICE_SPOT);
    }
    if (rt.dirty) {
      rt.dirty = false;
      const anchors = seatAnchors(kind, readSeats(id));
      h.setFeltChips(layoutStacks(
        readAllCrapsBets(id),
        anchors,
        (b: CrapsBet, pid) => crapsChipRect(b, crapsSideFor(anchors.get(pid)?.x ?? 1)),
        me,
      ));
      h.setHighlight(s.phase === 'settled' && s.dice ? crapsWinners(s.dice[0], s.dice[1], pointWasOn(s)) : NO_HIGHLIGHT);
    }
  }
}

function driveRoulette(id: string, h: CasinoTableVisualHandle, rt: TableRuntime, me: string): void {
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
      const anchors = seatAnchors('roulette-table', readSeats(id));
      const regionFor = new Map(ROULETTE_LAYOUT.regions.map((r) => [spotKey(r.bet), r.chipRect]));
      h.setFeltChips(layoutStacks(
        readAllBets(id, s.round),
        anchors,
        (b: RouletteBet) => regionFor.get(spotKey(b)) ?? null,
        me,
      ));
      h.setHighlight(s.phase === 'settled' && s.result !== null ? rouletteWinners(s.result) : NO_HIGHLIGHT);
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
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let bar: HTMLDivElement | null = null;
  let capture: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let seatTimer: number | null = null;
  /** The manual SPIN's settle poll: one per focused table. */
  let spinPoll: number | null = null;
  /** When this page first saw another house member's lease on a round. */
  let spinSeen: { key: string; at: number } | null = null;
  const stopSpinPoll = (): void => {
    if (spinPoll !== null) window.clearInterval(spinPoll);
    spinPoll = null;
  };

  /** Chips in hand (denominations). Spent only when they land on the felt. */
  let hand: number[] = [];
  /** The rail as laid out right now (frozen while a pickup drag runs). */
  let railView: RailStack[] = [];
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
  /** Chips I put down this betting window, by spot (the only ones I may take
   *  back — a craps bet from an earlier roll is a contract on the felt). */
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

  const crapsState = (): CrapsTableState | null => readCrapsTableState(itemId);
  const rouletteState = (): RouletteTableState | null => readTableState(itemId);
  const round = (): number => (game === 'craps' ? crapsState()?.round : rouletteState()?.round) ?? 1;
  const phase = (): 'betting' | 'closing' | 'settled' =>
    (game === 'craps' ? crapsState()?.phase : rouletteState()?.phase) ?? 'betting';
  const deadline = (): number | undefined =>
    game === 'craps' ? crapsState()?.phaseDeadline : rouletteState()?.phaseDeadline;
  const myBets = (): AnyBet[] => (game === 'craps' ? readMyCrapsBets(itemId, me) : readMyBets(itemId, me, round()));
  const writeBets = (bets: AnyBet[]): void => {
    if (game === 'craps') writeMyCrapsBets(itemId, me, bets as CrapsBet[]);
    else writeMyBets(itemId, me, round(), bets as RouletteBet[]);
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
    const t = readDiceThrow(itemId);
    return !(t && t.round === s.round);
  };

  const syncWindow = (): void => {
    syncEpoch();
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
    if (!pickup) railView = rail ? railStacks(rail, railChipCounts(balance - sumOf(hand))) : [];
    h.setRailStacks(railView);
    h.setHand(cursor, hand);
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
    if (!bettingOpen()) {
      say(phase() === 'settled' ? 'WAIT FOR THE NEXT ROUND' : 'NO MORE BETS');
      return;
    }
    if (game === 'craps') {
      const s = crapsState();
      const type = rg.bet.type as CrapsBet['type'];
      if (isOddsType(type)) {
        // 🎲 Odds ride on a flat bet, up to the table's multiple of it.
        const o = oddsRoom(readMyCrapsBets(itemId, me), type, rg.bet.pick, s?.point ?? null);
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
    // take a chip nobody would see.
    const mine = myBets();
    const key0 = spotKey(rg.bet);
    if (mine.filter((b) => spotKey(b) === key0).length + chips.length > MAX_STACK_CHIPS) {
      say(`THAT BOX IS FULL — ${MAX_STACK_CHIPS} CHIPS A BOX`);
      return;
    }
    if (mine.length + chips.length > MAX_BETS_DRAWN_PER_PLAYER) {
      say(`YOU HAVE ${MAX_BETS_DRAWN_PER_PLAYER} CHIPS DOWN — THE TABLE LIMIT`);
      return;
    }
    // ⚖️ A Fair round's transcript carries at most MAX_TABLE_BETTORS bettors:
    // a newcomer past that would be left out of the settle, so they wait.
    if (mine.length === 0 && roundIsFair(itemId, game)) {
      const all = game === 'craps' ? readAllCrapsBets(itemId) : readAllBets(itemId, round());
      if (Object.keys(all).filter((pid) => pid !== me).length >= MAX_TABLE_BETTORS) {
        say('THE TABLE IS FULL — WAIT FOR A PLACE');
        return;
      }
    }
    if (!spendChips(me, sumOf(chips))) {
      say('NOT ENOUGH CHIPS — VISIT THE CASHIER');
      refreshRail();
      return;
    }
    const placed = chips.map((amount) => ({ ...rg.bet, amount }));
    writeBets([...mine, ...placed]);
    const warnKey = `${casinoDocEpoch()}:${itemId}`;
    // Commit this bet's seed now, not on the next tick: a quick close must
    // still find it.
    tickFairSeeds(itemId, game, me, Date.now(), true);
    if (!roundIsFair(itemId, game) && !friendlyWarned.has(warnKey)) {
      friendlyWarned.add(warnKey);
      say("🤝 FRIENDLY TABLE — THE OWNER COULD STEER RESULTS · BET WITH PEOPLE YOU TRUST");
    }
    const key = spotKey(rg.bet);
    added.set(key, [...(added.get(key) ?? []), ...chips]);
    // The hand stays loaded: the next box you click takes the same chips.
    refreshRail();
  };

  /** Pick my chips put down this window back off a box (refunded; into the
   *  hand when it is empty). */
  const takeBack = (rg: FeltRegion<Spot>): boolean => {
    syncWindow();
    const key = spotKey(rg.bet);
    // Odds are the one bet you may take down any time the betting is open,
    // not only this window's chips (the flat bet under them stays).
    const mine = game === 'craps' && isOddsType(rg.bet.type)
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
    writeBets(keep);
    creditChips(me, sumOf(back));
    added.delete(key);
    // An empty hand picks them up; a loaded hand is already the stake you're
    // betting with, so they just go back to the rail.
    if (hand.length === 0) hand = back.slice(0, HAND_MAX);
    refreshRail();
    return true;
  };

  // ── The shooter ───────────────────────────────────────────────────────────

  const throwDice = (): void => {
    if (!held || !h) return;
    const s = crapsState();
    const samples = held;
    held = null;
    localHold.delete(itemId);
    const now = performance.now();
    const recent = samples.filter((x) => now - x.t <= FLING_WINDOW_MS);
    const a = recent[0] ?? samples[samples.length - 1];
    const b = samples[samples.length - 1];
    const dt = Math.max(1, b.t - a.t) / 1000;
    const vx = (b.p.x - a.p.x) / dt;
    const vz = (b.p.z - a.p.z) / dt;
    const speed = Math.hypot(vx, vz);
    // "Forward" is away from the shooter's own rail, toward the far side.
    const inward = stand ? inwardFrom(stand, h.halfZ) : { x: 0, z: 1 };
    const forward = (vx * inward.x + vz * inward.z) / (speed || 1);
    if (!s || !myThrowPending() || speed < FLING_MIN_SPEED || forward < 0.35) {
      say('FLING THE DICE FORWARD, ACROSS THE TABLE');
      return; // the frame driver slides them back to your spot
    }
    writeDiceThrow(itemId, {
      round: s.round,
      by: me,
      sx: b.p.x,
      sz: b.p.z,
      dx: vx / speed,
      dz: vz / speed,
      power: Math.min(1, (speed - FLING_MIN_SPEED) / (FLING_FULL_SPEED - FLING_MIN_SPEED)),
      seed: Math.floor(Math.random() * 2 ** 31),
    });
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
    if (oddsFlat(readMyCrapsBets(itemId, me), t, rg.bet.pick) > 0 && !(point === null && (t === 'passodds' || t === 'dontpassodds'))) return rg;
    const tag = rg.side > 0 ? '+' : '-';
    const to = t === 'comeodds' || t === 'dontcomeodds'
      ? `place:${rg.bet.pick}@${tag}`
      : point === null ? `${t === 'passodds' ? 'pass' : 'dontpass'}@${tag}` : null;
    return (to && layout.regions.find((r) => r.id === to)) || rg;
  };

  const onMove = (e: PointerEvent): void => {
    if (!h || !aim(e)) return;
    dropStaleHold();
    cursor = h.projectToFelt(ray);
    const hit = h.pick(ray, myThrowPending());
    h.setSettingsHot(hit?.kind === 'settings');
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

  const onDown = (e: PointerEvent): void => {
    e.stopPropagation();
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
    if (capture?.hasPointerCapture(e.pointerId)) capture.releasePointerCapture(e.pointerId);
    if (pickup) {
      pickup = null;
      refreshRail();
    }
    if (held) {
      held = null;
      localHold.delete(itemId); // the frame driver slides the dice back
    }
  };

  const onUp = (e: PointerEvent): void => {
    e.stopPropagation();
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
    + 'Delete takes back the chips you put there this round, or your odds there. 0 puts your hand back. '
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
    const o = oddsRoom(readMyCrapsBets(itemId, me), t, b.pick, point);
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
    writeDiceThrow(itemId, {
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
      const s = crapsState();
      if (animating()) return { line: '🎲 THE DICE ARE ROLLING…', color: PINK };
      if (!s) return { line: '🎲 COME OUT — PLACE YOUR BETS', color: GOLD_BRIGHT };
      if (s.phase === 'closing') {
        if (myThrowPending()) return { line: `🎲 YOUR ROLL — GRAB THE DICE AND FLING THEM ACROSS THE TABLE${remain()}`, color: WIN };
        if (s.shooter && s.shooter !== me) return { line: `✋ NO MORE BETS — ${readPlayerDisplayName(s.shooter).toUpperCase()} IS SHOOTING${remain()}`, color: PINK };
        return { line: '✋ NO MORE BETS — THE STICKMAN THROWS', color: PINK };
      }
      if (s.phase === 'settled' && s.voided) {
        return { line: '⚠ ROLL VOID — THE HOUSE SEED WAS LOST · BETS STAND FOR THE NEXT ROLL', color: GOLD_BRIGHT };
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
    if (s?.phase === 'closing') return { line: '✋ NO MORE BETS', color: PINK };
    if (s?.phase === 'settled' && s.voided) {
      return { line: '⚠ SPIN VOID — THE HOUSE SEED WAS LOST · STAKES RETURNED', color: GOLD_BRIGHT };
    }
    if (s?.phase === 'settled' && s.result !== null) {
      const won = (s.payouts?.[me] ?? 0) > 0;
      return { line: `● ${s.result} ${pocketColor(s.result).toUpperCase()}${won ? ' — YOU WIN' : ''}`, color: won ? WIN : GOLD_BRIGHT };
    }
    return { line: `🎡 ROUND ${round()} — PLACE YOUR BETS${remain()}${readChips(me) <= 0 && !staked ? ' · VISIT THE CASHIER FOR CHIPS' : ''}`, color: GOLD_BRIGHT };
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
       <div>The dice go clockwise to players with a line bet; a shooter keeps them until a seven-out.</div>`
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
        text: `⚠ ${what} VOIDED · THE HOUSE SEED WAS UNAVAILABLE · ${game === 'craps' ? 'EVERY BET STANDS' : 'STAKES RETURNED'}`,
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

  const renderCard = (): void => {
    if (!card) return;
    const house = deps.isHouse();
    const live = isCroupierLive(itemId);
    const p = phase();
    const rows: string[] = [];
    rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:12px;font-weight:900;letter-spacing:1px;color:${GOLD_BRIGHT};">⚙️ ${game === 'craps' ? 'CRAPS' : 'ROULETTE'} TABLE</span>
      <button data-act="close" aria-label="Close the table card" style="background:none;border:none;color:${GOLD};font-size:16px;cursor:pointer;">✕</button></div>`);
    rows.push(`<div style="font-size:9px;color:${DIM};letter-spacing:1px;">${house ? 'YOU RUN THIS TABLE' : 'THE OWNER SETS THIS TABLE · ANYONE CAN LOOK'}</div>`);
    rows.push(`<div style="font-size:10px;line-height:1.7;color:${GOLD};border-top:1px solid rgba(212,168,75,0.18);padding-top:8px;">${rulesHtml()}</div>`);
    // ⚖️ Fair / Friendly, how the result is made, and the last result's check.
    const badge = fairnessBadge(itemId, game);
    rows.push(`<div style="font-size:10px;font-weight:900;letter-spacing:1px;color:${badge.color};">${badge.text}</div>`);
    const mode = readCrapsFairnessPref(itemId) ?? getCrapsFairnessMode();
    const info = game === 'craps' || mode === 'multiparty' ? FAIRNESS_MODES[mode] : FAIRNESS_MODES.rng;
    rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <span style="font-size:9px;color:${DIM};letter-spacing:1.2px;">${game === 'craps' ? 'DICE' : 'WHEEL'} FAIRNESS</span>
      ${house ? btn('fairness', info.label.toUpperCase(), true) : `<span style="font-size:10px;color:${GOLD_BRIGHT};">${info.label.toUpperCase()}</span>`}</div>`);
    rows.push(`<div style="font-size:9px;color:${DIM};">${info.blurb}${game === 'craps' && (mode === 'commit-reveal' || mode === 'block-beacon') ? ' (dev-simulated, so not Fair yet)' : ''}</div>`);
    if (isFairTable(itemId) !== badge.fair) {
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

  /** The house's manual SPIN: close the window (freezing the round's seed
   *  commitments), then settle as soon as the bettors have revealed. */
  const spinByHand = (): void => {
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
      const k = `${casinoDocEpoch()}:${s.round}:${s.operator}`;
      if (spinSeen?.key !== k) spinSeen = { key: k, at: Date.now() };
      if (Date.now() - spinSeen.at < SPIN_TAKEOVER_MS) {
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
    const settleFrom = Date.now() + LEASE_SETTLE_MS;
    const epoch = casinoDocEpoch();
    const until = Date.now() + REVEAL_GRACE_MS + 6_000;
    spinPoll = window.setInterval(() => {
      const now = rouletteState();
      // Another room's table can share this id and round: stop on a rebind.
      if (casinoDocEpoch() !== epoch || now?.phase !== 'closing' || now.round !== r || Date.now() > until
        || (now.operator !== undefined && now.operator !== ROULETTE_PAGE_ID)) {
        stopSpinPoll();
        return;
      }
      if (Date.now() >= settleFrom) rollAndSettle(itemId, r);
    }, 150);
  };

  const toggleCard = (): void => {
    if (card) {
      card.remove();
      card = null;
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
    if (game === 'craps') markLocalSeat(itemId, me, true);
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
          OR KEYS: ARROWS · 1–6 · ENTER · H FOR HELP</div>`;
      host.appendChild(bar);

      beatSeat();
      seatTimer = window.setInterval(beatSeat, SEAT_BEAT_MS);
      unsubscribe = subscribeCasino(() => {
        syncWindow();
        refreshRail();
        renderBar();
        if (card) renderCard();
      });
      refreshRail();
      renderBar();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      if (seatTimer !== null) window.clearInterval(seatTimer);
      seatTimer = null;
      stopSpinPoll();
      clearMySeat(itemId, me);
      markLocalSeat(itemId, me, false);
      localHold.delete(itemId);
      held = null;
      pickup = null;
      hand = [];
      cursor = null;
      h?.setRailStacks([]);
      h?.setHand(null, []);
      h?.setSettingsHot(false);
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
      // Holding over one stack keeps picking chips off it, a little faster each time.
      if (pickup && pickup.stack >= 0 && performance.now() >= pickup.nextAt) {
        takeFromStack(pickup.stack);
        pickup.interval = Math.max(PICKUP_REPEAT_MIN_MS, pickup.interval * 0.8);
        pickup.nextAt = performance.now() + pickup.interval;
      }
      renderBar();
    },
  };
}
