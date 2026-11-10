//! What the publisher holds of the SSF wallet (stage 4 design §3.4, "Type
//! split").
//!
//! The heartbeat used to be started with the wallet key itself, the key the
//! Bank spends from, and made what it needed from it at each use. From here
//! it is started with a [`PublisherKeys`], made once from the wallet key
//! when the publisher starts ([`PublisherKeys::of`]):
//! - R, the root every burner key and slot of the network comes from
//!   ([`BurnerRoot`]);
//! - B, the beacon's key ([`BurnerKey`], [`MoneyKey::beacon`]);
//! - the SSF wallet's payer, which is a puzzle hash and no key ([`Payer`]),
//!   for the rules that tell the wallet's own writes from a burner's;
//! - and, on a test network only, the wallet key itself ([`MoneyKey`]), for
//!   the writes that still take it there: with burner keys off, the listing
//!   and the knocks, which the SSF wallet pays for, and the beacon, which
//!   the beacon wallet pays for with the key made from it
//!   ([`super::beacon_wallet_key`]); and the room records of Chia Mesh
//!   (v1), until the money key leaves the publisher (PR 12).
//!
//! Off a test network the wallet key is dropped here, so the heartbeat is
//! handed none: [`PublisherKeys::money`] is the one way to it through the
//! keys, and there it answers with the refusal the money writers
//! themselves give ([`super::refuse_money_memo`]). Neither R nor B gives
//! the wallet key back (each is a blake3 derivation of it, one-way:
//! [`BurnerRoot::of`], [`super::beacon_wallet_key`]), and a [`BurnerKey`]
//! gives no `SecretKey` at all.
//!
//! What this does not do. The node still holds the wallet key on every
//! network, in the hub (`HubState::chia_wallet`, for the Bank and the
//! faucet dish), and the heartbeat holds the hub, for the rooms and the
//! contact key. So the split is in what the publisher is handed and in
//! what its code reads, not in what the process could reach: no code in
//! `chia_publish.rs` or the files under it reads the hub's wallet key, and
//! a test reads their source for that and for each line that takes the
//! wallet key out of these keys
//! (`tests::the_publisher_reads_the_wallet_key_only_through_its_own_keys`).
//! It is a reading of text, not a proof by types.
//!
//! Not typed here, and left to PR 12 with the v1 writer's removal: the
//! money writers themselves (`build_publish_bundle`, `publish_memo_on`)
//! still take a plain `SecretKey`, since on a test network they are the
//! SSF wallet's writers and take its key ([`MoneyKey::secret_key`]). The
//! test hooks of a test network (the publish test, the craps fairness test
//! and the claim-and-write self-test) are started with the wallet key
//! beside the heartbeat, as before.

use std::fmt;

use chia_bls::SecretKey;

use super::{MoneyMemoRefused, Payer};
use crate::chia_burner::{BurnerKey, BurnerRoot, MoneyKey};
use crate::chia_network::ChiaNet;

/// What [`PublisherKeys::money`] says if it is ever asked where the money
/// writers would not refuse and no wallet key is held. [`PublisherKeys::of`]
/// keeps the key exactly where they do not refuse, so no run reaches it.
pub(crate) const NO_MONEY_KEY: &str = "the publisher holds no SSF wallet key, so the SSF wallet pays for no Phone Book write from it";

/// The publisher's keys for one network (§3.4), made once from the wallet
/// key ([`Self::of`]) when the publisher starts and held for its run, on
/// every network and with the beacon on or off. It is neither `Clone` nor
/// `Copy`: the heartbeat owns the one copy, and each copy of R would be one
/// more to wipe ([`BurnerRoot`]). Nothing here prints a key
/// ([`fmt::Debug`] below).
pub struct PublisherKeys {
    /// R for the network the keys were made for.
    root: BurnerRoot,
    /// B, the beacon's key, the same on the burner path and off it.
    beacon: BurnerKey,
    /// The SSF wallet's payer: a puzzle hash, as the marks, the knock book
    /// and the lease file it.
    money_payer: Payer,
    /// The wallet key, only where the money writers do not refuse a memo
    /// spend (a test network).
    money: Option<MoneyKey>,
}

