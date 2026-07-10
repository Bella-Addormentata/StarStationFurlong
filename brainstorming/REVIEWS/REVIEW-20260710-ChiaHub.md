# REVIEW — ChiaHub: The Chia Blockchain as a Sovereign Rendezvous & Punch-Coordination Lane

**Date:** 2026-07-10 · **Author:** Claude Fable 5 (GitHub Copilot) · **Status:** Implementation plan — gated on spike B-7 (chia-wallet-sdk audit); nothing here is run-verified yet
**Companions:** [STUDY-Architecture v007 §4](../AI%20BRAINSTORMING/STUDY-Architecture%20v007.md) (ladder position) · [Cabal discovery plan §4.5](REVIEW-20260707-Cabal-DNS-Free-Discovery-Plan.md) (the other lanes) · [v006 §10.2](../AI%20BRAINSTORMING/STUDY-Architecture%20v006.md) (Chia as coarse clock — this doc weaponizes that idea)

> **The question this answers:** can the Chia blockchain perform the beacon's tasks? Could it be done slowly over multiple blocks? With a standard or custom wallet?
>
> **The answer in one line:** the chain can be the swarm's **address book** and its **metronome** — but never its **pipe**. Two of the beacon's three jobs, at dust cost, with standard wallet primitives, on infrastructure the game already requires.

---

## 1. Scope — split the "beacon" into its three actual jobs

| # | Beacon job | Latency need | ChiaHub verdict |
|---|---|---|---|
| 1 | **Rendezvous** — publish "node X is at addresses A, B, C", let members find it | minutes OK | ✅ **Clean fit** — hinted coin-spend memos (§3) |
| 2 | **Punch coordination** — get two firewalled peers to fire simultaneously | seconds | ✅ **Fits with two tricks** — block-height-as-shared-clock scheduling, and mempool watching for ~5 s signaling (§4) |
| 3 | **Traffic relay** — carry the game when punching fails | milliseconds, continuous | ❌ **Never** — ~19 s block cadence vs 20 Hz datagrams. Symmetric-NAT-both-sides pairs still need a live player beacon (ladder rung 5) |

"Slowly over multiple blocks" is exactly the right model for jobs 1–2: each message is a *single* spend (~1 min to confirm, visible in the mempool in seconds), and the block *cadence itself* becomes the shared clock that replaces live round-trips. Multiple blocks are only needed as a clock, not as a data channel.

**Sovereignty audit:** no DNS, no registration, no TLS CA, no third-party service. The "server" is the chain the game already requires for L3 settlement; any farming player's full node serves light wallets. This is the only discovery lane that keeps working when every relay, DHT bootstrap, and DNS server on Earth refuses us — which is why v007 calls it **the floor of the ladder (rung 6)**.

---

## 2. Primitives used (and explicitly NOT used)

**Used — all standard, wallet-grade:**
- **Coin spends with memos.** A spend's `CREATE_COIN` condition carries a memo list; by ecosystem convention the **first 32-byte memo is a "hint"**, and wallets/indexers support lookup-by-hint (this is exactly how NFT/DID discovery works today).
- **Spend-to-self.** Publishing costs only the fee: spend a 1-mojo coin you own back to your own puzzle hash, attaching `[hint, payload…]` memos.
- **Singletons (optional upgrade, §6).** A per-player "presence singleton" makes the *current* record canonical with a cheap-to-follow lineage — the chia-wallet-sdk already ships DID/singleton drivers.
- **Mempool visibility.** Full nodes see spend bundles seconds after broadcast, long before a block confirms.

