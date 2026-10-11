/**
 * ⛓️🥣 The faucet dish — browser-side state and the pure helpers behind it.
 *
 * The dish is the room's faucet coin made physical (issue #231 onboarding
 * phase; design note ssf-p2p/faucet-dish-design.md): a keyless Chia coin set at
 * one address per room, from which the puzzle hands one GIFT per coin per GAP
 * blocks to whoever submits the spend. The NODE does every chain read and
 * spend (chia_faucet.rs); this module only keeps the last status the node sent
 * per room, parses the node's `faucet` envelopes, and turns the numbers into
 * what the fixture and its screen show.
 *
 * Owner rule, kept: in the room the jar is a LEVEL, never a total — the exact
 * mojos appear only on the focused screen, like the cashier's chip count.
 */

export interface FaucetStatus {
  /** `txch1…` address of this room's faucet (bech32m of puzzleHash). */
  address: string;
  puzzleHash: string;
  /** Mojos per claim and blocks between claims of one coin (puzzle constants). */
  gift: number;
  gap: number;
  /** Chain peak the status was read at. */
  peak: number;
  /** Mojos in claimable coins. A bigint: the node sends mojo totals as decimal
   *  strings because a JSON number is exact only below 2^53 (~9,007 XCH). */
  totalMojos: bigint;
  /** Claimable coins = gift slots per GAP. */
  coins: number;
  /** Coins past their GAP right now: mojos sitting in the dish. */
  ready: number;
  /** Blocks until the next coin is ready, when none is. */
  nextReadyInBlocks: number | null;
  /** This node can submit a claim / pay into the jar. */
  canClaim: boolean;
  canGive: boolean;
  /** Mojos our wallet OWNS on chain, when the node has a wallet loaded. */
  walletMojos: bigint | null;
  /** Of those, what the node can SPEND right now: owned minus coins a spend
   *  already consumed but the chain has not confirmed yet. GIVE is gated on
   *  this; an older node omits it (then it equals walletMojos). */
  walletSpendableMojos: bigint | null;
  /** The node's coin listing was cut short (a flood of outputs): coins, ready
   *  and totalMojos cover the pages it read; the jar holds more. */
  partial: boolean;
  /** Why take/give are off, in the node's words. */
  note: string;
}

export interface FaucetReply {
  op: string;
  ok: boolean;
  error?: string;
  status?: FaucetStatus;
  /** The coin a claim or gift spent, once the mempool accepted it. */
  spentCoin?: string;
}

export type FaucetOp = 'status' | 'claim' | 'give';

/** Testnet11 / mainnet block cadence: 32 blocks per 10 minutes. */
export const SECONDS_PER_BLOCK = 18.75;
/** Coins (gift slots) at which the jar reads FULL. One lobby drip is one coin. */
export const FULL_JAR_COINS = 8;
/** A spend is "pending" until a status read shows it landed, or this long. */
export const PENDING_TIMEOUT_MS = 120_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A mojo total off the wire: a decimal string (the node's form), or a safe
 *  non-negative integer number (older nodes). Anything else is refused. */
export function asMojos(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'string') return /^\d{1,30}$/.test(v) ? BigInt(v) : null;
  if (isNum(v) && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

/** Shape-guard a parsed status object from the node (a hostile or stale node
 *  must not crash the dish). Returns null when any required field is off. */
export function asFaucetStatus(raw: unknown): FaucetStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.address !== 'string' || typeof r.puzzleHash !== 'string') return null;
  for (const k of ['gift', 'gap', 'peak', 'coins', 'ready'] as const) {
    if (!isNum(r[k]) || (r[k] as number) < 0) return null;
  }
  const total = asMojos(r.totalMojos);
  if (total === null) return null;
  const next = r.nextReadyInBlocks;
  if (!(next === null || next === undefined || isNum(next))) return null;
  const optMojos = (v: unknown): bigint | null | undefined => (v === null || v === undefined ? null : (asMojos(v) ?? undefined));
  const wallet = optMojos(r.walletMojos);
  if (wallet === undefined) return null;
  const spendable = optMojos(r.walletSpendableMojos);
  if (spendable === undefined) return null;
  return {
    address: r.address,
    puzzleHash: r.puzzleHash,
    gift: r.gift as number,
    gap: r.gap as number,
    peak: r.peak as number,
    totalMojos: total,
    coins: r.coins as number,
    ready: r.ready as number,
    nextReadyInBlocks: isNum(next) ? next : null,
    canClaim: r.canClaim === true,
    canGive: r.canGive === true,
    walletMojos: wallet,
    walletSpendableMojos: spendable ?? wallet,
    partial: r.partial === true,
    note: typeof r.note === 'string' ? r.note : '',
  };
}

