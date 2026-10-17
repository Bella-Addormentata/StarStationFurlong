//! Per-room chain capabilities the LOCAL browser hands the node over the `cap`
//! lane (ChiaHub Slice 3, re-homed here by #231 N8 + D3).
//!
//! The browser sends `{ roomKeyB64, chiaMode, publicRoom }` once per session and
//! again whenever a flag changes. The node needs the room key to derive the
//! room's lookup hint (reads) and to seal presence records (publish). Loopback
//! only and trust-safe: the node already holds the room's plaintext Yjs doc, so
//! the key exposes nothing new.
//!
//! N8 (#231, 2026-10-11): `public_room` marks a room whose key ships inside every
//! build (the welcome room pass in `src/defaultStation.ts`) or whose passage
//! policy is PUBLIC. Nothing is ever PUBLISHED under such a key — anyone can
//! derive its hint, so an address record there is an address on a public
//! ledger — and nothing is READ under it either (D6: public rooms are public
//! space; their hosts are reached by pass hints, beacons and the DHT). The
//! browser stamps the flag, and the node ALSO recognises the bundled key itself
//! so an older browser build cannot talk a node into publishing under it.
//!
//! D3 (#231): reads are on by default, so ingest no longer waits for
//! `SSF_CHIA_LANE=1`; that switch now gates publishing only.
//!
//! KNOWN LIMIT — the private→public flip. This guard looks at a room's posture
//! NOW. Records a member published while the room was private stay on chain
//! forever, sealed under the room key; if the room's passage is later made
//! public, the station atlas starts sharing the room's bootstrap seed (room key
//! included) with anyone who walks in, and that key opens every record ever
//! sealed under it. The flip stops further publishing at once, but it cannot
//! take back what is already written. Rotating the room key on the flip is not
//! this guard's to do: every pass and seed for the room carries that key, so a
//! rotation re-keys the room for all its members — a room-model change, not a
//! node-side check. The fix of record is #231 P6: presence moves off room keys
//! to a per-node contact key that never travels in a room seed, so nothing on
//! chain is keyed by a room. Until P6 lands, publishing stays a per-room opt-in
//! (the `chiaMode` toggle), so the exposure is limited to rooms a member armed
//! by hand and later opened up.
#![cfg(feature = "chia-read")]

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;

/// Room keys that ship inside every build, base64url-no-pad exactly as the
/// browser emits them. Today: the welcome room's key from the `WELCOME_ROOM_LINK`
/// pass in `src/defaultStation.ts`. Update this list when that constant changes;
/// `src/defaultStation.test.ts` cross-checks the two.
pub const BUNDLED_ROOM_KEYS_B64: &[&str] = &["9cFoJclYIhraidhP4jdVH8G9uY2kcVCp8edFcPURP58"];

/// Per-room chain capability from the local browser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChiaRoomCap {
    pub room_key: [u8; 32],
    /// The per-room "publish my presence here" toggle (the arming switch; P3/D4
    /// give it its default). Publishing only — reads never consult it.
    pub chia_mode: bool,
    /// #231 P6b: the per-room "share my card in this room" toggle (default
    /// on). Off, this node hands no card to the room's members, files none of
    /// theirs, and reads no inbox for the room — a room one would rather not
    /// be findable from. Publishing and reads are not its business.
    pub share_card: bool,
    /// N8 posture. `Some(true)`: bundled-seed or PUBLIC-passage room — never
    /// published under, never read under. `Some(false)`: the browser resolved
    /// the door policy and the room is private. `None`: the browser never said
    /// (a build from before N8 sends no flag). Silence FAILS CLOSED for
    /// publishing — the unsafe direction is writing an address under a key that
    /// turns out to be public — and counts as unknown for reading, which is
    /// free and harmless either way. Set by the browser OR forced to
    /// `Some(true)` by the bundled-key check below.
    pub public_room: Option<bool>,
    /// The browser's per-session cap sequence number (0 from a browser that
    /// predates it). Every cap rides its own stream and streams may land out
    /// of order, so [`ingest_room_cap`] drops a cap older than the one it
    /// holds: a stale PRIVATE can never overwrite a fresh PUBLIC.
    pub seq: u64,
    /// Loaded from `rooms/<id>.cap` at startup rather than sent by a browser in
    /// THIS process. Its posture is the last one known before the node went
    /// down and the room may have gone public since, so a restored cap only
    /// authorizes reads (free and harmless); publishing under the room key and
    /// handing out the contact card wait for a live cap.
    pub restored: bool,
}

