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
}

impl ChiaRoomCap {
    /// Same key and flags — what "changed" means for logging; `seq` is not posture.
    pub fn same_posture(&self, other: &ChiaRoomCap) -> bool {
        self.room_key == other.room_key && self.chia_mode == other.chia_mode && self.public_room == other.public_room
    }

    /// May the publisher write a presence record under this room's key?
    /// Armed AND KNOWN private — the N8 guard in one place. An absent flag is
    /// not "private": an older browser cannot vouch for the room's posture.
    pub fn may_publish(&self) -> bool {
        self.chia_mode && self.public_room == Some(false)
    }

    /// Should the reader (rung-6 resolve, P1 watcher) read this room's hint?
    /// Everything not KNOWN to be public space — reads are free and need no
    /// arming (D3); public rooms carry nothing under their hint by
    /// construction (D6), so skipping them only saves gateway calls.
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
    Some(ChiaRoomCap { room_key, chia_mode: parsed.chia_mode, public_room, seq: parsed.seq })
}

/// Ingest a `cap` payload the local browser sent for `room`: store the room key
/// and flags, log the room's current lookup hint when something changed (a
/// re-sent cap on reconnect is quiet). A cap with a LOWER sequence number than
/// the one held is a straggler from an earlier send and is dropped.
pub fn ingest_room_cap(rooms: &Mutex<HashMap<String, ChiaRoomCap>>, room: &str, payload: &[u8]) {
    let cap = match parse_room_cap(payload) {
        Some(c) => c,
        None => {
            eprintln!("⛓️ ChiaHub lane: ignoring malformed room cap for {room}");
            return;
        }
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let hint = crate::chia_lane::derive_hint(&cap.room_key, crate::chia_lane::epoch_now(now));
    let changed = {
        let mut map = rooms.lock().unwrap();
        match map.get(room) {
            Some(prev) if prev.seq > cap.seq => {
                eprintln!(
                    "⛓️ ChiaHub lane: dropping a stale room cap for {room} (seq {} < held {})",
                    cap.seq, prev.seq
                );
                return;
            }
            Some(prev) if prev.same_posture(&cap) => {
                map.insert(room.to_string(), cap.clone()); // keep the newest seq
                false
            }
            _ => {
                map.insert(room.to_string(), cap.clone());
                true
            }
        }
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
            "⛓️ ChiaHub lane: room {room} key received · {posture} · epoch hint {}",
            hex::encode(&hint[..8]),
        );
    }
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
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":false"));
        assert!(!rooms.lock().unwrap()["r1"].chia_mode);
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true"));
        assert!(rooms.lock().unwrap()["r1"].chia_mode);
        ingest_room_cap(&rooms, "r1", b"garbage");
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
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":true,\"seq\":101"));
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":false,\"seq\":100"));
        let held = rooms.lock().unwrap()["r1"].clone();
        assert_eq!(held.public_room, Some(true), "the straggling PRIVATE must not overwrite PUBLIC");
        assert_eq!(held.seq, 101);
        // Equal seq (a browser without sequence numbers always sends 0) is accepted.
        ingest_room_cap(&rooms, "r2", &payload(key, ",\"chiaMode\":false"));
        ingest_room_cap(&rooms, "r2", &payload(key, ",\"chiaMode\":true"));
        assert!(rooms.lock().unwrap()["r2"].chia_mode, "seq 0 after seq 0 still applies");
        // A newer cap with the same posture is kept so its seq becomes the floor.
        ingest_room_cap(&rooms, "r1", &payload(key, ",\"chiaMode\":true,\"publicRoom\":true,\"seq\":105"));
        assert_eq!(rooms.lock().unwrap()["r1"].seq, 105);
    }
}
