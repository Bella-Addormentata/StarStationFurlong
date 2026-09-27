/**
 * 🎰🪙 casinoOperator games tests: both croupiers' real ticks against one
 * casino doc, under the room's one lease, in the order World runs them every
 * frame (the slot tick, the pusher tick, the pusher teardown tick), and the
 * mixed room, where a v0.38 peer (a second Y.Doc, kept in sync) reads and
 * writes only the two old room keys. Part 1 pins what the two games share:
 * one take for both settles, the union of their needs, one stop reaching
 * both, an earlier build holding both off, teardowns holding the lease, one
 * leave. Part 2 pins the hold-off on a v0.38 peer's record, the shadows a
 * v0.38 peer reads, device continuity, the race for one key, and the three
 * records a crashed new page leaves. Last, where the settle's pre-write check
 * sits: after its last await. The election's own rules are
 * casinoOperator.test.ts's; each croupier's wiring is its own test file's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  bindCasinoDoc,
  buyInChips,
  CASINO_OPERATOR_KEY,
  COIN_PUSHER_OPERATOR_KEY,
  depositSlotFunding,
  hasSlotEscrow,
  readCasinoOperatorLease,
  readChips,
  readCoinPusherOperatorLease,
  readCoinPusherRequest,
  readCoinPusherResult,
  readCoinPusherState,
  readRoomOperatorLease,
  readSlotFundingConfig,
  readSlotMachineState,
  readSlotOperatorLease,
  readSlotPlayRequests,
  reserveSlotWager,
  ROOM_OPERATOR_KEYS,
  SLOT_OPERATOR_KEY,
  writeCasinoOperatorRecords,
  writeCoinPusherOperatorLease,
  writeCoinPusherRequest,
  writeCoinPusherState,
  writeSlotFundingConfig,
  writeSlotMachineState,
  writeSlotOperatorLease,
  writeSlotPlayRequest,
  writeSlotReveal,
} from './casinoDoc';
import type { RoomOperatorKey, SlotOperatorLease } from './casinoDoc';
import { registerOperatorGame } from './casinoOperator';
import type { OperatorStopReason } from './casinoOperator';
import { setSoleCroupierPredicate } from './croupier';
import {
  chipsInMachine,
  currentPusherPhase,
  initialCoinPusherState,
  processInsert,
  PUSHER_ANTE,
} from './games/coinPusher';
import type { CoinPusherState, PusherHole, PusherInsertRequest } from './games/coinPusher';
import {
  commitSlotSeed,
  DEFAULT_PAYTABLE,
  hashSlotPaytable,
  initialSlotMachineState,
  maxSlotPayout,
  randomSlotSeed,
  SLOT_SPIN_MS,
} from './games/slots';
import type { SlotFundingConfig } from './games/slots';
import { getPlayerId } from './identity';
import {
  closeCoinPusher,
  coinPusherWatchCount,
  isCoinPusherOperator,
  leaveCoinPusherRoom,
  tickCoinPusherRoom,
  tickCoinPusherTeardowns,
} from './pusherCroupier';
import {
  closeSlotMachine,
  isManualSlotMachineRunning,
  isSlotOperator,
  leaveSlotMachineRoom,
  OPERATOR_UNCLEAN_TAKEOVER_MS,
  setManualSlotMachineRunning,
  slotOperatorSession,
  slotOperatorWatchCount,
  tickSlotMachineRoom,
} from './slotCroupier';

/** A hook run once the settle's reel derivation (its last real await) has
 *  resolved, before the settle goes on: the one test that pins where the
 *  settle's pre-write check sits sets it. */
const slotsHook = vi.hoisted(() => ({ afterDeriveReelStops: null as (() => void) | null }));
vi.mock('./games/slots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./games/slots')>();
  return {
    ...actual,
    deriveReelStops: async (...args: Parameters<typeof actual.deriveReelStops>) => {
      const stops = await actual.deriveReelStops(...args);
      slotsHook.afterDeriveReelStops?.();
      return stops;
    },
  };
});

const OPERATOR = getPlayerId();
const PLAYER = 'player-Bob';
const OTHER = 'player-Carol';
const M1 = 'slot-machine-1';
const M2 = 'slot-machine-2';
const CABINET = 'pusher-1';
const T0 = 1_000_000_000;
const LEASE_MS = 8_000;
const SETTLE_MS = 2_000;
const RENEW_MS = 3_000;
const BET = 5;
/** What a round locks in escrow (the most a BET can win). */
const RESERVE = Math.max(BET, maxSlotPayout(BET, DEFAULT_PAYTABLE));
/** This page's operator session, the one both games' records name. */
const SESSION = slotOperatorSession();
/** This page's device: tabs on it share this prefix in their session ids. */
const DEVICE = SESSION.split(':')[0];
/** The v0.38 peer: another device, one page. */
const PEER_DEVICE = 'other-device';
const PEER_SESSION = `${PEER_DEVICE}:tab`;
const TENURE = expect.stringMatching(/^[0-9a-f-]{36}$/);

let doc: Y.Doc;
/** What a game registered beside the two croupiers is told: why each take ended. */
let stops: OperatorStopReason[];

function at(t: number): number {
  vi.setSystemTime(t);
  return t;
}

/** One World frame at `t`: the slot tick, the pusher tick, then the pusher
 *  teardown tick, with the room's slot machines and cabinets. */
function frame(
  t: number,
  slots: readonly string[],
  pushers: readonly string[],
  manualAuthorized = false,
): void {
  at(t);
  tickSlotMachineRoom(slots, manualAuthorized, t);
  tickCoinPusherRoom(pushers, t);
  tickCoinPusherTeardowns();
}

/** Take the room at `t`, then a frame past the settling wait; returns that time. */
function becomeOperator(
  slots: readonly string[],
  pushers: readonly string[],
  t = T0,
  manualAuthorized = false,
): number {
  frame(t, slots, pushers, manualAuthorized);
  frame(t + SETTLE_MS, slots, pushers, manualAuthorized);
  return t + SETTLE_MS;
}

/** The three records as the doc holds them now: the primary, then the two v0.38 keys. */
function records(): (SlotOperatorLease | null)[] {
  return ROOM_OPERATOR_KEYS.map((key) => readRoomOperatorLease(key));
}

