// treasuryDoc.ts tests: verify-on-read against hostile map contents, the §7.2
// vote slot rule, signing-session merges, and cross-doc convergence. Uses real
// ed25519 (same @noble stack as keypair.ts) with hex-encoded pubs/sigs — the
// module is encoding-agnostic because the verifier is injected.

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import contracts from '../test-vectors/treasury/treasury-contracts.json';
import {
  type CompanyTreasuryPolicy,
  type RoomTreasuryBinding,
  type SigningSession,
  type TreasuryCheckpoint,
  type TreasuryProposal,
  type TreasuryVote,
  type UnsignedTreasuryProposal,
  type UnsignedTreasuryVote,
  proposalIdOf,
  proposalSignatureBytes,
  roomBindingSignatureBytes,
  signingSessionIdOf,
  voteIdOf,
  voteSignatureBytes,
} from './treasuryTypes';
import {
  bindTreasuryDoc,
  listCheckpoints,
  listProposals,
  listSigningSessions,
  listVotes,
  pickCanonicalVote,
  putAllowanceCache,
  putChainSyncStatus,
  putCheckpoint,
  putPolicyCache,
  putProposal,
  putProposalPayload,
  putRegistration,
  putReceiptCache,
  putRoomBinding,
  putSigningSession,
  putVote,
  putWindowsCache,
  readAllowanceCache,
  readChainSyncStatus,
  readChainSyncStatusResult,
  readPolicyCache,
  readPolicyCacheResult,
  readProposal,
  readProposalPayload,
  readProposalPayloadResult,
  readReceiptCache,
  readRegistration,
  readRegistrationResult,
  readRoomBinding,
  readRoomBindingResult,
  scanProposals,
  scanSigningSessions,
  scanVotes,
  readVote,
  readWindowsCache,
  subscribeTreasury,
  treasuryDocBound,
} from './treasuryDoc';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const verifier = (pub: string, bytes: Uint8Array, sig: string): boolean => {
  try {
    return ed.verify(hexToBytes(sig), bytes, hexToBytes(pub));
  } catch {
    return false;
  }
};

const GENESIS = 'a'.repeat(64);
const seedA = new Uint8Array(32).fill(1);
const seedB = new Uint8Array(32).fill(2);
const pub = (seed: Uint8Array): string => bytesToHex(ed.getPublicKey(seed));
const sign = (seed: Uint8Array, bytes: Uint8Array): string => bytesToHex(ed.sign(bytes, seed));

function makeProposal(overrides: Partial<UnsignedTreasuryProposal> = {}): TreasuryProposal {
  const unsigned: UnsignedTreasuryProposal = {
    v: 1,
    networkGenesisChallenge: GENESIS,
    companyId: 'b'.repeat(64),
    policyVersion: 1,
    kind: 'pay',
    payloadHash: '4'.repeat(64),
    proposerPub: pub(seedA),
    ...overrides,
  };
  const proposalId = proposalIdOf(unsigned);
  return {
    ...unsigned,
    proposalId,
    proposerSig: sign(seedA, proposalSignatureBytes(unsigned.networkGenesisChallenge, proposalId)),
  };
}

function makeVote(
  seed: Uint8Array,
  voterPuzzleHash: string,
  sequence: number,
  proposalId: string,
  choice: UnsignedTreasuryVote['choice'] = 'yes',
): TreasuryVote {
  const unsigned: UnsignedTreasuryVote = {
    v: 1,
    networkGenesisChallenge: GENESIS,
    proposalId,
    voterPuzzleHash,
    voterGamePub: pub(seed),
    choice,
    sequence,
    chiaAddressProof: 'proof-placeholder',
  };
  const voteId = voteIdOf(unsigned);
  return { ...unsigned, voteId, gameSig: sign(seed, voteSignatureBytes(GENESIS, voteId)) };
}

let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  bindTreasuryDoc(doc, { verifySig: verifier, networkGenesisChallenge: GENESIS });
});

