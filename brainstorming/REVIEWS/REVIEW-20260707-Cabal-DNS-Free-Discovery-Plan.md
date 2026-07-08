# StarStation Furlong - Cabal-Inspired DNS-Free Discovery Plan

Created on: 2026-07-07  
Status: Draft Implementation Plan — **updated 2026-07-07: Cabal-codebase deep-dive verified against source (§2.3–2.4); our iroh mapping (§4.4–4.7) is analysis with open validation items** — outstanding `[VERIFY]` markers: §4.1.1/§4.3 (plain-`http://` relay-client acceptance, exact `CaTlsConfig` constructor), §4.5 (iroh-gossip 1.0 compatibility, Mainline/pkarr feature names) — all folded into the B‑6 re-run / Phase D spikes  
Primary references: [STUDY-Architecture v006](../AI%20BRAINSTORMING/STUDY-Architecture%20v006.md), [P2P hole-punch re-review](REVIEW-20260707-P2P-Hole-Punching-v0.11.1.md), [TODO critical path](../../TODO.md)

> **License note:** cabal-core/cabal-client are AGPL/GPL. We adopt the **model, never the
> code** (standing ruling from the v004 Opus review, carried in v005/v006). Everything
> below is re-derived on our Rust/iroh stack.

---

## 1. Executive Summary

Yes, we can avoid DNS on the critical path.

What we cannot avoid is discovery/rendezvous itself. Cabal demonstrates this clearly:
- identity can be key-based,
- names can be optional,
- but peers still need a reachable discovery layer (bootstrap/rendezvous infrastructure).

For StarStation Furlong, the sovereignty-correct objective is:
- no third-party discovery dependency,
- no mandatory DNS dependency,
- no vendor default relays,
- but preserve practical cross-NAT connectivity.

In practice, this means: self-hosted (or player-hosted) rendezvous/bootstrap endpoints addressed by explicit IPs and distributed via signed seed tickets.

---

## 2. What to Borrow From Cabal

### 2.1 Principle, not exact stack

Cabal's key lessons to apply:
1. Key-based identity and invite links first.
2. Discovery layer can be independent of DNS names.
3. Community-run infrastructure can replace vendor dependency.
4. Discovery outages are real and must be treated as first-class operational risk.

### 2.2 Constraint to accept

Removing DNS does not remove the need for:
- endpoint discovery,
- introduction/rendezvous,
- and topology refresh when addresses change.

If DNS is removed, these functions must be replaced by explicit IP tracking and signed distribution mechanisms.

### 2.3 Deep dive — how Cabal actually connects (verified against source, 2026-07-07)

