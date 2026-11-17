//! 🔒 The house at a FAIR ONLY game (letters `p`/`q`; design-final section 8.5, N1): a game opened as the owner's
//! page opens one (a root checkpoint signed by the opener, carrying the delegation of the opener's house), the
//! pages' records signed as computedTable signs them, and the rules the simulated house (computedSimHouse.ts) keeps
//! there, which this is the node's half of.

use super::tests::{obj, padded, s, scratch, seed_of, sign, sorted, strs, who, with, Who};
use super::*;
use crate::fold_summary::{records_digest, BaseSummary, FoldSummary};
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
    /// 🔒 Where the house reads the fold's answers (none unless a test puts one).
    answers: GameAnswers,
    /// 🔒 A watch of the room's players' keys, as the fold in shadow keeps one: an answer is made with where it stands.
    #[cfg(feature = "house-fold")]
    pins: crate::fold_pins::PlayerPins,
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
        let answers = GameAnswers::default();
        house.read_answers_from(answers.clone());
        #[cfg(feature = "house-fold")]
        let pins = crate::fold_pins::PlayerPins::attach(&doc, crate::fold_pins::PIN_WALK_KEYS);
        let mut game = Game {
            doc,
            owner,
            house,
            now: 1_000_000,
            dir,
            ctx,
            base: CVal::Undef,
            ses: String::new(),
            answers,
            #[cfg(feature = "house-fold")]
            pins,
        };
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
fn a_delegation_of_a_holder_whose_rounds_are_over_wakes_no_game() {
    // 🔒 A key that held a game only up to its base makes none of the rounds still to be played this house's: the game is
    // not passed by under it, and its delegation under this house's key, put there and taken out however often, never
    // has the game read again. (Handed on at its first round, to a holder who never delegated this house.)
    let mut game = Game::new("hk-former-holder");
    game.ticks();
    game.transfer(&who("buyer"), 0);
    game.ticks();
    let key = (T.to_string(), game.ctx.inc.clone());
    let quiet = game.house.rooms[ROOM].index.as_ref().unwrap().games[&key].quiet.clone();
    assert_eq!(quiet, Some(Quiet::Mine(std::collections::BTreeSet::from([who("buyer").public]))), "its holder after the base only");
    let looks = |game: &Game| game.house.games_looked.get(T).copied().unwrap_or(0);
    let before = looks(&game);
    let me = game.house.public().to_string();
    let hk = format!("hk:{me}");
    for _ in 0..3 {
        game.put_top(&hk, &delegation(&game.owner, &me));
        game.ticks();
        game.delete_top(&hk);
        game.ticks();
    }
    assert_eq!(looks(&game), before, "not read again");
}

#[test]
fn the_games_a_delegation_under_this_houses_key_wakes_wake_as_the_ticks_reads_allow() {
    // 🔒 A visit of the tick's reads each: a tick whose reads ran out before them wakes none of them, and is short; the
    // ticks after wake them, and they are read, and joined. (Another opener's games, none of whose rounds were this
    // house's; the game here handed on at its first round, so that it wants nothing under the key.)
    let mut game = Game::new("hk-wakes-budget");
    game.ticks();
    game.transfer(&who("buyer"), 0);
    let other = House::open(&[9u8; 32], None).unwrap();
    let owner = std::mem::replace(&mut game.owner, who("ann"));
    let games: Vec<(Ctx, String)> = ["roulette-3", "roulette-4", "roulette-5"].iter().map(|t| game.second_game(t, other.public())).collect();
    game.owner = owner;
    game.ticks();
    let quiet = |game: &Game, ctx: &Ctx| game.house.rooms[ROOM].index.as_ref().unwrap().games[&(ctx.t.clone(), ctx.inc.clone())].quiet.clone();
    for (ctx, _) in &games {
        assert!(matches!(quiet(&game, ctx), Some(Quiet::Mine(holders)) if holders.len() == 1), "{}", ctx.t);
    }
    let me = game.house.public().to_string();
    let hk = format!("hk:{me}");
    // Their holder's delegation under this house's key, and other houses' keys after it, more than two ticks read.
    game.put_top(&hk, &delegation(&who("ann"), &me));
    let filler = "j".repeat(8_000);
    let above: Vec<String> = (0..20_000).map(|i| format!("hk:{}", who(&format!("junk{i}")).public)).filter(|k| *k > hk).take(1_200).collect();
    assert_eq!(above.len(), 1_200);
    for key in &above {
        game.put_top_any(key, Any::String(Arc::from(filler.as_str())));
    }
    // The first tick reads the delegation and checks it after its pass; the second goes by it, its reads spent.
    assert!(game.tick_with_passes(200, 1).short);
    assert!(game.tick_with_passes(200, 1).short);
    for (ctx, ses) in &games {
        assert!(matches!(quiet(&game, ctx), Some(Quiet::Mine(_))), "{}: not woken yet", ctx.t);
        assert_eq!(game.joins_in(ses), 0);
    }
    let mut n = 0;
    while game.tick(200).short {
        n += 1;
        assert!(n < 20, "reads through");
    }
    game.ticks();
    for (ctx, ses) in &games {
        assert_eq!(quiet(&game, ctx), None, "{}", ctx.t);
        assert_eq!(game.joins_in(ses), 1, "{}: read, and joined", ctx.t);
    }
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
fn a_game_another_doc_of_the_room_holds_no_record_of_is_held_from_the_first_pass_over_it() {
    // 🔒 Another doc of the room (the node's copy of the room made again, say), listed afresh: each game the house holds
    // memory of that it holds no record of is held from that pass, as one whose every record went; a close first read
    // once the base is back counts as there since then. (Back soon: revealed.)
    let late = REVEAL_CUTOFF_MS + 500;
    for (wait, revealed) in [(200, true), (late, false)] {
        let mut game = Game::new(&format!("new-doc-hold-{wait}"));
        game.add_house_table();
        game.ticks();
        assert_eq!(game.records("o:1:").len(), 1);
        let base_key = format!("ck:{T}:{}:{}", game.ctx.inc, hb::ck_id(&game.base).unwrap());
        let doc = Doc::new();
        {
            use yrs::updates::decoder::Decode;
            let update = game.doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
            doc.transact_mut().apply_update(yrs::Update::decode_v1(&update).unwrap()).unwrap();
        }
        game.doc = doc;
        game.delete_top(&base_key);
        game.tick(200);
        let key = (T.to_string(), game.ctx.inc.clone());
        assert!(!game.house.rooms[ROOM].index.as_ref().unwrap().games.contains_key(&key), "no record of it");
        // (A house table beside is none of the index's games, and is not held for it.)
        let house_table = (T2.to_string(), INC_R.to_string());
        assert_eq!(game.house.rooms[ROOM].tables.get(&house_table).map(|m| m.held_since), Some(None), "the house table");
        // A page puts back the round's close on the join, and its seeds; then the base.
        game.closed(1, &game.sid(), &game.commit(1));
        game.seeds(1);
        game.tick(wait);
        let base = game.base.clone();
        game.put_top(&base_key, &base);
        game.ticks();
        assert_eq!(game.records("h:1:").len(), usize::from(revealed), "back after {wait} ms");
    }
}

#[test]
fn a_game_whose_every_record_went_on_a_pass_behind_the_changes_is_held_from_that_pass() {
    // 🔒 The pass that took its last record out of the index could not look at every change (a flood of keys after it,
    // and one of the game's own keys among them, written and taken out again, so the game is gone only once the index
    // catches up, passes later): held from that pass all the same; a close first read once the base is back counts as
    // there since then. (Back soon: revealed.)
    let late = REVEAL_CUTOFF_MS + 500;
    for (wait, revealed) in [(200, true), (late, false)] {
        let mut game = Game::new(&format!("gone-behind-{wait}"));
        game.ticks();
        assert_eq!(game.records("o:1:").len(), 1);
        let inc = game.ctx.inc.clone();
        let base_key = format!("ck:{T}:{inc}:{}", hb::ck_id(&game.base).unwrap());
        game.delete_top(&base_key);
        let own = vec![format!("xf:{T}:{inc}:{}", "ef".repeat(16))];
        game.touch(&own);
        game.untouch(&own);
        let junk = game.junk_games(6_000);
        game.untouch(&junk);
        assert!(game.tick(200).short, "behind");
        let key = (T.to_string(), inc.clone());
        assert!(!game.house.rooms[ROOM].index.as_ref().unwrap().games.contains_key(&key));
        game.closed(1, &game.sid(), &game.commit(1));
        game.seeds(1);
        game.tick(wait);
        let base = game.base.clone();
        game.put_top(&base_key, &base);
        let mut n = 0;
        while game.tick(200).short {
            n += 1;
            assert!(n < 20, "reads through");
        }
        game.ticks();
        assert_eq!(game.records("h:1:").len(), usize::from(revealed), "back after {wait} ms");
    }
}

#[test]
fn a_game_held_for_a_spell_with_no_base_and_then_gone_is_held_from_when_the_base_went() {
    // 🔒 The earlier of the two holds: a game a pass found with no base (a record of it left), whose last record went
    // later, is held from when the base went; a close first read once the base is back counts as there since then.
    let late = REVEAL_CUTOFF_MS + 500;
    let mut game = Game::new("base-then-gone-hold");
    game.ticks();
    assert_eq!(game.records("o:1:").len(), 1);
    let inc = game.ctx.inc.clone();
    let base_key = format!("ck:{T}:{inc}:{}", hb::ck_id(&game.base).unwrap());
    let fin = format!("fin:{T}:{inc}");
    game.put_top(&fin, &obj(vec![("x", s("junk"))]));
    game.tick(200);
    game.delete_top(&base_key);
    game.tick(200);
    let key = (T.to_string(), inc.clone());
    assert!(game.house.rooms[ROOM].tables[&key].held_since.is_some(), "held: no base");
    game.tick(late);
    game.delete_top(&fin);
    game.tick(200);
    assert!(!game.house.rooms[ROOM].index.as_ref().unwrap().games.contains_key(&key), "gone");
    game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    let base = game.base.clone();
    game.put_top(&base_key, &base);
    game.ticks();
    assert_eq!(game.records("h:1:").len(), 0, "held from when the base went");
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
fn a_check_put_off_at_a_game_with_nothing_for_this_house_keeps_it_read_until_its_forged_record_goes() {
    // 🔒 A check put off there that cannot change the base may yet find a forged record, and its answer changes no
    // record (so the index would not wake the game for it): the game is not passed by meanwhile, the next read finds the
    // record forged, and it goes at the put-back's turn; then the game is passed by. (Handed on at its first round; a
    // forged root after the root in the order the base is looked for in.)
    let mut game = Game::new("put-off-forged");
    game.ticks();
    game.transfer(&who("buyer"), 0);
    game.ticks();
    let key = (T.to_string(), game.ctx.inc.clone());
    let quiet = |game: &Game| game.house.rooms[ROOM].index.as_ref().unwrap().games[&key].quiet.clone();
    assert!(matches!(quiet(&game), Some(Quiet::Mine(_))));
    game.tick(REPUT_MS);
    let root_id = hb::ck_id(&game.base).unwrap();
    let forged = (0..)
        .map(|i: i32| with(&with(&game.base, "dl", delegation(&game.owner, &who(&format!("h{i}")).public)), "g", s(&"A".repeat(86))))
        .find(|f| hb::ck_id(f).unwrap() > root_id)
        .unwrap();
    let fkey = game.ck_key(&forged);
    game.put_top(&fkey, &forged);
    game.tick_with_passes(200, 1);
    assert_eq!(quiet(&game), None, "not passed by while its check waits");
    game.ticks();
    assert!(game.top(&fkey).is_some(), "not before the put-back's turn");
    game.tick(REPUT_MS);
    assert!(game.top(&fkey).is_none(), "found forged, and gone at it");
    game.ticks();
    assert!(matches!(quiet(&game), Some(Quiet::Mine(_))), "then passed by");
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

// ── What the node's fold in shadow follows of a game ─────────────────────────

/// The games of the house's plan for the room.
fn planned(house: &House) -> Vec<GamePlan> {
    house.fold_plan(ROOM).map(|p| p.games).unwrap_or_default()
}

/// Plans as compared: a base by its canonical bytes (the doc gives its fields in an order of its own), the rest as is.
fn as_compared(plans: &[GamePlan]) -> Vec<(GamePlan, String)> {
    plans.iter().map(|p| (GamePlan { base: CVal::Undef, ..p.clone() }, hb::canon(&p.base).expect("a base with canonical bytes"))).collect()
}

#[test]
fn the_plan_names_a_game_it_serves_with_its_base_its_session_and_its_houses_by_round() {
    // The deed is another's, who delegated nothing: the room has no house tables of this house's, and the plan is of
    // the game only.
    let mut game = Game::opened("plan", "landlord");
    assert!(game.house.fold_plan(ROOM).is_none(), "nothing read yet");
    game.tick(0);
    let plan = game.house.fold_plan(ROOM).expect("a plan of the game");
    assert!(plan.tables.is_empty());
    assert_eq!(plan.houses, vec![game.house.public().to_string()]);
    let me = game.house.public().to_string();
    let first = GamePlan {
        t: T.into(),
        inc: game.ctx.inc.clone(),
        rv: "f1".into(),
        base_key: game.ck_key(&game.base),
        base: game.base.clone(),
        sid: game.sid(),
        spans: vec![(me.clone(), 0, None)],
    };
    assert_eq!(as_compared(&plan.games), as_compared(&[first.clone()]));

    // Round 1 decided by its reveal, and trimmed: the plan follows the new base and the session after it.
    let (c, _, _) = game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    let reveal = game.records("h:1:")[0].0.rsplit(':').next().unwrap().to_string();
    let commit2 = game.commit(2);
    game.trim(1, &c, &reveal, Some(&commit2));
    game.ticks();
    let after = GamePlan { base_key: game.ck_key(&game.base), base: game.base.clone(), sid: game.sid(), ..first.clone() };
    assert_ne!(after.sid, first.sid);
    assert_eq!(as_compared(&planned(&game.house)), as_compared(&[after]));
}

#[test]
fn a_game_is_planned_beside_the_house_tables_of_the_deed_holder_it_is_a_house_of() {
    let mut game = Game::new("plan-beside");
    // The deed holder delegates this house under its key in the room: a house of the room's house tables too.
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&game.owner, game.house.public()));
    game.ticks();
    let plan = game.house.fold_plan(ROOM).expect("a plan");
    assert_eq!(plan.owner, "owner");
    assert_eq!(plan.games.len(), 1);
    assert_eq!(plan.games[0].spans, vec![(game.house.public().to_string(), 0, None)]);
}

#[test]
fn after_a_hand_over_each_house_is_a_house_of_its_holders_rounds_only() {
    let mut game = Game::new("plan-hand-over");
    game.closed_on_the_join();
    let me = game.house.public().to_string();
    // Handed to the buyer at round 1, in flight: the seller's house is a house of round 1 only.
    let buyer = who("buyer");
    game.transfer(&buyer, 1);
    let mut theirs = game.second_house(9, &buyer);
    game.ticks();
    assert_eq!(planned(&game.house)[0].spans, vec![(me.clone(), 0, Some(1))]);
    // The seller's house reveals round 1, and the buyer's joins round 2: each one's plan names both, each a house of
    // its own holder's rounds.
    game.seeds(1);
    game.ticks();
    game.ticks_of(&mut theirs);
    assert_eq!(game.of("o:2:", theirs.public()).len(), 1, "the buyer's house joined round 2");
    game.ticks();
    let both = vec![(me.clone(), 0, Some(1)), (theirs.public().to_string(), 1, None)];
    assert_eq!(planned(&game.house)[0].spans, both, "the seller's house");
    let theirs_plan = theirs.fold_plan(ROOM).expect("the buyer's house's plan");
    assert_eq!(theirs_plan.games.len(), 1);
    assert_eq!(theirs_plan.games[0].spans, both, "the buyer's house");
}

#[test]
fn a_game_it_does_not_serve_has_no_plan() {
    // Not served: no plan.
    let mut game = Game::new("plan-off");
    game.tick(0);
    assert_eq!(planned(&game.house).len(), 1);
    game.house.serve_fair_only(false);
    assert!(game.house.fold_plan(ROOM).is_none(), "off: no game is followed");
    game.house.serve_fair_only(true);
    assert!(game.house.fold_plan(ROOM).is_none(), "on again: nothing from before it was off");
    game.ticks();
    assert_eq!(planned(&game.house).len(), 1, "on again: planned afresh");

    // Handed on before any of its rounds was decided, to a holder who did not delegate this house: none of its rounds
    // is this house's, and it is followed no more. (Under an end order it is still served, and followed: its rounds in
    // flight are this house's to reveal.)
    game.fin(&game.owner);
    game.ticks();
    assert_eq!(planned(&game.house).len(), 1, "an end order: still served");
    game.transfer(&who("buyer"), 0);
    game.ticks();
    assert!(planned(&game.house).is_empty(), "none of its rounds is this house's");
}

#[test]
fn a_game_whose_records_are_gone_has_no_plan() {
    let mut game = Game::new("plan-gone");
    game.tick(0);
    assert_eq!(planned(&game.house).len(), 1);
    // A peer deletes the game's checkpoint and its session: the doc holds no record of it.
    game.delete_top(&game.ck_key(&game.base));
    game.delete_top(&game.ses.clone());
    game.ticks();
    assert!(planned(&game.house).is_empty());
}

// ── 🔒 The trim (design-final section 8.5 N3, N4, N5; computedSimHouse.ts trimDuty) ─────────────────────────────────

/// A round of the fold's answer, undecided, missing no slip.
fn round(r: i64, close: &str) -> RoundSummary {
    RoundSummary {
        r,
        close: close.into(),
        decided: None,
        counted: vec![],
        pocket: None,
        deltas: vec![],
        house: None,
        forfeit: None,
        abandon: None,
        copies: None,
        dice: None,
        missing: Some(vec![]),
        seven_out: None,
    }
}

/// Round r decided by the house reveal of hash `reveal` on close `close`, its outcome pocket 17, its decider and the
/// reveals it counted under `copies`.
fn by_house(r: i64, close: &str, reveal: &str, copies: &[&str]) -> RoundSummary {
    RoundSummary { decided: Some("house".into()), house: Some(reveal.into()), pocket: Some(17), copies: Some(copies.iter().map(|c| c.to_string()).collect()), ..round(r, close) }
}

/// The last checkpoint of each FAIR ONLY game this house signed, as its rows file has it: its key and canonical bytes.
fn rows_on_disk(dir: &std::path::Path) -> BTreeMap<(String, String, String), (String, String)> {
    let rows = parse_rows(&std::fs::read(dir.join(ROWS_FILE)).unwrap()).unwrap();
    rows.into_iter().map(|(at, row)| (at, (row.key, hb::canon(&row.value).unwrap()))).collect()
}

/// A value's canonical bytes (a record read back from the doc has its fields in another order).
fn canon_of(v: Option<CVal>) -> Option<String> {
    v.as_ref().and_then(hb::canon)
}

impl Game {
    /// The fold's answer for the live session as the bundle gives one of a FAIR ONLY game: rounds `rounds`, the open
    /// round `open` asking for `required`; alice 5 up and bob 5 down; kept 1,000 bytes of 1,000.
    fn summary(&self, rounds: Vec<RoundSummary>, open: i64, required: Option<String>) -> FoldSummary {
        FoldSummary {
            v: 1,
            rules: None,
            base: BaseSummary { sid: self.sid(), u: self.base.get("u").and_then(CVal::as_int).unwrap(), l: None, n: vec![], ended: false, h: None },
            rounds,
            tip: None,
            open,
            parent: String::new(),
            house_table: false,
            required,
            joins: vec![],
            nets: vec![("alice".into(), "5".into()), ("bob".into(), "-5".into())],
            held: vec![],
            carry: serde_json::Value::Null,
            pending: false,
            records: 0,
            bytes: 0,
            raw_bytes: 1_000,
            kept: Some(1_000),
            felt_bytes: Some(0),
            felts: Some(0),
            carry_felts: Some(vec![]),
            open_closes: Some(vec![]),
        }
    }

    /// The digest of the records the live session holds now, as the fold's mirror keeps them.
    fn digest(&self) -> String {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, &self.ses) else { return records_digest([]) };
        let mut keys: Vec<String> = m
            .iter(&txn)
            .filter_map(|(k, v)| match v {
                // (A record a page may read otherwise is none to the mirror: it reads it so.)
                Out::Any(a) if hb::clarity(&a) == hb::Clarity::Clear && own_record(k, &CVal::from_any(&a)) => Some(k.to_string()),
                _ => None,
            })
            .collect();
        keys.sort();
        records_digest(keys.iter().map(String::as_str))
    }

    /// `f` as the fold in shadow would put it where the house reads it: on the game's base, of the session as the doc
    /// holds it now, under the houses by round of the house's plan.
    fn answer(&mut self, f: FoldSummary) {
        let spans = self.house.fold_plan(ROOM).expect("a plan").games.into_iter().find(|g| g.inc == self.ctx.inc).expect("the game planned").spans;
        self.answer_with(f, spans, self.digest());
    }

    fn answer_with(&mut self, summary: FoldSummary, spans: Vec<(String, i64, Option<i64>)>, digest: String) {
        let answer = GameAnswer {
            base_key: self.ck_key(&self.base),
            sid: self.sid(),
            spans,
            digest,
            born: 1,
            frame: 1,
            summary,
            #[cfg(feature = "house-fold")]
            pins: Some((self.pins.watch(), self.pins.watch().epoch())),
        };
        self.answers.lock().unwrap().insert((ROOM.to_string(), T.to_string(), self.ctx.inc.clone()), answer);
    }

    fn no_answer(&mut self) {
        self.answers.lock().unwrap().clear();
    }

    /// Put `v` under `key` in the live session as it is, whatever it is.
    fn put_in_session(&self, key: &str, v: Any) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &self.ses) else { panic!("no session {}", self.ses) };
        m.insert(&mut txn, key, v);
    }

    /// Delete `key` from the live session.
    fn delete_in_session(&self, key: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &self.ses) else { panic!("no session {}", self.ses) };
        m.remove(&mut txn, key);
    }

    /// Not trimmed: the base the test laid is still in the doc (a trim deletes every checkpoint of the game but its
    /// own). (One checkpoint is not enough: a trim leaves one too.)
    fn untrimmed(&self) -> bool {
        let base = self.ck_key(&self.base);
        self.cks().iter().any(|(k, _)| *k == base)
    }

    /// The game's checkpoints in the doc, by key.
    fn cks(&self) -> Vec<(String, CVal)> {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let prefix = format!("ck:{T}:{}:", self.ctx.inc);
        let mut out: Vec<(String, CVal)> = comp
            .iter(&txn)
            .filter(|(k, _)| k.starts_with(&prefix))
            .filter_map(|(k, v)| match v {
                Out::Any(a) => Some((k.to_string(), CVal::from_any(&a))),
                _ => None,
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// The doc's session maps of the game.
    fn sessions(&self) -> Vec<String> {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let prefix = format!("ses:{T}:{}:", self.ctx.inc);
        let mut out: Vec<String> = comp.iter(&txn).filter(|(k, v)| k.starts_with(&prefix) && matches!(v, Out::YMap(_))).map(|(k, _)| k.to_string()).collect();
        out.sort();
        out
    }

    /// The game as a page resolves it from the doc: the base's key.
    fn resolved_base(&self) -> Option<String> {
        let cks = self.cks();
        let deleg = self.top(&format!("hk:{}", self.house.public()));
        let rec = ha::AuthRecords { cks: cks.iter().map(|(k, v)| (k.as_str(), v)).collect(), xfs: vec![], fins: vec![], delegations: deleg.iter().collect() };
        let res = ha::resolve_game(ROOM, T, &self.ctx.inc, None, &rec, &mut |_, k, bytes, g| bytes().map(|b| hb::verify(k, &b, g)));
        assert!(!res.pending);
        res.base.map(|b| b.key)
    }

    /// Round 1 joined, closed on the join and revealed by the house: (close, its key, the reveal's key, its hash).
    fn revealed_round_one(&mut self) -> (String, String, String, String) {
        let (c, _, _) = self.closed_on_the_join();
        self.seeds(1);
        self.ticks();
        let (rk, _) = self.records("h:1:").into_iter().next().expect("the house revealed round 1");
        let hash = rk.rsplit(':').next().unwrap().to_string();
        let ck = self.records("c:1:").into_iter().map(|(k, _)| k).find(|k| k.ends_with(&c)).unwrap();
        (c, ck, rk, hash)
    }

    /// The answer of round 1 decided by the house's reveal and nothing else, under pressure (kept 100 KiB): the trim's
    /// every condition met but the time since the round was decided.
    fn pressed_answer(&mut self, c: &str, ck: &str, rk: &str, hash: &str) -> FoldSummary {
        let mut f = self.summary(vec![by_house(1, c, hash, &[ck, rk])], 2, Some(self.commit(2)));
        f.kept = Some(100 * 1024);
        f.raw_bytes = 100 * 1024;
        f
    }
}

#[test]
fn the_house_trims_a_game_from_the_folds_answer_signs_it_and_keeps_its_row() {
    let mut game = Game::opened("trim", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    // A felt of the open round, and an earlier base's checkpoint with its session, which the trim deletes too.
    let felt = game.slip(&who("carol"), 2);
    let felt_key = format!("s:2:carol:{felt}");
    // (And a join of the open round, as the fold names it: whatever is under its key goes with it.)
    let join = "ef".repeat(16);
    let join_key = format!("o:2:{join}");
    game.put_in_session(&join_key, to_any(&obj(vec![("r", CVal::Int(2))])));
    let (old_base, old_ses) = (game.ck_key(&game.base), game.ses.clone());
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.carry_felts = Some(vec![felt_key.clone()]);
    f.joins = vec![join];
    game.answer(f);
    // Not before HOUSE_TRIM_AFTER_MS since its reveal decided the round.
    game.tick(200);
    assert!(game.untrimmed(), "too soon");
    game.tick(HOUSE_TRIM_AFTER_MS);
    let cks = game.cks();
    assert_eq!(cks.len(), 1, "the base it trimmed from is gone: {cks:?}");
    let (key, v) = &cks[0];
    assert_ne!(*key, old_base);
    let me = game.house.public().to_string();
    assert_eq!(str_of(v, "b"), Some(game.sid().as_str()));
    assert_eq!(v.get("u").and_then(CVal::as_int), Some(1));
    assert_eq!(str_of(v, "l"), Some(c.as_str()));
    assert_eq!(str_of(v, "d"), Some(format!("h:{hash}").as_str()));
    assert_eq!(v.get("o").and_then(CVal::as_int), Some(17));
    assert_eq!(canon_of(v.get("n").cloned()), hb::canon(&obj(vec![("alice", s("5")), ("bob", s("-5"))])));
    assert_eq!(str_of(v, "h"), Some(game.commit(2).as_str()));
    assert_eq!(v.get("dl").and_then(hb::canon), hb::canon(&delegation(&game.owner, &me)));
    assert_eq!(str_of(v, "k"), Some(me.as_str()));
    assert!(v.get("s").is_none() && v.get("x").is_none() && v.get("w").is_none() && v.get("e").is_none());
    for k in ["ok", "j", "rv", "ts"] {
        assert_eq!(v.get(k), game.base.get(k), "{k} is the base's");
    }
    assert!(hb::verify(&me, &hb::sign_bytes("ck", &game.ctx, &with_out(v, "g")).unwrap(), str_of(v, "g").unwrap()));
    assert_eq!(*key, game.ck_key(v));
    // The pages count from it, and its session holds what the trim carried: the open round's felt, round 1's decider
    // and its reveal.
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
    let next = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, v).unwrap());
    assert_eq!(game.sessions(), vec![next.clone()], "the old session ({old_ses}) is gone");
    game.ses = next;
    let held: Vec<String> = game.records("").into_iter().map(|(k, _)| k).collect();
    assert_eq!(held, sorted(vec![ck.clone(), felt_key, join_key, rk.clone()]));
    // On disk, and counted.
    let rows = rows_on_disk(&game.dir);
    assert_eq!(rows.get(&(ROOM.to_string(), T.to_string(), game.ctx.inc.clone())), Some(&(key.clone(), hb::canon(v).unwrap())));
    assert_eq!(game.house.game_counts(), GameCounts { trims: 1, sweeps: 0, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 });
    // What it waited for and when its rounds were decided are of the session it closed: gone with it.
    let mem = &game.house.rooms[ROOM].tables[&(T.to_string(), game.ctx.inc.clone())];
    assert!(mem.decided_at.is_empty() && mem.waits.is_empty());
    // And the house plays on from it: once its walk reads it, the plan follows it.
    game.base = v.clone();
    game.no_answer();
    game.ticks();
    assert_eq!(planned(&game.house)[0].base_key, *key);
    game.tick(REPUT_MS);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 1, sweeps: 0, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 }, "once, and its checkpoint is there: nothing to put back");
}

