<!-- Produced 2026-07-18 by a 5-agent research workflow (4 web sweeps: CAT share issuance, offer markets, governance, org custody; synthesis). Extends chia-authority-architecture.md. PLAYER-FACING language rule (#68): ventures/charters/shares/deeds/offers/the Registry — the chain terms below are IMPLEMENTATION vocabulary only and must never reach game UI. -->

# SPACE COMPANIES — Shared Ownership Architecture

*Extends the settled per-module deed architecture (one NFT1 per module as transferable deed; live permissions off-chain as records signed against a chain-anchored authority head; node BLS key signs heads binding game Ed25519 keys). Status: design settled for implementation. Chain work is testnet11-only until legal review (§7).*

---

## 1. TL;DR

- **A company on chain is a singleton vault.** Its launcher id is the permanent company id. Company-owned module deeds (NFT1s) are transferred to `P2Singleton(company_launcher_id)` — provably company property, owned by no individual player. The launcher id never changes across rekeys, so the board can rotate without touching a single deed (chia-sdk-driver 0.34 `vault.rs`, `p2_singleton.rs`; same stable-address property as a Gnosis Safe).
- **Shares are a fixed-supply CAT2** minted once per company with the `genesis_by_coin_id` TAIL — supply provably can never inflate or melt (chialisp.com/cats; `Cat::single_issuance` in SDK 0.34). Asset id = TAIL tree hash, recorded in the company's on-chain metadata and authority head. Note: CAT2 is a grandfathered standard with **no CHIP number** — cite chialisp.com/cats, not "CHIP-0006".
- **v1 access rule** ("any share ⇒ full owner-equivalent access"): a player binds their Chia receive address (inner p2 puzzle hash) into their authority-head record — signed by their game Ed25519 key *plus* a one-time CHIP-0002 BLS challenge signature proving they control that Chia key. The Rust node then verifies holdings by pure coinset reads: compute the CAT outer puzzle hash via `CatArgs::curry_tree_hash(asset_id, inner_ph)`, query unspent coins, do **one parent-hop lineage check** (`Cat::parse_children`) to defeat spoofing, and require **≥ 1000 mojos (one whole share)** to block mojo-dust access grants. Grants carry a TTL and re-verify on authority-head rotation (~52 s block time bounds the revoke lag).
- **What stays off-chain:** everything live — room permissions, manager roles, the shareholder-facing access records, vote tallies, the offer board, price charts. On-chain spends are reserved for rare events: mint shares, buy/sell a deed, rekey the board, dissolve. This mirrors how every serious DAO works — membership churn is far too fast to mirror onto chain custody.
- **Ship order:** an off-chain v1 (company records + share ledger in room docs, same access predicate) ships **now** with zero chain dependency; the ledger root swaps to CAT holdings later with no UX change (§6).

---

## 2. Company formation

When players found a company, the node assembles **one founding spend bundle** on the existing coinset testnet11 lane (dev wallet funds it):

1. **Mint the company singleton.** Start with a **MedievalVault 1-of-1** over the founding node's BLS key (`medieval_vault.rs`, behind the `action-layer` feature — needs a build check on the Windows-GNU sub-crate lane; fall back to MIPs `Launcher::mint_vault`, which is in default features). The point of minting the vault on day one even with a single key: the **launcher id is the company id forever**, and adding co-signers later is a rekey (`child(new_m, new_key_list)`), not a migration. MedievalVault self-describes via launcher hints, so any observer can reconstruct the current key set from chain history — good for public attributability.
2. **Mint the share CAT.** `Cat::single_issuance(ctx, genesis_coin_id, None, N × 1000, …)` — `genesis_by_coin_id` TAIL, N whole shares at the universal 1 CAT = 1000 mojos convention (docs.chia.net/guides/cat-creation-tutorial). The N×1000 XCH mojos stay locked in the CAT coins permanently (genesis CATs can never melt) — at 1000 shares that's 1,000,000 mojos ≈ 0.000001 XCH, negligible.
3. **Record the binding.** Company metadata (name, share asset id, founding height, agent identity) goes in the launcher memos and in the company's **authority head** — the same head structure as modules, but signed by the vault's key set instead of a single node key.
4. **Distribute founder shares** as ordinary CAT sends **with hint memos** (`ctx.hint(p2_ph)`) so wallets and hint-based lookups work.
5. **Custody deeds.** Contributing a module = a standard NFT1 transfer of the deed to `P2Singleton(company_launcher_id)`. The NFT stays a normal tradeable NFT (royalty/transfer program intact); a vault spend authorizes any later deed sale via a SEND_MESSAGE condition in the same bundle (`test_wallet.rs` lines 194–256). Selling a vault-held deed through standard offer files works (SDK `SpendKind::Settlement`).

**Fixed vs mintable supply — recommend FIXED (`genesis_by_coin_id`).** Rationale: (a) no god key — `everything_with_signature`/delegated TAILs let the issuer key inflate supply forever, and delegated-TAIL signatures are irrevocable once published; (b) provably fixed cap table is what makes "share" a meaningful game object; (c) dilution rounds, if ever wanted, are better modeled as *founding a successor company* and offering swaps — an interesting game mechanic rather than a trust hole. Do a **pre-flight spike** transferring an NFT1 to `P2Singleton` on testnet11 before committing (flagged untested in research).

---

## 3. The v1 access rule: any share ⇒ full access

### Holder-proof flow (browser → Rust node → coinset)

Chia has no pubkey→balance query; everything is puzzle-hash based, and p2 hashes derive from BLS synthetic keys, not our Ed25519 game keys. So the binding must be explicit — and per the presence-addr trust lesson, **a declared address is not an owned address**. The flow:

**One-time binding (per player, per Chia address):**
1. Browser asks the node for a challenge nonce.
2. Player signs, via CHIP-0002 `sign_message_by_address` (BLS-AUG over `sha256tree('Chia Signed Message', msg)`, signing mode `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_AUG:CHIP-0002_`), a message embedding: nonce, network id, their **game Ed25519 pubkey**, and expiry.
3. Player's game key signs a record declaring the address (bech32m decoded → 32-byte inner puzzle hash; `CatInfo` docs confirm p2_puzzle_hash *is* the address).
4. The node verifies both signatures and publishes the binding record under the player's authority-head lane. From here on, no wallet software is needed for checks.

**Per-check verification (node-side, pure coinset reads):**
1. `outer_ph = CatArgs::curry_tree_hash(company_asset_id, bound_inner_ph)` — offline, no CLVM.
2. `get_coin_records_by_puzzle_hash(outer_ph, include_spent_coins=false)` on `CoinsetClient::testnet11()`.
3. **Anti-spoof lineage hop (mandatory):** puzzle-hash equality is forgeable — anyone can park a plain XCH coin at the CAT outer hash. For at least one candidate coin, fetch `get_coin_record_by_name(parent)` + `get_puzzle_and_solution(parent, spent_height)` and run `Cat::parse_children` to confirm the parent was a CAT of the same asset id.
4. **Threshold: sum of verified unspent amounts ≥ 1000 mojos (one whole share).** Without this, a 1-mojo dust transfer is a full master key (research caveat). This is the access predicate: `holds_whole_share(inner_ph, asset_id) → bool`.

### Authority-head extension

The company's authority head is structurally identical to a module head, with two additions:
- **Company record:** `{company_id: launcher_id, share_asset_id, deed_nft_ids[], key_set}` signed by the vault key(s).
- **Shareholder access records:** the node, having run the holder-proof, signs a record `{game_ed25519_pubkey, company_id, granted: full, verified_at_height, expires_at}` under the head. Room-doc permission checks then treat any player with a live shareholder record as owner-equivalent on all company property — the module-level check just adds "OR module's deed is owned by company C AND player has a live shareholder record for C."

### Staleness / revocation window

- Share trades change access only after on-chain confirmation; block target is ~52 s, so grant/revoke lag is sub-minute — fine for a hangout game.
- **TTL on access records:** recommend 10 minutes, refreshed by cheap re-checks (the outer-ph query is one HTTP call; the lineage hop can be cached per coin id since lineage is immutable).
- **Re-verify on authority-head rotation** — the natural sync point already in the architecture.
- Optimistic UI: watch the mempool (`get_mempool_item_by_tx_id`) to show "share transfer pending" on trading-floor screens, but never grant access from mempool state.
- Accepted residual: a seller retains access for ≤ TTL after their coin is spent. For v1 (hangout permissions, not funds) this is fine; sensitive future actions (deed sale) go through the vault anyway.

---

## 4. Share trading

### Offers are the market primitive

A Chia offer is a bech32m `offer1…` string — a partially-signed spend bundle locking the maker's coins behind settlement announcements; anyone holding the string can take it, no venue named (chialisp.com/offers). SDK 0.34 has the full stack: `encode_offer`/`decode_offer` (wallet- and dexie-compatible), `Offer::from_spend_bundle` to parse foreign offers, `offered_coins()`/`requested_payments()` to display them, `Offer::take` + `push_tx` to settle on the existing lane. Offers natively express **CAT-for-XCH and CAT-for-CAT** — company shares trade against XCH *and against other companies' shares* with zero extra infrastructure.

**v1 constraint: all-or-nothing.** Partial fills are CHIP-0052 (Final 2026-05-11) but have no implementation in SDK 0.34. Ship **fixed-lot offers** (1-share and 5-share lots) and plan for CHIP-0052 later; don't depend on it.

### Game-first market board: gossip over the iroh mesh (recommended), not external aggregators

Copy the **Splash!** architecture (dexie-space/splash — dexie itself is just an indexer sitting on a stateless libp2p gossip net), but on our own mesh:

- One gossip topic per market (or one global topic + client filtering); payload = the raw `offer1` string.
- Receiving nodes **decode + validate before listing**: involved coins unspent (coinset), not expired (offers can carry ASSERT_BEFORE timelocks since Chia 2.1.0; default GUI expiry is 7 days — enforce an expiry on everything we gossip), assets match a known company asset id.
- Each node keeps a local index with a background status checker (the offerpool pattern) so stale offers fall off the board.
- Taking an offer = the node completes and `push_tx`es the bundle. Cancel = maker spends their own coins, or just stops gossiping an unshared offer.

External venues (dexie POST `/v1/offers`, TibetSwap) are an **optional mainnet enrichment**, not a dependency — dexie testnet indexing is thin, and the game must not require a third party to have a market.

### Price charts: trustless trade tape from settlement-coin scanning

Venue-independent and identical on testnet11 and mainnet:

1. Compute the CAT-wrapped settlement puzzle hash per company asset id (inner = current `SETTLEMENT_PAYMENT` hash `cfbfdeed5c4ca2de3d0bf520b9cb4bb7743a359bd2e6a188d19ce7dffc21d3e7` from chia_puzzles; **not** the deprecated `bae24162…`).
2. Poll `get_coin_records_by_puzzle_hash(…, include_spent_coins=true)` for settlement coins; fetch the settling spends and decode notarized payments.
3. Each settlement yields `(asset, amount, counter-asset, amount, height/timestamp)` — bucket into OHLC candles client-side.

Dexie's `/v2/prices/*` family (tickers, orderbook depth, historical_trades — all probed live) is a secondary mainnet source; the `/v1/prices/*` paths return 400, use v2 only.

### The trading-floor screens, mapped to data sources

| Screen element | Data source |
|---|---|
| Order book / offer wall | Mesh-gossiped `offer1` strings, coinset-validated, local index |
| Candles / price chart | Settlement-coin scan trade tape (coinset), bucketed to OHLC |
| Ticker tape / last trade | Same tape, latest entries; mempool watch for "pending" flair |
| Company page (cap table, deeds) | Authority head company record + coinset holdings scan |
| "Buy 1 share" button | Take a fixed-lot offer → `Offer::take` → `push_tx` |
| Shareholder registry | Hint-lookup (`get_coin_records_by_hint`) — best-effort only; non-hinted sends are invisible, so it's decorative, never authoritative |

---

## 5. Governance later (design now, defer implementation)

**There is no production governance primitive on Chia.** The DAO wallet was removed in chia-blockchain 2.5.3 ("Removed unused proof-of-concept DAO wallet"); CHIP-23/24 are Stagnant; DAO1's known issues (proposal spam, fake proposals permanently locking voter CATs, mid-vote rule changes) are exactly why we don't want coin-locking votes. Off-chain voting against on-chain holdings is the practical route — and it *is* our authority-head architecture.

**Recommended pattern — Snapshot-style, tallied by nodes:**
- A proposal is a signed record under the company head, pinning a **snapshot height at creation time** (unannounced, fixed at creation — kills buy-vote-sell; Chia has no flash loans, but the Beanstalk $182M lesson in slow motion still applies).
- Votes are free CHIP-0002-signed messages over the mesh (no transaction). Vote weight = verified CAT balance at the snapshot height: query with `include_spent_coins=true`, count coins where `confirmed_block_index ≤ H` and (`spent_block_index == 0` or `> H`), with the same lineage hop.
- Anyone can independently recount — holdings are on chain, votes are public signed records.
- **Manager roles:** shareholders vote to appoint managers; the appointment is a signed record under the company head granting scoped day-to-day permissions (the Safe Modules/Zodiac Roles pattern, off-chain). Only a board **rekey** (changing who can sign vault spends / head updates) touches chain.
- **Default to optimistic governance:** managers act, shareholders hold a lazy veto window. Token-governance turnout is dismal (~half of DAOs have <10 distinct voters); requiring active votes for routine matters will simply stall companies.
- Delegation = an off-chain signed record ("address X delegates weight to game-key Y"), tallied by the same snapshot logic — the ERC20Votes idea with zero chain work.

**Defer:** on-chain vote enforcement (DAO1 lockup resurrection), vote-buying countermeasures (time-weighted balances, arXiv 2505.00888), and always keep a delay between "passed" and "executed" for anything touching the vault.

---

## 6. Game-first migration: the off-chain v1 that ships NOW

The entire chain layer hides behind one predicate: **`holds_whole_share(player, company) → bool`**. Ship v1 with an off-chain implementation and swap the root later.

**v1 (no chain dependency):**
- **Company record** in the room/company doc: `{company_id: random_32B, name, founders[], share_supply}` signed by founders' Ed25519 keys, anchored under the existing authority head.
- **Share ledger** as signed transfer records: `{company_id, from_pubkey, to_pubkey, whole_shares, seq}` — the current holder signs each transfer; nodes replay the chain of records to compute balances. Integer whole shares only (matching the ≥1-whole-share rule from day one).
- **Access rule:** identical predicate — any player whose replayed balance ≥ 1 share gets owner-equivalent records on company property. Same TTL, same head-rotation refresh.
- **Market board, offers, charts:** signed off-chain offer records gossiped on the same mesh topics the on-chain version will use; "settlement" = both parties' signed transfer records; the trade tape feeds the same OHLC screens.

**The swap (later, invisible to players):**
1. Company founding gains the vault + CAT mint step (§2); `company_id` becomes the launcher id (keep a signed alias record mapping the old random id).
2. Off-chain balances are honored once: the founding bundle distributes CAT shares matching the ledger (with hint memos), then the off-chain ledger is frozen with a terminal record pointing at the asset id.
3. `holds_whole_share` swaps its backend from ledger-replay to the coinset check (§3). Offer records become real `offer1` strings on the same topics. Charts switch tape source from signed records to settlement scans.

Nothing about rooms, screens, permission checks, or the trading UX changes — only the trust root under the predicate. This also derisks sequencing: the game mechanics (companies, shared access, trading floor) get playtested before any chalisp is load-bearing.

**Deliberate v1 simplifications:** double-spend safety of the off-chain ledger rests on the seq-numbered current-holder signature chain plus mesh convergence — acceptable for a hangout game's cosmetic-stakes v1, and it is exactly the class of problem the CAT swap eliminates.

---

## 7. Risks

- **Regulatory (the big one): tradeable profit-sharing "shares" in company assets are the textbook shape of a security** (Howey: investment in a common enterprise with expectation of profit from others' efforts). Mitigants: access-rights framing (shares grant *use*, not dividends — keep it that way; do not add revenue distribution without review), no fiat on-ramp inside the game. **Recommendation: CAT minting and share trading stay testnet11-only until reviewed.** The off-chain v1 (§6) carries the same shading in economic substance if shares trade for value — keep v1 shares non-purchasable for real assets, or purely granted/earned, until reviewed.
- **The v1 rule makes the smallest share a transferable master key** to all company property. Mitigated by the 1000-mojo whole-share floor; residual risk is that the market price floor of one share *is* the value of access, and one hostile buyer of one lot gets full permissions. Accept for v1; the designed escape hatches are threshold tiers and manager-gating (§5), no rearchitecture needed.
- **Custody:** with a 1-of-1 vault, the agent node can unilaterally sell deeds or abscond. Mitigations: launcher-memo attributability from day one; upgrade to m-of-n is a rekey, not a migration; deeds in `P2Singleton` (never a player's own address) from the start.
- **Key loss:** a lost 1-of-1 vault key permanently strands every deed the company holds. Push companies toward 2-of-3 as soon as MedievalVault is spiked; MIPs also offers `Force1of2RestrictedVariable` delayed-recovery if wanted. Lost *shareholder* keys just lose that stake — bearer asset, no recovery (plain CATs, `hidden_puzzle_hash = None`; the CHIP-0038 revocable variant would allow treasury clawback but makes shares non-bearer — decide per-company later, default plain).
- **Tiny-market liquidity:** company share markets will be a handful of fixed lots with huge spreads; charts will be sparse and manipulable by self-trades (settlement scans can't distinguish wash trades). Treat prices as flavor, never as an input to game logic or access decisions.
- **Technical spikes required before build:** (a) NFT1 → `P2Singleton` transfer on testnet11; (b) MedievalVault `action-layer` feature on the Windows-GNU sub-crate lane (remember: sub-crates not umbrella, `--exclude-all-symbols`, and `cargo check` hides the link error); (c) CHIP-0002 `sign_message_by_address` against the funded dev wallet; (d) verify the exact melt-condition rendering and dexie status codes before hardcoding anything from them (research caveats).
- **External-service dependence:** none required — coinset is the only third party in the critical path (already the case for deeds), and it speaks the standard full-node RPC, so it's swappable for a self-run node.

---

*Primary sources: chialisp.com/cats and chialisp.com/offers (CAT2/offer specs); docs.chia.net cat-creation tutorial (1 CAT = 1000 mojos); Chia-Network/chips (CHIP-0002 Final, CHIP-0043 MIPS Final, CHIP-0052 Partial Offers Final, CHIP-23/24 Stagnant; CAT2 grandfathered); chia-blockchain 2.5.3 release notes (DAO wallet removed); local crate sources chia-sdk-driver-0.34.0 (cat.rs, vault.rs, p2_singleton.rs, medieval_vault.rs, offers/, test_wallet.rs), chia-sdk-coinset-0.34.0, chia-puzzle-types (curry_tree_hash helpers); chia_puzzles (settlement hash cfbfdeed…); dexie-space/splash and offerpool (P2P offer-board patterns); live dexie /v2/prices probes; a16zcrypto governance-attacks, Beanstalk post-mortems, arXiv 2505.00888 (snapshot gaming).*
