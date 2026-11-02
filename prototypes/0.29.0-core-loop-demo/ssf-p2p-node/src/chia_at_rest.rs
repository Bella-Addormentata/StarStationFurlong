//! 🏦 The SSF wallet's identity at rest (#335 stage 1, step 3).
//!
//! Once the player has marked the 24 words saved, the node locks the
//! identity file's entropy with the operating system's own store for the
//! account it runs as. On Windows that is DPAPI (`CryptProtectData` for the
//! current user): `chia_identity.json` then holds a `blob` in place of
//! `entropy` (`protect: "dpapi"`), and only this Windows account on this PC
//! can open it. A copy of the folder that leaves the account (synced, zipped,
//! backed up, opened by another account or on another PC) no longer gives the
//! wallet away; the saved 24 words still restore it anywhere.
//!
//! What it does not stop: a program running as the same Windows user can ask
//! DPAPI exactly as the node does, so the Bank says the key is "on disk", not
//! that it is safe. Copies made before the lock, and the disk blocks the clear
//! file used, keep the key in the clear; the log and the Bank say so once.
//!
//! The wrap waits for the saved mark so that no wallet whose words were never
//! written down depends on a store it can lose (a Windows reinstall, an admin
//! password reset, a reset login keychain). Minting still writes
//! `protect: "none"` (chia_wallet.rs).
//!
//! On a Mac the store is the user's login keychain (`protect: "keychain"`,
//! keychain_lock.rs and keychain.rs): the file keeps the entropy sealed with
//! a random key, and one keychain item per wallet keeps that key, so a copy
//! of the folder alone no longer holds the wallet. Apple's own
//! `/usr/bin/security` makes and reads the item: macOS ties an item a
//! program makes itself to that build of it, so an item the unsigned node
//! made would be refused to its next update. An update never brings a
//! prompt, and the node never shows one: a locked keychain (a node started
//! over ssh sees it locked) is a refusal that keeps the file, and a lock
//! that cannot land is tried again at the next start. As with DPAPI, a
//! program running as the same Mac user can ask `security` for the key just
//! as the node does.
//!
//! Linux keeps `protect: "none"`: owner-only (0600), which the Bank says.
//!
//! `SSF_WALLET_AT_REST` decides new wraps only: unset, empty or `os` wraps
//! where a store exists; `none` never wraps (a headless node that runs as a
//! service account, a folder shared between accounts); anything else is a
//! mistake, and the wallet is not loaded until it is fixed. A file already
//! locked opens by its own `protect` whatever the setting, and nothing here
//! ever unwraps a file back into the clear.
#![cfg(feature = "chia-publish")]

use std::ffi::OsStr;
use std::path::Path;

use zeroize::Zeroizing;

pub use crate::chia_wallet_switch::AtRest;

/// The setting that decides new wraps.
pub const POLICY_ENV: &str = "SSF_WALLET_AT_REST";

/// What `SSF_WALLET_AT_REST` asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// Lock the file with this computer's store once the words are saved.
    Os,
    /// Never lock it here.
    None,
}

/// A value of `SSF_WALLET_AT_REST` that is neither `os` nor `none`.
pub const BAD_POLICY: &str = "SSF_WALLET_AT_REST is set to something other than os or none, so the wallet is not loaded: \
                              unset it, or set it to os or none";

/// The policy a value of `SSF_WALLET_AT_REST` asks for.
pub fn policy_of(raw: Option<&OsStr>) -> Result<Policy, &'static str> {
    match raw.map(OsStr::to_str) {
        None | Some(Some("" | "os")) => Ok(Policy::Os),
        Some(Some("none")) => Ok(Policy::None),
        Some(_) => Err(BAD_POLICY),
    }
}

/// This run's policy, from the environment.
pub fn policy() -> Result<Policy, &'static str> {
    policy_of(std::env::var_os(POLICY_ENV).as_deref())
}

