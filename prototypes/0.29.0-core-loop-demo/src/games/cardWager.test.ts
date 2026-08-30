// 🃏🎰 CARD WAGER (#45) — chip-escrow tests.
//
// TESTED HERE:
//   1. Pure shape guards accept well-formed values and reject every
//      class of malformed hostile-peer payload.
//   2. The pure conservation helper is arithmetic-correct and detects
//      leaks / double-credits.
//   3. Round-trip on a live Y.Doc: two players pay in, owner begins
//      the match, owner settles → winner is credited the whole pot,
//      escrow keys are gone, config is gone, conservation still balances.
//   4. HOSTILE-PEER posture: non-owner cannot settle, non-owner cannot
//      activate, non-participant cannot pay for someone else, malformed
//      records are refused shape-first, non-participant cannot refund.
//   5. STATE-MACHINE discipline: self-refund locked after BEGIN;
//      owner-abandonment refund works pre-and-post BEGIN; second settle
//      is a no-op (no double-credit).
//   6. FAILED settle leaves state untouched (partial-write drain test):
//      a settle attempt that fails the precondition wall must NOT have
//      credited the winner nor deleted the escrow records.
//   7. CONCURRENT-DIVERGENCE: two Y.Docs each pay their own player,
//      merge via encodeStateAsUpdate / applyUpdate, and both sides
//      converge to identical map contents (LWW + per-key single-writer
//      discipline holds).
//   8. TWO-PLAYER CONFIRM GATE (#45 ack slice): settle pays out only
//      when BOTH payers countersigned the SAME fresh result — spectator
//      acks, pre-start acks, outsider winners, stale / mis-bound /
//      kind-mismatched acks, and disputes all hold the pot in escrow.
//   9. RE-STAMP GUARDS: identical re-stamp stays legal (crash retry);
//      term changes freeze while chips are escrowed; every re-stamp is
//      locked while a match is live.
//  10. PER-KIND FLOORS: poker's buy-in floor is 20 (2 × the engine big
//      blind) so escrowed chips always cover the seated stacks; war
//      keeps the absolute floor.

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  MIN_CARD_WAGER_BUY_IN, MAX_CARD_WAGER_BUY_IN, POKER_MIN_WAGER_BUY_IN,
  minCardWagerBuyIn, deriveHeadsUpWinner,
  cardWagerEscrowKey, cardWagerAckKey,
  isCardWagerConfig, isCardWagerRecord, isCardWagerAck,
  isCardWagerConservationBalanced, filterConformingHeld,
  type CardWagerConfig, type CardWagerRecord, type CardWagerAck,
} from './cardWager';
import {
  bindCasinoDoc, buyInChips, readChips,
  stampCardWagerConfig, readCardWagerConfig,
  payCardWager, readCardWagerEscrow, scanCardWagerEscrow,
  activateCardWager, refundCardWager, settleCardWager,
  clearCardWagerKeys,
  readCardWagerAck, ackCardWagerResult, readAgreedCardWagerResult,
} from '../casinoDoc';

// ── Helpers ─────────────────────────────────────────────────────────────────

const OWNER = 'owner_alice';
const P1 = 'alice';
const P2 = 'bob';
const P3 = 'chris';
const TABLE = 'table-A';
const BUY_IN = 25;

let lastBoundDoc: Y.Doc | null = null;

function freshDoc(): Y.Doc {
  const doc = new Y.Doc();
  bindCasinoDoc(doc);
  lastBoundDoc = doc;
  return doc;
}

/** Raw access to the currently-bound casino map (test-only — hostile-peer
 *  simulations plant malformed values directly under a key). Production
 *  code MUST NOT reach into the map directly. */
function getBoundCasino(): Y.Map<unknown> {
  if (!lastBoundDoc) throw new Error('freshDoc() has not been called in this test');
  return lastBoundDoc.getMap('casino') as Y.Map<unknown>;
}

/** Sum of all `held` escrow records on the doc for a table. */
function sumHeld(tableId: string): number {
  return scanCardWagerEscrow(tableId).reduce((s, r) => s + r.amount, 0);
}

/** Total chip supply visible on the casino map = Σ bal:<*> + Σ held. */
function totalChips(doc: Y.Doc, tableId: string): number {
  let bals = 0;
  const map = doc.getMap('casino') as Y.Map<unknown>;
  for (const [k, v] of map.entries()) {
    if (k.startsWith('bal:') && typeof v === 'number') bals += v;
  }
  return bals + sumHeld(tableId);
}

/** Both payers countersign `winner` — the standard unlock for a settle
 *  behind the #45 two-player confirm gate. */
function ackBoth(winner: string | 'split', atMs = 9_000): void {
  expect(ackCardWagerResult(P1, TABLE, winner, atMs)).toBe(true);
  expect(ackCardWagerResult(P2, TABLE, winner, atMs + 1)).toBe(true);
}

/** Stamp → both pay → BEGIN, the standard live-match fixture (startedAt
 *  lands at 4 — several freshness tests key on that value). */
function setupLiveMatch(): void {
  buyInChips(P1, 100);
  buyInChips(P2, 100);
  expect(stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1)).toBe(true);
  expect(payCardWager(P1, TABLE, P1, 2)).toBe(true);
  expect(payCardWager(P2, TABLE, P2, 3)).toBe(true);
  expect(activateCardWager(OWNER, TABLE, 4)).toBe(true);
}

// ── Shape guards ────────────────────────────────────────────────────────────

