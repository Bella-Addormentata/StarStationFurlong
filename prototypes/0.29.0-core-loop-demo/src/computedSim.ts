/**
 * 🧪🧮🌐 A room of pages playing computed roulette over a simulated network
 * (computedSim.test.ts) — for specs only; no app code imports it.
 *
 * PAGES. Each page is a computedPageKit page: its own load of the casino
 * modules, its own Y.Doc, player id and identity key, its own clock (the
 * room's virtual time plus its skew). A page is up (frames, sync), asleep (no
 * frames; its doc still hears the room, or not), gone (neither), or loaded
 * again (fresh modules and an empty doc the room fills, the same identity
 * key and the same seed store: the same browser profile, a Device). Its
 * frame is World's (world.ts updateCroupier) for a computed table: the
 * tables marked running, the operator's turn on the house's page, and
 * tickComputedTables for the room's tables; a player bot before it puts
 * felts down through the real writeComputedSlip, refusals and all.
 *
 * THE NETWORK is a mesh of one-way links, each with its delay (jitter
 * drawn per message) and loss, first in first out on each link and in no
 * order across links: an update can reach a page before one it rests on
 * that came another way, which the doc holds back (pendingStructs) until the
 * rest comes. A partition cuts the links between its groups; a page made
 * deaf hears nothing while what it sends still goes (a stall of its
 * downlink alone: the wifi's, or its node's link to the host). Every 5 s each
 * linked pair is sent the full state diff the other lacks (the room relay's
 * resync: Y.encodeStateAsUpdate against the peer's state vector), and a page
 * coming online has one sent each way at once (its handshake).
 *
 * A doc that asks the room for what it is missing (casinoDoc's resync
 * callback, as YjsSync's) is sent each linked peer's diff on the next tick.
 *
 * HEARTBEATS. Each page that is up sends every page it is linked to a
 * heartbeat each step (its position tick: main.ts sends one every 50 ms
 * while its player is in the room), over the same links: their delay and
 * jitter, their partitions, lost at their rate, but as datagrams, each in
 * no order with what went before it (and drawn from a random stream of
 * their own, so the updates go as they would without them). A page asleep
 * or gone sends none (a backgrounded tab runs no frames); one that only
 * lags or cheats (pauseUntil, beforeFrame) still does. A page that hears
 * one tells its tables (computedTable noteRoomHeard, as main.ts's onTick
 * does), and an update its doc applies tells them through casinoDoc, as in
 * the app: every page listens to the room as main.ts has it listen
 * (listenToRoom), so a page that hears nothing (cut off, deaf, alone, or
 * every other page asleep) forfeits nothing.
 *
 * THE CLOCK is virtual, in 250 ms steps; each page reads the room's time
 * plus its skew (a clock step is a change of skew). Everything a page does
 * — a frame, an update it hears, a bot's press — runs with its own clock set
 * as the system time and its own Device's storage as localStorage, so its
 * arrival stamps, timers and seeds are its own. A timer a page's code sets
 * (casinoDoc's signature-check slice) is that page's, run before its next
 * frames; its checks run on a clock of their own, 2 ms a check against the
 * real budget, so a page loading a session checks it over several slices.
 * Randomness is seeded: the bots draw from the run's seed, and so do slip
 * seeds (crypto.getRandomValues) and identity keys, so a seed replays a run.
 *
 * WHAT IS MEASURED, while it runs: rounds decided (and how), flips per page
 * (a round the page showed decided that later reads otherwise: another
 * pocket, other payouts, or other chips moved), trims, the largest doc
 * snapshot and live session, the longest a table sat with a tip or with
 * felts and no close while an honest page frozen or staked in it was up and
 * in reach, the CPU time of each update applied (a warm transaction) and of
 * a cold fold of the largest session (the wall clock's beside it).
 *
 * WHAT IS CHECKED, while it runs (a violation each): every decided round
 * each page folds, worked out afresh from its records (who is counted, each
 * stake and delta by the game's rule, the pocket by the async draw of the
 * counted seeds); every forfeit an honest page writes, against the seeds
 * that came into its doc within its grace (and none of a round it showed
 * decided by the reveals that a delete moved, nor an answer or a void's
 * forfeit of a close that came before its last wake's lapse ended); every
 * abandon, ABANDON_MS at least after the close came and after its last
 * wake; a trim moves no player's nets or
 * holds, an ending leaves the nets folded live; a count stands while the doc
 * holds part of an update; a felt of more than its player has is refused; a
 * page that leaves takes its felt down; nothing computed is written before
 * the room's state is in; and at every 5 s, on every page whose doc is whole
 * and checked, each player's chips against a cold fold of every incarnation
 * the doc holds. After the heal and a quiet period, every up page caught up,
 * and against every other: the fold, the view's last decided round, every
 * player's chips, the cage; and the cage against what the run bought.
 */

import { vi } from 'vitest';
import * as Y from 'yjs';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { CrapsHarness, crapsChangeKind, crapsShownOf } from './computedCrapsSim';
import type { CrapsBotSpec, Place } from './computedCrapsSim';
import { canon, gameOfInc, houseCommitOf, parseKey, seedTable, slipCommit } from './computedFold';
import type { Checkpoint, FoldCtx, FoldResult, GameName, RoundView, SigCheck } from './computedFold';
import { loadPage, PAGE_ROOM } from './computedPageKit';
import type { Page } from './computedPageKit';
import { HOUSE_HEARD_MS } from './computedHouse';
import { HOUSE_ORIGIN, SimHouse } from './computedSimHouse';
import { RobotWatch } from './computedSimRobot';
import { b64url, snapshot } from './computedTestKit';
import { combinePocketSeeds } from './games/diceFairness';
import { pocketFromMaterial } from './games/fairDice';
import { resolveRound } from './games/roulette';
import type { RouletteBet } from './games/roulette';

export const SIM_T0 = 2_000_000_000;
/** The virtual clock's step. */
export const SIM_STEP = 250;
/** How often the room resyncs every linked pair. */
export const RESYNC_MS = 5_000;
/** SIM_LONG=1: the long runs (15 simulated minutes a scenario). */
export const SIM_LONG = typeof process !== 'undefined' && process.env.SIM_LONG === '1';
/** A spec's run length, in simulated minutes. */
export const SIM_MINUTES = SIM_LONG ? 15 : 3;
/** SIM_SEED=n: every scenario's seed moved by n (a sweep). */
export const SIM_SEED_OFFSET = typeof process !== 'undefined' ? Number(process.env.SIM_SEED ?? 0) || 0 : 0;

const NET = Symbol('sim-net');
const COMPUTED_INC = /^[ckrd][0-9a-f]{24}$/;
const COMPUTED_SID = /^(?:g|[0-9a-f]{24})$/;

// ── 🎲 Seeded randomness ─────────────────────────────────────────────────────

export type Rng = () => number;

/** mulberry32: the spike's. */
export function simRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole number from lo to hi, both in. */
export const between = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

// ── 💾 Devices: one browser profile's localStorage ───────────────────────────

/** One browser profile: its localStorage, which holds its identity key (the
 *  keypair module's seed) and its seed store (fairTableSeeds). Two tabs of a
 *  player share one; a reload keeps it. */
export class Device {
  readonly store = new Map<string, string>();

  constructor(readonly name: string, seed: number) {
    // The identity seed keypair.ts would mint, fixed by name and run seed.
    this.store.set('ssf-identity-seed', b64url(sha256(utf8ToBytes(`ssf-sim-identity|${seed}|${name}`))));
  }
}

/** The device whose page runs now (enter): what localStorage reads. */
let device: Device | null = null;

const simStorage = {
  getItem: (k: string): string | null => device?.store.get(k) ?? null,
  setItem: (k: string, v: string): void => { device?.store.set(k, String(v)); },
  removeItem: (k: string): void => { device?.store.delete(k); },
  clear: (): void => { device?.store.clear(); },
  key: (i: number): string | null => [...(device?.store.keys() ?? [])][i] ?? null,
  get length(): number { return device?.store.size ?? 0; },
};

// ── ⏲ Timers: each page's own ────────────────────────────────────────────────

/** The page whose code runs now (enter): a timer it sets is its own, run
 *  before its next frame (casinoDoc's signature-check slices). Outside a
 *  page (a load's imports, the runner), the real setTimeout. */
let timersOf: SimPage | null = null;
const realSetTimeout = globalThis.setTimeout;

