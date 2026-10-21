# librqbit-dht 9.0.1 — StarStationFurlong fork

Upstream: <https://github.com/ikatson/rqbit> (`crates/dht`), version 9.0.1 as
published on crates.io, Apache-2.0 (see `LICENSE-APACHE`). Wired in through
`[patch.crates-io]` in `ssf-p2p-node/Cargo.toml`; only the `torrent` feature
pulls it in.

Changes from upstream (media plan §6, the trackers and DHT rows):

1. **Client-only.** `on_received_message` drops every incoming query
   (`ping`, `find_node`, `get_peers`, `announce_peer`) unanswered while
   `CLIENT_ONLY` holds. Upstream answers all of them, and a reply is larger
   than the query, so a forged source address would make the node a
   reflector. Lookups the node makes are unchanged. Lift this only once the
   fork carries the plan's no-amplification rule (reply ≤ query size, a
   per-address and global response budget).
2. **Global unicast only.** The UDP writer sends nothing to, and the reader
   takes nothing from, an address that `is_global_unicast` refuses
   (loopback, private, CGNAT, link-local and the cloud metadata address,
   multicast, documentation, and IPv6 forms that embed those). Node and peer
   addresses come from untrusted replies.
3. **Peers too.** The peer addresses a `get_peers` reply carries are
   dropped unless global unicast before the stream yields them. librqbit
   checks its blocklist when it dials a peer for pieces, but not when it
   dials one for a magnet's metadata (BEP 9), and this stream is where those
   addresses come from.

Everything else is upstream's, untouched.
