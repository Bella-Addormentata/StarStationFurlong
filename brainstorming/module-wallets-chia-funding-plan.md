# ChiaHub Presence Wallet, Covenant & Funding Model: One Coherent Plan

*Star Station Furlong — who pays for on-chain presence heartbeats, how a module/room "wallet" should be represented, whether a covenant can make it autospend safely, and what any of it actually costs. Design synthesis, not code.*

Repo root for prototype paths: `prototypes/0.29.0-core-loop-demo/`. Chia constants are cited from the local Rust `chia_rs` crates by file:line; where a figure lives only in Python `chia-blockchain` (not the local crates), it is flagged as such and not treated as source-verified.

> **Companions:** [REVIEWS/REVIEW-20260710-ChiaHub.md](REVIEWS/REVIEW-20260710-ChiaHub.md) (§3.3 spend-to-self, §6 presence singleton, §7 privacy, §9 spike items) · `ssf-p2p-node/src/chia_lane.rs` (shipped crypto half; seams `[C1-DESIGN]` line 18, `resolve_presence` line 183) · [keyed-identity-contacts-plan.md](keyed-identity-contacts-plan.md) (ChiaHub is rung 6 of the reachability ladder) · [module-transform-docking-adapters-plan.md](module-transform-docking-adapters-plan.md) (module = room = Yjs doc; honest-client ownership) · STUDY-Architecture v006 §6.1 ("the room's Chia singleton" + FROST t-of-n).

---

## 1. Executive summary

The owner asked two questions: **should each module/room have its own wallet, and can it "autospend as necessary"?** The honest answers:

1. **Not per-room for v1.** Presence payloads are **per-node** (each member publishes *its own* iroh address under a *shared* room-derived lookup tag), so payment naturally follows the payload → **one small burner key per node**, spending to self, paying its own fee. A per-room shared wallet only becomes safe with a covenant (Part 4), and it solves a problem — shared-spend authority every 30–60 min — that we don't have yet.
2. **"Autospend" is a half-truth worth stating loudly.** **Chia has no on-chain scheduler.** Every heartbeat spend is *poked off-chain by some node*. A CLVM covenant can constrain *how* a coin may be spent (republish-only, fee ≤ cap, one spend per interval); it can **never spend the coin for you**. So "autospend as necessary" means **permissionless-to-poke + covenant-constrained**, not self-executing. For v1, the node pokes its own coin on its own timer — which is exactly what already ships.

**The money answer, up front (math in Part 5):** in Chia's normal, uncongested state the presence lane costs **~0** — a 0-fee spend confirms because blocks sit far under capacity. The per-stream coin is a **reservation, not a burn**: a spend-to-self recreates it minus fee, so the principal circulates and is swept back on exit. Real money leaves only as *fees*, and fees only bite under **sustained exogenous congestion** (someone else's dust storm). Worst realistic per-node cost is **pennies to a few dollars a year**; the multi-hundred-dollar figures appear only if you assume the mempool is jammed *every block for a whole year*, which has never happened.

**The invariant that survives every option (say it every time):** a module wallet moves **no trust boundary**. `decode_signed` (chia_lane.rs:94) verifies Ed25519 over `node_id` only — it proves **authorship, not that the listed `addrs` belong to or are reachable at that node.** Whoever paid the fee — per-node key, room key, or covenant coin — the record still must **not** be dialed on its self-declared addrs without return-routability (host-observed reflexive addr + public-only filter + addr-per-record cap). **On-chain payment proves someone paid to publish; it proves nothing about address reachability.** A covenant coin will happily publish a lie.

### 1.1 The v1 recommendation

**Ship the plain per-NODE burner key. No shared wallet, no CLVM, no covenant.**

- It **matches the record model** (per-node payloads → per-node payment, zero coordination).
- It **matches what already ships** — this *is* ChiaHub §3.3 spend-to-self; the crypto scaffold in `chia_lane.rs` is built and unit-tested around it. C1 is chain IO only.
- **Smallest blast radius per key**, and a node compromise grants no authorship power the attacker didn't already have (it already holds that node's Ed25519 key).
- It **avoids the shared-spend-authority problem entirely** — the whole difficulty of a room wallet.
- It **sidesteps an open blocker:** room keys don't reach the node today (`[C1-DESIGN]`, chia_lane.rs:18); a per-room wallet would *compound* this by also demanding node-side spend authority.

Derive the spend key as a **burner from the room seed** (§7 rule 3), fund it with small top-ups, pay its own fee.

