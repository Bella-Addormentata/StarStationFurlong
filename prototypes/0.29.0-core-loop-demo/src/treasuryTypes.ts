// treasuryTypes.ts — PR B of the company treasury plan: canonical data contracts,
// deterministic encoding, domain-tagged hashing, and validation guards. Types and
// pure functions ONLY.
//
// Import boundaries (company-treasury-governance-plan.md §15.1): this module
// imports no DOM, Yjs, furniture, or UI code and performs no IO. Its only
// dependency is @noble/hashes. treasuryDoc.ts (signed Yjs caches) layers on top.
//
// Serverless amendments (sovereign-treasury-serverless-plan.md §10): there is no
// authoritative treasury service. TreasuryProposalAcceptance/serviceSig are
// replaced by ProposalWindows — a value every node DERIVES from the on-chain
// registration event and the committed governance rule, so all nodes compute
// identical deadlines with nobody to trust. TreasuryCheckpoint and SigningSession
// are the anyone-can-publish vote checkpoint and the board signature-collection
// record. maxFeeMojos bounds self-paid fees (open decision 9, resolved).
//
// Encoding profile ("SSF deterministic CBOR", plan §12): RFC 8949 deterministic
// encoding, definite lengths only, no floats, no tags, no byte strings (binary
// values travel as lowercase hex text), UTF-8 strings, shortest integer heads,
// map keys sorted bytewise by their encoded bytes. TypeScript and Rust
// (ssf-p2p-node/src/treasury_codec.rs) must produce byte-for-byte identical
// output — proven by the shared vectors in test-vectors/treasury/.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Scalar types and guards
// ---------------------------------------------------------------------------

/** Unsigned mojo amount as a decimal string — never a JS number (u64 > 2^53). */
export type MojoString = string;
/** 32 bytes as 64 lowercase hex characters. */
export type Hex32 = string;

/**
 * Bounded lexical check: 1–20 digits, no leading zero, ≤ u64::MAX. The string
 * is validated BEFORE any BigInt conversion so an oversized untrusted payload
 * cannot burn CPU/memory on parse (plan §12 guard rules).
 */
export function isMojoString(value: unknown): value is MojoString {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 20
    && /^(0|[1-9][0-9]*)$/.test(value)
    && (value.length < 20 || value <= '18446744073709551615');
}

