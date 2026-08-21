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
  // The pin and the verifier are inputs to every cached verdict, and both may
  // have just changed — start again rather than trust answers computed under
  // the previous binding.
  verdictCaches = freshVerdictCaches();
  policyResults = new WeakMap();
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

/**
 * The map, but only once a network is pinned — every READ goes through here.
 *
 * With `expectedGenesis` null nothing can be on-net, so every read's answer is
 * already null. Returning it now matters for more than tidiness: each reader
 * validated the peer-written value in full BEFORE reaching its `onNet` check,
 * so an unconfigured build still paid structural validation over whatever a
 * peer chose to write — on every repaint, for a result fixed in advance.
 *
 * Writes keep using `map()`: their input is local, and each `put*` already
 * refuses off-net records up front. `map()` also stays pin-agnostic because
 * `treasuryDocBound()` answers "is a room document attached", which callers
 * report to the player quite differently from "no network is configured".
 */
function readMap(): Y.Map<unknown> | null {
  return expectedGenesis === null ? null : map();
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

/**
 * Validation verdicts, keyed by the identity of the stored object.
 *
 * The entry budget bounds how many records a repaint LOOKS at; it says nothing
 * about what each one costs. Every check below recomputes a canonical id or
 * hash and verifies an ed25519 signature — measured at roughly 1.4 ms per
 * proposal, so a peer who plants 800 valid self-signed proposals freezes the
 * main thread for over a second on EVERY repaint. Coalescing repaints does not
 * help: it bounds how often a render runs, never how long one takes.
 *
 * Y.Map hands back the same object reference for an entry that has not
 * changed, so keying on that reference turns a repeat scan into pointer
 * lookups while a genuinely new or replaced record still pays full price once.
 * A WeakMap so evicted records do not pin memory.
 *
 * This cannot mask a change: these records are immutable by construction (id
 * and signature cover the body), and a replaced value is a different object.
 * It is reset on rebind because `expectedGenesis` and `verifySig` are inputs
 * to the verdict and both change there.
 */
type VerdictClass = 'proposal' | 'vote' | 'checkpoint' | 'binding' | 'session';

/**
 * Why a record is or is not usable — three answers, not two.
 *
 *  'ok'         valid, and checked here.
 *  'invalid'    held, but fails its shape, pin, id or signature.
 *  'too-large'  held, quite possibly valid on the wire, and refused only
 *               because reading it would cost this device more than it is
 *               willing to spend.
 *
 * The last one is a LOCAL decision, so collapsing it into 'invalid' — or into
 * the `null` a reader returns for both — would have the UI report a record the
 * room is holding as one that does not exist. That is the absence-as-fact
 * mistake this module refuses everywhere else, and readPolicyCacheResult
 * already refuses it for the policy slot.
 */
export type RecordVerdict = 'ok' | 'invalid' | 'too-large';

function freshVerdictCaches(): Record<VerdictClass, WeakMap<object, RecordVerdict>> {
  return {
    proposal: new WeakMap(),
    vote: new WeakMap(),
    checkpoint: new WeakMap(),
    binding: new WeakMap(),
    session: new WeakMap(),
  };
}

let verdictCaches = freshVerdictCaches();

/**
 * Is `value` small enough to be worth validating? Answered in CONSTANT time.
 *
 * Counting array lengths was not enough: every string field in these records
 * is checked with isNonEmptyString and has no length limit, so one share class
 * carrying a megabyte `id` — or one proposal with a huge `proposerPub` — still
 * dragged the canonical encoder and the hash function across it before it
 * could be rejected. A budget bounds counts and text together.
 *
 * The early-out is the whole point: the walk stops the moment the budget runs
 * out, so an oversized record costs the budget rather than its own size. That
 * is what makes the refusal cheap enough to sit on the repaint path. Iterated
 * lazily (for…in, for…of) rather than through Object.entries, which would
 * materialise an array as long as the object a peer chose to send.
 */
function withinBudget(value: unknown, budget: { left: number }): boolean {
  if (budget.left <= 0) return false;
  budget.left -= 1;
  if (typeof value === 'string') {
    budget.left -= value.length;
    return budget.left >= 0;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!withinBudget(item, budget)) return false;
    }
    return true;
  }
  if (typeof value === 'object' && value !== null) {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      budget.left -= key.length + 1;
      if (budget.left < 0) return false;
      if (!withinBudget((value as Record<string, unknown>)[key], budget)) return false;
    }
    return true;
  }
  return budget.left >= 0;
}

