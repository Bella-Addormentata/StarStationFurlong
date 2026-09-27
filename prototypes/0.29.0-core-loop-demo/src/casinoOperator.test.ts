/**
 * 🎰🪙 casinoOperator tests: ONE session operates every casino game in the
 * room under one lease (`casino-operator`, shadowed on the two v0.38 room
 * keys), against a real Yjs-backed casino map. These pin the election's core
 * rules, driven as a game's tick drives them (reportOperatorNeed, then
 * electCasinoOperator) with a stub game registered as the fee lane will be:
 * the take, settling wait and renewal, the tenure, lapse and takeover maths,
 * the per-key hold-off on any of the three records, the union of the games'
 * needs, the pre-write check, the RUN path, earlier builds' per-machine
 * leases, leaving, doc epochs, the panel states and the watch count. The
 * croupiers' own tests cover their wiring to it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  bindCasinoDoc,
  CASINO_OPERATOR_KEY,
  COIN_PUSHER_OPERATOR_KEY,
  LEGACY_SLOT_LEASE_READ_CAP,
  readCasinoOperatorLease,
  readCoinPusherOperatorLease,
  readLegacySlotOperatorMachineIds,
  readRoomOperatorLease,
  readSlotOperatorLease,
  ROOM_OPERATOR_KEYS,
  SLOT_OPERATOR_KEY,
  writeCasinoOperatorRecords,
  writeCoinPusherOperatorLease,
  writeSlotOperatorLease,
} from './casinoDoc';
import type { RoomOperatorKey, SlotOperatorLease } from './casinoDoc';
import {
  casinoLeaseObserved,
  casinoOperatorSession,
  casinoOperatorState,
  coinPusherOperatorState,
  currentTake,
  earlierBuildLeasesWatched,
  electCasinoOperator,
  forgetEarlierBuildLease,
  isEarlierBuildOperatingNow,
  isLeavingCasinoRoom,
  leaveCasinoRoom,
  OPERATOR_LEASE_MS,
  OPERATOR_LEASE_RENEW_MS,
  OPERATOR_LEASE_SETTLE_MS,
  OPERATOR_UNCLEAN_TAKEOVER_MS,
  operatorReady,
  ownsCasinoOperatorLease,
  registerOperatorGame,
  releaseCasinoOperatorLease,
  reportOperatorNeed,
  stillOperates,
  takeCasinoOperatorLease,
  WRITE_LEGACY_ROOM_SHADOWS,
} from './casinoOperator';
import type { ElectionOutcome, OperatorStopReason } from './casinoOperator';
import { getPlayerId } from './identity';

const OPERATOR = getPlayerId();
const OTHER = 'player-Carol';
const M1 = 'slot-machine-1';
const T0 = 1_000_000_000;
const LEASE_MS = 8_000;
const SETTLE_MS = 2_000;
const RENEW_MS = 3_000;
const SESSION = casinoOperatorSession();
/** This page's device: tabs on it share this prefix in their session ids. */
const DEVICE = SESSION.split(':')[0];
const TENURE = expect.stringMatching(/^[0-9a-f-]{36}$/);

let doc: Y.Doc;
/** What the stub game was told. */
let stops: OperatorStopReason[];
let leaves: number;

function at(t: number): number {
  vi.setSystemTime(t);
  return t;
}

/** A record another session holds (another device unless `sessionId` says). */
function lease(expiresAt: number, sessionId = 'other-device:tab', playerId = OPERATOR): SlotOperatorLease {
  return { playerId, sessionId, expiresAt };
}

/** A peer's write under one key: a v0.38 client writes its own key only. */
function writeKey(key: RoomOperatorKey, record: SlotOperatorLease): void {
  writeCasinoOperatorRecords(record, [key]);
}

/** The three records as the doc holds them now. */
function records(): (SlotOperatorLease | null)[] {
  return ROOM_OPERATOR_KEYS.map((key) => readRoomOperatorLease(key));
}

/** An earlier build's per-machine lease. */
function legacy(expiresAt: number): SlotOperatorLease {
  return { playerId: OPERATOR, sessionId: 'a'.repeat(64), expiresAt };
}
const legacyKey = `slot-operator:${M1}`;

function countTransactions(d: Y.Doc): () => number {
  let n = 0;
  d.on('afterTransaction', () => { n += 1; });
  return () => n;
}

/** The stub game's tick: report its need, then run the election. */
function tick(t: number, need = true, tidy = true): ElectionOutcome {
  reportOperatorNeed('air-hockey', need);
  return electCasinoOperator(at(t), tidy);
}

/** Take the room's lease at `t`, then tick past the settling wait. */
function becomeOperator(t = T0): number {
  tick(t);
  tick(t + SETTLE_MS);
  return t + SETTLE_MS;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  doc = new Y.Doc();
  bindCasinoDoc(doc);
  stops = [];
  leaves = 0;
  registerOperatorGame('air-hockey', {
    onStop: (reason) => { stops.push(reason); },
    onLeave: () => { leaves += 1; },
  });
});

afterEach(() => {
  leaveCasinoRoom(); // reset this session's take and watch state
  vi.useRealTimers();
});

// ── The election ─────────────────────────────────────────────────────────────

