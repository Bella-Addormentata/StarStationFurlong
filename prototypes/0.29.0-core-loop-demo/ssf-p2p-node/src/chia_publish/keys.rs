//! What the publisher holds of the SSF wallet (stage 4 design §3.4, "Type
//! split").
//!
//! The heartbeat used to be started with the wallet key itself, the key the
//! Bank spends from, and made what it needed from it at each use. It is
//! started with a [`PublisherKeys`], made once from the wallet key when the
//! publisher starts ([`PublisherKeys::of`]), and the wallet key is dropped
//! there, on every network (§13 row 12, "the money key leaves the
//! publisher"). The keys hold:
//! - R, the root every burner key and slot of the network comes from
//!   ([`BurnerRoot`]);
//! - B, the beacon's key ([`BurnerKey`], [`MoneyKey::beacon`]);
//! - the SSF wallet's payer, which is a puzzle hash and no key ([`Payer`]),
//!   for the rules that tell a write the wallet paid for from a burner's:
//!   an older version paid for listings and knocks from the wallet on a
//!   test network, and a station that moves to this one in the middle of
//!   an era still has such a mark, knock or parked spend.
//!
//! Neither R nor B gives the wallet key back (each is a blake3 derivation
//! of it, one-way: [`BurnerRoot::of`], [`super::beacon_wallet_key`]), and a
//! [`BurnerKey`] gives no `SecretKey` at all. So the listing, the knocks
//! and the beacon are written from keys that are not the wallet's, by a
//! task that could not sign with the wallet's if it tried.
//!
//! What this does not do. The node still holds the wallet key on every
//! network, in the hub (`HubState::chia_wallet`, for the Bank and the
//! faucet dish), and the heartbeat holds the hub, for the rooms and the
//! contact key. So the split is in what the publisher is handed and in
//! what its code reads, not in what the process could reach: no code in
//! `chia_publish.rs` or the files under it reads the hub's wallet key, and
//! a test reads their source for that
//! (`tests::the_publisher_holds_no_wallet_key`). It is a reading of text,
//! not a proof by types.
//!
//! Beside the heartbeat, a test network's hooks (the craps fairness test
//! and the claim-and-write self-test) are started with the wallet key, as
//! before. The craps hook is the one caller left of the memo builder that
//! signs with it ([`super::build_publish_bundle`]).

use std::fmt;

use chia_bls::SecretKey;

use super::Payer;
use crate::chia_burner::{BurnerKey, BurnerRoot, MoneyKey};
use crate::chia_network::ChiaNet;

/// The publisher's keys for one network (§3.4), made once from the wallet
/// key ([`Self::of`]) when the publisher starts and held for its run, on
/// every network and with the beacon on or off. It is neither `Clone` nor
/// `Copy`: the heartbeat owns the one copy, and each copy of R would be one
/// more to wipe ([`BurnerRoot`]). Nothing here prints a key
/// ([`fmt::Debug`] below).
pub struct PublisherKeys {
    /// R for the network the keys were made for.
    root: BurnerRoot,
    /// B, the beacon's key.
    beacon: BurnerKey,
    /// The SSF wallet's payer: a puzzle hash, as the marks, the knock book
    /// and the lease file it.
    money_payer: Payer,
}

impl PublisherKeys {
    /// The publisher's keys on `net` from the wallet key `wallet`, which is
    /// consumed: R, B and the wallet's payer are made from it, and it is
    /// dropped, on every network.
    pub fn of(net: ChiaNet, wallet: SecretKey) -> PublisherKeys {
        let money = MoneyKey::new(wallet);
        PublisherKeys { root: BurnerRoot::of(&money, net), beacon: money.beacon(), money_payer: Payer::of(money.secret_key()) }
    }

    /// The network the keys were made for, which is R's.
    pub fn net(&self) -> ChiaNet {
        self.root.net()
    }