/**
 * Roughly the character count a record may occupy before this cache refuses to
 * look at it. Generous: the golden-vector policy is a few hundred characters
 * and the largest record class here is nowhere near this.
 */
const RECORD_BUDGET = 64_000;

/** Convenience wrapper: one budget per call, so callers cannot share state. */
function smallEnough(value: unknown, budget = RECORD_BUDGET): boolean {
  return withinBudget(value, { left: budget });
}

/**
 * Freezes a record, and everything under it, before its verdict is cached.
 *
 * The memo keys on object identity, which is only sound if identity implies
 * the bytes have not changed — and these are plain mutable objects that the
 * read APIs hand out by reference. Without this, code that mutated a record
 * in place after it validated (putProposal validates the very object it then
 * stores, and its caller still holds the reference) would keep the cache hit
 * and have altered contents reported as signed. Freezing makes the assumption
 * true rather than merely assumed, and it protects callers from doing it by
 * accident: these records are immutable by construction, since their id and
 * signature cover the body.
 *
 * Shallow freezing would not do — a policy's board, share classes and rules
 * are nested. The isFrozen early-out both prunes repeat work and terminates
 * on a cyclic value.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  // Typed arrays are left alone. Object.freeze THROWS on an ArrayBuffer view
  // with elements, and Yjs will happily store a Uint8Array a peer put in a
  // slot — so freezing before the shape guard turned one binary value into an
  // exception that aborted the whole treasury render. No treasury record
  // contains binary, so skipping here costs nothing: the value still meets its
  // type guard next and is rejected the ordinary way.
  if (ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Memoizes a validator over a peer-written value. Non-objects skip the memo.
 *
 * Keyed by RECORD CLASS as well as identity. A single shared map storing bare
 * booleans answered the wrong question: "has this object been validated?"
 * rather than "is this object a valid X?". The type guards accept extra
 * fields, so one object filed under two slots — a proposal that is also
 * written to a `vote:` key — would take the proposal's cached `true` and be
 * handed back as a vote, its own shape and signature never checked. Per-class
 * maps make a hit mean what the caller asked.
 */
function cachedVerdict(
  cls: VerdictClass,
  value: unknown,
  compute: () => boolean,
): RecordVerdict {
  if (typeof value !== 'object' || value === null) return compute() ? 'ok' : 'invalid';
  const verdicts = verdictCaches[cls];
  const hit = verdicts.get(value);
  if (hit !== undefined) return hit;
  // Size first, and before the freeze: deepFreeze walks the whole value, so
  // running it on an unbounded record would pay exactly the cost the size
  // check exists to avoid. A record too large to be plausible is refused
  // without the encoder, the hash or the freeze ever touching it — and the
  // refusal is cached, so re-reading cannot re-charge it.
  let verdict: RecordVerdict;
  if (!smallEnough(value)) {
    verdict = 'too-large';
  } else {
    // Frozen BEFORE the verdict is computed and stored, so there is no window
    // in which a cached verdict describes bytes that can still change.
    deepFreeze(value);
    verdict = compute() ? 'ok' : 'invalid';
  }
  verdicts.set(value, verdict);
  return verdict;
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
  return proposalVerdict(value) === 'ok';
}

