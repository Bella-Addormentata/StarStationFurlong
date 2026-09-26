# Coin Pusher Plan — issue #135

Owner ask: an arcade "coin pusher" you can drop into a room the same way any
other cabinet-shaped game goes down. Player picks a hole above the machine +
times the drop; a tiny physics engine handles the chip falling, hitting pegs,
landing on the moving floor, interacting with pre-existing chips, friction,
tipping. A chip that falls off the LAST platform pays out to the dropper.
Chips STAY IN THE MACHINE until they physically fall out — the owner has a
manual "open door" to empty. Never auto-siphoned.

The build follows the slot machine on main: a pure engine
(`games/coinPusher.ts`, like `games/slots.ts`), money and records in
`casinoDoc.ts`, a lease-elected operator (`pusherCroupier.ts`, like
`slotCroupier.ts`), and the panel and cabinet in `devices.ts` /
`furniture.ts`.

## Files touched

- **`src/games/coinPusher.ts`** — the pure, deterministic engine (no Yjs /
  DOM / three / clock / `Math.random`). Guards (`isCoinPusherState` with an
  aggregate `MACHINE_MAX_CHIPS` cap, `isPusherInsertRequest`,
  `isPusherEmptyRequest`, `normalizeCoinPusherState`), the physics
  (`settlePiles`, `insertOnPlatform`, `simulatePeg`, `stepMachine`,
  `advanceSim`), and the reducers the operator runs: `resolveDropTiming`,
  `processInsert` (one chip per drop), `emptyMachine`, `computeConservation`.
- **`src/casinoDoc.ts`** — the machine's records and every chip movement (see
  *Money and authority*).
- **`src/pusherCroupier.ts`** — the operator: election, ownership, and the
  settle / refuse / empty work.
- **`src/devices.ts`** — `createCoinPusherUI()`: a live pusher gauge, three
  hole buttons, DROP ONE CHIP, the player's chips as a physical rack and their
  last drop's payout as a tray (the casino's physical-chip rule), and the
  owner's OPEN THE DOOR. Keyboard: ← / → pick a hole, Space drops.
