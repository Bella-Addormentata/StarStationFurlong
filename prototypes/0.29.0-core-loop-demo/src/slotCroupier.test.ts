/**
 * 🎰 slotCroupier tests: ONE session operates every slot machine in the room
 * (the room's `slot-operator` lease), against a real Yjs-backed casino map.
 * A player's `bal:` is a whole value, so two sessions settling that player's
 * spins on two machines at once would each write it and the merge would keep
 * only one of the two writes. These tests pin the election that prevents it:
 * the takeover rules, the wind-down of a round on a machine this session no
 * longer operates, the by-hand (venture room) path, earlier builds' per-
 * machine leases, and leaving a room.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  bindCasinoDoc,
  buyInChips,
  hasSlotEscrow,
  readChips,
  readSlotMachineState,
  readSlotOperatorLease,
  readSlotPlayRequests,
  refundSlotWager,
  reserveSlotWager,
  SLOT_OPERATOR_KEY,
  writeSlotFundingConfig,
  writeSlotMachineState,
  writeSlotOperatorLease,
  writeSlotPlayRequest,
  writeSlotReveal,
} from './casinoDoc';
import type { SlotOperatorLease } from './casinoDoc';
import { setSoleCroupierPredicate } from './croupier';
import {
  commitSlotSeed,
  DEFAULT_PAYTABLE,
  hashSlotPaytable,
  maxSlotPayout,
  randomSlotSeed,
  SLOT_SPIN_MS,
} from './games/slots';
import { getPlayerId } from './identity';
import {
  closeSlotMachine,
  isManualSlotMachineRunning,
  isSlotOperator,
  leaveSlotMachineRoom,
  OPERATOR_UNCLEAN_TAKEOVER_MS,
  releaseSlotOperatorLease,
  setManualSlotMachineRunning,
  slotOperatorSession,
  slotOperatorWatchCount,
  slotRoundsInHand,
  tickSlotMachineRoom,
} from './slotCroupier';

const OPERATOR = getPlayerId();
const PLAYER = 'player-Bob';
const OTHER = 'player-Carol';
const M1 = 'slot-machine-1';
const M2 = 'slot-machine-2';
const T0 = 1_000_000_000;
const LEASE_MS = 8_000;
const SETTLE_MS = 2_000;
const BET = 5;
/** What a round locks in escrow (the most a BET can win). */
const RESERVE = Math.max(BET, maxSlotPayout(BET, DEFAULT_PAYTABLE));
/** This page's device: tabs on it share this prefix in their session ids. */
const DEVICE = slotOperatorSession().split(':')[0];

let doc: Y.Doc;

function at(t: number): number {
  vi.setSystemTime(t);
  return t;
}

/** A lease another session holds (another device unless `sessionId` says). */
function lease(expiresAt: number, sessionId = 'other-device:tab', playerId = OPERATOR): SlotOperatorLease {
  return { playerId, sessionId, expiresAt };
}

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

const TENURE = expect.stringMatching(/^[0-9a-f-]{36}$/);

const spinning = (machineId: string): boolean =>
  readSlotMachineState(machineId)?.phase === 'spinning';

/** Let the operator's async accept (it hashes the house seed) run out. */
async function acceptsDone(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Take the room's lease at `t`, then tick past the settling wait. */
function becomeOperator(machineIds: readonly string[], t = T0, manual = false): number {
  tickSlotMachineRoom(machineIds, manual, at(t));
  const ready = at(t + SETTLE_MS);
  tickSlotMachineRoom(machineIds, manual, ready);
  return ready;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  doc = new Y.Doc();
  bindCasinoDoc(doc);
  setSoleCroupierPredicate(() => true);
  buyInChips(OPERATOR, 10_000);
  buyInChips(PLAYER, 100);
});

afterEach(async () => {
  await acceptsDone();
  leaveSlotMachineRoom(); // reset this session's operator and watch state
  setSoleCroupierPredicate(() => true);
  vi.useRealTimers();
});

// ── The room's election ──────────────────────────────────────────────────────