/** The full answer, including a local size refusal. */
function proposalVerdict(value: unknown): RecordVerdict {
  return cachedVerdict('proposal', value, () => validProposalUncached(value));
}

function validProposalUncached(value: unknown): value is TreasuryProposal {
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
  const m = readMap();
  if (!m) return null;
  const value = m.get(`proposal:${proposalId}`);
  return validProposal(value) && value.proposalId === proposalId ? value : null;
}

export function listProposals(): TreasuryProposal[] {
  return scanProposals(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY).items;
}

/**
 * A scan bounded on TWO axes, because the map's entries do not all cost the
 * same and a single budget can only bound one of them.
 *
 *  `maxEntries` — every key the iteration touches, whatever its prefix.
 *      Skipping a wrong-prefix key is cheap but not free, and anyone can add
 *      unlimited `junk:*` keys to a peer-writable, never-pruned map. Without
 *      this bound an attacker sets how far every repaint walks.
 *
 *  `maxChecks` — entries that match the prefix and are therefore handed to
 *      `take`, which re-derives a canonical id or hash and verifies an
 *      ed25519 signature: roughly 1.4 ms EACH. Traversal budget alone never
 *      bounded this. 800 matching entries is over a second of blocked main
 *      thread, and the identity memo does not save a repaint that is seeing
 *      those records for the first time — a peer who keeps writing NEW
 *      records is writing new object identities, so every one is a miss.
 *      This is the budget that keeps a repaint's cost bounded.
 *
 * Neither bound hides what it drops. Hitting either sets `truncated`, which
 * means "this view is partial and its contents are an arbitrary subset",
 * never "the first N".
 *
 * The lasting fix is a per-class index so each record type can be reached
 * without walking shared space, plus validation moved off the render path;
 * that belongs with the op-log durability work the plans already schedule.
 */
export interface BoundedScan<T> {
  items: T[];
  truncated: boolean;
  /**
   * How many entries this device declined to read on size alone. Counted
   * apart from invalid ones: those may well be valid records, refused by a
   * local budget, so folding them into the same silence would let the list
   * report "no proposals" about proposals the room is holding.
   */
  refusedTooLarge: number;
}

function scanPrefixed<T>(
  prefix: string,
  maxEntries: number,
  maxChecks: number,
  take: (key: string, value: unknown) => T | null,
  /** Optional: lets a caller count entries refused on size alone. */
  verdictOf?: (value: unknown) => RecordVerdict,
): BoundedScan<T> {
  const m = readMap();
  if (!m) return { items: [], truncated: false, refusedTooLarge: 0 };
  const items: T[] = [];
  let visited = 0;
  let checked = 0;
  let refusedTooLarge = 0;
  for (const [key, value] of m.entries()) {
    // Counted BEFORE the prefix test: a skipped key is still a key this
    // repaint had to look at.
    if (visited >= maxEntries) return { items, truncated: true, refusedTooLarge };
    visited += 1;
    if (!key.startsWith(prefix)) continue;
    // Counted BEFORE `take` runs, for the same reason: the check is the
    // expensive part, so the budget has to be spent before it, not after.
    if (checked >= maxChecks) return { items, truncated: true, refusedTooLarge };
    checked += 1;
    // Asked first, so the verdict is cached and `take` costs nothing extra.
    if (verdictOf?.(value) === 'too-large') refusedTooLarge += 1;
    const kept = take(key, value);
    if (kept !== null) items.push(kept);
  }
  return { items, truncated: false, refusedTooLarge };
}

export function scanProposals(
  maxEntries: number,
  maxChecks: number,
): BoundedScan<TreasuryProposal> {
  return scanPrefixed(
    'proposal:',
    maxEntries,
    maxChecks,
    (key, value) =>
      validProposal(value) && key === `proposal:${value.proposalId}` ? value : null,
    proposalVerdict,
  );
}