impl ChiaRoomCap {
    /// Same key and flags — what "changed" means for logging; `seq` is not posture.
    pub fn same_posture(&self, other: &ChiaRoomCap) -> bool {
        self.room_key == other.room_key
            && self.chia_mode == other.chia_mode
            && self.public_room == other.public_room
            && self.share_card == other.share_card
    }

    /// May the publisher write a presence record under this room's key?
    /// Armed AND KNOWN private, by a cap from this process — the N8 guard in
    /// one place. An absent flag is not "private": an older browser cannot
    /// vouch for the room's posture; neither can a cap restored from disk.
    pub fn may_publish(&self) -> bool {
        self.chia_mode && self.public_room == Some(false) && !self.restored
    }

    /// Should the reader (rung-6 resolve, P1 watcher) read this room's hint?
    /// Everything not KNOWN to be public space — reads are free and need no
    /// arming (D3); public rooms carry nothing under their hint by
    /// construction (D6), so skipping them only saves chain calls.
    pub fn may_read(&self) -> bool {
        self.public_room != Some(true)
    }

    /// True when the browser never sent the N8 flag (pre-N8 build).
    pub fn posture_unknown(&self) -> bool {
        self.public_room.is_none()
    }
}

/// Wire shape of a `cap` envelope's JSON payload (browser camelCase).
#[derive(Deserialize)]
struct RoomCapPayload {
    #[serde(rename = "roomKeyB64")]
    room_key_b64: String,
    #[serde(rename = "chiaMode", default)]
    chia_mode: bool,
    /// Absent in caps from browsers that predate N8 — see [`ChiaRoomCap::public_room`].
    #[serde(rename = "publicRoom", default)]
    public_room: Option<bool>,
    /// Absent (0) from browsers that predate the sequence number.
    #[serde(default)]
    seq: u64,
    /// #231 P6b: absent (on) from browsers that predate the toggle.
    #[serde(rename = "shareCard", default = "default_true")]
    share_card: bool,
    /// #231 P6b: the node-signed contact cards the room's pass carries for its
    /// members, so the node can find them by key before it ever meets them.
    /// Verified and filed by [`file_member_cards`], never trusted as sent.
    #[serde(rename = "memberCards", default)]
    member_cards: Vec<crate::chia_contact::ContactCard>,
}

fn default_true() -> bool {
    true
}

/// May a `cap` from a browser session at `source` be trusted? Only loopback:
/// the node's WebTransport listener is open to remote browsers too, and a room
/// key is the LOCAL browser's to hand over, nobody else's. IPv4 loopback, IPv6
/// loopback and the IPv4-mapped form all count.
pub fn cap_source_is_local(source: &std::net::SocketAddr) -> bool {
    match source.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    }
}

/// Decode a 32-byte room key from whatever base64 flavor the browser emits
/// (`getOrCreateRoomKeyB64` uses base64url-no-pad; be tolerant of all four).
pub fn decode_room_key(s: &str) -> Option<[u8; 32]> {
    use base64::Engine;
    let trimmed = s.trim();
    for eng in [
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::STANDARD_NO_PAD,
    ] {
        if let Ok(bytes) = eng.decode(trimmed) {
            if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Some(arr);
            }
        }
    }
    None
}

/// N8: is this one of the room keys that ships inside every build?
pub fn is_bundled_room_key(room_key: &[u8; 32]) -> bool {
    BUNDLED_ROOM_KEYS_B64
        .iter()
        .filter_map(|b64| decode_room_key(b64))
        .any(|k| &k == room_key)
}

/// Pure parse of a `cap` payload — the testable core of [`ingest_room_cap`].
/// `None` on bad JSON or a key that isn't 32 bytes of (any-flavor) base64. A
/// bundled key forces `public_room` to `Some(true)` whatever the browser said
/// (or did not say).
pub fn parse_room_cap(payload: &[u8]) -> Option<ChiaRoomCap> {
    let parsed: RoomCapPayload = serde_json::from_slice(payload).ok()?;
    let room_key = decode_room_key(&parsed.room_key_b64)?;
    let public_room = if is_bundled_room_key(&room_key) { Some(true) } else { parsed.public_room };
    Some(ChiaRoomCap {
        room_key,
        chia_mode: parsed.chia_mode,
        share_card: parsed.share_card,
        public_room,
        seq: parsed.seq,
        restored: false,
    })
}

