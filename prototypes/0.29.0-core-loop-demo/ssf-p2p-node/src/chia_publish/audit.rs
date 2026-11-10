//! The sign-off review's audit switch (stage 4 design §11, "Inputs"):
//! `SSF_CHIA_AUDIT=1`.
//!
//! Stage 4 keeps a station's chain writes apart: each edition's listing,
//! each knock and the beacon is written from a key of its own, and no log
//! line, screen or error names where such a key's coin sits. The review
//! that signs stage 4 off (§11) has to look those coins up, on its own
//! full node and on an explorer, so for that review alone the node can be
//! told to name them. With the switch set to exactly `1` the log gains
//! lines that start `🔎 ChiaHub audit:`, one for each key, giving the
//! key's address on the node's network and the same puzzle hash in hex, as
//! the files' `payer` fields write it and a full node's
//! `get_coin_records_by_puzzle_hash` takes it.
//!
//! What is named, and when:
//! - the listing's key P(e), once the heartbeat knows the era, and again
//!   at each new era, for a station that is findable with burner keys on.
//!   The first time in a run it names the keys of the
//!   [`AUDIT_ERAS_BACK`] eras before as well, under the words and the
//!   contact key of now, so one run at the end of a drill of up to five
//!   eras gives the review every listing key of it, written from or not
//!   ([`AuditBook::listing`]);
//! - a knock's key K(h), once the run knows the key has written: when the
//!   knock arm writes the knock from it, finds that write still held on
//!   the lease with its entry lost, or reads from the chain that the key
//!   already knocked (`super::audit_knock`, [`AuditBook::knock`]). A knock
//!   that waits or fails names nothing, since its key holds nothing. A
//!   knock an earlier run wrote is not named again while the knock book
//!   holds it: the arm skips a request for that host before its step
//!   (`super::knock_skipped`), so a later run names it only where the
//!   book lost the entry and the knock is asked for again. Its puzzle
//!   hash is otherwise the `payer` of its entry in `knocks.json`, which
//!   keeps an entry for its era and the one after
//!   (`chia_knock::KnockBook::prune`). So the knock keys of a drill need
//!   the switch on in the runs that write them;
//! - the beacon's key B, when the wallet loads with the beacon on
//!   (`SSF_CHIA_BEACON=1`), on either path: B is one key and one address
//!   with burner keys on or off ([`wallet_lines`]). It is named wherever
//!   the beacon is on, on every network: on the burner path, the only one
//!   off a test network, the beacon's own startup line names no address;
//! - the claim-and-write self-test's key, when that hook runs
//!   (`claim_write::claim_write_selftest`).
//!
//! What is never named: a key. Every line is built from a [`Payer`], which
//! holds a puzzle hash and nothing else, so no secret key and no public
//! key can reach one ([`audit_line`]). The SSF wallet's own address is not
//! the audit's to give: the wallet's line and the Bank's RECEIVE have it.
//!
//! It is a developer switch and is never on by default. A log written with
//! it ties this station's listing, knocks and beacon to each other and to
//! the node id the same log carries, which is the link stage 4 closes on
//! chain, so the notice says to keep the log private ([`audit_of`]). The
//! switch changes nothing else: no write, no file, no screen and nothing
//! sent to a peer. It reads the same on every network, since the review
//! runs on testnet11 first and then on mainnet dev builds.

use std::ffi::OsStr;

use chia_bls::SecretKey;
use chia_sdk_utils::Address;

use super::Payer;
use crate::chia_burner::BurnerRoot;
use crate::chia_network::ChiaNet;

/// The variable that turns the audit's lines on for a run (stage 4 design
/// §11): `SSF_CHIA_AUDIT=1`.
pub const AUDIT_ENV: &str = "SSF_CHIA_AUDIT";

/// How many eras before the one the chain is in the listing's keys are
/// named for, the first time a run names them ([`AuditBook::listing`]).
/// The review comes after a drill of at least two era boundaries (§11), so
/// four eras back, about a month, reach every listing key of such a drill
/// by one run at its end.
pub(crate) const AUDIT_ERAS_BACK: u64 = 4;

