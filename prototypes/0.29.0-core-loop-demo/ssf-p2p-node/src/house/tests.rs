//! The house's job on a room's document built as the browsers build it:
//! the pages' records (slips, reveals, closes, abandons, checkpoints) signed
//! as computedTable signs them, the owner's delegation and settings as
//! computedTable houseDuty and setComputedFairness write them.

use super::*;
use iroh::SecretKey;
use yrs::updates::decoder::Decode;
use yrs::{MapPrelim, WriteTxn};

const ROOM: &str = "room-house";
const T: &str = "roulette-1";
const INC: &str = "r0123456789abcdef01234567";
const NODE: [u8; 32] = [7u8; 32];

struct Who {
    pid: String,
    key: SecretKey,
    public: String,
}

fn who(pid: &str) -> Who {
    let key = SecretKey::from_bytes(&hb::sha256(format!("ssf-house-test|{pid}").as_bytes()));
    let public = hb::b64url(key.public().as_bytes());
    Who { pid: pid.into(), key, public }
}

fn sign(w: &Who, bytes: &[u8; 32]) -> String {
    hb::b64url(&w.key.sign(bytes).to_bytes())
}

fn ctx() -> Ctx {
    Ctx { room: ROOM.into(), t: T.into(), inc: INC.into() }
}