/// #231 P6b: file the member cards a `cap` payload carries into the address
/// book under `room` — each verified (signature, skew), our own skipped — and
/// save the book to `peers_path` when it changed. Returns how many were new or
/// newer. The CALLER has checked the accepted cap's
/// [`ChiaRoomCap::may_share_card`]: a public, bundled or posture-unknown
/// room's hints never fill the book, for the reason the `contact` frame gives.
pub fn file_member_cards(
    peers: &Mutex<crate::chia_contact::PeerBook>,
    peers_path: &std::path::Path,
    self_id: &iroh::PublicKey,
    room: &str,
    payload: &[u8],
    now: u64,
) -> usize {
    let Ok(parsed) = serde_json::from_slice::<RoomCapPayload>(payload) else { return 0 };
    if parsed.member_cards.is_empty() {
        return 0;
    }
    let mut filed = 0usize;
    let mut book = peers.lock().unwrap();
    for card in &parsed.member_cards {
        match crate::chia_contact::verify_card(card, now) {
            Ok(verified) if &verified.node_id == self_id => {}
            Ok(verified) => {
                if book.record_card(&verified, room) {
                    filed += 1;
                }
            }
            Err(e) => eprintln!("⛓️ ChiaHub lane: a member card in room {room}'s cap did not verify: {e}"),
        }
    }
    if filed > 0 {
        if let Err(e) = book.save(peers_path) {
            eprintln!("⛓️ ChiaHub contact: could not save {}: {e}", peers_path.display());
        }
    }
    filed
}

