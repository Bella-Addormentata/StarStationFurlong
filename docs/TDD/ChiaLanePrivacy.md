# Chia lane privacy: what a station writes, who can read it, and what stays visible

> **Purpose:** the one place that says what a Star Station node writes to the Chia chain, what it asks Chia full nodes, what it keeps on disk about both, and what each kind of observer can learn from that. It is the written form of the mainnet privacy gate ([#231](https://github.com/Bella-Addormentata/StarStationFurlong/issues/231) P8, [#335](https://github.com/Bella-Addormentata/StarStationFurlong/issues/335) stage 4). §6 lists what the gate does not hide, and §10 is the review that has to pass before mainnet opens to players.
>
> **As of:** main after [#413](https://github.com/Bella-Addormentata/StarStationFurlong/pull/413), 2026-11-10. **Proven so far:** the node's reads have met real full nodes on testnet11 and mainnet ([#412](https://github.com/Bella-Addormentata/StarStationFurlong/pull/412)). No write of the burner path has: it has run on the mock chain only (`chia_peer/mock`, `chia_publish/chain_tests.rs`), and the two-machine drill has not happened. Mainnet exists only in a development build (the `chia-mainnet` cargo feature, which the release workflow never builds). A statement marked **inferred** is reasoned from Chia's rules, not observed.
>
> **Rule:** a change to what the node writes to the chain, asks of a full node, or stores about either updates this file in the same PR.

Code is named by file and by function or constant, not by line. Node files are in [`ssf-p2p-node/src`](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src), page files in [`src`](../../prototypes/0.29.0-core-loop-demo/src), both under `prototypes/0.29.0-core-loop-demo`. An **era** is 32,256 blocks, about a week (`ERA_BLOCKS` in `chia_lane.rs`); the game calls it an edition of the Phone Book. A **hint** is the 32-byte value a record is filed under on chain. A light client can look a record up by its exact hint, or by the address of the coin that carries it; there is no search. So who can compute a hint, or knows the address that paid, decides who can find the record.

## 1. In short, for players

This is the text the game's help should carry. Today the game says part of it, in LIST ME's warning and notes (`listMeWarning` in `listMe.ts`) and in the Phone Book and Bank rows: who can read a listing, that a write is visible and stays, the IP address, and who pays. It does not yet say that a card holder reads every week's listing, it says nothing of a beacon, and there is no help page.

> **What the Phone Book writes on Chia.** While LIST ME is on, your station writes a listing about once a week, and a knock when it cannot reach a host whose card it holds. With LIST ME off it writes neither.
>
> Your listing is sealed. Only people who hold your contact card can open it, and with the card they can find and open every listing your station has written, in every week. Chia never forgets. Your card goes to the members of each private room where SHARE CARD is on, to anyone a member hands that room's pass to, and to a host you knock on for such a room.
>
> A listing holds your station's id and its public internet addresses, never an address on your home network.
>
> On Chia mainnet each week's listing, and each knock, is paid by a one-mojo key of its own that the lobby dish funds. It is never your SSF wallet. Nothing on the chain ties this week's key to last week's, to your knocks, or to your wallet. Anyone can still see that some Star Station node wrote a listing or a knock, when it was written, and that the lobby dish paid for it.
>
> On testnet11 today your SSF wallet pays for each listing and each knock, so they all sit at your wallet's address.
>
> A beacon writes your station's id in the clear every week. Nothing in the game lights one: only whoever starts the node can.
>
> The Chia full nodes your station talks to see its IP address on everything it sends and asks for. To stop that, turn Chia off (SETTINGS, NETWORK, CHIA). Your station then never contacts Chia at all.

## 2. What a station writes

Every spend the node makes is first sent through `push_parked_as` in `chia_publish.rs` (the lease sends a saved one again: §5). These are all of them.

| Write | When | Filed under | Body | Paid by |
|---|---|---|---|---|
| **Listing** (presence, record v2) | Once an era, and again when the station's public addresses or their flags change (10 minutes after the last write at the earliest), when a write has not confirmed after 30 minutes, or when the chain dropped one: 9 writes an era at most (`ADDR_CHANGE_DEBOUNCE_SECS`, `MAX_NODE_WRITES_PER_ERA`). Only while LIST ME is on, `SSF_CHIA_FINDABLE` is not `0`, the SSF wallet is on and `contact.key` is saved on disk. | The listing hint, `derive_ck_hint`: the contact key, the era number and, on mainnet, the genesis challenge. | 360 bytes, sealed with XChaCha20-Poly1305 under a key made from the contact key alone (`derive_ck_enc_key`). Inside, 320 bytes of fixed length: node id, a per-era X25519 public key, issue and expiry times, up to 8 addresses with a flags byte each, the node's signature. Only public, internet-routable addresses are written (`chia_public_addrs` in `main.rs`); a listing may hold none. | A burner key of its own per era, P(e), on mainnet and with `SSF_CHIA_BURNERS=1`. Otherwise the SSF wallet's coin (§7). |
| **Knock** | When every live route to a host has failed and the station holds that host's card: once per host per era, whatever the room (`knocked_this_era` in `chia_knock.rs`). Only while LIST ME is on, the SSF wallet is on, the watcher runs and the room uses cards (`may_use_cards` in `chia_rooms.rs`: a private room with SHARE CARD on, never the welcome room). | The inbox hint, `derive_inbox_hint`: the host's contact key, the room's lane token (made from the room key), the era and, on mainnet, the genesis. | 392 bytes, sealed to the host's long-term card key (`seal_to_kx`; the key is `kx_card_secret`, made from the host's node key). The seal also binds the carrier coin's parent and the room's lane token. Inside: the knocker's node id, the knocker's own contact key when its card may be handed out in that room, one 16-byte room lane id, times, signature. No address. | A burner key of its own per host, room and era, or the SSF wallet's coin (§7). |
| **Beacon** | Only with `SSF_CHIA_BEACON=1` in the node's environment, and only while the node is reachable from outside and serves the welcome room (`beacon_arm_due`): once an era. LIST ME does not hold it. | The beacon hint, `derive_beacon_hint`: the era and, on mainnet, the genesis. Anyone can compute it. | 320 bytes in the clear: node id, era, times, signature. No key and no address. | The beacon key B, one key for every era. |
| **v1 room record** ("Chia mesh") | On a test network only, for a private room whose Chia mesh switch this station turned on (off by default, not offered on mainnet): about every 30 minutes, and at once when the node's addresses change. LIST ME does not hold it. | A hint per room per UTC day (`derive_hint`: the room key and the day), the same bytes on every network. | Sealed under the room key. Signed JSON of variable length: node id and every live address of the node, addresses on the home network included; it expires after an hour. | The SSF wallet's coin. |
| **TAKE A MOJO, GIVE** | The player's own taps at a faucet dish, on a test network only. | No memo. | TAKE pays 1 mojo from the dish to the SSF wallet's address; GIVE pays the dish from the wallet. | The dish, or the wallet. |
| **Test hooks** | `SSF_CHIA_PUBLISH_TEST=1`, `SSF_CHIA_CRAPS_FAIR_TEST=1`, `SSF_CHIA_CLAIM_WRITE_TEST=1`, on a test network only (`test_hook_on` in `main.rs`), with a wallet loaded. | Test hints. | None is private. The publish hook writes a v1 record, the node id and every live address in it, under a key anyone can compute from the source. The craps hook writes two records in the clear. The claim-and-write hook writes 64 random bytes. | The SSF wallet's coin; for the claim-and-write hook, which needs burner keys on, a test burner. |

Every spend carries fee 0 (`PUBLISH_FEE`, `MAX_FEE_MOJOS`). A listing and a knock expire two eras after they are issued; readers look in the current era and the one before, and count a record only if its block lies inside its own era.

**A station writes nothing when:**
- Chia is off on the computer (§8): no write, no read, no lookup.
- No SSF wallet is loaded: every publishing key is made from the wallet's key. Reads go on. Turning the wallet on in the Bank loads it and starts the publisher in the same run, with no restart (`start_publisher`); turning it off takes effect at the next start.
- A room does not use cards (it is public, it is the welcome room, or its SHARE CARD is off): no knock on a host there.
- The build has no `chia-publish` feature.
- LIST ME is off: no listing and no knock. Turning it off also drops knocks not yet written and stops the node from sending again a listing or knock it had already sent. It withdraws nothing from the chain, and it does not hold the beacon or a v1 room record.
- `SSF_CHIA_FINDABLE=0`: no listing. Knocks still follow LIST ME.
- An era is in its last 14 blocks (`ERA_GUARD_BLOCKS`): no listing, knock or beacon.

## 3. What a station asks full nodes

The node speaks Chia's light-wallet protocol to full nodes (`chia_peer.rs`, `chia_peer_lane.rs`): four connections at most (`MAX_CONNS`), found through the network's DNS introducer (asked through the operating system's resolver), through `chia_peers.json` (full nodes that answered before, 64 at most) and through peer gossip, or pinned with `SSF_CHIA_PEERS`. Each of those full nodes sees the station's IP address. At the handshake each sees a wallet-type client with constant version strings, so Star Station nodes look like one another. Each also sees the client certificate the node made at its start, the same on every connection of that run. The connection is TLS, but the node does not verify the full node's certificate (`AnyServer`), so the encryption keeps a listener on the path out, not a host standing in the middle.

The node subscribes to nothing. It asks again on a 60-second tick, so a peer sees the same lookups repeat for as long as the station is up.

There are two kinds of request (`chia_chain.rs`):
- A **carrier** read (`connect_carrier`) goes to one peer: a connected pin first, else the first connection, and one stand-in if that peer is silent.
- An **agreed** read (`connect`) and every push go to the agreed set: two peers from different sources and network groups, or the pin alone in pin-only mode. A spend whose inputs the chain still shows unspent is handed to the agreed set of that moment again (`spend_live`), which may be other peers than the ones that first saw it.

| What is asked | When | Lane | What it shows the peer |
|---|---|---|---|
| The chain's peak | Each tick with something to read for. Usually it is the peer's own announcement; the node asks only when that is more than 10 minutes old | Carrier | That this IP runs the client. |
| The station's own listing hints, this era and the last | Every beat (32 blocks; `SSF_CHIA_BEAT_BLOCKS`) of a tick with something to read for. A station that does not list asks all the same, unless it has nothing else to read for either: no room that is not public, no card held, no inbox to watch and no knock in its book (`watch_loop`) | Carrier | Which listing hint belongs to this IP. |
| Each contact's listing hints, this era and the last: every peer in `peers.json` with a contact key | Every beat, four times less often while the station is connected to every station that claims the key; 8 keys a tick at most (`MAX_CK_READS_PER_TICK`) | Carrier | The station's contact list, as hints. |
| v1 room hints for each room that is not public, three UTC days | Every beat, four times less often for a room with a connected peer | Carrier | The station's private rooms, as hints. They carry no network tag, and the watcher reads them on mainnet too, so the same bytes are asked on both chains. |
| Inbox hints for each room that shares cards, this era and the last | Every beat | Agreed | Which inboxes this IP watches. |
| The coins of knocks and spends not yet settled | Every tick | Agreed | Coin ids of the station's own writes. |
| The publisher's reads: the peak, the station's own listing, and before each burner write the burner's coins by its puzzle hash and the lobby dish's coins | Each tick while something may be due | Agreed | Which burner address belongs to this IP. |
| The SSF wallet's coins, by its puzzle hash | At each wallet-paid write (§7). With a wallet loaded on a test network, also at every dish status: every 60 seconds in a room that has a faucet dish, every 20 seconds while the dish screen is open, and when the Bank opens or refreshes. Off a test network only at a status that asks for the balance (`status_reads_wallet` in `chia_faucet.rs`): when the Bank opens or refreshes, and at the dish's polls for as long as the Bank is the phone's open app. | Agreed | Which money address belongs to this IP. |
| The puzzle hash of the dish in the room the player is in | With each dish status | Agreed | Which room's dish this IP looks at. |
| After a dial has run out of routes: the host's listing by its contact key, the room's v1 records, and in the welcome room the beacon hint (once in 10 minutes per room at most) | On demand | Carrier | Whom the station is trying to reach. |

For each coin a hint read finds, the node also asks for the spend of that coin's parent, by coin id.

The carrier peer therefore sees, from one IP, the station's whole watch set. The agreed peers see its burner addresses, its inbox hints and every spend bundle in full, and its money address whenever the wallet's coins are read (the row above: on mainnet, when the Bank shows the balance). These are not three separate full nodes: all are picked from the same four connections at most, a pin is in both sets, and without a pin the first connection usually is. So one full node can see all of it together.

Outside the lane, the node also asks a website for its public IPv4 address over plain HTTP by default, at start and every 5 minutes: the first of two, and the second when the first gives no public address (`DEFAULT_IP_ECHO_HOSTS` in `main.rs`; `SSF_EXTERNAL_ADDRS=off` stops it). The register's first row covers it, and turning Chia off does not touch it.

## 4. Who can see what

| Observer | Holds | Can learn |
|---|---|---|
| **A**, anyone with the chain | No key | The lobby dish's address (it is computed from the welcome room's key, which ships in every build: `lobby` in `chia_faucet.rs`), every claim from it and the address each claim paid. Every Star Station dish, by the pinned module hash each claim reveals (`FAUCET_MOD_HASH`). When each record was written and, from its length, its kind. Every beacon's node id. On the wallet path (§7): a station's whole line of writes at one address, and whoever funded that address. A cannot open a listing or a knock, and on the burner path cannot tell which burner is whose. |
| **A+**, many full nodes | A's view, and the time each node first saw a bundle | A guess at the IP a bundle started from. |
| **B**, a card holder | Station X's contact key | X's listing hint for any era, and the key that opens every listing under it: X's node id and its public addresses, each with a flag saying whether the node took an inbound connection there, and the time of every write, week by week, on both networks, for as long as X keeps the same `contact.key`. On the wallet path B can also follow the listing's coin to X's wallet address and its other writes. |
| **C**, a pass holder of a private room | The room key, and the member cards the pass carries | Everything B can, for each member whose card is in the pass. Each such member's inbox hint for that room, so how many knocks were filed there and when; C cannot open them, but on the wallet path each knock's coin shows its knocker's wallet address. On testnet11, that room's v1 records, home-network addresses included. |
| **A host that was knocked on** | Its own node key, the room key | The knock: the knocker's node id and the room, and the knocker's contact key when it was handed out, which makes the host a card holder (B) of the knocker. On the wallet path, also the knocker's wallet address: the knock is a spend of the wallet's coin. |
| **D**, the full nodes the station talks to | The connection | §3. |
| **E**, whoever can read the data folder | The files | §9. |
| **F**, Sage or the Chia wallet on the same 24 words | The words | The SSF wallet's coins at the wallet's own derivation path. Burner keys are made by hashing, not from the wallet's key tree, so they are on no wallet path and F never lists or co-spends a burner coin. (`burner_keys_are_off_every_wallet_path_and_off_the_master` in `chia_burner.rs` pins that for sample listing and knock keys against the master key and the first 1,001 wallet indices, hardened and unhardened; the beacon key has a smaller test of its own in `chia_wallet.rs`.) On the wallet path F sees the coin that pays for writes as an ordinary coin and can spend it. |

The burner path closes the on-chain links for A, B and C. It does nothing about D or E.

## 5. How the writes are kept apart

This is the burner path: the only path off a test network, and on testnet11 the path a node takes with `SSF_CHIA_BURNERS=1` (`burners_of` in `chia_publish.rs`). The stage 4 design that code comments cite by section is not a file in this repository; this section and §6 restate what of it was built.

**Keys** (`chia_burner.rs`, `chia_publish/keys.rs`). W is the SSF wallet's key and G the network's genesis challenge.
- The root R is `blake3::derive_key("ssf-chia-burner-root-v1", W ‖ G)`. It lives in memory only and is made once per run; no new secret is written to disk (the burners' puzzle hashes are: §9).
- A burner key is `blake3::keyed_hash(R, "ssf-chia-burner-v1" ‖ kind ‖ era ‖ slot)`, used as a BLS seed.
- **P(e)**, the listing key: the slot is the era's listing hint. One key per era and per contact key.
- **K**, a knock key: the slot is made from the inbox hint and the host's node id (`knock_slot`). One key per host, room and era. The design keyed it on the inbox hint alone; binding the node id is a departure, so two hosts that share a contact key get two keys, which reads on chain as two knockers under one inbox hint.
- **B**, the beacon key, is `blake3::derive_key("ssf-chia-beacon-wallet-v1", W)`: the same key in every era. It differs per network only because each network has its own wallet words.
- Two stations on the same wallet words share R and B, and so their slots and every knock key. They share a listing key only if they also share `contact.key`.
- A burner key leaks nothing about W, R or another burner (**inferred**: blake3 in keyed mode is a pseudo-random function).
- The publisher's key set (`PublisherKeys`) holds no wallet key off a test network. The process still holds the wallet key there for the Bank and the dish; that the publisher never reads it is pinned by a source-scan test, not by the types.

**Coins** (`chia_publish/claim_write.rs`).
- A key's first write is one bundle of two spends: a lobby dish coin F, claimed with no key, and the gift g, a 1-mojo coin the claim creates at the burner's address and the burner spends at once. The outputs are F's remainder back to the dish (when F held more than the gift), g, and a 1-mojo coin at the burner's address carrying the two memos (hint, body). One signature, the burner's, at fee 0. No coin of the wallet is in it. If a 1-mojo coin the lease does not hold already sits at the key's address, the write spends that coin and claims nothing (`write_slot`): the gift of a claim that a peer pushed on its own, or a coin someone else paid there (§6, 5).
- A rewrite spends the key's 1-mojo coin to a 1-mojo coin at the same address. A knock key writes once.
- Before it signs, the builder refuses a bundle that breaks a rule (`broken_rules`): exactly one input at the burner's address (R1); no input that is neither the burner's nor a dish's, so never a wallet coin (R2); every output is at the burner's address, or a dish's remainder back to its own dish (R3); one dish coin at most (R4); the burner's spend makes one 1-mojo coin and nothing else, and nothing is left over as a fee (R5); no dish but this network's lobby (R6); the burner's input is a coin of exactly 1 mojo (R7).
- A fuse stops funding after 16 gifts in an era (`MAX_GIFTS_PER_ERA`), so a fault cannot drain the dish through one station. The count is a local file, `gift_fuse.json`: a copy of the folder, or a folder that lost the file, starts its own 16.
- The dish coin is picked at random among the ready ones. Burner coins are never swept.

**Timing** (burner path only).
- **T1.** The era's first listing is due at a secret slot in the era's first day: `slot(kind, era)`, a number from 0 to 4,607 blocks made from R (`SLOT_BLOCKS`).
- **A newcomer** writes at its next tick instead. The node decides this from its one local mark in `publish_marks.json`, not from the chain: it waits for the slot only when that mark is last era's, its own, and confirmed or seen on chain.
- **T2.** A node that first sees an era after its slot waits a fresh random 0 to 192 blocks, about an hour at most (`LATE_START_MAX_BLOCKS`). A restart draws again. Not covered: a run that saw the era before its slot and then slept past it writes at its next tick after waking.
- **T3.** An address change is written once 10 minutes have passed since the station's last write (not since the change), and then 0 to 32 more blocks (`CHANGE_JITTER_MAX_BLOCKS`). A change since last era's listing takes the slot's place: that station's first listing of the era leaves 0 to 32 blocks after it first sees the era, not at its slot. The retry of a write that did not confirm within 30 minutes is not jittered, nor is the rewrite of a write the chain dropped.
- **T4.** A burner's push lands at least 32 blocks after a spend from another of the station's keys: it waits 32 to 64 blocks from the other's landing (`SPACING_MIN_BLOCKS`, `SPACING_MAX_BLOCKS`). Writes from one key are not spaced from each other (`WalletLease::other_spends`); an era's listing rewrites are one line of coins in any case (§6, 9). A spend stuck for more than 20 minutes holds the others no longer, and a restart forgets the draw. Only a burner's push is spaced. A spend the SSF wallet pays for on testnet11 (a v1 room record, a GIVE) is not, so it can land right beside a burner's.
- **T5.** The beacon has a slot of its own and obeys T4.
- Kept from before: one try per 60-second tick, in the order listing, knock, beacon.

**Another copy.** A spend of the listing key's coin that this station's lease never parked is taken to mean that another copy of the station is writing (the same wallet words and contact key); a lease file that was lost or restored from a backup can look the same. Listing, knocks and beacon pause for two hours, and until the next era the second time (`chia_publish/foreign_pause.rs`). Only the listing key is watched, so a copy that only knocks or beacons is not noticed.

**The lease.** Each spend is parked and its signed bundle saved in `wallet_lease.json` before it is pushed, per paying key. While the chain still shows the spend's inputs unspent, the bundle is handed to the peers again. Once they are spent it is kept until the spend is 32 blocks deep (`SETTLED_DEPTH`), and goes out again only if a reorganisation undoes the spend. With LIST ME off, a listing's or a knock's saved bundle is not handed out again; the beacon's is, except from a lease file an older build wrote, where every spend is held as LIST ME's. Off a test network a saved bundle of the SSF wallet's own never goes out again.

## 6. What stays visible

What is still true with all of §5 working.

**Funding and shape**
1. A burner's first coin is a gift from the lobby dish, unless a 1-mojo coin was already waiting at its address (5). The claim shows the burner's address, the dish and the height, and the dish is recognisable by its module hash. Anyone can list every burner and count Star Station's writers per era. Which burner is whose is not shown.
2. Whoever gives the mainnet lobby dish its coin is tied to Star Station for ever. The plan is a quiet gift from Sage at stage 5.
3. The shape of a write is recognisable (**inferred** from the shapes): one coin in and one 1-mojo coin out at fee 0, two memos, a 32-byte hint and a body of 360, 392 or 320 bytes, and claims from the pinned module. The body's length shows the kind: each kind has one fixed length, and the three are not padded to a common one.
4. One 1-mojo coin per key stays on chain for ever.
5. Anyone can pay a burner's address. A coin of any other amount is never written from, but a stranger's coin of exactly 1 mojo is, oldest first, and then becomes the parent of the station's next write. That ties the burner to the stranger's coin and says nothing about the station.
6. Anyone who holds a pending bundle can attach a fee coin of their own and replace it (**inferred**: Chia's replace-by-fee takes a superset bundle with a higher fee, and BLS signatures aggregate without the signer). Same effect as 5.
7. The dish claim is unsigned and names its recipient in the clear. A full node the bundle was pushed to can lift the claim, re-solve it to its own address and push that first; the station's bundle then dies and is built again with another dish coin. Anyone can also take every ready gift. These deny service; they leak nothing.

**Time**

8. Every write is a dated public event. T1 to T5 hide the era's start and the pairing of one station's writes. They cannot hide a player who is online at the same hours each week, or an IP that changes at the same hour. The gaps named in §5 are real: a machine that slept past its slot, a station whose address changed since last era, an unjittered retry, a draw forgotten at a restart, and on testnet11 a wallet-paid spend that is not spaced.
9. All of an era's listings come from one key, so its rewrites are linked to each other. Their count (9 at most, by the node's own mark) shows how often the station wrote that era: its address changes, a change of an address's inbound flag, and retries.
10. "k knocks were filed under one hint in era e" is visible to anyone, and a pass holder who holds the host's card knows which host and room that is. A station knocks on a host once an era at most, so k is close to the number of stations that knocked.
11. After a knock confirms at height h, both sides dial at h + 10n blocks for n from 1 to 6, then every 320 blocks, for between one and two eras (`RENDEZVOUS_NEAR_STEP`, `RENDEZVOUS_FAR_STEP` in `chia_knock.rs`). Someone who watches a station's network traffic can match its dials to the chain.
12. With few stations on mainnet, counts and times can pair a station's weeks statistically. The crowd grows with players.

**Observers who hold more than the chain**

13. The full nodes the station talks to (D) see its IP with everything in §3: its burners, its beacon, the dish, the hints of the contacts it reads, and its money address once the Bank shows the balance (on a test network at every dish status). No key scheme removes this. A full node of one's own (`SSF_CHIA_PEERS` with `SSF_CHIA_PIN_ONLY=1`) keeps it on one's own machine. Turning Chia off removes it.
14. A card holder reads a station's whole address history for as long as the station keeps its contact key, by design. There is no control in the game that changes the key: deleting `contact.key` makes the node mint a new one at its next start, which stops this for the future only and makes every card handed out before stale.
15. A private room's pass carries the room key, the sender's own card while SHARE CARD is on, and the member cards that came in the pass the sender joined by, 64 at most. So every pass holder is a card holder of those members, and can count the knocks filed for them in that room.
16. A knock hands the knocker's contact key to the host, when the knocker's card may be handed out in that room.
17. Knocks have no forward secrecy. They are sealed to a key made from the host's long-term node key, so whoever later gets `iroh_node_id.key` and the room key can open every knock ever sent to that station for that room.
18. The data folder (§9): the wallet key gives every burner key, and the state files tie the station's writes together.
19. The node's own log and its local page (§9).

**Across networks and over time**

20. `contact.key`, the card key and the node id are one for both networks. On mainnet the genesis challenge is mixed into every v2 hint and seal (`network_tag` in `chia_lane.rs`), which stops a match by someone with no key. A card holder can still find a station on both chains.
21. A beacon writes the same node id on any chain it beacons on, from one key in every era: one line of coins at one address. The node refuses a beacon on one network while this folder beaconed on the other in the last 14 days (`BEACON_GUARD_SECS`).
22. v1 room hints have no network tag and are still read on mainnet, so the full node the station asks on each chain sees the same room hints.
23. What is already written stays: on testnet11, every write the SSF wallet paid for at its one address (decision D5 accepted that there).

## 7. testnet11 today, and mainnet

| | testnet11 in a release build | testnet11 with `SSF_CHIA_BURNERS=1` | mainnet (development build only) |
|---|---|---|---|
| Who pays for a listing and a knock | The SSF wallet: its largest free coin, recreated whole at its own address at fee 0 (`publish_memo_on`, `build_publish_bundle`). Every listing, every knock and the money sit at one address. They are one line of coins for as long as the same coin stays the wallet's largest free one; a larger deposit becomes the parent of the next write (`find_spendable_coin_on`). Either way, whoever paid the wallet is tied to its writes. | Burner keys, funded by the lobby dish. If the wallet already wrote this era's listing, the burner writes nothing under that hint and the listing is not rewritten until the next era, so that one hint does not get two payers (`hint_rule_holds`). The rule reads the node's own mark, not the chain, so it holds only while `publish_marks.json` survives. | Burner keys only. `refuse_money_memo` refuses any memo spend from the wallet's key. |
| Timing T1 to T5 | None: the wallet writes at the first tick of an era, and a beacon lands just after the listing. | On. | On. |
| LIST ME starts | On. | On. | Off, until the player taps LIST ME and then CONFIRM. |
| v1 room records | Written for a room whose Chia mesh switch is on, paid by the wallet. | The same, still paid by the wallet and not spaced from the burner's writes. Both follow the same address change, the wallet's at once and the burner's 10 minutes or more later, which pairs the listing key with the wallet's address by time. | Never written (`publishable_rooms`); the switch is hidden. They are still read. |
| Beacon, if lit | From B, which the operator funds by hand. | From B, funded by the lobby dish. | From B, funded by the lobby dish. |
| TAKE A MOJO, GIVE | Yes. | Yes. | Refused, and nobody claims at any dish but the lobby (`dish_claim_refusal`). |
| Test hooks | With their variables. | With their variables. | The three that write are ignored, with one line saying so. `SSF_CHIA_RESOLVE_TEST=1`, which only reads one fixed test hint, still runs. |
| The 24 words | Shown by the desktop app in its own window. A page shows them only in a run the desktop app did not start, when the page's origin is listed in `SSF_BANK_DEV_PAGES`, and until the words are marked saved. | The same. | The desktop app's window only (`page_allowed`). A new wallet is made only while the app's channel is live (`may_mint`). |
| Hints and seals | No network tag. | No network tag. | The genesis challenge mixed in; the lobby dish has its own address. |

So on testnet11 today nothing in §5 is in effect unless the operator sets the flag, and a card holder can follow a station's listing to its wallet address. Making burners the default on testnet11, and deleting the v1 writer, is the next code step after the two-machine drill (stage 4 PR 12).

## 8. The switches

| Switch | Where | Default | Stops | Does not stop |
|---|---|---|---|---|
| **CHIA off** | SETTINGS, NETWORK, the CHIA row (`chia_lane_off.json` at the data root, one switch for every network), or `SSF_NO_CHIA_LANE` set to anything but empty or `0` (`chia_strict.rs`) | Chia on | Everything in §2 and §3: no introducer lookup, no dial, no read, no write, and no wallet loaded at a start. Off takes effect at once; on at the node's next start. A wallet that was loaded before an in-game off stays in memory until the node stops, and publishes nothing. It wins over every other switch here. | iroh, the DHT, mDNS, relays and the public-IP lookup, which have their own switches, and the exchange of contact cards between stations. A request already being written when the lane closes may still go out, and so may a name lookup already at the resolver. |
| **LIST ME** | SETTINGS, NETWORK, under the PHONE BOOK row (`chia_listing.json`, per network) | On for a test network, off for mainnet | The listing, knocks, and sending either again. | The beacon, v1 room records, every read, and what is already on chain. |
| `SSF_CHIA_FINDABLE=0` | Environment | Unset | The listing. | Knocks, which follow LIST ME alone. |
| **SHARE CARD** | Per room (the room's Share Card row) | On, in private rooms only | Handing this station's card to that room's members, filing theirs, reading knocks for that room, and knocking on a host there (`may_use_cards` in `chia_rooms.rs`). | Cards already handed out, which keep working while the contact key stays. |
| `SSF_CHIA_SHARE_CARD=0` | Environment | Unset | Handing out this station's card, in every room and in a knock. | Reading knocks, and writing them: a knock then goes out without the station's contact key and still names its node id. |
| **Chia mesh** | Per room, on a test network | Off | Nothing; turning it on writes v1 room records. | |
| `SSF_CHIA_BEACON=1` | Environment | Unset: no beacon | Nothing; setting it lights the beacon. | |
| `SSF_CHIA_BURNERS=1` | Environment, test network only | Unset: the wallet pays | Setting it moves listing, knocks and beacon to the burner path. Off a test network that path is the only one. | v1 room records, which the wallet still pays for. |
| `SSF_CHIA_WATCH=0` | Environment | Unset: the watcher runs | The watcher's reads on every beat and, with it, knocks. | The reads a failed dial makes, and the listing. |
| `SSF_CHIA_PEERS`, `SSF_CHIA_PIN_ONLY` | Environment | Unset: public full nodes | With both set, every request goes to the operator's own full node and no other. Pin-only takes `1`, `true`, `on` or `yes`. | With no pin set, pin-only is ignored without a line saying so. |
| **The SSF wallet** | The Bank's switch (`chia_wallet.json`, per network); `SSF_CHIA_LANE` holds it on (`1`) or off (any other value that is not empty) | Off until the player makes a wallet | With no wallet on, every write. Turning it on in the Bank loads the wallet and starts the publisher at once, in the same run. Turning it off takes effect at the node's next start; until then the wallet stays loaded and the node goes on writing. | Reads. |
| `SSF_CHIA_AUDIT=1` | Environment | Unset | Nothing; setting it prints the address and puzzle hash of the station's burner keys in the node's own log, for the review in §10. Never key bytes. | |
| Build features | `cargo build` | Release builds: `chia-publish`, no `chia-mainnet` | Without default features there is no lane; without `chia-publish`, no write; without `chia-mainnet`, the node stops at `SSF_CHIA_NETWORK=mainnet`. | |

## 9. On this computer

The data folder is the node's working directory. Its secret and state files are written owner-only (mode 0600) on Linux and macOS (`write_private` in `private_file.rs`); on Windows the node sets no rule of its own and the folder's own permissions apply. Three kinds of file are written without that step: `wallet_lease.json`, `chia_peers.json` and the room documents in `rooms/`. On mainnet the first two sit in `chia-mainnet/`, a folder the node makes owner-only (mode 0700, `make_state_dir`); on testnet11 they sit in the data root.

| File | Where | Holds |
|---|---|---|
| `iroh_node_id.key` | Data root, both networks | The node's secret key. The card key that opens knocks is made from it. |
| `contact.key` | Data root, both networks | The contact key: 32 random bytes. It finds and opens every listing of this station. |
| `peers.json` | Data root, both networks | Up to 512 other stations: node id, their contact key and card key, the rooms each was met in, when it was last reached, knock times. |
| `rooms/<room id>.cap` | Data root | A room's key and its switches (Chia mesh, public or private, SHARE CARD). |
| `rooms/<room id>.bin` | Data root | The room's document, with the room key in it. Written without the owner-only step. |
| `chia_lane_off.json` | Data root | The CHIA off switch. |
| `chia_identity.json` | Per network | The SSF wallet: the entropy of its 24 words. In the clear (`protect: "none"`) until the player marks the words saved. The node then locks it with DPAPI on Windows or the login keychain on macOS. It stays in the clear on Linux, with `SSF_WALLET_AT_REST=none` (which leaves a file already locked as it is), and whenever the lock does not land: a locked keychain, a folder on exFAT or FAT, another node holding the file. The log then says the file "stays in the clear for now", and the node tries again at its next start (`chia_at_rest.rs`, `chia_wallet.rs`). An older `chia_identity.seed`, and the `chia_identity.seed.retired-<time>` copy the node keeps when it retires one, is a raw seed. |
| `chia_wallet.json`, `chia_words_saved.json`, `chia_listing.json` | Per network | The wallet's switch, the mark that the words were saved, LIST ME. Nothing secret. |
| `wallet_lease.json` | Per network | Parked coins and, for each spend still settling, the whole signed bundle and the address that paid. Written without the owner-only step. |
| `publish_marks.json`, `beacon_mark.json` | Per network | The last listing and beacon: era, hint, coin id, node id, the paying address, and for the listing its address set in the clear. |
| `knocks.json` | Per network | Knocks sent (host, room, era, hint, coin, paying address) and knocks received (from whom, room, era), in the clear: two eras of them, 256 of each at most. |
| `gift_fuse.json`, `foreign_pause.json`, `beacon_pushed.json` | Per network | The puzzle hashes of the burners funded this era; the other-copy pause; the date of the last beacon push. |
| `chia_peers.json` | Per network | The full nodes this station used. Written without the owner-only step. |

"Per network" is the bare name on testnet11 and `chia-mainnet/<name>` on mainnet (`ChiaNet::path` in `chia_network.rs`).

**What a copy of the folder gives.**
- The wallet, while its file is in the clear (or from a legacy seed), and with it every burner key the station ever used: R needs only the wallet key and the public genesis, and a listing key also needs `contact.key`.
- Every knock ever sent to the station: `contact.key` and the room key find them, and `iroh_node_id.key` opens them. `knocks.json` already names the ones received in the last two eras.
- The station's own listings (`contact.key`) and every listed contact's (`peers.json` holds their keys).
- The contact graph: `peers.json`, `knocks.json` and `rooms/`.
- The link between the station's burners, which the chain does not show: the paying addresses in the mark, knock, lease and fuse files.

**The 24 words do not restore a station.** They bring the money back in Sage or the Chia wallet. The node has no restore-from-words screen (`Mnemonic::parse_normalized` is called only in tests), and the words do not bring back `iroh_node_id.key`, `contact.key` or `peers.json`.

**The log.** By default the node prints, at start, the station's node id and the SSF wallet's receive address and key fingerprint, which ties the node id to the money address in one file. It also prints the first 16 hex digits of each hint it writes under, the node ids of hosts, knockers and contacts (some shortened, a host's in full when a dial runs out of routes), room ids, the address of each full node it dials, a coin id on TAKE, and on a failed wallet-paid write the wallet's puzzle hash. It never prints the address or puzzle hash of a listing key or a knock key unless `SSF_CHIA_AUDIT=1`. The beacon key is the exception: with the beacon lit on testnet11 and burners off, the start line prints its address so that the operator can fund it, and a failed beacon write prints its puzzle hash. It is the same key on the burner path.

**The local page.** The node answers `/api/fingerprint` on 127.0.0.1 with, among other things, the node id, the wallet's receive address while a wallet is loaded, and the state of the listing, the wallet and the switches. The allowlist of origins decides which browser pages may read it; any program on the computer can. On a test network, in a run the desktop app did not start and only where the operator listed a page in `SSF_BANK_DEV_PAGES`, any program on the computer that sends that page's origin is answered with the 24 words until they are marked saved (`app_page` in `chia_wallet_switch.rs` names this as a known gap, accepted for testnet).

**Outside the folder.** The page keeps the station's own signed contact card, with the contact key in it, in the browser's or the desktop app's local storage (`NODE_CARD_KEY` in `network/roomCap.ts`), so that the passes it mints can carry it.

## 10. The sign-off review

A one-off developer review of what the chain actually shows. The game never depends on an explorer, and nothing in the register changes for players.

**Who and when.** The author of the gate and one person who did not write it; Dorkmo signs. First on testnet11, after the drill has crossed at least two era boundaries (about 15 days: one boundary cannot show that eras do not link). Then on mainnet development builds, across at least one boundary. Stage 5 waits on the mainnet sign-off.

**Tools.** The reviewer's own full node (`get_coin_records_by_puzzle_hash`, `get_coin_records_by_hint`, `get_coin_record_by_name`, `get_puzzle_and_solution`), and one public explorer looked at by hand for the casual view. The explorer learns what is looked up, so it is opened from a machine and a network the drill nodes never use.

**Inputs.** From each drill node: `publish_marks.json`, `knocks.json`, `beacon_mark.json` and `wallet_lease.json` (coin ids, hints and paying addresses, no keys); the Bank's RECEIVE address; the node ids; the machines' public IPs; a test card to act as a card holder. The burner and beacon addresses come from the node's log under `SSF_CHIA_AUDIT=1` (`chia_publish/audit.rs`). A run with the switch on names the listing keys of this era and the four before (`AUDIT_ERAS_BACK`), on the burner path while the station may list, and the beacon key when the wallet loads with the beacon on; so one run at the end of a drill of up to five eras gives all of those. A knock key is named once, when it writes, so for the knocks the switch has to be on during the drill.

**Checks** (pass or fail, with heights and coin ids).

| # | Look up | Pass when |
|---|---|---|
| 1 | The money address, from the moment burners are on | No coin there carries a memo. No coin goes to or comes from a burner or the dish. On testnet11 this holds only with Chia mesh off in every drill room, since the wallet still pays for v1 records there. |
| 2 | Each burner's first coin | Its parent is the gift g, and g's parent is a lobby dish coin. One case is allowed otherwise: a first write from a 1-mojo coin someone else paid to the address (§6, 5). That coin's ancestry is then written down, and it leads neither to the money address nor to another of the station's keys. |
| 3 | Every burner spend | One burner input to one 1-mojo coin at the same address, fee 0, memos of 32 bytes and 360, 392 or 320 bytes. A key's first write also spends a dish coin in the same bundle, unless its 1-mojo coin was already at the address (a claim a peer pushed on its own, or a coin someone else paid there). No other output but the dish's remainder. |
| 4 | P(e) against P(e+1), and each knock key against P(e) | No shared address and no shared parent. No burner coin is the parent of another key's coin. The amount is not counted: every burner coin is 1 mojo by rule (R5, R7), the same for every key of every station. |
| 5 | Hints | Each era's listing hint differs. On mainnet: no v1 hint for the drill rooms, nothing under a test hook's hint, and the mainnet hint for one contact key and era differs from testnet11's. |
| 6 | Memo bodies | The node id and the drill IPs, as text and as bytes, appear in no listing or knock body. Only the beacon carries the node id, by design. |
| 7 | The lobby dish's history | Its claims from the drill nodes pay burners only. On mainnet, no claim to a money address and none at another dish. |
| 8 | Timing, each era | A station that listed last era, kept its addresses and was up before its slot came writes its first listing in the era's first day or just after it (a slot is one of the day's 4,608 blocks, and T4 can hold a write a little longer), not at the boundary and not together with the other drill stations'. A first listing that falls elsewhere is written down with the §5 case that explains it (a newcomer, a late start, a machine that slept past its slot, a changed address); one that no case explains fails. Two writes of one node from different keys, the beacon's included, land at least 32 blocks apart, unless the earlier one was stuck in flight for more than 20 minutes. Writes from one key are not spaced from each other. The drill makes no wallet-paid spend (no v1 record, no GIVE), since those are not spaced. |
| 9 | As a card holder | Every era's listing opens and holds public addresses only, 9 writes an era at most. No lineage path from a listing coin reaches the money address. |
| 10 | Sage on the node's 24 words | It shows money coins only: no burner and no 1-mojo dust. |
| 11 | A run with Chia off | A packet capture shows no connection to a Chia port and no lookup of the introducer, and no per-network Chia file is created (`contact.key` and `peers.json` do not count: the node keeps them with Chia off too). The CI test `tests/strict_lane.rs` covers part of this: with a pinned local listener it sees no connection and none of the node's `chia` state files. It runs in pin-only mode, so it cannot show the introducer lookup; the capture has to. |
| 12 | The peer view | What each node asked its peers is written down against §3. A note, not pass or fail. |
| 13 | What stays visible | §6 still describes what the reviewer saw. Any surprise blocks stage 5. |

**Record.** `brainstorming/REVIEWS/REVIEW-<YYYYMMDD>-P8-signoff.md`: the table, coin ids and heights, and Dorkmo's yes.

## 11. Open questions and known gaps

**The owner's to decide.** Work has gone ahead on these defaults; each can be reversed.
- No fallback to the SSF wallet when the lobby dish is dry, and no writing from last era's key. Either would link what §5 keeps apart.
- No sweep of 1-mojo burner coins, and no SWEEP for stray amounts yet.
- Fee 0 only. A 1-mojo coin cannot pay a fee, and a second input would be a link.
- `contact.key`, cards and `peers.json` stay shared by both networks (§6, 20).
- No RESTORE FROM 24 WORDS yet, and no forward secrecy for knocks yet (§6, 17).
- Records are not padded to one size (§6, 3).
- The ten calls LIST ME made, listed in [#413](https://github.com/Bella-Addormentata/StarStationFurlong/pull/413)'s description. Among them: a switch file the node cannot read counts as off on every network, and UNLIST ME needs no CONFIRM.

**Gaps this document's check against the code found.** Each is a place where the code does less than a reader might assume. Most show only to the full nodes a station talks to or to someone at the computer; the timing ones show on the chain.
- On mainnet the publisher never reads the money address, and the dish's own polls no longer do. The Bank still does when it shows the balance: on open, on REFRESH, and at the dish's polls while it is open. The two agreed full nodes of that moment then see the money address and the burner addresses from one IP. A balance needs a read; only a full node of one's own, or reading the balance through other peers than the burners', would close this.
- LIST ME does not hold the beacon or a v1 room record, and with LIST ME off the watcher still asks a full node for the station's own listing hints, except on a station with nothing else to read for (§3).
- v1 room hints are still read on mainnet, untagged (§6, 22). The v1 writer goes in stage 4 PR 12. `chia_lane.rs` says v1 stays readable for two eras, but no code ends the reads yet.
- A machine that slept past its listing slot writes as soon as it wakes, and a station whose address changed since last era does not wait for its slot (§5, T2 and T3).
- With burners on on testnet11, a room's v1 record is still paid by the wallet and not spaced, which pairs the listing key with the wallet's address by time (§7). It goes with the v1 writer.
- The hint rule and the gift fuse rest on local files, not on the chain (§5, §7).
- `SSF_CHIA_RESOLVE_TEST=1` still reads a fixed test hint on mainnet.
- The default log prints the wallet's receive address, and its puzzle hash on a failed write.
- `wallet_lease.json` (signed bundles and the addresses that paid), `chia_peers.json` and the room documents are written without the owner-only step. On testnet11 the first two sit in the data root.
- Pin-only mode with no pin is ignored silently.

## 12. Where this comes from

- Decision D5 of [#231](https://github.com/Bella-Addormentata/StarStationFurlong/issues/231) (2026-10-11): pseudonymity on testnet11 is accepted; mainnet waits for burner keys that are never the money key.
- [The ChiaHub review, §7 "Privacy & permanence"](../../brainstorming/REVIEWS/REVIEW-20260710-ChiaHub.md): the rule that publishing keys are apart from the holding wallet, and that the chain never forgets.
- The stage 4 item in [TODO.md](../../TODO.md) lists the gate's PRs and what remains; [CHANGELOG.md](../../CHANGELOG.md) describes each.
- [The External Infrastructure Register](ExternalInfrastructureRegister.md): the hosts and networks a build can contact, the Chia rows among them.
- [01-Architecture.md](01-Architecture.md): where the lane sits in the node.