export function isPolicyVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** Lowercase-only: mixed-case hex would break canonical byte equality. */
export function isHex32(value: unknown): value is Hex32 {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isBlockHeight(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// ---------------------------------------------------------------------------
// Governance rule contracts (plan §7.3)
// ---------------------------------------------------------------------------

export type TreasuryProposalKind =
  | 'pay'
  | 'budget'
  | 'appoint-manager'
  | 'revoke-manager'
  | 'bind-room'
  | 'change-policy'
  | 'rotate-board'
  | 'add-share-class'
  | 'dissolve';

export type GovernancePassRule =
  | 'majority-cast'
  | 'supermajority-cast'
  | 'supermajority-total-supply';

export interface GovernanceKindRule {
  proposalThresholdBps: number;
  passRule: GovernancePassRule;
  yesThresholdBps: number;
  quorumBps: number;
  vetoBps: number;
  votingBlocks: number;
  vetoBlocks: number;
  implementationDelayBlocks: number;
  executionWindowBlocks: number;
}

export type ProposalKindRules = Record<TreasuryProposalKind, GovernanceKindRule>;

const BPS_MAX = 10_000;

export function isGovernanceKindRule(value: unknown): value is GovernanceKindRule {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const bps = (n: unknown): boolean =>
    Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= BPS_MAX;
  const blocks = (n: unknown): boolean =>
    Number.isSafeInteger(n) && (n as number) >= 0;
  return bps(r.proposalThresholdBps)
    && (r.passRule === 'majority-cast'
      || r.passRule === 'supermajority-cast'
      || r.passRule === 'supermajority-total-supply')
    && bps(r.yesThresholdBps)
    && bps(r.quorumBps)
    && bps(r.vetoBps)
    && blocks(r.votingBlocks)
    && blocks(r.vetoBlocks)
    && blocks(r.implementationDelayBlocks)
    && blocks(r.executionWindowBlocks);
}

// ---------------------------------------------------------------------------
// Company policy (plan §12, + maxFeeMojos per serverless §8/§10)
// ---------------------------------------------------------------------------

export interface ShareClassPolicy {
  id: string;                  // "common" in v1
  assetId: string;             // CAT asset id
  votesPerWholeShare: number;  // 1 in v1
  grantsRoomAccess: boolean;
  transferable: boolean;
  convertsToClassId?: string;
  sunsetHeight?: number;
}

export interface CompanyTreasuryPolicy {
  v: 1;
  networkGenesisChallenge: Hex32;
  companyId: Hex32;
  treasuryLauncherId: Hex32;
  policyVersion: number;
  board: {
    threshold: number;
    signerPuzzleHashes: Hex32[];
  };
  shareClasses: ShareClassPolicy[];
  governanceRules: ProposalKindRules;
  approvalModuleHashes: Hex32[];
  /** Upper bound on the fee any treasury/allowance spend may self-pay. */
  maxFeeMojos: MojoString;
  emergencyPolicyHash?: Hex32;
}

// ---------------------------------------------------------------------------
// Proposals (plan §7.1) and derived windows (serverless §4)
// ---------------------------------------------------------------------------

export interface UnsignedTreasuryProposal {
  v: 1;
  networkGenesisChallenge: Hex32;
  companyId: Hex32;
  policyVersion: number;
  kind: TreasuryProposalKind;
  payloadHash: Hex32;
  proposerPub: string;
}

export interface TreasuryProposal extends UnsignedTreasuryProposal {
  proposalId: Hex32;
  proposerSig: string;
}

/**
 * The on-chain registration event a proposal's lifecycle hangs from: a hinted
 * coin spend anyone can publish (chia_publish.rs pattern). acceptedHeight is
 * the spend's confirmation height read from chain — never a supplied number.
 */
export interface ProposalRegistration {
  v: 1;
  proposalId: Hex32;
  policyVersion: number;
  kind: TreasuryProposalKind;
  registrationCoinId: Hex32;
  acceptedHeight: number;
  acceptedBlockHash: Hex32;
}

/**
 * Replaces PR 111's service-signed TreasuryProposalAcceptance. This record is
 * DERIVED — deriveProposalWindows() is a pure function of the registration and
 * the policy-committed rule, so every node computes identical values and the
 * record needs (and has) no signature. Cache freely; recompute to trust.
 */
export interface ProposalWindows {
  v: 1;
  proposalId: Hex32;
  policyVersion: number;
  governanceRuleHash: Hex32;
  registrationCoinId: Hex32;
  acceptedHeight: number;
  acceptedBlockHash: Hex32;
  snapshotHeight: number;
  snapshotBlockHash: Hex32;
  votingEndsHeight: number;
  vetoEndsHeight: number;
  executableFromHeight: number;
  expiresAfterHeight: number;
}

export function deriveProposalWindows(
  registration: ProposalRegistration,
  rule: GovernanceKindRule,
): ProposalWindows {
  if (!isBlockHeight(registration.acceptedHeight)) {
    throw new Error('treasury: registration.acceptedHeight is not a block height');
  }
  if (!isGovernanceKindRule(rule)) {
    throw new Error('treasury: malformed GovernanceKindRule');
  }
  const accepted = registration.acceptedHeight;
  const votingEndsHeight = accepted + rule.votingBlocks;
  const vetoEndsHeight = votingEndsHeight + rule.vetoBlocks;
  const executableFromHeight = vetoEndsHeight + rule.implementationDelayBlocks;
  const expiresAfterHeight = executableFromHeight + rule.executionWindowBlocks;
  if (!Number.isSafeInteger(expiresAfterHeight)) {
    throw new Error('treasury: window heights overflow');
  }
  return {
    v: 1,
    proposalId: registration.proposalId,
    policyVersion: registration.policyVersion,
    governanceRuleHash: governanceRuleHashOf(registration.kind, rule),
    registrationCoinId: registration.registrationCoinId,
    acceptedHeight: accepted,
    acceptedBlockHash: registration.acceptedBlockHash,
    // v1 rule: the share snapshot is pinned at the registration height itself.
    snapshotHeight: accepted,
    snapshotBlockHash: registration.acceptedBlockHash,
    votingEndsHeight,
    vetoEndsHeight,
    executableFromHeight,
    expiresAfterHeight,
  };
}

// ---------------------------------------------------------------------------
// Votes and checkpoints (plan §7.2, serverless §5)
// ---------------------------------------------------------------------------

export interface UnsignedTreasuryVote {
  v: 1;
  networkGenesisChallenge: Hex32;
  proposalId: Hex32;
  voterPuzzleHash: Hex32;
  voterGamePub: string;
  choice: 'yes' | 'no' | 'abstain' | 'veto';
  sequence: number;
  chiaAddressProof: string;
}

export interface TreasuryVote extends UnsignedTreasuryVote {
  voteId: Hex32;
  gameSig: string;
}

/**
 * Anyone-can-checkpoint: any shareholder may publish a coin spend before
 * votingEndsHeight whose memo commits voteRoot. The deterministic tally is the
 * union of valid votes provably included in ANY checkpoint confirmed by the
 * deadline; a vote in no confirmed checkpoint does not count.
 */
export interface TreasuryCheckpoint {
  v: 1;
  checkpointId: Hex32;
  networkGenesisChallenge: Hex32;
  companyId: Hex32;
  proposalId: Hex32;
  voteRoot: Hex32;
  voteCount: number;
  publisherPub: string;
  /** Set once the publishing spend is observed/confirmed on chain. */
  checkpointCoinId?: Hex32;
  confirmedHeight?: number;
}

export interface MerkleStep {
  side: 'left' | 'right';
  hash: Hex32;
}

export interface VoteInclusionProof {
  v: 1;
  voteId: Hex32;
  checkpointId: Hex32;
  steps: MerkleStep[];
}

// ---------------------------------------------------------------------------
// Allowances and execution (plan §9.1, + maxFeeMojos)
// ---------------------------------------------------------------------------

export type TreasuryOperation =
  | 'casino-reserve'
  | 'casino-settle'
  | 'casino-refund'
  | 'robot-charge'
  | 'robot-parts'
  | 'room-rent'
  | 'room-repair'
  | 'room-service'
  | 'manager-payment';

export interface AllowanceAuthorityHead {
  headId: string;
  version: number;
  scheme: 'ed25519' | 'bls12381';
  publicKey: string;
}

export interface DeviceAllowance {
  v: 1;
  allowanceId: Hex32;
  networkGenesisChallenge: Hex32;
  companyId: Hex32;
  policyVersion: number;
  subject: {
    kind: 'room' | 'device' | 'robot' | 'manager';
    id: string;
    authorityHead: AllowanceAuthorityHead;
  };
  roomId?: string;
  operations: TreasuryOperation[];
  assetId: 'xch' | string;
  maxPerOperation: MojoString;
  maxPerPeriod: MojoString;
  maxFeeMojos: MojoString;
  periodBlocks: number;
  destinationPuzzleHashes?: Hex32[];
  startsAtHeight: number;
  expiresAfterHeight: number;
  /** Lineage of the on-chain state coin holding the atomic period-cap state. */
  stateCoinLauncherId: Hex32;
  nonce: Hex32;
  policyProof: string;
}

export interface TreasuryExecutionRequestBody {
  v: 1;
  requestId: Hex32;
  networkGenesisChallenge: Hex32;
  allowanceId: Hex32;
  policyVersion: number;
  authorityHeadId: string;
  authorityVersion: number;
  operation: TreasuryOperation;
  payloadHash: Hex32;
  /**
   * The exact allowance state coin this request authorizes consuming. Binding
   * the signed body to one state-coin generation makes replay structurally
   * impossible once the state advances — the named coin no longer exists — with
   * no used-id ledger to maintain. The allowance puzzle MUST assert that the
   * spend consumes this coin (serverless plan §3).
   */
  stateCoinId: Hex32;
  expiresAfterHeight: number;
}

export interface TreasuryExecutionRequest extends TreasuryExecutionRequestBody {
  subjectSig: string;
}

export interface TreasuryReceipt {
  v: 1;
  receiptId: Hex32;
  networkGenesisChallenge: Hex32;
  companyId: Hex32;
  policyVersion: number;
  operation: TreasuryOperation;
  authorization:
    | { kind: 'proposal'; proposalId: Hex32 }
    | { kind: 'allowance'; allowanceId: Hex32 };
  requestId: Hex32;
  spendBundleId: Hex32;
  confirmedHeight?: number;
  confirmedBlockHash?: Hex32;
  assetId: 'xch' | Hex32;
  amount: MojoString;
  destinations: Hex32[];
}

// ---------------------------------------------------------------------------
// Board signing sessions (serverless §7) and room bindings (plan §10.1)
// ---------------------------------------------------------------------------

/**
 * A signature-collection cache gossiped in the treasury Y.Map. It carries no
 * authority: the canonical spend bundle's own asserts (executableFromHeight,
 * expiry) are what the chain enforces. BLS collection is non-interactive —
 * each board node signs bundleHash whenever it comes online; any node holding
 * m valid signatures aggregates and submits.
 */
export interface SigningSession {
  v: 1;
  sessionId: Hex32;
  networkGenesisChallenge: Hex32;
  companyId: Hex32;
  policyVersion: number;
  proposalId: Hex32;
  bundleHash: Hex32;
  requiredThreshold: number;
  collectedSigs: { signerPuzzleHash: Hex32; sig: string }[];
  expiresAfterHeight: number;
}

export interface RoomTreasuryBinding {
  v: 1;
  networkGenesisChallenge: Hex32;
  roomId: string;
  companyId: Hex32;
  treasuryLauncherId: Hex32;
  policyVersion: number;
  profileId: string;
  boundByPub: string;
  boundAtHeight: number;
  expiresAfterHeight?: number;
  policyReceiptId: Hex32;
  sig: string;
}

// ---------------------------------------------------------------------------
// SSF deterministic CBOR (profile in the header comment)
// ---------------------------------------------------------------------------

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

const utf8 = new TextEncoder();

// TextEncoder silently folds an unpaired UTF-16 surrogate to U+FFFD, which
// would make distinct JS strings hash identically — and Rust strings cannot
// represent lone surrogates at all, so such inputs must be rejected, not
// normalized, to keep cross-runtime acceptance parity.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function encodeHead(major: number, arg: number, out: number[]): void {
  const base = major << 5;
  if (arg < 24) {
    out.push(base | arg);
  } else if (arg < 0x100) {
    out.push(base | 24, arg);
  } else if (arg < 0x10000) {
    out.push(base | 25, arg >>> 8, arg & 0xff);
  } else if (arg < 0x100000000) {
    out.push(base | 26, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff);
  } else {
    // Safe integers only, so the high word fits in 32 bits.
    const hi = Math.floor(arg / 0x100000000);
    const lo = arg % 0x100000000;
    out.push(
      base | 27,
      (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    );
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function encodeInto(value: CanonicalValue, out: number[]): void {
  if (value === null) {
    out.push(0xf6);
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 0xf5 : 0xf4);
      return;
    case 'number': {
      if (!Number.isSafeInteger(value)) {
        throw new Error('canonicalEncode: only safe integers are encodable (no floats)');
      }
      const n = Object.is(value, -0) ? 0 : value;
      if (n >= 0) encodeHead(0, n, out);
      else encodeHead(1, -(n + 1), out);
      return;
    }
    case 'string': {
      if (LONE_SURROGATE.test(value)) {
        throw new Error('canonicalEncode: string contains an unpaired surrogate');
      }
      const bytes = utf8.encode(value);
      encodeHead(3, bytes.length, out);
      for (const b of bytes) out.push(b);
      return;
    }
    case 'object': {
      if (Array.isArray(value)) {
        encodeHead(4, value.length, out);
        for (const item of value) encodeInto(item, out);
        return;
      }
      // Class instances encode only their enumerable own fields (e.g. a Date
      // becomes the same bytes as {}), which has no Rust/JSON equivalent —
      // only plain objects are part of the canonical profile.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('canonicalEncode: only plain objects are encodable');
      }
      const entries: { key: Uint8Array; val: Uint8Array }[] = [];
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) {
          throw new Error(`canonicalEncode: undefined value for key "${k}" — use null explicitly`);
        }
        const keyOut: number[] = [];
        encodeInto(k, keyOut);
        const valOut: number[] = [];
        encodeInto(v, valOut);
        entries.push({ key: Uint8Array.from(keyOut), val: Uint8Array.from(valOut) });
      }
      entries.sort((a, b) => compareBytes(a.key, b.key));
      encodeHead(5, entries.length, out);
      for (const e of entries) {
        for (const b of e.key) out.push(b);
        for (const b of e.val) out.push(b);
      }
      return;
    }
    default:
      throw new Error(`canonicalEncode: unsupported value type "${typeof value}"`);
  }
}