/// How many knock keys a run remembers having named
/// ([`AuditBook::knock`]). At this many the memory starts again, and a key
/// named before it may be named once more, which tells the review nothing
/// wrong. A key is named once it has written, and a key's first write
/// as a rule takes one of the era's 16 gifts
/// (`claim_write::MAX_GIFTS_PER_ERA`), so a run stays under it for about
/// sixteen eras.
pub(crate) const MAX_KNOCKS_NAMED: usize = 256;

/// Whether [`AUDIT_ENV`] set to `raw` turns the audit on, and the notice
/// said once a wallet loads. Exactly `1` turns it on, on every network.
/// Any other value (unset, empty, `0`, `true`, a stray space, not UTF-8) is
/// off and says nothing, as a hook's does (main.rs `test_hook`). It reads
/// no environment, so its test asks it every value.
pub fn audit_of(raw: Option<&OsStr>) -> (bool, Option<String>) {
    if raw != Some(OsStr::new("1")) {
        return (false, None);
    }
    let notice = format!(
        "🔎 ChiaHub audit ({AUDIT_ENV}=1): on, for the sign-off review. This log names the address and the puzzle hash of the keys this station's chain writes come from: each era's listing key and each knock's key once it has written (with SSF_CHIA_BURNERS=1), and the beacon's key (with SSF_CHIA_BEACON=1). It prints no key, secret or public. Keep this log private: whoever reads it can tell which chain writes are this station's. Leave the switch unset otherwise."
    );
    (true, Some(notice))
}

/// The process's [`AUDIT_ENV`] ([`audit_of`]), read once, as
/// [`super::burners`] reads its variable: the wallet's lines, the
/// heartbeat's book and the self-test hook see the same value. No test
/// calls it.
pub fn audit() -> &'static (bool, Option<String>) {
    static AUDIT: std::sync::OnceLock<(bool, Option<String>)> = std::sync::OnceLock::new();
    AUDIT.get_or_init(|| audit_of(std::env::var_os(AUDIT_ENV).as_deref()))
}

/// Whether the audit is on for this run ([`audit`]).
pub fn audit_enabled() -> bool {
    audit().0
}

/// What a key the audit names is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AuditKey {
    /// P(e), the listing's key for `era` (stage 4 design §3.2).
    Listing { era: u64 },
    /// K(h), one knock's key in `era` (§3.2).
    Knock { era: u64 },
    /// B, the beacon's key, the same in every era.
    Beacon,
    /// The key of the claim-and-write self-test's write in `era`.
    SelfTest { era: u64 },
}

/// The address `payer`'s coins sit at on `net`: its puzzle hash in the
/// network's bech32m form, as `chia_wallet::receive_address` gives a
/// wallet's.
fn address(net: ChiaNet, payer: Payer) -> String {
    Address::new(payer.0, net.prefix().to_string())
        .encode()
        .expect("bech32m encode never fails for a 32-byte puzzle hash")
}

/// The audit's line for one key: what it is for, its address on `net` and
/// its puzzle hash in hex, the text the marks, the knock book and the
/// lease file write as `payer` ([`Payer::hex`]). It is given the key's
/// [`Payer`] alone, a puzzle hash, so it can name no key.
pub(crate) fn audit_line(net: ChiaNet, key: AuditKey, payer: Payer) -> String {
    let what = match key {
        AuditKey::Listing { era } => format!("listing key, era {era}"),
        AuditKey::Knock { era } => format!("knock key, era {era}"),
        AuditKey::Beacon => "beacon key".to_string(),
        AuditKey::SelfTest { era } => format!("claim-and-write test key, era {era}"),
    };
    format!("🔎 ChiaHub audit: {what} · address {} · puzzle hash {}", address(net, payer), payer.hex())
}

