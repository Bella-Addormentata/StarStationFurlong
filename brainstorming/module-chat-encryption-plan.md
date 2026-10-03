# Module Chat Encryption: Signal Mechanics, Reusable Access Control, and Tribler

> Answers issue #183. Repo root for all source paths: `prototypes/0.29.0-core-loop-demo/`.
>
> **Companions:** [keyed-identity-contacts-plan.md](keyed-identity-contacts-plan.md) (the identity
> spine this builds on — its *Phase 3* is the slot this work fills),
> [room-durability-plan.md](room-durability-plan.md) (sealed snapshots, same key question),
> [chia-authority-architecture.md](chia-authority-architecture.md) (where enforcement eventually lands).

The issue asks five things. Short answers first, evidence after.

| # | Question | Answer |
|---|---|---|
| 1 | Could we use Signal's mechanics to secure each module's chat? | **The mechanics yes; the library no.** Sender Keys is the right shape and SSF already has two of its three prerequisites. `libsignal` itself is AGPLv3 and ships as a native Node addon — a bad fit for a browser client whose whole dependency posture is two audit-sized `@noble` packages. |
| 2 | Anyone with access to the module can read the chat? | **That is the correct design target, and it is not what happens today.** Today it is *wider*: anyone who ever held the pass, plus the node operator, plus any prefetching peer. Making the target true requires rekeying on membership change — otherwise "access" never ends. |
| 3 | Which existing room access permission details can we reuse? | **Most of them.** The `players` key directory, `coHosts`, `doorGrants`, `accessMode`, the deed, contact cards and the DM pair-doc each map onto a named part of a group-E2EE design. Inventory in §4. |
| 4 | Is there any level of encryption already built in for chat? | **Transport only. No confidentiality, and for room chat, not even authenticity.** DMs are signed; room chat is not. Details in §1. |
| 5 | Is Tribler worth studying? | **Worth reading, not worth adopting.** py-ipv8 is Python-over-UDP with no browser path, and iroh already covers its transport job. Its *lesson* is real though: E2EE hides the text, not the social graph. §5. |

---

## 1. What exists today — the honest baseline *(answers Q4)*

Three layers, and only the middle one does any end-to-end work.

### 1.1 Transport: encrypted hop-by-hop, plaintext at every node

Browser → node is raw WebTransport over QUIC/TLS with `serverCertificateHashes` pinning
(`src/network/NetworkProvider.ts:98-99`). Node → node is iroh (QUIC, Ed25519 node identity,
relays). So bytes on the wire are encrypted **between hops** — and every hop terminates that
encryption and holds plaintext. This is TLS. It is not end-to-end encryption, and it protects
nothing from the node itself.

The browser even hands the node the room key deliberately: `sendRoomCap`
(`src/network/NetworkProvider.ts:231-250`) ships `roomKeyB64` over a one-shot `cap` stream, with the
comment *"it holds the room's plaintext doc already, so this is loopback-only and exposes nothing
new."* That comment is accurate today and is exactly the sentence that stops being true the moment
chat is sealed.

### 1.2 Authenticity: real, end-to-end, and applied unevenly

A per-install Ed25519 keypair exists (`@noble/ed25519`, `src/keypair.ts:18`), seeded from a 32-byte
value in `localStorage` under `ssf-identity-seed` (`:25`, `:45-58`), exportable as a recovery
credential (`:133-149`). Every state-mutating ysync envelope is signed over canonical bytes binding
`v‖roomId‖kind‖seq‖payload` under a blake3 digest (`src/network/signBytes.ts:19-31`) and verified
before apply (`src/network/YjsSync.ts:302-317`).

Two caveats, both load-bearing:

- **Verification is "observe", not "enforce".** An envelope with no signature is *allowed through*
  and merely not trusted as host state (`YjsSync.ts:303-304`). Only a signature that is present and
  *invalid* causes a drop (`:312-314`).
- **Room chat is not signed at all.** The chat record carries
  `authorId: getPlayerId()` (`src/main.ts:6932`) — the localStorage UUID, which
  `src/identity.ts:11-13` labels in its own header: *"NOT security … nothing stops a peer from
  claiming any id or name."* The Ed25519 key exists and is published in the same room doc, and chat
  does not use it.

