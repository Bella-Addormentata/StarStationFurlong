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
  type GovernanceKindRule,
  type MerkleStep,
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
