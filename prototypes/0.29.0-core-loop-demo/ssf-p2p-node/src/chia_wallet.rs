//! 🏦 The SSF wallet's identity: 24 words (ChiaHub C1, SLICE 2; the 24-word
//! wallet since #352's follow-up).
//!
//! Behind the `chia-publish` Cargo feature ONLY — a read-only node (the default
//! build, #231 D3) never links the BLS12-381 stack and never mints a wallet.
//!
//! The node's on-chain identity is 32 bytes of BIP39 entropy, kept in
//! `chia_identity.json` beside the node (its CWD, the per-user data folder).
//! They make 24 English words, and the keys come from the words the way Chia
//! and Sage derive them: the empty-passphrase BIP39 seed, Chia's KeyGen for
//! the master key, then m/12381/8444/2/0 unhardened for the WALLET key. The
//! wallet key is the one every spend site is handed, so the node's `txch1…`
//! address is the first address `chia keys show` and Sage give for the same
//! words, and the key fingerprint the Bank shows is the number they print.
//!
//! The words are never written anywhere and never printed: the Bank shows
//! them, until the player marks them saved, from the identity file read again
//! each time (main.rs, `POST /api/chia/words`). The node keeps no copy of the
//! entropy or the words, only the derived wallet key.
//!
//! A node from before the words kept a raw 32-byte seed in
//! `chia_identity.seed`. No words reproduce its key, so turning such a wallet
//! on mints fresh entropy, and the raw seed is archived as
//! `chia_identity.seed.retired-<unix>` (its testnet coins stay at its old
//! address, which the log names).
//!
//! Runtime is gated at the CALLER (main.rs, by chia_wallet_switch.rs): a build
//! that HAS the feature keeps no identity file until the player turns the SSF
//! wallet on in the SpacePhone's Bank (or the operator starts the node with
//! `SSF_CHIA_LANE=1`). The per-room `cap` plumbing that used to live here is
//! read-side since D3 and moved to `chia_rooms`.
//!
//! Every chia-wallet-sdk 0.34 symbol/path/signature below was source-verified
//! against the local registry crate source (B-7 API audit, "Surface A") — no
//! fabricated SDK calls. Versions: chia-wallet-sdk 0.34, chia-bls 0.36.1,
//! chia-puzzle-types 0.36.1, chia-protocol 0.36.1, chia-sdk-utils 0.34,
//! bip39 2.2.2 (with `zeroize`).
#![cfg(feature = "chia-publish")]

use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{anyhow, Context, Result};
use bip39::Mnemonic;

// --- Verified chia 0.34/0.36 surface (audit "Surface A"), imported from the
// SUB-CRATES directly (see Cargo.toml note — the umbrella crate overflows the
// Windows-GNU link). The umbrella's `prelude`/`chia::puzzle_types` re-exports map
// 1:1 to these paths.
use chia_bls::{master_to_wallet_unhardened, PublicKey, SecretKey};
use chia_protocol::Bytes32;
// The DeriveSynthetic trait must be in scope for `pk.derive_synthetic()` to resolve.
use chia_puzzle_types::standard::StandardArgs;
use chia_puzzle_types::DeriveSynthetic;
use chia_sdk_utils::Address;
use serde::Deserialize;
use zeroize::Zeroizing;

/// Testnet11 human-readable prefix (mainnet would be `"xch"`).
const TESTNET_PREFIX: &str = "txch";

/// The identity file's format, and the one `kind` and `protect` this node
/// reads. The at-rest PR adds other `protect` values (with a `blob` in place
/// of `entropy`); this node refuses them rather than minting over them.
const IDENTITY_V: u64 = 1;
const IDENTITY_KIND: &str = "bip39-english";
const PROTECT_NONE: &str = "none";

/// Bytes of BIP39 entropy in the identity: 24 words.
const ENTROPY_LEN: usize = 32;

/// The largest identity file the reader takes; anything longer is damaged.
/// Also the most of a legacy seed file read to compare it with its archives.
const FILE_MAX: usize = 4096;

/// Names tried for one archive of a legacy seed (`-<unix>`, `-<unix>-2`, …).
const RETIRE_ATTEMPTS: u32 = 16;

/// A temporary file younger than this may be a write in flight, whoever's;
/// an older one is from a write that stopped.
const TMP_IN_FLIGHT: std::time::Duration = std::time::Duration::from_secs(60);
/// How many temporary names a mint tries before it gives up (see
/// [`install_once_with`]).
const TMP_NAME_ATTEMPTS: u32 = 16;

/// Chia's keys for one set of words: the wallet key (m/12381/8444/2/0,
/// unhardened) and the master public key's fingerprint.
pub(crate) struct ChiaKeys {
    pub wallet: SecretKey,
    pub fingerprint: u32,
}

/// Fingerprint only: `SecretKey`'s own Debug prints the key.
impl fmt::Debug for ChiaKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChiaKeys").field("fingerprint", &self.fingerprint).finish_non_exhaustive()
    }
}

/// The master key for a BIP39 mnemonic, the way Chia derives it: the
/// empty-passphrase BIP39 seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt
/// "mnemonic"), then Chia's KeyGen (`blst_keygen_v3` with no salt override).
/// `to_seed_normalized("")` gives the same bytes as `to_seed("")`, and needs
/// no unicode normalisation for an empty passphrase.
pub(crate) fn master_of(m: &Mnemonic) -> SecretKey {
    let seed = Zeroizing::new(m.to_seed_normalized(""));
    SecretKey::from_seed(&seed[..])
}

/// Chia's keys for a BIP39 mnemonic, the way Chia and Sage derive them:
/// master ([`master_of`]) -> m/12381/8444/2/0 unhardened. The synthetic key
/// of `wallet` is the first address `chia keys show` and Sage give for the
/// same words; the fingerprint is the number they print for them.
pub(crate) fn keys_from_mnemonic(m: &Mnemonic) -> ChiaKeys {
    let master = master_of(m);
    let fingerprint = master.public_key().get_fingerprint();
    let wallet = master_to_wallet_unhardened(&master, 0);
    ChiaKeys { wallet, fingerprint }
}

/// Chia's keys for 32 bytes of entropy (24 words). The mnemonic wipes its
/// word indices when dropped (bip39's `zeroize` feature).
pub(crate) fn keys_from_entropy(entropy: &[u8; ENTROPY_LEN]) -> ChiaKeys {
    let m = Mnemonic::from_entropy(&entropy[..]).expect("32 bytes of entropy always make 24 words");
    keys_from_mnemonic(&m)
}

/// The node's wallet as one load gives it: the wallet key every spend site is
/// handed, the fingerprint of the words it comes from, and what this load did.
pub struct WalletIdentity {
    /// m/12381/8444/2/0, unhardened.
    pub wallet: SecretKey,
    /// The master public key's fingerprint (what Sage and `chia keys show` print).
    pub fingerprint: u32,
    /// This load created `chia_identity.json`.
    pub minted: bool,
    /// This load archived a legacy raw seed.
    pub retired: Option<RetiredSeed>,
}

/// Fingerprint and what the load did; never the key.
impl fmt::Debug for WalletIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WalletIdentity")
            .field("fingerprint", &self.fingerprint)
            .field("minted", &self.minted)
            .field("retired", &self.retired)
            .finish_non_exhaustive()
    }
}

