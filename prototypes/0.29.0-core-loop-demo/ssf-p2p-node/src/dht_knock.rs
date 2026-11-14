//! 🚪 The DHT knock: a way in to a computer whose router answers nobody.
//!
//! Two computers behind home routers cannot reach each other by dialing: each
//! router drops what nobody inside asked for. A router does let an answer
//! through once the computer behind it has sent something to that address, so
//! a link forms when BOTH sides send. The side that dials sends by dialing.
//! The side that is dialed has to learn that it is wanted, and by whom. This
//! module is how it learns it, with no server and no coin:
//!
//! - **The knocker** (a dial that is not answered at once, `knock_while_dialing`)
//!   announces the game's UDP port at a **knock point** on the BitTorrent
//!   Mainline DHT: twenty bytes worked out from the room's key, the node id of
//!   the computer it dials and the hour ([`knock_point`]). The DHT's nodes
//!   store the announcer's address as they saw it (BEP 5), so a knocker can
//!   only ever name its own.
//! - **The holder** (`run_holder`) looks its own knock points up every
//!   [`POLL_PERIOD`], for every room it is in and holds the key of. The DHT
//!   hands back addresses and ports, never a node id. For each new one it runs
//!   an **opening hold**: a dial under a made-up node id to that address every
//!   [`OPENING_PERIOD`] for [`OPENING_WINDOW`] ([`opening_dial`]). Such a dial
//!   can never finish, and it does not need to: its first packets leave from
//!   the game's port toward the knocker, which is what opens the holder's
//!   router. The knocker's own dial, still running, then lands, and the holder
//!   learns who it was from the handshake, as with any inbound link. The DHT
//!   goes on listing a knock for a long while after: no hold begins toward an
//!   address a connection that came in from it still stands to, nor toward
//!   one a link in any room has a direct path to, whichever side dialed it
//!   ([`linked_addrs`]; [`OpeningBook::begin`] has the other limits).
//!
//! What it does not do: it does not find a holder's address (the dial does
//! that, from the pass and the DHT's address record), and it reads and writes
//! nothing of Chia. It does not help where the knocker's router gives the
//! game's socket an outside port the node does not know: a different one for
//! every destination, or one fixed other port the router never told it. The
//! knock names the outside port as far as it is known ([`knock_port`]), and
//! the holder's router lets in only what comes from the port it sent to.
//!
//! Who can see what: a knocker's address and port are stored by the DHT nodes
//! nearest the knock point, and handed to anyone who asks at that point. The
//! point cannot be worked out without the room's key, so for a private room
//! that is the room's members; SSF-WELCOME's key ships in the game, so there
//! it is anyone. The address is the one the knocker's dial shows the holder
//! anyway. Off with `SSF_NO_DHT=1` (the whole DHT) or `SSF_DHT_KNOCK=0`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use iroh::{Endpoint as IrohEndpoint, EndpointAddr, PublicKey, SecretKey, TransportAddr};
use n0_future::StreamExt;
use n0_mainline::{Dht, DhtBuilder, Id};

use crate::SharedHub;

/// A knock point lives for one hour of the clock: the knocker announces at the
/// hour it reads, and the holder looks at that hour and, near a boundary, at
/// the one beside it ([`poll_buckets`]). Points therefore change by
/// themselves, and what the DHT still lists of an hour gone is not looked at.
pub(crate) const BUCKET_SECS: u64 = 3600;

/// How near an hour's boundary the holder also looks at the neighbouring
/// hour: a knock announced just before the boundary, and a knocker whose clock
/// runs this far off the holder's, are still found.
pub(crate) const BUCKET_OVERLAP_SECS: u64 = 600;

/// The holder's first look comes this long after the node started (the DHT
/// has to be joined first), and then one every [`POLL_PERIOD`].
const FIRST_POLL_DELAY: Duration = Duration::from_secs(10);

/// How often the holder looks its knock points up. A lookup on the real DHT
/// took 1 to 4 s when measured (2026-11-14), so a knock is seen within about
/// half a minute of its announce.
pub(crate) const POLL_PERIOD: Duration = Duration::from_secs(30);

/// A lookup is given this long. Its answers come one DHT node at a time and
/// the last can be long in coming: what it found by then is kept
/// ([`gathered_until`]) and the rest is not waited for. A round's lookups run
/// side by side, so a round is over within this, well inside [`POLL_PERIOD`]:
/// a slow point holds no other up, and the rounds keep their rhythm.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(12);

/// At most this many rooms are looked up per round, SSF-WELCOME first.
pub(crate) const MAX_ROOMS: usize = 4;

/// One opening dial every this long, for this long: the chain hold's rhythm
/// (`chia_watch::HOLD_PERIOD` / `HOLD_WINDOW`). A router keeps the opening a
/// packet made for at least two minutes when it follows RFC 4787, and many
/// keep it for only thirty seconds, so the hold sends again well inside that.
pub(crate) const OPENING_PERIOD: Duration = Duration::from_secs(15);
pub(crate) const OPENING_WINDOW: Duration = Duration::from_secs(180);

/// An opening dial is let go after this long: its packets left at once, and
/// nothing more is wanted of it.
const OPENING_DIAL_TIMEOUT: Duration = Duration::from_secs(4);

/// At most this many opening holds at once, whoever knocks.
pub(crate) const MAX_OPENINGS: usize = 8;

/// The DHT goes on listing a knock long after the knocker linked or left, and
/// a listing does not say which. Three rules keep the holder from opening
/// toward a listing for ever: no hold toward an address a connection that
/// came in from it still stands to; at most this many holds per address in
/// any [`HOLDS_WINDOW`]; and after a hold that nothing came in on, the next
/// toward that address waits [`OPENING_REST`]. A hold that did get its
/// connection asks for no rest: if that address is listed and no connection
/// stands, the link was lost, and the knocker may well be dialing again.
///
/// The window is counted from when each hold began, not by the hour of the
/// clock the knock points turn with: a hold is the same hold whichever hour's
/// point listed it and whichever hour it began in, so no boundary can hand an
/// address a fourth.
pub(crate) const MAX_HOLDS_PER_ADDR: usize = 3;
pub(crate) const HOLDS_WINDOW: Duration = Duration::from_secs(3600);
pub(crate) const OPENING_REST: Duration = Duration::from_secs(600);

/// How long an address an opening dial went to counts as one we sent to
/// first: main.rs `DIAL_PINHOLE_GRACE`, for the same reason (a connection
/// that comes back through an opening our own packets made is not
/// unsolicited, and proves nothing about being reachable). Counted, as that
/// one is, from when the dial was let go ([`noted_opening_dial`]).
pub(crate) const OPENED_GRACE: Duration = Duration::from_secs(120);

/// A dial that is answered at once needs no knock: the knocker waits this
/// long before it announces. A reachable computer answers well inside it.
const KNOCK_GRACE: Duration = Duration::from_secs(3);

/// How often a knock whose room's key is not filed yet looks for it
/// ([`room_key_when_held`]).
const KEY_WAIT_PERIOD: Duration = Duration::from_millis(250);

/// While its dial runs the knocker announces again every this long (a new
/// hour may have begun, and a DHT node that held the announce may be gone),
/// at most [`MAX_KNOCKS_PER_DIAL`] times. The dial ladder itself lasts about
/// four and a half minutes when nothing answers (2026-11-14, measured).
const KNOCK_PERIOD: Duration = Duration::from_secs(120);
const MAX_KNOCKS_PER_DIAL: u32 = 3;

/// An announce that has not ended in this long is given up (measured: 0.3 to
/// 7 s on the real DHT).
const ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(20);

/// A knocker's port below this is not opened toward: the game never binds
/// one, and nothing is sent to another service's port on a knocker's word.
const MIN_KNOCK_PORT: u16 = 1024;

/// The hour of the clock `unix_secs` falls in.
pub(crate) fn bucket_of(unix_secs: u64) -> u64 {
    unix_secs / BUCKET_SECS
}

