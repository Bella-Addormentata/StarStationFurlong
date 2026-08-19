// treasuryDoc.ts — signed treasury caches over the company office doc's
// `treasury` Y.Map. Completes PR B's cache layer
// (company-treasury-governance-plan.md §14, sovereign-treasury-serverless-plan.md
// §4/§5/§7, import boundary per §15.1: treasuryTypes + Yjs only, no UI, no IO).
//
// TRUST POSTURE (invariant 5): everything in this map is a REPLACEABLE CACHE.
// Money is authoritative on chain; nothing here establishes balances, decides
// executability, or serializes spends. Any peer can write anything into the
// shared doc, so every read re-validates at this boundary: treasuryTypes
// guards first, then id recomputation, then signature verification. Malformed
// or unverifiable entries are skipped, never thrown into money paths.
//
// Key layout (plan §14 pins the first seven; the rest follow its convention):
//   policy                                  -> CompanyTreasuryPolicy cache
//   proposal:<proposalId>                   -> TreasuryProposal      (signed)
//   vote:<proposalId>:<voterGamePub>        -> TreasuryVote          (signed)
//   allowance:<allowanceId>                 -> DeviceAllowance cache
//   binding:<roomId>                        -> RoomTreasuryBinding   (signed)
//   receipt:<receiptId>                     -> TreasuryReceipt cache
//   sync                                    -> ChainSyncStatus (display-only)
//   registration:<proposalId>               -> ProposalRegistration
//   windows:<proposalId>                    -> ProposalWindows (derived — recompute to trust)
//   checkpoint:<proposalId>:<checkpointId>  -> TreasuryCheckpoint
//   session:<proposalId>:<sessionId>        -> SigningSession shell (zero authority)
//   sessionsig:<sessionId>:<signerPuzzleHash> -> one collected signature
//   payload:<payloadHash>                   -> proposal payload bytes, lowercase hex
//
// NETWORK PINNING (plan §17.5): the binding carries the room's configured
// networkGenesisChallenge, and every genesis-bearing record must match it —
// a correctly signed record from another network is invalid here, so
// testnet records can never replay into a mainnet cache or vice versa.
// (Registrations and windows carry no genesis field; they anchor to a
// genesis-bound proposal by id and to chain observations the node verifies.)
//
// The vote slot is keyed by voterGamePub (plan §14's voterPub) — the identity
// gameSig AUTHENTICATES, so nobody can squat another voter's slot: a record
// claiming a slot must carry that slot's pub and verify against it. The §7.2
// dedup rule ("greatest per-voter sequence; equal sequence -> smallest
// voteId") is enforced per slot on write; dedup across game keys down to the
// weight-bearing voterPuzzleHash happens at TALLY time — puzzle-hash binding
// (chiaAddressProof) is chain-checked there, not here — via the exported
// pickCanonicalVote.
//
// VOTE RETENTION: this map holds ONE record per voter slot — the canonical
// latest, per §14's pinned layout. A Yjs same-key concurrent write resolves
// by CRDT rule, so a cross-partition merge can surface the §7.2 loser and
// hide the winner's payload FROM THIS MAP. That is a display gap, not a
// money gap: the tally counts only votes in confirmed checkpoints, whose
// publishers MUST retain the payloads they root (sovereign §5), and a vote's
// author always holds their own vote — any holder republishing (putVote)
// repairs the slot, because the no-downgrade rule always yields to the
// canonical vote.

import * as Y from 'yjs';
import {
  type CompanyTreasuryPolicy,
  type DeviceAllowance,
  type Hex32,
  type ProposalRegistration,
  type ProposalWindows,
  type RoomTreasuryBinding,
  type SigningSession,
  type TreasuryCheckpoint,
  type TreasuryProposal,
  type TreasuryReceipt,
  type TreasuryVote,
  checkpointIdOf,
  isBlockHeight,
  isCompanyTreasuryPolicy,
  isDeviceAllowance,
  isHex32,
  isProposalRegistration,
  isProposalWindows,
  isRoomTreasuryBinding,
  isSigningSession,
  isTreasuryCheckpoint,
  isTreasuryProposal,
  isTreasuryReceipt,
  isTreasuryVote,
  payloadHashOf,
  policyHashOf,
  proposalIdOf,
  proposalSignatureBytes,
  roomBindingSignatureBytes,
  signingSessionIdOf,
  voteIdOf,
  voteSignatureBytes,
} from './treasuryTypes';

