//! 🔒 The house at a FAIR ONLY game (letters `p`/`q`; design-final section 8.5, N1): a game opened as the owner's
//! page opens one (a root checkpoint signed by the opener, carrying the delegation of the opener's house), the
//! pages' records signed as computedTable signs them, and the rules the simulated house (computedSimHouse.ts) keeps
//! there, which this is the node's half of.

use super::tests::{obj, padded, s, scratch, seed_of, sign, sorted, strs, who, with, Who};
use super::*;
use yrs::MapPrelim;

const ROOM: &str = "room-game";
const T: &str = "roulette-1";
const NODE: [u8; 32] = [7u8; 32];
const TS: i64 = 1_700_000_000_000;

/// A delegation of house `house` by `by` (computedHouse hkey).
fn delegation(by: &Who, house: &str) -> CVal {
    let body = obj(vec![("v", CVal::Int(1)), ("h", s(house)), ("k", s(&by.public))]);
    let g = sign(by, &hb::room_sign_bytes("hkey", ROOM, "", &body).unwrap());
    with(&body, "g", s(&g))
}

struct Game {
    doc: Doc,
    owner: Who,
    house: House,
    now: u64,
    dir: PathBuf,
    ctx: Ctx,
    /// The checkpoint the live session continues from, and that session's key.
    base: CVal,
    ses: String,
}

impl Game {
    /// A roulette game the owner opened with this node's house, its first session there. The deed is `deed`'s.
    fn opened(name: &str, deed: &str) -> Self {
        Self::opened_as(name, deed, 'p')
    }

    /// The same, of the game letter `letter` names (`p` roulette, `q` craps). (The table's name says nothing of its
    /// game: the letter does.)
    fn opened_as(name: &str, deed: &str, letter: char) -> Self {
        // (Apart from the house tables' fixtures: tests run side by side.)
        let dir = scratch(&format!("game-{name}"));
        let mut house = House::open(&NODE, Some(dir.join(STATE_FILE))).unwrap();
        house.settle_ms = 0;
        house.serve_fair_only(true);
        let owner = who("owner");
        let inc = hb::faironly_inc(letter, ROOM, T, "f1", &owner.public, "0123456789abcdef", TS);
        let ctx = Ctx { room: ROOM.into(), t: T.into(), inc };
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let info = txn.get_or_insert_map("roomInfo");
            info.insert(&mut txn, "owner", Any::String(Arc::from(deed)));
            let players = txn.get_or_insert_map("players");
            for p in ["owner", "alice", "bob", "carol", "mallory", "buyer", "landlord"] {
                players.insert(&mut txn, p, to_any(&obj(vec![("keyB64", s(&who(p).public))])));
            }
            txn.get_or_insert_map(CASINO_MAP);
            txn.get_or_insert_map(COMPUTED_MAP);
        }
        let mut game = Game { doc, owner, house, now: 1_000_000, dir, ctx, base: CVal::Undef, ses: String::new() };
        let root = game.root(game.house.public(), "f1");
        game.lay(&root);
        game
    }

    fn new(name: &str) -> Self {
        Self::opened(name, "owner")
    }

    /// The opening root, naming `house` as the opener's house, under rules version `rv`.
    fn root(&self, house: &str, rv: &str) -> CVal {
        self.root_of(&self.ctx, house, rv)
    }

    /// The same for game `ctx` (at craps, with the opening carry).
    fn root_of(&self, ctx: &Ctx, house: &str, rv: &str) -> CVal {
        let mut fields = vec![
            ("v", CVal::Int(1)),
            ("ok", s(&self.owner.public)),
            ("j", s("0123456789abcdef")),
            ("rv", s(rv)),
            ("ts", CVal::Int(TS)),
            ("b", s("g")),
            ("u", CVal::Int(0)),
            ("l", s(ha::NO_CLOSE)),
            ("n", obj(vec![])),
            ("dl", delegation(&self.owner, house)),
            ("k", s(&self.owner.public)),
        ];
        if ctx.inc.starts_with('q') {
            fields.push(("s", obj(vec![("p", CVal::Int(0)), ("w", obj(vec![]))])));
        }
        let body = obj(fields);
        let g = sign(&self.owner, &hb::sign_bytes("ck", ctx, &body).unwrap());
        with(&body, "g", s(&g))
    }

    fn ck_key(&self, ck: &CVal) -> String {
        format!("ck:{T}:{}:{}", self.ctx.inc, hb::ck_id(ck).unwrap())
    }

    /// Lay checkpoint `ck` in the doc with the session it opens: the game's base from now on.
    fn lay(&mut self, ck: &CVal) {
        let sid = hb::next_sid3(&self.ctx, ck).unwrap();
        self.ses = format!("ses:{T}:{}:{sid}", self.ctx.inc);
        self.base = ck.clone();
        let key = self.ck_key(ck);
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, to_any(ck));
        comp.insert(&mut txn, self.ses.as_str(), MapPrelim::default());
    }

    fn sid(&self) -> String {
        self.ses.rsplit(':').next().unwrap().to_string()
    }

    /// The house's trim of the live session at round `u`, decided on close `l` by its reveal `reveal`, carrying
    /// the commitment `h` for the round after: signed by the house as its own node would sign one.
    fn trim(&mut self, u: i64, l: &str, reveal: &str, h: Option<&str>) {
        let dl = delegation(&self.owner, self.house.public());
        self.trim_with(u, l, reveal, h, dl, &[]);
    }

    /// The same under delegation `dl`, carrying the transfers `x` of the game's chain.
    fn trim_with(&mut self, u: i64, l: &str, reveal: &str, h: Option<&str>, dl: CVal, x: &[CVal]) {
        let ck = self.trim_ck(u, l, reveal, h, dl, x);
        self.lay(&ck);
    }

    /// That checkpoint, not laid.
    fn trim_ck(&self, u: i64, l: &str, reveal: &str, h: Option<&str>, dl: CVal, x: &[CVal]) -> CVal {
        let mut fields = vec![
            ("v", CVal::Int(1)),
            ("ok", s(&self.owner.public)),
            ("j", s("0123456789abcdef")),
            ("rv", s("f1")),
            ("ts", CVal::Int(TS)),
            ("b", s(&self.sid())),
            ("u", CVal::Int(u)),
            ("l", s(l)),
            ("d", s(&format!("h:{reveal}"))),
            ("n", obj(vec![("alice", s("5")), ("bob", s("-5"))])),
            ("dl", dl),
            ("k", s(self.house.public())),
        ];
        if let Some(h) = h {
            fields.push(("h", s(h)));
        }
        if !x.is_empty() {
            fields.push(("x", CVal::Arr(x.to_vec())));
        }
        let body = obj(fields);
        let g = self.house.key.sign(&hb::sign_bytes("ck", &self.ctx, &body).unwrap());
        with(&body, "g", s(&g))
    }

    fn put_top(&self, key: &str, v: &CVal) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, to_any(v));
    }

    fn put_top_any(&self, key: &str, v: Any) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, v);
    }

    fn delete_top(&self, key: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.remove(&mut txn, key);
    }

    fn top(&self, key: &str) -> Option<CVal> {
        let txn = self.doc.transact();
        top_value_within(&txn.get_map(COMPUTED_MAP).unwrap(), &txn, key, usize::MAX)
    }

    /// A session record signed by `w`.
    fn signed(&self, kind: &str, w: &Who, body: CVal) -> CVal {
        let body = with(&body, "k", s(&w.public));
        let g = sign(w, &hb::sign_bytes(kind, &self.ctx, &body).unwrap());
        with(&body, "g", s(&g))
    }

    /// Put a record into the live session under its own key; the key.
    fn put(&self, kind: char, v: &CVal) -> String {
        let r = v.get("r").and_then(CVal::as_int).unwrap();
        let h = hb::rec_hash(v).unwrap();
        let key = match v.get("p").and_then(CVal::as_str) {
            Some(p) if kind == 's' || kind == 'x' => format!("{kind}:{r}:{p}:{h}"),
            _ => format!("{kind}:{r}:{h}"),
        };
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &self.ses) else { panic!("no session {}", self.ses) };
        m.insert(&mut txn, key.as_str(), to_any(v));
        key
    }

    /// A slip by `w` at round r with seed seed_of(w, r), 5 on red (at craps 5 on the pass line, stamped): its hash.
    fn slip(&self, w: &Who, r: i64) -> String {
        let c = hb::slip_commit(&self.ctx, r, &w.pid, &seed_of(&w.pid, r));
        let craps = self.ctx.inc.starts_with('q');
        let b = CVal::Arr(vec![obj(vec![("type", s(if craps { "pass" } else { "red" })), ("amount", CVal::Int(5))])]);
        let mut fields = vec![("r", CVal::Int(r)), ("p", s(&w.pid)), ("v", CVal::Int(1)), ("b", b), ("c", s(&c))];
        if craps {
            fields.push(("o", s(&"ab".repeat(16))));
        }
        let rec = self.signed("slip", w, obj(fields));
        self.put('s', &rec);
        hb::rec_hash(&rec).unwrap()
    }

    fn reveal(&self, w: &Who, r: i64) {
        self.put('x', &obj(vec![("r", CVal::Int(r)), ("p", s(&w.pid)), ("s", s(&seed_of(&w.pid, r)))]));
    }

    /// A close of round r by `by`, freezing `frozen` (pid, slip hash), on parent q, naming h: its hash.
    fn close(&self, by: &Who, r: i64, q: &str, frozen: &[(&str, &str)], h: Option<&str>) -> String {
        let f = CVal::Obj(frozen.iter().map(|(p, x)| (p.to_string(), s(x))).collect());
        let mut fields = vec![("r", CVal::Int(r)), ("q", s(q)), ("f", f)];
        if let Some(h) = h {
            fields.push(("h", s(h)));
        }
        let rec = self.signed("close", by, obj(fields));
        self.put('c', &rec);
        hb::rec_hash(&rec).unwrap()
    }

    fn abandon(&self, by: &Who, r: i64, x: &str) {
        let rec = self.signed("abandon", by, obj(vec![("r", CVal::Int(r)), ("x", s(x))]));
        self.put('z', &rec);
    }

    /// Round r closed by alice on parent q naming h, alice and bob frozen, seeds not in: (close, alice's, bob's).
    fn closed(&self, r: i64, q: &str, h: &str) -> (String, String, String) {
        let (alice, bob) = (who("alice"), who("bob"));
        let (a, b) = (self.slip(&alice, r), self.slip(&bob, r));
        let c = self.close(&alice, r, q, &[("alice", &a), ("bob", &b)], Some(h));
        (c, a, b)
    }

    fn seeds(&self, r: i64) {
        self.reveal(&who("alice"), r);
        self.reveal(&who("bob"), r);
    }

    fn tick(&mut self, after: u64) -> TickOut {
        self.now += after;
        self.house.tick(ROOM, &self.doc, self.now, 1_700_000_000_000 + self.now)
    }

    /// A few ticks, 200 ms apart: a record's checks are asked for as the read comes to need them (a slip's, then the
    /// close it signed, then what decides it), each with the doc let go, so a fresh record can take more passes than
    /// one tick has.
    fn ticks(&mut self) {
        for _ in 0..3 {
            self.tick(200);
        }
    }

    /// The same for another house.
    fn ticks_of(&mut self, other: &mut House) {
        for _ in 0..3 {
            self.now += 200;
            self.tick_of(other);
        }
    }

    /// Another house's tick in the same doc, at the same moment.
    fn tick_of(&self, other: &mut House) -> TickOut {
        other.tick(ROOM, &self.doc, self.now, 1_700_000_000_000 + self.now)
    }

    /// The live session's records of a kind, by key.
    fn records(&self, prefix: &str) -> Vec<(String, CVal)> {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, &self.ses) else { return vec![] };
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

    /// Records of a kind this house (`pub_key`) signed.
    fn of(&self, prefix: &str, pub_key: &str) -> Vec<CVal> {
        self.records(prefix).into_iter().map(|(_, v)| v).filter(|v| str_of(v, "k") == Some(pub_key)).collect()
    }

    fn commit(&self, r: i64) -> String {
        self.house.commit(&self.ctx, r)
    }

    fn beat(&self) -> Option<CVal> {
        self.top(&format!("hb:{}", self.house.public()))
    }

    /// A second house, of node secret `secret`, delegated by `by` under its key in the room.
    fn second_house(&self, secret: u8, by: &Who) -> House {
        let mut other = House::open(&[secret; 32], None).unwrap();
        other.settle_ms = 0;
        other.serve_fair_only(true);
        self.put_top(&format!("hk:{}", other.public()), &delegation(by, other.public()));
        other
    }

    /// The owner's end order.
    fn fin(&self, by: &Who) {
        let body = obj(vec![("v", CVal::Int(1)), ("k", s(&by.public))]);
        let g = sign(by, &hb::sign_bytes("fin", &self.ctx, &body).unwrap());
        self.put_top(&format!("fin:{T}:{}", self.ctx.inc), &with(&body, "g", s(&g)));
    }

    /// The game handed from the owner to `to` at round `u` (a deed offer the owner made out to them, taken): the
    /// transfer.
    fn transfer(&self, to: &Who, u: i64) -> CVal {
        self.transfer_of(&self.ctx, &self.owner, to, u, "0123456789abcdef01234567")
    }

    /// Game `ctx` handed from `from` to `to` at round `u`, by an offer of nonce `nonce`: the transfer.
    fn transfer_of(&self, ctx: &Ctx, from: &Who, to: &Who, u: i64, nonce: &str) -> CVal {
        let (issued, expires) = (TS + 1_000, TS + 604_801_000);
        let bytes = hb::offer_sign_bytes(&hb::DeedOfferBytes {
            room_id: ROOM,
            room_name: "Furlong",
            maker_pub: &from.public,
            maker_name: "Maker",
            to_pub: Some(&to.public),
            to_venture_id: None,
            to_venture_name: None,
            price: 0,
            issued_at: issued,
            expires_at: expires,
            nonce,
        });
        let o = obj(vec![
            ("v", CVal::Int(1)),
            ("kind", s("transfer-offer")),
            ("asset", obj(vec![("kind", s("deed")), ("roomId", s(ROOM)), ("roomName", s("Furlong"))])),
            ("makerPub", s(&from.public)),
            ("makerName", s("Maker")),
            ("toPub", s(&to.public)),
            ("price", CVal::Int(0)),
            ("issuedAt", CVal::Int(issued)),
            ("expiresAt", CVal::Int(expires)),
            ("nonce", s(nonce)),
            ("sig", s(&hb::b64url(&from.key.sign(&bytes).to_bytes()))),
        ]);
        let body = obj(vec![("v", CVal::Int(1)), ("o", o), ("u", CVal::Int(u)), ("k", s(&to.public))]);
        let g = sign(to, &hb::sign_bytes("xf", ctx, &body).unwrap());
        let xf = with(&body, "g", s(&g));
        self.put_top(&format!("xf:{}:{}:{}", ctx.t, ctx.inc, hb::xf_id(&xf).unwrap()), &xf);
        xf
    }

    /// Round 1 joined by the house and closed on its join: (close, alice's slip, bob's slip).
    fn closed_on_the_join(&mut self) -> (String, String, String) {
        self.tick(0);
        assert_eq!(self.records("o:1:").len(), 1, "the house joined round 1");
        self.closed(1, &self.sid(), &self.commit(1))
    }
}

impl Drop for Game {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_game_is_not_served_until_the_house_is_told_to() {
    let mut game = Game::new("off");
    game.house.serve_fair_only(false);
    assert_eq!(game.tick(0).wrote, 0);
    assert_eq!(game.tick(1_000).wrote, 0);
    assert!(game.records("o:").is_empty() && game.beat().is_none());
    game.house.serve_fair_only(true);
    game.tick(1_000);
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn joins_and_reveals_at_a_game_whoever_holds_the_deed() {
    // The deed is another's, who delegated nothing, and the room holds no `hk:` key: the root's own delegation
    // makes this house the game's.
    let mut game = Game::opened("fair-only", "landlord");
    let out = game.tick(0);
    assert!(out.update.is_some() && !out.short);
    let joins = game.records("o:1:");
    assert_eq!(joins.len(), 1);
    let join = &joins[0].1;
    assert_eq!(str_of(join, "k"), Some(game.house.public()));
    assert!(hb::verify(game.house.public(), &hb::sign_bytes("hcommit", &game.ctx, join).unwrap(), str_of(join, "g").unwrap()));
    assert_eq!(str_of(join, "c"), Some(game.commit(1).as_str()));
    assert!(game.beat().is_some(), "the house is heard at the game");

    let (c, a, b) = game.closed(1, &game.sid(), &game.commit(1));
    game.tick(200);
    assert!(game.records("h:").is_empty(), "no reveal before the seeds");
    game.seeds(1);
    game.tick(200);
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    let h = &reveals[0].1;
    assert!(hb::verify(game.house.public(), &hb::sign_bytes("hreveal", &game.ctx, h).unwrap(), str_of(h, "g").unwrap()));
    assert_eq!(strs(h, "x"), vec![c.clone()]);
    assert_eq!(strs(h, "n"), sorted(vec![a, b]));
    assert_eq!(str_of(h, "c"), Some(game.commit(2).as_str()), "carries the next round's commitment");

    // Round 2 asks for that commitment: no join, and it is revealed in turn.
    for _ in 0..10 {
        game.tick(500);
    }
    assert!(game.records("o:2:").is_empty());
    let (c2, _, _) = game.closed(2, &c, &game.commit(2));
    game.seeds(2);
    game.tick(200);
    assert_eq!(strs(&game.records("h:2:")[0].1, "x"), vec![c2]);
    // (The room's own key for it is not the house's to write here.)
    assert!(game.top(&format!("hk:{}", game.house.public())).is_none());
}

#[test]
fn a_game_whose_root_names_another_house_is_not_served() {
    let mut game = Game::new("not-mine");
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = game.ck_key(&game.base.clone());
    game.delete_top(&key);
    let root = game.root(other.public(), "f1");
    game.lay(&root);
    for _ in 0..5 {
        assert_eq!(game.tick(1_000).wrote, 0);
    }
}

#[test]
fn a_game_under_rules_this_build_does_not_know_is_not_served() {
    let mut game = Game::new("newer");
    let root = game.root(game.house.public(), "f9");
    // (The name binds the rules version: another incarnation, which the kit's context follows.)
    game.ctx.inc = hb::faironly_inc('p', ROOM, T, "f9", &game.owner.public, "0123456789abcdef", TS);
    let root = { let _ = root; game.root(game.house.public(), "f9") };
    game.lay(&root);
    for _ in 0..5 {
        game.tick(1_000);
    }
    assert!(game.records("o:").is_empty(), "nothing at the game of the newer rules");
}

#[test]
fn a_close_that_names_no_commitment_is_junk_at_a_game() {
    let mut game = Game::new("s6a");
    let (c, _, _) = game.closed_on_the_join();
    // A Friendly close of the same round by a bettor with chips on: at a house table the house would refuse the
    // round (a choice it won't hand out); at a game it is no close at all.
    let mallory = who("mallory");
    let m = game.slip(&mallory, 1);
    game.close(&mallory, 1, &game.sid(), &[("mallory", &m)], None);
    game.seeds(1);
    game.tick(200);
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c]);
}