/// `v` without field `k`.
fn with_out(v: &CVal, k: &str) -> CVal {
    let CVal::Obj(fields) = v else { panic!("no record") };
    CVal::Obj(fields.iter().filter(|(f, _)| f != k).cloned().collect())
}

#[test]
fn a_craps_trim_carries_the_dice_and_the_carry() {
    let mut game = Game::opened_as("trim-craps", "landlord", 'q');
    let (c, ck, rk, hash) = game.revealed_round_one();
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.rounds[0].pocket = None;
    f.rounds[0].dice = Some([3, 1]);
    f.carry = serde_json::json!({ "p": 4, "w": {} });
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    let cks = game.cks();
    assert_eq!(cks.len(), 1);
    let v = &cks[0].1;
    assert_eq!(v.get("u").and_then(CVal::as_int), Some(1));
    assert_eq!(v.get("o"), Some(&CVal::Arr(vec![CVal::Int(3), CVal::Int(1)])));
    assert_eq!(canon_of(v.get("s").cloned()), hb::canon(&obj(vec![("p", CVal::Int(4)), ("w", obj(vec![]))])));
    assert_eq!(game.resolved_base().as_deref(), Some(cks[0].0.as_str()));
}

#[test]
fn a_round_a_bettors_abandon_decided_is_trimmed_to_with_its_abandon() {
    let mut game = Game::opened("trim-abandon", "landlord");
    let (c, a, b) = game.closed_on_the_join();
    let _ = (a, b);
    game.abandon(&who("alice"), 1, &c);
    game.ticks();
    let z = game.records("z:1:")[0].0.rsplit(':').next().unwrap().to_string();
    let mut f = game.summary(vec![RoundSummary { decided: Some("void".into()), abandon: Some(z.clone()), ..round(1, &c) }], 2, None);
    f.kept = Some(100 * 1024);
    game.answer(f);
    // The abandon's time runs from when the trim first read it.
    game.tick(200);
    assert!(game.untrimmed());
    game.tick(HOUSE_TRIM_AFTER_MS);
    let cks = game.cks();
    assert_eq!(cks.len(), 1);
    assert_eq!(cks[0].1.get("u").and_then(CVal::as_int), Some(1), "trimmed");
    assert_eq!(str_of(&cks[0].1, "d"), Some(format!("z:{z}").as_str()));
    assert!(cks[0].1.get("o").is_none() && cks[0].1.get("h").is_none(), "no outcome, no commitment");
}

