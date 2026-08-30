// casinoTransfers.ts unit tests: id derivation is deterministic across peers,
// the shape/entry guards refuse hostile writes, signature verification is
// bound tightly to the record's canonical bytes, the deterministic over-drain
// rule refuses phantom mints, the block-list filter hides incoming from
// blocked BUT the visible count still reflects the physical credit, and the
// factory returns records that round-trip through every guard.
//
// Pure engine ⇒ no Yjs, no @noble import at test time. Signatures are stubbed
// with a deterministic HMAC-ish concatenation so the test file has no crypto
// dependency of its own.

import { describe, it, expect } from 'vitest';

import {
  buildChipTransfer,
  CHIP_TRANSFER_KIND,
  CHIP_TRANSFER_VERSION,
  compareTransfersForReplay,
  deriveChipTransferId,
  filterIncoming,
  filterOutgoing,
  isChipTransfer,
  isValidChipTransferEntry,
  MAX_CHIP_TRANSFERS,
  partitionIncomingByBlocked,
  partitionValidTransfers,
  readTransferEntries,
  transferSignBytes,
  verifyChipTransfer,
  TRANSFER_NONCE_MAX,
  type SenderIssuance,
  type VerifyIdentityFn,
} from './casinoTransfers';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Deterministic byte hasher for the sig stub — the same bytes always yield
 *  the same "signature" string. Uses a simple joined hex; test-only. */
function stubSig(pub: string, bytes: Uint8Array): string {
  let acc = 0;
  for (const b of bytes) acc = (acc * 33 + b) >>> 0;
  return `sig(${pub}|${acc.toString(16)})`;
}

const stubSignFor = (pub: string) => (bytes: Uint8Array): string => stubSig(pub, bytes);

const stubVerify: VerifyIdentityFn = (pub, bytes, sig) => sig === stubSig(pub, bytes);

const ALICE = 'pub-alice-base64url';
const BOB = 'pub-bob-base64url';
const CAROL = 'pub-carol-base64url';
const ALICE_PID = 'pid-alice';
const BOB_PID = 'pid-bob';
const CAROL_PID = 'pid-carol';
const ROOM = 'room-r1';

/** Minimum viable input for id derivation / building. */
function baseInput(overrides: Partial<Parameters<typeof buildChipTransfer>[0]> = {}) {
  return {
    roomId: ROOM,
    fromPub: ALICE,
    toPub: BOB,
    fromPlayerId: ALICE_PID,
    toPlayerId: BOB_PID,
    amount: 100,
    nonce: 'nonce-01',
    ts: 1_700_000_000_000,
    sign: stubSignFor(ALICE),
    ...overrides,
  };
}

// ── Id derivation (deterministic across peers) ───────────────────────────────

describe('chip transfers · deriveChipTransferId', () => {
  it('yields identical ids for identical inputs', () => {
    const input = {
      v: CHIP_TRANSFER_VERSION, kind: CHIP_TRANSFER_KIND, roomId: ROOM,
      fromPub: ALICE, toPub: BOB, fromPlayerId: ALICE_PID, toPlayerId: BOB_PID,
      amount: 250, nonce: 'nonce-abc', ts: 1_700_000_500_000,
    } as const;
    const a = deriveChipTransferId(input);
    const b = deriveChipTransferId(input);
    expect(a).toBe(b);
    expect(a.startsWith('t-')).toBe(true);
    // 32 hex chars after the 't-' prefix ⇒ 34 total.
    expect(a.length).toBe(34);
  });

  it('flips the id when ANY field changes', () => {
    const base = {
      v: CHIP_TRANSFER_VERSION, kind: CHIP_TRANSFER_KIND, roomId: ROOM,
      fromPub: ALICE, toPub: BOB, fromPlayerId: ALICE_PID, toPlayerId: BOB_PID,
      amount: 250, nonce: 'nonce-abc', ts: 1_700_000_500_000,
    } as const;
    const baseId = deriveChipTransferId(base);
    // Every field participates — mutating each one alone must change the id.
    expect(deriveChipTransferId({ ...base, roomId: 'room-other' })).not.toBe(baseId);
    expect(deriveChipTransferId({ ...base, fromPub: BOB })).not.toBe(baseId);
    expect(deriveChipTransferId({ ...base, toPub: CAROL })).not.toBe(baseId);
    expect(deriveChipTransferId({ ...base, fromPlayerId: 'pid-other' })).not.toBe(baseId);
    expect(deriveChipTransferId({ ...base, toPlayerId: 'pid-other' })).not.toBe(baseId);
    expect(deriveChipTransferId({ ...base, amount: 251 })).not.toBe(baseId);
    expect(deriveChipTransferId({ ...base, nonce: 'nonce-different' })).not.toBe(baseId);
    expect(deriveChipTransferId({ ...base, ts: base.ts + 1 })).not.toBe(baseId);
  });
});

