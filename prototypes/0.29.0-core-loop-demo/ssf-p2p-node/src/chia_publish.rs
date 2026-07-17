//! ChiaHub C1 Slice 4: PUBLISH a room-key-sealed presence record as a
//! spend-to-self carrying `[hint, ciphertext]` memos on testnet11.
//!
//! Two keys, two roles (this is the whole design):
//!   - the IROH secret key SIGNS the presence record (identity + authorship — a
//!     resolver dials the `node_id` inside it), via the shipped `chia_lane` crypto;
//!   - the CHIA BLS secret key PAYS for the publish (spends one of the wallet's
//!     coins back to itself, carrying the sealed record as memos).
//!
//! The principal returns to the wallet (spend-to-self, amount − fee), so only the
//! fee leaves. Every SDK call is the source-verified 0.34 API (audit surfaces B/C/D).
//! Behind the `chia-lane` feature; runtime-gated by SSF_CHIA_LANE=1 at the caller.
#![cfg(feature = "chia-lane")]

use anyhow::{anyhow, Result};
use chia_bls::{aggregate, sign, PublicKey, SecretKey, Signature};
use chia_protocol::{Bytes, Bytes32, Coin, CoinSpend, SpendBundle};
use chia_puzzle_types::standard::StandardArgs;
use chia_puzzle_types::DeriveSynthetic;
use chia_sdk_coinset::{ChiaRpcClient, CoinsetClient};
use chia_sdk_driver::{SpendContext, StandardLayer};
use chia_sdk_signer::{AggSigConstants, RequiredSignature};
use chia_sdk_types::{Conditions, TESTNET11_CONSTANTS};
use clvmr::Allocator;

use crate::chia_lane::{self, ChiaPresenceRecord};

/// Fee (mojos) for a publish. 0 confirms when the mempool is quiet (the usual
/// testnet state); the spend-to-self recreates the coin at `amount − fee`, so at
/// fee 0 the principal is fully preserved. Bump under sustained congestion.
const PUBLISH_FEE: u64 = 0;

/// How long a published record advertises itself as fresh (seconds). Advisory —
/// the chain cannot delete; resolvers enforce freshness and writers heartbeat.
const RECORD_TTL_SECS: u64 = 3600;

/// The standard puzzle hash our coins are locked to (from the synthetic key).
pub fn our_puzzle_hash(chia_sk: &SecretKey) -> Bytes32 {
    let synthetic_pk: PublicKey = chia_sk.public_key().derive_synthetic();
    StandardArgs::curry_tree_hash(synthetic_pk).into()
}

/// Find our largest UNSPENT coin — the one to spend-to-self. `None` if unfunded.
pub async fn find_spendable_coin(
    client: &CoinsetClient,
    puzzle_hash: Bytes32,
) -> Result<Option<Coin>> {
    let resp = client
        .get_coin_records_by_puzzle_hash(puzzle_hash, None, None, Some(false), None)
        .await
        .map_err(|e| anyhow!("coinset get_coin_records_by_puzzle_hash failed: {e}"))?;
    if !resp.success {
        return Err(anyhow!("coin lookup unsuccessful: {:?}", resp.error));
    }
    let mut coins: Vec<Coin> = resp
        .coin_records
        .unwrap_or_default()
        .into_iter()
        .filter(|r| !r.spent)
        .map(|r| r.coin)
        .collect();
    // Largest first — the recreated coin keeps the most value for future republishes.
    coins.sort_by_key(|c| std::cmp::Reverse(c.amount));
    Ok(coins.into_iter().next())
}