describe('the election', () => {
  it('takes the room on a need, under all three keys in one transaction, and is ready after its settling wait', () => {
    expect(WRITE_LEGACY_ROOM_SHADOWS).toBe(true);
    // A peer sees all three records or none, at every write.
    const peer = new Y.Doc();
    const partial: boolean[] = [];
    doc.on('update', (update: Uint8Array) => {
      Y.applyUpdate(peer, update);
      const present = ROOM_OPERATOR_KEYS.filter((key) => peer.getMap('casino').has(key)).length;
      partial.push(present !== 0 && present !== ROOM_OPERATOR_KEYS.length);
    });
    const transactions = countTransactions(doc);
    expect(tick(T0)).toEqual({ kind: 'starting', playerId: OPERATOR, tenure: TENURE });
    expect(transactions()).toBe(1);
    const mine = readCasinoOperatorLease();
    expect(mine).toEqual({ playerId: OPERATOR, sessionId: SESSION, tenure: TENURE, expiresAt: T0 + LEASE_MS });
    for (const record of records()) expect(record).toEqual(mine);
    expect(currentTake()).toEqual({ docEpoch: expect.any(Number), playerId: OPERATOR, tenure: mine!.tenure, readyAt: T0 + SETTLE_MS });
    expect(ownsCasinoOperatorLease(OPERATOR, T0)).toBe(true);
    expect(tick(T0 + SETTLE_MS - 1)).toEqual({ kind: 'starting', playerId: OPERATOR, tenure: mine!.tenure });
    expect(operatorReady(T0 + SETTLE_MS - 1)).toBe(false);
    const ready = tick(T0 + SETTLE_MS);
    expect(ready).toEqual({ kind: 'ready', docEpoch: expect.any(Number), playerId: OPERATOR, tenure: mine!.tenure });
    expect(operatorReady(T0 + SETTLE_MS)).toBe(true);
    expect(stillOperates((ready as { docEpoch: number }).docEpoch, mine!.tenure!, T0 + SETTLE_MS)).toBe(true);
    expect(partial.some(Boolean)).toBe(false);
    expect(stops).toEqual([]);
  });

  it('writes nothing without a need', () => {
    expect(tick(T0, false)).toEqual({ kind: 'idle' });
    expect(tick(T0 + 16, false)).toEqual({ kind: 'idle' });
    expect(records()).toEqual([null, null, null]);
    expect(currentTake()).toBeNull();
    expect(stops).toEqual([]);
  });

  it('called twice at one time neither writes twice nor ends anything', () => {
    becomeOperator();
    const transactions = countTransactions(doc);
    expect(tick(T0 + 2_500).kind).toBe('ready');
    expect(tick(T0 + 2_500).kind).toBe('ready');
    expect(transactions()).toBe(0);
    expect(stops).toEqual([]);
  });

  it('never takes a foreign record that is renewed, and never counts its own', () => {
    // Another session of the same player (a new build: all three keys) keeps renewing.
    for (let t = T0; t <= T0 + 30_000; t += 1_000) {
      if ((t - T0) % 3_000 === 0) writeCasinoOperatorRecords(lease(t + LEASE_MS), ROOM_OPERATOR_KEYS);
      expect(tick(t)).toEqual({ kind: 'held-elsewhere' });
    }
    expect(readCasinoOperatorLease()?.sessionId).toBe('other-device:tab');
    expect(ownsCasinoOperatorLease(OPERATOR)).toBe(false);
    expect(casinoLeaseObserved()).toBe(1);
    expect(stops).toEqual([]);
  });

  it('exposes the constants the croupiers re-export', () => {
    expect(OPERATOR_LEASE_MS).toBe(LEASE_MS);
    expect(OPERATOR_LEASE_SETTLE_MS).toBe(SETTLE_MS);
    expect(OPERATOR_LEASE_RENEW_MS).toBe(RENEW_MS);
    expect(OPERATOR_UNCLEAN_TAKEOVER_MS).toBe(60_000);
  });
});

// ── Renewal ──────────────────────────────────────────────────────────────────

describe('renewal', () => {
  it('renews at 3 s and not before, keeping the tenure, under every key in one transaction', () => {
    becomeOperator();
    const first = readCasinoOperatorLease()!;
    const transactions = countTransactions(doc);
    tick(T0 + RENEW_MS - 1);
    expect(transactions()).toBe(0);
    for (const record of records()) expect(record?.expiresAt).toBe(T0 + LEASE_MS);
    tick(T0 + RENEW_MS);
    expect(transactions()).toBe(1);
    for (const record of records()) {
      expect(record).toEqual({ ...first, expiresAt: T0 + RENEW_MS + LEASE_MS });
    }
    // And again a term of renewals later, still the same take.
    tick(T0 + 2 * RENEW_MS);
    expect(readCasinoOperatorLease()).toEqual({ ...first, expiresAt: T0 + 2 * RENEW_MS + LEASE_MS });
    expect(stops).toEqual([]);
  });
});

// ── Tenure ───────────────────────────────────────────────────────────────────

