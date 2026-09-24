# Implementation Plan — Issue #163 "New vestibule type — two part docking adapter"

*Star Station Furlong — a door can wear one half of a round docking adapter; two halves mate into a
dock; a dock can be released (UNDOCK, the module is free to fly away) and made again (DOCK) from the
door's control panel or from the helm.*

Target: `prototypes/0.29.0-core-loop-demo/src/` (the `RELEASE_FRONTEND` line, v0.36.x). Companions:
[spaceship-conversion-plan.md](spaceship-conversion-plan.md) (#30 — "module = room = doc", the helm,
the accepted one-sided undock this plan improves on) and
[module-transform-docking-adapters-plan.md](module-transform-docking-adapters-plan.md) (the original
vestibule + adapter design).

---

## 0. What the issue asks, and what already exists

| # | Ask (issue #163) | Ground truth on `main` |
|---|---|---|
| A | A new vestibule: a dedicated door connection point for **temporary** docking, typically ship ↔ station | `#67 D2` shipped half of this: `doorPolicy[door].adapter` ("a Docking Adapter is INSTALLED at this door") lets anyone berth a ship there as a `transient` pairing. But the berth renders as the ordinary rectangular gangway, and the adapter itself is only drawn from space (an IDA collar in `exteriorView.ts`). |
| B | **Both** doors of the connection carry **one part** of the adapter | Nothing models the far half. A transient berth is a plain pairing record. |
| C | DOCK / UNDOCK on the **flight-control furniture** (the helm); a small screen that shows the **ship atlas** when there are several docks to choose from, a plain button when there is one | The helm (`#30 SH1`) is a status-only checklist that says *"Undocking and flight arrive with the flight update"*. |
| D | DOCK / UNDOCK in the **door's control panel** too | The panel has a transient-berth `⏏ DETACH` (plain delete, everyone) and an owner `⏏ UNDOCK` for permanent modules (tombstone). Both hidden in the collapsed policy section, both one-sided. |
| E | Docking-adapter vestibules are **round**, so they are easy to recognise | All vestibules/connectors are rectangular ring frames. |
| F | In door editing mode, a new **vestibule option "dock"** adds one side; add **another** for the other side, then a **new module** → a new independent ship/station | The CONNECTION ASSEMBLY strip offers `+FLEX` `+EXT` `CLEAR`; `PROVISION NEW MODULE` mints a module at the chain's end. |

Architecture facts that bind the design:

1. **One room doc at a time.** Each side of a connection keeps its own record in its own room's
   `doors` map; the far record is written lazily by the first walk-through (the *mirror*). So every
   existing undock is one-sided, and the spaceship plan (§5.1) explicitly *accepted* a stale
   station-side berth after a ship leaves.
2. **Chains drive every pose and every renderer.** `segments` on a pairing record feed
   `foldChainEnd`/`projectionPoseFromWall` (gray-box projection, `atlasLayout`, overlap gates,
   hull chain occupancy, the jetbridge solver) and `buildConnectorChain` (room view, the exterior's
   neighbour links, the first-person neighbour shells). A new *segment kind* therefore reaches every
   one of them without touching the call sites.
3. **Policy survives unpair; pairing records do not.** `doorPolicy` was deliberately kept off
   `DoorRecord` for exactly this reason, which makes it the right home for a *fitting* that must
   outlive the connection.
4. **Background sessions to another room exist.** `roomPasses.ts` (prefetch) and
   `directMessages.ts` open their own `NetworkProvider` + `YjsSync` against the local node.

---

## 1. Vocabulary (one meaning each, everywhere)

- **Dock port** — one half of a docking adapter, fitted to a door. Stored as the existing
  `doorPolicy[doorId].adapter === true` (shared room truth; outlives any connection).
- **Dock** — a connection made of **two halves**, one per door: a pairing record whose chain is
  exactly two `dock` segments (`DOCK_CHAIN`), always `transient: true`.
- **Undocked port** — a port whose door record is a *dock tombstone*: it remembers its last berth
  (far address, far door, wall, lateral) so DOCK can re-make the connection.

## 2. Data model (additive on the wire)

1. `ConnectorSegment.kind` gains **`'dock'`** (no parameters): a straight, round half-adapter of
   `DOCK_HALF_LEN` = 1.2 m. `DOCK_CHAIN = [dock, dock]` folds to 0.3 + 2 × 1.2 + 0.3 = **3.0 m** —
   the same door-to-module gap as the classic vestibule, so a dock sits where a gangway would.