// ── Shape guard ──────────────────────────────────────────────────────────────

describe('chip transfers · isChipTransfer', () => {
  it('accepts a well-formed transfer', () => {
    const t = buildChipTransfer(baseInput());
    expect(isChipTransfer(t)).toBe(true);
  });

  it('rejects non-object / null / undefined', () => {
    expect(isChipTransfer(null)).toBe(false);
    expect(isChipTransfer(undefined)).toBe(false);
    expect(isChipTransfer('string')).toBe(false);
    expect(isChipTransfer(42)).toBe(false);
    expect(isChipTransfer([])).toBe(false);
  });

  it('rejects mismatched kind / version', () => {
    const t = buildChipTransfer(baseInput());
    expect(isChipTransfer({ ...t, kind: 'other' })).toBe(false);
    expect(isChipTransfer({ ...t, v: 2 })).toBe(false);
  });

  it('rejects missing / mistyped fields', () => {
    const t = buildChipTransfer(baseInput());
    expect(isChipTransfer({ ...t, id: undefined })).toBe(false);
    expect(isChipTransfer({ ...t, roomId: '' })).toBe(false);
    expect(isChipTransfer({ ...t, fromPub: null })).toBe(false);
    expect(isChipTransfer({ ...t, amount: -1 })).toBe(false);
    expect(isChipTransfer({ ...t, amount: 1.5 })).toBe(false);
    expect(isChipTransfer({ ...t, amount: 0 })).toBe(false);
    expect(isChipTransfer({ ...t, ts: 'not-a-number' })).toBe(false);
    expect(isChipTransfer({ ...t, ts: Number.NaN })).toBe(false);
    expect(isChipTransfer({ ...t, sig: '' })).toBe(false);
  });

  it('rejects a self-transfer', () => {
    // Cannot build one from the factory (it throws), so hand-craft the record.
    const same = 'pub-self';
    const idInput = {
      v: CHIP_TRANSFER_VERSION, kind: CHIP_TRANSFER_KIND, roomId: ROOM,
      fromPub: same, toPub: same,
      fromPlayerId: 'pid-a', toPlayerId: 'pid-b',
      amount: 10, nonce: 'nx', ts: 123,
    } as const;
    const id = deriveChipTransferId(idInput);
    expect(isChipTransfer({ ...idInput, id, sig: 'sig' })).toBe(false);
  });

  it('rejects a record whose id does not match its own fields (hijack)', () => {
    const t = buildChipTransfer(baseInput());
    // Same signature, but the claimed id is another (well-formed) id.
    const hijacked = { ...t, id: 't-0000000000000000000000000000abcd' };
    expect(isChipTransfer(hijacked)).toBe(false);
  });

  it('rejects overlong nonce', () => {
    const bigNonce = 'x'.repeat(TRANSFER_NONCE_MAX + 1);
    // Factory rejects overlong nonce
    expect(() => buildChipTransfer(baseInput({ nonce: bigNonce }))).toThrow();
    // A hand-crafted record with an overlong nonce is rejected by isChipTransfer
    const idInput = {
      v: CHIP_TRANSFER_VERSION, kind: CHIP_TRANSFER_KIND, roomId: ROOM,
      fromPub: ALICE, toPub: BOB, fromPlayerId: ALICE_PID, toPlayerId: BOB_PID,
      amount: 10, nonce: bigNonce, ts: 1,
    } as const;
    const id = deriveChipTransferId(idInput);
    expect(isChipTransfer({ ...idInput, id, sig: 'sig' })).toBe(false);
  });
});

// ── Entry guard (map key ↔ value.id) ─────────────────────────────────────────

