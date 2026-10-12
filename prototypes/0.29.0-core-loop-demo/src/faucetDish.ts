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
  /** The node's WALLET listing was cut short the same way (our address is as
   *  permissionless as the faucet's): the two wallet totals cover the pages it
   *  read, the wallet holds more, and GIVE spends from the coins it read. */
  walletPartial: boolean;
  /** The node's coin listing was cut short (a flood of outputs): coins, ready
   *  and totalMojos cover the pages it read; the jar holds more. */
  partial: boolean;
  /** Why take/give are off, in the node's words. */
  note: string;
  /** A spend from our wallet is still settling (coins of ours are parked by a
   *  push the chain and the mempool have not settled yet). */
  spending: boolean;
  /** A gift from the dish is still landing in our wallet. */
  landing: boolean;
  /** The node's number for this snapshot. The node captures status snapshots
   *  one at a time and numbers them as they complete, so a higher number is a
   *  later look at the chain and the wallet whatever order the requests went
   *  out in (they run on separate streams and the node serves them
   *  concurrently, so request order is not capture order). 0 from an older
   *  node, which orders nothing. */
  snapshot: number;
}

export interface FaucetReply {
  op: string;
  ok: boolean;
  error?: string;
  status?: FaucetStatus;
  /** The coin a claim or gift spent, once the mempool accepted it. */
  spentCoin?: string;
  /** On a claim or give that went out: the node's snapshot barrier. Every
   *  status numbered above it was captured after the push. Sent even when the
   *  status read right after the push failed. */
  afterSnapshot?: number;
  /** On a claim or give whose push the gateway did not ANSWER: why. The spend
   *  may be in the mempool all the same, so the action stays pending, exactly
   *  as after an accepted push, until the node's statuses settle it; only an
   *  explicit rejection comes back as `ok: false`. */
  unanswered?: string;
}

export type FaucetOp = 'status' | 'claim' | 'give';

/** A request on its way to the node (NetworkProvider.requestFaucet). `seq` is
 *  the request's number on the wire, which the node echoes on the reply; it is
 *  allotted before the frame leaves, so a pending TAKE/GIVE is keyed on it
 *  before any reply can arrive. `sent` resolves once the request is on the
 *  wire and rejects when it never left (no node connection, a stream that
 *  failed before the write). */
export interface FaucetRequestTicket {
  seq: number;
  sent: Promise<void>;
}

/** Testnet11 / mainnet block cadence: 32 blocks per 10 minutes. */
export const SECONDS_PER_BLOCK = 18.75;
/** Coins (gift slots) at which the jar reads FULL. One lobby drip is one coin. */
export const FULL_JAR_COINS = 8;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A mojo total off the wire: a decimal string (the node's form; it sums coins
 *  in u128, so up to 39 digits, since several u64 coins can pass u64 together),
 *  or a safe non-negative integer number (older nodes). Anything else is refused. */
export function asMojos(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'string') return /^\d{1,39}$/.test(v) ? BigInt(v) : null;
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
    walletPartial: r.walletPartial === true,
    partial: r.partial === true,
    note: typeof r.note === 'string' ? r.note : '',
    spending: r.spending === true,
    landing: r.landing === true,
    snapshot: isNum(r.snapshot) && r.snapshot > 0 ? Math.floor(r.snapshot) : 0,
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
  if (isNum(r.afterSnapshot) && r.afterSnapshot >= 0) reply.afterSnapshot = Math.floor(r.afterSnapshot);
  if (typeof r.unanswered === 'string') reply.unanswered = r.unanswered;
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

/** A TAKE or GIVE from the click until the node settles it (see setFaucetReply).
 *  `seq` is the request's number on the wire: the node echoes it on the reply,
 *  and only the reply carrying it is this action's own. `floor` is the first
 *  snapshot number that counts as captured AFTER the push (from the barrier
 *  the node sends with the reply): a status numbered below it predates the
 *  spend and says nothing about it. Null until the reply arrives. `unanswered`
 *  is the node's word when the gateway never answered the push: the spend may
 *  be live all the same, and the action stays pending until a status settles
 *  it, as after an accepted push. */
interface Pending {
  op: FaucetOp;
  seq: number;
  floor: number | null;
  unanswered: string | null;
}

const latest = new Map<string, FaucetStatus>();
const lastError = new Map<string, string>();
const pending = new Map<string, Pending>();
/** The node's snapshot number of the newest status filed per room (see setFaucetReply). */
const latestSnapshot = new Map<string, number>();
const listeners = new Set<() => void>();
/** The room whose node session this store listens to right now (see openFaucetRoom). */
let openRoom: string | null = null;

