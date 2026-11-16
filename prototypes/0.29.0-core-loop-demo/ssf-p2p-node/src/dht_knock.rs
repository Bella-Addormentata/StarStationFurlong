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
//! - **The dial back**: the holder's own router may give its game socket a
//!   different outside port for every destination (GitHub's machines do), so
//!   the knocker's dial to the holder's port never meets it. The opening dial
//!   arrives FROM that mapping, though: while a knock is out, the knocker
//!   keeps where an opening came in from ([`CameIn`]), and its dial to that IP
//!   goes there too, on the pair of addresses both routers already let
//!   through. It lands wherever the opening got in at all (2026-11-16: a
//!   GitHub machine held, a home computer whose router had opened a port
//!   knocked, and they linked 33 s after the invite was opened).
//! - **The IPv6 note**: on IPv6 no router hands out ports, so none moves one;
//!   a firewall lets in only what the computer behind it sent out toward
//!   first, which is the knock's job again. The knocker's dial already goes
//!   to the holder's IPv6 addresses (the DHT's address record of the holder
//!   lists them), and that opens the knocker's side. The DHT's peer lists
//!   carry IPv4 only (BEP 5 as this client speaks it), so beside each knock
//!   the knocker leaves a **note** (a BEP 44 stored item, signed by a key
//!   worked out from the same room key, holder and hour, [`v6_note_signer`]):
//!   its own public IPv6 addresses with the game's port, sealed with a key
//!   from the same three ([`seal_v6_note`]), each for [`V6_NOTE_LIFE`]. Every
//!   knocker at one holder writes the one note and keeps what the others left
//!   ([`merge_v6_note`]). A holder with a public IPv6 address of its own
//!   reads its notes with its knock points and runs the same opening holds
//!   toward each address in them ([`v6_openings`]), from its IPv6 socket. Two
//!   computers with IPv6 therefore link where the IPv4 knock cannot: a router
//!   that gives every destination its own port does not matter here.
//!
//! What it does not do: it does not find a holder's address (the dial does
//! that, from the pass and the DHT's address record), and it reads and writes
//! nothing of Chia. It does not help where the knocker's router gives the
//! game's socket an outside port the node does not know: a different one for
//! every destination, or one fixed other port the router never told it. The
//! knock names the outside port as far as it is known ([`knock_port`]), and
//! the holder's router lets in only what comes from the port it sent to. Nor,
//! for the same reason, where the holder's router is the one with a port for
//! every destination and the knocker's lets in only what it asked for: its
//! opening never gets in, so there is nothing to dial back to.
//!
//! Who can see what: a knocker's address and port are stored by the DHT nodes
//! nearest the knock point, and handed to anyone who asks at that point. The
//! point cannot be worked out without the room's key, so for a private room
//! that is the room's members; SSF-WELCOME's key ships in the game, so there
//! it is anyone. The address is the one the knocker's dial shows the holder
//! anyway. A note is sealed: the DHT's nodes keep an item they cannot read,
//! under a key that says nothing of the room or the holder, and see the
//! knocker's IPv4 address as with any request. Whoever holds the room's key
//! reads the knocker's IPv6 addresses, which the node's own address record
//! lists under its node id anyway. Unlike a knock, a note could name an
//! address that is not the writer's: a holder opens only toward public
//! addresses at ports the game could have bound ([`v6_admitted`]), and the
//! book's caps bound how often, as for any opening. Off with `SSF_NO_DHT=1`
//! (the whole DHT) or `SSF_DHT_KNOCK=0`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use iroh::{Endpoint as IrohEndpoint, EndpointAddr, PublicKey, SecretKey, TransportAddr};
use n0_future::StreamExt;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use n0_mainline::{Dht, Id, MutableItem, SigningKey};
#[cfg(test)]
use n0_mainline::DhtBuilder;

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

/// How long the knocker keeps the address an opening dial came in from
/// ([`CameIn`]). Openings come every [`OPENING_PERIOD`], and each one keeps
/// the routers' entries for that pair of addresses fresh; one heard longer ago
/// than this is not dialed back.
pub(crate) const DIAL_BACK_FOR: Duration = Duration::from_secs(60);

/// The most addresses [`CameIn`] keeps. Each one is an opening that came in
/// while a knock of ours was out, so a handful is plenty; the bound keeps a
/// stream of stray inbound dials from growing it.
pub(crate) const CAME_IN_MAX: usize = 16;

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

/// An announce that has not ended in this long is no longer waited for. It
/// goes on in the DHT client all the same, so the knock may still be stored
/// ([`Announced::Unconfirmed`]). Measured on the real DHT: 0.3 to 7 s from
/// cloud runners, and 18 s from a home line whose node had joined the DHT
/// half a minute before (2026-11-14), which the first limit of 20 s left no
/// room for.
const ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(60);

/// A knocker's port below this is not opened toward: the game never binds
/// one, and nothing is sent to another service's port on a knocker's word.
const MIN_KNOCK_PORT: u16 = 1024;

/// How long an entry of an IPv6 note stands: the knocker writes it again with
/// every knock ([`KNOCK_PERIOD`]), so it outlives its dial by this long at
/// most, and the holder passes over what is older ([`v6_openings`]).
pub(crate) const V6_NOTE_LIFE: Duration = Duration::from_secs(600);
/// Entries one note holds at most, the newest kept: the knockers at one holder
/// in one room and hour, with up to [`V6_PER_KNOCKER`] addresses each.
pub(crate) const V6_NOTE_MAX: usize = 8;
/// A knocker's own public IPv6 addresses one note carries at most: most often
/// two, the stable one and the temporary one its packets leave from.
pub(crate) const V6_PER_KNOCKER: usize = 3;
/// The note's layout: this byte, the count, then per entry the address (16
/// bytes), the port and the unix second it stands until (big-endian).
const V6_NOTE_VERSION: u8 = 1;
const V6_ENTRY_LEN: usize = 16 + 2 + 8;
/// Bound into the seal, so a note opens as nothing else.
const V6_NOTE_AAD: &[u8] = b"StarStationFurlong DHT knock IPv6 note v1";
/// How long after writing the note a knocker reads it again, to see that a
/// knocker who wrote at the same moment from an older read did not drop its
/// entries; if one did, it writes them back at once.
#[cfg(not(test))]
const V6_NOTE_RECHECK: Duration = Duration::from_secs(10);
#[cfg(test)]
const V6_NOTE_RECHECK: Duration = Duration::from_millis(500);
/// How long a knock waits on its note at most: a read, a write and the read
/// that checks it, once more if another knocker's write crossed it.
const V6_NOTE_WAIT: Duration = Duration::from_secs(90);

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

/// One address in an IPv6 note: a knocker's public IPv6 address with the
/// game's port, and the unix second it stands until.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct V6Entry {
    pub(crate) addr: SocketAddrV6,
    pub(crate) until: u64,
}

/// The key that signs the IPv6 note for `holder` in the room of `room_key`
/// during the hour `bucket`. Everyone with the room's key can work it out, so
/// every knocker writes the one note, and the holder knows where to read it;
/// its public half says nothing of the room or the holder without the key.
pub(crate) fn v6_note_signer(room_key: &[u8; 32], holder: &PublicKey, bucket: u64) -> SigningKey {
    let mut hasher = blake3::Hasher::new_derive_key("StarStationFurlong 2026-11-16 DHT knock IPv6 note signer v1");
    hasher.update(room_key);
    hasher.update(holder.as_bytes());
    hasher.update(&bucket.to_le_bytes());
    SigningKey::from_bytes(hasher.finalize().as_bytes())
}

/// The key the same note is sealed with: the DHT's nodes keep a note they
/// cannot read.
pub(crate) fn v6_note_key(room_key: &[u8; 32], holder: &PublicKey, bucket: u64) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new_derive_key("StarStationFurlong 2026-11-16 DHT knock IPv6 note seal v1");
    hasher.update(room_key);
    hasher.update(holder.as_bytes());
    hasher.update(&bucket.to_le_bytes());
    *hasher.finalize().as_bytes()
}

/// `entries` sealed with `key`: a fresh 24-byte nonce, then XChaCha20-Poly1305.
pub(crate) fn seal_v6_note(key: &[u8; 32], entries: &[V6Entry]) -> Vec<u8> {
    let entries = &entries[..entries.len().min(V6_NOTE_MAX)];
    let mut plain = Vec::with_capacity(2 + entries.len() * V6_ENTRY_LEN);
    plain.push(V6_NOTE_VERSION);
    plain.push(entries.len() as u8);
    for entry in entries {
        plain.extend_from_slice(&entry.addr.ip().octets());
        plain.extend_from_slice(&entry.addr.port().to_be_bytes());
        plain.extend_from_slice(&entry.until.to_be_bytes());
    }
    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let sealed = XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: V6_NOTE_AAD })
        .expect("sealing a short note cannot fail");
    let mut out = Vec::with_capacity(24 + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    out
}

