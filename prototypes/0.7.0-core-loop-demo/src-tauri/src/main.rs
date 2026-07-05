#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod wt_listener;

use std::sync::Arc;
use tauri::State;
use wt_listener::{compute_fingerprint, start_wt_server, run_wt_listener, start_http_api_server, Fingerprint, SharedHub};

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

fn main() {
    // Start WebTransport listener in background
    let listen_port = 4443;
    let (hub, endpoint) = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async { start_wt_server(listen_port).await })
    {
        Ok((h, ep)) => (h, ep),
        Err(e) => {
            eprintln!("⚠️ Failed starting WebTransport server: {:?}", e);
            std::process::exit(1);
        }
    };

    let hub_clone = hub.clone();
    let hub_http = hub.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.spawn(async move {
            start_http_api_server(hub_http).await;
        });
        if let Err(e) = rt.block_on(run_wt_listener(hub, endpoint)) {
            eprintln!("⚠️ WebTransport server error: {:?}", e);
        }
    });

    // Boot Tauri v2 App Shell (Sovereign backbone)
    tauri::Builder::default()
        .manage(hub_clone)
        .invoke_handler(tauri::generate_handler![get_fingerprint, rotate_fingerprint])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
