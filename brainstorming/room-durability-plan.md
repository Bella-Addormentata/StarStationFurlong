# Empty-Room Availability: Client Cache, Co-Hosts & Sealed Snapshots — One Coherent Plan

*Star Station Furlong — what a visitor finds when nobody's home, whether room state can be pulled from members who are elsewhere, and whether the mesh should spread room state to players who aren't in the room. Design synthesis, not code.*

Repo root for prototype paths: `prototypes/0.29.0-core-loop-demo/` (browser: `src/...`, node: `ssf-p2p-node/src/...`). Browser line numbers are exact from the current files; node line numbers are approximate (~) and drift with edits. Everything cited here was read and verified in-source this session; anything not source-verified is flagged.

> **Companions:** [module-wallets-chia-funding-plan.md](module-wallets-chia-funding-plan.md) (chia cost model + the addr-trust invariant this plan inherits) · [keyed-identity-contacts-plan.md](keyed-identity-contacts-plan.md) (reachability ladder; chia presence is rung 6) · [module-transform-docking-adapters-plan.md](module-transform-docking-adapters-plan.md) (module = room = Yjs doc) · `ssf-p2p-node/src/chia_lane.rs` (shipped seal/open/derive_hint — the crypto half of Tier D already exists) · `src/network/protocol.ts` (~54 `DurabilityState{replicas, sealedEpoch, pinned}` and kind `'asset'` — both reserved for exactly this plan).

---

## 1. Executive summary

The owner asked three questions, verbatim:

> "what happens if a person tries to visit a room module and no one else is in the room? can they pull the latest room state from other players that are in other rooms? should the mesh try spread room information to other players even if they are not in a particular room?"

The honest answers:

1. **Today they usually get an empty room.** A visitor with a valid pass whose owner's *browser* is closed lands in the default "Lobby" fallback even if the owner's *node* is still running — because the node's room doc is a **write-only replica**: it merges every update it relays but never answers a relayed SyncStep1 (§1.1, fact 1). Every browser doc is created per-join and destroyed on leave, so nothing browser-side survives either. The room's state exists in RAM on the owner's node and serves nobody.
2. **Yes — and the path already 90% exists by accident.** The pass-prefetch machinery in `roomPasses.ts` keeps a passive `YjsSync` per held pass, and `YjsSync` *answers* inbound SyncStep1 (`YjsSync.ts` ~383). So any pass-holder whose app is open — in *any* room — is already an unwitting co-host, end-to-end over the existing relay path. What's missing is exactly three things: the visitor can't **find** that pass-holder (pass hints carry only the host), nothing works once the pass-holder's app closes (the mute-node gap), and there's no **designation/authorization** story. That's Tier C (Part 4).
3. **Yes — but only sealed, never plaintext.** Spreading room state to non-members is correct and is what `DurabilityState` was reserved for — provided the spread artifact is room-key-sealed ciphertext (XChaCha20-Poly1305 via the shipped `chia_lane::seal`), content-addressed by blake3, publisher-signed. Non-members can *hold and serve* what they can never *read*. Plaintext reach tracks the pass; ciphertext reach is unbounded. That's Tier D (Part 5), and the invariant is Part 2.

### 1.1 Ground truth today (verified in code this session)

1. **The node never answers a relayed SyncStep1.** `handle_ysync_message` (main.rs ~2804) runs only on the WT-in path (local browsers). On the iroh-in path (~2281) a ysync frame is blind-decoded as `Update::decode_v1`; a subtype-0 SyncStep1 fails decode and is **silently dropped**. This one asymmetry is the whole reason a room dies when its browsers close.
2. **Browser docs are ephemeral by construction.** Fresh `Y.Doc` per join; destroyed in `leaveRoom()` (`main.ts:845`, `YjsSync.stop()` at `YjsSync.ts:136`). Nothing is persisted anywhere — not browser, not node disk.
3. **The prefetch is an accidental co-host.** `roomPasses.ts` per-pass passive syncs answer SyncStep1 today; only discovery and lifetime are missing.
4. **All the hard machinery already ships:** M4 member-hint parallel dial (main.rs ~1429), DHT dial by node-id only (~2155), strict-sig control plane (`control_should_admit` ~2420) with the ihave/iwant retain machinery, browser Ed25519 identity + name certs, the `cap` lane that **already hands the node the room key** (main.rs ~1351), and live testnet11 chia publish/resolve. This plan is overwhelmingly *composition*, not invention.

### 1.2 Which tier fixes which failure — the honesty table

