/**
 * 🚪 Door-pairing sync (issue #64 + #67 D3 pairing extension)
 *
 * A room's DOCKED-MODULE door pairings live in a room-doc `doors` Y.Map, keyed by
 * door id ('north'|'south'|'east'|'west' or free-door `d:`-ids) → EITHER a
 * paired record OR an owner/guest-signed tombstone. A pairing is what makes a
 * module another user docked to a door VISIBLE + ENTERABLE for everyone else
 * in the room; before this doc existed, docking state was purely local
 * (DoorDockingPortSystem's private doorState) and every other user's door read
 * unpaired — no projection, and transit failed with "No room docked at this
 * port."
 *
 * Rebinds per join exactly like players / games / roomInfo / furniture (main.ts
 * T0 seam): bindDoorsDoc attaches to the FRESH doc and re-notifies subscribers,
 * and the previous doc's observers die with its doc.destroy() on leaveRoom.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * #67 D3 SIGNED PAIRING RECORDS (this pass — extension of the D3 discipline
 * already applied to doorPolicy / doorGrants / doorRequests / grant-tombstones).
 *
 * Two authorship modes ride on the same shared map:
 *
 *  1. OWNER-SIGNED — structural pairings (a module the room owner docked
 *     PERMANENTLY at their own door) and owner-authored tombstones (the
 *     PERMANENT undock at docking.ts's "undock-module" action). Signed with
 *     the local player's identity key when the local session IS the current
 *     room owner. Domain tags: `ssf-door-pairing:v1` for the paired shape,
 *     `ssf-door-tombstone:v1` for the tombstone shape.
 *  2. GUEST-SIGNED — TRANSIENT berths (a guest ship docked at an adapter port
 *     under the "anyone may berth" adapter policy) and their EITHER-SIDE
 *     detach tombstones. Signed with the LOCAL player's identity key (whoever
 *     is doing the write); the signer's pub rides INSIDE the record's
 *     `guestPub` field, and the signature bytes include `guestPub` so a
 *     hostile peer cannot swap the guest identity on a captured record.
 *     Domain tags: `ssf-door-pairing-guest:v1`, `ssf-door-tombstone-guest:v1`.
 *
 * READ RULE (mirrors doorPolicy.ts's fail-safe fallback):
 *  - A record with NEITHER owner nor guest signature fields is treated as
 *    LEGACY and honored as today's shape-only read — existing pre-D3 rooms
 *    keep working across the transition without a schema bump.
 *  - A record with only PART of an authorship pair (e.g. `ownerPub` set but
 *    `ownerSig` missing) is malformed and refused.
 *  - A record with an owner signature verifies against the current room owner
 *    pub (or its own carried `ownerPub` when the room's players map has not
 *    yet synced — the verifier still refuses forgeries, and the fail-open
 *    posture avoids blanking a joiner's neighbours during T0).
 *  - A record with a guest signature verifies against the carried `guestPub`.
 *    Guest-signed records MUST also carry `transient: true`; guests are only
 *    permitted to author transient berths (the adapter policy is the owner's
 *    consent to that write class), not structural pairings.
 *  - A record with BOTH signatures set is malformed and refused.
 *
 * SEQ + WATERMARK (mirrors D3.2 revoked-grant defence):
 *   Pairings and tombstones carry a MONOTONIC `seq` inside their signed
 *   envelope, per `(roomId, doorId)` slot (pairings are one-per-door, so the
 *   slot is the door — not `(doorId, pub)` like grants). Each reader keeps an
 *   IN-MEMORY watermark of the highest verified `(seq, isTombstone)` it has
 *   observed for each slot. Higher seq wins; a tombstone at seq S defeats any
 *   pairing at seq <= S (tombstone-tie-break on equal seq).
 *
 *   Why we need this even for pairings:
 *    - A guest berths (paired, seq 0, guest-signed by G).
 *    - Guest detaches (tombstone at seq 1, guest-signed by G).
 *    - A HOSTILE peer captures the paired record from step 1 before the
 *      detach and, after the detach, re-sets the map slot with the captured
 *      bytes. The signature still verifies (guest's key is unchanged).
 *    - Without a seq/watermark rule, that replay looks like a fresh berth
 *      and every reader draws the guest's ship back at the port.
 *    - With the rule, the reader's watermark sits at (seq 1, tombstone),
 *      and the replayed (seq 0, pairing) is refused before it can be
 *      surfaced OR bump the projection.
 *
 * WRITE RULE (owner-side and guest-side, both throw on signer failure):
 *  - `writeDoorPairing`: signs the record on the way in when a signer is wired
 *    AND the local session is authorized for the write class:
 *      • Non-transient pairing: sign as OWNER when local == room owner.
 *      • Transient pairing: sign as GUEST (using the local player's own key).
 *    If neither authorization path is available, the record lands UNSIGNED as
 *    a legacy fallback (documented residual — a hostile could equally have
 *    written the same shape, and the mirror-write path at main.ts also relies
 *    on this fallback for cross-room writes — see DOCUMENTED RESIDUALS below).
 *  - `writeDoorTombstone` (owner permanent undock): signs as OWNER when local
 *    == room owner. THROWS in signed binding when signing was required and
 *    failed (canonical-encode overflow at seq > MAX_SAFE_INTEGER, or the
 *    injected signer erroring / returning null). Fix pattern lifted from
 *    doorPolicy.ts's PR #129 BLOCKER-2 lesson: a silent unsigned write leaves
 *    the caller UI and every reader diverged, so we surface the failure.
 *  - `detachTransientBerth` (NEW — the transient DETACH path from docking.ts's
 *    "detach-berth" action): in signed binding, writes a signed tombstone
 *    (owner-signed if local == owner, guest-signed otherwise) at the slot the
 *    berth occupied — never a bare Yjs delete, since a bare delete leaves
 *    the map slot empty and any peer that retained the paired bytes could
 *    re-set them (the exact D3.2 attack shape, now applied to pairings).
 *    THROWS in signed binding on signer failure for the same reason as the
 *    grant-tombstone writer. In legacy binding, falls through to bare delete
 *    (pre-D3 rooms have no signature layer to defeat).
 *  - `deleteDoorPairing`: BARE DELETE always. Reserved for shapes where a
 *    tombstone offers no protection — the REJECTED-handshake path in world.ts
 *    (the pairing never landed) and the orphan-reap path in reapOrphanPairings
 *    (the door itself no longer exists, so re-setting the pairing points to a
 *    door that isn't there anyway).
 *
 * TRUST BOUNDARY (what the signatures do and don't prove — mirrors
 *                  doorPolicy.ts's TRUST BOUNDARY):
 *  PREVENTED:
 *   - A hostile peer forging a PERMANENT pairing under the room owner's
 *     authority (verify-on-read refuses; the owner's key did not sign it).
 *   - A hostile peer forging a TRANSIENT berth under someone else's guest
 *     identity (they cannot produce a signature under a key they don't hold,
 *     and swapping `guestPub` invalidates the signature).
 *   - Cross-room replay (roomId is inside every signature envelope) and
 *     cross-door replay (doorId is inside too — signature bytes are always
 *     rebuilt over the MAP KEY's doorId at verify time, so a valid signed
 *     record lifted UNMODIFIED to a foreign door refuses).
 *   - Detach-then-replay for peers that observed the tombstone. Once a
 *     reader has verified a `(seq S, tombstone)` at a door, no
 *     subsequently-observed pairing with seq <= S is accepted, even if a
 *     hostile peer CRDT-overwrites the slot with the replayed pairing bytes.
 *   - A hostile peer REVOKING a signed pairing via an UNSIGNED TOMBSTONE. In
 *     signed binding, tombstones with no signature fields are refused; they
 *     cannot bump reader watermarks and they cannot defeat the signed pairing
 *     they overwrote. Legacy binding still accepts unsigned tombstones as a
 *     shape (there is no signature layer to protect there anyway).
 *   - A hostile peer PLANTING an UNSIGNED PAIRING WITH A HUGE `seq` to
 *     inflate reader watermarks. Legacy pairings MUST have no seq field; a
 *     "legacy but with seq" record is malformed and refused up front. This
 *     mirrors doorPolicy.ts's PR #129 MAJOR fix on grant records.
 *   - A silent unsigned WRITE when the injected signer throws. `writeDoor…`
 *     and `detachTransientBerth` throw in signed binding rather than degrade
 *     to a shape our own reader would refuse — the caller (docking.ts / owner
 *     UI) is expected to surface the failure to the user.
 *   - A GUEST fabricating a PERMANENT pairing: guest-signed records MUST
 *     carry `transient: true` or verification refuses. A guest signature
 *     over a non-transient shape is treated as forgery.
 *   - A hostile peer TAMPERING WITH connector geometry (segments — flex
 *     `bendDeg`, ext `bays`, either `stretch`, and `skin` — plus the far-side
 *     lateral placement offset `farLateral`). The sig envelope covers them at
 *     fixed-point precision (deciDegrees for flex bend, millimeters for stretch
 *     AND for farLateral, exact integer for bays / skin). Any change big enough
 *     to see — a bay swap, a bend past the 0.1° quantization floor, a lateral
 *     shift past the 1 mm floor — invalidates the signature and the record
 *     fails verify. Sub-quantization tweaks slip through but are visually
 *     indistinguishable (0.1° at ~2.4 m gangway ≈ 4 mm arc, 1 mm on stretch and
 *     on lateral); this is the price of encoding fractional geometry through
 *     the safe-integer canonical CBOR profile.
 *  NOT PREVENTED (DOCUMENTED RESIDUALS):
 *   - A hostile peer OVERWRITING a valid signed record with garbage (Yjs map
 *     LWW rule). Verify-on-read drops the garbage and treats the slot as
 *     absent, so the door FALLS BACK TO UNPAIRED, not to the previous
 *     authoritative state. Defence in depth here needs signed CRDT ops
 *     (durability C6) and is out of scope for D3.
 *   - Detach-then-replay against a peer that NEVER OBSERVED the tombstone.
 *     `seq` NARROWS the replay window to peers whose in-memory watermark
 *     never saw the higher-seq revocation (fresh joiners after a hostile
 *     tombstone-delete, or a peer whose browser restarted and lost its
 *     watermark). Closing it fully requires signed CRDT ops (C6) or a
 *     chain-anchored tombstone log (chia-authority-architecture), both out
 *     of scope for D3.
 *   - The CROSS-ROOM MIRROR WRITE at main.ts's post-arrival lazy-mirror path
 *     writes into the ARRIVAL room's doc from a TRAVELER who is not the
 *     arrival-room owner (that write is what makes the return-walk direction
 *     exist for a pairing whose INITIATE could not know the far side; see
 *     main.ts comment near the write). The traveler cannot authoritatively
 *     sign for the arrival room, so the mirror record lands UNSIGNED and is
 *     accepted by the arrival room's peers via the legacy-fallback rule. A
 *     hostile could equally have written the same shape; the mirror provides
 *     no forgery resistance today. Any subsequent SIGNED write by the
 *     arrival-room owner (seq >= 0) supersedes the legacy mirror (seq -1),
 *     which is the migration path off the residual once mirrored pairings
 *     get their own attestation shape (a future slice — carrying the
 *     departure-room owner's signature into the arrival doc as evidence).
 *   - Legacy (unsigned) writes remain accepted, so a hostile peer that can
 *     also write to the doc can plant a legacy record. The dev-phase posture
 *     accepts this trade for zero-migration continuity; a future flag can
 *     flip fallback to strict once every writer signs and every mirrored
 *     pairing has a residual-closing story.
 *
 * MAP-KEY DISCIPLINE: every pairing/tombstone lives at a door-id key (one of
 * DOOR_IDS, an axis id, or a free `d:`-id — see `isAcceptableDoorKey`). The
 * map key is the authoritative doorId; signature bytes are re-built over the
 * KEY's doorId at verify time (not the record's carried field), so a valid
 * signed record COPIED to a foreign door fails verify. Free-door ids remain
 * bounded to `MAX_KEY_LEN`, and the total keyspace is bounded to
 * `MAX_PAIRINGS` (see the readAllDoors comment for the pre-record-era
 * DoS-fence discussion).
 *
 * REDONE 2026-08 (owner ruling: no backwards compatibility): the pre-#67
 * pairing shape was one struct doing two jobs — a live pairing AND a
 * tombstone smuggled in as `paired: false` with the retired address squatting
 * in `connectedRoomAddress`. Both jobs get their own arm now, and the
 * v0.30.x "legacy fields always written, never renamed" invariant (§3.5) is
 * deleted. The important addition (which #67 D3 preserves) is `farWall`. A
 * pairing used to describe the far side by DOOR ID alone, and an id says
 * nothing about where a door is — the old design got away with it because
 * cardinal names doubled as positions. They no longer do (a record can put
 * "east" on the west wall), and free `d:` doors never did. Everything that
 * needs the far door's orientation — the gray-box projection, the exterior
 * neighbour shells, atlas hop composition — reads the WALL from the record
 * instead of guessing it from the id, and an absent wall means "unknown",
 * not "north".
 */

