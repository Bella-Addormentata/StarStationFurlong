/**
 * Air hockey fee escrow tests — issue #115.
 *
 * The money lane (casinoDoc.ts `ah-fee:` / `ah-paid:` keys) exists to survive
 * concurrent divergence, so beyond the single-doc lifecycle these tests fork a
 * room doc into independent Y.Docs, run conflicting operations on each side,
 * merge both ways, and assert chips were neither minted nor destroyed — the
 * exact failure modes (concurrent pays clobbering the owner's balance,
 * concurrent refunds double-crediting) that killed the earlier direct-transfer
 * design.
 *
 * Technique: casinoDoc/gamesDoc are module singletons bound to one doc at a
 * time, so a "client" is simulated by re-binding both modules to that client's
 * fork before running its operations (the same bind pair main.ts performs per
 * join). Merges exchange full state updates both ways; Yjs guarantees the two
 * docs then converge to identical maps.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindCasinoDoc,
  buyInChips,
  clearAirHockeyKeys,
  finalizeAirHockeyFee,
  payAirHockeyFee,
  readAirHockeyFeeConfig,
  readAirHockeyPaidRecord,
  readCageLedger,
  readChips,
  refundAirHockeyFee,
  scanAirHockeyPaidRecords,
  sweepAirHockeyFees,
  writeAirHockeyFeeConfig,
} from './casinoDoc';
import { bindGamesDoc, clearTable, readAirHockey, writeGame } from './games/gamesDoc';
import {
  AH_MAX_FEE,
  airHockeyEscrowAction,
  claimSide,
  initialAirHockeyState,
  isAirHockeyPaidRecord,
  setReady,
  startIfReady,
  startPractice,
  type AirHockeyFeeConfig,
  type AirHockeyPaidRecord,
  type AirHockeyState,
} from './games/airHockey';

// Player ids mirror identity.ts's UUID alphabet (hex + hyphens, no ':') — the
// scan parser's key-splitting contract depends on that.
const OWNER = 'owner-0000-4000-8000-000000000001';
const P1 = 'payer-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const P2 = 'payer-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const TABLE = 'ah-table-1';

/** Bind BOTH module singletons to one doc — a simulated client "join". */
function bindRoom(doc: Y.Doc): void {
  bindCasinoDoc(doc);
  bindGamesDoc(doc);
}

/** Fresh room doc, optionally owner-claimed, with both modules bound to it. */
function makeRoom(owner: string | null = OWNER): Y.Doc {
  const doc = new Y.Doc();
  if (owner !== null) doc.getMap('roomInfo').set('owner', owner);
  bindRoom(doc);
  return doc;
}

/** Independent client: a full copy of the doc's current state. */
function forkDoc(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/** Sync two diverged docs both ways; afterwards their maps are identical. */
function mergeDocs(a: Y.Doc, b: Y.Doc): void {
  const fromA = Y.encodeStateAsUpdate(a);
  const fromB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, fromB);
  Y.applyUpdate(b, fromA);
}

/** Raw casino map of a doc — hostile-peer writes and low-level asserts. */
function rawCasino(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('casino');
}

function feeConfig(amount: number, enabled = true, ownerId = OWNER): AirHockeyFeeConfig {
  return { enabled, feeAmount: amount, ownerId };
}

/** Chips currently sitting in escrow records (for conservation asserts). */
function escrowTotal(): number {
  return scanAirHockeyPaidRecords().reduce((sum, e) => sum + e.record.amount, 0);
}

/** Conservation invariant: every issued chip is in a balance or in escrow. */
function expectConserved(): void {
  const ledger = readCageLedger();
  expect(ledger.outstanding + escrowTotal()).toBe(ledger.issued - ledger.cashed);
}

/** Doc-state helper: both players seated (side a = P1, side b = P2). */
function seatedState(): AirHockeyState {
  let s = initialAirHockeyState();
  s = claimSide(s, 'a', P1)!;
  s = claimSide(s, 'b', P2)!;
  return s;
}

// ── Config validation (owner-recipient binding) ──────────────────────────────

