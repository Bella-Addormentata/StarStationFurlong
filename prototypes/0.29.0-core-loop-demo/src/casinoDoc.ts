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
import type { CrapsBet, CrapsTableState } from './games/craps';

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
const listeners = new Set<() => void>();

function notify(): void {
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
}

function docAlive(): boolean {
  return boundDoc !== null
    && (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true;
}

export function bindCasinoDoc(doc: Y.Doc): void {
  boundDoc = doc;
  casinoMap = doc.getMap('casino');
  casinoMap.observe(() => notify());
  notify(); // repaint subscribers from the fresh doc
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

// Permanent debug handle (the __ssfGames precedent) — console verification of
// balances, table state and settle math without UI plumbing.
(window as unknown as { __ssfCasino: unknown }).__ssfCasino = {
  readChips, buyInChips, cashOutChips, spendChips, creditChips,
  readCageLedger, readTableState, writeTableState, readMyBets, writeMyBets, readAllBets,
  readCroupierBeat, writeCroupierBeat,
  readCrapsTableState, writeCrapsTableState, readMyCrapsBets, writeMyCrapsBets, readAllCrapsBets,
};