    /// These keys if they were made for `net`, and the words to stop with
    /// if they were made for another network. The heartbeat asks it once,
    /// of the process's network, before anything else: its files, its
    /// lease and its peers are that network's, and so must be the keys'
    /// root.
    pub(crate) fn for_net(self, net: ChiaNet) -> Result<PublisherKeys, String> {
        if self.net() == net {
            Ok(self)
        } else {
            Err(format!("the publisher's keys were made for {} and this node runs on {}", self.net().name(), net.name()))
        }
    }

    /// R, for the listing's keys and slots, the knocks' keys and the
    /// beacon's slot.
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
}

/// Redacted: the network alone. No key, root or puzzle hash.
impl fmt::Debug for PublisherKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublisherKeys({})", self.net().name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet(n: u8) -> SecretKey {
        SecretKey::from_seed(&[n; 32])
    }

    /// R, B and the wallet's payer are the named derivations of the wallet
    /// key on the keys' network, on every network: the same listing and
    /// knock keys, the same beacon key and the same payer the heartbeat
    /// made for itself before, and the ones a build that still held the
    /// wallet key made, so a station that moves to this build keeps its
    /// keys.
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

    /// Debug names the network, and no byte of a key, of R or of a puzzle
    /// hash.
    #[test]
    fn debug_prints_no_key() {
        for net in ChiaNet::ALL {
            let w = wallet(10);
            let keys = PublisherKeys::of(net, w.clone());
            let said = format!("{keys:?}");
            assert_eq!(said, format!("PublisherKeys({})", net.name()));
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

    /// The lines of `source` that start at the left margin once its own
    /// `mod tests` has opened: the tests' end, a raw string's line inside
    /// them, and whatever the file holds after them, which [`code`] does
    /// not read.
    fn after_tests(source: &str) -> Vec<&str> {
        let tests = source.find("\nmod tests {").expect("the file's tests");
        source[tests..].lines().skip(2).filter(|line| line.starts_with(|c: char| !c.is_whitespace())).collect()
    }

    /// Every `.rs` file under the crate's `src`, by its path from there
    /// with `/` between its parts, with its text ([`lf`]), in the order of
    /// the paths. Read from the source tree the test was built from.
    fn sources() -> Vec<(String, String)> {
        fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).expect("the crate's sources").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let parts: Vec<String> = path.strip_prefix(root).unwrap().components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                    out.push((parts.join("/"), lf(&std::fs::read_to_string(&path).expect("a source file"))));
                }
            }
        }
        let root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    }

    /// The item of `source` that opens with `header`, up to the `}` that
    /// closes it at the start of a line.
    fn item<'a>(source: &'a str, header: &str) -> &'a str {
        let start = source.find(header).unwrap_or_else(|| panic!("{header}"));
        assert!(!source[start + header.len()..].contains(header), "{header} opens one item");
        let len = source[start..].find("\n}\n").expect("the item's end");
        &source[start..start + len]
    }

    /// What the source says of the wallet key and the publisher (stage 4
    /// design §13 row 12, "the money key leaves the publisher"), read as
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
    /// - The keys hold three things, none of them the wallet key. A
    ///   `SecretKey` is named in this file only where the keys are made,
    ///   the wallet key is read there once, for the wallet's payer, and no
    ///   function of the keys gives a key that signs for the wallet.
    /// - In `chia_publish.rs`, outside its tests, nothing takes a wallet
    ///   key out of anything (`secret_key`, `.money()`, under any
    ///   spelling). The other files under `chia_publish` (the
    ///   claim-and-write, the foreign pause, the audit) never read one and
    ///   never name the keys.
    /// - None of those files reads the hub's wallet key (`.chia_wallet`),
    ///   which the node holds on every network for the Bank and the dish,
    ///   and the hub's field has that name.
    /// - After its tests `chia_publish.rs` holds its sub-modules and what
    ///   it takes from them, and no item of its own, so reading it up to
    ///   its tests reads all of its code.
    /// - The wallet's payer, the beacon's key and the root are read out of
    ///   the keys on the lines below and no other.
    /// - The memo builder that signs with a wallet key
    ///   ([`super::super::build_publish_bundle`]) is called from no code of
    ///   the publisher but the test-only [`super::super::memo_bundle`]; the
    ///   craps fairness hook is its one caller in the node, by a reading
    ///   of every source file up to its own tests.
    ///
    /// What it does not see: the wallet key reached from a file outside
    /// `chia_publish` by another way than that builder.
    #[test]
    fn the_publisher_holds_no_wallet_key() {
        // A CRLF checkout reads as an LF one.
        let crlf = "use a;\r\n\r\nfn one(\r\n    a: A,\r\n) {\r\n    two();\r\n}\r\n\r\n#[cfg(test)]\r\nmod tests {\r\n}\r\n";
        assert_eq!(item(code(&lf(crlf)), "\nfn one("), "\nfn one(\n    a: A,\n) {\n    two();");
        assert_eq!(lf(&lf(crlf)), crlf.replace('\r', ""), "and an LF one as itself");

        let (main, publish, this) = (lf(include_str!("../main.rs")), lf(include_str!("../chia_publish.rs")), lf(include_str!("keys.rs")));
        let (claim, pause, audit) = (lf(include_str!("claim_write.rs")), lf(include_str!("foreign_pause.rs")), lf(include_str!("audit.rs")));
        // What `code` leaves unread in chia_publish.rs is no item of its
        // own: the tests' end, two lines of a raw string in them, and the
        // sub-modules with what is taken from them.
        for line in after_tests(&publish) {
            let known = ["}", "}}\"#"].contains(&line) || ["mod ", "use ", "pub use ", "pub(crate) use ", "#[cfg(test)]", "//"].iter().any(|open| line.starts_with(open));
            assert!(known, "chia_publish.rs holds code after its tests: {line}");
        }
        for (name, source) in [("keys.rs", &this), ("claim_write.rs", &claim), ("foreign_pause.rs", &pause), ("audit.rs", &audit)] {
            assert_eq!(after_tests(source), ["}"], "{name} ends with its tests");
        }
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

        // The keys: three fields, none a wallet key, and no `SecretKey` but
        // where they are made. The wallet key is read once, for its payer,
        // in the one expression that makes the keys, and dropped with it.
        let fields = item(this, "\npub struct PublisherKeys {");
        assert_eq!(code_lines(fields, ":"), ["root: BurnerRoot,", "beacon: BurnerKey,", "money_payer: Payer,"]);
        assert_eq!(code_lines(this, "SecretKey"), ["use chia_bls::SecretKey;", "pub fn of(net: ChiaNet, wallet: SecretKey) -> PublisherKeys {"]);
        assert_eq!(code_lines(this, "MoneyKey"), ["use crate::chia_burner::{BurnerKey, BurnerRoot, MoneyKey};", "let money = MoneyKey::new(wallet);"]);
        assert_eq!(code_lines(this, "secret_key"), ["PublisherKeys { root: BurnerRoot::of(&money, net), beacon: money.beacon(), money_payer: Payer::of(money.secret_key()) }"]);
        // What the keys give out: the network, themselves, R, B and a
        // puzzle hash.
        assert_eq!(code_lines(this, "fn "), [
            "pub fn of(net: ChiaNet, wallet: SecretKey) -> PublisherKeys {",
            "pub fn net(&self) -> ChiaNet {",
            "pub(crate) fn for_net(self, net: ChiaNet) -> Result<PublisherKeys, String> {",
            "pub(crate) fn root(&self) -> &BurnerRoot {",
            "pub(crate) fn beacon(&self) -> &BurnerKey {",
            "pub(crate) fn money_payer(&self) -> Payer {",
            "fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {",
        ]);

        // No wallet key is taken out of anything in the publisher.
        for what in ["secret_key", ".money()", "MoneyKey", "NO_MONEY_KEY"] {
            assert_eq!(code_lines(publish, what), [""; 0], "chia_publish.rs: {what}");
        }
        assert_eq!(code_lines(publish, "keys.money_payer()"), [
            "let money = keys.money_payer();",
            "let money_payer = keys.money_payer().hex();",
            "let written = publish_burner_presence(net, root, keys.money_payer(), &iroh_sk, &hub.contact_key, era, &entries, now_unix, listed).await;",
        ]);
        assert_eq!(code_lines(publish, "keys.beacon()"), ["let (hint, write) = publish_beacon_with(lease, fuse, net, client, now(), keys.beacon(), iroh_sk, era, now_unix, dated, rng).await?;"]);
        assert_eq!(code_lines(publish, "keys.root()"), [
            "let own = || Payer::of_burner(&knock_burner(keys.root(), net, req, room_key, era));",
            "let (hint, write) = publish_knock_with(lease, fuse, net, client, now(), keys.root(), money, iroh_sk, gate, leave, req, room_key, era, now_unix, rng).await?;",
            "let root: &crate::chia_burner::BurnerRoot = keys.root();",
        ]);
        for (name, other) in others {
            for what in ["secret_key", ".money()", "PublisherKeys"] {
                assert_eq!(code_lines(other, what), [""; 0], "{name}: {what}");
            }
        }

        // The memo builder that signs with a wallet key has one caller in
        // the publisher, and that caller is the tests' own.
        assert_eq!(code_lines(publish, "build_publish_bundle("), ["pub fn build_publish_bundle(", "let bundle = build_publish_bundle(net, chia_sk, coin, hint, Bytes::new(body))?;"]);
        assert!(publish.contains("#[cfg(test)]\npub fn memo_bundle("), "memo_bundle is the tests' own");
        assert_eq!(code_lines(item(publish, "\npub fn memo_bundle("), "build_publish_bundle(").len(), 1, "and it is the caller");
        // In the rest of the node it has one caller, the craps fairness
        // hook: every other source file is read up to its own tests, but
        // for the one that is tests throughout.
        let mut callers: Vec<(String, String)> = Vec::new();
        for (name, text) in sources() {
            if name == "chia_publish.rs" || name == "chia_publish/chain_tests.rs" {
                continue;
            }
            let code = text.find("\nmod tests {").map_or(text.as_str(), |tests| &text[..tests]);
            callers.extend(code_lines(code, "build_publish_bundle(").into_iter().map(|line| (name.clone(), line.to_string())));
        }
        assert_eq!(callers, [("chia_craps_fair.rs".to_string(), "let bundle = build_publish_bundle(net, chia_sk, coin.coin, hint, Bytes::new(payload.to_vec()))?;".to_string())]);

        // The hub's wallet key is read by none of them.
        for (name, source) in [("chia_publish.rs", publish), ("keys.rs", this)].into_iter().chain(others) {
            assert_eq!(code_lines(source, ".chia_wallet"), [""; 0], "{name} reads the hub's wallet key");
        }
        // The scan names the field the hub keeps the key in.
        assert_eq!(code_lines(main, "chia_wallet: Mutex<"), ["pub chia_wallet: Mutex<Option<chia_bls::SecretKey>>,"]);
    }

    /// What the heartbeat's source says of its writers (stage 4 design §13
    /// rows 10 and 12, §4.5 (6)), read as the scan above reads the wallet
    /// key. No test runs the heartbeat, so this is the one check that each
    /// of its arms writes from a burner key and from nothing else. It is a
    /// reading of text and no proof.
    /// - The heartbeat chooses no path: nothing in it, or in the publisher,
    ///   asks whether burner keys are on, and the variable that turned
    ///   them off (`SSF_CHIA_BURNERS`) is read nowhere in the publisher.
    ///   `main.rs` reads it on one line, to say it is no longer read.
    /// - The writers of the SSF wallet's own path are gone by name: the
    ///   listing's, the knocks', the beacon's and the builder's seam they
    ///   shared.
    /// - The money refusal is asked once in the heartbeat, for its line
    ///   off a test network, and its answer holds no arm.
    /// - What an older version's wallet paid for is still looked for: the
    ///   heartbeat files a lost listing mark again from the lease, with the
    ///   wallet's payer, and hands that payer to the listing's step for
    ///   the hint rule.
    /// - LIST ME is asked once a tick, and its word is read on eight lines:
    ///   where it is asked, where a turn to off drops the queued knocks,
    ///   the tick's findable, the listing's arm and its writer, and the
    ///   knock's arm and its writer. Each writer is handed the word, so
    ///   the listing's and the knocks' arms run and write only with it.
    /// - The root is read out of the keys once in the heartbeat, for the
    ///   listing's keys and slots, the beacon's slot, the pause's keys and
    ///   the audit.
    /// - Each arm calls one writer: the listing's burner writer, the
    ///   knock's seam and the beacon's seam.
    /// - The beacon's seam dates this network's push from the writer's last
    ///   step, no earlier than this network's own mark, which the write
    ///   replaces, and the forgotten mark's date is carried before the mark
    ///   is removed.
    ///
    /// What it does not see: a writer reached under another name.
    #[test]
    fn the_heartbeat_writes_from_burner_keys_alone() {
        let publish = lf(include_str!("../chia_publish.rs"));
        let publish = code(&publish);
        let heartbeat = item(publish, "\npub async fn heartbeat_loop(");
        let main = lf(include_str!("../main.rs"));

        // No path is chosen, and the old variable is read nowhere here.
        for gone in ["burners_enabled", "burner_paths", "burners_of", "BurnerPaths", "paths.", "burner_path", "wallet_refusal", "money_refused", "listing_refused"] {
            assert_eq!(code_lines(publish, gone), [""; 0], "chia_publish.rs: {gone}");
        }
        assert_eq!(code_lines(publish, "env::var"), [
            "std::env::var(\"SSF_CHIA_FINDABLE\").ok().as_deref() != Some(\"0\")",
            "std::env::var(\"SSF_CHIA_BEACON\").ok().as_deref() == Some(\"1\")",
        ]);
        assert_eq!(code_lines(publish, "BURNERS_ENV").len(), 2, "the variable's name, and the note that it is no longer read");
        assert_eq!(code_lines(publish, "pub const BURNERS_ENV"), ["pub const BURNERS_ENV: &str = \"SSF_CHIA_BURNERS\";"]);
        assert_eq!(code_lines(&main, "BURNERS"), ["if let Some(note) = chia_publish::burners_env_note(std::env::var_os(chia_publish::BURNERS_ENV).as_deref()) {"]);
        // The writers of the wallet's own path are gone.
        for gone in ["publish_memo_on", "publish_knock_on", "publish_beacon_on", "publish_node_presence(", "publish_node_presence_on", "money_listing_step", "money_path_burner_payer", "MemoWait"] {
            assert_eq!(code_lines(publish, gone), [""; 0], "chia_publish.rs: {gone}");
        }
        // The money refusal: its line, once, and nothing held by it.
        assert_eq!(code_lines(heartbeat, "refuse_money_memo"), ["let _ = refuse_money_memo(net);"]);
        assert_eq!(code_lines(heartbeat, "money_memo_refusal"), [""; 0]);
        // A write an older version's wallet paid for: its lost mark is
        // filed again, and the listing's step is told the wallet's payer.
        assert_eq!(code_lines(heartbeat, "lost_listing_mark("), [
            "lost_listing_mark(&WALLET_LEASE, node_mark.as_ref(), net, &hub.contact_key, era, &money_payer, |m| listing_clock.burner_payer(root, &hub.contact_key, era, &m.hint)).await;",
        ]);
        assert_eq!(code_lines(heartbeat, "money: "), ["money: &money_payer,"]);

        // 📖 LIST ME (stage 4 design §4.5 (6)): asked of the hub's switch
        // once a tick, and every read of its word. The listing's arm opens
        // on the tick's findable, which is made from it; the knock's arm
        // on the word itself; and each of the two writers is handed it.
        let knock_arm = "let knock_open = listed.as_ref().filter(|_| knock_arm_open(knock_waiting, peak, knock_paced(knock_wait, Instant::now()), knock_paused) && !peak_aged(\"knock\"));";
        let knock_writer = "let done = publish_knock(net, &keys, &iroh_sk, &hub.card_gate, leave, &req, &room_key, era, now_unix, listed).await;";
        let listing_writer = "let written = publish_burner_presence(net, root, keys.money_payer(), &iroh_sk, &hub.contact_key, era, &entries, now_unix, listed).await;";
        let beacon_writer = "let done = publish_beacon(net, &keys, &iroh_sk, era, now_unix).await;";
        assert_eq!(code_lines(heartbeat, "list_me"), ["let listed: Option<crate::chia_listing::Listed> = hub.list_me.listed();"]);
        assert_eq!(code_lines(heartbeat, "listed"), [
            "let listed: Option<crate::chia_listing::Listed> = hub.list_me.listed();",
            "if listed.is_none() {",
            "let findable = findable_now(listed.as_ref(), may_list);",
            "if let Some(listed) = findable {",
            listing_writer,
            knock_arm,
            "if let Some(listed) = knock_open {",
            knock_writer,
        ]);
        assert_eq!(code_lines(heartbeat, "findable"), [
            "let may_list = findable_enabled() && hub.contact_key_durable;",
            "if findable_enabled() && !hub.contact_key_durable {",
            "let findable = findable_now(listed.as_ref(), may_list);",
            "hub.presence_publishing.store(findable.is_some(), std::sync::atomic::Ordering::Relaxed);",
            "if findable.is_none() {",
            "if peak == 0 && (findable.is_some() || knock_waiting || beacon_on) {",
            "if let Some(listed) = findable {",
        ]);
        // The switch's word is a value only a switch that is on gives out,
        // and each writer's signature asks for one.
        for writer in ["\nasync fn publish_burner_presence(", "\npub async fn publish_knock("] {
            assert_eq!(code_lines(item(publish, writer), "Listed"), ["_listed: &crate::chia_listing::Listed,"], "{writer}");
        }
        // What the switch allowed is parked as its own (`Resend`), so the
        // saved bundle stops going to the peers again when the switch is
        // turned off. The slot's rule says which: the listing's first write
        // and a knock are LIST ME's, and a rewrite and the beacon, which
        // has its own setting, are not. The lease leaves LIST ME's spends
        // out of its liveness question by the switch it is told to ask.
        assert_eq!(code_lines(publish, "Resend::WhileListed"), ["if resend == Resend::WhileListed {"]);
        assert_eq!(code_lines(publish, "Resend::Always"), [
            "self.park_with_bundle_as(coin_ids, bundle, payer, Resend::Always)",
            "self.park_pushed_at(coin_ids, pushed, Resend::Always, now)",
            "push_parked_as(lease, client, payer, Resend::Always, bundle, inputs).await",
        ]);
        assert_eq!(code_lines(publish, "sends_again("), [
            "fn sends_again(&self, spend: u64, list_me_on: bool) -> bool {",
            "due.iter().filter(|d| self.asks_the_peers(net, d.payer) && self.sends_again(d.spend, list_me_on)).cloned().collect();",
            "} else if !self.sends_again(*spend, list_me_on) {",
        ]);
        let claim = lf(include_str!("claim_write.rs"));
        let claim = code(&claim);
        assert_eq!(code_lines(item(claim, "\nimpl Slot {"), "Resend::"), ["Slot::Rewritten => Resend::Always,", "Slot::Listing | Slot::Once { .. } => Resend::WhileListed,"]);
        assert_eq!(code_lines(claim, "push_parked"), [
            "use super::{push_parked_as, MemoWrite, ParkedInput, Payer, PushError, Resend, Spacing, WalletLease, WALLET_LEASE};",
            "let acked = match push_parked_as(lease, client, payer, slot.resend(), built.bundle, [built.parked]).await {",
        ]);
        assert_eq!(code_lines(&main, "ask_list_me("), ["chia_publish::WALLET_LEASE.ask_list_me({"]);
        assert!(main.contains("    chia_publish::WALLET_LEASE.ask_list_me({\n        let hub = hub.clone();\n        move || hub.list_me.on()\n    });"));

        // The root: read out of the keys once, and one writer an arm.
        assert_eq!(code_lines(heartbeat, "keys.root()"), ["let root: &crate::chia_burner::BurnerRoot = keys.root();"]);
        assert_eq!(code_lines(heartbeat, "publish_knock("), [knock_writer]);
        assert_eq!(code_lines(heartbeat, "publish_beacon("), [beacon_writer]);
        assert_eq!(code_lines(heartbeat, "publish_burner_presence("), [listing_writer]);
        assert_eq!(code_lines(heartbeat, "let written = "), [listing_writer], "the listing has the one writer");
        assert_eq!(code_lines(heartbeat, "beacon_sees_peak("), ["beacon_sees_peak(&mut beacon_clock, root, peak, &mut rand::rngs::OsRng);"]);
        // The seams under the knock's and the beacon's arms end in the
        // burner writers, with the keys' root and the beacon's key.
        let knock_seam = item(publish, "\nasync fn knock_on_path<");
        assert_eq!(code_lines(knock_seam, "publish_knock_with(").len(), 1);
        assert_eq!(code_lines(knock_seam, ".await").len(), 2, "the lease's read of what it holds under the hint, then the one writer");

        // The beacon's dated push: made in the seam, handed to the writer,
        // and called by it as its body, the last step before a bundle.
        let seam = item(publish, "\nasync fn beacon_on_path<");
        assert_eq!(code_lines(seam, "let pushed = "), ["let pushed = data.join(net.path(BEACON_PUSHED_FILE));"], "this network's own file");
        assert_eq!(code_lines(seam, "let mark = "), ["let mark = data.join(net.path(BEACON_MARK_FILE));"], "and this network's own mark, which the write replaces");
        assert_eq!(code_lines(seam, "date_beacon_push").len(), 1);
        assert_eq!(code_lines(seam, "dated"), [
            "let dated = move || date_beacon_push_over(&pushed, &mark, now_unix).map_err(|e| anyhow!(\"this network's {BEACON_PUSHED_FILE} could not be saved ({e}), so the beacon was not sent\"));",
            "let (hint, write) = publish_beacon_with(lease, fuse, net, client, now(), keys.beacon(), iroh_sk, era, now_unix, dated, rng).await?;",
        ]);
        assert_eq!(code_lines(seam, "other_beacon("), ["let (other_file, other) = other_beacon(data, net);"], "the guard reads the other network's two files");
        assert_eq!(code_lines(publish, "dated().map("), ["let body = move |_| dated().map(|()| plain);"], "the writer dates the push from its body");
        assert_eq!(code_lines(item(publish, "\nasync fn publish_beacon_with<"), "dated().map(").len(), 1);
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

    /// The v1 room record's writer is gone (stage 4 design §13 row 12), and
    /// this keeps it gone: no code of the publisher, or of the files under
    /// it, names what a v1 write was made of: the room key's seal, the
    /// room's daily hint, the v1 record, or the flag that armed a room.
    /// And `main.rs` starts no hook that wrote one. (`chia_resolve.rs` and
    /// `chia_watch.rs` still read v1 on a test network, with the same hint
    /// and the seal's opening: they are not the publisher's.) A reading of
    /// text, like the pins above.
    #[test]
    fn the_publisher_writes_no_v1_room_record() {
        let sources = [
            ("chia_publish.rs", lf(include_str!("../chia_publish.rs"))),
            ("keys.rs", lf(include_str!("keys.rs"))),
            ("claim_write.rs", lf(include_str!("claim_write.rs"))),
            ("foreign_pause.rs", lf(include_str!("foreign_pause.rs"))),
            ("audit.rs", lf(include_str!("audit.rs"))),
        ];
        for (name, source) in &sources {
            for v1 in ["chia_lane::seal(", "derive_hint(", "ChiaPresenceRecord", "may_publish", "chia_mode", "publish_presence"] {
                assert_eq!(code_lines(code(source), v1), [""; 0], "{name} names {v1}");
            }
        }
        let main = lf(include_str!("../main.rs"));
        for hook in ["SSF_CHIA_PUBLISH_TEST", "publish_test_task", "publish_presence"] {
            assert_eq!(code_lines(&main, hook), [""; 0], "main.rs names {hook}");
        }
        // The pin reads what it should: the lines it would catch are found
        // where they still stand, in the readers.
        let resolve = lf(include_str!("../chia_resolve.rs"));
        assert!(!code_lines(code(&resolve), "derive_hint(").is_empty(), "the reader still derives a v1 hint");
    }
}
