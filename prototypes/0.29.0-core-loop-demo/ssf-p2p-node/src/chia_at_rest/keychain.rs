//! 🍎 The macOS hands of the keychain store (keychain_lock.rs): Apple's own
//! `/usr/bin/security` reads and makes the wallet's keychain item, and a
//! search in this process finds which keychain holds it and whether that
//! keychain is unlocked, with keychain prompts turned off for the process.
//! Built only on a Mac, and not switched on yet: [`super::os_store`] is
//! still none there.
//!
//! This process never asks for the item's data. Its search asks for
//! attributes and references only, so no access check runs and nothing can
//! prompt. Only `security` reads or writes the key, so the item's one
//! trusted program is Apple's tool, the same after any update of the node.
//!
//! Every run of `security`:
//! - by its absolute path, with no shell, in the node's own environment;
//! - with all three of its stdio set here: the node's own stdin and stdout
//!   are the desktop app's channel, so a child never inherits them;
//! - stderr to nothing, so nothing it prints reaches the log;
//! - stopped and reaped at [`SECURITY_DEADLINE`], so a prompt the node did
//!   not expect never hangs it;
//! - only against a keychain whose state was read as unlocked just before,
//!   since `security` has prompts of its own that the node cannot turn off.
//!
//! Tests never touch the login keychain: under `cfg(test)` the login target
//! refuses with [`Code::Guard`] before any search or run. The tests that
//! need a real keychain make a temporary one (`TempKeychain`), and run only
//! where `SSF_KEYCHAIN_TESTS=1` (the macOS CI job).

use std::borrow::Cow;
use std::ffi::{c_char, c_void, OsStr, OsString};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::ptr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use core_foundation::base::{CFType, TCFType};
use security_framework::item::{ItemClass, ItemSearchOptions, Limit, Reference, SearchResult};
use security_framework::os::macos::keychain::{KeychainUserInteractionLock, SecKeychain};
use security_framework::os::macos::keychain_item::SecKeychainItem;
use security_framework_sys::base::{SecKeychainItemRef, SecKeychainRef};
use security_framework_sys::item::kSecValueRef;
use zeroize::Zeroizing;

use super::keychain_lock::{
    add_line, exit_error, find_args, kek_of, status_error, KeychainHands, KeychainStore, Spot, ADD_FLAGS,
    ERR_SEC_ITEM_NOT_FOUND, READ_MAX, SECURITY, SECURITY_DEADLINE, SERVICE,
};
use super::{Code, Refusal, StoreError};

#[cfg(test)]
use std::path::Path;
#[cfg(test)]
use std::sync::atomic::{AtomicU32, Ordering};

// The three calls that neither security-framework 3.7 nor its -sys crate
// binds. All three are deprecated since macOS 10.10 but still exported, and
// `security` itself stands on the same layer.
#[link(name = "Security", kind = "framework")]
extern "C" {
    /// The keychain's state bits; [`UNLOCKED`] is set while it is unlocked.
    /// A pure read: it never prompts.
    fn SecKeychainGetStatus(keychain: SecKeychainRef, status: *mut u32) -> i32;
    /// The keychain's file. `io_len` is the buffer's room going in, and the
    /// path's length (without its NUL) coming out.
    fn SecKeychainGetPath(keychain: SecKeychainRef, io_len: *mut u32, path: *mut c_char) -> i32;
    /// The keychain an item is in, retained for the caller.
    fn SecKeychainItemCopyKeychain(item: SecKeychainItemRef, keychain: *mut SecKeychainRef) -> i32;
}

/// `kSecUnlockStateStatus`: the keychain is unlocked.
const UNLOCKED: u32 = 1;
/// Room for a keychain's path and its NUL (macOS paths are at most 1024).
const PATH_ROOM: usize = 4096;
/// How often a run of `security` is checked for its exit.
const POLL: Duration = Duration::from_millis(10);

/// Keychain prompts off for the whole process, from its first keychain use
/// on. The guard that would turn them back on is kept here and never
/// dropped, and nothing else turns them on, so no lock is needed.
static UI_OFF: OnceLock<Result<KeychainUserInteractionLock, i32>> = OnceLock::new();

/// The store a Mac node locks its wallet's file with: this user's own
/// keychains, through `security`.
// Nothing names it until the store is switched on in the next step
// (os_store); until then it is only built and tested.
#[allow(dead_code)]
pub(crate) static LOGIN: KeychainStore<SecurityTool> =
    KeychainStore::new(SecurityTool::new(Cow::Borrowed(SERVICE), Target::Login));

/// Which keychains the hands use.
enum Target {
    /// This user's search list, and the default keychain for a new item.
    Login,
    /// One keychain file and nothing else: a test's temporary keychain.
    #[cfg(test)]
    At(PathBuf),
}

/// The hands: a search in this process for where the item is, and
/// `/usr/bin/security` for its key.
pub(crate) struct SecurityTool {
    service: Cow<'static, str>,
    target: Target,
    /// Tests: searches in this process.
    #[cfg(test)]
    searches: AtomicU32,
    /// Tests: runs of `security`.
    #[cfg(test)]
    spawns: AtomicU32,
    /// Tests: calls the guard refused.
    #[cfg(test)]
    guarded: AtomicU32,
}

impl SecurityTool {
    const fn new(service: Cow<'static, str>, target: Target) -> SecurityTool {
        SecurityTool {
            service,
            target,
            #[cfg(test)]
            searches: AtomicU32::new(0),
            #[cfg(test)]
            spawns: AtomicU32::new(0),
            #[cfg(test)]
            guarded: AtomicU32::new(0),
        }
    }

    /// Hands for one keychain file only, with a service of their own.
    #[cfg(test)]
    pub(crate) fn at(path: PathBuf, service: String) -> SecurityTool {
        SecurityTool::new(Cow::Owned(service), Target::At(path))
    }

    /// (searches, runs of `security`, calls the guard refused) so far.
    #[cfg(test)]
    pub(crate) fn counts(&self) -> (u32, u32, u32) {
        (self.searches.load(Ordering::Relaxed), self.spawns.load(Ordering::Relaxed), self.guarded.load(Ordering::Relaxed))
    }

    /// Tests never reach the login keychain: every hand refuses there,
    /// before any search or run of `security`.
    fn guard(&self) -> Result<(), StoreError> {
        #[cfg(test)]
        if matches!(self.target, Target::Login) {
            self.guarded.fetch_add(1, Ordering::Relaxed);
            return Err(StoreError { refusal: Refusal::NotNow, code: Code::Guard });
        }
        Ok(())
    }