/// The audit's lines when a wallet loads, at startup or when the Bank
/// turns it on: nothing with the audit off; with it on (`audit`, as
/// [`audit_of`] gives it) its notice, and with the beacon on (`beacon_on`)
/// the line of the beacon's key B, derived from the wallet key `wallet`
/// ([`super::beacon_wallet_key`]). B pays for the beacon on either path,
/// as the beacon wallet's key or as a burner key, at one address, so its
/// line is the same with burner keys on or off. It is said wherever the
/// beacon is on, on every network, whether or not a coin sits at the
/// address yet.
pub fn wallet_lines(net: ChiaNet, audit: &(bool, Option<String>), beacon_on: bool, wallet: &SecretKey) -> Vec<String> {
    let (true, notice) = audit else {
        return Vec::new();
    };
    let mut lines: Vec<String> = notice.iter().cloned().collect();
    if beacon_on {
        lines.push(audit_line(net, AuditKey::Beacon, Payer::of(&super::beacon_wallet_key(wallet))));
    }
    lines
}

/// What the heartbeat's audit has named this run, so that each key is
/// named once and not at every tick: the last era whose listing key it
/// named, and the knock keys. It is kept in memory alone. With the audit
/// off it names nothing and derives nothing.
pub(crate) struct AuditBook {
    on: bool,
    /// The latest era whose listing key was named.
    listing_era: Option<u64>,
    /// The knock keys named, at most [`MAX_KNOCKS_NAMED`].
    knocks: Vec<Payer>,
}

impl AuditBook {
    /// A book that has named nothing, for a run with the audit `on` or off.
    pub(crate) fn new(on: bool) -> AuditBook {
        AuditBook { on, listing_era: None, knocks: Vec::new() }
    }

    /// Whether the audit is on, so a caller derives a key for it only then.
    pub(crate) fn on(&self) -> bool {
        self.on
    }

    /// The lines of the listing keys not yet named, as of `era`: `root`'s
    /// listing burners under the contact key `ck` (P(e), stage 4 design
    /// §3.2), on the root's own network. The first time in a run these are
    /// the keys of `era` and of the [`AUDIT_ERAS_BACK`] eras before it,
    /// oldest first; after that, the keys of the eras since the last one
    /// named, the same few at most, which is one line at each new era. An
    /// era already named, or one before it (a peak that stepped back
    /// across an era's start), names nothing.
    pub(crate) fn listing(&mut self, root: &BurnerRoot, ck: &[u8; 32], era: u64) -> Vec<String> {
        if !self.on {
            return Vec::new();
        }
        let oldest = era.saturating_sub(AUDIT_ERAS_BACK);
        let from = match self.listing_era {
            Some(named) if named >= era => return Vec::new(),
            Some(named) => oldest.max(named + 1),
            None => oldest,
        };
        self.listing_era = Some(era);
        (from..=era).map(|e| audit_line(root.net(), AuditKey::Listing { era: e }, Payer::of_burner(&root.presence(ck, e)))).collect()
    }

