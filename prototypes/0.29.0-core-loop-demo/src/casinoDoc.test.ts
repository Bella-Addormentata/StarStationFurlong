/**
 * 🪙 casinoDoc coin-pusher record tests (issue #135).
 *
 * The pusher's money side lives in casinoDoc: a player's request carries no
 * chips, and only the operator's settle / refuse / empty / teardown helpers
 * move them — each in ONE transaction, each re-checking the stored machine
 * first. These specs pin that no peer-written record is ever taken as proof
 * that chips moved (the PR #137 review), that a credit is always read off the
 * machine's own transition, and — with two docs — that a settle racing the
 * player's cancel converges to one drop paid once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  bindCasinoDoc,
  buyInChips,
  cancelCoinPusherRequest,
  commitCoinPusherEmpty,
  continueCoinPusherKeySweep,
  drainAndClearCoinPusher,
  PUSHER_REQUEST_SCAN,
  PUSHER_SWEEP_BATCH,
  readChips,
  readCoinPusherDoorResult,
  readCoinPusherEmptyRequest,
  readCoinPusherOperatorLease,
  readCoinPusherRequest,
  readCoinPusherRequests,
  readCoinPusherResult,
  readCoinPusherState,
  refuseCoinPusherEmpty,
  refuseCoinPusherInsert,
  settleCoinPusherInsert,
  startCoinPusherKeySweep,
  writeCoinPusherEmptyRequest,
  writeCoinPusherOperatorLease,
  writeCoinPusherRequest,
  writeCoinPusherState,
} from './casinoDoc';
import {
  chipsInMachine,
  emptyMachine,
  initialCoinPusherState,
  processInsert,
  type CoinPusherState,
  type PusherHole,
  type PusherInsertRequest,
} from './games/coinPusher';

const OWNER = 'owner-Alice';
const PLAYER = 'player-Bob';
const OTHER = 'player-Carol';
const ATTACKER = 'attacker-Mallory';
const MACHINE = 'pusher-1';

let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  bindCasinoDoc(doc);
});

function request(
  player: string,
  requestId: string,
  hole: PusherHole = 1,
  phase = 0.5,
): PusherInsertRequest {
  return { requestId, player, hole, phase, requestedAt: 1_000 };
}

/** The operator's drop exactly as pusherCroupier builds it. */
function dropFor(base: CoinPusherState, req: PusherInsertRequest, seed = 42): CoinPusherState {
  const drop = processInsert(base, req.player, req.hole, req.phase, seed);
  return {
    ...drop.state,
    lastDrop: {
      requestId: req.requestId, player: req.player, hole: req.hole, chipId: drop.chipId,
      landedX: drop.landedX, paid: drop.paid, phase: req.phase, honored: true, atMs: 2_000,
    },
  };
}

/** A machine that has taken `n` drops from OTHER (full enough to pay out). */
function machineWith(n: number, owner = OWNER): CoinPusherState {
  let s = initialCoinPusherState(owner, 0);
  for (let i = 0; i < n; i++) {
    s = processInsert(s, OTHER, (i % 3) as PusherHole, (i * 0.37) % 1, i * 7919).state;
  }
  return s;
}

/** A published machine plus a pending request whose drop pays out. */
function payingSetup(): { base: CoinPusherState; req: PusherInsertRequest; next: CoinPusherState } {
  const base = machineWith(60);
  for (let seed = 0; seed < 500; seed++) {
    const req = request(PLAYER, `req-${seed}`);
    const next = dropFor(base, req, seed);
    if (next.lastDrop!.paid > 0) {
      writeCoinPusherState(MACHINE, base);
      writeCoinPusherRequest(MACHINE, req);
      return { base: readCoinPusherState(MACHINE)!, req, next };
    }
  }
  throw new Error('no paying drop in the seed sweep');
}

function countTransactions(d: Y.Doc): () => number {
  let n = 0;
  d.on('afterTransaction', () => { n += 1; });
  return () => n;
}

/** Sweep a drained machine's per-player keys to the end (the operator does it
 *  a batch per frame); returns how many batches it took. */
function sweepAll(machineId: string): number {
  const sweep = startCoinPusherKeySweep(machineId);
  let batches = 1;
  while (!continueCoinPusherKeySweep(sweep)) batches += 1;
  return batches;
}