#[test]
fn a_close_more_than_the_held_rounds_past_the_base_is_junk() {
    let mut game = Game::new("s6b");
    game.tick(0);
    let mut q = game.sid();
    for r in 1..=MAX_HELD_ROUNDS + 1 {
        let (c, _, _) = game.closed(r, &q, &game.commit(r));
        game.seeds(r);
        game.tick(200);
        q = c;
    }
    assert_eq!(game.records(&format!("h:{MAX_HELD_ROUNDS}:")).len(), 1, "the last round a game may hold is revealed");
    for _ in 0..5 {
        game.tick(500);
    }
    assert!(game.records(&format!("h:{}:", MAX_HELD_ROUNDS + 1)).is_empty(), "a close past it is no close");
}

#[test]
fn an_abandoned_close_is_still_revealed_at_a_game() {
    // (Design B2: at a house table a close that already had an abandon when the house first saw it is never
    // revealed; at a game nobody but the house can decide a round, so anyone could hold it off that way.)
    let mut game = Game::new("b2");
    let (c, _, _) = game.closed_on_the_join();
    game.abandon(&who("bob"), 1, &c);
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1);
}

#[test]
fn a_close_first_seen_while_settling_is_never_revealed_and_the_house_is_unheard_until_settled() {
    let mut game = Game::new("settle");
    let (c, _, _) = game.closed_on_the_join();
    game.seeds(1);
    game.tick(200);
    let reveal = game.records("h:1:")[0].0.clone();
    let reveal = reveal.rsplit(':').next().unwrap().to_string();
    game.trim(1, &c, &reveal, Some(&game.commit(2)));
    // The node starts again (its state kept): the round after the trim is closed before it has settled.
    let mut house = House::open(&NODE, Some(game.dir.join(STATE_FILE))).unwrap();
    house.serve_fair_only(true);
    game.house = house;
    game.delete_top(&format!("hb:{}", game.house.public()));
    game.closed(2, &game.sid(), &game.commit(2));
    game.seeds(2);
    // (It settles from when it first read the game through, which takes the ticks its checks take.)
    let began = game.now;
    while game.now < began + SETTLE_MS - 200 {
        game.tick(200);
        assert!(game.beat().is_none(), "no beat while it settles at a game it serves");
    }
    for _ in 0..5 {
        game.tick(200);
    }
    assert!(game.beat().is_some(), "heard once settled");
    for _ in 0..10 {
        game.tick(1_000);
    }
    assert!(game.records("o:2:").is_empty(), "the checkpoint carries round 2's commitment: no join of it");
    assert!(game.records("h:2:").is_empty(), "a close first read while settling is never revealed");
}

#[test]
fn a_house_cut_off_for_as_long_as_the_pages_wait_settles_again() {
    for (gap, revealed) in [(HOUSE_HEARD_MS - 200, true), (HOUSE_HEARD_MS, false)] {
        let mut game = Game::new(&format!("cut-off-{gap}"));
        game.house.settle_ms = SETTLE_MS;
        game.tick(0);
        game.tick(SETTLE_MS);
        assert_eq!(game.records("o:1:").len(), 1, "joined once settled");
        // Nothing ticks the house for `gap`; a close comes meanwhile.
        game.closed(1, &game.sid(), &game.commit(1));
        game.seeds(1);
        game.tick(gap);
        game.tick(200);
        assert_eq!(game.records("h:1:").len(), usize::from(revealed), "after {gap} ms away");
        for _ in 0..8 {
            game.tick(1_000);
        }
        assert_eq!(game.records("h:1:").len(), usize::from(revealed));
    }
}

#[test]
fn a_house_back_after_a_gap_settles_from_when_it_reads_the_game_again() {
    // 🔒 Back after HOUSE_HEARD_MS to a record no reader can tell under the game's keys, which holds the game for
    // longer than it takes to settle: a close come meanwhile, which it first reads once the record is gone, it first
    // read while settling there, and never reveals. (Back sooner, it reveals it: the hold bounds how long it was there.)
    for (gap, revealed) in [(HOUSE_HEARD_MS - 200, true), (HOUSE_HEARD_MS, false)] {
        let mut game = Game::new(&format!("gap-held-{gap}"));
        game.house.settle_ms = SETTLE_MS;
        game.tick(0);
        game.tick(SETTLE_MS);
        assert_eq!(game.records("o:1:").len(), 1, "joined once settled");
        let held = game.unreadable();
        game.closed(1, &game.sid(), &game.commit(1));
        game.seeds(1);
        game.tick(gap);
        game.settle();
        assert!(game.records("h:1:").is_empty(), "nothing at the game while it is held");
        game.delete_top(&held);
        game.ticks();
        assert_eq!(game.records("h:1:").len(), usize::from(revealed), "after {gap} ms away");
        for _ in 0..8 {
            game.tick(1_000);
        }
        assert_eq!(game.records("h:1:").len(), usize::from(revealed));
    }
}

#[test]
fn under_an_end_order_it_reveals_without_a_commitment_and_joins_nothing() {
    let mut game = Game::new("fin-closed");
    let (c, _, _) = game.closed_on_the_join();
    game.fin(&who("owner"));
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c]);
    assert!(reveals[0].1.get("c").is_none(), "no commitment for a round that will not be");
    for _ in 0..5 {
        game.tick(1_000);
    }
    assert!(game.records("o:2:").is_empty() && game.records("h:2:").is_empty());
}

#[test]
fn under_an_end_order_it_steps_down_a_commitment_nobody_closed_on() {
    let mut game = Game::new("fin-open");
    game.tick(0);
    assert_eq!(game.records("o:1:").len(), 1);
    // An order that is not the holder's is nobody's.
    game.fin(&who("mallory"));
    game.tick(1_000);
    assert!(game.records("h:").is_empty());
    game.fin(&who("owner"));
    game.tick(1_000);
    let downs = game.records("h:1:");
    assert_eq!(downs.len(), 1);
    assert!(strs(&downs[0].1, "x").is_empty(), "a step-down");
    for _ in 0..5 {
        game.tick(1_000);
    }
    assert_eq!(game.records("o:").len(), 1, "no join after it");
    assert_eq!(game.records("h:").len(), 1);
}

#[test]
fn after_a_hand_over_the_sellers_house_reveals_its_round_without_a_commitment_and_the_buyers_house_joins() {
    let mut game = Game::new("hand-over");
    let (c, _, _) = game.closed_on_the_join();
    // The game changes hands at round 1, which is in flight: round 1 is still the seller's house's.
    let buyer = who("buyer");
    game.transfer(&buyer, 1);
    // The buyer's house, a house of the rounds after the hand-over: round 1 waits on the seller's house's reveal.
    let mut theirs = game.second_house(9, &buyer);
    game.ticks_of(&mut theirs);
    assert!(game.of("o:", theirs.public()).is_empty(), "round 1 is the seller's house's to reveal");
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c.clone()]);
    assert!(reveals[0].1.get("c").is_none(), "round 2 is not its own: no commitment for it");
    let beat = game.beat();
    for _ in 0..8 {
        game.tick(1_000);
    }
    assert!(game.records("o:2:").is_empty(), "the seller's house joins nothing more");
    assert_eq!(game.beat(), beat, "and is heard at the game no more");

    // Revealed: the buyer's house joins the round after.
    game.ticks_of(&mut theirs);
    let joins = game.of("o:2:", theirs.public());
    assert_eq!(joins.len(), 1, "the buyer's house joins round 2");
    let commit2 = str_of(&joins[0], "c").unwrap().to_string();
    let (c2, _, _) = game.closed(2, &c, &commit2);
    game.seeds(2);
    game.ticks_of(&mut theirs);
    let reveals = game.of("h:2:", theirs.public());
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0], "x"), vec![c2]);
    assert!(reveals[0].get("c").is_some());
    // (And the seller's house has nothing to say of round 2.)
    game.ticks();
    assert!(game.of("h:2:", game.house.public()).is_empty());
}

#[test]
fn a_house_delegated_by_a_key_the_game_has_left_serves_no_round_past_the_hand_over() {
    let mut game = Game::new("left");
    let (c, _, _) = game.closed_on_the_join();
    game.seeds(1);
    game.tick(200);
    assert_eq!(str_of(&game.records("h:1:")[0].1, "c"), Some(game.commit(2).as_str()));
    // Handed over at round 1, after its reveal: round 2 names the seller's house's commitment, which is nobody's.
    game.transfer(&who("buyer"), 1);
    game.closed(2, &c, &game.commit(2));
    game.seeds(2);
    for _ in 0..8 {
        game.tick(1_000);
    }
    assert!(game.records("h:2:").is_empty(), "round 2 is not its own to reveal");
    assert_eq!(game.records("h:").len(), 1, "nor to step down");
}

#[test]
fn a_second_house_joins_no_round_that_waits_on_the_first() {
    let mut game = Game::new("theirs");
    let owner = who("owner");
    let mut other = game.second_house(9, &owner);
    let (c, _, _) = game.closed_on_the_join();
    // Round 1 is closed on the first house's join and not revealed yet: its reveal will carry round 2's commitment.
    for _ in 0..5 {
        game.now += 1_000;
        game.tick_of(&mut other);
    }
    assert!(game.of("o:", other.public()).is_empty(), "the second house waits");
    // A stranger's abandon is nobody's (S6 d): still waiting.
    game.abandon(&who("carol"), 1, &c);
    game.ticks_of(&mut other);
    assert!(game.of("o:", other.public()).is_empty(), "an abandon from no frozen bettor counts for nothing");
    // A frozen bettor's voids the round: nothing to wait for, and round 2 wants a join.
    game.abandon(&who("bob"), 1, &c);
    game.ticks_of(&mut other);
    assert_eq!(game.of("o:2:", other.public()).len(), 1, "the second house joins round 2");
}

#[test]
fn an_abandon_decides_a_round_only_from_a_frozen_bettor() {
    // (At craps too: its slips are read by the craps rules, its felt and its stamp.)
    for (letter, who_abandons, decided) in [('p', "carol", false), ('p', "bob", true), ('q', "carol", false), ('q', "bob", true)] {
        let mut game = Game::opened_as(&format!("s6d-{letter}-{who_abandons}"), "owner", letter);
        let owner = who("owner");
        let mut other = game.second_house(9, &owner);
        // Round 1 on the first house's join, which never reveals it (the node is away).
        let (c, _, _) = game.closed_on_the_join();
        game.abandon(&who(who_abandons), 1, &c);
        game.ticks_of(&mut other);
        let joins = game.of("o:2:", other.public());
        assert_eq!(joins.len(), usize::from(decided));
        if !decided {
            continue;
        }
        // Round 2 on the second house's join, under the voided round: it is on the chain, and revealed.
        let commit2 = str_of(&joins[0], "c").unwrap().to_string();
        let (c2, _, _) = game.closed(2, &c, &commit2);
        game.seeds(2);
        game.ticks_of(&mut other);
        let reveals = game.of("h:2:", other.public());
        assert_eq!(reveals.len(), 1);
        assert_eq!(strs(&reveals[0], "x"), vec![c2]);
    }
}