/// What a store's failure means for the player, chosen from its code.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The file is locked by a store this computer does not have.
    Foreign(AtRest),
    /// DPAPI: another account or PC locked it, or an administrator reset
    /// this account's password.
    DpapiLost,
    /// DPAPI: the locked bytes are damaged (or were changed).
    DpapiDamaged,
    /// Keychain: the keychain that holds the key is locked for this session
    /// (or its state cannot be read). The node never asks for its password.
    KeychainLocked,
    /// Keychain: it is unlocked, but macOS would ask before handing the key
    /// over (the item's access was changed), and the node never lets it ask.
    KeychainAsks,
    /// Keychain: macOS refused the key to this program.
    KeychainDenied,
    /// Keychain: this session has no keychain the node can use (root, a
    /// service account, a user who never logged in at the Mac).
    KeychainUnavailable,
    /// Keychain: no keychain of this user holds an item for this wallet.
    KeychainMissing,
    /// Keychain: the item for this wallet holds another key than the one
    /// the file was locked with.
    KeychainReplaced,
    /// Keychain: the locked bytes are damaged, or the item at our name is
    /// not one this node made.
    KeychainDamaged,
    /// Anything else: it may open at the next try.
    NotNow,
}

/// Where a store's failure code came from, so it is printed in its own form
/// (`{:#x}` of a negative number would print sixteen hex digits).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    /// No code: the class says it all.
    None,
    /// A Windows error after a DPAPI call (`GetLastError`).
    #[cfg_attr(not(windows), allow(dead_code))]
    Dpapi(u32),
    /// A macOS Security status from a call in this process.
    OsStatus(i32),
    /// The exit status of `/usr/bin/security`: the low byte of its status.
    Exit(u8),
    /// `/usr/bin/security` did not answer in time and was stopped.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    TimedOut,
    /// `/usr/bin/security` could not be started (its errno).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Spawn(i32),
    /// A test reached for the login keychain, which tests never touch.
    #[cfg_attr(not(test), allow(dead_code))]
    Guard,
}

/// A store's failure: its class and the operating system's code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoreError {
    pub refusal: Refusal,
    pub code: Code,
}

/// A code in words, in the form of where it came from.
pub fn code_words(code: Code) -> String {
    match code {
        Code::None => "no code".to_string(),
        Code::Dpapi(c) => format!("code {c:#x}"),
        Code::OsStatus(c) => format!("OSStatus {c}"),
        Code::Exit(c) => format!("security exit {c}"),
        Code::TimedOut => {
            format!("security did not answer within {} s", keychain_lock::SECURITY_DEADLINE.as_secs())
        }
        Code::Spawn(errno) => format!("could not start {} (errno {errno})", keychain_lock::SECURITY),
        Code::Guard => "tests never touch the login keychain".to_string(),
    }
}

/// `NTE_BAD_KEY_STATE`: the user's DPAPI master key is not the one that
/// locked the blob (another account or PC, or a forced password reset).
#[cfg_attr(not(windows), allow(dead_code))]
pub const DPAPI_BAD_KEY_STATE: u32 = 0x8009_000B;
/// `ERROR_INVALID_DATA`: the blob, or the entropy it was locked with, is
/// not what was given.
#[cfg_attr(not(windows), allow(dead_code))]
pub const DPAPI_INVALID_DATA: u32 = 13;
/// `NTE_BAD_DATA`.
#[cfg_attr(not(windows), allow(dead_code))]
pub const DPAPI_BAD_DATA: u32 = 0x8009_0005;

/// The class of a DPAPI error code (`GetLastError` after a failed call).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn classify_dpapi(code: u32) -> Refusal {
    match code {
        DPAPI_BAD_KEY_STATE => Refusal::DpapiLost,
        DPAPI_INVALID_DATA | DPAPI_BAD_DATA => Refusal::DpapiDamaged,
        _ => Refusal::NotNow,
    }
}

/// A store that locks the identity's entropy for the account the node runs
/// as. `wrap` gives the bytes the file keeps as its `blob`; `unwrap` opens a
/// blob it wrote for the same fingerprint (which is bound into the lock).
/// Both may block (the keychain store runs `/usr/bin/security`), so callers
/// call them off the async runtime.
pub trait SecretStore: Sync {
    fn protect(&self) -> AtRest;
    fn wrap(&self, entropy: &[u8; 32], fingerprint: u32) -> Result<Vec<u8>, StoreError>;
    fn unwrap(&self, blob: &[u8], fingerprint: u32) -> Result<Zeroizing<Vec<u8>>, StoreError>;
}

