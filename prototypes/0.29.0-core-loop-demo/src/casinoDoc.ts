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
// 🏒 #115: air-hockey pay-to-play fees ride the same chip ledger. The
// gamesDoc import is a READ-ONLY seam (fee configs must name the CURRENT
// room owner — see readAirHockeyFeeConfig); no transactional coupling, and
// no cycle (gamesDoc imports only the pure game engines).
import { isAirHockeyFeeConfig, isAirHockeyPaidRecord } from './games/airHockey';
import type { AirHockeyFeeConfig, AirHockeyPaidRecord } from './games/airHockey';
import { readRoomOwner } from './games/gamesDoc';

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

// ── 🏒 Air-hockey fees (#115) ────────────────────────────────────────────────
//
// Key layout (same LWW rules as everything above):
//   ah-fee:<tableId>             → AirHockeyFeeConfig   owner-written config
//   ah-paid:<tableId>:<playerId> → AirHockeyPaidRecord  the payer's escrow
//
// Money moves through PER-PLAYER ESCROW RECORDS so every key keeps exactly
// one writer per lifecycle phase (the slot-escrow precedent, per player):
//
//   pay      PAYER    one transact: bal:<self> −= fee, record set 'held'
//   refund   PAYER    one transact: record deleted,   bal:<self> += amount
//   finalize PAYER    one transact: record 'held' → 'final' (start observed)
//   sweep    OWNER    one transact: records 'final' addressed to me deleted,
//                     bal:<self> += Σ amounts
//
// The payer only ever writes their OWN balance and their OWN record; the
// owner only credits their OWN balance and deletes records already handed
// over ('final'). Concurrent pays, refunds, or sweeps therefore touch
// disjoint keys — per-key LWW can neither mint nor destroy chips, which the
// previous direct player→owner transfer could under concurrent read-modify-
// writes of bal:<owner>. A refund needs no owner-balance check any more
// (the escrowed chips never reached the owner), so a pre-start un-ready
// always gets its money back.
//
// Orphan self-healing: airHockeySession runs airHockeyEscrowAction (pure,
// games/airHockey.ts) over MY records on a slow timer — a crash, reset,
// kick, or table removal strands a 'held' record and the payer refunds it
// on return; 'final' records wait for their owner's sweep. Ties break to
// the player: a held record whose match cannot be proven to have run
// refunds rather than finalizes.
//
// Known bound (documented, not exploitable for gain): an un-ready refund
// racing the opponent's match-start write across a sync gap can leave the
// started state carrying paid[side] > 0 with no record — the player got
// their fee back yet the match plays. Bounded at one fee ≤ AH_MAX_FEE,
// requires a genuine sub-sync race, and biases to the PLAYER like every
// other tie here. The prior design turned this same race into unbounded
// chip minting; an auto-recharge variant was rejected because a crash-
// rejoin after the owner's sweep could not distinguish "settled and swept"
// from "refund raced the start" and would double-charge an innocent player.
//
// Same-player, multi-client caveat: "one writer per key" means one CLIENT —
// a player running two concurrent tabs is two writers of their own keys and
// inherits the map-wide lost-update semantics every chips lane already has
// (spendChips's read-modify-write of bal:<self> included). Honest same-base
// races still converge safely: two tabs refunding the same record both
// compute base + amount, so LWW lands on ONE credit.
//
// Trust boundary (the same one every chips key already has): map writes are
// unauthenticated, so a hostile peer can forge whole records — a fake 'held'
// record makes its named payer's own upkeep credit that payer, a fake
// 'final' makes its named owner's sweep credit that owner. Neither hands
// the FORGER anything a direct write of bal:<target> would not, and
// AH_MAX_FEE caps each record, not the aggregate across forged keys, so
// this lane adds no new power — only a new shape — inside the boundary.
// Authenticated authorship (the roadmapped signing work) is the real fix
// here, exactly as it is for the balances themselves.

