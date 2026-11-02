#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod reveal;
mod shell_channel;
mod wt_listener;

use std::process::Child;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use shell_channel::{node_command, Channel};
use wt_listener::{start_wt_server, run_wt_listener, start_http_api_server};

/// 🏠 Ask the node we spawned to step its house down before it is stopped
/// (ssf-p2p-node house.rs): the tables it runs go on Friendly with no void.
/// Its local HTTP API is on 8080, or 8081 when that was taken: both are asked
/// at once, each with the whole second and a half, so something else on 8080
/// that holds its answer open can't spend the time the node on 8081 needs.
/// Only the node holding UDP 4443 serves that API, and that is the one we
/// spawned, so no other node is asked. One that doesn't answer is stopped all
/// the same.
fn house_step_down() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(1_500);
    let (tx, rx) = mpsc::channel();
    for port in [8080u16, 8081] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(ask_house_step_down(port, deadline));
        });
    }
    drop(tx);
    // The first port that is the node's ends the wait; a port that isn't
    // leaves it to the other. Both answered no, or the deadline: we're done.
    while let Ok(stepped) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        if stepped {
            println!("🏠 The node's house stepped down");
            return;
        }
    }
}

/// One port's ask: true when the node's own answer came back by `deadline`.
fn ask_house_step_down(port: u16, deadline: std::time::Instant) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::{Duration, Instant};
    let left = || deadline.saturating_duration_since(Instant::now());
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, left().min(Duration::from_millis(200)).max(Duration::from_millis(1))) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(left().max(Duration::from_millis(1))));
    let req = "POST /api/house/stepdown HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    // The answer is a few hundred bytes: read at most 4 KB, by the deadline,
    // so whatever listens there can't hold the app's exit.
    let mut answer = Vec::new();
    let mut buf = [0u8; 512];
    while answer.len() < 4_096 {
        let wait = left();
        if wait.is_zero() || stream.set_read_timeout(Some(wait)).is_err() {
            break;
        }
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => answer.extend_from_slice(&buf[..n]),
        }
    }
    // The node's own answer ({"ok":true,"wrote":N}), not any server's 200.
    let text = String::from_utf8_lossy(&answer);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b.trim_start()).unwrap_or("");
    text.starts_with("HTTP/1.1 200") && body.starts_with("{\"ok\":true,\"wrote\":")
}

/// How we ended up with (or without) a sovereign P2P node this launch.
enum NodeMode {
    /// UDP 4443 is already bound — an external ssf-p2p-node (or prior spawn)
    /// is serving. The app did not start it, so it has no channel to it.
    AlreadyRunning,
    /// We spawned the standalone node binary; child must be killed on app
    /// exit. `channel` is the node's stdin and stdout, when the app could
    /// guard its ends of the pipes (shell_channel.rs); none otherwise.
    Spawned { child: Child, channel: Option<Arc<Channel>> },
    /// No node binary found anywhere — embedded iroh-less listener is the
    /// fallback, with its own hub and no channel.
    Unavailable,
}

impl NodeMode {
    /// The channel the backup window may use: only a node this app spawned
    /// with the channel on. A node already running, or the embedded
    /// listener, has none, and `open_backup` answers `no_channel`.
    fn channel(&self) -> Option<Arc<Channel>> {
        match self {
            NodeMode::Spawned { channel, .. } => channel.clone(),
            NodeMode::AlreadyRunning | NodeMode::Unavailable => None,
        }
    }
}

/// The spawned node, kept for the exit hook.
struct SpawnedNode {
    child: Child,
    channel: Option<Arc<Channel>>,
}

/// Candidate locations for the standalone node binary, in preference order:
/// 1. Next to our own executable (bundled-sidecar layout, §7.5 — `bundle.externalBin`)
/// 2. Dev-tree release/debug builds relative to this crate's manifest
fn node_binary_candidates() -> Vec<std::path::PathBuf> {
    let exe_name = if cfg!(windows) { "ssf-p2p-node.exe" } else { "ssf-p2p-node" };
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(exe_name));
        }
    }
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest_dir.join("../ssf-p2p-node/target/release").join(exe_name));
    candidates.push(manifest_dir.join("../ssf-p2p-node/target/debug").join(exe_name));
    candidates
}

/// Per-user writable working directory for the spawned node. The node persists
/// `iroh_node_id.key` into its cwd — which must NOT be the install dir, because
/// bundled installs can land in read-only locations (Program Files, /usr/bin).
/// Falls back to the binary's own directory (pre-0.19 behavior) if unavailable.
fn node_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| std::path::PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")));
    let dir = base?.join("StarStationFurlong");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// `cmd` with the node's channel turned on, only when `guarded`.
fn channel_command(mut cmd: std::process::Command, guarded: bool) -> std::process::Command {
    if guarded {
        shell_channel::attach(&mut cmd);
    }
    cmd
}

