//! 🖥️ The backup window: the app shows the SSF wallet's 24 words in a
//! window of its own (native-reveal design, section 4, "Shell: the reveal
//! window").
//!
//! The game page calls one command, [`open_backup`], and gets back one of
//! eight fixed answers, never a word. The words go from the node, over the
//! app's own pipe (shell_channel.rs), to the `reveal` window only: its page
//! comes from the `ssfreveal` scheme, built into the binary, which answers
//! that window's webview and no other. Two walls guard each command: the
//! capabilities (capabilities/*.json) give `open_backup` to `main` only and
//! the two reveal commands to `reveal` only, and each handler checks the
//! caller's label and page itself ([`caller_is`]).
//!
//! The app keeps no copy of the words: each SHOW asks the node again, and
//! the answer goes straight back to the window in a buffer wiped when it is
//! dropped. The key fingerprint of the window's last reveal is kept, for
//! I SAVED, and never goes to JavaScript.

use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Manager, Url};

use crate::shell_channel::{Answer, Channel, Failed, Hello, Op, Words, SHELL_NET};

/// The scheme the window's page is served from.
pub const SCHEME: &str = "ssfreveal";
/// The backup window's label (its webview's too).
pub const LABEL: &str = "reveal";
/// The game page's window label (tauri.conf.json names none, so it is the
/// default, "main").
pub const MAIN: &str = "main";
/// The backup window's title.
pub const TITLE: &str = "Back up your 24 words";
/// The page the window opens on.
pub const INDEX_URL: &str = "ssfreveal://localhost/index.html";
/// After the window closes without the words being marked saved,
/// `open_backup` answers `busy` this long.
pub const CLOSED_BUSY: Duration = Duration::from_secs(10);

/// Every answer of the scheme carries this policy: scripts and styles from
/// the scheme itself only, IPC to the app, and nothing else.
pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src ipc: http://ipc.localhost; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const INDEX_HTML: &[u8] = include_bytes!("../reveal/index.html");
const REVEAL_JS: &[u8] = include_bytes!("../reveal/reveal.js");
const REVEAL_CSS: &[u8] = include_bytes!("../reveal/reveal.css");

/// What the index shows for an address it does not have.
const NO_ADDRESS: &str = "(no address)";

/// The index's address lines with Chia on: the wallet's address, and that it
/// should be the one the Bank shows. `{{ADDRESS}}` takes the address, escaped.
/// The ids are reveal.js's, which hides the line and swaps the hint when a
/// reveal says Chia was turned off since the window opened.
const ADDRESS_LINES: &str = "<p class=\"facts\" id=\"address-line\">Wallet address: <code id=\"address\">{{ADDRESS}}</code></p>\n<p class=\"hint\" id=\"address-hint\">It should be the address the Bank shows.</p>";

/// The index's address lines while Chia is off on this computer: the Bank
/// shows no address then, so the address line is kept but hidden (reveal.js
/// checks every reveal against it) and the hint says why there is none.
const ADDRESS_LINES_CHIA_OFF: &str = "<p class=\"facts\" id=\"address-line\" hidden>Wallet address: <code id=\"address\">{{ADDRESS}}</code></p>\n<p class=\"hint\" id=\"address-hint\">Chia is off on this computer, so the Bank shows no address to check this window against.</p>";

/// The line the page shows where the window cannot keep screen capture out.
const CAPTURE_NOTE: &str = "<p class=\"warn\" id=\"capture\">On Linux this window is not protected from screen capture: close screen sharing and recording apps first.</p>";

// ── What open_backup answers ────────────────────────────────────────────────

/// `open_backup`'s fixed answers (src/nativeShell.ts's list).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenAnswer {
    /// The window closed after the words were marked saved.
    Saved,
    /// The window closed without that.
    Closed,
    /// The app did not start the node, or has no channel to it.
    NoChannel,
    /// The node runs on another network than the app.
    OtherNetwork,
    /// The wallet is not on.
    NotOn,
    /// The wallet is on but not ready to show its address yet.
    Turning,
    /// The words are marked saved already.
    AlreadySaved,
    /// A window is out, or one just closed without a save.
    Busy,
}

impl OpenAnswer {
    pub fn as_str(self) -> &'static str {
        match self {
            OpenAnswer::Saved => "saved",
            OpenAnswer::Closed => "closed",
            OpenAnswer::NoChannel => "no_channel",
            OpenAnswer::OtherNetwork => "other_network",
            OpenAnswer::NotOn => "not_on",
            OpenAnswer::Turning => "turning",
            OpenAnswer::AlreadySaved => "already_saved",
            OpenAnswer::Busy => "busy",
        }
    }
}

/// The hello `open_backup` sends first, read: the address the window shows
/// and whether Chia is off on this computer (the window then hides the
/// address, as the Bank does), or the answer that keeps the window shut.
/// `sticky_other` is true once any hello in this run named another network.
pub fn hello_gate(hello: Result<Hello, Failed>, sticky_other: bool) -> Result<(String, bool), OpenAnswer> {
    let hello = hello.map_err(|_| OpenAnswer::NoChannel)?;
    if sticky_other || !hello.is_net(SHELL_NET) {
        return Err(OpenAnswer::OtherNetwork);
    }
    if hello.wallet != "on" {
        return Err(OpenAnswer::NotOn);
    }
    if hello.backed_up {
        return Err(OpenAnswer::AlreadySaved);
    }
    // A loaded wallet always has its address; without one it is mid-turn.
    let address = hello.address.ok_or(OpenAnswer::Turning)?;
    Ok((address, hello.chia_off))
}

/// What the window's last opening ended with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Outcome {
    #[default]
    Closed,
    Saved,
    AlreadySaved,
}

/// The one backup window's flight: at most one `open_backup` at a time.
#[derive(Debug, Default)]
pub struct Flight {
    /// An `open_backup` is out (asking the node, or its window is open).
    pub out: bool,
    /// The window's instance, bumped at every opening.
    pub instance: u64,
    /// The key fingerprint of this instance's last reveal.
    pub key: Option<u32>,
    /// The address this instance was opened for (from the hello).
    pub address: Option<String>,
    /// Chia was off on this computer at this instance's hello, or at a
    /// hello beside one of its reveals since: its page hides the address,
    /// as the Bank does.
    pub chia_off: bool,
    pub outcome: Outcome,
    /// When the last window closed without a save.
    pub closed_unsaved: Option<Instant>,
    /// A saved request of this instance is out: the close waits for its
    /// reply before it reads the outcome ([`Backup::settled`]).
    pub saving: bool,
    /// A saved request went out in this instance, whatever came back.
    pub save_tried: bool,
    /// This instance's window is gone and its outcome is read: no saved
    /// request may start any more.
    pub settled: bool,
}

/// `busy` while a window is out and for [`CLOSED_BUSY`] after one closed
/// without a save; otherwise None (the call may go ahead).
pub fn flight_gate(f: &Flight, now: Instant) -> Option<OpenAnswer> {
    let cooling = f.closed_unsaved.is_some_and(|at| now.saturating_duration_since(at) < CLOSED_BUSY);
    (f.out || cooling).then_some(OpenAnswer::Busy)
}

/// The app's backup state: the node's channel (none when the app did not
/// start the node, or started it without the channel) and the flight.
pub struct Backup {
    channel: Option<Arc<Channel>>,
    flight: Mutex<Flight>,
    /// Signalled each time a saved request ends.
    save_ended: tokio::sync::Notify,
}

impl Backup {
    pub fn new(channel: Option<Arc<Channel>>) -> Backup {
        Backup { channel, flight: Mutex::new(Flight::default()), save_ended: tokio::sync::Notify::new() }
    }

    /// Start one `open_backup`: `no_channel` without a channel, `busy` while
    /// [`flight_gate`] says so, otherwise the channel, with the flight now
    /// out (the caller ends it with [`Backup::end`]).
    pub fn begin(&self, now: Instant) -> Result<Arc<Channel>, OpenAnswer> {
        let channel = self.channel.clone().ok_or(OpenAnswer::NoChannel)?;
        let mut f = self.flight();
        if let Some(busy) = flight_gate(&f, now) {
            return Err(busy);
        }
        f.out = true;
        Ok(channel)
    }