/** Run `work` asserting it never walks a Y.Map; returns what it returned. */
function withoutWalking<T>(work: () => T): T {
  const walks = (['keys', 'entries', 'values', 'forEach'] as const)
    .map((method) => vi.spyOn(Y.Map.prototype, method));
  try {
    const out = work();
    for (const walk of walks) expect(walk).not.toHaveBeenCalled();
    return out;
  } finally {
    for (const walk of walks) walk.mockRestore();
  }
}

// ── Requests: a wish, not a payment ──────────────────────────────────────────

describe('coin-pusher requests', () => {
  it('writing a request moves no chips', () => {
    buyInChips(PLAYER, 5);
    const req = request(PLAYER, 'req-1');
    expect(writeCoinPusherRequest(MACHINE, req)).toBe(true);
    expect(readChips(PLAYER)).toBe(5);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toEqual(req);
  });

  it('one pending request per player; junk under the key does not lock them out', () => {
    expect(writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'))).toBe(true);
    expect(writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-2'))).toBe(false);
    expect(readCoinPusherRequest(MACHINE, PLAYER)?.requestId).toBe('req-1');
    doc.getMap('casino').set(`pusher-req:${MACHINE}:${OTHER}`, { junk: true });
    expect(writeCoinPusherRequest(MACHINE, request(OTHER, 'req-3'))).toBe(true);
  });

  it('rejects a malformed request', () => {
    expect(writeCoinPusherRequest(MACHINE, { ...request(PLAYER, 'r'), phase: 1 })).toBe(false);
    expect(writeCoinPusherRequest(MACHINE, { ...request(PLAYER, 'r'), hole: 5 as PusherHole })).toBe(false);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
  });

  it('a cancel withdraws only the same request', () => {
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'));
    expect(cancelCoinPusherRequest(MACHINE, PLAYER, 'req-0')).toBe(false);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).not.toBeNull();
    expect(cancelCoinPusherRequest(MACHINE, PLAYER, 'req-1')).toBe(true);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
  });

  it('lists requests oldest first and ignores one filed under another player\'s key', () => {
    writeCoinPusherRequest(MACHINE, request(OTHER, 'b-2'));
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'a-1'));
    doc.getMap('casino').set(`pusher-req:${MACHINE}:${ATTACKER}`, request(PLAYER, 'a-0'));
    expect(readCoinPusherRequests(MACHINE).map((r) => r.requestId)).toEqual(['a-1', 'b-2']);
  });

  it('a bounded read keeps only the oldest, whatever order they were written in', () => {
    const ids = ['m-5', 'm-2', 'm-9', 'm-1', 'm-7', 'm-3'];
    ids.forEach((id, i) => writeCoinPusherRequest(MACHINE, request(`p${i}`, id)));
    expect(readCoinPusherRequests(MACHINE, 3).map((r) => r.requestId)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(readCoinPusherRequests(MACHINE, 1).map((r) => r.requestId)).toEqual(['m-1']);
    expect(readCoinPusherRequests(MACHINE).map((r) => r.requestId)).toEqual(
      ['m-1', 'm-2', 'm-3', 'm-5', 'm-7', 'm-9'],
    );
  });

  it('reads a machine\'s requests from its index, never by walking the casino map — not even the first time', () => {
    const map = doc.getMap('casino');
    for (let i = 0; i < 2_000; i++) map.set(`noise:${i}`, i);
    for (let i = 0; i < 2_000; i++) {
      map.set(`pusher-req:another-machine:p${i}`, request(`p${i}`, `x-${i}`));
    }
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'a-1'));
    writeCoinPusherRequest(MACHINE, request(OTHER, 'b-2'));
    expect(withoutWalking(() => readCoinPusherRequests(MACHINE).map((r) => r.requestId)))
      .toEqual(['a-1', 'b-2']);
  });

  it('a doc that already holds requests is indexed when it is bound, never by a read', () => {
    const loaded = new Y.Doc();
    const map = loaded.getMap('casino');
    for (let i = 0; i < 2_000; i++) map.set(`noise:${i}`, i);
    map.set(`pusher-req:${MACHINE}:${PLAYER}`, request(PLAYER, 'a-1'));
    map.set(`pusher-req:${MACHINE}:${ATTACKER}`, request(PLAYER, 'filed-under-someone-else'));
    bindCasinoDoc(loaded);
    expect(withoutWalking(() => readCoinPusherRequests(MACHINE).map((r) => r.requestId)))
      .toEqual(['a-1']);
  });

  it('files a request by its own player, so a colon in an id never files it under another machine', () => {
    const map = doc.getMap('casino');
    // One key, two readings: machine 'a' with player 'b:p', or machine 'a:b'
    // with player 'p'. The request's player decides which.
    map.set('pusher-req:a:b:p', request('p', 'for-a:b'));
    expect(readCoinPusherRequests('a:b').map((r) => r.requestId)).toEqual(['for-a:b']);
    expect(readCoinPusherRequests('a')).toEqual([]);
    map.set('pusher-req:a:b:p', request('b:p', 'for-a'));
    expect(readCoinPusherRequests('a').map((r) => r.requestId)).toEqual(['for-a']);
    expect(readCoinPusherRequests('a:b')).toEqual([]);
  });

  it('keeps the index current as requests come, change and go — from this peer or another', () => {
    const map = doc.getMap('casino');
    const ids = () => readCoinPusherRequests(MACHINE).map((r) => r.requestId);
    expect(ids()).toEqual([]);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'a-1'));
    expect(ids()).toEqual(['a-1']);
    map.set(`pusher-req:${MACHINE}:${PLAYER}`, { junk: true });
    expect(ids()).toEqual([]);
    map.set(`pusher-req:${MACHINE}:${PLAYER}`, request(PLAYER, 'a-2'));
    expect(ids()).toEqual(['a-2']);
    cancelCoinPusherRequest(MACHINE, PLAYER, 'a-2');
    expect(ids()).toEqual([]);
    // A request written on another peer arrives as a remote update.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getMap('casino').set(`pusher-req:${MACHINE}:${OTHER}`, request(OTHER, 'b-1'));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    expect(ids()).toEqual(['b-1']);
    // Each bound doc has its own index.
    bindCasinoDoc(new Y.Doc());
    expect(ids()).toEqual([]);
    bindCasinoDoc(doc);
    expect(ids()).toEqual(['b-1']);
  });

  it('works through a flood PUSHER_REQUEST_SCAN at a time, in arrival order, reaching every request once', () => {
    const id = (i: number) => `r-${String(i).padStart(4, '0')}`;
    const total = 3 * PUSHER_REQUEST_SCAN + 5;
    // Written newest first, so arrival order and age disagree.
    for (let i = total - 1; i >= 0; i--) writeCoinPusherRequest(MACHINE, request(`p${i}`, id(i)));
    const gets = vi.spyOn(Y.Map.prototype, 'get');
    let first: string[];
    try {
      first = readCoinPusherRequests(MACHINE, 4).map((r) => r.requestId);
      expect(gets.mock.calls.length).toBeLessThanOrEqual(PUSHER_REQUEST_SCAN);
    } finally {
      gets.mockRestore();
    }
    // The oldest of the first PUSHER_REQUEST_SCAN to arrive.
    expect(first).toEqual([0, 1, 2, 3].map((k) => id(total - PUSHER_REQUEST_SCAN + k)));
    // Answering four a pass (the operator's batch) reaches each exactly once.
    const answered = new Set<string>();
    let passes = 0;
    for (let batch = readCoinPusherRequests(MACHINE, 4); batch.length > 0 && passes <= total;
      batch = readCoinPusherRequests(MACHINE, 4)) {
      passes += 1;
      for (const r of batch) {
        expect(answered.has(r.requestId)).toBe(false);
        answered.add(r.requestId);
        cancelCoinPusherRequest(MACHINE, r.player, r.requestId);
      }
    }
    expect(answered.size).toBe(total);
    expect(passes).toBe(Math.ceil(total / 4));
  });
});