    /// Where a new item goes: the default keychain, or the target's file.
    fn home(&self) -> Result<SecKeychain, StoreError> {
        let home = match &self.target {
            Target::Login => SecKeychain::default(),
            #[cfg(test)]
            Target::At(path) => SecKeychain::open(path),
        };
        home.map_err(|e| status_error(e.code(), None))
    }

    /// The keychains a search looks in: none named is the search list.
    fn search_list(&self) -> Result<Option<SecKeychain>, StoreError> {
        match &self.target {
            Target::Login => Ok(None),
            #[cfg(test)]
            Target::At(path) => SecKeychain::open(path).map(Some).map_err(|e| status_error(e.code(), None)),
        }
    }

    /// `security` runs only against a keychain read as unlocked right now.
    fn still_unlocked(&self, spot: &Spot) -> Result<(), StoreError> {
        match self.unlocked(spot) {
            Some(true) => Ok(()),
            _ => Err(StoreError { refusal: Refusal::KeychainLocked, code: Code::None }),
        }
    }

    /// One run of `security`, with the store's deadline.
    fn run(&self, args: &[&OsStr], input: Option<&[u8]>, output: Option<&mut [u8]>) -> Result<Ran, StoreError> {
        #[cfg(test)]
        self.spawns.fetch_add(1, Ordering::Relaxed);
        run(args, input, output, SECURITY_DEADLINE)
    }
}

impl KeychainHands for SecurityTool {
    fn service(&self) -> &str {
        &self.service
    }

    /// Prompts off for good, then the keychain a new item would go into
    /// must exist and say what state it is in.
    fn ready(&self) -> Result<(), StoreError> {
        self.guard()?;
        prompts_off()?;
        let home = self.home()?;
        status_of(&home).map(|_| ()).map_err(|code| status_error(code, None))
    }

    /// One search in this process, for attributes and references only, of
    /// at most four results, each turned into its keychain's path and
    /// state. "Not found" is the only empty answer; a result that cannot be
    /// placed is "not now", never "missing".
    fn locate(&self, account: &str) -> Result<Vec<Spot>, StoreError> {
        self.guard()?;
        #[cfg(test)]
        self.searches.fetch_add(1, Ordering::Relaxed);
        let only = self.search_list()?;
        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(&self.service)
            .account(account)
            .load_attributes(true)
            .load_refs(true)
            .limit(Limit::Max(4));
        if let Some(keychain) = &only {
            search.keychains(std::slice::from_ref(keychain));
        }
        let found = match search.search() {
            Ok(found) => found,
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => return Ok(Vec::new()),
            Err(e) => return Err(status_error(e.code(), None)),
        };
        if found.is_empty() {
            return Err(not_now());
        }
        let mut spots: Vec<Spot> = Vec::with_capacity(found.len());
        for result in &found {
            let spot = spot_of(&keychain_of(result)?)?;
            if !spots.iter().any(|s| s.path == spot.path) {
                spots.push(spot);
            }
        }
        Ok(spots)
    }

    fn default_spot(&self) -> Result<Spot, StoreError> {
        self.guard()?;
        spot_of(&self.home()?)
    }

    /// The keychain's state now, opened again by its path. `None` when it
    /// cannot be read, which counts as locked.
    fn unlocked(&self, spot: &Spot) -> Option<bool> {
        self.guard().ok()?;
        let keychain = SecKeychain::open(&spot.path).ok()?;
        unlocked_now(&keychain)
    }

    /// `security find-generic-password -s <service> -a <account> -w <path>`,
    /// its stdout read into a buffer of [`READ_MAX`] bytes that is wiped.
    fn read(&self, spot: &Spot, account: &str) -> Result<Zeroizing<[u8; 32]>, StoreError> {
        self.guard()?;
        self.still_unlocked(spot)?;
        let mut printed = Zeroizing::new([0u8; READ_MAX]);
        let ran = self.run(&find_args(&self.service, account, &spot.path), None, Some(&mut printed[..]))?;
        match ran.exit {
            0 => kek_of(&printed[..ran.printed]),
            exit => Err(exit_error(exit, spot.unlocked)),
        }
    }

    /// `security -q -i` with the add line on its stdin, then end of input,
    /// so it runs that one command and exits with its status. The key is
    /// never in any process's arguments.
    fn add(&self, spot: &Spot, account: &str, label: &str, comment: &str, kek: &[u8; 32]) -> Result<(), StoreError> {
        self.guard()?;
        self.still_unlocked(spot)?;
        let line = add_line(&self.service, account, label, comment, kek, &spot.path)?;
        let ran = self.run(&ADD_FLAGS.map(OsStr::new), Some(line.as_bytes()), None)?;
        match ran.exit {
            0 => Ok(()),
            exit => Err(exit_error(exit, spot.unlocked)),
        }
    }
}

fn not_now() -> StoreError {
    StoreError { refusal: Refusal::NotNow, code: Code::None }
}

/// Keychain prompts off for this process, once and for good. If that
/// fails, nothing is asked of any keychain.
fn prompts_off() -> Result<(), StoreError> {
    match UI_OFF.get_or_init(|| SecKeychain::disable_user_interaction().map_err(|e| e.code())) {
        Ok(_) => Ok(()),
        Err(code) => Err(StoreError { refusal: Refusal::NotNow, code: Code::OsStatus(*code) }),
    }
}

/// The keychain's state bits, or the status of the failed read.
fn status_of(keychain: &SecKeychain) -> Result<u32, i32> {
    let mut status = 0u32;
    // SAFETY: a live keychain reference and a valid out pointer.
    let code = unsafe { SecKeychainGetStatus(keychain.as_concrete_TypeRef(), &mut status) };
    match code {
        0 => Ok(status),
        code => Err(code),
    }
}

/// Whether the keychain is unlocked now; `None` when its state cannot be read.
fn unlocked_now(keychain: &SecKeychain) -> Option<bool> {
    status_of(keychain).ok().map(|status| status & UNLOCKED != 0)
}