#[test]
fn no_trim_from_an_answer_that_is_not_the_session_the_house_reads() {
    let mut game = Game::opened("trim-stale", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    let spans = planned(&game.house)[0].spans.clone();
    // A record the answer did not see.
    let digest = game.digest();
    game.slip(&who("carol"), 2);
    game.answer_with(f.clone(), spans.clone(), digest);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed(), "a felt came after the answer");
    // Other houses by round, or none of the game's.
    game.answer_with(f.clone(), vec![], game.digest());
    game.tick(200);
    assert!(game.untrimmed(), "other houses");
    // Another base or session.
    let mut other = GameAnswer {
        base_key: "ck:x".into(),
        sid: game.sid(),
        spans: spans.clone(),
        digest: game.digest(),
        born: 1,
        frame: 1,
        summary: f.clone(),
        #[cfg(feature = "house-fold")]
        pins: Some((game.pins.watch(), game.pins.watch().epoch())),
    };
    game.answers.lock().unwrap().insert((ROOM.to_string(), T.to_string(), game.ctx.inc.clone()), other.clone());
    game.tick(200);
    assert!(game.untrimmed(), "another base");
    other.base_key = game.ck_key(&game.base);
    other.sid = "abc".into();
    game.answers.lock().unwrap().insert((ROOM.to_string(), T.to_string(), game.ctx.inc.clone()), other);
    game.tick(200);
    assert!(game.untrimmed(), "another session");
    // One whose fold has signatures left to check.
    game.answer(FoldSummary { pending: true, ..f.clone() });
    game.tick(200);
    assert!(game.untrimmed(), "not finished");
    // The answer of the session as it is.
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[test]
fn no_trim_while_a_round_is_in_flight_or_the_round_is_not_one_it_may_trim_to() {
    let mut game = Game::opened("trim-not", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    // A close of the open round.
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.tip = Some(2);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed(), "a round in flight");
    // Nothing decided past the base.
    let f = game.summary(vec![round(1, &c)], 1, Some(game.commit(1)));
    game.answer(FoldSummary { kept: Some(100 * 1024), ..f });
    game.tick(200);
    assert!(game.untrimmed(), "nothing decided");
    // Decided otherwise than by this house's reveal or an abandon.
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.rounds[0] = RoundSummary { decided: Some("reveals".into()), ..round(1, &c) };
    game.answer(f);
    game.tick(200);
    assert!(game.untrimmed(), "every seed in");
    // By a reveal that is not the one its state file has.
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.rounds[0].house = Some("ab".repeat(16));
    game.answer(f);
    game.tick(200);
    assert!(game.untrimmed(), "another reveal");
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.rounds[0].close = "cd".repeat(16);
    game.answer(f);
    game.tick(200);
    assert!(game.untrimmed(), "another close");
    // (Its own round read under another close waits MISSING_WAIT_MS for the record it lost; past it, still not its
    // reveal's round to trim to, and nothing to cross-check.)
    game.tick(MISSING_WAIT_MS);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed(), "another close, past the wait");
    assert_eq!(game.house.game_counts(), GameCounts::default());
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[test]
fn no_trim_to_a_round_before_the_holder_it_serves_held_the_game() {
    let mut game = Game::opened("trim-from", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    // Handed to the buyer from round 2, who delegates this house: round 1 is the seller's, and so is the round a
    // checkpoint at the hand-over stands at (none past it is the buyer's yet).
    let buyer = who("buyer");
    game.transfer(&buyer, 2);
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&buyer, game.house.public()));
    game.ticks();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed(), "round 1 is under the round the buyer holds the game from");
    assert_eq!(game.house.game_counts(), GameCounts::default(), "and no checkpoint is made to be refused");
}

/// An abandon-decided round `r` on top of round 1 decided by the house's reveal.
fn abandoned_after(r: i64) -> RoundSummary {
    RoundSummary { decided: Some("void".into()), abandon: Some("12".repeat(16)), ..round(r, &"34".repeat(16)) }
}

#[test]
fn a_trim_waits_for_pressure() {
    type Press = Box<dyn Fn(&mut FoldSummary, &mut Game)>;
    let cases: Vec<(&str, Press, Press)> = vec![
        (
            "rounds",
            Box::new(|f: &mut FoldSummary, _: &mut Game| f.rounds.push(abandoned_after(HOUSE_TRIM_ROUNDS - 1))),
            Box::new(|f: &mut FoldSummary, _: &mut Game| f.rounds.push(abandoned_after(HOUSE_TRIM_ROUNDS))),
        ),
        ("bytes", Box::new(|f: &mut FoldSummary, _: &mut Game| f.kept = Some(HOUSE_TRIM_BYTES - 1)), Box::new(|f: &mut FoldSummary, _: &mut Game| f.kept = Some(HOUSE_TRIM_BYTES))),
        (
            "junk",
            Box::new(|f: &mut FoldSummary, _: &mut Game| f.raw_bytes = 1_000 + HOUSE_SWEEP_BYTES - 1),
            Box::new(|f: &mut FoldSummary, _: &mut Game| f.raw_bytes = 1_000 + HOUSE_SWEEP_BYTES),
        ),
        (
            "seven-out",
            Box::new(|f: &mut FoldSummary, _: &mut Game| f.rounds.push(RoundSummary { seven_out: Some(true), ..abandoned_after(HOUSE_SEVEN_OUT_MIN - 1) })),
            Box::new(|f: &mut FoldSummary, _: &mut Game| f.rounds.push(RoundSummary { seven_out: Some(true), ..abandoned_after(HOUSE_SEVEN_OUT_MIN) })),
        ),
        ("idle", Box::new(|_: &mut FoldSummary, g: &mut Game| g.now += HOUSE_IDLE_MS - 10_000), Box::new(|_: &mut FoldSummary, g: &mut Game| g.now += 1_000)),
    ];
    for (name, short, pressed) in cases {
        let mut game = Game::opened(&format!("trim-press-{name}"), "landlord");
        let (c, ck, rk, hash) = game.revealed_round_one();
        let base = game.summary(vec![by_house(1, &c, &hash, &[&ck, &rk])], 2, Some(game.commit(2)));
        game.answer(base.clone());
        game.tick(HOUSE_TRIM_AFTER_MS);
        assert!(game.untrimmed(), "{name}: no pressure");
        let mut f = base.clone();
        short(&mut f, &mut game);
        game.answer(f.clone());
        game.tick(0);
        game.tick(HOUSE_TRIM_AFTER_MS);
        assert_eq!(game.house.game_counts().trims, 0, "{name}: short of it");
        let mut f = base.clone();
        short(&mut f, &mut game);
        pressed(&mut f, &mut game);
        game.answer(f);
        game.tick(0);
        game.tick(HOUSE_TRIM_AFTER_MS);
        assert_eq!(game.house.game_counts().trims, 1, "{name}: pressed");
    }
}

#[test]
fn the_rooms_games_heavy_together_press_a_trim_of_one_not_light() {
    for (other_kept, kept, trims) in [
        (HOUSE_ROOM_BYTES - HOUSE_ROOM_MIN_BYTES - 1, HOUSE_ROOM_MIN_BYTES, 0),
        (HOUSE_ROOM_BYTES, HOUSE_ROOM_MIN_BYTES - 1, 0),
        (HOUSE_ROOM_BYTES - HOUSE_ROOM_MIN_BYTES, HOUSE_ROOM_MIN_BYTES, 1),
    ] {
        let mut game = Game::opened(&format!("trim-room-{other_kept}-{kept}"), "landlord");
        let (c, ck, rk, hash) = game.revealed_round_one();
        // Another game of the room the house remembers as that heavy; and a house table, which is none of the games'.
        let tables = &mut game.house.rooms.get_mut(ROOM).unwrap().tables;
        tables.entry((T2.to_string(), format!("p{}", "0".repeat(24)))).or_default().kept = other_kept;
        tables.entry((T2.to_string(), INC_R.to_string())).or_default().kept = HOUSE_ROOM_BYTES;
        let mut f = game.summary(vec![by_house(1, &c, &hash, &[&ck, &rk])], 2, Some(game.commit(2)));
        f.kept = Some(kept);
        f.raw_bytes = kept;
        game.answer(f);
        game.tick(HOUSE_TRIM_AFTER_MS);
        assert_eq!(game.house.game_counts().trims, trims, "{other_kept} + {kept}");
    }
}

#[test]
fn the_cross_check_refuses_an_answer_that_disagrees_with_what_the_house_knows() {
    type Fault = Box<dyn FnMut(&mut Vec<(String, CVal)>) + Send>;
    let set = |k: &'static str, v: CVal| -> Fault { Box::new(move |b: &mut Vec<(String, CVal)>| b.iter_mut().filter(|(f, _)| f == k).for_each(|(_, x)| *x = v.clone())) };
    let faults: Vec<(&str, Fault)> = vec![
        ("b", set("b", s("abc"))),
        ("u", set("u", CVal::Int(2))),
        ("l", set("l", s(&"ab".repeat(16)))),
        ("d", set("d", s(&format!("h:{}", "ab".repeat(16))))),
        ("h", set("h", s(&"cd".repeat(32)))),
        ("h gone", Box::new(|b: &mut Vec<(String, CVal)>| b.retain(|(f, _)| f != "h"))),
        ("nets", Box::new(|b: &mut Vec<(String, CVal)>| {
            let n: Vec<(String, CVal)> = (0..=ha::MAX_TABLE_PIDS).map(|i| (format!("p{i}"), s("0"))).collect();
            b.iter_mut().filter(|(f, _)| f == "n").for_each(|(_, x)| *x = CVal::Obj(n.clone()));
        })),
        ("not a page's", set("ts", s("then"))),
    ];
    for (name, fault) in faults {
        let mut game = Game::opened(&format!("trim-cross-{}", name.replace(' ', "-")), "landlord");
        let (c, ck, rk, hash) = game.revealed_round_one();
        game.house.fault_trim = Some(fault);
        let f = game.pressed_answer(&c, &ck, &rk, &hash);
        game.answer(f);
        game.tick(HOUSE_TRIM_AFTER_MS);
        assert!(game.untrimmed(), "{name}: not signed");
        assert_eq!(game.house.game_counts(), GameCounts { trims: 0, sweeps: 0, ends: 0, cross_check_mismatches: 1, row_put_backs: 0 }, "{name}");
        assert!(!game.dir.join(ROWS_FILE).exists(), "{name}: no row");
    }
}

#[test]
fn the_cross_check_holds_the_commitment_to_what_its_reveal_carried_and_none_after_a_step_down() {
    let mut game = Game::opened("trim-commit", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    // The fold says round 2 asks for no commitment, where its reveal carried one.
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.required = None;
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts().cross_check_mismatches, 1);
    // Stepped down since: the commitment is lifted, and a trim that names it is refused.
    game.house.begin_step_down();
    game.no_answer();
    game.ticks();
    assert!(game.house.last_of(&game.ctx).unwrap().r > 1, "stepped down");
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().cross_check_mismatches, 2);
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.required = None;
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1, "none named");
}

#[test]
fn a_missing_frozen_slip_holds_the_trim_for_the_wait_and_a_tick_without_an_answer_starts_it_over() {
    let mut game = Game::opened("trim-wait", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.rounds[0].missing = Some(vec!["bob".into()]);
    game.answer(f.clone());
    game.tick(HOUSE_TRIM_AFTER_MS);
    game.tick(MISSING_WAIT_MS - HOUSE_TRIM_AFTER_MS - 1);
    assert!(game.untrimmed(), "waiting");
    // A tick with no answer forgets it.
    game.no_answer();
    game.tick(1);
    game.answer(f.clone());
    game.tick(MISSING_WAIT_MS - 1);
    assert!(game.untrimmed(), "waiting afresh");
    // Another slip missing waits on its own.
    f.rounds[0].missing = Some(vec!["alice".into(), "bob".into()]);
    game.answer(f.clone());
    game.tick(1);
    assert!(game.untrimmed(), "alice's waits from now");
    game.tick(MISSING_WAIT_MS - 1);
    assert!(game.untrimmed());
    game.tick(1);
    assert_eq!(game.house.game_counts().trims, 1, "nobody put them back");
}

#[test]
fn its_own_round_read_otherwise_holds_a_trim_to_an_abandon_for_the_wait() {
    let mut game = Game::opened("trim-own-round", "landlord");
    let (c, _, _, _) = game.revealed_round_one();
    // Round 1 read as an abandon decided it on another close: the slip its reveal counted is gone.
    let other = "ef".repeat(16);
    let z = "12".repeat(16);
    let mut f = game.summary(vec![RoundSummary { decided: Some("void".into()), abandon: Some(z), ..round(1, &other) }], 2, None);
    f.kept = Some(100 * 1024);
    let _ = c;
    game.answer(f.clone());
    game.tick(HOUSE_TRIM_AFTER_MS);
    game.tick(MISSING_WAIT_MS - 1);
    assert!(game.untrimmed(), "waiting for its round");
    // (And an abandon's time runs from when the trim first reads the round decided by it, once nothing is waited for.)
    game.tick(1);
    assert!(game.untrimmed());
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[test]
fn nothing_of_its_own_into_the_session_it_would_close_the_same_pass() {
    let mut game = Game::opened("trim-own-write", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    game.tick(HOUSE_TRIM_AFTER_MS);
    // Round 2 closed: the pass that reveals it writes into the session; the answer is of the session before.
    let (c2, _, _) = game.closed(2, &c, &game.commit(2));
    game.seeds(2);
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.records("h:2:").len(), 1, "revealed round 2");
    let _ = c2;
    assert_eq!(game.house.game_counts().trims, 0);
}

#[test]
fn no_trim_from_a_doc_that_holds_part_of_an_update() {
    let mut game = Game::opened("trim-partial", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let (first, second) = game.updates_out_of_order();
    game.apply_update(&second);
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed());
    game.apply_update(&first);
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[test]
fn a_trim_it_cannot_note_on_disk_is_not_written() {
    let mut game = Game::opened("trim-disk", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    std::fs::create_dir_all(game.dir.join(ROWS_FILE)).unwrap();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed());
    assert_eq!(game.house.game_counts(), GameCounts::default());
    std::fs::remove_dir_all(game.dir.join(ROWS_FILE)).unwrap();
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[test]
fn its_last_checkpoint_goes_back_while_none_stands_above_it_and_after_a_start() {
    let mut game = Game::opened("trim-reput", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    let (key, v) = game.cks().into_iter().next().unwrap();
    game.no_answer();
    // Gone from the doc: back at the put-back's turn.
    game.delete_top(&key);
    game.tick(REPUT_MS);
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v));
    assert_eq!(game.house.game_counts().row_put_backs, 1);
    // Junk under its key: the same. (The session it opens is there: as it is.)
    let live = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, &v).unwrap());
    game.ses = live.clone();
    game.put_in_session("left-as-it-is", Any::Number(1.0));
    let held = game.records_in(&live);
    game.put_top(&key, &s("junk"));
    game.tick(REPUT_MS);
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v));
    assert_eq!(game.records_in(&live), held, "its session as it was");
    // Every record of the game gone, the session's too: it goes back all the same, once the doc holds no part of an
    // update.
    for (k, _) in game.cks() {
        game.delete_top(&k);
    }
    for k in game.sessions() {
        game.delete_top(&k);
    }
    let (first, second) = game.updates_out_of_order();
    game.apply_update(&second);
    game.tick(REPUT_MS);
    game.tick(REPUT_MS);
    assert!(game.top(&key).is_none(), "not from a doc that holds part of an update");
    game.apply_update(&first);
    game.tick(REPUT_MS);
    game.tick(REPUT_MS);
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v), "a game the doc holds nothing of");
    // (With the session it opens, which holds nothing its trim carried: the session it closed is gone with them.)
    let next = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, &v).unwrap());
    assert_eq!(game.sessions(), vec![next.clone()]);
    game.ses = next;
    assert!(game.records("").iter().all(|(k, _)| *k != ck && *k != rk), "{:?}", game.records(""));
    // After a start, from its rows file.
    let dir = game.dir.clone();
    let mut again = House::open(&NODE, Some(dir.join(STATE_FILE))).unwrap();
    again.settle_ms = 0;
    again.serve_fair_only(true);
    game.delete_top(&key);
    game.tick_of(&mut again);
    game.now += REPUT_MS;
    game.tick_of(&mut again);
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v), "after a start");
    assert_eq!(again.game_counts().row_put_backs, 1);
}

impl Game {
    /// The doc as it is now: as the node's saved room would hold it, had it stopped now.
    fn saved(&self) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
    }

    /// The node stopped and started again with its state file and rows, on the doc as `saved` held it: what it wrote
    /// since is lost, as no page had it.
    fn stopped_before_it_saved(&mut self, saved: &[u8]) {
        use yrs::updates::decoder::Decode;
        let doc = Doc::new();
        doc.transact_mut().apply_update(yrs::Update::decode_v1(saved).unwrap()).unwrap();
        self.doc = doc;
        self.restart(0);
        self.no_answer();
    }

    /// Session `ses`'s records: their keys and canonical bytes.
    fn records_in(&mut self, ses: &str) -> Vec<(String, Option<String>)> {
        let live = std::mem::replace(&mut self.ses, ses.to_string());
        let out = self.records("").into_iter().map(|(k, v)| (k, hb::canon(&v))).collect();
        self.ses = live;
        out
    }
}

/// A trim of round 1 that carried the open round's felts of carol and dave and a join of it, with round 1's decider and
/// reveal: the game; the checkpoint's key and value; the session it closed, and the one it opened; and the doc just
/// before it.
fn trimmed_with_copies(name: &str) -> (Game, String, CVal, String, String, Vec<u8>) {
    let mut game = Game::opened(name, "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let carol = format!("s:2:carol:{}", game.slip(&who("carol"), 2));
    let dave = format!("s:2:dave:{}", game.slip(&who("dave"), 2));
    let join = "ef".repeat(16);
    game.put_in_session(&format!("o:2:{join}"), to_any(&obj(vec![("r", CVal::Int(2))])));
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.carry_felts = Some(vec![carol, dave]);
    f.joins = vec![join];
    game.answer(f);
    game.tick(200);
    let closed = game.ses.clone();
    let saved = game.saved();
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts().trims, 1);
    let (key, v) = game.cks().into_iter().next().unwrap();
    let next = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, &v).unwrap());
    assert_eq!(game.records_in(&next).len(), 5, "the felts, the join, the decider and its reveal");
    (game, key, v, closed, next, saved)
}

