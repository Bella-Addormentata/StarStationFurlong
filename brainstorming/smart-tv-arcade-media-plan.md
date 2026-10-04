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
| Single-writer clocks | The operator stamps absolute deadlines; others render `deadline − localNow`; heartbeat 3 s, stale at 9 s — wall clocks compared across devices, so a precedent for the schedule's absolute `startAt` (§3.1 accepts that skew) and NOT for liveness, which §3.1 takes from the pusher row below | `croupier.ts` (`isCroupierLive`) |
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
        | { kind: 'blob', hash, bytes, name, provider }  // the host's own file: the hash with the importing node's iroh id — the id
                         // ALONE, never dial hints: a viewer's node resolves the id to a route itself
                         // (what it observed on an earlier authenticated connection, iroh discovery),
                         // since an address a peer wrote, signed or not, is a reflection surface (§4)
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
writes land locally). That term corrects exactly one hop — the last one,
from the viewer's own node to its page, which on a desktop build is
loopback and worth nothing — and no other: the sample's path runs from the
holder's page through its node and the mesh to the viewer's node before
that hop, and anchoring at receipt keeps every millisecond of that
delivery delay in the viewer's position. The honest guarantee is therefore
the weaker one: each viewer sits BEHIND the holder by its own delivery
delay, a standing offset that no heartbeat corrects (the next sample
arrives with the same delay) and that never grows (a heartbeat replaces,
it does not accumulate, so a one-off spike lasts one heartbeat); two
viewers differ by the difference of their delays, typically tens of
milliseconds over a hop or two and inside the seek band; and none of it is
clock skew: no device
compares its clock with another's (the `pusherCroupier.ts` rule —
`leaseLapsesAt` counts a lease term from when THIS page first saw the
record, never `Date.now()` against a stamp another device wrote — and the
air-hockey staleness clocks, local receipt time against the local clock;
NOT `croupier.ts`, whose `isCroupierLive` takes `Date.now() − beat` across
devices and is the precedent this rule exists to avoid). An end-to-end
probe — a viewer's mark echoed by the holder through the record and timed
on the viewer's own clock — is what would measure the whole path and take
the offset out; it is a later item, and until it lands the term stays the
one hop it is. Drift correction: `<video>` elements
nudge `playbackRate` ±3 % under 1 s of drift and seek beyond 1.5 s; the
YouTube player only seeks (its rate steps are coarse), with a 1.5 s dead band
so we never fight its own buffering. Pause is a record write. A late joiner
reads once, computes, seeks.

