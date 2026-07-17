//! Chia wallet identity for the introduction lane (ChiaHub C1, SLICE 2).
//!
//! Behind the `chia-lane` Cargo feature ONLY — the default release binary never
//! links the BLS12-381 + clvm stack. This module owns the node's on-chain
//! identity: a persistent 32-byte seed, the BLS secret key minted from it, and
//! the `txch1…` testnet11 receive address printed at startup for faucet funding.
//!
//! Runtime is still gated by `SSF_CHIA_LANE=1` (the same switch the rest of the
//! lane uses), so a build that HAS the feature stays silent unless the operator
//! opts in.
//!
//! Every chia-wallet-sdk 0.34 symbol/path/signature below was source-verified
//! against the local registry crate source (B-7 API audit, "Surface A") — no
//! fabricated SDK calls. Versions: chia-wallet-sdk 0.34, chia-bls 0.36.1,
//! chia-puzzle-types 0.36.1, chia-protocol 0.36.1, chia-sdk-utils 0.34.
#![cfg(feature = "chia-lane")]

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

// --- Verified chia 0.34/0.36 surface (audit "Surface A"), imported from the
// SUB-CRATES directly (see Cargo.toml note — the umbrella crate overflows the
// Windows-GNU link). The umbrella's `prelude`/`chia::puzzle_types` re-exports map
// 1:1 to these paths.
use chia_bls::{PublicKey, SecretKey};
use chia_protocol::Bytes32;
// The DeriveSynthetic trait must be in scope for `pk.derive_synthetic()` to resolve.
use chia_puzzle_types::standard::StandardArgs;
use chia_puzzle_types::DeriveSynthetic;
use chia_sdk_utils::Address;

/// Testnet11 human-readable prefix (mainnet would be `"xch"`).
const TESTNET_PREFIX: &str = "txch";

/// Size of the persisted identity seed. `SecretKey::from_seed` asserts the seed
/// is at least 32 bytes; 32 is the minimum and all we need.
const SEED_LEN: usize = 32;

/// Load the node's persistent BLS identity, minting + persisting a fresh 32-byte
/// seed on first run.
///
/// We persist the SEED, not the serialized key: `SecretKey::from_seed` runs
/// EIP-2333 keygen (blst_keygen_v3), so the key is DERIVED from — not equal to —
/// the seed bytes. Re-running `from_seed` on the stored seed reproduces the exact
/// same key every boot, which is what makes this a stable node identity.
///
/// Mirrors the iroh key convention (`iroh_node_id.key`, a bare CWD-relative
/// path — see `load_or_create_secret_key` in main.rs).
pub fn load_or_mint_bls_key(path: &Path) -> Result<SecretKey> {
    let seed: [u8; SEED_LEN] = if path.exists() {
        let bytes = std::fs::read(path)
            .with_context(|| format!("reading chia identity seed {}", path.display()))?;
        // Refuse to silently re-mint over a wrong-length file — that would change
        // the node's on-chain identity and orphan any coins already funded to it.
        bytes.as_slice().try_into().map_err(|_| {
            anyhow!(
                "chia identity seed {} is {} bytes, expected {} — refusing to \
                 overwrite a corrupt identity file; move it aside to re-mint",
                path.display(),
                bytes.len(),
                SEED_LEN,
            )
        })?
    } else {
        // First run: mint a fresh seed from the OS CSPRNG (the same `OsRng` the
        // lane's `seal` nonce uses at chia_lane.rs:119) and persist it beside the
        // node data.
        let mut fresh = [0u8; SEED_LEN];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut fresh);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("creating chia identity dir {}", parent.display()))?;
            }
        }
        std::fs::write(path, fresh)
            .with_context(|| format!("writing chia identity seed {}", path.display()))?;
        // Best-effort lock-down of the secret file (no-op on Windows).
        restrict_permissions(path);
        fresh
    };

    // `from_seed` takes `&[u8]` and asserts len >= 32 (panics if shorter);
    // SEED_LEN guarantees the precondition. Key != seed bytes (EIP-2333).
    Ok(SecretKey::from_seed(&seed))
}