impl PublisherKeys {
    /// The publisher's keys on `net` from the wallet key `wallet`, which is
    /// consumed: R, B and the wallet's payer are made from it, and it is
    /// kept only where the SSF wallet pays for a memo spend
    /// ([`super::money_memo_refusal`], so on a test network) and dropped
    /// everywhere else.
    pub fn of(net: ChiaNet, wallet: SecretKey) -> PublisherKeys {
        let money = MoneyKey::new(wallet);
        PublisherKeys {
            root: BurnerRoot::of(&money, net),
            beacon: money.beacon(),
            money_payer: Payer::of(money.secret_key()),
            money: super::money_memo_refusal(net).is_none().then_some(money),
        }
    }

    /// The network the keys were made for, which is R's.
    pub fn net(&self) -> ChiaNet {
        self.root.net()
    }

    /// These keys if they were made for `net`, and the words to stop with
    /// if they were made for another network. The heartbeat asks it once,
    /// of the process's network, before anything else: its files, its
    /// lease and its peers are that network's, and so must be the keys'
    /// root and their rule for the wallet key.
    pub(crate) fn for_net(self, net: ChiaNet) -> Result<PublisherKeys, String> {
        if self.net() == net {
            Ok(self)
        } else {
            Err(format!("the publisher's keys were made for {} and this node runs on {}", self.net().name(), net.name()))
        }
    }

    /// R, for the listing's keys and slots and the knocks' keys.
    pub(crate) fn root(&self) -> &BurnerRoot {
        &self.root
    }

    /// B, the beacon's key.
    pub(crate) fn beacon(&self) -> &BurnerKey {
        &self.beacon
    }

    /// The SSF wallet's payer, a puzzle hash.
    pub(crate) fn money_payer(&self) -> Payer {
        self.money_payer
    }

    /// These keys with the wallet key dropped, as they are off a test
    /// network, whatever network they were made for: the mock-chain tests
    /// run the burner path's steps with them, on the test network the mock
    /// chain is, so every such test shows the path needs no wallet key.
    #[cfg(test)]
    pub(crate) fn without_wallet_key(mut self) -> PublisherKeys {
        self.money = None;
        self
    }

    /// The wallet key, for a write that takes it: one the SSF wallet pays
    /// for, or the beacon off the burner path, whose key is made from it.
    /// Off a test network there is none, and the answer is the money
    /// writers' own refusal, in their words, with nothing read and nothing
    /// said.
    pub(crate) fn money(&self) -> Result<&MoneyKey, MoneyMemoRefused> {
        self.money.as_ref().ok_or_else(|| MoneyMemoRefused(super::money_memo_refusal(self.net()).unwrap_or_else(|| NO_MONEY_KEY.to_string())))
    }
}

