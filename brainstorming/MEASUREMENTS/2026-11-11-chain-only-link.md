# Chain-only link: the two-computer drill on testnet11, 2026-11-11

> **What this is:** the record of the acceptance test for the Phone Book's hole punch ([#231](https://github.com/Bella-Addormentata/StarStationFurlong/issues/231), phase P4, with the knocks of P6b). Two home computers on two different internet connections, with no relay, the DHT and mDNS off and no forwarded port in use, were to find each other through the Chia chain alone: first on a first visit by invite, then again after one of them had been away.
>
> **Result:** they did, both times. Getting there took four changes, each found by a run that failed or was slow, each merged during the drill: [#423](https://github.com/Bella-Addormentata/StarStationFurlong/pull/423), [#424](https://github.com/Bella-Addormentata/StarStationFurlong/pull/424), [#427](https://github.com/Bella-Addormentata/StarStationFurlong/pull/427) and [#428](https://github.com/Bella-Addormentata/StarStationFurlong/pull/428).
>
> **How to read it:** times are UTC. "A" and "B" are the two computers. Computer names, IP addresses, wallet addresses and invites are left out; "v4" and "v6" stand for an IPv4 and an IPv6 address; node and room ids are cut short. Where a statement is an inference and not a log line, it says so.

## 1. The variants, in one table

| # | What was tried | Code | Result | What the logs show |
|---|---|---|---|---|
| 1 | Chain reads only, each computer alone, a new empty wallet (no coin) | main at `0eae55e` | Passed on both | Two agreeing full nodes 6 to 11 s after the introducer's answer on a first run, under 2 s after a restart. IPv6 full nodes connected from both. |
| 2 | A newcomer's own listing, written from a burner key the lobby dish pays for | `6524a47` (#423's branch) | Written and confirmed on both, and on a GitHub runner | Push to confirmation: 9 min 10 s on B, 5 min 4 s on A. No money of the station's own was needed. |
| 3 | First visit by invite: guest A, host B. No relay, DHT off, no forwarded port in use | `6524a47` | **No link** | The guest's knock was written, confirmed and read by the host 22 s later. Both sides kept the six set heights within a minute of each other. The host held "at 0 public addr(s)": a first visitor's knock named no address, and with the DHT off the host had nowhere to send a packet. |
| 4 | First visit again, roles swapped: host A, guest B with a new identity. The knock now carries the knocker's public addresses, sealed for the host | `8cf8e7f` (#424) | **Linked** | At the first set height after the knock's confirmation, on attempt 1 on both sides. 38 min from the guest's start; 5 min 18 s from the knock's confirmation. |
| 5 | Break and relink: host A stopped for 6 min 25 s and started again at the same addresses, cards held both ways | `8cf8e7f` | Linked again, after **1 h 32 min** | Seven holds by contact key on the host and eight on the guest never overlapped. The link came at the knock's next far set height (they come every 320 blocks, about two hours). |
| 6 | The same break with hold slots: a failed hold's next try starts at a block height both sides work out alike | `917feca` (#428) | Linked again, **7 min 26 s** after the host's start | The host's first hold after its start missed. Its next hold and the guest's both began at the pair's slot boundary (height 4952031 in both logs), and the host's dial connected on attempt 1. |

Not run: the plan's section D beyond the knock (a beacon in the welcome room, Share Card off, the roles swapped with cards on both sides), a packet capture (no capture tool was on either computer, and none was installed), and a run of #427 on testnet11.

## 2. Setup

| | Computer A | Computer B |
|---|---|---|
| Connection | A home connection: public IPv4 and public IPv6 | Another home connection: public IPv4 and public IPv6. Its router forwards one UDP port for an installed game; the drill's nodes ran on other ports |
| Windows Firewall, for the drill's node | Blocks unasked incoming TCP and UDP (the prompt went unanswered, which is what a player who closes it gets) | Allows incoming (the owner pressed Allow) |
| System and build | Windows 11 Pro 25H2; `cargo build --release --features chia-publish` with the MSVC toolchain | The same |

