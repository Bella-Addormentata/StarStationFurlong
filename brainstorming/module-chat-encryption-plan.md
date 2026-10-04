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
| 1 | Could we use Signal's mechanics to secure each module's chat? | **The mechanics yes; the library no.** Sender Keys is the right shape and SSF already has two of its three prerequisites. `libsignal` itself is AGPLv3 and ships as a native Node addon — a bad fit for a browser client whose entire *cryptographic* dependency surface is two audit-sized `@noble` packages (`@noble/ed25519`, `@noble/hashes` — the rest of the tree is `three`, Yjs, `y-*` and `msgpackr`). |
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
doc comment at `:225-230` saying *"it holds the room's plaintext doc already, so this is
loopback-only and exposes nothing new."* That comment is accurate today and is exactly the
sentence that stops being true the moment chat is sealed.

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
200 entries inside the same transaction (`src/main.ts:6925-6955`; the trim itself at `:6953-6954`). It is therefore in the CRDT, in
every peer's replica, in the node's copy, and in any cached snapshot.

**DMs** are explicitly not confidential, and the code says so twice. The module header:

> *"v1 is authenticated but NOT confidential: the derived key is possession-based room access, not
> payload encryption (the node relays plaintext, same as every room today)."* — `src/directMessages.ts:17-19`

And `dmRoomKeyFor`'s own doc comment (`:77-81`) is unusually candid: the "room key" is derived from
the two **public** keys, so *"anyone who has seen both pubkeys can recompute it … It is an addressing
tag, not a secret."* That function's name is the single most misleading thing in this area of the
codebase; anyone skim-reading it would reasonably assume DMs are encrypted. They are not.

### 1.4 The AEAD already exists — on the node, for something else

The Rust node is **in this repo**, at `prototypes/0.29.0-core-loop-demo/ssf-p2p-node/`, so this is
directly checkable rather than taken on trust: `seal` at `ssf-p2p-node/src/chia_lane.rs:115-127`
and `open` at `:129-138` are XChaCha20-Poly1305 (`:26`) under `derive_enc_key(room_key)` (`:59`),
with a `record_roundtrip_sign_seal_open_verify` test at `:183` and `chacha20poly1305 = "0.10"` pinned
at `ssf-p2p-node/Cargo.toml:29`. It is used today for sealed presence records, not chat. The plan
already reserves the work this issue is asking about:

> **Phase 3 (optional, de-risked) — Content confidentiality vs. a curious node.** *"The load-bearing
> decision is architectural (the node can no longer merge encrypted state — it becomes a ciphertext
> relay), not cryptographic."* — `keyed-identity-contacts-plan.md:81-83`

That sentence is the real cost of this feature, and §6 takes it seriously.

### 1.5 One unrelated gap worth recording while we are here

Chat is read raw **twice**, and S0 has to cover both. `rebuildChatLog` does
`const items: any[] = sharedChat.toArray()` (`src/main.ts:2010`); the bubble observer independently
casts each inserted item (`:2048-2053`), checks only `typeof msg?.text !== "string"` (`:2054`), and
passes unvalidated `atX`/`atZ` straight into `spawnChatBubble` (`:2058`). A guard added only at
`:2010` leaves the second path uncovered.

Two other reads also take an array raw — `readMessages` (`directMessages.ts:175`) and the
introductions ingest (`main.ts:8152`) — but both then filter: the first on `verifyMessage`, a
*cryptographic* guard stronger than any shape check, the second on an `isTrustedIntroducer`
predicate. Chat applies neither.

To be precise about the convention, since this is a criticism: five modules define a true
`is*Record` guard (`doorLayoutDoc.ts:331`, `doorsDoc.ts:145`, `furnitureDoc.ts:81`,
`wallpaperLayoutDoc.ts:71`, `windowLayoutDoc.ts:84`), and `doorPolicy`/`roomRoles` use
`isGrant`/`isRequest` (`doorPolicy.ts:191`, `:228`; `roomRoles.ts:67`, `:72`). But the codebase is
**inconsistent, not uniformly guarded** — `roomInfo` fields are read through bare `as` casts in a
dozen places (`main.ts:2805`, `:3321`, `:7709`, `:1301`, `:3012`, `:8682`, among others). Chat is
the weakest of these, not a lone outlier. Rendering is via `textContent`/`createTextNode`
(`:2026`, `:2028`), so this is **not** an XSS: it is a robustness and consistency gap, and it is
the natural place a `isChatRecord` guard would go when chat records gain
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
| **Anything that can read the local IndexedDB** | ✅ | `roomCache.ts` persists a full unsealed `Y.encodeStateAsUpdate(doc)` snapshot (`:1-11`), chat included — and sizes its cap explicitly against the chat cap (`:33-34`) |

