//! 🔒 The macOS keychain lock for the SSF wallet's file, as logic that builds
//! and is tested on every OS. Only its hands ([`KeychainHands`]) touch macOS
//! (keychain.rs); everything that decides is here.
//!
//! The file keeps an 85-byte blob in place of the entropy: the entropy
//! sealed with XChaCha20-Poly1305 under a random 32-byte key (the KEK). The
//! user's login keychain keeps that key, as 64 lowercase hex characters, in
//! one generic-password item per wallet (service [`SERVICE`], account
//! `v1/<fingerprint>`). Neither half alone is the wallet: a copied folder has
//! only the blob, and a read of the item alone gives only the KEK.
//!
//! The blob:
//!
//! | Bytes  | What |
//! |--------|------|
//! | 0..4   | `SSFK` |
//! | 4      | format `0x01` |
//! | 5..13  | key check: the first 8 bytes of `blake3::derive_key` of the KEK |
//! | 13..37 | nonce, 24 bytes from `OsRng` |
//! | 37..69 | the sealed entropy |
//! | 69..85 | the Poly1305 tag |
//!
//! The associated data is `StarStationFurlong/chia_identity/v1/keychain/<fp>`
//! followed by bytes 0..13, so a blob moved under another fingerprint, or
//! with its header or key check edited, does not open. The key check tells
//! "the keychain now holds another key for this wallet" from "this file is
//! damaged", so the refusal can say which.
//!
//! Apple's own `/usr/bin/security` makes and reads the item, never this
//! process: an item a process makes or reads itself is tied to that build
//! of it, so the next update of the node could not open it. The node never
//! lets the keychain ask anything: it checks that the keychain is unlocked
//! before each run of `security`, and a locked one is a refusal that keeps
//! the file. No item is ever deleted or overwritten.
//!
//! "Missing" comes only from the search in this process, never from an exit
//! of `security`: `security find` reports any failure to search as "not
//! found", so its exit 44 after the item was seen means "not now".
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::ffi::OsStr;
use std::fmt;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{Key, Tag, XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use super::{AtRest, Code, Refusal, SecretStore, StoreError};
use crate::chia_wallet_switch::IDENTITY_FILE;

/// The item's service (`-s`). Tests name their own.
pub const SERVICE: &str = "StarStationFurlong.chia_identity";
/// The item's kind (`-D`), and the start of its label (`-l`, the "Name" in
/// Keychain Access).
pub const KIND: &str = "Star Station Furlong wallet lock";
/// Apple's tool, by its absolute path.
pub const SECURITY: &str = "/usr/bin/security";
/// How long one run of `security` may take before it is stopped.
pub const SECURITY_DEADLINE: Duration = Duration::from_secs(10);
/// `security`'s own flags for an add: quiet, and the command read from
/// stdin, so the key never shows in its arguments. Never `-v`, which echoes
/// each command, with the key, to stderr.
pub const ADD_FLAGS: [&str; 2] = ["-q", "-i"];
/// `security -i` reads a line into a buffer this long (with its NUL); a
/// longer line would be cut, and its tail read as another command.
pub const MAX_LINE: usize = 4096;
/// The most of `security find -w`'s output the node reads: 64 hex
/// characters and a newline fit, and anything longer is not our item.
pub const READ_MAX: usize = 80;

/// The blob's length.
pub const BLOB_LEN: usize = 85;
const MAGIC: [u8; 4] = *b"SSFK";
const FORMAT: u8 = 0x01;
const KCV_CONTEXT: &str = "StarStationFurlong chia_identity keychain check v1";
/// The bound header: magic, format and key check.
const HEAD: Range<usize> = 0..13;
const KCV: Range<usize> = 5..13;
const NONCE: Range<usize> = 13..37;
const SEALED: Range<usize> = 37..69;
const TAG: Range<usize> = 69..85;
const KEK_HEX: usize = 64;

/// The OSStatus codes the classes are chosen from (Apple's SecBase.h and
/// MacErrors.h).
pub const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
pub const ERR_SEC_INTERACTION_REQUIRED: i32 = -25315;
pub const ERR_SEC_AUTH_FAILED: i32 = -25293;
pub const USER_CANCELED: i32 = -128;
pub const ERR_SEC_NO_DEFAULT_KEYCHAIN: i32 = -25307;
pub const ERR_SEC_NO_SUCH_KEYCHAIN: i32 = -25294;
pub const ERR_SEC_INVALID_KEYCHAIN: i32 = -25295;
pub const ERR_SEC_NOT_AVAILABLE: i32 = -25291;
pub const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
pub const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;
pub const ERR_SEC_IN_DARK_WAKE: i32 = -25320;
pub const ERR_SEC_MISSING_ENTITLEMENT: i32 = -34018;
pub const IO_ERR: i32 = -36;

/// `security`'s exit status for an OSStatus: its low byte.
pub const fn exit_of(status: i32) -> u8 {
    status as u8
}

const EXIT_INTERACTION_NOT_ALLOWED: u8 = exit_of(ERR_SEC_INTERACTION_NOT_ALLOWED);
const EXIT_INTERACTION_REQUIRED: u8 = exit_of(ERR_SEC_INTERACTION_REQUIRED);
const EXIT_AUTH_FAILED: u8 = exit_of(ERR_SEC_AUTH_FAILED);
const EXIT_NO_DEFAULT_KEYCHAIN: u8 = exit_of(ERR_SEC_NO_DEFAULT_KEYCHAIN);
const EXIT_NO_SUCH_KEYCHAIN: u8 = exit_of(ERR_SEC_NO_SUCH_KEYCHAIN);
const EXIT_INVALID_KEYCHAIN: u8 = exit_of(ERR_SEC_INVALID_KEYCHAIN);
const EXIT_NOT_AVAILABLE: u8 = exit_of(ERR_SEC_NOT_AVAILABLE);
const EXIT_IN_DARK_WAKE: u8 = exit_of(ERR_SEC_IN_DARK_WAKE);
const EXIT_CANCELED: u8 = exit_of(USER_CANCELED);
/// `security find`'s exit for any failure to find (44).
pub const EXIT_NOT_FOUND: u8 = exit_of(ERR_SEC_ITEM_NOT_FOUND);
/// `security add`'s exit when the item is already there (45).
pub const EXIT_DUPLICATE: u8 = exit_of(ERR_SEC_DUPLICATE_ITEM);

/// The class of a status from a Security call in this process. `unlocked`
/// is the keychain's state as last read: an interaction code while it is
/// unlocked means the item's access would ask; while locked, or when the
/// state cannot be read, it means locked. -25300 is never "missing" here:
/// only an empty search says that ([`KeychainHands::locate`]).
pub fn classify_keychain_status(code: i32, unlocked: Option<bool>) -> Refusal {
    match code {
        ERR_SEC_INTERACTION_NOT_ALLOWED | ERR_SEC_INTERACTION_REQUIRED => match unlocked {
            Some(true) => Refusal::KeychainAsks,
            _ => Refusal::KeychainLocked,
        },
        ERR_SEC_AUTH_FAILED | USER_CANCELED => Refusal::KeychainDenied,
        ERR_SEC_NO_DEFAULT_KEYCHAIN | ERR_SEC_NO_SUCH_KEYCHAIN | ERR_SEC_INVALID_KEYCHAIN | ERR_SEC_NOT_AVAILABLE => {
            Refusal::KeychainUnavailable
        }
        // Named so the table reads whole: no entitlement for another kind
        // of keychain, a disk error, a Mac in dark wake, "not found" from
        // anything but the search, and "already there".
        ERR_SEC_MISSING_ENTITLEMENT | IO_ERR | ERR_SEC_IN_DARK_WAKE | ERR_SEC_ITEM_NOT_FOUND | ERR_SEC_DUPLICATE_ITEM => {
            Refusal::NotNow
        }
        _ => Refusal::NotNow,
    }
}

/// The class of a `security` exit status (the low byte of its OSStatus).
/// `unlocked_now` is the keychain's state read again after the exit. 44
/// ("not found") and 45 ("already there") are not now: the store reads
/// "missing" only from its own search, and handles a duplicate add itself.
/// 128 is a dialog's Cancel; 0 is no failure, and is never asked about.
pub fn classify_security_exit(exit: u8, unlocked_now: Option<bool>) -> Refusal {
    match exit {
        EXIT_INTERACTION_NOT_ALLOWED | EXIT_INTERACTION_REQUIRED => match unlocked_now {
            Some(true) => Refusal::KeychainAsks,
            _ => Refusal::KeychainLocked,
        },
        EXIT_AUTH_FAILED => Refusal::KeychainDenied,
        EXIT_NO_DEFAULT_KEYCHAIN | EXIT_NO_SUCH_KEYCHAIN | EXIT_INVALID_KEYCHAIN | EXIT_NOT_AVAILABLE => {
            Refusal::KeychainUnavailable
        }
        EXIT_NOT_FOUND | EXIT_DUPLICATE | EXIT_IN_DARK_WAKE | EXIT_CANCELED => Refusal::NotNow,
        _ => Refusal::NotNow,
    }
}

/// A failed Security call in this process, classed.
pub fn status_error(code: i32, unlocked: Option<bool>) -> StoreError {
    StoreError { refusal: classify_keychain_status(code, unlocked), code: Code::OsStatus(code) }
}

/// A failed run of `security`, classed.
pub fn exit_error(exit: u8, unlocked_now: Option<bool>) -> StoreError {
    StoreError { refusal: classify_security_exit(exit, unlocked_now), code: Code::Exit(exit) }
}

fn error(refusal: Refusal) -> StoreError {
    StoreError { refusal, code: Code::None }
}

/// The item's account (`-a`): fixed per wallet, so every wrap of it, and a
/// wrap after a crash, finds the same item.
pub fn account(fingerprint: u32) -> String {
    format!("v1/{fingerprint}")
}

/// The item's label (`-l`).
pub fn label(fingerprint: u32) -> String {
    format!("{KIND} {fingerprint}")
}

/// The item's comment (`-j`): what it opens, for whoever finds it in
/// Keychain Access.
pub fn comment(fingerprint: u32) -> String {
    format!(
        "Opens {IDENTITY_FILE} of the Star Station Furlong wallet with key fingerprint {fingerprint} for this Mac user. \
         Without it that file does not open; the 24 words of the wallet restore it anywhere."
    )
}

/// The first 8 bytes of a key-derivation of the KEK: says which key locked
/// a blob without saying anything about the key.
fn kcv(kek: &[u8; 32]) -> [u8; 8] {
    let full = Zeroizing::new(blake3::derive_key(KCV_CONTEXT, &kek[..]));
    let mut out = [0u8; 8];
    out.copy_from_slice(&full[..8]);
    out
}

/// The associated data: this use, the fingerprint and the blob's header.
fn aad(fingerprint: u32, head: &[u8]) -> Vec<u8> {
    let mut aad = format!("StarStationFurlong/chia_identity/v1/keychain/{fingerprint}").into_bytes();
    aad.extend_from_slice(head);
    aad
}

/// Seal the entropy under the KEK with this nonce. It is sealed in place,
/// in a buffer that is wiped if anything fails.
pub fn seal(kek: &[u8; 32], nonce: &[u8; 24], entropy: &[u8; 32], fingerprint: u32) -> Result<Vec<u8>, StoreError> {
    let mut blob = Zeroizing::new(Vec::with_capacity(BLOB_LEN));
    blob.extend_from_slice(&MAGIC);
    blob.push(FORMAT);
    blob.extend_from_slice(&kcv(kek));
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(entropy);
    let aad = aad(fingerprint, &blob[HEAD]);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&kek[..]));
    let tag = cipher
        .encrypt_in_place_detached(XNonce::from_slice(nonce), &aad, &mut blob[SEALED])
        .map_err(|_| error(Refusal::NotNow))?;
    blob.extend_from_slice(&tag);
    debug_assert_eq!(blob.len(), BLOB_LEN);
    Ok(std::mem::take(&mut *blob))
}

