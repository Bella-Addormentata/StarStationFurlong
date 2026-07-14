# M5 — Hole-Punched P2P Traffic Gossip Mesh (plan)

**Date:** 2026-07-14 · **Author:** Claude Fable 5 · **Status:** Design — synthesized from a 4-approach × 3-judge design panel; gated on M4 reachability + the M5.0 admission gate. Nothing here is run-verified.
**Companions:** [keyed-identity-contacts-plan.md §7 (M1–M4)](keyed-identity-contacts-plan.md) (the reachability mesh this sits on) · [REVIEW-20260710-ChiaHub.md](REVIEWS/REVIEW-20260710-ChiaHub.md) (rung 6, the discovery floor — distinct from this) · the v0.27.0 keyed-identity build (M1 `peerStore.ts` + M2 `introductions.ts`, already shipped)

Repo root for all paths: `prototypes/0.27.0-core-loop-demo/`.

> **The gap this closes.** M1–M4 are a *reachability* mesh — "how do I find and reach a peer." They do **not** change how game **traffic** is distributed. Today's traffic path is a hub-centric star: reliable ysync state already floods multi-hop with a dedup cache, but real-time **movement ticks are hop-1-capped** (`main.rs:1225-1235`) so a spoke two relay-nodes out never sees them, the whole thing is **single-hub-critical**, and `remote_peers` is **ephemeral and never pruned** (`main.rs:74`). M5 is the *traffic-topology* layer: a resilient, hub-independent, multi-hop overlay.

---

## 0. The one-line answer

**M5 = flood over a bounded, trust-ordered neighbor set** — the ship-first simplicity and redundant-path resilience of a plain flood, capped to a trust-ordered degree so it can't amplify unboundedly or go O(N²) as the room grows, admission-gated by M1/M2 so free-minted keys can't buy relay leverage, and rolled out in slices that **never open the flood before the signature gate is live**.

---

## 1. Decision: the spine and the graft (the design panel)

A panel generated competing overlay architectures and had independent adversarial judges tear them apart. The two decision-relevant designs and the two decision-relevant judges completed; they **disagreed productively**, and the disagreement is the design:

| Judge lens | Picked spine | Core reason |
|---|---|---|
| **Security / sybil** | Gossipsub-adapted (bounded degree D + peer-score clamped by M1 trust) | Only a **degree bound** contains an admitted-but-malicious insider's amplification (O(D), not O(N·E)); a graft trust-floor denies sybils scarce mesh slots. |
| **Resilience / real-time latency** | Pragmatic evolution (lift the hop-1 cap to a TTL flood, minimal diff) | For SSF's real 3–8-node rooms a flood **degenerates to 1 hop** — *beating* today's 2-hop star — and its redundant paths give **zero-repair reroute** under loss/churn. Explicitly: **do NOT import the peer-scoring subsystem** (fiddly, flap-prone, dead weight at these sizes). |

**Chosen spine: Pragmatic flood. Grafted onto it, from the security design:** a **bounded, trust-*ordered* neighbor set** (D_low/D_high hysteresis, ordered by M1 trust tier — *not* a peer-score subsystem), **PX-on-prune** for partition healing, and **IHAVE/IWANT lazy-pull on the reliable state lane only**. This is exactly the convergence both judges point at: "flood over a bounded, trust-ordered neighbor set" gives the low-diameter redundancy and shippability of the flood with just enough degree control to bound amplification (the security win) and O(N²) growth (the scale win), without the game-feel-hostile scoring/flapping machinery.

**Both judges' non-negotiable, adopted as M5.0:** the signed roster/introduction **admission gate must land before any hop cap is lifted** — the existing gossip-upgrade dial (`main.rs:1325`) is *unsigned* today, so opening multi-hop flood over it would turn the mesh into an open amplifier. And both flag the same residual ceiling: the **13-byte tick hot path is unsigned**, so until per-tick authorship exists (M5.5), tick-lane spoof resistance rests on neighbor-trust + TTL + dedup, not end-to-end signatures.