export function canonicalEncode(value: CanonicalValue): Uint8Array {
  const out: number[] = [];
  encodeInto(value, out);
  return Uint8Array.from(out);
}

/** sha256 over the canonical encoding, as lowercase hex. */
export function canonicalHashHex(value: CanonicalValue): Hex32 {
  return bytesToHex(sha256(canonicalEncode(value)));
}

/**
 * Profile rule: arrays with SET semantics are sorted by their canonical
 * encoded bytes before hashing. Hash helpers apply this to signer sets,
 * module registries, share-class lists, and similar unordered fields.
 */
export function sortedSet<T extends CanonicalValue>(values: T[]): T[] {
  return values
    .map((v) => ({ v, enc: canonicalEncode(v) }))
    .sort((a, b) => compareBytes(a.enc, b.enc))
    .map((e) => e.v);
}

// ---------------------------------------------------------------------------
// Domain-tagged hashes (plan §7.1/§12; serverless §4/§5/§10)
// ---------------------------------------------------------------------------

function shareClassCanonical(c: ShareClassPolicy): CanonicalValue {
  return {
    id: c.id,
    assetId: c.assetId,
    votesPerWholeShare: c.votesPerWholeShare,
    grantsRoomAccess: c.grantsRoomAccess,
    transferable: c.transferable,
    convertsToClassId: c.convertsToClassId ?? null,
    sunsetHeight: c.sunsetHeight ?? null,
  };
}