And nothing enforces any of it. `src/roomOwner.ts:26-32` states the position plainly, and it is the
most important paragraph in this whole analysis:

> *"nothing authorizes a write to a room doc today, so a modified client ignores every function in
> this file and writes the Yjs record anyway … read every check here as 'should this client offer the
> action', never as 'can this peer do it'."*

`roomRoles.ts:20` says the same for its own maps — *"dev-phase UI gating on writes, shape-checked
reads"* — and `doorPolicy.ts:22-24` states the same posture in its own words: write-side UI-gated,
read-side shape-validated *"but not cryptographically verified"*.

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
3. **The node stops being a *reader*. It does not stop being a *merger*.** This distinction is a
   design choice and worth making deliberately. If each `Y.Array` item carries an AEAD-sealed
   payload, Yjs/yrs goes on merging the records exactly as today — they are simply opaque. Only
   sealing whole ysync *updates* would break CRDT merging, and that is the option this plan
   **rejects**. So the node keeps relaying, storing and merging; it loses the ability to read.
   That is what `keyed-identity-contacts-plan.md:82` is warning about, and why §6 scopes sealing to
   a *lane* — per-item, inside the doc — rather than to the doc as a whole.

---

## 3. Signal's mechanics, mapped onto SSF *(answers Q1)*

### 3.1 What "Signal mechanics" actually consists of

Four separable pieces. Three of them matter here — X3DH, the Double Ratchet and Sender Keys;
Sesame is the one that does not, for the reason given in its row:

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
| **A key directory — who is in the room, and which key is theirs** | ⚠️ **partly.** The `players` map carries `keyB64` + a self-signed name↔key cert (`src/main.ts:3057-3068`, written at `:3085-3095`). Two paths verify it: the mesh harvest (`:7978-7991`), and the roster friend-add, which routes through `addContactFromRoomEntry` and refuses on a bad cert (`main.ts:3241-3247` → `contacts.ts:240-252`). The remaining consumers check shape or equality and never the signature — `games/gamesDoc.ts:202-209`, `main.ts:4905-4908`, `:5615-5622` test only `typeof`, while `offers.ts:318-319`, `:443-444` and `roomPasses.ts:211-212` compare the stored `keyB64` against an expected value, which inherits whatever the writer put there. And the cert is a **self**-signature, so it does not bind a key to a *slot*. See §3.2.1 — this must be fixed before Sender Keys is safe |
| **A pairwise confidential channel to distribute sender keys over** | ❌ the *doc* exists — the DM pair-doc (`src/directMessages.ts`) — but it is authenticated only, and there is **no X25519 key anywhere in the codebase** |

That third row is the entire gap. An ECDH key is required and SSF has only a signing key. Two routes:

- **Mint a second X25519 key** and publish it in the same `players` entry and contact card. Clean
  separation of signing and key-agreement; one more field to carry; the recommended route.
- **Convert the Ed25519 key** via the Edwards↔Montgomery birational map (what libsodium's
  `crypto_sign_ed25519_pk_to_curve25519` does). Name the API carefully: in the current
  `@noble/curves` (v2.x) it is `ed25519.utils.toMontgomery(publicKey)` and
  `ed25519.utils.toMontgomerySecret(secretKey)`. The v1-era free functions `edwardsToMontgomeryPub`
  / `edwardsToMontgomeryPriv` — and the pub-only alias `edwardsToMontgomery` — were **removed** in
  v2; upstream records the rename in its changelog. §3.4 sets the version floor, which applies to
  both routes rather than only to this one. Note also that converting saves no dependency — X25519
  itself comes from `@noble/curves`, so either way it is added. The real objection is sharper than
  "two uses of one key": `toMontgomerySecret` returns
  `adjustScalarBytes(sha512(seed)).subarray(0, 32)`, the clamped hash head that Ed25519 signing
  then reduces mod L into its private scalar. That is the same secret one step earlier, not
  something derived alongside it. One secret would serve two protocols, and §3.2.1 makes that same
  key the identity anchor — so any weakness in either protocol lands on the identity itself.
  Avoidable for the cost of 32 bytes in a map we already write.

### 3.2.1 The directory is not yet trustworthy — fix this before anything else