Tiers: **A** = client IndexedDB cache · **B** = node disk persistence (falls out of C4/D0 — same mechanism) · **C** = co-host replication set · **D** = sealed snapshots on the mesh.

| # | Scenario | Today | A | B | C | D |
|---|---|---|---|---|---|---|
| S1 | Returning visitor rejoins a live room | full-doc resync, transit-curtain wait | ✅ instant paint, delta-only sync | — | — | — |
| S2 | Owner reloads browser mid-session | **rename-revert bug** (documented, `main.ts:654–658`) | ✅ closed as a side effect (§3.2) | — | — | — |
| S3 | Owner's node restarts, owner returns | room state gone (RAM-only doc) | ✅ cache re-seeds node via SyncStep2 | ✅ disk reload, zero browsers needed | — | — |
| S4 | Visitor joins; owner's app closed, machine on | **empty Lobby** (mute node) | ❌ no cache on first visit | needs C2 to serve | ✅ C2 alone fixes this | ✅ |
| S5 | Visitor joins; owner's machine off, a co-host reachable | empty Lobby | ❌ | ❌ | ✅ grants + hint ladder | ✅ |
| S6 | First-time visitor; every member's *app* off, one member *node* cold | empty Lobby | ❌ | ❌ | ❌ (a co-host must be live) | ✅ D3 restore from sealed snap |
| S7 | Every node everywhere off | nothing | ⚠️ offline view of rooms *you've* visited | ❌ | ❌ | ❌ data; ✅ chia anchor still proves what the latest *was* |
| S8 | Staleness detection ("is this actually current?") | none | ❌ | ❌ | ⚠️ human-visible `stateEpoch` hint | ✅ anchored pointer outranks every holder |

No tier is redundant with another; each closes rows the previous can't. S7-data is **unsolvable by design** — availability with zero holders online is not promised, and pretending the mesh "just holds it" without incentives would be fiction (§5.5).

### 1.3 The recommendation

**Ship Tier A now (~180 LOC, browser-only, no deps), then C2 standalone (the node answers SyncStep1 — the single highest-value node change in this entire plan), then B/D0 (disk), then the C designation layer, then D.** Full ordering with rationale in Part 6. Tier A's snapshot blob is byte-identical to what Tier D seals — nothing built early is thrown away.

---

## 2. The one invariant (say it every time)

**Spread SEALED state, never plaintext — reach tracks the pass.**

