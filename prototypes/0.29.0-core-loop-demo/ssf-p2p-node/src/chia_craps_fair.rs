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
#![cfg(feature = "chia-publish")]

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use chia_bls::SecretKey;
use chia_protocol::{Bytes, Bytes32, Coin};
use crate::chia_chain::ChainAccess;
use sha2::{Digest, Sha256};

use crate::chia_faucet::{unspent_at, MAX_FAUCET_PAGES};
use crate::chia_publish::{build_publish_bundle, find_spendable_coin, our_puzzle_hash, push_parked, WALLET_LEASE};
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
/// the plaintext fairness record. Reuses the presence lane's `build_publish_bundle`
/// and pushes with the coin parked first (`push_parked`: a push that times out
/// may still have landed, so the coin stays parked until the chain or the
/// mempool settles it; an outright rejection frees it).
async fn push_fair_record(
    client: &impl ChainAccess,
    chia_sk: &SecretKey,
    coin: Coin,
    table: &str,
    round: u64,
    payload: &[u8],
) -> Result<()> {
    let hint = fair_hint(table, round);
    let bundle = build_publish_bundle(chia_sk, coin, hint, Bytes::new(payload.to_vec()))?;
    push_parked(client, bundle, [coin.coin_id()]).await?;
    Ok(())
}

/// Poll until `spent` is no longer in the unspent set, then return the largest
/// remaining spendable coin. Waiting for `spent` to disappear (rather than
/// simply returning the first coin that differs from it) is safe when the wallet
/// has multiple coins: a larger coin could be returned before `spent`'s spend
/// confirms, violating the commit→reveal ordering assumption. ~200 s bound.
///
/// The listing is PAGED like every other wallet listing (#245 review, round 15):
/// `spent` was selected across up to [`MAX_FAUCET_PAGES`] listing pages, so the
/// first page alone could simply not hold it while it still sits unspent on a
/// later one, and the reveal would go out before the commit confirmed. A
/// listing cut short that does not show `spent` proves nothing either way
/// ([`confirmed_gone`]): the wait goes on.
async fn wait_for_next_coin(
    client: &impl ChainAccess,
    our_ph: Bytes32,
    spent: &Coin,
) -> Result<Coin> {
    let mut cut_short = false;
    for attempt in 0..40u32 {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let listing = unspent_at(client, our_ph).await?;
        cut_short = listing.partial;
        let unspent: Vec<Coin> = listing.coins.into_iter().map(|c| c.coin).collect();
        if confirmed_gone(!listing.partial, &unspent, spent) {
            if let Some(next) = unspent.into_iter().max_by_key(|c| c.amount) {
                return Ok(next);
            }
        }
        if attempt % 4 == 3 {
            println!("   …waiting for block confirmation ({}s)", (attempt + 1) * 5);
        }
    }
    if cut_short {
        return Err(anyhow!(
            "timed out (~200 s): the wallet listing is cut short at {MAX_FAUCET_PAGES} pages, so whether the spend confirmed cannot be read"
        ));
    }
    Err(anyhow!(
        "timed out (~200 s) waiting for the spend to confirm — testnet slow or unfunded"
    ))
}

/// Whether a wallet listing proves `spent` gone from the unspent set: absent
/// from a COMPLETE listing. Absent from one cut short, it may sit on a page the
/// listing never reached, so that is unknown, not confirmed (#245 review,
/// round 15).
fn confirmed_gone(listing_complete: bool, unspent: &[Coin], spent: &Coin) -> bool {
    listing_complete && !unspent.iter().any(|c| c == spent)
}

/// Resolve every PUBLIC fairness record published under (table, round): the raw
/// plaintext payloads (commit and/or reveal), in confirmation order. Read-only.
pub async fn resolve_fair_records(table: &str, round: u64) -> Result<Vec<Vec<u8>>> {
    let client = crate::chia_chain::connect();
    let hint = fair_hint(table, round);
    let mut records = client
        .coin_records_by_hint(hint, None, true, None)
        .await
        .map_err(|e| anyhow!("hint lookup: {e}"))?
        .records;
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
    let client = crate::chia_chain::connect();
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

    // 1. COMMIT. Select + push under the wallet lease (chia_publish::WALLET_LEASE):
    //    the heartbeat or the faucet dish must not pick the same coin before this
    //    spend confirms. The confirmation wait below runs with the lease released.
    let commit_payload = serde_json::to_vec(&serde_json::json!({
        "t": table, "r": round, "k": "commit", "commit": commit,
    }))?;
    let coin_a = {
        let _lease = WALLET_LEASE.lock().await;
        WALLET_LEASE.ensure_open()?;
        WALLET_LEASE.reconcile(&client).await;
        let coin = find_spendable_coin(&client, our_ph)
            .await?
            .ok_or_else(|| anyhow!("chia wallet unfunded — no unspent coin at {our_ph}; fund it at a testnet11 faucet"))?;
        push_fair_record(&client, chia_sk, coin.clone(), table, round, &commit_payload).await?;
        coin
    };
    println!("   ✅ commit published; waiting for confirmation…");
    wait_for_next_coin(&client, our_ph, &coin_a).await?;

    // 2. REVEAL (after the "betting window" — here, once the commit confirmed).
    //    Selected afresh under the lease: `wait_for_next_coin`'s pick could have
    //    been taken by another writer in the meantime.
    let reveal_payload = serde_json::to_vec(&serde_json::json!({
        "t": table, "r": round, "k": "reveal", "seed": seed_hex, "beacon": beacon_hex,
    }))?;
    let coin_b = {
        let _lease = WALLET_LEASE.lock().await;
        WALLET_LEASE.ensure_open()?;
        WALLET_LEASE.reconcile(&client).await;
        let coin = find_spendable_coin(&client, our_ph)
            .await?
            .ok_or_else(|| anyhow!("no spendable coin for the reveal (the commit's change not confirmed yet?)"))?;
        push_fair_record(&client, chia_sk, coin.clone(), table, round, &reveal_payload).await?;
        coin
    };
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
    fn matches_the_browser_fairdice_golden_vectors() {
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
    fn a_coin_missing_from_a_listing_cut_short_is_not_confirmed_gone() {
        let coin = |n: u8, amount: u64| Coin::new(Bytes32::new([n; 32]), Bytes32::new([0u8; 32]), amount);
        let spent = coin(1, 500);
        let others = vec![coin(2, 700), coin(3, 100)];
        // Still listed: not gone, whatever the listing's completeness.
        assert!(!confirmed_gone(true, &[spent.clone(), others[0].clone()], &spent));
        assert!(!confirmed_gone(false, &[spent.clone()], &spent));
        // Absent from a COMPLETE listing: confirmed gone.
        assert!(confirmed_gone(true, &others, &spent));
        // Absent from a listing cut short: it may sit on a page never reached —
        // unknown, and the reveal must wait (#245 review, round 15).
        assert!(!confirmed_gone(false, &others, &spent));
        assert!(!confirmed_gone(false, &[], &spent));
    }

    #[test]
    fn fair_hint_is_public_and_per_roll() {
        assert_eq!(fair_hint("t", 1), fair_hint("t", 1));
        assert_ne!(fair_hint("t", 1), fair_hint("t", 2));
        assert_ne!(fair_hint("t", 1), fair_hint("u", 1));
    }
}
