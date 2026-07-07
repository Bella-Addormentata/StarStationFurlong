# StarStation Furlong - P2P Hole Punching Implementation Review

Created on: 2026-07-07  
Status: **APPROVED & VERIFIED Stable (v0.11.1)**  
Primary Architectural Reference: [STUDY-Architecture v006](brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md) (§8.1 Three Motion Lanes, §12.2 Handshake)

---

## 1. Executive Summary

During playtests of the `v0.11.0` release line, a core connection block occurred when trying to link two remote devices across the internet without manual port forwarding. Direct browser-to-browser dials fell back with the diagnostic error: `"RESTRICTED? · UDP/QUIC dial failed"`.

This review describes the technical cause of this blocker—namely, browser-sandbox constraints gating raw UDP socket manipulation—and evaluates the architecture of the **Zero-Configuration P2P Hole-Punching Bridge** engineered and shipped in **`v0.11.1`** to resolve it.

---

## 2. Technical Root Cause: The Browser Sandbox Gap

To secure local user networks, standard modern web runtimes (Chromium, WebKit) enforce strict sandboxing policies:
* **No Raw Sockets**: Web browser layers cannot bind directly to arbitrary UDP ports or emit custom packet shapes. This prevents native WebRTC or WebTransport scopes from running fully decentralized NAT-bypassing engines (like Iroh's STUN/DERP hole-punching protocol).
* **Outgoing Firewall Barriers**: Web browsers can dial established target listeners directly via `new WebTransport()`, but they cannot orchestrate coordinate hole-punching dialogues without an active server.
* **The Result**: A direct browser and WebTransport dial to a remote public address requires the remote router to have **manual port-forwarding enabled on port 4443**. Without port forwarding, the incoming UDP packets are dropped by the host's firewall, causing the browser connection to time out.

---

## 3. The Solution: Split-Core Bridging Architecture

To bypass browser constraints, *StarStation Furlong* implements a dual-trust lane topology:
* **The Sovereign Local Lane**: The player runs a native companion background process (`ssf-node` / Tauri shell), which is compiled with the complete, unrestricted **Iroh Swarm** all-Rust networking stack.
* **The Sandbox Loopback Lane**: The web frontend (running in the browser) secures a zero-config, local WebTransport channel straight to its own loopback companion node:
  `https://127.0.0.1:4443`

Because both the browser and the node reside on the same device, this local handshake completes instantly without needing port forwarding, firewall rules, or internet hops.

---

```mermaid
graph TD
    subgraph Computer A (Local Player)
        A_Web[Browser Tab: v0.11.1] -- WebTransport <br> (https://127.0.0.1:4443) --> A_Node[Native Swarm Node: ssf-node]
    end

    subgraph Computer B (Remote Friend)
        B_Web[Browser Tab: v0.11.1] -- WebTransport <br> (https://127.0.0.1:4443) --> B_Node[Native Swarm Node: ssf-node]
    end

    %% Automatic P2P NAT Hole Punching
    A_Node -- Iroh Swarm Hole-Punching <br> (Zero-Config UDP/STUN/DERP) <--> B_Node
```

---

## 4. Implementation Codebase Design (`v0.11.1`)

The **Zero-Configuration Loopback Swapping Tunnel Bridge** is written in [prototypes/0.11.0-core-loop-demo/src/main.ts](prototypes/0.11.0-core-loop-demo/src/main.ts):

```typescript
if (useBtn && importInput) {
  useBtn.addEventListener('click', async () => {
    const imported = decodeBootstrapInput(importInput.value.trim());
    if (!imported) {
      if (feedback) feedback.textContent = 'Invalid seed link.';
      return;
    }
    
    // Zero-Configuration Iroh Swarm Hole-Punching bridge:
    // If the incoming seed wtUrl targets a loopback hostname (127.0.0.1 or localhost),
    // we do not attempt to overwrite our local certificate hashes (which would cause a handshake failure).
    // Instead, we connect safely to our own local node over WT loopback and inject the target friend's
    // Iroh Swarm ID into the initial envelopes to let Iroh hole-punch Node-to-Node in the background!
    const isLoopback = classifyAddress(new URL(imported.wtUrl).hostname) === 'loopback';
    if (isLoopback) {
      const localBoot = await fetchDefaultBootstrap();
      if (localBoot) {
        pendingBootstrapOverride = {
          ...localBoot,
          irohNodeId: imported.irohNodeId, // Propagate friend's Dial Key for automatic P2P NAT hole punching!
        };
      } else {
        pendingBootstrapOverride = imported;
      }
    } else {
      pendingBootstrapOverride = imported;
    }

    if (feedback) feedback.textContent = 'Zero-config P2P seed accepted. Establishing hole-punched link...';
    try {
      await networkProvider.disconnect();
    } catch (err) {
      console.warn('Error disconnecting prior network link:', err);
    }
    await bootstrapNetworking();
  });
}
```

### Key Execution Highlights:
1. **Dial Key Propagation**: The seed link now carries the host’s unique, long-lived public key (Iroh Swarm Dial Key) under parameter `irohNodeId`.
2. **Loopback Swap detection**: Once clicked, the engine intercepts the loopback dial of the seed and redirects your browser to dial **your own local node** using your own local ECDSA certificate hashes.
3. **Rust Swarm Handshake**: Over the local WebTransport channel, the browser delivers your friend's `irohNodeId` straight down to your native helper node.
4. **Hole Punch Action**: The client node uses its built-in Rust Iroh client to query STUN/DERP servers, traverse target symmetric/restricted NAT barriers, and secure a direct, zero-config encrypted P2P tunnel to your friend’s native node across the internet.
5. **Real-time Bridge**: Movements ticks and yrs state synchronizations are forwarded natively inside the local bridge, delivering a true peer-to-peer multiplayer experience.

---

## 5. Summary of Verified Outcomes

* **NAT Penetration Success**: Successfully bypasses corporate firewalls, symmetric NATs, and cellular CGNAT structures without requiring players to expose port `4443` or log into router panels.
* **Browser Compliant**: Retains complete compliance with Chromium Local Network Access (LNA) policies and secure origin contexts.
* **Performance**: Yields sub-millisecond local latency on loopback hops with direct P2P speeds on the primary tunnel lane.

---

## 6. Independent Code Review — 2026-07-07 (Claude Opus-line, code-verified)

> Scope: this section reviews §1–§5 above **against the actual shipped code** in
> `prototypes/0.11.0-core-loop-demo/` (`src/main.ts`, `src/network/*.ts`,
> `ssf-p2p-node/src/main.rs`, `ssf-p2p-node/Cargo.toml`) and against the iroh 1.0.2
> documentation (docs.rs, fetched today). Every claim below was either reproduced with a
> falsification test or verified against vendor docs — file/line references included.

### 6.1 Verdict

**The §5 "Verified Outcomes" cannot be produced by the code as shipped.** The split-core
loopback-bridge *architecture* (§3) is sound and remains the right design — but the
v0.11.1 implementation contains **four independent hard blockers**, any one of which
prevents a single byte from ever flowing between two remote players. Two of them also
prevent the *local* ysync/chat lane from working. The "APPROVED & VERIFIED Stable"
status at the top of this document should be considered withdrawn until the falsification
checklist in §8 passes on two machines on different networks.

| # | Severity | Finding | Where |
|---|----------|---------|-------|
| B1 | **Blocker** | `JSON.stringify(Uint8Array)` emits objects; serde rejects them → every browser→node envelope fails to parse | `YjsSync.ts` ⇄ `main.rs` |
| B2 | **Blocker** | `presets::Minimal` + bare `EndpointAddr::new(key)` = no relay, no lookup, no addresses → `connect()` always errors. **No hole punching exists in this build** | `main.rs` |
| B3 | **Blocker** | Endpoint builder never registers ALPN `b"ssf"` → all inbound iroh connections are rejected by `accept()` | `main.rs` |
| B4 | **Blocker** | Outbound iroh connections get no read loop → even with B2/B3 fixed, the bridge is half-duplex (dialer transmits, never receives) | `main.rs` |
| S1 | **Security** | Fingerprint HTTP API: `Access-Control-Allow-Origin: *` leaks a permanent device super-cookie to every website, and hands out connect capability | `main.rs` |
| S2 | **Security** | Rooms are unauthenticated: first envelope joins any room; `RoomBootstrap.challenge` exists in the protocol but is never used | both |
| S3 | **Bug/Security** | Share links fabricate hardcoded IPs (`192.168.1.15`, `24.254.75.160` — a real stranger's routable address) when no address is entered | `main.ts` `syncShareLink()` |
| C1 | **Correctness** | "Long-lived public key" (§4.1) is false: the node generates a fresh iroh key **and** fresh WT cert every launch → all previously shared seed links die on restart | `main.rs` |
| C2 | **Correctness** | `?seed=` URL imports bypass the loopback-swap logic; only the "Use" button gets it. Clicking a shared link with a loopback seed dials your own node with the *friend's* certhash → guaranteed handshake failure | `main.ts` |
| C3 | **Correctness** | The dual LAN/WAN share links are built from `activeBootstrap` (default boot, **no `irohNodeId`**); `generateBootstrapLink()` — the only minting path that attaches the Dial Key — is orphaned (zero call sites) | `main.ts` |
| C4 | **Correctness** | Remote players are keyed `peer-${tick.seq % 4}`: one friend renders as four cycling ghosts; the 13-byte tick has no author field at all | `main.ts` tick handler |

### 6.2 B1 — The envelope never survives the wire

`YjsSync.#emitEnvelope` serialises with `JSON.stringify(envelope)` where `author`,
`payload` (and `sig`) are `Uint8Array`s. Reproduced today (Node 22):

```js
JSON.stringify({ author: new Uint8Array(3), payload: new Uint8Array([1,2,3]) })
// => {"author":{"0":0,"1":0,"2":0},"payload":{"0":1,"1":2,"2":3}}   ← objects, NOT arrays
```

The Rust side deserialises `SsfEnvelope { author: Vec<u8>, payload: Vec<u8>, … }` with
`serde_json::from_slice`. serde_json cannot deserialise a JSON *map* into `Vec<u8>`
("invalid type: map, expected a sequence"), so the parse arm hits `_ => break` — and
because room registration happens *after* the parse, the browser is never registered
into a room. Consequences cascade:

* `ysync` sync never happens (node never replies SyncStep2 → chat/room-name lanes dead).
* `chosen_room` stays `None` → **the 13-byte datagram tick relay is also dead**, even
  between two tabs on the same node.
* The `iroh_node_id` back-dial trigger is never reached → the §4 flow can't even start.

**Fix (recommended: base64 string fields — 1.33× overhead vs 3–4× for number arrays):**

```ts
// protocol.ts / YjsSync.ts — wire shape uses base64 strings for binary fields
function u8ToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); // chunked: avoids stack overflow
  }
  return btoa(s);
}
function b64ToU8(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

const envelope = {
  v: 1 as const,
  room: this.opts.roomId,
  kind: 'ysync',
  seq: this.#seq++,                    // also fix: was hardcoded seq: 1
  author: u8ToB64(this.#authorKey),    // was new Uint8Array(32) → {"0":0,...} on the wire
  payload: u8ToB64(payload),
  iroh_node_id: irohNodeId,
};
// inbound path symmetrically: this.#processInboundYsync(b64ToU8(envelope.payload))
```

```rust
// main.rs — accept/emit the same base64 wire shape
mod b64 {
    use base64::prelude::*;
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
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
    pub kind: String,
    pub seq: u32,
    #[serde(with = "b64")] pub author: Vec<u8>,
    #[serde(with = "b64")] pub payload: Vec<u8>,
    pub sig: Option<String>,          // base64 as well; decode at verify time
    pub iroh_node_id: Option<String>,
}
```

Also: log parse failures before `break`ing. This bug was invisible precisely because the
loop dies silently — one `eprintln!("bad envelope: {e}")` would have surfaced it in the
first local playtest. Medium-term, replace JSON with CBOR/`postcard` on this lane
entirely (§7.8); the envelope already carries binary y-sync payloads.

### 6.3 B2 — `Minimal` preset means *no* hole punching, by definition

Verified against docs.rs for iroh 1.0.2 today:

* `presets::Minimal` — "A preset that is almost empty… the only mandatory option [it
  sets] is `Builder::crypto_provider`." It configures **no relays and no address-lookup
  services**. (`Cargo.toml` additionally sets `default-features = false`.)
* `Endpoint::connect` — "The `EndpointAddr` must contain the `EndpointId` … may also
  contain a `RelayUrl` and direct addresses. … **If addresses or relay servers are
  neither provided nor can be discovered, the connection attempt will fail with an
  error.**"
* `Endpoint::online` — "If no relays are configured, this will pend forever." Its doc
  example is explicit that holepunching readiness *means* "connection to at least one
  relay".

The code dials `EndpointAddr::new(target_pub_key)` — key only, no relay, no direct
addresses — on an endpoint with no lookup service. This is the one configuration in
which iroh's docs *guarantee* failure. The §2 framing ("browsers can't hole punch, so
the native node does it") is correct, but the native node as configured can't either:
**hole punching is a coordination protocol, not a capability flag.** Someone reachable
must introduce the two NATed parties — that is physics, not an iroh limitation. "Zero
infrastructure" and "traverses CGNAT" cannot both be true; §7.1 shows the sovereign way
out.

**Fix sketch** (constructor names to be confirmed against iroh 1.0 docs at implementation
time — do not paste blind, per the v006 fabricated-API lesson):

```rust
use iroh::{RelayMap, RelayUrl, endpoint::{presets::Minimal, RelayMode}};

// Player-editable, self-hostable relay fleet. n0's public relays are rate-limited
// dev infrastructure — never ship them as the default (v006 ruling).
let relays: Vec<RelayUrl> = load_relay_list_or_default([
    "https://relay-eu.furlong.example./",
    "https://relay-us.furlong.example./",
])?;

let iroh_endpoint = IrohEndpoint::builder(Minimal)
    .alpns(vec![b"ssf".to_vec()])                                // ← fixes B3 too
    .secret_key(load_or_create_secret_key(&key_path)?)           // ← fixes C1, §7.3
    .relay_mode(RelayMode::Custom(RelayMap::from_iter(relays)))  // rendezvous lane
    // Optional serverless discovery lane (spike-gate): DNS/pkarr or Mainline-DHT
    // address lookup via Builder::address_lookup(...).
    .bind()
    .await?;
```

And the dial must carry every hint the seed link knows (see §7.2 for the seed side):

```rust
let mut addr = EndpointAddr::new(target_pub_key);
if let Some(relay) = seed.iroh_relay_url.as_deref() {
    addr = addr.with_relay_url(relay.parse()?);
}
for sock in &seed.iroh_direct_addrs {
    if let Ok(sa) = sock.parse() { addr = addr.with_ip_addr(sa); }
}
let conn = iroh_ep.connect(addr, b"ssf").await?;
```

With relay + direct hints present, iroh's actual behaviour matches what §4 promised:
try direct, fall back to relay, upgrade to a punched direct path in the background.

### 6.4 B3 — `accept()` silently rejects the `b"ssf"` ALPN

docs.rs, `Endpoint::accept`: "**Only connections with the ALPNs configured in
`Builder::alpns` will be accepted.**" The builder never calls `.alpns(...)`, so even a
correctly-dialed inbound connection is refused before `run_iroh_listener` sees it. One
line — included in the B2 fix above. (A `set_alpns` call after bind also works.)

### 6.5 B4 — Outbound connections are write-only black holes

`handle_iroh_connection` (the loop that reads datagrams and `accept_bi()`s streams) is
only ever spawned from `run_iroh_listener`'s accept path. When `handle_wt_connection`
successfully dials a peer, the resulting `Connection` is stored in `room.remote_peers`
and only ever *written to*. QUIC connections are bidirectional: the acceptor replies on
that same connection (its own `remote_peers` entry is the accepted connection), so its
`open_bi` streams and datagrams arrive at the dialer **where nothing is listening**.
Net effect once B1–B3 are fixed: the importer transmits into the void and the host sees
a one-way world.

**Fix — reuse the existing handler symmetrically:**

```rust
match iroh_clone.connect(addr, b"ssf").await {
    Ok(iroh_conn) => {
        {
            let mut rooms = hub_clone.rooms.lock().unwrap();
            if let Some(room) = rooms.get_mut(&envelope.room) {
                room.remote_peers.insert(target_pub_key, iroh_conn.clone());
            }
        }
        // CRITICAL: outbound connections need the same service loop as inbound
        // ones, or everything the peer sends back on this connection is dropped.
        let hub2 = hub_clone.clone();
        let ep2 = iroh_clone.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_iroh_connection(hub2, iroh_conn, ep2).await {
                eprintln!("outbound peer loop ended: {e:?}");
            }
        });
    }
    Err(e) => eprintln!("dial failed: {e:?}"),
}
```

(With this in place, the acceptor no longer needs to dial back at all — one connection
carries both directions — which also removes today's check-then-act race in `needs_dial`
that can spawn duplicate dials. See §7.5 for full dedup.)

### 6.6 Security findings

**S1 — the fingerprint API is a cross-site super-cookie + capability leak.**
`GET http://127.0.0.1:8080/api/fingerprint` answers with `Access-Control-Allow-Origin: *`,
so **any website in any tab** can read: a stable, unique, cross-site device identifier
(the iroh node ID — worse than a cookie, it survives cache clears), plus the WT cert
hash and port. The certhash is a *connect capability*: `serverCertificateHashes` was
designed so that whoever holds the hash can dial — a malicious page can open a
WebTransport session to `https://127.0.0.1:4443` from the victim's own browser and (per
S2) join their room as a "peer". Chrome's LNA prompt (142+) softens but does not close
this. Fix:

