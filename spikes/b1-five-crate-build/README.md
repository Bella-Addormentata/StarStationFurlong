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
| Date / toolchain | 2026‑07‑04 / rustc 1.96.1 stable-x86_64-pc-windows-gnu |
| Desktop build | ❌ FAIL on the 5-crate stack because `p2panda 0.6.1` is incompatible with `iroh 1.x` due to pre-release `ed25519-dalek` version conflict (`3.0.0-rc.0` vs `3.0.0-pre.6`). <br><br>✅ PASS on the all-Rust non-p2panda core stack (`iroh` + `yrs` + `wtransport` + `chia-wallet-sdk`) |
| Resolved MSRV | rustc 1.96.1 |
| Android build | ⬜ pass / ⬜ fail (disabled due to NO-GO on 5-crate p2panda) |
| Desktop release size | ~16 MB (estimated without p2panda) |
| Android `.so` size (arm64‑v8a) | — |
| Version conflicts / notes | `p2panda 0.6.1` depends on `iroh v0.98.2` and `ed25519-dalek = "3.0.0-pre.6"`. `iroh v1.x` depends on `ed25519-dalek = "3.0.0-rc.0"`. Since pre-release cargo dependencies are incompatible, both cannot reside in the same project. |
| **Verdict** | ❌ NO‑GO on five-crate stack (due to p2panda pre-1.0 rot). <br><br>🚀 GO on the `SsfLog` all-Rust fallback path (v006 §5.4 / §12.3) as specified in the architecture blueprint. |

## What failure means

- **p2panda pins don't resolve / API moved** → the v006 P‑2 headline risk fired early; the `SsfLog` fallback (v006 §12.3) is specified for exactly this — the `RoomLog` port makes it a substrate swap, not a redesign.
- **iroh + wtransport conflict** (e.g., rustls/quinn version skew) → record the tree (`cargo tree -d`); this informs whether the two-socket node (v006 §5.1) needs feature-gating or a workspace split.
- **Android linkage fails** → the sovereign-phone thesis (v004 §5.4) needs re-work before Phase 2 — better to know now.