describe('isCardWagerConfig', () => {
  const good: CardWagerConfig = {
    kind: 'poker', buyIn: 50, ownerId: OWNER,
    createdAt: 1_000, startedAt: null,
  };

  it('accepts a well-formed config', () => {
    expect(isCardWagerConfig(good)).toBe(true);
    expect(isCardWagerConfig({ ...good, startedAt: 2_000 })).toBe(true);
    expect(isCardWagerConfig({ ...good, kind: 'war' })).toBe(true);
  });

  it('rejects the null/wrong-type roots', () => {
    expect(isCardWagerConfig(null)).toBe(false);
    expect(isCardWagerConfig(undefined)).toBe(false);
    expect(isCardWagerConfig('cfg')).toBe(false);
    expect(isCardWagerConfig(42)).toBe(false);
    expect(isCardWagerConfig([])).toBe(false);
  });

  it('rejects unknown / stringly-typed kinds', () => {
    expect(isCardWagerConfig({ ...good, kind: 'solitaire' })).toBe(false);
    expect(isCardWagerConfig({ ...good, kind: '' })).toBe(false);
    // Prototype-poisoned kind field: strict enum membership blocks it.
    expect(isCardWagerConfig({ ...good, kind: undefined })).toBe(false);
  });

  it('rejects out-of-range buy-in', () => {
    expect(isCardWagerConfig({ ...good, buyIn: 0 })).toBe(false);
    expect(isCardWagerConfig({ ...good, buyIn: -1 })).toBe(false);
    expect(isCardWagerConfig({ ...good, buyIn: 1.5 })).toBe(false);
    expect(isCardWagerConfig({ ...good, buyIn: MAX_CARD_WAGER_BUY_IN + 1 })).toBe(false);
    expect(isCardWagerConfig({ ...good, buyIn: Number.NaN })).toBe(false);
  });

  it('rejects empty/wrong-type owner id', () => {
    expect(isCardWagerConfig({ ...good, ownerId: '' })).toBe(false);
    expect(isCardWagerConfig({ ...good, ownerId: 42 as unknown as string })).toBe(false);
    expect(isCardWagerConfig({ ...good, ownerId: null as unknown as string })).toBe(false);
  });

  it('rejects bad timestamps', () => {
    expect(isCardWagerConfig({ ...good, createdAt: -1 })).toBe(false);
    expect(isCardWagerConfig({ ...good, createdAt: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isCardWagerConfig({ ...good, createdAt: Number.NaN })).toBe(false);
    // startedAt: null OR a finite non-negative number, nothing else.
    expect(isCardWagerConfig({ ...good, startedAt: -1 })).toBe(false);
    expect(isCardWagerConfig({ ...good, startedAt: 'yes' as unknown as number })).toBe(false);
  });
});

describe('isCardWagerRecord', () => {
  const good: CardWagerRecord = {
    kind: 'poker', amount: 25, ownerId: OWNER,
    playerId: P1, paidAt: 500, state: 'held',
  };

  it('accepts a well-formed record', () => {
    expect(isCardWagerRecord(good)).toBe(true);
    expect(isCardWagerRecord({ ...good, kind: 'war' })).toBe(true);
  });

  it('rejects roots that are not plain objects', () => {
    expect(isCardWagerRecord(null)).toBe(false);
    expect(isCardWagerRecord('record')).toBe(false);
    expect(isCardWagerRecord(0)).toBe(false);
  });

  it('rejects unknown kinds and states', () => {
    expect(isCardWagerRecord({ ...good, kind: 'blackjack' })).toBe(false);
    expect(isCardWagerRecord({ ...good, state: 'paid' })).toBe(false);
    expect(isCardWagerRecord({ ...good, state: '' })).toBe(false);
  });

  it('rejects out-of-range amount', () => {
    expect(isCardWagerRecord({ ...good, amount: 0 })).toBe(false);
    expect(isCardWagerRecord({ ...good, amount: -25 })).toBe(false);
    expect(isCardWagerRecord({ ...good, amount: 1.7 })).toBe(false);
    expect(isCardWagerRecord({ ...good, amount: MAX_CARD_WAGER_BUY_IN + 1 })).toBe(false);
  });

  it('rejects empty owner / player ids', () => {
    expect(isCardWagerRecord({ ...good, ownerId: '' })).toBe(false);
    expect(isCardWagerRecord({ ...good, playerId: '' })).toBe(false);
    expect(isCardWagerRecord({ ...good, playerId: {} as unknown as string })).toBe(false);
  });

  it('rejects non-finite paidAt', () => {
    expect(isCardWagerRecord({ ...good, paidAt: -1 })).toBe(false);
    expect(isCardWagerRecord({ ...good, paidAt: Number.NaN })).toBe(false);
    expect(isCardWagerRecord({ ...good, paidAt: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('isCardWagerAck', () => {
  const good: CardWagerAck = {
    kind: 'poker', playerId: P1, winnerId: P2,
    matchStartedAt: 2_000, ackedAt: 3_000,
  };

  it('accepts a well-formed ack (payer winner or the split sentinel)', () => {
    expect(isCardWagerAck(good)).toBe(true);
    expect(isCardWagerAck({ ...good, winnerId: 'split' })).toBe(true);
    expect(isCardWagerAck({ ...good, kind: 'war' })).toBe(true);
    expect(isCardWagerAck({ ...good, matchStartedAt: 0 })).toBe(true);
  });

  it('rejects roots that are not plain objects', () => {
    expect(isCardWagerAck(null)).toBe(false);
    expect(isCardWagerAck(undefined)).toBe(false);
    expect(isCardWagerAck('ack')).toBe(false);
    expect(isCardWagerAck(7)).toBe(false);
    expect(isCardWagerAck([])).toBe(false);
  });

  it('rejects unknown / missing kinds', () => {
    expect(isCardWagerAck({ ...good, kind: 'blackjack' })).toBe(false);
    expect(isCardWagerAck({ ...good, kind: undefined })).toBe(false);
    expect(isCardWagerAck({ ...good, kind: '' })).toBe(false);
  });

  it('rejects empty / wrong-type ids', () => {
    expect(isCardWagerAck({ ...good, playerId: '' })).toBe(false);
    expect(isCardWagerAck({ ...good, playerId: 9 as unknown as string })).toBe(false);
    expect(isCardWagerAck({ ...good, winnerId: '' })).toBe(false);
    expect(isCardWagerAck({ ...good, winnerId: null as unknown as string })).toBe(false);
  });

  it('rejects bad timestamps', () => {
    expect(isCardWagerAck({ ...good, matchStartedAt: -1 })).toBe(false);
    expect(isCardWagerAck({ ...good, matchStartedAt: Number.NaN })).toBe(false);
    expect(isCardWagerAck({ ...good, matchStartedAt: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isCardWagerAck({ ...good, matchStartedAt: 'now' as unknown as number })).toBe(false);
    expect(isCardWagerAck({ ...good, ackedAt: -1 })).toBe(false);
    expect(isCardWagerAck({ ...good, ackedAt: Number.NaN })).toBe(false);
  });
});

// ── Conservation invariant helpers ──────────────────────────────────────────

describe('isCardWagerConservationBalanced', () => {
  it('holds when held + paid-out + refunded == paid-in', () => {
    expect(isCardWagerConservationBalanced({
      sumHeld: 50, sumPaidOut: 0, sumRefunded: 0, sumPaidIn: 50,
    })).toBe(true);
    expect(isCardWagerConservationBalanced({
      sumHeld: 0, sumPaidOut: 50, sumRefunded: 0, sumPaidIn: 50,
    })).toBe(true);
    expect(isCardWagerConservationBalanced({
      sumHeld: 25, sumPaidOut: 0, sumRefunded: 25, sumPaidIn: 50,
    })).toBe(true);
  });

  it('detects a drain (paid-in > escrow + payouts + refunds)', () => {
    expect(isCardWagerConservationBalanced({
      sumHeld: 0, sumPaidOut: 25, sumRefunded: 0, sumPaidIn: 50,
    })).toBe(false);
  });

  it('detects a double-credit (payouts + refunds > paid-in)', () => {
    expect(isCardWagerConservationBalanced({
      sumHeld: 0, sumPaidOut: 75, sumRefunded: 0, sumPaidIn: 50,
    })).toBe(false);
  });

  it('holds on the empty case', () => {
    expect(isCardWagerConservationBalanced({
      sumHeld: 0, sumPaidOut: 0, sumRefunded: 0, sumPaidIn: 0,
    })).toBe(true);
  });
});

describe('filterConformingHeld', () => {
  const goodA: CardWagerRecord = {
    kind: 'poker', amount: 25, ownerId: OWNER, playerId: P1,
    paidAt: 1, state: 'held',
  };
  const goodB: CardWagerRecord = { ...goodA, playerId: P2 };
  const wrongAmount: CardWagerRecord = { ...goodA, playerId: P3, amount: 999_999 };

  it('drops records whose amount does not match the configured buy-in', () => {
    const out = filterConformingHeld([goodA, goodB, wrongAmount], 25);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.playerId).sort()).toEqual([P1, P2]);
  });

  it('is empty when nothing conforms', () => {
    expect(filterConformingHeld([wrongAmount], 25)).toHaveLength(0);
  });
});

describe('deriveHeadsUpWinner', () => {
  it('the seat holding all the chips wins', () => {
    expect(deriveHeadsUpWinner({ id: P1, stack: 50 }, { id: P2, stack: 0 })).toBe(P1);
    expect(deriveHeadsUpWinner({ id: P1, stack: 0 }, { id: P2, stack: 50 })).toBe(P2);
  });

  it('both seats still holding chips → split', () => {
    expect(deriveHeadsUpWinner({ id: P1, stack: 25 }, { id: P2, stack: 25 })).toBe('split');
    expect(deriveHeadsUpWinner({ id: P1, stack: 1 }, { id: P2, stack: 999 })).toBe('split');
  });

  it('missing seat id → null (not derivable)', () => {
    expect(deriveHeadsUpWinner({ id: null, stack: 50 }, { id: P2, stack: 0 })).toBeNull();
    expect(deriveHeadsUpWinner({ id: P1, stack: 50 }, { id: null, stack: 0 })).toBeNull();
  });

  it('both stacks zero → null (mangled terminal state, never a payout)', () => {
    expect(deriveHeadsUpWinner({ id: P1, stack: 0 }, { id: P2, stack: 0 })).toBeNull();
  });
});

describe('minCardWagerBuyIn', () => {
  it('poker floor is 20 = 2 × the engine big blind; war keeps the absolute floor', () => {
    // beginPoker clamps startingStack to at least 2×bigBlind (poker.ts) —
    // a poker wager below 20 would seat stacks LARGER than the escrow.
    expect(POKER_MIN_WAGER_BUY_IN).toBe(20);
    expect(minCardWagerBuyIn('poker')).toBe(POKER_MIN_WAGER_BUY_IN);
    expect(minCardWagerBuyIn('war')).toBe(MIN_CARD_WAGER_BUY_IN);
  });
});

// ── End-to-end round trips on a live Y.Doc ──────────────────────────────────

describe('card wager escrow — pay/settle round trip', () => {
  beforeEach(() => { freshDoc(); });

  it('winner takes the pot; both records + config are deleted; balances conserve', () => {
    // Cage issues equal starting chips to both players.
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    const startingSupply = readChips(P1) + readChips(P2);

    // Owner stamps a poker wager with a $25 buy-in.
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1_000)).toBe(true);
    expect(readCardWagerConfig(TABLE)?.buyIn).toBe(BUY_IN);

    // Both players pay in.
    expect(payCardWager(P1, TABLE, P1, 1_001)).toBe(true);
    expect(payCardWager(P2, TABLE, P2, 1_002)).toBe(true);
    expect(readChips(P1)).toBe(75);
    expect(readChips(P2)).toBe(75);
    expect(sumHeld(TABLE)).toBe(BUY_IN * 2);

    // Owner begins the match.
    expect(activateCardWager(OWNER, TABLE, 2_000)).toBe(true);
    expect(readCardWagerConfig(TABLE)?.startedAt).toBe(2_000);

    // Both payers confirm the result, then the owner settles: P1 wins.
    ackBoth(P1);
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(true);
    expect(readChips(P1)).toBe(75 + BUY_IN * 2);
    expect(readChips(P2)).toBe(75);
    // Config, both escrow records, AND both acks are gone.
    expect(readCardWagerConfig(TABLE)).toBeNull();
    expect(readCardWagerEscrow(TABLE, P1)).toBeNull();
    expect(readCardWagerEscrow(TABLE, P2)).toBeNull();
    expect(readCardWagerAck(TABLE, P1)).toBeNull();
    expect(readCardWagerAck(TABLE, P2)).toBeNull();
    // Chip supply preserved: no minting, no burning.
    expect(readChips(P1) + readChips(P2)).toBe(startingSupply);
  });

  it('SPLIT tie returns each buy-in to its payer', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1_000);
    payCardWager(P1, TABLE, P1, 1_001);
    payCardWager(P2, TABLE, P2, 1_002);
    activateCardWager(OWNER, TABLE, 2_000);
    ackBoth('split');
    expect(settleCardWager(OWNER, TABLE, 'split')).toBe(true);
    expect(readChips(P1)).toBe(100);
    expect(readChips(P2)).toBe(100);
    expect(readCardWagerConfig(TABLE)).toBeNull();
  });

  it('war mode is accepted end-to-end (same escrow path, different kind)', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'war', 40, 1_000);
    expect(payCardWager(P1, TABLE, P1, 1)).toBe(true);
    expect(payCardWager(P2, TABLE, P2, 2)).toBe(true);
    expect(scanCardWagerEscrow(TABLE).every((r) => r.kind === 'war')).toBe(true);
    activateCardWager(OWNER, TABLE, 3);
    ackBoth(P2);
    settleCardWager(OWNER, TABLE, P2);
    expect(readChips(P2)).toBe(60 + 80);
  });

  it('self-refund BEFORE begin credits chips back and deletes the record', () => {
    buyInChips(P1, 50);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    expect(readChips(P1)).toBe(25);
    expect(refundCardWager(P1, TABLE, P1)).toBe(true);
    expect(readChips(P1)).toBe(50);
    expect(readCardWagerEscrow(TABLE, P1)).toBeNull();
  });

  it('OWNER-abandonment refund works even AFTER begin (stranded pay-in path)', () => {
    buyInChips(P1, 50);
    buyInChips(P2, 50);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    activateCardWager(OWNER, TABLE, 4);
    // P2 walked away — owner refunds both, then clears the table's wager keys.
    expect(refundCardWager(OWNER, TABLE, P1)).toBe(true);
    expect(refundCardWager(OWNER, TABLE, P2)).toBe(true);
    expect(readChips(P1)).toBe(50);
    expect(readChips(P2)).toBe(50);
    expect(clearCardWagerKeys(OWNER, TABLE)).toBe(true);
    expect(readCardWagerConfig(TABLE)).toBeNull();
  });

  it('is idempotent: a duplicate pay is a no-op; a duplicate settle refuses', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    expect(payCardWager(P1, TABLE, P1, 2)).toBe(true);
    // Second pay call at the same buyIn: crash-retry idempotency — no re-debit.
    expect(readChips(P1)).toBe(75);
    expect(payCardWager(P1, TABLE, P1, 2)).toBe(true);
    expect(readChips(P1)).toBe(75);
    payCardWager(P2, TABLE, P2, 3);
    activateCardWager(OWNER, TABLE, 4);
    ackBoth(P1);
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(true);
    // Second settle: config deleted → refuses. Cannot double-credit.
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(false);
    expect(readChips(P1)).toBe(75 + BUY_IN * 2);
  });
});

// ── HOSTILE-PEER posture ────────────────────────────────────────────────────

describe('card wager escrow — hostile-peer refusals', () => {
  beforeEach(() => { freshDoc(); });

  it('non-owner cannot settle', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    activateCardWager(OWNER, TABLE, 4);
    // P1 tries to settle in their own favor.
    expect(settleCardWager(P1, TABLE, P1)).toBe(false);
    // P2 tries too.
    expect(settleCardWager(P2, TABLE, P2)).toBe(false);
    // A completely unrelated bystander.
    expect(settleCardWager(P3, TABLE, P1)).toBe(false);
    // State is untouched: escrow still holds, chips still debited, config still present.
    expect(readCardWagerConfig(TABLE)).not.toBeNull();
    expect(sumHeld(TABLE)).toBe(BUY_IN * 2);
    expect(readChips(P1)).toBe(75);
  });

  it('non-owner cannot activate (stamp startedAt)', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    expect(activateCardWager(P1, TABLE, 4)).toBe(false);
    expect(readCardWagerConfig(TABLE)?.startedAt).toBeNull();
  });

  it('cannot pay for someone else (actor must equal payer)', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    // P2 tries to burn P1's chips into escrow.
    expect(payCardWager(P2, TABLE, P1, 2)).toBe(false);
    expect(readChips(P1)).toBe(100);
    expect(readCardWagerEscrow(TABLE, P1)).toBeNull();
  });

  it('non-participant cannot refund someone else', () => {
    buyInChips(P1, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    // A bystander cannot yank P1's escrow.
    expect(refundCardWager(P3, TABLE, P1)).toBe(false);
    expect(readCardWagerEscrow(TABLE, P1)).not.toBeNull();
  });

  it('self-refund is BLOCKED once startedAt is stamped', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    activateCardWager(OWNER, TABLE, 4);
    // P1 tries to grab their chips back mid-match: refused.
    expect(refundCardWager(P1, TABLE, P1)).toBe(false);
    // Owner still can (abandonment path).
    expect(refundCardWager(OWNER, TABLE, P1)).toBe(true);
    expect(readChips(P1)).toBe(100);
  });

  it('malformed escrow record reads as absent and blocks activate/settle', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);

    // A hostile peer plants a garbled record under P2's escrow key —
    // reach in via the test-only raw-map accessor.
    const casinoMap = getBoundCasino();
    casinoMap.set(cardWagerEscrowKey(TABLE, P2), { kind: 'poker', amount: 'lots' });

    // scan / read: malformed record is filtered out.
    expect(readCardWagerEscrow(TABLE, P2)).toBeNull();
    expect(scanCardWagerEscrow(TABLE).map((r) => r.playerId)).toEqual([P1]);

    // Activate refuses (fewer than 2 well-formed records).
    expect(activateCardWager(OWNER, TABLE, 3)).toBe(false);
    // And settle can't even run.
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(false);

    // Owner can clear the hostile write (owner-only malformed cleanup).
    expect(refundCardWager(OWNER, TABLE, P2)).toBe(true);
    // Cleared record: subsequent read is null.
    expect(readCardWagerEscrow(TABLE, P2)).toBeNull();
  });

  it('a well-formed HOSTILE third record blocks every settle path', () => {
    // A hostile peer that writes directly to the map bypasses payCardWager
    // (their balance is NOT debited). Without the "exactly 2" check the
    // winner would be credited a 3×BUY_IN pot even though only 2×BUY_IN
    // came out of real balances — a straight chip mint. This test locks
    // in the "exactly 2" refuse-and-sweep discipline.
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    activateCardWager(OWNER, TABLE, 4);
    // Both real payers have already confirmed — the forged record must
    // STILL block settle (the refusal is structural, not ack-driven).
    ackBoth(P1);

    // Plant a THIRD well-formed record under a bystander id.
    const casinoMap = getBoundCasino();
    const forged: CardWagerRecord = {
      kind: 'poker', amount: BUY_IN, ownerId: OWNER, playerId: P3,
      paidAt: 5, state: 'held',
    };
    casinoMap.set(cardWagerEscrowKey(TABLE, P3), forged);

    // Split path refuses.
    expect(settleCardWager(OWNER, TABLE, 'split')).toBe(false);
    // Winner-take-pot path also refuses (records.length === 3 ≠ 2).
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(false);
    // No chip mint: real payers' balances are unchanged.
    expect(readChips(P1)).toBe(75);
    expect(readChips(P2)).toBe(75);

    // Owner sweep of the forged record: `clearCardWagerKeys` cannot
    // target a single record without wiping the whole table, so tests
    // simulate the direct-delete path here (in production, the owner
    // would refund BOTH legitimate payers and then clearCardWagerKeys).
    // Directly wiping the forged key returns the escrow to the 2-record
    // heads-up shape and settle succeeds — the point of the assertion.
    casinoMap.delete(cardWagerEscrowKey(TABLE, P3));
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(true);
    expect(readChips(P1)).toBe(75 + BUY_IN * 2);
  });

  it('out-of-range buy-in is refused at config stamp time (per-kind floors)', () => {
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', 0, 1)).toBe(false);
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', -5, 1)).toBe(false);
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', 1.5, 1)).toBe(false);
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', MAX_CARD_WAGER_BUY_IN + 1, 1)).toBe(false);
    // Poker's floor is 20 (2 × the engine big blind): a 19-chip buy-in
    // would seat stacks LARGER than the escrowed pot (beginPoker clamps
    // startingStack up to 2×bigBlind), so it is refused at the boundary.
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', POKER_MIN_WAGER_BUY_IN - 1, 1)).toBe(false);
    // War has no blind structure — the absolute floor still applies.
    expect(stampCardWagerConfig(OWNER, TABLE, 'war', MIN_CARD_WAGER_BUY_IN, 1)).toBe(true);
    clearCardWagerKeys(OWNER, TABLE);
    // Per-kind floor and the shared MAX are inclusive.
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', POKER_MIN_WAGER_BUY_IN, 1)).toBe(true);
    clearCardWagerKeys(OWNER, TABLE);
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', MAX_CARD_WAGER_BUY_IN, 2)).toBe(true);
  });
});