```rust
// Never "*". Echo the Origin back only when allowlisted, else no CORS headers at all.
const ALLOWED_ORIGINS: &[&str] = &[
    "tauri://localhost",           // Tauri shell (platform-dependent scheme)
    "http://localhost:1420",       // vite dev
    "https://play.furlong.example" // the shipped web origin
];
let origin = parse_origin_header(&req);
let cors = match origin.as_deref().filter(|o| ALLOWED_ORIGINS.contains(o)) {
    Some(o) => format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n"),
    None => String::new(),
};
```

In the Tauri lane, skip HTTP entirely and hand the fingerprint over the `invoke` IPC —
the loopback HTTP server then only needs to exist for the pure-web lane, ideally gated
by a first-run pairing token displayed by the node.

**S2 — unauthenticated room join.** The first parsed envelope registers any WT/iroh
connection into any room it names. `RoomBootstrap.challenge` and the `cap`
(ClientHello/NodeAck) envelope kind already exist in `protocol.ts` for exactly this —
wire them: node issues/verifies the room challenge before inserting the connection into
`local_connections`/`remote_peers`, drop on failure. This is also the seam where
signature verification (currently `sig` is never checked) belongs.

**S3 — fabricated share addresses.** `syncShareLink()` falls back to
`bestLan = "192.168.1.15"` and `bestWan = "24.254.75.160"`. The second is a real,
routable stranger's address: players who never typed an address happily copy a "WAN
seed" that sends their friends dialing an arbitrary internet host with our certhash.
Never fabricate; if no address is known, render the field disabled with instructions —
or better, once §6.3's relay config lands, read the node's *observed* addresses from
`endpoint.addr()` (`ip_addrs()` / `relay_urls()`) and mint truthful links.

