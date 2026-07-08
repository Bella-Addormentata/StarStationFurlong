use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use yrs::{
    encoding::write::Write,
    updates::decoder::Decode,
    updates::encoder::{Encode, Encoder, EncoderV1},
    Doc, Map, ReadTxn, StateVector, Transact, Update, WriteTxn,
};
use wtransport::{Connection, Endpoint, Identity, ServerConfig};

mod b64 {
    use base64::prelude::*;
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&BASE64_STANDARD.encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        BASE64_STANDARD.decode(String::deserialize(d)?).map_err(Error::custom)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SsfEnvelope {
    pub v: u32,
    pub room: String,
    pub kind: String, // tick | awareness | ysync | roomlog | asset | cap | ping | pong
    pub seq: u32,
    #[serde(with = "b64")]
    pub author: Vec<u8>,
    #[serde(with = "b64")]
    pub payload: Vec<u8>,
    pub sig: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Fingerprint {
    pub hex: String,
    pub base64: String,
    pub port: u16,
}

// Global server registry of players and document states
pub struct Room {
    pub doc: Doc,
    pub connections: HashMap<SocketAddr, Connection>,
}

pub struct HubState {
    pub rooms: Mutex<HashMap<String, Room>>,
    pub fingerprint: Mutex<Fingerprint>,
    pub port: u16,
}

pub type SharedHub = Arc<HubState>;

pub fn compute_fingerprint(identity: &Identity, port: u16) -> Result<Fingerprint> {
    let chain = identity.certificate_chain();
    let certs = chain.as_slice();
    if certs.is_empty() {
        return Err(anyhow!("No certs in chain"));
    }
    let digest = certs[0].hash();
    let result: &[u8; 32] = digest.as_ref();
    let hex = hex::encode(result);
    let base64 = base64::Engine::encode(&base64::prelude::BASE64_STANDARD, result);
    Ok(Fingerprint { hex, base64, port })
}

pub async fn start_wt_server(port: u16) -> Result<(SharedHub, Endpoint<wtransport::endpoint::endpoint_side::Server>)> {
    let identity = Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|e| anyhow!("Failed to generate self-signed certificate identity: {:?}", e))?;
    
    let fingerprint = compute_fingerprint(&identity, port)?;
    
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let config = ServerConfig::builder()
        .with_bind_address(addr)
        .with_identity(identity)
        .build();

    let endpoint = Endpoint::server(config)
        .map_err(|e| anyhow!("Failed to bind wtransport server: {:?}", e))?;

    let hub = Arc::new(HubState {
        rooms: Mutex::new(HashMap::new()),
        fingerprint: Mutex::new(fingerprint),
        port,
    });

    Ok((hub, endpoint))
}

pub async fn run_wt_listener(
    hub: SharedHub,
    endpoint: Endpoint<wtransport::endpoint::endpoint_side::Server>,
) -> Result<()> {
    println!("🌌 WebTransport Server active on port {}", hub.port);
    loop {
        let incoming = endpoint.accept().await;
        let request = match incoming.await {
            Ok(req) => req,
            Err(e) => {
                eprintln!("⚠️ Failed pre-handshake connection: {:?}", e);
                continue;
            }
        };

        let connection = match request.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("⚠️ Handshake failed: {:?}", e);
                continue;
            }
        };

        let remote_addr = connection.remote_address();
        println!("🤝 Peer session opened directly from {}", remote_addr);

        let hub_clone = hub.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(hub_clone, connection).await {
                eprintln!("⚠️ Peer connection closed with error ({}): {:?}", remote_addr, e);
            } else {
                println!("🔌 Peer session clean exit for {}", remote_addr);
            }
        });
    }
}

