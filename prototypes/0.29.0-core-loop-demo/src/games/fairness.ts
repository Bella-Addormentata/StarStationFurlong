/**
 * 🎰🔒 HOUSE COMMIT-REVEAL FAIRNESS — the shared G5 fairness core for the two
 * house-banked games (#69 G5). Roulette AND craps use the SAME proof shape and
 * the SAME verification: the operator (croupier/stickman client) picks a secret
 * seed at ROLL-OPEN, publishes `commit = H(domain | seedBytes)` to the round
 * record BEFORE bets close, and at settle publishes the seed as `reveal`. The
 * outcome (pocket 0..36 for roulette, [d1, d2] for craps) is DERIVED
 * DETERMINISTICALLY from the revealed seed via a pure rejection-sampled
 * function; every client re-computes it and refuses to render the round as
 * FAIR unless both checks pass:
 *
 *   1. H(commit-domain | seedBytes) === published commit
 *   2. derive(seedBytes, tableId, round, game) === published outcome
 *
 * TRUST BOUNDARY: `table:<id>` values live in the room Y.Map. Only the elected
 * operator (deed holder — see croupier.canRunCroupier) writes them; the
 * per-key single-writer discipline of the casino doc means a hostile peer
 * simply cannot land a rival table state. The one attack surface a hostile
 * peer HAS is corrupt SHAPE inside the fairness field (bogus hex, wrong types,
 * unbounded strings). `isFairnessProof` is the shape guard the room-state
 * guards call before any downstream code dereferences the proof — malformed
 * data reads as "no proof" (legacy label) rather than crashing the UI.
 *
 * PURE CORE vs BINDING LAYER (a hard split so the same math can move to a
 * ChiaLisp puzzle later):
 *
 *   • PURE (this module, top half) — rejection sampling over an injected byte
 *     buffer, hex utilities, shape guards. No wall-clock reads, no ambient
 *     randomness, no `crypto.subtle`, no DOM. Every function is
 *     deterministic and testable synchronously with a fixed byte vector.
 *
 *   • BINDING (this module, bottom half) — the async wrappers that supply
 *     bytes via platform SHA-256 (`crypto.subtle.digest`). The wrappers call
 *     the pure core; the pure core never calls the wrappers. If the SHA-256
 *     draw exhausts the 32-byte block before the sampler accepts a value
 *     (astronomically rare — rejection probability per byte ≈ 1.5% for dice,
 *     ≈ 13.3% for a roulette pocket), the wrapper re-hashes with an
 *     incrementing block counter and continues.
 *
 * HONEST LIMIT (documented, G5.1 follow-up): commit-reveal proves the house
 * did not change the outcome AFTER bets closed; it does NOT prevent the house
 * from grinding an adversarial seed BEFORE commit (they can pre-compute many
 * seed→outcome pairs and pick a favourable one). Mixing player entropy into
 * the derivation would close this — see the G5.1 note in TODO.md. For a
 * single-operator dev-phase house-banked table where the operator has no
 * economic incentive to grind (they own the house), this is the chosen bar;
 * grinding-resistance lands with the multiparty / block-beacon modes already
 * scaffolded in games/diceFairness.ts (#69 G6).
 */

// ── PURE CORE ─────────────────────────────────────────────────────────────────
// Hex/bytes helpers + rejection sampling over an INJECTED byte buffer. No
// hashing here; no DOM; no wall clock. Every function is deterministic.

/** Fixed length of a fairness seed / commit / reveal, in bytes. 32 = the width
 *  of SHA-256, wide enough that guessing the seed from the commit is infeasible
 *  and picking a favourable seed by brute force is intractable. */
export const FAIRNESS_SEED_BYTES = 32;

/** SHA-256 hex string length (64 chars). Both `commit` and `reveal` are always
 *  exactly this width; the shape guard enforces it. */
export const FAIRNESS_HEX_LEN = FAIRNESS_SEED_BYTES * 2;

/** House-only commit-reveal proof carried on a settled round record. `commit`
 *  is published at ROLL-OPEN (before bets close); `reveal` is added at SETTLE.
 *  During the betting window `reveal` is absent — the operator's client holds
 *  the seed privately until it publishes the reveal + settled outcome. */