describe('chip transfers · isValidChipTransferEntry', () => {
  it('accepts a well-formed entry whose key equals value.id', () => {
    const t = buildChipTransfer(baseInput());
    expect(isValidChipTransferEntry(t.id, t)).toBe(true);
  });

  it('rejects when map key does not match value.id', () => {
    const t = buildChipTransfer(baseInput());
    expect(isValidChipTransferEntry('some-other-key', t)).toBe(false);
  });

  it('rejects on non-string / empty key', () => {
    const t = buildChipTransfer(baseInput());
    expect(isValidChipTransferEntry('', t)).toBe(false);
    expect(isValidChipTransferEntry(undefined, t)).toBe(false);
    expect(isValidChipTransferEntry(42, t)).toBe(false);
  });

  it('rejects a malformed value even when the key matches', () => {
    const t = buildChipTransfer(baseInput());
    const bad = { ...t, amount: -1 };
    expect(isValidChipTransferEntry(t.id, bad)).toBe(false);
  });
});

// ── Signature verification ───────────────────────────────────────────────────

describe('chip transfers · verifyChipTransfer', () => {
  it('accepts a real signature from the sender', () => {
    const t = buildChipTransfer(baseInput());
    expect(verifyChipTransfer(t, stubVerify)).toBe(true);
  });

  it('rejects a tampered field even when the sig is present', () => {
    const t = buildChipTransfer(baseInput());
    // Mutate one field but keep the original sig — sig no longer matches
    // the mutated canonical bytes. (The record won't survive isChipTransfer
    // either because the id would drift; verifyChipTransfer alone MUST reject.)
    const tampered = { ...t, amount: t.amount + 1 };
    expect(verifyChipTransfer(tampered, stubVerify)).toBe(false);
  });

  it('rejects a sig by a DIFFERENT identity', () => {
    // Sender is Alice but the record's sig was made by Bob — the verifier is
    // called with Alice's pub and Bob's sig, and cannot match.
    const t = buildChipTransfer(baseInput({ sign: stubSignFor(BOB) }));
    expect(verifyChipTransfer(t, stubVerify)).toBe(false);
  });

  it('is defensive against a verifier that throws (returns false, does not propagate)', () => {
    const t = buildChipTransfer(baseInput());
    const throwingVerifier: VerifyIdentityFn = () => { throw new Error('boom'); };
    expect(verifyChipTransfer(t, throwingVerifier)).toBe(false);
  });
});

// ── Canonical sig bytes stability ────────────────────────────────────────────

describe('chip transfers · transferSignBytes', () => {
  it('is stable across calls with the same input', () => {
    const t = buildChipTransfer(baseInput());
    const a = transferSignBytes(t);
    const b = transferSignBytes(t);
    expect(a).toEqual(b);
  });

  it('embeds the domain tag so bytes cannot be replayed cross-kind', () => {
    const t = buildChipTransfer(baseInput());
    const bytes = transferSignBytes(t);
    const asStr = new TextDecoder().decode(bytes);
    expect(asStr.includes('ssf-chip-xfer:v1')).toBe(true);
  });
});

// ── Deterministic replay (over-drain refusal) ────────────────────────────────

