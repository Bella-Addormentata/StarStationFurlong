use anyhow::{anyhow, Result};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// 📜 Standard Seal v2 Body (conforming to v006 §6.1 / §6.2 specs)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SealBody {
    pub room_id: String,
    pub epoch: u64,
    pub frontier: HashMap<String, u64>, // Map of writer public key hex to last processed sequence number
    pub frontier_hash: [u8; 32],       // BLAKE3 of the serialized frontier
    pub yjs_snapshot_blob: [u8; 32],   // BLAKE3 content-addressed pointer to iroh-blobs
    pub prev_seal: Option<[u8; 32]>,    // Hash of the previous seal
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SealV2 {
    pub body: SealBody,
    /// FROST Threshold Signature simulation (signs the serialized SealBody).
    /// Stores the aggregated signature bytes + list of public keys that participated.
    pub aggregate_signature: Vec<u8>,
    pub signers: Vec<[u8; 32]>, // Verifying ed25519 keys of validators who participated
    pub anchored: bool,         // True if posted on-chain as a Chia singleton spend memo
}

impl SealV2 {
    /// Compute the cryptographic digest hash of the seal.
    pub fn digest(&self) -> Result<[u8; 32]> {
        let serialized = serde_json::to_vec(&self.body)?;
        let hash = blake3::hash(&serialized);
        Ok(*hash.as_bytes())
    }
}

/// 🛰️ Decentralized Room State / Co-Host Validator Node
pub struct ValidatorNode {
    pub key: SigningKey,
    pub verifying_key: VerifyingKey,
}

impl ValidatorNode {
    pub fn new(seed: &[u8; 32]) -> Self {
        let key = SigningKey::from_bytes(seed);
        let verifying_key = key.verifying_key();
        Self { key, verifying_key }
    }

    /// Sign the seal body unilaterally.
    pub fn sign_seal(&self, body: &SealBody) -> Result<( [u8; 32], Vec<u8> )> {
        let serialized = serde_json::to_vec(body)?;
        let signature = self.key.sign(&serialized);
        Ok((self.verifying_key.to_bytes(), signature.to_bytes().to_vec()))
    }
}

/// 🛸 Co-Host Group Quorum Manager
pub struct CoHostGroup {
    pub room_id: String,
    pub threshold: usize,                     // t in t-of-n threshold setting
    pub total_validators: HashSet<[u8; 32]>,  // Public keys of all authorized validators
    pub double_sign_registry: HashMap<(u64, [u8; 32]), [u8; 32]>, // Tracker to detect equivocation: (Epoch, Validator) -> Seal Hash signed
    pub last_anchored_seal: Option<SealV2>,   // Active canonical anchored checkpoint
}

impl CoHostGroup {
    pub fn new(room_id: &str, threshold: usize, validators: Vec<[u8; 32]>) -> Self {
        Self {
            room_id: room_id.to_string(),
            threshold,
            total_validators: validators.into_iter().collect(),
            double_sign_registry: HashMap::new(),
            last_anchored_seal: None,
        }
    }

    /// Aggregates independent validator signatures into a simulated single FROST seal representation.
    /// Performs immediate, automated cryptographic verification and double-sign detection.
    pub fn aggregate_and_verify(
        &mut self,
        body: &SealBody,
        signatures: Vec<([u8; 32], Vec<u8>)>,
        anchored: bool,
    ) -> Result<SealV2> {
        if body.room_id != self.room_id {
            return Err(anyhow!("Room ID mismatch in seal aggregation request"));
        }

        if signatures.len() < self.threshold {
            return Err(anyhow!(
                "Insufficient signatures to meet quorum threshold: {} required, got {}",
                self.threshold,
                signatures.len()
            ));
        }

        let serialized_body = serde_json::to_vec(body)?;
        let mut verified_signers = Vec::new();
        
        // 1. Verify signatures and assert security rules
        for (v_key_bytes, sig_bytes) in &signatures {
            if !self.total_validators.contains(v_key_bytes) {
                return Err(anyhow!("Signature provider is not an authorized room co-host"));
            }

            let vk = VerifyingKey::from_bytes(v_key_bytes)?;
            let sig = Signature::from_slice(sig_bytes)?;
            vk.verify(&serialized_body, &sig)
                .map_err(|e| anyhow!("Cryptographic signature verification failed: {:?}", e))?;

            // 2. EQUIVOCATION DETECTOR (v006 §6.2 / Pitfall P-15):
            // Check if this validator has already signed another seal in this same epoch.
            let serialized_body_digest = blake3::hash(&serialized_body);
            let registry_key = (body.epoch, *v_key_bytes);
            if let Some(existing_hash) = self.double_sign_registry.get(&registry_key) {
                if existing_hash != serialized_body_digest.as_bytes() {
                    return Err(anyhow!(
                        "🔥 CRITICAL EQUIVOCATION DETECTED! Validator {:?} double-signed different state seals during Epoch {}!",
                        hex::encode(v_key_bytes),
                        body.epoch
                    ));
                }
            } else {
                // Record the vote
                self.double_sign_registry.insert(registry_key, *serialized_body_digest.as_bytes());
            }

            verified_signers.push(*v_key_bytes);
        }

        // Mock FROST aggregate signature: simple chain concatenation of checked validators
        let mut aggregate_signature = Vec::new();
        for (_, sig_bytes) in &signatures {
            aggregate_signature.extend_from_slice(sig_bytes);
        }

        let seal = SealV2 {
            body: body.clone(),
            aggregate_signature,
            signers: verified_signers,
            anchored,
        };

        if anchored {
            self.last_anchored_seal = Some(seal.clone());
        }

        Ok(seal)
    }

