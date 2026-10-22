# librqbit-tracker-comms 9.0.1 — StarStationFurlong fork

Upstream: <https://github.com/ikatson/rqbit> (`crates/tracker_comms`),
version 9.0.1 as published on crates.io, Apache-2.0 (see `LICENSE-APACHE`).
Wired in through `[patch.crates-io]` in `ssf-p2p-node/Cargo.toml`; only the
`torrent` feature pulls it in.

The node runs its torrent session with trackers OFF (media plan §6), but
librqbit builds this crate's UDP tracker client at session start anyway, bound
to `[::]:0`. On a host with IPv6 disabled that bind fails and takes the whole
session with it. One change from upstream: `UdpTrackerClient::new` falls back
to `0.0.0.0:0` when the IPv6 bind fails. Everything else is upstream's.