**Not used — and ruled out on purpose:**
- ❌ No custom consensus, no protocol changes, no soft forks.
- ❌ No CLVM puzzle is *required* for the MVP (the singleton is an upgrade, and it's a stock puzzle).
- ❌ No DataLayer (its data plane needs HTTP mirrors — servers by another name).
- ❌ No on-chain plaintext, ever (§7).

**Standard or custom wallet?** Standard *primitives*, custom *software*: the node drives these spends itself via the **chia-wallet-sdk** (Rust; already pinned in v006 §12.1 and already scheduled for audit as spike **B-7**). A human with the stock GUI wallet couldn't operate this lane by hand — but nothing about it requires anything the standard wallet protocol doesn't already do. Light-wallet mode works against any farmer's full node; running your own full node upgrades you to the fast path (§4.2).

---

## 3. Job 1 — the Presence Record (rendezvous)

### 3.1 Record format (before encryption)

```json
{
  "v": 1,
  "kind": "presence",
  "node_id": "<32B iroh public key, hex>",
  "addrs": ["192.168.1.79:64330", "[2600:1700:…]:64331", "203.0.113.7:4444"],
  "relay_urls": [],
  "issued_at": 1783627515,
  "expires_at": 1783631115,
  "sig": "<ed25519 over the canonical serialization, by node_id>"
}
```

- `addrs` come from the **live** endpoint view (v0.17.0's F3 fix) — portmapper mappings and `SSF_EXTERNAL_ADDRS` included.
- `expires_at` is advisory (the chain can't delete): readers ignore stale records; writers heartbeat every ~30–60 min and on address change.
- The signature binds the record to the iroh node key — spam to the hint costs an attacker fees and costs readers one signature check.

### 3.2 Encryption & hint derivation — "the room is the key" extends to the chain

Everything on chain is ciphertext addressed by an unlinkable tag:

```text
enc_key  = blake3::derive_key("ssf-chia-lane-enc-v1",  room_key)          → XChaCha20-Poly1305
hint     = blake3::derive_key("ssf-chia-lane-hint-v1", room_key ‖ epoch)  → 32-byte lookup tag
epoch    = floor(unix_time / 86400)   // daily rotation; readers scan epoch and epoch−1
```

- Only room-key holders can find (hint) or read (enc_key) the records — the same blinded-topic discipline as the DHT/gossip lanes (Cabal plan §4.4).
- Epoch rotation stops a passive observer who learned one day's hint from following the room forever.

### 3.3 Publish / resolve flow

1. **Publish:** node spends a 1-mojo self-coin with memos `[hint, ciphertext]` (chunk across a second memo if needed — well under condition-size limits for this payload). Cost: fee only (typically ~0–dust-level mojos; spikes during congestion are tolerable for a minutes-scale lane).
2. **Resolve:** member asks any full node (light-wallet protocol) for coins hinted with `hint` for the current + previous epoch, decrypts, verifies signatures, keeps the newest non-expired record per `node_id`.
3. **Join:** feed the addresses into the normal dial path as hints — this lane is upstream of iroh, not a replacement for it.

Latency: ~1 min confirmed; **~2–5 s if the reader watches the mempool** (§4.2).

---

## 4. Job 2 — Block-Clock Punch Coordination

Hole punching needs *simultaneity*, not conversation. Both sides already share a clock: **the chain's peak height**.

### 4.1 The protocol sketch

1. B (joiner) publishes a **punch intent** (same envelope discipline as §3.2):

```json
{
  "v": 1, "kind": "punch-intent",
  "from": "<B node_id>", "to": "<A node_id>",
  "endpoints": ["<B's live addrs>"],
  "schedule": { "start_height": "H+2", "every_n_blocks": 1, "count": 20, "offsets_ms": [0, 700, 1400] },
  "sig": "…"
}
```

2. A (watching the hint via mempool or chain) publishes a mirroring **punch-ack** with its own endpoints.
3. From `start_height`, **each side fires UDP probes at the other's endpoints every time it observes a new peak height**, at the listed sub-offsets. Peak propagation skew across full nodes is small relative to firewall pinhole lifetimes (~30 s), and the repeated offsets absorb it.
4. Once probes cross (pinholes open), the **smaller node id** performs the real `iroh connect()` with the other's endpoints as explicit hints; the connection then lives entirely off-chain.

### 4.2 Latency tiers

| Reader mode | Signaling latency | Requirement |
|---|---|---|
| Confirmed blocks only | ~1–3 min to first link | any full node via light-wallet protocol |
| **Mempool watcher** | **~2–5 s** | player runs a local full node (opt-in; maximally sovereign; many players farm anyway) |

### 4.3 Honest limits

- **Symmetric NAT (both sides)** defeats endpoint-predictable punching — as it defeats STUN-based WebRTC. Those pairs fall through to a live beacon (rung 5). *(Port-spray birthday tactics exist in the literature; out of scope until measured.)*
- **IPv6 pairs are the sweet spot:** no NAT mapping to predict at all — known `addr:port`, stateful firewalls open on the first outbound probe. Both current playtest machines have global IPv6; this lane alone would likely connect them.
- Clock skew, peak-propagation jitter, and per-router pinhole lifetimes are **measured in the spike (§8 C2), not assumed**.

---

## 5. What ChiaHub explicitly does NOT do

1. **No traffic.** If the punch fails, the game does not fall back to the chain — it falls back to a live player beacon or stays hub-relayed.
2. **No membership authority.** Room membership is still gated by the room key (and the S2 challenge when it lands) — the chain never learns who is "allowed", it only carries ciphertext.
3. **No replacement of faster lanes.** Direct hints, mDNS, DHT, and beacons all outrank it in latency; ChiaHub is the floor that's always there.

---

## 6. The Presence-Singleton upgrade (phase C4)

The MVP's loose hinted coins work but leave history-walking to the reader. A per-player **presence singleton** (stock singleton top-layer, driven by the SDK's existing DID/singleton drivers):

- one canonical *current* record per player (readers track the lineage tip, not a hint scan),
- natural update rate-limiting (one updater — the key holder),
- replay-proofing for free (old states are provably superseded),
- and it composes with the existing L3 story (Station Seals already anchor to singletons — v006 §6).

Cost: slightly more complex spend construction; same wallet-grade primitives.

---

## 7. Privacy & permanence — the section that must not be skipped

**The chain never forgets.** A DHT record expires; a memo is forever. Rules before this lane touches mainnet:

1. **Ciphertext only** (§3.2) — an unreadable record is a meaningless record, even in 2040.
2. **Unlinkable tags** — per-room, per-epoch hints; no cross-room correlation from tags alone.
3. **Burner spend keys** — derive the publishing wallet keys from the room seed, not the player's farming/holding wallet. ⚠️ **Honest caveat:** the *funding trail* of those burner coins still exists on chain; true unlinkability needs care (fund via offers, or accept pseudonymity). MVP accepts pseudonymity; strict-mode players set `SSF_NO_CHIA_LANE=1` and the ladder simply loses its floor for them.
4. **Addresses inside ciphertext only** — never in the clear, never in a hint.

---

## 8. Implementation plan

**Env surface (all opt-in initially):** `SSF_CHIA_LANE=1` · `SSF_CHIA_NODE_URL=<full node RPC / wallet peer>` · `SSF_CHIA_MEMPOOL_WATCH=1` · `SSF_NO_CHIA_LANE=1` (strict override, wins over everything).

| Phase | Deliverable | Acceptance criterion |
|---|---|---|
| **C0** *(= spike B-7, already on the critical path)* | chia-wallet-sdk audit confirms: memo-attach on spend construction, lookup-by-hint query surface, spend-to-self flow, singleton drivers, WASM/browser posture | API table with exact names/versions; **[VERIFY] items in §9 closed** |
| **C1** | Presence records on **testnet11**: publish + resolve behind `SSF_CHIA_LANE=1`, wired as a hint source into the existing dial path | Two nodes on different networks, **no other discovery lane enabled**, resolve each other's live records and complete a dial where physics allow |
| **C2** | Block-clock punch (§4.1) + skew/pinhole measurement | Firewalled-IPv6 pair (the current playtest topology!) establishes a direct link with **chain-only coordination**; measured skew + success table by NAT type recorded |
| **C3** | Mempool watcher fast path (local full node) | Signaling latency ≤ 10 s end-to-end, measured |
| **C4** | Presence singleton + epoch hint rotation + strict-mode audit | Record update = one singleton spend; reader tracks tip; privacy rules of §7 verified against a chain explorer |

Rollout gate to mainnet: C1–C3 green on testnet11 **and** the §7 privacy checklist signed off in a dedicated review.

---

## 9. Open [VERIFY] items (all owned by C0/B-7 unless noted)

1. Exact chia-wallet-sdk APIs for memo attachment + hint queries (names, light-wallet vs full-node RPC coverage).
2. Mempool subscription surface: what a *light* wallet can see pre-confirmation vs what requires a local full node.
3. Current dust-filter thresholds / minimum viable coin value + fee for reliable mempool acceptance.
4. Transaction-block cadence in practice (blocks ~19 s; **transaction** blocks are a subset — measure effective confirmation latency on testnet11).
5. Peak-height propagation skew between independent full nodes (C2 measures).
6. Memo size budget per spend for the ciphertext (chunking needs, if any).
7. testnet11 faucet/funding path for CI-run spikes.

---

## 10. Ladder placement (from v007 §4)

```text
rung 1  UPnP portmapper            [shipped]     fast, works when routers cooperate
rung 2  hints + DHT + mDNS         [shipped]     fast, works for LAN/open-NAT/IPv6-friendly
rung 3  manual port-forward        [shipped]     always works, human effort
rung 4  hub relay + gossip + punch [planned]     one reachable member serves the room
rung 5  player beacon (iroh-relay) [planned]     one volunteer serves everyone — the only TRAFFIC fallback
rung 6  CHIAHUB                    [this doc]    slow, permanent, unkillable — the discovery floor
```

The floor property is the point: rungs 1–5 all depend on *something being up right now*. Rung 6 works as long as the chain the game is built on exists — which is the same assumption the game's economy already makes.