    /// End the flight [`Backup::begin`] started, with its answer: the key and
    /// the address go, and a close without a save starts the busy time.
    pub fn end(&self, answer: OpenAnswer, now: Instant) {
        let mut f = self.flight();
        f.out = false;
        f.key = None;
        f.address = None;
        f.chia_off = false;
        if answer == OpenAnswer::Closed {
            f.closed_unsaved = Some(now);
        }
    }

    fn flight(&self) -> std::sync::MutexGuard<'_, Flight> {
        self.flight.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A new window instance, opened for `address`, with Chia off on this
    /// computer or not (`chia_off`, from the same hello): returns its number.
    pub fn opened(&self, address: String, chia_off: bool) -> u64 {
        let mut f = self.flight();
        f.instance += 1;
        f.key = None;
        f.address = Some(address);
        f.chia_off = chia_off;
        f.outcome = Outcome::Closed;
        f.saving = false;
        f.save_tried = false;
        f.settled = false;
        f.instance
    }

    /// ⚠ CONFIRM's saved request may go out: a window is open and not yet
    /// settled, and this instance has a reveal's key. The guard it returns
    /// keeps the close waiting until the request ends ([`SaveGuard::done`],
    /// or its drop).
    pub fn start_save(&self) -> Result<(SaveGuard<'_>, u32), &'static str> {
        let mut f = self.flight();
        if !f.out || f.settled {
            return Err("refused");
        }
        let key = f.key.ok_or("not_shown")?;
        f.saving = true;
        f.save_tried = true;
        Ok((SaveGuard { backup: self, instance: f.instance, ended: false }, key))
    }

    /// After the window is gone: wait until no saved request of this
    /// instance is out, then read its outcome, and whether a saved request
    /// went out at all. From here on no saved request may start.
    pub async fn settled(&self) -> (Outcome, bool) {
        loop {
            // A Notified future hears every notify_waiters from its creation
            // on, so a save that ends between the check and the await is not
            // missed.
            let ended = self.save_ended.notified();
            {
                let mut f = self.flight();
                if !f.saving {
                    f.settled = true;
                    return (f.outcome, f.save_tried);
                }
            }
            ended.await;
        }
    }

    /// Run `request` on a blocking thread, off the main thread and the
    /// async workers.
    async fn ask(&self, op: Op) -> Result<zeroize::Zeroizing<String>, Failed> {
        let channel = self.channel.clone().ok_or(Failed::Closed)?;
        tauri::async_runtime::spawn_blocking(move || channel.request(op)).await.unwrap_or(Err(Failed::Closed))
    }

    /// The node's hello, the same way.
    async fn hello(&self) -> Result<Hello, Failed> {
        let channel = self.channel.clone().ok_or(Failed::Closed)?;
        tauri::async_runtime::spawn_blocking(move || channel.hello()).await.unwrap_or(Err(Failed::Closed))
    }

    /// A reveal's checked answer ([`reveal_outcome`]) lands for window
    /// `instance`, with the `hello` asked beside it. The flight takes
    /// whether Chia is off now ([`chia_off_after`]), so a reload of the page
    /// serves the same lines; the reveal's view says so too, for the page to
    /// hide the address, and its key is kept for I SAVED. `refused` once
    /// that window is no longer the one out.
    pub fn land_reveal(&self, instance: u64, outcome: Result<(RevealView, u32), &'static str>, hello: Result<Hello, Failed>) -> Result<RevealView, &'static str> {
        let mut f = self.flight();
        if f.instance != instance || !f.out {
            return Err("refused");
        }
        f.chia_off = chia_off_after(hello, f.chia_off);
        match outcome {
            Ok((mut view, key)) => {
                f.key = Some(key);
                view.chia_off = f.chia_off;
                Ok(view)
            }
            Err(code) => {
                if code == "already_saved" {
                    f.outcome = Outcome::AlreadySaved;
                }
                Err(code)
            }
        }
    }
}

/// One saved request that is out. It ends with [`SaveGuard::done`]; a guard
/// dropped without it (the request's future dropped) ends it as not saved,
/// so a close never waits forever.
pub struct SaveGuard<'a> {
    backup: &'a Backup,
    instance: u64,
    ended: bool,
}

impl SaveGuard<'_> {
    /// The node's answer came: `saved` when it recorded the mark.
    pub fn done(mut self, saved: bool) {
        self.end(saved);
    }

    fn end(&mut self, saved: bool) {
        if self.ended {
            return;
        }
        self.ended = true;
        {
            let mut f = self.backup.flight();
            if f.instance == self.instance {
                f.saving = false;
                if saved {
                    f.outcome = Outcome::Saved;
                }
            }
        }
        self.backup.save_ended.notify_waiters();
    }
}

impl Drop for SaveGuard<'_> {
    fn drop(&mut self) {
        self.end(false);
    }
}

/// After a close with no saved mark although a saved request went out (it
/// timed out, or its answer was lost): the hello says whether the node
/// recorded it for this window's wallet all the same.
pub fn saved_after_all(hello: Result<Hello, Failed>, address: &str, sticky_other: bool) -> bool {
    hello.is_ok_and(|h| !sticky_other && h.is_net(SHELL_NET) && h.wallet == "on" && h.backed_up && h.address.as_deref() == Some(address))
}

// ── Who may call ───────────────────────────────────────────────────────────

/// The two callers the commands answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    /// The game page's window, on the app's own origin.
    Main,
    /// The backup window, on the `ssfreveal` scheme's page.
    Reveal,
}

/// Whether a webview labelled `label` showing `url` is `who`.
pub fn caller_is(who: Caller, label: &str, url: &str) -> bool {
    caller_is_in(who, label, url, cfg!(dev))
}

/// [`caller_is`], with whether this is a development build (whose game page
/// is the Vite dev server's) spelled out for the tests.
fn caller_is_in(who: Caller, label: &str, url: &str, dev: bool) -> bool {
    let Ok(url) = Url::parse(url) else {
        return false;
    };
    match who {
        Caller::Reveal => label == LABEL && navigation_allowed(&url),
        Caller::Main => label == MAIN && main_origin(&url, dev),
    }
}

fn plain_host(url: &Url) -> bool {
    url.port().is_none() && url.username().is_empty() && url.password().is_none()
}

/// The scheme's own origin, in both its forms: `ssfreveal://localhost`, or
/// `http(s)://ssfreveal.localhost` where the engine cannot load a custom
/// scheme (WebView2).
pub fn reveal_origin(url: &Url) -> bool {
    let host = url.host_str();
    plain_host(url)
        && match url.scheme() {
            "ssfreveal" => host == Some("localhost"),
            "http" | "https" => host == Some("ssfreveal.localhost"),
            _ => false,
        }
}

/// The only page the backup window may show: the scheme's index.
pub fn navigation_allowed(url: &Url) -> bool {
    reveal_origin(url) && matches!(url.path(), "/" | "/index.html") && url.query().is_none() && url.fragment().is_none()
}

/// The app's own page: `tauri://localhost`, `http(s)://tauri.localhost`, or
/// in a development build the Vite dev server (tauri.conf.json's devUrl).
fn main_origin(url: &Url, dev: bool) -> bool {
    let host = url.host_str();
    match url.scheme() {
        "tauri" => plain_host(url) && host == Some("localhost"),
        "http" | "https" if host == Some("tauri.localhost") => plain_host(url),
        "http" => dev && host == Some("localhost") && url.port() == Some(5173) && url.username().is_empty(),
        _ => false,
    }
}

// ── The scheme ─────────────────────────────────────────────────────────────

/// What the index shows besides the words: all public.
#[derive(Clone, Debug, Default)]
pub struct PageFacts {
    /// The network's name.
    pub network: String,
    /// The wallet's receive address, from the hello that opened the window.
    pub address: Option<String>,
    /// Chia is off on this computer, from the same hello: the address line
    /// is hidden, as the Bank shows no address.
    pub chia_off: bool,
    /// Add the line that the window is not protected from screen capture.
    pub capture_note: bool,
}