describe('fee config validation', () => {
  it('round-trips an owner-stamped config', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    expect(readAirHockeyFeeConfig(TABLE)).toEqual(feeConfig(50));
  });

  it('refuses to WRITE a config not stamped with the room owner', () => {
    const doc = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50, true, P1));
    expect(rawCasino(doc).get(`ah-fee:${TABLE}`)).toBeUndefined();
  });

  it('rejects on READ a hostile config naming a non-owner recipient', () => {
    // A hostile peer bypasses writeAirHockeyFeeConfig and plants a config
    // routing fees to itself; the validated read treats it as "no fee".
    const doc = makeRoom();
    doc.transact(() => rawCasino(doc).set(`ah-fee:${TABLE}`, feeConfig(50, true, P1)));
    buyInChips(P2, 200);
    expect(readAirHockeyFeeConfig(TABLE)).toBeNull();
    expect(payAirHockeyFee(TABLE, P2)).toBe(0);
    expect(readChips(P2)).toBe(200);
    expect(readAirHockeyPaidRecord(TABLE, P2)).toBeNull();
  });

  it('rejects a stale config after the room owner changes', () => {
    const doc = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    doc.getMap('roomInfo').set('owner', P1); // ownership moved on
    expect(readAirHockeyFeeConfig(TABLE)).toBeNull();
  });

  it('rejects every config when the room has no owner (offline / unclaimed)', () => {
    const doc = makeRoom(null);
    doc.transact(() => rawCasino(doc).set(`ah-fee:${TABLE}`, feeConfig(50)));
    buyInChips(P1, 200);
    expect(readAirHockeyFeeConfig(TABLE)).toBeNull();
    expect(payAirHockeyFee(TABLE, P1)).toBe(0);
    expect(readChips(P1)).toBe(200);
  });

  it('rejects malformed config shapes on read', () => {
    const doc = makeRoom();
    doc.transact(() =>
      rawCasino(doc).set(`ah-fee:${TABLE}`, { enabled: true, feeAmount: AH_MAX_FEE + 1, ownerId: OWNER }));
    expect(readAirHockeyFeeConfig(TABLE)).toBeNull();
  });
});

// ── Pay: self-debit + held record ────────────────────────────────────────────

describe('payAirHockeyFee', () => {
  it('debits the payer and creates a held record; the owner is untouched', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    expect(payAirHockeyFee(TABLE, P1)).toBe(50);
    expect(readChips(P1)).toBe(150);
    expect(readChips(OWNER)).toBe(0); // escrowed, not transferred
    expect(readAirHockeyPaidRecord(TABLE, P1))
      .toEqual({ amount: 50, ownerId: OWNER, state: 'held' });
    expectConserved();
  });

  it('returns 0 with no record when the fee is off, zero, or absent', () => {
    makeRoom();
    buyInChips(P1, 200);
    expect(payAirHockeyFee(TABLE, P1)).toBe(0); // no config at all
    writeAirHockeyFeeConfig(TABLE, feeConfig(50, false));
    expect(payAirHockeyFee(TABLE, P1)).toBe(0); // disabled
    writeAirHockeyFeeConfig(TABLE, feeConfig(0));
    expect(payAirHockeyFee(TABLE, P1)).toBe(0); // zero fee
    expect(readChips(P1)).toBe(200);
    expect(readAirHockeyPaidRecord(TABLE, P1)).toBeNull();
  });

  it('lets the owner play their own table free', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(OWNER, 100);
    expect(payAirHockeyFee(TABLE, OWNER)).toBe(0);
    expect(readChips(OWNER)).toBe(100);
    expect(readAirHockeyPaidRecord(TABLE, OWNER)).toBeNull();
  });

  it('refuses (null) on insufficient balance without touching anything', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 30);
    expect(payAirHockeyFee(TABLE, P1)).toBeNull();
    expect(readChips(P1)).toBe(30);
    expect(readAirHockeyPaidRecord(TABLE, P1)).toBeNull();
  });

  it('is idempotent: a retry reuses the existing record, no double debit', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    expect(payAirHockeyFee(TABLE, P1)).toBe(50);
    expect(payAirHockeyFee(TABLE, P1)).toBe(50); // crash-retry
    expect(readChips(P1)).toBe(150);
    expectConserved();
  });

  it('reports the escrowed amount even after the owner disables or re-prices', () => {
    // The record, not today's config, is the truth: a crash-retry after a
    // config change must surface the chips actually held, not 0 / new price.
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    expect(payAirHockeyFee(TABLE, P1)).toBe(50);
    writeAirHockeyFeeConfig(TABLE, feeConfig(50, false));
    expect(payAirHockeyFee(TABLE, P1)).toBe(50);
    writeAirHockeyFeeConfig(TABLE, feeConfig(200));
    expect(payAirHockeyFee(TABLE, P1)).toBe(50);
    expect(readChips(P1)).toBe(150); // still the one original debit
  });
});

