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
        let cp = top_value_within(&comp, &txn, &format!("sum:{T}:{INC}"), usize::MAX);
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

    fn delete_top(&self, key: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.remove(&mut txn, key);
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

    /// A tick of `passes` passes at most.
    fn tick_passes(&mut self, after: u64, passes: usize) -> TickOut {
        self.now += after;
        self.house.tick_with(ROOM, &self.doc, self.now, 1_700_000_000_000 + self.now, VERIFY_PER_TICK, passes)
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
        top_value_within(&txn.get_map(COMPUTED_MAP).unwrap(), &txn, key, usize::MAX)
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
fn of_two_settings_with_one_number_the_higher_hash_stands_whichever_came_first() {
    let sign = |room: &Room, m: i64| room_signed("hfair", T, &room.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(m)), ("s", CVal::Int(7))]));
    for hi_first in [false, true] {
        let mut room = Room::new(if hi_first { "tie-hi" } else { "tie-lo" }, true);
        let (mut lo, mut hi) = (sign(&room, 0), sign(&room, 1));
        if hb::rec_hash(&lo) > hb::rec_hash(&hi) {
            std::mem::swap(&mut lo, &mut hi);
        }
        let (first, then) = if hi_first { (&hi, &lo) } else { (&lo, &hi) };
        room.put_top(&format!("hf:{T}"), first);
        room.tick(0);
        room.put_top(&format!("hf:{T}"), then);
        room.tick(REPUT_MS);
        // It reads the higher one, and that is the one in the doc after it.
        assert_eq!(room.house.rooms[ROOM].fair.get(T).and_then(hb::canon), hb::canon(&hi), "hi first: {hi_first}");
        assert_eq!(room.top(&format!("hf:{T}")).and_then(|v| hb::canon(&v)), hb::canon(&hi), "hi first: {hi_first}");
    }
}

#[test]
fn a_signature_verdict_holds_only_where_it_was_given() {
    let mut room = Room::new("scope", true);
    room.set_fair(1, 1);
    let rec = room.top(&format!("hf:{T}")).unwrap();
    let (hash, g) = (hb::rec_hash(&rec).unwrap(), str_of(&rec, "g").unwrap().to_string());
    let k = room.owner.public.clone();
    // (Asked for, checked as between a tick's passes, then known.)
    let mut verdict = |at: [&str; 3]| {
        let house = &mut room.house;
        house.budget = VERIFY_PER_TICK;
        let bytes = hb::room_sign_bytes("hfair", at[0], at[1], &rec);
        if house.verified("hfair", at, &hash, &k, bytes, &g).is_none() {
            house.check_wanted();
        }
        house.verified("hfair", at, &hash, &k, bytes, &g)
    };
    assert_eq!(verdict([ROOM, T, ""]), Some(true));
    // The same record copied to another table, or another room.
    assert_eq!(verdict([ROOM, "roulette-2", ""]), Some(false));
    assert_eq!(verdict(["room-2", T, ""]), Some(false));
    assert_eq!(verdict([ROOM, T, ""]), Some(true));
}

/// 600 bettors' closes, each over a slip whose signature is forged: a
/// signature check apiece.
fn flood(room: &Room) {
    flood_as(room, "junk");
}

fn flood_as(room: &Room, names: &str) {
    let sid = room.ses_key().rsplit(':').next().unwrap().to_string();
    for i in 0..600 {
        let w = who(&format!("{names}{i}"));
        let c = hb::slip_commit(&ctx(), 1, &w.pid, &seed_of(&w.pid, 1));
        let felt = CVal::Arr(vec![obj(vec![("type", s("red")), ("amount", CVal::Int(5))])]);
        let body = obj(vec![("r", CVal::Int(1)), ("p", s(&w.pid)), ("v", CVal::Int(1)), ("b", felt), ("c", s(&c)), ("k", s(&w.public)), ("g", s(&"A".repeat(86)))]);
        room.put('s', &body);
        let sh = hb::rec_hash(&body).unwrap();
        room.close(&w, 1, &sid, &[(w.pid.as_str(), sh.as_str())], None);
    }
}

#[test]
fn a_flood_of_forged_records_is_checked_a_budget_a_tick_and_the_house_acts_once_through() {
    let mut room = Room::new("flood", true);
    flood(&room);
    // The delegation and 255 slips this tick: the table waits.
    room.tick(0);
    assert_eq!(room.house.verdicts.len(), VERIFY_PER_TICK);
    assert!(room.records("o:").is_empty());
    room.tick(TICK_MS);
    assert_eq!(room.house.verdicts.len(), 2 * VERIFY_PER_TICK);
    assert!(room.records("o:").is_empty());
    // 601 in all: through at the third, and it joins round 1 (no close counts).
    room.tick(TICK_MS);
    assert_eq!(room.house.verdicts.len(), 601);
    assert_eq!(room.records("o:1:").len(), 1);
    // Its own join read back, and nothing checked again.
    room.tick(TICK_MS);
    assert_eq!(room.house.verdicts.len(), 602);
    room.tick(TICK_MS);
    assert_eq!(room.house.verdicts.len(), 602);
}

#[test]
fn a_flood_at_one_table_holds_another_back_a_tick_at_most() {
    let mut room = Room::new("flood-turn", true);
    // A second table, its session holding a "join" under the house's key it
    // did not sign: a check before the house may act there.
    const T2: &str = "roulette-2";
    const INC2: &str = "r89abcdef0123456789abcdef";
    let ctx2 = Ctx { room: ROOM.into(), t: T2.into(), inc: INC2.into() };
    let ses2 = format!("ses:{T2}:{INC2}:{}", hb::next_sid(&ctx2, None).unwrap());
    let fake = with(&obj(vec![("r", CVal::Int(1)), ("c", s(&"0".repeat(64))), ("k", s(room.house.public()))]), "g", s(&"A".repeat(86)));
    {
        let mut txn = room.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        casino.insert(&mut txn, format!("cfg:computed:{T2}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC2))])));
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        let m = comp.insert(&mut txn, ses2.as_str(), MapPrelim::default());
        m.insert(&mut txn, format!("o:1:{}", hb::rec_hash(&fake).unwrap()), to_any(&fake));
    }
    let joins2 = |room: &Room| {
        let txn = room.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses2) else { panic!("no session") };
        m.keys(&txn).filter(|k| k.starts_with("o:1:")).count()
    };
    // Floods at the first table, tick after tick.
    flood_as(&room, "junk-a");
    room.tick(0);
    assert_eq!(joins2(&room), 1, "only the fake");
    flood_as(&room, "junk-b");
    room.tick(TICK_MS);
    assert_eq!(joins2(&room), 2, "its own join at the second table, the flood going on at the first");
    assert!(room.records("o:").is_empty());
}

#[test]
fn stepping_down_checks_all_it_must_in_its_last_word() {
    let mut room = Room::new("flood-stop", true);
    room.tick(0);
    assert_eq!(room.records("o:1:").len(), 1);
    flood(&room);
    room.house.begin_step_down();
    // A tick's budget is short of the flood: nothing yet.
    assert!(room.tick(200).short);
    assert!(room.records("h:1:").is_empty());
    let out = room.house.tick_unbounded(ROOM, &room.doc, room.now, 0);
    assert!(!out.short);
    // Its join of round 1 stepped down: a reveal listing no close.
    let d = &room.records("h:1:")[0].1;
    assert!(strs(d, "x").is_empty());
    // The delegation, its own join and the 600 slips.
    assert_eq!(room.house.verdicts.len(), 602);
}

/// A pid as long as the pages take one (256 UTF-16 units), of 3-byte
/// characters, ending in `i`'s digits.
fn long_pid(i: usize) -> String {
    let tail = format!("{i}");
    "€".repeat(256 - tail.len()) + &tail
}

#[test]
fn the_heaviest_records_the_pages_take_weigh_well_under_what_a_read_allows() {
    let w = |v: &CVal| hb::weight(&to_any(v), usize::MAX).unwrap();
    let big = CVal::Int(MAX_SAFE);
    let (hex32, hex64) = (s(&"f".repeat(32)), s(&"f".repeat(64)));
    let (k, g) = (s(&"A".repeat(43)), s(&"A".repeat(86)));
    let pids: Vec<String> = (0..MAX_FROZEN).map(long_pid).collect();
    let bets = CVal::Arr(
        (0..400).map(|_| obj(vec![("type", s("straight")), ("amount", CVal::Int(1_000_000_000)), ("pick", CVal::Int(36))])).collect(),
    );
    let slip = obj(vec![("r", big.clone()), ("p", s(&pids[0])), ("v", big.clone()), ("b", bets), ("c", hex64.clone()), ("k", k.clone()), ("g", g.clone())]);
    assert!(felt_ok(false, slip.get("b").and_then(CVal::as_arr).unwrap()));
    let close = obj(vec![
        ("r", big.clone()),
        ("q", hex32.clone()),
        ("f", CVal::Obj(pids.iter().map(|p| (p.clone(), hex32.clone())).collect())),
        ("h", hex64.clone()),
        ("k", k.clone()),
        ("g", g.clone()),
    ]);
    let forfeit = obj(vec![("r", big.clone()), ("x", hex32.clone()), ("n", CVal::Arr(pids.iter().map(|p| s(p)).collect())), ("k", k.clone()), ("g", g.clone())]);
    let reveal = obj(vec![
        ("r", big.clone()),
        ("s", hex64.clone()),
        ("x", CVal::Arr(vec![hex32.clone(); MAX_CLOSES_PER_ROUND])),
        ("n", CVal::Arr(vec![hex32.clone(); MAX_HOUSE_COUNTED])),
        ("c", hex64.clone()),
        ("k", k.clone()),
        ("g", g.clone()),
    ]);
    for (name, rec) in [("slip", &slip), ("close", &close), ("forfeit", &forfeit), ("house reveal", &reveal)] {
        assert!(w(rec) * 2 <= MAX_RECORD_BYTES, "{name} weighs {}", w(rec));
    }
    // A delegation, a setting, a heartbeat and a switch, far under theirs.
    let small = [
        obj(vec![("v", CVal::Int(1)), ("h", k.clone()), ("k", k.clone()), ("g", g.clone())]),
        obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(1)), ("s", big.clone()), ("k", k.clone()), ("g", g.clone())]),
        obj(vec![("v", CVal::Int(1)), ("n", big.clone()), ("k", k.clone()), ("g", g.clone())]),
        obj(vec![("v", CVal::Int(1)), ("inc", s(INC))]),
    ];
    for rec in &small {
        assert!(w(rec) * 8 <= MAX_TOP_BYTES);
    }
    // A checkpoint of as many bettors as the pages keep, each net 40 digits:
    // one tick reads it.
    let nets = CVal::Obj((0..4_096).map(|i| (long_pid(i), s(&"9".repeat(40)))).collect());
    let cp = obj(vec![("v", CVal::Int(1)), ("b", hex32.clone()), ("u", big.clone()), ("l", hex32.clone()), ("n", nets), ("h", hex64.clone()), ("k", k), ("g", g)]);
    assert!(checkpoint_ok(&with(&cp, "b", s(&"f".repeat(24))), INC));
    assert!(w(&cp) < READ_PER_TICK, "a full checkpoint weighs {}", w(&cp));
}

#[test]
fn weighing_a_value_stops_at_its_cap_and_its_depth() {
    let any = |v: &CVal| to_any(v);
    assert_eq!(hb::weight(&any(&s("abc")), 100), Some(5));
    assert_eq!(hb::weight(&any(&obj(vec![("ab", CVal::Int(1))])), 100), Some(2 + 6 + 8));
    assert_eq!(hb::weight(&any(&CVal::Arr(vec![CVal::Int(1), CVal::Int(2)])), 100), Some(2 + 2 * 9));
    assert_eq!(hb::weight(&any(&s(&"x".repeat(98))), 100), Some(100));
    assert_eq!(hb::weight(&any(&s(&"x".repeat(99))), 100), None);
    // A long array: found heavy on its first members.
    let long = Any::Array(Arc::from(vec![Any::Number(1.0); 1_000_000]));
    assert_eq!(hb::weight(&long, 1_000), None);
    // Nesting past MAX_DEPTH, however light.
    let mut deep = Any::Number(1.0);
    for _ in 0..hb::MAX_DEPTH {
        deep = Any::Array(Arc::from(vec![deep]));
    }
    assert!(hb::weight(&deep, usize::MAX).is_some());
    let deeper = Any::Array(Arc::from(vec![deep]));
    assert_eq!(hb::weight(&deeper, usize::MAX), None);
    assert_eq!(hb::weigh(&deeper, usize::MAX), hb::Weighed::Heavy);
}