#[test]
fn a_checkpoint_put_back_after_the_doc_lost_its_trim_whole_opens_its_session_with_what_the_trim_carried() {
    let (mut game, key, v, closed, next, saved) = trimmed_with_copies("trim-lost-whole");
    let carried = game.records_in(&next);
    // The node stopped before it saved the room, and no page had the trim: the doc as it was before, the row on disk.
    game.stopped_before_it_saved(&saved);
    assert!(game.top(&key).is_none() && !game.sessions().contains(&next));
    // (Meanwhile dave's felt left the session it closed: it is not one to put back.)
    let dave = carried.iter().map(|(k, _)| k.clone()).find(|k| k.starts_with("s:2:dave:")).unwrap();
    game.ses = closed.clone();
    game.delete_in_session(&dave);
    game.tick(REPUT_MS);
    game.tick(REPUT_MS);
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v), "its checkpoint back");
    assert_eq!(game.house.game_counts().row_put_backs, 1);
    // The session it opens, with what the trim carried out of the one it closed, as the trim wrote it.
    let back = game.records_in(&next);
    assert_eq!(back, carried.into_iter().filter(|(k, _)| *k != dave).collect::<Vec<_>>());
    // Once, and the pages count from it.
    game.tick(REPUT_MS);
    assert_eq!(game.house.game_counts().row_put_backs, 1);
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[test]
fn a_checkpoint_a_page_put_back_alone_after_the_doc_lost_its_trim_gets_its_session_with_what_the_trim_carried() {
    let (mut game, key, v, _closed, next, saved) = trimmed_with_copies("trim-lost-ck-only");
    let carried = game.records_in(&next);
    game.stopped_before_it_saved(&saved);
    // A page that counted from the checkpoint puts it back, and only it: the session it opens is the house's to open.
    game.put_top(&key, &v);
    game.tick(REPUT_MS);
    game.tick(REPUT_MS);
    assert_eq!(game.records_in(&next), carried, "the session, with what the trim carried");
    assert_eq!(game.house.game_counts().row_put_backs, 0, "the checkpoint was the page's to put back");
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v));
}

#[test]
fn a_lost_session_of_its_rows_checkpoint_goes_back_with_this_houses_records_in_it() {
    let (mut game, key, _v, _closed, next, _saved) = trimmed_with_copies("trim-lost-next");
    // The house plays on in the session the trim opened: it reveals round 2 there.
    game.no_answer();
    game.ses = next.clone();
    game.closed(2, &game.sid(), &game.commit(2));
    game.seeds(2);
    game.ticks();
    let own: Vec<String> = game.records("h:2:").into_iter().map(|(k, _)| k).collect();
    assert_eq!(own.len(), 1, "its reveal of round 2");
    // The map gone (the session it closed went with the trim: nothing carried to put back), it goes back in one write
    // with its reveal in it, as any lost map does.
    game.delete_top(&next);
    // (What the put-back writes at the top of the doc, by key.)
    let written = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = written.clone();
    let _sub = yrs::Observable::observe(&game.doc.get_or_insert_map(COMPUTED_MAP), move |txn, e: &yrs::types::map::MapEvent| seen.lock().unwrap().extend(e.keys(txn).keys().map(|k| k.to_string())));
    game.tick(REPUT_MS);
    assert!(game.has_session(), "the map goes back");
    let back: Vec<String> = game.records("").into_iter().map(|(k, _)| k).collect();
    assert_eq!(back, own, "with its reveal in it, and nothing the trim carried");
    assert_eq!(*written.lock().unwrap(), vec![next.clone()], "and its checkpoint, which the doc holds, is not written again ({key})");
    assert_eq!(game.house.game_counts().row_put_backs, 0);
}

#[test]
fn no_checkpoint_goes_back_from_its_row_while_the_doc_holds_part_of_an_update() {
    let (mut game, key, v, _closed, next, saved) = trimmed_with_copies("trim-lost-partial");
    let carried = game.records_in(&next);
    game.stopped_before_it_saved(&saved);
    let (first, second) = game.updates_out_of_order();
    game.apply_update(&second);
    assert!(game.doc.transact().store().pending_update().is_some(), "the doc holds part of an update");
    for _ in 0..3 {
        game.tick(REPUT_MS);
    }
    assert!(game.top(&key).is_none(), "it, and the session it opens, may be in the part to come");
    assert!(!game.sessions().contains(&next));
    assert_eq!(game.house.game_counts().row_put_backs, 0);
    game.apply_update(&first);
    game.tick(REPUT_MS);
    game.tick(REPUT_MS);
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v));
    assert_eq!(game.records_in(&next), carried, "and its session with it");
}

#[test]
fn a_checkpoint_above_its_last_one_takes_its_row_away() {
    let mut game = Game::opened("trim-above", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    let (key, v) = game.cks().into_iter().next().unwrap();
    game.no_answer();
    game.base = v;
    game.ses = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, &game.base).unwrap());
    assert_eq!(rows_on_disk(&game.dir).len(), 1);
    // A later trim, as another of the game's houses would sign one: its row is no longer one to put back.
    game.trim(2, &"ab".repeat(16), &"cd".repeat(16), None);
    game.ticks();
    assert!(rows_on_disk(&game.dir).is_empty());
    game.delete_top(&key);
    game.tick(REPUT_MS);
    assert!(game.top(&key).is_none());
    assert_eq!(game.house.game_counts().row_put_backs, 0);
}

#[test]
fn the_rows_file_reads_back_what_it_wrote_and_no_row_whose_key_is_not_its_checkpoints() {
    let game = Game::opened("trim-rows", "landlord");
    let ck = game.base.clone();
    let key = game.ck_key(&ck);
    let path = game.dir.join(ROWS_FILE);
    let at = (ROOM.to_string(), T.to_string(), game.ctx.inc.clone());
    // With what its trim carried, each record as it was.
    let copies = vec![("s:2:carol:ab".to_string(), obj(vec![("r", CVal::Int(2)), ("p", s("carol"))])), ("o:2:cd".to_string(), obj(vec![("r", CVal::Int(2))]))];
    let canons = |copies: &[(String, CVal)]| copies.iter().map(|(k, v)| (k.clone(), hb::canon(v))).collect::<Vec<_>>();
    let mut rows = BTreeMap::new();
    rows.insert(at.clone(), Row { key: key.clone(), value: ck.clone(), copies: copies.clone() });
    write_rows(&path, &rows).unwrap();
    let back = parse_rows(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(back.keys().collect::<Vec<_>>(), vec![&at]);
    assert_eq!((back[&at].key.as_str(), hb::canon(&back[&at].value)), (key.as_str(), hb::canon(&ck)));
    assert_eq!(canons(&back[&at].copies), canons(&copies));
    // (A file of v 1, from before a row kept what its trim carried: it carried nothing.)
    let old = serde_json::json!({ "v": 1, "rows": [[ROOM, T, game.ctx.inc, key, hb::canon(&ck)]] });
    std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let back = parse_rows(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!((back[&at].key.as_str(), back[&at].copies.len()), (key.as_str(), 0));
    let wrong = serde_json::json!({ "v": 2, "rows": [[ROOM, T, game.ctx.inc, "ck:x", hb::canon(&ck), []]] });
    std::fs::write(&path, serde_json::to_vec(&wrong).unwrap()).unwrap();
    assert!(rows_on_disk(&game.dir).is_empty());
    for bad in [
        serde_json::json!({ "v": 3, "rows": [] }),
        serde_json::json!({ "v": 1 }),
        serde_json::json!({ "v": 1, "rows": [[ROOM]] }),
        serde_json::json!({ "v": 1, "rows": [[ROOM, T, game.ctx.inc, key, hb::canon(&ck), []]] }),
        serde_json::json!({ "v": 2, "rows": [[ROOM, T, game.ctx.inc, key, hb::canon(&ck)]] }),
        serde_json::json!({ "v": 2, "rows": [[ROOM, T, game.ctx.inc, key, hb::canon(&ck), [["o:2:cd"]]]] }),
    ] {
        assert!(parse_rows(&serde_json::to_vec(&bad).unwrap()).is_none(), "{bad}");
    }
    // Unreadable: the house starts all the same, with no row.
    std::fs::write(&path, b"{").unwrap();
    let house = House::open(&NODE, Some(game.dir.join(STATE_FILE))).unwrap();
    assert!(house.rows.is_empty());
}

#[test]
fn the_trim_write_lays_its_checkpoint_deletes_the_rest_and_opens_its_session() {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        comp.insert(&mut txn, "ck:t:p:old", Any::String("old".into()));
        comp.insert(&mut txn, "ck:t:p:new", Any::String("there".into()));
        comp.insert(&mut txn, "ses:t:p:aaa", MapPrelim::default());
        comp.insert(&mut txn, "other", Any::String("stays".into()));
    }
    let w = Write::Trim {
        key: "ck:t:p:new".into(),
        value: s("new"),
        gone: vec!["ck:t:p:old".into(), "ck:t:p:new".into(), "ses:t:p:aaa".into(), "ses:t:p:none".into()],
        ses: Some("ses:t:p:bbb".into()),
        copies: vec![("s:2:carol:x".into(), s("felt"))],
    };
    apply(&mut doc.transact_mut(), &[w]);
    let txn = doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let mut keys: Vec<String> = comp.keys(&txn).map(str::to_string).collect();
    keys.sort();
    assert_eq!(keys, vec!["ck:t:p:new", "other", "ses:t:p:bbb"]);
    assert_eq!(top_value_within(&comp, &txn, "ck:t:p:new", usize::MAX), Some(s("there")), "what is there stays");
    let Some(Out::YMap(m)) = comp.get(&txn, "ses:t:p:bbb") else { panic!("no session") };
    assert_eq!(m.len(&txn), 1);
}

impl Game {
    /// 🔒 The bundled fold's own answer for the live session, every signature checked, under the houses by round of the
    /// house's plan: what the fold in shadow puts where the house reads it.
    #[cfg(feature = "house-fold")]
    fn folded(&self) -> FoldSummary {
        use crate::house_fold::{strict_check, FairHouses, FoldEngine};
        let plan = planned(&self.house).into_iter().find(|g| g.inc == self.ctx.inc).expect("the game planned");
        let mut pins: Vec<(String, String)> = ["owner", "alice", "bob", "carol", "mallory", "buyer", "landlord"].iter().map(|p| (p.to_string(), who(p).public.clone())).collect();
        pins.sort();
        let mut e = FoldEngine::new(strict_check()).expect("the engine starts");
        e.open_fair_only(&self.ctx, &FairHouses { rv: plan.rv, spans: plan.spans }, Some(&self.base), &pins).unwrap();
        e.reset(&self.ctx, &self.records("")).unwrap();
        e.result(&self.ctx).unwrap()
    }
}

#[cfg(feature = "house-fold")]
#[test]
fn the_house_trims_a_game_from_the_bundled_folds_own_answer_and_the_fold_plays_on_from_its_checkpoint() {
    for letter in ['p', 'q'] {
        let mut game = Game::opened_as(&format!("trim-folded-{letter}"), "landlord", letter);
        let (_, _, _, hash) = game.revealed_round_one();
        let f = game.folded();
        assert!(!f.pending, "{letter}: every signature checked");
        let decided: Vec<_> = f.rounds.iter().map(|r| (r.r, r.decided.clone(), r.house.clone())).collect();
        assert_eq!(decided, vec![(1, Some("house".to_string()), Some(hash.clone()))], "{letter}: round 1 is the house's reveal's");
        // A game this small is pressed only once nothing new has come for HOUSE_IDLE_MS. Each tick has the fold's answer
        // for the session as it is then, as the shadow's pass after each tick puts it.
        // (Folded again only when the session has changed: the same records give the same answer.)
        let (start, mut last) = (game.now, (game.digest(), f));
        while game.cks().iter().all(|(_, v)| v.get("u").and_then(CVal::as_int) == Some(0)) {
            assert!(game.now - start < 2 * HOUSE_IDLE_MS, "{letter}: never trimmed ({:?})", game.house.game_counts());
            if game.digest() != last.0 {
                last = (game.digest(), game.folded());
            }
            game.answer(last.1.clone());
            game.tick(1_000);
        }
        assert!(game.now - start >= HOUSE_IDLE_MS - 2_000, "{letter}: not before it was idle ({} ms)", game.now - start);
        let before = last.1;
        assert_eq!(game.house.game_counts(), GameCounts { trims: 1, sweeps: 0, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 }, "{letter}");
        let cks = game.cks();
        assert_eq!(cks.len(), 1, "{letter}");
        let (key, v) = cks[0].clone();
        assert_eq!(v.get("u").and_then(CVal::as_int), Some(1), "{letter}");
        assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()), "{letter}: the pages count from it");
        // The fold opened on it with its session reads the game as it was: the same nets, the same open round asking
        // for the same commitment, the same carry, and nothing left to check.
        game.base = v.clone();
        game.ses = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, &v).unwrap());
        let after = game.folded();
        assert!(!after.pending, "{letter}");
        assert_eq!(after.base.u, 1, "{letter}");
        assert!(after.rounds.iter().all(|r| r.r > 1), "{letter}: no round at or before its base");
        assert_eq!((&after.nets, after.open, &after.required, &after.carry), (&before.nets, before.open, &before.required, &before.carry), "{letter}");
    }
}

#[test]
fn a_record_a_page_may_read_otherwise_is_in_neither_digest_and_holds_no_trim_back() {
    let mut game = Game::opened("trim-unclear", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    // A felt of round 2 under its own key whose signature fails (none the house puts back as every page reads it), with
    // a `__proto__` field that is no object: a page reads that felt, or junk.
    let felt = game.slip(&who("carol"), 2);
    let key = format!("s:2:carol:{felt}");
    let carol = game.records(&key)[0].1.clone();
    game.delete_in_session(&key);
    let bob_g = game.records("s:1:bob:")[0].1.get("g").cloned().unwrap();
    let v = with(&carol, "g", bob_g);
    let key = format!("s:2:carol:{}", hb::rec_hash(&v).unwrap());
    game.put_in_session(&key, padded(&v, Any::Null));
    let txn = game.doc.transact();
    let Some(Out::YMap(m)) = txn.get_map(COMPUTED_MAP).unwrap().get(&txn, &game.ses) else { panic!() };
    let Some(Out::Any(raw)) = m.get(&txn, &key) else { panic!("gone") };
    assert_eq!(hb::clarity(&raw), hb::Clarity::Proto);
    drop(txn);
    // The fold's mirror reads no record there, and neither does the house's read: the same records.
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[test]
fn a_new_record_starts_the_idle_time_over() {
    let mut game = Game::opened("trim-idle", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let f = game.summary(vec![by_house(1, &c, &hash, &[&ck, &rk])], 2, Some(game.commit(2)));
    game.answer(f.clone());
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed(), "not idle yet");
    // Most of the idle time on, a felt comes: idle from when the trim reads it.
    game.now += HOUSE_IDLE_MS - 10_000;
    game.slip(&who("carol"), 2);
    game.answer(f.clone());
    game.tick(0);
    game.now += 20_000;
    game.tick(0);
    assert!(game.untrimmed(), "idle 20 s since the felt");
    game.now += HOUSE_IDLE_MS - 20_000;
    game.tick(0);
    assert_eq!(game.house.game_counts().trims, 1, "idle since");
}

#[test]
fn a_trim_at_the_round_of_a_hand_over_is_the_new_holders_and_carries_the_transfer() {
    let mut game = Game::opened("trim-at-xf", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    // Handed to the buyer at round 1, who delegates this house: a checkpoint at round 1 is the buyer's to make.
    let buyer = who("buyer");
    let xf = game.transfer(&buyer, 1);
    let me = game.house.public().to_string();
    game.put_top(&format!("hk:{me}"), &delegation(&buyer, &me));
    game.ticks();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 1, sweeps: 0, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 });
    let cks = game.cks();
    assert_eq!(cks.len(), 1);
    let (key, v) = &cks[0];
    assert_eq!(v.get("u").and_then(CVal::as_int), Some(1));
    assert_eq!(v.get("dl").and_then(hb::canon), hb::canon(&delegation(&buyer, &me)), "by the delegation it serves the buyer by");
    assert_eq!(v.get("x").map(|x| x.as_arr().unwrap().iter().filter_map(hb::canon).collect::<Vec<_>>()), Some(vec![hb::canon(&xf).unwrap()]), "the chain's transfer");
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[test]
fn no_trim_to_the_round_its_base_stands_at() {
    let mut game = Game::opened("trim-at-base", "landlord");
    let (c, _, _, hash) = game.revealed_round_one();
    // Its base at round 1 already (its own trim, laid), and a felt of round 2 in the session that follows it.
    game.trim(1, &c, &hash, Some(&game.commit(2)));
    game.slip(&who("carol"), 2);
    game.ticks();
    // An answer that says round 1 was decided by an abandon: no round past the base to trim to.
    let mut f = game.summary(vec![RoundSummary { decided: Some("void".into()), abandon: Some("12".repeat(16)), ..round(1, &c) }], 2, Some(game.commit(2)));
    f.kept = Some(100 * 1024);
    game.answer(f);
    game.tick(200);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed());
    assert_eq!(game.house.game_counts(), GameCounts::default(), "and no checkpoint is made to be refused");
    // (Nothing decided past it: junk there is swept.)
    game.junk(HOUSE_SWEEP_BYTES);
    let mut f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    f.rounds = vec![RoundSummary { decided: Some("void".into()), abandon: Some("12".repeat(16)), ..round(1, &c) }];
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 0, sweeps: 1, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 });
}