/// Escape text for an HTML text node or attribute.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// One answer of the scheme: its status, headers and body.
pub type SchemeAnswer = (u16, Vec<(&'static str, String)>, Cow<'static, [u8]>);

/// One answer of the `ssfreveal` scheme, for the webview labelled `label`:
/// 403 for any other webview, the three built-in files by GET, 404 for any
/// other path. Every answer carries [`CSP`].
pub fn scheme_answer(label: &str, method: &str, path: &str, facts: &PageFacts) -> SchemeAnswer {
    let mut headers = vec![
        ("Content-Security-Policy", CSP.to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Cache-Control", "no-store".to_string()),
        ("Referrer-Policy", "no-referrer".to_string()),
    ];
    let text = |headers: &mut Vec<(&'static str, String)>| headers.push(("Content-Type", "text/plain; charset=utf-8".to_string()));
    if label != LABEL {
        text(&mut headers);
        return (403, headers, Cow::Borrowed(b"forbidden"));
    }
    if method != "GET" {
        text(&mut headers);
        return (405, headers, Cow::Borrowed(b"method not allowed"));
    }
    let (kind, body): (&str, Cow<'static, [u8]>) = match path {
        "/" | "/index.html" => {
            let address = facts.address.as_deref().unwrap_or(NO_ADDRESS);
            let lines = if facts.chia_off { ADDRESS_LINES_CHIA_OFF } else { ADDRESS_LINES };
            let page = String::from_utf8_lossy(INDEX_HTML)
                .replace("{{NETWORK}}", &escape(&facts.network))
                .replace("{{ADDRESS_LINES}}", &lines.replace("{{ADDRESS}}", &escape(address)))
                .replace("{{CAPTURE}}", if facts.capture_note { CAPTURE_NOTE } else { "" });
            ("text/html; charset=utf-8", Cow::Owned(page.into_bytes()))
        }
        "/reveal.js" => ("text/javascript; charset=utf-8", Cow::Borrowed(REVEAL_JS)),
        "/reveal.css" => ("text/css; charset=utf-8", Cow::Borrowed(REVEAL_CSS)),
        _ => {
            text(&mut headers);
            return (404, headers, Cow::Borrowed(b"not found"));
        }
    };
    headers.push(("Content-Type", kind.to_string()));
    (200, headers, body)
}

/// The backup window's facts, from this run's flight: the address and
/// whether Chia is off, both from the hello that opened the window (none
/// before the app's state is set up).
fn window_facts(backup: Option<&Backup>) -> PageFacts {
    let (address, chia_off) = backup
        .map(|b| {
            let f = b.flight();
            (f.address.clone(), f.chia_off)
        })
        .unwrap_or_default();
    PageFacts { network: SHELL_NET.name.to_string(), address, chia_off, capture_note: cfg!(target_os = "linux") }
}

/// The scheme's handler: [`scheme_answer`] with this run's facts.
pub fn serve<R: tauri::Runtime>(ctx: tauri::UriSchemeContext<'_, R>, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Cow<'static, [u8]>> {
    let label = ctx.webview_label();
    let facts = if label == LABEL { window_facts(ctx.app_handle().try_state::<Backup>().as_deref()) } else { PageFacts::default() };
    let (status, headers, body) = scheme_answer(label, request.method().as_str(), request.uri().path(), &facts);
    let mut response = tauri::http::Response::builder().status(status);
    for (name, value) in headers {
        response = response.header(name, value);
    }
    response.body(body).unwrap_or_else(|_| {
        let mut r = tauri::http::Response::new(Cow::Borrowed(&b"internal error"[..]));
        *r.status_mut() = tauri::http::StatusCode::INTERNAL_SERVER_ERROR;
        r
    })
}

// ── The window ─────────────────────────────────────────────────────────────

/// Whether the backup window's webview is incognito: yes, except on Linux.
///
/// On WebKitGTK the app's custom schemes (`ssfreveal`, and Tauri's own
/// `ipc` and `tauri`) are registered on a WebKit context, once per context:
/// Tauri gives every webview the same default data directory, so the
/// window joins the context the main window made, whose schemes are already
/// registered, and Tauri hands wry none for it. An incognito webview then
/// gets a new ephemeral context of its own with only those schemes, none,
/// and its page cannot load ("The URL can't be shown"). Not incognito, it
/// shares main's context and its handlers. That keeps nothing of the words:
/// the page stores nothing, every answer of the scheme is `no-store`, and
/// `ssfreveal` is an origin of its own, apart from the game page's.
pub const INCOGNITO: bool = !cfg!(target_os = "linux");

/// Build the backup window: owned by main (above it on every engine), not
/// minimizable (so it is never lost behind the Bank), incognito where the
/// engine allows it ([`INCOGNITO`]), no devtools, screen capture kept out
/// where the OS can, its own page only, no new windows. The clipboard is
/// never enabled for it.
fn build_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let main = app.get_webview_window(MAIN).ok_or(tauri::Error::WindowNotFound)?;
    let url = Url::parse(INDEX_URL).map_err(tauri::Error::InvalidUrl)?;
    tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::CustomProtocol(url))
        .title(TITLE)
        .inner_size(520.0, 760.0)
        .parent(&main)?
        .incognito(INCOGNITO)
        .devtools(false)
        .content_protected(true)
        .minimizable(false)
        .resizable(false)
        .focused(true)
        .on_navigation(navigation_allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
}

fn focus_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_focus();
    }
}

/// The webview's label and page, for [`caller_is`].
fn who(webview: &tauri::Webview) -> (String, String) {
    (webview.label().to_string(), webview.url().map(|u| u.to_string()).unwrap_or_default())
}

// ── The commands ───────────────────────────────────────────────────────────

/// BACK UP in the game page: ask the node (hello), then open the backup
/// window and answer when it closes. Main only. One at a time: a second call
/// focuses the window and answers `busy`, as does any call for
/// [`CLOSED_BUSY`] after a close without a save.
#[tauri::command]
pub async fn open_backup(app: tauri::AppHandle, webview: tauri::Webview) -> &'static str {
    let (label, url) = who(&webview);
    if !caller_is(Caller::Main, &label, &url) {
        // The capability already refuses it; this answer says nothing.
        return OpenAnswer::NoChannel.as_str();
    }
    let backup = app.state::<Backup>();
    let channel = match backup.begin(Instant::now()) {
        Ok(channel) => channel,
        Err(answer) => {
            if answer == OpenAnswer::Busy {
                focus_window(&app);
            }
            return answer.as_str();
        }
    };
    let answer = run_backup(&app, &backup, channel).await;
    backup.end(answer, Instant::now());
    answer.as_str()
}

async fn run_backup(app: &tauri::AppHandle, backup: &Backup, channel: Arc<Channel>) -> OpenAnswer {
    let hello_channel = channel.clone();
    let hello = tauri::async_runtime::spawn_blocking(move || hello_channel.hello()).await.unwrap_or(Err(Failed::Closed));
    let (address, chia_off) = match hello_gate(hello, channel.other_network()) {
        Ok(opening) => opening,
        Err(answer) => return answer,
    };
    backup.opened(address.clone(), chia_off);
    let window = match build_window(app) {
        Ok(window) => window,
        Err(e) => {
            eprintln!("🖥️ The backup window could not open: {e}");
            return OpenAnswer::Closed;
        }
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = Mutex::new(Some(tx));
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(());
            }
        }
    });
    let _ = rx.await;
    // A CONFIRM whose answer is still out when the window closes (the title
    // bar's X while the page says "Telling your node…") is waited for, so the
    // answer says what the node recorded.
    match backup.settled().await {
        (Outcome::Saved, _) => OpenAnswer::Saved,
        (Outcome::AlreadySaved, _) => OpenAnswer::AlreadySaved,
        (Outcome::Closed, false) => OpenAnswer::Closed,
        (Outcome::Closed, true) => {
            // The saved request failed or timed out; the node may have
            // written the mark all the same.
            let hello_channel = channel.clone();
            let hello = tauri::async_runtime::spawn_blocking(move || hello_channel.hello()).await.unwrap_or(Err(Failed::Closed));
            if saved_after_all(hello, &address, channel.other_network()) {
                OpenAnswer::Saved
            } else {
                OpenAnswer::Closed
            }
        }
    }
}