/// A legacy `chia_identity.seed` this load archived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredSeed {
    /// The archive's name (`chia_identity.seed.retired-<unix>[-n]`).
    pub archived_as: PathBuf,
    /// The old wallet's address, when the file was a 32-byte seed.
    pub old_address: Option<String>,
    /// The old beacon wallet's address (D7: derived from the old key), for
    /// an operator whose beacon was on.
    pub old_beacon: Option<String>,
}

/// The 24 words of the identity on disk, read again for the Bank's reveal.
/// The mnemonic wipes its word indices when dropped; nothing else here holds
/// a word.
pub struct Revealed {
    mnemonic: Mnemonic,
    /// The fingerprint the words make.
    pub fingerprint: u32,
    /// The wallet public key the words make, to compare with the loaded one.
    pub wallet: PublicKey,
}

impl Revealed {
    /// The words, in order.
    pub fn words(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.mnemonic.words()
    }
}

/// Fingerprint only: never the words.
impl fmt::Debug for Revealed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Revealed").field("fingerprint", &self.fingerprint).finish_non_exhaustive()
    }
}

/// Load the node's wallet from `identity` (`chia_identity.json`), minting it
/// once when there is none, and retire a legacy raw seed at `legacy`
/// (`chia_identity.seed`) once the identity is durable.
///
/// Before reading or minting, temporary files a stopped mint left beside the
/// identity are removed: one can hold the entropy (or a raw seed), and the
/// at-rest PR's re-wrap would not reach it.
///
/// A file that is there and cannot be read is reported and never minted
/// over; see [`read_identity`]'s refusals.
pub fn load_or_mint_wallet(identity: &Path, legacy: &Path) -> Result<WalletIdentity> {
    sweep_stale_tmp(&[identity, legacy]);
    // `try_exists`, not `exists`: an identity that is there but cannot be
    // looked at (a permission error) is reported, never minted over.
    let present = identity
        .try_exists()
        .with_context(|| format!("looking for chia identity file {}", identity.display()))?;
    let (entropy, keys, minted) = if present {
        let (entropy, keys) = read_identity(identity)?;
        // Owner-only again, for a copy the operator put back (from a zip, a
        // cloud folder, a FAT stick) with the modes it picked up there.
        restrict_permissions(identity);
        (entropy, keys, false)
    } else {
        mint_identity(identity)?
    };
    drop(entropy);
    // Only now, with the identity durable (installed and its directory
    // synced, or already there), is the raw seed archived.
    let retired = retire_legacy_seed(legacy, unix_now()).unwrap_or_else(|e| {
        eprintln!(
            "🏦 SSF wallet: could not retire the old {} ({e:#}); it is left as it is and is not this wallet",
            legacy.display()
        );
        None
    });
    Ok(WalletIdentity { wallet: keys.wallet, fingerprint: keys.fingerprint, minted, retired })
}

/// For the Bank's reveal only: the 24 words of the identity on disk, read
/// again (the node keeps no copy), with the fingerprint and wallet key they
/// make so the caller can check they are the wallet in use.
pub fn reveal_words(identity: &Path) -> Result<Revealed> {
    let (entropy, keys) = read_identity(identity)?;
    let mnemonic = Mnemonic::from_entropy(&entropy[..])
        .map_err(|_| anyhow!("the identity's entropy does not make words"))?;
    if mnemonic.word_count() != 24 {
        return Err(anyhow!("the identity does not make 24 words"));
    }
    Ok(Revealed { mnemonic, fingerprint: keys.fingerprint, wallet: keys.wallet.public_key() })
}