// ── Refund: held-only self-credit ────────────────────────────────────────────

describe('refundAirHockeyFee', () => {
  it('deletes the held record and credits the payer exactly once', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    expect(refundAirHockeyFee(TABLE, P1)).toBe(50);
    expect(readChips(P1)).toBe(200);
    expect(readAirHockeyPaidRecord(TABLE, P1)).toBeNull();
    expect(refundAirHockeyFee(TABLE, P1)).toBe(0); // second call: nothing held
    expect(readChips(P1)).toBe(200);
    expectConserved();
  });

  it('never refunds a final record — fees are final once the match starts', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    finalizeAirHockeyFee(TABLE, P1);
    expect(refundAirHockeyFee(TABLE, P1)).toBe(0);
    expect(readChips(P1)).toBe(150);
    expect(readAirHockeyPaidRecord(TABLE, P1)?.state).toBe('final');
  });

  it('keeps the record when the credit would overflow a safe integer', () => {
    const doc = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    // Hostile/corrupt balance near the safe-integer ceiling: the refund must
    // refuse rather than write an unsafe number, and must KEEP the record so
    // a later retry can still make the player whole.
    doc.transact(() => rawCasino(doc).set(`bal:${P1}`, Number.MAX_SAFE_INTEGER - 10));
    expect(refundAirHockeyFee(TABLE, P1)).toBe(0);
    expect(readChips(P1)).toBe(Number.MAX_SAFE_INTEGER - 10);
    expect(readAirHockeyPaidRecord(TABLE, P1)?.state).toBe('held');
  });
});

// ── Finalize: one-way held → final ───────────────────────────────────────────

describe('finalizeAirHockeyFee', () => {
  it('promotes held to final preserving amount and recipient', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    expect(finalizeAirHockeyFee(TABLE, P1)).toBe(true);
    expect(readAirHockeyPaidRecord(TABLE, P1))
      .toEqual({ amount: 50, ownerId: OWNER, state: 'final' });
    expect(finalizeAirHockeyFee(TABLE, P1)).toBe(false); // already final
    expect(finalizeAirHockeyFee(TABLE, P2)).toBe(false); // no record at all
  });
});

// ── Sweep: owner collects finals addressed to them ───────────────────────────

