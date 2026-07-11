use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use yrs::{
    encoding::write::Write,
    updates::decoder::Decode,
    updates::encoder::{Encoder, EncoderV1},
    Doc, StateVector, Transact, Update,
    ReadTxn,
};
use wtransport::{Connection, Endpoint as WtEndpoint, Identity, ServerConfig};
use iroh::{Endpoint as IrohEndpoint, EndpointAddr, PublicKey, RelayMap, RelayUrl, SecretKey};
use iroh::endpoint::presets::Minimal;

mod chia_lane;

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
    /// Carrying the sender's Iroh Node ID so peers know how to back-dial
    pub iroh_node_id: Option<String>,
    pub iroh_relay_urls: Option<Vec<String>>,
    pub iroh_direct_addrs: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Fingerprint {
    pub hex: String,
    pub base64: String,
    pub port: u16,
    pub iroh_node_id: String, // expose our Iroh Node ID to the browser client!
    pub iroh_relay_urls: Vec<String>,
    pub iroh_direct_addrs: Vec<String>,
}

// Global server state
pub struct Room {
    pub doc: Doc,
    pub local_connections: HashMap<SocketAddr, Connection>,
    pub remote_peers: HashMap<PublicKey, iroh::endpoint::Connection>,
}

pub struct HubState {
    pub rooms: Mutex<HashMap<String, Room>>,
    pub fingerprint: Mutex<Fingerprint>,
    pub port: u16,
    pub configured_relays: Vec<String>,
    /// Relay dedup (0.18.0 hub-relay): envelopes seen/forwarded recently, keyed by
    /// blake3(origin_node_id ‖ seq ‖ payload). Prevents echo storms once meshes form.
    pub seen_envelopes: Mutex<SeenCache>,
}

/// Bounded recently-seen set for relay loop protection.
pub struct SeenCache {
    set: std::collections::HashSet<[u8; 16]>,
    order: std::collections::VecDeque<[u8; 16]>,
}