describe('proposals', () => {
  it('caps the scan when asked, so an unbounded map cannot stall a repaint', () => {
    // Each entry costs a signature check and nothing ever prunes them, so a
    // renderer must be able to stop early.
    const made = [0, 1, 2, 3].map((i) =>
      makeProposal({ payloadHash: `${i}`.repeat(64) }),
    );
    for (const p of made) expect(putProposal(p)).toBe(true);
    expect(listProposals()).toHaveLength(4); // unbounded convenience wrapper
    // The collection bound counts MATCHING keys, not records kept: capping
    // results alone would still verify every junk entry a peer planted under
    // this prefix before the cap filled up, and that is the work that stalls
    // a repaint.
    const two = scanProposals(2, 99);
    expect(two.items).toHaveLength(2);
    expect(two.truncated).toBe(true);
    expect(scanProposals(0, 99).items).toHaveLength(0);
    const all = scanProposals(99, 99);
    expect(all.items).toHaveLength(4);
    expect(all.truncated).toBe(false);
    // Junk under this prefix consumes budget rather than being had for free.
    doc.getMap('treasury').set(`proposal:${'7'.repeat(64)}`, { junk: true });
    const withJunk = scanProposals(1, 99);
    expect(withJunk.truncated).toBe(true);
    expect(withJunk.items.length).toBeLessThanOrEqual(1);
  });

  it('has exactly ONE horizon, and it is a runaway guard not a page', () => {
    // Second correction to the same rule, so the reasoning is recorded here
    // rather than rediscovered a third time.
    //
    // Any cap that stops this scan early is a horizon, and every horizon is a
    // censorship tool: whatever sits past it cannot be paged to, because
    // paging only moves within what the scan collected. Capping keys EXAMINED
    // let unrelated keys hide everything. Moving the cap to keys COLLECTED
    // just moved the horizon — planted `proposal:` keys ahead of an honest one
    // in iteration order hid it exactly as well.
    //
    // So there is one budget, on keys examined, set far above any real room.
    // The bound that decides how long a repaint BLOCKS for is the check
    // budget, which is where the signature work is.
    const m = doc.getMap('treasury');
    for (let i = 0; i < 400; i++) m.set(`junk:${i}`, { anything: i });
    const p = makeProposal();
    expect(putProposal(p)).toBe(true);
    // A generous guard — what the UI passes — finds the record behind junk.
    const roomy = scanProposals(50_000, 99);
    expect(roomy.items.map((x) => x.proposalId)).toContain(p.proposalId);
    expect(roomy.truncated).toBe(false);
    // Matching keys are NOT separately capped, so every one of them is
    // reachable by paging rather than sitting past a second horizon.
    for (let i = 0; i < 12; i++) {
      m.set(`proposal:${i.toString().padStart(64, 'b')}`, { junk: i });
    }
    const all = scanProposals(50_000, 4);
    expect(all.matched).toBe(13); // 12 planted + 1 honest, all pageable
    expect(all.truncated).toBe(true); // a page was shown, not everything
    // Walking the pages reaches the honest record wherever it sorted.
    const seen: string[] = [];
    for (let offset = 0; offset < all.matched; offset += 4) {
      seen.push(...scanProposals(50_000, 4, offset).items.map((x) => x.proposalId));
    }
    expect(seen).toContain(p.proposalId);
    // The one horizon still exists, and says so when it is hit.
    const starved = scanProposals(3, 99);
    expect(starved.truncated).toBe(true);
  });

  it('caps VERIFICATIONS separately, since traversal is not what costs', () => {
    // A traversal budget bounds how far a scan walks; it never bounded how
    // much signature work the walk does. 800 verifiable records was measured
    // at over a second of blocked main thread with a traversal budget alone.
    const made = [0, 1, 2, 3, 4, 5].map((i) =>
      makeProposal({ payloadHash: `${i}`.repeat(64) }),
    );
    for (const p of made) expect(putProposal(p)).toBe(true);
    // Traversal budget generous, check budget tight: the scan stops on checks.
    const capped = scanProposals(999, 2);
    expect(capped.items).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    // Zero checks verifies nothing at all, and says the view is partial.
    const none = scanProposals(999, 0);
    expect(none.items).toHaveLength(0);
    expect(none.truncated).toBe(true);
    // Invalid entries spend check budget too — rejecting one costs a
    // verification, so letting them go free would leave the bound useless.
    doc.getMap('treasury').set(`proposal:${'7'.repeat(64)}`, {
      ...made[0],
      proposalId: '7'.repeat(64),
    });
    const withForgery = scanProposals(999, 6);
    expect(withForgery.items.length).toBeLessThanOrEqual(6);
    // Both budgets clear: everything valid comes back, nothing is flagged.
    const full = scanProposals(999, 999);
    expect(full.items).toHaveLength(6);
    expect(full.truncated).toBe(false);
  });

  it('lets a player page past a flood instead of being censored by it', () => {
    // A check budget alone made the list censorable: the scan restarted at the
    // beginning every time, so the first maxChecks prefix-matching entries —
    // junk included, since rejecting one spends a check too — hid everything
    // after them permanently. Paging is what makes the bound survivable.
    const m = doc.getMap('treasury');
    const real = makeProposal({ payloadHash: 'e'.repeat(64) });
    expect(putProposal(real)).toBe(true);
    // Junk that sorts BEFORE the honest record, so page one is all junk.
    for (let i = 0; i < 8; i += 1) {
      m.set(`proposal:0${i.toString().padStart(63, '0')}`, { junk: i });
    }
    const first = scanProposals(500, 4, 0);
    expect(first.items).toEqual([]); // buried
    expect(first.truncated).toBe(true);
    expect(first.matched).toBe(9);
    expect(first.offset).toBe(0);
    // ...but reachable. Walk the pages until the honest record turns up.
    const seen: string[] = [];
    for (let offset = 0; offset < first.matched; offset += 4) {
      seen.push(...scanProposals(500, 4, offset).items.map((p) => p.proposalId));
    }
    expect(seen).toContain(real.proposalId);
    // The offset is clamped to what matched, so an over-run page is empty
    // rather than throwing, and reports where it actually landed.
    const past = scanProposals(500, 4, 999);
    expect(past.items).toEqual([]);
    expect(past.offset).toBe(9);
    // A page is deterministic: same offset, same records, across repaints.
    expect(scanProposals(500, 4, 4).items.map((p) => p.proposalId))
      .toEqual(scanProposals(500, 4, 4).items.map((p) => p.proposalId));
  });

  it('round-trips a signed proposal and lists it', () => {
    const p = makeProposal();
    expect(putProposal(p)).toBe(true);
    expect(readProposal(p.proposalId)).toEqual(p);
    expect(listProposals()).toEqual([p]);
  });

  it('rejects a tampered signature and a mismatched id', () => {
    const p = makeProposal();
    expect(putProposal({ ...p, proposerSig: sign(seedB, new Uint8Array([1])) })).toBe(false);
    expect(putProposal({ ...p, proposalId: 'f'.repeat(64) })).toBe(false);
    expect(readProposal(p.proposalId)).toBeNull();
  });

  it('skips hostile raw map writes on read', () => {
    const p = makeProposal();
    const m = doc.getMap('treasury');
    m.set(`proposal:${p.proposalId}`, { junk: true });
    m.set('proposal:misfiled', p); // valid record under the wrong key
    expect(readProposal(p.proposalId)).toBeNull();
    expect(listProposals()).toEqual([]);
  });

  it('stays total when a peer plants encoder-hostile strings', () => {
    const p = makeProposal();
    const m = doc.getMap('treasury');
    // A lone surrogate passes the shape guard (non-empty string) but makes
    // the canonical encoder throw — the read must treat it as invalid.
    m.set(`proposal:${p.proposalId}`, { ...p, proposerPub: '\uD800' });
    expect(readProposal(p.proposalId)).toBeNull();
    expect(listProposals()).toEqual([]);
  });

  it('a valid decoy misfiled under another id cannot block the honest put', () => {
    const a = makeProposal();
    const b = makeProposal({ payloadHash: '5'.repeat(64) }); // different, also valid
    doc.getMap('treasury').set(`proposal:${a.proposalId}`, b); // hostile misfile
    expect(readProposal(a.proposalId)).toBeNull();
    expect(putProposal(a)).toBe(true);
    expect(readProposal(a.proposalId)).toEqual(a); // decoy overwritten, not honored
    expect(putProposal(a)).toBe(true); // now genuinely idempotent
  });
});

