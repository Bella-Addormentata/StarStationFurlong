# Design Breakdown — SpacePhone Apps (#20) + QR Mobile Chat (#12)

> **Scope:** phased sub-issue breakdown for Issue #20 ("phone apps": Contacts / Bank / Chat home screen) and Issue #12 ("mobile phone chat": QR → real-phone room chat + door-list room transfer). Grounded in the live prototype `prototypes/0.22.0-core-loop-demo` as of 2026‑07‑13. Deep context: [Phase 1 plan](../docs/TDD/03-Implementation/Phase1-ExecutionPlan.md), [Phase 2 plan](../docs/TDD/03-Implementation/Phase2-ExecutionPlan.md), [TrustAndSafety.md](../docs/TDD/02-Systems/TrustAndSafety.md), TODO.md items on RoomLog/B‑7/#12.

## 1. Where we actually are ([FACT], verified at source)

- The SpacePhone is a **single-app phone**: bezel/notch/status-bar DOM + a hardcoded `CLONE CHAT` header ([index.html:169-209](../prototypes/0.22.0-core-loop-demo/index.html)), toggled by Tab ([main.ts:447-467](../prototypes/0.22.0-core-loop-demo/src/main.ts)).
- Chat syncs via a Yjs `chat` array (main.ts:321-346). **Author identity is hardcoded** — every sender writes `authorName: 'Local-Clone'` (main.ts:515) and the `isMe` check compares against that same string (main.ts:330), so with 2+ players every message renders as "me". There is **no stable player identity in the doc**; the 8-byte addressed-tick sender id (main.ts:348-376, issue #22) exists only on the movement lane.
- `EnvelopeKind` declares `'awareness'` — "DISCRETE presence only: join/leave, name, typing, speaking" — but nothing implements it ([protocol.ts:18-20](../prototypes/0.22.0-core-loop-demo/src/network/protocol.ts)). `RoomLog` is a port stub (protocol.ts:123-135; Phase 2 plan gates the real substrate on spike #3 + the T&S note).
- No Contacts, no block list, no wallet. Economy/ATMs are ROADMAP Phase 3; crypto tie-ins explicitly land "only after the core economy feels good without it" (ROADMAP.md:160). chia-wallet-sdk browser audit is spike **B‑7** (TODO.md:14) — not run.
- Invite links already exist: `mintBootstrapLink()` (main.ts:596-640) mints a `?seed=` URL carrying `{roomId, roomKeyB64, wtUrl, certHashesB64, memberHints…}` (main.ts:571-594). Docking doors already carry `connectedRoomAddress: string // Target room URL seed` ([docking.ts:14-21](../prototypes/0.22.0-core-loop-demo/src/docking.ts)) — exactly the data #12's "click a door name to transfer" needs.
- TODO.md:29 already records the #12 posture: *"capability skeleton early (challenge-bound QR, zxing-wasm decode), full UI later."*

## 2. Sub-issue breakdown

Dependency graph: `S1` and `S2` are independent roots. `S2 → S3 → S4`; `S2 → S5`; `S2 → S6`; `S7 → S8`. S1 gates all phone UI work (everything renders inside the shell).

```
S1 phone shell ──────────────┬─→ S4 Contacts ←─ S3 presence ←─ S2 identity
                             ├─→ S5 Chat DMs ←─ S2
                             ├─→ S6 Bank     ←─ S2
                             └─→ S8 phone-side join ←─ S7 QR render
```

### S1 · Phone home screen shell (app grid + view router) — **first slice, see §4**
- **Rationale:** every other sub-issue needs somewhere to live. Zero network changes, pure DOM/CSS/TS — the safest possible first PR.
- **Surface:** `index.html` (#phone-screen gains `#phone-home-screen` app grid + one container per app view; existing chat DOM becomes the Chat app view), `main.ts` `setupSpacePhoneOverlay()` (main.ts:401-527) gains a ~40-line view router (home ↔ app, back button in `#phone-app-header`), CSS.
- **Acceptance:** Tab opens phone to home screen; tiles for Chat / Contacts / Bank; Chat fully works as before; Contacts/Bank tiles open "no signal" placeholder views; back returns home; no `yjsSync` or node changes in the diff.
- **Defers:** everything functional behind the tiles.

### S2 · Player identity + display names in the room doc
- **Rationale:** hard prerequisite for Contacts, DMs, Bank, and fixing the `isMe` bug. Reuse the identity the network already has: the node's 8-byte lane id (issue #22 lane) or the browser's persisted per-install key — decide in-PR, but it must be **stable across reloads** and written into the doc.
- **Surface:** new Yjs `players` map (`playerId → {name, joinedAt}`), a name prompt/localStorage default ("Clone-XXXX"), chat writes `authorId` + `authorName` (main.ts:513-519), observer compares `authorId === myId` not the string literal (main.ts:330).
- **Acceptance:** two browsers show distinct names; my bubbles right-aligned, theirs left; name survives reload; old `Local-Clone` messages still render (legacy fallback).
- **Defers:** signed identity / key custody (v006 §10.3 recovery UX), avatars, name uniqueness.

### S3 · Presence: online status via the players map
- **Rationale:** "online green dot" needs liveness. Cheapest honest signal: heartbeat `lastSeen` timestamp in the `players` map (Yjs-synced), with the `'awareness'` envelope kind (protocol.ts:20) as the eventual proper home — spike B‑5 already ruled Awareness is for discrete presence only.
- **Surface:** `main.ts` heartbeat interval (~10s) + stale threshold (~30s); helper `isOnline(playerId)`. Optionally reuse `remoteLastSeen` from the tick lane (main.ts:371) as a second signal.
- **Acceptance:** peer joins → dot green within 15s; peer closes tab → gray within 45s; no envelope-schema changes required.
- **Defers:** real awareness protocol wiring, typing/speaking indicators.

### S4 · Contacts app v1 (roster + block = local mute)
- **Rationale:** #20's contacts list. "Everyone you've shared a room with" is a **local** fact — persist it client-side, don't invent a global directory.
- **Surface:** localStorage/IndexedDB roster (`playerId → {name, firstMet, roomId}`) appended whenever a new id appears in the `players` map; Contacts view in the shell (name, green/gray dot from S3, red ✗); block button → confirm dialog → id added to a local `blockedIds` set; chat observer (main.ts:322-346) skips bubbles whose `authorId` is blocked.
- **Acceptance:** meeting a player adds them once; dot tracks S3 state; blocking hides their past and future messages after confirmation; unblock exists; roster survives reload.
- **Defers:** protocol-level enforcement (§3.2), roster sync across the player's own devices, avatars/profiles.

### S5 · Chat app: room chat + DM/group conversations
- **Rationale:** #20's "messages between users, or group chats." Room chat already works; add a conversation layer, not a new transport.
- **Surface:** Yjs map `conversations` (`convId → {members: [playerId], title}`) + one Yjs array per conversation (`chat:${convId}`); Chat app gains a conversation list (Room = the existing `chat` array, pinned first); compose flow picks members from Contacts (S4). Mute filter from S4 applies everywhere.
- **Acceptance:** two players DM without a third seeing it in *UI* terms; group of 3 works; unread badge on the Chat tile.
- **Defers:** **honesty note in the issue** — Yjs doc contents replicate to all room members, so v1 DMs are private-by-UI, not private-by-crypto. E2E sealing and durable history are RoomLog work (Phase 2 plan:19, `ChatProvider` swap) — do not promise privacy in-game copy.

### S6 · Bank app v1 (demo ledger in the room doc)
- **Rationale:** #20's balances/send/receive, without touching the chain (B‑7 unrun, ROADMAP.md:160 explicitly sequences crypto after the fun test). See §3.1.
- **Surface:** Yjs map `ledger` (`playerId → balance`), join grant (e.g. 100 credits once per playerId), send flow inside a `doc.transact` (pattern at main.ts:513); Bank view: balance, send-to-contact picker, simple tx history array.
- **Acceptance:** both players see both balances converge; send moves credits atomically in one transaction; insufficient funds rejected client-side; "DEMO LEDGER — resets with the room" label visible.
- **Defers:** double-spend hardening (host-sequenced transfers, same posture as Sprint 4's host-sequenced capsule claiming), RoomLog signed ops, Chia custody (Phase 2 horizon, TODO.md:53).

### S7 · QR invite render in-game (#12 capability skeleton)
- **Rationale:** the seed link already encodes everything a phone needs (main.ts:596-640). v1 = draw it as a QR. This is the "capability skeleton early" TODO.md:29 asks for.
- **Surface:** small QR encoder dep (or the zxing-wasm already-decided lane for decode later); "Show QR" button in the network panel + phone shell; renders the `mintBootstrapLink()` output. Avatar phone-holding pose is a nice-to-have rig task — separate ticket, not blocking.
- **Acceptance:** QR renders for the current room; scanning it on a phone opens the link; QR regenerates when the seed changes (cert rotation).
- **Defers:** challenge-bound QR (short-lived nonce so a screenshotted QR expires — the hardening TODO.md:29 names), avatar pose.

### S8 · Phone-side mobile chat page + door-list room transfer
- **Rationale:** the rest of #12. Depends on the §3.3 hosting decision.
- **Surface:** mobile-first chat-only route in the existing web client (reads `?seed=`, dials WT, mounts only the chat view); room-transfer list sourced from the four doors' `connectedRoomAddress` seeds (docking.ts:18) — tap a room name → swap bootstrap → rejoin.
- **Acceptance:** phone on the **same LAN** as a player-run node can read/send room chat; door list shows paired rooms by name; transfer reconnects to the neighbor room.
- **Defers:** cellular/NAT-traversal joins (blocked on the relay lane — TODO.md:12 names SSF_RELAYS/beacon as "the TOP unbuilt rung"), voice, full game rendering on mobile.

## 3. Architecture decisions (the risky bits)

### 3.1 Bank balances before chain integration → **demo ledger in the room doc**
Options: (a) Yjs `ledger` map in the room doc, (b) RoomLog signed ops, (c) chia-wallet-sdk now. **(c)** is gated on B‑7 and inverts ROADMAP.md:160's sequencing. **(b)** is gated on the Phase 2 RoomLog spike-#3/T&S gates — jumping a gate is how the v0.11.x bridge shipped before the B‑6 drill; don't repeat it. **(a)** ships this month, exercises the UI/UX we actually need to playtest, and its known flaw (concurrent CRDT sends can race a balance negative) is acceptable for demo credits and fixable later by host-sequencing transfers exactly as capsule claiming already plans (TODO.md:27). Migration path: `ledger` map → RoomLog `transfer` ops (signed, append-only) → Chia offers per v006 §5.3. Label it a demo ledger in the UI so nobody banks real value on it.

### 3.2 Blocking in a P2P world → **local mute first, signed op later**
There is no server to enforce a block. v1 blocking is a **client-side mute**: a local id set that filters render (S4). That is honest and immediately useful — the blocked player's bytes still arrive, they just don't render. Protocol-level enforcement already has a designed home: the T&S note's signed `mod-flag` operation on the RoomLog plus co-host payload refusal and node denylists (TrustAndSafety.md:18) — a personal `block` op is the same machinery. Do not build a bespoke enforcement path before RoomLog lands; it would be thrown away.

### 3.3 #12 QR → real phone: **QR encodes the existing `?seed=` invite, opened by an HTTPS-hosted client**
The concerns raised in the issue, answered honestly:
- **"Would Chrome block non-SSL sites?"** A plain-HTTP page on a LAN IP *loads* (with "Not secure" chrome, and HTTPS-First interstitials on some configs), but it doesn't matter: **WebTransport requires a secure context**, so a `http://192.168.x.x` page can never dial the node. Serving the site from super-user seeders over raw IP therefore fails at the API layer, not just the padlock. This is precisely the Station-in-a-Box secure-context problem — four candidate lanes (native-first / baked DNS‑01 cert / local CA / IWA) already queued as spike #9 with real phones (TODO.md:19).
- **Recommended v1:** host the *existing web client* (or a chat-only route of it) on ordinary HTTPS static hosting; the QR is that URL + `?seed=`. The secure context comes from the hosting origin; the connection to the player's node needs no CA cert because `serverCertificateHashes` pins the node's rotating cert — the hash is *in the seed* (main.ts:587). Known residual risk: Chromium Local-Network-Access prompts on public-origin → private-address dials (spike #2 mapped LNA; BrowserSupportMatrix P‑11 says re-verify before the sprint). Scope v1 to same-LAN and let spike #9 pick the long-term lane.
- **"QR should include a key so only in-game players can connect."** Already true: the seed carries `roomKeyB64` (main.ts:573) — the QR *is* the capability. Hardening = the challenge-bound QR from TODO.md:29 (bind a short-lived nonce so leaked screenshots expire), deferred to the skeleton's follow-up.
- **Cert rotation:** node certs rotate ≤14 days, so QRs are session-scoped by nature — regenerate on display (S7 acceptance), never print them on posters.

## 4. Suggested first slice PR — "SpacePhone home screen shell" (S1)
One PR, no new network features, reviewable in an afternoon:
1. `index.html`: wrap existing chat DOM in `<div id="phone-app-chat" class="phone-app-view">`; add `#phone-home-screen` with three tiles (Chat, Contacts, Bank) and a back chevron in `#phone-app-header` (index.html:193).
2. `main.ts`: `showPhoneView(id)` router inside `setupSpacePhoneOverlay()`; Tab opens to home (or last view); Esc/back → home. Chat input focus moves into the Chat view-open path (currently main.ts:434/460).
3. CSS: app-grid icons in the existing bezel aesthetic; Contacts/Bank open a themed "NO SIGNAL — app not yet provisioned" placeholder.
4. Acceptance: everything in S1 above, plus a 2-player smoke test proving chat behavior is byte-identical to before.

This lands visible progress on #20 immediately, creates the surface S2–S8 mount into, and touches zero gated systems.