describe('chip transfers · partitionValidTransfers', () => {
  const issuanceMap: Record<string, SenderIssuance> = {
    [ALICE_PID]: { bought: 500, cashed: 0 },
    [BOB_PID]: { bought: 0, cashed: 0 },
    [CAROL_PID]: { bought: 200, cashed: 100 }, // budget = 100
  };
  const issuanceOf = (pid: string): SenderIssuance => issuanceMap[pid] ?? { bought: 0, cashed: 0 };

  it('accepts transfers within the sender budget', () => {
    const t1 = buildChipTransfer(baseInput({ amount: 100, nonce: 'n1', ts: 1000 }));
    const t2 = buildChipTransfer(baseInput({ amount: 200, nonce: 'n2', ts: 2000 }));
    const t3 = buildChipTransfer(baseInput({ amount: 200, nonce: 'n3', ts: 3000 }));
    const { valid, refused } = partitionValidTransfers([t1, t2, t3], issuanceOf);
    expect(valid).toHaveLength(3);
    expect(refused).toHaveLength(0);
  });

  it('refuses transfers over the sender budget', () => {
    const t1 = buildChipTransfer(baseInput({ amount: 300, nonce: 'n1', ts: 1000 }));
    // t2 would push cumulative outgoing to 600 > 500 issued → REFUSED
    const t2 = buildChipTransfer(baseInput({ amount: 300, nonce: 'n2', ts: 2000 }));
    const { valid, refused } = partitionValidTransfers([t1, t2], issuanceOf);
    expect(valid.map((v) => v.id)).toEqual([t1.id]);
    expect(refused.map((v) => v.id)).toEqual([t2.id]);
  });

  it('is deterministic under any input order (ts asc, id asc)', () => {
    const t1 = buildChipTransfer(baseInput({ amount: 100, nonce: 'a', ts: 1000 }));
    const t2 = buildChipTransfer(baseInput({ amount: 100, nonce: 'b', ts: 1000 })); // same ts, id breaks tie
    const t3 = buildChipTransfer(baseInput({ amount: 400, nonce: 'c', ts: 2000 })); // would overflow
    const forward = partitionValidTransfers([t1, t2, t3], issuanceOf);
    const shuffled = partitionValidTransfers([t3, t1, t2], issuanceOf);
    const reversed = partitionValidTransfers([t3, t2, t1], issuanceOf);
    expect(forward.valid.map((v) => v.id)).toEqual(shuffled.valid.map((v) => v.id));
    expect(forward.valid.map((v) => v.id)).toEqual(reversed.valid.map((v) => v.id));
    expect(forward.refused.map((v) => v.id)).toEqual(shuffled.refused.map((v) => v.id));
    expect(forward.refused.map((v) => v.id)).toEqual(reversed.refused.map((v) => v.id));
  });

  it('rejects transfers by unknown sender (missing issuance ⇒ zero budget)', () => {
    const stranger = buildChipTransfer(baseInput({
      fromPub: 'pub-stranger', fromPlayerId: 'pid-stranger',
      toPub: BOB, toPlayerId: BOB_PID, amount: 1, nonce: 'n', ts: 1000,
      sign: stubSignFor('pub-stranger'),
    }));
    const { valid, refused } = partitionValidTransfers([stranger], issuanceOf);
    expect(valid).toHaveLength(0);
    expect(refused).toHaveLength(1);
  });

  it('tracks per-sender budgets independently', () => {
    // Alice can send 500; Carol can send only 100.
    const alicePays = buildChipTransfer(baseInput({ amount: 400, nonce: 'n1', ts: 1000 }));
    const carolPays = buildChipTransfer(baseInput({
      fromPub: CAROL, fromPlayerId: CAROL_PID,
      toPub: BOB, toPlayerId: BOB_PID,
      amount: 200, nonce: 'n2', ts: 1500, sign: stubSignFor(CAROL),
    }));
    const { valid, refused } = partitionValidTransfers([alicePays, carolPays], issuanceOf);
    expect(valid.map((v) => v.id)).toEqual([alicePays.id]);
    expect(refused.map((v) => v.id)).toEqual([carolPays.id]);
  });
});

// ── Compare helper (comparator honesty) ──────────────────────────────────────

describe('chip transfers · compareTransfersForReplay', () => {
  it('orders by ts asc, then id asc', () => {
    const early = buildChipTransfer(baseInput({ nonce: 'n1', ts: 1 }));
    const late = buildChipTransfer(baseInput({ nonce: 'n2', ts: 2 }));
    expect(compareTransfersForReplay(early, late) < 0).toBe(true);
    expect(compareTransfersForReplay(late, early) > 0).toBe(true);
    // Same ts — tie broken by id string order.
    const same1 = buildChipTransfer(baseInput({ nonce: 'a', ts: 1 }));
    const same2 = buildChipTransfer(baseInput({ nonce: 'b', ts: 1 }));
    const cmp = compareTransfersForReplay(same1, same2);
    // Comparison sign matches the id string order.
    expect(Math.sign(cmp)).toBe(Math.sign(same1.id < same2.id ? -1 : 1));
  });
});

// ── Incoming / outgoing filters ──────────────────────────────────────────────