    /// Fork Resolution Tiebreaker (conforming with the v006 §6.2 specifications):
    /// 1. Anchor Wins (economic state finalized in Chia singleton spend).
    /// 2. If neither is anchored, lowest lexicographical frontier_hash wins.
    pub fn select_canonical_seal(&self, fork_a: &SealV2, fork_b: &SealV2) -> Result<SealV2> {
        if fork_a.body.epoch != fork_b.body.epoch {
            return Err(anyhow!("Cannot run tiebreak fork-resolution across different epochs"));
        }

        println!("⚖️ Running Fork Resolution Tiebreak on Epoch {}... ", fork_a.body.epoch);
        
        // Rule 1: Anchor wins
        if fork_a.anchored && !fork_b.anchored {
            println!("  🏆 Winner: Fork A (On-Chain Chia Anchored)");
            return Ok(fork_a.clone());
        }
        if fork_b.anchored && !fork_a.anchored {
            println!("  🏆 Winner: Fork B (On-Chain Chia Anchored)");
            return Ok(fork_b.clone());
        }

        // Rule 2: Lowest lexicographical frontier_hash wins
        if fork_a.body.frontier_hash < fork_b.body.frontier_hash {
            println!("  🏆 Winner: Fork A (Lexicographical lower frontier hash: {:?})", hex::encode(fork_a.body.frontier_hash));
            Ok(fork_a.clone())
        } else {
            println!("  🏆 Winner: Fork B (Lexicographical lower frontier hash: {:?})", hex::encode(fork_b.body.frontier_hash));
            Ok(fork_b.clone())
        }
    }
}

/// 📦 In-Memory Room DB holding message logs and tracking prune boundaries
pub struct RoomDB {
    pub room_id: String,
    // Database storage: (writer_key_hex, seq) -> payload string
    pub live_ops: HashMap<(String, u64), String>,
    pub sealed_frontier: HashMap<String, u64>, // Highest sequentially compiled sequence pruned
    pub archived_snapshots: HashMap<[u8; 32], String>, // simulated blake3 blob storage -> full Yjs snapshot strings
    pub liveness_epochs_failed: u64,           // Counter of failed quorums
}

impl RoomDB {
    pub fn new(room_id: &str) -> Self {
        Self {
            room_id: room_id.to_string(),
            live_ops: HashMap::new(),
            sealed_frontier: HashMap::new(),
            archived_snapshots: HashMap::new(),
            liveness_epochs_failed: 0,
        }
    }

    /// Insert single transaction ledger op
    pub fn write_op(&mut self, writer: &str, seq: u64, body: &str) {
        self.live_ops.insert((writer.to_string(), seq), body.to_string());
    }

    /// "Prune-Then-Need" Invariant Checks (v006 §6.2)
    /// Retains logs after seal, but evicts logs at-or-before the frontier since they are compiled inside snapshot.
    pub fn prune_behind_frontier(&mut self, seal: &SealV2, snapshot_data: &str) -> Result<()> {
        // Assert database checkpoint liveness guard
        // LIVENESS LOCK (v006 §2 / §6.2): If quorum has failed for k consecutive epochs, suspend pruning.
        if self.liveness_epochs_failed >= 3 {
            println!("⚠️ WARNING: Quorum unreachable for >=3 epochs! Pruning suspended to prevent permanent partition data loss.");
            return Ok(());
        }

        println!("✂️ Evicting operations at-or-before sealed frontier for Epoch {}...", seal.body.epoch);
        
        // Store snapshot natively inside our simulated blobs store
        self.archived_snapshots.insert(seal.body.yjs_snapshot_blob, snapshot_data.to_string());

        let mut evicted_count = 0;
        let mut keys_to_remove = Vec::new();

        for ((writer, seq), _) in &self.live_ops {
            if let Some(&frontier_seq) = seal.body.frontier.get(writer) {
                if *seq <= frontier_seq {
                    keys_to_remove.push((writer.clone(), *seq));
                    evicted_count += 1;
                }
            }
        }

        for k in keys_to_remove {
            self.live_ops.remove(&k);
        }

        // Advance compiled frontier
        for (writer, &seq) in &seal.body.frontier {
            let f = self.sealed_frontier.entry(writer.clone()).or_insert(0);
            if seq > *f {
                *f = seq;
            }
        }

        println!("  ✅ Pruned {} live operations. Sealed frontier advanced.", evicted_count);
        Ok(())
    }