2. `DoorPairing.dockedAt?` — when the dock was made (writer clock). Docks only.
3. `DoorTombstone.dock?` — `{ farDoor?, farWall?, farLateral?, undockedAt }`, the berth memory.
4. Sanitizers accept exactly these shapes (`doorsDoc`, the bundled-atlas parser); unknown kinds still
   drop the whole chain. Parts: a `dock` segment costs an **ADAPTER** part (prefill / consume /
   refund). `mirrorSegments` keeps dock segments as dock.
5. **Old clients** drop the unknown segment kind and draw a straight gangway at the classic offset
   (render-not-corrupt); they ignore the new optional fields. (Dev-build posture: no backwards
   compatibility is promised anyway.)

## 3. Rules (the invariants — say them every time)

1. **A dock needs a port on both doors.** The near port is fitted first; the second `+DOCK` stages
   the *mating half* the connection brings to the far door; a dock arrival fits the arrival door with
   its port (the mirror), so both sides always end up with one.
2. **A port door connects only by docking.** `+FLEX`/`+EXT` are refused on a port door, `+DOCK` is
   refused while a gangway chain is staged or a non-dock connection is live. INITIATE at a port door
   always publishes a dock — even without a staged mating half (the guest-berth path: the visiting
   ship brings its own half).
3. **UNDOCK leaves a tombstone with memory, never a plain delete** — so the lazy mirror cannot quietly
   re-pair it. A re-dock overrides a dock tombstone only when it is *newer*
   (`dockedAt > undockedAt`); an older record walking in is a stale berth and is refused. Every stamp
   is *causal* (`stampAfter`): the local clock, or one past the stamp it replaces when this client's
   clock trails the one that wrote it — so clock skew can never make an undock look older than its
   dock, or a re-dock older than its undock.
4. **Both ends, best effort.** UNDOCK writes the near tombstone at once, then opens a short
   background session to the far room and writes its end. DOCK asks the far berth *first* (so a
   refused dock never flickers into existence), then writes the near side — only over the very
   tombstone it read; if a peer changed the port meanwhile, the far write is taken back (an undock
   that undoes only the dock carrying our stamp). Every far write is compare-and-swap: only if the far
   record still describes *this* connection — our room **and our door**; a record naming another of
   our doors is that other connection's end (UNDOCK), or the berth is free/ours (DOCK). Unreachable →
   the near side stands, and the far side heals on the next walk-through (re-dock rule) or by its
   own UNDOCK.
5. **Who may dock/undock:** whoever may *build* at that door (`canConstruct`: the owner, a venture
   shareholder, or a door whose construction policy is public/granted) — on the panel and at the helm
   alike (the helm operates a specific port door, so it asks that door). Legacy transient berths
   without a dock chain keep today's everyone-`⏏ DETACH`.
6. **Removing a port closes the berth**: allowed only while undocked; it rewrites a dock tombstone as
   a plain one (memory dropped) in the same transaction as the policy flag, and a far DOCK refuses
   any tombstoned door without a port — so no one can re-dock into, or re-fit, a port its owner took
   off.

## 4. Rendering — round, recognisable, one representation

- `adapter.ts`: `buildDockHalf({ sealed })` in the language of the existing IDA collar (white
  soft-goods shell, black capture latches, silver guide rings, blue truss struts, an amber-rimmed
  hatch when sealed) plus the usual `vestibuleGlow` deck strips so the airlock light states still work.
  `buildConnectorChain` dispatches a dock chain to it — every renderer draws round docks with **zero
  call-site changes**.
- `buildDockPortStub(doorId)` — a lone sealed half. `world.updatePairedVestibules` builds it for an
  **unpaired port door** (keyed so it rebuilds on dock/undock), with the same proximity fade and
  zoom rules as every vestibule.
- The exterior-only IDA collar block is retired: the stub/tunnel now carries that look into every
  view (room, first person, space), so a port has exactly one representation.
- Hull occupancy: a lone port stub reserves its exterior space like a chain does.

## 5. The door panel ("door editing mode")

- **CONNECTION ASSEMBLY** gains `+DOCK`:
  - no port → *fit this door's port* (writes `adapter`, consumes an ADAPTER part);
  - port, unpaired, nothing staged → *stage the mating half* (`segments = DOCK_CHAIN`, consumes a
    part) → the ghost shows the round tunnel and the NEW MODULE ghost sits at its end;
  - chips: `⚓ PORT` (✕ removes the port — refund; refused while docked) and `⚓ MATING HALF`
    (✕ unstages — refund).
- **PROVISION NEW MODULE** with a staged dock: the module is born with its door wearing the other half
  (fitted at its first claim), and the connection is a dock → "a new independent ship or station".
