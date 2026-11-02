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
//! password reset). Minting still writes `protect: "none"` (chia_wallet.rs).
//!
//! macOS and Linux keep `protect: "none"` for now: owner-only (0600) on Unix,
//! which the Bank says. The macOS keychain is the next step; this node reads
//! a file locked by it as one from a newer Star Station, never mints over it.
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
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The file is locked by a store this computer does not have.
    Foreign(AtRest),
    /// DPAPI: another account or PC locked it, or an administrator reset
    /// this account's password.
    DpapiLost,
    /// DPAPI: the locked bytes are damaged (or were changed).
    DpapiDamaged,
    /// Anything else: it may open at the next try.
    NotNow,
}

/// A store's failure: its class and the operating system's code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoreError {
    pub refusal: Refusal,
    pub code: i64,
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
pub trait SecretStore: Sync {
    fn protect(&self) -> AtRest;
    fn wrap(&self, entropy: &[u8; 32], fingerprint: u32) -> Result<Vec<u8>, StoreError>;
    fn unwrap(&self, blob: &[u8], fingerprint: u32) -> Result<Zeroizing<Vec<u8>>, StoreError>;
}

/// This computer's store, when it has one the node uses.
pub fn os_store() -> Option<&'static dyn SecretStore> {
    #[cfg(windows)]
    {
        Some(&dpapi::Dpapi)
    }
    #[cfg(not(windows))]
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

/// What to keep, for a file that is refused because it is locked.
const KEEP: &str = "it is left as it is; keep this file: it opens again for the account that made it, \
                    and if its 24 words were saved they restore the coins in Sage or the Chia wallet";
/// How to start over without losing it.
const MOVE: &str = "to start a new wallet here, move it aside (do not delete it)";

/// The sentence for a locked file this node cannot open: its path, the class
/// and the operating system's number, never anything read from the file.
pub fn refusal_words(path: &Path, e: StoreError) -> String {
    let p = path.display();
    match e.refusal {
        Refusal::Foreign(AtRest::Dpapi) => format!(
            "chia identity file {p} is locked to a Windows account on the computer that made it, so this node cannot open it; {KEEP}; {MOVE}"
        ),
        Refusal::Foreign(other) => format!(
            "chia identity file {p} is locked by a store this computer does not have ({other:?}); {KEEP}; {MOVE}"
        ),
        Refusal::DpapiLost => format!(
            "chia identity file {p} is locked to another Windows account or PC, or an administrator reset this account's password \
             (code {:#x}); {KEEP}; {MOVE}",
            e.code
        ),
        Refusal::DpapiDamaged => {
            format!("chia identity file {p} is locked by Windows, but its locked key is damaged (code {:#x}); {KEEP}", e.code)
        }
        Refusal::NotNow => format!(
            "chia identity file {p} is locked by this computer's store and could not be opened right now (code {:#x}); \
             start the node again",
            e.code
        ),
    }
}

/// The startup line for the policy, or none for the default.
pub fn policy_line(policy: Policy, store: Option<AtRest>) -> Option<String> {
    match (policy, store) {
        (Policy::None, _) => Some(format!(
            "🏦 SSF wallet: {POLICY_ENV}=none: the wallet's file stays in the clear on disk, even once its 24 words are saved"
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
                .ok_or(StoreError { refusal: Refusal::DpapiDamaged, code: DPAPI_INVALID_DATA as i64 })?;
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
        let lost = refusal_words(p, StoreError { refusal: Refusal::DpapiLost, code: 0x8009_000B });
        assert!(lost.contains("chia_identity.json") && lost.contains("0x8009000b"), "{lost}");
        assert!(lost.contains("keep this file") && lost.contains("move it aside"), "{lost}");
        let damaged = refusal_words(p, StoreError { refusal: Refusal::DpapiDamaged, code: 13 });
        assert!(damaged.contains("keep this file") && !damaged.contains("move it aside"), "{damaged}");
        let foreign = refusal_words(p, StoreError { refusal: Refusal::Foreign(AtRest::Dpapi), code: 0 });
        assert!(foreign.contains("Windows account on the computer that made it"), "{foreign}");
        let now = refusal_words(p, StoreError { refusal: Refusal::NotNow, code: 5 });
        assert!(now.contains("start the node again"), "{now}");
    }

    #[test]
    fn the_startup_line_speaks_only_when_the_file_stays_in_the_clear() {
        assert!(policy_line(Policy::Os, Some(AtRest::Dpapi)).is_none());
        assert!(policy_line(Policy::None, Some(AtRest::Dpapi)).unwrap().contains("=none"));
        assert!(policy_line(Policy::Os, None).unwrap().contains("in the clear"));
        assert!(!policy_line(Policy::Os, None).unwrap().contains("owner-only"), "the node does not check that");
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
        assert_eq!(wrong.refusal, Refusal::DpapiDamaged, "wrong entropy gave code {:#x}", wrong.code);
        let mut flipped = blob.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 0x01;
        let bad = store.unwrap(&flipped, 42).expect_err("a flipped byte does not open");
        assert_eq!(bad.refusal, Refusal::DpapiDamaged, "a flipped byte gave code {:#x}", bad.code);
    }
}
