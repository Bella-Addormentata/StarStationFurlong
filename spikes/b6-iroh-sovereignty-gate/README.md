# 📡 Spike B-6: Iroh Sovereignty Gate

> **Topic:** Iroh 1.0 GA Sovereignty Gate & Self-Hosted Relay Drill  
> **Status:** ⚠️ **RE-OPENED (2026-07-07)** — prior GO withdrawn; see banner below. *(was: ✅ COMPLETED 2026-07-05)*  
> **Objective:** Verify compilation, linking, and direct peer-to-peer stream handshakes of `iroh 1.0` under isolated, offline-hardened custom presets. Prove we can completely bypass global `n0` DNS, bootstrap DHTs, and default relay mappings to secure extreme metadata privacy and avoid public server rate limits (P-3 / P-4 constraints).

---

## ⚠️ Re-open notice (2026-07-07)

The GO below is withdrawn after the v0.11.1 hole-punch review
([REVIEW-20260707-P2P-Hole-Punching-v0.11.1.md §9.3](../../brainstorming/REVIEWS/REVIEW-20260707-P2P-Hole-Punching-v0.11.1.md)).
Original text is preserved below per repo convention (banners-in-place). Three reasons:

1. **Scope shortfall vs v006 §15.1‑6.** The scoped drill was *self-hosted-relay-only
   (kill DNS, kill relay, kill DHT — record survivals); iroh-WASM maturity;
   refuse-publics proven in config.* What ran instead: two `Minimal`-preset endpoints on
   `127.0.0.1` dialing via explicit `with_ip_addr`. **No relay was ever stood up.** A
   loopback direct dial exercises none of the sovereignty questions this gate exists for.
2. **Evidence gap.** The only artifact, [iroh_test.log](iroh_test.log), records a
   **failed GNU link** (`export ordinal too large: 68463`, compiling `iroh-relay`);
   `target/debug` contains no built binary. Additionally [src/main.rs](src/main.rs)
   never calls `.alpns(b"ssf")` on the accepting endpoint — per iroh 1.0 docs
   (`Endpoint::accept`: "Only connections with the ALPNs configured in `Builder::alpns`
   will be accepted"), the handshake cannot complete as coded.
3. **Downstream damage.** The linker failure pushed `ssf-p2p-node` to
   `default-features = false` + `presets::Minimal`, which stripped the relay lane and
   produced v0.11.1 blocker B2 (dial-by-key with no relay/lookup = guaranteed
   `connect()` failure). The Windows-GNU toolchain limit is therefore **on the
   sovereign critical path**.

### Remaining scope to earn the GO

- [ ] Fix the harness: `.alpns(b"ssf")`, then a **self-hosted `iroh-relay`**
      (`RelayMode::Custom` / relay map) with the two endpoints on **different networks**
      (or network-namespaced), no direct-addr hints — prove relay rendezvous + punch upgrade.
- [ ] Kill-switch survival matrix: kill DNS → kill relay (established connections must
      survive; new dials fail cleanly) → kill everything (offline behavior recorded).
- [ ] Refuse-publics proof: config inspection + packet capture showing zero contact with
      n0 infrastructure.
- [ ] iroh-WASM maturity check vs the 1.0 JS bindings (browser fallback lane).
- [ ] **Toolchain resolution:** MSVC build of this spike + `ssf-p2p-node` with full relay
      features, or a documented minimal feature set that links under GNU.

---

## 📊 Summary of Results

| Metric | Result | Source / Verification |
|---|---|---|
| **MSRV Required** | Rust 1.75+ | Native compilation toolchain |
| **Iroh Version** | `1.0.1` (GA stable) | `Cargo.lock` dependency resolution |
| **Preset Used** | `iroh::endpoint::presets::Minimal` | Conforming to fully private/offline constraints |
| **Hole-Punch Capabilities** | Direct UDP connection traversal | Swarm communication over `EndpointAddr::with_ip_addr` |
| **Sovereignty Boundary** | 100% Offline-hardened | DHT/Relay-fallback pathways disabled cleanly |

---

## 🛠️ Verification Code

A clean, compilable, and self-contained Iroh 1.0 connection mock is implemented under [src/main.rs](src/main.rs).

To execute the test benchmark locally, run:

```bash
cargo run
```

### Architecture Key Discoveries (Iroh 1.x Spec):
1. **Stable Keys over IPs:** Endpoints are uniquely addressed cryptographically by their public key (`PublicKey` aka `EndpointId`), bypassing static host IP dependencies.
2. **Endpoint Addressing:** For peer-to-peer connection paths, addressing is encapsulated inside the `EndpointAddr` structure.
3. **Socket Bindings:** Active local bound sockets are queried via `endpoint.bound_sockets()` rather than utilizing hardcoded port configurations.
4. **Stream Duplex Channels:** Bi-directional reliable transport streams are processed cleanly using standard Tokio async wrappers (`conn.open_bi().await?` and `conn.accept_bi().await?`).

---

## ⚖️ Conformance Decision: GO 🟢

We have successfully proven that **Iroh's 1.0 GA network stack compiles, links, and operates flawlessly on desktop inside private sovereignty bounds**. 

This concludes Spike B-6, clearing the final transport gate for our Phase 2 real-time solar-system traveling and sharded node connections!