describe('sweepAirHockeyFees', () => {
  it('collects every final addressed to the owner across tables, once', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    writeAirHockeyFeeConfig('ah-table-2', feeConfig(30));
    buyInChips(P1, 200);
    buyInChips(P2, 200);
    payAirHockeyFee(TABLE, P1);
    payAirHockeyFee('ah-table-2', P2);
    finalizeAirHockeyFee(TABLE, P1);
    finalizeAirHockeyFee('ah-table-2', P2);
    expect(sweepAirHockeyFees(OWNER)).toBe(80);
    expect(readChips(OWNER)).toBe(80);
    expect(scanAirHockeyPaidRecords()).toEqual([]);
    expect(sweepAirHockeyFees(OWNER)).toBe(0); // nothing left to collect
    expect(readChips(OWNER)).toBe(80);
    expectConserved();
  });

  it('leaves held records alone — those still belong to their payers', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    expect(sweepAirHockeyFees(OWNER)).toBe(0);
    expect(readChips(OWNER)).toBe(0);
    expect(readAirHockeyPaidRecord(TABLE, P1)?.state).toBe('held');
  });

  it('moves nothing for a non-recipient — records name their owner', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    finalizeAirHockeyFee(TABLE, P1);
    expect(sweepAirHockeyFees(P2)).toBe(0); // addressed to OWNER, not P2
    expect(readChips(P2)).toBe(0);
    expect(readAirHockeyPaidRecord(TABLE, P1)?.state).toBe('final');
  });

  it('skips (and keeps) records that would overflow the owner balance', () => {
    const doc = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    writeAirHockeyFeeConfig('ah-table-2', feeConfig(50));
    buyInChips(P1, 100);
    buyInChips(P2, 100);
    payAirHockeyFee(TABLE, P1);
    payAirHockeyFee('ah-table-2', P2);
    finalizeAirHockeyFee(TABLE, P1);
    finalizeAirHockeyFee('ah-table-2', P2);
    // Corrupt owner balance with headroom for exactly one of the two 50s.
    doc.transact(() => rawCasino(doc).set(`bal:${OWNER}`, Number.MAX_SAFE_INTEGER - 60));
    expect(sweepAirHockeyFees(OWNER)).toBe(50);
    expect(readChips(OWNER)).toBe(Number.MAX_SAFE_INTEGER - 10);
    expect(scanAirHockeyPaidRecords()).toHaveLength(1); // the skipped one survives
  });
});

// ── Table removal: config gone, records stay ─────────────────────────────────

describe('clearAirHockeyKeys', () => {
  it('deletes the config but leaves escrow records for their owners', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    clearAirHockeyKeys(TABLE);
    clearAirHockeyKeys(TABLE); // every observing client runs it — idempotent
    expect(readAirHockeyFeeConfig(TABLE)).toBeNull();
    expect(readAirHockeyPaidRecord(TABLE, P1)?.state).toBe('held');
    // The payer's reconciler then refunds the stranded record (table gone).
    expect(airHockeyEscrowAction(readAirHockeyPaidRecord(TABLE, P1)!, null, P1)).toBe('refund');
    expect(refundAirHockeyFee(TABLE, P1)).toBe(50);
    expect(readChips(P1)).toBe(200);
    expectConserved();
  });
});

// ── Scan: key parsing across the peer trust boundary ─────────────────────────

describe('scanAirHockeyPaidRecords', () => {
  it('splits table and player at the LAST colon (table ids may contain ":")', () => {
    const doc = makeRoom();
    const record: AirHockeyPaidRecord = { amount: 25, ownerId: OWNER, state: 'held' };
    doc.transact(() => rawCasino(doc).set(`ah-paid:furn:12:${P1}`, record));
    expect(scanAirHockeyPaidRecords())
      .toEqual([{ tableId: 'furn:12', playerId: P1, record }]);
  });

  it('skips malformed keys and malformed records without throwing', () => {
    const doc = makeRoom();
    const record: AirHockeyPaidRecord = { amount: 25, ownerId: OWNER, state: 'held' };
    doc.transact(() => {
      const map = rawCasino(doc);
      map.set('ah-paid:lonesegment', record);          // no player segment
      map.set(`ah-paid::${P1}`, record);               // empty table id
      map.set(`ah-paid:${TABLE}:`, record);            // empty player id
      map.set(`ah-paid:${TABLE}:${P1}`, { amount: 0, ownerId: OWNER, state: 'held' }); // bad shape
      map.set(`ah-paid:${TABLE}:${P2}`, record);       // the one valid entry
      map.set(`bal:${P1}`, 500);                       // non-escrow key ignored
    });
    expect(scanAirHockeyPaidRecords())
      .toEqual([{ tableId: TABLE, playerId: P2, record }]);
  });
});

// ── Record shape guard ───────────────────────────────────────────────────────