// ---------------------------------------------------------------------------
// Binding and module state
// ---------------------------------------------------------------------------

/**
 * Signature verification is injected so this module stays encoding-agnostic
 * and import-pure: the browser passes keypair.ts's identity verifier; tests
 * pass @noble/ed25519 directly. `pub` and `sig` are whatever strings the
 * records carry (b64url for game identities, per house convention).
 */
export type TreasurySigVerifier = (pub: string, bytes: Uint8Array, sig: string) => boolean;

/**
 * Per-node chain-view display status (plan §14 `sync`). Under the serverless
 * design pausing is each node's LOCAL verdict (sovereign §15 consequence 3) —
 * this entry is display state for the room UI, never a gate anyone obeys.
 * IMPORTANT for PR C: any peer can overwrite this shared key, so offline /
 * read-only / spending-paused UI states MUST come from the local node's own
 * verdict, never from this entry.
 */
export interface ChainSyncStatus {
  v: 1;
  state: 'verified' | 'degraded' | 'unavailable';
  verifiedHeight?: number;
  verifiedBlockHash?: Hex32;
}

function isChainSyncStatus(value: unknown): value is ChainSyncStatus {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return s.v === 1
    && (s.state === 'verified' || s.state === 'degraded' || s.state === 'unavailable')
    && (s.verifiedHeight === undefined || isBlockHeight(s.verifiedHeight))
    && (s.verifiedBlockHash === undefined || isHex32(s.verifiedBlockHash));
}

let boundDoc: Y.Doc | null = null;
let treasuryMap: Y.Map<unknown> | null = null;
let verifySig: TreasurySigVerifier | null = null;
let expectedGenesis: Hex32 | null = null;
let unobservePrevious: (() => void) | null = null;
const listeners = new Set<() => void>();

/** Plan §17.5: a record for any other network is invalid here, full stop. */
function onNet(genesis: unknown): boolean {
  return expectedGenesis !== null && genesis === expectedGenesis;
}

function notify(): void {
  // Copy first: a listener may unsubscribe mid-notify, and one throwing
  // render must not kill the rest.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* listener errors are that listener's problem */
    }
  }
}

/** Bind to the room's office doc at the join seam. Rebinding replaces state. */
export function bindTreasuryDoc(
  doc: Y.Doc,
  opts: { verifySig: TreasurySigVerifier; networkGenesisChallenge: Hex32 },
): void {
  unobservePrevious?.();
  boundDoc = doc;
  verifySig = opts.verifySig;
  if (isHex32(opts.networkGenesisChallenge)) {
    expectedGenesis = opts.networkGenesisChallenge;
  } else {
    // Fail closed, but loudly: with no valid pin every genesis-bearing put
    // and read refuses, which is a local wiring bug, not peer hostility.
    expectedGenesis = null;
    console.warn('bindTreasuryDoc: invalid networkGenesisChallenge — treasury cache disabled');
  }
  const nextMap = doc.getMap('treasury');
  treasuryMap = nextMap;
  const observer = (): void => notify();
  nextMap.observe(observer);
  unobservePrevious = () => {
    try {
      nextMap.unobserve(observer);
    } catch {
      /* the previous doc may already be destroyed */
    }
  };
  notify();
}

function docAlive(): boolean {
  return boundDoc !== null && boundDoc.isDestroyed !== true;
}

// Offers-style unbound behavior: no page-local fallback doc — a treasury
// write that silently lands nowhere is a foot-gun, so puts fail loudly
// (false) and reads return null/[] until a real room doc is bound.
function map(): Y.Map<unknown> | null {
  return docAlive() && treasuryMap ? treasuryMap : null;
}

export function treasuryDocBound(): boolean {
  return map() !== null;
}

