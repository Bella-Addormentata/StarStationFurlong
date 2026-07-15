# v0.29.0 Implementation Plan — Traffic Mesh (M3, M4, M5.0–M5.4; M5.5 stubbed)

**Target release:** v0.29.0 (draft; owner publishes after the two-machine test).
**Scope decision (explicit, per M5 plan §9.4):** Ship the mesh on the **link-trust boundary** — M5.0 through M5.4. **Defer M5.5 (per-tick authorship / origin_lane_id→pubkey binding) as a designed-but-stubbed next increment.** Rationale: M5.5 needs an amortized epoch-signature scheme on the 13B/20Hz datagram lane that the browser cannot participate in (it holds no tick-lane key), and tick spoof resistance is adequately carried by neighbor-trust + TTL + dedup for the 3–8 node target rooms. Wiring it now would gate movement behind a new crypto seam with no functional payoff for this release.

All line numbers are **verified 0.28.0** from the subsystem maps. The design docs' line refs are stale 0.27.0 throughout — ignore them; use the numbers below.

---

## 0. Reconciliation of the maps' contradictions (decide once, up front)

Every map surfaced the same core contradiction: the design docs call peerStore/introductions "node-side," but they **shipped browser-side** (TypeScript, localStorage). This build commits to the following split and does **not** try to move trust into the node:

| Concern | Lives in | This build |
|---|---|---|
| Durable trust tiers, `dialCandidates()`, `hintsFor()` | **Browser** (`peerStore.ts`) | Stays browser-side; it is the trust authority. |
| Sybil admission (`ingestIntroduction` verify→trust→record) | **Browser** (`introductions.ts`) | Stays browser-side for friend-of-friend. |
| Ephemeral live membership (`remote_peers`), liveness, neighbor set, dial, flood, dedup | **Node** (`main.rs`) | All new mesh mechanics land here. |
| Cryptographic membership signal | **Node** `verify_envelope_sig` (main.rs:98-128) | The *only* thing the node can independently check. |

**Hand-off rule over WebTransport (the seam the design never names):** the node cannot see trust tiers, so it **cannot independently vet a dial target**. We bridge trust as follows:

1. The browser remains the party that decides *whether* to hand the node a dial target. It only stamps iroh hints (`YjsSync.#emitEnvelope`, YjsSync.ts:206-215,238-240) for vetted peers.
2. To harden against a compromised/patched browser, the node enforces **"never dial off an `Unsigned` envelope"** (M3): a dial target must arrive inside an envelope whose Ed25519 sig **verifies** (verdict `Valid`, not `Unsigned`, not `Invalid`). This is stricter than today's `sig_should_drop` (which lets `Unsigned` pass).
3. New signed control kinds (roster/mesh-join) carry the subject's own signature so a relayed third-party membership claim is self-authenticating at the node, independent of the introducing browser.

**Consequences we accept for v0.29.0 (documented, not fixed):**
- "Trust-ordered" neighbor selection (M3/M5.3) uses the browser's `dialCandidates()` order, delivered by stamping an optional `trust_tier: u8` on the dial-triggering envelope. The node orders/refuses by that plus its own sig check. Full node-side trust replication is **out of scope**.
- The roster is **not** modeled as an authored Y.Map this release (the node is merge-only on `Room.doc` — no `get_or_insert_map`, no self-origin seq source; authoring is a genuinely new capability). The roster is a plain Rust `RosterTable` in `HubState`, surfaced to the UI via the existing `bridge` status kind (main.rs:1580-1624). Deferred: Y.Map roster (M5.4 optional item).
- `memberHints[0]`-only stamping (YjsSync.ts:209) is **fixed in M4/M5.3** so the node learns the full roster, not one host per envelope.

---

## 1. Linear build sequence (dependency-resolved)

The task's slice order **is** the correct linear order once dependencies are honored. Justification per edge:

```
M5.0  →  M5.1  →  M5.2  →  M3  →  M5.3  →  M4  →  M5.4      [ M5.5 = stub only ]
```

- **M5.0 first** — the unsigned mesh-upgrade dial (main.rs:1452-1506) and the blind-relay-of-all-kinds (main.rs:1035-1064, 1514-1558) are the amplifier. Lifting the tick hop cap (M5.2) or bounding degree (M5.3) over an unsigned control plane echo-storms/spoofs instantly. Close the control plane before opening any flood.
- **M5.1 before M5.2/M5.3** — `remote_peers` is insert-only (inserts 1246/1422/1483, **no `.remove` anywhere**). Every flood site fans out to dead connections. Bounded degree and the tick TTL flood both amplify wasted sends per dead peer; prune first.
- **M5.2 after M5.1** — the tick TTL flood needs the second dedup cache **and** a live target set.
- **M3 before M5.3** — the neighbor set must be trust-ordered; the browser→node trust feed and the never-blind-dial rule must exist before we bound/select neighbors by trust.
- **M5.3 after M3+M5.1** — bounded neighbor set with hysteresis + tier diversity needs both trust order and liveness.
- **M4 after M5.3** — the ChiaHub fall-through hook and dial→relay fallback sit at dial exhaustion, downstream of the neighbor/dial machinery.
- **M5.4 last** — lazy-pull ihave/iwant is a refinement on the narrowed flood; it needs the neighbor set (M5.3) to target and the retained-envelope store built on the deduped lane.