/// What SHOW gets: the words, the address they are for, and whether Chia
/// is off on this computer now (the page then hides the address, as the
/// Bank does).
#[derive(Serialize, Debug)]
pub struct RevealView {
    pub words: Words,
    pub address: String,
    /// Set by [`Backup::land_reveal`], from the flight.
    pub chia_off: bool,
}

/// Whether Chia is off now, for a window whose flight says `was`: a hello
/// for the app's network says so, and Chia never comes back on before the
/// node stops, so an off stays off. A hello that failed, or that could not
/// be read, keeps what the window has.
pub fn chia_off_after(hello: Result<Hello, Failed>, was: bool) -> bool {
    was || hello.is_ok_and(|h| h.is_net(SHELL_NET) && h.chia_off)
}

/// The node's reveal answer, checked: 24 well-formed words, a key, and the
/// address the window was opened for. Otherwise a fixed refusal.
pub fn reveal_outcome(answer: Answer, expect_address: Option<&str>) -> Result<(RevealView, u32), &'static str> {
    if !answer.ok {
        return Err(if answer.saved { "already_saved" } else { "refused" });
    }
    let (Some(words), Some(key), Some(address)) = (answer.words, answer.key, answer.address) else {
        return Err("refused");
    };
    if !words.well_formed() {
        return Err("refused");
    }
    if expect_address != Some(address.as_str()) {
        return Err("changed");
    }
    Ok((RevealView { words, address, chia_off: false }, key))
}

/// SHOW in the backup window: ask the node for the words, every time (the
/// app keeps no copy), and whether Chia is off now, and record the answer's
/// key for this window.
#[tauri::command]
pub async fn backup_reveal(app: tauri::AppHandle, webview: tauri::Webview) -> Result<RevealView, &'static str> {
    let (label, url) = who(&webview);
    if !caller_is(Caller::Reveal, &label, &url) {
        return Err("refused");
    }
    let backup = app.state::<Backup>();
    if backup.channel.is_none() {
        return Err("no_channel");
    }
    let (instance, address) = {
        let f = backup.flight();
        if !f.out {
            return Err("refused");
        }
        (f.instance, f.address.clone())
    };
    let body = backup.ask(Op::Reveal).await.map_err(|_| "no_channel")?;
    let answer = Answer::parse(&body).ok_or("refused")?;
    drop(body);
    let outcome = reveal_outcome(answer, address.as_deref());
    // Chia can be turned off in the game while the window is open (it is
    // not modal): a hello beside every reveal says whether it is off now.
    let hello = backup.hello().await;
    backup.land_reveal(instance, outcome, hello)
}

