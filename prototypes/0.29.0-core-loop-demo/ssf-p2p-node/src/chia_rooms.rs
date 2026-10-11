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
    /// N8: bundled-seed or PUBLIC-passage room. Never published under, never
    /// read under. Set by the browser OR by the bundled-key check below.
    pub public_room: bool,
}

impl ChiaRoomCap {
    /// May the publisher write a presence record under this room's key?
    /// Armed AND not public space — the N8 guard in one place.
    pub fn may_publish(&self) -> bool {
        self.chia_mode && !self.public_room
    }

    /// Should the reader (rung-6 resolve, P1 watcher) read this room's hint?
    /// Everything that is not public space — reads are free and need no arming
    /// (D3); public rooms carry nothing under their hint by construction (D6).
    pub fn may_read(&self) -> bool {
        !self.public_room
    }
}

/// Wire shape of a `cap` envelope's JSON payload (browser camelCase).
#[derive(Deserialize)]
struct RoomCapPayload {
    #[serde(rename = "roomKeyB64")]
    room_key_b64: String,
    #[serde(rename = "chiaMode", default)]
    chia_mode: bool,
    #[serde(rename = "publicRoom", default)]
    public_room: bool,
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
/// bundled key forces `public_room` on whatever the browser said.
pub fn parse_room_cap(payload: &[u8]) -> Option<ChiaRoomCap> {
    let parsed: RoomCapPayload = serde_json::from_slice(payload).ok()?;
    let room_key = decode_room_key(&parsed.room_key_b64)?;
    let public_room = parsed.public_room || is_bundled_room_key(&room_key);
    Some(ChiaRoomCap { room_key, chia_mode: parsed.chia_mode, public_room })
}

/// Ingest a `cap` payload the local browser sent for `room`: store the room key
/// and flags, log the room's current lookup hint when something changed (a
/// re-sent cap on reconnect is quiet).
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
            Some(prev) if *prev == cap => false,
            _ => {
                map.insert(room.to_string(), cap.clone());
                true
            }
        }
    };
    if changed {
        let posture = if cap.public_room {
            "public space — N8: never published or read under this key"
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
        assert!(!cap.public_room);
        assert!(cap.may_publish());
        assert!(cap.may_read());
    }

    #[test]
    fn room_cap_defaults_flags_false_and_rejects_junk() {
        let key = [3u8; 32];
        let cap = parse_room_cap(&payload(key, "")).expect("parses");
        assert!(!cap.chia_mode);
        assert!(!cap.public_room);
        assert!(!cap.may_publish(), "unarmed rooms never publish");
        assert!(cap.may_read(), "reads need no arming (D3)");
        assert!(parse_room_cap(b"not json at all").is_none());
        assert!(parse_room_cap(b"{\"roomKeyB64\":\"c2hvcnQ\"}").is_none());
    }

    #[test]
    fn n8_public_room_flag_blocks_publish_and_read() {
        let key = [5u8; 32];
        let cap = parse_room_cap(&payload(key, ",\"chiaMode\":true,\"publicRoom\":true")).unwrap();
        assert!(cap.public_room);
        assert!(!cap.may_publish(), "N8: armed but public — never publish");
        assert!(!cap.may_read(), "D6: nothing lives under a public room's hint");
    }

    #[test]
    fn n8_bundled_welcome_key_is_public_whatever_the_browser_says() {
        let welcome = decode_room_key(BUNDLED_ROOM_KEYS_B64[0]).expect("bundled key decodes to 32 bytes");
        assert!(is_bundled_room_key(&welcome));
        assert!(!is_bundled_room_key(&[0u8; 32]));
        // An old browser build sends no publicRoom flag and arms the room: still refused.
        let cap = parse_room_cap(&payload(welcome, ",\"chiaMode\":true")).unwrap();
        assert!(cap.public_room);
        assert!(!cap.may_publish());
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
}
