# Coin Pusher Plan — issue #135

Owner ask: an arcade "coin pusher" you can drop into a room the same way any
other cabinet-shaped game goes down. Player picks a hole above the machine +
times the drop; a tiny physics engine handles the chip falling, hitting pegs,
landing on the moving floor, interacting with pre-existing chips, friction,
tipping. A chip that falls off the LAST platform pays out to the dropper.
Chips STAY IN THE MACHINE until they physically fall out — the owner has a
manual "open door" to empty. Never auto-siphoned.

The build sits inside the pure-engine-plus-Yjs pattern already carrying slot
machines (`games/slots.ts` + `slotCroupier.ts` + `casinoDoc.ts`) and the
game-table games (`games/gamesDoc.ts`) — an engine module with no DOM/three/Yjs
dependencies, DeviceUI/visual glue in `devices.ts` / `furniture.ts`, and one
sole operator client (the machine's owner) publishing the reduced state.

## Files touched

- **`src/games/coinPusher.ts`** — pure deterministic dt-driven engine. Guards
  (`isCoinPusherState`, `isPusherInsertRequest`, `isPusherEscrow`), seeded
  RNG (FNV-1a 32-bit, high-bit sampled to sidestep LSB bias), constants
  (`CHIP_R=0.030`, `PILE_STEP=0.06`, `PUSHER_PERIOD_MS=2400`,
  `PHYSICS_SUBSTEP_MS=40`, `MAX_STACK_HEIGHT=4`, `HOLE_COUNT=3`,
  `PUSHER_MAX_ANTE=100`), and reducers: `settlePiles`, `insertOnPlatform`,
  `simulatePeg`, `stepMachine`, `advanceSim`, `processInsert`, `emptyMachine`,
  `claimPendingCredit`, `computeConservation`. Two-layer geometry model (upper
  and lower platforms, upper spills forward to lower, lower spills forward to
  the tray = pay-out). Column model per platform: piles are indexed by chip
  column; `MAX_STACK_HEIGHT` bounds tower growth and shoves forward on overflow.
- **`src/games/coinPusher.test.ts`** — 59 vitest cases. Guard tables,
  conservation invariant (`totalInserted == chipsInMachine + totalPaid +
  totalEmptied`) held across long play traces, peg deterministic under fixed
  seed, `emptyMachine` owner-only + zero-effect otherwise, TTL refund path,
  bounded RNG, hostile-value degradation, pusher sweep in-range for all `t`.
- **`src/casinoDoc.ts`** — thin CRDT layer over the room doc: `pusher:<mid>`
  for state (whole-value LWW), `pusher-req:<mid>:<player>` for one queued
  request per player (single-writer-per-key, purged by the operator after
  processing), `pusher-escrow:<mid>:<player>:<requestId>` for the debited
  chips awaiting resolve, `pusher-pending:<mid>:<player>` for the payout
  entries the engine hands over on tip-off. All shape-guarded on read; every
  balance move goes through a single `transact()`. `PUSHER_REQUEST_TTL_MS =
  90_000` bounds refund latency if the operator is offline.
- **`src/devices.ts`** — `createCoinPusherUI()` DeviceUI (three big hole
  buttons, timing slider, ante input, INSERT / CLAIM / OPEN DOOR / OPERATOR
  TOGGLE / REFUND, keyboard shortcuts arrows/space). Operator loop
  (`startCoinPusherOperator` / `tickCoinPusherOperator`) drains the request
  queue via `processInsert`, then `advanceSim` progresses free-running physics
  between inserts. `ensureCoinPusherInitialized` seeds a fresh cabinet's state
  once so the operator can start without demanding the panel be opened.
  `clearPendingCoinPusherPlays` refunds outstanding requests + shuts the loop
  when the cabinet is removed.
- **`src/furniture.ts`** — `buildCoinPusher(ctx)`: plinth + cabinet body +
  marquee (COIN PUSHER canvas display), three drop holes with gold rim
  meshes (`coinPusherControl='hole'` userData for click routing), a two-tier
  playfield (upper platform → lower platform → pay-out tray with glass front
  + side walls), an animated pusher bar, and a chip pool that mirrors the
  engine's `piles` back onto the scene. Registers a `CoinPusherVisualHandle`
  on the upper-platform mesh (setSelectedHole / showMessage / triggerDropFx /
  update) so the panel can drive the cabinet's feedback. `FURNITURE_DEFS
  ["coin-pusher"]` gives it a 1×1 footprint with a `device: {kind:
  "coinPusher", …}` entry so the device-focus pipeline picks it up.
- **`src/world.ts`** — the reconciler mirrors the slot-machine pattern:
  registers/removes `coinPusherVisuals` in scene traversal, calls
  `clearPendingCoinPusherPlays` + `clearCoinPusherKeys` on furniture removal,
  ticks the visual handle each frame, autostarts the operator loop for every
  spawned cabinet the local player owns, and wires the coin-pusher branch
  of `requestDeviceFocus` (`createCoinPusherUI` + visual callbacks).
- **`src/devMenu.ts`** — 🪙 COIN PUSHER label; the item picks up the
  spawnable list automatically off `FURNITURE_DEFS`.
- **`CHANGELOG.md`** — Unreleased bullet.
- **`TODO.md`** — dated Done entry.

## Authority + trust model (single-authority per cabinet)

- **Owner as sole operator.** Whoever first opens the panel on a machine that
  has no state seeds `initialCoinPusherState(myId, now)`; their id is
  latched into `state.ownerId`. Their client is thereafter the only one that
  publishes new engine state (mirrors the slot-machine "elected croupier"
  pattern). Non-owner clients read state read-only and submit insert requests
  via the queue key.
- **Owner absence is bounded.** Insert-request records carry `requestedAt`;
  the pure engine reads a wall-clock `nowMs` and any client can call
  `refundExpiredCoinPusherRequest(...)` after `PUSHER_REQUEST_TTL_MS`. The
  player's own client is entitled to refund their OWN outstanding request
  regardless of who is offline (single-writer-per-key holds: the request
  record belongs to the player and no one else writes it).
- **Payouts atomic.** When physics tips a chip off the lower platform,
  the reducer appends to `state.pendingCredit[player]`. The player's own
  client calls `claimCoinPusherPayout(machineId, nextState, playerId, amount)`
  which does the credit + state-write in one `transact()` — the pattern the
  slot machine uses for its own settle.
- **Empty is owner-only.** `emptyMachine(state, callerId)` returns the same
  state unchanged when `callerId !== state.ownerId`. `commitCoinPusherEmpty`
  in `casinoDoc.ts` re-checks ownerId before writing.
- **Deserialization boundary.** Every read call uses the shape guards; a
  hostile peer that scribbles garbage into a coin-pusher key is dropped at
  the seam. Same discipline as the treasury policy fields.

## Conservation invariant

At every reduce step the pure engine maintains:

```
totalInserted = chipsInMachine + totalPaid + totalEmptied
```

Where `chipsInMachine` sums the two platform piles + the pusher-column strip;
`totalPaid` is the chips already credited to players; `totalEmptied` is the
amount the owner has removed via OPEN DOOR. `computeConservation` returns the
delta so the DeviceUI can display "OK / OFF-BY N" and the tests can assert
zero drift across long random traces.

## Physics model — honest limits

- Discrete substep `PHYSICS_SUBSTEP_MS = 40ms`. Each substep advances the
  pusher, then processes any pending chip drops with `simulatePeg` (five peg
  rows, deterministic left/right per seeded FNV bit), then calls
  `stepMachine` which:
  1. Slides the pusher bar forward/back by its cosine phase.
  2. If the pusher's front face has passed a column's chip stack, spills
     the topmost chip forward (upper→lower or lower→tray = pay-out).
  3. Runs a `settlePiles` pass — a chip landing on a peg pile that's already
     at `MAX_STACK_HEIGHT` cascades one column forward.
  4. Resolves per-frame contact impulses (a fresh drop nudges the column it
     lands on; if that column is full, the shove propagates forward).
- **What we deliberately don't model:** rotation (chips are treated as
  flat discs settling on their pile column, not tumbling), lateral wobble
  (a chip lands in the column its `x` maps to and stays there until it's
  spilled forward), non-integer chip fractions (all values are chip counts).
  These simplifications keep the engine deterministic and cheap enough to
  publish at 4 Hz without eating room-doc bandwidth.
- **Peg deflection RNG bias.** `simulatePeg` hashes `hashInts(seed,
  chipId, rowIndex)` and samples the high bit (`h >>> 24) & 1`) instead of
  the LSB — FNV-1a's low bit shows measurable non-uniformity on small
  inputs. Tests cover both bits' distribution across many seeds.

## Data-flow at insert

1. Player clicks INSERT → `requestCoinPusherInsert(machineId, hole, timing,
   ante)` reads `chipsForPlayer(myId)`, refuses if short, else
   `submitCoinPusherInsert()` does ONE `transact()`:
   - Debits `chips:<myId>` by `ante`.
   - Writes `pusher-req:<mid>:<myId>` with the request record.
   - Writes `pusher-escrow:<mid>:<myId>:<requestId>` = `ante` for
     later refund on TTL.
2. Owner's operator tick reads all queued requests (sorted by
   `requestedAt`), calls `processInsert(state, ..., seed = timestamp ^
   requestedAt)` on the pure engine — the returned state has the chip
   dropped and `state.totalInserted += ante`.
3. Operator's `writeCoinPusherState()` publishes new state; the operator's
   `clearCoinPusherInsert()` removes the request + escrow record.
4. Every peer sees the state change via `subscribeCasinoKey('pusher:<mid>')`
   and the visual handle mirrors the piles.
5. When a chip tips off the lower platform, the reducer credits
   `state.pendingCredit[player]` (an object keyed by player id). Any client
   whose id has a positive credit calls `claimCoinPusherPayout` — atomic
   `chips:<player> += credit; state.pendingCredit[player] = 0`.
6. Owner clicks OPEN DOOR → `commitCoinPusherEmpty(machineId, nextState,
   ownerId, emptied)` — atomic `chips:<ownerId> += emptied; state cleared`.

## What still isn't done here

- No robot at the cabinet (the slot machine has no dealer either — a
  coin pusher plays without one). If we later want an idle-robot pose, add
  it as a separate PR against the robot routine module.
- No leaderboard / high-score across cabinets. State is per-machine.
- No hostile-owner protection beyond conservation display — the owner
  is the operator, so a griefer can withhold physics ticks by not opening
  the panel. Autostart from `updateCroupier` mitigates in practice (the
  loop starts as soon as the owner is in the room and hits it 4x/second),
  and the TTL refund covers the "owner disappears mid-play" case.
- Physics doesn't model chip-on-chip spin or angled slopes. If we ever want
  the visual sag of a leaning stack, that's a rendering polish separate
  from the deterministic reducer.