describe('one operator for the room', () => {
  it('takes the room lease, then accepts spins on every machine it funds once past its settling wait', async () => {
    fund(M1);
    fund(M2);
    await requestSpin(M1);
    await requestSpin(M2);

    tickSlotMachineRoom([M1, M2], false, at(T0));
    expect(readSlotOperatorLease()).toEqual({
      playerId: OPERATOR,
      sessionId: slotOperatorSession(),
      tenure: TENURE,
      expiresAt: T0 + LEASE_MS,
    });
    tickSlotMachineRoom([M1, M2], false, at(T0 + SETTLE_MS - 1));
    await acceptsDone();
    expect(spinning(M1) || spinning(M2)).toBe(false); // still settling in

    tickSlotMachineRoom([M1, M2], false, at(T0 + SETTLE_MS));
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(spinning(M2)).toBe(true);
    // One writer for the player's balance: both debits are kept.
    expect(readChips(PLAYER)).toBe(100 - 2 * BET);
    expect(readChips(OPERATOR)).toBe(10_000 + 2 * BET - 2 * RESERVE);
  });

  it("keeps off every machine while another session's lease is live, even the machines it funds", async () => {
    fund(M1);
    fund(M2);
    await requestSpin(M1);
    await requestSpin(M2);
    // Another session of the same player (the deed holder's other tab or
    // device) holds the room and keeps renewing.
    writeSlotOperatorLease(lease(T0 + LEASE_MS));
    for (let t = T0; t <= T0 + 30_000; t += 1_000) {
      if ((t - T0) % 3_000 === 0) writeSlotOperatorLease(lease(t + LEASE_MS));
      tickSlotMachineRoom([M1, M2], false, at(t));
    }
    await acceptsDone();
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab');
    expect(isSlotOperator()).toBe(false);
    expect(spinning(M1) || spinning(M2)).toBe(false);
    expect(readSlotPlayRequests(M1)).toHaveLength(1);
    expect(readSlotPlayRequests(M2)).toHaveLength(1);
    expect(readChips(PLAYER)).toBe(100);
  });

  it("takes another device's lapsed lease only after the split window", () => {
    fund(M1);
    writeSlotOperatorLease(lease(T0 + LEASE_MS));
    tickSlotMachineRoom([M1], false, at(T0)); // first seen now; never renewed
    tickSlotMachineRoom([M1], false, at(T0 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS - 1));
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab');
    tickSlotMachineRoom([M1], false, at(T0 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS));
    expect(readSlotOperatorLease()?.sessionId).toBe(slotOperatorSession());
  });

  it('gives another device the split window whatever player id its lease names', () => {
    // The deed holder's other installs have player ids of their own.
    fund(M1);
    writeSlotOperatorLease(lease(T0 + LEASE_MS, 'other-device:tab', 'player-other-install'));
    tickSlotMachineRoom([M1], false, at(T0));
    tickSlotMachineRoom([M1], false, at(T0 + LEASE_MS + 1));
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab');
  });

  it('takes a lapsed lease from a tab on this device at once', () => {
    fund(M1);
    writeSlotOperatorLease(lease(T0 + LEASE_MS, `${DEVICE}:other-tab`));
    tickSlotMachineRoom([M1], false, at(T0));
    tickSlotMachineRoom([M1], false, at(T0 + LEASE_MS - 1));
    expect(readSlotOperatorLease()?.sessionId).toBe(`${DEVICE}:other-tab`);
    tickSlotMachineRoom([M1], false, at(T0 + LEASE_MS));
    expect(readSlotOperatorLease()?.sessionId).toBe(slotOperatorSession());
  });

  it("judges another device's lease by the renewals it sees, never by the expiry it claims", () => {
    fund(M1);
    // A clock 10 s behind ours: every renewal claims an expiry already past.
    for (let t = T0; t <= T0 + 30_000; t += 1_000) {
      if ((t - T0) % 3_000 === 0) writeSlotOperatorLease(lease(t - 10_000 + LEASE_MS));
      tickSlotMachineRoom([M1], false, at(t));
    }
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab');

    // A record claiming a far-future expiry holds the room for one term (and
    // the split window), not forever.
    const t1 = T0 + 40_000;
    writeSlotOperatorLease(lease(t1 + 365 * 24 * 3_600_000));
    tickSlotMachineRoom([M1], false, at(t1));
    tickSlotMachineRoom([M1], false, at(t1 + LEASE_MS + OPERATOR_UNCLEAN_TAKEOVER_MS));
    expect(readSlotOperatorLease()?.sessionId).toBe(slotOperatorSession());
  });

  it('never takes the lease for machines whose bankroll another player owns', () => {
    fund(M1, OTHER);
    fund(M2, OTHER);
    tickSlotMachineRoom([M1, M2], false, at(T0));
    expect(readSlotOperatorLease()).toBeNull();
  });

  it('lets the lease go once it has no machine left to operate', () => {
    fund(M1);
    becomeOperator([M1]);
    expect(isSlotOperator()).toBe(true);
    tickSlotMachineRoom([], false, at(T0 + SETTLE_MS + 1));
    expect(readSlotOperatorLease()).toBeNull();
    expect(isSlotOperator()).toBe(false);
  });

  it('lets the lease go when this client may no longer run the croupier', () => {
    fund(M1);
    becomeOperator([M1]);
    setSoleCroupierPredicate(() => false);
    tickSlotMachineRoom([M1], false, at(T0 + SETTLE_MS + 1));
    expect(readSlotOperatorLease()).toBeNull();
  });

  it("stops once another session has taken the lease, and leaves that session's record alone", () => {
    fund(M1);
    const ready = becomeOperator([M1]);
    writeSlotOperatorLease(lease(ready + LEASE_MS)); // another session took the room over
    tickSlotMachineRoom([M1], false, at(ready + 100));
    expect(isSlotOperator()).toBe(false);
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab');
  });

  it('forgets a round of a machine that has left the room, and lets the lease go at once', async () => {
    fund(M1);
    await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    expect(slotRoundsInHand()).toBe(1);
    // A peer removed the machine, and this client may not tear it down.
    closeSlotMachine(M1, false);
    tickSlotMachineRoom([], false, at(ready + 100));
    expect(slotRoundsInHand()).toBe(0);
    expect(isSlotOperator()).toBe(false);
    expect(readSlotOperatorLease()).toBeNull();
  });

  it('writes a fresh tenure each time it takes the lease, and keeps it when renewing', () => {
    fund(M1);
    becomeOperator([M1]);
    const first = readSlotOperatorLease()?.tenure;
    expect(first).toEqual(TENURE);
    tickSlotMachineRoom([M1], false, at(T0 + 3_000)); // a renewal
    expect(readSlotOperatorLease()?.expiresAt).toBe(T0 + 3_000 + LEASE_MS);
    expect(readSlotOperatorLease()?.tenure).toBe(first);
    tickSlotMachineRoom([], false, at(T0 + 3_016)); // lets it go…
    tickSlotMachineRoom([M1], false, at(T0 + 3_032)); // …and takes it again
    expect(readSlotOperatorLease()?.tenure).toEqual(TENURE);
    expect(readSlotOperatorLease()?.tenure).not.toBe(first);
  });

  it('reads a retake with a new tenure as a new term, even when it never saw the lease go', () => {
    fund(M1);
    const other = `${DEVICE}:other-tab`;
    writeSlotOperatorLease({ playerId: OPERATOR, sessionId: other, tenure: 'first', expiresAt: T0 + 60_000 });
    tickSlotMachineRoom([M1], false, at(T0));
    // Let go and taken again between two of this page's frames, claiming the
    // same expiry: only the tenure tells the new take from the old record.
    writeSlotOperatorLease({ playerId: OPERATOR, sessionId: other, tenure: 'second', expiresAt: T0 + 60_000 });
    tickSlotMachineRoom([M1], false, at(T0 + 5_000));
    tickSlotMachineRoom([M1], false, at(T0 + LEASE_MS)); // the first take's term is over
    expect(readSlotOperatorLease()?.sessionId).toBe(other);
    tickSlotMachineRoom([M1], false, at(T0 + 5_000 + LEASE_MS)); // and now the second's
    expect(readSlotOperatorLease()?.sessionId).toBe(slotOperatorSession());
  });

  it('renews its lease every 3 s while it operates', () => {
    fund(M1);
    becomeOperator([M1]);
    tickSlotMachineRoom([M1], false, at(T0 + 2_999));
    expect(readSlotOperatorLease()?.expiresAt).toBe(T0 + LEASE_MS);
    tickSlotMachineRoom([M1], false, at(T0 + 3_000));
    expect(readSlotOperatorLease()?.expiresAt).toBe(T0 + 3_000 + LEASE_MS);
  });

  it('clears a lapsed lease of its own at once, and takes the lease afresh on the next frame', () => {
    fund(M1);
    becomeOperator([M1]);
    // No frames for a while (a background tab): the lease lapses.
    tickSlotMachineRoom([M1], false, at(T0 + 20_000));
    expect(readSlotOperatorLease()).toBeNull();
    tickSlotMachineRoom([M1], false, at(T0 + 20_001));
    expect(readSlotOperatorLease()).toEqual({
      playerId: OPERATOR,
      sessionId: slotOperatorSession(),
      tenure: TENURE,
      expiresAt: T0 + 20_001 + LEASE_MS,
    });
  });

  it('accepts nothing once the lease is lost while it is accepting', async () => {
    fund(M1);
    await requestSpin(M1);
    becomeOperator([M1]); // starts the accept, which awaits its hashes
    writeSlotOperatorLease(lease(T0 + SETTLE_MS + LEASE_MS)); // taken over meanwhile
    await acceptsDone();
    expect(spinning(M1)).toBe(false);
    expect(readSlotPlayRequests(M1)).toHaveLength(1);
    expect(readChips(PLAYER)).toBe(100);
  });
});