// ── settleCoinPusherInsert: the only way a drop moves chips ──────────────────

describe('settleCoinPusherInsert', () => {
  it('debits one chip, credits exactly the drop\'s payout, publishes and clears — in one transaction', () => {
    const { base, req, next } = payingSetup();
    buyInChips(PLAYER, 3);
    const transactions = countTransactions(doc);
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('ok');
    expect(transactions()).toBe(1);
    const paid = next.lastDrop!.paid;
    expect(paid).toBeGreaterThan(0);
    expect(readChips(PLAYER)).toBe(3 - 1 + paid);
    expect(readCoinPusherState(MACHINE)).toEqual(next);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
    expect(readCoinPusherResult(MACHINE, PLAYER)).toEqual({
      kind: 'drop', requestId: req.requestId, paid, honored: true, atMs: 2_000,
    });
  });

  it('a player\'s answer survives the next player\'s drop (lastDrop does not)', () => {
    const { base, req, next } = payingSetup();
    buyInChips(PLAYER, 3);
    buyInChips(OTHER, 3);
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('ok');
    // OTHER drops right after; the machine's lastDrop is now theirs.
    const other = request(OTHER, 'zz-other');
    writeCoinPusherRequest(MACHINE, other);
    const stored = readCoinPusherState(MACHINE)!;
    expect(settleCoinPusherInsert(MACHINE, stored, dropFor(stored, other, 7), other)).toBe('ok');
    expect(readCoinPusherState(MACHINE)!.lastDrop!.requestId).toBe('zz-other');
    // PLAYER's panel, catching up late, still finds its own answer.
    expect(readCoinPusherResult(MACHINE, PLAYER)?.requestId).toBe(req.requestId);
  });

  it('a request from a player with no chip gets nothing — and nothing is written', () => {
    const { base, req, next } = payingSetup(); // PLAYER never bought in
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('no-chips');
    expect(readChips(PLAYER)).toBe(0);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toEqual(req);
  });

  it('refuses a stale base: a second settle of the same drop pays nothing', () => {
    const { base, req, next } = payingSetup();
    buyInChips(PLAYER, 3);
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('ok');
    const after = readChips(PLAYER);
    writeCoinPusherRequest(MACHINE, req); // even with the request back
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('stale-state');
    expect(readChips(PLAYER)).toBe(after);
  });

  it('refuses when the request was withdrawn or replaced', () => {
    const { base, req, next } = payingSetup();
    buyInChips(PLAYER, 3);
    cancelCoinPusherRequest(MACHINE, PLAYER, req.requestId);
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('stale-request');
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'someone-else'));
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('stale-request');
    expect(readChips(PLAYER)).toBe(3);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
  });

  it('reads the credit off the machine\'s transition — a payout that did not leave the machine is invalid', () => {
    const { base, req, next } = payingSetup();
    buyInChips(PLAYER, 3);
    const d = next.lastDrop!;
    // A chip lifted out of the machine and counted as paid — the machine still
    // balances, but this drop's record does not say it paid that chip.
    const lifted = structuredClone(next);
    const pile = [...lifted.upper, ...lifted.lower].find((p) => p.count > 0)!;
    pile.chipIds.pop();
    pile.count -= 1;
    lifted.totalPaid += 1;
    const forged: CoinPusherState[] = [
      lifted,
      // Counter inflated alone: does not balance.
      { ...next, totalPaid: next.totalPaid + 50 },
      // Counter AND the drop's paid inflated: still does not balance.
      { ...next, totalPaid: next.totalPaid + 50, lastDrop: { ...d, paid: d.paid + 50 } },
      // A drop record for someone else's request.
      { ...next, lastDrop: { ...d, requestId: 'other-request' } },
      { ...next, lastDrop: { ...d, player: ATTACKER } },
      // Two chips in, owner moved, emptied counter touched.
      { ...next, totalInserted: next.totalInserted + 1 },
      { ...next, ownerId: ATTACKER },
      { ...next, totalEmptied: next.totalEmptied + 1 },
    ];
    for (const bad of forged) {
      expect(settleCoinPusherInsert(MACHINE, base, bad, req)).toBe('invalid');
    }
    const { lastDrop: _dropped, ...noDrop } = next;
    expect(settleCoinPusherInsert(MACHINE, base, noDrop, req)).toBe('invalid');
    expect(readChips(PLAYER)).toBe(3);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
  });
});

