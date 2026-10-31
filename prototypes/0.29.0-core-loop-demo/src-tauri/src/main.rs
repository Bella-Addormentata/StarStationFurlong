#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod wt_listener;

use std::collections::HashMap;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::State;
use wt_listener::{compute_fingerprint, start_wt_server, run_wt_listener, start_http_api_server, Fingerprint, HubState, SharedHub};

#[tauri::command]
fn get_fingerprint(hub: State<'_, SharedHub>) -> Result<Fingerprint, String> {
    let fp = hub.fingerprint.lock().unwrap();
    Ok(fp.clone())
}

#[tauri::command]
async fn rotate_fingerprint(hub: State<'_, SharedHub>) -> Result<Fingerprint, String> {
    println!("🔄 Command -> Requesting Certificate Rotation...");
    let next_id = wtransport::Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|e| format!("Failed to generate self-signed cert: {:?}", e))?;
    
    let fp = compute_fingerprint(&next_id, hub.port)
        .map_err(|e| format!("Failed to digest fingerprint: {:?}", e))?;

    // In a real Tauri context, the Endpoint would be reloadable. Let's register it.
    {
        let mut inner_fp = hub.fingerprint.lock().unwrap();
        *inner_fp = fp.clone();
    }
    
    println!("✅ Certificate rotated smoothly. New Hash: {}", fp.hex);
    Ok(fp)
}

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
    /// UDP 4443 is already bound — an external ssf-p2p-node (or prior spawn) is serving.
    AlreadyRunning,
    /// We spawned the standalone node binary; child must be killed on app exit.
    Spawned(Child),
    /// No node binary found anywhere — embedded iroh-less listener is the fallback.
    Unavailable,
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

    for candidate in node_binary_candidates() {
        if !candidate.is_file() {
            continue;
        }
        let mut cmd = Command::new(&candidate);
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
        match cmd.spawn() {
            Ok(child) => {
                println!("🛰️ Spawned sovereign P2P node: {} (pid {})", candidate.display(), child.id());
                return NodeMode::Spawned(child);
            }
            Err(e) => eprintln!("⚠️ Failed to spawn {}: {e}", candidate.display()),
        }
    }

    // Last resort: whatever `ssf-p2p-node` resolves to on PATH.
    match Command::new("ssf-p2p-node").spawn() {
        Ok(child) => {
            println!("🛰️ Spawned sovereign P2P node from PATH (pid {})", child.id());
            NodeMode::Spawned(child)
        }
        Err(_) => NodeMode::Unavailable,
    }
}

/// Minimal hub so the vestigial `get_fingerprint`/`rotate_fingerprint` commands stay
/// callable when the external node owns the real state. The frontend reads the real
/// fingerprint over HTTP (127.0.0.1:8080/8081), not through these commands.
fn external_placeholder_hub(port: u16) -> SharedHub {
    Arc::new(HubState {
        rooms: Mutex::new(HashMap::new()),
        fingerprint: Mutex::new(Fingerprint {
            hex: "(external ssf-p2p-node — query http://127.0.0.1:8080/api/fingerprint)".into(),
            base64: String::new(),
            port,
        }),
        port,
    })
}

fn main() {
    let listen_port = 4443;

    // Handle to a spawned node child so the exit hook can reap it. Tauri's run()
    // terminates via std::process::exit, so Drop guards in main() would never fire.
    let node_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    let hub_for_commands: SharedHub = match acquire_p2p_node(listen_port) {
        NodeMode::AlreadyRunning => external_placeholder_hub(listen_port),
        NodeMode::Spawned(child) => {
            *node_child.lock().unwrap() = Some(child);
            external_placeholder_hub(listen_port)
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

            let hub_http = hub.clone();
            let hub_run = hub.clone();
            std::thread::spawn(move || {
                rt.spawn(async move {
                    start_http_api_server(hub_http).await;
                });
                if let Err(e) = rt.block_on(run_wt_listener(hub_run, endpoint)) {
                    eprintln!("⚠️ WebTransport server error: {:?}", e);
                }
            });

            hub
        }
    };

    // Boot Tauri v2 App Shell (Sovereign backbone)
    let node_child_on_exit = node_child.clone();
    tauri::Builder::default()
        .manage(hub_for_commands)
        .invoke_handler(tauri::generate_handler![get_fingerprint, rotate_fingerprint])
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
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_web_resource_request(|request, response| {
                    if request.uri().path().starts_with("/emulatorjs/") {
                        response.headers_mut().insert(
                            tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
                            tauri::http::HeaderValue::from_static("*"),
                        );
                    }
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = node_child_on_exit.lock().unwrap().take() {
                    println!("🛑 Stopping spawned ssf-p2p-node (pid {})", child.id());
                    house_step_down();
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