describe('tenure', () => {
  it.each(ROOM_OPERATOR_KEYS)('ends its take when the record under %s names this page with another take, then takes afresh', (key) => {
    const ready = becomeOperator();
    const mine = readCasinoOperatorLease()!;
    writeKey(key, { ...mine, tenure: 'forged' }); // a peer, naming this page
    expect(ownsCasinoOperatorLease(OPERATOR, ready)).toBe(false);
    expect(stillOperates(currentTake()!.docEpoch, mine.tenure!, ready)).toBe(false);
    expect(tick(ready + 100)).toEqual({ kind: 'lost', foreignHolder: false });
    expect(stops).toEqual(['lost-own']);
    expect(records()).toEqual([null, null, null]); // not renewed over: every record naming this page goes
    expect(currentTake()).toBeNull();
    // A fresh take, with a fresh tenure and its own settling wait.
    expect(tick(ready + 200).kind).toBe('starting');
    const retaken = readCasinoOperatorLease()!;
    expect(retaken.sessionId).toBe(SESSION);
    expect([mine.tenure, 'forged']).not.toContain(retaken.tenure);
    for (const record of records()) expect(record).toEqual(retaken);
    expect(tick(ready + 200 + SETTLE_MS - 1).kind).toBe('starting');
    expect(tick(ready + 200 + SETTLE_MS).kind).toBe('ready');
  });

  it('never counts a record naming this page as another session\'s, forged tenure or not', () => {
    writeKey(SLOT_OPERATOR_KEY, { playerId: OPERATOR, sessionId: SESSION, tenure: 'forged', expiresAt: T0 + LEASE_MS });
    expect(tick(T0, false)).toEqual({ kind: 'idle' });
    expect(casinoLeaseObserved()).toBe(0);
    // Nor is it this page's lease: a take overwrites it, settling wait and all.
    expect(ownsCasinoOperatorLease(OPERATOR, T0)).toBe(false);
    expect(tick(T0 + 16).kind).toBe('starting');
    expect(readSlotOperatorLease()?.tenure).toEqual(TENURE);
    expect(casinoLeaseObserved()).toBe(0);
  });
});

// ── Lapse and takeover ───────────────────────────────────────────────────────

describe('lapse and takeover', () => {
  it("takes another device's lapsed record only after the split window", () => {
    writeKey(CASINO_OPERATOR_KEY, lease(T0 + LEASE_MS));
    expect(tick(T0).kind).toBe('held-elsewhere'); // first seen now; never renewed
    expect(tick(T0 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1).kind).toBe('held-elsewhere');
    expect(readCasinoOperatorLease()?.sessionId).toBe('other-device:tab');
    expect(tick(T0 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS).kind).toBe('starting');
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
  });

  it('gives another device the split window whatever player id its record names', () => {
    writeKey(CASINO_OPERATOR_KEY, lease(T0 + LEASE_MS, 'other-device:tab', 'player-other-install'));
    tick(T0);
    expect(tick(T0 + LEASE_MS + 1).kind).toBe('held-elsewhere');
    expect(readCasinoOperatorLease()?.sessionId).toBe('other-device:tab');
  });

  it("takes a tab on this device's record at its own expiry, never later than a term after it was seen", () => {
    writeKey(CASINO_OPERATOR_KEY, lease(T0 + 5_000, `${DEVICE}:other-tab`));
    tick(T0);
    expect(tick(T0 + 4_999).kind).toBe('held-elsewhere');
    expect(tick(T0 + 5_000).kind).toBe('starting');
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
    leaveCasinoRoom();
    bindCasinoDoc(new Y.Doc());
    // One claiming a far-future expiry holds one term from its sighting.
    writeKey(CASINO_OPERATOR_KEY, lease(Number.MAX_VALUE, `${DEVICE}:rogue-tab`, OTHER));
    tick(T0 + 10_000);
    expect(tick(T0 + 10_000 + LEASE_MS - 1).kind).toBe('held-elsewhere');
    expect(tick(T0 + 10_000 + LEASE_MS).kind).toBe('starting');
  });

  it("judges another device's record by the renewals it sees, never by the expiry it claims", () => {
    // A clock 10 s behind ours: every renewal claims an expiry already past.
    for (let t = T0; t <= T0 + 30_000; t += 1_000) {
      if ((t - T0) % 3_000 === 0) writeKey(CASINO_OPERATOR_KEY, lease(t - 10_000 + LEASE_MS));
      expect(tick(t).kind).toBe('held-elsewhere');
    }
    // No renewal after T0 + 30 s: taken a term and the split window later.
    expect(tick(T0 + 30_000 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1).kind).toBe('held-elsewhere');
    expect(tick(T0 + 30_000 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS).kind).toBe('starting');
    leaveCasinoRoom();
    bindCasinoDoc(new Y.Doc());
    // A far-future expiry holds the room for one term and the split window, not forever.
    const t1 = T0 + 100_000;
    writeKey(CASINO_OPERATOR_KEY, lease(Number.MAX_VALUE));
    tick(t1);
    expect(tick(t1 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1).kind).toBe('held-elsewhere');
    expect(tick(t1 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS).kind).toBe('starting');
  });

  it('reads a retake with a new tenure as a new term, even when it never saw the record go', () => {
    const other = `${DEVICE}:other-tab`;
    writeKey(CASINO_OPERATOR_KEY, { playerId: OPERATOR, sessionId: other, tenure: 'first', expiresAt: T0 + 60_000 });
    tick(T0);
    writeKey(CASINO_OPERATOR_KEY, { playerId: OPERATOR, sessionId: other, tenure: 'second', expiresAt: T0 + 60_000 });
    tick(T0 + 5_000);
    expect(tick(T0 + LEASE_MS).kind).toBe('held-elsewhere'); // the first take's term is over…
    expect(tick(T0 + 5_000 + LEASE_MS).kind).toBe('starting'); // …and now the second's
  });

  it('a record seen in another room\'s doc starts afresh here', () => {
    const rogue = lease(Number.MAX_VALUE, 'rogue:tab', OTHER);
    writeKey(CASINO_OPERATOR_KEY, rogue);
    tick(T0); // first seen here, in this room
    bindCasinoDoc(new Y.Doc());
    writeKey(CASINO_OPERATOR_KEY, rogue);
    expect(tick(T0 + 100_000).kind).toBe('held-elsewhere');
    expect(tick(T0 + 100_000 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1).kind).toBe('held-elsewhere');
    expect(tick(T0 + 100_000 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS).kind).toBe('starting');
  });
});