// ── FAILED settle leaves state untouched (drain safety) ─────────────────────

describe('card wager escrow — failed settle does not drain', () => {
  beforeEach(() => { freshDoc(); });

  it('settle refused for missing/wrong winner does not touch escrow or balances', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    activateCardWager(OWNER, TABLE, 4);
    // Both payers agree on P1 — isolates the WRONG-WINNER refusal from
    // the missing-ack refusal.
    ackBoth(P1);

    // Snapshot pre-state.
    const preP1 = readChips(P1);
    const preP2 = readChips(P2);
    const preHeld = sumHeld(TABLE);
    const preCfg = readCardWagerConfig(TABLE);

    // winnerId not a payer → refused; winnerId a payer but NOT the
    // agreed result → also refused (ack-gate mismatch).
    expect(settleCardWager(OWNER, TABLE, P3)).toBe(false);
    expect(settleCardWager(OWNER, TABLE, P2)).toBe(false);
    expect(settleCardWager(OWNER, TABLE, 'split')).toBe(false);
    // Nothing changed — acks included.
    expect(readChips(P1)).toBe(preP1);
    expect(readChips(P2)).toBe(preP2);
    expect(sumHeld(TABLE)).toBe(preHeld);
    expect(readCardWagerConfig(TABLE)).toEqual(preCfg);
    expect(readCardWagerAck(TABLE, P1)).not.toBeNull();
    expect(readCardWagerAck(TABLE, P2)).not.toBeNull();
  });

  it('settle refused before BEGIN does not touch escrow or balances', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    // startedAt still null.
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(false);
    expect(readChips(P1)).toBe(75);
    expect(readChips(P2)).toBe(75);
    expect(sumHeld(TABLE)).toBe(BUY_IN * 2);
    expect(readCardWagerConfig(TABLE)).not.toBeNull();
  });

  it('conservation holds across every path (pay/refund/settle)', () => {
    const doc = freshDoc();
    buyInChips(P1, 200);
    buyInChips(P2, 200);
    const supply = totalChips(doc, TABLE);

    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    expect(totalChips(doc, TABLE)).toBe(supply);
    payCardWager(P2, TABLE, P2, 3);
    expect(totalChips(doc, TABLE)).toBe(supply);
    activateCardWager(OWNER, TABLE, 4);
    expect(totalChips(doc, TABLE)).toBe(supply);
    ackBoth(P1);
    expect(totalChips(doc, TABLE)).toBe(supply);
    settleCardWager(OWNER, TABLE, P1);
    expect(totalChips(doc, TABLE)).toBe(supply);

    // A refund-flavored round-trip on a fresh table also conserves.
    stampCardWagerConfig(OWNER, 'table-B', 'poker', BUY_IN, 5);
    payCardWager(P2, 'table-B', P2, 6);
    expect(totalChips(doc, 'table-B')).toBe(supply);
    refundCardWager(P2, 'table-B', P2);
    expect(totalChips(doc, 'table-B')).toBe(supply);
  });
});

