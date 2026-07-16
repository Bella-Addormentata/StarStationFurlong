//! ChiaHub lane scaffold — C0/C1 groundwork per REVIEW-20260710-ChiaHub.md.
//!
//! What this module IS (0.18.0): the chain-independent half of the lane —
//! record types, canonical signing, room-key-derived encryption + epoch-rotated
//! lookup hints, and a startup self-test. All of it runs and is unit-tested
//! without touching a network.
//!
//! What this module IS NOT yet: chain IO. Publishing (spend-to-self with
//! `[hint, ciphertext]` memos) and resolving (lookup-by-hint) land in C1,
//! AFTER spike B-7 verifies the exact chia-wallet-sdk API surface — no
//! fabricated SDK calls ship here.
//!
//! [C0-VERIFY] items owned by B-7 (see ChiaHub review §9):
//!   1. memo attachment on spend construction (exact API)
//!   2. lookup-by-hint query surface (light-wallet vs full-node RPC)
//!   3. dust threshold + minimum fee for reliable mempool acceptance
//!   4. mempool subscription surface for the ~5s fast path
//! [C1-DESIGN] room-key plumbing: the node currently never sees room KEYS
//!   (only room ids — keys live in browser tickets). C1 must either pass
//!   `roomKeyB64` node-ward in a `cap`-style envelope or manage room keys
//!   node-side. Decide alongside the S2 challenge work, which has the same
//!   need.

use anyhow::{anyhow, Result};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

/// A member's presence record — the plaintext that gets signed, sealed, and
/// (in C1) published as coin-spend memos. Addresses come from the LIVE
/// endpoint view (v0.17.0 F3 rule: hints are live data, not constants).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ChiaPresenceRecord {
    pub v: u32,
    pub node_id: String,
    pub addrs: Vec<String>,
    pub relay_urls: Vec<String>,
    /// Unix seconds. `expires_at` is advisory — the chain cannot delete, so
    /// readers enforce freshness; writers heartbeat (~30–60 min) and on change.
    pub issued_at: u64,
    pub expires_at: u64,
}

/// Signed wrapper as serialized inside the ciphertext.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SignedRecord {
    /// Canonical JSON bytes of [`ChiaPresenceRecord`], base64.
    pub record_b64: String,
    /// ed25519 signature by the record's `node_id` key, hex.
    pub sig_hex: String,
}

/// Domain-separated key derivations — "the room is the key" extended to the
/// chain (ChiaHub review §3.2). Contexts are versioned; bumping them is a
/// lane-wide epoch break by design.
const CTX_ENC: &str = "ssf-chia-lane-enc-v1";
const CTX_HINT: &str = "ssf-chia-lane-hint-v1";

pub fn derive_enc_key(room_key: &[u8]) -> [u8; 32] {
    blake3::derive_key(CTX_ENC, room_key)
}

/// Epoch = UTC day number. Readers scan `epoch` and `epoch - 1` so records
/// straddling midnight stay findable; daily rotation stops a passive observer
/// who learned one day's hint from following the room forever.
pub fn epoch_now(unix_seconds: u64) -> u64 {
    unix_seconds / 86_400
}

/// 32-byte lookup hint for a room + epoch: what C1 puts first in the memo
/// list (ecosystem hint convention) and queries by.
pub fn derive_hint(room_key: &[u8], epoch: u64) -> [u8; 32] {
    let mut material = Vec::with_capacity(room_key.len() + 8);
    material.extend_from_slice(room_key);
    material.extend_from_slice(&epoch.to_le_bytes());
    blake3::derive_key(CTX_HINT, &material)
}

/// Sign a presence record with the node's iroh key and produce the plaintext
/// blob that gets sealed. (Same ed25519 identity as the swarm — one keypair.)
pub fn encode_signed(record: &ChiaPresenceRecord, secret: &iroh::SecretKey) -> Result<Vec<u8>> {
    let record_json = serde_json::to_vec(record)?;
    let sig = secret.sign(&record_json);
    let wrapper = SignedRecord {
        record_b64: base64::Engine::encode(&base64::prelude::BASE64_STANDARD, &record_json),
        sig_hex: hex::encode(sig.to_bytes()),
    };
    Ok(serde_json::to_vec(&wrapper)?)
}

/// Verify + decode the plaintext blob back into a record. Records signed by
/// keys the reader doesn't recognize as room members are the caller's problem
/// to filter — signature validity alone is not membership.
pub fn decode_signed(blob: &[u8]) -> Result<ChiaPresenceRecord> {
    let wrapper: SignedRecord = serde_json::from_slice(blob)?;
    let record_json = base64::Engine::decode(&base64::prelude::BASE64_STANDARD, &wrapper.record_b64)?;
    let record: ChiaPresenceRecord = serde_json::from_slice(&record_json)?;
    let public: iroh::PublicKey = record
        .node_id
        .parse()
        .map_err(|e| anyhow!("record node_id is not a valid iroh key: {e:?}"))?;
    let sig_bytes: [u8; 64] = hex::decode(&wrapper.sig_hex)?
        .try_into()
        .map_err(|_| anyhow!("signature is not 64 bytes"))?;
    let sig = iroh::Signature::from_bytes(&sig_bytes);
    public
        .verify(&record_json, &sig)
        .map_err(|e| anyhow!("record signature invalid: {e:?}"))?;
    Ok(record)
}