fn obj(fields: Vec<(&str, CVal)>) -> CVal {
    CVal::Obj(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn s(v: &str) -> CVal {
    CVal::Str(v.into())
}

fn with(rec: &CVal, k: &str, v: CVal) -> CVal {
    let CVal::Obj(mut fields) = rec.clone() else { unreachable!() };
    fields.retain(|(name, _)| name != k);
    fields.push((k.into(), v));
    CVal::Obj(fields)
}

/// A session record signed by `w` (computedTable `signed`).
fn signed(kind: &str, w: &Who, body: CVal) -> CVal {
    let body = with(&body, "k", s(&w.public));
    let g = sign(w, &hb::sign_bytes(kind, &ctx(), &body).unwrap());
    with(&body, "g", s(&g))
}

/// A room record signed by `w` (computedHouse roomSignBytes).
fn room_signed(kind: &str, t: &str, w: &Who, body: CVal) -> CVal {
    let body = with(&body, "k", s(&w.public));
    let g = sign(w, &hb::room_sign_bytes(kind, ROOM, t, &body).unwrap());
    with(&body, "g", s(&g))
}

fn seed_of(pid: &str, r: i64) -> String {
    hex::encode(hb::sha256(format!("seed|{pid}|{r}").as_bytes()))
}

struct Room {
    doc: Doc,
    owner: Who,
    house: House,
    now: u64,
    dir: PathBuf,
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ssf-house-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

impl Room {
    /// The owner's room, its table switched on, the house delegated or not.
    fn new(name: &str, delegate: bool) -> Self {
        let dir = scratch(name);
        let mut house = House::open(&NODE, Some(dir.join(STATE_FILE))).unwrap();
        // (The settle after a start has a test of its own.)
        house.settle_ms = 0;
        let owner = who("owner");
        let doc = Doc::new();
        let room = Room { doc, owner, house, now: 1_000_000, dir };
        {
            let mut txn = room.doc.transact_mut();
            let info = txn.get_or_insert_map("roomInfo");
            info.insert(&mut txn, "owner", Any::String(Arc::from("owner")));
            let players = txn.get_or_insert_map("players");
            players.insert(&mut txn, "owner", to_any(&obj(vec![("keyB64", s(&room.owner.public))])));
            for p in ["alice", "bob", "carol", "mallory"] {
                players.insert(&mut txn, p, to_any(&obj(vec![("keyB64", s(&who(p).public))])));
            }
            let casino = txn.get_or_insert_map(CASINO_MAP);
            casino.insert(&mut txn, format!("cfg:computed:{T}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC))])));
            let comp = txn.get_or_insert_map(COMPUTED_MAP);
            comp.insert(&mut txn, format!("ses:{T}:{INC}:g"), MapPrelim::default());
        }
        if delegate {
            room.delegate(&room.owner);
        }
        room
    }

    fn delegate(&self, by: &Who) {
        let rec = room_signed("hkey", "", by, obj(vec![("v", CVal::Int(1)), ("h", s(self.house.public()))]));
        self.put_top(&format!("hk:{}", self.house.public()), &rec);
    }

    fn put_top(&self, key: &str, v: &CVal) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, to_any(v));
    }

    fn ses_key(&self) -> String {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let cp = top_value(&comp, &txn, &format!("sum:{T}:{INC}"));
        format!("ses:{T}:{INC}:{}", hb::next_sid(&ctx(), cp.as_ref()).unwrap())
    }

    /// Put a record into the live session under its own key; the key.
    fn put(&self, kind: char, v: &CVal) -> String {
        let r = v.get("r").and_then(CVal::as_int).unwrap();
        let h = hb::rec_hash(v).unwrap();
        let key = match v.get("p").and_then(CVal::as_str) {
            Some(p) if kind == 's' || kind == 'x' => format!("{kind}:{r}:{p}:{h}"),
            _ => format!("{kind}:{r}:{h}"),
        };
        let ses = self.ses_key();
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!("no session {ses}") };
        m.insert(&mut txn, key.as_str(), to_any(v));
        key
    }

    /// Put `v` under `key` in the live session as it is (junk included).
    fn put_raw(&self, key: &str, v: &CVal) {
        let ses = self.ses_key();
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!("no session {ses}") };
        m.insert(&mut txn, key, to_any(v));
    }

    fn delete(&self, key: &str) {
        let ses = self.ses_key();
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        if key.starts_with("hk:") || key.starts_with("hf:") {
            comp.remove(&mut txn, key);
        } else if let Some(Out::YMap(m)) = comp.get(&txn, &ses) {
            m.remove(&mut txn, key);
        }
    }

    /// A slip by `w` at round r with seed seed_of(w, r), 5 on red: its hash.
    fn slip(&self, w: &Who, r: i64) -> String {
        self.slip_on(w, r, CVal::Arr(vec![obj(vec![("type", s("red")), ("amount", CVal::Int(5))])]))
    }

    /// The same with felt `b`.
    fn slip_on(&self, w: &Who, r: i64, b: CVal) -> String {
        let c = hb::slip_commit(&ctx(), r, &w.pid, &seed_of(&w.pid, r));
        let body = obj(vec![("r", CVal::Int(r)), ("p", s(&w.pid)), ("v", CVal::Int(1)), ("b", b), ("c", s(&c))]);
        let rec = signed("slip", w, body);
        self.put('s', &rec);
        hb::rec_hash(&rec).unwrap()
    }

    fn reveal(&self, w: &Who, r: i64) {
        self.put('x', &obj(vec![("r", CVal::Int(r)), ("p", s(&w.pid)), ("s", s(&seed_of(&w.pid, r)))]));
    }

    /// A close of round r by `by`, freezing `frozen` (pid, slip hash), on
    /// parent q, naming h: its hash.
    fn close(&self, by: &Who, r: i64, q: &str, frozen: &[(&str, &str)], h: Option<&str>) -> String {
        let f = CVal::Obj(frozen.iter().map(|(p, x)| (p.to_string(), s(x))).collect());
        let mut fields = vec![("r", CVal::Int(r)), ("q", s(q)), ("f", f)];
        if let Some(h) = h {
            fields.push(("h", s(h)));
        }
        let rec = signed("close", by, obj(fields));
        self.put('c', &rec);
        hb::rec_hash(&rec).unwrap()
    }

    fn abandon(&self, by: &Who, r: i64, x: &str) {
        let rec = signed("abandon", by, obj(vec![("r", CVal::Int(r)), ("x", s(x))]));
        self.put('z', &rec);
    }

    fn set_fair(&self, m: i64, seq: i64) {
        let rec = room_signed("hfair", T, &self.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(m)), ("s", CVal::Int(seq))]));
        self.put_top(&format!("hf:{T}"), &rec);
    }

    fn tick(&mut self, after: u64) -> TickOut {
        self.now += after;
        self.house.tick(ROOM, &self.doc, self.now, 1_700_000_000_000 + self.now)
    }

    /// The live session's records of a kind, by key.
    fn records(&self, prefix: &str) -> Vec<(String, CVal)> {
        let ses = self.ses_key();
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { return vec![] };
        let mut out: Vec<(String, CVal)> = m
            .iter(&txn)
            .filter(|(k, _)| k.starts_with(prefix))
            .filter_map(|(k, v)| match v {
                Out::Any(a) => Some((k.to_string(), CVal::from_any(&a))),
                _ => None,
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn top(&self, key: &str) -> Option<CVal> {
        let txn = self.doc.transact();
        top_value(&txn.get_map(COMPUTED_MAP).unwrap(), &txn, key)
    }

    fn commit(&self, r: i64) -> String {
        self.house.commit(&ctx(), r)
    }

    /// Round 1 closed by alice on the house's join, alice and bob frozen;
    /// returns (close hash, alice's slip, bob's slip).
    fn closed_on_the_join(&mut self, alice: &Who, bob: &Who) -> (String, String, String) {
        self.tick(0);
        assert_eq!(self.records("o:1:").len(), 1, "the house joined round 1");
        let (a, b) = (self.slip(alice, 1), self.slip(bob, 1));
        let c = self.close(alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&self.commit(1)));
        (c, a, b)
    }
}

impl Drop for Room {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn strs(v: &CVal, k: &str) -> Vec<String> {
    v.get(k).and_then(CVal::as_arr).unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// A house record as the pages check it: the house's key, its signature
/// over signBytes, and a seed opening `commit`.
fn assert_house_rec(room: &Room, kind: &str, rec: &CVal) {
    assert_eq!(str_of(rec, "k"), Some(room.house.public()));
    let bytes = hb::sign_bytes(kind, &ctx(), rec).unwrap();
    assert!(hb::verify(room.house.public(), &bytes, str_of(rec, "g").unwrap()), "{kind} signature");
}

#[test]
fn nothing_without_a_delegation_from_the_deed_holder() {
    let mut room = Room::new("none", false);
    assert_eq!(room.tick(0).wrote, 0);
    // A delegation signed by someone else is nobody's.
    room.delegate(&who("mallory"));
    assert_eq!(room.tick(1_000).wrote, 0);
    assert!(room.records("o:").is_empty());
}

#[test]
fn joins_then_reveals_a_round_once_every_seed_is_in() {
    let mut room = Room::new("fair", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let out = room.tick(0);
    assert!(out.update.is_some());
    let joins = room.records("o:1:");
    assert_eq!(joins.len(), 1);
    let join = &joins[0].1;
    assert_house_rec(&room, "hcommit", join);
    assert_eq!(str_of(join, "c"), Some(room.commit(1).as_str()));
    assert!(room.top(&format!("hb:{}", room.house.public())).is_some(), "the house beats");

    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    room.tick(200);
    assert!(room.records("h:").is_empty(), "no reveal before the seeds");
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    let reveals = room.records("h:1:");
    assert_eq!(reveals.len(), 1);
    let h = &reveals[0].1;
    assert_house_rec(&room, "hreveal", h);
    assert_eq!(strs(h, "x"), vec![c.clone()]);
    assert_eq!(strs(h, "n"), sorted(vec![a.clone(), b.clone()]));
    assert_eq!(str_of(h, "c"), Some(room.commit(2).as_str()), "carries the next round's commitment");
    assert_eq!(hb::house_commit(&ctx(), 1, str_of(h, "s").unwrap()), room.commit(1), "its seed opens the join");

    // Round 2 asks for that commitment: no join, and no second reveal of 1.
    for _ in 0..30 {
        room.tick(500);
    }
    assert_eq!(room.records("h:").len(), 1);
    assert!(room.records("o:2:").is_empty());
    // Round 2 closes on it and is revealed in turn.
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    let c2 = room.close(&bob, 2, &c, &[("alice", &a2), ("bob", &b2)], Some(&room.commit(2)));
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    room.tick(200);
    let h2 = &room.records("h:2:")[0].1;
    assert_eq!(strs(h2, "x"), vec![c2]);
    assert_eq!(str_of(h2, "c"), Some(room.commit(3).as_str()));
}

#[test]
fn waits_for_a_late_seed_until_the_grace_runs_out() {
    let mut room = Room::new("grace", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (_, a, _) = room.closed_on_the_join(&alice, &bob);
    room.tick(0);
    room.tick(1_000);
    // Alice's seed at 1 s (it stretches nothing: 2.5 s is inside 4 s).
    room.reveal(&alice, 1);
    room.tick(0);
    room.tick(2_999);
    assert!(room.records("h:").is_empty(), "inside the grace");
    room.tick(1);
    let h = &room.records("h:1:")[0].1;
    assert_eq!(strs(h, "n"), vec![a], "only the seed it saw");
}

#[test]
fn a_seed_inside_the_grace_stretches_it() {
    let mut room = Room::new("stretch", true);
    let (alice, bob, carol) = (who("alice"), who("bob"), who("carol"));
    room.tick(0);
    let (a, b, c) = (room.slip(&alice, 1), room.slip(&bob, 1), room.slip(&carol, 1));
    room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b), ("carol", &c)], Some(&room.commit(1)));
    room.tick(0);
    room.reveal(&alice, 1);
    room.tick(3_500);
    // Alice's seed at 3.5 s: the grace runs to 5 s.
    room.tick(1_000);
    assert!(room.records("h:").is_empty(), "the grace was stretched to 5 s");
    room.tick(500);
    assert_eq!(strs(&room.records("h:1:")[0].1, "n"), vec![a]);
}

#[test]
fn a_close_already_abandoned_when_first_seen_is_never_revealed() {
    let mut room = Room::new("abandoned", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    room.abandon(&bob, 1, &c);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..20 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty());
}

#[test]
fn an_abandon_after_the_house_saw_the_close_is_beaten() {
    let mut room = Room::new("beaten", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    room.tick(0);
    room.abandon(&bob, 1, &c);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(room.records("h:1:").len(), 1);
}

#[test]
fn a_round_with_a_later_round_on_top_when_first_seen_is_never_revealed() {
    let mut room = Room::new("later", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.tick(0);
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &c, &[("alice", &a2), ("bob", &b2)], None);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..20 {
        room.tick(1_000);
    }
    assert!(room.records("h:1:").is_empty());
}

#[test]
fn a_round_seen_too_late_is_given_up() {
    let mut room = Room::new("cutoff", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.tick(0);
    // The node stalls past the cutoff; the seeds are in when it wakes.
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(REVEAL_CUTOFF_MS + 1);
    assert!(room.records("h:").is_empty());
    room.tick(200);
    assert!(room.records("h:").is_empty());
}

#[test]
fn a_joined_round_with_a_rival_friendly_close_is_refused() {
    let mut room = Room::new("rival", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (_, a, b) = room.closed_on_the_join(&alice, &bob);
    room.close(&bob, 1, "g", &[("alice", &a), ("bob", &b)], None);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..20 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty());
    // The next round is joined again.
    assert_eq!(room.records("o:2:").len(), 1);
}

#[test]
fn closes_no_frozen_slip_signed_are_not_listed() {
    let mut room = Room::new("junk", true);
    let (alice, bob, mallory) = (who("alice"), who("bob"), who("mallory"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    let (a, b) = (hb::rec_hash(&room.records("s:1:alice")[0].1).unwrap(), hb::rec_hash(&room.records("s:1:bob")[0].1).unwrap());
    // Mallory froze nothing; a close with a forged signature.
    room.close(&mallory, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    let forged = with(&signed("close", &alice, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", obj(vec![("alice", s(&a))])), ("h", s(&room.commit(1)))])), "g", s(&"A".repeat(86)));
    room.put('c', &forged);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
}

#[test]
fn never_reveals_a_round_twice_and_puts_its_reveal_back() {
    let mut room = Room::new("twice", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    let (key, rec) = room.records("h:1:")[0].clone();
    // A peer deletes it: the same record goes back, no new one.
    room.delete(&key);
    room.tick(REPUT_MS);
    let back = room.records("h:1:");
    assert_eq!(back.len(), 1);
    assert_eq!((back[0].0.as_str(), hb::canon(&back[0].1)), (key.as_str(), hb::canon(&rec)));
    // A restart that finds it gone puts the same one back, from its state
    // file, and reveals nothing more for round 1.
    room.delete(&key);
    room.house = House::open(&NODE, Some(room.dir.join(STATE_FILE))).unwrap();
    room.house.settle_ms = 0;
    for _ in 0..10 {
        room.tick(1_000);
    }
    let back = room.records("h:1:");
    assert_eq!(back.len(), 1);
    assert_eq!((back[0].0.as_str(), hb::canon(&back[0].1)), (key.as_str(), hb::canon(&rec)));
    assert_eq!(room.records("o:1:").len(), 1, "and joins nothing it already revealed");
}

#[test]
fn after_a_restart_it_reveals_no_close_it_did_not_watch_come_and_joins_once_settled() {
    let mut room = Room::new("settle", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    // The node goes down right after the close (it never read it), and comes
    // back with every seed in.
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.house = House::open(&NODE, Some(room.dir.join(STATE_FILE))).unwrap();
    assert_eq!(room.house.settle_ms, SETTLE_MS);
    for _ in 0..(SETTLE_MS / 1_000 + 3) {
        room.tick(1_000);
        assert!(room.records("h:").is_empty(), "the close it found on its first read is never revealed");
    }
    // The pages void round 1 (an abandon): round 2 is joined, now settled.
    room.abandon(&alice, 1, &c);
    room.tick(200);
    assert!(room.records("h:").is_empty());
    assert_eq!(room.records("o:2:").len(), 1);
}

#[test]
fn settling_after_a_start_it_joins_nothing_and_reveals_no_close_first_seen_then() {
    let mut room = Room::new("settle-start", true);
    room.house.settle_ms = SETTLE_MS;
    room.tick(0);
    room.tick(SETTLE_MS - 1);
    assert!(room.records("o:").is_empty(), "no join while it settles");
    // A Friendly round closes meanwhile: nothing to do. Once settled it joins
    // round 2.
    let (alice, bob) = (who("alice"), who("bob"));
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], None);
    room.tick(1);
    assert_eq!(room.records("o:2:").len(), 1);
}

#[test]
fn an_unreadable_state_file_keeps_the_house_off() {
    let dir = scratch("corrupt");
    std::fs::write(dir.join(STATE_FILE), b"{not json").unwrap();
    assert!(House::open(&NODE, Some(dir.join(STATE_FILE))).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn steps_down_when_the_owner_sets_the_table_friendly() {
    let mut room = Room::new("friendly", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    room.set_fair(1, 1);
    room.tick(200);
    let down = room.records("h:2:");
    assert_eq!(down.len(), 1);
    let d = &down[0].1;
    assert_house_rec(&room, "hreveal", d);
    assert!(strs(d, "x").is_empty() && strs(d, "n").is_empty() && d.get("c").is_none(), "a step-down");
    assert_eq!(hb::house_commit(&ctx(), 2, str_of(d, "s").unwrap()), room.commit(2), "it opens round 2's commitment");
    // Friendly from here: no join, no heartbeat.
    let beat = room.top(&format!("hb:{}", room.house.public()));
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &c, &[("alice", &a2), ("bob", &b2)], None);
    for _ in 0..12 {
        room.tick(1_000);
    }
    assert!(room.records("o:").iter().all(|(k, _)| k.starts_with("o:1:")));
    assert_eq!(room.top(&format!("hb:{}", room.house.public())).and_then(|v| hb::canon(&v)), beat.and_then(|v| hb::canon(&v)));
    // Fair again: the next round is joined.
    room.set_fair(0, 2);
    room.tick(200);
    assert_eq!(room.records("o:3:").len(), 1);
}

#[test]
fn friendly_mid_round_reveals_that_round_without_a_next_commitment() {
    let mut room = Room::new("mid", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.set_fair(1, 1);
    room.tick(0);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    let h = &room.records("h:1:")[0].1;
    assert_eq!(strs(h, "x").len(), 1);
    assert!(h.get("c").is_none());
}

#[test]
fn stepping_down_on_stop_lifts_the_commitment_or_leaves_a_short_round_void() {
    let mut room = Room::new("stop", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    // Round 2 closed on its commitment, bob's seed not in yet: stopping
    // writes nothing for it (the round voids, every stake back).
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &c, &[("alice", &a2), ("bob", &b2)], Some(&room.commit(2)));
    room.reveal(&alice, 2);
    room.house.begin_step_down();
    room.tick(200);
    assert!(room.records("h:2:").is_empty());
    // Not even once the grace has run out.
    room.tick(GRACE_MAX_MS);
    assert!(room.records("h:2:").is_empty());
    // With every seed in, it is revealed, carrying nothing on.
    room.reveal(&bob, 2);
    room.tick(200);
    let h = &room.records("h:2:")[0].1;
    assert_eq!(strs(h, "x").len(), 1);
    assert!(h.get("c").is_none());
}

#[test]
fn stepping_down_on_stop_between_rounds() {
    let mut room = Room::new("stop2", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    room.house.begin_step_down();
    let out = room.tick(200);
    assert_eq!(out.wrote, 1);
    let d = &room.records("h:2:")[0].1;
    assert!(strs(d, "x").is_empty());
    assert_eq!(room.tick(5_000).wrote, 0, "nothing more: no heartbeat, no join");
}

#[test]
fn a_join_nobody_closed_on_is_stepped_down_too() {
    let mut room = Room::new("stopjoin", true);
    room.tick(0);
    assert_eq!(room.records("o:1:").len(), 1);
    room.house.begin_step_down();
    room.tick(200);
    let d = &room.records("h:1:")[0].1;
    assert!(strs(d, "x").is_empty());
    assert_eq!(hb::house_commit(&ctx(), 1, str_of(d, "s").unwrap()), room.commit(1));
}

#[test]
fn puts_back_the_delegation_and_the_newest_setting() {
    let mut room = Room::new("putback", true);
    room.set_fair(1, 3);
    room.tick(0);
    let deleg = room.top(&format!("hk:{}", room.house.public())).unwrap();
    let setting = room.top(&format!("hf:{T}")).unwrap();
    room.delete(&format!("hk:{}", room.house.public()));
    // An older setting replayed.
    let old = room_signed("hfair", T, &room.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(0)), ("s", CVal::Int(2))]));
    room.put_top(&format!("hf:{T}"), &old);
    room.tick(REPUT_MS);
    assert_eq!(room.top(&format!("hk:{}", room.house.public())).and_then(|v| hb::canon(&v)), hb::canon(&deleg));
    assert_eq!(room.top(&format!("hf:{T}")).and_then(|v| hb::canon(&v)), hb::canon(&setting));
    // ...and goes on reading the table as Friendly: no join.
    assert!(room.records("o:").is_empty());
}

#[test]
fn heartbeats_count_up_past_the_one_in_the_doc() {
    let mut room = Room::new("beat", true);
    room.tick(0);
    let key = format!("hb:{}", room.house.public());
    let n1 = room.top(&key).unwrap().get("n").and_then(CVal::as_int).unwrap();
    room.tick(1_000);
    assert_eq!(room.top(&key).unwrap().get("n").and_then(CVal::as_int), Some(n1), "every 5 s");
    room.tick(4_000);
    let beat = room.top(&key).unwrap();
    assert!(beat.get("n").and_then(CVal::as_int).unwrap() > n1);
    let bytes = hb::room_sign_bytes("hbeat", ROOM, "", &beat).unwrap();
    assert!(hb::verify(room.house.public(), &bytes, str_of(&beat, "g").unwrap()));
    // A peer's copy with a higher count, unsigned: it counts on from its own.
    let n2 = beat.get("n").and_then(CVal::as_int).unwrap();
    let forged = with(&with(&beat, "n", CVal::Int(MAX_SAFE)), "g", s(&"A".repeat(86)));
    room.put_top(&key, &forged);
    room.tick(5_000);
    let n3 = room.top(&key).unwrap().get("n").and_then(CVal::as_int).unwrap();
    assert!(n3 > n2 && n3 < 9_000_000_000_000_000, "{n3}");
    // A beat of its own from the future in the doc (another clock): the
    // next passes it.
    let body = obj(vec![("v", CVal::Int(1)), ("n", CVal::Int(9_000_000_000_000_000)), ("k", s(room.house.public()))]);
    let g = room.house.key.sign(&hb::room_sign_bytes("hbeat", ROOM, "", &body).unwrap());
    room.put_top(&key, &with(&body, "g", s(&g)));
    room.tick(5_000);
    assert!(room.top(&key).unwrap().get("n").and_then(CVal::as_int).unwrap() > 9_000_000_000_000_000);
}

#[test]
fn a_forged_setting_with_a_higher_count_is_put_back_over() {
    let mut room = Room::new("forged-setting", true);
    room.set_fair(1, 3);
    room.tick(0);
    let setting = room.top(&format!("hf:{T}")).unwrap();
    // Fair, numbered past it, under the owner's key, not their signature.
    let forged = room_signed("hfair", T, &who("mallory"), obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(0)), ("s", CVal::Int(9))]));
    room.put_top(&format!("hf:{T}"), &with(&forged, "k", s(&room.owner.public)));
    room.tick(REPUT_MS);
    assert_eq!(room.top(&format!("hf:{T}")).and_then(|v| hb::canon(&v)), hb::canon(&setting));
    assert!(room.records("o:").is_empty(), "still Friendly");
    // The owner's own newer one stands.
    room.set_fair(0, 4);
    let newer = room.top(&format!("hf:{T}")).unwrap();
    room.tick(REPUT_MS);
    assert_eq!(room.top(&format!("hf:{T}")).and_then(|v| hb::canon(&v)), hb::canon(&newer));
    assert_eq!(room.records("o:1:").len(), 1, "Fair: it joins");
}

#[test]
fn a_signature_verdict_holds_only_where_it_was_given() {
    let mut room = Room::new("scope", true);
    room.set_fair(1, 1);
    let rec = room.top(&format!("hf:{T}")).unwrap();
    let (hash, g) = (hb::rec_hash(&rec).unwrap(), str_of(&rec, "g").unwrap().to_string());
    let k = room.owner.public.clone();
    assert!(room.house.verified("hfair", [ROOM, T, ""], &hash, &k, hb::room_sign_bytes("hfair", ROOM, T, &rec), &g));
    // The same record copied to another table, or another room.
    assert!(!room.house.verified("hfair", [ROOM, "roulette-2", ""], &hash, &k, hb::room_sign_bytes("hfair", ROOM, "roulette-2", &rec), &g));
    assert!(!room.house.verified("hfair", ["room-2", T, ""], &hash, &k, hb::room_sign_bytes("hfair", "room-2", T, &rec), &g));
    assert!(room.house.verified("hfair", [ROOM, T, ""], &hash, &k, hb::room_sign_bytes("hfair", ROOM, T, &rec), &g));
}

#[test]
fn records_under_its_key_it_did_not_sign_are_not_its_own() {
    let mut room = Room::new("forged-own", true);
    let (alice, bob) = (who("alice"), who("bob"));
    // A "reveal" of round 1000 and a "join" of round 1, the house's key on
    // them, mallory's signature.
    let mallory = who("mallory");
    let fake = |kind: &str, body: CVal| with(&signed(kind, &mallory, body), "k", s(room.house.public()));
    let h = fake("hreveal", obj(vec![("r", CVal::Int(1000)), ("s", s(&"0".repeat(64))), ("x", CVal::Arr(vec![])), ("n", CVal::Arr(vec![]))]));
    let o = fake("hcommit", obj(vec![("r", CVal::Int(1)), ("c", s(&room.commit(1)))]));
    room.put('h', &h);
    room.put('o', &o);
    room.tick(0);
    let joins = room.records("o:1:");
    assert_eq!(joins.len(), 2, "it joins round 1 itself");
    let mine: Vec<_> = joins.iter().filter(|(_, v)| hb::canon(v) != hb::canon(&o)).collect();
    assert_eq!(mine.len(), 1);
    assert_house_rec(&room, "hcommit", &mine[0].1);
    // ...and reveals it.
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
}

#[test]
fn a_close_skipping_rounds_is_not_on_the_chain() {
    let mut room = Room::new("jump", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    // Round 50 "after" round 1: it would make round 1 one with a later round
    // on top, and the next round to join 51.
    let a50 = room.slip(&alice, 50);
    room.close(&alice, 50, &c, &[("alice", &a50)], None);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
    for _ in 0..5 {
        room.tick(1_000);
    }
    assert!(room.records("o:51:").is_empty());
}

#[test]
fn reveals_one_close_a_round_and_carries_on_its_line_alone() {
    let mut room = Room::new("rivals", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c1, a, b) = room.closed_on_the_join(&alice, &bob);
    // A rival close of round 1, by bob, freezing bob alone.
    let c1b = room.close(&bob, 1, "g", &[("bob", &b)], Some(&room.commit(1)));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    let h = &room.records("h:1:")[0].1;
    let x = strs(h, "x");
    assert_eq!(x.len(), 1, "one close: {x:?}");
    let (picked, other) = if x[0] == c1 { (c1.clone(), c1b.clone()) } else { (c1b.clone(), c1.clone()) };
    let frozen = if picked == c1 { sorted(vec![a.clone(), b.clone()]) } else { vec![b.clone()] };
    assert_eq!(strs(h, "n"), frozen, "the slips of that close alone");

    // Round 2 on the close it passed over, naming the commitment it carried:
    // never revealed.
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &other, &[("alice", &a2), ("bob", &b2)], Some(&room.commit(2)));
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    for _ in 0..20 {
        room.tick(1_000);
    }
    assert!(room.records("h:2:").is_empty());
    // On the close it decided: revealed.
    let d = room.close(&bob, 2, &picked, &[("alice", &a2), ("bob", &b2)], Some(&room.commit(2)));
    room.tick(200);
    assert_eq!(strs(&room.records("h:2:")[0].1, "x"), vec![d]);
}

#[test]
fn a_checkpoint_carrying_the_commitment_needs_no_join() {
    let mut room = Room::new("trim", true);
    let (alice, bob) = (who("alice"), who("bob"));
    // A trim after round 4: the checkpoint names round 5's commitment, the
    // next session opens empty.
    let cp_body = obj(vec![
        ("v", CVal::Int(1)),
        ("b", s("g")),
        ("u", CVal::Int(4)),
        ("l", s(&"ab".repeat(16))),
        ("n", obj(vec![])),
        ("h", s(&room.commit(5))),
    ]);
    let cp = signed("sum", &alice, cp_body);
    {
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        comp.insert(&mut txn, format!("sum:{T}:{INC}"), to_any(&cp));
        comp.remove(&mut txn, &format!("ses:{T}:{INC}:g"));
        let sid = hb::next_sid(&ctx(), Some(&cp)).unwrap();
        comp.insert(&mut txn, format!("ses:{T}:{INC}:{sid}"), MapPrelim::default());
    }
    room.tick(0);
    assert!(room.records("o:").is_empty(), "the checkpoint carries round 5's");
    let sid = room.ses_key().rsplit(':').next().unwrap().to_string();
    let (a, b) = (room.slip(&alice, 5), room.slip(&bob, 5));
    let c = room.close(&alice, 5, &sid, &[("alice", &a), ("bob", &b)], Some(&room.commit(5)));
    room.reveal(&alice, 5);
    room.reveal(&bob, 5);
    room.tick(200);
    assert_eq!(strs(&room.records("h:5:")[0].1, "x"), vec![c]);
}

#[test]
fn its_update_reaches_a_page_as_plain_records() {
    let mut room = Room::new("wire", true);
    let page = Doc::new();
    {
        let mut txn = page.transact_mut();
        let state = room.doc.transact().encode_diff_v1(&yrs::StateVector::default());
        txn.apply_update(yrs::Update::decode_v1(&state).unwrap()).unwrap();
    }
    let out = room.tick(0);
    {
        let mut txn = page.transact_mut();
        txn.apply_update(yrs::Update::decode_v1(&out.update.unwrap()).unwrap()).unwrap();
    }
    let txn = page.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let Some(Out::YMap(ses)) = comp.get(&txn, &format!("ses:{T}:{INC}:g")) else { panic!() };
    let (key, value) = ses.iter(&txn).find(|(k, _)| k.starts_with("o:1:")).expect("the join reached the page");
    let Out::Any(Any::Map(m)) = value else { panic!("a plain object") };
    assert_eq!(m.get("r"), Some(&Any::Number(1.0)), "a number, not a bigint");
    assert!(key.ends_with(&hb::rec_hash(&CVal::from_any(&Any::Map(m.clone()))).unwrap()));
}

#[test]
fn grace_matches_the_pages() {
    assert_eq!(grace_of(0, &mut []), 4_000);
    assert_eq!(grace_of(0, &mut [3_500]), 5_000);
    assert_eq!(grace_of(0, &mut [3_500, 4_900, 6_000]), 7_500);
    assert_eq!(grace_of(0, &mut [4_100]), 4_000, "after the grace: stretches nothing");
    assert_eq!(grace_of(0, &mut [3_900, 5_300, 6_700, 8_100, 9_500]), 10_000);
}

#[test]
fn keys_parse_as_the_fold_parses_them() {
    let h = "0123456789abcdef0123456789abcdef";
    assert_eq!(parse_key(&format!("c:12:{h}")), Some(('c', 12, None, h)));
    assert_eq!(parse_key(&format!("s:3:a:b:{h}")), Some(('s', 3, Some("a:b"), h)));
    for bad in [format!("c:0:{h}"), format!("c:01:{h}"), format!("c:1:x:{h}"), format!("s:1:{h}"), format!("q:1:{h}"), format!("c:1:{}", &h[1..])] {
        assert_eq!(parse_key(&bad), None, "{bad}");
    }
}

#[test]
fn closes_signed_over_a_slip_the_pages_refuse_are_never_revealed() {
    let mallory = who("mallory");
    // The signer's slip: no chips; bets no table takes; mallory's, its
    // signature forged. (One under another's key is the pages' to flag: the
    // fold takes a close as its signer signed it.)
    let cases: Vec<(&str, Box<dyn Fn(&Room) -> (String, Who)>)> = vec![
        ("empty", Box::new(|room: &Room| (room.slip_on(&who("mallory"), 1, CVal::Arr(vec![])), who("mallory")))),
        ("junk bets", Box::new(|room: &Room| (room.slip_on(&who("mallory"), 1, CVal::Arr(vec![obj(vec![("type", s("purple")), ("amount", CVal::Int(5))])])), who("mallory")))),
        ("forged signature", Box::new(|room: &Room| {
            let m = who("mallory");
            let c = hb::slip_commit(&ctx(), 1, "mallory", &seed_of("mallory", 1));
            let body = obj(vec![("r", CVal::Int(1)), ("p", s("mallory")), ("v", CVal::Int(1)), ("b", CVal::Arr(vec![obj(vec![("type", s("red")), ("amount", CVal::Int(5))])])), ("c", s(&c))]);
            let rec = with(&signed("slip", &m, body), "g", s(&"A".repeat(86)));
            room.put('s', &rec);
            (hb::rec_hash(&rec).unwrap(), m)
        })),
    ];
    for (name, slip) in cases {
        let mut room = Room::new(&format!("signer-{}", name.replace(' ', "-").replace('\'', "")), true);
        let (alice, bob) = (who("alice"), who("bob"));
        room.tick(0);
        let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
        let (m, signer) = slip(&room);
        room.close(&signer, 1, "g", &[("alice", &a), ("bob", &b), ("mallory", &m)], Some(&room.commit(1)));
        room.reveal(&alice, 1);
        room.reveal(&bob, 1);
        room.reveal(&mallory, 1);
        for _ in 0..20 {
            room.tick(1_000);
        }
        assert!(room.records("h:").is_empty(), "{name}");
        // The round's real close is revealed when it comes.
        let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
        room.tick(200);
        assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c], "{name}");
    }
}

#[test]
fn a_deleted_reveal_is_put_back_after_a_restart_and_its_line_holds() {
    let mut room = Room::new("deleted", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c1, _, b) = room.closed_on_the_join(&alice, &bob);
    let c1b = room.close(&bob, 1, "g", &[("bob", &b)], Some(&room.commit(1)));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    let (key, h) = room.records("h:1:")[0].clone();
    let picked = strs(&h, "x")[0].clone();
    let other = if picked == c1 { c1b } else { c1 };
    let state: serde_json::Value = serde_json::from_slice(&std::fs::read(room.dir.join(STATE_FILE)).unwrap()).unwrap();
    assert_eq!(state["v"], 3);
    let ses = room.ses_key();
    assert_eq!(state["done"][0], serde_json::json!([ROOM, T, INC, 1, 1, picked, true, [[ses, key, hb::canon(&h)]]]));
    // A peer deletes the reveal; the node restarts, and puts it back from
    // its state file as it would have during the run.
    room.delete(&key);
    room.house = House::open(&NODE, Some(room.dir.join(STATE_FILE))).unwrap();
    room.house.settle_ms = 0;
    room.tick(0);
    room.tick(REPUT_MS);
    let back: Vec<_> = room.records("h:1:").into_iter().map(|(k, v)| (k, hb::canon(&v))).collect();
    assert_eq!(back, vec![(key, hb::canon(&h))]);
    // Round 2 asks for the commitment it carried: no join, and a close on
    // the close it passed over is never revealed.
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &other, &[("alice", &a2), ("bob", &b2)], Some(&room.commit(2)));
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    for _ in 0..20 {
        room.tick(1_000);
    }
    assert!(room.records("h:2:").is_empty());
    assert!(room.records("o:2:").is_empty(), "no join of a round its reveal carried");
    let d = room.close(&bob, 2, &picked, &[("alice", &a2), ("bob", &b2)], Some(&room.commit(2)));
    room.tick(200);
    assert_eq!(strs(&room.records("h:2:")[0].1, "x"), vec![d]);
}

#[test]
fn older_state_files_read_as_what_they_held() {
    let dir = scratch("state-old");
    let path = dir.join(STATE_FILE);
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!({ "v": 1, "done": [[ROOM, T, INC, 4]] })).unwrap()).unwrap();
    let house = House::open(&NODE, Some(path.clone())).unwrap();
    assert_eq!(house.last_of(&ctx()), Some(&Done { r: 4, d: None, c: false, kept: vec![] }), "v 1: nothing to carry on");
    let x = "0123456789abcdef0123456789abcdef";
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!({ "v": 2, "done": [[ROOM, T, INC, 4, x, true]] })).unwrap()).unwrap();
    let house = House::open(&NODE, Some(path.clone())).unwrap();
    assert_eq!(house.last_of(&ctx()), Some(&Done { r: 4, d: Some((4, x.to_string())), c: true, kept: vec![] }), "v 2: its round's close");
    // A kept record whose key isn't its own hash: unreadable (the house stays off).
    let rec = obj(vec![("r", CVal::Int(4)), ("s", s(&"0".repeat(64)))]);
    let bad = serde_json::json!({ "v": 3, "done": [[ROOM, T, INC, 4, 4, x, true, [[format!("ses:{T}:{INC}:g"), format!("h:4:{x}"), hb::canon(&rec)]]]] });
    std::fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(House::open(&NODE, Some(path)).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn junk_under_the_key_of_its_reveal_is_put_back_over() {
    let mut room = Room::new("junk-key", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    let (key, rec) = room.records("h:1:")[0].clone();
    room.put_raw(&key, &obj(vec![("r", CVal::Int(1)), ("s", s("junk"))]));
    room.tick(REPUT_MS);
    let back = room.records("h:1:");
    assert_eq!(back.len(), 1);
    assert_eq!(hb::canon(&back[0].1), hb::canon(&rec));
}

#[test]
fn felts_read_as_the_fold_reads_them() {
    // test-vectors/computed-house-v1.json `felts`: each with whether the
    // fold (asSlipFor) takes a slip holding it.
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors/computed-house-v1.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let cases = v["felts"].as_array().unwrap();
    assert!(cases.len() >= 60);
    for case in cases {
        let craps = case["game"] == "craps";
        let b = CVal::from_json(&case["b"]);
        let ok = b.as_arr().is_some_and(|b| felt_ok(craps, b));
        assert_eq!(ok, case["ok"].as_bool().unwrap(), "{case}");
    }
    // The caps on a felt's length (computedFold MAX_SLIP_BETS, computedCraps
    // MAX_CRAPS_SPOTS: every spot once is 49 of them).
    let red = obj(vec![("type", s("red")), ("amount", CVal::Int(1))]);
    assert!(felt_ok(false, &vec![red.clone(); MAX_SLIP_BETS]));
    assert!(!felt_ok(false, &vec![red; MAX_SLIP_BETS + 1]));
    let mut spots: Vec<CVal> = Vec::new();
    for t in CRAPS_BETS {
        let picks: Vec<Option<i64>> = match *t {
            "place" | "comeodds" | "dontcomeodds" => POINT_NUMBERS.iter().map(|p| Some(*p)).collect(),
            "hard" => HARD_NUMBERS.iter().map(|p| Some(*p)).collect(),
            "come" | "dontcome" => std::iter::once(None).chain(POINT_NUMBERS.iter().map(|p| Some(*p))).collect(),
            _ => vec![None],
        };
        for p in picks {
            let mut fields = vec![("type", s(t)), ("amount", CVal::Int(1))];
            if let Some(p) = p {
                fields.push(("pick", CVal::Int(p)));
            }
            spots.push(obj(fields));
        }
    }
    let spot = |e: &CVal| format!("{}:{}", str_of(e, "type").unwrap(), e.get("pick").and_then(CVal::as_int).map(|p| p.to_string()).unwrap_or_default());
    spots.sort_by_key(spot);
    assert_eq!(spots.len(), MAX_CRAPS_SPOTS);
    assert!(felt_ok(true, &spots));
}

/// Round 1 on the house's join, alice's close and bob's rival, every seed
/// in, revealed: (the close it picked, the other, alice's slip, bob's).
fn revealed_with_a_rival(room: &mut Room, alice: &Who, bob: &Who) -> (String, String) {
    let (c1, _, b) = room.closed_on_the_join(alice, bob);
    let c1b = room.close(bob, 1, "g", &[("bob", &b)], Some(&room.commit(1)));
    room.reveal(alice, 1);
    room.reveal(bob, 1);
    room.tick(200);
    let picked = strs(&room.records("h:1:")[0].1, "x")[0].clone();
    let other = if picked == c1 { c1b } else { c1 };
    (picked, other)
}

#[test]
fn a_step_down_a_deleted_reveal_and_a_restart_never_carry_on_the_rival_line() {
    let mut room = Room::new("down-deleted", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (picked, other) = revealed_with_a_rival(&mut room, &alice, &bob);
    let key = room.records("h:1:")[0].0.clone();
    // The rival voided; the owner sets the table Friendly: a step-down at 2.
    room.abandon(&bob, 1, &other);
    room.set_fair(1, 1);
    room.tick(200);
    assert!(strs(&room.records("h:2:")[0].1, "x").is_empty(), "a step-down");
    // Round 2 played Friendly on the voided rival.
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &other, &[("alice", &a2), ("bob", &b2)], None);
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    // A peer keeps deleting the round-1 reveal; the node restarts; Fair again.
    room.house = House::open(&NODE, Some(room.dir.join(STATE_FILE))).unwrap();
    room.house.settle_ms = 0;
    room.set_fair(0, 2);
    for _ in 0..20 {
        room.delete(&key);
        room.tick(1_000);
    }
    assert!(room.records("o:3:").is_empty(), "no join on top of the rival line");
    // Its reveal back, round 2 played on the close it decided: it joins 3.
    room.tick(REPUT_MS);
    assert_eq!(room.records("h:1:").len(), 1);
    room.close(&bob, 2, &picked, &[("alice", &a2), ("bob", &b2)], None);
    room.tick(200);
    assert_eq!(room.records("o:3:").len(), 1);
}

#[test]
fn a_close_the_fold_throws_out_neither_refuses_a_round_nor_is_revealed() {
    let mut room = Room::new("ineligible", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.tick(0);
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    // Beside the round's close: one naming a commitment no house wrote, and
    // one on a parent that isn't the session.
    let junk = "ab".repeat(32);
    room.close(&bob, 1, "g", &[("alice", &a), ("bob", &b)], Some(&junk));
    room.close(&bob, 1, &"cd".repeat(16), &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    let h = room.records("h:1:");
    assert_eq!(h.len(), 1, "the round isn't refused");
    assert_eq!(strs(&h[0].1, "x"), vec![c]);
}

#[test]
fn a_close_on_a_round_nothing_decided_is_never_revealed() {
    let mut room = Room::new("undecided", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c1, _, _) = room.closed_on_the_join(&alice, &bob);
    // Round 1 waits on bob's seed; a close of round 2 on it, naming the
    // commitment round 1's reveal will carry, comes first.
    room.reveal(&alice, 1);
    room.tick(200);
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &c1, &[("alice", &a2), ("bob", &b2)], Some(&room.commit(2)));
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    room.tick(200);
    assert!(room.records("h:").is_empty(), "nothing yet: round 1 is undecided");
}

/// A second node of the owner's, delegated as the first.
fn second_house(room: &Room) -> House {
    let mut other = House::open(&[9u8; 32], None).unwrap();
    other.settle_ms = 0;
    let rec = room_signed("hkey", "", &room.owner, obj(vec![("v", CVal::Int(1)), ("h", s(other.public()))]));
    room.put_top(&format!("hk:{}", other.public()), &rec);
    other
}

fn tick_both(room: &mut Room, other: &mut House, after: u64) {
    room.tick(after);
    other.tick(ROOM, &room.doc, room.now, 1_700_000_000_000 + room.now);
}

#[test]
fn a_second_house_carries_on_the_line_the_first_decided_and_nothing_else() {
    let mut room = Room::new("two-houses", true);
    let mut b_house = second_house(&room);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c1, _, b) = room.closed_on_the_join(&alice, &bob);
    let c1b = room.close(&bob, 1, "g", &[("bob", &b)], Some(&room.commit(1)));
    // The first stops: it reveals round 1 carrying nothing on.
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.house.begin_step_down();
    tick_both(&mut room, &mut b_house, 200);
    let h = &room.records("h:1:")[0].1;
    assert!(h.get("c").is_none());
    let picked = strs(h, "x")[0].clone();
    let other = if picked == c1 { c1b } else { c1 };
    // The second joins round 2 (it asks for nothing now).
    room.abandon(&bob, 1, &other);
    tick_both(&mut room, &mut b_house, 200);
    let joins = room.records("o:2:");
    assert_eq!(joins.len(), 1);
    let b_commit = str_of(&joins[0].1, "c").unwrap().to_string();
    assert_eq!(str_of(&joins[0].1, "k"), Some(b_house.public()));
    // A close on the voided rival naming the second's commitment (on the
    // pages it would carry the rival's line past the first's decision):
    // never revealed.
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &other, &[("alice", &a2), ("bob", &b2)], Some(&b_commit));
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    for _ in 0..20 {
        tick_both(&mut room, &mut b_house, 1_000);
    }
    assert!(room.records("h:2:").is_empty());
    // On the close the first decided: the second reveals it.
    let d = room.close(&bob, 2, &picked, &[("alice", &a2), ("bob", &b2)], Some(&b_commit));
    tick_both(&mut room, &mut b_house, 200);
    let h2 = room.records("h:2:");
    assert_eq!(h2.len(), 1);
    assert_eq!(strs(&h2[0].1, "x"), vec![d]);
    assert_eq!(str_of(&h2[0].1, "k"), Some(b_house.public()));
}

#[test]
fn a_second_house_joins_no_round_the_first_holds() {
    let mut room = Room::new("two-hold", true);
    let mut b_house = second_house(&room);
    let (alice, bob) = (who("alice"), who("bob"));
    tick_both(&mut room, &mut b_house, 0);
    let joins = room.records("o:1:");
    assert_eq!(joins.len(), 1, "one house to a round");
    assert_eq!(str_of(&joins[0].1, "k"), Some(room.house.public()));
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..5 {
        tick_both(&mut room, &mut b_house, 1_000);
    }
    assert!(room.records("h:1:")[0].1.get("c").is_some());
    assert!(room.records("o:").iter().all(|(k, _)| k.starts_with("o:1:")), "nor one the first's reveal carried");
    // The first stops, stepping its commitment down: round 2 is the second's.
    room.house.begin_step_down();
    tick_both(&mut room, &mut b_house, 200);
    assert!(strs(&room.records("h:2:")[0].1, "x").is_empty());
    tick_both(&mut room, &mut b_house, 200);
    let joins = room.records("o:2:");
    assert_eq!(joins.len(), 1);
    assert_eq!(str_of(&joins[0].1, "k"), Some(b_house.public()));
}

#[test]
fn of_two_houses_joining_a_round_only_the_one_the_pages_name_reveals() {
    let mut room = Room::new("two-joins", true);
    let mut b_house = second_house(&room);
    let (alice, bob) = (who("alice"), who("bob"));
    room.tick(0);
    // Both joined round 1, neither seeing the other's yet.
    let b_join = b_house.signed(
        "hcommit",
        &ctx(),
        vec![("r".into(), CVal::Int(1)), ("c".into(), CVal::Str(b_house.commit(&ctx(), 1))), ("k".into(), CVal::Str(b_house.public().to_string()))],
    );
    room.put('o', &b_join);
    let joins = room.records("o:1:");
    assert_eq!(joins.len(), 2);
    let lowest = str_of(&joins[0].1, "k").unwrap().to_string();
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    let ca = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    let cb = room.close(&bob, 1, "g", &[("alice", &a), ("bob", &b)], Some(&b_house.commit(&ctx(), 1)));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..20 {
        tick_both(&mut room, &mut b_house, 1_000);
    }
    let h = room.records("h:1:");
    assert_eq!(h.len(), 1, "one reveal: no second outcome to choose");
    assert_eq!(str_of(&h[0].1, "k"), Some(lowest.as_str()));
    let named = if lowest == room.house.public() { ca } else { cb };
    assert_eq!(strs(&h[0].1, "x"), vec![named]);
}

#[test]
fn a_close_naming_nothing_where_its_round_asks_for_a_commitment_takes_the_table_nowhere() {
    let mut room = Room::new("names-nothing", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (picked, _) = revealed_with_a_rival(&mut room, &alice, &bob);
    // Round 2 asks for the commitment round 1's reveal carried: a Friendly
    // close is no close of it, its seeds all in or not.
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &picked, &[("alice", &a2), ("bob", &b2)], None);
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    for _ in 0..10 {
        room.tick(1_000);
    }
    assert!(room.records("o:3:").is_empty(), "no join of a round the table hasn't reached");
}

#[test]
fn a_close_on_an_undecided_close_is_on_no_chain_beside_a_decided_one() {
    let mut room = Room::new("undecided-parent", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.set_fair(1, 1);
    room.tick(0);
    // Friendly round 1: alice's close decided, bob's waiting on his seed;
    // round 2 played on bob's.
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    room.close(&alice, 1, "g", &[("alice", &a)], None);
    let c1b = room.close(&bob, 1, "g", &[("bob", &b)], None);
    room.reveal(&alice, 1);
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    room.close(&alice, 2, &c1b, &[("alice", &a2), ("bob", &b2)], None);
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    // Fair again: the table is at round 2.
    room.set_fair(0, 2);
    room.tick(200);
    assert_eq!(room.records("o:2:").len(), 1);
    assert!(room.records("o:3:").is_empty());
}