/// The entries of a note sealed with `key`, or `None` for one this key does
/// not open or whose layout is not this version's to the byte.
pub(crate) fn open_v6_note(key: &[u8; 32], sealed: &[u8]) -> Option<Vec<V6Entry>> {
    if sealed.len() < 24 {
        return None;
    }
    let plain = XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(&sealed[..24]), Payload { msg: &sealed[24..], aad: V6_NOTE_AAD })
        .ok()?;
    let (&version, rest) = plain.split_first()?;
    let (&count, rest) = rest.split_first()?;
    let count = count as usize;
    if version != V6_NOTE_VERSION || count > V6_NOTE_MAX || rest.len() != count * V6_ENTRY_LEN {
        return None;
    }
    Some(
        rest.chunks_exact(V6_ENTRY_LEN)
            .map(|chunk| {
                let ip: [u8; 16] = chunk[..16].try_into().expect("16 bytes");
                let port = u16::from_be_bytes([chunk[16], chunk[17]]);
                let until = u64::from_be_bytes(chunk[18..26].try_into().expect("8 bytes"));
                V6Entry { addr: SocketAddrV6::new(Ipv6Addr::from(ip), port, 0, 0), until }
            })
            .collect(),
    )
}

/// Does `entry` stand at `now`? Not once its time is up, nor when it claims
/// more than twice [`V6_NOTE_LIFE`] ahead: no knocker writes that, whatever
/// its clock says, so it is passed over rather than kept for hours.
fn v6_entry_stands(entry: &V6Entry, now: u64) -> bool {
    entry.until > now && entry.until <= now + 2 * V6_NOTE_LIFE.as_secs()
}

/// The note a knocker writes: what `old` held that still stands, other than
/// its own entries `mine`, and then `mine`, each for [`V6_NOTE_LIFE`] from
/// `now`. An entry is matched by address AND port: two games on one computer
/// share its addresses on ports of their own, and neither may drop the
/// other's. An entry of ours at a port we left is not ours to drop either; it
/// runs out by itself. The newest [`V6_NOTE_MAX`] are kept.
pub(crate) fn merge_v6_note(old: &[V6Entry], mine: &[SocketAddrV6], now: u64) -> Vec<V6Entry> {
    let mut entries: Vec<V6Entry> =
        old.iter().filter(|entry| v6_entry_stands(entry, now) && !mine.contains(&entry.addr)).copied().collect();
    let until = now + V6_NOTE_LIFE.as_secs();
    entries.extend(mine.iter().map(|addr| V6Entry { addr: *addr, until }));
    entries.sort_by_key(|entry| entry.until);
    let over = entries.len().saturating_sub(V6_NOTE_MAX);
    entries.drain(..over);
    entries
}

/// May the holder open toward `addr`, as far as the address itself goes: a
/// public IPv6 address that is not one of our own, at a port the game could
/// have bound. A note, unlike a knock, could name any address at all, so the
/// same rule as for an address a record declares of itself holds (main.rs
/// `ipv6_is_public`), and the book's caps bound how often it is opened toward.
/// An IPv4 address in IPv6 clothing (`::ffff:a.b.c.d`, `::a.b.c.d`) is no
/// IPv6 address at all: the IPv4 knock is the way for it, so it is refused
/// here, where neither our own IPv4 addresses nor the IPv4 holds are counted.
pub(crate) fn v6_admitted(addr: &SocketAddrV6, own: &HashSet<Ipv6Addr>, is_public: impl Fn(Ipv6Addr) -> bool) -> bool {
    addr.port() >= MIN_KNOCK_PORT && addr.ip().to_ipv4().is_none() && is_public(*addr.ip()) && !own.contains(addr.ip())
}

/// The addresses of a note the holder opens toward at `now`: those that still
/// stand ([`v6_entry_stands`]) and are admitted ([`v6_admitted`]), each once.
pub(crate) fn v6_openings(entries: &[V6Entry], now: u64, own: &HashSet<Ipv6Addr>, is_public: impl Fn(Ipv6Addr) -> bool) -> Vec<SocketAddrV6> {
    let mut out: Vec<SocketAddrV6> = Vec::new();
    for entry in entries {
        if v6_entry_stands(entry, now) && v6_admitted(&entry.addr, own, &is_public) && !out.contains(&entry.addr) {
            out.push(entry.addr);
        }
    }
    out
}

/// This computer's own public IPv6 addresses with the game's port, as the
/// endpoint sees them now (`live`), one per address, [`V6_PER_KNOCKER`] at
/// most: what a knock's note carries. Nothing on a computer without IPv6.
pub(crate) fn own_public_v6(live: &[SocketAddr], is_public: impl Fn(Ipv6Addr) -> bool) -> Vec<SocketAddrV6> {
    let mut out: Vec<SocketAddrV6> = Vec::new();
    for sock in live {
        if let SocketAddr::V6(v6) = sock {
            if v6.ip().to_ipv4().is_none() && is_public(*v6.ip()) && !out.iter().any(|kept| kept.ip() == v6.ip()) {
                out.push(SocketAddrV6::new(*v6.ip(), v6.port(), 0, 0));
            }
        }
    }
    out.truncate(V6_PER_KNOCKER);
    out
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
    /// Holds running now, by the knocker's address (IPv4 from the knock,
    /// IPv6 from the knock's note).
    running: HashSet<SocketAddr>,
    /// Per address, its holds of the last [`HOLDS_WINDOW`].
    begun: HashMap<SocketAddr, Held>,
    /// Addresses an opening dial went to, and when the last one left.
    opened: HashMap<IpAddr, Instant>,
    /// Addresses a connection came in from, and when.
    landed: HashMap<SocketAddr, Instant>,
    /// Addresses a connection that came in from them stands to now, with how
    /// many do.
    live: HashMap<SocketAddr, u32>,
}

impl OpeningBook {
    /// Claim a hold toward `addr` at `now`: `true` when it may begin (and is
    /// now counted as running), `false` when one runs already,
    /// [`MAX_OPENINGS`] run, a connection from that address stands, the
    /// address had its [`MAX_HOLDS_PER_ADDR`] in the last [`HOLDS_WINDOW`],
    /// or its last hold got no connection and began less than
    /// [`OPENING_REST`] ago.
    pub(crate) fn begin(&mut self, addr: impl Into<SocketAddr>, now: Instant) -> bool {
        let addr = addr.into();
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
    pub(crate) fn end(&mut self, addr: &(impl Into<SocketAddr> + Copy)) {
        self.running.remove(&(*addr).into());
    }

    /// An opening dial is leaving for `ip`.
    pub(crate) fn note_opening(&mut self, ip: impl Into<IpAddr>, now: Instant) {
        self.opened.retain(|_, at| now.duration_since(*at) < OPENED_GRACE);
        self.opened.insert(ip.into(), now);
    }

    /// Did an opening dial go to `ip` within [`OPENED_GRACE`]?
    pub(crate) fn opened_lately(&mut self, ip: impl Into<IpAddr>, now: Instant) -> bool {
        self.opened.retain(|_, at| now.duration_since(*at) < OPENED_GRACE);
        self.opened.contains_key(&ip.into())
    }

    /// A connection came in from `addr`. Kept only while a hold toward that
    /// address runs: nobody else asks.
    pub(crate) fn note_landed(&mut self, addr: impl Into<SocketAddr>, now: Instant) {
        let addr = addr.into();
        if self.running.contains(&addr) {
            self.landed.insert(addr, now);
        }
    }

    /// Did a connection come in from `addr` since `since`? The hold toward it
    /// stops asking for one then, and is remembered as one that got its
    /// connection. Forgets the mark once read as true.
    pub(crate) fn landed_since(&mut self, addr: &(impl Into<SocketAddr> + Copy), since: Instant) -> bool {
        let addr: SocketAddr = (*addr).into();
        match self.landed.get(&addr) {
            Some(at) if *at >= since => {
                self.landed.remove(&addr);
                if let Some(held) = self.begun.get_mut(&addr) {
                    held.landed = true;
                }
                true
            }
            _ => false,
        }
    }

    /// The hold toward `addr` is over because a link stands to that address
    /// by now, made some other way than by a connection coming in from it (a
    /// dial of our own that landed while the knocker's ran). Remembered as a
    /// hold that got its link: it asks for no rest.
    pub(crate) fn note_linked(&mut self, addr: &(impl Into<SocketAddr> + Copy)) {
        if let Some(held) = self.begun.get_mut(&(*addr).into()) {
            held.landed = true;
        }
    }

    /// A connection that came in from `addr` stands from now on.
    pub(crate) fn note_live(&mut self, addr: impl Into<SocketAddr>) {
        *self.live.entry(addr.into()).or_insert(0) += 1;
    }

    /// One connection that came in from `addr` ended.
    pub(crate) fn end_live(&mut self, addr: &(impl Into<SocketAddr> + Copy)) {
        let addr: SocketAddr = (*addr).into();
        if let Some(count) = self.live.get_mut(&addr) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.live.remove(&addr);
            }
        }
    }

    #[cfg(test)]
    fn running(&self) -> usize {
        self.running.len()
    }
}