export interface FairnessProof {
  /** SHA-256(commit-domain | seedBytes) as lower-case hex, 64 chars. */
  commit: string;
  /** Revealed seed as lower-case hex, 64 chars. Absent while betting is open. */
  reveal?: string;
}

/** The two house-banked games sharing this proof. Used only in the debug/audit
 *  string domain — `computeCommit` and derivation prefix a game-specific tag so
 *  a commit for roulette cannot verify against a craps outcome and vice versa. */
export type FairnessGameKind = 'roulette' | 'craps';

/** Verdict a client renders next to a settled outcome. FAIR = both checks
 *  passed. UNVERIFIED = the round CLAIMS a proof but at least one check failed
 *  (bad hex, reveal doesn't hash to the commit, or the derived outcome doesn't
 *  match the published outcome). LEGACY = no proof at all on this round —
 *  pre-G5 or a round settled without a pre-commit (documented read-repair
 *  case). Only FAIR is presented as "provably fair"; UNVERIFIED reads as a
 *  loud plain-language warning; LEGACY reads as a neutral "no fairness proof". */
export type FairnessVerdict = 'fair' | 'unverified' | 'legacy';

/** Lower-case hex (0-9a-f) match, no leading 0x. */
function isLowerHex(value: string, expectedLen: number): boolean {
  if (value.length !== expectedLen) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // 0..9 = 48..57; a..f = 97..102
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

/** Trust-boundary shape guard: peer-written FairnessProof values must be
 *  well-formed OR the UI treats the round as LEGACY. Never throws. */
export function isFairnessProof(value: unknown): value is FairnessProof {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Partial<FairnessProof>;
  if (typeof p.commit !== 'string' || !isLowerHex(p.commit, FAIRNESS_HEX_LEN)) return false;
  if (p.reveal !== undefined) {
    if (typeof p.reveal !== 'string' || !isLowerHex(p.reveal, FAIRNESS_HEX_LEN)) return false;
  }
  return true;
}

/** Bytes → lower-case hex. Pure; deterministic. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Lower-case hex → bytes; returns null on any malformed input (odd length,
 *  non-hex character). Pure; deterministic; never throws. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const hi = hexNibble(hex.charCodeAt(i));
    const lo = hexNibble(hex.charCodeAt(i + 1));
    if (hi < 0 || lo < 0) return null;
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;       // '0'..'9'
  if (code >= 97 && code <= 102) return code - 97 + 10; // 'a'..'f'
  if (code >= 65 && code <= 70) return code - 65 + 10;  // 'A'..'F' (tolerant read;
                                                        // shape guard still requires lower)
  return -1;
}

/** Constant-time equality on two SAME-length hex strings. Falls open (returns
 *  false) if lengths differ, so callers must have validated the shape first —
 *  the shape guard already enforces the SHA-256 width. Constant-time in the
 *  characters compared: no early return on the first mismatch, so a timing
 *  side channel on the commit compare is not usable to guess the seed. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** PURE rejection sampler for a value in 0..faces-1 with NO MODULO BIAS. Uses
 *  the given `bytes` buffer starting at `offset`. Rejects any byte at or above
 *  `256 - (256 % faces)`, the largest multiple-of-`faces` boundary. Returns
 *  `{ value, consumed }` (consumed counts every byte scanned, including
 *  rejected ones — the caller uses it to know if the buffer was exhausted).
 *  Returns `null` if the buffer runs out before a value is accepted; the
 *  caller (`derivePocket` etc.) can then hash another block and continue.
 *
 *  faces must be 2..256 inclusive. */
export function sampleFromBytes(
  bytes: Uint8Array,
  faces: number,
  offset = 0,
): { value: number; consumed: number } | null {
  if (!Number.isInteger(faces) || faces < 2 || faces > 256) return null;
  const cap = 256 - (256 % faces);
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < cap) return { value: b % faces, consumed: i - offset };
  }
  return null;
}

/** PURE derivation of a roulette pocket (0..36 inclusive, 37 faces) from a byte
 *  buffer. Rejection sampling on 37 → cap = 256 - (256 % 37) = 222 (bytes 222..
 *  255 are re-drawn, ~13.3% rejection per byte). Returns `null` on exhaustion;
 *  the async binding refills. Pure and side-effect-free. */
