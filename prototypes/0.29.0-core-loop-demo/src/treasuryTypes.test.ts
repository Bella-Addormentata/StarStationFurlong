// PR B unit tests: canonical encoding stability, golden-vector conformance
// (shared with ssf-p2p-node/src/treasury_codec.rs), guard rejection of
// malformed input, and hash sensitivity. Regenerate vectors with
// `node test-vectors/treasury/generate.mjs` when contracts change — the
// generator self-checks the primitive cases against RFC 8949 Appendix A.

import { describe, expect, it } from 'vitest';
import cborCases from '../test-vectors/treasury/canonical-cbor.json';
import contracts from '../test-vectors/treasury/treasury-contracts.json';
import {
  type CanonicalValue,
  type CompanyTreasuryPolicy,
  type DeviceAllowance,
  type GovernanceKindRule,
  type MerkleStep,
  compareMojoStrings,
  isCompanyTreasuryPolicy,
  isDeviceAllowance,
  isProposalRegistration,
  isProposalWindows,
  isRoomTreasuryBinding,
  isShareClassPolicy,
  isSigningSession,
  isTreasuryCheckpoint,
  isTreasuryProposal,
  isTreasuryReceipt,
  isTreasuryVote,
  isUnsignedTreasuryVote,
  payloadHashOf,
  roomBindingSignatureBytes,
  voteSignatureBytes,
  type ProposalRegistration,
  type TreasuryProposalKind,
  type UnsignedTreasuryProposal,
  type UnsignedTreasuryVote,
  canonicalEncode,
  canonicalHashHex,
  checkpointIdOf,
  deriveProposalWindows,
  governanceRuleHashOf,
  isBlockHeight,
  isGovernanceKindRule,
  isHex32,
  isMojoString,
  isPolicyVersion,
  policyHashOf,
  proposalIdOf,
  proposalSignatureBytes,
  sortedSet,
  verifyVoteInclusion,
  voteIdOf,
  voteInclusionStepsOf,
  voteRootOf,
} from './treasuryTypes';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('canonical CBOR golden vectors', () => {
  for (const c of cborCases as { name: string; value: CanonicalValue; hex: string; sha256: string }[]) {
    it(`encodes ${c.name}`, () => {
      expect(hex(canonicalEncode(c.value))).toBe(c.hex);
      expect(canonicalHashHex(c.value)).toBe(c.sha256);
    });
  }

  it('is stable across repeated encodings', () => {
    const value = { z: [1, 'two', null], a: { nested: true } };
    expect(hex(canonicalEncode(value))).toBe(hex(canonicalEncode(value)));
  });

  it('encodes maps identically regardless of insertion order', () => {
    expect(hex(canonicalEncode({ b: 1, a: 2 }))).toBe(hex(canonicalEncode({ a: 2, b: 1 })));
  });

  it('rejects floats, unsafe integers, and undefined values', () => {
    expect(() => canonicalEncode(1.5)).toThrow();
    expect(() => canonicalEncode(Number.NaN)).toThrow();
    expect(() => canonicalEncode(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => canonicalEncode({ a: undefined } as unknown as CanonicalValue)).toThrow();
  });

  it('rejects unpaired surrogates but accepts well-formed non-ASCII', () => {
    expect(() => canonicalEncode('\uD800')).toThrow();
    expect(() => canonicalEncode('a\uDC00b')).toThrow();
    expect(() => canonicalEncode({ key: '\uDBFF' } as CanonicalValue)).toThrow();
    expect(() => canonicalEncode({ ['\uD800']: 1 } as CanonicalValue)).toThrow();
    expect(() => canonicalEncode('🚀')).not.toThrow();
  });

  it('rejects non-plain objects that would encode as their enumerable fields', () => {
    expect(() => canonicalEncode(new Date() as unknown as CanonicalValue)).toThrow();
    expect(() => canonicalEncode(new Map() as unknown as CanonicalValue)).toThrow();
    expect(() => canonicalEncode(Object.create(null) as CanonicalValue)).not.toThrow();
  });
});

describe('contract golden vectors (TS<->Rust parity fixtures)', () => {
  it('reproduces the policy hash', () => {
    const policy = contracts.policy.value as CompanyTreasuryPolicy;
    expect(policyHashOf(policy)).toBe(contracts.policy.policyHash);
  });

  it('reproduces the governance rule hash', () => {
    expect(
      governanceRuleHashOf(
        contracts.governanceRule.kind as TreasuryProposalKind,
        contracts.governanceRule.rule as GovernanceKindRule,
      ),
    ).toBe(contracts.governanceRule.governanceRuleHash);
  });

  it('reproduces the proposal id and signature bytes', () => {
    const unsigned = contracts.proposal.unsigned as UnsignedTreasuryProposal;
    expect(proposalIdOf(unsigned)).toBe(contracts.proposal.proposalId);
    expect(
      hex(proposalSignatureBytes(unsigned.networkGenesisChallenge, contracts.proposal.proposalId)),
    ).toBe(contracts.proposal.signatureBytesHex);
  });

  it('reproduces the vote signature bytes', () => {
    const unsigned = contracts.vote.unsigned as UnsignedTreasuryVote;
    expect(hex(voteSignatureBytes(unsigned.networkGenesisChallenge, contracts.vote.voteId))).toBe(
      contracts.vote.signatureBytesHex,
    );
  });

  it('reproduces the payload content address and rejects non-byte hex', () => {
    expect(payloadHashOf(contracts.payload.payloadHex)).toBe(contracts.payload.payloadHash);
    expect(() => payloadHashOf('')).toThrow();
    expect(() => payloadHashOf('abc')).toThrow(); // odd length
    expect(() => payloadHashOf('AB')).toThrow(); // uppercase
  });

  it('reproduces the vote id, vote root, and checkpoint id', () => {
    expect(voteIdOf(contracts.vote.unsigned as UnsignedTreasuryVote)).toBe(contracts.vote.voteId);
    expect(voteRootOf(contracts.voteTree.voteIds)).toBe(contracts.voteTree.voteRoot);
    expect(voteRootOf([contracts.vote.voteId])).toBe(contracts.voteTree.singleLeafRoot);
    expect(checkpointIdOf(contracts.checkpoint.body as never)).toBe(
      contracts.checkpoint.checkpointId,
    );
  });

  it('derives identical proposal windows from the registration and rule', () => {
    const derived = deriveProposalWindows(
      contracts.windows.registration as ProposalRegistration,
      contracts.windows.rule as GovernanceKindRule,
    );
    expect(derived).toEqual(contracts.windows.derived);
    // The snapshot rule: pinned at the registration's confirmation height.
    expect(derived.snapshotHeight).toBe(derived.acceptedHeight);
  });

  it('sorts set-semantics arrays by canonical encoded bytes', () => {
    expect(sortedSet(contracts.sortedSet.input)).toEqual(contracts.sortedSet.output);
  });
});

describe('hash sensitivity', () => {
  const unsigned = contracts.proposal.unsigned as UnsignedTreasuryProposal;

  it('changes the proposal id when any field changes', () => {
    const base = proposalIdOf(unsigned);
    expect(proposalIdOf({ ...unsigned, policyVersion: 2 })).not.toBe(base);
    expect(proposalIdOf({ ...unsigned, kind: 'dissolve' })).not.toBe(base);
    const flipped = unsigned.payloadHash.replace(/^4/, '5');
    expect(proposalIdOf({ ...unsigned, payloadHash: flipped })).not.toBe(base);
  });

  it('binds ids to the network genesis challenge (testnet/mainnet separation)', () => {
    const otherNet = '9'.repeat(64);
    expect(proposalIdOf({ ...unsigned, networkGenesisChallenge: otherNet })).not.toBe(
      proposalIdOf(unsigned),
    );
  });

  it('treats an own __proto__ governance kind as an ordinary map key', () => {
    const raw = JSON.stringify(contracts.policy.value);
    expect(policyHashOf(JSON.parse(raw))).toBe(contracts.policy.policyHash);
    // JSON.parse creates "__proto__" as an own data property; it must flow
    // into the hash like any other kind (as Rust's map does), not vanish into
    // the accumulator's prototype.
    const tampered = JSON.parse(
      raw.replace(
        '"governanceRules":{',
        `"governanceRules":{"__proto__":${JSON.stringify(contracts.governanceRule.rule)},`,
      ),
    ) as CompanyTreasuryPolicy;
    expect(Object.keys(tampered.governanceRules)).toContain('__proto__');
    expect(() => policyHashOf(tampered)).not.toThrow();
    expect(policyHashOf(tampered)).not.toBe(contracts.policy.policyHash);
  });
});

describe('vote inclusion proofs', () => {
  const ids = contracts.voteTree.voteIds;
  const root = contracts.voteTree.voteRoot;

  it('builds a verifying proof for every leaf', () => {
    for (const id of ids) {
      const steps = voteInclusionStepsOf(ids, id);
      expect(verifyVoteInclusion(id, steps, root)).toBe(true);
    }
  });

  it('rejects a proof against the wrong root or the wrong vote', () => {
    const steps = voteInclusionStepsOf(ids, ids[0]);
    expect(verifyVoteInclusion(ids[0], steps, '0'.repeat(64))).toBe(false);
    expect(verifyVoteInclusion(ids[1], steps, root)).toBe(false);
  });

  it('refuses an empty checkpoint and unknown targets', () => {
    expect(() => voteRootOf([])).toThrow();
    expect(() => voteInclusionStepsOf(ids, 'f'.repeat(64))).toThrow();
  });

  it('rejects malformed ids, oversized proofs, and unknown step sides', () => {
    expect(() => voteInclusionStepsOf(['aa'], 'aa')).toThrow();
    expect(() => voteInclusionStepsOf([...ids, 'A'.repeat(64)], ids[0])).toThrow();
    // The smallest sorted leaf's proof is all 'right' steps, so an unknown
    // side that silently defaulted to 'right' would still verify — it must not.
    const sorted = [...ids].sort();
    const proof = voteInclusionStepsOf(ids, sorted[0]);
    const mangled = proof.map((s) => ({ ...s, side: 'up' as MerkleStep['side'] }));
    expect(verifyVoteInclusion(sorted[0], mangled, root)).toBe(false);
    const oversized = Array.from({ length: 65 }, () => ({
      side: 'left' as const,
      hash: '0'.repeat(64),
    }));
    expect(verifyVoteInclusion(sorted[0], oversized, root)).toBe(false);
    // Gossip-decoded JSON can hold anything — the verifier must stay total.
    expect(verifyVoteInclusion(sorted[0], [null] as unknown as MerkleStep[], root)).toBe(false);
    expect(verifyVoteInclusion(sorted[0], 'nope' as unknown as MerkleStep[], root)).toBe(false);
  });
});

describe('guards', () => {
  it('isMojoString accepts bounded u64 decimal strings only', () => {
    expect(isMojoString('0')).toBe(true);
    expect(isMojoString('1')).toBe(true);
    expect(isMojoString('999999999999')).toBe(true);
    expect(isMojoString('18446744073709551615')).toBe(true); // u64::MAX
    expect(isMojoString('18446744073709551616')).toBe(false); // u64::MAX + 1
    expect(isMojoString('99999999999999999999')).toBe(false); // 20 digits over max
    expect(isMojoString('123456789012345678901')).toBe(false); // 21 digits
    expect(isMojoString('')).toBe(false);
    expect(isMojoString('01')).toBe(false);
    expect(isMojoString('-1')).toBe(false);
    expect(isMojoString('1.5')).toBe(false);
    expect(isMojoString('1e5')).toBe(false);
    expect(isMojoString(5 as unknown)).toBe(false);
    expect(isMojoString(null)).toBe(false);
  });

  it('isPolicyVersion requires a safe integer >= 1', () => {
    expect(isPolicyVersion(1)).toBe(true);
    expect(isPolicyVersion(0)).toBe(false);
    expect(isPolicyVersion(-1)).toBe(false);
    expect(isPolicyVersion(1.5)).toBe(false);
    expect(isPolicyVersion('1')).toBe(false);
  });

  it('isHex32 requires 64 lowercase hex characters', () => {
    expect(isHex32('a'.repeat(64))).toBe(true);
    expect(isHex32('A'.repeat(64))).toBe(false);
    expect(isHex32('a'.repeat(63))).toBe(false);
    expect(isHex32('g'.repeat(64))).toBe(false);
  });

  it('isBlockHeight and isGovernanceKindRule reject malformed values', () => {
    expect(isBlockHeight(0)).toBe(true);
    expect(isBlockHeight(-1)).toBe(false);
    expect(isBlockHeight(1.5)).toBe(false);
    expect(isGovernanceKindRule(contracts.governanceRule.rule)).toBe(true);
    expect(isGovernanceKindRule({ ...contracts.governanceRule.rule, vetoBps: 10001 })).toBe(false);
    expect(isGovernanceKindRule({ ...contracts.governanceRule.rule, passRule: 'plurality' })).toBe(false);
    expect(isGovernanceKindRule({ ...contracts.governanceRule.rule, votingBlocks: -1 })).toBe(false);
  });
});

describe('contract guards', () => {
  const policy = contracts.policy.value as CompanyTreasuryPolicy;
  const clonePolicy = (): Record<string, unknown> & { board: { threshold: number; signerPuzzleHashes: string[] }; shareClasses: Record<string, unknown>[]; governanceRules: Record<string, unknown> } =>
    JSON.parse(JSON.stringify(policy));

  it('isCompanyTreasuryPolicy accepts the golden-vector policy', () => {
    expect(isCompanyTreasuryPolicy(policy)).toBe(true);
    expect(isCompanyTreasuryPolicy(JSON.parse(JSON.stringify(policy)))).toBe(true);
  });

  it('isCompanyTreasuryPolicy rejects structural violations', () => {
    expect(isCompanyTreasuryPolicy(null)).toBe(false);
    expect(isCompanyTreasuryPolicy([])).toBe(false);
    let p = clonePolicy();
    p.board.threshold = p.board.signerPuzzleHashes.length + 1;
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.board.threshold = 0;
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.board.signerPuzzleHashes.push(p.board.signerPuzzleHashes[0]);
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.board.signerPuzzleHashes = [];
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.companyId = 'not-hex';
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    delete p.governanceRules.pay;
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.governanceRules.bribe = p.governanceRules.pay;
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    (p.governanceRules.pay as Record<string, unknown>).vetoBps = 10001;
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.shareClasses[0].votesPerWholeShare = -1;
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.shareClasses.push({ ...p.shareClasses[0] });
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.shareClasses = [];
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.maxFeeMojos = '01';
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.emergencyPolicyHash = 'xyz';
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.shareClasses[0].assetId = 'zzz-not-a-cat-id';
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
    p = clonePolicy();
    p.shareClasses.push({ ...p.shareClasses[0], id: 'preferred' }); // same assetId
    expect(isCompanyTreasuryPolicy(p)).toBe(false);
  });

  it('isCompanyTreasuryPolicy rejects a JSON-parsed own __proto__ governance kind', () => {
    const raw = JSON.stringify(policy);
    const rule = JSON.stringify(contracts.governanceRule.rule);
    // As an unknown 10th kind alongside the nine real ones...
    const extra = JSON.parse(raw.replace('"governanceRules":{', `"governanceRules":{"__proto__":${rule},`));
    expect(isCompanyTreasuryPolicy(extra)).toBe(false);
    // ...and as a replacement for a required kind.
    const replaced = JSON.parse(raw.replace('"pay":', '"__proto__":'));
    expect(isCompanyTreasuryPolicy(replaced)).toBe(false);
  });

  const validAllowance: DeviceAllowance = {
    v: 1,
    allowanceId: 'a'.repeat(64),
    networkGenesisChallenge: 'b'.repeat(64),
    companyId: 'c'.repeat(64),
    policyVersion: 1,
    subject: {
      kind: 'device',
      id: 'slot-machine-7',
      authorityHead: { headId: 'head-1', version: 1, scheme: 'ed25519', publicKey: 'd'.repeat(64) },
    },
    operations: ['casino-reserve', 'casino-settle', 'casino-refund'],
    assetId: 'xch',
    maxPerOperation: '1000000',
    maxPerPeriod: '5000000',
    maxFeeMojos: '50000',
    periodBlocks: 4608,
    startsAtHeight: 100,
    expiresAfterHeight: 500000,
    stateCoinLauncherId: 'e'.repeat(64),
    nonce: 'f'.repeat(64),
    policyProof: 'proof',
  };

  it('isDeviceAllowance accepts a valid allowance and its JSON round-trip', () => {
    expect(isDeviceAllowance(validAllowance)).toBe(true);
    expect(isDeviceAllowance(JSON.parse(JSON.stringify(validAllowance)))).toBe(true);
  });

  it('isDeviceAllowance rejects malformed capability records', () => {
    const cloneAllowance = (): Record<string, unknown> => JSON.parse(JSON.stringify(validAllowance));
    let a = cloneAllowance();
    a.operations = [];
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.operations = ['casino-reserve', 'mint-money'];
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.operations = ['casino-reserve', 'casino-reserve'];
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.maxPerOperation = '9000000'; // exceeds maxPerPeriod
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.maxPerPeriod = '18446744073709551616'; // > u64::MAX
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    (a.subject as Record<string, unknown>).kind = 'furniture';
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    ((a.subject as Record<string, unknown>).authorityHead as Record<string, unknown>).scheme = 'rsa';
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    ((a.subject as Record<string, unknown>).authorityHead as Record<string, unknown>).version = 0;
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.periodBlocks = 0;
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.expiresAfterHeight = 100; // == startsAtHeight
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.destinationPuzzleHashes = [];
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.destinationPuzzleHashes = ['not-hex'];
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.destinationPuzzleHashes = ['9'.repeat(64), '9'.repeat(64)];
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.assetId = 'BTC';
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.roomId = '';
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.policyProof = '';
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    ((a.subject as Record<string, unknown>).authorityHead as Record<string, unknown>).headId = '';
    expect(isDeviceAllowance(a)).toBe(false);
    a = cloneAllowance();
    a.startsAtHeight = -1;
    expect(isDeviceAllowance(a)).toBe(false);
  });

  it('record guards accept vector-shaped records and reject mutations', () => {
    const unsignedVote = contracts.vote.unsigned;
    expect(isUnsignedTreasuryVote(unsignedVote)).toBe(true);
    const vote = { ...unsignedVote, voteId: contracts.vote.voteId, gameSig: 'sig' };
    expect(isTreasuryVote(vote)).toBe(true);
    expect(isTreasuryVote({ ...vote, sequence: -1 })).toBe(false);
    expect(isTreasuryVote({ ...vote, choice: 'maybe' })).toBe(false);
    expect(isTreasuryVote({ ...vote, gameSig: '' })).toBe(false);

    const proposal = {
      ...contracts.proposal.unsigned,
      proposalId: contracts.proposal.proposalId,
      proposerSig: 'sig',
    };
    expect(isTreasuryProposal(proposal)).toBe(true);
    expect(isTreasuryProposal({ ...proposal, kind: 'coup' })).toBe(false);
    expect(isTreasuryProposal({ ...proposal, proposalId: 'short' })).toBe(false);

    const checkpoint = {
      ...contracts.checkpoint.body,
      checkpointId: contracts.checkpoint.checkpointId,
    };
    expect(isTreasuryCheckpoint(checkpoint)).toBe(true);
    expect(isTreasuryCheckpoint({ ...checkpoint, voteCount: 0 })).toBe(false);
    expect(isTreasuryCheckpoint({ ...checkpoint, confirmedHeight: -1 })).toBe(false);

    expect(isProposalRegistration(contracts.windows.registration)).toBe(true);
    expect(isProposalRegistration({ ...contracts.windows.registration, acceptedHeight: 1.5 })).toBe(false);
    expect(isProposalWindows(contracts.windows.derived)).toBe(true);
    expect(isProposalWindows({ ...contracts.windows.derived, votingEndsHeight: 0 })).toBe(false); // non-monotonic
    expect(isProposalWindows({ ...contracts.windows.derived, snapshotHeight: 1 })).toBe(false); // v1 pin broken
    expect(isProposalWindows({ ...contracts.windows.derived, snapshotBlockHash: '9'.repeat(64) }))
      .toBe(false); // block-hash half of the v1 pin

    const session = {
      v: 1,
      sessionId: 'a'.repeat(64),
      networkGenesisChallenge: 'a'.repeat(64),
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      proposalId: 'c'.repeat(64),
      bundleHash: 'd'.repeat(64),
      requiredThreshold: 2,
      collectedSigs: [{ signerPuzzleHash: 'e'.repeat(64), sig: 's1' }],
      expiresAfterHeight: 10,
    };
    expect(isSigningSession(session)).toBe(true);
    expect(isSigningSession({ ...session, requiredThreshold: 0 })).toBe(false);
    expect(isSigningSession({
      ...session,
      collectedSigs: [...session.collectedSigs, ...session.collectedSigs], // duplicate signer
    })).toBe(false);

    const receipt = {
      v: 1,
      receiptId: 'a'.repeat(64),
      networkGenesisChallenge: 'a'.repeat(64),
      companyId: 'b'.repeat(64),
      policyVersion: 1,
      operation: 'casino-settle',
      authorization: { kind: 'allowance', allowanceId: 'c'.repeat(64) },
      requestId: 'd'.repeat(64),
      spendBundleId: 'e'.repeat(64),
      assetId: 'xch',
      amount: '1000',
      destinations: ['f'.repeat(64)],
    };
    expect(isTreasuryReceipt(receipt)).toBe(true);
    expect(isTreasuryReceipt({ ...receipt, operation: 'mint' })).toBe(false);
    expect(isTreasuryReceipt({ ...receipt, authorization: { kind: 'divine-right' } })).toBe(false);
    expect(isTreasuryReceipt({ ...receipt, destinations: [] })).toBe(false);
    // Confirmation is both-or-neither.
    expect(isTreasuryReceipt({ ...receipt, confirmedHeight: 5 })).toBe(false);
    expect(isTreasuryReceipt({ ...receipt, confirmedBlockHash: '9'.repeat(64) })).toBe(false);
    expect(isTreasuryReceipt({
      ...receipt, confirmedHeight: 5, confirmedBlockHash: '9'.repeat(64),
    })).toBe(true);
  });

  it('isRoomTreasuryBinding enforces its shape and expiry invariant', () => {
    const binding = {
      v: 1,
      networkGenesisChallenge: 'a'.repeat(64),
      roomId: 'room-1',
      companyId: 'b'.repeat(64),
      treasuryLauncherId: 'c'.repeat(64),
      policyVersion: 1,
      profileId: 'p1',
      boundByPub: 'pub',
      boundAtHeight: 10,
      policyReceiptId: 'd'.repeat(64),
      sig: 'sig',
    };
    expect(isRoomTreasuryBinding(binding)).toBe(true);
    expect(isRoomTreasuryBinding({ ...binding, expiresAfterHeight: 20 })).toBe(true);
    expect(isRoomTreasuryBinding({ ...binding, expiresAfterHeight: 10 })).toBe(false); // not after
    expect(isRoomTreasuryBinding({ ...binding, expiresAfterHeight: null })).toBe(false); // omitted, never null
    expect(isRoomTreasuryBinding({ ...binding, roomId: '' })).toBe(false);
    expect(isRoomTreasuryBinding({ ...binding, sig: '' })).toBe(false);
  });

  it('roomBindingSignatureBytes commits every field including absent options', () => {
    const base = {
      v: 1 as const,
      networkGenesisChallenge: 'a'.repeat(64),
      roomId: 'room-1',
      companyId: 'b'.repeat(64),
      treasuryLauncherId: 'c'.repeat(64),
      policyVersion: 1,
      profileId: 'p1',
      boundByPub: 'pub',
      boundAtHeight: 5,
      policyReceiptId: 'd'.repeat(64),
    };
    const bytes = hex(roomBindingSignatureBytes(base));
    // Every field perturbs the signed bytes — a dropped field would collide.
    expect(hex(roomBindingSignatureBytes({ ...base, roomId: 'room-2' }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, companyId: 'e'.repeat(64) }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, treasuryLauncherId: 'f'.repeat(64) }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, policyVersion: 2 }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, profileId: 'p2' }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, boundByPub: 'other' }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, boundAtHeight: 6 }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, policyReceiptId: 'e'.repeat(64) }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, networkGenesisChallenge: 'b'.repeat(64) }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes({ ...base, expiresAfterHeight: 9 }))).not.toBe(bytes);
    expect(hex(roomBindingSignatureBytes(base))).toBe(bytes); // deterministic
  });

  it('isShareClassPolicy and compareMojoStrings behave at the edges', () => {
    expect(isShareClassPolicy(policy.shareClasses[0])).toBe(true);
    expect(isShareClassPolicy({ ...policy.shareClasses[0], votesPerWholeShare: 1.5 })).toBe(false);
    expect(isShareClassPolicy({ ...policy.shareClasses[0], assetId: 'not-a-cat-id' })).toBe(false);
    expect(compareMojoStrings('99', '100')).toBeLessThan(0);
    expect(compareMojoStrings('100', '99')).toBeGreaterThan(0);
    expect(compareMojoStrings('100', '100')).toBe(0);
    expect(compareMojoStrings('18446744073709551615', '18446744073709551615')).toBe(0);
  });
});

describe('window derivation guards', () => {
  it('rejects malformed registrations and rules', () => {
    const reg = contracts.windows.registration as ProposalRegistration;
    const rule = contracts.windows.rule as GovernanceKindRule;
    expect(() => deriveProposalWindows({ ...reg, acceptedHeight: -1 }, rule)).toThrow();
    expect(() => deriveProposalWindows(reg, { ...rule, votingBlocks: -1 })).toThrow();
    expect(() =>
      deriveProposalWindows({ ...reg, acceptedHeight: Number.MAX_SAFE_INTEGER - 10 }, rule),
    ).toThrow();
  });
});