/// The reveal's 200 body, `{"ok":true,"words":[…24],"key":N,"address":"txch1…"}`,
/// built by hand into a buffer that is wiped when dropped (never through
/// `serde_json::Value`, which would leave copies behind). The words are a–z
/// only, from the wordlist, so they need no escaping.
pub fn reveal_body(rev: &Revealed, address: &str) -> Zeroizing<String> {
    // Room for every word at its longest, so the buffer never reallocates
    // (a reallocation would leave the old buffer unwiped).
    let address = serde_json::to_string(address).expect("a string always serializes");
    let mut out = Zeroizing::new(String::with_capacity(64 + 24 * 11 + address.len()));
    out.push_str(r#"{"ok":true,"words":["#);
    for (i, word) in rev.words().enumerate() {
        debug_assert!(word.bytes().all(|b| b.is_ascii_lowercase()));
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(word);
        out.push('"');
    }
    out.push_str(r#"],"key":"#);
    out.push_str(&rev.fingerprint.to_string());
    out.push_str(r#","address":"#);
    out.push_str(&address);
    out.push('}');
    out
}

/// The identity file's header: read first, alone, so a newer file (another
/// `protect`, a `blob` in place of `entropy`) is told apart from a damaged
/// one before anything else is asked of it.
#[derive(Deserialize)]
struct IdentityHeader<'a> {
    v: u64,
    #[serde(borrow, default)]
    kind: Option<&'a str>,
    #[serde(borrow, default)]
    protect: Option<&'a str>,
}

/// The v1 body (`protect:"none"`). Borrowed from the read buffer, so the
/// entropy's hex is never copied out of it.
#[derive(Deserialize)]
struct IdentityV1<'a> {
    #[serde(borrow)]
    entropy: &'a str,
    fingerprint: u32,
}

/// Read and check the identity file: the only read site.
///
/// The file is read into a buffer that is wiped when dropped, parsed in two
/// steps (the header, then the v1 body), its entropy decoded into another
/// wiped buffer, and the keys derived again: the fingerprint written beside
/// the entropy must match, since the entropy carries no checksum of its own.
///
/// Every refusal is a fixed sentence built fresh, with no source error under
/// it: serde and hex errors can quote the bytes they choked on (a piece of
/// the entropy), and `{e:#}` prints a whole chain. A refused file is left as
/// it is, and nothing is minted over it.
fn read_identity(path: &Path) -> Result<(Zeroizing<[u8; ENTROPY_LEN]>, ChiaKeys)> {
    let damaged = || {
        anyhow!(
            "chia identity file {} is damaged — refusing to overwrite a corrupt identity file; move it aside to re-mint",
            path.display()
        )
    };
    let newer = || {
        anyhow!(
            "chia identity file {} was written by a newer Star Station, in a form this node cannot read; \
             it will not replace it: update Star Station",
            path.display()
        )
    };
    let buf = read_capped(path, FILE_MAX)
        .map_err(|e| anyhow!("reading chia identity file {} ({e})", path.display()))?
        .ok_or_else(damaged)?;
    let header: IdentityHeader = serde_json::from_slice(&buf).map_err(|_| damaged())?;
    if header.v != IDENTITY_V {
        return Err(newer());
    }
    let (Some(kind), Some(protect)) = (header.kind, header.protect) else {
        return Err(damaged());
    };
    if kind != IDENTITY_KIND || protect != PROTECT_NONE {
        return Err(newer());
    }
    let body: IdentityV1 = serde_json::from_slice(&buf).map_err(|_| damaged())?;
    if body.entropy.len() != 2 * ENTROPY_LEN {
        return Err(damaged());
    }
    let mut entropy = Zeroizing::new([0u8; ENTROPY_LEN]);
    hex::decode_to_slice(body.entropy, &mut entropy[..]).map_err(|_| damaged())?;
    let keys = keys_from_entropy(&entropy);
    if keys.fingerprint != body.fingerprint {
        return Err(damaged());
    }
    Ok((entropy, keys))
}

/// The identity file's bytes: the one encode site. Always this exact shape,
/// with nothing that needs escaping:
/// `{"v":1,"kind":"bip39-english","protect":"none","entropy":"<64 hex>","fingerprint":N,"at":T}`.
fn encode_identity(entropy: &[u8; ENTROPY_LEN], fingerprint: u32, at: u64) -> Zeroizing<String> {
    let mut digits = Zeroizing::new([0u8; 2 * ENTROPY_LEN]);
    hex::encode_to_slice(&entropy[..], &mut digits[..]).expect("64 hex digits for 32 bytes");
    let mut out = Zeroizing::new(String::with_capacity(256));
    out.push_str(r#"{"v":1,"kind":"bip39-english","protect":"none","entropy":""#);
    out.push_str(std::str::from_utf8(&digits[..]).expect("hex digits are ASCII"));
    out.push_str(r#"","fingerprint":"#);
    out.push_str(&fingerprint.to_string());
    out.push_str(r#","at":"#);
    out.push_str(&at.to_string());
    out.push('}');
    out
}

/// First load: fresh entropy from the OS CSPRNG (the same `OsRng` the lane's
/// `seal` nonce uses), installed once ([`install_once`]). The loser of a race
/// loads the winner's identity.
fn mint_identity(path: &Path) -> Result<(Zeroizing<[u8; ENTROPY_LEN]>, ChiaKeys, bool)> {
    let mut entropy = Zeroizing::new([0u8; ENTROPY_LEN]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut entropy[..]);
    let keys = keys_from_entropy(&entropy);
    let bytes = encode_identity(&entropy, keys.fingerprint, unix_now());
    match install_once(path, bytes.as_bytes())? {
        Installed::Ours => Ok((entropy, keys, true)),
        Installed::Theirs => {
            let (entropy, keys) = read_identity(path)?;
            Ok((entropy, keys, false))
        }
    }
}

/// Whose file a name holds after [`install_once`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Installed {
    /// This call put it there.
    Ours,
    /// Another minter got there first: its file is the identity.
    Theirs,
}

/// Put `bytes` at `path` once, never over an existing file, so that the file
/// is never torn and never written twice. Since the SpacePhone's Bank can
/// turn the wallet on at any moment of a run (chia_wallet_switch.rs), not
/// only at startup, the identity may be written while the app is about to
/// stop the node, or while a second tap asks for the same thing.
///
/// The bytes go to a temporary file first (created new, owner-only on Unix,
/// synced), which is then hard-linked to the final name. A link never
/// replaces an existing file: when two minters race, the second finds the
/// first one's file and loads that, so nobody holds a key whose identity is
/// gone (its address shown, funded, and orphaned at the next start). A folder
/// whose filesystem cannot hard-link (exFAT, FAT) gets no identity at all:
/// writing the final name directly would show a half-written file to a
/// racing minter, and a stop mid-write would leave a short one, so the mint
/// fails closed and says to run the node from a folder on the system drive.
fn install_once(path: &Path, bytes: &[u8]) -> Result<Installed> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    install_once_with(path, bytes, &SEQ)
}

/// [`install_once`], numbering its temporary files from `seq` (a test's own
/// counter, so it knows which names come next).
fn install_once_with(path: &Path, bytes: &[u8], seq: &AtomicU64) -> Result<Installed> {
    let dir = parent_dir(path);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating chia identity dir {}", dir.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "identity".to_string());
    // A temporary name can already be taken by a file a stopped run left
    // behind under the same process id (a container's restarted pid 1),
    // which the sweep keeps for its first minute as a write in flight: take
    // the next number rather than fail the mint on it.
    let mut attempt = 0;
    let tmp = loop {
        let tmp = dir.join(format!(".{name}.{}-{}.tmp", std::process::id(), seq.fetch_add(1, Ordering::Relaxed)));
        match write_new(&tmp, bytes) {
            Ok(()) => break tmp,
            Err(e) if e.kind() == ErrorKind::AlreadyExists && attempt + 1 < TMP_NAME_ATTEMPTS => attempt += 1,
            Err(e) => return Err(e).with_context(|| format!("writing chia identity file {}", tmp.display())),
        }
    };
    let linked = std::fs::hard_link(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => return Ok(Installed::Theirs),
        Err(e) => {
            return Err(e).with_context(|| {
                format!(
                    "installing chia identity file {} (this folder's filesystem may not hard-link files, \
                     as exFAT and FAT cannot; run the node from a folder on the system drive)",
                    path.display()
                )
            })
        }
    }
    // Best-effort lock-down of the secret file (no-op on Windows).
    restrict_permissions(path);
    // The new name is directory metadata: sync it so a power loss right after
    // cannot lose the identity of a wallet whose address is about to be
    // shown. A failed sync fails the mint, as in `chia_contact::write_private`:
    // no address is shown for an identity that may not survive, and the next
    // attempt loads the file now on disk. Windows has no directory handle to
    // sync; NTFS journals the link.
    #[cfg(unix)]
    std::fs::File::open(&dir).and_then(|d| d.sync_all()).with_context(|| {
        format!("syncing chia identity dir {} (the identity is written; turning the wallet on again loads it)", dir.display())
    })?;
    Ok(Installed::Ours)
}

/// Create `at` (never over an existing file), write `bytes` and sync them; a
/// file this call created and could not fill is removed again, so no short
/// file is left for the next start to refuse.
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

/// A file's bytes into a buffer wiped when dropped, or `None` when it is
/// longer than `cap`. The buffer is sized once, so it never reallocates.
fn read_capped(path: &Path, cap: usize) -> std::io::Result<Option<Zeroizing<Vec<u8>>>> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = Zeroizing::new(vec![0u8; cap + 1]);
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    if n > cap {
        return Ok(None);
    }
    buf.truncate(n);
    Ok(Some(buf))
}

/// Archive a legacy raw seed at `legacy`, so it is never read as a wallet
/// again: hard-link it to `<name>.retired-<now>` (`-<now>-2`, … when that is
/// taken, so no archive is ever replaced), then remove the legacy name.
///
/// Idempotent: a legacy name already gone (another retirer's work) is
/// already retired, and an archive that already holds the same file (same
/// inode, or the same bytes) is used instead of a new name, so a removal
/// that keeps failing (a file held open on Windows) does not add an archive
/// at every start. `Ok(None)` when there was nothing to retire here.
///
/// Nothing is derived from the file except, for the log only, the old
/// wallet's and beacon's addresses when it is a 32-byte seed.
pub(crate) fn retire_legacy_seed(legacy: &Path, now: u64) -> Result<Option<RetiredSeed>> {
    // One retirer at a time in this process: two at once, a second apart,
    // could each link the file under its own time before either removes it.
    static RETIRING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = RETIRING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let lmeta = match std::fs::metadata(legacy) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(anyhow!("looking at it ({e})")),
    };
    let raw = match read_capped(legacy, FILE_MAX) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(anyhow!("reading it ({e})")),
    };
    let dir = parent_dir(legacy);
    let name = legacy.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = format!("{name}.retired-");
    let same = |candidate: &Path| same_file(candidate, &lmeta, raw.as_deref().map(Vec::as_slice));
    let existing = std::fs::read_dir(&dir).ok().and_then(|entries| {
        entries
            .flatten()
            .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with(&stem)))
            .map(|e| e.path())
            .find(|p| same(p))
    });
    let archived_as = match existing {
        Some(p) => p,
        None => {
            let mut archived = None;
            for n in 1..=RETIRE_ATTEMPTS {
                let candidate =
                    if n == 1 { dir.join(format!("{stem}{now}")) } else { dir.join(format!("{stem}{now}-{n}")) };
                match std::fs::hard_link(legacy, &candidate) {
                    Ok(()) => {
                        archived = Some(candidate);
                        break;
                    }
                    // A racing retirer's archive of this same file: use it.
                    Err(e) if e.kind() == ErrorKind::AlreadyExists && same(&candidate) => {
                        archived = Some(candidate);
                        break;
                    }
                    Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                    Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
                    Err(e) => return Err(anyhow!("archiving it as {} ({e})", candidate.display())),
                }
            }
            archived.ok_or_else(|| anyhow!("every archive name {stem}{now}[-n] is taken"))?
        }
    };
    // The archive still holds a wallet's secret: owner-only, best effort.
    restrict_permissions(&archived_as);
    match std::fs::remove_file(legacy) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow!("removing it after archiving it as {} ({e})", archived_as.display())),
    }
    #[cfg(unix)]
    let _ = std::fs::File::open(&dir).and_then(|d| d.sync_all());
    let old = raw.as_deref().filter(|r| r.len() == ENTROPY_LEN).map(|r| SecretKey::from_seed(r));
    Ok(Some(RetiredSeed {
        archived_as,
        old_address: old.as_ref().map(testnet_address),
        old_beacon: old.as_ref().map(|sk| testnet_address(&crate::chia_publish::beacon_wallet_key(sk))),
    }))
}

