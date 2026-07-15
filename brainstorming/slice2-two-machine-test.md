# Slice 2 — two-machine acceptance test (verify-before-apply)

Proves the node-side sign/verify seam end-to-end across two real machines. Line
under test: `prototypes/0.28.0-core-loop-demo/` on branch `feat/28-node-mesh`.

## What we're proving
1. **Legit signed traffic flows.** Peer A's signed ysync state (chat, furniture,
   room name, players) syncs to peer B and back — i.e. real signatures VERIFY
   across the internet, not just locally.
2. **Zero false drops (the metric that authorizes `reject`).** With
   `SSF_REQUIRE_SIG=warn` (the default), neither node logs an `invalid-sig`
   line for legitimate traffic. This is the gate the design requires before
   anyone flips to `reject`.
3. **Forged state is dropped under `reject`.** With one node in
   `SSF_REQUIRE_SIG=reject`, a tampered envelope is dropped node-side (logged
   `🔒 reject: DROPPED invalid-sig`) and never reaches the peer; legit traffic
   is unaffected.

## Setup (both machines)
```
git fetch && git checkout feat/28-node-mesh && git pull
cd prototypes/0.28.0-core-loop-demo
npm install
cargo build --release --manifest-path ssf-p2p-node/Cargo.toml   # release only — debug link fails on MinGW
```
Run the node (each machine), then the frontend (`npm run dev`) in a browser.
The node prints its mode at startup: `🔒 SSF_REQUIRE_SIG mode: Warn`.

## Test 1 — legit signed sync (default warn)
1. **Machine A:** start the node (default = warn), open the app, enter a room,
   ACCESS → GENERATE PASS, copy it.
2. **Machine B:** start the node (default = warn), open the app, ACCESS → paste
   the pass → ADD PASS, enter once it reads READY.
3. Edit the room name / move furniture / send chat on A → it appears on B, and
   vice-versa.
4. **Check both node consoles:** there must be **NO** `🔎 warn: invalid-sig`
   lines during normal play. (A one-off at the very first frame from a
   pre-Slice-2 client would be the only acceptable exception — there are none
   here.) → **acceptance 1 + 2**.

## Test 2 — reject drops only forged state
1. Restart **Machine B's** node with `SSF_REQUIRE_SIG=reject`
   (PowerShell: `$env:SSF_REQUIRE_SIG='reject'; .\...\ssf-p2p-node.exe`).
   Startup prints `🔒 SSF_REQUIRE_SIG mode: Reject`.
2. Repeat the room join + edits. Legit sync must STILL work (valid sigs pass
   reject) — B sees A's edits and vice-versa. No `DROPPED` lines for real traffic.
3. **Forge check (pick one):**
   - *Simple:* on Machine B's browser console, corrupt an outbound envelope's
     payload after signing — or run an old (pre-Slice-2, e.g. 0.27.0) client as
     a third peer and confirm its UNSIGNED frames still merge (legacy allowed)
     while a *tampered-signed* frame is dropped. The node logs
     `🔒 reject: DROPPED invalid-sig ysync (room …, path iroh-in)` and the tampered
     state never appears on the peer. → **acceptance 3**.

## Notes / expected honest limits
- The **browser** already drops signed-but-invalid inbound before `Y.applyUpdate`
  (verified single-machine); this test adds the **node** enforcement + the
  cross-machine signature verification that a single box can't exercise (two
  nodes can't share the pinned ports 4443/8080/44442).
- **Unsigned = legacy = always allowed**, in every mode — only a *present-but-
  invalid* signature is dropped under `reject`, so old clients never break.
- The node's own SyncStep2 is unsigned (it holds no identity key) and is always
  applied — the trust boundary is your own local node.
- Ticks (movement) are a separate unsigned datagram lane — out of scope for
  Slice 2 (per-tick auth is M5.5).
- Keep the default `warn` in released builds; the owner flips `reject` once this
  test is green on the fleet.
