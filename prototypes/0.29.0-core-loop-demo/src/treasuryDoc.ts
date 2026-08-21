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
  /**
   * Which network this claim is about (plan §17.5).
   *
   * Added because this entry is the ONLY cache value used as a clock: its
   * height drives every proposal's phase and the funding record's
   * has-it-ended text. Without a genesis it was the one record the pin could
   * not reject, so a peer on another Chia network could supply the height
   * this room reasons with — a testnet height placing mainnet proposals on
   * their clocks. Stamped by putChainSyncStatus, checked on read.
   */
  networkGenesisChallenge: Hex32;
  state: 'verified' | 'degraded' | 'unavailable';
  verifiedHeight?: number;
  verifiedBlockHash?: Hex32;
}

function isChainSyncStatus(value: unknown): value is ChainSyncStatus {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return s.v === 1
    && isHex32(s.networkGenesisChallenge)
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
 *
 * ITERATIVE, not recursive. A node budget does not bound call-stack depth: a
 * peer can nest arrays 64,000 deep, which spends well under the budget and
 * still overflows the stack — throwing, and taking the treasury render with
 * it, exactly as the typed-array freeze did. An explicit queue has no depth
 * limit to hit, and a cyclic value simply spends budget until it is refused.
 */
function withinBudget(root: unknown, budget: number): boolean {
  let left = budget;
  const pending: unknown[] = [];
  // A node is CHARGED WHEN QUEUED, not when popped. That keeps the queue
  // itself from outgrowing the budget — an enormous collection is refused
  // part-way through being walked rather than after it has all been listed.
  const queue = (v: unknown): boolean => {
    if (left <= 0) return false;
    left -= 1;
    pending.push(v);
    return true;
  };
  if (!queue(root)) return false;
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      left -= value.length;
      if (left < 0) return false;
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!queue(item)) return false;
      }
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        left -= key.length;
        if (left < 0) return false;
        if (!queue((value as Record<string, unknown>)[key])) return false;
      }
    }
  }
  return true;
}

/**
 * Roughly the character count a record may occupy before this cache refuses to
 * look at it. Generous: the golden-vector policy is a few hundred characters
 * and the largest record class here is nowhere near this.
 */
const RECORD_BUDGET = 64_000;