The audit of this document turned up a gap sharp enough to defeat the naive Sender Keys design, so
it is stated separately rather than buried in a caveat.

`verifyNameCert` is a pure **self**-signature: `verifyIdentity(pubB64, nameCertBytes(name, pubB64),
sigB64)` (`keypair.ts:123-125`), where the key being checked is the same key named in the signed
bytes. It proves *"whoever holds this key asserts this name"*. It does **not** prove that this key
belongs in this player's slot.

So an attacker mints a fresh keypair, signs `ssf-id-cert:v1:<victim's name>:<attacker pub>`,
overwrites `players[victimId].keyB64` and `keySig`, and the check at `main.ts:7989` passes. Nothing
on screen changes. The codebase already documents this precisely, for the owner key:

> *"A peer who overwrites `players[owner].keyB64` with their own key — keeping the name, leaving
> `roomInfo.owner` alone — substitutes the owner key silently … there is no key-change detection or
> first-seen pinning for the room owner today."* — `src/games/gamesDoc.ts:152-157`

Under S3 an honest member, distributing sender keys to everyone listed in `players`, would hand one
to the attacker. **This is the case where a forged entry gets you a key even though every member is
honest** — which is why §8's forged-membership bullet is not the whole story, and why encryption
layered on today's directory would be confidence without security.

**The fix is not pinning.** An earlier draft of this document said "TOFU plus key-change detection"
and stopped there; review caught that this is insufficient, and the reason is worth stating plainly.
Trust-on-first-use detects a key that *changes* after you first saw it. It cannot authenticate the
*first* observation. An attacker who overwrites `players[victimId].keyB64` before any given peer has
observed that slot simply becomes the key that peer pins — permanently, and with a green light.
Pinning narrows the attack window; it does not close the hole.

The hole is the binding itself. `players` is keyed by `getPlayerId()`, a per-install `localStorage`
UUID (`identity.ts:11-13`: *"nothing stops a peer from claiming any id or name"*), and nothing
authenticates the UUID→key edge. **The fix is to stop having that edge: make the Ed25519 public key
the identity.** Key the directory by `pub`, and there is no binding left to forge — an attacker can
add `players[attackerPub]`, but that entry is only ever *themselves*, because the self-cert proves
possession of exactly that key. Impersonation collapses into a display-name collision, which is a UI
problem (show the fingerprint, as every messenger does) rather than a cryptographic one.

This is not a new pattern for the codebase; `players` is the outlier. `coHosts` is already keyed by
pubkey and already revocable (`roomRoles.ts:103-124`), and `doorGrants` is already keyed by
`${doorId}|${pub}` (`doorPolicy.ts:235-261`). Two of the three peer-facing authorization maps got
this right.

Pinning still earns its place — as the *detection* layer over the legacy UUID path during migration,
and over the owner key. The fingerprint helper already exists (`fingerprintOf`, `keypair.ts:92`), and
the contacts store already retains a subject's signature for exactly this kind of re-verification
(`reconstructCard`, `contacts.ts:195-197`). Together these become slice **S1a**, and nothing after it
is sound without it.

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
`msgpackr`, `three`, `yjs` and the `y-*` family (`prototypes/0.29.0-core-loop-demo/package.json` —
there is no root manifest carrying dependencies). Adding an AGPLv3 WASM blob would be the single
largest dependency and licence decision in the project's history, to obtain mechanics that are
roughly 300 lines of `@noble` calls.

**Build the mechanics, not the import.** Adding `@noble/curves` (X25519) and `@noble/ciphers`
(XChaCha20-Poly1305 — matching the AEAD the node already uses) keeps the thin-dependency,
in-browser, auditable posture `keypair.ts:11-14` chose deliberately, and keeps the browser and the
node speaking the same cipher.

**Pin both new dependencies, and say what each floor buys — one is part of the design, the other is
hygiene.** `@noble/curves` ≥ 2.3.0 and `@noble/ciphers` ≥ 2.4.0; a fresh install resolves to 2.4.0
for both today. The difference between the two floors is the point of this paragraph, and in the
second case the changelog actively misleads.

