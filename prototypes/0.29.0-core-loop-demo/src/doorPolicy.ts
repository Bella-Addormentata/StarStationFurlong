/**
 * 🚦 Per-door permissions + rights requests (#67 D1/D1b/D3)
 *
 * Three shared maps in the room doc (rebind per join, T0 seam, exactly the
 * doorsDoc pattern):
 *  - `doorPolicy`   : door id → { passage, construction } — the owner's rules.
 *  - `doorRequests` : `${doorId}|${pub}` → a player's plea for build rights.
 *  - `doorGrants`   : `${doorId}|${pub}` → EITHER a standing grant OR a
 *                     revocation tombstone (discriminated by `tombstone:true`).
 *
 * MODES. passage: 'public' (default — today's behavior, anyone opens/closes/
 * walks) | 'owner'. construction: 'owner' (default — the v0.30.7 gate) |
 * 'request' (anyone may ASK; owner approves into a grant) | 'public'.
 *
 * Grants are keyed to IDENTITY PUBKEYS (base64url Ed25519, keypair.ts), not
 * ephemeral player ids — a grant survives leave/rejoin and ties into the
 * contacts system. This is the game's first owner-mediated social contract;
 * the same plumbing generalizes to co-host designation (durability C1) later.
 *
 * POLICY LIVES HERE, NOT ON DoorRecord: pairing records are deleted on unpair
 * (the one-way-vestibule investigation's lesson) — policy must survive that.
 *
 * D3 SIGNED ENFORCEMENT (this pass): the three authority-bearing record kinds
 * — doorPolicy (owner-authored), doorGrant (owner-authored), doorRequest
 * (self-authored by the requester) — carry ADDITIVE Ed25519 signatures over
 * domain-tagged, room- and door-scoped canonical bytes (SSF deterministic CBOR
 * borrowed from treasuryTypes so cross-runtime parity is automatic). Reads
 * VERIFY signed records against the current room owner's identity key (or the
 * requester's own key for requests) and skip anything that fails to verify.
 *
 * D3.2 REVOKE-REPLAY DEFENCE (this pass): the naive delete-on-revoke shape
 * from D3 was fail-DANGEROUS — signed grant bytes were valid forever and any
 * peer that retained a deleted grant could re-`set` the map key to restore
 * privileges the owner actively withdrew (dorkmo's reproduction on PR #129,
 * 2026-08-21T22:37Z). The fix follows the treasury's greatest-sequence-wins
 * precedent (sovereign-treasury-serverless-plan.md §5):
 *
 *   1. Grants and tombstones carry a MONOTONIC `seq` inside their signed
 *      envelope (`doorGrantSignatureBytes` includes `seq` when the record has
 *      one). A hostile peer cannot bump the seq of an existing signature
 *      without owning the owner's key.
 *   2. Revocation is a NEW signed record kind — a tombstone — written to the
 *      SAME `${doorId}|${pub}` grants-map slot as the grant it replaces. Its
 *      signature covers `ssf-door-grant-tombstone:v1` domain bytes plus the
 *      slot's roomId/doorId/pub, so tombstones do NOT cross doors or rooms.
 *   3. Read rule: greatest verified `(seq, tombstone-tie-break)` wins per
 *      slot. Tombstone at seq S defeats any grant with seq <= S; a grant at
 *      seq S+1 overrides an earlier tombstone at seq S (higher-seq-regrant).
 *   4. Every reader keeps an IN-MEMORY watermark of the highest verified
 *      (seq, isTombstone) it has observed per slot. A subsequent replay of a
 *      lower-seq grant is rejected against that watermark even if a hostile
 *      peer has CRDT-overwritten the slot with the replayed bytes.
 *
 * MIGRATION (explicit decision — legacy grants readable but always outranked):
 *   - LEGACY UNSIGNED grant (no sig, no seq): still readable — the fail-safe
 *     fallback lets pre-D3 rooms keep working. Treated as `seq = -1` for the
 *     greatest-sequence-wins rule, so ANY seq-carrying record (grant or
 *     tombstone) outranks it. Rationale: not refusing legacy avoids bricking
 *     rooms in the wild; treating it as -1 keeps every signed D3.2 record
 *     authoritative over any legacy record.
 *   - LEGACY SIGNED grant (sig present but no seq — pre-D3.2 branch head
 *     shape): still readable IF the signature verifies against the seq-less
 *     byte shape. Treated as `seq = -1` for the same reason. A hostile peer
 *     that adds a fake seq would break verification (bytes no longer match);
 *     a hostile peer that strips seq would also break verification. Both
 *     downgrade attacks fail closed.
 *   - NEW SIGNED grant (sig + numeric seq): normal D3.2 path. Signature bytes
 *     include seq. Numeric seq >= 0 required — negative or non-integer refused.
 *   - Tombstones ARE new in D3.2 — no legacy tombstone shape exists.
 *
 * FAIL-SAFE FALLBACK (intentional, no migration for the OTHER two record
 * kinds): a record with NEITHER `sig` NOR `pub` fields is treated as LEGACY
 * and honored as today's shape-only read — existing v1 stations keep working
 * across the transition without a schema bump. A record with only one of the
 * two fields is malformed and refused.
 *
 * TRUST BOUNDARY (what the signatures do and don't prove):
 *   PREVENTED:
 *    - A hostile peer forging a doorPolicy that appears owner-authored (the
 *      owner's key does not sign it, so verify-on-read drops it).
 *    - A hostile peer minting a doorGrant for themselves under the owner's
 *      authority (same reason: no owner sig).
 *    - A hostile peer writing a doorRequest with someone else's `pub` in it
 *      (they cannot produce a signature under a key they don't hold).
 *    - Cross-room replay (roomId is inside the signature bytes) and cross-door
 *      replay (doorId is inside too).
 *    - Revoked-grant REPLAY for peers that observed the tombstone. Once a
 *      reader has ever verified a `(seq S, tombstone)` at a slot, no
 *      subsequently-observed grant with seq <= S is accepted, even if a
 *      hostile peer overwrote the CRDT slot with the earlier grant bytes.
 *   NOT PREVENTED (still gated by later slices, DOCUMENTED RESIDUALS):
 *    - A hostile peer OVERWRITING a valid signed record with garbage (Yjs map
 *      LWW rule). Verify-on-read drops the garbage and treats the slot as
 *      absent — so the door FALLS BACK TO DEFAULTS, not to the honest owner's
 *      last policy. Defence in depth here needs signed CRDT operations
 *      (durability C6) and is out of scope for D3.
 *    - Revoked-grant REPLAY against a PEER THAT NEVER OBSERVED THE
 *      TOMBSTONE. `seq` NARROWS the replay window to peers that missed the
 *      revocation (fresh joiners after a hostile tombstone-delete + replay,
 *      or a peer whose browser restarted and lost its in-memory watermark);
 *      it does NOT close the window. Closing it requires signed CRDT ops
 *      (C6) or a chain-anchored tombstone log (chia-authority-architecture),
 *      both out of scope for D3.2.
 *    - The tombstone key ITSELF can be deleted by any peer with map-write
 *      access. A tombstone delete followed by a grant replay is the specific
 *      shape of the residual above. Watermarked peers still refuse; fresh
 *      peers cannot know a tombstone ever existed at that slot.
 *    - Requests are self-signed under any key a player holds. Signing prevents
 *      IMPERSONATING another user; it does not prevent request spam.
 *    - Legacy (unsigned) writes remain accepted, so a hostile peer that can
 *      also write to the doc can plant a legacy record. The dev-phase posture
 *      accepts this trade for zero-migration continuity; a future flag can
 *      flip fallback to strict once every writer signs.
 *    - The owner's LOCAL LOCK toggle (a scratched TODO in the D1 UI) is not
 *      yet in this map, so signing does not cover it until that ships.
 *
 * WHAT THE OWNER KEY IS: the local player's `getIdentityPub()` when the room
 * doc names them owner (`roomInfo.owner === getPlayerId()` AND the players map
 * carries their `keyB64`). Only that local session can sign; other peers read
 * `players.get(ownerId).keyB64` from the room doc as the verifying key. When
 * the room's players map has NOT synced (`ownerPubExpected === null`), signed
 * reads still ACCEPT a record whose carried `ownerPub` verifies its own
 * signature — the verifier keeps forgeries out, and this fail-open posture
 * avoids flickering every un-synced viewer's UI to defaults during T0. Once
 * the expected owner pub IS known, signed records must claim it (a stale
 * owner's signature is stale, not authoritative). See the doc-comment on
 * `isValidSignedPolicy` for the exact rule.
 *
 * MAP-KEY DISCIPLINE (grants/requests): every grant/tombstone/request lives
 * at `${doorId}|${pub}`. The map key is authoritative; a record's carried
 * `doorId`/`pub` MUST equal the key's parts. Reads verify signatures against
 * the KEY's doorId (not the record's), and refuse any record whose carried
 * doorId/pub does not match the slot it was written into. This defeats
 * cross-door / cross-pub lift attacks where a hostile peer copies a valid
 * signed grant UNMODIFIED to a foreign key — the signature bytes are re-built
 * over the key's doorId and no longer match the original sig.
 */