describe('isAirHockeyPaidRecord', () => {
  const valid: AirHockeyPaidRecord = { amount: 50, ownerId: OWNER, state: 'held' };
  it('accepts held and final records within the fee cap', () => {
    expect(isAirHockeyPaidRecord(valid)).toBe(true);
    expect(isAirHockeyPaidRecord({ ...valid, amount: AH_MAX_FEE, state: 'final' })).toBe(true);
    expect(isAirHockeyPaidRecord({ ...valid, amount: 1 })).toBe(true);
  });
  it('rejects out-of-range amounts, bad recipients, and bad states', () => {
    expect(isAirHockeyPaidRecord(null)).toBe(false);
    expect(isAirHockeyPaidRecord(42)).toBe(false);
    expect(isAirHockeyPaidRecord({})).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: 0 })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: -5 })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: AH_MAX_FEE + 1 })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: 12.5 })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: Number.MAX_SAFE_INTEGER + 2 })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: Number.NaN })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: Infinity })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: -Infinity })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, amount: -0 })).toBe(false); // safe int, but not > 0
    expect(isAirHockeyPaidRecord({ ...valid, ownerId: 42 })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, ownerId: null })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, ownerId: '' })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, ownerId: 'x'.repeat(129) })).toBe(false);
    expect(isAirHockeyPaidRecord({ ...valid, state: 'pending' })).toBe(false);
  });
});

// ── Reconciler predicate: all arms ───────────────────────────────────────────

describe('airHockeyEscrowAction', () => {
  const held: AirHockeyPaidRecord = { amount: 50, ownerId: OWNER, state: 'held' };
  it("leaves final records to the owner ('none')", () => {
    expect(airHockeyEscrowAction({ ...held, state: 'final' }, seatedState(), P1)).toBe('none');
    expect(airHockeyEscrowAction({ ...held, state: 'final' }, null, P1)).toBe('none');
  });
  it('refunds when the table state is gone (cleared / removed)', () => {
    expect(airHockeyEscrowAction(held, null, P1)).toBe('refund');
  });
  it('refunds when the payer is no longer seated (reset / kick / release)', () => {
    const s = initialAirHockeyState(); // nobody seated
    expect(airHockeyEscrowAction(held, s, P1)).toBe('refund');
    expect(airHockeyEscrowAction(held, seatedState(), OWNER)).toBe('refund');
  });
  it('finalizes when the match started while seated (crash before the hook)', () => {
    let s = seatedState();
    s = setReady(s, 'a', P1, 50)!;
    s = setReady(s, 'b', P2, 50)!;
    s = startIfReady(s, 1000)!;
    expect(airHockeyEscrowAction(held, s, P1)).toBe('finalize');
    // Still finalize after the match ENDED — startedAt proves the match ran.
    expect(airHockeyEscrowAction(held, { ...s, status: 'ended', winner: 'a' }, P1)).toBe('finalize');
    // Even with ready cleared post-start (hostile or partial reset write):
    // startedAt outranks the ready check by design.
    expect(airHockeyEscrowAction(held, { ...s, ready: { a: false, b: false } }, P1)).toBe('finalize');
  });
  it("holds ('none') while seated + ready pre-start — the legitimate escrow", () => {
    const s = setReady(seatedState(), 'a', P1, 50)!;
    expect(airHockeyEscrowAction(held, s, P1)).toBe('none');
  });
  it('refunds when seated but NOT ready (pay landed, ready write lost)', () => {
    expect(airHockeyEscrowAction(held, seatedState(), P1)).toBe('refund');
  });
});

// ── Full lifecycles on one doc ───────────────────────────────────────────────