/// The `txch1…` standard-puzzle receive address for this key on testnet11.
///
/// Path: secret key -> public key -> synthetic public key
/// (DEFAULT_HIDDEN_PUZZLE_HASH) -> standard puzzle tree hash -> bech32m("txch").
///
/// This is the SELF-CUSTODY derivation: the synthetic key is taken straight off
/// the master key (no unhardened wallet index). Correct for a node that always
/// regenerates from its own seed and is funded by sending TXCH directly to this
/// printed address (faucet or another wallet) — funding works regardless of the
/// derivation path, because senders pay the exact address string we print. The
/// unhardened wallet-derivation path only matters for importing the SAME seed
/// into a GUI light wallet and seeing the funds there; the node never does that.
pub fn testnet_address(sk: &SecretKey) -> String {
    let pk: PublicKey = sk.public_key();
    let synthetic_pk: PublicKey = pk.derive_synthetic();
    // curry_tree_hash returns clvm_utils::TreeHash; From<TreeHash> for Bytes32.
    let puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
    Address::new(puzzle_hash, TESTNET_PREFIX.to_string())
        .encode()
        .expect("bech32m encode never fails for a 32-byte puzzle hash")
}

/// Reverse: `txch1…` -> standard puzzle hash (rejects a wrong/mainnet prefix).
/// Unused until the resolve slice consumes it; keep it as verified public API.
#[allow(dead_code)]
pub fn testnet_address_to_puzzle_hash(address: &str) -> Result<Bytes32> {
    Address::decode(address)
        .map_err(|e| anyhow!("not a valid bech32m address: {e:?}"))?
        .expect_prefix(TESTNET_PREFIX)
        .map_err(|e| anyhow!("address is not a testnet ({TESTNET_PREFIX}) address: {e:?}"))
}

/// Startup line (gated by `SSF_CHIA_LANE=1`): print the receive address so the
/// operator can fund it at the testnet11 faucet. TXCH only — no real XCH.
pub fn log_receive_address(sk: &SecretKey) {
    if std::env::var("SSF_CHIA_LANE").ok().as_deref() != Some("1") {
        return;
    }
    let addr = testnet_address(sk);
    println!(
        "⛓️ ChiaHub lane: testnet11 receive address {addr}\n   \
         Fund it at a testnet11 faucet (TXCH — no real XCH needed); \
         once it holds a coin, the lane can publish/resolve presence."
    );
}

// ── Slice 3: room-key plumbing (browser -> local node over the `cap` lane) ──

/// Per-room chia capability the LOCAL browser hands the node: the room key (so
/// the node can derive the room's lookup hint and seal presence records) and the
/// per-room chia-mode toggle (whether this room actually uses the introduction
/// lane — the "advanced chia mesh mode" switch). Trust-safe: loopback delivery,
/// and the node already holds the room's plaintext Yjs doc, so the key exposes
/// nothing new.
#[derive(Clone)]
pub struct ChiaRoomCap {
    pub room_key: [u8; 32],
    pub chia_mode: bool,
}

/// Wire shape of a `cap` envelope's JSON payload (browser camelCase).
#[derive(Deserialize)]
struct RoomCapPayload {
    #[serde(rename = "roomKeyB64")]
    room_key_b64: String,
    #[serde(rename = "chiaMode", default)]
    chia_mode: bool,
}

/// Decode a 32-byte room key from whatever base64 flavor the browser emits
/// (`getOrCreateRoomKeyB64` uses base64url-no-pad; be tolerant of all four).
fn decode_room_key(s: &str) -> Option<[u8; 32]> {
    use base64::Engine;
    let trimmed = s.trim();
    for eng in [
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::STANDARD_NO_PAD,
    ] {
        if let Ok(bytes) = eng.decode(trimmed) {
            if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Some(arr);
            }
        }
    }
    None
}

/// Pure parse of a `cap` payload into a [`ChiaRoomCap`] — the testable core of
/// [`ingest_room_cap`], with no env gate, storage, or logging. `None` on bad JSON
/// or a key that isn't 32 bytes of (any-flavor) base64.
fn parse_room_cap(payload: &[u8]) -> Option<ChiaRoomCap> {
    let parsed: RoomCapPayload = serde_json::from_slice(payload).ok()?;
    let room_key = decode_room_key(&parsed.room_key_b64)?;
    Some(ChiaRoomCap { room_key, chia_mode: parsed.chia_mode })
}

