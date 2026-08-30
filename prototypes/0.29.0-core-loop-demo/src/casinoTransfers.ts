/**
 * 💸 In-world chip transfers (issue #20 — BANK send/receive slice)
 *
 * A CHIP TRANSFER moves casino chips from one identity (base64url Ed25519 pub)
 * to another INSIDE THE CURRENT ROOM. Transfers ride the room casino doc as
 * whole-value LWW records keyed by a collision-safe id, written ONCE by the
 * SENDER and signed with their identity key. The chip ledger already keys
 * PHYSICAL storage by the legacy per-install player id (`bal:<pid>` — see
 * casinoDoc.ts); the transfer record carries BOTH the identity pub (authority)
 * and the players-map key (settlement handle) so the two halves stay bound.
 *
 * Discipline (mirrors groupChat.ts / directMessages.ts):
 *   - **Deterministic id**  `deriveChipTransferId` hashes the domain-tagged
 *     canonical fields — same inputs on every peer converge on the same key
 *     (defence against a hostile peer trying to smuggle a mismatched-key entry
 *     into the audit log, and lets an accidental double-write LWW-merge into
 *     one record rather than fork).
 *   - **Shape guard**       `isChipTransfer` — kind + version + every field
 *     type/range checked, self-transfer rejected, id recomputed from the
 *     candidate fields and required to match. NEVER `throw`s — a malformed
 *     record cannot crash BANK repaint.
 *   - **Entry guard**       `isValidChipTransferEntry(key, value)` — chains
 *     the value guard AND requires the map KEY to equal `value.id`. Own writes
 *     go through `writeChipTransfer(t, verify)` which uses `map.set(t.id, t)` so the
 *     invariant always holds locally; the guard closes the same hijack window
 *     the group-chat lane closed (mismatched key ⇒ downstream lookups miss ⇒
 *     silent misroute).
 *   - **Signature check**   `verifyChipTransfer` — Ed25519 sig by `fromPub`
 *     over the canonical bytes (domain-tagged `ssf-chip-xfer:v1`). Verify is
 *     INJECTED so this module stays pure (no @noble import in the engine —
 *     the test file supplies a stub, the app wires `verifyIdentity`).
 *   - **Deterministic ledger-replay rule** `partitionValidTransfers` — replays
 *     the sorted transfers ((ts asc, id asc)) maintaining a per-player running
 *     SPENDABLE balance: each player's balance is seeded ON FIRST TOUCH at
 *     their sender-side issuance (`max(0, bought − cashed)`), then every valid
 *     transfer DEBITS the sender and CREDITS the recipient — so chips a player
 *     RECEIVED become spendable onward, exactly as the physical `bal:<pid>`
 *     ledger already permits at write time (writeChipTransfer checks the live
 *     balance, not lifetime issuance). A transfer whose amount exceeds the
 *     sender's running balance is REFUSED. Both sides derive the same
 *     partition, and because callers sig-verify EVERY row before this replay
 *     (a forged row can never enter), every credit corresponds to a
 *     genuinely-signed debit — phantom-mint is impossible: total spendable
 *     chips never exceed total honest cage issuance (Σ running balances =
 *     Σ first-touch budgets, invariant at every step).
 *
 * The `writeChipTransfer` path (in casinoDoc.ts) mutates `bal:<from_pid>`
 * DOWN and `bal:<to_pid>` UP inside ONE Yjs transact so the physical chip
 * ledger stays consistent instant-to-instant; this engine module operates on
 * the RECORD side (the audit log + the derivation of who-owes-what).
 * Conservation invariant (test-locked): `Σ bal_stored` is unchanged by any
 * transfer — the sender loses exactly what the recipient gains.
 *
 * BLOCK-list integration lives at the render seam, not here — the pure
 * partition returns EVERY valid transfer; the BANK's incoming/outgoing
 * displays run the block filter over the partition so an incoming transfer
 * from a blocked identity is HIDDEN from view but the `bal:<to_pid>` credit
 * that already landed at write time is still counted (conservation preserved,
 * per issue #20 audit r2's "block-follows-rotation" edge sibling).
 */

import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex } from '@noble/hashes/utils';

// ── Constants ────────────────────────────────────────────────────────────────