// ── Winding a round down ─────────────────────────────────────────────────────

describe('a round on a machine this session no longer operates', () => {
  it('is refunded here when the bankroll changes hands, then the lease goes', async () => {
    fund(M1);
    await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);

    fund(M1, OTHER); // another house member takes the machine's bankroll
    tickSlotMachineRoom([M1], false, at(ready + 100));
    await acceptsDone();
    const state = readSlotMachineState(M1);
    expect(state?.phase).toBe('settled');
    expect(state?.failure).toBe('invalid-house-commit'); // shown as REFUNDED
    expect(readChips(PLAYER)).toBe(100);
    expect(readChips(OPERATOR)).toBe(10_000);
    // The lease was held for the refund; with nothing left, it goes.
    expect(isSlotOperator()).toBe(true);
    tickSlotMachineRoom([M1], false, at(ready + 200));
    expect(readSlotOperatorLease()).toBeNull();
  });

  it('is refunded here when this client may no longer run the croupier', async () => {
    fund(M1);
    await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    setSoleCroupierPredicate(() => false); // the deed changed hands
    tickSlotMachineRoom([M1], false, at(ready + 100));
    await acceptsDone();
    expect(readSlotMachineState(M1)?.phase).toBe('settled');
    expect(readChips(PLAYER)).toBe(100);
    tickSlotMachineRoom([M1], false, at(ready + 200));
    expect(readSlotOperatorLease()).toBeNull();
  });

  it('keeps operating its other machines meanwhile', async () => {
    fund(M1);
    fund(M2);
    await requestSpin(M1);
    const ready = becomeOperator([M1, M2]);
    await acceptsDone();
    fund(M1, OTHER);
    await requestSpin(M2);
    tickSlotMachineRoom([M1, M2], false, at(ready + 300));
    await acceptsDone();
    expect(readSlotMachineState(M1)?.phase).toBe('settled');
    expect(spinning(M2)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
    expect(isSlotOperator()).toBe(true);
  });

  it('is dropped, never refunded twice, once another operator has resolved it', async () => {
    fund(M1);
    await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    // Another operator refunded the round meanwhile: the player has the stake
    // back, the escrow is gone, and the machine shows the refund.
    const map = doc.getMap('casino');
    doc.transact(() => {
      map.delete(`slot-escrow:${M1}`);
      map.set(`bal:${PLAYER}`, 100);
      map.set(`bal:${OPERATOR}`, 10_000);
    });
    writeSlotMachineState(M1, { ...readSlotMachineState(M1)!, phase: 'settled', credited: 0 });
    fund(M1, OTHER);
    tickSlotMachineRoom([M1], false, at(ready + 100));
    await acceptsDone();
    expect(readChips(PLAYER)).toBe(100);
    expect(readChips(OPERATOR)).toBe(10_000);
    expect(readSlotOperatorLease()).toBeNull(); // nothing held it
  });
});