- **Plaintext room state lives only where the room key legitimately lives:** browsers holding the pass (`roomKeyB64`), and their local node via the shipped `cap` lane. Tier A's IndexedDB cache, a co-host's RAM/disk doc (a co-host is by definition a pass-holder), and the owner-node's disk copy all sit *inside* this boundary — same trust surface as holding the live doc in memory today.
- **Anything replicated beyond membership is ciphertext:** `seal(room_key, signed_body)`, blake3-addressed **over the ciphertext** so keyless holders can self-verify integrity of what they store and serve without ever being able to read it. Forgery fails three independent ways (AEAD tag, publisher ed25519 sig, content hash).
- **Serving is a membership question, not a reachability question.** A node answering SyncStep1 hands out plaintext-equivalent state; gate it (C6's `roomProof`, a room-key-derived keyed hash — finally using the `challenge` field the bootstrap reserved).
- **Carried over unchanged from the presence lane:** discovery records prove *authorship, not address ownership*. Chia-resolved or hint-carried addrs are self-declared; filter to public, treat as extra probes, and let the node-id-authenticated dial (DHT/host-observed routes preferred) be the actual trust event. Neither a co-host grant nor a sealed snapshot launders addr-trust or membership-trust.
- **CRDT corollary (Tier A/D specific): never "clean" a restored doc before sync.** Locally deleting seemingly-stale entries pre-merge creates real tombstones that propagate and delete *live* peers' state. Staleness is repaired by merge, never by local deletion. Same reason Tier D snapshots are raw `encodeStateAsUpdate` history, never compacted rebuilds (§5.1).

---

## 3. Tier A — client-side room-doc cache

### 3.1 Mechanism: hand-rolled snapshot cache, not y-indexeddb

One IndexedDB database (`ssf-room-cache`), one object store, key = `roomId`, value = `{ update: Uint8Array, savedAt, lastUsedAt, bytes, owned }` where `update = Y.encodeStateAsUpdate(doc)` — a **full self-contained snapshot**, not an update log.

Why not y-indexeddb, specifically for this codebase:

- **Lifecycle mismatch.** y-indexeddb assumes a long-lived doc it owns; we create a doc per join and destroy it on leave. Rapid room swaps (`performRoomSwap` = leave→join) would race its async open/compaction against `doc.destroy()`. The epoch-guard pattern in `joinRoomAtEpoch` needs restore to be one awaitable read we control.
- **One IDB database per doc name** makes cross-room LRU and size accounting an `indexedDB.databases()` enumeration; one store keyed by roomId makes it a cursor walk.
- **The snapshot blob IS the Tier D artifact.** `encodeStateAsUpdate` from an empty state vector is exactly the byte string Tier D seals and content-addresses, and what Tier B hands the node for disk. y-indexeddb's internal log format is not reusable. The Tier A writer *is* the future snapshot producer.
- **House style.** The codebase hand-rolls the y-sync wire (`YjsSync.#packYSyncPayload`) and every storage module (`roomPasses.ts`, `contacts.ts`, `identity.ts`) is a small try/catch-everywhere file. `roomCache.ts` follows the pattern. IndexedDB over localStorage: binary blobs without base64 inflation, async reads, and the 5 MB localStorage quota is already shared.

### 3.2 Restore semantics — apply BEFORE `sync.start()`, never after

Insertion point: `joinRoomAtEpoch`, between `new YjsSync(...)` (`main.ts:544`) and `await sync.start()` (`main.ts:551`) — above the "No awaits below this line" barrier at `main.ts:564`, with the existing epoch-guard mirrored after the await.

Why *before*, precisely:

- **State-vector economics.** `start()` sends SyncStep1 carrying our SV (`YjsSync.ts:190`); pre-applied cache means the host ships only the genuinely missing delta. Applied after, the empty SV pulls the full doc *and* the `doc.on('update')` hook attached in `start()` would echo the entire cached snapshot back out as one giant Update frame. Before `start()`, restore is silent.
- **CRDT idempotence makes every interleaving safe.** Ops are `(clientID, clock)`-identified; duplicates are no-ops; cache-then-network and network-then-cache converge identically. If the cache is *ahead* of the host (host restarted), our SyncStep2 answer to the host's SyncStep1 (`YjsSync.ts:383–389`) heals the mesh — **this is the owner-restart recovery path**: browser cache re-seeds the node's empty yrs doc, and through it, the room.
- **The `claimRoomDefaults` race gets better, not worse.** Today the claim (`main.ts:659`) always fires on an empty replica and races inbound real state — the documented rename-revert bug. Cache-first, an ever-synced owned room has `owner` present → claim skipped → bug closed. A genuinely new room has no cache → claim fires exactly as today. The E4 furniture seed stays doubly suppressed (`whenServerSynced` + `furnitureDocSize() === 0`, `main.ts:674–682`).

**One mandatory counter-fix — stale cache satisfies freshness probes.** Two places treat "roomInfo has an owner" as "host answered". The transit gate (`awaitInitialRoomState`, `main.ts:902`) being cache-satisfied at t=0 is the *desired* instant-load win (the `roomMap.observe` repaint live-updates). But the v0.29.7 backfill retry loop (`main.ts:747–758`) stopping on owner-presence would freeze on stale state if the resync-on-connected is swallowed (the documented prefetch single-flight case, `main.ts:739–743`). **Fix: key the loop on `sync.serverSynced`** — a 3-line getter over the existing `#serverSynced` (`YjsSync.ts:88`). That is the true "host answered" signal.

**Persist side:** a second `doc.on('update')` listener (they stack), trailing-debounced ~1 s; flush on `whenServerSynced` and in `leaveRoom()` — encode **synchronously before** `await sync.stop()` destroys the doc (`main.ts:857–860`), fire-and-forget the put. Optionally wire into the `roomPasses` prefetch docs: pass rows show real names instantly, and rooms you're *not* in stay warm.

### 3.3 Storage bounds & policy

Typical decorated room with history: **tens of KB; worst realistic ~0.5 MB.** The unbounded term is chat (`main.ts:1642` pushes, nothing deletes).

- **Cap chat in the doc, not just the cache:** at the push site, trim beyond 200 entries inside the same transact. CRDT-safe (concurrent trims delete overlapping ranges idempotently) and it bounds sync cost at the source — matching the stated "session-capped demo storage" intent (`YjsSync.ts:11`).
- Per-room cap 1 MB (skip put + warn); ~50 MB / ~50 rooms total; **LRU evicts non-owned rooms first, never `owned` ones** (your copy may be the only one in the universe — which is precisely why Tiers B/C/D exist). Call `navigator.storage.persist()` once; browsers still evict under pressure (Safari's 7-day rule), so Tier A is a cache, not durability.

### 3.4 Slice (~180–190 LOC, no new dependencies)

| File | Change | ~LOC |
|---|---|---|
| `src/roomCache.ts` (new) | IDB open, `loadRoomSnapshot`, `attachRoomCache`, `flushRoomSnapshot`, `deleteRoomSnapshot`, LRU, `storage.persist()`; try/catch throughout (privacy-mode IDB failure degrades to no-cache); header documents the do-not-clean invariant | ~140 |
| `src/main.ts` | Epoch-guarded restore between :544 and :551; attach writer; final flush in `leaveRoom`; backfill loop → `serverSynced` (:752); chat cap (:1641) | ~35 |
| `src/network/YjsSync.ts` | `get serverSynced(): boolean` | 3 |
| `src/roomPasses.ts` (optional) | prefetch-doc restore/persist | ~12 |

Risks: corrupt blob → `Y.applyUpdate` throws → delete blob, proceed empty (today's behavior). Multi-tab last-writer-wins is benign (both tabs converge through the same local node). No epoch/dependency hazard — full-blob snapshots can never apply a delta with missing dependencies (another reason over y-indexeddb's log). Trust surface: unchanged (plaintext only where the pass already is).

---

## 4. Tier C — co-host replication set (`DurabilityState.replicas` realized)

### 4.1 Designation — where the set lives, how it's authorized

**A `coHosts` Y.Map inside the room doc itself**, keyed by co-host identity pubkey. The co-host set *is* room state: it replicates to every member via the T0 bind seam, pass-minting reads it synchronously, and it survives via the very replication it configures. Grant value: `{ identityPubB64, nodeId, relayUrls, grantedAt, ownerSigB64 }` — owner sig over domain-tagged canonical bytes (`ssf-cohost:v1:<roomId>:<identityPubB64>:<nodeId>:<grantedAt>`), same pattern as `nameCertBytes`. Revocation is a signed **tombstone record** (`ssf-cohost-revoke:v1:...`), never a map delete — so it replicates and can't be un-merged by a stale replica. The `nodeId` binding is load-bearing: it authorizes a *dial target*, not just a person.

**Trust-anchor problem, stated honestly:** "the owner" is currently `roomInfo.owner` = a UUID resolved through the players map — itself raceable CRDT state. Fix at the pass layer: **`RoomBootstrap` v2→v3 adds `ownerPubB64`**, and `sigB64` (reserved at `protocol.ts` ~94) actually signs the pass including it. The pass is obtained out-of-band from someone you trust — it is the root of trust; verification chains pass → ownerPub → grant sig → (identityPub, nodeId). **This same field is Tier D's publisher-trust bootstrap — design it once** (Part 6).

UX: owner long-presses a roster row (keys + verified certs already on hand via `verifyNameCert`) → "Make co-host"; grantee's `nodeId` comes from their contact card.

### 4.2 Behavior — two nested availability tiers, cheapest first

**C-a. App-open co-host (mostly exists).** A client seeing its own verified grant: (1) keeps that room's prefetch warm permanently — the only change to `roomPasses.ts` is *never demote a co-hosted room to `offline` / never give up*; (2) sends the node a **`cohost` envelope** on the WT lane (consumed locally like `cap`, never relayed): `{ roomId, roomKeyB64, grant }`.

**C-b. Node-level co-host (the real Tier C change).** The node marks the room `served` and **answers iroh-in SyncStep1 from its own doc**: in the iroh-in ysync branch (main.rs ~2281), if the payload parses as subtype-0 and the room is served, build SyncStep2 exactly as `handle_ysync_message` does (`encode_diff_v1` against the client SV) and `send_framed` it **directly back on the receiving connection — never through relay fan-out** (echo/dup risk if misrouted; browsers already accept unsigned SyncStep2 as node-origin). That's the whole change: `rooms` never prunes, the iroh listener already accepts any inbound conn, `mesh_maintenance_loop` already heartbeats — the node was already a durable dialable replica; it was just **mute**. Gate on `served` rather than answering for every room (a visitor's own empty-doc node shouldn't advertise authority; an empty SyncStep2 is CRDT-harmless anyway).

**B, scoped here because co-hosts make it matter:** persist served rooms' docs (debounced yrs `encode_state_as_update` → `rooms/<roomId>.bin` beside `iroh_node_id.key`; load at startup, re-mark served) plus the cohost registration + room key. Room key at rest on a pass-holder's machine is inside the trust invariant — say so in release notes. The same mechanism applied to the owner's own rooms **is Tier B for free**.

### 4.3 Bootstrap — finding a co-host when the owner is offline

A strict ladder, all funneling into `dial_peer_with_retry`, all existing machinery:

1. **Pass member hints (fast path).** `buildOutgoingBootstrap` (`main.ts` ~1731) additionally merges every verified `coHosts` grant (nodeId + relayUrls) at mint time. M4 already dials **all** hints in parallel (~1429); any answering co-host bootstraps the room. Old host-only passes keep working.
2. **DHT by node-id (stale-addr healing).** Hints carry node ids; iroh resolves rotated IPs by node-id via Mainline — the same node-id-only discipline the gossip dial enforces (~2182). Zero new code; it's why stale hint *addresses* are survivable.
3. **Chia presence lane (rung 6, the floor).** A co-host node holds the room key (from `cohost` ingest) → it can heartbeat-publish room-key-sealed presence for served rooms **even with no browser attached**; on dial exhaustion the visitor resolves *any* member record for the room (`resolve_by_room_key`), not just a named target — one resolved co-host yields a dial that gossips in the rest. Addr-trust rule holds throughout (Part 2).

**Hardening (not a blocker):** require SyncStep1 to carry `roomProof = blake3::keyed(room_key-derived key, canonical_sign_bytes)` before a served node answers — both ends can compute it via the `cap`/`cohost` key material. Ship warn-then-enforce, mirroring `SSF_REQUIRE_SIG`.

### 4.4 Write authority while the owner is away — recommended policy

**Writes stay open; tag, don't gate.** Every ysync update is already author-signed and CRDT-merged; the returning owner merges visitor edits losslessly. A read-only mode would need the node to deep-decode which Y maps an update touches (heavy) or clients to self-censor (not enforcement). Socially, "friends can rearrange my room while I'm out" is the product — a co-host is a trusted member. Concretely: default open; **soft gate** via `roomInfo.stewardship: 'open' | 'owner-present'` (edit-mode UI disabled + "station on caretaker power" banner when the owner is absent — advisory-honest, matching the S2 warn-mode posture); **hard gate arrives with Tier D's seals** (owner's seal policy declares the unsealed tail discardable or mergeable) — don't build a bespoke ACL interpreter that seals will obsolete.

### 4.5 Failure & consistency

- **Co-host divergence:** disjoint visitor sets converge the moment any mesh path links them; duplicate SyncStep2s are idempotent merges. This is what CRDTs are for; no protocol work.
- **Owner rejoins:** bidirectional merge; only LWW map keys (room name, a doubly-moved furniture item) can "conflict," and LWW is already the app-wide semantic.
- **Stale co-host:** serves old-but-valid state; monotonicity means stale can *delay*, never *revert*, once any fresher peer is reachable. The dangerous case — a stale-or-**malicious** co-host as the *only* replica — is honestly scoped: node-served SyncStep2 is an unsigned merged diff, so a hostile co-host can fabricate state; Tier C's mitigation is that co-hosts are owner-signed trusted members, and Tier D polices it mechanically (anchored `sealedEpoch` + content hash; client flags/refuses regressions). Cheap precursor: owner bumps `roomInfo.stateEpoch`; UI shows "records as of epoch N."
- **Replicas HUD:** `DurabilityState.replicas` = verified grants whose node currently answers, surfaced diegetically as "station records backed up ×N."

### 4.6 Slices

| # | Slice | Files | Risk |
|---|---|---|---|
| C1 | `coHosts` map + grant/revoke sigs + owner UI + verification | new `src/coHosts.ts`; `main.ts`; `keypair.ts`; `protocol.ts` (pass v3 `ownerPubB64`) | Low. Grant verification must use pass-anchored ownerPub, never the raceable players map. |
| C2 | Node serves: `cohost` envelope, `Room.served`, **iroh-in SyncStep1 answer** | `main.rs` (~1351 ingest, ~2281 answer, `Room` ~306) | Medium. Answer must be point-to-point on the receiving conn; build diff under lock, send after drop. Test: 3 nodes, host kills app, visitor cold-joins via co-host. |
| C3 | Pass hints carry co-hosts; co-host prefetch never gives up | `main.ts`, `roomPasses.ts` | Low. Cap merged hints (co-hosts + owner first) vs envelope growth. |
| C4 (=B) | Disk persistence of served rooms + registration | `main.rs` + small format file | Medium-low. Corrupt file must fail open (fresh doc). |
| C5 | Chia: nodeless heartbeat publish + resolve-any-member on exhaustion | `chia_publish.rs`, `chia_resolve.rs`, `main.rs` | Low-medium. `SSF_CHIA_LANE=1`-gated; funded testnet11 dev wallet exists. |
| C6 | `roomProof` on SyncStep1 + `stewardship` soft gate + replicas HUD | `main.rs`, `YjsSync.ts`, `NetworkProvider.ts`, `main.ts` | Medium. Version skew → warn-then-enforce. |

**Ordering note: C2 alone is independently shippable** before any designation UI exists (interim gate: `served` iff this node's browser ever claimed defaults for the room). It converts every "owner left the browser but not the machine" room from dead to alive — the highest-value single change in this plan.

---

## 5. Tier D — room-key-sealed snapshots on the mesh

The crypto half already ships and is unit-tested (`chia_lane.rs` seal/open/derive_hint/encode_signed); the control-plane half mirrors the proven ihave/iwant machinery; `protocol.ts` reserved the wire kind (`'asset'`) and the HUD fields. Tier D is assembly.

### 5.1 Format

```
SnapshotBody { v:1, room_id, seq (unix-ms, monotonic per publisher),
               publisher_node_id, created_at, y_update_b64 }

signed  = encode_signed_generic(body, iroh_secret)   // ed25519, same wrapper shape as SignedRecord
sealed  = chia_lane::seal(room_key, signed)          // 24B XNonce ‖ XChaCha20-Poly1305
snap_id = blake3(sealed)                             // content address — OVER THE CIPHERTEXT
```

Two load-bearing decisions:

- **Hash over ciphertext, deliberately** — keyless holders self-verify what they store/serve without ever holding the key; AEAD tag + inner sig protect plaintext integrity separately.
- **Raw `encodeStateAsUpdate` full history, NOT a compacted rebuild** — a full-history snapshot merges cleanly with any live replica when the owner returns (visitor edits made in absence merge as ordinary updates; no forks, no duplicated furniture). A rebuilt doc gets fresh client IDs and duplicates content on re-merge. Compaction is the real "Station Seals" `sealedEpoch` story — **deferred** until tombstone growth measurably hurts.

Sizes: typical sealed snapshot 10–100 KB, worst a few hundred KB. **No chunking in v1** (QUIC streams + existing `[len:u32][bytes]` framing carry this in one frame; hard accept-cap 4 MB; reserve `{chunk, of}` header fields now so the wire won't break later).

### 5.2 Store, wire, who holds, who publishes

- **`SnapStore` (node, disk-backed — Tier B generalized):** current + previous per room at `snapshots/<blake3(room_id)[..16]>/<id>.snap`; caps 2/room, 8 MB/room, 64 MB global LRU with own-membership rooms never evicted by volunteer rooms. Startup reload alone fixes "owner rebooted" (= slice D0).
- **Three control kinds mirroring ihave/iwant**, all under `control_should_admit` STRICT sig admission (never subject to `SSF_REQUIRE_SIG` relaxation), collect-under-lock/send-after-drop: `snap-have {room, id_hex, seq, publisher, size, tag_b64}` piggybacked on the mesh heartbeat; `snap-want` sent iff advertised seq > held seq and size ≤ cap, serve-rate-capped like `IWANT_MAX_SERVE`; `snap-data` framed sealed bytes, receiver verifies `blake3(bytes) == id` or drops + demerits. `tag_b64` = publisher sig over `(room_id ‖ id ‖ seq)` — restorers rank candidates without opening blobs; holders can't inflate `seq`.
- **Who holds, v1: every room member's node.** Honest scoping — "spread across the mesh" initially means "across all members' nodes, retained offline-owner-proof and restart-proof," which is exactly the availability gap being closed. Out-of-room **volunteer holders** (opaque ciphertext, `SSF_SNAP_HOLD_MB` quota, blinded room tags) are slice D5, safe by the invariant but not needed for the core win.
- **Who publishes, v1: the owner's node, automatically** — it holds the room key (`ChiaRoomCap`) and the doc; debounced ~30 s after last mutation, min interval 5 min; browser never needs a publish path. Tier C widens the publisher set to co-hosts.

### 5.3 Discovery — "which snapshot is CURRENT?" (layered, cheapest first)

1. **Mesh compare:** highest `(seq, publisher, id)` among tag-verified adverts from the trusted publisher set; deterministic tie-break.
2. **No live room peers:** reuse existing machinery verbatim — dial `memberHints` (their nodes may be up serving other rooms), then `chia_resolve::resolve_by_room_key` → dial → snap-want. No new discovery lane.
3. **Chia anchor ("Station Seals" — optional, per-room `pinned`):** owner's node publishes a spend with memos `[anchor_hint, sealed_pointer]` where `anchor_hint = blake3::derive_key("ssf-chia-anchor-v1", room_key ‖ epoch)` (same epoch-rotation unlinkability discipline as presence) and `sealed_pointer = seal(room_key, signed{room_id, snap_id, seq, publisher, issued_at})` — ~250 B, one memo, no chunking ever. **Chain = pointer, mesh = data**: the chain never sees plaintext or payload, and gives the one thing the mesh can't — an owner-authoritative CURRENT that survives every holder being stale or absent. Reuses `chia_publish`/`chia_resolve` with context + payload parameterized; cadence on-demand ("Seal Station" button) + daily while pinned; cost is the funding-plan's presence-lane cost model — **~0 in Chia's normal state**, dust-scale otherwise.

**Publisher-trust bootstrap** (the chicken-and-egg — restorer must know who may publish before holding the doc): pass v3 `ownerPubB64`, v1 rule accepted publisher == pinned owner key; Tier C's owner-signed co-host list extends it — **one shared artifact, defined once.**

### 5.4 Restore path (visitor with a pass, zero live peers)

1. `roomPasses` load-timeout → instead of terminal `offline`, the node enters restore at the existing dial-exhaustion hook (where `chia_resolve::resolve_target` already hangs).
2. Resolve CURRENT: local `SnapStore` (Tier A/B synergy — instant) → mesh snap-have via hints/presence dials → chia anchor if pinned.
3. Fetch from any holder; verify blake3.
4. **Node-side open + hydrate (the elegant bit):** node holds the room key → `open` → verify publisher against the pinned owner/co-host set **before** `Doc::apply_update` into `Room.doc`. From that moment the node is an ordinary warm host and the browser's stock SyncStep1/2 delivers the room — **zero new browser rendering code.** `roomPasses` gains one state: `archived` (restorable) vs `offline` (nothing anywhere).
5. HUD: `replicas` = distinct nodes acking snap-have for current id; `pinned` = anchor active.

### 5.5 Trust analysis & the honest retention section

| Attack by a holder | Outcome |
|---|---|
| Forge/alter content | **Impossible** — AEAD tag + ed25519 sig + blake3 fail independently |
| Read the room | **Impossible** — ciphertext only; invariant holds |
| Cross-room replay | **Impossible** — `room_id` inside signed plaintext; key is room-derived |
| Advertise fake high `seq` | **Blocked** — tag sig covers seq |
| Serve **stale** | **Possible** — bounded by fetch-many-compare; **eliminated** when anchored |
| Serve **nothing** | **Possible** — availability is not cryptographically guaranteed; the anchor at least makes "lost" distinguishable from "never was" |
| Metadata observation | **Real leak, stated plainly:** sizes, cadence, publisher id, room-scoped traffic; D5 must use blinded room tags |
| Malicious **publisher** (stolen key) rolls back | Sig-valid → accepted; revocation is Tier C's problem; owner-only v1 shrinks it to "stolen owner key," which is game-over anyway |

Retention: v1 incentive is natural — members store their own rooms (tens of KB of their own stuff); no protocol incentive needed for "your room survives as long as *any* member's node runs." GC: current+previous, delete on pass removal, LRU with own-rooms protected. Abuse: 4 MB accept cap, membership-gated accept, declared-size enforcement pre-fetch, serve-rate caps, demerit+disconnect on hash-mismatch. **Not solved, on purpose:** guaranteed availability with zero members and zero volunteers online. The anchor preserves the *pointer* forever, never the *data*. A Chia-paid pinning market is a natural future extension (the anchor is its settlement object) but designing one here would be fiction dressed as a plan.

---

## 6. Recommended build order — and why

Tier A is fully independent. Tier B is C4 and D0 wearing different hats — build it once. Tiers C and D share exactly one artifact: **pass v3 `ownerPubB64` + the owner-signed publisher/co-host list** — define its format once, early. Note one research-line discrepancy resolved here: an earlier framing called Tier A "y-indexeddb persistence"; the Tier A deep-dive rejects y-indexeddb for cause (§3.1), and the hand-rolled full-snapshot blob is what makes A→D artifact-compatible. Hand-rolled wins.

| Step | Slice | Why here |
|---|---|---|
| 1 | **A1** — client cache (~180 LOC, browser-only) | Cheapest win; fixes S1–S3 rows; closes the rename-revert bug as a side effect; produces the exact blob D will seal. |
| 2 | **C2** — node answers iroh-in SyncStep1 (interim `served` gate, no designation UI) | Highest-value single change: S4 dies. Independently shippable and testable (3-node recipe). |
| 3 | **B (= C4/D0)** — node disk persistence of served/own docs | With C2, "owner's machine rebooted" stops mattering. Kill+restart acceptance, no browser change. |
| 4 | **Pass v3 `ownerPubB64`** (+ actually signing `sigB64`) | The shared trust anchor both C1 and D3 consume; smallest possible protocol bump, do it once. |
| 5 | **C1 + C3** — grants, revocation tombstones, owner UI, hints in passes | Designated co-hosts become findable; S5 dies for live co-hosts. |
| 6 | **D1 + D2** — snapshot format + publish + mesh spread + replicas HUD | Sealed snaps on every member's disk; unit tests mirror `chia_lane`'s (roundtrip/wrong-key/tamper/wrong-room). |
| 7 | **D3** — restore path + `archived` state | S6 dies: cold member node serves a full room; owner returns later → clean CRDT merge, no duplicates. |
| 8 | **C5 + D4** — the chia pair (co-host presence heartbeat; snapshot anchor) | Same lane, same wallet, same `SSF_CHIA_LANE=1` gate; anchor makes staleness (S8) mechanical. |
| 9 | **C6 + D5** — `roomProof` enforcement, stewardship gate, volunteer holders | Hardening and reach, each warn-then-enforce. |
| later | Epoch compaction (true `sealedEpoch` fence) | Only when measured tombstone growth hurts; needs C's co-host set + D3. |

Steps 1–3 alone flip the answer to the owner's first question from "empty Lobby" to "the room, whenever the owner's machine — or any serving machine — is on." Everything after widens *who* can be that machine and *how stale* the worst answer can be.

---

## 7. Known unknowns

Decision-forcing, not blocking. Steps 1–3 hold regardless of how these resolve.

1. **Pass v3 shape.** `ownerPubB64` is one field, but making `sigB64` real changes pass minting/verification for every existing pass — need a legacy-accept window and a decision on whether unsigned v2 passes can ever mint co-host-hint-bearing v3 passes. Owns the C1/D3 trust chain, so settle before step 5.
2. **Freshness-probe audit.** The `serverSynced` fix covers the two known owner-presence probes; any *future* code that treats "doc non-empty" as "host answered" re-opens the stale-cache trap. Needs a grep-able convention (probe on `serverSynced`, never on doc contents) written into `roomCache.ts`'s header.
3. **Subtype parsing on iroh-in (C2).** The answer branch must classify subtype-0 without misfiring on legitimate Updates (`is_ysync_state_frame`-sibling logic); a misclassification either drops real updates or answers garbage. Unit-test the frame classifier against all three sync subtypes before shipping C2.
4. **Hint-list growth (C3).** How many co-host hints fit in a pass envelope/QR before size hurts — cap policy (owner + co-hosts first) is stated but the number is unmeasured.
5. **IndexedDB durability in practice.** `navigator.storage.persist()` grant rates and Safari eviction behavior are environment-dependent; Tier A must be *presented* as cache, and the "owned rooms never evicted" rule is only as good as the browser's cooperation. B/C exist because of this — don't let A's success defer them indefinitely.
6. **Publisher cadence constants (D).** 30 s debounce / 5 min floor / daily anchor are guesses; pin against real edit patterns and the chia funding plan's fee regimes (anchor cost is ~0 uncongested, but cadence × congestion is the only place money appears).
7. **Snapshot size trajectory.** Full-history snapshots grow with tombstones; the chat cap bounds the worst term, but the trigger threshold for epoch compaction ("later" slice) needs a measured number, not a feeling.
8. **Malicious-co-host detection UX.** Until D4's anchor, a hostile designated co-host can fabricate state for visitors who reach only it. `stateEpoch` is a human hint, not enforcement — decide whether that's acceptable copy for the C-only interim ("caretaker records, unverified") or whether C ships gated behind D2.

---

*Provenance note: browser citations (`main.ts`, `YjsSync.ts`, `roomPasses.ts`, `protocol.ts`, `keypair.ts`) are exact line numbers from files read this session; node citations (`main.rs`, `chia_lane.rs`, `chia_publish.rs`, `chia_resolve.rs`) are approximate and drift. The chia cost figures defer entirely to the funding plan's model and its `[VERIFY]` items. Sizes (snapshot KB estimates, chat-growth rates) are engineering estimates, not measurements. This document is design synthesis, not shipped behavior.*