/// A blob of the right length, magic and format, checked before anything
/// is asked of the keychain.
fn check_shape(blob: &[u8]) -> Result<(), StoreError> {
    if blob.len() != BLOB_LEN || blob[..4] != MAGIC || blob[4] != FORMAT {
        return Err(error(Refusal::KeychainDamaged));
    }
    Ok(())
}

/// What one KEK makes of a blob.
enum Opened {
    Entropy(Zeroizing<Vec<u8>>),
    /// The key check is another key's: try the next keychain.
    OtherKey,
}

/// Open a blob of the right shape with one KEK. The key check picks the
/// key; with the right key, a failed tag is damage.
fn open_with(blob: &[u8], kek: &[u8; 32], fingerprint: u32) -> Result<Opened, StoreError> {
    if kcv(kek)[..] != blob[KCV] {
        return Ok(Opened::OtherKey);
    }
    let aad = aad(fingerprint, &blob[HEAD]);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&kek[..]));
    let mut entropy = Zeroizing::new(Vec::with_capacity(SEALED.len()));
    entropy.extend_from_slice(&blob[SEALED]);
    cipher
        .decrypt_in_place_detached(XNonce::from_slice(&blob[NONCE]), &aad, &mut entropy[..], Tag::from_slice(&blob[TAG]))
        .map_err(|_| error(Refusal::KeychainDamaged))?;
    Ok(Opened::Entropy(entropy))
}

/// The KEK from what `security find -w` printed: exactly 64 lowercase hex
/// characters and a newline. Anything else is an item this node did not
/// make, and is never overwritten.
pub fn kek_of(output: &[u8]) -> Result<Zeroizing<[u8; 32]>, StoreError> {
    let digits = match output {
        [digits @ .., b'\n'] if digits.len() == KEK_HEX => digits,
        _ => return Err(error(Refusal::KeychainDamaged)),
    };
    if !digits.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(error(Refusal::KeychainDamaged));
    }
    let mut kek = Zeroizing::new([0u8; 32]);
    hex::decode_to_slice(digits, &mut kek[..]).map_err(|_| error(Refusal::KeychainDamaged))?;
    Ok(kek)
}

