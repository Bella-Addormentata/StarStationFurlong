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
// 🃏🎰 #45 wager slice — chip-escrowed table stakes on the card felt.
// Types + shape guards + key layout + chia-gaming compatibility contract
// live in `games/cardWager.ts`; the escrow-side transacted operations
// (pay / refund / settle / owner-abandonment sweep) live below in this
// module so they share the same bound doc + trust model as the rest of
// the cage. Owner-single-writer for the config and settle; per-player
// single-writer for each escrow record (mirrors the air-hockey fee
// discipline reviewed clean on PR #116).
import {
  cardWagerConfigKey, cardWagerEscrowKey,
  CARD_WAGER_ESCROW_PREFIX,
  MAX_CARD_WAGER_BUY_IN, MIN_CARD_WAGER_BUY_IN,
  isCardWagerConfig, isCardWagerRecord,
} from './games/cardWager';
import type {
  CardWagerConfig, CardWagerKind, CardWagerRecord,
} from './games/cardWager';

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

// ── 🃏🎰 #45 CARD WAGER: chip-escrowed table stakes ─────────────────────────
// Keys (owner writes cfg; each payer writes only their own escrow record):
//   cw-cfg:<tableId>             → CardWagerConfig  (owner-written)
//   cw-escrow:<tableId>:<pid>    → CardWagerRecord  (payer-written)
//
// TRUST BOUNDARY
//   Peers write the casino Y.Map unauthenticated. Every read below runs
//   the isCardWagerConfig / isCardWagerRecord guard from cardWager.ts
//   before any settle / refund / conservation path consumes the value.
//   A malformed peer record reads as absent (fails SAFE — never as a
//   partial value that would drain, double-credit, or divert the pot).
//
// SETTLE AUTHORITY
//   Only the CONFIG OWNER may call settleCardWager / activateCardWager
//   / owner-abandonment refund. That mirrors the air-hockey fee owner
//   (PR #116 reviewed clean) — the settle is a single transact by a
//   single writer, so no concurrent-writer race can inflate the payout.
//   Non-participants (any actor other than owner or the record's payer)
//   are refused shape-first by the actor check on every entry point.
//
// CONSERVATION INVARIANT (locked by tests in cardWager.test.ts):
//   escrowed_total == paid_out + refunded + still_held
//   Every pay / refund / settle path writes matching deltas in one
//   transact, so a mid-settle throw is all-or-nothing at the Y.Doc
//   level (Yjs transact semantics).

/** Read the wager config for a table. Returns null when absent or
 *  when a hostile peer planted a malformed value under the key. */
export function readCardWagerConfig(tableId: string): CardWagerConfig | null {
  const v = ensureMap().get(cardWagerConfigKey(tableId));
  return isCardWagerConfig(v) ? v : null;
}

/**
 * Stamp a NEW wager config for a table. Writes the `cw-cfg:<tableId>`
 * key. Refuses to overwrite an existing config with a DIFFERENT ownerId
 * (single-writer discipline for the config key).
 *
 * The write is atomic within one transact — nothing else is touched.
 * Balances / escrow records are unaffected; this only records intent.
 */
export function stampCardWagerConfig(
  actorId: string,
  tableId: string,
  kind: CardWagerKind,
  buyIn: number,
  nowMs: number,
): boolean {
  if (!Number.isInteger(buyIn) || buyIn < MIN_CARD_WAGER_BUY_IN
    || buyIn > MAX_CARD_WAGER_BUY_IN) return false;
  if (typeof actorId !== 'string' || actorId.length === 0) return false;
  if (!Number.isFinite(nowMs) || nowMs < 0) return false;
  const map = ensureMap();
  const key = cardWagerConfigKey(tableId);
  const existing = map.get(key);
  if (existing !== undefined) {
    if (!isCardWagerConfig(existing)) return false;
    if (existing.ownerId !== actorId) return false;
  }
  const cfg: CardWagerConfig = {
    kind, buyIn, ownerId: actorId, createdAt: nowMs, startedAt: null,
  };
  boundDoc!.transact(() => {
    map.set(key, cfg);
  });
  return true;
}