describe('votes', () => {
  const proposalId = makeProposal().proposalId;
  const voter = '6'.repeat(64); // voterPuzzleHash (weight identity)
  const slotPub = pub(seedA); // the slot key is the AUTHENTICATED game pub

  it('round-trips and enforces the greatest-sequence slot rule', () => {
    const v1 = makeVote(seedA, voter, 1, proposalId);
    const v2 = makeVote(seedA, voter, 2, proposalId, 'no');
    expect(putVote(v1)).toBe(true);
    expect(putVote(v1)).toBe(true); // idempotent re-put
    expect(putVote(makeVote(seedA, voter, 0, proposalId))).toBe(false); // downgrade refused
    expect(readVote(proposalId, slotPub)).toEqual(v1);
    expect(putVote(v2)).toBe(true); // higher sequence replaces
    expect(readVote(proposalId, slotPub)).toEqual(v2);
    expect(listVotes(proposalId)).toEqual([v2]);
  });

  it('resolves equal sequences to the lexicographically smallest voteId', () => {
    const a = makeVote(seedA, voter, 3, proposalId, 'yes');
    const b = makeVote(seedA, voter, 3, proposalId, 'no');
    const [small, large] = a.voteId < b.voteId ? [a, b] : [b, a];
    expect(pickCanonicalVote(a, b)).toEqual(small);
    expect(putVote(large)).toBe(true);
    expect(putVote(small)).toBe(true); // smaller id wins the tie
    expect(readVote(proposalId, slotPub)).toEqual(small);
    expect(putVote(large)).toBe(false); // and cannot be displaced
  });

  it('rejects forged votes and mis-slotted records', () => {
    const v = makeVote(seedA, voter, 1, proposalId);
    expect(putVote({ ...v, choice: 'no' } as TreasuryVote)).toBe(false); // id no longer matches
    const forged = { ...v, gameSig: sign(seedB, voteSignatureBytes(GENESIS, v.voteId)) };
    expect(putVote(forged)).toBe(false); // signed by the wrong key
    doc.getMap('treasury').set(`vote:${proposalId}:${pub(seedB)}`, v);
    expect(readVote(proposalId, pub(seedB))).toBeNull(); // wrong slot
    expect(listVotes(proposalId)).toEqual([]);
  });

  it('a squatter planted in another voter slot cannot lock the honest vote out', () => {
    // Hostile raw write: attacker B self-signs a max-sequence vote and plants
    // it under A's slot key. The record cannot claim A's slot (its pub is
    // B's), so the read skips it and A's honest put overwrites it.
    const squatter = makeVote(seedB, voter, Number.MAX_SAFE_INTEGER, proposalId, 'veto');
    doc.getMap('treasury').set(`vote:${proposalId}:${slotPub}`, squatter);
    expect(readVote(proposalId, slotPub)).toBeNull();
    const honest = makeVote(seedA, voter, 1, proposalId);
    expect(putVote(honest)).toBe(true);
    expect(readVote(proposalId, slotPub)).toEqual(honest);
    expect(listVotes(proposalId)).toEqual([honest]);
  });

  it('lists one slot per voter across multiple voters', () => {
    const a = makeVote(seedA, voter, 1, proposalId);
    const b = makeVote(seedB, '7'.repeat(64), 5, proposalId, 'no');
    expect(putVote(a)).toBe(true);
    expect(putVote(b)).toBe(true);
    const listed = listVotes(proposalId);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([a, b]));
  });

  it('cross-partition concurrent slot writes converge; the recount repairs', () => {
    // Same voter, two partitioned replicas, equal-sequence conflicting votes.
    const va = makeVote(seedA, voter, 2, proposalId, 'yes');
    const vb = makeVote(seedA, voter, 2, proposalId, 'no');
    const docB = new Y.Doc();
    doc.getMap('treasury').set(`vote:${proposalId}:${slotPub}`, va);
    docB.getMap('treasury').set(`vote:${proposalId}:${slotPub}`, vb);
    // Heal the partition both ways.
    const updA = Y.encodeStateAsUpdate(doc);
    const updB = Y.encodeStateAsUpdate(docB);
    Y.applyUpdate(doc, updB);
    Y.applyUpdate(docB, updA);
    // Both replicas converge to the SAME winner — but the CRDT picks it, so
    // it may be the §7.2 loser. The signed payloads + pickCanonicalVote are
    // the recount's recovery path, and re-putting the canonical vote repairs
    // the slot on every replica.
    const surfacedA = doc.getMap('treasury').get(`vote:${proposalId}:${slotPub}`);
    const surfacedB = docB.getMap('treasury').get(`vote:${proposalId}:${slotPub}`);
    expect(surfacedA).toEqual(surfacedB);
    const canonical = pickCanonicalVote(va, vb);
    expect(canonical).toEqual(va.voteId < vb.voteId ? va : vb);
    bindTreasuryDoc(doc, { verifySig: verifier, networkGenesisChallenge: GENESIS });
    putVote(canonical);
    expect(readVote(proposalId, slotPub)).toEqual(canonical);
  });

  it('converges across two docs', () => {
    const v = makeVote(seedA, voter, 1, proposalId);
    expect(putVote(v)).toBe(true);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    bindTreasuryDoc(other, { verifySig: verifier, networkGenesisChallenge: GENESIS });
    expect(readVote(proposalId, slotPub)).toEqual(v);
  });
});

describe('policy, allowance, registration, windows, checkpoints', () => {
  it('round-trips the golden-vector policy and recomputes its hash', () => {
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    expect(putPolicyCache(policy)).toBe(true);
    const cached = readPolicyCache();
    expect(cached?.policy).toEqual(policy);
    expect(cached?.policyHash).toBe(contracts.policy.policyHash);
    expect(putPolicyCache({ ...policy, companyId: 'nope' } as CompanyTreasuryPolicy)).toBe(false);
  });

  it('stays replaceable — a planted max-version policy cannot brick the cache', () => {
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    // Hostile raw write with an absurd version: guard-valid, but it must not
    // block honest puts (invariant 5: caches are replaceable from chain
    // state; version selection is the node's job, not this layer's).
    const hostile = { ...policy, policyVersion: Number.MAX_SAFE_INTEGER };
    doc.getMap('treasury').set('policy', hostile);
    expect(putPolicyCache(policy)).toBe(true);
    expect(readPolicyCache()?.policy.policyVersion).toBe(policy.policyVersion);
  });

  it('refuses unencodable policies at put and maps them to null on read', () => {
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    // A lone surrogate passes the shape guard but not the encoder — put must
    // refuse it rather than caching a permanently unreadable entry.
    const hostile = JSON.parse(JSON.stringify(policy)) as CompanyTreasuryPolicy;
    hostile.shareClasses[0].id = '\uD800';
    expect(putPolicyCache(hostile)).toBe(false);
    doc.getMap('treasury').set('policy', hostile);
    expect(readPolicyCache()).toBeNull();
  });

  it('round-trips allowances and receipts', () => {
    const allowance = {
      v: 1,
      allowanceId: 'a'.repeat(64),
      networkGenesisChallenge: GENESIS,
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      subject: {
        kind: 'device',
        id: 'slot-machine-7',
        authorityHead: { headId: 'head-1', version: 1, scheme: 'ed25519', publicKey: 'pk' },
      },
      operations: ['casino-reserve'],
      assetId: 'xch',
      maxPerOperation: '100',
      maxPerPeriod: '500',
      maxFeeMojos: '10',
      periodBlocks: 100,
      startsAtHeight: 1,
      expiresAfterHeight: 1000,
      stateCoinLauncherId: 'c'.repeat(64),
      nonce: 'd'.repeat(64),
      policyProof: 'proof',
    } as never;
    expect(putAllowanceCache(allowance)).toBe(true);
    expect(readAllowanceCache('a'.repeat(64))).toEqual(allowance);
    const receipt = {
      v: 1,
      receiptId: 'e'.repeat(64),
      networkGenesisChallenge: GENESIS,
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      operation: 'casino-settle',
      authorization: { kind: 'allowance', allowanceId: 'a'.repeat(64) },
      requestId: 'f'.repeat(64),
      spendBundleId: '9'.repeat(64),
      assetId: 'xch',
      amount: '50',
      destinations: ['8'.repeat(64)],
    } as never;
    expect(putReceiptCache(receipt)).toBe(true);
    expect(readReceiptCache('e'.repeat(64))).toEqual(receipt);
    // Confirmation status is a replaceable attestation — same-id updates land.
    const confirmed = {
      ...(receipt as Record<string, unknown>),
      confirmedHeight: 77,
      confirmedBlockHash: '7'.repeat(64),
    } as never;
    expect(putReceiptCache(confirmed)).toBe(true);
    expect(readReceiptCache('e'.repeat(64))).toEqual(confirmed);
    // The slot is plain-replace (invariant 5): a planted same-id record can
    // never brick honest re-puts — §13.1 body immutability is enforced where
    // receipts are chain-verifiable, not by cache occupancy.
    const planted = { ...(receipt as Record<string, unknown>), amount: '9999999' } as never;
    doc.getMap('treasury').set(`receipt:${'e'.repeat(64)}`, planted);
    expect(putReceiptCache(confirmed)).toBe(true);
    expect(readReceiptCache('e'.repeat(64))).toEqual(confirmed);
  });

  it('replicates payloads content-addressed by their hash', () => {
    const payloadHex = contracts.payload.payloadHex;
    const payloadHash = contracts.payload.payloadHash;
    expect(putProposalPayload(payloadHex)).toBe(true);
    expect(readProposalPayload(payloadHash)).toBe(payloadHex);
    expect(putProposalPayload('not hex')).toBe(false);
    expect(putProposalPayload('AB')).toBe(false); // uppercase
    // A tampered raw write fails the content-address recheck.
    doc.getMap('treasury').set(`payload:${payloadHash}`, 'deadbeef');
    expect(readProposalPayload(payloadHash)).toBeNull();
  });

  it('stores registrations and windows from the golden vectors', () => {
    const registration = contracts.windows.registration as never;
    const windows = contracts.windows.derived as never;
    expect(putRegistration(registration)).toBe(true);
    expect(putWindowsCache(windows)).toBe(true);
    const proposalId = contracts.windows.registration.proposalId;
    expect(readRegistration(proposalId)).toEqual(registration);
    expect(readWindowsCache(proposalId)).toEqual(windows);
  });

  it('verifies checkpoint ids and lists per proposal', () => {
    const checkpoint: TreasuryCheckpoint = {
      ...(contracts.checkpoint.body as Omit<TreasuryCheckpoint, 'checkpointId'>),
      checkpointId: contracts.checkpoint.checkpointId,
    };
    expect(putCheckpoint(checkpoint)).toBe(true);
    expect(putCheckpoint({ ...checkpoint, voteCount: 4 })).toBe(false); // id mismatch
    expect(listCheckpoints(checkpoint.proposalId)).toEqual([checkpoint]);
    expect(putAllowanceCache({ junk: true } as never)).toBe(false);
  });
});

