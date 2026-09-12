// Regenerates the shared TS<->Rust treasury golden vectors from the TypeScript
// reference implementation (src/treasuryTypes.ts). Run from the prototype root:
//
//   node test-vectors/treasury/generate.mjs
//
// (Node >= 22.18 — imports the .ts module via built-in type stripping.)
//
// The primitive CBOR cases are asserted here against hex hand-copied from
// RFC 8949 Appendix A before anything is written, so a drifting encoder cannot
// silently regenerate matching-but-wrong vectors. Contract-level cases are then
// produced by the same encoder and pinned; the Rust twin
// (ssf-p2p-node/src/treasury_codec.rs) must reproduce every byte.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalEncode,
  canonicalHashHex,
  checkpointIdOf,
  deriveProposalWindows,
  governanceRuleHashOf,
  policyHashOf,
  proposalIdOf,
  payloadHashOf,
  proposalSignatureBytes,
  sortedSet,
  voteIdOf,
  voteRootOf,
  voteSignatureBytes,
} from '../../src/treasuryTypes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// --------------------------------------------------------------------------
// 1. canonical-cbor.json — encoding profile vectors
// --------------------------------------------------------------------------

// [name, value, expected hex from RFC 8949 Appendix A (null = derived case)]
const cborCases = [
  ['zero', 0, '00'],
  ['int-23', 23, '17'],
  ['int-24', 24, '1818'],
  ['int-255', 255, '18ff'],
  ['int-256', 256, '190100'],
  ['int-65535', 65535, '19ffff'],
  ['int-65536', 65536, '1a00010000'],
  ['int-1000000', 1000000, '1a000f4240'],
  ['int-u32-max', 4294967295, '1affffffff'],
  ['int-u32-max-plus-1', 4294967296, '1b0000000100000000'],
  ['int-max-safe', 9007199254740991, '1b001fffffffffffff'],
  ['int-neg-1', -1, '20'],
  ['int-neg-24', -24, '37'],
  ['int-neg-25', -25, '3818'],
  ['int-neg-1000', -1000, '3903e7'],
  ['false', false, 'f4'],
  ['true', true, 'f5'],
  ['null', null, 'f6'],
  ['text-empty', '', '60'],
  ['text-a', 'a', '6161'],
  ['text-IETF', 'IETF', '6449455446'],
  ['text-u-umlaut', 'ü', '62c3bc'],
  ['array-empty', [], '80'],
  ['array-123', [1, 2, 3], '83010203'],
  ['map-empty', {}, 'a0'],
  ['map-a1-b23', { a: 1, b: [2, 3] }, 'a26161016162820203'],
  // Deterministic key order: written b-then-a, must encode a-then-b.
  ['map-key-order', { b: 1, a: 2 }, 'a2616102616201'],
  // Bytewise order of ENCODED keys: "b" (0x6162) sorts before "aa" (0x626161).
  ['map-key-order-length', { aa: 1, b: 2 }, 'a261620262616101'],
  // Derived (not from the RFC): nesting, 24+-entry heads, negative-zero fold.
  ['neg-zero-is-zero', -0, '00'],
  ['nested', { k: { a: [null, true, 'x'] } }, null],
  ['text-emoji', '\u{1F680}', null],
  ['array-mixed', [0, 'a', { b: [] }, null], null],
];

const cborOut = [];
for (const [name, value, expected] of cborCases) {
  const encoded = hex(canonicalEncode(value));
  if (expected !== null && encoded !== expected) {
    throw new Error(`RFC 8949 mismatch for ${name}: got ${encoded}, expected ${expected}`);
  }
  cborOut.push({ name, value, hex: encoded, sha256: canonicalHashHex(value) });
}

// --------------------------------------------------------------------------
// 2. treasury-contracts.json — domain-tagged contract vectors
// --------------------------------------------------------------------------

const h = (fill) => fill.repeat(64);
const GENESIS = h('a'); // stand-in testnet genesis challenge, 64 hex chars