// ── refuseCoinPusherInsert ───────────────────────────────────────────────────

describe('refuseCoinPusherInsert', () => {
  it('answers the player with why, clears the request, and leaves the machine and chips alone', () => {
    const base = machineWith(10);
    writeCoinPusherState(MACHINE, base);
    buyInChips(PLAYER, 2);
    const req = request(PLAYER, 'req-1');
    writeCoinPusherRequest(MACHINE, req);
    const transactions = countTransactions(doc);
    expect(refuseCoinPusherInsert(MACHINE, req, 'machine-full', 9)).toBe(true);
    expect(transactions()).toBe(1);
    expect(readCoinPusherResult(MACHINE, PLAYER)).toEqual({
      kind: 'refused', requestId: 'req-1', reason: 'machine-full', atMs: 9,
    });
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readChips(PLAYER)).toBe(2);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
  });

  it('writes nothing once the request is gone or replaced', () => {
    const req = request(PLAYER, 'req-1');
    expect(refuseCoinPusherInsert(MACHINE, req, 'no-chips', 9)).toBe(false);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-2'));
    expect(refuseCoinPusherInsert(MACHINE, req, 'no-chips', 9)).toBe(false);
    expect(readCoinPusherResult(MACHINE, PLAYER)).toBeNull();
    expect(readCoinPusherRequest(MACHINE, PLAYER)?.requestId).toBe('req-2');
  });
});