describe('fee lifecycle', () => {
  it('versus match: pay → ready → start → finalize → sweep, fully conserved', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    buyInChips(P2, 200);
    // Ready-up (the doReady sequence): escrow the fee, then write the state.
    const feeA = payAirHockeyFee(TABLE, P1)!;
    const feeB = payAirHockeyFee(TABLE, P2)!;
    let s = seatedState();
    s = setReady(s, 'a', P1, feeA)!;
    s = setReady(s, 'b', P2, feeB)!;
    s = startIfReady(s, 1000)!;
    writeGame(TABLE, s);
    expectConserved();
    // Each payer observes the start (seenStartedAt hook) and finalizes.
    expect(airHockeyEscrowAction(readAirHockeyPaidRecord(TABLE, P1)!, readAirHockey(TABLE), P1))
      .toBe('finalize');
    finalizeAirHockeyFee(TABLE, P1);
    finalizeAirHockeyFee(TABLE, P2);
    // The owner's upkeep sweeps both finals in one transaction.
    expect(sweepAirHockeyFees(OWNER)).toBe(100);
    expect(readChips(P1)).toBe(150);
    expect(readChips(P2)).toBe(150);
    expect(readChips(OWNER)).toBe(100);
    expect(scanAirHockeyPaidRecords()).toEqual([]);
    expectConserved();
  });

  it('practice fee: solo start stamps startedAt, so the fee finalizes too', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(30));
    buyInChips(P1, 100);
    const fee = payAirHockeyFee(TABLE, P1)!;
    let s = claimSide(initialAirHockeyState(), 'a', P1)!;
    s = startPractice(s, 'a', P1, fee, 1000)!;
    writeGame(TABLE, s);
    expect(airHockeyEscrowAction(readAirHockeyPaidRecord(TABLE, P1)!, readAirHockey(TABLE), P1))
      .toBe('finalize');
    finalizeAirHockeyFee(TABLE, P1);
    expect(sweepAirHockeyFees(OWNER)).toBe(30);
    expect(readChips(P1)).toBe(70);
    expect(readChips(OWNER)).toBe(30);
    expectConserved();
  });

  it('un-ready before start refunds in full — no owner balance involved', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    const fee = payAirHockeyFee(TABLE, P1)!;
    let s = setReady(seatedState(), 'a', P1, fee)!;
    writeGame(TABLE, s);
    // doUnready: state write first, then the money move.
    writeGame(TABLE, { ...s, ready: { ...s.ready, a: false }, paid: { ...s.paid, a: 0 } });
    expect(refundAirHockeyFee(TABLE, P1)).toBe(50);
    expect(readChips(P1)).toBe(200);
    expect(readChips(OWNER)).toBe(0);
    expectConserved();
  });

  it('heals a stranded record after the table is cleared mid-setup', () => {
    makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    writeGame(TABLE, setReady(seatedState(), 'a', P1, 50)!);
    clearTable(TABLE);        // reset / removal wiped the game state
    clearAirHockeyKeys(TABLE);
    const rec = readAirHockeyPaidRecord(TABLE, P1)!;
    expect(airHockeyEscrowAction(rec, readAirHockey(TABLE), P1)).toBe('refund');
    expect(refundAirHockeyFee(TABLE, P1)).toBe(50);
    expect(readChips(P1)).toBe(200);
    expectConserved();
  });

  it('an ownership change mid-escrow redirects nothing', () => {
    // Records capture ownerId at pay time. After the room changes hands: a
    // held record still refunds to its payer (no owner involved at all), a
    // final still sweeps to the OLD owner it names — never to the new one,
    // and never stranding (regression pin: sweep matches record.ownerId, not
    // the CURRENT room owner).
    const doc = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    writeAirHockeyFeeConfig('ah-table-2', feeConfig(30));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);        // held 50
    payAirHockeyFee('ah-table-2', P1); // held 30
    finalizeAirHockeyFee(TABLE, P1);   // the match ran on TABLE only
    doc.getMap('roomInfo').set('owner', P2); // the room changes hands
    expect(sweepAirHockeyFees(P2)).toBe(0);                 // new owner: not the recipient
    expect(refundAirHockeyFee('ah-table-2', P1)).toBe(30);  // held: payer's, owner-free
    expect(sweepAirHockeyFees(OWNER)).toBe(50);             // old owner still collects
    expect(readChips(P1)).toBe(150);
    expect(readChips(P2)).toBe(0);
    expect(readChips(OWNER)).toBe(50);
    expect(scanAirHockeyPaidRecords()).toEqual([]);
    expectConserved();
  });
});

