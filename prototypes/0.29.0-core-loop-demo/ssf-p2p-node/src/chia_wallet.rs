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

use std::path::Path;

use anyhow::{anyhow, Context, Result};

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
}