#[test]
fn it_plays_on_from_the_checkpoint_its_resolution_chose() {
    let mut game = Game::new("trim");
    let (c, _, _) = game.closed_on_the_join();
    game.seeds(1);
    game.tick(200);
    let reveal = game.records("h:1:")[0].0.rsplit(':').next().unwrap().to_string();
    let old = game.ses.clone();
    game.trim(1, &c, &reveal, Some(&game.commit(2)));
    assert_ne!(game.ses, old);
    for _ in 0..5 {
        game.tick(1_000);
    }
    assert!(game.records("o:").is_empty(), "the checkpoint carries round 2's commitment: no join");
    // Round 2 in the session the checkpoint opens, on that session, naming the checkpoint's commitment.
    let (c2, _, _) = game.closed(2, &game.sid(), &game.commit(2));
    game.seeds(2);
    game.tick(200);
    let reveals = game.records("h:2:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c2]);
    assert_eq!(str_of(&reveals[0].1, "c"), Some(game.commit(3).as_str()));
}

#[test]
fn a_record_of_the_game_a_page_may_read_otherwise_holds_it_and_goes_back_as_read() {
    let mut game = Game::new("proto");
    // The root with a `__proto__` field beside its own: a page reads it as the house does, or as junk.
    let key = game.ck_key(&game.base.clone());
    game.put_top_any(&key, padded(&game.base, Any::Null));
    let out = game.tick_with_passes(0, 1);
    assert!(game.records("o:").is_empty(), "nothing at the game while a page may not count its root");
    assert!(out.wrote >= 1, "the root goes back as read");
    game.tick(200);
    assert_eq!(game.records("o:1:").len(), 1, "and the game is served once every page reads it alike");
}

#[test]
fn a_record_under_the_games_keys_that_no_reader_can_tell_holds_the_game_while_it_is_there() {
    let mut game = Game::new("unknown");
    // A transfer's key holding more padding than a small record may weigh: a page may read it light.
    let mut m: HashMap<String, Any> = HashMap::new();
    for i in 0..1_200 {
        m.insert(format!("pad{i:04}"), Any::Undefined);
    }
    let key = format!("xf:{T}:{}:{}", game.ctx.inc, "ab".repeat(16));
    game.put_top_any(&key, Any::Map(Arc::new(m)));
    for _ in 0..3 {
        game.tick(1_000);
    }
    assert!(game.records("o:").is_empty());
    game.delete_top(&key);
    game.tick(1_000);
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn a_tick_short_of_its_checks_writes_nothing_at_a_game_and_carries_on() {
    let mut game = Game::new("short");
    let out = game.tick_with_passes(0, 1);
    assert!(out.short && out.wrote == 0, "the root's signatures are checked with the doc let go");
    let out = game.tick_with_passes(200, 1);
    assert!(!out.short);
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn a_games_session_map_the_doc_lost_goes_back_with_this_houses_records_in_it() {
    // 🔒 (design-final section 8.5 N5.) In the write that puts the map back, so that a close a page puts back into it
    // is never read without the join it was made on.
    let mut game = Game::new("no-session");
    game.ticks();
    let joins: Vec<String> = game.records("o:1:").into_iter().map(|(k, _)| k).collect();
    assert_eq!(joins.len(), 1);
    let ses = game.ses.clone();
    game.delete_top(&ses);
    game.tick(REPUT_MS);
    assert!(game.has_session(), "the map goes back");
    assert_eq!(game.records("o:1:").into_iter().map(|(k, _)| k).collect::<Vec<_>>(), joins, "with its join in it");
    // (And a map it never read, of a game it is to serve: opened before it reads anything there.)
    let mut fresh = Game::new("no-session-fresh");
    let ses = fresh.ses.clone();
    fresh.delete_top(&ses);
    fresh.ticks();
    fresh.tick(REPUT_MS);
    assert!(fresh.has_session());
    fresh.ticks();
    assert_eq!(fresh.records("o:1:").len(), 1, "and joins there");
}

#[test]
fn no_session_map_goes_back_while_the_doc_holds_part_of_an_update() {
    let mut game = Game::new("partial");
    game.ticks();
    let ses = game.ses.clone();
    game.delete_top(&ses);
    let (first, second) = game.updates_out_of_order();
    game.apply_update(&second);
    assert!(game.doc.transact().store().pending_update().is_some(), "the doc holds part of an update");
    for _ in 0..3 {
        game.tick(REPUT_MS);
    }
    assert!(!game.has_session(), "the map may be in the part to come");
    game.apply_update(&first);
    assert!(game.doc.transact().store().pending_update().is_none());
    game.tick(REPUT_MS);
    assert!(game.has_session());
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn a_close_put_back_with_a_lost_session_counts_as_there_since_the_map_went() {
    // 🔒 A hold: the house read none of the game's closes while its map was gone, so one it first reads once the
    // map is back counts as there since the house found it gone, for the cutoff (the pages void a close they saw
    // that long); the hold is over at its first read of the map back. (A spell short of HOUSE_HEARD_MS: no settling
    // anew.)
    let late = REVEAL_CUTOFF_MS + 500;
    for (read_between, revealed) in [(false, false), (true, true)] {
        let mut game = Game::new(&format!("lost-map-hold-{read_between}"));
        game.ticks();
        assert_eq!(game.records("o:1:").len(), 1);
        let ses = game.ses.clone();
        game.delete_top(&ses);
        game.tick(REPUT_MS);
        assert!(game.has_session());
        if read_between {
            game.tick(200);
        }
        // A page puts back the round's close on the join, and its seeds.
        game.closed(1, &game.sid(), &game.commit(1));
        game.seeds(1);
        game.tick(if read_between { late - 200 } else { late });
        game.ticks();
        assert_eq!(game.records("h:1:").len(), usize::from(revealed), "read in between: {read_between}");
    }
}

#[test]
fn a_long_spell_without_the_session_map_counts_from_when_the_house_found_it_gone() {
    // 🔒 The map gone while the doc holds part of an update (none goes back meanwhile), for longer than the cutoff:
    // a close a page puts back once the map is back counts as there since the house first found the map gone, not
    // since it last did.
    let mut game = Game::new("lost-map-long");
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
    let ses = game.ses.clone();
    game.delete_top(&ses);
    let (first, second) = game.updates_out_of_order();
    game.apply_update(&second);
    let began = game.now;
    while game.now < began + REVEAL_CUTOFF_MS + 500 {
        game.tick(200);
    }
    assert!(!game.has_session());
    game.apply_update(&first);
    game.tick(REPUT_MS);
    assert!(game.has_session());
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    assert!(game.records("h:1:").is_empty(), "too late, as the pages count it");
}

#[test]
fn a_session_map_put_back_where_one_is_by_then_leaves_it_as_it_is() {
    // (Planned and applied in one transaction, so this is the write's own guard: a map already there keeps what it
    // holds.)
    let game = Game::new("map-guard");
    let key = game.closed(1, &game.sid(), "ab").0;
    apply(&mut game.doc.transact_mut(), &[Write::NewSession { ses: game.ses.clone() }]);
    assert!(game.records("c:").iter().any(|(k, _)| k.ends_with(&key)), "the close is still there");
}

impl Game {
    /// A tick of `passes` passes at most.
    fn tick_with_passes(&mut self, after: u64, passes: usize) -> TickOut {
        self.now += after;
        self.house.tick_with(ROOM, &self.doc, self.now, 1_700_000_000_000 + self.now, VERIFY_PER_TICK, passes)
    }
}

const T2: &str = "roulette-2";
const INC_R: &str = "r0123456789abcdef01234567";

impl Game {
    /// A house table (`r`) of the room beside the game, switched on, and the deed holder's delegation of the house
    /// under its key.
    fn add_house_table(&self) {
        self.put_top(&format!("hk:{}", self.house.public()), &delegation(&self.owner, self.house.public()));
        let mut txn = self.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        casino.insert(&mut txn, format!("cfg:computed:{T2}"), to_any(&obj(vec![("v", CVal::Int(1)), ("inc", s(INC_R))])));
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        comp.insert(&mut txn, format!("ses:{T2}:{INC_R}:g"), MapPrelim::default());
    }

    /// The house table's records of a kind.
    fn at_house_table(&self, prefix: &str) -> usize {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, &format!("ses:{T2}:{INC_R}:g")) else { return 0 };
        m.keys(&txn).filter(|k| k.starts_with(prefix)).count()
    }
}

#[test]
fn the_rooms_beat_waits_until_the_house_has_settled_at_every_game_it_serves() {
    for serve in [false, true] {
        let mut game = Game::new(&format!("room-beat-{serve}"));
        game.house.settle_ms = SETTLE_MS;
        game.house.serve_fair_only(serve);
        game.add_house_table();
        game.tick(0);
        game.tick(200);
        // (A house table alone is beaten for from the first tick, as before.)
        assert_eq!(game.beat().is_some(), !serve, "serving games: {serve}");
        let began = game.now;
        while game.now < began + SETTLE_MS + 1_000 {
            game.tick(200);
        }
        assert!(game.beat().is_some());
        assert_eq!(game.at_house_table("o:1:"), 1, "the house table is served beside the game");
        assert_eq!(game.records("o:1:").len(), usize::from(serve));
    }
}

#[test]
fn a_house_the_games_holder_delegated_in_the_room_is_a_house_of_the_game_too() {
    // The root names another house of the owner's; this one is delegated under its key in the room, for the house
    // table beside: the same holder's delegation makes it a house of the game's rounds as well.
    let mut game = Game::new("beside");
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = game.ck_key(&game.base.clone());
    game.delete_top(&key);
    let root = game.root(other.public(), "f1");
    game.lay(&root);
    for _ in 0..3 {
        assert_eq!(game.tick(200).wrote, 0, "no house of the game yet");
    }
    game.add_house_table();
    game.ticks();
    assert_eq!(game.at_house_table("o:1:"), 1);
    assert_eq!(game.records("o:1:").len(), 1);
    assert!(game.beat().is_some());
}

#[test]
fn stopping_it_steps_down_its_commitment_at_a_game() {
    let mut game = Game::new("stop");
    game.tick(0);
    assert_eq!(game.records("o:1:").len(), 1);
    game.house.begin_step_down();
    game.tick(200);
    let downs = game.records("h:1:");
    assert_eq!(downs.len(), 1);
    assert!(strs(&downs[0].1, "x").is_empty());
}

#[test]
fn a_house_of_a_key_the_game_has_left_joins_nothing_even_at_a_round_still_its_own() {
    let mut game = Game::new("left-joins");
    let (c, _, _) = game.closed_on_the_join();
    // Handed over at round 3, far ahead: rounds 2 and 3 are still the seller's house's by the chain.
    game.transfer(&who("buyer"), 3);
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(str_of(&reveals[0].1, "c"), Some(game.commit(2).as_str()), "round 2 is its own: the commitment is carried");
    // Round 2 on that commitment, voided by a frozen bettor before the house has seen it through.
    let (c2, _, _) = game.closed(2, &c, &game.commit(2));
    game.seeds(2);
    game.ticks();
    let reveals = game.records("h:2:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c2.clone()]);
    assert_eq!(str_of(&reveals[0].1, "c"), Some(game.commit(3).as_str()));
    // Round 3 is its last: revealed with no commitment for round 4, which is the buyer's.
    let (c3, _, _) = game.closed(3, &c2, &game.commit(3));
    game.seeds(3);
    game.ticks();
    let reveals = game.records("h:3:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c3]);
    assert!(reveals[0].1.get("c").is_none());
    assert!(game.records("o:").len() == 1, "and it joined nothing since the hand-over");
}

#[test]
fn a_house_of_a_key_the_game_has_left_does_not_join_a_round_of_its_own() {
    for (handed_over, joins) in [(true, 0), (false, 1)] {
        let mut game = Game::new(&format!("left-void-{handed_over}"));
        let (c, _, _) = game.closed_on_the_join();
        if handed_over {
            // Far ahead: round 2 is still the seller's house's by the chain.
            game.transfer(&who("buyer"), 3);
        }
        // The node starts again without its state and first reads round 1's close while it settles: it never
        // reveals it, the bettors void it, and round 2 wants a join.
        let mut house = House::open(&NODE, None).unwrap();
        house.serve_fair_only(true);
        game.house = house;
        game.abandon(&who("bob"), 1, &c);
        let began = game.now;
        while game.now < began + SETTLE_MS + 2_000 {
            game.tick(200);
        }
        assert!(game.records("h:").is_empty());
        assert_eq!(game.records("o:2:").len(), joins, "handed over: {handed_over}");
    }
}

#[test]
fn under_an_end_order_a_house_of_a_key_the_game_has_left_steps_down_no_commitment_of_a_round_not_its_own() {
    let mut game = Game::new("left-fin");
    let (_, _, _) = game.closed_on_the_join();
    game.seeds(1);
    game.ticks();
    assert_eq!(str_of(&game.records("h:1:")[0].1, "c"), Some(game.commit(2).as_str()));
    let buyer = who("buyer");
    game.transfer(&buyer, 1);
    game.fin(&buyer);
    for _ in 0..6 {
        game.tick(1_000);
    }
    assert_eq!(game.records("h:").len(), 1, "round 2 is the buyer's: nothing of it is this house's to open");
}

#[test]
fn a_delegation_in_the_room_a_page_may_read_otherwise_holds_its_games_and_goes_back_as_read() {
    let mut game = Game::new("hk-proto");
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = format!("hk:{}", other.public());
    game.put_top_any(&key, padded(&delegation(&game.owner, other.public()), Any::Null));
    let out = game.tick_with_passes(0, 1);
    assert!(out.wrote >= 1 && game.records("o:").is_empty());
    let back = game.top(&key).unwrap();
    assert_eq!(hb::rec_hash(&back), hb::rec_hash(&delegation(&game.owner, other.public())), "back as every page reads it");
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn its_own_delegation_in_the_room_read_otherwise_holds_the_game_until_it_is_back() {
    // The root names another house; this one is a house of the game by the delegation under its key in the room
    // alone, which a page may read as junk: the game waits for it to go back, and is served in the same tick.
    let mut game = Game::new("hk-own-proto");
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = game.ck_key(&game.base.clone());
    game.delete_top(&key);
    let root = game.root(other.public(), "f1");
    game.lay(&root);
    // (The root's checks made first: the tick that finds the delegation has nothing else to wait on.)
    game.ticks();
    assert!(game.records("o:").is_empty());
    let hk = format!("hk:{}", game.house.public());
    game.put_top_any(&hk, padded(&delegation(&game.owner, game.house.public()), Any::Null));
    game.tick(200);
    assert_eq!(hb::rec_hash(&game.top(&hk).unwrap()), hb::rec_hash(&delegation(&game.owner, game.house.public())));
    assert_eq!(game.records("o:1:").len(), 1, "read again once it is back, in the tick that put it back");
}

#[test]
fn a_delegation_key_no_reader_can_tell_holds_the_rooms_games_while_it_is_there() {
    let mut game = Game::new("hk-unknown");
    let mut m: HashMap<String, Any> = HashMap::new();
    for i in 0..1_200 {
        m.insert(format!("pad{i:04}"), Any::Undefined);
    }
    let key = format!("hk:{}", who("mallory").public);
    game.put_top_any(&key, Any::Map(Arc::new(m)));
    for _ in 0..3 {
        game.tick(1_000);
    }
    assert!(game.records("o:").is_empty());
    game.delete_top(&key);
    game.tick(1_000);
    assert_eq!(game.records("o:1:").len(), 1);
}

impl Game {
    /// The house's end of the game at its root, carrying the owner's order (design-final section 8.6), laid in the doc.
    fn end(&mut self) {
        let fin = {
            let body = obj(vec![("v", CVal::Int(1)), ("k", s(&self.owner.public))]);
            let g = sign(&self.owner, &hb::sign_bytes("fin", &self.ctx, &body).unwrap());
            with(&body, "g", s(&g))
        };
        let body = obj(vec![
            ("v", CVal::Int(1)),
            ("ok", s(&self.owner.public)),
            ("j", s("0123456789abcdef")),
            ("rv", s("f1")),
            ("ts", CVal::Int(TS)),
            ("b", s(&self.sid())),
            ("u", CVal::Int(0)),
            ("l", s(ha::NO_CLOSE)),
            ("n", obj(vec![])),
            ("e", CVal::Int(1)),
            ("f", fin),
            ("dl", delegation(&self.owner, self.house.public())),
            ("k", s(self.house.public())),
        ]);
        let g = self.house.key.sign(&hb::sign_bytes("ck", &self.ctx, &body).unwrap());
        let end = with(&body, "g", s(&g));
        assert!(matches!(ha::read_ck(ROOM, &self.ck_key(&end), &end), ha::CkRead::Ok { .. }), "the kit's end is one a page reads");
        // (With a session where one would be, were it no end.)
        self.lay(&end);
    }
}

#[test]
fn an_ended_game_is_not_served() {
    let mut game = Game::new("ended");
    game.end();
    for _ in 0..5 {
        assert_eq!(game.tick(1_000).wrote, 0);
    }
}

#[test]
fn the_buyers_house_joins_past_a_round_closed_on_the_sellers_houses_leftover_commitment() {
    let mut game = Game::new("leftover");
    let (c, _, _) = game.closed_on_the_join();
    game.seeds(1);
    game.ticks();
    assert_eq!(str_of(&game.records("h:1:")[0].1, "c"), Some(game.commit(2).as_str()));
    let buyer = who("buyer");
    game.transfer(&buyer, 1);
    let mut theirs = game.second_house(9, &buyer);
    game.ticks_of(&mut theirs);
    assert!(game.of("o:", theirs.public()).is_empty(), "round 2 asks for the commitment the seller's house's reveal carried");
    // Round 2 closed on it: nobody reveals that close (its house is none of round 2), and the round after wants a
    // join now, not once somebody has voided it.
    game.closed(2, &c, &game.commit(2));
    game.ticks_of(&mut theirs);
    assert_eq!(game.of("o:3:", theirs.public()).len(), 1);
}

#[test]
fn a_strangers_abandon_lets_no_round_be_built_on_its_close() {
    for (who_abandons, built_on) in [("carol", 0), ("bob", 1)] {
        let mut game = Game::new(&format!("s6d-decide-{who_abandons}"));
        let (c, _, _) = game.closed_on_the_join();
        // The node starts again without its state and first reads the close while it settles: never revealed.
        let mut house = House::open(&NODE, None).unwrap();
        house.serve_fair_only(true);
        game.house = house;
        game.abandon(&who(who_abandons), 1, &c);
        let began = game.now;
        while game.now < began + SETTLE_MS + 2_000 {
            game.tick(200);
        }
        assert_eq!(game.records("o:2:").len(), 1, "it joins round 2 either way");
        // Round 2 under round 1's close, on that join: on the chain only if round 1 is decided.
        let (c2, _, _) = game.closed(2, &c, &game.commit(2));
        game.seeds(2);
        game.ticks();
        assert_eq!(game.records("h:2:").len(), built_on, "{who_abandons} abandoned");
        if built_on == 1 {
            assert_eq!(strs(&game.records("h:2:")[0].1, "x"), vec![c2]);
        }
    }
}

#[test]
fn the_buyers_house_joins_no_round_the_seller_still_holds() {
    let mut game = Game::new("not-yet");
    let (c, _, _) = game.closed_on_the_join();
    let buyer = who("buyer");
    // Handed over at round 3, far ahead; round 1 is voided, and round 2, which wants a join, is the seller's.
    game.transfer(&buyer, 3);
    let mut theirs = game.second_house(9, &buyer);
    game.abandon(&who("bob"), 1, &c);
    for _ in 0..3 {
        game.ticks_of(&mut theirs);
    }
    assert!(game.of("o:", theirs.public()).is_empty());
}

#[test]
fn a_second_house_joins_once_the_first_has_revealed_with_no_commitment() {
    let mut game = Game::new("theirs-revealed");
    let owner = who("owner");
    let mut other = game.second_house(9, &owner);
    game.closed_on_the_join();
    game.seeds(1);
    // The first house is stopping: it reveals round 1 and carries nothing on.
    game.house.begin_step_down();
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert!(!strs(&reveals[0].1, "x").is_empty() && reveals[0].1.get("c").is_none());
    game.ticks_of(&mut other);
    assert_eq!(game.of("o:2:", other.public()).len(), 1, "the round is decided: nothing to wait for");
}

#[test]
fn its_records_at_a_game_go_back_whoever_holds_the_deed() {
    let mut game = Game::opened("reput", "landlord");
    game.tick(0);
    let joins = game.records("o:1:");
    assert_eq!(joins.len(), 1);
    {
        let comp = game.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = game.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &game.ses) else { panic!() };
        m.remove(&mut txn, &joins[0].0);
    }
    assert!(game.records("o:1:").is_empty());
    game.tick(REPUT_MS);
    let back = game.records("o:1:");
    assert_eq!(back.len(), 1);
    assert_eq!((&back[0].0, hb::rec_hash(&back[0].1)), (&joins[0].0, hb::rec_hash(&joins[0].1)), "the same join, back");
}

#[test]
fn a_house_tables_records_and_setting_do_not_go_back_once_the_deed_holder_is_another() {
    let mut game = Game::new("reput-rd");
    game.add_house_table();
    let fair = {
        let body = obj(vec![("v", CVal::Int(1)), ("m", CVal::Int(0)), ("s", CVal::Int(1)), ("k", s(&game.owner.public))]);
        let g = sign(&game.owner, &hb::room_sign_bytes("hfair", ROOM, T2, &body).unwrap());
        with(&body, "g", s(&g))
    };
    game.put_top(&format!("hf:{T2}"), &fair);
    game.ticks();
    assert_eq!(game.at_house_table("o:1:"), 1);
    assert_eq!(game.records("o:1:").len(), 1);
    // The deed goes to another, who delegated nothing: this house is none of the room's house tables any more,
    // and still the game's (its holder is the owner yet).
    {
        let mut txn = game.doc.transact_mut();
        let info = txn.get_or_insert_map("roomInfo");
        info.insert(&mut txn, "owner", Any::String(Arc::from("landlord")));
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        comp.remove(&mut txn, &format!("hf:{T2}"));
        comp.remove(&mut txn, &format!("hk:{}", game.house.public()));
        let Some(Out::YMap(m)) = comp.get(&txn, &format!("ses:{T2}:{INC_R}:g")) else { panic!() };
        let keys: Vec<String> = m.keys(&txn).map(str::to_string).collect();
        for k in keys {
            m.remove(&mut txn, &k);
        }
        let Some(Out::YMap(m)) = comp.get(&txn, &game.ses) else { panic!() };
        let keys: Vec<String> = m.keys(&txn).map(str::to_string).collect();
        for k in keys {
            m.remove(&mut txn, &k);
        }
    }
    for _ in 0..3 {
        game.tick(REPUT_MS);
    }
    assert_eq!(game.at_house_table("o:"), 0, "the house table's join stays gone");
    assert!(game.top(&format!("hf:{T2}")).is_none(), "its setting too");
    assert!(game.top(&format!("hk:{}", game.house.public())).is_none(), "and the old holder's delegation");
    assert_eq!(game.records("o:1:").len(), 1, "the game's join is back");
}

#[test]
fn a_house_the_holder_delegates_later_settles_at_the_game_first() {
    // The root names another house; this one reads the game while it is a house of none of its rounds, and then the
    // holder delegates it in the room: it settles from when it became a house of the game, not from its first look.
    let mut game = Game::new("delegated-later");
    game.house.settle_ms = SETTLE_MS;
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = game.ck_key(&game.base.clone());
    game.delete_top(&key);
    let root = game.root(other.public(), "f1");
    game.lay(&root);
    let began = game.now;
    while game.now < began + SETTLE_MS + 1_000 {
        assert_eq!(game.tick(200).wrote, 0, "no house of the game yet");
    }
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&game.owner, game.house.public()));
    game.ticks();
    assert!(game.records("o:").is_empty(), "settling at the game it has just become a house of");
    let began = game.now;
    while game.now < began + SETTLE_MS {
        game.tick(200);
    }
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn a_close_made_while_the_house_served_none_of_the_games_rounds_counts_as_there_since_that_began() {
    // 🔒 Settled at the game and joined at round 1, the house is handed off it at its base (no round to come is its
    // own), and then the buyer delegates it. A close on its join made in between it first reads once it serves the
    // game again, and counts as there since the spell began, for the cutoff, as after a hold: after a spell longer
    // than the cutoff it never reveals it, after a short one it does; and one made after the spell it reveals.
    let long = REVEAL_CUTOFF_MS + 1_000;
    for (spell, made_after, revealed) in [(long, false, false), (2_000, false, true), (long, true, true)] {
        let mut game = Game::new(&format!("served-again-{spell}-{made_after}"));
        game.house.settle_ms = SETTLE_MS;
        game.settle();
        assert_eq!(game.records("o:1:").len(), 1);
        let buyer = who("buyer");
        game.transfer(&buyer, 0);
        game.ticks();
        if !made_after {
            game.closed(1, &game.sid(), &game.commit(1));
            game.seeds(1);
        }
        let began = game.now;
        while game.now < began + spell {
            game.tick(200);
        }
        assert!(game.records("h:1:").is_empty(), "none of this house's rounds");
        game.put_top(&format!("hk:{}", game.house.public()), &delegation(&buyer, game.house.public()));
        game.ticks();
        if made_after {
            game.closed(1, &game.sid(), &game.commit(1));
            game.seeds(1);
        }
        game.settle();
        assert_eq!(game.records("h:1:").len(), usize::from(revealed), "a spell of {spell} ms, the close made after: {made_after}");
    }
}

#[test]
fn a_house_whose_delegation_goes_for_a_tick_reveals_the_closes_made_on_the_beat_it_gave_meanwhile() {
    // 🔒 The root names another house, and this one is a house of the game by the holder's delegation under its key,
    // which the Fair house table beside runs on too. The delegation deleted, a tick finds the game none of this
    // house's, beats for the house table, and puts the delegation back: a close made on that beat it reveals, for
    // the spell lasted a tick (it does not settle at the game again).
    let mut game = Game::new("deleg-blink");
    game.house.settle_ms = SETTLE_MS;
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = game.ck_key(&game.base.clone());
    game.delete_top(&key);
    let root = game.root(other.public(), "f1");
    game.lay(&root);
    game.add_house_table();
    game.settle();
    assert_eq!(game.records("o:1:").len(), 1, "a house of the game by the room's delegation");
    let hk = format!("hk:{}", game.house.public());
    game.delete_top(&hk);
    game.tick(HEARTBEAT_MS);
    assert!(game.top(&hk).is_some(), "put back");
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1);
}

#[test]
fn a_close_at_the_round_in_flight_it_first_reads_after_a_hand_over_it_reveals() {
    // The game handed on at round 1, which the house joined: that round is still the seller's house's to reveal, and
    // it has read the game's session all along as its house, so it does not settle there again; a close on its join
    // it first reads after the hand-over is one it reveals.
    let mut game = Game::new("in-flight-later");
    game.house.settle_ms = SETTLE_MS;
    game.settle();
    assert_eq!(game.records("o:1:").len(), 1);
    game.transfer(&who("buyer"), 1);
    game.settle();
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert!(reveals[0].1.get("c").is_none(), "no commitment for a round that is not its own");
}

#[test]
fn the_rooms_beat_goes_on_beside_a_game_it_serves_only_for_the_key_that_left() {
    // The deed holder's house table beside a game its holder handed on at the round in flight: the house serves the
    // game for that round alone, and is heard there for nobody, so the room's beat is the house table's and goes on.
    let mut game = Game::new("left-beat");
    game.add_house_table();
    game.closed_on_the_join();
    game.transfer(&who("buyer"), 1);
    game.ticks();
    for _ in 0..3 {
        let before = game.beat();
        game.tick(HEARTBEAT_MS);
        assert!(game.beat().is_some() && game.beat() != before, "beaten for the house table");
    }
}

#[test]
fn a_game_short_of_its_checks_holds_the_rooms_beat_only_while_it_settles_there() {
    for settling in [false, true] {
        let mut game = Game::new(&format!("short-beat-{settling}"));
        game.house.settle_ms = SETTLE_MS;
        game.add_house_table();
        game.settle();
        assert!(game.beat().is_some());
        // A close comes in, and the beat is due with the doc's beat gone (nothing else puts it off a pass): a tick of
        // one pass is short of the close's checks at the game it serves. Settled there, it is heard: a close it reads
        // after is one it reveals. Back after HOUSE_HEARD_MS, it settles there again, and is not.
        game.closed_on_the_join();
        game.delete_top(&format!("hb:{}", game.house.public()));
        let out = game.tick_with_passes(if settling { HOUSE_HEARD_MS } else { HEARTBEAT_MS }, 1);
        assert!(out.short);
        assert_eq!(game.beat().is_some(), !settling, "settling there again: {settling}");
        game.settle();
        assert!(game.beat().is_some());
    }
}

#[test]
fn a_game_no_pass_can_read_counts_for_the_beat_as_when_last_read_through() {
    // 🔒 Settled at the game when a pass last read it through, the beat goes on while a record no reader can tell
    // holds the game (a close it reads after is one it reveals, and a flood under one game's keys would stop the
    // room's beat). Back after HOUSE_HEARD_MS, it settles there again whether it can read the game or not: no beat
    // until it has read the game through and settled.
    let mut game = Game::new("unread-beat");
    game.house.settle_ms = SETTLE_MS;
    game.add_house_table();
    game.settle();
    assert_eq!(game.records("o:1:").len(), 1);
    let key = game.unreadable();
    for _ in 0..3 {
        let before = game.beat();
        game.tick(HEARTBEAT_MS);
        assert!(game.beat().is_some() && game.beat() != before, "heard, as settled there");
    }
    let before = game.beat();
    for _ in 0..3 {
        game.tick(HOUSE_HEARD_MS);
        assert_eq!(game.beat(), before, "not heard while it settles at a game it serves, read or not");
    }
    game.delete_top(&key);
    game.tick(200);
    assert_eq!(game.beat(), before, "read through, and settling");
    game.settle();
    assert!(game.beat().is_some() && game.beat() != before);
}

#[test]
fn after_a_start_a_game_it_revealed_at_holds_the_beat_until_it_reads_it_through_and_settles() {
    // 🔒 Its state holds round 1 revealed, with round 2's commitment, which a page may close on: started again, the
    // house has read the game through on no pass of this run, so it is one it serves and has not settled at.
    let mut game = Game::new("start-beat");
    game.add_house_table();
    game.closed_on_the_join();
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1);
    let key = game.unreadable();
    game.restart(SETTLE_MS);
    let before = game.beat();
    for _ in 0..3 {
        game.tick(HEARTBEAT_MS);
        assert_eq!(game.beat(), before, "no beat while a game it committed at is not read through");
    }
    assert!(game.at_house_table("o:") > 0, "the house table beside is served");
    game.delete_top(&key);
    game.settle();
    assert!(game.beat().is_some() && game.beat() != before);
}

#[test]
fn a_pass_that_cannot_get_to_the_changes_of_the_rooms_fair_only_records_counts_the_games_it_knows_as_when_last_read_through() {
    let mut game = Game::new("keys-spent");
    game.house.settle_ms = SETTLE_MS;
    // (A house table beside, its state holding a reveal there: a house table is none of the games.)
    game.add_house_table();
    game.house.done.insert((ROOM.into(), T2.into(), INC_R.into()), Done { r: 1, d: None, c: false, kept: Vec::new() });
    game.settle();
    assert!(game.beat().is_some());
    // More changes to the keys of games' records before each tick than a tick looks at: no pass gets to the game's
    // records. (A beat whose check is put off waits a tick here: the house table reads nothing on a pass after the
    // reads are spent.)
    let keys = game.junk_games(4_000);
    for _ in 0..2 {
        let before = game.beat();
        for _ in 0..2 {
            game.touch(&keys);
            assert!(game.tick(HEARTBEAT_MS).short && game.house.read_out);
        }
        assert!(game.beat().is_some() && game.beat() != before, "heard, as settled at the game it knows");
    }
    let before = game.beat();
    game.touch(&keys);
    game.tick(HOUSE_HEARD_MS);
    for _ in 0..3 {
        game.touch(&keys);
        game.tick(HEARTBEAT_MS);
    }
    assert_eq!(game.beat(), before, "settling there again, and not read");
    for key in &keys {
        game.delete_top(key);
    }
    game.settle();
    assert!(game.beat().is_some() && game.beat() != before);
}

#[test]
fn after_a_start_a_pass_that_cannot_get_to_the_rooms_fair_only_records_counts_a_game_it_revealed_at_as_one_it_settles_at() {
    let mut game = Game::new("start-keys-spent");
    game.add_house_table();
    game.closed_on_the_join();
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1);
    let keys = game.junk_games(4_000);
    game.restart(SETTLE_MS);
    let before = game.beat();
    for _ in 0..3 {
        game.touch(&keys);
        assert!(game.tick(HEARTBEAT_MS).short && game.house.read_out);
        assert_eq!(game.beat(), before, "no beat while a game it committed at is not read through");
    }
    for key in &keys {
        game.delete_top(key);
    }
    game.settle();
    assert!(game.beat().is_some() && game.beat() != before);
}

#[test]
fn junk_under_another_games_keys_past_a_ticks_reads_leaves_this_game_its_turns() {
    let mut game = Game::new("junk-game");
    // Three checkpoints' weight under the keys of a game named before this one: more than a tick reads.
    let junk_inc = format!("p{}", "0".repeat(24));
    let filler = "j".repeat(ha::MAX_CHECKPOINT_BYTES - 1_024);
    for i in 0..3 {
        game.put_top(&format!("ck:roulette-0:{junk_inc}:{i:032x}"), &obj(vec![("x", s(&filler))]));
    }
    // Its turns, every other tick: at the first its root's checks are asked for (the rest of the tick's reads go
    // to the junk), at the next it joins.
    for _ in 0..4 {
        assert!(game.tick(200).short);
    }
    assert_eq!(game.records("o:1:").len(), 1, "its turns came");
}

#[test]
fn a_flood_in_one_games_session_leaves_another_its_turns() {
    let mut game = Game::new("flood-games");
    let (_, ses2) = game.second_game("roulette-3", game.house.public());
    // ~6 MB of junk in the first game's session (the first by name): more than a tick reads.
    let ses = game.ses.clone();
    game.junk_in(&ses, 100, 60_000);
    for _ in 0..3 {
        assert!(game.tick(200).short);
    }
    assert_eq!(game.joins_in(&ses2), 1, "the second game had its turn");
    assert!(game.records("o:").is_empty(), "nothing at the flooded game");
}

#[test]
fn a_craps_game_reads_its_slips_by_the_craps_rules() {
    // 🔒 `q` is FAIR ONLY craps (computedFold gameOfInc): a slip carries a craps felt and its stamp `o`, which the
    // roulette rules throw out, and the house would join and never reveal.
    let mut game = Game::opened_as("craps", "owner", 'q');
    let (c, a, b) = game.closed_on_the_join();
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c]);
    assert_eq!(strs(&reveals[0].1, "n"), sorted(vec![a, b]), "both slips read");
}