- **`src/furniture.ts`** — `buildCoinPusher(ctx)`: cabinet, marquee (shows the
  panel's short messages), three holes, the two platforms, the pusher bar and
  a chip pool, all drawn as the engine's cross-section (below). Registers a
  `CoinPusherVisualHandle` on the upper platform. The handle's `dispose()`
  frees the chip geometry and both chip materials: they exist before any chip
  is drawn, and a chip mesh holds only one of the two, so a traversal of the
  cabinet can't reach them all.
- **`src/world.ts`** — files the visual handle, ticks the operator election
  for every cabinet, opens the panel on focus, and closes the machine when the
  cabinet is removed (calling the handle's `dispose()` before its own
  traversal frees the rest).
- **`src/furnitureHandles.ts`** — the `coinPusherVisual` handle kind in the
  shared registration list.
- **`src/devMenu.ts`** — 🪙 COIN PUSHER spawn label.
- Tests: `games/coinPusher.test.ts` (engine), `casinoDoc.test.ts` (records
  and money, including a two-doc merge), `pusherCroupier.test.ts` (operator),
  `coinPusherCabinet.test.ts` (removing a cabinet frees everything it made,
  each once).

## Physics model — a 1-D cross-section

The engine models ONE back-to-front axis. Every pile of chips has a single
position `x`; there is no side-to-side coordinate and no side drain. The
three holes differ only in where along that axis a chip enters. Upper
platform `x ∈ [0, 0.60]`, lower platform `x ∈ [0.60, 1.20]`; a chip pushed
past `1.20` falls into the tray and is paid out.

- The pusher sweeps the upper platform on a cosine (period 2.4 s). Only its
  forward stroke pushes; it never drags chips back.
- A drop falls through five peg rows (a seeded left/right hash per row),
  lands on the upper platform, stacks (at most `MAX_STACK_HEIGHT` per column,
  the excess spills forward) and nudges the contact chain ahead of it. The
  same column cap holds wherever chips land, on a stack or on open floor (a
  pile falling off the upper front onto an empty stretch of the lower
  platform spills too).
- After every drop the engine runs one full pusher cycle. Each substep uses
  the pusher's true furthest reach within it, so that cycle compresses the
  piles all the way: **the machine is at rest between drops**, and the
  operator never runs physics on its own. Nothing leaves the machine except
  through a drop or the owner's door.
- The cabinet draws exactly this cross-section: the holes sit in a
  back-to-front row at the engine's hole positions, every pile is drawn on the
  centre line at its engine position, and the bar's front face follows
  `pusherFaceX`.
- Honest limits: no rotation, no side-to-side wobble, no lateral outcomes. A
  2-D playfield would be a new engine, not a tweak to this one.
- Measured: the machine fills to a steady ~41 chips, after which a drop
  returns about one chip on average (87% of drops pay 1, 7% pay 0, 6% pay 2,
  rarely 3–4). There is no built-in house edge; the owner's take is what sits
  inside when they open the door. `MACHINE_MAX_CHIPS = 128` is headroom that
  honest play does not reach.

## Timing

The pusher is a free-running clock: `(pusherPhase, pusherAtMs)` anchor it when
the machine is created and drops never move it, so every client draws the same
pusher from its own wall clock (`currentPusherPhase`). When the player presses
DROP, the panel records in the request the phase on their screen and the time
they pressed it (`requestedAt`, their clock).

The operator reaches the request a little later. `resolveDropTiming` keeps the
player's phase when that phase is the pusher's phase at `requestedAt` (so the
claim names one moment, not a phase that comes round every cycle) and the
operator's clock is at most `MAX_DROP_LAG_MS` (1 s) past `requestedAt`, or at
most `MAX_DROP_LEAD_MS` (250 ms) before it (a player clock running a little
fast). Comparing phases alone would take a request one or more whole cycles
old for a fresh one. Anything else drops at the operator's current phase, so a
claim outside the window gains nothing. The result says which happened
(`lastDrop.honored`), and the panel tells the player. Every timestamp a
record carries must lie in the Date range (±8.64e15 ms, `MAX_TIMESTAMP_MS`):
the guards refuse a peer-written one outside it, so the phase arithmetic
between any two stays finite. The operator ages a request on its own clock,
from when it first saw it (`PUSHER_STALE_REQUEST_MS`, the tail of a flood),
never by `requestedAt`. Browser clocks aren't
synchronised: a device whose clock is off by more than the window never has
its timing kept (it still plays, dropping where the pusher is), and the panel
says the drop was late or the device's clock is off.

The peg-field seed is drawn by the operator from `crypto.getRandomValues`
when it settles the drop, so the player can neither choose nor predict it.

## Money and authority

Records in the room's `casino` map:

| Key | Written by | Holds |
|---|---|---|
| `pusher:<mid>` | the operator only | the machine (`CoinPusherState`) |
| `pusher-req:<mid>:<pid>` | the player (own key) | hole + the phase they saw — **no chips** |
| `pusher-result:<mid>:<pid>` | the operator | its answer to that player's latest request |
| `pusher-empty:<mid>` | the owner | a door request |
| `pusher-door:<mid>` | the operator | its answer to the latest door request |
| `pusher-operator` | the operator | the room's lease, one for every cabinet |

In the per-player keys each id is escaped (`%` → `%25`, `:` → `%3A`), so a
key splits one way only: `(a, b:p)` and `(a:b, p)` are different keys, and
no machine's keys begin with another machine's prefix. Ordinary ids (the UUID
player ids, `<kind>-<n>` item ids) are written as they are.

- **Election.** Only the room's deed holder operates (`canRunCroupier`, the
  rule every casino operator follows since #141/#142), and only one of their
  browser sessions, for every coin pusher in the room: the room's lease is
  written, the session waits 2 s for the doc to converge, renews every 3 s,
  and lapses after 8 s. One operator for the room, not one per cabinet: a
  player's `bal:` is a whole value, so two sessions settling that player's
  drops on two cabinets at once would each write it, and the merge would keep
  only one of the two writes (a chip dropped for free). World ticks the room
  every frame (`tickCoinPusherRoom`), so there is no start/stop control, and a
  session whose room has no cabinet left lets the lease go. Devices' clocks
  aren't synchronised, so a lease written on another device is never judged by
  the expiry it claims: it lapses one lease term (8 s) after this session last
  saw it renewed (the operator rewrites it at every renewal). Only a tab on
  the same device, which shares the clock, is also held to its own expiry.
  Every client watches the renewals (World ticks the room on every client),
  and that is also how the panel tells whether the machines are operated. Its
  DROP waits (STARTING UP) until the operator is past its 2 s settling wait:
  its own, or for another session 2 s after this client first saw that holder
  take the lease, which is never sooner than the holder's own. Each take
  writes a fresh tenure into the record (its renewals keep it), so a release
  and retake that a client never saw still restarts that wait. A drop made
  sooner would reach the operator too late to keep its timing. The lease
  record is peer-writable, so a record claiming a far-future expiry holds the
  room for one term, not forever. "Last saw it renewed" counts in the bound
  room's doc only, so an identical record seen earlier in another room isn't
  cut short.
- **Splits.** A Y.Map lease is not a mutex. Two operator sessions cut off from
  each other could each settle a drop from the same machine; when the docs
  merge only one machine value survives while both players' balance writes do.
  Settling can't be made partition-safe without an authoritative ledger (the
  Registry-anchored chips), and reconciling afterwards from receipts would
  only move the problem (a forged receipt would pay its writer). So the rule
  is to never start a second operator while the first may only be cut off:
  another *device* takes over a lapsed lease only after a further 60 s (only
  the deed holder operates, so another device's lease is the deed holder's
  own, whatever player id it names: an install that restored their identity
  key has its own); tabs on one device share its local node and take over as
  soon as the lease lapses; a session that stops operating releases its lease,
  including when it leaves the room (before the room's doc goes, the release
  sent first) and when the page closes. A session that finds its own lease
  lapsed (a tab that got no frames for a while) clears the record at once and
  takes the lease afresh on the next frame, so a page leaving in between
  leaves no record of its own for a successor to wait out. While it leaves the
  room, it operates and watches nothing more in that room, so no frame takes a
  lease back as the release goes out, and the room's lease observation,
  pending teardowns and sweeps go with it. Only a split outlasting that window
  can still put two operators in one room.