/// The KEK as the item keeps it: 64 lowercase hex characters.
pub fn kek_hex(kek: &[u8; 32]) -> Zeroizing<[u8; KEK_HEX]> {
    let mut digits = Zeroizing::new([0u8; KEK_HEX]);
    hex::encode_to_slice(&kek[..], &mut digits[..]).expect("64 hex digits for 32 bytes");
    digits
}

/// `security`'s arguments for a read of the item in exactly one keychain.
/// Nothing secret: the key comes back on stdout.
pub fn find_args<'a>(service: &'a str, account: &'a str, keychain: &'a Path) -> [&'a OsStr; 7] {
    [
        OsStr::new("find-generic-password"),
        OsStr::new("-s"),
        OsStr::new(service),
        OsStr::new("-a"),
        OsStr::new(account),
        OsStr::new("-w"),
        keychain.as_os_str(),
    ]
}

/// A value `security -i` reads back as one argument: in double quotes, with
/// `\` and `"` escaped. Its line splitter takes both quote kinds and
/// backslash escapes, so a `'` inside double quotes is plain.
fn push_quoted(line: &mut String, value: &str) {
    line.push('"');
    for c in value.chars() {
        if c == '"' || c == '\\' {
            line.push('\\');
        }
        line.push(c);
    }
    line.push('"');
}

/// The one line `security -q -i` reads on stdin to add the item:
///
/// `add-generic-password -s "<service>" -a "v1/<fp>" -l "<label>" -D "<kind>" -j "<comment>" -w <64 hex> "<keychain>"`
///
/// and a newline. Never `-U` (it would overwrite an item a locked file
/// depends on), `-A` or `-T` (the item's only trusted app stays `security`
/// itself). The line is built in a buffer reserved up front and wiped when
/// dropped; the key never shows in any process's arguments. A value with a
/// newline or NUL, or a line too long to be read whole, is refused.
pub fn add_line(
    service: &str,
    account: &str,
    label: &str,
    comment: &str,
    kek: &[u8; 32],
    keychain: &Path,
) -> Result<Zeroizing<String>, StoreError> {
    let refused = || error(Refusal::NotNow);
    let path = keychain.to_str().ok_or_else(refused)?;
    let values = [service, account, label, KIND, comment, path];
    if values.iter().any(|v| v.contains(['\n', '\0'])) {
        return Err(refused());
    }
    let room = 64 + KEK_HEX + values.iter().map(|v| 2 * v.len() + 6).sum::<usize>();
    let mut line = Zeroizing::new(String::with_capacity(room));
    let reserved = line.capacity();
    line.push_str("add-generic-password");
    for (flag, value) in [("-s", service), ("-a", account), ("-l", label), ("-D", KIND), ("-j", comment)] {
        line.push(' ');
        line.push_str(flag);
        line.push(' ');
        push_quoted(&mut line, value);
    }
    line.push_str(" -w ");
    let digits = kek_hex(kek);
    line.push_str(std::str::from_utf8(&digits[..]).expect("hex digits are ASCII"));
    line.push(' ');
    push_quoted(&mut line, path);
    line.push('\n');
    debug_assert_eq!(line.capacity(), reserved, "the line never moved, so no copy of the key was left behind");
    if line.len() >= MAX_LINE {
        return Err(refused());
    }
    Ok(line)
}

/// A keychain that holds the item, or where a new one goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spot {
    /// The keychain's own file, which every `security` run names.
    pub path: PathBuf,
    /// Its lock state when it was found: `None` when it could not be read,
    /// which counts as locked.
    pub unlocked: Option<bool>,
}

/// The only part of the store that touches macOS (keychain.rs; a fake in
/// tests). None of these may show a prompt.
pub trait KeychainHands: Sync {
    /// The item's service, the same for every call.
    fn service(&self) -> &str;
    /// Turns keychain prompts off for the process (once, for good), and
    /// checks that a keychain exists. Called before any other hand.
    fn ready(&self) -> Result<(), StoreError>;
    /// Every keychain on the search list that holds the item, in order, at
    /// most four, each with its path and lock state. A search in this
    /// process, for attributes only, so nothing can prompt. Nothing found
    /// (-25300) is an empty list, the only way to say missing.
    fn locate(&self, account: &str) -> Result<Vec<Spot>, StoreError>;
    /// The default keychain, where a new item goes.
    fn default_spot(&self) -> Result<Spot, StoreError>;
    /// The spot's lock state, read again now.
    fn unlocked(&self, spot: &Spot) -> Option<bool>;
    /// `security find-generic-password -s <service> -a <account> -w <path>`:
    /// the item's KEK ([`kek_of`]). Its failure is classed by its exit.
    fn read(&self, spot: &Spot, account: &str) -> Result<Zeroizing<[u8; 32]>, StoreError>;
    /// `security -q -i` with [`add_line`] on stdin: a new item in that
    /// keychain. Its failure is classed by its exit.
    fn add(&self, spot: &Spot, account: &str, label: &str, comment: &str, kek: &[u8; 32]) -> Result<(), StoreError>;
}

/// The keychain store: a [`SecretStore`] whose KEK lives in a keychain
/// item that its hands read and make.
pub struct KeychainStore<H> {
    hands: H,
}

impl<H> KeychainStore<H> {
    pub const fn new(hands: H) -> KeychainStore<H> {
        KeychainStore { hands }
    }

    /// Tests read the hands' counts and set their faults through this.
    #[cfg(test)]
    pub fn hands(&self) -> &H {
        &self.hands
    }
}

impl<H: KeychainHands> fmt::Debug for KeychainStore<H> {
    /// The service only: nothing read from a keychain.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeychainStore").field("service", &self.hands.service()).finish()
    }
}

impl<H: KeychainHands> KeychainStore<H> {
    /// A `security` exit that can mean "locked" is classed again with the
    /// keychain's state read now: locked now is locked, still unlocked is
    /// an item that would ask.
    fn settle(&self, spot: &Spot, e: StoreError) -> StoreError {
        match e.code {
            Code::Exit(exit @ (EXIT_INTERACTION_NOT_ALLOWED | EXIT_INTERACTION_REQUIRED)) => {
                exit_error(exit, self.hands.unlocked(spot))
            }
            _ => e,
        }
    }

    /// Read the item at one spot, but never run `security` against a
    /// keychain that is not known to be unlocked.
    fn read_at(&self, spot: &Spot, account: &str) -> Result<Zeroizing<[u8; 32]>, StoreError> {
        if spot.unlocked != Some(true) {
            return Err(error(Refusal::KeychainLocked));
        }
        self.hands.read(spot, account).map_err(|e| self.settle(spot, e))
    }

    /// The KEK of the item that is already there (the first keychain that
    /// holds it), or none when no keychain does.
    fn existing(&self, account: &str) -> Result<Option<Zeroizing<[u8; 32]>>, StoreError> {
        match self.hands.locate(account)?.first() {
            None => Ok(None),
            Some(spot) => self.read_at(spot, account).map(Some),
        }
    }

