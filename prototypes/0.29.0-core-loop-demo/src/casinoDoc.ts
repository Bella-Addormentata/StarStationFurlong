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
 *   bal:<playerId>            → number   current chips (written by its OWNER
 *                                        for buy-in/bet/cash-out, and by the
 *                                        CROUPIER for payouts — see below)
 *   bought:<playerId>         → number   lifetime chips issued to the player
 *   cashed:<playerId>         → number   lifetime chips returned to the cage
 *   table:<tableId>           → RouletteTableState (croupier-written)
 *   bets:<tableId>:<playerId> → { round, bets: RouletteBet[] } (owner-written)
 *
 * Every player-scoped key is written by exactly one writer in normal play, so
 * per-key LWW is safe. The one shared writer pair is bal:<pid> (owner spends,
 * croupier credits payouts): the windows are disjoint in practice — players
 * bet during 'betting', the croupier credits at the settle write — and a
 * dev-phase race degrades to one lost update, visible in the public cage
 * ledger. Documented v1 semantics; the G4 Registry chips close it for real.
 *
 * The HOUSE keeps no stored record at all — everything about the cage is
 * DERIVED: issued = Σ bought, outstanding = Σ bal, house net = issued −
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
import { isRouletteBet, isRouletteTableState } from './games/roulette';
import type { RouletteBet, RouletteTableState } from './games/roulette';
import { isCrapsBet, isCrapsTableState } from './games/craps';
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

/** One player's open bets on one table (round-stamped: stale rounds ignore). */
export interface TableBets {
  round: number;
  bets: RouletteBet[];
}

/** 🎲 One player's craps bets. Unlike roulette these PERSIST across rolls (a
 *  pass line rides its point; a place bet stays working), so there is no round
 *  stamp — the stickman prunes the list at each settle (see games/craps.ts). */
export interface CrapsTableBets {
  kind: 'craps';
  bets: CrapsBet[];
}

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

export function bindCasinoDoc(doc: Y.Doc): void {
  bindingEpoch += 1;
  boundDoc = doc;
  casinoMap = doc.getMap('casino');
  // 🪙 Index the coin pushers' requests now, outside any operator poll, and
  // observe ahead of notify() so listeners never see a stale index.
  pusherRequestIndex(casinoMap);
  casinoMap.observe((event) => notify(event.keysChanged));
  notify(); // repaint subscribers from the fresh doc
}

export function casinoDocEpoch(): number {
  return bindingEpoch;
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

/** Non-negative integer read (doc values cross the peer trust boundary). */
function readCount(key: string): number {
  const v = ensureMap().get(key);
  return Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0;
}

function writeCount(key: string, value: number): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(key, Math.max(0, Math.floor(value)));
  });
}

// ── Chips ────────────────────────────────────────────────────────────────────

export function readChips(playerId: string): number {
  return readCount(`bal:${playerId}`);
}

/** Cashier BUY-IN: the cage issues chips to the player (own-key writes). */
export function buyInChips(playerId: string, amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) return;
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`bal:${playerId}`, readCount(`bal:${playerId}`) + amount);
    map.set(`bought:${playerId}`, readCount(`bought:${playerId}`) + amount);
  });
}

/** Cashier CASH-OUT: chips go back to the cage. Returns chips returned. */
export function cashOutChips(playerId: string, amount: number): number {
  const bal = readChips(playerId);
  const n = Math.min(bal, Math.max(0, Math.floor(amount)));
  if (n <= 0) return 0;
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`bal:${playerId}`, bal - n);
    map.set(`cashed:${playerId}`, readCount(`cashed:${playerId}`) + n);
  });
  return n;
}

/** Stake chips on the felt (bet placement). False when the balance is short. */
export function spendChips(playerId: string, amount: number): boolean {
  if (!Number.isInteger(amount) || amount <= 0) return false;
  const bal = readChips(playerId);
  if (bal < amount) return false;
  writeCount(`bal:${playerId}`, bal - amount);
  return true;
}