- A **DOCK row** at the top of the pane (not hidden in the collapsed policy section):
  `⚓ DOCKED → <name>  [⏏ UNDOCK]` · `⚓ UNDOCKED · last berth <name>  [⚓ DOCK]` ·
  `⚓ DOCK PORT · free — +DOCK stages the mating half, or pick a target and INITIATE`.
- The old install row in the policy section is removed (the port moved to the assembly).

## 6. The helm — a docking computer with a ship atlas

- `createHelmUI(deps)` gains a **DOCKING COMPUTER** screen:
  - **no port** → how to fit one;
  - **one port** → just the plain `⚓ DOCK` / `⏏ UNDOCK` button and a status line;
  - **several ports** → the **ship atlas**: a top-down canvas of this module with every port as a
    numbered round marker (green docked · amber undocked with a berth on record · cyan free) and each
    docked partner module drawn at its atlas pose; click a marker (or its row) to choose, then one
    DOCK/UNDOCK button acts on the choice.
- A DOCKING line joins the checklist; the copy stops promising undocking "with the flight update":
  UNDOCK releases the module — it is free to fly away; *flight itself* is still SH3.
- A small secondary screen on the helm console model, so the docking computer exists in the world.

## 7. Two-sided writes — `farDoorWrite.ts`

`writeFarDock(request, near)` — the roomPasses prefetch pattern: its own `NetworkProvider` + `YjsSync`
on the local node → wait until the far replica is populated (read-before-write, so the write is
causally after the record it replaces and wins; for a room hosted *elsewhere* only a fresh, verified
frame from its live host counts — the local node may hold a stale cached copy) → one `transact`,
deciding on the named door read directly (never through the 64-record snapshot cap) →
`YjsSync.confirmOwnWrites()` (new: flushes the signed sends in flight — `stop()` alone can drop them —
then a SyncStep1 with the pre-write state vector; the node's answer holds our structs only once it
applied them) → for a DOCK, a settle window for concurrent claims on the same berth, after which only
the claim the CRDT kept has docked (a DOCK is not a lock) → teardown. Serialized per far room; bounded
by timeouts. A claim that arrives only after the settle window is the residual no client can close
alone: exactly-once arbitration needs an authority for the berth (the room host). The decisions are
pure (`dockRules.ts`, unit-tested):

- **UNDOCK far patch:** the far door's record is paired to us — our room, and our door or none named
  — and is not a newer dock (a take-back also requires our exact stamp) → dock tombstone naming us,
  with our door as its memory.
- **DOCK far patch:** far door exists; its record is absent / a tombstone on a port / paired to us
  through this door → dock pairing to us (+ its port when the door never had a connection); paired
  elsewhere, or to another of our doors → *occupied*; a plain tombstone naming us, or any tombstone
  on a door without a port → *closed*.

Our own address for the far record: pass → minted-module ledger → mint (the transit's ladder,
factored out).

## 8. Mirror changes (`transitTo`)

- The *retired* check compares **room ids**, not seed strings (two different passes to the same module
  used to slip past a tombstone).
- A dock departure newer than the arrival door's dock tombstone re-pairs it (a deliberate re-dock);
  an older one is refused (a stale berth).
- A dock arrival fits the arrival door with its port if it has none, and the mirror carries `dockedAt`.

## 9. Slices (one PR, reviewable in this order)

1. **Data + rules** — segment kind, record fields, sanitizers, parts, mirror math, `dockRules.ts`
   (+ tests).
2. **Visuals** — dock half / tunnel / stub, world stub rendering, retire the exterior collar,
   occupancy.
3. **Door panel** — `+DOCK`, chips, gating, INITIATE-as-dock, provisioning with a port, DOCK row.
4. **Helm** — docking computer, ship atlas, copy, console screen.
5. **Two-sided** — `farDoorWrite.ts`, `YjsSync.flush`, mirror rules, main.ts wiring.

## 10. Honest limits (deferred by name)

- **Flight is still SH3.** Undocked means *detached*: the station stops drawing the module and the
  module stands alone; nothing travels yet.
- **Docking somewhere new** uses the door panel (target + INITIATE); DOCK on the panel/helm re-docks
  the remembered berth. The atlas only learns *paired* doors, so free ports on other modules are not
  listed anywhere yet — the arrival chooser still lands the walk-in.
- **The ship atlas** shows ports of the module you stand in, plus docked partners. Ports on other
  modules of a multi-module ship are operated from that module.
- **The far write needs the far room reachable** through the local node; otherwise the near side
  stands alone until the far side heals (walk-through) or undocks itself.
- **Trust** is honest-client, as everywhere (#67 D3 signed door records).