import * as Y from 'yjs';
import { hasDoorLayout } from './doorLayoutDoc';
import { canonicalEncode } from './treasuryTypes';

export type PassageMode = 'public' | 'owner';
export type ConstructionMode = 'owner' | 'request' | 'public';

export interface DoorPolicyRecord {
  passage: PassageMode;
  /** 🚪↦ ONE-WAY travel (owner request): with passage 'public', 'in' lets
   *  guests only ENTER through this door (their departures are refused);
   *  'out' lets guests only EXIT (their arrivals bounce off the turnstile).
   *  Absent = two-way. Owner-equivalents always pass BOTH ways. */
  oneWay?: 'in' | 'out';
  construction: ConstructionMode;
  /** #67 D2: a 🔌 Docking Adapter is INSTALLED at this door — anyone may
   *  TRANSIENTLY berth a ship module here (no chains, no station-graph
   *  permanence, either side detaches). Owner installs/removes (consumes/
   *  refunds an ADAPTER part). */
  adapter?: boolean;
  /** #67 D3: owner identity pubkey that signed this record (base64url Ed25519).
   *  Present on signed writes; absent on legacy unsigned records. */
  ownerPub?: string;
  /** #67 D3: owner signature over doorPolicySignatureBytes (base64url). */
  ownerSig?: string;
}

export interface DoorRightsRequest {
  doorId: string;
  requesterPub: string;   // base64url Ed25519 identity key
  requesterName: string;
  at: number;
  /** #67 D3: self-signed by requesterPub over doorRequestSignatureBytes. Its
   *  purpose is impersonation resistance — a peer cannot file a request that
   *  names another player's pub. Absent on legacy records (still accepted). */
  requesterSig?: string;
}

export interface DoorRightsGrant {
  doorId: string;
  pub: string;
  name: string;
  grantedAt: number;
  /** #67 D3.2: monotonic sequence within (roomId, doorId, pub). A signed
   *  record with a higher seq supersedes any lower-seq record for the same
   *  slot; a tombstone at seq S defeats any grant with seq <= S. Included in
   *  the signature bytes so a hostile peer cannot bump seq without owning
   *  the owner's key. Absent on LEGACY records (pre-D3 unsigned and pre-D3.2
   *  signed-but-seqless), which are treated as seq = -1 by the read rule and
   *  are therefore always outranked by any seq-carrying record. */
  seq?: number;
  ownerPub?: string;
  /** #67 D3: owner signature over doorGrantSignatureBytes. */
  ownerSig?: string;
}

/**
 * #67 D3.2: revocation tombstone written to the SAME grants-map slot as the
 * grant it withdraws. Owner-signed; peers that verify it update their local
 * watermark for the slot and refuse any subsequently-observed lower-seq
 * grant (see module header D3.2 REVOKE-REPLAY DEFENCE and the doc-comment
 * on `isValidSignedGrantTombstone`).
 */