/// Redacted: the network, and whether the wallet key is held. No key, root
/// or puzzle hash.
impl fmt::Debug for PublisherKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublisherKeys({}, wallet key {})", self.net().name(), if self.money.is_some() { "held" } else { "not held" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet(n: u8) -> SecretKey {
        SecretKey::from_seed(&[n; 32])
    }

    /// The wallet key is held exactly where the SSF wallet pays for a memo
    /// spend, which is a test network. Off one, asking for it gives the
    /// money writers' own refusal, and the keys hold none.
    #[test]
    fn the_wallet_key_is_held_on_a_test_network_only() {
        let mut held = 0;
        for net in ChiaNet::ALL {
            let w = wallet(7);
            let keys = PublisherKeys::of(net, w.clone());
            assert_eq!(keys.net(), net);
            assert_eq!(keys.money.is_some(), net.is_test(), "{}", net.name());
            assert_eq!(keys.money.is_some(), super::super::money_memo_refusal(net).is_none(), "{}: held exactly where the money writers do not refuse", net.name());
            match keys.money() {
                Ok(money) => {
                    held += 1;
                    assert!(net.is_test(), "{}", net.name());
                    assert_eq!(money.secret_key().to_bytes(), w.to_bytes(), "the wallet key itself");
                }
                Err(refused) => {
                    assert!(!net.is_test(), "{}", net.name());
                    assert_eq!(Some(refused.0.clone()), super::super::money_memo_refusal(net), "the money writers' own words");
                    assert_eq!(super::super::refuse_money_memo(net), Err(refused), "the refusal the money writers give");
                }
            }
        }
        assert!(held > 0 && held < ChiaNet::ALL.len(), "both a network that holds it and one that does not were tried");
    }

    /// R, B and the wallet's payer are the named derivations of the wallet
    /// key on the keys' network, on every network, with the wallet key held
    /// or not: the same listing and knock keys, the same beacon key and the
    /// same payer the heartbeat made for itself before.
    #[test]
    fn the_root_the_beacon_key_and_the_payer_are_the_wallets_own_on_every_network() {
        for net in ChiaNet::ALL {
            let (w, other) = (wallet(8), wallet(9));
            let keys = PublisherKeys::of(net, w.clone());
            let named = BurnerRoot::of(&MoneyKey::new(w.clone()), net);
            let (ck, slot) = ([0x21u8; 32], [0x22u8; 32]);
            for era in [0u64, 1, 2_900] {
                assert_eq!(keys.root().presence(&ck, era).puzzle_hash(), named.presence(&ck, era).puzzle_hash(), "{} P({era})", net.name());
                assert_eq!(keys.root().knock(&slot, era).puzzle_hash(), named.knock(&slot, era).puzzle_hash(), "{} K(h), era {era}", net.name());
            }
            assert_eq!(keys.root().net(), net);
            assert_eq!(keys.beacon().puzzle_hash(), MoneyKey::new(w.clone()).beacon().puzzle_hash(), "{} B", net.name());
            assert_eq!(keys.beacon().puzzle_hash(), super::super::our_puzzle_hash(&super::super::beacon_wallet_key(&w)), "{} B is beacon_wallet_key(W)", net.name());
            assert_eq!(keys.money_payer(), Payer::of(&w), "{} the wallet's payer", net.name());

            // Another wallet's keys share none of them.
            let theirs = PublisherKeys::of(net, other.clone());
            assert_ne!(theirs.root().presence(&ck, 0).puzzle_hash(), keys.root().presence(&ck, 0).puzzle_hash());
            assert_ne!(theirs.beacon().puzzle_hash(), keys.beacon().puzzle_hash());
            assert_ne!(theirs.money_payer(), keys.money_payer());
        }
        // The root is the network's own: the same wallet's listing key
        // differs from one network to another.
        let [a, b] = ChiaNet::ALL;
        let ck = [0x21u8; 32];
        assert_ne!(PublisherKeys::of(a, wallet(8)).root().presence(&ck, 0).puzzle_hash(), PublisherKeys::of(b, wallet(8)).root().presence(&ck, 0).puzzle_hash());
    }

    /// Debug names the network and whether the wallet key is held, and no
    /// byte of a key, of R or of a puzzle hash.
    #[test]
    fn debug_prints_no_key() {
        for net in ChiaNet::ALL {
            let w = wallet(10);
            let keys = PublisherKeys::of(net, w.clone());
            let said = format!("{keys:?}");
            let held = if net.is_test() { "held" } else { "not held" };
            assert_eq!(said, format!("PublisherKeys({}, wallet key {held})", net.name()));
            for secret in [hex::encode(w.to_bytes()), keys.money_payer().hex(), hex::encode(keys.beacon().puzzle_hash())] {
                assert!(!said.contains(&secret) && !said.contains(&secret[..16]));
            }
        }
    }

    /// The keys are let by for the network they were made for and for no
    /// other, and the words for another name both networks and no key.
    #[test]
    fn keys_made_for_another_network_are_not_let_by() {
        let mut refused = 0;
        for made in ChiaNet::ALL {
            for runs in ChiaNet::ALL {
                let w = wallet(11);
                let payer = Payer::of(&w);
                match PublisherKeys::of(made, w.clone()).for_net(runs) {
                    Ok(keys) => {
                        assert_eq!(made, runs, "{} keys on {}", made.name(), runs.name());
                        assert_eq!((keys.net(), keys.money_payer()), (runs, payer), "the same keys");
                        assert_eq!(keys.money.is_some(), runs.is_test());
                    }
                    Err(why) => {
                        refused += 1;
                        assert_ne!(made, runs);
                        assert_eq!(why, format!("the publisher's keys were made for {} and this node runs on {}", made.name(), runs.name()));
                        assert!(!why.contains(&payer.hex()[..16]) && !why.contains(&hex::encode(w.to_bytes())[..16]));
                    }
                }
            }
        }
        assert_eq!(refused, ChiaNet::ALL.len() * (ChiaNet::ALL.len() - 1), "every pair of two networks was tried");
    }

    /// The lines of `source`, trimmed, that are code (no comment line) and
    /// hold `what`.
    fn code_lines<'a>(source: &'a str, what: &str) -> Vec<&'a str> {
        source.lines().map(str::trim).filter(|line| !line.starts_with("//") && line.contains(what)).collect()
    }

    /// `source` with its line ends made LF, before anything is cut from it
    /// or matched in it. Git for Windows with `core.autocrlf=true` checks
    /// the sources out with CRLF ends (the repo has no `.gitattributes`),
    /// `include_str!` keeps them, and the cuts below are LF text
    /// ([`code`], [`item`]), as `chia_burner`'s scan's are.
    fn lf(source: &str) -> String {
        source.replace("\r\n", "\n")
    }

    /// What comes before a file's own `mod tests`.
    fn code(source: &str) -> &str {
        &source[..source.find("\nmod tests {").expect("the file's tests")]
    }

    /// The item of `source` that opens with `header`, up to the `}` that
    /// closes it at the start of a line.
    fn item<'a>(source: &'a str, header: &str) -> &'a str {
        let start = source.find(header).unwrap_or_else(|| panic!("{header}"));
        assert!(!source[start + header.len()..].contains(header), "{header} opens one item");
        let len = source[start..].find("\n}\n").expect("the item's end");
        &source[start..start + len]
    }

    /// What the source says of the wallet key and the publisher, read as
    /// `chia_burner`'s pin scan reads its own file. It is a reading of
    /// text and no proof: it pins the plain spellings below, so a change
    /// to one of them fails here and has to say why.
    /// - `main.rs`'s `start_publisher` makes the keys from the wallet key
    ///   on the process's own network, and hands the heartbeat those and
    ///   not the key; nothing else in `main.rs` names the keys.
    /// - The heartbeat's own parameters are the hub, the endpoint, the node
    ///   key and the keys. Its network is the process's, and the first
    ///   thing it does with the keys is stop if they were made for another
    ///   ([`PublisherKeys::for_net`]).
    /// - The keys hold four things, a `SecretKey` is named in this file
    ///   only where the keys are made, and the wallet key is kept by the
    ///   money writers' own rule.
    /// - In `chia_publish.rs`, outside its tests, the wallet key is taken
    ///   out of the keys (`secret_key`, under any spelling) on four lines
    ///   and no other, each behind [`PublisherKeys::money`]: the knock and
    ///   the beacon off the burner path, in their seams, and the listing
    ///   off the burner path and the v1 room record, in the heartbeat. In
    ///   this file it is read once, for the wallet's payer. The other
    ///   files under `chia_publish` (the claim-and-write, the foreign
    ///   pause, the audit) never read it and never name the keys.
    /// - None of those files reads the hub's wallet key (`.chia_wallet`),
    ///   which the node holds on every network for the Bank and the dish.
    /// - The wallet's payer and the beacon's key are read out of the keys
    ///   on the lines below and no other. Two of them are the heartbeat's
    ///   own, which no test runs: the payer text for the hint rule, and
    ///   the payer the listing's burner writer is given.
    ///
    /// What it does not see: the wallet key reached from a file outside
    /// `chia_publish`, or the hub's field under another name.
    #[test]
    fn the_publisher_reads_the_wallet_key_only_through_its_own_keys() {
        // A CRLF checkout reads as an LF one.
        let crlf = "use a;\r\n\r\nfn one(\r\n    a: A,\r\n) {\r\n    two();\r\n}\r\n\r\n#[cfg(test)]\r\nmod tests {\r\n}\r\n";
        assert_eq!(item(code(&lf(crlf)), "\nfn one("), "\nfn one(\n    a: A,\n) {\n    two();");
        assert_eq!(lf(&lf(crlf)), crlf.replace('\r', ""), "and an LF one as itself");

        let (main, publish, this) = (lf(include_str!("../main.rs")), lf(include_str!("../chia_publish.rs")), lf(include_str!("keys.rs")));
        let (claim, pause, audit) = (lf(include_str!("claim_write.rs")), lf(include_str!("foreign_pause.rs")), lf(include_str!("audit.rs")));
        let (main, publish, this) = (main.as_str(), code(&publish), code(&this));
        let others = [("claim_write.rs", code(&claim)), ("foreign_pause.rs", code(&pause)), ("audit.rs", code(&audit))];

        // main.rs: the keys are made once, for the process's network.
        assert_eq!(code_lines(main, "PublisherKeys"), ["let keys = chia_publish::PublisherKeys::of(net, chia_sk);"]);
        assert_eq!(code_lines(main, "heartbeat_loop("), ["chia_publish::heartbeat_loop(hub_hb, iroh_hb, iroh_sk_hb, keys).await;"]);
        let start = item(main, "\nfn start_publisher(");
        assert_eq!(code_lines(start, "let net = "), ["let net = chia_network::net();"], "the keys' network is the process's");
        assert_eq!(code_lines(start, "PublisherKeys").len(), 1, "made in start_publisher");
        assert_eq!(code_lines(start, "heartbeat_loop(").len(), 1, "handed over in start_publisher");

        // The heartbeat: what it is handed, its network, and the keys'.
        let heartbeat = item(publish, "\npub async fn heartbeat_loop(");
        let lines: Vec<&str> = heartbeat.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
        assert_eq!(lines[1..6], ["hub: crate::SharedHub,", "iroh_ep: iroh::Endpoint,", "iroh_sk: iroh::SecretKey,", "keys: PublisherKeys,", ") {"]);
        assert_eq!(code_lines(heartbeat, "let net = "), ["let net = crate::chia_network::net();"], "the heartbeat's network is the process's");
        assert_eq!(code_lines(heartbeat, "keys")[..2], ["keys: PublisherKeys,", "let keys = match keys.for_net(net) {"], "the keys are asked for the network first");
        assert_eq!(code_lines(heartbeat, "for_net(").len(), 1);

        // The keys: four fields, and no `SecretKey` but where they are made.
        let fields = item(this, "\npub struct PublisherKeys {");
        assert_eq!(code_lines(fields, ":"), ["root: BurnerRoot,", "beacon: BurnerKey,", "money_payer: Payer,", "money: Option<MoneyKey>,"]);
        assert_eq!(code_lines(this, "SecretKey"), ["use chia_bls::SecretKey;", "pub fn of(net: ChiaNet, wallet: SecretKey) -> PublisherKeys {"]);
        assert_eq!(code_lines(this, "then_some(money)"), ["money: super::money_memo_refusal(net).is_none().then_some(money),"]);
        assert_eq!(code_lines(this, "MoneyKey::new("), ["let money = MoneyKey::new(wallet);"]);
        assert_eq!(code_lines(this, "secret_key"), ["money_payer: Payer::of(money.secret_key()),"]);

        // Where the wallet key is taken out of the keys.
        assert_eq!(code_lines(publish, "secret_key"), [
            "None => publish_knock_on(lease, net, client, now, iroh_sk, keys.money()?.secret_key(), gate, leave, req, room_key, era, now_unix).await?,",
            "publish_beacon_on(lease, net, client, now, iroh_sk, &beacon_wallet_key(keys.money()?.secret_key()), era, now_unix, dated).await?",
            "Ok(money) => publish_node_presence(net, &iroh_sk, money.secret_key(), &hub.contact_key, era, &entries, now_unix).await,",
            "Ok(money) => publish_presence(&iroh_sk, money.secret_key(), &room_key, &addrs).await,",
        ]);
        assert_eq!(code_lines(publish, ".money()"), [
            "None => publish_knock_on(lease, net, client, now, iroh_sk, keys.money()?.secret_key(), gate, leave, req, room_key, era, now_unix).await?,",
            "publish_beacon_on(lease, net, client, now, iroh_sk, &beacon_wallet_key(keys.money()?.secret_key()), era, now_unix, dated).await?",
            "None => match keys.money() {",
            "let published = match keys.money() {",
        ]);
        assert_eq!(code_lines(publish, "keys.money_payer()"), [
            "let money = keys.money_payer();",
            "Some(root) => publish_knock_with(lease, fuse, net, client, now(), root, keys.money_payer(), iroh_sk, gate, leave, req, room_key, era, now_unix, rng).await?,",
            "let money_payer = keys.money_payer().hex();",
            "Some(root) => publish_burner_presence(net, root, keys.money_payer(), &iroh_sk, &hub.contact_key, era, &entries, now_unix).await,",
        ]);
        assert_eq!(code_lines(publish, "keys.beacon()"), ["publish_beacon_with(lease, fuse, net, client, now(), keys.beacon(), iroh_sk, era, now_unix, dated, rng).await?"]);
        for (name, other) in others {
            for what in ["secret_key", ".money()", "PublisherKeys"] {
                assert_eq!(code_lines(other, what), [""; 0], "{name}: {what}");
            }
        }

        // The hub's wallet key is read by none of them.
        for (name, source) in [("chia_publish.rs", publish), ("keys.rs", this)].into_iter().chain(others) {
            assert_eq!(code_lines(source, ".chia_wallet"), [""; 0], "{name} reads the hub's wallet key");
        }
        // The scan sees the field where it is: main.rs sets it.
        assert!(!code_lines(main, ".chia_wallet").is_empty());
    }

    /// What the heartbeat's source says of its paths (stage 4 design §13
    /// row 10, §4.5 (6)), read as the scan above reads the wallet key. No
    /// test runs the heartbeat, so this is the one check that it hands each
    /// arm the path [`super::burner_paths`] gives it. It is a reading of
    /// text and no proof.
    /// - The heartbeat asks whether burner keys are on once, and makes its
    ///   paths from that and the money refusal.
    /// - The root is handed out twice: for the beacon's slot on the beacon's
    ///   path, and for the listing's and the knocks' keys on the listing's.
    ///   The money path's hint rule reads it on two more lines, and makes a
    ///   listing key from it for a test network's root alone.
    /// - The beacon's arm is given the beacon's path and its root: its slot
    ///   clock, its due rule, its seam, and its words for a failed try and
    ///   for a beacon written again.
    /// - The knock's seam, its line for a knock not written and the words
    ///   after a void listing are given the listing's path, and the
    ///   listing's arm its root. So off a test network, where the listing's
    ///   path is closed, a knock is handed the money path, which ends in
    ///   the keys' refusal, and no listing or knock key is made.
    /// - The beacon's seam dates this network's push from the writer's last
    ///   step on both paths, no earlier than this network's own mark, which
    ///   the write replaces, and the forgotten mark's date is carried
    ///   before the mark is removed.
    ///
    /// What it does not see: a path read under another name, or an arm
    /// that reaches a writer some other way.
    #[test]
    fn the_heartbeat_hands_each_arm_its_own_path() {
        let publish = lf(include_str!("../chia_publish.rs"));
        let publish = code(&publish);
        let heartbeat = item(publish, "\npub async fn heartbeat_loop(");

        assert_eq!(code_lines(heartbeat, "burners_enabled()"), ["let paths = burner_paths(burners_enabled(), money_refused.is_some());"]);
        assert_eq!(code_lines(heartbeat, "burner_paths("), ["let paths = burner_paths(burners_enabled(), money_refused.is_some());"]);
        assert_eq!(code_lines(heartbeat, "let money_refused"), ["let money_refused: Option<String> = refuse_money_memo(net).err().map(|e| e.0);"]);
        assert_eq!(code_lines(heartbeat, "keys.root()"), [
            "let burner_root: Option<&crate::chia_burner::BurnerRoot> = paths.beacon.then(|| keys.root());",
            "let listing_root: Option<&crate::chia_burner::BurnerRoot> = paths.listing.then(|| keys.root());",
            "None => money_path_burner_payer(Some(m), era, &m.hint, &money_payer, keys.root(), &hub.contact_key),",
            "money_path_burner_payer(node_mark.as_ref(), era, era_hint, &money_payer, keys.root(), &hub.contact_key).as_deref(),",
        ]);
        let hint_rule = item(publish, "\npub(crate) fn money_path_burner_payer(");
        assert_eq!(
            code_lines(hint_rule, "root."),
            ["let m = mark.filter(|m| root.net().is_test() && m.era == era && m.hint == era_hint)?;", "Some(Payer::of_burner(&root.presence(ck, era)).hex())"],
            "the money path's hint rule makes a listing key from a test network's root only"
        );
        assert_eq!(code_lines(heartbeat, "paths."), [
            "let burner_root: Option<&crate::chia_burner::BurnerRoot> = paths.beacon.then(|| keys.root());",
            "let listing_root: Option<&crate::chia_burner::BurnerRoot> = paths.listing.then(|| keys.root());",
            "let next = after_void_words(lost, paused_now(&mut foreign_pause, Some(now), now_unix), era == now, net, paths.listing);",
            "let done = publish_knock(net, &keys, paths.listing, &iroh_sk, &hub.card_gate, leave, &req, &room_key, era, now_unix).await;",
            "waits_its_turn = knock_not_written(paths.listing, req, &e, era, Instant::now(), &mut hub.knock_queue.lock().unwrap(), &mut knock_wait, &mut chain_knocked);",
            "println!(\"⛓️ ChiaHub beacon: the era {era} beacon {why}; {}\", write_again_words(net, paths.beacon));",
            "let done = publish_beacon(net, &keys, paths.beacon, &iroh_sk, era, now_unix).await;",
            "let failed = done.as_ref().err().map(|e| beacon_failure_line(paths.beacon, era, e));",
        ]);
        assert_eq!(code_lines(heartbeat, "burner_root"), [
            "let burner_root: Option<&crate::chia_burner::BurnerRoot> = paths.beacon.then(|| keys.root());",
            "beacon_sees_peak(&mut beacon_clock, burner_root, peak, &mut rand::rngs::OsRng);",
            "root: burner_root,",
        ]);
        assert_eq!(code_lines(heartbeat, "publish_knock("), ["let done = publish_knock(net, &keys, paths.listing, &iroh_sk, &hub.card_gate, leave, &req, &room_key, era, now_unix).await;"]);
        assert_eq!(code_lines(heartbeat, "publish_beacon("), ["let done = publish_beacon(net, &keys, paths.beacon, &iroh_sk, era, now_unix).await;"]);
        assert_eq!(code_lines(heartbeat, "publish_burner_presence("), [
            "Some(root) => publish_burner_presence(net, root, keys.money_payer(), &iroh_sk, &hub.contact_key, era, &entries, now_unix).await,",
        ]);
        assert_eq!(code_lines(heartbeat, "let written = match "), ["let written = match listing_root {"], "the listing's writer is chosen by the listing's root");

        // The beacon's dated push: made in the seam, handed to both writers,
        // and called by each as its body, the last step before a bundle.
        let seam = item(publish, "\nasync fn beacon_on_path<");
        assert_eq!(code_lines(seam, "let pushed = "), ["let pushed = data.join(net.path(BEACON_PUSHED_FILE));"], "this network's own file");
        assert_eq!(code_lines(seam, "let mark = "), ["let mark = data.join(net.path(BEACON_MARK_FILE));"], "and this network's own mark, which the write replaces");
        assert_eq!(code_lines(seam, "date_beacon_push").len(), 1);
        assert_eq!(code_lines(seam, "dated"), [
            "let dated = move || date_beacon_push_over(&pushed, &mark, now_unix).map_err(|e| anyhow!(\"this network's {BEACON_PUSHED_FILE} could not be saved ({e}), so the beacon was not sent\"));",
            "publish_beacon_with(lease, fuse, net, client, now(), keys.beacon(), iroh_sk, era, now_unix, dated, rng).await?",
            "publish_beacon_on(lease, net, client, now, iroh_sk, &beacon_wallet_key(keys.money()?.secret_key()), era, now_unix, dated).await?",
        ]);
        assert_eq!(code_lines(seam, "other_beacon("), ["let (other_file, other) = other_beacon(data, net);"], "the guard reads the other network's two files");
        assert_eq!(code_lines(publish, "dated().map("), ["let body = move |_| dated().map(|()| plain);"; 2], "both writers date the push from their body");
        for writer in ["\nasync fn publish_beacon_with<", "\nasync fn publish_beacon_on("] {
            assert_eq!(code_lines(item(publish, writer), "dated().map(").len(), 1, "{writer}");
        }
        assert_eq!(code_lines(publish, "date_beacon_push("), [
            "fn date_beacon_push(path: &std::path::Path, at: u64) -> std::io::Result<()> {",
            "date_beacon_push(pushed, at)",
            "date_beacon_push(pushed, last_at)?;",
        ]);
        assert_eq!(code_lines(publish, "date_beacon_push_over("), [
            "fn date_beacon_push_over(pushed: &std::path::Path, mark: &std::path::Path, at: u64) -> std::io::Result<()> {",
            "let dated = move || date_beacon_push_over(&pushed, &mark, now_unix).map_err(|e| anyhow!(\"this network's {BEACON_PUSHED_FILE} could not be saved ({e}), so the beacon was not sent\"));",
        ]);
        assert_eq!(code_lines(heartbeat, "forget_beacon_mark("), ["if let Err(e) = forget_beacon_mark(beacon_mark_path, beacon_pushed_path, m.last_at) {"]);
        assert_eq!(code_lines(heartbeat, "let beacon_pushed_file = "), ["let beacon_pushed_file = crate::chia_network::net().path(BEACON_PUSHED_FILE);"]);
        // The mark is removed by its forgetting alone, which dates first.
        let forget = item(publish, "\nfn forget_beacon_mark(");
        let steps: Vec<&str> = code_lines(forget, "(").into_iter().filter(|line| line.contains("date_beacon_push(") || line.contains("remove_file(")).collect();
        assert_eq!(steps, ["date_beacon_push(pushed, last_at)?;", "match std::fs::remove_file(mark) {"], "the date is carried before the mark goes");
        assert_eq!(code_lines(heartbeat, "remove_file(beacon_mark_path)"), [""; 0], "the heartbeat removes the mark through its forgetting only");
    }
}