/** Read one player's escrow record (shape-guarded). */
export function readCardWagerEscrow(
  tableId: string,
  playerId: string,
): CardWagerRecord | null {
  const v = ensureMap().get(cardWagerEscrowKey(tableId, playerId));
  return isCardWagerRecord(v) ? v : null;
}

/** Scan every well-formed escrow record for a table (in doc order). */
export function scanCardWagerEscrow(tableId: string): CardWagerRecord[] {
  const prefix = `${CARD_WAGER_ESCROW_PREFIX}${tableId}:`;
  const out: CardWagerRecord[] = [];
  for (const [key, value] of ensureMap().entries()) {
    if (!key.startsWith(prefix)) continue;
    if (!isCardWagerRecord(value)) continue;
    out.push(value);
  }
  return out;
}

/**
 * Player pays their BUY-IN into escrow. Debits the payer's balance by
 * exactly `config.buyIn` and writes the `held` record under the payer's
 * own key. All in one transact so a mid-write throw leaves the doc in a
 * consistent state.
 *
 * Refuses when:
 *   - No config, or a malformed one on the doc.
 *   - `actorId !== playerId` (payer is the sole writer of their key).
 *   - `state.startedAt !== null` (match already begun; pay window closed).
 *   - Player already has a well-formed `held` record at the SAME amount —
 *     returns TRUE without a rewrite (crash-retry idempotency).
 *   - Player already has a well-formed `held` record at a DIFFERENT amount
 *     (config drift; the caller should refund first). Returns false.
 *   - Player balance short. Returns false.
 *
 * Returns true when the record is present after the call (either wrote
 * new or matched an existing well-formed record).
 */
export function payCardWager(
  actorId: string,
  tableId: string,
  playerId: string,
  nowMs: number,
): boolean {
  if (actorId !== playerId) return false;
  if (!Number.isFinite(nowMs) || nowMs < 0) return false;
  const cfg = readCardWagerConfig(tableId);
  if (!cfg) return false;
  if (cfg.startedAt !== null) return false;
  const buyIn = cfg.buyIn;
  const map = ensureMap();
  const key = cardWagerEscrowKey(tableId, playerId);
  const existing = map.get(key);
  if (existing !== undefined && isCardWagerRecord(existing)) {
    // Crash-retry idempotency: same amount, same owner, still 'held' → no-op.
    if (existing.amount === buyIn
      && existing.ownerId === cfg.ownerId
      && existing.state === 'held'
      && existing.playerId === playerId) return true;
    // Any other existing well-formed record blocks the pay path.
    return false;
  }
  const balKey = `bal:${playerId}`;
  const bal = readCount(balKey);
  if (bal < buyIn) return false;
  const record: CardWagerRecord = {
    kind: cfg.kind, amount: buyIn, ownerId: cfg.ownerId,
    playerId, paidAt: nowMs, state: 'held',
  };
  boundDoc!.transact(() => {
    map.set(balKey, bal - buyIn);
    map.set(key, record);
  });
  return true;
}

/**
 * Owner stamps `startedAt` (the BEGIN transition) once BOTH players have
 * paid in. Refuses when:
 *   - `actorId !== config.ownerId`.
 *   - No config, or already-started.
 *   - Fewer than 2 well-formed `held` records for the table.
 *   - Any recorded amount != config.buyIn (peer-tampered record;
 *     caller should refund the offender first).
 *
 * After BEGIN, self-refund is locked — only owner-abandonment refund
 * or settle can move the escrow chips. This is the point where the
 * chia-gaming state channel would "open".
 */