describe('signing sessions', () => {
  const shell = {
    v: 1 as const,
    networkGenesisChallenge: GENESIS,
    companyId: 'b'.repeat(64),
    policyVersion: 1,
    proposalId: 'c'.repeat(64),
    bundleHash: 'd'.repeat(64),
    requiredThreshold: 2,
    expiresAfterHeight: 100,
  };
  const sessionId = signingSessionIdOf(shell);
  const base: SigningSession = {
    ...shell,
    sessionId,
    collectedSigs: [{ signerPuzzleHash: 'e'.repeat(64), sig: 'sig-e' }],
  };

  it('derives session ids from the shell and refuses undeciphered ids', () => {
    expect(putSigningSession({ ...base, sessionId: 'a1'.repeat(32) })).toBe(false);
    expect(putSigningSession(base)).toBe(true);
    // A different bundleHash IS a different session (different derived id) —
    // same-id shell conflicts are structurally impossible now.
    const otherShell = { ...shell, bundleHash: '9'.repeat(64) };
    const other: SigningSession = {
      ...otherShell,
      sessionId: signingSessionIdOf(otherShell),
      collectedSigs: [],
    };
    expect(putSigningSession(other)).toBe(true);
    expect(listSigningSessions(shell.proposalId)).toHaveLength(2);
  });

  it('unions signature sets across sequential puts, sorted by signer', () => {
    // Existing signer 'f' sorts AFTER the peer's 'e', so the sorted output
    // genuinely pins the sort (insertion order alone would be f-then-e).
    expect(putSigningSession({
      ...base,
      collectedSigs: [{ signerPuzzleHash: 'f'.repeat(64), sig: 'sig-f' }],
    })).toBe(true);
    expect(putSigningSession(base)).toBe(true); // adds signer 'e'
    const merged = listSigningSessions(shell.proposalId);
    expect(merged).toHaveLength(1);
    expect(merged[0].collectedSigs).toEqual([
      { signerPuzzleHash: 'e'.repeat(64), sig: 'sig-e' },
      { signerPuzzleHash: 'f'.repeat(64), sig: 'sig-f' },
    ]);
  });

  it('CRDT sync itself unions signatures collected on partitioned replicas', () => {
    expect(putSigningSession(base)).toBe(true); // replica A holds signer 'e'
    const docB = new Y.Doc();
    bindTreasuryDoc(docB, { verifySig: verifier, networkGenesisChallenge: GENESIS });
    expect(putSigningSession({
      ...base,
      collectedSigs: [{ signerPuzzleHash: 'f'.repeat(64), sig: 'sig-f' }],
    })).toBe(true); // replica B holds signer 'f'
    // Heal the partition both ways — no application merge step runs.
    const updA = Y.encodeStateAsUpdate(doc);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, updA);
    for (const replica of [doc, docB]) {
      bindTreasuryDoc(replica, { verifySig: verifier, networkGenesisChallenge: GENESIS });
      expect(listSigningSessions(shell.proposalId)[0].collectedSigs).toEqual([
        { signerPuzzleHash: 'e'.repeat(64), sig: 'sig-e' },
        { signerPuzzleHash: 'f'.repeat(64), sig: 'sig-f' },
      ]);
    }
  });

  it('planted garbage cannot permanently shadow a signature; honest re-put restores', () => {
    doc.getMap('treasury').set(`sessionsig:${sessionId}:${'e'.repeat(64)}`, {
      signerPuzzleHash: 'e'.repeat(64),
      sig: '!',
    });
    expect(putSigningSession(base)).toBe(true); // shell + honest re-put of 'e'
    expect(listSigningSessions(shell.proposalId)[0].collectedSigs).toEqual([
      { signerPuzzleHash: 'e'.repeat(64), sig: 'sig-e' },
    ]);
    // The subtler plant: the HONEST sig string under a mismatched signer
    // field — dropped on read, so a naive value-only skip-check would let it
    // shadow the signature forever. The re-put must overwrite it.
    doc.getMap('treasury').set(`sessionsig:${sessionId}:${'e'.repeat(64)}`, {
      signerPuzzleHash: '9'.repeat(64),
      sig: 'sig-e',
    });
    expect(listSigningSessions(shell.proposalId)[0].collectedSigs).toEqual([]);
    expect(putSigningSession(base)).toBe(true);
    expect(listSigningSessions(shell.proposalId)[0].collectedSigs).toEqual([
      { signerPuzzleHash: 'e'.repeat(64), sig: 'sig-e' },
    ]);
  });

  it('a shell bloated with embedded sigs is scrubbed by an honest put', () => {
    doc.getMap('treasury').set(`session:${shell.proposalId}:${sessionId}`, {
      ...shell,
      sessionId,
      collectedSigs: [{ signerPuzzleHash: 'f'.repeat(64), sig: 'x'.repeat(1000) }],
    });
    expect(putSigningSession(base)).toBe(true);
    const stored = doc.getMap('treasury').get(`session:${shell.proposalId}:${sessionId}`);
    expect((stored as SigningSession).collectedSigs).toEqual([]); // bloat scrubbed
  });

  it('a misfiled valid session cannot brick the slot', () => {
    const otherShell = { ...shell, bundleHash: '9'.repeat(64) };
    const squatter: SigningSession = {
      ...otherShell,
      sessionId: signingSessionIdOf(otherShell),
      collectedSigs: [],
    };
    doc.getMap('treasury').set(`session:${shell.proposalId}:${sessionId}`, squatter);
    expect(listSigningSessions(shell.proposalId)).toEqual([]); // slot-claim mismatch
    expect(putSigningSession(base)).toBe(true); // overwrites the squatter
    expect(listSigningSessions(shell.proposalId)).toEqual([base]);
  });
});

