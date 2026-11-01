//! Chia wallet identity for the introduction lane (ChiaHub C1, SLICE 2).
//!
//! Behind the `chia-publish` Cargo feature ONLY — a read-only node (the default
//! build, #231 D3) never links the BLS12-381 stack and never mints a seed. This
//! module owns the node's on-chain identity: a persistent 32-byte seed, the BLS
//! secret key minted from it, and the `txch1…` testnet11 receive address printed
//! at startup for faucet funding.
//!
//! Runtime is gated at the CALLER (main.rs, by chia_wallet_switch.rs): a build
//! that HAS the feature keeps no seed file until the player turns the SSF
//! wallet on in the SpacePhone's Bank (or the operator starts the node with
//! `SSF_CHIA_LANE=1`). The per-room `cap` plumbing that used to live here is
//! read-side since D3 and moved to `chia_rooms`.
//!
//! Every chia-wallet-sdk 0.34 symbol/path/signature below was source-verified
//! against the local registry crate source (B-7 API audit, "Surface A") — no
//! fabricated SDK calls. Versions: chia-wallet-sdk 0.34, chia-bls 0.36.1,
//! chia-puzzle-types 0.36.1, chia-protocol 0.36.1, chia-sdk-utils 0.34.
#![cfg(feature = "chia-publish")]

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
    // `try_exists`, not `exists`: a seed that is there but cannot be looked at
    // (a permission error) is reported, never minted over.
    let present = path
        .try_exists()
        .with_context(|| format!("looking for chia identity seed {}", path.display()))?;
    let seed = if present { read_seed(path)? } else { mint_seed(path)? };
    // `from_seed` takes `&[u8]` and asserts len >= 32 (panics if shorter);
    // SEED_LEN guarantees the precondition. Key != seed bytes (EIP-2333).
    Ok(SecretKey::from_seed(&seed))
}

fn read_seed(path: &Path) -> Result<[u8; SEED_LEN]> {
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
    })
}

/// First run: mint a fresh seed from the OS CSPRNG (the same `OsRng` the
/// lane's `seal` nonce uses) and persist it so that it is never torn and never
/// minted twice. Since the SpacePhone's Bank can turn the wallet on at any
/// moment of a run (chia_wallet_switch.rs), not only at startup, the seed may
/// be written while the app is about to stop the node, or while a second tap
/// asks for the same thing.
///
/// The bytes go to a temporary file first (created new, owner-only on Unix,
/// synced), which is then hard-linked to the seed's name. A link never
/// replaces an existing file: when two minters race, the second finds the
/// first one's seed and loads that, so nobody holds a key whose seed is gone
/// (its address shown, funded, and orphaned at the next start). A folder
/// whose filesystem cannot hard-link (exFAT, FAT) gets no seed at all: writing
/// the seed's own name directly would show a half-written seed to a racing
/// minter, and a stop mid-write would leave a short one, so the mint fails
/// closed and says to run the node from a folder on the system drive.
fn mint_seed(path: &Path) -> Result<[u8; SEED_LEN]> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut fresh = [0u8; SEED_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut fresh);
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating chia identity dir {}", dir.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "seed".to_string());
    let tmp = dir.join(format!(".{name}.{}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    write_new(&tmp, &fresh).with_context(|| format!("writing chia identity seed {}", tmp.display()))?;
    let linked = std::fs::hard_link(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => {}
        // Another minter's seed got there first: it is the identity.
        Err(e) if e.kind() == ErrorKind::AlreadyExists => return read_seed(path),
        Err(e) => {
            return Err(e).with_context(|| {
                format!(
                    "installing chia identity seed {} (this folder's filesystem may not hard-link files, \
                     as exFAT and FAT cannot; run the node from a folder on the system drive)",
                    path.display()
                )
            })
        }
    }
    // Best-effort lock-down of the secret file (no-op on Windows).
    restrict_permissions(path);
    // The new name is directory metadata: sync it so a power loss right after
    // cannot lose the seed of a wallet whose address is about to be shown. A
    // failed sync fails the mint, as in `chia_contact::write_private`: no
    // address is shown for a seed that may not survive, and the next attempt
    // loads the seed now on disk. Windows has no directory handle to sync;
    // NTFS journals the link.
    #[cfg(unix)]
    std::fs::File::open(&dir).and_then(|d| d.sync_all()).with_context(|| {
        format!("syncing chia identity dir {} (the seed is written; turning the wallet on again loads it)", dir.display())
    })?;
    Ok(fresh)
}

/// Create `at` (never over an existing file), write `bytes` and sync them; a
/// file this call created and could not fill is removed again, so no short
/// seed is left for the next start to refuse.
fn write_new(at: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(at)?;
    let written = f.write_all(bytes).and_then(|()| f.sync_all());
    if written.is_err() {
        drop(f);
        let _ = std::fs::remove_file(at);
    }
    written
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

/// Printed when the wallet loads (at startup, or when the Bank turns it on):
/// the receive address, so the operator can fund it at a testnet11 faucet.
/// TXCH only.
pub fn log_receive_address(sk: &SecretKey) {
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

    fn fresh_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ssf-chia-seed-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 🏦 Two taps in the Bank, or two tabs, may ask for the wallet at once:
    /// every minter ends up with the one seed on disk, never a key of its own
    /// whose seed another minter's write replaced.
    #[test]
    fn minters_racing_for_one_seed_all_load_the_seed_on_disk() {
        let dir = fresh_dir("race");
        let path = dir.join("chia_identity.seed");
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let keys: Vec<[u8; 48]> = (0..8)
            .map(|_| {
                let (path, start) = (path.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    load_or_mint_bls_key(&path).unwrap().public_key().to_bytes()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        let on_disk = load_or_mint_bls_key(&path).unwrap().public_key().to_bytes();
        assert!(keys.iter().all(|k| *k == on_disk), "every minter holds the seed that stayed");
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("chia_identity.seed")], "no temporary file left behind");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the seed is owner-only from the moment it exists");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_seed_of_the_wrong_length_is_refused_and_left_alone() {
        let dir = fresh_dir("short");
        let path = dir.join("chia_identity.seed");
        std::fs::write(&path, [7u8; 5]).unwrap();
        let err = format!("{:#}", load_or_mint_bls_key(&path).unwrap_err());
        assert!(err.contains("refusing to overwrite"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), vec![7u8; 5], "the file is left for recovery");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