/// The keychain's own file, as `security` is given it.
fn path_of(keychain: &SecKeychain) -> Result<PathBuf, StoreError> {
    let mut buf = vec![0u8; PATH_ROOM];
    let mut len = PATH_ROOM as u32;
    // SAFETY: `buf` has `len` bytes of room; the call writes at most that
    // many, its NUL included, and says how long the path is.
    let code = unsafe { SecKeychainGetPath(keychain.as_concrete_TypeRef(), &mut len, buf.as_mut_ptr().cast()) };
    if code != 0 {
        return Err(status_error(code, None));
    }
    let len = len as usize;
    if len == 0 || len >= PATH_ROOM || buf[..len].contains(&0) {
        return Err(not_now());
    }
    buf.truncate(len);
    Ok(PathBuf::from(OsString::from_vec(buf)))
}

/// A keychain's path and its state as read now.
fn spot_of(keychain: &SecKeychain) -> Result<Spot, StoreError> {
    Ok(Spot { path: path_of(keychain)?, unlocked: unlocked_now(keychain) })
}

/// The keychain that holds one search result. The result is a dictionary
/// of attributes with the item's reference under `kSecValueRef`, which is
/// kept only if it is a keychain item.
fn keychain_of(result: &SearchResult) -> Result<SecKeychain, StoreError> {
    let item = match result {
        SearchResult::Dict(dict) => {
            // SAFETY: a constant of the Security framework.
            let key = unsafe { kSecValueRef }.cast::<c_void>();
            let value = dict.find(key).map(|value| *value).filter(|value| !value.is_null()).ok_or_else(not_now)?;
            // SAFETY: a live value the dictionary holds; the get rule retains it.
            let value = unsafe { CFType::wrap_under_get_rule(value) };
            value.downcast_into::<SecKeychainItem>().ok_or_else(not_now)?
        }
        SearchResult::Ref(Reference::KeychainItem(item)) => item.clone(),
        _ => return Err(not_now()),
    };
    let mut keychain: SecKeychainRef = ptr::null_mut();
    // SAFETY: a live item reference and a valid out pointer.
    let code = unsafe { SecKeychainItemCopyKeychain(item.as_concrete_TypeRef(), &mut keychain) };
    if code != 0 {
        return Err(status_error(code, None));
    }
    if keychain.is_null() {
        return Err(not_now());
    }
    // SAFETY: the copy is retained for us (the create rule) and released once.
    Ok(unsafe { SecKeychain::wrap_under_create_rule(keychain) })
}

/// How one run of `security` ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ran {
    /// Its exit status: the low byte of an OSStatus, 0 for success.
    exit: u8,
    /// How many bytes of its stdout landed in the output buffer: all of
    /// them, or the buffer's whole length when it printed more.
    printed: usize,
}

/// Start `security` with these arguments. Its stdin is a pipe only when
/// something is written to it, its stdout only when it is read, and its
/// stderr goes nowhere.
fn spawn(args: &[&OsStr], input: bool, output: bool) -> Result<Child, StoreError> {
    let piped = |on: bool| if on { Stdio::piped() } else { Stdio::null() };
    Command::new(SECURITY)
        .args(args)
        .stdin(piped(input))
        .stdout(piped(output))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| StoreError { refusal: Refusal::NotNow, code: Code::Spawn(e.raw_os_error().unwrap_or(0)) })
}

/// Kill and reap.
fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The child's exit, or, past the deadline, the child killed and reaped.
fn finish(child: &mut Child, deadline: Duration) -> Result<ExitStatus, StoreError> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if start.elapsed() < deadline => std::thread::sleep(POLL),
            Ok(None) => {
                stop(child);
                return Err(StoreError { refusal: Refusal::NotNow, code: Code::TimedOut });
            }
            Err(_) => {
                stop(child);
                return Err(not_now());
            }
        }
    }
}