DMs are the exception and the proof the pattern works: `msgSignBytes` binds
`roomId‖author‖authorName‖ts‖text` (`src/directMessages.ts:92-95`), `verifyMessage` requires the
author be one of the two pair members (`:99-103`), and `readMessages` **drops** anything that does
not verify before it renders (`:174-181`).

### 1.3 Confidentiality: none, for either chat surface

**Room chat** is a plain `Y.Array("chat")` on the room doc (`src/main.ts:2003`). The send path pushes
`{authorId, authorName, text, atTick, scope, atX, atZ}` as cleartext and trims the array to the last
200 entries inside the same transaction (`src/main.ts:6925-6951`). It is therefore in the CRDT, in
every peer's replica, in the node's copy, and in any cached snapshot.

**DMs** are explicitly not confidential, and the code says so twice. The module header:

> *"v1 is authenticated but NOT confidential: the derived key is possession-based room access, not
> payload encryption (the node relays plaintext, same as every room today)."* — `src/directMessages.ts:17-19`

And `dmRoomKeyFor`'s own doc comment (`:77-81`) is unusually candid: the "room key" is derived from
the two **public** keys, so *"anyone who has seen both pubkeys can recompute it … It is an addressing
tag, not a secret."* That function's name is the single most misleading thing in this area of the
codebase; anyone skim-reading it would reasonably assume DMs are encrypted. They are not.

### 1.4 The AEAD already exists — on the node, for something else

[keyed-identity-contacts-plan.md:29](keyed-identity-contacts-plan.md) and `:82` record that the Rust
node implements `seal`/`open` as XChaCha20-Poly1305 under `derive_enc_key(room_key)` in
`chia_lane.rs:112-138`, with a `record_roundtrip_sign_seal_open_verify` test, used today for sealed
presence records. *(The node source lives outside this repo — that is the plan's verified-at-the-time
claim, carried forward, not something re-checked here.)* The plan already reserves the work this
issue is asking about:

> **Phase 3 (optional, de-risked) — Content confidentiality vs. a curious node.** *"The load-bearing
> decision is architectural (the node can no longer merge encrypted state — it becomes a ciphertext
> relay), not cryptographic."* — `keyed-identity-contacts-plan.md:81-83`

That sentence is the real cost of this feature, and §6 takes it seriously.

### 1.5 One unrelated gap worth recording while we are here

The chat read path does `const items: any[] = sharedChat.toArray()` (`src/main.ts:2010`) with no
shape guard — the only peer-facing doc read in the codebase without the `isXRecord` convention that
`doorPolicy`, `roomRoles`, `doorLayoutDoc`, `airHockeyTheme` and the rest all follow. Rendering is
via `textContent`/`createTextNode` (`:2026`, `:2028`), so this is **not** an XSS: it is a robustness and
consistency gap, and it is the natural place a `isChatRecord` guard would go when chat records gain
a signature. Worth its own small issue regardless of whether encryption ships.

---

## 2. "Anyone with access to the module can read the chat?" *(answers Q2)*

### 2.1 Today the readership is wider than module access

| Who | Can read room chat today? | Why |
|---|---|---|
| A member standing in the room | ✅ | the doc is theirs |
| **Anyone ever forwarded the pass** | ✅ | possession is entry, *"checked nowhere"* — [keyed-identity-contacts-plan.md:90](keyed-identity-contacts-plan.md) |
| **Someone the owner "removed"** | ✅ | there is no removal; `accessMode: 'keyed'` is labelled in the UI itself *"enforced once keyed identity ships"* (`src/main.ts:7648`) |
| **The node operator** | ✅ | the node holds the plaintext doc and the room key (`NetworkProvider.ts:231-250`) |
| **A co-host / prefetching peer** | ✅ | `roomPasses.ts` keeps a passive `YjsSync` per held pass; a warm room is a full replica |
| **A late joiner, for messages sent before they arrived** | ✅ | the last 200 messages are *in the CRDT*, so they arrive with SyncStep2 |