// ── Per-key hold-off ─────────────────────────────────────────────────────────

describe('per-key hold-off', () => {
  it.each(ROOM_OPERATOR_KEYS)('a live foreign record under %s alone holds the room off, and lapses by the same maths', (key) => {
    writeKey(key, lease(T0 + LEASE_MS));
    expect(tick(T0)).toEqual({ kind: 'held-elsewhere' });
    expect(casinoLeaseObserved()).toBe(1);
    // Nothing is written meanwhile, under any key.
    expect(tick(T0 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1).kind).toBe('held-elsewhere');
    for (const other of ROOM_OPERATOR_KEYS) {
      if (other !== key) expect(readRoomOperatorLease(other)).toBeNull();
    }
    expect(takeCasinoOperatorLease('slots', OPERATOR, T0 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1)).toBe(false);
    // Past the split window the take overwrites the lapsed record: that is the tidy.
    expect(tick(T0 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS).kind).toBe('starting');
    const mine = readCasinoOperatorLease();
    expect(mine?.sessionId).toBe(SESSION);
    for (const record of records()) expect(record).toEqual(mine);
    tick(T0 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS + 16); // its own records aren't watched
    expect(casinoLeaseObserved()).toBe(0);
  });

  it('a v0.38 holder on both old keys counts once and holds until both lapse', () => {
    writeSlotOperatorLease(lease(T0 + LEASE_MS, 'old-slot-device:tab'));
    writeCoinPusherOperatorLease(lease(T0 + LEASE_MS, 'old-pusher-device:tab'));
    tick(T0);
    expect(casinoLeaseObserved()).toBe(1);
    writeSlotOperatorLease(lease(T0 + 3_000 + LEASE_MS, 'old-slot-device:tab')); // only the slot one renews
    tick(T0 + 3_000);
    expect(tick(T0 + 3_000 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1).kind).toBe('held-elsewhere');
    expect(tick(T0 + 3_000 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS).kind).toBe('starting');
  });
});

// ── Lost ─────────────────────────────────────────────────────────────────────

describe('lost', () => {
  it('clears its own lapsed records at once, without taking in that call, and takes afresh on the next', () => {
    becomeOperator();
    // No frames for a while (a background tab): the lease lapses.
    expect(tick(T0 + 20_000)).toEqual({ kind: 'lost', foreignHolder: false });
    expect(records()).toEqual([null, null, null]);
    expect(stops).toEqual(['lost-own']);
    expect(currentTake()).toBeNull();
    expect(tick(T0 + 20_001).kind).toBe('starting');
    expect(readCasinoOperatorLease()).toEqual({
      playerId: OPERATOR, sessionId: SESSION, tenure: TENURE, expiresAt: T0 + 20_001 + LEASE_MS,
    });
    expect(tick(T0 + 20_001 + SETTLE_MS).kind).toBe('ready');
  });

  it("stops once another session's write won a key, deleting only its own records and leaving that session's alone", () => {
    const ready = becomeOperator();
    const theirs = lease(ready + LEASE_MS, 'our-other-device:tab');
    writeKey(SLOT_OPERATOR_KEY, theirs); // a v0.38 peer's take won the merge on its key
    expect(tick(ready + 16)).toEqual({ kind: 'lost', foreignHolder: true });
    expect(stops).toEqual(['lost-foreign']);
    expect(readCasinoOperatorLease()).toBeNull();
    expect(readCoinPusherOperatorLease()).toBeNull();
    expect(readSlotOperatorLease()).toEqual(theirs);
    expect(ownsCasinoOperatorLease(OPERATOR, ready + 16)).toBe(false);
    // And waits on it as on any foreign record.
    expect(tick(ready + 32).kind).toBe('held-elsewhere');
    expect(readSlotOperatorLease()).toEqual(theirs);
  });

  it('a take of another doc is void, without a stop', () => {
    becomeOperator();
    bindCasinoDoc(new Y.Doc());
    expect(currentTake()).toBeNull();
    expect(ownsCasinoOperatorLease(OPERATOR, T0 + SETTLE_MS)).toBe(false);
    expect(tick(T0 + SETTLE_MS + 16, false)).toEqual({ kind: 'idle' });
    expect(records()).toEqual([null, null, null]);
    expect(stops).toEqual([]);
  });
});

// ── Union need ───────────────────────────────────────────────────────────────