export function scanVotes(
  proposalId: string,
  maxEntries: number,
  maxChecks: number,
): BoundedScan<TreasuryVote> {
  const prefix = `vote:${proposalId}:`;
  return scanPrefixed(prefix, maxEntries, maxChecks, (key, value) =>
    validVote(value) && key === `vote:${value.proposalId}:${value.voterGamePub}`
      ? value
      : null,
  );
}

export function scanCheckpoints(
  proposalId: string,
  maxEntries: number,
  maxChecks: number,
): BoundedScan<TreasuryCheckpoint> {
  const prefix = `checkpoint:${proposalId}:`;
  return scanPrefixed(prefix, maxEntries, maxChecks, (key, value) =>
    validCheckpoint(value) &&
    key === `checkpoint:${value.proposalId}:${value.checkpointId}`
      ? value
      : null,
  );
}

// ---------------------------------------------------------------------------
// Votes (signed; per-voter slot with the §7.2 canonical-conflict rule)
// ---------------------------------------------------------------------------

function validVote(value: unknown): value is TreasuryVote {
  return cachedVerdict('vote', value, () => validVoteUncached(value)) === 'ok';
}

function validVoteUncached(value: unknown): value is TreasuryVote {
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
  const m = readMap();
  if (!m) return null;
  const value = m.get(`vote:${proposalId}:${voterGamePub}`);
  if (!validVote(value)) return null;
  // The record must claim the slot it sits in.
  if (value.proposalId !== proposalId || value.voterGamePub !== voterGamePub) return null;
  return value;
}