And nothing enforces any of it. `src/roomOwner.ts:26-32` states the position plainly, and it is the
most important paragraph in this whole analysis:

> *"nothing authorizes a write to a room doc today, so a modified client ignores every function in
> this file and writes the Yjs record anyway … read every check here as 'should this client offer the
> action', never as 'can this peer do it'."*

`roomRoles.ts:20-21` and `doorPolicy.ts:22-24` say the same for their own maps: *"dev-phase UI gating
on writes, shape-checked reads."*

### 2.2 What the design target actually commits us to

"Anyone with access to the module can read the chat" is the right model for this game — it matches
the physical metaphor (you are in the room, you hear the room) and it is what makes chat feel like
part of the world rather than a bolted-on messenger. But stated precisely it must mean:

> **Anyone who has module access *at the time a message is sent* can read that message — and nobody else, ever.**

That phrasing forces three consequences, and they are the whole engineering problem:

1. **Membership change must rekey.** A departing member keeps every key they ever held and can
   decrypt any ciphertext they retained. Without rekeying, "removed" is cosmetic — exactly the
   situation today, just with extra maths. In the literature this is *post-compromise security*,
   and §3 shows it is the axis on which the candidate designs differ most.
2. **History becomes a product decision.** Today a joiner syncs the last 200 messages. Under
   rekey-on-join they *cannot* read anything sent before they arrived unless the room deliberately
   hands them an old epoch key. Signal and MLS both default to "no history." This is the owner's
   call, not a technical given — see §7.
3. **The node stops being a participant.** It can still relay and store ciphertext, and it must stop
   merging chat as CRDT state it understands. This is `keyed-identity-contacts-plan.md:82`'s
   architectural warning, and it is why §6 scopes sealing to a *lane*, not to the whole doc.

---

## 3. Signal's mechanics, mapped onto SSF *(answers Q1)*

### 3.1 What "Signal mechanics" actually consists of

Four separable pieces, and only the first three matter here:

| Piece | What it provides | Relevance to a room chat |
|---|---|---|
| **X3DH / PQXDH** | asynchronous session setup — encrypt to someone who is offline, using pre-published keys | needed: SSF peers are frequently offline |
| **Double Ratchet** | per-message forward secrecy and post-compromise security on a *pairwise* channel | needed pairwise; **not** how groups are done |
| **Sesame** | multi-device session management — which of a contact's devices holds the live session | **not needed yet**: SSF identity is per-install, one seed per browser (`keypair.ts:45`). It becomes relevant the day one identity runs on phone *and* desktop |
| **Sender Keys** | the actual group mechanism: each member holds a symmetric chain key + signing keypair, distributes it over the pairwise channels, then encrypts to the group under their own ratcheting key | **this is the piece the issue is really asking about** |

Sender Keys works like this: advance your chain key with a hash, encrypt under the new key, sign,
fan out. Receivers verify the signature, ratchet their copy of your chain forward, decrypt. It scales
because nobody computes a shared group key — which is precisely why it is used by Signal, WhatsApp,
Matrix, Session and Messenger for groups.

### 3.2 Where SSF already fits, and the one piece missing

Sender Keys needs three things. SSF has two of them already built and tested:

| Prerequisite | Status in SSF |
|---|---|
| **A per-identity signing key** | ✅ Ed25519, `src/keypair.ts` |
| **A key directory — who is in the room, and which key is theirs** | ✅ the `players` map carries `keyB64` + a self-signed name↔key cert (`src/main.ts:3057-3068`, written at `:3085-3095`), and the client **already verifies those certs** before trusting a key (`src/main.ts:7978-7991`) |
| **A pairwise confidential channel to distribute sender keys over** | ❌ the *doc* exists — the DM pair-doc (`src/directMessages.ts`) — but it is authenticated only, and there is **no X25519 key anywhere in the codebase** |

That third row is the entire gap. An ECDH key is required and SSF has only a signing key. Two routes:

- **Mint a second X25519 key** and publish it in the same `players` entry and contact card. Clean
  separation of signing and key-agreement; one more field to carry; the recommended route.