/** A record another session holds (another device unless `sessionId` says). */
function lease(expiresAt: number, sessionId = PEER_SESSION, playerId = OPERATOR): SlotOperatorLease {
  return { playerId, sessionId, expiresAt };
}

/** An earlier build's per-machine lease. */
function legacy(expiresAt: number): SlotOperatorLease {
  return { playerId: OPERATOR, sessionId: 'a'.repeat(64), expiresAt };
}

function countTransactions(d: Y.Doc): () => number {
  let n = 0;
  d.on('afterTransaction', () => { n += 1; });
  return () => n;
}

/** Bring two docs up to date with each other, as the sync would. */
function sync(a: Y.Doc, b: Y.Doc): void {
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, toB);
  Y.applyUpdate(a, toA);
}

// ── Slot machines ────────────────────────────────────────────────────────────

/** A machine whose bankroll is `owner`'s own chip balance. */
function fund(machineId: string, owner = OPERATOR): void {
  writeSlotFundingConfig(machineId, { mode: 'owner', ownerId: owner });
}

/** The player's spin request, as their panel writes it; returns the seed the
 *  panel will reveal. */
async function requestSpin(machineId: string, player = PLAYER, requestId = `req-${machineId}`): Promise<string> {
  const seed = randomSlotSeed();
  writeSlotPlayRequest(machineId, {
    requestId,
    player,
    bet: BET,
    requestedAt: Date.now(),
    playerCommit: await commitSlotSeed(seed),
    paytableHash: await hashSlotPaytable(DEFAULT_PAYTABLE),
  });
  return seed;
}

/** The player's reveal once the house has committed (their panel's job). */
function reveal(machineId: string, seed: string, player = PLAYER): void {
  const state = readSlotMachineState(machineId)!;
  writeSlotReveal(machineId, player, {
    requestId: state.requestId!,
    seed,
    houseCommit: state.fairness!.commits![1],
  });
}

const spinning = (machineId: string): boolean =>
  readSlotMachineState(machineId)?.phase === 'spinning';

/** Let the operator's async accept, settle, refund or teardown run out. */
async function acceptsDone(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A spin another operator accepted on `machineId`: its stake is locked. */
function spinElsewhere(machineId: string, funding: SlotFundingConfig): void {
  expect(reserveSlotWager(machineId, PLAYER, BET, funding, RESERVE)).toBe('ok');
  writeSlotMachineState(machineId, {
    ...initialSlotMachineState(),
    phase: 'spinning',
    player: PLAYER,
    bet: BET,
    requestId: 'req-elsewhere',
    acceptedAt: Date.now(),
    funding,
    fairness: { mode: 'commit-reveal', commits: ['a'.repeat(64), 'b'.repeat(64)] },
  });
}

/** A machine with its own bankroll (1,000 chips) and a round another operator
 *  accepted on it: both hold chips a teardown pays out. */
function machineHoldingChips(machineId: string): void {
  const funding = { mode: 'machine' as const, ownerId: OPERATOR };
  writeSlotFundingConfig(machineId, funding);
  expect(depositSlotFunding(machineId, OPERATOR, 1_000)).toBe(true);
  spinElsewhere(machineId, funding);
}

// ── Coin pushers ─────────────────────────────────────────────────────────────

/** A cabinet owned by `owner` that has taken `n` drops from OTHER. */
function machineWith(n: number, owner = OPERATOR): CoinPusherState {
  let s = initialCoinPusherState(owner, 0);
  for (let i = 0; i < n; i++) {
    s = processInsert(s, OTHER, (i % 3) as PusherHole, (i * 0.37) % 1, i * 7919).state;
  }
  return s;
}

function request(
  player: string,
  requestId: string,
  phase: number,
  requestedAt = Date.now(),
  hole: PusherHole = 1,
): PusherInsertRequest {
  return { requestId, player, hole, phase, requestedAt };
}

/** The player's drop at a cabinet, as their panel writes it now. */
function requestDrop(machineId: string, player = PLAYER, requestId = `drop-${machineId}`): void {
  const state = readCoinPusherState(machineId)!;
  expect(writeCoinPusherRequest(machineId, request(player, requestId, currentPusherPhase(state, Date.now())))).toBe(true);
}

/** What a drop paid the player, from the operator's answer. */
function paidBy(machineId: string, player = PLAYER): number {
  const result = readCoinPusherResult(machineId, player);
  return result?.kind === 'drop' ? result.paid : NaN;
}

// ── A v0.38 peer's hold-off ──────────────────────────────────────────────────

/** What a v0.38 client saw under one key: that exact record, first seen when. */
interface V038Sighting { id: string; at: number }

/**
 * A copy of the v0.38 hold-off (that build's slotCroupier.ts and
 * pusherCroupier.ts, each on its own key: seeLease, leaseLapsesAt, takeoverAt,
 * heldElsewhere). A record naming another session holds the peer off until a
 * term after it first saw that exact record, plus the split window unless
 * the record is a tab of the peer's own device, which is also held to the
 * expiry it claims. Run against the peer doc as the peer's page would, with
 * the peer's device id and session.
 */
function v038HeldElsewhere(
  peer: Y.Doc,
  key: RoomOperatorKey,
  memo: { sighting: V038Sighting | null },
  now: number,
): boolean {
  const record = peer.getMap('casino').get(key) as SlotOperatorLease | undefined;
  if (!record || record.sessionId === PEER_SESSION) {
    memo.sighting = null;
    return false;
  }
  const id = `${record.playerId}|${record.sessionId}|${record.tenure ?? ''}|${record.expiresAt}`;
  if (memo.sighting?.id !== id) memo.sighting = { id, at: now };
  const thisDevice = record.sessionId.startsWith(`${PEER_DEVICE}:`);
  const heldUntil = memo.sighting.at + LEASE_MS;
  const lapsesAt = thisDevice ? Math.min(record.expiresAt, heldUntil) : heldUntil;
  const takeoverAt = thisDevice ? lapsesAt : lapsesAt + OPERATOR_UNCLEAN_TAKEOVER_MS;
  return now < takeoverAt;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  doc = new Y.Doc();
  bindCasinoDoc(doc);
  setSoleCroupierPredicate(() => true);
  buyInChips(OPERATOR, 10_000);
  buyInChips(PLAYER, 100);
  stops = [];
  // A third game beside the two croupiers (the fee lane's shape), with no
  // need of its own: it only hears why each take ended.
  registerOperatorGame('air-hockey', {
    onStop: (reason) => { stops.push(reason); },
    onLeave: () => {},
  });
});