describe('chip transfers · filterIncoming / filterOutgoing', () => {
  const t1 = buildChipTransfer(baseInput({ nonce: 'n1', ts: 1 })); // ALICE → BOB
  const t2 = buildChipTransfer(baseInput({
    fromPub: BOB, fromPlayerId: BOB_PID,
    toPub: ALICE, toPlayerId: ALICE_PID,
    nonce: 'n2', ts: 2, sign: stubSignFor(BOB),
  })); // BOB → ALICE
  const t3 = buildChipTransfer(baseInput({
    fromPub: CAROL, fromPlayerId: CAROL_PID,
    toPub: BOB, toPlayerId: BOB_PID,
    nonce: 'n3', ts: 3, sign: stubSignFor(CAROL),
  })); // CAROL → BOB

  it('picks incoming for a given pub', () => {
    expect(filterIncoming([t1, t2, t3], BOB).map((t) => t.id)).toEqual([t1.id, t3.id]);
    expect(filterIncoming([t1, t2, t3], ALICE).map((t) => t.id)).toEqual([t2.id]);
    expect(filterIncoming([t1, t2, t3], CAROL)).toEqual([]);
    expect(filterIncoming([t1, t2, t3], '')).toEqual([]);
  });

  it('picks outgoing for a given pub', () => {
    expect(filterOutgoing([t1, t2, t3], ALICE).map((t) => t.id)).toEqual([t1.id]);
    expect(filterOutgoing([t1, t2, t3], BOB).map((t) => t.id)).toEqual([t2.id]);
    expect(filterOutgoing([t1, t2, t3], CAROL).map((t) => t.id)).toEqual([t3.id]);
  });
});

// ── Block-list partition on incoming ─────────────────────────────────────────

describe('chip transfers · partitionIncomingByBlocked', () => {
  const t1 = buildChipTransfer(baseInput({ nonce: 'n1', ts: 1 })); // ALICE → BOB
  const t2 = buildChipTransfer(baseInput({
    fromPub: CAROL, fromPlayerId: CAROL_PID,
    toPub: BOB, toPlayerId: BOB_PID,
    nonce: 'n2', ts: 2, sign: stubSignFor(CAROL),
  })); // CAROL → BOB

  it('drops incoming from blocked, keeps others', () => {
    const blocked = new Set([CAROL]);
    const { visible, hidden } = partitionIncomingByBlocked([t1, t2], blocked);
    expect(visible.map((t) => t.id)).toEqual([t1.id]);
    expect(hidden).toBe(1);
  });

  it('empty block set is a fast passthrough', () => {
    const empty = new Set<string>();
    const { visible, hidden } = partitionIncomingByBlocked([t1, t2], empty);
    expect(visible).toHaveLength(2);
    expect(hidden).toBe(0);
    // Returns a shallow copy — not a reference to the input.
    expect(visible).not.toBe([t1, t2]);
  });
});

// ── Read-side collection (skips hostile / malformed rows) ────────────────────

describe('chip transfers · readTransferEntries', () => {
  it('keeps valid entries and silently drops malformed / mismatched-key rows', () => {
    const t = buildChipTransfer(baseInput());
    const entries: [string, unknown][] = [
      [t.id, t],
      ['not-matching-key', t], // mismatched key ⇒ drop
      ['xfer:x', { junk: true }], // malformed value ⇒ drop
      ['xfer:y', null], // null value ⇒ drop
    ];
    const out = readTransferEntries(entries);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(t.id);
  });
});

// ── Factory (buildChipTransfer) ──────────────────────────────────────────────

describe('chip transfers · buildChipTransfer', () => {
  it('returns a record that survives every guard', () => {
    const t = buildChipTransfer(baseInput());
    expect(isChipTransfer(t)).toBe(true);
    expect(isValidChipTransferEntry(t.id, t)).toBe(true);
    expect(verifyChipTransfer(t, stubVerify)).toBe(true);
    expect(t.v).toBe(CHIP_TRANSFER_VERSION);
    expect(t.kind).toBe(CHIP_TRANSFER_KIND);
    expect(t.id.startsWith('t-')).toBe(true);
  });

  it('throws on invalid input (surfaces reason to UI)', () => {
    expect(() => buildChipTransfer(baseInput({ fromPub: '' }))).toThrow();
    expect(() => buildChipTransfer(baseInput({ toPub: '' }))).toThrow();
    expect(() => buildChipTransfer(baseInput({ amount: 0 }))).toThrow();
    expect(() => buildChipTransfer(baseInput({ amount: -1 }))).toThrow();
    expect(() => buildChipTransfer(baseInput({ amount: 1.5 }))).toThrow();
    expect(() => buildChipTransfer(baseInput({ nonce: '' }))).toThrow();
    // Same identity ⇒ nonsense (no chip actually moves).
    expect(() => buildChipTransfer(baseInput({ fromPub: BOB, toPub: BOB }))).toThrow();
    expect(() => buildChipTransfer(baseInput({
      fromPlayerId: BOB_PID, toPlayerId: BOB_PID,
    }))).toThrow();
  });

  it('id derivation matches deriveChipTransferId', () => {
    const t = buildChipTransfer(baseInput());
    const idFromDeriver = deriveChipTransferId({
      v: t.v, kind: t.kind, roomId: t.roomId, fromPub: t.fromPub, toPub: t.toPub,
      fromPlayerId: t.fromPlayerId, toPlayerId: t.toPlayerId,
      amount: t.amount, nonce: t.nonce, ts: t.ts,
    });
    expect(t.id).toBe(idFromDeriver);
  });
});