import * as Y from 'yjs';
import {
  clampExtBays, clampFlexBendFine, clampFlexStretch, clampExtStretch, type ConnectorSegment,
} from './adapter';
import type { DoorWall } from './doorLayoutDoc';
import { normalizeWall } from './doorLayoutDoc';
import { canonicalEncode, type CanonicalValue } from './treasuryTypes';

/**
 * Serializable pairing record — one per door id. Plain JSON (no nested Y
 * types), a DISCRIMINATED UNION on `paired`.
 *
 * #67 D3 additions (all optional so pre-signed rooms keep working):
 *  - `seq`         : monotonic per (roomId, doorId); higher wins; tombstone
 *                    ties beat pairing ties. Absent ⇒ legacy (seq -1).
 *  - `ownerPub`/`ownerSig` : owner-signed non-transient pairings.
 *  - `guestPub`/`guestSig` : guest-signed transient berths (guestPub is inside
 *                    the signature bytes so a hostile peer cannot swap the
 *                    guest identity on a captured record).
 */
export interface DoorPairing {
  paired: true;
  /** Seed link of the room this door is docked to. */
  connectedRoomAddress: string;
  /** Ordered connector chain (flex joints + extensions). Absent ⇒ straight
   *  vestibule. Unknown segment kinds fail sanitize ⇒ straight. */
  segments?: ConnectorSegment[];
  /** The FAR room's door this connection lands on — any door, cardinal or
   *  free `d:`. */
  farDoor?: string;
  /** The WALL that far door sits on — what actually orients the far module.
   *  Written by the first walk-through's mirror (the traveler just departed
   *  through that door and knows), or from the atlas when the far room's
   *  geometry is already gossiped. Absent ⇒ orientation unknown. */
  farWall?: DoorWall;
  /** …and WHERE along that wall (the far door's along-wall centre). An
   *  off-centre far door shifts the whole far module sideways relative to the
   *  tube; without this every peer would draw it centred until they visited.
   *  Absent ⇒ assume centred. */
  farLateral?: number;
  /** Far room ring-orientation: 0 = square, 45 = diamond (octagon ring). */
  farYawDeg?: 0 | 45;
  /** #67 D2: TRANSIENT guest berth (docking-adapter pairing) — no chains, no
   *  station-graph permanence, either side may detach. */
  transient?: boolean;
  /** #67 D3: monotonic sequence within (roomId, doorId). Absent on LEGACY
   *  records (pre-signing) — treated as seq -1 by the read rule and always
   *  outranked by any seq-carrying record. See module header. */
  seq?: number;
  /** #67 D3: owner identity pubkey that signed this record (base64url Ed25519).
   *  Set on owner-signed writes; must equal the current room owner pub at
   *  verify time. */
  ownerPub?: string;
  /** #67 D3: owner signature over doorPairingSignatureBytes (base64url). */
  ownerSig?: string;
  /** #67 D3: guest identity pubkey that signed this record — set on
   *  guest-signed TRANSIENT berths. A guest-signed record MUST also carry
   *  `transient: true` (see isValidSignedPairing). */
  guestPub?: string;
  /** #67 D3: guest signature over doorPairingGuestSignatureBytes. */
  guestSig?: string;
}