describe('network pinning', () => {
  it('rejects correctly signed records from another network', () => {
    const foreign = makeProposal({ networkGenesisChallenge: 'b'.repeat(64) });
    expect(putProposal(foreign)).toBe(false); // valid signature, wrong net
    doc.getMap('treasury').set(`proposal:${foreign.proposalId}`, foreign);
    expect(readProposal(foreign.proposalId)).toBeNull();
    expect(listProposals()).toEqual([]);
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    // The vector policy's genesis is 'a'*64 == GENESIS, so it puts fine —
    // rebind to another net and the same policy is refused and unreadable.
    expect(putPolicyCache(policy)).toBe(true);
    // Read BEFORE rebinding, so the rebind has a warm cache to invalidate:
    // a verdict cached under the old pin must not survive into the new one.
    expect(readPolicyCache()?.policy).toEqual(policy);
    bindTreasuryDoc(doc, { verifySig: verifier, networkGenesisChallenge: 'f'.repeat(64) });
    expect(putPolicyCache(policy)).toBe(false);
    expect(readPolicyCache()).toBeNull();
  });

  it('fails closed before touching the map when no network is pinned', () => {
    const proposal = makeProposal();
    expect(putProposal(proposal)).toBe(true);
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    expect(putPolicyCache(policy)).toBe(true);
    expect(putChainSyncStatus({ v: 1, state: 'verified', verifiedHeight: 9 })).toBe(true);
    // An invalid pin disables the cache (a local wiring bug, not hostility).
    bindTreasuryDoc(doc, { verifySig: verifier, networkGenesisChallenge: 'not-hex' as never });
    // A room document is still attached — that is a different question from
    // whether anything may be read out of it, and callers report them apart.
    expect(treasuryDocBound()).toBe(true);
    expect(readProposal(proposal.proposalId)).toBeNull();
    expect(scanProposals(100, 100)).toEqual({
      items: [],
      truncated: false,
      refusedTooLarge: 0,
      rejected: 0,
      matched: 0,
      offset: 0,
    });
    expect(readPolicyCache()).toBeNull();
    // The sync entry carries no genesis of its own, so this is the only place
    // it can fail closed inside the cache layer.
    expect(readChainSyncStatus()).toBeNull();
  });
});