/** Kind tag + version for the record. Never mutate — the shape guard rejects
 *  any other value, so bumping this is a schema migration. */
export const CHIP_TRANSFER_VERSION = 1 as const;
export const CHIP_TRANSFER_KIND = 'chip-xfer' as const;

/** Domain-separated hash prefix for the id derivation. Same discipline as
 *  keypair.nameCertBytes + groupChat.deriveGroupChatId + directMessages
 *  msgSignBytes: a versioned tag prevents cross-domain replay of the same
 *  hash bytes as a different message kind. */
const ID_DOMAIN = 'ssf-chip-xfer-id:v1';

/** Domain-separated bytes for the sender's signature (bound with roomId +
 *  every field so the same authorization cannot ride into another room, or
 *  be repurposed as a different transfer). */
const SIG_DOMAIN = 'ssf-chip-xfer:v1';

/** Cap on the number of SIGNATURE-VERIFIED transfer rows a room's audit log
 *  holds — the single bound shared by BOTH seams, and deliberately the same
 *  number at each so the ledger replay stays exact:
 *
 *    • writeChipTransfer refuses a new send once this many VERIFIED rows
 *      already exist. It counts only rows a hostile peer cannot mint —
 *      entry-valid AND signature-verified (forging one needs a real identity
 *      key) — so a keyless junk flood cannot trip the cap. The earlier count
 *      included UNVERIFIED rows, so 512 junk `xfer:` rows planted straight onto
 *      the Yjs map (which needs no key) locked every honest send in the room;
 *      counting only verified rows closes that denial-of-service.
 *
 *    • readAllChipTransfers stops materializing rows past this (the replay /
 *      render fan-out bound).
 *
 *  Capping HONEST rows at the very number the reader materializes is what keeps
 *  partitionValidTransfers' running-balance replay exact: honest history can
 *  never outgrow the read window, so a genuine transfer is never silently
 *  dropped from the balance computation (a per-sender cap would let N senders
 *  push the total past the window and truncate real history — a correctness
 *  bug, not just a capacity one). It is a hygiene / capacity bound, NOT a
 *  money-safety invariant: Yjs has no write ACL, so a hostile peer still writes
 *  what it likes; the enforceable truth is the balance transact plus the
 *  read-seam sig-verify + replay. Sized well over any realistic room (hundreds
 *  of transfers per hour still fit), the way MAX_GROUP_CHATS bounds its map. */
export const MAX_CHIP_TRANSFERS = 512;

/** Cap on the sender-supplied nonce length. The nonce only needs to be
 *  unique per (fromPub, toPub, amount, ts) tuple to collide-safe the id
 *  hash; a 16-hex-char nonce (64 bits of entropy) is plenty. A hostile peer
 *  writing multi-KB "nonces" is refused shape-first so nothing pokes at the
 *  raw string later. */
export const TRANSFER_NONCE_MAX = 128;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One in-world chip transfer, keyed by `xfer:<id>` on the casino Y.Map. Every
 * field is present on every valid write; whole-value LWW is safe because the
 * id is a hash of every non-signature field (change any field ⇒ different id
 * ⇒ different key, so overwrite is impossible in normal play).
 */
export interface ChipTransfer {
  v: typeof CHIP_TRANSFER_VERSION;
  kind: typeof CHIP_TRANSFER_KIND;
  /** Derived — see `deriveChipTransferId`. */
  id: string;
  /** Which room this transfer belongs to. Prevents a valid transfer from
   *  being replayed in a DIFFERENT room (the sig bytes bind it). */
  roomId: string;
  /** Sender's base64url Ed25519 identity pub. Authority for the signature. */
  fromPub: string;
  /** Recipient's base64url Ed25519 identity pub. */
  toPub: string;
  /** Sender's legacy players-map key (per-install UUID) — the ledger keys
   *  physical chip storage by this id today (`bal:<pid>`), so the transfer
   *  record carries it so the auto-settle mutation knows which key to touch.
   *  Bound into the id/sig so a hostile peer cannot rewrite a valid transfer
   *  to reference a different sender playerId. */
  fromPlayerId: string;
  /** Recipient's legacy players-map key. Same rationale as `fromPlayerId`. */
  toPlayerId: string;
  /** Chips moved (positive integer). Denomination decomposition is a display
   *  concern (chipDisplay.chipsFor) — the transfer amount is atomic. */
  amount: number;
  /** Sender-supplied collision-safe entropy for the id hash. Hex or
   *  base64url characters; opaque to this module. */
  nonce: string;
  /** Sender-supplied timestamp (ms since epoch). Not authoritative — clocks
   *  drift; only used for deterministic display order (ts asc, id asc) and
   *  as an id-hash input so two transfers with the same amount / parties
   *  yield distinct ids. */
  ts: number;
  /** Base64url Ed25519 signature by `fromPub` over the canonical bytes
   *  (`transferSignBytes(record)`). Verified on every read into the display. */
  sig: string;
}