### M5.0 ↔ Slice-2 overlap: what's already shipped vs. still needed

The sig seam map confirms **Slice-2 verify-before-apply is already wired** in 0.28.0:
- `verify_envelope_sig` / `SigVerdict` (main.rs:88-128), `sig_should_drop` (133-157), `canonical_sign_bytes` (80-86), applied on both ysync paths (wt-in 1011, iroh-in 1442).

**What M5.0 still needs** (the seam is verify-before-*apply* for ysync, not verify-before-*admit* for control):
1. A **strict** verdict path for control kinds, **independent of `SIG_MODE`**: `Unsigned ⇒ drop`, `Invalid ⇒ drop`, `Valid ⇒ admit`. Do **not** reuse `sig_should_drop` — default `SIG_MODE=Warn` (main.rs:71) drops nothing and `Unsigned` always passes, which would admit forged/unsigned rosters.
2. Thread the node's iroh `SecretKey` (local in `run()`, main.rs:484) into `HubState` (188-206) so reader loops can node-sign rosters.
3. Replace the raw `iroh_clone.connect` (main.rs:1476) with verify → single-flight (`hub.dialing`) → `dial_peer_with_retry`.

---

## 2. Concrete defaults (with one-line justification)

| Param | Value | Justification |
|---|---|---|
| `TARGET_DEGREE` D | **6** | Design target; O(N·D) fan-out stays cheap for 3–8 node rooms while surviving a single-neighbor loss. |
| `D_LOW` / `D_HIGH` | **4 / 8** | Hysteresis band ±2 around D so a churn blip doesn't trigger graft↔prune thrash. |
| `TICK_TTL_INIT` | **4** | Bounded-degree(6) mesh of ≤8 nodes has diameter ~2–3; 4 gives one hop of margin without unbounded flood. |
| `HEARTBEAT_INTERVAL` | **5 s** | Fast enough that a dead neighbor is caught within a lobby's patience; slow enough to be negligible traffic. |
| `HEARTBEAT_MISS` | **3** (prune at ~15 s silence) | 3× one interval absorbs transient datagram loss before an expensive re-dial/PX. |
| `TICK_SEEN_CAP` | **4096** (reuse `SeenCache` cap) | In safe band: fills in 4096/20≈205 s per sender ≪ 54.6 min u16 wrap, and > in-flight set ≈ 20·D6·TTL4 ≈ 480. |
| **Tick dedup key** | `blake3(origin_lane_id[8B] ‖ full 13B tick)[..16]` | **Payload-inclusive** — structurally eliminates the u16-seq wrap alias (mirrors `envelope_seen_key` including payload, 297-306). Do **not** key on `(origin,seq)` alone. |
| `ENVELOPE_RETAIN_CAP` (M5.4) | **2048 per room** | Covers rate×fanout×diameter for IWANT service; per-room (not the shared global cache) so a busy room doesn't evict recent ids. |
| `discoverable` | **opt-in (default false)** | Privacy floor; a player must consent before ChiaHub/introduction exposure. Matches `makeIntroductions` emitting only `discoverable` cards (introductions.ts:56-69). |
| introductions | **automatic-for-mutuals** | If both peers are mutual contacts (each already trusts the other), auto-introduce — zero friction, and consent is already established both ways; non-mutuals stay manual. |
| `IWANT_RATE` (M5.4) | **≤5/s per peer, bounded map** | Caps the pull-amplification the flood-narrowing was meant to remove; the limiter map is pruned on peer churn so it can't leak. |

---

## 3. Per-slice implementation

Each slice: **(a)** files/functions/lines · **(b)** the change · **(c)** new wire/struct + canonical binding · **(d)** acceptance check · **(e)** hazards.

---

### M5.0 — Signed control plane + close the unsigned dial

**(a) Edit sites**
- `HubState` struct — `main.rs:188-206` (add `secret_key`, prepare for `roster`).
- `HubState` construction — `main.rs:484-490` (thread the iroh `SecretKey` in).
- New helpers beside the sig seam — `main.rs:80-157`.
- Control-kind gates beside — wt-in `main.rs:1011`, iroh-in `main.rs:1442`.
- Mesh-upgrade dial rewrite — `main.rs:1452-1506` (raw connect 1476, election 1462).
- Reuse dial template — WT dial `main.rs:959-1005`; dialer `dial_peer_with_retry` 1168-1190 / `dial_peer_inner` 1196-1291.

