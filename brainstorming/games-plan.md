# Games Plan — issue #45 (flippable table: chess/checkers ⇄ cards)

Owner ask: one flippable game table — chess/checkers face + card face — carrying
chess, checkers, war, two-player poker, single-player solitaire; chia-gaming
compatibility for secure wagering when players want to wager.

## Shipped in v1 (this slice)

- **`game-table` furniture/device**: 2×1 sturdy table, top flips 180° (checkerboard
  CanvasTexture face A / card-felt face B), focusable via the #33 device stack.
- **Checkers, fully playable**: standard American rules (black opens, forced
  captures, chained multi-jumps, crowning ends the move, no-move = loss; no draw
  adjudication). State is plain JSON in the room doc's `games` Y.Map keyed by
  table item id (`src/games/gamesDoc.ts`), rebinding per join like `players`.
  Seats = first two claimants by S2 player id; spectators see the live board
  (DOM panel + the in-world texture mirror); VS BOT = trivial capture-preferring
  random AI driven by the red claimant's client while the table is focused.

## Phase 2 — chess (reuse the board/turn plumbing)

Same seat/turn/status/doc shape; swap the engine: piece codes → chess set, move
gen with check/checkmate/stalemate, promotion UI, algebraic move log in-state.
Castling/en-passant need move history — add a `moves: string[]` field.
Board face already renders from a 64-cell array; kings/queens need a sprite row
on the canvas painter. Estimated: one engine file + painter tweaks, no new sync.

## Phase 3 — card engine + war + solitaire

Shared `src/games/cards.ts`: deck/shuffle/deal + a doc-synced `CardGameState`.
- **Trust note (documented, not solved here)**: a Yjs map is replicated state —
  every client sees the whole deck. Fine for war (no hidden info that matters)
  and solitaire (single-player). NOT fine for poker — see phase 4/5.
- **War**: 2 seats, flip-compare-collect; trivial rules, good engine shakedown.
- **Solitaire (Klondike)**: single-player on the felt face; local-first state
  (doc-backed optional — nice for resume, no adversary so no trust issue).

## Phase 4 — two-player poker (chia rules docs)

Target the two documented chia-gaming variants rather than inventing one:
- **California poker** (docs.chia.net/guides/gaming-california-poker-rules):
  commit-reveal randomness variant.
- **Space poker** (docs.chia.net/guides/gaming-space-poker-rules): Hold'em
  variant.
Plain-doc poker (open deck) is only acceptable as a NO-STAKES practice mode
with a visible "cards are technically public" banner. Real hidden-hand play
needs the commit-reveal scheme those rules define — which is exactly what
chia-gaming implements, so phase 4 play-money UI should mirror its game flow
(bet/call/raise/fold state machine, commit-reveal deal) to make phase 5 a
transport swap rather than a redesign.

## Phase 5 — chia-gaming wagering integration

From the repo README (github.com/Chia-Network/chia-gaming, Alpha 0.3, June
2026): "Players fund a shared channel coin on the Chia blockchain, then play
games entirely off-chain by exchanging signed messages." Architecture: **state
channels** (off-chain play) + the "potato protocol" (signed alternating-turn
messages) + an **on-chain referee** coin for dispute arbitration/slashing —
i.e. it is not state-channels-VS-referee; the referee is the channel's
enforcement backstop. Chain is touched only at open/close/dispute.

Integration posture for SSF:
- **Gate**: wagering waits on the B-7 wallet spike (key custody, XCH balance,
  spend signing) — no wallet, no channel coin, no wagers. Hard dependency.
- **Shape**: chia-gaming games are chialisp validators + handlers registered in
  its `clsp/games/` tree; our checkers/chess engines do NOT port for free.
  Poker comes with the framework (their two variants) — start wagering there.
- **Transport**: the potato protocol needs a reliable ordered peer channel —
  our iroh node's stream lane fits; the Yjs `games` map stays for spectators/
  lobby, while wagered moves ride the signed channel.
- **Honest unknowns**: alpha-stage API stability; whether a browser/WASM client
  exists or we must sidecar a native process next to the p2p node; testnet vs
  mainnet posture; fee/latency of dispute paths. Spike before promising UX.

## Sequencing

P2 chess and P3 cards are independent of each other (both reuse v1 plumbing);
P4 practice poker builds on P3; P5 gates on B-7 wallet + a chia-gaming spike.
