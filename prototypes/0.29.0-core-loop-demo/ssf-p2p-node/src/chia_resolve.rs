//! ChiaHub C1 Slice 5: RESOLVE a peer's presence record from testnet11 by the
//! room-derived hint — the READ side of mesh introduction ("identity known,
//! route unknown"), consulted only at dial-exhaustion.
//!
//! Flow (all source-verified 0.34 API, audit surfaces D + E):
//!   derive_hint -> get_coin_records_by_hint -> get_puzzle_and_solution on the
//!   PARENT coin -> run_puzzle -> pull the create_coin `[hint, ciphertext]`
//!   memos -> chia_lane::open (room key) -> decode_signed -> ChiaPresenceRecord.
//!
//! The chain is the swarm's address book + metronome, never its pipe: this reads
//! at ~19 s block latency and hands the record's addrs into exactly one more dial.
#![cfg(feature = "chia-lane")]

use anyhow::{anyhow, Result};
use chia_protocol::{Bytes, Bytes32, CoinSpend};
use chia_puzzle_types::Memos;
use chia_sdk_coinset::{ChiaRpcClient, CoinsetClient};
use chia_sdk_types::{run_puzzle, Conditions};
use clvm_traits::{FromClvm, ToClvm};
use clvmr::{Allocator, NodePtr};

use crate::chia_lane::{self, ChiaPresenceRecord};

/// Resolve the freshest presence record published under `room_key` (any member).
pub async fn resolve_by_room_key(room_key: &[u8; 32]) -> Result<Option<ChiaPresenceRecord>> {
    resolve_inner(room_key, None).await
}

/// Resolve the freshest record for a SPECIFIC peer (`target_node_id`, the iroh
/// node-id hex) under `room_key` — the introduction lookup at dial-exhaustion.
pub async fn resolve_target(
    room_key: &[u8; 32],
    target_node_id: &str,
) -> Result<Option<ChiaPresenceRecord>> {
    resolve_inner(room_key, Some(target_node_id)).await
}

/// Scans the current epoch and the previous one (records straddling midnight stay
/// found), verifies signature + freshness, and returns the first matching record.
async fn resolve_inner(
    room_key: &[u8; 32],
    target: Option<&str>,
) -> Result<Option<ChiaPresenceRecord>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let client = CoinsetClient::testnet11();
    let epoch = chia_lane::epoch_now(now);
    for e in [epoch, epoch.saturating_sub(1)] {
        let hint = Bytes32::new(chia_lane::derive_hint(room_key, e));
        if let Some(rec) = resolve_one_hint(&client, hint, room_key, now, target).await? {
            return Ok(Some(rec));
        }
    }
    Ok(None)
}

async fn resolve_one_hint(
    client: &CoinsetClient,
    hint: Bytes32,
    room_key: &[u8; 32],
    now: u64,
    target: Option<&str>,
) -> Result<Option<ChiaPresenceRecord>> {
    let resp = client
        .get_coin_records_by_hint(hint, None, None, Some(true), None)
        .await
        .map_err(|e| anyhow!("get_coin_records_by_hint: {e}"))?;
    if !resp.success {
        return Err(anyhow!("hint lookup unsuccessful: {:?}", resp.error));
    }
    let mut records = resp.coin_records.unwrap_or_default();
    // Newest first — take the latest presence a member published.
    records.sort_by_key(|r| std::cmp::Reverse(r.confirmed_block_index));
    for rec in records {
        let coin = rec.coin;
        // The memos live in the PARENT's spend (the create_coin that made this coin).
        let parent_spend =
            match fetch_coin_spend(client, coin.parent_coin_info, rec.confirmed_block_index).await? {
                Some(cs) => cs,
                None => continue,
            };
        let ciphertext = match extract_ciphertext(&parent_spend, hint)? {
            Some(ct) => ct,
            None => continue,
        };
        // Decrypt with the room key, verify the self-signature, enforce freshness.
        let blob = match chia_lane::open(room_key, &ciphertext) {
            Ok(b) => b,
            Err(_) => continue, // wrong room key / not for us
        };
        let record = match chia_lane::decode_signed(&blob) {
            Ok(r) => r,
            Err(_) => continue, // tampered / bad signature
        };
        // Introduction wants a SPECIFIC peer — skip other members' records.
        if let Some(want) = target {
            if record.node_id != want {
                continue;
            }
        }
        if record.expires_at != 0 && record.expires_at < now {
            continue; // stale — a newer heartbeat should exist
        }
        return Ok(Some(record));
    }
    Ok(None)
}

pub(crate) async fn fetch_coin_spend(
    client: &CoinsetClient,
    coin_id: Bytes32,
    height: u32,
) -> Result<Option<CoinSpend>> {
    let resp = client
        .get_puzzle_and_solution(coin_id, Some(height))
        .await
        .map_err(|e| anyhow!("get_puzzle_and_solution: {e}"))?;
    if !resp.success {
        return Ok(None);
    }
    Ok(resp.coin_solution)
}

/// Run the parent spend and return the ciphertext (2nd memo) of the create_coin
/// whose FIRST memo is our `hint` — the ecosystem hint convention we published with.
pub(crate) fn extract_ciphertext(coin_spend: &CoinSpend, hint: Bytes32) -> Result<Option<Vec<u8>>> {
    let mut allocator = Allocator::new();
    let puzzle: NodePtr = coin_spend
        .puzzle_reveal
        .to_clvm(&mut allocator)
        .map_err(|e| anyhow!("puzzle_reveal to_clvm: {e:?}"))?;
    let solution: NodePtr = coin_spend
        .solution
        .to_clvm(&mut allocator)
        .map_err(|e| anyhow!("solution to_clvm: {e:?}"))?;
    let output = run_puzzle(&mut allocator, puzzle, solution)
        .map_err(|e| anyhow!("run_puzzle: {e:?}"))?;
    let conditions = Conditions::<NodePtr>::from_clvm(&allocator, output)
        .map_err(|e| anyhow!("conditions from_clvm: {e:?}"))?;
    for condition in conditions {
        let Some(create_coin) = condition.into_create_coin() else {
            continue;
        };
        let memos_ptr = match create_coin.memos {
            Memos::Some(ptr) => ptr,
            Memos::None => continue,
        };
        let memos = match Vec::<Bytes>::from_clvm(&allocator, memos_ptr) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if memos.len() >= 2 && memos[0].as_ref() == hint.as_ref() {
            return Ok(Some(memos[1].clone().into_inner()));
        }
    }
    Ok(None)
}
