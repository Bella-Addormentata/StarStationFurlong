//! 🎲⛓️ Craps provably-fair transcript on testnet11 (#69 G5b · plan §12, slice T1).
//!
//! Publishes the house's COMMIT and REVEAL for one (table, round) as two
//! spend-to-self records carrying `[hint, payload]` memos — the SAME primitive
//! the presence lane (`chia_publish` / `chia_resolve`) verified live on testnet11
//! (2026-07-16), with ONE difference: the payload is PLAINTEXT (publicly
//! auditable), not sealed, because the whole point of a fairness transcript is
//! that ANYONE can read and check it.
//!
//! The scheme (identical maths to the browser's `src/games/fairDice.ts`, so the
//! two are cross-verifiable):
//!   1. commit  = sha256("ssf-craps-commit-v1|" + seedHex)  — published BEFORE bets.
//!   2. beacon  = a Chia block header_hash (T1 uses a placeholder; T2 swaps in a
//!      real testnet block hash) — unpredictable at commit time.
//!   3. reveal  = the seed — published at settle. dice = deriveDice(seed, beacon,
//!      table, round). Anyone resolves both records and re-derives the dice.
//!
//! Why this needs NO wallet spike (B-7): it is the same self-recreating
//! spend-to-self as presence — no CAT mint/melt, no channel coins, no
//! arbitrary-recipient spends. Only the wagering (chips/channels) waits on B-7.
//!
//! NOT run-verified from CI/browser: `cargo check --features chia-lane` compiles
//! it, but the publish→resolve loop must run against the funded dev wallet on the
//! chia-lane build (see brainstorming/craps-chia-backend-plan.md §12.5). The
//! `SSF_CHIA_CRAPS_FAIR_TEST=1` hook in main.rs runs the end-to-end self-test.
#![cfg(feature = "chia-lane")]

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use chia_bls::SecretKey;
use chia_protocol::{Bytes, Bytes32, Coin};
use chia_sdk_coinset::{ChiaRpcClient, CoinsetClient};
use sha2::{Digest, Sha256};

use crate::chia_publish::{build_publish_bundle, find_spendable_coin, our_puzzle_hash};
use crate::chia_resolve::{extract_ciphertext, fetch_coin_spend};

/// Domain for the PUBLIC craps-fairness lookup hint. Unlike presence (keyed on a
/// room SECRET), this is keyed on the PUBLIC (table, round) so ANY auditor who
/// knows the roll can find its commit + reveal records.
const CTX_FAIR_HINT: &str = "ssf-craps-fair-hint-v1";

/// Public lookup hint for one table's roll.
pub fn fair_hint(table: &str, round: u64) -> Bytes32 {
    Bytes32::new(blake3::derive_key(
        CTX_FAIR_HINT,
        format!("{table}|{round}").as_bytes(),
    ))
}

fn sha256_hex(msg: &str) -> String {
    let mut h = Sha256::new();
    h.update(msg.as_bytes());
    hex::encode(h.finalize())
}

fn sha256_bytes(msg: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(msg.as_bytes());
    h.finalize().into()
}

/// `commitToSeed` — MUST match `src/games/fairDice.ts` byte-for-byte.
pub fn commit_to_seed(seed_hex: &str) -> String {
    sha256_hex(&format!("ssf-craps-commit-v1|{seed_hex}"))
}

/// `deriveDice` — MUST match `src/games/fairDice.ts` byte-for-byte: rejection
/// sampling (a byte ≥ 252 is discarded → uniform 1..6), re-hashing with an
/// incrementing block counter if a hash block is exhausted.
pub fn derive_dice(seed_hex: &str, beacon_hex: &str, table: &str, round: u64) -> (u8, u8) {
    let base = format!("ssf-craps-dice-v1|{seed_hex}|{beacon_hex}|{table}|{round}");
    let mut dice: Vec<u8> = Vec::with_capacity(2);
    let mut block: u64 = 0;
    let mut bytes = sha256_bytes(&format!("{base}|{block}"));
    block += 1;
    let mut i = 0usize;
    while dice.len() < 2 {
        if i >= bytes.len() {
            bytes = sha256_bytes(&format!("{base}|{block}"));
            block += 1;
            i = 0;
        }
        let b = bytes[i];
        i += 1;
        if b < 252 {
            dice.push((b % 6) + 1);
        }
    }
    (dice[0], dice[1])
}

