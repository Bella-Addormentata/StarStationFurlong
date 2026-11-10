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
//! wallet key is the one every spend site is handed, so the node's address
//! (`txch1…` on testnet11) is the first address `chia keys show` and Sage give for the same
//! words, and the key fingerprint the Bank shows is the number they print.
//!
//! The words are never written anywhere and never printed: the Bank shows
//! them, until the player marks them saved, from the identity file read again
//! each time (main.rs, `POST /api/chia/words`). The node keeps no copy of the
//! entropy or the words, only the derived wallet key.
//!
//! 🔒 Once the words are marked saved, [`wrap_at_rest`] locks the file with
//! this computer's store (chia_at_rest.rs: Windows DPAPI, and the Mac login
//! keychain): the entropy is replaced by a `blob`
//! only this account can open, in one guarded rename that never leaves the
//! wallet without a whole file. Minting always writes the clear form first.
//!
//! A node from before the words kept a raw 32-byte seed in
//! `chia_identity.seed`. No words reproduce its key, so turning such a wallet
//! on mints fresh entropy, and the raw seed is archived as
//! `chia_identity.seed.retired-<unix>` (its testnet coins stay at its old
//! address, which the log names).
//!
//! ⛓️ Each Chia network has its own identity (chia_network.rs): testnet11's
//! at the data root, where it always was, and mainnet's under
//! `chia-mainnet/`. The file names its network in an optional `net` field.
//! A testnet11 mint never writes it, so its files stay byte for byte as they
//! were; a mainnet mint writes `"net":"mainnet"`, which an older node refuses
//! as a field it does not know. Raw seeds from before the words were only
//! ever testnet11's, so a mainnet load never looks for one.
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

use std::collections::BTreeMap;
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
use base64::Engine;
use serde::Deserialize;
use zeroize::Zeroizing;

use crate::chia_at_rest::{self, AtRest, Policy, SecretStore};
use crate::chia_network::ChiaNet;

/// The identity file's format, its one `kind`, and the `protect` values this
/// node reads: `none` (the entropy in the clear), and `dpapi` and `keychain`
/// (a `blob` in place of the entropy, in the same fields). A locked file
/// opens only with a store of its own `protect`; on any other computer it is
/// refused as locked by a store it does not have. Any other `protect`, or a
/// field this node does not know, is a newer Star Station's file: refused,
/// never minted over.
const IDENTITY_V: u64 = 1;
const IDENTITY_KIND: &str = "bip39-english";
const PROTECT_NONE: &str = "none";
const PROTECT_DPAPI: &str = "dpapi";
const PROTECT_KEYCHAIN: &str = "keychain";

/// Every field a v1 file can carry. `net` is optional: absent means testnet11.
const KNOWN_FIELDS: [&str; 9] = ["v", "kind", "net", "protect", "entropy", "blob", "fingerprint", "at", "wrapped_at"];

/// The longest `blob` a reader takes, in base64 characters. DPAPI's for 32
/// bytes is a few hundred, the keychain's 116; this keeps the file well
/// under [`FILE_MAX`].
pub(crate) const BLOB_MAX: usize = 2048;

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
    /// How the identity file keeps its key on disk.
    pub at_rest: AtRest,
}

/// Fingerprint and what the load did; never the key.
impl fmt::Debug for WalletIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WalletIdentity")
            .field("fingerprint", &self.fingerprint)
            .field("minted", &self.minted)
            .field("retired", &self.retired)
            .field("at_rest", &self.at_rest)
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
/// lock once the words are saved would not reach it. A lock that stopped
/// can leave a locked copy beside it ([`recover_rewrap`]): it is put back
/// when the identity is missing, and one that does not open stops the mint.
/// Such leftovers are removed only once the identity has opened, and only
/// when they are torn or hold that same wallet.
///
/// A file that is there and cannot be read is reported and never minted
/// over; see [`read_identity`]'s refusals. The file must be `net`'s; on a
/// network that is not a test network, `legacy` is never looked at.
///
/// With no identity on disk, a mint happens only when `may_mint`
/// (chia_wallet_switch::may_mint: a test network, or the desktop app's
/// channel live); otherwise the load refuses with [`MINT_NEEDS_APP`] and
/// writes no file. An identity on disk loads either way.
pub fn load_or_mint_wallet(net: ChiaNet, identity: &Path, legacy: &Path, may_mint: bool) -> Result<WalletIdentity> {
    load_or_mint_wallet_with(net, identity, legacy, may_mint, chia_at_rest::os_store())
}

/// Why a load made no wallet where it may not mint one (Chia mainnet with
/// no desktop app channel): no mainnet wallet should exist whose words
/// nothing can show.
pub const MINT_NEEDS_APP: &str = "On Chia mainnet a new SSF wallet is made only in the desktop app, which can show its 24 words.";

/// [`load_or_mint_wallet`] with the store a locked file is opened by.
pub(crate) fn load_or_mint_wallet_with(
    net: ChiaNet,
    identity: &Path,
    legacy: &Path,
    may_mint: bool,
    store: Option<&dyn SecretStore>,
) -> Result<WalletIdentity> {
    // Raw seeds were only ever testnet11's.
    let legacy = net.is_test().then_some(legacy);
    match legacy {
        Some(legacy) => sweep_stale_tmp(&[identity, legacy]),
        None => sweep_stale_tmp(&[identity]),
    }
    // No lock is taken here: a lock replaces the identity in one rename, so
    // a load reads either whole file, and both open to the same wallet.
    recover_rewrap(net, identity, store)?;
    // `try_exists`, not `exists`: an identity that is there but cannot be
    // looked at (a permission error) is reported, never minted over.
    let present = identity
        .try_exists()
        .with_context(|| format!("looking for chia identity file {}", identity.display()))?;
    let (opened, minted) = if present {
        let opened = read_identity(net, identity, store)?;
        // Only now that it opened: a leftover beside a file that is refused
        // may be the one intact copy of the wallet.
        remove_rewrap_leftovers(identity, opened.keys.fingerprint);
        // Owner-only again, for a copy the operator put back (from a zip, a
        // cloud folder, a FAT stick) with the modes it picked up there.
        restrict_permissions(identity);
        (opened, false)
    } else if !may_mint {
        // Before anything is written: no identity, no temporary file.
        return Err(anyhow!(MINT_NEEDS_APP));
    } else {
        mint_identity(net, identity, store)?
    };
    let Opened { keys, protect: at_rest, .. } = opened;
    // Only now, with the identity durable (installed and its directory
    // synced, or already there), is the raw seed archived.
    let retired = legacy.and_then(|legacy| {
        retire_legacy_seed(legacy, unix_now()).unwrap_or_else(|e| {
            eprintln!(
                "🏦 SSF wallet: could not retire the old {} ({e:#}); it is left as it is and is not this wallet",
                legacy.display()
            );
            None
        })
    });
    Ok(WalletIdentity { wallet: keys.wallet, fingerprint: keys.fingerprint, minted, retired, at_rest })
}

/// For the Bank's reveal only: the 24 words of the identity on disk, read
/// again (the node keeps no copy), with the fingerprint and wallet key they
/// make so the caller can check they are the wallet in use.
pub fn reveal_words(net: ChiaNet, identity: &Path) -> Result<Revealed> {
    reveal_words_with(net, identity, chia_at_rest::os_store())
}

/// [`reveal_words`] with the store a locked file is opened by. It only
/// reads: nothing is written, locked or minted.
pub(crate) fn reveal_words_with(net: ChiaNet, identity: &Path, store: Option<&dyn SecretStore>) -> Result<Revealed> {
    let Opened { entropy, keys, .. } = read_identity(net, identity, store)?;
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
/// `protect`, a field this node does not know) is told apart from a damaged
/// one before anything else is asked of it.
#[derive(Deserialize)]
struct IdentityHeader<'a> {
    v: u64,
    #[serde(borrow, default)]
    kind: Option<&'a str>,
    /// The network the file is for: absent on testnet11's.
    #[serde(borrow, default)]
    net: Option<&'a str>,
    #[serde(borrow, default)]
    protect: Option<&'a str>,
}

/// The v1 body, for every `protect` this node reads; which fields one must
/// have is checked against its `protect`. Borrowed from the read buffer, so
/// the entropy's hex is never copied out of it.
#[derive(Deserialize)]
struct IdentityBody<'a> {
    #[serde(borrow, default)]
    entropy: Option<&'a str>,
    #[serde(borrow, default)]
    blob: Option<&'a str>,
    fingerprint: u32,
    #[serde(default)]
    at: Option<u64>,
    #[serde(default)]
    wrapped_at: Option<u64>,
}

/// An identity file read and checked: its entropy, the keys it makes, how it
/// keeps them, when it was made, and its bytes as read (a lock checks the
/// file did not change under it).
pub(crate) struct Opened {
    entropy: Zeroizing<[u8; ENTROPY_LEN]>,
    keys: ChiaKeys,
    protect: AtRest,
    at: u64,
    raw: Zeroizing<Vec<u8>>,
}

/// Read and check the identity file: the only read site.
///
/// The file is read into a buffer that is wiped when dropped, parsed in
/// steps (the header, the names of its fields, then the body), its entropy
/// decoded, or opened by `store` for a locked file, into another wiped
/// buffer, and the keys derived again: the fingerprint written beside the
/// entropy must match, since the entropy carries no checksum of its own.
///
/// Every refusal is a fixed sentence built fresh, with no source error under
/// it: serde and hex errors can quote the bytes they choked on (a piece of
/// the entropy), and `{e:#}` prints a whole chain. A store's refusal names
/// only its class and number (chia_at_rest::refusal_words). A refused file
/// is left as it is, and nothing is minted over it.
///
/// The file must be `net`'s: testnet11 takes `net` absent or `"testnet11"`,
/// any other network only its own id. A file for another network is refused
/// with a fixed sentence that names the network the node runs on, never what
/// the file says.
fn read_identity(net: ChiaNet, path: &Path, store: Option<&dyn SecretStore>) -> Result<Opened> {
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
    if kind != IDENTITY_KIND {
        return Err(newer());
    }
    if !identity_net_is(header.net, net) {
        return Err(anyhow!(
            "chia identity file {} is not a wallet for {}, the Chia network this node runs on; it is left as it is",
            path.display(),
            net.name()
        ));
    }
    let protect = match protect {
        PROTECT_NONE => AtRest::None,
        PROTECT_DPAPI => AtRest::Dpapi,
        PROTECT_KEYCHAIN => AtRest::Keychain,
        _ => return Err(newer()),
    };
    // A file locked by a store this computer does not have: say whose,
    // before anything else is asked of it.
    let store = match protect {
        AtRest::None => None,
        locked => match store.filter(|s| s.protect() == locked) {
            Some(s) => Some(s),
            None => {
                let e = chia_at_rest::StoreError { refusal: chia_at_rest::Refusal::Foreign(locked), code: chia_at_rest::Code::None };
                return Err(anyhow!("{}", chia_at_rest::refusal_words(path, e)));
            }
        },
    };
    // The names of the fields alone (their values are skipped, not copied):
    // one this node does not know is a newer node's.
    let fields: BTreeMap<&str, serde::de::IgnoredAny> = serde_json::from_slice(&buf).map_err(|_| damaged())?;
    if fields.keys().any(|k| !KNOWN_FIELDS.contains(k)) {
        return Err(newer());
    }
    let body: IdentityBody = serde_json::from_slice(&buf).map_err(|_| damaged())?;
    let mut entropy = Zeroizing::new([0u8; ENTROPY_LEN]);
    match (protect, store) {
        (AtRest::None, _) => {
            let (Some(hex), None, None) = (body.entropy, body.blob, body.wrapped_at) else {
                return Err(damaged());
            };
            if hex.len() != 2 * ENTROPY_LEN {
                return Err(damaged());
            }
            hex::decode_to_slice(hex, &mut entropy[..]).map_err(|_| damaged())?;
        }
        (_, Some(store)) => {
            let (None, Some(blob)) = (body.entropy, body.blob) else {
                return Err(damaged());
            };
            if blob.len() > BLOB_MAX {
                return Err(damaged());
            }
            let sealed = base64::engine::general_purpose::STANDARD.decode(blob).map_err(|_| damaged())?;
            let opened = store
                .unwrap(&sealed, body.fingerprint)
                .map_err(|e| anyhow!("{}", chia_at_rest::refusal_words(path, e)))?;
            if opened.len() != ENTROPY_LEN {
                return Err(damaged());
            }
            entropy.copy_from_slice(&opened);
        }
        (_, None) => unreachable!("a locked file without its store was refused above"),
    }
    let keys = keys_from_entropy(&entropy);
    if keys.fingerprint != body.fingerprint {
        return Err(damaged());
    }
    Ok(Opened { entropy, keys, protect, at: body.at.unwrap_or(0), raw: buf })
}

/// Whether an identity file's `net` (absent, or its value) is `net`'s.
fn identity_net_is(field: Option<&str>, net: ChiaNet) -> bool {
    match (field, net) {
        (None, ChiaNet::Testnet11) => true,
        (None, _) => false,
        (Some(id), net) => id == net.id(),
    }
}