describe('verification caching', () => {
  // Each read re-derives an id or hash and verifies a signature. Repeating
  // that for records that have not changed made one repaint over a second
  // long with 800 planted proposals, so verdicts are memoized on the stored
  // object's identity. These pin the invariants that makes safe.
  it('re-checks a record a peer replaces, rather than trusting the old verdict', () => {
    const good = makeProposal();
    expect(putProposal(good)).toBe(true);
    expect(readProposal(good.proposalId)).toEqual(good);
    // Same key, different object: a forgery with the signature stripped.
    doc.getMap('treasury').set(`proposal:${good.proposalId}`, {
      ...good,
      proposerSig: sign(seedB, proposalSignatureBytes(GENESIS, good.proposalId)),
    });
    expect(readProposal(good.proposalId)).toBeNull();
    // And back again — a cached rejection must not stick to the honest record.
    doc.getMap('treasury').set(`proposal:${good.proposalId}`, { ...good });
    expect(readProposal(good.proposalId)).toEqual(good);
  });

  it('does not let one record class inherit another class’s verdict', () => {
    // A single shared memo storing bare booleans answered "has this object
    // been validated?" rather than "is this object a valid X?". The type
    // guards accept extra fields, so the same object filed under two slots
    // could take the first class's cached `true` and be handed back as the
    // second, its own shape and signature never checked.
    const p = makeProposal();
    expect(putProposal(p)).toBe(true);
    expect(readProposal(p.proposalId)).toEqual(p); // caches the proposal verdict
    // The very same object reference, filed in a vote slot by a hostile peer.
    const asVote = readProposal(p.proposalId) as unknown as TreasuryVote;
    doc.getMap('treasury').set(`vote:${p.proposalId}:${pub(seedA)}`, asVote);
    expect(readVote(p.proposalId, pub(seedA))).toBeNull();
    expect(listVotes(p.proposalId)).toEqual([]);
    expect(scanVotes(p.proposalId, 99, 99).items).toEqual([]);
    // And the proposal still reads as a proposal — scoping did not break it.
    expect(readProposal(p.proposalId)).toEqual(p);
  });

  it('keeps the slot-claim checks outside the cache', () => {
    // A session shell is judged partly on the caller's arguments. Caching that
    // against the object would let a lookup under the wrong proposal id poison
    // the verdict for the right one.
    const shell = {
      v: 1 as const,
      networkGenesisChallenge: GENESIS,
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId: 'e'.repeat(64),
      bundleHash: '7'.repeat(64),
      requiredThreshold: 2,
      expiresAfterHeight: 500,
    };
    const session: SigningSession = {
      ...shell,
      sessionId: signingSessionIdOf(shell),
      collectedSigs: [],
    };
    expect(putSigningSession(session)).toBe(true);
    // Wrong proposal id first: must miss, and must not be remembered as "bad".
    expect(listSigningSessions('f'.repeat(64))).toEqual([]);
    expect(listSigningSessions(session.proposalId)).toEqual([session]);
  });

  it('returns a stable policy result without recomputing it', () => {
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    expect(putPolicyCache(policy)).toBe(true);
    const first = readPolicyCache();
    const second = readPolicyCache();
    expect(first).not.toBeNull();
    expect(second).toBe(first); // same object: served from the memo
    expect(first?.policyHash).toBe(contracts.policy.policyHash);
    // The WRAPPER is frozen, not just the policy inside it. This exact object
    // goes to every caller, so a write to policyHash would leave later reads
    // returning a hash beside a policy it no longer describes.
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.policy)).toBe(true);
    expect(() => {
      (first as unknown as { policyHash: string }).policyHash = 'x'.repeat(64);
    }).toThrow();
    expect(readPolicyCache()?.policyHash).toBe(contracts.policy.policyHash);
  });

  it('freezes what it validates, so a cached verdict cannot outlive the bytes', () => {
    // The memo keys on object identity, which only means anything if identity
    // implies the bytes are unchanged. Without the freeze, mutating a record
    // in place after it validated kept the cache hit and had the altered
    // contents reported as signed.
    const p = makeProposal();
    expect(putProposal(p)).toBe(true);
    const held = readProposal(p.proposalId);
    expect(held).not.toBeNull();
    expect(Object.isFrozen(held)).toBe(true);
    // Strict mode (ES modules) throws rather than failing silently.
    expect(() => {
      (held as unknown as { proposerSig: string }).proposerSig = 'tampered';
    }).toThrow();
    expect(readProposal(p.proposalId)?.proposerSig).toBe(p.proposerSig);
  });

  it('counts rejected records, so a page of forgeries is not "none held"', () => {
    // A page whose every entry fails its checks is not truncated and refuses
    // nothing on size, so a panel reading only those two flags reported an
    // empty room while the room held records it had just thrown out.
    const m = doc.getMap('treasury');
    const p = makeProposal();
    expect(putProposal(p)).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      m.set(`proposal:${i.toString().padStart(64, 'c')}`, { ...p, proposerSig: 'forged' });
    }
    const scan = scanProposals(99, 99);
    expect(scan.items).toEqual([p]);
    expect(scan.rejected).toBe(3);
    expect(scan.truncated).toBe(false);
    expect(scan.refusedTooLarge).toBe(0);
    // matched sees every key, so "records are held" is distinguishable from
    // "the map is empty" even when nothing survives verification.
    expect(scan.matched).toBe(4);
    // A size refusal is NOT also counted as a rejection — they are different
    // facts and the UI words them differently.
    m.set(`proposal:${'d'.repeat(64)}`, { ...p, filler: 'x'.repeat(200_000) });
    const withBig = scanProposals(99, 99);
    expect(withBig.refusedTooLarge).toBe(1);
    expect(withBig.rejected).toBe(3);
  });

  it('gives a paged shell its approvals despite a flood of other sessions', () => {
    // The signature pass used to share one budget with unrelated sessionsig
    // keys and break the WHOLE scan on hitting it, so 800 planted signatures
    // starved the real round of its own — the exact opposite of the guarantee
    // the paging change claimed. Signatures are now chosen after the page is.
    const shell = {
      v: 1 as const,
      networkGenesisChallenge: GENESIS,
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId: 'a1'.repeat(32),
      bundleHash: '5'.repeat(64),
      requiredThreshold: 2,
      expiresAfterHeight: 800,
    };
    const session: SigningSession = {
      ...shell,
      sessionId: signingSessionIdOf(shell),
      collectedSigs: [{ signerPuzzleHash: 'e'.repeat(64), sig: 'sig-e' }],
    };
    expect(putSigningSession(session)).toBe(true);
    // Signatures for sessions that are not on this page, planted first.
    const m = doc.getMap('treasury');
    for (let i = 0; i < 300; i += 1) {
      const other = i.toString().padStart(64, '7');
      m.set(`sessionsig:${other}:${i.toString().padStart(64, '8')}`, {
        signerPuzzleHash: i.toString().padStart(64, '8'),
        sig: 'noise',
      });
    }
    const scan = scanSigningSessions(session.proposalId, 50, 10, 0);
    expect(scan.items).toHaveLength(1);
    expect(scan.items[0].collectedSigs).toEqual(session.collectedSigs);
  });

  it('lets the detail screen page past decoy rounds to the genuine one', () => {
    // The UI read page 0 only, and shells are UNSIGNED and peer-writable, so
    // a page's worth of self-consistent decoys sorted ahead of the real round
    // consumed the check budget before sessionsFor could filter them — and
    // with no next page, that round's progress was invisible for good. Same
    // hole the proposal list had; this pins the offset the screen now uses.
    const shellOf = (proposalId: string, bundle: string) => ({
      v: 1 as const,
      networkGenesisChallenge: GENESIS,
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId,
      bundleHash: bundle,
      requiredThreshold: 2,
      expiresAfterHeight: 900,
    });
    const proposalId = 'c3'.repeat(32);
    const real = shellOf(proposalId, 'f'.repeat(64));
    const realId = signingSessionIdOf(real);
    const m = doc.getMap('treasury');
    m.set(`session:${proposalId}:${realId}`, { ...real, sessionId: realId, collectedSigs: [] });
    // Decoys for the SAME proposal, so sessionsFor cannot drop them either.
    for (let i = 0; i < 8; i += 1) {
      const decoy = shellOf(proposalId, i.toString().padStart(64, '0'));
      const id = signingSessionIdOf(decoy);
      m.set(`session:${proposalId}:${id}`, { ...decoy, sessionId: id, collectedSigs: [] });
    }
    const first = scanSigningSessions(proposalId, 50_000, 3, 0);
    expect(first.matched).toBe(9);
    expect(first.truncated).toBe(true);
    const seen: string[] = [];
    for (let offset = 0; offset < first.matched; offset += 3) {
      seen.push(...scanSigningSessions(proposalId, 50_000, 3, offset).items.map((s) => s.sessionId));
    }
    expect(seen).toContain(realId);
    // Over-running the end reports where it landed rather than throwing, so
    // the screen can snap back to the last page that holds something.
    const past = scanSigningSessions(proposalId, 50_000, 3, 999);
    expect(past.items).toEqual([]);
    expect(past.offset).toBe(9);
  });

  it('caps one round’s signatures and says the set is partial', () => {
    // Signature entries are peer-writable and unverified here, so one wanted
    // session could absorb the whole scan ceiling — and every repaint would
    // then store, sort and re-validate that array. Capped per session, and
    // reported, because a partial count shown as a complete one is the same
    // invented certainty as reporting a held record as absent.
    const shell = {
      v: 1 as const,
      networkGenesisChallenge: GENESIS,
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId: 'b2'.repeat(32),
      bundleHash: '6'.repeat(64),
      requiredThreshold: 2,
      expiresAfterHeight: 900,
    };
    const sessionId = signingSessionIdOf(shell);
    const m = doc.getMap('treasury');
    m.set(`session:${shell.proposalId}:${sessionId}`, {
      ...shell, sessionId, collectedSigs: [],
    });
    for (let i = 0; i < 400; i += 1) {
      const signer = i.toString(16).padStart(64, '0');
      m.set(`sessionsig:${sessionId}:${signer}`, { signerPuzzleHash: signer, sig: `s${i}` });
    }
    const scan = scanSigningSessions(shell.proposalId, 50_000, 10, 0);
    expect(scan.items).toHaveLength(1);
    expect(scan.items[0].collectedSigs.length).toBeLessThanOrEqual(256);
    // Flagged BY SESSION, so a caveat lands on the round it belongs to
    // rather than on whichever round the screen happens to be showing.
    expect(scan.partialSessionIds).toContain(sessionId);
    // An ordinary round is not flagged.
    const doc2 = new Y.Doc();
    bindTreasuryDoc(doc2, { verifySig: verifier, networkGenesisChallenge: GENESIS });
    expect(putSigningSession({
      ...shell,
      sessionId,
      collectedSigs: [{ signerPuzzleHash: 'e'.repeat(64), sig: 'sig-e' }],
    })).toBe(true);
    expect(scanSigningSessions(shell.proposalId, 50_000, 10, 0).partialSessionIds).toEqual([]);
  });

  it('survives a value nested deeper than the call stack', () => {
    // A NODE budget does not bound call-stack DEPTH. 64,000 nested arrays cost
    // about one budget unit each — well inside the cap — while a recursive
    // walk overflows long before the budget runs out, throwing and taking the
    // render with it, exactly as the typed-array freeze did.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 60_000; i += 1) deep = [deep];
    const m = doc.getMap('treasury');
    m.set(`proposal:${'3'.repeat(64)}`, deep);
    expect(() => readProposal('3'.repeat(64))).not.toThrow();
    expect(readProposal('3'.repeat(64))).toBeNull();
    expect(() => scanProposals(99, 99)).not.toThrow();
    // A cycle terminates too, rather than walking forever.
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    m.set(`binding:room-cycle`, loop);
    expect(() => readRoomBinding('room-cycle')).not.toThrow();
    expect(readRoomBinding('room-cycle')).toBeNull();
  });

  it('lets a player page past a flood of planted approval shells', () => {
    // Session shells are UNSIGNED and peer-writable, so a check limit with no
    // paging let a peer bury the genuine round — and, when the old single pass
    // broke out of the whole loop, could put the break before that round's
    // signature entries so even a surviving shell came back without them.
    const shellOf = (bundle: string) => ({
      v: 1 as const,
      networkGenesisChallenge: GENESIS,
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId: 'f0'.repeat(32),
      bundleHash: bundle,
      requiredThreshold: 2,
      expiresAfterHeight: 700,
    });
    const real = shellOf('9'.repeat(64));
    const realSession: SigningSession = {
      ...real,
      sessionId: signingSessionIdOf(real),
      collectedSigs: [{ signerPuzzleHash: 'e'.repeat(64), sig: 'sig-e' }],
    };
    expect(putSigningSession(realSession)).toBe(true);
    // Plant self-consistent decoys until the real round is past a small page.
    const m = doc.getMap('treasury');
    for (let i = 0; i < 10; i += 1) {
      const decoy = shellOf(i.toString().padStart(64, '0'));
      const id = signingSessionIdOf(decoy);
      m.set(`session:${decoy.proposalId}:${id}`, { ...decoy, sessionId: id, collectedSigs: [] });
    }
    const found: string[] = [];
    let offset = 0;
    let matched = Number.POSITIVE_INFINITY;
    while (offset < matched) {
      const pageScan = scanSigningSessions(realSession.proposalId, 500, 3, offset);
      matched = pageScan.matched;
      found.push(...pageScan.items.map((s) => s.sessionId));
      offset += 3;
    }
    expect(found).toContain(realSession.sessionId);
    // And its signatures travel with it, whichever page it landed on.
    for (let o = 0; o < matched; o += 3) {
      const hit = scanSigningSessions(realSession.proposalId, 500, 3, o).items
        .find((s) => s.sessionId === realSession.sessionId);
      if (hit) expect(hit.collectedSigs).toEqual(realSession.collectedSigs);
    }
  });

  it('survives a peer storing binary in a treasury slot', () => {
    // Object.freeze THROWS on an ArrayBuffer view with elements, and Yjs will
    // store a Uint8Array a peer puts in a slot. Because the freeze runs before
    // any shape guard, one binary value used to abort the whole read — and
    // with it the treasury render — instead of being rejected.
    const p = makeProposal();
    expect(putProposal(p)).toBe(true);
    const m = doc.getMap('treasury');
    m.set(`proposal:${'8'.repeat(64)}`, new Uint8Array([1, 2, 3]));
    m.set(`binding:room-bin`, new Uint8Array([4, 5, 6]));
    expect(() => readProposal('8'.repeat(64))).not.toThrow();
    expect(readProposal('8'.repeat(64))).toBeNull();
    expect(() => readRoomBinding('room-bin')).not.toThrow();
    expect(readRoomBinding('room-bin')).toBeNull();
    // The scan walks past it and still returns the honest record beside it.
    expect(() => scanProposals(99, 99)).not.toThrow();
    expect(scanProposals(99, 99).items).toEqual([p]);
    // An EMPTY typed array does not throw on freeze, so cover both shapes.
    m.set(`proposal:${'9'.repeat(64)}`, new Uint8Array());
    expect(() => listProposals()).not.toThrow();
  });

  it('keeps held-but-unusable apart from absent in every reader', () => {
    // One rule, applied everywhere rather than in the slot that happened to
    // be reviewed: a record the room HOLDS is never reported as one that does
    // not exist, whatever made it unusable.
    const m = doc.getMap('treasury');
    const id = 'c'.repeat(64);
    // Registrations: a record filed under a key it does not claim.
    expect(readRegistrationResult(id).status).toBe('absent');
    m.set(`registration:${id}`, { nonsense: true });
    expect(readRegistrationResult(id).status).toBe('unreadable');
    // Payloads: absent, mismatched fingerprint, and over the local cap.
    const hash = '4'.repeat(64);
    expect(readProposalPayloadResult(hash).status).toBe('absent');
    m.set(`payload:${hash}`, 'ab'.repeat(8));
    expect(readProposalPayloadResult(hash).status).toBe('unreadable');
    m.set(`payload:${hash}`, 'a'.repeat(600 * 1024));
    expect(readProposalPayloadResult(hash).status).toBe('too-large');
    // Sync: somebody wrote here, and it could not be read.
    expect(readChainSyncStatusResult().status).toBe('absent');
    m.set('sync', { v: 1, state: 'bogus' });
    expect(readChainSyncStatusResult().status).toBe('unreadable');
    expect(putChainSyncStatus({ v: 1, state: 'verified', verifiedHeight: 7 })).toBe(true);
    expect(readChainSyncStatusResult().status).toBe('ok');
    // The plain readers keep their old contract for callers that only want
    // the value, so nothing had to change at the call sites that do.
    expect(readRegistration(id)).toBeNull();
    expect(readProposalPayload(hash)).toBeNull();
  });

  it('bounds the signing-session put like every other put', () => {
    // isSigningSession walks collectedSigs and allocates for its distinctness
    // check, so behind it a size guard bounds nothing — and the READ side does
    // bound the shell, so an unbounded put could write a session that then
    // read back as too-large forever.
    const shell = {
      v: 1 as const,
      networkGenesisChallenge: GENESIS,
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId: 'd'.repeat(64),
      bundleHash: '7'.repeat(64),
      requiredThreshold: 2,
      expiresAfterHeight: 900,
    };
    const huge: SigningSession = {
      ...shell,
      sessionId: signingSessionIdOf(shell),
      collectedSigs: Array.from({ length: 400 }, (_unused, i) => ({
        signerPuzzleHash: i.toString(16).padStart(64, '0'),
        sig: 'z'.repeat(400),
      })),
    };
    expect(putSigningSession(huge)).toBe(false);
    // An ordinary session is unaffected.
    const ok: SigningSession = { ...shell, sessionId: signingSessionIdOf(shell), collectedSigs: [] };
    expect(putSigningSession(ok)).toBe(true);
  });

  it('reports a record refused on size as refused, not as absent', () => {
    // The size cap is this device's decision, so a protocol-valid record that
    // trips it is still a record the room is holding. Collapsing it into the
    // same null as a missing record had the UI say NO DATA about it.
    const huge = 'x'.repeat(200_000);
    const p = makeProposal();
    const m = doc.getMap('treasury');
    m.set(`binding:room-big`, { roomId: 'room-big', filler: huge });
    expect(readRoomBindingResult('room-big').status).toBe('too-large');
    // Absent, unreadable and too-large stay three different answers.
    expect(readRoomBindingResult('room-missing').status).toBe('absent');
    m.set('binding:room-junk', { roomId: 'room-junk', nonsense: true });
    expect(readRoomBindingResult('room-junk').status).toBe('unreadable');
    // Scans count refusals rather than silently dropping them.
    expect(putProposal(p)).toBe(true);
    m.set(`proposal:${'a5'.repeat(32)}`, { proposalId: 'a5'.repeat(32), filler: huge });
    const scan = scanProposals(99, 99);
    expect(scan.refusedTooLarge).toBe(1);
    expect(scan.items).toEqual([p]); // the honest one still lists
  });

  it('freezes NESTED data even when the caller froze only the top level', () => {
    // Object.isFrozen is shallow, so using it as the walk's early-out skipped
    // the children of anything already frozen. A caller can hand in exactly
    // that — Object.freeze(policy) leaves policy.board and policy.shareClasses
    // mutable — and the hash would then be cached over a value whose insides
    // could still change, which is the stale fingerprint the freeze prevents.
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    const shallow = Object.freeze({
      ...policy,
      board: { ...policy.board, signerPuzzleHashes: [...policy.board.signerPuzzleHashes] },
      shareClasses: policy.shareClasses.map((c) => ({ ...c })),
    }) as CompanyTreasuryPolicy;
    expect(Object.isFrozen(shallow)).toBe(true);
    expect(Object.isFrozen(shallow.board)).toBe(false); // the hole
    expect(putPolicyCache(shallow)).toBe(true);
    const first = readPolicyCache();
    expect(first?.policyHash).toBe(contracts.policy.policyHash);
    // Everything under it is frozen too, so the hash cannot go stale.
    expect(Object.isFrozen(shallow.board)).toBe(true);
    expect(Object.isFrozen(shallow.shareClasses)).toBe(true);
    expect(Object.isFrozen(shallow.shareClasses[0])).toBe(true);
    expect(() => {
      (shallow.board as { threshold: number }).threshold = 99;
    }).toThrow();
    expect(readPolicyCache()?.policy.board.threshold).toBe(policy.board.threshold);
  });

  it('refuses a record too large to be worth checking, in constant time', () => {
    // Capping array counts was not enough: every string field here is checked
    // with isNonEmptyString and has no length limit, so ONE record with a huge
    // string still dragged the encoder and hash across it before rejection.
    const huge = 'x'.repeat(200_000);
    const p = makeProposal();
    doc.getMap('treasury').set(`proposal:${p.proposalId}`, { ...p, proposerPub: huge });
    const t0 = performance.now();
    expect(readProposal(p.proposalId)).toBeNull();
    // The point is the early-out: the refusal costs the budget, not the
    // record's own size. Generous bound so the assertion is about the
    // algorithm rather than the machine it runs on.
    expect(performance.now() - t0).toBeLessThan(100);
    // An honest record of ordinary size is unaffected.
    expect(putProposal(p)).toBe(true);
    expect(readProposal(p.proposalId)).toEqual(p);
  });

  it('refuses a policy too large to validate, at both put and read', () => {
    // The memo cannot save this one: every peer REWRITE is a new object and
    // so a fresh miss, and validating plus hashing 20,000 share classes was
    // measured at 627 ms — on the repaint path, repeatable at will. Counting
    // lengths first costs nothing and turns it into an immediate refusal.
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    const oversized = {
      ...policy,
      shareClasses: Array.from({ length: 300 }, (_unused, i) => ({
        ...policy.shareClasses[0],
        id: `class-${i}`,
      })),
    } as CompanyTreasuryPolicy;
    expect(putPolicyCache(oversized)).toBe(false);
    // A hostile peer writes past put() anyway, so the read must refuse too.
    doc.getMap('treasury').set('policy', oversized);
    expect(readPolicyCache()).toBeNull();
    // The cap is far above anything real: the golden vector is well inside it.
    expect(putPolicyCache(policy)).toBe(true);
    expect(readPolicyCache()?.policy).toEqual(policy);
  });

  it('never reports a held-but-refused policy as an absent one', () => {
    // The size cap is a local display decision, not a protocol rule, so a
    // policy that is perfectly valid on the wire can trip it. Answering that
    // with the same silence as a missing record would have the UI say "no
    // company policy" about a policy the room is holding right now.
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    expect(readPolicyCacheResult().status).toBe('absent');
    doc.getMap('treasury').set('policy', {
      ...policy,
      shareClasses: [{ ...policy.shareClasses[0], id: 'y'.repeat(200_000) }],
    });
    expect(readPolicyCacheResult().status).toBe('too-large');
    doc.getMap('treasury').set('policy', { nonsense: true });
    expect(readPolicyCacheResult().status).toBe('unreadable');
    expect(putPolicyCache(policy)).toBe(true);
    expect(readPolicyCacheResult().status).toBe('ok');
    // All three non-ok states still read as "nothing usable" for callers that
    // only want the policy, so the convenience form keeps its contract.
    doc.getMap('treasury').set('policy', { nonsense: true });
    expect(readPolicyCache()).toBeNull();
  });
});