/// Read until the end or until `into` is full, straight into `into`.
fn read_into(mut from: impl Read, into: &mut [u8]) -> usize {
    let mut filled = 0;
    while filled < into.len() {
        match from.read(&mut into[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    filled
}

/// What fits into `into`, then the rest to its end into a wiped scratch
/// buffer that is thrown away, so the writer never waits on a full pipe
/// however much it prints. Says how many bytes landed in `into`.
fn drain_into(mut from: impl Read, into: &mut [u8]) -> usize {
    let kept = read_into(&mut from, into);
    let mut rest = Zeroizing::new([0u8; 4096]);
    while read_into(&mut from, &mut rest[..]) > 0 {}
    kept
}

/// One run of `security`: `input` written to its stdin and then closed,
/// and its exit awaited until `deadline`. Its stdout is read while it
/// runs, on a thread of its own: at most `output.len()` bytes straight
/// into `output`, and the rest to its end and thrown away. Our own item
/// prints 65 bytes, but an item the node did not make can print more than
/// a pipe holds, and `security` would then wait on the full pipe until it
/// was killed at the deadline; read this way it always ends by itself,
/// and a full `output` tells the caller the output was not ours. The
/// reading ends when `security` does, killed or not: it starts no program
/// that could keep its stdout open. A kill at the deadline, a signal, a
/// failed write or a failed start is an error here; any exit status is the
/// caller's to class.
fn run(args: &[&OsStr], input: Option<&[u8]>, output: Option<&mut [u8]>, deadline: Duration) -> Result<Ran, StoreError> {
    let mut child = spawn(args, input.is_some(), output.is_some())?;
    let stdout = child.stdout.take();
    std::thread::scope(|scope| {
        let reader = match (output, stdout) {
            (Some(into), Some(stdout)) => {
                match std::thread::Builder::new().spawn_scoped(scope, move || drain_into(stdout, into)) {
                    Ok(reader) => Some(reader),
                    Err(_) => {
                        stop(&mut child);
                        return Err(not_now());
                    }
                }
            }
            _ => None,
        };
        // Dropping the pipe closes it: `-i` reads to the end and exits.
        let written = input.map(|line| child.stdin.take().map(|mut stdin| stdin.write_all(line)));
        let status = match written {
            None | Some(Some(Ok(()))) => finish(&mut child, deadline),
            Some(_) => {
                stop(&mut child);
                Err(not_now())
            }
        };
        // The child has ended or been killed, so its stdout is at its end.
        let printed = match reader {
            Some(reader) => reader.join().map_err(|_| not_now()),
            None => Ok(0),
        };
        let (status, printed) = (status?, printed?);
        let exit = status.code().and_then(|code| u8::try_from(code).ok()).ok_or_else(not_now)?;
        Ok(Ran { exit, printed })
    })
}

/// The variable that lets tests use a real (temporary) keychain.
#[cfg(test)]
pub(crate) const TESTS_ENV: &str = "SSF_KEYCHAIN_TESTS";

/// Whether a test may use a real keychain: only with `SSF_KEYCHAIN_TESTS=1`,
/// which the macOS CI job sets, since a temporary keychain sits on this
/// user's search list while it lives. Without it the test says so, and
/// should return at once.
#[cfg(test)]
pub(crate) fn tests_enabled(test: &str) -> bool {
    let on = std::env::var_os(TESTS_ENV).is_some_and(|v| v == "1");
    if !on {
        eprintln!("🍎 {test}: skipped; set {TESTS_ENV}=1 to run it with a temporary keychain");
    }
    on
}

/// How long an in-process keychain call may take in a test: a refusal
/// comes at once, and a prompt would wait for ever.
#[cfg(test)]
pub(crate) const IN_PROCESS_DEADLINE: Duration = Duration::from_secs(30);

/// Runs `f` on a thread of its own and waits at most
/// [`IN_PROCESS_DEADLINE`], so a keychain call that would prompt fails the
/// test instead of hanging the job.
#[cfg(test)]
pub(crate) fn within<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    use std::sync::mpsc::{channel, RecvTimeoutError};
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(IN_PROCESS_DEADLINE) {
        Ok(value) => value,
        Err(RecvTimeoutError::Timeout) => {
            panic!("{what} took over {} s: a keychain prompt would have shown", IN_PROCESS_DEADLINE.as_secs())
        }
        Err(RecvTimeoutError::Disconnected) => panic!("{what} failed on its thread"),
    }
}

/// A keychain of a test's own: a new file in a new temporary folder, with
/// a random password, unlocked, set never to lock by itself, and a service
/// of its own. Making it puts it on this user's search list; dropping it,
/// also after a panic, runs `security delete-keychain`, which takes it off
/// again, then removes the folder. The login keychain is never touched.
/// A test makes one only once [`tests_enabled`] says yes.
///
/// The file is `<folder>/Library/Keychains/t.keychain-db`: securityd makes
/// a keychain in the format the login keychain has, with partition IDs on
/// its items, only when its path has `/Library/Keychains` in it (but does
/// not start with it). Anywhere else it makes the old format, which skips
/// the partition check, and the update drill would test nothing.
#[cfg(test)]
pub(crate) struct TempKeychain {
    dir: PathBuf,
    path: PathBuf,
    service: String,
    /// The temporary keychain's own password, nothing of a wallet's.
    password: Zeroizing<String>,
    keychain: SecKeychain,
}

#[cfg(test)]
impl TempKeychain {
    pub(crate) fn new() -> TempKeychain {
        within("making a temporary keychain", TempKeychain::make)
    }

    fn make() -> TempKeychain {
        use security_framework::os::macos::keychain::{CreateOptions, KeychainSettings};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("ssf-keychain-{pid}-{n}-{:08x}", rand::random::<u32>()));
        let home = dir.join("Library").join("Keychains");
        std::fs::create_dir_all(&home).expect("a temporary folder for the keychain");
        let path = home.join("t.keychain-db");
        let mut secret = Zeroizing::new([0u8; 16]);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut secret[..]);
        let password = Zeroizing::new(hex::encode(&secret[..]));
        let keychain = match CreateOptions::new().password(&password).create(&path) {
            Ok(keychain) => keychain,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                panic!("could not make a temporary keychain: OSStatus {}", e.code());
            }
        };
        let made = TempKeychain { dir, path, service: format!("{SERVICE}.test-{pid}-{n}"), password, keychain };
        if let Err(e) = made.keychain().set_settings(&KeychainSettings::new()) {
            panic!("could not stop the temporary keychain locking by itself: OSStatus {}", e.code());
        }
        made
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn service(&self) -> &str {
        &self.service
    }

    /// The keychain itself, for in-process calls.
    pub(crate) fn keychain(&self) -> SecKeychain {
        self.keychain.clone()
    }

    /// Hands for this keychain only.
    pub(crate) fn tool(&self) -> SecurityTool {
        SecurityTool::at(self.path.clone(), self.service.clone())
    }

    /// A store at this keychain only.
    pub(crate) fn store(&self) -> KeychainStore<SecurityTool> {
        KeychainStore::new(self.tool())
    }

    /// `security lock-keychain <path>`.
    pub(crate) fn lock(&self) {
        let ran = run(&[OsStr::new("lock-keychain"), self.path.as_os_str()], None, None, SECURITY_DEADLINE);
        assert_eq!(ran.map(|r| r.exit), Ok(0), "security locks the temporary keychain");
    }

    /// Unlock it again with its password.
    pub(crate) fn unlock(&self) {
        let (mut keychain, password) = (self.keychain(), self.password.clone());
        let unlocked =
            within("unlocking the temporary keychain", move || keychain.unlock(Some(password.as_str())).map_err(|e| e.code()));
        assert_eq!(unlocked, Ok(()), "the temporary keychain unlocks with its password");
    }

    /// Every item of its service, as attributes only (never their data),
    /// by the names the search gives them (`svce`, `acct`, `labl`, ...).
    pub(crate) fn items(&self) -> Vec<std::collections::HashMap<String, String>> {
        let (keychain, service) = (self.keychain(), self.service.clone());
        within("an attribute search", move || {
            let found = ItemSearchOptions::new()
                .class(ItemClass::generic_password())
                .service(&service)
                .keychains(&[keychain])
                .load_attributes(true)
                .limit(Limit::All)
                .search();
            match found {
                Ok(found) => found.iter().filter_map(SearchResult::simplify_dict).collect(),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Vec::new(),
                Err(e) => panic!("the attribute search failed: OSStatus {}", e.code()),
            }
        })
    }

    /// How many items its service has.
    pub(crate) fn item_count(&self) -> usize {
        self.items().len()
    }
}