// ── Rounds in flight when the lease goes, and rounds resolved elsewhere ─────

describe('a round once this session no longer holds the lease', () => {
  it('writes nothing from a settle paused at an await: the round stays for the next operator', async () => {
    fund(M1);
    const seed = await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    reveal(M1, seed);
    tickSlotMachineRoom([M1], false, at(ready + SLOT_SPIN_MS + 10)); // the settle starts, then awaits
    releaseSlotOperatorLease(); // the page is put away (pagehide), or leaves the room
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
    expect(hasSlotEscrow(M1)).toBe(true);
  });

  it('writes nothing from a settle paused at an await once another session has taken the lease', async () => {
    fund(M1);
    const seed = await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    reveal(M1, seed);
    tickSlotMachineRoom([M1], false, at(ready + SLOT_SPIN_MS + 10)); // the settle starts, then awaits
    writeSlotOperatorLease(lease(ready + SLOT_SPIN_MS + 10 + LEASE_MS)); // taken over meanwhile
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
  });

  it('writes nothing from a settle paused under one take once this page has taken the lease again, then settles it under the new take', async () => {
    fund(M1);
    const seed = await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    reveal(M1, seed);
    const t = ready + SLOT_SPIN_MS + 10;
    tickSlotMachineRoom([M1], false, at(t)); // the settle starts under the first take, then awaits
    releaseSlotOperatorLease(); // released (pagehide)…
    tickSlotMachineRoom([M1], false, at(t + 1)); // …and taken again at once (a page restored from the cache)
    const second = readSlotOperatorLease()?.tenure;
    await acceptsDone();
    expect(spinning(M1)).toBe(true); // the first take's settle wrote nothing
    expect(readChips(PLAYER)).toBe(100 - BET);
    // Past the new take's settling wait, the round is settled under it.
    tickSlotMachineRoom([M1], false, at(t + 1 + SETTLE_MS));
    await acceptsDone();
    expect(readSlotMachineState(M1)?.phase).toBe('settled');
    expect(readSlotOperatorLease()?.tenure).toBe(second);
  });

  it('writes nothing from a settle whose take a peer has overwritten, even naming this page', async () => {
    fund(M1);
    const seed = await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    reveal(M1, seed);
    const t = ready + SLOT_SPIN_MS + 10;
    tickSlotMachineRoom([M1], false, at(t)); // the settle starts, then awaits
    const mine = readSlotOperatorLease()!;
    writeSlotOperatorLease({ ...mine, tenure: 'forged' }); // this page's session, another take
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
  });

  it('writes nothing from a settle begun under a take this page has since replaced, even if that take is written back', async () => {
    fund(M1);
    const seed = await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    reveal(M1, seed);
    const t = ready + SLOT_SPIN_MS + 10;
    tickSlotMachineRoom([M1], false, at(t)); // the settle starts under the first take, then awaits
    const first = readSlotOperatorLease()!;
    releaseSlotOperatorLease();
    tickSlotMachineRoom([M1], false, at(t + 1)); // a new take…
    writeSlotOperatorLease({ ...first, expiresAt: t + 1 + LEASE_MS }); // …and a peer writes the old one back
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
  });

  it('writes nothing from a settle that resumes after its own lease has lapsed', async () => {
    fund(M1);
    const seed = await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    reveal(M1, seed);
    tickSlotMachineRoom([M1], false, at(ready + SLOT_SPIN_MS + 10)); // the settle starts, then awaits
    at(ready + SLOT_SPIN_MS + 10 + 20_000); // the page is frozen past its lease's term
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
  });

  it('accepts nothing from an accept paused under one take once this page has taken the lease again', async () => {
    fund(M1);
    await requestSpin(M1);
    const ready = becomeOperator([M1]); // the accept starts under the first take, then awaits
    releaseSlotOperatorLease();
    tickSlotMachineRoom([M1], false, at(ready + 1)); // taken again at once
    await acceptsDone();
    expect(spinning(M1)).toBe(false);
    expect(readSlotPlayRequests(M1)).toHaveLength(1);
    expect(readChips(PLAYER)).toBe(100);
    // Accepted once, under the new take, when its settling wait is over.
    tickSlotMachineRoom([M1], false, at(ready + 1 + SETTLE_MS));
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
  });

  it('writes nothing from a refund paused at an await', async () => {
    fund(M1);
    await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    fund(M1, OTHER); // the bankroll changes hands: the round is wound down…
    tickSlotMachineRoom([M1], false, at(ready + 100));
    releaseSlotOperatorLease(); // …but the lease goes while the refund awaits
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
    expect(hasSlotEscrow(M1)).toBe(true);
  });

  it('writes nothing from a reveal-timeout refund paused at an await', async () => {
    fund(M1);
    await requestSpin(M1);
    let t = becomeOperator([M1]);
    await acceptsDone();
    // No reveal comes; the operator keeps renewing past the 30 s reveal
    // timeout, whose refund then starts and awaits.
    for (let i = 0; i < 11; i++) tickSlotMachineRoom([M1], false, at(t += 3_000));
    releaseSlotOperatorLease();
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(readChips(PLAYER)).toBe(100 - BET);
  });

  it('drops a round another operator refunded meanwhile, and refunds nothing from the next round\'s escrow', async () => {
    fund(M1);
    await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    const first = readSlotMachineState(M1)!;
    const funding = { mode: 'owner' as const, ownerId: OPERATOR };
    // While this session had lost the lease for a while (a hidden tab gets no
    // frames), another operator refunded its round and accepted the next
    // player's spin, then went away.
    expect(refundSlotWager(M1, PLAYER, BET, funding)).toBe(true);
    buyInChips(OTHER, 100);
    expect(reserveSlotWager(M1, OTHER, BET, funding, RESERVE)).toBe('ok');
    writeSlotMachineState(M1, {
      ...first,
      round: first.round + 1,
      player: OTHER,
      requestId: 'req-other',
      fairness: { mode: 'commit-reveal', commits: ['a'.repeat(64), 'b'.repeat(64)] },
    });
    tickSlotMachineRoom([M1], false, at(ready + 100));
    await acceptsDone();
    expect(slotRoundsInHand()).toBe(0);
    // The orphaned spin is refunded to its own player, from its own escrow.
    expect(readSlotMachineState(M1)).toMatchObject({ phase: 'settled', requestId: 'req-other' });
    expect(readChips(OTHER)).toBe(100);
    expect(readChips(PLAYER)).toBe(100); // refunded once, by the other operator
    expect(readChips(OPERATOR)).toBe(10_000);
    expect(hasSlotEscrow(M1)).toBe(false);
  });

  it('drops a round another operator already refunded, without trying again', async () => {
    fund(M1);
    await requestSpin(M1);
    const ready = becomeOperator([M1]);
    await acceptsDone();
    const first = readSlotMachineState(M1)!;
    expect(refundSlotWager(M1, PLAYER, BET, { mode: 'owner', ownerId: OPERATOR })).toBe(true);
    const refunded = { ...first, phase: 'settled' as const, credited: 0, failure: 'invalid-house-commit' as const };
    writeSlotMachineState(M1, refunded);
    tickSlotMachineRoom([M1], false, at(ready + 100));
    await acceptsDone();
    expect(slotRoundsInHand()).toBe(0);
    expect(readSlotMachineState(M1)).toEqual(refunded);
    expect(readChips(PLAYER)).toBe(100);
    expect(readChips(OPERATOR)).toBe(10_000);
  });
});

