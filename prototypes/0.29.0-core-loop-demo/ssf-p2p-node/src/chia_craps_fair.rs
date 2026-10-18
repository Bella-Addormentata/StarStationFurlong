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
use crate::chia_chain::{ChainAccess, CoinRecord, PagedRecords};
use sha2::{Digest, Sha256};

use crate::chia_faucet::MAX_FAUCET_PAGES;
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
    coin: crate::chia_faucet::FaucetCoin,
    table: &str,
    round: u64,
    payload: &[u8],
) -> Result<()> {
    let hint = fair_hint(table, round);
    let bundle = build_publish_bundle(chia_sk, coin.coin, hint, Bytes::new(payload.to_vec()))?;
    push_parked(client, bundle, [(coin.coin.coin_id(), coin.confirmed_height)]).await?;
    Ok(())
}

/// Poll until the chain reports `spent` SPENT: the coin's own record, asked
/// for by id and marked spent at a height, from the agreed peers. Its absence
/// from a wallet listing proved nothing: a listing cut short may have left it
/// on a page never reached (#245 review, round 15), and a COMPLETE listing from
/// peers standing below the coin's creation height omits it just the same, so
/// absence would have passed for the commit's confirmation and let the reveal
/// go out first (#271 review, round 19). Peers behind the spend report the
/// coin unspent, and the wait goes on; the next coin is picked afresh under the
/// wallet lease by the caller. ~200 s bound.
async fn wait_for_spend(client: &impl ChainAccess, spent: &Coin) -> Result<()> {
    for attempt in 0..40u32 {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let seen = client
            .coin_records_by_names(vec![spent.coin_id()], true, None)
            .await
            .map_err(|e| anyhow!("coin lookup: {e}"))?;
        if spend_confirmed(&seen.records, spent) {
            return Ok(());
        }
        if attempt % 4 == 3 {
            println!("   …waiting for block confirmation ({}s)", (attempt + 1) * 5);
        }
    }
    Err(anyhow!(
        "timed out (~200 s) waiting for the spend to confirm — testnet slow or unfunded"
    ))
}

/// Whether the records prove `spent` spent: its own record, marked spent. No
/// record (peers that have not reached its creation block, a lookup cut
/// short) and an unspent record are no evidence, so the wait goes on.
fn spend_confirmed(records: &[CoinRecord], spent: &Coin) -> bool {
    records.iter().any(|r| r.coin == *spent && r.spent)
}

/// Every coin under `hint`, pages followed up to the bound every wallet listing
/// shares: a transcript with records missing proves nothing, so a listing
/// still cut short is an error, not a shorter transcript. A coin a later page
/// lists again (spent since the earlier page: the chain pages by latest
/// change) is one coin, in its later state ([`PagedRecords`]), so no record is
/// read twice.
async fn fair_coins(client: &impl ChainAccess, hint: Bytes32) -> Result<Vec<CoinRecord>> {
    let mut gathered = PagedRecords::default();
    let mut cursor: Option<String> = None;
    let mut pages = 0usize;
    loop {
        let listing = client
            .coin_records_by_hint(hint, None, true, cursor.take())
            .await
            .map_err(|e| anyhow!("hint lookup: {e}"))?;
        pages += 1;
        gathered.fold(listing.records);
        let truncated = listing.truncated;
        match listing.next_cursor {
            Some(next) if truncated => {
                if pages >= MAX_FAUCET_PAGES {
                    return Err(anyhow!("hint lookup: the listing is cut short at {MAX_FAUCET_PAGES} pages, so records would be missing"));
                }
                cursor = Some(next);
            }
            _ if truncated => return Err(anyhow!("hint lookup: the listing is cut short with no way to go on")),
            _ => break,
        }
    }
    Ok(gathered.into_records())
}

/// Resolve every PUBLIC fairness record published under (table, round): the raw
/// plaintext payloads (commit and/or reveal), in confirmation order. Read-only.
pub async fn resolve_fair_records(table: &str, round: u64) -> Result<Vec<Vec<u8>>> {
    let client = crate::chia_chain::connect();
    let hint = fair_hint(table, round);
    let mut records = fair_coins(&client, hint).await?;
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
    wait_for_spend(&client, &coin_a.coin).await?;

    // 2. REVEAL (after the "betting window" — here, once the commit confirmed:
    //    the chain shows the commit's coin spent). The reveal's coin is
    //    selected afresh under the lease, which knows the commit's inputs.
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
    wait_for_spend(&client, &coin_b.coin).await?;

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

    #[tokio::test]
    async fn a_record_coin_listed_again_spent_on_a_later_page_is_read_once() {
        use crate::chia_chain::testing::Scripted;
        use crate::chia_chain::CoinListing;
        // The commit's coin is unspent on the first page and spent (the reveal
        // consumed it) by the time the second page is read, where it comes
        // again: one record, in its later state, not two transcripts.
        let coin = |seed: u8| Coin::new(Bytes32::new([seed; 32]), Bytes32::new([9u8; 32]), u64::from(seed));
        let rec = |c: Coin, height: u32, spent: Option<u32>| CoinRecord { coin: c, confirmed_block_index: height, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) };
        let first = CoinListing { records: vec![rec(coin(1), 80, None)], truncated: true, next_cursor: Some("page-2".into()), judged_at: None };
        let second =
            CoinListing { records: vec![rec(coin(1), 80, Some(101)), rec(coin(2), 101, None)], truncated: false, next_cursor: None, judged_at: None };
        let chain = Scripted::new(vec![first, second]);
        let coins = fair_coins(&chain, Bytes32::new([1u8; 32])).await.unwrap();
        assert_eq!(coins.iter().map(|r| (r.coin.amount, r.spent)).collect::<Vec<_>>(), vec![(1, true), (2, false)]);
    }

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
    fn only_the_coins_own_spent_record_confirms_the_commit() {
        let coin = |n: u8, amount: u64| Coin::new(Bytes32::new([n; 32]), Bytes32::new([0u8; 32]), amount);
        let rec = |c: Coin, spent: Option<u32>| CoinRecord { coin: c, confirmed_block_index: 90, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) };
        let spent = coin(1, 500);
        // Its own record, spent: confirmed.
        assert!(spend_confirmed(&[rec(coin(2, 700), None), rec(spent.clone(), Some(101))], &spent));
        // Its record unspent (peers behind the spend): the wait goes on.
        assert!(!spend_confirmed(&[rec(spent.clone(), None)], &spent));
        // No record of it at all (peers behind its creation block, a lookup
        // cut short): absence is no evidence, whatever else is listed
        // (#271 review, round 19).
        assert!(!spend_confirmed(&[], &spent));
        assert!(!spend_confirmed(&[rec(coin(2, 700), Some(101)), rec(coin(3, 100), None)], &spent));
    }

    #[test]
    fn fair_hint_is_public_and_per_roll() {
        assert_eq!(fair_hint("t", 1), fair_hint("t", 1));
        assert_ne!(fair_hint("t", 1), fair_hint("t", 2));
        assert_ne!(fair_hint("t", 1), fair_hint("u", 1));
    }
}