#[test]
fn a_second_trim_deletes_every_session_a_checkpoint_it_read_opens() {
    let mut game = Game::opened("trim-twice", "landlord");
    let (c, _, _, hash) = game.revealed_round_one();
    // Its trim to round 1 laid beside the opening and its session, both still in the doc.
    let (root_ses, root_key) = (game.ses.clone(), game.ck_key(&game.base));
    game.trim(1, &c, &hash, Some(&game.commit(2)));
    assert_eq!(game.sessions().len(), 2);
    // Round 2 on it, revealed.
    let (c2, _, _) = game.closed(2, &game.sid(), &game.commit(2));
    game.seeds(2);
    game.ticks();
    let (rk2, _) = game.records("h:2:").into_iter().next().expect("the house revealed round 2");
    let hash2 = rk2.rsplit(':').next().unwrap().to_string();
    let ck2 = game.records("c:2:").into_iter().map(|(k, _)| k).find(|k| k.ends_with(&c2)).unwrap();
    let mut f = game.summary(vec![by_house(2, &c2, &hash2, &[&ck2, &rk2])], 3, Some(game.commit(3)));
    f.kept = Some(100 * 1024);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts().trims, 1);
    let cks = game.cks();
    assert_eq!(cks.len(), 1, "the opening ({root_key}) and its first trim gone");
    assert_eq!(cks[0].1.get("u").and_then(CVal::as_int), Some(2));
    let next = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, &cks[0].1).unwrap());
    assert_eq!(game.sessions(), vec![next], "the opening's session ({root_ses}) is gone too");
}

// ── #468 round 1 ─────────────────────────────────────────────────────────────────────────────────────────────────

#[cfg(feature = "house-fold")]
#[test]
fn an_answer_made_before_a_players_key_came_is_not_trimmed_from_and_one_made_after_is() {
    let mut game = Game::opened("trim-pins", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f.clone());
    // A player's key comes after the fold was given the keys: a felt of theirs may count that the answer left out.
    {
        let mut txn = game.doc.transact_mut();
        let players = txn.get_or_insert_map("players");
        players.insert(&mut txn, "dave", to_any(&obj(vec![("keyB64", s(&who("dave").public))])));
    }
    game.tick(HOUSE_TRIM_AFTER_MS);
    game.tick(200);
    assert!(game.untrimmed(), "the answer was made before the key came");
    assert_eq!(game.house.game_counts(), GameCounts::default());
    // An answer made with it.
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[cfg(feature = "house-fold")]
#[test]
fn an_answer_with_no_watch_of_the_players_keys_is_not_trimmed_from() {
    let mut game = Game::opened("trim-pins-none", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f.clone());
    let at = (ROOM.to_string(), T.to_string(), game.ctx.inc.clone());
    game.answers.lock().unwrap().get_mut(&at).unwrap().pins = None;
    game.tick(HOUSE_TRIM_AFTER_MS);
    game.tick(200);
    assert!(game.untrimmed(), "nothing says the keys are the room's");
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[cfg(feature = "house-fold")]
#[test]
fn an_answer_whose_watch_of_the_players_keys_was_let_go_is_not_trimmed_from() {
    let mut game = Game::opened("trim-pins-gone", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let f = game.pressed_answer(&c, &ck, &rk, &hash);
    game.answer(f.clone());
    // The watch the answer was made by is let go (the shadow stopped following the room): it no longer sees a key come.
    game.pins = crate::fold_pins::PlayerPins::attach(&game.doc, crate::fold_pins::PIN_WALK_KEYS);
    game.tick(HOUSE_TRIM_AFTER_MS);
    game.tick(200);
    assert!(game.untrimmed());
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1);
}

#[test]
fn a_session_past_the_keys_the_house_reads_is_not_trimmed_from() {
    for (extra, trims) in [(0usize, 1u64), (1, 0)] {
        let mut game = Game::opened(&format!("trim-keys-{extra}"), "landlord");
        let (c, ck, rk, hash) = game.revealed_round_one();
        let f = game.pressed_answer(&c, &ck, &rk, &hash);
        game.answer(f);
        // Keys of nothing up to the keys the house reads of a session (and one more): the answer's records are the same.
        let held = game.records("").len();
        {
            let comp = game.doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = game.doc.transact_mut();
            let Some(Out::YMap(m)) = comp.get(&txn, &game.ses) else { panic!("no session") };
            for i in 0..MAX_SESSION_KEYS - held + extra {
                m.insert(&mut txn, format!("n{i}"), Any::Number(0.0));
            }
        }
        assert_eq!(game.records("").len(), MAX_SESSION_KEYS + extra);
        game.tick(HOUSE_TRIM_AFTER_MS);
        game.tick(200);
        assert_eq!(game.house.game_counts().trims, trims, "{extra} past the keys it reads");
    }
}

#[test]
fn a_tick_that_checks_no_answer_forgets_what_the_trim_waited_for_whatever_kept_it_from_one() {
    let mut game = Game::opened("trim-wait-held", "landlord");
    let (c, ck, rk, hash) = game.revealed_round_one();
    let mut f = game.pressed_answer(&c, &ck, &rk, &hash);
    f.rounds[0].missing = Some(vec!["bob".into()]);
    game.answer(f.clone());
    game.tick(HOUSE_TRIM_AFTER_MS);
    game.tick(MISSING_WAIT_MS - HOUSE_TRIM_AFTER_MS - 1);
    assert!(game.untrimmed(), "waiting");
    // A tick the game is held in (a record under its keys no reader can tell), its answer as it was: no answer checked.
    let unreadable = game.unreadable();
    game.tick(1);
    game.delete_top(&unreadable);
    // The slip could have come back and gone again meanwhile: the wait begins again.
    game.tick(1);
    game.tick(200);
    assert!(game.untrimmed(), "waiting afresh");
    game.tick(MISSING_WAIT_MS - 400);
    assert!(game.untrimmed(), "waiting afresh still");
    game.tick(200);
    assert_eq!(game.house.game_counts().trims, 1, "nobody put it back");
}

#[test]
fn a_file_is_put_in_place_in_its_directory_or_the_one_it_runs_in() {
    assert_eq!(dir_of(std::path::Path::new("house-checkpoints.json")), std::path::Path::new("."));
    assert_eq!(dir_of(std::path::Path::new("/a/b/house-checkpoints.json")), std::path::Path::new("/a/b"));
    let dir = scratch("put-in-place");
    let (tmp, path) = (dir.join("rows.json.tmp"), dir.join("rows.json"));
    std::fs::write(&tmp, b"new").unwrap();
    std::fs::write(&path, b"old").unwrap();
    put_in_place(&tmp, &path).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"new");
    assert!(!tmp.exists());
}

// ── The sweep (design-final section 8.5 N3s; computedSimHouseGame.test.ts "the sweep") ──────────────────────────────

impl Game {
    /// 🔒 Each key of the live session weighed as the fold weighs it (computedFold `weigh`): the key and its value's
    /// canonical form, in UTF-16 code units.
    fn weights(&self) -> BTreeMap<String, i64> {
        let txn = self.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(m)) = comp.get(&txn, &self.ses) else { return BTreeMap::new() };
        m.iter(&txn)
            .map(|(k, v)| {
                let c = match v {
                    Out::Any(a) => hb::canon(&CVal::from_any(&a)).map_or(64, |c| c.encode_utf16().count()),
                    _ => 64,
                };
                (k.to_string(), (k.encode_utf16().count() + c) as i64)
            })
            .collect()
    }

    /// What `keys` of the live session weigh together.
    fn weight_of(&self, keys: &[String]) -> i64 {
        let w = self.weights();
        keys.iter().map(|k| w[k]).sum()
    }

    /// Junk in the live session under keys of no record (`junk-…`, a kilobyte of `x` each): at least `bytes` of it.
    fn junk(&self, bytes: i64) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &self.ses) else { panic!("no session {}", self.ses) };
        let mut i = m.keys(&txn).filter(|k| k.starts_with("junk-")).count();
        let mut added = 0;
        while added < bytes {
            let key = format!("junk-{i}");
            added += (key.len() + 1_002) as i64;
            m.insert(&mut txn, key, Any::String("x".repeat(1_000).into()));
            i += 1;
        }
    }

    /// `n` keys of nothing (0) in the live session, `tag` before each one's number.
    fn nothings(&self, n: usize, tag: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &self.ses) else { panic!("no session {}", self.ses) };
        for i in 0..n {
            m.insert(&mut txn, format!("{tag}{i}"), Any::Number(0.0));
        }
    }

    /// The fold's answer of the live session with no round decided past the base, the open round `open` asking for
    /// `required`, as the fold weighs the session now: it keeps the open round's felts `felts` and the houses' joins
    /// `joins` (their keys), and nothing else.
    fn unswept(&self, open: i64, required: Option<String>, felts: &[String], joins: &[String]) -> FoldSummary {
        let mut f = self.summary(vec![], open, required);
        f.raw_bytes = self.weights().values().sum();
        f.kept = Some(self.weight_of(&felts.iter().chain(joins).cloned().collect::<Vec<_>>()));
        f.felts = Some(felts.len() as i64);
        f.carry_felts = Some(sorted(felts.to_vec()));
        f.joins = joins.iter().map(|k| k.rsplit(':').next().unwrap().to_string()).collect();
        f
    }

    /// The live session's keys.
    fn session_keys(&self) -> Vec<String> {
        self.weights().into_keys().collect()
    }

    /// The game's one checkpoint in the doc, laid as its base with the session it opens.
    fn follow(&mut self) -> (String, CVal) {
        let cks = self.cks();
        assert_eq!(cks.len(), 1, "one checkpoint: {cks:?}");
        let (key, v) = cks[0].clone();
        self.base = v.clone();
        self.ses = format!("ses:{T}:{}:{}", self.ctx.inc, hb::next_sid3(&self.ctx, &v).unwrap());
        (key, v)
    }
}

/// A game with nothing decided: the house's join of round 1 in, and alice's felt of round 1: (the felt's key, the
/// join's key).
fn fresh(name: &str) -> (Game, String, String) {
    let mut game = Game::opened(name, "landlord");
    game.tick(0);
    let joins = game.records("o:1:");
    assert_eq!(joins.len(), 1, "the house joined round 1");
    let felt = game.slip(&who("alice"), 1);
    (game, format!("s:1:alice:{felt}"), joins[0].0.clone())
}

/// Round 1 played, revealed by the house and trimmed to by it, carrying its reveal and the two seeds it counted, and
/// nothing decided since: the trim's key, round 1's close, and what the trim carried (its reveal, alice's seed, bob's).
fn trimmed(name: &str) -> (Game, String, String, Vec<String>) {
    let mut game = Game::opened(name, "landlord");
    let (c, _, rk, hash) = game.revealed_round_one();
    let (xa, xb) = (game.records("x:1:alice:")[0].0.clone(), game.records("x:1:bob:")[0].0.clone());
    let mut f = game.summary(vec![by_house(1, &c, &hash, &[&rk, &xa, &xb])], 2, Some(game.commit(2)));
    f.kept = Some(100 * 1024);
    f.raw_bytes = 100 * 1024;
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts().trims, 1);
    let (key, v) = game.follow();
    assert_eq!(v.get("u").and_then(CVal::as_int), Some(1));
    game.no_answer();
    game.ticks();
    let carried = sorted(vec![rk, xa, xb]);
    assert_eq!(game.session_keys(), carried, "the trim carried round 1's decider and seeds, and nothing joins round 2");
    (game, key, c, carried)
}

#[test]
fn the_sweeps_numbers_are_the_pages_twins() {
    assert_eq!((HOUSE_SWEEP_BYTES, HOUSE_SWEEP_KEYS, HOUSE_SWEEP_MIN_MS), (48 * 1024, 2_048, 10_000));
}

#[test]
fn junk_in_a_session_with_nothing_decided_is_swept_by_the_bases_content_signed_again_one_sweep_on() {
    let (mut game, felt, join) = fresh("sweep-fresh");
    let (root_key, root) = (game.ck_key(&game.base), game.base.clone());
    let old_ses = game.ses.clone();
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(1, Some(game.commit(1)), &[felt.clone()], &[join.clone()]);
    assert!(f.raw_bytes - f.kept.unwrap() >= HOUSE_SWEEP_BYTES);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 0, sweeps: 1, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 });
    let cks = game.cks();
    assert_eq!(cks.len(), 1, "the root ({root_key}) is gone: {cks:?}");
    let (key, v) = &cks[0];
    let me = game.house.public().to_string();
    // The root's content, the session it closes, one sweep on, this house's under its delegation.
    for k in ["v", "ok", "j", "rv", "ts", "u", "l", "n"] {
        assert_eq!(canon_of(v.get(k).cloned()), canon_of(root.get(k).cloned()), "{k} is the root's");
    }
    assert_eq!(str_of(v, "b"), Some(old_ses.rsplit(':').next().unwrap()));
    assert_eq!(v.get("w").and_then(CVal::as_int), Some(1));
    assert_eq!(v.get("dl").and_then(hb::canon), hb::canon(&delegation(&game.owner, &me)));
    assert_eq!(str_of(v, "k"), Some(me.as_str()));
    let CVal::Obj(fields) = v else { panic!("no record") };
    assert_eq!(sorted(fields.iter().map(|(k, _)| k.clone()).collect()), ["b", "dl", "g", "j", "k", "l", "n", "ok", "rv", "ts", "u", "v", "w"].map(String::from).to_vec());
    assert!(hb::verify(&me, &hb::sign_bytes("ck", &game.ctx, &with_out(v, "g")).unwrap(), str_of(v, "g").unwrap()));
    // The pages count from it; its session, not the junked one, holds the open felt and the join, and no junk.
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
    let next = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, v).unwrap());
    assert_ne!(next, old_ses);
    assert_eq!(game.sessions(), vec![next.clone()]);
    game.follow();
    assert_eq!(game.session_keys(), sorted(vec![felt.clone(), join.clone()]));
    let rows = rows_on_disk(&game.dir);
    assert_eq!(rows.get(&(ROOM.to_string(), T.to_string(), game.ctx.inc.clone())), Some(&(key.clone(), hb::canon(v).unwrap())));
    // Round 1 plays on from it, on the join it carried: no second join, and the house reveals the close made on it.
    game.no_answer();
    game.ticks();
    assert_eq!(game.records("o:1:").into_iter().map(|(k, _)| k).collect::<Vec<_>>(), vec![join]);
    let (c, _, _) = game.closed(1, &game.sid(), &game.commit(1));
    game.seeds(1);
    game.ticks();
    let reveals = game.records("h:1:");
    assert_eq!(reveals.len(), 1, "the house revealed round 1");
    assert_eq!(canon_of(reveals[0].1.get("x").cloned()), hb::canon(&CVal::Arr(vec![s(&c)])));
    assert_eq!(game.house.game_counts().sweeps, 1);
}