- **Ownership.** The operator creates a missing machine with itself as owner,
  and re-owns one owned by anyone else (a deed transfer, or a peer-written
  owner). The chips inside stay put and go with the room, like its furniture.
  Nothing is paid on a takeover, so a forged owner earns nothing.
- **A drop.** The player's request is a wish, not a payment. The operator
  refuses it (answers the player, clears the request, moves nothing and leaves
  the machine alone) when it is more than 2 minutes old, the player has no
  chip, or the machine is full. Otherwise `processInsert` runs, and
  `settleCoinPusherInsert` debits the one chip, credits exactly what the drop
  paid, publishes the machine, answers the player and clears the request in
  **one transaction**. Before writing, it re-reads the stored machine and
  refuses if it is not the state the drop was computed from, if the request
  is gone or replaced, or if the transition is not a one-chip drop whose
  payout (`totalPaid` delta) matches `lastDrop.paid`. The credit is read off
  that transition; it is never a separate argument. Each poll works through
  at most 4 requests (oldest first), so a flood of requests can't stall the
  operator's frame. It reads them from an index of the requests by machine.
  The index is built by one pass when the casino map is bound (a join, where
  the doc is usually still empty) and then kept current by an observer, from
  the keys each transaction changed. No poll, not even a machine's first,
  walks the map, and a read looks at no more than 64 requests (in arrival
  order), so a poll costs the same however many keys peers write. A request
  is filed only under the machine and player its key names, and only if the
  request's own player is that player. The same index files every per-player
  key (`pusher-req:`, `pusher-result:`, `pusher-esc:`) under the one machine
  it names, so a removal finds a machine's keys, and no other machine's,
  without walking the map either. A key that isn't its ids escaped exactly
  once names no machine, and nothing reads it.
- **Answers.** Each player's answer lives under their own
  `pusher-result:<mid>:<pid>` until their next request is answered. The
  machine's `lastDrop` (the settle's check on the payout) and `recentDrops`
  (the holes of the last 8 drops, which light the cabinet) move on with the
  next player's drop, so a panel that missed updates would misread them. A
  panel that withdraws an unanswered request keeps watching for an answer
  that raced the withdrawal.
- **Nothing to claim, nothing to refund.** There is no escrow and no pending
  credit. A cancelled or withdrawn request costs nothing (the panel withdraws
  its own after 15 s without an answer, and when the player walks away), so no
  peer-written record is ever taken as proof that chips moved. A request left
  behind by a tab that closed before any operator answered it is still a
  request: an operator that sees it later plays it like any other.
