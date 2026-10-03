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
        | { kind: 'blob', hash, bytes, name }     // the host's own file (blob lane, §4)
        | null,
  state: 'off' | 'scheduled' | 'playing' | 'paused',
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
```

**Sync rule.** While playing, the holder's client writes `{positionMs, seq}`
every 3 s. Every other client records `receivedAt = Date.now()` when a new
`seq` lands and computes `expected = positionMs + (now − receivedAt) + lead`.
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
node is refused outright, no button offered (`tvConsent.ts` in #207). So the
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
  the Web Audio graph; the iframe swallows pointer events.
- **Path B — a `<video>` into a `VideoTexture`** (node-proxied mp4, local file,
  blob, torrent). Lit, occluded, shader-able (the #194 CRT pass only works
  here), audio through the `partyAudio.ts` graph with distance falloff. Needs
  CORS-clean bytes: a `/api/media` range pipe on the node, behind its CORS
  allowlist and a host allowlist — and, because a loopback service that
  fetches URLs is an SSRF surface, the destination is validated AFTER DNS
  resolution and on EVERY redirect (loopback, private, link-local and
  metadata addresses refused; redirects capped), with a size ceiling and a
  timeout. A hostname allowlist alone closes nothing.
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
  and nothing else depending on it (browsers are unaffected). Try
  `referrerpolicy="strict-origin-when-cross-origin"` and `youtube-nocookie.com`
  first; the fallback is serving the UI from an http(s) loopback origin — the
  node's HTTP origin as the frontend discovered it (8080, or 8081 when 8080 is
  taken; never a fixed port) — which also makes the proxy same-origin but
  moves the app's storage origin, so it is a measured decision.
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
their own webview with range support. No re-encode, every platform; the
countdown spreads the host's upload before T0. Honest caveat: a transfer, not
a stream — delete-on-leave cache and private rooms keep it in the shape of
sending a friend a file. And the record is peer-writable, so a fetch is never
automatic beyond a cap: the source carries its declared size; a viewer's node
fetches on its own only under a per-room ceiling the viewer sets (a FETCH
button above it), under per-room and global cache quotas, with cancellation
and delete-on-leave — nobody in a room can spend another viewer's bandwidth
or disk unasked. The same lane later carries room assets, ROMs and the
station library (§7).

**Step 2 — the live lane.** `new VideoFrame(canvasOrVideo, {timestamp})` →
WebCodecs `VideoEncoder` / `AudioEncoder` (Opus) → WebTransport unidirectional
streams (one per frame or keyframe group; 20 ms Opus frames may use datagrams)
→ node → iroh fan-out as an opaque `media` lane → viewers' `VideoDecoder` →
three.js `VideoFrameTexture`, and viewers' `AudioDecoder` (Opus) → a 60–120 ms
jitter buffer → the Web Audio graph, spatialised at the source's position. A
keyframe every ~2 s plus keyframe-on-request.
A canvas or `<video>` source needs no `MediaStreamTrackProcessor`, but the
three legs are detected separately and a sender advertises only the legs it
has: `WebTransport` (Safari 26.4 is the floor per
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
and forwards frames only to subscribed links; a hub subscribes upstream for
its spokes; with no subscriber the sender's own node drops frames at the
source AND tells its browser so, and the browser stops capturing and encoding
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
  `library-add` is accepted only from the station's owners (room owners, by
  key) — the library-station operator approves each item before any fetch
  (or allowlists signers) but does not add; the fetch verifies hash and size
  against the op; storage and egress run under quotas. `library-remove` (a
  denylist honoured by every node) is accepted from the station's owners AND
  from the library-station operator, an additional remove-only authority
  (the volunteer must be able to drop what it will not host); a removal
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
lane, and a lookup alone would let it drive P2 — and then the S3 mapping
from that verified key to the player holding the seat. P1 accepts kind-3
inputs only from a lane whose signed key is the P2 seat's identity. Lockstep
stays the upgrade for games where lag matters.

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
   IFrame API with full sync, archive.org and direct URLs via `<video>` with
   full sync, the countdown, the start screen with lane badges, the theatre
   panel. Spike **S1** beside it: the CSS3D hole-punch with the ortho camera
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
