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
  casinoDocEpoch, clearMySeat, creditChips, readAllBets, readAllCrapsBets, readChips,
  readCrapsBackendPref, readCrapsFairnessPref, readCrapsTableState,
  readDiceThrow, readMyBets, readMyCrapsBets, readSeat, readSeats, readTableState,
  spendChips, subscribeCasino, writeCrapsBackendPref, writeCrapsFairnessPref,
  writeDiceThrow, writeMyBets, writeMyCrapsBets, writeMySeat,
} from './casinoDoc';
import type { TableSeat } from './casinoDoc';
import { railStacks, RAIL_PITCH } from './casinoTable3d';
import type { CasinoTableVisualHandle, FeltStack, RailSpec, RailStack } from './casinoTable3d';
import { CHIP_DENOMS, railChips } from './chipDisplay';
import { isCroupierLive, openBetting, rollAndSettle } from './croupier';
import { crapsBackend } from './crapsBackend';
import {
  openCrapsBetting, pressManualRoll, STICKMAN_DICE_SPOT,
} from './crapsCroupier';
import { deviceFocus } from './deviceFocus';
import type { DeviceUI } from './devices';
import { FURNITURE, FURNITURE_DEFS } from './furniture';
import {
  assignSlots, chipSlots, crapsChipRect, crapsSideFor, CRAPS_LAYOUT, hitRegion,
  hitSettings, ROULETTE_LAYOUT, spotKey,
} from './games/casinoLayout';
import type { FeltLayout, FeltPoint, FeltRect, FeltRegion } from './games/casinoLayout';
import { canPlaceBet, crapsBetLabel, pointWasOn } from './games/craps';
import type { CrapsBet, CrapsTableState, FairnessMode } from './games/craps';
import { FAIRNESS_MODES, getCrapsFairnessMode, verifyTranscript } from './games/diceFairness';
import { readPlayerDisplayName } from './games/gamesDoc';
import { betLabel, payoutFor, pocketColor } from './games/roulette';
import type { RouletteBet, RouletteTableState } from './games/roulette';
import { getPlayerId } from './identity';