/// Build the SIGNED SpendBundle: spend `coin` back to our own puzzle hash at
/// `amount − fee`, carrying MEMOS = `( hint ciphertext )` (a proper 2-element
/// CLVM list). Signed for TESTNET11 with the synthetic BLS key.
pub fn build_publish_bundle(
    chia_sk: &SecretKey,
    coin: Coin,
    hint: Bytes32,
    ciphertext: Bytes,
) -> Result<SpendBundle> {
    let synthetic_sk: SecretKey = chia_sk.derive_synthetic();
    let synthetic_pk: PublicKey = synthetic_sk.public_key();
    let our_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();

    if coin.amount < PUBLISH_FEE {
        return Err(anyhow!("coin amount {} < fee {}", coin.amount, PUBLISH_FEE));
    }
    let out_amount = coin.amount - PUBLISH_FEE;

    let mut ctx = SpendContext::new();
    // MEMOS value = ( hint . ( ciphertext . () ) ) == proper list [hint, ciphertext].
    // The trailing `()` makes it a true 2-element list (not an improper cons pair).
    let memos = ctx
        .memos(&(hint, (ciphertext, ())))
        .map_err(|e| anyhow!("alloc memos: {e:?}"))?;
    let conditions = Conditions::new().create_coin(our_ph, out_amount, memos);
    StandardLayer::new(synthetic_pk)
        .spend(&mut ctx, coin, conditions)
        .map_err(|e| anyhow!("standard-layer spend: {e:?}"))?;
    let coin_spends: Vec<CoinSpend> = ctx.take();

    // Sign for testnet11: agg_sig_me additional data == testnet11 genesis challenge.
    let mut allocator = Allocator::new();
    let constants = AggSigConstants::from(&*TESTNET11_CONSTANTS);
    let required = RequiredSignature::from_coin_spends(&mut allocator, &coin_spends, &constants)
        .map_err(|e| anyhow!("required signatures: {e:?}"))?;
    let mut sigs: Vec<Signature> = Vec::new();
    for req in &required {
        match req {
            RequiredSignature::Bls(bls) => {
                // Standard-puzzle coins require the SYNTHETIC key; chia_bls::sign
                // augments with sk.public_key(), so sign with the synthetic sk.
                if bls.public_key != synthetic_pk {
                    return Err(anyhow!(
                        "spend requires an unexpected signer key {:?}",
                        bls.public_key
                    ));
                }
                sigs.push(sign(&synthetic_sk, bls.message()));
            }
            RequiredSignature::Secp(_) => {
                return Err(anyhow!("unexpected secp signature on a standard spend"));
            }
        }
    }
    let aggregated: Signature = aggregate(&sigs);
    Ok(SpendBundle::new(coin_spends, aggregated))
}

/// Full publish: seal the presence record, find our coin, spend-to-self with the
/// `[hint, ciphertext]` memos, and push to testnet11. Returns the published hint.
///
/// `iroh_sk` signs the record (identity); `chia_sk` pays (spends the coin).
/// `live_addrs` are the node's current direct addresses (F3 rule: live data).
pub async fn publish_presence(
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    room_key: &[u8; 32],
    live_addrs: &[String],
) -> Result<Bytes32> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // 1. Build + sign (iroh key) + seal (room key) the presence record — all the
    //    shipped, unit-tested chia_lane crypto.
    let record = ChiaPresenceRecord {
        v: 1,
        node_id: iroh_sk.public().to_string(),
        addrs: live_addrs.to_vec(),
        relay_urls: vec![],
        issued_at: now,
        expires_at: now + RECORD_TTL_SECS,
    };
    let blob = chia_lane::encode_signed(&record, iroh_sk)?;
    let sealed = chia_lane::seal(room_key, &blob)?;
    let hint = Bytes32::new(chia_lane::derive_hint(room_key, chia_lane::epoch_now(now)));
    let ciphertext = Bytes::new(sealed);

    // 2. Find our fundable coin (pays for the spend).
    let client = CoinsetClient::testnet11();
    let our_ph = our_puzzle_hash(chia_sk);
    let coin = find_spendable_coin(&client, our_ph)
        .await?
        .ok_or_else(|| anyhow!("chia wallet unfunded — no unspent coin at puzzle hash {our_ph}"))?;

    // 3. Build + sign the spend-to-self, then push to the mempool.
    let bundle = build_publish_bundle(chia_sk, coin, hint, ciphertext)?;
    let resp = client
        .push_tx(bundle)
        .await
        .map_err(|e| anyhow!("coinset push_tx failed: {e}"))?;
    if !resp.success {
        return Err(anyhow!("push_tx rejected: {:?}", resp.error));
    }
    Ok(hint)
}