async fn handle_connection(hub: SharedHub, connection: Connection) -> Result<()> {
    let remote_addr = connection.remote_address();
    let chosen_room: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    loop {
        tokio::select! {
            // Unreliable Datagram lane (Task 3.2: 13-byte movement ticks bobbing)
            dg = connection.receive_datagram() => {
                let datagram = dg?;
                if datagram.len() == 13 {
                    // This is a raw movement tick. Broadcast directly to all other peers in the room.
                    let room_id_snapshot = chosen_room.lock().unwrap().clone();
                    if let Some(ref room_id) = room_id_snapshot {
                        let rooms = hub.rooms.lock().unwrap();
                        if let Some(room) = rooms.get(room_id) {
                            for (&addr, peer_conn) in &room.connections {
                                if addr != remote_addr {
                                    let _ = peer_conn.send_datagram(&*datagram);
                                }
                            }
                        }
                    }
                } else {
                    // Check if it's a ping probe
                    if datagram.starts_with(b"ping") {
                        // Echo a pong back instantly (RTT & Loss computation, Task 3.4)
                        let pong = b"pong";
                        let _ = connection.send_datagram(pong);
                    }
                }
            }
            // Reliable multiplexed streams framed per SsfEnvelope
            stream = connection.accept_bi() => {
                let (mut send, mut recv) = stream?;
                let hub_clone = hub.clone();
                let remote_addr_inner = remote_addr;
                let mut room_id_inner = chosen_room.lock().unwrap().clone();
                let connection_clone = connection.clone();
                let chosen_room_inner = chosen_room.clone();
                
                tokio::spawn(async move {
                    let mut length_buf = [0u8; 4];
                    loop {
                        // Read length prefix
                        if let Err(e) = recv.read_exact(&mut length_buf).await {
                            if !matches!(e, wtransport::error::StreamReadExactError::FinishedEarly(_)) {
                                eprintln!("Error reading stream length: {:?}", e);
                            }
                            break;
                        }
                        let len = u32::from_le_bytes(length_buf) as usize;
                        let mut payload_buf = vec![0u8; len];
                        if let Err(e) = recv.read_exact(&mut payload_buf).await {
                            eprintln!("Error reading stream payload: {:?}", e);
                            break;
                        }

                        // Deserialize envelope
                        let envelope: SsfEnvelope = match serde_json::from_slice(&payload_buf) {
                            Ok(env) => env,
                            Err(e) => {
                                eprintln!("JSON deserialize error on stream: {:?}", e);
                                break;
                            }
                        };

                        // Register the player room binding on first message routing
                        if room_id_inner.is_none() {
                            room_id_inner = Some(envelope.room.clone());
                            *chosen_room_inner.lock().unwrap() = room_id_inner.clone();
                            // Create room document state natively using yrs (Task 3.3)
                            let mut rooms = hub_clone.rooms.lock().unwrap();
                            let room = rooms.entry(envelope.room.clone()).or_insert_with(|| {
                                println!("🎨 Registering new room document natively on host: {}", envelope.room);
                                Room {
                                    doc: Doc::new(),
                                    connections: HashMap::new(),
                                }
                            });
                            room.connections.insert(remote_addr_inner, connection_clone.clone());
                        }

                        // Route the SsfEnvelope by kind (ysync, chat, etc.)
                        if envelope.kind == "ysync" {
                            if let Err(e) = handle_ysync_message(&hub_clone, &room_id_inner.as_ref().unwrap(), &envelope, &mut send).await {
                                eprintln!("Yjs sync handling failure: {:?}", e);
                                break;
                            }
                        } else if envelope.kind == "awareness" {
                            // Forward awareness presence blocks directly to other room peers
                            if let Some(ref r_id) = room_id_inner {
                                // Collect peer connections while holding the lock, then release it before awaiting
                                let peers: Vec<Connection> = {
                                    let rooms = hub_clone.rooms.lock().unwrap();
                                    rooms.get(r_id).map(|room| {
                                        room.connections
                                            .iter()
                                            .filter(|(&addr, _)| addr != remote_addr_inner)
                                            .map(|(_, conn)| conn.clone())
                                            .collect()
                                    }).unwrap_or_default()
                                };
                                for peer_conn in peers {
                                    match peer_conn.open_bi().await {
                                        Ok(opening) => match opening.await {
                                            Ok((mut s, _)) => {
                                                let _ = s.write_all(&length_buf).await;
                                                let _ = s.write_all(&payload_buf).await;
                                            }
                                            Err(e) => eprintln!("Failed opening peer stream: {:?}", e),
                                        },
                                        Err(e) => eprintln!("Failed initiating peer stream: {:?}", e),
                                    }
                                }
                            }
                        }
                    }
                });
            }
        }
    }
}