- **Convert the Ed25519 key** via the Edwards↔Montgomery birational map (what libsodium's
  `crypto_sign_ed25519_pk_to_curve25519` does; `@noble/curves` exposes `edwardsToMontgomery`). No new
  field, but it reuses one key across two protocols — a cross-protocol-attack surface that is
  avoidable here for the cost of 32 bytes in a map we already write.

### 3.3 The limitation that decides room size

RFC 9420 names the Sender Keys trade-off explicitly: post-compromise security is expensive —
key-update traffic scales with the **square** of group size — and *an adversary who learns a sender
key can often indefinitely and passively eavesdrop on that member's messages*.

For a module holding 2–20 avatars, that is a non-issue. For a public "town square" module with a
hundred people, it is. The standardized alternative is **MLS (RFC 9420)**: tree-based group key
agreement where FS and PCS hold and *rekeying on membership change is a first-class operation* —
which is exactly what §2.2's design target demands. RFC 9750 is the matching architecture document.

**Recommendation:** Sender Keys now, MLS as the named end-state if module populations grow. Note
that the SSF `accessMode` split already draws the line in the right place: `public` modules are the
large ones and arguably should stay unsealed (a town square is not confidential), while `keyed`
modules are homes and hangouts — small, and exactly where Sender Keys is strongest.

### 3.4 Do not take the library

`signalapp/libsignal` is **AGPLv3**, written in Rust, exposed as Java/Swift/TypeScript bindings where
the Node package `@signalapp/libsignal-client` is a **native addon** (prebuilt binaries for Windows,
macOS and Debian) — not a browser module. Signal Desktop compiles libsignal to WASM for its own
Electron renderer; a community browser-WASM wrapper exists and does cover sender-key distribution
and group encrypt/decrypt, but is explicitly not a drop-in for the upstream package.

Against that, SSF's stated posture is `keyed-identity-contacts-plan.md:108-110` — *"no servers, PKI,
CA, key-directory"*, with runtime dependencies today of exactly `@noble/ed25519`, `@noble/hashes`,
`msgpackr`, `three`, `yjs` and the `y-*` family (`package.json`). Adding an AGPLv3 WASM blob would be
the single largest dependency and licence decision in the project's history, to obtain mechanics that
are roughly 300 lines of `@noble` calls.

**Build the mechanics, not the import.** Adding `@noble/curves` (X25519) and `@noble/ciphers`
(XChaCha20-Poly1305 — matching the AEAD the node already uses) keeps the dependency-free,
in-browser, auditable posture `keypair.ts:11-14` chose deliberately, and keeps the browser and the
node speaking the same cipher.

---

## 4. Reusable access-control inventory *(answers Q3)*

Every row below already exists, is already keyed the right way, and already has UI. This is the
reason the work is tractable.

| Existing mechanism | Where | What it becomes in a sealed-chat design |
|---|---|---|
| Ed25519 identity + self-signed name cert | `src/keypair.ts`; `players[id].keyB64/keySig` (`main.ts:3057-3068`, `:3085-3095`), verified at `main.ts:7978-7991` | **the key directory** — the authoritative in-room answer to "who is here and what is their key", already cert-checked |
| `roomInfo.owner` + the deed | `src/roomOwner.ts`, `src/deeds.ts`, `currentRoomDeedIsMine()` | **the group administrator** — who may rekey and evict. #142 already narrowed the lock-out surfaces to the raw deed holder, which is the correct authority for key management too |
| `coHosts` map (pub-keyed, owner-granted, revocable) | `src/roomRoles.ts:103-124` | **the second key-holder tier.** Already keyed by Ed25519 pubkey, already revocable, already survives leave/rejoin — structurally this is a key-distribution list that currently distributes nothing |
| `doorGrants` / `doorRequests`, keyed `${doorId}\|${pub}` | `src/doorPolicy.ts:235-261` | **the request → grant → revoke workflow**, built and UI'd. A chat-key grant is the same record with a different scope; the generalization is already anticipated at `doorPolicy.ts:16-17` |
| `accessMode` public / pass / keyed | `src/main.ts:7643-7670` | **the policy switch** deciding whether a module is sealed at all. `public` → unsealed by design; `keyed` → sealed. Already deed-holder-gated (`:7666`) |
| `roomKeyB64` (32 random bytes, per room) | `src/main.ts:618-630` | **the epoch-key seed** — but it must gain an epoch counter and rotate on membership change, which it never does today |
| Signed contact cards + the friends tier | `src/contacts.ts:145-190` | **the out-of-band channel** for pair setup, and the trust anchor deciding who may be invited |
| DM pair-doc (deterministic from sorted pubkeys, authenticated) | `src/directMessages.ts:71-103` | **the pairwise channel Sender Keys distributes over.** Seal it first (it is two parties, no group machinery) and the group case inherits a working transport |
| The ysync sign/verify seam | `src/network/YjsSync.ts:302-317`, `signBytes.ts:19-31` | **where a ciphertext envelope rides.** Already domain-separated by `roomId`, so a sealed payload cannot be replayed into another module |
| `chia_lane::seal/open`, XChaCha20-Poly1305 | node-side, per `keyed-identity-contacts-plan.md:29`, `:82` | **the AEAD**, already written and tested; match it in the browser rather than picking a different cipher |