export interface DoorGrantTombstone {
  /** Discriminator; MUST be the literal true so `isTombstoneShape` can pick
   *  this record out of the grants map without ambiguity. */
  tombstone: true;
  doorId: string;
  pub: string;
  revokedAt: number;
  /** #67 D3.2: monotonic sequence — see DoorRightsGrant.seq. Required on
   *  tombstones; a numeric seq >= 0 is mandatory (there is no LEGACY
   *  tombstone shape, since tombstones are new in D3.2). */
  seq: number;
  ownerPub?: string;
  /** #67 D3.2: owner signature over doorGrantTombstoneSignatureBytes. */
  ownerSig?: string;
}

export const DEFAULT_DOOR_POLICY: DoorPolicyRecord = { passage: 'public', construction: 'owner' };

const DOOR_IDS = ['north', 'south', 'east', 'west'] as const;

/**
 * 🚪 #91: policy is keyed by ANY door the room actually has — the 4 cardinal
 * berths plus every free door the editor placed (#28) — not by the cardinal
 * list alone, which silently dropped every write for a `d:` id and pinned its
 * canPass to "public". Unknown ids are still rejected, so a stale id can't
 * spawn a policy record.
 *
 * NOTE the WRITE side has no UI yet: free doors are passages with no terminal
 * (that keypad drove cardinal-only pose math and threw), so today nothing calls
 * writeDoorPolicy for one and a placed door is effectively public two-way. The
 * read side honouring free ids is what makes an affordance — the deferred #28
 * S6d work — a UI-only change rather than another store migration.
 */
function isKnownDoorId(doorId: string): boolean {
  if ((DOOR_IDS as readonly string[]).includes(doorId)) return true;
  return hasDoorLayout(doorId);
}

// ── D3 sign/verify seam ──────────────────────────────────────────────────────
//
// The verifier and signer are INJECTED, not imported, so this module stays
// encoding-agnostic (identical seam to treasuryDoc.ts). The browser wires
// keypair.ts's verifyIdentity + signIdentity; tests wire @noble/ed25519
// directly with hex-encoded pubs and sigs.
//
// `roomOwnerPub` is a LIVE READ, not a snapshot: the room's owner value may
// arrive after this module binds (players/roomInfo sync asynchronously per
// the T0 seam), and a rotated owner key must take effect immediately without
// re-binding. `localPub` is also a live read for the same reason.
//
// `signOwner` returns a base64url-shaped signature; it fires only when the
// LOCAL player is the current room owner. Guest sessions still call
// writeDoorPolicy / writeDoorGrant via the UI (owner-only gate is already
// enforced at the caller in docking.ts) — this module treats a signer-less
// write as legacy (no sig fields) rather than refusing it, so a room that
// binds without a signer keeps writing today's unsigned records.

/** (pub, bytes, sig) → boolean. Same shape as TreasurySigVerifier. */
export type DoorSigVerifier = (pub: string, bytes: Uint8Array, sig: string) => boolean;
/** (bytes) → signature string. Returns null on any error so writes stay total. */
export type DoorSigner = (bytes: Uint8Array) => string | null;

export interface DoorPolicyBindOptions {
  /** roomId scope inside every signature — cross-room replay refuses without
   *  bumping the domain tag. */
  roomId?: string;
  verifySig?: DoorSigVerifier;
  /** Live-read of the current room owner's identity pub, or null if not yet
   *  synced / no owner. */
  roomOwnerPub?: () => string | null;
  /** Live-read of the local player's identity pub (for self-signed requests
   *  and for the owner-signing check). */
  localPub?: () => string | null;
  /** Signer used when the local session is the room owner. */
  signOwner?: DoorSigner;
  /** Signer used for the local player's own requests. */
  signSelf?: DoorSigner;
}

let boundDoc: Y.Doc | null = null;
let policyMap: Y.Map<unknown> | null = null;
let requestsMap: Y.Map<unknown> | null = null;
let grantsMap: Y.Map<unknown> | null = null;
let boundRoomId: string = '';
let verifier: DoorSigVerifier | null = null;
let ownerPubReader: (() => string | null) | null = null;
let localPubReader: (() => string | null) | null = null;
let ownerSigner: DoorSigner | null = null;
let selfSigner: DoorSigner | null = null;
const listeners = new Set<() => void>();

// ── D3.2 in-memory watermark ────────────────────────────────────────────────
//
// Per-slot record of the highest verified (seq, isTombstone) this reader has
// ever observed for `${roomId}|${doorId}|${pub}`. Read updates bump it;
// writes bump it too so the writer's own subsequent reads reflect the new
// state without needing another observation cycle. Cleared when the bound
// doc changes (fresh join = fresh context) so tests and cross-room binds do
// not inherit stale watermarks.
//
// This is IN-MEMORY BY DESIGN — persisting it would require another layer
// hostile peers can attack (see module header, DOCUMENTED RESIDUALS). The
// caveat: a browser restart loses watermarks; a fresh join after a hostile
// tombstone-delete + replay accepts the replayed grant. `seq` narrows the
// replay window, it does not close it.
type SeqObservation = { seq: number; isTombstone: boolean };
const grantSeqWatermark = new Map<string, SeqObservation>();

function watermarkKey(roomId: string, doorId: string, pub: string): string {
  return `${roomId}|${doorId}|${pub}`;
}

function watermarkOf(doorId: string, pub: string): SeqObservation {
  return grantSeqWatermark.get(watermarkKey(boundRoomId, doorId, pub))
    ?? { seq: -1, isTombstone: false };
}

/** True iff `a` strictly outranks `b` under greatest-sequence-wins with
 *  tombstone-beats-grant on ties. Used both to compare a candidate record
 *  against the watermark and to decide whether to advance the watermark. */
function seqOutranks(a: SeqObservation, b: SeqObservation): boolean {
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.isTombstone && !b.isTombstone;
}

/** Bump the watermark for a slot if the observation is strictly higher.
 *  Never lowers; equal observations are a no-op. */
function bumpWatermark(doorId: string, pub: string, obs: SeqObservation): void {
  const cur = watermarkOf(doorId, pub);
  if (seqOutranks(obs, cur)) {
    grantSeqWatermark.set(watermarkKey(boundRoomId, doorId, pub), obs);
  }
}