/// The hours the holder looks at now: this one, and the neighbour while the
/// clock is within [`BUCKET_OVERLAP_SECS`] of the boundary to it.
pub(crate) fn poll_buckets(unix_secs: u64) -> Vec<u64> {
    let bucket = bucket_of(unix_secs);
    let into = unix_secs % BUCKET_SECS;
    let mut out = vec![bucket];
    if into < BUCKET_OVERLAP_SECS && bucket > 0 {
        out.push(bucket - 1);
    } else if into >= BUCKET_SECS - BUCKET_OVERLAP_SECS {
        out.push(bucket + 1);
    }
    out
}

/// Where a knock on `holder` for the room of `room_key` is left during the
/// hour `bucket`: the first twenty bytes of a keyed hash, so the point says
/// nothing of the room or the holder to someone without the room's key, and
/// two rooms' knocks on one holder never share a point.
pub(crate) fn knock_point(room_key: &[u8; 32], holder: &PublicKey, bucket: u64) -> [u8; 20] {
    let mut hasher = blake3::Hasher::new_derive_key("StarStationFurlong 2026-11-14 DHT knock point v1");
    hasher.update(room_key);
    hasher.update(holder.as_bytes());
    hasher.update(&bucket.to_le_bytes());
    let mut point = [0u8; 20];
    point.copy_from_slice(&hasher.finalize().as_bytes()[..20]);
    point
}

/// Whether `SSF_DHT_KNOCK` holds the knock off: exactly `0`. Unset or
/// anything else leaves it on, as the DHT itself is on unless told otherwise.
pub(crate) fn knock_off(raw: Option<&str>) -> bool {
    raw.map(str::trim) == Some("0")
}

/// May the holder open toward `addr`, as far as the address itself goes: a
/// public IPv4 address that is not one of our own (a computer behind our own
/// router is found on the LAN, and our router would not turn the packets
/// round), at a port the game could have bound.
pub(crate) fn knock_admitted(addr: SocketAddrV4, own: &HashSet<Ipv4Addr>, is_public: impl Fn(Ipv4Addr) -> bool) -> bool {
    addr.port() >= MIN_KNOCK_PORT && is_public(*addr.ip()) && !own.contains(addr.ip())
}

/// This computer's own IPv4 addresses, as far as anything here knows them
/// now: `live`, the endpoint's own view (its interfaces, what the node
/// advertised and still does, what iroh found through the router), and
/// `dht_vote`, where the DHT's nodes say our packets come from. The second
/// is there for a node that advertises nothing (`SSF_EXTERNAL_ADDRS=off`)
/// and so has no public address in the first.
pub(crate) fn own_ips_of(live: impl IntoIterator<Item = SocketAddr>, dht_vote: Option<SocketAddrV4>) -> HashSet<Ipv4Addr> {
    let mut own: HashSet<Ipv4Addr> = live
        .into_iter()
        .filter_map(|sock| match sock.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .collect();
    own.extend(dht_vote.map(|public| *public.ip()));
    own
}

/// The port a knock names: the outside port of the game's socket, as far as
/// it is known. The holder opens toward exactly this port, and a router that
/// filters by port lets the knocker's packets in only if they come from it.
///
/// - A public IPv4 address in the endpoint's live view (`live`) that the node
///   did not advertise itself (`advertised`) is one iroh got from the router
///   (a port mapping) or was shown by a peer: the mapping itself. Its port.
/// - Else a public IPv4 address the node advertised and still does: the
///   operator's port where one was named (`SSF_EXTERNAL_ADDRS=ip:port` or
///   `auto:port`), the bound port otherwise.
/// - Else `bound`, the port the socket is bound to: most home routers keep
///   it on the way out. One that does not, and tells nobody, is the limit
///   the module's head names.
pub(crate) fn knock_port(live: &[SocketAddr], advertised: &HashSet<SocketAddr>, bound: u16, is_public: impl Fn(Ipv4Addr) -> bool) -> u16 {
    let public_v4 = |sock: &&SocketAddr| matches!(sock.ip(), IpAddr::V4(v4) if is_public(v4));
    let found = live.iter().filter(public_v4).find(|sock| !advertised.contains(sock));
    let told = live.iter().filter(public_v4).find(|sock| advertised.contains(sock));
    found.or(told).map(|sock| sock.port()).unwrap_or(bound)
}

/// What the holder remembers of one address's holds.
struct Held {
    /// When its holds of the last [`HOLDS_WINDOW`] began, oldest first.
    began: Vec<Instant>,
    /// The last one got the connection it was for.
    landed: bool,
}

/// What the holder remembers of its opening holds: which run now, when each
/// address's holds of the last hour began, where opening dials went lately, where a
/// connection has come in from, and where one still stands. Pure: the clock is
/// handed in.
#[derive(Default)]
pub(crate) struct OpeningBook {
    /// Holds running now, by the knocker's address.
    running: HashSet<SocketAddrV4>,
    /// Per address, its holds of the last [`HOLDS_WINDOW`].
    begun: HashMap<SocketAddrV4, Held>,
    /// Addresses an opening dial went to, and when the last one left.
    opened: HashMap<Ipv4Addr, Instant>,
    /// Addresses a connection came in from, and when.
    landed: HashMap<SocketAddrV4, Instant>,
    /// Addresses a connection that came in from them stands to now, with how
    /// many do.
    live: HashMap<SocketAddrV4, u32>,
}

impl OpeningBook {
    /// Claim a hold toward `addr` at `now`: `true` when it may begin (and is
    /// now counted as running), `false` when one runs already,
    /// [`MAX_OPENINGS`] run, a connection from that address stands, the
    /// address had its [`MAX_HOLDS_PER_ADDR`] in the last [`HOLDS_WINDOW`],
    /// or its last hold got no connection and began less than
    /// [`OPENING_REST`] ago.
    pub(crate) fn begin(&mut self, addr: SocketAddrV4, now: Instant) -> bool {
        if self.running.contains(&addr) || self.running.len() >= MAX_OPENINGS || self.live.contains_key(&addr) {
            return false;
        }
        // Holds that began longer ago than the window count for nothing any
        // more, and an address with none left is forgotten.
        self.begun.retain(|_, held| {
            held.began.retain(|at| now.duration_since(*at) < HOLDS_WINDOW);
            !held.began.is_empty()
        });
        match self.begun.get_mut(&addr) {
            Some(held) => {
                let resting = !held.landed && held.began.last().is_some_and(|last| now.duration_since(*last) < OPENING_REST);
                if resting || held.began.len() >= MAX_HOLDS_PER_ADDR {
                    return false;
                }
                held.began.push(now);
                held.landed = false;
            }
            None => {
                self.begun.insert(addr, Held { began: vec![now], landed: false });
            }
        }
        self.running.insert(addr);
        true
    }

    /// The hold toward `addr` ended.
    pub(crate) fn end(&mut self, addr: &SocketAddrV4) {
        self.running.remove(addr);
    }

    /// An opening dial is leaving for `ip`.
    pub(crate) fn note_opening(&mut self, ip: Ipv4Addr, now: Instant) {
        self.opened.retain(|_, at| now.duration_since(*at) < OPENED_GRACE);
        self.opened.insert(ip, now);
    }

    /// Did an opening dial go to `ip` within [`OPENED_GRACE`]?
    pub(crate) fn opened_lately(&mut self, ip: Ipv4Addr, now: Instant) -> bool {
        self.opened.retain(|_, at| now.duration_since(*at) < OPENED_GRACE);
        self.opened.contains_key(&ip)
    }

    /// A connection came in from `addr`. Kept only while a hold toward that
    /// address runs: nobody else asks.
    pub(crate) fn note_landed(&mut self, addr: SocketAddrV4, now: Instant) {
        if self.running.contains(&addr) {
            self.landed.insert(addr, now);
        }
    }

    /// Did a connection come in from `addr` since `since`? The hold toward it
    /// stops asking for one then, and is remembered as one that got its
    /// connection. Forgets the mark once read as true.
    pub(crate) fn landed_since(&mut self, addr: &SocketAddrV4, since: Instant) -> bool {
        match self.landed.get(addr) {
            Some(at) if *at >= since => {
                self.landed.remove(addr);
                if let Some(held) = self.begun.get_mut(addr) {
                    held.landed = true;
                }
                true
            }
            _ => false,
        }
    }

    /// A connection that came in from `addr` stands from now on.
    pub(crate) fn note_live(&mut self, addr: SocketAddrV4) {
        *self.live.entry(addr).or_insert(0) += 1;
    }

    /// One connection that came in from `addr` ended.
    pub(crate) fn end_live(&mut self, addr: &SocketAddrV4) {
        if let Some(count) = self.live.get_mut(addr) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.live.remove(addr);
            }
        }
    }

    #[cfg(test)]
    fn running(&self) -> usize {
        self.running.len()
    }
}