/**
 * Per-player issuance from the cage ledger — the SEED for the ledger-replay
 * rule. `max(0, bought − cashed)` is the player's FIRST-TOUCH spendable
 * balance (their lifetime cage throughput); the replay then debits/credits
 * that balance as transfers move chips, so a player's spendable total also
 * grows with whatever they RECEIVE. Looked up by playerId (the players-map
 * key the ledger uses) for every sender AND recipient in the replayed set.
 */
export interface SenderIssuance {
  /** Total chips ever bought at the cage. */
  bought: number;
  /** Total chips ever cashed out at the cage. */
  cashed: number;
}

/** Result of the deterministic replay: which transfers pass the over-drain
 *  rule, which do not. Refused entries stay OUT of the audit-log display. */
export interface PartitionedTransfers {
  valid: ChipTransfer[];
  refused: ChipTransfer[];
}

// ── Canonicalization + id derivation + signing bytes ─────────────────────────

/** The tuple hashed to derive the id. Every non-signature field participates
 *  so two transfers that differ ANYWHERE hash to distinct ids. */
type IdInput = Omit<ChipTransfer, 'id' | 'sig'>;

/** Bytes hashed for the id. Field order is fixed and MUST match on every
 *  peer — the join order is the field ordering below (documented so a
 *  reviewer can re-derive the id from a record's fields by hand). */
function idInputBytes(input: IdInput): Uint8Array {
  const parts = [
    ID_DOMAIN,
    String(input.v),
    input.kind,
    input.roomId,
    input.fromPub,
    input.toPub,
    input.fromPlayerId,
    input.toPlayerId,
    String(input.amount),
    input.nonce,
    String(input.ts),
  ];
  return new TextEncoder().encode(parts.join('|'));
}

/**
 * Deterministic id from the non-signature fields — same inputs on every peer
 * yield the same id, so an accidental double-write LWW-merges into one
 * record instead of forking. The `t-` prefix keeps the id namespace visibly
 * distinct from `g-` (group chats) and future record kinds.
 */
export function deriveChipTransferId(input: IdInput): string {
  return `t-${bytesToHex(sha512(idInputBytes(input))).slice(0, 32)}`;
}

/**
 * Canonical bytes the SENDER signs. Bound with roomId + every field so the
 * same sig cannot ride a different transfer (id bound in too closes the
 * malleability window where a hostile peer might try to reshape a record and
 * keep the sig). Kept as JSON for reviewer clarity — the field set is small
 * and stable, so parsing/serialization overhead is trivial.
 */
export function transferSignBytes(t: IdInput & { id: string }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    k: SIG_DOMAIN,
    v: t.v,
    kind: t.kind,
    id: t.id,
    roomId: t.roomId,
    fromPub: t.fromPub,
    toPub: t.toPub,
    fromPlayerId: t.fromPlayerId,
    toPlayerId: t.toPlayerId,
    amount: t.amount,
    nonce: t.nonce,
    ts: t.ts,
  }));
}

// ── Shape guards (verify-on-read; hostile peers write junk) ──────────────────

function isBoundedString(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= max;
}

/**
 * True iff `x` is a well-formed transfer record whose id matches its own
 * fields. Rejects wrong kind / version, missing or mistyped fields, self-
 * transfer (nonsense), non-positive / non-integer amount, and an id that
 * doesn't match the fields (a hostile peer trying to hijack a well-known id
 * with different content is rejected here). NEVER throws.
 */