function kindRuleCanonical(r: GovernanceKindRule): CanonicalValue {
  return {
    proposalThresholdBps: r.proposalThresholdBps,
    passRule: r.passRule,
    yesThresholdBps: r.yesThresholdBps,
    quorumBps: r.quorumBps,
    vetoBps: r.vetoBps,
    votingBlocks: r.votingBlocks,
    vetoBlocks: r.vetoBlocks,
    implementationDelayBlocks: r.implementationDelayBlocks,
    executionWindowBlocks: r.executionWindowBlocks,
  };
}

/** Covers every authority-bearing policy field (plan §12 + maxFeeMojos). */
export function policyHashOf(policy: CompanyTreasuryPolicy): Hex32 {
  const governanceRules: { [k: string]: CanonicalValue } = {};
  for (const [kind, rule] of Object.entries(policy.governanceRules)) {
    governanceRules[kind] = kindRuleCanonical(rule);
  }
  return canonicalHashHex({
    domain: 'ssf-company-treasury-policy:v1',
    v: policy.v,
    networkGenesisChallenge: policy.networkGenesisChallenge,
    companyId: policy.companyId,
    treasuryLauncherId: policy.treasuryLauncherId,
    policyVersion: policy.policyVersion,
    board: {
      threshold: policy.board.threshold,
      signerPuzzleHashes: sortedSet([...policy.board.signerPuzzleHashes]),
    },
    shareClasses: sortedSet(policy.shareClasses.map(shareClassCanonical)),
    governanceRules,
    approvalModuleHashes: sortedSet([...policy.approvalModuleHashes]),
    maxFeeMojos: policy.maxFeeMojos,
    emergencyPolicyHash: policy.emergencyPolicyHash ?? null,
  });
}