// ── commitCoinPusherEmpty ────────────────────────────────────────────────────

describe('commitCoinPusherEmpty', () => {
  const door = (requester: string) => ({ requestId: 'door-1', requester, requestedAt: 5 });

  it('credits the owner exactly the chips inside, empties the machine, answers and clears the door — in one transaction', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, door(OWNER));
    buyInChips(OWNER, 7);
    const inside = chipsInMachine(base);
    const transactions = countTransactions(doc);
    const emptied = emptyMachine(base, OWNER).state;
    expect(commitCoinPusherEmpty(MACHINE, readCoinPusherState(MACHINE)!, emptied, door(OWNER), OWNER, 11)).toBe(inside);
    expect(transactions()).toBe(1);
    expect(readChips(OWNER)).toBe(7 + inside);
    expect(chipsInMachine(readCoinPusherState(MACHINE)!)).toBe(0);
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
    expect(readCoinPusherDoorResult(MACHINE)).toEqual({
      kind: 'opened', requestId: 'door-1', emptied: inside, atMs: 11,
    });
  });

  it('refuses a door request from anyone but the owner', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, door(ATTACKER));
    const emptied = { ...emptyMachine(base, OWNER).state };
    expect(commitCoinPusherEmpty(MACHINE, base, emptied, door(ATTACKER), OWNER, 11)).toBeNull();
    expect(commitCoinPusherEmpty(MACHINE, base, emptied, door(ATTACKER), ATTACKER, 11)).toBeNull();
    expect(readChips(ATTACKER)).toBe(0);
    expect(readChips(OWNER)).toBe(0);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readCoinPusherDoorResult(MACHINE)).toBeNull();
  });

  it('pays only an operator who owns the machine — a machine naming someone else pays nobody', () => {
    // A peer-written machine that names the attacker as owner, with the
    // attacker's own door request: the operator (OWNER) is not its owner.
    const forged = machineWith(40, ATTACKER);
    writeCoinPusherState(MACHINE, forged);
    writeCoinPusherEmptyRequest(MACHINE, door(ATTACKER));
    const emptied = emptyMachine(forged, ATTACKER).state;
    expect(commitCoinPusherEmpty(MACHINE, forged, emptied, door(ATTACKER), OWNER, 11)).toBeNull();
    expect(readChips(ATTACKER)).toBe(0);
  });

  it('refuses a next that is not the empty of the stored machine', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, door(OWNER));
    const emptied = emptyMachine(base, OWNER).state;
    expect(commitCoinPusherEmpty(MACHINE, base, { ...emptied, totalEmptied: emptied.totalEmptied + 10 }, door(OWNER), OWNER, 11)).toBeNull();
    expect(commitCoinPusherEmpty(MACHINE, { ...base, tick: base.tick - 1 }, emptied, door(OWNER), OWNER, 11)).toBeNull();
    expect(commitCoinPusherEmpty(MACHINE, base, base, door(OWNER), OWNER, 11)).toBeNull();
    expect(readChips(OWNER)).toBe(0);
    expect(readCoinPusherDoorResult(MACHINE)).toBeNull();
  });
});

// ── refuseCoinPusherEmpty ────────────────────────────────────────────────────