/** Decode a node `faucet` envelope payload (base64 JSON) into a reply. */
export function parseFaucetReply(payloadB64: string): FaucetReply | null {
  let raw: unknown;
  try {
    raw = JSON.parse(atob(payloadB64));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.op !== 'string' || typeof r.ok !== 'boolean') return null;
  const reply: FaucetReply = { op: r.op, ok: r.ok };
  if (typeof r.error === 'string') reply.error = r.error;
  if (typeof r.spentCoin === 'string') reply.spentCoin = r.spentCoin;
  if (r.status !== undefined) {
    const status = asFaucetStatus(r.status);
    if (!status) return null;
    reply.status = status;
  }
  return reply;
}

/** The jar's fill level, 0..1, from gift SLOTS (coins), not mojos: a one-mojo
 *  gift makes any funded jar bottomless in mojos, so mojos would read FULL
 *  forever; coins are what a passer-by can actually feel (gifts per window). */
export function jarLevel(status: FaucetStatus | null): number {
  if (!status || status.coins <= 0) return 0;
  return Math.min(1, status.coins / FULL_JAR_COINS);
}

export function blocksToMinutes(blocks: number): number {
  return Math.max(1, Math.round((blocks * SECONDS_PER_BLOCK) / 60));
}

const MOJOS_PER_TXCH = 1_000_000_000_000n;

/** Mojos for the focused screen: thousands grouped; TXCH alongside from 1e9.
 *  Exact at any size (digit strings, no floating point). */
export function formatMojos(mojos: bigint | number): string {
  const n = typeof mojos === 'bigint' ? (mojos < 0n ? 0n : mojos) : BigInt(Math.max(0, Math.floor(mojos)));
  const grouped = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const unit = n === 1n ? 'mojo' : 'mojos';
  if (n >= 1_000_000_000n) {
    const whole = n / MOJOS_PER_TXCH;
    const frac = (n % MOJOS_PER_TXCH).toString().padStart(12, '0');
    const shown = whole >= 1n ? `${whole}.${frac.slice(0, 3)}` : `0.${frac.slice(0, 6).replace(/0+$/, '') || '0'}`;
    return `${grouped} ${unit} (${shown} TXCH)`;
  }
  return `${grouped} ${unit}`;
}

/** The one line the dish shows about what is in it right now. */
export function dishLine(status: FaucetStatus | null): string {
  if (!status) return 'READING THE CHAIN…';
  if (status.coins <= 0) return 'THE JAR IS EMPTY — DROP SOMETHING IN THE SLOT';
  if (status.ready > 0) {
    return status.ready === 1 ? '1 MOJO IN THE DISH' : `${status.ready} MOJOS IN THE DISH`;
  }
  if (status.nextReadyInBlocks !== null) {
    const b = status.nextReadyInBlocks;
    return `DISH EMPTY · REFILLS IN ${b} BLOCK${b === 1 ? '' : 'S'} (~${blocksToMinutes(b)} MIN)`;
  }
  return 'DISH EMPTY';
}

// ── Per-room store: the last status the node sent, and in-flight spends ──────

interface Pending {
  op: FaucetOp;
  since: number;
}

const latest = new Map<string, FaucetStatus>();
const lastError = new Map<string, string>();
const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

export function latestFaucetStatus(roomId: string): FaucetStatus | null {
  return latest.get(roomId) ?? null;
}

export function latestFaucetError(roomId: string): string | null {
  return lastError.get(roomId) ?? null;
}

/** A take or give is in flight (until a status shows it, or the timeout). */
export function faucetPending(roomId: string, now: number = Date.now()): FaucetOp | null {
  const p = pending.get(roomId);
  if (!p) return null;
  if (now - p.since > PENDING_TIMEOUT_MS) {
    pending.delete(roomId);
    return null;
  }
  return p.op;
}

export function markFaucetPending(roomId: string, op: FaucetOp, now: number = Date.now()): void {
  pending.set(roomId, { op, since: now });
  notify();
}

/** File a reply from the node for `roomId`. A status replaces the last one and
 *  clears a pending spend once the wallet/jar shows it (claim: our wallet now
 *  holds a coin; give: fewer wallet mojos); an error is kept for the screen. */
export function setFaucetReply(roomId: string, reply: FaucetReply): void {
  if (!reply.ok) {
    lastError.set(roomId, reply.error ?? 'the node refused');
    if (reply.op === 'claim' || reply.op === 'give') pending.delete(roomId);
    notify();
    return;
  }
  lastError.delete(roomId);
  if (reply.status) {
    const prev = latest.get(roomId);
    latest.set(roomId, reply.status);
    const p = pending.get(roomId);
    if (p && prev) {
      const landed =
        (p.op === 'claim' && (reply.status.walletMojos ?? 0n) > 0n) ||
        (p.op === 'give' && reply.status.walletMojos !== null && prev.walletMojos !== null
          && reply.status.walletMojos < prev.walletMojos);
      if (landed) pending.delete(roomId);
    }
  }
  notify();
}

export function subscribeFaucet(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Forget a room's dish state (leaving the room / tests). */
export function clearFaucetRoom(roomId: string): void {
  latest.delete(roomId);
  lastError.delete(roomId);
  pending.delete(roomId);
  notify();
}