/// This computer's store, when it has one the node uses: DPAPI on Windows,
/// the login keychain on a Mac, and none on Linux. It makes no system call
/// (the keychain's first is its `ready`, once a locked file is opened or a
/// lock is due), so asking costs nothing at startup.
pub fn os_store() -> Option<&'static dyn SecretStore> {
    #[cfg(windows)]
    {
        Some(&dpapi::Dpapi)
    }
    #[cfg(target_os = "macos")]
    {
        Some(&keychain::LOGIN)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}

/// Whether to lock the identity now: its words are marked saved, it is in
/// the clear, the policy allows it, and this computer has a store.
pub fn should_wrap(backed_up: bool, protect: AtRest, policy: Policy, store: Option<AtRest>) -> bool {
    backed_up && protect == AtRest::None && policy == Policy::Os && store.is_some()
}

/// The lock a file in the clear gets once its words are saved, for the
/// Bank: none when the policy is `none` (or not valid) or there is no store.
pub fn next_lock(policy: Result<Policy, &'static str>, store: Option<AtRest>) -> Option<AtRest> {
    match policy {
        Ok(Policy::Os) => store,
        _ => None,
    }
}

/// The extra entropy a DPAPI blob is locked with: it binds the blob to this
/// use and to the wallet's fingerprint, so a blob copied into another
/// identity file, or under another fingerprint, does not open.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn dpapi_entropy(fingerprint: u32) -> String {
    format!("StarStationFurlong/chia_identity/v1/{fingerprint}")
}

/// How a lock is said in the log: "locked {file} {lock_words}". A file in
/// the clear has no lock; its words say so.
pub fn lock_words(protect: AtRest) -> &'static str {
    match protect {
        AtRest::None => "in the clear",
        AtRest::Dpapi => "to this Windows account",
        AtRest::Keychain => "with this Mac user's login keychain",
    }
}

/// What to keep, for a file that is refused because it is locked.
const KEEP: &str = "it is left as it is; keep this file: it opens again for the account that made it, \
                    and if its 24 words were saved they restore the coins in Sage or the Chia wallet";
/// How to start over without losing it.
const MOVE: &str = "to start a new wallet here, move it aside (do not delete it)";

/// A code as the end of a clause: " (OSStatus -25308)", or nothing when
/// there is none.
fn bracketed(code: Code) -> String {
    match code {
        Code::None => String::new(),
        code => format!(" ({})", code_words(code)),
    }
}