// ── CONCURRENT-DIVERGENCE (two-doc merge) ───────────────────────────────────

describe('card wager escrow — concurrent divergence', () => {
  it('two peers paying their own escrow keys converge on merge (per-key single writer)', () => {
    // Doc A: owner stamps config; P1 pays their escrow.
    const docA = new Y.Doc();
    bindCasinoDoc(docA);
    buyInChips(P1, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    const updateA = Y.encodeStateAsUpdate(docA);

    // Doc B: peer starts fresh, sees A's state, then P2 pays their escrow.
    const docB = new Y.Doc();
    bindCasinoDoc(docB);
    Y.applyUpdate(docB, updateA);
    buyInChips(P2, 100);
    // On the fresh side, the owner's config and P1's escrow record are visible.
    expect(readCardWagerConfig(TABLE)?.buyIn).toBe(BUY_IN);
    expect(readCardWagerEscrow(TABLE, P1)).not.toBeNull();
    payCardWager(P2, TABLE, P2, 3);
    const updateB = Y.encodeStateAsUpdate(docB);

    // Merge B's changes back into A.
    bindCasinoDoc(docA);
    Y.applyUpdate(docA, updateB);

    // Both sides now see both escrow records and identical config.
    expect(scanCardWagerEscrow(TABLE).map((r) => r.playerId).sort()).toEqual([P1, P2]);
    // Owner can now activate; both payers confirm; owner settles — all
    // deterministic on the merged doc.
    expect(activateCardWager(OWNER, TABLE, 4)).toBe(true);
    ackBoth(P1);
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(true);
    expect(readChips(P1)).toBe(75 + BUY_IN * 2);
    expect(readChips(P2)).toBe(75);
    // Also verify state converges: encode A after settle, apply to B.
    bindCasinoDoc(docB);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(readCardWagerConfig(TABLE)).toBeNull();
    expect(readCardWagerEscrow(TABLE, P1)).toBeNull();
    expect(readCardWagerEscrow(TABLE, P2)).toBeNull();
    expect(readCardWagerAck(TABLE, P1)).toBeNull();
    expect(readCardWagerAck(TABLE, P2)).toBeNull();
  });
});

// ── TWO-PLAYER CONFIRM GATE (#45 ack slice) ─────────────────────────────────

describe('ackCardWagerResult — write-side refusals', () => {
  beforeEach(() => { freshDoc(); });

  it('spectator (no escrow record) cannot ack', () => {
    setupLiveMatch();
    expect(ackCardWagerResult(P3, TABLE, P1, 5)).toBe(false);
    expect(readCardWagerAck(TABLE, P3)).toBeNull();
  });

  it('cannot ack before BEGIN (there is no result to confirm yet)', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    // startedAt still null.
    expect(ackCardWagerResult(P1, TABLE, P1, 5)).toBe(false);
    expect(readCardWagerAck(TABLE, P1)).toBeNull();
  });

  it('winner must be a current payer or the split sentinel', () => {
    setupLiveMatch();
    expect(ackCardWagerResult(P1, TABLE, P3, 5)).toBe(false);
    expect(ackCardWagerResult(P1, TABLE, '', 5)).toBe(false);
    expect(ackCardWagerResult(P1, TABLE, 'split', 5)).toBe(true);
  });

  it('empty actor / non-finite time refused', () => {
    setupLiveMatch();
    expect(ackCardWagerResult('', TABLE, P1, 5)).toBe(false);
    expect(ackCardWagerResult(P1, TABLE, P1, Number.NaN)).toBe(false);
    expect(ackCardWagerResult(P1, TABLE, P1, -1)).toBe(false);
  });

  it('records the config kind and the matchStartedAt freshness echo', () => {
    setupLiveMatch(); // activates at nowMs = 4
    expect(ackCardWagerResult(P1, TABLE, P1, 5)).toBe(true);
    const ack = readCardWagerAck(TABLE, P1);
    expect(ack).not.toBeNull();
    expect(ack!.playerId).toBe(P1);
    expect(ack!.kind).toBe('poker');
    expect(ack!.matchStartedAt).toBe(4);
    expect(ack!.ackedAt).toBe(5);
  });

  it('re-ack overwrites the own key (LWW — the dispute-resolution path)', () => {
    setupLiveMatch();
    expect(ackCardWagerResult(P1, TABLE, P1, 5)).toBe(true);
    expect(ackCardWagerResult(P1, TABLE, P2, 6)).toBe(true);
    const ack = readCardWagerAck(TABLE, P1);
    expect(ack!.winnerId).toBe(P2);
    expect(ack!.ackedAt).toBe(6);
  });
});