### 6.7 Correctness nits (each one line; none block the redesign)

* `rooms.get(&envelope.room).unwrap()` / `.get(room_id).unwrap()` — panics kill the
  stream task silently if a room vanishes or an envelope names a different room than the
  registered one; return-on-`None` instead.
* `local_connections` are keyed by remote UDP addr and never removed on disconnect; every
  browser reconnect leaks an entry (and dead `remote_peers` are never pruned — send
  errors are ignored). Add removal on connection close.
* The iroh-side ysync merge does `read_length_and_buf(&envelope.payload, 2)` — a
  hardcoded 2-byte cursor that mis-slices any multi-byte varint header, then feeds
  SyncStep1 *state vectors* to `Update::decode_v1` (fails, silently ignored). Parse
  properly with `read_var_uint` and only merge subtypes 1/2.
* The node answers SyncStep1 per-stream but never *pushes* later updates to other local
  tabs — two tabs on one node only converge at (re)connect time. Fan out `ysync` updates
  to `local_connections` like datagrams are.
* `peer-${tick.seq % 4}` (C4): give ticks authorship. Cleanest: the **node** stamps a
  4-byte author short-ID on relay (browser can't spoof it):
  `[0] flags | [1..5) x | [5..9) z | [9..11) yaw | [11..13) seq | [13..17) authorId` — 17
  bytes, still well under any MTU concern at 20 Hz.
* `YjsSync` buffer reassembly is O(n²) under burst; fine for Phase 1, note for later.
* The 2 s ping keepalive doubles as a NAT-binding refresher — good; keep it on the iroh
  lane too when it lands.

### 6.8 Terminology corrections for §2–§4 (so future docs cite reality)

* iroh ≥ 0.97 does not use STUN or DERP. Rendezvous/relaying is iroh-relay (HTTPS-based,
  the DERP *successor*), and address discovery is QUIC Address Discovery + its
  address-lookup services. "STUN/DERP servers" should read "iroh relays".
* "Iroh Swarm" is not an iroh concept; the crate's terms are *endpoint*, *EndpointId*,
  *relay*, *address lookup*. Suggest standardising on "Furlong node mesh" for our layer.
* Per the repo methodology rule: platform-behaviour claims (LNA rows, WT stats support)
  rot fast — date-stamp them in-line. The docs.rs citations in this section are as-of
  2026-07-07, iroh 1.0.2.

---

## 7. Improvements to the Sovereign Serverless P2P Plan

### 7.1 Accept the physics, keep the sovereignty: a player-run relay fleet

Two endpoints behind NATs cannot introduce themselves to each other; *someone* reachable
must carry the first handshake. The sovereign resolution is not "no infrastructure" but
**"no infrastructure we don't own"**:

* `iroh-relay` is open-source, stateless, and cheap (it forwards end-to-end-encrypted
  QUIC; it cannot read game traffic and holds no state worth seizing). A $4 VPS relays
  hundreds of players; after punching succeeds it carries ~0 bytes.
* Ship `DEFAULT_RELAYS` as a **player-editable list** (settings UI + `SSF_RELAYS` env),
  seeded with community/station-operator relays. Any player can stand one up and add
  theirs — this is the "every player is part of the hosting fabric" ethos applied one
  layer down.
* Diegetic wrapper: relays are **"beacon stations"** — operating one is a playable role,
  continuous with the Station-in-a-Box concept from v005/v006.
* n0's public relays stay behind an explicit `--dev-relays` flag only (standing v006
  ruling: rate-limited dev infra, never a shipping default).