export function pocketFromBytes(
  bytes: Uint8Array,
  offset = 0,
): { value: number; consumed: number } | null {
  return sampleFromBytes(bytes, 37, offset);
}

/** PURE derivation of a two-die pair (each 1..6) from a byte buffer.
 *  Rejection sampling on 6 → cap = 252 (bytes 252..255 re-drawn, ~1.5%
 *  rejection per byte). Returns `null` on exhaustion. Pure. */
export function dicePairFromBytes(
  bytes: Uint8Array,
  offset = 0,
): { value: [number, number]; consumed: number } | null {
  const a = sampleFromBytes(bytes, 6, offset);
  if (!a) return null;
  const b = sampleFromBytes(bytes, 6, offset + a.consumed);
  if (!b) return null;
  return { value: [a.value + 1, b.value + 1], consumed: a.consumed + b.consumed };
}

// ── BINDING LAYER ─────────────────────────────────────────────────────────────
// Async wrappers that supply bytes via the platform SHA-256. The pure core
// above is called with those bytes; the pure core never reaches back here.

/** Domain string prefix on the commit hash. Versioned so a future proof scheme
 *  cannot be confused with this one (a v2 commit will not verify against a v1
 *  reveal). */
const COMMIT_DOMAIN = 'ssf-house-fairness-commit-v1';

/** Domain string prefix on the outcome-derivation hash. Same versioning
 *  discipline; the round + table + game are tacked on for domain separation
 *  so one seed cannot produce colliding outcomes across rounds or tables. */
const DERIVE_DOMAIN = 'ssf-house-fairness-derive-v1';

/** Async SHA-256 → bytes. Uses the platform SubtleCrypto (browser
 *  window.crypto.subtle; Node ≥ 20 globalThis.crypto.subtle). */