/// Spawn `cmd`, with the node's channel on when the app's ends of the
/// pipes are guarded (`guarded`): then the node's stdin and stdout are the
/// channel, and its stderr stays the app's. Otherwise it is spawned as
/// before, with no channel.
fn spawn_node(cmd: std::process::Command, guarded: bool) -> std::io::Result<(Child, Option<Arc<Channel>>)> {
    let mut child = channel_command(cmd, guarded).spawn()?;
    let channel = match (guarded, child.stdin.take(), child.stdout.take()) {
        (true, Some(stdin), Some(stdout)) => Some(Channel::start(stdin, stdout)),
        _ => None,
    };
    Ok((child, channel))
}

/// Prefer the real sovereign node (iroh + DHT + WebTransport) over the embedded
/// iroh-less listener. See REVIEW-20260708 §7.5: two packaged apps running only
/// the embedded listener silently form separate same-key rooms and never bridge.
fn acquire_p2p_node(port: u16) -> NodeMode {
    // Probe: if UDP 4443 is already bound, a node is already serving — use it.
    match std::net::UdpSocket::bind(("0.0.0.0", port)) {
        Err(_) => {
            println!("🛰️ UDP {port} already bound — assuming an external ssf-p2p-node is running; using it.");
            return NodeMode::AlreadyRunning;
        }
        Ok(sock) => drop(sock), // release the probe socket before the child binds it
    }

    // Linux: not dumpable before the first spawn, or no channel.
    let guarded = shell_channel::pipes_guarded();

    for candidate in node_binary_candidates() {
        if !candidate.is_file() {
            continue;
        }
        let mut cmd = node_command(&candidate);
        // Run the node from a per-user data dir so iroh_node_id.key persists
        // in a writable location; fall back to the binary's own directory.
        match node_data_dir() {
            Some(dir) => {
                cmd.current_dir(dir);
            }
            None => {
                if let Some(dir) = candidate.parent() {
                    cmd.current_dir(dir);
                }
            }
        }
        // Bundled sidecar must not flash a console window on Windows
        // (CREATE_NO_WINDOW) — its stdout stays on the app's console handle rules.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match spawn_node(cmd, guarded) {
            Ok((child, channel)) => {
                println!("🛰️ Spawned sovereign P2P node: {} (pid {})", candidate.display(), child.id());
                return NodeMode::Spawned { child, channel };
            }
            Err(e) => eprintln!("⚠️ Failed to spawn {}: {e}", candidate.display()),
        }
    }

    // Last resort: whatever `ssf-p2p-node` resolves to on PATH.
    match spawn_node(node_command("ssf-p2p-node"), guarded) {
        Ok((child, channel)) => {
            println!("🛰️ Spawned sovereign P2P node from PATH (pid {})", child.id());
            NodeMode::Spawned { child, channel }
        }
        Err(_) => NodeMode::Unavailable,
    }
}

/// The hello the app sends once the node is spawned: a node on another
/// network turns the backup window off for the run. Only the verdict is
/// logged, never what the node wrote.
fn hello_at_spawn(channel: Arc<Channel>) {
    let spawned = std::thread::Builder::new().name("ssf-shell-hello".into()).spawn(move || match channel.hello() {
        Ok(_) if channel.other_network() => eprintln!(
            "🖥️ Desktop app channel: the node runs on another Chia network than this app ({}), so the backup window stays off",
            shell_channel::SHELL_NET.name
        ),
        Ok(_) => println!("🖥️ Desktop app channel: on"),
        Err(e) => eprintln!("🖥️ Desktop app channel: the node did not answer its hello ({e:?}); the app asks again when the backup window opens"),
    });
    if let Err(e) = spawned {
        eprintln!("🖥️ Desktop app channel: the hello could not start ({e})");
    }
}