afterEach(async () => {
  slotsHook.afterDeriveReelStops = null;
  await acceptsDone();
  leaveSlotMachineRoom(); // reset this session's operator and watch state…
  leaveCoinPusherRoom(); // …the second wrapper call is a no-op
  setSoleCroupierPredicate(() => true);
  vi.useRealTimers();
});

// ── Part 1: one doc ──────────────────────────────────────────────────────────

describe('two games one lease', () => {
  it("settles one player's spin and drop under one take, named on all three keys, and the balances add up", async () => {
    fund(M1);
    const base = machineWith(60);
    writeCoinPusherState(CABINET, base);
    const seed = await requestSpin(M1);
    requestDrop(CABINET);

    frame(T0, [M1], [CABINET]);
    const taken = readCasinoOperatorLease();
    expect(taken).toEqual({ playerId: OPERATOR, sessionId: SESSION, tenure: TENURE, expiresAt: T0 + LEASE_MS });
    for (const record of records()) expect(record).toEqual(taken);
    await acceptsDone();
    expect(spinning(M1)).toBe(false); // both games still settling in
    expect(readCoinPusherRequest(CABINET, PLAYER)).not.toBeNull();

    const ready = T0 + SETTLE_MS;
    frame(ready, [M1], [CABINET]); // the accept starts; the drop is settled in this frame
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readCoinPusherResult(CABINET, PLAYER)).toMatchObject({ kind: 'drop', requestId: `drop-${CABINET}` });
    const paid = paidBy(CABINET);
    expect(readChips(PLAYER)).toBe(100 - BET - PUSHER_ANTE + paid);

    reveal(M1, seed);
    const settledAt = ready + SLOT_SPIN_MS + 10;
    frame(settledAt, [M1], [CABINET]); // the settle starts, and the lease is renewed
    await acceptsDone();
    const settled = readSlotMachineState(M1);
    expect(settled?.phase).toBe('settled');
    expect(hasSlotEscrow(M1)).toBe(false);
    // One session, one take: every record names it, in the tenure taken at T0.
    const renewed = readCasinoOperatorLease();
    expect(renewed).toEqual({ ...taken, expiresAt: settledAt + LEASE_MS });
    for (const record of records()) expect(record).toEqual(renewed);
    expect(isSlotOperator()).toBe(true);
    expect(isCoinPusherOperator()).toBe(true);
    // Every write kept: the stake debited, the payout credited, the drop settled.
    const credited = settled?.credited ?? NaN;
    expect(readChips(PLAYER)).toBe(100 - BET + credited - PUSHER_ANTE + paid);
    expect(readChips(OPERATOR)).toBe(10_000 + BET - credited);
    const after = readCoinPusherState(CABINET)!;
    expect(readChips(PLAYER) + readChips(OPERATOR) + chipsInMachine(after))
      .toBe(100 + 10_000 + chipsInMachine(base));
  });
});

describe('union need across games', () => {
  it('holds the lease for a cabinet with no slot machine in the room, and lets it go with the cabinet', () => {
    writeCoinPusherState(CABINET, machineWith(10));
    let tenure: string | undefined;
    for (let t = T0; t <= T0 + 10_000; t += 500) {
      frame(t, [], [CABINET]);
      const record = readCasinoOperatorLease();
      expect(record?.sessionId).toBe(SESSION);
      tenure ??= record?.tenure;
      expect(record?.tenure).toBe(tenure); // never let go by the slot tick, which needs nothing
      for (const other of records()) expect(other).toEqual(record);
    }
    expect(readCasinoOperatorLease()?.expiresAt).toBe(T0 + 9_000 + LEASE_MS); // renewed every 3 s
    expect(isSlotOperator()).toBe(true); // one lease for the room
    expect(readCoinPusherState(CABINET)?.ownerId).toBe(OPERATOR);
    frame(T0 + 10_500, [], []);
    expect(records()).toEqual([null, null, null]);
    expect(stops).toEqual(['released']);
  });

  it('with a machine run by hand where nobody runs the croupier, the pusher tick neither works nor lets the record go', () => {
    setSoleCroupierPredicate(() => false); // a venture room
    fund(M1);
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    requestDrop(CABINET);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0))).toBe(true);
    const taken = readCasinoOperatorLease()!;
    for (let t = T0 + 16; t <= T0 + 10_000; t += 500) {
      frame(t, [M1], [CABINET], true);
      const record = readCasinoOperatorLease();
      expect(record).toEqual({ ...taken, expiresAt: expect.any(Number) }); // the same take, never deleted
      for (const other of records()) expect(other).toEqual(record);
    }
    expect(readCasinoOperatorLease()?.expiresAt).toBe(T0 + 9_016 + LEASE_MS);
    expect(isManualSlotMachineRunning(M1, OPERATOR)).toBe(true);
    // Nobody may run the croupier, so nobody settles drops: the cabinet is left as it is.
    expect(readCoinPusherRequest(CABINET, PLAYER)?.requestId).toBe(`drop-${CABINET}`);
    expect(readCoinPusherResult(CABINET, PLAYER)).toBeNull();
    expect(readCoinPusherState(CABINET)).toEqual(base);
    expect(readChips(PLAYER)).toBe(100);
    expect(stops).toEqual([]);
  });

  it('when the deed goes while a round is winding down, the pusher stops that frame, the lease lasts until the refund lands, then goes', async () => {
    fund(M1);
    await requestSpin(M1);
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    const ready = becomeOperator([M1], [CABINET]);
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);

    setSoleCroupierPredicate(() => false); // the deed changed hands
    requestDrop(CABINET); // a drop made since
    frame(ready + 100, [M1], [CABINET]); // the refund starts, then awaits; the pusher does nothing
    expect(readCoinPusherRequest(CABINET, PLAYER)).not.toBeNull();
    expect(readCoinPusherState(CABINET)).toEqual(base);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION); // kept for the refund
    expect(stops).toEqual([]);
    await acceptsDone();
    expect(readSlotMachineState(M1)).toMatchObject({ phase: 'settled', failure: 'invalid-house-commit' });
    expect(readChips(PLAYER)).toBe(100);
    expect(readChips(OPERATOR)).toBe(10_000);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);

    frame(ready + 200, [M1], [CABINET]);
    expect(records()).toEqual([null, null, null]);
    expect(stops).toEqual(['released']);
    // The drop is still nobody's to settle.
    expect(readCoinPusherRequest(CABINET, PLAYER)).not.toBeNull();
    expect(readCoinPusherState(CABINET)).toEqual(base);
    expect(readChips(PLAYER)).toBe(100);
  });
});