function notify(): void {
  for (const cb of listeners) cb();
}

/** Open `roomId` to its node's replies. main.ts opens the room at join, before
 *  the connect (the id is known synchronously, so the first poll's reply is
 *  filed), and closes it at the top of a leave, before any await. Only the
 *  open room's replies, the failures of its requests and its pending actions
 *  are filed: a reply still in flight when the room is left (a poll answered
 *  during the leave's flush), or a request that fails to leave after it (a
 *  stream that could not be opened, rejecting during the leave), would
 *  otherwise put state back for a room already left — a stale balance, a stale
 *  TAKING… line, an error for the departed room. The gate lives here, in the
 *  one store every reply and failure goes through, so no caller can pass it
 *  by (#245 review, rounds 14 and 20). */
export function openFaucetRoom(roomId: string): void {
  openRoom = roomId;
}

/** Close the gate, whatever room is open: nothing is filed until the next
 *  openFaucetRoom. Synchronous, so it takes effect before a leave's flush. */
export function closeFaucetRoom(): void {
  openRoom = null;
}

export function latestFaucetStatus(roomId: string): FaucetStatus | null {
  return latest.get(roomId) ?? null;
}

export function latestFaucetError(roomId: string): string | null {
  return lastError.get(roomId) ?? null;
}

/** A take or give is in flight: from the click until the node reports it
 *  settled (landed, dropped or refused). Never cleared on elapsed time: a
 *  zero-fee spend can wait in the mempool for longer than any timeout, and a
 *  GIVE button re-enabled by the clock while the first gift still waits would
 *  invite a second one (#245 review, round 11). */
export function faucetPending(roomId: string): FaucetOp | null {
  return pending.get(roomId)?.op ?? null;
}

export function markFaucetPending(roomId: string, op: FaucetOp, seq: number): void {
  if (roomId !== openRoom) return;
  pending.set(roomId, { op, seq, floor: null, unanswered: null });
  notify();
}

/** The node's word when the gateway did not answer the pending action's push
 *  (null otherwise): the spend may be live all the same, its inputs stay
 *  parked, and the action stays pending until a status settles it. */
export function faucetPendingUnanswered(roomId: string): string | null {
  return pending.get(roomId)?.unanswered ?? null;
}

/** File a reply from the node for `roomId`. A status replaces the last one; an
 *  error is kept for the screen and drops a pending TAKE/GIVE (refused).
 *
 *  A pending TAKE/GIVE clears on what the node reports, not on the clock. The
 *  take/give reply carries the first status captured after the push; from that
 *  snapshot number on, a status that no longer shows the spend settling
 *  (`spending` for a give, `landing` for a take) means the chain or the mempool
 *  settled it — landed or dropped — and the action is over either way. A TAKE
 *  also clears from any status that shows our wallet holding a coin: TAKE is
 *  over then whatever happened, since the dish is for empty wallets. A GIVE
 *  clears from the node's verdict alone, never from a lower balance: the
 *  wallet is the node's, shared by every room and tab, and another action's
 *  gift confirming would read as this one's while its own spend is still
 *  parked — and GIVE would come back while that spend is live (#245 review,
 *  round 18). A status numbered below the reply's predates the push and is
 *  not read as "nothing in flight". Until the reply arrives nothing but a
 *  TAKE's landing clears an action; a reply lost with its stream keeps the
 *  action pending until the room is left, rather than risk a second gift.
 *
 *  Statuses are ordered by the node's snapshot number, not by request: the
 *  20 s and 60 s polls and the post-action read each run on their own stream,
 *  the node serves them concurrently, and a later request can be captured
 *  before an earlier one, so request order says nothing about which view is
 *  newer. The node numbers snapshots as it captures them, one at a time; a
 *  status numbered below the newest filed is an older look and is dropped (it
 *  could put a pre-claim balance back and re-enable TAKE). An older node sends
 *  no number (0), which orders nothing.
 *
 *  A take/give reply is tied to its request by `seq`, the number the request
 *  carried on the wire and the node echoes back: only the reply with the
 *  pending action's own seq (or the failure of that very request) sets its
 *  floor or refuses it. An earlier action's reply answered late — after a poll
 *  showed that action landed and cleared it, and a new one began — carries an
 *  older seq: its status is filed like any other (the snapshot ordering sorts
 *  it), but it says nothing about the action pending now, whose floor it would
 *  otherwise set from a snapshot already on file and clear it at once; a late
 *  refusal of it is not this action's refusal either (#245 review, round 14).
 *  A refusal the node issued before it could read the op — `op: "?"`, for a
 *  request it could not parse or one from a session that is not its local
 *  browser — carries the request's seq like any reply, so with the pending
 *  action's seq it is that action's refusal and clears it (round 20); with
 *  another seq (a status poll's) it is shown, since the whole dish is refused
 *  then, but the action stands.
 *
 *  Only the open room's replies are filed (see openFaucetRoom); any other
 *  room's are dropped here, whatever the caller. */
