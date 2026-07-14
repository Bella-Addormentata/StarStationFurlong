# Keyed Identity + Contacts + Sovereign Mesh: Phased Implementation Plan

*Star Station Furlong — real cryptographic identity, signed contact cards, per-contact room access, and a self-strengthening peer mesh built from your contacts. Design spike output, not code.*

Repo root for all paths: `prototypes/0.26.0-core-loop-demo/`. Produced by a multi-approach design panel (sealed-keyring vs RoomLog-capabilities vs pragmatic-signed) judged on security + feasibility/reuse, then synthesized. Section 7 (mesh substrate) is an owner-requested extension.

---

## 1. Decision: the winning spine and the graft

The judge panel split cleanly by lens:

- **Feasibility/reuse lens → Approach C (score 9).** Wins because it is the only design that found `ssf-p2p-node/src/chia_lane.rs` — an in-tree, unit-tested Ed25519 sign/verify path (`decode_signed`, lines 94–110) — so the node-side verify seam is a *near-copy of existing code*, not greenfield. Smallest migration (possession access unchanged → zero behavior break), smallest browser-crypto surface.
- **Security lens → Approach B (score 9).** Wins because a signed append-only RoomLog folded into a grant set, enforced at the sovereign node with verify-before-apply, is the *only* design that actually answers "can a non-granted party enter?" with **no** — the stated goal.

**Chosen spine: C is v1. B is the committed end-state (Phase 2). A supplies the optional confidentiality tier (Phase 3). The contacts-as-mesh layer (Phase 4) is the sovereignty payoff.**

This ordering is the dependency graph, not a compromise. B's RoomLog enforcement *requires* the identity keypair, canonical sign-bytes, and verify-before-apply plumbing that C's slices build first. C is literally slices 1–4 of B with honest scope limits. Phase 4's sybil-resistant peer gossip *requires* the verifiable identities + signed introductions that Slices 1 & 3 build. Shipping C first means every slice is independently reviewable and the fleet is already signing (in `warn` mode) before we ever flip enforcement on.

### What was grafted from where

| Grafted idea | From | Where it lands |
|---|---|---|
| Reuse `chia_lane.rs` tested Ed25519 verify as the node gate; `SSF_REQUIRE_SIG=off\|warn\|reject` staged rollout | C | Slice 2 |
| Canonical sign-bytes bind `v‖roomId‖kind‖seq‖payload` — fixes the payload-only gap | C | Slice 2 |
| Signed append-only RoomLog → grant-set fold → verify-before-apply at BOTH node reader loops | B | Phase 2 (Slices 5–6) |
| `roomId = base32(blake3(ownerPubKey‖nonce))` genesis-spoof defense | B | Slice 5 |
| Observe-then-enforce with a false-drop metric before flipping | B | Slice 2 (`warn`) → Slice 6 (`reject`) |
| Sealed content under the room key (`chia_lane::seal/open` already implements XChaCha20-Poly1305) | A | Phase 3 (optional) |
| One seed → backup UX (recovery phrase surfaced in Contacts on mint) | A | Slice 1 |
| Honest "authenticated invite" not "private room" copy | C | UI copy throughout |
| Signed, consent-gated, trust-weighted friend-of-friend peer gossip | owner ask | Phase 4 |

---

## 2. Reusable infrastructure inventory (verified against the code)