function simSetTimeout(fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown {
  if (!timersOf) return realSetTimeout(fn, ms, ...args);
  timersOf.timers.push(() => fn(...args));
  return 0;
}

/** Each page's signature checks on a clock of their own: 2 ms a check, as
 *  strict noble's take (casinoDoc's estimate), with the real 40 ms budget
 *  per recount: a session of more than 20 unchecked records takes slices. */
const VERIFY_BUDGET_MS = 40;
function verifyClock(): () => number {
  // (Read before a check and after it: 2 ms between the two reads.)
  let t = 0;
  return () => (t += 2);
}

// ── 🤖 Bots ──────────────────────────────────────────────────────────────────

export interface BotSpec {
  /** Chance per frame, while the view reads betting, of a first felt down,
   *  of taking it all down, of changing it. */
  place: number;
  take: number;
  change: number;
  /** Chips per bet, and bets per felt. */
  amount: [number, number];
  bets: [number, number];
  /** Straight-up bets only (a heavy felt: hundreds of entries). */
  straight?: boolean;
  /** Everything the player has, on red (two tabs at two tables overspend). */
  allIn?: boolean;
  /** Buy this many chips in when the player has fewer than `low` (0: never). */
  low: number;
  topUp: number;
}

export const BOT: BotSpec = { place: 0.12, take: 0.01, change: 0.03, amount: [1, 25], bets: [1, 3], low: 60, topUp: 500 };
/** A felt of 300-400 chips: sessions fill to TRIM_BYTES in a few rounds. */
export const HEAVY_BOT: BotSpec = { ...BOT, change: 0.004, amount: [1, 1], bets: [300, 400], straight: true, low: 450, topUp: 1_000 };

const KINDS: RouletteBet['type'][] = ['red', 'black', 'odd', 'even', 'low', 'high', 'dozen', 'column', 'straight'];

function newBet(r: Rng, bot: BotSpec): RouletteBet {
  const type = bot.straight ? 'straight' : KINDS[between(r, 0, KINDS.length - 1)];
  const amount = between(r, bot.amount[0], bot.amount[1]);
  if (type === 'straight') return { type, pick: between(r, 0, 36), amount };
  if (type === 'dozen' || type === 'column') return { type, pick: between(r, 0, 2), amount };
  return { type, amount };
}

// ── 📄 Pages ─────────────────────────────────────────────────────────────────

export type Mode = 'up' | 'asleep' | 'gone';

export interface PageSpec {
  name: string;
  /** Its clock ahead of the room's, ms. */
  skew?: number;
  /** Another tab of this player (its pid; default `player-<name>`). */
  pid?: string;
  /** Its browser profile (default its own, by name): a second tab names the first's. */
  device?: string;
  /** False for a page the spec plays a cheat on: it counts for no stall. */
  honest?: boolean;
  /** Its bot (null: none), and the tables it plays (default every one). */
  bot?: BotSpec | null;
  botTables?: string[];
  /** The house's page (default the first): it switches the tables on, and
   *  drives them as World does on the deed holder's page (takeTableTurn,
   *  tickAutoCroupier, or at craps tickAutoStickman). */
  house?: boolean;
  /** Chips it buys in as it joins. */
  chips?: number;
  /** 🎲 At craps tables: its bot (default the run's, else CRAPS_BOT), and
   *  where its player is at first (computedCrapsSim Place: a stand 1–7, null
   *  for the device front, 'off' for off the table; default a stand by its
   *  index). */
  crapsBot?: CrapsBotSpec;
  place?: Place;
  /** Run on each load of the page right after its modules load (its own
   *  generation, before another page's load resets them): a scenario's
   *  table UI (computedCrapsUiKit withUI). */
  onLoad?: (p: Page) => Promise<void>;
}

/** A room's table: a bare id is a roulette table's (as the roulette
 *  scenarios name them), or its id and game. */
export type TableSpec = string | { id: string; game: GameName };

/** A round as a page showed it: what its player saw (the pocket, the
 *  payouts and what each player's chips moved by), and the close and the
 *  decision behind it (and the deciding forfeit's writer). */
export interface Shown {
  seen: string;
  close: string;
  decided: string;
  fk?: string;
  /** Since when it has read undecided or gone (ms into the run). */
  gone?: number;
  /** 🎲 At craps: the table the roll played from (computedCrapsSim). */
  sIn?: string;
}

function shownOf(v: RoundView): Shown {
  // (The deltas too: the same pocket and payouts over other stakes — another
  // close, freezing another version of a felt — move other chips.)
  const pay = [...v.deltas.keys()].sort().map((pid) => [pid, (v.payouts.get(pid) ?? 0n).toString(), v.deltas.get(pid)!.toString()]);
  return {
    seen: JSON.stringify([v.pocket, pay]), close: v.close, decided: v.decided ?? 'undecided',
    ...(v.forfeit ? { fk: v.forfeit.rec.k } : {}),
  };
}

/** What rewrote a round a page showed:
 *  - 'forfeit over reveals': the same close, decided by a forfeit that came
 *    after the full set of reveals had shown (a valid forfeit beats a full
 *    set: pr2-verdict.md Q4), written by a page that hadn't seen a seed
 *    within its grace;
 *  - 'answer forfeit': the same close, its deciding forfeit replaced by a
 *    better-ranked one that counts a seed the first dropped (an answer
 *    forfeit, written by a page that saw that seed in time);
 *  - 'rival close': another close of the round won (by the chain rule: the
 *    longest decided chain, then rank), decided another way ("ROUND n WAS
 *    REWRITTEN");
 *  - 'void undone': the same close, shown void (stakes back), then decided
 *    by the full set of reveals or a forfeit (a seed back after the void, or
 *    a forfeit, beats an abandon): it pays out after the stakes went back;
 *  - 'blip': it read undecided or gone for a while, then as shown again (a
 *    record deleted, then put back by its author or a witness);
 *  - 'undone': it read undecided or gone, and the chain kept at the end
 *    doesn't hold it as shown;
 *  - 'other branch': found once the run is over: the chain the doc kept
 *    holds it otherwise, a trim having taken it out of the session meanwhile
 *    (a split: the checkpoint the doc kept, `sum:`'s last write, is the other
 *    side's; or it changed while the page was away);
 *  - 'checkpoint': a checkpoint that differs from the rounds it covers;
 *  - 'repaid' (craps): the same close, decided the same way on the same
 *    dice, paying otherwise: an earlier roll changed, and this one played
 *    again from the state it left (counted once a roll a page showed);
 *  - 'other': anything else. */
export type FlipKind =
  'forfeit over reveals' | 'answer forfeit' | 'rival close' | 'void undone' | 'blip' | 'undone' | 'other branch' | 'checkpoint'
  | 'repaid' | 'other';

/** What took a round from `was` to `is` (both decided, not alike). */
function changeKind(was: Shown, is: Shown): FlipKind {
  if (is.close !== was.close) return 'rival close';
  if (was.decided === 'void') return 'void undone';
  if (was.decided === 'reveals' && is.decided === 'forfeit') return 'forfeit over reveals';
  return was.decided === 'forfeit' && is.decided === 'forfeit' ? 'answer forfeit' : 'other';
}

interface TableWatch {
  /** The last session seen, its weight, and its weight when its last decided round moved on. */
  sid: string;
  bytes: number;
  advancedBytes: number;
  decidedTo: number;
  /** Since when the table has sat (stall). */
  stall: { key: string; from: number } | null;
  cpFlipped: Set<string>;
}

export class SimPage {
  /** The page as now loaded. */
  p!: Page;
  loads = 0;
  mode: Mode = 'up';
  /** Asleep: whether its doc still hears the room. */
  syncing = true;
  /** What its croupier's room-state check answers: false from a (re)load
   *  until the room's state has come (its first resync). */
  roomIn = true;
  /** No frames until then (a throttled tab), its doc syncing. */
  pauseUntil = 0;
  /** Its bot puts felts down (off for the quiet period). */
  betting = true;
  /** The room's tables as this page knows them (a removal heard takes one). */
  readonly inRoom: Set<string>;
  readonly rand: Rng;
  /** Of this load: what it showed decided (`<t>:<inc>:<r>` → what it showed),
   *  and of every load (what it showed last of each round). */
  shown = new Map<string, Shown>();
  readonly shownAll = new Map<string, Shown>();
  /** Flips this page saw, every load, of each kind, and what they were. */
  flips = 0;
  readonly flipKinds: Partial<Record<FlipKind, number>> = {};
  readonly flipLog: string[] = [];
  /** Run before each of its frames: false skips the frame (a spec's page
   *  that lags or cheats). */
  beforeFrame: ((now: number) => boolean) | null = null;
  /** Its spec writes records itself (a cheat's): the write checks skip it. */
  cheats = false;
  watch = new Map<string, TableWatch>();
  /** Its doc held part of an update (pendingStructs) at the last look. */
  partial = false;
  partialEpisodes = 0;
  /** Transactions of its own that wrote to casinoComputed before the room's
   *  state was in (a violation each). */
  earlyWrites = 0;
  /** Of its bot's presses: writeComputedSlip's answers. */
  readonly writes: Record<string, number> = {};
  /** Its bot has tried a felt of more chips than its player has, and been
   *  answered (bot: once a page, for certain). */
  overTried = false;
  /** Of this load: the timers its modules set (the signature-check slices),
   *  run before its next frames; and how many ran, every load. */
  timers: (() => void)[] = [];
  slices = 0;
  /** Updates it heard that left a count waiting on its checks (computedSettled). */
  pendingHeard = 0;
  /** Times its doc asked the room for what it is missing (bindCasinoDoc's resync). */
  resyncAsks = 0;
  /** Of this load: the hashes of the felts it wrote (its own, as leaveComputedTables
   *  takes down); by `<sesKey>|<record key>`, when each record came into its
   *  doc (its clock, and the room's), and by `<sesKey>|<round>`, the rounds a
   *  record of was written over or deleted after it came. */
  myFelts = new Set<string>();
  arrivals = new Map<string, { at: number; T: number }>();
  touched = new Set<string>();
  /** When it was away or its clock moved (the room's time, every load): a
   *  sleep, gone, a clock step, a frame its croupier counted as a wake. */
  readonly away: [number, number][] = [];
  awayFrom: number | null = null;
  /** Of this load: its last frame its croupier counted as a wake (its clock,
   *  and the room's). Every first-seen time its tables keep starts again
   *  there (computedTable lookAtClock): a timer whose wait spanned it waits
   *  in full from it. */
  restartAt: { at: number; T: number } | null = null;
  /** Of this load: when the room's state came in, and the end of the lapse
   *  after its latest wake (its clock), whichever is later, never earlier
   *  than it was. A close that came by then came, to its tables, all at
   *  once: not one it watched come in (computedTable watchedClose, which
   *  reads from no earlier than this). */
  realFrom = -Infinity;
  /** Of this load, by `<t>|<close>`: the rounds its player was frozen in that
   *  a frame of its, the duties' gates open, read decided by the full set of
   *  reveals (shown at once: what each rests on is kept from then, its
   *  tables' witness copies: computedTable noteWitness). And when a frame of
   *  its last ran with a table's gates shut (the room's time). */
  keptFor = new Set<string>();
  shutAt = -Infinity;
  /** By `<t>:<inc>`: the last decided round and the nets it folded there while
   *  the incarnation was live. */
  readonly lastLive = new Map<string, { u: number; nets: string }>();
  /** Its flips as they happened: the kind, when, the close it now reads and
   *  its frozen bettors, and the writer of the forfeit that dropped a seed (a
   *  forfeit over reveals: the new decider's; an answer: the one it answered). */
  readonly flipEvents: { kind: FlipKind; T: number; close: string; present: string[]; fk?: string }[] = [];
  /** By `<t>:<inc>:<r>`, with backIsBlip: a round that reads otherwise than
   *  it showed, what it showed, and its flips since (blips once it is back). */
  readonly unlike = new Map<string, { shown: Shown; flips: { kind: FlipKind }[] }>();
  /** 🎲 By `<t>:<inc>:<r>`, every load: the rolls it showed that it counted
   *  as paid again ('repaid', once a roll). */
  readonly repaid = new Set<string>();
  /** 🎲 Its leaving second (Sim.leave at a craps table): frames run, its bot
   *  doesn't, and then it is gone. */
  leaving = false;
  /** 🤖 Whether its table's pieces move, and are drawn (a page with the
   *  table UI: computedCrapsSimShooter), for the robot's hold; none: no
   *  pieces. */
  robotMotion: ((t: string) => { moving: boolean; drawn: boolean }) | null = null;
  /** 🤖 Run after its robot frame (a spec's page that sleeps as its robot
   *  waits a frame for its felt). */
  afterRobot: ((now: number) => void) | null = null;

  constructor(readonly spec: PageSpec, readonly device: Device, readonly pid: string, tables: string[], rand: Rng) {
    this.inRoom = new Set(tables);
    this.rand = rand;
  }

  get name(): string { return this.spec.name; }
  get honest(): boolean { return this.spec.honest !== false; }
  get skew(): number { return this.p.skew; }
}

// ── 🌐 The network ───────────────────────────────────────────────────────────

interface Link { delay: [number, number]; loss: number; last: number }
/** An update (`u`), or a heartbeat (`u` null). */
interface Msg { at: number; seq: number; from: SimPage; to: SimPage; u: Uint8Array | null; resync: boolean }

export interface LinkSpec { delay: [number, number]; loss: number }

export class Net {
  private readonly links = new Map<string, Link>();
  private queue: Msg[] = [];
  private seq = 0;
  /** A partition: pages in different groups can't reach each other. */
  groups: string[][] | null = null;
  /** Pages that hear nothing, by name: what is sent to them is lost as it
   *  would arrive, while what they send goes (a downlink stall). */
  readonly deaf = new Set<string>();
  sent = 0;
  lost = 0;
  /** Heartbeats sent, and lost on the way. */
  beats = 0;
  beatsLost = 0;

  /** `beatRand` draws the heartbeats' losses and delays apart from the
   *  updates' (`rand`): the updates go as they would with no heartbeats. */
  constructor(private readonly sim: Sim, readonly rand: Rng, public base: LinkSpec, private readonly beatRand: Rng = rand) {}

  private link(a: SimPage, b: SimPage): Link {
    const key = `${a.name}>${b.name}`;
    let l = this.links.get(key);
    if (!l) this.links.set(key, l = { delay: this.base.delay, loss: this.base.loss, last: 0 });
    return l;
  }

  /** The link from a to b: its delay and loss from now on. */
  setLink(a: SimPage, b: SimPage, spec: Partial<LinkSpec>): void {
    const l = this.link(a, b);
    if (spec.delay) l.delay = spec.delay;
    if (spec.loss !== undefined) l.loss = spec.loss;
  }

  /** Every link back to the run's own (a heal). */
  reset(): void {
    for (const l of this.links.values()) {
      l.delay = this.base.delay;
      l.loss = this.base.loss;
    }
    this.groups = null;
    this.deaf.clear();
  }

  connected(p: SimPage): boolean {
    return p.mode === 'up' || (p.mode === 'asleep' && p.syncing);
  }

  /** 🎲 Nothing is lost or cut off, and nothing takes over a second: no
   *  partition, no deaf page, every link lossless and quick. */
  clean(): boolean {
    const quick = (l: { delay: [number, number]; loss: number }): boolean => l.loss === 0 && l.delay[1] <= 1_000;
    return this.groups === null && this.deaf.size === 0 && quick(this.base) && [...this.links.values()].every(quick);
  }

  apart(a: SimPage, b: SimPage): boolean {
    if (!this.groups) return false;
    const g = (p: SimPage) => this.groups!.findIndex((names) => names.includes(p.name));
    return g(a) !== g(b);
  }

  linked(a: SimPage, b: SimPage): boolean {
    return a !== b && this.connected(a) && this.connected(b) && !this.apart(a, b);
  }

  /** Whether page a can reach page b now (itself always). */
  reach(a: SimPage, b: SimPage): boolean {
    return a === b || this.linked(a, b);
  }

  private enqueue(from: SimPage, to: SimPage, u: Uint8Array | null, resync: boolean, lossy: boolean): void {
    const l = this.link(from, to);
    const rand = u ? this.rand : this.beatRand;
    if (lossy && rand() < l.loss) {
      if (u) this.lost++;
      else this.beatsLost++;
      return;
    }
    const delay = l.delay[0] + rand() * (l.delay[1] - l.delay[0]);
    // First in, first out on each link; a heartbeat waits for nothing.
    const at = u ? Math.max(this.sim.T + delay, l.last) : this.sim.T + delay;
    if (u) l.last = at;
    const msg: Msg = { at, seq: this.seq++, from, to, u, resync };
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1].at > at)) i--;
    this.queue.splice(i, 0, msg);
    if (u) this.sent++;
    else this.beats++;
  }

  /** An update page `from` wrote: to every page it is linked to. */
  send(from: SimPage, u: Uint8Array): void {
    for (const to of this.sim.pages) if (this.linked(from, to)) this.enqueue(from, to, u, false, true);
  }

  /** What `from` holds that `to` lacks, on their link. */
  private diff(from: SimPage, to: SimPage, lossy: boolean): void {
    const u = Y.encodeStateAsUpdate(from.p.doc, Y.encodeStateVector(to.p.doc));
    this.enqueue(from, to, u, true, lossy);
  }

  /** Each up page's heartbeat to every page it is linked to (HEARTBEATS). */
  beat(): void {
    for (const from of this.sim.pages) {
      if (from.mode !== 'up') continue;
      for (const to of this.sim.pages) if (this.linked(from, to)) this.enqueue(from, to, null, false, true);
    }
  }

  /** The 5 s resync: each linked pair, each way. */
  resync(): void {
    for (const a of this.sim.pages) for (const b of this.sim.pages) if (this.linked(a, b)) this.diff(a, b, true);
  }

  /** Pages whose doc asked the room for what it is missing (casinoDoc's
   *  resync callback), answered on the next tick: what each linked peer holds
   *  that it lacks. */
  private asks = new Set<SimPage>();

  ask(p: SimPage): void {
    p.resyncAsks += 1;
    this.asks.add(p);
  }

  answerAsks(): void {
    for (const p of this.asks) for (const q of this.sim.pages) if (this.linked(q, p)) this.diff(q, p, true);
    this.asks.clear();
  }

  /** Page p comes online: its handshake with every page it reaches, each way. */
  connect(p: SimPage): void {
    for (const q of this.sim.pages) {
      if (!this.linked(p, q)) continue;
      this.diff(q, p, false);
      this.diff(p, q, false);
    }
  }

  /** 🎲 Page p, loaded again, hears its device's node: what `was` (its last
   *  load's doc, all of it sent to that node) holds that p's doc lacks, as
   *  a handshake (lossless, a link's delay). */
  handshakeFrom(p: SimPage, was: Y.Doc): void {
    const u = Y.encodeStateAsUpdate(was, Y.encodeStateVector(p.p.doc));
    this.enqueue(p, p, u, true, false);
  }

  /** Hand on what is due by `T` (everything, with `all`), to pages that still
   *  hear the room, aren't deaf and aren't cut off from the sender. */
  async deliver(T: number, all = false): Promise<void> {
    while (this.queue.length > 0 && (all || this.queue[0].at <= T)) {
      const m = this.queue.shift()!;
      if (!this.connected(m.to) || this.apart(m.from, m.to) || this.deaf.has(m.to.name)) continue;
      if (m.u) await this.sim.hear(m.to, m.u, m.resync);
      else this.sim.heardBeat(m.to);
    }
  }

  get inFlight(): number {
    return this.queue.length;
  }
}

// ── 🧮 Counting a page's doc cold ────────────────────────────────────────────

interface Cold {
  /** By `<t>:<inc>`: the fold of every incarnation the doc holds. */
  folds: Map<string, { ctx: FoldCtx; cp: Checkpoint | null; res: FoldResult; live: boolean }>;
  nets: Map<string, bigint>;
  held: Map<string, bigint>;
}

/** The incarnation a casinoComputed key is of, as casinoDoc parses it. */
function incOfKey(key: string): { t: string; inc: string } | null {
  let rest: string;
  if (key.startsWith('ses:')) {
    const cut = key.lastIndexOf(':');
    if (!COMPUTED_SID.test(key.slice(cut + 1))) return null;
    rest = key.slice('ses:'.length, cut);
  } else if (key.startsWith('sum:')) {
    rest = key.slice('sum:'.length);
  } else {
    return null;
  }
  const cut = rest.lastIndexOf(':');
  const inc = rest.slice(cut + 1);
  return cut > 0 && COMPUTED_INC.test(inc) ? { t: rest.slice(0, cut), inc } : null;
}

const addTo = (m: Map<string, bigint>, from: ReadonlyMap<string, bigint>): void => {
  for (const [pid, n] of from) m.set(pid, (m.get(pid) ?? 0n) + n);
};

// ── 📊 What a run measured ───────────────────────────────────────────────────

export interface SimSummary {
  name: string;
  seed: number;
  minutes: number;
  pages: number;
  /** Σ over incarnations of the last decided round on the final chain. */
  rounds: number;
  /** Rounds seen decided, by how (each incarnation's rounds, once each). */
  byReveals: number;
  byForfeit: number;
  /** 🏠 …by a house reveal (a Fair round). */
  byHouse: number;
  voids: number;
  flips: Record<string, number>;
  flipKinds: Partial<Record<FlipKind, number>>;
  trims: number;
  maxDocBytes: number;
  maxSessionBytes: number;
  maxPreTrimBytes: number;
  maxRoundBytes: number;
  worstStallMs: number;
  /** CPU time (this process's, user + system): what the page's own work
   *  costs, whatever else the machine runs. And the wall clock's, as seen. */
  coldFoldMs: number;
  coldFoldWallMs: number;
  warmP50Ms: number;
  warmP95Ms: number;
  warmMaxMs: number;
  warmWallP95Ms: number;
  partialEpisodes: number;
  /** Signature-check slices run, and resyncs the docs asked for. */
  slices: number;
  resyncAsks: number;
  /** Decided rounds whose deltas and pocket were worked out afresh,
   *  forfeits checked against the seeds that truly came in their grace, and
   *  abandons against their wait (checkOwnAbandons). */
  roundsChecked: number;
  forfeitsChecked: number;
  abandonsChecked: number;
  writes: Record<string, number>;
  lost: number;
}