impl SeenCache {
    pub fn new() -> Self {
        Self { set: std::collections::HashSet::new(), order: std::collections::VecDeque::new() }
    }
    /// Returns true if this key is fresh (and records it); false if already seen.
    pub fn check_and_insert(&mut self, key: [u8; 16]) -> bool {
        if self.set.contains(&key) {
            return false;
        }
        self.set.insert(key);
        self.order.push_back(key);
        while self.order.len() > 4096 {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

/// Relay-dedup key: origin identity + sequence + payload bytes.
fn envelope_seen_key(origin_node_id: &str, seq: u32, payload: &[u8]) -> [u8; 16] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(origin_node_id.as_bytes());
    hasher.update(&seq.to_le_bytes());
    hasher.update(payload);
    let hash = hasher.finalize();
    let mut key = [0u8; 16];
    key.copy_from_slice(&hash.as_bytes()[..16]);
    key
}

pub type SharedHub = Arc<HubState>;

pub fn compute_fingerprint(
    identity: &Identity,
    port: u16,
    iroh_node_id: &str,
    iroh_relay_urls: Vec<String>,
    iroh_direct_addrs: Vec<String>,
) -> Result<Fingerprint> {
    let chain = identity.certificate_chain();
    let certs = chain.as_slice();
    if certs.is_empty() {
        return Err(anyhow!("No certs in chain"));
    }
    let digest = certs[0].hash();
    let result: &[u8; 32] = digest.as_ref();
    let hex = hex::encode(result);
    let base64 = base64::Engine::encode(&base64::prelude::BASE64_STANDARD, result);
    Ok(Fingerprint {
        hex,
        base64,
        port,
        iroh_node_id: iroh_node_id.to_string(),
        iroh_relay_urls,
        iroh_direct_addrs,
    })
}

fn load_configured_relays_from_env() -> Vec<String> {
    let Some(raw) = std::env::var("SSF_RELAYS").ok() else {
        return Vec::new();
    };

    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn load_or_create_secret_key() -> Result<SecretKey> {
    let key_path = std::path::Path::new("iroh_node_id.key");
    if key_path.exists() {
        let bytes = std::fs::read(key_path)?;
        if bytes.len() == 32 {
            let arr: [u8; 32] = bytes.try_into().map_err(|_| anyhow!("Invalid key format"))?;
            return Ok(SecretKey::from_bytes(&arr));
        }
    }
    let sk = SecretKey::generate();
    std::fs::write(key_path, sk.to_bytes())?;
    Ok(sk)
}

/// Default public-IPv4 echo services for `SSF_EXTERNAL_ADDRS=auto` — queried
/// over plain HTTP/1.0. The response is only our own public IP: nothing secret
/// leaves the machine, and a poisoned answer can at worst add one dead dial
/// hint (iroh connections are authenticated by node key regardless).
/// Operators can substitute their own echo with `SSF_IP_ECHO=host1,host2`.
/// Never contacted unless an `auto` entry is explicitly configured — the node
/// makes no third-party calls by default (sovereignty posture, v006 §10.2).
const DEFAULT_IP_ECHO_HOSTS: &[&str] = &["api.ipify.org", "checkip.amazonaws.com"];
/// How often `auto` re-checks the public IP (ISP rotations heal within this).
const AUTO_ADDR_RECHECK_SECS: u64 = 300;

/// True when the address is usable as an internet-facing dial hint — rejects
/// private/loopback/link-local/documentation ranges and CGNAT (100.64.0.0/10),
/// where a home-router port-forward cannot produce inbound reachability.
fn ipv4_is_public(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    let cgnat = o[0] == 100 && (o[1] & 0b1100_0000) == 64; // 100.64.0.0/10
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || cgnat)
}

/// Resolves the current public IPv4 via the first echo service that answers
/// with a public address. Tries `SSF_IP_ECHO` hosts (comma-separated) if set,
/// else the defaults; 10 s timeout per host.
async fn discover_public_ipv4() -> Result<std::net::Ipv4Addr> {
    let hosts_env = std::env::var("SSF_IP_ECHO").ok();
    let hosts: Vec<&str> = match hosts_env.as_deref() {
        Some(raw) => raw.split(',').map(str::trim).filter(|s| !s.is_empty()).collect(),
        None => DEFAULT_IP_ECHO_HOSTS.to_vec(),
    };
    let mut last_err = anyhow!("no IP echo services configured");
    for host in hosts {
        match tokio::time::timeout(std::time::Duration::from_secs(10), query_ip_echo(host)).await {
            Ok(Ok(ip)) if ipv4_is_public(ip) => return Ok(ip),
            Ok(Ok(ip)) => {
                last_err = anyhow!("{host} reports non-public address {ip} — this looks like CGNAT/private WAN; a router port-forward cannot make you reachable from there")
            }
            Ok(Err(e)) => last_err = e,
            Err(_) => last_err = anyhow!("{host}: timed out"),
        }
    }
    Err(last_err)
}

/// Minimal plain-HTTP/1.0 GET returning the echoed IPv4 body (bounded read;
/// HTTP/1.0 + Connection: close sidesteps chunked encoding entirely).
async fn query_ip_echo(host: &str) -> Result<std::net::Ipv4Addr> {
    let mut stream = tokio::net::TcpStream::connect((host, 80)).await?;
    let req = format!("GET / HTTP/1.0\r\nHost: {host}\r\nUser-Agent: ssf-p2p-node\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await?;
    let mut resp = Vec::with_capacity(512);
    let mut limited = stream.take(4096);
    limited.read_to_end(&mut resp).await?;
    let text = String::from_utf8_lossy(&resp);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow!("{host}: malformed HTTP response"))?;
    let status_ok = head.lines().next().map(|l| l.contains(" 200 ")).unwrap_or(false);
    if !status_ok {
        return Err(anyhow!("{host}: non-200 echo response"));
    }
    body.trim()
        .parse::<std::net::Ipv4Addr>()
        .map_err(|e| anyhow!("{host}: echo body is not an IPv4 address: {e}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    println!("🪐 StarStation Furlong — Standalone P2P Swarm Node");
    println!("📡 Initializing real-time networks...");

    // First load or generate persistent SecretKey (C1 fix)
    let secret_key = load_or_create_secret_key()?;
    let iroh_id = secret_key.public();
    println!("🔑 Unified Iroh Swarm ID (YOUR DIAL KEY): {}", iroh_id);

    // Build Endpoint incorporating ALPN "ssf" (B3 fix) and persistent SecretKey (C1 fix)
    let mut builder = IrohEndpoint::builder(Minimal)
        .secret_key(secret_key.clone())
        .alpns(vec![b"ssf".to_vec()]); // Ensure B3 is resolved so we do not reject inbound ALPN

    // Configure relay map from SSF_RELAYS (comma-separated URLs).
    // Placeholder defaults are intentionally removed: operators provide real relays.
    let configured_relays = load_configured_relays_from_env();
    if !configured_relays.is_empty() {
            let relay_map = RelayMap::try_from_iter(configured_relays.iter().map(String::as_str))?;
         builder = builder.relay_mode(iroh::endpoint::RelayMode::Custom(relay_map));
         println!("🌐 SSF_RELAYS configured ({} relay URL(s))", configured_relays.len());
    } else {
         println!("🌐 SSF_RELAYS not set; no default relay URLs loaded.");
    }

    // 🕳️ Mainline DHT address lookup — sovereign zero-server discovery.
    // Publishes our ed25519-signed addresses to the BitTorrent Mainline DHT and
    // resolves remote node IDs the same way: no DNS, no registration, no n0 infra.
    // AddrFilter::unfiltered is REQUIRED: the default (relay_only) would publish
    // nothing at all in our relay-less posture.
    if std::env::var("SSF_NO_DHT").ok().as_deref() == Some("1") {
        println!("🕳️ Mainline DHT lookup DISABLED (SSF_NO_DHT=1)");
    } else {
        match iroh_mainline_address_lookup::DhtAddressLookup::builder()
            .secret_key(secret_key.clone())
            .addr_filter(iroh::endpoint_info::AddrFilter::unfiltered())
            .build()
        {
            Ok(dht) => {
                builder = builder.address_lookup(dht);
                println!("🕳️ Mainline DHT lookup ENABLED — publishing + resolving via BitTorrent Mainline (set SSF_NO_DHT=1 to disable)");
            }
            Err(e) => {
                eprintln!("⚠️ Mainline DHT init failed (continuing without DHT): {e}");
            }
        }
    }

    // 📌 Reachability rung 3 (§4.1.2), promoted in 0.19.0: the iroh UDP port is
    // PINNED BY DEFAULT to 44442 (IANA-unassigned for TCP+UDP, verified
    // 2026-07-10) so router port-forwards, firewall rules, and invite hints
    // survive restarts with zero configuration. SSF_IROH_PORT=<port> overrides
    // the pin; SSF_IROH_PORT=0 restores the pre-0.19.0 random per-launch bind.
    // IPv6 keeps its default bind either way.
    const DEFAULT_IROH_PORT: u16 = 44442;
    let (pinned_port, is_default_pin) = match std::env::var("SSF_IROH_PORT") {
        Ok(raw) => match raw.trim().parse::<u16>() {
            Ok(0) => (None, false),
            Ok(port) => (Some(port), false),
            Err(_) => {
                eprintln!("⚠️ Invalid SSF_IROH_PORT '{raw}' (want 0-65535); using default pin {DEFAULT_IROH_PORT}");
                (Some(DEFAULT_IROH_PORT), true)
            }
        },
        Err(_) => (Some(DEFAULT_IROH_PORT), true),
    };
    match pinned_port {
        Some(port) => {
            // Probe availability first so an auto-spawned node degrades to a
            // random port instead of dying when a foreign process already owns
            // the default port. An EXPLICIT pin still fails loudly.
            match std::net::UdpSocket::bind(("0.0.0.0", port)) {
                Ok(probe) => {
                    drop(probe);
                    builder = builder
                        .bind_addr(format!("0.0.0.0:{port}"))
                        .map_err(|e| anyhow!("Invalid iroh bind address 0.0.0.0:{port}: {e:?}"))?;
                    let origin = if is_default_pin { "default" } else { "SSF_IROH_PORT" };
                    println!("📌 iroh IPv4 socket pinned to UDP {port} ({origin}) — forward UDP {port} on your router for direct reachability");
                }
                Err(e) if is_default_pin => {
                    eprintln!("⚠️ Default iroh port UDP {DEFAULT_IROH_PORT} is unavailable ({e}); falling back to a random per-launch port — direct dials then need SSF_IROH_PORT + a matching forward, or the other reachability rungs");
                }
                Err(e) => {
                    return Err(anyhow!("SSF_IROH_PORT={port} requested but UDP {port} is unavailable: {e}"));
                }
            }
        }
        None => println!("📌 SSF_IROH_PORT=0 — iroh IPv4 socket uses a random per-launch port (not manually forwardable)"),
    }

    // 📌 Manually-known public addresses (e.g. after a router port-forward):
    // advertised to peers, used in NAT traversal, and flow into invite hints + DHT.
    // `auto` / `auto:<port>` entries resolve the CURRENT public IPv4 via an HTTP
    // echo (opt-in; SSF_IP_ECHO overrides the service list) and re-check every
    // 5 minutes — dynamic-IP rotations heal live, no restart, no stale invites.
    let mut auto_ports: Vec<Option<u16>> = Vec::new();
    if let Ok(raw) = std::env::var("SSF_EXTERNAL_ADDRS") {
        for entry in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let lower = entry.to_ascii_lowercase();
            if lower == "auto" {
                auto_ports.push(None);
            } else if let Some(port_str) = lower.strip_prefix("auto:") {
                match port_str.parse::<u16>() {
                    Ok(p) if p > 0 => auto_ports.push(Some(p)),
                    _ => eprintln!("⚠️ Ignoring invalid SSF_EXTERNAL_ADDRS entry '{entry}' (want auto:<1-65535>)"),
                }
            } else {
                match entry.parse::<SocketAddr>() {
                    Ok(sock) => {
                        builder = builder.external_addr(sock);
                        println!("📌 External address advertised: {sock}");
                    }
                    Err(e) => eprintln!("⚠️ Ignoring invalid SSF_EXTERNAL_ADDRS entry '{entry}': {e:?}"),
                }
            }
        }
    }

    let iroh_endpoint = builder.bind().await?;
    println!("   Bound Sockets: {:?}", iroh_endpoint.bound_sockets());

    // 🔄 Dynamic public-IP advertising (SSF_EXTERNAL_ADDRS=auto[:port]): resolve
    // now, then re-check every AUTO_ADDR_RECHECK_SECS. On ISP rotation the stale
    // address is swapped LIVE via Endpoint::{add,remove}_external_addr — the DHT
    // record and freshly-minted invite hints follow automatically. Invites are
    // durable across IP changes anyway (room key + node ID; DHT re-resolves).
    if !auto_ports.is_empty() {
        let bound_v4_port = iroh_endpoint
            .bound_sockets()
            .iter()
            .find(|s| s.is_ipv4())
            .map(|s| s.port())
            .unwrap_or(DEFAULT_IROH_PORT);
        for port_override in auto_ports {
            let port = port_override.unwrap_or(bound_v4_port);
            let ep = iroh_endpoint.clone();
            tokio::spawn(async move {
                let mut announced: Option<SocketAddr> = None;
                loop {
                    match discover_public_ipv4().await {
                        Ok(ip) => {
                            let addr = SocketAddr::from((ip, port));
                            if announced != Some(addr) {
                                if let Some(old) = announced.take() {
                                    let _ = ep.remove_external_addr(&old).await;
                                    println!("🔄 Public IP changed — un-advertised stale external address {old}");
                                }
                                ep.add_external_addr(addr).await;
                                announced = Some(addr);
                                println!("📌 External address advertised (auto): {addr} — re-checked every {AUTO_ADDR_RECHECK_SECS}s; router must forward UDP {port} here");
                            }
                        }
                        Err(e) => eprintln!("⚠️ Public-IP auto-discovery failed (will retry in {AUTO_ADDR_RECHECK_SECS}s): {e}"),
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(AUTO_ADDR_RECHECK_SECS)).await;
                }
            });
        }
    }

    // 📡 mDNS same-LAN lookup: a bare room key + node id resolves on the local
    // network with zero hints, zero internet, zero servers (plan §4.5 lane 3).
    if std::env::var("SSF_NO_MDNS").ok().as_deref() == Some("1") {
        println!("📡 mDNS LAN lookup DISABLED (SSF_NO_MDNS=1)");
    } else {
        match iroh_mdns_address_lookup::MdnsAddressLookup::builder().build(iroh_endpoint.id()) {
            Ok(mdns) => match iroh_endpoint.address_lookup() {
                Ok(services) => {
                    services.add(mdns);
                    println!("📡 mDNS LAN lookup ENABLED — same-network peers resolve bare keys (set SSF_NO_MDNS=1 to disable)");
                }
                Err(e) => eprintln!("⚠️ mDNS init skipped: address-lookup services unavailable: {e:?}"),
            },
            Err(e) => eprintln!("⚠️ mDNS LAN lookup init failed (continuing without): {e:?}"),
        }
    }

    // Invite hints must be DIALABLE addresses, not bind addresses (🐛 fix 2026-07-08):
    // bound_sockets() yields the bind address (0.0.0.0:<port> — unspecified, useless to
    // a remote dialer). endpoint.addr() carries iroh's own view of reachable interface
    // (and later relay/observed) addresses — filter any unspecified leftovers.
    let iroh_direct_addrs: Vec<String> = iroh_endpoint
        .addr()
        .ip_addrs()
        .filter(|sock| !sock.ip().is_unspecified())
        .map(|sock| sock.to_string())
        .collect();
    println!("   Advertised direct-addr hints: {:?}", iroh_direct_addrs);

    // ⛓️ ChiaHub lane scaffold (C0): crypto self-test + status when SSF_CHIA_LANE=1.
    chia_lane::startup_status(&secret_key, &iroh_direct_addrs);

    // 2. Start WebTransport Server for local browser tab GUI connections
    let listen_port = 4443;
    let identity = Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|e| anyhow!("Failed to generate self-signed identity: {:?}", e))?;
    
    let fingerprint = compute_fingerprint(
        &identity,
        listen_port,
        &iroh_id.to_string(),
        configured_relays.clone(),
        iroh_direct_addrs,
    )?;
    
    let addr = SocketAddr::from(([0, 0, 0, 0], listen_port));
    let wt_config = ServerConfig::builder()
        .with_bind_address(addr)
        .with_identity(identity)
        .build();

    let wt_endpoint = WtEndpoint::server(wt_config)
        .map_err(|e| anyhow!("Failed to bind wtransport server: {:?}", e))?;

    let hub = Arc::new(HubState {
        rooms: Mutex::new(HashMap::new()),
        fingerprint: Mutex::new(fingerprint),
        port: listen_port,
        configured_relays,
        seen_envelopes: Mutex::new(SeenCache::new()),
    });

    // Start background HTTP API for local certificate fingerprint requests.
    // The endpoint handle lets each request refresh direct-addr hints LIVE —
    // portmapper mappings, QAD-observed and external addresses appear minutes
    // after startup and must reach invites (🐛 0.16.0: hints were a stale
    // startup snapshot, so port-mapped public addresses never made it out).
    let hub_http = hub.clone();
    let iroh_http = iroh_endpoint.clone();
    tokio::spawn(async move {
        start_http_api_server(hub_http, iroh_http).await;
    });

    // Start background Iroh Inbound connection acceptance loop
    let hub_iroh = hub.clone();
    let iroh_clone = iroh_endpoint.clone();
    tokio::spawn(async move {
        if let Err(e) = run_iroh_listener(hub_iroh, iroh_clone).await {
            eprintln!("⚠️ Iroh listener closed with error: {:?}", e);
        }
    });

    // Start WebTransport listener
    println!("🌌 WebTransport active, awaiting local tab on port {}", listen_port);
    if let Err(e) = run_wt_listener(hub, wt_endpoint, iroh_endpoint).await {
        eprintln!("⚠️ WebTransport server error: {:?}", e);
    }

    Ok(())
}

async fn run_wt_listener(
    hub: SharedHub,
    endpoint: WtEndpoint<wtransport::endpoint::endpoint_side::Server>,
    iroh_ep: IrohEndpoint,
) -> Result<()> {
    loop {
        let incoming = endpoint.accept().await;
        let request = incoming.await?;
        let connection = request.accept().await?;
        let remote_addr = connection.remote_address();
        println!("🤝 Local browser session secured from {}", remote_addr);

        let hub_clone = hub.clone();
        let iroh_clone = iroh_ep.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_wt_connection(hub_clone, connection, iroh_clone).await {
                eprintln!("⚠️ Local peer connection closed with error ({}): {:?}", remote_addr, e);
            }
        });
    }
}