async function sha256Bytes(message: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

/** A fresh cryptographically-random 32-byte seed as lower-case hex. Uses
 *  `crypto.getRandomValues` — the same source the RNG dice/pocket used before
 *  G5. The seed leaves the operator's client ONLY as the reveal at settle. */
export function randomSeedHex(): string {
  const buf = new Uint8Array(FAIRNESS_SEED_BYTES);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/** Compute the public commitment for a secret seed. Async because SHA-256 is
 *  async in SubtleCrypto. Result is a lower-case-hex 64-character SHA-256. */
export async function computeCommit(seedHex: string): Promise<string> {
  const bytes = await sha256Bytes(`${COMMIT_DOMAIN}|${seedHex}`);
  return bytesToHex(bytes);
}

/** Domain-tagged derivation base for a specific round on a specific table for
 *  a specific game. Exposed for tests + audit; also used by the binding. */
export function deriveMaterial(
  kind: FairnessGameKind,
  tableId: string,
  round: number,
  seedHex: string,
): string {
  // The block counter is appended by the caller when re-hashing on exhaustion.
  return `${DERIVE_DOMAIN}|${kind}|${tableId}|${round}|${seedHex}`;
}

/** Draw enough SHA-256 bytes from the (seed, table, round, game) domain to
 *  satisfy the pure sampler `run`. Re-hashes with an incrementing block
 *  counter on exhaustion (astronomically rare — 32 bytes gives 27 usable
 *  pocket candidates and 31 usable die candidates on average). Deterministic
 *  in its inputs: same (kind, tableId, round, seedHex) always yields the same
 *  outcome, which is what makes the round verifiable. */
async function drawFromDomain<T>(
  kind: FairnessGameKind,
  tableId: string,
  round: number,
  seedHex: string,
  run: (bytes: Uint8Array) => { value: T; consumed: number } | null,
): Promise<T> {
  const base = deriveMaterial(kind, tableId, round, seedHex);
  let block = 0;
  let bytes = await sha256Bytes(`${base}|${block++}`);
  // Merge blocks together on exhaustion — the sampler keeps a stable byte
  // sequence across boundaries so re-verification lines up. In practice a
  // single 32-byte block ALWAYS suffices for one pocket or dice pair; the
  // loop is a safety net for the ~10^-27 exhaustion tail.
  let acc = bytes;
  for (let safety = 0; safety < 64; safety++) {
    const r = run(acc);
    if (r) return r.value;
    // Exhausted this block — draw one more, append, and let the sampler
    // continue on the extended buffer. Deterministic because the block
    // counter is domain-separated inside `base`.
    bytes = await sha256Bytes(`${base}|${block++}`);
    const merged = new Uint8Array(acc.length + bytes.length);
    merged.set(acc, 0);
    merged.set(bytes, acc.length);
    acc = merged;
  }
  // Truly unreachable in practice; keep it defensive.
  throw new Error('[fairness] sample exhaustion — impossible under SHA-256');
}

/** Async derivation of a roulette pocket (0..36) from the committed seed. */
export function derivePocket(
  tableId: string,
  round: number,
  seedHex: string,
): Promise<number> {
  return drawFromDomain('roulette', tableId, round, seedHex, (bytes) =>
    pocketFromBytes(bytes),
  );
}

/** Async derivation of the craps dice pair (each 1..6) from the committed seed. */
export function deriveDicePair(
  tableId: string,
  round: number,
  seedHex: string,
): Promise<[number, number]> {
  return drawFromDomain('craps', tableId, round, seedHex, (bytes) =>
    dicePairFromBytes(bytes),
  );
}

// ── Verification ──────────────────────────────────────────────────────────────
// One entry point per game. Absent proof ⇒ 'legacy' (rendered plainly).
// Present-but-inconsistent proof ⇒ 'unverified' (rendered as a loud warning).
// Consistent proof ⇒ 'fair'. Async because verifying requires re-hashing.

async function verifyProofAgainstOutcome(
  proof: FairnessProof | undefined,
  check: (seedHex: string) => Promise<boolean>,
): Promise<FairnessVerdict> {
  if (!isFairnessProof(proof)) return 'legacy';
  const { commit, reveal } = proof;
  if (reveal === undefined) return 'legacy'; // committed but not yet revealed
  // Recompute the commit from the revealed seed. If it doesn't match, the
  // house tried to swap the seed after publishing the commit → UNVERIFIED.
  const recomputed = await computeCommit(reveal);
  if (!constantTimeEqualHex(recomputed, commit)) return 'unverified';
  // Recompute the outcome and compare byte-for-byte with the published one.
  // A published outcome that doesn't match derivation ⇒ house tampered with
  // the derived draw → UNVERIFIED. `check` returns the game-specific test.
  const outcomeOk = await check(reveal);
  return outcomeOk ? 'fair' : 'unverified';
}

/** Verify a roulette round's published fairness proof against its published
 *  pocket. See FairnessVerdict for the three outcomes. Never throws — even a
 *  malformed proof or a promise rejection inside SubtleCrypto degrades to
 *  UNVERIFIED (a lie is a lie; the player is entitled to know). */
export async function verifyRoulette(
  proof: FairnessProof | undefined,
  tableId: string,
  round: number,
  pocket: number,
): Promise<FairnessVerdict> {
  try {
    return await verifyProofAgainstOutcome(
      proof,
      async (seedHex) => (await derivePocket(tableId, round, seedHex)) === pocket,
    );
  } catch {
    return 'unverified';
  }
}

/** Verify a craps round's published fairness proof against its published dice
 *  pair. See FairnessVerdict for the three outcomes. Never throws. */
export async function verifyCraps(
  proof: FairnessProof | undefined,
  tableId: string,
  round: number,
  dice: [number, number],
): Promise<FairnessVerdict> {
  try {
    return await verifyProofAgainstOutcome(
      proof,
      async (seedHex) => {
        const [d1, d2] = await deriveDicePair(tableId, round, seedHex);
        return d1 === dice[0] && d2 === dice[1];
      },
    );
  } catch {
    return 'unverified';
  }
}

// ── Operator seed store ───────────────────────────────────────────────────────
// Only the elected operator's client uses this: it holds the SECRET SEED for a
// committed-but-not-yet-revealed round, keyed by (kind, tableId, round). The
// pool is populated in `prepareRoundFairness` (called at open) and drained in
// `takeRoundSeed` (called at settle). No seed ever leaves this module until
// the operator publishes it as the reveal in the settled table state.

/** One entry per prepared round. Holding both the seed AND the commit means a
 *  settle can always publish a self-consistent proof, even if the room's
 *  betting state was clobbered mid-round and no longer carries the commit
 *  (peer-planted junk that failed the shape guard, or a race where the
 *  betting-state write hadn't yet landed when settle fires). */
interface StoredRoundProof {
  seedHex: string;
  commit: string;
}

const seedStore = new Map<string, StoredRoundProof>();

function seedKey(kind: FairnessGameKind, tableId: string, round: number): string {
  return `${kind}\0${tableId}\0${round}`;
}

/** Prepare a fresh commit-reveal proof for one round: mint a random seed, hash
 *  it to a public commit, store BOTH keyed by (kind, tableId, round). The
 *  caller writes the returned `proof` (commit only, reveal absent) into the
 *  round's table state BEFORE bets close. At settle, `consumeRoundProof`
 *  retrieves the seed AND the original commit to publish a self-consistent
 *  reveal. */
export async function prepareRoundFairness(
  kind: FairnessGameKind,
  tableId: string,
  round: number,
): Promise<{ proof: FairnessProof; seedHex: string }> {
  const seedHex = randomSeedHex();
  const commit = await computeCommit(seedHex);
  seedStore.set(seedKey(kind, tableId, round), { seedHex, commit });
  return { proof: { commit }, seedHex };
}

/** Retrieve the seed + commit stored by `prepareRoundFairness` for one round
 *  and DELETE the entry (so a seed can never be revealed twice). Returns null
 *  if there is no proof for that round — the documented read-repair case
 *  (operator changed mid-round, or a legacy round that pre-dates G5); the
 *  caller then settles without a fairness proof and the round renders LEGACY. */
export function consumeRoundProof(
  kind: FairnessGameKind,
  tableId: string,
  round: number,
): StoredRoundProof | null {
  const key = seedKey(kind, tableId, round);
  const entry = seedStore.get(key);
  if (entry === undefined) return null;
  seedStore.delete(key);
  return entry;
}

/** Thin wrapper kept for the tests that only need the seed. Consumes the
 *  entry exactly like `consumeRoundProof` (the two share the same underlying
 *  storage — call ONE per round, not both). */
export function takeRoundSeed(
  kind: FairnessGameKind,
  tableId: string,
  round: number,
): string | null {
  const p = consumeRoundProof(kind, tableId, round);
  return p ? p.seedHex : null;
}

/** Peek without consuming — for verification / debugging only (never used in
 *  the settle path, which must consume so a seed cannot be revealed twice). */
export function peekRoundSeed(
  kind: FairnessGameKind,
  tableId: string,
  round: number,
): string | null {
  return seedStore.get(seedKey(kind, tableId, round))?.seedHex ?? null;
}

/** Drop every seed held for one table — called on `closeTable` /
 *  `closeCrapsTable` so a removed table leaves no operator-side secrets
 *  behind, and so re-adding a table with the same id cannot accidentally
 *  reveal a seed from the previous incarnation. */
export function clearFairnessForTable(tableId: string): void {
  const suffix = `\0${tableId}\0`;
  for (const key of [...seedStore.keys()]) {
    // key layout: `${kind}\0${tableId}\0${round}` — the tableId sits between
    // the two nulls, so a substring match on the null-bracketed id is safe
    // against tableId values that happen to contain the kind name.
    if (key.includes(suffix)) seedStore.delete(key);
  }
}

/** Test-only: wipe every stored seed. Called from vitest teardown so cross-
 *  test bleed cannot make a settle see a seed from an earlier `it` block. */
export function __resetFairnessStoreForTests(): void {
  seedStore.clear();
}

// Debug/audit handle — verify a round from the console without UI plumbing.
if (typeof window !== 'undefined') {
  (window as unknown as { __ssfHouseFairness: unknown }).__ssfHouseFairness = {
    computeCommit,
    derivePocket,
    deriveDicePair,
    verifyRoulette,
    verifyCraps,
    randomSeedHex,
    isFairnessProof,
  };
}