**(b) Concrete change**
1. Add `secret_key: iroh::SecretKey` to `HubState`; populate from the `run()` local at 484-490. (Also add `roster: Mutex<HashMap<String, RosterTable>>` now — populated in M5.1/M5.3.)
2. Add `fn is_control_kind(kind: &str) -> bool` matching `"mesh-join" | "roster" | "graft" | "prune" | "px" | "ihave" | "iwant"`.
3. Add `fn control_should_admit(env) -> bool`: compute `verify_envelope_sig(env)`; return `matches!(verdict, Valid)` **only**. Ignore `SIG_MODE` entirely. `Unsigned`/`Invalid` ⇒ `false`.
4. In **both** reader loops, **before** the generic relay/merge, branch: `if is_control_kind(&env.kind) { if !control_should_admit(&env) { continue; } dispatch_control(...); continue; }` — so control kinds are never blind-flooded and never reach `apply_update`.
5. Rewrite the gossip mesh-upgrade dial (1452-1506): keep the smaller-id election (1462) as a de-dupe hint only; require the envelope carrying the third-party origin to be `Valid`-signed; then **claim `hub.dialing`** (mirror 974-976) and **dispatch `dial_peer_with_retry(preset_room=room)`** instead of the inline `iroh_clone.connect` at 1476. This also fixes the inline-await-stalls-the-ysync-reader bug for free.

**(c) New wire / canonical binding**
- New `EnvelopeKind`s (browser mirror `src/network/protocol.ts:18-26`; authoritative Rust `SsfEnvelope` main.rs:31-46): `"mesh-join"`, `"roster"`.
- `mesh-join` payload (JSON, base64 in `payload`): `{ subject_pub, room, epoch, hints: RoomMemberHint }`. **Signed by the subject's identity key** (author = identity pubkey). Canonical bytes: existing `canonical_sign_bytes(v, room, "mesh-join", seq, payload)` — `kind` is bound, so cross-kind replay is free. Add `epoch` **inside payload** for freshness (canonical bytes cover payload).
- `roster` payload: `{ room, epoch, members: [{pub, hints, tier}] }`. **Signed by the node's iroh key** (author = node iroh pubkey; `verify_envelope_sig` already accepts 32B iroh keys). Same canonical scheme with `kind="roster"`.
- **Who-signs-what rule:** rosters = node iroh key; join/graft = player identity key. Admission must additionally check the author key's *role* (node-of-room vs introduced-member) — sig validity alone can't distinguish, both are 32B ed25519.

**(d) Acceptance** — **Single-machine**: unit test that `control_should_admit` returns false for an unsigned and a tampered `mesh-join`, true for a correctly signed one; trace that a forged roster envelope hits `continue` (add a `[CTRL-DROP]` log) and never reaches relay. Compile + one-node boot with `SSF_REQUIRE_SIG=warn` and confirm control drops still fire (independent of mode). **Two-machine**: confirm a real gossip-learned third party is dialed via `dial_peer_with_retry` (bridge status `dialing→connected`) and that `hub.dialing` prevents duplicate dials.

**(e) Hazards**
- **Do not** reuse `sig_should_drop` for control (default Warn admits forgeries; `Unsigned` always passes). Separate verdict path is non-negotiable.
- The rewritten dial must **claim `hub.dialing`** or many gossip envelopes for one dead target storm dials.
- Snapshot connections and **drop the `std::Mutex<rooms>` guard before any `.await`** (dial, open_bi). Current code already does this at 1017-1020/1532-1547 — preserve the pattern.
- Replay: canonical bytes bind room+kind+seq but no time; `seen_envelopes` keys on origin+seq+payload so a re-signed roster with a bumped seq slips dedup. Enforce freshness with the payload `epoch`, not the dedup cache.

---

### M5.1 — Liveness + prune `remote_peers` (greenfield; no removal exists today)

**(a) Edit sites**
- `Room` struct — `main.rs:182-186` (add per-peer metadata).
- Insert sites — `main.rs:1246, 1422, 1483` (stamp `last_seen`).
- Lane-death hooks — datagram lane `main.rs:1327-1330`, ysync `accept_bi` `main.rs:1383-1386`.
- WT ping/pong (the only liveness today) — `main.rs:900-902`.
- Fan-out readers that must skip dead peers — `main.rs:891, 1019, 1367, 1537`.

**(b) Concrete change**
1. Change `remote_peers: HashMap<PublicKey, Connection>` → `HashMap<PublicKey, MemberEntry>` where `MemberEntry { conn: Connection, last_seen: Instant, tier: u8, hints: RoomMemberHint, in_mesh: bool }`. (`tier`/`in_mesh` used by M3/M5.3; set defaults now.)
2. Stamp `last_seen = Instant::now()` at each insert (1246/1422/1483) and on every inbound frame/datagram from that peer.
3. Add a **per-room heartbeat task** (new `tokio::time::interval(5s)` — **no periodic timer exists anywhere in the file today**) that: emits a lightweight node→node `heartbeat` datagram (or reuses ping on the iroh lane, which currently has **none** — only WT has ping/pong at 900-902), and prunes any `MemberEntry` with `last_seen` older than `3×interval`. Pruning **removes the entry and drops the `Connection`**.
4. On lane death (reader loop exits at 1327-1330/1383-1386), remove that peer from `remote_peers`.