// ── Tunables ─────────────────────────────────────────────────────────────────

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
 *  GPU pools without limit either. Players draw in player-id order, so every
 *  client draws the same chips in the same slots. */
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
    if (budget <= 0) break;
    for (const b of bets.slice(0, MAX_BETS_DRAWN_PER_PLAYER)) {
      if (budget <= 0) break;
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
      const add = chipsUpTo(b.amount, Math.min(MAX_STACK_CHIPS - list.length, budget));
      budget -= add.length;
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
  /** Chips I put down this betting window, by spot (the only ones I may take
   *  back — a craps bet from an earlier roll is a contract on the felt). */
  let added = new Map<string, number[]>();
  let windowRound = -1;
  /** round → verdict of the fairness check, so the card never re-hashes. */
  const verdicts = new Map<number, boolean>();
  /** The room doc this focus began in: rounds and bets from another room's
   *  table with the same id must not count as this window's. */
  let mountEpoch = casinoDocEpoch();
  const syncEpoch = (): void => {
    if (mountEpoch === casinoDocEpoch()) return;
    mountEpoch = casinoDocEpoch();
    windowRound = -1;
    added = new Map();
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
  };

  const say = (text: string): void => {
    flash = text;
    flashUntil = performance.now() + 2600;
    renderBar();
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
    if (!pickup) railView = rail ? railStacks(rail, railChips(balance - sumOf(hand))) : [];
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
      if (!canPlaceBet(type, s?.point ?? null)) {
        say(type === 'come' || type === 'dontcome'
          ? 'THE COME BOX OPENS ONCE A POINT IS ON'
          : 'THE LINE IS CLOSED WHILE A POINT IS ON');
        return;
      }
    }
    const chips = [...hand];
    if (!spendChips(me, sumOf(chips))) {
      say('NOT ENOUGH CHIPS — VISIT THE CASHIER');
      refreshRail();
      return;
    }
    const placed = chips.map((amount) => ({ ...rg.bet, amount }));
    writeBets([...myBets(), ...placed]);
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
    const mine = added.get(key) ?? [];
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
    const inward = stand ? { x: -Math.sign(Math.abs(stand.z) > h.halfZ ? 0 : stand.x), z: -Math.sign(Math.abs(stand.z) > h.halfZ ? stand.z : 0) } : { x: 0, z: 1 };
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

  const onMove = (e: PointerEvent): void => {
    if (!h || !aim(e)) return;
    cursor = h.projectToFelt(ray);
    const hit = h.pick(ray, myThrowPending());
    h.setSettingsHot(hit?.kind === 'settings');
    if (capture) capture.style.cursor = hit && hit.kind !== 'felt' ? 'pointer' : hit && hitRegion(layout, hit.p) ? 'pointer' : 'default';
    if (held && cursor) {
      held.push({ t: performance.now(), p: cursor });
      if (held.length > 40) held.shift();
      h.diceHold(cursor);
    }
    if (pickup && hit?.kind === 'rail') {
      const i = stackAt(hit.p);
      if (i >= 0 && i !== pickup.stack) {
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
    const rg = hitRegion(layout, hit.p);
    if (!rg) return;
    if (hand.length > 0) placeHand(rg);
    else say(`${labelOf(rg.bet)} — PICK UP CHIPS FROM YOUR RAIL FIRST`);
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
    if (s?.phase === 'settled' && s.result !== null) {
      const won = (s.payouts?.[me] ?? 0) > 0;
      return { line: `● ${s.result} ${pocketColor(s.result).toUpperCase()}${won ? ' — YOU WIN' : ''}`, color: won ? WIN : GOLD_BRIGHT };
    }
    return { line: `🎡 ROUND ${round()} — PLACE YOUR BETS${remain()}${readChips(me) <= 0 && !staked ? ' · VISIT THE CASHIER FOR CHIPS' : ''}`, color: GOLD_BRIGHT };
  };

  const renderBar = (): void => {
    if (!bar) return;
    const st = status();
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
    const said = showFlash ? flash : '';
    if (live.textContent !== said) live.textContent = said;
  };

  // ── ⚙️ settings card ──────────────────────────────────────────────────────

  const rulesHtml = (): string => game === 'craps'
    ? `<div>PASS / DON'T PASS — 1:1, come-out only (12 pushes don't pass)</div>
       <div>COME / DON'T COME — 1:1, once a point is on; travels to its number</div>
       <div>PLACE 4 · 10 — 9:5 &nbsp; 5 · 9 — 7:5 &nbsp; 6 · 8 — 7:6 (off on the come-out)</div>
       <div>FIELD — 1:1, 2 and 12 pay 2:1 &nbsp; BIG 6 / BIG 8 — 1:1</div>
       <div>HARD 6 · 8 — 9:1 &nbsp; HARD 4 · 10 — 7:1 (off on the come-out)</div>
       <div>ANY 7 — 4:1 &nbsp; ANY CRAPS — 7:1 &nbsp; 2 · 12 — 30:1 &nbsp; 3 · 11 — 15:1</div>
       <div>The dice go clockwise to players with a line bet; a shooter keeps them until a seven-out.</div>`
    : `<div>SINGLE-ZERO WHEEL — straight up 35:1</div>
       <div>DOZENS and COLUMNS — 2:1</div>
       <div>RED / BLACK · ODD / EVEN · 1–18 / 19–36 — 1:1 (zero loses them)</div>`;

  const btn = (id: string, label: string, enabled: boolean): string =>
    `<button data-act="${id}" ${enabled ? '' : 'disabled'} style="padding:6px 10px;background:rgba(212,168,75,${enabled ? 0.12 : 0.04});border:1px solid rgba(212,168,75,${enabled ? 0.5 : 0.18});border-radius:6px;color:${enabled ? GOLD_BRIGHT : DIM};font:inherit;font-size:10px;font-weight:800;letter-spacing:1.2px;cursor:${enabled ? 'pointer' : 'not-allowed'};">${label}</button>`;

  const renderCard = (): void => {
    if (!card) return;
    const house = deps.isHouse();
    const live = isCroupierLive(itemId);
    const p = phase();
    const rows: string[] = [];
    rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:12px;font-weight:900;letter-spacing:1px;color:${GOLD_BRIGHT};">⚙️ ${game === 'craps' ? 'CRAPS' : 'ROULETTE'} TABLE</span>
      <button data-act="close" style="background:none;border:none;color:${GOLD};font-size:16px;cursor:pointer;">✕</button></div>`);
    rows.push(`<div style="font-size:9px;color:${DIM};letter-spacing:1px;">${house ? 'YOU RUN THIS TABLE' : 'THE OWNER SETS THIS TABLE · ANYONE CAN LOOK'}</div>`);
    rows.push(`<div style="font-size:10px;line-height:1.7;color:${GOLD};border-top:1px solid rgba(212,168,75,0.18);padding-top:8px;">${rulesHtml()}</div>`);
    if (game === 'craps') {
      const mode = readCrapsFairnessPref(itemId) ?? getCrapsFairnessMode();
      const info = FAIRNESS_MODES[mode];
      const backend = crapsBackend(readCrapsBackendPref(itemId));
      rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:9px;color:${DIM};letter-spacing:1.2px;">DICE FAIRNESS</span>
        ${house ? btn('fairness', info.label.toUpperCase(), true) : `<span style="font-size:10px;color:${GOLD_BRIGHT};">${info.label.toUpperCase()}</span>`}</div>`);
      rows.push(`<div style="font-size:9px;color:${DIM};">${info.blurb}</div>`);
      const pref = readCrapsBackendPref(itemId);
      rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:9px;color:${DIM};letter-spacing:1.2px;">SETTLEMENT</span>
        ${house ? btn('backend', `${backend.label.toUpperCase()}${pref === 'chia' && !backend.isAvailable() ? ' · FALLS BACK TO LOCAL' : ''}`, true) : `<span style="font-size:10px;color:${GOLD_BRIGHT};">${backend.label.toUpperCase()}</span>`}</div>`);
      const s = crapsState();
      if (s?.phase === 'settled' && s.fairness && s.dice) {
        const v = verdicts.get(s.round);
        const fx = s.fairness;
        const txt = `🔒 LAST ROLL · ${fx.mode.toUpperCase()}${fx.simulated ? ' (dev-simulated)' : ''} · ${v === undefined ? 'verifying…' : v ? '✓ verified' : '✗ FAILED'}`;
        rows.push(`<div style="font-size:9px;color:${v === false ? '#FF8A80' : '#7CF5B0'};">${txt}</div>`);
        if (v === undefined) {
          const forRound = s.round;
          const forEpoch = casinoDocEpoch();
          verifyTranscript(fx, itemId, forRound, s.dice).then((ok) => {
            // A check started in another room's doc says nothing about this one.
            if (forEpoch !== casinoDocEpoch()) return;
            if (verdicts.size > 32) verdicts.clear();
            verdicts.set(forRound, ok);
            renderCard();
          });
        }
      }
    }
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
      CLICK YOUR OWN CHIPS TO TAKE THEM BACK · RIGHT-CLICK PUTS YOUR HAND BACK · ESC STEPS AWAY</div>`);
    card.innerHTML = rows.join('');
  };

  const onCardClick = (e: MouseEvent): void => {
    e.stopPropagation();
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    const house = deps.isHouse();
    if (act === 'close') {
      toggleCard();
      return;
    }
    if (!house) return;
    if (act === 'fairness') {
      const order: FairnessMode[] = ['rng', 'commit-reveal', 'multiparty', 'block-beacon'];
      const cur = readCrapsFairnessPref(itemId) ?? getCrapsFairnessMode();
      writeCrapsFairnessPref(itemId, order[(order.indexOf(cur) + 1) % order.length]);
    } else if (act === 'backend') {
      writeCrapsBackendPref(itemId, readCrapsBackendPref(itemId) === 'chia' ? 'local' : 'chia');
    } else if (act === 'roll') {
      // Manual ROLL takes the same close as the robot: the dice go to a
      // seated shooter with a line bet first; a second press (or nobody to
      // shoot) has the stickman throw. See pressManualRoll for who may.
      const notice = pressManualRoll(itemId);
      if (notice) say(notice);
    } else if (act === 'spin') {
      if (phase() === 'betting' || phase() === 'closing') rollAndSettle(itemId, round());
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
    card.style.cssText = `
      position:absolute; top:76px; right:24px; width:340px; max-height:80vh; overflow-y:auto;
      background:rgba(4,8,22,0.94); border:1px solid rgba(212,168,75,0.3); border-radius:10px;
      box-shadow:0 10px 48px rgba(0,0,0,0.85); padding:14px; display:flex; flex-direction:column; gap:10px;
      font-family:'SF Mono','Monaco','Consolas',monospace; color:${GOLD}; pointer-events:auto; box-sizing:border-box;`;
    card.addEventListener('click', onCardClick);
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup'] as const) {
      card.addEventListener(ev, (e) => e.stopPropagation());
    }
    host.appendChild(card);
    renderCard();
  };

  // ── Seat ──────────────────────────────────────────────────────────────────

  const beatSeat = (): void => {
    if (deps.stand === null || !stand) return;
    writeMySeat(itemId, me, { stand: deps.stand, angle: Math.atan2(stand.z, stand.x), at: Date.now() });
  };

  // ── DeviceUI ──────────────────────────────────────────────────────────────

  return {
    mount(host: HTMLElement): void {
      syncWindow();
      capture = document.createElement('div');
      capture.id = 'casino-table-capture';
      capture.style.cssText = 'position:absolute; inset:0; pointer-events:auto; touch-action:none;';
      capture.addEventListener('pointermove', onMove);
      capture.addEventListener('pointerdown', onDown);
      capture.addEventListener('pointerup', onUp);
      capture.addEventListener('pointercancel', onUp);
      capture.addEventListener('contextmenu', (e) => e.preventDefault());
      // Never a click-away release: the table owns every click on it.
      for (const ev of ['click', 'mousedown', 'mouseup'] as const) {
        capture.addEventListener(ev, (e) => e.stopPropagation());
      }
      host.appendChild(capture);

      bar = document.createElement('div');
      bar.id = 'casino-table-bar';
      bar.style.cssText = `
        position:absolute; top:14px; left:50%; transform:translateX(-50%); max-width:min(92vw, 760px);
        background:rgba(4,8,22,0.82); border:1px solid rgba(212,168,75,0.28); border-radius:10px;
        padding:8px 14px; text-align:center; pointer-events:none;
        font-family:'SF Mono','Monaco','Consolas',monospace; box-sizing:border-box;`;
      bar.innerHTML = `
        <div data-status style="font-size:12px;font-weight:900;letter-spacing:1px;"></div>
        <div data-flash style="display:none;font-size:10px;font-weight:800;color:#FF8A80;letter-spacing:1px;margin-top:3px;"></div>
        <div data-live role="status" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;"></div>
        <div style="font-size:9px;color:rgba(212,168,75,0.55);letter-spacing:1px;margin-top:4px;">
          DRAG ACROSS YOUR RAIL TO PICK UP CHIPS · CLICK THE FELT TO BET · RIGHT-CLICK TO PUT THEM BACK · ⚙️ TABLE · ESC TO STEP BACK</div>`;
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
      clearMySeat(itemId, me);
      localHold.delete(itemId);
      held = null;
      pickup = null;
      hand = [];
      cursor = null;
      h?.setRailStacks([]);
      h?.setHand(null, []);
      h?.setSettingsHot(false);
      card?.remove();
      card = null;
      bar?.remove();
      bar = null;
      capture?.remove();
      capture = null;
    },
    update(): void {
      syncEpoch();
      // Holding over one stack keeps picking chips off it, a little faster each time.
      if (pickup && performance.now() >= pickup.nextAt) {
        takeFromStack(pickup.stack);
        pickup.interval = Math.max(PICKUP_REPEAT_MIN_MS, pickup.interval * 0.8);
        pickup.nextAt = performance.now() + pickup.interval;
      }
      renderBar();
    },
  };
}