#[test]
fn a_sweep_the_doc_lost_whole_goes_back_with_what_it_carried_and_none_of_the_junk() {
    let (mut game, felt, join) = fresh("sweep-lost-whole");
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(1, Some(game.commit(1)), &[felt.clone()], &[join.clone()]);
    game.answer(f);
    let saved = game.saved();
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
    let (key, v) = game.cks().into_iter().next().unwrap();
    let next = format!("ses:{T}:{}:{}", game.ctx.inc, hb::next_sid3(&game.ctx, &v).unwrap());
    // The node stopped before it saved the room, and no page had the sweep.
    game.stopped_before_it_saved(&saved);
    game.tick(REPUT_MS);
    game.tick(REPUT_MS);
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v), "its checkpoint back");
    assert_eq!(game.house.game_counts().row_put_backs, 1);
    assert_eq!(game.records_in(&next).into_iter().map(|(k, _)| k).collect::<Vec<_>>(), sorted(vec![felt, join]), "the felt and the join, and no junk");
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[test]
fn after_a_trim_a_sweep_signs_the_checkpoint_again_and_carries_round_us_decider_and_seeds_on() {
    let (mut game, key, _, carried) = trimmed("sweep-trimmed");
    let trim = game.base.clone();
    let trim_ses = game.sid();
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 1, sweeps: 1, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 });
    let (swept, v) = game.follow();
    assert_ne!(swept, key);
    // The checkpoint's content (its nets, its outcome, the commitment it carried), on the session it closes, one sweep on.
    let CVal::Obj(fields) = &trim else { panic!("no record") };
    for (k, was) in fields.iter().filter(|(k, _)| !matches!(k.as_str(), "g" | "b")) {
        assert_eq!(canon_of(v.get(k).cloned()), hb::canon(was), "{k} is the trim's");
    }
    assert_eq!(str_of(&v, "b"), Some(trim_ses.as_str()));
    assert_eq!(v.get("w").and_then(CVal::as_int), Some(1));
    let CVal::Obj(swept_fields) = &v else { panic!("no record") };
    assert_eq!(sorted(swept_fields.iter().map(|(k, _)| k.clone()).collect()), sorted(fields.iter().map(|(k, _)| k.clone()).chain(["w".to_string()]).collect()));
    assert_eq!(game.resolved_base().as_deref(), Some(swept.as_str()));
    assert_eq!(game.session_keys(), carried);
    // …and a second sweep carries them on again, two sweeps on.
    game.ticks();
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    game.answer(f);
    game.tick(HOUSE_SWEEP_MIN_MS);
    assert_eq!(game.house.game_counts().sweeps, 2);
    let (_, v) = game.follow();
    assert_eq!((v.get("u").and_then(CVal::as_int), v.get("w").and_then(CVal::as_int)), (Some(1), Some(2)));
    assert_eq!(str_of(&v, "h"), Some(game.commit(2).as_str()));
    assert_eq!(game.session_keys(), carried);
    // Round 2 plays on it: the house reveals the close made on the commitment it carried.
    game.no_answer();
    game.ticks();
    let (c2, _, _) = game.closed(2, &game.sid(), &game.commit(2));
    game.seeds(2);
    game.ticks();
    let reveals = game.records("h:2:");
    assert_eq!(reveals.len(), 1, "the house revealed round 2");
    assert_eq!(canon_of(reveals[0].1.get("x").cloned()), hb::canon(&CVal::Arr(vec![s(&c2)])));
}

#[test]
fn junk_a_peer_wrote_over_a_carried_seed_is_not_carried() {
    let (mut game, _, _, carried) = trimmed("sweep-overwritten");
    let seed = carried.iter().find(|k| k.starts_with("x:1:bob:")).unwrap().clone();
    game.put_in_session(&seed, Any::String("x".repeat(HOUSE_SWEEP_BYTES as usize).into()));
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
    game.follow();
    assert_eq!(game.session_keys(), carried.into_iter().filter(|k| *k != seed).collect::<Vec<_>>());
    // (And nothing junk is left to press another.)
    game.ticks();
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    game.answer(f);
    game.tick(HOUSE_SWEEP_MIN_MS + 2_400);
    assert_eq!(game.house.game_counts().sweeps, 1);
}

#[test]
fn what_is_carried_is_no_junk_by_its_weight() {
    let (mut game, _, _, carried) = trimmed("sweep-carried-weight");
    let weight = game.weight_of(&carried);
    assert!(weight > 500, "round 1's decider and seeds weigh {weight}");
    // Junk a byte short of HOUSE_SWEEP_BYTES besides round 1's records (a key of 4 and a string's quotes): the session
    // past what the fold keeps weighs more.
    game.put_in_session("fill", Any::String("x".repeat(HOUSE_SWEEP_BYTES as usize - 1 - 6).into()));
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    assert_eq!(f.raw_bytes - f.kept.unwrap(), HOUSE_SWEEP_BYTES - 1 + weight);
    game.answer(f);
    game.tick(HOUSE_SWEEP_MIN_MS + 2_400);
    assert_eq!(game.house.game_counts().sweeps, 0);
    // A byte more is swept.
    game.put_in_session("fill", Any::String("x".repeat(HOUSE_SWEEP_BYTES as usize - 6).into()));
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    assert_eq!(f.raw_bytes - f.kept.unwrap(), HOUSE_SWEEP_BYTES + weight);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
}

#[test]
fn a_carried_seed_written_over_is_one_junk_key_more() {
    let (mut game, _, _, carried) = trimmed("sweep-carried-keys");
    let seed = carried.iter().find(|k| k.starts_with("x:1:bob:")).unwrap().clone();
    game.put_in_session(&seed, Any::Number(0.0));
    game.nothings(HOUSE_SWEEP_KEYS as usize - 2, "a");
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    assert!(f.raw_bytes - f.kept.unwrap() < HOUSE_SWEEP_BYTES);
    game.answer(f);
    game.tick(200);
    game.tick(2_400);
    assert_eq!(game.house.game_counts().sweeps, 0, "one junk key short");
    game.nothings(1, "b");
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
    game.follow();
    assert_eq!(game.session_keys(), carried.into_iter().filter(|k| *k != seed).collect::<Vec<_>>());
}

#[test]
fn a_house_that_restarted_since_the_trim_carries_the_decider_on_and_not_what_else_lies_under_round_u() {
    let (mut game, _, _, carried) = trimmed("sweep-restarted");
    game.restart(SETTLE_MS);
    game.house.read_answers_from(game.answers.clone());
    game.junk(HOUSE_SWEEP_BYTES);
    let start = game.now;
    while game.house.game_counts().sweeps == 0 {
        assert!(game.now - start < SETTLE_MS + 5_000, "never swept");
        game.tick(200);
        if game.house.fold_plan(ROOM).is_some_and(|p| !p.games.is_empty()) {
            let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
            game.answer(f);
        }
    }
    game.follow();
    let decider: Vec<String> = carried.into_iter().filter(|k| k.starts_with("h:1:")).collect();
    assert_eq!(decider.len(), 1);
    assert_eq!(game.session_keys(), decider);
}

#[test]
fn at_most_one_sweep_per_house_sweep_min_ms() {
    let (mut game, felt, join) = fresh("sweep-often");
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(1, Some(game.commit(1)), &[felt.clone()], &[join.clone()]);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
    let at = game.now;
    game.follow();
    game.ticks();
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(1, Some(game.commit(1)), &[felt.clone()], &[join.clone()]);
    game.answer(f);
    while game.now - at < HOUSE_SWEEP_MIN_MS - 200 {
        game.tick(200);
    }
    assert_eq!(game.house.game_counts().sweeps, 1, "junk again at once waits");
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 2);
    let (key, v) = game.follow();
    assert_eq!((v.get("u").and_then(CVal::as_int), v.get("w").and_then(CVal::as_int)), (Some(0), Some(2)));
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[test]
fn junk_just_short_of_house_sweep_bytes_is_left_however_long_and_an_idle_session_with_nothing_decided_is_not_swept() {
    let (mut game, felt, join) = fresh("sweep-short");
    let f = game.unswept(1, Some(game.commit(1)), &[felt.clone()], &[join.clone()]);
    game.put_in_session("fill", Any::String("x".repeat((HOUSE_SWEEP_BYTES - (f.raw_bytes - f.kept.unwrap()) - 3_000) as usize).into()));
    let f = game.unswept(1, Some(game.commit(1)), &[felt.clone()], &[join.clone()]);
    assert!(f.raw_bytes - f.kept.unwrap() < HOUSE_SWEEP_BYTES);
    game.answer(f);
    let start = game.now;
    while game.now - start < HOUSE_IDLE_MS + 5_000 {
        game.tick(1_000);
    }
    assert_eq!(game.house.game_counts(), GameCounts::default());
    game.junk(4_000);
    let f = game.unswept(1, Some(game.commit(1)), &[felt], &[join]);
    assert!(f.raw_bytes - f.kept.unwrap() >= HOUSE_SWEEP_BYTES);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
}

#[test]
fn keys_of_nothing_are_swept_at_house_sweep_keys_though_they_weigh_little() {
    let (mut game, felt, join) = fresh("sweep-keys");
    game.nothings(HOUSE_SWEEP_KEYS as usize - 1, "a");
    let f = game.unswept(1, Some(game.commit(1)), &[felt.clone()], &[join.clone()]);
    assert!(f.raw_bytes - f.kept.unwrap() < HOUSE_SWEEP_BYTES);
    game.answer(f);
    game.tick(200);
    game.tick(2_400);
    assert_eq!(game.house.game_counts().sweeps, 0, "one short");
    game.nothings(1, "b");
    let f = game.unswept(1, Some(game.commit(1)), &[felt.clone()], &[join.clone()]);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
    game.follow();
    assert_eq!(game.session_keys(), sorted(vec![felt, join]));
}

#[test]
fn no_sweep_while_a_close_of_the_open_round_is_in_and_once_it_is_decided_the_trim_sweeps() {
    let mut game = Game::opened("sweep-close", "landlord");
    let (c, _, _) = game.closed_on_the_join();
    game.junk(HOUSE_SWEEP_BYTES);
    let mut f = game.unswept(1, Some(game.commit(1)), &[], &[]);
    f.rounds = vec![round(1, &c)];
    f.tip = Some(1);
    game.answer(f);
    game.tick(200);
    game.tick(2_800);
    assert_eq!(game.house.game_counts(), GameCounts::default());
    game.seeds(1);
    game.ticks();
    let (rk, _) = game.records("h:1:").into_iter().next().expect("the house revealed round 1");
    let hash = rk.rsplit(':').next().unwrap().to_string();
    let mut f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    f.rounds = vec![by_house(1, &c, &hash, &[&rk])];
    game.answer(f);
    game.tick(200);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 1, sweeps: 0, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 });
    let (_, v) = game.follow();
    assert_eq!((v.get("u").and_then(CVal::as_int), str_of(&v, "l")), (Some(1), Some(c.as_str())));
    assert!(v.get("w").is_none());
}

#[test]
fn a_frozen_slip_its_reveal_counted_deleted_holds_the_sweep_for_the_wait_and_back_the_round_is_trimmed_to() {
    let mut game = Game::opened("sweep-deleted-slip", "landlord");
    let (c, _, rk, hash) = game.revealed_round_one();
    let root = game.ck_key(&game.base);
    let alice = game.records("s:1:alice:")[0].clone();
    game.delete_in_session(&alice.0);
    game.junk(HOUSE_SWEEP_BYTES);
    // (Off the chain: no round decided, no close in.)
    let f = game.unswept(1, Some(game.commit(1)), &[], &[]);
    game.answer(f);
    let start = game.now;
    while game.now - start < 28_000 {
        game.tick(1_000);
    }
    assert_eq!(game.house.game_counts(), GameCounts::default(), "a sweep would void the round for good");
    assert_eq!(game.cks().into_iter().map(|(k, _)| k).collect::<Vec<_>>(), vec![root]);
    // A witness puts it back: the round is decided again, and the junk presses its trim.
    game.put_in_session(&alice.0, to_any(&alice.1));
    let mut f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    f.rounds = vec![by_house(1, &c, &hash, &[&rk])];
    game.answer(f);
    game.tick(200);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 1, sweeps: 0, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 });
    let (_, v) = game.follow();
    assert_eq!((v.get("u").and_then(CVal::as_int), str_of(&v, "l"), str_of(&v, "d")), (Some(1), Some(c.as_str()), Some(format!("h:{hash}").as_str())));
}

#[test]
fn a_frozen_slip_nobody_puts_back_for_the_wait_leaves_the_junked_session_to_be_swept() {
    let mut game = Game::opened("sweep-deleted-for-good", "landlord");
    game.revealed_round_one();
    let alice = game.records("s:1:alice:")[0].0.clone();
    game.delete_in_session(&alice);
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(1, Some(game.commit(1)), &[], &[]);
    game.answer(f);
    let start = game.now;
    while game.now - start < 29_000 {
        game.tick(1_000);
    }
    assert_eq!(game.house.game_counts().sweeps, 0);
    while game.now - start < 32_000 {
        game.tick(1_000);
    }
    assert_eq!(game.house.game_counts().sweeps, 1);
    let (_, v) = game.follow();
    assert_eq!((v.get("u").and_then(CVal::as_int), v.get("w").and_then(CVal::as_int)), (Some(0), Some(1)));
}

#[test]
fn no_sweep_of_a_base_under_the_round_the_holder_it_serves_holds_the_game_from() {
    let (mut game, felt, join) = fresh("sweep-from");
    // Handed to the buyer from round 1, who delegates this house: the root is the seller's.
    let buyer = who("buyer");
    game.transfer(&buyer, 1);
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&buyer, game.house.public()));
    game.ticks();
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(1, Some(game.commit(1)), &[felt], &[join]);
    game.answer(f);
    game.tick(200);
    game.tick(2_400);
    assert!(game.untrimmed());
    assert_eq!(game.house.game_counts(), GameCounts::default(), "and no checkpoint is made to be refused");
}

#[test]
fn a_sweep_it_cannot_note_on_disk_is_not_written() {
    let (mut game, felt, join) = fresh("sweep-disk");
    std::fs::create_dir_all(game.dir.join(ROWS_FILE)).unwrap();
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(1, Some(game.commit(1)), &[felt], &[join]);
    game.answer(f);
    game.tick(200);
    assert!(game.untrimmed());
    assert_eq!(game.house.game_counts(), GameCounts::default());
    // (Nor is the time it did not sweep counted against the next.)
    std::fs::remove_dir_all(game.dir.join(ROWS_FILE)).unwrap();
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
}

#[test]
fn the_cross_check_refuses_a_sweep_that_does_not_hold_what_its_base_holds() {
    type Fault = Box<dyn FnMut(&mut Vec<(String, CVal)>) + Send>;
    let set = |k: &'static str, v: CVal| -> Fault {
        Box::new(move |b: &mut Vec<(String, CVal)>| {
            b.retain(|(f, _)| f != k);
            b.push((k.to_string(), v.clone()));
        })
    };
    let me = Game::opened("sweep-cross-key", "landlord").house.public().to_string();
    let faults: Vec<(&str, Fault)> = vec![
        ("b", set("b", s(&"f".repeat(24)))),
        ("w", set("w", CVal::Int(2))),
        ("w gone", Box::new(|b: &mut Vec<(String, CVal)>| b.retain(|(f, _)| f != "w"))),
        ("n", set("n", obj(vec![("alice", s("1000"))]))),
        ("o", set("o", CVal::Int(5))),
        ("h", set("h", s(&"e".repeat(64)))),
        ("u", set("u", CVal::Int(2))),
        ("k", set("k", s(&who("buyer").public))),
        ("dl", set("dl", delegation(&who("buyer"), &me))),
        ("x", set("x", CVal::Arr(vec![s("xf")]))),
        ("e", set("e", CVal::Int(1))),
    ];
    for (name, fault) in faults {
        let (mut game, key, _, _) = trimmed(&format!("sweep-cross-{}", name.replace(' ', "-")));
        game.house.fault_trim = Some(fault);
        game.junk(HOUSE_SWEEP_BYTES);
        let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
        game.answer(f);
        game.tick(200);
        game.tick(2_400);
        let counts = game.house.game_counts();
        assert_eq!(counts.sweeps, 0, "{name}");
        assert!(counts.cross_check_mismatches >= 1, "{name}");
        assert_eq!(game.cks().into_iter().map(|(k, _)| k).collect::<Vec<_>>(), vec![key.clone()], "{name}");
        assert_eq!(rows_on_disk(&game.dir).values().map(|(k, _)| k.clone()).collect::<Vec<_>>(), vec![key.clone()], "{name}: the trim's row");
        game.house.fault_trim = None;
        game.tick(200);
        assert_eq!(game.house.game_counts().sweeps, 1, "{name}: then swept");
    }
}