**(c) New wire** — node→node `heartbeat` datagram on the unreliable lane (distinct 4-byte magic prefix, not an `SsfEnvelope`, must **not** enter the ysync dedup/merge path). No signature this release (liveness only; spoofing a heartbeat merely keeps a real connection marked live).

**(d) Acceptance** — **Single-machine**: compile; unit-test the prune predicate. **Two-machine (required)**: kill one node, confirm the survivor prunes the entry within ~15 s (add `[PRUNE]` log) and stops issuing `open_bi`/`send_datagram` to it; confirm no false-positive prune under a lossy-but-alive link.

**(e) Hazards**
- Prune must take the `std::Mutex<rooms>` **briefly and never across `.await`**. Heartbeat send itself is `send_datagram` (sync/non-blocking) — safe under the guard; any `open_bi` prune-notice is not.
- `handle_ysync_message` does `rooms.get(room_id).unwrap()` (1703, 1734) — safe **only** because rooms were insert-only. If M5.1 ever removes a whole `Room`, these become panics. **Only prune peers, never Rooms, this release.**
- False-positive prune → re-dial thrash: 3-miss count + hysteresis chosen to avoid it; do not lower `HEARTBEAT_MISS` below 3.
- Heartbeat must be its **own kind**, never routed through ysync dedup+merge.

---

### M5.2 — Tick lane: hop-1 cap → TTL flood + second dedup cache

**(a) Edit sites**
- Origin TTL init — WT origin injection `main.rs:893` (`relayed.push(0u8)`).
- Wire disambiguation — `main.rs:1336-1344`.
- iroh→browser fan-out gate — `main.rs:1345-1356`.
- Relay gate + emit — `main.rs:1362-1372` (`if hop == Some(0)`; `relayed.push(1u8)`).
- Second cache field + init — `HubState` `main.rs:195, 484`.
- Seed at WT origin — `main.rs:891-897` (mirror ysync seed 1030-1033).
- Codec reference (do not edit, but the node now hard-couples to it) — `src/network/protocol.ts:170-176, 196` (u16 seq at [11..13) LE).

**(b) Concrete change**
1. Add `tick_seen: Mutex<SeenCache>` to `HubState` (a **second, tick-scoped** instance beside `seen_envelopes`).
2. Origin injection (893): `relayed.push(0u8)` → `push(TICK_TTL_INIT)` (=4). Semantics flip from up-counting flag to down-counting TTL.
3. Wire parse (1336-1344): for 22B, `ttl = datagram[0]`, `origin_lane_id = [1..9]`, `tick = &[9..]`. For 13B legacy (no TTL): default to **deliver-locally-only, do not relay** (explicit decision at 1340-1341). 14B legacy byte0∈{0,1} reinterprets as ttl 0/1 — benign.
4. **Dedup-before-everything**: compute `key = blake3(origin_lane_id ‖ full 13B tick)[..16]`; `if !tick_seen.check_and_insert(key) { continue; }` **before** both local delivery (1350-1356) and relay (1362).
5. Relay gate (1362): `if hop == Some(0)` → `if ttl > 1` (after dedup-fresh). Emit `relayed.push(ttl.saturating_sub(1))` (replaces `push(1u8)` at 1364), to `remote_peers` where `peer_id != remote_id` (keep 1367 back-edge filter — note it only blocks the immediate back-edge, **not** a 3rd-node return path; the dedup cache handles that).
6. **Seed the origin's own tick** at WT injection (891-897): parse the u16 seq from the browser's 13B tick, insert `blake3(tab_lane_id ‖ 13B tick)` into `tick_seen` so this node's own tick returning through the mesh is dropped (mirror ysync seed at 1030-1033).
7. Keep **fire-and-forget synchronous `send_datagram`** — the tick lane already does this (884/896/1355/1369). **Do not** wrap in `tokio::spawn`/`open_bi` (that would be a wrong copy from the ysync relay template at 1548-1558).

**(c) New wire** — 22B tick wire byte[0] changes semantics: down-counting TTL instead of 0/1 hop flag. No new struct. The node now performs its **first parse of the opaque 13B tick** (reads nothing but hashes the whole 13B — no field extraction needed if we hash the full tick, which is the recommended wrap-alias-proof approach).

**(d) Acceptance** — **Single-machine**: compile; unit-test the dedup gate drops a re-injected identical (lane_id,tick); trace that a 13B legacy tick delivers-only. **Two-machine (required)**: 3-node line topology, confirm a tick from node A reaches node C (multi-hop, proving TTL>1 relay) and that no echo storm occurs (measure per-tick send count is bounded; add a `[TICK-RELAY]` counter). Confirm own-tick seeding prevents self-echo.

