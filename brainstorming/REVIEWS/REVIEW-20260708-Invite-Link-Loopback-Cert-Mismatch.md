# StarStation Furlong - Invite Link Join Failure Review

Created on: 2026-07-08
Status: OPEN
Scope: Cross-machine room join attempts using seed links with v2 payload

## 1. Executive Summary

Cross-machine joining fails because exported invite links are still loopback-oriented and usually hintless:

- wtUrl is set to https://127.0.0.1:4443
- memberHints is absent

This makes the joiner dial itself instead of the remote host. When the seed cert hash does not match the joiner's local node cert hash, handshake fails immediately. When it does match, the join still stays local and does not reach the remote room.

## 2. Evidence Captured On 2026-07-08

### 2.1 Live local node status (joiner machine)

- Process: ssf-node.exe
- UDP listener: 0.0.0.0:4443
- TCP API listener: 127.0.0.1:8080
- Fingerprint API route observed live: GET /api/fingerprint

Code references:
- [prototypes/0.14.0-core-loop-demo/src-tauri/src/wt_listener.rs](prototypes/0.14.0-core-loop-demo/src-tauri/src/wt_listener.rs#L365)
- [prototypes/0.14.0-core-loop-demo/src-tauri/src/wt_listener.rs](prototypes/0.14.0-core-loop-demo/src-tauri/src/wt_listener.rs#L456)
- [prototypes/0.14.0-core-loop-demo/src/main.ts](prototypes/0.14.0-core-loop-demo/src/main.ts#L482)

### 2.2 Remote seed sample (fresh)

Decoded payload:

{
  "v": 2,
  "roomId": "furlong-lobby",
  "roomKeyB64": "bd7V1EQRsFEDoYDVwkH4o_zOKxquvf0At90Tji6pV78",
  "wtUrl": "https://127.0.0.1:4443",
  "certHashesB64": ["SyzeMuk57cd7cQi6poBQ94b88cI8NBZnp0HkP78VqT0="],
  "issuedAt": 1783550255110
}

Observed problems:

- Loopback wtUrl (local-only target)
- No memberHints
- Seed cert hash often differs from the joiner local node cert hash

### 2.3 Cert mismatch example

- Seed cert hash: SyzeMuk57cd7cQi6poBQ94b88cI8NBZnp0HkP78VqT0=
- Live local cert hash from /api/fingerprint: Sg4ANSOgkd03NFOvbuKtDNgEkPz0UPa9J9zprFVrEgM=
- Result: mismatch, so WT handshake fails when joiner dials local 127.0.0.1 with foreign cert pin

## 3. Root Cause

The exported invite format is still centered on local WT loopback rather than remote reachability hints.

In practice:

1. Joiner reads wtUrl = 127.0.0.1 and dials its own node.
2. Seed cert pin belongs to remote host identity, not joiner local identity.
3. Handshake fails if certs differ.
4. If certs happen to match, join remains local because no remote hint lane is present.

## 4. Impact

Severity: HIGH for multiplayer onboarding.

- Cross-machine invite links are not reliably usable.
- Users see failed joins even with fresh links.
- Behavior appears random because cert mismatch depends on which local node identity is currently running.

## 5. Corrective Direction

### 5.1 Invite payload requirements

Include remote reachability hints in every exported invite:

- memberHints.direct: reachable LAN or WAN candidates, not loopback
- memberHints.relay: relay URL hints for CGNAT or filtered networks
- Keep roomKeyB64 as canonical room identity

### 5.2 Export rules

- Do not export loopback-only wtUrl as the primary remote join target.
- Loopback can remain a local diagnostic lane, but not the only lane.

### 5.3 Import rules

- If wtUrl is loopback and no hints exist, mark invite as local-only and show a clear warning.
- Prefer hint ladder on import: direct candidates, then relay candidates.

### 5.4 Acceptance checks

1. Two-machine LAN join succeeds from Copy Invite with zero manual edits.
2. Two-network join succeeds via relay hints when direct is unavailable.
3. Imported invite clearly reports local-only vs remote-join-capable.
4. Cert mismatch diagnostics identify stale or foreign links quickly.

## 6. Suggested Follow-Up Work Items

- Add memberHints population in invite generation path.
- Add remote reachability source for exported direct hints.
- Add relay hint inclusion from configured relay set.
- Add UI warning when invite contains only loopback wtUrl and no memberHints.
- Add automated tests for import classification and cert mismatch messaging.

---

## 7. Review & Live Verification (2026-07-08, code-verified + probed against the running app)

> The symptoms in §1–§4 are accurately captured. The §3 root cause is right at the
> invite-format level but sits on top of **two deeper causes**, both now verified —
> and they change the fix order in §5/§6. Verification method: JS probe executed
> inside the actual running packaged app (`http://tauri.localhost`, the shared
> playtest window) + source inspection of the 0.15.0 line.

### 7.1 Verified cause chain (three layers, outermost first)

1. **The packaged app embeds the iroh-less sidecar — so its invites CANNOT carry
   hints.** The seed in §2.2 has no `irohNodeId`; the standalone `ssf-p2p-node`'s
   fingerprint *always* includes `iroh_node_id` (non-optional field), while the Tauri
   sidecar ([wt_listener.rs](../../prototypes/0.15.0-core-loop-demo/src-tauri/src/wt_listener.rs))
   contains **zero iroh code** — so a hint-less seed is *proof* the host minted it
   against the sidecar. `getLocalNodeHint()` returns `null` without `iroh_node_id`
   ([main.ts ≈L162](../../prototypes/0.15.0-core-loop-demo/src/main.ts#L162)), which
   silently drops `memberHints` — producing exactly the §2.2 payload. **Until the
   sidecar embeds the iroh bridge (or the app ships/spawns the standalone node),
   §5.1's "include hints in every invite" is unimplementable for packaged-app hosts.**
2. **The installed build's CORS allowlist blocks `http://tauri.localhost` — so the
   joiner's always-bridge never runs, causing the §2.3 mismatch.** Live probe from
   inside the running app: `fetch http://127.0.0.1:8080/api/fingerprint` →
   *"blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present"*
   (port 8081: connection refused). With the fingerprint unreachable,
   `fetchDefaultBootstrap()` → `null`, and `resolveBridgeBootstrap()` **passes the
   imported seed through untouched** — the joiner then dials its own `127.0.0.1:4443`
   pinned to the *host's* cert hash → guaranteed TLS failure. This is the observed
   "cert mismatch" — it is not the invite's fault; it is the always-bridge swap
   failing to run. The allowlist fix (loopback-any-port + `tauri.localhost`) landed
   in source 2026-07-08 (`3237cb1`, in the v0.15.0 build) — **the installed app
   predates it; players must update to the v0.15.0 installers once published.**
3. **Invite format (the §3 finding).** Correct, with one design nuance: under the
   §4.4.1 always-bridge design, `wtUrl: 127.0.0.1` in the ticket is *intentional* —
   the loopback lane is the browser→own-node hop, and remote reachability is meant to
   ride `memberHints`. So §5.2 should read "never export a ticket whose ONLY lane is
   loopback" rather than "don't export loopback wtUrl": the fix is guaranteeing
   hints (or an explicit local-only warning, as §5.3 already proposes), not changing
   the wtUrl.

### 7.2 Adjudication of §5 corrective direction

- §5.1 hints-in-every-invite — **correct, but gated on cause #1** (sidecar iroh lane
  or shipping the standalone node with the app). Direct-addr hints additionally need
  the `endpoint.addr().ip_addrs()` fix (landed 2026-07-08) and relay hints need
  `SSF_RELAYS` set (no committed default list yet — known limit in CHANGELOG v0.15.0).
- §5.2 export rules — adopt with the §7.1-3 rewording.
- §5.3 import rules + local-only warning — **adopt as-is**; cheap and immediately
  useful. Classification: `!memberHints?.length && !irohNodeId && classify(wtUrl)
  === 'loopback'` ⇒ "LOCAL-ONLY INVITE — ask your friend to update and re-share".
- §5.4 acceptance — add a fifth check: **joiner-side bridge health** — if the
  fingerprint fetch fails, the UI must say "companion node unreachable (CORS/not
  running)" instead of attempting the foreign-cert loopback dial (turn cause #2's
  silent failure into a diagnostic).

### 7.3 Fix order (supersedes §6 ordering)

1. **Update the installed apps** to the v0.15.0 build (CORS fix) — unblocks the
   joiner-side bridge today; no code change needed.
2. **Embed the iroh bridge in the Tauri sidecar** (or ship/spawn `ssf-p2p-node`
   alongside the app) — the packaged-app hint lane depends on it (tracked in TODO's
   bridge-remainder item; this review makes it the top user-facing blocker).
3. §5.3 import classification + local-only warning + §7.2's bridge-health message.
4. §5.1 hint population then follows automatically from #2 (standalone node already
   mints `irohNodeId` + filtered direct addrs; relay hints appear once `SSF_RELAYS`
   / the community list lands).
5. §6's automated tests, extended with: "seed without irohNodeId ⇒ classified
   local-only", "fingerprint fetch failure ⇒ no foreign-cert loopback dial".

*Review appended 2026-07-08. Evidence: live CORS probe inside the running packaged app
(origin `http://tauri.localhost`; ACAO header absent on 8080, ERR_CONNECTION_REFUSED
on 8081); zero `iroh` matches in the 0.15.0 sidecar; `getLocalNodeHint` null-guard;
`resolveBridgeBootstrap` pass-through on null local bootstrap.*

### 7.4 Correction & re-verification with both machines on v0.15.0 (2026-07-08, later same day)

**Layer 2 (CORS) is RESOLVED and was mis-measured in §7.1-2 — correcting the record.**
Direct probe against the live server with the app's *real* `Origin` header:

```
GET http://127.0.0.1:8080/api/fingerprint   (Origin: http://tauri.localhost)
→ Access-Control-Allow-Origin: http://tauri.localhost
→ Vary: Origin
→ {"hex":"4a0e…","base64":"Sg4ANSOg…","port":4443}
```

The running build IS the fixed v0.15.0. The earlier in-page probe reported "No ACAO
header" because the shared page frame had crashed to `chrome-error://chromewebdata/`
— **its origin was `null`**, which the allowlist correctly rejects. A probe from a
crashed frame is a false negative for any origin-gated behavior; §7.1-2's
"installed build predates the fix" claim is withdrawn for these machines. (Real app
windows, whose origin is `http://tauri.localhost`, pass.)

**Which makes Layer 1 the confirmed, sole remaining blocker — now with process-level
proof.** The fingerprint body above has **no `iroh_node_id` / relay / direct fields**
(the 3-field sidecar shape), and `netstat` shows ONE process (the Tauri app) owning
both TCP 8080 and UDP 4443, with **no standalone `ssf-p2p-node` running**:

```
TCP  127.0.0.1:8080  LISTENING  14748   ← Tauri app (embedded sidecar — no iroh)
UDP  0.0.0.0:4443               14748   ← same process
UDP  …:58890 → 127.0.0.1:4443   15084   ← WebView dialing the sidecar (loopback WT ok)
```

**Failure mode on v0.15.0 is therefore SILENT, not a cert error:** the joiner's
bridge swap now works (fingerprint reachable), so the import dials the joiner's own
sidecar successfully and joins a room with the imported room key — **on the joiner's
own node, with no lane to the host**. Both players sit in identical-looking but
*separate* rooms: "trouble making a connection" with no error anywhere. The §2.3
cert-mismatch symptom belonged to the pre-fix build / crashed-frame states.

**Unblock sequence for playtesting today (no code changes):**

1. Build the **standalone** node from the 0.15.0 line on the HOST machine
   (`cargo build --release` in
   [prototypes/0.15.0-core-loop-demo/ssf-p2p-node](../../prototypes/0.15.0-core-loop-demo/ssf-p2p-node)
   — release profile links under GNU, ≈13 min; no 0.15.0 node binary exists yet).
2. Start the standalone node **before** the game app so it wins ports 4443/8080 —
   the app's WebView then transparently talks to the iroh-capable node (fingerprint
   gains `iroh_node_id` + direct addrs → Copy Invite mints remote-capable tickets).
   Caveat: the app's embedded sidecar will fail its own binds; behavior unverified —
   watch the app logs.