/// Ingest a `cap` payload the local browser sent for `room`: store the room key
/// and flags, log the room's current lookup hint when something changed (a
/// re-sent cap on reconnect is quiet). A cap with a LOWER sequence number than
/// the one held is a straggler from an earlier send and is dropped.
///
/// `then` runs on an accepted cap WHILE the room map is still locked. The
/// persist hook goes there so the files land in acceptance order: the browser's
/// caps arrive one per stream, two streams can carry seq N and N+1 for one room
/// at once, and a write made after the lock is released could put the stale cap
/// on disk last — restored at the next start (with seq 0) as a private, armed
/// room the browser had already declared public.
pub fn ingest_room_cap(
    rooms: &Mutex<HashMap<String, ChiaRoomCap>>,
    room: &str,
    payload: &[u8],
    then: impl FnOnce(&str, &ChiaRoomCap),
) -> Option<ChiaRoomCap> {
    let cap = match parse_room_cap(payload) {
        Some(c) => c,
        None => {
            eprintln!("⛓️ ChiaHub lane: ignoring malformed room cap for {room}");
            return None;
        }
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let hint = crate::chia_lane::derive_hint(&cap.room_key, crate::chia_lane::epoch_now(now));
    let changed = {
        let mut map = rooms.lock().unwrap();
        let changed = match map.get(room) {
            Some(prev) if prev.seq > cap.seq => {
                eprintln!(
                    "⛓️ ChiaHub lane: dropping a stale room cap for {room} (seq {} < held {})",
                    cap.seq, prev.seq
                );
                return None;
            }
            Some(prev) if prev.same_posture(&cap) => {
                map.insert(room.to_string(), cap.clone()); // keep the newest seq
                false
            }
            _ => {
                map.insert(room.to_string(), cap.clone());
                true
            }
        };
        then(room, &cap); // still under the lock — see the doc comment
        changed
    };
    if changed {
        let posture = if cap.public_room == Some(true) {
            "public space — N8: never published or read under this key"
        } else if cap.posture_unknown() {
            "posture unknown (browser predates N8) — reads on, publishing refused until the browser says private"
        } else if cap.chia_mode {
            "armed — reads on, presence publishes while SSF_CHIA_LANE=1"
        } else {
            "reads on, publishing off"
        };
        println!(
            "⛓️ ChiaHub lane: room {room} key received · {posture}{} · epoch hint {}",
            if cap.share_card { "" } else { " · card sharing off for this room" },
            hex::encode(&hint[..8]),
        );
    }
    Some(cap)
}

/// May this node hand its contact card to the peers it is connected to in
/// `room`, and file the cards they hand it? Only a room KNOWN to be private
/// (N8: never a bundled or PUBLIC room, never one whose posture the browser
/// has not stated). One answer gates both directions, so a visitor of a public
/// room can neither learn our key nor fill our address book. Independent of
/// the arming toggle: a card lets the other side find US once we publish, and
/// theirs lets us find them, whether or not either publishes yet.
impl ChiaRoomCap {
    /// Known private by a cap from THIS process (a restored cap's posture may
    /// be stale), never the bundled welcome key, and the room's own toggle on
    /// (#231 P6b).
    pub fn may_share_card(&self) -> bool {
        self.share_card && self.public_room == Some(false) && !self.restored && !is_bundled_room_key(&self.room_key)
    }
}

// ── #231 P6a: cap persistence (`rooms/<hex-room-id>.cap`) ───────────────────
// A cap lived in RAM only, so a node restart forgot every room key until a
// browser came back: the watcher read nothing and the publisher wrote nothing
// for rooms whose docs the node still served from `rooms/<id>.bin`. The cap now
// persists beside the doc, 0600, and loads at startup with `seq` reset to 0 so
// the first cap from any new browser session replaces it (sequence numbers are
// per browser session and would otherwise block a fresh cap as "stale"). The
// room key already sits on this disk in the plaintext doc the node serves, so
// the file adds no new exposure class; it is the same CWD-relative convention
// as every other node file.

const CAP_FILE_SUFFIX: &str = ".cap";

/// Wire shape of a persisted cap (the browser's own field names).
#[derive(serde::Serialize, Deserialize)]
struct PersistedCap {
    #[serde(rename = "roomKeyB64")]
    room_key_b64: String,
    #[serde(rename = "chiaMode")]
    chia_mode: bool,
    #[serde(rename = "publicRoom")]
    public_room: Option<bool>,
    /// Absent (on) in files written before #231 P6b.
    #[serde(rename = "shareCard", default = "default_true")]
    share_card: bool,
}

fn cap_path(room_id: &str) -> std::path::PathBuf {
    std::path::Path::new("rooms").join(format!("{}{CAP_FILE_SUFFIX}", hex::encode(room_id.as_bytes())))
}

/// Write one room's cap. Fails closed: when the new cap cannot be written, the
/// file holding the OLD cap is removed, so a restart never restores a posture
/// the browser has since replaced (a room gone public coming back as private).
pub fn persist_room_cap(room_id: &str, cap: &ChiaRoomCap) {
    use base64::Engine;
    let path = cap_path(room_id);
    let body = PersistedCap {
        room_key_b64: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(cap.room_key),
        chia_mode: cap.chia_mode,
        public_room: cap.public_room,
        share_card: cap.share_card,
    };
    let written = std::fs::create_dir_all("rooms")
        .map_err(|e| format!("cannot create rooms/: {e}"))
        .and_then(|_| serde_json::to_vec(&body).map_err(|e| format!("encode failed: {e}")))
        .and_then(|bytes| crate::chia_contact::write_private(&path, &bytes).map_err(|e| format!("write failed: {e}")));
    if let Err(why) = written {
        match std::fs::remove_file(&path) {
            Ok(()) => eprintln!("💾 cap persist: {why} for {room_id} — the previous cap file was removed so no stale posture is restored"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => eprintln!("💾 cap persist: {why} for {room_id}"),
            Err(e) => eprintln!(
                "💾 cap persist: {why} for {room_id}, and the previous cap file could not be removed ({e}) — it is read-only when restored"
            ),
        }
    }
}

/// Load every persisted cap at startup → (room_id, cap with seq 0). Malformed
/// files are skipped with a log line; a bundled key is forced public as in
/// [`parse_room_cap`].
pub fn load_persisted_caps() -> Vec<(String, ChiaRoomCap)> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir("rooms") {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(hex_id) = name.strip_suffix(CAP_FILE_SUFFIX) else { continue };
        let room_id = match hex::decode(hex_id).ok().and_then(|b| String::from_utf8(b).ok()) {
            Some(id) if !id.is_empty() => id,
            _ => {
                eprintln!("💾 cap persist: skipping malformed filename {name}");
                continue;
            }
        };
        let parsed: Option<PersistedCap> = std::fs::read(entry.path()).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let Some(parsed) = parsed else {
            eprintln!("💾 cap persist: unreadable {name}");
            continue;
        };
        // The cap holds the room key: a file left broader than 0600 is
        // tightened on load, like `contact.key` and `peers.json`.
        if let Err(e) = crate::chia_contact::tighten_private(&entry.path()) {
            eprintln!("💾 cap persist: could not tighten {name}: {e}");
        }
        let Some(room_key) = decode_room_key(&parsed.room_key_b64) else {
            eprintln!("💾 cap persist: bad room key in {name}");
            continue;
        };
        let public_room = if is_bundled_room_key(&room_key) { Some(true) } else { parsed.public_room };
        out.push((
            room_id,
            ChiaRoomCap {
                room_key,
                chia_mode: parsed.chia_mode,
                share_card: parsed.share_card,
                public_room,
                seq: 0,
                restored: true,
            },
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn payload(key: [u8; 32], extra: &str) -> Vec<u8> {
        let b64url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
        format!("{{\"roomKeyB64\":\"{b64url}\"{extra}}}").into_bytes()
    }

    #[test]
    fn room_cap_parses_browser_base64url_and_flags() {
        let key = [9u8; 32];
        let cap = parse_room_cap(&payload(key, ",\"chiaMode\":true,\"publicRoom\":false")).unwrap();
        assert_eq!(cap.room_key, key);
        assert!(cap.chia_mode);
        assert_eq!(cap.public_room, Some(false));
        assert!(cap.may_publish());
        assert!(cap.may_read());
    }

    #[test]
    fn room_cap_defaults_and_rejects_junk() {
        let key = [3u8; 32];
        let cap = parse_room_cap(&payload(key, "")).expect("parses");
        assert!(!cap.chia_mode);
        assert_eq!(cap.public_room, None, "no flag = the browser never said");
        assert!(cap.posture_unknown());
        assert!(!cap.may_publish(), "unarmed rooms never publish");
        assert!(cap.may_read(), "reads need no arming (D3) and no posture");
        assert!(parse_room_cap(b"not json at all").is_none());
        assert!(parse_room_cap(b"{\"roomKeyB64\":\"c2hvcnQ\"}").is_none());
    }

    #[test]
    fn n8_public_room_flag_blocks_publish_and_read() {
        let key = [5u8; 32];
        let cap = parse_room_cap(&payload(key, ",\"chiaMode\":true,\"publicRoom\":true")).unwrap();
        assert_eq!(cap.public_room, Some(true));
        assert!(!cap.may_publish(), "N8: armed but public — never publish");
        assert!(!cap.may_read(), "D6: nothing lives under a public room's hint");
    }

    #[test]
    fn n8_absent_flag_fails_closed_for_publishing_only() {
        // A browser from before N8 arms a room but cannot say whether its
        // passage is public: the node must not publish under that key (the
        // room may well be public space) but may still read it.
        let key = [6u8; 32];
        let cap = parse_room_cap(&payload(key, ",\"chiaMode\":true")).unwrap();
        assert_eq!(cap.public_room, None);
        assert!(!cap.may_publish(), "N8: silence is not 'private'");
        assert!(cap.may_read(), "reads stay on for an unknown posture");
        // Once the browser resolves the door policy and says private, publishing opens.
        let cap = parse_room_cap(&payload(key, ",\"chiaMode\":true,\"publicRoom\":false")).unwrap();
        assert!(cap.may_publish());
    }

    #[test]
    fn n8_bundled_welcome_key_is_public_whatever_the_browser_says() {
        let welcome = decode_room_key(BUNDLED_ROOM_KEYS_B64[0]).expect("bundled key decodes to 32 bytes");
        assert!(is_bundled_room_key(&welcome));
        assert!(!is_bundled_room_key(&[0u8; 32]));
        // An old browser build sends no publicRoom flag and arms the room: still refused.
        let cap = parse_room_cap(&payload(welcome, ",\"chiaMode\":true")).unwrap();
        assert_eq!(cap.public_room, Some(true), "bundled key: public, flag or no flag");
        assert!(!cap.may_publish());
        assert!(!cap.may_read());
        // Even an explicit `false` from the browser cannot make the bundled key private.
        let cap = parse_room_cap(&payload(welcome, ",\"chiaMode\":true,\"publicRoom\":false")).unwrap();
        assert_eq!(cap.public_room, Some(true));
    }

    #[test]
    fn ingest_stores_and_updates_on_change_only() {
        let rooms = Mutex::new(HashMap::new());
        let key = [8u8; 32];
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":false"), |_, _| {});
        assert!(!rooms.lock().unwrap()["r1"].chia_mode);
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true"), |_, _| {});
        assert!(rooms.lock().unwrap()["r1"].chia_mode);
        ingest_room_cap(&rooms, "r1", b"garbage", |_, _| {});
        assert!(rooms.lock().unwrap()["r1"].chia_mode, "malformed cap leaves the stored one alone");
    }

    #[test]
    fn caps_are_trusted_from_loopback_only() {
        let ok = ["127.0.0.1:50000", "127.9.9.9:1", "[::1]:4443", "[::ffff:127.0.0.1]:4443"];
        for a in ok {
            assert!(cap_source_is_local(&a.parse().unwrap()), "{a} is loopback");
        }
        let bad = ["192.168.1.20:4443", "10.0.0.5:1", "203.0.113.7:4443", "[2001:db8::1]:4443", "[::ffff:10.0.0.5]:1"];
        for a in bad {
            assert!(!cap_source_is_local(&a.parse().unwrap()), "{a} is not loopback");
        }
    }

    #[test]
    fn ingest_drops_a_cap_older_than_the_one_held() {
        let rooms = Mutex::new(HashMap::new());
        let key = [11u8; 32];
        // The browser sent PRIVATE (seq 100) then PUBLIC (seq 101); they ride
        // separate streams and the node sees PUBLIC first.
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":true,\"seq\":101"), |_, _| {});
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":false,\"seq\":100"), |_, _| {});
        let held = rooms.lock().unwrap()["r1"].clone();
        assert_eq!(held.public_room, Some(true), "the straggling PRIVATE must not overwrite PUBLIC");
        assert_eq!(held.seq, 101);
        // Equal seq (a browser without sequence numbers always sends 0) is accepted.
        ingest_room_cap(&rooms, "r2", &payload(key, ",\"chiaMode\":false"), |_, _| {});
        ingest_room_cap(&rooms, "r2", &payload(key, ",\"chiaMode\":true"), |_, _| {});
        assert!(rooms.lock().unwrap()["r2"].chia_mode, "seq 0 after seq 0 still applies");
        // A newer cap with the same posture is kept so its seq becomes the floor.
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":true,\"seq\":105"), |_, _| {});
        assert_eq!(rooms.lock().unwrap()["r1"].seq, 105);
    }

    #[test]
    fn persist_hook_runs_under_the_lock_for_accepted_caps_only() {
        let rooms: Mutex<HashMap<String, ChiaRoomCap>> = Mutex::new(HashMap::new());
        let key = [5u8; 32];
        let seen: Mutex<Vec<(u64, bool)>> = Mutex::new(Vec::new());
        let hook = |_: &str, c: &ChiaRoomCap| {
            // The map is still locked while the hook runs, so a cap can never be
            // persisted after a newer one replaced it.
            let locked = rooms.try_lock().is_err();
            seen.lock().unwrap().push((c.seq, locked));
        };
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":false,\"seq\":7"), hook);
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":true,\"seq\":6"), hook);
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":true,\"seq\":8"), hook);
        ingest_room_cap(&rooms, "r1", b"garbage", hook);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![(7, true), (8, true)],
            "stale and malformed caps never reach the hook; accepted ones run with the map locked"
        );
    }

    #[test]
    fn cards_are_shared_only_in_rooms_known_private() {
        let private = ChiaRoomCap {
            room_key: [9u8; 32],
            chia_mode: false,
            share_card: true,
            public_room: Some(false),
            seq: 0,
            restored: false,
        };
        assert!(private.may_share_card(), "a private room shares (and files the peers' cards), armed or not");
        let muted = ChiaRoomCap { share_card: false, ..private.clone() };
        assert!(!muted.may_share_card(), "P6b: the room's own toggle turns cards off");
        assert!(muted.may_read() && !muted.posture_unknown(), "and nothing else");
        let restored = ChiaRoomCap { chia_mode: true, restored: true, ..private.clone() };
        assert!(!restored.may_share_card(), "a cap restored from disk may have gone public meanwhile: no card");
        assert!(!restored.may_publish(), "nor does it arm the room publisher");
        assert!(restored.may_read(), "reading under it is free and harmless");
        assert!(ChiaRoomCap { chia_mode: true, ..private.clone() }.may_publish(), "a live armed private cap publishes");
        let public = ChiaRoomCap { public_room: Some(true), ..private.clone() };
        assert!(!public.may_share_card());
        let unknown = ChiaRoomCap { public_room: None, ..private.clone() };
        assert!(!unknown.may_share_card(), "an unstated posture fails closed");
        let bundled_key = decode_room_key(BUNDLED_ROOM_KEYS_B64[0]).unwrap();
        let bundled = ChiaRoomCap { room_key: bundled_key, public_room: Some(false), ..private.clone() };
        assert!(!bundled.may_share_card(), "the bundled welcome key never gets a card, whatever a browser says");
    }

    #[test]
    fn p6b_share_card_toggle_rides_the_cap_and_its_file() {
        let key = [4u8; 32];
        let on = parse_room_cap(&payload(key, ",\"publicRoom\":false")).unwrap();
        assert!(on.share_card, "absent means on (older browsers)");
        let off = parse_room_cap(&payload(key, ",\"publicRoom\":false,\"shareCard\":false")).unwrap();
        assert!(!off.share_card && !off.may_share_card());
        assert!(!on.same_posture(&off), "the toggle is posture: a change is logged");
        // The persisted shape carries it, and a file from before P6b (no
        // shareCard) loads as on.
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
        let written = PersistedCap { room_key_b64: b64.clone(), chia_mode: true, public_room: Some(false), share_card: false };
        let text = serde_json::to_string(&written).unwrap();
        assert!(text.contains("\"shareCard\":false"));
        let back: PersistedCap = serde_json::from_str(&text).unwrap();
        assert!(!back.share_card, "the toggle survives a restart");
        let older: PersistedCap =
            serde_json::from_str(&format!("{{\"roomKeyB64\":\"{b64}\",\"chiaMode\":true,\"publicRoom\":false}}")).unwrap();
        assert!(older.share_card);
    }

    #[test]
    fn p6b_member_cards_are_verified_and_filed_under_the_room_but_never_our_own() {
        let me = iroh::SecretKey::generate();
        let a = iroh::SecretKey::generate();
        let b = iroh::SecretKey::generate();
        let now = 1_700_000_000u64;
        let card_a = crate::chia_contact::make_card(&a, &[7u8; 32], now);
        let card_me = crate::chia_contact::make_card(&me, &[8u8; 32], now);
        let mut card_b = crate::chia_contact::make_card(&b, &[9u8; 32], now);
        card_b.issued_at += 1; // signature no longer matches
        let cards = serde_json::to_string(&vec![card_a.clone(), card_me, card_b]).unwrap();
        let body = payload([4u8; 32], &format!(",\"publicRoom\":false,\"memberCards\":{cards}"));
        let peers = Mutex::new(crate::chia_contact::PeerBook::default());
        let dir = std::env::temp_dir().join(format!("ssf-member-cards-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(crate::chia_contact::PEERS_FILE);
        let filed = file_member_cards(&peers, &path, &me.public(), "room-x", &body, now);
        assert_eq!(filed, 1, "one good card of another node");
        assert_eq!(crate::chia_contact::PeerBook::load(&path).peers.len(), 1, "saved where it was told");
        let book = peers.lock().unwrap();
        assert_eq!(book.peers.len(), 1);
        let entry = &book.peers[&a.public().to_string()];
        assert_eq!(entry.ck.as_deref(), Some(card_a.ck.as_str()));
        assert!(entry.rooms.contains("room-x"));
        drop(book);
        assert_eq!(file_member_cards(&peers, &path, &me.public(), "room-x", &body, now), 0, "filed once");
        assert_eq!(file_member_cards(&peers, &path, &me.public(), "room-x", &payload([4u8; 32], ""), now), 0, "no cards, nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