#[test]
fn a_sweep_at_the_round_of_a_hand_over_is_the_new_holders_and_carries_the_transfer() {
    let (mut game, felt, join) = fresh("sweep-at-xf");
    let buyer = who("buyer");
    let xf = game.transfer(&buyer, 0);
    let me = game.house.public().to_string();
    game.put_top(&format!("hk:{me}"), &delegation(&buyer, &me));
    game.ticks();
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(1, Some(game.commit(1)), &[felt], &[join]);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 0, sweeps: 1, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 });
    let (key, v) = game.follow();
    assert_eq!(v.get("dl").and_then(hb::canon), hb::canon(&delegation(&buyer, &me)), "by the delegation it serves the buyer by");
    assert_eq!(v.get("x").map(|x| x.as_arr().unwrap().iter().filter_map(hb::canon).collect::<Vec<_>>()), Some(vec![hb::canon(&xf).unwrap()]), "the chain's transfer");
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[cfg(feature = "house-fold")]
#[test]
fn the_house_sweeps_a_game_from_the_bundled_folds_own_answer_and_the_fold_reads_the_game_as_before() {
    for letter in ['p', 'q'] {
        let mut game = Game::opened_as(&format!("sweep-folded-{letter}"), "landlord", letter);
        game.tick(0);
        game.slip(&who("alice"), 1);
        game.ticks();
        let clean = game.folded();
        assert!(!clean.pending, "{letter}");
        assert_eq!((clean.felts, clean.joins.len()), (Some(1), 1), "{letter}: alice's felt and the house's join");
        game.junk(HOUSE_SWEEP_BYTES);
        let f = game.folded();
        assert_eq!(f.raw_bytes - f.kept.unwrap(), clean.raw_bytes - clean.kept.unwrap() + game.weight_of(&game.session_keys().into_iter().filter(|k| k.starts_with("junk-")).collect::<Vec<_>>()), "{letter}: the junk weighs as the fold weighs it");
        game.answer(f);
        game.tick(200);
        assert_eq!(game.house.game_counts(), GameCounts { trims: 0, sweeps: 1, ends: 0, cross_check_mismatches: 0, row_put_backs: 0 }, "{letter}");
        let (key, _) = game.follow();
        assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()), "{letter}");
        game.ticks();
        let after = game.folded();
        assert!(!after.pending, "{letter}");
        assert_eq!(after.raw_bytes - after.kept.unwrap(), 0, "{letter}: no junk left");
        assert_eq!((&after.nets, after.open, &after.required, &after.carry, &after.joins, after.felts), (&clean.nets, clean.open, &clean.required, &clean.carry, &clean.joins, clean.felts), "{letter}");
    }
}

#[cfg(feature = "house-fold")]
#[test]
fn what_a_sweep_carries_weighs_as_the_bundled_fold_weighs_it() {
    let (mut game, _, _, carried) = trimmed("sweep-folded-carried");
    let clean = game.folded();
    assert!(!clean.pending);
    let weight = game.weight_of(&carried);
    assert_eq!(clean.raw_bytes - clean.kept.unwrap(), weight, "the fold keeps none of round 1's records, and weighs them as the house does");
    game.put_in_session("fill", Any::String("x".repeat(HOUSE_SWEEP_BYTES as usize - 100 - 6).into()));
    let f = game.folded();
    assert!(f.raw_bytes - f.kept.unwrap() >= HOUSE_SWEEP_BYTES);
    game.answer(f);
    game.tick(HOUSE_SWEEP_MIN_MS);
    assert_eq!(game.house.game_counts().sweeps, 0);
    game.put_in_session("more", Any::String("x".repeat(200).into()));
    let f = game.folded();
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
    game.follow();
    assert_eq!(game.session_keys(), carried);
}

#[test]
fn what_a_trim_or_a_sweep_carries_is_none_where_the_ticks_reads_run_out_on_it_never_less() {
    // 🔒 Each record a trim or a sweep carries is read at its cost. Where the tick's reads run out on one, it carries
    // none this pass (it waits for the next), never those read before it: a checkpoint signed with less would leave a
    // felt or a join behind in the session it closes.
    let mut game = Game::opened("copies-spent", "landlord");
    let (carol, dave, join) = (format!("s:2:carol:{}", "ab".repeat(16)), format!("s:2:dave:{}", "cd".repeat(16)), "ef".repeat(16));
    let joined = format!("o:2:{join}");
    for k in [&carol, &dave, &joined] {
        game.put_in_session(k, to_any(&obj(vec![("r", CVal::Int(2))])));
    }
    let mut f = game.summary(vec![], 2, None);
    f.carry_felts = Some(vec![carol.clone(), dave.clone()]);
    f.joins = vec![join];
    let txn = game.doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let Some(Out::YMap(ses)) = comp.get(&txn, &game.ses) else { panic!("the session") };
    let keys = |c: Vec<(String, CVal)>| c.into_iter().map(|(k, _)| k).collect::<Vec<_>>();
    // The reads last: all three, each once.
    game.house.read_left = usize::MAX;
    let all = game.house.copies_of(&txn, &ses, &f, std::slice::from_ref(&carol));
    assert_eq!(all.map(keys), Some(vec![carol.clone(), dave.clone(), joined]));
    // (What carol's felt costs a tick's reads.)
    let mut first = f.clone();
    first.carry_felts = Some(vec![carol.clone()]);
    first.joins = vec![];
    (game.house.read_left, game.house.read_out) = (1 << 20, false);
    assert_eq!(game.house.copies_of(&txn, &ses, &first, &[]).map(keys), Some(vec![carol.clone()]));
    let cost = (1 << 20) - game.house.read_left;
    // Reads for carol's felt and not dave's: none.
    (game.house.read_left, game.house.read_out) = (cost, false);
    assert_eq!(game.house.copies_of(&txn, &ses, &f, &[]), None, "the next pass");
    assert!(game.house.read_out);
}

#[test]
fn what_a_sweep_carries_of_round_u_is_none_where_the_ticks_reads_run_out_on_it_never_less() {
    // 🔒 The same of round u's records, which a sweep reads before it signs: where the tick's reads run out on one, the
    // sweep waits for the next pass. With less, it would sign without the decider and count the record left as junk.
    let (mut game, _, _, carried) = trimmed("sweep-carried-spent");
    let weight = game.weight_of(&carried);
    let txn = game.doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let Some(Out::YMap(ses)) = comp.get(&txn, &game.ses) else { panic!("the session") };
    // The reads last: each record, and what they weigh as the fold weighs them.
    game.house.read_left = usize::MAX;
    assert_eq!(game.house.carried_in(&txn, &ses, carried.clone()), Some((carried.clone(), weight)));
    // (What the first costs a tick's reads.)
    (game.house.read_left, game.house.read_out) = (1 << 20, false);
    assert_eq!(game.house.carried_in(&txn, &ses, carried[..1].to_vec()).map(|(c, _)| c), Some(carried[..1].to_vec()));
    let cost = (1 << 20) - game.house.read_left;
    // Reads for the first and not the rest: none.
    (game.house.read_left, game.house.read_out) = (cost, false);
    assert_eq!(game.house.carried_in(&txn, &ses, carried.clone()), None, "the next pass");
    assert!(game.house.read_out);
}

#[test]
fn a_sweep_carries_what_the_last_trim_noted_only_on_the_base_it_noted_it_for() {
    // 🔒 What the last trim or sweep carried is noted with the checkpoint it signed. Under any other base (one another
    // house signed since, or one put back), a sweep goes by that base: the decider it names, alone.
    let (mut game, key, _, carried) = trimmed("sweep-other-base");
    let at = (T.to_string(), game.ctx.inc.clone());
    let mem = game.house.rooms.get_mut(ROOM).unwrap().tables.get_mut(&at).unwrap();
    let noted = mem.carried.clone().map(|(k, keys)| (k, sorted(keys)));
    assert_eq!(noted, Some((key.clone(), carried.clone())), "noted with the trim's checkpoint");
    mem.carried = Some((format!("{key}0"), carried.clone()));
    game.junk(HOUSE_SWEEP_BYTES);
    let f = game.unswept(2, Some(game.commit(2)), &[], &[]);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().sweeps, 1);
    game.follow();
    let decider: Vec<String> = carried.into_iter().filter(|k| k.starts_with("h:1:")).collect();
    assert_eq!(decider.len(), 1);
    assert_eq!(game.session_keys(), decider);
}

// ── The end (design-final section 8.5 N6; computedSimHouseGame.test.ts "the end (N6)") ──────────────────────────────

impl Game {
    /// Round 1 joined, closed on the join and revealed by the house under the owner's end order, so with no next
    /// commitment: (close, its key, the reveal's key, its hash).
    fn last_round(&mut self) -> (String, String, String, String) {
        let (c, _, _) = self.closed_on_the_join();
        self.fin(&who("owner"));
        self.seeds(1);
        self.ticks();
        let (rk, h) = self.records("h:1:").into_iter().next().expect("the house revealed round 1");
        assert!(h.get("c").is_none(), "no commitment for a round that will not be");
        let hash = rk.rsplit(':').next().unwrap().to_string();
        let ck = self.records("c:1:").into_iter().map(|(k, _)| k).find(|k| k.ends_with(&c)).unwrap();
        (c, ck, rk, hash)
    }

    /// The fold's answer of a game ending after round 1, decided by the house's reveal of hash `hash`: nothing asked of
    /// round 2, and no close of it in.
    fn ending(&self, c: &str, hash: &str) -> FoldSummary {
        self.summary(vec![by_house(1, c, hash, &[])], 2, None)
    }

    /// The owner's end order, as the doc holds it.
    fn order(&self) -> CVal {
        self.top(&format!("fin:{T}:{}", self.ctx.inc)).expect("the order")
    }

    /// The game's one checkpoint, which must be an end: its key and value.
    fn the_end(&self) -> (String, CVal) {
        let cks = self.cks();
        assert_eq!(cks.len(), 1, "one checkpoint: {cks:?}");
        let (key, v) = cks[0].clone();
        assert_eq!(v.get("e").and_then(CVal::as_int), Some(1), "an end");
        (key, v)
    }
}

/// A checkpoint's fields, sorted.
fn fields_of(v: &CVal) -> Vec<String> {
    let CVal::Obj(fields) = v else { panic!("no record") };
    sorted(fields.iter().map(|(k, _)| k.clone()).collect())
}

/// `keys`, as owned and sorted.
fn names(keys: &[&str]) -> Vec<String> {
    sorted(keys.iter().map(|k| k.to_string()).collect())
}

#[test]
fn after_its_last_reveal_the_house_ends_the_game_at_that_round_with_the_folds_nets_and_the_order_in_it() {
    let mut game = Game::opened("end", "landlord");
    let (c, _, _, hash) = game.last_round();
    // A felt of round 2, which no commitment stands for: an end carries nothing on.
    game.slip(&who("carol"), 2);
    let (root_key, root_ses) = (game.ck_key(&game.base), game.ses.clone());
    let f = game.ending(&c, &hash);
    game.answer(f);
    // Not before HOUSE_TRIM_AFTER_MS since its reveal decided the round (the pages' show of it).
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 0, "too soon");
    assert!(game.untrimmed());
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts(), GameCounts { trims: 0, sweeps: 0, ends: 1, cross_check_mismatches: 0, row_put_backs: 0 });
    let (key, v) = game.the_end();
    assert_ne!(key, root_key);
    let me = game.house.public().to_string();
    assert_eq!(str_of(&v, "b"), Some(game.sid().as_str()));
    assert_eq!(v.get("u").and_then(CVal::as_int), Some(1));
    assert_eq!(str_of(&v, "l"), Some(c.as_str()));
    assert_eq!(str_of(&v, "d"), Some(format!("h:{hash}").as_str()));
    assert_eq!(v.get("o").and_then(CVal::as_int), Some(17));
    assert_eq!(canon_of(v.get("n").cloned()), hb::canon(&obj(vec![("alice", s("5")), ("bob", s("-5"))])));
    assert_eq!(canon_of(v.get("f").cloned()), hb::canon(&game.order()), "the order in it");
    assert_eq!(v.get("dl").and_then(hb::canon), hb::canon(&delegation(&game.owner, &me)));
    assert_eq!(str_of(&v, "k"), Some(me.as_str()));
    // (No carry, no commitment, no sweep count, no transfers: an end hands nothing on.)
    assert_eq!(fields_of(&v), names(&["b", "d", "dl", "e", "f", "g", "j", "k", "l", "n", "o", "ok", "rv", "ts", "u", "v"]));
    for k in ["ok", "j", "rv", "ts"] {
        assert_eq!(v.get(k), game.base.get(k), "{k} is the base's");
    }
    assert!(matches!(ha::read_ck(ROOM, &key, &v), ha::CkRead::Ok { .. }), "one a page reads");
    // The pages read the game over, from it: every session gone, and none opened.
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
    assert!(game.sessions().is_empty(), "the root's session ({root_ses}) gone, and none opened");
    // On disk, with nothing carried.
    let rows = rows_on_disk(&game.dir);
    assert_eq!(rows.get(&(ROOM.to_string(), T.to_string(), game.ctx.inc.clone())), Some(&(key.clone(), hb::canon(&v).unwrap())));
    // …and it writes nothing more at the game.
    let top = game.house.rooms[ROOM].tables.len();
    for _ in 0..5 {
        game.tick(HOUSE_TRIM_AFTER_MS);
    }
    assert_eq!(game.cks(), vec![(key, v)]);
    assert!(game.sessions().is_empty());
    assert_eq!(game.house.game_counts().ends, 1);
    assert_eq!(game.house.rooms[ROOM].tables.len(), top);
}

#[test]
fn with_no_round_decided_since_the_base_the_end_is_at_the_bases_round_at_once_after_its_step_down() {
    let mut game = Game::opened("end-at-base", "landlord");
    game.tick(0);
    assert_eq!(game.records("o:1:").len(), 1, "the house joined round 1");
    game.slip(&who("alice"), 1);
    game.fin(&who("owner"));
    game.tick(200);
    assert_eq!(game.records("h:1:").len(), 1, "its step-down");
    assert_eq!(game.house.game_counts().ends, 0);
    let mut f = game.summary(vec![], 1, None);
    f.nets = vec![];
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 1);
    let (key, v) = game.the_end();
    assert_eq!(str_of(&v, "b"), Some(game.sid().as_str()));
    assert_eq!(v.get("u").and_then(CVal::as_int), Some(0));
    assert_eq!(str_of(&v, "l"), Some(ha::NO_CLOSE));
    assert_eq!(canon_of(v.get("n").cloned()), hb::canon(&obj(vec![])));
    assert_eq!(canon_of(v.get("f").cloned()), hb::canon(&game.order()));
    assert_eq!(fields_of(&v), names(&["b", "dl", "e", "f", "g", "j", "k", "l", "n", "ok", "rv", "ts", "u", "v"]));
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
    assert!(game.sessions().is_empty());
}

#[test]
fn no_end_while_a_round_is_in_flight_or_the_answer_does_not_say() {
    let mut game = Game::opened("end-in-flight", "landlord");
    let (c, _, _, hash) = game.last_round();
    for (tip, open) in [(Some(2), Some(vec![])), (None, Some(vec!["ab".repeat(16)])), (None, None)] {
        let mut f = game.ending(&c, &hash);
        (f.tip, f.open_closes) = (tip, open.clone());
        game.answer(f);
        game.tick(HOUSE_TRIM_AFTER_MS);
        game.tick(200);
        assert_eq!(game.house.game_counts().ends, 0, "{tip:?} {open:?}");
        assert!(game.untrimmed());
    }
    let f = game.ending(&c, &hash);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 1, "once none is");
    assert_eq!(game.the_end().1.get("u").and_then(CVal::as_int), Some(1));
}