**(e) Hazards**
- **Echo storm** — lifting the hop cap **without the dedup gate wired first** = instant broadcast storm in any cycle. Dedup-before-relay is the hard constraint. This is why M5.2 follows M5.0 (control plane closed) and the cache is added in the same commit as the TTL change.
- **u16 seq wrap** — solved structurally by hashing the **full 13B payload** into the key (not `(origin,seq)`). Do **not** oversize `tick_seen` toward ≥65536 "for safety" — that lets stale keys survive a full 54.6-min wrap and reintroduces the alias. Cap **4096**.
- **Opaque-tick coupling** — the node now silently depends on `protocol.ts:170-176` layout. Add a comment at the parse site pinning the codec version; a future tick re-pack breaks dedup with no error.
- **Stale relay targets** — depends on M5.1 prune; until pruned, 20 Hz of doomed sends per dead peer. (Sequenced correctly.)
- **Do not** promote ticks onto the reliable lane.

---

### M3 — Trust-ordered dial + never-blind-dial-unvetted

**(a) Edit sites**
- WT dial trigger — `main.rs:959-1005` (needs_dial gate 961-967, single-flight claim 974-976).
- Gossip dial trigger — `main.rs:1452-1506` (now routed through `dial_peer_with_retry` after M5.0).
- Dialer connect points — `main.rs:1237` (primary), `main.rs:1476` (gossip, removed by M5.0).
- `SsfEnvelope` — `main.rs:31-46` (add optional trust field).
- Browser stamp — `src/network/YjsSync.ts:206-215, 238-240`; browser trust source `src/peerStore.ts:186-193` (`dialCandidates`, **zero consumers today**).

**(b) Concrete change**
1. **Enforce never-blind-dial-Unsigned**: in the WT dial trigger (959-1005), before claiming `hub.dialing`, require `verify_envelope_sig(env) == Valid`. An `Unsigned` or `Invalid` envelope must **not** trigger a dial (contrast today: dial is not sig-gated at all — comment at 1007-1010 explicitly says dial is reachability, not state).
2. Add optional `trust_tier: Option<u8>` to `SsfEnvelope` (default `None`; serde skip_if_none for wire-compat). Browser stamps it from `peerStore` tier when emitting a dial-bearing envelope.
3. Node dial election orders candidates by `trust_tier` descending, then refuses tier 0 / `None` when a higher-tier candidate exists for the same room. Store the tier into `MemberEntry.tier` (from M5.1) on connect.
4. Browser: wire `dialCandidates()` (peerStore.ts:186-193) — currently **unconsumed** — to stamp `trust_tier` on the dial envelope. This is *build the browser→node feed from scratch*, not reorder an existing one.

**(c) New wire / canonical binding** — `SsfEnvelope.trust_tier: Option<u8>`. **Not signed** (the browser is asserting its own local trust; a compromised browser could lie, but the sig-Valid requirement bounds it to keys the browser could already dial). If we want it tamper-evident, fold it into the signed `mesh-join` payload instead — **decision for v0.29.0: keep it unsigned on the dial envelope** (the hard gate is sig-Valid; tier is only ordering). Document this.

**(d) Acceptance** — **Single-machine**: compile; unit-test dial election refuses an `Unsigned`/tier-0 target when a signed higher-tier one is present; trace a `[DIAL-REFUSE]` log. **Two-machine**: confirm a vetted target dials and an unsigned dial-trigger is refused (bridge status shows no dial).

**(e) Hazards**
- **Sybil/slot-denial** — tier ordering must never surface unvetted above vetted; `dialCandidates` already filters+orders browser-side, preserve that.
- Trust is browser-authored → **forgeable**; the only hard node-side signal is sig-Valid. State plainly that a fully compromised browser can still feed vetted-looking targets — accepted for this release.
- Reachability tier is unknowable without attempting the dial (`classify_reachability` is self-only, 250-268) — don't pretend the node can pre-rank by reachability.

---

### M5.3 — Bounded neighbor set (degree cap, hysteresis, tier diversity)

**(a) Edit sites**
- `Room`/`HubState` — `main.rs:182-206` (promote `remote_peers` metadata → a neighbor view).
- WT ysync relay snapshot — `main.rs:1017-1020` (collect) + loop 1035-1064.
- iroh ysync relay filter — `main.rs:1532-1547` (`relay_targets`) + loop 1548-1558.
- Tick relay target — `main.rs:1367`.
- **Do NOT touch** local delivery — down-to-browser 1508-1526, sibling-tab 1079-1105 (those are LOCAL, narrowing them breaks state sync).
- Graft dials route through — `dial_peer_with_retry` 1168-1291.