/// Seal a signed blob for the chain: `[24B XNonce ‖ XChaCha20-Poly1305 ciphertext]`.
/// Only room-key holders can read — an unreadable record stays meaningless
/// even though the chain keeps it forever (ChiaHub review §7 rule 1).
pub fn seal(room_key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let key = derive_enc_key(room_key);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|e| anyhow!("seal failed: {e:?}"))?;
    let mut out = Vec::with_capacity(24 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn open(room_key: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < 24 {
        return Err(anyhow!("sealed blob too short"));
    }
    let key = derive_enc_key(room_key);
    let cipher = XChaCha20Poly1305::new((&key).into());
    cipher
        .decrypt(XNonce::from_slice(&sealed[..24]), &sealed[24..])
        .map_err(|e| anyhow!("open failed (wrong room key?): {e:?}"))
}

/// Startup self-test + status line. Proves the lane's crypto machinery on a
/// throwaway key so `SSF_CHIA_LANE=1` users see exactly where the lane stands.
pub fn startup_status(secret: &iroh::SecretKey, live_addrs: &[String]) {
    if std::env::var("SSF_CHIA_LANE").ok().as_deref() != Some("1") {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let test_room_key = [7u8; 32];
    let record = ChiaPresenceRecord {
        v: 1,
        node_id: secret.public().to_string(),
        addrs: live_addrs.to_vec(),
        relay_urls: vec![],
        issued_at: now,
        expires_at: now + 3600,
    };
    let ok = encode_signed(&record, secret)
        .and_then(|blob| seal(&test_room_key, &blob))
        .and_then(|sealed| open(&test_room_key, &sealed))
        .and_then(|blob| decode_signed(&blob))
        .map(|round| round == record)
        .unwrap_or(false);
    let hint = derive_hint(&test_room_key, epoch_now(now));
    println!(
        "⛓️ ChiaHub lane SCAFFOLD (C0): crypto self-test {} · sample epoch hint {} · chain IO lands in C1 after spike B-7 (testnet11 first — faucet TXCH, no real XCH needed)",
        if ok { "PASSED" } else { "FAILED" },
        hex::encode(&hint[..8]),
    );
}
// [C1-HOOK realized in Slice 5b] The dial-exhaustion resolve now lives in
// `chia_resolve` (room-key-keyed, per the [C1-DESIGN] resolution: the node holds
// the room key via Slice 3's `cap` lane, and filters resolved records by the
// target node-id). `dial_peer_inner` calls `chia_resolve::resolve_target` and
// feeds the public addrs into one more node-id-authenticated dial.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_roundtrip_sign_seal_open_verify() {
        let secret = iroh::SecretKey::generate();
        let room_key = [42u8; 32];
        let record = ChiaPresenceRecord {
            v: 1,
            node_id: secret.public().to_string(),
            addrs: vec!["192.0.2.1:4444".into(), "[2001:db8::1]:4445".into()],
            relay_urls: vec![],
            issued_at: 1_783_600_000,
            expires_at: 1_783_603_600,
        };
        let blob = encode_signed(&record, &secret).unwrap();
        let sealed = seal(&room_key, &blob).unwrap();
        let opened = open(&room_key, &sealed).unwrap();
        let decoded = decode_signed(&opened).unwrap();
        assert_eq!(decoded, record);
    }

    #[test]
    fn wrong_room_key_cannot_open() {
        let secret = iroh::SecretKey::generate();
        let record = ChiaPresenceRecord {
            v: 1,
            node_id: secret.public().to_string(),
            addrs: vec![],
            relay_urls: vec![],
            issued_at: 0,
            expires_at: 0,
        };
        let blob = encode_signed(&record, &secret).unwrap();
        let sealed = seal(&[1u8; 32], &blob).unwrap();
        assert!(open(&[2u8; 32], &sealed).is_err());
    }

    #[test]
    fn tampered_record_fails_signature() {
        let secret = iroh::SecretKey::generate();
        let record = ChiaPresenceRecord {
            v: 1,
            node_id: secret.public().to_string(),
            addrs: vec!["192.0.2.1:4444".into()],
            relay_urls: vec![],
            issued_at: 10,
            expires_at: 20,
        };
        let blob = encode_signed(&record, &secret).unwrap();
        let mut wrapper: SignedRecord = serde_json::from_slice(&blob).unwrap();
        // Swap in a different record body, keep the old signature.
        let forged = ChiaPresenceRecord { addrs: vec!["203.0.113.9:1".into()], ..record };
        wrapper.record_b64 =
            base64::Engine::encode(&base64::prelude::BASE64_STANDARD, serde_json::to_vec(&forged).unwrap());
        let forged_blob = serde_json::to_vec(&wrapper).unwrap();
        assert!(decode_signed(&forged_blob).is_err());
    }

    #[test]
    fn hints_rotate_by_epoch_and_room() {
        let room_a = [1u8; 32];
        let room_b = [2u8; 32];
        assert_ne!(derive_hint(&room_a, 100), derive_hint(&room_a, 101));
        assert_ne!(derive_hint(&room_a, 100), derive_hint(&room_b, 100));
        assert_eq!(derive_hint(&room_a, 100), derive_hint(&room_a, 100));
    }
}