/** Return chips to a player (bet refund by its owner, payout by the croupier). */
export function creditChips(playerId: string, amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) return;
  writeCount(`bal:${playerId}`, readChips(playerId) + amount);
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
  let issued = 0, cashed = 0, outstanding = 0;
  const balances: Record<string, number> = {};
  for (const [key, value] of map.entries()) {
    if (!Number.isInteger(value) || (value as number) < 0) continue;
    const n = value as number;
    if (key.startsWith('bought:')) issued += n;
    else if (key.startsWith('cashed:')) cashed += n;
    else if (key.startsWith('bal:')) {
      outstanding += n;
      if (n > 0) balances[key.slice(4)] = n;
    }
  }
  return { issued, cashed, outstanding, houseNet: issued - cashed - outstanding, balances };
}

// ── Roulette table state + bets ──────────────────────────────────────────────

export function readTableState(tableId: string): RouletteTableState | null {
  const value = ensureMap().get(`table:${tableId}`);
  return isRouletteTableState(value) ? value : null;
}

/** Croupier-only in practice (the UI gates on the house predicate). */
export function writeTableState(tableId: string, state: RouletteTableState): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`table:${tableId}`, state);
  });
}

/** 🎰 Wipe every casino key for a table (its state, croupier heartbeat, and all
 *  per-player bets) — the removal teardown so a deleted table leaves no orphan
 *  records. Refunding outstanding stakes is the CALLER's job (croupier.closeTable),
 *  done before this so the bet records are still readable. One transact. */
export function clearTableKeys(tableId: string): void {
  const map = ensureMap();
  const betPrefix = `bets:${tableId}:`;
  boundDoc!.transact(() => {
    map.delete(`table:${tableId}`);
    map.delete(`croupier:${tableId}`);
    // 🎲 The per-table config keys ride the same map — a removed table must
    // not leave orphaned settings behind (harmless no-op for roulette, which
    // never writes them).
    map.delete(`cfg:backend:${tableId}`);
    map.delete(`cfg:fairness:${tableId}`);
    for (const key of [...map.keys()]) {
      if (key.startsWith(betPrefix)) map.delete(key);
    }
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

function isTableBets(value: unknown): value is TableBets {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<TableBets>;
  return Number.isInteger(t.round) && (t.round as number) >= 1
    && Array.isArray(t.bets) && t.bets.every(isRouletteBet);
}

export function readMyBets(tableId: string, playerId: string, round: number): RouletteBet[] {
  const value = ensureMap().get(`bets:${tableId}:${playerId}`);
  if (!isTableBets(value) || value.round !== round) return [];
  return value.bets;
}

export function writeMyBets(tableId: string, playerId: string, round: number, bets: RouletteBet[]): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`bets:${tableId}:${playerId}`, { round, bets });
  });
}

/** Every player's bets for THIS round of one table (the croupier's settle
 *  read; also drives the "on the felt" spectator totals). */
export function readAllBets(tableId: string, round: number): Record<string, RouletteBet[]> {
  const prefix = `bets:${tableId}:`;
  const out: Record<string, RouletteBet[]> = {};
  for (const [key, value] of ensureMap().entries()) {
    if (!key.startsWith(prefix)) continue;
    if (!isTableBets(value) || value.round !== round) continue;
    if (value.bets.length === 0) continue;
    out[key.slice(prefix.length)] = value.bets;
  }
  return out;
}

// ── 🎲 Craps table state + bets (#69 G3) ─────────────────────────────────────
// Same casino-map keys as roulette (`table:<id>`, `bets:<id>:<pid>`) — a given
// table is one game, so the shapes never collide, and clearTableKeys /
// creditChips / the croupier heartbeat are already game-agnostic. Craps bets are
// NOT round-stamped: they carry across rolls until the stickman prunes them.

export function readCrapsTableState(tableId: string): CrapsTableState | null {
  const value = ensureMap().get(`table:${tableId}`);
  return isCrapsTableState(value) ? value : null;
}

/** Stickman-only in practice (the UI gates on the house predicate). */
export function writeCrapsTableState(tableId: string, state: CrapsTableState): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`table:${tableId}`, state);
  });
}