fn main() {
    let listen_port = 4443;

    // The spawned node, so the exit hook can reap it. Tauri's run()
    // terminates via std::process::exit, so Drop guards in main() would never fire.
    let node: Arc<Mutex<Option<SpawnedNode>>> = Arc::new(Mutex::new(None));

    let mode = acquire_p2p_node(listen_port);
    let channel = mode.channel();
    match mode {
        NodeMode::AlreadyRunning => {}
        NodeMode::Spawned { child, channel } => {
            if let Some(channel) = &channel {
                hello_at_spawn(channel.clone());
            }
            *node.lock().unwrap() = Some(SpawnedNode { child, channel });
        }
        NodeMode::Unavailable => {
            println!("⚠️ No ssf-p2p-node binary found — falling back to embedded WebTransport listener.");
            println!("   (Embedded mode has NO iroh bridging: two stations in this mode cannot reach each other.)");

            // Create ONE persistent runtime for the lifetime of the embedded servers
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap();

            let (hub, endpoint) = match rt.block_on(async { start_wt_server(listen_port).await }) {
                Ok((h, ep)) => (h, ep),
                Err(e) => {
                    eprintln!("⚠️ Failed starting WebTransport server: {:?}", e);
                    std::process::exit(1);
                }
            };

            // The embedded listener keeps its own hub.
            let hub_http = hub.clone();
            std::thread::spawn(move || {
                rt.spawn(async move {
                    start_http_api_server(hub_http).await;
                });
                if let Err(e) = rt.block_on(run_wt_listener(hub, endpoint)) {
                    eprintln!("⚠️ WebTransport server error: {:?}", e);
                }
            });
        }
    }

    // Boot Tauri v2 App Shell (Sovereign backbone)
    let node_on_exit = node.clone();
    tauri::Builder::default()
        .manage(reveal::Backup::new(channel))
        .register_uri_scheme_protocol(reveal::SCHEME, reveal::serve)
        .invoke_handler(tauri::generate_handler![reveal::open_backup, reveal::backup_reveal, reveal::backup_saved])
        .setup(|app| {
            // 🕹 The window is built here, not by tauri.conf.json ("create":
            // false), for the arcade cabinet's emulator frame. That frame is an
            // opaque origin (src/arcadeEmulator.ts), so its fetches of the
            // engine's cores carry `Origin: null`, which the app protocol's own
            // Access-Control-Allow-Origin (this window's origin) refuses. The
            // files under /emulatorjs/ are public and answer any origin, as the
            // dev server's do (vite.config.ts); nothing else changes.
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("tauri.conf.json names no window")?;
            // The window's label is the config's, which names none: "main",
            // the label capabilities/main.json and open_backup expect. It
            // opens no new window: a page script or a target=_blank link
            // gets nothing.
            let main = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_web_resource_request(|request, response| {
                    if request.uri().path().starts_with("/emulatorjs/") {
                        response.headers_mut().insert(
                            tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
                            tauri::http::HeaderValue::from_static("*"),
                        );
                    }
                })
                .build()?;
            // The backup window goes with the game page's window: it is
            // owned by it, and is never left open on its own.
            let handle = app.handle().clone();
            main.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(window) = handle.get_webview_window(reveal::LABEL) {
                        let _ = window.close();
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(SpawnedNode { mut child, channel }) = node_on_exit.lock().unwrap().take() {
                    // The channel's stdin first: the node sees EOF.
                    if let Some(channel) = channel {
                        channel.close_stdin();
                    }
                    println!("🛑 Stopping spawned ssf-p2p-node (pid {})", child.id());
                    house_step_down();
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both sidecar spawns go through `node_command`, which removes
    /// SSF_CHIA_NETWORK and SSF_SHELL_CHANNEL from the child's environment
    /// (a removed variable shows in `get_envs` as `None`); a `chia-mainnet`
    /// build then sets the network to mainnet. Nothing is spawned and
    /// nothing is read from this process's environment.
    #[test]
    fn the_sidecar_never_inherits_the_chia_network_or_the_shell_channel() {
        let net = if cfg!(feature = "chia-mainnet") { Some(std::ffi::OsStr::new("mainnet")) } else { None };
        for program in [std::ffi::OsStr::new("ssf-p2p-node"), std::ffi::OsStr::new("/opt/ssf/ssf-p2p-node")] {
            let cmd = node_command(program);
            assert_eq!(cmd.get_program(), program);
            let mut envs: Vec<_> = cmd.get_envs().collect();
            envs.sort();
            assert_eq!(
                envs,
                vec![(std::ffi::OsStr::new("SSF_CHIA_NETWORK"), net), (std::ffi::OsStr::new("SSF_SHELL_CHANNEL"), None)],
                "both removed (mainnet set back under chia-mainnet), and nothing else changed"
            );
        }
    }

    /// The channel's variable is set only when the app's ends of the pipes
    /// are guarded (on Linux, when prctl held); otherwise the node is
    /// spawned as before, with the variable removed.
    #[test]
    fn the_channel_is_turned_on_only_when_the_pipes_are_guarded() {
        let channel_var = |guarded| {
            let cmd = channel_command(node_command("ssf-p2p-node"), guarded);
            let envs: std::collections::BTreeMap<_, _> = cmd.get_envs().map(|(k, v)| (k.to_owned(), v.map(|v| v.to_owned()))).collect();
            envs.get(std::ffi::OsStr::new("SSF_SHELL_CHANNEL")).cloned()
        };
        assert_eq!(channel_var(true), Some(Some(std::ffi::OsString::from("1"))));
        assert_eq!(channel_var(false), Some(None), "still removed");
    }

    /// A node the app did not start, or the embedded listener, gives the
    /// backup window no channel, so open_backup answers `no_channel`.
    #[test]
    fn a_node_the_app_did_not_start_has_no_channel() {
        for mode in [NodeMode::AlreadyRunning, NodeMode::Unavailable] {
            assert!(mode.channel().is_none());
        }
        for mode in [NodeMode::AlreadyRunning, NodeMode::Unavailable] {
            let backup = reveal::Backup::new(mode.channel());
            assert_eq!(backup.begin(std::time::Instant::now()).err(), Some(reveal::OpenAnswer::NoChannel));
        }
    }
}