describe('union need', () => {
  it('holds the lease while any game needs it, and releases it once none does', () => {
    reportOperatorNeed('slots', true);
    reportOperatorNeed('pusher', false);
    expect(electCasinoOperator(at(T0), true).kind).toBe('starting');
    expect(electCasinoOperator(at(T0 + SETTLE_MS), true).kind).toBe('ready');
    // The pusher's tick reporting no need neither ends nor releases anything.
    reportOperatorNeed('pusher', false);
    expect(electCasinoOperator(at(T0 + SETTLE_MS + 16), true).kind).toBe('ready');
    expect(stops).toEqual([]);
    reportOperatorNeed('slots', false);
    reportOperatorNeed('pusher', true);
    expect(electCasinoOperator(at(T0 + SETTLE_MS + 32), true).kind).toBe('ready');
    reportOperatorNeed('pusher', false);
    expect(electCasinoOperator(at(T0 + SETTLE_MS + 48), true)).toEqual({ kind: 'idle' });
    expect(records()).toEqual([null, null, null]);
    expect(stops).toEqual(['released']);
    expect(currentTake()).toBeNull();
  });

  it('ignores a need reported in another room\'s doc', () => {
    reportOperatorNeed('slots', true);
    bindCasinoDoc(new Y.Doc());
    expect(electCasinoOperator(at(T0), true)).toEqual({ kind: 'idle' });
    expect(records()).toEqual([null, null, null]);
  });
});

// ── The pre-write check ──────────────────────────────────────────────────────

describe('stillOperates', () => {
  it('is true for the current take past its settling wait, and false before it (operatorReady)', () => {
    tick(T0);
    const take = currentTake()!;
    expect(stillOperates(take.docEpoch, take.tenure, T0 + 1)).toBe(true);
    expect(operatorReady(T0 + SETTLE_MS - 1)).toBe(false);
    expect(operatorReady(T0 + SETTLE_MS)).toBe(true);
    expect(stillOperates(take.docEpoch, 'another take', T0 + 1)).toBe(false);
    expect(stillOperates(take.docEpoch + 1, take.tenure, T0 + 1)).toBe(false);
  });

  it('is false after a release', () => {
    const ready = becomeOperator();
    const take = currentTake()!;
    releaseCasinoOperatorLease();
    expect(stillOperates(take.docEpoch, take.tenure, ready)).toBe(false);
    expect(operatorReady(ready)).toBe(false);
    expect(records()).toEqual([null, null, null]);
    expect(stops).toEqual(['released']);
  });

  it('is false once the record is lost, lapsed, or shadowed by a forged take, read afresh', () => {
    const ready = becomeOperator();
    const take = currentTake()!;
    expect(stillOperates(take.docEpoch, take.tenure, ready)).toBe(true);
    expect(stillOperates(take.docEpoch, take.tenure, ready - SETTLE_MS + LEASE_MS)).toBe(false); // lapsed by our clock
    writeKey(COIN_PUSHER_OPERATOR_KEY, { ...readCasinoOperatorLease()!, tenure: 'forged' });
    expect(stillOperates(take.docEpoch, take.tenure, ready)).toBe(false); // a shadow overwritten
    writeKey(COIN_PUSHER_OPERATOR_KEY, readCasinoOperatorLease()!);
    expect(stillOperates(take.docEpoch, take.tenure, ready)).toBe(true);
    writeKey(CASINO_OPERATOR_KEY, lease(ready + LEASE_MS)); // taken over meanwhile
    expect(stillOperates(take.docEpoch, take.tenure, ready)).toBe(false);
  });

  it('is false after a rebind, and once an earlier build\'s lease is renewed, read afresh', () => {
    const ready = becomeOperator();
    const take = currentTake()!;
    doc.getMap('casino').set(legacyKey, legacy(ready + LEASE_MS)); // arrived between two frames
    expect(stillOperates(take.docEpoch, take.tenure, ready)).toBe(false);
    expect(isEarlierBuildOperatingNow(ready)).toBe(true);
    doc.getMap('casino').delete(legacyKey);
    expect(stillOperates(take.docEpoch, take.tenure, ready)).toBe(true);
    bindCasinoDoc(new Y.Doc());
    expect(stillOperates(take.docEpoch, take.tenure, ready)).toBe(false);
  });
});

// ── RUN ──────────────────────────────────────────────────────────────────────

describe('takeCasinoOperatorLease (RUN)', () => {
  it('takes the room at once, records the game\'s need, and is a no-op while the lease is held', () => {
    expect(takeCasinoOperatorLease('slots', OPERATOR, at(T0))).toBe(true);
    const first = readCasinoOperatorLease();
    expect(first).toEqual({ playerId: OPERATOR, sessionId: SESSION, tenure: TENURE, expiresAt: T0 + LEASE_MS });
    for (const record of records()) expect(record).toEqual(first);
    expect(ownsCasinoOperatorLease(OPERATOR, T0)).toBe(true);
    // The need recorded at the click keeps the next election from releasing it.
    expect(electCasinoOperator(at(T0 + 16), true).kind).toBe('starting');
    expect(electCasinoOperator(at(T0 + SETTLE_MS), true).kind).toBe('ready');
    expect(takeCasinoOperatorLease('slots', OPERATOR, at(T0 + SETTLE_MS + 1))).toBe(true);
    expect(readCasinoOperatorLease()).toEqual(first); // the same take
    expect(stops).toEqual([]);
  });

  it('refuses while leaving, while an earlier build operates, or while any key is held elsewhere', () => {
    doc.getMap('casino').set(legacyKey, legacy(T0 + LEASE_MS));
    expect(takeCasinoOperatorLease('slots', OPERATOR, at(T0))).toBe(false);
    doc.getMap('casino').delete(legacyKey);
    for (const key of ROOM_OPERATOR_KEYS) {
      writeKey(key, lease(T0 + LEASE_MS, `other-device:${key}`));
      expect(takeCasinoOperatorLease('slots', OPERATOR, at(T0))).toBe(false);
      expect(readRoomOperatorLease(key)?.sessionId).toBe(`other-device:${key}`);
      doc.getMap('casino').delete(key);
    }
    leaveCasinoRoom();
    expect(takeCasinoOperatorLease('slots', OPERATOR, at(T0 + 16))).toBe(false);
    expect(records()).toEqual([null, null, null]);
  });

  it('takes the lease afresh when the record naming this page carries another take, ending the old one', () => {
    expect(takeCasinoOperatorLease('slots', OPERATOR, at(T0))).toBe(true);
    const first = readCasinoOperatorLease()!;
    writeKey(CASINO_OPERATOR_KEY, { ...first, tenure: 'forged' });
    expect(ownsCasinoOperatorLease(OPERATOR, T0)).toBe(false);
    expect(takeCasinoOperatorLease('slots', OPERATOR, at(T0 + 10))).toBe(true);
    const retaken = readCasinoOperatorLease()!;
    expect([first.tenure, 'forged']).not.toContain(retaken.tenure);
    expect(retaken.expiresAt).toBe(T0 + 10 + LEASE_MS);
    for (const record of records()) expect(record).toEqual(retaken);
    expect(stops).toEqual(['lost-own']);
    expect(currentTake()?.readyAt).toBe(T0 + 10 + SETTLE_MS);
  });
});