#[cfg(test)]
impl Drop for TempKeychain {
    fn drop(&mut self) {
        let _ = run(&[OsStr::new("delete-keychain"), self.path.as_os_str()], None, None, SECURITY_DEADLINE);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    //! The store with a real keychain. Each test makes its own temporary
    //! keychain and service, and every call names that keychain. These run
    //! only with `SSF_KEYCHAIN_TESTS=1`, which the macOS CI job sets, so
    //! `cargo test` on a developer's Mac never changes their search list.
    //! Nothing here prints a key, an entropy or an item's data: results are
    //! compared, and failures name the step and the class.
    use super::*;
    use std::sync::Arc;

    use core_foundation::string::{CFString, CFStringRef};
    use security_framework_sys::item::{
        kSecAttrAccount, kSecAttrComment, kSecAttrDescription, kSecAttrLabel, kSecAttrService,
    };

    use crate::chia_at_rest::keychain_lock::{
        account, comment, label, seal, ERR_SEC_AUTH_FAILED, ERR_SEC_INTERACTION_NOT_ALLOWED, EXIT_DUPLICATE,
        EXIT_NOT_FOUND, KIND,
    };
    use crate::chia_at_rest::SecretStore;

    const ENTROPY: [u8; 32] = [1; 32];
    const FP: u32 = 42;
    /// The key check's bytes in a blob: the same key gives the same bytes.
    const KCV: std::ops::Range<usize> = 5..13;
    /// The start of the names of the variables the drill's child reads.
    const DRILL: &str = "SSF_KEYCHAIN_DRILL_";
    /// The drill's child, by its full test name.
    const DRILL_CHILD: &str = "chia_at_rest::keychain::tests::drill_child";
    const SECOND: Duration = Duration::from_secs(1);

    type Store = Arc<KeychainStore<SecurityTool>>;

    /// The value, or a failure that names the step and the class.
    fn ok<T>(what: &str, r: Result<T, StoreError>) -> T {
        r.unwrap_or_else(|e| panic!("{what}: {e:?}"))
    }

    /// The refusal, or a failure that says only that there was none.
    fn refused<T>(what: &str, r: Result<T, StoreError>) -> StoreError {
        match r {
            Ok(_) => panic!("{what}: it was not refused"),
            Err(e) => e,
        }
    }

    /// A wrap of the test entropy on a thread of its own, and how long it took.
    fn wrap_in(store: &Store, fingerprint: u32) -> (Result<Vec<u8>, StoreError>, Duration) {
        let store = Arc::clone(store);
        within("a wrap", move || {
            let start = Instant::now();
            let wrapped = store.wrap(&ENTROPY, fingerprint);
            (wrapped, start.elapsed())
        })
    }

    /// An open on a thread of its own, and how long it took.
    fn open_in(store: &Store, blob: &[u8], fingerprint: u32) -> (Result<Zeroizing<Vec<u8>>, StoreError>, Duration) {
        let (store, blob) = (Arc::clone(store), blob.to_vec());
        within("an open", move || {
            let start = Instant::now();
            let opened = store.unwrap(&blob, fingerprint);
            (opened, start.elapsed())
        })
    }

    /// The blob opens to the test entropy.
    fn assert_opens(store: &Store, blob: &[u8], fingerprint: u32, why: &str) {
        let opened = ok(why, open_in(store, blob, fingerprint).0);
        assert!(opened[..] == ENTROPY[..], "{why}: it opened to other bytes");
    }

    /// An attribute's key as the search's dictionaries name it.
    fn key(name: CFStringRef) -> String {
        // SAFETY: a constant string of the Security framework.
        unsafe { CFString::wrap_under_get_rule(name) }.to_string()
    }

    /// One `security` run with the store's deadline and nothing on stdin.
    fn security(args: &[&OsStr]) -> u8 {
        ok("security runs", run(args, None, None, SECURITY_DEADLINE)).exit
    }

    /// 32 random bytes, wiped when dropped.
    fn random_key() -> Zeroizing<[u8; 32]> {
        let mut key = Zeroizing::new([0u8; 32]);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key[..]);
        key
    }