/// Whether `candidate` is the legacy file already: the same inode (a link
/// made earlier), or the same bytes (`raw`, read when small enough).
fn same_file(candidate: &Path, legacy: &std::fs::Metadata, raw: Option<&[u8]>) -> bool {
    let Ok(meta) = std::fs::metadata(candidate) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.dev() == legacy.dev() && meta.ino() == legacy.ino() {
            return true;
        }
    }
    #[cfg(not(unix))]
    let _ = legacy;
    match raw {
        Some(raw) if meta.len() == raw.len() as u64 => {
            matches!(read_capped(candidate, FILE_MAX), Ok(Some(bytes)) if bytes.as_slice() == raw)
        }
        _ => false,
    }
}

/// Remove the temporary files a stopped mint left beside `paths`
/// (`.<name>.<pid>-<seq>.tmp`): one can hold the entropy, or a raw seed of
/// an older build. A file younger than a minute may be a mint in flight,
/// another thread's or another node's started from the same folder, whose
/// process id says nothing about whether it stopped: it is left alone, and
/// the next load after that minute removes it.
fn sweep_stale_tmp(paths: &[&Path]) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for p in paths {
        let d = parent_dir(p);
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    let prefixes: Vec<String> =
        paths.iter().filter_map(|p| p.file_name()).map(|n| format!(".{}.", n.to_string_lossy())).collect();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let ours = prefixes.iter().any(|p| name.strip_prefix(p.as_str()).is_some_and(|r| r.ends_with(".tmp")));
            if !ours {
                continue;
            }
            // An age that cannot be read (a clock set back, no mtime) counts
            // as in flight: kept, never removed under a writer.
            let age = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
            if !age.is_some_and(|a| a >= TMP_IN_FLIGHT) {
                continue;
            }
            match std::fs::remove_file(entry.path()) {
                Ok(()) => println!("🏦 SSF wallet: removed {name}, a temporary file a stopped write left behind"),
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => eprintln!(
                    "🏦 SSF wallet: could not remove {name}, a temporary file a stopped write left behind ({e}); \
                     it may hold a wallet's secret: delete it"
                ),
            }
        }
    }
}