    /// A new item with a new KEK in the default keychain. `security -i`'s
    /// exit is not trusted alone: after any failed add the item is looked
    /// for once more, and used if it is there (another node's that came
    /// first, or ours that landed before the failure).
    fn create(&self, account: &str, fingerprint: u32) -> Result<Zeroizing<[u8; 32]>, StoreError> {
        let spot = self.hands.default_spot()?;
        if spot.unlocked != Some(true) {
            return Err(error(Refusal::KeychainLocked));
        }
        let mut kek = Zeroizing::new([0u8; 32]);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut kek[..]);
        let failed = match self.hands.add(&spot, account, &label(fingerprint), &comment(fingerprint), &kek) {
            Ok(()) => return Ok(kek),
            Err(e) => e,
        };
        match self.existing(account)? {
            Some(landed) => Ok(landed),
            None if failed.code == Code::Exit(EXIT_DUPLICATE) => Err(StoreError { refusal: Refusal::NotNow, ..failed }),
            None => Err(self.settle(&spot, failed)),
        }
    }
}

impl<H: KeychainHands> SecretStore for KeychainStore<H> {
    fn protect(&self) -> AtRest {
        AtRest::Keychain
    }

    /// The item that is there is reused (one item per wallet, whatever
    /// crashed before); only when no keychain holds one is a new one made.
    fn wrap(&self, entropy: &[u8; 32], fingerprint: u32) -> Result<Vec<u8>, StoreError> {
        self.hands.ready()?;
        let account = account(fingerprint);
        let kek = match self.existing(&account)? {
            Some(kek) => kek,
            None => self.create(&account, fingerprint)?,
        };
        let mut nonce = [0u8; 24];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
        seal(&kek, &nonce, entropy, fingerprint)
    }