/// ⚠ CONFIRM in the backup window: tell the node the words of this window's
/// last reveal are saved, then close the window, so `open_backup` answers
/// `saved`. No argument: the key is the app's own.
#[tauri::command]
pub async fn backup_saved(app: tauri::AppHandle, webview: tauri::Webview) -> Result<(), &'static str> {
    let (label, url) = who(&webview);
    if !caller_is(Caller::Reveal, &label, &url) {
        return Err("refused");
    }
    let backup = app.state::<Backup>();
    let (guard, key) = backup.start_save()?;
    let Ok(body) = backup.ask(Op::Saved(key)).await else {
        guard.done(false);
        return Err("no_channel");
    };
    let ok = Answer::parse(&body).is_some_and(|a| a.ok);
    guard.done(ok);
    if !ok {
        return Err("refused");
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell_channel::{MAINNET, TESTNET11};

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_reveal_commands_answer_only_the_reveal_window_on_its_scheme() {
        for page in ["ssfreveal://localhost/index.html", "ssfreveal://localhost/", "http://ssfreveal.localhost/index.html", "https://ssfreveal.localhost/"] {
            assert!(caller_is(Caller::Reveal, "reveal", page), "{page}");
            assert!(!caller_is(Caller::Reveal, "main", page), "main on {page}");
            assert!(!caller_is(Caller::Reveal, "Reveal", page));
            assert!(!caller_is(Caller::Reveal, "reveal2", page));
        }
        for page in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://localhost:5173/",
            "ssfreveal://localhost/reveal.js",
            "ssfreveal://localhost/index.html?x=1",
            "ssfreveal://localhost/index.html#x",
            "ssfreveal://other/index.html",
            "ssfreveal://localhost:1/index.html",
            "ssfreveal://user@localhost/index.html",
            "http://ssfreveal.localhost:8080/",
            "http://ssfreveal.localhost.example/",
            "ftp://ssfreveal.localhost/",
            "about:blank",
            "",
            "not a url",
        ] {
            assert!(!caller_is(Caller::Reveal, "reveal", page), "{page}");
        }
    }

    #[test]
    fn open_backup_answers_only_main_on_the_apps_own_page() {
        for page in ["tauri://localhost/", "tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/"] {
            assert!(caller_is_in(Caller::Main, "main", page, false), "{page}");
            assert!(caller_is_in(Caller::Main, "main", page, true), "{page}");
            assert!(!caller_is_in(Caller::Main, "reveal", page, true), "reveal on {page}");
        }
        assert!(caller_is_in(Caller::Main, "main", "http://localhost:5173/", true), "the dev server, in a dev build");
        assert!(!caller_is_in(Caller::Main, "main", "http://localhost:5173/", false), "not in a release build");
        for page in ["ssfreveal://localhost/index.html", "http://ssfreveal.localhost/", "http://localhost:8080/", "tauri://evil/", "tauri://localhost:9/", "http://tauri.localhost:1/"] {
            assert!(!caller_is_in(Caller::Main, "main", page, true), "{page}");
        }
    }

    /// Incognito everywhere but WebKitGTK, where an incognito window would
    /// lose the app's scheme handlers ([`INCOGNITO`]).
    #[test]
    fn the_window_is_incognito_except_on_webkitgtk() {
        assert_eq!(INCOGNITO, !cfg!(target_os = "linux"));
    }

    #[test]
    fn the_window_navigates_only_to_its_index() {
        assert!(navigation_allowed(&url("ssfreveal://localhost/index.html")));
        assert!(navigation_allowed(&url("http://ssfreveal.localhost/index.html")));
        assert!(!navigation_allowed(&url("ssfreveal://localhost/reveal.css")));
        assert!(!navigation_allowed(&url("tauri://localhost/")));
        assert!(!navigation_allowed(&url("about:blank")));
    }

    fn facts() -> PageFacts {
        PageFacts { network: "testnet11".into(), address: Some("txch1abc".into()), chia_off: false, capture_note: true }
    }

    fn header<'a>(headers: &'a [(&'static str, String)], name: &str) -> Option<&'a str> {
        headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    #[test]
    fn the_scheme_answers_only_the_reveal_webview_and_always_with_the_csp() {
        for label in ["main", "", "Reveal", "reveal ", "other"] {
            for path in ["/", "/index.html", "/reveal.js", "/reveal.css", "/nope"] {
                let (status, headers, body) = scheme_answer(label, "GET", path, &facts());
                assert_eq!(status, 403, "{label:?} {path}");
                assert_eq!(header(&headers, "Content-Security-Policy"), Some(CSP));
                assert!(!String::from_utf8_lossy(&body).contains("txch1abc"));
            }
        }
        let cases = [("GET", "/", 200), ("GET", "/index.html", 200), ("GET", "/reveal.js", 200), ("GET", "/reveal.css", 200), ("GET", "/x", 404), ("GET", "/../index.html", 404), ("POST", "/", 405)];
        for (method, path, want) in cases {
            let (status, headers, _) = scheme_answer("reveal", method, path, &facts());
            assert_eq!(status, want, "{method} {path}");
            assert_eq!(header(&headers, "Content-Security-Policy"), Some(CSP), "{method} {path}");
            assert_eq!(header(&headers, "X-Content-Type-Options"), Some("nosniff"));
            assert!(header(&headers, "Content-Type").is_some());
        }
        let (_, headers, _) = scheme_answer("reveal", "GET", "/reveal.js", &facts());
        assert_eq!(header(&headers, "Content-Type"), Some("text/javascript; charset=utf-8"));
    }

    #[test]
    fn the_csp_is_the_designs() {
        assert_eq!(
            CSP,
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src ipc: http://ipc.localhost; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
        );
    }

    #[test]
    fn the_index_shows_the_network_the_address_and_the_warnings_escaped() {
        let page = |f: &PageFacts| String::from_utf8(scheme_answer("reveal", "GET", "/", f).2.into_owned()).unwrap();
        let shown = page(&facts());
        assert!(shown.contains("<strong id=\"net\">testnet11</strong>"));
        assert!(shown.contains(">txch1abc<"));
        assert!(shown.contains("Star Station never asks you to type your 24 words."));
        assert!(shown.contains("not protected from screen capture"));
        assert!(!shown.contains("{{"), "every placeholder filled");

        let without = page(&PageFacts { capture_note: false, ..facts() });
        assert!(!without.contains("screen capture"));

        let hostile = page(&PageFacts { network: "<b>x</b>".into(), address: Some("\"><script>x</script>&'".into()), chia_off: false, capture_note: false });
        assert!(hostile.contains("&lt;b&gt;x&lt;/b&gt;"));
        assert!(hostile.contains("&quot;&gt;&lt;script&gt;x&lt;/script&gt;&amp;&#39;"));
        assert!(!hostile.contains("<script>x"));
        assert!(page(&PageFacts { address: None, ..facts() }).contains("(no address)"));
    }

    fn index(f: &PageFacts) -> String {
        String::from_utf8(scheme_answer("reveal", "GET", "/", f).2.into_owned()).unwrap()
    }

    /// ⛓️ With Chia on, the address and the hint to check it against the
    /// Bank's, as before; with Chia off on this computer the Bank shows no
    /// address, so the window keeps its address element (reveal.js checks
    /// every reveal's address against it) but hidden, and says why there is
    /// nothing to check it against.
    #[test]
    fn while_chia_is_off_the_index_keeps_the_address_hidden_and_says_the_bank_shows_none() {
        let on = index(&facts());
        assert!(
            on.contains("<p class=\"facts\" id=\"address-line\">Wallet address: <code id=\"address\">txch1abc</code></p>\n<p class=\"hint\" id=\"address-hint\">It should be the address the Bank shows.</p>\n"),
            "{on}"
        );
        assert!(!on.contains(" hidden>") && !on.contains("Chia is off"));

        let off = index(&PageFacts { chia_off: true, ..facts() });
        assert!(off.contains("<p class=\"facts\" id=\"address-line\" hidden>Wallet address: <code id=\"address\">txch1abc</code></p>\n"), "{off}");
        assert!(!off.contains("It should be the address the Bank shows"));
        assert!(off.contains("<p class=\"hint\" id=\"address-hint\">Chia is off on this computer, so the Bank shows no address to check this window against.</p>"));
        assert!(!off.contains("{{"), "every placeholder filled");
        for page in [&on, &off] {
            for id in ["address", "address-line", "address-hint"] {
                assert_eq!(page.matches(&format!("id=\"{id}\"")).count(), 1, "one {id} element, for reveal.js");
            }
            // The CSP's rules hold for the filled page too.
            let lower = page.to_ascii_lowercase();
            assert!(!lower.contains(" style=") && !lower.contains("<style"));
            assert_eq!(lower.matches("<script").count(), 1);
        }

        // The address is escaped, and the missing one shown, with Chia off too.
        let hostile = index(&PageFacts { address: Some("\"><script>x</script>&'".into()), chia_off: true, ..facts() });
        assert!(hostile.contains("<code id=\"address\">&quot;&gt;&lt;script&gt;x&lt;/script&gt;&amp;&#39;</code>"));
        assert!(!hostile.contains("<script>x"));
        assert!(index(&PageFacts { address: None, chia_off: true, ..facts() }).contains("<code id=\"address\">(no address)</code>"));

        // Nothing in the stylesheet gives the address line a display of its
        // own, so its hidden attribute hides it.
        let css = std::str::from_utf8(REVEAL_CSS).unwrap();
        for rule in css.split('}') {
            let Some((selector, body)) = rule.rsplit_once('{') else { continue };
            if body.contains("display") {
                for part in selector.split(',').map(str::trim) {
                    let names_the_line = part.split(|c: char| c.is_whitespace() || c == '>').any(|s| s == "p" || s.starts_with("p.") || s.starts_with("p[") || s.contains(".facts") || s.contains("[hidden]"));
                    assert!(!names_the_line, "{part:?} sets a display");
                }
            }
        }
    }

    /// The built-in page: no inline script, no event-handler attribute, no
    /// web URL, nothing that reaches the clipboard or Tauri's events, and
    /// nothing that reaches a printer.
    #[test]
    fn the_built_in_assets_hold_no_inline_script_url_clipboard_or_event() {
        let html = std::str::from_utf8(INDEX_HTML).unwrap();
        let js = std::str::from_utf8(REVEAL_JS).unwrap();
        let css = std::str::from_utf8(REVEAL_CSS).unwrap();
        for (name, text) in [("index.html", html), ("reveal.js", js), ("reveal.css", css)] {
            let lower = text.to_ascii_lowercase();
            for banned in ["http://", "https://", "clipboard", "writetext", "emit", "javascript:", "data:", "eval(", "new function", "innerhtml", "outerhtml", "insertadjacenthtml", "document.write", "localstorage", "sessionstorage", "indexeddb", "fetch(", "xmlhttprequest", "window.open", "print(", "@import", "url("] {
                assert!(!lower.contains(banned), "{name} holds {banned:?}");
            }
        }
        let lower = html.to_ascii_lowercase();
        // Every script element is an empty one that loads reveal.js.
        let mut rest = lower.as_str();
        let mut scripts = 0;
        while let Some(at) = rest.find("<script") {
            let tail = &rest[at..];
            let close = tail.find("</script>").expect("a closed script element");
            let element = &tail[..close];
            let open_end = element.find('>').unwrap();
            assert_eq!(&element[..open_end + 1], "<script src=\"reveal.js\" defer>", "only the built-in script");
            assert!(element[open_end + 1..].trim().is_empty(), "no inline script");
            scripts += 1;
            rest = &tail[close..];
        }
        assert_eq!(scripts, 1);
        assert!(!lower.contains("<style"), "no inline style element");
        assert!(!lower.contains(" style="), "no inline style attribute");
        // No on…= attribute anywhere in a tag.
        let mut in_tag = false;
        let bytes = lower.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            match b {
                b'<' => in_tag = true,
                b'>' => in_tag = false,
                b'o' if in_tag && i > 0 && bytes[i - 1].is_ascii_whitespace() && bytes.get(i + 1) == Some(&b'n') => {
                    let name: String = lower[i..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
                    let after = lower[i + name.len()..].trim_start();
                    assert!(!after.starts_with('='), "an event-handler attribute {name:?}");
                }
                _ => {}
            }
        }
        assert!(html.contains("<link rel=\"stylesheet\" href=\"reveal.css\">"));
        // The page's script asks only the two reveal commands.
        let mut asked: Vec<&str> = js.match_indices("ask('").map(|(at, _)| &js[at + 5..at + 5 + js[at + 5..].find('\'').unwrap()]).collect();
        asked.sort();
        assert_eq!(asked, ["backup_reveal", "backup_saved"]);
        assert_eq!(js.matches("invoke(").count(), 1, "one call into the app, inside ask");
        // Nothing of the page reaches a printer or a print-to-file: the
        // stylesheet prints no page, a print that starts anyway finds the
        // words masked, and the print shortcut is cancelled before it acts.
        let print = css.find("@media print").expect("a print rule");
        let rule = &css[print..];
        let rule = &rule[..rule.find("\n}").expect("the print rule's end")];
        assert!(rule.contains("main { display: none !important; }"), "the print rule leaves the page out");
        assert!(js.contains("window.addEventListener('beforeprint', () => hide());"), "a print hides the words first");
        let keys = js.find("document.addEventListener(\n    'keydown',").expect("the keydown listener");
        let keys = &js[keys..];
        let keys = &keys[..keys.find("\n    true,\n  );").expect("a capturing keydown listener")];
        let shortcut = keys.find("event.key.toLowerCase() === 'p'").expect("the print shortcut is caught");
        assert!(keys[..shortcut].contains("(event.ctrlKey || event.metaKey)"), "with Ctrl or Cmd");
        let after = &keys[shortcut..];
        let stop = after.find("event.preventDefault();").expect("the print shortcut is cancelled");
        assert!(stop < after.find("return;").expect("and goes no further"));
    }

    /// The page keeps the Bank's rules (bankBackup.ts, main.ts): HIDE acts
    /// before the fresh-click check SHOW needs, and SHOW puts an armed
    /// CONFIRM back to I SAVED before it asks for the words.
    #[test]
    fn the_page_hides_at_once_and_show_disarms_confirm() {
        let js = std::str::from_utf8(REVEAL_JS).unwrap();
        let at = js.find("addEventListener('click'").expect("a click handler");
        assert!(js[..at].ends_with("showButton."), "the first click handler is SHOW/HIDE's");
        let handler = &js[at..];
        let handler = &handler[..handler.find("\n  });").expect("the handler's end")];
        let hides = handler.find("if (shown)").expect("a HIDE branch");
        let checks = handler.find("fresh(event, 'show')").expect("SHOW's fresh-click check");
        assert!(hides < checks, "HIDE is handled before SHOW's fresh-click check");
        assert!(handler[hides..checks].contains("hide(") && handler[hides..checks].contains("return;"), "HIDE hides and returns");
        let reveal = &js[js.find("function reveal()").expect("reveal()")..];
        let reveal = &reveal[..reveal.find("ask('backup_reveal')").expect("its request")];
        assert!(reveal.contains("if (armed) disarm();"), "SHOW disarms CONFIRM before it asks");
        // A request that is out (CONFIRM's included) disables SHOW, never
        // HIDE: the button is enabled whenever the words are on screen.
        let sync = &js[js.find("function sync()").expect("sync()")..];
        let sync = &sync[..sync.find("\n  }").expect("its end")];
        assert!(sync.contains("showButton.disabled = !shown && (asking || saving);"), "{sync}");
    }

    #[test]
    fn the_hello_decides_what_open_backup_answers() {
        let other = if SHELL_NET == TESTNET11 { MAINNET } else { TESTNET11 };
        let hello = |net: crate::shell_channel::Net, wallet: &str, backed_up: bool, address: Option<&str>| Hello {
            net_id: net.id.into(),
            genesis: net.genesis.into(),
            wallet: wallet.into(),
            backed_up,
            address: address.map(str::to_string),
            chia_off: false,
        };
        assert_eq!(hello_gate(Ok(hello(SHELL_NET, "on", false, Some("txch1abc"))), false), Ok(("txch1abc".to_string(), false)));
        // ⛓️ A wallet loaded before an in-game off: the window opens, and
        // learns that Chia is off; an answer that keeps it shut stays one.
        let off = Hello { chia_off: true, ..hello(SHELL_NET, "on", false, Some("txch1abc")) };
        assert_eq!(hello_gate(Ok(off.clone()), false), Ok(("txch1abc".to_string(), true)));
        assert_eq!(hello_gate(Ok(Hello { backed_up: true, ..off.clone() }), false), Err(OpenAnswer::AlreadySaved));
        assert_eq!(hello_gate(Ok(Hello { address: None, ..off.clone() }), false), Err(OpenAnswer::Turning));
        assert_eq!(hello_gate(Ok(Hello { wallet: "off".into(), address: None, ..off }), false), Err(OpenAnswer::NotOn));
        assert_eq!(hello_gate(Ok(hello(other, "on", false, Some("xch1abc"))), false), Err(OpenAnswer::OtherNetwork));
        assert_eq!(hello_gate(Ok(hello(SHELL_NET, "on", false, Some("txch1abc"))), true), Err(OpenAnswer::OtherNetwork), "sticky for the run");
        assert_eq!(hello_gate(Ok(Hello::default()), false), Err(OpenAnswer::OtherNetwork), "a hello that could not be read");
        for state in ["ready", "off", "gated", "unbuilt"] {
            assert_eq!(hello_gate(Ok(hello(SHELL_NET, state, false, None)), false), Err(OpenAnswer::NotOn), "{state}");
        }
        assert_eq!(hello_gate(Ok(hello(SHELL_NET, "on", true, Some("txch1abc"))), false), Err(OpenAnswer::AlreadySaved));
        assert_eq!(hello_gate(Ok(hello(SHELL_NET, "on", false, None)), false), Err(OpenAnswer::Turning));
        assert_eq!(hello_gate(Err(Failed::TimedOut), false), Err(OpenAnswer::NoChannel));
        assert_eq!(hello_gate(Err(Failed::Closed), false), Err(OpenAnswer::NoChannel));
    }

    #[test]
    fn open_backup_is_single_flight_and_busy_after_a_close_without_a_save() {
        let now = Instant::now();
        assert_eq!(flight_gate(&Flight::default(), now), None);
        assert_eq!(flight_gate(&Flight { out: true, ..Flight::default() }, now), Some(OpenAnswer::Busy));
        let closed = Flight { closed_unsaved: Some(now), ..Flight::default() };
        assert_eq!(flight_gate(&closed, now + Duration::from_secs(9)), Some(OpenAnswer::Busy));
        assert_eq!(flight_gate(&closed, now + CLOSED_BUSY), None);
    }

    #[test]
    fn begin_answers_no_channel_without_a_channel_and_busy_while_out() {
        let none = Backup::new(None);
        assert_eq!(none.begin(Instant::now()).err(), Some(OpenAnswer::NoChannel));

        // A channel over pipes nobody answers: only the flight is tested.
        let (_req_read, req_write) = std::io::pipe().unwrap();
        let (rep_read, _rep_write) = std::io::pipe().unwrap();
        let backup = Backup::new(Some(Channel::start(req_write, rep_read)));
        let now = Instant::now();
        assert!(backup.begin(now).is_ok());
        assert_eq!(backup.begin(now).err(), Some(OpenAnswer::Busy), "single flight");
        backup.end(OpenAnswer::Closed, now);
        assert_eq!(backup.begin(now + Duration::from_secs(5)).err(), Some(OpenAnswer::Busy), "busy after a close without a save");
        assert!(backup.begin(now + CLOSED_BUSY).is_ok());
        backup.end(OpenAnswer::Saved, now + CLOSED_BUSY);
        assert!(backup.begin(now + CLOSED_BUSY).is_ok(), "a save starts no busy time");
        backup.end(OpenAnswer::NotOn, now + CLOSED_BUSY);
        assert!(backup.begin(now + CLOSED_BUSY).is_ok());
    }

    /// A backup with a channel over pipes nobody answers (only the flight
    /// is tested), and those pipes' other ends.
    fn quiet_backup() -> (Backup, (std::io::PipeReader, std::io::PipeWriter)) {
        let (req_read, req_write) = std::io::pipe().unwrap();
        let (rep_read, rep_write) = std::io::pipe().unwrap();
        (Backup::new(Some(Channel::start(req_write, rep_read))), (req_read, rep_write))
    }

    /// ⛓️ Whether Chia is off goes from the hello that opened a window, by
    /// the flight, to the page the window is served; the next opening takes
    /// its own hello's, and the flight's end drops it with the address.
    #[test]
    fn the_flight_carries_chia_off_from_the_opening_hello_to_the_page() {
        let (backup, _pipes) = quiet_backup();
        backup.begin(Instant::now()).unwrap();
        let hello = Hello {
            net_id: SHELL_NET.id.into(),
            genesis: SHELL_NET.genesis.into(),
            wallet: "on".into(),
            backed_up: false,
            address: Some("txch1abc".into()),
            chia_off: true,
        };
        let (address, chia_off) = hello_gate(Ok(hello), false).unwrap();
        backup.opened(address, chia_off);
        let facts = window_facts(Some(&backup));
        assert_eq!((facts.address.as_deref(), facts.chia_off), (Some("txch1abc"), true));
        assert!(index(&facts).contains("<p class=\"facts\" id=\"address-line\" hidden>Wallet address: <code id=\"address\">txch1abc</code></p>"));

        backup.opened("txch1abc".into(), false);
        assert!(!window_facts(Some(&backup)).chia_off, "each opening takes its own hello's");
        backup.opened("txch1abc".into(), true);
        backup.end(OpenAnswer::Closed, Instant::now());
        let facts = window_facts(Some(&backup));
        assert_eq!((facts.address.as_deref(), facts.chia_off), (None, false), "the end drops it with the address");
        let none = window_facts(None);
        assert_eq!((none.address.as_deref(), none.chia_off), (None, false));
    }

    /// ⛓️ Chia turned off in the game while a window opened with Chia on is
    /// up: the hello beside the next reveal says so, the reveal's view and
    /// the flight take it (the page hides the address, and a reload serves
    /// the Chia-off lines), and it stays off, as Chia does until the node
    /// stops. A hello that failed, or named another network, changes
    /// nothing; a refusal still takes it for the page; and an answer for a
    /// window no longer out is refused and changes nothing either.
    #[test]
    fn a_reveal_that_finds_chia_turned_off_hides_the_address_of_a_window_opened_with_chia_on() {
        let other = if SHELL_NET == TESTNET11 { MAINNET } else { TESTNET11 };
        let words = "[\"abandon\",\"ability\",\"able\",\"about\",\"above\",\"absent\",\"absorb\",\"abstract\",\"absurd\",\"abuse\",\"access\",\"accident\",\"account\",\"accuse\",\"achieve\",\"acid\",\"acoustic\",\"acquire\",\"across\",\"act\",\"action\",\"actor\",\"actress\",\"actual\"]";
        let ok = format!("{{\"ok\":true,\"words\":{words},\"key\":7,\"address\":\"txch1abc\"}}");
        let reveal = || reveal_outcome(answer(&ok), Some("txch1abc"));
        let hello = |net: crate::shell_channel::Net, chia_off: bool| {
            Ok(Hello { net_id: net.id.into(), genesis: net.genesis.into(), wallet: "on".into(), backed_up: false, address: Some("txch1abc".into()), chia_off })
        };
        let (backup, _pipes) = quiet_backup();
        backup.begin(Instant::now()).unwrap();
        let instance = backup.opened("txch1abc".into(), false);
        assert!(!index(&window_facts(Some(&backup))).contains(" hidden>"), "opened with Chia on: the address shows");

        let view = backup.land_reveal(instance, reveal(), hello(SHELL_NET, false)).unwrap();
        assert!(!view.chia_off && !backup.flight().chia_off, "Chia still on");
        // Off for a hello that failed, or one for another network: nothing changes.
        assert!(!backup.land_reveal(instance, reveal(), Err(Failed::TimedOut)).unwrap().chia_off);
        assert!(!backup.land_reveal(instance, reveal(), hello(other, true)).unwrap().chia_off);

        // Turned off in the game: the next reveal says so.
        let view = backup.land_reveal(instance, reveal(), hello(SHELL_NET, true)).unwrap();
        assert!(view.chia_off);
        assert_eq!((view.address.as_str(), backup.flight().key), ("txch1abc", Some(7)), "the words still show, for the same wallet");
        assert_eq!(serde_json::to_value(&view).unwrap()["chia_off"], serde_json::json!(true), "the page is told");
        let facts = window_facts(Some(&backup));
        assert_eq!((facts.address.as_deref(), facts.chia_off), (Some("txch1abc"), true));
        assert!(index(&facts).contains("<p class=\"facts\" id=\"address-line\" hidden>"), "a reload serves the Chia-off lines");

        // It stays off: a later hello that says on, or none, changes nothing.
        assert!(backup.land_reveal(instance, reveal(), hello(SHELL_NET, false)).unwrap().chia_off);
        assert!(backup.land_reveal(instance, reveal(), Err(Failed::Closed)).unwrap().chia_off);

        // A refusal takes it for the page too, and still records already_saved.
        let (backup, _pipes) = quiet_backup();
        backup.begin(Instant::now()).unwrap();
        let instance = backup.opened("txch1abc".into(), false);
        let saved = reveal_outcome(answer(r#"{"ok":false,"saved":true,"error":"x"}"#), Some("txch1abc"));
        assert_eq!(backup.land_reveal(instance, saved, hello(SHELL_NET, true)).unwrap_err(), "already_saved");
        let f = backup.flight();
        assert_eq!((f.chia_off, f.outcome), (true, Outcome::AlreadySaved));
        drop(f);

        // An answer for a window that is no longer out changes nothing.
        let (backup, _pipes) = quiet_backup();
        backup.begin(Instant::now()).unwrap();
        let instance = backup.opened("txch1abc".into(), false);
        backup.opened("txch1abc".into(), false);
        assert_eq!(backup.land_reveal(instance, reveal(), hello(SHELL_NET, true)).unwrap_err(), "refused");
        let f = backup.flight();
        assert_eq!((f.chia_off, f.key), (false, None));
    }

    /// ⛓️ The page's half: a reveal answer that says Chia is off hides the
    /// address line and swaps the hint for the Chia-off lines' own, before
    /// anything else is decided (an answer dropped for a hidden window still
    /// says it), and never shows the line again.
    #[test]
    fn the_page_hides_the_address_when_a_reveal_says_chia_is_off() {
        let js = std::str::from_utf8(REVEAL_JS).unwrap();
        let needle = "const CHIA_OFF_HINT = '";
        let hint = js.find(needle).map(|at| &js[at + needle.len()..]).expect("the Chia-off hint");
        let hint = &hint[..hint.find("';").unwrap()];
        assert!(ADDRESS_LINES_CHIA_OFF.contains(&format!("<p class=\"hint\" id=\"address-hint\">{hint}</p>")), "{hint:?} is the index's");
        assert!(js.contains("const addressLine = document.getElementById('address-line');"));
        assert!(js.contains("const addressHint = document.getElementById('address-hint');"));
        let off = &js[js.find("function chiaTurnedOff() {").expect("chiaTurnedOff()")..];
        let off = &off[..off.find("\n  }").unwrap()];
        assert!(off.contains("addressLine.hidden = true;") && off.contains("addressHint.textContent = CHIA_OFF_HINT;"), "{off}");
        assert!(!js.contains("addressLine.hidden = false") && !js.contains("removeAttribute('hidden')"), "the line never comes back");
        let landed = &js[js.find("(answer) => {").expect("the reveal's answer")..];
        let first = landed.find("if (answer && answer.chia_off === true) chiaTurnedOff();").expect("the answer's chia_off is read");
        assert!(first < landed.find("if (ticket !== gen").unwrap(), "before the answer can be dropped");
        assert!(first < landed.find("answer.address !== addressShown").unwrap(), "before the address check");
    }

    /// A window opened for txch1abc whose last reveal gave key 7.
    fn shown_backup() -> (Arc<Backup>, (std::io::PipeReader, std::io::PipeWriter)) {
        let (backup, pipes) = quiet_backup();
        backup.begin(Instant::now()).unwrap();
        backup.opened("txch1abc".into(), false);
        backup.flight().key = Some(7);
        (Arc::new(backup), pipes)
    }

    /// Wait for [`Backup::settled`] on a thread of its own.
    fn settle(backup: &Arc<Backup>) -> std::thread::JoinHandle<(Outcome, bool)> {
        let backup = backup.clone();
        std::thread::spawn(move || tauri::async_runtime::block_on(backup.settled()))
    }

    #[test]
    fn a_close_waits_for_a_saved_request_that_is_out_and_answers_what_it_recorded() {
        let (backup, _pipes) = shown_backup();
        let (guard, key) = backup.start_save().unwrap();
        assert_eq!(key, 7);
        // The window closes while the node's answer is still out.
        let closing = settle(&backup);
        std::thread::sleep(Duration::from_millis(150));
        assert!(!closing.is_finished(), "the close waits for the saved answer");
        guard.done(true);
        assert_eq!(closing.join().unwrap(), (Outcome::Saved, true), "saved, not closed");
        assert_eq!(backup.start_save().err(), Some("refused"), "no saved request once the close is settled");
    }

    #[test]
    fn a_saved_request_that_fails_or_is_dropped_releases_the_close() {
        let (backup, _pipes) = shown_backup();
        let (guard, _) = backup.start_save().unwrap();
        let closing = settle(&backup);
        std::thread::sleep(Duration::from_millis(50));
        guard.done(false);
        assert_eq!(closing.join().unwrap(), (Outcome::Closed, true), "closed, with a saved request tried");

        let (backup, _pipes) = shown_backup();
        let (guard, _) = backup.start_save().unwrap();
        let closing = settle(&backup);
        std::thread::sleep(Duration::from_millis(50));
        drop(guard);
        assert_eq!(closing.join().unwrap(), (Outcome::Closed, true), "a dropped request never holds the close");

        let (backup, _pipes) = shown_backup();
        assert_eq!(settle(&backup).join().unwrap(), (Outcome::Closed, false), "no saved request: closed at once");
    }

    #[test]
    fn a_saved_request_needs_an_open_window_and_a_reveal() {
        let (backup, _pipes) = quiet_backup();
        assert_eq!(backup.start_save().err(), Some("refused"), "no window out");
        backup.begin(Instant::now()).unwrap();
        backup.opened("txch1abc".into(), false);
        assert_eq!(backup.start_save().err(), Some("not_shown"));
        backup.flight().key = Some(7);
        assert!(backup.start_save().is_ok());
        // The next opening starts clean.
        backup.flight().settled = true;
        backup.opened("txch1abc".into(), false);
        let f = backup.flight();
        assert_eq!((f.saving, f.save_tried, f.settled, f.key, f.outcome), (false, false, false, None, Outcome::Closed));
    }

    #[test]
    fn a_failed_saved_request_counts_when_the_hello_says_the_mark_was_written() {
        let other = if SHELL_NET == TESTNET11 { MAINNET } else { TESTNET11 };
        let hello = |net: crate::shell_channel::Net, wallet: &str, backed_up: bool, address: &str| {
            Ok(Hello { net_id: net.id.into(), genesis: net.genesis.into(), wallet: wallet.into(), backed_up, address: Some(address.into()), chia_off: false })
        };
        assert!(saved_after_all(hello(SHELL_NET, "on", true, "txch1abc"), "txch1abc", false));
        assert!(!saved_after_all(hello(SHELL_NET, "on", false, "txch1abc"), "txch1abc", false), "not written");
        assert!(!saved_after_all(hello(SHELL_NET, "on", true, "txch1other"), "txch1abc", false), "another wallet");
        assert!(!saved_after_all(hello(SHELL_NET, "off", true, "txch1abc"), "txch1abc", false));
        assert!(!saved_after_all(hello(other, "on", true, "txch1abc"), "txch1abc", false));
        assert!(!saved_after_all(hello(SHELL_NET, "on", true, "txch1abc"), "txch1abc", true), "sticky other network");
        assert!(!saved_after_all(Err(Failed::TimedOut), "txch1abc", false));
    }

    #[test]
    fn the_eight_answers_are_the_pages() {
        let all = [
            OpenAnswer::Saved,
            OpenAnswer::Closed,
            OpenAnswer::NoChannel,
            OpenAnswer::OtherNetwork,
            OpenAnswer::NotOn,
            OpenAnswer::Turning,
            OpenAnswer::AlreadySaved,
            OpenAnswer::Busy,
        ];
        let names: Vec<&str> = all.iter().map(|a| a.as_str()).collect();
        assert_eq!(names, ["saved", "closed", "no_channel", "other_network", "not_on", "turning", "already_saved", "busy"]);
    }

    fn answer(json: &str) -> Answer {
        Answer::parse(json).unwrap()
    }

    #[test]
    fn a_reveal_shows_only_the_wallet_the_window_opened_for() {
        let words = "[\"abandon\",\"ability\",\"able\",\"about\",\"above\",\"absent\",\"absorb\",\"abstract\",\"absurd\",\"abuse\",\"access\",\"accident\",\"account\",\"accuse\",\"achieve\",\"acid\",\"acoustic\",\"acquire\",\"across\",\"act\",\"action\",\"actor\",\"actress\",\"actual\"]";
        let ok = format!("{{\"ok\":true,\"words\":{words},\"key\":7,\"address\":\"txch1abc\"}}");
        let (view, key) = reveal_outcome(answer(&ok), Some("txch1abc")).unwrap();
        assert_eq!((view.words.len(), key, view.address.as_str()), (24, 7, "txch1abc"));
        assert_eq!(format!("{view:?}"), "RevealView { words: [24 words], address: \"txch1abc\", chia_off: false }");
        assert_eq!(reveal_outcome(answer(&ok), Some("txch1other")).unwrap_err(), "changed");
        assert_eq!(reveal_outcome(answer(&ok), None).unwrap_err(), "changed");
        assert_eq!(reveal_outcome(answer(r#"{"ok":false,"saved":true,"error":"x"}"#), Some("txch1abc")).unwrap_err(), "already_saved");
        assert_eq!(reveal_outcome(answer(r#"{"ok":false,"error":"x"}"#), Some("txch1abc")).unwrap_err(), "refused");
        assert_eq!(reveal_outcome(answer(r#"{"ok":true,"words":["abandon"],"key":7,"address":"txch1abc"}"#), Some("txch1abc")).unwrap_err(), "refused");
        let no_key = format!("{{\"ok\":true,\"words\":{words},\"address\":\"txch1abc\"}}");
        assert_eq!(reveal_outcome(answer(&no_key), Some("txch1abc")).unwrap_err(), "refused");
    }

    /// The capability files: `main` holds only `allow-open-backup`, `reveal`
    /// only the two reveal permissions; no core permission and no remote URL
    /// in either.
    #[test]
    fn the_capabilities_give_each_window_only_its_own_commands() {
        use tauri::utils::acl::capability::Capability;
        let main: Capability = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let reveal: Capability = serde_json::from_str(include_str!("../capabilities/reveal.json")).unwrap();
        let ids = |c: &Capability| -> Vec<String> {
            c.permissions
                .iter()
                .map(|p| match p {
                    tauri::utils::acl::capability::PermissionEntry::PermissionRef(id) => id.get().to_string(),
                    tauri::utils::acl::capability::PermissionEntry::ExtendedPermission { identifier, .. } => identifier.get().to_string(),
                })
                .collect()
        };
        assert_eq!(main.windows, ["main"]);
        assert!(main.webviews.is_empty());
        assert_eq!(ids(&main), ["allow-open-backup"]);
        assert_eq!(reveal.windows, ["reveal"]);
        assert_eq!(reveal.webviews, ["reveal"]);
        let mut r = ids(&reveal);
        r.sort();
        assert_eq!(r, ["allow-backup-reveal", "allow-backup-saved"]);
        for c in [&main, &reveal] {
            assert!(c.remote.is_none(), "no remote URL");
            assert!(c.local);
            assert!(ids(c).iter().all(|p| !p.starts_with("core:") && !p.contains(':')));
        }
        for text in [include_str!("../capabilities/main.json"), include_str!("../capabilities/reveal.json")] {
            for banned in ["core:", "http", "remote"] {
                assert!(!text.contains(banned), "{banned}");
            }
        }
    }
}