// ── By hand (venture rooms) ──────────────────────────────────────────────────

describe('running machines by hand', () => {
  beforeEach(() => setSoleCroupierPredicate(() => false));

  it('RUN takes the room lease at once and operates only the machines started here', async () => {
    fund(M1);
    fund(M2);
    await requestSpin(M1);
    await requestSpin(M2);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0))).toBe(true);
    expect(readSlotOperatorLease()?.sessionId).toBe(slotOperatorSession());
    expect(isManualSlotMachineRunning(M1, OPERATOR)).toBe(true);
    expect(isManualSlotMachineRunning(M2, OPERATOR)).toBe(false);
    tickSlotMachineRoom([M1, M2], true, at(T0 + SETTLE_MS));
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    expect(spinning(M2)).toBe(false);
  });

  it('keeps running a machine by hand across a lapse of its own lease, and takes the lease again', () => {
    fund(M1);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0))).toBe(true);
    tickSlotMachineRoom([M1], true, at(T0 + SETTLE_MS));
    // No frames for a while (a background tab): its own lease lapses.
    tickSlotMachineRoom([M1], true, at(T0 + 20_000));
    expect(readSlotOperatorLease()).toBeNull();
    tickSlotMachineRoom([M1], true, at(T0 + 20_001));
    expect(readSlotOperatorLease()?.sessionId).toBe(slotOperatorSession());
    expect(isManualSlotMachineRunning(M1, OPERATOR)).toBe(true);
  });

  it('stops running a machine by hand once another session takes the lease, and leaves it stopped', () => {
    fund(M1);
    setManualSlotMachineRunning(M1, OPERATOR, true, at(T0));
    writeSlotOperatorLease(lease(T0 + LEASE_MS)); // another session took the room over
    tickSlotMachineRoom([M1], true, at(T0 + 100));
    expect(isManualSlotMachineRunning(M1, OPERATOR)).toBe(false);
    // Not taken back up when that session lets go: RUN is pressed again.
    doc.getMap('casino').delete(SLOT_OPERATOR_KEY);
    tickSlotMachineRoom([M1], true, at(T0 + 200));
    expect(readSlotOperatorLease()).toBeNull();
  });

  it('STOP lets the lease go on the next frame once no machine is run here', () => {
    fund(M1);
    setManualSlotMachineRunning(M1, OPERATOR, true, at(T0));
    expect(setManualSlotMachineRunning(M1, OPERATOR, false, at(T0 + 10))).toBe(true);
    tickSlotMachineRoom([M1], true, at(T0 + 20));
    expect(readSlotOperatorLease()).toBeNull();
  });

  it("RUN is refused while another session operates the room's slots, or for another's bankroll", () => {
    fund(M1);
    fund(M2, OTHER);
    expect(setManualSlotMachineRunning(M2, OPERATOR, true, at(T0))).toBe(false);
    writeSlotOperatorLease(lease(T0 + LEASE_MS, 'other-device:tab', OTHER));
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0))).toBe(false);
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab');
  });

  it('stops running them when this client may no longer edit the room, refunding a round in flight', async () => {
    fund(M1);
    await requestSpin(M1);
    setManualSlotMachineRunning(M1, OPERATOR, true, at(T0));
    tickSlotMachineRoom([M1], true, at(T0 + SETTLE_MS));
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    tickSlotMachineRoom([M1], false, at(T0 + SETTLE_MS + 100));
    await acceptsDone();
    expect(isManualSlotMachineRunning(M1, OPERATOR)).toBe(false);
    expect(readChips(PLAYER)).toBe(100);
    tickSlotMachineRoom([M1], false, at(T0 + SETTLE_MS + 200));
    expect(readSlotOperatorLease()).toBeNull();
  });
});