function notify(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[doorPolicy] listener threw:', e); }
  }
}

/**
 * Bind the three maps to a fresh room doc. Options are optional so callers
 * that do not yet have the signing seam wired (or tests that only need the
 * legacy behavior) keep working — the module falls back to today's shape-only
 * behavior in that case.
 */
export function bindDoorPolicy(doc: Y.Doc, opts: DoorPolicyBindOptions = {}): void {
  // Clear watermarks whenever the bound doc changes (a fresh join is a fresh
  // context — a different room, or a rejoin after leave, cannot inherit the
  // prior doc's revocation observations). Rebinding the SAME doc preserves
  // watermarks (e.g. UI re-init, seam re-wire).
  if (boundDoc !== doc) {
    grantSeqWatermark.clear();
  }
  boundDoc = doc;
  policyMap = doc.getMap('doorPolicy');
  requestsMap = doc.getMap('doorRequests');
  grantsMap = doc.getMap('doorGrants');
  boundRoomId = typeof opts.roomId === 'string' ? opts.roomId : '';
  verifier = opts.verifySig ?? null;
  ownerPubReader = opts.roomOwnerPub ?? null;
  localPubReader = opts.localPub ?? null;
  ownerSigner = opts.signOwner ?? null;
  selfSigner = opts.signSelf ?? null;
  policyMap.observe(() => notify());
  requestsMap.observe(() => notify());
  grantsMap.observe(() => notify());
  notify();
}

export function subscribeDoorPolicy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && policyMap !== null;
}

// ── Signature bytes (domain-tagged, canonical CBOR from treasuryTypes) ───────
//
// One helper per record kind. Every domain tag pins the room AND the door so a
// signature valid in one context refuses to authenticate another; canonical
// encoding gives byte-for-byte equality across runtimes (treasuryTypes owns
// the profile and the Rust twin in ssf-p2p-node/src/treasury_codec.rs).

/** Bytes the room owner signs for a doorPolicy record. */
export function doorPolicySignatureBytes(
  roomId: string,
  doorId: string,
  policy: Pick<DoorPolicyRecord, 'passage' | 'oneWay' | 'construction' | 'adapter'>,
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-door-policy:v1',
    roomId,
    doorId,
    policy: {
      passage: policy.passage,
      // Absent optional fields hash as explicit null (matches the treasury
      // helpers and the Rust codec's skip_serializing_if convention).
      oneWay: policy.oneWay === 'in' || policy.oneWay === 'out' ? policy.oneWay : null,
      construction: policy.construction,
      adapter: policy.adapter === true,
    },
  });
}

/**
 * Bytes the room owner signs for a doorGrant record. `seq` is included when
 * present (D3.2 records) and omitted when absent (LEGACY signed-seqless
 * records — see MIGRATION in the module header). The canonical encoder sorts
 * by key bytes, so key ORDER inside `grant` does not affect the output —
 * only key PRESENCE does, which is exactly what discriminates the two byte
 * shapes for downgrade-attack resistance.
 */
export function doorGrantSignatureBytes(
  roomId: string,
  doorId: string,
  grant: Pick<DoorRightsGrant, 'pub' | 'name' | 'grantedAt'> & { seq?: number },
): Uint8Array {
  const inner: { [k: string]: string | number } = {
    pub: grant.pub,
    name: grant.name,
    grantedAt: grant.grantedAt,
  };
  if (typeof grant.seq === 'number') {
    inner.seq = grant.seq;
  }
  return canonicalEncode({
    domain: 'ssf-door-grant:v1',
    roomId,
    doorId,
    grant: inner,
  });
}

/**
 * Bytes the room owner signs for a doorGrant TOMBSTONE. Distinct domain tag
 * (`ssf-door-grant-tombstone:v1`) so a grant signature can never authenticate
 * a tombstone (or vice versa), and the tombstone envelope always carries seq
 * (there is no legacy tombstone shape — tombstones are new in D3.2).
 */
export function doorGrantTombstoneSignatureBytes(
  roomId: string,
  doorId: string,
  tomb: Pick<DoorGrantTombstone, 'pub' | 'revokedAt' | 'seq'>,
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-door-grant-tombstone:v1',
    roomId,
    doorId,
    tombstone: {
      pub: tomb.pub,
      revokedAt: tomb.revokedAt,
      seq: tomb.seq,
    },
  });
}

/** Bytes the requester signs for a doorRequest record (self-signed). */
export function doorRequestSignatureBytes(
  roomId: string,
  doorId: string,
  req: Pick<DoorRightsRequest, 'requesterPub' | 'requesterName' | 'at'>,
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-door-request:v1',
    roomId,
    doorId,
    request: {
      requesterPub: req.requesterPub,
      requesterName: req.requesterName,
      at: req.at,
    },
  });
}

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * Signed-record validation for a policy. Returns true when the record either
 * carries a valid owner signature or is a LEGACY unsigned record (both sig
 * fields absent). A partially signed record (one field present, the other
 * absent) or a signed record whose signature fails verification is refused.
 *
 * `ownerPubExpected` is the room's current owner pub; when null (no verifier
 * wired, or the room's players map has not synced yet), signed records are
 * accepted on their carried `ownerPub` alone — the verifier still refuses
 * forgeries, and the fallback avoids bricking un-synced views. When the
 * expected pub IS known, signed records must claim it (a stale owner's
 * signature is stale, not authoritative).
 */
function isValidSignedPolicy(raw: Partial<DoorPolicyRecord>, doorId: string, ownerPubExpected: string | null): boolean {
  const hasPub = typeof raw.ownerPub === 'string' && raw.ownerPub.length > 0;
  const hasSig = typeof raw.ownerSig === 'string' && raw.ownerSig.length > 0;
  if (!hasPub && !hasSig) return true;                 // legacy — accept
  if (hasPub !== hasSig) return false;                 // partial — refuse
  if (!verifier) return true;                           // no verifier wired — accept (legacy posture)
  if (ownerPubExpected !== null && raw.ownerPub !== ownerPubExpected) return false;
  try {
    return verifier(
      raw.ownerPub as string,
      doorPolicySignatureBytes(boundRoomId, doorId, {
        passage: raw.passage === 'owner' ? 'owner' : 'public',
        oneWay: raw.oneWay === 'in' || raw.oneWay === 'out' ? raw.oneWay : undefined,
        construction: raw.construction === 'request' || raw.construction === 'public' ? raw.construction : 'owner',
        adapter: raw.adapter === true,
      }),
      raw.ownerSig as string,
    );
  } catch {
    return false;
  }
}