**Documented as future, not v1:** the per-module **singleton** (canonical-lineage "module has a wallet/identity" answer, unified with the Station Seals v2 Anchored-Seal coin) and the **covenant autospend** layered on it (the only shape that makes a room-funded, member-pokeable wallet safe). Both are gated and optional — see Parts 3–4.

---

## 2. Chia cost mechanics — the verified floor

Everything downstream rests on four facts about Chia's fee and coin rules. Constants below are cited to the local Rust crates; two figures that live only in Python `chia-blockchain` are flagged.

### 2.1 There is no consensus minimum fee

A **0-fee transaction is fully valid and gets farmed** whenever the mempool isn't full. Blocks arrive ~every 18–19 s and typical utilization is low, so *uncongested = fee 0 works reliably*. What can force a positive fee is purely congestion:

| Constant | Value | Role | Source |
|---|---|---|---|
| `max_block_cost_clvm` | 11,000,000,000 (1.1e10) | hard cap on total CLVM cost per block | consensus_constants.rs:223 |
| `mempool_block_buffer` | 10 | mempool capacity = 10× one block's cost | consensus_constants.rs:221 |
| `cost_per_byte` | 12,000 | every serialized generator byte (incl. our hint+ciphertext memos) costs this | consensus_constants.rs:224 |

When the mempool is **full**, admission and inclusion are prioritized by **fee-per-cost** (mojos of fee ÷ CLVM cost); a new tx must out-bid the lowest fee-per-cost item, and farmers pack highest-first. **There is no hard-coded "min fee rate" constant** — the floor is *dynamic*, equal to the current lowest fee-per-cost in a full mempool.

**Magnitudes** (against the source-documented standard-spend cost `MIN_COST_THRESHOLD` = 6,000,000 CLVM, build_compressed_block.rs:21):
- **Light/uncongested:** fee = **0**.
- **Congested:** 1 mojo/cost ≈ 6e6 mojos (6e-6 XCH); 5 mojos/cost ≈ 3e7 mojos (3e-5 XCH). Common wallet "safe" recs land near 0.00005 XCH (5e7 mojos) for prompt inclusion.

### 2.2 Per-condition costs that make up our spend

Our publish is a standard 1-in/1-out signed spend that recreates the presence coin:

| Constant | Value | Meaning | Source |
|---|---|---|---|
| `CREATE_COIN_COST` | 1,800,000 | per CREATE_COIN — we recreate one presence coin | opcodes.rs:65 |
| `AGG_SIG_COST` | 1,200,000 | per AGG_SIG_* — the signature authorizing the spend | opcodes.rs:66 |
| `GENERIC_CONDITION_COST` | 500 | base cost per condition past the free allowance | opcodes.rs:68 |
| `FREE_CONDITIONS` | 100 | first 100 conditions/spend not charged the generic cost — we use a handful, so effectively free | opcodes.rs:69 |
| `MIN_COST_THRESHOLD` | 6,000,000 | documented "typical cost of a standard XCH spend" — our best source-anchored total-cost proxy | build_compressed_block.rs:21 |

Byte cost from the ciphertext memo is added on top at `cost_per_byte` — see Part 5.1 for how these roll up to `C_spend ≈ 2e7`.

### 2.3 There is no consensus minimum coin amount — and the "dust filter" doesn't touch us

| Constant | Value | Meaning | Source |
|---|---|---|---|
| `max_coin_amount` | u64::MAX (~18.446M XCH) | only a **ceiling**; any value 0..=u64::MAX is representable on-chain | consensus_constants.rs:222 |
| `xch_spam_amount` | 1,000,000 mojos (1e-6 XCH), default | **wallet** dust filter — hides/aggregates tiny unsolicited coins in the reference **UI** | *not in local Rust crates* (Python `chia-blockchain` config.yaml) |

A **1-mojo coin is unambiguously valid and spendable**; a 0-mojo coin is also representable but holds no value to return and can't pay its own fee. Crucially, `xch_spam_amount` is a **wallet UI concern, not a consensus rule** — it does not exist in the local Rust crates and never affects on-chain validity or mempool acceptance.