// ── Earlier builds ───────────────────────────────────────────────────────────

describe("earlier builds' per-machine leases", () => {
  it('hold the whole room off while one is renewed, and end a held take', () => {
    becomeOperator();
    const map = doc.getMap('casino');
    for (let t = T0 + SETTLE_MS; t <= T0 + 20_000; t += 1_000) {
      if ((t - T0) % 3_000 === 0) map.set(legacyKey, legacy(t + LEASE_MS));
      if (t === T0 + SETTLE_MS) {
        expect(tick(t).kind).toBe('ready'); // not there yet
        continue;
      }
      expect(tick(t)).toEqual({ kind: 'legacy-build' });
    }
    expect(stops).toEqual(['legacy']);
    expect(records()).toEqual([null, null, null]);
    expect(earlierBuildLeasesWatched()).toBe(1);
    expect(takeCasinoOperatorLease('slots', OPERATOR, T0 + 20_000)).toBe(false);
  });

  it('once lapsed, are deleted by a session that may tidy, which then takes the room', () => {
    doc.getMap('casino').set(legacyKey, legacy(T0 + LEASE_MS));
    expect(tick(T0)).toEqual({ kind: 'legacy-build' });
    expect(records()).toEqual([null, null, null]);
    expect(tick(T0 + LEASE_MS).kind).toBe('starting');
    expect(doc.getMap('casino').has(legacyKey)).toBe(false);
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
    expect(stops).toEqual([]);
  });

  it('are never deleted by a session that may not tidy, though a lapsed one no longer holds it off', () => {
    doc.getMap('casino').set(legacyKey, legacy(T0 + LEASE_MS));
    expect(tick(T0, true, false)).toEqual({ kind: 'legacy-build' });
    expect(tick(T0 + LEASE_MS - 1, true, false)).toEqual({ kind: 'legacy-build' });
    expect(tick(T0 + LEASE_MS, true, false).kind).toBe('starting');
    expect(doc.getMap('casino').has(legacyKey)).toBe(true);
    expect(isEarlierBuildOperatingNow(T0 + LEASE_MS)).toBe(false);
    tick(T0 + LEASE_MS + 16, true, true);
    expect(doc.getMap('casino').has(legacyKey)).toBe(false);
  });

  it('past the read cap, hold the room off, and are tidied a batch a term until the rest fit', () => {
    const map = doc.getMap('casino');
    const key = (i: number): string => `slot-operator:flood-${i}`;
    for (let i = 0; i < LEGACY_SLOT_LEASE_READ_CAP + 1; i++) map.set(key(i), legacy(T0 + LEASE_MS));
    expect(readLegacySlotOperatorMachineIds().more).toBe(true);
    expect(tick(T0)).toEqual({ kind: 'legacy-build' });
    // The unread one may be live: nothing is taken once the read batch lapses.
    expect(tick(T0 + LEASE_MS)).toEqual({ kind: 'legacy-build' });
    expect(map.has(key(0))).toBe(false); // the batch it read, lapsed, is deleted
    expect(readLegacySlotOperatorMachineIds()).toEqual({ machineIds: [key(LEGACY_SLOT_LEASE_READ_CAP).slice('slot-operator:'.length)], more: false });
    // The rest, first seen on the next frame, get a term of their own.
    expect(tick(T0 + LEASE_MS + 1)).toEqual({ kind: 'legacy-build' });
    expect(tick(T0 + 2 * LEASE_MS + 1).kind).toBe('starting');
    expect(readLegacySlotOperatorMachineIds()).toEqual({ machineIds: [], more: false });
  });

  it('are watched by machine, forgotten when their record goes or the machine is closed here', () => {
    const map = doc.getMap('casino');
    map.set(legacyKey, legacy(T0 + LEASE_MS));
    map.set('slot-operator:slot-machine-2', legacy(T0 + LEASE_MS));
    tick(T0);
    expect(earlierBuildLeasesWatched()).toBe(2);
    map.delete(legacyKey); // an earlier build letting it go
    tick(T0 + 100);
    expect(earlierBuildLeasesWatched()).toBe(1);
    forgetEarlierBuildLease('slot-machine-2');
    expect(earlierBuildLeasesWatched()).toBe(0);
    // Still in the doc, so still live: seen afresh on the next tick, a term from then.
    expect(tick(T0 + 200)).toEqual({ kind: 'legacy-build' });
    expect(earlierBuildLeasesWatched()).toBe(1);
  });
});