describe('refuseCoinPusherEmpty', () => {
  const door = (requestId: string) => ({ requestId, requester: ATTACKER, requestedAt: 5 });

  it('answers the door request with a refusal and clears it — the machine and chips stay put', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, door('door-1'));
    const transactions = countTransactions(doc);
    expect(refuseCoinPusherEmpty(MACHINE, door('door-1'), 12)).toBe(true);
    expect(transactions()).toBe(1);
    expect(readCoinPusherDoorResult(MACHINE)).toEqual({ kind: 'refused', requestId: 'door-1', atMs: 12 });
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
    expect(readCoinPusherState(MACHINE)).toEqual(base);
    expect(readChips(ATTACKER)).toBe(0);
  });

  it('writes nothing once the request is gone or replaced', () => {
    expect(refuseCoinPusherEmpty(MACHINE, door('door-1'), 12)).toBe(false);
    writeCoinPusherEmptyRequest(MACHINE, door('door-2'));
    expect(refuseCoinPusherEmpty(MACHINE, door('door-1'), 12)).toBe(false);
    expect(readCoinPusherDoorResult(MACHINE)).toBeNull();
    expect(readCoinPusherEmptyRequest(MACHINE)?.requestId).toBe('door-2');
  });

  it('a door answer that is not well formed reads as none', () => {
    const map = doc.getMap('casino');
    for (const junk of [
      { kind: 'opened', requestId: 'd', emptied: -1, atMs: 1 },
      { kind: 'opened', requestId: 'd', emptied: 10_000, atMs: 1 },
      { kind: 'opened', requestId: 'd', atMs: 1 },
      { kind: 'refused', requestId: '', atMs: 1 },
      { kind: 'shut', requestId: 'd', atMs: 1 },
      'opened',
    ]) {
      map.set(`pusher-door:${MACHINE}`, junk);
      expect(readCoinPusherDoorResult(MACHINE)).toBeNull();
    }
  });
});

// ── drainAndClearCoinPusher (cabinet removed) ────────────────────────────────