export function setFaucetReply(roomId: string, reply: FaucetReply, seq?: number): void {
  if (roomId !== openRoom) return;
  const p = pending.get(roomId);
  // This action's own reply: the one echoing its seq, under its op or under
  // '?' (refused before the op was read).
  const own: Pending | null =
    p !== undefined && seq !== undefined && seq === p.seq && (reply.op === p.op || reply.op === '?') ? p : null;
  if (!reply.ok) {
    if (own) {
      pending.delete(roomId);
    } else if (reply.op === 'claim' || reply.op === 'give') {
      // A refusal of some other action — an earlier one's, answered late —
      // neither clears the pending action nor shows as its error.
      return;
    }
    lastError.set(roomId, reply.error ?? 'the node refused');
    notify();
    return;
  }
  lastError.delete(roomId);
  // This action's own reply: the spend went out. Its floor is recorded BEFORE
  // the snapshot ordering below is consulted: a reply answered after a newer
  // poll carries an older snapshot and must not be filed over it, but the floor
  // it brings still stands, or the action could never clear (#245 review,
  // round 12). The node sends the barrier even when its status read after the
  // push failed (round 13); an older node sends only the status; one that sends
  // neither leaves the floor unset, and only a landing clears the action then.
  // A push the gateway did not answer is a spend that may be live: the action
  // stays pending the same way, and the screen says why (round 14).
  if (own) {
    own.floor = reply.afterSnapshot !== undefined
      ? reply.afterSnapshot + 1
      : reply.status && reply.status.snapshot > 0 ? reply.status.snapshot : null;
    own.unanswered = reply.unanswered ?? null;
  }
  if (reply.status) {
    const st = reply.status;
    // An older snapshot answered late is not filed over a newer one (an older
    // node numbers nothing and always files).
    const newest = latestSnapshot.get(roomId) ?? 0;
    if (!(st.snapshot > 0 && st.snapshot < newest)) {
      if (st.snapshot > 0) latestSnapshot.set(roomId, st.snapshot);
      latest.set(roomId, st);
    }
  }
  // Judge the pending action on the newest view there is: the status just
  // filed, or the newer one already on file (a late reply, or a reply without
  // a status), which counts as after the push once the floor is set.
  const view = latest.get(roomId);
  if (p && view) {
    // A funded wallet ends a TAKE whatever happened; a GIVE has no such sign
    // of its own (a lower balance can be another room's or tab's gift) and
    // waits for the node's verdict past the barrier.
    const landed = p.op === 'claim' && (view.walletMojos ?? 0n) > 0n;
    const settling = p.op === 'claim' ? view.landing : view.spending;
    const afterPush = p.floor !== null && view.snapshot >= p.floor;
    if (landed || (afterPush && !settling)) pending.delete(roomId);
  }
  notify();
}

/** A request never reached the node (no connection, a failed stream): no spend
 *  was made, so the pending TAKE/GIVE it was for (`seq`) is dropped at once,
 *  and the screen says why. Gated like a reply: a request whose failure
 *  resolves after its room was left files nothing (see openFaucetRoom). */
export function failFaucetRequest(roomId: string, op: FaucetOp, seq: number, reason: unknown): void {
  const why = reason instanceof Error ? reason.message : String(reason ?? 'unknown error');
  setFaucetReply(roomId, { op, ok: false, error: `the request did not reach your node (${why})` }, seq);
}

export function subscribeFaucet(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Forget a room's dish state, and close it to replies if it is the open room
 *  (leaving the room / tests). */
export function clearFaucetRoom(roomId: string): void {
  if (openRoom === roomId) openRoom = null;
  latest.delete(roomId);
  lastError.delete(roomId);
  pending.delete(roomId);
  latestSnapshot.delete(roomId);
  notify();
}