/// The node's own client on the Mainline DHT for knocks, with the holder's
/// book. The address lookup keeps the client it publishes and resolves with
/// to itself, so this is a second one, on a socket of its own.
pub struct KnockDht {
    dht: Dht,
    book: Mutex<OpeningBook>,
    /// Knocks of ours that are out now: dials whose knock was stored and that
    /// still run. While any is, a handshake that fails on the way in is most
    /// likely the opening dial we asked for (main.rs `run_iroh_listener`).
    knocks_out: AtomicUsize,
}

impl KnockDht {
    /// Join the DHT with `builder` (the library's bootstrap hosts, or the
    /// operator's). The join itself goes on in the background.
    pub(crate) fn start(builder: &DhtBuilder) -> std::io::Result<Self> {
        Ok(Self { dht: builder.build()?, book: Mutex::new(OpeningBook::default()), knocks_out: AtomicUsize::new(0) })
    }

    /// Is a knock of ours out now?
    pub(crate) fn knock_out(&self) -> bool {
        self.knocks_out.load(Ordering::SeqCst) > 0
    }

    /// Did an opening dial of ours go to `ip` lately (main.rs
    /// `note_inbound_verified`: a connection from there is not unsolicited)?
    pub(crate) fn opened_lately(&self, ip: std::net::IpAddr, now: Instant) -> bool {
        match ip {
            std::net::IpAddr::V4(v4) => self.book.lock().unwrap().opened_lately(v4, now),
            std::net::IpAddr::V6(_) => false,
        }
    }

    /// A connection was accepted from `addr` (main.rs `run_iroh_listener`).
    pub(crate) fn note_landed(&self, addr: SocketAddr) {
        if let SocketAddr::V4(v4) = addr {
            self.book.lock().unwrap().note_landed(v4, Instant::now());
        }
    }

    /// A connection accepted from `addr` stands for as long as the guard this
    /// hands back is kept (main.rs `run_iroh_listener` keeps it in the
    /// connection's task): no opening hold begins toward that address
    /// meanwhile. `None` with the knock off, or for an address that is not
    /// IPv4.
    pub(crate) fn live_from(hub: &SharedHub, addr: SocketAddr) -> Option<LiveFrom> {
        let SocketAddr::V4(v4) = addr else { return None };
        hub.dht_knock.as_ref()?.book.lock().unwrap().note_live(v4);
        Some(LiveFrom { hub: hub.clone(), addr: v4 })
    }

    /// What the DHT lists at `point`, as far as it answered `within` that
    /// long. `None` only when the DHT client has stopped.
    async fn lookup(&self, point: [u8; 20], within: Duration) -> Option<BTreeSet<SocketAddrV4>> {
        let id = Id::from_bytes(point).ok()?;
        let deadline = tokio::time::Instant::now() + within;
        match tokio::time::timeout_at(deadline, self.dht.get_peers(id)).await {
            Ok(answers) => Some(gathered_until(answers.ok()?, deadline).await),
            Err(_) => Some(BTreeSet::new()),
        }
    }