function isCrapsTableBets(value: unknown): value is CrapsTableBets {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<CrapsTableBets>;
  return t.kind === 'craps' && Array.isArray(t.bets) && t.bets.every(isCrapsBet);
}

export function readMyCrapsBets(tableId: string, playerId: string): CrapsBet[] {
  const value = ensureMap().get(`bets:${tableId}:${playerId}`);
  return isCrapsTableBets(value) ? value.bets : [];
}

export function writeMyCrapsBets(tableId: string, playerId: string, bets: CrapsBet[]): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`bets:${tableId}:${playerId}`, { kind: 'craps', bets });
  });
}

/** Every player's standing craps bets on one table (the stickman's settle read;
 *  also drives the "on the felt" spectator view). Empty lists are omitted. */
export function readAllCrapsBets(tableId: string): Record<string, CrapsBet[]> {
  const prefix = `bets:${tableId}:`;
  const out: Record<string, CrapsBet[]> = {};
  for (const [key, value] of ensureMap().entries()) {
    if (!key.startsWith(prefix)) continue;
    if (!isCrapsTableBets(value) || value.bets.length === 0) continue;
    out[key.slice(prefix.length)] = value.bets;
  }
  return out;
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
}

function isSlotOperatorLease(value: unknown): value is SlotOperatorLease {
  if (typeof value !== 'object' || value === null) return false;
  const lease = value as Partial<SlotOperatorLease>;
  return typeof lease.playerId === 'string' && lease.playerId.length > 0
    && lease.playerId.length <= 128
    && typeof lease.sessionId === 'string' && lease.sessionId.length > 0
    && lease.sessionId.length <= 128
    && typeof lease.expiresAt === 'number' && Number.isFinite(lease.expiresAt);
}

export function readSlotOperatorLease(machineId: string): SlotOperatorLease | null {
  const value = ensureMap().get(`slot-operator:${machineId}`);
  return isSlotOperatorLease(value) ? value : null;
}

export function writeSlotOperatorLease(
  machineId: string,
  lease: SlotOperatorLease,
): void {
  if (!isSlotOperatorLease(lease)) return;
  ensureMap().set(`slot-operator:${machineId}`, lease);
}