/** ⏏ An UNDOCK leaves this rather than deleting the entry: only one room doc
 *  is bound at a time, so an undock can never reach the far room's mirror
 *  record — and the lazy mirror-write would read a plain delete as "never
 *  docked" and helpfully re-create the pairing on the next walk-through. The
 *  retired address lets it refuse exactly that module and no other.
 *
 *  #67 D3: tombstones are now signed too (owner-authored for a permanent
 *  undock via `writeDoorTombstone`; owner- or guest-authored for a transient
 *  detach via `detachTransientBerth`). Fields mirror DoorPairing's D3
 *  additions. */
export interface DoorTombstone {
  paired: false;
  retiredAddress: string;
  /** #67 D3: monotonic sequence within (roomId, doorId). See DoorPairing.seq. */
  seq?: number;
  ownerPub?: string;
  ownerSig?: string;
  guestPub?: string;
  guestSig?: string;
}

export type DoorRecord = DoorPairing | DoorTombstone;

const DOOR_IDS = ['north', 'south', 'east', 'west'] as const;

// ── D3 sign/verify seam ──────────────────────────────────────────────────────
//
// The verifier and signer are INJECTED, not imported, so this module stays
// encoding-agnostic (identical seam to doorPolicy.ts / treasuryDoc.ts). The
// browser wires keypair.ts's verifyIdentity + signIdentity; tests wire
// @noble/ed25519 directly with hex-encoded pubs and sigs.

/** (pub, bytes, sig) → boolean. Same shape as TreasurySigVerifier. */
export type DoorsSigVerifier = (pub: string, bytes: Uint8Array, sig: string) => boolean;
/** (bytes) → signature string. Returns null on any error so writes stay total. */
export type DoorsSigner = (bytes: Uint8Array) => string | null;

export interface DoorsBindOptions {
  /** roomId scope inside every signature — cross-room replay refuses without
   *  bumping the domain tag. */
  roomId?: string;
  verifySig?: DoorsSigVerifier;
  /** Live-read of the current room owner's identity pub, or null if not yet
   *  synced / no owner. */
  roomOwnerPub?: () => string | null;
  /** Live-read of the local player's identity pub (for guest-signed writes
   *  and for the owner-signing check). */
  localPub?: () => string | null;
  /** Signer used when the local session is the room owner. */
  signOwner?: DoorsSigner;
  /** Signer used for the local player's own guest-signed writes. */
  signSelf?: DoorsSigner;
}

let boundDoc: Y.Doc | null = null;
let doorsMap: Y.Map<unknown> | null = null;
let boundRoomId: string = '';
let verifier: DoorsSigVerifier | null = null;
let ownerPubReader: (() => string | null) | null = null;
let localPubReader: (() => string | null) | null = null;
let ownerSigner: DoorsSigner | null = null;
let selfSigner: DoorsSigner | null = null;
const listeners = new Set<() => void>();

// ── D3 in-memory watermark ──────────────────────────────────────────────────
//
// Per-slot record of the highest verified (seq, isTombstone) this reader has
// ever observed for `${roomId}|${doorId}`. Read updates bump it; writes bump
// it too so the writer's own subsequent reads reflect the new state without
// needing another observation cycle. Cleared when the bound doc changes
// (fresh join = fresh context) so tests and cross-room binds do not inherit
// stale watermarks.
//
// This is IN-MEMORY BY DESIGN — persisting it would require another layer
// hostile peers can attack (see module header, DOCUMENTED RESIDUALS). The
// caveat: a browser restart loses watermarks; a fresh join after a hostile
// tombstone-delete + replay accepts the replayed pairing. `seq` narrows the
// replay window, it does not close it.
type SeqObservation = { seq: number; isTombstone: boolean };
const pairingSeqWatermark = new Map<string, SeqObservation>();

function watermarkKey(roomId: string, doorId: string): string {
  return `${roomId}|${doorId}`;
}

function watermarkOf(doorId: string): SeqObservation {
  return pairingSeqWatermark.get(watermarkKey(boundRoomId, doorId))
    ?? { seq: -1, isTombstone: false };
}

/** True iff `a` strictly outranks `b` under greatest-sequence-wins with
 *  tombstone-beats-pairing on ties. Used both to compare a candidate record
 *  against the watermark and to decide whether to advance the watermark. */
function seqOutranks(a: SeqObservation, b: SeqObservation): boolean {
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.isTombstone && !b.isTombstone;
}

/** Bump the watermark for a door if the observation is strictly higher. */
function bumpWatermark(doorId: string, obs: SeqObservation): void {
  const cur = watermarkOf(doorId);
  if (seqOutranks(obs, cur)) {
    pairingSeqWatermark.set(watermarkKey(boundRoomId, doorId), obs);
  }
}

function notify(): void {
  // Copy: a listener may unsubscribe mid-notify. Isolate: this runs inside the
  // Yjs observe callback — one throwing reconcile must not kill the others.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[doors] listener threw during doc notify:', err);
    }
  }
}

export function bindDoorsDoc(doc: Y.Doc, opts: DoorsBindOptions = {}): void {
  // Clear watermarks whenever the bound doc changes (a fresh join is a fresh
  // context — a different room, or a rejoin after leave, cannot inherit the
  // prior doc's revocation observations). Rebinding the SAME doc preserves
  // watermarks (e.g. UI re-init, seam re-wire).
  if (boundDoc !== doc) {
    pairingSeqWatermark.clear();
  }
  boundDoc = doc;
  doorsMap = doc.getMap('doors');
  boundRoomId = typeof opts.roomId === 'string' ? opts.roomId : '';
  verifier = opts.verifySig ?? null;
  ownerPubReader = opts.roomOwnerPub ?? null;
  localPubReader = opts.localPub ?? null;
  ownerSigner = opts.signOwner ?? null;
  selfSigner = opts.signSelf ?? null;
  doorsMap.observe(() => notify());
  notify(); // reconcile from the fresh doc (mirror of bindFurnitureDoc)
}

export function subscribeDoors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the bound doc is usable (leaveRoom destroys the previous doc). */
function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    doorsMap !== null
  );
}

// ── Signature bytes (domain-tagged, canonical CBOR from treasuryTypes) ──────
//
// Four helpers, one per record kind × authorship. Every domain tag pins the
// room AND the door, so a signature valid in one context refuses to
// authenticate another; canonical encoding gives byte-for-byte equality across
// runtimes (treasuryTypes owns the profile and its Rust twin lives in
// ssf-p2p-node/src/treasury_codec.rs). Absent optional fields hash as explicit
// null so the encoder does not reject the value (canonicalEncode throws on
// `undefined`) and so field PRESENCE is what discriminates the byte shape.

type PairingSigInput = Pick<DoorPairing,
  'connectedRoomAddress' | 'segments' | 'farDoor' | 'farWall'
  | 'farLateral' | 'farYawDeg' | 'transient' | 'seq'>;
type TombstoneSigInput = Pick<DoorTombstone, 'retiredAddress' | 'seq'>;

/** Convert an optional value to `null` so canonicalEncode accepts it. */
function orNull<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

/** Serialize a ConnectorSegment as a plain JSON object canonicalEncode
 *  accepts — same field selection as `sanitizeDoorGeometry`, so the sig
 *  bytes cover only what the reader would render. Unknown kinds are dropped
 *  upstream by the sanitizer before they ever reach this encoder.
 *
 *  #67 D3 audit follow-up (round-4 BLOCKER on RING preset): canonicalEncode
 *  refuses non-safe-integer numbers (float 22.5, NaN, Infinity), so a raw
 *  `{ bendDeg: 22.5 }` — the shipped RING preset — threw on the way in,
 *  the throw was swallowed at the two production call sites (world.ts
 *  ACCEPTED handshake and main.ts cross-room mirror), and every signed RING
 *  pairing was silently poisoned. Fix: run the sanitize clamps in-line so
 *  hostile non-finite floats fold to the same safe value the reader would
 *  render, then quantize to a fixed-point integer (deciDeg for bend, mm for
 *  stretch — both well inside safe-integer range across the whole clamp
 *  window). Signer and verifier both encode through here, so byte-identical
 *  output is guaranteed for any raw input, hostile or clean. */