    /// Announce `port` at `point`: "the computer at the address you see this
    /// from, at this port, knocks".
    async fn announce(&self, point: [u8; 20], port: u16) -> Result<(), String> {
        let id = Id::from_bytes(point).map_err(|e| e.to_string())?;
        self.dht.announce_peer(id, Some(port)).await.map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Every address `answers` hands over before `deadline`, and all of them when
/// the stream ends sooner. A knock found early in a lookup is not thrown away
/// because the lookup's tail was slow: the holder opens toward it this round,
/// not at some later round whose tail happens to be quick.
async fn gathered_until<S>(mut answers: S, deadline: tokio::time::Instant) -> BTreeSet<SocketAddrV4>
where
    S: n0_future::Stream<Item = Vec<SocketAddrV4>> + Unpin,
{
    let mut found = BTreeSet::new();
    while let Ok(Some(batch)) = tokio::time::timeout_at(deadline, answers.next()).await {
        found.extend(batch);
    }
    found
}

/// A connection that came in from an address, for as long as it stands
/// ([`KnockDht::live_from`]).
pub(crate) struct LiveFrom {
    hub: SharedHub,
    addr: SocketAddrV4,
}

impl Drop for LiveFrom {
    fn drop(&mut self) {
        if let Some(knock) = self.hub.dht_knock.as_ref() {
            knock.book.lock().unwrap().end_live(&self.addr);
        }
    }
}

/// One opening dial: a dial under a node id nobody holds, to `addr`. It cannot
/// finish (whoever answers there proves another id, or nobody answers), and
/// what it is for has happened by the time it fails: its first packets left
/// the game's socket toward `addr`. Should it ever connect, the link is
/// closed at once: nothing was meant to be said on it.
pub(crate) async fn opening_dial(endpoint: &IrohEndpoint, addr: SocketAddrV4) {
    let nobody = SecretKey::generate().public();
    let target = EndpointAddr::new(nobody).with_ip_addr(SocketAddr::V4(addr));
    if let Ok(Ok(conn)) = tokio::time::timeout(OPENING_DIAL_TIMEOUT, endpoint.connect(target, b"ssf")).await {
        conn.close(0u32.into(), b"opening dial");
    }
}

/// One opening dial of a hold, noted in the book for [`OPENED_GRACE`] twice:
/// as it begins, so that a connection landing while it runs is known for one
/// we sent toward first, and again as it is let go. The dial's packets leave
/// for as long as it runs (measured 2026-11-14: Initials at 0, 1 and 3 s, a
/// last packet as the dial is let go at 4 s, none in the 146 s after), and
/// the grace counts from the last of them, as main.rs counts a dial of our
/// own from when it ended (`release_dial`).
async fn noted_opening_dial(book: &Mutex<OpeningBook>, endpoint: &IrohEndpoint, addr: SocketAddrV4) {
    book.lock().unwrap().note_opening(*addr.ip(), Instant::now());
    opening_dial(endpoint, addr).await;
    book.lock().unwrap().note_opening(*addr.ip(), Instant::now());
}

/// The IPv4 addresses a connection that still stands has a direct path to:
/// where its packets go now, whichever side dialed, and whatever the link
/// began on (one that began through a relay finds its direct path after).
/// Nothing for a connection that has closed.
pub(crate) fn direct_paths_of(conn: &iroh::endpoint::Connection) -> Vec<SocketAddrV4> {
    if conn.close_reason().is_some() {
        return Vec::new();
    }
    let paths = conn.paths();
    let direct: Vec<SocketAddrV4> = paths
        .iter()
        .filter_map(|path| match path.remote_addr() {
            TransportAddr::Ip(SocketAddr::V4(v4)) => Some(*v4),
            TransportAddr::Ip(SocketAddr::V6(v6)) => v6.ip().to_ipv4_mapped().map(|ip| SocketAddrV4::new(ip, v6.port())),
            _ => None,
        })
        .collect();
    direct
}

/// Every address a link of ours, in any room, has a direct path to. No hold
/// begins toward one: the router is open that way already. The book's own
/// rule ([`OpeningBook::begin`], `live`) knows only the connections that came
/// in, and only by the address they came in from; a knocker this computer
/// reached by a dial of its own, or one whose link began through a relay, is
/// linked all the same, and the DHT goes on listing its knock.
fn linked_addrs(hub: &SharedHub) -> HashSet<SocketAddrV4> {
    let links: Vec<iroh::endpoint::Connection> =
        hub.rooms.lock().unwrap().values().flat_map(|room| room.remote_peers.values().map(|member| member.conn.clone())).collect();
    links.iter().flat_map(direct_paths_of).collect()
}

/// The rooms the holder looks its knock points up for: the rooms this node is
/// in whose key it holds, SSF-WELCOME first, [`MAX_ROOMS`] at most.
fn rooms_to_poll(hub: &SharedHub) -> Vec<(String, [u8; 32])> {
    let live: Vec<String> = hub.rooms.lock().unwrap().keys().cloned().collect();
    let caps = hub.chia_rooms.lock().unwrap();
    let mut rooms: Vec<(String, [u8; 32])> =
        live.into_iter().filter_map(|id| caps.get(&id).map(|cap| (id, cap.room_key))).collect();
    drop(caps);
    order_rooms(&mut rooms, crate::chia_rooms::is_bundled_room_key);
    rooms
}

/// SSF-WELCOME (the bundled key) first, then by room id so a round is the same
/// rooms as the last, [`MAX_ROOMS`] at most.
pub(crate) fn order_rooms(rooms: &mut Vec<(String, [u8; 32])>, is_welcome: impl Fn(&[u8; 32]) -> bool) {
    rooms.sort_by(|a, b| is_welcome(&b.1).cmp(&is_welcome(&a.1)).then_with(|| a.0.cmp(&b.0)));
    rooms.truncate(MAX_ROOMS);
}

/// The points one round looks up: for each room, this node's knock point of
/// each hour looked at now ([`poll_buckets`]). With [`MAX_ROOMS`] rooms and two
/// hours near a boundary that is eight at most.
pub(crate) fn round_points(rooms: &[(String, [u8; 32])], me: &PublicKey, unix_secs: u64) -> Vec<(String, [u8; 20])> {
    let hours = poll_buckets(unix_secs);
    rooms
        .iter()
        .flat_map(|(room_id, room_key)| hours.iter().map(move |hour| (room_id.clone(), knock_point(room_key, me, *hour))))
        .collect()
}

/// This computer's own IPv4 addresses now ([`own_ips_of`]).
async fn own_ips(endpoint: &IrohEndpoint, knock: &KnockDht) -> HashSet<Ipv4Addr> {
    let vote = knock.dht.info().await.ok().and_then(|info| info.public_address());
    own_ips_of(endpoint.addr().ip_addrs().copied(), vote)
}

/// The holder's side, for as long as the node runs: every [`POLL_PERIOD`] look
/// up this node's knock points and begin an opening hold toward each address
/// found there that may have one.
pub(crate) async fn run_holder(hub: SharedHub, endpoint: IrohEndpoint) {
    let Some(knock) = hub.dht_knock.as_ref() else { return };
    let me = endpoint.id();
    tokio::time::sleep(FIRST_POLL_DELAY).await;
    match knock.dht.bootstrapped().await {
        Ok(true) => println!("🚪 DHT knock: joined the DHT; looking for knocks every {} s", POLL_PERIOD.as_secs()),
        Ok(false) => println!("🚪 DHT knock: the DHT is not joined yet (no bootstrap host answered); it keeps trying, and so does the look for knocks"),
        Err(_) => {
            eprintln!("🚪 DHT knock: the DHT client stopped; no knock is seen or sent in this run");
            return;
        }
    }
    // One round every POLL_PERIOD by the clock, however long the last took. A
    // round that ran over is not made up for by rounds in a burst.
    let mut rounds = tokio::time::interval(POLL_PERIOD);
    rounds.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        rounds.tick().await;
        let points = round_points(&rooms_to_poll(&hub), &me, crate::chia_resolve::unix_now());
        // All of a round's lookups side by side: one slow point holds no
        // other room up, and the round is over within LOOKUP_TIMEOUT, with
        // whatever each lookup had found by then.
        let looked =
            n0_future::join_all(points.into_iter().map(|(room_id, point)| async move { (room_id, knock.lookup(point, LOOKUP_TIMEOUT).await) })).await;
        let own = own_ips(&endpoint, knock).await;
        // Asked only in a round that found somebody.
        let anybody = looked.iter().any(|(_, found)| found.as_ref().is_some_and(|found| !found.is_empty()));
        let linked = if anybody { linked_addrs(&hub) } else { HashSet::new() };
        for (room_id, found) in looked {
            let Some(found) = found else {
                eprintln!("🚪 DHT knock: the DHT client stopped; no knock is seen or sent in this run");
                return;
            };
            for addr in found {
                if !knock_admitted(addr, &own, crate::ipv4_is_public) || linked.contains(&addr) {
                    continue;
                }
                let begun = Instant::now();
                if !knock.book.lock().unwrap().begin(addr, begun) {
                    continue;
                }
                println!(
                    "🚪 DHT knock: {addr} knocked for room {room_id}; opening toward it every {} s for {} s",
                    OPENING_PERIOD.as_secs(),
                    OPENING_WINDOW.as_secs()
                );
                tokio::spawn(opening_hold(hub.clone(), endpoint.clone(), addr, begun));
            }
        }
    }
}

/// One opening hold: an opening dial toward `addr` every [`OPENING_PERIOD`]
/// until a connection comes in from it or [`OPENING_WINDOW`] has passed.
async fn opening_hold(hub: SharedHub, endpoint: IrohEndpoint, addr: SocketAddrV4, begun: Instant) {
    let Some(knock) = hub.dht_knock.as_ref() else { return };
    let mut landed = false;
    while begun.elapsed() < OPENING_WINDOW {
        let round = Instant::now();
        noted_opening_dial(&knock.book, &endpoint, addr).await;
        // Look twice a second for the knocker's dial to land, up to the next
        // opening dial: a hold that got what it was for sends nothing more.
        while round.elapsed() < OPENING_PERIOD {
            if knock.book.lock().unwrap().landed_since(&addr, begun) {
                landed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if landed {
            break;
        }
    }
    knock.book.lock().unwrap().end(&addr);
    if landed {
        println!("🚪 DHT knock: a connection came in from {addr} {} s after the opening began", begun.elapsed().as_secs());
    } else {
        println!("🚪 DHT knock: nothing came in from {addr} in {} s; the opening is over", OPENING_WINDOW.as_secs());
    }
}

/// A dial's knock has not been stored (yet).
const KNOCK_NOT_OUT: u8 = 0;
/// A dial's knock was stored and is counted in `KnockDht::knocks_out`.
const KNOCK_OUT: u8 = 1;
/// The dial ended: nothing more is counted for it.
const KNOCK_ENDED: u8 = 2;

/// The knocker's side of one dial. Dropped when the dial ends, however it
/// ends, which stops the knocking and takes the knock out of the count of
/// those that are out.
pub(crate) struct Knocking {
    task: tokio::task::AbortHandle,
    hub: SharedHub,
    /// One of `KNOCK_NOT_OUT`, `KNOCK_OUT`, `KNOCK_ENDED`: the task and the
    /// guard run on different threads, so the count moves only on the change
    /// each of them wins.
    state: Arc<AtomicU8>,
}

impl Drop for Knocking {
    fn drop(&mut self) {
        self.task.abort();
        if self.state.swap(KNOCK_ENDED, Ordering::SeqCst) == KNOCK_OUT {
            if let Some(knock) = self.hub.dht_knock.as_ref() {
                knock.knocks_out.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }
}

/// Count a dial's stored knock as out, once per dial, and only while the dial
/// still runs: a guard dropped meanwhile leaves the count as it was.
fn count_knock_out(knocks_out: &AtomicUsize, state: &AtomicU8) {
    if state.load(Ordering::SeqCst) != KNOCK_NOT_OUT {
        return;
    }
    knocks_out.fetch_add(1, Ordering::SeqCst);
    if state.compare_exchange(KNOCK_NOT_OUT, KNOCK_OUT, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        knocks_out.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The room's key, as soon as the node holds it. The page hands the key over
/// on a stream of its own (the `cap`) and does not wait for that before it
/// starts the room's sync, so a first dial can begin a moment before the key
/// is filed. The knock waits for the key rather than give the whole dial up.
/// The wait ends with the dial ([`Knocking`] aborts the task), so a room
/// whose key never comes costs a look every [`KEY_WAIT_PERIOD`] and sends
/// nothing.
async fn room_key_when_held(rooms: &Mutex<HashMap<String, crate::chia_rooms::ChiaRoomCap>>, room_id: &str) -> [u8; 32] {
    loop {
        let held = rooms.lock().unwrap().get(room_id).map(|cap| cap.room_key);
        if let Some(room_key) = held {
            return room_key;
        }
        tokio::time::sleep(KEY_WAIT_PERIOD).await;
    }
}

/// Whether a knock is still wanted, asked at the moment it would be sent.
/// `linked` is whether the target is linked in the room, `None` when the room
/// is no longer open here. The dial ladder asks the same before each attempt.
/// The knock asks for itself because its guard can outlive the link by as
/// long as the caller waits on something else (the page's stream, when it
/// reports the dial).
fn knock_wanted(linked: Option<bool>) -> bool {
    linked == Some(false)
}

/// Knock on `target` for `room_id` while a dial to it runs: after
/// [`KNOCK_GRACE`] (a reachable computer has answered by then, and the caller
/// has dropped the guard), announce the game's outside IPv4 port
/// ([`knock_port`]) at the knock point, and again every [`KNOCK_PERIOD`].
/// `None`, and nothing sent, when the knock is off or the game has no IPv4
/// socket. A room whose key the node does not hold yet is waited for
/// ([`room_key_when_held`]).
pub(crate) fn knock_while_dialing(hub: &SharedHub, endpoint: &IrohEndpoint, room_id: &str, target: PublicKey) -> Option<Knocking> {
    hub.dht_knock.as_ref()?;
    let bound = endpoint.bound_sockets().iter().find(|s| s.is_ipv4()).map(|s| s.port())?;
    let state = Arc::new(AtomicU8::new(KNOCK_NOT_OUT));
    let task = tokio::spawn(knock_rounds(hub.clone(), endpoint.clone(), state.clone(), room_id.to_string(), target, bound));
    Some(Knocking { task: task.abort_handle(), hub: hub.clone(), state })
}

/// The knocking itself, for as long as its dial runs ([`Knocking`] aborts it).
async fn knock_rounds(hub: SharedHub, endpoint: IrohEndpoint, state: Arc<AtomicU8>, room_id: String, target: PublicKey, bound: u16) {
    let Some(knock) = hub.dht_knock.as_ref() else { return };
    let shown: String = target.to_string().chars().take(8).collect();
    tokio::time::sleep(KNOCK_GRACE).await;
    let room_key = room_key_when_held(&hub.chia_rooms, &room_id).await;
    // A node that has only just started (a first run) may still be joining the
    // DHT: an announce before that is stored by nobody.
    if knock.dht.bootstrapped().await.is_err() {
        return;
    }
    for round in 0..MAX_KNOCKS_PER_DIAL {
        if round > 0 {
            tokio::time::sleep(KNOCK_PERIOD).await;
        }
        let linked = hub.rooms.lock().unwrap().get(&room_id).map(|room| room.remote_peers.contains_key(&target));
        if !knock_wanted(linked) {
            return;
        }
        let point = knock_point(&room_key, &target, bucket_of(crate::chia_resolve::unix_now()));
        // Asked at each round: a port mapping may have come since the last.
        let live: Vec<SocketAddr> = endpoint.addr().ip_addrs().copied().collect();
        let port = knock_port(&live, &hub.reach.self_advertised.lock().unwrap(), bound, crate::ipv4_is_public);
        let began = Instant::now();
        match tokio::time::timeout(ANNOUNCE_TIMEOUT, knock.announce(point, port)).await {
            Ok(Ok(())) => {
                count_knock_out(&knock.knocks_out, &state);
                println!(
                    "🚪 DHT knock: knocked on {shown}… through the DHT (port {port}, {:.1} s); it opens toward this computer when it sees the knock",
                    began.elapsed().as_secs_f32()
                );
            }
            Ok(Err(e)) => eprintln!("🚪 DHT knock: the knock on {shown}… was not stored ({e}); the dial goes on without it"),
            Err(_) => eprintln!("🚪 DHT knock: the knock on {shown}… was not stored in {} s; the dial goes on without it", ANNOUNCE_TIMEOUT.as_secs()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> PublicKey {
        SecretKey::from_bytes(&[byte; 32]).public()
    }

    fn v4(a: u8, b: u8, c: u8, d: u8, port: u16) -> SocketAddrV4 {
        SocketAddrV4::new(Ipv4Addr::new(a, b, c, d), port)
    }

    fn sock(a: u8, b: u8, c: u8, d: u8, port: u16) -> SocketAddr {
        SocketAddr::V4(v4(a, b, c, d, port))
    }

    /// An IPv6 address of the documentation range.
    fn sock6(port: u16) -> SocketAddr {
        SocketAddr::new(IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1)), port)
    }

    #[test]
    fn a_knock_is_counted_out_once_and_never_after_its_dial_ended() {
        let count = AtomicUsize::new(0);
        // Stored twice in one dial (the second round): counted once.
        let running = AtomicU8::new(KNOCK_NOT_OUT);
        count_knock_out(&count, &running);
        count_knock_out(&count, &running);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(running.load(Ordering::SeqCst), KNOCK_OUT);
        // A dial that ended before its knock was stored: never counted, so the
        // count cannot stay raised with nobody left to lower it.
        let ended = AtomicU8::new(KNOCK_ENDED);
        count_knock_out(&count, &ended);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(ended.load(Ordering::SeqCst), KNOCK_ENDED);
    }

    #[test]
    fn a_point_is_the_rooms_the_holders_and_the_hours() {
        let room = [7u8; 32];
        let other_room = [8u8; 32];
        let holder = key(1);
        let other_holder = key(2);
        let point = knock_point(&room, &holder, 500_000);
        // The same three give the same point, on either computer.
        assert_eq!(point, knock_point(&room, &holder, 500_000));
        // Another room, another holder or another hour is another point.
        assert_ne!(point, knock_point(&other_room, &holder, 500_000));
        assert_ne!(point, knock_point(&room, &other_holder, 500_000));
        assert_ne!(point, knock_point(&room, &holder, 500_001));
        // And it is a DHT id.
        assert!(Id::from_bytes(point).is_ok());
    }

    #[test]
    fn the_holder_looks_at_this_hour_and_near_a_boundary_at_the_neighbour() {
        let hour = 500_000u64;
        let start = hour * BUCKET_SECS;
        assert_eq!(bucket_of(start), hour);
        assert_eq!(bucket_of(start + BUCKET_SECS - 1), hour);
        // Just after the hour began: the hour before as well.
        assert_eq!(poll_buckets(start), vec![hour, hour - 1]);
        assert_eq!(poll_buckets(start + BUCKET_OVERLAP_SECS - 1), vec![hour, hour - 1]);
        // In the middle: this hour alone.
        assert_eq!(poll_buckets(start + BUCKET_OVERLAP_SECS), vec![hour]);
        assert_eq!(poll_buckets(start + BUCKET_SECS - BUCKET_OVERLAP_SECS - 1), vec![hour]);
        // Just before the next: the next as well.
        assert_eq!(poll_buckets(start + BUCKET_SECS - BUCKET_OVERLAP_SECS), vec![hour, hour + 1]);
        assert_eq!(poll_buckets(start + BUCKET_SECS - 1), vec![hour, hour + 1]);
        // A knocker and a holder whose clocks differ by less than the overlap
        // always share an hour: whatever hour the knocker reads, the holder
        // looks at it.
        for knocker in [start + 5, start + BUCKET_SECS / 2, start + BUCKET_SECS - 5] {
            for skew in [-(BUCKET_OVERLAP_SECS as i64) + 1, 0, BUCKET_OVERLAP_SECS as i64 - 1] {
                let holder = (knocker as i64 + skew) as u64;
                assert!(poll_buckets(holder).contains(&bucket_of(knocker)), "knocker at {knocker}, holder at {holder}");
            }
        }
        // The first hour of the clock has none before it.
        assert_eq!(poll_buckets(5), vec![0]);
    }

    #[test]
    fn only_a_plain_zero_holds_the_knock_off() {
        assert!(knock_off(Some("0")));
        assert!(knock_off(Some(" 0 ")));
        assert!(!knock_off(None));
        assert!(!knock_off(Some("")));
        assert!(!knock_off(Some("1")));
        assert!(!knock_off(Some("off")));
    }

    #[test]
    fn a_knock_is_opened_toward_only_at_a_public_address_that_is_not_ours() {
        let public = |ip: Ipv4Addr| !ip.is_private() && !ip.is_loopback();
        let own: HashSet<Ipv4Addr> = [Ipv4Addr::new(198, 51, 100, 7)].into_iter().collect();
        assert!(knock_admitted(v4(203, 0, 113, 9, 44442), &own, public));
        // A private or loopback address: never.
        assert!(!knock_admitted(v4(192, 168, 1, 20, 44442), &own, public));
        assert!(!knock_admitted(v4(127, 0, 0, 1, 44442), &own, public));
        // Our own public address (another computer behind our router).
        assert!(!knock_admitted(v4(198, 51, 100, 7, 44442), &own, public));
        // A port the game never binds.
        assert!(!knock_admitted(v4(203, 0, 113, 9, 53), &own, public));
        assert!(!knock_admitted(v4(203, 0, 113, 9, 0), &own, public));
        assert!(knock_admitted(v4(203, 0, 113, 9, MIN_KNOCK_PORT), &own, public));
    }

    #[test]
    fn our_own_addresses_are_the_endpoints_live_ones_and_the_dhts_vote() {
        let live = [sock(192, 168, 1, 20, 44442), sock(198, 51, 100, 7, 44442), sock6(44442)];
        let own = own_ips_of(live, None);
        assert_eq!(own, HashSet::from([Ipv4Addr::new(192, 168, 1, 20), Ipv4Addr::new(198, 51, 100, 7)]));
        // A node that advertises nothing has no public address in its live
        // view: the DHT's vote is then the only word on where it sits.
        let own = own_ips_of([sock(192, 168, 1, 20, 44442)], Some(v4(203, 0, 113, 9, 6881)));
        assert!(own.contains(&Ipv4Addr::new(203, 0, 113, 9)));
        // And a computer behind our own router that knocks is then not opened
        // toward, whatever its port.
        assert!(!knock_admitted(v4(203, 0, 113, 9, 51000), &own, |_| true));
        assert!(own_ips_of(std::iter::empty::<SocketAddr>(), None).is_empty());
    }

    #[test]
    fn a_knock_names_the_outside_port_as_far_as_it_is_known() {
        let public = |ip: Ipv4Addr| !ip.is_private();
        let lan = sock(192, 168, 1, 20, 44442);
        // Nothing known of the outside: the bound port.
        assert_eq!(knock_port(&[lan], &HashSet::new(), 44442, public), 44442);
        assert_eq!(knock_port(&[], &HashSet::new(), 44442, public), 44442);
        // The node advertised its address with the bound port (plain `auto`).
        let auto = sock(203, 0, 113, 9, 44442);
        assert_eq!(knock_port(&[lan, auto], &HashSet::from([auto]), 44442, public), 44442);
        // The operator named the outside port: the router maps 44442 to 55555.
        let named = sock(203, 0, 113, 9, 55555);
        assert_eq!(knock_port(&[lan, named], &HashSet::from([named]), 44442, public), 55555);
        // iroh got a mapping from the router that the node did not advertise:
        // it is the mapping itself, and wins over what the node only claimed.
        let mapped = sock(203, 0, 113, 9, 61001);
        assert_eq!(knock_port(&[lan, auto, mapped], &HashSet::from([auto]), 44442, public), 61001);
        assert_eq!(knock_port(&[mapped, auto], &HashSet::from([auto]), 44442, public), 61001);
        // An address advertised once and no longer live (the IP rotated) says
        // nothing, and an IPv6 address has no say in an IPv4 knock.
        let v6 = sock6(50000);
        assert_eq!(knock_port(&[lan, v6], &HashSet::from([named]), 44442, public), 44442);
    }

    #[test]
    fn a_round_looks_up_each_room_at_each_hour_and_eight_points_at_most() {
        let me = key(1);
        let mut rooms: Vec<(String, [u8; 32])> = (0..6u8).map(|i| (format!("room-{i}"), [i; 32])).collect();
        order_rooms(&mut rooms, |_| false);
        // Mid-hour: one point per room.
        let mid = 10 * BUCKET_SECS + BUCKET_SECS / 2;
        let points = round_points(&rooms, &me, mid);
        assert_eq!(points.len(), MAX_ROOMS);
        assert_eq!(points[0], ("room-0".to_string(), knock_point(&[0; 32], &me, 10)));
        // Near a boundary: this hour's and the neighbour's, for every room.
        let late = 11 * BUCKET_SECS - 5;
        let points = round_points(&rooms, &me, late);
        assert_eq!(points.len(), MAX_ROOMS * 2);
        assert!(points.contains(&("room-3".to_string(), knock_point(&[3; 32], &me, 10))));
        assert!(points.contains(&("room-3".to_string(), knock_point(&[3; 32], &me, 11))));
        // No room, no lookup.
        assert!(round_points(&[], &me, mid).is_empty());
    }

    #[test]
    fn the_welcome_room_is_looked_up_first_and_four_rooms_at_most() {
        let welcome = [9u8; 32];
        let mut rooms: Vec<(String, [u8; 32])> =
            ["e", "c", "w", "a", "d", "b"].iter().map(|id| (id.to_string(), if *id == "w" { welcome } else { [1u8; 32] })).collect();
        order_rooms(&mut rooms, |k| *k == welcome);
        let ids: Vec<&str> = rooms.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["w", "a", "b", "c"]);
        assert_eq!(rooms.len(), MAX_ROOMS);
    }

    #[test]
    fn one_address_one_hold_at_a_time_and_eight_holds_at_most() {
        let mut book = OpeningBook::default();
        let now = Instant::now();
        let a = v4(203, 0, 113, 9, 44442);
        assert!(book.begin(a, now));
        // The same address again while its hold runs: no.
        assert!(!book.begin(a, now));
        // Another port at the same address is another knocker (two computers
        // behind one router).
        assert!(book.begin(v4(203, 0, 113, 9, 44443), now));
        for i in 0..(MAX_OPENINGS as u8 - 2) {
            assert!(book.begin(v4(203, 0, 113, 100 + i, 44442), now));
        }
        assert_eq!(book.running(), MAX_OPENINGS);
        // The ninth waits, whoever it is.
        assert!(!book.begin(v4(203, 0, 113, 200, 44442), now));
        // And is taken once one ended.
        book.end(&a);
        assert!(book.begin(v4(203, 0, 113, 200, 44442), now));
    }

    #[test]
    fn an_address_rests_between_holds_and_has_three_an_hour() {
        let mut book = OpeningBook::default();
        let t0 = Instant::now();
        let a = v4(203, 0, 113, 9, 44442);
        assert!(book.begin(a, t0));
        book.end(&a);
        // The DHT lists the knock at the next look too: not again so soon.
        assert!(!book.begin(a, t0 + POLL_PERIOD));
        assert!(!book.begin(a, t0 + OPENING_REST - Duration::from_secs(1)));
        // After the rest: the second, then the third.
        assert!(book.begin(a, t0 + OPENING_REST));
        book.end(&a);
        assert!(book.begin(a, t0 + OPENING_REST * 2));
        book.end(&a);
        // A fourth inside the hour that began with the first: no, however
        // long it rested.
        assert!(!book.begin(a, t0 + OPENING_REST * 3));
        assert!(!book.begin(a, t0 + HOLDS_WINDOW - Duration::from_secs(1)));
        // A refused begin counted nothing and left nothing running.
        assert_eq!(book.running(), 0);
        // Once the first is an hour old it counts no more, and one fits.
        assert!(book.begin(a, t0 + HOLDS_WINDOW));
        book.end(&a);
        // And then the next waits for the second to be an hour old.
        assert!(!book.begin(a, t0 + HOLDS_WINDOW + OPENING_REST - Duration::from_secs(1)));
        assert!(book.begin(a, t0 + HOLDS_WINDOW + OPENING_REST));
    }

    #[test]
    fn no_boundary_of_the_clocks_hour_hands_an_address_a_fourth_hold_or_ends_its_rest() {
        // The book is never told the hour of the clock: a hold is counted
        // from when it began, whichever hour's point listed the knock and
        // whichever hour the lookup began or ended in. So the cases a clock
        // boundary could open are closed by construction, and shown here by
        // times alone.
        let mut book = OpeningBook::default();
        let t0 = Instant::now();
        let a = v4(203, 0, 113, 9, 44442);
        // A hold that got nothing, begun seconds before the hour turned (a
        // lookup begun in the old hour and ended in the new one).
        assert!(book.begin(a, t0));
        book.end(&a);
        // The hour has turned, and the old hour's point still lists the
        // knock during the overlap: the rest holds all the same.
        assert!(!book.begin(a, t0 + Duration::from_secs(8)));
        assert!(!book.begin(a, t0 + OPENING_REST - Duration::from_secs(1)));
        // Another address is not held up by what is kept of this one.
        assert!(book.begin(v4(203, 0, 113, 10, 44442), t0 + Duration::from_secs(60)));
        // In the new hour of the clock the address has two more holds, not
        // three: the one from seconds before the boundary still counts.
        assert!(book.begin(a, t0 + OPENING_REST));
        book.end(&a);
        assert!(book.begin(a, t0 + OPENING_REST * 2));
        book.end(&a);
        assert!(!book.begin(a, t0 + OPENING_REST * 3));
        assert!(!book.begin(a, t0 + OPENING_REST * 5));
        // In any sixty minutes, three: the fourth fits when the first is an
        // hour old.
        assert!(book.begin(a, t0 + HOLDS_WINDOW));
    }

    #[test]
    fn no_hold_toward_an_address_a_connection_stands_from() {
        let mut book = OpeningBook::default();
        let t0 = Instant::now();
        let a = v4(203, 0, 113, 9, 44442);
        let b = v4(203, 0, 113, 9, 44443);
        // The knocker's dial landed and its hold ended: the link stands.
        assert!(book.begin(a, t0));
        book.note_landed(a, t0 + Duration::from_secs(2));
        assert!(book.landed_since(&a, t0));
        book.end(&a);
        book.note_live(a);
        // The DHT still lists the knock, at every look and after any rest:
        // nothing is opened toward a computer that is linked.
        assert!(!book.begin(a, t0 + POLL_PERIOD));
        assert!(!book.begin(a, t0 + OPENING_REST * 2));
        // Another knocker behind the same router is not held up by it.
        assert!(book.begin(b, t0 + POLL_PERIOD));
        // Two connections from one address: the address is free once both
        // ended, not one.
        book.note_live(a);
        book.end_live(&a);
        assert!(!book.begin(a, t0 + OPENING_REST * 2));
        book.end_live(&a);
        assert!(book.begin(a, t0 + OPENING_REST * 2));
        // An end nobody noted a beginning for changes nothing.
        book.end_live(&v4(203, 0, 113, 77, 44442));
    }

    #[test]
    fn a_hold_that_got_its_connection_asks_for_no_rest_but_counts() {
        let mut book = OpeningBook::default();
        let t0 = Instant::now();
        let a = v4(203, 0, 113, 9, 44442);
        // Linked through the first hold, and the link was lost a minute on.
        assert!(book.begin(a, t0));
        book.note_landed(a, t0 + Duration::from_secs(2));
        assert!(book.landed_since(&a, t0));
        book.end(&a);
        book.note_live(a);
        book.end_live(&a);
        // Listed, and no connection stands: the knocker may be dialing
        // again, so the second hold does not wait for the rest.
        let second = t0 + Duration::from_secs(60);
        assert!(book.begin(a, second));
        book.end(&a);
        // That one got nothing: the rest holds again.
        assert!(!book.begin(a, second + POLL_PERIOD));
        assert!(book.begin(a, second + OPENING_REST));
        book.note_landed(a, second + OPENING_REST + Duration::from_secs(2));
        assert!(book.landed_since(&a, second + OPENING_REST));
        book.end(&a);
        // Three in the hour, landed or not: the fourth waits until the first
        // is an hour old, and then asks for no rest (the third landed).
        assert!(!book.begin(a, second + OPENING_REST + Duration::from_secs(60)));
        assert!(!book.begin(a, t0 + HOLDS_WINDOW - Duration::from_secs(1)));
        assert!(book.begin(a, t0 + HOLDS_WINDOW));
    }

    #[test]
    fn an_opening_marks_its_address_for_the_grace_and_no_longer() {
        let mut book = OpeningBook::default();
        let t0 = Instant::now();
        let ip = Ipv4Addr::new(203, 0, 113, 9);
        assert!(!book.opened_lately(ip, t0));
        book.note_opening(ip, t0);
        assert!(book.opened_lately(ip, t0));
        assert!(book.opened_lately(ip, t0 + OPENED_GRACE - Duration::from_secs(1)));
        // Another address was never opened toward.
        assert!(!book.opened_lately(Ipv4Addr::new(203, 0, 113, 10), t0));
        // A later opening dial renews the mark.
        book.note_opening(ip, t0 + Duration::from_secs(60));
        assert!(book.opened_lately(ip, t0 + OPENED_GRACE + Duration::from_secs(30)));
        // And it runs out.
        assert!(!book.opened_lately(ip, t0 + Duration::from_secs(60) + OPENED_GRACE));
    }

    #[test]
    fn a_landing_ends_the_hold_it_was_for_and_only_that_one() {
        let mut book = OpeningBook::default();
        let t0 = Instant::now();
        let a = v4(203, 0, 113, 9, 44442);
        let b = v4(203, 0, 113, 9, 44443);
        // A connection from an address no hold runs toward is not kept.
        book.note_landed(a, t0);
        assert!(book.begin(a, t0));
        assert!(!book.landed_since(&a, t0));
        // The knocker's dial lands.
        book.note_landed(a, t0 + Duration::from_secs(5));
        assert!(!book.landed_since(&b, t0));
        assert!(book.landed_since(&a, t0));
        // Read once.
        assert!(!book.landed_since(&a, t0));
        // A landing from before a later hold began does not end that hold.
        book.note_landed(a, t0 + Duration::from_secs(6));
        book.end(&a);
        let later = t0 + OPENING_REST;
        assert!(book.begin(a, later));
        assert!(!book.landed_since(&a, later));
    }

    /// The whole point of the opening dial: under a node id nobody holds, to
    /// an address where nobody speaks the game's language, the endpoint still
    /// SENDS, from its own socket, and the dial comes back without a link.
    #[tokio::test]
    async fn an_opening_dial_sends_from_the_games_socket_and_links_nothing() {
        let endpoint = IrohEndpoint::builder(iroh::endpoint::presets::Minimal)
            .alpns(vec![b"ssf".to_vec()])
            .bind_addr("127.0.0.1:0")
            .expect("a loopback address")
            .bind()
            .await
            .expect("an endpoint on loopback");
        let game_port = endpoint.bound_sockets().iter().find(|s| s.is_ipv4()).expect("an IPv4 socket").port();
        let knocker = tokio::net::UdpSocket::bind("127.0.0.1:0").await.expect("a UDP socket");
        let SocketAddr::V4(knocker_addr) = knocker.local_addr().unwrap() else { panic!("IPv4") };

        let dial = tokio::spawn({
            let endpoint = endpoint.clone();
            async move { opening_dial(&endpoint, knocker_addr).await }
        });
        let mut buf = [0u8; 2048];
        let (len, from) = tokio::time::timeout(Duration::from_secs(3), knocker.recv_from(&mut buf))
            .await
            .expect("a packet within three seconds")
            .expect("a packet");
        // A QUIC Initial is padded to 1200 bytes at least.
        assert!(len >= 1200, "an Initial, not {len} bytes");
        assert_eq!(from.port(), game_port, "from the game's own socket");
        // Nobody answers: the dial ends by itself, inside its own timeout.
        tokio::time::timeout(OPENING_DIAL_TIMEOUT + Duration::from_secs(2), dial).await.expect("the dial ends").unwrap();
        endpoint.close().await;
    }

    /// A knock announced by one client is found by another at the same point,
    /// with the port it named, on a DHT of this process's own.
    #[tokio::test]
    async fn a_knock_announced_is_found_at_its_point_and_nowhere_else() {
        let testnet = n0_mainline::Testnet::new(8).await.expect("a DHT of our own");
        let client = || {
            let mut builder = DhtBuilder::default();
            builder.bootstrap(&testnet.bootstrap);
            KnockDht::start(&builder).expect("a DHT client")
        };
        let knocker = client();
        let holder = client();
        assert_eq!(knocker.dht.bootstrapped().await, Ok(true));
        assert_eq!(holder.dht.bootstrapped().await, Ok(true));

        let room = [7u8; 32];
        let me = key(1);
        let point = knock_point(&room, &me, 500_000);
        assert_eq!(holder.lookup(point, LOOKUP_TIMEOUT).await, Some(BTreeSet::new()));
        knocker.announce(point, 44442).await.expect("the announce is stored");
        let found = holder.lookup(point, LOOKUP_TIMEOUT).await.expect("a lookup");
        assert_eq!(found.into_iter().map(|a| a.port()).collect::<Vec<_>>(), vec![44442]);
        // Another hour's point, and another room's, list nobody.
        assert_eq!(holder.lookup(knock_point(&room, &me, 500_001), LOOKUP_TIMEOUT).await, Some(BTreeSet::new()));
        assert_eq!(holder.lookup(knock_point(&[8u8; 32], &me, 500_000), LOOKUP_TIMEOUT).await, Some(BTreeSet::new()));
    }

    #[tokio::test]
    async fn the_grace_after_an_opening_dial_counts_from_when_it_was_let_go() {
        let endpoint = IrohEndpoint::builder(iroh::endpoint::presets::Minimal)
            .alpns(vec![b"ssf".to_vec()])
            .bind_addr("127.0.0.1:0")
            .expect("a loopback address")
            .bind()
            .await
            .expect("an endpoint on loopback");
        // A socket that never answers: the dial runs its whole timeout.
        let knocker = tokio::net::UdpSocket::bind("127.0.0.1:0").await.expect("a UDP socket");
        let SocketAddr::V4(knocker_addr) = knocker.local_addr().unwrap() else { panic!("IPv4") };
        let book = Mutex::new(OpeningBook::default());
        let began = Instant::now();
        noted_opening_dial(&book, &endpoint, knocker_addr).await;
        let let_go = Instant::now();
        let ran = let_go.duration_since(began);
        assert!(ran >= OPENING_DIAL_TIMEOUT - Duration::from_millis(100), "the dial ran its timeout, not {ran:?}");
        // The dial sent until it was let go, so the address is still marked a
        // whole grace after it BEGAN, short of nothing but the dial's length.
        let ip = *knocker_addr.ip();
        assert!(book.lock().unwrap().opened_lately(ip, began + OPENED_GRACE + Duration::from_secs(1)));
        assert!(book.lock().unwrap().opened_lately(ip, let_go + OPENED_GRACE - Duration::from_secs(1)));
        // And the mark runs out a grace after the dial was let go.
        assert!(!book.lock().unwrap().opened_lately(ip, let_go + OPENED_GRACE + Duration::from_secs(1)));
        endpoint.close().await;
    }

    #[tokio::test]
    async fn a_standing_link_is_known_by_where_its_packets_go_whichever_side_dialed() {
        async fn loopback() -> (IrohEndpoint, SocketAddrV4) {
            let endpoint = IrohEndpoint::builder(iroh::endpoint::presets::Minimal)
                .alpns(vec![b"ssf".to_vec()])
                .bind_addr("127.0.0.1:0")
                .expect("a loopback address")
                .bind()
                .await
                .expect("an endpoint on loopback");
            let bound = endpoint.bound_sockets().iter().find_map(|s| match s {
                SocketAddr::V4(v4) => Some(*v4),
                SocketAddr::V6(_) => None,
            });
            (endpoint, bound.expect("an IPv4 socket"))
        }
        /// The snapshot of a link's paths may come a moment after the handshake.
        async fn has_path(conn: &iroh::endpoint::Connection, to: SocketAddrV4) -> bool {
            for _ in 0..30 {
                if direct_paths_of(conn).contains(&to) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            false
        }
        let (dialer, dialer_addr) = loopback().await;
        let (dialed, dialed_addr) = loopback().await;
        let accepting = tokio::spawn({
            let dialed = dialed.clone();
            async move { dialed.accept().await.expect("an incoming dial").accept().expect("accepted").await.expect("a handshake") }
        });
        let out = dialer
            .connect(EndpointAddr::new(dialed.id()).with_ip_addr(SocketAddr::V4(dialed_addr)), b"ssf")
            .await
            .expect("the dial lands");
        let inbound = accepting.await.expect("the accepting task");
        // The side that dialed knows the link by the address it reached: the
        // case the book's own rule, which hears only of inbound links, misses.
        assert!(has_path(&out, dialed_addr).await, "{:?}", direct_paths_of(&out));
        // The side that was dialed knows it by the address the dial came from.
        assert!(has_path(&inbound, dialer_addr).await, "{:?}", direct_paths_of(&inbound));
        // Neither is known by the other's address.
        assert!(!direct_paths_of(&out).contains(&dialer_addr));
        // A link that has closed stands to nothing.
        out.close(0u32.into(), b"done");
        assert!(direct_paths_of(&out).is_empty());
        dialer.close().await;
        dialed.close().await;
    }

    #[tokio::test]
    async fn a_lookup_keeps_what_it_found_when_its_tail_is_slow() {
        let knocker = v4(203, 0, 113, 7, 44442);
        let other = v4(203, 0, 113, 8, 44442);
        // A lookup that answers once and then never ends: what came before the
        // deadline is kept, and the deadline is not run past by much.
        let stalled = n0_future::stream::once(vec![knocker]).chain(n0_future::stream::pending());
        let began = Instant::now();
        let found = gathered_until(stalled, tokio::time::Instant::now() + Duration::from_millis(200)).await;
        assert_eq!(found, BTreeSet::from([knocker]));
        assert!(began.elapsed() >= Duration::from_millis(200) && began.elapsed() < Duration::from_secs(10), "{:?}", began.elapsed());
        // A lookup that ends by itself is not waited on: all of it, at once.
        let ended = n0_future::stream::iter(vec![vec![knocker], vec![other, knocker]]);
        let began = Instant::now();
        let found = gathered_until(ended, tokio::time::Instant::now() + Duration::from_secs(60)).await;
        assert_eq!(found, BTreeSet::from([knocker, other]));
        assert!(began.elapsed() < Duration::from_secs(30), "{:?}", began.elapsed());
        // A lookup that says nothing in time found nobody.
        let silent = n0_future::stream::pending::<Vec<SocketAddrV4>>();
        assert!(gathered_until(silent, tokio::time::Instant::now() + Duration::from_millis(50)).await.is_empty());
    }

    fn cap(byte: u8) -> crate::chia_rooms::ChiaRoomCap {
        crate::chia_rooms::ChiaRoomCap { room_key: [byte; 32], share_card: true, public_room: None, seq: 0, restored: false, pass_private: false, prefetch: false }
    }

    #[tokio::test]
    async fn a_dial_begun_before_its_rooms_key_was_filed_knocks_once_it_is() {
        // The page's cap and its sync ride streams of their own, and the cap
        // is not waited for: the first dial of a session can be the earlier.
        let rooms = Arc::new(Mutex::new(HashMap::new()));
        // Another room's key is not this room's.
        rooms.lock().unwrap().insert("other".to_string(), cap(8));
        let waiting = tokio::spawn({
            let rooms = rooms.clone();
            async move { room_key_when_held(&rooms, "room").await }
        });
        tokio::time::sleep(KEY_WAIT_PERIOD * 2).await;
        assert!(!waiting.is_finished(), "no key yet: the knock waits, it does not give the dial up");
        rooms.lock().unwrap().insert("room".to_string(), cap(7));
        let room_key = tokio::time::timeout(KEY_WAIT_PERIOD * 20, waiting).await.expect("seen within a few looks").expect("the wait ended by itself");
        assert_eq!(room_key, [7u8; 32]);
        // A key that is held already is given at once.
        assert_eq!(tokio::time::timeout(KEY_WAIT_PERIOD, room_key_when_held(&rooms, "room")).await, Ok([7u8; 32]));
    }

    #[test]
    fn a_knock_is_sent_only_for_an_open_room_and_a_target_not_linked_in_it() {
        assert!(knock_wanted(Some(false)));
        assert!(!knock_wanted(Some(true)), "linked meanwhile, by this dial's own attempt or by another path");
        assert!(!knock_wanted(None), "the room is no longer open here");
    }
}
