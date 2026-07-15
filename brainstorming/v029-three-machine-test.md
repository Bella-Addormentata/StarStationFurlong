# v0.29.0 — Three-Machine Traffic-Mesh Test Plan

**Goal:** verify the M5.2 multi-hop tick flood, M5.1 liveness/prune, and no-echo-storm
on real hardware — the properties a two-machine test *cannot* prove. Cut for this
test; publish the draft release only after a green run.

Repo copy under test: `prototypes/0.29.0-core-loop-demo/`. Build each node with
`cargo build --release --manifest-path prototypes/0.29.0-core-loop-demo/ssf-p2p-node/Cargo.toml`
(or install the drafted v0.29.0 build on each machine).

## Roles

| Machine | Role | Network | Why |
|---|---|---|---|
| **B** | **Bridge** (the relay in the middle) | **Port 44442 forwarded** (reachable) | Both others can reach B; B is the node that must relay A↔C traffic. |
| **A** | Endpoint | behind NAT / **not** port-forwarded | Reaches B, ideally can't hole-punch C. |
| **C** | Endpoint | behind NAT / **not** port-forwarded | Reaches B, ideally can't hole-punch A. |

The A–B–C **line** (A and C not directly linked) is what proves multi-hop. If A and
C *do* hole-punch each other you get a **triangle** instead — still run it: the triangle
is the echo-storm test (the dedup must stop a tick from circling A→B→C→A forever).

## Setup

1. On each machine, run the node with the debug log on:
   - `SSF_MESH_DEBUG=1` — prints a per-room mesh-state line every 5 s:
     `🕸️ MESH room=<id> peers=[<id4>,…] in_mesh=<n> candidates=<k>`
   - (defaults kept: `SSF_REQUIRE_SIG=warn`, `SSF_IROH_PORT=44442`.)
2. **B** opens the game, creates/enters a room, and **shares its room pass**.
3. **A** pastes the pass and enters. **C** pastes the same pass and enters.
4. In each browser's bridge-status HUD, note which peers each node connected to
   (`dialing → connected` / `failed`).

## Test 1 — Multi-hop movement (the core win)

- Confirm the topology from the `🕸️ MESH` logs / bridge HUD:
  - **Line (ideal):** A shows `peers=[B]`, C shows `peers=[B]`, B shows `peers=[A,C]`.
    A↔C bridge status is `failed` (couldn't punch).
  - **Triangle:** all three show two peers — skip to Test 2, then still do the kill test.
- In the **line** case: **move A's avatar.** On **C's screen, A's avatar must move in
  real time** — even though C's node is *not* linked to A (`peers=[B]`). That movement
  arrived A→B→C: **multi-hop TTL relay proven.** (Before v0.29.0 this was hop-1-capped,
  so C saw nothing.)
- ✅ Pass: C renders A's live movement with only B in C's peer set. ❌ Fail: A's avatar
  is frozen/absent on C.

## Test 2 — No echo storm

- In whatever topology formed (triangle is the stress case), **move all three avatars
  vigorously for ~30 s.**
- ✅ Pass: movement stays smooth; consoles are quiet (no runaway relay spam); CPU/network
  stay normal. ❌ Fail: console flood, rising CPU, or lag — a tick is circling the cycle
  (the dedup gate would be the suspect).

## Test 3 — Liveness + prune (first-ever node liveness)

- **Kill C** (close the app / stop the node). Within ~15 s, **A's and B's consoles log
  `💀 PRUNE peer <Cxxxx>`** and their `🕸️ MESH peers=` drops C.
- **Restart C**, re-enter the room. A/B re-admit it; all three see each other again.
- ✅ Pass: prune within ~15 s, clean rejoin. ❌ Fail: C lingers in `peers=` forever, or a
  transient blip prunes a *still-connected* peer that never comes back (the re-admit path).

## Test 4 — Regression (0.28.1 wins preserved)

- With all three in the room, **B moves furniture / sends chat.** A and C must both see
  it (reliable ysync still floods correctly over the narrowed neighbor set).
- Two tabs on one machine still sync (sibling fan-out intact).

## What to watch in the console

- `🕸️ MESH …` — topology + neighbor/candidate counts (with `SSF_MESH_DEBUG=1`).
- `💀 PRUNE peer …` — a silent peer was dropped (Test 3).
- `🌿 GRAFT dial to candidate …` — the mesh is trying to reach a known peer.
- `📇 Gossip-learned peer … — signed mesh-upgrade dial` — transitive discovery firing.
- **Red flags:** any `🔒 CTRL-DROP` (a control message failed admission — shouldn't happen
  among honest nodes), any `invalid-sig` warn spam, or `GRAFT` spam to the same dead id
  (cooldown should bound it to ~once/60 s).

## Deferred (NOT under test here — need >8 nodes or a later increment)

- M5.5 per-tick authorship (tick lane stays unsigned — spoof resistance is neighbor-trust
  + TTL + dedup).
- M5.4 lazy-pull is opt-in (`SSF_MESH_LAZYPULL=1`); the default deduped flood is what ships.
- Symmetric membership above 8 nodes (graft/prune are not emitted yet), eclipse tier-floor.