function segmentForSig(s: ConnectorSegment): { [k: string]: CanonicalValue } {
  if (s.kind === 'flex') {
    const bendDeg = clampFlexBendFine(
      typeof s.bendDeg === 'number' && Number.isFinite(s.bendDeg) ? s.bendDeg : 0,
    );
    const stretch = clampFlexStretch(
      typeof s.stretch === 'number' && Number.isFinite(s.stretch) ? s.stretch : 0,
    );
    return {
      kind: 'flex',
      // Deci-degrees: ±60° clamp × 10 ⇒ ±600, a safe integer everywhere.
      // Field-name suffix names the unit so a foreign reader (Rust twin, an
      // envelope inspector) cannot confuse fixed-point for the raw value.
      bendDeg10: Math.round(bendDeg * 10),
      // Millimeters: flex stretch clamp ±0.45 m × 1000 ⇒ ±450, safe integer.
      stretchMm: Math.round(stretch * 1000),
    };
  }
  const bays = clampExtBays(
    typeof s.bays === 'number' && Number.isFinite(s.bays) ? s.bays : 2,
  );
  const stretch = clampExtStretch(
    typeof s.stretch === 'number' && Number.isFinite(s.stretch) ? s.stretch : 0,
  );
  return {
    kind: 'ext',
    // clampExtBays already Math.rounds — integer within [2, 12], safe.
    bays,
    skin: s.skin === 'solid' ? 'solid' : 'ribbed',
    // Ext stretch clamp ±0.6 m × 1000 ⇒ ±600, safe integer. Same suffix
    // discipline as the flex arm — deliberate divergence from the raw field
    // name so a byte-encoding round-trip cannot silently reuse untyped data.
    stretchMm: Math.round(stretch * 1000),
  };
}

/** Segments array or explicit null so absent hashes distinctly from empty.
 *  Typed as CanonicalValue so the composed envelope type-checks. */
function segmentsForSig(segs: ConnectorSegment[] | undefined): CanonicalValue {
  if (!segs || segs.length === 0) return null;
  return segs.map(segmentForSig);
}

/** farLateral (metres) quantized to a fixed-point MILLIMETRE integer for the
 *  signature bytes — same discipline as segmentForSig's bendDeg10/stretchMm,
 *  and for the same reason. canonicalEncode refuses non-safe-integer numbers,
 *  yet sanitizeDoorGeometry admits ANY finite |farLateral| ≤ 32 m (fractional
 *  included), and isValidSignedPairing accepts a keyless LEGACY record — so a
 *  hostile peer needs no signing key to plant `{ paired:true, …, farLateral:1.5 }`.
 *  That raw fractional value survives the sanitized read, hydrates into docking
 *  state, and throws on the owner's NEXT ACCEPTED-handshake re-sign — caught and
 *  console.error'd, silently dropping the pairing from the UI. It is the exact
 *  griefable owner-write DoS the round-4 segment fix closed, left open on this
 *  one lane (and a future honest hazard too — the continuous-space adapter
 *  solver can emit a fractional lateral with no attacker). |32 m|×1000 ⇒ |32000|,
 *  a safe integer everywhere; the sanitizer's own ±32 clamp is idempotent; a
 *  non-finite / non-number folds to null (= absent) so signer and verifier emit
 *  byte-identical envelopes for any stored value, hostile or clean. The `Mm`
 *  suffix names the unit so a foreign reader (Rust twin, envelope inspector)
 *  cannot mistake fixed-point for the raw metre value — same as the segment
 *  arms. */
function farLateralForSig(p: PairingSigInput): CanonicalValue {
  return typeof p.farLateral === 'number' && Number.isFinite(p.farLateral)
    ? Math.round(Math.max(-32, Math.min(32, p.farLateral)) * 1000)
    : null;
}

/** Bytes the room owner signs for a non-transient DoorPairing record.
 *  transient is EXCLUDED from the payload here — the domain tag itself
 *  encodes "non-transient". A hostile peer that adds `transient:true` to a
 *  captured owner-signed record cannot upgrade it into a guest-signed berth
 *  because verify rebuilds the bytes without the transient field. */
export function doorPairingSignatureBytes(
  roomId: string,
  doorId: string,
  p: PairingSigInput,
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-door-pairing:v1',
    roomId,
    doorId,
    pairing: {
      connectedRoomAddress: p.connectedRoomAddress,
      segments: segmentsForSig(p.segments),
      farDoor: orNull(p.farDoor),
      farWall: orNull(p.farWall),
      farLateralMm: farLateralForSig(p),
      farYawDeg: orNull(p.farYawDeg),
      seq: orNull(p.seq),
    },
  });
}

/** Bytes the GUEST signs for a TRANSIENT DoorPairing record. `guestPub`
 *  rides INSIDE the envelope so a hostile peer that captures a valid
 *  guest-signed record cannot swap `guestPub` to their own key — the
 *  signature bytes would no longer match. The domain tag encodes "transient",
 *  same reasoning as the owner variant. */
export function doorPairingGuestSignatureBytes(
  roomId: string,
  doorId: string,
  p: PairingSigInput & { guestPub: string },
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-door-pairing-guest:v1',
    roomId,
    doorId,
    pairing: {
      connectedRoomAddress: p.connectedRoomAddress,
      guestPub: p.guestPub,
      segments: segmentsForSig(p.segments),
      farDoor: orNull(p.farDoor),
      farWall: orNull(p.farWall),
      farLateralMm: farLateralForSig(p),
      farYawDeg: orNull(p.farYawDeg),
      seq: orNull(p.seq),
    },
  });
}

/** Bytes the room owner signs for a DoorTombstone record — the PERMANENT
 *  undock and the owner-authored transient DETACH share this shape. */
export function doorTombstoneSignatureBytes(
  roomId: string,
  doorId: string,
  t: TombstoneSigInput,
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-door-tombstone:v1',
    roomId,
    doorId,
    tombstone: {
      retiredAddress: t.retiredAddress,
      seq: orNull(t.seq),
    },
  });
}

/** Bytes the GUEST signs for a TRANSIENT DETACH tombstone. `guestPub`
 *  inside the envelope, same discipline as doorPairingGuestSignatureBytes. */
export function doorTombstoneGuestSignatureBytes(
  roomId: string,
  doorId: string,
  t: TombstoneSigInput & { guestPub: string },
): Uint8Array {
  return canonicalEncode({
    domain: 'ssf-door-tombstone-guest:v1',
    roomId,
    doorId,
    tombstone: {
      retiredAddress: t.retiredAddress,
      guestPub: t.guestPub,
      seq: orNull(t.seq),
    },
  });
}

// ── Shape guards ────────────────────────────────────────────────────────────

/** Basic shape guard (doc reads cross a trust boundary — see module header). */
export function isDoorRecord(value: unknown): value is DoorRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as { paired?: unknown; connectedRoomAddress?: unknown; retiredAddress?: unknown };
  if (r.paired === true) return typeof r.connectedRoomAddress === 'string';
  if (r.paired === false) return typeof r.retiredAddress === 'string';
  return false;
}

/** Refuse a record whose `seq` field is present-but-bogus (non-numeric,
 *  fractional, negative, or unsafe integer). We use `Number.isSafeInteger`
 *  (not `Number.isInteger`) so a hostile value at MAX_SAFE_INTEGER+1 (a
 *  double that is representable but not a safe integer) is refused up front;
 *  canonicalEncode would reject the same value when rebuilding verify bytes,
 *  so accepting it here would only defer the failure. */
function hasValidSeqIfPresent(seq: unknown): boolean {
  if (seq === undefined) return true;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0;
}

// ── Verify helpers ──────────────────────────────────────────────────────────

/**
 * Owner-side verification for a pairing. Rebuilds signature bytes over the
 * MAP KEY's doorId (map-key discipline — a lifted record whose carried
 * doorId no longer matches its slot cannot re-verify against the original
 * sig). Refuses partial sig fields (one set, the other missing).
 */
function verifyOwnerPairing(
  p: DoorPairing,
  keyDoorId: string,
  ownerPubExpected: string | null,
): boolean {
  const hasPub = typeof p.ownerPub === 'string' && p.ownerPub.length > 0;
  const hasSig = typeof p.ownerSig === 'string' && p.ownerSig.length > 0;
  if (hasPub !== hasSig) return false;
  if (!hasPub) return false; // caller checks legacy separately
  if (!verifier) return true; // no verifier wired — accept (legacy posture)
  if (ownerPubExpected !== null && p.ownerPub !== ownerPubExpected) return false;
  if (!hasValidSeqIfPresent(p.seq)) return false;
  try {
    return verifier(
      p.ownerPub as string,
      doorPairingSignatureBytes(boundRoomId, keyDoorId, p),
      p.ownerSig as string,
    );
  } catch {
    return false;
  }
}