export function subscribeTreasury(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function put(key: string, value: unknown): boolean {
  const m = map();
  if (!m) return false;
  boundDoc!.transact(() => {
    m.set(key, value);
  });
  return true;
}

function verify(pub: string, bytes: Uint8Array, sig: string): boolean {
  if (!verifySig) return false;
  try {
    return verifySig(pub, bytes, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Proposals (signed, immutable, idempotent ids)
// ---------------------------------------------------------------------------

function validProposal(value: unknown): value is TreasuryProposal {
  if (!isTreasuryProposal(value)) return false;
  if (!onNet(value.networkGenesisChallenge)) return false;
  // try/catch: the canonical encoder throws on strings the profile rejects
  // (e.g. lone surrogates), and map values cross the peer trust boundary —
  // an unencodable record is invalid, not an exception.
  try {
    if (proposalIdOf(value) !== value.proposalId) return false;
    return verify(
      value.proposerPub,
      proposalSignatureBytes(value.networkGenesisChallenge, value.proposalId),
      value.proposerSig,
    );
  } catch {
    return false;
  }
}

export function putProposal(proposal: TreasuryProposal): boolean {
  if (!validProposal(proposal)) return false;
  const m = map();
  if (!m) return false;
  // Idempotent: same id = same unsigned body. Keep the first valid copy —
  // but only if it actually claims this slot; a valid record misfiled under
  // this key by a hostile peer is junk to overwrite, not an occupant.
  const existing = m.get(`proposal:${proposal.proposalId}`);
  if (validProposal(existing) && existing.proposalId === proposal.proposalId) return true;
  return put(`proposal:${proposal.proposalId}`, proposal);
}

export function readProposal(proposalId: string): TreasuryProposal | null {
  const m = map();
  if (!m) return null;
  const value = m.get(`proposal:${proposalId}`);
  return validProposal(value) && value.proposalId === proposalId ? value : null;
}

export function listProposals(): TreasuryProposal[] {
  const m = map();
  if (!m) return [];
  const out: TreasuryProposal[] = [];
  for (const [key, value] of m.entries()) {
    if (!key.startsWith('proposal:')) continue;
    if (validProposal(value) && key === `proposal:${value.proposalId}`) out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Votes (signed; per-voter slot with the §7.2 canonical-conflict rule)
// ---------------------------------------------------------------------------

function validVote(value: unknown): value is TreasuryVote {
  if (!isTreasuryVote(value)) return false;
  if (!onNet(value.networkGenesisChallenge)) return false;
  try {
    if (voteIdOf(value) !== value.voteId) return false;
    return verify(
      value.voterGamePub,
      voteSignatureBytes(value.networkGenesisChallenge, value.voteId),
      value.gameSig,
    );
  } catch {
    return false;
  }
}

/**
 * The §7.2 canonical-vote rule as a pure reducer: greatest sequence wins;
 * equal sequences resolve to the lexicographically smallest voteId (lowercase
 * fixed-width hex, so string order is byte order). Exported for the tally
 * recount to reuse across the checkpoint union.
 */
export function pickCanonicalVote(a: TreasuryVote, b: TreasuryVote): TreasuryVote {
  if (a.sequence !== b.sequence) return a.sequence > b.sequence ? a : b;
  return a.voteId <= b.voteId ? a : b;
}

export function putVote(vote: TreasuryVote): boolean {
  if (!validVote(vote)) return false;
  const m = map();
  if (!m) return false;
  const key = `vote:${vote.proposalId}:${vote.voterGamePub}`;
  const existing = m.get(key);
  if (validVote(existing)
    && existing.proposalId === vote.proposalId
    && existing.voterGamePub === vote.voterGamePub
    && pickCanonicalVote(existing, vote) === existing) {
    // The slot already holds the canonical vote; do not downgrade it. (The
    // occupant provably signed with this slot's key — squatting under
    // someone else's pub is impossible, so no-downgrade is safe.)
    return existing.voteId === vote.voteId;
  }
  return put(key, vote);
}

export function readVote(proposalId: string, voterGamePub: string): TreasuryVote | null {
  const m = map();
  if (!m) return null;
  const value = m.get(`vote:${proposalId}:${voterGamePub}`);
  if (!validVote(value)) return null;
  // The record must claim the slot it sits in.
  if (value.proposalId !== proposalId || value.voterGamePub !== voterGamePub) return null;
  return value;
}

export function listVotes(proposalId: string): TreasuryVote[] {
  const m = map();
  if (!m) return [];
  const out: TreasuryVote[] = [];
  const prefix = `vote:${proposalId}:`;
  for (const [key, value] of m.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (validVote(value)
      && key === `vote:${value.proposalId}:${value.voterGamePub}`) {
      out.push(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policy and allowance caches (chain-authoritative; cache conveys no authority)
// ---------------------------------------------------------------------------

export function putPolicyCache(policy: CompanyTreasuryPolicy): boolean {
  if (!isCompanyTreasuryPolicy(policy)) return false;
  if (!onNet(policy.networkGenesisChallenge)) return false;
  // Encodability probe: a policy the canonical encoder rejects would put
  // fine but read back null forever — refuse it here instead.
  try {
    policyHashOf(policy);
  } catch {
    return false;
  }
  // Deliberately plain-replace (invariant 5: caches must stay replaceable).
  // Version selection against the chain's policy lineage is the node's job —
  // a local version-monotonicity rule over UNAUTHENTICATED entries would let
  // a planted max-version record brick the cache.
  return put('policy', policy);
}

/** The returned hash is recomputed here — compare it against the on-chain commitment. */
export function readPolicyCache(): { policy: CompanyTreasuryPolicy; policyHash: Hex32 } | null {
  const m = map();
  if (!m) return null;
  const value = m.get('policy');
  if (!isCompanyTreasuryPolicy(value)) return null;
  if (!onNet(value.networkGenesisChallenge)) return null;
  try {
    return { policy: value, policyHash: policyHashOf(value) };
  } catch {
    return null; // unencodable strings — treat as an invalid cache entry
  }
}

export function putAllowanceCache(allowance: DeviceAllowance): boolean {
  if (!isDeviceAllowance(allowance)) return false;
  if (!onNet(allowance.networkGenesisChallenge)) return false;
  return put(`allowance:${allowance.allowanceId}`, allowance);
}

export function readAllowanceCache(allowanceId: string): DeviceAllowance | null {
  const m = map();
  if (!m) return null;
  const value = m.get(`allowance:${allowanceId}`);
  if (!isDeviceAllowance(value) || value.allowanceId !== allowanceId) return null;
  return onNet(value.networkGenesisChallenge) ? value : null;
}

// ---------------------------------------------------------------------------
// Registrations and derived windows (chain observations / recompute-to-trust)
// ---------------------------------------------------------------------------

export function putRegistration(registration: ProposalRegistration): boolean {
  if (!isProposalRegistration(registration)) return false;
  return put(`registration:${registration.proposalId}`, registration);
}

export function readRegistration(proposalId: string): ProposalRegistration | null {
  const m = map();
  if (!m) return null;
  const value = m.get(`registration:${proposalId}`);
  return isProposalRegistration(value) && value.proposalId === proposalId ? value : null;
}

export function putWindowsCache(windows: ProposalWindows): boolean {
  if (!isProposalWindows(windows)) return false;
  return put(`windows:${windows.proposalId}`, windows);
}

/**
 * A cached derivation, returned for display. To TRUST windows, recompute them:
 * deriveProposalWindows(readRegistration(id), rule) — sovereign §4.
 */
export function readWindowsCache(proposalId: string): ProposalWindows | null {
  const m = map();
  if (!m) return null;
  const value = m.get(`windows:${proposalId}`);
  return isProposalWindows(value) && value.proposalId === proposalId ? value : null;
}

// ---------------------------------------------------------------------------
// Checkpoints (chain-anchored; multiple per proposal are normal)
// ---------------------------------------------------------------------------

function validCheckpoint(value: unknown): value is TreasuryCheckpoint {
  if (!isTreasuryCheckpoint(value)) return false;
  if (!onNet(value.networkGenesisChallenge)) return false;
  const { checkpointId, checkpointCoinId, confirmedHeight, ...body } = value;
  void checkpointCoinId;
  void confirmedHeight;
  try {
    return checkpointIdOf(body) === checkpointId;
  } catch {
    return false;
  }
}

export function putCheckpoint(checkpoint: TreasuryCheckpoint): boolean {
  if (!validCheckpoint(checkpoint)) return false;
  return put(`checkpoint:${checkpoint.proposalId}:${checkpoint.checkpointId}`, checkpoint);
}

export function listCheckpoints(proposalId: string): TreasuryCheckpoint[] {
  const m = map();
  if (!m) return [];
  const out: TreasuryCheckpoint[] = [];
  const prefix = `checkpoint:${proposalId}:`;
  for (const [key, value] of m.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (validCheckpoint(value)
      && key === `checkpoint:${value.proposalId}:${value.checkpointId}`) {
      out.push(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signing sessions (zero authority; CRDT-native signature union)
// ---------------------------------------------------------------------------
// A session's id is DERIVED — signingSessionIdOf hashes the immutable shell —
// so "same id, different shell" is structurally impossible: an id mismatch is
// junk to overwrite, and nothing can brick a slot. Signatures live under one
// key PER SIGNER (`sessionsig:<sessionId>:<signerPuzzleHash>`), so Yjs sync
// itself performs the set union across partitions — two replicas collecting
// different signers merge losslessly with no application merge step. Sigs are
// unverifiable at this layer (BLS lands with PR F), so a same-signer conflict
// resolves by plain CRDT last-write — a planted garbage value cannot win
// permanently, because any holder of the real signature re-puts it and the
// aggregation layer verifies before use.

function sessionShellOf(session: SigningSession): SigningSession {
  return { ...session, collectedSigs: [] };
}

function validSessionShell(value: unknown, proposalId: string, sessionId: string): value is SigningSession {
  if (!isSigningSession(value)) return false;
  if (value.proposalId !== proposalId || value.sessionId !== sessionId) return false;
  if (!onNet(value.networkGenesisChallenge)) return false;
  try {
    return signingSessionIdOf(value) === value.sessionId;
  } catch {
    return false;
  }
}

export function putSigningSession(session: SigningSession): boolean {
  if (!isSigningSession(session)) return false;
  if (!onNet(session.networkGenesisChallenge)) return false;
  try {
    if (signingSessionIdOf(session) !== session.sessionId) return false;
  } catch {
    return false;
  }
  const m = map();
  if (!m) return false;
  const shellKey = `session:${session.proposalId}:${session.sessionId}`;
  const existing = m.get(shellKey);
  boundDoc!.transact(() => {
    // The shell is content-addressed, so a clean valid occupant is
    // byte-equivalent and needs no write; anything else (junk, or a valid
    // shell bloated with embedded sigs a peer parked there) is scrubbed.
    const occupantClean = validSessionShell(existing, session.proposalId, session.sessionId)
      && (existing as SigningSession).collectedSigs.length === 0;
    if (!occupantClean) {
      m.set(shellKey, sessionShellOf(session));
    }
    for (const s of session.collectedSigs) {
      const sigKey = `sessionsig:${session.sessionId}:${s.signerPuzzleHash}`;
      // Overwrite unless the held entry is EXACTLY the canonical shape — a
      // planted entry with the right sig string but a mismatched signer
      // field would otherwise skip the write yet be dropped on read,
      // permanently shadowing the signature.
      const held = m.get(sigKey) as Record<string, unknown> | undefined;
      if (!held || held.sig !== s.sig || held.signerPuzzleHash !== s.signerPuzzleHash) {
        m.set(sigKey, { signerPuzzleHash: s.signerPuzzleHash, sig: s.sig });
      }
    }
  });
  return true;
}

// One pass over the whole map builds a signature index keyed by session, so
// listing stays O(map size) no matter how many shells a peer plants —
// per-shell rescans would be O(sessions × map size), a cheap read-freeze.
export function listSigningSessions(proposalId: string): SigningSession[] {
  const m = map();
  if (!m) return [];
  const shellPrefix = `session:${proposalId}:`;
  const shells: { sessionId: string; shell: SigningSession }[] = [];
  const sigsBySession = new Map<string, { signerPuzzleHash: Hex32; sig: string }[]>();
  for (const [key, value] of m.entries()) {
    if (key.startsWith(shellPrefix)) {
      const sessionId = key.slice(shellPrefix.length);
      if (validSessionShell(value, proposalId, sessionId)) {
        shells.push({ sessionId, shell: value });
      }
    } else if (key.startsWith('sessionsig:')) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (!isHex32(entry.signerPuzzleHash)) continue;
      // Session ids are fixed-width Hex32, so the key decomposes exactly.
      const sessionId = key.slice('sessionsig:'.length, 'sessionsig:'.length + 64);
      if (key !== `sessionsig:${sessionId}:${entry.signerPuzzleHash}`) continue;
      if (typeof entry.sig !== 'string' || entry.sig.length === 0) continue;
      let bucket = sigsBySession.get(sessionId);
      if (!bucket) {
        bucket = [];
        sigsBySession.set(sessionId, bucket);
      }
      bucket.push({ signerPuzzleHash: entry.signerPuzzleHash, sig: entry.sig });
    }
  }
  const out: SigningSession[] = [];
  for (const { sessionId, shell } of shells) {
    const collectedSigs = (sigsBySession.get(sessionId) ?? [])
      .sort((a, b) => (a.signerPuzzleHash < b.signerPuzzleHash ? -1 : 1));
    const assembled = { ...shell, collectedSigs };
    if (isSigningSession(assembled)) out.push(assembled);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Room bindings (signed by boundByPub) and receipt caches
// ---------------------------------------------------------------------------

function validBinding(value: unknown): value is RoomTreasuryBinding {
  if (!isRoomTreasuryBinding(value)) return false;
  if (!onNet(value.networkGenesisChallenge)) return false;
  const { sig, ...unsigned } = value;
  try {
    return verify(value.boundByPub, roomBindingSignatureBytes(unsigned), sig);
  } catch {
    return false;
  }
}

export function putRoomBinding(binding: RoomTreasuryBinding): boolean {
  if (!validBinding(binding)) return false;
  return put(`binding:${binding.roomId}`, binding);
}

export function readRoomBinding(roomId: string): RoomTreasuryBinding | null {
  const m = map();
  if (!m) return null;
  const value = m.get(`binding:${roomId}`);
  return validBinding(value) && value.roomId === roomId ? value : null;
}

// §13.1's immutable-body rule is enforced where receipts are VERIFIABLE —
// against the chain facts they anchor to (spendBundleId, confirmation), the
// node's job from PR D on. At this layer receipts are unauthenticated cache
// entries, so the slot is deliberately plain-replace (invariant 5): a local
// occupancy rule over unverifiable entries would let a planted same-id
// forgery brick honest re-puts forever — the same trap the policy slot
// avoids — while protecting readers from nothing.
export function putReceiptCache(receipt: TreasuryReceipt): boolean {
  if (!isTreasuryReceipt(receipt)) return false;
  if (!onNet(receipt.networkGenesisChallenge)) return false;
  return put(`receipt:${receipt.receiptId}`, receipt);
}

export function readReceiptCache(receiptId: string): TreasuryReceipt | null {
  const m = map();
  if (!m) return null;
  const value = m.get(`receipt:${receiptId}`);
  if (!isTreasuryReceipt(value) || value.receiptId !== receiptId) return null;
  return onNet(value.networkGenesisChallenge) ? value : null;
}

// ---------------------------------------------------------------------------
// Proposal payloads (content-addressed; sovereign §5 data availability)
// ---------------------------------------------------------------------------
// The one record type that is trivially self-verifying: the key IS the sha256
// of the bytes. Voters need the payload behind a proposal's payloadHash to
// know what they are approving (§16.4), and checkpoint publishers MUST retain
// the payloads they root — the office doc is the primary replication lane.

/** Payload ceiling: 256 KiB of bytes (512 KiB hex) keeps doc bloat bounded. */
const PAYLOAD_MAX_HEX = 512 * 1024;

export function putProposalPayload(payloadHex: string): boolean {
  if (typeof payloadHex !== 'string' || payloadHex.length > PAYLOAD_MAX_HEX) return false;
  let hash: Hex32;
  try {
    hash = payloadHashOf(payloadHex);
  } catch {
    return false;
  }
  return put(`payload:${hash}`, payloadHex);
}

export function readProposalPayload(payloadHash: string): string | null {
  const m = map();
  if (!m) return null;
  if (!isHex32(payloadHash)) return null;
  const value = m.get(`payload:${payloadHash}`);
  if (typeof value !== 'string' || value.length > PAYLOAD_MAX_HEX) return null;
  try {
    return payloadHashOf(value) === payloadHash ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chain-sync display status
// ---------------------------------------------------------------------------

export function putChainSyncStatus(status: ChainSyncStatus): boolean {
  if (!isChainSyncStatus(status)) return false;
  return put('sync', status);
}

export function readChainSyncStatus(): ChainSyncStatus | null {
  const m = map();
  if (!m) return null;
  const value = m.get('sync');
  return isChainSyncStatus(value) ? value : null;
}