export function governanceRuleHashOf(
  kind: TreasuryProposalKind,
  rule: GovernanceKindRule,
): Hex32 {
  return canonicalHashHex({
    domain: 'ssf-governance-rule:v1',
    kind,
    rule: kindRuleCanonical(rule),
  });
}

/** Non-recursive id: hashes the UNSIGNED body only (plan §7.1). */
export function proposalIdOf(proposal: UnsignedTreasuryProposal): Hex32 {
  return canonicalHashHex({
    domain: 'ssf-treasury-proposal:v1',
    proposal: {
      v: proposal.v,
      networkGenesisChallenge: proposal.networkGenesisChallenge,
      companyId: proposal.companyId,
      policyVersion: proposal.policyVersion,
      kind: proposal.kind,
      payloadHash: proposal.payloadHash,
      proposerPub: proposal.proposerPub,
    },
  });
}

/** The bytes the proposer's personal key signs (plan §7.1). */
export function proposalSignatureBytes(
  networkGenesisChallenge: Hex32,
  proposalId: Hex32,
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-treasury-proposal-signature:v1',
    networkGenesisChallenge,
    proposalId,
  });
}

export function voteIdOf(vote: UnsignedTreasuryVote): Hex32 {
  return canonicalHashHex({
    domain: 'ssf-treasury-vote:v1',
    vote: {
      v: vote.v,
      networkGenesisChallenge: vote.networkGenesisChallenge,
      proposalId: vote.proposalId,
      voterPuzzleHash: vote.voterPuzzleHash,
      voterGamePub: vote.voterGamePub,
      choice: vote.choice,
      sequence: vote.sequence,
      chiaAddressProof: vote.chiaAddressProof,
    },
  });
}