export function isChipTransfer(x: unknown): x is ChipTransfer {
  if (!x || typeof x !== 'object') return false;
  const o = x as Partial<ChipTransfer>;
  if (o.v !== CHIP_TRANSFER_VERSION) return false;
  if (o.kind !== CHIP_TRANSFER_KIND) return false;
  // roomId + pubs + playerIds are all bounded strings; keep a generous cap
  // (2 KB) so a hostile peer cannot smuggle multi-MB blobs through fields.
  if (!isBoundedString(o.id, 2048)) return false;
  if (!isBoundedString(o.roomId, 2048)) return false;
  if (!isBoundedString(o.fromPub, 2048)) return false;
  if (!isBoundedString(o.toPub, 2048)) return false;
  if (!isBoundedString(o.fromPlayerId, 2048)) return false;
  if (!isBoundedString(o.toPlayerId, 2048)) return false;
  if (!isBoundedString(o.nonce, TRANSFER_NONCE_MAX)) return false;
  if (!isBoundedString(o.sig, 2048)) return false;
  if (!Number.isSafeInteger(o.amount) || (o.amount as number) <= 0) return false;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return false;
  // Self-transfer is nonsense (a chip that never moves).
  if (o.fromPub === o.toPub) return false;
  if (o.fromPlayerId === o.toPlayerId) return false;
  // The claimed id must match the id derived from the fields — closes the
  // hijack window a hostile peer could otherwise exploit to write junk under
  // a well-known id (or to slide a mutated record past readers that check
  // fields but trust the id). Every field is fully checked above, so the
  // cast to IdInput is only closing TS's narrowing gap (Number.isSafeInteger
  // is not a type predicate) — not skipping any runtime guard.
  const derived = deriveChipTransferId(o as IdInput);
  return derived === o.id;
}

/**
 * True iff the map entry `(key, value)` is a well-formed transfer record whose
 * map KEY equals `value.id`. Own writes always call `map.set(t.id, t)` so the
 * invariant holds locally; a hostile peer that writes `key='junk'` /
 * `value.id='t-xyz'` (both individually valid) would produce an audit entry
 * whose downstream references (any lookup by the id string) would miss —
 * failing the guard here means the entry never appears in the ledger.
 */
export function isValidChipTransferEntry(
  key: unknown,
  value: unknown,
): value is ChipTransfer {
  if (typeof key !== 'string' || !key) return false;
  if (!isChipTransfer(value)) return false;
  return value.id === key;
}

// ── Signature verification (injected verifier keeps this module pure) ────────

/** Ed25519 verify function shape — matches `keypair.verifyIdentity`. The
 *  engine takes the verifier as a parameter so it never imports @noble; tests
 *  supply a deterministic stub, the app wires the real one. */
export type VerifyIdentityFn = (
  pubB64: string,
  bytes: Uint8Array,
  sigB64: string,
) => boolean;

/**
 * True iff the record's `sig` is a valid Ed25519 signature by `fromPub` over
 * the canonical bytes. Wrap-safe — a verifier that throws on malformed input
 * is caught by the caller's own guard (isChipTransfer, run first). Callers
 * SHOULD run the shape guard before this so we never verify unshaped data.
 */
export function verifyChipTransfer(t: ChipTransfer, verify: VerifyIdentityFn): boolean {
  try {
    return verify(t.fromPub, transferSignBytes(t), t.sig);
  } catch {
    return false;
  }
}

// ── Deterministic replay: over-drain refusal ─────────────────────────────────

/**
 * Comparator for the deterministic replay order. Same order on every peer
 * so both sides refuse the SAME transfers. Ts is the primary key (real-time
 * intent); id is the tie-breaker (a stable hash).
 */