describe('drainAndClearCoinPusher', () => {
  it('pays the chips inside to the caller (the deed holder) and deletes the machine\'s own keys in one transaction', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'));
    const refused = { requestId: 'd0', requester: ATTACKER, requestedAt: 0 };
    writeCoinPusherEmptyRequest(MACHINE, refused);
    refuseCoinPusherEmpty(MACHINE, refused, 1);
    expect(readCoinPusherDoorResult(MACHINE)).not.toBeNull();
    writeCoinPusherEmptyRequest(MACHINE, { requestId: 'd', requester: OWNER, requestedAt: 0 });
    writeCoinPusherOperatorLease(MACHINE, { playerId: OWNER, sessionId: 's', expiresAt: 99 });
    refuseCoinPusherInsert(MACHINE, request(PLAYER, 'req-1'), 'expired', 1);
    expect(readCoinPusherResult(MACHINE, PLAYER)).not.toBeNull();
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-2'));
    const transactions = countTransactions(doc);
    expect(drainAndClearCoinPusher(MACHINE, OWNER)).toBe(chipsInMachine(base));
    expect(transactions()).toBe(1);
    expect(readChips(OWNER)).toBe(chipsInMachine(base));
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
    expect(doc.getMap('casino').has(`pusher-door:${MACHINE}`)).toBe(false);
    expect(readCoinPusherOperatorLease(MACHINE)).toBeNull();
    // Its per-player keys carry no chips; the sweep deletes them afterwards.
    expect(readCoinPusherResult(MACHINE, PLAYER)).not.toBeNull();
    sweepAll(MACHINE);
    expect(readCoinPusherResult(MACHINE, PLAYER)).toBeNull();
    expect(readCoinPusherRequests(MACHINE)).toEqual([]);
    expect(readChips(OWNER)).toBe(chipsInMachine(base));
  });

  it('sweeps a flood of per-player keys a batch at a time', () => {
    const map = doc.getMap('casino');
    writeCoinPusherState(MACHINE, machineWith(5));
    const flood = 3 * PUSHER_SWEEP_BATCH + 5;
    for (let i = 0; i < flood; i++) map.set(`pusher-result:${MACHINE}:p${i}`, 'junk');
    const left = () => [...map.keys()].filter((k) => k.startsWith(`pusher-result:${MACHINE}:`)).length;
    drainAndClearCoinPusher(MACHINE, OWNER);
    expect(left()).toBe(flood);
    const sweep = startCoinPusherKeySweep(MACHINE);
    for (let batch = 1; batch <= 3; batch++) {
      const transactions = countTransactions(doc);
      expect(continueCoinPusherKeySweep(sweep)).toBe(false);
      expect(transactions()).toBe(1);
      const late = batch > 1 ? 1 : 0;
      expect(left()).toBe(flood + late - batch * PUSHER_SWEEP_BATCH);
      // A stale answer landing mid-sweep is swept too.
      if (batch === 1) map.set(`pusher-result:${MACHINE}:late`, 'junk');
    }
    // The pass ends deleting the last few; the next finds nothing and ends it.
    expect(continueCoinPusherKeySweep(sweep)).toBe(false);
    expect(left()).toBe(0);
    expect(continueCoinPusherKeySweep(sweep)).toBe(true);
  });

  it('a key added to a family the pass already went through is swept by the next pass', () => {
    const map = doc.getMap('casino');
    writeCoinPusherState(MACHINE, machineWith(5));
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'));
    for (let i = 0; i < 2 * PUSHER_SWEEP_BATCH; i++) map.set(`pusher-result:${MACHINE}:p${i}`, 'junk');
    drainAndClearCoinPusher(MACHINE, OWNER);
    const sweep = startCoinPusherKeySweep(MACHINE);
    expect(continueCoinPusherKeySweep(sweep)).toBe(false); // the request, then answers
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
    // A stale request lands after its family was passed, answers still left.
    writeCoinPusherRequest(MACHINE, request(OTHER, 'stale'));
    let batches = 1;
    while (!continueCoinPusherKeySweep(sweep)) batches += 1;
    expect(readCoinPusherRequest(MACHINE, OTHER)).toBeNull();
    expect([...map.keys()].filter((k) => k.includes(`${MACHINE}:`))).toEqual([]);
    expect(batches).toBeLessThan(10);
  });

  it('a sweep ends when the room changes, writing to neither room\'s doc', () => {
    const map = doc.getMap('casino');
    writeCoinPusherState(MACHINE, machineWith(5));
    for (let i = 0; i < 10; i++) map.set(`pusher-result:${MACHINE}:p${i}`, 'junk');
    drainAndClearCoinPusher(MACHINE, OWNER);
    const sweep = startCoinPusherKeySweep(MACHINE);
    const nextRoom = new Y.Doc();
    bindCasinoDoc(nextRoom);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'theirs'));
    expect(continueCoinPusherKeySweep(sweep)).toBe(true);
    expect(readCoinPusherRequest(MACHINE, PLAYER)?.requestId).toBe('theirs');
    // The room it left is left alone too: it may be torn down already.
    expect([...map.keys()].filter((k) => k.startsWith(`pusher-result:${MACHINE}:`))).toHaveLength(10);
  });

  it('refunds nothing for pending or forged requests — they never held chips', () => {
    writeCoinPusherState(MACHINE, machineWith(5));
    buyInChips(PLAYER, 4);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'));
    const map = doc.getMap('casino');
    for (let i = 0; i < 20; i++) {
      map.set(`pusher-req:${MACHINE}:${ATTACKER}`, request(ATTACKER, `forged-${i}`));
      map.set(`pusher-esc:${MACHINE}:${ATTACKER}:forged-${i}`, { requestId: `forged-${i}`, player: ATTACKER, ante: 100, escrowedAt: 0 });
    }
    drainAndClearCoinPusher(MACHINE, OWNER);
    sweepAll(MACHINE);
    expect(readChips(PLAYER)).toBe(4);
    expect(readChips(ATTACKER)).toBe(0);
    // The escrow-shaped records an earlier revision used go with the machine.
    expect([...map.keys()].filter((k) => k.startsWith(`pusher-esc:${MACHINE}:`))).toEqual([]);
  });

  it('never pays the owner a peer-written machine names', () => {
    // A forged, well-formed machine full of invented chips that names the
    // attacker as its owner, raced against the cabinet's removal.
    const forged = machineWith(30, ATTACKER);
    writeCoinPusherState(MACHINE, forged);
    expect(drainAndClearCoinPusher(MACHINE, OWNER)).toBe(chipsInMachine(forged));
    expect(readChips(ATTACKER)).toBe(0);
    expect(readChips(OWNER)).toBe(chipsInMachine(forged));
  });

  it('finds the machine\'s keys through the index, never by walking the casino map', () => {
    const map = doc.getMap('casino');
    for (let i = 0; i < 2_000; i++) map.set(`noise:${i}`, i);
    const base = machineWith(10);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'));
    refuseCoinPusherInsert(MACHINE, request(PLAYER, 'req-1'), 'expired', 1); // an answer
    writeCoinPusherRequest(MACHINE, request(OTHER, 'req-2'));
    map.set(`pusher-result:${MACHINE}:${OTHER}`, 'junk'); // any value under the prefix goes
    map.set(`pusher-esc:${MACHINE}:${ATTACKER}:old`, { requestId: 'old', player: ATTACKER, ante: 5 });
    // A machine whose id starts with this one's keeps its keys.
    const neighbour = `${MACHINE}0`;
    writeCoinPusherRequest(neighbour, request(PLAYER, 'n-1'));
    map.set(`pusher-result:${neighbour}:${PLAYER}`, { kind: 'refused', requestId: 'n-0', reason: 'expired', atMs: 1 });
    expect(withoutWalking(() => {
      const credit = drainAndClearCoinPusher(MACHINE, OWNER);
      sweepAll(MACHINE);
      return credit;
    })).toBe(chipsInMachine(base));
    expect([...map.keys()].filter((k) => k.includes(MACHINE)).sort()).toEqual([
      `pusher-req:${neighbour}:${PLAYER}`, `pusher-result:${neighbour}:${PLAYER}`,
    ]);
    expect(readChips(ATTACKER)).toBe(0);
  });

  it('credits nothing when there is no machine (or junk), and still clears its keys', () => {
    doc.getMap('casino').set(`pusher:${MACHINE}`, { kind: 'coin-pusher', junk: true });
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'));
    expect(drainAndClearCoinPusher(MACHINE, OWNER)).toBe(0);
    expect(doc.getMap('casino').has(`pusher:${MACHINE}`)).toBe(false);
    sweepAll(MACHINE);
    expect(readCoinPusherRequests(MACHINE)).toEqual([]);
  });
});

