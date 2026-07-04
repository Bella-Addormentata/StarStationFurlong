use anyhow::{anyhow, Result};
use axum::{
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use yrs::{
    encoding::write::Write,
    updates::decoder::Decode,
    updates::encoder::{Encode, Encoder, EncoderV1},
    Doc, Map, StateVector, Transact, Update, ReadTxn, WriteTxn,
};

struct RoomState {
    doc: Doc,
}

#[tokio::main]
async fn main() -> Result<()> {
    let room = Arc::new(Mutex::new(RoomState {
        doc: Doc::new(),
    }));

    // Pre-populate raw lobby data in the server-side yrs instance
    {
        let room = room.clone();
        let state = room.lock().unwrap();
        let mut txn = state.doc.transact_mut();
        let map = txn.get_or_insert_map("room_metadata");
        map.insert(&mut txn, "name".to_string(), "Furlong Station Lobby".to_string());
        map.insert(&mut txn, "motd".to_string(), "Welcome back, Clones! Remember to clean up your berths.".to_string());
    }

    let app_state = room.clone();

    let cors = CorsLayer::permissive();
    let app = Router::new()
        .fallback_service(ServeDir::new("static"))
        .route("/ws", get(move |ws| ws_handler(ws, app_state.clone())))
        .layer(cors);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8081));
    println!("🌍 yrs-Yjs Conformance Spike served on http://{}", addr);
    println!("⚡ Real-time synchronization socket at ws://{}/ws", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, state: Arc<Mutex<RoomState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<Mutex<RoomState>>) {
    println!("🔌 New WebSocket peer connected for room sync!");

    // Protocol Step 1: Send our state vector (SyncStep1)
    // To match y-protocols/dist/sync, a message format is:
    // [message_type (0 = Sync), sync_message_type (0 = SyncStep1), length, state_vector_bytes...]
    let mut encoder = EncoderV1::new();
    // Message type 0 is sync
    encoder.write_var(0u32); 
    // Sync subtype 0 is SyncStep1
    encoder.write_var(0u32); 
    
    let sv = {
        let room = state.lock().unwrap();
        let txn = room.doc.transact();
        txn.state_vector()
    };
    encoder.write_buf(&sv.encode_v1());

    let payload = encoder.to_vec();
    if let Err(e) = socket.send(WsMessage::Binary(payload)).await {
        eprintln!("Failed to send initial SyncStep1: {:?}", e);
        return;
    }
    println!("📤 Inflight -> SyncStep1 sent to browser client");

    // Start reading client updates
    while let Some(Ok(msg)) = socket.recv().await {
        if let WsMessage::Binary(bytes) = msg {
            if let Err(e) = process_client_message(&mut socket, &state, &bytes).await {
                eprintln!("Error processing y-sync protocol payload: {:?}", e);
            }
        }
    }
    println!("🔌 Peer session closed");
}

async fn process_client_message(
    socket: &mut WebSocket,
    state: &Arc<Mutex<RoomState>>,
    bytes: &[u8],
) -> Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }

    let mut cursor = 0;
    
    // Read messageType (var_uint)
    let (msg_type, bytes_read) = read_var_uint(bytes, cursor)?;
    cursor += bytes_read;

    if msg_type == 0 {
        // This is a Sync message
        let (sync_sub_type, bytes_read) = read_var_uint(bytes, cursor)?;
        cursor += bytes_read;

        if sync_sub_type == 0 {
            // SyncStep1: Client sent their state vector. 
            // We must compile a SyncStep2 containing our document's missing blocks relative to client's SV.
            println!("📥 Received SyncStep1 from browser client");
            
            // Read client state vector bytes
            let (client_sv_bytes, bytes_read) = read_length_and_buf(bytes, cursor)?;
            cursor += bytes_read;

            let client_sv = StateVector::decode_v1(&client_sv_bytes)
                .map_err(|e| anyhow!("Failed to decode client state vector: {:?}", e))?;

            // Generate SyncStep2 (contains missing updates relative to client_sv)
            let mut encoder = EncoderV1::new();
            encoder.write_var(0u32); // MessageType = Sync
            encoder.write_var(1u32); // SyncSubType = SyncStep2
            
            let missing_diff = {
                let room = state.lock().unwrap();
                let txn = room.doc.transact();
                txn.encode_diff_v1(&client_sv)
            };
            encoder.write_buf(&missing_diff);

            let payload = encoder.to_vec();
            socket.send(WsMessage::Binary(payload)).await?;
            println!("📤 Inflight -> SyncStep2 sent to browser client (diff update payload)");

        } else if sync_sub_type == 1 || sync_sub_type == 2 {
            // SyncStep2 or Update: Client sent document updates or we applied missing state.
            // Merge this update into our node doc.
            println!("📥 Received SyncStep2/Update block from browser client");
            
            let (update_bytes, _bytes_read) = read_length_and_buf(bytes, cursor)?;
            
            let update = Update::decode_v1(&update_bytes)
                .map_err(|e| anyhow!("Failed to decode update block: {:?}", e))?;

            {
                let room = state.lock().unwrap();
                let mut txn = room.doc.transact_mut();
                txn.apply_update(update)
                    .map_err(|e| anyhow!("Failed to apply browser update: {:?}", e))?;
            }
            println!("✅ Conformance update applied successfully to node's yrs Doc!");
            
            // Let's print the state vector status for diagnostics
            {
                let room = state.lock().unwrap();
                let txn = room.doc.transact();
                println!("  Node state vector now: {:?}", txn.state_vector());
                if let Some(map) = txn.get_map("room_metadata") {
                    if let Some(motd) = map.get(&txn, "motd") {
                        println!("  Metadata 'motd' value: {:?}", motd);
                    }
                }
            }
        }
    } else {
        println!("⚠️ Ignored external topic/awareness envelope inside this spike.");
    }

    Ok(())
}

fn read_var_uint(bytes: &[u8], mut cursor: usize) -> Result<(u32, usize)> {
    let mut value: u32 = 0;
    let mut shift = 0;
    let start = cursor;
    
    loop {
        if cursor >= bytes.len() {
            return Err(anyhow!("Unexpected EOF parsing varint"));
        }
        let byte = bytes[cursor];
        cursor += 1;
        
        value |= ((byte & 0x7f) as u32) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 32 {
            return Err(anyhow!("Varint too long"));
        }
    }
    
    Ok((value, cursor - start))
}

fn read_length_and_buf(bytes: &[u8], mut cursor: usize) -> Result<(Vec<u8>, usize)> {
    let (len, bytes_read) = read_var_uint(bytes, cursor)?;
    cursor += bytes_read;
    
    let len = len as usize;
    if cursor + len > bytes.len() {
        return Err(anyhow!("Unexpected EOF parsing buffer payload (length {})", len));
    }
    
    let buf = bytes[cursor..cursor + len].to_vec();
    Ok((buf, bytes_read + len))
}