async fn handle_ysync_message<W: AsyncWriteExt + Unpin>(
    hub: &SharedHub,
    room_id: &str,
    envelope: &SsfEnvelope,
    writer: &mut W,
) -> Result<()> {
    let payload = &envelope.payload;
    if payload.is_empty() {
        return Ok(());
    }

    let mut cursor = 0;
    let (msg_type, bytes_read) = read_var_uint(payload, cursor)?;
    cursor += bytes_read;

    if msg_type == 0 {
        // Sync message
        let (sync_sub_type, bytes_read) = read_var_uint(payload, cursor)?;
        cursor += bytes_read;

        if sync_sub_type == 0 {
            // Client sent SyncStep1
            let (client_sv_bytes, _) = read_length_and_buf(payload, cursor)?;
            let client_sv = StateVector::decode_v1(&client_sv_bytes)
                .map_err(|e| anyhow!("Failed decoding client state vector: {:?}", e))?;

            // Generate SyncStep2 with our missing blocks relative to client's state vector
            let mut encoder = EncoderV1::new();
            encoder.write_var(0u32); // messageType = Sync
            encoder.write_var(1u32); // syncSubType = SyncStep2

            let missing_diff = {
                let rooms = hub.rooms.lock().unwrap();
                let room = rooms.get(room_id).unwrap();
                let txn = room.doc.transact();
                txn.encode_diff_v1(&client_sv)
            };
            encoder.write_buf(&missing_diff);

            // Frame our reply inside SsfEnvelope and write back over stream
            let reply_env = SsfEnvelope {
                v: 1,
                room: room_id.to_string(),
                kind: "ysync".to_string(),
                seq: envelope.seq + 1,
                author: vec![],
                payload: encoder.to_vec(),
                sig: None,
            };

            let reply_bytes = serde_json::to_vec(&reply_env)?;
            let len_bytes = (reply_bytes.len() as u32).to_le_bytes();
            writer.write_all(&len_bytes).await?;
            writer.write_all(&reply_bytes).await?;

        } else if sync_sub_type == 1 || sync_sub_type == 2 {
            // Client sent SyncStep2 / Update. Merge it directly into the native yrs Document!
            let (update_bytes, _) = read_length_and_buf(payload, cursor)?;
            let update = Update::decode_v1(&update_bytes)
                .map_err(|e| anyhow!("Failed decoding update block: {:?}", e))?;

            {
                let rooms = hub.rooms.lock().unwrap();
                let room = rooms.get(room_id).unwrap();
                let mut txn = room.doc.transact_mut();
                txn.apply_update(update)
                    .map_err(|e| anyhow!("Failed to apply browser update: {:?}", e))?;
                println!("✅ Merged peer ysync update into native yrs doc for room: {}", room_id);
            }
        }
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
        return Err(anyhow!("Unexpected EOF reading buffer payload with size {}", len));
    }
    let buf = bytes[cursor..cursor + len].to_vec();
    Ok((buf, bytes_read + len))
}

pub async fn start_http_api_server(hub: SharedHub) {
    let mut port = 8080;
    let mut listener = None;
    while port <= 8081 {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => {
                listener = Some((l, port));
                break;
            }
            Err(e) => {
                eprintln!("⚠️ Failed to bind HTTP API server on port {}: {:?}", port, e);
                port += 1;
            }
        }
    }
    
    let (listener, bound_port) = match listener {
        Some((l, p)) => (l, p),
        None => {
            eprintln!("⚠️ Failed to bind HTTP API server on both 8080 and 8081. Local frontend won't be able to query fingerprint.");
            return;
        }
    };

    println!("🌍 Local HTTP API server listening on http://127.0.0.1:{}", bound_port);
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => continue,
        };
        let hub_clone = hub.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let n = match socket.read(&mut buf).await {
                Ok(n) if n > 0 => n,
                _ => return,
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            
            let req_lines: Vec<&str> = req.lines().collect();
            let mut origin_header = None;
            for line in req_lines {
                if line.to_ascii_lowercase().starts_with("origin:") {
                    origin_header = Some(line["origin:".len()..].trim().to_string());
                    break;
                }
            }

            let allowed_origins = [
                "tauri://localhost",
                "http://localhost:1420",
                "http://localhost:5173",
                "http://127.0.0.1:1420",
                "http://127.0.0.1:5173",
            ];

            let cors_origin = match origin_header {
                Some(ref o) if allowed_origins.iter().any(|allowed| o.eq_ignore_ascii_case(allowed)) => {
                    format!("Access-Control-Allow-Origin: {}\r\n", o)
                }
                _ => String::new(),
            };

            if req.starts_with("GET /api/fingerprint") {
                let fp_json = {
                    let fp = hub_clone.fingerprint.lock().unwrap();
                    serde_json::to_string(&*fp).unwrap()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: application/json\r\n\
                     {}Access-Control-Allow-Methods: GET, OPTIONS\r\n\
                     Access-Control-Allow-Headers: *\r\n\
                     Content-Length: {}\r\n\
                     Connection: close\r\n\r\n\
                     {}",
                    cors_origin,
                    fp_json.len(),
                    fp_json
                );
                let _ = socket.write_all(response.as_bytes()).await;
            } else if req.starts_with("OPTIONS ") {
                let response = format!(
                    "HTTP/1.1 204 No Content\r\n\
                     {}Access-Control-Allow-Methods: GET, OPTIONS\r\n\
                     Access-Control-Allow-Headers: *\r\n\
                     Connection: close\r\n\r\n",
                     cors_origin
                );
                let _ = socket.write_all(response.as_bytes()).await;
            } else {
                let response = "HTTP/1.1 404 No Found\r\n\
                                Connection: close\r\n\r\n";
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
    }
}