// ── Two peers ────────────────────────────────────────────────────────────────

describe('coin pusher across two peers', () => {
  function sync(a: Y.Doc, b: Y.Doc): void {
    const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, toB);
    Y.applyUpdate(a, toA);
  }

  /** Operator doc + player doc, synced, with a paying request pending. */
  function twoPeers() {
    const operatorDoc = new Y.Doc();
    const playerDoc = new Y.Doc();
    bindCasinoDoc(operatorDoc);
    const { base, req, next } = payingSetup();
    sync(operatorDoc, playerDoc);
    bindCasinoDoc(playerDoc);
    buyInChips(PLAYER, 5);
    sync(operatorDoc, playerDoc);
    return { operatorDoc, playerDoc, base, req, next };
  }

  it('a settle racing the player\'s cancel converges to one drop, paid once', () => {
    const { operatorDoc, playerDoc, base, req, next } = twoPeers();
    bindCasinoDoc(operatorDoc);
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('ok');
    bindCasinoDoc(playerDoc);
    expect(cancelCoinPusherRequest(MACHINE, PLAYER, req.requestId)).toBe(true);
    sync(operatorDoc, playerDoc);
    for (const d of [operatorDoc, playerDoc]) {
      bindCasinoDoc(d);
      expect(readChips(PLAYER)).toBe(5 - 1 + next.lastDrop!.paid);
      expect(readCoinPusherState(MACHINE)).toEqual(next);
      expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
    }
  });

  it('a new request the player writes while the operator settles the last one survives the merge', () => {
    const { operatorDoc, playerDoc, base, req, next } = twoPeers();
    bindCasinoDoc(operatorDoc);
    expect(settleCoinPusherInsert(MACHINE, base, next, req)).toBe('ok');
    bindCasinoDoc(playerDoc);
    cancelCoinPusherRequest(MACHINE, PLAYER, req.requestId);
    const again = request(PLAYER, 'req-again', 2, 0.1);
    expect(writeCoinPusherRequest(MACHINE, again)).toBe(true);
    sync(operatorDoc, playerDoc);
    for (const d of [operatorDoc, playerDoc]) {
      bindCasinoDoc(d);
      expect(readCoinPusherRequest(MACHINE, PLAYER)).toEqual(again);
      expect(readChips(PLAYER)).toBe(5 - 1 + next.lastDrop!.paid);
    }
  });
});