// ── Leaving ──────────────────────────────────────────────────────────────────

describe('leaving the room', () => {
  it('releases the records, forgets everything watched, tells every game, and takes nothing back until another doc is bound', () => {
    const ready = becomeOperator();
    writeKey(SLOT_OPERATOR_KEY, lease(ready + LEASE_MS)); // a v0.38 peer won the slot key
    tick(ready + 16); // lost to it; its record is watched
    doc.getMap('casino').set(legacyKey, legacy(ready + LEASE_MS));
    tick(ready + 32);
    expect(casinoLeaseObserved()).toBe(1);
    expect(earlierBuildLeasesWatched()).toBe(1);
    expect(tick(ready + 48)).toEqual({ kind: 'legacy-build' });
    stops = [];
    leaveCasinoRoom();
    expect(isLeavingCasinoRoom()).toBe(true);
    expect(stops).toEqual(['leaving']);
    expect(leaves).toBe(1);
    expect(casinoLeaseObserved()).toBe(0);
    expect(earlierBuildLeasesWatched()).toBe(0);
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab'); // theirs, left alone
    // Frames go on while the release is flushed: nothing is taken or watched.
    doc.getMap('casino').delete(SLOT_OPERATOR_KEY);
    doc.getMap('casino').delete(legacyKey);
    for (const t of [ready + 100, ready + 3_000, ready + 90_000]) expect(tick(t)).toEqual({ kind: 'leaving' });
    expect(records()).toEqual([null, null, null]);
    expect(takeCasinoOperatorLease('slots', OPERATOR, ready + 100)).toBe(false);
    writeKey(CASINO_OPERATOR_KEY, lease(ready + 100_000));
    expect(casinoOperatorState(ready + 100)).toBe('offline');
    expect(coinPusherOperatorState(ready + 100)).toBe('offline');
    expect(casinoLeaseObserved()).toBe(0);
    // Leaving again finds nothing held and is harmless.
    leaveCasinoRoom();
    expect(leaves).toBe(2);
    // The next room's doc lifts it.
    bindCasinoDoc(new Y.Doc());
    expect(isLeavingCasinoRoom()).toBe(false);
    expect(tick(ready + 200_000).kind).toBe('starting');
    expect(readCasinoOperatorLease()?.sessionId).toBe(SESSION);
  });

  it('releasing leaves another session\'s records alone, and always tells the games', () => {
    writeKey(SLOT_OPERATOR_KEY, lease(T0 + LEASE_MS));
    becomeOperator(); // held off, in fact: nothing is taken
    expect(readCasinoOperatorLease()).toBeNull();
    releaseCasinoOperatorLease();
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab');
    expect(stops).toEqual(['released']); // the slot side forgets its manual machines on every release
  });
});

// ── Doc epochs ───────────────────────────────────────────────────────────────

describe('doc epochs', () => {
  it('a take and a need belong to the doc they were made in', () => {
    const ready = becomeOperator();
    const a = doc;
    const b = new Y.Doc();
    bindCasinoDoc(b);
    expect(currentTake()).toBeNull();
    expect(electCasinoOperator(at(ready + 16), true)).toEqual({ kind: 'idle' }); // the need was doc A's
    expect(casinoLeaseObserved()).toBe(0);
    for (const key of ROOM_OPERATOR_KEYS) expect(b.getMap('casino').has(key)).toBe(false);
    expect(a.getMap('casino').has(CASINO_OPERATOR_KEY)).toBe(true); // nothing written back to A
    expect(stops).toEqual([]);
    // A foreign record seen in A doesn't count here either.
    bindCasinoDoc(a);
    writeKey(CASINO_OPERATOR_KEY, lease(ready + LEASE_MS));
    tick(ready + 32);
    expect(casinoLeaseObserved()).toBe(1);
    bindCasinoDoc(b);
    expect(casinoLeaseObserved()).toBe(0);
  });
});

// ── Panel states ─────────────────────────────────────────────────────────────