export function compareTransfersForReplay(a: ChipTransfer, b: ChipTransfer): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Partition the transfers into (valid, refused) by replaying them in
 * deterministic order as a FULL LEDGER — received chips are spendable:
 *
 *   Each player has a running SPENDABLE balance, seeded ON FIRST TOUCH at
 *   `max(0, bought − cashed)` (their sender-side cage issuance). Replaying in
 *   (ts asc, id asc) order, every valid transfer DEBITS the sender's running
 *   balance by `amount` and CREDITS the recipient's by the same. A transfer is
 *   REFUSED when its `amount` exceeds the sender's CURRENT running balance, or
 *   when crediting the recipient would leave the safe-integer range (a bounds
 *   guard so a hostile-but-signed chain cannot drive a running balance past
 *   Number.MAX_SAFE_INTEGER and corrupt the arithmetic).
 *
 * This mirrors the physical settlement writeChipTransfer already performs (it
 * debits/credits the real `bal:<pid>` keys, checking the LIVE balance — not
 * lifetime issuance — at write time). Aligning the read-side replay to that
 * closes a divergence in the shipped slice: a player could physically spend
 * chips they RECEIVED (the write succeeds, `Σ bal:*` conserved) yet see that
 * onward transfer REFUSED and hidden from the audit view on every peer.
 *
 * No-mint proof: callers MUST sig-verify every record BEFORE partitioning
 * (see main.ts bankReadValidTransfers — verifyChipTransfer filters first), so
 * every row here is genuinely signed by its `fromPub`. A forged row never
 * enters; an attacker cannot credit themselves without a signed debit from a
 * real balance. `Σ running balances = Σ first-touch budgets` holds at every
 * step (each transfer only MOVES `amount` between two running balances), so
 * the total spendable is bounded by total honest cage issuance — received
 * chips circulate but are never multiplied.
 *
 * Callers pass:
 *  - `transfers`  — every shape+sig-verified record they want to display
 *  - `issuanceOf` — `playerId → {bought, cashed}` for every pid that appears
 *                   as a SENDER or RECIPIENT in `transfers`; missing pids get
 *                   0/0 (fail-closed: a sender the reader never saw issue
 *                   chips first-touches at a zero budget, so their transfers
 *                   are refused until they legitimately RECEIVE some)
 *
 * Missing / partial-doc reads stay fail-closed: an unknown pid first-touches
 * at a ZERO budget, so a sender whose cage `bought:` record has not yet synced
 * is refused rather than trusted — the deterministic safe answer.
 */
export function partitionValidTransfers(
  transfers: readonly ChipTransfer[],
  issuanceOf: (playerId: string) => SenderIssuance,
): PartitionedTransfers {
  const sorted = [...transfers].sort(compareTransfersForReplay);
  // playerId → running spendable chips. Seeded lazily on first touch so a pid
  // that only ever RECEIVES still starts from its own cage issuance (0 for a
  // pure recipient) — never from an implicit unbounded balance.
  const balance = new Map<string, number>();
  const touch = (pid: string): number => {
    let b = balance.get(pid);
    if (b === undefined) {
      const iss = issuanceOf(pid);
      b = Math.max(0, iss.bought - iss.cashed);
      balance.set(pid, b);
    }
    return b;
  };
  const valid: ChipTransfer[] = [];
  const refused: ChipTransfer[] = [];
  for (const t of sorted) {
    // fromPlayerId !== toPlayerId is guaranteed by isChipTransfer (self-
    // transfers are rejected on read), so touching both never aliases one
    // running balance — the debit and credit target distinct entries.
    const from = touch(t.fromPlayerId);
    const nextTo = touch(t.toPlayerId) + t.amount;
    // Over-drain (amount beyond the sender's CURRENT balance) or an out-of-
    // range credit (bounds guard) is refused — the running arithmetic stays
    // exact and identical on every peer.
    if (t.amount > from || !Number.isSafeInteger(nextTo)) {
      refused.push(t);
      continue;
    }
    balance.set(t.fromPlayerId, from - t.amount);
    balance.set(t.toPlayerId, nextTo);
    valid.push(t);
  }
  return { valid, refused };
}

// ── Pure helpers used by the BANK render + tests ─────────────────────────────

/** Transfers whose recipient pub is `myPub`. Preserves the caller's order. */
export function filterIncoming(
  transfers: readonly ChipTransfer[],
  myPub: string,
): ChipTransfer[] {
  if (typeof myPub !== 'string' || !myPub) return [];
  return transfers.filter((t) => t.toPub === myPub);
}