**Our lookup path is unaffected by it.** `get_coin_records_by_hint` (chia-sdk-coinset-0.34.0/src/chia_rpc_client.rs:136–154) takes `hint, start_height, end_height, include_spent_coins, cursor` — **no amount/min-value filter.** Full nodes index coins by hint (from the CREATE_COIN memo's first extra element) regardless of value, so a dust-sized (even 1-mojo) presence coin carrying our room-derived hint is **fully resolvable**. Because our node reads coins by hint over coinset RPC — not through the reference wallet's dust filter — `xch_spam_amount` is irrelevant to us.

**Practical guidance:** for the node's own logic a **1-mojo coin is fine**, but keep the principal a bit larger so it survives fee subtraction across many republish cycles (Part 5). Make it **≥ 1,000,000 mojos only if** you also want it to appear normally in a reference GUI wallet — otherwise don't bother.

### 2.4 What is *not* source-verified (carried into §6)

- **`MOJO_PER_XCH` = 1e12** and **`xch_spam_amount` = 1e6 mojos** are **not** in the local Rust crates — they are Python `chia-blockchain` conventions. 1e12 mojo/XCH is bedrock, well-established Chia (safe to treat as ground truth); the 1e6 dust default is Chia knowledge/config.yaml, not local source.
- The **exact total CLVM cost of *our* specific spend** is not a fixed constant; `MIN_COST_THRESHOLD` = 6e6 is a proxy, memo bytes add on top (§6).
- The **dynamic congested fee floor** (mojos/cost to get in when full) is not a constant; the 1–5 mojos/cost figures are historical/operational, not source (§6).

---

## 3. Module / room wallet design space — WHO pays and HOW it's represented

Two sub-questions: **who holds spend authority** (per-node vs per-room), and **how the wallet is represented on-chain** (plain BLS key vs module-as-singleton).

### 3.1 The one framing that settles most of it

1. **Presence is per-NODE; the lookup tag is per-ROOM.** Each member publishes its own `node_id`-signed record under a shared `derive_hint(room_key, epoch)` tag. The *payload* is individual; only the *rendezvous tag* is collective. **Payment follows the payload → per-node by default.**
2. **No on-chain scheduler** (restating Part 1): a covenant constrains *how* a coin spends, never spends it *for* you.
3. **Two different lookup keys exist.** At dial-exhaustion (`resolve_presence`, chia_lane.rs:183) the node holds a *target pubkey but no room key* — an **identity-keyed** lookup — whereas the sealed `derive_hint` path is a **room-key-keyed** enumeration. A room/module wallet only ever serves the room-keyed path; C1 must reconcile the two.

### 3.2 WHO pays — per-node vs per-room

| | Per-NODE wallet (MVP) | Per-ROOM / MODULE wallet |
|---|---|---|
| Fits the record model? | ✅ payload is per-node; each member funds its own record | ⚠️ mismatch — one wallet, N per-node payloads to authorize |
| Spend authority | trivially clear — you spend your own coin | **the hard problem** — who may spend the shared wallet? |
| Coordination | none | a live spender/quorum every 30–60 min |
| Blast radius per key | one member's dust wallet | potentially the whole room's balance |
| Matches shipped plan | ✅ = ChiaHub §3.3 spend-to-self | needs new plumbing |

The per-room model's whole difficulty is **shared-spend authority**, and it has exactly three shapes:

- **(i) Hot shared key** everyone holds → *any* member leak drains the whole wallet. **Reject.**
- **(ii) FROST t-of-n** (the architecture already uses FROST for seals) → safe, but a live t-quorum co-sign every 30–60 min for a *heartbeat* is operationally brutal. Right tool for the rare **Anchored Seal**, wrong tool for presence.
- **(iii) Covenant coin + low-trust "poke" key** → the coin can *only* self-republish within fee/rate caps, so it barely matters who pokes it; no poker can steal. **The only shape where a per-room wallet becomes attractive — and it only works because of Part 4's covenant.**

**Key insight: a per-room wallet only makes sense together with a covenant.** A per-node wallet needs none. And there's a legitimate degenerate case: a room with a single always-on **host** node (SSF's hub-relay topology — the host relay already lets joiners see each other) really only needs the *host's* presence findable. "Per-room wallet that funds only the host" collapses back to "the host node's per-node wallet." So even the room-funded intuition mostly reduces to per-node for v1.

### 3.3 HOW it's represented — plain BLS key vs module-as-singleton

**(1) Plain BLS key per node** — *the v1 pick.*
- **Pros:** zero CLVM; stock spend construction; *is* the shipped MVP (§3.3); smallest thing that works.
- **Cons:** no on-chain identity/lineage — readers must **hint-scan** each epoch and keep newest-per-node (already how `chia_lane` is designed); the key = full authority (drain risk); no native rate-limit or covenant anchor.