/** Escrow record key — payer-scoped, like `bets:<tableId>:<playerId>`. */
function airHockeyPaidKey(tableId: string, playerId: string): string {
  return `ah-paid:${tableId}:${playerId}`;
}

/**
 * The table's fee config, validated TWICE: shape (peer trust boundary) and
 * recipient — config.ownerId must be the CURRENT room owner, read through
 * gamesDoc from the same room doc. A stale or hostile config naming anyone
 * else reads as "no fee" instead of routing chips to the wrong pocket;
 * offline (no room, no owner) every config is rejected, matching the UI
 * rule that an ownerless room has no fee knob.
 */
export function readAirHockeyFeeConfig(tableId: string): AirHockeyFeeConfig | null {
  const value = ensureMap().get(`ah-fee:${tableId}`);
  if (!isAirHockeyFeeConfig(value)) return null;
  const owner = readRoomOwner();
  return owner !== null && value.ownerId === owner ? value : null;
}

/** Room owner only — callers gate via isHouse (the slot-odds precedent);
 *  the recipient check makes a mis-stamped config unwritable, not just
 *  unreadable. */
export function writeAirHockeyFeeConfig(tableId: string, config: AirHockeyFeeConfig): void {
  if (!isAirHockeyFeeConfig(config) || config.ownerId !== readRoomOwner()) return;
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`ah-fee:${tableId}`, config);
  });
}

/** My escrow record on one table, shape-guarded (peer trust boundary). */
export function readAirHockeyPaidRecord(
  tableId: string,
  playerId: string,
): AirHockeyPaidRecord | null {
  const value = ensureMap().get(airHockeyPaidKey(tableId, playerId));
  return isAirHockeyPaidRecord(value) ? value : null;
}

/** Every escrow record in the room — the session reconciler/sweep scan.
 *  Guarded parse; the key's own segments name the table and payer (records
 *  outlive their table's game state after a removal, so the key is the only
 *  index). Keys with ':' inside the table id cannot collide: player ids are
 *  the LAST segment and contain no ':' (identity.ts format). */
export function scanAirHockeyPaidRecords(): Array<{
  tableId: string;
  playerId: string;
  record: AirHockeyPaidRecord;
}> {
  const map = ensureMap();
  const out: Array<{ tableId: string; playerId: string; record: AirHockeyPaidRecord }> = [];
  for (const [key, value] of map.entries()) {
    if (!key.startsWith('ah-paid:')) continue;
    if (!isAirHockeyPaidRecord(value)) continue;
    const rest = key.slice('ah-paid:'.length);
    const cut = rest.lastIndexOf(':');
    if (cut <= 0 || cut >= rest.length - 1) continue;
    out.push({ tableId: rest.slice(0, cut), playerId: rest.slice(cut + 1), record: value });
  }
  return out;
}

/**
 * Escrow my ready-up fee: one transaction debits MY balance and creates MY
 * 'held' record — the owner's balance is untouched until they sweep the
 * finalized record. Returns the chips escrowed — 0 when nothing is owed
 * (fee off / zero / the owner playing their own table), or null when my
 * balance cannot cover it (ready refused). IDEMPOTENT: an existing record
 * (a crash between pay and the ready write, retried) is reused at ITS
 * amount — no double debit; a leftover 'final' from a reverted start counts
 * for the restarted match rather than charging twice. The reuse check runs
 * BEFORE the config gates: chips already escrowed are the truth even if the
 * owner has since disabled or re-priced the fee.
 */
export function payAirHockeyFee(tableId: string, playerId: string): number | null {
  const existing = readAirHockeyPaidRecord(tableId, playerId);
  if (existing) return existing.amount;
  const config = readAirHockeyFeeConfig(tableId);
  if (!config || !config.enabled || config.feeAmount <= 0) return 0;
  if (config.ownerId === playerId) return 0;
  const map = ensureMap();
  const playerKey = `bal:${playerId}`;
  const playerBalance = safeCount(map, playerKey);
  const fee = config.feeAmount;
  if (playerBalance < fee) return null;
  const record: AirHockeyPaidRecord = { amount: fee, ownerId: config.ownerId, state: 'held' };
  boundDoc!.transact(() => {
    map.set(playerKey, playerBalance - fee);
    map.set(airHockeyPaidKey(tableId, playerId), record);
  });
  return fee;
}

