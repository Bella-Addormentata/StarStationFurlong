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
  readPolicyCache,
  readProposal,
  readProposalPayload,
  readReceiptCache,
  readRegistration,
  readRoomBinding,
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
    expect(listProposals()).toHaveLength(4); // no cap given
    expect(listProposals(2)).toHaveLength(2);
    expect(listProposals(0)).toHaveLength(0); // the cap is exact
    // A cap larger than the set still returns everything.
    expect(listProposals(99)).toHaveLength(4);
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
    bindTreasuryDoc(doc, { verifySig: verifier, networkGenesisChallenge: 'f'.repeat(64) });
    expect(putPolicyCache(policy)).toBe(false);
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
    expect(readChainSyncStatus()).toEqual({ v: 1, state: 'verified', verifiedHeight: 123 });
    expect(putChainSyncStatus({ v: 1, state: 'bogus' } as never)).toBe(false);
    expect(putChainSyncStatus({ v: 1, state: 'verified', verifiedHeight: -1 } as never)).toBe(false);
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
  });

  it('notifies subscribers on remote updates too', () => {
    const remote = new Y.Doc();
    remote.getMap('treasury').set('sync', { v: 1, state: 'degraded' });
    let notified = 0;
    const unsubscribe = subscribeTreasury(() => { notified += 1; });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
    expect(notified).toBeGreaterThan(0);
    expect(readChainSyncStatus()).toEqual({ v: 1, state: 'degraded' });
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
