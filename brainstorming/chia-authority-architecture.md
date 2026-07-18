<!-- Produced 2026-07-18 by a 14-agent research workflow (5 web sweeps, 8 load-bearing claims adversarially verified, synthesis). Owner question: should durable authority records move on-chain, and which Chia primitive fits? -->

# StarStation Furlong: On-Chain Authority Records — Architecture Recommendation

## 1. TL;DR

**Mint one NFT1 singleton per module/room as its transferable deed. Everything else stays off-chain, chained to that deed by signatures.**

- **Ownership + transferability → NFT1** ([CHIP-0005](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0005.md)), default metadata updater, `royalty_basis_points = 0`. The launcher id is the permanent module id; the current p2 puzzle hash is the owner key. Transfer = `Nft::transfer` (gift) or an [Offer](https://chialisp.com/offers/) (atomic trade/sale, no coordinator, maker can be offline).
- **Co-host sets, grants, door policies → off-chain**, as records signed by the on-chain owner key (Keybase-sigchain / [UCAN](https://github.com/ucan-wg/spec)-style), carried in Yjs room docs and the iroh mesh, verified against the chain-anchored root.
- **DIDs ([CHIP-0004](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0004.md)): skip for now.** They add provenance stamping only (not custody), recovery is effectively dead (RPCs removed in chia-blockchain 2.5.7), and they double mint cost. Add later as optional player-profile provenance if wanted.
- **Fallback if mutable on-chain co-host state ever becomes necessary:** the CHIP-0035 DataStore delegation layer (admin/writer roles), already available in chia-sdk-driver 0.34 behind the `chip-0035` feature. Not needed for v1.

Everything required ships in the crates the project already builds against (chia-sdk-driver 0.34.0, chia-puzzle-types 0.36.1 — verified against the local registry sources), and the resolution machinery is the same hint/coinset lane the presence system already uses.

## 2. The primitives, compared for this use case

| | NFT1 (default updater) | DID1 | DataStore (CHIP-0035) | Custom singleton / custom updater | Offers |
|---|---|---|---|---|---|
| Durable id | launcher id ✅ | launcher id ✅ | launcher id (store_id) ✅ | launcher id ✅ | n/a (transfer mechanism) |
| Owner key rotation | ✅ every transfer rotates p2 | ✅ via transfer | ✅ owner re-curry | ✅ | n/a |
| Atomic p2p transfer | ✅ offers, NFT-for-NFT tested in SDK | ✅ but no offer ecosystem | awkward (owner-path spend) | build it yourself | **is** the transfer |
| Mutable on-chain state | ❌ prepend-URI only | ✅ free-form metadata | ✅ merkle root + delegation | ✅ arbitrary | n/a |
| Multi-key / co-writer | ❌ | ❌ single p2 key | ✅ admin/writer/oracle | build it yourself | n/a |
| Wallet/explorer support | ✅ Sage, MintGarden, offers ecosystem | partial (profiles) | DL tooling only | ❌ none | ✅ universal |
| SDK 0.34 maturity | ✅ complete, simulator-tested | ✅ complete | ✅ behind `chip-0035` feature | raw conditions only | ✅ complete incl. NFT-for-NFT |
| Recovery story | none (key = deed) | dead ([recovery RPCs removed](https://docs.chia.net/did-rpc/)) | none | build it yourself | n/a |

**Why NFT1 wins.** The authority question decomposes into two very different halves. *Ownership and transferability* need consensus: two players who don't trust each other must agree who owns a module, and a sale must be atomic. NFT1 + Offers solves exactly this, is the most battle-tested primitive on Chia (mainnet since 2022), and comes with a free ecosystem — deeds show up in [Sage](https://github.com/xch-dev/sage) and MintGarden, and "trade module A for module B" is a solved, [simulator-tested](https://docs.rs/chia-sdk-driver/0.34.0/chia_sdk_driver/) flow (`test_offer_nft_for_nft`). *Co-host sets and grants* need low latency, cheap revocation, and privacy — three things a public chain with ~52 s blocks structurally can't give. Chia's own gaming direction ([a protocol, not a platform](https://www.chia.net/2026/01/07/a-protocol-not-a-platform-our-goal-for-chia-gaming/)) reaches the same split: chain for open/close/dispute, everything live off-chain.

**Why not DID as the record.** A DID gives freely-updatable metadata, which is tempting for co-host sets. But it's still a single-key singleton — co-hosts in DID metadata are owner attestations, exactly what a signed off-chain record gives you without a chain write per change. And DID's one distinctive feature over NFT1 (social recovery) is abandoned in practice. You'd give up the offer/transfer ecosystem to gain a mutable field you don't need on-chain.

**Why not DataStore first.** CHIP-0035 delegation (admin/writer puzzles, structurally unable to seize ownership) is genuinely the closest on-chain match to "owner + co-hosts", and it's in the dependency tree. But every grant/revoke is an on-chain spend with minute-scale latency, one-pending-update sequencing per store, and a public record of the social graph. Per-module transferability is also weaker: transferring one module out of a shared store requires owner ceremony, and per-module stores forfeit the delegation advantage while losing NFT wallet support. Keep it as the named fallback.

**The key-scheme constraint that shapes everything:** CLVM has BLS and secp256k1/r1 operators but **no Ed25519** ([CHIP-0011](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0011.md)). SSF's Ed25519 identity keys cannot be spend keys. So the on-chain owner is a BLS key held by the Rust node, and the Ed25519 game identity is *bound to it by signature*, not curried into a puzzle. This makes the "signed head record" pattern below mandatory rather than optional — which is fine, because it's also the right design.

## 3. Recommended architecture

### Module creation ("claiming a deed")

Deed minting is **opt-in and lazy** — casual module creation stays chain-free exactly as today. When an owner claims a deed, the Rust node:

1. Derives a per-module BLS key from the node's wallet seed (the same funded testnet11 dev-wallet infrastructure).
2. Mints via `Launcher::new(parent, 1).mint_nft(ctx, &NftMint::new(metadata, p2_puzzle_hash, 0, None))` — default updater, zero royalty, no DID. ~53M CLVM cost, [zero fee in the normal mempool state](https://docs.chia.net/guides/nft-intro/), 1 mojo locked.
3. On-chain `NftMetadata`: `data_uris = ["ssf://module/<uuid>"]`, `data_hash` = SHA-256 of a small canonical module descriptor (name, created-at, genesis room-doc id). Immutable — this is the birth certificate, not the mutable state.
4. CHIP-0007 JSON (name/description clearly marked "StarStation Furlong module deed") so external wallets render it honestly.
5. Hints the p2 puzzle hash (`ctx.hint`) so the deed is resolvable through the **same coinset hint lane the presence records already use**.
6. Writes `authority_root: <launcher_id>` into the room doc.

### The authority head record (the chain→game bridge)

The owner's node publishes into the room doc a signed **authority head**:

```
{ launcher_id, seq, owner_ed25519_pubkey, cohost_ed25519_pubkeys[], transferable: bool, issued_at }
+ BLS signature by the NFT's current p2 key (CHIP-0002-style domain-separated message signing)
```

Verification by any peer (Rust node does this; browser consumes results):
1. Resolve the NFT's current unspent coin from the launcher id via coinset lineage walking + `Nft::parse_child` — the SDK's `child_from_p2_spend` machinery handles this.
2. Check the head's BLS signature corresponds to the coin's current `p2_puzzle_hash`.
3. Accept the Ed25519 owner/co-host keys in the head as authoritative; all existing room-doc grant records (door permissions, build rights) now chain from those keys unchanged.

[CHIP-0002](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0002.md) domain separation guarantees a head signature can never be replayed as a spend. Highest `seq` wins; a new head instantly rotates co-hosts or even the owner's *game* key with zero chain writes. This is the ENS [CCIP-read](https://docs.ens.domains/resolvers/ccip-read/) lesson applied: because verifiers check against the chain-anchored root themselves, a compromised relay or malicious room-doc peer can only *censor* authority data, never *forge* it.

### Ownership transfer

- **Gift:** `Nft::transfer` to the recipient's p2 hash — ownership transfer and BLS key rotation in one spend, ~1 min finality. New owner publishes a fresh head (`seq+1`) with their Ed25519 key; the old head fails verification automatically because the p2 hash changed.
- **Trade/sale:** Offer files. Maker's node builds `Offer::from_input_spend_bundle`; the offer text (inert, tamper-evident, no secrets) is dropped into a room doc or "market board" doc; taker's node parses with `Offer::from_spend_bundle`, verifies the NFT identity **from the puzzle reveals, not the file's claimed metadata** (self-authenticating in the SDK), and takes. Add [CHIP-0014](https://github.com/Chia-Network/chips/blob/main/CHIPs/chip-0014.md) `ASSERT_BEFORE` expiry to anything posted publicly.
- **Non-transferable modules:** enforce as game policy via the head's `transferable` flag, not on-chain (a custom transfer program would forfeit ecosystem compatibility; not worth it).

### Division of labor

- **Rust node:** BLS keys, minting, transfers, offer make/take, coinset resolution, head signing/verification, caching verified heads. All spend logic is `chia-sdk-driver` 0.34 already compiled in the chia-lane build.
- **Browser:** never touches BLS or the chain. It renders verified authority state served by its local node and continues to speak Ed25519 for everything it does today. Trust boundary unchanged.

## 4. What deliberately stays off-chain, and why

**Per-door grants, door policies, build-rights, co-host changes, presence.** Four arguments:

1. **Latency.** ~52 s average between transaction blocks, 1–2 min to confirmation ([mempool docs](https://docs.chia.net/chia-blockchain/architecture/mempool/)). A door check happens in milliseconds; even a co-host add feels broken at a minute. On-chain writes are fine only for events that are *supposed* to feel ceremonial — claiming and transferring.
2. **Sequencing.** A singleton supports one spend per confirmation. Rapid grant churn would queue behind itself.
3. **Privacy.** Public per-user permission records leak the social graph — the exact pitfall the [W3C VC status-list](https://www.w3.org/TR/vc-bitstring-status-list/) work documents. SSF's room-key-sealed record approach is strictly better; keep it.
4. **Revocation honesty.** UCAN's spec concedes off-chain revocation is eventually consistent — and an on-chain root *does not fix that* for the grants themselves. The right mitigation is short-lived grants re-validated against the head (TTLs), which room-doc sync already delivers faster than block confirmation would.

Cost is *not* the argument — mojo-level fees are negligible. The chain is simply the wrong latency/privacy tier for live permissions.

## 5. Migration path

Today: room-doc maps (door policies, build-rights) keyed to Ed25519 pubkeys, plus the working sealed-presence coinset lane.

- **Phase 1 — additive anchor.** Add deed minting + `authority_root` in the room doc + head publication. No existing structure changes; rooms without `authority_root` behave exactly as today. The mint/resolve code is a sibling of the introduction lane (same coinset client, same hint pattern, same wallet).
- **Phase 2 — verified precedence.** When `authority_root` is present, peers derive the owner/co-host set from the verified head instead of the raw room-doc owner map; the map becomes a cache of the head. Grant records need **no schema change** — they already chain from Ed25519 keys; only the root of the chain moves.
- **Phase 3 — transfers.** Direct transfer, then offers + market-board docs. Simulator-test the whole flow offline with `chia-sdk-test` before touching testnet11.
- **Phase 4 (optional).** Player DIDs for mint provenance; DataStore fallback only if a concrete need for on-chain delegation appears.

Each phase ships independently and degrades gracefully to the previous one — a peer with no chain access still gets room-doc authority, just unverified (mirrors today's trust level).

## 6. Costs and risks

- **Fees:** effectively zero on testnet11 and normally zero on mainnet; busy-mempool worst case ~0.000265 XCH per mint at [5 mojos/cost](https://docs.chia.net/guides/nft-intro/). 1 mojo locked per deed. The funded dev wallet covers thousands of mints. Note mainnet has seen dust storms where zero-fee tx stall — attach a small fee for anything user-facing.
- **Key loss = stranded deed.** The dominant real-world failure across every ecosystem surveyed. No recovery in v1: mitigate with seed backup (deed keys derive from the node wallet seed, so one backup covers all deeds) and a documented stance. Medium-term option: chia-sdk-driver 0.34 already ships `mint_vault` (MIPs custody with clawback-style recovery) — a deed could later be re-parented under a vault without changing this architecture.
- **External-wallet foot-gun.** Deeds are real NFTs; a user can sell or melt one from Sage by accident. Honest CHIP-0007 naming + a client warning when a deed's owner changed unexpectedly (the node sees this on resolution anyway).
- **Testnet→mainnet:** mechanics and costs identical; only address prefix/genesis constants differ. No redesign risk.
- **SDK maturity:** the entire surface used here (NFT mint/transfer/parse, offers incl. NFT-for-NFT, hints, coinset) was verified against the pinned 0.34.0/0.36.1 sources and the SDK's own simulator tests — this is the SDK's best-paved path. Known project-specific risk is the Windows-GNU link quirks already documented for the chia-lane build, not the API. The one thing to avoid is the unpaved path: custom metadata updaters and custom transfer programs, which this design deliberately never needs.
- **Staleness window:** a peer with a cached head can be fooled for the duration of its cache TTL after a transfer. Bound the TTL (minutes) and re-resolve on any authority-sensitive action; this equals the chain's own finality window and is unavoidable in any light-client design.