/// Padding a page reads past (an undefined field; a field a typed-array
/// prototype keeps out) weighs toward the cap like anything, so no value
/// costs more than the cap to weigh; but past it, a value holding any is
/// `Unsure` (a page may read it light), and only one past it by what a page
/// reads of it alone is `Heavy` (junk on every page).
#[test]
fn padding_a_page_reads_past_never_makes_a_record_heavy() {
    let map = |fields: Vec<(String, Any)>| Any::Map(Arc::new(fields.into_iter().collect::<HashMap<_, _>>()));
    let cap = 1_000;
    // An undefined field with a long name, or many: past the cap, Unsure.
    let long_name = map(vec![("r".into(), Any::Number(1.0)), ("x".repeat(cap), Any::Undefined)]);
    assert_eq!(hb::weigh(&long_name, cap), hb::Weighed::Unsure);
    let many = map((0..cap).map(|i| (format!("u{i}"), Any::Undefined)).collect());
    assert_eq!(hb::weigh(&many, cap), hb::Weighed::Unsure);
    // Inside a map inside the record too.
    let inner = map(vec![("n".into(), many.clone())]);
    assert_eq!(hb::weigh(&inner, cap), hb::Weighed::Unsure);
    // Under the cap: light, and every page reads it as the node does.
    let light = map(vec![("r".into(), Any::Number(1.0)), ("u".into(), Any::Undefined)]);
    assert_eq!(hb::weigh(&light, cap), hb::Weighed::Light { w: 2 + 5 + 8 + 5 + 8, scan: 0 });
    assert_eq!(hb::clarity(&light), hb::Clarity::Clear);
    // Past it by a field a page reads: Heavy, padding or none.
    let heavy = map(vec![("s".into(), Any::String(Arc::from("x".repeat(cap))))]);
    assert_eq!(hb::weigh(&heavy, cap), hb::Weighed::Heavy);
    let padded_heavy = map(vec![("s".into(), Any::String(Arc::from("x".repeat(cap)))), ("u".into(), Any::Undefined)]);
    assert_eq!(hb::weigh(&padded_heavy, cap), hb::Weighed::Heavy);
    let long = Any::Array(Arc::from(vec![Any::Number(1.0); 1_000_000]));
    assert_eq!(hb::weigh(&long, cap), hb::Weighed::Heavy);
    // A typed-array key beside a `__proto__` field: its value unread,
    // however big, and the map Unknown (junk to read: no page may agree).
    let big = Any::String(Arc::from("x".repeat(100 * cap)));
    let typed = map(vec![("r".into(), Any::Number(1.0)), ("77777".into(), big.clone()), ("__proto__".into(), Any::Null)]);
    assert_eq!(hb::weigh(&typed, cap), hb::Weighed::Light { w: 2 + 5 + 8 + 9 + 8 + 13 + 8, scan: 0 });
    assert_eq!(hb::clarity(&typed), hb::Clarity::Unknown);
    assert_eq!(CVal::from_any(&typed), CVal::Junk);
    // The same key without a `__proto__` field is a field like any.
    let plain = map(vec![("r".into(), Any::Number(1.0)), ("77777".into(), big)]);
    assert_eq!(hb::weigh(&plain, cap), hb::Weighed::Heavy);
}

/// `n` records under slip keys of round 1 in table `ses`'s session, each
/// junk (its key not its hash) weighing about `bytes`.
fn junk_in(room: &Room, ses: &str, n: usize, bytes: usize) {
    let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
    let mut txn = room.doc.transact_mut();
    let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
    let filler = "j".repeat(bytes);
    for i in 0..n {
        m.insert(&mut txn, format!("s:1:junk{i}:{i:032x}"), to_any(&obj(vec![("r", CVal::Int(1)), ("x", s(&filler))])));
    }
}