// ── Concurrent divergence: the minting/destruction regression suite ──────────

describe('escrow conservation under concurrent divergence', () => {
  it('two players paying on diverged clients both land — nothing lost (F1)', () => {
    // The old direct-transfer design lost one fee here: both clients wrote
    // bal:<owner> from the same base and LWW dropped one credit. Escrow
    // records give each payer disjoint keys, so the merge is a clean union.
    const room = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    buyInChips(P2, 200);
    const a = forkDoc(room);
    const b = forkDoc(room);
    bindRoom(a);
    expect(payAirHockeyFee(TABLE, P1)).toBe(50);
    bindRoom(b);
    expect(payAirHockeyFee(TABLE, P2)).toBe(50);
    mergeDocs(a, b);
    bindRoom(a);
    expect(readChips(P1)).toBe(150);
    expect(readChips(P2)).toBe(150);
    expect(readChips(OWNER)).toBe(0);
    expect(readAirHockeyPaidRecord(TABLE, P1)?.state).toBe('held');
    expect(readAirHockeyPaidRecord(TABLE, P2)?.state).toBe('held');
    expectConserved();
  });

  it('two players refunding on diverged clients — nothing minted (F2)', () => {
    // The old design MINTED here: both refunds read the same owner balance
    // and re-credited from it. Refunds now touch only the payer's own keys.
    const room = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    buyInChips(P2, 200);
    payAirHockeyFee(TABLE, P1);
    payAirHockeyFee(TABLE, P2);
    const a = forkDoc(room);
    const b = forkDoc(room);
    bindRoom(a);
    expect(refundAirHockeyFee(TABLE, P1)).toBe(50);
    bindRoom(b);
    expect(refundAirHockeyFee(TABLE, P2)).toBe(50);
    mergeDocs(a, b);
    bindRoom(a);
    expect(readChips(P1)).toBe(200);
    expect(readChips(P2)).toBe(200);
    expect(readChips(OWNER)).toBe(0);
    expect(scanAirHockeyPaidRecords()).toEqual([]);
    expectConserved();
  });

  it('the SAME player refunding in two tabs converges to one credit', () => {
    // Two clients of one player race the same refund: both compute
    // base + amount from the same base, so whichever balance write wins LWW
    // carries a single credit; both record deletions agree.
    const room = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    const a = forkDoc(room);
    const b = forkDoc(room);
    bindRoom(a);
    expect(refundAirHockeyFee(TABLE, P1)).toBe(50);
    bindRoom(b);
    expect(refundAirHockeyFee(TABLE, P1)).toBe(50);
    mergeDocs(a, b);
    bindRoom(a);
    expect(readChips(P1)).toBe(200); // exactly one credit survives
    expect(readAirHockeyPaidRecord(TABLE, P1)).toBeNull();
    expectConserved();
  });

  it('an owner sweep and a new pay on diverged clients both land intact', () => {
    const room = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    buyInChips(P2, 200);
    payAirHockeyFee(TABLE, P1);
    finalizeAirHockeyFee(TABLE, P1);
    const a = forkDoc(room);
    const b = forkDoc(room);
    bindRoom(a); // owner's client collects...
    expect(sweepAirHockeyFees(OWNER)).toBe(50);
    bindRoom(b); // ...while a new player pays elsewhere
    expect(payAirHockeyFee(TABLE, P2)).toBe(50);
    mergeDocs(a, b);
    bindRoom(a);
    expect(readChips(OWNER)).toBe(50);
    expect(readChips(P1)).toBe(150);
    expect(readChips(P2)).toBe(150);
    expect(readAirHockeyPaidRecord(TABLE, P1)).toBeNull();
    expect(readAirHockeyPaidRecord(TABLE, P2)?.state).toBe('held');
    expectConserved();
  });

  it('merged docs agree byte-for-byte after a divergent fee round', () => {
    // Convergence sanity: after the two-way merge both replicas must render
    // the identical casino map (Yjs guarantee, asserted end-to-end here).
    const room = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    buyInChips(P2, 200);
    const a = forkDoc(room);
    const b = forkDoc(room);
    bindRoom(a);
    payAirHockeyFee(TABLE, P1);
    bindRoom(b);
    payAirHockeyFee(TABLE, P2);
    refundAirHockeyFee(TABLE, P2);
    mergeDocs(a, b);
    expect(rawCasino(a).toJSON()).toEqual(rawCasino(b).toJSON());
  });
});

