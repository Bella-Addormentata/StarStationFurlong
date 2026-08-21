/**
 * 🚦 Per-door permissions + rights requests (#67 D1/D1b/D3)
 *
 * Three shared maps in the room doc (rebind per join, T0 seam, exactly the
 * doorsDoc pattern):
 *  - `doorPolicy`   : door id → { passage, construction } — the owner's rules.
 *  - `doorRequests` : `${doorId}|${pub}` → a player's plea for build rights.
 *  - `doorGrants`   : `${doorId}|${pub}` → a standing, revocable grant.
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
 * FAIL-SAFE FALLBACK (intentional, no migration): a record with NEITHER `sig`
 * NOR `pub` fields is treated as LEGACY and honored as today's shape-only read
 * — existing v1 stations keep working across the transition without a schema
 * bump. A record with only one of the two fields is malformed and refused.
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
 *   NOT PREVENTED (still gated by later slices):
 *    - A hostile peer OVERWRITING a valid signed record with garbage (Yjs map
 *      LWW rule). Verify-on-read drops the garbage and treats the slot as
 *      absent — so the door FALLS BACK TO DEFAULTS, not to the honest owner's
 *      last policy. Defence in depth here needs signed CRDT operations
 *      (durability C6) and is out of scope for D3.
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
 * `players.get(ownerId).keyB64` from the room doc as the verifying key. Until
 * the room's players map has synced, there is no key to check against and
 * signed reads refuse (see `readDoorPolicy`) — an unreached room shows door
 * defaults rather than junk, which is the safer failure mode.
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
  /** #67 D3: owner identity pubkey that signed this grant. */
  ownerPub?: string;
  /** #67 D3: owner signature over doorGrantSignatureBytes. */
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

/** Bytes the room owner signs for a doorGrant record. */
export function doorGrantSignatureBytes(
  roomId: string,
  doorId: string,
  grant: Pick<DoorRightsGrant, 'pub' | 'name' | 'grantedAt'>,
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-door-grant:v1',
    roomId,
    doorId,
    grant: {
      pub: grant.pub,
      name: grant.name,
      grantedAt: grant.grantedAt,
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
 */
function isValidSignedRequest(v: DoorRightsRequest): boolean {
  const hasSig = typeof v.requesterSig === 'string' && v.requesterSig.length > 0;
  if (!hasSig) return true;
  if (!verifier) return true;
  try {
    return verifier(
      v.requesterPub,
      doorRequestSignatureBytes(boundRoomId, v.doorId, v),
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

/** All pending requests, optionally for one door (sanitized, newest first). */
export function readDoorRequests(doorId?: string): DoorRightsRequest[] {
  if (!docAlive()) return [];
  const out: DoorRightsRequest[] = [];
  for (const v of requestsMap!.values()) {
    if (!isRequestShape(v)) continue;
    if (doorId && v.doorId !== doorId) continue;
    if (!isValidSignedRequest(v)) continue;
    out.push(v);
  }
  return out.sort((a, b) => b.at - a.at);
}

export function hasDoorRequest(doorId: string, pub: string): boolean {
  if (!docAlive()) return false;
  const v = requestsMap!.get(reqKey(doorId, pub));
  if (!isRequestShape(v)) return false;
  return isValidSignedRequest(v);
}

// ── Grants ───────────────────────────────────────────────────────────────────

function isGrantShape(v: unknown): v is DoorRightsGrant {
  const g = v as Partial<DoorRightsGrant> | null;
  return !!g && typeof g.doorId === 'string' && typeof g.pub === 'string' && !!g.pub
    && typeof g.name === 'string' && typeof g.grantedAt === 'number';
}

/**
 * Signed-grant validation — same shape as isValidSignedPolicy: legacy accepted,
 * signed requires the current-owner key to have signed. When the expected
 * owner pub is null (unreached room), signed grants are accepted on the
 * carried pub alone so a visitor's grant list is not blanked while sync
 * catches up.
 */
function isValidSignedGrant(v: DoorRightsGrant, ownerPubExpected: string | null): boolean {
  const hasPub = typeof v.ownerPub === 'string' && v.ownerPub.length > 0;
  const hasSig = typeof v.ownerSig === 'string' && v.ownerSig.length > 0;
  if (!hasPub && !hasSig) return true;
  if (hasPub !== hasSig) return false;
  if (!verifier) return true;
  if (ownerPubExpected !== null && v.ownerPub !== ownerPubExpected) return false;
  try {
    return verifier(
      v.ownerPub as string,
      doorGrantSignatureBytes(boundRoomId, v.doorId, v),
      v.ownerSig as string,
    );
  } catch {
    return false;
  }
}

/** Owner ACCEPT: standing, revocable grant; clears the matching request. */
export function writeDoorGrant(doorId: string, pub: string, name: string): void {
  if (!docAlive() || !pub) return;
  const grantedAt = Date.now();
  const body: DoorRightsGrant = {
    doorId,
    pub,
    name: name || 'Unknown-Clone',
    grantedAt,
  };
  if (ownerSigner && localPubReader && ownerPubReader) {
    const localPub = localPubReader();
    const ownerPub = ownerPubReader();
    if (localPub && ownerPub && localPub === ownerPub) {
      let sig: string | null = null;
      try { sig = ownerSigner(doorGrantSignatureBytes(boundRoomId, doorId, body)); } catch { sig = null; }
      if (sig) { body.ownerPub = ownerPub; body.ownerSig = sig; }
    }
  }
  boundDoc!.transact(() => {
    grantsMap!.set(reqKey(doorId, pub), body);
    requestsMap!.delete(reqKey(doorId, pub));
  });
}

/** Owner REVOKE (or DENY doubles as remove-request via removeDoorRequest). */
export function removeDoorGrant(doorId: string, pub: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => { grantsMap!.delete(reqKey(doorId, pub)); });
}

export function readDoorGrants(doorId?: string): DoorRightsGrant[] {
  if (!docAlive()) return [];
  const out: DoorRightsGrant[] = [];
  const ownerPubExpected = ownerPubReader?.() ?? null;
  for (const v of grantsMap!.values()) {
    if (!isGrantShape(v)) continue;
    if (doorId && v.doorId !== doorId) continue;
    if (!isValidSignedGrant(v, ownerPubExpected)) continue;
    out.push(v);
  }
  return out.sort((a, b) => b.grantedAt - a.grantedAt);
}

export function hasDoorGrant(doorId: string, pub: string): boolean {
  if (!docAlive()) return false;
  const v = grantsMap!.get(reqKey(doorId, pub));
  if (!isGrantShape(v)) return false;
  const ownerPubExpected = ownerPubReader?.() ?? null;
  return isValidSignedGrant(v, ownerPubExpected);
}
