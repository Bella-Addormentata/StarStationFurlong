<!-- Produced 2026-07-23. Owner question: can craps run on an OPTIONAL Chia gaming
backend where each player has an independent player-vs-house game that shares one
dice roll, presented as a normal communal craps table — toggled on/off without
changing gameplay? Research + options + the seam to build now. -->

# Craps on a Chia Gaming Backend — Research & Options (#69 G5/G6)

## 1. TL;DR

- **Bank craps decomposes into N independent 2-party (player↔house) wagers that
  share ONE public dice draw.** That is an unusually clean fit for
  [chia-gaming](https://github.com/Chia-Network/chia-gaming), which is inherently
  *2-party* state channels + an on-chain referee — its reference games are 2-party
  poker, and multiplayer is explicitly not its model. Craps doesn't need N-way
  consensus: every bet is player-vs-house, resolved independently. The table is
  "communal" only in **presentation** and in the **shared dice**.
- **The one genuinely new piece is the shared, fair dice** — a single roll that
  every player's channel agrees on. Recommended: **house commit-reveal anchored to
  a future Chia block hash** (a beacon), so the house cannot foresee or bias the
  roll and every channel's referee derives the same dice independently. This is
  exactly #69 G5's commit-reveal, strengthened with the "block-as-metronome" idea
  already worked out in [[REVIEW-20260710-ChiaHub]].
- **Presentation is already backend-agnostic.** The felt, dice tumble, chip trays,
  eight standing positions, robot stickman, and narration all render from the
  *synced table state* (dice + point + payouts). Both backends produce that same
  state. Swapping local↔chia changes only **where the roll comes from** and **how
  wagers settle** — zero change to gameplay or in-world things. That is why "turn
  it on and off without changing gameplay" is architecturally *true*, not
  aspirational: the seam sits **below** the presentation.
- **Build now / implement later.** Build the backend *seam* (an interface, the
  current logic as the `local` implementation, a `chia` stub, and a per-table
  toggle) — default `local`, so nothing changes today. Implement the `chia` stub
  later, gated on the same two spikes [[games-plan]] Phase 5 already names: the
  **B-7 wallet spike** and a **chia-gaming integration spike**.

## 2. Why craps fits chia-gaming unusually well

chia-gaming (Alpha 0.3, June 2026): *"Players fund a shared channel coin on the
Chia blockchain, then play games entirely off-chain by exchanging signed messages
(the potato protocol)."* Architecture: **state channels** (off-chain, alternating
signed turns) + an **on-chain referee** coin that validates moves and slashes a
cheater on dispute. Chain is touched only at **open / close / dispute**. Reference
games are 2-party: **CalPoker** (commit-reveal randomness) and **Space Poker**
(Hold'em). Rust core + WASM/TS bindings + a React frontend.

The catch for a *casino table* is that a poker table is irreducibly N-way — every
player sees every other player's contested state. **Bank craps is not.** In bank
craps the house books every wager, and each wager wins or loses **against the
house alone**, decided by the communal dice. So a craps table with N players is
**N parallel player↔house games** that happen to consume the **same dice input**:

```
        ┌─────────── shared fair dice (one roll) ───────────┐
        │              │              │              │
   player A↔house  player B↔house  player C↔house  player D↔house
   (2-party chan)  (2-party chan)  (2-party chan)  (2-party chan)
```

This is the whole reason craps is the *right first wagering table for a house*,
even though poker is what ships in the framework: craps needs **no N-way
protocol**, only N instances of the 2-party protocol chia-gaming already provides,
plus one shared input. The pure payout engine we already shipped
(`src/games/craps.ts`, `resolveCrapsBet`) is the per-channel outcome function —
the same math a ChiaLisp referee would enforce.

## 3. The hard part: one shared, fair dice

Every channel must consume the **same** two dice, and no party may foresee or bend
them. Options:

| Option | Mechanism | Fairness | Liveness | Verdict |
|---|---|---|---|---|
| **(a) House commit-reveal only** | House commits `H(seed)` before betting, reveals `seed` after betting closes, `dice = f(seed)` | House **knows** the dice at commit (before bets). No post-commit tampering, but a house that knows the roll can steer limits/behaviour | House-only reveal; simple | Weak — reject |
| **(b) House commit + block beacon** ⭐ | House commits `H(seed)` before betting; after betting closes, `dice = f(seed ‖ blockHash[H])` for a height `H` unmined at commit | House cannot predict `blockHash[H]` → cannot foresee or bias the dice. Deterministic + identical for all players | House reveal + a public chain read (read-only, no wallet) | **Recommended** |
| **(c) Multiparty commit-reveal** | House **and** each player contribute entropy; `dice = H(all reveals)` | Strongest — no single party controls it | A non-revealing player **stalls** the roll (griefing); needs per-player timeouts + a default | Overkill for a *bank* game where (b) already removes house advantage |

**Recommend (b).** One house commit-reveal per roll, mixed with a future Chia
block hash. Each player's channel references the same commit + the same beacon
height, so every referee derives the same dice with no cross-player messaging. It
is #69 G5's commit-reveal made un-grindable by the beacon, and it reuses the exact
"the block cadence is the shared clock" primitive [[REVIEW-20260710-ChiaHub]]
already specced (a read-only use — no wallet needed for the fairness upgrade
alone, see §7 G5b).

## 4. Settlement: what actually moves

- **Today (local):** chips are room-doc integers (`casinoDoc.ts`); the stickman
  credits winners and debits stakes at placement. #69 G4 plans to anchor the same
  ledger as issuer-minted **CATs** under the house.
- **Chia backend:** each player↔house channel is **funded at buy-in**. Bets and
  payouts are off-chain signed state updates *inside* the channel; the shared dice
  (§3) + the craps payout table decide each update; the **referee puzzle** enforces
  the payout math on dispute and slashes a cheater. Cash-out = **channel close**.
- **The referee puzzle is a re-expression of `resolveCrapsBet`,** not a new
  ruleset. The TS engine stays the golden spec; the ChiaLisp port is
  differential-tested against it (the payout table is small and already
  console-tested). This keeps the chain logic honest and the two in lockstep.

## 5. The on/off seam (what we build now)

```
        presentation  (furniture · 8 stands · stickman · dice tumble ·
                        chip trays · board · narration)   ── UNCHANGED
                          ▲ reads synced table state (dice, point, payouts)
                          │
        ┌─────────────────┴─────────────────┐
        │            CrapsBackend            │   ← the seam
        │  rollAndSettle(table, round, pt)   │
        └─────────────────┬─────────────────┘
             ┌────────────┴────────────┐
      LocalCrapsBackend          ChiaCrapsBackend
   (crypto RNG + room-doc     (per-player channels + shared
    chips — today, default)    beacon dice + referee — later)
```

- **One interface, `CrapsBackend`**, with the settle seam (`rollAndSettle`) that
  already exists as `rollAndSettleCraps`. `LocalCrapsBackend` = today's behaviour
  verbatim. `ChiaCrapsBackend` = the channel/beacon design above (a stub now,
  `isAvailable() === false` until the node wallet + chia-gaming are wired).
- **Per-table preference** (`cfg:backend:<tableId>` in the casino doc, owner-set),
  default `local`. The selector **falls back to local** whenever the chia backend
  is unavailable — so the toggle is safe to flip **today**; it simply no-ops to
  local with a note until the stub is filled in.
- **Async note.** A local roll is synchronous; a chia roll is multi-step (commit →
  betting → beacon wait → reveal → channel settle). The table state already has
  phases (`betting`/`closing`/`settled`) — a chia backend adds an
  `awaiting-beacon` beat so the existing sync tick + the focused UI simply render a
  "waiting on the chain" countdown. The interface is defined async-friendly now;
  the local implementation stays sync.

## 6. What stays identical — the guarantee

The `craps-table` furniture, the 3×1 footprint, the eight stands + reserved
stickman, the robot dealer post/narration, the two tumbling dice, the ON/OFF point
puck, the chip trays, the betting board, and every payout in `games/craps.ts` all
read from — or write — the **synced table state**. **None reference the backend.**
Flipping `local`↔`chia` changes only the roll source and where the wager settles.
This is the mechanical reason the owner's requirement holds: the in-world game is
the same game regardless of what settles it underneath.

## 7. Phasing

| Phase | Deliverable | Wallet needed? |
|---|---|---|
| **G5a — build now** | The backend seam: `CrapsBackend` interface, `LocalCrapsBackend` (today's logic), `ChiaCrapsBackend` stub, per-table toggle. Default local; **zero gameplay change** | No |
| **G5b** | Shared-dice **commit-reveal + block beacon** (§3b) under a *still-local* settlement. A large trust win (provably fair dice) that needs only **read-only** chain access — no channels, no wallet | No (read-only chain) |
| **G6a** | One player↔house **channel** proof on testnet11: fund, bet, settle, close; the payout **referee puzzle** = a `resolveCrapsBet` port, differential-tested vs the TS engine | Yes (B-7) |
| **G6b** | **N channels sharing one beacon-anchored dice**; buy-in/cash-out = channel open/close; chips as **CATs** | Yes |

G5b is the sweet spot to chase first after the seam: it delivers *provable
fairness* — the headline trust property of an on-chain casino — without the wallet
dependency, because reading a block hash is not a spend.

## 8. Dependencies & gates (unchanged from repo posture)

- **B-7 wallet spike** — key custody, XCH balance, spend signing. Hard gate for any
  channel/settlement work (same gate as [[games-plan]] Phase 5 and
  [[REVIEW-20260710-ChiaHub]] C0). The fairness-only G5b does **not** need it.
- **chia-gaming integration spike** — alpha 0.3 API stability; WASM-in-browser vs a
  native sidecar next to the iroh p2p node (the potato protocol wants a reliable
  ordered stream — our node's stream lane fits); the referee puzzle for craps
  payouts; testnet vs mainnet; dispute-path latency/fees.
- **Regulatory** — #69's **TESTNET-ONLY** stance holds. Real-value wagering plus
  issuer chips is a compliance decision, not a code one; the seam does not change
  that and defaults to the play-money local backend.

## 9. Risks / honest unknowns

- **Binding the shared dice.** Every channel must reference the *same* commit + the
  *same* beacon height. Publish the commit + the target height into the table state
  at roll open; a player joining mid-roll bets on the **next** roll only.
- **Reveal liveness (the house).** Option (b) has a single revealer. If the house
  vanishes after the commit, the reveal is missing — the referee's **timeout path**
  must let each player reclaim their funded stake (the framework's slashing covers
  the 2-party case). Mirror today's `closeCrapsTable`: no reveal in time ⇒
  **no-roll, refund**.
- **Alpha framework churn.** Pin a chia-gaming version; expect a native/WASM
  sidecar rather than pure browser; treat the API as unstable until the spike.
- **ChiaLisp payout port drift.** Keep `games/craps.ts` as the single source of
  truth and differential-test the referee puzzle against it in CI.
- **Chatty channels.** Per-roll channel updates are frequent. Consider netting a
  whole shooter-hand (come-out → seven-out) into fewer signed updates — an
  optimisation, not a correctness issue (open question §10).

## 10. Open questions for the owner

1. **Fairness bar** — is house commit + block-beacon (§3b) enough, or do you want
   player entropy (§3c) despite the griefing/timeout cost?
2. **Settlement granularity** — per-roll channel updates (simple, chatty) vs
   per-shooter-hand netting (fewer messages, more bookkeeping)?
3. **Chips** — keep room-doc integers under `local` forever and only CAT-ize under
   `chia`, or unify everything on CATs once G4 lands?
4. **Runtime** — WASM chia-gaming inside the Tauri webview, or a native sidecar
   process beside the p2p node?

## 11. Relationship to existing plans

- **[[games-plan]] Phase 4/5** already commits to chia-gaming for *poker* wagering
  and names the same gates. This plan is the *craps-shaped* companion: craps is the
  easier first wager (2-party-decomposable, house-banked) and should arguably lead.
- **[[chia-authority-architecture]]** sets the division of labour this reuses: the
  **Rust node** holds BLS keys and drives every chain spend/channel; the **browser**
  never touches BLS and keeps speaking Ed25519, rendering verified state from its
  local node. The craps backend seam lives in the browser only as an *interface* —
  the `chia` implementation calls down to the node, exactly as authority
  verification does.
- **[[REVIEW-20260710-ChiaHub]]** supplies the block-as-clock primitive the
  beacon dice reuses, and the `SSF_CHIA_*` env-flag opt-in discipline the backend
  toggle should follow at the node layer.
