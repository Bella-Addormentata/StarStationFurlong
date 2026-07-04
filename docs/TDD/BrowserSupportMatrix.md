# Browser Support Matrix

> **Purpose:** the single date-stamped source of truth for every browser-platform fact the networking stack leans on. **Re-verify the "Load-bearing" rows before every networking sprint** — v004's Local-Network-Access row went stale within one day of writing (v006 P‑11). Update `Checked` when you re-verify, even if nothing changed.
>
> **Owner:** whoever runs the current networking sprint. **Sources:** MDN compat tables, Chrome release blog, vendor release notes — primary sources only, no secondhand claims.

**Support matrix baseline:** Chrome/Edge, Firefox, Safari 26.4+ (desktop + mobile builds where the feature exists). Feature-detect everything; no single-vendor dependency (Sovereignty Test applies to browser vendors too).

## Load-bearing (re-verify every networking sprint)

| Feature | Chrome/Edge | Firefox | Safari (desktop+iOS) | Checked | Notes / consequence |
|---|---|---|---|---|---|
| `WebTransport` | 97+ | 114+ | **26.4** | 2026‑07‑04 | **Baseline 2026.** Primary browser↔node pipe. Also: WebView Android 97+, Samsung Internet 18+ |
| `serverCertificateHashes` | 100+ | 125+ | 26.4 | 2026‑07‑04 | The CA-free dial. ECDSA P‑256, ≤14-day cert, `allowPooling:false`. WebView Android 100+ |
| WebTransport in Web Workers | ✅ | ✅ | ✅ | 2026‑07‑04 | Network worker may own the WT session (all majors, MDN banner) |
| **Local Network Access gate on WT** | **147+** (prompt shipped 142) | not shipped | not shipped | 2026‑07‑04 | Public origin → private IP dial prompts on Chromium. First LAN dial must come from page context, not a worker. Firefox = smoothest LAN browser |
| `WebTransport.getStats()` | ❌ **No** | 114 partial | 26.4 full | 2026‑07‑04 | Comms-weather uses our own ping/pong datagrams (v006 §3.8) |
| `WebTransport.reliability` / `supportsReliableOnly` | ❌ / ❌ | 114 / ❌ | 26.4 / 26.4 | 2026‑07‑04 | WT-over-H2 is **not** a usable Chrome fallback tier (v004 §3.6) |
| `WebTransport.protocol` (in-WT ALPN) | 143+ | ❌ | 26.4 | 2026‑07‑04 | Firefox lacks it → keep in-band version negotiation (v006 §3.1 note) |
| WebRTC (mesh voice, fallback lane) | ✅ | ✅ | ✅ | 2026‑07‑04 | Main-thread only (not worker-exposed). Proximity voice P2/P3 (v006 §9) |
| `SharedWorker` | desktop ✅ / **Android ❌** | ✅ incl. Android 151+ | 16+ | 2026‑07‑04 | Chromium-Android fallback: dedicated Worker + Web Locks + BroadcastChannel (v004 §3.2) |
| OPFS + `storage.persist()` | ✅ | 111+ | ✅ (iOS can still evict pre-install) | 2026‑07‑04 | Keys must have explicit export/backup (v004 §8.4) |
| `CompressionStream` | ✅ | ✅ | ✅ | 2026‑07‑04 | Baseline — used for RoomLog/OPFS compaction |
| Secure-context rule | — | — | — | 2026‑07‑04 | **Platform rule, all browsers:** `https://`, `localhost`, `file://` only. `http://` LAN IP / `.local` = NO WebTransport/SW/OPFS/WebCrypto (v006 §3.3 — Station-in-a-Box implication) |

## Enhancements (feature-detect; verify when adopted)

| Feature | Status at last check | Checked | Use |
|---|---|---|---|
| `BarcodeDetector` | ❌ not cross-browser (FF absent; Chrome desktop partial) | 2026‑07‑04 | **Never used** — QR = bundled WASM decoder (zxing-wasm), v004 §6.4 decision |
| WebCodecs | Chromium ✅; FF desktop 130+ only; not FF-Android | 2026‑07‑04 | SFU-lite voice path only (P3) — degrade to mesh |
| WebRTC Encoded Transform | Chromium + Safari; FF partial | 2026‑07‑04 | E2EE voice through forwarders (P3) |
| `scheduler.postTask` / `yield` | Chromium + FF | 2026‑07‑04 | Frame pacing under sync storms |
| Document PiP / Idle Detection / Background Fetch / Storage Buckets / Network Info | Chromium-only | 2026‑07‑04 | Opportunistic (v005 §4 #21) |
| Isolated Web Apps + Direct Sockets | Chromium, enterprise/kiosk-oriented | 2026‑07‑04 | **Watch** — would close web first-load asterisk + relay dependency (v006 §14.4) |
| WebAuthn PRF extension | uneven (FF-Android, Android WebView gaps) | 2026‑07‑04 | Passkey key-wrap is feature-detected optional; passphrase/export fallbacks mandatory (v004 §8.4) |
| Encrypted Client Hello (ECH) | Chrome + FF (DNS HTTPS-RR assisted) | 2026‑07‑04 | Relay SNI protection — server-side story = v006 spike #11 |

## Change log

| Date | Change |
|---|---|
| 2026‑07‑04 | Initial matrix created from the v004–v006 verification ledgers (MDN WebTransport table last-modified 2026‑06‑19; Chrome LNA blog updated 2025‑09‑29). |