**Scheduled start.** `state: 'scheduled'` renders the countdown from
`startAt − localNow` (display only). At T0 only the HOLDER's clock decides.
The shared record is still `scheduled`: the holder's own read treats the due
schedule as running (locally, and nowhere else), and its first heartbeat
performs the shared transition to `playing`; every viewer starts on receipt
of that write and anchors to it, so skew between viewers never splits the
room. What anchoring cannot do is make the holder's clock right: the START
is the holder's wall clock against `startAt`, and a holder five minutes
fast starts the room five minutes early for everyone (five minutes slow,
late) — skew moves the start, never the sync after it. v1 states that and
accepts it: the holder who scheduled the film sees the same countdown as
everyone else, and a clock within a minute is the norm; a station time
source (the node's peers, or NTP through the node) is a later item, not
v1's. A viewer whose countdown has
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
| The TV has buttons on its body | Anyone standing at the TV can press POWER and VOLUME without the remote — each its own key (§3.1), so no body press writes the programme record the holder rewrites every three seconds, and an INPUT button, if one comes, gets a key of its own the same way, never a second writer of `tv:<id>` — and whoever turns the set ON has the remote placed in their hand (#186's rule) when it is on the set or lapsed; a live holder keeps it, since a body button moves nothing out of a hand and the owner's spare is not the switch's to use: the holder turns the set on themselves, or hands the remote over |
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
and a strict-sovereign build greys out the convenience tiles and shows the
torrent tile as library-only, since §6 compiles the torrent client out there.

**Ruling (2026‑10‑04): serverless sources only, by default.** The owner's
call after the torrent-only assessment: a default build offers no
convenience lane at all — the YouTube and archive.org tiles are not shown,
a pasted URL plays only from the viewer's own origin or their node (any
other server is refused with the reason; PLAY FROM <host> does not exist
there), and the cabinet's CDN opt-in (§9) is not offered — while the
convenience code stays in the tree behind one build flag,
`VITE_SSF_CONVENIENCE_LANES=1` (`src/sovereignty.ts`, read literally at
build time the way the treasury's network pin is), for the day it is wanted
again. The file, karaoke, screen and torrent tiles are the sovereign lanes
and land on their own schedule (§11). The table below describes every lane
as designed; the Convenience rows exist only in a build with the flag on.
In code: #207 (the TV) and #208 (the cabinet).

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
  the node is another PROCESS — spawned by the shell, or already running
  (`src-tauri/src/main.rs`, `acquire_p2p_node`), the shell holding only an
  HTTP placeholder for it — so the hand-off crosses that boundary where the
  OS already authenticates: the node writes the token at launch to a file in
  its per-user data dir readable by that user alone (a spawned node also
  takes a pairing secret from the shell's environment and writes the file
  under it), the shell's Rust side reads the file and hands the token to
  its own webview over `invoke` — never over HTTP. "Readable by that user
  alone" is a creation property, never a tightening after the fact, and it
  is defined per platform: on Unix, mode 0600 at creation
  (`OpenOptions::mode(0o600)` with `create_new`); on Windows, where a mode
  means nothing, a security descriptor set at creation whose DACL is
  protected — it inherits nothing from the directory — and grants the
  owning user's SID alone. The directory it lives in is owner-only the same
  way — mode 0700 on Unix, a protected DACL granting the owning SID alone
  on Windows — created so and verified so by writer and reader alike
  before any token is written or read, since ownership alone says nothing
  about who else may rename into, replace or delete from a directory. The
  file is written under a temporary name in the same directory and renamed
  into place with the platform's atomic replacement — `rename(2)` on Unix;
  on Windows `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, or
  `SetFileInformationByHandle` with `FileRenameInfoEx` and the
  replace-if-exists and POSIX-semantics flags, which is what Rust's
  `std::fs::rename` wraps there, verified on the target toolchain by the
  spike and failing closed (no token, no proxy) where it cannot replace an
  existing file — so no reader sees a half-written token and the previous
  launch's file is replaced by the rename, never left behind, and it is
  removed on a clean exit. The reader opens the final path without
  following links (`O_NOFOLLOW`; on Windows `FILE_FLAG_OPEN_REPARSE_POINT`
  with any reparse point refused) and checks the open handle, not the
  path: a regular file, owned by the user, with the mode or DACL above,
  and on Unix the inode the directory entry names, so a swapped, linked or
  stale file is refused; a shell that finds the file or its directory
  wider than owner-only refuses it and reports, and the proxy is
  unavailable. In the EMBEDDED
  mode — no sidecar found, the shell starting its own `wt_listener` and HTTP
  API in-process (`src-tauri/src/main.rs`, `NodeMode::Unavailable`) — there
  is no boundary to cross: the shell mints the token itself and hands it to
  its webview over `invoke`, with no file. Whichever listener answers, the
  gate is ONE module — the token check, the `Origin` / fetch-metadata rule,
  the address classifier and the socket pinning in a crate both the node
  and the embedded listener compile in, with one table of test cases — or
  the proxy does not exist in that listener: an embedded listener without
  the module answers `/api/media` with 404 and the theatre's consent-only
  direct URL is what plays, so the two HTTP implementations never diverge
  in what they let through. `tauri://localhost` on macOS and Linux, and
  `http://tauri.localhost` on Windows (§2), is every Tauri app's origin on
  that platform and names nothing on its own, so possession of the token
  is the authority and the origin list only a filter. A browser page, in development, gets it from a dedicated
  `/api/media-cap` endpoint whose allowlist is the EXACT origins named in
  `SSF_ALLOWED_ORIGINS`, never a loopback wildcard. Where no such channel
  exists — a node whose data dir the shell cannot read, a page on an origin
  the list does not name — the proxy is simply unavailable and the
  theatre's consent-only direct URL is what plays. The proxy's own
  `Origin` check is that same exact list, a filter behind the token. The
  token is carried in the URL
  because a `<video>` cannot set a header, with the element in CORS mode
  (`crossOrigin = 'anonymous'`):
  that is what makes a cross-origin `<video>` send `Origin` at all — a plain
  cross-origin `<video src>` sends none — and what a `VideoTexture` needs
  anyway, since a non-CORS video taints the canvas it is drawn to. A
  SAME-origin GET sends no `Origin` even in CORS mode, and that is the very
  deployment §3.5 proposes (the UI served from the node's own HTTP origin),
  so the gate reads `Origin` where there is one and fetch metadata where
  there is not: a request with no `Origin` is admitted only with
  `Sec-Fetch-Site: same-origin` — the header every current browser sets and
  no page can forge — and refused otherwise. A missing or wrong token, a
  disallowed `Origin`, or no `Origin` without that same-origin metadata, is
  a 403 **before any DNS lookup or outbound connection**; `/blob` follows
  the same rule (§4). Only then the
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
  on both ends of the pipe (an upstream that stalls, a reader that stops
  reading) and a cap on concurrent fetches. The REQUEST upstream is built
  from nothing, never copied from the browser's: in the same-origin
  deployment the browser's request carries the app's own cookies and
  whatever `Authorization` it holds, so the proxy sends an allowlist of its
  own making — GET or HEAD, `Host`, `Range` (with `If-Range`,
  `If-None-Match` and `If-Modified-Since` as validators), a fixed
  `User-Agent`, `Accept: */*` and `Accept-Encoding: identity` — and nothing
  else: no `Cookie`, `Authorization`, `Origin`, `Referer` or fetch-metadata
  header reaches a media host. Identity encoding is forced, and an upstream
  answer that carries `Content-Encoding` anyway is refused, since an encoded
  body breaks the byte offsets `Content-Length` and `Content-Range`
  promise. And the RESPONSE is bytes, never
  the upstream's headers: the proxy forwards an allowlist of them only —
  `Content-Type` (checked against an allowlist: `video/*`, `audio/*`,
  `application/octet-stream`, and `application/zip` with
  `application/x-zip-compressed` for the cabinet's ROM sets, §9 — a text,
  HTML, script or image type ends the fetch, since nothing the proxy
  serves is ever a document), `Content-Length`, `Content-Range`,
  `Accept-Ranges`, `ETag`,
  `Last-Modified` — and drops everything else, `Set-Cookie`,
  `Clear-Site-Data`, `Content-Security-Policy`,
  `Strict-Transport-Security`, `Location` (a redirect is followed under the
  gate above, never handed to the browser), `Link`, `Refresh`,
  `WWW-Authenticate` and every `Access-Control-*`, `Cross-Origin-*` and
  `Cache-Control` among them, minting its own CORS, `Cache-Control:
  private, no-store` and `X-Content-Type-Options: nosniff`; in the
  same-origin deployment §3.5 proposes, a forwarded cookie or
  `Clear-Site-Data` would act on the app's own origin, and a media host
  could set the app's cookies or wipe its storage. It answers only a
  subresource fetch (`Sec-Fetch-Dest` of `video`, `audio` or `empty`, with
  `Content-Security-Policy: sandbox` on the response besides), never a
  navigation, so nothing an allowed host serves is ever rendered as a
  document of the app's origin. A hostname allowlist alone closes nothing,
  a response header gates nothing, and a check the connect does not reuse
  protects nothing.
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
  decision — and moves Tauri's IPC boundary with it: `invoke` is what hands
  the webview the media token, the shell's commands are registered in
  `src-tauri/src/main.rs` (`invoke_handler`), and a page on an http(s)
  origin reaches them only through Tauri's remote-domain IPC access, which
  is off by default and must not be opened wide. S1 verifies that the
  loopback origin — chosen at run time, so the capability must name the
  node's actual origin, never a wildcard — can reach exactly the commands
  it needs (the media-token command, the fingerprint one) and no other, and
  that no other origin reaches any; if Tauri cannot scope it that narrowly,
  the token travels another way (the shell injects it into the page at
  load) and the IPC stays closed.
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
and an allowed `Origin` — or `Sec-Fetch-Site: same-origin` in its place,
the proxy's rule — checked before any read of the store, the element in
CORS mode so that a cross-origin one sends an `Origin`. Every `/blob`
response carries `Cache-Control: private, no-store` (the proxy's responses
the same): a webview's HTTP cache keeps the ranges it was served, and
without the header delete-on-leave and eviction would remove the store's
copy while a second, unquotaed one lived on in the cache — the node's store
is the only copy, under the quotas. The route
serves only what the store already holds or is fetching and never starts a
fetch itself — CORS only governs who may read a response, a `<video src>`
needs none to make the request, and a hash is no secret once a room record
carries it, so the hash alone authorizes nothing and without the gate any
page that can reach loopback could drive reads against the viewer's node.
A hash alone starts nothing: a fetch
needs a provider, as an `iroh-blobs` `BlobTicket` carries one beside the
hash and format. The ticket's `NodeAddr` bundles a relay URL and direct
addresses with the node id for convenience; here the id is ALL that
travels — no dial hints, signed or not. A signature binds a claim to its
signer and proves nothing about who answers at an address: a member could
sign {its own id, a victim's address} and have every automatic viewer send
a QUIC handshake there, which is exactly why the node already dials every
gossip-learned peer by id with EMPTY hints (`ssf-p2p-node/src/main.rs`, the
TIER_INTRODUCED dial: "the signature covers the payload + author, NOT the
iroh_node_id / direct_addrs"). So the `blob` source (§3.1) and a library
op (§7) carry the hash with the importing node's iroh id, and a viewer's
node resolves that id to a route in two classes, kept apart. A route it
observed ITSELF on an authenticated connection with that id — the importer
is a connected member when the record first appears, a `have` announcer is
connected by definition, and iroh keeps what it saw — is the only route an
AUTOMATIC fetch (one the viewer did not ask for: the cap and budget below)
ever dials. In a hub-and-spoke room that route is usually the HUB, not the
importer: a spoke's node holds one authenticated connection, to its hub,
the record reaches it through that hub, and a `have` counts only on its
announcer's own connection, never relayed — so an automatic fetch at a
spoke has exactly one admissible route, its hub, and runs only once the
hub holds the blob: the hub prefetches what its spokes will play as an
explicit step of its own, under its own cap and budget (below), and
announces `have` on each spoke's connection once it holds the whole blob.
A spoke whose hub does not hold it gets a FETCH button, and that consent
is what admits a discovery route. A hub vouching for the importer's
address — a route handoff — was considered and refused: the hub's word
about another node's address is exactly the claim the id-only rule exists
to reject. A route from discovery is a peer-authored hint like any other:
on the sovereign Mainline DHT a node publishes its OWN signed address record
(`ssf-p2p-node/src/main.rs`, the `DhtAddressLookup`), so a holder could
publish a victim's address under its own id as surely as it could write one
into a room record, and mDNS and a relay are no better — so such a route is
dialled only for a fetch the viewer asked for (the FETCH button, the
library's explicit resolution of a seeder nobody is connected to), under a
per-id and a global rate limit with exponential backoff, one QUIC Initial
per attempt and no retry storm. The most a victim can be made to receive is
a few datagrams a minute from each viewer who chose to fetch — the standing
cost of any id-to-address lookup on a public DHT, iroh's included — which
is bounded here and never claimed closed. A viewer's node never sends an
automatic handshake to an address anyone merely wrote down, in a room
record or a DHT record alike. A provider reachable by neither class is not
reachable, and the record says who else to ask: every node that
completes the blob announces `have` for the hash on the room's control
plane (a sibling of the `media-sub` kind) — an announce that is evidence
only on the announcer's own authenticated connection, accepted from the
link whose iroh handshake proved its node id, never relayed as someone
else's word, and dialled, again, by that id. The hints in the room's
member records are the bootstrap roster's and nothing more (`YjsSync`
carries them outside the signed envelope, `src/network/YjsSync.ts`); the
blob lane dials from none of them. A library seeder's signed entry (§7)
names its node id, dialled the same way. So the fall-back to a seeder
nobody is connected to is a dial by id through discovery — never to an
address a stranger supplied — and holding is proven by serving bytes the
hash verifies, never by a claim. A viewer resolves a
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
WebCodecs `VideoEncoder` / `AudioEncoder` (Opus), each chunk's bytes
carrying its timestamp, its type and its decoder-configuration generation
in the authenticated header below (`copyTo()` gives the bytes alone) →
**end-to-end encryption in
the sender's page** → WebTransport unidirectional streams, one per video
frame, each carrying one signed frame and verified whole; 20 ms Opus frames
(or a batch of three) as datagrams, one signed frame or batch per datagram
→ node → iroh fan-out as
a `media` lane the node and every hub forward without being able to read →
viewers' `VideoDecoder` → three.js `VideoFrameTexture` — added upstream in
r173 (January 2025, `src/textures/VideoFrameTexture.js`), after the r167
the prototype pins (`three` 0.167.1), so the
video lane carries a three.js upgrade with a regression pass of the
renderer (the hole-punch spike touches the same file), or, until it lands,
an equivalent uploader on r167: each decoded `VideoFrame` drawn into an
`OffscreenCanvas` behind a `CanvasTexture`, one copy a frame, enough at
arcade resolution — and viewers'
`AudioDecoder` (Opus), both decoders configured from the signed
`media-config` message (below) → a 60–120 ms jitter buffer ordered by the
chunks' timestamps → the Web Audio graph,
spatialised at the source's position. A keyframe every ~2 s plus
keyframe-on-request.

**Encrypted end to end, not hop by hop.** WebTransport and iroh encrypt each
hop, and a forwarding hub terminates one hop and opens the next, so "opaque"
framing alone would let a hub read every Opus frame and video chunk it
relays. v006 §9's rule for forwarded voice stands: forwarders see only
ciphertext (the WebRTC path met it with Encoded Transform; here the sender
does the same by hand on WebCodecs output — the SFrame shape, RFC 9605).
Each frame is sealed with ONE suite, pinned rather than negotiated —
AES‑256‑GCM through WebCrypto, the one AEAD every browser's `crypto.subtle`
has and hardware-backed; a version byte in the header names the suite, v1
is this, and a receiver that lacks a version drops the frame and reports —
under a per-LEG key: a source has an audio leg and a video leg, and each
leg's key and nonce salt are derived by HKDF‑SHA‑256 from the 32-byte
per-source media key with the key epoch (4 bytes, big-endian) as the salt
and `"ssf-media-v1" ‖ leg (1 byte) ‖ "key"` or `‖ "salt"` as the info, 32
and 12 bytes out; the 96-bit nonce is the leg's 12-byte salt XOR the
64-bit frame counter, big-endian in the low 8 bytes (the SFrame
construction), and each leg counts its own frames, so two legs never
share a nonce space under one key — one key with two independent encoder
counters would reuse a nonce, which breaks the AEAD outright. The
associated data is the header exactly as it goes on the wire, fixed to
the byte: version (1) ‖ source (32) ‖
leg (1) ‖ key epoch (4, big-endian) ‖ counter (8, big-endian) ‖ timestamp
(8, big-endian `i64`: the chunk's WebCodecs `timestamp`, a signed 64-bit
microsecond count, on the source's one capture clock, which both legs
share — a sender starts that clock at zero or above and a receiver drops
a negative value as malformed, so the sign bit is never set on the wire
and Rust and TypeScript read the field alike) ‖ config (2, big-endian:
the generation of the decoder configuration the frame decodes under) ‖
flags (1: bit 0 the keyframe, bit 1 a batch) — 57 bytes — and the
signature below covers that header and the ciphertext with its tag. The
counter is for the nonce, the replay window and loss, never for time:
`copyTo()` hands the page encoded bytes only, and a chunk's timestamp, its
type and the decoder's configuration travel beside them or a receiver
cannot rebuild an `EncodedAudioChunk` or `EncodedVideoChunk` at all — so
the timestamp is here, authenticated with the rest: the jitter buffer
orders by it, a pause is a gap in it rather than a slip, a screen share's
irregular frames keep their own times, and audio meets video by
subtraction on the shared clock (a batch carries its first chunk's
timestamp in the header and each chunk's duration in its table, below —
never inferred from a packet's TOC byte, which gives the duration of ONE
frame while a code-3 packet carries several — so chunk k starts at the
header's timestamp plus the durations before it); the keyframe bit is the
chunk's type; and the configuration
goes on the reliable lane, below, named by its generation. The source is an INSTANCE, never
the sender's key: one identity may publish voice, a screen share and an
arcade feed at once, and each is its own source with its own subscriber
set, media key, epochs and counters — `source = BLAKE3(sender key ‖ room
‖ kind ‖ a 16-byte instance nonce)`, declared in the sender's signed
source announcement on the control plane, which binds the id to the
sender key, the room, the kind and the nonce; a frame's signature is
verified against the key that announcement names, resolved once per
source and never read from the header. The DECODER CONFIGURATION travels
the same way, not in the frame: a signed `media-config` message per
(source, leg, generation) on the reliable lane — for video the codec
string, the coded width and height and, where the codec wants one, the
`description` bytes; for audio `opus`, the sample rate, the channel count
and the Opus head beyond two channels — signed by the sender's identity
key like the announcement, forwarded verbatim by every hub, naming the
counter of the first frame it governs; the generation rises on every
reconfiguration (a resolution change, a codec change), which always begins
at a keyframe, so a decoder is reset on a frame it can start from; a
receiver holding frames of a generation it has no configuration for waits
the jitter window for the message and then drops them; a `media-config`
that fails its signature is dropped and counted against the link like a
frame; and senders use codecs whose keyframes are self-describing (VP8,
VP9, AV1, H.264 in Annex-B form), so a keyframe and its configuration are
all a late joiner needs. A leg's counter is the SENDER's for
the whole epoch, never the encoder's: it lives outside the encoder and
survives every pause, restart and reconfiguration (§9 and spike #21 restart
encoders for the first subscriber), so a restarted encoder goes on from the
counter it left. Epochs and counters live together in the sender's page
state, and the epoch only rises within an instance; a counter about to wrap
takes a new epoch — a fresh media key, sealed again, as any rotation —
before the next frame. A sender that has LOST that state (a page reload, a
crash) has lost the instance: it cannot know which epochs or counters the
old source used, so it never continues it under any epoch — it announces a
NEW source instance (a fresh 16-byte instance nonce, hence a new source id
and a new media key, every subscriber subscribing afresh), and the old
source ends as a departure does. A nonce is never reused under one key,
because no key outlives the state that counts under it. The frame counter is the nonce, and
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
the reliable lane — which at room scale is nothing, until one member makes
a habit of it; so the transitions are defined once, enforceably, and the
two guarantees never meet. Membership is per IDENTITY, not per link: a
second tab, or a re-dialled link, of a member who holds the epoch's key is
the same member — no transition, the key resent to the new link. A
DEPARTURE is a member whose last lease has been gone for the grace window
(5 s: a lapsed lease renewed inside it was a flap, and the member never
left) or who said leave; it rotates AT ONCE — the sender emits under the
new epoch from its next frame — and from that rotation the departed can
open nothing: there is no resuming an epoch, and a return is an ADMISSION
like any other. Admissions are the side that is batched: a joiner is
pending until the next admission boundary (at most 2 s away), when one
rotation admits every pending joiner — with the key BEFORE the frames,
never after. The sender seals the new epoch's key to every subscriber, old
and new, on the reliable lane; switches its emission to the new epoch once
the current subscribers have acknowledged the key, or 500 ms later for any
that have not (they drop what they cannot open and catch the next
keyframe); and the sender's node starts routing frames to a joiner only
once that joiner's node has reported the key installed. A receiver holds
no frame it has no key for: a frame of an unknown epoch is dropped, and an
old-epoch frame that arrives reordered after the switch is opened with the
old key, which is kept for the jitter window (120 ms) and then discarded —
so a live voice stream is never a buffer stale, and the frames from before
a joiner's admission, which it was never meant to open, it never sees. So
a departure is never delayed, and admissions cost one rotation per interval
however many join.
What bounds a member who leaves and returns on purpose is counted at three
scopes, since an identity is free to mint: per identity, past three
departures in a minute it is parked — its next admission waits out a
backoff that doubles each time, and its leaves and returns trigger nothing
meanwhile; per ORIGIN NODE — the node a subscriber's page is connected
to, which signs every lease it forwards with its own iroh key
({subscriber identity, origin node id, lease epoch, sequence}, end to end
to the sender under the hub's relay; the control plane of #21), so the
origin is never the hub's word: a lease without a valid origin signature
is charged to the hub link alone, a departure counts against an origin
only when the origin signed it (its page gone, reported by the node that
saw it go), and a LAPSE — renewals that stopped arriving — is charged to
the link that carried them, the hub's, since a hub that withheld an
honest origin's renewals would otherwise park the honest origin; a
principal a fresh key cannot change and a shared hub connection is not:
past six departures a minute
across every identity behind one origin, that origin is parked — its
identities evicted in ONE rotation, their re-admissions waiting out the
doubling backoff together — so a client minting identities interrupts a
source six times, not without end, and the honest spokes behind the same
hub are not touched. The quota is enforced in layers, each parking only
the offender: a hub applies it to each spoke's link at the hub before
relaying anything (a spoke's departures count against that spoke, never
the hub), the sender applies it to the origin a lease names, and the
sender keeps a budget on the hub LINK itself regardless of the origins
behind it — a hub minting origins beside identities, each a fresh key
that signs its own leases, would keep every one under six: past one
departure a minute per admitted subscriber behind the link, plus six, the
link is parked and everything behind it evicted in one rotation, room an
honest hub with many spokes never needs and a lying one cannot stay
inside; a hub that keeps relaying a parked origin's churn is parked the
same way, an honest hub having parked the spoke first; and
source-wide, past thirty rotations a minute the sender batches further
departures into one rotation every two seconds and reports the storm,
which hands a departed member at most two seconds of frames it could still
open — stated as the cost — rather than the sender's whole budget. A
subscriber cap per source (sixty-four identities; the hubs' aggregation
keeps the forwarding tree beneath it) bounds what any rotation costs: one
sealed key per subscriber, a few milliseconds of X25519 and a few
kilobytes at the cap. Replay protection is a sliding window per leg and
epoch, the SRTP shape: a leg's counter only ever goes up within an epoch, a
new epoch starts a new window, and a new instance is a new source with
windows of its own (a reloaded sender is a new instance, above, never an old
source resumed); a receiver keeps, per leg, the highest counter it has
accepted and a bitmap
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
replay window advances on verified frames only. Authentication bounds
nothing by itself, so the lane has budgets enforced on the node BEFORE any
signature is checked, on the authenticated ingress link FIRST — the
WebTransport session or iroh connection a frame arrived on — in one
aggregate bucket per link whatever source ids its frames carry, since a
source id is what a flooder forges and a bucket per id would multiply the
allowance: the link's packet-rate and byte-rate ceilings are the sum of
the tiers of the sources it is admitted for (the publisher's registered
sources on a browser link, the subscribed sources on a mesh link) plus a
fifth, and a frame past them is dropped unverified. Inside that
aggregate, per-source tier buckets, nested: a frame-size ceiling per leg
from the source's announced tier (an Opus frame with its header, tag and
signature under 400 bytes; a video frame one WebTransport unidirectional
stream of its own, per the wire path above, read only up to the tier's
frame-size ceiling and verified whole before it is forwarded — never
fragmented into datagrams, which would need fragment ids, loss handling
and reassembly before any hub could check the signature — and, since a
stream is state the receiver holds until it ends, a cap on the streams a
link may hold open UNFINISHED (per link, set as the session's own
unidirectional-stream limit, which the receiver dictates and the sender
cannot exceed; and per source inside it, a few frames' worth: the tier's
frame rate times the jitter window) and a deadline from a stream's first
byte to its end (one frame interval of the tier, with slack) — a stream
past either is reset, its bytes discarded and the reset counted against
the link's failed-verification budget below, since a publisher holding a
thousand streams open with a byte each would spend the receiver's memory
and stream state under every rate ceiling here; and a stream whose bytes
pass the ceiling is reset at that byte, the frame never assembled), and
packet-rate and byte-rate ceilings per source with
a short burst allowance, per tier and counted on the WIRE — the tier's
codec rate plus the per-frame overhead (the 57-byte header, the 16-byte
tag and the 64-byte signature: 137 bytes a frame, 55 kbps at 50 frames a
second, more than voice itself, which is why three Opus frames may ride
one header, tag and signature, framed by a count, length and duration table inside
the plaintext) plus a fifth: about 105 kbps for the 32
kbps voice tier and about 220 kbps for the 128 kbps music tier signed
frame by frame, a third of the overhead when batched, and 50 frames a
second plus the batch allowance either way; video the same way from its
tier's rate —
admission per link by what the link is to the source: a browser link is
admitted for the sources it REGISTERED as their publisher (the source
announcement bound to that link on the control plane) and for nothing
else, a mesh link for the sources this node subscribed to upstream through
it and for nothing else, and a frame for any other source is dropped at
ingress (a publisher's own link subscribes to nothing — its subscribers
are downstream — so one rule for both would drop every frame at the
originating node);
a cap on the sources one link may carry, and a failed-verification budget
per link — past a handful of failures a second the LINK is muted for a
doubling backoff and the event reported, while the source stays up on
every other path. A hub verifies before it forwards (the signature is
public-key), so a forged frame dies at its first hop and its sender's link
pays; an honest hub forwards no forgery, so a failure arriving over a hub
link is that hub's own doing and the member re-homes rather than keep a
link that lies. A member or hub that floods invalid or oversized frames
spends its own link's budget, costs verification only up to it, and takes
no honest source down; a valid source past its tier is throttled to the
tier on every link, the ceilings being the tier's, not an estimate's. The cost is 137 bytes a
frame — the 64-byte signature, the 57-byte header and the 16-byte tag:
about 55 kbps on a 20 ms Opus stream, more than voice itself and still a
tenth of an arcade-resolution stream — and some eighty verifications a
second per source, a few milliseconds of CPU; a sender may sign a batch of
up to three Opus frames (60 ms) under one header, tag and signature for a
third of the overhead at 40 ms more latency — framed inside the plaintext
so the receiver can cut it back into the encoder's chunks, each with its
own timestamp and duration: a one-byte count, then per chunk a two-byte
big-endian length and a two-byte big-endian duration in 48 kHz samples
(one of Opus's frame sizes, 120 to 5760 — 2.5 to 120 ms: the sender
writes `round(duration × 48 / 1000)` from the chunk's WebCodecs
`duration`, which is MICROSECONDS — 20 000 for a 20 ms frame, so 960 goes
in the table, never 20 000 — and, when the chunk reports none, from the
`opus.frameDuration` it configured the encoder with, the same conversion;
the receiver hands its `EncodedAudioChunk` `samples × 1000 / 48`
microseconds back; a packet's TOC byte is never read for it, since the
TOC gives the duration of ONE frame while a code-3 packet carries
several), then the chunks in order, chunk k's
timestamp the header's plus the durations before it; the table under the
AEAD and the signature with the rest, bit 1 of the flags byte saying a
batch is inside, and a batch whose lengths do not add up to the payload,
or whose durations are not Opus frame sizes, dropped as malformed; never
a bare concatenation,
which Opus chunks of varying size could not be split again, and never a
repacketised multi-frame Opus packet, which would mean rewriting the TOC
in the page — while video frames, kilobytes
each, are signed one by one. Hash chains and
signed manifests were considered and rejected: both either make playback
speculative — a frame heard before its proof cannot be unheard, and a
subscriber with the group key could inject audible frames until the proof
was due — or add their interval to the latency. A subscription is signed by the subscriber's identity
with proof of possession (the P2 lane binding's shape, §9) and
countersigned by the origin node that forwards it, so no entry is forged
in another's name and no origin in another node's, and a forged entry would receive only ciphertext
it cannot open. What a hub still sees is the traffic's shape — who sends to
whom, how often, how much — as with v006's SFU-lite. The lane supersedes
the WebRTC mesh (#10) only once this layer is in and a forwarding node that
logs every frame is shown to reconstruct no audio.
Audio needs a step video does not: `AudioEncoder` takes `AudioData`, never
a `MediaStream` or a Web Audio node. A microphone track goes through an
audio `MediaStreamTrackProcessor` where the browser has one (Chromium),
else through an `AudioWorklet` tapping the track's
`MediaStreamAudioSourceNode` and building `AudioData` from its PCM frames —
the universal path, since the worklet is everywhere the lane runs, and the
one the karaoke mix takes regardless, tapped off the mix bus; both are
feature-detected with the worklet as the fallback for the PCM step only —
a worklet supplies PCM and encodes nothing — and a browser without
`AudioEncoder`, or whose `AudioEncoder` cannot do Opus, sends no audio and
says so, whatever worklets it has (Safari 16.4–18.x; on WebKitGTK the API
is there from 2.44 and the codec is a GStreamer plugin, below).
A canvas or `<video>` source needs no `MediaStreamTrackProcessor`, but the
three CAPABILITIES the lane rests on are feature-detected separately, and a
sender advertises only the ones it has (they are not legs — the lane has
two, audio and video, keyed as above): `WebTransport` (Safari 26.4 is the floor per
`docs/TDD/BrowserSupportMatrix.md`), `VideoEncoder` (Chromium; Firefox
desktop 130+ and NOT Firefox Android, per the matrix, so an Android Firefox
advertises no media leg; Safari 16.4+; WebKitGTK 2.44+) and `AudioEncoder`
(absent on Safari 16.4–18.x; present on WebKitGTK from 2.44, where WebCodecs
sits on GStreamer and a codec is whatever plugin the system has — Opus from
`opusenc` in gst-plugins-base — so the page asks
`AudioEncoder.isConfigSupported({ codec: 'opus', … })` rather than reading
a version, and advertises the audio leg only on a yes). Only true screen capture (`getDisplayMedia`)
is Chromium-first. Budget per
viewer: ~24–32 kbps voice, ~96–128 kbps music, ~0.3–0.8 Mbps for a
native-resolution arcade screen, ~1.5–3 Mbps for a 720p desktop — codec
rates; the wire adds the per-frame overhead, and §4's ceilings count the
wire. **Build
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
spoke's signed membership lease, countersigned by the spoke's own node as
its origin, and its departure, to the sender
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
| Trackers (`tr=`, `announce`) | DHT (BEP 5) + PEX (BEP 11) + LSD (BEP 14). rqbit does DHT and PEX; verify LSD. Trackers in a magnet are used opportunistically, never required; the node ships **no tracker list** — and since shipping no list suppresses nothing the metadata carries, whether a pasted magnet's or `.torrent`'s embedded trackers (`tr=`, `announce`) are contacted is an operator setting, default off, on a non-strict build — and when it is on, every tracker announce and every web-seed request (next rows) goes through §3.4's destination gate, the one crate the media proxy uses: the node resolves each tracker and web-seed name itself, admits global unicast only (loopback, private, link-local and the cloud metadata ranges refused; an explicit allowlist for a tracker the operator runs on the station's own LAN), pins the socket to the address it checked, and re-runs the whole gate on every redirect of a web seed. `librqbit` inherits none of that on its own, so the node filters the metadata's `tr=` and `url-list` entries before the client sees them, hands it pinned addresses where its API allows, runs its HTTP under a redirect policy that re-checks each hop, and where the client cannot be made to check every hop the setting stays off and says why. And the same classifier stands on every PEER dial, setting or no setting: the endpoints a tracker response, the DHT or PEX hand back are as untrusted as the metadata, so every outgoing BitTorrent connection and every uTP or DHT packet goes to a global-unicast address or nowhere — loopback, private, link-local and the metadata ranges refused, a LAN peer reachable only through the operator's explicit allowlist, which is also the only door LSD (a LAN-discovery protocol by design) ever opens — the check sitting in the client's connector, which the node forks if `librqbit` offers no hook there, rather than shipping without it. A strict build has no swarm at all (next row), so there the question never arises: "strict" is a build-time guarantee, not a runtime default, and nothing in a strict build opts into any of this. |
| DHT bootstrap nodes | A persisted routing table (rqbit's `DhtConfig` takes `routing_table` and `peer_store`), **our own nodes as bootstrap** (`bootstrap_addrs`; every node with the `torrent` feature runs a full Mainline DHT node, so a room's hub is its spokes' bootstrap — a way into the public DHT without a vendor's list, never an isolation boundary: an owned bootstrap is a Mainline participant and hands out public contacts on the first lookup, so a client bootstrapped from it IS in the public swarm, and a separate routing-table file changes nothing), a player-run tracker in the registry (`aquatic_udp`, Rust, in the bridge kit), and a ChiaHub record for our own content. A strict build has no torrent client at all: the `torrent` feature is not compiled in, so there is no BEP‑5 infohash DHT client, no PEX, no LSD, no tracker or web-seed code to reach a swarm with — the only isolation that holds for the swarm, since any Mainline client joins Mainline whatever it bootstraps from, and a second, private DHT would only duplicate what the blob lane and the library already are (an overlay of id-authenticated station nodes). A strict station takes its torrents through the blob lane and the library, fetched by a non-strict node of the station's. What this feature neither adds nor removes is the node's OWN address lookup over Mainline — `DhtAddressLookup` in `ssf-p2p-node/src/main.rs`, on by default today and off with `SSF_NO_DHT=1`, which publishes and resolves node ids, never infohashes: node discovery's lane-5 question (§1) — and a STRICT build answers it the way §1 does: the lookup is off there by default (`SSF_NO_DHT=1` is the strict default; an operator turns it on knowingly, and the node's status row says so), discovery falling back to signed local config, tickets and connected peers, so that "strict" promises no public DHT traffic of any kind, torrent or address. A build that merely leaves the `torrent` feature out while keeping the address lookup is TORRENT-FREE, the narrower promise, and is called that — never strict. |
| Web seeds (BEP 19) | Fine as convenience; archive torrents are mostly this, which is why the proxy serves them better. Third-party HTTP origins: an operator setting, default off, on a non-strict build, under the trackers row's destination gate when on (a web-seed URL comes from the same untrusted metadata, and a crafted one would otherwise point the node at loopback, the LAN or a metadata service); never on a strict one. rqbit's web-seed support is unverified. |
| Metadata for a magnet (BEP 9) | From any peer; a `.torrent` file skips the step. |

Rules: `librqbit` inside `ssf-p2p-node` as an optional cargo feature
(`torrent`, gated like `chia-lane`), never a second process, and not
compiled into a strict build at all (the DHT row above). The **host's node
is the room's one swarm participant**; the file reaches the room over the blob
lane; viewers join the swarm only by opt-in. And the client starts from a
LOCAL command only, never from the room record: the TV record is
peer-writable, so a node that reacted to a `torrent` source in it would let
any member put this node's IP in a public swarm and spend its disk and
bandwidth. A page starts a torrent on its own node through the node's
local channel under §3.4's capability token — the paste on the holder's
page is that command for the holder's node, JOIN SWARM on a viewer's page
is it for theirs — a node reading a magnet in shared state fetches nothing
and joins nothing, and the record carries the hash and the host node's
progress for the screen: it reports a transfer a node already approved
locally and starts none. The torrent side keeps its own limits beside
§4's blob-lane caps, viewer-set with defaults: a size cap per torrent and
a disk quota for torrent data, download and upload rate ceilings, a
seeding budget — *seed while the TV plays, stop after* by default, else up
to a ratio or a number of hours — and a count of concurrent torrents.
Paste only, no search, no
catalogue. A `fetching` state with the host node's progress on the screen; the
🕒 schedule is how a torrent is meant to be used. One-line notice that
BitTorrent uploads as it downloads. Prefer `mp4`/`webm` files; most webviews will not play
`mkv`. A station that passes its library around as torrents runs its own
`aquatic` tracker and marks them private (BEP 27).

## 7. The station library: the sovereign backup

- **Bytes:** the blob lane, content-addressed, replicated by possession, served
  to a webview by the local node.
- **Index:** a signed `library-add { hash, title, bytes, licence, source,
  addedBy, provider }` op in the RoomLog, per station or venture —
  `provider` the adding owner's node id, the first node to ask — plus a
  signed `library-seed { hash, node, seq }` announcement from every node
  that holds the item and will serve it (a library-station volunteer, an
  owner's node), renewed hourly under a sequence per (node, hash) that
  only rises — one per item, never one per node across items, or a
  renewal for one hash arriving after a higher one for another would read
  as a replay — and judged expiring by the READER: an announcement counts
  for a day from when this node last received a renewal with a higher
  `seq` for that (node, hash), by this node's own clock — never a stamp of
  the seeder's, which no reader could bound and a skewed or lying seeder
  could set a decade out — a renewal with an older or equal `seq` for that
  (node, hash) is a replay and ignored, the high-water mark kept per
  (node, hash) and persisted, and a signed `library-unseed` from the same
  node (a higher `seq` for that hash) or the
  item's `library-remove` withdraws it early. A late joiner counts its day
  from its own receipt and is wrong by at most that day about a seeder
  that has gone, and §4's route rule skips a holder that fails or stalls
  for the rest of the session either way. A seeder is its node id, dialled by id
  under §4's route rule (a connected announcer's observed route for an
  automatic fetch; discovery only for a fetch the viewer asked for), so a
  hash resolves, in order, to the connected `have` announcers, the
  unexpired seeders, and the adder's own node — never to a bare hash with
  nobody to ask. v002's "Chia infohash registry + our seeders" with the
  registry in the signed log and a ChiaHub-shaped record for a station's
  library root as the floor.
  **Prerequisite:** the SsfLog-backed RoomLog adapter. Today `RoomLog.append`
  and `subscribe` are contract stubs on the Phase 2 horizon; the adapter is
  an explicit gate that lands before the library, not beside it.
- **Resolution order on the TV:** library (a connected member who announces
  it, else an unexpired seeder, else the adder's node) → archive /
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
- **Under which authority:** owners' keys rotate and a deed transfers, so
  every `library-add`, `library-remove` and operator-key op names the
  authority head it was signed under — the head's sequence number and
  hash — and chains to the writer's own previous op by hash (the writer's
  first op names none), so each writer's ops form one contiguous chain
  that a gap breaks: a node holding an op whose predecessor it lacks
  fetches the predecessor before it accepts anything after it — and a
  chain that forks (two ops from one key naming the same predecessor: two
  devices on one key, or an equivocating writer) is resolved the same way
  everywhere, at once, not at the next head: the branch whose first op has
  the lower hash stands, the other is refused whole and the fork reported,
  and a node that accepted the losing branch first switches on sight and
  re-validates; a writer's client never signs over a tip it has not read
  (it fetches the key's tip first), so two honest devices on one key fork
  only in a race and lose at most the race's ops, and an anchored head's
  committed tip is the finality that closes the question later. A node
  validates an op against THAT head's writer set, never the current one.
  Heads form one chain of their own: each is signed by the authority that
  makes it (the deed holder for a key-set change; for a transfer, the new
  holder, citing the chain spend that made it so), numbers in sequence,
  names its predecessor by hash, and COMMITS the history it inherits — for
  every earlier writer, the hash of that writer's terminal accepted op —
  so an op under a superseded head is accepted only if it lies on the
  chain that ends at the committed tip. A newly signed op with an old
  sequence is off that chain, and so is a second op at a sequence the
  chain already holds, whoever signs them and whenever a node syncs; a
  sequence number alone would commit nothing, since a former owner could
  mint a backdated op below it, or two at one number, and a late node
  could not tell them from the history the successor accepted. A chain of
  signatures detects a fork and chooses none: the authority itself could
  sign two heads on one predecessor committing different tips, and two
  readers could accept two histories. So a head counts only once it is
  ANCHORED — its hash carried in a spend of the deed's own singleton on
  chain, the channel the authority architecture already gives the deed,
  whose lineage is linear by construction: one chain of coins, one chain
  of heads — and an unanchored head authorizes nothing yet; ops under it
  wait. Until the anchor lands (the §3 verification the authority
  architecture still owes), the deterministic rule is the lowest hash: of
  two heads on one predecessor from one authority, every node takes the
  one whose hash sorts first, switches to it on sight and re-validates
  what it accepted under the other, and an authority seen to equivocate is
  reported — convergent, and a stopgap, never finality.
  Historical validation is then the same rule on every node: walk the
  head chain, accept each writer's ops along its hash chain up to the tip
  the next head committed, and refuse the rest everywhere at once; the
  new holder chooses the tips and so may drop ops still in flight at the
  transfer, which is the new holder's prerogative over the new holder's
  library. A pinned owner key in a station's config is head zero of a
  chain of one.

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
sequence and payload, nothing an input says left outside it. The frame is
fixed to the byte: `[kind 3 | sub-kind: 1 B][len: 1 B, counting the
tag][seq: 4 B unsigned little-endian][input: 13 B]` (the sequence in the
tick codec's byte order, `protocol.ts`); the MAC is `blake3::keyed_hash` under the
32-byte session key over exactly those nineteen bytes, truncated to its
first 16 bytes and appended — a 128-bit tag (BLAKE3's output is a PRF, so
a prefix is a MAC of its own length's strength; 2⁻¹²⁸ per forged frame is
the claim, and the full 32 bytes would buy nothing a 60 Hz lane could use)
— and P1 takes the tag as the payload's last 16 bytes. The node's wrapper
(the TTL, the origin lane id) stays outside the MAC: the TTL changes per
hop, and the lane id is already bound into the key. The sequence starts at
zero under each session key and never wraps: 2³² frames is two years at
60 Hz, and a sender at the ceiling stops and takes a new seat (a new tenure
nonce, a new key, a new zero). P1 drops any
input whose MAC fails or whose sequence does not advance, and an input
captured in one session verifies in no other — a high sequence replayed
from an earlier tenure cannot push a new session's inputs out (thirteen
bytes become thirty-five; at 60 Hz that is 17 kbps, nothing). Thirty-five bytes do not fit the tick
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
`public/emulatorjs/` by a script (`npm run fetch:emulatorjs`), and the CDN is
an opt-in labelled CONVENIENCE that exists only in a build with the
convenience lanes on (`VITE_SSF_CONVENIENCE_LANES=1`: the 2026‑10‑04 ruling,
§3.3 — a record that says CDN reads as the station's files in a default
build, and a link on another server is refused at PUT ON with the reason).
The station's own files run in a same-origin frame (the canvas must stay
reachable for the spectator lane), so that frame runs under a
content-security policy set before its loader is fetched: this origin,
`blob:`, `data:` and the viewer's own node, nothing else — no update check,
no netplay signalling, no third party of any kind; `'unsafe-eval'` and
`'wasm-unsafe-eval'` for the cores. The CDN lane keeps its sandbox (an
opaque origin) for a wall instead. EmulatorJS has not yet run under the
policy (its files are never in the repository): the fetch spike is where a
directive it needs would show, as a console refusal naming it.

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
EmulatorJS in our origin under the policy above — the CDN lane, with the
lanes on, sandboxed — P1 focus and controls, the
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
   countdown, the start screen with lane badges, the theatre panel.
   **In #207 (open), serverless-only under the 2026‑10‑04 ruling (§3.3):** the
   YouTube and archive tiles and PLAY FROM <host> are in the tree behind
   `VITE_SSF_CONVENIENCE_LANES=1`; a default build plays a file on the
   viewer's own origin or node. Spike
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
   archive ROMs; local files work without it) — in #208 (open, stacked on
   #207) under the same ruling: the CDN opt-in and links on other servers
   behind the flag,
   the station lane's frame under a content-security policy (§9).
8. **Not now:** IPv8/Tribler (stage-A spike only on request), per-viewer swarm
   fetch by default, any built-in content search.

## 12. Open decisions for the owner

- ~~v1 sources: YouTube + archive.org + direct URL (recommended), PeerTube next.~~
  **Decided 2026‑10‑04:** serverless sources only by default — a URL on the
  viewer's own origin or node now, the file, torrent, karaoke and screen
  tiles as they land; YouTube, archive.org and PLAY FROM <host> kept in the
  tree behind `VITE_SSF_CONVENIENCE_LANES=1` (§3.3). PeerTube, when it
  comes, behind the same flag.
- Whether a station runs a library-station node, and who.
- Whether the IPv8 stage-A spike is wanted at all after the library lands.
- The arcade shelf's default contents (homebrew/freeware first). ~~Whether
  the CDN opt-in for emulator files is acceptable for non-sovereign builds.~~
  **Decided 2026‑10‑04:** not offered by default; behind
  `VITE_SSF_CONVENIENCE_LANES=1` with the rest (§9).