    /// The line of the knock key `payer` (K(h), §3.2) of a knock of `era`
    /// on `net`, the first time the run is given that key, and nothing
    /// after. Its caller gives it a key only once the key has written
    /// (`super::audit_knock`), and can learn that of one knock more than
    /// once: written, then found on the lease, then read from the chain.
    /// Nothing with the audit off.
    pub(crate) fn knock(&mut self, net: ChiaNet, era: u64, payer: Payer) -> Option<String> {
        if !self.on || self.knocks.contains(&payer) {
            return None;
        }
        if self.knocks.len() >= MAX_KNOCKS_NAMED {
            self.knocks.clear();
        }
        self.knocks.push(payer);
        Some(audit_line(net, AuditKey::Knock { era }, payer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chia_burner::MoneyKey;
    use chia_protocol::Bytes32;

    /// A test wallet's key, from a seed no real wallet uses.
    fn wallet(n: u8) -> SecretKey {
        SecretKey::from_seed(&[n; 32])
    }

    /// Test wallet `n`'s burner root on `net`.
    fn root(n: u8, net: ChiaNet) -> BurnerRoot {
        BurnerRoot::of(&MoneyKey::new(wallet(n)), net)
    }

    /// A payer of the test's own, one for each `n`: a puzzle hash no key
    /// here has.
    fn payer(n: u16) -> Payer {
        let mut bytes = [0u8; 32];
        bytes[..2].copy_from_slice(&n.to_be_bytes());
        Payer(Bytes32::new(bytes))
    }

    /// The address and the puzzle hash a line gives, by its fixed shape.
    fn named(line: &str) -> (String, String) {
        let (_, rest) = line.split_once(" · address ").expect("an address");
        let (address, hex) = rest.split_once(" · puzzle hash ").expect("a puzzle hash");
        (address.to_string(), hex.to_string())
    }

    /// Stage 4 design §11: the audit is on with exactly `1`, on every
    /// network, and its notice says what the log then names, that it names
    /// no key, and to keep the log private. Any other value is off and says
    /// nothing. No environment is read.
    #[test]
    fn ssf_chia_audit_is_on_with_exactly_1_and_any_other_value_is_off_and_says_nothing() {
        assert_eq!(audit_of(None), (false, None), "unset");
        for raw in ["", "0", "true", "yes", " 1", "1 ", "11", "01", "on"] {
            assert_eq!(audit_of(Some(OsStr::new(raw))), (false, None), "{raw:?}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            for raw in [&[0xffu8][..], &[b'1', 0xff][..]] {
                assert_eq!(audit_of(Some(OsStr::from_bytes(raw))), (false, None), "not UTF-8 ({raw:?})");
            }
        }
        assert_eq!(
            audit_of(Some(OsStr::new("1"))),
            (
                true,
                Some(
                    "🔎 ChiaHub audit (SSF_CHIA_AUDIT=1): on, for the sign-off review. This log names the address and the puzzle hash of the keys this station's chain writes come from: each era's listing key and each knock's key once it has written (with SSF_CHIA_BURNERS=1), and the beacon's key (with SSF_CHIA_BEACON=1). It prints no key, secret or public. Keep this log private: whoever reads it can tell which chain writes are this station's. Leave the switch unset otherwise."
                        .to_string()
                )
            )
        );
    }

    /// A line says what the key is for, its address on the line's network
    /// and its puzzle hash, in one fixed shape, and the two name the same
    /// 32 bytes: the address reads back to the puzzle hash on its own
    /// network and is refused on the other, and the hex is the payer text
    /// the files write.
    #[test]
    fn a_line_names_what_the_key_is_for_its_address_on_the_network_and_its_puzzle_hash() {
        let key = root(7, ChiaNet::Testnet11).presence(&[9; 32], 12);
        let payer = Payer::of_burner(&key);
        let hex = hex::encode(key.puzzle_hash());
        assert_eq!(payer.hex(), hex);
        let rows = [
            (AuditKey::Listing { era: 12 }, "listing key, era 12"),
            (AuditKey::Knock { era: 12 }, "knock key, era 12"),
            (AuditKey::Beacon, "beacon key"),
            (AuditKey::SelfTest { era: 12 }, "claim-and-write test key, era 12"),
        ];
        for net in ChiaNet::ALL {
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).expect("two networks");
            for (what, words) in rows {
                let line = audit_line(net, what, payer);
                let (address, said_hex) = named(&line);
                assert_eq!(line, format!("🔎 ChiaHub audit: {words} · address {address} · puzzle hash {hex}"), "{what:?} on {net:?}");
                assert_eq!(said_hex, hex);
                assert!(address.starts_with(&format!("{}1", net.prefix())), "{address} on {net:?}");
                assert_eq!(crate::chia_wallet::address_to_puzzle_hash(net, &address).unwrap(), key.puzzle_hash(), "{what:?} on {net:?}");
                assert!(crate::chia_wallet::address_to_puzzle_hash(other, &address).is_err(), "{address} is {net:?}'s alone");
            }
        }
    }

    /// The address is the one the wallet's own line gives a key
    /// (`chia_wallet::receive_address`), and a line carries no key: not the
    /// secret key's bytes and not the public key's, in hex.
    #[test]
    fn a_line_gives_the_address_a_wallet_line_would_and_no_key() {
        for net in ChiaNet::ALL {
            let sk = wallet(31);
            let line = audit_line(net, AuditKey::Beacon, Payer::of(&sk));
            let (address, _) = named(&line);
            assert_eq!(address, crate::chia_wallet::receive_address(net, &sk));
            for secret in [hex::encode(sk.to_bytes()), hex::encode(sk.public_key().to_bytes())] {
                assert!(!line.contains(&secret), "{line}");
            }
        }
    }

    /// The listing's keys, as the heartbeat asks every tick: the first
    /// asking names the era's key and those of the four eras before, oldest
    /// first, each P(e) of the root and contact key; the same era again
    /// names nothing; the next era names its own key alone; a run that
    /// slept across eras names the ones it missed, the same few at most;
    /// and an era before the last one named names nothing.
    #[test]
    fn the_listing_keys_are_named_once_each_with_the_eras_before_the_first_time() {
        let (ck, net) = ([9u8; 32], ChiaNet::Testnet11);
        let root = root(7, net);
        let lines_of = |eras: std::ops::RangeInclusive<u64>| -> Vec<String> {
            eras.map(|e| audit_line(net, AuditKey::Listing { era: e }, Payer::of_burner(&root.presence(&ck, e)))).collect()
        };
        let mut book = AuditBook::new(true);
        assert!(book.on());
        let first = book.listing(&root, &ck, 10);
        assert_eq!(first, lines_of(6..=10), "the era and the four before");
        assert_eq!(AUDIT_ERAS_BACK, 4);
        let hashes: std::collections::HashSet<String> = first.iter().map(|l| named(l).1).collect();
        assert_eq!(hashes.len(), 5, "a key for each era");
        assert_eq!(book.listing(&root, &ck, 10), Vec::<String>::new(), "the same era, at the next tick");
        assert_eq!(book.listing(&root, &ck, 11), lines_of(11..=11), "the new era's key alone");
        assert_eq!(book.listing(&root, &ck, 14), lines_of(12..=14), "the eras a sleeping run missed");
        assert_eq!(book.listing(&root, &ck, 13), Vec::<String>::new(), "a peak that stepped back");
        assert_eq!(book.listing(&root, &ck, 14), Vec::<String>::new(), "and forward again");
        assert_eq!(book.listing(&root, &ck, 30), lines_of(26..=30), "a long sleep: the same few at most");

        // Another contact key, or another wallet's root, is another key.
        let theirs = AuditBook::new(true).listing(&root, &[10; 32], 10);
        let others = AuditBook::new(true).listing(&self::root(8, net), &ck, 10);
        for other in [&theirs, &others] {
            assert_eq!(other.len(), 5);
            assert!(other.iter().all(|l| !hashes.contains(&named(l).1)), "no key shared");
        }
    }

    /// The first eras have fewer eras before them, and the root's network
    /// is the address's.
    #[test]
    fn the_listing_keys_of_the_first_eras_start_at_era_0_and_carry_the_roots_network() {
        let ck = [9u8; 32];
        for net in ChiaNet::ALL {
            let root = root(7, net);
            let lines = AuditBook::new(true).listing(&root, &ck, 2);
            assert_eq!(lines.len(), 3, "eras 0, 1 and 2 on {net:?}");
            for (e, line) in lines.iter().enumerate() {
                assert!(line.starts_with(&format!("🔎 ChiaHub audit: listing key, era {e} · address {}1", net.prefix())), "{line}");
                assert_eq!(named(line).1, Payer::of_burner(&root.presence(&ck, e as u64)).hex());
            }
            assert_eq!(AuditBook::new(true).listing(&root, &ck, 0).len(), 1, "era 0 alone");
        }
    }

    /// A knock's key is named the first time the run is given it and not
    /// again, each key apart.
    #[test]
    fn a_knock_key_is_named_once_a_run() {
        let net = ChiaNet::Testnet11;
        let mut book = AuditBook::new(true);
        assert_eq!(book.knock(net, 5, payer(1)), Some(audit_line(net, AuditKey::Knock { era: 5 }, payer(1))));
        assert_eq!(book.knock(net, 5, payer(1)), None, "the same knock, tried again");
        assert_eq!(book.knock(net, 6, payer(1)), None, "the same key, whatever the era it is asked in");
        assert_eq!(book.knock(net, 5, payer(2)), Some(audit_line(net, AuditKey::Knock { era: 5 }, payer(2))), "another knock's key");
        assert_eq!(book.knock(net, 5, payer(2)), None);
        assert_eq!(book.knock(net, 5, payer(1)), None, "the first is still remembered");
    }

    /// The run remembers [`MAX_KNOCKS_NAMED`] knock keys. The key that
    /// would make one more starts the memory again, so it never grows past
    /// that, and a key named before may then be named once more.
    #[test]
    fn the_knock_keys_a_run_remembers_are_bounded() {
        let net = ChiaNet::Testnet11;
        let mut book = AuditBook::new(true);
        for n in 0..MAX_KNOCKS_NAMED as u16 {
            assert!(book.knock(net, 5, payer(n)).is_some(), "key {n}");
        }
        assert_eq!(book.knocks.len(), MAX_KNOCKS_NAMED);
        assert_eq!(book.knock(net, 5, payer(0)), None, "full, and the first still remembered");
        assert_eq!(book.knock(net, 5, payer(MAX_KNOCKS_NAMED as u16 - 1)), None, "and the last");
        assert!(book.knock(net, 5, payer(9000)).is_some(), "one more key");
        assert_eq!(book.knocks, vec![payer(9000)], "the memory started again with it");
        assert_eq!(book.knock(net, 5, payer(9000)), None);
        assert!(book.knock(net, 5, payer(0)).is_some(), "an earlier key can be named once more");
        assert_eq!(book.knocks.len(), 2);
    }

    /// With the audit off the book names no listing key and no knock key,
    /// at the first asking or any later one, and remembers nothing.
    #[test]
    fn with_the_audit_off_the_book_names_nothing() {
        let (ck, net) = ([9u8; 32], ChiaNet::Testnet11);
        let root = root(7, net);
        let mut book = AuditBook::new(false);
        assert!(!book.on());
        for era in [0, 10, 10, 11] {
            assert_eq!(book.listing(&root, &ck, era), Vec::<String>::new(), "era {era}");
        }
        assert_eq!(book.knock(net, 5, payer(1)), None);
        assert_eq!(book.knock(net, 5, payer(1)), None);
        assert_eq!((book.listing_era, book.knocks.len()), (None, 0));
    }

    /// When a wallet loads: nothing with the audit off, beacon or not; the
    /// notice with it on; and with the beacon on as well, the line of the
    /// beacon's key B, whose address is the one the beacon's own startup
    /// line names with burner keys off (the beacon wallet's) and whose
    /// puzzle hash is the payer B has as a burner key.
    #[test]
    fn a_loaded_wallet_says_the_notice_and_the_beacons_key_only_with_the_audit_on() {
        let w = wallet(41);
        let on = audit_of(Some(OsStr::new("1")));
        let notice = on.1.clone().expect("a notice");
        for net in ChiaNet::ALL {
            for off in [audit_of(None), audit_of(Some(OsStr::new("0"))), (false, Some("never said".to_string()))] {
                for beacon_on in [false, true] {
                    assert_eq!(wallet_lines(net, &off, beacon_on, &w), Vec::<String>::new(), "off on {net:?}, beacon {beacon_on}");
                }
            }
            assert_eq!(wallet_lines(net, &on, false, &w), vec![notice.clone()], "no beacon, no key named on {net:?}");
            let lines = wallet_lines(net, &on, true, &w);
            assert_eq!(lines.len(), 2, "{lines:?}");
            assert_eq!(lines[0], notice);
            let b = super::super::beacon_wallet_key(&w);
            assert_eq!(lines[1], audit_line(net, AuditKey::Beacon, Payer::of(&b)));
            let (address, hex) = named(&lines[1]);
            assert_eq!(address, crate::chia_wallet::receive_address(net, &b), "the beacon wallet's address on {net:?}");
            assert_eq!(hex, Payer::of_burner(&MoneyKey::new(w.clone()).beacon()).hex(), "B as a burner key");
            assert_ne!(address, crate::chia_wallet::receive_address(net, &w), "never the SSF wallet's own");
        }
    }

    /// The lines of `source`, trimmed, that are code (no comment line) and
    /// hold `what`.
    fn code_lines<'a>(source: &'a str, what: &str) -> Vec<&'a str> {
        source.lines().map(str::trim).filter(|line| !line.starts_with("//") && line.contains(what)).collect()
    }

