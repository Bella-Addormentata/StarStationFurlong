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
//!   the writes the SSF wallet still pays for there: the listing, the
//!   knocks and the beacon with burner keys off, and the room records of
//!   Chia Mesh (v1), until the money key leaves the publisher (PR 12).
//!
//! Off a test network the wallet key is dropped here and never reaches the
//! heartbeat: [`PublisherKeys::money`] is the one way to it, and there it
//! answers with the refusal the money writers themselves give
//! ([`super::refuse_money_memo`]). So the publisher's task cannot sign a
//! spend of the Bank's coins on mainnet, whatever its code does later: it
//! holds no key that could. Neither R nor B gives the wallet key back
//! (each is a blake3 derivation of it, one-way: [`BurnerRoot::of`],
//! [`super::beacon_wallet_key`]), and a [`BurnerKey`] gives no `SecretKey`
//! at all.
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
/// key ([`Self::of`]). It is neither `Clone` nor `Copy`: the heartbeat owns
/// the one copy, and each copy of R would be one more to wipe
/// ([`BurnerRoot`]). Nothing here prints a key ([`fmt::Debug`] below).
pub struct PublisherKeys {
    /// R for the network the keys were made for.
    root: BurnerRoot,
    /// B, the beacon's key, the same on the burner path and off it.
    beacon: BurnerKey,
    /// The SSF wallet's payer: a puzzle hash, as the marks, the knock book
    /// and the lease file it.
    money_payer: Payer,
    /// The wallet key, only where the SSF wallet pays for a memo spend (a
    /// test network).
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

    /// The wallet key, for a write the SSF wallet pays for. Off a test
    /// network there is none, and the answer is the money writers' own
    /// refusal, in their words, with nothing read and nothing said.
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

    /// The lines of `source`, trimmed, that are code (no comment line) and
    /// hold `what`.
    fn code_lines<'a>(source: &'a str, what: &str) -> Vec<&'a str> {
        source.lines().map(str::trim).filter(|line| !line.starts_with("//") && line.contains(what)).collect()
    }

    /// The heartbeat is started with the publisher's keys and holds the
    /// wallet key in no other way, read from the source as `chia_burner`'s
    /// pin scan reads its own file:
    /// - `main.rs` makes the keys from the wallet key on the process's
    ///   network and hands the heartbeat those, not the key;
    /// - the heartbeat's own parameters are the hub, the endpoint, the node
    ///   key and the keys, and its network is the keys';
    /// - in `chia_publish.rs`, outside its tests, the wallet key is taken
    ///   out of the keys (`.secret_key()`) on four lines and no other, each
    ///   of them a write the SSF wallet pays for, behind
    ///   [`PublisherKeys::money`]: the knock and the beacon off the burner
    ///   path, in their seams, and the listing off the burner path and the
    ///   v1 room record, in the heartbeat;
    /// - the keys keep the wallet key by the money writers' own rule.
    ///
    /// A change that hands the heartbeat a `SecretKey` again, or reads the
    /// wallet key somewhere new, fails here and has to say why.
    #[test]
    fn the_heartbeat_holds_the_wallet_key_only_through_the_publishers_keys() {
        // What comes before a file's own `mod tests`.
        fn code(source: &str) -> &str {
            &source[..source.find("\nmod tests {").expect("the file's tests")]
        }
        let main = include_str!("../main.rs");
        let publish = code(include_str!("../chia_publish.rs"));
        let this = code(include_str!("keys.rs"));

        assert_eq!(code_lines(main, "PublisherKeys"), ["let keys = chia_publish::PublisherKeys::of(net, chia_sk);"]);
        assert_eq!(code_lines(main, "heartbeat_loop("), ["chia_publish::heartbeat_loop(hub_hb, iroh_hb, iroh_sk_hb, keys).await;"]);

        let lines: Vec<&str> = publish.lines().map(str::trim).collect();
        let start = lines.iter().position(|line| *line == "pub async fn heartbeat_loop(").expect("the heartbeat");
        assert_eq!(lines[start + 1..start + 6], ["hub: crate::SharedHub,", "iroh_ep: iroh::Endpoint,", "iroh_sk: iroh::SecretKey,", "keys: PublisherKeys,", ") {"]);
        assert_eq!(code_lines(publish, "let net = "), ["let net = keys.net();"], "the heartbeat's network is the keys'");

        assert_eq!(code_lines(publish, ".secret_key()"), [
            "None => publish_knock_on(lease, net, client, now, iroh_sk, keys.money()?.secret_key(), gate, leave, req, room_key, era, now_unix).await?,",
            "publish_beacon_on(lease, net, client, now, iroh_sk, &beacon_wallet_key(keys.money()?.secret_key()), era, now_unix).await?",
            "Ok(money) => publish_node_presence(net, &iroh_sk, money.secret_key(), &hub.contact_key, era, &entries, now_unix).await,",
            "Ok(money) => publish_presence(&iroh_sk, money.secret_key(), &room_key, &addrs).await,",
        ]);
        assert_eq!(code_lines(publish, "keys.money()"), [
            "None => publish_knock_on(lease, net, client, now, iroh_sk, keys.money()?.secret_key(), gate, leave, req, room_key, era, now_unix).await?,",
            "publish_beacon_on(lease, net, client, now, iroh_sk, &beacon_wallet_key(keys.money()?.secret_key()), era, now_unix).await?",
            "None => match keys.money() {",
            "let published = match keys.money() {",
        ]);

        assert_eq!(code_lines(this, "then_some(money)"), ["money: super::money_memo_refusal(net).is_none().then_some(money),"]);
        assert_eq!(code_lines(this, "MoneyKey::new("), ["let money = MoneyKey::new(wallet);"]);
    }
}