- **`@noble/curves` 2.3.0 (2026-08-06) rebuilt the X25519 ladder**, inside a wider constant-time
  pass that also brought secret-scalar blinding and a fixed-window multiply for unprecomputed
  points, closing a remote timing attack that could learn up to 4.036 bits of a long-term private
  key across many samples. Upstream scopes the impact as *primarily* fingerprinting, not key
  recovery. Attribute the mechanism carefully, because the release reads as one change and is
  three, and the three land on different calls. `getSharedSecret` is the rebuilt ladder, and that
  rewrite is what this floor mainly buys: inside `montgomery.js`, 163 lines added and 30 removed,
  178 becoming 311. `getPublicKey`/`keygen` stopped being the ladder here — 2.3.0 hands `x25519` a
  fixed-base `scalarMultBase` hook (`ed25519.js:227-237`) that multiplies on the birationally
  equivalent Edwards curve, so keygen now picks up the secret-scalar blinding of
  `ScalarMultiplier.mulCTBlinded` (`abstract/curve.js:466-469`, via `mulSecret`); `montgomery.js`
  says as much at `:225` — "the ladder is skipped". Only the fixed-window multiply for
  unprecomputed points stays off this path, the base point being precomputed. Settle this by
  reading imports and you get it backwards: `montgomery.js` imports exactly one name from
  `curve.js`, `createKeygen`, and the blinding runs anyway — reached through a callback the curve
  passes in, not an edge the import graph shows. This floor reaches **both** routes in §3.2,
  because both end at `x25519.getSharedSecret`, which is that ladder. What differs is the blast
  radius. Under the recommended route the X25519 key is
  its own, so what leaks is bits of a key that signs nothing and anchors no identity — and the
  fingerprinting framing is moot there in any case, since the public half is already in the contact
  card. Under the conversion route the scalar driving the ladder is the identity key's, so the leak
  comes out of the thing §3.2.1 makes the room's anchor.

- **The same release applied the Trail of Bits review, which corrected the Edwards→Montgomery
  conversion** — scope that precisely, because it is easy to overstate. In 2.2.0 the public-key
  helper chose the Montgomery form from `lengths.publicKey`, the *curve's* declared key size rather
  than anything about the key passed in, and that dispatch had two wrong branches rather than one:
  a 32-byte declared key size was handed the Curve25519 map and a 57-byte one the ed448 map, each
  whatever the curve should actually have used, and only a size that was neither threw
  `only defined for 25519 and 448`. 2.3.0 moved the map into each curve's own declaration and made
  the generic wrapper throw `Montgomery conversion is not supported for this curve` when a curve
  supplies none. **For ed25519 nothing changed** — `Fp.div(1 + y, 1 - y)` before and after, same
  encoding, same validation. The floor buys dispatch that cannot be wrong, not different keys.

- **`@noble/ciphers` has no equivalent fix, and its changelog cannot be read for one.** 2.3.0 does
  touch XChaCha20-Poly1305 — the cipher gained a `withAAD: true` parameter so it keeps accepting
  AAD under the new strictness rule, and `hchacha`, the X in XChaCha, was reimplemented on top of
  the shared `chachaCore` — and the notes carry a catch-all, "Other minor corrections", the fifth
  of six bullets under *Hardening*, so no exhaustive negative is derivable from them at all. Only
  measurement settles it, and it does: the AEAD with and without AAD, `chacha20poly1305`, and the
  raw `xchacha20` stream are byte-identical across 2.2.0, 2.3.0 and 2.4.0, and ciphertext written
  by 2.2.0 decrypts unchanged on 2.4.0 — measured over a fixed 257-byte plaintext (four blocks
  plus an unaligned tail) under a fixed 32-byte key, 24- and 12-byte nonces, and `roomId‖epoch`
  as AAD, with a flipped-key negative control to show the comparator can see a difference. State
  the parameters so the next reader can re-run it rather than take this on the same faith the
  changelog asks for. So nothing here is known to bite. Two smaller things still argue for the
  floor: 2.3.0 turned *silently ignoring* AAD into a throw for ciphers that lack it,
  which is a real guard if this design ever wraps or substitutes a non-AAD primitive while still
  passing `roomId‖epoch`; and 2.4.0 makes a cleaned PRG fail closed instead of continuing from a
  zeroed key, which matters if §6 draws nonces from the `rngChacha20` this package also exports.
  2.4.0's other item does **not** apply: the raw-stream entry points gained an overlap check, and
  the AEAD drives the stream with a single view as both input and output (`@noble/ciphers@2.4.0`,
  `chacha.js:350` — pinned, because the package is proposed here rather than installed, so a bare
  line number would rot), so it runs that check on every call and can never trip it. The guard
  throws only when the two views
  genuinely *overlap* inside one buffer *and* the output starts later, and `overlapBytes` reads
  "overlap" strictly: same buffer, both non-empty, ranges actually intersecting. A single view
  passed twice has equal offsets, so it fails the second test however the first comes out. Only a
  direct `xchacha20(key, nonce, data, output)` with a caller-supplied, later-starting view trips
  it.