export function checkpointIdOf(
  checkpoint: Omit<TreasuryCheckpoint, 'checkpointId' | 'checkpointCoinId' | 'confirmedHeight'>,
): Hex32 {
  return canonicalHashHex({
    domain: 'ssf-treasury-checkpoint:v1',
    checkpoint: {
      v: checkpoint.v,
      networkGenesisChallenge: checkpoint.networkGenesisChallenge,
      companyId: checkpoint.companyId,
      proposalId: checkpoint.proposalId,
      voteRoot: checkpoint.voteRoot,
      voteCount: checkpoint.voteCount,
      publisherPub: checkpoint.publisherPub,
    },
  });
}

// ---------------------------------------------------------------------------
// Checkpoint vote tree (serverless §5)
// ---------------------------------------------------------------------------
// Leaves are the DISTINCT vote ids, sorted bytewise. Domain separation keeps a
// leaf from ever being replayed as an interior node: leaf = sha256(0x00 ‖ id),
// node = sha256(0x01 ‖ left ‖ right). An odd node is PROMOTED unchanged to the
// next level (never duplicated — duplication invites CVE-2012-2459-style
// ambiguity). The Rust codec and the eventual Chialisp must match exactly.

function merkleLeaf(voteId: Hex32): Uint8Array {
  const bytes = hexToBytes(voteId);
  const buf = new Uint8Array(1 + bytes.length);
  buf[0] = 0x00;
  buf.set(bytes, 1);
  return sha256(buf);
}

function merkleNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + left.length + right.length);
  buf[0] = 0x01;
  buf.set(left, 1);
  buf.set(right, 1 + left.length);
  return sha256(buf);
}

export function voteRootOf(voteIds: Hex32[]): Hex32 {
  const unique = [...new Set(voteIds)];
  if (unique.length === 0) {
    throw new Error('voteRootOf: a checkpoint must include at least one vote');
  }
  for (const id of unique) {
    if (!isHex32(id)) throw new Error('voteRootOf: vote ids must be Hex32');
  }
  // Lowercase fixed-width hex sorts identically as strings and as bytes.
  let level = [...unique].sort().map(merkleLeaf);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(merkleNode(level[i], level[i + 1]));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
  }
  return bytesToHex(level[0]);
}

/**
 * Builds the inclusion proof for one vote id against voteRootOf(voteIds).
 * A promoted odd node contributes no step — proofs may be shorter than the
 * tree is tall. Throws if targetId is not among the (distinct) vote ids.
 */
export function voteInclusionStepsOf(voteIds: Hex32[], targetId: Hex32): MerkleStep[] {
  if (!isHex32(targetId)) {
    throw new Error('voteInclusionStepsOf: targetId must be Hex32');
  }
  const unique = [...new Set(voteIds)].sort();
  for (const id of unique) {
    if (!isHex32(id)) throw new Error('voteInclusionStepsOf: vote ids must be Hex32');
  }
  let index = unique.indexOf(targetId);
  if (index < 0) {
    throw new Error('voteInclusionStepsOf: targetId is not in voteIds');
  }
  let level = unique.map(merkleLeaf);
  const steps: MerkleStep[] = [];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      if (i === index || i + 1 === index) {
        const targetIsLeft = i === index;
        steps.push({
          side: targetIsLeft ? 'right' : 'left',
          hash: bytesToHex(level[targetIsLeft ? i + 1 : i]),
        });
        index = next.length;
        next.push(merkleNode(level[i], level[i + 1]));
      } else {
        next.push(merkleNode(level[i], level[i + 1]));
      }
    }
    if (level.length % 2 === 1) {
      if (index === level.length - 1) index = next.length;
      next.push(level[level.length - 1]);
    }
    level = next;
  }
  return steps;
}

/**
 * A promoted-odd-node tree over distinct 32-byte ids can never be deeper than
 * 64 levels; anything longer is garbage, and proofs arrive over gossip, so the
 * bound is checked before the per-step hashing work (plan §12 guard rules).
 */
const MAX_PROOF_STEPS = 64;

export function verifyVoteInclusion(
  voteId: Hex32,
  steps: MerkleStep[],
  voteRoot: Hex32,
): boolean {
  if (!isHex32(voteId) || !isHex32(voteRoot)) return false;
  if (!Array.isArray(steps) || steps.length > MAX_PROOF_STEPS) return false;
  let acc = merkleLeaf(voteId);
  for (const step of steps) {
    // Proofs arrive as gossip-decoded JSON: stay total (false, never throw).
    if (typeof step !== 'object' || step === null) return false;
    if (step.side !== 'left' && step.side !== 'right') return false;
    if (!isHex32(step.hash)) return false;
    const sibling = hexToBytes(step.hash);
    acc = step.side === 'left' ? merkleNode(sibling, acc) : merkleNode(acc, sibling);
  }
  return bytesToHex(acc) === voteRoot;
}