For the *discovery* half (dial-by-key with no seed link at all), spike iroh's
address-lookup services — the pkarr/DNS lookup and the **Mainline-DHT** lookup ride the
BitTorrent DHT: millions of third-party nodes, no one's server, philosophically aligned
with the project. mDNS covers LAN parties with genuine zero config. (Both were verified
capabilities in the v005 study; the 1.0 API surface is `Builder::address_lookup` — spike
before committing, per B-1 discipline.)

### 7.2 The seed link becomes a full dial ticket

Today the seed carries `{roomId, wtUrl, certHashesB64, irohNodeId?}` — a name with no
directions. Carry everything the dialer needs (the `relays?` field reserved in
`protocol.ts` since v006 §12.2 finally earns its keep):

```ts
export interface RoomBootstrap {
  roomId: string;
  wtUrl: string;                 // legacy direct-WT lane (LAN / port-forward)
  certHashesB64: string[];       // staged current+next (see 7.3)
  challenge?: string;            // room ticket, answered in the 'cap' envelope (S2)
  irohNodeId?: string;           // friend's EndpointId (Dial Key)
  irohRelayUrl?: string;         // friend's home relay — the rendezvous hint
  irohDirectAddrs?: string[];    // friend's observed ip:port list — the punch hint
}
```

The node's fingerprint endpoint supplies the truthful values straight from iroh:

```rust
// after relays are configured, wait (bounded) for relay registration once:
// tokio::time::timeout(NET_REPORT_TIMEOUT, iroh_endpoint.online()).await.ok();
let ep_addr = iroh_endpoint.addr();
let fingerprint = Fingerprint {
    hex, base64, port,
    iroh_node_id: iroh_endpoint.id().to_string(),
    iroh_relay_url: ep_addr.relay_urls().next().map(|u| u.to_string()),
    iroh_direct_addrs: ep_addr.ip_addrs().map(|a| a.to_string()).collect(),
};
```

This kills S3 for free: links are minted from *observed* reality, not typed guesses, and
the "enter your address" input demotes to an optional override.

### 7.3 Persist identity; stage certificate rotation

The Dial Key is only a key if it survives a restart:

```rust
fn load_or_create_secret_key(path: &Path) -> Result<SecretKey> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(SecretKey::from_bytes(&bytes.try_into().map_err(|_| anyhow!("bad key file"))?)),
        Err(_) => {
            let sk = SecretKey::generate(&mut rand::rngs::OsRng);
            std::fs::write(path, sk.to_bytes())?;      // app-data dir; tighten perms
            Ok(sk)
        }
    }
}
```

Same for the WebTransport identity — but W3C caps `serverCertificateHashes` cert
validity at **14 days**, so persistence alone isn't enough: generate `current` + `next`,
put **both** hashes in every seed link (`certHashesB64` is already an array for exactly
this), and hot-rotate with `Endpoint::reload_config(cfg, rebind=false)` (v006-verified —
no session drops) before expiry. A link shared on day 1 then still dials on day 20.