describe('own lapse ends both', () => {
  it('ends the take for both games in one election on the next frame, and work paused under it writes nothing', async () => {
    fund(M1);
    await requestSpin(M1);
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    const ready = becomeOperator([M1], [CABINET]); // the accept starts, then awaits its hashes
    const first = readCasinoOperatorLease()!;

    // No frames for a while (a hidden tab): the lease lapses by this page's own clock.
    const lapsed = at(ready + 20_000);
    // The cabinet is removed before the next frame: the immediate drain finds the take over.
    closeCoinPusher(CABINET, true, lapsed);
    expect(readCoinPusherState(CABINET)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(10_000);
    expect(coinPusherWatchCount()).toBe(1); // pending

    // The frame: the slot tick's election ends the take, once, for both games…
    tickSlotMachineRoom([M1], false, lapsed);
    expect(stops).toEqual(['lost-own']);
    expect(records()).toEqual([null, null, null]);
    // …and the pusher tick's, the same frame, takes the room afresh for the drain still owed.
    tickCoinPusherRoom([], lapsed);
    tickCoinPusherTeardowns();
    const second = readCasinoOperatorLease();
    expect(second).toEqual({ ...first, tenure: TENURE, expiresAt: lapsed + LEASE_MS });
    expect(second?.tenure).not.toBe(first.tenure);
    for (const record of records()) expect(record).toEqual(second);
    expect(stops).toEqual(['lost-own']);
    expect(readCoinPusherState(CABINET)).toEqual(base); // a settling wait first

    // The accept, paused under the first take, writes nothing under the second.
    await acceptsDone();
    expect(spinning(M1)).toBe(false);
    expect(hasSlotEscrow(M1)).toBe(false);
    expect(readSlotPlayRequests(M1)).toHaveLength(1);
    expect(readChips(PLAYER)).toBe(100);

    // Past the new settling wait, both games work under the new take.
    frame(lapsed + SETTLE_MS, [M1], []);
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
    expect(readCoinPusherState(CABINET)).toBeNull();
    expect(readChips(OPERATOR)).toBe(10_000 + BET - RESERVE + chipsInMachine(base));
  });
});

describe('stop reaches every game', () => {
  it("a record naming this page with another take, under the pusher key, ends the take in the pusher tick; the slot accept paused meanwhile writes nothing", async () => {
    fund(M1);
    await requestSpin(M1);
    const base = machineWith(30, OTHER); // owned elsewhere: the pusher's first pass would re-own it
    writeCoinPusherState(CABINET, base);
    frame(T0, [M1], [CABINET]);
    const ready = at(T0 + SETTLE_MS);
    tickSlotMachineRoom([M1], false, ready); // the accept starts, then awaits its hashes
    // Between the frame's two ticks a peer's write lands under the pusher key,
    // naming this session with another take (a stale record of this page's
    // written back, or forged): not this page's lease, under any key.
    const mine = readCasinoOperatorLease()!;
    writeCoinPusherOperatorLease({ ...mine, tenure: 'forged' });
    tickCoinPusherRoom([CABINET], ready);
    tickCoinPusherTeardowns();
    expect(stops).toEqual(['lost-own']);
    expect(records()).toEqual([null, null, null]); // every record naming this session, the forged one too
    expect(readCoinPusherState(CABINET)).toEqual(base); // not re-owned: the pusher worked nothing
    await acceptsDone();
    expect(spinning(M1)).toBe(false);
    expect(hasSlotEscrow(M1)).toBe(false);
    expect(readSlotPlayRequests(M1)).toHaveLength(1);
    expect(readChips(PLAYER)).toBe(100);
    // The next frame takes the room afresh, and both games work after its settling wait.
    frame(ready + 16, [M1], [CABINET]);
    const retaken = readCasinoOperatorLease();
    expect(retaken?.sessionId).toBe(SESSION);
    expect([mine.tenure, 'forged']).not.toContain(retaken?.tenure);
    frame(ready + 16 + SETTLE_MS, [M1], [CABINET]);
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readCoinPusherState(CABINET)?.ownerId).toBe(OPERATOR);
    expect(stops).toEqual(['lost-own']);
  });
});

describe('a take that ends with a drain pending', () => {
  it('drains the removed cabinet under the next take', () => {
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    frame(T0, [], [CABINET]); // the pusher takes the room
    const first = readCasinoOperatorLease()!;
    closeCoinPusher(CABINET, true, T0 + 10); // removed while the take is still settling: pending
    expect(readCoinPusherState(CABINET)).toEqual(base);
    expect(coinPusherWatchCount()).toBe(1);
    // No frames for 9 s: the take lapsed. The next frame ends it, and takes
    // the room again for the drain still owed.
    frame(T0 + 9_000, [], []);
    expect(stops).toEqual(['lost-own']);
    const second = readCasinoOperatorLease();
    expect(second).toEqual({ ...first, tenure: TENURE, expiresAt: T0 + 9_000 + LEASE_MS });
    expect(second?.tenure).not.toBe(first.tenure);
    expect(readCoinPusherState(CABINET)).toEqual(base);
    frame(T0 + 9_000 + SETTLE_MS - 1, [], []);
    expect(readCoinPusherState(CABINET)).toEqual(base);
    frame(T0 + 9_000 + SETTLE_MS, [], []);
    expect(readCoinPusherState(CABINET)).toBeNull();
    expect(readChips(OPERATOR)).toBe(10_000 + chipsInMachine(base));
    frame(T0 + 9_000 + SETTLE_MS + 16, [], []);
    expect(records()).toEqual([null, null, null]); // nothing left to need the room
    expect(coinPusherWatchCount()).toBe(0);
  });
});