/// The knocker's side of an opening that came in: where the holder's opening
/// dials came from, and when. The holder's router may give its game socket a
/// different outside port for every destination (GitHub's machines do,
/// 2026-11-16): the port the knocker dials then never meets the holder's
/// mapping, but the opening dial arrives FROM it. A dial of the knocker's own
/// to that very address goes out on the pair of addresses the opening came in
/// on, which both routers already let through, so it lands, where the
/// knocker's router let the opening in at all (a port it forwards or had
/// opened for it, or one that lets in anyone once the computer has sent out).
/// Pure: the clock is handed in.
#[derive(Default)]
pub(crate) struct CameIn {
    /// The addresses openings came in from, and when the last one from each
    /// did. Several per IP: two holders behind one public address each open
    /// from a port of their own, and neither may push the other's out.
    from: HashMap<SocketAddrV4, Instant>,
}

impl CameIn {
    /// An opening dial came in from `addr` at `now`. At most [`CAME_IN_MAX`]
    /// addresses are kept, the ones heard from last.
    pub(crate) fn note(&mut self, addr: SocketAddrV4, now: Instant) {
        self.from.retain(|_, at| now.duration_since(*at) < DIAL_BACK_FOR);
        self.from.insert(addr, now);
        while self.from.len() > CAME_IN_MAX {
            let oldest = self.from.iter().min_by_key(|(addr, at)| (**at, **addr)).map(|(addr, _)| *addr);
            match oldest {
                Some(addr) => self.from.remove(&addr),
                None => break,
            };
        }
    }

    /// The addresses to dial back for a dial whose hints name `ips`: those an
    /// opening came in from within [`DIAL_BACK_FOR`], from one of those IPs,
    /// that the dial does not hold already (`known`). An opening from an IP
    /// the dial does not name is not followed: the dial would only go where
    /// nobody it means is.
    pub(crate) fn dial_back(&mut self, ips: &HashSet<Ipv4Addr>, known: &HashSet<SocketAddr>, now: Instant) -> Vec<SocketAddrV4> {
        self.from.retain(|_, at| now.duration_since(*at) < DIAL_BACK_FOR);
        let mut back: Vec<SocketAddrV4> = self
            .from
            .keys()
            .filter(|addr| ips.contains(addr.ip()) && !known.contains(&SocketAddr::V4(**addr)))
            .copied()
            .collect();
        back.sort();
        back
    }
}

/// The node's own client on the Mainline DHT for knocks, with the holder's
/// book. The address lookup keeps the client it publishes and resolves with
/// to itself, so this is a second one, on a socket of its own, which the
/// public-IPv4 votes (public_v4.rs) read too (main.rs `own_dht`).
pub struct KnockDht {
    dht: Dht,
    book: Mutex<OpeningBook>,
    /// Knocks of ours that are out now: dials that still run and whose knock
    /// is stored or on its way to be ([`announced`]). While any is, a
    /// handshake that fails on the way in is most likely the opening dial we
    /// asked for (main.rs `run_iroh_listener`).
    knocks_out: AtomicUsize,
    /// Where opening dials toward us came in from, to dial back
    /// ([`CameIn`]).
    came_in: Mutex<CameIn>,
}

impl KnockDht {
    /// Knock on `dht`, the node's own DHT client (main.rs `own_dht`), whose
    /// join goes on in the background.
    pub(crate) fn on(dht: Dht) -> Self {
        Self { dht, book: Mutex::new(OpeningBook::default()), knocks_out: AtomicUsize::new(0), came_in: Mutex::new(CameIn::default()) }
    }

    /// Join the DHT with `builder` on a client of the test's own.
    #[cfg(test)]
    pub(crate) fn start(builder: &DhtBuilder) -> std::io::Result<Self> {
        Ok(Self::on(builder.build()?))
    }

    /// Is a knock of ours out now?
    pub(crate) fn knock_out(&self) -> bool {
        self.knocks_out.load(Ordering::SeqCst) > 0
    }

    /// Did an opening dial of ours go to `ip` lately (main.rs
    /// `note_inbound_verified`: a connection from there is not unsolicited)?
    pub(crate) fn opened_lately(&self, ip: std::net::IpAddr, now: Instant) -> bool {
        self.book.lock().unwrap().opened_lately(ip, now)
    }

    /// A connection was accepted from `addr` (main.rs `run_iroh_listener`).
    pub(crate) fn note_landed(&self, addr: SocketAddr) {
        self.book.lock().unwrap().note_landed(addr, Instant::now());
    }

    /// An inbound dial that ended before it linked came from `addr` while a
    /// knock of ours was out: most likely the opening we asked for (main.rs
    /// `run_iroh_listener`). Kept to dial back ([`CameIn`]).
    pub(crate) fn note_opening_from(&self, addr: SocketAddr) {
        if let SocketAddr::V4(v4) = addr {
            self.came_in.lock().unwrap().note(v4, Instant::now());
        }
    }

    /// Where a dial whose hints are `hints` should also go: the addresses an
    /// opening came in from lately, from the IPs it dials ([`CameIn::dial_back`]).
    pub(crate) fn dial_back(&self, hints: &[SocketAddr]) -> Vec<SocketAddrV4> {
        let ips: HashSet<Ipv4Addr> = hints
            .iter()
            .filter_map(|addr| match addr {
                SocketAddr::V4(v4) => Some(*v4.ip()),
                SocketAddr::V6(_) => None,
            })
            .collect();
        let known: HashSet<SocketAddr> = hints.iter().copied().collect();
        self.came_in.lock().unwrap().dial_back(&ips, &known, Instant::now())
    }