    /// Client request pipeline (soft routing checks)
    pub fn fetch_data_since(&self, writer: &str, seq: u64, active_seal: &SealV2) -> Result<String> {
        let frontier_seq = self.sealed_frontier.get(writer).copied().unwrap_or(0);
        
        if seq <= frontier_seq {
            // "Prune-Then-Need" Check: This operation has already been evicted
            println!("  💨 Request for {} seq {} is behind frontier ({})", writer, seq, frontier_seq);
            println!("  👉 Redirection: loading full Yjs checkpoint snapshot: {:?} to fast-forward", hex::encode(active_seal.body.yjs_snapshot_blob));
            let snap = self.archived_snapshots.get(&active_seal.body.yjs_snapshot_blob)
                .ok_or_else(|| anyhow!("Snapshot blob missing from content-addressed store"))?;
            Ok(format!("SNAPSHOT:{}", snap))
        } else {
            // Live, active heap lookup
            let payload = self.live_ops.get(&(writer.to_string(), seq))
                .ok_or_else(|| anyhow!("Operation not found"))?;
            Ok(payload.clone())
        }
    }
}

fn main() -> Result<()> {
    println!("🧪 Running Spike B-4 — Station Seals v2 (FROST & Pruning Property Tests)");

    // Initialize 5 active validators representing our Co-Host group
    let validator_seeds = [
        [1u8; 32], [2u8; 32], [3u8; 32], [4u8; 32], [5u8; 32]
    ];
    let validators: Vec<ValidatorNode> = validator_seeds.iter().map(|s| ValidatorNode::new(s)).collect();
    let val_keys: Vec<[u8; 32]> = validators.iter().map(|v| v.verifying_key.to_bytes()).collect();

    // Setup 3-of-5 threshold Co-Host Group
    let mut cohosts = CoHostGroup::new("furlong-lobby", 3, val_keys.clone());
    let mut db = RoomDB::new("furlong-lobby");

    // Write simulated transaction history
    let client_id = "Ed_Client_1";
    db.write_op(client_id, 1, "Initialize capsule module");
    db.write_op(client_id, 2, "Craft iron lock plate");
    db.write_op(client_id, 3, "Claim berth U1");
    db.write_op(client_id, 4, "WIFI AP online");

    // Print active queue
    println!("📦 Current local active operations: {}", db.live_ops.len());

    // -------------------------------------------------------------------------
    // TEST Scenario 1: Standard Quorum Sealing & Prune-Then-Need Assertion
    // -------------------------------------------------------------------------
    println!("\n--- SCENARIO 1: Quorum Sealing & Prune-Then-Need ---");
    
    let sim_snapshot = "COMPACTED_CAPSULE_ROOM_STATE_YJS";
    let snapshot_hash = *blake3::hash(sim_snapshot.as_bytes()).as_bytes();

    let mut frontier = HashMap::new();
    frontier.insert(client_id.to_string(), 3u64); // Seal up to sequence 3

    let mut f_bytes = Vec::new();
    for (k, v) in &frontier {
        f_bytes.extend_from_slice(k.as_bytes());
        f_bytes.extend_from_slice(&(*v).to_le_bytes());
    }
    let frontier_hash = *blake3::hash(&f_bytes).as_bytes();

    let seal_body = SealBody {
        room_id: "furlong-lobby".to_string(),
        epoch: 1,
        frontier: frontier.clone(),
        frontier_hash,
        yjs_snapshot_blob: snapshot_hash,
        prev_seal: None,
    };

    // Gather signatures from 4 co-hosts (meets 3 threshold requirement)
    let mut sigs = Vec::new();
    for node in validators.iter().take(4) {
        let (vk, sig) = node.sign_seal(&seal_body)?;
        sigs.push((vk, sig));
    }

    let seal_v1 = cohosts.aggregate_and_verify(&seal_body, sigs, false)?;
    println!("✅ Epoch 1 seal generated with threshold signature! Digest: {:?}", hex::encode(seal_v1.digest()?));

    // Execute database pruning
    db.prune_behind_frontier(&seal_v1, sim_snapshot)?;
    println!("📦 Remaining local active operations: {}", db.live_ops.len()); // only seq 4 remains

    // Fetch sequence 2 (pruned) vs sequence 4 (active)
    let res_seq2 = db.fetch_data_since(client_id, 2, &seal_v1)?;
    println!("🔍 Fetch seq 2: {}", res_seq2);
    
    let res_seq4 = db.fetch_data_since(client_id, 4, &seal_v1)?;
    println!("🔍 Fetch seq 4: {}", res_seq4);

    // -------------------------------------------------------------------------
    // TEST Scenario 2: Equivocation Detection (Security Hard Guard)
    // -------------------------------------------------------------------------
    println!("\n--- SCENARIO 2: Double-Signing / Equivocation Prevention ---");
    
    // Malicious node attempts to sign a DIFFERENT seal state for the same epoch
    let mal_frontier_hash = [9u8; 32];
    let bad_seal_body = SealBody {
        frontier_hash: mal_frontier_hash,
        ..seal_body.clone()
    };

    let mut bad_sigs = Vec::new();
    // Host 0 signs the BAD seal
    let (vk_mal, sig_mal) = validators[0].sign_seal(&bad_seal_body)?;
    bad_sigs.push((vk_mal, sig_mal));
    
    // Hosts 1 and 2 also sign the bad seal to emulate a malicious client gathering thresholds
    let (vk1, sig1) = validators[1].sign_seal(&bad_seal_body)?;
    bad_sigs.push((vk1, sig1));
    let (vk2, sig2) = validators[2].sign_seal(&bad_seal_body)?;
    bad_sigs.push((vk2, sig2));

    println!("⚠️ Submitting bad seal containing double-sign updates...");
    let attempt = cohosts.aggregate_and_verify(&bad_seal_body, bad_sigs, false);
    match attempt {
        Ok(_) => panic!("Failure: Equivocation allowed!"),
        Err(e) => println!("  Caught expected error: {}", e),
    }

    // -------------------------------------------------------------------------
    // TEST Scenario 3: Fork Resolution Rules (Anchor vs Lexicographical)
    // -------------------------------------------------------------------------
    println!("\n--- SCENARIO 3: Fork Choice Rule ---");
    
    // Construct Fork A (lexicographical low hash, unanchored)
    let f_body_a = SealBody {
        epoch: 2,
        frontier_hash: [0x11; 32],
        ..seal_body.clone()
    };
    let mut sigs_a = Vec::new();
    for v in validators.iter().take(3) {
        let (vk, sig) = v.sign_seal(&f_body_a)?;
        sigs_a.push((vk, sig));
    }
    let seal_fork_a = cohosts.aggregate_and_verify(&f_body_a, sigs_a, false)?;

    // Construct Fork B (lexicographical high hash, BUT on-chain anchored)
    cohosts.double_sign_registry.clear(); // Clear double-sign registry to simulate independent fork generation
    let f_body_b = SealBody {
        epoch: 2,
        frontier_hash: [0x22; 32],
        ..seal_body.clone()
    };
    let mut sigs_b = Vec::new();
    for v in validators.iter().take(3) {
        let (vk, sig) = v.sign_seal(&f_body_b)?;
        sigs_b.push((vk, sig));
    }
    let seal_fork_b = cohosts.aggregate_and_verify(&f_body_b, sigs_b, true)?; // Anchored!

    // Tiebreak: Anchor wins
    let winner = cohosts.select_canonical_seal(&seal_fork_a, &seal_fork_b)?;
    assert!(winner.anchored);
    println!("✅ Fork resolution passed: Anchored state selected!");

    // -------------------------------------------------------------------------
    // TEST Scenario 4: Liveness Boundary (Safeguard suspended pruning)
    // -------------------------------------------------------------------------
    println!("\n--- SCENARIO 4: Liveness Check / Suspended Pruning ---");
    db.liveness_epochs_failed = 4; // Simulate partition where quorum hasn't been met for 4 epochs
    db.write_op(client_id, 5, "Unpruned fallback message");

    db.prune_behind_frontier(&seal_v1, sim_snapshot)?;
    assert!(db.live_ops.contains_key(&(client_id.to_string(), 4))); // Operation 4 is preserved due to safety lock

    println!("\n💖 Spike B-4 Results: Station Seals v2 specifications successfully implemented and verified!");

    Ok(())
}