describe('legacy room-wide', () => {
  const legacyKey = `slot-operator:${M1}`;

  it("an earlier build's per-machine lease, renewed, ends a held take and keeps the pusher idle too", async () => {
    fund(M1);
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    const ready = becomeOperator([M1], [CABINET]);
    requestDrop(CABINET); // made after the operator's last pass
    const map = doc.getMap('casino');
    let last = ready;
    for (let t = ready + 100; t <= ready + 20_100; t += 1_000) {
      if ((t - ready - 100) % RENEW_MS === 0) {
        map.set(legacyKey, legacy(t + LEASE_MS));
        last = t;
      }
      frame(t, [M1], [CABINET]);
      expect(records()).toEqual([null, null, null]);
    }
    expect(stops).toEqual(['legacy']);
    expect(readCoinPusherRequest(CABINET, PLAYER)).not.toBeNull();
    expect(readCoinPusherResult(CABINET, PLAYER)).toBeNull();
    expect(readCoinPusherState(CABINET)).toEqual(base);
    expect(readChips(PLAYER)).toBe(100);
    setSoleCroupierPredicate(() => false);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(ready + 20_200))).toBe(false);
    setSoleCroupierPredicate(() => true);
    // Not renewed again: a term after its last renewal it is tidied and the
    // room taken, and the drop settled once the settling wait is over.
    frame(last + LEASE_MS, [M1], [CABINET]);
    expect(map.has(legacyKey)).toBe(false);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
    expect(readCoinPusherRequest(CABINET, PLAYER)).not.toBeNull();
    frame(last + LEASE_MS + SETTLE_MS, [M1], [CABINET]);
    expect(readCoinPusherResult(CABINET, PLAYER)?.kind).toBe('drop');
    expect(readChips(PLAYER)).toBe(100 - PUSHER_ANTE + paidBy(CABINET));
  });

  it('once lapsed, is tidied by a slot tick that may operate, never by a pusher tick without the deed', () => {
    const map = doc.getMap('casino');
    map.set(legacyKey, legacy(T0 + LEASE_MS));
    setSoleCroupierPredicate(() => false);
    fund(M1);
    frame(T0, [M1], [CABINET]); // seen now, by a visitor
    // A visitor's ticks never tidy it, however long it has lapsed.
    frame(T0 + LEASE_MS + 60_000, [M1], [CABINET]);
    expect(map.has(legacyKey)).toBe(true);
    // A room owner who may run machines by hand: the pusher tick still may not (no deed)…
    tickCoinPusherRoom([CABINET], at(T0 + LEASE_MS + 60_016));
    expect(map.has(legacyKey)).toBe(true);
    // …the slot tick may.
    tickSlotMachineRoom([M1], true, at(T0 + LEASE_MS + 60_032));
    expect(map.has(legacyKey)).toBe(false);
    expect(records()).toEqual([null, null, null]); // nothing run by hand: nothing taken
    // The deed holder's slot tick tidies one too, then takes the room.
    map.set(`slot-operator:${M2}`, legacy(T0 + LEASE_MS + 60_100 + LEASE_MS));
    setSoleCroupierPredicate(() => true);
    frame(T0 + LEASE_MS + 60_100, [M1], [CABINET]);
    expect(records()).toEqual([null, null, null]);
    frame(T0 + 2 * LEASE_MS + 60_100, [M1], [CABINET]);
    expect(map.has(`slot-operator:${M2}`)).toBe(false);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
  });

  it('one appearing between frames fails the check before a pusher drain, which then waits for the room', () => {
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    const ready = becomeOperator([], [CABINET]);
    const map = doc.getMap('casino');
    map.set(legacyKey, legacy(ready + LEASE_MS)); // arrived since the last frame
    closeCoinPusher(CABINET, true, ready + 10); // the immediate drain reads the doc afresh
    expect(readCoinPusherState(CABINET)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(10_000);
    expect(coinPusherWatchCount()).toBe(1); // pending
    frame(ready + 16, [], []); // the take ends: an earlier build operates here
    expect(stops).toEqual(['legacy']);
    expect(records()).toEqual([null, null, null]);
    expect(readCoinPusherState(CABINET)).toEqual(base);
    // A term after the drain's own check first saw it, the lapsed record is
    // tidied and the room taken for the drain.
    frame(ready + 10 + LEASE_MS - 1, [], []);
    expect(map.has(legacyKey)).toBe(true);
    expect(records()).toEqual([null, null, null]);
    frame(ready + 10 + LEASE_MS, [], []);
    expect(map.has(legacyKey)).toBe(false);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
    expect(readCoinPusherState(CABINET)).toEqual(base);
    frame(ready + 10 + LEASE_MS + SETTLE_MS, [], []);
    expect(readCoinPusherState(CABINET)).toBeNull();
    expect(readChips(OPERATOR)).toBe(10_000 + chipsInMachine(base));
  });

  it("a chip-less slot removal keeps its keys, that record among them, while it is renewed, and loses them once it lapses", () => {
    fund(M1); // the owner's balance is its bankroll: no chips of its own
    writeSlotMachineState(M1, initialSlotMachineState());
    const map = doc.getMap('casino');
    map.set(legacyKey, legacy(T0 + LEASE_MS)); // an earlier build operates the machine
    frame(T0, [M1], []);
    closeSlotMachine(M1, true); // removed here
    let last = T0;
    for (let t = T0 + 1_000; t <= T0 + 12_000; t += 1_000) {
      if ((t - T0) % RENEW_MS === 0) {
        map.set(legacyKey, legacy(t + LEASE_MS));
        last = t;
      }
      frame(t, [], []);
      expect(readSlotFundingConfig(M1)).not.toBeNull();
      expect(readSlotMachineState(M1)).not.toBeNull();
      expect(map.has(legacyKey)).toBe(true);
      expect(slotOperatorWatchCount()).toBe(2); // the record, and the removal waiting
    }
    expect(records()).toEqual([null, null, null]); // never needed the room
    frame(last + LEASE_MS - 1, [], []);
    expect(readSlotFundingConfig(M1)).not.toBeNull();
    frame(last + LEASE_MS, [], []);
    expect(readSlotFundingConfig(M1)).toBeNull();
    expect(readSlotMachineState(M1)).toBeNull();
    expect(map.has(legacyKey)).toBe(false);
    expect(slotOperatorWatchCount()).toBe(0);
    expect(records()).toEqual([null, null, null]);
    expect(readChips(OPERATOR)).toBe(10_000);
  });
});