/**
 * Sanitized read; unknown/missing values fall back to the defaults. Signed
 * records that fail verification are treated as absent (defaults surface).
 */
export function readDoorPolicy(doorId: string): DoorPolicyRecord {
  if (!docAlive() || !isKnownDoorId(doorId)) return { ...DEFAULT_DOOR_POLICY };
  const raw = policyMap!.get(doorId) as Partial<DoorPolicyRecord> | undefined;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DOOR_POLICY };
  const ownerPubExpected = ownerPubReader?.() ?? null;
  if (!isValidSignedPolicy(raw, doorId, ownerPubExpected)) {
    return { ...DEFAULT_DOOR_POLICY };
  }
  return {
    passage: raw.passage === 'owner' ? 'owner' : 'public',
    ...(raw.oneWay === 'in' || raw.oneWay === 'out' ? { oneWay: raw.oneWay } : {}),
    construction: raw.construction === 'request' || raw.construction === 'public' ? raw.construction : 'owner',
    adapter: raw.adapter === true,
    ...(typeof raw.ownerPub === 'string' && raw.ownerPub ? { ownerPub: raw.ownerPub } : {}),
    ...(typeof raw.ownerSig === 'string' && raw.ownerSig ? { ownerSig: raw.ownerSig } : {}),
  };
}

/** True iff the last accepted read of `doorId` was a signed record. UI helper —
 *  not on the enforcement path. Falls back to false on unbound / unknown id. */
export function isDoorPolicySigned(doorId: string): boolean {
  const p = readDoorPolicy(doorId);
  return typeof p.ownerPub === 'string' && typeof p.ownerSig === 'string';
}

/**
 * Owner UI only (write-side gating is the caller's job — see module header).
 * When a signer is wired AND the local player is the current owner, the record
 * is signed on the way in and every peer verifies it on read. Otherwise the
 * record lands UNSIGNED (legacy shape) — no fallback bricks existing rooms.
 */
export function writeDoorPolicy(doorId: string, policy: DoorPolicyRecord): void {
  if (!docAlive() || !isKnownDoorId(doorId)) return;
  const base = {
    passage: policy.passage,
    ...(policy.oneWay === 'in' || policy.oneWay === 'out' ? { oneWay: policy.oneWay } : {}),
    construction: policy.construction,
    adapter: policy.adapter === true,
  };
  const signed = maybeSignPolicy(doorId, base);
  boundDoc!.transact(() => {
    policyMap!.set(doorId, signed);
  });
}

/** Attach ownerPub/ownerSig when the local session can produce them for the
 *  current room owner; otherwise return the unsigned record unchanged. */
function maybeSignPolicy(
  doorId: string,
  base: Pick<DoorPolicyRecord, 'passage' | 'oneWay' | 'construction' | 'adapter'>,
): DoorPolicyRecord {
  if (!ownerSigner || !localPubReader || !ownerPubReader) return base;
  const localPub = localPubReader();
  const ownerPub = ownerPubReader();
  if (!localPub || !ownerPub || localPub !== ownerPub) return base;
  let sig: string | null = null;
  try { sig = ownerSigner(doorPolicySignatureBytes(boundRoomId, doorId, base)); } catch { sig = null; }
  if (!sig) return base;
  return { ...base, ownerPub, ownerSig: sig };
}

/** Player-facing passage label (plain language, one string everywhere). */
export function passageLabel(policy: DoorPolicyRecord): string {
  if (policy.passage === 'owner') return 'OWNER';
  if (policy.oneWay === 'in') return 'PUBLIC · IN ONLY';
  if (policy.oneWay === 'out') return 'PUBLIC · OUT ONLY';
  return 'PUBLIC';
}

// ── Requests ─────────────────────────────────────────────────────────────────

function reqKey(doorId: string, pub: string): string {
  return `${doorId}|${pub}`;
}

/**
 * Reverse of `reqKey`: split a `${doorId}|${pub}` key back into its parts.
 * Base64url pubs never contain `|` and every doorId in use today (cardinal
 * berths + free-door `d:`-ids) is `|`-free, so a first-`|` split is unambiguous.
 * Returns null on any shape that could not have been produced by `reqKey`
 * (missing separator, empty doorId, empty pub) — callers treat that as a
 * silently-dropped hostile write.
 */
function parseReqKey(key: string): { doorId: string; pub: string } | null {
  if (typeof key !== 'string') return null;
  const i = key.indexOf('|');
  if (i <= 0 || i >= key.length - 1) return null;
  return { doorId: key.slice(0, i), pub: key.slice(i + 1) };
}

function isRequestShape(v: unknown): v is DoorRightsRequest {
  const r = v as Partial<DoorRightsRequest> | null;
  return !!r && typeof r.doorId === 'string' && typeof r.requesterPub === 'string'
    && !!r.requesterPub && typeof r.requesterName === 'string' && typeof r.at === 'number';
}

/**
 * True iff a request record either carries a valid self-signature or is
 * LEGACY (no sig). Mirrors the policy fallback rule so unsigned records keep
 * working during the transition, while a hostile peer cannot mint requests
 * naming another user's pub.
 *
 * `expectedDoorId` is the AUTHORITATIVE door id (the map-key's parsed doorId,
 * or the caller's argument in `hasDoorRequest`). Signature bytes are re-built
 * over `expectedDoorId`, so a request lifted UNMODIFIED to a foreign key
 * fails to verify (audit MAJOR #67): the original sig covered the original
 * door's bytes, not this slot's bytes.
 */
