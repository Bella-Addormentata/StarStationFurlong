//! Spike B-1 — five-crate build gate (STUDY-Architecture v006 §15.1 #1).
//!
//! Success = this compiles and runs for desktop AND `aarch64-linux-android`.
//! The body deliberately touches each crate's most basic construction path so
//! the linker cannot dead-strip a dependency away entirely, while staying
//! version-robust (no deep APIs that churn between releases).
//!
//! If a `use` line below fails to resolve on the pinned versions, THAT IS THE
//! SPIKE'S DATA — record the conflict in README.md, do not silently upgrade.

fn main() {
    // yrs — CRDT doc + the sync/Awareness module the node hosts (v006 §3.6)
    let doc = yrs::Doc::new();
    let _awareness = yrs::sync::Awareness::new(doc);

    // blake3 / ed25519 — the SsfLog + envelope primitives (v006 §12.3)
    let hash = blake3::hash(b"star station furlong");
    let signing = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
    let _vk = signing.verifying_key();

    // p2panda-core — Ed25519 signed append-only log primitives (v006 §3.5)
    let p2p_key = p2panda_core::SigningKey::generate();
    let _p2p_pub = p2p_key.verifying_key();

    // wtransport — self-signed ≤14-day identity for the browser pipe (v006 §3.2)
    let identity = wtransport::Identity::self_signed(["localhost", "127.0.0.1"])
        .expect("self-signed identity");
    drop(identity);

    // iroh — endpoint key identity ("dial keys, not IPs", 1.0)
    let iroh_secret = iroh::SecretKey::from_bytes(&[7u8; 32]);
    let _iroh_pub = iroh_secret.public();

    // chia-wallet-sdk + iroh-blobs + p2panda-{net,store,auth} + tokio:
    // linked via Cargo (compilation of the full dependency graph is the gate);
    // touch tokio trivially so at least the runtime is exercised end-to-end.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(async {
            println!("ssf-node-hello: five-crate gate PASSED");
            println!("  blake3 sanity: {}", hash.to_hex());
            println!("  target: {}", std::env::consts::ARCH);
        });
}