describe('teardowns', () => {
  it('a removed slot machine holding chips holds the lease with no machine listed, and is paid out only past the settling wait', async () => {
    machineHoldingChips(M1);
    closeSlotMachine(M1, true);
    frame(T0, [], []);
    const taken = readCasinoOperatorLease();
    expect(taken?.sessionId).toBe(SESSION);
    for (const record of records()) expect(record).toEqual(taken);
    expect(slotOperatorWatchCount()).toBe(1);
    frame(T0 + SETTLE_MS - 1, [], []);
    await acceptsDone();
    expect(hasSlotEscrow(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
    frame(T0 + SETTLE_MS, [], []);
    await acceptsDone();
    expect(readSlotMachineState(M1)).toBeNull();
    expect(hasSlotEscrow(M1)).toBe(false);
    expect(readChips(PLAYER)).toBe(100); // the stake back
    expect(readChips(OPERATOR)).toBe(10_000); // the bankroll back with its owner
    frame(T0 + SETTLE_MS + 16, [], []);
    expect(records()).toEqual([null, null, null]);
    expect(slotOperatorWatchCount()).toBe(0);
  });

  it('a removed cabinet holds the lease with no cabinet listed, and is drained only past the settling wait', () => {
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    closeCoinPusher(CABINET, true, T0); // nobody holds the room
    expect(readCoinPusherState(CABINET)).toEqual(base);
    frame(T0 + 16, [], []);
    const taken = readCasinoOperatorLease();
    expect(taken?.sessionId).toBe(SESSION);
    for (const record of records()) expect(record).toEqual(taken);
    expect(coinPusherWatchCount()).toBe(1);
    frame(T0 + 16 + SETTLE_MS - 1, [], []);
    expect(readCoinPusherState(CABINET)).toEqual(base);
    frame(T0 + 16 + SETTLE_MS, [], []);
    expect(readCoinPusherState(CABINET)).toBeNull();
    expect(readChips(OPERATOR)).toBe(10_000 + chipsInMachine(base));
    frame(T0 + 16 + SETTLE_MS + 16, [], []);
    expect(records()).toEqual([null, null, null]);
    expect(coinPusherWatchCount()).toBe(0);
  });

  it('both, removed together, are torn down in one frame under one take', async () => {
    machineHoldingChips(M1);
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    closeSlotMachine(M1, true);
    closeCoinPusher(CABINET, true, T0);
    frame(T0 + 16, [], []);
    const taken = readCasinoOperatorLease();
    expect(taken?.sessionId).toBe(SESSION);
    expect(slotOperatorWatchCount()).toBe(1);
    expect(coinPusherWatchCount()).toBe(1);
    frame(T0 + 16 + SETTLE_MS, [], []);
    await acceptsDone();
    expect(readSlotMachineState(M1)).toBeNull();
    expect(readCoinPusherState(CABINET)).toBeNull();
    expect(readChips(PLAYER)).toBe(100);
    expect(readChips(OPERATOR)).toBe(10_000 + chipsInMachine(base));
    expect(readCasinoOperatorLease()?.tenure).toBe(taken?.tenure);
    frame(T0 + 16 + SETTLE_MS + 16, [], []);
    expect(records()).toEqual([null, null, null]);
  });
});

describe('leave across games', () => {
  it("leaveSlotMachineRoom() alone resets the pusher's queue and watch, and the second wrapper call is a no-op", () => {
    writeSlotOperatorLease(lease(T0 + LEASE_MS)); // a v0.38 peer operates the room
    frame(T0, [], []); // watched by both games' ticks, needing nothing
    expect(slotOperatorWatchCount()).toBe(1);
    expect(coinPusherWatchCount()).toBe(1);
    const base = machineWith(30);
    writeCoinPusherState(CABINET, base);
    closeCoinPusher(CABINET, true, T0); // left pending for the holder
    frame(T0 + 16, [], []);
    expect(coinPusherWatchCount()).toBe(2); // the peer's record, the teardown
    expect(slotOperatorWatchCount()).toBe(1);
    leaveSlotMachineRoom();
    expect(stops).toEqual(['leaving']);
    expect(coinPusherWatchCount()).toBe(0);
    expect(slotOperatorWatchCount()).toBe(0);
    expect(readSlotOperatorLease()).toEqual(lease(T0 + LEASE_MS)); // theirs, left alone
    // Frames go on while the leave is flushed: nothing is taken back, even
    // once the room is free and a cabinet is listed.
    doc.getMap('casino').delete(SLOT_OPERATOR_KEY);
    for (const t of [T0 + 100, T0 + 3_000, T0 + 90_000]) frame(t, [], [CABINET]);
    expect(records()).toEqual([null, null, null]);
    expect(readCoinPusherState(CABINET)).toEqual(base);
    expect(readChips(OPERATOR)).toBe(10_000);
    expect(coinPusherWatchCount()).toBe(0);
    const transactions = countTransactions(doc);
    expect(() => leaveCoinPusherRoom()).not.toThrow();
    expect(transactions()).toBe(0);
    expect(coinPusherWatchCount()).toBe(0);
    expect(slotOperatorWatchCount()).toBe(0);
  });

  it("leaveCoinPusherRoom() alone resets the slot's machines run by hand and its queue, and the second wrapper call is a no-op", async () => {
    setSoleCroupierPredicate(() => false); // a venture room
    fund(M1);
    await requestSpin(M1);
    machineHoldingChips(M2);
    closeSlotMachine(M2, true);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0))).toBe(true);
    frame(T0 + 16, [M1], [], true);
    expect(slotOperatorWatchCount()).toBe(1); // the removal waiting
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
    leaveCoinPusherRoom();
    expect(stops).toEqual(['leaving']);
    expect(records()).toEqual([null, null, null]);
    expect(isManualSlotMachineRunning(M1, OPERATOR)).toBe(false);
    expect(slotOperatorWatchCount()).toBe(0);
    expect(coinPusherWatchCount()).toBe(0);
    // Frames go on while the leave is flushed: nothing is operated or torn down.
    for (const t of [T0 + 100, T0 + SETTLE_MS + 100, T0 + 90_000]) frame(t, [M1], [], true);
    await acceptsDone();
    expect(records()).toEqual([null, null, null]);
    expect(spinning(M1)).toBe(false);
    expect(readSlotPlayRequests(M1)).toHaveLength(1);
    expect(hasSlotEscrow(M2)).toBe(true); // left to the sessions still in the room
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0 + 90_016))).toBe(false);
    const transactions = countTransactions(doc);
    expect(() => leaveSlotMachineRoom()).not.toThrow();
    expect(transactions()).toBe(0);
    expect(slotOperatorWatchCount()).toBe(0);
    expect(coinPusherWatchCount()).toBe(0);
  });
});