/**
 * Guest-side verification for a pairing. Guest-signed pairings MUST carry
 * `transient: true` — guests are only permitted to author transient berths
 * (the adapter policy is the owner's consent to that write class). A guest
 * signature over a non-transient shape is treated as forgery.
 */
function verifyGuestPairing(p: DoorPairing, keyDoorId: string): boolean {
  const hasPub = typeof p.guestPub === 'string' && p.guestPub.length > 0;
  const hasSig = typeof p.guestSig === 'string' && p.guestSig.length > 0;
  if (hasPub !== hasSig) return false;
  if (!hasPub) return false;
  if (p.transient !== true) return false; // guests may only sign transient
  if (!verifier) return true;
  if (!hasValidSeqIfPresent(p.seq)) return false;
  try {
    return verifier(
      p.guestPub as string,
      doorPairingGuestSignatureBytes(boundRoomId, keyDoorId, {
        ...p,
        guestPub: p.guestPub as string,
      }),
      p.guestSig as string,
    );
  } catch {
    return false;
  }
}

/**
 * Owner-side verification for a tombstone. Mirrors verifyOwnerPairing.
 */
function verifyOwnerTombstone(
  t: DoorTombstone,
  keyDoorId: string,
  ownerPubExpected: string | null,
): boolean {
  const hasPub = typeof t.ownerPub === 'string' && t.ownerPub.length > 0;
  const hasSig = typeof t.ownerSig === 'string' && t.ownerSig.length > 0;
  if (hasPub !== hasSig) return false;
  if (!hasPub) return false;
  if (!verifier) return true;
  if (ownerPubExpected !== null && t.ownerPub !== ownerPubExpected) return false;
  if (!hasValidSeqIfPresent(t.seq)) return false;
  try {
    return verifier(
      t.ownerPub as string,
      doorTombstoneSignatureBytes(boundRoomId, keyDoorId, t),
      t.ownerSig as string,
    );
  } catch {
    return false;
  }
}

/** Guest-side verification for a tombstone. Guest-signed tombstones close the
 *  transient DETACH path — either side may cast off, so a guest-signed
 *  tombstone is authoritative on its own slot. */
function verifyGuestTombstone(t: DoorTombstone, keyDoorId: string): boolean {
  const hasPub = typeof t.guestPub === 'string' && t.guestPub.length > 0;
  const hasSig = typeof t.guestSig === 'string' && t.guestSig.length > 0;
  if (hasPub !== hasSig) return false;
  if (!hasPub) return false;
  if (!verifier) return true;
  if (!hasValidSeqIfPresent(t.seq)) return false;
  try {
    return verifier(
      t.guestPub as string,
      doorTombstoneGuestSignatureBytes(boundRoomId, keyDoorId, {
        ...t,
        guestPub: t.guestPub as string,
      }),
      t.guestSig as string,
    );
  } catch {
    return false;
  }
}

/**
 * D3: validate a pairing record. Returns true on legacy (no sig fields) OR
 * on a valid owner-signed OR valid guest-signed record. A record with BOTH
 * owner and guest sig fields is malformed (two authorities on one record) and
 * refused. Partial signatures (one field of a pair present) are also refused.
 * Legacy pairings MUST have no `seq` field — a "no sig but seq present"
 * record is hostile (see PR #129 MAJOR pattern in doorPolicy.ts).
 */
function isValidSignedPairing(p: DoorPairing, keyDoorId: string, ownerPubExpected: string | null): boolean {
  const hasOwnerPub = typeof p.ownerPub === 'string' && p.ownerPub.length > 0;
  const hasOwnerSig = typeof p.ownerSig === 'string' && p.ownerSig.length > 0;
  const hasGuestPub = typeof p.guestPub === 'string' && p.guestPub.length > 0;
  const hasGuestSig = typeof p.guestSig === 'string' && p.guestSig.length > 0;
  const hasOwner = hasOwnerPub || hasOwnerSig;
  const hasGuest = hasGuestPub || hasGuestSig;
  if (hasOwner && hasGuest) return false;                 // two authorities — malformed
  if (!hasOwner && !hasGuest) {
    // LEGACY pairing: MUST have NO seq field. See the same rationale on
    // doorPolicy.ts isValidSignedGrant — a hostile "legacy with seq" record
    // would inflate reader watermarks and force honest owner writes into
    // artificially high seq territory (or past MAX_SAFE_INTEGER).
    if (p.seq !== undefined) return false;
    return true;
  }
  if (hasOwner) return verifyOwnerPairing(p, keyDoorId, ownerPubExpected);
  return verifyGuestPairing(p, keyDoorId);
}

/**
 * D3: validate a tombstone. Signed binding refuses unsigned tombstones (BLOCKER-1
 * lesson from PR #129: pre-fix the legacy fallback let any peer plant an
 * unsigned tombstone and blank a signed pairing). Legacy binding accepts
 * unsigned tombstones (no signature layer to protect, same posture as legacy
 * pairings). A record with BOTH owner and guest sig fields is refused.
 */
function isValidSignedTombstone(t: DoorTombstone, keyDoorId: string, ownerPubExpected: string | null): boolean {
  const hasOwnerPub = typeof t.ownerPub === 'string' && t.ownerPub.length > 0;
  const hasOwnerSig = typeof t.ownerSig === 'string' && t.ownerSig.length > 0;
  const hasGuestPub = typeof t.guestPub === 'string' && t.guestPub.length > 0;
  const hasGuestSig = typeof t.guestSig === 'string' && t.guestSig.length > 0;
  const hasOwner = hasOwnerPub || hasOwnerSig;
  const hasGuest = hasGuestPub || hasGuestSig;
  if (hasOwner && hasGuest) return false;
  if (!hasOwner && !hasGuest) {
    // Legacy binding accepts unsigned tombstone (as pre-#67 D3). Signed
    // binding refuses so a hostile cannot plant an unsigned tombstone to
    // revoke a signed pairing — BLOCKER-1 pattern from PR #129.
    if (t.seq !== undefined) return false; // legacy with seq is hostile
    return !verifier;
  }
  if (hasOwner) return verifyOwnerTombstone(t, keyDoorId, ownerPubExpected);
  return verifyGuestTombstone(t, keyDoorId);
}

/** Slot observation used by the greatest-sequence-wins read rule. */
type SlotObservation =
  | { kind: 'pairing'; seq: number; pairing: DoorPairing }
  | { kind: 'tombstone'; seq: number; tomb: DoorTombstone }
  | null;

function observeDoorSlot(
  v: unknown,
  keyDoorId: string,
  ownerPubExpected: string | null,
): SlotObservation {
  if (!isDoorRecord(v)) return null;
  if (v.paired === false) {
    if (!isValidSignedTombstone(v, keyDoorId, ownerPubExpected)) return null;
    const seq = typeof v.seq === 'number' ? v.seq : -1;
    return { kind: 'tombstone', seq, tomb: v };
  }
  if (!isValidSignedPairing(v, keyDoorId, ownerPubExpected)) return null;
  const seq = typeof v.seq === 'number' ? v.seq : -1;
  return { kind: 'pairing', seq, pairing: v };
}

/**
 * D3: compute the seq for the NEXT write at (roomId, doorId). Uses the max
 * of the local watermark and the currently-observed valid record's seq (so
 * the next write outranks anything the current reader would already have
 * refused). A hostile peer cannot inflate our seq through a fake record
 * because observeDoorSlot verifies the signature before returning a seq.
 */
function nextPairingSeqFor(doorId: string, ownerPubExpected: string | null): number {
  const wm = watermarkOf(doorId).seq;
  const cur = doorsMap!.get(doorId);
  const obs = observeDoorSlot(cur, doorId, ownerPubExpected);
  const curSeq = obs ? obs.seq : -1;
  const base = Math.max(wm, curSeq, -1);
  return base + 1;
}

// ── Read side ───────────────────────────────────────────────────────────────

/** #62 P2 geometry sanitizer: peer-written geometry is UNTRUSTED — every
 *  segment param is clamped to the parts catalog, an unknown segment kind or
 *  malformed list drops the WHOLE chain (⇒ legacy straight-gangway render,
 *  never a crash, identical on every client), and farDoor/farYawDeg must be
 *  exact enum values or they vanish.
 *
 *  #67 D3: sanitize runs AFTER verify (see readAllDoors). Sig fields (already
 *  verified) are preserved onto the sanitized record so downstream UIs can
 *  show "signed by owner" / "signed by guest" chips without a second lookup. */