/**
 * Return MY pre-start escrow: one transaction deletes MY 'held' record and
 * credits MY balance its amount — no owner key involved, so a refund can
 * never be "not covered" and record-existence makes double refunds
 * structurally impossible. Returns the chips returned (0 = nothing held).
 * 'final' records are never refunded — fees are final once the match
 * starts; those wait for the owner's sweep.
 */
export function refundAirHockeyFee(tableId: string, playerId: string): number {
  const record = readAirHockeyPaidRecord(tableId, playerId);
  if (!record || record.state !== 'held') return 0;
  const map = ensureMap();
  const playerKey = `bal:${playerId}`;
  const playerBalance = safeCount(map, playerKey);
  // Guard-only branch: an honest balance can't approach 2^53. Keep the
  // record so a later retry can still make the player whole.
  if (!Number.isSafeInteger(playerBalance + record.amount)) return 0;
  boundDoc!.transact(() => {
    map.delete(airHockeyPaidKey(tableId, playerId));
    map.set(playerKey, playerBalance + record.amount);
  });
  return record.amount;
}

/**
 * Promote MY 'held' record to 'final' — called when the payer OBSERVES the
 * match start (startedAt stamped while they are seated). One-way: from here
 * only the recorded owner's sweep moves the money. True when a promotion
 * happened (false = no record / already final).
 */
export function finalizeAirHockeyFee(tableId: string, playerId: string): boolean {
  const record = readAirHockeyPaidRecord(tableId, playerId);
  if (!record || record.state !== 'held') return false;
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(airHockeyPaidKey(tableId, playerId), { ...record, state: 'final' });
  });
  return true;
}

/**
 * Collect every 'final' record addressed to ME, across all tables, in one
 * transaction: my balance += Σ amounts, records deleted. Self-limiting —
 * records name their recipient, so a non-owner sweeping moves nothing —
 * which lets the session call it on a timer without an isHouse gate.
 * Returns the chips collected.
 */
export function sweepAirHockeyFees(ownerId: string): number {
  const map = ensureMap();
  const keys: string[] = [];
  let total = 0;
  const base = safeCount(map, `bal:${ownerId}`);
  for (const { tableId, playerId, record } of scanAirHockeyPaidRecords()) {
    if (record.state !== 'final' || record.ownerId !== ownerId) continue;
    // Per-record overflow guard: skip (and keep) any record that would push
    // the balance past a safe integer — unreachable honestly, cheap anyway.
    if (!Number.isSafeInteger(base + total + record.amount)) continue;
    total += record.amount;
    keys.push(airHockeyPaidKey(tableId, playerId));
  }
  if (total <= 0) return 0;
  boundDoc!.transact(() => {
    for (const key of keys) map.delete(key);
    map.set(`bal:${ownerId}`, base + total);
  });
  return total;
}

/**
 * Remove the fee CONFIG for a removed table. Escrow records are deliberately
 * left in place: each has exactly one rightful writer (payer for 'held',
 * recorded owner for 'final'), and the session reconciler/sweep resolves
 * them the moment that party is next online — a removal must not touch
 * other players' money (the multi-writer hazard this lane exists to avoid).
 * Runs on EVERY observing client (removeFurnitureVisuals), so it must stay
 * an idempotent delete.
 */
export function clearAirHockeyKeys(tableId: string): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.delete(`ah-fee:${tableId}`);
  });
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
    readAirHockeyFeeConfig, writeAirHockeyFeeConfig,
    readAirHockeyPaidRecord, scanAirHockeyPaidRecords,
    payAirHockeyFee, refundAirHockeyFee, finalizeAirHockeyFee,
    sweepAirHockeyFees, clearAirHockeyKeys,
  };
}