export interface SimOptions {
  name: string;
  seed: number;
  pages: PageSpec[];
  /** The room's computed tables (default one roulette table). */
  tables?: TableSpec[];
  link?: LinkSpec;
  bot?: BotSpec;
  /** 🎲 Every page's craps bot unless its spec gives one (default CRAPS_BOT). */
  crapsBot?: CrapsBotSpec;
  /** Each page's skew, when its spec gives none: drawn within ±this (ms). */
  skewMs?: number;
  /** A round a page showed that reads otherwise for a while, then as shown
   *  again, is a blip, whatever it read meanwhile (its flips are counted
   *  as blips once it is back): a delete's (pr2-pr-notes.md lever 8: what
   *  a decided round rests on goes back, and the round with it). */
  backIsBlip?: boolean;
  /** 🏠 The owner's node as the room's house (computedSimHouse): the house's
   *  page holds the room's deed and delegates the node's key; the node joins,
   *  reveals and beats through that page's doc (nodeUp: it runs). */
  houseNode?: boolean;
}

/** ms for which no per-tick bookkeeping runs (a spec's own loop may). */
export class Sim {
  T = SIM_T0;
  readonly pages: SimPage[] = [];
  readonly devices = new Map<string, Device>();
  readonly net: Net;
  /** The room's tables, by id, and each one's game. */
  readonly tables: string[];
  readonly games = new Map<string, GameName>();
  /** 🎲 The craps side of the run (bots, checker, oracles), with any craps
   *  table in the room; null in a roulette room, which then runs as it
   *  always did (no draw, import or check of craps's). */
  readonly craps: CrapsHarness | null;
  /** Every checkpoint the room's docs have held (canon): one written again
   *  is a restore (checkOwnTrims). */
  private readonly sumsSeen = new Set<string>();
  readonly rand: Rng;
  /** The house's page: it switched the tables on, and drives them. */
  house!: SimPage;
  /** 🤖 The robot at the players' tables, watched on every page's frame. */
  readonly robots: RobotWatch = new RobotWatch(this);
  /** 🏠 The owner's node as the house (houseNode), and whether it runs; and
   *  the load of the house's page it last told its key to. */
  readonly node: SimHouse | null;
  nodeUp = true;
  private nodeOn: Page | null = null;
  /** What broke an invariant while it ran (empty when all held). */
  readonly violations: string[] = [];
  private readonly entropy: Rng;
  private events: { at: number; fn: () => void | Promise<void> }[] = [];
  private readonly hooks: ((T: number) => void | Promise<void>)[] = [];
  private nextClient = 1;
  private verdicts = new Map<string, boolean>();
  // Measurements.
  readonly decisions = new Map<string, string>();
  /** Every decided close any page folded (hash → its round, its parent, how
   *  it was decided last), and every checkpoint (by `<t>:<inc>:<the sid it
   *  opens>`): the chain a trim took out of the session, for 'split'. */
  private readonly closes = new Map<string, { r: number; q: string; shown: Shown }>();
  private readonly cps = new Map<string, Checkpoint>();
  readonly sids = new Map<string, Set<string>>();
  maxDocBytes = 0;
  maxSessionBytes = 0;
  maxPreTrimBytes = 0;
  maxRoundBytes = 0;
  worstStall = { ms: 0, at: '' };
  /** 🎲 At craps tables: the worst stall with no close in (felts) and with
   *  a close in waiting on its seeds (tip). */
  readonly worstStallBy = { felts: { ms: 0, at: '' }, tip: { ms: 0, at: '' } };
  /** Each warm transaction's CPU time, and its wall time. */
  readonly warm: number[] = [];
  readonly warmWall: number[] = [];
  /** The chips every player bought (buyIn): what the cage issued. */
  readonly bought = new Map<string, bigint>();
  /** Decided rounds worked out afresh (by close, decision and count), and the
   *  pocket checks under way (awaited at the end of each tick; at craps the
   *  dice checks too). */
  readonly checkedRounds = new Set<string>();
  readonly pocketChecks: Promise<void>[] = [];
  forfeitsChecked = 0;
  abandonsChecked = 0;
  /** When any page first held each close (the room's time). */
  private readonly closeAt = new Map<string, number>();
  /** Players of one page each whose chips read below 0 before the clamp. */
  readonly debts = new Map<string, string>();
  /** Chips an owner-run roll a scenario plays settled for good, by player
   *  (an older build's paid roll: its own chip records, and the house's net,
   *  count them; cageProblems), and what a removal or sweep refunded of a
   *  list an earlier build took whole (its `end:` record). */
  readonly ownerRunPaid = new Map<string, bigint>();
  /** Chips an earlier build's buy-in issued, by player, as that build keeps
   *  them: counts in the casino map (`bought:<pid>`, `bal:<pid>`), not chip
   *  records. They are in `bought` too (the cage issued them); a list that
   *  build puts down takes its stake off `bal:` (casinoDoc's legacy count,
   *  part of every player's ledger total: ledgerProblems, cageProblems). */
  readonly legacyBought = new Map<string, bigint>();
  /** The heal has run: the scenarios' disturbances stop. */
  healed = false;
  /** The heaviest live session seen, to fold cold at the end (coldFoldMs). */
  private biggest: { bytes: number; ctx: FoldCtx; cp: Checkpoint | null; entries: [string, unknown][]; keyOf: (pid: string) => string | undefined } | null = null;

  private constructor(readonly opts: SimOptions) {
    this.rand = simRng(opts.seed);
    this.entropy = simRng(opts.seed ^ 0x5eed5eed);
    const specs = opts.tables ?? ['roulette-1'];
    this.tables = specs.map((s) => (typeof s === 'string' ? s : s.id));
    for (const s of specs) this.games.set(typeof s === 'string' ? s : s.id, typeof s === 'string' ? 'roulette' : s.game);
    this.craps = [...this.games.values()].includes('craps') ? new CrapsHarness(this) : null;
    this.net = new Net(this, simRng(opts.seed ^ 0x0e7), opts.link ?? { delay: [40, 150], loss: 0 }, simRng(opts.seed ^ 0xbea7));
    this.node = opts.houseNode ? new SimHouse(sha256(utf8ToBytes(`sim-house-node|${opts.seed}`))) : null;
  }

  /** Table t's game. */
  gameOf(t: string): GameName {
    return this.games.get(t) ?? 'roulette';
  }

  /** The room's tables as World passes them to the computed duties: a bare
   *  id for a roulette table (as it always passed them), {id, game} for a
   *  craps one. */
  private refsOf(tables: string[]): (string | { id: string; game: GameName })[] | string[] {
    return this.craps ? tables.map((t) => (this.gameOf(t) === 'craps' ? { id: t, game: 'craps' as const } : t)) : tables;
  }

  /** "<name> seed=<n>": every failure message carries it, to replay the run. */
  get label(): string {
    return `${this.opts.name} seed=${this.opts.seed}`;
  }