function sanitizeDoorGeometry(r: DoorRecord): DoorRecord {
  // Tombstones carry no geometry — pass through as-is (the guard already
  // proved the shape). Preserve sig fields so authorship stays visible.
  if (!r.paired) {
    const out: DoorTombstone = { paired: false, retiredAddress: r.retiredAddress };
    if (typeof r.seq === 'number') out.seq = r.seq;
    if (r.ownerPub) out.ownerPub = r.ownerPub;
    if (r.ownerSig) out.ownerSig = r.ownerSig;
    if (r.guestPub) out.guestPub = r.guestPub;
    if (r.guestSig) out.guestSig = r.guestSig;
    return out;
  }
  const out: DoorPairing = { paired: true, connectedRoomAddress: r.connectedRoomAddress };
  if (Array.isArray(r.segments) && r.segments.length > 0 && r.segments.length <= 8) {
    const clean: ConnectorSegment[] = [];
    let ok = true;
    for (const s of r.segments) {
      if (!s || typeof s !== 'object') { ok = false; break; }
      if (s.kind === 'flex') {
        clean.push({
          kind: 'flex',
          // 🛬 FINE clamp (range only, no detent snap): solved jetbridge
          // bends (e.g. 40.1°) survive the wire and render as solved.
          bendDeg: clampFlexBendFine(typeof s.bendDeg === 'number' && Number.isFinite(s.bendDeg) ? s.bendDeg : 0),
          stretch: clampFlexStretch(typeof s.stretch === 'number' && Number.isFinite(s.stretch) ? s.stretch : 0),
        });
      } else if (s.kind === 'ext') {
        clean.push({
          kind: 'ext',
          bays: clampExtBays(typeof s.bays === 'number' && Number.isFinite(s.bays) ? s.bays : 2),
          skin: s.skin === 'solid' ? 'solid' : 'ribbed',
          // 🛬 Telescoping delta (additive; legacy readers ignore → rigid).
          stretch: clampExtStretch(typeof s.stretch === 'number' && Number.isFinite(s.stretch) ? s.stretch : 0),
        });
      } else {
        ok = false; // unknown kind (newer client) — fall back to legacy render
        break;
      }
    }
    if (ok) out.segments = clean;
  }
  // 🚪 Bounded, not enumerated: same shape rule as a pairing KEY, so a peer
  // cannot smuggle an arbitrary string into the pose and arrival paths.
  // Every consumer degrades safely on a miss anyway — findDoor returns null
  // and the adapter falls back to the departure heading.
  if (typeof r.farDoor === 'string' && isAcceptableDoorKey(r.farDoor)) {
    out.farDoor = r.farDoor;
  }
  // farWall drives the far module's ROTATION straight into the renderer and
  // arrives from a peer — a real wall in either vocabulary (normalizeWall maps
  // legacy compass values) or it vanishes ("unknown"), which every consumer
  // renders as no rotation rather than a guess. This list was compass-only
  // after the axis rename, so every farWall written since was being STRIPPED.
  const fw = normalizeWall(r.farWall);
  if (fw) out.farWall = fw;
  // Same discipline as farWall: geometry from a peer, bounded or dropped.
  // ±32 comfortably covers the largest room's wall run (5 tiles = ±15).
  if (typeof r.farLateral === 'number' && Number.isFinite(r.farLateral)
      && Math.abs(r.farLateral) <= 32) {
    out.farLateral = r.farLateral;
  }
  if (r.farYawDeg === 0 || r.farYawDeg === 45) out.farYawDeg = r.farYawDeg;
  if (r.transient === true) out.transient = true;
  // D3: preserve verified sig fields for downstream visibility.
  if (typeof r.seq === 'number') out.seq = r.seq;
  if (r.ownerPub) out.ownerPub = r.ownerPub;
  if (r.ownerSig) out.ownerSig = r.ownerSig;
  if (r.guestPub) out.guestPub = r.guestPub;
  if (r.guestSig) out.guestSig = r.guestSig;
  return out;
}

/** A door id we will accept as a pairing key: one of the four structural
 *  berths, or an editor-minted free door. Deliberately an id-SHAPE test and
 *  NOT `hasDoorLayout(id)` — bindDoorsDoc runs notify() synchronously and
 *  main.ts binds it BEFORE bindDoorLayoutDoc, so a cross-doc lookup here is
 *  false on every join and would silently drop every free-door pairing, with
 *  no recovery (reconcileDoorLayout never re-runs reconcileDoors). */
function isAcceptableDoorKey(id: string): boolean {
  if (id.length > MAX_KEY_LEN) return false;
  return (
    (DOOR_IDS as readonly string[]).includes(id) ||
    // 🧭 Axis-label ids: seedDoorLayoutSingle names a module's birth door
    // after its wall, which the axis rename turned into 'x-'/'y+'… — and this
    // filter, still speaking only legacy names and d:, silently DROPPED every
    // pairing keyed by one. The write-only black hole came back for exactly
    // the newest doors: walk into a fresh module and the mirror written for
    // the way home was unreadable — "There is no module connected" (owner
    // report, 2026-08-10). Ids are opaque names; all three shapes are legal.
    (AXIS_IDS as readonly string[]).includes(id) ||
    id.startsWith('d:')
  );
}

const AXIS_IDS = ['x+', 'x-', 'y+', 'y-'] as const;

/** Bounds replacing the DoS fence the fixed four-id loop gave us for free:
 *  before, whatever a peer wrote we read exactly four entries. Mirrors the
 *  station atlas's MAX_ENTRIES discipline. */
const MAX_KEY_LEN = 64;
const MAX_PAIRINGS = 64;

/**
 * Snapshot every valid door pairing as id → SANITIZED record (malformed
 * entries are skipped, not fatal). #67 D3: signed records verify against the
 * MAP KEY's doorId (map-key discipline) before sanitize runs; the watermark
 * is bumped for every verified observation so a later replayed lower-seq
 * record is refused even if a hostile peer CRDT-overwrites the slot.
 *
 * 🚪 This loop WAS the four-door keyspace. Nothing on the wire ever constrained
 * it — `doors` is a plain string-keyed Y.Map and writeDoorPairing /
 * deleteDoorPairing / writeDoorTombstone all take `doorId: string` unvalidated
 * — so a free door's pairing was already being written and gossiped, and read
 * by nobody, including its own author after a rejoin. A silent write-only black
 * hole rather than a throw, which is why nothing ever surfaced it. Iterating
 * the map is what makes a free door dockable; every cardinal-ism downstream
 * (reconcileDoors, the arrival mirror, the atlas harvest) reads through here.
 */
export function readAllDoors(): Map<string, DoorRecord> {
  const out = new Map<string, DoorRecord>();
  if (!docAlive()) return out;
  const ownerPubExpected = ownerPubReader?.() ?? null;
  for (const [id, value] of doorsMap!.entries()) {
    if (out.size >= MAX_PAIRINGS) break;
    if (!isAcceptableDoorKey(id)) continue;
    const obs = observeDoorSlot(value, id, ownerPubExpected);
    if (!obs) continue;
    // Bump watermark for EVERY verified observation, whether pairing or
    // tombstone. This is what lets a later replayed lower-seq record be
    // refused even after a hostile peer CRDT-overwrites the slot.
    bumpWatermark(id, { seq: obs.seq, isTombstone: obs.kind === 'tombstone' });
    // Refuse a record that is defeated by the (now-updated) watermark. In
    // the fresh-observation case, bumpWatermark just set the watermark to
    // this observation's rank, so the outranks check is false and the record
    // surfaces normally.
    const cur = watermarkOf(id);
    if (seqOutranks(cur, { seq: obs.seq, isTombstone: obs.kind === 'tombstone' })) {
      continue;
    }
    out.set(id, sanitizeDoorGeometry(obs.kind === 'pairing' ? obs.pairing : obs.tomb));
  }
  return out;
}

// ── Optional geometry input for writeDoorPairing ────────────────────────────

