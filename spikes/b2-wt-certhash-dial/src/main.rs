use anyhow::{anyhow, Result};
use axum::{routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use wtransport::{Endpoint, Identity, ServerConfig};

#[derive(Serialize, Deserialize, Clone, Debug)]
struct FingerprintResponse {
    hex: String,
    base64: String,
    port: u16,
}

struct AppState {
    endpoint: Endpoint<wtransport::endpoint::endpoint_side::Server>,
    current_fingerprint: Arc<Mutex<FingerprintResponse>>,
    port: u16,
}

fn compute_fingerprint(identity: &Identity) -> Result<(String, String)> {
    let chain = identity.certificate_chain();
    let certs = chain.as_slice();
    if certs.is_empty() {
        return Err(anyhow!("No certificates found in chain"));
    }
    
    // wtransport Certificate hash API
    let digest = certs[0].hash();
    let result: &[u8; 32] = digest.as_ref();
    
    let hex = hex::encode(result);
    let base64 = base64::Engine::encode(&base64::prelude::BASE64_STANDARD, result);
    Ok((hex, base64))
}

#[tokio::main]
async fn main() -> Result<()> {
    // Generate our first self-signed identity
    let wt_port = 4443;
    let initial_identity = Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|e| anyhow!("Failed to generate self-signed identity: {:?}", e))?;
    
    let (hex, base64) = compute_fingerprint(&initial_identity)?;
    println!("🔐 Initial WebTransport Fingerprint SHA-256:");
    println!("  Hex:    {}", hex);
    println!("  Base64: {}", base64);

    let current_fingerprint = Arc::new(Mutex::new(FingerprintResponse {
        hex,
        base64,
        port: wt_port,
    }));
    
    // WebTransport server configuration
    let wt_addr = SocketAddr::from(([0, 0, 0, 0], wt_port));
    let wt_config = ServerConfig::builder()
        .with_bind_address(wt_addr)
        .with_identity(initial_identity)
        .build();
    
    println!("🚀 Launching WebTransport spike server on UDP port {}", wt_port);
    let wt_endpoint = Endpoint::server(wt_config)
        .map_err(|e| anyhow!("Failed to create WebTransport server endpoint: {:?}", e))?;

    let state = Arc::new(AppState {
        endpoint: wt_endpoint,
        current_fingerprint,
        port: wt_port,
    });

    // Start background WebTransport connection acceptance loop
    let state_clone = state.clone();
    tokio::spawn(async move {
        if let Err(e) = run_wt_loop(state_clone).await {
            eprintln!("⚠️ WebTransport loop error: {:?}", e);
        }
    });

    // HTTP Axum API to coordinate with the browser client
    let cors = CorsLayer::permissive();
    let api_router = Router::new()
        .route("/api/fingerprint", get(handle_get_fingerprint))
        .route("/api/rotate", post(handle_rotate_cert))
        .layer(cors)
        .with_state(state.clone());

    // Serve index.html and static files from "static" dir, falling back to /api routes
    let app = Router::new()
        .fallback_service(ServeDir::new("static"))
        .merge(api_router);

    let http_addr: SocketAddr = "127.0.0.1:8080".parse()?;
    println!("🌍 Web client & REST control API served on http://{}", http_addr);
    
    let listener = tokio::net::TcpListener::bind(http_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn handle_get_fingerprint(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> Result<Json<FingerprintResponse>, axum::http::StatusCode> {
    let fp = state.current_fingerprint.lock().unwrap();
    Ok(Json(fp.clone()))
}

async fn handle_rotate_cert(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> Result<Json<FingerprintResponse>, axum::http::StatusCode> {
    println!("🔄 Rotating WebTransport self-signed certificate dynamically...");
    
    // Generate next 14-day identity
    let next_identity = Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    
    let (hex, base64) = compute_fingerprint(&next_identity)
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    
    // Update the wtransport Endpoint config dynamically WITHOUT dropping sessions
    let config = ServerConfig::builder()
        .with_bind_address(SocketAddr::from(([0, 0, 0, 0], state.port)))
        .with_identity(next_identity)
        .build();
    
    state.endpoint.reload_config(config, false)
        .map_err(|e| {
            eprintln!("Failed to reload config: {:?}", e);
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        })?;
    
    let mut current_fp = state.current_fingerprint.lock().unwrap();
    *current_fp = FingerprintResponse {
        hex: hex.clone(),
        base64: base64.clone(),
        port: state.port,
    };
    
    println!("✅ Certification rotation successful!");
    println!("  New SHA-256 Hex: {}", hex);
    
    Ok(Json(current_fp.clone()))
}

async fn run_wt_loop(state: Arc<AppState>) -> Result<()> {
    loop {
        // Accept incoming WebTransport sessions
        let incoming_session = state.endpoint.accept().await;
        
        let session_request = match incoming_session.await {
            Ok(req) => req,
            Err(e) => {
                eprintln!("Failed to accept incoming WT connection pre-handshake: {:?}", e);
                continue;
            }
        };

        // Accept the session
        let connection = match session_request.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("Failed WT handshake accept: {:?}", e);
                continue;
            }
        };

        println!("🤝 New WebTransport session established from {}", connection.remote_address());
        
        // Handle session stream & datagram traffic
        tokio::spawn(async move {
            if let Err(e) = handle_session(connection).await {
                eprintln!("Session closed with error: {:?}", e);
            } else {
                println!("🔌 WebTransport session closed cleanly");
            }
        });
    }
}

async fn handle_session(connection: wtransport::Connection) -> Result<()> {
    loop {
        tokio::select! {
            // Echo back incoming datagrams (UDP mode)
            datagram = connection.receive_datagram() => {
                let datagram = datagram?;
                println!("📩 Received WT Datagram (size: {}): {:?}", datagram.len(), String::from_utf8_lossy(&*datagram));
                // Echo back
                connection.send_datagram(&*datagram)?;
                println!("📤 Echoed WT Datagram back to client");
            }
            // Read incoming bi-directional stream
            stream = connection.accept_bi() => {
                let (mut send, mut recv) = stream?;
                println!("🛠️ New bi-directional stream accepted");
                
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 1024];
                    loop {
                        match recv.read(&mut buf).await {
                            Ok(Some(n)) => {
                                let msg = String::from_utf8_lossy(&buf[..n]);
                                println!("💬 Inbound stream payload ({} bytes): {}", n, msg);
                                // Echo back
                                if let Err(e) = send.write_all(&buf[..n]).await {
                                    eprintln!("Failed to write to stream: {:?}", e);
                                    break;
                                }
                            }
                            Ok(None) => break,
                            Err(e) => {
                                eprintln!("Error reading stream: {:?}", e);
                                break;
                            }
                        }
                    }
                    println!("🔒 Bi-directional stream handling complete");
                });
            }
        }
    }
}