/// A second house table, T2, switched on: its session's key.
fn second_table(room: &Room) -> String {
    const T2: &str = "roulette-2";
    const INC2: &str = "r89abcdef0123456789abcdef";
    let ctx2 = Ctx { room: ROOM.into(), t: T2.into(), inc: INC2.into() };
    let ses2 = format!("ses:{T2}:{INC2}:{}", hb::next_sid(&ctx2, None).unwrap());
    let mut txn = room.doc.transact_mut();
    let casino = txn.get_or_insert_map(CASINO_MAP);
    casino.insert(&mut txn, format!("cfg:computed:{T2}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC2))])));
    let comp = txn.get_or_insert_map(COMPUTED_MAP);
    comp.insert(&mut txn, ses2.as_str(), MapPrelim::default());
    ses2
}

fn joins_in(room: &Room, ses: &str) -> usize {
    let txn = room.doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session") };
    m.keys(&txn).filter(|k| k.starts_with("o:1:")).count()
}

#[test]
fn a_record_heavier_than_any_the_pages_take_is_junk_and_costs_a_tick_no_more_than_its_cap() {
    let mut room = Room::new("heavy-junk", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    // 50 MB under a slip key, and a million numbers under another.
    room.put_raw(&format!("s:1:alice:{}", "e".repeat(32)), &obj(vec![("r", CVal::Int(1)), ("x", s(&"b".repeat(50 << 20)))]));
    let numbers = Any::Map(Arc::new(HashMap::from([
        ("r".to_string(), Any::Number(1.0)),
        ("x".to_string(), Any::Array(Arc::from(vec![Any::Number(1.0); 1_000_000]))),
    ])));
    {
        let ses = room.ses_key();
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
        m.insert(&mut txn, format!("s:1:bob:{}", "d".repeat(32)), numbers);
    }
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    let out = room.tick(200);
    assert!(!out.short, "the table read whole");
    // (Each pass of the tick read them: two caps a pass, and the rest.)
    let read = READ_PER_TICK - room.house.read_left;
    assert!(read < MAX_PASSES * 3 * MAX_RECORD_BYTES, "read {read}");
    // And the round revealed as ever.
    let rev = &room.records("h:1:")[0].1;
    assert_eq!(strs(rev, "x"), vec![c]);
}

#[test]
fn junk_past_a_ticks_reads_waits_at_its_table_holding_the_room_no_longer_and_the_others_have_their_turns() {
    let mut room = Room::new("junk-turns", true);
    let ses2 = second_table(&room);
    // ~6 MB of junk at the first table: more than a tick reads.
    let ses = room.ses_key();
    junk_in(&room, &ses, 100, 60_000);
    let first = room.tick(0);
    assert!(first.short);
    assert!(room.house.read_out);
    assert!(room.records("o:").is_empty(), "nothing at the junk table");
    // The second table has its turn by the next tick, the junk going on.
    if joins_in(&room, &ses2) == 0 {
        assert!(room.tick(TICK_MS).short);
    }
    assert_eq!(joins_in(&room, &ses2), 1);
    assert!(room.records("o:").is_empty());
    // The step-down's last word reads it all.
    assert!(!room.house.tick_unbounded(ROOM, &room.doc, room.now, 0).short);
    // The junk gone (a trim): the first table joins again.
    room.house.stepping_down = false;
    for i in 0..100 {
        room.delete(&format!("s:1:junk{i}:{i:032x}"));
    }
    let out = room.tick(TICK_MS);
    assert!(!out.short);
    assert_eq!(room.records("o:1:").len(), 1);
}

#[test]
fn a_checkpoint_heavier_than_a_tick_reads_leaves_its_table_unread_not_on_another_session() {
    let mut room = Room::new("heavy-checkpoint", true);
    // As junk it would send the house to the first session ("g"), which a
    // checkpoint the pages took had trimmed.
    let first = format!("ses:{T}:{INC}:g");
    room.put_top(&format!("sum:{T}:{INC}"), &obj(vec![("v", CVal::Int(1)), ("x", s(&"c".repeat(READ_PER_TICK)))]));
    assert!(room.tick(0).short);
    assert!(room.tick(TICK_MS).short);
    assert_eq!(joins_in(&room, &first), 0);
    // Nested past what is weighed, even in the step-down's last word.
    let mut deep = Any::Number(1.0);
    for _ in 0..hb::MAX_DEPTH + 1 {
        deep = Any::Array(Arc::from(vec![deep]));
    }
    {
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        comp.insert(&mut txn, format!("sum:{T}:{INC}"), Any::Map(Arc::new(HashMap::from([("x".to_string(), deep)]))));
    }
    assert!(room.house.tick_unbounded(ROOM, &room.doc, room.now, 0).short);
    assert_eq!(joins_in(&room, &first), 0);
    // Gone: the house joins there.
    room.delete_top(&format!("sum:{T}:{INC}"));
    assert!(!room.tick(TICK_MS).short);
    assert_eq!(joins_in(&room, &first), 1);
}

#[test]
fn junk_switches_past_a_ticks_reads_leave_the_room_short_until_they_go() {
    let mut room = Room::new("junk-switches", true);
    let n = READ_PER_TICK / 64;
    {
        let mut txn = room.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        for i in 0..n {
            casino.insert(&mut txn, format!("cfg:computed:junk-{i}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC))])));
        }
    }
    assert!(room.tick(0).short);
    assert!(room.records("o:").is_empty());
    {
        let mut txn = room.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        for i in 0..n {
            casino.remove(&mut txn, &format!("cfg:computed:junk-{i}"));
        }
    }
    assert!(!room.tick(TICK_MS).short);
    assert_eq!(room.records("o:1:").len(), 1);
}

#[test]
fn records_no_table_names_are_never_checked() {
    let mut room = Room::new("unnamed", true);
    // Delegations of 300 keys and settings of 300 tables, every signature forged.
    for i in 0..300 {
        let j = who(&format!("junk{i}"));
        let deleg = obj(vec![("v", CVal::Int(1)), ("h", s(&j.public)), ("k", s(&room.owner.public)), ("g", s(&"A".repeat(86)))]);
        room.put_top(&format!("hk:{}", j.public), &deleg);
        let setting = obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(1)), ("s", CVal::Int(9)), ("k", s(&room.owner.public)), ("g", s(&"A".repeat(86)))]);
        room.put_top(&format!("hf:roulette-junk-{i}"), &setting);
    }
    room.tick(0);
    // Its own delegation alone, and it joins.
    assert_eq!(room.house.verdicts.len(), 1);
    assert_eq!(room.records("o:1:").len(), 1);
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


/// A second room of the owner's, `id`: its table switched on, `house`
/// delegated there (signed for that room), nothing else.
fn bare_room(id: &str, house: &House) -> Doc {
    let owner = who("owner");
    let body = obj(vec![("v", CVal::Int(1)), ("h", s(house.public())), ("k", s(&owner.public))]);
    let deleg = with(&body, "g", s(&sign(&owner, &hb::room_sign_bytes("hkey", id, "", &body).unwrap())));
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        let info = txn.get_or_insert_map("roomInfo");
        info.insert(&mut txn, "owner", Any::String(Arc::from("owner")));
        let players = txn.get_or_insert_map("players");
        players.insert(&mut txn, "owner", to_any(&obj(vec![("keyB64", s(&owner.public))])));
        let casino = txn.get_or_insert_map(CASINO_MAP);
        casino.insert(&mut txn, format!("cfg:computed:{T}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC))])));
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        comp.insert(&mut txn, format!("ses:{T}:{INC}:g"), MapPrelim::default());
        comp.insert(&mut txn, format!("hk:{}", house.public()), to_any(&deleg));
    }
    doc
}

/// Room `id`'s records of a kind in its live session (no checkpoint).
fn records_in(doc: &Doc, prefix: &str) -> Vec<CVal> {
    let txn = doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let Some(Out::YMap(m)) = comp.get(&txn, &format!("ses:{T}:{INC}:g")) else { return vec![] };
    m.iter(&txn)
        .filter(|(k, _)| k.starts_with(prefix))
        .filter_map(|(_, v)| match v {
            Out::Any(a) => Some(CVal::from_any(&a)),
            _ => None,
        })
        .collect()
}

/// The house in a lock, as the node holds it (main.rs HubState), and a
/// fresh one left in the test's room.
fn locked(room: &mut Room) -> Mutex<House> {
    let mut stand_in = House::open(&NODE, None).unwrap();
    stand_in.settle_ms = 0;
    Mutex::new(std::mem::replace(&mut room.house, stand_in))
}

/// 🏠 No signature is checked while the house holds the doc: a check waits
/// for the pass that asked for it to let the doc go, so a room's sync waits
/// on the house no longer than a read.
#[test]
fn no_signature_is_checked_while_the_house_holds_the_doc() {
    let mut room = Room::new("no-txn", true);
    let checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (doc, n) = (room.doc.clone(), checks.clone());
    room.house.on_check = Some(Box::new(move |_| {
        assert!(doc.try_transact_mut().is_ok(), "a check with the doc held");
        n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }));
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    // Two slips, then the close they sign, then the reveal: one tick.
    room.tick(200);
    assert_eq!(room.records("h:1:").len(), 1);
    flood(&room);
    room.tick(TICK_MS);
    assert!(checks.load(std::sync::atomic::Ordering::Relaxed) > VERIFY_PER_TICK);
}

/// 🏠 Stopping, a room flooded past a tick's budget has its last word after
/// every other room's step-down has gone out.
#[test]
fn stepping_down_steps_every_other_room_down_before_a_flooded_ones_last_word() {
    let mut room = Room::new("stop-rooms", true);
    room.tick(0);
    assert_eq!(room.records("o:1:").len(), 1);
    flood(&room);
    let house = locked(&mut room);
    let other = bare_room("room-2", &lock(&house));
    lock(&house).tick("room-2", &other, room.now, 0);
    assert_eq!(records_in(&other, "o:1:").len(), 1, "its join in room-2");
    let mut sent: Vec<(String, usize)> = Vec::new();
    let docs = vec![(ROOM.to_string(), room.doc.clone()), ("room-2".to_string(), other.clone())];
    step_down(&house, docs, room.now + TICK_MS, |r, _, n| sent.push((r, n)));
    assert_eq!(sent, [("room-2".to_string(), 1), (ROOM.to_string(), 1)]);
    assert!(strs(&records_in(&other, "h:1:")[0], "x").is_empty());
    assert!(strs(&room.records("h:1:")[0].1, "x").is_empty());
}

/// 🏠 A tick that panics is its room's alone: the house goes on in the other
/// rooms, and steps down there.
#[test]
fn a_tick_that_panics_in_one_room_holds_back_no_other_room_nor_the_step_down() {
    let mut room = Room::new("panic", true);
    room.tick(0);
    assert_eq!(room.records("o:1:").len(), 1);
    let house = locked(&mut room);
    let other = bare_room("room-2", &lock(&house));
    lock(&house).on_check = Some(Box::new(|r| assert_ne!(r, "room-2", "a bug in room-2")));
    assert_eq!(tick_room(&house, "room-2", &other, room.now, 0, false), TickOut::default());
    assert!(house.is_poisoned());
    // The other room ticks on.
    let (alice, bob) = (who("alice"), who("bob"));
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    assert_eq!(tick_room(&house, ROOM, &room.doc, room.now + TICK_MS, 0, false).wrote, 1);
    let h = &room.records("h:1:")[0].1;
    assert_eq!(strs(h, "x").len(), 1);
    // And steps down there, room-2's tick failing again.
    let mut sent = Vec::new();
    let docs = vec![("room-2".to_string(), other.clone()), (ROOM.to_string(), room.doc.clone())];
    step_down(&house, docs, room.now + 2 * TICK_MS, |r, _, _| sent.push(r));
    assert_eq!(sent, [ROOM]);
    assert!(strs(&room.records("h:2:")[0].1, "x").is_empty());
}

// ── PR 6n: what the house reads is what the pages read ───────────────────────

fn vectors() -> serde_json::Value {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors/computed-house-v1.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

/// A close as the house reads it (read_table's checks, the round aside:
/// the key's): computedFold asClose.
fn close_ok(v: &CVal) -> bool {
    has_fields(v, &["r", "q", "f", "k", "g"], &["h"])
        && is_round(v.get("r")).is_some()
        && str_of(v, "q").is_some_and(|q| q == "g" || hex_of(q, 24) || hex_of(q, 32))
        && str_of(v, "k").is_some_and(is_pub)
        && str_of(v, "g").is_some_and(is_sig)
        && v.get("h").is_none_or(|h| h.as_str().is_some_and(|h| hex_of(h, 64)))
        && close_frozen(v).is_some()
}

/// test-vectors `checkpoints`, `forfeits` and `closes`: the house takes
/// the ones the fold takes, and no other. A carry is held to isCarry (the
/// point, the riders and their felts, the shooters' lengths in UTF-16
/// units, `i`), a house commitment only at a house table, and a forfeit's
/// ids ascend as JS compares strings.
#[test]
fn checkpoints_forfeits_and_closes_read_as_the_fold_reads_them() {
    let v = vectors();
    let cases = v["checkpoints"].as_array().unwrap();
    assert!(cases.len() >= 70);
    for case in cases {
        let inc = case["inc"].as_str().unwrap();
        let cp = CVal::from_json(&case["value"]);
        assert_eq!(checkpoint_ok(&cp, inc), case["ok"].as_bool().unwrap(), "{inc}: {}", case["value"]);
    }
    let cases = v["forfeits"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for case in cases {
        let f = CVal::from_json(&case["value"]);
        assert_eq!(forfeit_ids(&f).is_some(), case["ok"].as_bool().unwrap(), "{}", case["value"]["n"]);
    }
    let cases = v["closes"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let c = CVal::from_json(&case["value"]);
        assert_eq!(close_ok(&c), case["ok"].as_bool().unwrap(), "{}", case["value"]["f"]);
    }
}

/// test-vectors `yjs`: values a peer can write that no JSON holds
/// (undefined entries, own `__proto__` fields, a typed array as the
/// prototype), each in the Yjs update a page wrote, read as a page
/// receiving it reads it: the same canon and hash, and the same verdict
/// from the reader; or, where the node can't tell, held (Unknown) or, for a
/// switch, served nothing.
#[test]
fn values_no_json_holds_read_as_a_page_receiving_them_reads_them() {
    let v = vectors();
    let cases = v["yjs"].as_array().unwrap();
    assert!(cases.len() >= 31);
    let (mut exact, mut unclear, mut twice, mut refused, mut unknown, mut switches) = (0, 0, 0, 0, 0, 0);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let bytes = hex::decode(case["update"].as_str().unwrap()).unwrap();
            txn.apply_update(yrs::Update::decode_v1(&bytes).unwrap()).unwrap();
        }
        let txn = doc.transact();
        let m = txn.get_map("m").unwrap();
        let Some(Out::Any(any)) = m.get(&txn, "v") else { panic!("{name}: no value") };
        let kind = case["kind"].as_str().unwrap();
        if kind == "switch" {
            // The node serves a table only under a switch every page takes.
            let page = case["ok"].as_bool().unwrap();
            match switch_of(&any) {
                Some(inc) => assert!(page && !case["proto"].as_bool().unwrap(), "{name}: {inc}"),
                None => assert!(!page || case["proto"].as_bool().unwrap(), "{name}: a page's switch"),
            }
            switches += 1;
            continue;
        }
        let val = CVal::from_any(&any);
        let ok = match kind {
            "checkpoint" => Some(checkpoint_ok(&val, case["inc"].as_str().unwrap())),
            "close" => Some(close_ok(&val)),
            _ => None,
        };
        let clarity = hb::clarity(&any);
        assert!(matches!(hb::weigh(&any, MAX_RECORD_BYTES), hb::Weighed::Light { .. }), "{name}");
        let as_page = hb::canon(&val).as_deref() == case["canon"].as_str()
            && hb::rec_hash(&val).as_deref() == case["hash"].as_str()
            && ok == case["ok"].as_bool();
        if case["unknown"].as_bool().unwrap() {
            // No page holds it, or one may hold what the node can't see: the
            // house won't act where it would count.
            assert_eq!(clarity, hb::Clarity::Unknown, "{name}");
            if case["refused"].as_bool().unwrap() {
                refused += 1;
            } else {
                unknown += 1;
            }
        } else if case["unclear"].as_bool().unwrap() {
            // A page reads it as the house does, or (a `__proto__` object
            // before the field the node sees) as junk; the house knows.
            assert_eq!(clarity, hb::Clarity::Proto, "{name}");
            let page_junk = case["canon"].is_null() || case["ok"].as_bool() == Some(false);
            assert!(as_page || page_junk, "{name}: neither the house's reading nor junk");
            if !as_page {
                assert_eq!(ok, Some(true), "{name}: the house's reading is good, a page's junk");
                twice += 1;
            }
            unclear += 1;
        } else {
            assert_eq!(clarity, hb::Clarity::Clear, "{name}");
            assert!(as_page, "{name}: read as a page reads it");
            exact += 1;
        }
    }
    assert!(
        exact >= 10 && unclear >= 11 && twice >= 3 && refused >= 4 && unknown >= 1 && switches >= 5,
        "{exact} exact, {unclear} unclear ({twice} junk on a page), {refused} refused, {unknown} unknown, {switches} switches"
    );
}

#[test]
fn a_switch_holds_v_and_inc_and_nothing_else() {
    let sw = |extra: Vec<(&str, CVal)>| {
        let mut f = vec![("v", CVal::Int(1)), ("inc", s(INC))];
        f.extend(extra);
        to_any(&obj(f))
    };
    assert_eq!(switch_of(&sw(vec![])).as_deref(), Some(INC));
    // computedCfgInc counts Object.keys, which lists an undefined entry.
    let with_undef = |m: Any| {
        let Any::Map(m) = m else { unreachable!() };
        let mut m = (*m).clone();
        m.insert("x".into(), Any::Undefined);
        Any::Map(Arc::new(m))
    };
    assert_eq!(switch_of(&with_undef(sw(vec![]))), None);
    assert_eq!(switch_of(&sw(vec![("x", s("1"))])), None);
    assert_eq!(switch_of(&to_any(&obj(vec![("v", CVal::Int(1)), ("x", s(INC))]))), None);
    assert_eq!(switch_of(&to_any(&obj(vec![("v", CVal::Int(2)), ("inc", s(INC))]))), None);
    // A `__proto__` field, whatever it holds and however much it weighs: a
    // page counts it an own key (after an earlier `__proto__: null` in the
    // update, which the node can't see) or not. No switch.
    let real = obj(vec![("v", CVal::Int(1)), ("inc", s(INC))]);
    let big = Any::String(Arc::from("x".repeat(2 * MAX_TOP_BYTES)));
    for pad in [Any::Undefined, Any::Null, Any::String(Arc::from("x")), Any::Map(Arc::new(HashMap::new())), Any::Array(Arc::from(vec![])), big] {
        assert_eq!(switch_of(&padded(&real, pad.clone())), None, "{pad:?}");
    }
}

/// A switch whose `inc` is no UTF-8 (yrs reads strings unchecked; a page
/// refuses the update): none, and nothing slices it on the way.
#[test]
fn a_switch_whose_inc_is_no_utf8_is_none() {
    let doc = Doc::with_client_id(5);
    let m = doc.get_or_insert_map(CASINO_MAP);
    let inc = format!("rq{}", "0".repeat(23));
    m.insert(&mut doc.transact_mut(), "sw", to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(&inc))])));
    let mut update = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    let at = update.windows(inc.len()).position(|w| w == inc.as_bytes()).unwrap();
    // (Byte 1 a continuation byte: no char starts there.)
    update[at + 1] = 0x80;
    let peer = Doc::new();
    peer.transact_mut().apply_update(yrs::Update::decode_v1(&update).unwrap()).unwrap();
    let txn = peer.transact();
    let Some(Out::Any(v)) = txn.get_map(CASINO_MAP).unwrap().get(&txn, "sw") else { panic!("no switch") };
    assert!(switch_of(&v).is_none());
}

/// A padded switch, which a page may take or not: the house serves
/// nothing there while it is there, and the table once it is clean.
#[test]
fn a_padded_switch_has_the_house_serve_nothing_there() {
    for pad in [Any::Map(Arc::new(HashMap::new())), Any::String(Arc::from("x")), Any::Null] {
        let mut room = Room::new("padded-switch", true);
        let real = obj(vec![("v", CVal::Int(1)), ("inc", s(INC))]);
        let put = |room: &Room, v: Any| {
            let casino = room.doc.get_or_insert_map(CASINO_MAP);
            let mut txn = room.doc.transact_mut();
            casino.insert(&mut txn, format!("cfg:computed:{T}"), v);
        };
        put(&room, padded(&real, pad.clone()));
        room.tick(0);
        room.tick(1_000);
        assert!(room.records("o:").is_empty(), "{pad:?}");
        put(&room, to_any(&real));
        room.tick(1_000);
        assert_eq!(room.records("o:1:").len(), 1, "{pad:?}");
    }
}

impl Room {
    /// A trim as a page writes it: checkpoint `body` signed by `by`, the
    /// live session deleted, the next one opened holding the records under
    /// `copies` byte for byte (a v0.51 trim's round-u copies): the next
    /// session's key.
    fn trim(&self, by: &Who, body: CVal, copies: &[String]) -> String {
        let old = self.ses_key();
        let cp = signed("sum", by, body);
        let sid = hb::next_sid(&ctx(), Some(&cp)).unwrap();
        let next = format!("ses:{T}:{INC}:{sid}");
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let kept: Vec<(String, Any)> = match comp.get(&txn, &old) {
            Some(Out::YMap(m)) => copies
                .iter()
                .map(|k| match m.get(&txn, k) {
                    Some(Out::Any(a)) => (k.clone(), a),
                    _ => panic!("no record {k} to copy"),
                })
                .collect(),
            _ => panic!("no session {old}"),
        };
        comp.insert(&mut txn, format!("sum:{T}:{INC}"), to_any(&cp));
        comp.remove(&mut txn, &old);
        let ses = comp.insert(&mut txn, next.as_str(), MapPrelim::default());
        for (k, a) in kept {
            ses.insert(&mut txn, k.as_str(), a);
        }
        next
    }

    fn forfeit(&self, by: &Who, r: i64, x: &str, n: &[&str]) -> String {
        let rec = signed("forfeit", by, obj(vec![("r", CVal::Int(r)), ("x", s(x)), ("n", CVal::Arr(n.iter().map(|p| s(p)).collect()))]));
        self.put('f', &rec)
    }