/** Optional connection geometry a publisher attaches to a pairing (#62 P2). */
export interface DoorGeometry {
  segments?: ConnectorSegment[];
  farDoor?: DoorPairing['farDoor'];
  farWall?: DoorPairing['farWall'];
  farLateral?: DoorPairing['farLateral'];
  farYawDeg?: DoorPairing['farYawDeg'];
  transient?: boolean;
}

// ── Write side ──────────────────────────────────────────────────────────────

/** Compose a base DoorPairing (no sig fields yet) from the caller's inputs. */
function composePairing(address: string, geometry: DoorGeometry | undefined): DoorPairing {
  const record: DoorPairing = { paired: true, connectedRoomAddress: address };
  if (geometry?.segments && geometry.segments.length > 0) record.segments = geometry.segments;
  if (geometry?.farDoor) record.farDoor = geometry.farDoor;
  if (geometry?.farWall) record.farWall = geometry.farWall;
  if (geometry?.farLateral !== undefined) record.farLateral = geometry.farLateral;
  if (geometry?.farYawDeg !== undefined) record.farYawDeg = geometry.farYawDeg;
  if (geometry?.transient === true) record.transient = true;
  return record;
}

/**
 * Publish one door's pairing (whoever docked a module); geometry rides along
 * when the connection was assembled from parts or the far side is known.
 *
 * #67 D3 signing decision:
 *   - non-transient AND local session == room owner   ⇒ sign as OWNER
 *   - transient AND signer available                  ⇒ sign as GUEST (self-sign)
 *   - otherwise                                        ⇒ LEGACY unsigned write
 *
 * THROWS in signed binding when signing was required (a signer path was
 * chosen) and failed (canonical-encode overflow, or the injected signer
 * erroring / returning null). See doorPolicy.ts's writeDoorGrant BLOCKER-2
 * lesson: a silent unsigned+seq record is refused by our own reader, so
 * failing loud lets the caller (world.ts / docking UI) surface the failure.
 */
export function writeDoorPairing(doorId: string, address: string, geometry?: DoorGeometry): void {
  if (!docAlive()) return;
  const record = composePairing(address, geometry);
  const canSignAny = !!verifier && !!localPubReader;
  if (!canSignAny) {
    // Legacy binding — pre-D3 posture. No seq, no signature; a signed peer
    // that reads this record accepts it as fail-safe fallback.
    boundDoc!.transact(() => {
      doorsMap!.set(doorId, record);
    });
    return;
  }
  const localPub = localPubReader!();
  const ownerPub = ownerPubReader?.() ?? null;
  const isOwner = !!localPub && !!ownerPub && localPub === ownerPub;

  // Decide the write class. Priority:
  //  1. Non-transient + local == owner: owner-signed.
  //  2. Transient + signer available: guest-signed (self-sign).
  //  3. Non-transient + non-owner: LEGACY unsigned (the cross-room mirror
  //     write from main.ts is the concrete case — a traveler cannot
  //     authoritatively sign for a foreign room's structural pairing).
  const wantOwnerSign = record.transient !== true && isOwner && !!ownerSigner;
  const wantGuestSign = record.transient === true && !!localPub && !!selfSigner;

  if (wantOwnerSign) {
    const seq = nextPairingSeqFor(doorId, ownerPub);
    record.seq = seq;
    let bytes: Uint8Array;
    try { bytes = doorPairingSignatureBytes(boundRoomId, doorId, record); }
    catch (e) {
      throw new Error(
        `writeDoorPairing: could not build owner-signature bytes for ${doorId} (${String(e)}) — refusing to persist an unsigned record`,
      );
    }
    let sig: string | null = null;
    let signerErr: unknown = null;
    try { sig = ownerSigner!(bytes); } catch (e) { signerErr = e; }
    if (!sig) {
      throw new Error(
        `writeDoorPairing: owner signer failed for ${doorId} (${
          signerErr ? String(signerErr) : 'signer returned null'
        }) — refusing to persist an unsigned record`,
      );
    }
    record.ownerPub = ownerPub!;
    record.ownerSig = sig;
    boundDoc!.transact(() => { doorsMap!.set(doorId, record); });
    bumpWatermark(doorId, { seq, isTombstone: false });
    return;
  }

  if (wantGuestSign) {
    const seq = nextPairingSeqFor(doorId, ownerPub);
    record.seq = seq;
    let bytes: Uint8Array;
    try {
      bytes = doorPairingGuestSignatureBytes(boundRoomId, doorId, {
        ...record, guestPub: localPub!,
      });
    } catch (e) {
      throw new Error(
        `writeDoorPairing: could not build guest-signature bytes for ${doorId} (${String(e)}) — refusing to persist an unsigned record`,
      );
    }
    let sig: string | null = null;
    let signerErr: unknown = null;
    try { sig = selfSigner!(bytes); } catch (e) { signerErr = e; }
    if (!sig) {
      throw new Error(
        `writeDoorPairing: guest signer failed for ${doorId} (${
          signerErr ? String(signerErr) : 'signer returned null'
        }) — refusing to persist an unsigned record`,
      );
    }
    record.guestPub = localPub!;
    record.guestSig = sig;
    boundDoc!.transact(() => { doorsMap!.set(doorId, record); });
    bumpWatermark(doorId, { seq, isTombstone: false });
    return;
  }

  // Legacy unsigned path (documented residual — see module header). Concrete
  // case today: the cross-room MIRROR write from main.ts, where the traveler
  // writes into the arrival room's doc without owner authority. Falls through
  // to shape-only reads at every peer.
  boundDoc!.transact(() => { doorsMap!.set(doorId, record); });
}

/**
 * 🧹 Reap pairing records whose DOOR no longer exists.
 *
 * removeSelectedDoor only calls deleteDoorLayout, so before free doors could
 * pair this was harmless — a deleted door had no pairing. Now it matters: an
 * orphan record keeps publishing a phantom neighbour to every peer's exterior
 * view and offering transit into it, forever.
 *
 * A reaper rather than an inline delete in the editor, because a door deletion
 * also arrives from a PEER, which removeSelectedDoor never sees.
 *
 * `liveDoorIds` must be the room's REAL door set. The caller is responsible for
 * not calling this for an UNSEEDED room, where "no records" means "this room
 * predates the store" rather than "every door was deleted" — reaping there
 * would wipe every pairing in the room the first time anyone joined.
 *
 * #67 D3 note: reaping bare-deletes the orphan even in signed binding. There
 * is no replay attack surface here because the door itself no longer exists
 * — a re-set of the pairing points to a door that isn't there, so downstream
 * consumers (reconcileDoors, exterior projection) ignore it. Writing a signed
 * tombstone for an orphan would burn seq budget with no defence in return.
 */
export function reapOrphanPairings(liveDoorIds: ReadonlySet<string>): string[] {
  if (!docAlive()) return [];
  const dead: string[] = [];
  for (const id of doorsMap!.keys()) {
    // No cardinal exemption. It was here to stop an UNSEEDED room — which
    // reads as "no records at all" — from looking like every door had been
    // deleted; but the caller already refuses to reap in that state, so all
    // the exemption actually did was make a deleted CARDINAL door keep its
    // pairing forever, publishing a phantom neighbour to every peer's
    // exterior and offering transit into it. Exactly the defect the reaper
    // exists to prevent, exempted for the doors most likely to have one.
    if (!liveDoorIds.has(id)) dead.push(id);
  }
  if (dead.length === 0) return [];
  boundDoc!.transact(() => {
    for (const id of dead) doorsMap!.delete(id);
  });
  return dead;
}

/**
 * Remove a door's pairing from the shared layout. Bare delete — reserved for
 * shapes where a tombstone offers no protection:
 *  - REJECTED-handshake path in world.ts (the pairing never landed).
 *  - Orphan-reap path in reapOrphanPairings (the door itself is gone).
 *
 * The intentional-detach path (docking.ts's "detach-berth" action for
 * transient berths, and the owner "undock-module" action for permanent
 * modules) uses `detachTransientBerth` / `writeDoorTombstone` respectively,
 * so the signed-tombstone lands and the replay attack window closes.
 */
export function deleteDoorPairing(doorId: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorsMap!.delete(doorId);
  });
}

