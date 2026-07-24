/**
 * 🎲🔒 Provably-fair dice — the commit-reveal + block-beacon CORE (#69 G5b,
 * option (b) in brainstorming/craps-chia-backend-plan.md).
 *
 * This is the PURE cryptographic heart of the fair-dice scheme, with no doc,
 * DOM, network, or chain access — so it is fully console-testable AND it is the
 * single reference the ChiaLisp referee puzzle must reproduce (differential-test
 * the puzzle against `deriveDice` when G6 lands). It is deliberately NOT wired
 * into the live roll loop yet: the honest scheme needs the async multi-step
 * flow (commit at roll-open → wait for the beacon block → reveal at settle) and a
 * real Chia `header_hash` beacon, neither of which exists in the browser
 * prototype. Shipping the tested core now makes that wiring a transport job, not
 * a redesign — exactly the games-plan "make the swap a transport swap" posture.
 *
 * THE SCHEME (who can do what):
 *   1. At roll-open, BEFORE any bet, the house picks a secret `seed` and
 *      publishes `commit = commitToSeed(seed)`. It cannot change the seed later
 *      (players saw the commit; the synced record is whole-value LWW).
 *   2. Betting closes. A future Chia block at a pre-committed height H is mined;
 *      its `header_hash` is the `beacon` — unpredictable at commit time (it
 *      commits to the infused VDF output + all prior blocks), so NEITHER the
 *      house (which chose the seed but can't mine the block) nor a farmer (which
 *      might influence the block but can't know the seed) controls the result.
 *   3. The house reveals `seed`; everyone derives the SAME dice via
 *      `deriveDice(seed, beacon, tableId, round)` and checks `verifyRoll`.
 *
 * The `tableId` + `round` domain separation makes each table's each roll a
 * distinct draw from the same commit+beacon, so one beacon block can settle a
 * whole floor of tables at once (the shared-dice property the casino needs).
 *
 * Residual (documented in the plan §0): a house that ALSO farms significant
 * netspace could grind/withhold the beacon block. Adding player entropy to the
 * commit set (option (c)) closes that; for testnet bank craps the house-commit +
 * beacon is the chosen bar.
 */

/** SHA-256 of a UTF-8 string → raw bytes. Uses the platform SubtleCrypto (browser
 *  window.crypto.subtle; Node ≥ 20 globalThis.crypto.subtle), so it is async. */
async function sha256Bytes(message: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(message: string): Promise<string> {
  return toHex(await sha256Bytes(message));
}

/** A fresh 32-byte secret seed as hex (the house's per-roll secret). */
export function randomSeedHex(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/** The house's public COMMITMENT to a seed, published at roll-open before bets.
 *  Domain-separated so a commit can never be replayed as another message. */
export function commitToSeed(seedHex: string): Promise<string> {
  return sha256Hex(`ssf-craps-commit-v1|${seedHex}`);
}

/**
 * Derive the two dice (each 1–6, uniform + unbiased) DETERMINISTICALLY from the
 * revealed seed, the beacon, and the table/round domain. Rejection sampling on
 * the hash bytes removes modulo bias (a byte ≥ 252 = 42·6 is discarded); the
 * material is re-hashed with an incrementing block counter if a hash block is
 * exhausted (astronomically rare — ~1.5% reject per byte). Same inputs ⇒ same
 * dice, which is what makes the roll publicly verifiable.
 */
export async function deriveDice(
  seedHex: string,
  beaconHex: string,
  tableId: string,
  round: number,
): Promise<[number, number]> {
  return diceFromMaterial(`ssf-craps-dice-v1|${seedHex}|${beaconHex}|${tableId}|${round}`);
}

/**
 * Two unbiased dice (each 1–6) DETERMINISTICALLY from an arbitrary domain string
 * — the shared extraction behind every fairness mode (block-beacon derivation and
 * the commit-reveal / multiparty seed-combination in diceFairness.ts). Rejection
 * sampling removes modulo bias; re-hashes with an incrementing block counter if a
 * hash block is exhausted. Same `base` ⇒ same dice, which is what makes any mode's
 * roll publicly verifiable.
 */
export async function diceFromMaterial(base: string): Promise<[number, number]> {
  const dice: number[] = [];
  let block = 0;
  let bytes = await sha256Bytes(`${base}|${block++}`);
  let i = 0;
  while (dice.length < 2) {
    if (i >= bytes.length) {
      bytes = await sha256Bytes(`${base}|${block++}`);
      i = 0;
    }
    const b = bytes[i++];
    if (b < 252) dice.push((b % 6) + 1); // reject 252..255 → unbiased 1..6
  }
  return [dice[0], dice[1]];
}

/**
 * Verify a settled roll from its PUBLIC transcript — anyone (a player, an
 * auditor) can run this: the revealed seed must match the commit the house
 * published before bets, and the dice must be the deterministic derivation. A
 * false result means the transcript was tampered with (or the house cheated).
 */
export async function verifyRoll(
  commit: string,
  seedHex: string,
  beaconHex: string,
  tableId: string,
  round: number,
  dice: [number, number],
): Promise<boolean> {
  if ((await commitToSeed(seedHex)) !== commit) return false;
  const [d1, d2] = await deriveDice(seedHex, beaconHex, tableId, round);
  return d1 === dice[0] && d2 === dice[1];
}

// Debug/audit handle (the __ssfCasino precedent): exercise + verify the fair-dice
// scheme from the console without any UI or chain plumbing. Guarded so this pure
// module still imports under a non-DOM runtime (the node console tests).
if (typeof window !== 'undefined') {
  (window as unknown as { __ssfCrapsFair: unknown }).__ssfCrapsFair = {
    randomSeedHex,
    commitToSeed,
    deriveDice,
    verifyRoll,
  };
}