/// Ingest a `cap` payload the local browser sent for `room`: store the room key
/// + chia-mode flag, and log the REAL per-room lookup hint (proof the plumbing
/// works — this is the actual room key, not the C0 `[7u8;32]` self-test key).
/// No-op unless `SSF_CHIA_LANE=1` — so a chia-lane build that hasn't opted in
/// holds no room-key material.
pub fn ingest_room_cap(rooms: &Mutex<HashMap<String, ChiaRoomCap>>, room: &str, payload: &[u8]) {
    if std::env::var("SSF_CHIA_LANE").ok().as_deref() != Some("1") {
        return;
    }
    let cap = match parse_room_cap(payload) {
        Some(c) => c,
        None => {
            eprintln!("⛓️ ChiaHub lane: ignoring malformed room cap for {room}");
            return;
        }
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let hint = crate::chia_lane::derive_hint(&cap.room_key, crate::chia_lane::epoch_now(now));
    let chia_mode = cap.chia_mode;
    // Log only when something changed, so a re-sent cap on reconnect is quiet.
    let changed = {
        let mut map = rooms.lock().unwrap();
        match map.get(room) {
            Some(prev) if prev.room_key == cap.room_key && prev.chia_mode == cap.chia_mode => false,
            _ => {
                map.insert(room.to_string(), cap);
                true
            }
        }
    };
    if changed {
        println!(
            "⛓️ ChiaHub lane: room {room} key received (chia_mode={chia_mode}) · real epoch hint {}",
            hex::encode(&hint[..8]),
        );
    }
}

/// Tighten the seed file to owner-only on Unix; a no-op elsewhere (Windows ACLs
/// are inherited from the node-data dir). Best-effort — a failure here never
/// stops the node.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_persists_and_key_is_stable() {
        let dir = std::env::temp_dir().join(format!("ssf-chia-seed-{}", std::process::id()));
        let path = dir.join("chia_identity.seed");
        let _ = std::fs::remove_file(&path);

        let k1 = load_or_mint_bls_key(&path).unwrap();
        // Second load re-reads the SAME seed -> identical key + address.
        let k2 = load_or_mint_bls_key(&path).unwrap();
        assert_eq!(k1.public_key().to_bytes(), k2.public_key().to_bytes());
        assert_eq!(testnet_address(&k1), testnet_address(&k2));

        let addr = testnet_address(&k1);
        assert!(addr.starts_with("txch1"), "expected txch1… address, got {addr}");

        // Round-trip the address back to the same puzzle hash.
        let ph = testnet_address_to_puzzle_hash(&addr).unwrap();
        let expected: Bytes32 =
            StandardArgs::curry_tree_hash(k1.public_key().derive_synthetic()).into();
        assert_eq!(ph, expected);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn room_cap_parses_browser_base64url_and_mode() {
        use base64::Engine;
        // Exactly how the browser's toBase64Url emits the key: base64url, no pad.
        let key = [9u8; 32];
        let b64url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
        let payload = format!("{{\"roomKeyB64\":\"{b64url}\",\"chiaMode\":true}}");
        let cap = parse_room_cap(payload.as_bytes()).expect("valid cap parses");
        assert_eq!(cap.room_key, key);
        assert!(cap.chia_mode);
    }

    #[test]
    fn room_cap_defaults_mode_false_and_rejects_junk() {
        use base64::Engine;
        let key = [3u8; 32];
        let b64url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
        // chiaMode omitted -> defaults false.
        let payload = format!("{{\"roomKeyB64\":\"{b64url}\"}}");
        assert!(!parse_room_cap(payload.as_bytes()).expect("parses").chia_mode);
        // Junk / wrong-length key -> None (no panic, no store).
        assert!(parse_room_cap(b"not json at all").is_none());
        assert!(parse_room_cap(b"{\"roomKeyB64\":\"c2hvcnQ\"}").is_none());
    }
}