**(2) Module-as-singleton** (unique-lineage smart coin; launcher id = module identity) — *the documented future.*
- **Pros:** **canonical current record** — readers follow the lineage tip, not a scan (this *is* the ChiaHub §6 / phase-C4 "presence singleton" upgrade); single-writer rate-limiting is inherent; **replay-proof** (old states provably superseded); and it **unifies cleanly with Station Seals v2**, which *already* wants "a memo in the room's Chia singleton spend" (v006 §6.1) — one coin can carry *module identity + presence-lineage tip + seal anchor*. The singleton top layer already enforces "child must re-wrap in the same launcher" — i.e. self-recreation — which is exactly the covenant substrate Part 4 needs.
- **Cons:** more complex spend construction; needs SDK singleton/DID drivers (**B-7 must confirm**, ChiaHub §9 item 1); a singleton is a persistent, publicly-walkable object — anyone who learns the launcher id can follow it across time (privacy: keep launcher id room-key-derived, payload ciphertext-only, per §7).
- **Upgrade path is clean:** MVP loose hinted coins → later mint a launcher and publish via the singleton. **No format break** for readers who already verify `decode_signed`.

**Representation verdict:** plain key now; the singleton is the documented "module has a wallet/identity" answer *and* the covenant's natural host — and it's already half-anticipated by the Anchored-Seal singleton, so **don't design a separate module coin later; make them the same coin.**

### 3.4 Security — does a module wallet move any trust boundary? No.

State this loudly so nobody mistakes it:

- The SSF invariant is **orthogonal to who pays.** `decode_signed` proves authorship, not addr-ownership. Whether the fee came from a per-node key, a room key, or a covenant coin, the record still must **not** be dialed on its self-declared addrs without return-routability (host-observed reflexive addr + public-only filter + addr-per-record cap). This is the latent gap the addr-trust memo flags in ChiaHub §3.1/§4.
- **New footgun a room wallet introduces:** do not let "published from the room's own covenant coin" launder addr-trust or membership-trust. Membership stays the room-key + Ed25519 author filter; the addr stays return-routability-gated.
- **Blast radius by key holder:**
  - *Per-node burner key* (v1): leak = that member's dust wallet drained + fee griefing. The attacker already owns the node's Ed25519 key, so **no additional authorship-forgery power**. Smallest radius. ✅
  - *Per-room hot shared key*: any member leak drains the whole room. Worst. ❌
  - *Per-room covenant + poke key*: leak → bounded fee burn + junk records at the rate limit until the room **re-keys** (v006 §7.4 topic rotation already exists); funds safe. Acceptable *because* of the covenant.
  - *Per-room FROST t-of-n*: needs *t* compromises; safest, operationally heavy — reserve for Anchored Seals.
- **Funding-trail privacy** (§7 rule 3) applies to every option: the funding coin has an on-chain history. Burner-derived-from-room-seed + accept pseudonymity for MVP; strict-mode players set `SSF_NO_CHIA_LANE=1` and lose the floor.

---

## 4. Covenant autospend — what it buys, at what complexity, v1 vs later

**Can CLVM constrain "republish-only, fee ≤ cap, rate-limited"? Yes — each clause is expressible in stock CLVM** (this is close to the historical "rate-limited wallet" puzzle):

- **Republish-to-self only** → the singleton top layer already forces the child to re-wrap under the same launcher id / puzzle hash (curry `SINGLETON_STRUCT`, assert the recreated coin). A bespoke covenant would `ASSERT_MY_PUZZLEHASH` against a curried self-hash and force `CREATE_COIN(self_puzzlehash, my_amount − fee, memos)`. The principal returns to the same coin; only the fee leaves.
- **Fee ≤ cap** → `ASSERT_MY_AMOUNT` + compute output `= my_amount − fee` + `(if (> fee CAP) (x) …)`, optionally `RESERVE_FEE`. Curry `CAP`.
- **Rate-limit per epoch** → `ASSERT_SECONDS_RELATIVE min_interval` (or `ASSERT_HEIGHT_RELATIVE`): the child can't be spent until `min_interval` after its own creation → one spend per interval, chain-enforced. Curry the interval.
- **External fee source** → compose with `CREATE_COIN_ANNOUNCEMENT` / `ASSERT_COIN_ANNOUNCEMENT` if the fee must come from a separate coin.

**What the covenant CANNOT do (be honest):**
- It **cannot validate the ciphertext/hint content.** The hint rotates daily (`derive_hint(room_key, epoch)`) and the room key must *never* touch the chain, so the puzzle can't check the memo derives correctly. The covenant constrains *where the money goes and how fast* — **not** whether the published address is honest.
- **Fee-source tension:** a no-signature ("anyone can poke") covenant is griefable — an anonymous poker can burn the room's money at the rate-limit cap unless the fee is forced to come from the poker's *own* coin (more complex). For v1 per-node, the node pays its own fee from its own key and this tension vanishes.