    /// Everything in the room's computed map but `skip`: each top-level
    /// key, and each record of the live session, with its canon.
    fn snapshot(&self, skip: &[String]) -> Vec<(String, Option<String>)> {
        let ses = self.ses_key();
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let mut out = Vec::new();
        for (k, v) in comp.iter(&txn) {
            match v {
                Out::Any(a) => out.push((k.to_string(), hb::canon(&CVal::from_any(&a)))),
                Out::YMap(m) if k == ses => {
                    for (rk, rv) in m.iter(&txn) {
                        if let (false, Out::Any(a)) = (skip.iter().any(|s| s == rk), rv) {
                            out.push((format!("{k}/{rk}"), hb::canon(&CVal::from_any(&a))));
                        }
                    }
                }
                _ => out.push((k.to_string(), None)),
            }
        }
        out.sort();
        out
    }
}

/// How round 1 was decided before the trim after it.
#[derive(Clone, Copy, Debug)]
enum Decided {
    /// The house revealed the close on its join.
    House,
    /// A Friendly close, by alice's forfeit of bob's seed.
    Forfeit,
    /// The close on the house's join, abandoned before the house saw it.
    Abandon,
}

/// Round 1 decided as `how`, a trim after it (copying round 1's deciding
/// record and counted reveals into the next session when `copy`, as a
/// v0.51 trim does), then rounds 2 and 3 on the house: what the room's
/// computed map holds after each tick, the copies aside.
fn after_a_trim(how: Decided, copy: bool) -> Vec<Vec<(String, Option<String>)>> {
    let mut room = Room::new(&format!("copies-{how:?}-{copy}"), true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (l, h, copies) = match how {
        Decided::House => {
            let (c, _, _) = room.closed_on_the_join(&alice, &bob);
            room.reveal(&alice, 1);
            room.reveal(&bob, 1);
            room.tick(200);
            let reveal = room.records("h:1:");
            assert_eq!(reveal.len(), 1, "round 1 revealed");
            let next = str_of(&reveal[0].1, "c").map(str::to_string);
            let mut copies: Vec<String> = room.records("x:1:").into_iter().map(|(k, _)| k).collect();
            copies.push(reveal[0].0.clone());
            (c, next, copies)
        }
        Decided::Forfeit => {
            room.set_fair(1, 1);
            room.tick(200);
            let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
            let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], None);
            room.reveal(&alice, 1);
            let f = room.forfeit(&alice, 1, &c, &["alice"]);
            room.tick(200);
            let mut copies: Vec<String> = room.records("x:1:").into_iter().map(|(k, _)| k).collect();
            copies.push(f);
            (c, None, copies)
        }
        Decided::Abandon => {
            let (c, _, _) = room.closed_on_the_join(&alice, &bob);
            room.abandon(&bob, 1, &c);
            room.tick(200);
            assert!(room.records("h:").is_empty(), "round 1 void");
            let copies: Vec<String> = room.records("z:1:").into_iter().map(|(k, _)| k).collect();
            (c, None, copies)
        }
    };
    assert!(!copies.is_empty());
    let mut body = vec![
        ("v", CVal::Int(1)),
        ("b", s("g")),
        ("u", CVal::Int(1)),
        ("l", s(&l)),
        ("n", obj(vec![("alice", s("-5")), ("bob", s("5"))])),
    ];
    if let Some(h) = &h {
        body.push(("h", s(h)));
    }
    let skip = if copy { copies.clone() } else { Vec::new() };
    room.trim(&alice, obj(body), &skip);
    let sid = room.ses_key().rsplit(':').next().unwrap().to_string();

    let mut seen = Vec::new();
    room.tick(200);
    seen.push(room.snapshot(&skip));
    if matches!(how, Decided::Forfeit) {
        // Fair again: the house joins round 2.
        room.set_fair(0, 2);
        room.tick(200);
        seen.push(room.snapshot(&skip));
    }
    // Round 2 on the house: closed on its commitment (the checkpoint's, or
    // its join's), every seed in, revealed.
    let (a2, b2) = (room.slip(&alice, 2), room.slip(&bob, 2));
    let c2 = room.close(&alice, 2, &sid, &[("alice", &a2), ("bob", &b2)], Some(&room.commit(2)));
    room.reveal(&alice, 2);
    room.reveal(&bob, 2);
    for _ in 0..3 {
        room.tick(200);
        seen.push(room.snapshot(&skip));
    }
    assert_eq!(room.records("h:2:").len(), 1, "{how:?}: round 2 revealed");
    // Friendly mid-way: round 3's commitment is stepped down.
    let (a3, b3) = (room.slip(&alice, 3), room.slip(&bob, 3));
    room.close(&bob, 3, &c2, &[("alice", &a3), ("bob", &b3)], Some(&room.commit(3)));
    room.set_fair(1, 3);
    for _ in 0..3 {
        room.tick(500);
        seen.push(room.snapshot(&skip));
    }
    seen
}

/// 🧷 PR 6a's round-u copies change nothing the house does: a v0.51 trim
/// copies round u's deciding record (the house's reveal, a forfeit, an
/// abandon) and its counted reveals into the next session, and the house
/// (this build, and so v0.50's) writes exactly what it writes without them,
/// tick for tick. Its walk starts past the checkpoint's round, and its own
/// reveal of round u carries only what the checkpoint's `h` carries.
#[test]
fn round_u_copies_after_a_trim_leave_the_house_unchanged() {
    for how in [Decided::House, Decided::Forfeit, Decided::Abandon] {
        let with = after_a_trim(how, true);
        let without = after_a_trim(how, false);
        assert_eq!(with.len(), without.len());
        for (i, (a, b)) in with.iter().zip(&without).enumerate() {
            assert_eq!(a, b, "{how:?}: tick {i}");
        }
        // And the house did write: a reveal of round 2 and more.
        assert!(with.last().unwrap().iter().any(|(k, _)| k.contains("/h:2:")), "{how:?}");
    }
}

// ── Values a page may read otherwise (hb::Clarity) ──────────────────────────

/// `v` as the doc holds it with a `__proto__` field `pad` as well: a peer's
/// write (no page's encoder makes one from an object it signed), which a
/// page decodes as `o.__proto__ = pad`.
fn padded(v: &CVal, pad: Any) -> Any {
    let Any::Map(m) = to_any(v) else { unreachable!() };
    let mut m = (*m).clone();
    m.insert("__proto__".to_string(), pad);
    Any::Map(Arc::new(m))
}

/// The key a record goes under in a session (as Room::put).
fn key_of(kind: char, v: &CVal) -> String {
    let r = v.get("r").and_then(CVal::as_int).unwrap();
    let h = hb::rec_hash(v).unwrap();
    match v.get("p").and_then(CVal::as_str) {
        Some(p) if kind == 's' || kind == 'x' => format!("{kind}:{r}:{p}:{h}"),
        _ => format!("{kind}:{r}:{h}"),
    }
}

/// Session `ses`'s records whose key starts `prefix`.
fn count_in(room: &Room, ses: &str, prefix: &str) -> usize {
    let txn = room.doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let Some(Out::YMap(m)) = comp.get(&txn, ses) else { return 0 };
    m.keys(&txn).filter(|k| k.starts_with(prefix)).count()
}

impl Room {
    /// Put `v` padded with `__proto__: pad` under its own key in the live
    /// session: the key.
    fn put_padded(&self, kind: char, v: &CVal, pad: Any) -> String {
        let key = key_of(kind, v);
        let ses = self.ses_key();
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!("no session {ses}") };
        m.insert(&mut txn, key.as_str(), padded(v, pad));
        key
    }

    fn put_top_padded(&self, key: &str, v: &CVal, pad: Any) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, padded(v, pad));
    }

    /// The value under `key` in the live session as the doc holds it.
    fn raw(&self, key: &str) -> Option<Any> {
        let ses = self.ses_key();
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        match comp.get(&txn, &ses) {
            Some(Out::YMap(m)) => match m.get(&txn, key) {
                Some(Out::Any(a)) => Some(a),
                _ => None,
            },
            _ => None,
        }
    }

    fn raw_top(&self, key: &str) -> Option<Any> {
        let txn = self.doc.transact();
        match txn.get_map(COMPUTED_MAP).unwrap().get(&txn, key) {
            Some(Out::Any(a)) => Some(a),
            _ => None,
        }
    }

    /// A peer's update writing a string that isn't UTF-8 under `key` in
    /// the live session (a page's decoder refuses the whole update).
    fn put_refused(&self, key: &str) {
        let peer = Doc::with_client_id(77);
        let sv = {
            let txn = self.doc.transact();
            let state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
            peer.transact_mut().apply_update(yrs::Update::decode_v1(&state).unwrap()).unwrap();
            txn.state_vector()
        };
        let ses = self.ses_key();
        {
            let comp = peer.get_or_insert_map(COMPUTED_MAP);
            let mut txn = peer.transact_mut();
            let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!("no session {ses}") };
            m.insert(&mut txn, key, Any::String(Arc::from("zqzqzqzqzq")));
        }
        let mut update = peer.transact().encode_state_as_update_v1(&sv);
        let at = update.windows(10).position(|w| w == b"zqzqzqzqzq").unwrap();
        update[at] = 0xff;
        self.doc.transact_mut().apply_update(yrs::Update::decode_v1(&update).unwrap()).unwrap();
    }
}

/// Whether `a` is `v` as every page reads it.
fn clean(a: Option<Any>, v: &CVal) -> bool {
    a.is_some_and(|a| hb::clarity(&a) == hb::Clarity::Clear && hb::rec_hash(&CVal::from_any(&a)) == hb::rec_hash(v))
}

