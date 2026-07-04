# Spike B‑2 — WebTransport Certhash Dial & Rotation Matrix

> **WebTransport certhash is our primary browser↔node pipe.** This spike validates the configuration constraints, browser capabilities, cert rotation mechanics, and Local-Network-Access (LNA) constraints of the `wtransport` raw WebTransport channel.

## 📐 WebTransport Certhash Specifications

To connect a web browser directly to a local, player-run node without using formal PKI certificate authorities (the ultimate offline-sovereign path), we use W3C WebTransport `serverCertificateHashes`. The browser enforces strict cryptographic requirements for this:

1. **Algorithm:** Must be `ECDSA P-384`, `ECDSA P-256`, or similar allowed curves. Our implementation uses **ECDSA P-256** (constructed using `wtransport` built-in self-signed builder).
2. **Topology:** The certificate must be self-signed.
3. **Lifespan:** The total lifetime from creation to expiration **MUST NOT exceed 14 days** (strictly $\le 14$ days duration). If a certificate is valid for even 14 days and 1 second, modern browsers throw a silent `WebTransportError` during the handshake.
4. **Digest:** The SHA-256 digest of the raw DER-encoded leaf certificate must be pinned in the JS client constructor:
   ```javascript
   const wt = new WebTransport("https://127.0.0.1:4443", {
     serverCertificateHashes: [
       { algorithm: 'sha-256', value: sha256Bytes }
     ]
   });
   ```

---

## 🧭 Browser Support & Gates Matrix

Our findings align with [docs/TDD/BrowserSupportMatrix.md](docs/TDD/BrowserSupportMatrix.md), with load-bearing constraints re-validated:

| Browser | WebTransport | `serverCertificateHashes` | LNA / LAN Dial Gate | Minimum Version |
|---|---|---|---|---|
| **Chrome / Edge** | ✅ Yes | ✅ Yes | **⚠️ LNA Prompt Gate** (dialing private loops/LAN IPs requires interactive page-context grant; cannot connect silently inside a Worker) | Chrome 147+ (prompts 142+) |
| **Firefox** | ✅ Yes | ✅ Yes | **✅ None** (does not restrict private LAN dials) | Firefox 125+ |
| **Safari (desktop/iOS)** | ✅ Yes | ✅ Yes (Since 26.4) | **✅ None** (does not restrict private LAN dials yet) | iOS 16.4+ / Safari 26.4+ |

### 🛑 Special LNA Constraint on Chrome
In Chrome $\ge 142$, if the game shell is loaded from a public web origin (e.g., `https://starstationfurlong.example`) and attempts to dial a player's local loop (`127.0.0.1`) or LAN IP, Chrome blocks the connection under the **Local Network Access (LNA)** policy.
* **Fix & UX:** The first WebTransport dial *must* be initiated from the **main thread / page context** so that Chrome can prompt the user to grant permission. We cannot boot the WebTransport connection blindly in a background Web Worker on initialization without this context.

---

## ⚡ zero-Downtime Cert Rotation (`reload_config`)

Because certificates expire after 14 days, the node must rotate certificates periodically (suggested: every 10–12 days). In traditional servers, a restart is required.
With `wtransport`, we achieve **zero-downtime certificate rotation** while connections are active, verified in our rust code:

```rust
state.endpoint.reload_config(new_config, /*rebind=*/ false)?;
```

1. **Active Connections:** Existing WebTransport connections continue running over their UDP endpoints without interruption or packet loss.
2. **New Connections:** New incoming dials see the rotated certificate and handshake successfully using the new cert hash advertised in our room registry model.
3. **Registry Coexistence:** During the overlap window, our room registry advertises both the `current` and `next` certificate hashes, so lagging clients don't get shut out.

---

## 🎮 Running the Spike

### 1. Build and Start Server
From the project folder:
```powershell
# Compile & start server (runs on HTTP local loop 8080 and WebTransport target UDP 4443)
cargo run --release
```

### 2. Connect via Browser
1. Open your browser and navigate to `http://127.0.0.1:8080` (or `http://localhost:8080`).
2. **Secure Context Check:** Loading from `localhost`/`127.0.0.1` validates as a secure context, giving us access to WebTransport APIs.
3. Observe the active certificate hashes automatically fetched from the REST API endpoints.
4. Click **Connect** to establish the raw WebTransport socket.
5. Send **Datagrams** (UDP) and open **Bidirectional Streams** (TCP) to watch the server echo your payloads back instantly in the scrollable log terminal.
6. Click **Simulate Hot Rotate** to watch the server swap certificates in real-time, update the registry, and allow continued seamless messaging!