describe('readAgreedCardWagerResult — the settle gate\'s source of truth', () => {
  beforeEach(() => { freshDoc(); });

  it('null with no config / before BEGIN', () => {
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
  });

  it('null while either ack is missing; the winner id once both agree', () => {
    setupLiveMatch();
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
    ackCardWagerResult(P1, TABLE, P1, 5);
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
    ackCardWagerResult(P2, TABLE, P1, 6);
    expect(readAgreedCardWagerResult(TABLE)).toBe(P1);
  });

  it("'split' agreement round-trips", () => {
    setupLiveMatch();
    ackBoth('split');
    expect(readAgreedCardWagerResult(TABLE)).toBe('split');
  });

  it('null when the two acks disagree (DISPUTED), non-null again after a re-ack', () => {
    setupLiveMatch();
    ackCardWagerResult(P1, TABLE, P1, 5);
    ackCardWagerResult(P2, TABLE, P2, 6);
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
    // P2 concedes on a re-look: LWW re-ack resolves the dispute.
    ackCardWagerResult(P2, TABLE, P1, 7);
    expect(readAgreedCardWagerResult(TABLE)).toBe(P1);
  });

  it('null when an ack is STALE (matchStartedAt from a previous match)', () => {
    setupLiveMatch(); // startedAt = 4
    ackCardWagerResult(P1, TABLE, P1, 5);
    // Hostile replay: a well-formed ack for P2 minted against an older match.
    getBoundCasino().set(cardWagerAckKey(TABLE, P2), {
      kind: 'poker', playerId: P2, winnerId: P1,
      matchStartedAt: 999, ackedAt: 5,
    } satisfies CardWagerAck);
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
  });

  it("null when an ack sits under the WRONG key (peer-planted vote)", () => {
    setupLiveMatch();
    ackCardWagerResult(P1, TABLE, P1, 5);
    // A peer plants P1's ack payload under P2's key — the key/payload
    // playerId binding refuses it, so P2's "vote" was never cast.
    getBoundCasino().set(cardWagerAckKey(TABLE, P2), {
      kind: 'poker', playerId: P1, winnerId: P1,
      matchStartedAt: 4, ackedAt: 5,
    } satisfies CardWagerAck);
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
  });

  it('null when an ack kind mismatches the config kind', () => {
    setupLiveMatch();
    ackCardWagerResult(P1, TABLE, P1, 5);
    getBoundCasino().set(cardWagerAckKey(TABLE, P2), {
      kind: 'war', playerId: P2, winnerId: P1,
      matchStartedAt: 4, ackedAt: 5,
    } satisfies CardWagerAck);
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
  });

  it('null when the escrow set is not a clean heads-up pair', () => {
    setupLiveMatch();
    ackBoth(P1);
    expect(readAgreedCardWagerResult(TABLE)).toBe(P1);
    // A forged third record voids "both payers agree".
    getBoundCasino().set(cardWagerEscrowKey(TABLE, P3), {
      kind: 'poker', amount: BUY_IN, ownerId: OWNER, playerId: P3,
      paidAt: 5, state: 'held',
    } satisfies CardWagerRecord);
    expect(readAgreedCardWagerResult(TABLE)).toBeNull();
  });
});

