# Review of STUDY-Architecture v003
**Date**: 2026-07-03
**Evaluator**: Gemini 3.1 Pro (Preview)
**Focus**: Sovereign Serverless Game Mechanics, Web Context, and Network Resilience

---

## 1. Executive Summary & Verdict

**Verdict:** The v003 architecture is a brilliant evolution of the v002 blueprint. By leveraging **WebTransport + `serverCertificateHashes`** and **libp2p WebRTC-direct**, it successfully excises the hidden third-party CA dependency for the browser-to-node bootstrap. Expanding the browser capability surface (OPFS, Service Workers, WebCodecs) effectively bridges the functionality gap between pure-web and native implementations.

However, the architecture heavily leans on leading-edge APIs (WebTransport/QUIC) and assumes a somewhat cooperative underlying network environment, which will struggle in heavily locked-down environments (universities, corporate LANs). Additionally, there are potential economic and persistence pitfalls that require immediate spikes.

## 2. Critical Pitfalls & Errors

### 2.1 The "Hostile Network" Trap (UDP/QUIC Blocking)
- **The Issue:** WebTransport and WebRTC robustly rely on UDP. Many enterprise and university networks (as well as certain cellular carriers) strictly block outbound UDP traffic, except for DNS (53) and NTP (123), via Deep Packet Inspection (DPI).
- **The Pitfall:** If QUIC packets are dropped by a university firewall, the `serverCertificateHashes` WebTransport dial will simply time out. The v003 fallback to `Circuit Relay v2` also relies on libp2p transports, which if exclusively UDP-based, will isolate the player entirely.
- **Why it matters:** Dorms are a primary demographic for gaming. If a dorm blocks UDP and has no IPv6, the player cannot connect to Tauri nodes.

### 2.2 Storage Persistence (`navigator.storage.persist()`) Illusions
- **The Issue:** v003 claims `navigator.storage.persist()` exempts the app from eviction.
- **The Pitfall:** In browsers like Safari/iOS, `persist()` requires explicit PWA installation (Add to Home Screen) and frequent engagement. Even with OPFS, if a user doesn't interact with the PWA for a few weeks, iOS may still silently scrub the data.
- **Implication:** If wallets/keys are stored solely in OPFS without cross-device sync or explicit backup mechanisms, users might permanently lose their accounts upon cache eviction.

### 2.3 Chia Singleton "Mojo Fee" Economics & Surges
- **The Issue:** Rotating certificates every ~12 days requires a new singleton spend on the Chia blockchain with a fee (`max_fee_mojos`).
- **The Pitfall:** If the Chia network experiences sustained congestion (e.g., an inscription/dusting craze), the `max_fee_mojos` configured in `node.toml` may be insufficient for block inclusion. Nodes would silently fail to renew their certificates on the registry, causing sudden, widespread network partition as hashes expire.

## 3. Circumventing Locked-Down Networks (Outside-the-Box Ideas)

To guarantee access for university/dorm networks, we must masquerade traffic or use reliable TCP fallbacks:

1. **Tor Snowflake-style Circumvention:**
   We can implement a mechanism similar to Tor's Snowflake. Browser clients on unrestricted networks can volunteer as ephemeral WebRTC "bridges" for censored users. The censored user connects via heavily obfuscated WebRTC to a normal browser, which then forwards traffic to the Tauri node.
2. **WebRTC over TCP (ICE TCP) via Port 443:**
   Ensure the Tauri node fallback listener supports ICE TCP masquerading as standard HTTPS. When a strict DPI firewall sees TCP traffic over port 443 that mimics TLS handshakes, it often lets it pass.
3. **DNS Tunneling / DoH for Bootstrap Signaling:**
   If all else fails, initial peer discovery and small intent packets could hypothetically be requested via DNS-over-HTTPS (DoH) utilizing TXT records, circumventing captive portals just to get enough peer-IDs to initiate a heavily fragmented UDP hole punch.

## 4. Unexploited Browser Features & Capabilities

Beyond the capabilities listed in v003, the following evergreen APIs offer immense sovereign value:

1. **File System Access API (Chrome/Edge):**
   - *Use Case:* Total Sovereign Modding. Players can point the web client at a local directory containing `.gltf`/`.wasm` mods. The browser reads them directly from disk in real-time without needing IPFS or WebTorrent for local modifications.
2. **SharedWorker:**
   - *Use Case:* While v003 mentions `BroadcastChannel` + `Web Locks`, a `SharedWorker` serves as a vastly superior orchestrator for multi-tab libp2p multiplexing. It holds the single Wasm execution context and memory buffer, eliminating race conditions entirely between tabs.
3. **Web Serial API / WebHID:**
   - *Use Case:* Sovereign hardware integration. A pure browser context can connect directly to custom space-sim hardware logic (HOTAS joysticks, microcontrollers, LED telemetry strips) or even native Hardware Wallets (Trezor/Ledger) without any desktop software.
4. **Web Speech API (Speech Recognition):**
   - *Use Case:* Voice-activated commands (e.g., "Computer, open docking bays") processed entirely offline in the browser through OS-level speech recognition, requiring no third-party cloud API.

## 5. Areas Missing / Requiring Further Study

1. **Key Sync vs. Sovereign Identity:**
   - The design lacks a clear cross-device identity sync mechanism. If a player establishes an account on desktop (holding keys in OPFS + Passkey), how do they seamlessly and securely join via their mobile phone (Issue #12) using the *same identity* if they are joining the chat? Passkeys manage authentication, but not necessarily the CRDT/Yjs identity keys.
2. **WebTransport Congestion Control over P2P:**
   - How does WebTransport's underlying BBR congestion control react to messy, multi-hop relay circuits? A robust study of latency spikes over `Circuit Relay v2` is needed.
3. **Webtorrent "Leech-Only" Browser Limits:**
   - Browsers can seed to other browsers via WebRTC, but cannot seed to native TCP/UDP BitTorrent peers. Does this cause a partition where mobile/web players are pure leeches draining the Tauri nodes? We must measure asset delivery exhaustion.

## 6. Actionable Output & Next Steps
- Implement a fallback WebRTC/TCP transport specifically on port 443 for Tauri nodes to catch players trapped behind UDP-blocking firewalls.
- Create an automated backup/export flow for wallet seeds inside the web UI to preempt iOS/Safari storage evictions.
- Add an explicit key-export/sync strategy (perhaps wrapping the seed phrase in a QR code alongside the WebTransport endpoint for the phone-chat flow).