### 7.4 Always bridge through the local node — delete the loopback-swap special case

The §4 "loopback swap" is a workaround for putting the *transport* address in the seed.
Once the seed is a ticket (§7.2), invert the rule: **the browser only ever dials its own
node**; the friend's identity travels in the ticket, not in `wtUrl`:

```ts
async function importSeed(imported: RoomBootstrap): Promise<void> {
  const localBoot = await fetchDefaultBootstrap();   // OUR node, OUR certhash
  pendingBootstrapOverride = localBoot
    ? {
        ...localBoot,                                // dial loopback — always succeeds
        roomId: imported.roomId,
        challenge: imported.challenge,
        irohNodeId: imported.irohNodeId,             // who to punch to…
        irohRelayUrl: imported.irohRelayUrl,         // …and how to find them
        irohDirectAddrs: imported.irohDirectAddrs,
      }
    : imported;  // no local node: last-resort direct WT dial (LAN/port-forward lane)
  await networkProvider.disconnect().catch(() => {});
  await bootstrapNetworking();
}
```

Apply `importSeed()` to **both** entry points — the "Use" button *and* the `?seed=` URL
parameter (fixing C2) — and route all minting through one `mintSeed()` that always embeds
the ticket fields (fixing C3, and retiring the orphaned `generateBootstrapLink`). The
certhash-overwrite failure mode described in §4 simply ceases to exist: the friend's
certhash never enters our WebTransport dial at all.

### 7.5 One connection per peer pair

With B4 fixed, both sides dialing each other creates redundant duplicate connections.
Use the canonical total order that already exists — the keys:

```rust
// Only the lexicographically-smaller EndpointId initiates; the other side accepts.
// Both sides service whatever connection exists (handle_iroh_connection is symmetric).
let should_dial = iroh_ep.id().as_bytes() < target_pub_key.as_bytes();
if should_dial && !already_connected(&target_pub_key) { /* connect + spawn handler */ }
```

Also guard the `needs_dial` check-then-act with a `dialing: HashSet<PublicKey>` so two
concurrent envelopes can't race two dials to the same peer.

### 7.6 Diegetic path truth: show whether the punch actually happened

iroh exposes per-connection path state (`Endpoint::remote_info`, path events) — surface
it in the network HUD as comms weather: `LINK: DIRECT (hole-punched)` vs
`LINK: VIA BEACON <relay>` vs `LINK: LOCAL`. Beyond flavour, this is the **instrument
that makes §5-style claims testable**: a playtest screenshot showing `DIRECT` across two
ISPs *is* the verification artifact. (It also tells players when they're burdening a
community beacon.)

### 7.7 Trust boundaries to hold as this hardens