/// The sentence for a locked file this node cannot open: its path, the class
/// and the operating system's number, never anything read from the file.
/// Only a file that will never open for this account says to move it aside;
/// one that opens after an unlock, or at another try, says only to keep it.
pub fn refusal_words(path: &Path, e: StoreError) -> String {
    let p = path.display();
    let code = bracketed(e.code);
    let kind = keychain_lock::KIND;
    match e.refusal {
        Refusal::Foreign(AtRest::Dpapi) => format!(
            "chia identity file {p} is locked to a Windows account on the computer that made it, so this node cannot open it; {KEEP}; {MOVE}"
        ),
        Refusal::Foreign(AtRest::Keychain) => format!(
            "chia identity file {p} is locked with the login keychain of the Mac user that made it, on that Mac, \
             so this node cannot open it; {KEEP}; {MOVE}"
        ),
        Refusal::Foreign(other) => format!(
            "chia identity file {p} is locked by a store this computer does not have ({other:?}); {KEEP}; {MOVE}"
        ),
        Refusal::DpapiLost => format!(
            "chia identity file {p} is locked to another Windows account or PC, or an administrator reset this account's \
             password{code}; {KEEP}; {MOVE}"
        ),
        Refusal::DpapiDamaged => {
            format!("chia identity file {p} is locked by Windows, but its locked key is damaged{code}; {KEEP}")
        }
        Refusal::KeychainLocked => format!(
            "chia identity file {p} is locked with a key in this Mac user's login keychain, and that keychain is locked for this \
             session{code}; a node started over ssh sees it locked even while you are logged in at the Mac. The node never asks \
             for its password: log in at the Mac and start the node there, or run security unlock-keychain in this session, then \
             start the node again; {KEEP}"
        ),
        Refusal::KeychainAsks => format!(
            "chia identity file {p} is locked with a key in this Mac user's login keychain, but macOS would ask before handing it \
             over{code}, and the node never lets it ask; this happens when the item's access was changed in Keychain Access: open \
             the {kind} item for this wallet, put security back under Access Control, then start the node again. If security is \
             already there, the item's partition list was changed, which Keychain Access does not show: run security \
             set-generic-password-partition-list -S apple-tool:,apple: -s {service} -a <the item's Account> in Terminal (it asks \
             for the login keychain's password), then start the node again; {KEEP}",
            service = keychain_lock::SERVICE
        ),
        Refusal::KeychainDenied => format!(
            "chia identity file {p} is locked with a key in this Mac user's login keychain, and macOS refused it to this \
             program{code}; its access may have been changed in Keychain Access; {KEEP}; start the node again as the Mac user \
             that locked it, with the login keychain unlocked"
        ),
        Refusal::KeychainUnavailable => format!(
            "chia identity file {p} is locked with a Mac login keychain, and this session has none the node can use{code}: \
             a service account, root, or a user who never logged in at the Mac; {KEEP}; start the node as the Mac user that \
             locked it, logged in"
        ),
        Refusal::KeychainMissing => format!(
            "chia identity file {p} is locked with a key that this Mac user's keychains do not hold{code}: the file comes from \
             another Mac or user, the login keychain was reset, or its {kind} item was deleted; {KEEP}; {MOVE}"
        ),
        Refusal::KeychainReplaced => format!(
            "chia identity file {p} is locked with another key than the one this Mac user's keychain now holds for this wallet: \
             its item was deleted and made again, or the file was locked on another Mac or by another user; {KEEP}; {MOVE}"
        ),
        Refusal::KeychainDamaged => format!(
            "chia identity file {p} is locked with this Mac user's login keychain, but its locked key is damaged, \
             or the keychain's item for it is not one this node made; {KEEP}"
        ),
        Refusal::NotNow => format!(
            "chia identity file {p} is locked by this computer's store and could not be opened right now{code}; \
             start the node again"
        ),
    }
}

/// Why a lock did not land, for the log's "stays in the clear for now
/// (...)": the class in a few words and the code. DPAPI's classes give the
/// code alone, as they always did.
pub fn short_words(e: StoreError) -> String {
    let code = bracketed(e.code);
    match e.refusal {
        Refusal::KeychainLocked => {
            format!("this Mac user's login keychain is locked for this session, and the node never asks for its password{code}")
        }
        Refusal::KeychainAsks => format!("macOS would ask before handing over the key, and the node never lets it ask{code}"),
        Refusal::KeychainDenied => format!("macOS refused the key{code}"),
        Refusal::KeychainUnavailable => {
            format!("this session has no login keychain{code}; a node run as a service can set {POLICY_ENV}=none")
        }
        Refusal::KeychainMissing => format!("this Mac user's keychains do not hold its key{code}"),
        Refusal::KeychainReplaced => "the keychain holds another key for this wallet than the one it was locked with".to_string(),
        Refusal::KeychainDamaged => format!(
            "the keychain already holds a {} item for this wallet that the node did not make; it is left as it is",
            keychain_lock::KIND
        ),
        Refusal::NotNow if !matches!(e.code, Code::Dpapi(_)) => format!("the keychain did not answer as expected{code}"),
        Refusal::NotNow | Refusal::Foreign(_) | Refusal::DpapiLost | Refusal::DpapiDamaged => code_words(e.code),
    }
}