    /// Each keychain that holds the item is tried in order: a locked one is
    /// skipped without a run of `security`, and one whose key is another
    /// key's is passed by. Nothing opened: locked if any was locked, else
    /// the item was made again since.
    fn unwrap(&self, blob: &[u8], fingerprint: u32) -> Result<Zeroizing<Vec<u8>>, StoreError> {
        check_shape(blob)?;
        self.hands.ready()?;
        let account = account(fingerprint);
        let spots = self.hands.locate(&account)?;
        if spots.is_empty() {
            return Err(StoreError { refusal: Refusal::KeychainMissing, code: Code::OsStatus(ERR_SEC_ITEM_NOT_FOUND) });
        }
        let mut any_locked = false;
        for spot in &spots {
            if spot.unlocked != Some(true) {
                any_locked = true;
                continue;
            }
            let kek = self.read_at(spot, &account)?;
            match open_with(blob, &kek, fingerprint)? {
                Opened::Entropy(entropy) => return Ok(entropy),
                Opened::OtherKey => {}
            }
        }
        Err(error(if any_locked { Refusal::KeychainLocked } else { Refusal::KeychainReplaced }))
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! Hands for tests on any OS: keychains in search-list order, each with
    //! items by account, faults on demand, and counts of the searches, the
    //! reads and the adds (the runs of `security`).
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    pub const FAKE_SERVICE: &str = "StarStationFurlong.chia_identity.test-fake";

    pub struct FakeKeychain {
        pub path: PathBuf,
        pub unlocked: Option<bool>,
        /// What `security find -w` prints for each account.
        pub items: HashMap<String, Zeroizing<Vec<u8>>>,
    }

    pub struct FakeHands {
        /// The search list; the first is the default keychain.
        pub keychains: Mutex<Vec<FakeKeychain>>,
        pub ready_fails: Mutex<Option<StoreError>>,
        pub locate_fails: Mutex<Option<StoreError>>,
        pub default_fails: Mutex<Option<StoreError>>,
        /// Every read fails with this.
        pub read_fails: Mutex<Option<StoreError>>,
        /// Every add fails with this, and lands nothing.
        pub add_fails: Mutex<Option<StoreError>>,
        /// What `unlocked` says in place of the keychain's own state.
        pub unlocked_now: Mutex<Option<Option<bool>>>,
        /// At the next add, another node adds this key first, so ours
        /// gets exit 45.
        pub duplicate_next_add: Mutex<Option<[u8; 32]>>,
        /// The next add lands, then reports this.
        pub fail_after_landed: Mutex<Option<StoreError>>,
        pub locates: AtomicU32,
        pub reads: AtomicU32,
        pub adds: AtomicU32,
    }

    pub fn login() -> PathBuf {
        PathBuf::from("/Users/player/Library/Keychains/login.keychain-db")
    }

    impl FakeHands {
        /// One unlocked login keychain, empty.
        pub fn new() -> FakeHands {
            FakeHands::with(&[(login(), Some(true))])
        }

        /// These keychains, in this order, empty.
        pub fn with(keychains: &[(PathBuf, Option<bool>)]) -> FakeHands {
            FakeHands {
                keychains: Mutex::new(
                    keychains
                        .iter()
                        .map(|(path, unlocked)| FakeKeychain { path: path.clone(), unlocked: *unlocked, items: HashMap::new() })
                        .collect(),
                ),
                ready_fails: Mutex::new(None),
                locate_fails: Mutex::new(None),
                default_fails: Mutex::new(None),
                read_fails: Mutex::new(None),
                add_fails: Mutex::new(None),
                unlocked_now: Mutex::new(None),
                duplicate_next_add: Mutex::new(None),
                fail_after_landed: Mutex::new(None),
                locates: AtomicU32::new(0),
                reads: AtomicU32::new(0),
                adds: AtomicU32::new(0),
            }
        }

        /// Put an item in keychain `at` (an index), as `security` would print it.
        pub fn put(&self, at: usize, account: &str, printed: &[u8]) {
            self.keychains.lock().unwrap()[at].items.insert(account.to_string(), Zeroizing::new(printed.to_vec()));
        }

        /// Put an item that holds this KEK, as the node makes it.
        pub fn put_kek(&self, at: usize, account: &str, kek: &[u8; 32]) {
            let mut printed = kek_hex(kek).to_vec();
            printed.push(b'\n');
            self.put(at, account, &printed);
        }

        /// What keychain `at` keeps for an account.
        pub fn item(&self, at: usize, account: &str) -> Option<Vec<u8>> {
            self.keychains.lock().unwrap()[at].items.get(account).map(|v| v.to_vec())
        }

        /// How many items all keychains keep.
        pub fn item_count(&self) -> usize {
            self.keychains.lock().unwrap().iter().map(|k| k.items.len()).sum()
        }

        pub fn remove(&self, at: usize, account: &str) {
            self.keychains.lock().unwrap()[at].items.remove(account);
        }

        pub fn set_unlocked(&self, at: usize, unlocked: Option<bool>) {
            self.keychains.lock().unwrap()[at].unlocked = unlocked;
        }

        /// (searches, reads, adds) so far.
        pub fn counts(&self) -> (u32, u32, u32) {
            (self.locates.load(Ordering::Relaxed), self.reads.load(Ordering::Relaxed), self.adds.load(Ordering::Relaxed))
        }

        fn state_of(&self, path: &Path) -> Option<bool> {
            self.keychains.lock().unwrap().iter().find(|k| k.path == path).and_then(|k| k.unlocked)
        }
    }

    impl KeychainHands for FakeHands {
        fn service(&self) -> &str {
            FAKE_SERVICE
        }

        fn ready(&self) -> Result<(), StoreError> {
            match *self.ready_fails.lock().unwrap() {
                Some(e) => Err(e),
                None => Ok(()),
            }
        }

        fn locate(&self, account: &str) -> Result<Vec<Spot>, StoreError> {
            self.locates.fetch_add(1, Ordering::Relaxed);
            if let Some(e) = *self.locate_fails.lock().unwrap() {
                return Err(e);
            }
            Ok(self
                .keychains
                .lock()
                .unwrap()
                .iter()
                .filter(|k| k.items.contains_key(account))
                .take(4)
                .map(|k| Spot { path: k.path.clone(), unlocked: k.unlocked })
                .collect())
        }

        fn default_spot(&self) -> Result<Spot, StoreError> {
            if let Some(e) = *self.default_fails.lock().unwrap() {
                return Err(e);
            }
            match self.keychains.lock().unwrap().first() {
                Some(k) => Ok(Spot { path: k.path.clone(), unlocked: k.unlocked }),
                None => Err(status_error(ERR_SEC_NO_DEFAULT_KEYCHAIN, None)),
            }
        }

        fn unlocked(&self, spot: &Spot) -> Option<bool> {
            match *self.unlocked_now.lock().unwrap() {
                Some(now) => now,
                None => self.state_of(&spot.path),
            }
        }

        fn read(&self, spot: &Spot, account: &str) -> Result<Zeroizing<[u8; 32]>, StoreError> {
            self.reads.fetch_add(1, Ordering::Relaxed);
            if let Some(e) = *self.read_fails.lock().unwrap() {
                return Err(e);
            }
            let keychains = self.keychains.lock().unwrap();
            let Some(k) = keychains.iter().find(|k| k.path == spot.path) else {
                return Err(exit_error(exit_of(ERR_SEC_NO_SUCH_KEYCHAIN), None));
            };
            if k.unlocked != Some(true) {
                return Err(exit_error(EXIT_INTERACTION_NOT_ALLOWED, k.unlocked));
            }
            match k.items.get(account) {
                Some(printed) => kek_of(printed),
                None => Err(exit_error(EXIT_NOT_FOUND, k.unlocked)),
            }
        }

        fn add(&self, spot: &Spot, account: &str, label: &str, comment: &str, kek: &[u8; 32]) -> Result<(), StoreError> {
            self.adds.fetch_add(1, Ordering::Relaxed);
            // The line the real hands would write: what it refuses, this refuses.
            add_line(FAKE_SERVICE, account, label, comment, kek, &spot.path)?;
            if let Some(theirs) = self.duplicate_next_add.lock().unwrap().take() {
                let mut keychains = self.keychains.lock().unwrap();
                if let Some(k) = keychains.iter_mut().find(|k| k.path == spot.path) {
                    let mut printed = kek_hex(&theirs).to_vec();
                    printed.push(b'\n');
                    k.items.entry(account.to_string()).or_insert(Zeroizing::new(printed));
                }
                return Err(exit_error(EXIT_DUPLICATE, Some(true)));
            }
            if let Some(e) = *self.add_fails.lock().unwrap() {
                return Err(e);
            }
            {
                let mut keychains = self.keychains.lock().unwrap();
                let Some(k) = keychains.iter_mut().find(|k| k.path == spot.path) else {
                    return Err(exit_error(exit_of(ERR_SEC_NO_SUCH_KEYCHAIN), None));
                };
                if k.unlocked != Some(true) {
                    return Err(exit_error(EXIT_INTERACTION_NOT_ALLOWED, k.unlocked));
                }
                if k.items.contains_key(account) {
                    return Err(exit_error(EXIT_DUPLICATE, k.unlocked));
                }
                let mut printed = kek_hex(kek).to_vec();
                printed.push(b'\n');
                k.items.insert(account.to_string(), Zeroizing::new(printed));
            }
            if let Some(e) = self.fail_after_landed.lock().unwrap().take() {
                return Err(e);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{login, FakeHands, FAKE_SERVICE};
    use super::*;
    use base64::Engine;

    const KEK: [u8; 32] = [7; 32];
    const NONCE_9: [u8; 24] = [9; 24];
    const ENTROPY: [u8; 32] = [1; 32];
    const FP: u32 = 42;

    fn store() -> KeychainStore<FakeHands> {
        KeychainStore::new(FakeHands::new())
    }

    /// The blob opens to the test entropy. A failure says only that, never
    /// the bytes.
    fn assert_opens(s: &KeychainStore<FakeHands>, blob: &[u8], why: &str) {
        match s.unwrap(blob, FP) {
            Ok(entropy) => assert!(entropy[..] == ENTROPY[..], "{why}: it opened to other bytes"),
            Err(e) => panic!("{why}: {e:?}"),
        }
    }

    fn refusal<T>(r: Result<T, StoreError>) -> Refusal {
        match r {
            Ok(_) => panic!("expected a refusal"),
            Err(e) => e.refusal,
        }
    }

    /// The blob of the test constants, pinned: any change to its layout,
    /// key check, associated data or cipher shows here. Its cipher part and
    /// associated data were checked once with another XChaCha20-Poly1305.
    const PINNED: &str = concat!(
        "5353464b01",                                                       // SSFK, format 1
        "26128f711ba7a2f2",                                                 // key check
        "090909090909090909090909090909090909090909090909",                 // nonce
        "bf73e38b7dab7863f513093d697206ea2bf2b69b41609ce0a78c195dd227525a", // sealed entropy
        "751bb071973509645fd59231af19a7ba",                                 // tag
    );

    #[test]
    fn the_blob_has_one_shape() {
        let blob = seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap();
        assert_eq!(blob.len(), BLOB_LEN);
        assert_eq!(&blob[..4], b"SSFK");
        assert_eq!(blob[4], 0x01);
        assert_eq!(&blob[5..13], &blake3::derive_key("StarStationFurlong chia_identity keychain check v1", &KEK)[..8]);
        assert_eq!(&blob[13..37], &NONCE_9[..]);
        assert!(blob[37..69] != ENTROPY[..], "the entropy is sealed");
        let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
        assert_eq!(b64.len(), 116);
        assert!(b64.len() <= crate::chia_wallet::BLOB_MAX);
        assert_eq!(hex::encode(&blob), PINNED);
        assert_eq!(seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap(), blob, "the same inputs seal the same bytes");
    }

    #[test]
    fn a_blob_opens_only_with_its_key_and_fingerprint() {
        let s = store();
        s.hands().put_kek(0, &account(FP), &KEK);
        let blob = seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap();
        assert_opens(&s, &blob, "its own key and fingerprint");

        // Another fingerprint: with no item for it, missing; with the same
        // key under it, the bound fingerprint does not match.
        assert_eq!(refusal(s.unwrap(&blob, FP + 1)), Refusal::KeychainMissing);
        s.hands().put_kek(0, &account(FP + 1), &KEK);
        assert_eq!(refusal(s.unwrap(&blob, FP + 1)), Refusal::KeychainDamaged);

        // Another key in the item: replaced.
        s.hands().remove(0, &account(FP));
        s.hands().put_kek(0, &account(FP), &[8; 32]);
        assert_eq!(refusal(s.unwrap(&blob, FP)), Refusal::KeychainReplaced);
        s.hands().remove(0, &account(FP));
        s.hands().put_kek(0, &account(FP), &KEK);

        // A flipped byte in the nonce, the sealed entropy or the tag is
        // damage; one in the key check reads as another key's (the two
        // cannot be told apart).
        for at in [13, 36, 37, 68, 69, 84] {
            let mut bad = blob.clone();
            bad[at] ^= 0x01;
            assert_eq!(refusal(s.unwrap(&bad, FP)), Refusal::KeychainDamaged, "byte {at}");
        }
        for at in 5..13 {
            let mut bad = blob.clone();
            bad[at] ^= 0x01;
            assert_eq!(refusal(s.unwrap(&bad, FP)), Refusal::KeychainReplaced, "byte {at}");
        }

        // A wrong magic, format or length is damage, with no keychain call.
        let before = s.hands().counts();
        let mut cases: Vec<Vec<u8>> = Vec::new();
        for at in 0..5 {
            let mut bad = blob.clone();
            bad[at] ^= 0x01;
            cases.push(bad);
        }
        cases.push(blob[..84].to_vec());
        cases.push([&blob[..], &[0]].concat());
        cases.push(Vec::new());
        for bad in cases {
            assert_eq!(refusal(s.unwrap(&bad, FP)), Refusal::KeychainDamaged, "{} bytes", bad.len());
        }
        assert_eq!(s.hands().counts(), before, "no search, no read");
    }

    #[test]
    fn two_wraps_of_one_wallet_make_one_item() {
        let s = store();
        let first = s.wrap(&ENTROPY, FP).unwrap();
        let second = s.wrap(&ENTROPY, FP).unwrap();
        assert_eq!(s.hands().counts().2, 1, "one add");
        assert_eq!(s.hands().item_count(), 1);
        assert_ne!(first, second, "each wrap takes a new nonce");
        assert_eq!(first[KCV], second[KCV], "the same key");
        assert_opens(&s, &first, "first");
        assert_opens(&s, &second, "second");
        assert_eq!(s.protect(), AtRest::Keychain);
    }

    #[test]
    fn a_race_uses_the_key_of_the_node_that_added_first() {
        let s = store();
        *s.hands().duplicate_next_add.lock().unwrap() = Some([5; 32]);
        let blob = s.wrap(&ENTROPY, FP).unwrap();
        assert_eq!(&blob[KCV], &kcv(&[5; 32])[..], "the winner's key");
        assert_eq!(s.hands().counts().2, 1);
        assert_opens(&s, &blob, "the winner's key");

        // A duplicate that cannot be found again is not now.
        let s = store();
        *s.hands().add_fails.lock().unwrap() = Some(exit_error(EXIT_DUPLICATE, Some(true)));
        let e = s.wrap(&ENTROPY, FP).unwrap_err();
        assert_eq!((e.refusal, e.code), (Refusal::NotNow, Code::Exit(45)));
        assert_eq!(s.hands().counts(), (2, 0, 1), "searched again once, nothing to read");
    }

    #[test]
    fn an_add_that_failed_after_landing_is_adopted() {
        for failure in [exit_error(2, Some(true)), StoreError { refusal: Refusal::NotNow, code: Code::TimedOut }] {
            let s = store();
            *s.hands().fail_after_landed.lock().unwrap() = Some(failure);
            let blob = s.wrap(&ENTROPY, FP).unwrap();
            assert_eq!(s.hands().counts(), (2, 1, 1), "{failure:?}: searched again and read what landed");
            assert_eq!(s.hands().item_count(), 1);
            assert_opens(&s, &blob, &format!("{failure:?}"));
        }
    }

    #[test]
    fn a_foreign_item_is_never_overwritten() {
        let s = store();
        s.hands().put(0, &account(FP), b"made by someone else\n");
        let e = s.wrap(&ENTROPY, FP).unwrap_err();
        assert_eq!(e.refusal, Refusal::KeychainDamaged);
        assert!(crate::chia_at_rest::short_words(e).contains("did not make"));
        assert_eq!(s.hands().counts().2, 0, "no add");
        assert_eq!(s.hands().item(0, &account(FP)).as_deref(), Some(&b"made by someone else\n"[..]), "left as it is");
        let theirs = [0xab; 32];
        let digits = kek_hex(&theirs).to_vec();
        let with = |tail: &[u8]| [&digits[..], tail].concat();
        let not_ours: [(&str, Vec<u8>); 6] = [
            ("nothing", Vec::new()),
            ("no newline", digits.clone()),
            ("two newlines", with(b"\n\n")),
            ("upper case", [&digits.to_ascii_uppercase()[..], b"\n"].concat()),
            ("short", [&digits[..62], b"\n"].concat()),
            ("not hex", [&digits[..63], b"g\n"].concat()),
        ];
        for (why, printed) in not_ours {
            assert_eq!(kek_of(&printed).map(|_| ()).unwrap_err().refusal, Refusal::KeychainDamaged, "{why}");
        }
        assert!(*kek_of(&with(b"\n")).unwrap() == theirs, "64 lowercase hex and a newline is the key");
    }

    #[test]
    fn a_locked_keychain_is_refused_without_a_spawn() {
        for state in [Some(false), None] {
            // The item's keychain is locked.
            let s = store();
            s.hands().put_kek(0, &account(FP), &KEK);
            let blob = seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap();
            s.hands().set_unlocked(0, state);
            assert_eq!(refusal(s.unwrap(&blob, FP)), Refusal::KeychainLocked, "{state:?}");
            assert_eq!(refusal(s.wrap(&ENTROPY, FP)), Refusal::KeychainLocked, "{state:?}");
            let (_, reads, adds) = s.hands().counts();
            assert_eq!((reads, adds), (0, 0), "{state:?}");

            // The default keychain, where a new one would go, is locked.
            let s = KeychainStore::new(FakeHands::with(&[(login(), state)]));
            assert_eq!(refusal(s.wrap(&ENTROPY, FP)), Refusal::KeychainLocked, "{state:?}");
            assert_eq!(s.hands().counts(), (1, 0, 0), "{state:?}");
            assert_eq!(s.hands().item_count(), 0);
        }
    }

    #[test]
    fn not_found_is_missing_only_from_the_search() {
        let s = store();
        s.hands().put_kek(0, &account(FP), &KEK);
        let blob = seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap();
        *s.hands().read_fails.lock().unwrap() = Some(exit_error(EXIT_NOT_FOUND, Some(true)));
        let e = s.unwrap(&blob, FP).unwrap_err();
        assert_eq!((e.refusal, e.code), (Refusal::NotNow, Code::Exit(44)), "security find's 44 is never missing");

        // An empty search is missing on open, and a new item on wrap.
        let s = store();
        let e = s.unwrap(&blob, FP).unwrap_err();
        assert_eq!((e.refusal, e.code), (Refusal::KeychainMissing, Code::OsStatus(-25300)));
        assert_eq!(s.hands().counts(), (1, 0, 0));
        s.wrap(&ENTROPY, FP).unwrap();
        assert_eq!(s.hands().counts(), (2, 0, 1), "searched, then made it");
        assert_eq!(classify_keychain_status(ERR_SEC_ITEM_NOT_FOUND, Some(true)), Refusal::NotNow, "only the search says missing");
    }

    #[test]
    fn several_keychains_are_tried_in_order() {
        let other = PathBuf::from("/Users/player/Library/Keychains/old.keychain-db");
        let blob = seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap();
        let two = |first: Option<bool>, first_kek: [u8; 32], second: Option<bool>, second_kek: [u8; 32]| {
            let s = KeychainStore::new(FakeHands::with(&[(login(), first), (other.clone(), second)]));
            s.hands().put_kek(0, &account(FP), &first_kek);
            s.hands().put_kek(1, &account(FP), &second_kek);
            s
        };
        // The first locked, the second good: it opens.
        let s = two(Some(false), KEK, Some(true), KEK);
        assert_opens(&s, &blob, "the first locked, the second good");
        assert_eq!(s.hands().counts().1, 1, "only the unlocked one was read");
        // The first another key, the second ours: it opens.
        let s = two(Some(true), [8; 32], Some(true), KEK);
        assert_opens(&s, &blob, "the first another key, the second ours");
        assert_eq!(s.hands().counts().1, 2);
        // All locked: locked. All another key: replaced. One of each: locked.
        assert_eq!(refusal(two(Some(false), KEK, None, KEK).unwrap(&blob, FP)), Refusal::KeychainLocked);
        assert_eq!(refusal(two(Some(true), [8; 32], Some(true), [6; 32]).unwrap(&blob, FP)), Refusal::KeychainReplaced);
        assert_eq!(refusal(two(Some(true), [8; 32], Some(false), KEK).unwrap(&blob, FP)), Refusal::KeychainLocked);
        // A read that fails ends the search with its class.
        let s = two(Some(true), KEK, Some(true), KEK);
        *s.hands().read_fails.lock().unwrap() = Some(exit_error(EXIT_AUTH_FAILED, Some(true)));
        assert_eq!(refusal(s.unwrap(&blob, FP)), Refusal::KeychainDenied);
        assert_eq!(s.hands().counts().1, 1);
        // A wrap reuses the first keychain's key.
        let s = two(Some(true), [8; 32], Some(true), KEK);
        let wrapped = s.wrap(&ENTROPY, FP).unwrap();
        assert_eq!(&wrapped[KCV], &kcv(&[8; 32])[..]);
        assert_eq!(s.hands().counts().2, 0);
    }

    #[test]
    fn exit_36_reads_the_lock_state_again() {
        for (now, class) in
            [(Some(false), Refusal::KeychainLocked), (None, Refusal::KeychainLocked), (Some(true), Refusal::KeychainAsks)]
        {
            for exit in [36, 29] {
                let s = store();
                s.hands().put_kek(0, &account(FP), &KEK);
                let blob = seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap();
                // The hands class it by the state they saw; the store reads it again.
                *s.hands().read_fails.lock().unwrap() = Some(exit_error(exit, Some(true)));
                *s.hands().unlocked_now.lock().unwrap() = Some(now);
                let e = s.unwrap(&blob, FP).unwrap_err();
                assert_eq!((e.refusal, e.code), (class, Code::Exit(exit)), "read, exit {exit}, now {now:?}");

                let s = store();
                *s.hands().add_fails.lock().unwrap() = Some(exit_error(exit, Some(true)));
                *s.hands().unlocked_now.lock().unwrap() = Some(now);
                let e = s.wrap(&ENTROPY, FP).unwrap_err();
                assert_eq!((e.refusal, e.code), (class, Code::Exit(exit)), "add, exit {exit}, now {now:?}");
            }
        }
    }

    /// Every exit `security` can give, through a read and through an add,
    /// and the deadline.
    #[test]
    fn security_exits_are_classified_for_read_and_add() {
        use Refusal::*;
        let table: [(u8, Refusal, Refusal); 14] = [
            // exit, while unlocked, while locked or unknown
            (0, NotNow, NotNow),
            (44, NotNow, NotNow),
            (45, NotNow, NotNow),
            (36, KeychainAsks, KeychainLocked),
            (29, KeychainAsks, KeychainLocked),
            (51, KeychainDenied, KeychainDenied),
            (37, KeychainUnavailable, KeychainUnavailable),
            (49, KeychainUnavailable, KeychainUnavailable),
            (50, KeychainUnavailable, KeychainUnavailable),
            (53, KeychainUnavailable, KeychainUnavailable),
            (24, NotNow, NotNow),
            (128, NotNow, NotNow),
            (2, NotNow, NotNow),
            (1, NotNow, NotNow),
        ];
        for (exit, unlocked, locked) in table {
            assert_eq!(classify_security_exit(exit, Some(true)), unlocked, "exit {exit}");
            assert_eq!(classify_security_exit(exit, Some(false)), locked, "exit {exit}");
            assert_eq!(classify_security_exit(exit, None), locked, "exit {exit}");
        }
        assert_eq!(
            [EXIT_NOT_FOUND, EXIT_DUPLICATE, EXIT_INTERACTION_NOT_ALLOWED, EXIT_INTERACTION_REQUIRED, EXIT_AUTH_FAILED],
            [44, 45, 36, 29, 51]
        );
        assert_eq!([EXIT_IN_DARK_WAKE, EXIT_CANCELED], [24, 128]);

        let blob = seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap();
        let deadline = StoreError { refusal: NotNow, code: Code::TimedOut };
        let failures = table
            .iter()
            .filter(|(exit, ..)| *exit != 0)
            .map(|&(exit, unlocked, _)| (exit_error(exit, Some(true)), unlocked))
            .chain([(deadline, NotNow)]);
        for (failure, class) in failures {
            // Read: the item is there and unlocked.
            let s = store();
            s.hands().put_kek(0, &account(FP), &KEK);
            *s.hands().read_fails.lock().unwrap() = Some(failure);
            let e = s.unwrap(&blob, FP).unwrap_err();
            assert_eq!((e.refusal, e.code), (class, failure.code), "read {failure:?}");
            // Add: no item yet, and the add lands nothing.
            let s = store();
            *s.hands().add_fails.lock().unwrap() = Some(failure);
            let e = s.wrap(&ENTROPY, FP).unwrap_err();
            assert_eq!((e.refusal, e.code), (class, failure.code), "add {failure:?}");
            assert_eq!(s.hands().counts(), (2, 0, 1), "add {failure:?}: searched again before classing it");
        }
        // Exit 0: the read opens, the add makes the item.
        let s = store();
        s.hands().put_kek(0, &account(FP), &KEK);
        assert_opens(&s, &blob, "exit 0");
        let s = store();
        s.wrap(&ENTROPY, FP).unwrap();
        assert_eq!((s.hands().counts(), s.hands().item_count()), ((1, 0, 1), 1));
    }

    #[test]
    fn in_process_statuses_are_classified() {
        use Refusal::*;
        let table: [(i32, Refusal, Refusal); 14] = [
            // status, while unlocked, while locked or unknown
            (-25308, KeychainAsks, KeychainLocked),
            (-25315, KeychainAsks, KeychainLocked),
            (-25293, KeychainDenied, KeychainDenied),
            (-128, KeychainDenied, KeychainDenied),
            (-25307, KeychainUnavailable, KeychainUnavailable),
            (-25294, KeychainUnavailable, KeychainUnavailable),
            (-25295, KeychainUnavailable, KeychainUnavailable),
            (-25291, KeychainUnavailable, KeychainUnavailable),
            (-25300, NotNow, NotNow),
            (-25299, NotNow, NotNow),
            (-34018, NotNow, NotNow),
            (-36, NotNow, NotNow),
            (-25320, NotNow, NotNow),
            (-4, NotNow, NotNow),
        ];
        for (status, unlocked, locked) in table {
            assert_eq!(classify_keychain_status(status, Some(true)), unlocked, "{status}");
            assert_eq!(classify_keychain_status(status, Some(false)), locked, "{status}");
            assert_eq!(classify_keychain_status(status, None), locked, "{status}");
        }
        assert_eq!(status_error(-25308, None), StoreError { refusal: KeychainLocked, code: Code::OsStatus(-25308) });
    }

    #[test]
    fn a_hand_that_fails_first_stops_the_store_there() {
        let blob = seal(&KEK, &NONCE_9, &ENTROPY, FP).unwrap();
        // Prompts could not be turned off: no keychain call at all.
        let s = store();
        s.hands().put_kek(0, &account(FP), &KEK);
        *s.hands().ready_fails.lock().unwrap() = Some(status_error(-4, None));
        assert_eq!(refusal(s.unwrap(&blob, FP)), Refusal::NotNow);
        assert_eq!(refusal(s.wrap(&ENTROPY, FP)), Refusal::NotNow);
        assert_eq!(s.hands().counts(), (0, 0, 0));
        // The search fails: its class, and no run of security.
        let s = store();
        *s.hands().locate_fails.lock().unwrap() = Some(status_error(-25293, Some(true)));
        assert_eq!(refusal(s.unwrap(&blob, FP)), Refusal::KeychainDenied);
        assert_eq!(refusal(s.wrap(&ENTROPY, FP)), Refusal::KeychainDenied);
        assert_eq!(s.hands().counts(), (2, 0, 0));
        // No default keychain: unavailable, and nothing added.
        let s = KeychainStore::new(FakeHands::with(&[]));
        let e = s.wrap(&ENTROPY, FP).unwrap_err();
        assert_eq!((e.refusal, e.code), (Refusal::KeychainUnavailable, Code::OsStatus(-25307)));
        assert_eq!(s.hands().counts(), (1, 0, 0));
    }

    /// A port of the line splitter `security -i` reads its commands with:
    /// words split on spaces and tabs, `'` or `"` quote until the same mark,
    /// and a backslash takes the next character as it is, in quotes or not.
    fn split_line(line: &str) -> Vec<String> {
        let mut words = Vec::new();
        let mut chars = line.chars().peekable();
        loop {
            while matches!(chars.peek(), Some(' ' | '\t' | '\n')) {
                chars.next();
            }
            if chars.peek().is_none() {
                return words;
            }
            let mut word = String::new();
            let mut quote = None;
            while let Some(c) = chars.next() {
                match (c, quote) {
                    ('\\', _) => word.extend(chars.next()),
                    (q, Some(open)) if q == open => quote = None,
                    ('"' | '\'', None) => quote = Some(c),
                    (' ' | '\t' | '\n', None) => break,
                    _ => word.push(c),
                }
            }
            words.push(word);
        }
    }

    #[test]
    fn the_add_line_keeps_the_key_off_the_arguments_and_round_trips() {
        let find = find_args(SERVICE, "v1/42", Path::new("/k/login.keychain-db"));
        let hex = std::str::from_utf8(&kek_hex(&KEK)[..]).unwrap().to_string();
        assert!(find.iter().all(|a| a.to_str().unwrap() != hex && !a.to_str().unwrap().contains(&hex[..16])), "{find:?}");
        assert_eq!(find[0], "find-generic-password");
        assert!(ADD_FLAGS.iter().all(|f| *f != "-v"), "never -v: it echoes the key");

        for name in [label(u32::MAX), KIND.to_string(), comment(u32::MAX), SERVICE.to_string(), account(u32::MAX)] {
            assert!(!name.contains(['\'', '"', '\\']), "{name}");
        }
        assert_eq!(label(42), "Star Station Furlong wallet lock 42");
        assert!(comment(42).starts_with(
            "Opens chia_identity.json of the Star Station Furlong wallet with key fingerprint 42 for this Mac user."
        ));

        for path in [
            "/Users/player/Library/Keychains/login.keychain-db",
            "/Users/Jo Ann/Library/Keychains/login.keychain-db",
            "/Users/o'brien/Library/Keychains/login.keychain-db",
            "/Volumes/a \"quoted\" disk/k.keychain-db",
            "/tmp/back\\slash/'both' \"kinds\"\t/k.keychain-db",
        ] {
            let line = add_line(SERVICE, &account(FP), &label(FP), &comment(FP), &KEK, Path::new(path)).unwrap();
            assert!(line.ends_with('\n') && line.matches('\n').count() == 1, "one line");
            assert!(line.len() < MAX_LINE);
            let words = split_line(&line);
            for flag in ["-U", "-A", "-T", "-v"] {
                assert!(!words.iter().any(|w| w == flag), "{flag} in the line");
            }
            // The key is the one word after -w; the rest is compared openly.
            assert!(words.len() == 14 && words[11] == "-w" && words[12] == hex, "{path}: the key is the word after -w");
            let others: Vec<&str> = words.iter().enumerate().filter(|(i, _)| *i != 12).map(|(_, w)| w.as_str()).collect();
            let (label, comment) = (label(FP), comment(FP));
            let expected: [&str; 13] =
                ["add-generic-password", "-s", SERVICE, "-a", "v1/42", "-l", &label, "-D", KIND, "-j", &comment, "-w", path];
            assert_eq!(others, expected, "{path}");
        }

        for bad in ["/tmp/new\nline/k.keychain-db", "/tmp/nul\0/k.keychain-db"] {
            assert_eq!(
                add_line(SERVICE, &account(FP), &label(FP), &comment(FP), &KEK, Path::new(bad)).unwrap_err().refusal,
                Refusal::NotNow
            );
        }
        let long = format!("/{}", "a".repeat(MAX_LINE));
        assert!(
            add_line(SERVICE, &account(FP), &label(FP), &comment(FP), &KEK, Path::new(&long)).is_err(),
            "a line security would cut"
        );

        // The fake refuses the same lines, and adds nothing.
        let s = KeychainStore::new(FakeHands::with(&[(PathBuf::from("/tmp/new\nline/k.keychain-db"), Some(true))]));
        assert_eq!(refusal(s.wrap(&ENTROPY, FP)), Refusal::NotNow);
        assert_eq!(s.hands().item_count(), 0);
    }

    #[test]
    fn the_store_prints_only_its_service() {
        let s = store();
        s.hands().put_kek(0, &account(FP), &KEK);
        s.wrap(&ENTROPY, FP).unwrap();
        let shown = format!("{s:?}");
        assert_eq!(shown, format!(r#"KeychainStore {{ service: "{FAKE_SERVICE}" }}"#));
        let spot = Spot { path: login(), unlocked: Some(true) };
        assert!(!format!("{spot:?}").contains(&hex::encode(KEK)));
    }
}