    /// A connection accepted from `addr` stands for as long as the guard this
    /// hands back is kept (main.rs `run_iroh_listener` keeps it in the
    /// connection's task): no opening hold begins toward that address
    /// meanwhile. `None` with the knock off.
    pub(crate) fn live_from(hub: &SharedHub, addr: SocketAddr) -> Option<LiveFrom> {
        hub.dht_knock.as_ref()?.book.lock().unwrap().note_live(addr);
        Some(LiveFrom { hub: hub.clone(), addr })
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

    /// Every version of the note signed by `public` that the DHT handed over
    /// within `within` ([`NOTE_VERSIONS_MAX`] at most, the newest kept), and
    /// whether the read got to its end by then. `None` only when the DHT
    /// client has stopped. As with a lookup, what came early is kept when the
    /// tail is slow.
    async fn read_note(&self, public: &[u8; 32], within: Duration) -> Option<NoteRead> {
        let deadline = tokio::time::Instant::now() + within;
        let mut answers = match tokio::time::timeout_at(deadline, self.dht.get_mutable(public, None, None)).await {
            Ok(Ok(answers)) => answers,
            Ok(Err(_)) => return None,
            Err(_) => return Some(NoteRead { items: Vec::new(), complete: false }),
        };
        let mut items: Vec<MutableItem> = Vec::new();
        let complete = loop {
            match tokio::time::timeout_at(deadline, answers.next()).await {
                Ok(Some(item)) => {
                    if !items.iter().any(|kept| kept.seq() == item.seq() && kept.value() == item.value()) {
                        items.push(item);
                        items.sort_by_key(|kept| std::cmp::Reverse(kept.seq()));
                        items.truncate(NOTE_VERSIONS_MAX);
                    }
                }
                Ok(None) => break true,
                Err(_) => break false,
            }
        };
        Some(NoteRead { items, complete })
    }

    /// Leave `mine`, this computer's public IPv6 addresses, in the note for
    /// `holder` in the room of `room_key` during the hour `bucket`: read the
    /// note (waiting `read_within` at most), keep what other knockers left
    /// that still stands, write it back newer, and read it again
    /// [`V6_NOTE_RECHECK`] later. The number of entries the note holds on
    /// success.
    ///
    /// A note is one item that every knocker at this holder writes whole, and
    /// a DHT node keeps the last write it was handed. So:
    /// - a read that did not get to its end and found nothing writes nothing:
    ///   the note may be there unread, and writing over it would drop the
    ///   other knockers' entries. The next knock tries again.
    /// - what is written is merged from every version the read saw, so two
    ///   versions that nodes hold side by side (two knockers who wrote at
    ///   once) become one again; and the write names the newest version read
    ///   (`cas`): where another knocker wrote in between, the DHT's nodes turn
    ///   it down, and the knocker reads again and writes once more.
    /// - the read after the write must find the note settled: one newest
    ///   version, with all of ours in it ([`note_settled`]). Otherwise our
    ///   write was crossed, counts for nothing, and the knocker writes again.
    ///   Three crossed writes in a row are a failure, and the next knock
    ///   tries again.
    async fn leave_v6_note(
        &self,
        room_key: &[u8; 32],
        holder: &PublicKey,
        bucket: u64,
        mine: &[SocketAddrV6],
        read_within: Duration,
    ) -> Result<usize, String> {
        let signer = v6_note_signer(room_key, holder, bucket);
        let key = v6_note_key(room_key, holder, bucket);
        let public = signer.verifying_key().to_bytes();
        // Our last write, until the read after it says it was crossed.
        let mut written: Option<usize> = None;
        for _ in 0..3 {
            let read = self.read_note(&public, read_within).await.ok_or("the DHT client stopped")?;
            let versions = opened_versions(&key, &read.items);
            let now = crate::chia_resolve::unix_now();
            if let Some(entries) = written {
                if note_settled(&versions, mine) {
                    return Ok(note_entries(&versions, now).len());
                }
                // A read that saw nothing in time says nothing either way.
                if read.items.is_empty() && !read.complete {
                    return Ok(entries);
                }
                written = None;
            } else if read.items.is_empty() && !read.complete {
                return Err(format!("the note could not be read within {} s; the next knock writes it", read_within.as_secs()));
            }
            let cas = read.items.iter().map(MutableItem::seq).max();
            let entries = merge_v6_note(&note_entries(&versions, now), mine, now);
            let item = MutableItem::new(&signer, &seal_v6_note(&key, &entries), note_seq(cas), None);
            match self.dht.put_mutable(item, cas).await {
                Ok(_) => {
                    written = Some(entries.len());
                    tokio::time::sleep(V6_NOTE_RECHECK).await;
                }
                Err(n0_mainline::errors::PutMutableError::Concurrency(_)) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        match written {
            // The last write was not read back yet: nothing says it was crossed.
            Some(entries) => Ok(entries),
            None => Err("other knocks crossed every write of the note; the next knock writes it".to_string()),
        }
    }
}

/// Versions of one note a read keeps at most.
const NOTE_VERSIONS_MAX: usize = 16;

/// What a read of a note found: the versions it saw, newest first, and
/// whether the read got to its end in the time it had.
pub(crate) struct NoteRead {
    items: Vec<MutableItem>,
    complete: bool,
}

/// The versions among `items` that `key` opens, as (version, entries).
pub(crate) fn opened_versions(key: &[u8; 32], items: &[MutableItem]) -> Vec<(i64, Vec<V6Entry>)> {
    items.iter().filter_map(|item| open_v6_note(key, item.value()).map(|entries| (item.seq(), entries))).collect()
}

/// Every entry of every version that stands at `now` ([`v6_entry_stands`]),
/// one per address, the one that stands longest. The holder opens toward all
/// of them: nodes may hold two versions side by side for a while (two
/// knockers wrote at once), and each names a knocker. Entries that do not
/// stand are passed over before two of one address are made one, so an
/// entry too far ahead (an old version from a clock that ran fast) cannot
/// stand in for one that is good.
pub(crate) fn note_entries(versions: &[(i64, Vec<V6Entry>)], now: u64) -> Vec<V6Entry> {
    let mut out: Vec<V6Entry> = Vec::new();
    for entry in versions.iter().flat_map(|(_, entries)| entries).filter(|entry| v6_entry_stands(entry, now)) {
        match out.iter_mut().find(|kept| kept.addr == entry.addr) {
            Some(kept) => kept.until = kept.until.max(entry.until),
            None => out.push(*entry),
        }
    }
    out
}

/// Is the note as a knocker wants to leave it: one newest version (two that
/// share a version number but differ are two knockers' writes that crossed),
/// holding all of `mine`?
pub(crate) fn note_settled(versions: &[(i64, Vec<V6Entry>)], mine: &[SocketAddrV6]) -> bool {
    let Some(top) = versions.iter().map(|(seq, _)| *seq).max() else { return false };
    let newest: Vec<&Vec<V6Entry>> = versions.iter().filter(|(seq, _)| *seq == top).map(|(_, entries)| entries).collect();
    newest.windows(2).all(|pair| pair[0] == pair[1]) && mine.iter().all(|addr| newest[0].iter().any(|entry| entry.addr == *addr))
}

/// The version number of a write after a read whose newest version was `cas`:
/// above it, and above the clock in microseconds with a random part below the
/// millisecond, so two knockers who write at once (both after the same read,
/// or both after none) all but never pick one number. Where they do, the
/// read after the write sees two versions under it ([`note_settled`]).
pub(crate) fn note_seq(cas: Option<i64>) -> i64 {
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as i64);
    let clock = millis.saturating_mul(1000).saturating_add(rand::Rng::gen_range(&mut rand::thread_rng(), 0..1000));
    cas.map_or(0, |seq| seq.saturating_add(1)).max(clock)
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
    addr: SocketAddr,
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
pub(crate) async fn opening_dial(endpoint: &IrohEndpoint, addr: impl Into<SocketAddr>) {
    let nobody = SecretKey::generate().public();
    let target = EndpointAddr::new(nobody).with_ip_addr(addr.into());
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
async fn noted_opening_dial(book: &Mutex<OpeningBook>, endpoint: &IrohEndpoint, addr: impl Into<SocketAddr>) {
    let addr: SocketAddr = addr.into();
    book.lock().unwrap().note_opening(addr.ip(), Instant::now());
    opening_dial(endpoint, addr).await;
    book.lock().unwrap().note_opening(addr.ip(), Instant::now());
}

/// The addresses a connection that still stands has a direct path to:
/// where its packets go now, whichever side dialed, and whatever the link
/// began on (one that began through a relay finds its direct path after).
/// An IPv4 address in IPv6 clothing is given as the IPv4 it is. Nothing for
/// a connection that has closed.
pub(crate) fn direct_paths_of(conn: &iroh::endpoint::Connection) -> Vec<SocketAddr> {
    if conn.close_reason().is_some() {
        return Vec::new();
    }
    let paths = conn.paths();
    let direct: Vec<SocketAddr> = paths
        .iter()
        .filter_map(|path| match path.remote_addr() {
            TransportAddr::Ip(SocketAddr::V4(v4)) => Some(SocketAddr::V4(*v4)),
            TransportAddr::Ip(SocketAddr::V6(v6)) => Some(match v6.ip().to_ipv4_mapped() {
                Some(ip) => SocketAddr::V4(SocketAddrV4::new(ip, v6.port())),
                None => SocketAddr::V6(*v6),
            }),
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
fn linked_addrs(hub: &SharedHub) -> HashSet<SocketAddr> {
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

/// The IPv6 notes one round reads: for each room, the note for this node of
/// each hour looked at now ([`poll_buckets`]), as the room, the note's public
/// key and its seal. Eight at most, as with the points.
pub(crate) fn round_notes(rooms: &[(String, [u8; 32])], me: &PublicKey, unix_secs: u64) -> Vec<(String, [u8; 32], [u8; 32])> {
    let hours = poll_buckets(unix_secs);
    rooms
        .iter()
        .flat_map(|(room_id, room_key)| {
            hours.iter().map(move |hour| {
                (room_id.clone(), v6_note_signer(room_key, me, *hour).verifying_key().to_bytes(), v6_note_key(room_key, me, *hour))
            })
        })
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
        let rooms = rooms_to_poll(&hub);
        let unix_secs = crate::chia_resolve::unix_now();
        let points = round_points(&rooms, &me, unix_secs);
        // The IPv6 notes are read only by a holder that has a public IPv6
        // address of its own: without one, no opening could leave toward them.
        let live: Vec<SocketAddr> = endpoint.addr().ip_addrs().copied().collect();
        let own6: HashSet<Ipv6Addr> = live
            .iter()
            .filter_map(|sock| match sock.ip() {
                IpAddr::V6(v6) => Some(v6),
                IpAddr::V4(_) => None,
            })
            .collect();
        let notes = if own6.iter().any(|ip| crate::ipv6_is_public(*ip)) { round_notes(&rooms, &me, unix_secs) } else { Vec::new() };
        // All of a round's lookups side by side, the notes beside the points:
        // one slow point holds no other room up, and the round is over within
        // LOOKUP_TIMEOUT, with whatever each lookup had found by then.
        let (looked, noted) = tokio::join!(
            n0_future::join_all(points.into_iter().map(|(room_id, point)| async move { (room_id, knock.lookup(point, LOOKUP_TIMEOUT).await) })),
            n0_future::join_all(
                notes.into_iter().map(|(room_id, public, key)| async move { (room_id, key, knock.read_note(&public, LOOKUP_TIMEOUT).await) })
            ),
        );
        if looked.iter().any(|(_, found)| found.is_none()) || noted.iter().any(|(_, _, found)| found.is_none()) {
            eprintln!("🚪 DHT knock: the DHT client stopped; no knock is seen or sent in this run");
            return;
        }
        let mut knocked: Vec<(String, SocketAddr)> = Vec::new();
        let own = own_ips(&endpoint, knock).await;
        for (room_id, found) in looked {
            for addr in found.unwrap_or_default() {
                if knock_admitted(addr, &own, crate::ipv4_is_public) {
                    knocked.push((room_id.clone(), SocketAddr::V4(addr)));
                }
            }
        }
        let now = crate::chia_resolve::unix_now();
        for (room_id, key, found) in noted {
            let Some(read) = found else { continue };
            let entries = note_entries(&opened_versions(&key, &read.items), now);
            for addr in v6_openings(&entries, now, &own6, crate::ipv6_is_public) {
                knocked.push((room_id.clone(), SocketAddr::V6(addr)));
            }
        }
        // Asked only in a round that found somebody.
        let linked = if knocked.is_empty() { HashSet::new() } else { linked_addrs(&hub) };
        for (room_id, addr) in knocked {
            if linked.contains(&addr) {
                continue;
            }
            let begun = Instant::now();
            if !knock.book.lock().unwrap().begin(addr, begun) {
                continue;
            }
            let how = if addr.is_ipv6() { " (its IPv6 note)" } else { "" };
            println!(
                "🚪 DHT knock: {addr} knocked for room {room_id}{how}; opening toward it every {} s for {} s",
                OPENING_PERIOD.as_secs(),
                OPENING_WINDOW.as_secs()
            );
            tokio::spawn(opening_hold(hub.clone(), endpoint.clone(), addr, begun));
        }
    }
}

/// One opening hold: an opening dial toward `addr` every [`OPENING_PERIOD`]
/// until a connection comes in from it, a link stands to it that was made
/// some other way, or [`OPENING_WINDOW`] has passed.
async fn opening_hold(hub: SharedHub, endpoint: IrohEndpoint, addr: SocketAddr, begun: Instant) {
    let Some(knock) = hub.dht_knock.as_ref() else { return };
    let mut landed = false;
    let mut linked = false;
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
        // Before the next opening dial: a link that stands to the address by
        // now, made by a dial of our own that landed while the knocker's ran,
        // needs no more opening either. The knocker's dial has stopped by
        // then (it found itself linked), so nothing will come in to say so,
        // and the hold would send, and keep its slot, to the window's end.
        if linked_addrs(&hub).contains(&addr) {
            knock.book.lock().unwrap().note_linked(&addr);
            linked = true;
            break;
        }
    }
    knock.book.lock().unwrap().end(&addr);
    if landed {
        println!("🚪 DHT knock: a connection came in from {addr} {} s after the opening began", begun.elapsed().as_secs());
    } else if linked {
        println!("🚪 DHT knock: a link stands to {addr} by a dial of our own, {} s after the opening began; the opening is over", begun.elapsed().as_secs());
    } else {
        println!("🚪 DHT knock: nothing came in from {addr} in {} s; the opening is over", OPENING_WINDOW.as_secs());
    }
}

/// A dial has no knock out (yet).
const KNOCK_NOT_OUT: u8 = 0;
/// A dial's knock is out, or on its way out, and is counted in
/// `KnockDht::knocks_out`.
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

/// Count a dial's knock as out, once per dial, and only while the dial still
/// runs: a guard dropped meanwhile leaves the count as it was.
fn count_knock_out(knocks_out: &AtomicUsize, state: &AtomicU8) {
    if state.load(Ordering::SeqCst) != KNOCK_NOT_OUT {
        return;
    }
    knocks_out.fetch_add(1, Ordering::SeqCst);
    if state.compare_exchange(KNOCK_NOT_OUT, KNOCK_OUT, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        knocks_out.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Take a dial's knock out of the count again: its announce failed, so
/// nothing of this dial's is out. A guard dropped meanwhile has taken it out
/// already, and the count moves once.
fn uncount_knock_out(knocks_out: &AtomicUsize, state: &AtomicU8) {
    if state.compare_exchange(KNOCK_OUT, KNOCK_NOT_OUT, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        knocks_out.fetch_sub(1, Ordering::SeqCst);
    }
}

/// How one announce of a knock ended.
#[derive(Debug, PartialEq)]
enum Announced {
    /// The DHT nodes nearest the point answered: the knock is stored.
    Stored,
    /// The announce was not over in time. It goes on in the DHT client, so
    /// the knock may be stored all the same.
    Unconfirmed,
    /// The announce failed: it stored nothing.
    Failed(String),
}

/// One announce of a dial's knock, waited for at most `within`, with the knock
/// counted as out from the moment the announce BEGINS. An announce is a walk
/// to the DHT nodes nearest the point and then a store at each, and it ends
/// only when the slowest of them has answered or timed out. The holder can
/// find the knock before that: between two home routers its opening dial came
/// in half a second before the announce was over (2026-11-14), and was logged
/// as a failed handshake because the knock was not counted yet. An announce
/// that fails takes the knock out of the count again, unless an earlier
/// announce of this dial (`out_before`) is out.
async fn announced<F>(knocks_out: &AtomicUsize, state: &AtomicU8, out_before: bool, within: Duration, announce: F) -> Announced
where
    F: std::future::Future<Output = Result<(), String>>,
{
    count_knock_out(knocks_out, state);
    match tokio::time::timeout(within, announce).await {
        Ok(Ok(())) => Announced::Stored,
        Ok(Err(e)) => {
            if !out_before {
                uncount_knock_out(knocks_out, state);
            }
            Announced::Failed(e)
        }
        Err(_) => Announced::Unconfirmed,
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
    // Whether an earlier announce of this dial is out (stored, or not known
    // not to be).
    let mut out_before = false;
    for round in 0..MAX_KNOCKS_PER_DIAL {
        if round > 0 {
            tokio::time::sleep(KNOCK_PERIOD).await;
        }
        let linked = hub.rooms.lock().unwrap().get(&room_id).map(|room| room.remote_peers.contains_key(&target));
        if !knock_wanted(linked) {
            return;
        }
        let bucket = bucket_of(crate::chia_resolve::unix_now());
        let point = knock_point(&room_key, &target, bucket);
        // Asked at each round: a port mapping may have come since the last.
        let live: Vec<SocketAddr> = endpoint.addr().ip_addrs().copied().collect();
        let port = knock_port(&live, &hub.reach.self_advertised.lock().unwrap(), bound, crate::ipv4_is_public);
        // And the IPv6 note beside the knock, on a computer with a public IPv6
        // address: the knock's peer list carries IPv4 only.
        let mine6 = own_public_v6(&live, crate::ipv6_is_public);
        let v6_note = async {
            if mine6.is_empty() {
                return None;
            }
            let began = Instant::now();
            let left = tokio::time::timeout(V6_NOTE_WAIT, knock.leave_v6_note(&room_key, &target, bucket, &mine6, LOOKUP_TIMEOUT)).await;
            Some((left, began.elapsed()))
        };
        let began = Instant::now();
        let announce = async {
            let how = announced(&knock.knocks_out, &state, out_before, ANNOUNCE_TIMEOUT, knock.announce(point, port)).await;
            (how, began.elapsed())
        };
        let ((how, took), v6) = tokio::join!(announce, v6_note);
        match v6 {
            None => {}
            Some((Ok(Ok(entries)), took)) => println!(
                "🚪 DHT knock: left a note for {shown}… with this computer's {} IPv6 address(es) ({:.1} s, {entries} in the note); it opens toward them too",
                mine6.len(),
                took.as_secs_f32()
            ),
            Some((Ok(Err(e)), _)) => eprintln!("🚪 DHT knock: the IPv6 note for {shown}… was not stored ({e}); the knock goes on without it"),
            Some((Err(_), _)) => eprintln!(
                "🚪 DHT knock: the IPv6 note for {shown}… was not confirmed in {} s; the DHT may hold it all the same",
                V6_NOTE_WAIT.as_secs()
            ),
        }
        match how {
            Announced::Stored => {
                out_before = true;
                println!(
                    "🚪 DHT knock: knocked on {shown}… through the DHT (port {port}, {:.1} s); it opens toward this computer when it sees the knock",
                    took.as_secs_f32()
                );
            }
            Announced::Unconfirmed => {
                out_before = true;
                eprintln!(
                    "🚪 DHT knock: the knock on {shown}… (port {port}) was not confirmed in {} s; the DHT may hold it all the same, and the dial goes on",
                    ANNOUNCE_TIMEOUT.as_secs()
                );
            }
            Announced::Failed(e) => eprintln!("🚪 DHT knock: the knock on {shown}… was not stored ({e}); the dial goes on without it"),
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

    /// GitHub's machine held the room and the owner's computer knocked
    /// (2026-11-16): the openings came in from the holder's IP on a port its
    /// router picked for this destination, never the one the knocker dialed.
    /// The knocker dials that address back.
    #[test]
    fn an_opening_from_the_ip_we_dial_is_dialed_back_on_its_own_port() {
        let now = Instant::now();
        let mut came = CameIn::default();
        let holder = v4(203, 0, 113, 7, 44452);
        let mapped = v4(203, 0, 113, 7, 61022);
        came.note(mapped, now);
        let ips: HashSet<Ipv4Addr> = [*holder.ip()].into();
        let known: HashSet<SocketAddr> = [SocketAddr::V4(holder)].into();
        assert_eq!(came.dial_back(&ips, &known, now + Duration::from_secs(5)), vec![mapped]);
        // Another holder behind the same public address opens from a port of
        // its own: both are dialed back, neither pushes the other out.
        let other = v4(203, 0, 113, 7, 61040);
        came.note(other, now + Duration::from_secs(15));
        assert_eq!(came.dial_back(&ips, &known, now + Duration::from_secs(16)), vec![mapped, other]);
    }

    #[test]
    fn the_book_of_openings_keeps_the_last_few_only() {
        let now = Instant::now();
        let mut came = CameIn::default();
        let count = CAME_IN_MAX as u16 + 4;
        for i in 0..count {
            came.note(v4(203, 0, 113, 7, 40000 + i), now + Duration::from_millis(u64::from(i)));
        }
        let ips: HashSet<Ipv4Addr> = [Ipv4Addr::new(203, 0, 113, 7)].into();
        let back = came.dial_back(&ips, &HashSet::new(), now + Duration::from_secs(1));
        assert_eq!(back.len(), CAME_IN_MAX);
        // The oldest went first.
        assert_eq!(back.first().map(|a| a.port()), Some(40000 + 4));
        assert_eq!(back.last().map(|a| a.port()), Some(40000 + count - 1));
    }

    #[test]
    fn an_opening_is_not_followed_elsewhere_twice_or_too_late() {
        let now = Instant::now();
        let mut came = CameIn::default();
        let holder = v4(203, 0, 113, 7, 44452);
        came.note(v4(198, 51, 100, 9, 50000), now);
        let ips: HashSet<Ipv4Addr> = [*holder.ip()].into();
        let mut known: HashSet<SocketAddr> = [SocketAddr::V4(holder)].into();
        // From an IP the dial does not name: not followed.
        assert!(came.dial_back(&ips, &known, now).is_empty());
        // The very address the dial holds already: nothing to add.
        came.note(holder, now);
        assert!(came.dial_back(&ips, &known, now).is_empty());
        // Heard too long ago: dropped.
        let mapped = v4(203, 0, 113, 7, 61022);
        came.note(mapped, now);
        known.remove(&SocketAddr::V4(holder));
        assert!(came.dial_back(&ips, &known, now + DIAL_BACK_FOR).is_empty());
    }

    #[tokio::test]
    async fn the_knocker_dials_back_only_ipv4_hints_of_its_own_dial() {
        let mut builder = DhtBuilder::default();
        builder.no_bootstrap();
        let knock = KnockDht::start(&builder).expect("a DHT client that joins nothing");
        knock.note_opening_from(sock(203, 0, 113, 7, 61022));
        knock.note_opening_from(sock6(61023));
        assert_eq!(knock.dial_back(&[sock(203, 0, 113, 7, 44452), sock6(44452)]), vec![v4(203, 0, 113, 7, 61022)]);
        assert!(knock.dial_back(&[sock(198, 51, 100, 9, 44452)]).is_empty());
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

    /// The holder can find a knock, and its opening dial can come in, before
    /// the announce is over (seen between two home routers, 2026-11-14). The
    /// knock is counted as out for as long as the announce runs, not only
    /// after it.
    #[tokio::test]
    async fn a_knock_counts_as_out_while_its_announce_is_still_under_way() {
        let count = AtomicUsize::new(0);
        let state = AtomicU8::new(KNOCK_NOT_OUT);
        let (answer, answered) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let announce = announced(&count, &state, false, Duration::from_secs(30), async { answered.await.expect("an answer") });
        tokio::pin!(announce);
        // The DHT has not answered yet.
        assert!(tokio::time::timeout(Duration::from_millis(100), &mut announce).await.is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1, "counted while the announce runs");
        assert_eq!(state.load(Ordering::SeqCst), KNOCK_OUT);
        answer.send(Ok(())).expect("the announce still waits");
        assert_eq!(announce.await, Announced::Stored);
        assert_eq!(count.load(Ordering::SeqCst), 1, "and once, not again when it is stored");
    }

    #[tokio::test]
    async fn an_announce_that_fails_takes_its_knock_out_of_the_count_unless_an_earlier_one_is_out() {
        // A first announce that fails: nothing of this dial's is out.
        let count = AtomicUsize::new(0);
        let state = AtomicU8::new(KNOCK_NOT_OUT);
        let failed = announced(&count, &state, false, Duration::from_secs(30), async { Err("no node answered".to_string()) }).await;
        assert_eq!(failed, Announced::Failed("no node answered".to_string()));
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(state.load(Ordering::SeqCst), KNOCK_NOT_OUT);
        // The next round's announce is stored: counted then.
        assert_eq!(announced(&count, &state, false, Duration::from_secs(30), async { Ok(()) }).await, Announced::Stored);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        // A later round that fails leaves the stored one counted.
        assert!(matches!(announced(&count, &state, true, Duration::from_secs(30), async { Err("x".to_string()) }).await, Announced::Failed(_)));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(state.load(Ordering::SeqCst), KNOCK_OUT);
        // A dial that ended while its first announce ran: its guard took the
        // knock out of the count, and the failure does not take it out twice.
        let other = AtomicUsize::new(1);
        let ended = AtomicU8::new(KNOCK_ENDED);
        uncount_knock_out(&other, &ended);
        assert_eq!(other.load(Ordering::SeqCst), 1);
        assert_eq!(ended.load(Ordering::SeqCst), KNOCK_ENDED);
    }

    /// An announce that outlasts the wait goes on in the DHT client, so the
    /// knock may be stored: it stays counted.
    #[tokio::test]
    async fn an_announce_that_outlasts_the_wait_stays_counted() {
        let count = AtomicUsize::new(0);
        let state = AtomicU8::new(KNOCK_NOT_OUT);
        let slow = announced(&count, &state, false, Duration::from_millis(50), std::future::pending::<Result<(), String>>()).await;
        assert_eq!(slow, Announced::Unconfirmed);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(state.load(Ordering::SeqCst), KNOCK_OUT);
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
    fn a_hold_ended_by_a_link_made_another_way_asks_for_no_rest_but_counts() {
        let mut book = OpeningBook::default();
        let t0 = Instant::now();
        let a = v4(203, 0, 113, 9, 44442);
        assert!(book.begin(a, t0));
        // No connection came in from the address: a dial of our own reached
        // it, and the hold ended on seeing the link.
        assert!(!book.landed_since(&a, t0));
        book.note_linked(&a);
        book.end(&a);
        // Listed still a minute on, and the link was lost (the caller looks
        // at the links before it asks the book): no rest, as after a landing.
        let second = t0 + Duration::from_secs(60);
        assert!(book.begin(a, second));
        book.end(&a);
        // That one got nothing: the rest holds, and all of them count.
        assert!(!book.begin(a, second + POLL_PERIOD));
        assert!(book.begin(a, second + OPENING_REST));
        book.end(&a);
        assert!(!book.begin(a, second + OPENING_REST * 2), "three in the hour");
        // The note makes up no hold toward an address none was begun for.
        let b = v4(203, 0, 113, 10, 44442);
        book.note_linked(&b);
        assert!(book.begin(b, t0));
        book.end(&b);
        assert!(!book.begin(b, t0 + POLL_PERIOD), "its first hold got nothing, and rests");
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
                if direct_paths_of(conn).contains(&SocketAddr::V4(to)) {
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
        assert!(!direct_paths_of(&out).contains(&SocketAddr::V4(dialer_addr)));
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

    /// A public IPv6 address (the range main.rs's own filter tests use).
    fn pub6(last: u16, port: u16) -> SocketAddrV6 {
        SocketAddrV6::new(Ipv6Addr::new(0x2600, 0x1700, 0, 0, 0, 0, 0, last), port, 0, 0)
    }

    #[test]
    fn an_ipv6_note_opens_with_its_own_key_only_and_holds_what_was_sealed() {
        let seal = v6_note_key(&[7u8; 32], &key(1), 500_000);
        let entries = vec![V6Entry { addr: pub6(1, 44442), until: 1_800_000_000 }, V6Entry { addr: pub6(2, 44452), until: 1_800_000_060 }];
        let sealed = seal_v6_note(&seal, &entries);
        assert_eq!(open_v6_note(&seal, &sealed), Some(entries.clone()));
        // Sealed afresh each time: the DHT's nodes cannot tell two notes alike.
        assert_ne!(seal_v6_note(&seal, &entries), sealed);
        // Another room's, another holder's or another hour's key opens nothing.
        assert_eq!(open_v6_note(&v6_note_key(&[8u8; 32], &key(1), 500_000), &sealed), None);
        assert_eq!(open_v6_note(&v6_note_key(&[7u8; 32], &key(2), 500_000), &sealed), None);
        assert_eq!(open_v6_note(&v6_note_key(&[7u8; 32], &key(1), 500_001), &sealed), None);
        // A byte changed anywhere, or a note cut short, opens nothing.
        for at in [0, 23, 24, sealed.len() - 1] {
            let mut bent = sealed.clone();
            bent[at] ^= 1;
            assert_eq!(open_v6_note(&seal, &bent), None, "byte {at}");
        }
        assert_eq!(open_v6_note(&seal, &sealed[..20]), None);
        // An empty note is a note.
        assert_eq!(open_v6_note(&seal, &seal_v6_note(&seal, &[])), Some(Vec::new()));
        // More than a note holds is cut to the newest it may hold when sealed.
        let many: Vec<V6Entry> = (0..12).map(|i| V6Entry { addr: pub6(i, 44442), until: 1_800_000_000 + u64::from(i) }).collect();
        assert_eq!(open_v6_note(&seal, &seal_v6_note(&seal, &many)).map(|got| got.len()), Some(V6_NOTE_MAX));
    }

    #[test]
    fn a_notes_key_is_the_rooms_the_holders_and_the_hours() {
        let room = [7u8; 32];
        let public = |room: &[u8; 32], holder: u8, hour: u64| v6_note_signer(room, &key(holder), hour).verifying_key().to_bytes();
        // Worked out alike by every knocker and by the holder.
        assert_eq!(public(&room, 1, 500_000), public(&room, 1, 500_000));
        // And by nobody without all three.
        assert_ne!(public(&room, 1, 500_000), public(&[8u8; 32], 1, 500_000));
        assert_ne!(public(&room, 1, 500_000), public(&room, 2, 500_000));
        assert_ne!(public(&room, 1, 500_000), public(&room, 1, 500_001));
        // The seal's key is not the signer's.
        assert_ne!(v6_note_key(&room, &key(1), 500_000), v6_note_signer(&room, &key(1), 500_000).to_bytes());
        // A round reads a note wherever it looks up a point: per room, per hour.
        let rooms: Vec<(String, [u8; 32])> = vec![("a".to_string(), room), ("b".to_string(), [8u8; 32])];
        let near_boundary = 500_000 * BUCKET_SECS + 30;
        let notes = round_notes(&rooms, &key(1), near_boundary);
        assert_eq!(notes.len(), round_points(&rooms, &key(1), near_boundary).len());
        assert_eq!(notes.len(), 4);
        assert!(notes.contains(&("a".to_string(), public(&room, 1, 500_000), v6_note_key(&room, &key(1), 500_000))));
        assert!(notes.contains(&("b".to_string(), public(&[8u8; 32], 1, 499_999), v6_note_key(&[8u8; 32], &key(1), 499_999))));
    }

    #[test]
    fn a_knocker_keeps_the_others_entries_and_writes_its_own_afresh() {
        let now = 1_800_000_000;
        let life = V6_NOTE_LIFE.as_secs();
        let other = V6Entry { addr: pub6(9, 44442), until: now + 100 };
        let gone = V6Entry { addr: pub6(8, 44442), until: now };
        let far = V6Entry { addr: pub6(7, 44442), until: now + 2 * life + 1 };
        // Our own from the last knock, at a port the game has since moved off.
        let stale_own = V6Entry { addr: pub6(1, 40000), until: now + 50 };
        let mine = [pub6(1, 44452), pub6(2, 44452)];
        // Our own from the last knock, at the port we are on still.
        let renewed = V6Entry { addr: pub6(2, 44452), until: now + 30 };
        let note = merge_v6_note(&[other, gone, far, stale_own, renewed], &mine, now);
        // The port we left is not ours to drop (it may be another game's on
        // this computer); it runs out by itself.
        assert_eq!(
            note,
            vec![stale_own, other, V6Entry { addr: pub6(1, 44452), until: now + life }, V6Entry { addr: pub6(2, 44452), until: now + life }]
        );
        // Two games on one computer, one address, two ports: each keeps the
        // other's entry.
        let first_game = merge_v6_note(&[], &[pub6(1, 44442)], now);
        let both = merge_v6_note(&first_game, &[pub6(1, 44452)], now + 1);
        assert_eq!(both.iter().map(|entry| entry.addr).collect::<Vec<_>>(), vec![pub6(1, 44442), pub6(1, 44452)]);
        let again = merge_v6_note(&both, &[pub6(1, 44442)], now + 120);
        assert_eq!(again.iter().map(|entry| entry.addr).collect::<Vec<_>>(), vec![pub6(1, 44452), pub6(1, 44442)]);
        // A full note keeps the newest: ours, and the others' that stand longest.
        let full: Vec<V6Entry> = (10..18).map(|i| V6Entry { addr: pub6(i, 44442), until: now + u64::from(i) }).collect();
        let note = merge_v6_note(&full, &mine, now);
        assert_eq!(note.len(), V6_NOTE_MAX);
        assert!(note.iter().any(|entry| entry.addr == mine[0]) && note.iter().any(|entry| entry.addr == mine[1]));
        assert!(!note.iter().any(|entry| entry.addr == pub6(10, 44442) || entry.addr == pub6(11, 44442)), "the two oldest made room");
    }

    #[test]
    fn the_holder_opens_toward_a_notes_public_addresses_that_still_stand_and_are_not_its_own() {
        let now = 1_800_000_000;
        let own_addr = pub6(5, 44442);
        let own: HashSet<Ipv6Addr> = HashSet::from([*own_addr.ip()]);
        let standing = |addr: SocketAddrV6| V6Entry { addr, until: now + 60 };
        let entries = vec![
            standing(pub6(1, 44442)),
            standing(pub6(1, 44442)),                                                          // twice: once
            standing(pub6(2, 80)),                                                             // a port the game cannot bind
            standing(SocketAddrV6::new(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1), 44442, 0, 0)), // link-local
            standing(SocketAddrV6::new(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1), 44442, 0, 0)), // unique-local
            standing(SocketAddrV6::new(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1), 44442, 0, 0)), // documentation
            standing(own_addr),                                                                // ours
            standing(SocketAddrV6::new(Ipv4Addr::new(8, 8, 8, 8).to_ipv6_mapped(), 44442, 0, 0)), // an IPv4 address
            standing(SocketAddrV6::new(Ipv4Addr::new(8, 8, 4, 4).to_ipv6_compatible(), 44442, 0, 0)), // and again
            V6Entry { addr: pub6(3, 44442), until: now },                                      // its time is up
            V6Entry { addr: pub6(4, 44442), until: now + 2 * V6_NOTE_LIFE.as_secs() + 1 },     // claims too long
            standing(pub6(6, 44452)),
        ];
        assert_eq!(v6_openings(&entries, now, &own, crate::ipv6_is_public), vec![pub6(1, 44442), pub6(6, 44452)]);
    }

    #[test]
    fn a_note_carries_this_computers_public_ipv6_addresses_three_at_most() {
        let live = vec![
            sock(203, 0, 113, 9, 44442),
            SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1), 44442, 0, 3)),
            SocketAddr::V6(SocketAddrV6::new(*pub6(1, 0).ip(), 44442, 0, 2)),
            SocketAddr::V6(pub6(1, 44442)), // the same address again
            SocketAddr::V6(pub6(2, 44442)),
            sock6(44442), // documentation range: not public
            SocketAddr::V6(SocketAddrV6::new(Ipv4Addr::new(8, 8, 8, 8).to_ipv6_mapped(), 44442, 0, 0)), // IPv4 in IPv6 clothing
        ];
        // Scope and flow are not carried: they mean nothing on another computer.
        assert_eq!(own_public_v6(&live, crate::ipv6_is_public), vec![pub6(1, 44442), pub6(2, 44442)]);
        let many: Vec<SocketAddr> = (1..=5).map(|i| SocketAddr::V6(pub6(i, 44442))).collect();
        assert_eq!(own_public_v6(&many, crate::ipv6_is_public).len(), V6_PER_KNOCKER);
        assert!(own_public_v6(&[sock(203, 0, 113, 9, 44442)], crate::ipv6_is_public).is_empty(), "no IPv6: no note");
    }

    #[test]
    fn the_book_keeps_ipv6_holds_and_openings_apart_from_ipv4_ones() {
        let mut book = OpeningBook::default();
        let t0 = Instant::now();
        let a = SocketAddr::V6(pub6(1, 44442));
        assert!(book.begin(a, t0));
        assert!(!book.begin(a, t0), "one hold at a time, as for IPv4");
        assert!(book.begin(v4(203, 0, 113, 9, 44442), t0), "an IPv4 knock of the same computer is held apart");
        book.note_opening(a.ip(), t0);
        assert!(book.opened_lately(a.ip(), t0 + Duration::from_secs(1)));
        assert!(!book.opened_lately(IpAddr::V6(*pub6(2, 0).ip()), t0));
        book.note_landed(a, t0 + Duration::from_secs(5));
        assert!(book.landed_since(&a, t0));
        book.end(&a);
        book.note_live(a);
        assert!(!book.begin(a, t0 + OPENING_REST * 2), "no hold toward an address a connection stands from");
        book.end_live(&a);
        assert!(book.begin(a, t0 + Duration::from_secs(60)), "it got its connection: no rest");
    }

    /// Two knockers leave their addresses in one note on a DHT of this
    /// process's own; the holder reads both, and another hour's note is none.
    #[tokio::test]
    async fn two_knockers_notes_are_read_by_the_holder_both_of_them() {
        let testnet = n0_mainline::Testnet::new(8).await.expect("a DHT of our own");
        let client = || {
            let mut builder = DhtBuilder::default();
            builder.bootstrap(&testnet.bootstrap);
            KnockDht::start(&builder).expect("a DHT client")
        };
        let first = client();
        let second = client();
        let holder = client();
        for dht in [&first, &second, &holder] {
            assert_eq!(dht.dht.bootstrapped().await, Ok(true));
        }
        let room = [7u8; 32];
        let me = key(1);
        let hour = bucket_of(crate::chia_resolve::unix_now());
        let public = v6_note_signer(&room, &me, hour).verifying_key().to_bytes();
        let seal = v6_note_key(&room, &me, hour);
        assert!(nothing_at(&holder, &public).await, "nothing left yet");

        assert_eq!(first.leave_v6_note(&room, &me, hour, &[pub6(1, 44442)], LOOKUP_TIMEOUT).await, Ok(1));
        assert_eq!(second.leave_v6_note(&room, &me, hour, &[pub6(2, 44452), pub6(3, 44452)], LOOKUP_TIMEOUT).await, Ok(3));
        let read = holder.read_note(&public, LOOKUP_TIMEOUT).await.expect("a lookup");
        let now = crate::chia_resolve::unix_now();
        let entries = note_entries(&opened_versions(&seal, &read.items), now);
        let mut opened = v6_openings(&entries, now, &HashSet::new(), crate::ipv6_is_public);
        opened.sort();
        assert_eq!(opened, vec![pub6(1, 44442), pub6(2, 44452), pub6(3, 44452)]);
        // The first knocks again: still three, its own written afresh.
        assert_eq!(first.leave_v6_note(&room, &me, hour, &[pub6(1, 44442)], LOOKUP_TIMEOUT).await, Ok(3));
        // Another hour's note, or another holder's, is somewhere else.
        let elsewhere = v6_note_signer(&room, &me, hour + 1).verifying_key().to_bytes();
        assert!(nothing_at(&holder, &elsewhere).await);
        let other_holder = v6_note_signer(&room, &key(2), hour).verifying_key().to_bytes();
        assert!(nothing_at(&holder, &other_holder).await);
    }

    /// A read that got to its end and found no note.
    async fn nothing_at(dht: &KnockDht, public: &[u8; 32]) -> bool {
        let read = dht.read_note(public, LOOKUP_TIMEOUT).await.expect("a lookup");
        read.complete && read.items.is_empty()
    }

    /// The addresses of every version of the note a read sees, sorted.
    async fn noted_addrs(dht: &KnockDht, public: &[u8; 32], seal: &[u8; 32]) -> Vec<SocketAddrV6> {
        let read = dht.read_note(public, LOOKUP_TIMEOUT).await.expect("a lookup");
        let now = crate::chia_resolve::unix_now();
        let mut addrs: Vec<SocketAddrV6> = note_entries(&opened_versions(seal, &read.items), now).iter().map(|entry| entry.addr).collect();
        addrs.sort();
        addrs
    }

    #[test]
    fn a_note_is_settled_only_with_one_newest_version_that_holds_ours() {
        let (a, b) = (pub6(1, 44442), pub6(2, 44452));
        let at = |addr: SocketAddrV6, until: u64| V6Entry { addr, until };
        // Two versions under one number: two writes crossed. Not settled for
        // either writer, and the holder opens toward both.
        let crossed = vec![(5, vec![at(a, 100)]), (5, vec![at(b, 100)])];
        assert!(!note_settled(&crossed, &[a]) && !note_settled(&crossed, &[b]));
        assert_eq!(note_entries(&crossed, 50), vec![at(a, 100), at(b, 100)]);
        // One newest version with ours in it: settled, whatever older ones say.
        let merged = vec![(6, vec![at(b, 100), at(a, 200)]), (5, vec![at(a, 100)])];
        assert!(note_settled(&merged, &[a]) && note_settled(&merged, &[b]));
        // One address in two versions is one entry, the one that stands longest.
        assert_eq!(note_entries(&merged, 50), vec![at(b, 100), at(a, 200)]);
        // But only among those that stand: one too far ahead (an old version
        // from a fast clock) is passed over, not kept in place of a good one,
        // and one whose time is up is gone.
        let now = 1_000_000;
        let ahead = vec![(9, vec![at(a, now + 600)]), (8, vec![at(a, now + 1800), at(b, now - 1)])];
        assert_eq!(note_entries(&ahead, now), vec![at(a, now + 600)]);
        assert_eq!(v6_openings(&note_entries(&ahead, now), now, &HashSet::new(), |_| true), vec![a]);
        // Ours dropped by a newer write: not settled.
        assert!(!note_settled(&[(7, vec![at(b, 100)]), (6, vec![at(a, 100), at(b, 100)])], &[a]));
        // No version at all: nothing is settled.
        assert!(!note_settled(&[], &[a]));
        // A version number is above the one read, and above the clock.
        assert_eq!(note_seq(Some(i64::MAX - 1)), i64::MAX);
        let micros = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros() as i64;
        assert!(note_seq(None) >= micros - 1_000_000 && note_seq(Some(5)) > 5);
    }

    /// Two knockers who both read the note before either wrote: the later
    /// write drops the earlier's entries, and the earlier's read after its
    /// write sees that and writes them back. A read that did not finish and
    /// found nothing writes nothing.
    #[tokio::test]
    async fn knockers_writing_at_once_both_end_in_the_note_and_an_unfinished_read_writes_nothing() {
        let testnet = n0_mainline::Testnet::new(8).await.expect("a DHT of our own");
        let client = || {
            let mut builder = DhtBuilder::default();
            builder.bootstrap(&testnet.bootstrap);
            KnockDht::start(&builder).expect("a DHT client")
        };
        let first = client();
        let second = client();
        let holder = client();
        for dht in [&first, &second, &holder] {
            assert_eq!(dht.dht.bootstrapped().await, Ok(true));
        }
        let room = [9u8; 32];
        let me = key(3);
        let hour = bucket_of(crate::chia_resolve::unix_now());
        let public = v6_note_signer(&room, &me, hour).verifying_key().to_bytes();
        let seal = v6_note_key(&room, &me, hour);

        // A read that cannot finish in its time writes nothing. Its only node
        // never answers, and the DHT client waits 500 ms at least for an
        // answer, so a read given 100 ms always ends unfinished. (A read
        // given no time at all is no such test: on a busy computer the
        // lookup can end before it is first looked at.)
        let silent = std::net::UdpSocket::bind("127.0.0.1:0").expect("a socket that never answers");
        let mut builder = DhtBuilder::default();
        builder.bootstrap(&[silent.local_addr().expect("its address").to_string()]);
        let unheard = KnockDht::start(&builder).expect("a DHT client");
        let unfinished = unheard.leave_v6_note(&room, &me, hour, &[pub6(1, 44442)], Duration::from_millis(100)).await;
        assert!(unfinished.as_ref().is_err_and(|why| why.starts_with("the note could not be read")), "{unfinished:?}");
        assert!(nothing_at(&holder, &public).await, "nothing was written");

        // Both at once.
        let (one, two) = ([pub6(1, 44442)], [pub6(2, 44452)]);
        let (a, b) = tokio::join!(
            first.leave_v6_note(&room, &me, hour, &one, LOOKUP_TIMEOUT),
            second.leave_v6_note(&room, &me, hour, &two, LOOKUP_TIMEOUT)
        );
        assert!(a.is_ok() && b.is_ok(), "{a:?} {b:?}");
        assert_eq!(noted_addrs(&holder, &public, &seal).await, vec![pub6(1, 44442), pub6(2, 44452)]);
    }

    /// Two writes under ONE version number, forced: the second knocker's
    /// write replaces the first's at the DHT's nodes (a node takes an equal
    /// number). The first knocker's next leave reads its entries gone, merges
    /// them back, and the holder sees both.
    #[tokio::test]
    async fn a_write_under_the_same_version_number_is_mended_by_the_knocker_it_dropped() {
        let testnet = n0_mainline::Testnet::new(8).await.expect("a DHT of our own");
        let client = || {
            let mut builder = DhtBuilder::default();
            builder.bootstrap(&testnet.bootstrap);
            KnockDht::start(&builder).expect("a DHT client")
        };
        let first = client();
        let second = client();
        let holder = client();
        for dht in [&first, &second, &holder] {
            assert_eq!(dht.dht.bootstrapped().await, Ok(true));
        }
        let room = [10u8; 32];
        let me = key(4);
        let hour = bucket_of(crate::chia_resolve::unix_now());
        let signer = v6_note_signer(&room, &me, hour);
        let public = signer.verifying_key().to_bytes();
        let seal = v6_note_key(&room, &me, hour);
        let until = crate::chia_resolve::unix_now() + V6_NOTE_LIFE.as_secs();
        let (a, b) = (pub6(1, 44442), pub6(2, 44452));
        let seq = note_seq(None);
        let written = |addr: SocketAddrV6| MutableItem::new(&signer, &seal_v6_note(&seal, &[V6Entry { addr, until }]), seq, None);
        first.dht.put_mutable(written(a), None).await.expect("the first write");
        second.dht.put_mutable(written(b), None).await.expect("the second, under the same number");
        assert_eq!(noted_addrs(&holder, &public, &seal).await, vec![b], "the first knocker's entry went");

        assert!(first.leave_v6_note(&room, &me, hour, &[a], LOOKUP_TIMEOUT).await.is_ok());
        assert_eq!(noted_addrs(&holder, &public, &seal).await, vec![a, b]);
        // And the second, knocking again, finds the note settled as it is.
        assert_eq!(second.leave_v6_note(&room, &me, hour, &[b], LOOKUP_TIMEOUT).await, Ok(2));
    }

    #[test]
    fn a_knock_is_sent_only_for_an_open_room_and_a_target_not_linked_in_it() {
        assert!(knock_wanted(Some(false)));
        assert!(!knock_wanted(Some(true)), "linked meanwhile, by this dial's own attempt or by another path");
        assert!(!knock_wanted(None), "the room is no longer open here");
    }
}
