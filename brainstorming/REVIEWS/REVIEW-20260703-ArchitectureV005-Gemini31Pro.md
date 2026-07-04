# Review of STUDY-Architecture v005 & Execution Plans
**Date**: 2026-07-04
**Evaluator**: Gemini 3.1 Pro (Preview)
**Focus**: Architecture v005, Execution Phases 1 & 2, Spikes & Feasibility

---

## 1. Executive Summary & Verdict

**Verdict:** The v005 architecture is a masterpiece of pragmatic system design. Transitioning the Node to an all-Rust foundation (`iroh`, `p2panda`, `yrs`) and discarding the JS-native Cabal layer fundamentally solves the "Runtime Gap" and avoids Electron/Node bloat in Tauri clients. The alignment of execution plans (Phase 1 & Phase 2) accurately reflects this roadmap. 

However, there are critical technical pitfalls in Phase 2's CRDT usage, a major hidden conflict with port-sharing between `wtransport` and `iroh`, and OS-level limitations on Android that require immediate refinement. 

## 2. Critical Errors & Pitfalls

### 2.1 The CRDT State-Explosion Trap (Phase 2 Plan)
- **The Issue:** In the *Phase 2 Execution Plan* (Feature 3), `anomaly` (current true anomaly of an orbit) is stored in the `stationOrbits` Yjs `Y.Map` and "updated each tick".
- **The Pitfall:** Yjs is a history-preserving CRDT. If a value is updated at 30Hz or 60Hz, it will bloat the Yjs document size exponentially within minutes, leading to massive memory consumption and network partition failures as peers drown in historical tombstones.
- **The Fix:** Never store ticking/rapidly-changing values in persisted CRDT state. The true anomaly/orbit clock must be deterministic. Store the *epoch timestamp of placement* and *orbital parameters* in the `Y.Map`. The clients use the local clock + those parameters to compute the anomaly instantly without network traffic.

### 2.2 The UDP 443 Port Multiplexing Conflict
- **The Issue:** v005 proposes pinning both the `wtransport` listener (for pure browser connections) and the `iroh` endpoint (for native swarms) to `UDP 443` to masquerade as HTTP/3 and evade firewalls.
- **The Pitfall:** Two separate Rust libraries (`wtransport` and `iroh`) cannot simultaneously map to the exact same UDP socket (0.0.0.0:443) natively. One library must act as the underlying `quinn` (QUIC) driver and manually demultiplex incoming connections via ALPN (Application-Layer Protocol Negotiation) before handing the stream to the respective handler. 
- **The Fix [Blocking Spike]:** Build a custom QUIC router using `quinn` that listens on UDP 443, reads the ALPN bytes, and routes the raw connection handles to either the `wtransport` context or the `iroh` context. 

### 2.3 SQLite WAL Mode on Android Tauri
- **The Issue:** `p2panda-store` uses SQLite to persist the RoomLog.
- **The Pitfall:** Android’s aggressive lifecycle can kill the app while a Write-Ahead Log (WAL) commit is occurring. If `p2panda-store` relies on default SQLite primitives without strict strict limits or explicit `fsync` mobile tweaks, room logs could corrupt upon backgrounding. 

## 3. Circumventing Locked-Down Networks (Outside-the-Box)

- **Iroh over CDN Edge Brokers:** 
  You can deploy lightweight WebSocket forwarders on free serverless edges (Cloudflare Workers, Deno Deploy) that convert WSS to Iroh QUIC packets. Because enterprise firewalls cannot blanket-block CDNs without breaking the internet, this serves as an unblockable, cost-free Tier 3 fallback.
- **WebRTC TCP Candidate Forcing:**
  Configure the fallback WebRTC layer (for browser-to-node proximity chat) to explicitly allow TCP `local` candidates on port 443. This bypasses the need for TURN servers entirely if the Tauri node has the port open, as DPI firewalls view it as standard HTTPS TLS traffic.
- **Service Worker Stale-While-Revalidate Sync:**
  Cache the most recent room states and registry lookups in the browser using the Background Sync API so that users on intensely unreliable mobile networks load the game interface instantly, bridging intermittent cellular dropouts gracefully.

## 4. Unexploited Browser Features & Capabilities

1. **WebUSB & WebSerial:**
   - *Use Case:* Hardware immersion. Browsers can natively interface with custom HOTAS joysticks, microcontrollers, or physical switches built for the game, giving players visceral hardware control directly to the browser without intermediate drivers.
2. **Page Visibility API & "Tick Decoupling":**
   - *Use Case:* To keep connections alive when users tab out, automatically lower the heartbeat rate. This signals to the host that the player is AFK without dropping them, minimizing bandwidth consumption for stationary tabbed-out users.

## 5. Proposals for Blocking / Spiked Items

### Spike #1: The `quinn` ALPN Demultiplexer 
**Proposal:** Create an isolated Rust binary project. Initialize a single `quinn::Endpoint`. Catch incoming `Connecting` futures. Inspect `conn.alpn()`. If it equals `h3` (WebTransport), feed it into a customized `wtransport::Endpoint` builder. If it equals the `iroh` protocol ALPN, feed it to `iroh::Endpoint`. Prove this routing takes < 5ms and that both protocols can successfully share port 443.

### Spike #2: Deterministic Orbit Simulation
**Proposal:** Rewrite the `Feature 3` logic in Phase 2. Remove all `.set('anomaly', pos)` ticks. Write a pure stateless function: `get_anomaly(eccentricity, semiMajorAxis, epoch_start, current_time)`. This guarantees the Yjs document stays <1MB regardless of how long the station drifts in space. Update the Phase-2 documentation to reflect this.

### Spike #3: Station-in-a-Box TLS / SSL Mitigation 
**Proposal:** For the physical Raspberry Pi node (v005 §12.6), browsers refuse WebTransport capabilities over unencrypted HTTP.
- *Fix A:* Use a captive portal to prompt the user to download a self-signed Root CA upon joining the Pi's Wi-Fi. (Lots of friction).
- *Fix B (Preferred):* Use `.local` mDNS domains with Let’s Encrypt DNS challenges managed by a centralized project DNS server (`station1.furlong.space`). Sync fresh certs to Pi boxes when they briefly hit the internet, allowing seamless HTTPS local play as long as the cert hasn't expired. 