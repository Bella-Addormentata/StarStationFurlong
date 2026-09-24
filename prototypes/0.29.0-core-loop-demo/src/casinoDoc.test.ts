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

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindCasinoDoc,
  buyInChips,
  cancelCoinPusherRequest,
  commitCoinPusherEmpty,
  drainAndClearCoinPusher,
  readChips,
  readCoinPusherEmptyRequest,
  readCoinPusherOperatorLease,
  readCoinPusherRequest,
  readCoinPusherRequests,
  readCoinPusherState,
  refuseCoinPusherInsert,
  settleCoinPusherInsert,
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
  it('records why, clears the request and moves no chips', () => {
    const base = machineWith(10);
    writeCoinPusherState(MACHINE, base);
    buyInChips(PLAYER, 2);
    const req = request(PLAYER, 'req-1');
    writeCoinPusherRequest(MACHINE, req);
    expect(refuseCoinPusherInsert(MACHINE, readCoinPusherState(MACHINE)!, req, 'machine-full', 9)).toBe(true);
    const after = readCoinPusherState(MACHINE)!;
    expect(after.lastRefusal).toEqual({ requestId: 'req-1', player: PLAYER, reason: 'machine-full', atMs: 9 });
    expect(after.tick).toBe(base.tick + 1);
    expect(chipsInMachine(after)).toBe(chipsInMachine(base));
    expect(after.totalInserted).toBe(base.totalInserted);
    expect(readChips(PLAYER)).toBe(2);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
  });

  it('writes nothing over a newer machine', () => {
    const base = machineWith(10);
    writeCoinPusherState(MACHINE, { ...base, tick: base.tick + 5 });
    const req = request(PLAYER, 'req-1');
    writeCoinPusherRequest(MACHINE, req);
    expect(refuseCoinPusherInsert(MACHINE, base, req, 'no-chips', 9)).toBe(false);
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toEqual(req);
  });
});

// ── commitCoinPusherEmpty ────────────────────────────────────────────────────

describe('commitCoinPusherEmpty', () => {
  const door = (requester: string) => ({ requestId: 'door-1', requester, requestedAt: 5 });

  it('credits the owner exactly the chips inside, empties the machine and clears the door — in one transaction', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, door(OWNER));
    buyInChips(OWNER, 7);
    const inside = chipsInMachine(base);
    const transactions = countTransactions(doc);
    const emptied = emptyMachine(base, OWNER).state;
    expect(commitCoinPusherEmpty(MACHINE, readCoinPusherState(MACHINE)!, emptied, door(OWNER), OWNER)).toBe(inside);
    expect(transactions()).toBe(1);
    expect(readChips(OWNER)).toBe(7 + inside);
    expect(chipsInMachine(readCoinPusherState(MACHINE)!)).toBe(0);
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
  });

  it('refuses a door request from anyone but the owner', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, door(ATTACKER));
    const emptied = { ...emptyMachine(base, OWNER).state };
    expect(commitCoinPusherEmpty(MACHINE, base, emptied, door(ATTACKER), OWNER)).toBeNull();
    expect(commitCoinPusherEmpty(MACHINE, base, emptied, door(ATTACKER), ATTACKER)).toBeNull();
    expect(readChips(ATTACKER)).toBe(0);
    expect(readChips(OWNER)).toBe(0);
    expect(readCoinPusherState(MACHINE)).toEqual(base);
  });

  it('pays only an operator who owns the machine — a machine naming someone else pays nobody', () => {
    // A peer-written machine that names the attacker as owner, with the
    // attacker's own door request: the operator (OWNER) is not its owner.
    const forged = machineWith(40, ATTACKER);
    writeCoinPusherState(MACHINE, forged);
    writeCoinPusherEmptyRequest(MACHINE, door(ATTACKER));
    const emptied = emptyMachine(forged, ATTACKER).state;
    expect(commitCoinPusherEmpty(MACHINE, forged, emptied, door(ATTACKER), OWNER)).toBeNull();
    expect(readChips(ATTACKER)).toBe(0);
  });

  it('refuses a next that is not the empty of the stored machine', () => {
    const base = machineWith(40);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherEmptyRequest(MACHINE, door(OWNER));
    const emptied = emptyMachine(base, OWNER).state;
    expect(commitCoinPusherEmpty(MACHINE, base, { ...emptied, totalEmptied: emptied.totalEmptied + 10 }, door(OWNER), OWNER)).toBeNull();
    expect(commitCoinPusherEmpty(MACHINE, { ...base, tick: base.tick - 1 }, emptied, door(OWNER), OWNER)).toBeNull();
    expect(commitCoinPusherEmpty(MACHINE, base, base, door(OWNER), OWNER)).toBeNull();
    expect(readChips(OWNER)).toBe(0);
  });
});

// ── drainAndClearCoinPusher (cabinet removed) ────────────────────────────────

describe('drainAndClearCoinPusher', () => {
  it('pays the chips inside to the caller (the deed holder) and deletes every key the machine used', () => {
    const base = machineWith(30);
    writeCoinPusherState(MACHINE, base);
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'));
    writeCoinPusherEmptyRequest(MACHINE, { requestId: 'd', requester: OWNER, requestedAt: 0 });
    writeCoinPusherOperatorLease(MACHINE, { playerId: OWNER, sessionId: 's', expiresAt: 99 });
    expect(drainAndClearCoinPusher(MACHINE, OWNER)).toBe(chipsInMachine(base));
    expect(readChips(OWNER)).toBe(chipsInMachine(base));
    expect(readCoinPusherState(MACHINE)).toBeNull();
    expect(readCoinPusherRequests(MACHINE)).toEqual([]);
    expect(readCoinPusherEmptyRequest(MACHINE)).toBeNull();
    expect(readCoinPusherOperatorLease(MACHINE)).toBeNull();
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
    expect(readChips(PLAYER)).toBe(4);
    expect(readChips(ATTACKER)).toBe(0);
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

  it('credits nothing when there is no machine (or junk), and still clears its keys', () => {
    doc.getMap('casino').set(`pusher:${MACHINE}`, { kind: 'coin-pusher', junk: true });
    writeCoinPusherRequest(MACHINE, request(PLAYER, 'req-1'));
    expect(drainAndClearCoinPusher(MACHINE, OWNER)).toBe(0);
    expect(doc.getMap('casino').has(`pusher:${MACHINE}`)).toBe(false);
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