/** Transfers whose sender pub is `myPub`. Preserves the caller's order. */
export function filterOutgoing(
  transfers: readonly ChipTransfer[],
  myPub: string,
): ChipTransfer[] {
  if (typeof myPub !== 'string' || !myPub) return [];
  return transfers.filter((t) => t.fromPub === myPub);
}

/**
 * Split an INCOMING-transfer list into (visible, hidden) by the block set —
 * the display-side twin of directMessages.filterOutBlockedDms. Blocked
 * incoming transfers stay OUT of the audit UI, but the physical chip credit
 * already applied at write time is not undone (conservation preserved). The
 * BANK's honest label can surface the hidden count so the block is visible.
 */
export function partitionIncomingByBlocked(
  incoming: readonly ChipTransfer[],
  blockedPubs: ReadonlySet<string>,
): { visible: ChipTransfer[]; hidden: number } {
  if (blockedPubs.size === 0) return { visible: incoming.slice(), hidden: 0 };
  const visible: ChipTransfer[] = [];
  let hidden = 0;
  for (const t of incoming) {
    if (blockedPubs.has(t.fromPub)) { hidden++; continue; }
    visible.push(t);
  }
  return { visible, hidden };
}

/**
 * Read every valid transfer entry out of an iterable of map entries. Shape
 * + entry guard applied to each; hostile / malformed rows silently skipped.
 * Signature verification is a SEPARATE step (verifyChipTransfer) so callers
 * can stage it behind the cheap shape guard.
 */
export function readTransferEntries(
  entries: Iterable<readonly [string, unknown]>,
): ChipTransfer[] {
  const out: ChipTransfer[] = [];
  for (const [k, v] of entries) {
    if (!isValidChipTransferEntry(k, v)) continue;
    out.push(v);
  }
  return out;
}

// ── Factory: build a fresh, signed transfer record (client-side) ─────────────

/**
 * Assemble a signed transfer record from user inputs. Validates the input
 * shape, derives the id, and calls the injected signer for the canonical
 * bytes. Never persists — the caller writes it into the doc in a transact
 * (see casinoDoc.writeChipTransfer). Throws on invalid input so the UI can
 * surface the exact reason (mirrors buildGroupChatThread).
 */
export function buildChipTransfer(input: {
  roomId: string;
  fromPub: string;
  toPub: string;
  fromPlayerId: string;
  toPlayerId: string;
  amount: number;
  nonce: string;
  ts: number;
  /** Sign the canonical bytes with the sender's identity key → base64url. */
  sign: (bytes: Uint8Array) => string;
}): ChipTransfer {
  if (!isBoundedString(input.roomId, 2048)) throw new Error('transfer roomId must be a non-empty string');
  if (!isBoundedString(input.fromPub, 2048)) throw new Error('transfer fromPub must be a non-empty string');
  if (!isBoundedString(input.toPub, 2048)) throw new Error('transfer toPub must be a non-empty string');
  if (!isBoundedString(input.fromPlayerId, 2048)) throw new Error('transfer fromPlayerId must be a non-empty string');
  if (!isBoundedString(input.toPlayerId, 2048)) throw new Error('transfer toPlayerId must be a non-empty string');
  if (!isBoundedString(input.nonce, TRANSFER_NONCE_MAX)) throw new Error(`transfer nonce must be a non-empty string of at most ${TRANSFER_NONCE_MAX} chars`);
  if (input.fromPub === input.toPub) throw new Error('cannot transfer to yourself');
  if (input.fromPlayerId === input.toPlayerId) throw new Error('cannot transfer to yourself');
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('transfer amount must be a positive integer');
  if (!Number.isFinite(input.ts)) throw new Error('transfer ts must be a finite number');
  const idInput: IdInput = {
    v: CHIP_TRANSFER_VERSION,
    kind: CHIP_TRANSFER_KIND,
    roomId: input.roomId,
    fromPub: input.fromPub,
    toPub: input.toPub,
    fromPlayerId: input.fromPlayerId,
    toPlayerId: input.toPlayerId,
    amount: input.amount,
    nonce: input.nonce,
    ts: input.ts,
  };
  const id = deriveChipTransferId(idInput);
  const unsigned = { ...idInput, id };
  const sig = input.sign(transferSignBytes(unsigned));
  return { ...unsigned, sig };
}