    /// No audit line reaches the log but behind the process's switch. The
    /// functions here are given the switch by their callers, so this reads
    /// the callers' own lines, as `chia_burner`'s pin scan reads its file:
    /// the switch is the environment's variable and nothing else; the
    /// heartbeat's book, which the listing's and the knocks' lines come
    /// from, is made once, from that switch, and is the book both are
    /// asked of; a loaded wallet's lines are given the switch as it was
    /// read; and the self-test's line is printed inside its own check of
    /// the switch. A caller changed to pass `true`, or a new place that
    /// makes a book or a line, fails here.
    #[test]
    fn every_audit_line_is_printed_behind_the_processs_switch() {
        let publish = include_str!("../chia_publish.rs");
        let claim = include_str!("claim_write.rs");
        let main = include_str!("../main.rs");
        let this = include_str!("audit.rs");
        let this = &this[..this.find("#[cfg(test)]").expect("this module's tests")];

        assert_eq!(code_lines(this, "AUDIT.get_or_init("), ["AUDIT.get_or_init(|| audit_of(std::env::var_os(AUDIT_ENV).as_deref()))"]);
        assert_eq!(code_lines(this, "audit_of("), [
            "pub fn audit_of(raw: Option<&OsStr>) -> (bool, Option<String>) {",
            "AUDIT.get_or_init(|| audit_of(std::env::var_os(AUDIT_ENV).as_deref()))",
        ]);
        assert_eq!(code_lines(this, "audit().0"), ["audit().0"], "audit_enabled is the switch as read");

        assert_eq!(code_lines(publish, "AuditBook::new("), ["let mut audit = AuditBook::new(audit_enabled());"]);
        assert_eq!(code_lines(publish, "audit.listing("), ["for line in audit.listing(root, &hub.contact_key, era) {"]);
        assert_eq!(code_lines(publish, "audit_knock("), [
            "fn audit_knock(",
            "let audit_line = audit_knock(&mut audit, listing_root, net, &req, &room_key, era, &done);",
        ]);
        assert_eq!(code_lines(publish, "audit_line("), Vec::<&str>::new(), "no line is made in chia_publish.rs itself");
        assert_eq!(code_lines(publish, "audit_of("), Vec::<&str>::new());

        assert_eq!(code_lines(main, "audit"), ["for line in chia_publish::audit_wallet_lines(net, chia_publish::audit(), chia_publish::beacon_enabled(), &id.wallet) {"]);

        let said = [
            "if super::audit::audit_enabled() {",
            "println!(\"{}\", super::audit::audit_line(net, super::audit::AuditKey::SelfTest { era }, Payer::of_burner(&key)));",
            "}",
        ];
        assert_eq!(code_lines(claim, "audit"), said[..2]);
        let lines: Vec<&str> = claim.lines().map(str::trim).collect();
        assert!(lines.windows(3).any(|three| three == said), "the self-test's line is printed inside its check of the switch");
    }
}