/// A Friendly close padded with `__proto__: undefined` is one every page
/// receiving it takes (the field leaves none): at the round the house
/// joined, it is the rival that keeps the house's seed in.
#[test]
fn a_padded_friendly_close_beside_the_house_one_still_refuses_the_round() {
    let mut room = Room::new("padded-rival", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (_, a, b) = room.closed_on_the_join(&alice, &bob);
    let f = obj(vec![("alice", s(&a)), ("bob", s(&b))]);
    let rival = signed("close", &bob, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", f)]));
    let key = room.put_padded('c', &rival, Any::Undefined);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert!(clean(room.raw(&key), &rival), "back as every page reads it");
    for _ in 0..20 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty());
}

/// A slip by `w` at round r as Room::slip writes it, not yet put.
fn slip_rec(w: &Who, r: i64) -> CVal {
    let c = hb::slip_commit(&ctx(), r, &w.pid, &seed_of(&w.pid, r));
    let b = CVal::Arr(vec![obj(vec![("type", s("red")), ("amount", CVal::Int(5))])]);
    signed("slip", w, obj(vec![("r", CVal::Int(r)), ("p", s(&w.pid)), ("v", CVal::Int(1)), ("b", b), ("c", s(&c))]))
}

/// A record padded with a string (the close, the slip that signs it, a
/// seed that opens a slip): a page may take it, or (an object under that
/// name before it in the bytes, which the node can't see) hold junk. The
/// house does nothing at the table the pass it reads it, and puts it back
/// clean: the next pass reads what every page does, and the house plays on
/// in the same tick (after a tick's last pass, the next tick).
#[test]
fn a_record_a_page_may_read_otherwise_goes_back_clean_before_the_house_counts_it() {
    for which in ["close", "slip", "seed"] {
        for last_pass in [true, false] {
            let mut room = Room::new(&format!("padded-{which}-{last_pass}"), true);
            let (alice, bob) = (who("alice"), who("bob"));
            room.tick(0);
            let alice_slip = slip_rec(&alice, 1);
            let a = hb::rec_hash(&alice_slip).unwrap();
            let s_key = room.put('s', &alice_slip);
            let b = room.slip(&bob, 1);
            let f = obj(vec![("alice", s(&a)), ("bob", s(&b))]);
            let close = signed("close", &alice, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", f), ("h", s(&room.commit(1)))]));
            let c_key = room.put('c', &close);
            let alice_seed = obj(vec![("r", CVal::Int(1)), ("p", s("alice")), ("s", s(&seed_of("alice", 1)))]);
            let x_key = room.put('x', &alice_seed);
            // Every check made, bob's seed not in: nothing yet.
            room.tick(200);
            assert!(room.records("h:").is_empty());
            let (kind, key, rec) = match which {
                "close" => ('c', c_key, close.clone()),
                "slip" => ('s', s_key, alice_slip.clone()),
                _ => ('x', x_key, alice_seed.clone()),
            };
            assert_eq!(room.put_padded(kind, &rec, Any::String(Arc::from("x"))), key);
            room.reveal(&bob, 1);
            if last_pass {
                room.tick_passes(200, 1);
                assert!(room.records("h:").is_empty(), "{which}: nothing the pass it may read otherwise");
                assert!(clean(room.raw(&key), &rec), "{which}: back clean");
                let mem = &room.house.rooms[ROOM].tables[&(T.to_string(), INC.to_string())];
                assert!(mem.held_since.is_some(), "{which}: held, for the cutoff");
                room.tick(200);
            } else {
                room.tick(200);
                assert!(clean(room.raw(&key), &rec), "{which}: back clean");
            }
            let h = room.records("h:1:");
            assert_eq!(h.len(), 1, "{which} {last_pass}: revealed that tick");
            assert_eq!(strs(&h[0].1, "x"), vec![hb::rec_hash(&close).unwrap()]);
            assert_eq!(strs(&h[0].1, "n"), sorted(vec![a.clone(), b.clone()]), "{which}: both seeds counted");
        }
    }
}

/// An abandon padded so: a page takes it, and the close it names is never
/// revealed.
#[test]
fn a_padded_abandon_still_keeps_its_close_unrevealed() {
    let mut room = Room::new("padded-abandon", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    let z = signed("abandon", &bob, obj(vec![("r", CVal::Int(1)), ("x", s(&c))]));
    let key = room.put_padded('z', &z, Any::Undefined);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert!(clean(room.raw(&key), &z));
    for _ in 0..20 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty());
}

/// A forfeit padded so holds its table a tick and goes back clean.
#[test]
fn a_padded_forfeit_goes_back_clean() {
    let mut room = Room::new("padded-forfeit", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.tick(0);
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], None);
    let f = signed("forfeit", &alice, obj(vec![("r", CVal::Int(1)), ("x", s(&c)), ("n", CVal::Arr(vec![s("alice")]))]));
    let key = room.put_padded('f', &f, Any::Undefined);
    room.tick(200);
    assert!(clean(room.raw(&key), &f));
}

/// Another house's join padded so: the table waits a tick (no join of its
/// own beside it) and it goes back clean.
#[test]
fn another_houses_padded_join_holds_the_table_and_goes_back_clean() {
    let mut room = Room::new("padded-join", true);
    let mut b_house = second_house(&room);
    b_house.tick(ROOM, &room.doc, room.now, 1_700_000_000_000 + room.now);
    let (key, join) = room.records("o:1:").pop().unwrap();
    assert_eq!(str_of(&join, "k"), Some(b_house.public()));
    room.put_padded('o', &join, Any::Undefined);
    room.tick(0);
    assert!(clean(room.raw(&key), &join));
    assert_eq!(room.records("o:1:").len(), 1, "no second join beside it");
    room.tick(200);
    assert_eq!(room.records("o:1:").len(), 1);
}

/// A rival padded past what a record may weigh, with a `__proto__` string
/// a page drops: it still counts, and the round stays refused.
#[test]
fn a_rival_padded_heavy_still_refuses_the_round() {
    let mut room = Room::new("heavy-rival", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (_, a, b) = room.closed_on_the_join(&alice, &bob);
    let f = obj(vec![("alice", s(&a)), ("bob", s(&b))]);
    let rival = signed("close", &bob, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", f)]));
    let key = room.put_padded('c', &rival, Any::String(Arc::from("x".repeat(MAX_RECORD_BYTES + 1))));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert!(clean(room.raw(&key), &rival));
    for _ in 0..20 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty());
}

/// A rival a page reads without a field the node sees (a typed array as
/// the prototype before, a `__proto__: null` after, drop a numeric key):
/// the house can't know, and holds the table while it is there.
#[test]
fn a_record_a_page_may_read_as_another_holds_its_table_while_it_is_there() {
    let mut room = Room::new("typed-proto", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, a, b) = room.closed_on_the_join(&alice, &bob);
    let f = obj(vec![("alice", s(&a)), ("bob", s(&b))]);
    let rival = signed("close", &bob, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", f)]));
    let key = key_of('c', &rival);
    let odd = with(&rival, "7", s("x"));
    let pad = padded(&odd, Any::Null);
    assert_eq!(hb::clarity(&pad), hb::Clarity::Unknown);
    // Each key such a prototype keeps from being a field, and no other.
    let beside = |k: &str| hb::clarity(&padded(&with(&rival, k, s("x")), Any::Null));
    for k in ["7", "-1", "-.5", "-Infinity", ".5", "1e3", "NaN", "Infinity", "length", "byteLength", "byteOffset", "buffer", "BYTES_PER_ELEMENT"] {
        assert_eq!(beside(k), hb::Clarity::Unknown, "{k}");
    }
    for k in ["x7", "lengthy", "Length", "-", "-x", ".", "nan"] {
        assert_eq!(beside(k), hb::Clarity::Proto, "{k}");
    }
    {
        let ses = room.ses_key();
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
        m.insert(&mut txn, key.as_str(), pad);
    }
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..5 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty());
    // Gone (and no rival): the close is revealed, within the cutoff.
    room.delete(&key);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
}

/// Stepping down with a padded record at the table: the step-down's word
/// reads it again once it is back, and lifts the commitment.
#[test]
fn stepping_down_reads_a_held_table_again_once_its_values_are_back() {
    let mut room = Room::new("stop-held", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (_, a, _) = room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(room.records("h:1:").len(), 1);
    let slip = room.records(&format!("s:1:alice:{a}")).pop().unwrap().1;
    room.put_padded('s', &slip, Any::Undefined);
    room.house.begin_step_down();
    room.tick(200);
    let d = &room.records("h:2:")[0].1;
    assert!(strs(d, "x").is_empty(), "round 2's commitment stepped down");
}

/// Stepping down with nothing to check (every verdict in from an earlier
/// hold): the step-down's word still reads the table again once its
/// values are back, in the same tick.
#[test]
fn stepping_down_with_nothing_to_check_reads_a_held_table_again() {
    let mut room = Room::new("stop-held-checked", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (_, a, _) = room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(room.records("h:1:").len(), 1);
    let slip = room.records(&format!("s:1:alice:{a}")).pop().unwrap().1;
    room.put_padded('s', &slip, Any::Undefined);
    room.tick(200);
    assert!(clean(room.raw(&format!("s:1:alice:{a}")), &slip));
    room.put_padded('s', &slip, Any::Undefined);
    room.house.begin_step_down();
    room.tick(200);
    let words = room.records("h:2:");
    let d = &words.first().expect("the step-down's word").1;
    assert!(strs(d, "x").is_empty(), "round 2's commitment stepped down");
}

/// The owner's setting where a page may hold another (a typed array's
/// prototype keeps a key from it): the table waits while it is there.
#[test]
fn a_setting_a_page_may_read_as_another_holds_its_table_while_it_is_there() {
    let mut room = Room::new("typed-setting", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    let rec = room_signed("hfair", T, &room.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(0)), ("s", CVal::Int(1))]));
    let odd = padded(&with(&rec, "7", s("x")), Any::Null);
    assert_eq!(hb::clarity(&odd), hb::Clarity::Unknown);
    let key = format!("hf:{T}");
    {
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        comp.insert(&mut txn, key.as_str(), odd);
    }
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..5 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty());
    room.delete_top(&key);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
}

/// Another house's delegation where a page may hold another: no join of
/// the house's beside that house's while it is there.
#[test]
fn another_houses_delegation_a_page_may_read_as_another_holds_its_table() {
    let mut room = Room::new("typed-house", true);
    let mut b_house = second_house(&room);
    b_house.tick(ROOM, &room.doc, room.now, 1_700_000_000_000 + room.now);
    let b_pub = b_house.public().to_string();
    let key = format!("hk:{b_pub}");
    let deleg = top_value_within(&room.doc.get_or_insert_map(COMPUTED_MAP), &room.doc.transact(), &key, usize::MAX).unwrap();
    let odd = padded(&with(&deleg, "7", s("x")), Any::Null);
    assert_eq!(hb::clarity(&odd), hb::Clarity::Unknown);
    {
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        comp.insert(&mut txn, key.as_str(), odd);
    }
    for _ in 0..3 {
        room.tick(1_000);
    }
    let joins = room.records("o:1:");
    assert_eq!(joins.len(), 1);
    assert_eq!(str_of(&joins[0].1, "k"), Some(b_pub.as_str()));
    // Back: the other house's join is the table's, and stands alone.
    room.put_top(&key, &deleg);
    room.tick(1_000);
    assert_eq!(room.records("o:1:").len(), 1);
}

/// Two tables naming another house whose delegation is padded: both wait
/// (the second reads what the first found), and it goes back once.
#[test]
fn a_padded_delegation_holds_every_table_naming_its_house() {
    let mut room = Room::new("padded-house-two", true);
    const T2: &str = "roulette-2";
    const INC2: &str = "r89abcdef0123456789abcdef";
    let ctx2 = Ctx { room: ROOM.into(), t: T2.into(), inc: INC2.into() };
    let ses2 = format!("ses:{T2}:{INC2}:{}", hb::next_sid(&ctx2, None).unwrap());
    {
        let mut txn = room.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        casino.insert(&mut txn, format!("cfg:computed:{T2}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC2))])));
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        comp.insert(&mut txn, ses2.as_str(), MapPrelim::default());
    }
    let mut b_house = second_house(&room);
    b_house.tick(ROOM, &room.doc, room.now, 1_700_000_000_000 + room.now);
    let b_pub = b_house.public().to_string();
    let joins2 = |room: &Room| {
        let txn = room.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses2) else { panic!("no session") };
        m.keys(&txn).filter(|k| k.starts_with("o:1:")).count()
    };
    assert_eq!((room.records("o:1:").len(), joins2(&room)), (1, 1), "the other house's joins");
    let key = format!("hk:{b_pub}");
    let deleg = top_value_within(&room.doc.get_or_insert_map(COMPUTED_MAP), &room.doc.transact(), &key, usize::MAX).unwrap();
    room.put_top_padded(&key, &deleg, Any::Undefined);
    let out = room.tick(0);
    assert!(clean(room.raw_top(&key), &deleg));
    let g = str_of(&deleg, "g").unwrap().as_bytes();
    assert_eq!(out.update.unwrap().windows(g.len()).filter(|w| *w == g).count(), 1, "one write of it");
    assert_eq!((room.records("o:1:").len(), joins2(&room)), (1, 1), "no join beside them");
}

/// Two tables naming another house whose delegation is padded: the first
/// puts it back, and the second, reading what the first found, plays on in
/// the same tick too (here: the house's reveal at its own table).
#[test]
fn a_padded_delegation_goes_back_once_and_every_table_naming_its_house_plays_on() {
    let mut room = Room::new("padded-house-plays", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, _, _) = room.closed_on_the_join(&alice, &bob);
    // A table read before this one ("roulette-0" < T), naming that house.
    const T0: &str = "roulette-0";
    const INC0: &str = "r89abcdef0123456789abcdef";
    let ctx0 = Ctx { room: ROOM.into(), t: T0.into(), inc: INC0.into() };
    let ses0 = format!("ses:{T0}:{INC0}:{}", hb::next_sid(&ctx0, None).unwrap());
    let b_house = second_house(&room);
    let b_pub = b_house.public().to_string();
    let naming = |i: u8| obj(vec![("r", CVal::Int(9)), ("c", s(&format!("{i:064x}"))), ("k", s(&b_pub)), ("g", s(&"A".repeat(86)))]);
    {
        let mut txn = room.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        casino.insert(&mut txn, format!("cfg:computed:{T0}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC0))])));
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        let ses = comp.insert(&mut txn, ses0.as_str(), MapPrelim::default());
        ses.insert(&mut txn, key_of('o', &naming(0)), to_any(&naming(0)));
    }
    room.put_raw(&key_of('o', &naming(1)), &naming(1));
    let key = format!("hk:{b_pub}");
    let deleg = top_value_within(&room.doc.get_or_insert_map(COMPUTED_MAP), &room.doc.transact(), &key, usize::MAX).unwrap();
    room.put_top_padded(&key, &deleg, Any::Undefined);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    let out = room.tick(200);
    assert!(clean(room.raw_top(&key), &deleg));
    let g = str_of(&deleg, "g").unwrap().as_bytes();
    assert_eq!(out.update.unwrap().windows(g.len()).filter(|w| *w == g).count(), 1, "one write of it");
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c], "revealed in the same tick");
}

/// Stepping down with another house's delegation padded and two tables
/// naming it: both get the step-down's word.
#[test]
fn stepping_down_with_a_padded_delegation_steps_every_table_naming_its_house_down() {
    let mut room = Room::new("stop-padded-house", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    const T0: &str = "roulette-0";
    const INC0: &str = "r89abcdef0123456789abcdef";
    let ctx0 = Ctx { room: ROOM.into(), t: T0.into(), inc: INC0.into() };
    let ses0 = format!("ses:{T0}:{INC0}:{}", hb::next_sid(&ctx0, None).unwrap());
    {
        let mut txn = room.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        casino.insert(&mut txn, format!("cfg:computed:{T0}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC0))])));
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        comp.insert(&mut txn, ses0.as_str(), MapPrelim::default());
    }
    // Round 1 revealed here (round 2's commitment carried), and round 1
    // joined at the new table.
    room.tick(200);
    assert_eq!(room.records("h:1:").len(), 1);
    let in0 = |room: &Room, prefix: &str| {
        let txn = room.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses0) else { panic!("no session") };
        m.iter(&txn).filter(|(k, _)| k.starts_with(prefix)).count()
    };
    assert_eq!((in0(&room, "o:1:"), in0(&room, "h:1:")), (1, 0));
    // Then records at both naming another house, its delegation padded.
    let b_house = second_house(&room);
    let b_pub = b_house.public().to_string();
    let naming = |i: u8| obj(vec![("r", CVal::Int(9)), ("c", s(&format!("{i:064x}"))), ("k", s(&b_pub)), ("g", s(&"A".repeat(86)))]);
    {
        let mut txn = room.doc.transact_mut();
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        let Some(Out::YMap(m)) = comp.get(&txn, &ses0) else { panic!("no session") };
        m.insert(&mut txn, key_of('o', &naming(0)), to_any(&naming(0)));
    }
    room.put_raw(&key_of('o', &naming(1)), &naming(1));
    let key = format!("hk:{b_pub}");
    let deleg = top_value_within(&room.doc.get_or_insert_map(COMPUTED_MAP), &room.doc.transact(), &key, usize::MAX).unwrap();
    room.put_top_padded(&key, &deleg, Any::Undefined);
    room.house.begin_step_down();
    room.tick(200);
    assert!(clean(room.raw_top(&key), &deleg));
    assert_eq!(in0(&room, "h:1:"), 1, "the new table's step-down word");
    let words = room.records("h:2:");
    let d = &words.first().expect("this table's step-down word").1;
    assert!(strs(d, "x").is_empty(), "round 2's commitment stepped down");
}

/// A second table, "roulette-0" (read before T), and a record at each
/// naming another house (a join of round 9 with a signature's shape).
fn two_tables_naming(room: &Room, b_pub: &str) -> String {
    const T0: &str = "roulette-0";
    const INC0: &str = "r89abcdef0123456789abcdef";
    let ctx0 = Ctx { room: ROOM.into(), t: T0.into(), inc: INC0.into() };
    let ses0 = format!("ses:{T0}:{INC0}:{}", hb::next_sid(&ctx0, None).unwrap());
    let naming = |i: u8| obj(vec![("r", CVal::Int(9)), ("c", s(&format!("{i:064x}"))), ("k", s(b_pub)), ("g", s(&"A".repeat(86)))]);
    {
        let mut txn = room.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        casino.insert(&mut txn, format!("cfg:computed:{T0}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC0))])));
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        let ses = comp.insert(&mut txn, ses0.as_str(), MapPrelim::default());
        ses.insert(&mut txn, key_of('o', &naming(0)), to_any(&naming(0)));
    }
    room.put_raw(&key_of('o', &naming(1)), &naming(1));
    ses0
}

/// Another house's delegation no page may read as the node does: each
/// table naming it waits, read once a tick (no table reads it again for
/// what another found).
#[test]
fn an_unknown_delegation_costs_each_table_naming_it_one_read() {
    let mut room = Room::new("unknown-house-reads", true);
    room.tick(0);
    let b_house = second_house(&room);
    let b_pub = b_house.public().to_string();
    let key = format!("hk:{b_pub}");
    let deleg = top_value_within(&room.doc.get_or_insert_map(COMPUTED_MAP), &room.doc.transact(), &key, usize::MAX).unwrap();
    {
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        comp.insert(&mut txn, key.as_str(), padded(&with(&deleg, "7", s("x")), Any::Null));
    }
    two_tables_naming(&room, &b_pub);
    room.tick(200);
    room.house.table_reads = 0;
    room.tick(200);
    assert_eq!(room.house.table_reads, 2);
}

/// After a delegation went back for a table, the next table with a value
/// no heal can mend waits as it would have: read once a tick.
#[test]
fn a_delegation_put_back_leaves_no_later_table_reading_again() {
    let mut room = Room::new("healed-house-reads", true);
    room.tick(0);
    let b_house = second_house(&room);
    let b_pub = b_house.public().to_string();
    let key = format!("hk:{b_pub}");
    let deleg = top_value_within(&room.doc.get_or_insert_map(COMPUTED_MAP), &room.doc.transact(), &key, usize::MAX).unwrap();
    room.put_top_padded(&key, &deleg, Any::Undefined);
    two_tables_naming(&room, &b_pub);
    room.tick(200);
    assert!(clean(room.raw_top(&key), &deleg));
    let seed = obj(vec![("r", CVal::Int(1)), ("p", s("alice")), ("s", s(&seed_of("alice", 1)))]);
    room.put_refused(&key_of('x', &seed));
    room.tick(200);
    room.house.table_reads = 0;
    room.tick(200);
    assert_eq!(room.house.table_reads, 2, "this table held, the other through");
}

/// Its own record padded goes back with the put-back even where no read
/// reaches it (here: the table switched off since).
#[test]
fn its_own_padded_record_goes_back_with_the_put_back() {
    let mut room = Room::new("padded-own-record", true);
    room.tick(0);
    let (key, join) = room.records("o:1:").pop().unwrap();
    {
        let casino = room.doc.get_or_insert_map(CASINO_MAP);
        let mut txn = room.doc.transact_mut();
        casino.remove(&mut txn, &format!("cfg:computed:{T}"));
    }
    room.delete(&key);
    room.put_padded('o', &join, Any::Undefined);
    room.tick(REPUT_MS);
    assert!(clean(room.raw(&key), &join));
}

/// A checkpoint padded so (an ended one, or a live one): the house never
/// serves the first session a peer kept beside it, and goes by the
/// checkpoint once it has put it back.
#[test]
fn a_padded_checkpoint_sends_the_house_to_no_other_session() {
    for ended in [true, false] {
        let mut room = Room::new(if ended { "padded-ended" } else { "padded-live" }, true);
        let (alice, bob) = (who("alice"), who("bob"));
        let first = format!("ses:{T}:{INC}:g");
        // Round 1 of the first session, closed on the commitment, seeds in:
        // the house would reveal it there at once.
        let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
        room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
        room.reveal(&alice, 1);
        room.reveal(&bob, 1);
        let mut body = vec![("v", CVal::Int(1)), ("b", s("g")), ("u", CVal::Int(4)), ("l", s(&"ab".repeat(16))), ("n", obj(vec![]))];
        if ended {
            body.push(("e", CVal::Int(1)));
        } else {
            body.push(("h", s(&room.commit(5))));
        }
        let cp = signed("sum", &alice, obj(body));
        assert!(checkpoint_ok(&cp, INC));
        let sid = hb::next_sid(&ctx(), Some(&cp)).unwrap();
        let next = format!("ses:{T}:{INC}:{sid}");
        {
            let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = room.doc.transact_mut();
            comp.insert(&mut txn, format!("sum:{T}:{INC}"), padded(&cp, Any::Null));
            comp.insert(&mut txn, next.clone(), MapPrelim::default());
        }
        room.tick(0);
        assert!(clean(room.raw_top(&format!("sum:{T}:{INC}")), &cp), "back as every page reads it");
        for _ in 0..10 {
            room.tick(1_000);
        }
        assert_eq!(count_in(&room, &first, "h:") + count_in(&room, &first, "o:"), 0, "ended {ended}: nothing in the first session");
        if !ended {
            // The live one carries round 5's commitment: round 5 there plays.
            let (a5, b5) = (room.slip(&alice, 5), room.slip(&bob, 5));
            let c = room.close(&alice, 5, &sid, &[("alice", &a5), ("bob", &b5)], Some(&room.commit(5)));
            room.reveal(&alice, 5);
            room.reveal(&bob, 5);
            room.tick(200);
            assert_eq!(strs(&room.records("h:5:")[0].1, "x"), vec![c]);
        } else {
            assert_eq!(count_in(&room, &next, ""), 0, "an ended table: nothing at all");
        }
    }
}

/// A value no page holds (a string that isn't UTF-8: a page refuses the
/// update that brought it, keeping what was under its key before) holds
/// its table while it is there, past every grace. Gone, the table plays,
/// and a close that came during the hold counts as first seen when the
/// hold began: past REVEAL_CUTOFF_MS from then (the pages have voided
/// it), it is given up, never revealed.
#[test]
fn a_value_a_page_refuses_holds_its_table_while_it_is_there() {
    for hold_ms in [3_000u64, 40_000] {
        let mut room = Room::new(&format!("refused-{hold_ms}"), true);
        let (alice, bob) = (who("alice"), who("bob"));
        let (c, _, _) = room.closed_on_the_join(&alice, &bob);
        room.reveal(&bob, 1);
        // Where alice's seed goes: a page may hold it there, the node can't know.
        let seed = obj(vec![("r", CVal::Int(1)), ("p", s("alice")), ("s", s(&seed_of("alice", 1)))]);
        let key = key_of('x', &seed);
        room.put_refused(&key);
        assert_eq!(room.raw(&key).map(|a| hb::clarity(&a)), Some(hb::Clarity::Unknown));
        for _ in 0..hold_ms / 1_000 {
            room.tick(1_000);
        }
        assert!(room.records("h:").is_empty(), "held {hold_ms}: nothing");
        room.put('x', &seed);
        room.tick(200);
        if hold_ms < REVEAL_CUTOFF_MS {
            assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c.clone()]);
        } else {
            for _ in 0..5 {
                room.tick(1_000);
            }
            assert!(room.records("h:").is_empty(), "held {hold_ms}: given up");
        }
    }
}

/// A hold that ends before a close comes changes nothing for it.
#[test]
fn a_close_after_a_hold_counts_from_when_it_is_seen() {
    let mut room = Room::new("after-hold", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.tick(0);
    let seed = obj(vec![("r", CVal::Int(1)), ("p", s("alice")), ("s", s(&seed_of("alice", 1)))]);
    let key = key_of('x', &seed);
    room.put_refused(&key);
    for _ in 0..30 {
        room.tick(1_000);
    }
    room.delete(&key);
    room.tick(200);
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
}

/// A close that comes during a hold: once the hold is over, its seeds
/// still get the whole grace from when the house first saw it (a hold
/// counts only toward the cutoff).
#[test]
fn a_close_during_a_hold_still_gives_its_seeds_their_grace() {
    let mut room = Room::new("grace-after-hold", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.tick(0);
    let seed = obj(vec![("r", CVal::Int(1)), ("p", s("alice")), ("s", s(&seed_of("alice", 1)))]);
    let key = key_of('x', &seed);
    room.put_refused(&key);
    room.tick(1_000);
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    room.tick(1_000);
    let c = room.close(&alice, 1, "g", &[("alice", &a), ("bob", &b)], Some(&room.commit(1)));
    for _ in 0..4 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty(), "held");
    // The hold over, alice's seed in, bob's not yet.
    room.put('x', &seed);
    room.tick(200);
    room.tick(REVEAL_GRACE_MS / 2);
    assert!(room.records("h:").is_empty(), "bob's seed still has its time");
    room.reveal(&bob, 1);
    room.tick(200);
    let h = room.records("h:1:");
    assert_eq!(strs(&h[0].1, "x"), vec![c]);
    assert_eq!(strs(&h[0].1, "n"), sorted(vec![a, b]), "both seeds counted");
}

/// The `__proto__` strings a page drops weigh nothing toward a record's
/// cap, but reading them (are they UTF-8?) costs the tick their bytes, and
/// more than a tick reads is never read: the value is Unknown.
#[test]
fn padding_a_page_drops_still_costs_the_tick_its_bytes() {
    let stray = |i: u8| obj(vec![("r", CVal::Int(1)), ("p", s("carol")), ("s", s(&format!("{i:064x}")))]);
    let pad = |n: usize| Any::String(Arc::from("x".repeat(n)));
    let w = hb::weight(&to_any(&stray(0)), MAX_RECORD_BYTES).unwrap();
    assert_eq!(hb::weigh(&padded(&stray(0), pad(1_000)), MAX_RECORD_BYTES), hb::Weighed::Light { w: w + "__proto__".len() + 4 + 8, scan: 1_000 });
    for (n, short) in [(2, false), (5, true)] {
        let mut room = Room::new(&format!("padding-cost-{n}"), true);
        // (Every check made: a tick of one pass.)
        room.tick(0);
        room.tick(200);
        // Junk however it is read (a seed that opens no slip): it stays.
        for i in 0..n {
            room.put_padded('x', &stray(i as u8), pad(READ_PER_TICK / 4));
        }
        assert_eq!(room.tick(200).short, short, "{n} MB of padding");
        assert_eq!(room.tick(200).short, short, "{n} MB of padding, still there");
    }
    // Past what a tick reads: never read, Unknown, and the table waits.
    let mut room = Room::new("padding-past-a-tick", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    let seed = obj(vec![("r", CVal::Int(1)), ("p", s("bob")), ("s", s(&seed_of("bob", 1)))]);
    let key = room.put_padded('x', &seed, pad(READ_PER_TICK + 1));
    for _ in 0..5 {
        assert!(!room.tick(1_000).short);
    }
    assert!(room.records("h:").is_empty());
    room.put('x', &seed);
    room.tick(200);
    assert_eq!(room.records("h:1:").len(), 1, "gone: revealed");
    assert!(clean(room.raw(&key), &seed));
}

/// Junk on every page holds nothing: a record padded with an object (no
/// page holds a plain object there), a seed padded so that opens no slip.
#[test]
fn junk_on_every_page_and_an_idle_unclear_seed_hold_no_table() {
    let mut room = Room::new("junk-either-way", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, a, b) = room.closed_on_the_join(&alice, &bob);
    let f = obj(vec![("alice", s(&a)), ("bob", s(&b))]);
    let rival = signed("close", &bob, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", f)]));
    room.put_padded('c', &rival, Any::Map(Arc::new(HashMap::new())));
    let stray = obj(vec![("r", CVal::Int(1)), ("p", s("carol")), ("s", s(&"5a".repeat(32)))]);
    let stray_key = room.put_padded('x', &stray, Any::Undefined);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
    // A seed opening no slip there is nobody's to need: it stays as it is.
    assert!(room.raw(&stray_key).is_some_and(|a| hb::clarity(&a) != hb::Clarity::Clear), "not written back");
}

/// Another house's delegation padded: a page may not count that house, so
/// the table waits while its delegation goes back clean.
#[test]
fn a_padded_delegation_of_another_house_goes_back_clean() {
    let mut room = Room::new("padded-house", true);
    let mut b_house = second_house(&room);
    b_house.tick(ROOM, &room.doc, room.now, 1_700_000_000_000 + room.now);
    let key = format!("hk:{}", b_house.public());
    let deleg = top_value_within(&room.doc.get_or_insert_map(COMPUTED_MAP), &room.doc.transact(), &key, usize::MAX).unwrap();
    room.put_top_padded(&key, &deleg, Any::Undefined);
    // Records naming that house, each asking for its delegation: it goes
    // back once.
    let b_pub = b_house.public().to_string();
    for i in 0..5 {
        let body = obj(vec![("r", CVal::Int(9)), ("c", s(&format!("{i:064x}"))), ("k", s(&b_pub)), ("g", s(&"A".repeat(86)))]);
        room.put_raw(&key_of('o', &body), &body);
    }
    let out = room.tick(0);
    assert!(clean(room.raw_top(&key), &deleg));
    // (A write over a key names the item it follows, not the key, so the
    // delegation's signature is what shows each write of it.)
    let update = out.update.unwrap();
    let g = str_of(&deleg, "g").unwrap().as_bytes();
    assert_eq!(update.windows(g.len()).filter(|w| *w == g).count(), 1, "one write of it");
    // Nothing at the table that tick: no join beside the other house's.
    let joins = room.records("o:1:");
    assert_eq!(joins.len(), 1);
    assert_eq!(str_of(&joins[0].1, "k"), Some(b_pub.as_str()));
}

/// A newer setting padded: the table waits a pass, the setting goes back
/// clean and stands, and the table plays by it in the same tick (after a
/// tick's last pass, the next).
#[test]
fn a_padded_newer_setting_goes_back_clean_and_stands() {
    for last_pass in [true, false] {
        let mut room = Room::new(&format!("padded-setting-{last_pass}"), true);
        let (alice, bob) = (who("alice"), who("bob"));
        room.closed_on_the_join(&alice, &bob);
        room.reveal(&alice, 1);
        room.reveal(&bob, 1);
        room.tick(200);
        assert_eq!(room.records("h:1:").len(), 1);
        let rec = room_signed("hfair", T, &room.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(1)), ("s", CVal::Int(1))]));
        room.put_top_padded(&format!("hf:{T}"), &rec, Any::Undefined);
        if last_pass {
            // (A pass for its check, then the last.)
            room.tick_passes(200, 2);
            assert!(room.records("h:2:").is_empty(), "no step-down the pass it may read otherwise");
            assert!(clean(room.raw_top(&format!("hf:{T}")), &rec));
            let mem = &room.house.rooms[ROOM].tables[&(T.to_string(), INC.to_string())];
            assert!(mem.held_since.is_some(), "held, for the cutoff");
        }
        room.tick(200);
        assert!(clean(room.raw_top(&format!("hf:{T}")), &rec));
        let down = room.records("h:2:");
        assert_eq!(down.len(), 1, "Friendly: round 2's commitment stepped down");
        assert!(strs(&down[0].1, "x").is_empty());
    }
}

/// Stepping down with a newer setting padded: it goes back, and the
/// step-down's word reads the table again.
#[test]
fn stepping_down_with_a_padded_newer_setting_still_steps_its_table_down() {
    let mut room = Room::new("stop-padded-setting", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(room.records("h:1:").len(), 1);
    let rec = room_signed("hfair", T, &room.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(0)), ("s", CVal::Int(1))]));
    room.put_top_padded(&format!("hf:{T}"), &rec, Any::Undefined);
    room.house.begin_step_down();
    room.tick(200);
    assert!(clean(room.raw_top(&format!("hf:{T}")), &rec));
    let words = room.records("h:2:");
    let d = &words.first().expect("the step-down's word").1;
    assert!(strs(d, "x").is_empty(), "round 2's commitment stepped down");
}

/// Its own delegation padded goes back clean with the put-back.
#[test]
fn its_own_padded_delegation_goes_back_clean() {
    let mut room = Room::new("padded-own", false);
    let key = format!("hk:{}", room.house.public());
    let rec = room_signed("hkey", "", &room.owner, obj(vec![("v", CVal::Int(1)), ("h", s(room.house.public()))]));
    room.put_top_padded(&key, &rec, Any::Undefined);
    room.tick(0);
    room.tick(REPUT_MS);
    assert!(clean(room.raw_top(&key), &rec));
}

// ── Values a page reads otherwise than the node can see (round 2) ───────────

/// A rival a page reads past a typed array (a `__proto__` buffer first in
/// the update, a numeric key past its end, a `__proto__: null` last: the
/// page drops the key, test-vectors "a close with __proto__ a buffer, a
/// numeric field, then null"), the key holding more than any record
/// weighs: the house reads it no further, holds the table while it is
/// there, and the read costs the tick no more than a light record.
#[test]
fn a_rival_a_page_reads_past_a_typed_array_holds_its_table_however_heavy() {
    let mut room = Room::new("typed-heavy", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, a, b) = room.closed_on_the_join(&alice, &bob);
    let f = obj(vec![("alice", s(&a)), ("bob", s(&b))]);
    let rival = signed("close", &bob, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", f)]));
    let key = key_of('c', &rival);
    let Any::Map(m) = padded(&rival, Any::Null) else { unreachable!() };
    let mut m = (*m).clone();
    m.insert("77777".into(), Any::String(Arc::from("x".repeat(4 * MAX_RECORD_BYTES))));
    let pad = Any::Map(Arc::new(m));
    assert!(matches!(hb::weigh(&pad, MAX_RECORD_BYTES), hb::Weighed::Light { w, .. } if w < 1_000));
    assert_eq!(hb::clarity(&pad), hb::Clarity::Unknown);
    {
        let ses = room.ses_key();
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
        m.insert(&mut txn, key.as_str(), pad);
    }
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..5 {
        hb::UTF8_READ.with(|n| n.set(0));
        room.tick(1_000);
        let read = hb::UTF8_READ.with(|n| n.get());
        assert!(read < MAX_RECORD_BYTES, "{read} bytes read for UTF-8: the key's value unread");
    }
    assert!(room.records("h:").is_empty(), "no reveal over a rival a page may count");
    room.delete(&key);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
}

/// A rival padded past the cap with undefined fields, which no page reader
/// counts (computedFold hasFields, canon): every page takes it, so the
/// house never reads it as junk. It can't tell what a page reads without
/// reading it all: it holds the table while it is there.
#[test]
fn a_rival_padded_past_the_cap_with_undefined_fields_holds_its_table() {
    for many in [false, true] {
        let mut room = Room::new(&format!("undefined-heavy-{many}"), true);
        let (alice, bob) = (who("alice"), who("bob"));
        let (c, a, b) = room.closed_on_the_join(&alice, &bob);
        let f = obj(vec![("alice", s(&a)), ("bob", s(&b))]);
        let rival = signed("close", &bob, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", f)]));
        let key = key_of('c', &rival);
        let Any::Map(m) = to_any(&rival) else { unreachable!() };
        let mut m = (*m).clone();
        if many {
            for i in 0..MAX_RECORD_BYTES / 8 {
                m.insert(format!("u{i}"), Any::Undefined);
            }
        } else {
            m.insert("u".repeat(MAX_RECORD_BYTES), Any::Undefined);
        }
        let pad = Any::Map(Arc::new(m));
        assert_eq!(hb::canon(&CVal::from_any(&pad)), hb::canon(&rival), "a page's reading, the padding skipped");
        assert_eq!(hb::weigh(&pad, MAX_RECORD_BYTES), hb::Weighed::Unsure);
        {
            let ses = room.ses_key();
            let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = room.doc.transact_mut();
            let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
            m.insert(&mut txn, key.as_str(), pad);
        }
        room.reveal(&alice, 1);
        room.reveal(&bob, 1);
        for _ in 0..5 {
            room.tick(1_000);
        }
        assert!(room.records("h:").is_empty(), "no reveal over a rival every page counts");
        room.delete(&key);
        room.tick(200);
        assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
    }
}

/// A key a typed array keeps from being a field, beside a `__proto__`
/// field holding anything (the node sees the last of several: an earlier
/// buffer may have been the prototype as the key came, and a getter's key
/// refuses the update, test-vectors "a close with __proto__ a buffer, a
/// length, then an object"): Unknown, and a rival so padded holds the table.
#[test]
fn a_typed_array_key_beside_any_proto_field_is_unknown() {
    let mut room = Room::new("typed-any-proto", true);
    let (alice, bob) = (who("alice"), who("bob"));
    let (c, a, b) = room.closed_on_the_join(&alice, &bob);
    let f = obj(vec![("alice", s(&a)), ("bob", s(&b))]);
    let rival = signed("close", &bob, obj(vec![("r", CVal::Int(1)), ("q", s("g")), ("f", f)]));
    let pads = [
        Any::Null,
        Any::Undefined,
        Any::String(Arc::from("x")),
        Any::Map(Arc::new(HashMap::new())),
        Any::Array(Arc::from(vec![])),
        Any::Buffer(Arc::from(vec![0u8; 4])),
    ];
    for pad in &pads {
        for k in ["7", "length", "byteLength", "BYTES_PER_ELEMENT"] {
            assert_eq!(hb::clarity(&padded(&with(&rival, k, CVal::Int(1)), pad.clone())), hb::Clarity::Unknown, "{k} beside {pad:?}");
        }
    }
    let key = key_of('c', &rival);
    let odd = padded(&with(&rival, "length", CVal::Int(1)), Any::Map(Arc::new(HashMap::new())));
    {
        let ses = room.ses_key();
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
        m.insert(&mut txn, key.as_str(), odd);
    }
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    for _ in 0..5 {
        room.tick(1_000);
    }
    assert!(room.records("h:").is_empty(), "no reveal while a page may hold the rival");
    room.delete(&key);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
}

/// A setting a page may hold otherwise entirely, over the older one the
/// house holds (the deed holder's newer Friendly setting, as a page reads
/// it past a typed array, or past undefined fields that take it over the
/// cap): the house puts nothing back over it (a page keeps the newer one
/// whatever comes after, fairAfter), and the table waits; once it is
/// clean, the house plays the newer one.
#[test]
fn a_setting_a_page_may_hold_otherwise_is_never_put_back_over_with_an_older_one() {
    for typed in [true, false] {
        let mut room = Room::new(&format!("unknown-setting-{typed}"), true);
        let (alice, bob) = (who("alice"), who("bob"));
        room.set_fair(0, 1);
        room.closed_on_the_join(&alice, &bob);
        let key = format!("hf:{T}");
        let newer = room_signed("hfair", T, &room.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(1)), ("s", CVal::Int(2))]));
        let odd = if typed {
            padded(&with(&newer, "7", s("x")), Any::Null)
        } else {
            let Any::Map(m) = to_any(&newer) else { unreachable!() };
            let mut m = (*m).clone();
            m.insert("u".repeat(MAX_TOP_BYTES), Any::Undefined);
            Any::Map(Arc::new(m))
        };
        {
            let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = room.doc.transact_mut();
            comp.insert(&mut txn, key.as_str(), odd.clone());
        }
        room.reveal(&alice, 1);
        room.reveal(&bob, 1);
        for _ in 0..5 {
            room.tick(REPUT_MS);
            assert_eq!(room.raw_top(&key).as_ref(), Some(&odd), "nothing put back over it");
        }
        assert!(room.records("h:").is_empty(), "nothing at the table meanwhile");
        room.put_top(&key, &newer);
        // (Its check, then the records the hold left unread: two ticks.)
        room.tick(200);
        room.tick(200);
        let h = &room.records("h:1:")[0].1;
        assert_eq!(strs(h, "x").len(), 1);
        assert!(h.get("c").is_none(), "Friendly: no next commitment");
    }
}

/// Stepping down with its own record a page may read otherwise entirely
/// (`__proto__: undefined`, `7: undefined`): the put-back writes it again
/// and the step-down's word reads the table again (the next pass; after a
/// tick's last pass, short, for the step-down's unbounded tick), and lifts
/// the commitment.
#[test]
fn stepping_down_reads_a_table_again_once_its_own_record_is_put_back() {
    for last_pass in [false, true] {
        let mut room = Room::new(&format!("stop-own-unknown-{last_pass}"), true);
        let (alice, bob) = (who("alice"), who("bob"));
        room.closed_on_the_join(&alice, &bob);
        room.reveal(&alice, 1);
        room.reveal(&bob, 1);
        room.tick(200);
        let (key, h1) = room.records("h:1:").pop().unwrap();
        let odd = padded(&h1, Any::Undefined);
        let Any::Map(m) = odd else { unreachable!() };
        let mut m = (*m).clone();
        m.insert("7".into(), Any::Undefined);
        let odd = Any::Map(Arc::new(m));
        assert_eq!(hb::clarity(&odd), hb::Clarity::Unknown);
        {
            let ses = room.ses_key();
            let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = room.doc.transact_mut();
            let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
            m.insert(&mut txn, key.as_str(), odd);
        }
        room.house.begin_step_down();
        if last_pass {
            let out = room.tick_passes(REPUT_MS, 1);
            assert!(clean(room.raw(&key), &h1), "put back");
            assert!(out.short, "short: the step-down's last word reads it again");
            assert!(room.records("h:2:").is_empty());
            room.house.tick_unbounded(ROOM, &room.doc, room.now, 0);
        } else {
            room.tick(REPUT_MS);
        }
        let words = room.records("h:2:");
        let d = &words.first().expect("the step-down's word").1;
        assert!(strs(d, "x").is_empty(), "round 2's commitment stepped down");
    }
}

/// A record put back for a table the tick never held (its switch gone, so
/// not read at all) asks for no second read: the tick isn't short.
#[test]
fn a_record_put_back_for_a_table_not_held_reads_nothing_again() {
    let mut room = Room::new("put-back-not-held", true);
    room.tick(0);
    let (key, join) = room.records("o:1:").pop().unwrap();
    {
        let casino = room.doc.get_or_insert_map(CASINO_MAP);
        let mut txn = room.doc.transact_mut();
        casino.remove(&mut txn, &format!("cfg:computed:{T}"));
    }
    room.delete(&key);
    let out = room.tick_passes(REPUT_MS, 1);
    assert!(clean(room.raw(&key), &join), "put back");
    assert!(!out.short, "nothing held: no second read");
}

/// A session key longer than any record's goes under: the tick reads
/// nothing of its bytes (not even whether they are UTF-8) before it is
/// charged its length, which here is more than a tick reads.
#[test]
fn a_key_longer_than_any_records_is_charged_before_anything_reads_it() {
    let mut room = Room::new("long-key", true);
    room.tick(0);
    let long = format!("s:1:{}", "x".repeat(2 * READ_PER_TICK));
    {
        let ses = room.ses_key();
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
        m.insert(&mut txn, long.as_str(), Any::Number(1.0));
    }
    hb::UTF8_READ.with(|n| n.set(0));
    let out = room.tick(200);
    let read = hb::UTF8_READ.with(|n| n.get());
    assert!(read < 64 * 1024, "{read} bytes read for UTF-8");
    assert!(out.short, "more than a tick reads: short");
}

/// Records under the longest keys a page writes (a pid of 256 UTF-16
/// units, 3 bytes each): read as ever.
#[test]
fn records_under_the_longest_keys_are_read() {
    let mut room = Room::new("longest-keys", true);
    let (alice, bob) = (who(&long_pid(1)), who(&long_pid(2)));
    {
        let mut txn = room.doc.transact_mut();
        let players = txn.get_or_insert_map("players");
        for w in [&alice, &bob] {
            players.insert(&mut txn, w.pid.as_str(), to_any(&obj(vec![("keyB64", s(&w.public))])));
        }
    }
    room.tick(0);
    assert_eq!(room.records("o:1:").len(), 1, "the house joined round 1");
    let (a, b) = (room.slip(&alice, 1), room.slip(&bob, 1));
    let c = room.close(&alice, 1, "g", &[(alice.pid.as_str(), &a), (bob.pid.as_str(), &b)], Some(&room.commit(1)));
    let longest = room.records("s:1:").iter().map(|(k, _)| k.len()).max().unwrap();
    assert!(longest > 800 && longest <= MAX_KEY_BYTES, "{longest}");
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    room.tick(200);
    assert_eq!(strs(&room.records("h:1:")[0].1, "x"), vec![c]);
}

/// A setting the house holds written over with a copy padded with a
/// `__proto__` string longer than a tick reads: the house reads none of it
/// (not even whether it is UTF-8, which would cost its bytes), neither
/// where it reads the table's setting nor where it looks to put its own
/// back, so what a page reads of it is Unknown: it holds its table and is
/// never put back over. Clean again, it stands.
#[test]
fn a_setting_padded_with_a_long_proto_string_is_read_no_further() {
    let mut room = Room::new("long-proto-setting", true);
    let (alice, bob) = (who("alice"), who("bob"));
    room.closed_on_the_join(&alice, &bob);
    room.reveal(&alice, 1);
    room.reveal(&bob, 1);
    room.tick(200);
    assert_eq!(room.records("h:1:").len(), 1);
    let rec = room_signed("hfair", T, &room.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(1)), ("s", CVal::Int(1))]));
    let key = format!("hf:{T}");
    room.put_top(&key, &rec);
    room.tick(200);
    assert_eq!(room.records("h:2:").len(), 1, "Friendly: round 2's commitment stepped down");
    let pad = Any::String(Arc::from("x".repeat(READ_PER_TICK + 1)));
    assert!(matches!(hb::weigh(&padded(&rec, pad.clone()), MAX_TOP_BYTES), hb::Weighed::Light { scan, .. } if scan > READ_PER_TICK));
    room.put_top_padded(&key, &rec, pad);
    for _ in 0..3 {
        hb::UTF8_READ.with(|n| n.set(0));
        room.tick(200);
        let read = hb::UTF8_READ.with(|n| n.get());
        assert!(read < MAX_RECORD_BYTES, "{read} bytes read for UTF-8: the padding unread");
    }
    assert!(!clean(room.raw_top(&key), &rec), "never put back over");
    room.put_top(&key, &rec);
    room.tick(200);
    room.tick(200);
    assert!(clean(room.raw_top(&key), &rec), "clean again: it stands");
}