*(Panel note: 2 of 4 designs and 1 of 3 judges failed the run's structured-output cap. The two that completed are the decision-relevant poles; the missing approaches' best ideas are already absorbed — Plumtree's lazy-push = the IHAVE/IWANT graft; "Adaptive star↔mesh" = the fact that the bounded flood *is* a star at N ≤ D.)*

---

## 2. Reusable infrastructure (verified against the code)

M5 is almost entirely a behavioral change to how already-connected sovereign nodes forward — it reuses far more than it adds.

| Component | Location | M5 use |
|---|---|---|
| `SeenCache` + `check_and_insert` (bounded LRU, `blake3(origin‖seq‖payload)`) | `main.rs:160-195`, gate `1284-1293` | The loop-kill for multi-hop flood. Instantiate a **second, tick-scoped** cache (own keyspace) — the tick lane has *no* dedup today. |
| ysync multi-hop forward-with-dedup relay | `main.rs:1377-1406` | The exact structural template; M5 copies it onto the datagram lane (`send_datagram` for `open_bi`) and narrows the target from *all* `remote_peers` to the neighbor set. |
| Gossip smaller-node-id star→mesh upgrade | `main.rs:1297-1355` | The embryonic membership overlay; M5 generalizes its third-party-learn + `self_id < origin_key` dial election into an explicit **signed roster**. |
| `dial_peer_with_retry` / `dial_peer_inner` | `main.rs:1043-1166` | The correct dial entry point (bounded backoff, pre-check, room-bind, bridge status) — replaces the raw inline `iroh_ep.connect()` at `main.rs:1325`. |
| `HubState.dialing` single-flight set | `main.rs:863-865` / `1064` | All roster-driven dials route through it (closes the `1325` bypass) so learning many members can't storm dials. |
| `tick_lane_id` + `[hop][8B lane][13B tick]` wire | `main.rs:200-208,755,777-786,1199-1235` | The stable 8B sender id keys the tick dedup cache; the **hop byte is repurposed from a 0/1 flag to a decrementing TTL**. |
| `SsfEnvelope` + `iroh_*` hint fields | `protocol.ts:28-39` | New signed control kinds (`roster`/`graft`/`prune`/`ihave`/`iwant`) on the reliable lane. |
| **M1** `peerStore` `recordPeer`/`hintsFor`/`dialCandidates` | `peerStore.ts:118-193` | The **durable, trust-ranked** backing for the ephemeral node roster; drives neighbor-selection order + persists learned members. |
| **M2** `introductions` verify→trust→record | `introductions.ts:60-109` | The **sybil boundary for roster admission**; carried in roster control to teach routes to never-card-exchanged members. |
| `keypair` Ed25519 sign/verify | `keypair.ts:82-110` | Signs every M5 control message; verify-before-admit. |

---

## 3. Hard constraints (non-negotiable)

1. **No relays / no TURN.** iroh relays are disabled by default (`main.rs:384-391`); there is no transport fallback. M5 cannot assume any peer is directly dialable — CGNAT peers stay hub/mutual-relayed leaves. This is *why* multi-hop traffic gossip is the goal.
2. **All mesh logic is node-side.** The browser is a thin WebTransport client with no iroh stack and no identity on the tick lane (the node assigns the 8B lane id, `main.rs:755`). Roster, broadcast, dedup, dial election all live in `ssf-p2p-node/src/main.rs`.
3. **Two lanes, opposite semantics.** 20 Hz **unreliable** movement ticks (WT datagram, 13B hot path) vs **reliable** CRDT ysync (bi-stream, Y.Doc merge). The tick flood must tolerate loss/reorder, never block, never be promoted onto the reliable stream.
4. **Raising the tick hop count REQUIRES a tick dedup cache.** The tick lane relies on the hop-1 cap *alone* for loop protection; lift it without a dedup cache and it echo-storms.
5. **`remote_peers` has no liveness today.** Insert-only (`main.rs:74/1121/1278/1332`); M5 must own heartbeat + pruning.
6. **Sovereignty.** Traffic routes through *member* nodes (mutuals relaying for each other — the sovereign alternative to relay servers); no third-party infra, no external reputation service.
7. **Tick-seq wrap.** Ticks carry only a wrapping `u16` seq (~55 min at 20 Hz). The tick dedup window must be provably larger than the in-flight tick set (`rate × fanout × diameter`) or a wrapped seq can alias a fresh one — false-drop legit ticks.

---

## 4. Architecture

**Membership** — a per-room `RosterTable` (`HashMap<room, HashMap<PublicKey, MemberEntry{last_seen, trust, hints, in_mesh}>>`) makes explicit what `main.rs:1297-1355` does implicitly. Members are learned from (a) the *full* `memberHints[]` at bootstrap (fixing the today-only-`memberHints[0]` gap, `YjsSync.ts:174`), (b) signed `roster` control envelopes on the reliable lane, and (c) PX hints on PRUNE. Every learn crosses the WT boundary to `peerStore.recordPeer(trust:'room')` so the durable browser store owns membership across the ephemeral node lifetime. **Every membership-ingest vector — roster, PX, IHAVE-sender — passes the identical M2 `verify→trust→record` gate.** Neighbor selection pulls `peerStore.dialCandidates()` ordering.

**Bounded degree** — each node holds direct hole-punched links to `D` neighbors (`D_low`/`D_high` hysteresis, target ~6), **ordered by M1 trust tier** (direct > room > introduced), with **trust-tier diversity** (reserve a floor of direct-tier slots; cap the fraction of `D` any single introducer's PX chain can supply — closes the eclipse regression). Peers that can't be hole-punched stay off the mesh, hub/mutual-relayed as today. At `N ≤ D` the mesh *is* the complete graph (small rooms pay nothing).

**Tick lane (unreliable, latency-first)** — repurpose the hop byte to a decrementing **TTL** (init ~4, sized to room diameter). On receive: compute `blake3(origin_lane_id ‖ tick_seq)`, look up the **second tick-scoped SeenCache**; if fresh AND `ttl>0`, deliver to local tabs then `send_datagram` `[ttl-1]…` to the **neighbor set only** — fire-and-forget, **no `tokio::spawn`**, never touches the reliable stream. Degenerates to 1-hop delivery in small dense rooms.

**State lane (reliable)** — keep the existing dedup-flood but narrow the eager target to the neighbor set; add **IHAVE/IWANT lazy-pull** (heartbeat piggybacks recent `(origin,seq)` ids; a peer missing one replies IWANT and gets a unicast) so only `D` eager copies traverse and everyone else pulls on demand, converging via Y.Doc merge. Model the roster itself as a `Y.Map` so membership converges over this lane. IWANT is **per-peer rate-limited**.

**Liveness** — a per-room ~heartbeat stamps `last_seen`; a neighbor silent > N intervals is pruned from `remote_peers` *and* the mesh, mirrored to `peerStore` (trust decays), and a replacement grafted from `dialCandidates()` to hold `D_low`. All graft dials route through `hub.dialing` single-flight + `dial_peer_with_retry`.

---

## 5. Phased slices (dependency order — each independently reviewable)

- **M5.0 — Signed admission gate + close the unsigned dial *(PRECONDITION — must land first)*.** Add the signed `roster`/`mesh-join` kind; route the gossip-upgrade dial (`main.rs:1325`) through verify → M2 introductions gate → `hub.dialing` → `dial_peer_with_retry`. **No topology change yet.** *Acceptance:* a forged/unsigned roster entry is dropped; the dial no longer bypasses single-flight; traffic behavior otherwise identical. (Overlaps Slice 2's node verify-before-apply seam — do them together.)
- **M5.1 — Liveness + pruning.** Heartbeat + `last_seen` + prune dead `remote_peers`, mirrored to `peerStore`. *Acceptance:* a killed peer is pruned within N intervals; no doomed sends accumulate; the first liveness the node has ever had.
- **M5.2 — TTL tick flood + tick dedup.** Repurpose hop→TTL; second SeenCache; multi-hop tick delivery replacing `main.rs:1225-1235`. *Acceptance (multi-machine):* in a 3-node line A–B–C where A,C are not directly linked, A's ticks reach C; no echo storm under a bounce loop; small-room (≤ D nodes) tick latency **≤ today's 2-hop star**.
- **M5.3 — Bounded, trust-ordered neighbor set.** Cap fanout at `D` (`D_low`/`D_high` hysteresis), trust-ordered + tier-diverse; PX-on-prune. *Acceptance:* per-node degree ≤ `D_high` in an N-node room; a sybil swarm of free-minted keys occupies **zero** mesh slots and is pruned first; a single-bridging-mutual partition heals via PX.
- **M5.4 — Lazy-pull on the reliable lane.** IHAVE/IWANT on ysync; eager only to neighbors; IWANT rate-limited. *Acceptance:* state converges with only `D` eager copies + on-demand pulls; measured amplification drop vs the full flood.
- **M5.5 — Per-tick authorship *(the residual ceiling)*.** Bind `origin_lane_id` to a trusted pubkey via a periodic signed epoch key so tick spoofing is detectable end-to-end. *Acceptance:* a neighbor forging a foreign `origin_lane_id` is dropped; the 20 Hz/13B budget is preserved (amortized signature, not per-tick).

---

## 6. Threat model — ship with eyes open

**Enforces:** hub-independence (no single critical node); multi-hop reach for ticks (the core fix); **bounded amplification** (degree cap → O(D) eager fanout, not O(N·E)); **sybil slot-denial** (trust-ordered selection + tier diversity + graft floor → free-minted keys get no mesh slots); a signed control plane (forged roster can't hijack routing); loop/echo/replay kill (TTL + dedup on *both* lanes).

**Does NOT (yet):**
- **Per-tick authorship until M5.5.** The 13B tick is unsigned; an admitted/compromised neighbor can forge any `origin_lane_id` and flood it within its TTL budget. This is the sharpest residual gap — tick spoof resistance rests on neighbor-trust + TTL + dedup until M5.5.
- **Fully prevent eclipse.** Mitigated (tier diversity reserves direct-tier slots; flood redundancy needs *all* mutuals controlled to blind a victim), not eliminated — a small bounded degree is inherently more eclipse-exposed than a full flood, which is why the diversity constraint is load-bearing.
- **Prevent a betraying *admitted* insider's junk.** The trust gate limits *who* joins; a per-origin rate cap + prune-on-abuse is reactive, not structural.
- **Beat the reachability ceiling.** In CGNAT-heavy rooms few peers are hole-punchable, so the mesh stays small and most traffic still rides hub/mutual relay — that's M4's problem (and rung 5's), not M5's.

---

## 7. Sovereignty check

No third-party infrastructure introduced. Traffic routes through **member nodes** (mutuals relay for each other — `peerStore.ts:16-17`'s "sovereign alternative to relay servers"); discovery is unchanged (Mainline DHT + mDNS + public-IP echo of *our own* IP); relays stay disabled; there is no rendezvous, TURN, or external reputation service. Trust is user-rooted (cards + introductions) and computed **locally** from signed messages. Bounded degree keeps each self-hosted node's bandwidth predictable — a property that matters precisely because members run their own nodes, not rented capacity.

---

## 8. Ladder placement

M5 upgrades the **traffic rungs**, distinct from ChiaHub's discovery floor:

```
rung 4  hub relay + gossip + punch   → M5 turns this into a resilient multi-hop mesh (was single-hub-critical)
rung 5  player beacon (iroh-relay)   → still the last TRAFFIC resort for CGNAT-both-sides pairs M5 can't mesh
rung 6  CHIAHUB                       → discovery + punch-coordination only; never carries traffic (unchanged by M5)
```

**Depends on:** M1 (`peerStore`, shipped), M2 (`introductions`, shipped), and **M4** (reachability — M4 makes neighbors *connectable*; M5 decides the *overlay* and floods over it). **M5.0 overlaps Slice 2** (the node-side verify-before-apply seam) — the signed-control-plane work is shared, so sequence them together.

---

## 9. Open decisions for the owner

1. **Degree params:** `D` / `D_low` / `D_high` defaults and the direct-tier reservation floor for tier diversity.
2. **TTL default** (a function of expected room diameter) and the tick dedup window size vs the `u16` seq wrap.
3. **Heartbeat interval / miss-count** — the tension between fast churn detection and false-positive prune→re-dial thrash (a game-feel spike).
4. **M5.5 gating:** is per-tick authorship required before the flood is opened on mainnet, or do we ship M5.2–M5.4 on the link-trust boundary and add M5.5 as the next security increment? (Recommend the latter — the link-trust boundary + admission gate is a defensible interim, and M5.5 amortized-signature design deserves its own review.)
5. **Where the roster lives:** node-only `RosterTable` vs modeled as a `Y.Map` on the reliable lane (recommend the `Y.Map` — it converges for free and surfaces to the UI via the existing bridge-status envelope path).
