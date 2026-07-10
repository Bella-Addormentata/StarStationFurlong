# STUDY — Architecture Distilled v007
*A networking-reality synthesis over [STUDY-Architecture v006](STUDY-Architecture%20v006.md) and everything learned in the six days since: the v0.11.1 hole-punch review chain ([§§6–10](../REVIEWS/REVIEW-20260707-P2P-Hole-Punching-v0.11.1.md)), the [Cabal DNS-free discovery plan](../REVIEWS/REVIEW-20260707-Cabal-DNS-Free-Discovery-Plan.md), the [invite-link failure review](../REVIEWS/REVIEW-20260708-Invite-Link-Loopback-Cert-Mismatch.md), three shipped releases (v0.15.0 → v0.17.0), and the first real cross-machine playtest — plus the new [ChiaHub lane](../REVIEWS/REVIEW-20260710-ChiaHub.md).*

**Date:** 2026-07-10 · **Author:** Claude Fable 5 (GitHub Copilot)

> ⚠️ **GATE STATUS — read this first.** The [v006 errata ledger](STUDY-Architecture%20v006.md#errata--post-v006-decisions-ledger-appended-2026-07-07--original-text-above-unchanged) gated v007 on three empirics. As of today:
>
> | # | Entry criterion | Status |
> |---|---|---|
> | (a) | Node **links and runs** on Windows, toolchain verdict recorded | ✅ **MET** — release-profile GNU links (13 m 55 s); MSVC CI builds and ships it; the binary has run live on two machines serving real WT + iroh sessions |
> | (b) | **B-6 re-run** delivers a real relay-drill verdict | ❌ **NOT MET** — no relay has ever been stood up |
> | (c) | One **cross-network room-key-ticket join** end-to-end | ❌ **NOT MET** — the v0.16.0 playtest failed; five findings fixed in v0.17.0; re-test pending |
>
> This study is therefore written **at the maintainer's request as a *provisional* synthesis** — v006 remains the foundation study. Every section below is tagged either **[FACT]** (run-proven or compile-proven, with the evidence class named) or **[PLAN]** (design intent, not yet demonstrated). v007 graduates to "current" the day gates (b) and (c) close; if their results contradict a [PLAN] section, the plan yields, not the results. Writing plans as facts is the B-6 mistake; this document is structured so it cannot repeat it.

---

## 1. TL;DR — What v007 Changes vs v006

| Topic | v006 said | v007 verdict |
|---|---|---|
| Node existence | "no node binary had ever been produced" (errata #3) | **[FACT/run]** The node builds (GNU release + MSVC CI), ships as a release asset, and has served live sessions on two machines. The Windows toolchain verdict is recorded: MSVC for iteration and CI; GNU release-profile works but is a 13-minute link |
| Node topology | Tauri app embeds an iroh-less `wt_listener` sidecar | **[FACT/run]** That sidecar caused the silent separate-rooms failure. **One-node doctrine** (§3): `ssf-p2p-node` is the only networking codebase; the app probes UDP 4443, spawns it, or falls back loudly. `wt_listener.rs` is fallback-only, scheduled for retirement |
| Discovery | DNS-free plan designed (errata #5) | **[FACT/compile]** Three lanes are now *in the shipped binary*: Mainline DHT (unfiltered publish, `SSF_NO_DHT` opt-out), mDNS LAN, UPnP/NAT-PMP/PCP portmapper. **[PLAN]** Two more specified: hub-coordinated punch (§5) and the Chia lane ([ChiaHub](../REVIEWS/REVIEW-20260710-ChiaHub.md)) |
| Invites | Room-key-first tickets designed | **[FACT/run]** One-button `Copy Invite` ships; tickets carry room key + live member hints; `ssf://room?seed=…` carrier replaces the dead `tauri.localhost` origin links |
| Bridge | "always-bridge" landed in source | **[FACT/run-diagnosed]** The first playtest exposed that the bridge was **write-only toward the browser** — findings F1–F5 (§6), all fixed in v0.17.0, re-test pending (gate c) |
| Multi-user | Implied by the Cabal model | **[FACT/code-read]** Current code is star-forming but **pairwise-visible only**: the hub does not relay spoke↔spoke and forwarding hides the original sender. **[PLAN]** Hub relay + membership gossip + coordinated punch upgrade (§5) |
| Beacon | Player-run `iroh-relay`, zero-registration (errata #5) | **[PLAN]** Unchanged and still the top unbuilt rung — now joined by a *slower, permanent* floor: the Chia rendezvous/punch-scheduling lane (§4, ChiaHub) |
| Chia's role | L3 settlement + coarse clock (§10.2) | **[PLAN]** Extended: the chain the game already requires can also be its **introduction service** — rendezvous records and block-clock punch scheduling, never traffic (ChiaHub) |

Everything else in v006 — SsfLog, Station Seals v2, three-lane motion, two-tier markets, T&S, the port split, derive-don't-tick — **stands unchanged** and is not relitigated here.

---

## 2. The Evidence Ledger — what we actually know now

Three evidence classes, strongest first. Nothing may cite a weaker class as if it were a stronger one.

### 2.1 Run-proven **[FACT/run]**
- The standalone node runs on Windows, binds UDP 4443 + TCP 8080, serves a real WebTransport session to the packaged app, and answers `/api/fingerprint` with the full 6-field iroh shape (verified live via netstat PID-mapping + direct HTTP probe, 2026-07-09).
- The MSVC-built CI binary is the binary that ran — first MSVC compile of the node crate worked end-to-end (release run #21).
- CORS allowlist v2 works from the real packaged-app origin (`http://tauri.localhost` echo verified with a real-Origin request after a crashed-frame probe produced a false negative — see §6, lesson 5).
- The app's spawn ladder works: UDP-probe → exe-adjacent → dev tree → PATH → loud fallback (observed taking the "already running" branch live).
- Cross-network reachability physics, measured: the host's LAN hint is foreign-subnet dead; both of the host's global IPv6 addresses drop unsolicited probes (residential stateful firewalls); the invite carried no public IPv4. **A dial with only those hints cannot succeed regardless of code correctness.**

### 2.2 Compile-proven, run-pending **[FACT/compile]**
- v0.17.0 fix pack (F1–F5, §6): browser reads node-initiated streams; bridge status envelopes + UI row; live-refreshed fingerprint hints; `ssf://` invite carrier; `SSF_IROH_PORT` / `SSF_EXTERNAL_ADDRS`; mDNS lookup. (`cargo check` clean; vite build clean; **no cross-machine run yet** — this is gate (c)'s subject.)
- Mainline DHT publish/resolve with `AddrFilter::unfiltered` (the default `relay_only` publishes nothing in a relay-less posture — a silent-failure trap now documented in code).
- Portmapper re-enabled (the `default-features = false` linker workaround had silently dropped it — reachability rung 1 was off in every build before v0.16.0).

### 2.3 Designed, not yet built **[PLAN]**
- Hub relay + membership gossip + hub-coordinated punch (§5).
- Beacon toggle (embedded `iroh-relay` server, IP-literal + `ca_tls_config` self-signed — APIs verified on docs, never exercised: B-6 re-run scope).
- ChiaHub lane (full spec in the [review](../REVIEWS/REVIEW-20260710-ChiaHub.md); gated behind spike B-7).
- S2 room challenge; WT cert staged rotation (C1 second half); `wt_listener` retirement; installer bundling of the node (`externalBin`).

---

## 3. The One-Node Doctrine **[FACT/run + decision]**

The v0.16.0 silent-separate-rooms bug was an *architecture* bug: two listener codebases (the real node and an iroh-less embedded sidecar) drifted, and the weaker one shipped. The standing decision ([invite review §7.5](../REVIEWS/REVIEW-20260708-Invite-Link-Loopback-Cert-Mismatch.md)):

- **`ssf-p2p-node` is the only networking implementation.** "App companion", "station", and "beacon" are *profiles* of it, not programs.
- The Tauri shell **acquires** a node (probe → spawn → PATH) and only falls back to the embedded listener with a loud, player-visible warning that bridging is off.
- Remaining work: ship the node *inside* the installers (`bundle.externalBin` + CI build per platform — currently a separate release asset), then delete `wt_listener.rs`.

---

## 4. The Reachability & Discovery Ladders — consolidated status

One table now tracks both ladders from the Cabal plan (§4.1.2, §4.5) plus the new floor. **The physics rule stands: one reachable party must exist for the first link; every rung changes who that is and how much work it costs, never whether.**

| Rung | Mechanism | Status | Removes manual work for |
|---|---|---|---|
| 1 | UPnP/NAT-PMP/PCP portmapper | **[FACT/compile]** shipped v0.16.0; live-hint fix v0.17.0 makes its mapping reach invites; **unverified in anger** | The reachable member, when routers cooperate |
| 2 | Direct hints (LAN / open NAT / IPv6) + DHT + mDNS | **[FACT/compile]** all three lookup lanes shipped | Same-LAN and open-NAT peers entirely |
| 3 | Manual port-forward (`SSF_IROH_PORT` + `SSF_EXTERNAL_ADDRS`) | **[FACT/compile]** shipped v0.17.0 | Nobody — this *is* the manual rung, now at least possible |
| 4 | Hub relay + membership gossip + hub-coordinated punch | **[PLAN]** §5 | Every member except one per room |
| 5 | Beacon toggle (embedded `iroh-relay`) | **[PLAN]** B-6 re-run scope | Everyone, every room, while one volunteer runs it |
| 6 | **ChiaHub** — chain rendezvous + block-clock punch scheduling | **[PLAN]** [full spec](../REVIEWS/REVIEW-20260710-ChiaHub.md), gated on B-7 | The *discovery* half of everything above, permanently, with no live infrastructure at all |

Lane 6 is the new insight of this study: the chain the game already requires (L3 settlement, coarse clock) can also be its **introduction service** — slow (~5 s mempool-watched, ~1 min confirmed), permanent, and unkillable. It can never carry traffic; symmetric-NAT-both-sides pairs still need rung 5.

---

## 5. Multi-User Topology — from pairwise to N players **[PLAN]**

**Current fact [FACT/code-read]:** with one reachable member A and joiners B, C — all three connect (star forms), A sees everyone, but **B and C do not see each other**: the node forwards inbound remote envelopes to local browsers only (never to other remote peers), and outbound forwarding rewrites `iroh_node_id` to the forwarder's own id, so spokes can never learn each other.

**The Cabal lesson** (verified from source in the deep-dive): Cabal never forwards packets — *possession is relaying*. Data is per-author signed logs; any peer replicates any log from whoever holds it, so a hub relays B's data to C simply by having it. Our hub's node already merges every member's Yjs updates into its room doc — we are one re-emit away from the same property.

**The three-step upgrade** (ordered, each independently shippable):
1. **Hub relay:** forward inbound remote envelopes + 13-byte ticks to the room's *other* remote peers (exclude origin; `(author, seq)` dedup cache against future multi-hub loops).
2. **Membership gossip:** preserve the original sender's node id + hints when forwarding (or append a `memberHints` list) — spokes learn each other and can attempt direct dials (instant win on LAN via mDNS, on open NATs via hints).
3. **Hub-coordinated punch:** the hub observes each spoke's *public* UDP endpoint on its existing connections; it gossips those observed addresses and schedules a simultaneous open — star upgrades to mesh wherever NAT types allow, with the hub as the sovereign coordinator (no external relay). Links that can't upgrade keep flowing through the hub.

**Scale envelope:** the hub pays O(N) per tick fan-out (≈ N× 20 Hz × 13 B ≈ 1 kB/s per member — trivial at playtest size; revisit at ~16+ members, which is v006's room-size envelope anyway). simple-peer/WebRTC was evaluated and **parked**: the node layer already does the P2P leg strictly better; browser↔browser DataChannels only matter for a future node-less pure-web lane (y-webrtc is the shovel-ready adapter if that lane ever ships).

---

## 6. Five Playtest Lessons as Architecture Rules **[FACT/run-diagnosed]**

The v0.16.0 cross-machine failure produced five findings (fixed in v0.17.0). Each generalizes to a rule:

| # | Finding | Rule |
|---|---|---|
| F1 | Node forwarded to browsers on node-initiated WT streams; no browser code ever read them | **No write-only lanes.** Every forwarding path must name its reader, and the reader must exist in the same release |
| F2 | Dial success/failure was console-only; players saw a quiet room | **Status must reach the player.** Every async network outcome surfaces in-UI (the Bridge row + SpacePhone messages) |
| F3 | Invite hints were a boot-time snapshot; portmapper/observed addresses never reached invites | **Hints are live data, not constants.** Anything advertised to peers re-reads the endpoint's current view |
| F4 | Invites carried `http://tauri.localhost/…` — a WebView-internal origin, dead everywhere else | **Link carriers must be origin-neutral** (`ssf://room?seed=…`); a share artifact must work in the *recipient's* context |
| F5 | All advertised addresses were unreachable (foreign LAN, firewalled IPv6, no public IPv4, no relay) | **Physics outranks code.** Every release must state which ladder rungs (§4) it actually provides, and the UI must say which rung a join is using |

Meta-lesson (also from the CORS false-negative episode): **landed-in-source ≠ run-verified**, and a diagnostic from a crashed context is void. The evidence-class discipline of §2 exists because of these.

---

## 7. Implementation Plan — ordered, with acceptance criteria **[PLAN]**

1. **Cross-network re-test on v0.17.0** *(gate c)* — host + joiner on published builds; UPnP checked first (fingerprint shows public IPv4?), manual rung 3 otherwise. **Accept:** two machines, different networks, one invite, shared room state both directions; Bridge row shows `LINKED`.
2. **Hub relay + membership gossip** (§5 steps 1–2, node-only change). **Accept:** three players, one reachable member, all three see each other's moves + chat.
3. **B-6 re-run** *(gate b)*: stand up one player-run `iroh-relay` (IP-literal, self-signed via `ca_tls_config`), relay-assisted punch drill across two networks, kill-switch matrix (DNS off / relay off / DHT off), refuse-publics proof. **Accept:** the errata-#2 checklist, plus a recorded toolchain note.
4. **Hub-coordinated punch** (§5 step 3). **Accept:** B↔C direct link forms through A's coordination with A's relay path then going quiet.
5. **Beacon toggle**: `--beacon` profile embedding the `iroh-relay` server; greys out when unreachable (§4.1.3). **Accept:** a fresh third-party joins a room whose only reachable party is the beacon.
6. **ChiaHub spike** (post-B-7; [phased C1–C4 in the review](../REVIEWS/REVIEW-20260710-ChiaHub.md)). **Accept:** C1 on testnet11 — publish + resolve a presence record via hinted memo round-trip.
7. **Node-in-installer** (`externalBin` + per-platform CI node builds) → **retire `wt_listener.rs`**.
8. **S2 key-gated room challenge** (plan §4.6) and **C1-cert staged rotation** (`reload_config`) — the two oldest open security findings.
9. **v007 graduation pass**: when gates (b) and (c) close, strike this banner, promote [PLAN]→[FACT] sections with evidence citations, and hand v006+v007 to the reviewer panel together.

---

## 8. Open Risks

| Risk | Exposure | Mitigation in plan |
|---|---|---|
| v0.17.0 F1 fix has never moved real cross-machine bytes | Gate (c) could fail again | Plan item 1 is first; Bridge row makes failure loud and diagnosable this time |
| UPnP success rates in the wild | Rung 1 may quietly not exist for many players | Rung 3 documented; rung 4–6 remove the dependency |
| Hub relaying adds an implicit trust role | Hub sees/forwards room traffic (already E2E-visible to members; room key gates membership) | S2 challenge (plan item 8) before any hostile-member threat model matters |
| Chain-lane privacy (records are forever) | IP history permanence if done naively | ChiaHub mandates encrypt-to-room-key + burner derivations + epoch rotation before any mainnet use |
| `wt_listener` lingers as a fallback | Two-codebase drift recurring | Retirement is explicitly sequenced (plan item 7) behind installer bundling |

---

*Chain: [v005](STUDY-Architecture%20v005.md) → [v006](STUDY-Architecture%20v006.md) (+ errata ledger) → **v007 (provisional)**. Companion deep-dives: [Cabal discovery plan](../REVIEWS/REVIEW-20260707-Cabal-DNS-Free-Discovery-Plan.md) · [hole-punch review](../REVIEWS/REVIEW-20260707-P2P-Hole-Punching-v0.11.1.md) · [invite-link review](../REVIEWS/REVIEW-20260708-Invite-Link-Loopback-Cert-Mismatch.md) · [ChiaHub](../REVIEWS/REVIEW-20260710-ChiaHub.md).*