/// The startup line for the policy, or none for the default.
pub fn policy_line(policy: Policy, store: Option<AtRest>) -> Option<String> {
    match (policy, store) {
        (Policy::None, _) => Some(format!(
            "🏦 SSF wallet: {POLICY_ENV}=none: the node does not lock the wallet's file, even once its 24 words are saved, \
             so a file in the clear stays in the clear on disk; a file already locked stays locked"
        )),
        (Policy::Os, None) => Some(
            "🏦 SSF wallet: this computer has no store the node locks the wallet's file with yet, so it stays in the clear on disk"
                .to_string(),
        ),
        (Policy::Os, Some(_)) => None,
    }
}

#[cfg(windows)]
mod dpapi;

pub mod keychain_lock;

/// The keychain store's macOS hands. The rest of the crate sees it so that
/// the wallet's tests can use its `TempKeychain`.
#[cfg(target_os = "macos")]
pub(crate) mod keychain;

#[cfg(test)]
pub(crate) mod fake {
    //! A store for tests on any OS: a keyed XOR with a tag, so a blob opens
    //! only for the fingerprint it was made for, and faults on demand.
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    pub struct FakeStore {
        pub protect: AtRest,
        /// The next wraps fail with this.
        pub wrap_fails: Mutex<Option<StoreError>>,
        /// Every unwrap fails with this.
        pub unwrap_fails: Mutex<Option<StoreError>>,
        /// Unwrap gives the wrong bytes back (a store that lies).
        pub unwrap_lies: Mutex<bool>,
        pub wraps: AtomicU32,
    }

    impl FakeStore {
        pub fn new() -> FakeStore {
            FakeStore {
                protect: AtRest::Dpapi,
                wrap_fails: Mutex::new(None),
                unwrap_fails: Mutex::new(None),
                unwrap_lies: Mutex::new(false),
                wraps: AtomicU32::new(0),
            }
        }

        fn pad(fingerprint: u32, i: usize) -> u8 {
            let b = dpapi_entropy(fingerprint).into_bytes();
            b[i % b.len()] ^ (i as u8).wrapping_mul(31)
        }
    }

    const TAG: &[u8] = b"FAKE1";

    impl SecretStore for FakeStore {
        fn protect(&self) -> AtRest {
            self.protect
        }

        fn wrap(&self, entropy: &[u8; 32], fingerprint: u32) -> Result<Vec<u8>, StoreError> {
            if let Some(e) = *self.wrap_fails.lock().unwrap() {
                return Err(e);
            }
            self.wraps.fetch_add(1, Ordering::Relaxed);
            let mut out = TAG.to_vec();
            out.extend(entropy.iter().enumerate().map(|(i, b)| b ^ Self::pad(fingerprint, i)));
            Ok(out)
        }