export function activateCardWager(
  actorId: string,
  tableId: string,
  nowMs: number,
): boolean {
  const cfg = readCardWagerConfig(tableId);
  if (!cfg) return false;
  if (actorId !== cfg.ownerId) return false;
  if (cfg.startedAt !== null) return false;
  if (!Number.isFinite(nowMs) || nowMs < 0) return false;
  const records = scanCardWagerEscrow(tableId);
  // Heads-up only: exactly 2 well-formed records at activation. A
  // hostile third record blocks activate so the owner sweeps it first
  // (via refundCardWager on the forged player id).
  if (records.length !== 2) return false;
  for (const r of records) {
    if (r.amount !== cfg.buyIn) return false;
    if (r.ownerId !== cfg.ownerId) return false;
    if (r.state !== 'held') return false;
  }
  if (records[0].playerId === records[1].playerId) return false;
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(cardWagerConfigKey(tableId), { ...cfg, startedAt: nowMs });
  });
  return true;
}

/**
 * Self-refund BEFORE BEGIN (state 'held', config.startedAt === null).
 * Payer writes their own key → deletes the record, credits own balance
 * += record.amount. Idempotent: missing record → false.
 *
 * When `actorId === config.ownerId` and `playerId !== actorId`, this is
 * the OWNER-ABANDONMENT refund — the owner may return a stranded pay-in
 * to a player who left the table before both sides completed. Owner can
 * do this at any startedAt state; that mirrors the air-hockey owner
 * sweep on removed tables (records must not be left orphaned).
 *
 * Refuses non-participants: neither the payer nor the owner can be
 * spoofed by a bystander — every entry point checks `actorId`.
 */
export function refundCardWager(
  actorId: string,
  tableId: string,
  playerId: string,
): boolean {
  const cfg = readCardWagerConfig(tableId);
  if (!cfg) return false;
  const isSelf = actorId === playerId;
  const isOwner = actorId === cfg.ownerId;
  if (!isSelf && !isOwner) return false;
  // Self-refund is only legal BEFORE begin. Owner-abandonment is legal
  // at any state (documented above).
  if (isSelf && cfg.startedAt !== null) return false;
  const map = ensureMap();
  const key = cardWagerEscrowKey(tableId, playerId);
  const existing = map.get(key);
  if (existing === undefined) return false;
  if (!isCardWagerRecord(existing)) {
    // Malformed record — delete it (no credit; hostile write cannot mint
    // chips into a real balance). Owner-only cleanup step.
    if (!isOwner) return false;
    boundDoc!.transact(() => { map.delete(key); });
    return true;
  }
  // Well-formed record: return chips to the payer.
  const balKey = `bal:${playerId}`;
  const bal = readCount(balKey);
  const refund = existing.amount;
  boundDoc!.transact(() => {
    map.set(balKey, bal + refund);
    map.delete(key);
  });
  return true;
}

/**
 * SETTLE — winner takes the pot. Owner reads both escrow records, credits
 * the winner's balance by their sum (= 2 × buyIn for the standard match;
 * for a split, each player gets their own buyIn back), and deletes both
 * records + the config in ONE transact.
 *
 * `winnerId` must be one of the two payers' ids, or the literal string
 * `'split'` for a tie (heads-up hold'em ties are rare but real — two
 * pair on the board, etc.).
 *
 * Refuses when:
 *   - `actorId !== config.ownerId`.
 *   - No config, or match not begun (startedAt === null).
 *   - The doc holds anything other than EXACTLY 2 well-formed 'held'
 *     records (heads-up only; a hostile peer that planted a well-formed
 *     third record cannot inflate the pot — see the drain-safety test
 *     in cardWager.test.ts).
 *   - Any recorded amount != config.buyIn.
 *   - `winnerId` not 'split' and not present as a payer.
 *
 * Idempotent: after a successful settle both records + config are gone,
 * so a second call reads no config and returns false (no double-credit).
 *
 * The single transact is the mid-settle-throw safeguard: Yjs applies
 * the whole set of `map.set` / `map.delete` writes in one commit. All
 * writes are pure data mutations that don't execute user code, so the
 * transact body itself cannot throw mid-way. See `cardWager.test.ts`
 * for the drain-safety test that asserts a REFUSED settle does not
 * partially credit / partially delete.
 */