#[test]
fn a_tick_whose_last_pass_only_carries_a_flooded_game_is_short_and_the_next_game_has_its_turn() {
    let mut game = Game::new("carry-short");
    let (_, ses2) = game.second_game("roulette-3", game.house.public());
    game.ticks();
    assert_eq!(game.joins_in(&ses2), 1);
    // Junk past a tick's reads in the second game's session, and the tick starting there. Each tick beats, on a pass
    // of its own (its check of the doc's beat is made with the doc let go), which reads no game: the tick is short
    // all the same, and the first game has its turns, every other tick (a fresh record's checks are asked for one
    // turn after another: the slips', the close's, and what decides it).
    game.junk_in(&ses2, 100, 60_000);
    game.house.rooms.get_mut(ROOM).unwrap().turn = 1;
    let (c, _, _) = game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    for _ in 0..10 {
        assert!(game.tick(HEARTBEAT_MS).short);
    }
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1, "revealed in its turn");
    assert_eq!(strs(&reveals[0].1, "x"), vec![c]);
}

#[test]
fn a_transfer_or_an_end_order_a_page_may_read_otherwise_holds_the_game_and_goes_back_as_read() {
    for kind in ["xf", "fin"] {
        let mut game = Game::new(&format!("proto-{kind}"));
        game.ticks();
        assert_eq!(game.records("o:1:").len(), 1);
        if kind == "xf" {
            game.transfer(&who("buyer"), 5);
        } else {
            game.fin(&who("owner"));
        }
        let key = game.top_keys(&format!("{kind}:")).pop().unwrap();
        let v = game.top(&key).unwrap();
        game.put_top_any(&key, padded(&v, Any::Null));
        assert!(game.tick_with_passes(200, 1).wrote >= 1);
        assert_eq!(hb::rec_hash(&game.top(&key).unwrap()), hb::rec_hash(&v), "back as read: {kind}");
    }
}

#[test]
fn a_game_whose_records_wait_on_a_check_holds_the_beat_while_it_settles_there() {
    let mut game = Game::new("pending-beat");
    game.house.settle_ms = SETTLE_MS;
    game.add_house_table();
    game.settle();
    assert!(game.beat().is_some());
    // A transfer comes in as the house comes back after HOUSE_HEARD_MS: on the tick's one pass its check is put off,
    // so the walk cannot tell whose the game is, and it settles there again: not heard. (The doc's beat gone: nothing
    // else puts the beat off a pass.)
    game.transfer(&who("buyer"), 5);
    game.delete_top(&format!("hb:{}", game.house.public()));
    assert!(game.tick_with_passes(HOUSE_HEARD_MS, 1).short);
    assert!(game.beat().is_none());
}

#[test]
fn a_game_it_serves_without_its_session_holds_the_beat_when_a_pass_cannot_read_it_either() {
    let mut game = Game::new("no-session-unread");
    game.add_house_table();
    let ses = game.ses.clone();
    game.delete_top(&ses);
    game.ticks();
    assert!(game.beat().is_none(), "not heard while a game it serves has no session it can read");
    // A record no reader can tell under the game's keys: the game counts as it was last read through.
    game.unreadable();
    for _ in 0..3 {
        game.tick(HEARTBEAT_MS);
    }
    assert!(game.beat().is_none());
}

#[test]
fn a_game_handed_on_is_counted_as_none_of_this_houses_from_its_next_read() {
    let mut game = Game::new("left-unread");
    game.house.settle_ms = SETTLE_MS;
    game.add_house_table();
    game.settle();
    let (_, _, _) = game.closed(1, &game.sid(), &game.commit(1));
    game.ticks();
    // Handed on at round 1, with a slip at round 2 come in: two ticks of one pass are short of the transfer's checks
    // (asked one after the other). On the next, the walk knows the game is not this house's now and is short of the
    // slip's check: none it serves, though it had settled there, so the house table's beat goes on. (The doc's beat
    // gone: no check of it to wait on.)
    game.tick(HEARTBEAT_MS);
    game.transfer(&who("buyer"), 1);
    let carol = who("carol");
    game.slip(&carol, 2);
    for _ in 0..2 {
        assert!(game.tick_with_passes(200, 1).short);
    }
    let before = game.beat();
    game.delete_top(&format!("hb:{}", game.house.public()));
    assert!(game.tick_with_passes(HEARTBEAT_MS - 400, 1).short);
    assert!(game.beat().is_some() && game.beat() != before, "heard: the game is not this house's now");
    // Read through as one it does not serve: after a gap of HOUSE_HEARD_MS, with a record no reader can tell under
    // its keys, it is still none of this house's, and holds no beat.
    game.ticks();
    game.unreadable();
    let before = game.beat();
    game.tick(HOUSE_HEARD_MS);
    for _ in 0..2 {
        game.tick(HEARTBEAT_MS);
    }
    assert!(game.beat().is_some() && game.beat() != before, "the house table's beat");
}

#[test]
fn after_a_start_a_game_whose_rounds_past_its_base_are_not_this_houses_holds_no_beat_while_a_pass_cannot_read_it() {
    let mut game = Game::new("start-left");
    game.add_house_table();
    let (c, _, _) = game.closed_on_the_join();
    game.seeds(1);
    game.ticks();
    let reveal = game.records("h:1:")[0].0.rsplit(':').next().unwrap().to_string();
    // The house's trim at round 1, and the game handed on there: no round past the base is this house's. Started
    // again, its state holds round 1 revealed; read through, the game is none of this house's, and stays so.
    game.trim(1, &c, &reveal, None);
    game.transfer(&who("buyer"), 1);
    game.restart(0);
    game.ticks();
    game.unreadable();
    let before = game.beat();
    for _ in 0..2 {
        game.tick(HEARTBEAT_MS);
    }
    assert!(game.beat().is_some() && game.beat() != before, "the house table's beat");
}

#[test]
fn a_game_whose_first_read_is_short_of_a_check_counts_as_one_it_serves_and_has_not_settled_at() {
    // (And so when the tick's second pass can read nothing: the first spent the tick's reads on the games named after
    // it.)
    for flooded in [false, true] {
        let mut game = Game::new(&format!("new-short-{flooded}"));
        game.ticks();
        assert!(game.beat().is_some());
        // A second game, whose root names another house: none of this house's yet.
        let other = House::open(&[9u8; 32], None).unwrap();
        let (ctx2, ses2) = game.second_game("roulette-3", other.public());
        game.ticks();
        // The holder delegates this house in the room, and a round closes at the second game. Both passes of the
        // tick know this house serves the game (the delegation is the one the first game's root carries), and are
        // short of the close's checks (its own, then its slips'): not settled there, so not heard. (The doc's beat
        // gone: no check of it to wait on.)
        game.tick(HEARTBEAT_MS);
        game.put_top(&format!("hk:{}", game.house.public()), &delegation(&game.owner, game.house.public()));
        let (ctx, ses) = (std::mem::replace(&mut game.ctx, ctx2.clone()), std::mem::replace(&mut game.ses, ses2.clone()));
        game.closed(1, &game.sid(), &"ab".repeat(32));
        (game.ctx, game.ses) = (ctx, ses);
        // (Flooded: the end orders of many games no root opened, named after both games, which the first pass reads
        // after them with what is left of the tick's reads, and which leave the second nothing.)
        let keys = if flooded { game.junk_games(2_000) } else { Vec::new() };
        game.house.rooms.get_mut(ROOM).unwrap().turn = 0;
        game.delete_top(&format!("hb:{}", game.house.public()));
        let before = game.beat();
        game.tick_with_passes(HEARTBEAT_MS, 2);
        assert_eq!(game.beat(), before, "flooded: {flooded}");
        assert_eq!(game.house.read_out, flooded);
        for key in &keys {
            game.delete_top(key);
        }
        // On the next tick a record no reader can tell holds the second game: it counts as the walk last found it,
        // one it serves and has not settled at, so still not heard.
        let ctx = std::mem::replace(&mut game.ctx, ctx2);
        let held = game.unreadable();
        game.ctx = ctx;
        game.tick(HEARTBEAT_MS);
        assert_eq!(game.beat(), before, "held after a short read, flooded: {flooded}");
        game.delete_top(&held);
        // Read through: it joins, and is heard.
        game.ticks();
        assert_eq!(game.joins_in(&ses2), 1);
        game.tick(HEARTBEAT_MS);
        game.tick(HEARTBEAT_MS);
        assert!(game.beat() != before);
    }
}