    /// A hash to compare secrets by, so they are never printed.
    fn sum(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    /// The number a drill result carries for a code.
    fn number(code: Code) -> i64 {
        match code {
            Code::OsStatus(status) => i64::from(status),
            Code::Exit(exit) => i64::from(exit),
            Code::Spawn(errno) => i64::from(errno),
            Code::Dpapi(code) => i64::from(code),
            Code::None | Code::TimedOut | Code::Guard => -1,
        }
    }

    /// The login keychain is out of the tests' reach: its hands refuse with
    /// the guard's code, with no search and no run of `security`.
    #[test]
    fn tests_never_reach_the_login_keychain() {
        if !tests_enabled("tests_never_reach_the_login_keychain") {
            return;
        }
        let store = KeychainStore::new(SecurityTool::new(Cow::Borrowed(SERVICE), Target::Login));
        let e = refused("a wrap at the login keychain", store.wrap(&ENTROPY, FP));
        assert_eq!((e.refusal, e.code), (Refusal::NotNow, Code::Guard));
        let blob = ok("a blob of the right shape", seal(&[7; 32], &[9; 24], &ENTROPY, FP));
        let e = refused("an open at the login keychain", store.unwrap(&blob, FP));
        assert_eq!((e.refusal, e.code), (Refusal::NotNow, Code::Guard));
        assert_eq!(store.hands().counts(), (0, 0, 2), "no search, no run of security");
    }

    /// Test 1. Wrap, open, and a second wrap that reuses the item, each in under
    /// 2 s; one item with the node's names; another fingerprint is missing
    /// and a flipped byte is damage; prompts stay off.
    #[test]
    fn keychain_round_trips_in_a_temp_keychain() {
        if !tests_enabled("keychain_round_trips_in_a_temp_keychain") {
            return;
        }
        let tk = TempKeychain::new();
        let store: Store = Arc::new(tk.store());
        let two = 2 * SECOND;

        let (first, took) = wrap_in(&store, FP);
        let first = ok("the first wrap", first);
        assert!(took < two, "the first wrap took {took:?}");
        let (opened, took) = open_in(&store, &first, FP);
        assert!(ok("the first open", opened)[..] == ENTROPY[..], "it opened to other bytes");
        assert!(took < two, "the open took {took:?}");
        let (second, took) = wrap_in(&store, FP);
        let second = ok("the second wrap", second);
        assert!(took < two, "the second wrap took {took:?}");
        assert!(first != second, "each wrap takes a new nonce");
        assert!(first[KCV] == second[KCV], "the second wrap reused the item's key");
        assert_opens(&store, &second, FP, "the second blob");
        assert_eq!(store.hands().counts().1, 4, "one add, then three reads");

        let found = tk.items();
        assert_eq!(found.len(), 1, "one item for the wallet");
        let attr = |name: CFStringRef| found[0].get(&key(name)).cloned();
        // SAFETY (each key): constants of the Security framework.
        assert_eq!(attr(unsafe { kSecAttrService }), Some(tk.service().to_string()), "service");
        assert_eq!(attr(unsafe { kSecAttrAccount }), Some(account(FP)), "account");
        assert_eq!(attr(unsafe { kSecAttrLabel }), Some(label(FP)), "label");
        assert_eq!(attr(unsafe { kSecAttrDescription }), Some(KIND.to_string()), "kind");
        assert_eq!(attr(unsafe { kSecAttrComment }), Some(comment(FP)), "comment");

        let e = refused("another fingerprint", open_in(&store, &first, FP + 1).0);
        assert_eq!((e.refusal, e.code), (Refusal::KeychainMissing, Code::OsStatus(ERR_SEC_ITEM_NOT_FOUND)));
        let mut flipped = first.clone();
        flipped[40] ^= 0x01;
        let e = refused("a flipped byte", open_in(&store, &flipped, FP).0);
        assert_eq!(e.refusal, Refusal::KeychainDamaged);

        let allowed = within("reading the prompt setting", SecKeychain::user_interaction_allowed);
        assert_eq!(allowed.map_err(|e| e.code()), Ok(false), "keychain prompts stay off for the process");
    }

    /// Test 2. `security`'s exit is the low byte of its OSStatus: a find that
    /// finds nothing is 44, an add through `-i` is 0, the same add again 45.
    #[test]
    fn security_exits_are_osstatus_low_bytes() {
        if !tests_enabled("security_exits_are_osstatus_low_bytes") {
            return;
        }
        let tk = TempKeychain::new();
        let acct = account(7);
        let mut printed = Zeroizing::new([0u8; READ_MAX]);
        let find = find_args(tk.service(), &acct, tk.path());
        let ran = ok("a find", run(&find, None, Some(&mut printed[..]), SECURITY_DEADLINE));
        assert_eq!((ran.exit, ran.printed), (EXIT_NOT_FOUND, 0), "a find of an account that is not there");

        let kek = random_key();
        let line = ok("the add line", add_line(tk.service(), &acct, &label(7), &comment(7), &kek, tk.path()));
        let add = ADD_FLAGS.map(OsStr::new);
        assert_eq!(ok("an add", run(&add, Some(line.as_bytes()), None, SECURITY_DEADLINE)).exit, 0, "a new item");
        let again = ok("the same add", run(&add, Some(line.as_bytes()), None, SECURITY_DEADLINE));
        assert_eq!(again.exit, EXIT_DUPLICATE, "the same account again is a duplicate");

        let ran = ok("a find", run(&find, None, Some(&mut printed[..]), SECURITY_DEADLINE));
        assert_eq!((ran.exit, ran.printed), (0, 65), "64 hex digits and a newline");
        let back = ok("the printed key", kek_of(&printed[..ran.printed]));
        assert!(*back == *kek, "security gives back the key it was given");
        assert_eq!(tk.item_count(), 1);
    }

    /// An item the node did not make, at the wallet's own service and
    /// account, whose data is longer than any pipe holds (64 KiB at most):
    /// `security` still prints it all and exits by itself, at once, and a
    /// wrap and an open each call it damage, not "not now", and leave it.
    #[test]
    fn a_foreign_item_longer_than_a_pipe_is_damage_at_once() {
        if !tests_enabled("a_foreign_item_longer_than_a_pipe_is_damage_at_once") {
            return;
        }
        let tk = TempKeychain::new();
        let acct = account(FP);
        // Printable, so `security` prints it as it is. It is no secret, so
        // it goes on the arguments: a line for `-i` holds only MAX_LINE.
        let data = "z".repeat(100 * 1024);
        let added = security(&[
            OsStr::new("add-generic-password"),
            OsStr::new("-s"),
            OsStr::new(tk.service()),
            OsStr::new("-a"),
            OsStr::new(&acct),
            OsStr::new("-w"),
            OsStr::new(&data),
            tk.path().as_os_str(),
        ]);
        assert_eq!(added, 0, "security adds the long item");

        let mut printed = Zeroizing::new([0u8; READ_MAX]);
        let find = find_args(tk.service(), &acct, tk.path());
        let start = Instant::now();
        let ran = ok("a find of the long item", run(&find, None, Some(&mut printed[..]), 2 * SECOND));
        let took = start.elapsed();
        assert_eq!((ran.exit, ran.printed), (0, READ_MAX), "security exits by itself, and the buffer is full");
        assert!(took < 2 * SECOND, "the find took {took:?}");
        assert!(printed.iter().all(|b| *b == b'z'), "the buffer holds the start of what security printed");

        let store: Store = Arc::new(tk.store());
        let (wrapped, took) = wrap_in(&store, FP);
        assert_eq!(refused("a wrap over the long item", wrapped).refusal, Refusal::KeychainDamaged);
        assert!(took < 2 * SECOND, "the wrap took {took:?}");
        let blob = ok("a blob of the right shape", seal(&[7; 32], &[9; 24], &ENTROPY, FP));
        let (opened, took) = open_in(&store, &blob, FP);
        assert_eq!(refused("an open with the long item", opened).refusal, Refusal::KeychainDamaged);
        assert!(took < 2 * SECOND, "the open took {took:?}");
        assert_eq!(store.hands().counts().1, 2, "one read each, and no add");
        assert_eq!(tk.item_count(), 1, "the long item is left as it is");
    }

    /// Test 3. An item deleted with `security` is missing; a new wrap of the
    /// clear copy makes a new item, and the old blob is then replaced.
    #[test]
    fn a_deleted_or_remade_item_is_missing_or_replaced() {
        if !tests_enabled("a_deleted_or_remade_item_is_missing_or_replaced") {
            return;
        }
        let tk = TempKeychain::new();
        let store: Store = Arc::new(tk.store());
        let old = ok("the first wrap", wrap_in(&store, FP).0);
        let acct = account(FP);
        let deleted = security(&[
            OsStr::new("delete-generic-password"),
            OsStr::new("-s"),
            OsStr::new(tk.service()),
            OsStr::new("-a"),
            OsStr::new(&acct),
            tk.path().as_os_str(),
        ]);
        assert_eq!(deleted, 0, "security deletes the item");
        let e = refused("the deleted item", open_in(&store, &old, FP).0);
        assert_eq!((e.refusal, e.code), (Refusal::KeychainMissing, Code::OsStatus(ERR_SEC_ITEM_NOT_FOUND)));

        let new = ok("a wrap of the clear copy", wrap_in(&store, FP).0);
        assert!(new[KCV] != old[KCV], "a new item with a new key");
        assert_eq!(tk.item_count(), 1);
        let e = refused("the old blob", open_in(&store, &old, FP).0);
        assert_eq!(e.refusal, Refusal::KeychainReplaced);
        assert_opens(&store, &new, FP, "the new blob");
    }

    /// Test 4. A locked keychain is refused in under 1 s with no run of
    /// `security`, for an open and for a wrap; once unlocked, it opens.
    #[test]
    fn a_locked_temp_keychain_is_refused_without_a_spawn() {
        if !tests_enabled("a_locked_temp_keychain_is_refused_without_a_spawn") {
            return;
        }
        let tk = TempKeychain::new();
        let store: Store = Arc::new(tk.store());
        let blob = ok("the wrap", wrap_in(&store, FP).0);
        tk.lock();
        let spawns = store.hands().counts().1;

        let (opened, took) = open_in(&store, &blob, FP);
        assert_eq!(refused("an open while locked", opened).refusal, Refusal::KeychainLocked);
        assert!(took < SECOND, "the refusal took {took:?}");
        let (wrapped, took) = wrap_in(&store, FP + 1);
        assert_eq!(refused("a new wrap while locked", wrapped).refusal, Refusal::KeychainLocked);
        assert!(took < SECOND, "the refusal took {took:?}");
        assert_eq!(store.hands().counts().1, spawns, "no run of security against a locked keychain");

        tk.unlock();
        assert_opens(&store, &blob, FP, "unlocked again");
        assert_eq!(tk.item_count(), 1, "the wrap while locked added no item");
    }

    /// Test 5. A `security` that never ends (`-i` with its stdin held open) is
    /// killed at its deadline and reaped.
    #[test]
    fn a_stuck_security_is_killed_at_its_deadline() {
        if !tests_enabled("a_stuck_security_is_killed_at_its_deadline") {
            return;
        }
        let mut child = ok("security starts", spawn(&[OsStr::new("-i")], true, false));
        let pid = child.id();
        let start = Instant::now();
        let e = refused("a stuck security", finish(&mut child, SECOND));
        let took = start.elapsed();
        assert_eq!((e.refusal, e.code), (Refusal::NotNow, Code::TimedOut));
        assert!(took >= SECOND && took < SECOND * 5 / 2, "it took {took:?}");
        assert!(matches!(child.try_wait(), Ok(Some(_))), "it was waited for");
        let ps = Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .expect("ps runs");
        assert!(String::from_utf8_lossy(&ps.stdout).trim().is_empty(), "process {pid} is still there");
    }

    /// Test 6. With prompts off, this process cannot read an item `security`
    /// made: refused within 2 s, and no data comes back. "Not found" would
    /// prove nothing, so it fails the test.
    #[test]
    fn the_node_cannot_read_a_security_item_in_process() {
        if !tests_enabled("the_node_cannot_read_a_security_item_in_process") {
            return;
        }
        let tk = TempKeychain::new();
        let store: Store = Arc::new(tk.store());
        ok("the wrap", wrap_in(&store, FP).0);
        let (keychain, service, acct) = (tk.keychain(), tk.service().to_string(), account(FP));
        let (status, took) = within("an in-process read", move || {
            let start = Instant::now();
            let status = match keychain.find_generic_password(&service, &acct) {
                Ok(_) => 0,
                Err(e) => e.code(),
            };
            (status, start.elapsed())
        });
        assert_ne!(status, ERR_SEC_ITEM_NOT_FOUND, "the item was not found, which proves nothing");
        assert!(
            status == ERR_SEC_AUTH_FAILED || status == ERR_SEC_INTERACTION_NOT_ALLOWED,
            "an in-process read gave OSStatus {status}; only security may read the key"
        );
        assert!(took < 2 * SECOND, "the refusal took {took:?}");
    }

    /// The `CDHash=` line of `codesign -d`, if the file is signed.
    fn cdhash(exe: &Path) -> Option<String> {
        let shown = Command::new("/usr/bin/codesign").args(["-d", "--verbose=4"]).arg(exe).stdin(Stdio::null()).output().ok()?;
        [shown.stdout, shown.stderr]
            .iter()
            .flat_map(|text| String::from_utf8_lossy(text).lines().map(str::to_string).collect::<Vec<_>>())
            .find_map(|line| line.strip_prefix("CDHash=").map(str::to_string))
    }

    /// `status=<n> same=<bool>`, as the drill's child writes it.
    fn drill_result(written: &str) -> Option<(i64, bool)> {
        let mut words = written.split_whitespace();
        let status = words.next()?.strip_prefix("status=")?.parse().ok()?;
        let same = words.next()?.strip_prefix("same=")?.parse().ok()?;
        words.next().is_none().then_some((status, same))
    }

    /// Run the drill's child in `copy` for one item, and read its result.
    /// It is killed at 60 s: only a prompt would take that long.
    fn drill(tk: &TempKeychain, copy: &Path, item: &str, account: &str, mode: &str, sum: &str) -> (i64, bool) {
        let out = tk.dir.join(format!("drill-{item}.out"));
        let mut child = Command::new(copy)
            .args([DRILL_CHILD, "--exact", "--ignored", "--test-threads=1"])
            .env(format!("{DRILL}PATH"), tk.path())
            .env(format!("{DRILL}PW"), tk.password.as_str())
            .env(format!("{DRILL}SERVICE"), tk.service())
            .env(format!("{DRILL}ACCOUNT"), account)
            .env(format!("{DRILL}MODE"), mode)
            .env(format!("{DRILL}SUM"), sum)
            .env(format!("{DRILL}OUT"), &out)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the re-signed copy starts");
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if start.elapsed() < 60 * SECOND => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    stop(&mut child);
                    panic!("the drill's child for item ({item}) ran over 60 s: a prompt would have shown");
                }
            }
        };
        let written = std::fs::read_to_string(&out)
            .unwrap_or_else(|_| panic!("the drill's child for item ({item}) wrote no result ({status})"));
        drill_result(&written).unwrap_or_else(|| panic!("the drill's child for item ({item}) wrote {written:?}"))
    }

    /// Test 7. The update drill, the merge gate. An app update, played by a copy
    /// of this binary signed again so that it counts as another build,
    /// opens the item `security` made with no prompt, while the two items
    /// made the other ways are refused to it. This process is refused the
    /// any-app item first, which shows the partition check is on.
    #[test]
    fn update_drill() {
        if !tests_enabled("update_drill") {
            return;
        }
        let tk = TempKeychain::new();
        let tool = Arc::new(tk.tool());
        let (service, path) = (tk.service().to_string(), tk.path().to_path_buf());
        {
            let tool = Arc::clone(&tool);
            ok("ready", within("ready", move || tool.ready()));
        }

        // (a) Through the production add: `security -q -i`.
        let kek_a = random_key();
        let sum_a = sum(&kek_a[..]);
        {
            let (tool, kek) = (Arc::clone(&tool), kek_a.clone());
            let added = within("the production add", move || {
                let spot = tool.default_spot()?;
                tool.add(&spot, &account(1), &label(1), &comment(1), &kek)
            });
            ok("security adds item (a)", added);
        }

        // (b) Made in this process, so only this build may read it. This
        // process reads it back at once, as a check of the control.
        let secret_b = random_key();
        let sum_b = sum(&secret_b[..]);
        {
            let (keychain, service, secret) = (tk.keychain(), service.clone(), secret_b.clone());
            let added = within("an in-process add", move || keychain.add_generic_password(&service, "drill/b", &secret[..]));
            assert_eq!(added.map_err(|e| e.code()), Ok(()), "this process adds item (b)");
        }
        let (keychain, service_b, sum_check) = (tk.keychain(), service.clone(), sum_b.clone());
        let read_b = within("an in-process read of (b)", move || match keychain.find_generic_password(&service_b, "drill/b") {
            Ok((data, _)) => (0, sum(&data) == sum_check),
            Err(e) => (e.code(), false),
        });
        assert_eq!(read_b, (0, true), "the process that made item (b) reads it");

        // (c) Any app may read it: `security add-generic-password -A`, also
        // through stdin, so its data stays off the arguments.
        let secret_c = Zeroizing::new(hex::encode(&random_key()[..]));
        let sum_c = sum(secret_c.as_bytes());
        let shown = path.to_str().expect("a temporary path in UTF-8");
        assert!(!shown.contains(['"', '\\', '\n']), "a temporary path that security reads back as it is");
        let line_c = Zeroizing::new(format!(
            "add-generic-password -A -s \"{service}\" -a \"drill/c\" -w {} \"{shown}\"\n",
            secret_c.as_str()
        ));
        let add = ADD_FLAGS.map(OsStr::new);
        let ran = ok("security adds item (c)", run(&add, Some(line_c.as_bytes()), None, SECURITY_DEADLINE));
        assert_eq!(ran.exit, 0, "security adds item (c)");

        // The control for (c): only the partition check keeps this process,
        // which is not `security`, from an any-app item, with prompts off.
        // A keychain in the old format has no such check and would give the
        // data here, and then (c) below would prove nothing.
        let (keychain, service_c) = (tk.keychain(), service.clone());
        let read_c = within("an in-process read of (c)", move || match keychain.find_generic_password(&service_c, "drill/c") {
            Ok(_) => 0,
            Err(e) => e.code(),
        });
        assert!(
            read_c == ERR_SEC_AUTH_FAILED || read_c == ERR_SEC_INTERACTION_NOT_ALLOWED,
            "this process read item (c) with OSStatus {read_c}: the temporary keychain is not partition-protected"
        );

        // The update: the same code, signed again, so it is another build.
        let exe = std::env::current_exe().expect("this test binary");
        let copy = tk.dir.join("update-drill");
        std::fs::copy(&exe, &copy).expect("a copy of this test binary");
        let signed = Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--identifier", "org.starstationfurlong.update-drill"])
            .arg(&copy)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("codesign runs");
        assert!(signed.success(), "codesign signs the copy ({signed})");
        let (before, after) = (cdhash(&exe), cdhash(&copy));
        assert!(after.is_some(), "the copy is signed");
        assert_ne!(before, after, "the copy has another code hash than this binary");

        let a = drill(&tk, &copy, "a", &account(1), "tool", &sum_a);
        let b = drill(&tk, &copy, "b", "drill/b", "inproc", &sum_b);
        let c = drill(&tk, &copy, "c", "drill/c", "inproc", &sum_c);
        assert_eq!(a, (0, true), "the updated build opens the wallet's key through security, with no prompt");
        let refusals = [i64::from(ERR_SEC_AUTH_FAILED), i64::from(ERR_SEC_INTERACTION_NOT_ALLOWED)];
        assert!(refusals.contains(&b.0) && !b.1, "item (b) gave the updated build {b:?}; it counts as another program");
        assert!(
            refusals.contains(&c.0) && !c.1,
            "item (c) gave the updated build {c:?}; an any-app item does not pass the partition check"
        );
    }

    /// The drill's other side, run only by `update_drill` in a re-signed
    /// copy of this binary; without its variables it does nothing. It opens
    /// and unlocks the drill's keychain, turns prompts off, reads one item
    /// through `security` (mode `tool`) or in this process (mode `inproc`),
    /// and writes only `status=<n> same=<bool>`, where `same` compares
    /// hashes, never the bytes.
    #[test]
    #[ignore = "run only by update_drill, in a re-signed copy of this test binary"]
    fn drill_child() {
        let var = |name: &str| std::env::var(format!("{DRILL}{name}")).ok();
        let (Some(path), Some(password), Some(service), Some(account), Some(mode), Some(expected), Some(out)) =
            (var("PATH"), var("PW"), var("SERVICE"), var("ACCOUNT"), var("MODE"), var("SUM"), var("OUT"))
        else {
            return;
        };
        let path = PathBuf::from(path);
        let mut keychain =
            SecKeychain::open(&path).unwrap_or_else(|e| panic!("open the drill's keychain: OSStatus {}", e.code()));
        if let Err(e) = keychain.unlock(Some(password.as_str())) {
            panic!("unlock the drill's keychain: OSStatus {}", e.code());
        }
        ok("prompts off", prompts_off());
        let (status, same) = match mode.as_str() {
            "tool" => {
                let tool = SecurityTool::at(path, service);
                let read = tool.ready().and_then(|()| tool.locate(&account)).and_then(|spots| match spots.first() {
                    Some(spot) => tool.read(spot, &account),
                    None => Err(StoreError { refusal: Refusal::KeychainMissing, code: Code::OsStatus(ERR_SEC_ITEM_NOT_FOUND) }),
                });
                match read {
                    Ok(kek) => (0, sum(&kek[..]) == expected),
                    Err(e) => (number(e.code), false),
                }
            }
            "inproc" => match keychain.find_generic_password(&service, &account) {
                Ok((data, _)) => (0, sum(&data) == expected),
                Err(e) => (i64::from(e.code()), false),
            },
            other => panic!("the drill has no mode {other}"),
        };
        std::fs::write(&out, format!("status={status} same={same}\n")).expect("the drill's child writes its result");
    }
}