// ── Part 2: a v0.38 peer ─────────────────────────────────────────────────────

describe('mixed-room hold-off', () => {
  it.each([SLOT_OPERATOR_KEY, COIN_PUSHER_OPERATOR_KEY] as const)(
    'a v0.38 peer renewing %s holds both games off, and this build writes no record',
    async (key) => {
      fund(M1);
      await requestSpin(M1);
      const base = machineWith(30);
      writeCoinPusherState(CABINET, base);
      requestDrop(CABINET);
      const peer = new Y.Doc();
      sync(doc, peer);
      const theirs = (t: number): SlotOperatorLease =>
        ({ playerId: OPERATOR, sessionId: PEER_SESSION, tenure: 'peer-take', expiresAt: t + LEASE_MS });
      for (let t = T0; t <= T0 + 30_000; t += 1_000) {
        if ((t - T0) % RENEW_MS === 0) {
          peer.getMap('casino').set(key, theirs(t));
          sync(doc, peer);
        }
        frame(t, [M1], [CABINET]);
        expect(readCasinoOperatorLease()).toBeNull();
        expect(readRoomOperatorLease(key)).toEqual(theirs(t - ((t - T0) % RENEW_MS)));
      }
      await acceptsDone();
      sync(doc, peer);
      for (const other of ROOM_OPERATOR_KEYS) {
        if (other !== key) expect(peer.getMap('casino').has(other)).toBe(false);
      }
      expect(spinning(M1)).toBe(false);
      expect(readSlotPlayRequests(M1)).toHaveLength(1);
      expect(readCoinPusherRequest(CABINET, PLAYER)).not.toBeNull();
      expect(readCoinPusherResult(CABINET, PLAYER)).toBeNull();
      expect(readCoinPusherState(CABINET)).toEqual(base);
      expect(readChips(PLAYER)).toBe(100);
      expect(isSlotOperator()).toBe(false);
      expect(isCoinPusherOperator()).toBe(false);
      expect(stops).toEqual([]);
    },
  );
});

describe('mixed-room shadows', () => {
  it("a v0.38 peer reads both old keys naming this session in the primary's tenure at every renewal, waits on them, and finds all three gone after the leave", () => {
    fund(M1);
    const peer = new Y.Doc();
    // The peer's slot election and its pusher election each keep their own memo.
    const memo = { sighting: null as V038Sighting | null };
    const pusherMemo = { sighting: null as V038Sighting | null };
    const peerReads = (key: RoomOperatorKey): unknown => peer.getMap('casino').get(key);
    let tenure: string | undefined;
    for (let t = T0; t <= T0 + 30_000; t += 1_000) {
      frame(t, [M1], [CABINET]);
      sync(doc, peer);
      const primary = readCasinoOperatorLease();
      tenure ??= primary?.tenure;
      expect(primary).toEqual({
        playerId: OPERATOR, sessionId: SESSION, tenure, expiresAt: t - ((t - T0) % RENEW_MS) + LEASE_MS,
      });
      expect(peerReads(SLOT_OPERATOR_KEY)).toEqual(primary);
      expect(peerReads(COIN_PUSHER_OPERATOR_KEY)).toEqual(primary);
      expect(v038HeldElsewhere(peer, SLOT_OPERATOR_KEY, memo, t)).toBe(true);
      expect(v038HeldElsewhere(peer, COIN_PUSHER_OPERATOR_KEY, pusherMemo, t)).toBe(true);
    }
    expect(tenure).toEqual(TENURE);
    // Were the renewals to stop, the peer would take over a term and the
    // split window after the last one it saw: the copy is the v0.38 rule.
    expect(v038HeldElsewhere(peer, SLOT_OPERATOR_KEY, memo, T0 + 30_000 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1)).toBe(true);
    expect(v038HeldElsewhere(peer, SLOT_OPERATOR_KEY, memo, T0 + 30_000 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS)).toBe(false);
    // Leaving deletes every record naming this session: the peer sees none.
    leaveSlotMachineRoom();
    sync(doc, peer);
    for (const key of ROOM_OPERATOR_KEYS) expect(peer.getMap('casino').has(key)).toBe(false);
    expect(v038HeldElsewhere(peer, SLOT_OPERATOR_KEY, memo, T0 + 30_016)).toBe(false);
  });
});

describe('mixed-room device continuity', () => {
  it("takes a v0.38 record of a tab on this device at its lapse, and one of an unknown device only after the split window", () => {
    fund(M1);
    writeCoinPusherState(CABINET, machineWith(10));
    let peer = new Y.Doc();
    const sameDevice = lease(T0 + 5_000, `${DEVICE}:other-tab`);
    peer.getMap('casino').set(COIN_PUSHER_OPERATOR_KEY, sameDevice); // a v0.38 pusher tab of this profile
    sync(doc, peer);
    frame(T0, [M1], [CABINET]);
    frame(T0 + 4_999, [M1], [CABINET]);
    expect(records()).toEqual([null, null, sameDevice]);
    frame(T0 + 5_000, [M1], [CABINET]);
    const mine = readCasinoOperatorLease();
    expect(mine?.sessionId).toBe(SESSION);
    for (const record of records()) expect(record).toEqual(mine);
    sync(doc, peer);
    expect(peer.getMap('casino').get(COIN_PUSHER_OPERATOR_KEY)).toEqual(mine);

    // A device this profile never used: judged by sightings, never by its expiry.
    leaveSlotMachineRoom();
    doc = new Y.Doc();
    bindCasinoDoc(doc);
    peer = new Y.Doc();
    const unknown = lease(T0 + 5_000, 'unknown-device:tab');
    peer.getMap('casino').set(SLOT_OPERATOR_KEY, unknown);
    sync(doc, peer);
    // First seen by a frame with nothing to operate (World ticks the room on
    // every client): the window runs from then, not from the first need.
    const t1 = T0 + 10_000;
    frame(t1, [], []);
    expect(slotOperatorWatchCount()).toBe(1);
    fund(M1);
    frame(t1 + 1_000, [M1], []);
    frame(t1 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1, [M1], []);
    expect(records()).toEqual([null, unknown, null]);
    frame(t1 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS, [M1], []);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
    expect(readSlotOperatorLease()?.sessionId).toBe(SESSION);
  });
});