  /** The room's pages loaded, their chips bought, the house's switch on, all
   *  synced at the start. */
  static async open(opts: SimOptions): Promise<Sim> {
    const sim = new Sim(opts);
    vi.stubGlobal('localStorage', simStorage);
    timersOf = null;
    vi.stubGlobal('setTimeout', simSetTimeout);
    // Slip seeds (fairDice randomSeedHex) and anything else drawing bytes:
    // from the run's seed, so a run replays.
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(buf: T): T => {
      if (buf) {
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(sim.entropy() * 256);
      }
      return buf;
    });
    vi.setSystemTime(sim.T);
    for (const spec of opts.pages) await sim.add(spec, { connect: false });
    const house = sim.house = sim.pages.find((sp) => sp.spec.house) ?? sim.pages[0];
    // 🏠 With a node, the house's page holds the room's deed.
    if (sim.node) await sim.as(house, () => house.p.doc.getMap('roomInfo').set('owner', house.pid));
    for (const t of sim.tables) {
      const now = sim.enter(house);
      house.p.table.setComputedTablesEnabledForTests(true);
      const ok = house.p.table.switchComputedOn(t, sim.gameOf(t), now);
      if (ok !== 'ok') throw new Error(`${sim.label}: the house's switch-on of ${t} answered ${ok}`);
    }
    await sim.syncAll();
    // (A page loaded after another missed what that one wrote before it came:
    // held back until the sync just now, which is the start, not the run.)
    for (const sp of sim.pages) sp.partialEpisodes = 0;
    sim.warm.length = 0;
    sim.warmWall.length = 0;
    return sim;
  }

  // ── Pages ──

  /** Page sp's clock now, set as the system time, its device's storage as
   *  localStorage, its timers its own. */
  enter(sp: SimPage): number {
    device = sp.device;
    timersOf = sp;
    const now = this.T + sp.p.skew;
    vi.setSystemTime(now);
    return now;
  }

  /** Run up to `max` of page sp's timers (in the order set; one a timer sets
   *  waits for the next call). */
  private async runTimers(sp: SimPage, max: number): Promise<void> {
    for (const fn of sp.timers.splice(0, max)) {
      sp.slices += 1;
      await this.as(sp, () => fn());
    }
  }

  /** Every chip bought, by the page's own buy-in: what the cage must read
   *  as issued. */
  buyIn(sp: SimPage, pid: string, amount: number): void {
    sp.p.casino.buyInChips(pid, amount);
    this.bought.set(pid, (this.bought.get(pid) ?? 0n) + BigInt(amount));
  }

  /** Page sp was away (or its clock moved) from `from` to now. */
  private wasAway(sp: SimPage, from = this.T): void {
    sp.away.push([from, this.T]);
  }

  /** Run `act` as page sp, then let what it queued (microtasks) run as sp too.
   *  `act` runs wholly as sp: one that enters another page on the way (a
   *  helper that reads another page's fold) would have sp's next writes made
   *  on that page's clock, device and timers, which no real page can do; so
   *  it is a harness error, thrown at once. */
  async as<R>(sp: SimPage, act: (now: number) => R): Promise<R> {
    const now = this.enter(sp);
    const out = act(now);
    if (timersOf !== sp || device !== sp.device) {
      throw new Error(`${this.label}: a step run as ${sp.name} at ${this.elapsed} ms entered ${timersOf?.name ?? 'no page'} on the way`);
    }
    await Promise.resolve();
    await Promise.resolve();
    return out;
  }

  private deviceOf(spec: PageSpec): Device {
    const name = spec.device ?? spec.name;
    let d = this.devices.get(name);
    if (!d) this.devices.set(name, d = new Device(name, this.opts.seed));
    return d;
  }

  private skewOf(spec: PageSpec): number {
    if (spec.skew !== undefined) return spec.skew;
    const w = this.opts.skewMs ?? 5_000;
    return Math.round((this.rand() * 2 - 1) * w);
  }

  /** Load a page (`connect`: it comes online at once, its handshake sent). */
  async add(spec: PageSpec, opts: { connect?: boolean } = {}): Promise<SimPage> {
    const dev = this.deviceOf(spec);
    const pid = spec.pid ?? `player-${spec.name}`;
    const sp = new SimPage(spec, dev, pid, this.tables, simRng(this.opts.seed * 31 + this.pages.length + 1));
    // (One joining a room under way waits for the room's state; the room's
    // first pages start with it, at the opening sync.)
    sp.roomIn = opts.connect === false;
    await this.load(sp, spec, this.skewOf(spec));
    this.pages.push(sp);
    if (opts.connect !== false) this.net.connect(sp);
    return sp;
  }

  private async load(sp: SimPage, spec: PageSpec, skew: number, reloadOf?: Page, cache?: Uint8Array): Promise<void> {
    device = sp.device;
    timersOf = null;
    vi.setSystemTime(this.T + skew);
    let page: Page | null = null;
    const p = await loadPage(spec.name, this.nextClient++, {
      skew, pid: sp.pid, ...(reloadOf ? { reloadOf } : {}),
      resync: () => {
        if (page && sp.p === page) this.net.ask(sp);
      },
      verify: { now: verifyClock(), budgetMs: VERIFY_BUDGET_MS },
      hears: true,
    });
    page = p;
    sp.p = p;
    if (spec.onLoad) await spec.onLoad(p);
    // 🎲 This load's craps modules, imported now (this load's generation,
    // before another page's load resets the modules): crapsCroupier for the
    // house's stickman tick.
    if (this.craps) await this.craps.loaded(sp);
    sp.loads += 1;
    sp.shown = new Map();
    sp.watch = new Map();
    sp.partial = false;
    sp.timers = [];
    sp.myFelts = new Set();
    sp.arrivals = new Map();
    sp.touched = new Set();
    sp.restartAt = null;
    sp.unlike.clear();
    sp.realFrom = -Infinity;
    sp.keptFor = new Set();
    sp.shutAt = this.T;
    p.croupier.setRoomStateArrivedCheck(() => sp.roomIn);
    p.croupier.setTableInRoomPredicate((t) => sp.inRoom.has(t));
    if (cache) await this.as(sp, () => Y.applyUpdate(p.doc, cache, NET));
    p.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === NET || sp.p !== p) return;
      this.net.send(sp, u);
    });
    // (What it wrote as it loaded, its players entry, goes first: the
    // updates after it rest on it.)
    this.net.send(sp, Y.encodeStateAsUpdate(p.doc));
    // Nothing computed is written before the room's state is in: the doc may
    // be the room cache's copy, and a seed revealed for a close the room has
    // since dropped is a seed out for nothing (computedTable tickTable). Nor,
    // while the doc holds part of an update, anything but a reveal (the one
    // duty that needs only the room's state): what it read may be missing
    // the part (casinoWhole).
    const computed = p.doc.getMap('casinoComputed');
    // Each record's arrival in the doc, as casinoDoc would stamp it; and of
    // this page's own transactions, the folds before (what its duties read).
    let pre: Map<string, { inc: string | null; res: FoldResult | null }> | null = null;
    let behind = false;
    p.doc.on('beforeTransaction', (tr: Y.Transaction) => {
      pre = tr.origin === NET || sp.p !== p ? null : this.foldsNow(sp);
      // 🎲 At craps the folds its own write starts from, walked by the
      // checker (a trim's: the rolls it takes out of the session are played
      // as the trimmer had them, so its checkpoint is held to them).
      if (pre && this.craps) {
        for (const [t, w] of pre) if (w.res && w.inc && gameOfInc(w.inc) === 'craps') this.craps.check(sp, this.ctxOf(t, w.inc), w.res, false);
      }
    });
    p.doc.on('afterTransaction', (tr: Y.Transaction) => {
      const was = pre;
      pre = null;
      if (sp.p !== p) return;
      const partial = (p.doc.store as unknown as { pendingStructs: unknown }).pendingStructs !== null;
      behind = this.logArrivals(sp, tr, computed, partial, behind);
      if (was) {
        if (!sp.cheats) this.checkOwnTrims(sp, tr, computed, was);
        this.checkOwnForfeits(sp, tr, computed, was);
        this.checkOwnAbandons(sp, tr, computed, was);
        if (this.craps) this.craps.ownWrite(sp, tr, computed, was);
      }
      const top = tr.changed.get(computed as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>);
      for (const k of top ?? []) if (k?.startsWith('sum:')) this.sumsSeen.add(canon(computed.get(k)) ?? '');
    });
    p.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.origin === NET || tr.origin === HOUSE_ORIGIN || sp.p !== p || sp.cheats) return;
      const partial = (p.doc.store as unknown as { pendingStructs: unknown }).pendingStructs !== null;
      if (sp.roomIn && !partial) return;
      for (const [type, keys] of tr.changed) {
        let root = type as Y.AbstractType<unknown>;
        while (root._item && root._item.parent instanceof Y.AbstractType) root = root._item.parent as Y.AbstractType<unknown>;
        if (root !== (computed as unknown)) continue;
        if (!sp.roomIn) {
          sp.earlyWrites += 1;
          this.violate(`${sp.name} wrote to casinoComputed at ${this.elapsed} ms, before the room's state was in`);
          return;
        }
        const written = [...keys].filter((k): k is string => k !== null && (type === (computed as unknown) || !k.startsWith('x:')));
        if (written.length > 0) {
          this.violate(`${sp.name} wrote ${written.join(', ')} at ${this.elapsed} ms, its doc holding part of an update`);
          return;
        }
      }
    });
    await this.as(sp, (now) => {
      if (!reloadOf && spec.chips !== 0) this.buyIn(sp, sp.pid, spec.chips ?? 1_000);
      this.sit(sp, now);
    });
  }

  /** Each table's incarnation and fold on page sp now. */
  private foldsNow(sp: SimPage): Map<string, { inc: string | null; res: FoldResult | null }> {
    const { casino } = sp.p;
    return new Map(this.tables.map((t) => [t, { inc: casino.computedIncOf(t), res: casino.computedFoldOf(t) }]));
  }

  /** What came into page sp's doc with transaction tr: when each session
   *  record first stood in the doc whole (casinoDoc stamps it then: what came
   *  while the doc held part of an update, when the rest came), of every
   *  session map (one new to the doc, all its records). A record written over
   *  or deleted once it came marks its round touched. Whether the log is
   *  behind (the doc holding part of an update). */
  private logArrivals(sp: SimPage, tr: Y.Transaction, computed: Y.Map<unknown>, partial: boolean, behind: boolean): boolean {
    const at = { at: Date.now(), T: this.T };
    const log = (sesKey: string, ses: Y.Map<unknown>, keys: Iterable<string | null>): void => {
      for (const k of keys) {
        if (k === null) continue;
        const id = `${sesKey}|${k}`;
        if (sp.arrivals.has(id) || !ses.has(k)) {
          const pk = parseKey(k);
          if (pk) sp.touched.add(`${sesKey}|${pk.r}`);
        } else if (!partial) {
          sp.arrivals.set(id, at);
        }
      }
    };
    if (!partial && behind) {
      for (const [k, ses] of computed.entries()) if (k.startsWith('ses:') && ses instanceof Y.Map) log(k, ses, [...ses.keys()].filter((x) => !sp.arrivals.has(`${k}|${x}`)));
    }
    for (const [type, keys] of tr.changed) {
      if (type === (computed as unknown)) {
        for (const k of keys) {
          const ses = k?.startsWith('ses:') ? computed.get(k) : undefined;
          if (ses instanceof Y.Map) log(k!, ses, [...ses.keys()].filter((x) => !sp.arrivals.has(`${k}|${x}`)));
        }
        continue;
      }
      const item = (type as Y.AbstractType<unknown>)._item;
      if (!item || item.parent !== (computed as unknown) || typeof item.parentSub !== 'string') continue;
      log(item.parentSub, type as unknown as Y.Map<unknown>, keys);
    }
    return partial;
  }

  /** A trim page sp wrote (its own transaction tr; `was`, each table's fold
   *  before it) moves no player's nets, nor what anyone's felt holds, but
   *  for a felt whose seed is out (a burned commitment: left behind, its
   *  hold released). And the felts it writes are its own (leave). */
  private checkOwnTrims(sp: SimPage, tr: Y.Transaction, computed: Y.Map<unknown>, was: Map<string, { inc: string | null; res: FoldResult | null }>): void {
    const { casino } = sp.p;
    for (const [type, keys] of tr.changed) {
      if (type === (computed as unknown)) continue;
      const item = (type as Y.AbstractType<unknown>)._item;
      if (!item || item.parent !== (computed as unknown)) continue;
      for (const k of keys) {
        const pk = k === null ? null : parseKey(k);
        if (pk?.kind === 's' && pk.pid === sp.pid && (type as unknown as Y.Map<unknown>).has(k!)) sp.myFelts.add(pk.h);
      }
    }
    const top = tr.changed.get(computed as unknown as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>);
    if (!top || ![...top].some((k) => k?.startsWith('sum:'))) return;
    for (const [t, w] of was) {
      const res = casino.computedFoldOf(t);
      if (!w.res || !res || w.inc !== casino.computedIncOf(t) || w.res.base.sid === res.base.sid) continue;
      // (A restore puts back a checkpoint the room held before, over a
      // peer's: it moves the nets back to the head's, as the scenario that
      // forges one checks. No trim writes one again.)
      if (this.sumsSeen.has(canon(computed.get(`sum:${t}:${w.inc}`)) ?? '')) continue;
      if (netsText(w.res.nets) !== netsText(res.nets)) this.violate(`${sp.name}'s trim of ${t} at ${this.elapsed} ms moved nets ${netsText(w.res.nets)} → ${netsText(res.nets)}`);
      // (The final checkpoint of an incarnation an end mark ended while its
      // switch still names it hands on no table and holds nothing: every
      // hold and the carry go, by design, but the nets stay; checkEnded
      // holds them to the checker's own.)
      if (res.base.ended) continue;
      const burned = new Set([...w.res.felts.values()].filter((s) => w.res!.revealedCommits.has(s.rec.c)).map((s) => s.rec.p));
      const unburned = (m: ReadonlyMap<string, bigint>): Map<string, bigint> => new Map([...m].filter(([pid]) => !burned.has(pid)));
      if (netsText(unburned(w.res.held)) !== netsText(unburned(res.held))) this.violate(`${sp.name}'s trim of ${t} at ${this.elapsed} ms moved holds ${netsText(w.res.held)} → ${netsText(res.held)}`);
      // 🎲 And at craps the table it hands on: the point, every bet riding,
      // the dice's holder (the checkpoint's `s`), as the fold had it.
      if (this.craps && this.gameOf(t) === 'craps') this.craps.checkTrimCarry(sp, t, w.res, res);
    }
  }

  /** A forfeit page sp wrote (its own transaction tr), against the seeds that
   *  came into its doc in the grace, by their arrivals (logArrivals): the
   *  frozen bettors whose seed came by the close's arrival plus the grace
   *  (REVEAL_GRACE_MS, stretched by each seed inside it to GRACE_PAD_MS past
   *  it, GRACE_MAX_MS at most) and its own player; an answer, the forfeit's
   *  count and the seeds it dropped that came by then. Not where the page's
   *  times aren't the arrivals (its clock moved, a wake, away, from before
   *  this load), nor for a round a record of was written over or deleted —
   *  but never of a round it showed decided by the reveals that reads
   *  undecided only as what it rests on is gone (keptFor), and an answer or
   *  a void's forfeit only of a close it watched come in (realFrom). */
  private checkOwnForfeits(sp: SimPage, tr: Y.Transaction, computed: Y.Map<unknown>, was: Map<string, { inc: string | null; res: FoldResult | null }>): void {
    if (!sp.honest || sp.cheats) return;
    const { casino, pub, table } = sp.p;
    for (const [type, keys] of tr.changed) {
      const item = (type as Y.AbstractType<unknown>)._item;
      if (!item || item.parent !== (computed as unknown) || typeof item.parentSub !== 'string') continue;
      const sesKey = item.parentSub;
      const ses = type as unknown as Y.Map<unknown>;
      for (const k of keys) {
        if (k === null || !k.startsWith('f:') || !ses.has(k)) continue;
        const F = ses.get(k) as { r: number; x: string; n: string[]; k: string };
        if (F.k !== pub) continue;
        const t = this.tables.find((x) => casino.computedSessionForWrite(x) === ses);
        const w = t === undefined ? undefined : was.get(t);
        const round = w?.res && w.inc === casino.computedIncOf(t!) ? w.res.rounds.find((v) => v.close === F.x) : undefined;
        // 🏠 A Fair round is the house's to decide: no page forfeits it.
        const fairClose = ses.get(`c:${F.r}:${F.x}`) as { h?: unknown } | undefined;
        if (fairClose?.h !== undefined) {
          this.violate(`${sp.name} forfeited ${t} round ${F.r} at ${this.elapsed} ms, a Fair round (its close names the house's commitment)`);
          continue;
        }
        // Not of a round it showed decided by the reveals that reads
        // undecided only as a peer took away what it rests on (its tables
        // keep a copy of it, and it goes back: computedTable heldBack).
        if (round && round.decided === null && sp.keptFor.has(`${t}|${F.x}`)) {
          this.violate(`${sp.name} forfeited ${t} round ${round.r} at ${this.elapsed} ms, a round it showed decided by the reveals that reads undecided only as a record it rests on is gone`);
          continue;
        }
        const closeIn = sp.arrivals.get(`${sesKey}|c:${F.r}:${F.x}`);
        if (!round || !closeIn || sp.touched.has(`${sesKey}|${F.r}`)) continue;
        // An answer, or the forfeit of a void, only of a close it watched come
        // in: not one that came before the lapse after its last wake ended.
        const F0 = round.decided === 'forfeit' && round.forfeit && round.forfeit.rec.k !== pub ? round.forfeit.rec : null;
        if ((F0 || round.decided === 'void') && closeIn.at <= sp.realFrom) {
          this.violate(`${sp.name}'s forfeit of ${t} round ${round.r} (${round.decided}) at ${this.elapsed} ms, of a close that came ${sp.realFrom - closeIn.at} ms before the lapse after its last wake ended`);
          continue;
        }
        if (sp.away.some(([a, b]) => b >= closeIn.T - SIM_STEP && a <= this.T)) continue;
        const ctx: FoldCtx = { room: PAGE_ROOM, t: t!, inc: w!.inc! };
        const times = new Map<string, number>();
        for (const pid of round.present) {
          const slip = ses.get(`s:${round.r}:${pid}:${round.frozen[pid]}`) as { c?: unknown } | undefined;
          for (const key of ses.keys()) {
            if (typeof slip?.c !== 'string' || !key.startsWith(`x:${round.r}:${pid}:`)) continue;
            const x = ses.get(key) as { r?: unknown; p?: unknown; s?: unknown } | undefined;
            if (x?.r !== round.r || x.p !== pid || typeof x.s !== 'string' || slipCommit(ctx, round.r, pid, x.s) !== slip.c) continue;
            const came = sp.arrivals.get(`${sesKey}|${key}`);
            if (came) times.set(pid, came.at);
          }
        }
        let grace = table.REVEAL_GRACE_MS;
        for (const at of [...times.values()].sort((a, b) => a - b)) {
          if (at - closeIn.at > grace) break;
          grace = Math.min(table.GRACE_MAX_MS, Math.max(grace, at - closeIn.at + table.GRACE_PAD_MS));
        }
        const until = closeIn.at + grace;
        const inTime = (pid: string): boolean => (times.get(pid) ?? Infinity) <= until;
        const want = F0
          ? [...new Set([...F0.n, ...round.present.filter((pid) => !F0.n.includes(pid) && inTime(pid))])].sort()
          : round.present.filter((pid) => pid === sp.pid || inTime(pid));
        this.forfeitsChecked += 1;
        if (round.decided === 'reveals' || JSON.stringify(F.n) !== JSON.stringify(want)) {
          const came = [...times].map(([pid, at]) => `${pid}+${at - closeIn.at}`).join(' ');
          this.violate(`${sp.name}'s forfeit of ${t} round ${round.r} (${round.decided ?? 'undecided'}) at ${this.elapsed} ms counts ${F.n.join(',')}, the seeds in its grace ${want.join(',')} (grace ${grace} ms; seeds came at ${came})`);
        }
      }
    }
  }

  /** An abandon page sp wrote (its own transaction tr): ABANDON_MS at least
   *  after the close came into its doc (logArrivals), on its clock; and when
   *  its croupier counted a wake since (a sleep, a stop, its clock gone back
   *  or on by a lapse: restartAt), ABANDON_MS at least after that — the wait
   *  spanned it, and starts again (computedTable lookAtClock). */
  private checkOwnAbandons(sp: SimPage, tr: Y.Transaction, computed: Y.Map<unknown>, was: Map<string, { inc: string | null; res: FoldResult | null }>): void {
    if (!sp.honest || sp.cheats) return;
    const { casino, pub, table } = sp.p;
    const now = Date.now();
    for (const [type, keys] of tr.changed) {
      const item = (type as Y.AbstractType<unknown>)._item;
      if (!item || item.parent !== (computed as unknown) || typeof item.parentSub !== 'string') continue;
      const sesKey = item.parentSub;
      const ses = type as unknown as Y.Map<unknown>;
      for (const k of keys) {
        if (k === null || !k.startsWith('z:') || !ses.has(k)) continue;
        const z = ses.get(k) as { r: number; x: string; k: string };
        if (z.k !== pub) continue;
        const closeIn = sp.arrivals.get(`${sesKey}|c:${z.r}:${z.x}`);
        if (!closeIn) continue;
        // (Its first look since the wake reads the close as come then, or
        // later: a clock gone back reads a stamp ahead of it as now.)
        const restart = sp.restartAt !== null && sp.restartAt.T >= closeIn.T ? sp.restartAt : null;
        const from = restart ? restart.at : closeIn.at;
        // 🏠 A Fair round's, while this page hasn't heard the house for
        // HOUSE_HEARD_MS: that long (computedTable abandonWait), unless the
        // house's reveal of the close was in, as the fold the page's duty
        // read counted it (verified, a house's: houseWaits), waiting on a
        // seed this page lacked: then the full ABANDON_MS.
        const fair = (ses.get(`c:${z.r}:${z.x}`) as { h?: unknown } | undefined)?.h !== undefined;
        const t = this.tables.find((x) => casino.computedSessionForWrite(x) === ses);
        const w = t === undefined ? undefined : was.get(t);
        const round = w?.res && w.inc === casino.computedIncOf(t!) ? w.res.rounds.find((v) => v.close === z.x) : undefined;
        const wait = fair && !casino.houseOnline(now) && round?.houseWaits === undefined ? HOUSE_HEARD_MS : table.ABANDON_MS;
        this.abandonsChecked += 1;
        if (now < from + wait) {
          this.violate(`${sp.name}'s abandon of round ${z.r} at ${this.elapsed} ms came ${now - closeIn.at} ms after the close came`
            + `${restart ? ` and ${now - restart.at} ms after it woke (at ${restart.T - SIM_T0} ms)` : ''}, before its wait (${wait} ms${fair ? ', a Fair round' : ''})`);
        }
      }
    }
  }

  /** A player's page (its bot's) at the room's tables: its seat at each, as
   *  the table's UI beats it while the player is there (casinoTableSession,
   *  every 5 s: a seat a switch-on or a removal cleared comes back). */
  private sit(sp: SimPage, now: number): void {
    if (sp.spec.bot === null) return;
    for (const [i, t] of this.tables.entries()) {
      if (!sp.inRoom.has(t)) continue;
      // 🎲 At craps where its player is (computedCrapsSim): the stand
      // page-local, marked again on every load, and the seat record beaten.
      if (this.craps && this.gameOf(t) === 'craps') this.craps.sit(sp, t, now);
      else sp.p.casino.writeMySeat(t, sp.pid, { stand: (this.pages.indexOf(sp) + 1 + i) % 8, angle: 0, at: now });
    }
  }

  /** Page sp loaded again (a reload, or coming back on the same profile):
   *  fresh modules and doc, its key and seed store kept; the room's state
   *  comes over the network. With `cache`, its doc starts from that (the
   *  room cache from before it left), and it waits for the room's state
   *  before it acts (roomStateIn). */
  async reload(sp: SimPage, opts: { cache?: Uint8Array; goodbye?: boolean } = {}): Promise<void> {
    // 🎲 A real reload fires pagehide, which says goodbye at a craps table
    // (leaveComputedTables, held to the goodbye oracle); without, it is a
    // crash and then a load.
    if (opts.goodbye && this.craps && sp.mode === 'up') await this.craps.goodbye(sp);
    if (sp.mode !== 'gone') sp.awayFrom = this.T;
    const was = sp.p.doc;
    sp.mode = 'gone';
    sp.leaving = false;
    sp.roomIn = false;
    await this.load(sp, sp.spec, sp.p.skew, sp.p, opts.cache);
    sp.mode = 'up';
    sp.syncing = true;
    sp.pauseUntil = 0;
    this.wasAway(sp, sp.awayFrom ?? this.T);
    sp.awayFrom = null;
    this.net.connect(sp);
    // 🎲 A page talks to the room through its device's own node, which holds
    // a replica of the room's doc: every update the page sent went to it
    // first (YjsSync: the node applies it, fans it out to the device's other
    // tabs and relays it to the mesh). So a page loaded again on the same
    // device has, in its handshake with that node, everything its last load
    // wrote, its pagehide goodbye included, not only what the other pages
    // have heard of it so far (an update of its still on its way to them
    // would otherwise reach the new load only by the next resync). Only in
    // a room with a craps table: roulette's runs stay as they were.
    if (this.craps) this.net.handshakeFrom(sp, was);
  }

  /** Page sp leaves the room as main.ts leaves it: its felts down
   *  (leaveComputedTables), its seats cleared, then gone. A felt it wrote
   *  (this load's), on a round taking bets, on a doc it may write from, is
   *  down as it goes. */
  async leave(sp: SimPage): Promise<void> {
    await this.as(sp, (now) => {
      const { casino, croupier, table } = sp.p;
      const able = croupier.tablesAwake(now) && casino.casinoWhole() && casino.computedSettled();
      const mine = (t: string): boolean => {
        const felt = casino.computedFoldOf(t)?.felts.get(sp.pid);
        return felt !== undefined && felt.rec.b.length > 0 && sp.myFelts.has(felt.hash);
      };
      const down = this.tables.filter((t) => able && table.readComputedRoulette(t, now)?.phase === 'betting' && mine(t));
      // 🎲 At craps a goodbye instead (its oracle: computedCrapsSim).
      const bye = this.craps ? this.craps.goodbyeDue(sp, now) : null;
      if (this.craps) this.craps.saying(sp, true);
      try {
        table.leaveComputedTables(now);
      } finally {
        if (this.craps) this.craps.saying(sp, false);
      }
      for (const t of this.tables) casino.clearMySeat(t, sp.pid);
      for (const t of down) if (mine(t)) this.violate(`${sp.name} left ${t} at ${this.elapsed} ms with its felt still down`);
      if (bye) this.craps!.goodbyeSaid(sp, bye, now, true);
    });
    // 🎲 With a craps table in the room, as main.ts leaves: the page keeps
    // framing a second with no bot while the room's last writes go out,
    // writing no new slip (computedCrapsSim ownWrite); then it is gone.
    if (this.craps) {
      this.craps.leavingSecond(sp);
      return;
    }
    sp.mode = 'gone';
    sp.awayFrom = this.T;
  }

  /** Page sp gone with no leave (a crash, a killed tab). */
  crash(sp: SimPage): void {
    sp.mode = 'gone';
    sp.leaving = false;
    sp.awayFrom = this.T;
  }

  /** Page sp stops running frames (a sleep); its doc hears the room or not. */
  sleep(sp: SimPage, syncing: boolean): void {
    sp.mode = 'asleep';
    sp.syncing = syncing;
    sp.awayFrom = this.T;
  }

  /** Page sp back up (from a sleep, or gone with its doc kept). */
  wake(sp: SimPage): void {
    const was = this.net.connected(sp);
    sp.mode = 'up';
    sp.syncing = true;
    this.wasAway(sp, sp.awayFrom ?? this.T);
    sp.awayFrom = null;
    if (!was) this.net.connect(sp);
  }

  /** Page sp's clock moved by `ms` (a step: back, or forward). */
  step(sp: SimPage, ms: number): void {
    sp.p.skew += ms;
    this.wasAway(sp);
  }

  /** A removal of table t from the room, by the house's page (closeTable,
   *  as World's furniture removal calls it); each other page hears it a
   *  link's delay later and closes the table too. */
  async remove(house: SimPage, t: string): Promise<void> {
    house.inRoom.delete(t);
    await this.as(house, () => house.p.croupier.closeTable(t, 'local'));
    for (const sp of this.pages) {
      if (sp === house) continue;
      this.at(this.T - SIM_T0 + between(this.rand, 50, 400), async () => {
        sp.inRoom.delete(t);
        if (sp.mode === 'gone') return;
        await this.as(sp, () => sp.p.croupier.closeTable(t, 'heard'));
      });
    }
  }

  // ── Running ──

  /** Run `fn` at `ms` after the start (on the first tick at or past it). */
  at(ms: number, fn: () => void | Promise<void>): void {
    this.events.push({ at: SIM_T0 + ms, fn });
    this.events.sort((a, b) => a.at - b.at);
  }

  /** Run `fn` on every tick, before the deliveries and frames. */
  every(fn: (T: number) => void | Promise<void>): void {
    this.hooks.push(fn);
  }

  /** 🎲 The fold context of table t's incarnation inc in this room. */
  ctxOf(t: string, inc: string): FoldCtx {
    return { room: PAGE_ROOM, t, inc };
  }

  /** ms since the start. */
  get elapsed(): number {
    return this.T - SIM_T0;
  }

  /** Run the room for `ms`. */
  async run(ms: number): Promise<void> {
    const end = this.T + ms;
    while (this.T < end) {
      await this.tick();
      this.T += SIM_STEP;
    }
  }

  private async tick(): Promise<void> {
    while (this.events.length > 0 && this.events[0].at <= this.T) await this.events.shift()!.fn();
    for (const hook of this.hooks) await hook(this.T);
    this.net.beat();
    await this.net.deliver(this.T);
    this.net.answerAsks();
    const beat = (this.T - SIM_T0) % RESYNC_MS === 0;
    if (beat) this.net.resync();
    if (this.node) await this.houseTick();
    for (const sp of this.pages) {
      if (sp.mode !== 'up' || this.T < sp.pauseUntil) continue;
      if (beat) await this.as(sp, (now) => this.sit(sp, now));
      // (Its timers first: a slice set after a frame runs before the next,
      // a few in the time a frame of the run takes.)
      await this.runTimers(sp, 4);
      if (sp.beforeFrame && !sp.beforeFrame(this.enter(sp))) continue;
      await this.frame(sp);
    }
    for (const sp of this.pages) {
      if (sp.mode !== 'up') continue;
      this.observe(sp);
      if (beat) this.audit(sp);
    }
    if (this.pocketChecks.length > 0) await Promise.all(this.pocketChecks.splice(0));
  }

  /** 🏠 The owner's node's tick (computedSimHouse), on the doc of the
   *  house's page while that page hears the room and the node runs: its key
   *  told to each load of the page (main.ts setLocalHouse, from the node's
   *  fingerprint), its clock the room's (monotonic) and the page's (wall). */
  private async houseTick(): Promise<void> {
    const sp = this.house;
    if (!this.nodeUp || !this.net.connected(sp)) return;
    await this.as(sp, (now) => {
      if (this.nodeOn !== sp.p) {
        sp.p.table.setLocalHouse(this.node!.pub);
        this.nodeOn = sp.p;
      }
      this.node!.tick(PAGE_ROOM, sp.p.doc, this.T, now);
    });
  }

  /** Page sp hears update `u` (from the network). While its doc holds part
   *  of an update, before and after, no computed count moves (each stands
   *  as it was, parked, until the rest comes). */
  async hear(sp: SimPage, u: Uint8Array, resync: boolean): Promise<void> {
    const before = sp.partial ? this.foldsNow(sp) : null;
    await this.as(sp, () => {
      const wall = performance.now();
      const cpu = process.cpuUsage();
      Y.applyUpdate(sp.p.doc, u, NET);
      if (!resync) {
        const spent = process.cpuUsage(cpu);
        this.warm.push((spent.user + spent.system) / 1_000);
        this.warmWall.push(performance.now() - wall);
      }
    });
    if (resync && !sp.roomIn) {
      sp.roomIn = true;
      // (What came by now came with the room's state: computedTable reads
      // from its first look with it in on.)
      sp.realFrom = Math.max(sp.realFrom, this.T + sp.p.skew);
    }
    const partial = (sp.p.doc.store as unknown as { pendingStructs: unknown }).pendingStructs !== null;
    if (before && partial) {
      for (const [t, b] of before) {
        if (b.res && b.inc === sp.p.casino.computedIncOf(t) && sp.p.casino.computedFoldOf(t) !== b.res) {
          this.violate(`${sp.name}'s count of ${t} moved at ${this.elapsed} ms, its doc holding part of an update`);
        }
      }
    }
    if (!sp.p.casino.computedSettled()) sp.pendingHeard += 1;
    if (partial && !sp.partial) sp.partialEpisodes += 1;
    sp.partial = partial;
  }

  /** Page sp hears a heartbeat (main.ts onTick): its tables are told, on its clock. */
  heardBeat(sp: SimPage): void {
    const now = this.enter(sp);
    sp.p.table.noteRoomHeard(now);
  }

  /** One frame of page sp: its bot, then World's frame for computed tables. */
  private async frame(sp: SimPage): Promise<void> {
    try {
      await this.as(sp, (now) => {
        if (sp.betting && sp.spec.bot !== null && !sp.leaving) this.bot(sp, now);
        // 🎲 Off betting (the quiet period), a craps player still throws
        // the dice it is offered.
        else if (this.craps && sp.spec.bot !== null && !sp.leaving) this.craps.idle(sp, now);
        const { casino, croupier, table } = sp.p;
        const tables = this.tables.filter((t) => sp.inRoom.has(t));
        const wakes = croupier.tablesWakeCount();
        if (tables.length || table.computedCompactionPending()) croupier.noteTablesRunning(now);
        if (croupier.tablesWakeCount() !== wakes) {
          this.wasAway(sp);
          sp.restartAt = { at: now, T: this.T };
          sp.realFrom = Math.max(sp.realFrom, now + croupier.TABLE_LEASE_LAPSE_MS);
        }
        // (The gates its tables' duties run behind, as this frame's run of
        // them finds them: computedTable tickTable.)
        for (const t of tables) {
          const res = casino.computedFoldOf(t);
          if (!res || !casino.isComputedTable(t)) continue;
          if (!croupier.tablesAwake(now) || !casino.casinoWhole(t) || !casino.computedSettled(t)) {
            sp.shutAt = this.T;
            continue;
          }
          for (const v of res.rounds) if (v.decided === 'reveals' && v.present.includes(sp.pid)) sp.keptFor.add(`${t}|${v.close}`);
        }
        if (sp === this.house && tables.length && croupier.canRunCroupier() && croupier.takeTableTurn(now)) {
          // (At a craps table the stickman's tick, as World runs it: never
          // roulette's robot on a craps id.)
          for (const t of tables) {
            if (this.craps && this.gameOf(t) === 'craps') this.craps.stickman(sp, t);
            else croupier.tickAutoCroupier(t);
          }
        }
        table.tickComputedTables(this.refsOf(tables), now);
        // 🤖 Then the robot, as World runs it (computedSimRobot).
        this.robots.frame(sp, tables, now, sp.robotMotion ?? undefined);
        sp.afterRobot?.(now);
        if (this.craps) this.craps.framed(sp);
      });
    } catch (err) {
      if (err instanceof Error) err.message = `${this.label}: ${sp.name}'s frame threw at ${this.elapsed} ms: ${err.message}`;
      throw err;
    }
  }

  private bot(sp: SimPage, now: number): void {
    const bot = sp.spec.bot ?? this.opts.bot ?? BOT;
    const { casino, table } = sp.p;
    for (const t of sp.spec.botTables ?? this.tables) {
      if (!sp.inRoom.has(t)) continue;
      // 🎲 A craps table's player: computedCrapsSim.
      if (this.craps && this.gameOf(t) === 'craps') {
        this.craps.bot(sp, t, now);
        continue;
      }
      const v = table.readComputedRoulette(t, now);
      if (!v || v.phase !== 'betting') continue;
      const mine = table.readMyComputedBets(t, sp.pid, v.round, now);
      const r = sp.rand;
      let felt: RouletteBet[] | null = null;
      if (mine.length === 0) {
        if (r() < bot.place) {
          if (bot.low > 0 && casino.readChips(sp.pid) < bot.low) this.buyIn(sp, sp.pid, bot.topUp);
          if (bot.allIn) {
            const all = casino.readChips(sp.pid);
            felt = all > 0 ? [{ type: 'red', amount: all }] : null;
          } else {
            felt = Array.from({ length: between(r, bot.bets[0], bot.bets[1]) }, () => newBet(r, bot));
          }
        }
      } else if (r() < bot.take) {
        felt = [];
      } else if (r() < bot.change && !bot.allIn && mine.length < sp.p.fold.MAX_SLIP_BETS) {
        // (A felt holds MAX_SLIP_BETS at most: the table's UI adds no more.)
        felt = [...mine, newBet(r, bot)];
      }
      if (!felt) continue;
      // Now and then a felt of more than the player has (past what their
      // felt holds): the chip check refuses it, whatever else may answer.
      let over = false;
      if (!bot.allIn && felt.length > 0 && r() < 0.05) {
        const held = Number(casino.computedFoldOf(t)?.held.get(sp.pid) ?? 0n);
        felt = [{ type: 'red', amount: casino.readChips(sp.pid) + held + 1 + between(r, 0, 50) }];
        over = true;
      }
      // And for certain once a page: its first felt with chips on it is
      // tried first at more than its player has, past what its felt holds
      // (the 5% above can miss a whole run: SIM_SEED=700's baseline drew no
      // over felt in 81). No draw is taken for it, and a felt refused writes
      // nothing, so the run goes on as drawn; an answer that isn't the chip
      // check's ('closed', 'reconnecting') leaves it for the next felt.
      if (!sp.overTried && !bot.allIn && felt.some((b) => b.amount > 0)) {
        const held = Number(casino.computedFoldOf(t)?.held.get(sp.pid) ?? 0n);
        const big: RouletteBet[] = [{ type: 'red', amount: casino.readChips(sp.pid) + held + 1 }];
        const tried = table.writeComputedSlip(t, big, now);
        if (tried === 'chips' || tried === 'ok') {
          sp.overTried = true;
          sp.writes[tried] = (sp.writes[tried] ?? 0) + 1;
        }
        if (tried === 'ok') this.violate(`${sp.name}'s felt of ${big[0].amount} chips at ${t} went down at ${this.elapsed} ms (it has ${casino.readChips(sp.pid)})`);
      }
      const res = table.writeComputedSlip(t, felt, now);
      sp.writes[res] = (sp.writes[res] ?? 0) + 1;
      if (over && res === 'ok') this.violate(`${sp.name}'s felt of ${felt[0].amount} chips at ${t} went down at ${this.elapsed} ms (it has ${casino.readChips(sp.pid)})`);
    }
  }

  // ── Looking ──

  /** What page sp shows now: flips, trims, session weight, stalls. */
  private observe(sp: SimPage): void {
    const now = this.enter(sp);
    const { casino, croupier } = sp.p;
    for (const t of this.tables) {
      const res = casino.computedFoldOf(t);
      const inc = casino.computedIncOf(t);
      if (!res || !inc) continue;
      const key = `${t}:${inc}`;
      let sids = this.sids.get(key);
      if (!sids) this.sids.set(key, sids = new Set());
      sids.add(res.base.sid);
      // Session weight, before each trim, and what one round adds.
      const D = lastDecided(res);
      const to = D?.r ?? res.base.u;
      let w = sp.watch.get(key);
      if (!w || w.sid !== res.base.sid) {
        const cp = sp.p.fold.asCheckpointFor({ inc })(sp.p.doc.getMap('casinoComputed').get(`sum:${t}:${inc}`));
        if (cp) this.cps.set(`${key}:${sp.p.fold.nextSid({ room: PAGE_ROOM, t, inc }, cp)}`, cp);
      }
      if (!w) {
        sp.watch.set(key, w = { sid: res.base.sid, bytes: res.rawBytes, advancedBytes: res.rawBytes, decidedTo: to, stall: null, cpFlipped: new Set() });
      }
      if (w.sid !== res.base.sid) {
        this.maxPreTrimBytes = Math.max(this.maxPreTrimBytes, w.bytes);
        w.sid = res.base.sid;
        w.advancedBytes = res.rawBytes;
        w.decidedTo = to;
      } else if (to > w.decidedTo) {
        this.maxRoundBytes = Math.max(this.maxRoundBytes, res.rawBytes - w.advancedBytes);
        w.advancedBytes = res.rawBytes;
        w.decidedTo = to;
      }
      w.bytes = res.rawBytes;
      if (res.rawBytes > this.maxSessionBytes) {
        this.maxSessionBytes = res.rawBytes;
        const ses = casino.computedSessionForWrite(t);
        const cp = sp.p.fold.asCheckpointFor({ inc })(sp.p.doc.getMap('casinoComputed').get(`sum:${t}:${inc}`));
        if (ses) {
          this.biggest = {
            bytes: res.rawBytes, ctx: { room: PAGE_ROOM, t, inc }, cp,
            entries: [...ses.entries()].map(([k, v]): [string, unknown] => [k, v === undefined ? null : v]),
            keyOf: this.keyOf(sp),
          };
        }
      }
      if (casino.isComputedTable(t) && casino.computedIncOf(t) === inc) sp.lastLive.set(key, { u: to, nets: netsText(res.nets) });
      const craps = this.craps !== null && gameOfInc(inc) === 'craps';
      for (const v of res.rounds) {
        if (!this.closeAt.has(v.close)) this.closeAt.set(v.close, this.T);
        if (!v.decided) continue;
        this.decisions.set(`${key}:${v.r}`, v.decided);
        this.closes.set(v.close, { r: v.r, q: v.closeRec.q, shown: craps ? crapsShownOf(v) : shownOf(v) });
        if (!craps) this.workOut(sp, { room: PAGE_ROOM, t, inc }, v);
      }
      // 🎲 At craps the rolls are worked out as a chain, each from the state
      // the one before left (computedCrapsSim's checker), once a fold result.
      if (craps) {
        this.craps!.check(sp, { room: PAGE_ROOM, t, inc }, res);
        this.craps!.observeCraps(sp, { room: PAGE_ROOM, t, inc }, res, now);
      }
      this.flipsOf(sp, t, inc, res, now);
      this.stallOf(sp, t, key, res, croupier.tablesAwake(now) && casino.casinoWhole(t) && casino.computedSettled(t));
    }
  }

  /** A decided round page sp folded, worked out afresh from the records its
   *  session holds (once a page per close, decision and count; again while a
   *  record it rests on is missing): who is counted (the reveals: every
   *  frozen bettor; a forfeit: its own list; a void: nobody), each frozen
   *  bettor's stake and delta by the game's rule (games/roulette
   *  resolveRound: the bets the close froze against the pocket; nothing on a
   *  void), and the pocket from the counted seeds (diceFairness
   *  combinePocketSeeds, the async draw a Fair table makes; awaited at the
   *  end of the tick). */
  private workOut(sp: SimPage, ctx: FoldCtx, v: RoundView): void {
    const id = `${sp.name}|${ctx.t}:${ctx.inc}:${v.close}|${v.decided}|${v.forfeit?.hash ?? v.abandon?.hash ?? v.house?.hash ?? ''}|${v.counted.join(',')}`;
    if (this.checkedRounds.has(id)) return;
    const ses = sp.p.casino.computedSessionForWrite(ctx.t);
    if (!ses || sp.p.casino.computedIncOf(ctx.t) !== ctx.inc) return;
    const wrong = (why: string): void => this.violate(`${sp.name} ${ctx.t} round ${v.r} (${v.decided}) at ${this.elapsed} ms: ${why}`);
    // 🏠 A Fair round (its close names a commitment) is decided by a house
    // reveal of this round listing its close, whose seed opens the
    // commitment, in the session as the fold names it; or voided by an
    // abandon. The house counts the bettors whose frozen slip it lists.
    const H = v.house?.rec;
    if (v.closeRec.h !== undefined) {
      if (v.decided === 'reveals' || v.decided === 'forfeit') wrong('a Fair round decided without the house');
      if (H) {
        const rec = ses.get(`h:${v.r}:${v.house!.hash}`);
        if (rec === undefined) return;
        if (canon(rec) !== canon(H)) wrong(`its house reveal reads ${canon(rec)}, the fold's ${canon(H)}`);
        if (H.r !== v.r || !H.x.includes(v.close) || houseCommitOf(ctx, v.r, H.s) !== v.closeRec.h) wrong('its house reveal is of another round, close or commitment');
      } else if (v.decided !== 'void' || !v.abandon) {
        wrong('a Fair round decided with no house reveal');
      }
    } else if (H) {
      wrong('a Friendly round decided by a house reveal');
    }
    const counted = v.decided === 'reveals' ? v.present : v.decided === 'forfeit' ? [...(v.forfeit?.rec.n ?? [])].sort()
      : v.decided === 'house' ? v.present.filter((pid) => H!.n.includes(v.frozen[pid])) : [];
    if (JSON.stringify(v.counted) !== JSON.stringify(counted)) wrong(`counted ${v.counted.join(',')}, not ${counted.join(',')}`);
    const seeds: string[] = [];
    for (const pid of v.present) {
      const slip = ses.get(`s:${v.r}:${pid}:${v.frozen[pid]}`) as { b?: RouletteBet[]; c?: string } | undefined;
      if (!slip?.b || typeof slip.c !== 'string') return;
      const stake = slip.b.reduce((n, b) => n + BigInt(b.amount), 0n);
      const won = v.pocket !== null && counted.includes(pid) ? BigInt(resolveRound({ bettor: slip.b }, v.pocket).bettor ?? 0) : 0n;
      const delta = v.decided === 'void' ? 0n : won - stake;
      if (v.stakes.get(pid) !== stake || (v.deltas.get(pid) ?? 0n) !== delta) {
        wrong(`${pid}'s stake ${v.stakes.get(pid)} and delta ${v.deltas.get(pid)}, by the felt ${stake} and ${delta} (pocket ${v.pocket})`);
      }
      if (!counted.includes(pid)) continue;
      const x = [...ses.keys()].filter((k) => k.startsWith(`x:${v.r}:${pid}:`)).map((k) => ses.get(k) as { r?: unknown; p?: unknown; s?: unknown })
        .find((rec) => rec?.r === v.r && rec.p === pid && typeof rec.s === 'string' && slipCommit(ctx, v.r, pid, rec.s) === slip.c);
      if (!x) return;
      seeds.push(x.s as string);
    }
    this.checkedRounds.add(id);
    if (v.decided === 'void') {
      if (v.pocket !== null) wrong(`a void with pocket ${v.pocket}`);
      return;
    }
    const pocket = v.pocket;
    // (A Fair round's draw takes the house's seed last.)
    const draw = H && v.decided === 'house'
      ? pocketFromMaterial(`ssf-roulette-combine-v1|${[...seeds].sort().join('|')}|${seedTable(ctx)}|${v.r}|house:${H.s}`)
      : combinePocketSeeds(seeds, seedTable(ctx), v.r);
    this.pocketChecks.push(draw.then((want) => {
      if (want !== pocket) wrong(`pocket ${pocket}, the counted seeds draw ${want}`);
    }));
  }

  /** A round page sp showed decided (its view's spin key named it, or its
   *  view read it settled void) that now reads otherwise — decided another
   *  way, or not at all — is a flip; so is a checkpoint differing from what
   *  it folded of the rounds it covers. */
  private flipsOf(sp: SimPage, t: string, inc: string, res: FoldResult, now: number): void {
    const { table } = sp.p;
    // 🎲 At craps the view's roll key names the roll the dice landed on, a
    // roll shows what it paid and handed on (crapsShownOf), and a roll paid
    // again on the same dice is its own kind, once a roll ('repaid').
    const craps = this.craps !== null && gameOfInc(inc) === 'craps';
    const shown = craps ? crapsShownOf : shownOf;
    const kindOf = craps ? crapsChangeKind : changeKind;
    const view = craps ? table.readComputedCraps(t, now) : table.readComputedRoulette(t, now);
    const spinKey = view === null ? '' : 'rollKey' in view ? view.rollKey : view.spinKey;
    const flip = (kind: FlipKind, why: string, v?: RoundView, was?: Shown, is?: Shown, key?: string): void => {
      const unlike = key !== undefined && this.opts.backIsBlip ? sp.unlike.get(key) : undefined;
      if (unlike && is && is.close === unlike.shown.close && is.decided === unlike.shown.decided && is.seen === unlike.shown.seen) {
        // Back as it showed: each flip since was a blip.
        for (const f of unlike.flips) {
          this.unflip(sp, f.kind);
          sp.flipKinds.blip = (sp.flipKinds.blip ?? 0) + 1;
          f.kind = 'blip';
        }
        sp.unlike.delete(key!);
        kind = 'blip';
        why += ' (back as it showed)';
      }
      this.flip(sp, t, kind, why);
      if (!v || !was || !is) return;
      const fk = kind === 'answer forfeit' ? was.fk : is.fk;
      const event = { kind, T: this.T, close: is.close, present: v.present, ...(fk ? { fk } : {}) };
      sp.flipEvents.push(event);
      if (key !== undefined && this.opts.backIsBlip && kind !== 'blip') {
        const u = sp.unlike.get(key) ?? { shown: { seen: was.seen, close: was.close, decided: was.decided }, flips: [] };
        u.flips.push(event);
        sp.unlike.set(key, u);
      }
    };
    // (A void shows too, with no spin: "stakes back".)
    const voidShown = view !== null && view.phase === 'settled' && view.voided === true;
    if (view && (spinKey !== '' || voidShown) && view.inc === inc) {
      const r = spinKey !== '' ? Number(spinKey.split(':')[0]) : view.round;
      const v = res.rounds.find((x) => x.r === r && x.decided !== null);
      const key = `${t}:${inc}:${r}`;
      if (v && !sp.shown.has(key)) {
        sp.shown.set(key, shown(v));
        sp.shownAll.set(key, shown(v));
      }
    }
    const keep = (key: string, s: Shown): void => {
      sp.shown.set(key, s);
      sp.shownAll.set(key, s);
    };
    for (const [key, was] of [...sp.shown]) {
      const at = key.lastIndexOf(':');
      if (!key.startsWith(`${t}:${inc}:`)) continue;
      const r = Number(key.slice(at + 1));
      // (A checkpoint covers it: final, unless a split's other side's
      // checkpoint takes its place: settleFlips, once the run is over.)
      if (r <= res.base.u) continue;
      const v = res.rounds.find((x) => x.r === r);
      if (!v || v.decided === null) {
        if (was.gone === undefined) keep(key, { ...was, gone: this.elapsed });
        continue;
      }
      const is = shown(v);
      if (was.gone !== undefined) {
        const away = `${((this.elapsed - was.gone) / 1000).toFixed(2)}s`;
        flip(is.seen === was.seen ? 'blip' : kindOf(was, is), `round ${r} gone ${away}: ${said(was)} → ${said(is)}`, v, was, is, key);
        keep(key, is);
        continue;
      }
      // (Decided another way to the same pocket, payouts and deltas: the
      // wheel doesn't spin again and no chip moves; not a flip.)
      if (is.seen === was.seen) continue;
      const kind = kindOf(was, is);
      // (A roll paid again counts once, however often it is.)
      if (kind === 'repaid' && sp.repaid.has(key)) {
        keep(key, is);
        continue;
      }
      if (kind === 'repaid') sp.repaid.add(key);
      flip(kind, `round ${r} ${said(was)} → ${said(is)}`, v, was, is, key);
      keep(key, is);
    }
    const check = table.computedRoundCheck(t, now);
    const w = sp.watch.get(`${t}:${inc}`)!;
    if (check && check.checkpointDiff > 0 && !w.cpFlipped.has(res.base.sid)) {
      w.cpFlipped.add(res.base.sid);
      flip('checkpoint', `${res.base.sid} differs by ${check.checkpointDiff} chips`);
    }
  }

  /** When `close` first came to any page (the room's time), or undefined. */
  closeFirstAt(close: string): number | undefined {
    return this.closeAt.get(close);
  }

  /** Flips of `kinds` that no page's absence explains: each needs a page
   *  frozen in the round, or the one that wrote the forfeit that dropped a
   *  seed (a forfeit over reveals: the round's new decider; an answer: the
   *  forfeit it answered), to have been away or its clock to have moved (a
   *  sleep, gone, a step, a wake) between a lapse before the close first came
   *  to any page and the flip: a seed that came late from it, or seeds it
   *  read late. */
  unexplained(kinds: readonly FlipKind[]): string[] {
    const out: string[] = [];
    const lapse = this.house.p.croupier.TABLE_LEASE_LAPSE_MS;
    for (const sp of this.pages) {
      for (const f of sp.flipEvents) {
        if (!kinds.includes(f.kind)) continue;
        const from = (this.closeAt.get(f.close) ?? f.T) - lapse;
        const who = this.pages.filter((q) => f.present.includes(q.pid) || (f.fk !== undefined && q.p.pub === f.fk));
        const away = (q: SimPage): boolean => q.away.some(([a, b]) => b >= from && a <= f.T) || (q.awayFrom !== null && q.awayFrom <= f.T);
        if (who.some(away)) continue;
        out.push(`${sp.name} ${((f.T - SIM_T0) / 1000).toFixed(2)}s ${f.kind}: none of ${who.map((q) => q.name).join(',')} away`);
      }
    }
    return out;
  }

  private flip(sp: SimPage, t: string, kind: FlipKind, why: string): void {
    sp.flips += 1;
    sp.flipKinds[kind] = (sp.flipKinds[kind] ?? 0) + 1;
    if (sp.flipLog.length < 20) sp.flipLog.push(`${(this.elapsed / 1000).toFixed(2)}s ${t} ${kind}: ${why}`);
  }

  /** One flip of `kind` page sp counted, counted again as a blip. */
  private unflip(sp: SimPage, kind: FlipKind): void {
    const n = (sp.flipKinds[kind] ?? 0) - 1;
    if (n > 0) sp.flipKinds[kind] = n;
    else delete sp.flipKinds[kind];
  }

  /** Once the run is over (healed, quiet, synced): every round a page showed
   *  that the chain the doc kept holds otherwise, a trim having taken it out
   *  of the session meanwhile (the live check sees only the session's). The
   *  kept chain: the live session's decided rounds, then each checkpoint's
   *  closes back from the one it names (`l`, each close's `q` the one
   *  before), checkpoint by checkpoint (`b`, the session it closed). */
  settleFlips(): void {
    const ref = this.pages.find((sp) => sp.mode === 'up');
    if (!ref) return;
    this.enter(ref);
    for (const [key, fold] of this.cold(ref).folds) {
      const kept = new Map<number, string>();
      for (const v of fold.res.rounds) if (v.decided) kept.set(v.r, v.close);
      const to = lastDecided(fold.res)?.r ?? fold.res.base.u;
      let cp = this.cps.get(`${key}:${fold.res.base.sid}`);
      for (let hops = 0; cp && hops < 10_000; hops++) {
        for (let h: string | undefined = cp.l, c = this.closes.get(h); c; h = c.q, c = this.closes.get(h)) kept.set(c.r, h);
        cp = this.cps.get(`${key}:${cp.b}`);
      }
      for (const sp of this.pages) {
        for (const [k, was] of sp.shownAll) {
          if (!k.startsWith(`${key}:`)) continue;
          const r = Number(k.slice(key.length + 1));
          const h = kept.get(r);
          if (h === undefined && r <= to) continue; // (a stretch of the chain no page folded: unknown)
          const is = h === undefined ? null : this.closes.get(h)!.shown;
          const same = is !== null && (h === was.close || is.seen === was.seen);
          const what = `round ${r} ${said(was)} → ${is ? said(is) : 'not on the chain kept'}`;
          if (was.gone !== undefined) this.flip(sp, fold.ctx.t, same ? 'blip' : 'undone', what);
          else if (!same) this.flip(sp, fold.ctx.t, 'other branch', what);
          sp.shownAll.delete(k);
        }
      }
    }
  }

  /** How long the table has sat, as page sp reads it (awake, whole, checked):
   *  with a tip, or with chips on the felt and no close, while an honest
   *  page frozen in the tip or staked on the felt is up (running frames) and
   *  in sp's reach. */
  private stallOf(sp: SimPage, t: string, key: string, res: FoldResult, able: boolean): void {
    const w = sp.watch.get(key)!;
    // (At craps, the players whose latest version puts anything to the
    // roll: computedCrapsSim stakedOf.)
    const staked = this.craps && this.gameOf(t) === 'craps'
      ? this.craps.stakedOf(res)
      : [...res.felts.values()].filter((s) => s.rec.b.length > 0).map((s) => s.rec.p);
    const who = res.tip ? res.tip.present : staked;
    const sitting = res.tip !== null || staked.length > 0;
    const watched = this.pages.some((q) => q.honest && q.mode === 'up' && this.T >= q.pauseUntil && who.includes(q.pid) && this.net.reach(sp, q));
    if (!able || !sitting || !watched) {
      w.stall = null;
      return;
    }
    const k = `${res.base.sid}|${res.open}|${res.tip?.close ?? '-'}`;
    if (!w.stall || w.stall.key !== k) {
      w.stall = { key: k, from: this.T };
      return;
    }
    const ms = this.T - w.stall.from;
    const at = `${sp.name} ${t} round ${res.open} ${res.tip ? 'tip' : 'felts'} from ${((w.stall.from - SIM_T0) / 1000).toFixed(2)}s`;
    if (ms > this.worstStall.ms) this.worstStall = { ms, at };
    // 🎲 At craps by phase: the felts' wait (the show, betting, the wait for
    // the throw, the close turns) and the tip's (the seeds), held to budgets
    // of their own.
    if (this.craps && this.gameOf(t) === 'craps') {
      const by = res.tip ? this.worstStallBy.tip : this.worstStallBy.felts;
      if (ms > by.ms) {
        by.ms = ms;
        by.at = at;
      }
    }
  }

  /** Every 5 s on page sp: the snapshot's size, and on a doc whole and
   *  checked, the cage's books and every player's chips against a cold fold. */
  private audit(sp: SimPage): void {
    this.enter(sp);
    const bytes = Y.encodeStateAsUpdate(sp.p.doc).length;
    if (bytes > this.maxDocBytes) this.maxDocBytes = bytes;
    if (bytes >= 1_000_000) this.violate(`${sp.name}'s doc weighs ${bytes} B at ${this.elapsed} ms`);
    const { casino } = sp.p;
    // (Nor while a table reads as lost: a session or checkpoint it counted
    // gone, its count kept until the recovery duty brings it back.)
    if (sp.partial || !casino.casinoWhole() || this.tables.some((t) => !casino.casinoWhole(t)) || !casino.computedSettled()) return;
    for (const v of this.ledgerProblems(sp)) this.violate(`${sp.name} at ${this.elapsed} ms: ${v}`);
    // An incarnation ended (switched off, removed): its last checkpoint holds
    // the nets this page last folded of it live, to the same round (an
    // ending moves no chips).
    for (const [key, f] of this.cold(sp).folds) {
      // 🎲 At craps: an ended incarnation's nets, those the checker handed
      // on at the close its final checkpoint names.
      if (this.craps && f.res.base.ended && gameOfInc(f.ctx.inc) === 'craps') this.craps.checkEnded(sp, f.ctx, f.res);
      const last = sp.lastLive.get(key);
      if (!f.res.base.ended || !last || last.u !== f.res.base.u) continue;
      const nets = netsText(f.res.nets);
      if (nets !== last.nets) this.violate(`${sp.name} at ${this.elapsed} ms: ${key} ended on nets ${nets}, its rounds to ${last.u} folded ${last.nets}`);
    }
  }

  violate(why: string): void {
    if (this.violations.length < 40) this.violations.push(`${this.label}: ${why}`);
  }

  /** The key page sp's fold reads each player's felts under (casinoDoc's pin). */
  keyOf(sp: SimPage): (pid: string) => string | undefined {
    const { casino, pub } = sp.p;
    return (pid) => (pid === sp.pid ? pub : casino.readPlayerKey(pid));
  }

  /** A SigCheck on the strict verifier, its verdicts kept by incarnation and
   *  record hash (a record's bytes are its hash's). */
  private checkFor(sp: SimPage, ctx: FoldCtx, cache = true): SigCheck {
    const verify = sp.p.keypair.verifyIdentityStrict;
    return (hash, _kind, pub, bytes, sig) => {
      const key = `${ctx.t}|${ctx.inc}|${hash}`;
      let v = cache ? this.verdicts.get(key) : undefined;
      if (v === undefined) {
        v = verify(pub, bytes(), sig);
        if (cache) this.verdicts.set(key, v);
      }
      return v;
    };
  }

  /** Page sp's doc folded cold: every incarnation it holds a session or a
   *  checkpoint of, as casinoDoc counts them (the session the checkpoint
   *  opens; felts held only while the incarnation is live). */
  cold(sp: SimPage): Cold {
    const { fold } = sp.p;
    const map = sp.p.doc.getMap<unknown>('casinoComputed');
    const casinoMap = sp.p.doc.getMap<unknown>('casino');
    const out: Cold = { folds: new Map(), nets: new Map(), held: new Map() };
    const incs = new Map<string, { t: string; inc: string }>();
    for (const key of map.keys()) {
      const at = incOfKey(key);
      if (at) incs.set(`${at.t}:${at.inc}`, at);
    }
    const keyOf = this.keyOf(sp);
    // (While the doc holds no checkpoint, deleted or junk, a page on this
    // build counts from the head it holds: casinoDoc heldBase.)
    const held = new Map(sp.p.casino.computedRecoveryOn() ? sp.p.casino.computedRecoveries().map((r) => [`${r.t}:${r.inc}`, r.head]) : []);
    for (const [key, { t, inc }] of [...incs].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const ctx: FoldCtx = { room: PAGE_ROOM, t, inc };
      const cp = fold.asCheckpointFor(ctx)(map.get(`sum:${t}:${inc}`)) ?? fold.asCheckpointFor(ctx)(held.get(key) ?? undefined);
      const ses = map.get(`ses:${t}:${inc}:${fold.nextSid(ctx, cp)}`);
      const entries = ses instanceof Y.Map ? [...(ses as Y.Map<unknown>).entries()].map(([k, v]): [string, unknown] => [k, v === undefined ? null : v]) : [];
      // (A house table's fold asks casinoDoc which keys are houses, as the
      // page's own does.)
      const tf = new fold.TableFold(ctx, this.checkFor(sp, ctx), keyOf, fold.foldGameOf(ctx), (pub) => sp.p.casino.houseOkOf(pub));
      tf.setBase(cp);
      tf.reset(entries);
      const res = tf.result();
      const cfg = casinoMap.get(`cfg:computed:${t}`) as { inc?: unknown } | undefined;
      const live = cfg?.inc === inc && !casinoMap.has(`gone:${t}:${inc}`) && !res.base.ended;
      out.folds.set(key, { ctx, cp, res, live });
      addTo(out.nets, res.nets);
      if (live) addTo(out.held, res.held);
    }
    return out;
  }

  /** Each player's chips as casinoDoc reads them against what a cold fold of
   *  every incarnation gives: their chip records and books, plus their
   *  computed nets, less what computed felts and owner-run lists hold, and
   *  never below 0 (a debt reads as none); and the cage's outstanding, their
   *  sum. A player with one page whose count reads below 0 is a debt
   *  (debts). */
  ledgerProblems(sp: SimPage): string[] {
    const out: string[] = [];
    const { casino } = sp.p;
    const L = casino.readCageLedger();
    const cold = this.cold(sp);
    const pids = new Set<string>([...this.pages.map((q) => q.pid), ...Object.keys(L.balances), ...cold.nets.keys(), ...cold.held.keys()]);
    let outstanding = 0n;
    for (const pid of pids) {
      let total = this.legacyBal(sp, pid) + this.endRefunds(sp, pid);
      for (const rec of casino.readChipRecords(pid)) total += BigInt(rec.d);
      total += cold.nets.get(pid) ?? 0n;
      total -= cold.held.get(pid) ?? 0n;
      for (const t of this.tables) if (this.ownerRunUp(sp, t)) total -= BigInt(casino.feltStake(t, pid).net);
      const want = total > 0n ? total : 0n;
      outstanding += want;
      if (BigInt(casino.readChips(pid)) !== want) out.push(`${pid} reads ${casino.readChips(pid)} chips, a cold count ${want}`);
      if (total < 0n && !this.debts.has(pid) && this.pages.filter((q) => q.pid === pid).length === 1) this.debts.set(pid, `${pid} at ${total} on ${sp.name} at ${this.elapsed} ms`);
    }
    if (BigInt(L.outstanding) !== outstanding) out.push(`the cage's outstanding ${L.outstanding} ≠ Σ chips ${outstanding}`);
    return out;
  }

  /** Once the run is over, on page sp: the cage against what the run did.
   *  It issued every chip bought (buyIn) and nothing more, cashed none;
   *  each player's chip records are their buy-ins; and the house's net is
   *  what the players' counts, from their buy-ins (not the doc's records),
   *  leave it: Σ bought − Σ max(0, bought + nets − held − list stakes). */
  cageProblems(sp: SimPage): string[] {
    const out: string[] = [];
    const { casino } = sp.p;
    const L = casino.readCageLedger();
    const issued = [...this.bought.values()].reduce((a, b) => a + b, 0n);
    if (BigInt(L.issued) !== issued) out.push(`the cage issued ${L.issued}, the run bought ${issued}`);
    if (L.cashed !== 0) out.push(`the cage cashed ${L.cashed}, the run cashed nothing`);
    const cold = this.cold(sp);
    const pids = new Set<string>([...this.pages.map((q) => q.pid), ...this.bought.keys(), ...Object.keys(L.balances), ...cold.nets.keys(), ...cold.held.keys()]);
    let kept = 0n;
    for (const pid of pids) {
      const bought = this.bought.get(pid) ?? 0n;
      const paid = this.ownerRunPaid.get(pid) ?? 0n;
      // (An earlier build's buy-in is no chip record: its counts, `bal:`
      // what its lists left of it.)
      const legacy = this.legacyBought.get(pid) ?? 0n;
      const recs = casino.readChipRecords(pid).reduce((n, rec) => n + BigInt(rec.d), this.endRefunds(sp, pid));
      if (recs !== bought - legacy + paid) {
        out.push(`${pid}'s chip records come to ${recs}, its buy-ins ${bought - legacy}${paid ? ` and owner-run play ${paid}` : ''}${legacy ? ` (and ${legacy} an earlier build's)` : ''}`);
      }
      let total = bought - legacy + this.legacyBal(sp, pid) + paid + (cold.nets.get(pid) ?? 0n) - (cold.held.get(pid) ?? 0n);
      for (const t of this.tables) if (this.ownerRunUp(sp, t)) total -= BigInt(casino.feltStake(t, pid).net);
      if (total > 0n) kept += total;
    }
    if (BigInt(L.houseNet) !== issued - kept) out.push(`the house's net ${L.houseNet}, the players' counts leave it ${issued - kept}`);
    return out;
  }

  /** What the refunds (`end:<table>:<inc>:<pid>` chip keys: an incarnation's
   *  removal or sweep handing back what an earlier build's list took whole)
   *  give player pid on page sp's doc: each one whose book still has pid's
   *  entry as the refund's writer saw it (its `seen`: else a settle it
   *  hadn't heard of resolved the list). readChipRecords lists none of them. */
  private endRefunds(sp: SimPage, pid: string): bigint {
    const chips = sp.p.doc.getMap('casinoChips');
    let n = 0n;
    for (const [key, value] of chips.entries()) {
      if (!key.startsWith('end:') || !key.endsWith(`:${pid}`)) continue;
      const e = value as { p?: unknown; d?: unknown; seen?: unknown } | null;
      if (!e || e.p !== pid || !Number.isSafeInteger(e.d) || (e.d as number) <= 0 || typeof e.seen !== 'string') continue;
      const at = key.slice('end:'.length, key.length - pid.length - 1);
      const book = chips.get(`book:${at}`) as { recs?: Record<string, { w?: unknown }> } | undefined;
      const w = book && typeof book === 'object' && book.recs && Object.prototype.hasOwnProperty.call(book.recs, pid) ? book.recs[pid]?.w : undefined;
      if ((typeof w === 'string' ? w : '') === e.seen) n += BigInt(e.d as number);
    }
    return n;
  }

  /** Player pid's chips as an earlier build counts them on page sp's doc
   *  (`bal:<pid>`, a non-negative integer: casinoDoc's legacyCount, the
   *  opening of every ledger total), 0 with none. */
  private legacyBal(sp: SimPage, pid: string): bigint {
    const v = sp.p.doc.getMap('casino').get(`bal:${pid}`);
    return Number.isInteger(v) && (v as number) >= 0 ? BigInt(v as number) : 0n;
  }

  /** Whether table t has an owner-run state up on page sp (its lists hold
   *  chips: casinoDoc feltStake): roulette's, or at a craps table craps's. */
  private ownerRunUp(sp: SimPage, t: string): boolean {
    const { casino } = sp.p;
    return this.craps && this.gameOf(t) === 'craps' ? casino.readCrapsTableState(t) !== null : casino.readTableState(t) !== null;
  }

  /** Once the run is over, page sp's doc whole, every count checked, awake
   *  (while it runs tables: a room whose last table went runs none, as
   *  World notes them running only then, frame), nothing held back: what a
   *  page that has caught up reads. */
  endProblems(sp: SimPage): string[] {
    const now = this.enter(sp);
    const { casino, croupier, table } = sp.p;
    const out: string[] = [];
    if (sp.partial || !casino.casinoWhole()) out.push('its doc holds part of an update');
    if (!casino.computedSettled()) out.push('a count waits on its checks');
    const runs = this.tables.some((t) => sp.inRoom.has(t)) || table.computedCompactionPending();
    if (runs && !croupier.tablesAwake(now)) out.push('its tables read asleep');
    if (sp.timers.length > 0) out.push(`${sp.timers.length} timers wait`);
    return out;
  }

  /** A player's chips before the clamp, as a cold count reads them on sp. */
  ledgerTotal(sp: SimPage, pid: string): bigint {
    const { casino } = sp.p;
    let total = this.legacyBal(sp, pid) + this.endRefunds(sp, pid);
    for (const rec of casino.readChipRecords(pid)) total += BigInt(rec.d);
    const cold = this.cold(sp);
    return total + (cold.nets.get(pid) ?? 0n) - (cold.held.get(pid) ?? 0n);
  }

  // ── The end ──

  /** The heal: no partition, every link the run's own, every page not gone
   *  up, and what the scenario did to them stops (no lag, no cheat: its
   *  pages run their frames; its events look at `healed`). */
  heal(): void {
    this.healed = true;
    this.net.reset();
    for (const sp of this.pages) {
      sp.pauseUntil = 0;
      sp.beforeFrame = null;
      sp.robotMotion = null;
      sp.afterRobot = null;
      if (sp.mode === 'asleep') this.wake(sp);
    }
  }

  /** The quiet period: bots stop putting felts down, and the room runs until
   *  every table has no tip, no felt anyone up is staked on, every view past
   *  its show, and nothing left to compact (`maxMs` at most). */
  async quiet(maxMs = 120_000): Promise<number> {
    for (const sp of this.pages) sp.betting = false;
    const from = this.T;
    await this.run(15_000);
    while (this.T - from < maxMs && !this.settled()) await this.run(SIM_STEP * 4);
    return this.T - from;
  }

  settled(): boolean {
    for (const sp of this.pages) {
      if (sp.mode !== 'up') continue;
      const now = this.enter(sp);
      const { casino, table } = sp.p;
      if (table.computedCompactionPending()) return false;
      for (const t of this.tables) {
        const res = casino.computedFoldOf(t);
        if (!res || !casino.isComputedTable(t)) continue;
        if (res.tip) return false;
        // 🎲 At craps: computedCrapsSim settledAt (riders' bets ride on).
        if (this.craps && this.gameOf(t) === 'craps') {
          if (!this.craps.settledAt(sp, t, now)) return false;
          continue;
        }
        const staked = [...res.felts.values()].filter((s) => s.rec.b.length > 0).map((s) => s.rec.p);
        if (staked.some((pid) => this.pages.some((q) => q.mode === 'up' && q.pid === pid))) return false;
        const v = table.readComputedRoulette(t, now);
        if (v && v.phase !== 'betting') return false;
      }
    }
    return true;
  }

  /** Every up page handed everything: in-flight updates, then full diffs
   *  each way until their docs hold the same; then every timer they set
   *  (the checks those left waiting). */
  async syncAll(): Promise<void> {
    await this.net.deliver(this.T, true);
    const up = this.pages.filter((sp) => sp.mode !== 'gone');
    for (let round = 0; round < 3; round++) {
      for (const a of up) {
        for (const b of up) {
          if (a === b) continue;
          await this.hear(b, Y.encodeStateAsUpdate(a.p.doc, Y.encodeStateVector(b.p.doc)), true);
        }
      }
    }
    for (let i = 0; i < 1_000 && up.some((sp) => sp.timers.length > 0); i++) for (const sp of up) await this.runTimers(sp, 1);
  }

  /** Where the up pages disagree (empty when they all agree): each table's
   *  fold, the last decided round its view shows, every incarnation's cold
   *  nets, every player's chips, the cage. */
  disagreements(): string[] {
    const up = this.pages.filter((sp) => sp.mode === 'up');
    const out: string[] = [];
    const ref = up[0];
    const pids = [...new Set(this.pages.map((q) => q.pid))].sort();
    const read = (sp: SimPage) => {
      const now = this.enter(sp);
      const { casino, table } = sp.p;
      const tables: Record<string, unknown> = {};
      for (const t of this.tables) {
        const res = casino.computedFoldOf(t);
        // 🎲 At craps: computedCrapsSim agreement (the fold with its carry
        // and every roll's craps fields; the view's roll, point, dice, holder).
        if (this.craps && this.gameOf(t) === 'craps') {
          tables[t] = this.craps.agreement(sp, t, res, now);
          continue;
        }
        const view = table.readComputedRoulette(t, now);
        const D = res && lastDecided(res);
        tables[t] = {
          fold: res ? snapshot(res) : null,
          // (Its phase aside: each page's clock runs its own.)
          view: view ? { inc: view.inc, spinKey: view.spinKey, round: view.round, result: view.result, decided: D?.r ?? null, pocket: D?.pocket ?? null } : null,
        };
      }
      const cold = this.cold(sp);
      const nets = [...cold.folds].map(([k, f]) => [k, [...f.res.nets].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, n]) => [p, n.toString()])]);
      const L = casino.readCageLedger();
      const balances = Object.keys(L.balances).sort().map((p) => [p, L.balances[p]]);
      return {
        tables, nets,
        chips: pids.map((pid) => [pid, casino.readChips(pid)]),
        cage: { ...L, balances },
      };
    };
    // 🤖 Each page's robot called what its screen shows (computedSimRobot R6).
    for (const sp of up) out.push(...this.robots.agreement(sp, this.enter(sp)));
    const want = read(ref);
    for (const sp of up.slice(1)) {
      const got = read(sp);
      for (const part of ['tables', 'nets', 'chips', 'cage'] as const) {
        const a = JSON.stringify(want[part]);
        const b = JSON.stringify(got[part]);
        if (a !== b) out.push(`${this.label}: ${sp.name}'s ${part} differ from ${ref.name}'s:\n  ${ref.name}: ${a.slice(0, 600)}\n  ${sp.name}: ${b.slice(0, 600)}`);
      }
    }
    return out;
  }

  /** A cold fold of the heaviest live session seen, its signatures checked
   *  afresh: what a page joining at that moment folds (trims bound it). ms
   *  of CPU time, and of the wall clock. */
  coldFold(): { cpu: number; wall: number } {
    const b = this.biggest;
    const sp = this.pages.find((q) => q.mode === 'up') ?? this.pages[0];
    if (!b) return { cpu: 0, wall: 0 };
    const wall = performance.now();
    const cpu = process.cpuUsage();
    const tf = new sp.p.fold.TableFold(b.ctx, this.checkFor(sp, b.ctx, false), b.keyOf, sp.p.fold.foldGameOf(b.ctx), (pub) => sp.p.casino.houseOkOf(pub));
    tf.setBase(b.cp);
    tf.reset(b.entries);
    tf.result();
    const spent = process.cpuUsage(cpu);
    return { cpu: (spent.user + spent.system) / 1_000, wall: performance.now() - wall };
  }

  /** The run's numbers (after the heal, the quiet period and syncAll). */
  summary(): SimSummary {
    const ref = this.pages.find((sp) => sp.mode === 'up') ?? this.pages[0];
    this.enter(ref);
    let rounds = 0;
    for (const f of this.cold(ref).folds.values()) rounds += lastDecided(f.res)?.r ?? f.res.base.u;
    const by = { reveals: 0, forfeit: 0, house: 0, void: 0 } as Record<string, number>;
    for (const d of this.decisions.values()) by[d] = (by[d] ?? 0) + 1;
    const sorted = [...this.warm].sort((a, b) => a - b);
    const wall = [...this.warmWall].sort((a, b) => a - b);
    const at = (xs: number[], q: number): number => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0);
    const pct = (q: number): number => at(sorted, q);
    const cold = this.coldFold();
    const flips: Record<string, number> = {};
    const flipKinds: Partial<Record<FlipKind, number>> = {};
    const writes: Record<string, number> = {};
    for (const sp of this.pages) {
      flips[sp.name] = sp.flips;
      for (const [k, n] of Object.entries(sp.flipKinds) as [FlipKind, number][]) flipKinds[k] = (flipKinds[k] ?? 0) + n;
      for (const [k, n] of Object.entries(sp.writes)) writes[k] = (writes[k] ?? 0) + n;
    }
    let trims = 0;
    for (const s of this.sids.values()) trims += s.size - 1;
    return {
      name: this.opts.name,
      seed: this.opts.seed,
      minutes: Math.round(this.elapsed / 6_000) / 10,
      pages: this.pages.length,
      rounds,
      byReveals: by.reveals,
      byForfeit: by.forfeit,
      byHouse: by.house,
      voids: by.void,
      flips,
      flipKinds,
      trims,
      maxDocBytes: this.maxDocBytes,
      maxSessionBytes: this.maxSessionBytes,
      maxPreTrimBytes: this.maxPreTrimBytes,
      maxRoundBytes: this.maxRoundBytes,
      worstStallMs: this.worstStall.ms,
      coldFoldMs: cold.cpu,
      coldFoldWallMs: cold.wall,
      warmP50Ms: pct(0.5),
      warmP95Ms: pct(0.95),
      warmMaxMs: pct(1),
      warmWallP95Ms: at(wall, 0.95),
      partialEpisodes: this.pages.reduce((n, sp) => n + sp.partialEpisodes, 0),
      slices: this.pages.reduce((n, sp) => n + sp.slices, 0),
      resyncAsks: this.pages.reduce((n, sp) => n + sp.resyncAsks, 0),
      roundsChecked: this.checkedRounds.size,
      forfeitsChecked: this.forfeitsChecked,
      abandonsChecked: this.abandonsChecked,
      writes,
      lost: this.net.lost,
    };
  }

  /** The one line a scenario prints. */
  static line(s: SimSummary, worst = ''): string {
    const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
    const kinds = Object.entries(s.flipKinds).map(([k, n]) => `${k} ${n}`).join(', ');
    const flips = Object.entries(s.flips).map(([k, n]) => `${k}:${n}`).join(',') + (kinds ? ` (${kinds})` : '');
    return `[sim] ${s.name} seed=${s.seed} ${s.pages}p ${s.minutes}min: rounds=${s.rounds} `
      + `(reveals ${s.byReveals}, forfeit ${s.byForfeit}${s.byHouse ? `, house ${s.byHouse}` : ''}, void ${s.voids}) flips=${flips} trims=${s.trims} `
      + `doc≤${kb(s.maxDocBytes)} session≤${kb(s.maxSessionBytes)} (pre-trim ≤${kb(s.maxPreTrimBytes)}, round ≤${kb(s.maxRoundBytes)}) `
      + `stall≤${(s.worstStallMs / 1000).toFixed(1)}s${worst ? ` [${worst}]` : ''} `
      + `coldFold=${s.coldFoldMs.toFixed(0)}ms cpu (${s.coldFoldWallMs.toFixed(0)} wall) `
      + `warm cpu p50=${s.warmP50Ms.toFixed(2)} p95=${s.warmP95Ms.toFixed(2)} max=${s.warmMaxMs.toFixed(1)}ms (wall p95=${s.warmWallP95Ms.toFixed(2)}) `
      + `partial=${s.partialEpisodes} resyncs=${s.resyncAsks} slices=${s.slices} checked=${s.roundsChecked} rounds, ${s.forfeitsChecked} forfeits, ${s.abandonsChecked} abandons `
      + `lost=${s.lost} writes=${JSON.stringify(s.writes)}`;
  }
}

const said = (s: Shown): string => `${s.decided} ${s.seen}`;

/** Nets as text, by player. */
const netsText = (m: ReadonlyMap<string, bigint>): string => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => [k, n.toString()]));

/** The last decided round on a fold's chain, or null. */
export function lastDecided(res: FoldResult): RoundView | null {
  for (let i = res.rounds.length - 1; i >= 0; i--) if (res.rounds[i].decided) return res.rounds[i];
  return null;
}