Nothing is exposed today: neither package is a dependency —
`prototypes/0.29.0-core-loop-demo/package.json` carries `@noble/ed25519` and `@noble/hashes` and no
other crypto — and `@noble/ed25519` ships no ECDH: no `getSharedSecret`, no X25519 and no
Montgomery conversion in any 2.x inside the declared `^2.1.0` range. (Its point type does export
`multiply`, so Edwards-form ECDH is hand-rollable; nothing in SSF does it.) That is why §3.2 can
say there is "no X25519 key anywhere in the codebase". Count the real cost before committing,
though: `@noble/curves` pins `@noble/hashes` to an *exact* version — 2.4.0 for curves 2.4.0 — while
the tree asks for `^1.5.0`, so the install carries the same hash library twice at different majors
until that top-level pin is raised. `@noble/ciphers` has no dependencies at all. Both packages
also declare `engines: node >= 20.19.0`; CI clears that today, but only implicitly, since
`ci.yml:36` asks for `node-version: 20` and takes whatever 20.x that resolves to. The floors bind
the commit that adds these packages, and are worth writing down now precisely because a fresh
install already satisfies them — which is how a floor goes unwritten and is then met only by luck.
The two pins already in the tree are the cautionary case: `@noble/ed25519` sits at `^2.1.0` against
a current 3.2.0, and `@noble/hashes` at `^1.5.0` against a current 2.4.0.

---

## 4. Reusable access-control inventory *(answers Q3)*

Every row below already exists, is already keyed the right way, and already has UI. This is the
reason the work is tractable.

| Existing mechanism | Where | What it becomes in a sealed-chat design |
|---|---|---|
| Ed25519 identity + self-signed name cert | `src/keypair.ts`; `players[id].keyB64/keySig` (`main.ts:3057-3068`, `:3085-3095`), verified on the harvest path at `main.ts:7978-7991` | **the key directory** — the in-room answer to "who is here and what is their key". Reusable, but **not yet trustworthy**: needs first-seen pinning (§3.2.1) |
| `roomInfo.owner` + the deed | `src/roomOwner.ts`, `src/deeds.ts`, `currentRoomDeedIsMine()` | **the group administrator** — who may rekey and evict. #142 already narrowed the lock-out surfaces to the raw deed holder, which is the correct authority for key management too |
| `coHosts` map (pub-keyed, owner-granted, revocable) | `src/roomRoles.ts:103-124` | **the seed for the second key-holder tier.** Already keyed by Ed25519 pubkey, already revocable, already survives leave/rejoin — structurally a key-distribution list that currently distributes nothing. Not sufficient by itself: its write side is UI-gated only, so S3 consumes it as a deed-holder-**signed** `chatGrants` set rather than reading the map directly (§6 S3) |
| `doorGrants` / `doorRequests`, keyed `${doorId}\|${pub}` | `src/doorPolicy.ts:235-261` | **the request → grant → revoke workflow**, built and UI'd. A chat-key grant is the same record with a different scope; the generalization is already anticipated at `doorPolicy.ts:16-17` |
| `accessMode` public / pass / keyed | `src/main.ts:7643-7670` | **the policy switch** deciding whether a module is sealed at all. `public` → unsealed by design; `keyed` → sealed. Already deed-holder-gated (`:7667`) |
| `roomKeyB64` (32 random bytes, per room) | `generateRoomKeyB64` `src/main.ts:612-616`, stored by `getOrCreateRoomKeyB64` `:618-631` | **nothing that chat may reuse — and establishing that is the finding.** It must **not** seed chat key material: `sendRoomCap` deliberately hands `roomKeyB64` to the node (`network/NetworkProvider.ts:225-250`), so anything derived from it is derived by the node too — §1.1's own finding. Chat epochs need fresh client-only secrets distributed over the pairwise channels (S2). Nor may the raw key serve as the public epoch *label*: it travels in the bootstrap blob (`main.ts:7029-7030`, `:8509-8511`) and the node seals presence records under `derive_enc_key(room_key)` (`ssf-p2p-node/src/chia_lane.rs:59`), so printing it beside every ciphertext would hand presence decryption to every passive reader of the doc — a secret spent as an identifier. Label epochs with a **non-invertible tag** instead: `blake3("ssf-chat-epoch:v1" ‖ roomId ‖ epochCounter)`, truncated. That needs no secret at all, and the room still needs the epoch counter and the rotate-on-membership-change it lacks today |
| Signed contact cards + the friends tier | cards `src/contacts.ts:145-190`; friends tier `:43`, `listFriends` `:128`, `setFriend` `:266-270` | **the out-of-band channel** for pair setup, and the trust anchor deciding who may be invited |
| DM pair-doc (deterministic from sorted pubkeys, authenticated) | `src/directMessages.ts:71-103` | **the pairwise channel Sender Keys distributes over.** Seal it first (it is two parties, no group machinery) and the group case inherits a working transport |
| Co-present settle requests: nonce-bound signed ask → verified answer, with a TTL | `src/copresent.ts:56-57`, `:80-93`, `SETTLE_REQ_TTL_MS` `:99` | **the precedent for an "ask for the current epoch key" exchange.** Already binds `roomId‖nonce‖playerId‖pub`, already re-verifies the name cert, already expires. Its own comment states the posture the rest of this design needs: *"the owner is taken from the SIGNED request, not from any attacker-writable players lookup"* (`:77-78`) |
| The ysync sign/verify seam | `src/network/YjsSync.ts:302-317`, `signBytes.ts:19-31` | **where a ciphertext envelope rides.** Already domain-separated by `roomId`, so a sealed payload cannot be replayed into another module |
| `chia_lane::seal/open`, XChaCha20-Poly1305 | node-side, per `keyed-identity-contacts-plan.md:29`, `:82` | **the AEAD**, already written and tested; match it in the browser rather than picking a different cipher |