/// A record of the house's written over with a copy padded with a
/// `__proto__` string longer than any record weighs: it goes back clean,
/// and the put-back reads none of the padding to find it is not.
#[test]
fn a_record_padded_with_a_long_proto_string_goes_back_unread() {
    let mut room = Room::new("reput-long-proto", true);
    room.tick(0);
    let (key, join) = room.records("o:1:").pop().unwrap();
    // (No table to read: only the put-back looks at it.)
    {
        let casino = room.doc.get_or_insert_map(CASINO_MAP);
        let mut txn = room.doc.transact_mut();
        casino.remove(&mut txn, &format!("cfg:computed:{T}"));
    }
    let pad = Any::String(Arc::from("x".repeat(4 * MAX_RECORD_BYTES)));
    {
        let ses = room.ses_key();
        let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = room.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
        m.insert(&mut txn, key.as_str(), padded(&join, pad));
    }
    hb::UTF8_READ.with(|n| n.set(0));
    room.tick_passes(REPUT_MS, 1);
    let read = hb::UTF8_READ.with(|n| n.get());
    assert!(read < MAX_RECORD_BYTES, "{read} bytes read for UTF-8: the padding unread");
    assert!(clean(room.raw(&key), &join), "put back");
}

/// A switch whose `inc` is no house incarnation's length: refused, and
/// nothing reads that string (not even whether it is UTF-8), however long.
#[test]
fn a_switch_whose_inc_is_no_houses_length_is_read_no_further() {
    let mut room = Room::new("switch-long-inc", true);
    room.tick(0);
    {
        let casino = room.doc.get_or_insert_map(CASINO_MAP);
        let mut txn = room.doc.transact_mut();
        casino.insert(&mut txn, format!("cfg:computed:{T}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(&"h".repeat(4 * MAX_RECORD_BYTES)))])));
    }
    for _ in 0..3 {
        hb::UTF8_READ.with(|n| n.set(0));
        room.tick(200);
        let read = hb::UTF8_READ.with(|n| n.get());
        assert!(read < MAX_RECORD_BYTES, "{read} bytes read for UTF-8: the inc unread");
    }
}

/// A heal that asks for a reread begins the table's hold then, though the
/// reread runs short of the tick's reading (a peer's junk) and the house
/// reads the table only a tick or more later: a close first seen then
/// counts as there since the heal, for the cutoff. (A record healed, and a
/// setting, which waits a pass for its check.)
#[test]
fn a_heal_whose_reread_runs_short_still_marks_when_the_hold_began() {
    for which in ["seed", "setting"] {
        let mut room = Room::new(&format!("heal-short-{which}"), true);
        let (alice, bob) = (who("alice"), who("bob"));
        room.closed_on_the_join(&alice, &bob);
        room.reveal(&alice, 1);
        let ses = room.ses_key();
        let tkey = (T.to_string(), INC.to_string());
        let junk: Vec<String>;
        if which == "seed" {
            // ~3 MB: the first pass reads it, the reread no longer can.
            junk_in(&room, &ses, 50, 60_000);
            junk = (0..50).map(|i| format!("s:1:junk{i}:{i:032x}")).collect();
            let seed = obj(vec![("r", CVal::Int(1)), ("p", s("bob")), ("s", s(&seed_of("bob", 1)))]);
            room.put_padded('x', &seed, Any::Null);
        } else {
            // ~3 MB at another table, read the pass the setting heals,
            // and ~1.5 MB at this one: more than the reread has left.
            let ses2 = second_table(&room);
            junk_in(&room, &ses2, 50, 60_000);
            junk_in(&room, &ses, 25, 60_000);
            junk = (0..25).map(|i| format!("s:1:junk{i}:{i:032x}")).collect();
            let rec = room_signed("hfair", T, &room.owner, obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(0)), ("s", CVal::Int(1))]));
            room.put_top_padded(&format!("hf:{T}"), &rec, Any::Undefined);
        }
        let out = room.tick(200);
        let healed_at = room.now;
        assert!(out.short, "{which}: the reread ran short");
        assert!(room.records("h:").is_empty());
        assert_eq!(room.house.rooms[ROOM].tables[&tkey].held_since, Some(healed_at), "{which}: held from the heal on");
        // Read again a while later: the hold over, the round revealed.
        for k in &junk {
            room.delete(k);
        }
        room.reveal(&bob, 1);
        // (The other table's junk read each pass it waits: a tick or two.)
        for _ in 0..3 {
            room.tick(1_000);
            if !room.records("h:1:").is_empty() {
                break;
            }
        }
        assert_eq!(room.records("h:1:").len(), 1, "{which}: revealed once read");
        assert_eq!(room.house.rooms[ROOM].tables[&tkey].held_since, None, "{which}: the hold over");
    }
}