- **The sign seam is threaded and stubbed, with a comment naming this exact work.** `YjsSyncOptions.sign?` (`src/network/YjsSync.ts:34`, doc-comment *"the verify-before-apply seam must exist"*); `#emitEnvelope` calls it when present (`~183`) but the app never supplies it and stamps a dummy zero author (`~193`); inbound applies with **no check** (`Y.applyUpdate(..., 'server-origin')`, `~318`).
- **The wire already carries `author` + `sig`.** `SsfEnvelope.author` (Ed25519 pubkey) + `sig?` at `src/network/protocol.ts:33–35`.
- **Tested crypto exists in the Rust node (verified).** `chia_lane.rs`: `encode_signed`/`decode_signed` (Ed25519 via `iroh::PublicKey::verify`, `81–110`) and `seal`/`open` (XChaCha20-Poly1305 under `derive_enc_key(room_key)`, `112–138`), with a `record_roundtrip_sign_seal_open_verify` test (`177+`). Node identity is Ed25519.
- **Shareable-credential carrier.** `encodeBootstrapSeed` (`src/main.ts:2029`) / `decodeBootstrapInput` (`~2117`).
- **`RoomBootstrap` dormant slots.** `roomKeyB64`, `memberHints`, `issuedAt`, `expiresAt`, `sigB64` (`src/network/protocol.ts:87–94`; `sigB64` never produced today).
- **RoomLog contract pre-specified + stubbed.** `RoomLogPort`/`RoomLogOp` with `writer` (Ed25519 pubkey), plus a client-local writer-keyed mute set (`src/network/RoomLog.ts`, 36-line stub).
- **Mint/persist patterns to mirror.** `getPlayerId()` (`src/identity.ts:49`), `getOrCreateRoomKeyB64()` (`src/main.ts:134`) — localStorage-cached with privacy-mode fallback.
- **Persisted pass list + prefetch + `addPass`** (`src/roomPasses.ts`), the `players` Yjs map (`src/main.ts:1027`), ACCESS app + Contacts "NO SIGNAL" placeholder (`index.html`).
- **Room-scoped, transient peer gossip** already forms a mesh: a relayed envelope introduces a THIRD party and the node dials it via the smaller-id rule (`ssf-p2p-node/src/main.rs:1297–1312`), plus Mainline-DHT + mDNS discovery. `remote_peers` is per-room and dissolves on leave — Phase 4 makes it durable.
- **No crypto dependency today** (`package.json`: msgpackr, three, y-*, yjs). v1 adds exactly `@noble/ed25519` + `@noble/hashes`.

---

## 3. Phased slices (dependency order)

**Slices 1–4 = v1** (authenticity + honest grants). **Slices 5–6 = end-state** (real per-key authorization). Each is independently reviewable/shippable.

### Slice 1 — Identity keypair, additive only (no wire change)
New `src/keypair.ts`: mint/persist a 32-byte Ed25519 seed in localStorage beside the UUID (minted-once/cached like `getOrCreateRoomKeyB64`, privacy-mode fallback); expose `getIdentityPub()`, `sign`, `verify`, `exportRecoveryPhrase`/`importRecoveryPhrase`. `getPlayerId()` returns the pubkey for keyed installs; the UUID persists as a legacy handle. `players` map becomes dual-read (pubkey **or** legacy UUID) and gains `keyB64` + a self-signature on `PlayerEntry` so name↔key is a verifiable self-cert.
- **Crypto/API:** `@noble/ed25519` (+ `@noble/hashes/sha512`), *not* WebCrypto — the seed must be **exportable** for the recovery phrase (BIP39-style 24 words). Seed from `crypto.getRandomValues`.
- **Acceptance:** fresh install mints + persists a key (stable across reload); clear localStorage + re-import phrase → identical pubkey; two tabs in a legacy room still render each other; no wire change.