/// What an identity file keeps of its entropy.
pub(crate) enum Body<'a> {
    /// The entropy itself (`protect:"none"`).
    Clear(&'a [u8; ENTROPY_LEN]),
    /// A store's blob of it (`protect:"dpapi"` or `"keychain"`).
    Locked(AtRest, &'a [u8]),
}

/// The identity file's bytes: the one encode site. Always one of these exact
/// shapes, with nothing that needs escaping:
/// `{"v":1,"kind":"bip39-english","protect":"none","entropy":"<64 hex>","fingerprint":N,"at":T}`, or
/// `{"v":1,"kind":"bip39-english","protect":"dpapi","blob":"<base64>","fingerprint":N,"at":T,"wrapped_at":W}`,
/// where a keychain lock has `"protect":"keychain"` and the same fields.
/// On testnet11 that is all. Any other network adds its id after `kind`:
/// `{"v":1,"kind":"bip39-english","net":"mainnet","protect":…`.
fn encode_identity(net: ChiaNet, body: Body<'_>, fingerprint: u32, at: u64, wrapped_at: u64) -> Zeroizing<String> {
    let mut out = Zeroizing::new(String::with_capacity(256 + BLOB_MAX));
    let head = |out: &mut String| {
        out.push_str(r#"{"v":1,"kind":"bip39-english","#);
        if net != ChiaNet::Testnet11 {
            out.push_str(r#""net":""#);
            out.push_str(net.id());
            out.push_str(r#"","#);
        }
    };
    match body {
        Body::Clear(entropy) => {
            let mut digits = Zeroizing::new([0u8; 2 * ENTROPY_LEN]);
            hex::encode_to_slice(&entropy[..], &mut digits[..]).expect("64 hex digits for 32 bytes");
            head(&mut out);
            out.push_str(r#""protect":"none","entropy":""#);
            out.push_str(std::str::from_utf8(&digits[..]).expect("hex digits are ASCII"));
        }
        Body::Locked(protect, blob) => {
            let protect = match protect {
                AtRest::Dpapi => PROTECT_DPAPI,
                AtRest::Keychain => PROTECT_KEYCHAIN,
                AtRest::None => unreachable!("a clear body is Body::Clear"),
            };
            head(&mut out);
            out.push_str(r#""protect":""#);
            out.push_str(protect);
            out.push_str(r#"","blob":""#);
            out.push_str(&base64::engine::general_purpose::STANDARD.encode(blob));
        }
    }
    out.push_str(r#"","fingerprint":"#);
    out.push_str(&fingerprint.to_string());
    out.push_str(r#","at":"#);
    out.push_str(&at.to_string());
    if let Body::Locked(..) = body {
        out.push_str(r#","wrapped_at":"#);
        out.push_str(&wrapped_at.to_string());
    }
    out.push('}');
    out
}

/// First load: fresh entropy from the OS CSPRNG (the same `OsRng` the lane's
/// `seal` nonce uses), installed once ([`install_once`]). The loser of a race
/// loads the winner's identity. The file is `net`'s.
fn mint_identity(net: ChiaNet, path: &Path, store: Option<&dyn SecretStore>) -> Result<(Opened, bool)> {
    let mut entropy = Zeroizing::new([0u8; ENTROPY_LEN]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut entropy[..]);
    let keys = keys_from_entropy(&entropy);
    let at = unix_now();
    let bytes = encode_identity(net, Body::Clear(&entropy), keys.fingerprint, at, 0);
    match install_once(path, bytes.as_bytes())? {
        Installed::Ours => {
            let raw = Zeroizing::new(bytes.as_bytes().to_vec());
            Ok((Opened { entropy, keys, protect: AtRest::None, at, raw }, true))
        }
        Installed::Theirs => Ok((read_identity(net, path, store)?, false)),
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
    // A raw seed was only ever a testnet11 wallet.
    let t11 = ChiaNet::Testnet11;
    Ok(Some(RetiredSeed {
        archived_as,
        old_address: old.as_ref().map(|sk| receive_address(t11, sk)),
        old_beacon: old.as_ref().map(|sk| receive_address(t11, &crate::chia_publish::beacon_wallet_key(sk))),
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

/// Under a lock, once the identity is checked to still hold `raw` (its clear
/// bytes): remove the temporary files beside it (`.<name>.*.tmp`) that hold
/// those same bytes, of any age. Only a stopped mint of this wallet leaves
/// one (or someone copied the file there): a mint in flight draws fresh
/// entropy, so its bytes always differ. Other names, links and files with
/// other bytes are left alone, and only file names are ever printed.
fn remove_clear_temporaries(identity: &Path, raw: &[u8]) {
    let prefix = format!(".{}.", file_name_of(identity));
    let Ok(entries) = std::fs::read_dir(parent_dir(identity)) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !name.strip_prefix(prefix.as_str()).is_some_and(|r| r.ends_with(".tmp")) {
            continue;
        }
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if !matches!(read_capped(&path, FILE_MAX), Ok(Some(b)) if b.as_slice() == raw) {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => println!("🔒 SSF wallet: removed {name}, a temporary file a stopped write left with the key in the clear"),
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => eprintln!(
                "🔒 SSF wallet: could not remove {name}, a temporary file that holds the key in the clear ({e}): delete it"
            ),
        }
    }
}

/// What [`wrap_at_rest`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wrapped {
    /// The file is locked now; `linked` when another name still points at
    /// the old clear file (a hard link someone made), which keeps the key in
    /// the clear there.
    Done { linked: bool },
    /// It was locked already.
    Already(AtRest),
    /// The file holds another wallet than the one in use, locked or not:
    /// nothing changed, and the next start loads that wallet.
    OtherWallet,
    /// Nothing changed, for this reason; the next start tries again.
    Skipped(String),
}

/// The steps of a lock, for tests that stop it at each one as a crash would.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    Read,
    Sealed,
    Written,
    Probed,
    Locked,
    Rechecked,
    Renamed,
}

/// 🔒 Lock the identity file with this computer's store (chia_at_rest.rs),
/// once its words are marked saved: the caller decides that
/// (`chia_at_rest::should_wrap`). The same wallet, the same fingerprint and
/// address; only how the file keeps the entropy changes. The file must be
/// `net`'s, and the locked file names the same network.
pub fn wrap_at_rest(net: ChiaNet, identity: &Path, fingerprint: u32, policy: Policy) -> Wrapped {
    wrap_at_rest_with(net, identity, fingerprint, policy, chia_at_rest::os_store(), &|_| false)
}

/// [`wrap_at_rest`] with its store, and `stop`, which a test uses to end the
/// call at a step the way a crash would: at once, with nothing cleaned up.
///
/// The steps, each of which leaves the file byte for byte as it was until
/// the rename:
/// 1. read the file; another wallet is `OtherWallet`, and a locked one is `Already`;
/// 2. lock the entropy and open the result again, which must give it back;
/// 3. write the locked file whole under `.<name>.rewrap-<pid>-<n>`, synced
///    (no `.tmp` suffix, so the temporary-file sweep leaves it to
///    [`recover_rewrap`]);
/// 4. hard-link it once and remove that link: a folder that cannot (exFAT,
///    FAT) cannot replace a file in one step either, so it stays in the clear;
/// 5. take the identity's lock file, or skip while another node holds it;
/// 6. under it, check the file still holds the bytes read in step 1; then
///    temporary files that hold these same clear bytes (a stopped mint's)
///    are removed, while the identity still holds the same bytes;
/// 7. rename the locked file over the identity: the one step that replaces
///    the clear file, and it either lands whole or not at all;
/// 8. sync the folder on Unix (the old and the new file both open to the
///    same wallet, so a failure there is only logged).
///
/// No store item is ever deleted and nothing ever unlocks a file. Until the
/// rename, the entropy is whole in the identity; after it, in the locked file.
pub(crate) fn wrap_at_rest_with(
    net: ChiaNet,
    identity: &Path,
    fingerprint: u32,
    policy: Policy,
    store: Option<&dyn SecretStore>,
    stop: &dyn Fn(Step) -> bool,
) -> Wrapped {
    let stopped = |step: Step| Wrapped::Skipped(format!("stopped at {step:?}"));
    let Some(store) = store else {
        return Wrapped::Skipped("this computer has no store to lock it with".into());
    };
    if policy != Policy::Os {
        return Wrapped::Skipped(format!("{}=none", chia_at_rest::POLICY_ENV));
    }
    // 1. Read.
    let opened = match read_identity(net, identity, Some(store)) {
        Ok(opened) => opened,
        Err(e) => return Wrapped::Skipped(format!("{e:#}")),
    };
    if opened.keys.fingerprint != fingerprint {
        return Wrapped::OtherWallet;
    }
    if opened.protect != AtRest::None {
        return Wrapped::Already(opened.protect);
    }
    if stop(Step::Read) {
        return stopped(Step::Read);
    }
    // 2. Lock, and open again.
    let blob = match store.wrap(&opened.entropy, fingerprint) {
        Ok(blob) => blob,
        Err(e) => return Wrapped::Skipped(format!("the store refused to lock it ({})", chia_at_rest::short_words(e))),
    };
    match store.unwrap(&blob, fingerprint) {
        Ok(back) if back.as_slice() == &opened.entropy[..] => {}
        Ok(_) => return Wrapped::Skipped("the store gave back other bytes than it locked".into()),
        Err(e) => return Wrapped::Skipped(format!("the store could not open what it locked ({})", chia_at_rest::short_words(e))),
    }
    let bytes = encode_identity(net, Body::Locked(store.protect(), &blob), fingerprint, opened.at, unix_now());
    if bytes.len() > FILE_MAX || base64::engine::general_purpose::STANDARD.encode(&blob).len() > BLOB_MAX {
        return Wrapped::Skipped("the store's locked bytes are too long for the file".into());
    }
    if stop(Step::Sealed) {
        return stopped(Step::Sealed);
    }
    // 3. Write the locked file beside it.
    let dir = parent_dir(identity);
    let name = file_name_of(identity);
    let mut rewrap = None;
    for n in 0..TMP_NAME_ATTEMPTS {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let at = dir.join(format!(".{name}.rewrap-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        match write_new(&at, bytes.as_bytes()) {
            Ok(()) => {
                rewrap = Some(at);
                break;
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists && n + 1 < TMP_NAME_ATTEMPTS => {}
            Err(e) => return Wrapped::Skipped(format!("could not write the locked file ({e})")),
        }
    }
    let Some(rewrap) = rewrap else {
        return Wrapped::Skipped("every name for the locked file is taken".into());
    };
    let give_up = |why: String| {
        let _ = std::fs::remove_file(&rewrap);
        Wrapped::Skipped(why)
    };
    if stop(Step::Written) {
        return stopped(Step::Written);
    }
    // 4. Probe for hard links.
    let probe = PathBuf::from(format!("{}.probe", rewrap.display()));
    let linked = std::fs::hard_link(&rewrap, &probe);
    let _ = std::fs::remove_file(&probe);
    if let Err(e) = linked {
        return give_up(format!(
            "this folder's filesystem cannot hard-link files ({e}), so it cannot replace the file in one step either \
             (exFAT and FAT cannot); run the node from a folder on the system drive"
        ));
    }
    if stop(Step::Probed) {
        return stopped(Step::Probed);
    }
    // 5. The lock file.
    let held = match try_lock_identity(identity) {
        Ok(held) => held,
        Err(why) => return give_up(why),
    };
    if stop(Step::Locked) {
        return stopped(Step::Locked);
    }
    // 6. Unchanged since step 1?
    match read_capped(identity, FILE_MAX) {
        Ok(Some(now)) if now.as_slice() == opened.raw.as_slice() => {}
        Ok(_) => return give_up("the file changed while it was being locked".into()),
        Err(e) => return give_up(format!("the file could not be read again ({e})")),
    }
    // The identity still holds these bytes, so a temporary file removed here
    // is never the only copy; counted before the links, so it is not one.
    remove_clear_temporaries(identity, opened.raw.as_slice());
    let linked = link_count(identity) > 1;
    if stop(Step::Rechecked) {
        return stopped(Step::Rechecked);
    }
    // 7. The rename.
    if let Err(e) = std::fs::rename(&rewrap, identity) {
        return give_up(format!("the locked file could not replace it ({e})"));
    }
    if stop(Step::Renamed) {
        return stopped(Step::Renamed);
    }
    // 8. The folder.
    #[cfg(unix)]
    if let Err(e) = std::fs::File::open(&dir).and_then(|d| d.sync_all()) {
        eprintln!(
            "🔒 SSF wallet: locked {}, but its folder could not be synced ({e}); both forms open to the same wallet",
            identity.display()
        );
    }
    drop(held);
    Wrapped::Done { linked }
}

/// The line a lock prints: what it did, and what it did not reach.
/// `protect` is the store that locked it.
pub fn log_wrapped(identity: &Path, outcome: &Wrapped, protect: AtRest) {
    match outcome {
        Wrapped::Done { linked } => {
            println!("{}", locked_line(identity, protect));
            if *linked {
                eprintln!(
                    "🔒 SSF wallet: another name still points at the old {} (a hard link), and it keeps the key in the clear: delete it",
                    identity.display()
                );
            }
        }
        Wrapped::Already(_) => {}
        Wrapped::OtherWallet => eprintln!(
            "🔒 SSF wallet: {} now holds another wallet than the one in use; this wallet's file is not there to lock, \
             and the next start loads the wallet in that file",
            identity.display()
        ),
        Wrapped::Skipped(why) => eprintln!(
            "🔒 SSF wallet: {} stays in the clear for now ({why}); the node tries again at its next start",
            identity.display()
        ),
    }
}

/// The line of a lock that landed: with which store, and the copies made
/// before it that it did not reach.
fn locked_line(identity: &Path, protect: AtRest) -> String {
    let copies = match protect {
        AtRest::Keychain => "a synced or zipped folder, a Time Machine backup or snapshot",
        AtRest::Dpapi | AtRest::None => "a synced or zipped folder, a backup",
    };
    format!(
        "🔒 SSF wallet: locked {} {}, since its 24 words are saved; copies of it made before this lock ({copies}) \
         still hold the key in the clear: delete them",
        identity.display(),
        chia_at_rest::lock_words(protect)
    )
}

/// Leftovers of a lock that stopped (`.<name>.rewrap-*` and their probes),
/// looked at before every load.
///
/// With the identity gone and a locked file beside it that opens (a rename
/// some filesystem lost, or an identity moved aside mid-lock), the newest
/// such file is put back as the identity, with the same never-replace link
/// as a mint, and nothing is minted over it. A locked copy that does not
/// open now (another account, a locked keychain, a store that fails, a
/// folder from another computer), or one that cannot be put back, stops
/// the mint with an error: it may be the only file that holds the wallet.
/// Only a torn leftover lets a new wallet be minted. Nothing is removed
/// here: leftovers go once the identity has opened
/// ([`remove_rewrap_leftovers`]). Only a copy of `net`'s wallet is put back.
fn recover_rewrap(net: ChiaNet, identity: &Path, store: Option<&dyn SecretStore>) -> Result<()> {
    let mut leftovers = rewrap_leftovers(identity);
    // A `try_exists` error is reported by the loader's own check.
    if leftovers.is_empty() || !matches!(identity.try_exists(), Ok(false)) {
        return Ok(());
    }
    leftovers.sort_by_key(|(_, t)| std::cmp::Reverse(*t));
    let id = identity.display();
    let newest = leftovers
        .iter()
        .filter(|(p, _)| p.extension().is_none_or(|x| x != "probe"))
        .find(|(p, _)| read_identity(net, p, store).is_ok());
    if let Some((found, _)) = newest {
        return match std::fs::hard_link(found, identity) {
            Ok(()) => {
                println!("🔒 SSF wallet: {id} was missing; put back the locked copy a stopped lock left ({})", found.display());
                #[cfg(unix)]
                let _ = std::fs::File::open(parent_dir(identity)).and_then(|d| d.sync_all());
                Ok(())
            }
            // Another loader put it back first: the loader reads that.
            Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(anyhow!(
                "chia identity file {id} is missing, and the locked copy {} a stopped lock left could not be put back ({e}); \
                 no new wallet is minted over it: put it back as {id} by hand",
                found.display()
            )),
        };
    }
    // Nothing opens. A whole locked copy, or one that cannot be read, may
    // still be the only file of a wallet: no mint over it. The newest one
    // is named, with read_identity's own refusal (fixed sentences only).
    let Some((leftover, _)) =
        leftovers.iter().find(|(p, _)| matches!(classify_leftover(p), Leftover::Wallet(_) | Leftover::Unreadable))
    else {
        return Ok(());
    };
    let shown = leftover.display();
    Err(match read_identity(net, leftover, store) {
        Err(e) => anyhow!(
            "chia identity file {id} is missing, and a stopped lock left a locked copy of a wallet beside it, {shown}, \
             that does not open now ({e}); no new wallet is minted over it: start the node as the user, on the computer, \
             that locked it, with its store unlocked, or move {shown} aside to start a new wallet"
        ),
        // A second name of a lock's file, or a store that opened it only on
        // a second try: still not put back by itself.
        Ok(_) => anyhow!(
            "chia identity file {id} is missing, and a stopped lock left a locked copy of a wallet beside it, {shown}, \
             that the node does not put back by itself; no new wallet is minted over it: put it back as {id} by hand"
        ),
    })
}

/// A stopped lock's leftovers beside the identity, with when each was last
/// written (none when that cannot be read).
fn rewrap_leftovers(identity: &Path) -> Vec<(PathBuf, Option<std::time::SystemTime>)> {
    let prefix = format!(".{}.rewrap-", file_name_of(identity));
    let Ok(entries) = std::fs::read_dir(parent_dir(identity)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with(&prefix)))
        .map(|e| (e.path(), e.metadata().and_then(|m| m.modified()).ok()))
        .collect()
}

/// What a stopped lock's leftover holds, told from its shape alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leftover {
    /// Not a whole identity file: a write that stopped part way.
    Torn,
    /// A whole identity file, for this fingerprint.
    Wallet(u32),
    /// It could not be read.
    Unreadable,
}

/// Tell a leftover's shape without the store: its blob is never decoded,
/// and nothing read from it is ever printed.
fn classify_leftover(path: &Path) -> Leftover {
    let buf = match read_capped(path, FILE_MAX) {
        Ok(Some(buf)) => buf,
        // Longer than any file a lock writes.
        Ok(None) => return Leftover::Torn,
        Err(_) => return Leftover::Unreadable,
    };
    if serde_json::from_slice::<IdentityHeader>(&buf).is_err() {
        return Leftover::Torn;
    }
    match serde_json::from_slice::<IdentityBody>(&buf) {
        Ok(body) => Leftover::Wallet(body.fingerprint),
        Err(_) => Leftover::Torn,
    }
}

/// Once the identity has opened to `fingerprint`: remove the leftovers a
/// stopped lock left beside it that are torn or hold that same wallet (the
/// identity holds it whole). One younger than a minute may be a lock in
/// flight in another node, and is left to it. One of another wallet, or one
/// that cannot be read, is kept and named, since it may be the only copy of
/// some wallet.
fn remove_rewrap_leftovers(identity: &Path, fingerprint: u32) {
    for (path, modified) in rewrap_leftovers(identity) {
        let old = modified.and_then(|t| t.elapsed().ok()).is_some_and(|a| a >= TMP_IN_FLIGHT);
        if !old {
            continue;
        }
        match classify_leftover(&path) {
            Leftover::Torn => {}
            Leftover::Wallet(fp) if fp == fingerprint => {}
            Leftover::Wallet(_) | Leftover::Unreadable => {
                eprintln!(
                    "🔒 SSF wallet: kept {}, a locked copy a stopped lock left that is not the wallet in use or cannot be read; \
                     move it aside if it is not needed",
                    path.display()
                );
                continue;
            }
        }
        match std::fs::remove_file(&path) {
            Ok(()) => println!("🔒 SSF wallet: removed {}, left by a lock that stopped", path.display()),
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => eprintln!("🔒 SSF wallet: could not remove {}, left by a lock that stopped ({e})", path.display()),
        }
    }
}

/// The identity's lock file, `.<name>.lock` beside it, which two nodes
/// locking the same file take in turn. Empty; never removed (removing a lock
/// file is what lets two holders in).
fn lock_path(identity: &Path) -> PathBuf {
    parent_dir(identity).join(format!(".{}.lock", file_name_of(identity)))
}

fn open_lock(identity: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(lock_path(identity))
}

/// The identity's lock, now or not at all: a lock skips while another node
/// holds it, or where the folder cannot be locked.
fn try_lock_identity(identity: &Path) -> std::result::Result<std::fs::File, String> {
    let f = open_lock(identity).map_err(|e| format!("its lock file could not be opened ({e})"))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => Err("another node is loading or locking it right now".into()),
        Err(std::fs::TryLockError::Error(e)) => Err(format!("this folder cannot lock files ({e})")),
    }
}

/// How many names point at the file; 1 when that cannot be read.
fn link_count(path: &Path) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).map(|m| m.nlink()).unwrap_or(1)
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let Ok(f) = std::fs::File::open(path) else { return 1 };
        // SAFETY: the struct is plain integers, so all zeros is a valid value.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the handle is f's and stays open for the call; info is a valid out pointer.
        let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut info) };
        if ok == 0 {
            1
        } else {
            u64::from(info.nNumberOfLinks)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        1
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "identity".to_string())
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

/// The standard-puzzle receive address for this key on `net` (`txch1…` on
/// testnet11, `xch1…` on mainnet). The puzzle hash is the same on every
/// network; only the prefix differs.
///
/// Path: secret key -> public key -> synthetic public key
/// (DEFAULT_HIDDEN_PUZZLE_HASH) -> standard puzzle tree hash -> bech32m(prefix).
///
/// Handed the wallet key (m/12381/8444/2/0, [`load_or_mint_wallet`]), this is
/// Chia's index-0 address for the node's 24 words: the first address
/// `chia keys show` and Sage list for them. The node watches only this one.
pub fn receive_address(net: ChiaNet, sk: &SecretKey) -> String {
    let pk: PublicKey = sk.public_key();
    let synthetic_pk: PublicKey = pk.derive_synthetic();
    // curry_tree_hash returns clvm_utils::TreeHash; From<TreeHash> for Bytes32.
    let puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
    Address::new(puzzle_hash, net.prefix().to_string())
        .encode()
        .expect("bech32m encode never fails for a 32-byte puzzle hash")
}

/// Reverse: an address on `net` -> standard puzzle hash (rejects any other
/// network's prefix). Unused until the resolve slice consumes it; keep it as
/// verified public API.
#[allow(dead_code)]
pub fn address_to_puzzle_hash(net: ChiaNet, address: &str) -> Result<Bytes32> {
    let prefix = net.prefix();
    Address::decode(address)
        .map_err(|e| anyhow!("not a valid bech32m address: {e:?}"))?
        .expect_prefix(prefix)
        .map_err(|e| anyhow!("address is not a {} ({prefix}) address: {e:?}", net.name()))
}

/// Printed when the wallet loads (at startup, or when the Bank turns it on):
/// what the load did, the key fingerprint, and the receive address on `net`,
/// with how it is funded there. Never the words.
pub fn log_receive_address(net: ChiaNet, id: &WalletIdentity) {
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
                    "🏦 SSF wallet: retired the old raw-seed wallet {old} (kept as {kept}; its coins stay at that address{beacon})"
                );
            }
            None => println!(
                "🏦 SSF wallet: retired an old chia_identity.seed that was not a 32-byte seed (kept as {kept})"
            ),
        }
    }
    if id.minted && net.is_test() {
        println!(
            "🏦 SSF wallet: made a new wallet from 24 words, key fingerprint {} — back the words up in the SpacePhone's 🏦 BANK \
             (the node never prints them)",
            id.fingerprint
        );
    } else if id.minted {
        // The page never shows the words off a test network.
        println!(
            "🏦 SSF wallet: made a new wallet from 24 words, key fingerprint {}. Only the desktop app shows its words; the node never prints them.",
            id.fingerprint
        );
    } else {
        let kept = match id.at_rest {
            AtRest::None => "",
            AtRest::Dpapi => " (its file locked to this Windows account)",
            AtRest::Keychain => " (its file locked with this Mac user's login keychain)",
        };
        println!("🏦 SSF wallet: loaded the wallet made from 24 words, key fingerprint {}{kept}", id.fingerprint);
    }
    println!("{}", receive_line(net, &receive_address(net, &id.wallet)));
}

/// The receive address's line, and how it is funded on `net`. Off a test
/// network the lane pays for no write from this wallet (stage 4 design
/// §4.5 (1), `chia_publish::money_memo_refusal`), so the line promises none
/// there: funding it would buy no listing. It says nothing of what the
/// lane writes from other keys.
fn receive_line(net: ChiaNet, addr: &str) -> String {
    let fund = if net.is_test() {
        format!("Fund it at a {} faucet. {} is free. Once it holds a coin, the lane can publish/resolve presence.", net.name(), net.ticker())
    } else {
        format!("This address takes real {}. On {} the lane pays for no chain write from it.", net.ticker(), net.name())
    };
    format!("⛓️ ChiaHub lane: {} receive address {addr}\n   {fund}", net.name())
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

    /// The network the existing tests run on: testnet11, whose files and
    /// addresses are what they were before the network became a setting.
    const T11: ChiaNet = ChiaNet::Testnet11;

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
        assert_eq!(receive_address(T11, &k.wallet), "txch10y5nzscm52tkudhr40qtxhypr9y9x670wlee4rveas4pttcwsj7qnxh9ya");

        let k = keys_from_mnemonic(&Mnemonic::parse_normalized(&art_24()).unwrap());
        assert_eq!(k.fingerprint, 1532878573);
        assert_eq!(puzzle_hash_hex(&k.wallet), "d207c1e11fc3b0cd7472e8c7e53c8d2b81709516346c7baa9fbb9070ffccfe89");
        assert_eq!(receive_address(T11, &k.wallet), "txch16grurcglcwcv6arjarr720yd9wqhp9gkx3k8h25lhwg8pl7vl6ys36pefh");

        let k = keys_from_entropy(&entropy_of(HAMSTER_HEX));
        assert_eq!(k.fingerprint, 3552866753, "byte-reversed entropy would give 3701174480");
        assert_eq!(receive_address(T11, &k.wallet), "txch1z7mfs4eqsm3dhxg7y3a497mftavx0xtexrekfr6kn3d0ltjf64tqevsfhk");
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
            assert_eq!(receive_address(T11, &master), pathless, "the path-less address of these words");
            assert_eq!(receive_address(T11, &master_to_wallet_hardened(&master, 0)), hardened);
            let ours = receive_address(T11, &keys_from_mnemonic(&m).wallet);
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
        let beacon = receive_address(T11, &crate::chia_publish::beacon_wallet_key(&wallet));
        assert_eq!(beacon, "txch1jmfqazsfj4fh6vldzjnwas0wudfv8fy5d6w7tcd5v3deddmhm9yqravp4u", "the value this rule gave when it was pinned");
        for idx in 0..4 {
            assert_ne!(beacon, receive_address(T11, &master_to_wallet_unhardened(&master, idx)), "index {idx}");
            assert_ne!(beacon, receive_address(T11, &master_to_wallet_hardened(&master, idx)), "hardened index {idx}");
        }
        assert_ne!(beacon, "txch10wnvld5a9j7evr0la4ss4megqwzdqs66fjweapvzgv8smaw5q5hsxfkaqe", "index 1");
        assert_ne!(beacon, receive_address(T11, &master));
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
        let id = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        assert!(!id.minted && id.retired.is_none());
        assert_eq!(id.fingerprint, 3552866753);
        assert_eq!(puzzle_hash_hex(&id.wallet), "17b698572086e2db991e247b52fb695f5867997930f3648f569c5affae49d556");
        assert_eq!(receive_address(T11, &id.wallet), "txch1z7mfs4eqsm3dhxg7y3a497mftavx0xtexrekfr6kn3d0ltjf64tqevsfhk");
        let raw = entropy_of(HAMSTER_HEX);
        assert_ne!(receive_address(T11, &id.wallet), receive_address(T11, &SecretKey::from_seed(&raw)), "not the entropy as a seed");
        let rev = reveal_words(T11, &identity).unwrap();
        assert_eq!(rev.words().collect::<Vec<_>>(), HAMSTER.split_whitespace().collect::<Vec<_>>());
        assert_eq!(rev.fingerprint, 3552866753);
        assert_eq!(rev.wallet, id.wallet.public_key());

        std::fs::write(&identity, envelope(&"00".repeat(32), 1532878573)).unwrap();
        let id = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        assert_eq!(id.fingerprint, 1532878573);
        assert_eq!(receive_address(T11, &id.wallet), "txch16grurcglcwcv6arjarr720yd9wqhp9gkx3k8h25lhwg8pl7vl6ys36pefh");
        assert_ne!(receive_address(T11, &id.wallet), receive_address(T11, &SecretKey::from_seed(&[0u8; 32])));
        assert_eq!(names(&dir), vec!["chia_identity.json"], "a load writes nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_persists_and_reloads_the_same_wallet() {
        let dir = fresh_dir("persist");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let first = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        assert!(first.minted && first.retired.is_none());
        let again = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        assert!(!again.minted);
        assert_eq!(first.wallet.public_key(), again.wallet.public_key());
        assert_eq!(first.fingerprint, again.fingerprint);
        let addr = receive_address(T11, &first.wallet);
        assert_eq!(addr, receive_address(T11, &again.wallet));
        assert!(addr.starts_with("txch1"), "expected txch1… address, got {addr}");
        let ph = address_to_puzzle_hash(T11, &addr).unwrap();
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
                    let id = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
                    (id.wallet.public_key(), id.minted)
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        let on_disk = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap().wallet.public_key();
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
                    load_or_mint_wallet(T11, &identity, &legacy, true).unwrap().wallet.public_key()
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
            ("a store this node does not know", good.replace(r#""protect":"none""#, r#""protect":"tpm""#)),
            ("another kind", good.replace("bip39-english", "bip39-japanese")),
            ("a field this node does not know", good.replace(r#""at":"#, r#""salt":"x","at":"#)),
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
            let err = format!("{:#}", load_or_mint_wallet(T11, &identity, &legacy, true).unwrap_err());
            assert!(err.contains(says), "{why}: {err}");
            assert_eq!(std::fs::read_to_string(&identity).unwrap(), *text, "{why}: the file is left for recovery");
            assert_eq!(names(&dir), vec!["chia_identity.json"], "{why}: nothing minted beside it");
            assert!(reveal_words(T11, &identity).is_err(), "{why}: nothing revealed");
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
            let e = load_or_mint_wallet(T11, &identity, &dir.join("chia_identity.seed"), true).unwrap_err();
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
        let id = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        assert!(id.minted);
        let retired = id.retired.clone().expect("the legacy seed is retired");
        assert!(!legacy.exists(), "the legacy name is gone");
        assert_eq!(std::fs::read(&retired.archived_as).unwrap(), raw.to_vec(), "the archive holds the same bytes");
        #[cfg(unix)]
        assert_eq!(mode(&retired.archived_as), 0o600, "the archive is owner-only, however the old file was made");
        let archive_name = retired.archived_as.file_name().unwrap().to_string_lossy().into_owned();
        assert!(archive_name.starts_with("chia_identity.seed.retired-"), "{archive_name}");
        assert_eq!(retired.old_address.as_deref(), Some(receive_address(T11, &old_key).as_str()), "the path-less address");
        assert_eq!(
            retired.old_beacon.as_deref(),
            Some(receive_address(T11, &crate::chia_publish::beacon_wallet_key(&old_key)).as_str())
        );
        assert_ne!(receive_address(T11, &id.wallet), receive_address(T11, &old_key), "a new wallet at a new address");
        assert_ne!(
            id.wallet.public_key(),
            keys_from_entropy(&raw).wallet.public_key(),
            "fresh entropy, not the raw seed read as entropy"
        );
        let again = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
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
        let first = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        std::fs::write(&legacy, [3u8; 32]).unwrap();
        let next = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
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
        let id = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
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
        let id = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
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
        let minted = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&identity), 0o600, "minted owner-only");
        std::fs::set_permissions(&identity, std::fs::Permissions::from_mode(0o644)).unwrap();
        let loaded = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        assert_eq!(loaded.fingerprint, minted.fingerprint);
        assert_eq!(mode(&identity), 0o600, "owner-only again after the load");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Reveal and redaction ----------------------------------------------

    #[test]
    fn reveal_reads_back_the_words_of_the_loaded_key() {
        let dir = fresh_dir("reveal");
        let identity = dir.join("chia_identity.json");
        let id = load_or_mint_wallet(T11, &identity, &dir.join("chia_identity.seed"), true).unwrap();
        let rev = reveal_words(T11, &identity).unwrap();
        let words: Vec<&str> = rev.words().collect();
        assert_eq!(words.len(), 24);
        assert_eq!(rev.fingerprint, id.fingerprint);
        assert_eq!(rev.wallet, id.wallet.public_key());
        // The words alone, typed into another wallet, make the same wallet.
        let typed = Mnemonic::parse_normalized(&words.join(" ")).unwrap();
        let k = keys_from_mnemonic(&typed);
        assert_eq!(k.fingerprint, id.fingerprint);
        assert_eq!(k.wallet.public_key(), id.wallet.public_key());
        assert!(reveal_words(T11, &dir.join("missing.json")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_reveal_body_is_the_words_the_key_and_the_address() {
        let dir = fresh_dir("body");
        let identity = dir.join("chia_identity.json");
        std::fs::write(&identity, envelope(HAMSTER_HEX, 3552866753)).unwrap();
        let rev = reveal_words(T11, &identity).unwrap();
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
        let id = load_or_mint_wallet(T11, &identity, &legacy, true).unwrap();
        let rev = reveal_words(T11, &identity).unwrap();
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

    // --- 🔒 At rest ---------------------------------------------------------

    use crate::chia_at_rest::fake::FakeStore;

    fn fields_of(path: &Path) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    fn no_stop(_: Step) -> bool {
        false
    }

    fn age_two_minutes(path: &Path) {
        let two_minutes_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        std::fs::File::options().write(true).open(path).unwrap().set_modified(two_minutes_ago).unwrap();
    }

    /// The stopped locks' leftovers in `dir`.
    fn rewrap_names(dir: &Path) -> Vec<String> {
        names(dir).into_iter().filter(|n| n.contains(".rewrap-")).collect()
    }

    use crate::chia_at_rest::keychain_lock::fake::FakeHands;
    use crate::chia_at_rest::keychain_lock::{self, KeychainHands, KeychainStore};

    /// 🔒 The stores the file's tests run over: the DPAPI fake, and the
    /// keychain store with fake hands (keychain_lock.rs), so every rule of
    /// the file holds for both.
    enum TestStore {
        Dpapi(FakeStore),
        Keychain(KeychainStore<FakeHands>),
    }

    impl TestStore {
        fn both() -> [TestStore; 2] {
            [TestStore::Dpapi(FakeStore::new()), TestStore::Keychain(KeychainStore::new(FakeHands::new()))]
        }

        /// Keys the store made so far: one per DPAPI wrap, and one per
        /// keychain item (its adds), however many locks use it.
        fn made(&self) -> u32 {
            match self {
                TestStore::Dpapi(s) => s.wraps.load(std::sync::atomic::Ordering::Relaxed),
                TestStore::Keychain(s) => s.hands().counts().2,
            }
        }

        /// The file's `protect` field for this store.
        fn protect_field(&self) -> &'static str {
            match self.protect() {
                AtRest::Dpapi => r#""protect":"dpapi""#,
                AtRest::Keychain => r#""protect":"keychain""#,
                AtRest::None => unreachable!("a test store locks"),
            }
        }
    }

    impl SecretStore for TestStore {
        fn protect(&self) -> AtRest {
            match self {
                TestStore::Dpapi(s) => s.protect(),
                TestStore::Keychain(s) => s.protect(),
            }
        }

        fn wrap(&self, entropy: &[u8; 32], fingerprint: u32) -> Result<Vec<u8>, chia_at_rest::StoreError> {
            match self {
                TestStore::Dpapi(s) => s.wrap(entropy, fingerprint),
                TestStore::Keychain(s) => s.wrap(entropy, fingerprint),
            }
        }

        fn unwrap(&self, blob: &[u8], fingerprint: u32) -> Result<Zeroizing<Vec<u8>>, chia_at_rest::StoreError> {
            match self {
                TestStore::Dpapi(s) => s.unwrap(blob, fingerprint),
                TestStore::Keychain(s) => s.unwrap(blob, fingerprint),
            }
        }
    }

    /// A keychain store whose one (unlocked) keychain holds `kek` for the
    /// wallet `fp`, or nothing.
    fn keychain_holding(kek: Option<&[u8; 32]>, fp: u32) -> KeychainStore<FakeHands> {
        let store = KeychainStore::new(FakeHands::new());
        if let Some(kek) = kek {
            store.hands().put_kek(0, &keychain_lock::account(fp), kek);
        }
        store
    }

    /// The locked file's exact bytes, and the clear one's.
    #[test]
    fn the_locked_envelope_has_one_exact_shape() {
        assert_eq!(
            encode_identity(T11, Body::Locked(AtRest::Dpapi, &[0, 1, 2, 3, 4]), 7, 100, 200).as_str(),
            r#"{"v":1,"kind":"bip39-english","protect":"dpapi","blob":"AAECAwQ=","fingerprint":7,"at":100,"wrapped_at":200}"#
        );
        assert_eq!(
            encode_identity(T11, Body::Clear(&entropy_of(HAMSTER_HEX)), 7, 100, 200).as_str(),
            format!(r#"{{"v":1,"kind":"bip39-english","protect":"none","entropy":"{HAMSTER_HEX}","fingerprint":7,"at":100}}"#)
        );
        // The keychain's: the same fields, on testnet11 and on mainnet.
        assert_eq!(
            encode_identity(T11, Body::Locked(AtRest::Keychain, &[0, 1, 2, 3, 4]), 7, 100, 200).as_str(),
            r#"{"v":1,"kind":"bip39-english","protect":"keychain","blob":"AAECAwQ=","fingerprint":7,"at":100,"wrapped_at":200}"#
        );
        assert_eq!(
            encode_identity(ChiaNet::Mainnet, Body::Locked(AtRest::Keychain, &[0, 1, 2, 3, 4]), 7, 100, 200).as_str(),
            r#"{"v":1,"kind":"bip39-english","net":"mainnet","protect":"keychain","blob":"AAECAwQ=","fingerprint":7,"at":100,"wrapped_at":200}"#
        );
        // A real keychain blob is 85 bytes, 116 base64 characters.
        let blob = keychain_lock::seal(&[7; 32], &[9; 24], &[1; 32], 42).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
        assert_eq!((blob.len(), b64.len()), (85, 116));
        let file = encode_identity(T11, Body::Locked(AtRest::Keychain, &blob), u32::MAX, 1_730_000_000, 1_730_000_001);
        assert_eq!(
            file.as_str(),
            format!(
                r#"{{"v":1,"kind":"bip39-english","protect":"keychain","blob":"{b64}","fingerprint":4294967295,"at":1730000000,"wrapped_at":1730000001}}"#
            )
        );
        assert!(file.len() < 300, "{} bytes", file.len());
        // The longest blob the reader takes still fits the file.
        let longest = vec![0u8; BLOB_MAX / 4 * 3];
        assert!(base64::engine::general_purpose::STANDARD.encode(&longest).len() <= BLOB_MAX);
        assert!(encode_identity(T11, Body::Locked(AtRest::Dpapi, &longest), u32::MAX, u64::MAX, u64::MAX).len() < FILE_MAX);
    }

    /// 🔒 A saved wallet is locked in place by either store: the same seven
    /// fields with its own `protect`, the same keys, and a reveal that
    /// writes nothing.
    #[test]
    fn a_saved_wallet_is_locked_in_place_and_opens_to_the_same_wallet() {
        for store in TestStore::both() {
            let protect = store.protect();
            let dir = fresh_dir(&format!("wrap-{protect:?}"));
            let identity = dir.join("chia_identity.json");
            let legacy = dir.join("chia_identity.seed");
            let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
            std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
            let before = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
            assert_eq!(before.at_rest, AtRest::None);

            let clear = std::fs::read(&identity).unwrap();
            reveal_words_with(T11, &identity, Some(&store)).unwrap();
            assert_eq!(std::fs::read(&identity).unwrap(), clear, "{protect:?}: a reveal never writes");

            assert_eq!(
                wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &no_stop),
                Wrapped::Done { linked: false },
                "{protect:?}"
            );
            let text = std::fs::read_to_string(&identity).unwrap();
            assert!(!text.contains(&HAMSTER_HEX[..16]) && !text.contains("entropy"), "the entropy is gone from the file: {text}");
            assert!(text.contains(store.protect_field()) && text.contains(&format!(r#""fingerprint":{fp},"at":1730000000,"wrapped_at":"#)));
            assert_eq!(fields_of(&identity), ["at", "blob", "fingerprint", "kind", "protect", "v", "wrapped_at"]);
            assert_eq!(names(&dir), [".chia_identity.json.lock", "chia_identity.json"], "{protect:?}: no leftovers beside it");
            #[cfg(unix)]
            assert_eq!(mode(&identity), 0o600);

            let after = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
            assert!(!after.minted);
            assert_eq!(after.at_rest, protect);
            assert_eq!((after.fingerprint, after.wallet.public_key()), (before.fingerprint, before.wallet.public_key()));
            let locked = std::fs::read(&identity).unwrap();
            let rev = reveal_words_with(T11, &identity, Some(&store)).unwrap();
            assert!(rev.words().collect::<Vec<_>>().join(" ") == HAMSTER, "{protect:?}: the reveal gives the file's words");
            assert_eq!(std::fs::read(&identity).unwrap(), locked, "{protect:?}: a reveal never writes");

            assert_eq!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &no_stop), Wrapped::Already(protect));
            assert_eq!(std::fs::read(&identity).unwrap(), locked);
            assert_eq!(store.made(), 1, "{protect:?}: locked once");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// What a refusal tells the owner to do with the file.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Advice {
        /// The reader's own sentence: damaged, or a newer node's.
        Fixed,
        /// Not now: start the node again, nothing about keeping or moving.
        Retry,
        /// Keep it: it opens after an unlock, or as the account that made it.
        Keep,
        /// Keep it, and move it aside to start over: it never opens here.
        Move,
    }

    /// A locked file this node cannot open, or one that is damaged, is
    /// refused with a sentence that says what to keep, and left alone. Only
    /// a file that never opens for this account says to move it aside.
    #[test]
    fn a_locked_file_that_does_not_open_is_refused_and_left_alone() {
        use crate::chia_at_rest::keychain_lock::{exit_error, status_error};
        use crate::chia_at_rest::{Code, Refusal, StoreError};
        use Advice::*;
        let entropy = entropy_of(HAMSTER_HEX);
        let fp = keys_from_entropy(&entropy).fingerprint;
        let store = FakeStore::new();
        let blob = store.wrap(&entropy, fp).unwrap();
        let locked = encode_identity(T11, Body::Locked(AtRest::Dpapi, &blob), fp, 1730000000, 1730000001).to_string();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
        let short = base64::engine::general_purpose::STANDARD.encode(&store.wrap(&[1u8; 32], fp).unwrap()[..20]);
        let no_store: Option<&dyn SecretStore> = None;
        let lost = FakeStore::new();
        *lost.unwrap_fails.lock().unwrap() = Some(StoreError { refusal: Refusal::DpapiLost, code: Code::Dpapi(0x8009_000B) });
        let busy = FakeStore::new();
        *busy.unwrap_fails.lock().unwrap() = Some(StoreError { refusal: Refusal::NotNow, code: Code::Dpapi(5) });

        // The same wallet locked with the keychain: its item holds `kek`.
        let kek = [7u8; 32];
        let kblob = keychain_lock::seal(&kek, &[9; 24], &entropy, fp).unwrap();
        let kb64 = base64::engine::general_purpose::STANDARD.encode(&kblob);
        let klocked = encode_identity(T11, Body::Locked(AtRest::Keychain, &kblob), fp, 1730000000, 1730000001).to_string();
        let mut flipped = kblob.clone();
        flipped[40] ^= 0x01;
        let flipped = base64::engine::general_purpose::STANDARD.encode(&flipped);
        let cut = base64::engine::general_purpose::STANDARD.encode(&kblob[..84]);
        let kgood = keychain_holding(Some(&kek), fp);
        let kmissing = keychain_holding(None, fp);
        let kreplaced = keychain_holding(Some(&[8u8; 32]), fp);
        let kforeign = keychain_holding(None, fp);
        kforeign.hands().put(0, &keychain_lock::account(fp), b"made by someone else\n");
        let klocked_now = keychain_holding(Some(&kek), fp);
        klocked_now.hands().set_unlocked(0, Some(false));
        let kasks = keychain_holding(Some(&kek), fp);
        *kasks.hands().read_fails.lock().unwrap() = Some(exit_error(36, Some(true)));
        let knone = keychain_holding(Some(&kek), fp);
        *knone.hands().ready_fails.lock().unwrap() = Some(status_error(-25307, None));
        let kslow = keychain_holding(Some(&kek), fp);
        *kslow.hands().read_fails.lock().unwrap() = Some(StoreError { refusal: Refusal::NotNow, code: Code::TimedOut });

        /// Why, the file, the store, what the refusal says, and its advice.
        type Case<'a> = (&'a str, String, Option<&'a dyn SecretStore>, &'a str, Advice);
        let cases: Vec<Case> = vec![
            ("no store here", locked.clone(), no_store, "locked to a Windows account on the computer that made it", Move),
            ("another account's", locked.clone(), Some(&lost), "another Windows account or PC", Move),
            ("not now", locked.clone(), Some(&busy), "start the node again", Retry),
            ("a DPAPI file at the keychain", locked.clone(), Some(&kgood), "locked to a Windows account on the computer that made it", Move),
            ("entropy beside the blob", locked.replace(r#""blob":"#, &format!(r#""entropy":"{HAMSTER_HEX}","blob":"#)), Some(&store), "refusing to overwrite", Fixed),
            ("no blob", locked.replace(&format!(r#""blob":"{b64}","#), ""), Some(&store), "refusing to overwrite", Fixed),
            ("not base64", locked.replace(&b64, "%%%%"), Some(&store), "refusing to overwrite", Fixed),
            ("an oversized blob", locked.replace(&b64, &"A".repeat(BLOB_MAX + 4)), Some(&store), "refusing to overwrite", Fixed),
            ("opens to 20 bytes", locked.replace(&b64, &short), Some(&store), "refusing to overwrite", Fixed),
            ("another fingerprint", locked.replace(&format!(r#""fingerprint":{fp}"#), &format!(r#""fingerprint":{}"#, fp ^ 1)), Some(&store), "refusing to overwrite", Fixed),
            ("a field this node does not know", locked.replace(r#""at":"#, r#""salt":"x","at":"#), Some(&store), "update Star Station", Fixed),
            ("a clear file that says it was locked", envelope(HAMSTER_HEX, fp).replace(r#""at":"#, r#""wrapped_at":1,"at":"#), Some(&store), "refusing to overwrite", Fixed),
            // 🍎 Locked with the keychain.
            ("a keychain file, no store here", klocked.clone(), no_store, "login keychain of the Mac user that made it", Move),
            ("a keychain file at DPAPI", klocked.clone(), Some(&store), "login keychain of the Mac user that made it", Move),
            ("its item is missing", klocked.clone(), Some(&kmissing), "keychains do not hold (OSStatus -25300)", Move),
            ("its item was made again", klocked.clone(), Some(&kreplaced), "another key than the one this Mac user's keychain now holds", Move),
            ("an item the node did not make", klocked.clone(), Some(&kforeign), "not one this node made", Keep),
            ("a flipped byte", klocked.replace(&kb64, &flipped), Some(&kgood), "its locked key is damaged", Keep),
            ("a cut blob", klocked.replace(&kb64, &cut), Some(&kgood), "its locked key is damaged", Keep),
            ("the keychain is locked", klocked.clone(), Some(&klocked_now), "run security unlock-keychain in this session", Keep),
            ("the item would ask", klocked.clone(), Some(&kasks), "would ask before handing it over (security exit 36)", Keep),
            ("no keychain in this session", klocked.clone(), Some(&knone), "this session has none the node can use (OSStatus -25307)", Keep),
            ("the keychain does not answer", klocked.clone(), Some(&kslow), "right now (security did not answer within 10 s)", Retry),
            ("a keychain blob beside entropy", klocked.replace(r#""blob":"#, &format!(r#""entropy":"{HAMSTER_HEX}","blob":"#)), Some(&kgood), "refusing to overwrite", Fixed),
            ("a keychain file of another fingerprint", klocked.replace(&format!(r#""fingerprint":{fp}"#), &format!(r#""fingerprint":{}"#, fp ^ 1)), Some(&kgood), "keychains do not hold", Move),
            ("a keychain file with a field this node does not know", klocked.replace(r#""at":"#, r#""salt":"x","at":"#), Some(&kgood), "update Star Station", Fixed),
        ];
        for (why, text, store, says, advice) in cases {
            let dir = fresh_dir("locked-refuse");
            let identity = dir.join("chia_identity.json");
            std::fs::write(&identity, &text).unwrap();
            let err = format!("{:#}", load_or_mint_wallet_with(T11, &identity, &dir.join("chia_identity.seed"), true, store).unwrap_err());
            assert!(err.contains(says), "{why}: {err}");
            let (keep, moves) = (err.contains("keep this file"), err.contains("move it aside"));
            match advice {
                Fixed => assert!(!keep, "{why}: {err}"),
                Retry => assert!(!keep && !moves, "{why}: {err}"),
                Keep => assert!(keep && !moves, "{why}: {err}"),
                Move => assert!(keep && moves, "{why}: {err}"),
            }
            for shown in [&b64, &kb64] {
                assert!(!err.contains(&shown[..12]), "{why}: {err}");
            }
            assert!(!err.contains(&HAMSTER_HEX[..12]), "{why}: {err}");
            assert_eq!(std::fs::read_to_string(&identity).unwrap(), text, "{why}: the file is left as it is");
            assert_eq!(names(&dir), ["chia_identity.json"], "{why}: nothing minted beside it");
            assert!(reveal_words_with(T11, &identity, store).is_err(), "{why}");
            let _ = std::fs::remove_dir_all(&dir);
        }
        assert_eq!(kgood.hands().counts().2, 0, "a refused file adds no keychain item");
        // The good keychain opens its own file.
        let dir = fresh_dir("locked-opens");
        let identity = dir.join("chia_identity.json");
        std::fs::write(&identity, &klocked).unwrap();
        let id = load_or_mint_wallet_with(T11, &identity, &dir.join("chia_identity.seed"), true, Some(&kgood)).unwrap();
        assert_eq!((id.fingerprint, id.minted, id.at_rest), (fp, false, AtRest::Keychain));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every way a lock does not land leaves the file byte for byte as it
    /// was, and nothing beside it.
    #[test]
    fn a_lock_that_cannot_land_changes_nothing() {
        use crate::chia_at_rest::keychain_lock::fake::login;
        use crate::chia_at_rest::keychain_lock::{exit_error, status_error};
        use crate::chia_at_rest::{Code, Refusal, StoreError};
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let refuses = FakeStore::new();
        *refuses.wrap_fails.lock().unwrap() = Some(StoreError { refusal: Refusal::NotNow, code: Code::Dpapi(5) });
        let lies = FakeStore::new();
        *lies.unwrap_lies.lock().unwrap() = true;
        let no_store: Option<&dyn SecretStore> = None;
        // 🍎 The keychain: locked, none in this session, an item the node
        // did not make, and an item that would ask once it was made.
        let locked = KeychainStore::new(FakeHands::with(&[(login(), Some(false))]));
        let none_here = KeychainStore::new(FakeHands::with(&[]));
        let foreign = keychain_holding(None, fp);
        foreign.hands().put(0, &keychain_lock::account(fp), b"made by someone else\n");
        let asks = keychain_holding(None, fp);
        *asks.hands().read_fails.lock().unwrap() = Some(exit_error(36, Some(true)));
        let unread = keychain_holding(None, fp);
        *unread.hands().locate_fails.lock().unwrap() = Some(status_error(-25293, Some(true)));
        /// Why, the fingerprint in use, the policy, the store, and the skip's words.
        type Case<'a> = (&'a str, u32, Policy, Option<&'a dyn SecretStore>, &'a str);
        let mut cases: Vec<Case> = vec![
            ("no store", fp, Policy::Os, no_store, "no store"),
            ("the store refuses", fp, Policy::Os, Some(&refuses), "refused to lock it (code 0x5)"),
            ("the store gives back other bytes", fp, Policy::Os, Some(&lies), "other bytes"),
            (
                "the keychain is locked",
                fp,
                Policy::Os,
                Some(&locked),
                "refused to lock it (this Mac user's login keychain is locked for this session, and the node never asks for its password)",
            ),
            ("no keychain here", fp, Policy::Os, Some(&none_here), "no login keychain (OSStatus -25307); a node run as a service can set SSF_WALLET_AT_REST=none"),
            ("an item the node did not make", fp, Policy::Os, Some(&foreign), "that the node did not make; it is left as it is"),
            ("the new item would ask", fp, Policy::Os, Some(&asks), "could not open what it locked (macOS would ask before handing over the key"),
            ("the search is refused", fp, Policy::Os, Some(&unread), "refused to lock it (macOS refused the key (OSStatus -25293))"),
        ];
        let both = TestStore::both();
        for store in &both {
            cases.push(("policy none", fp, Policy::None, Some(store), "=none"));
        }
        for (why, key, policy, store, says) in cases {
            let dir = fresh_dir("wrap-skip");
            let identity = dir.join("chia_identity.json");
            let text = envelope(HAMSTER_HEX, fp);
            std::fs::write(&identity, &text).unwrap();
            match wrap_at_rest_with(T11, &identity, key, policy, store, &no_stop) {
                Wrapped::Skipped(reason) => assert!(reason.contains(says), "{why}: {reason}"),
                other => panic!("{why}: {other:?}"),
            }
            assert_eq!(std::fs::read_to_string(&identity).unwrap(), text, "{why}");
            assert_eq!(names(&dir), ["chia_identity.json"], "{why}");
            let _ = std::fs::remove_dir_all(&dir);
        }
        assert_eq!(locked.hands().counts(), (1, 0, 0), "no run of security against a locked keychain");
        assert_eq!(foreign.hands().counts().2, 0, "no add over an item the node did not make");
        assert_eq!(
            foreign.hands().item(0, &keychain_lock::account(fp)).as_deref(),
            Some(&b"made by someone else\n"[..]),
            "and it is left as it is"
        );

        for good in &both {
            let protect = good.protect();
            // A clear file of another wallet.
            let dir = fresh_dir("wrap-other");
            let identity = dir.join("chia_identity.json");
            let text = envelope(HAMSTER_HEX, fp);
            std::fs::write(&identity, &text).unwrap();
            assert_eq!(wrap_at_rest_with(T11, &identity, fp ^ 1, Policy::Os, Some(good), &no_stop), Wrapped::OtherWallet);
            assert_eq!(std::fs::read_to_string(&identity).unwrap(), text);
            assert_eq!(names(&dir), ["chia_identity.json"]);
            let _ = std::fs::remove_dir_all(&dir);

            // Another node holds the lock file.
            let dir = fresh_dir("wrap-busy");
            let identity = dir.join("chia_identity.json");
            let text = envelope(HAMSTER_HEX, fp);
            std::fs::write(&identity, &text).unwrap();
            let other = open_lock(&identity).unwrap();
            other.lock().unwrap();
            match wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(good), &no_stop) {
                Wrapped::Skipped(reason) => assert!(reason.contains("another node"), "{protect:?}: {reason}"),
                other => panic!("{protect:?}: {other:?}"),
            }
            drop(other);
            assert_eq!(std::fs::read_to_string(&identity).unwrap(), text);
            assert_eq!(names(&dir), [".chia_identity.json.lock", "chia_identity.json"]);

            // The file changes between the read and the rename (another node's
            // write): the lock gives up, and the new bytes stay.
            let changed = text.replace("1730000000", "1730000099");
            let rewrite = |step: Step| {
                if step == Step::Probed {
                    std::fs::write(&identity, &changed).unwrap();
                }
                false
            };
            match wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(good), &rewrite) {
                Wrapped::Skipped(reason) => assert!(reason.contains("changed"), "{protect:?}: {reason}"),
                other => panic!("{protect:?}: {other:?}"),
            }
            assert_eq!(std::fs::read_to_string(&identity).unwrap(), changed);
            assert_eq!(names(&dir), [".chia_identity.json.lock", "chia_identity.json"]);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A lock stopped at any step, as a crash would stop it, loses nothing:
    /// the next load opens the same wallet and mints nothing, a leftover is
    /// kept for a minute and then removed, and the next lock lands. The
    /// keychain makes one item for the wallet across all the retries.
    #[test]
    fn a_lock_stopped_at_any_step_loses_nothing() {
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        for store in TestStore::both() {
            let protect = store.protect();
            for at in [Step::Read, Step::Sealed, Step::Written, Step::Probed, Step::Locked, Step::Rechecked, Step::Renamed] {
                let dir = fresh_dir("wrap-stop");
                let identity = dir.join("chia_identity.json");
                let legacy = dir.join("chia_identity.seed");
                std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
                let stop = |step: Step| step == at;
                let stopped = wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &stop);
                assert!(matches!(stopped, Wrapped::Skipped(_)), "{protect:?} {at:?}");
                let left: Vec<String> = names(&dir).into_iter().filter(|n| n.contains(".rewrap-")).collect();
                let expect_left = matches!(at, Step::Written | Step::Probed | Step::Locked | Step::Rechecked);
                assert_eq!(left.len(), usize::from(expect_left), "{protect:?} {at:?}: {left:?}");
                assert!(left.iter().all(|n| !n.ends_with(".probe")), "{protect:?} {at:?}: no probe is left");

                let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
                assert!(!id.minted, "{protect:?} {at:?}");
                assert_eq!(id.fingerprint, fp, "{protect:?} {at:?}");
                assert_eq!(id.at_rest, if at == Step::Renamed { protect } else { AtRest::None }, "{protect:?} {at:?}");
                // A fresh leftover may be another node's lock in flight: kept.
                assert_eq!(names(&dir).iter().filter(|n| n.contains(".rewrap-")).count(), left.len(), "{protect:?} {at:?}");
                for n in &left {
                    age_two_minutes(&dir.join(n));
                }
                let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
                assert_eq!((id.fingerprint, id.minted), (fp, false), "{protect:?} {at:?}");
                assert!(names(&dir).iter().all(|n| !n.contains(".rewrap-")), "{protect:?} {at:?}: the old leftover is removed");

                let next = wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &no_stop);
                assert!(
                    matches!(next, Wrapped::Done { .. }) || next == Wrapped::Already(protect),
                    "{protect:?} {at:?}: {next:?}"
                );
                let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
                assert_eq!((id.fingerprint, id.minted, id.at_rest), (fp, false, protect), "{protect:?} {at:?}");
                if protect == AtRest::Keychain {
                    assert_eq!(store.made(), 1, "{at:?}: one keychain item across the retries");
                }
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }

    /// With the identity gone and a stopped lock's file beside it, the load
    /// puts that file back rather than minting a new wallet; a leftover
    /// that does not open is never put back.
    #[test]
    fn a_missing_identity_comes_back_from_a_stopped_locks_file() {
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        for store in TestStore::both() {
            let protect = store.protect();
            let dir = fresh_dir("wrap-recover");
            let identity = dir.join("chia_identity.json");
            let legacy = dir.join("chia_identity.seed");
            std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
            let stop = |step: Step| step == Step::Rechecked;
            assert!(matches!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &stop), Wrapped::Skipped(_)));
            std::fs::remove_file(&identity).unwrap();
            let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
            assert_eq!((id.fingerprint, id.minted, id.at_rest), (fp, false, protect));
            let _ = std::fs::remove_dir_all(&dir);

            let dir = fresh_dir("wrap-recover-junk");
            let identity = dir.join("chia_identity.json");
            let junk = dir.join(".chia_identity.json.rewrap-1-0");
            std::fs::write(&junk, b"{\"v\":1").unwrap();
            let id = load_or_mint_wallet_with(T11, &identity, &dir.join("chia_identity.seed"), true, Some(&store)).unwrap();
            assert!(id.minted, "{protect:?}: nothing that opens: a new wallet");
            assert!(junk.exists(), "{protect:?}: a leftover that does not open is left as it is");
            // Once a minute old, beside an identity that opens, the torn
            // leftover is removed.
            age_two_minutes(&junk);
            let again = load_or_mint_wallet_with(T11, &identity, &dir.join("chia_identity.seed"), true, Some(&store)).unwrap();
            assert_eq!((again.fingerprint, again.minted), (id.fingerprint, false));
            assert!(!junk.exists(), "{protect:?}: the torn leftover is gone");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A hard link someone made to the clear file (Unix or NTFS) keeps the
    /// key in the clear under that name: the lock says so.
    #[test]
    fn a_lock_says_when_another_name_still_holds_the_clear_file() {
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let store = FakeStore::new();
        let dir = fresh_dir("wrap-linked");
        let identity = dir.join("chia_identity.json");
        std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
        std::fs::hard_link(&identity, dir.join("backup.json")).unwrap();
        assert_eq!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &no_stop), Wrapped::Done { linked: true });
        assert!(std::fs::read_to_string(dir.join("backup.json")).unwrap().contains(HAMSTER_HEX));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn link_count_counts_every_name() {
        let dir = fresh_dir("links");
        let one = dir.join("one");
        let two = dir.join("two");
        std::fs::write(&one, b"a file").unwrap();
        assert_eq!(link_count(&one), 1);
        std::fs::hard_link(&one, &two).unwrap();
        assert_eq!((link_count(&one), link_count(&two)), (2, 2));
        assert_eq!(link_count(&dir.join("missing")), 1, "a name that cannot be read counts as one");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A locked file of another wallet than the one in use is reported as
    /// another wallet, not as this wallet's lock nor as still in the clear,
    /// and left as it is.
    #[test]
    fn a_locked_file_of_another_wallet_is_not_reported_as_locked() {
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let store = FakeStore::new();
        let dir = fresh_dir("wrap-other-locked");
        let identity = dir.join("chia_identity.json");
        std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
        assert_eq!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &no_stop), Wrapped::Done { linked: false });
        let locked = std::fs::read(&identity).unwrap();
        assert_eq!(wrap_at_rest_with(T11, &identity, fp ^ 1, Policy::Os, Some(&store), &no_stop), Wrapped::OtherWallet);
        assert_eq!(std::fs::read(&identity).unwrap(), locked, "the file is left as it is");
        assert_eq!(names(&dir), [".chia_identity.json.lock", "chia_identity.json"]);
        assert_eq!(store.wraps.load(std::sync::atomic::Ordering::Relaxed), 1, "locked once");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A mint that stopped between its link and removing its temporary file
    /// leaves the key in the clear under that name: the lock removes it (and
    /// a plain copy of the same bytes), and so does not count it as a link.
    /// Another temporary file, a write in flight, and a backup under another
    /// name are left alone.
    #[test]
    fn a_lock_removes_the_clear_temporary_a_stopped_mint_left() {
        let store = FakeStore::new();
        let dir = fresh_dir("wrap-mint-tmp");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let me = std::process::id();
        let other = if me == 1 { 2 } else { me - 1 };
        let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
        assert!(id.minted);
        let fp = id.fingerprint;
        let clear = std::fs::read(&identity).unwrap();
        let linked_tmp = dir.join(format!(".chia_identity.json.{me}-0.tmp"));
        let copied_tmp = dir.join(format!(".chia_identity.json.{other}-1.tmp"));
        let in_flight = dir.join(format!(".chia_identity.json.{other}-2.tmp"));
        std::fs::hard_link(&identity, &linked_tmp).unwrap();
        std::fs::copy(&identity, &copied_tmp).unwrap();
        std::fs::write(&in_flight, b"in flight").unwrap();
        std::fs::copy(&identity, dir.join("backup.json")).unwrap();

        assert_eq!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &no_stop), Wrapped::Done { linked: false });
        assert!(!linked_tmp.exists() && !copied_tmp.exists(), "the clear temporaries are gone");
        assert_eq!(std::fs::read(&in_flight).unwrap(), b"in flight", "a write in flight is not the lock's");
        assert_eq!(std::fs::read(dir.join("backup.json")).unwrap(), clear, "a backup under another name is not the lock's");
        let mut expect = vec![
            ".chia_identity.json.lock".to_string(),
            format!(".chia_identity.json.{other}-2.tmp"),
            "backup.json".to_string(),
            "chia_identity.json".to_string(),
        ];
        expect.sort();
        assert_eq!(names(&dir), expect);
        let after = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
        assert_eq!((after.fingerprint, after.minted, after.at_rest), (fp, false, AtRest::Dpapi));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The clear temporary is removed only after the recheck, while the
    /// identity still holds the same bytes, so a lock that stops right
    /// after removing it loses nothing.
    #[test]
    fn a_lock_removes_a_clear_temporary_only_once_the_file_is_rechecked() {
        let store = FakeStore::new();
        let dir = fresh_dir("wrap-mint-tmp-stop");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
        let fp = id.fingerprint;
        let clear = std::fs::read(&identity).unwrap();
        let tmp = dir.join(format!(".chia_identity.json.{}-0.tmp", std::process::id()));
        std::fs::copy(&identity, &tmp).unwrap();

        let at_locked = |step: Step| step == Step::Locked;
        assert!(matches!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &at_locked), Wrapped::Skipped(_)));
        assert_eq!(std::fs::read(&tmp).unwrap(), clear, "nothing is removed before the recheck");

        let at_rechecked = |step: Step| step == Step::Rechecked;
        assert!(matches!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &at_rechecked), Wrapped::Skipped(_)));
        assert!(!tmp.exists(), "removed once the file is rechecked");
        assert_eq!(std::fs::read(&identity).unwrap(), clear, "the identity still holds the same clear bytes");
        let again = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
        assert_eq!((again.fingerprint, again.minted, again.at_rest), (fp, false, AtRest::None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// With the identity gone and a stopped lock's copy beside it that does
    /// not open now (a store that fails, another Windows account, a locked
    /// keychain, a folder from another computer), the load refuses and mints
    /// nothing, however old the copy is, and keeps it; once the store opens
    /// it, it comes back.
    #[test]
    fn a_missing_identity_beside_a_locked_copy_that_does_not_open_mints_nothing() {
        use crate::chia_at_rest::{Code, Refusal, StoreError};
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let good = FakeStore::new();
        let busy = FakeStore::new();
        *busy.unwrap_fails.lock().unwrap() = Some(StoreError { refusal: Refusal::NotNow, code: Code::Dpapi(5) });
        let lost = FakeStore::new();
        *lost.unwrap_fails.lock().unwrap() = Some(StoreError { refusal: Refusal::DpapiLost, code: Code::Dpapi(0x8009_000B) });
        let no_store: Option<&dyn SecretStore> = None;
        // 🍎 The keychain whose item every lock here reuses, the same item in
        // a keychain that is locked now, and a keychain without it.
        let kek = [7u8; 32];
        let kgood = keychain_holding(Some(&kek), fp);
        let klocked = keychain_holding(Some(&kek), fp);
        klocked.hands().set_unlocked(0, Some(false));
        let kmissing = keychain_holding(None, fp);
        let windows = "locked to a Windows account on the computer that made it";
        let mac = "locked with the login keychain of the Mac user that made it";
        type Cases<'a> = Vec<(&'a str, Option<&'a dyn SecretStore>, &'a str)>;
        let groups: Vec<(&dyn SecretStore, Cases)> = vec![
            (
                &good,
                vec![
                    ("not now", Some(&busy), "could not be opened right now (code 0x5)"),
                    ("another account's", Some(&lost), "another Windows account or PC"),
                    ("no store here", no_store, windows),
                    ("the keychain store", Some(&kgood), windows),
                ],
            ),
            (
                &kgood,
                vec![
                    ("the keychain is locked", Some(&klocked), "run security unlock-keychain in this session"),
                    ("its item is missing", Some(&kmissing), "keychains do not hold"),
                    ("no store here", no_store, mac),
                    ("the DPAPI store", Some(&good), mac),
                ],
            ),
        ];
        let words: Vec<&str> = HAMSTER.split_whitespace().collect();
        for (good, cases) in groups {
            let protect = good.protect();
            for (why, store, says) in cases {
                let dir = fresh_dir("wrap-recover-refused");
                let identity = dir.join("chia_identity.json");
                let legacy = dir.join("chia_identity.seed");
                std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
                let stop = |step: Step| step == Step::Rechecked;
                let stopped = wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(good), &stop);
                assert!(matches!(stopped, Wrapped::Skipped(_)), "{protect:?} {why}");
                std::fs::remove_file(&identity).unwrap();
                let left = rewrap_names(&dir);
                assert_eq!(left.len(), 1, "{protect:?} {why}: {left:?}");
                let leftover = dir.join(&left[0]);

                for aged in [false, true] {
                    if aged {
                        age_two_minutes(&leftover);
                    }
                    let err = format!("{:#}", load_or_mint_wallet_with(T11, &identity, &legacy, true, store).unwrap_err());
                    assert!(err.contains("missing") && err.contains(&left[0]), "{protect:?} {why}: {err}");
                    assert!(err.contains(says), "{protect:?} {why}: {err}");
                    assert!(err.contains("start the node as the user, on the computer, that locked it, with its store unlocked"), "{err}");
                    assert!(!err.contains("Windows account that locked it"), "the advice fits every store: {err}");
                    assert!(!err.contains(&HAMSTER_HEX[..12]), "{protect:?} {why}: {err}");
                    assert!(err.split(|c: char| !c.is_ascii_alphabetic()).all(|t| !words.contains(&t)), "{protect:?} {why}: {err}");
                    assert!(!identity.exists(), "{protect:?} {why}: no new wallet is minted");
                    assert!(leftover.exists(), "{protect:?} {why}: the locked copy is kept");
                }

                let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(good)).unwrap();
                assert_eq!((id.fingerprint, id.minted, id.at_rest), (fp, false, protect), "{protect:?} {why}");
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
        assert_eq!(kgood.hands().counts().2, 0, "every lock reused the keychain's one item");
        assert_eq!(klocked.hands().counts().1, 0, "no run of security against a locked keychain");
    }

    /// An identity that is refused (damaged, or locked and not opening now)
    /// keeps the stopped lock's copy beside it, however old: it may be the
    /// one intact file of the wallet. Moved aside, the copy comes back.
    #[test]
    fn a_damaged_identity_keeps_the_locked_copy_beside_it() {
        use crate::chia_at_rest::{Code, Refusal, StoreError};
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let store = FakeStore::new();
        let dir = fresh_dir("wrap-damaged-keep");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
        let stop = |step: Step| step == Step::Rechecked;
        assert!(matches!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &stop), Wrapped::Skipped(_)));
        let left = rewrap_names(&dir);
        assert_eq!(left.len(), 1, "{left:?}");
        let leftover = dir.join(&left[0]);
        age_two_minutes(&leftover);
        std::fs::write(&identity, b"{\"v\":1").unwrap();
        assert!(load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).is_err());
        assert!(leftover.exists(), "the locked copy is kept beside a damaged identity");
        // The operator moves the damaged file aside, as the refusal says.
        std::fs::remove_file(&identity).unwrap();
        let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
        assert_eq!((id.fingerprint, id.minted, id.at_rest), (fp, false, AtRest::Dpapi));
        let _ = std::fs::remove_dir_all(&dir);

        // A locked identity that does not open now keeps an old copy too.
        let dir = fresh_dir("wrap-refused-keep");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
        assert_eq!(wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&store), &no_stop), Wrapped::Done { linked: false });
        let blob = store.wrap(&entropy_of(HAMSTER_HEX), fp).unwrap();
        let leftover = dir.join(".chia_identity.json.rewrap-9-0");
        std::fs::write(&leftover, encode_identity(T11, Body::Locked(AtRest::Dpapi, &blob), fp, 1730000000, 1730000001).as_bytes())
            .unwrap();
        age_two_minutes(&leftover);
        let busy = FakeStore::new();
        *busy.unwrap_fails.lock().unwrap() = Some(StoreError { refusal: Refusal::NotNow, code: Code::Dpapi(5) });
        assert!(load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&busy)).is_err());
        assert!(leftover.exists(), "the locked copy is kept while the identity does not open");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An old leftover of another wallet (a folder merged from elsewhere) is
    /// kept beside an identity that opens; one of the same wallet is removed.
    #[test]
    fn a_stopped_locks_copy_of_another_wallet_is_kept() {
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let other_fp = keys_from_entropy(&[0u8; 32]).fingerprint;
        assert_ne!(fp, other_fp);
        let store = FakeStore::new();
        let dir = fresh_dir("wrap-other-leftover");
        let identity = dir.join("chia_identity.json");
        let legacy = dir.join("chia_identity.seed");
        std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
        let theirs = dir.join(".chia_identity.json.rewrap-9-0");
        let blob = store.wrap(&[0u8; 32], other_fp).unwrap();
        std::fs::write(&theirs, encode_identity(T11, Body::Locked(AtRest::Dpapi, &blob), other_fp, 1730000000, 1730000001).as_bytes())
            .unwrap();
        let ours = dir.join(".chia_identity.json.rewrap-9-1");
        let blob = store.wrap(&entropy_of(HAMSTER_HEX), fp).unwrap();
        std::fs::write(&ours, encode_identity(T11, Body::Locked(AtRest::Dpapi, &blob), fp, 1730000000, 1730000001).as_bytes()).unwrap();
        age_two_minutes(&theirs);
        age_two_minutes(&ours);
        let id = load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&store)).unwrap();
        assert_eq!((id.fingerprint, id.minted), (fp, false));
        assert!(theirs.exists(), "another wallet's locked copy is kept");
        assert!(!ours.exists(), "the same wallet's old copy is removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- Networks ------------------------------------------------------------

    /// ⛓️ An address on each network: the same puzzle hash under the
    /// network's own prefix, a round trip, and the other prefix refused. The
    /// txch vectors above stay as they were.
    #[test]
    fn each_network_has_its_own_prefix_over_the_same_puzzle_hash() {
        let k = keys_from_entropy(&entropy_of(HAMSTER_HEX));
        assert_eq!(receive_address(ChiaNet::Testnet11, &k.wallet), "txch1z7mfs4eqsm3dhxg7y3a497mftavx0xtexrekfr6kn3d0ltjf64tqevsfhk");
        let ph = puzzle_hash_hex(&k.wallet);
        for net in ChiaNet::ALL {
            let addr = receive_address(net, &k.wallet);
            assert!(addr.starts_with(&format!("{}1", net.prefix())), "{addr}");
            let back = address_to_puzzle_hash(net, &addr).unwrap();
            assert_eq!(hex::encode(back.to_bytes()), ph, "{net:?}: one wallet, one puzzle hash");
            for other in ChiaNet::ALL.into_iter().filter(|o| *o != net) {
                let err = address_to_puzzle_hash(other, &addr).unwrap_err().to_string();
                assert!(err.contains(other.prefix()) && err.contains(other.name()), "{err}");
            }
        }
        assert_ne!(receive_address(ChiaNet::Testnet11, &k.wallet), receive_address(ChiaNet::Mainnet, &k.wallet));
        assert!(receive_address(ChiaNet::Mainnet, &k.wallet).starts_with("xch1"));
    }

    /// The identity file's `net`: testnet11 takes it absent or "testnet11",
    /// mainnet only "mainnet". A refusal is a fixed sentence that never
    /// quotes the file, and the file is left as it is.
    #[test]
    fn an_identity_opens_only_on_its_own_network() {
        let dir = fresh_dir("net-field");
        let identity = dir.join("chia_identity.json");
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let with_net = |net: Option<&str>| match net {
            None => envelope(HAMSTER_HEX, fp),
            Some(n) => format!(
                r#"{{"v":1,"kind":"bip39-english","net":"{n}","protect":"none","entropy":"{HAMSTER_HEX}","fingerprint":{fp},"at":1730000000}}"#
            ),
        };
        let cases = [
            (None, ChiaNet::Testnet11, true),
            (Some("testnet11"), ChiaNet::Testnet11, true),
            (Some("mainnet"), ChiaNet::Testnet11, false),
            (Some("testnet10"), ChiaNet::Testnet11, false),
            (None, ChiaNet::Mainnet, false),
            (Some("testnet11"), ChiaNet::Mainnet, false),
            (Some("mainnet"), ChiaNet::Mainnet, true),
            (Some("Mainnet"), ChiaNet::Mainnet, false),
        ];
        for (field, net, opens) in cases {
            let bytes = with_net(field);
            std::fs::write(&identity, &bytes).unwrap();
            match read_identity(net, &identity, None) {
                Ok(opened) => {
                    assert!(opens, "{field:?} on {net:?} opened");
                    assert_eq!(opened.keys.fingerprint, fp);
                }
                Err(e) => {
                    assert!(!opens, "{field:?} on {net:?}: {e:#}");
                    let e = format!("{e:#}");
                    assert_eq!(
                        e,
                        format!(
                            "chia identity file {} is not a wallet for {}, the Chia network this node runs on; it is left as it is",
                            identity.display(),
                            net.name()
                        )
                    );
                    assert!(!e.contains(&HAMSTER_HEX[..16]) && !e.contains("testnet10") && !e.contains("Mainnet"), "never the file: {e}");
                    assert!(load_or_mint_wallet(net, &identity, &dir.join("chia_identity.seed"), true).is_err(), "never minted over");
                    assert_eq!(std::fs::read_to_string(&identity).unwrap(), bytes, "left as it is");
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A testnet11 mint writes no `net`, byte for byte the shape it always
    /// had; a mainnet mint writes `"net":"mainnet"` and never looks at a
    /// raw seed beside it.
    #[test]
    fn a_mint_names_its_network_only_off_testnet11() {
        let dir = fresh_dir("net-mint");
        let entropy = entropy_of(HAMSTER_HEX);
        let fp = keys_from_entropy(&entropy).fingerprint;
        assert_eq!(encode_identity(ChiaNet::Testnet11, Body::Clear(&entropy), fp, 1730000000, 0).as_str(), envelope(HAMSTER_HEX, fp));
        assert_eq!(
            encode_identity(ChiaNet::Mainnet, Body::Clear(&entropy), fp, 1730000000, 0).as_str(),
            format!(r#"{{"v":1,"kind":"bip39-english","net":"mainnet","protect":"none","entropy":"{HAMSTER_HEX}","fingerprint":{fp},"at":1730000000}}"#)
        );
        assert_eq!(
            encode_identity(ChiaNet::Mainnet, Body::Locked(AtRest::Dpapi, &[0, 1, 2]), 7, 100, 200).as_str(),
            r#"{"v":1,"kind":"bip39-english","net":"mainnet","protect":"dpapi","blob":"AAEC","fingerprint":7,"at":100,"wrapped_at":200}"#
        );

        let t11 = dir.join("t11");
        std::fs::create_dir_all(&t11).unwrap();
        let id = load_or_mint_wallet(ChiaNet::Testnet11, &t11.join("chia_identity.json"), &t11.join("chia_identity.seed"), true).unwrap();
        assert!(id.minted);
        let text = std::fs::read_to_string(t11.join("chia_identity.json")).unwrap();
        assert!(text.starts_with(r#"{"v":1,"kind":"bip39-english","protect":"none","entropy":""#) && !text.contains("net"), "{}", text.len());

        let main = dir.join("chia-mainnet");
        std::fs::create_dir_all(&main).unwrap();
        let legacy = main.join("chia_identity.seed");
        std::fs::write(&legacy, [9u8; 32]).unwrap();
        let identity = main.join("chia_identity.json");
        let id = load_or_mint_wallet(ChiaNet::Mainnet, &identity, &legacy, true).unwrap();
        assert!(id.minted && id.retired.is_none(), "a mainnet load never retires a raw seed");
        assert_eq!(std::fs::read(&legacy).unwrap(), [9u8; 32], "and leaves it as it is");
        let text = std::fs::read_to_string(&identity).unwrap();
        assert!(text.starts_with(r#"{"v":1,"kind":"bip39-english","net":"mainnet","protect":"none","entropy":""#), "{}", text.len());
        let again = load_or_mint_wallet(ChiaNet::Mainnet, &identity, &legacy, true).unwrap();
        assert!(!again.minted);
        assert_eq!(again.wallet.public_key(), id.wallet.public_key());
        assert!(load_or_mint_wallet(ChiaNet::Testnet11, &identity, &legacy, true).is_err(), "a mainnet wallet never opens on testnet11");
        assert!(reveal_words(ChiaNet::Testnet11, &identity).is_err());
        assert_eq!(reveal_words(ChiaNet::Mainnet, &identity).unwrap().fingerprint, id.fingerprint);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🖥️ A mainnet node the desktop app did not start never mints: with no
    /// identity on disk the load refuses, in one fixed sentence, and leaves
    /// the folder as it was; an identity already there still loads. The rule
    /// main.rs passes in is chia_wallet_switch::may_mint.
    #[test]
    fn a_load_that_may_not_mint_refuses_and_writes_nothing_but_still_loads_a_wallet_on_disk() {
        let dir = fresh_dir("may-mint");
        let main = dir.join("chia-mainnet");
        std::fs::create_dir_all(&main).unwrap();
        let identity = main.join("chia_identity.json");
        let legacy = main.join("chia_identity.seed");
        let may = crate::chia_wallet_switch::may_mint(ChiaNet::Mainnet.is_test(), false);
        assert!(!may, "mainnet, no channel");
        let err = load_or_mint_wallet(ChiaNet::Mainnet, &identity, &legacy, may).unwrap_err();
        assert_eq!(format!("{err:#}"), "On Chia mainnet a new SSF wallet is made only in the desktop app, which can show its 24 words.");
        assert_eq!(format!("{err:#}"), MINT_NEEDS_APP);
        assert!(names(&main).is_empty(), "no file written: {:?}", names(&main));
        assert!(load_or_mint_wallet_with(ChiaNet::Mainnet, &identity, &legacy, false, None).is_err());
        assert!(names(&main).is_empty());

        // An identity on disk (the fixed test vector's) still loads, with
        // nothing minted and the file left byte for byte.
        let entropy = entropy_of(HAMSTER_HEX);
        let fp = keys_from_entropy(&entropy).fingerprint;
        let bytes = encode_identity(ChiaNet::Mainnet, Body::Clear(&entropy), fp, 1730000000, 0);
        std::fs::write(&identity, bytes.as_bytes()).unwrap();
        let id = load_or_mint_wallet(ChiaNet::Mainnet, &identity, &legacy, may).unwrap();
        assert!(!id.minted);
        assert_eq!(id.fingerprint, fp);
        assert_eq!(std::fs::read_to_string(&identity).unwrap(), bytes.as_str());
        assert_eq!(names(&main), ["chia_identity.json"]);

        // With the channel on, a mainnet load may mint, as a testnet one may.
        assert!(crate::chia_wallet_switch::may_mint(ChiaNet::Mainnet.is_test(), true));
        assert!(crate::chia_wallet_switch::may_mint(ChiaNet::Testnet11.is_test(), false));
        let fresh = dir.join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        let id = load_or_mint_wallet(ChiaNet::Mainnet, &fresh.join("chia_identity.json"), &fresh.join("chia_identity.seed"), true).unwrap();
        assert!(id.minted);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A lock keeps the file's network: a locked mainnet file still says
    /// `"net":"mainnet"` and opens only there, with either store.
    #[test]
    fn a_locked_file_keeps_its_network() {
        for store in TestStore::both() {
            let protect = store.protect();
            let dir = fresh_dir("net-wrap");
            let identity = dir.join("chia_identity.json");
            let legacy = dir.join("chia_identity.seed");
            let entropy = entropy_of(HAMSTER_HEX);
            let fp = keys_from_entropy(&entropy).fingerprint;
            std::fs::write(&identity, encode_identity(ChiaNet::Mainnet, Body::Clear(&entropy), fp, 1730000000, 0).as_bytes()).unwrap();
            assert_eq!(wrap_at_rest_with(ChiaNet::Testnet11, &identity, fp, Policy::Os, Some(&store), &no_stop), Wrapped::Skipped(format!(
                "chia identity file {} is not a wallet for testnet11, the Chia network this node runs on; it is left as it is",
                identity.display()
            )));
            assert_eq!(wrap_at_rest_with(ChiaNet::Mainnet, &identity, fp, Policy::Os, Some(&store), &no_stop), Wrapped::Done { linked: false });
            let text = std::fs::read_to_string(&identity).unwrap();
            assert!(text.contains(&format!(r#""net":"mainnet",{}"#, store.protect_field())), "{protect:?}: {}", text.len());
            assert_eq!(fields_of(&identity), ["at", "blob", "fingerprint", "kind", "net", "protect", "v", "wrapped_at"]);
            let id = load_or_mint_wallet_with(ChiaNet::Mainnet, &identity, &legacy, true, Some(&store)).unwrap();
            assert_eq!((id.fingerprint, id.at_rest), (fp, protect));
            assert!(load_or_mint_wallet_with(ChiaNet::Testnet11, &identity, &legacy, true, Some(&store)).is_err());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The line of a lock that landed names its store; the Windows one is
    /// as it was.
    #[test]
    fn a_lock_says_which_store_locked_the_file() {
        let p = Path::new("/ssf/chia_identity.json");
        assert_eq!(
            locked_line(p, AtRest::Dpapi),
            "🔒 SSF wallet: locked /ssf/chia_identity.json to this Windows account, since its 24 words are saved; copies of it made \
             before this lock (a synced or zipped folder, a backup) still hold the key in the clear: delete them"
        );
        assert_eq!(
            locked_line(p, AtRest::Keychain),
            "🔒 SSF wallet: locked /ssf/chia_identity.json with this Mac user's login keychain, since its 24 words are saved; \
             copies of it made before this lock (a synced or zipped folder, a Time Machine backup or snapshot) still hold the \
             key in the clear: delete them"
        );
    }

    /// Runs `f` on a thread of its own and waits at most 30 s, so a store
    /// that would prompt fails the test instead of hanging it.
    fn on_a_thread<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(value) => value,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => panic!("{what} took over 30 s: a prompt would have shown"),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panic!("{what} failed on its thread"),
        }
    }

    /// 🍎 One wallet through the keychain store end to end, with any hands:
    /// a clear file is locked, opens and reveals with `at_rest` Keychain;
    /// then a clear copy is stopped at every step of a lock, loses nothing,
    /// and locks again with the one item `items` counts. A store whose
    /// keychains do not hold the item (`elsewhere`) refuses the locked file
    /// as missing, leaves it as it is, and mints nothing. Every call that
    /// reaches the store runs on a thread with a deadline.
    fn a_wallet_locks_with<H: KeychainHands + Send + 'static>(
        tag: &str,
        store: std::sync::Arc<KeychainStore<H>>,
        elsewhere: std::sync::Arc<KeychainStore<H>>,
        items: &dyn Fn() -> usize,
    ) {
        use std::sync::Arc;
        let fp = keys_from_entropy(&entropy_of(HAMSTER_HEX)).fingerprint;
        let lock = |store: &Arc<KeychainStore<H>>, identity: &Path, at: Option<Step>| {
            let (store, identity) = (Arc::clone(store), identity.to_path_buf());
            on_a_thread("a lock", move || {
                wrap_at_rest_with(T11, &identity, fp, Policy::Os, Some(&*store), &|step| Some(step) == at)
            })
        };
        let load = |store: &Arc<KeychainStore<H>>, identity: &Path| {
            let (store, identity) = (Arc::clone(store), identity.to_path_buf());
            on_a_thread("a load", move || {
                let legacy = parent_dir(&identity).join("chia_identity.seed");
                load_or_mint_wallet_with(T11, &identity, &legacy, true, Some(&*store))
                    .map(|id| (id.fingerprint, id.minted, id.at_rest))
                    .map_err(|e| format!("{e:#}"))
            })
        };
        let reveal = |store: &Arc<KeychainStore<H>>, identity: &Path| {
            let (store, identity) = (Arc::clone(store), identity.to_path_buf());
            on_a_thread("a reveal", move || {
                reveal_words_with(T11, &identity, Some(&*store))
                    .map(|rev| (rev.fingerprint, rev.words().collect::<Vec<_>>().join(" ") == HAMSTER))
                    .map_err(|e| format!("{e:#}"))
            })
        };

        // A clear file, locked whole.
        let dir = fresh_dir(&format!("{tag}-done"));
        let identity = dir.join("chia_identity.json");
        std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
        assert_eq!(lock(&store, &identity, None), Wrapped::Done { linked: false });
        let locked = std::fs::read(&identity).unwrap();
        assert!(std::str::from_utf8(&locked).unwrap().contains(r#""protect":"keychain""#), "{} bytes", locked.len());
        assert_eq!(load(&store, &identity), Ok((fp, false, AtRest::Keychain)));
        assert_eq!(reveal(&store, &identity), Ok((fp, true)), "the reveal gives the file's words");
        assert_eq!(std::fs::read(&identity).unwrap(), locked, "a load and a reveal write nothing");
        assert_eq!(items(), 1, "one item for the wallet");

        // A clear copy, stopped at every step: nothing lost, still one item.
        for at in [Step::Read, Step::Sealed, Step::Written, Step::Probed, Step::Locked, Step::Rechecked, Step::Renamed] {
            let dir = fresh_dir(&format!("{tag}-stop"));
            let identity = dir.join("chia_identity.json");
            std::fs::write(&identity, envelope(HAMSTER_HEX, fp)).unwrap();
            assert!(matches!(lock(&store, &identity, Some(at)), Wrapped::Skipped(_)), "{at:?}");
            let renamed = if at == Step::Renamed { AtRest::Keychain } else { AtRest::None };
            assert_eq!(load(&store, &identity), Ok((fp, false, renamed)), "{at:?}");
            for n in rewrap_names(&dir) {
                age_two_minutes(&dir.join(n));
            }
            assert_eq!(load(&store, &identity), Ok((fp, false, renamed)), "{at:?}");
            assert!(rewrap_names(&dir).is_empty(), "{at:?}: the old leftover is removed");
            let next = lock(&store, &identity, None);
            assert!(matches!(next, Wrapped::Done { .. } | Wrapped::Already(AtRest::Keychain)), "{at:?}: {next:?}");
            assert_eq!(load(&store, &identity), Ok((fp, false, AtRest::Keychain)), "{at:?}");
            assert_eq!(items(), 1, "{at:?}: still one item");
            let _ = std::fs::remove_dir_all(&dir);
        }

        // Keychains that do not hold the item: missing, and nothing changes.
        let err = load(&elsewhere, &identity).unwrap_err();
        assert!(err.contains("keychains do not hold") && err.contains("keep this file"), "{err}");
        assert!(reveal(&elsewhere, &identity).is_err());
        assert_eq!(std::fs::read(&identity).unwrap(), locked, "the file is left as it is");
        assert_eq!(names(&dir), [".chia_identity.json.lock", "chia_identity.json"], "nothing minted beside it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The end-to-end keychain run with fake hands, on every OS.
    #[test]
    fn a_wallet_locks_with_a_keychain_store() {
        let store = std::sync::Arc::new(KeychainStore::new(FakeHands::new()));
        let elsewhere = std::sync::Arc::new(KeychainStore::new(FakeHands::new()));
        let counted = std::sync::Arc::clone(&store);
        a_wallet_locks_with("keychain-fake", store, elsewhere, &|| counted.hands().item_count());
        assert_eq!(counted.hands().counts().2, 1, "one add in all");
    }

    /// 🍎 The same run with real keychains, through `/usr/bin/security`: a
    /// temporary keychain of the test's own, and a second one searched for
    /// the same service, which does not hold the item. It runs only with
    /// SSF_KEYCHAIN_TESTS=1 (the macOS CI job), and never touches the login
    /// keychain.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_wallet_locks_with_a_real_keychain() {
        use crate::chia_at_rest::keychain::{tests_enabled, SecurityTool, TempKeychain};
        if !tests_enabled("a_wallet_locks_with_a_real_keychain") {
            return;
        }
        let (tk, other) = (TempKeychain::new(), TempKeychain::new());
        let store = std::sync::Arc::new(tk.store());
        let elsewhere = KeychainStore::new(SecurityTool::at(other.path().to_path_buf(), tk.service().to_string()));
        a_wallet_locks_with("keychain-real", std::sync::Arc::clone(&store), std::sync::Arc::new(elsewhere), &|| tk.item_count());
        assert_eq!(store.hands().counts().2, 0, "the guard refused nothing");
    }

    #[test]
    fn the_receive_line_says_how_each_network_is_funded() {
        let a = "txch1z7mfs4eqsm3dhxg7y3a497mftavx0xtexrekfr6kn3d0ltjf64tqevsfhk";
        assert_eq!(
            receive_line(ChiaNet::Testnet11, a),
            format!("⛓️ ChiaHub lane: testnet11 receive address {a}\n   Fund it at a testnet11 faucet. TXCH is free. Once it holds a coin, the lane can publish/resolve presence.")
        );
        // Stage 4 design §4.5 (1): off a test network the SSF wallet pays
        // for no write, so the mainnet line no longer says a coin there lets
        // the lane publish. It speaks of this address alone, and does not
        // say the lane only reads the chain: a beacon is written from a key
        // of its own.
        let line = receive_line(ChiaNet::Mainnet, "xch1q");
        assert_eq!(line, "⛓️ ChiaHub lane: Chia mainnet receive address xch1q\n   This address takes real XCH. On Chia mainnet the lane pays for no chain write from it.");
        assert!(!line.contains("faucet") && !line.contains("publish") && !line.contains("only reads"), "{line}");
    }
}