describe('operator states', () => {
  it('show this page\'s own take starting until its settling wait is over, and a record it isn\'t operating under as offline', () => {
    writeCasinoOperatorRecords({ playerId: OPERATOR, sessionId: SESSION, expiresAt: T0 + LEASE_MS }, ROOM_OPERATOR_KEYS);
    expect(casinoOperatorState(T0)).toBe('offline');
    expect(coinPusherOperatorState(T0)).toBe('offline');
    tick(T0);
    expect(casinoOperatorState(T0 + SETTLE_MS - 1)).toBe('starting');
    expect(coinPusherOperatorState(T0 + SETTLE_MS - 1)).toBe('starting');
    expect(casinoOperatorState(T0 + SETTLE_MS)).toBe('ready');
    expect(coinPusherOperatorState(T0 + SETTLE_MS)).toBe('ready');
    // Its own record is judged by its own clock…
    expect(casinoOperatorState(T0 + LEASE_MS - 1)).toBe('ready');
    expect(casinoOperatorState(T0 + LEASE_MS)).toBe('offline');
    // …and by its tenure: a record naming this page with another take is nobody's.
    writeKey(COIN_PUSHER_OPERATOR_KEY, { ...readCasinoOperatorLease()!, tenure: 'forged' });
    expect(coinPusherOperatorState(T0 + SETTLE_MS)).toBe('offline');
    expect(casinoOperatorState(T0 + SETTLE_MS)).toBe('ready');
  });

  it('tell a player a v0.38 pusher operator is starting up until its settling wait is over (today\'s timeline)', () => {
    const write = (t: number, sessionId = 'their-device:tab') =>
      writeCoinPusherOperatorLease({ playerId: OTHER, sessionId, expiresAt: t + LEASE_MS });
    write(T0);
    tick(T0, false); // a player at the cabinet: first seen held now
    expect(coinPusherOperatorState(T0 + SETTLE_MS - 1)).toBe('starting');
    expect(coinPusherOperatorState(T0 + SETTLE_MS)).toBe('ready');
    expect(casinoOperatorState(T0 + SETTLE_MS)).toBe('offline'); // a v0.38 holder writes no primary
    // A renewal is the same holder: still ready.
    write(T0 + 3_000);
    tick(T0 + 3_000, false);
    expect(coinPusherOperatorState(T0 + 3_001)).toBe('ready');
    // Another session taking over starts its own wait.
    write(T0 + 4_000, 'their-other-device:tab');
    tick(T0 + 4_000, false);
    expect(coinPusherOperatorState(T0 + 5_999)).toBe('starting');
    expect(coinPusherOperatorState(T0 + 6_000)).toBe('ready');
    // So does the same session taking it again after letting it go.
    doc.getMap('casino').delete(COIN_PUSHER_OPERATOR_KEY);
    tick(T0 + 7_000, false);
    expect(coinPusherOperatorState(T0 + 7_000)).toBe('offline');
    write(T0 + 7_500, 'their-other-device:tab');
    tick(T0 + 7_500, false);
    expect(coinPusherOperatorState(T0 + 9_499)).toBe('starting');
    expect(coinPusherOperatorState(T0 + 9_500)).toBe('ready');
    // A lapse shows without a frame: the panel polls, and no key changed.
    expect(coinPusherOperatorState(T0 + 7_500 + LEASE_MS - 1)).toBe('ready');
    expect(coinPusherOperatorState(T0 + 7_500 + LEASE_MS)).toBe('offline');
  });

  it('read a new build\'s holder from any of its keys, a new tenure as a new take, and feed the shared memo', () => {
    const write = (t: number, tenure: string) =>
      writeCasinoOperatorRecords({ playerId: OTHER, sessionId: 'their-device:tab', tenure, expiresAt: t + LEASE_MS }, ROOM_OPERATOR_KEYS);
    write(T0, 'first');
    // No frame yet: the panel's poll is the first sighting of the key it reads.
    expect(casinoOperatorState(T0)).toBe('starting');
    expect(casinoLeaseObserved()).toBe(1);
    tick(T0, false); // a frame: every key seen held now
    expect(casinoOperatorState(T0 + SETTLE_MS)).toBe('ready');
    expect(coinPusherOperatorState(T0 + SETTLE_MS)).toBe('ready');
    write(T0 + 3_000, 'first'); // a renewal
    tick(T0 + 3_000, false);
    expect(coinPusherOperatorState(T0 + 3_001)).toBe('ready');
    write(T0 + 4_000, 'second'); // let go and taken again between two frames
    tick(T0 + 4_000, false);
    expect(coinPusherOperatorState(T0 + 5_999)).toBe('starting');
    expect(coinPusherOperatorState(T0 + 6_000)).toBe('ready');
    expect(casinoLeaseObserved()).toBe(1);
  });
});

// ── Watch count ──────────────────────────────────────────────────────────────

describe('casinoLeaseObserved', () => {
  it('counts a foreign holder once, on three keys or on one, and this page\'s own records never', () => {
    expect(casinoLeaseObserved()).toBe(0);
    writeCasinoOperatorRecords(lease(T0 + LEASE_MS), ROOM_OPERATOR_KEYS);
    tick(T0, false);
    expect(casinoLeaseObserved()).toBe(1);
    for (const key of ROOM_OPERATOR_KEYS) doc.getMap('casino').delete(key);
    tick(T0 + 16, false);
    expect(casinoLeaseObserved()).toBe(0);
    writeSlotOperatorLease(lease(T0 + LEASE_MS, 'old-build-device:tab'));
    tick(T0 + 32, false);
    expect(casinoLeaseObserved()).toBe(1);
    doc.getMap('casino').delete(SLOT_OPERATOR_KEY);
    becomeOperator(T0 + 48);
    expect(casinoLeaseObserved()).toBe(0);
  });
});

// ── The fee lane's interface ─────────────────────────────────────────────────

describe('a game with only a need', () => {
  it('takes and holds the room on its need alone, and checks before every write with stillOperates', () => {
    let held = 0;
    for (let t = T0; t <= T0 + 10_000; t += 500) {
      const outcome = tick(t);
      if (outcome.kind !== 'ready') continue;
      expect(stillOperates(outcome.docEpoch, outcome.tenure, t)).toBe(true);
      held += 1;
    }
    expect(held).toBe(17); // every frame from T0 + 2 s on
    expect(readCasinoOperatorLease()?.expiresAt).toBe(T0 + 9_000 + LEASE_MS);
    expect(stops).toEqual([]);
  });
});