function isValidSignedRequest(v: DoorRightsRequest, expectedDoorId: string): boolean {
  const hasSig = typeof v.requesterSig === 'string' && v.requesterSig.length > 0;
  if (!hasSig) return true;
  if (!verifier) return true;
  try {
    return verifier(
      v.requesterPub,
      // Use expectedDoorId (map-key authoritative), NOT v.doorId — a lifted
      // record whose v.doorId still reads 'north' at map-key `south|<pub>`
      // must not verify against the original sig.
      doorRequestSignatureBytes(boundRoomId, expectedDoorId, v),
      v.requesterSig as string,
    );
  } catch {
    return false;
  }
}

/** A player asks for build rights at a door (their own client writes it). */
export function writeDoorRequest(doorId: string, pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  const at = Date.now();
  const body: DoorRightsRequest = {
    doorId,
    requesterPub: pub,
    requesterName: name || 'Unknown-Clone',
    at,
  };
  // Only self-sign when the LOCAL player owns the pub the request names —
  // signing another player's request is meaningless.
  if (selfSigner && localPubReader && localPubReader() === pub) {
    let sig: string | null = null;
    try { sig = selfSigner(doorRequestSignatureBytes(boundRoomId, doorId, body)); } catch { sig = null; }
    if (sig) body.requesterSig = sig;
  }
  boundDoc!.transact(() => {
    requestsMap!.set(reqKey(doorId, pub), body);
  });
}

export function removeDoorRequest(doorId: string, pub: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => { requestsMap!.delete(reqKey(doorId, pub)); });
}

/** All pending requests, optionally for one door (sanitized, newest first).
 *  Iterates over ENTRIES so the map key is the source of truth for both the
 *  doorId filter and the signature bytes — a record's carried doorId/pub
 *  MUST match its map key or it is dropped (map-key discipline, see header). */
export function readDoorRequests(doorId?: string): DoorRightsRequest[] {
  if (!docAlive()) return [];
  const out: DoorRightsRequest[] = [];
  for (const [key, v] of requestsMap!.entries()) {
    const parsed = parseReqKey(key);
    if (!parsed) continue;
    const { doorId: keyDoorId, pub: keyPub } = parsed;
    if (doorId && keyDoorId !== doorId) continue;
    if (!isRequestShape(v)) continue;
    // Map-key discipline: refuse any record whose carried doorId/pub does not
    // match the slot it lives at — defeats cross-door/cross-pub lift attacks
    // even for LEGACY unsigned records (which would otherwise bypass the sig
    // check entirely). See audit NOTE #67 (readDoorGrants duplicates).
    if (v.doorId !== keyDoorId || v.requesterPub !== keyPub) continue;
    if (!isValidSignedRequest(v, keyDoorId)) continue;
    out.push(v);
  }
  return out.sort((a, b) => b.at - a.at);
}

export function hasDoorRequest(doorId: string, pub: string): boolean {
  if (!docAlive()) return false;
  const v = requestsMap!.get(reqKey(doorId, pub));
  if (!isRequestShape(v)) return false;
  // Map-key discipline: a lifted record whose carried doorId/pub does not
  // match this slot is refused BEFORE verify runs (audit MAJOR #67).
  if (v.doorId !== doorId || v.requesterPub !== pub) return false;
  return isValidSignedRequest(v, doorId);
}

// ── Grants and Tombstones ────────────────────────────────────────────────────

function isGrantShape(v: unknown): v is DoorRightsGrant {
  const g = v as Partial<DoorRightsGrant> | null;
  if (!g || typeof g !== 'object') return false;
  // Discriminator: a tombstone carries `tombstone: true`. Refuse it here so
  // callers that specifically want a grant get a clean type-narrowed value.
  if ((g as { tombstone?: unknown }).tombstone === true) return false;
  return typeof g.doorId === 'string' && typeof g.pub === 'string' && !!g.pub
    && typeof g.name === 'string' && typeof g.grantedAt === 'number';
}

function isTombstoneShape(v: unknown): v is DoorGrantTombstone {
  const t = v as Partial<DoorGrantTombstone> | null;
  if (!t || typeof t !== 'object') return false;
  if (t.tombstone !== true) return false;
  return typeof t.doorId === 'string' && typeof t.pub === 'string' && !!t.pub
    && typeof t.revokedAt === 'number'
    // Tombstones REQUIRE a non-negative integer seq — no legacy shape exists.
    && typeof t.seq === 'number' && Number.isInteger(t.seq) && t.seq >= 0;
}

/**
 * Signed-grant validation — same shape as isValidSignedPolicy: legacy accepted,
 * signed requires the current-owner key to have signed. When the expected
 * owner pub is null (unreached room), signed grants are accepted on the
 * carried pub alone so a visitor's grant list is not blanked while sync
 * catches up.
 *
 * `expectedDoorId` is the AUTHORITATIVE door id (map-key parsed doorId, or
 * the caller's argument in `hasDoorGrant`). Signature bytes are re-built over
 * `expectedDoorId`, so a grant lifted UNMODIFIED to a foreign key fails to
 * verify — the original owner sig covered the ORIGINAL door's bytes, not
 * this slot's. Fixes audit MAJOR #67 (cross-door replay via has/read).
 *
 * D3.2: `seq` is inside the signed envelope. A record with `seq` uses the
 * seq-carrying byte shape; a record without `seq` uses the legacy byte shape
 * (see MIGRATION in the module header). If the record carries seq, it MUST
 * be a non-negative integer — a non-numeric or negative seq refuses so a
 * hostile peer cannot fabricate a "seq present but not counted" record.
 */
function isValidSignedGrant(v: DoorRightsGrant, expectedDoorId: string, ownerPubExpected: string | null): boolean {
  const hasPub = typeof v.ownerPub === 'string' && v.ownerPub.length > 0;
  const hasSig = typeof v.ownerSig === 'string' && v.ownerSig.length > 0;
  if (!hasPub && !hasSig) return true;
  if (hasPub !== hasSig) return false;
  if (!verifier) return true;
  if (ownerPubExpected !== null && v.ownerPub !== ownerPubExpected) return false;
  // If seq is present, it MUST be a non-negative integer. A non-numeric seq
  // would silently degrade to the legacy byte shape below, opening a
  // downgrade attack; refuse it up front.
  if (v.seq !== undefined && (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 0)) {
    return false;
  }
  try {
    return verifier(
      v.ownerPub as string,
      // Byte shape mirrors the record: seq present ⇒ include, absent ⇒
      // legacy shape. Both hostile downgrades (strip seq to force legacy
      // bytes; inject fake seq to force new bytes) break verify.
      doorGrantSignatureBytes(boundRoomId, expectedDoorId, v),
      v.ownerSig as string,
    );
  } catch {
    return false;
  }
}