impl Game {
    /// Ticks of 200 ms for SETTLE_MS and a second: read through and settled.
    fn settle(&mut self) {
        let began = self.now;
        while self.now < began + SETTLE_MS + 1_000 {
            self.tick(200);
        }
    }

    /// A record under one of the game's keys that no reader can tell (more padding than a small record may weigh: a
    /// page may read it light), holding the game while it is there: its key.
    fn unreadable(&self) -> String {
        let mut m: HashMap<String, Any> = HashMap::new();
        for i in 0..1_200 {
            m.insert(format!("pad{i:04}"), Any::Undefined);
        }
        let key = format!("xf:{}:{}:{}", self.ctx.t, self.ctx.inc, "cd".repeat(16));
        self.put_top_any(&key, Any::Map(Arc::new(m)));
        key
    }

    /// The node started again with its state, settling for `settle_ms`.
    fn restart(&mut self, settle_ms: u64) {
        let mut house = House::open(&NODE, Some(self.dir.join(STATE_FILE))).unwrap();
        house.settle_ms = settle_ms;
        house.serve_fair_only(true);
        self.house = house;
    }

    /// A second game of the room, at table `t`, opened as the first, naming `house`: it, and its live session's key.
    fn second_game(&self, t: &str, house: &str) -> (Ctx, String) {
        let inc = hb::faironly_inc('p', ROOM, t, "f1", &self.owner.public, "0123456789abcdef", TS);
        let ctx = Ctx { room: ROOM.into(), t: t.into(), inc };
        let root = self.root_of(&ctx, house, "f1");
        let ses = format!("ses:{t}:{}:{}", ctx.inc, hb::next_sid3(&ctx, &root).unwrap());
        self.put_top(&format!("ck:{t}:{}:{}", ctx.inc, hb::ck_id(&root).unwrap()), &root);
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, ses.as_str(), MapPrelim::default());
        (ctx, ses)
    }

    /// `n` junk records of `bytes` bytes each in session `ses`, under slips' keys.
    fn junk_in(&self, ses: &str, n: usize, bytes: usize) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        let filler = "j".repeat(bytes);
        for i in 0..n {
            m.insert(&mut txn, format!("s:1:junk{i}:{i:032x}"), to_any(&obj(vec![("r", CVal::Int(1)), ("x", s(&filler))])));
        }
    }

    /// `n` end orders of games no root opened (a kilobyte's key each, named after every game here), whose keys the
    /// room's index follows: their keys.
    fn junk_games(&self, n: usize) -> Vec<String> {
        let keys: Vec<String> = (0..n).map(|i| format!("fin:zz{i:04}{}:p{}", "k".repeat(980), "0".repeat(24))).collect();
        assert!(keys.iter().all(|k| k.len() <= MAX_KEY_BYTES));
        self.touch(&keys);
        keys
    }

    /// Each of `keys` written again (true): a change the room's index looks at on the next pass.
    fn touch(&self, keys: &[String]) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        for key in keys {
            comp.insert(&mut txn, key.as_str(), Any::Bool(true));
        }
    }

    /// Each of `keys` taken out of the room: a change the room's index looks at on the next pass, as one put in is.
    fn untouch(&self, keys: &[String]) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        for key in keys {
            comp.remove(&mut txn, key);
        }
    }

    /// The room's keys under `prefix`, in order.
    fn top_keys(&self, prefix: &str) -> Vec<String> {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let mut keys: Vec<String> = comp.keys(&txn).filter(|k| k.starts_with(prefix)).map(str::to_string).collect();
        keys.sort();
        keys
    }

    /// This house's joins of round 1 in session `ses`.
    fn joins_in(&self, ses: &str) -> usize {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { return 0 };
        m.keys(&txn).filter(|k| k.starts_with("o:1:")).count()
    }
}

#[test]
fn keys_of_no_game_cost_the_walk_nothing_whatever_their_number() {
    // 🔒 Some 60,000 keys of the room's, more visits than a tick has reads for, under no name of a game's record: the
    // walk once listed them all each pass, and no game was reached. Now only the first pass after a start lists them
    // (charged, so that tick reads no game); every tick after it reaches the game.
    let mut game = Game::new("index-keys");
    game.ticks();
    {
        let comp = game.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = game.doc.transact_mut();
        for i in 0..60_000 {
            comp.insert(&mut txn, format!("zz{i:05}"), Any::Bool(true));
        }
    }
    let visits: usize = (0..60_000).map(|i| format!("zz{i:05}").len() + VISIT_BYTES).sum();
    assert!(visits > READ_PER_TICK, "more than a tick visits");
    let (c, _, _) = game.closed_on_the_join();
    assert!(!game.house.read_out);
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c.clone()]);
    // After a start: the listing spends the tick, and the next reads the game.
    game.restart(0);
    assert!(game.tick(200).short && game.house.read_out, "the first pass lists the room's keys");
    let (c2, _, _) = game.closed(2, &c, &game.commit(2));
    game.seeds(2);
    game.ticks();
    assert!(!game.house.read_out);
    let reveals = game.records("h:2:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c2]);
}

#[test]
fn junk_under_many_delegation_keys_is_read_once_and_the_games_go_on() {
    // 🔒 Some 600 houses' keys holding junk of a small record's weight, more than a tick reads: the walk once read
    // them all each pass, and no game was reached. Now each is read once (over the ticks the reads allow), and again
    // only when it changes.
    let mut game = Game::new("index-hk");
    game.ticks();
    let filler = "j".repeat(8_000);
    let keys: Vec<String> = (0..600).map(|i| format!("hk:{}", who(&format!("junk{i}")).public)).collect();
    for key in &keys {
        game.put_top_any(key, Any::String(Arc::from(filler.as_str())));
    }
    let weight: usize = keys.iter().map(|k| k.len() + VISIT_BYTES + filler.len() + 2).sum();
    assert!(weight > READ_PER_TICK, "more than a tick reads");
    let mut short = 0;
    while game.tick(200).short {
        short += 1;
        assert!(short < 5, "read within a few ticks");
    }
    assert!(short >= 1, "not all in one");
    let (c, _, _) = game.closed_on_the_join();
    game.seeds(1);
    for _ in 0..3 {
        assert!(!game.tick(200).short);
    }
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c]);
    // (One changed: that one is read again, and the rest are not.)
    let left = |game: &mut Game| {
        game.now += 200;
        game.house.tick_with(ROOM, &game.doc, game.now, 1_700_000_000_000 + game.now, VERIFY_PER_TICK, 1);
        READ_PER_TICK - game.house.read_left
    };
    let quiet = left(&mut game);
    assert_eq!(left(&mut game), quiet, "the same, tick after tick");
    game.put_top_any(&keys[7], Any::String(Arc::from(filler.as_str())));
    let one = left(&mut game);
    // (Its key looked at, then its value read: the key and a visit each, and the value's weight.)
    assert_eq!(one - quiet, 2 * (keys[7].len() + VISIT_BYTES) + filler.len() + 2);
}

#[test]
fn the_index_follows_the_rooms_doc_while_it_serves_the_games() {
    // 🔒 Another doc of the room (the room loaded again): the index follows it, and a game opened there is joined.
    // Not serving the games: no index, which would only grow.
    let mut game = Game::new("index-doc");
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
    let doc = Doc::new();
    {
        use yrs::updates::decoder::Decode;
        let update = game.doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
        doc.transact_mut().apply_update(yrs::Update::decode_v1(&update).unwrap()).unwrap();
    }
    game.doc = doc;
    game.ticks();
    let (_, ses2) = game.second_game("roulette-3", game.house.public());
    game.ticks();
    assert_eq!(game.joins_in(&ses2), 1, "the game opened in the other doc");
    game.house.serve_fair_only(false);
    game.tick(200);
    assert!(game.house.rooms[ROOM].index.is_none());
    game.house.serve_fair_only(true);
    game.tick(200);
    assert!(game.house.rooms[ROOM].index.is_some());
}

#[test]
fn games_that_have_nothing_for_this_house_are_read_once_until_their_records_change() {
    // 🔒 Many end orders of games no root opened: each such game is read once, and passed by after that, so the
    // game the house serves is reached on every tick; one that comes to have a root is read again.
    let mut game = Game::new("index-quiet");
    game.ticks();
    let keys = game.junk_games(3_000);
    let mut short = 0;
    while game.tick(200).short {
        short += 1;
        assert!(short < 5, "read within a few ticks");
    }
    assert!(short >= 1, "not all in one");
    let quiet = game.house.rooms[ROOM].index.as_ref().unwrap().games.values().filter(|g| g.quiet == Some(Quiet::Records)).count();
    assert_eq!(quiet, 3_000);
    assert_eq!(game.house.rooms[ROOM].index.as_ref().unwrap().awake.len(), 1, "only the game it serves is read");
    let (c, _, _) = game.closed_on_the_join();
    game.seeds(1);
    for _ in 0..3 {
        assert!(!game.tick(200).short);
        assert!(READ_PER_TICK - game.house.read_left < 1024 * 1024, "the junk games cost nothing");
    }
    assert_eq!(strs(&game.records("h:1:")[0].1, "x"), vec![c]);
    // A game this house is no house of (its root names another): passed by too, until a delegation of this house
    // comes under its key; then read again, and joined.
    let other = House::open(&[9u8; 32], None).unwrap();
    let (_, ses2) = game.second_game("roulette-3", other.public());
    game.ticks();
    let key2 = game.house.rooms[ROOM].index.as_ref().unwrap().games.keys().find(|k| k.0 == "roulette-3").cloned().unwrap();
    assert!(matches!(game.house.rooms[ROOM].index.as_ref().unwrap().games[&key2].quiet, Some(Quiet::Mine(_))));
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&game.owner, game.house.public()));
    game.ticks();
    assert_eq!(game.joins_in(&ses2), 1, "read again, and joined");
    // (And a game whose only record was junk, given its root: read again, and joined.)
    let t3 = "roulette-4";
    let inc3 = hb::faironly_inc('p', ROOM, t3, "f1", &game.owner.public, "0123456789abcdef", TS);
    game.put_top_any(&format!("fin:{t3}:{inc3}"), Any::Bool(true));
    game.tick(200);
    let key3 = (t3.to_string(), inc3.clone());
    assert_eq!(game.house.rooms[ROOM].index.as_ref().unwrap().games[&key3].quiet, Some(Quiet::Records));
    let (_, ses3) = game.second_game(t3, game.house.public());
    game.ticks();
    assert_eq!(game.joins_in(&ses3), 1, "read again, and joined");
    let _ = keys;
}

#[test]
fn games_that_have_nothing_for_this_house_take_no_turns() {
    // 🔒 Many games found to have nothing for this house, after two it serves: the turns are the two games' alone, so a
    // flood past a tick's reads at the first leaves the second a turn the tick after. (Had each game a turn, the
    // second's would come round only once in as many short ticks as there are games.)
    let mut game = Game::new("index-turns");
    game.ticks();
    let keys = game.junk_games(3_000);
    for _ in 0..5 {
        if !game.tick(200).short {
            break;
        }
    }
    // (The flooded game first by name, the one opened now right after it, then the games it found nothing for; the turn
    // passed on twice, as after two short ticks: with the turns the two games' alone, at the flooded game again.)
    let ses = game.ses.clone();
    game.junk_in(&ses, 100, 60_000);
    let (_, ses2) = game.second_game("roulette-2", game.house.public());
    for _ in 0..2 {
        game.house.rooms.get_mut(ROOM).unwrap().index.as_mut().unwrap().pass_turn();
    }
    for _ in 0..6 {
        assert!(game.tick(200).short);
    }
    assert_eq!(game.joins_in(&ses2), 1, "the second game had its turns");
    let _ = keys;
}

#[test]
fn a_pass_looks_at_no_more_games_than_it_reads() {
    // 🔒 Once the tick's reads are spent, the games after it cost a pass nothing, not even a look: each of many games
    // is looked at about once, as it is read, though they take some ticks.
    let mut game = Game::new("index-looks");
    game.ticks();
    game.junk_games(3_000);
    game.house.games_looked.clear();
    let mut short = 0;
    while game.tick(200).short {
        short += 1;
        assert!(short < 5, "read within a few ticks");
    }
    assert!(short >= 1, "not all in one");
    let looked: usize = game.house.games_looked.iter().filter(|(t, _)| t.starts_with("zz")).map(|(_, n)| n).sum();
    assert!(looked < 3_000 + 50, "{looked}");
}

#[test]
fn only_a_good_delegation_a_holder_signed_under_this_houses_key_wakes_a_game_of_none_of_its_rounds() {
    // 🔒 A game none of whose rounds are this house's (its root names another): not looked at again while this house's
    // key holds a delegation whose signature fails, however often it changes, or a good one of a key holding none of
    // its rounds; read again, and joined, once its holder's is there.
    let mut game = Game::new("hk-wakes");
    game.ticks();
    let other = House::open(&[9u8; 32], None).unwrap();
    let (_, ses2) = game.second_game("roulette-3", other.public());
    game.ticks();
    let looks = |game: &Game| game.house.games_looked.get("roulette-3").copied().unwrap_or(0);
    let before = looks(&game);
    assert!(before >= 1);
    let hk = format!("hk:{}", game.house.public());
    let me = game.house.public().to_string();
    let stranger = who("stranger");
    for i in 0u8..3 {
        // (The holder's, it says; signed by another.)
        let forged = with(&delegation(&game.owner, &me), "g", s(&sign(&stranger, &[i; 32])));
        game.put_top(&hk, &forged);
        game.ticks();
    }
    game.put_top(&hk, &delegation(&stranger, &me));
    game.ticks();
    assert_eq!(looks(&game), before, "not looked at again");
    assert_eq!(game.joins_in(&ses2), 0);
    game.put_top(&hk, &delegation(&game.owner, &me));
    game.ticks();
    assert!(looks(&game) > before);
    assert_eq!(game.joins_in(&ses2), 1, "read again, and joined");
}

#[test]
fn a_delegation_under_this_houses_key_wakes_a_game_its_signer_held_and_handed_on() {
    // 🔒 Rounds still to be played are an earlier holder's before a hand-over to come: the game wakes for a delegation of
    // this house that holder signed, not only for one of the holder's now (and is this house's for those rounds).
    let mut game = Game::new("hk-wakes-seller");
    game.ticks();
    let other = House::open(&[9u8; 32], None).unwrap();
    let (ctx2, _) = game.second_game("roulette-3", other.public());
    game.transfer_of(&ctx2, &game.owner, &who("buyer"), 5, "fedcba9876543210fedcba98");
    game.ticks();
    let key2 = (ctx2.t.clone(), ctx2.inc.clone());
    let quiet = |game: &Game| game.house.rooms[ROOM].index.as_ref().unwrap().games[&key2].quiet.clone();
    assert!(matches!(quiet(&game), Some(Quiet::Mine(holders)) if holders.len() == 2), "both its holders");
    let looks = |game: &Game| game.house.games_looked.get("roulette-3").copied().unwrap_or(0);
    let before = looks(&game);
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&game.owner, game.house.public()));
    game.ticks();
    assert!(looks(&game) > before, "read again");
    assert_eq!(quiet(&game), None, "and served");
}

#[test]
fn a_pass_short_of_this_houses_own_key_wakes_no_game() {
    // 🔒 What stands under it not read yet (the tick's reads spent on other houses' keys before it): as it was, so the
    // pass after, reading it as it stood, wakes nothing (here a game handed on at its first round, which the good
    // delegation under the key, of its first holder, does not make this house's).
    let mut game = Game::new("hk-own-unread");
    game.ticks();
    game.transfer(&who("buyer"), 0);
    let me = game.house.public().to_string();
    let hk = format!("hk:{me}");
    game.put_top(&hk, &delegation(&game.owner, &me));
    game.ticks();
    assert!(!game.tick(200).short);
    let looks = |game: &Game| game.house.games_looked.get(T).copied().unwrap_or(0);
    let before = looks(&game);
    // Other houses' keys before it, more than a tick reads, and it written again as it was.
    let filler = "j".repeat(8_000);
    let below: Vec<String> = (0..20_000).map(|i| format!("hk:{}", who(&format!("junk{i}")).public)).filter(|k| *k < hk).take(600).collect();
    assert_eq!(below.len(), 600);
    for key in &below {
        game.put_top_any(key, Any::String(Arc::from(filler.as_str())));
    }
    game.put_top(&hk, &delegation(&game.owner, &me));
    assert!(game.tick_with_passes(200, 1).short);
    assert!(matches!(game.house.rooms[ROOM].index.as_ref().unwrap().hk[&hk], Hk::Unread), "not read");
    while game.tick(200).short {}
    assert_eq!(looks(&game), before, "no game woken");
}

#[test]
fn a_pass_that_cannot_check_the_delegation_under_this_houses_key_yet_is_short() {
    // 🔒 A game it may wake waits for that check, and may be this house's: the pass that could not make it is short. Once
    // made, the game is read, and joined. (Another opener's game, whose delegation of this house no pass has checked.)
    let mut game = Game::new("hk-check-waits");
    game.ticks();
    let other = House::open(&[9u8; 32], None).unwrap();
    let owner = std::mem::replace(&mut game.owner, who("ann"));
    let (_, ses2) = game.second_game("roulette-3", other.public());
    game.owner = owner;
    game.ticks();
    assert!(!game.tick(200).short);
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&who("ann"), game.house.public()));
    assert!(game.tick_with_checks(200, 0, 1).short, "no check to be had");
    assert_eq!(game.joins_in(&ses2), 0);
    game.ticks();
    assert_eq!(game.joins_in(&ses2), 1, "read, and joined");
}

impl Game {
    /// A tick of `passes` passes at most, with `checks` signature checks a pass.
    fn tick_with_checks(&mut self, after: u64, checks: usize, passes: usize) -> TickOut {
        self.now += after;
        self.house.tick_with(ROOM, &self.doc, self.now, 1_700_000_000_000 + self.now, checks, passes)
    }
}