// ── Doc rebind mid-upkeep ────────────────────────────────────────────────────

describe('doc rebind mid-upkeep', () => {
  it('stale scan results against a freshly bound doc are no-ops', () => {
    // runEscrowUpkeep scans, then every money call independently re-resolves
    // the CURRENTLY bound doc inside its own transaction. If a room switch
    // (rebind) lands between scan and write, the stale (table, player) pairs
    // must find no record in the new doc — the in-transaction record check is
    // the guard, not the scan (regression pin on that check ordering).
    const roomA = makeRoom();
    writeAirHockeyFeeConfig(TABLE, feeConfig(50));
    buyInChips(P1, 200);
    payAirHockeyFee(TABLE, P1);
    const stale = scanAirHockeyPaidRecords(); // an upkeep's view of room A
    expect(stale).toHaveLength(1);
    makeRoom(); // rebind: joined a different room mid-upkeep
    buyInChips(P1, 70);
    for (const { tableId, playerId } of stale) {
      expect(refundAirHockeyFee(tableId, playerId)).toBe(0);
      expect(finalizeAirHockeyFee(tableId, playerId)).toBe(false);
    }
    expect(sweepAirHockeyFees(OWNER)).toBe(0);
    expect(readChips(P1)).toBe(70); // the new room never saw room A's escrow
    expectConserved();
    bindRoom(roomA); // back on room A: the record survived, still refundable
    expect(readAirHockeyPaidRecord(TABLE, P1)?.state).toBe('held');
    expect(readChips(P1)).toBe(150);
    expectConserved();
  });
});

// ── Trust boundary: forged records (documented, accepted) ────────────────────

describe('forged records (documented trust boundary)', () => {
  // Map writes are unauthenticated, so a hostile peer can forge whole escrow
  // records and the reconcilers will honour them. These tests PIN that
  // accepted bound so any future change to it is deliberate: the forger
  // gains nothing a direct bal:<target> write would not give, the mint is
  // just as visible in the cage ledger, and the real fix is authenticated
  // authorship (roadmapped) — not record heuristics that would strand honest
  // crash-rejoin records (see the casinoDoc lane header).
  it("a forged 'held' record refunds to the player it names", () => {
    const doc = makeRoom();
    const forged: AirHockeyPaidRecord = { amount: 500, ownerId: OWNER, state: 'held' };
    doc.transact(() => rawCasino(doc).set(`ah-paid:no-such-table:${P1}`, forged));
    // The named player's own upkeep sees "my record, no table" → refund arm.
    expect(airHockeyEscrowAction(forged, null, P1)).toBe('refund');
    expect(refundAirHockeyFee('no-such-table', P1)).toBe(500);
    expect(readChips(P1)).toBe(500); // minted INTO the target, ≤ AH_MAX_FEE per record
    const ledger = readCageLedger();
    expect(ledger.outstanding - (ledger.issued - ledger.cashed)).toBe(500); // visible mint
  });
  it("a forged 'final' record sweeps to the owner it names", () => {
    const doc = makeRoom();
    const forged: AirHockeyPaidRecord = { amount: 500, ownerId: OWNER, state: 'final' };
    doc.transact(() => rawCasino(doc).set(`ah-paid:no-such-table:${P1}`, forged));
    expect(sweepAirHockeyFees(OWNER)).toBe(500);
    expect(readChips(OWNER)).toBe(500);
    const ledger = readCageLedger();
    expect(ledger.outstanding - (ledger.issued - ledger.cashed)).toBe(500); // visible mint
  });
});