/// Weighing a map with a `__proto__` field looks at each key only as far
/// as the capped loop goes, however many keys it holds (undefined ones
/// weigh little, so a peer's map may hold millions).
#[test]
fn weighing_a_map_with_a_proto_field_looks_at_its_keys_no_further_than_its_cap() {
    let mut m: HashMap<String, Any> = (0..1_000_000).map(|i| (format!("u{i}"), Any::Undefined)).collect();
    m.insert("__proto__".to_string(), Any::Null);
    m.insert("r".to_string(), Any::Number(1.0));
    let v = Any::Map(Arc::new(m));
    hb::TYPED_KEYS_READ.with(|n| n.set(0));
    assert!(matches!(hb::weigh(&v, MAX_RECORD_BYTES), hb::Weighed::Heavy | hb::Weighed::Unsure));
    let looked = hb::TYPED_KEYS_READ.with(|n| n.get());
    assert!(looked < MAX_RECORD_BYTES / 8, "{looked} keys looked at");
}

/// After a restart, a value a page may read otherwise in place of the
/// house's reveal holds the table, and the reveal goes back from the state
/// file as it would have during the run: the table is read again, and a
/// step-down then lifts round 2's commitment.
#[test]
fn after_a_restart_its_own_reveal_held_over_goes_back_from_its_state_file() {
    for step_down in [false, true] {
        let mut room = Room::new(&format!("restart-own-unknown-{step_down}"), true);
        let (alice, bob) = (who("alice"), who("bob"));
        room.closed_on_the_join(&alice, &bob);
        room.reveal(&alice, 1);
        room.reveal(&bob, 1);
        room.tick(200);
        let (key, h1) = room.records("h:1:").pop().unwrap();
        let odd = padded(&h1, Any::Undefined);
        let Any::Map(m) = odd else { unreachable!() };
        let mut m = (*m).clone();
        m.insert("7".into(), Any::Undefined);
        let odd = Any::Map(Arc::new(m));
        assert_eq!(hb::clarity(&odd), hb::Clarity::Unknown);
        {
            let ses = room.ses_key();
            let comp = room.doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = room.doc.transact_mut();
            let Some(Out::YMap(m)) = comp.get(&txn, &ses) else { panic!() };
            m.insert(&mut txn, key.as_str(), odd);
        }
        room.house = House::open(&NODE, Some(room.dir.join(STATE_FILE))).unwrap();
        room.house.settle_ms = 0;
        if step_down {
            room.house.begin_step_down();
        }
        for _ in 0..3 {
            room.tick(REPUT_MS);
        }
        assert!(clean(room.raw(&key), &h1), "{step_down}: put back from the state file");
        let tkey = (T.to_string(), INC.to_string());
        assert_eq!(room.house.rooms[ROOM].tables[&tkey].held_since, None, "{step_down}: read again");
        if step_down {
            let words = room.records("h:2:");
            let d = &words.first().expect("the step-down's word").1;
            assert!(strs(d, "x").is_empty(), "round 2's commitment stepped down");
        }
    }
}
