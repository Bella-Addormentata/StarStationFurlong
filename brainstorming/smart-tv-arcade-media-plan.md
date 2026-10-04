# Smart TV, Arcade Cabinet and the Media Lane — options and recommendations

Issues: [#186 smart TV](https://github.com/Bella-Addormentata/StarStationFurlong/issues/186) ·
[#193 arcade cabinet](https://github.com/Bella-Addormentata/StarStationFurlong/issues/193) ·
[#194 CRT vibe](https://github.com/Bella-Addormentata/StarStationFurlong/issues/194) ·
[#189 voice toggle](https://github.com/Bella-Addormentata/StarStationFurlong/issues/189) ·
[#190 voice calls](https://github.com/Bella-Addormentata/StarStationFurlong/issues/190)

Status: design of record for the TV, the cabinet and everything that moves media
between players, consolidated from the research notes on #186 and #193
(2026‑10‑03). Grounded in `prototypes/0.29.0-core-loop-demo` as of v0.38.0 and
in the sovereignty rules of [STUDY-Architecture v002 §3](AI%20BRAINSTORMING/STUDY-Architecture%20v002.md),
the [Cabal DNS-free plan §3–§4](REVIEWS/REVIEW-20260707-Cabal-DNS-Free-Discovery-Plan.md)
and [v007](AI%20BRAINSTORMING/STUDY-Architecture%20v007.md). Every option that
was weighed is listed in §10, including the rejected ones, so the next reader
does not re-open them by accident.

---

## 1. The yardstick

Every choice below was scored against the project's own rules, not a generic
idea of decentralisation:

- **The Sovereignty Test** (v002 §3): *"If every third party we don't control
  vanished overnight — GitHub, Cloudflare, public STUN, public Nostr relays,
  public torrent trackers, every commercial cloud — would StarStationFurlong
  still boot, find peers, and play?"* A critical-path component must be a
  player-run node, our own code, or the Chia consensus; anything else is
  rejected or demoted to an optional fallback. v002's table already rules
  *Public WebTorrent tracker → Rejected → Chia infohash registry + our seeders*.
- **The DNS-free rules** (Cabal plan §3.1): no external DNS for a join, no
  public relay by default, no public bootstrap defaults unless explicitly
  enabled as dev mode, discovery inputs only from signed local config or
  signed tickets.
- **The lane classes** (Cabal plan §4.5): *pure P2P*, *community-owned*, and
  *decentralised third party — optional, off in strict sovereign builds, never
  a dependency*. The Mainline DHT is already in that last class for address
  lookup; a public torrent swarm is the same shape.
- **P‑3**: never default public relays. **v007 F2/F5**: status must reach the
  player, and every feature says which rung it is using.
- **The ChiaHub floor** (rung 6): the chain as the discovery that keeps working
  when every DHT bootstrap and DNS server refuses us.

Applied to a TV the test reads: *with YouTube, archive.org, every tracker and
every DHT bootstrap node gone, can a room still watch something together, and
can a station keep what it has?* At least one source has to answer yes, and
the sources that fail have to say so on the screen.

## 2. What the stack already gives us (checked in source)

| Need | What exists | Where |
|---|---|---|
| Shared switch state | Whole-value LWW records per item, shape-checked reads, per-key subscribe, owner-predicate seam | `partyDoc.ts` (`speaker:<itemId>`, `setPartyHostPredicate`) |
| Single-writer clocks | The operator stamps absolute deadlines; others render `deadline − localNow`; heartbeat 3 s, stale at 9 s | `croupier.ts` |
| A renewable lease, liveness judged by the renewals a page saw | Operator lease: renew every 3 s, lapse after 8 s. Its CLAIM policy is the pusher's own — owner-only, and a 60 s split window before another device takes over — and is NOT what the TV reuses: the remote's claim policy is distinct (§3.2): anyone takes a free or lapsed remote, at once, no owner gate | `pusherCroupier.ts` |
| Per-frame unreliable lane | 13-byte datagrams, relayed content-blind to every room member; 2-bit lane kind, one kind (3) still free | `network/protocol.ts`; `ssf-p2p-node/src/main.rs` accepts only `datagram.len() == 13` from the browser |
| Reliable lane | JSON envelopes with base64 payloads (`ysync`); `'asset'` kind declared, unimplemented; no `iroh-blobs` in the node | `network/YjsSync.ts`, `protocol.ts` |
| Fan-out | The hub relays ticks and control frames to the room (M5), with heartbeat pruning and a signed control plane (`graft`/`prune`/`px`/`ihave`/`iwant`) | `main.rs` |
| Screens | Live `CanvasTexture` planes (wall computer at ~1 Hz, the air-hockey scoreboard). No iframe, CSS3D, `VideoTexture`, WebCodecs, WebRTC or `getUserMedia` anywhere | `furniture.ts`, `devices.ts` |
| Mounting and focus | `FurnitureDef.wallMount`, the `device` focus template, seats with the seated pose bit | `furniture.ts`, `deviceFocus.ts` |
| The phone | `phoneViewMeta` registry + `showPhoneView` router; a new app is one entry and one view element | `main.ts` |
| Transit measurement | `ping`/`pong` datagrams, `stats().rttMs` | `NetworkProvider.ts` |
| Tauri | `csp: null`; the UI is served from `tauri://localhost` on macOS/Linux and `http://tauri.localhost` on Windows | `src-tauri/tauri.conf.json` |

## 3. The Smart TV

### 3.1 The record and the sync rule

```ts
// room doc, map 'tv', key tv:<itemId> — whole-value transacted writes, shape-checked reads
{
  source: { kind: 'youtube', videoId }            // IFrame API: full sync
        | { kind: 'archive', identifier, file }   // their embed (start-time sync) or mp4 (full sync)
        | { kind: 'url', url }                    // any mp4 / webm a <video> can play
        | { kind: 'blob', hash, bytes, name, provider }  // the host's own file: the hash with the importing node's iroh id AND its
                         // dial hints — relay URLs and direct addresses, the RoomMemberHint shape of
                         // network/protocol.ts — which is what a BlobTicket's provider is: an id alone
                         // is nothing to dial once the importer's link is gone (blob lane, §4)
        | null,
  state: 'home' | 'scheduled' | 'playing' | 'paused',  // the PROGRAMME only: 'home' is on with nothing on. Power is
                         // not here — it is its own key (below), so the set has one source of truth
                         // for being off; a reader derives the 'off' it shows from `power.on`,
                         // and a programme value of 'off' (legacy or garbage) is read as 'home'
  startAt: number,       // UTC ms — the countdown only
  positionMs: number,    // where the holder's player was…
  seq: number,           // …stamped with a per-write counter: a NEW seq is a new sample, which a
                         // reader anchors to its OWN receipt time; never a wall clock
  started: number,       // the seq of the write that started the programme: a replay is a new start
  jump: number,          // bumped by every transport write, never by a heartbeat; the holder follows it once
  history: Array<{ source, title, playedAt }>,    // cap 20
  // later, not v1 — ui: { screen, cursor, text }: the start screen everyone watches the holder
  // navigate on the prop. v1 (#207) picks sources on the phone's remote app or the panel at
  // the set, and the prop's texture shows what is on (the status, the countdown, the holder).
}
// key remote:<itemId> — its own record so a lease renewal never collides with a playback write
{ holder: pub | '', name, leaseAt, by, page }
// page: the holder's PAGE-LOAD id, never the key — two tabs of one browser share the key (the
// seed lives in localStorage) and must not both renew, beat the clock and release on leave; a
// hand-over writes page '' and the first of the receiver's pages to tick claims it
// key volume:<itemId> — the set's volume (a body button anyone may press), its own key so a
// viewer turning the sound down never carries a stale programme over the holder's seek:
// whole-value LWW keeps one writer per key, so each thing that changes on its own has one
{ volume: 0..100 }
// key power:<itemId> — the switch, a body button anyone may press; its own key for the same
// reason (a press must never race the holder's heartbeat in the programme's slot). Off keeps
// the programme; on brings it back, the holder's tick parking a programme that was playing
// where it was; `seq` voids a lookup in flight
{ on: boolean, seq }
```

**Sync rule.** While playing, the holder's client writes `{positionMs, seq}`
every 3 s. Every other client records `receivedAt = performance.now()` when
a new `seq` lands and computes `expected = positionMs + (now − receivedAt) +
lead` with the same monotonic `now`. The monotonic clock, never the wall
clock: `Date.now()` steps on an NTP correction, on a wake from sleep or on
a manual change, and a step would read as elapsed playback and seek every
viewer at once; the wall clock serves the UTC schedule (`startAt`) and
nothing in the sync maths.
`lead` is half the round trip the viewer's `NetworkProvider` measures to the
node it is connected to, capped at 1 s, and zero for the holder (its own
writes land locally). That term is an approximation of the one-way transit,
not a measurement of it — the measured round trip is to the viewer's own
node, which on a desktop build is loopback — so the honest bound is "one
delivery lag, corrected within a heartbeat", never clock skew: no device
compares its clock with another's (the `croupier.ts` rule, and the
air-hockey staleness clocks). An end-to-end probe correlated with the current
holder could replace the term later. Drift correction: `<video>` elements
nudge `playbackRate` ±3 % under 1 s of drift and seek beyond 1.5 s; the
YouTube player only seeks (its rate steps are coarse), with a 1.5 s dead band
so we never fight its own buffering. Pause is a record write. A late joiner
reads once, computes, seeks.

**Scheduled start.** `state: 'scheduled'` renders the countdown from
`startAt − localNow` (display only). At T0 only the HOLDER's clock decides.
The shared record is still `scheduled`: the holder's own read treats the due
schedule as running (locally, and nowhere else), and its first heartbeat
performs the shared transition to `playing`; every viewer starts on receipt
of that write and anchors to it, so clock skew never starts a film early or
late. A viewer whose countdown has
reached 0 shows STARTING… until the write lands (within a heartbeat). Only
when nobody holds the remote does a viewer free-run from `startAt`, best
effort, until someone picks the remote up and beats. For `blob` and torrent
sources the countdown doubles as the prefetch window.

### 3.2 The remote: possession, not a role

| Real life | In the room |
|---|---|
| The remote sits by the TV | `remote:<tvId> → { holder: '' }` (the schema above; never `null`) |
| You pick it up | Walk to the TV and press PICK UP REMOTE, or click the remote in the holder's hand |
| You hand it to someone | HAND TO… lists the room's players (v1: everyone the players map has seen — there is no liveness until S3 presence, so a remote handed to someone who has left lapses back to the set in 8 s; arm's reach comes with the rig work); the receiver's phone opens on the remote; no accept step |
| You put it down | PUT DOWN → back at the TV. Leaving the room puts it down too |
| You fall asleep holding it | The holder renews every 3 s; after 8 s of silence anyone may take it |
| You open a second tab | The remote stays with the tab that picked it up (`page`); the other is a viewer that may take it over — one person, one place — and closing it drops nothing |
| The TV has buttons on its body | Anyone standing at the TV can press POWER, VOLUME and INPUT without the remote |
| The owner has the spare | The room owner may take the remote from anyone, always |

The holder gate is client-side and best effort — the dev-phase posture of
`doorPolicy.ts`, not an authority boundary. The `tv` map is peer-writable:
a modified client can write any shape-valid `tv:<id>` or `remote:<id>` (a
different programme, position, history or lease). Every read is
shape-checked, and nothing is FETCHED on a peer's say-so: a shape-valid
http(s) source would otherwise make every open theatre's browser request it
(a `<video>` preloads the moment it is mounted), so the theatre mounts a
source only when its origin is one of the product's own lanes
(`youtube-nocookie.com`, `archive.org`), the page's own origin or its node's,
or one this viewer accepted in this session by pressing PLAY FROM <host>; a
loopback, link-local or private-network host that is not the viewer's own
node is refused outright, no button offered (`tvConsent.ts` in #207). That is
consent, not validation: a host the viewer accepted can redirect the request,
or resolve, into the viewer's own network, and a browser `<video>` can see
neither — the ask says so, and the node's media proxy (§3.4, TODO) is where
destinations are checked after DNS and on every redirect; until it lands, a
direct URL is the viewer's own trust decision, per origin, per session. So the
worst a modified client can do is change what is on — never make a browser
fetch what its owner did not agree to. When an authority boundary is needed
it is the signed-op acceptance rule of the RoomLog (Phase 2), not more checks
in the client. The holder shows as a 📺 badge on the name tag first; the
remote prop in the hand is rig work shared with #190.

### 3.3 The start screen and the sources

The TV boots to its own home screen, drawn on the screen texture. In v1 (#207)
that texture shows what is on — the status, the countdown, who holds the
remote — and the sources are picked on the phone's remote app or the panel at
the set; everyone watching the holder navigate the start screen on the prop
(a cursor in the record, the `ui` field) is a later slice. The phone's remote
app is the buttons; the TV is the display. Every tile wears its
lane badge (**SOVEREIGN** / **PLAYER-RUN** / **PUBLIC SWARM** / **CONVENIENCE**),
and strict-sovereign builds grey out the convenience tiles and the public DHT.

| Tile | Who fetches the bytes | Reaches the screen as | Sync | Class | Posture |
|---|---|---|---|---|---|
| ▶️ YouTube | each viewer, from YouTube | iframe, IFrame API | full | Convenience, single vendor | allowed, labelled, greyed out when unreachable; `youtube-nocookie.com`; no other feature may require it; on the desktop shells gated on §3.5's error-153 check — until it passes, the tile may fail from `tauri://localhost`, which v1's theatre reports as a lane failure with RETRY (browsers are unaffected) |
| 🏛️ archive.org | each viewer (direct `<video>`, or via the node proxy for a texture) | `<video>` / `VideoTexture`, or their embed | full (a chosen file) / start-time (their embed) | Convenience host, sovereign backup exists | later, not v1: the item's `licenseurl` shown and a marked-PD shelf (v1's resolver accepts any identifier and reads only the file list and the title); every fetch offered to the station library |
| 📺 PeerTube | the instance named; a station can run its own | iframe, embed API (`play`/`pause`/`seek`) | full | Convenience, or player-run | add it: the player-run answer to "YouTube-shaped" content |
| 🔗 URL | the host named | `<video>` | full for finite, seekable media (a host with range support); start-only for a live stream or a host without usable ranges — the element's `seekable` decides, and the controller never seeks what cannot be sought | Convenience | whoever pastes it is responsible for it; each viewer's browser fetches it only after PLAY FROM <host> (§3.2), and never from a private-network host |
| 📁 File (host's own) | host node → blob lane → viewers' nodes | `VideoTexture` from the local node | full | Pure P2P | private rooms, delete-on-leave cache |
| 🧲 Magnet / `.torrent` | the host node from the public swarm, then the blob lane (§6) | `VideoTexture` from the local node | full | Public swarm for the fetch, pure P2P for the room | paste only, no search, no tracker list, seeding notice |
| 🎤 Karaoke MP3+G | the singer's client (§5) | CD+G on the `CanvasTexture` + audio through Web Audio | full | Pure P2P | the host's own files; stream, don't copy |
| 🖥️ Screen share | the host, live (§4) | `VideoFrameTexture` | live | Pure P2P | the #189 lane |

### 3.4 Rendering paths

- **Path A — an iframe on a CSS3D plane** (YouTube, archive embed, PeerTube).
  The three.js `css3d_youtube` pattern: a `CSS3DRenderer` layer behind the
  WebGL canvas, the canvas clearing transparent, a `NoBlending` "hole" mesh on
  the screen plane so avatars occlude it. Works with the orthographic camera.
  Costs: `renderer.ts` sets an opaque `scene.background` that must move to the
  CSS layer; no lighting or CRT shader on the iframe; its audio cannot enter
  the Web Audio graph; the iframe swallows pointer events. And the canvas
  itself is opaque today: `renderer.ts` builds its `WebGLRenderer` without
  `alpha: true` (line 74), so moving the background alone would leave the
  drawing buffer opaque and the hole hidden — the spike recreates the
  renderer with alpha enabled and clears with alpha 0, and only then moves
  `scene.background` into the CSS layer.
- **Path B — a `<video>` into a `VideoTexture`** (node-proxied mp4, local file,
  blob, torrent). Lit, occluded, shader-able (the #194 CRT pass only works
  here), audio through the `partyAudio.ts` graph with distance falloff. Needs
  CORS-clean bytes: a `/api/media?url=…&cap=…` range pipe on the node. The
  pipe is a **request gate, not a response header**: the listener's existing
  origin allowlist (`wt_listener.rs`, `origin_allowed`) only decides whether
  `Access-Control-Allow-Origin` is emitted and serves the GET regardless —
  right for a fingerprint, wrong for a fetcher, because a `<video src>` or a
  no-CORS request from any page that can reach loopback would still make the
  node download whatever the URL names, bandwidth and CPU spent on a response
  the page can never read. So the proxy requires a **node-scoped capability
  token**: minted by the node at launch (random, per launch, never
  persisted) and delivered over a channel only the app's own page can read
  — NOT `/api/fingerprint`, whose allowlist (`origin_allowed` in
  `ssf-p2p-node/src/main.rs`) admits any loopback origin on any port, so
  that a dev server or another app's local UI could read a token served
  there; that loopback-wide rule stays for the fingerprint, and for
  development builds, and gates nothing of the proxy's. In the desktop shell
  the token goes from the sidecar to the webview over the app's own IPC
  (Tauri `invoke`), never over HTTP; a browser page gets it from a dedicated
  `/api/media-cap` endpoint whose allowlist is EXACT origins — the app's own
  (`tauri://localhost`, `http(s)://tauri.localhost`) and the origins named
  in `SSF_ALLOWED_ORIGINS`, never a loopback wildcard — and the proxy's own
  `Origin` check is that same exact list. The token is carried in the URL
  because a `<video>` cannot set a header, with the element in CORS mode
  (`crossOrigin = 'anonymous'`):
  that is what makes a `<video>` send `Origin` at all — a plain cross-origin
  `<video src>` sends none and would meet the 403 below — and what a
  `VideoTexture` needs anyway, since a non-CORS video taints the canvas it is
  drawn to; a missing or wrong token, or a missing or disallowed `Origin`,
  is a 403 **before any DNS lookup or outbound connection**. Only then the
  host allowlist — and, because a loopback service that fetches URLs is an
  SSRF surface, the node resolves the name ITSELF and validates every
  address the answer holds: an IPv6 address that carries an IPv4 inside is
  normalized to that IPv4 first — IPv4-mapped and IPv4-compatible forms, and
  any address under a NAT64 prefix: the well-known `64:ff9b::/96` and
  `64:ff9b:1::/48`, and the network's own, learned the RFC 7050 way by
  resolving `ipv4only.arpa` and reading the prefix off the AAAA answer
  (`64:ff9b::a9fe:a9fe` is global unicast on paper and the metadata address
  in fact) — and then anything that is not a global unicast address is
  refused — loopback, private, link-local, the metadata address,
  unspecified, carrier-grade NAT, multicast, broadcast, documentation and
  reserved ranges, IPv6 unique-local and link-local alike (a denylist of a
  few classes is a list of what was remembered; the rule is an allowlist of
  global unicast and nothing else). Where the NAT64 discovery cannot run, or
  its answer is not one the node trusts, IPv6 destinations are refused
  outright, which costs nothing where IPv4 reaches the same host. The
  classifier is a pure function with that table of cases as its tests — and
  the node PINS the socket to
  a vetted address: it connects to the IP with the original name kept as
  `Host` and SNI, and the HTTP client never resolves the name again on
  connect — a rebinding resolver would answer the check with a public
  address and the connect with a private one, so "validated after DNS"
  alone checks one answer and connects on another. On EVERY redirect and
  every retry the whole gate runs again from the top: the host allowlist on
  the new target before any lookup, then the resolve, validate and pin
  (redirects capped) — an allowed host can redirect anywhere, and a redirect
  that is not re-admitted is the end of the fetch. A size ceiling, a timeout
  and a cap on concurrent fetches. A hostname allowlist alone closes
  nothing, a response header gates nothing, and a check the connect does not
  reuse protects nothing.
- **v1 ships neither on the in-world plane.** The first slice draws the status,
  menu, countdown and now-playing card on the in-world `CanvasTexture` and plays
  the actual video in a **theatre panel** (DOM) that anyone in the room opens
  from the TV, the phone, or a HUD chip while seated. A `<video>` in a DOM
  panel needs no CORS, so archive.org files and direct URLs get full sync
  without any node change. The CSS3D in-world plane is spike S1 (§11).

### 3.5 Tauri checks before the in-world iframe

- YouTube **error 153** is a referrer problem: on macOS and Linux Tauri serves
  the UI from `tauri://localhost`, which sends no `Referer`. It gates TV v1 on
  those shells, not only the in-world iframe: v1's theatre is itself an IFrame
  API embed from the same origin. Until the three-shell check passes, v1's
  defined state on a shell that fails is the lane-failure notice with RETRY
  and nothing else depending on it (browsers are unaffected). No
  `referrerpolicy` is a remedy: a document loaded from `tauri://` has no
  HTTP(S) referrer to send whatever the policy says — Tauri's own tracker
  confirms that even `unsafe-url` produces none for the custom protocol — so
  the spike does not spend itself there. `youtube-nocookie.com` stays, for
  privacy. The remedy to measure is serving the UI from an http(s) loopback
  origin — the node's HTTP origin as the frontend discovered it (8080, or
  8081 when 8080 is taken; never a fixed port) — which also makes the proxy
  same-origin but moves the app's storage origin, so it is a measured
  decision.
- The Linux webview (WebKitGTK) is the weakest: codecs via GStreamer; WebCodecs
  from 2.44; WebRTC reportedly absent in many builds. Treat Linux as "embeds
  and mp4" until verified.

### 3.6 Content classes (unchanged from the first note on #186)

1. Public-domain and Creative Commons films: any room.
2. Free embeddable web video via the platform's own player: any room.
3. The host's own DRM-free files: small private rooms, stream rather than copy.
4. Never: paid platform content (DRM captures black), re-broadcast captures of
   YouTube, ripped discs, Tribler/torrent search as a built-in catalogue.

## 4. The media lane: two steps, then subscriptions

**Step 1 — the blob lane (bytes, not a stream).** Add `iroh-blobs` to the
node (v006 §12.1 already pins it; the `'asset'` envelope kind is reserved for
it). The host's node imports a file as a BLAKE3 blob; viewers' nodes fetch it
(verified, resumable, in order, so playback can start early) and serve it to
their own webview at `/blob/<hash>?cap=…` with range support, behind the
same request gate as `/api/media` (§3.4): the per-launch capability token
and an allowed `Origin`, checked before any read of the store, the element
in CORS mode so that it sends one. The route
serves only what the store already holds or is fetching and never starts a
fetch itself — CORS only governs who may read a response, a `<video src>`
needs none to make the request, and a hash is no secret once a room record
carries it, so the hash alone authorizes nothing and without the gate any
page that can reach loopback could drive reads against the viewer's node.
A hash alone starts nothing: a fetch
needs a provider, as an `iroh-blobs` `BlobTicket` carries one beside the
hash and format — and a provider is an ADDRESS, not a name: the ticket's
`NodeAddr` is the node id with its relay URL and direct addresses, and an
id alone is nothing to dial once the importer is no longer a connected
member. So the `blob` source (§3.1) and a library op (§7) carry the hash
with the importing node's iroh id and its dial hints in the shape the room
already passes around for its members — `RoomMemberHint` in
`network/protocol.ts`: `irohNodeId`, `irohRelayUrls`, `irohDirectAddrs` —
and every node that completes the blob announces `have` for the hash on
the room's control plane (a sibling of the `media-sub` kind) with its own
current hints the same way; a connected member's hints are also in the
room's member records, authenticated by the link they came over, and a
library seeder's ride its signed library entry (§7), so the fall-back to a
seeder nobody is connected to is a dial, not a guess. A viewer resolves a
hash to the nodes that hold it: the ticket's provider while it is still
here, else any announcing holder — a hub among them only when it chose to
hold the blob, since `iroh-blobs` moves bytes from provider to requester
directly and relaying for a spoke puts nothing in the hub's store: a hub
prefetches what its spokes play as an explicit step under its own cap and
budget, and announces `have` only once it holds the whole blob — else the
station library's seeders (§7). A provider that
leaves mid-transfer, stalls (no progress for 10 s, or under a floor rate
for 30 s), fails a request or serves bytes the hash rejects is replaced by
the next holder from the next range on — a `have` is any peer's claim, so a
holder that lied or stalled is remembered and not tried again this session
— and the hash verifies every byte, so any honest holder is as good as the
host, and the host leaving does not end the film for those still fetching.
No re-encode, every platform; the countdown spreads the host's upload
before T0. Honest caveat: a transfer, not
a stream — delete-on-leave cache and private rooms keep it in the shape of
sending a friend a file. And the record is peer-writable, so a fetch is never
automatic beyond a cap AND a budget: the source carries its declared size; a
viewer's node fetches on its own only when the declared size fits a
per-transfer `autoFetchCap` the viewer sets AND what is left of a cumulative
`autoFetchBudget` — the bytes fetched without asking, per room and per
session (a FETCH button otherwise: a declaration larger than the remainder
would download partially and abort, spending the remainder for nothing),
with one automatic transfer in flight per room, a byte rate ceiling, and —
since a byte budget bounds no number of requests — an automatic-transfer
count per room and per session, a minimum charge per transfer against the
byte budget (a thousand empty blobs still cost what verifying and indexing
them costs), and a cache-entry count limit per room and global, under
per-room and global cache quotas, with cancellation and delete-on-leave. The budget exists because a
cap alone bounds one transfer: a peer rotating through fresh under-cap
hashes would spend a viewer's bandwidth without end while cache eviction
kept the disk quota honest; a spent budget makes every further fetch an
explicit FETCH, and eviction never refills it. And the declared size, being
peer-written, is only a hint, so every transfer runs under a hard byte
ceiling of its own. Three numbers, kept apart: the cap and the budget say
what fetches *without asking*; a fetch the viewer approved runs to the
`approvedLimit` the FETCH button showed them (the declaration, bounded by
the quota they have left), never to the cap, which would abort the very
transfer they agreed to. An automatic fetch's ceiling is its declaration,
already fitted under the cap and the remainder by the rule that let it
start, so the ceiling never cuts short a transfer it began; an approved
one's is its approved limit; received bytes past the ceiling abort the
transfer, and a completed blob whose size differs from the declaration is
rejected either way.
Nobody in a room can spend another viewer's bandwidth or disk unasked. The same lane later carries room assets, ROMs and the
station library (§7).

**Step 2 — the live lane.** `new VideoFrame(canvasOrVideo, {timestamp})` →
WebCodecs `VideoEncoder` / `AudioEncoder` (Opus) → **end-to-end encryption in
the sender's page** → WebTransport unidirectional streams (one per frame or
keyframe group; 20 ms Opus frames may use datagrams) → node → iroh fan-out as
a `media` lane the node and every hub forward without being able to read →
viewers' `VideoDecoder` → three.js `VideoFrameTexture`, and viewers'
`AudioDecoder` (Opus) → a 60–120 ms jitter buffer → the Web Audio graph,
spatialised at the source's position. A keyframe every ~2 s plus
keyframe-on-request.

**Encrypted end to end, not hop by hop.** WebTransport and iroh encrypt each
hop, and a forwarding hub terminates one hop and opens the next, so "opaque"
framing alone would let a hub read every Opus frame and video chunk it
relays. v006 §9's rule for forwarded voice stands: forwarders see only
ciphertext (the WebRTC path met it with Encoded Transform; here the sender
does the same by hand on WebCodecs output — the SFrame shape, RFC 9605).
Each frame is sealed with an AEAD (XChaCha20-Poly1305 or AES-256-GCM) under
a per-LEG key: a source has an audio leg and a video leg, each leg's key is
derived from the per-source media key with the leg as the label (HKDF), and
each leg counts its own frames, so two legs never share a nonce space under
one key — one key with two independent encoder counters would reuse a
nonce, which breaks the AEAD outright. A leg's counter is the SENDER's for
the whole epoch, never the encoder's: it lives outside the encoder and
survives every pause, restart and reconfiguration (§9 and spike #21 restart
encoders for the first subscriber), so a restarted encoder goes on from the
counter it left; and a counter about to wrap, or a sender that has lost its
counter (a page reload), takes a new key epoch before it sends another
frame. A nonce is never reused under one key. The frame counter is the nonce, and
the routing header — source id, leg, key epoch, counter, keyframe flag — is
the associated data and is under the sender's signature below, so a hub can
relabel nothing: a frame moved to another leg or another counter neither
opens nor verifies. The header is all the node needs to route (the
subscriber set), to serve the glimpse tier (the keyframe flag) and to drop,
and it gets nothing else. The sender mints the source key, seals it to each
subscriber's X25519 key (derived from their Ed25519 identity, the libsodium
conversion) on the reliable lane when the subscription is accepted, and
rotates to a new epoch before every admission (the admitted can open
nothing from before it: a key handed out mid-epoch would open the ciphertext
a joiner, or a hub that later joins as a member, had already logged — which
is the guarantee below that a forwarding node reconstructs no audio), on
every departure (the departed can open nothing after it) and on a timer. A
join and a leave each cost one rotation — a sealed key per subscriber on
the reliable lane — which at room scale is nothing. Replay protection is a sliding window per leg,
the SRTP shape: a leg's counter only ever goes up within an epoch; a
receiver keeps, per leg, the highest counter it has accepted and a bitmap
of the last 128 below it, takes a frame above the highest (and
slides the window up), takes a frame inside the window that the bitmap has
not seen, and drops a duplicate or a counter older than the window — so
frames that arrive out of order across streams are played once, and a
replayed one never. Origin, not only membership: a shared key proves that a
frame came from someone holding it, and every subscriber holds it — so any
subscriber could forge frames as the source, and with a high counter push
genuine frames out of the window. The sender therefore signs every frame:
an Ed25519 signature by the sender's identity key — the key the room
already knows the source by — over the frame's header and ciphertext,
verified before anything is decoded or played. Nothing plays
unauthenticated, a lost datagram costs only itself, and a forged frame
fails verification and is dropped and counted (reported when it keeps
coming) — never a reason to drop the source, since any member could inject,
and dropping would hand each of them a way to silence any speaker. The
replay window advances on verified frames only. The cost is 64 bytes a
frame: about 26 kbps on a 20 ms Opus stream, roughly doubling voice and
still a tenth of a video stream, and some eighty verifications a second per
source, a few milliseconds of CPU; a sender may sign a batch of up to three
Opus frames (60 ms) for a third of the overhead at 40 ms more latency,
while video frames, kilobytes each, are signed one by one. Hash chains and
signed manifests were considered and rejected: both either make playback
speculative — a frame heard before its proof cannot be unheard, and a
subscriber with the group key could inject audible frames until the proof
was due — or add their interval to the latency. A subscription is signed by the subscriber's identity
with proof of possession (the P2 lane binding's shape, §9), so no entry is
forged in another's name, and a forged entry would receive only ciphertext
it cannot open. What a hub still sees is the traffic's shape — who sends to
whom, how often, how much — as with v006's SFU-lite. The lane supersedes
the WebRTC mesh (#10) only once this layer is in and a forwarding node that
logs every frame is shown to reconstruct no audio.
A canvas or `<video>` source needs no `MediaStreamTrackProcessor`, but the
three CAPABILITIES the lane rests on are feature-detected separately, and a
sender advertises only the ones it has (they are not legs — the lane has
two, audio and video, keyed as above): `WebTransport` (Safari 26.4 is the floor per
`docs/TDD/BrowserSupportMatrix.md`), `VideoEncoder` (Chromium, Firefox 130+,
Safari 16.4+, WebKitGTK 2.44+) and `AudioEncoder` (absent on Safari
16.4–18.x and WebKitGTK 2.44). Only true screen capture (`getDisplayMedia`)
is Chromium-first. Budget per
viewer: ~24–32 kbps voice, ~96–128 kbps music, ~0.3–0.8 Mbps for a
native-resolution arcade screen, ~1.5–3 Mbps for a 720p desktop. **Build
audio first**: it is a tenth of the work, it is #189, and it unlocks karaoke.

**Subscriptions by distance.** The viewer decides, not the sender: every client
knows the source's position (furniture doc) and its own, subscribes within
`R_live`, unsubscribes beyond `R_live + 1.5 m` (hysteresis). The node keeps a
per-source subscriber set (a `media-sub` control kind beside `graft`/`prune`)
and forwards frames only to subscribed links. An entry is a lease scoped to
the link that made it — renewed by that link, removed from every set when
the link disconnects or stops renewing, so a dead tab never pins a sender on
and frames are never sent into a dead link; a hub subscribes upstream for
its spokes — ONE forwarding subscription per hub on the data plane, kept
only while a live spoke of its own still wants the source — and relays each
spoke's signed membership lease, and its departure, to the sender
separately on the control plane: the aggregate says where frames go, the
per-spoke leases say who may open them, because the sender above seals the
key to each subscriber on admission and rotates on each departure, and a
join or a leave behind an already-subscribed hub would otherwise reach it
neither — the joiner waiting on a key that never comes, the leaver keeping
one it should have lost. The hub forwards what it receives as the
ciphertext it is — the media key reaches each spoke sealed from the sender,
never from the hub (above). With no subscriber the sender's own node drops
frames at the source AND tells its browser so, and the browser stops capturing and encoding
until the first subscriber returns (restarting on a keyframe) — a node-side
drop alone would leave the dominant CPU and battery cost in place. Tiers:
live (near, full stream + audio), glimpse (keyframes only, no second
encode), far (the attract still; nothing captured, nothing encoded). The
TV's live sources
use the same mechanism with a larger radius; voice uses an earshot radius.

## 5. Karaoke

- **Tier 1 (TV v1 only):** YouTube karaoke/lyric videos, synced; everyone sings
  alone. A toy.
- **Tier 2 (audio lane):** a microphone prop; whoever holds it is the live
  source. Either everyone plays the backing track locally and listeners delay
  it by the measured transit (the voice-chat shape), or the singer's client
  mixes mic + track in Web Audio and streams the mix (~128 kbps; perfect sync
  by construction; the track must be a decodable file). Recommend the mix for
  the karaoke machine. `echoCancellation: true` plus a "headphones recommended"
  line; verify Chromium's canceller removes the local backing track.
- **MP3+G** (`.mp3` + `.cdg`, 300×216, 16 colours, ~300 packets/s, usually
  zipped): render with the `cdgraphics` library keyed to the audio element's
  `currentTime` onto the screen's `CanvasTexture` (so lyrics get the CRT pass).
  Distribution: share the zip over the blob lane for home-made/CC/PD tracks;
  stream the mixed audio plus the `.cdg` packets as a tiny side stream for a
  purchased library, so nothing but a stream leaves the singer's machine.
- **Lyrics and scoring** need no media: LRC/UltraStar timed lyrics from the
  shared clock; pitch detection (YIN in an `AudioWorklet`) against an UltraStar
  note track where one exists. CD+G carries no pitch data.

## 6. Torrents without the central parts

| Central piece | Without it |
|---|---|
| Trackers (`tr=`, `announce`) | DHT (BEP 5) + PEX (BEP 11) + LSD (BEP 14). rqbit does DHT and PEX; verify LSD. Trackers in a magnet are used opportunistically, never required; the node ships **no tracker list** — and a strict build ignores the ones embedded in a pasted magnet or `.torrent` (`tr=`, `announce`) unless the operator opts in, since shipping no list suppresses nothing the metadata carries. |
| DHT bootstrap nodes | A persisted routing table (rqbit's `DhtConfig` takes `routing_table` and `peer_store`), **our own nodes as bootstrap** (`bootstrap_addrs`; every node with the `torrent` feature runs a full DHT node, so a room's hub is its spokes' bootstrap), a player-run tracker in the registry (`aquatic_udp`, Rust, in the bridge kit), and a ChiaHub record for our own content. Strict builds turn the public list off. |
| Web seeds (BEP 19) | Fine as convenience; archive torrents are mostly this, which is why the proxy serves them better. Third-party HTTP origins too: off in a strict build unless the operator opts in. rqbit's web-seed support is unverified. |
| Metadata for a magnet (BEP 9) | From any peer; a `.torrent` file skips the step. |

Rules: `librqbit` inside `ssf-p2p-node` as an optional cargo feature
(`torrent`, gated like `chia-lane`), never a second process. The **host's node
is the room's one swarm participant**; the file reaches the room over the blob
lane; viewers join the swarm only by opt-in. Paste only, no search, no
catalogue. A `fetching` state with the host node's progress on the screen; the
🕒 schedule is how a torrent is meant to be used. One-line notice that
BitTorrent uploads as it downloads; owner setting defaults to *seed while the
TV plays, stop after*. Prefer `mp4`/`webm` files; most webviews will not play
`mkv`. A station that passes its library around as torrents runs its own
`aquatic` tracker and marks them private (BEP 27).

## 7. The station library: the sovereign backup

- **Bytes:** the blob lane, content-addressed, replicated by possession, served
  to a webview by the local node.
- **Index:** a signed `library-add { hash, title, bytes, licence, source,
  addedBy }` op in the RoomLog, per station or venture — v002's "Chia infohash
  registry + our seeders" with the registry in the signed log and a
  ChiaHub-shaped record for a station's library root as the floor.
  **Prerequisite:** the SsfLog-backed RoomLog adapter. Today `RoomLog.append`
  and `subscribe` are contract stubs on the Phase 2 horizon; the adapter is
  an explicit gate that lands before the library, not beside it.
- **Resolution order on the TV:** library (any member who has it) → archive /
  PeerTube / URL via the proxy → the item's torrent over the DHT; an
  `identifier → hash` map keeps a second viewing off archive.org.
- **Policy:** PD/CC-marked items by default, the owner's own files behind the
  private-room rule, never YouTube.
- **Who seeds outward:** nobody by default. A **library-station** role (the
  beacon-toggle shape) fetches from the public swarm and the archive, seeds
  into the public DHT, and serves the station. That volunteer alone exposes
  an IP to public swarms; everyone else is hidden by construction.
- **Who may fill it:** a signature says who enqueued an item, not that the
  content is theirs to share or fit to seed. Two writer sets, stated apart.
  `library-add` is accepted only from the station's owners — room owners by
  a key the accepting node can trust: an owner key pinned in the station's
  own config, or the `owner_ed25519_pubkey` / `cohost_ed25519_pubkeys` of
  the room's verified authority head
  ([chia-authority-architecture.md](chia-authority-architecture.md), whose
  §3 verification is itself an open TODO item), and never the peer-writable
  `roomInfo.owner → players[owner].keyB64` chain that `gamesDoc.ts` reads
  today, which any peer can rewrite and nothing pins, so a writer set taken
  from it would be no writer set at all — the library-station operator
  approves each item before any fetch
  (or allowlists signers) but does not add; the fetch verifies hash and size
  against the op; storage and egress run under quotas. `library-remove` (a
  denylist honoured by every node) is accepted from the station's owners AND
  from the library-station operator, an additional remove-only authority
  (the volunteer must be able to drop what it will not host) — whose key is
  bound the way the owners' are, never self-asserted: pinned in the
  station's own config, or named by the room's verified authority head (an
  operator key the deed holder signs into it). The beacon-style opt-in says
  a node volunteers to fetch and seed; it says nothing about whose removals
  the rest of the station should honour, and a node that can resolve no
  operator key honours no operator removals. A removal
  signed by anyone else is rejected before the denylist is applied, since a
  signature identifies a writer without authorizing one, and an open remove
  would let any room peer blank the whole library. Nobody can make the
  volunteer fetch and seed arbitrary or oversized content, or drop what it
  holds, by writing an op.

## 8. Tribler / IPv8, evaluated seriously

IPv8 is a UDP overlay of communities keyed by public key, bootstrapped by
introduction. py-ipv8's shipped `configuration.py` loads `DiscoveryCommunity`,
`HiddenTunnelCommunity` and `DHTDiscoveryCommunity` by default; bootstrap is
13 raw IP:port entries at TU Delft plus `dispersy1–4.tribler.org`; tunnel
defaults are `max_circuits: 1`, `max_joined_circuits: 100` (every default node
relays strangers' circuits), `max_time: 600`, `max_time_inactive: 20`,
`max_traffic: 250 MiB`. No Rust implementation exists: `ipv8-rust-tunnels` is
the data plane under Python and `kotlin-ipv8` implements Discovery and
TrustChain only.

| Stage | Build | Yields | Estimate |
|---|---|---|---|
| A | wire format, keys, the Discovery walk, bootstrap, persisted peers | on the overlay | 3–4 weeks |
| B | TunnelCommunity client: circuits, DATA cells, rotation, SOCKS5 UDP-associate for rqbit, exit selection | anonymous fetch of a public magnet | 6–10 weeks |
| C | HiddenTunnelCommunity + DHT discovery | hidden swarms | 4–8 weeks |
| D | relay side, TrustChain accounting, their test vectors | good citizenship | 4+ weeks |
| ∞ | track py-ipv8 3.x / Tribler 8.x releases | staying on the overlay | ongoing |

**Verdict:** buildable in four to six engineer-months, but it fails the
project's own tests: the protocol is one lab's with one reference
implementation (the single-vendor shape v002 rejects for relays), a default
node relays strangers' traffic (or free-rides if it does not), the circuit
limits make it a download-ahead source rather than a streaming one, and the
anonymity is, by Tribler's own statement, not mature. The one property worth
having — players' IPs never in public swarms — comes cheaper from host-only
fetch, the library-station volunteer, and later an opt-in embedded I2P router
(`emissary`, Rust, experimental, several independent implementations, no
exits). **Recommendation:** do not port IPv8 now; if the owners still want it
after the library, run a two-week opt-in FEASIBILITY SPIKE — a subset of
stage A, not stage A: the wire format, keys and one Discovery walk against
the shipped bootstrap list, with no persistence or relay polish — measured on
what discovery alone can show: bootstrap success and latency, introductions
received, peers walked per minute, how many advertise the tunnel community.
Those are its exit criteria; stage A proper stays the 3–4 weeks in the table,
and nothing past it is committed on the spike. Exit-peer count and three-hop
throughput need stage B's circuits: they gate B→C, not A→B.

## 9. The arcade cabinet

**Models.** A: every player runs the same deterministic emulator and the room
exchanges inputs (RetroArch netplay); bytes per frame, fits the tick lane, no
media lane. B: one machine runs it, streams video, receives inputs
(Parsec/cloud gaming); needs the live lane and adds a round trip of input lag.
Screen sharing is not required for multiplayer; it is how spectators watch.

**Player one is the source.** P1 holds the cabinet's P1 panel (claimed in the
doc the way an air-hockey end is, with the page-seat rule); their emulator
canvas is the picture. Spectators subscribe by distance (§4): live within
~5 m at the game's native resolution (~0.3–0.8 Mbps), keyframe glimpses to
~10 m, the attract still beyond. With the lane in place the cheapest player
two is **also over the video** (inputs on the tick lane's extended kind,
P1's emulator applies them): any core, no determinism work, ~50 ms input lag
on a LAN and ~120 ms at a 40 ms round trip between the players; the game dies
when P1 leaves. **Prerequisite, in two parts:** first the node's SIGNED
lane-to-key binding — M5.5's per-epoch Ed25519 binding of `origin_lane_id`
to a trusted pubkey, carried on the reliable lane and verified before relay;
today the id is minted unauthenticated and relayed verbatim (the M5.5-STUB
note in `ssf-p2p-node/src/main.rs`), so an admitted neighbour can forge any
lane, and a lookup alone would let it drive P2. The binding must carry the
PLAYER's proof of possession, not the node's word alone: a node signature
authenticates the node, and an admitted node gone bad could attest its own
lane as the P2 occupant's key and sail through the lookup. So the page
identity signs a fresh binding over {room, origin node key, epoch, lane id};
the originating node verifies it on the connection that owns the lane and
relays that proof with its own attestation; P1 verifies both against the
seat before any lane is mapped to a player. And every input after that is
authenticated end to end too: the binding proves the lane was the player's
once, and a node gone bad could emit ticks under it afterwards that P1
could not tell from the player's. So the two pages derive a session key —
X25519 between their identity-derived keys, bound by the KDF to {room,
cabinet id, the seat's tenure nonce, epoch, lane id, both pubs}, where the
tenure nonce is minted fresh by P1 as it grants the seat and carried in the
seat record, so a renewed seat or another cabinet is another key even for
the same two identities on the same lane in the same room epoch — and each
kind-3 input carries a strictly increasing sequence number and a
keyed-BLAKE3 MAC under that key over the whole canonical frame: sub-kind,
sequence and payload, nothing an input says left outside it. P1 drops any
input whose MAC fails or whose sequence does not advance, and an input
captured in one session verifies in no other — a high sequence replayed
from an earlier tenure cannot push a new session's inputs out (thirteen
bytes become about thirty; at 60 Hz that is nothing). Thirty bytes do not fit the tick
lane as it is: browser ingress takes exactly 13-byte datagrams, and the
mesh relays only the 13-, 14- and 22-byte frames with a 13-byte tick inside
(`ssf-p2p-node/src/main.rs`, the datagram arms) — everything else is
dropped on the floor. So the extended datagram is a prerequisite in its own
right, landed as one change across the four places that read a tick, in
two shapes as today's tick already has: the browser sends its node a bare
`[kind 3 | sub-kind][len][payload ≤ 64 B]` and nothing else, and the node —
as it does for the 13-byte tick — mints the lane id from the connection and
the TTL itself and wraps the mesh frame `[TTL][8B origin lane id][kind 3 |
sub-kind][len][payload]`, so a browser never chooses routing or authorship
metadata, and ingress rejects a frame that carries any. Negotiated per link
by a capability on the M5 control plane; ingress accepts it only from a
browser that announced it, the relay forwards it only to links that did
and dedups it as it dedups the tick today — on `blake3(origin lane id ‖
the whole extended datagram)`, payload included (`tick_seen_key` in
`ssf-p2p-node/src/main.rs`, the M5.2 rule the build plan states as "never
on (origin, seq) alone") — because a dedup keyed on the sequence would let
a forwarding hub race a doctored copy under a genuine sequence into every
cache on the way, and the honest copy arriving by another path would be
dropped before P1 ever saw its MAC fail; loop suppression keys on the
bytes, and the sequence is enforced by P1 alone, after the MAC verifies.
Local delivery hands it to the page as its own message, and a legacy peer
is never sent one and goes on dropping unknown lengths as it does today. And then the S3 mapping from that proven key to the player
holding the seat. P1 accepts kind-3 inputs only
from a lane whose proven key is the P2 seat's identity, and only inputs
that key's session authenticates. Lockstep stays the upgrade for games
where lag matters.

**Sources.** The archive.org embed (`archive.org/embed/<id>`) is single-player
only (cross-origin, no input injection, no CRT). The ROM file loaded into an
emulator in our page is the path that can do netplay, save states and #194.
ROM-set versions must match the core; the owner's shelf is curated by test.
The archive is a convenience source; the owner's own file is the sovereign
one; the station library (§7) is the sovereign backup for ROMs exactly as for
films, and its BLAKE3 hash is the first half of the netplay determinism check
— the bytes. Lockstep also binds the exact core build, the emulator settings
and the initial state, or two identical ROMs still diverge.

**Engine.** EmulatorJS (libretro cores in WASM) for single-player, the menu,
save states, gamepads and touch; its own netplay is WebRTC-based with its own
signaling and STUN/TURN and is marked unstable, so it is not depended on.
Lockstep needs a libretro core driven per frame (a thin harness, the P2
spike). Licences to review before bundling: EmulatorJS GPL-3.0, FBNeo
non-commercial clause, MAME a GPL-2.0/BSD-3 mix. The emulator data files are
**not** vendored into the repository (size); they are fetched into
`public/emulatorjs/` by a script for sovereign builds, and the CDN is an
opt-in labelled CONVENIENCE.

**Display and controls.** The emulator draws to a canvas. In P1 the picture
lives in P1's stage panel (DOM) with a CSS scanline-and-vignette pass, and the
cabinet's `CanvasTexture` shows the attract card and "P1 · name" — the TV's
posture (§3.4), for the TV's reason: nothing else in the room can see P1's
canvas yet. The canvas on the prop's texture, with the #194 shader pass, comes
with the spectator lane, which is what puts the picture in front of other
players in the first place. Focus is the device-focus first-person framing;
keyboard first (RetroPad defaults, WASD suppressed while at the controls),
Gamepad API, mouse under pointer lock as a trackball, the virtual gamepad on
Android.

**Phasing.** P1 cabinet + single player (attract mode, owner-set game or menu,
EmulatorJS in our origin — the CDN lane sandboxed — P1 focus and controls, the
CSS CRT pass on the stage) → the media lane with subscriptions (shared with
the TV's screen share and karaoke), which brings the picture and the texture
CRT pass to the prop → P2 over video → lockstep only for the games that need
it.

## 10. Options considered

| Option | Verdict | Why |
|---|---|---|
| Holder runs a browser and screen-shares it (the issue's first idea) | Rejected for public web video; kept for things that cannot be embedded (step 2) | Embed + sync costs no re-encode or uplink, gives each viewer their own quality, and DRM content captures black |
| Owner-only remote | Rejected | Owner ruling: anyone holding the remote controls the TV; the lease gives possession semantics |
| UTC-only sync | Rejected | Consumer clocks are minutes off; anchor on local receipt of the holder's heartbeat instead |
| CSS3D iframe on the in-world plane in v1 | Deferred to spike S1 | Needs the renderer's opaque background moved to CSS and the Tauri referer check; the theatre panel delivers the sync first |
| iroh-blobs for the host's files | Adopted (step 1) | No re-encode, every platform, reuses the reserved `'asset'` lane |
| WebCodecs live lane | Adopted (step 2), audio first | Needed for voice, karaoke, screen share, arcade spectators |
| Bundle headless Tribler | Rejected | Python runtime, GPL, second update train, and the room still cannot see the stream |
| "Bring your own Tribler" REST hook | Allowed, desktop-only, out of scope for v1 | Days of work; hides nothing for the room |
| Native IPv8 in Rust | Not now (stage-A spike only on request) | §8 |
| librqbit torrent feature | Adopted with §6 rules | Single binary, DHT/PEX, streaming endpoint |
| Per-viewer swarm fetch | Opt-in only | Exposes every viewer's IP; host-only fetch + blob lane hides N−1 |
| Tor for torrent traffic | Rejected | No UDP; the Tor project asks people not to torrent through it |
| I2P (`emissary`) | Watch; opt-in later | Experimental; passes the no-single-vendor rule that IPv8 fails |
| WebTorrent in the browser | Rejected | Browsers cannot join classic swarms |
| Lockstep netplay first for the arcade | Deferred behind P2-over-video | Multi-week determinism spike; the video lane is built for spectators anyway |
| EmulatorJS netplay | Not depended on | WebRTC + its own signaling/TURN, marked unstable |
| Spectators run the emulator themselves | Possible later | CPU per spectator and a save-state transfer; the video lane is cheaper at retro resolutions |
| Sender-side distance gating | Rejected | The node is content-blind and tick positions are untrusted; viewer-pull matches the mesh's IWANT philosophy |

## 11. Final recommendations and sequence

1. **TV v1, no node changes** (this PR line): TV furniture (wall mount + stand),
   the `tv`/`remote` records, the lease remote on the phone, YouTube via the
   IFrame API with full sync, archive.org files and direct URLs via `<video>`
   with full sync for finite, seekable media (the archive embed, a live
   stream or a host without usable ranges play start-time only, §3.3), the
   countdown, the start screen with lane badges, the theatre panel. Spike
   **S1** beside it: the CSS3D hole-punch with the ortho camera
   plus the error-153 check on the three desktop shells.
2. **Node media proxy** (`/api/media`, range + CORS, host allowlist): textures
   from archive.org files, spatial audio, the #194 CRT pass; the cabinet's ROM
   fetch uses the same route.
3. **Blob lane** (`iroh-blobs`): the host's files, prefetched during the
   countdown; the room side of torrents; the station library.
4. **`torrent` feature** (`librqbit`) under §6's rules; PeerTube tile.
5. **Audio lane** (WebCodecs Opus over the node): #189, then karaoke tier 2 and
   the #190 calls; media subscriptions by distance on the node.
6. **Video lane:** screen share, arcade spectators, then P2 over video.
7. **Arcade P1** can proceed in parallel with 1–2 (it needs only the proxy for
   archive ROMs; local files work without it).
8. **Not now:** IPv8/Tribler (stage-A spike only on request), per-viewer swarm
   fetch by default, any built-in content search.

## 12. Open decisions for the owner

- v1 sources: YouTube + archive.org + direct URL (recommended), PeerTube next.
- Whether a station runs a library-station node, and who.
- Whether the IPv8 stage-A spike is wanted at all after the library lands.
- The arcade shelf's default contents (homebrew/freeware first) and whether
  the CDN opt-in for emulator files is acceptable for non-sovereign builds.