// ── Earlier builds ───────────────────────────────────────────────────────────

describe("earlier builds' per-machine leases", () => {
  const legacyKey = `slot-operator:${M1}`;
  const legacy = (expiresAt: number): SlotOperatorLease => ({
    playerId: OPERATOR,
    sessionId: 'a'.repeat(64), // an earlier build's session id
    expiresAt,
  });

  it('keep this build off every machine in the room while one is being renewed', async () => {
    fund(M1);
    fund(M2);
    await requestSpin(M2);
    const map = doc.getMap('casino');
    for (let t = T0; t <= T0 + 20_000; t += 1_000) {
      if ((t - T0) % 3_000 === 0) map.set(legacyKey, legacy(t + LEASE_MS));
      tickSlotMachineRoom([M1, M2], false, at(t));
    }
    await acceptsDone();
    expect(readSlotOperatorLease()).toBeNull();
    expect(spinning(M2)).toBe(false);
    setSoleCroupierPredicate(() => false);
    expect(setManualSlotMachineRunning(M2, OPERATOR, true, at(T0 + 20_000))).toBe(false);
  });

  it('once lapsed, are deleted by a session that could operate, which then takes the room', () => {
    fund(M1);
    doc.getMap('casino').set(legacyKey, legacy(T0 + LEASE_MS));
    tickSlotMachineRoom([M1], false, at(T0));
    expect(readSlotOperatorLease()).toBeNull();
    tickSlotMachineRoom([M1], false, at(T0 + LEASE_MS));
    expect(doc.getMap('casino').has(legacyKey)).toBe(false);
    expect(readSlotOperatorLease()?.sessionId).toBe(slotOperatorSession());
  });

  it('are never deleted by a visitor', () => {
    setSoleCroupierPredicate(() => false);
    fund(M1);
    doc.getMap('casino').set(legacyKey, legacy(T0 + LEASE_MS));
    tickSlotMachineRoom([M1], false, at(T0));
    tickSlotMachineRoom([M1], false, at(T0 + 60_000));
    expect(doc.getMap('casino').has(legacyKey)).toBe(true);
  });

  it('are never written by this build', async () => {
    fund(M1);
    await requestSpin(M1);
    becomeOperator([M1]);
    await acceptsDone();
    expect(spinning(M1)).toBe(true);
    const keys = [...doc.getMap('casino').keys()].filter((k) => k.startsWith('slot-operator'));
    expect(keys).toEqual([SLOT_OPERATOR_KEY]);
  });

  it('refuse RUN when one is renewed after the last room tick, before the click', () => {
    setSoleCroupierPredicate(() => false);
    fund(M1);
    fund(M2);
    tickSlotMachineRoom([M1, M2], true, at(T0)); // no earlier build here yet
    // An earlier build takes machine 1 up between that frame and a click on machine 2.
    doc.getMap('casino').set(legacyKey, legacy(T0 + LEASE_MS));
    expect(setManualSlotMachineRunning(M2, OPERATOR, true, at(T0 + 10))).toBe(false);
    expect(readSlotOperatorLease()).toBeNull();
    expect(isManualSlotMachineRunning(M2, OPERATOR)).toBe(false);
    // Not renewed again: RUN works once it has lapsed.
    expect(setManualSlotMachineRunning(M2, OPERATOR, true, at(T0 + 10 + LEASE_MS))).toBe(true);
  });

  it("refuse RUN on a machine no room tick has seen yet, while that machine's is renewed", () => {
    setSoleCroupierPredicate(() => false);
    fund(M1);
    doc.getMap('casino').set(legacyKey, legacy(T0 + LEASE_MS));
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0))).toBe(false);
    expect(readSlotOperatorLease()).toBeNull();
  });
});