**(b) Concrete change**
1. Add a `neighbors: HashSet<PublicKey>` derived view per room (or use `MemberEntry.in_mesh` flag from M5.1). Selection: keep at most `D_HIGH`(8) mesh neighbors, target `D`(6); **graft** (dial a new candidate via `dial_peer_with_retry`) when `|neighbors| < D_LOW`(4); **prune** a neighbor (send signed `prune`, clear `in_mesh`) when `|neighbors| > D_HIGH`(8).
2. Narrow **every mesh relay** to iterate `neighbors`, not `remote_peers.values()`: WT ysync (1035-1064), iroh ysync (1532-1558), tick relay (1367). Snapshot the set under the `std::Mutex`, drop the guard before any `.await`.
3. **Eviction policy**: reserve slots for higher tiers (never drop a `direct`/`friend` neighbor to keep an `unvetted` one); **never drop the single bridging mutual** (eclipse guard) — if a neighbor is the only path to a subtree, keep it.
4. **PX-on-prune**: when pruning, send the pruned peer a signed `px` of a few alternative neighbors so it can re-graft. PX-introduced peers **must re-pass the M5.0 admission gate** (no unsigned re-admission).

**(c) New wire / canonical binding** — `"prune"` and `"px"` control kinds, **node-signed** (author = node iroh key), canonical `kind="prune"|"px"`. `px` payload: `{ room, epoch, candidates: [{pub, hints, tier}] }`. Each PX candidate is a *claim* — receiving node treats it as a dial hint that still must be sig-Valid before dialing.

**(d) Acceptance** — **Single-machine**: compile; unit-test graft/prune thresholds fire at the right bounds; confirm relay loops iterate `neighbors` not `remote_peers`. **Two-machine (required)**: a room of 5–8 nodes converges to degree within [D_LOW, D_HIGH]; measure fan-out is bounded; kill a bridging neighbor and confirm eclipse guard + PX re-graft restore connectivity.

**(e) Hazards**
- **Eclipse / slot-denial** — one introducer's PX chain must not fill the neighbor set; enforce a **tier-diversity floor** (e.g. at least one non-`unvetted` slot reserved) and never let PX bypass admission.
- **Lock-across-await** — the classic deadlock; snapshot-then-release at every narrowed loop (existing pattern at 1017-1020/1532-1547).
- **Narrowing the wrong loop** — do not narrow local browser/sibling fan-out; only node→node `open_bi`/tick relay.
- Graft dials must re-enter `hub.dialing` single-flight or a churny room dial-storms.

---

### M4 — ChiaHub rung-6 fall-through hook + dial→relay fallback

**(a) Edit sites**
- Primary hook — `main.rs:1279`, immediately before the "failed" bridge-status write (1280-1290) at the `dial_peer_inner` exhaustion tail.
- Gossip-dial exhaustion twin — `main.rs:1501` (the "staying hub-relayed" arm, 1498-1503).
- Relay-unchanged substrate (fallback target) — `main.rs:1528-1558`.
- Full-roster ingest fix — `src/network/YjsSync.ts:206-215, 238-240` (memberHints[0]-only gap).
- ChiaHub scaffold — `ssf-p2p-node/src/chia_lane.rs` (`resolve_presence` new stub; `derive_hint` note at 72-77).

**(b) Concrete change**
1. Add node-side stub `chia_lane::resolve_presence(target_pub_key) -> Option<ChiaPresenceRecord>` returning `None` today (no chain IO ships).
2. At dial exhaustion (1279), **before** writing "failed": `if let Some(rec) = resolve_presence(target).await` (spawned off the reader loop, **not** holding `rooms`), freshness-check against `rec.expires_at` (advisory — treat past-expiry as absent; scan epoch and epoch-1 for midnight straddle), rebuild `EndpointAddr` from `rec.addrs`+`rec.relay_urls`, run **one** more attempt, then fall back to "failed". Add the comment block: `// [C1-HOOK: ChiaHub rung-6 fall-through]`.
3. Gossip twin (1501): one-line note `// [C1-HOOK] rung-4 gossip exhausted → same fall-through`; route through the **same single-flight resolver** as the primary hook (no inline resolve — this arm has no retry ladder).
4. **Dial→relay fallback**: when the dial (incl. rung-6) exhausts, mark the target relay-only and forward its traffic through the reachable bridging mutual using the existing relay-unchanged substrate (1528-1558) instead of giving up.
5. **Fix memberHints[0]-only** (YjsSync.ts:209): stamp the **full** `memberHints[]` so the node learns the whole roster per bootstrap, not one host. Node ingest populates `remote_peers`/`neighbors` candidates from all hints.
6. Leave a note at `chia_lane.rs:72-77` that person-discovery needs a new **identity-keyed** `derive_hint_by_identity(pub, epoch)` — the C0 scaffold's `derive_hint`/`seal` are **room-key-keyed only**, and at dial-exhaustion the node holds `target_pub_key` but **no room key**. Presence must be self-signed (`encode_signed`) and identity-derived, **not** room-key-sealed. Do not implement now.