export function clearSlotOperatorLease(machineId: string): void {
  ensureMap().delete(`slot-operator:${machineId}`);
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
  if (config.mode === 'machine') return `slot-bankroll:machine:${machineId}`;
  return 'slot-bankroll:shared';
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
  return safeCount(ensureMap(), slotFundingBalanceKey(machineId, config));
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
  const ownerKey = `bal:${ownerId}`;
  const fundingKey = slotFundingBalanceKey(machineId, config);
  const ownerBalance = safeCount(map, ownerKey);
  const fundingBalance = safeCount(map, fundingKey);
  if (ownerBalance < amount || !Number.isSafeInteger(fundingBalance + amount)) return false;
  boundDoc!.transact(() => {
    map.set(ownerKey, ownerBalance - amount);
    map.set(fundingKey, fundingBalance + amount);
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
  const ownerKey = `bal:${ownerId}`;
  const fundingKey = slotFundingBalanceKey(machineId, config);
  const ownerBalance = safeCount(map, ownerKey);
  const fundingBalance = safeCount(map, fundingKey);
  if (fundingBalance < amount || !Number.isSafeInteger(ownerBalance + amount)) return false;
  boundDoc!.transact(() => {
    map.set(fundingKey, fundingBalance - amount);
    map.set(ownerKey, ownerBalance + amount);
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
  const playerBalance = safeCount(map, playerKey);
  if (playerBalance < bet) return 'insufficient-player-funds';
  if (safeCount(map, escrowKey) > 0) return 'insufficient-bankroll';

  const sameAccount = playerKey === fundingKey;
  const fundingBalance = safeCount(map, fundingKey);
  const afterStake = sameAccount ? fundingBalance : fundingBalance + bet;
  if (!Number.isSafeInteger(afterStake) || afterStake < maximumPayout) {
    return 'insufficient-bankroll';
  }

  boundDoc!.transact(() => {
    if (!sameAccount) map.set(playerKey, playerBalance - bet);
    map.set(fundingKey, afterStake - maximumPayout);
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
  const fundingBalance = safeCount(map, fundingKey);
  const playerBalance = safeCount(map, playerKey);
  const returned = escrow - payout;
  const sameAccount = fundingKey === playerKey;
  const nextFunding = fundingBalance + returned + (sameAccount ? payout : 0);
  const nextPlayer = playerBalance + payout;
  if (!Number.isSafeInteger(nextFunding)
    || (!sameAccount && !Number.isSafeInteger(nextPlayer))) return false;
  boundDoc!.transact(() => {
    map.delete(escrowKey);
    map.set(fundingKey, nextFunding);
    if (!sameAccount && payout > 0) map.set(playerKey, nextPlayer);
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
  const fundingBalance = safeCount(map, fundingKey);
  const playerBalance = safeCount(map, playerKey);
  const sameAccount = fundingKey === playerKey;
  if (!sameAccount && fundingBalance + escrow < bet) return false;
  const nextFunding = sameAccount
    ? fundingBalance + escrow
    : fundingBalance + escrow - bet;
  const nextPlayer = sameAccount ? nextFunding : playerBalance + bet;
  if (!Number.isSafeInteger(nextFunding) || !Number.isSafeInteger(nextPlayer)) return false;
  boundDoc!.transact(() => {
    map.delete(escrowKey);
    map.set(fundingKey, nextFunding);
    if (!sameAccount) map.set(playerKey, nextPlayer);
  });
  return true;
}

/** Return a removed machine's private bankroll to the configured owner. */
export function drainSlotMachineFunding(machineId: string): void {
  const config = readSlotFundingConfig(machineId);
  if (!config) return;
  const map = ensureMap();
  const fundingKey = `slot-bankroll:machine:${machineId}`;
  const amount = safeCount(map, fundingKey);
  if (amount <= 0) return;
  const ownerKey = `bal:${config.ownerId}`;
  const ownerBalance = safeCount(map, ownerKey);
  if (!Number.isSafeInteger(ownerBalance + amount)) return;
  boundDoc!.transact(() => {
    map.delete(fundingKey);
    map.set(ownerKey, ownerBalance + amount);
  });
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
    map.delete(`slot-bankroll:machine:${machineId}`);
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
//   pusher-operator:<mid>   → operator lease     (one browser session operates)
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
// peer-writable record, so forging the machine can't pay the forger.
//
// PARTITIONS: the operator lease is a Y.Map record, not a mutex; see
// pusherCroupier.ts for how a second session of the same deed holder is kept
// from operating while the first may only be cut off.

/** Same field-for-field record the slot operator uses. */
export type CoinPusherOperatorLease = SlotOperatorLease;

export function readCoinPusherState(machineId: string): CoinPusherState | null {
  const value = ensureMap().get(`pusher:${machineId}`);
  return isCoinPusherState(value) ? value : null;
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
// walks the map.
interface PusherRequestIndex {
  /** machineId → the keys holding its filed requests, in arrival order. */
  byMachine: Map<string, Set<string>>;
  /** key → the machine it is filed under (to unfile it when it changes). */
  machineOf: Map<string, string>;
  /** `<family><first segment of mid>` → every key of the per-player families
   *  that begins so, filed by name alone whatever it holds (a removal sweeps
   *  a machine's keys from here — see startCoinPusherKeySweep). */
  byBucket: Map<string, Set<string>>;
}

const pusherRequestIndexes = new WeakMap<Y.Map<unknown>, PusherRequestIndex>();
const PUSHER_REQUEST_PREFIX = 'pusher-req:';
/** The per-player key families under `<family><mid>:` (`pusher-esc:` is an
 *  earlier revision's escrow, still cleared with its machine). */
const PUSHER_PLAYER_FAMILIES = [PUSHER_REQUEST_PREFIX, 'pusher-result:', 'pusher-esc:'] as const;

/** `<family><first segment of the rest>`: the bucket a per-player key is filed
 *  in. Machine ids never need to be told apart here — a sweep deletes only the
 *  keys that start with the machine's full prefix. */
function pusherBucketOf(family: string, key: string): string | null {
  const cut = key.indexOf(':', family.length);
  return cut < 0 ? null : key.slice(0, cut);
}

/** Keys a sweep looks at per batch (continueCoinPusherKeySweep). */
export const PUSHER_SWEEP_BATCH = 64;

/**
 * A removed machine's per-player keys (requests, answers, and `pusher-esc:`
 * escrows an earlier revision left), deleted a batch at a time after the
 * drain, so a flood of them can't stall a frame. None of them carries chips.
 * It works in passes over the index's buckets for the machine, with live
 * iterators: a key deleted meanwhile is skipped. A pass that deleted anything
 * is followed by another over every family, so a key added meanwhile (a stale
 * request, or a late answer) is swept too, even in a family already passed.
 * The sweep ends after a whole pass that finds nothing to delete.
 */
export interface CoinPusherKeySweep {
  readonly machineId: string;
  /** The map it was started on — a sweep never touches another room's. */
  readonly map: Y.Map<unknown>;
  /** This pass's iterators, one per family bucket still to walk. */
  cursors: Iterator<string>[];
  /** Whether this pass has found any of the machine's keys. */
  found: boolean;
}

/** Fresh iterators over the machine's buckets in the index, one per family. */
function sweepCursors(map: Y.Map<unknown>, machineId: string): Iterator<string>[] {
  const index = pusherRequestIndex(map);
  const cursors: Iterator<string>[] = [];
  for (const family of PUSHER_PLAYER_FAMILIES) {
    const bucket = pusherBucketOf(family, `${family}${machineId}:`);
    const keys = bucket === null ? undefined : index.byBucket.get(bucket);
    if (keys) cursors.push(keys.values());
  }
  return cursors;
}

export function startCoinPusherKeySweep(machineId: string): CoinPusherKeySweep {
  const map = ensureMap();
  return { machineId, map, cursors: sweepCursors(map, machineId), found: false };
}

/**
 * Look at up to `max` more of the sweep's keys and delete those that are the
 * machine's, in one transaction. True once a whole pass has found none of its
 * keys, or when the bound doc is no longer the one it started on (nothing is
 * touched then).
 */
export function continueCoinPusherKeySweep(
  sweep: CoinPusherKeySweep,
  max: number = PUSHER_SWEEP_BATCH,
): boolean {
  if (!docAlive() || casinoMap !== sweep.map) return true;
  const prefixes = PUSHER_PLAYER_FAMILIES.map((family) => `${family}${sweep.machineId}:`);
  const doomed: string[] = [];
  let looked = 0;
  let finished = false;
  while (looked < max) {
    if (sweep.cursors.length === 0) {
      // The pass is over. One that found nothing ends the sweep; otherwise
      // start another, once this batch's deletions are in.
      if (!sweep.found) {
        finished = true;
        break;
      }
      if (doomed.length > 0) break;
      sweep.cursors = sweepCursors(sweep.map, sweep.machineId);
      sweep.found = false;
      continue;
    }
    const next = sweep.cursors[0].next();
    if (next.done) {
      sweep.cursors.shift();
      continue;
    }
    looked += 1;
    // A bucket also holds the keys of a machine whose id extends this one's
    // first segment (a colon in an id): those are left alone.
    if (prefixes.some((prefix) => next.value.startsWith(prefix))) {
      doomed.push(next.value);
      sweep.found = true;
    }
  }
  if (doomed.length > 0) {
    boundDoc!.transact(() => {
      for (const key of doomed) sweep.map.delete(key);
    });
  }
  return finished;
}

/** The machine a value under `key` is a request for, or null when it is not
 *  a well-formed request filed under its own player's key
 *  (`pusher-req:<mid>:<pid>` with `<pid>` its player — the cross-key guard).
 *  The player fixes where `<mid>` ends, so a colon in either id can't file a
 *  request under the wrong machine. */
function filedRequestMachine(key: string, value: unknown): string | null {
  if (!key.startsWith(PUSHER_REQUEST_PREFIX) || !isPusherInsertRequest(value)) return null;
  const tail = `:${value.player}`;
  const end = key.length - tail.length;
  if (end <= PUSHER_REQUEST_PREFIX.length || !key.endsWith(tail)) return null;
  return key.slice(PUSHER_REQUEST_PREFIX.length, end);
}

/** File `key` afresh: any change is a new arrival, so it goes to the back. */
function reindexPusherRequest(index: PusherRequestIndex, key: string, value: unknown): void {
  const was = index.machineOf.get(key);
  if (was !== undefined) {
    const keys = index.byMachine.get(was);
    keys?.delete(key);
    if (keys?.size === 0) index.byMachine.delete(was);
    index.machineOf.delete(key);
  }
  const machineId = filedRequestMachine(key, value);
  if (machineId === null) return;
  let keys = index.byMachine.get(machineId);
  if (!keys) {
    keys = new Set();
    index.byMachine.set(machineId, keys);
  }
  keys.add(key);
  index.machineOf.set(key, machineId);
}

/** Re-file one changed key of the casino map (a no-op for other keys). */
function reindexPusherKey(index: PusherRequestIndex, map: Y.Map<unknown>, key: string): void {
  const family = PUSHER_PLAYER_FAMILIES.find((f) => key.startsWith(f));
  if (family === undefined) return;
  if (family === PUSHER_REQUEST_PREFIX) reindexPusherRequest(index, key, map.get(key));
  const bucket = pusherBucketOf(family, key);
  if (bucket === null) return;
  let keys = index.byBucket.get(bucket);
  if (map.has(key)) {
    if (!keys) {
      keys = new Set();
      index.byBucket.set(bucket, keys);
    }
    keys.add(key);
  } else if (keys) {
    keys.delete(key);
    if (keys.size === 0) index.byBucket.delete(bucket);
  }
}

/** The bound map's request index (built by bindCasinoDoc). */
function pusherRequestIndex(map: Y.Map<unknown>): PusherRequestIndex {
  const existing = pusherRequestIndexes.get(map);
  if (existing) return existing;
  const index: PusherRequestIndex = {
    byMachine: new Map(), machineOf: new Map(), byBucket: new Map(),
  };
  for (const key of map.keys()) reindexPusherKey(index, map, key);
  map.observe((event) => {
    for (const key of event.keysChanged) reindexPusherKey(index, map, key);
  });
  pusherRequestIndexes.set(map, index);
  return index;
}

/** Up to `limit` of this machine's insert requests, oldest first (the
 *  requestId leads with the base-36 request time — the slot-request
 *  precedent), from the first PUSHER_REQUEST_SCAN in arrival order. It reads
 *  the machine's index, never the whole map, so its cost grows neither with
 *  what peers write elsewhere nor with a flood of requests. Shape- and
 *  cross-key-guarded: a request whose `player` disagrees with the `<pid>` in
 *  its key is ignored. */
export function readCoinPusherRequests(
  machineId: string,
  limit = PUSHER_REQUEST_SCAN,
): PusherInsertRequest[] {
  const map = ensureMap();
  const keys = pusherRequestIndex(map).byMachine.get(machineId);
  const out: PusherInsertRequest[] = [];
  let looked = 0;
  for (const key of keys ?? []) {
    if (looked++ === PUSHER_REQUEST_SCAN) break;
    const value = map.get(key);
    if (isPusherInsertRequest(value)) out.push(value);
  }
  out.sort((a, b) => a.requestId.localeCompare(b.requestId));
  return out.slice(0, Math.max(0, limit));
}

/** One player's pending request on this machine (null when none). */
export function readCoinPusherRequest(
  machineId: string,
  playerId: string,
): PusherInsertRequest | null {
  const value = ensureMap().get(`pusher-req:${machineId}:${playerId}`);
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
  ensureMap().set(`pusher-req:${machineId}:${request.player}`, request);
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
  ensureMap().delete(`pusher-req:${machineId}:${playerId}`);
  return true;
}

/** The operator's answer to `playerId`'s latest request (null before the first). */
export function readCoinPusherResult(machineId: string, playerId: string): PusherResult | null {
  const value = ensureMap().get(`pusher-result:${machineId}:${playerId}`);
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

export function readCoinPusherOperatorLease(machineId: string): CoinPusherOperatorLease | null {
  const value = ensureMap().get(`pusher-operator:${machineId}`);
  return isSlotOperatorLease(value) ? value : null;
}

export function writeCoinPusherOperatorLease(
  machineId: string,
  lease: CoinPusherOperatorLease,
): void {
  if (!isSlotOperatorLease(lease)) return;
  ensureMap().set(`pusher-operator:${machineId}`, lease);
}

export function clearCoinPusherOperatorLease(machineId: string): void {
  ensureMap().delete(`pusher-operator:${machineId}`);
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
  const balanceKey = `bal:${request.player}`;
  const balance = safeCount(map, balanceKey);
  if (balance < PUSHER_ANTE) return 'no-chips';
  const nextBalance = balance - PUSHER_ANTE + paid;
  if (!Number.isSafeInteger(nextBalance)) return 'invalid';
  const result: PusherResult = {
    kind: 'drop', requestId: request.requestId, paid, honored: drop.honored, atMs: drop.atMs,
  };
  boundDoc!.transact(() => {
    map.set(`pusher:${machineId}`, normalized);
    map.set(balanceKey, nextBalance);
    map.set(`pusher-result:${machineId}:${request.player}`, result);
    map.delete(`pusher-req:${machineId}:${request.player}`);
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
    map.set(`pusher-result:${machineId}:${request.player}`, result);
    map.delete(`pusher-req:${machineId}:${request.player}`);
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
  const ownerKey = `bal:${base.ownerId}`;
  const ownerBalance = safeCount(map, ownerKey);
  if (!Number.isSafeInteger(ownerBalance + emptied)) return null;
  const answer: PusherDoorResult = { kind: 'opened', requestId: request.requestId, emptied, atMs };
  boundDoc!.transact(() => {
    map.set(`pusher:${machineId}`, normalized);
    if (emptied > 0) map.set(ownerKey, ownerBalance + emptied);
    map.set(`pusher-door:${machineId}`, answer);
    map.delete(`pusher-empty:${machineId}`);
  });
  return emptied;
}

/**
 * Teardown for a removed cabinet, run only by the deed holder's session that
 * operates the machine, or could take it over by the election's rule
 * (pusherCroupier.closeCoinPusher), so it never merges with a drop another
 * session is still settling: credit the chips still inside to `recipientId`,
 * the deed holder running it, and delete every key the machine used, in ONE
 * transaction. The recipient is the caller's own identity, never
 * the `ownerId` stored in the peer-writable machine, so a forged machine can
 * only ever pay the deed holder (the operator re-owns every machine it runs,
 * so in honest play they are the same). This transaction touches only the
 * machine's own keys, a fixed few. Its per-player keys carry no chips and are
 * deleted afterwards, a batch at a time (startCoinPusherKeySweep). Returns the
 * chips credited.
 */
export function drainAndClearCoinPusher(machineId: string, recipientId: string): number {
  const map = ensureMap();
  const state = readCoinPusherState(machineId);
  const inside = state ? chipsInMachine(state) : 0;
  const ownerKey = `bal:${recipientId}`;
  const ownerBalance = safeCount(map, ownerKey);
  const credit = inside > 0 && recipientId.length > 0 && recipientId.length <= 128
    && Number.isSafeInteger(ownerBalance + inside) ? inside : 0;
  boundDoc!.transact(() => {
    if (credit > 0) map.set(ownerKey, ownerBalance + credit);
    map.delete(`pusher:${machineId}`);
    map.delete(`pusher-empty:${machineId}`);
    map.delete(`pusher-door:${machineId}`);
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
    readChips, buyInChips, cashOutChips, spendChips, creditChips,
    readCageLedger, readTableState, writeTableState, readMyBets, writeMyBets, readAllBets,
    readCroupierBeat, writeCroupierBeat,
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
    readCoinPusherOperatorLease,
  };
}