        fn unwrap(&self, blob: &[u8], fingerprint: u32) -> Result<Zeroizing<Vec<u8>>, StoreError> {
            if let Some(e) = *self.unwrap_fails.lock().unwrap() {
                return Err(e);
            }
            let body = blob
                .strip_prefix(TAG)
                .ok_or(StoreError { refusal: Refusal::DpapiDamaged, code: Code::Dpapi(DPAPI_INVALID_DATA) })?;
            let mut out = Zeroizing::new(body.iter().enumerate().map(|(i, b)| b ^ Self::pad(fingerprint, i)).collect::<Vec<u8>>());
            if *self.unwrap_lies.lock().unwrap() {
                if let Some(first) = out.first_mut() {
                    *first ^= 0xff;
                }
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn the_policy_is_os_unless_none_and_anything_else_is_refused() {
        assert_eq!(policy_of(None), Ok(Policy::Os));
        assert_eq!(policy_of(Some(&OsString::from(""))), Ok(Policy::Os));
        assert_eq!(policy_of(Some(&OsString::from("os"))), Ok(Policy::Os));
        assert_eq!(policy_of(Some(&OsString::from("none"))), Ok(Policy::None));
        for bad in ["OS", "None", "off", "0", "1", "dpapi", " os"] {
            assert_eq!(policy_of(Some(&OsString::from(bad))), Err(BAD_POLICY), "{bad:?}");
        }
    }

    #[test]
    fn a_wrap_waits_for_the_saved_words_a_store_and_the_policy() {
        let store = Some(AtRest::Dpapi);
        assert!(should_wrap(true, AtRest::None, Policy::Os, store));
        assert!(!should_wrap(false, AtRest::None, Policy::Os, store), "words not saved");
        assert!(!should_wrap(true, AtRest::Dpapi, Policy::Os, store), "already locked");
        assert!(!should_wrap(true, AtRest::None, Policy::None, store), "policy none");
        assert!(!should_wrap(true, AtRest::None, Policy::Os, None), "no store here");
        assert_eq!(next_lock(Ok(Policy::Os), store), store);
        assert_eq!(next_lock(Ok(Policy::None), store), None);
        assert_eq!(next_lock(Err(BAD_POLICY), store), None);
        assert_eq!(next_lock(Ok(Policy::Os), None), None);
    }

    #[test]
    fn dpapi_codes_are_classified_and_the_entropy_names_the_fingerprint() {
        assert_eq!(classify_dpapi(0x8009_000B), Refusal::DpapiLost);
        assert_eq!(classify_dpapi(13), Refusal::DpapiDamaged);
        assert_eq!(classify_dpapi(0x8009_0005), Refusal::DpapiDamaged);
        assert_eq!(classify_dpapi(5), Refusal::NotNow);
        assert_eq!(dpapi_entropy(123), "StarStationFurlong/chia_identity/v1/123");
    }

    #[test]
    fn refusals_name_the_path_and_code_and_say_to_keep_the_file() {
        let p = Path::new("chia_identity.json");
        let lost = refusal_words(p, StoreError { refusal: Refusal::DpapiLost, code: Code::Dpapi(0x8009_000B) });
        assert!(lost.contains("chia_identity.json") && lost.contains("0x8009000b"), "{lost}");
        assert!(lost.contains("keep this file") && lost.contains("move it aside"), "{lost}");
        let damaged = refusal_words(p, StoreError { refusal: Refusal::DpapiDamaged, code: Code::Dpapi(13) });
        assert!(damaged.contains("keep this file") && !damaged.contains("move it aside"), "{damaged}");
        let foreign = refusal_words(p, StoreError { refusal: Refusal::Foreign(AtRest::Dpapi), code: Code::None });
        assert!(foreign.contains("Windows account on the computer that made it"), "{foreign}");
        let now = refusal_words(p, StoreError { refusal: Refusal::NotNow, code: Code::Dpapi(5) });
        assert!(now.contains("start the node again"), "{now}");
    }

    #[test]
    fn the_startup_line_speaks_only_when_the_file_stays_in_the_clear() {
        assert!(policy_line(Policy::Os, Some(AtRest::Dpapi)).is_none());
        assert!(policy_line(Policy::None, Some(AtRest::Dpapi)).unwrap().contains("=none"));
        let none = policy_line(Policy::None, None).unwrap();
        assert!(none.contains("does not lock") && none.contains("already locked stays locked"), "{none}");
        assert!(policy_line(Policy::Os, None).unwrap().contains("in the clear"));
        assert!(!policy_line(Policy::Os, None).unwrap().contains("owner-only"), "the node does not check that");
    }

    #[test]
    fn codes_are_printed_by_where_they_came_from() {
        assert_eq!(code_words(Code::Dpapi(0x8009_000B)), "code 0x8009000b");
        assert_eq!(code_words(Code::Dpapi(5)), "code 0x5");
        assert_eq!(code_words(Code::OsStatus(-25308)), "OSStatus -25308");
        assert_eq!(code_words(Code::Exit(44)), "security exit 44");
        assert_eq!(code_words(Code::TimedOut), "security did not answer within 10 s");
        assert_eq!(code_words(Code::Spawn(2)), "could not start /usr/bin/security (errno 2)");
        assert_eq!(code_words(Code::Guard), "tests never touch the login keychain");
        assert_eq!(code_words(Code::None), "no code");
    }

    /// 🍎 Each keychain class names the path and its code, and says to keep
    /// the file. Only a file that never opens for this Mac user says to move
    /// it aside; one that opens after an unlock, or later, does not.
    #[test]
    fn keychain_refusals_say_to_keep_the_file_and_only_some_to_move_it() {
        let p = Path::new("/Users/player/ssf/chia_identity.json");
        let says = |refusal, code| refusal_words(p, StoreError { refusal, code });
        let cases = [
            (Refusal::Foreign(AtRest::Keychain), Code::None, true),
            (Refusal::KeychainLocked, Code::OsStatus(-25308), false),
            (Refusal::KeychainAsks, Code::Exit(36), false),
            (Refusal::KeychainDenied, Code::Exit(51), false),
            (Refusal::KeychainUnavailable, Code::OsStatus(-25307), false),
            (Refusal::KeychainMissing, Code::OsStatus(-25300), true),
            (Refusal::KeychainReplaced, Code::None, true),
            (Refusal::KeychainDamaged, Code::None, false),
        ];
        for (refusal, code, moves) in cases {
            let words = says(refusal, code);
            assert!(words.contains("/Users/player/ssf/chia_identity.json"), "{refusal:?}: {words}");
            if code != Code::None {
                assert!(words.contains(&code_words(code)), "{refusal:?}: {words}");
            }
            assert!(words.contains("keep this file"), "{refusal:?}: {words}");
            assert_eq!(words.contains("move it aside"), moves, "{refusal:?}: {words}");
            assert!(!words.contains("no code"), "{refusal:?}: {words}");
        }
        let foreign = says(Refusal::Foreign(AtRest::Keychain), Code::None);
        assert!(foreign.contains("login keychain of the Mac user that made it"), "{foreign}");
        let unread = says(Refusal::KeychainLocked, Code::None);
        assert!(unread.contains("locked for this session; a node started over ssh"), "no empty brackets: {unread}");
        let locked = says(Refusal::KeychainLocked, Code::OsStatus(-25308));
        assert!(locked.contains("security unlock-keychain") && locked.contains("over ssh"), "{locked}");
        assert!(locked.contains("never asks for its password"), "{locked}");
        let asks = says(Refusal::KeychainAsks, Code::Exit(36));
        assert!(asks.contains("Keychain Access") && asks.contains("Access Control"), "{asks}");
        assert!(asks.contains("Star Station Furlong wallet lock item"), "{asks}");
        // A partition list changed outside Keychain Access gives the same
        // refusal, so the words also say how to set it back.
        assert!(asks.contains("If security is already there, the item's partition list was changed"), "{asks}");
        assert!(
            asks.contains("security set-generic-password-partition-list -S apple-tool:,apple: -s StarStationFurlong.chia_identity -a"),
            "{asks}"
        );
        assert!(asks.contains("asks for the login keychain's password"), "{asks}");
        let missing = says(Refusal::KeychainMissing, Code::OsStatus(-25300));
        assert!(missing.contains("Star Station Furlong wallet lock item was deleted"), "{missing}");
        // Not now: the code, and no advice to keep or move it.
        let now = says(Refusal::NotNow, Code::TimedOut);
        assert!(now.contains("right now (security did not answer within 10 s); start the node again"), "{now}");
        assert!(!now.contains("keep this file") && !now.contains("move it aside"), "{now}");
        // The DPAPI sentences are as they were.
        let lost = says(Refusal::DpapiLost, Code::Dpapi(0x8009_000B));
        assert!(lost.contains("(code 0x8009000b); it is left as it is"), "{lost}");
    }

    #[test]
    fn a_lock_that_did_not_land_says_why_in_a_few_words() {
        let short = |refusal, code| short_words(StoreError { refusal, code });
        assert_eq!(
            short(Refusal::KeychainLocked, Code::OsStatus(-25308)),
            "this Mac user's login keychain is locked for this session, and the node never asks for its password (OSStatus -25308)"
        );
        assert!(short(Refusal::KeychainAsks, Code::Exit(36)).starts_with("macOS would ask before handing over the key"));
        assert_eq!(short(Refusal::KeychainDenied, Code::Exit(51)), "macOS refused the key (security exit 51)");
        assert!(short(Refusal::KeychainUnavailable, Code::OsStatus(-25307)).contains("SSF_WALLET_AT_REST=none"));
        assert!(short(Refusal::KeychainDamaged, Code::None).contains("that the node did not make; it is left as it is"));
        let unexpected = "the keychain did not answer as expected";
        assert_eq!(short(Refusal::NotNow, Code::TimedOut), format!("{unexpected} (security did not answer within 10 s)"));
        assert_eq!(short(Refusal::NotNow, Code::Guard), format!("{unexpected} (tests never touch the login keychain)"));
        assert_eq!(short(Refusal::NotNow, Code::None), unexpected);
        assert!(short(Refusal::KeychainLocked, Code::None).ends_with("never asks for its password"));
        // DPAPI's give the code alone, as they always did.
        assert_eq!(short(Refusal::NotNow, Code::Dpapi(5)), "code 0x5");
        assert_eq!(short(Refusal::DpapiLost, Code::Dpapi(0x8009_000B)), "code 0x8009000b");
    }

    #[test]
    fn the_keychain_is_a_store_like_dpapi_for_the_policy() {
        let store = Some(AtRest::Keychain);
        assert!(policy_line(Policy::Os, store).is_none(), "nothing to say at startup");
        let none = policy_line(Policy::None, store).unwrap();
        assert!(none.contains("=none") && none.contains("already locked stays locked"), "{none}");
        assert!(should_wrap(true, AtRest::None, Policy::Os, store));
        assert!(!should_wrap(false, AtRest::None, Policy::Os, store), "words not saved");
        assert!(!should_wrap(true, AtRest::Keychain, Policy::Os, store), "already locked");
        assert!(!should_wrap(true, AtRest::Keychain, Policy::Os, Some(AtRest::Dpapi)), "already locked, by another store");
        assert!(!should_wrap(true, AtRest::None, Policy::None, store), "policy none");
        assert_eq!(next_lock(Ok(Policy::Os), store), store);
        assert_eq!(next_lock(Ok(Policy::None), store), None);
        assert_eq!(next_lock(Err(BAD_POLICY), store), None);
        assert_eq!(lock_words(AtRest::Keychain), "with this Mac user's login keychain");
        assert_eq!(lock_words(AtRest::Dpapi), "to this Windows account");
    }

    /// Each computer's store: DPAPI on Windows, the login keychain on a
    /// Mac, none on Linux, which alone says at startup that the file stays
    /// in the clear. Asking calls no store (keychain.rs's test 8 counts it).
    #[test]
    fn each_computer_has_its_own_store() {
        let here = if cfg!(windows) {
            Some(AtRest::Dpapi)
        } else if cfg!(target_os = "macos") {
            Some(AtRest::Keychain)
        } else {
            None
        };
        let store = os_store().map(|s| s.protect());
        assert_eq!(store, here);
        assert_eq!(next_lock(Ok(Policy::Os), store), here);
        assert_eq!(policy_line(Policy::Os, store).is_some(), here.is_none());
        assert_eq!(should_wrap(true, AtRest::None, Policy::Os, store), here.is_some());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_and_classifies_a_wrong_fingerprint_and_a_flipped_byte() {
        let store = os_store().expect("Windows has DPAPI");
        assert_eq!(store.protect(), AtRest::Dpapi);
        let entropy = [7u8; 32];
        let blob = store.wrap(&entropy, 42).expect("DPAPI wraps for the current user");
        assert!(blob.len() <= 1024, "a blob of {} bytes would not fit the file", blob.len());
        assert_eq!(&store.unwrap(&blob, 42).expect("it opens again")[..], &entropy[..]);
        let wrong = store.unwrap(&blob, 43).expect_err("another fingerprint's entropy does not open it");
        assert_eq!(wrong.refusal, Refusal::DpapiDamaged, "wrong entropy gave {}", code_words(wrong.code));
        let mut flipped = blob.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 0x01;
        let bad = store.unwrap(&flipped, 42).expect_err("a flipped byte does not open");
        assert_eq!(bad.refusal, Refusal::DpapiDamaged, "a flipped byte gave {}", code_words(bad.code));
    }
}