describe('card wager settle — two-player confirm gate', () => {
  beforeEach(() => { freshDoc(); });

  it('settle refused until BOTH payers have confirmed', () => {
    setupLiveMatch();
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(false);
    ackCardWagerResult(P1, TABLE, P1, 5);
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(false);
    expect(sumHeld(TABLE)).toBe(BUY_IN * 2);
    ackCardWagerResult(P2, TABLE, P1, 6);
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(true);
    expect(readChips(P1)).toBe(75 + BUY_IN * 2);
  });

  it('the owner cannot pay out a result the payers did not agree on', () => {
    setupLiveMatch();
    ackBoth(P2);
    // Payers agreed on P2 — the owner cannot steer the pot to P1.
    expect(settleCardWager(OWNER, TABLE, P1)).toBe(false);
    expect(settleCardWager(OWNER, TABLE, 'split')).toBe(false);
    expect(settleCardWager(OWNER, TABLE, P2)).toBe(true);
    expect(readChips(P2)).toBe(75 + BUY_IN * 2);
  });

  it('activate sweeps stale acks left over from a previous match', () => {
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1);
    payCardWager(P1, TABLE, P1, 2);
    payCardWager(P2, TABLE, P2, 3);
    // A well-formed ack from an earlier round is still sitting on the key.
    getBoundCasino().set(cardWagerAckKey(TABLE, P1), {
      kind: 'poker', playerId: P1, winnerId: P1,
      matchStartedAt: 999, ackedAt: 1,
    } satisfies CardWagerAck);
    expect(readCardWagerAck(TABLE, P1)).not.toBeNull();
    expect(activateCardWager(OWNER, TABLE, 4)).toBe(true);
    // Swept at BEGIN — the freshness echo would refuse it anyway; the
    // sweep keeps dead keys from accumulating.
    expect(readCardWagerAck(TABLE, P1)).toBeNull();
  });

  it('clearCardWagerKeys sweeps acks on both the owner and recovery paths', () => {
    // Owner path: live match, both confirmed, owner aborts instead.
    setupLiveMatch();
    ackBoth(P1);
    expect(refundCardWager(OWNER, TABLE, P1)).toBe(true);
    expect(refundCardWager(OWNER, TABLE, P2)).toBe(true);
    expect(clearCardWagerKeys(OWNER, TABLE)).toBe(true);
    expect(readCardWagerAck(TABLE, P1)).toBeNull();
    expect(readCardWagerAck(TABLE, P2)).toBeNull();
    // Recovery path: an orphaned ack with NO owning config — anyone clears.
    getBoundCasino().set(cardWagerAckKey('table-orphan', P1), {
      kind: 'poker', playerId: P1, winnerId: P1,
      matchStartedAt: 1, ackedAt: 2,
    } satisfies CardWagerAck);
    expect(clearCardWagerKeys(P3, 'table-orphan')).toBe(true);
    expect(readCardWagerAck('table-orphan', P1)).toBeNull();
  });
});