export function settleCardWager(
  actorId: string,
  tableId: string,
  winnerId: string | 'split',
): boolean {
  const cfg = readCardWagerConfig(tableId);
  if (!cfg) return false;
  if (actorId !== cfg.ownerId) return false;
  if (cfg.startedAt === null) return false;
  const records = scanCardWagerEscrow(tableId);
  // Heads-up only: exactly 2 well-formed records. A hostile peer that
  // planted a well-formed THIRD record without paying chips in cannot
  // inflate the pot the winner is credited from — refuse the whole
  // settle so the owner can sweep the forged record first (refundCardWager
  // with the forged player id deletes it; then settle sees 2 again).
  if (records.length !== 2) return false;
  for (const r of records) {
    if (r.amount !== cfg.buyIn) return false;
    if (r.ownerId !== cfg.ownerId) return false;
    if (r.state !== 'held') return false;
  }
  const payerIds = records.map((r) => r.playerId);
  // Payer ids must be distinct (two SEPARATE players); catches the
  // hostile "same player twice under different keys" edge if a peer
  // ever finds a way to spoof the key layout.
  if (payerIds[0] === payerIds[1]) return false;
  const pot = records.reduce((sum, r) => sum + r.amount, 0);
  const map = ensureMap();
  if (winnerId === 'split') {
    const [balKey0, balKey1] = payerIds.map((pid) => `bal:${pid}`);
    const bal0 = readCount(balKey0);
    const bal1 = readCount(balKey1);
    boundDoc!.transact(() => {
      map.set(balKey0, bal0 + records[0].amount);
      map.set(balKey1, bal1 + records[1].amount);
      for (const pid of payerIds) {
        map.delete(cardWagerEscrowKey(tableId, pid));
      }
      map.delete(cardWagerConfigKey(tableId));
    });
    return true;
  }
  // Winner-takes-pot path.
  if (!payerIds.includes(winnerId)) return false;
  const winnerBalKey = `bal:${winnerId}`;
  const winnerBal = readCount(winnerBalKey);
  boundDoc!.transact(() => {
    map.set(winnerBalKey, winnerBal + pot);
    for (const pid of payerIds) {
      map.delete(cardWagerEscrowKey(tableId, pid));
    }
    map.delete(cardWagerConfigKey(tableId));
  });
  return true;
}

/**
 * Wipe every wager key for a table (config + all escrow records). Owner-
 * only teardown — a hostile peer cannot drain by calling this, because
 * the actor check refuses non-owner. Callers should REFUND outstanding
 * held records FIRST (via refundCardWager) so this is a defensive
 * no-orphan sweep rather than a chip-loss path.
 */
export function clearCardWagerKeys(actorId: string, tableId: string): boolean {
  const cfg = readCardWagerConfig(tableId);
  // If there's no config, allow anyone to clear stale escrow records
  // (an orphaned record with no owning config cannot be refunded by
  // the payer either — this is the recovery valve).
  if (!cfg) {
    const map = ensureMap();
    const escrowPrefix = `${CARD_WAGER_ESCROW_PREFIX}${tableId}:`;
    boundDoc!.transact(() => {
      map.delete(cardWagerConfigKey(tableId));
      for (const key of [...map.keys()]) {
        if (key.startsWith(escrowPrefix)) map.delete(key);
      }
    });
    return true;
  }
  if (actorId !== cfg.ownerId) return false;
  const map = ensureMap();
  const escrowPrefix = `${CARD_WAGER_ESCROW_PREFIX}${tableId}:`;
  boundDoc!.transact(() => {
    map.delete(cardWagerConfigKey(tableId));
    for (const key of [...map.keys()]) {
      if (key.startsWith(escrowPrefix)) map.delete(key);
    }
  });
  return true;
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
    // 🃏🎰 #45 wager slice — expose the escrow operations for devtools
    // verification of pay / refund / settle math from the console.
    readCardWagerConfig, stampCardWagerConfig, readCardWagerEscrow,
    scanCardWagerEscrow, payCardWager, refundCardWager,
    activateCardWager, settleCardWager, clearCardWagerKeys,
  };
}