fn parent_dir(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The `txch1…` standard-puzzle receive address for this key on testnet11.
///
/// Path: secret key -> public key -> synthetic public key
/// (DEFAULT_HIDDEN_PUZZLE_HASH) -> standard puzzle tree hash -> bech32m("txch").
///
/// Handed the wallet key (m/12381/8444/2/0, [`load_or_mint_wallet`]), this is
/// Chia's index-0 address for the node's 24 words: the first address
/// `chia keys show` and Sage list for them. The node watches only this one.
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
/// what the load did, the key fingerprint, and the receive address, so the
/// operator can fund it at a testnet11 faucet. TXCH only. Never the words.
pub fn log_receive_address(id: &WalletIdentity) {
    if let Some(r) = &id.retired {
        let kept = r.archived_as.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match &r.old_address {
            Some(old) => {
                let beacon = r
                    .old_beacon
                    .as_ref()
                    .map(|b| format!("; its beacon wallet, if the beacon ran, was {b}"))
                    .unwrap_or_default();
                println!(
                    "🏦 SSF wallet: retired the old raw-seed wallet {old} (kept as {kept}; its testnet coins stay at that address{beacon})"
                );
            }
            None => println!(
                "🏦 SSF wallet: retired an old chia_identity.seed that was not a 32-byte seed (kept as {kept})"
            ),
        }
    }
    if id.minted {
        println!(
            "🏦 SSF wallet: made a new wallet from 24 words, key fingerprint {} — back the words up in the SpacePhone's 🏦 BANK, \
             or keep a copy of chia_identity.json (the node never prints them)",
            id.fingerprint
        );
    } else {
        println!("🏦 SSF wallet: loaded the wallet made from 24 words, key fingerprint {}", id.fingerprint);
    }
    let addr = testnet_address(&id.wallet);
    println!(
        "⛓️ ChiaHub lane: testnet11 receive address {addr}\n   \
         Fund it at a testnet11 faucet (TXCH — no real XCH needed); \
         once it holds a coin, the lane can publish/resolve presence."
    );
}

/// Tighten the identity file to owner-only on Unix; a no-op elsewhere
/// (Windows ACLs are inherited from the node-data dir). Best-effort — a
/// failure here never stops the node.
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
    use chia_bls::master_to_wallet_hardened;

    const ABOUT_12: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    /// bip39's own vector (bip39-2.2.2 lib.rs, the 24-word block): entropy
    /// whose bytes are not a palindrome, so a byte-order slip changes it.
    const HAMSTER_HEX: &str = "68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c";
    const HAMSTER: &str = "hamster diagram private dutch cause delay private meat slide toddler razor book \
                           happy fancy gospel tennis maple dilemma loan word shrug inflict delay length";

    fn art_24() -> String {
        let mut w = vec!["abandon"; 23];
        w.push("art");
        w.join(" ")
    }

    fn entropy_of(hex_str: &str) -> [u8; 32] {
        let mut e = [0u8; 32];
        hex::decode_to_slice(hex_str, &mut e).unwrap();
        e
    }

    fn puzzle_hash_hex(sk: &SecretKey) -> String {
        let ph: Bytes32 = StandardArgs::curry_tree_hash(sk.public_key().derive_synthetic()).into();
        hex::encode(ph.to_bytes())
    }

    fn fresh_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ssf-chia-identity-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> =
            std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn envelope(entropy_hex: &str, fingerprint: u32) -> String {
        format!(
            r#"{{"v":1,"kind":"bip39-english","protect":"none","entropy":"{entropy_hex}","fingerprint":{fingerprint},"at":1730000000}}"#
        )
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    // --- Vectors -----------------------------------------------------------

    /// The BIP39 layer: entropy to words, words to the empty-passphrase seed.
    #[test]
    fn bip39_layer_matches_the_vendored_vectors() {
        let m = Mnemonic::from_entropy(&[0u8; 32]).unwrap();
        assert_eq!(m.words().collect::<Vec<_>>().join(" "), art_24());
        let m = Mnemonic::from_entropy(&entropy_of(HAMSTER_HEX)).unwrap();
        assert_eq!(m.words().collect::<Vec<_>>().join(" "), HAMSTER.split_whitespace().collect::<Vec<_>>().join(" "));
        assert_eq!(m.word_count(), 24);
        let m = Mnemonic::parse_normalized(ABOUT_12).unwrap();
        assert_eq!(
            hex::encode(m.to_seed_normalized("")),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );
        assert_eq!(m.to_seed_normalized(""), m.to_seed(""), "the normalized form gives the same bytes for no passphrase");
    }

    /// chia-blockchain's `test_keychain.py::test_bip39_eip2333_test_vector`,
    /// through the product's own `master_of`: this pins Chia's KeyGen.
    #[test]
    fn master_key_matches_chias_own_vector() {
        let master = master_of(&Mnemonic::parse_normalized(ABOUT_12).unwrap());
        // int 8075452428075949470768183878078858156044736575259233735633523546099624838313
        assert_eq!(hex::encode(master.to_bytes()), "11da8b4a2874a49dc42984b6aa127b68ef73adddc333319c36fd0446705204a9");
        // int 18507161868329770878190303689452715596635858303241878571348190917018711023613
        assert_eq!(
            hex::encode(master.derive_hardened(0).to_bytes()),
            "28eaaeb25677c38fbbaa61adb0804efe1bddae420109702eca2dbd5dcaa8dffd"
        );
    }

    /// The wallet path end to end, for the 12- and 24-word vectors. Computed
    /// independently with chia_rs 0.51 (the BLS library chia-blockchain
    /// uses: `AugSchemeMPL.key_gen`, `derive_child_sk_unhardened`, the real
    /// standard puzzle's tree hash); confirm with `chia keys show` and Sage
    /// on testnet11 before merge.
    #[test]
    fn wallet_key_is_chias_first_address() {
        let k = keys_from_mnemonic(&Mnemonic::parse_normalized(ABOUT_12).unwrap());
        assert_eq!(k.fingerprint, 3781984839);
        assert_eq!(
            hex::encode(master_of(&Mnemonic::parse_normalized(ABOUT_12).unwrap()).public_key().to_bytes()),
            "82ae65efe846b15a92c51b7ad6c32589fd79d38263d3cbefbeeba08be8e90d8bc335a1e2fcc66a10b8c817c06232285a"
        );
        assert_eq!(puzzle_hash_hex(&k.wallet), "792931431ba2976e36e3abc0b35c811948536bcf77f39a8d99ec2a15af0e84bc");
        assert_eq!(testnet_address(&k.wallet), "txch10y5nzscm52tkudhr40qtxhypr9y9x670wlee4rveas4pttcwsj7qnxh9ya");

        let k = keys_from_mnemonic(&Mnemonic::parse_normalized(&art_24()).unwrap());
        assert_eq!(k.fingerprint, 1532878573);
        assert_eq!(puzzle_hash_hex(&k.wallet), "d207c1e11fc3b0cd7472e8c7e53c8d2b81709516346c7baa9fbb9070ffccfe89");
        assert_eq!(testnet_address(&k.wallet), "txch16grurcglcwcv6arjarr720yd9wqhp9gkx3k8h25lhwg8pl7vl6ys36pefh");

        let k = keys_from_entropy(&entropy_of(HAMSTER_HEX));
        assert_eq!(k.fingerprint, 3552866753, "byte-reversed entropy would give 3701174480");
        assert_eq!(testnet_address(&k.wallet), "txch1z7mfs4eqsm3dhxg7y3a497mftavx0xtexrekfr6kn3d0ltjf64tqevsfhk");
    }

    /// A wallet that watches the address from the master public key alone
    /// (an observer) finds the same address the secret key spends from.
    #[test]
    fn observer_and_secret_derivations_agree() {
        for words in [ABOUT_12.to_string(), art_24(), HAMSTER.to_string()] {
            let m = Mnemonic::parse_normalized(&words).unwrap();
            let master = master_of(&m);
            let keys = keys_from_mnemonic(&m);
            let observer = master_to_wallet_unhardened(&master.public_key(), 0).derive_synthetic();
            assert_eq!(observer, keys.wallet.public_key().derive_synthetic());
        }
    }

    /// Not today's path-less address (the master key's own synthetic key),
    /// and not the hardened index 0 (which no observer can watch).
    #[test]
    fn not_the_old_pathless_address() {
        for (words, pathless, hardened) in [
            (
                ABOUT_12.to_string(),
                "txch1va6qexzxtmdvervtuedmlnngkh0l29skf9d4p2llyjrpdvavs9ws423g0u",
                "txch17m20cjztjwevl3rtql5j02rc0mgvmtup24lpq8esctctkaj3g54s08p2n0",
            ),
            (
                art_24(),
                "txch1ptl37j4r87zmnz88865qe326w5mrpwsepq952tmqvx5ju5z6p7uq2d93uz",
                "txch1wcdmmzw29gf2fj2s7xjvdhup8qjzterjy82ns6wvazprjdn46p7sdz8065",
            ),
        ] {
            let m = Mnemonic::parse_normalized(&words).unwrap();
            let master = master_of(&m);
            assert_eq!(testnet_address(&master), pathless, "the path-less address of these words");
            assert_eq!(testnet_address(&master_to_wallet_hardened(&master, 0)), hardened);
            let ours = testnet_address(&keys_from_mnemonic(&m).wallet);
            assert_ne!(ours, pathless);
            assert_ne!(ours, hardened);
        }
    }

    /// Our own rule, not a Chia vector: the beacon pays from blake3 of the
    /// wallet key (D7), off every m/12381/8444/2/* path, so Sage and the
    /// Chia wallet never see or co-spend beacon coins. A change detector.
    #[test]
    fn beacon_key_is_off_the_wallet_path() {
        let m = Mnemonic::from_entropy(&[0u8; 32]).unwrap();
        let master = master_of(&m);
        let wallet = keys_from_mnemonic(&m).wallet;
        let beacon = testnet_address(&crate::chia_publish::beacon_wallet_key(&wallet));
        assert_eq!(beacon, "txch1jmfqazsfj4fh6vldzjnwas0wudfv8fy5d6w7tcd5v3deddmhm9yqravp4u", "the value this rule gave when it was pinned");
        for idx in 0..4 {
            assert_ne!(beacon, testnet_address(&master_to_wallet_unhardened(&master, idx)), "index {idx}");
            assert_ne!(beacon, testnet_address(&master_to_wallet_hardened(&master, idx)), "hardened index {idx}");
        }
        assert_ne!(beacon, "txch10wnvld5a9j7evr0la4ss4megqwzdqs66fjweapvzgv8smaw5q5hsxfkaqe", "index 1");
        assert_ne!(beacon, testnet_address(&master));
    }

    // --- Through the file --------------------------------------------------

    /// The derivation pinned through the file the node reads: a hand-written
    /// envelope gives Chia's address for its words, and the reveal gives
    /// those words. A loader that took the entropy as a seed, or decoded its
    /// hex backwards, fails here.
    #[test]
    fn a_hand_written_identity_loads_chias_wallet_for_its_words() {
        let dir = fresh_dir("vector");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        std::fs::write(&identity, envelope(HAMSTER_HEX, 3552866753)).unwrap();
        let id = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert!(!id.minted && id.retired.is_none());
        assert_eq!(id.fingerprint, 3552866753);
        assert_eq!(puzzle_hash_hex(&id.wallet), "17b698572086e2db991e247b52fb695f5867997930f3648f569c5affae49d556");
        assert_eq!(testnet_address(&id.wallet), "txch1z7mfs4eqsm3dhxg7y3a497mftavx0xtexrekfr6kn3d0ltjf64tqevsfhk");
        let raw = entropy_of(HAMSTER_HEX);
        assert_ne!(testnet_address(&id.wallet), testnet_address(&SecretKey::from_seed(&raw)), "not the entropy as a seed");
        let rev = reveal_words(&identity).unwrap();
        assert_eq!(rev.words().collect::<Vec<_>>(), HAMSTER.split_whitespace().collect::<Vec<_>>());
        assert_eq!(rev.fingerprint, 3552866753);
        assert_eq!(rev.wallet, id.wallet.public_key());

        std::fs::write(&identity, envelope(&"00".repeat(32), 1532878573)).unwrap();
        let id = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert_eq!(id.fingerprint, 1532878573);
        assert_eq!(testnet_address(&id.wallet), "txch16grurcglcwcv6arjarr720yd9wqhp9gkx3k8h25lhwg8pl7vl6ys36pefh");
        assert_ne!(testnet_address(&id.wallet), testnet_address(&SecretKey::from_seed(&[0u8; 32])));
        assert_eq!(names(&dir), vec!["chia_identity.json"], "a load writes nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_persists_and_reloads_the_same_wallet() {
        let dir = fresh_dir("persist");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let first = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert!(first.minted && first.retired.is_none());
        let again = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert!(!again.minted);
        assert_eq!(first.wallet.public_key(), again.wallet.public_key());
        assert_eq!(first.fingerprint, again.fingerprint);
        let addr = testnet_address(&first.wallet);
        assert_eq!(addr, testnet_address(&again.wallet));
        assert!(addr.starts_with("txch1"), "expected txch1… address, got {addr}");
        let ph = testnet_address_to_puzzle_hash(&addr).unwrap();
        let expected: Bytes32 = StandardArgs::curry_tree_hash(first.wallet.public_key().derive_synthetic()).into();
        assert_eq!(ph, expected);

        let text = std::fs::read_to_string(&identity).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["kind"], "bip39-english");
        assert_eq!(v["protect"], "none");
        assert_eq!(v["fingerprint"], first.fingerprint);
        let hex_str = v["entropy"].as_str().unwrap();
        assert!(hex_str.len() == 64 && hex_str.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert!(v["at"].as_u64().unwrap() > 1_700_000_000);
        // The file's words make the loaded wallet.
        let k = keys_from_entropy(&entropy_of(hex_str));
        assert_eq!(k.wallet.public_key(), first.wallet.public_key());
        #[cfg(unix)]
        assert_eq!(mode(&identity), 0o600, "the identity is owner-only");
        assert_eq!(names(&dir), vec!["chia_identity.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🏦 Two taps in the Bank, or two tabs, may ask for the wallet at once:
    /// every minter ends up with the one identity on disk, never a key of its
    /// own whose file another minter's write replaced.
    #[test]
    fn minters_racing_for_one_identity_all_load_the_identity_on_disk() {
        let dir = fresh_dir("race");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let keys: Vec<(PublicKey, bool)> = (0..8)
            .map(|_| {
                let (identity, legacy, start) = (identity.clone(), legacy.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    let id = load_or_mint_wallet(&identity, &legacy).unwrap();
                    (id.wallet.public_key(), id.minted)
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        let on_disk = load_or_mint_wallet(&identity, &legacy).unwrap().wallet.public_key();
        assert!(keys.iter().all(|(k, _)| *k == on_disk), "every minter holds the identity that stayed");
        assert_eq!(keys.iter().filter(|(_, minted)| *minted).count(), 1, "one minter installed it");
        assert_eq!(names(&dir), vec!["chia_identity.json"], "no temporary file left behind");
        #[cfg(unix)]
        assert_eq!(mode(&identity), 0o600, "the identity is owner-only from the moment it exists");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The same race with a legacy seed beside it: one archive, the legacy
    /// name gone, and every minter on the same new wallet.
    #[test]
    fn minters_racing_with_a_legacy_seed_retire_it_once() {
        let dir = fresh_dir("race-legacy");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        std::fs::write(&legacy, [5u8; 32]).unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let keys: Vec<PublicKey> = (0..8)
            .map(|_| {
                let (identity, legacy, start) = (identity.clone(), legacy.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    load_or_mint_wallet(&identity, &legacy).unwrap().wallet.public_key()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        assert!(keys.windows(2).all(|w| w[0] == w[1]));
        let left = names(&dir);
        assert_eq!(left.len(), 2, "{left:?}");
        assert_eq!(left[0], "chia_identity.json");
        assert!(left[1].starts_with("chia_identity.seed.retired-"), "{left:?}");
        assert_eq!(std::fs::read(dir.join(&left[1])).unwrap(), vec![5u8; 32]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Refusals ----------------------------------------------------------

    #[test]
    fn an_unreadable_identity_is_refused_and_left_alone() {
        let k = keys_from_entropy(&entropy_of(HAMSTER_HEX));
        let fp = k.fingerprint;
        let good = envelope(HAMSTER_HEX, fp);
        let damaged: Vec<(&str, String)> = vec![
            ("truncated", good[..good.len() - 9].to_string()),
            ("empty", String::new()),
            ("not json", "68a79eac".to_string()),
            ("63 hex", envelope(&HAMSTER_HEX[..63], fp)),
            ("65 hex", envelope(&format!("{HAMSTER_HEX}0"), fp)),
            ("non-hex", envelope(&format!("{}zz", &HAMSTER_HEX[..62]), fp)),
            ("escaped", envelope(&format!("\\u0036{}", &HAMSTER_HEX[1..]), fp)),
            ("fingerprint mismatch", envelope(HAMSTER_HEX, fp ^ 1)),
            ("no fingerprint", good.replace(&format!(r#","fingerprint":{fp}"#), "")),
            ("no kind", good.replace(r#""kind":"bip39-english","#, "")),
            ("padded to 5 KB", format!("{good}{}", " ".repeat(5000))),
            ("v as a string", good.replace(r#""v":1"#, r#""v":"1""#)),
        ];
        let newer: Vec<(&str, String)> = vec![
            ("v2", good.replace(r#""v":1"#, r#""v":2"#)),
            ("dpapi", good.replace(r#""protect":"none""#, r#""protect":"dpapi""#)),
            (
                "a future envelope with a blob and no entropy",
                format!(r#"{{"v":1,"kind":"bip39-english","protect":"dpapi","blob":"AAECAwQ=","fingerprint":{fp}}}"#),
            ),
            ("another kind", good.replace("bip39-english", "bip39-japanese")),
        ];
        for (why, text, says) in damaged
            .iter()
            .map(|(w, t)| (w, t, "refusing to overwrite"))
            .chain(newer.iter().map(|(w, t)| (w, t, "update Star Station")))
        {
            let dir = fresh_dir("refuse");
            let identity = dir.join("chia_identity.json");
            let legacy = dir.join("chia_identity.seed");
            std::fs::write(&identity, text).unwrap();
            let err = format!("{:#}", load_or_mint_wallet(&identity, &legacy).unwrap_err());
            assert!(err.contains(says), "{why}: {err}");
            assert_eq!(std::fs::read_to_string(&identity).unwrap(), *text, "{why}: the file is left for recovery");
            assert_eq!(names(&dir), vec!["chia_identity.json"], "{why}: nothing minted beside it");
            assert!(reveal_words(&identity).is_err(), "{why}: nothing revealed");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// serde and hex errors quote what they choked on; the reader's
    /// refusals never do, in `{e:#}` or `{e:?}`.
    #[test]
    fn errors_never_echo_file_content() {
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let bad_char = format!("{}~{}", &HAMSTER_HEX[..20], &HAMSTER_HEX[21..]);
        let cases = [
            // The entropy where a number is expected.
            format!(r#"{{"v":1,"kind":"bip39-english","protect":"none","entropy":"{HAMSTER_HEX}","fingerprint":"{HAMSTER_HEX}"}}"#),
            format!(r#"{{"v":"{HAMSTER_HEX}","kind":"bip39-english","protect":"none"}}"#),
            format!(r#"{{"v":1,"kind":"bip39-english","protect":"none","entropy":{HAMSTER_HEX}}}"#),
            format!(r#"{{"v":1,"kind":"bip39-english","protect":"none","entropy":["{HAMSTER_HEX}"],"fingerprint":{fp}}}"#),
            // A non-hex character in the entropy.
            envelope(&bad_char, fp),
            // A protect value that is the entropy.
            format!(r#"{{"v":1,"kind":"bip39-english","protect":"{HAMSTER_HEX}"}}"#),
            format!(r#"{{"v":2,"kind":"{HAMSTER_HEX}","protect":"{HAMSTER_HEX}"}}"#),
        ];
        for text in &cases {
            let dir = fresh_dir("echo");
            let identity = dir.join("chia_identity.json");
            std::fs::write(&identity, text).unwrap();
            let e = load_or_mint_wallet(&identity, &dir.join("chia_identity.seed")).unwrap_err();
            // The path is the test's own (on Windows it can hold an 8.3 name
            // such as RUNNER~1): only what the file held must stay out.
            let path = identity.display().to_string();
            for shown in [format!("{e:#}"), format!("{e:?}"), format!("{e}")] {
                let shown = shown.replace(&path, "<path>");
                for i in 0..HAMSTER_HEX.len() - 8 {
                    let piece = &HAMSTER_HEX[i..i + 8];
                    assert!(!shown.contains(piece), "{text}: the error quotes {piece}: {shown}");
                }
                assert!(!shown.contains('~') && !shown.contains("Invalid character"), "{text}: {shown}");
                assert!(!shown.contains("invalid type") && !shown.contains("expected"), "{text}: {shown}");
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    // --- Legacy raw seeds --------------------------------------------------

    #[test]
    fn a_legacy_seed_is_retired_not_reused() {
        let dir = fresh_dir("legacy");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let raw = [9u8; 32];
        std::fs::write(&legacy, raw).unwrap();
        let old_key = SecretKey::from_seed(&raw);
        let id = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert!(id.minted);
        let retired = id.retired.clone().expect("the legacy seed is retired");
        assert!(!legacy.exists(), "the legacy name is gone");
        assert_eq!(std::fs::read(&retired.archived_as).unwrap(), raw.to_vec(), "the archive holds the same bytes");
        #[cfg(unix)]
        assert_eq!(mode(&retired.archived_as), 0o600, "the archive is owner-only, however the old file was made");
        let archive_name = retired.archived_as.file_name().unwrap().to_string_lossy().into_owned();
        assert!(archive_name.starts_with("chia_identity.seed.retired-"), "{archive_name}");
        assert_eq!(retired.old_address.as_deref(), Some(testnet_address(&old_key).as_str()), "the path-less address");
        assert_eq!(
            retired.old_beacon.as_deref(),
            Some(testnet_address(&crate::chia_publish::beacon_wallet_key(&old_key)).as_str())
        );
        assert_ne!(testnet_address(&id.wallet), testnet_address(&old_key), "a new wallet at a new address");
        assert_ne!(
            id.wallet.public_key(),
            keys_from_entropy(&raw).wallet.public_key(),
            "fresh entropy, not the raw seed read as entropy"
        );
        let again = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert!(!again.minted && again.retired.is_none(), "a second load retires nothing");
        assert_eq!(again.wallet.public_key(), id.wallet.public_key());
        assert_eq!(names(&dir), vec!["chia_identity.json".to_string(), archive_name]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A stop between the mint and the archive (or an older build run in
    /// between, which mints a raw seed again): the next load keeps the
    /// identity and archives the legacy file.
    #[test]
    fn a_crash_between_mint_and_archive_retires_on_the_next_load() {
        let dir = fresh_dir("crash");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let first = load_or_mint_wallet(&identity, &legacy).unwrap();
        std::fs::write(&legacy, [3u8; 32]).unwrap();
        let next = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert!(!next.minted);
        assert_eq!(next.wallet.public_key(), first.wallet.public_key(), "the identity stays the wallet");
        assert!(next.retired.is_some() && !legacy.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_length_legacy_seed_is_archived_too() {
        let dir = fresh_dir("legacy-short");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        std::fs::write(&legacy, [7u8; 5]).unwrap();
        let id = load_or_mint_wallet(&identity, &legacy).unwrap();
        let retired = id.retired.expect("archived whatever its length");
        assert_eq!(retired.old_address, None, "nothing is derived from a file that is not a seed");
        assert_eq!(retired.old_beacon, None);
        assert_eq!(std::fs::read(&retired.archived_as).unwrap(), vec![7u8; 5]);
        assert!(!legacy.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retiring_never_overwrites_an_archive() {
        let dir = fresh_dir("retire-names");
        let legacy = dir.join("chia_identity.seed");
        let taken = dir.join("chia_identity.seed.retired-1730000000");
        std::fs::write(&taken, [1u8; 32]).unwrap();
        std::fs::write(&legacy, [2u8; 32]).unwrap();
        let r = retire_legacy_seed(&legacy, 1730000000).unwrap().unwrap();
        assert_eq!(r.archived_as, dir.join("chia_identity.seed.retired-1730000000-2"));
        assert_eq!(std::fs::read(&taken).unwrap(), vec![1u8; 32], "the older archive is untouched");
        assert_eq!(std::fs::read(&r.archived_as).unwrap(), vec![2u8; 32]);
        assert!(!legacy.exists());
        assert_eq!(retire_legacy_seed(&legacy, 1730000001).unwrap(), None, "nothing left to retire");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A removal that failed after the archive was made (a file held open on
    /// Windows): the next retire uses that archive, it does not add another.
    #[test]
    fn retiring_again_reuses_the_archive_that_holds_the_same_seed() {
        let dir = fresh_dir("retire-again");
        let legacy = dir.join("chia_identity.seed");
        std::fs::write(&legacy, [4u8; 32]).unwrap();
        // A copy, not a link: the bytes decide, as they must on Windows.
        let earlier = dir.join("chia_identity.seed.retired-1720000000");
        std::fs::write(&earlier, [4u8; 32]).unwrap();
        let r = retire_legacy_seed(&legacy, 1730000000).unwrap().unwrap();
        assert_eq!(r.archived_as, earlier);
        assert_eq!(names(&dir), vec!["chia_identity.seed.retired-1720000000"]);
        // And a link made earlier, found by its inode.
        std::fs::hard_link(&earlier, &legacy).unwrap();
        let r = retire_legacy_seed(&legacy, 1730000000).unwrap().unwrap();
        assert_eq!(r.archived_as, earlier);
        assert_eq!(names(&dir), vec!["chia_identity.seed.retired-1720000000"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A stopped mint's temporary file can hold the entropy: the next load
    /// removes every one older than a minute, whichever process wrote it,
    /// and keeps a younger one, which may be a write in flight (this
    /// process's other thread, or another node started from the same folder).
    #[test]
    fn a_load_sweeps_the_temporary_files_a_stopped_mint_left() {
        let dir = fresh_dir("sweep");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let me = std::process::id();
        let other = if me == 1 { 2 } else { me - 1 };
        let two_minutes_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        for stale in [
            format!(".chia_identity.json.{other}-0.tmp"),
            format!(".chia_identity.json.{other}-17.tmp"),
            format!(".chia_identity.seed.{other}-0.tmp"),
            ".chia_identity.json.junk.tmp".to_string(),
            // This process's own, from a write that stopped (a thread that
            // failed mid-mint), beside the identity and beside the raw seed.
            format!(".chia_identity.json.{me}-7.tmp"),
            format!(".chia_identity.seed.{me}-8.tmp"),
        ] {
            let path = dir.join(stale);
            std::fs::write(&path, b"secret").unwrap();
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(two_minutes_ago).unwrap();
        }
        let in_flight = format!(".chia_identity.json.{me}-999999.tmp");
        std::fs::write(dir.join(&in_flight), b"in flight").unwrap();
        let theirs_in_flight = format!(".chia_identity.json.{other}-3.tmp");
        std::fs::write(dir.join(&theirs_in_flight), b"in flight").unwrap();
        // Not the wallet's: another file's temporary is not this sweep's.
        let not_ours = format!(".chia_wallet.json.{other}-0.tmp");
        std::fs::write(dir.join(&not_ours), b"{}").unwrap();
        std::fs::File::options().write(true).open(dir.join(&not_ours)).unwrap().set_modified(two_minutes_ago).unwrap();
        let id = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert!(id.minted);
        let mut expect = vec![in_flight, theirs_in_flight, not_ours, "chia_identity.json".to_string()];
        expect.sort();
        assert_eq!(names(&dir), expect, "every stale temporary is gone, and only the fresh ones stay");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A stopped run under this same process id (a container's restarted
    /// pid 1) can leave temporary names the sweep keeps for a minute: the
    /// mint takes the next free number instead of failing, and leaves the
    /// files it skipped to the sweep.
    #[test]
    fn a_mint_steps_past_temporary_names_a_stopped_run_left() {
        let dir = fresh_dir("tmp-taken");
        let identity = dir.join("chia_identity.json");
        let me = std::process::id();
        let taken = [format!(".chia_identity.json.{me}-0.tmp"), format!(".chia_identity.json.{me}-1.tmp")];
        for name in &taken {
            std::fs::write(dir.join(name), b"left behind").unwrap();
        }
        let seq = AtomicU64::new(0);
        assert_eq!(install_once_with(&identity, b"the identity", &seq).unwrap(), Installed::Ours);
        assert_eq!(std::fs::read(&identity).unwrap(), b"the identity");
        for name in &taken {
            assert_eq!(std::fs::read(dir.join(name)).unwrap(), b"left behind", "{name} is not this mint's to touch");
        }
        let mut expect = vec!["chia_identity.json".to_string()];
        expect.extend(taken.iter().cloned());
        expect.sort();
        assert_eq!(names(&dir), expect, "the temporary it did write is gone");

        // Every name taken: the mint gives up, says so, and writes nothing.
        let full = fresh_dir("tmp-full");
        let identity = full.join("chia_identity.json");
        for n in 0..u64::from(TMP_NAME_ATTEMPTS) {
            std::fs::write(full.join(format!(".chia_identity.json.{me}-{n}.tmp")), b"left behind").unwrap();
        }
        let err = format!("{:#}", install_once_with(&identity, b"the identity", &AtomicU64::new(0)).unwrap_err());
        assert!(err.contains("writing chia identity file"), "{err}");
        assert!(!identity.exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&full);
    }

    /// An identity the operator put back with looser modes (from a zip, a
    /// cloud folder, a FAT stick) is owner-only again once the node loads it.
    #[cfg(unix)]
    #[test]
    fn a_loaded_identity_is_owner_only_again() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fresh_dir("modes");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let minted = load_or_mint_wallet(&identity, &legacy).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&identity), 0o600, "minted owner-only");
        std::fs::set_permissions(&identity, std::fs::Permissions::from_mode(0o644)).unwrap();
        let loaded = load_or_mint_wallet(&identity, &legacy).unwrap();
        assert_eq!(loaded.fingerprint, minted.fingerprint);
        assert_eq!(mode(&identity), 0o600, "owner-only again after the load");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Reveal and redaction ----------------------------------------------

    #[test]
    fn reveal_reads_back_the_words_of_the_loaded_key() {
        let dir = fresh_dir("reveal");
        let identity = dir.join("chia_identity.json");
        let id = load_or_mint_wallet(&identity, &dir.join("chia_identity.seed")).unwrap();
        let rev = reveal_words(&identity).unwrap();
        let words: Vec<&str> = rev.words().collect();
        assert_eq!(words.len(), 24);
        assert_eq!(rev.fingerprint, id.fingerprint);
        assert_eq!(rev.wallet, id.wallet.public_key());
        // The words alone, typed into another wallet, make the same wallet.
        let typed = Mnemonic::parse_normalized(&words.join(" ")).unwrap();
        let k = keys_from_mnemonic(&typed);
        assert_eq!(k.fingerprint, id.fingerprint);
        assert_eq!(k.wallet.public_key(), id.wallet.public_key());
        assert!(reveal_words(&dir.join("missing.json")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_reveal_body_is_the_words_the_key_and_the_address() {
        let dir = fresh_dir("body");
        let identity = dir.join("chia_identity.json");
        std::fs::write(&identity, envelope(HAMSTER_HEX, 3552866753)).unwrap();
        let rev = reveal_words(&identity).unwrap();
        let addr = "txch1z7mfs4eqsm3dhxg7y3a497mftavx0xtexrekfr6kn3d0ltjf64tqevsfhk";
        let body = reveal_body(&rev, addr);
        let quoted: Vec<String> = HAMSTER.split_whitespace().map(|w| format!("\"{w}\"")).collect();
        assert_eq!(
            body.as_str(),
            format!(r#"{{"ok":true,"words":[{}],"key":3552866753,"address":"{addr}"}}"#, quoted.join(","))
        );
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["words"].as_array().unwrap().len(), 24);
        assert_eq!(body.capacity(), 64 + 24 * 11 + addr.len() + 2, "built in its first buffer, never reallocated");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn debug_never_prints_words_or_entropy() {
        let dir = fresh_dir("debug");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        std::fs::write(&identity, envelope(HAMSTER_HEX, 3552866753)).unwrap();
        std::fs::write(&legacy, [6u8; 32]).unwrap();
        let id = load_or_mint_wallet(&identity, &legacy).unwrap();
        let rev = reveal_words(&identity).unwrap();
        let keys = keys_from_entropy(&entropy_of(HAMSTER_HEX));
        let secret_hex = hex::encode(id.wallet.to_bytes());
        let old_hex = hex::encode([6u8; 32]);
        for shown in [format!("{id:?}"), format!("{rev:?}"), format!("{keys:?}"), format!("{id:#?}")] {
            assert!(shown.contains("3552866753"), "{shown}");
            for word in ["hamster", "diagram", "toddler", "length"] {
                assert!(!shown.contains(word), "{shown}");
            }
            assert!(!shown.contains(&HAMSTER_HEX[..12]) && !shown.contains(&secret_hex[..12]), "{shown}");
            assert!(!shown.contains(&old_hex[..12]), "{shown}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