### Slice 2 — Real sign / verify-before-apply seam (the spine's core)
New `src/network/signBytes.ts`: canonical bytes = domain-tagged `blake3(v ‖ roomId ‖ kind ‖ seq ‖ payload)` — binds roomId + kind (closes the cross-room replay hole; today's `opts.sign` would cover only `payload`). Wire `opts.sign` into every `YjsSync` site (main + the `roomPasses.ts` prefetch); real pubkey author. Browser verify-before-apply before `Y.applyUpdate` (`~318`) + in `ingestEnvelope`. Node verify-before-apply in the ysync merge path — a near-copy of `chia_lane.rs:94–109` — gated by **`SSF_REQUIRE_SIG = off|warn|reject`**, shipping at **`warn`** (log only).
- **Acceptance:** `warn` logs 100% valid + zero false drops (the metric that authorizes `reject`); tampered payload dropped browser-side + logged node-side; a valid envelope replayed into a different roomId is rejected; an old unsigned client still merges under `warn`.

### Slice 3 — Signed contact cards + the Contacts phone app
`SsfContactCard = { v, kind:'contact', pub, name, issuedAt, sig }` self-signed over canonical bytes. `encodeContactCard` wraps `encodeBootstrapSeed`; `decodeBootstrapInput` gains an `ssf://contact?card=<b64>` branch. Persist an `ssf-contacts` list shaped like the pass list. Replace the Contacts "NO SIGNAL" placeholder with: self-card + QR, an import box (decode → **verify sig** → add), and a list showing name + short pubkey fingerprint + verified badge. TOFU: proves key ownership, not name uniqueness (copy says so).
- **Acceptance:** A's self-card QR imports on B with a verified badge + fingerprint; a flipped byte is rejected; contacts survive reload.

### Slice 4 — Room-granting card (v1 "grant" = authenticated invite)
"Share this room with a contact": bundle the room's `RoomBootstrap` into a signed card (`SsfContactCard.room?`), populating the dormant `sigB64` with the owner's signature over `roomId‖issuedAt‖subjectPub`. On import: verify → add contact **and** feed `card.room` straight into the existing `addPass()` pipeline (zero new room-loading code; the staged-list prefetch warms it).
- **Honest scope:** access stays **possession-based** (`getOrCreateRoomKeyB64` unchanged); the *grant* is the authenticated act of sharing — the recipient knows cryptographically *who* invited them and every in-room write is signed, so a present member can't forge state as another contact. v1 revocation = rotate roomKey + re-issue. **Copy says "authenticated invite," never "private room."**
- **Acceptance:** owner grants B → B is a saved contact *and* auto-joined via the pass path; the grant sig verifies against the owner's card pubkey; a stranger *forwarded* the same blob also gets in (documented v1 limit).

### Slice 5 — RoomLog capability engine + genesis binding *(end-state, Phase 2)*
Make `RoomLog.ts` real over a `Y.Array('roomlog')` in the existing doc: signed ops `{writer, seq, prevHash, kind, body, sig}` chained by `prevHash = blake3(prev)`; kinds `create(ownerPub) / grant(subjectPub, epoch) / revoke(subjectPub, epoch)`. `roomId = base32(blake3(ownerPub‖createNonce))`, `create` self-signed — any node checks `roomId == derive(create.owner)`, killing genesis spoofing. `grantSet = fold(roomlog)` from `{owner}`. RoomLog ops sync first. Ships shared TS/Rust test vectors for the fold.
- **Acceptance:** owner `create`+`grant(B)` → B's ops accepted, a non-granted key's ops dropped at the browser verify point even before node changes; two clients fold to byte-identical grant sets against the vectors.

### Slice 6 — Node-side enforcement + revocation *(the teeth, Phase 2)*
Port the fold to Rust; in **both** node reader loops, after deserialize and before forward/merge, verify `sig` **and** `author ∈ grantSet(room)` (cached + invalidated) → drop on fail. **Dual-mode:** a room is "keyed" iff it has a valid `create` op, else it falls through to today's open behavior (every existing possession room keeps working). Owner grant/revoke UI. Flip `SSF_REQUIRE_SIG=reject` once Slice-2 metrics are clean. Revocation = signed `revoke`, forward-only (name the consensus-free race limit).
- **Acceptance:** a revoked contact's envelopes are dropped at every honest node/peer; a forged `grant` never validates; legacy rooms unaffected. This is where "anyone with the pass gets in" is finally false for keyed rooms.

### Phase 3 (optional, de-risked) — Content confidentiality vs. a curious node
AEAD-encrypt ysync/roomlog payloads under the epoch room key. `chia_lane::seal`/`open` (`112–138`) already implement XChaCha20-Poly1305 under `derive_enc_key(room_key)`, so the primitive is built. The load-bearing decision is architectural (the node can no longer merge encrypted state — it becomes a ciphertext relay), not cryptographic. Keep sealing as the confidentiality *layer*, not the access mechanism.

---

## 4. Threat model — ship with eyes open

**v1 (Slices 1–4) enforces:** identity authenticity (can't author as another's pubkey); message/state integrity; grant attribution (recipient knows *who* invited); in-room anti-impersonation; cross-room replay resistance (sign-bytes bind roomId+kind+seq).

**v1 does NOT enforce:** unauthorized room *entry* (possession of `roomKeyB64` = entry, checked nowhere → a forwarded pass admits any holder; fixed in Slice 6); surgical revocation (only roomKey rotation until Slice 6); confidentiality (node relays plaintext; Phase 3); sybil / name-squatting (key minting is free, names are TOFU — always show the fingerprint); key theft (seed in localStorage → any XSS on-origin exfiltrates it, same class as today's roomKey/UUID — **audit the pre-existing `innerHTML` sink in `simulateLocalMessage`, `src/main.ts` ~2168, before shipping**); a malicious/censoring remote node (only harms its own users — it can't inject forged-author state into you, since you verify).

**End-state (Slice 6) adds:** per-key authorization at the sovereign node (ungranted authors dropped), genesis-spoof resistance, signed revocation. Still no confidentiality (Phase 3) and no beating consensus-free revocation races.

---

## 5. Key decisions for the owner

1. **Browser key store:** `@noble/ed25519` (exportable seed) vs WebCrypto non-extractable. *Rec: `@noble`* — a sovereign no-recovery-service stance makes a user-held recovery phrase mandatory, which non-extractable keys forbid. Cost: XSS-exfiltratable seed.
2. **End-state access model:** RoomLog capabilities (B) vs sealed-keyring (A). *Rec: RoomLog* — enforces at the node without forking Yjs; `RoomLogPort` already exists. Keep sealing as the Phase-3 confidentiality layer.
3. **UUID → pubkey migration:** *Rec: gentle/dual-read* — keep the UUID, mint the key lazily, `players` reads either; existing installs gain a key on next boot with zero reset.
4. **`SSF_REQUIRE_SIG` cutover:** ship `warn`, watch the false-drop metric, flip to `reject` with Slice 6. Decide *now* who owns the flip (leaving `warn` forever silently enforces nothing).
5. **Revocation posture:** v1 coarse rotation (label invites honestly); end-state signed `revoke` (forward-only, eventually consistent). Hard immediate kicks need a Station-Seal/epoch checkpoint.
6. **Contact-card codec:** JSON (reuse `encodeBootstrapSeed`) for the carrier + msgpackr/blake3 only for canonical sign-bytes.
7. **(Phase 4) Reachability-sharing default:** opt-in vs opt-out discoverability, peer-store cap, and whether introductions are automatic or user-curated (§7).

---

## 6. Sovereignty check — no third-party infrastructure introduced

Confirmed across every slice. No servers, PKI, CA, key-directory, or STUN/TURN beyond the existing iroh mesh. Identity is a locally-minted seed; a contact is a self-signed card exchanged peer-to-peer (QR / paste / the `ssf://` carrier); a room's authority is its owner's own key. New deps are two dependency-free in-browser npm packages (`@noble/ed25519`, `@noble/hashes`); the Rust side adds **zero** heavy deps (verify reuses `iroh`/`ed25519-dalek`/`blake3`; confidentiality reuses `chia_lane`). The local node stays the only trusted component — v1 verifies signatures it already relays; the end-state *enforces* the owner-signed grant set (blind relay → sovereign enforcement point); Phase 3 would route ciphertext under a key it never holds. Every step strengthens, none dilutes, "your node, your keys, no one else's infrastructure."

---

## 7. Phase 4 — Contacts as a self-strengthening mesh substrate *(owner-requested)*

**Thesis:** turn the contacts graph into a durable, cross-room peer substrate. Today's mesh gossip is real but *ephemeral* — `remote_peers` is per-room and dies on leave (`main.rs:1297`). Make it persistent, consent-gated, and trust-weighted so the network densifies and self-heals from *who you know*, with no central index. **Depends on Slices 1 + 3** (verifiable identities + signed introductions are the entire sybil defense — do not build this before them).

**Why it matters (the sovereign payoff):** the real pain is NAT — two home routers can't directly hole-punch (the whole reason issue #60 existed). A *reachable* friend-of-a-friend becomes an introducer/relay, so the more of the trust graph your node knows, the more paths exist to reach an otherwise-unreachable peer. It's the sovereign alternative to renting relay servers, and it makes the staged room-list (`roomPasses.ts`) instant: if your node already knows a friend's node, entering their room is warm from the start.

### The reachability-vs-social-graph split (the core privacy rule)
Sharing "contacts" bundles two very different things; they must be handled separately:
- **Reachability** — a peer's pubkey + current addresses. Semi-public already (the DHT resolves addresses by key). Shareable liberally *with consent*.
- **Social edge** — the fact that *you* know someone. Sensitive; the friend graph must **never** be gossiped wholesale.

So a person is discoverable only via a self-signed **`discoverable`** flag in their own contact card, and you share the durable **pubkey + refreshable hints**, never a pinned stale IP (the v0.22.0 dynamic-IP re-resolution keeps hints fresh by key).

### Slices
- **M1 — Durable peer store (node-side).** Generalize the transient per-room `remote_peers` into a standing, **bounded, curated** store: `{pubkey, last-known addrs, last-seen, trust-score, introducer}`. Eviction is LRU / least-useful under a hard cap; addresses refresh via DHT re-resolution by pubkey (existing R1 machinery). *Acceptance:* the store survives leaving a room; capped growth under a bounce loop; stale addrs re-resolve.
- **M2 — Consented, signed introductions.** A contact card carries an optional reachability hint for a `discoverable` subject; an **introduction** = a signed `{subjectPub, addrs, introducerPub, issuedAt}` gossiped friend-of-friend, riding the reserved **`cap`** envelope kind (`protocol.ts:35`). Only `discoverable` subjects are ever introduced; social edges are not transmitted. *Acceptance:* a non-discoverable contact is never gossiped; a tampered introduction fails signature verify and is dropped.
- **M3 — Trust-weighted dial policy (the sybil defense).** Rank dial/introduce candidates: direct contact > friend-of-trusted-contact > unvetted. **Never blind-dial an unsigned/unvetted address.** Trust flows from the web-of-trust the keyed identity provides; sybil is *mitigated* (unvetted peers deprioritized/capped), not eliminated (key minting is free). *Acceptance:* an injected batch of unsigned/unvetted peers is deprioritized below real contacts and can't crowd them out of the capped store.
- **M4 — Reachability introduction / relay (the payoff).** A reachable peer in your trust graph introduces or relays two otherwise-unreachable peers, reusing the existing iroh mesh-upgrade dial (`main.rs:1297`) now seeded from the durable store. *Acceptance* (two-machine): a peer behind an un-forwarded NAT is reached via a mutual reachable contact, with no relay server configured.

### Mesh threat-model addendum
- **Enforces:** introductions are signed (can't forge who vouched); trust-weighting resists sybil crowding; consent-gated (only `discoverable` contacts gossiped, social edges never transmitted wholesale).
- **Does NOT:** stop a malicious contact lying about a peer's *address* (trust the identity, **verify the route** by probing — a bad address just fails to connect); hide the social graph from an adversary already inside your trust circle; eliminate sybil (free key minting — bound its blast radius with caps + trust, don't assume it away); force any peer to relay.

### Key decisions (Phase 4)
Discoverability default (recommend **opt-in** for a sovereignty-minded audience); peer-store cap size + eviction policy; automatic vs user-curated introductions (recommend automatic for reachability among mutuals, curated for anything wider); and whether relaying for others is on-by-default or opt-in (bandwidth + exposure).

---

## 8. Social structure: Friends, Contacts (mesh), and Companies *(owner refinement)*

Two tiers over the keyed identity, plus a future shared-ownership entity. This splits the double duty "Contacts" carried above (verified people *and* mesh substrate) into a cleaner layering.

**Contacts = the mesh (wide, low-intent).** Every verified identity your node has encountered or been introduced to — the §7 peer/identity graph, auto-populated from rooms + gossip + introductions. Purpose: reachability, discovery, "people you've met." A contact is just a verified key you've seen; trust is low by default.

**Friends = curated (narrow, high-intent).** A subset you explicitly add, via a **mutual signed handshake** (you sign a friend-request to their key; they accept by counter-signing — mutual friendship = both signatures, a verifiable two-party cert). Purpose:
- **Trust anchors for the mesh.** "Friend-of-trusted-friend" (§7 M3) becomes literally friend-of-friend — sybil-resistant peer prioritization radiates from your **friends**, not from anonymous mesh contacts. Friends are the web-of-trust roots.
- **The DM boundary.** DMs go to friends; non-friends can't DM you (or land in a "requests" bucket). Natural spam control a keyless system can't do cleanly.
- **Presence you care about** (their online/offline status — the S3 presence work).

### Friends + Direct Messages *(maps to phone-apps S5)*
- **Friend request / accept** = signed ops `{from, to, issuedAt, sig}` + the counter-signed accept, carried over the existing `ssf://` credential + the Slice-2 sign seam. Pending requests surface in a Friends "requests" bucket.
- **DM** = a conversation between two mutual-friend keys. Substrate: a Yjs conversation doc keyed by the *sorted pair of pubkeys* (mirrors the room/games docs, syncs via the node) — authenticated by the sign seam. For confidentiality even against a curious node, seal payloads to the recipient's key (`chia_lane::seal/open`, Phase 3). Recommend authenticated DMs first, sealed later.
- **Depends on:** Slice 1 (keys) + Slice 2 (sign seam) + Slice 3 (contacts). Sits alongside Slice 4. This is the S5 "DMs" slice, now cleanly gated: friends only, verified keys, no server, no directory.

### Future: Companies (shared ownership + income)
A **company** is a *keyed entity* — its own identity (keypair) plus a set of member keys and ownership shares — that collectively owns items and receives income. Sovereign, no registrar. It fits the keyed model directly:
- **Identity:** a company is a pubkey like any other; its authority is a *shared control policy*, not a single private key.
- **Control:** **M-of-N threshold** — transferring an item or paying out requires signatures from a threshold of member keys (multisig), recorded on a company ledger (the RoomLog machinery generalizes: an append-only signed op-log, for an entity instead of a room).
- **Ownership:** items become *signed ledger claims* for the company rather than mere possession — which requires **moving asset-ownership from today's possession model** (furniture/modules you happen to hold) to a signed ownership ledger. That is the load-bearing prerequisite.
- **Income:** the Bank ledger (phone-apps S6) credits the company account; distribution splits by share to member keys. Income sources tie into games/wagering (the chia-gaming rail in `games-plan.md`).

**Honest placement:** economy-phase, several steps out — it depends on (a) keyed identity (this design), (b) the Bank/ledger (S6), and (c) asset-ownership-as-ledger (new). Record it as the north-star for a "shared entities" phase; don't build it before the economy exists. But nothing in the keyed-identity foundation blocks it: a company is just a keyed entity with a threshold control policy and a share ledger — all expressible with the same Ed25519 + signed-op-log primitives this plan already builds.

---

## 9. Room access modes: Public / Pass / Keyed — doors as the surface *(owner refinement)*

Access is a spectrum, not a lock. A room carries an explicit owner-set **access mode**, stored in `roomInfo` and surfaced at the door:

- **Public / Unlocked** — anyone can enter; freely discoverable; the door is open (green), no pin, no grant. Town squares, shops, open events. The deliberate *open* end — the counterpart that keeps the mesh welcoming rather than walled.
- **Pass / Possession** (today's default) — anyone holding the room pass enters (shareable link; unlisted-but-open).
- **Keyed / Granted** — only granted contact keys (Slices 5–6). Homes, private hangouts.

**Doors are the surface.** `DoorTarget` (`src/doors.ts:22`) already has an `enabled` flag and a `requestOpen` that can be **denied** — *"Returns false immediately when the request is denied (locked port)"* (`src/doors.ts:53–56`). That denial hook is exactly the seam: an **unlocked/public door** always opens and admits anyone who walks through; a **locked door** consults the target room's mode (the existing pin/keypad today; the grant check after Slice 6). The north door's keypad is the "locked" visual — "public" is its open twin (green, always-opens).

**This ships mostly independent of the crypto — and can come FIRST.** "Public" is the *permissive* direction: no new enforcement, just (a) an explicit `accessMode: 'public'` on the room (`roomInfo`), owner-set in edit mode, (b) a door unlocked-state (open/green, no pin, always-opens), and (c) optionally listing the room as discoverable (a simple shareable "public rooms" set, later advertised over the §7 mesh). The *restrictive* direction (keyed grants) is the part that needs Slices 1–6. So a **public-doors slice is a candidate to land before the keyed identity** — it makes the open mode intentional and legible today, and it composes cleanly with the crypto because the node's Slice-6 rule is already "keyed iff a valid `create` op exists, else open." Public/pass rooms simply never carry a `create` op, so they need no gate by construction; `accessMode` is the owner's stated *intent*, and the node enforces only the keyed case.