/**
 * ⏏ #91 + #67 D3: OWNER UNDOCK of a permanent module leaves a signed
 * TOMBSTONE at the slot rather than a bare delete.
 *
 * Pre-#67 rationale (kept): only one room doc is bound at a time, so an
 * undock can never reach the far room's mirror record. That stale mirror
 * still offers transit back; on arrival the lazy mirror-write saw NO record
 * here (a plain delete is indistinguishable from "never docked") and
 * helpfully re-created the pairing. One walk-through silently undid the
 * undock for everyone. A present-but-unpaired record renders exactly like
 * an absent one — reconcileDoors routes it to clearRemotePairing — but it
 * is proof the connection was deliberately taken down. The retired address
 * lets it refuse precisely that module and no other.
 *
 * #67 D3: adds the OWNER signature so a hostile peer cannot revoke a signed
 * pairing via an UNSIGNED tombstone (BLOCKER-1 pattern from PR #129 audit).
 * The seq inside the signed envelope defeats a hostile REPLAY of the
 * original paired bytes after tombstone.
 *
 * THROWS in signed binding when signing was required and failed. See the
 * doorPolicy.ts removeDoorGrant doc-comment for the split-brain scenario
 * this fail-loud stance closes.
 */
export function writeDoorTombstone(doorId: string, retiredAddress = ''): void {
  if (!docAlive()) return;
  const record: DoorTombstone = { paired: false, retiredAddress };
  // Legacy binding is keyed on `!verifier` (pre-D3 posture — no signature
  // layer at all). SIGNED binding without a wired owner signer is a
  // different scenario: the caller reached here without owner authority
  // (guest peer, un-signed-in session, misconfigured seam) and MUST NOT
  // plant an unsigned tombstone — that would CRDT-clobber a signed pairing
  // and every reader in signed binding would refuse the tombstone, leaving
  // the pairing invisible-but-not-authoritatively-revoked.
  if (!verifier) {
    boundDoc!.transact(() => { doorsMap!.set(doorId, record); });
    return;
  }
  if (!ownerSigner || !localPubReader || !ownerPubReader) {
    // Signed binding but no owner-signing path — refuse the write.
    return;
  }
  const localPub = localPubReader();
  const ownerPub = ownerPubReader();
  if (!localPub || !ownerPub || localPub !== ownerPub) {
    // Non-owner caller in signed binding — refuse rather than plant an
    // unsigned tombstone that verify-on-read drops but that still CRDT-
    // clobbers the pairing. Owner-only UI gates this call site already
    // (docking.ts "undock-module" action); a caller that reaches here is
    // buggy or hostile. Same posture as doorPolicy.ts's removeDoorGrant.
    return;
  }
  const seq = nextPairingSeqFor(doorId, ownerPub);
  record.seq = seq;
  let bytes: Uint8Array;
  try { bytes = doorTombstoneSignatureBytes(boundRoomId, doorId, record); }
  catch (e) {
    throw new Error(
      `writeDoorTombstone: could not build tombstone bytes for ${doorId} (${String(e)}) — refusing to leave the pairing standing without a signed tombstone`,
    );
  }
  let sig: string | null = null;
  let signerErr: unknown = null;
  try { sig = ownerSigner!(bytes); } catch (e) { signerErr = e; }
  if (!sig) {
    throw new Error(
      `writeDoorTombstone: owner signer failed for ${doorId} (${
        signerErr ? String(signerErr) : 'signer returned null'
      }) — refusing to leave the pairing standing without a signed tombstone`,
    );
  }
  record.ownerPub = ownerPub;
  record.ownerSig = sig;
  boundDoc!.transact(() => { doorsMap!.set(doorId, record); });
  bumpWatermark(doorId, { seq, isTombstone: true });
}

/**
 * ⏏ #67 D2 + D3: TRANSIENT-berth DETACH — the EITHER-SIDE cast-off action
 * from docking.ts's "detach-berth" UI. In signed binding, writes a signed
 * tombstone at the slot (owner-signed if the local session is the room
 * owner, guest-signed otherwise). NEVER a bare delete in signed binding —
 * that shape is fail-DANGEROUS (any peer that retained the paired bytes can
 * re-set the slot after the delete, restoring the berth every reader draws;
 * this is the pairing analogue of PR #129's revoked-grant replay defence).
 *
 * In legacy binding (no verifier / no signer wired), falls through to a
 * bare delete — pre-D3 rooms have no signature layer to defeat and the
 * detach-then-replay attack is orthogonal to the D3 seq discipline for
 * those rooms.
 *
 * Reads the current record's `connectedRoomAddress` to populate the
 * tombstone's `retiredAddress` (so the mirror-write refusal in main.ts's
 * arrival path continues to name the exact module cast off). If no valid
 * pairing sits at the slot, does nothing (nothing to detach).
 *
 * THROWS in signed binding when signing was required and failed.
 */
export function detachTransientBerth(doorId: string): void {
  if (!docAlive()) return;
  const raw = doorsMap!.get(doorId);
  // Only accept the current record's retiredAddress from a shape-valid
  // pairing — a hostile shape at the slot must not smuggle an arbitrary
  // retiredAddress into our tombstone's signed bytes.
  if (!isDoorRecord(raw) || !raw.paired) {
    // Nothing to detach — no bare delete either (would leave the slot in
    // whatever hostile state it was in). Callers with no active pairing
    // should not have reached this button.
    return;
  }
  const retiredAddress = raw.connectedRoomAddress;

  const canSignOwner = !!verifier && !!ownerSigner && !!localPubReader && !!ownerPubReader;
  const canSignGuest = !!verifier && !!selfSigner && !!localPubReader;
  if (!canSignOwner && !canSignGuest) {
    // Legacy binding — pre-D3 bare delete.
    boundDoc!.transact(() => { doorsMap!.delete(doorId); });
    return;
  }

  const localPub = localPubReader!();
  const ownerPub = ownerPubReader?.() ?? null;
  const isOwner = !!localPub && !!ownerPub && localPub === ownerPub;

  const record: DoorTombstone = { paired: false, retiredAddress };
  const seq = nextPairingSeqFor(doorId, ownerPub);
  record.seq = seq;

  if (isOwner && canSignOwner) {
    // Owner detaching a berth on their own door — sign as owner.
    let bytes: Uint8Array;
    try { bytes = doorTombstoneSignatureBytes(boundRoomId, doorId, record); }
    catch (e) {
      throw new Error(
        `detachTransientBerth: could not build owner-tombstone bytes for ${doorId} (${String(e)}) — refusing to leave the berth standing without a signed tombstone`,
      );
    }
    let sig: string | null = null;
    let signerErr: unknown = null;
    try { sig = ownerSigner!(bytes); } catch (e) { signerErr = e; }
    if (!sig) {
      throw new Error(
        `detachTransientBerth: owner signer failed for ${doorId} (${
          signerErr ? String(signerErr) : 'signer returned null'
        }) — refusing to leave the berth standing without a signed tombstone`,
      );
    }
    record.ownerPub = ownerPub!;
    record.ownerSig = sig;
    boundDoc!.transact(() => { doorsMap!.set(doorId, record); });
    bumpWatermark(doorId, { seq, isTombstone: true });
    return;
  }

  // Non-owner (or owner without ownerSigner wired) — guest-sign.
  if (!canSignGuest || !localPub) {
    // No path to sign — the safest posture is to leave the slot untouched
    // rather than degrade to a bare delete a hostile peer could replay
    // against. Owner UI already gates the detach button by "berth present";
    // reaching here without a signer means the seam wiring is broken.
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = doorTombstoneGuestSignatureBytes(boundRoomId, doorId, {
      ...record, guestPub: localPub,
    });
  } catch (e) {
    throw new Error(
      `detachTransientBerth: could not build guest-tombstone bytes for ${doorId} (${String(e)}) — refusing to leave the berth standing without a signed tombstone`,
    );
  }
  let sig: string | null = null;
  let signerErr: unknown = null;
  try { sig = selfSigner!(bytes); } catch (e) { signerErr = e; }
  if (!sig) {
    throw new Error(
      `detachTransientBerth: guest signer failed for ${doorId} (${
        signerErr ? String(signerErr) : 'signer returned null'
      }) — refusing to leave the berth standing without a signed tombstone`,
    );
  }
  record.guestPub = localPub;
  record.guestSig = sig;
  boundDoc!.transact(() => { doorsMap!.set(doorId, record); });
  bumpWatermark(doorId, { seq, isTombstone: true });
}