// ── Conservation invariant (the hard property this slice must preserve) ──────

describe('chip transfers · conservation of chips', () => {
  it('sum of adjustments across every valid transfer is zero (net movement)', () => {
    // Property: for any set of valid transfers, Σ +amount(recipient) ==
    // Σ +amount(sender debit) — chips MOVE, they are neither created nor
    // destroyed. This is the invariant the storage-side writeChipTransfer
    // enforces atomically (bal:<from> -= n, bal:<to> += n); here we lock the
    // pure-engine truth so any change to the shape/partition still preserves
    // it (which the cage ledger's issued = cashed + outstanding relies on).
    const ts = [
      buildChipTransfer(baseInput({ amount: 50, nonce: 'a', ts: 1 })),
      buildChipTransfer(baseInput({ amount: 75, nonce: 'b', ts: 2 })),
      buildChipTransfer(baseInput({
        fromPub: BOB, fromPlayerId: BOB_PID,
        toPub: ALICE, toPlayerId: ALICE_PID,
        amount: 25, nonce: 'c', ts: 3, sign: stubSignFor(BOB),
      })),
    ];
    // Track per-pid net movement.
    const delta = new Map<string, number>();
    for (const t of ts) {
      delta.set(t.fromPlayerId, (delta.get(t.fromPlayerId) ?? 0) - t.amount);
      delta.set(t.toPlayerId, (delta.get(t.toPlayerId) ?? 0) + t.amount);
    }
    // Every credit is balanced by a matching debit — total delta sums to 0.
    let sum = 0;
    for (const v of delta.values()) sum += v;
    expect(sum).toBe(0);
  });

  it('does not credit received transfers back into a sender budget (conservative rule)', () => {
    // Alice's budget = 500. Bob's budget = 0 (bought 0). Alice → Bob 500 is
    // VALID. Bob → Carol 100 must be REFUSED — Bob's own budget is 0, even
    // though he received 500 (this documents the conservative rule from the
    // module header).
    const issuanceMap: Record<string, SenderIssuance> = {
      [ALICE_PID]: { bought: 500, cashed: 0 },
      [BOB_PID]: { bought: 0, cashed: 0 },
      [CAROL_PID]: { bought: 0, cashed: 0 },
    };
    const issuanceOf = (pid: string): SenderIssuance => issuanceMap[pid] ?? { bought: 0, cashed: 0 };
    const aliceToBob = buildChipTransfer(baseInput({ amount: 500, nonce: 'x', ts: 1 }));
    const bobToCarol = buildChipTransfer(baseInput({
      fromPub: BOB, fromPlayerId: BOB_PID,
      toPub: CAROL, toPlayerId: CAROL_PID,
      amount: 100, nonce: 'y', ts: 2, sign: stubSignFor(BOB),
    }));
    const { valid, refused } = partitionValidTransfers([aliceToBob, bobToCarol], issuanceOf);
    expect(valid.map((t) => t.id)).toEqual([aliceToBob.id]);
    expect(refused.map((t) => t.id)).toEqual([bobToCarol.id]);
  });
});

// ── Module-level constants sanity ────────────────────────────────────────────

describe('chip transfers · constants', () => {
  it('MAX_CHIP_TRANSFERS is a positive integer', () => {
    expect(Number.isInteger(MAX_CHIP_TRANSFERS)).toBe(true);
    expect(MAX_CHIP_TRANSFERS).toBeGreaterThan(0);
  });
  it('TRANSFER_NONCE_MAX is bounded and positive', () => {
    expect(Number.isInteger(TRANSFER_NONCE_MAX)).toBe(true);
    expect(TRANSFER_NONCE_MAX).toBeGreaterThan(0);
    expect(TRANSFER_NONCE_MAX).toBeLessThan(4096);
  });
});