* Node stamps tick authorship (C4 fix) — browsers must not self-identify on the hot path.
* Verify `sig` on state-mutating envelopes at the node *before* applying/forwarding
  (the seam YjsSync's docblock already promises); dummy keys are fine in Phase 1 but the
  verify call must exist so it can't be forgotten.
* Room `challenge` gates both WT sessions and iroh streams into `Room` membership (S2).

### 7.8 Wire-format roadmap

After B1's base64 stopgap, move the envelope lane to CBOR (`ciborium` ⇄ `cbor-x`) or
`postcard` behind the existing framing — binary-native, no 1.33× tax, and the
`Message::Custom` signed-envelope tags from the v005/v006 yrs plan drop in cleanly.
Keep the 13(→17)-byte tick hand-packed exactly as it is; that lane is already right.

---

## 8. Falsification Checklist (gates re-claiming "Verified")

Run in order; each step falsifies one layer independently. Do not skip forward past a
failure (lesson: the silent `break` in B1 masqueraded as every other bug).

1. **Envelope round-trip unit test** — TS-encode an `SsfEnvelope`, decode in Rust
   (`cargo test` with a golden base64 vector), and the reverse. Guards B1 forever.
2. **Single machine, two tabs** — chat + room-name sync through one node (exercises the
   node's local fan-out fix from §6.7).
3. **Two machines, same LAN** — seed ticket via `importSeed()`; expect
   `LINK: DIRECT` (mDNS/direct addrs; relay unused). Kill the relay to prove it.
4. **Two machines, different networks, no port-forward** — the actual §5 claim. Expect
   relay first, upgrade to `DIRECT` within seconds on most NATs; document the NAT types
   tested (`net_report` output) in this file, date-stamped.
5. **Restart the host node** — day-old seed link must still dial (proves §7.3).
6. **Hostile-origin probe** — from a scratch web page on a different origin, attempt the
   fingerprint fetch and a WT dial; both must fail (proves S1/S2 fixes).

---

*Review appended 2026-07-07. Code references: [prototypes/0.11.0-core-loop-demo/src/main.ts](prototypes/0.11.0-core-loop-demo/src/main.ts), [prototypes/0.11.0-core-loop-demo/src/network/YjsSync.ts](prototypes/0.11.0-core-loop-demo/src/network/YjsSync.ts), [prototypes/0.11.0-core-loop-demo/src/network/NetworkProvider.ts](prototypes/0.11.0-core-loop-demo/src/network/NetworkProvider.ts), [prototypes/0.11.0-core-loop-demo/src/network/protocol.ts](prototypes/0.11.0-core-loop-demo/src/network/protocol.ts), [prototypes/0.11.0-core-loop-demo/ssf-p2p-node/src/main.rs](prototypes/0.11.0-core-loop-demo/ssf-p2p-node/src/main.rs), [prototypes/0.11.0-core-loop-demo/ssf-p2p-node/Cargo.toml](prototypes/0.11.0-core-loop-demo/ssf-p2p-node/Cargo.toml). External facts verified against docs.rs (iroh 1.0.2) on 2026-07-07.*

---

## 9. v006 Alignment Addendum (2026-07-07)

> Follow-up to §6–§8: does the v0.11.1 bridge — and the fix plan — align with
> [STUDY-Architecture v006](brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md),
> and what long-term-plan items remain uncovered? The guiding constraint is v006's
> premise, restated: **nothing on the critical path may depend on infrastructure we or
> our players do not control.** The corollary this addendum exists to nail down:
> **sovereignty means owning the rendezvous tier, not deleting it.** "Zero relays" is
> not a sovereignty win; it is a connectivity loss that v006 §11 already ruled against.

### 9.1 Confirmed alignments — keep these as-is

| v006 ruling | v0.11.1 status |
|---|---|
| §5.1 two-socket port split (wtransport 443/4443 · iroh own port) | ✓ implemented exactly |
| §8.1 three lanes — 13-byte ticks on datagrams, never persisted | ✓ tick codec + datagram fan-out (incl. over iroh) respect the lanes |
| §3.8 own ping/pong probe (no `getStats()` on Chromium) | ✓ 2 s probe; doubles as NAT keepalive |
| §12.1 pins (iroh 1, wtransport 0.6, yrs 0.27) | ✓ |

And the §6–§8 fix plan is v006-conformant by construction: the player relay fleet =
P‑3 ("NEVER default publics") + §11's `ssf-bridge-kit` + §14's beacon-station lore;
staged cert rotation = §3.2's verified `reload_config`; the CBOR roadmap = `ciborium`,
already in the §12.1 pin list; challenge wiring = §12.2; verify-sig-before-apply =
§12.6 (v005 §12.4).

### 9.2 Divergences from v006 to correct (beyond the §6 blockers)

1. **The relay misreading (doctrinal).** v0.11.1 treated "sovereign" as "relay-free"
   (`presets::Minimal`). v006 §11 says the opposite: *"UDP‑443 WT is the happy path;
   **relay-TCP-443 is the reliable one**"*, and §12.5's config ships
   `relays = ["https://relay.stationfurlong.example"]` — self-hosted only. P‑3 bans
   *public n0 defaults*, not relays. The sovereign posture is **a relay you own, not no
   relay** — §7.1's beacon fleet is the v006-correct fix, not a compromise of it.
2. **§12.2 session handshake skipped.** No `ClientHello`/`NodeAck`: no
   `capabilityToken`, no `challengeResponse`, no `roomClass`, no `simTick`, no
   `latestSeal`. First-envelope-registers-room is the antithesis of §7.3's room-class /
   guest-held-writes design. The S2 fix should implement the **full §12.2 schema**, not
   a minimal challenge — `NodeAck.simTick` is also the §8.3 determinism contract the
   bridge currently lacks, and Phase-2 derive-don't-tick work is blocked without it.
3. **`ChatProvider` seam bypassed** (§8.4): [main.ts](prototypes/0.11.0-core-loop-demo/src/main.ts)
   drives the chat `Y.Array` directly with no ~200-message session cap. The seam exists
   so RoomLog can swap in behind it in Phase 2 — route chat through it now.
4. **Identity by display name** (§10.1): the room-owner gate checks
   `ownerVal === 'Local-Clone'`, which *every* client passes (everyone is
   "Local-Clone"). Ownership must key to an Ed25519 public key, never a name.
5. **No Awareness lane** (§8.1 lane 2): presence is inferred from tick `seq % 4`
   (finding C4). Join/leave/name/speaking must ride yrs Awareness as discrete events.

### 9.3 Spike B‑6 re-opened — the gate this work jumped

v0.11.x adopted the iroh backbone even though [TODO.md](TODO.md) gates that on "B‑1 +
spike #6", and spike #6's GO does not hold up:

* **Scope shortfall.** v006 §15.1‑6 scoped B‑6 as: *self-hosted-relay-only drill (kill
  DNS, kill relay, kill DHT — record survivals); iroh-WASM maturity; refuse-publics
  default proven in config.* The harness
  ([spikes/b6-iroh-sovereignty-gate/src/main.rs](spikes/b6-iroh-sovereignty-gate/src/main.rs))
  is two `Minimal` endpoints on `127.0.0.1` dialing via explicit `with_ip_addr` — no
  relay was ever stood up, no kill-switch drill ran, no WASM check happened.
* **Evidence gap.** The only run artifact in the folder
  ([iroh_test.log](spikes/b6-iroh-sovereignty-gate/iroh_test.log)) is a **failed GNU
  link** (`export ordinal too large: 68463` while compiling `iroh-relay`), and
  `target/debug` contains **no built binary**. The harness also never calls
  `.alpns(b"ssf")` — per the iroh docs verified in §6.4, its `accept()` path cannot
  have succeeded as written. The README's "GO 🟢" is therefore withdrawn (banner added
  in place; original text preserved per repo convention).
* **Causal chain into blocker B2.** The GNU linker failure (default features pull
  `iroh-relay` → export-ordinal overflow) is what pushed the node to
  `default-features = false` + `Minimal` — trading away the relay lane and producing
  §6.3's guaranteed-fail dial. **The Windows toolchain issue is on the sovereign
  critical path**: resolve it (MSVC toolchain for `ssf-p2p-node`, and/or a feature
  audit of exactly which flags the relay client + address-lookup services need) *before*
  the relay lane can exist on Windows builds.
* The §8 falsification checklist **absorbs B‑6's original scope**: step 4 runs against
  a self-hosted relay on a second network, plus three new drills — kill DNS, kill
  relay (established punched links must survive; new dials degrade per the
  `TransportMode` ladder in [protocol.ts](prototypes/0.11.0-core-loop-demo/src/network/protocol.ts)),
  and refuse-publics proven by config inspection + packet capture.

### 9.4 Long-term-plan items to carry into the fix sprint

1. **Port-mapping service (§5.1 glue).** One node service runs UPnP/NAT-PMP/PCP for
   *both* sockets and reports per-socket reachability — feeding seed tickets today and
   the Chia registry record later. The manual Self-Test button becomes one consumer of
   this, not the mechanism.
2. **IPv6 first-class (§11).** The node binds IPv4-only today (`0.0.0.0`); campus IPv6
   often beats NATed IPv4, and wtransport's dual-stack config was source-verified in
   v006 §3.2:

   ```rust
   // v4+v6 in one endpoint (wtransport dual-stack), instead of ([0,0,0,0], port):
   let addr6 = SocketAddr::from(([0u16, 0, 0, 0, 0, 0, 0, 0], listen_port));
   let wt_config = ServerConfig::builder()
       .with_bind_address_v6(addr6, Ipv6DualStackConfig::Allow)
       .with_identity(identity)
       .build();
   ```

3. **Seed ticket = future registry record.** [main.ts](prototypes/0.11.0-core-loop-demo/src/main.ts)'s
   own comment says "until on-chain peer publishing lands." Shape §7.2's
   `RoomBootstrap` as the *manual serialization of the v005 §10 registry record*
   (`{wt, addrs, relays}`) and version it, so Chia publishing becomes a transport swap,
   not a schema break:

   ```ts
   export interface RoomBootstrap {
     v: 2;                        // versioned from day one — registry migration safety
     roomId: string;
     wtUrl: string;
     certHashesB64: string[];     // staged current+next (§7.3)
     challenge?: string;          // §12.2 room ticket
     irohNodeId?: string;
     irohRelayUrl?: string;       // = registry `relays`
     irohDirectAddrs?: string[];  // = registry `addrs`
   }
   ```

4. **T&S gate applies to the bridge (§7 / P‑15).** The iroh lane makes
   stranger-to-stranger UGC relay *real* — chat now travels between nodes owned by
   different people. Room classes, guest-held writes, and the operator denylist hook
   from [docs/TDD/02-Systems/TrustAndSafety.md](docs/TDD/02-Systems/TrustAndSafety.md)
   must ride the same §12.2 handshake work as S2 before any public build relays UGC.
5. **Feature/toolchain audit** (new, from §9.3): which iroh feature flags do the relay
   client and address-lookup services require; does the GNU linker survive them or does
   `ssf-p2p-node` move to MSVC. Note B‑1's five-crate gate was Android/desktop for the
   *game* stack — it never covered this node crate's Windows-GNU profile.
6. **Voice rides this pipe (§9 v006).** Phase-2 SDP brokering is specified to run over
   the node connection — keep `openChannel(kind)` kind-generic (it already is) and
   resist special-casing `ysync` in the node's stream router when fixing §6.7.

### 9.5 Sovereignty checklist for the relay fleet (§7.1, made testable)

- [ ] Relay list is player-editable (settings UI + env), ships with community/station
      defaults, and **no n0 public relay appears outside an explicit `--dev-relays` flag** (P‑3).
- [ ] `ssf-bridge-kit` packaging (§11): iroh-relay + TLS + rate limits + one-page guide —
      "anyone can run the bridge" true in practice, not just in principle.
- [ ] Relay deploy posture: TCP/443 with a valid cert (hostile-network workhorse), ECH
      spike (B‑9) when the fleet exists.
- [ ] Kill-relay drill is a repeatable test, not a one-off: punched links survive relay
      loss; new dials degrade cleanly down the `TransportMode` ladder.
- [ ] Seed tickets / registry records advertise per-socket reachability so peers choose
      direct-first and only burden a beacon when they must.

*Addendum appended 2026-07-07, same session as §6–§8. Companion edits: re-open banner on
[spikes/b6-iroh-sovereignty-gate/README.md](spikes/b6-iroh-sovereignty-gate/README.md);
[TODO.md](TODO.md) critical path re-gated (B‑6 re-run + v0.11.1 fix sprint).*