**The gap list is correspondingly short:** no X25519 key; no key-epoch record; no rekey on membership
change; no enforcement of anything, anywhere (`roomOwner.ts:26-32`).

---

## 5. Tribler and py-ipv8 *(answers Q5)*

**py-ipv8** is Tribler's networking layer: Python 3 over **UDP** with integrated NAT hole-punching,
built on libsodium, offering overlay "Communities", a custom NAT-traversing DHT for peer and value
lookup, a zero-knowledge **identity/attestation** service, and **TunnelCommunity** anonymization with
hidden services. Its stated aim is authenticated communication with privacy, including end-to-end
encryption with perfect forward secrecy, and no infrastructure dependency.

**Why not to adopt it.** The SSF client is a browser; py-ipv8 is a Python package with no browser,
JavaScript or WASM path. The SSF node is Rust on iroh, which already provides what py-ipv8's
transport layer provides — QUIC, Ed25519 node identity, relays, hole-punching, plus the existing
Mainline-DHT and mDNS discovery. Adding py-ipv8 would be a
second, redundant networking stack in a third language, for no capability SSF lacks.

**Why it is still worth reading.** Three things transfer as *ideas*:

1. **The Community/overlay abstraction** is close to SSF's per-room doc model, and py-ipv8 has
   already solved problems SSF will hit — overlay membership churn, peer scoring, and the
   bootstrapping of a new overlay from a known peer set. Directly relevant to the §7 mesh work.
2. **Attestation with zero-knowledge proofs** — proving an attribute without revealing it — is the
   right primitive for a much later question in this project: proving company share ownership or
   room entitlement without publishing the whole ledger. It is the same pitfall
   `chia-authority-architecture.md:83` already flags: *"Public per-user permission records leak the
   social graph."* Not a chat concern; file it against Companies.
3. **Tribler's onion-routed tunnels** are the genuinely instructive part, because they solve a
   problem **encryption does not**: metadata. Sealing chat hides *what* was said. It does not hide
   who is in a module, who is talking to whom, or how often — and SSF leaks all of that today by
   construction, since the node sees full room membership (the `players` map), the full traffic
   pattern, and `sendRoomCap` hands it the room key on connect. If the owner's concern behind #183
   includes "who is in this room, talking to whom", that is a **separate axis** and a much larger
   piece of work. Worth saying out loud now rather than discovering after shipping E2EE.

**Verdict:** read `TunnelCommunity` and the attestation docs for design; take no dependency.

---

## 6. Recommended shape

Four slices, ordered so each is useful alone and nothing is wasted if the next is deferred.