**(c) New wire** — none ships (stub returns `None`). `ChiaPresenceRecord` (chia_lane.rs:33-42) is the future record shape; `resolve_presence` is the seam boundary.

**(d) Acceptance** — **Single-machine**: compile; confirm the hook compiles as a no-op (`None` path writes "failed" exactly as today); trace the full-roster ingest now records N hints not 1. **Two-machine**: confirm dial→relay fallback keeps a CGNAT peer reachable through a mutual (this is the real M4 win); rung-6 itself is un-testable until the chain spike lands.

**(e) Hazards**
- **Chain is an address book/metronome, never a pipe** (~19 s blocks vs 20 Hz) — resolved addrs feed the **dial only**; never relay game traffic through anything chain-derived.
- `resolve_presence` is a ~5 s async query — **must** be off the reader/dial loops and must **not** hold `rooms`. The dial already lives in its own task for exactly this reason.
- `expires_at` is advisory — enforce freshness or you hand the dialer the same dead addrs the fall-through exists to escape.
- Re-dial must re-enter `hub.dialing` + re-check `remote_peers` (1212-1221) or a room of dead-hint targets spawns a resolve→dial storm.

---

### M5.4 — Lazy-pull ihave/iwant + retained-envelope store

**(a) Edit sites**
- `HubState` — `main.rs:188-206` (add per-room retained store + per-peer IWANT rate map).
- Control dispatch (from M5.0) — before the generic relay at WT `main.rs:1035-1064` and iroh `main.rs:1514-1558`.
- Dedup gate — `main.rs:1425-1437` (IWANT must be **exempt**).
- Merge path — must **not** reach `apply_update` (1567) for control kinds.
- IWANT unicast template — `main.rs:1551-1557` (must `finish()`).

**(b) Concrete change**
1. Add `retained: Mutex<HashMap<String, LruMap<MsgId, Vec<u8>>>>` per room (cap `ENVELOPE_RETAIN_CAP`=2048) storing serialized recent `SsfEnvelope`s — the existing `SeenCache` holds only 16B hashes and **cannot** serve an IWANT.
2. **MsgId = author+seq (or explicit payload hash)** — **not** `(origin_node_id, seq)`: sibling tabs share `iroh_node_id` with independent seq counters, so `(origin,seq)` aliases distinct payloads (and the dedup key hashes payload too). Use `blake3(author ‖ seq ‖ payload)[..16]` as MsgId.
3. Add a heartbeat-piggybacked `ihave` (list of recent MsgIds) to **neighbors only** (reuse the M5.1 heartbeat task).
4. On `iwant`, **unicast** the retained envelope to the requesting connection only, reusing `[len][json]` + **`finish()`** (the host→joiner fix at 1061/1555 — without `finish()` quinn RESETs and the frame is silently lost).
5. IWANT is **exempt from the dedup gate** (1425-1437) and **never** reaches `apply_update`. Per-peer rate limit (≤5/s); the limiter map is **bounded and pruned on churn**.

**(c) New wire / canonical binding** — `"ihave"` / `"iwant"` control kinds, node-signed, canonical `kind="ihave"|"iwant"`. `ihave` payload: `{ room, ids: [MsgId] }`. `iwant` payload: `{ room, ids: [MsgId] }`. Placed **before** the generic relay so they are per-hop neighbor-only, never blind-flooded.

**(d) Acceptance** — **Single-machine**: compile; unit-test IWANT is served from `retained` and bypasses dedup; confirm rate-limit drops the 6th/s. **Two-machine**: induce a dropped ysync frame (kill+restore a link mid-flood), confirm the receiver IWANTs and converges without a re-flood; confirm `finish()` is called (no silent drop).

**(e) Hazards**
- **Blind-relay-of-all-kinds** (1035/1514/1548) — without the early ihave/iwant branch (return/continue), lazy-pull messages flood uncontrolled, defeating the whole point. The M5.0 dispatch seam must be in place.
- **MsgId aliasing** — `(origin,seq)` pulls the wrong payload; use author+payload-hash.
- **Retained eviction** — per-room store (not the shared global cache) so a busy room doesn't evict recent ids → false IWANT misses / re-floods.
- **`finish()` discipline** on the unicast; do **not** copy the browser-facing no-finish shape (1096-1104/1518-1524) onto node→node.
- **IWANT amplification** — unbounded IWANT re-opens the amplification the narrowing removed; the rate-limit map must itself be bounded/pruned or it leaks per churned peer.

---

### M5.5 — STUB ONLY (deferred; per-tick authorship)

**(a) Edit sites** — tick handlers `main.rs:868-902` and `1326-1376`; reuse `verify_envelope_sig` 98-128 / `canonical_sign_bytes` 80-86 (envelope path — **not** applicable to raw 13B ticks).