/// Spend a specific `coin` back to self carrying `[fair_hint, payload]` memos —
/// the plaintext fairness record. Reuses the presence lane's `build_publish_bundle`.
async fn push_fair_record(
    client: &CoinsetClient,
    chia_sk: &SecretKey,
    coin: Coin,
    table: &str,
    round: u64,
    payload: &[u8],
) -> Result<()> {
    let hint = fair_hint(table, round);
    let bundle = build_publish_bundle(chia_sk, coin, hint, Bytes::new(payload.to_vec()))?;
    let resp = client
        .push_tx(bundle)
        .await
        .map_err(|e| anyhow!("coinset push_tx failed: {e}"))?;
    if !resp.success {
        return Err(anyhow!("push_tx rejected: {:?}", resp.error));
    }
    Ok(())
}

/// Poll until `spent` is no longer in the unspent set, then return the largest
/// remaining spendable coin. Waiting for `spent` to disappear (rather than
/// simply returning the first coin that differs from it) is safe when the wallet
/// has multiple coins: a larger coin could be returned before `spent`'s spend
/// confirms, violating the commit→reveal ordering assumption. ~200 s bound.
async fn wait_for_next_coin(
    client: &CoinsetClient,
    our_ph: Bytes32,
    spent: &Coin,
) -> Result<Coin> {
    for attempt in 0..40u32 {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let resp = client
            .get_coin_records_by_puzzle_hash(our_ph, None, None, Some(false), None)
            .await
            .map_err(|e| anyhow!("coinset get_coin_records_by_puzzle_hash failed: {e}"))?;
        if !resp.success {
            return Err(anyhow!("coin lookup unsuccessful: {:?}", resp.error));
        }
        let unspent: Vec<Coin> = resp
            .coin_records
            .unwrap_or_default()
            .into_iter()
            .filter(|r| !r.spent)
            .map(|r| r.coin)
            .collect();
        // Only proceed once `spent` is confirmed gone from the unspent set.
        if !unspent.iter().any(|c| c == spent) {
            if let Some(next) = unspent.into_iter().max_by_key(|c| c.amount) {
                return Ok(next);
            }
        }
        if attempt % 4 == 3 {
            println!("   …waiting for block confirmation ({}s)", (attempt + 1) * 5);
        }
    }
    Err(anyhow!(
        "timed out (~200 s) waiting for the spend to confirm — testnet slow or unfunded"
    ))
}

/// Resolve every PUBLIC fairness record published under (table, round): the raw
/// plaintext payloads (commit and/or reveal), in confirmation order. Read-only.
pub async fn resolve_fair_records(table: &str, round: u64) -> Result<Vec<Vec<u8>>> {
    let client = CoinsetClient::testnet11();
    let hint = fair_hint(table, round);
    let resp = client
        .get_coin_records_by_hint(hint, None, None, Some(true), None)
        .await
        .map_err(|e| anyhow!("get_coin_records_by_hint: {e}"))?;
    if !resp.success {
        return Err(anyhow!("hint lookup unsuccessful: {:?}", resp.error));
    }
    let mut records = resp.coin_records.unwrap_or_default();
    records.sort_by_key(|r| r.confirmed_block_index);
    let mut out = Vec::new();
    for rec in records {
        let parent =
            match fetch_coin_spend(&client, rec.coin.parent_coin_info, rec.confirmed_block_index)
                .await?
            {
                Some(cs) => cs,
                None => continue,
            };
        if let Some(payload) = extract_ciphertext(&parent, hint)? {
            out.push(payload);
        }
    }
    Ok(out)
}