#[test]
fn a_round_a_bettors_abandon_voided_the_end_says_so_with_no_outcome() {
    let mut game = Game::opened("end-abandon", "landlord");
    let (c, _, _) = game.closed_on_the_join();
    game.fin(&who("owner"));
    game.tick(200);
    let z = "ab".repeat(16);
    let mut f = game.summary(vec![RoundSummary { decided: Some("abandon".into()), abandon: Some(z.clone()), ..round(1, &c) }], 2, None);
    f.nets = vec![];
    game.answer(f);
    // HOUSE_TRIM_AFTER_MS from the answer that first read the round decided.
    game.tick(200);
    game.tick(HOUSE_TRIM_AFTER_MS - 400);
    assert_eq!(game.house.game_counts().ends, 0, "too soon");
    game.tick(400);
    assert_eq!(game.house.game_counts().ends, 1);
    let (key, v) = game.the_end();
    assert_eq!((v.get("u").and_then(CVal::as_int), str_of(&v, "l"), str_of(&v, "d")), (Some(1), Some(c.as_str()), Some(format!("z:{z}").as_str())));
    assert!(v.get("o").is_none(), "no outcome");
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[test]
fn an_end_waits_missing_wait_ms_for_a_frozen_slip_missing_from_a_decided_round() {
    let mut game = Game::opened("end-missing", "landlord");
    let (c, _, _, hash) = game.last_round();
    let mut f = game.ending(&c, &hash);
    f.rounds[0].missing = Some(vec!["bob".into()]);
    game.answer(f.clone());
    game.tick(200);
    game.tick(MISSING_WAIT_MS - 1_000);
    assert_eq!(game.house.game_counts().ends, 0, "waiting");
    // A tick with no answer forgets it: the wait starts afresh.
    game.no_answer();
    game.tick(1);
    game.answer(f);
    game.tick(1);
    let at = game.now;
    while game.now - at < MISSING_WAIT_MS - 1_000 {
        game.tick(1_000);
    }
    assert_eq!(game.house.game_counts().ends, 0);
    game.tick(1_000);
    game.tick(1_000);
    assert_eq!(game.house.game_counts().ends, 1, "nobody put it back: the round is as the fold reads it");
}

#[test]
fn the_cross_check_refuses_an_end_that_disagrees_with_what_the_house_knows_or_hands_something_on() {
    type Fault = Box<dyn FnMut(&mut Vec<(String, CVal)>) + Send>;
    let set = |k: &'static str, v: CVal| -> Fault {
        Box::new(move |b: &mut Vec<(String, CVal)>| {
            b.retain(|(f, _)| f != k);
            b.push((k.to_string(), v.clone()));
        })
    };
    let gone = |k: &'static str| -> Fault { Box::new(move |b: &mut Vec<(String, CVal)>| b.retain(|(f, _)| f != k)) };
    let faults: Vec<(&str, Fault)> = vec![
        ("b", set("b", s(&"f".repeat(24)))),
        ("u", set("u", CVal::Int(2))),
        ("l", set("l", s(&"e".repeat(32)))),
        ("d", set("d", s(&format!("h:{}", "e".repeat(32))))),
        ("h", set("h", s(&"cd".repeat(32)))),
        ("w", set("w", CVal::Int(1))),
        ("s", set("s", obj(vec![("p", CVal::Int(0)), ("w", obj(vec![]))]))),
        ("nets", set("n", CVal::Obj((0..=ha::MAX_TABLE_PIDS).map(|i| (format!("p{i}"), s("0"))).collect()))),
        // (Not as a page reads one: an end with no order in it, an outcome no wheel has.)
        ("f gone", gone("f")),
        ("o", set("o", CVal::Int(37))),
        // (At the base's round, where round 1 is decided.)
        (
            "at the base",
            Box::new(|b: &mut Vec<(String, CVal)>| {
                b.retain(|(f, _)| !matches!(f.as_str(), "u" | "l" | "d" | "o"));
                b.push(("u".into(), CVal::Int(0)));
                b.push(("l".into(), s(ha::NO_CLOSE)));
            }),
        ),
    ];
    for (name, fault) in faults {
        let mut game = Game::opened(&format!("end-cross-{}", name.replace(' ', "-")), "landlord");
        let (c, _, _, hash) = game.last_round();
        game.house.fault_trim = Some(fault);
        let f = game.ending(&c, &hash);
        game.answer(f);
        game.tick(HOUSE_TRIM_AFTER_MS);
        assert!(game.untrimmed(), "{name}: not signed");
        assert_eq!(game.house.game_counts(), GameCounts { trims: 0, sweeps: 0, ends: 0, cross_check_mismatches: 1, row_put_backs: 0 }, "{name}");
        assert!(!game.dir.join(ROWS_FILE).exists(), "{name}: no row");
        game.house.fault_trim = None;
        game.tick(200);
        assert_eq!(game.house.game_counts().ends, 1, "{name}: once the fault is gone");
    }
}

#[test]
fn no_end_from_a_doc_that_holds_part_of_an_update() {
    let mut game = Game::opened("end-partial", "landlord");
    let (c, _, _, hash) = game.last_round();
    let (first, second) = game.updates_out_of_order();
    game.apply_update(&second);
    let f = game.ending(&c, &hash);
    game.answer(f);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed());
    game.apply_update(&first);
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 1);
}

#[test]
fn no_end_of_a_round_another_houses_reveal_decided() {
    // (The holder's page ends that one: this house knows nothing of the round but what the fold says.)
    let mut game = Game::opened("end-other-house", "landlord");
    let (c, _, _) = game.closed_on_the_join();
    game.fin(&who("owner"));
    game.tick(200);
    let f = game.ending(&c, &"ef".repeat(16));
    game.answer(f);
    for _ in 0..3 {
        game.tick(HOUSE_TRIM_AFTER_MS);
    }
    assert!(game.untrimmed());
    assert_eq!(game.house.game_counts(), GameCounts::default());
}

#[test]
fn no_end_of_its_own_round_where_the_fold_names_another_reveal_or_neither_a_reveal_nor_an_abandon() {
    for (name, how) in [("another", Some("ef".repeat(16))), ("neither", None)] {
        let mut game = Game::opened(&format!("end-not-its-{name}"), "landlord");
        let (c, _, _, _) = game.last_round();
        let mut f = game.ending(&c, "");
        f.rounds[0].house = how;
        game.answer(f);
        game.tick(HOUSE_TRIM_AFTER_MS);
        game.tick(HOUSE_TRIM_AFTER_MS);
        assert!(game.untrimmed(), "{name}");
        assert_eq!(game.house.game_counts(), GameCounts::default(), "{name}");
    }
}

#[test]
fn an_end_at_the_round_its_base_stands_at_is_the_bases_with_its_close_and_outcome() {
    let (mut game, _, c, carried) = trimmed("end-at-u");
    let trim = game.base.clone();
    game.fin(&who("owner"));
    game.ticks();
    // (A round the fold reads at the base's own round is the base's: the end does not wait on its reveal there.)
    let hash = carried.iter().find(|k| k.starts_with("h:1:")).unwrap().rsplit(':').next().unwrap().to_string();
    let f = game.summary(vec![by_house(1, &c, &hash, &[])], 2, None);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 1);
    let (_, v) = game.the_end();
    for k in ["u", "l", "d", "o"] {
        assert_eq!(canon_of(v.get(k).cloned()), canon_of(trim.get(k).cloned()), "{k} is the base's");
    }
}

#[test]
fn after_a_restart_it_still_ends_the_game_at_the_round_it_revealed_before() {
    let mut game = Game::opened("end-restart", "landlord");
    let (c, _, _, hash) = game.last_round();
    game.restart(0);
    game.house.read_answers_from(game.answers.clone());
    game.ticks();
    let f = game.ending(&c, &hash);
    game.answer(f);
    game.tick(200);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert_eq!(game.house.game_counts().ends, 1);
    let (_, v) = game.the_end();
    assert_eq!((v.get("u").and_then(CVal::as_int), str_of(&v, "d")), (Some(1), Some(format!("h:{hash}").as_str())));
}

#[test]
fn the_b4_race_the_holders_end_at_the_round_before_lies_under_the_trim_and_goes_with_the_houses_end() {
    let (mut game, trim_key, _, _) = trimmed("end-b4");
    // The owner pressed off at the root's round as the house trimmed past it: the order, and its own end there.
    game.fin(&who("owner"));
    let root = game.root(game.house.public(), "f1");
    let body = obj(vec![
        ("v", CVal::Int(1)),
        ("ok", s(&game.owner.public)),
        ("j", s("0123456789abcdef")),
        ("rv", s("f1")),
        ("ts", CVal::Int(TS)),
        ("b", s(&hb::next_sid3(&game.ctx, &root).unwrap())),
        ("u", CVal::Int(0)),
        ("l", s(ha::NO_CLOSE)),
        ("n", obj(vec![])),
        ("e", CVal::Int(1)),
        ("f", game.order()),
        ("k", s(&game.owner.public)),
    ]);
    let g = sign(&game.owner, &hb::sign_bytes("ck", &game.ctx, &body).unwrap());
    let own_end = with(&body, "g", s(&g));
    let own_key = game.ck_key(&own_end);
    assert!(matches!(ha::read_ck(ROOM, &own_key, &own_end), ha::CkRead::Ok { .. }), "an end a page reads");
    game.put_top(&own_key, &own_end);
    assert_eq!(game.resolved_base().as_deref(), Some(trim_key.as_str()), "the trim outranks it");
    // The house steps its commitment of round 2 down, then ends the game at the trim's round.
    game.ticks();
    let f = game.summary(vec![], 2, None);
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 1);
    let (key, v) = game.the_end();
    for k in ["u", "l", "d", "o"] {
        assert_eq!(canon_of(v.get(k).cloned()), canon_of(game.base.get(k).cloned()), "{k} is the trim's");
    }
    assert!(game.top(&own_key).is_none(), "the lower end goes with it");
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[test]
fn its_end_deleted_from_the_doc_goes_back_from_its_row_with_no_session() {
    let mut game = Game::opened("end-put-back", "landlord");
    let (c, _, _, hash) = game.last_round();
    let f = game.ending(&c, &hash);
    game.answer(f);
    game.tick(200);
    game.tick(HOUSE_TRIM_AFTER_MS);
    let (key, v) = game.the_end();
    game.delete_top(&key);
    game.tick(REPUT_MS);
    game.tick(REPUT_MS);
    assert_eq!(canon_of(game.top(&key)), hb::canon(&v), "its end back");
    assert_eq!(game.cks().len(), 1);
    assert!(game.sessions().is_empty(), "an end opens none");
    assert_eq!(game.house.game_counts().row_put_backs, 1);
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[test]
fn an_end_over_its_rows_checkpoint_the_doc_lost_is_not_followed_by_that_checkpoints_put_back() {
    // An end it could not note on disk, its trim's checkpoint gone from the doc meanwhile and that checkpoint's session
    // there: the end (its check already done) and the row's put-back fall due in the same pass. The end supersedes the
    // row, and nobody tidies an ended game: the put-back must not lay the trim's checkpoint and session again beside it.
    let (mut game, key, _, _) = trimmed("end-over-lost-row");
    game.fin(&who("owner"));
    game.ticks();
    assert_eq!(game.records("h:2:").len(), 1, "its step-down");
    let rows = game.dir.join(ROWS_FILE);
    std::fs::remove_file(&rows).unwrap();
    std::fs::create_dir_all(&rows).unwrap();
    game.answer(game.summary(vec![], 2, None));
    game.tick(200);
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 0, "not noted, not written");
    assert_eq!(game.cks().iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(), vec![key.clone()]);
    game.delete_top(&key);
    std::fs::remove_dir_all(&rows).unwrap();
    game.tick(REPUT_MS);
    assert_eq!(game.house.game_counts().ends, 1);
    let (end, v) = game.the_end();
    assert_eq!(v.get("u").and_then(CVal::as_int), Some(1), "at the trim's round");
    assert!(game.sessions().is_empty(), "nor the trim's session: {:?}", game.sessions());
    assert_eq!(game.house.game_counts().row_put_backs, 0);
    assert_eq!(game.resolved_base().as_deref(), Some(end.as_str()));
    game.tick(REPUT_MS);
    game.tick(REPUT_MS);
    assert_eq!(game.the_end().0, end);
    assert!(game.sessions().is_empty());
}

#[test]
fn an_end_it_cannot_note_on_disk_is_not_written() {
    let mut game = Game::opened("end-disk", "landlord");
    let (c, _, _, hash) = game.last_round();
    std::fs::create_dir_all(game.dir.join(ROWS_FILE)).unwrap();
    let f = game.ending(&c, &hash);
    game.answer(f);
    game.tick(200);
    game.tick(HOUSE_TRIM_AFTER_MS);
    assert!(game.untrimmed());
    assert_eq!(game.house.game_counts(), GameCounts::default());
    std::fs::remove_dir_all(game.dir.join(ROWS_FILE)).unwrap();
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 1);
}

#[test]
fn no_end_of_a_base_under_the_round_the_holder_it_serves_holds_the_game_from() {
    // Handed to the buyer from round 1, who delegates this house and orders the end: the root is the seller's, and a
    // checkpoint there would be nobody's to sign (the buyer's page ends it once a round of its own is decided).
    let mut game = Game::opened("end-from", "landlord");
    game.tick(0);
    let buyer = who("buyer");
    game.transfer(&buyer, 1);
    game.put_top(&format!("hk:{}", game.house.public()), &delegation(&buyer, game.house.public()));
    game.fin(&buyer);
    game.ticks();
    let mut f = game.summary(vec![], 1, None);
    f.nets = vec![];
    game.answer(f);
    game.tick(200);
    game.tick(2_400);
    assert!(game.untrimmed());
    assert_eq!(game.house.game_counts(), GameCounts::default(), "and no checkpoint is made to be refused");
}

#[test]
fn the_buyers_end_order_at_the_round_of_the_hand_over_its_house_ends_the_game_with_the_order_and_the_transfer_in_it() {
    let mut game = Game::opened("end-at-xf", "landlord");
    game.tick(0);
    let buyer = who("buyer");
    let xf = game.transfer(&buyer, 0);
    let me = game.house.public().to_string();
    game.put_top(&format!("hk:{me}"), &delegation(&buyer, &me));
    game.fin(&buyer);
    game.ticks();
    let mut f = game.summary(vec![], 1, None);
    f.nets = vec![];
    game.answer(f);
    game.tick(200);
    assert_eq!(game.house.game_counts().ends, 1);
    let (key, v) = game.the_end();
    assert_eq!(canon_of(v.get("f").cloned()), hb::canon(&game.order()), "the buyer's order");
    assert_eq!(v.get("dl").and_then(hb::canon), hb::canon(&delegation(&buyer, &me)), "by the delegation it serves the buyer by");
    assert_eq!(v.get("x").map(|x| x.as_arr().unwrap().iter().filter_map(hb::canon).collect::<Vec<_>>()), Some(vec![hb::canon(&xf).unwrap()]), "the chain's transfer");
    assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()));
}

#[test]
fn a_trim_with_no_next_session_opens_none() {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        let comp = txn.get_or_insert_map(COMPUTED_MAP);
        comp.insert(&mut txn, "ck:t:p:old", Any::String("old".into()));
        comp.insert(&mut txn, "ses:t:p:aaa", MapPrelim::default());
    }
    let w = Write::Trim { key: "ck:t:p:end".into(), value: s("end"), gone: vec!["ck:t:p:old".into(), "ses:t:p:aaa".into()], ses: None, copies: vec![("s:2:carol:x".into(), s("felt"))] };
    apply(&mut doc.transact_mut(), &[w]);
    let txn = doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let keys: Vec<String> = comp.keys(&txn).map(str::to_string).collect();
    assert_eq!(keys, vec!["ck:t:p:end"]);
}

#[cfg(feature = "house-fold")]
#[test]
fn the_house_ends_a_game_from_the_bundled_folds_own_answer() {
    for letter in ['p', 'q'] {
        let mut game = Game::opened_as(&format!("end-folded-{letter}"), "landlord", letter);
        let (c, _, _) = game.closed_on_the_join();
        game.fin(&who("owner"));
        game.seeds(1);
        game.ticks();
        assert_eq!(game.records("h:1:").len(), 1, "{letter}: its reveal of round 1");
        let f = game.folded();
        assert!(!f.pending, "{letter}");
        assert_eq!(f.rounds.iter().filter(|v| v.decided.is_some()).map(|v| v.close.clone()).collect::<Vec<_>>(), vec![c.clone()], "{letter}");
        let nets = obj(f.nets.iter().map(|(p, n)| (p.as_str(), s(n))).collect());
        game.answer(f);
        game.tick(200);
        game.tick(HOUSE_TRIM_AFTER_MS);
        assert_eq!(game.house.game_counts(), GameCounts { trims: 0, sweeps: 0, ends: 1, cross_check_mismatches: 0, row_put_backs: 0 }, "{letter}");
        let (key, v) = game.the_end();
        assert_eq!((v.get("u").and_then(CVal::as_int), str_of(&v, "l")), (Some(1), Some(c.as_str())), "{letter}");
        assert_eq!(canon_of(v.get("n").cloned()), hb::canon(&nets), "{letter}: the fold's nets");
        assert!(v.get("s").is_none() && v.get("h").is_none(), "{letter}: no carry, no commitment");
        assert_eq!(game.resolved_base().as_deref(), Some(key.as_str()), "{letter}");
        assert!(game.sessions().is_empty(), "{letter}");
    }
}