**(b) Concrete change** — **none functional.** Add a `// [M5.5-STUB: per-tick authorship]` comment block at the tick relay documenting: bind `origin_lane_id` → trusted pubkey via a **periodic signed epoch key** carried on the **reliable** lane (a 64B Ed25519 sig cannot fit the 13B/22B datagram budget; must be amortized per-epoch, not per-tick). The browser cannot participate (no tick-lane key) — this is a node-only seam.

**(c) Wire** — none this release.

**(d) Acceptance** — compile only (comment).

**(e) Hazards (documented for the next increment)** — until this lands, `origin_lane_id` is minted by unauthenticated `tick_lane_id` (311) and relayed **verbatim** (1365) with zero auth: any admitted neighbor can forge any foreign `origin_lane_id` and flood within its TTL budget. Spoof resistance rests on neighbor-trust + TTL + dedup — **acceptable for 3–8 node trusted rooms**, which is why deferral is safe.

---

## 4. Single-machine (compile + trace) vs two-machine verification

**Fully verifiable single-machine (compile + multi-tab on one node + unit tests):**
- M5.0 control-kind admission verdict logic; forged/unsigned roster drop; sig-independent-of-`SIG_MODE`.
- M5.2 tick dedup gate (identical re-inject dropped), legacy 13B deliver-only default, own-tick seeding — via unit tests + `[TICK-RELAY]` counter. **Sibling-tab fan-out** (879-886) exercises multi-participant on one node.
- M3 dial-election refusal of Unsigned/tier-0.
- M5.3 graft/prune threshold arithmetic; relay loops iterate `neighbors`.
- M5.4 IWANT served-from-retained, dedup-exempt, rate-limit.
- M4 hook compiles as `None` no-op; full-roster ingest records N hints.
- All compile / typecheck.

**Requires the two-machine test before publishing v0.29.0:**
- **M5.1 prune** — real connection death + timing (single-machine can't produce a genuine dead iroh `Connection`).
- **M5.2 multi-hop** — TTL>1 relay reaching a 3rd node; **echo-storm absence** under a real cycle (this is the highest-risk correctness item and is *only* observable across nodes).
- **M5.3 convergence** — degree settling in [D_LOW,D_HIGH]; eclipse guard + PX re-graft after killing a bridging neighbor.
- **M4 dial→relay fallback** — CGNAT peer reachable through a mutual (the actual M4 win).
- **M5.4** — real dropped-frame recovery via IWANT without re-flood.

The owner should not publish the draft until the **two-machine echo-storm check (M5.2)** and **prune/convergence (M5.1/M5.3)** pass — these are the load-bearing safety properties.

---

## 5. Risk / scope honesty

**Most likely to be wrong:**
1. **M5.2 echo storm** — the single highest risk. If the tick dedup gate is placed even slightly wrong (after relay instead of before, or keyed on `(origin,seq)` not full-payload), a real multi-node room storms at 20 Hz. Mitigation is already specified (dedup-before-relay, full-13B key, cap 4096, own-tick seed) but it is *only* provable on two machines. **Commit M5.2's cache and TTL change together; never in separate commits.**
2. **Lock-across-await regressions** — every new heartbeat/prune/roster/graft path is a chance to hold `std::Mutex<rooms>` across `.await` and deadlock all room traffic. The existing snapshot-then-release pattern (1017-1020/1532-1547) must be copied exactly at every new site.
3. **`(origin,seq)` aliasing in M5.4** — easy to write, subtly wrong because sibling tabs share the node origin id. Use author+payload-hash.
4. **M5.0 control gate reusing `sig_should_drop`** — the default-Warn toothlessness admits forgeries silently; the separate verdict path is easy to forget under time pressure.
5. **Trust is browser-side** — the whole "trust-ordered" story rests on a forgeable browser assertion bounded only by sig-Valid. This is a *known* architectural compromise this release does not close.

**Minimum subset that delivers the core traffic-mesh win if time is short:**

> **M5.0 + M5.1 + M5.2 + M5.3.**

That is: a **closed signed control plane** (M5.0), **live membership** (M5.1), the **multi-hop tick flood with dedup** (M5.2 — the actual "traffic mesh" for movement), and a **bounded trust-ordered neighbor set** (M5.3, using M3's never-blind-dial rule folded in as the minimal sig-Valid gate). This gives multi-hop movement + reliable-state relay over a bounded, deduped, pruned mesh — the core win.

**Cuttable to a later point release if needed:**
- **M4** (ChiaHub fall-through is a `None` stub anyway; dial→relay fallback and the full-roster ingest fix are the only functional parts — keep the ingest fix, defer the relay fallback if pressed).
- **M5.4** (lazy-pull is an efficiency refinement; the deduped flood is correct without it, just chattier).
- **M5.5** (already deferred by design).

Ship order to protect the release: land **M5.0→M5.3** first, run the two-machine echo-storm + convergence tests, and only then layer M4's ingest fix and M5.4 if the tests are green and time remains.