/**
 * D3.2: validate a revocation tombstone. Owner-signed only — there is no
 * legacy tombstone shape (tombstones are new in D3.2). A partial record
 * (one sig field present, the other absent) is refused; a signed record
 * whose signature verifies against `doorGrantTombstoneSignatureBytes` is
 * accepted. When no verifier is wired (legacy binding), the tombstone is
 * accepted on shape alone — matches the legacy-binding posture used by
 * every other record kind.
 */
function isValidSignedTombstone(v: DoorGrantTombstone, expectedDoorId: string, ownerPubExpected: string | null): boolean {
  const hasPub = typeof v.ownerPub === 'string' && v.ownerPub.length > 0;
  const hasSig = typeof v.ownerSig === 'string' && v.ownerSig.length > 0;
  if (!hasPub && !hasSig) return true;             // legacy-binding posture
  if (hasPub !== hasSig) return false;             // partial — refuse
  if (!verifier) return true;                       // no verifier wired
  if (ownerPubExpected !== null && v.ownerPub !== ownerPubExpected) return false;
  try {
    return verifier(
      v.ownerPub as string,
      doorGrantTombstoneSignatureBytes(boundRoomId, expectedDoorId, v),
      v.ownerSig as string,
    );
  } catch {
    return false;
  }
}

/**
 * D3.2: observe the slot's current value and classify it as (a) a verified
 * grant, (b) a verified tombstone, or (c) invalid/absent. Returns an
 * observation carrying the record's (seq, isTombstone); the caller uses this
 * to bump the watermark and decide the outcome.
 *
 * Map-key discipline is enforced here for BOTH grants and tombstones: the
 * record's carried doorId/pub must match the slot it lives at.
 */
type SlotObservation =
  | { kind: 'grant'; seq: number; grant: DoorRightsGrant }
  | { kind: 'tombstone'; seq: number; tomb: DoorGrantTombstone }
  | null;

function observeGrantSlot(
  v: unknown,
  keyDoorId: string,
  keyPub: string,
  ownerPubExpected: string | null,
): SlotObservation {
  if (isTombstoneShape(v)) {
    if (v.doorId !== keyDoorId || v.pub !== keyPub) return null;
    if (!isValidSignedTombstone(v, keyDoorId, ownerPubExpected)) return null;
    return { kind: 'tombstone', seq: v.seq, tomb: v };
  }
  if (isGrantShape(v)) {
    if (v.doorId !== keyDoorId || v.pub !== keyPub) return null;
    if (!isValidSignedGrant(v, keyDoorId, ownerPubExpected)) return null;
    // Legacy record (no seq) is seq -1 for the greatest-sequence-wins rule;
    // any D3.2 record outranks it. See MIGRATION in the module header.
    const seq = typeof v.seq === 'number' ? v.seq : -1;
    return { kind: 'grant', seq, grant: v };
  }
  return null;
}

/**
 * D3.2: compute the seq for the NEXT owner-authored write at (doorId, pub).
 * Uses the max of the local watermark and the currently-observed valid
 * record's seq (so the next write outranks anything the current reader
 * would already have refused). A hostile peer cannot inflate our seq
 * through a fake record because `observeGrantSlot` verifies the signature
 * before returning a seq.
 */
function nextGrantSeqFor(doorId: string, pub: string, ownerPubExpected: string | null): number {
  const wm = watermarkOf(doorId, pub).seq;
  const cur = grantsMap!.get(reqKey(doorId, pub));
  const obs = observeGrantSlot(cur, doorId, pub, ownerPubExpected);
  const curSeq = obs ? obs.seq : -1;
  const base = Math.max(wm, curSeq, -1);
  return base + 1;
}

/** Owner ACCEPT: standing, revocable grant; clears the matching request.
 *  D3.2: computes a monotonic seq inside the signature bytes so the grant
 *  outranks any prior grant OR tombstone the reader has ever verified. */
export function writeDoorGrant(doorId: string, pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  const ownerPubExpected = ownerPubReader?.() ?? null;
  const canSign = !!ownerSigner && !!localPubReader && !!ownerPubReader;
  const seq = canSign ? nextGrantSeqFor(doorId, pub, ownerPubExpected) : undefined;
  const grantedAt = Date.now();
  const body: DoorRightsGrant = {
    doorId,
    pub,
    name: name || 'Unknown-Clone',
    grantedAt,
    ...(seq !== undefined ? { seq } : {}),
  };
  if (canSign) {
    const localPub = localPubReader!();
    const ownerPub = ownerPubReader!();
    if (localPub && ownerPub && localPub === ownerPub) {
      let sig: string | null = null;
      try { sig = ownerSigner!(doorGrantSignatureBytes(boundRoomId, doorId, body)); } catch { sig = null; }
      if (sig) { body.ownerPub = ownerPub; body.ownerSig = sig; }
    }
  }
  boundDoc!.transact(() => {
    grantsMap!.set(reqKey(doorId, pub), body);
    requestsMap!.delete(reqKey(doorId, pub));
  });
  // Bump watermark for the writer's OWN subsequent reads — the seq we just
  // wrote is now the highest we've observed for this slot. Legacy writes
  // (seq === undefined) do not bump the watermark; they read at seq -1.
  if (typeof seq === 'number') {
    bumpWatermark(doorId, pub, { seq, isTombstone: false });
  }
}