#[test]
fn a_close_first_read_after_a_spell_with_no_base_counts_as_there_since_the_spell_began() {
    // 🔒 A hold: while the doc held no base of the game (the game passed by till a record of it changes; or no record
    // of it at all), the house read none of its closes, so one it first reads once the base is back counts as there
    // since the house found it gone, for the cutoff (the pages void a close they saw that long), as after its
    // session's map was gone. (Back soon: revealed.)
    let late = REVEAL_CUTOFF_MS + 500;
    for (left, wait, revealed) in [(true, 200, true), (true, late, false), (false, 200, true), (false, late, false)] {
        let mut game = Game::new(&format!("lost-base-hold-{left}-{wait}"));
        game.ticks();
        assert_eq!(game.records("o:1:").len(), 1);
        let inc = game.ctx.inc.clone();
        let base_key = format!("ck:{T}:{inc}:{}", hb::ck_id(&game.base).unwrap());
        assert_eq!(game.top_keys("ck:"), vec![base_key.clone()]);
        if left {
            // (A record of the game left: junk under its end order's key, which every page reads alike, there a tick
            // before, so the game never has no record at all.)
            game.put_top(&format!("fin:{T}:{inc}"), &obj(vec![("x", s("junk"))]));
            game.tick(200);
        }
        game.delete_top(&base_key);
        game.tick(200);
        let key = (T.to_string(), inc.clone());
        let quiet = game.house.rooms[ROOM].index.as_ref().unwrap().games.get(&key).map(|g| g.quiet.clone());
        assert_eq!(quiet, left.then_some(Some(Quiet::Records)));
        // A page puts back the round's close on the join, and its seeds; then the base.
        game.closed(1, &game.sid(), &game.commit(1));
        game.seeds(1);
        game.tick(wait);
        let base = game.base.clone();
        game.put_top(&base_key, &base);
        game.ticks();
        assert_eq!(game.records("h:1:").len(), usize::from(revealed), "a record left: {left}, back after {wait} ms");
    }
}

#[test]
fn a_value_under_a_houses_key_that_names_it_and_is_no_delegation_is_kept_as_nothing() {
    // 🔒 Read once, and kept as nothing a game goes by: not given to a game, nor weighed again, pass after pass.
    let mut game = Game::new("hk-shape");
    game.ticks();
    let (junk_house, other) = (who("junk-house"), who("other-house"));
    let junk_key = format!("hk:{}", junk_house.public);
    game.put_top(&junk_key, &obj(vec![("h", s(&junk_house.public)), ("x", s(&"j".repeat(8_000)))]));
    let good = delegation(&game.owner, &other.public);
    let good_key = format!("hk:{}", other.public);
    game.put_top(&good_key, &good);
    game.ticks();
    let ix = game.house.rooms[ROOM].index.as_ref().unwrap();
    assert_eq!(ix.hk[&junk_key], Hk::Nothing);
    // (As read back from the doc: its fields in the doc's order, its hash the same.)
    let hash = hb::rec_hash(&good).unwrap();
    assert!(matches!(&ix.hk[&good_key], Hk::Theirs(v, h) if *h == hash && hb::rec_hash(v).as_ref() == Some(&hash)));
    assert_eq!(delegation_of(&ix.hk, &other.public).map(|(_, h)| h), Some(hash.as_str()));
    assert_eq!(delegation_of(&ix.hk, &junk_house.public), None);
}

#[test]
fn a_pass_short_of_the_rooms_delegations_is_short_though_no_game_it_knows_is_this_houses() {
    // 🔒 Short, so the next tick carries on (and a step-down's last word reads the room in full): a delegation it has
    // not read may be one it is to put back as read.
    let mut game = Game::new("hk-behind");
    game.ticks();
    game.transfer(&who("buyer"), 0);
    game.ticks();
    assert!(!game.tick(200).short, "a game handed on: nothing for this house");
    let filler = "j".repeat(8_000);
    for i in 0..600 {
        game.put_top_any(&format!("hk:{}", who(&format!("junk{i}")).public), Any::String(Arc::from(filler.as_str())));
    }
    let mut short = 0;
    while game.tick(200).short {
        short += 1;
        assert!(short < 5, "read within a few ticks");
    }
    assert!(short >= 1, "not all in one");
}

#[test]
fn a_pass_behind_the_changes_of_the_rooms_fair_only_records_is_short_though_no_game_it_knows_is_this_houses() {
    // 🔒 Short, so the next tick carries on (and a step-down's last word reads the room in full): a change it has not
    // got to may be one that gives a game to this house. Here each change is of a key put in and taken out again, more
    // than a tick has reads for, and the one game it knows has been handed on.
    let mut game = Game::new("index-behind");
    game.ticks();
    game.transfer(&who("buyer"), 0);
    game.ticks();
    assert!(!game.tick(200).short, "a game handed on: nothing for this house");
    let keys = game.junk_games(6_000);
    game.untouch(&keys);
    let mut short = 0;
    while game.tick(200).short {
        short += 1;
        assert!(short < 5, "caught up within a few ticks");
    }
    assert!(short >= 1, "not all in one");
    assert_eq!(game.house.rooms[ROOM].index.as_ref().unwrap().games.len(), 1, "and none of the keys kept");
}

#[test]
fn a_pass_short_of_the_rooms_delegations_puts_nothing_under_this_houses_key() {
    // 🔒 Only a pass that read every delegation of the room chooses what goes under `hk:<house>`: one cut short before
    // it got to the key knows nothing of what is there. Here a stranger's good delegation of this house, which stays,
    // behind junk under other houses' keys that come first and weigh more than a tick reads.
    let mut game = Game::new("hk-short");
    game.handed_to_the_buyer();
    let key = format!("hk:{}", game.house.public());
    let strangers = delegation(&who("landlord"), game.house.public());
    game.put_top(&key, &strangers);
    for _ in 0..2 {
        game.tick(REPUT_MS);
        game.ticks();
    }
    assert_eq!(game.hk_hash(), hb::rec_hash(&strangers), "a stranger's stays");
    let filler = "j".repeat(8_000);
    let junk: Vec<String> = (0..600).map(|i| format!("hk:-{i:042}")).collect();
    assert!(junk.iter().all(|k| is_pub(&k[3..]) && *k < key), "other houses' keys, before this house's");
    for k in &junk {
        game.put_top_any(k, Any::String(Arc::from(filler.as_str())));
    }
    let mut short = 0;
    while game.tick(REPUT_MS).short {
        short += 1;
        assert!(short < 5, "read within a few ticks");
        assert_eq!(game.hk_hash(), hb::rec_hash(&strangers), "nothing written over it");
    }
    assert!(short >= 1, "not all in one");
    assert_eq!(game.hk_hash(), hb::rec_hash(&strangers));
}

#[test]
fn an_ended_game_is_read_again_while_it_holds_a_forged_record() {
    // 🔒 As a game handed on (below): passed by only once nothing is left to do there.
    let mut game = Game::new("forged-ended");
    game.end();
    game.ticks();
    let key = (T.to_string(), game.ctx.inc.clone());
    assert_eq!(game.house.rooms[ROOM].index.as_ref().unwrap().games[&key].quiet, Some(Quiet::Records), "over: passed by");
    game.tick(REPUT_MS);
    let xf = game.forged_transfer(3);
    game.tick(200);
    game.tick(200);
    assert!(game.top(&xf).is_some(), "not before the put-back's turn");
    game.tick(REPUT_MS);
    assert!(game.top(&xf).is_none(), "deleted at it");
}

#[test]
fn a_game_with_nothing_for_this_house_is_read_again_while_it_holds_a_forged_record() {
    // 🔒 Passed by only once nothing is left to do there: a forged record of a game handed on goes at the put-back's
    // turn, though the passes before that turn found the game none of this house's.
    let mut game = Game::new("forged-quiet");
    game.ticks();
    game.transfer(&who("buyer"), 0);
    game.ticks();
    game.tick(REPUT_MS);
    // A transfer of the buyer's, the game's holder now (whose transfers the resolution looks at), its signature broken.
    let good = game.transfer_of(&game.ctx, &who("buyer"), &who("carol"), 3, "fedcba9876543210fedcba98");
    game.delete_top(&format!("xf:{T}:{}:{}", game.ctx.inc, hb::xf_id(&good).unwrap()));
    let bad = with(&good, "g", s(&sign(&who("dave"), &[3u8; 32])));
    let xf = format!("xf:{T}:{}:{}", game.ctx.inc, hb::xf_id(&bad).unwrap());
    game.put_top(&xf, &bad);
    game.tick(200);
    game.tick(200);
    assert!(game.top(&xf).is_some(), "not before the put-back's turn");
    game.tick(REPUT_MS);
    assert!(game.top(&xf).is_none(), "deleted at it");
}

#[test]
fn the_beat_goes_on_at_a_game_it_has_settled_at() {
    let mut game = Game::new("beat-on");
    game.ticks();
    let mut last = game.beat();
    assert!(last.is_some());
    for _ in 0..3 {
        // (Its check of the beat already in the doc is made with the doc let go: the beat is the tick's next pass.)
        game.tick(HEARTBEAT_MS);
        let now = game.beat();
        assert!(now.is_some() && now != last, "a beat each HEARTBEAT_MS");
        last = now;
    }
}

#[test]
fn a_game_without_its_session_holds_the_beat_of_the_house_table_beside() {
    let mut game = Game::new("no-session-beat");
    game.add_house_table();
    game.ticks();
    let beat = game.beat();
    assert!(beat.is_some());
    assert_eq!(game.at_house_table("o:1:"), 1, "the house table is served");
    let ses = game.ses.clone();
    game.delete_top(&ses);
    // The beat is due in the tick that finds the map gone: the map goes back, and the house is not heard, as it could
    // not read a game it serves.
    game.tick(HEARTBEAT_MS);
    assert!(game.has_session());
    assert_eq!(game.beat(), beat, "no beat in that tick");
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
    assert!(game.beat().is_some() && game.beat() != beat);
}

#[test]
fn a_house_back_after_its_step_down_joins_no_round_that_waits_on_another() {
    let mut game = Game::new("back-after-stop");
    let owner = who("owner");
    let mut other = game.second_house(9, &owner);
    game.tick(0);
    assert_eq!(game.records("o:1:").len(), 1);
    // It stops: its commitment for round 1 is opened, and the second house joins round 1 in its place.
    game.house.begin_step_down();
    game.tick(200);
    let downs = game.records("h:1:");
    assert!(downs.len() == 1 && strs(&downs[0].1, "x").is_empty());
    game.ticks_of(&mut other);
    let joins = game.of("o:1:", other.public());
    assert_eq!(joins.len(), 1);
    let commit = str_of(&joins[0], "c").unwrap().to_string();
    game.closed(1, &game.sid(), &commit);
    // Back again: round 1 waits on the second house's reveal (its own step-down there decides nothing), and that
    // reveal carries round 2's commitment.
    let mut house = House::open(&NODE, Some(game.dir.join(STATE_FILE))).unwrap();
    house.settle_ms = 0;
    house.serve_fair_only(true);
    game.house = house;
    for _ in 0..3 {
        game.ticks();
    }
    assert!(game.of("o:2:", game.house.public()).is_empty(), "round 1 is the second house's to reveal");
    game.seeds(1);
    game.ticks_of(&mut other);
    let reveals = game.of("h:1:", other.public());
    assert_eq!(reveals.len(), 1);
    assert!(reveals[0].get("c").is_some());
}

#[test]
fn a_second_house_joins_no_round_that_waits_on_a_commitment_the_first_carried() {
    let mut game = Game::new("theirs-carried");
    let owner = who("owner");
    let mut other = game.second_house(9, &owner);
    let (c, _, _) = game.closed_on_the_join();
    game.seeds(1);
    game.ticks();
    assert_eq!(str_of(&game.records("h:1:")[0].1, "c"), Some(game.commit(2).as_str()));
    // Round 2 closed on the commitment the first house's reveal carried, and that house is away: its reveal of
    // round 2 will carry round 3's.
    game.closed(2, &c, &game.commit(2));
    for _ in 0..3 {
        game.ticks_of(&mut other);
    }
    assert!(game.of("o:", other.public()).is_empty(), "round 2 waits on the first house");
}

#[test]
fn turned_off_after_it_served_it_leaves_a_game_alone_put_backs_too() {
    for beside in [false, true] {
        let mut game = Game::new(&format!("off-later-{beside}"));
        if beside {
            game.add_house_table();
        }
        game.ticks();
        let joins = game.records("o:1:");
        assert_eq!(joins.len(), 1);
        game.house.serve_fair_only(false);
        {
            let comp = game.doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = game.doc.transact_mut();
            let Some(Out::YMap(m)) = comp.get(&txn, &game.ses) else { panic!() };
            m.remove(&mut txn, &joins[0].0);
        }
        for _ in 0..3 {
            game.tick(REPUT_MS);
        }
        assert!(game.records("o:1:").is_empty(), "its join stays gone (a house table beside: {beside})");
        if beside {
            assert_eq!(game.at_house_table("o:1:"), 1, "the house table is served as before");
        }
    }
}

#[test]
fn a_delegation_under_another_key_than_its_houses_makes_no_house() {
    // 🔒 A page takes a room's delegation only under its house's own key (casinoDoc fedDelegation): under another,
    // it is nothing to a game. (The root names another house: this one is a house only by the room's delegation.)
    let mut game = Game::new("hk-other-key");
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = game.ck_key(&game.base.clone());
    game.delete_top(&key);
    let root = game.root(other.public(), "f1");
    game.lay(&root);
    let mine = delegation(&game.owner, game.house.public());
    game.put_top(&format!("hk:{}", who("mallory").public), &mine);
    game.ticks();
    assert!(game.records("o:").is_empty(), "no house of the game by a delegation under another key");
    game.put_top(&format!("hk:{}", game.house.public()), &mine);
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn what_a_page_may_read_otherwise_under_a_key_that_holds_no_delegation_for_it_holds_no_game() {
    // Under a key that names no house, anything; under a house's key, a delegation of another house as a page may
    // read it: no page takes either for a delegation, so neither holds the game, and neither goes back.
    let mut game = Game::new("hk-not-theirs");
    let mut m: HashMap<String, Any> = HashMap::new();
    for i in 0..1_200 {
        m.insert(format!("pad{i:04}"), Any::Undefined);
    }
    game.put_top_any("hk:not-a-key", Any::Map(Arc::new(m)));
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = format!("hk:{}", who("mallory").public);
    game.put_top_any(&key, padded(&delegation(&game.owner, other.public()), Any::Null));
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
    let txn = game.doc.transact();
    let Some(Out::Any(raw)) = txn.get_map(COMPUTED_MAP).unwrap().get(&txn, &key) else { panic!("gone") };
    assert_ne!(hb::clarity(&raw), hb::Clarity::Clear, "not put back");
}

#[test]
fn a_tick_whose_later_pass_only_carries_a_game_short_of_its_checks_is_short() {
    // One check a tick: the first pass asks for one of the close's, and no pass of the tick reads the game again
    // (the budget spent), so the second carries it, short, and so is the tick.
    let mut game = Game::new("carry-checks");
    game.ticks();
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.now += 200;
    let before = game.house.table_reads;
    let out = game.house.tick_with(ROOM, &game.doc, game.now, 1_700_000_000_000 + game.now, 1, 2);
    assert!(out.short);
    assert_eq!(game.house.table_reads, before + 1, "read on the first pass alone");
    assert!(game.records("h:1:").is_empty());
}

#[test]
fn a_game_read_through_on_a_pass_is_not_read_again_that_tick() {
    let mut game = Game::new("read-once");
    game.ticks();
    // (The beat's check is made with the doc let go: a second pass, which reads no game.)
    game.house.table_reads = 0;
    game.tick(HEARTBEAT_MS);
    assert_eq!(game.house.table_reads, 1);
}

#[test]
fn a_pass_behind_the_changes_counts_a_game_whose_records_were_gone_as_when_last_read_through() {
    // 🔒 Its records may be back among the changes the pass has not got to: until the index has them, every game it
    // knows counts as when last read through (as when the walk listed the room's keys and could not get to their end).
    let mut game = Game::new("records-back");
    game.ticks();
    let cks: Vec<(String, CVal)> = game.top_keys("ck:").into_iter().map(|k| (k.clone(), game.top(&k).unwrap())).collect();
    for (k, _) in &cks {
        game.delete_top(k);
    }
    let before = game.beat();
    for _ in 0..3 {
        game.tick(HEARTBEAT_MS);
    }
    assert_eq!(game.beat(), before, "gone: no table runs Fair");
    // Back, behind more changes than a tick looks at (keys of other games' checkpoints, which the index looks at
    // first, by name).
    let junk: Vec<String> = (0..6_000).map(|i| format!("ck:a{i:05}{}:p{}:{i:032x}", "k".repeat(950), "0".repeat(24))).collect();
    assert!(junk.iter().all(|k| k.len() <= MAX_KEY_BYTES && cks.iter().all(|(c, _)| k < c)));
    game.touch(&junk);
    for (k, v) in &cks {
        game.put_top(k, v);
    }
    assert!(game.tick(HEARTBEAT_MS).short);
    assert!(game.beat().is_some() && game.beat() != before, "counted as when last read through");
}

#[test]
fn a_house_counts_the_records_of_a_house_the_holder_delegated_in_the_room_alone() {
    // 🔒 Another house of the game by the holder's delegation under its key in the room (no checkpoint carries it): its
    // join and its reveal are a house's (the walk weighs that delegation where a record of that house asks it). This
    // one stopped, and back: round 1 is the other's, and once the other reveals it with no commitment, round 2 is open
    // and this one joins it.
    let mut game = Game::new("other-in-room");
    let owner = who("owner");
    let mut other = game.second_house(9, &owner);
    game.tick(0);
    game.house.begin_step_down();
    game.tick(200);
    game.ticks_of(&mut other);
    let joins = game.of("o:1:", other.public());
    assert_eq!(joins.len(), 1);
    let commit = str_of(&joins[0], "c").unwrap().to_string();
    game.closed(1, &game.sid(), &commit);
    let mut house = House::open(&NODE, Some(game.dir.join(STATE_FILE))).unwrap();
    house.settle_ms = 0;
    house.serve_fair_only(true);
    game.house = house;
    game.ticks();
    assert!(game.of("o:2:", game.house.public()).is_empty(), "round 1 is the other's to reveal");
    game.seeds(1);
    other.begin_step_down();
    game.ticks_of(&mut other);
    let reveals = game.of("h:1:", other.public());
    assert!(reveals.len() == 1 && reveals[0].get("c").is_none(), "revealed, with nothing carried on");
    game.ticks();
    assert_eq!(game.of("o:2:", game.house.public()).len(), 1, "round 2 is open: joined");
}

#[test]
fn a_game_whose_records_are_gone_is_none_it_serves() {
    let mut game = Game::new("records-gone");
    game.ticks();
    assert!(game.beat().is_some());
    // The doc holds nothing of the game now (the pages compact an ended one, say): none it serves, and its last
    // read through counts for nothing.
    for key in game.top_keys("ck:") {
        game.delete_top(&key);
    }
    let before = game.beat();
    for _ in 0..3 {
        game.tick(HEARTBEAT_MS);
    }
    assert_eq!(game.beat(), before, "no table runs Fair");
}

#[test]
fn a_game_handed_on_before_it_revealed_there_is_remembered_as_none_of_this_houses() {
    // It joined round 1 and revealed nothing there: its state holds nothing of the game.
    let mut game = Game::new("left-unrevealed");
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
    assert!(game.beat().is_some());
    game.transfer(&who("buyer"), 0);
    game.ticks();
    let before = game.beat();
    game.tick(HEARTBEAT_MS);
    assert_eq!(game.beat(), before, "read through as none of this house's");
    // No pass gets to the changes of the room's FAIR ONLY records now: as last read through, none of its own.
    let keys = game.junk_games(4_000);
    for _ in 0..3 {
        game.touch(&keys);
        assert!(game.tick(HEARTBEAT_MS).short && game.house.read_out);
    }
    assert_eq!(game.beat(), before);
}

#[test]
fn a_game_whose_house_check_is_put_off_holds_the_beat_while_it_settles_there() {
    // This house is one of the game by its delegation in the room alone (the root names another). Back after
    // HOUSE_HEARD_MS with its checks forgotten, the walk is short of the root's on the first pass and of the
    // delegation's on the second: whose the game is waits on it, so it counts as when last read through, and it
    // settles there again: not heard. (The doc's beat gone: no check of it to wait on.)
    let mut game = Game::new("house-pending");
    game.house.settle_ms = SETTLE_MS;
    let other = House::open(&[9u8; 32], None).unwrap();
    let key = game.ck_key(&game.base.clone());
    game.delete_top(&key);
    let root = game.root(other.public(), "f1");
    game.lay(&root);
    game.add_house_table();
    game.settle();
    assert_eq!(game.records("o:1:").len(), 1);
    assert!(game.beat().is_some());
    game.house.verdicts.clear();
    game.house.verdict_order.clear();
    game.delete_top(&format!("hb:{}", game.house.public()));
    game.tick_with_passes(HOUSE_HEARD_MS, 2);
    assert!(game.beat().is_none());
}

#[test]
fn a_check_put_off_that_cannot_change_the_base_leaves_the_pass_its_duties() {
    // One pass a tick. On a twin, how many ticks a fresh game takes to be joined; then the same game, with a forged
    // root come in on the tick it is joined (another house delegated, a signature that fails), after the root in the
    // order the base is looked for in (the same round, a greater id): its check is put off, which cannot change the
    // base, and the house joins all the same.
    let ticks = {
        let mut twin = Game::new("put-off-twin");
        let mut n = 0;
        while twin.records("o:1:").is_empty() {
            twin.tick_with_passes(200, 1);
            n += 1;
            assert!(n < 10);
        }
        n
    };
    let mut game = Game::new("put-off-worse");
    for _ in 1..ticks {
        game.tick_with_passes(200, 1);
    }
    assert!(game.records("o:").is_empty());
    let root_id = hb::ck_id(&game.base).unwrap();
    let forged = (0..)
        .map(|i: i32| with(&with(&game.base, "dl", delegation(&game.owner, &who(&format!("h{i}")).public)), "g", s(&"A".repeat(86))))
        .find(|f| hb::ck_id(f).unwrap() > root_id)
        .unwrap();
    game.put_top(&game.ck_key(&forged), &forged);
    game.tick_with_passes(200, 1);
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn a_flood_at_a_house_table_leaves_the_games_their_reads() {
    // 🔒 ~6 MB of junk in the house table's session, more than a tick reads, and the house table the room's only one
    // (its turn comes first every tick): half of what the tick may read is the games', so the game beside is joined
    // and its close revealed.
    let mut game = Game::new("flood-house-table");
    game.add_house_table();
    game.junk_in(&format!("ses:{T2}:{INC_R}:g"), 100, 60_000);
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1, "joined beside the flood");
    let (c, _, _) = game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1);
    assert_eq!(strs(&reveals[0].1, "x"), vec![c]);
}