- Each computer ran three things from a folder of its own: the node, the page's dev server on loopback, and a headless browser driven by `scripts/drill-link.mjs` as the one player.
- Both nodes, from variant 2 on: `SSF_CHIA_LANE=1 SSF_CHIA_BURNERS=1 SSF_NO_DHT=1 SSF_NO_MDNS=1 SSF_CHIA_BEAT_BLOCKS=2`, no relay configured. So the only things the two had in common were the Chia testnet11 network and the introducer's DNS answer.
- An invite was carried from host to guest by hand, as a player would send it over any channel of their own. It was never sent over a path between the two nodes.
- The control held throughout: with no relay, no DHT and no forwarded port, a one-sided dial between these two connections never connected, on IPv4 or IPv6 (variant 3: 32 attempts in 24 minutes; variant 4 before the knock: 56 attempts).

## 3. Variant 1: chain reads

| | A, first run | A, restart | B, first run | B, restart |
|---|---|---|---|---|
| First chain request after start | 60 s | 60 s | 60 s | 60 s |
| Full nodes the introducer named | 6 | 7 | 9 | 7 |
| First full node connected, after the introducer's answer | 5.8 s | within 1.3 s | 0.4 s (IPv6) | within 1.6 s |
| Two full nodes agreeing | about 10.5 s (inferred from the wallet's verdict) | 1.6 s | 5.9 s | 1.6 s |
| Full nodes that disagreed or were let go | none | none | none | none |

- Full nodes that pass the handshake and then close while the node asks for block 0 were seen on both computers (4 of 9 dialled on A's first run, 2 of 6 on B's). It matches a full node that already holds its limit of wallet connections (inferred from the Chia source, not confirmed). It cost nothing: the pair still formed within seconds.
- A node waits one minute after its start before its first chain request, also after a restart with stored full nodes. Which timer sets that minute is not traced.
- Found here: a second node could not start beside a running one, because the page's port had no setting. Fixed by `SSF_WT_PORT` ([#423](https://github.com/Bella-Addormentata/StarStationFurlong/pull/423)).

## 4. Variant 2: the first writes

- The lobby dish on testnet11 held one coin of about 1.0002 TXCH from 02:02Z (height 4947911).
- A GitHub runner wrote the first listing this code has landed on a real chain, from a burner key the dish paid for: "published for era 153 (write 1)", then "own presence confirmed at height 4948026".
- B (the host of variant 3): listing pushed 03:08:01, confirmed at height 4948116 at 03:17:11. A: pushed 03:27:33, confirmed at height 4948163 at 03:32:37, "found unmoved 32 blocks deep, final" at 03:46:08.
- **A busy chain.** Some pushes were refused with `INVALID_FEE_TOO_CLOSE_TO_ZERO`. By the Chia full node's source (2.7.5, `mempool_manager.py`) a full node gives that only while its mempool is full and the transaction pays under 5 mojos per unit of cost. The dish's gift is 1 mojo, so a burner's write pays no fee: it is taken while a full node has room and refused while it has none. On this evening the same kind of write was refused by some full nodes and farmed within minutes through others. The node says "the chain is busy" and tries again.
- One coin in the dish pays one gift per 32 blocks (about ten minutes), so two newcomers at the same dish are about ten minutes apart. A node also keeps 32 to 64 blocks between two of its own burner writes.

## 5. Variant 3: a first visit with no link, and why

Guest A, host B, code `6524a47`.

| Time | Side | What |
|---|---|---|
| 03:26:55 | guest | The host's card filed from the invite; 03:27:26 the host's listing read from the chain by its contact key (3 public addresses), 31 s after the guest's first chain request |
| 03:27:26 to 03:34:28 | guest | 8 plain dials and one 180 s hold at the listed addresses: all timed out. "unreachable by every path — a knock is queued" |
| 03:34:42 to 03:52:25 | guest | The knock "waits its turn": 18 minutes, the spacing between a node's own listing and its next write |
| 03:52:25, 03:53:26 | guest | The knock refused twice: "the chain is busy (a full mempool refused its zero fee)" |
| 03:54:27 | guest | Knock pushed on the third and last attempt; confirmed at height 4948245 at 04:01:41 |
| 04:02:03 | host | "ChiaHub inbox: … knocked for room … (confirmed at height 4948245) — dialing it back on the schedule" |
| 04:05 to 04:26 | both | Six holds each at the six set heights (ten blocks apart). The guest's began 04:05:51 to 04:23:18, the host's 04:05:09 to 04:23:41. The guest dialled the host's 3 listed addresses. The host held "at 0 public addr(s) (knock rendezvous: they knocked)": every attempt failed with "No addressing information available" |

**Cause.** A knock named the knocker's contact key only where the knocker may hand its card out, which needs the room known to be private on the knocker's side. A first-time guest cannot know that: the room's doors reach it only over the link it does not have yet. So the knock carried the guest's node id and nothing to dial, and the host's dial-back would have asked the DHT, which was off. By the chain alone, the Phone Book as built linked only computers that had met before.

**Fix:** [#424](https://github.com/Bella-Addormentata/StarStationFurlong/pull/424). Every knock carries the knocker's public addresses of that moment, sealed for the host alone, in space the record already had. The owner chose this on a decision card ("Carry addresses").

**A second fault on the same night, on the host.** From 04:30:00 to the last read in its log (05:52:46; a Windows Update restart ended the run a minute later) every inbox read failed, 76 in a row: "fewer than two agreeing full-node peers reachable (4 connected; …)". The set heights were over by then, so it did not cause the missing link, but a host in that state reads no knock. Cause, from the log and `chia_peer_lane.rs`: a pair needs one full node the introducer named in this run; with four connections and none of that kind the node dialled nothing more for 83 minutes, and its waiting list let gossip push out the introducer's addresses. **Fix:** [#427](https://github.com/Bella-Addormentata/StarStationFurlong/pull/427): an address the introducer names always gets a place and keeps it, and a node with no introducer-named full node connected asks the introducer again after five minutes, not thirty. Proved by tests; it has not been run on testnet11 by itself, but the builds of variant 6 carry it and logged no failed read.

## 6. Variant 4: the first visit that linked

Host A in a new private room; guest B from an empty folder, so a node identity and a wallet the host had never heard of, on a port nothing had dialled before. Code `8cf8e7f` (#424).

| Time | Side | What |
|---|---|---|
| 18:45:10 | guest | Node started |
| 18:45:45 | guest | The host's card filed from the invite; 18:46:13 its listing read (3 public addresses) |
| 18:46:18 | guest | Own listing waits: "the chain is busy … retry in 5 min"; pushed 18:51:18; confirmed at height 4951166 at 18:58 |
| 18:45:45 to 19:15 | guest | 56 dial attempts at the host's listed addresses (the plain ladder, a 180 s hold, three holds by contact key): none answered |
| 18:53:18 | guest | "unreachable by every path — a knock is queued"; it waits its turn behind the listing |
| 19:13:42 | guest | Knock pushed; **19:17:57 confirmed at height 4951218** |
| 19:18:03 | host | The knock read from the inbox |
| 19:23:09 | guest | Hold at the first set height, "(knock rendezvous: we knocked)", 3 public addresses |
| 19:23:15 | host | Hold "at 3 public addr(s) (knock rendezvous: they knocked)"; "connection secured … on attempt 1 after 0s" |
| 19:23:15 | guest | "connection secured … on attempt 1 after 6s"; contact cards went both ways |

- When the host began its hold it held neither a card nor a listing of the knocker (it read the guest's listing a minute after the link). The 3 addresses it dialled can only be the ones the knock carried. In variant 3 the same line read "at 0 public addr(s)" six times.
- Both dials connected on their first attempt. The two clocks are not exact enough to say whose packet arrived first.
- From the guest's start to the link: 38 minutes. 22 of them are the wait between a newcomer's own listing and its knock.

## 7. Variants 5 and 6: finding each other again after a break

The two now hold each other's cards. The host (A) is stopped and started again at the same addresses; the guest (B) stays up. A restart at the same addresses writes no new listing, and a knock is written once per host per era, so nothing new goes on chain.

**Variant 5, code `8cf8e7f`.** Host down 19:47:27 to 19:53:53.

- The guest pruned the host 18 s after the stop and held for it by contact key eight times, 13 min 13 s to 13 min 55 s apart. The host held seven times, about 13 min 45 s apart. Each hold is 180 s of dialling.
- No two holds overlapped. A host hold began 3 min 51 s to 5 min 46 s after a guest hold had ended; the guest's next began 3 min 38 s down to 1 min 27 s after the host's had ended.
- **Cause.** A failed hold set a cooldown of ten minutes from the hold's end, so each side ran on a timer of its own. Two closed sides link only when both dial at the same time.
- 21:26:17 (guest) and 21:26:20 (host): both held at the knock's far set height 4951598, and linked on attempt 1 after 3 s. **1 h 32 min after the host's start.** Far set heights come every 320 blocks.

**Fix:** [#428](https://github.com/Bella-Addormentata/StarStationFurlong/pull/428), hold slots. A failed hold's next try starts when the pair's next slot begins. A slot is 32 blocks, cut at an offset worked out from the two node ids, so both sides derive the same boundaries from the chain's height. The first hold after a start or a loss is still immediate.

**Variant 6, code `917feca` on both.** For this pair the boundaries are the heights H with H mod 32 = 30. Host down from 23:11:34; started for good at 23:35:00, between two boundaries. (A first start at 23:23:55 wrote no log and was stopped after 1 min 52 s; the guest's log has no line at all in those minutes, so nothing reached it.)

| Start | Side | Height | Slot phase | Result |
|---|---|---|---|---|
| 23:12:18.777 | guest | 4951951 | 17 (first after it pruned the host) | missed |
| 23:16:29.348 | guest | 4951966 | 0, the boundary | missed (host down) |
| 23:29:36.955 | guest | 4951998 | 0, the boundary | missed (host down) |
| 23:36:05.939 | host | 4952016 | 18 (first after its start, 65 s after it) | missed: the guest held nothing between 23:32:37 and 23:41:44 |
| 23:41:44.610 | guest | 4952031 | 1, the boundary 4952030 + 1 | the host's connection arrived 41 s into this hold |
| 23:42:27.094 | host | 4952031 | 1, the boundary 4952030 + 1 | **"connection secured … on attempt 1 after 0s"** |

- The link came 7 min 26 s after the host's start and 3 min 21 s after its missed hold had ended. The old timer would have let the host try again only at 23:49:06, on its own clock.
- It was the hold at the slot boundary: not the first hold, not a knock's set height (the next one was 4952238), and the host saw no incoming connection before its own dial connected. The guest saw the link as an incoming connection while its own hold was dialling the host's addresses every 15 s, which is what kept its side open.
- Both sides logged the same height for the hold, 42 s apart: each node learns of a new block at its own moment. A hold lasts three minutes, so the two overlapped by about 2 min 18 s. The slot rule needs both to start within one hold's length, not in the same second.
- Block time on that evening: 19 to 21 s. Chain reads on both sides during variant 6: no failed read, no "fewer than two agreeing".
- The link then held until the drill's processes were stopped (00:26 the next day).

**What does not prove the slots.** Three other relinks were seen that evening and are not counted. One host restart linked 1 min 8 s after its start: a host's first hold after a start is immediate, and its dial arrived 22 s after the last attempt of a hold of the guest's own, most likely through the opening that attempt had left in the guest's router (inferred; the guest still ran the old code). Two guest restarts linked 5 s and 3 min 50 s after the start. A node that starts with its page dials almost without pause for about eleven minutes (the page's ladder of eight attempts, a 180 s hold, then the watcher's first hold), which is a whole slot, so a restarted guest always meets some hold of the host; the second of the two met the knock's far set height. So the proof had to be a host restart timed between two boundaries, with the guest up.

## 8. What the drill settled, and what it left open

Settled:

- A link by the chain alone works between two home connections that refuse one-sided dials, on a first visit and after a break.
- A station with no money of its own can list itself and knock, paid for by the lobby dish.
- The read side works from an invite alone: 31 s from a guest's first chain request to the host's current addresses.

Open, none of them blocking, each a design question for the owner:

1. **The wait before a first knock.** A newcomer's listing goes out first and its knock keeps 32 to 64 blocks behind it: 18 and 22 minutes here. A knock that went out before the listing would save that.
2. **A busy chain uses up a knock's attempts.** A push refused for its zero fee counts as one of three attempts, a minute apart. Two refusals left one attempt in variant 3.
3. **Other full nodes after a refusal.** Fullness differs between full nodes; the node sends the same write to the same two again.
4. **One coin in the dish.** One gift per 32 blocks for every newcomer on the network.
5. **The first chain request waits a minute** after every start.
6. **What the page shows after its node has lost a peer.** The drill script's "linked" and "players" stayed true through every break on the side that stayed up, while the node had pruned the peer.
7. **Dial first, make room on success** for a chain peer swap (the cost [#427](https://github.com/Bella-Addormentata/StarStationFurlong/pull/427) names).

One mistake on the way, for whoever runs the next drill: stopping a helper process by a recorded parent id stopped two unrelated tray programs on computer A, because the id had been reused. Check a process's name, start time and command line before stopping it by id.