// ── RE-STAMP GUARDS (#45 hardening) ─────────────────────────────────────────

describe('stampCardWagerConfig — re-stamp guards', () => {
  beforeEach(() => { freshDoc(); });

  it('identical re-stamp stays legal while un-started (crash-retry path)', () => {
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1)).toBe(true);
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 2)).toBe(true);
    expect(readCardWagerConfig(TABLE)?.createdAt).toBe(2);
  });

  it('changing terms is legal while nothing is escrowed', () => {
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', 25, 1)).toBe(true);
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', 30, 2)).toBe(true);
    expect(readCardWagerConfig(TABLE)?.buyIn).toBe(30);
    expect(stampCardWagerConfig(OWNER, TABLE, 'war', 40, 3)).toBe(true);
    expect(readCardWagerConfig(TABLE)?.kind).toBe('war');
  });

  it('ESCROW-FREEZE: terms cannot drift under an existing pay-in', () => {
    buyInChips(P1, 100);
    stampCardWagerConfig(OWNER, TABLE, 'poker', 25, 1);
    payCardWager(P1, TABLE, P1, 2);
    // Both the amount and the kind are frozen…
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', 30, 3)).toBe(false);
    expect(stampCardWagerConfig(OWNER, TABLE, 'war', 25, 3)).toBe(false);
    // …but an identical re-stamp (crash retry) still passes.
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', 25, 4)).toBe(true);
    expect(readCardWagerConfig(TABLE)?.buyIn).toBe(25);
    expect(readCardWagerConfig(TABLE)?.kind).toBe('poker');
  });

  it('LIVE-MATCH LOCK: no re-stamp of any shape once the match began', () => {
    setupLiveMatch();
    // A successful re-stamp here would reset startedAt to null and REOPEN
    // the self-refund window mid-match — refused, identical terms or not.
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 9)).toBe(false);
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', 30, 9)).toBe(false);
    expect(readCardWagerConfig(TABLE)?.startedAt).toBe(4);
  });

  it('non-owner cannot re-stamp an existing config', () => {
    expect(stampCardWagerConfig(OWNER, TABLE, 'poker', BUY_IN, 1)).toBe(true);
    expect(stampCardWagerConfig(P1, TABLE, 'poker', BUY_IN, 2)).toBe(false);
    expect(readCardWagerConfig(TABLE)?.ownerId).toBe(OWNER);
  });
});