- **The door.** Only the owner may empty the machine, and that too goes
  through the operator (`pusher-empty:<mid>` → `commitCoinPusherEmpty`: the
  emptied machine, the owner's credit for exactly the chips that were inside,
  the door's answer and the cleared request, in one transaction), so an empty
  never races a drop. The operator must itself be the machine's owner and the
  one who asked. A request from anyone else (say, an owner whose deed has
  since changed hands) is turned down with an answer too
  (`refuseCoinPusherEmpty`). The panel goes by `pusher-door:<mid>`, since a
  request that merely vanished says nothing about whether the door opened.
- **Removal.** Every client sees the cabinet go and stops operating it. The
  records are cleared only by a deed-holder session that may operate the room
  by the election's rule: the one holding its lease, or one that could take it
  over. In one transaction (`drainAndClearCoinPusher`) that session pays the
  chips still inside to the deed holder and deletes the machine's own keys, a
  fixed few. Its per-player keys (requests, answers, and any `pusher-esc:`
  records an earlier revision left) carry no chips. They are then swept a
  batch of 64 per frame through the index, so a flood of them can't stall a
  frame. The sweep walks only the keys the index files under the machine, with
  a live iterator, so a key written meanwhile (a stale request, a late answer)
  goes too: in the same pass, or in the next if it lands after the pass went
  by. The sweep ends when the index files none under the machine. Another
  machine's keys never enter its walk, so they can neither be deleted nor keep
  it going. Every settle happens on the lease holder, so the drain never
  merges with a drop another tab is still settling (that would bring the
  machine back and pay its chips twice). Another deed-holder session keeps the
  teardown pending, and finishes it only if the operator goes away still
  holding the lease (after the same wait as a takeover). A cabinet put back
  first is left alone (its sweep stops too), and a pending teardown or sweep
  is dropped if the session moves to another room's doc, so it never touches
  either room's doc again. The recipient is the caller's own identity, never
  the owner named in the peer-writable machine, so chips only ever leave the
  machine to the player whose drop pushed them or to the operator itself —
  forging the machine can't pay the forger.
- **Trust.** The same dev-phase honest-client model as the rest of the
  casino map: the operator is trusted to run the physics honestly, and every
  read shape-guards so junk in these keys reads as "no machine" (including a
  machine whose own ledger doesn't balance, or with a pile off its platform).
  The requests aren't authenticated either. Like every key in the map, a
  peer can write a request naming another player (a drop at that player's
  cost, paid to that player, never to the writer) or a door request naming
  the owner (the owner's own chips, back to the owner). That is no more than
  writing the player's `bal:` directly, which any peer can already do (the
  sync layer checks who sent an update, not which keys the sender may
  write). Authenticated accounts come with the Registry chips.

## Conservation invariant

```
totalInserted = chipsInMachine + totalPaid + totalEmptied
```

Every reducer keeps it; the settle and empty helpers refuse a transition that
breaks it; the guard rejects a machine whose ledger doesn't balance. The
panel's meter shows a check mark for a machine that reads (no totals —
outside the cashier, chips are shown as chips, never as numbers), and a
warning for a record that is there but won't read.

## Data flow at a drop

1. The player presses DROP ONE CHIP. The panel writes
   `pusher-req:<mid>:<me>` = `{ requestId, player, hole, phase, requestedAt }`
   (the phase on screen, and when). No chips move.
2. The operator's next pass (at most 100 ms later) reads the requests oldest
   first from the machine's index, refuses or resolves each one's timing,
   runs `processInsert` with its own seed, and settles it (step *A drop*
   above).
3. Every client sees `pusher:<mid>` change: the cabinet redraws the piles and
   flashes the hole of every drop it hasn't shown yet (`recentDrops`, by chip
   id, since one poll can settle several); the player's panel reads its result
   (paid chips into the tray, timing kept or not) or its refusal.
4. The owner presses OPEN THE DOOR → `pusher-empty:<mid>` → the operator
   empties the machine onto the owner's rack and answers under
   `pusher-door:<mid>`.

## Review history

The first revision escrowed each insert's chips under `pusher-esc:` keys and
left payouts in a `pendingCredit` map inside the machine for players to claim.
The PR #137 review showed that both treated peer-written records as proof of
a debit: a forged request + escrow pair could be drained into real value, a
claim could publish any state with any amount, and teardown refunded any
escrow-shaped record. It also found an ante that debited more chips than the
one chip it dropped, drop timing taken from the operator's drain time instead
of the player's press, no aggregate chip cap, an owner STOP button the
per-frame autostart undid, a hole light that never faded, stale plan text,
and documentation that described a 2-D lane. This revision replaces the money
path with operator settlement (above), keeps the player's timing, adds the
cap, removes the operator toggle, fades the light, and describes the 1-D
model as it is.

## What still isn't done here

- No robot at the cabinet, and no leaderboard across cabinets.
- When the deed holder is away the machine is offline: the panel says so and
  DROP is disabled; nothing is lost.
- A cabinet removed while the deed holder is offline leaves its records
  behind (the same as a slot machine removed with no managing client online).
- A network split between two of the deed holder's devices that outlasts the
  takeover window can still settle drops, or drain a removed cabinet, on both
  sides (see *Splits*).
- The machine's owner is the player id of the install operating the room (the
  operator re-owns every machine it runs). The deed holder's other installs
  each have a player id of their own, so OPEN THE DOOR shows only on the
  install operating at the time, and the chips it returns go to that
  install's balance, like every casino balance (keyed by player id). No chips
  are at risk. Owning by identity key instead would need casino accounts
  keyed the same way.
- Other casino games elect their own operators (a slot machine's is per
  machine, as on main), so a slot operator and the pusher operator writing
  the same player's balance in the same instant can still lose one of the two
  writes: the casino map's documented v1 semantics for `bal:`, which the G4
  Registry chips close.
- The operator is trusted. Verifying drops (publishing the seed and letting
  clients replay the transition) is possible with this engine but not built.