async fn handle_wt_connection(
    hub: SharedHub,
    connection: Connection,
    iroh_ep: IrohEndpoint,
) -> Result<()> {
    let remote_addr = connection.remote_address();
    let chosen_room: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    loop {
        tokio::select! {
            // UDP Datagram movement ticks routing over Iroh direct addresses
            dg = connection.receive_datagram() => {
                let datagram = dg?;
                if datagram.len() == 13 {
                    let room_id_snapshot = chosen_room.lock().unwrap().clone();
                    if let Some(ref room_id) = room_id_snapshot {
                        let rooms = hub.rooms.lock().unwrap();
                        if let Some(room) = rooms.get(room_id) {
                            // Local clients
                            for (&addr, peer_conn) in &room.local_connections {
                                if addr != remote_addr {
                                    let _ = peer_conn.send_datagram(&*datagram);
                                }
                            }
                            // Forward movement datagram ticks to remote Iroh peers! (v006 §8.1)
                            // 0.18.0 wire: node→node ticks carry a leading hop byte (0 = origin
                            // node) so relaying nodes can forward once without echo loops.
                            for (_, iroh_conn) in &room.remote_peers {
                                let mut relayed = Vec::with_capacity(1 + datagram.len());
                                relayed.push(0u8);
                                relayed.extend_from_slice(&datagram);
                                let _ = iroh_conn.send_datagram(relayed.into());
                            }
                        }
                    }
                } else if datagram.starts_with(b"ping") {
                    let _ = connection.send_datagram(b"pong");
                }
            }
            // Bidirectional synchronisation streams
            stream = connection.accept_bi() => {
                let (mut send, mut recv) = stream?;
                let hub_clone = hub.clone();
                let remote_addr_inner = remote_addr;
                let mut room_id_inner = chosen_room.lock().unwrap().clone();
                let connection_clone = connection.clone();
                let chosen_room_inner = chosen_room.clone();
                let iroh_clone = iroh_ep.clone();
                
                tokio::spawn(async move {
                    let mut length_buf = [0u8; 4];
                    loop {
                        if let Err(_) = recv.read_exact(&mut length_buf).await {
                            break;
                        }
                        let len = u32::from_le_bytes(length_buf) as usize;
                        let mut payload_buf = vec![0u8; len];
                        if let Err(_) = recv.read_exact(&mut payload_buf).await {
                            break;
                        }

                        let envelope: SsfEnvelope = match serde_json::from_slice(&payload_buf) {
                            Ok(env) => env,
                            _ => break,
                        };

                        if room_id_inner.is_none() {
                            room_id_inner = Some(envelope.room.clone());
                            *chosen_room_inner.lock().unwrap() = room_id_inner.clone();
                            let mut rooms = hub_clone.rooms.lock().unwrap();
                            let room = rooms.entry(envelope.room.clone()).or_insert_with(|| {
                                println!("🎨 Registering new room document: {}", envelope.room);
                                Room {
                                    doc: Doc::new(),
                                    local_connections: HashMap::new(),
                                    remote_peers: HashMap::new(),
                                }
                            });
                            room.local_connections.insert(remote_addr_inner, connection_clone.clone());
                        }

                        // Check if the envelope carries a new peer's Iroh ID to dial back
                        if let Some(ref target_node_id_str) = envelope.iroh_node_id {
                            if let Ok(target_pub_key) = target_node_id_str.parse::<PublicKey>() {
                                let needs_dial = {
                                    let rooms = hub_clone.rooms.lock().unwrap();
                                    rooms
                                        .get(&envelope.room)
                                        .map(|room| !room.remote_peers.contains_key(&target_pub_key))
                                        .unwrap_or(false)
                                };

                                if needs_dial {
                                    println!("📡 Dispatching Iroh Dial to remote peer key: {}", target_node_id_str);
                                    let _ = write_bridge_status(
                                        &mut send,
                                        &envelope.room,
                                        target_node_id_str,
                                        "dialing",
                                        None,
                                    )
                                    .await;
                                    let fallback_relays = hub_clone.configured_relays.clone();
                                    let relay_hints = envelope
                                        .iroh_relay_urls
                                        .clone()
                                        .filter(|hints| !hints.is_empty())
                                        .unwrap_or(fallback_relays);
                                    let direct_hints = envelope
                                        .iroh_direct_addrs
                                        .clone()
                                        .unwrap_or_default();

                                    let mut addr = EndpointAddr::new(target_pub_key);
                                    for relay_url_str in relay_hints {
                                        match relay_url_str.parse::<RelayUrl>() {
                                            Ok(relay_url) => {
                                                addr = addr.with_relay_url(relay_url);
                                            }
                                            Err(e) => {
                                                eprintln!("⚠️ Ignoring invalid relay hint '{}': {:?}", relay_url_str, e);
                                            }
                                        }
                                    }
                                    for direct_addr_str in direct_hints {
                                        match direct_addr_str.parse::<SocketAddr>() {
                                            Ok(socket_addr) => {
                                                addr = addr.with_ip_addr(socket_addr);
                                            }
                                            Err(e) => {
                                                eprintln!("⚠️ Ignoring invalid direct hint '{}': {:?}", direct_addr_str, e);
                                            }
                                        }
                                    }

                                    match iroh_clone.connect(addr, b"ssf").await {
                                        Ok(iroh_conn) => {
                                            println!("🎯 Iroh connection secured back to peer node!");
                                            let _ = write_bridge_status(
                                                &mut send,
                                                &envelope.room,
                                                target_node_id_str,
                                                "connected",
                                                None,
                                            )
                                            .await;
                                            {
                                                let mut rooms = hub_clone.rooms.lock().unwrap();
                                                if let Some(room) = rooms.get_mut(&envelope.room) {
                                                    room.remote_peers.insert(target_pub_key, iroh_conn.clone());
                                                }
                                            }
                                            // Handle bidirectional read/write loop symmetrically for outbound connections (B4 fix):
                                            let hub_outbound = hub_clone.clone();
                                            let iroh_outbound = iroh_clone.clone();
                                            let conn_outbound = iroh_conn.clone();
                                            tokio::spawn(async move {
                                                if let Err(e) = handle_iroh_connection(hub_outbound, conn_outbound, iroh_outbound).await {
                                                    eprintln!("⚠️ Outbound P2P peer loop closed: {:?}", e);
                                                }
                                            });
                                        }
                                        Err(e) => {
                                            eprintln!("⚠️ Failed dialing peer node {}: {:?}", target_node_id_str, e);
                                            let _ = write_bridge_status(
                                                &mut send,
                                                &envelope.room,
                                                target_node_id_str,
                                                "failed",
                                                Some(&format!("{e:?}")),
                                            )
                                            .await;
                                        }
                                    }
                                }
                            }
                        }

                        // Relayer/Bridge Pipeline: Forward stream updates over Iroh P2P to remote peers
                        let room_id = room_id_inner.as_ref().unwrap();
                        let peers: Vec<iroh::endpoint::Connection> = {
                            let rooms = hub_clone.rooms.lock().unwrap();
                            rooms.get(room_id).map(|r| r.remote_peers.values().cloned().collect()).unwrap_or_default()
                        };
                        let local_direct_hints = {
                            let fp = hub_clone.fingerprint.lock().unwrap();
                            fp.iroh_direct_addrs.clone()
                        };
                        let local_relay_hints = hub_clone.configured_relays.clone();

                        // Record browser-originated envelopes in the relay-dedup cache so a
                        // mesh echo can never re-enter this node as "new" (0.18.0 hub relay).
                        let self_id_str = iroh_clone.id().to_string();
                        {
                            let key = envelope_seen_key(&self_id_str, envelope.seq, &envelope.payload);
                            hub_clone.seen_envelopes.lock().unwrap().check_and_insert(key);
                        }

                        for peer_conn in peers {
                            let mut env_copy = envelope.clone();
                            // Append our own node ID to make tracking back-and-forth handshakes seamless
                            env_copy.iroh_node_id = Some(self_id_str.clone());
                            env_copy.iroh_relay_urls = if local_relay_hints.is_empty() {
                                None
                            } else {
                                Some(local_relay_hints.clone())
                            };
                            env_copy.iroh_direct_addrs = if local_direct_hints.is_empty() {
                                None
                            } else {
                                Some(local_direct_hints.clone())
                            };
                            let payload_bytes = serde_json::to_vec(&env_copy).unwrap();
                            let l_bytes = (payload_bytes.len() as u32).to_le_bytes();

                            tokio::spawn(async move {
                                if let Ok((mut send_stream, _recv_stream)) = peer_conn.open_bi().await {
                                    let _ = send_stream.write_all(&l_bytes).await;
                                    let _ = send_stream.write_all(&payload_bytes).await;
                                }
                            });
                        }

                        // Merge locally
                        if envelope.kind == "ysync" {
                            let _ = handle_ysync_message(&hub_clone, room_id, &envelope, &mut send).await;
                        }
                    }
                });
            }
        }
    }
}