**The gap list is correspondingly short:** no X25519 key; no key-epoch record; no rekey on membership
change; and no enforcement on the paths that matter here — `roomOwner.ts:26-32` holds for *doc
writes*, which remain unauthorized. The exception is worth naming, because it is the model to copy:
`verifiedRequestOwner` (`copresent.ts:80-93`) **is** a real cryptographic gate, refusing to act on a
request whose signature does not bind this room and nonce. The project already knows how to do this;
it simply has not done it for chat.

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

Five slices, ordered so each is useful alone and nothing is wasted if the next is deferred.

**S0 — Authenticate room chat (no crypto decisions, do this regardless).**
Covers *both* read paths — `rebuildChatLog` (`main.ts:2010`) and the bubble observer (`:2048-2058`).

Carry `keyB64` and a signature over canonical bytes `roomId‖author‖name‖ts‖text` on chat records,
mirroring `directMessages.ts:92-103` exactly; add the missing `isChatRecord` shape guard
(`main.ts:2010`); drop unverifiable messages on read as `readMessages` already does
(`directMessages.ts:174-181` — spelled out, since the inherited path here would be `main.ts`).
**Scope this honestly.** A signature verified against the `keyB64` carried *in the same record*
proves possession of that key and integrity of that text. It does **not** authenticate the claimed
`authorId` or name — a peer can write the victim's `authorId`, supply its own key, and sign
correctly. So S0 on its own buys *message integrity*, not *attribution*. Attribution needs the
identity to be the key (§3.2.1), which is why S0 must also render the author from `keyB64` — name
plus fingerprint — rather than from the UUID, and why S0 and S1a are best landed together.

*Rationale: encrypting unauthenticated messages buys confidential forgeries, so authentication
comes first. Note precisely what "first" buys, though — S0 on its own does **not** end the
forgery, because the `authorId` it signs over is still the UUID. S0 **+ S1a** ends it. The rule
being applied here is "authenticate before you encrypt", not "S0 closes the forgery".*

**S1a — Make the public key the identity (§3.2.1). Blocking for S0's attribution and for S3.**
Key the directory by `pub` the way `coHosts` and `doorGrants` already are, so the unauthenticated
UUID→key edge stops existing; carry TOFU pinning + a visible fingerprint-changed warning as the
detection layer over the legacy path and the owner key. Without this the directory Sender Keys reads
from is attacker-writable and the whole design is decoration. Independently valuable: it also closes
the silent owner-key substitution that `games/gamesDoc.ts:148-157` records as open today.

**S1 — Publish an X25519 key.**
Mint alongside the Ed25519 seed, publish in the directory entry and the contact card, carry it in the
same self-cert. Additive, no wire break, no behaviour change — it just makes S2 possible. This entry
is also where S3's signed prekey and one-time prekeys will sit, so give it room for them now rather
than reshaping the record twice.