describe('bindings, receipts, sync status, and lifecycle', () => {
  it('verifies room bindings signed by boundByPub', () => {
    const unsigned: Omit<RoomTreasuryBinding, 'sig'> = {
      v: 1,
      networkGenesisChallenge: GENESIS,
      roomId: 'room-42',
      companyId: 'b'.repeat(64),
      treasuryLauncherId: 'c'.repeat(64),
      policyVersion: 1,
      profileId: 'profile-1',
      boundByPub: pub(seedA),
      boundAtHeight: 10,
      policyReceiptId: 'd'.repeat(64),
    };
    const binding: RoomTreasuryBinding = {
      ...unsigned,
      sig: sign(seedA, roomBindingSignatureBytes(unsigned)),
    };
    expect(putRoomBinding(binding)).toBe(true);
    expect(readRoomBinding('room-42')).toEqual(binding);
    expect(putRoomBinding({ ...binding, boundAtHeight: 11 })).toBe(false); // sig no longer covers
  });

  it('stores sync status, rejects malformed status, and notifies subscribers', () => {
    let notified = 0;
    const unsubscribe = subscribeTreasury(() => { notified += 1; });
    expect(putChainSyncStatus({ v: 1, state: 'verified', verifiedHeight: 123 })).toBe(true);
    // The genesis is stamped by the writer from the active pin, so callers
    // cannot forget the field the read side needs to reject another chain.
    expect(readChainSyncStatus()).toEqual({
      v: 1,
      networkGenesisChallenge: GENESIS,
      state: 'verified',
      verifiedHeight: 123,
    });
    expect(putChainSyncStatus({ v: 1, state: 'bogus' } as never)).toBe(false);
    expect(putChainSyncStatus({ v: 1, state: 'verified', verifiedHeight: -1 } as never)).toBe(false);
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
  });

  it('refuses a chain-view claim about another network', () => {
    // This entry is the ONLY cache value used as a clock — its height drives
    // every proposal's phase and the funding record's has-it-ended text. It
    // was also the one record the pin could not reject, because it carried no
    // genesis, so a peer on another chain could supply the height this room
    // reasons with.
    const m = doc.getMap('treasury');
    m.set('sync', {
      v: 1,
      networkGenesisChallenge: 'f'.repeat(64),
      state: 'verified',
      verifiedHeight: 9_999_999,
    });
    // Held, and not about this chain: reported as unreadable, never as a
    // height to reason with, and never as "nobody has said anything".
    expect(readChainSyncStatusResult().status).toBe('unreadable');
    expect(readChainSyncStatus()).toBeNull();
  });

  it('notifies subscribers on remote updates too', () => {
    const remote = new Y.Doc();
    remote.getMap('treasury').set('sync', {
      v: 1,
      networkGenesisChallenge: GENESIS,
      state: 'degraded',
    });
    let notified = 0;
    const unsubscribe = subscribeTreasury(() => { notified += 1; });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
    expect(notified).toBeGreaterThan(0);
    expect(readChainSyncStatus()).toEqual({
      v: 1,
      networkGenesisChallenge: GENESIS,
      state: 'degraded',
    });
    unsubscribe();
  });

  it('fails loudly when the doc is destroyed instead of pretending to cache', () => {
    doc.destroy();
    expect(treasuryDocBound()).toBe(false);
    expect(putProposal(makeProposal())).toBe(false);
    expect(readProposal('f'.repeat(64))).toBeNull();
    expect(listVotes('f'.repeat(64))).toEqual([]);
  });
});