Read today: `cabal-core/swarm.js`, `cabal-core/bootstrap_nodes.js`, the
[Cable Handshake spec 1.0-draft8](https://github.com/cabal-club/cable/blob/main/handshake.md)
(Feb 2024), and the cabal-client README. Six mechanisms make the "paste one key, you're
in" UX work:

1. **The room IS the key.** A cabal is identified by a random 32-byte *cabal key*
   (`cabal://<64-hex>`). There is no host, no address, no name in the identifier —
   everything else is derived or discovered.
2. **Blinded rendezvous topic.** Peers do not announce the key itself. `swarm.js`
   derives `discoveryKey = crypto.discoveryKey(cabalKey)` — a keyed BLAKE2b hash — and
   joins the DHT under **the hash**. Discovery infrastructure (DHT nodes, bootstrap
   servers) can introduce members to each other but never learns the key, can't join,
   and can't decrypt (see #4). Rendezvous is *capability-blind*.
3. **Symmetric swarming.** `swarm.join(discoveryKey, { server: true, client: true })`
   — every member simultaneously announces (serves) and looks up (dials). **Any online
   member is a valid meeting point**; the room stays joinable as long as *anyone* is
   online. There is no host role at the transport layer at all.
4. **The key gates the handshake, cryptographically.** Cable's Noise protocol name is
   `Noise_XXpsk0_25519_ChaChaPoly_BLAKE2b`: the cabal key is mixed in as the `psk0`
   pre-shared key. A peer that doesn't know the key **cannot complete the handshake**
   — membership enforcement costs zero round trips, needs no member list, and the key
   never crosses the wire. MITM without the key fails at step 1. (Spec §2.4, §5.2.2.)
5. **Per-cabal identity keys.** The spec *mandates* (§3.1) a fresh Ed25519 identity
   keypair per cabal — the same user in two cabals is cryptographically uncorrelatable.
6. **Community-extendable bootstrap list, vendor-diluted.** `bootstrap_nodes.js` ships
   8 DHT bootstrap entries: 5 community-run (eight45.net, nthia.dev,
   cabaldht.linkping.org, hyperswarm.mindeco.de, hyperdht.cryptosec.se) + 3 vendor
   (node₁₃.hyperdht.org). Adding one is a pull request (the file's last commit *is*
   a community node addition). One bootstrap node serves **all** cabals — topic-blind,
   room-agnostic infrastructure, exactly our "beacon station" concept.

And two honest limitations Cabal itself documents, which we must design past:

7. **No re-key.** Handshake spec §5.2.1: a leaked cabal key = permanent, undetectable
   read access; "there is currently no way to re-key a cabal, other than starting a
   new cabal." (Our v006 §7.4 epochal re-key + room classes must stay in the design.)
8. **Bootstrap is DNS-named.** Cabal's own "DNS-free" story stops at the bootstrap
   list — all 8 entries are hostnames. They chose names because bootstrap IPs rot.
   Evidence for §7's posture: strict no-DNS is a *mode*, not the default.

### 2.4 What we deliberately do NOT copy

- **hyperswarm/hyperdht themselves** — JS stack, vendor-operated defaults; our
  transport is iroh (v006 §3.1 ruling).
- **AGPL code** — model only (see license note above).
- **Global flat swarm with no room classes** — our capability/room-class/T&S layers
  (v006 §7) stay on top of the key-gated join.
- **Identity == device feed** multi-writer semantics — that is RoomLog/SsfLog territory
  (v006 §5.4), out of scope here.

---

## 3. DNS-Free Sovereign Target State

### 3.1 Critical-path rules

1. No external DNS lookup required for peer join.
2. No external public relay dependency by default.
3. No public bootstrap defaults unless explicitly enabled as dev mode.
4. All discovery inputs must come from signed local config or signed seed tickets —
   plus the two lanes that need no external input at all: gossip introduction from an
   already-connected member (§4.5 lane 2) and local mDNS (§4.5 lane 3).

### 3.2 Runtime behavior

1. Browser always connects to local node over loopback WebTransport.
2. Local node performs remote rendezvous/dialing.
3. Local node uses a trusted list of relay/bootstrap endpoints represented as IP:port (or HTTPS IP endpoint with certificate pin metadata).
4. Seed ticket carries the **room key** (identity of the room, §4.2) plus optional
   member dial hints — the key is what joins; the hints only make it fast.

---

## 4. Proposed Architecture (Iroh-Compatible)

This plan keeps iroh and applies Cabal-style sovereignty discipline.

### 4.1 Discovery and rendezvous inputs

Use two local inputs only:

1. `SSF_RELAYS`
- Comma-separated list of trusted relay endpoints.
- DNS-free mode: require explicit IP endpoints.
- Optional strict format examples:
  - `https://203.0.113.20:443`
  - `https://198.51.100.41:443`

2. Signed seed ticket
- Contains per-peer dial hints and room capability material.

#### 4.1.1 What a beacon relay actually requires (verified 2026-07-07, iroh 1.0.2 docs)

Answering the standing question — *"does `SSF_RELAYS` still require a server with DNS
and TLS / any registration or external servers?"* — dependency by dependency:

| Dependency | Required? | Why / mechanism |
|---|---|---|
| **A reachable machine** | **Yes — physics** | *Something* must accept inbound packets to introduce two NATed peers. But it need not be "external": any player's box qualifies — a Station-in-a-Box, a home connection with one port-forward, a community VPS. Same dependency Cabal has (§2.3-6); ours is just player-owned. |
| **DNS name** | **No** | `RelayUrl` accepts IP-literal URLs (`https://203.0.113.20:443`). No domain, no registrar, no resolver on the join path. |
| **Public-CA TLS (Let's Encrypt etc.)** | **No** | Verified: `Builder::ca_tls_config(CaTlsConfig)` — *"sets the trusted CA root certificates for non-iroh TLS connections… used as trust anchors for verifying… external services, **such as iroh relays**, pkarr servers, or DoH resolvers."* The relay self-signs; its cert (acting as its own root) is distributed in the signed config bundle / ticket — the exact trust model we already use for WT `serverCertificateHashes`. Zero certificate authorities, zero renewal treadmill, zero registration. |
| **TLS at all** | Default yes, strictly no | The iroh-relay server binary runs "over **HTTP or HTTPS**" (verified crate docs), and relayed traffic is end-to-end encrypted QUIC regardless (revised-DERP design — *"temporarily routing encrypted traffic… the relay server steps back"*) — the relay **never sees plaintext** either way. Keep TLS-with-own-cert as the default because it preserves the v006 §11 looks-like-HTTPS camouflage on hostile networks and hides connection metadata; plain-HTTP is acceptable for LAN/lab drills. Client-side acceptance of `http://` relay URLs: **[VERIFY in B‑6 re-run]** — the one remaining unknown. |
| **Accounts / user registration** | **No** | iroh relays are open/unauthenticated by default; ours stay community-open (rate-limited). Nobody signs up for anything. |

Deepest form of the answer: **the relay is not a service class, it's a capability of the
same player-run node.** A beacon station is just an `ssf-node` whose owner can accept
inbound — and once ANY room member is reachable (port-forward, full-cone NAT, or the
node's own UPnP port-mapping succeeding), that member IS the introducer and no relay is
consulted at all (§4.5 lanes 1–2). Relays only carry the case where *nobody* in the
room is reachable — and then only until the punch completes.

#### 4.1.2 Who must be reachable, exactly? (the port-forwarding question)

Standing question: *"so at least one person will always have to have port forwarding
enabled?"* — **No. The two peers connecting never need it (that is what hole punching
is), and the one introduction point usually doesn't either.** The precise requirement:

> A **new** cross-internet joiner must be able to deliver its *first packet* to
> **one** currently-reachable party — any member or any beacon, shared across the
> whole swarm, needed only at join/punch time.

The reachability ladder for that one party (any rung suffices):

| Rung | Action required | Notes |
|---|---|---|
| 1. Automatic port mapping | **none** | iroh's portmapper (UPnP/NAT-PMP/PCP) is **on by default** (verified: `Builder::portmapper_config` → `PortmapperConfig::Enabled`); succeeds on most home routers with UPnP enabled |
| 2. Friendly NAT, no mapping | **none** | full-cone / endpoint-independent NAT + our 2 s keepalive keeps the mapping warm → the ticket's `irohDirectAddrs` hint is directly dialable as-is |
| 3. Manual port-forward | one-time, one member | the explicit fallback; also what makes a home box a beacon |
| 4. Community beacon | one operator, everyone covered | a VPS or Station-in-a-Box relay; serves ALL rooms at once (topic-blind, §2.3-6) |

Amortization properties that make this cheap in practice:

- **Per-swarm, not per-person**: one reachable point introduces everyone else.
- **Join-time only**: established punched links survive the introducer vanishing; and
  already-connected members introduce newcomers over their *existing* connections
  (§4.5 lane 2) — a room outlives its original entry point so long as a newcomer can
  reach *some* current member.
- **LAN: nobody needs anything** (mDNS lane).

The irreducible worst case — every member behind CGNAT/symmetric-filtered NAT, UPnP off
everywhere, no beacon — means a new cross-internet joiner physically cannot deliver a
first packet to anyone. No protocol escapes this; it is the case beacons exist for, and
Cabal's shared bootstrap nodes are the same answer to the same physics. Diegetic
surfacing: the network HUD should show which rung the local node achieved
("REACHABLE · auto-mapped / REACHABLE · open NAT / INTRODUCER NEEDED"), reusing the
existing Self-Test + portmapper facts — so the one player who needs to flip rung 3
knows it, and nobody else is ever asked to.

#### 4.1.3 Every install is a station (no additional hardware required)

Standing question: *"can each player be a Station-in-a-Box?"* — **Yes. "Station" is a
software profile of the one node every player already runs, not a hardware product.**
The v006 §5.2 box is the *venue/always-on packaging* of the same `ssf-node`; nothing in
the discovery design requires anyone to own anything beyond their gaming machine.

Node profiles (one binary, settings toggles):

| Profile | What it does | Extra hardware | Cost of enabling |
|---|---|---|---|
| **Player** (default) | full node: seeds, hosts own rooms, joins swarms, dials | none | zero — this is every install |
| **Introducer** (automatic) | reachable via §4.1.2 rungs 1–3 → introduces its rooms' joiners | none | usually zero (default-on portmapper); at most one port-forward |
| **Beacon** (opt-in toggle) | embeds the `iroh-relay` **server** (verified: the crate ships a full HTTP/HTTPS relay server behind the `server` feature — same dep already in our tree, same Windows-linker prerequisite) → topic-blind rendezvous for the whole community | none | a checkbox + bandwidth; rate-limited by default |
| **Dedicated box** (optional) | same binary on a Pi/VPS for **availability** (doesn't sleep) and **venue mode** (own Wi-Fi AP, no-internet LAN parties) | the Pi/VPS | for operators who *want* the role |

Honest caveats — what a player-PC station does *not* automatically give you:

1. **Uptime**: laptops sleep; a room whose only introducer sleeps loses its entry point
   until another member is reachable. Mitigations already in the design: any-member
   join (§4.5 lane 2), multi-member `memberHints` (§4.2), and established links
   surviving introducer loss (§4.1.2).
2. **Serving strangers' browsers on LAN**: the v006 §5.2 secure-context rule still
   applies — a player machine can serve *native/Tauri* peers freely, but the
   baked-cert browser lane remains the dedicated box's specialty (or the local-CA
   event lane).
3. **Beacon duty on hostile NAT**: toggling beacon mode doesn't bypass §4.1.2 — an
   unreachable machine can't relay. The toggle should grey out with the HUD's
   reachability verdict.

Diegetic framing writes itself: every player's computer **is** their station; the
beacon toggle is "opening your docking bay to public traffic"; the Pi in the closet is
a "permanent orbital platform". The run-infrastructure ladder (v006 §14: ESP32 buoy →
box → relay VPS) gains its true bottom rung: **the game install itself.**

Config shape carrying the pin (extends the §3.2-3 "certificate pin metadata"):

```toml
# ssf-node config — zero-registration relay entry
[[relays]]
url          = "https://203.0.113.20:443"   # IP literal — no DNS
cert_pem     = """-----BEGIN CERTIFICATE-----…"""  # self-signed; trusted via ca_tls_config
# or: cert_hash_b64 = "…"                  # compact pin form for tickets/QR
```

```rust
// Node startup: trust ONLY the community/self-signed relay certs — no WebPKI.
let mut roots = rustls::RootCertStore::empty();
for relay in &cfg.relays {
    roots.add(parse_pem_cert(&relay.cert_pem)?)?;   // relay cert as its own trust anchor
}
builder = builder
    .relay_mode(RelayMode::Custom(RelayMap::try_from_iter(cfg.relays.iter().map(|r| r.url.clone()))?))
    .ca_tls_config(CaTlsConfig::from(roots));        // exact constructor: [VERIFY shape at impl]
```

### 4.2 Seed ticket shape (next revision) — room-key-first

The Cabal lesson applied: **today's ticket identifies a host; it should identify a
room.** If the ticket's one required field is a room key, then (a) the link never rots
when the sharer goes offline or changes address — any online member can introduce you
(§2.3-3); (b) the join challenge derives from the key itself — S2 costs no extra
ceremony (§4.6); (c) every addressing field demotes to a *hint*.

```ts
interface RoomBootstrapV2 {
  v: 2;
  // ── THE substance: 32-byte random room key, base64url. Never sent to relays,
  //    never announced — only its derivations are (§4.5). Generated at room creation.
  roomKeyB64: string;
  roomId?: string;              // display alias only — NOT identity (key is identity)

  // ── Hints (all optional, all refreshable, all merely accelerate the join):
  memberHints?: {               // ANY members, not "the host" — Cabal symmetry (§2.3-3)
    irohNodeId: string;
    irohRelayUrls?: string[];   // DNS-free endpoints allowed
    irohDirectAddrs?: string[]; // observed ip:port
  }[];
  wtUrl?: string;               // legacy same-LAN direct-WT lane
  certHashesB64?: string[];     // staged current+next for the WT lane

  // ── Ticket authenticity & lifetime:
  issuedAt?: number;
  expiresAt?: number;
  sigB64?: string;              // signed by an existing member's per-room key (§4.6)
}
```

Link form: `https://<origin>/?seed=…` (clickable, carries the encoded ticket) and the
bare sovereign form `ssf://room/<roomKeyB64>[?hints=…]` for QR/out-of-band exchange —
the Cabal `cabal://<key>` equivalent. A link with **zero hints must still work** on any
network where a discovery lane (§4.5) can find one member.

### 4.3 Strict no-DNS mode

Add a runtime gate, for example `SSF_NO_DNS=1`:
1. reject hostnames in relay config and seed hints,
2. accept only IP-literal endpoints,
3. disable any automatic public lookup mechanism that emits DNS queries (incl. the §4.7
   shortname sugar),
4. hard-fail if only DNS hostnames are provided.

Caveats to engineer (not hand-wave): iroh relay endpoints are HTTPS URLs, so IP-literal
relays need certificates — **resolved 2026-07-07 (§4.1.1): self-signed relay certs
trusted via the verified `Builder::ca_tls_config` API, distributed in the signed config
bundle/ticket. No public CA, no Let's Encrypt, no registration of any kind.** Remaining
verify item: whether the relay *client* also accepts plain-`http://` relay URLs for the
no-TLS lab mode (fold into the B‑6 re-run). Note Cabal itself couldn't hold the no-DNS
line (§2.3-8) — with §4.1.1 we can.

### 4.4 One-key join UX (the Cabal flagship, adopted)

Target interaction, end state:

1. Room creator's node generates `roomKey` (32 random bytes) at room creation.
2. Share = one link/QR. No address entry, no "LAN vs WAN" fields, no fingerprint
   plumbing visible to the player. (The current dual-links panel becomes a diagnostics
   drawer, not the primary flow.)
3. Joiner pastes/clicks/scans → browser hands the ticket to its own local node over
   loopback (always-bridge, re-review §10.2) → node runs the §4.5 discovery ladder →
   key-gated handshake (§4.6) → in the room.
4. The SAME link keeps working tomorrow, from a different cafe, after the sharer
   rebooted — because the link identifies the room, not a machine (§2.3-1/-3).

#### 4.4.1 Invite minting: ONE button, no LAN/WAN choice (decision 2026-07-08)

Standing question: *"should the bootstrap button split into LAN and WAN buttons, with
autogenerated IPs? Do we still need bootstrap links, or is the room key enough?"*

**Decision: one "Copy Invite" button; the LAN/WAN split is retired, not doubled.**
Splitting makes the *sharer* answer a topology question ("is my friend on my LAN?")
that they usually can't answer — a wrong guess mints a dead link. Instead the node
autogenerates **every** hint it knows and the invite carries them all; the **joiner's**
node tries them concurrently (§4.5 lane 1) and the right one wins:

| Hint | Source (autogenerated — no typing) | Available |
|---|---|---|
| LAN `irohDirectAddrs` | node's own interface enumeration (browser can't; fingerprint API carries it) | now |
| WAN `irohDirectAddrs` | portmapper external-IP report + QUIC Address Discovery → `endpoint.addr()` | with the Phase A relay lane |
| `irohRelayUrls` | the node's configured/home relay | with Phase A |
| `wtUrl` + `certHashesB64` | fingerprint API (same-LAN direct-WT legacy lane) | now |

The manual address input demotes to an *optional override* in the diagnostics drawer
(alongside Self-Test and the reachability-rung readout, §4.1.2); the dual LAN/WAN
share fields are removed from the primary flow entirely.

**And the second half of the question: links remain, but only as the carrier.** The
link and the room key are not competing artifacts — `https://…?seed=…` and
`ssf://room/<key>` are the *same object*: room key mandatory, hints optional (§4.2).
A bare key with zero hints joins successfully only where a hintless lane exists —
mDNS on LAN (Phase C), topic announce via beacons (Phase A′), DHT (Phase D). For
cross-internet **first contact today, the hints are what make the invite work**; after
the lanes land they remain the difference between an instant join and a
discovery-latency join. So: keep the clickable link + QR, autogenerate its contents,
and never ask the player an addressing question again.

### 4.5 Discovery ladder (how a key finds peers, DNS-free)

Derive per-room rendezvous material — never expose the key itself (Cabal's blinding,
§2.3-2), and bind an epoch for v006 §7.4 re-key:

```rust
// BLAKE3 derive_key gives us domain-separated, blinded derivations:
let topic:     [u8; 32] = blake3::derive_key("ssf/room-topic/v1",     &[room_key, epoch_le].concat());
let psk:       [u8; 32] = blake3::derive_key("ssf/room-psk/v1",       &[room_key, epoch_le].concat());
let id_seed:   [u8; 32] = blake3::derive_key("ssf/room-identity/v1",  &[room_key, my_master_seed].concat());
// topic  → announced to discovery lanes (safe: one-way hash of key)
// psk    → gates the room handshake (§4.6); never leaves the device
// id_seed→ per-room Ed25519 identity (Cabal §2.3-5: cross-room uncorrelatable)
```

Lanes, tried concurrently, all feeding the same `topic`:

| Lane | Mechanism | Sovereignty class | Status |
|---|---|---|---|
| 1. Ticket hints | dial `memberHints[]` directly (relay+direct addrs per hint) | pure P2P | Phase A (exists in part) |
| 2. Gossip swarm | iroh-gossip: join `topic` with any ONE reached member as bootstrap; HyParView-style membership then introduces the rest; rebroadcast liveness | pure P2P once seeded | Phase A′ — **[VERIFY iroh-gossip 1.0-compat at implementation]** |
| 3. LAN | iroh mDNS discovery lane (v005-verified) — zero-config LAN parties, works with resolver dead | pure local | Phase C |
| 4. Community relays | `SSF_RELAYS` beacon stations (topic-blind, room-agnostic — exactly Cabal's bootstrap-node role, §2.3-6) | community-owned | Phase A |
| 5. Mainline DHT / pkarr | iroh address-lookup services: nodes publish **ed25519-signed** address records (BEP44) resolvable by node id — kills IP-rot in tickets without DNS; carried by the BitTorrent DHT (millions of third-party nodes, nobody's server) | decentralized third-party — **optional lane, off in strict sovereign builds**, records are self-signed so trust never delegates to the carrier | Phase D spike — **[VERIFY iroh 1.0 feature names; note default-features=false linker situation]** |

Rule kept from §3.1: lanes 1–4 suffice for the sovereign critical path; lane 5 is a
convenience accelerator, never a dependency.

### 4.6 Key-gated room handshake (S2 fixed the Cabal way)

Cable proves membership with `psk0` inside Noise (§2.3-4). Our transports (WT/iroh)
already encrypt, so we don't need Noise — we need the *capability proof* in the
`cap` envelope (the v006 §12.2 `ClientHello`), derived from the room key:

```rust
// NodeAck-first variant: node issues a nonce, client proves key knowledge.
// ClientHello.challengeResponse = HMAC-BLAKE3(psk, nonce ‖ client_room_pubkey)
fn verify_hello(psk: &[u8; 32], nonce: &[u8], hello: &ClientHello) -> bool {
    let mac = blake3::keyed_hash(psk, &[nonce, hello.client_pubkey.as_bytes()].concat());
    constant_time_eq(&mac.as_bytes()[..32], &hello.challenge_response)
}
// Membership = knowing the link. No member list needed for open rooms; the
// room-class ladder (v006 §7.3: open-drive-by / member / private-capsule) and
// guest-held writes layer ON TOP for T&S — the part Cabal never built.
```

Properties inherited: zero-RT membership check, key never on the wire, relays/DHT can
introduce but never join (they hold `topic`, not `psk`). Properties added beyond Cabal:
epochal re-key (epoch in the derivation, §4.5), signed tickets (issuer accountability),
room classes, and node-operator denylists — answering §2.3-7.

### 4.7 DNS shortnames — optional sugar, inverted dependency

cabal-client resolves shortnames (e.g. `cabal.chat`) to keys via DNS as a pure
convenience. We can mirror that *shape* later — `ssf://furlong.quest/lobby` → TXT
record → room ticket — with the dependency correctly inverted: DNS may *name* a key,
but is never required to *reach* one. Disabled by `SSF_NO_DNS=1`. Phase D, lowest
priority; listed so the door stays architecturally open.

---

## 5. Mapping to Current Open Findings

From [REVIEW-20260707-P2P-Hole-Punching-v0.11.1.md](REVIEW-20260707-P2P-Hole-Punching-v0.11.1.md) and [TODO.md](../../TODO.md):

> **Status refresh 2026-07-08 (code-verified against the live `0.13.0` line):** the
> 0.13.0 prototype landed much of Phase A in source — statuses below updated
> accordingly. "Landed-in-source" ≠ verified: **nothing has run yet** (§8 checklist
> still at step 1); run-proof is owed on every landed item.

1. B2 (functional relay lane) — **partially landed in source (0.13.0)**
- Landed: `SSF_RELAYS` env parsing with NO hardcoded defaults (the `.example`
  placeholder is gone — unset means "no relay URLs loaded"), and **hint-aware
  dialing** (`EndpointAddr::new(key)` + `with_relay_url` + `with_ip_addr` from ticket
  hints).
- Remaining: stand up ≥ 1 real self-hosted relay; commit a community default list
  (the §2.3-6 `bootstrap_nodes.js` model — env-only config means a fresh install has
  zero relay lane today); run-proof across two networks.

2. S2 (room challenge) — **remains open**
- Must wire capability handshake before room membership registration.
- Cabal-style fix: derive the challenge from the room key itself (§4.6) — membership
  proof comes free with the link, no member list required for open rooms.

3. C3 (share link missing dial key/hints) — **payload + one-button UX landed in source (0.13.0)**
- Landed: room-key-first V2 tickets (`roomKeyB64`, `memberHints[]`, relay/direct
  hints) minted through a unified path — a link without hints is still a valid
  (slower) invite, so minting can no longer produce a dead link.
- Landed: §4.4.1 primary flow now exposes ONE `Copy Invite` action; dual LAN/WAN
   share fields and manual address entry moved into diagnostics-only override controls.
- Remaining: run-proof for zero-typing invite acceptance, and node-side **WAN hint
   autogeneration** from observed addr/relay lane (`endpoint.addr()`) once that lane is
   active.

4. Section 10.2 structural gap — **landed in source (0.13.0)**
- `resolveBridgeBootstrap` applies always-bridge semantics on BOTH import paths
  (Use button + `?seed=`); run-proof owed.

5. C1 cert continuity — **remains half-done**
- iroh key persists; WT identity still regenerates per launch — persist and stage
  current/next cert hashes.
- Note: under §4.2 the WT certhash only matters for the same-LAN direct lane; the
  room-key link itself never stales — continuity pressure drops by design.

---

## 6. Implementation Plan

### Phase A - Wiring completeness (short sprint)

> *Status 2026-07-08: steps 1–5 are landed in source on the `0.13.0` line (see §5
> refresh); step 0 is half-resolved. Phase A closes only when the §4.4.1 UX
> assertions below pass and the landed code has run-proof.*

0. **Unblock the build first** — *updated 2026-07-08:* release-profile GNU **links**
   (first binary produced); dev-profile GNU still fails (export-ordinal wall), so pick
   the iteration toolchain (MSVC recommended) and — above all — **run the binary**:
   every landed item below is execution-unverified.
1. Parse `SSF_RELAYS` in node startup and remove hardcoded placeholder defaults —
   ✓ landed (0.13.0; env-only, no defaults). Still owed: a committed, community-
   PR-extendable default list (the `bootstrap_nodes.js` model, §2.3-6) so fresh
   installs have a relay lane — even if it starts with two entries.
2. Extend bootstrap decode/encode to the §4.2 room-key-first ticket — ✓ landed
   (0.13.0; keep v1 seed decoding for one release).
3. Change import flow to always bridge through local node when available — ✓ landed
   (0.13.0 `resolveBridgeBootstrap`, both import paths).
4. Change iroh dial path to use every hint — ✓ landed (0.13.0;
   `with_relay_url` + `with_ip_addr` per member hint).
5. Mint ALL share links through ONE path that embeds the ticket — ✓ landed (0.13.0);
   the §4.4.1 button/autogeneration UX on top is tracked as its own TODO item.

Acceptance:
- two peers on different networks can rendezvous using only ticket + configured relay
  endpoints; the SAME link still joins after the sharer's node restarts (iroh key
  persistence already landed; WT-cert staleness handled in Phase C).
- **§4.4.1 UX assertions (added 2026-07-08 — Phase A is NOT done without them):**
  the primary share flow is ONE `Copy Invite` button; the invite's hints are
  autogenerated by the node (zero typing); the dual LAN/WAN share fields and the
  manual address input no longer appear in the primary panel (diagnostics drawer
  only). A fresh install must be able to mint a working invite without entering any
  address.

### Phase A′ - Any-member join (the Cabal symmetry)

1. Node announces/joins the §4.5 `topic` (iroh-gossip **[spike-gated]**) whenever a room
   is active; every member is simultaneously introducer and joiner
   (`server: true, client: true` semantics).
2. On join via any single member, gossip membership introduces the remaining peers;
   node maintains `remote_peers` from the swarm view, not just from envelope back-dials.
3. Ticket `memberHints` refresh: nodes append currently-online member hints when
   re-minting links (fresh links stay warm without changing the room identity).

Acceptance:
- room with members A, B, C: A goes offline; a NEW joiner using A's old link still
  joins via B or C without manual re-invite.

### Phase B - Security and trust boundaries

1. Implement the `cap` challenge handshake gate before room join, **derived from the
   room key** per §4.6 (this is S2, the v006 §12.2 handshake, and Cabal's psk0 in one
   move); include `roomClass` + `simTick` in `NodeAck` while the message exists.
2. Per-room identity subkeys (§4.5 `id_seed`) — cross-room uncorrelatability (§2.3-5).
3. Add `SSF_NO_DNS=1` strict validation path (incl. IP-SAN relay cert story, §4.3).
4. Add CORS tighten-up parity (`Vary: Origin` and explicit allowlist maintenance).

Acceptance:
- hostile origin cannot join room,
- no unauthenticated first-envelope room registration,
- a peer with the topic but not the key (e.g. a relay operator) cannot join or read,
- strict mode rejects hostname-based relay inputs.

### Phase C - Stability and continuity

1. Persist WT identity material and stage current/next cert hashes (finishes C1).
2. Add local ysync fan-out and remove panic-prone unwraps.
3. Add ghost-peer fix (authorship stamp on tick lane — C4).
4. mDNS LAN lane (§4.5 lane 3): resolver-dead LAN party joins with zero hints.
5. Epoch re-key drill: advance epoch, verify old-epoch peers bridge for the grace
   window then drop (v006 §7.4; answers Cabal's admitted no-re-key gap, §2.3-7).

Acceptance:
- day-old seed links remain usable across restarts,
- two tabs converge locally,
- remote actor identity is stable,
- LAN join succeeds with DNS blocked and zero ticket hints.

### Phase D - Optional accelerators (never dependencies)

1. Mainline-DHT/pkarr address-lookup lane spike (§4.5 lane 5) — signed records only,
   off in strict builds; measure join-time improvement for hint-less links.
2. DNS shortname sugar (§4.7).
3. QR rendering of `ssf://room/…` tickets in the share panel (pairs with Issue #12's
   QR-onboarding flow and v006 §10.1 challenge-bound capabilities).

---

## 7. Operational Playbook (DNS-Free)

1. Run at least 2-3 community-owned relay endpoints on fixed public IPs.
2. Distribute relay endpoint list via signed config bundle or app update.
3. Rotate relay IP list only via signed update process.
4. Keep a manual out-of-band fallback ticket exchange channel.

Recommended posture:
- direct-first,
- relay-assisted punch when needed,
- strict no-DNS mode in sovereign deployments,
- optional dev mode for convenience outside sovereign builds.

---

## 8. Verification Checklist

1. No DNS dependency proof
- run with resolver blocked and confirm join still works from seed ticket plus relay IP list.

2. No third-party dependency proof
- packet capture confirms only self/community relay IPs are contacted (lane 5 disabled).

3. Cross-NAT proof
- two peers on separate networks connect without manual port forwarding.

4. Strict-mode proof
- hostname relay input rejected when `SSF_NO_DNS=1`.

5. Security proof
- room challenge required before membership and forwarding.

6. Continuity proof
- restart host node; previously shared seed still dials.

7. Key-blinding proof (Cabal §2.3-2)
- packet capture at a relay/introducer shows only `topic` derivations; the room key and
  psk never appear; a synthetic "malicious relay" with the topic fails the §4.6 handshake.

8. Any-member proof (Cabal §2.3-3)
- sharer offline; a new joiner with the old link joins via another online member.

9. LAN-party proof
- two devices, no internet, no hints: mDNS lane joins the room; DNS blocked throughout.

10. Re-key proof (beyond Cabal, §2.3-7)
- epoch advance: old-epoch link holders are bridged for the grace window, then excluded;
  leaked-key simulation confirms the new epoch is unreachable with the old psk.

---

## 9. Decision

Cabal-style sovereignty does not mean "no discovery infrastructure".
It means "no infrastructure outside user/community control".

For StarStation Furlong, the DNS-free sovereign design is viable if we:
1. keep discovery/rendezvous explicit,
2. replace DNS dependency with signed IP-based relay/bootstrap distribution,
3. and complete the open bridge/security wiring identified in the v0.11.1->v0.12.0 re-review.

And the deep-dive adds the design sentence the ticket work should be built around:

> **The room is the key; addresses are hints.** Blind the key into a topic for
> rendezvous (§4.5), gate the handshake with the key itself (§4.6), let any online
> member be the introducer (§Phase A′) — then one shared link joins the room today,
> tomorrow, and after every reboot, which is the entire Cabal UX — delivered on our
> stack, with the re-key, room-class, and T&S layers Cabal itself lacks.

Ordering note: Phase A/A′/B items land inside the existing TODO critical-path item
"v0.12.0 P2P bridge — remainder after re-review"; nothing here supersedes the ⛔
Windows-GNU linker blocker, which remains first.

---

Authored 2026-07-07 for implementation guidance in [TODO.md](../../TODO.md) critical-path item "v0.12.0 P2P bridge - remainder after re-review".
Cabal deep-dive sources (read 2026-07-07): [cabal-core/swarm.js](https://github.com/cabal-club/cabal-core/blob/master/swarm.js) · [cabal-core/bootstrap_nodes.js](https://github.com/cabal-club/cabal-core/blob/master/bootstrap_nodes.js) · [Cable Handshake 1.0-draft8](https://github.com/cabal-club/cable/blob/main/handshake.md) (§2.4 cabal key as psk0, §3.1 per-cabal keypairs, §5.2 threat notes) · [cabal-client README](https://github.com/cabal-club/cabal-client) (DNS shortname resolution) · cabal-core README (moderation model, AGPL license).