3. Same-LAN test first (direct-addr hints suffice). Cross-internet additionally
   requires `SSF_RELAYS` on both nodes pointing at a real relay — none ships by
   default yet (CHANGELOG v0.15.0 known limit).
4. The durable fix remains §7.3-2: embed the iroh bridge in the sidecar (or ship &
   auto-spawn the standalone node) — the packaged app cannot host remote-capable
   invites until then.

*Correction appended 2026-07-08. Evidence: HttpWebRequest probe with real Origin
header (ACAO + Vary returned; 3-field fingerprint body); netstat PID mapping; crashed
shared-frame origin `null` identified as the earlier probe's confound.*

### 7.5 Long-term fix — no external relays (decision note, 2026-07-08)

Standing question: *"what is the long-term fix without using external relays?"* —
Nothing external was ever required; the architecture's only relay concept is a
**player's own machine with a toggle** ([Cabal plan §4.1.1–4.1.3](REVIEW-20260707-Cabal-DNS-Free-Discovery-Plan.md)).
The durable fix stack, in dependency order:

1. **Bundle the standalone node as a Tauri external binary (sidecar) and retire
   `wt_listener.rs`.** Preferred over porting iroh into the shell: the two-listener
   split is precisely what drifted into this bug, and one node codebase serves the
   desktop app, headless station, and beacon roles alike. The app spawns
   `ssf-p2p-node` on launch; the WebView keeps talking to `127.0.0.1:4443/8080`
   unchanged. (Windows note: ship the release-profile binary — dev-profile GNU
   doesn't link.)
2. **Zero-infrastructure lanes then cover most pairs with no relay at all:** LAN
   direct hints + mDNS (Phase C); cross-internet via iroh's default-enabled
   portmapper (UPnP/NAT-PMP/PCP — either side's cooperating router suffices) or a
   full-cone NAT's keepalive-warmed mapping; deterministic fallback = one member's
   single port-forward.
3. **Residual hostile-NAT-both-sides case: the beacon toggle.** iroh's punch
   coordination needs a reachable rendezvous (physics, §4.1.2) — so any reachable
   player enables the embedded `iroh-relay` server (`server` feature, already in the
   dependency tree): IP-literal URL, self-signed cert via `ca_tls_config`, zero DNS /
   CA / registration / VPS. Invites auto-carry that player's relay hint; the relay
   carries only encrypted punch coordination, then steps aside.
4. **Optional accelerator (off in strict builds):** Mainline-DHT/pkarr lookup keeps
   hints fresh without anyone's server — it addresses staleness, never reachability.

Irreducible limit, stated plainly: all members unreachable + no player beacon ⇒ no
new cross-internet join. The design's job is making that rare (default-on
portmapping) and its escape one checkbox. Tracked: sidecar-bundling supersedes the
"embed iroh in sidecar" wording in TODO's bridge-remainder item.