**S0 — Authenticate room chat (no crypto decisions, do this regardless).**
Carry `keyB64` and a signature over canonical bytes `roomId‖author‖name‖ts‖text` on chat records,
mirroring `directMessages.ts:92-103` exactly; add the missing `isChatRecord` shape guard
(`main.ts:2010`); drop unverifiable messages on read as `readMessages` already does (`:174-181`).
*Rationale: encrypting unauthenticated messages buys confidential forgeries. Today any peer can write
a chat line attributed to anyone, because `authorId` is the UUID. Fix the forgery before the privacy.*

**S1 — Publish an X25519 key.**
Mint alongside the Ed25519 seed, publish in the `players` entry and the contact card, carry it in the
same self-cert. Additive, no wire break, no behaviour change — it just makes S2 possible.

**S2 — Seal DMs (two parties, no group machinery).**
X25519 ECDH between the pair → HKDF → XChaCha20-Poly1305 over the message payload, riding the
existing DM pair-doc. This is `keyed-identity-contacts-plan.md` §8's *"seal payloads to the
recipient's key … Recommend authenticated DMs first, sealed later"* — and it also retires the
misleading `dmRoomKeyFor` name (`directMessages.ts:77-88`) by giving the function's promise a real
implementation. Smallest possible surface on which to get the AEAD, nonce discipline and key-rotation
plumbing right.

**S3 — Sender Keys for `keyed` modules.**
Each member derives a chain key + signing key, distributes it over the S2 channels to the members
listed in `players`, and the room's chat lane carries ciphertext. Epoch bumps on membership change,
driven by the deed holder, with `coHosts` as the second tier. `public` and `pass` modules stay
unsealed — the node keeps merging their chat as today, which contains the §2.2 architectural cost to
exactly the rooms that asked for it.

Deferred by name, not forgotten: MLS if modules grow large (§3.3); metadata privacy (§5.3);
node-side enforcement, which remains Slice 6 of the existing plan and is what finally makes
`roomOwner.ts:26-32` untrue.

---

## 7. Decisions for the owner

1. **History on join.** Does a new member see the last 200 messages (today's behaviour), or does
   chat start blank for them (Signal/MLS default)? *Rec: start blank for `keyed` modules.* "Anyone
   with access can read" then means access *now*, which is the only version that survives someone
   leaving.
2. **Which modules seal.** *Rec: `keyed` only.* Sealing a public town square costs the node's ability
   to merge that state and buys nothing — nobody there expected privacy.
3. **Who holds the key.** Deed holder alone, or deed holder + `coHosts`? *Rec: + co-hosts* — they
   already exist to keep a room alive while the owner is away, and a room whose key dies with its
   owner has a durability problem (`room-durability-plan.md`).
4. **Library vs. mechanics.** *Rec: mechanics, via `@noble/curves` + `@noble/ciphers`.* §3.4.
5. **Sender Keys vs. MLS.** *Rec: Sender Keys now, MLS named as end-state.* §3.3.
6. **Is metadata in scope?** *Rec: explicitly out, and say so in the UI copy.* §5.3. The project has a
   good habit of honest labels — `accessMode`'s own string already admits *"enforced once keyed
   identity ships"* (`main.ts:7648`) — and sealed chat should not claim more than it does.

---

## 8. What this would still not protect

Stated up front, in the spirit of `keyed-identity-contacts-plan.md` §4:

- **Key theft via XSS.** The identity seed is in `localStorage` (`keypair.ts:25`), a deliberate
  trade for exportable recovery (`:11-14`). Any script execution on-origin takes the seed and every
  key derived from it. This is the strongest argument for S0's shape guard and for keeping the
  `escapeHtml` discipline that `airHockeyXss.test.ts` pins.
- **A member who leaks.** Nothing stops someone in the room from screenshotting it. E2EE bounds the
  set of people who *can* read; it cannot bound what they do next.
- **Metadata.** §5.3. Membership, timing and volume stay visible to the node.
- **Forged membership.** Until node-side enforcement lands (Slice 6), a modified client still writes
  itself into `players`. Sealed chat raises the bar — a forged entry gets you a key only if an honest
  member distributes one to you — but the directory itself is still peer-written.
- **Consensus-free revocation races.** Two members rekeying concurrently, or an eviction racing a
  send, resolve eventually and not instantly. Same limit the existing plan records for `revoke`.