**S2 — Seal DMs (two parties, no group machinery).**
X25519 ECDH between the pair → HKDF → XChaCha20-Poly1305 over the message payload, riding the
existing DM pair-doc. This is `keyed-identity-contacts-plan.md` §8's *"seal payloads to the
recipient's key … Recommend authenticated DMs first, sealed later"* — and it also retires the
misleading `dmRoomKeyFor` name (`directMessages.ts:77-88`) by giving the function's promise a real
implementation. Smallest possible surface on which to get the AEAD, nonce discipline and key-rotation
plumbing right.

*What S2 does not provide, stated so it is not assumed:* ECDH between two **long-lived** keys is
static-static. It has no forward secrecy and no post-compromise security — compromise of either
private key recomputes every past HKDF output and decrypts any retained ciphertext. That is a
tolerable, explicitly-scoped trade for DMs with a defined rotation policy (§7). It is **not**
tolerable as S3's key-distribution channel, because a recorded sender-key distribution would then
unseal the group's history on a single key compromise.

The proportionate fix does not need the full Double Ratchet, but it does need the **recipient** to
contribute freshness — and this is where an earlier draft of this document was wrong, in a way
worth leaving visible. It proposed wrapping each distribution ECIES-style: a fresh ephemeral X25519
keypair per distribution, ECDH'd against the recipient's static key. That defends against
compromise of the **sender's** key and nothing else. The threat named one sentence earlier is a
single key compromise unsealing recorded distributions, and the recipient's static key is exactly
such a key — so ephemeral-static leaves open the hole it was written to close.

What closes it is the recipient publishing **prekeys**, which is the cheap half of X3DH and needs
no ratchet: a signed prekey (medium-lived, rotated, signed under the Ed25519 identity key) plus a
set of one-time prekeys, carried in the same directory entry as the X25519 key S1 adds. A sender
claims one one-time prekey, ECDHs ephemeral×one-time and ephemeral×signed-prekey, and HKDFs the
pair; the recipient **deletes the one-time private on use**. After that deletion no key still in
existence decrypts that distribution — which is the property S3 actually needs. When one-time
prekeys run out the fallback is signed-prekey-only, which degrades to the rotation interval rather
than to "forever"; that interval is an owner-facing number and belongs in §7. Note that in a
peer-writable doc the set can be *drained* as well as honestly exhausted — anyone can claim every
one-time prekey and force the whole room onto the fallback — so the published set has to be
replenished on a schedule rather than minted once (§7), which makes draining a treadmill instead
of a one-shot. It is a downgrade attack, not a break: the floor it downgrades to is the floor S2
already accepts for DMs. Full X3DH + Double
Ratchet (§3.1) remains the end state for DMs; it is deferred, not dismissed.

**S3 — Sender Keys for `keyed` modules.**
Each member derives a chain key + signing key, distributes it over the S2 channels — **not** to
everyone listed in `players` — and the room's chat lane carries ciphertext.

> **`players` is not a roster.** It is a *seen* list. The codebase says so itself: *"'SEEN', not 'IN
> ROOM': nothing ever REMOVES a players entry in S2 (no leave hook, no liveness), so departed players
> stay listed until S3 presence lands heartbeat/lastSeen semantics."* (`main.ts:3178-3180`) — entries
> are upsert-only and preserve `joinedAt` (`:3074`, `:3087`). Distributing to `players` would hand
> sender keys to every historical visitor *and* to any forged entry, which is precisely the failure
> §3.2.1 describes.

Distribute instead to an authorized current set that is **signed, not merely written**. That
distinction is the whole of it, and `coHosts` on its own does not meet it. It is pub-keyed and
genuinely revocable — `removeCoHost` really deletes (`roomRoles.ts:103-124`), the structural
property `players` lacks — but its write side is only UI-gated (`roomRoles.ts:20`), so a modified
client adds itself and an honest member dutifully hands it a sender key. A better roster that is
still unauthenticated fails the same way `players` does, just less often.

Define a **`chatGrants`** set in the shape `doorGrants` already uses — keyed `${roomId}|${pub}`,
each record **signed by the deed holder** over canonical bytes binding `roomId‖pub‖epoch‖notBefore`,
with matching signed revocations. The doc staying peer-writable then stops mattering for this
purpose: a reader verifies every grant against the deed holder's key and drops what does not
verify, which is precisely what `verifiedRequestOwner` already does for settle requests — *"the
owner is taken from the SIGNED request, not from any attacker-writable players lookup"*
(`copresent.ts:77-78`). That is a real cryptographic gate, client-side, available **today** with no
node change. It is why S3 is blocked on signing the grant set rather than on Slice 6. `coHosts`
seeds the initial set and stays the UI for editing it; what changes is that the deed holder signs
the result and readers check the signature.

