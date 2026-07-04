# External Code References

## Current stack (architecture of record: [STUDY-Architecture v006](../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md))

| Dependency | Repo | Role |
|---|---|---|
| wtransport | https://github.com/BiagioFesta/wtransport | WebTransport server — browser↔node pipe (UDP 443, cert-hash pinned, `reload_config` rotation) |
| iroh | https://github.com/n0-computer/iroh | Native swarm: QUIC hole-punching, self-hosted relays, Mainline-DHT discovery |
| iroh-blobs | https://github.com/n0-computer/iroh-blobs | BLAKE3 content-addressed asset transfer |
| p2panda | https://github.com/p2panda/p2panda | RoomLog substrate: signed append-only logs, auth groups, encryption *(pre-1.0 — exact-pinned; `SsfLog` fallback specified in v006 §12.3)* |
| yrs / Yjs | https://github.com/y-crdt/y-crdt · https://github.com/yjs/yjs | CRDT room state — yrs hosts y-sync + Awareness on the node; stock Yjs in the browser |
| y-protocols / y-indexeddb | https://github.com/yjs/y-protocols · https://github.com/yjs/y-indexeddb | Browser sync/awareness protocol + instant local-first load |
| chia-wallet-sdk | https://github.com/xch-dev/chia-wallet-sdk | Deeds, CATs, offers, vaults, registry singletons *(browser-WASM surface = spike B‑7)* |
| Tauri 2 | https://github.com/tauri-apps/tauri | Desktop + Android app shell |
| Three.js | https://github.com/mrdoob/three.js | Rendering |
| zxing-wasm | https://github.com/Sec-ant/zxing-wasm | QR decode (cross-browser — `BarcodeDetector` rejected, v004 §6.4) |
| frost-ed25519 | https://github.com/ZcashFoundation/frost | Station Seals v2 threshold signatures + social recovery (Phase 3) |
| Semantics reference | https://github.com/holepunchto/autobase | The Cabal/Autobase *model* RoomLog realizes (JS-only — not linked; v005 §5 Runtime Gap) |

## Inspiration

* Space Trader (web port): https://memalign.github.io/p/spacetrader.html