// ── Leaving ──────────────────────────────────────────────────────────────────

describe('leaving the room', () => {
  it('releases the lease, then operates and watches nothing there until another doc is bound', async () => {
    fund(M1);
    becomeOperator([M1]);
    leaveSlotMachineRoom();
    expect(readSlotOperatorLease()).toBeNull();
    await requestSpin(M1);
    tickSlotMachineRoom([M1], false, at(T0 + 10_000));
    await acceptsDone();
    expect(readSlotOperatorLease()).toBeNull();
    expect(spinning(M1)).toBe(false);
    expect(slotOperatorWatchCount()).toBe(0);
    setSoleCroupierPredicate(() => false);
    expect(setManualSlotMachineRunning(M1, OPERATOR, true, at(T0 + 10_000))).toBe(false);

    // The next room's doc lifts it.
    setSoleCroupierPredicate(() => true);
    bindCasinoDoc(new Y.Doc());
    fund(M1);
    tickSlotMachineRoom([M1], false, at(T0 + 20_000));
    expect(readSlotOperatorLease()?.sessionId).toBe(slotOperatorSession());
  });

  it('forgets what it watched in the room', () => {
    fund(M1);
    writeSlotOperatorLease(lease(T0 + LEASE_MS));
    doc.getMap('casino').set(`slot-operator:${M2}`, {
      playerId: OPERATOR, sessionId: 'b'.repeat(64), expiresAt: T0 + LEASE_MS,
    });
    tickSlotMachineRoom([M1, M2], false, at(T0));
    expect(slotOperatorWatchCount()).toBe(2); // the room's lease + an earlier build's
    leaveSlotMachineRoom();
    expect(slotOperatorWatchCount()).toBe(0);
  });

  it("releasing leaves another session's lease alone", () => {
    writeSlotOperatorLease(lease(T0 + LEASE_MS));
    releaseSlotOperatorLease();
    expect(readSlotOperatorLease()?.sessionId).toBe('other-device:tab');
  });
});