Node-side enforcement (Slice 6) is still worth having — it stops forged records being *written*
rather than merely ignored on read, and it is what makes `roomOwner.ts:26-32` untrue. The
append-only signed log that should eventually carry these grants is named in-tree as
`network/RoomLog.ts`, but that file is a Phase-2 **stub** whose `append` and `subscribe` both throw
(`:13-20`). So it is the destination, not a dependency: the signature discipline above is what
makes the roster sound in the meantime.

Epoch bumps on every change to that authorized set, driven by the deed holder, which is what finally
makes eviction mean something (§2.2's first consequence). `public` and `pass` modules stay unsealed —
the node keeps merging their chat as today, which contains the §2.2 architectural cost to exactly the
rooms that asked for it.

Deferred by name, not forgotten: MLS if modules grow large (§3.3); metadata privacy (§5, point 3);
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
3. **Who holds the key.** Deed holder alone, or deed holder + co-hosts? *Rec: + co-hosts* — they
   already exist to keep a room alive while the owner is away, and a room whose key dies with its
   owner has a durability problem (`room-durability-plan.md`). Either way the holder set is
   distributed as a deed-holder-signed `chatGrants` set, not read from the `coHosts` map directly
   (§6 S3); the question here is who goes *in* it.
4. **Library vs. mechanics.** *Rec: mechanics, via `@noble/curves` + `@noble/ciphers`.* §3.4.
5. **Sender Keys vs. MLS.** *Rec: Sender Keys now, MLS named as end-state.* §3.3.
6. **How often do keys rotate, and who notices?** S2's static-static DM channel has no forward
   secrecy, so its exposure window *is* the rotation interval (§6 S2), and S3's signed prekey sets
   the same bound whenever a sender exhausts a recipient's one-time prekeys. *Rec: rotate the signed
   prekey monthly and replenish one-time prekeys on every connect, with rotation silent in the UI* —
   a prompt here trains people to click through the one dialog that should mean something. The
   fingerprint-changed warning of S1a stays loud, because that one is not routine.
7. **Is metadata in scope?** *Rec: explicitly out, and say so in the UI copy.* §5, point 3. The
   project has a good habit of honest labels — `accessMode`'s own string already admits
   *"enforced once keyed identity ships"* (`main.ts:7648`) — and sealed chat should not claim
   more than it does.

---

## 8. What this would still not protect

Stated up front, in the spirit of `keyed-identity-contacts-plan.md` §4:

- **Key theft via XSS.** The identity seed is in `localStorage` (`keypair.ts:25`), a deliberate
  trade for exportable recovery (`:11-14`). Any script execution on-origin takes the seed and every
  key derived from it. This is the strongest argument for S0's shape guard and for keeping the
  `escapeHtml` discipline that `airHockeyXss.test.ts` pins.
- **A member who leaks.** Nothing stops someone in the room from screenshotting it. E2EE bounds the
  set of people who *can* read; it cannot bound what they do next.
- **Metadata.** §5, point 3. Membership, timing and volume stay visible to the node.
- **Key substitution in the directory** (see §3.2.1 — the sharpest gap, and it defeats the naive
  design outright rather than merely weakening it).
- **Forged membership — on the write side.** Until node-side enforcement lands (Slice 6), a modified
  client still writes itself into `players`, and into `coHosts` too (`roomRoles.ts:20`). What S1a and
  the signed `chatGrants` set of §6 S3 change is the *read* side: a forged entry no longer earns a
  sender key, because a reader checks the deed holder's signature before distributing to it. That
  closes the attack §3.2.1 describes — the one where a forged entry needs no honest member to be
  fooled — without waiting for the node. It does not stop the junk being written, so the directory
  still fills with entries nobody authorized, and anything that reads it *without* checking a
  signature (the unverified consumers listed in §3.2) is still wrong today.
- **Stale membership.** Nothing removes a `players` entry on leave (`main.ts:3178-3180`), so without
  the S3 roster change above, "everyone in the room" silently means "everyone who has ever been in
  the room".
- **Consensus-free revocation races.** Two members rekeying concurrently, or an eviction racing a
  send, resolve eventually and not instantly. Same limit the existing plan records for `revoke`.