#[test]
fn a_flood_of_the_casinos_keys_leaves_the_games_their_reads() {
    // 🔒 More of the casino's keys than a tick reads, beside a house table: no pass reads the switches to their end,
    // so nothing at the house tables; the game is the deed holder's whatever they hold, and is served all the same.
    let mut game = Game::new("flood-casino");
    game.add_house_table();
    {
        let mut txn = game.doc.transact_mut();
        let casino = txn.get_or_insert_map(CASINO_MAP);
        for i in 0..5_000 {
            casino.insert(&mut txn, format!("zz{i:04}{}", "k".repeat(994)), Any::Bool(true));
        }
    }
    game.ticks();
    assert_eq!(game.at_house_table("o:"), 0, "the switches not read: nothing at the house table");
    assert_eq!(game.records("o:1:").len(), 1, "the game is joined");
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1);
}

#[test]
fn an_end_order_at_a_game_far_past_its_first_round_looks_for_its_commitment_from_its_base() {
    // 🔒 The house's trim at round 1,000,000, carrying its commitment for the round after, then the holder's end
    // order: a house with no memory of the game steps the commitment down, looking for it from past the base (the
    // rounds below were decided before it), not from round 1.
    let mut game = Game::new("far-end");
    let commit = game.commit(1_000_001);
    game.trim(1_000_000, &"ab".repeat(16), &"cd".repeat(16), Some(&commit));
    game.fin(&who("owner"));
    game.restart(0);
    game.ticks();
    let downs = game.records("h:1000001:");
    assert_eq!(downs.len(), 1, "stepped down");
    assert!(strs(&downs[0].1, "x").is_empty());
    assert!(game.house.commits.get() < 1_000, "{} commitments made", game.house.commits.get());
}

#[test]
fn a_house_that_serves_the_games_again_settles_at_them_again() {
    // 🔒 Settled at the game and joined at round 1, the house stops serving the games while the room still ticks
    // (no gap), and a close comes meanwhile: served again, it settles at the game again, so it first reads that close
    // while settling and never reveals it. One that comes once it has settled again it reveals.
    for later in [false, true] {
        let mut game = Game::new(&format!("served-on-again-{later}"));
        game.house.settle_ms = SETTLE_MS;
        game.settle();
        assert_eq!(game.records("o:1:").len(), 1);
        game.house.serve_fair_only(false);
        if !later {
            game.closed(1, &game.sid(), &game.commit(1));
            game.seeds(1);
        }
        for _ in 0..30 {
            game.tick(1_000);
        }
        assert!(game.records("h:1:").is_empty(), "nothing served");
        game.house.serve_fair_only(true);
        game.settle();
        if later {
            game.closed(1, &game.sid(), &game.commit(1));
            game.seeds(1);
            game.settle();
        }
        assert_eq!(game.records("h:1:").len(), usize::from(later), "the close came once it had settled again: {later}");
    }
}

// ── Put-backs at a game (design-final section 8.5 N5) ────────────────────────

impl Game {
    /// Whether the doc holds the live session's map.
    fn has_session(&self) -> bool {
        let txn = self.doc.transact();
        matches!(txn.get_map(COMPUTED_MAP).unwrap().get(&txn, &self.ses), Some(Out::YMap(_)))
    }

    /// Two updates of another copy of the room, the second adding to what the first holds: given the second first,
    /// Yjs keeps it until the first comes, and the doc holds part of an update meanwhile.
    fn updates_out_of_order(&self) -> (Vec<u8>, Vec<u8>) {
        use yrs::Array;
        let other = Doc::new();
        let list = other.get_or_insert_array("elsewhere");
        list.push_back(&mut other.transact_mut(), Any::Number(1.0));
        let first = other.transact().encode_state_as_update_v1(&yrs::StateVector::default());
        let sv = other.transact().state_vector();
        list.push_back(&mut other.transact_mut(), Any::Number(2.0));
        let second = other.transact().encode_diff_v1(&sv);
        (first, second)
    }

    fn apply_update(&self, update: &[u8]) {
        use yrs::updates::decoder::Decode;
        self.doc.transact_mut().apply_update(yrs::Update::decode_v1(update).unwrap()).unwrap();
    }

    /// The doc's value under this house's delegation key, by hash.
    fn hk_hash(&self) -> Option<String> {
        self.top(&format!("hk:{}", self.house.public())).and_then(|v| hb::rec_hash(&v))
    }

    /// Handed to the buyer at round 0, who delegates this house under its key; served as the buyer's house.
    fn handed_to_the_buyer(&mut self) -> CVal {
        let buyer = who("buyer");
        let xf = self.transfer(&buyer, 0);
        let mine = delegation(&buyer, self.house.public());
        self.put_top(&format!("hk:{}", self.house.public()), &mine);
        self.ticks();
        assert_eq!(self.records("o:1:").len(), 1, "joined round 1, the buyer's");
        xf
    }
}

#[test]
fn its_delegation_goes_back_under_its_key_over_what_no_game_goes_by_and_it_serves_on_meanwhile() {
    // 🔒 The one its rounds go by, which it holds for the game: over nothing, junk, a forged one, one with a field
    // too many (signed, and still no delegation), or another house's. A good delegation of this house stays,
    // whoever signed it (a game this pass could not resolve may go by it: a new holder's): a stranger's, or one of an
    // earlier holder of the game's, which the pages write over. (The deed is the owner's still, so this is no house
    // of the room's house tables: the key is the game's to keep.)
    let buyer = who("buyer");
    let mut game = Game::new("hk-back");
    game.handed_to_the_buyer();
    let mine = delegation(&buyer, game.house.public());
    let want = hb::rec_hash(&mine);
    let other = House::open(&[9u8; 32], None).unwrap();
    let forged = with(&mine, "g", str_of(&delegation(&buyer, other.public()), "g").map(s).unwrap());
    let extra = {
        let body = obj(vec![("v", CVal::Int(1)), ("h", s(game.house.public())), ("k", s(&buyer.public)), ("x", CVal::Int(1))]);
        let g = sign(&buyer, &hb::room_sign_bytes("hkey", ROOM, "", &body).unwrap());
        with(&body, "g", s(&g))
    };
    let (strangers, earlier) = (delegation(&who("landlord"), game.house.public()), delegation(&game.owner, game.house.public()));
    let cases: Vec<(&str, Option<CVal>, bool)> = vec![
        ("nothing", None, true),
        ("junk", Some(obj(vec![("v", CVal::Int(1))])), true),
        ("a forged one", Some(forged), true),
        ("one with a field too many", Some(extra), true),
        ("another house's", Some(delegation(&buyer, other.public())), true),
        ("a stranger's", Some(strangers), false),
        ("the earlier holder's", Some(earlier), false),
    ];
    let key = format!("hk:{}", game.house.public());
    for (what, value, back) in cases {
        match &value {
            Some(v) => game.put_top(&key, v),
            None => game.delete_top(&key),
        }
        // (A check of what is there is asked for at the first turn: put back at the next.)
        for _ in 0..2 {
            game.tick(REPUT_MS);
            game.ticks();
        }
        let there = if back { want.clone() } else { value.as_ref().and_then(hb::rec_hash) };
        assert_eq!(game.hk_hash(), there, "{what}: put back {back}");
    }
    // Served all along: a close on its join is revealed.
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1);
}

#[test]
fn a_delegation_gone_from_the_doc_costs_the_game_no_round() {
    // 🔒 It holds the delegation it serves the game by: deleted, the house is still the round's, and a close made
    // meanwhile is revealed (no spell of serving none of the game's rounds).
    let mut game = Game::new("hk-gone");
    game.handed_to_the_buyer();
    game.delete_top(&format!("hk:{}", game.house.public()));
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.tick(200);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1);
}

#[test]
fn the_delegation_a_games_base_carries_does_not_go_under_its_key() {
    // (The root names this house: no key is needed for it, and the pages hold none such.)
    let mut game = Game::new("hk-carried");
    game.settle();
    assert_eq!(game.records("o:1:").len(), 1);
    assert!(game.hk_hash().is_none());
    let junk = obj(vec![("v", CVal::Int(1))]);
    game.put_top(&format!("hk:{}", game.house.public()), &junk);
    game.tick(REPUT_MS);
    assert_eq!(game.hk_hash(), hb::rec_hash(&junk), "nor over junk");
}

#[test]
fn while_it_is_a_house_of_the_rooms_house_tables_their_delegation_keeps_its_key() {
    // 🔒 One value under `hk:<house>`: the room's, which the house tables beside go by, over the game's buyer's,
    // which the house holds for the game. No write over each other, and the game is served all the same.
    let buyer = who("buyer");
    let mut game = Game::new("hk-room");
    game.add_house_table();
    game.ticks();
    let room = game.hk_hash();
    game.transfer(&buyer, 0);
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&buyer, game.house.public()));
    game.ticks();
    for _ in 0..5 {
        game.tick(REPUT_MS);
        assert_eq!(game.hk_hash(), room, "the room's delegation, put back by the house tables, stays");
    }
    // (And with the key emptied, the room's goes back, not the game's.)
    game.delete_top(&format!("hk:{}", game.house.public()));
    game.tick(REPUT_MS);
    assert_eq!(game.hk_hash(), room, "the room's again");
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1, "the buyer's round, by the delegation the house holds");
}

#[test]
fn a_transfer_the_doc_holds_only_inside_the_base_goes_back_under_its_key() {
    let buyer = who("buyer");
    let mut game = Game::new("xf-back");
    let xf = game.handed_to_the_buyer();
    let key = format!("xf:{T}:{}:{}", game.ctx.inc, hb::xf_id(&xf).unwrap());
    // The buyer's house trims at round 1: its checkpoint carries the transfer.
    let commit = game.commit(2);
    game.trim_with(1, &"ab".repeat(16), &"cd".repeat(16), Some(&commit), delegation(&buyer, game.house.public()), &[xf.clone()]);
    game.ticks();
    for junk in [None, Some(obj(vec![("v", CVal::Int(1))]))] {
        match &junk {
            Some(v) => game.put_top(&key, v),
            None => game.delete_top(&key),
        }
        game.tick(REPUT_MS);
        assert_eq!(game.top(&key).and_then(|v| hb::rec_hash(&v)), hb::rec_hash(&xf), "over {junk:?}");
    }
    // (The base carries the buyer's delegation: no key for it.)
    game.delete_top(&format!("hk:{}", game.house.public()));
    game.tick(REPUT_MS);
    assert!(game.hk_hash().is_none());
}

impl Game {
    /// A transfer of the game from the owner with its signature broken, at round `u`: its key.
    fn forged_transfer(&self, u: i64) -> String {
        let good = self.transfer(&who("buyer"), u);
        self.delete_top(&format!("xf:{T}:{}:{}", self.ctx.inc, hb::xf_id(&good).unwrap()));
        let other = who("carol");
        let bad = with(&good, "g", s(&sign(&other, &[3u8; 32])));
        let key = format!("xf:{T}:{}:{}", self.ctx.inc, hb::xf_id(&bad).unwrap());
        self.put_top(&key, &bad);
        key
    }
}

#[test]
fn a_games_forged_records_go_at_the_put_backs_turn() {
    let mut game = Game::new("forged");
    game.ticks();
    // A transfer and a checkpoint, each with a signature that fails under the key it claims.
    let xf = game.forged_transfer(3);
    let good = game.trim_ck(1, &"ab".repeat(16), &"cd".repeat(16), None, delegation(&game.owner, game.house.public()), &[]);
    let ck = with(&good, "g", s(&sign(&who("carol"), &[3u8; 32])));
    let ck_key = game.ck_key(&ck);
    game.put_top(&ck_key, &ck);
    game.ticks();
    game.tick(REPUT_MS);
    assert!(game.top(&xf).is_none() && game.top(&ck_key).is_none(), "both deleted");
    assert_eq!(game.records("o:1:").len(), 1, "and the game served all along");
}

#[test]
fn no_forged_record_goes_while_the_doc_holds_part_of_an_update() {
    let mut game = Game::new("forged-partial");
    game.ticks();
    let (first, second) = game.updates_out_of_order();
    game.apply_update(&second);
    let xf = game.forged_transfer(3);
    for _ in 0..3 {
        game.tick(REPUT_MS);
    }
    assert!(game.top(&xf).is_some());
    game.apply_update(&first);
    game.tick(REPUT_MS);
    assert!(game.top(&xf).is_none());
}

#[test]
fn forged_records_go_at_most_forged_delete_max_a_pass() {
    // 🔒 A forged transfer, and more checkpoints that carry it than a pass deletes: they go over two passes, and the
    // game is served all along.
    let mut game = Game::new("forged-flood");
    game.ticks();
    let xf = game.forged_transfer(3);
    let bad = game.top(&xf).unwrap();
    let mut keys = vec![xf];
    for u in 1..=300 {
        // (Signed for the buyer the transfer names: a checkpoint of theirs that carries it.)
        let ck = game.trim_ck(u, &"ab".repeat(16), &"cd".repeat(16), None, delegation(&who("buyer"), game.house.public()), &[bad.clone()]);
        let key = game.ck_key(&ck);
        game.put_top(&key, &ck);
        keys.push(key);
    }
    let left = |game: &Game| keys.iter().filter(|k| game.top(k).is_some()).count();
    let mut gone = Vec::new();
    let mut was = left(&game);
    for _ in 0..6 {
        game.tick(REPUT_MS);
        let now = left(&game);
        gone.push(was - now);
        was = now;
    }
    assert_eq!(was, 0, "all gone: {gone:?}");
    assert!(gone.iter().all(|n| *n <= FORGED_DELETE_MAX) && gone.contains(&FORGED_DELETE_MAX), "{gone:?}");
    assert_eq!(game.records("o:1:").len(), 1);
}

