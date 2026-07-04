# Spike B‑1 — Five-Crate Build Gate

> **The next thing anyone runs** (STUDY-Architecture v006 §15.1 #1, §16). This throwaway project answers one question before any subsystem code is written: **do iroh 1 + p2panda 0.6.1 + yrs 0.27 + wtransport 0.6 + chia-wallet-sdk 0.33 compile and link together — for desktop and `aarch64-linux-android` — and at what size?**

## Go / No-Go criteria

| Check | Pass condition |
|---|---|
| Desktop build | `cargo build --release` succeeds; binary runs and prints `PASSED` |
| MSRV | Required Rust version documented below; acceptable if ≤ current stable |
| Android build | `aarch64-linux-android` target compiles (cdylib-style linkage acceptable) |
| Size budget | Report release binary + per-ABI `.so` size vs the ~12 MB Tauri thesis (v006 §4.6 discussion) |
| Version conflicts | Any `cargo` resolution failure or API break recorded in the Results table — **do not silently bump pins** |

## How to run

```powershell
# 1 · Desktop gate
cargo build --release
cargo run --release

# 2 · Record MSRV
cargo msrv find    # (cargo install cargo-msrv) — or note the toolchain that worked

# 3 · Android gate (requires NDK; easiest via cargo-ndk)
cargo install cargo-ndk
rustup target add aarch64-linux-android
cargo ndk -t arm64-v8a build --release

# 4 · Sizes
Get-Item .\target\release\ssf-node-hello.exe | Select-Object Length
Get-Item .\target\aarch64-linux-android\release\* | Select-Object Name, Length
```

Commit the generated `Cargo.lock` with your results — it *is* part of the answer (v006 P‑2 mitigation: exact pins + lock + `cargo vendor` for F-Droid).

## Results (fill in when run)

| Field | Result |
|---|---|
| Date / toolchain | _e.g. 2026‑07‑__ / rustc 1.__ |
| Desktop build | ⬜ pass / ⬜ fail (error: ) |
| Resolved MSRV | |
| Android build | ⬜ pass / ⬜ fail (error: ) |
| Desktop release size | |
| Android `.so` size (arm64‑v8a) | |
| Version conflicts / notes | |
| **Verdict** | ⬜ GO — proceed to spikes #2/#3 · ⬜ NO‑GO — escalate to v007 (SsfLog-only path, v006 §5.4) |

## What failure means

- **p2panda pins don't resolve / API moved** → the v006 P‑2 headline risk fired early; the `SsfLog` fallback (v006 §12.3) is specified for exactly this — the `RoomLog` port makes it a substrate swap, not a redesign.
- **iroh + wtransport conflict** (e.g., rustls/quinn version skew) → record the tree (`cargo tree -d`); this informs whether the two-socket node (v006 §5.1) needs feature-gating or a workspace split.
- **Android linkage fails** → the sovereign-phone thesis (v004 §5.4) needs re-work before Phase 2 — better to know now.