/** Convenience wrapper: one budget per call, so callers cannot share state. */
function smallEnough(value: unknown, budget = RECORD_BUDGET): boolean {
  return withinBudget(value, budget);
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
  // Iterative for the same reason withinBudget is: a value can pass the node
  // budget and still be nested deep enough to overflow the call stack, and a
  // throw here aborts the render.
  // Cycles are tracked SEPARATELY from frozenness. Object.isFrozen is a
  // shallow check, so using it as the early-out skipped the children of any
  // object that was already frozen at the top level — and a caller can hand in
  // exactly that: Object.freeze(policy) leaves policy.board and
  // policy.shareClasses mutable. The hash would then be computed and cached
  // over a value whose insides could still change, which is the stale
  // fingerprint this freeze exists to prevent.
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    // Typed arrays are left alone. Object.freeze THROWS on an ArrayBuffer view
    // with elements, and Yjs will happily store a Uint8Array a peer put in a
    // slot — so freezing before the shape guard turned one binary value into
    // an exception that aborted the whole treasury render. No treasury record
    // contains binary, so skipping costs nothing: the value still meets its
    // type guard next and is rejected the ordinary way.
    if (ArrayBuffer.isView(node)) continue;
    // Harmless if it was already frozen; what matters is that its children are
    // still queued below.
    Object.freeze(node);
    for (const key of Object.getOwnPropertyNames(node)) {
      pending.push((node as Record<string, unknown>)[key]);
    }
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

/** A proposal, or why there is none — the same four states as its siblings. */
export type ProposalResult =
  | { status: 'ok'; proposal: TreasuryProposal }
  | { status: 'absent' | 'unreadable' | 'too-large' };

export function readProposalResult(proposalId: string): ProposalResult {
  const m = readMap();
  if (!m) return { status: 'absent' };
  const value = m.get(`proposal:${proposalId}`);
  if (value === undefined) return { status: 'absent' };
  const verdict = proposalVerdict(value);
  if (verdict === 'too-large') return { status: 'too-large' };
  // The slot-claim check stays out of the verdict: it compares the record
  // against the caller's id rather than judging the record itself.
  if (verdict !== 'ok' || (value as TreasuryProposal).proposalId !== proposalId) {
    return { status: 'unreadable' };
  }
  return { status: 'ok', proposal: value as TreasuryProposal };
}

export function readProposal(proposalId: string): TreasuryProposal | null {
  const result = readProposalResult(proposalId);
  return result.status === 'ok' ? result.proposal : null;
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
/**
 * A runaway guard on key EXAMINATION, deliberately far above any plausible
 * room. It is not a page bound: examining a key is a prefix test, so this
 * costs a fraction of a millisecond even at the cap, whereas the old
 * page-sized traversal cap let 800 unrelated keys hide every real record
 * behind a horizon paging could not cross.
 */
const MAX_KEYS_EXAMINED = 50_000;

/**
 * The most signatures one approval round may contribute to a screen.
 *
 * A real board is a handful of signers. This is not a protocol rule — it is
 * the same refusal to do unbounded work on a peer's say-so that RECORD_BUDGET
 * is, applied where an unverified, peer-writable collection feeds a sort and
 * a re-validation on every repaint.
 */
const MAX_SIGS_PER_SESSION = 256;

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
  /**
   * Entries on this page that were checked and failed — wrong shape, wrong
   * network, bad signature, or filed under a key they do not claim.
   *
   * Reported for the same reason as refusedTooLarge, and it was the gap left
   * after that one: a page whose every entry is invalid is not truncated and
   * refuses nothing on size, so a panel reading only those two said "none
   * held" while the room held records it had just rejected.
   */
  rejected: number;
  /** Matching keys found within the traversal budget, before verification. */
  matched: number;
  /** Where this page started in that list. */
  offset: number;
}

/**
 * One page of a bounded scan.
 *
 * A check budget on its own made the list CENSORABLE. The scan always
 * restarted from the beginning, so once the first `maxChecks` prefix-matching
 * entries used the budget up, everything after them was permanently
 * unreachable — and since malformed entries spend budget too, a peer could
 * bury every real proposal behind two dozen pieces of junk. The partial-list
 * warning said the view was incomplete but gave nobody any way to see the
 * rest.
 *
 * So the walk is split. Collecting the matching KEYS is cheap — a prefix test
 * per entry, bounded by `maxEntries` — and only the page's worth of values is
 * verified. Keys are sorted so the page is the same across repaints and an
 * offset means the same thing twice; a peer can grind ids to sort early, but
 * paging past them still works, which is what censorship needs to fail.
 */
function scanPrefixed<T>(
  prefix: string,
  maxEntries: number,
  maxChecks: number,
  take: (key: string, value: unknown) => T | null,
  /** Optional: lets a caller count entries refused on size alone. */
  verdictOf?: (value: unknown) => RecordVerdict,
  offset = 0,
): BoundedScan<T> {
  const m = readMap();
  if (!m) {
    return {
      items: [], truncated: false, refusedTooLarge: 0, rejected: 0, matched: 0, offset: 0,
    };
  }
  // Pass one: which keys match, within ONE budget on keys examined.
  //
  // This has now been wrong twice in the same way, so it is worth being
  // explicit. Any cap that stops the scan early is a horizon, and every
  // horizon is a censorship tool: whatever sits past it cannot be paged to,
  // because paging only moves within what this pass collected. Capping keys
  // EXAMINED let 800 unrelated keys hide everything; moving the cap to keys
  // COLLECTED just moved the horizon, since 800 planted `proposal:` keys
  // ahead of an honest one in iteration order hid it exactly as well.
  //
  // So there is one budget, it is a runaway guard rather than a page, and it
  // is set far above any plausible room. Examining a key is a prefix test on
  // a string this loop already holds, and a matching key costs one array
  // slot — both cheap enough that a generous ceiling is affordable. The bound
  // that governs how long a repaint BLOCKS for is `maxChecks`, which is where
  // the signature work lives; this one only stops an unbounded walk.
  const keys: string[] = [];
  let examined = 0;
  let truncated = false;
  const ceiling = Math.min(maxEntries, MAX_KEYS_EXAMINED);
  for (const key of m.keys()) {
    examined += 1;
    if (examined > ceiling) {
      truncated = true;
      break;
    }
    if (key.startsWith(prefix)) keys.push(key);
  }
  keys.sort();
  const start = Math.max(0, Math.min(offset, keys.length));
  const page = keys.slice(start, start + Math.max(0, maxChecks));
  // Anything the page does not cover is still there to be paged to, and the
  // caller is told so rather than being left to assume it saw everything.
  if (start + page.length < keys.length) truncated = true;
  // Pass two: verify only this page. THIS is the expensive half.
  const items: T[] = [];
  let refusedTooLarge = 0;
  let rejected = 0;
  for (const key of page) {
    const value = m.get(key);
    const verdict = verdictOf?.(value);
    if (verdict === 'too-large') refusedTooLarge += 1;
    const kept = take(key, value);
    if (kept !== null) items.push(kept);
    // Held, checked, and not usable — counted so a panel can say so rather
    // than reporting a page of rejects as an empty room.
    else if (verdict !== 'too-large') rejected += 1;
  }
  return {
    items, truncated, refusedTooLarge, rejected, matched: keys.length, offset: start,
  };
}

export function scanProposals(
  maxEntries: number,
  maxChecks: number,
  /** Where to start in the sorted matching keys — see scanPrefixed. */
  offset = 0,
): BoundedScan<TreasuryProposal> {
  return scanPrefixed(
    'proposal:',
    maxEntries,
    maxChecks,
    (key, value) =>
      validProposal(value) && key === `proposal:${value.proposalId}` ? value : null,
    proposalVerdict,
    offset,
  );
}

export function scanVotes(
  proposalId: string,
  maxEntries: number,
  maxChecks: number,
): BoundedScan<TreasuryVote> {
  const prefix = `vote:${proposalId}:`;
  return scanPrefixed(
    prefix,
    maxEntries,
    maxChecks,
    (key, value) =>
      validVote(value) && key === `vote:${value.proposalId}:${value.voterGamePub}`
        ? value
        : null,
    voteVerdict,
  );
}

export function scanCheckpoints(
  proposalId: string,
  maxEntries: number,
  maxChecks: number,
): BoundedScan<TreasuryCheckpoint> {
  const prefix = `checkpoint:${proposalId}:`;
  return scanPrefixed(
    prefix,
    maxEntries,
    maxChecks,
    (key, value) =>
      validCheckpoint(value) &&
      key === `checkpoint:${value.proposalId}:${value.checkpointId}`
        ? value
        : null,
    checkpointVerdict,
  );
}

// ---------------------------------------------------------------------------
// Votes (signed; per-voter slot with the §7.2 canonical-conflict rule)
// ---------------------------------------------------------------------------

function validVote(value: unknown): value is TreasuryVote {
  return voteVerdict(value) === 'ok';
}

/** The full answer, including a local size refusal. */
function voteVerdict(value: unknown): RecordVerdict {
  return cachedVerdict('vote', value, () => validVoteUncached(value));
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
  // Size FIRST, exactly as the read path does it. Behind the structural
  // guard this bounded nothing: isCompanyTreasuryPolicy walks and
  // deduplicates every signer, class and module before returning, so the put
  // path still paid an arbitrary cost to reject an arbitrary policy.
  //
  // Refusing the same sizes the read refuses also keeps the two agreeing: a
  // policy that puts fine but reads back null forever is the exact foot-gun
  // the encodability probe below exists to avoid.
  if (!smallEnough(policy)) return false;
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

/**
 * An acceptance record, or why there is none.
 *
 * windowsView goes to some trouble to report a MISMATCHED record as a
 * conflict rather than as absence — but a record that fails its shape guard,
 * or that sits under a key it does not claim, never reached it: this reader
 * flattened both to null and the screen said "no acceptance record is held".
 */
export type RegistrationResult =
  | { status: 'ok'; registration: ProposalRegistration }
  | { status: 'absent' | 'unreadable' };

export function readRegistrationResult(proposalId: string): RegistrationResult {
  const m = readMap();
  if (!m) return { status: 'absent' };
  const value = m.get(`registration:${proposalId}`);
  if (value === undefined) return { status: 'absent' };
  return isProposalRegistration(value) && value.proposalId === proposalId
    ? { status: 'ok', registration: value }
    : { status: 'unreadable' };
}

export function readRegistration(proposalId: string): ProposalRegistration | null {
  const result = readRegistrationResult(proposalId);
  return result.status === 'ok' ? result.registration : null;
}

export function putWindowsCache(windows: ProposalWindows): boolean {
  if (!isProposalWindows(windows)) return false;
  return put(`windows:${windows.proposalId}`, windows);
}

/**
 * A cached derivation, returned for display. To TRUST windows, recompute them:
 * deriveProposalWindows(readRegistration(id), rule) — sovereign §4.
 */
/** Cached clocks, or why there are none. Same four states as its siblings. */
export type WindowsCacheResult =
  | { status: 'ok'; windows: ProposalWindows }
  | { status: 'absent' | 'unreadable' };

export function readWindowsCacheResult(proposalId: string): WindowsCacheResult {
  const m = readMap();
  if (!m) return { status: 'absent' };
  const value = m.get(`windows:${proposalId}`);
  if (value === undefined) return { status: 'absent' };
  return isProposalWindows(value) && value.proposalId === proposalId
    ? { status: 'ok', windows: value }
    : { status: 'unreadable' };
}

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
  return checkpointVerdict(value) === 'ok';
}

/** The full answer, including a local size refusal. */
function checkpointVerdict(value: unknown): RecordVerdict {
  return cachedVerdict('checkpoint', value, () => validCheckpointUncached(value));
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
  if (sessionShellVerdict(value) !== 'ok') return false;
  // Only the caller-dependent slot checks stay outside. They compare the
  // record against the caller's arguments rather than judging the record, so
  // caching their result against the object would let a mismatched lookup
  // poison the verdict for the matching one.
  const session = value as SigningSession;
  return session.proposalId === proposalId && session.sessionId === sessionId;
}

/** The full answer for a shell, including a local size refusal. */
function sessionShellVerdict(value: unknown): RecordVerdict {
  return cachedVerdict(
    'session',
    value,
    () => isSigningSession(value) && selfConsistentSession(value),
  );
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
  // Size FIRST, like every other put. isSigningSession walks collectedSigs and
  // allocates for its distinctness check, so behind it this bounded nothing —
  // and the READ side does bound the shell, so without this a session could
  // write fine and then read back 'too-large' forever, which is the put/read
  // disagreement putPolicyCache warns about.
  if (!smallEnough(session)) return false;
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
 * Bounded twin of listSigningSessions, paged like scanPrefixed and for the
 * same reason.
 *
 * Shells are UNSIGNED and peer-writable, so stopping at the check limit was a
 * censorship tool of its own: a peer could plant enough self-consistent shells
 * to push the genuine round past the cut — and, because the old single pass
 * broke out of the whole loop, could arrange for the break to land before that
 * round's SIGNATURE entries too, so even a shell that did survive came back
 * with its approvals missing.
 *
 * Three passes, so no axis can hide another. Keys are collected first (a
 * prefix test, guarded by MAX_KEYS_EXAMINED); shell keys are sorted and a page
 * of them verified — that is where a hash is recomputed; and the signature
 * index is built from every `sessionsig:` key regardless of where the shell
 * page fell, so a shell on this page always gets the approvals it actually
 * holds. Signature entries cost a few string comparisons, not a hash.
 */
export interface SigningSessionScan extends BoundedScan<SigningSession> {
  /**
   * The sessions whose signature set was cut short by a local cap, so their
   * `collectedSigs` may be fewer than the room holds.
   *
   * Per session, not a scan-wide flag: only ONE round's count is rendered, so
   * a flag covering the whole scan let an expired or foreign round hitting
   * the cap put an "at least" on a selected round that was complete.
   * Reported apart from `truncated`, which is about ROUNDS being cut rather
   * than signatures.
   */
  partialSessionIds: string[];
}

export function scanSigningSessions(
  proposalId: string,
  maxEntries: number,
  maxChecks: number,
  offset = 0,
): SigningSessionScan {
  const m = readMap();
  if (!m) {
    return {
      items: [], truncated: false, refusedTooLarge: 0, rejected: 0, matched: 0,
      offset: 0, partialSessionIds: [],
    };
  }
  const shellPrefix = `session:${proposalId}:`;
  let examined = 0;
  let truncated = false;
  let refusedTooLarge = 0;
  let rejected = 0;
  // Pass one: shell keys only. Signature keys are NOT collected here. Sharing
  // one budget with them was the same censorship shape the shells had: 800
  // unrelated `sessionsig:` entries filled it and broke the whole scan, so
  // later signatures — and later SHELLS — were never reached, which flatly
  // contradicted the guarantee that a paged shell carries its approvals.
  const shellKeys: string[] = [];
  const ceiling = Math.min(maxEntries, MAX_KEYS_EXAMINED);
  for (const key of m.keys()) {
    examined += 1;
    if (examined > ceiling) {
      truncated = true;
      break;
    }
    if (key.startsWith(shellPrefix)) shellKeys.push(key);
  }
  shellKeys.sort();
  const start = Math.max(0, Math.min(offset, shellKeys.length));
  const page = shellKeys.slice(start, start + Math.max(0, maxChecks));
  if (start + page.length < shellKeys.length) truncated = true;

  // Pass two: signatures for THIS PAGE's sessions, chosen after the page is.
  // Filtering during examination means a flood of signatures for other
  // sessions costs a Set lookup each and cannot crowd out the ones that
  // belong here — the collection budget applies only to signatures this page
  // can actually use, which real signers bound.
  const wanted = new Set(page.map((key) => key.slice(shellPrefix.length)));
  const sigsBySession = new Map<string, { signerPuzzleHash: Hex32; sig: string }[]>();
  // Its OWN counter. Sharing the shell pass's meant a large map spent most of
  // the allowance before this pass began — on a 30,000-key map only 20,000
  // keys remained — so a selected round could still come back missing
  // signatures held later in the map, which is the very guarantee this split
  // was made to provide.
  let sigExamined = 0;
  const partialSessions = new Set<string>();
  for (const key of m.keys()) {
    sigExamined += 1;
    if (sigExamined > ceiling) {
      // Cut short mid-collection: every session still wanted may be missing
      // signatures it holds, so all of them are flagged rather than none.
      for (const id of wanted) partialSessions.add(id);
      truncated = true;
      break;
    }
    if (!key.startsWith('sessionsig:')) continue;
    // Session ids are fixed-width Hex32, so the key decomposes exactly.
    const sessionId = key.slice('sessionsig:'.length, 'sessionsig:'.length + 64);
    if (!wanted.has(sessionId)) continue;
    // Per session, not just per scan. Signature entries are peer-writable and
    // unverified at this layer, so one wanted session could otherwise absorb
    // the whole ceiling — and every repaint would then store, sort and
    // re-validate an arbitrarily long array, straight past the detail
    // screen's cost budget.
    const already = sigsBySession.get(sessionId);
    if (already && already.length >= MAX_SIGS_PER_SESSION) {
      partialSessions.add(sessionId);
      continue;
    }
    const value = m.get(key);
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (!isHex32(entry.signerPuzzleHash)) continue;
    if (key !== `sessionsig:${sessionId}:${entry.signerPuzzleHash}`) continue;
    if (typeof entry.sig !== 'string' || entry.sig.length === 0) continue;
    let bucket = sigsBySession.get(sessionId);
    if (!bucket) {
      bucket = [];
      sigsBySession.set(sessionId, bucket);
    }
    bucket.push({ signerPuzzleHash: entry.signerPuzzleHash, sig: entry.sig });
  }

  const out: SigningSession[] = [];
  for (const key of page) {
    const value = m.get(key);
    // Counted, not just skipped: a shell refused on size is a record this
    // room holds, so leaving it out silently would report "no open round"
    // about a round that exists.
    const verdict = sessionShellVerdict(value);
    if (verdict === 'too-large') refusedTooLarge += 1;
    const sessionId = key.slice(shellPrefix.length);
    if (!validSessionShell(value, proposalId, sessionId)) {
      if (verdict !== 'too-large') rejected += 1;
      continue;
    }
    const collectedSigs = (sigsBySession.get(sessionId) ?? [])
      .sort((a, b) => (a.signerPuzzleHash < b.signerPuzzleHash ? -1 : 1));
    const assembled = { ...(value as SigningSession), collectedSigs };
    if (isSigningSession(assembled)) out.push(assembled);
    else rejected += 1;
  }
  return {
    items: out,
    truncated,
    refusedTooLarge,
    rejected,
    matched: shellKeys.length,
    offset: start,
    partialSessionIds: [...partialSessions],
  };
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

/** Payload bytes, or why there are none — same four states as the others. */
export type PayloadResult =
  | { status: 'ok'; hex: string }
  | { status: 'absent' | 'unreadable' | 'too-large' };

export function readProposalPayloadResult(payloadHash: string): PayloadResult {
  const m = readMap();
  if (!m) return { status: 'absent' };
  if (!isHex32(payloadHash)) return { status: 'absent' };
  const value = m.get(`payload:${payloadHash}`);
  if (value === undefined) return { status: 'absent' };
  if (typeof value !== 'string') return { status: 'unreadable' };
  // Over the cap is this device's own refusal — the payload may be perfectly
  // good — so it is reported apart from a payload nobody here holds.
  if (value.length > PAYLOAD_MAX_HEX) return { status: 'too-large' };
  try {
    return payloadHashOf(value) === payloadHash
      ? { status: 'ok', hex: value }
      : { status: 'unreadable' };
  } catch {
    return { status: 'unreadable' };
  }
}

export function readProposalPayload(payloadHash: string): string | null {
  const result = readProposalPayloadResult(payloadHash);
  return result.status === 'ok' ? result.hex : null;
}

// ---------------------------------------------------------------------------
// Chain-sync display status
// ---------------------------------------------------------------------------

/**
 * Publishes this node's chain view for the room to display.
 *
 * The genesis is STAMPED here from the active pin rather than taken from the
 * caller, so a claim can only ever be about the network this device is
 * actually on — and so callers cannot forget the field that makes the read
 * side able to reject someone else's chain.
 */
export function putChainSyncStatus(
  status: Omit<ChainSyncStatus, 'networkGenesisChallenge'>,
): boolean {
  if (expectedGenesis === null) return false;
  const stamped: ChainSyncStatus = {
    ...status,
    networkGenesisChallenge: expectedGenesis,
  };
  if (!isChainSyncStatus(stamped)) return false;
  return put('sync', stamped);
}

/** A peer's chain-view claim, or why there is none. */
export type ChainSyncResult =
  | { status: 'ok'; sync: ChainSyncStatus }
  | { status: 'absent' | 'unreadable' };

export function readChainSyncStatusResult(): ChainSyncResult {
  const m = readMap();
  if (!m) return { status: 'absent' };
  const value = m.get('sync');
  if (value === undefined) return { status: 'absent' };
  // Held but malformed is not "nobody has said anything" — somebody wrote
  // here, and what they wrote could not be read. A claim about ANOTHER
  // network reads the same way: something is here, and it is not about this
  // chain, so it cannot be this room's clock.
  if (!isChainSyncStatus(value)) return { status: 'unreadable' };
  if (!onNet(value.networkGenesisChallenge)) return { status: 'unreadable' };
  return { status: 'ok', sync: value };
}

export function readChainSyncStatus(): ChainSyncStatus | null {
  const result = readChainSyncStatusResult();
  return result.status === 'ok' ? result.sync : null;
}