const rule = {
  proposalThresholdBps: 100,
  passRule: 'majority-cast',
  yesThresholdBps: 5000,
  quorumBps: 1000,
  vetoBps: 2000,
  votingBlocks: 4608,
  vetoBlocks: 4608,
  implementationDelayBlocks: 4608,
  executionWindowBlocks: 9216,
};

const kinds = [
  'pay', 'budget', 'appoint-manager', 'revoke-manager', 'bind-room',
  'change-policy', 'rotate-board', 'add-share-class', 'dissolve',
];
const governanceRules = Object.fromEntries(kinds.map((k) => [k, rule]));

const policy = {
  v: 1,
  networkGenesisChallenge: GENESIS,
  companyId: h('b'),
  treasuryLauncherId: h('c'),
  policyVersion: 1,
  board: { threshold: 2, signerPuzzleHashes: [h('f'), h('d'), h('e')] },
  shareClasses: [{
    id: 'common',
    assetId: h('1'),
    votesPerWholeShare: 1,
    grantsRoomAccess: true,
    transferable: true,
  }],
  governanceRules,
  approvalModuleHashes: [h('3'), h('2')],
  maxFeeMojos: '50000000',
};

const proposal = {
  v: 1,
  networkGenesisChallenge: GENESIS,
  companyId: h('b'),
  policyVersion: 1,
  kind: 'pay',
  payloadHash: h('4'),
  proposerPub: h('5'),
};
const proposalId = proposalIdOf(proposal);

const vote = {
  v: 1,
  networkGenesisChallenge: GENESIS,
  proposalId,
  voterPuzzleHash: h('6'),
  voterGamePub: h('7'),
  choice: 'yes',
  sequence: 1,
  chiaAddressProof: 'sig-placeholder',
};
const voteId = voteIdOf(vote);

const otherVoteIds = [h('9'), h('8'), voteId];
const voteRoot = voteRootOf(otherVoteIds);

const checkpointBody = {
  v: 1,
  networkGenesisChallenge: GENESIS,
  companyId: h('b'),
  proposalId,
  voteRoot,
  voteCount: 3,
  publisherPub: h('7'),
};

const registration = {
  v: 1,
  proposalId,
  policyVersion: 1,
  kind: 'pay',
  registrationCoinId: h('0'),
  acceptedHeight: 5_000_000,
  acceptedBlockHash: h('a'),
};

const contracts = {
  note: 'Generated by generate.mjs from src/treasuryTypes.ts. Do not edit by hand.',
  policy: {
    value: policy,
    policyHash: policyHashOf(policy),
  },
  governanceRule: {
    kind: 'pay',
    rule,
    governanceRuleHash: governanceRuleHashOf('pay', rule),
  },
  proposal: {
    unsigned: proposal,
    proposalId,
    signatureBytesHex: hex(proposalSignatureBytes(GENESIS, proposalId)),
  },
  vote: {
    unsigned: vote,
    voteId,
    signatureBytesHex: hex(voteSignatureBytes(GENESIS, voteId)),
  },
  voteTree: {
    voteIds: otherVoteIds,
    voteRoot,
    singleLeafRoot: voteRootOf([voteId]),
    twoLeafRoot: voteRootOf([h('9'), h('8')]),
  },
  checkpoint: {
    body: checkpointBody,
    checkpointId: checkpointIdOf(checkpointBody),
  },
  windows: {
    registration,
    rule,
    derived: deriveProposalWindows(registration, rule),
  },
  sortedSet: {
    input: ['bb', 'a', 'ab', 'b'],
    output: sortedSet(['bb', 'a', 'ab', 'b']),
  },
  payload: {
    // Content-addressed payload bytes (hex): "treasury payload" in ASCII.
    payloadHex: '7472656173757279207061796c6f6164',
    payloadHash: payloadHashOf('7472656173757279207061796c6f6164'),
  },
};

writeFileSync(join(here, 'canonical-cbor.json'), JSON.stringify(cborOut, null, 2) + '\n');
writeFileSync(join(here, 'treasury-contracts.json'), JSON.stringify(contracts, null, 2) + '\n');
console.log(`wrote ${cborOut.length} cbor cases and contract vectors`);