#[test]
fn its_first_join_at_a_game_goes_into_its_state_first() {
    let mut game = Game::new("join-state");
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
    let state: serde_json::Value = serde_json::from_slice(&std::fs::read(game.dir.join(STATE_FILE)).unwrap()).unwrap();
    assert_eq!(state["done"], serde_json::json!([[ROOM, T, game.ctx.inc, 0, null, null, false, []]]), "a game joined, nothing decided");
    // A house that cannot write its state joins nothing there.
    let mut stuck = Game::new("join-state-stuck");
    stuck.house = House::open(&NODE, Some(stuck.dir.join("missing").join(STATE_FILE))).unwrap();
    stuck.house.settle_ms = 0;
    stuck.house.serve_fair_only(true);
    stuck.ticks();
    assert!(stuck.records("o:").is_empty());
}

#[test]
fn after_a_start_a_game_it_joined_at_holds_the_beat_until_it_reads_it_through_and_settles() {
    // 🔒 Its state holds that it joined (a page may close on the commitment it joined with): started again, the
    // game is one it serves and has not settled at until a pass reads it, as one it revealed at.
    let mut game = Game::new("start-join-beat");
    game.add_house_table();
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
    assert!(game.records("h:").is_empty());
    let key = game.unreadable();
    game.restart(SETTLE_MS);
    let before = game.beat();
    for _ in 0..3 {
        game.tick(HEARTBEAT_MS);
        assert_eq!(game.beat(), before, "no beat while a game it joined at is not read through");
    }
    game.delete_top(&key);
    game.settle();
    assert!(game.beat().is_some() && game.beat() != before);
}

#[test]
fn once_the_games_records_and_its_delegation_are_back_a_put_backs_turn_writes_nothing_there() {
    // 🔒 Come to rest: handed on (its delegation under its key, a transfer under its own), with the delegations of
    // other houses by both holders in the room, a put-back's turn writes nothing but the room's beat when it is due.
    let mut game = Game::new("at-rest");
    game.handed_to_the_buyer();
    let _a = game.second_house(9, &who("buyer"));
    let _b = game.second_house(10, &game.owner);
    for _ in 0..2 {
        game.tick(REPUT_MS);
        game.ticks();
    }
    for _ in 0..8 {
        let before = game.beat();
        let out = game.tick(REPUT_MS);
        assert_eq!(out.wrote, usize::from(game.beat() != before), "only a beat");
    }
    // (And its own key emptied, its own goes back, the other houses' good delegations in the room beside.)
    let want = game.hk_hash();
    game.delete_top(&format!("hk:{}", game.house.public()));
    game.tick(REPUT_MS);
    assert_eq!(game.hk_hash(), want);
}

#[test]
fn a_join_at_a_house_table_beside_does_not_go_into_its_state() {
    // (As before: only a FAIR ONLY game's first join is kept there.)
    let mut game = Game::new("join-state-beside");
    game.add_house_table();
    game.ticks();
    assert_eq!(game.at_house_table("o:1:"), 1);
    assert_eq!(game.records("o:1:").len(), 1);
    let state: serde_json::Value = serde_json::from_slice(&std::fs::read(game.dir.join(STATE_FILE)).unwrap()).unwrap();
    assert_eq!(state["done"], serde_json::json!([[ROOM, T, game.ctx.inc, 0, null, null, false, []]]));
}

#[test]
fn a_join_after_a_reveal_keeps_the_round_its_state_holds() {
    // 🔒 Only its first join at a game is noted: one after a reveal leaves the revealed round in its state. (Handed
    // on at round 1, it reveals that round with no commitment, round 2 not being its own; then the buyer delegates
    // it too, and it joins round 2.)
    let buyer = who("buyer");
    let mut game = Game::new("join-after-reveal");
    game.closed_on_the_join();
    game.transfer(&buyer, 1);
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert!(reveals.len() == 1 && reveals[0].1.get("c").is_none());
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&buyer, game.house.public()));
    game.ticks();
    assert_eq!(game.records("o:2:").len(), 1, "joined round 2");
    let state: serde_json::Value = serde_json::from_slice(&std::fs::read(game.dir.join(STATE_FILE)).unwrap()).unwrap();
    assert_eq!(state["done"][0][3], serde_json::json!(1), "{state}");
}

#[test]
fn after_a_start_a_lost_session_map_goes_back_with_the_reveals_its_state_holds() {
    // 🔒 Its reveals from before the start go back into the map in the write that puts the map back, as this run's
    // own records do.
    let mut game = Game::new("start-lost-map");
    game.closed_on_the_join();
    game.seeds(1);
    game.ticks();
    let reveals: Vec<String> = game.records("h:1:").into_iter().map(|(k, _)| k).collect();
    assert_eq!(reveals.len(), 1);
    game.restart(0);
    let ses = game.ses.clone();
    game.delete_top(&ses);
    for _ in 0..30 {
        game.tick(200);
        if game.has_session() {
            break;
        }
    }
    assert!(game.has_session(), "the map goes back");
    assert_eq!(game.records("h:1:").into_iter().map(|(k, _)| k).collect::<Vec<_>>(), reveals, "with its reveal in it");
}

impl Game {
    /// This game handed to the buyer and a second game (`roulette-3`) to carol, both at round 0, each delegating this
    /// house; it joins round 1 of each, by carol's delegation under its key and then by the buyer's, which the doc
    /// holds after: (the second game, its session, the buyer's delegation, carol's).
    fn two_holders(&mut self) -> (Ctx, String, CVal, CVal) {
        let (buyer, carol) = (who("buyer"), who("carol"));
        let (ctx2, ses2) = self.second_game("roulette-3", self.house.public());
        self.transfer(&buyer, 0);
        self.transfer_of(&ctx2, &self.owner, &carol, 0, "0123456789abcdef01234567");
        let key = format!("hk:{}", self.house.public());
        let (theirs, hers) = (delegation(&buyer, self.house.public()), delegation(&carol, self.house.public()));
        self.put_top(&key, &hers);
        self.ticks();
        assert_eq!(self.joins_in(&ses2), 1, "carol's game, by her delegation");
        self.put_top(&key, &theirs);
        self.ticks();
        assert_eq!(self.records("o:1:").len(), 1, "the buyer's, by theirs");
        for _ in 0..2 {
            self.tick(REPUT_MS);
            self.ticks();
        }
        assert_eq!(self.hk_hash(), hb::rec_hash(&theirs));
        (ctx2, ses2, theirs, hers)
    }
}

#[test]
fn two_games_handed_to_different_holders_do_not_write_over_each_others_delegation() {
    // 🔒 One value under `hk:<house>`, two games that want each their holder's there: the one the doc holds stays,
    // and the other game goes by the delegation the house holds for it. With the key emptied, the one of lowest hash
    // goes back, whichever game a pass reads first.
    let mut game = Game::new("two-holders");
    let (_, _, theirs, hers) = game.two_holders();
    let key = format!("hk:{}", game.house.public());
    for _ in 0..8 {
        let before = game.beat();
        let out = game.tick(REPUT_MS);
        assert_eq!(out.wrote, usize::from(game.beat() != before), "only a beat");
    }
    let lowest = [hb::rec_hash(&theirs), hb::rec_hash(&hers)].into_iter().min().unwrap();
    for _ in 0..3 {
        game.delete_top(&key);
        game.tick(REPUT_MS);
        assert_eq!(game.hk_hash(), lowest);
        for _ in 0..3 {
            game.tick(REPUT_MS);
            assert_eq!(game.hk_hash(), lowest);
        }
    }
}

#[test]
fn a_game_handed_on_to_a_holder_who_did_not_delegate_it_wants_its_key_no_more() {
    // (It serves none of the game's rounds: the delegation it holds for the game wants no key.)
    let buyer = who("buyer");
    let mut game = Game::new("handed-on-key");
    game.handed_to_the_buyer();
    game.transfer_of(&game.ctx, &buyer, &who("mallory"), 0, "fedcba9876543210fedcba98");
    game.ticks();
    game.delete_top(&format!("hk:{}", game.house.public()));
    for _ in 0..4 {
        game.tick(REPUT_MS);
        game.ticks();
    }
    assert!(game.hk_hash().is_none());
}

#[test]
fn an_ended_game_wants_its_key_no_more() {
    let buyer = who("buyer");
    let mut game = Game::new("ended-key");
    let xf = game.handed_to_the_buyer();
    let mine = delegation(&buyer, game.house.public());
    // Its end, by this house as the buyer's, on the buyer's order.
    let fin = {
        let body = obj(vec![("v", CVal::Int(1)), ("k", s(&buyer.public))]);
        let g = sign(&buyer, &hb::sign_bytes("fin", &game.ctx, &body).unwrap());
        with(&body, "g", s(&g))
    };
    let body = obj(vec![
        ("v", CVal::Int(1)),
        ("ok", s(&game.owner.public)),
        ("j", s("0123456789abcdef")),
        ("rv", s("f1")),
        ("ts", CVal::Int(TS)),
        ("b", s(&game.sid())),
        ("u", CVal::Int(0)),
        ("l", s(ha::NO_CLOSE)),
        ("n", obj(vec![])),
        ("e", CVal::Int(1)),
        ("f", fin),
        ("dl", mine),
        ("k", s(game.house.public())),
        ("x", CVal::Arr(vec![xf])),
    ]);
    let g = game.house.key.sign(&hb::sign_bytes("ck", &game.ctx, &body).unwrap());
    let end = with(&body, "g", s(&g));
    assert!(matches!(ha::read_ck(ROOM, &game.ck_key(&end), &end), ha::CkRead::Ok { .. }));
    game.lay(&end);
    game.ticks();
    game.delete_top(&format!("hk:{}", game.house.public()));
    for _ in 0..4 {
        game.tick(REPUT_MS);
        game.ticks();
    }
    assert!(game.hk_hash().is_none());
}

#[test]
fn a_game_whose_base_the_doc_lost_still_wants_its_delegation_under_the_key() {
    // (A spell without a base, which the pages put back, is no change of the game's: the key emptied meanwhile, the
    // one of lowest hash goes back still, of the game whose base is gone or not.)
    let mut game = Game::new("two-holders-base");
    let (ctx2, _, theirs, hers) = game.two_holders();
    let (lost, lowest) = if hb::rec_hash(&theirs) < hb::rec_hash(&hers) { (&game.ctx.clone(), &theirs) } else { (&ctx2, &hers) };
    let base = game.top_keys(&format!("ck:{}:{}:", lost.t, lost.inc));
    assert_eq!(base.len(), 1);
    game.delete_top(&base[0]);
    game.delete_top(&format!("hk:{}", game.house.public()));
    for _ in 0..3 {
        game.tick(REPUT_MS);
        game.ticks();
    }
    assert_eq!(game.hk_hash(), hb::rec_hash(lowest));
}

#[test]
fn a_game_gone_from_the_doc_wants_its_key_no_more() {
    // (The one of lowest hash, its game's records all deleted: the other game's goes under the key.)
    let mut game = Game::new("two-holders-gone");
    let (ctx2, _, theirs, hers) = game.two_holders();
    let (gone, stays) = if hb::rec_hash(&theirs) < hb::rec_hash(&hers) { (&game.ctx.clone(), &hers) } else { (&ctx2, &theirs) };
    for prefix in ["ck", "xf", "ses"] {
        for k in game.top_keys(&format!("{prefix}:{}:{}:", gone.t, gone.inc)) {
            game.delete_top(&k);
        }
    }
    game.delete_top(&format!("hk:{}", game.house.public()));
    for _ in 0..3 {
        game.tick(REPUT_MS);
        game.ticks();
    }
    assert_eq!(game.hk_hash(), hb::rec_hash(stays));
}

#[test]
fn the_rooms_one_delegation_waits_for_a_pass_that_reads_every_delegation_of_the_room_clear() {
    // 🔒 Handed on from the buyer to carol, who delegates this house under its key. Until a pass has read the room's
    // delegations, each clear, it cannot tell that the key holds hers, and puts back none over it (the one it holds
    // is the buyer's). First hers in a form a page may read otherwise: it goes back as read, and carol's round is
    // served by it.
    let (buyer, carol) = (who("buyer"), who("carol"));
    let mut game = Game::new("hk-new-holder-proto");
    game.handed_to_the_buyer();
    game.transfer_of(&game.ctx, &buyer, &carol, 0, "fedcba9876543210fedcba98");
    let hk = format!("hk:{}", game.house.public());
    let hers = delegation(&carol, game.house.public());
    game.put_top_any(&hk, padded(&hers, Any::Null));
    game.tick(REPUT_MS);
    assert_eq!(game.hk_hash(), hb::rec_hash(&hers), "back as read, and not the buyer's over it");
    game.ticks();
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1, "carol's round, by hers");
    // Then the tick's reads spent once the room's index has looked at the keys changed since its last pass (the
    // transfer's and the delegation key), before its delegations are read.
    let mut game = Game::new("hk-new-holder-spent");
    game.handed_to_the_buyer();
    let xf = game.transfer_of(&game.ctx, &buyer, &carol, 0, "fedcba9876543210fedcba98");
    game.put_top(&hk, &hers);
    let xf_key = format!("xf:{T}:{}:{}", game.ctx.inc, hb::xf_id(&xf).unwrap());
    let txn = game.doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    game.house.read_left = [&xf_key, &hk].iter().map(|k| k.len() + VISIT_BYTES).sum();
    game.house.read_out = false;
    let (mut writes, mut reput) = (Vec::new(), Vec::new());
    assert!(game.house.walk_games(ROOM, &txn, &comp, game.now, &mut writes, &mut reput), "the index up to the doc");
    assert_eq!(game.house.read_left, 0, "by those two keys' visits");
    assert!(game.house.read_out, "and the reads spent");
    assert!(!reput.iter().any(|w| matches!(w, Write::Top { key, .. } if *key == hk)));
}

#[test]
fn handed_on_at_the_round_in_flight_it_reveals_that_round_by_the_sellers_delegation_once_the_seeds_come() {
    // 🔒 The buyer hands the game on to carol at round 1, which this house joined as the buyer's house and which waits
    // for its seeds; carol delegates this same house, and hers is written over the buyer's under its key. No
    // checkpoint carries the buyer's (the base is the opener's root). Round 1 is still the buyer's, and once the
    // seeds come, passes later, the house reveals it by the buyer's delegation, which it keeps for the game.
    let (buyer, carol) = (who("buyer"), who("carol"));
    let mut game = Game::new("in-flight-delayed-seeds");
    game.handed_to_the_buyer();
    let (c, _, _) = game.closed(1, &game.sid(), &game.commit(1));
    game.transfer_of(&game.ctx, &buyer, &carol, 1, "fedcba9876543210fedcba98");
    let hers = delegation(&carol, game.house.public());
    game.put_top(&format!("hk:{}", game.house.public()), &hers);
    // (Passes enough to go by hers from the first, short of the seeds' grace.)
    game.ticks();
    for _ in 0..2 {
        game.tick(REPUT_MS);
    }
    assert_eq!(game.hk_hash(), hb::rec_hash(&hers), "hers under the key");
    assert!(game.records("h:1:").is_empty(), "no reveal before the seeds");
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1, "round 1 revealed, by the buyer's delegation");
    assert_eq!(strs(&reveals[0].1, "x"), vec![c.clone()]);
    // (Round 2 is carol's, and this house is hers too: the reveal carries its commitment, and the house joins it.)
    assert_eq!(str_of(&reveals[0].1, "c"), Some(game.commit(2).as_str()));
}

#[test]
fn a_games_memory_keeps_one_delegation_of_each_other_holder_of_the_game() {
    // 🔒 The one it went by before is kept beside the one it goes by now, unless it is of the same signer; one of a
    // key that holds the game no more goes.
    let (a, b, c) = (who("buyer"), who("carol"), who("mallory"));
    let house = House::open(&NODE, None).unwrap();
    let by = |w: &Who, n: i64| with(&delegation(w, house.public()), "x", CVal::Int(n));
    let holders = |ws: &[&Who]| ws.iter().map(|w| ha::Holder { k: w.public.clone(), from: 0, step: None }).collect::<Vec<_>>();
    let all = holders(&[&a, &b, &c]);
    let mut table = TableMem::default();
    let kept = |t: &TableMem| (t.deleg.clone(), t.earlier.clone());
    keep_earlier(&mut table, by(&a, 1), &all);
    assert_eq!(kept(&table), (Some(by(&a, 1)), vec![]));
    keep_earlier(&mut table, by(&b, 1), &all);
    assert_eq!(kept(&table), (Some(by(&b, 1)), vec![by(&a, 1)]), "the buyer's kept beside carol's");
    keep_earlier(&mut table, by(&b, 2), &all);
    assert_eq!(kept(&table), (Some(by(&b, 2)), vec![by(&a, 1)]), "carol's earlier one goes");
    keep_earlier(&mut table, by(&a, 2), &all);
    assert_eq!(kept(&table), (Some(by(&a, 2)), vec![by(&b, 2)]), "the buyer's earlier one goes");
    keep_earlier(&mut table, by(&c, 1), &all);
    assert_eq!(kept(&table), (Some(by(&c, 1)), vec![by(&b, 2), by(&a, 2)]));
    keep_earlier(&mut table, by(&c, 2), &holders(&[&a, &c]));
    assert_eq!(kept(&table), (Some(by(&c, 2)), vec![by(&a, 2)]), "carol holds the game no more");
}

#[test]
fn a_new_holders_good_delegation_stays_while_the_hand_over_is_not_yet_resolved() {
    // 🔒 Handed on from the buyer to carol, whose delegation of this house comes under its key in the same moment:
    // a put-back's turn on a pass that resolves neither the transfer nor hers (no check to spare) puts nothing over
    // it, though the delegation the house holds for the game is still the buyer's; and carol's round is served by
    // hers once the checks are made.
    let (buyer, carol) = (who("buyer"), who("carol"));
    let mut game = Game::new("hk-new-holder-pending");
    game.handed_to_the_buyer();
    game.transfer_of(&game.ctx, &buyer, &carol, 0, "fedcba9876543210fedcba98");
    let hers = delegation(&carol, game.house.public());
    game.put_top(&format!("hk:{}", game.house.public()), &hers);
    game.now += REPUT_MS;
    game.house.tick_with(ROOM, &game.doc, game.now, 1_700_000_000_000 + game.now, 0, 1);
    assert_eq!(game.hk_hash(), hb::rec_hash(&hers), "nothing over hers");
    game.ticks();
    for _ in 0..2 {
        game.tick(REPUT_MS);
        assert_eq!(game.hk_hash(), hb::rec_hash(&hers));
    }
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 1, "carol's round, by hers");
}