export function listVotes(proposalId: string): TreasuryVote[] {
  const m = readMap();
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
  // Same budget the read applies. Refusing here too keeps put and read
  // agreeing: a policy that puts fine but reads back null forever is the exact
  // foot-gun the encodability probe below exists to avoid.
  if (!smallEnough(policy)) return false;
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

/**
 * Why the policy cache has nothing usable — four different facts, kept apart.
 *
 *  'ok'          a policy is held and was checked here.
 *  'absent'      no policy entry, or no readable cache at all.
 *  'unreadable'  an entry is held but fails its shape, pin or encoding.
 *  'too-large'   an entry is held and may well be valid on the wire; this
 *                device simply refuses to spend the work to read it.
 *
 * The last two are held records. Reporting them as absence would tell a player
 * "no company policy" about a policy sitting in the room they are standing in.
 */
export type PolicyCacheResult =
  | { status: 'ok'; policy: CompanyTreasuryPolicy; policyHash: Hex32 }
  | { status: 'absent' | 'unreadable' | 'too-large' };

/**
 * The returned hash is recomputed here — compare it against the on-chain
 * commitment.
 *
 * Memoized on the stored object for the same reason the validators are, and
 * more sharply: a policy carries unbounded signer, share-class and module
 * arrays, and validating plus hashing one holding 20,000 share classes was
 * measured at 627 ms — paid on every repaint, for a value that had not
 * changed. Keyed on identity, so a policy a peer actually replaces is a new
 * object and is checked afresh.
 *
 * The memo alone did not close the hole: every peer REWRITE is a new object,
 * so a peer rewriting the key in a loop pays that 627 ms afresh each repaint
 * and never hits the cache. The size budget in readPolicyUncached is what
 * bounds it.
 */
let policyResults = new WeakMap<object, { result: PolicyCacheResult }>();

/** Full result, including WHY there is nothing to show. */
export function readPolicyCacheResult(): PolicyCacheResult {
  const m = readMap();
  if (!m) return { status: 'absent' };
  const value = m.get('policy');
  if (value === undefined) return { status: 'absent' };
  if (typeof value !== 'object' || value === null) return { status: 'unreadable' };
  const hit = policyResults.get(value);
  if (hit) return hit.result;
  // The WRAPPER is frozen too, not just the policy inside it. This exact
  // object is handed to every caller from here on, so a consumer that wrote
  // to `status` or `policyHash` would have later reads return altered derived
  // data — the hash beside a policy it no longer describes — without anything
  // recomputing. Freezing the nested value alone left that open.
  const result = deepFreeze(readPolicyUncached(value));
  policyResults.set(value, { result });
  return result;
}

/** The usable policy, or null. Callers needing the reason use the result form. */
export function readPolicyCache(): { policy: CompanyTreasuryPolicy; policyHash: Hex32 } | null {
  const result = readPolicyCacheResult();
  // The memoized result object itself, never a copy. Copying would hand back
  // a different object on every call and quietly undo the stable identity the
  // memo exists to give; the extra `status` field costs a caller nothing.
  return result.status === 'ok' ? result : null;
}

function readPolicyUncached(value: unknown): PolicyCacheResult {
  // Size first, and before the freeze — same order and same reason as
  // cachedVerdict. Running the structural walk or the hash first would pay
  // exactly the cost this check exists to avoid.
  //
  // "Too large" is reported as its OWN state, not folded into unreadable.
  // This cap is a local display decision rather than a protocol rule, so a
  // record that is perfectly valid on the wire can fail it — and answering
  // that with the same silence as a missing record would have the UI say "no
  // company policy" about a policy this room is holding right now. That is
  // the absence-as-fact mistake the rest of the module refuses to make.
  if (!smallEnough(value)) return { status: 'too-large' };
  deepFreeze(value);
  if (!isCompanyTreasuryPolicy(value)) return { status: 'unreadable' };
  if (!onNet(value.networkGenesisChallenge)) return { status: 'unreadable' };
  try {
    return { status: 'ok', policy: value, policyHash: policyHashOf(value) };
  } catch {
    return { status: 'unreadable' }; // unencodable strings
  }
}

export function putAllowanceCache(allowance: DeviceAllowance): boolean {
  if (!isDeviceAllowance(allowance)) return false;
  if (!onNet(allowance.networkGenesisChallenge)) return false;
  return put(`allowance:${allowance.allowanceId}`, allowance);
}

export function readAllowanceCache(allowanceId: string): DeviceAllowance | null {
  const m = readMap();
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
  const m = readMap();
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
  const m = readMap();
  if (!m) return null;
  const value = m.get(`windows:${proposalId}`);
  return isProposalWindows(value) && value.proposalId === proposalId ? value : null;
}

// ---------------------------------------------------------------------------
// Checkpoints (chain-anchored; multiple per proposal are normal)
// ---------------------------------------------------------------------------

function validCheckpoint(value: unknown): value is TreasuryCheckpoint {
  return cachedVerdict('checkpoint', value, () => validCheckpointUncached(value)) === 'ok';
}

function validCheckpointUncached(value: unknown): value is TreasuryCheckpoint {
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
  const m = readMap();
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
  if (typeof value !== 'object' || value === null) return false;
  // EVERYTHING that judges the record itself goes inside the memo, the shape
  // guard included. isSigningSession walks collectedSigs and allocates for its
  // distinctness check, so leaving it outside meant a peer-written shell with
  // a huge signature array was walked in full on every repaint — before the
  // size budget could refuse it, and without the memo ever saving a repeat.
  if (cachedVerdict('session', value, () => isSigningSession(value) && selfConsistentSession(value)) !== 'ok') {
    return false;
  }
  // Only the caller-dependent slot checks stay outside. They compare the
  // record against the caller's arguments rather than judging the record, so
  // caching their result against the object would let a mismatched lookup
  // poison the verdict for the matching one.
  const session = value as SigningSession;
  return session.proposalId === proposalId && session.sessionId === sessionId;
}

/** The arg-independent half: on-net, and the shell hashes to its own id. */
function selfConsistentSession(value: unknown): boolean {
  const session = value as SigningSession;
  if (!onNet(session.networkGenesisChallenge)) return false;
  try {
    return signingSessionIdOf(session) === session.sessionId;
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
  return scanSigningSessions(proposalId, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY).items;
}

/**
 * Bounded twin of listSigningSessions, on the same two axes as scanPrefixed.
 * The index pass touches every `sessionsig:` key in the map — including other
 * proposals' — so peer-written signature spam would otherwise grow the work
 * done on every repaint while a detail is open. `maxEntries` counts every slot
 * it looks at, shells and signatures alike; `maxChecks` counts only the shells
 * handed to validSessionShell, which is where a hash gets recomputed. Signature
 * slots cost a few string comparisons and are covered by `maxEntries` alone.
 */
export function scanSigningSessions(
  proposalId: string,
  maxEntries: number,
  maxChecks: number,
): BoundedScan<SigningSession> {
  const m = readMap();
  if (!m) return { items: [], truncated: false, refusedTooLarge: 0 };
  const shellPrefix = `session:${proposalId}:`;
  let visited = 0;
  let checked = 0;
  let truncated = false;
  let refusedTooLarge = 0;
  const shells: { sessionId: string; shell: SigningSession }[] = [];
  const sigsBySession = new Map<string, { signerPuzzleHash: Hex32; sig: string }[]>();
  for (const [key, value] of m.entries()) {
    // Same rule as scanPrefixed: every entry counts, including the ones this
    // scan does not want, or a peer's unrelated keys would be free.
    if (visited >= maxEntries) {
      truncated = true;
      break;
    }
    visited += 1;
    if (!key.startsWith(shellPrefix) && !key.startsWith('sessionsig:')) continue;
    if (key.startsWith(shellPrefix)) {
      if (checked >= maxChecks) {
        truncated = true;
        break;
      }
      checked += 1;
      const sessionId = key.slice(shellPrefix.length);
      if (validSessionShell(value, proposalId, sessionId)) {
        shells.push({ sessionId, shell: value });
      }
    } else {
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
  return { items: out, truncated, refusedTooLarge };
}

// ---------------------------------------------------------------------------
// Room bindings (signed by boundByPub) and receipt caches
// ---------------------------------------------------------------------------

function validBinding(value: unknown): value is RoomTreasuryBinding {
  return bindingVerdict(value) === 'ok';
}

/** The full answer, including a local size refusal. */
function bindingVerdict(value: unknown): RecordVerdict {
  return cachedVerdict('binding', value, () => validBindingUncached(value));
}

function validBindingUncached(value: unknown): value is RoomTreasuryBinding {
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

/**
 * The room's funding binding, or WHY there is none to show — the same four
 * states readPolicyCacheResult reports, and for the same reason: 'too-large'
 * is this device's own refusal, so answering it with the silence used for a
 * missing record would deny a record the room is holding.
 */
export type RoomBindingResult =
  | { status: 'ok'; binding: RoomTreasuryBinding }
  | { status: 'absent' | 'unreadable' | 'too-large' };

export function readRoomBindingResult(roomId: string): RoomBindingResult {
  const m = readMap();
  if (!m) return { status: 'absent' };
  const value = m.get(`binding:${roomId}`);
  if (value === undefined) return { status: 'absent' };
  const verdict = bindingVerdict(value);
  if (verdict === 'too-large') return { status: 'too-large' };
  // The slot-claim check stays out of the verdict: it compares the record
  // against the caller's room id rather than judging the record itself.
  if (verdict !== 'ok' || (value as RoomTreasuryBinding).roomId !== roomId) {
    return { status: 'unreadable' };
  }
  return { status: 'ok', binding: value as RoomTreasuryBinding };
}

export function readRoomBinding(roomId: string): RoomTreasuryBinding | null {
  const result = readRoomBindingResult(roomId);
  return result.status === 'ok' ? result.binding : null;
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
  const m = readMap();
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
  const m = readMap();
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
  const m = readMap();
  if (!m) return null;
  const value = m.get('sync');
  return isChainSyncStatus(value) ? value : null;
}