**Compromised-node worst case — the payoff table:**

| Attacker holds… | Plain BLS key | Covenant coin (self-recreate + fee-cap + rate-limit) |
|---|---|---|
| Drain the wallet | ✅ full drain to attacker | ❌ funds ring-fenced; coin can only recreate itself |
| Spend rate | unlimited | ❌ capped to one spend / interval |
| Fee burn | unlimited | bounded: ≤ `CAP × spends_per_epoch` |
| Publish junk/forged **own** record | ✅ | ✅ (still possible — covenant doesn't gate content) |
| Forge **other** members' presence | ❌ (needs their Ed25519 key) | ❌ (same) |

So the covenant is a real **financial** blast-radius reducer **and nothing more**. Caveat: it only protects the *covenant coin's* value — whatever key *tops it up* is the true exposure, so fund it in small burner increments.

**v1 vs later:** the covenant is **not v1.** It is the enabling piece for a *future per-room shared wallet*, layered on the singleton. v1 uses a plain per-node key that pays its own fee. Pursue the covenant **only if a genuine room-funded-infra need appears**, and carry its two honest limits every time: it constrains *money, not content*, and it needs a *fee-source decision* to not be griefable.

---

## 5. Parameterized funding model — testnet + mainnet

**Headline (honest conclusion, math below):** the presence lane costs **~0** in Chia's normal state. The per-stream coin is a **reservation, not a burn** — a spend-to-self recreates it minus fee, so principal circulates and is swept back on exit. Money leaves only as *fees*, and fees only bite under sustained *exogenous* congestion; even then the lane is minutes-scale, so it can defer to cheap blocks or slow its heartbeat.

### 5.1 Parameters and formulas

| Symbol | Meaning | Default | Low / High | Source / status |
|---|---|---|---|---|
| `M` | mojos per XCH | 1e12 | — | Chia constant (not in local Rust crates; §6) |
| `cadence` | heartbeat interval (min) | 30 | 60 / 30 | review §3.1 ("~30–60 min") |
| `chg` | on-address-change publishes/day | 2 | 0 / 24 | mobility-dependent |
| `P` | publishes/stream/day = `1440/cadence + chg` | **48** | 24 / 72 | derived |
| `C_spend` | CLVM cost of one publish spend | **2.0e7** | 1e7 / 3e7 | **[VERIFY]** derived §5.2 |
| `FPC` | fee-per-cost (mojo/cost) | regime | 0 … 20 | **[VERIFY]** empirical |
| `f` | fee/publish (mojo) = `FPC × C_spend` | regime | §5.3 | derived |
| `k` | recoverable coin principal/stream (mojo) | 1e7 (1e-5 XCH) | 1e6 / 1e9 | **[VERIFY]** dust-safe min, review §9.3 |
| `N` | publishing streams = Σ_rooms(members) = node-room memberships | scenario | — | topology |
| `H` | horizon (days) | 365 | 1 / 365 | — |
| `PXCH` | **assumed** USD/XCH (NOT a live quote) | $25 illus. | $10 / $50 | set at spend time |

**Core formulas**
```
f              = FPC × C_spend                  # fee per publish (mojos)
Fees(H)        = N × P × f × H                   # mojos actually consumed over horizon
Reserve        = N × k                           # one-time, RECOVERABLE (swept on exit)
Preload/stream ≈ k + P·f·H                        # of which P·f·H is spent, k returns
USD(H)         = Fees(H) / M × PXCH
```

**The load-bearing identity:** each publish is `spend(coin=V) → create(coin=V−f)` back to the same puzzle hash carrying `[hint, ciphertext]`. Only `f` leaves per publish; `V` (principal) returns. **Steady-state cost = Σ fees only**; principal is a reservation you get back.

### 5.2 Where `C_spend ≈ 2e7` comes from ([VERIFY])

Our spend = 1 input coin, 1 `CREATE_COIN` back to self carrying memos, 1 signature:
- `CREATE_COIN` ≈ 1.8e6 + `AGG_SIG_ME` ≈ 1.2e6 + standard-puzzle CLVM run ≈ ~0.5e6.
- **Byte cost dominates:** the ciphertext memo is the sealed presence record. Plaintext ~300–500 B (§3.1 JSON) + `seal()` overhead 24 B nonce + 16 B tag (chia_lane.rs `seal`) + 32 B hint. Serialized bundle ≈ 1.2–1.5 kB × 12,000 cost/byte ≈ 14–18e6.
- **Total ≈ 1.9e7 → round to 2.0e7.** Confirm against real testnet spends (review §9 items 3 & 6). Everything downstream is linear in `C_spend`, so a corrected number rescales the model trivially.

### 5.3 Fee regimes (the parameter that actually matters)

| Regime | `FPC` (mojo/cost) | `f` = FPC·C_spend (mojo) | `f` in XCH | When |
|---|---|---|---|---|
| **Free** (Chia's usual state) | 0 | **0** | 0 | mempool below block-cost cap → 0-fee confirms |
| **Moderate** (mild load) | 0.25 | **5e6** | 5e-6 | occasional busy periods |
| **Congested** (bad dust storm) | 5 | **1e8** | 1e-4 | mempool persistently full |
| **Extreme** (pathological) | 20 | **4e8** | 4e-4 | never sustained historically |

All `FPC` values are **[VERIFY]** — the one number to pin empirically on testnet11 and by watching mainnet. Memo size feeds `C_spend`, so bigger ciphertext marginally raises the congested fee via `cost_per_byte`.

### 5.4 Testnet (testnet11 — free, do this first)

testnet11 uses **TXCH from a free faucet** (review §8 C1; `chia_lane` startup already notes "faucet TXCH, no real XCH needed"). TXCH is valueless; the only question is whether one grant covers the C1→C3 spike program. Overwhelmingly yes.

Publishes covered by grant `G` = `G / f`:

| Faucet grant | Moderate `f`=5e6 | Congested `f`=1e8 | at `P`=48/day |
|---|---|---|---|
| 0.01 TXCH (1e10) | 2,000 publishes | 100 | ~42 / ~2 node-days |
| 0.1 TXCH (1e11) | 20,000 | 1,000 | ~417 / ~21 node-days |
| 1 TXCH (1e12) | 200,000 | 10,000 | ~11.4 yr / ~208 node-days |

**Recommendation:** request **~0.1–1 TXCH** (one typical faucet drip). At real testnet fees (usually ~0) it's effectively unlimited; even priced congested, 0.1 TXCH funds ~1,000 publishes — more than C1/C2/C3 will ever emit. **CI can run on 0.01 TXCH.** The recoverable coin `k` is trivial on testnet.

### 5.5 Mainnet scenarios

`P`=48, `C_spend`=2e7. **Free regime = 0 fees** (the common case) and is omitted from money columns — under Free you pay only the recoverable coin `k`. USD at illustrative **PXCH = $25**; scales linearly (band $10–$50 → ×0.4 to ×2.0).

**(a) 1 solo node, 1 room — `N = 1`** *(this is the only single-operator bill)*

| Regime | Daily (mojo / XCH) | Monthly (mojo / XCH) | Yearly (mojo / XCH) | Yearly USD ($10/$25/$50) |
|---|---|---|---|---|
| Moderate | 2.4e8 / 2.4e-4 | 7.2e9 / 7.2e-3 | 8.76e10 / 0.0876 | $0.88 / $2.19 / $4.38 |
| Congested | 4.8e9 / 4.8e-3 | 1.44e11 / 0.144 | 1.752e12 / 1.752 | $17.5 / $43.8 / $87.6 |

*Recoverable reservation: `k` = 1e7 mojo = 1e-5 XCH (~$0.00025), returned on exit.*

**(b) One 5-person room — `N = 5`** *(aggregate; each member individually = scenario (a))*

| Regime | Daily (mojo / XCH) | Monthly (mojo / XCH) | Yearly (mojo / XCH) | Yearly USD ($10/$25/$50) |
|---|---|---|---|---|
| Moderate | 1.2e9 / 1.2e-3 | 3.6e10 / 0.036 | 4.38e11 / 0.438 | $4.38 / $10.95 / $21.90 |
| Congested | 2.4e10 / 0.024 | 7.2e11 / 0.72 | 8.76e12 / 8.76 | $87.6 / $219 / $438 |

*Reservation: 5 × `k` = 5e-5 XCH, recoverable. Cost is borne 1/5 each, not by one operator.*

**(c) 50 rooms × avg 5 members — `N = 250` node-room memberships** *(ecosystem-wide aggregate)*

| Regime | Daily (mojo / XCH) | Monthly (mojo / XCH) | Yearly (mojo / XCH) | Yearly USD ($10/$25/$50) |
|---|---|---|---|---|
| Moderate | 6.0e10 / 0.06 | 1.8e12 / 1.8 | 2.19e13 / 21.9 | $219 / $547 / $1,095 |
| Congested | 1.2e12 / 1.2 | 3.6e13 / 36 | 4.38e14 / 438 | $4,380 / $10,950 / $21,900 |

*Reservation: 250 × `k` = 2.5e-3 XCH (~$0.06), recoverable. **Spread across 250 members, not one payer** — per member it's exactly scenario (a): a couple dollars/year moderate, tens of dollars/year only under year-round congestion.*

**Read the table correctly:** the only single-operator bill is **(a)**. (b) and (c) are aggregates — divide by `N` for the per-participant cost, which always collapses back to (a).

### 5.6 Sensitivity — what dominates, and the true worst case

**`f` (= `FPC × C_spend`) dominates, and `f` is dominated by congestion.** Leverage rank:
1. **`FPC` (congestion)** — 0 to ~20 mojo/cost. The whole story; moves cost across **four orders of magnitude** (0 → 4e8 mojo).
2. **`C_spend`** — memo size sets it; ciphertext is the swing factor (review §9.6). Fixed once measured.
3. **`P` (cadence)** — a 2× knob (60→30 min), and **defensive**: under congestion the node lengthens cadence and lets `expires_at` freshness stretch, because this lane is explicitly minutes-scale (review §1, §3.3).
4. **`N`, `H`** — pure linear scale; not a per-payer concern.

**SSF never self-congests.** One transaction block holds ~1.1e10 cost (~19 s cadence). Even scenario (c) at 48 pub/day is 12,000 publishes/day × 2e7 = 2.4e11 cost/day spread over ~4,500 blocks/day ≈ **~0.05% of one block's capacity**. Congestion for us is **always exogenous** — other people's dust storms — never demand we create.

**Worst case if the mempool is persistently full:** the "Congested yearly" rows *are* that case, and they assume the pathology holds **every block for 365 days**. Historically, Chia congestion (the 2021 dust storm) lasted **hours to days**, not years, and cleared to `f`=0. So the honest expectation: a solo node pays **$0 most of the year**, plus a handful of dollars during rare multi-day episodes — and can decline even that by (i) slowing the heartbeat, (ii) waiting for a cheap block (presence isn't latency-critical), or (iii) dropping to another discovery-ladder rung. **There is no scenario where a single participant faces a large, unavoidable bill:** the lane degrades gracefully on cost the same way it degrades on latency.

**Model stability notes:** the **singleton upgrade (§5/W2)** does not change this model — an update is still one spend, same `C_spend` order, same `f`; it changes *reader* mechanics, not fee count. Wallet packing (one burner per room vs one funding many, review §7.3) is **orthogonal to cost** — `N` counts publish streams regardless of how wallets are grouped.

---

## 6. Known unknowns — what to confirm before finalizing numbers

Everything here is **decision-forcing, not blocking**. The v1 recommendation (per-node key, spend-to-self) holds regardless of how these resolve; they only sharpen the funding figure and gate the singleton/covenant futures.

1. **Two constants are Python-only, not local-Rust-verified.** `MOJO_PER_XCH` = 1e12 is bedrock Chia (safe to treat as ground truth). `xch_spam_amount` = 1e6 mojos default is from config.yaml/Chia knowledge, **not** local source — and it doesn't affect us anyway (hint lookup ignores amount, §2.3). No action beyond noting provenance.
2. **Exact `C_spend` for our spend is not a constant.** `MIN_COST_THRESHOLD` = 6e6 is a standard-spend proxy; memo bytes add `cost_per_byte × bytes`. **To get the real number, build the actual spend bundle (standard puzzle + CREATE_COIN with hint + ciphertext memos) and read back the computed cost.** Maps to review §9 items 3 & 6.
3. **The congested fee floor is dynamic, not a constant.** The 1–5 mojos/cost figures are historical/operational. **Confirm against a live testnet11 mempool (`get_fee_estimate` / mempool RPC) and by watching mainnet** before finalizing the funding number. Maps to review §9.3.
4. **Is a strictly 0-mojo presence coin practically usable long-term?** It can't pay its own fee and would need an external fee coin each republish. **Recommend ≥ 1 mojo, funded from a separate fee reserve** — treat this as a decision, not a verified fact.
5. **B-7: SDK singleton/DID drivers** (ChiaHub §9 item 1) must be confirmed before the per-module singleton (and therefore the covenant) is buildable. Until then the singleton is documentation, not a slice.
6. **Room keys don't reach the node today** (`[C1-DESIGN]`, chia_lane.rs:18). This is why v1 stays per-node; a per-room wallet compounds it by also demanding node-side spend authority.

---

## 7. Proposed slices

Dependency-ordered. **W1 is v1.** W2–W3 are the documented futures, each independently reviewable and each gated on a named unknown from §6. Nothing after W1 is required for the presence lane to ship and be findable.

### W1 — Per-node burner spend-to-self (v1, the whole product for now)
Wire C1 chain IO onto the shipped `chia_lane.rs` crypto. Derive a **per-node burner spend key from the room seed** (§7 rule 3); mint/fund a small presence coin (principal `k` ≥ 1e6 mojo if GUI-visibility wanted, else ≥ 1 mojo); on each heartbeat, spend-to-self recreating the coin minus fee, carrying `[derive_hint(room_key, epoch), seal(record)]`. Fee = **0 in the common case**; cap a congested publish at ~1e7–5e7 mojo. Resolve peers via `get_coin_records_by_hint` (amount-agnostic, §2.3), keep newest-per-node.
- **Carries the invariant:** publishing proves authorship, not addr-ownership — the return-routability fix (host-observed reflexive addr + public-only filter + addr-per-record cap) lives **off-chain and is mandatory regardless of who funds the spend.**
- **Acceptance:** a fresh node publishes and is resolvable by hint at a 1-mojo coin; a spend-to-self recreates the coin minus fee (principal returns); a 0-fee publish confirms on an uncongested testnet11; measured `C_spend` recorded (closes §6.2); funding a node for a week costs ≤ one faucet drip; leaving sweeps the principal back.

### W2 — Per-module singleton (future; gated on B-7, §6.5) — "module has a wallet/identity"
Mint a launcher; publish presence via the singleton so readers follow the **lineage tip** instead of hint-scanning; replay-proof by construction. **Make it the same coin as the Station Seals v2 Anchored-Seal singleton** (v006 §6.1) — module identity + presence-lineage tip + seal anchor in one coin; **do not design a separate module coin.** Keep launcher id room-key-derived and payload ciphertext-only (§7 privacy). **No reader format break** — verifiers still `decode_signed`.
- **Acceptance:** a reader resolves the current record by following the launcher tip with no epoch scan; an old state provably supersedes; the same coin carries a seal-anchor memo; funding cost per update is the same `f` order as W1 (§5.6).

### W3 — Covenant autospend on the singleton (future; only if a room-funded need appears)
Layer the rate-limited-wallet covenant on W2's singleton: **self-recreate only** (`ASSERT_MY_PUZZLEHASH` + forced `CREATE_COIN` to self), **fee ≤ cap** (`ASSERT_MY_AMOUNT` + curried `CAP` + optional `RESERVE_FEE`), **one spend/interval** (`ASSERT_SECONDS_RELATIVE`). This is the **only** shape that makes a per-room, member-pokeable presence wallet safe (§4). Decide the **fee source** up front (node-pays vs external-coin-announcement) or it's griefable. Fund the covenant coin in **small burner increments** — whatever tops it up is the true exposure.
- **Honest limits to ship in the copy:** the covenant constrains *money, not content* (it cannot check the hint/ciphertext is honest); and it protects only the covenant coin's value.
- **Acceptance (adversarial):** a compromised poke key **cannot drain** the coin (only self-recreate), **cannot exceed** one spend/interval, and fee burn is bounded by `CAP × spends_per_epoch`; forging *another* member's record still fails (needs their Ed25519 key); the room can recover by re-keying (v006 §7.4).

### Non-slice: FROST t-of-n
Explicitly **not** for presence heartbeats (operationally brutal every 30–60 min). Reserve for the rare **Anchored Seal** economic events, where a live t-quorum co-sign is proportionate.

---

## 8. The one invariant to carry into every option

A module wallet — per-node key, room key, singleton, or covenant coin — **changes no trust boundary.** Presence still proves **authorship, not address-ownership**. On-chain payment proves *someone paid a fee to publish*; it proves **nothing** about whether the published addresses belong to, or are reachable at, that node. The reflection fix (host-observed reflexive addrs + return-routability + public-only filter + addr-per-record cap) lives entirely **off-chain and is mandatory**, whoever funds the spend. Do not let "it came from the room's own coin" launder addr-trust or membership-trust: membership stays the room-key + Ed25519 author filter, and every self-declared addr stays return-routability-gated.

---

*Provenance note: Chia consensus constants (cost, fees, coin bounds) are cited from the local Rust `chia_rs` crates by file:line. `MOJO_PER_XCH = 1e12` and the `xch_spam_amount` dust default are Python `chia-blockchain` conventions, not in the local crates, and are flagged as such (§2.4, §6.1). Fee-per-cost magnitudes and `C_spend` are engineering estimates marked `[VERIFY]` — pin them on testnet11 before finalizing any funding figure. This document is design synthesis, not shipped behavior.*