describe('mixed-room race', () => {
  it("a v0.38 peer's take winning the slot key ends the take as lost to a foreign holder: only this session's records go, machines run by hand are forgotten, and the room waits for its lapse", () => {
    setSoleCroupierPredicate(() => false); // a venture room
    fund(M1);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0))).toBe(true);
    frame(T0 + 16, [M1], [CABINET], true);
    const peer = new Y.Doc();
    sync(doc, peer);
    // The peer, a v0.38 slot tab on another device, took its key in the same
    // window: its write wins the merge on that key alone.
    const theirs: SlotOperatorLease = {
      playerId: OTHER, sessionId: PEER_SESSION, tenure: 'peer-take', expiresAt: T0 + 100 + LEASE_MS,
    };
    peer.getMap('casino').set(SLOT_OPERATOR_KEY, theirs);
    sync(doc, peer);
    expect(readSlotOperatorLease()).toEqual(theirs);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
    expect(readCoinPusherOperatorLease()?.sessionId).toBe(SESSION);

    frame(T0 + 100, [M1], [CABINET], true);
    expect(stops).toEqual(['lost-foreign']);
    expect(records()).toEqual([null, theirs, null]);
    expect(isManualSlotMachineRunning(M1, OPERATOR)).toBe(false);
    sync(doc, peer);
    expect(peer.getMap('casino').has(CASINO_OPERATOR_KEY)).toBe(false);
    expect(peer.getMap('casino').has(COIN_PUSHER_OPERATOR_KEY)).toBe(false);
    expect(peer.getMap('casino').get(SLOT_OPERATOR_KEY)).toEqual(theirs);
    // Held off until the record lapses (another device: a term and the split
    // window after this page first saw it): RUN is refused and frames take nothing.
    const takeover = T0 + 100 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS;
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0 + 200))).toBe(false);
    for (const t of [T0 + 200, T0 + 3_000, takeover - 1]) frame(t, [M1], [CABINET], true);
    expect(records()).toEqual([null, theirs, null]);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(takeover - 1))).toBe(false);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(takeover))).toBe(true);
    const retaken = readCasinoOperatorLease();
    expect(retaken?.sessionId).toBe(SESSION);
    for (const record of records()) expect(record).toEqual(retaken);
    expect(isManualSlotMachineRunning(M1, OPERATOR)).toBe(true);
  });
});

describe('stale trio', () => {
  it('three records left by a crashed new page are taken at their takeover: a tab of this device at its lapse, another device after the split window', () => {
    fund(M1);
    writeCoinPusherState(CABINET, machineWith(10));
    const trio = (sessionId: string): SlotOperatorLease =>
      ({ playerId: OPERATOR, sessionId, tenure: 'crashed-take', expiresAt: T0 + 5_000 });
    const leftBehind = (peer: Y.Doc, record: SlotOperatorLease): void => {
      peer.transact(() => {
        for (const key of ROOM_OPERATOR_KEYS) peer.getMap('casino').set(key, record);
      });
      sync(doc, peer);
    };
    leftBehind(new Y.Doc(), trio(`${DEVICE}:crashed-tab`));
    frame(T0, [M1], [CABINET]);
    frame(T0 + 4_999, [M1], [CABINET]);
    for (const record of records()) expect(record).toEqual(trio(`${DEVICE}:crashed-tab`));
    frame(T0 + 5_000, [M1], [CABINET]);
    const mine = readCasinoOperatorLease();
    expect(mine).toEqual({ playerId: OPERATOR, sessionId: SESSION, tenure: TENURE, expiresAt: T0 + 5_000 + LEASE_MS });
    for (const record of records()) expect(record).toEqual(mine);

    // Another device's: judged by sightings, never by the expiry it claims,
    // from the frame that first saw it, whether or not anything needed the room.
    leaveSlotMachineRoom();
    doc = new Y.Doc();
    bindCasinoDoc(doc);
    leftBehind(new Y.Doc(), trio('other-device:crashed-tab'));
    const t1 = T0 + 10_000;
    frame(t1, [], []);
    expect(coinPusherWatchCount()).toBe(1); // three keys, one holder
    fund(M1);
    frame(t1 + 1_000, [M1], []);
    frame(t1 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1, [M1], []);
    for (const record of records()) expect(record).toEqual(trio('other-device:crashed-tab'));
    frame(t1 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS, [M1], []);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
    for (const record of records()) expect(record?.sessionId).toBe(SESSION);
    expect(stops).toEqual(['leaving']);
  });
});

// ── The settle's pre-write check ─────────────────────────────────────────────

describe("the settle's pre-write check", () => {
  it('sits after its last await: a take another session wins between that await and the write stops the write', async () => {
    fund(M1);
    const seed = await requestSpin(M1);
    const ready = becomeOperator([M1], []);
    await acceptsDone();
    reveal(M1, seed);
    const t = ready + SLOT_SPIN_MS + 10;
    // Two microtasks after the settle's reel derivation resolves is exactly
    // between its last await (the funding lease, which resolves at once) and
    // its check: the only place a take lost there can be caught.
    slotsHook.afterDeriveReelStops = () => {
      slotsHook.afterDeriveReelStops = null;
      queueMicrotask(() => queueMicrotask(() => {
        writeCasinoOperatorRecords(lease(t + LEASE_MS), ROOM_OPERATOR_KEYS); // taken over meanwhile
      }));
    };
    frame(t, [M1], []); // the settle starts, then awaits
    await acceptsDone();
    expect(slotsHook.afterDeriveReelStops).toBeNull(); // the derivation ran
    expect(readCasinoOperatorLease()?.sessionId).toBe(PEER_SESSION);
    expect(spinning(M1)).toBe(true); // nothing written behind the new holder
    expect(hasSlotEscrow(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
  });
});