/**
 * Owner REVOKE (or DENY doubles as remove-request via removeDoorRequest).
 *
 * D3.2: revocation writes an OWNER-SIGNED TOMBSTONE record to the grants
 * map at the same slot as the grant it withdraws. NEVER a bare Yjs delete
 * (that shape was fail-DANGEROUS — dorkmo's replay repro on PR #129).
 *
 * Signed path (verifier + owner-signer wired AND local == owner): compute a
 * monotonic seq that outranks any prior grant or tombstone, sign the
 * tombstone envelope, write it at `${doorId}|${pub}`, and bump the local
 * watermark so subsequent reads (even after a hostile CRDT overwrite) refuse
 * lower-seq grant replays.
 *
 * Legacy-binding path (no verifier / no owner-signer wired): fall back to a
 * bare delete. Pre-D3 rooms had no signature layer to defeat and the
 * delete-then-replay attack is orthogonal to the D3.2 seq defence for those
 * rooms. Documented in the module header MIGRATION note.
 *
 * Non-owner call with a verifier wired: NO-OP. Writing an unsigned tombstone
 * from a non-owner session would let any peer revoke grants; better to
 * refuse the write cleanly than to plant a legacy-shape tombstone whose only
 * defence is the same signed-CRDT-op gap (C6) we already document.
 */
export function removeDoorGrant(doorId: string, pub: string): void {
  if (!docAlive()) return;
  const canSign = !!verifier && !!ownerSigner && !!localPubReader && !!ownerPubReader;
  if (!canSign) {
    // Legacy binding — no signing layer to protect; keep pre-D3 behavior.
    boundDoc!.transact(() => { grantsMap!.delete(reqKey(doorId, pub)); });
    return;
  }
  const localPub = localPubReader!();
  const ownerPub = ownerPubReader!();
  if (!localPub || !ownerPub || localPub !== ownerPub) {
    // Non-owner call in signed mode — refuse rather than plant an
    // authority-less tombstone. Owner-only UI already gates this call site
    // in docking.ts; a caller that reaches here is either buggy or hostile.
    return;
  }
  const ownerPubExpected = ownerPubReader!();
  const seq = nextGrantSeqFor(doorId, pub, ownerPubExpected);
  const revokedAt = Date.now();
  const tomb: DoorGrantTombstone = {
    tombstone: true,
    doorId,
    pub,
    revokedAt,
    seq,
  };
  let sig: string | null = null;
  try { sig = ownerSigner!(doorGrantTombstoneSignatureBytes(boundRoomId, doorId, tomb)); } catch { sig = null; }
  if (!sig) {
    // Signer failed. Do NOT fall back to a bare delete — that would leave
    // the slot empty and a replayed grant could be re-set to restore rights.
    // Do NOT write an unsigned tombstone either — verify-on-read would drop
    // it and the reader would treat the slot as absent. Refuse the revoke
    // and let the caller surface a UI error.
    return;
  }
  tomb.ownerPub = ownerPub;
  tomb.ownerSig = sig;
  boundDoc!.transact(() => {
    grantsMap!.set(reqKey(doorId, pub), tomb);
    // Requests are cleared on tombstone too, matching writeDoorGrant's
    // atomic clear — a revoked user's stale plea should not linger in the
    // owner's UI as a "still asking" row.
    requestsMap!.delete(reqKey(doorId, pub));
  });
  bumpWatermark(doorId, pub, { seq, isTombstone: true });
}

/** All grants, optionally for one door (sanitized, newest first).
 *  Iterates over ENTRIES so the map key is the source of truth for both the
 *  doorId filter and the signature bytes — a record's carried doorId/pub
 *  MUST match its map key or it is dropped (map-key discipline, see header).
 *  Fixes audit NOTE #67 (duplicates on multi-key copies) as a side-effect.
 *
 *  D3.2: tombstones are OBSERVED (watermark updated) but never surfaced as
 *  grants. A grant slot whose observation is defeated by the local watermark
 *  (a previously-verified higher-rank tombstone or grant) is dropped from
 *  the list. */
export function readDoorGrants(doorId?: string): DoorRightsGrant[] {
  if (!docAlive()) return [];
  const out: DoorRightsGrant[] = [];
  const ownerPubExpected = ownerPubReader?.() ?? null;
  for (const [key, v] of grantsMap!.entries()) {
    const parsed = parseReqKey(key);
    if (!parsed) continue;
    const { doorId: keyDoorId, pub: keyPub } = parsed;
    if (doorId && keyDoorId !== doorId) continue;
    const obs = observeGrantSlot(v, keyDoorId, keyPub, ownerPubExpected);
    if (!obs) continue;
    // Bump the watermark for EVERY verified observation, whether grant or
    // tombstone. This is what lets a later replayed lower-seq grant be
    // refused even after a hostile peer CRDT-overwrites the slot.
    bumpWatermark(keyDoorId, keyPub, { seq: obs.seq, isTombstone: obs.kind === 'tombstone' });
    if (obs.kind === 'tombstone') continue;
    // Refuse a grant that is defeated by the (now-updated) watermark. In
    // the fresh-observation case, bumpWatermark just set the watermark to
    // this observation's rank, so the outranks check is false and the
    // grant surfaces normally.
    const cur = watermarkOf(keyDoorId, keyPub);
    if (seqOutranks(cur, { seq: obs.seq, isTombstone: false })) continue;
    out.push(obs.grant);
  }
  return out.sort((a, b) => b.grantedAt - a.grantedAt);
}

export function hasDoorGrant(doorId: string, pub: string): boolean {
  if (!docAlive()) return false;
  const v = grantsMap!.get(reqKey(doorId, pub));
  const ownerPubExpected = ownerPubReader?.() ?? null;
  const obs = observeGrantSlot(v, doorId, pub, ownerPubExpected);
  if (!obs) return false;
  bumpWatermark(doorId, pub, { seq: obs.seq, isTombstone: obs.kind === 'tombstone' });
  if (obs.kind === 'tombstone') return false;
  // Grant observation must not be defeated by the watermark (which after the
  // bump above is at least as recent as this observation). If it IS defeated,
  // a hostile peer overwrote the slot with an older grant AFTER a tombstone
  // or higher-seq grant was previously observed — refuse.
  const cur = watermarkOf(doorId, pub);
  if (seqOutranks(cur, { seq: obs.seq, isTombstone: false })) return false;
  return true;
}
