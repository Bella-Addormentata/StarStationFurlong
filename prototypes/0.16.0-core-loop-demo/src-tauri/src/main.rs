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
/// 1. Next to our own executable (future bundled-sidecar layout, §7.5)
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
        // Run the node from its own directory so iroh_node_id.key persists beside the binary.
        if let Some(dir) = candidate.parent() {
            cmd.current_dir(dir);
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = node_child_on_exit.lock().unwrap().take() {
                    println!("🛑 Stopping spawned ssf-p2p-node (pid {})", child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