async fn run_iroh_listener(hub: SharedHub, endpoint: IrohEndpoint) -> Result<()> {
    println!("🔑 Unified Iroh Swarm listener online!");
    loop {
        let incoming = endpoint.accept().await;
        let incoming_conn = match incoming {
            Some(inc) => inc,
            None => continue,
        };

        let accepting = incoming_conn.accept()?;
        let connection = accepting.await?;
        let remote_id = connection.remote_id();
        println!("🚀 Inbound P2P Swarm handshake from peer: {}", remote_id);

        let hub_clone = hub.clone();
        let iroh_clone = endpoint.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_iroh_connection(hub_clone, connection, iroh_clone).await {
                eprintln!("⚠️ Swarm connection error with peer ({}): {:?}", remote_id, e);
            }
        });
    }
}

/// Handles one node↔node iroh connection. Returns a BOXED future because the
/// gossip mesh-upgrade path spawns this function recursively — a plain
/// `async fn` cannot name its own future type (E0283 cycle).
fn handle_iroh_connection(
    hub: SharedHub,
    connection: iroh::endpoint::Connection,
    iroh_ep: IrohEndpoint,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
    Box::pin(async move {
    let remote_id = connection.remote_id();
    let self_id = iroh_ep.id();
    let chosen_room: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    loop {
        tokio::select! {
            // Unreliable Datagram lane routing incoming ticks directly to browser WebTransport
            dg = connection.read_datagram() => {
                let datagram = dg?;
                // 14B = 0.18.0 hop-flagged node→node tick; 13B = legacy 0.17.0 peer tick.
                let (tick, hop) = if datagram.len() == 14 {
                    (&datagram[1..], Some(datagram[0]))
                } else if datagram.len() == 13 {
                    (&datagram[..], None)
                } else {
                    (&datagram[..0], None)
                };
                if tick.len() == 13 {
                    let room_id_snapshot = chosen_room.lock().unwrap().clone();
                    if let Some(ref room_id) = room_id_snapshot {
                        let rooms = hub.rooms.lock().unwrap();
                        if let Some(room) = rooms.get(room_id) {
                            // Down to local browser tabs (always 13B on that leg)
                            for (_, wt_conn) in &room.local_connections {
                                let _ = wt_conn.send_datagram(tick);
                            }
                            // 🌐 Hub relay (0.18.0): first-hop ticks fan out ONCE to the
                            // room's other remote peers so spokes see each other through
                            // a reachable member. hop=1 ticks are never re-relayed.
                            if hop == Some(0) {
                                let mut relayed = Vec::with_capacity(14);
                                relayed.push(1u8);
                                relayed.extend_from_slice(tick);
                                for (peer_id, iroh_conn) in &room.remote_peers {
                                    if *peer_id != remote_id {
                                        let _ = iroh_conn.send_datagram(relayed.clone().into());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Multi-channel streams incoming from remote Iroh peers
            stream = connection.accept_bi() => {
                let (mut _send, mut recv) = stream?;
                let hub_clone = hub.clone();
                let mut room_id_inner = chosen_room.lock().unwrap().clone();
                let connection_clone = connection.clone();
                let chosen_room_inner = chosen_room.clone();
                let iroh_clone = iroh_ep.clone();
                let self_id_inner = self_id;
                
                tokio::spawn(async move {
                    let mut length_buf = [0u8; 4];
                    loop {
                        if let Err(_) = recv.read_exact(&mut length_buf).await {
                            break;
                        }
                        let len = u32::from_le_bytes(length_buf) as usize;
                        let mut payload_buf = vec![0u8; len];
                        if let Err(_) = recv.read_exact(&mut payload_buf).await {
                            break;
                        }

                        let envelope: SsfEnvelope = match serde_json::from_slice(&payload_buf) {
                            Ok(env) => env,
                            _ => break,
                        };

                        if room_id_inner.is_none() {
                            room_id_inner = Some(envelope.room.clone());
                            *chosen_room_inner.lock().unwrap() = room_id_inner.clone();
                            let mut rooms = hub_clone.rooms.lock().unwrap();
                            let room = rooms.entry(envelope.room.clone()).or_insert_with(|| {
                                Room {
                                    doc: Doc::new(),
                                    local_connections: HashMap::new(),
                                    remote_peers: HashMap::new(),
                                }
                            });
                            room.remote_peers.insert(remote_id, connection_clone.clone());
                        }

                        // 🌐 Relay-dedup gate (0.18.0): drop envelopes we've already seen so
                        // hub relaying can never echo-storm once meshes form. The origin
                        // identity travels in iroh_node_id (stamped by the origin node).
                        let origin_id_str = envelope
                            .iroh_node_id
                            .clone()
                            .unwrap_or_else(|| remote_id.to_string());
                        {
                            let key = envelope_seen_key(&origin_id_str, envelope.seq, &envelope.payload);
                            if !hub_clone.seen_envelopes.lock().unwrap().check_and_insert(key) {
                                continue;
                            }
                        }

                        let room_id = room_id_inner.as_ref().unwrap();

                        // 📇 Membership gossip (0.18.0): a relayed envelope may introduce a
                        // THIRD party (origin ≠ the peer this connection belongs to). Learn it
                        // and, if the smaller-id rule elects us, dial it directly with the
                        // envelope's hints — star upgrades toward mesh where physics allow.
                        if let Ok(origin_key) = origin_id_str.parse::<PublicKey>() {
                            if origin_key != self_id_inner && origin_key != remote_id {
                                let already_connected = {
                                    let rooms = hub_clone.rooms.lock().unwrap();
                                    rooms
                                        .get(room_id)
                                        .map(|room| room.remote_peers.contains_key(&origin_key))
                                        .unwrap_or(true)
                                };
                                // Smaller node id dials — halves duplicate cross-dials.
                                if !already_connected && self_id_inner.as_bytes() < origin_key.as_bytes() {
                                    println!("📇 Gossip-learned peer {} — attempting mesh upgrade dial", origin_id_str);
                                    broadcast_bridge_status(&hub_clone, room_id, &origin_id_str, "dialing", Some("gossip mesh upgrade")).await;
                                    let mut addr = EndpointAddr::new(origin_key);
                                    for relay_url_str in envelope.iroh_relay_urls.clone().unwrap_or_default() {
                                        if let Ok(relay_url) = relay_url_str.parse::<RelayUrl>() {
                                            addr = addr.with_relay_url(relay_url);
                                        }
                                    }
                                    for direct_addr_str in envelope.iroh_direct_addrs.clone().unwrap_or_default() {
                                        if let Ok(socket_addr) = direct_addr_str.parse::<SocketAddr>() {
                                            addr = addr.with_ip_addr(socket_addr);
                                        }
                                    }
                                    match iroh_clone.connect(addr, b"ssf").await {
                                        Ok(iroh_conn) => {
                                            println!("🕸️ Mesh upgrade: direct link to gossip-learned peer {}", origin_id_str);
                                            broadcast_bridge_status(&hub_clone, room_id, &origin_id_str, "connected", Some("mesh upgrade")).await;
                                            {
                                                let mut rooms = hub_clone.rooms.lock().unwrap();
                                                if let Some(room) = rooms.get_mut(room_id) {
                                                    room.remote_peers.insert(origin_key, iroh_conn.clone());
                                                }
                                            }
                                            let hub_outbound = hub_clone.clone();
                                            let iroh_outbound = iroh_clone.clone();
                                            let conn_outbound = iroh_conn.clone();
                                            tokio::spawn(async move {
                                                if let Err(e) = handle_iroh_connection(hub_outbound, conn_outbound, iroh_outbound).await {
                                                    eprintln!("⚠️ Mesh peer loop closed: {:?}", e);
                                                }
                                            });
                                        }
                                        Err(e) => {
                                            // Expected when the peer is unreachable from here —
                                            // the hub keeps relaying; not an error condition.
                                            println!("🕸️ Mesh upgrade dial to {} failed ({e:?}); staying hub-relayed", origin_id_str);
                                        }
                                    }
                                }
                            }
                        }

                        // Relayer/Bridge Pipeline: Forward stream updates down to local browser tab
                        let clients: Vec<Connection> = {
                            let rooms = hub_clone.rooms.lock().unwrap();
                            rooms.get(room_id).map(|r| r.local_connections.values().cloned().collect()).unwrap_or_default()
                        };

                        for wt_conn in clients {
                            let payload_bytes = serde_json::to_vec(&envelope).unwrap();
                            let l_bytes = (payload_bytes.len() as u32).to_le_bytes();

                            tokio::spawn(async move {
                                if let Ok(opening) = wt_conn.open_bi().await {
                                    if let Ok((mut send_stream, _recv_stream)) = opening.await {
                                        let _ = send_stream.write_all(&l_bytes).await;
                                        let _ = send_stream.write_all(&payload_bytes).await;
                                    }
                                }
                            });
                        }

                        // 🌐 Hub relay (0.18.0): forward to the room's OTHER remote peers so
                        // spokes see each other through a reachable member. The envelope is
                        // relayed UNCHANGED — the origin's identity and dial hints survive
                        // (that's the membership gossip). Dedup above stops echo loops.
                        let relay_targets: Vec<(PublicKey, iroh::endpoint::Connection)> = {
                            let rooms = hub_clone.rooms.lock().unwrap();
                            rooms
                                .get(room_id)
                                .map(|r| {
                                    r.remote_peers
                                        .iter()
                                        .filter(|(peer_id, _)| {
                                            **peer_id != remote_id
                                                && peer_id.to_string() != origin_id_str
                                        })
                                        .map(|(id, conn)| (*id, conn.clone()))
                                        .collect()
                                })
                                .unwrap_or_default()
                        };
                        for (_, peer_conn) in relay_targets {
                            let payload_bytes = serde_json::to_vec(&envelope).unwrap();
                            let l_bytes = (payload_bytes.len() as u32).to_le_bytes();
                            tokio::spawn(async move {
                                if let Ok((mut send_stream, _recv_stream)) = peer_conn.open_bi().await {
                                    let _ = send_stream.write_all(&l_bytes).await;
                                    let _ = send_stream.write_all(&payload_bytes).await;
                                }
                            });
                        }

                        // Sync natively (importing ReadTxn / WriteTxn as needed)
                        if envelope.kind == "ysync" {
                            let (update_bytes, _) = read_length_and_buf(&envelope.payload, 2).unwrap();
                            if let Ok(update) = Update::decode_v1(&update_bytes) {
                                let rooms = hub_clone.rooms.lock().unwrap();
                                if let Some(room) = rooms.get(room_id) {
                                    let mut txn = room.doc.transact_mut();
                                    let _ = txn.apply_update(update);
                                }
                            }
                        }
                    }
                });
            }
        }
    }
    })
}

/// Push a bridge-status envelope to EVERY local browser in a room (used from
/// contexts that don't hold a specific browser stream, e.g. gossip mesh dials).
async fn broadcast_bridge_status(
    hub: &SharedHub,
    room_id: &str,
    target_node_id: &str,
    status: &str,
    detail: Option<&str>,
) {
    let body = serde_json::json!({
        "target": target_node_id,
        "status": status,
        "detail": detail,
    });
    let env = SsfEnvelope {
        v: 1,
        room: room_id.to_string(),
        kind: "bridge".to_string(),
        seq: 0,
        author: vec![],
        payload: body.to_string().into_bytes(),
        sig: None,
        iroh_node_id: None,
        iroh_relay_urls: None,
        iroh_direct_addrs: None,
    };
    let Ok(bytes) = serde_json::to_vec(&env) else { return };
    let len_bytes = (bytes.len() as u32).to_le_bytes();
    let clients: Vec<Connection> = {
        let rooms = hub.rooms.lock().unwrap();
        rooms
            .get(room_id)
            .map(|r| r.local_connections.values().cloned().collect())
            .unwrap_or_default()
    };
    for wt_conn in clients {
        let bytes = bytes.clone();
        tokio::spawn(async move {
            if let Ok(opening) = wt_conn.open_bi().await {
                if let Ok((mut send_stream, _recv_stream)) = opening.await {
                    let _ = send_stream.write_all(&len_bytes).await;
                    let _ = send_stream.write_all(&bytes).await;
                }
            }
        });
    }
}

/// Push a `bridge` status envelope to the local browser so the UI can show
/// whether the cross-machine dial is in flight / connected / failed instead
/// of failing silently (🐛 0.16.0: dial failures were console-only).
async fn write_bridge_status<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    room_id: &str,
    target_node_id: &str,
    status: &str,
    detail: Option<&str>,
) -> Result<()> {
    let body = serde_json::json!({
        "target": target_node_id,
        "status": status,
        "detail": detail,
    });
    let env = SsfEnvelope {
        v: 1,
        room: room_id.to_string(),
        kind: "bridge".to_string(),
        seq: 0,
        author: vec![],
        payload: body.to_string().into_bytes(),
        sig: None,
        iroh_node_id: None,
        iroh_relay_urls: None,
        iroh_direct_addrs: None,
    };
    let bytes = serde_json::to_vec(&env)?;
    let len_bytes = (bytes.len() as u32).to_le_bytes();
    writer.write_all(&len_bytes).await?;
    writer.write_all(&bytes).await?;
    Ok(())
}

async fn handle_ysync_message<W: AsyncWriteExt + Unpin>(
    hub: &SharedHub,
    room_id: &str,
    envelope: &SsfEnvelope,
    writer: &mut W,
) -> Result<()> {    let payload = &envelope.payload;
    if payload.is_empty() {
        return Ok(());
    }

    let mut cursor = 0;
    let (msg_type, bytes_read) = read_var_uint(payload, cursor)?;
    cursor += bytes_read;

    if msg_type == 0 {
        let (sync_sub_type, bytes_read) = read_var_uint(payload, cursor)?;
        cursor += bytes_read;

        if sync_sub_type == 0 {
            let (client_sv_bytes, _) = read_length_and_buf(payload, cursor)?;
            let client_sv = StateVector::decode_v1(&client_sv_bytes)
                .map_err(|e| anyhow!("Failed decoding client state vector: {:?}", e))?;

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

            let reply_env = SsfEnvelope {
                v: 1,
                room: room_id.to_string(),
                kind: "ysync".to_string(),
                seq: envelope.seq + 1,
                author: vec![],
                payload: encoder.to_vec(),
                sig: None,
                iroh_node_id: None,
                iroh_relay_urls: None,
                iroh_direct_addrs: None,
            };

            let reply_bytes = serde_json::to_vec(&reply_env)?;
            let len_bytes = (reply_bytes.len() as u32).to_le_bytes();
            writer.write_all(&len_bytes).await?;
            writer.write_all(&reply_bytes).await?;

        } else if sync_sub_type == 1 || sync_sub_type == 2 {
            let (update_bytes, _) = read_length_and_buf(payload, cursor)?;
            let update = Update::decode_v1(&update_bytes)
                .map_err(|e| anyhow!("Failed decoding update block: {:?}", e))?;

            {
                let rooms = hub.rooms.lock().unwrap();
                let room = rooms.get(room_id).unwrap();
                let mut txn = room.doc.transact_mut();
                txn.apply_update(update)
                    .map_err(|e| anyhow!("Failed to apply browser update: {:?}", e))?;
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

async fn start_http_api_server(hub: SharedHub, iroh_endpoint: IrohEndpoint) {
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
            eprintln!("⚠️ Failed to bind HTTP API server on both 8080 and 8081.");
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
        let iroh_snapshot = iroh_endpoint.clone();
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

            // S1 CORS allowlist v2 (2026-07-08): any LOOPBACK page origin is allowed on
            // ANY port — a remote website can never present a loopback Origin, and dev
            // servers drift ports (Vite 5173→5174…). Non-loopback origins (public /
            // staging web lane) come from the SSF_ALLOWED_ORIGINS env (comma-separated),
            // never from code. Tauri WebView origins covered on all platforms
            // (tauri://localhost on macOS/Linux, http(s)://tauri.localhost on Windows).
            let origin_allowed = |origin: &str| -> bool {
                if origin.eq_ignore_ascii_case("tauri://localhost") {
                    return true;
                }
                let host = origin
                    .strip_prefix("http://")
                    .or_else(|| origin.strip_prefix("https://"))
                    .map(|rest| rest.split('/').next().unwrap_or(rest))
                    .map(|host_port| {
                        if let Some(v6) = host_port.strip_prefix('[') {
                            v6.split(']').next().unwrap_or(v6).to_string()
                        } else {
                            host_port.split(':').next().unwrap_or(host_port).to_string()
                        }
                    });
                if let Some(host) = host {
                    if host.eq_ignore_ascii_case("localhost")
                        || host == "127.0.0.1"
                        || host == "::1"
                        || host.eq_ignore_ascii_case("tauri.localhost")
                    {
                        return true;
                    }
                }
                std::env::var("SSF_ALLOWED_ORIGINS")
                    .map(|raw| raw.split(',').map(str::trim).any(|o| o.eq_ignore_ascii_case(origin)))
                    .unwrap_or(false)
            };

            let cors_origin = match origin_header {
                Some(ref o) if origin_allowed(o) => {
                    format!("Access-Control-Allow-Origin: {}\r\nVary: Origin\r\n", o)
                }
                _ => String::new(),
            };

            if req.starts_with("GET /api/fingerprint") {
                let fp_json = {
                    // 🐛 0.16.0 fix: refresh direct-addr hints from the LIVE endpoint
                    // view on every request. Portmapper mappings, QAD-observed and
                    // external addresses appear AFTER startup; a boot-time snapshot
                    // meant invites never carried the public-reachable addresses.
                    let live_direct_addrs: Vec<String> = iroh_snapshot
                        .addr()
                        .ip_addrs()
                        .filter(|sock| !sock.ip().is_unspecified())
                        .map(|sock| sock.to_string())
                        .collect();
                    let mut fp = hub_clone.fingerprint.lock().unwrap();
                    if !live_direct_addrs.is_empty() {
                        fp.iroh_direct_addrs = live_direct_addrs;
                    }
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
                // Access-Control-Allow-Private-Network answers Chromium PNA/LNA
                // preflights when a public-origin page dials this loopback API
                // (harmless for loopback-origin pages, which skip the gate).
                let response = format!(
                    "HTTP/1.1 204 No Content\r\n\
                     {}Access-Control-Allow-Methods: GET, OPTIONS\r\n\
                     Access-Control-Allow-Headers: *\r\n\
                     Access-Control-Allow-Private-Network: true\r\n\
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