/// End-to-end self-test (SSF_CHIA_CRAPS_FAIR_TEST=1): publish a commit, wait for
/// confirmation, publish the reveal, wait, then resolve both from testnet11 and
/// re-derive + verify the dice — proving the on-chain fairness transcript loop.
/// T1 uses a placeholder beacon; T2 swaps in a real testnet block header_hash.
pub async fn craps_fair_selftest(chia_sk: &SecretKey) -> Result<()> {
    let client = CoinsetClient::testnet11();
    let our_ph = our_puzzle_hash(chia_sk);

    // Unique per run so re-runs don't pile records under one hint.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let table = "ssf-craps-selftest";
    let round = now;

    // House secret seed + commitment (published BEFORE bets), and the dice we
    // expect the transcript to verify to.
    let mut seed = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut seed);
    let seed_hex = hex::encode(seed);
    let commit = commit_to_seed(&seed_hex);
    let beacon_hex = "00".repeat(32); // T1 placeholder — T2 uses a real block header_hash
    let (d1, d2) = derive_dice(&seed_hex, &beacon_hex, table, round);

    println!("🎲⛓️ craps-fair selftest — table={table} round={round}");
    println!("   commit = {commit}");

    // 1. COMMIT.
    let coin_a = find_spendable_coin(&client, our_ph)
        .await?
        .ok_or_else(|| anyhow!("chia wallet unfunded — no unspent coin at {our_ph}; fund it at a testnet11 faucet"))?;
    let commit_payload = serde_json::to_vec(&serde_json::json!({
        "t": table, "r": round, "k": "commit", "commit": commit,
    }))?;
    push_fair_record(&client, chia_sk, coin_a.clone(), table, round, &commit_payload).await?;
    println!("   ✅ commit published; waiting for confirmation…");
    let coin_b = wait_for_next_coin(&client, our_ph, &coin_a).await?;

    // 2. REVEAL (after the "betting window" — here, once the commit confirmed).
    let reveal_payload = serde_json::to_vec(&serde_json::json!({
        "t": table, "r": round, "k": "reveal", "seed": seed_hex, "beacon": beacon_hex,
    }))?;
    push_fair_record(&client, chia_sk, coin_b.clone(), table, round, &reveal_payload).await?;
    println!("   ✅ reveal published; waiting for confirmation…");
    wait_for_next_coin(&client, our_ph, &coin_b).await?;

    // 3. RESOLVE both records from testnet11 and VERIFY the transcript.
    let payloads = resolve_fair_records(table, round).await?;
    println!("   resolved {} record(s) under the public hint", payloads.len());
    let mut got_commit: Option<String> = None;
    let mut got_seed: Option<String> = None;
    let mut got_beacon: Option<String> = None;
    for p in &payloads {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(p) {
            match v.get("k").and_then(|k| k.as_str()) {
                Some("commit") => {
                    got_commit = v.get("commit").and_then(|c| c.as_str()).map(String::from)
                }
                Some("reveal") => {
                    got_seed = v.get("seed").and_then(|c| c.as_str()).map(String::from);
                    got_beacon = v.get("beacon").and_then(|c| c.as_str()).map(String::from);
                }
                _ => {}
            }
        }
    }
    let (Some(c), Some(s), Some(b)) = (got_commit, got_seed, got_beacon) else {
        return Err(anyhow!("did not resolve BOTH a commit and a reveal record"));
    };
    let commit_ok = commit_to_seed(&s) == c;
    let (rd1, rd2) = derive_dice(&s, &b, table, round);
    let dice_ok = (rd1, rd2) == (d1, d2);
    println!(
        "   verify: commit-matches-seed={commit_ok} · dice from transcript = {rd1}+{rd2} (expected {d1}+{d2}) · dice-match={dice_ok}"
    );
    if commit_ok && dice_ok {
        println!("🎲⛓️ craps-fair selftest PASSED — commit+reveal published and verified on testnet11");
        Ok(())
    } else {
        Err(anyhow!(
            "verification FAILED (commit_ok={commit_ok} dice_ok={dice_ok})"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // GOLDEN VECTORS captured from the browser's src/games/fairDice.ts for
    // seed="ab"×32, beacon="cd"×32, table="t", round=3. Pinned here so the Rust
    // port is proven byte-for-byte identical to the TS spec (and can't drift).
    #[test]
    fn matches_the_browser_faircdice_golden_vectors() {
        let seed = "ab".repeat(32);
        let beacon = "cd".repeat(32);
        assert_eq!(
            commit_to_seed(&seed),
            "e2e81d08b122e11bf1538832fc0dffdc50d635664afea618c6933658570063d1"
        );
        assert_eq!(derive_dice(&seed, &beacon, "t", 3), (2, 1));
    }

    #[test]
    fn commit_and_dice_are_deterministic_and_unbiased() {
        let seed = "ab".repeat(32);
        let beacon = "cd".repeat(32);
        assert_eq!(commit_to_seed(&seed), commit_to_seed(&seed)); // deterministic
        assert_ne!(commit_to_seed(&seed), seed); // hides the seed
        let d = derive_dice(&seed, &beacon, "t", 3);
        assert_eq!(d, derive_dice(&seed, &beacon, "t", 3)); // deterministic
        assert!(d.0 >= 1 && d.0 <= 6 && d.1 >= 1 && d.1 <= 6);
        // Distribution: 7 is the mode across many seeds.
        let mut counts = [0u32; 13];
        for i in 0..3000u64 {
            let s = format!("{:064x}", i);
            let (a, b) = derive_dice(&s, &beacon, "d", i);
            counts[(a + b) as usize] += 1;
        }
        assert!(counts[7] > counts[2] && counts[7] > counts[12]);
    }

    #[test]
    fn fair_hint_is_public_and_per_roll() {
        assert_eq!(fair_hint("t", 1), fair_hint("t", 1));
        assert_ne!(fair_hint("t", 1), fair_hint("t", 2));
        assert_ne!(fair_hint("t", 1), fair_hint("u", 1));
    }
}
