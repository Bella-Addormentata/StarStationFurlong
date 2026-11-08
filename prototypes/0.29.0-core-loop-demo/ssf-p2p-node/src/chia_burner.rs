//! Burner keys (stage 4 design §3, PR 5 `burner-keys` in §13): the keys that
//! will pay for the lane's writes, one key per slot, so that the money
//! address never pays for a memo and no two slots share a coin chain.
//!
//! Three types keep the two kinds of key apart (§3.4):
//! - [`MoneyKey`] is the wallet key, m/12381/8444/2/0 unhardened. The Bank,
//!   GIVE, testnet TAKE and a future TRANSFER spend from it.
//! - [`BurnerRoot`] is R, 32 bytes made only from a `MoneyKey` and the
//!   network, kept in memory only and wiped when dropped. It keeps its
//!   network beside it (public, not wiped), since P(e) is derived under that
//!   network's listing hint, which carries the network tag on mainnet
//!   (§3.5).
//! - [`BurnerKey`] is one slot's key: P(e), the listing's for an era, or
//!   K(h), one knock's. Only a root's derivations make one: no trait turns
//!   a `MoneyKey` (or any other `SecretKey`) into one, and no line of this
//!   file builds one from anything else (the two tests under Types).
//!
//! The derivation is §3.2's, line by line (each line is quoted where it is
//! built). Every burner key is a blake3 PRF output fed to Chia's KeyGen,
//! not a Chia HD path, so it is off every m/12381/8444/2/* path and off the
//! master key (§3.3), and Sage and the Chia wallet restoring the same words
//! never list or co-spend a burner coin. The beacon is not a burner: it keeps
//! `chia_publish::beacon_wallet_key` of the wallet key, unchanged (§3.1).
//!
//! The slots of §4.3 (T1 and T5) come from the same root: [`BurnerRoot::slot`]
//! is how many blocks into an era a kind's first write is due, secret, and
//! the same after a restart, because it is computed again from the words.
//!
//! Nothing here is written to disk (§3.3, "No new secret on disk"): the node
//! keeps only the wallet key, and R and the burner keys are computed when
//! needed.
//!
//! What the derivations pass through is wiped as well: in [`BurnerRoot::of`]
//! the copy of W and the material W ‖ G (R itself goes straight into the
//! root, whose drop wipes it), and each keyed hash of R, which is a burner
//! key's whole seed in [`BurnerRoot::key`] or a slot's bytes in
//! [`BurnerRoot::slot`]. blake3's `zeroize` feature (Cargo.toml) makes its
//! `Hash` wipeable, so each keyed hash is held in `Zeroizing` itself and read
//! by reference, not copied out of a `Hash` that would be left behind. Out of
//! this file's reach: the state blake3 keeps on its own stack while it
//! hashes, the copies a move leaves, and a burner's `SecretKey`, which
//! chia-bls does not wipe.
#![cfg(feature = "chia-publish")]
// PR 9 (`claim-and-write`: the bundle builder and its self-test hook) calls
// the root, K(h) and a burner key's puzzle hash and signature; PR 10
// (`burner-writers`) calls the rest, P(e) and the slots among them (design
// §13). Until then only this module's tests use those, so a build without
// them would warn that they are dead code.
#![cfg_attr(not(test), allow(dead_code))]

use std::fmt;

use anyhow::Result;
use chia_bls::{PublicKey, SecretKey};
use chia_protocol::{Bytes32, CoinSpend, SpendBundle};
use zeroize::{Zeroize, Zeroizing};

use crate::chia_lane::{self, KIND_KNOCK, KIND_PRESENCE};
use crate::chia_network::ChiaNet;
use crate::chia_publish;

/// The blake3 `derive_key` context of the root R (§3.2, the line `R = ...`).
const CTX_ROOT: &str = "ssf-chia-burner-root-v1";
/// The label a burner key's message starts with (§3.2, the line `key(k,e,h) = ...`).
const LABEL_KEY: &[u8] = b"ssf-chia-burner-v1";
/// The label a slot's message starts with (§3.2, the line `slot(k,e) = ...`).
const LABEL_SLOT: &[u8] = b"ssf-chia-burner-slot-v1";

/// A burner key's message: the label, the kind (1 byte), the era (8 bytes,
/// little-endian) and the hint (32 bytes).
const KEY_MSG_LEN: usize = LABEL_KEY.len() + 1 + 8 + 32;
/// A slot's message: the label, the kind (1 byte) and the era (8 bytes,
/// little-endian).
const SLOT_MSG_LEN: usize = LABEL_SLOT.len() + 1 + 8;

/// The span a slot falls in, in blocks: one day at 18.75 s a block
/// (86,400 / 18.75 = 4,608), so an era's first listing (T1) and its beacon
/// (T5) are due 0 to 4,607 blocks into the era (§4.3). An era
/// (`chia_lane::ERA_BLOCKS`) is seven of these.
pub const SLOT_BLOCKS: u64 = 4_608;

/// The wallet key, m/12381/8444/2/0 unhardened (§3.4): the key the money
/// spends take (the Bank, GIVE, testnet TAKE, a future TRANSFER), and the W
/// a [`BurnerRoot`] is made from. It does not turn into a [`BurnerKey`] or
/// come from one: no `From`, `TryFrom`, `Into`, `AsRef`, `Borrow` or
/// `Deref` joins them (`tests::a_money_key_cannot_reach_the_publisher`),
/// and the only line that builds a `BurnerKey` is a root's derivation
/// (`tests::every_line_that_builds_a_key_or_reads_its_secret_is_pinned`).
pub struct MoneyKey(SecretKey);

impl MoneyKey {
    /// The wallet key as `chia_wallet::keys_from_mnemonic` and
    /// `load_or_mint_wallet` give it.
    pub(crate) fn new(wallet: SecretKey) -> MoneyKey {
        MoneyKey(wallet)
    }

    /// The wallet key, for the money spends, which take it as a plain
    /// `SecretKey` today. Never for the publisher: from PR 10 its entry
    /// points take a [`BurnerKey`], and no `SecretKey` makes one.
    pub(crate) fn secret_key(&self) -> &SecretKey {
        &self.0
    }
}

/// Redacted: `SecretKey`'s own Debug prints the key's bytes.
impl fmt::Debug for MoneyKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MoneyKey(..)")
    }
}

/// R of §3.2: 32 bytes made from the wallet key and the network, from which
/// every burner key and slot of that network is derived. It lives in memory
/// only, has no accessor of its bytes, and is wiped when dropped. It is
/// neither `Clone` nor `Copy`: no caller needs a second copy, and each copy
/// would be one more to wipe. The second field is the network R was made
/// for, kept so that [`presence`](Self::presence) derives the listing hint
/// on that network (§3.5); it is public and `Copy`, so it is not wiped.
pub struct BurnerRoot([u8; 32], ChiaNet);

impl BurnerRoot {
    /// The root of `money`'s burners on `net`. Each network has its own words
    /// (chia_wallet.rs), and G is mixed in as well (§3.3), so the same words
    /// on two networks still give two roots.
    pub fn of(money: &MoneyKey, net: ChiaNet) -> BurnerRoot {
        // §3.2: R = blake3::derive_key("ssf-chia-burner-root-v1", W.to_bytes() ‖ G).
        // W.to_bytes() is chia_bls's 32-byte big-endian scalar. G is the
        // network's genesis challenge (`ChiaNet::genesis`) on every network:
        // the root mixes it in on testnet11 too, unlike the network tag of
        // §3.5, which only mainnet appends. The material holds the wallet
        // key, so it and the copy of W are wiped. R comes back from
        // `derive_key` as a plain [u8; 32], not a `Hash`, and is moved
        // straight into the root, whose drop wipes it: no copy of R is held
        // here outside the root. The network goes in beside it as it is.
        let w = Zeroizing::new(money.0.to_bytes());
        let mut material = Zeroizing::new([0u8; 64]);
        material[..32].copy_from_slice(&w[..]);
        material[32..].copy_from_slice(&net.genesis());
        BurnerRoot(blake3::derive_key(CTX_ROOT, &material[..]), net)
    }

    /// key(k, e, h) of §3.2: the burner key of kind `kind` for era `era`
    /// under hint `hint`. Private: the slots name their kinds through
    /// [`presence`](Self::presence) and [`knock`](Self::knock).
    fn key(&self, kind: u8, era: u64, hint: &[u8; 32]) -> BurnerKey {
        // §3.2: key(k,e,h) = SecretKey::from_seed(blake3::keyed_hash(R,
        // "ssf-chia-burner-v1" ‖ k(1) ‖ e_le(8) ‖ h(32))). The message holds
        // no secret (the label, the kind, the era, and a hint that goes on
        // chain as the write's first memo); the key is R.
        let n = LABEL_KEY.len();
        let mut msg = [0u8; KEY_MSG_LEN];
        msg[..n].copy_from_slice(LABEL_KEY);
        msg[n] = kind;
        msg[n + 1..n + 9].copy_from_slice(&era.to_le_bytes());
        msg[n + 9..].copy_from_slice(hint);
        // The 32-byte keyed hash is the seed. `from_seed` (Chia's KeyGen,
        // EIP-2333) asserts a seed of at least 32 bytes, so 32 is enough; it
        // is the secret key's whole entropy, so it is wiped. The `Hash`
        // blake3 returns is itself held in `Zeroizing` (blake3's `zeroize`
        // feature) and its bytes are read by reference, so no unwiped copy
        // of the seed is left in this frame.
        let seed = Zeroizing::new(blake3::keyed_hash(&self.0, &msg));
        BurnerKey(SecretKey::from_seed(seed.as_bytes()))
    }

    /// P(e) of §3.2: the listing's key for `era`, under the hint of contact
    /// key `ck` for that era on the root's network. All the listing writes of
    /// an era share it, a new era brings a new key, and so does a new contact
    /// key (§3.1, Slots).
    pub fn presence(&self, ck: &[u8; 32], era: u64) -> BurnerKey {
        // §3.2: P(e) = key(1, e, derive_ck_hint(ck, e)). The hint is the one
        // the listing is written under on this root's network: on mainnet it
        // carries the network tag (§3.5), so mainnet's P(e) moved with it
        // when the tag came in; testnet11's did not.
        self.key(KIND_PRESENCE, era, &chia_lane::derive_ck_hint(self.1, ck, era))
    }

    /// K(h) of §3.2: the key of one knock. `inbox_hint` is the hint the
    /// knock is written under in `era`, `chia_lane::derive_inbox_hint(net,
    /// ck_host, lane, era)` on the root's network, so it is one key per host
    /// per era (§3.1, Slots).
    pub fn knock(&self, inbox_hint: &[u8; 32], era: u64) -> BurnerKey {
        // §3.2: K(h) = key(2, e, h) with h = derive_inbox_hint(ck_host, lane, e).
        // The caller gives h, already on its network (§3.5), so this line
        // takes no network of its own.
        self.key(KIND_KNOCK, era, inbox_hint)
    }

    /// slot(k, e) of §3.2: how many blocks into era `era` the first write of
    /// kind `kind` is due (`chia_lane::KIND_PRESENCE` for T1, `KIND_BEACON`
    /// for T5, §4.3), in `0..SLOT_BLOCKS`. Secret, because only the root
    /// gives it, and the same after a restart, because the root is computed
    /// again from the same words.
    pub fn slot(&self, kind: u8, era: u64) -> u64 {
        // §3.2: slot(k,e) = u64(blake3::keyed_hash(R, "ssf-chia-burner-slot-v1"
        // ‖ k(1) ‖ e_le(8))[0..8]) mod 4,608. The message holds no secret.
        let n = LABEL_SLOT.len();
        let mut msg = [0u8; SLOT_MSG_LEN];
        msg[..n].copy_from_slice(LABEL_SLOT);
        msg[n] = kind;
        msg[n + 1..].copy_from_slice(&era.to_le_bytes());
        // The keyed hash gives the slot away, so it is wiped as the seed is
        // in `key`: the `Hash` itself is held in `Zeroizing` and read by
        // reference, and its first 8 bytes are copied into a buffer that is
        // wiped too.
        let out = Zeroizing::new(blake3::keyed_hash(&self.0, &msg));
        // u64(..) reads the first 8 bytes little-endian: the design names no
        // byte order, and every integer in the lane's bytes is little-endian
        // (the era in the hints and in this module's own messages). 2^64 is
        // not a multiple of 4,608, so the low slots are favoured, by about
        // one part in 4·10^15: nothing a reader could measure.
        let mut first = Zeroizing::new([0u8; 8]);
        first.copy_from_slice(&out.as_bytes()[..8]);
        u64::from_le_bytes(*first) % SLOT_BLOCKS
    }
}

/// Wipes R, so that a dropped root leaves none of its bytes behind.
impl Drop for BurnerRoot {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Redacted: never R's bytes.
impl fmt::Debug for BurnerRoot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BurnerRoot(..)")
    }
}

/// One slot's key (§3.4): what the publisher signs a listing or a knock with
/// from PR 10. Only [`BurnerRoot::presence`] and [`BurnerRoot::knock`] make
/// one. There is no constructor from a `SecretKey`, from raw bytes or from a
/// [`MoneyKey`], and the key never leaves it: it gives its public key, its
/// puzzle hash and its signature over a spend, never the `SecretKey` itself.
/// Its field is private, so only this file can build one or read its key,
/// and `tests::every_line_that_builds_a_key_or_reads_its_secret_is_pinned`
/// pins each line here that does.
pub struct BurnerKey(SecretKey);

impl BurnerKey {
    /// The key's public key (G1).
    pub fn public_key(&self) -> PublicKey {
        self.0.public_key()
    }

    /// ph(key) of §3.2: the standard puzzle hash of the key's synthetic key,
    /// the address its one coin lives at, computed as every other coin of
    /// ours is (`chia_publish::our_puzzle_hash`).
    pub fn puzzle_hash(&self) -> Bytes32 {
        chia_publish::our_puzzle_hash(&self.0)
    }

    /// Signs `coin_spends` for `net` with the key's synthetic key and bundles
    /// them (`chia_publish::sign_standard_spends`, the signer the publisher
    /// and the dish's GIVE use today). The bundle builder of PR 9 calls this
    /// for the burner's own coin; the keyless lobby dish spend in the same
    /// bundle asks for no signature (§4.1). A spend that asks for another
    /// key's signature is refused, so a burner never signs for a money coin.
    pub(crate) fn sign_spends(&self, net: ChiaNet, coin_spends: Vec<CoinSpend>) -> Result<SpendBundle> {
        chia_publish::sign_standard_spends(net, &self.0, coin_spends)
    }
}

/// Redacted: the public key's fingerprint at most, never the key's bytes.
impl fmt::Debug for BurnerKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BurnerKey").field("fingerprint", &self.0.public_key().get_fingerprint()).finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    use bip39::Mnemonic;
    use chia_bls::{master_to_wallet_hardened, master_to_wallet_hardened_intermediate, master_to_wallet_unhardened};
    use chia_protocol::{Bytes, Coin};
    use chia_puzzle_types::DeriveSynthetic;
    use chia_sdk_driver::{SpendContext, StandardLayer};
    use chia_sdk_signer::{AggSigConstants, RequiredSignature};
    use chia_sdk_types::Conditions;
    use clvmr::Allocator;

    use crate::chia_lane::{derive_inbox_hint, derive_lane_token, ERA_BLOCKS, KIND_BEACON};
    use crate::chia_publish::beacon_wallet_key;
    use crate::chia_wallet::{keys_from_mnemonic, master_of, receive_address};

    /// A listing's contact key, a host's contact key and a room key for the
    /// vectors: fixed test bytes, not anyone's keys.
    const CK: [u8; 32] = [0x11; 32];
    const CK_HOST: [u8; 32] = [0x22; 32];
    const ROOM_KEY: [u8; 32] = [0x33; 32];
    /// The eras the vectors are taken at: 0, the first, and 123, whose eight
    /// little-endian bytes differ from its big-endian ones. Era 0 has the
    /// same bytes in either order, so only the rows at 123 catch an era
    /// written big-endian (see `PINNED`).
    const ERAS: [u64; 2] = [0, 123];
    /// The knock vector's era: 123, not 0, for the same reason.
    const KNOCK_ERA: u64 = 123;

    /// The zero-entropy test mnemonic (23 × "abandon", then "art"), the one
    /// chia_wallet.rs's `beacon_key_is_off_the_wallet_path` uses: public
    /// test data, never a real wallet.
    fn zero_words() -> Mnemonic {
        Mnemonic::from_entropy(&[0u8; 32]).expect("32 bytes of entropy make 24 words")
    }

    /// The zero mnemonic's wallet key, as a fresh load gives it.
    fn zero_money() -> MoneyKey {
        MoneyKey::new(keys_from_mnemonic(&zero_words()).wallet)
    }

    /// The knock vector's inbox hint: the host's for the room's lane in the
    /// era, on `net` (§3.5: mainnet's carries the network tag).
    fn inbox_hint(net: ChiaNet, ck_host: &[u8; 32], room_key: &[u8; 32], era: u64) -> [u8; 32] {
        derive_inbox_hint(net, ck_host, &derive_lane_token(room_key), era)
    }

    fn pk_hex(pk: &PublicKey) -> String {
        hex::encode(pk.to_bytes())
    }

    fn ph_hex(ph: Bytes32) -> String {
        hex::encode(ph.to_bytes())
    }

    /// What one network's vectors pin.
    struct Pinned {
        net: ChiaNet,
        /// blake3 of R's bytes, not R: the vector of a secret is its hash.
        root_blake3: &'static str,
        /// (era, P(era)'s public key, P(era)'s puzzle hash) for [`ERAS`].
        presence: [(u64, &'static str, &'static str); 2],
        /// K(h)'s public key and puzzle hash for `CK_HOST`, `ROOM_KEY`'s lane and [`KNOCK_ERA`].
        knock: (&'static str, &'static str),
        /// (era, [slot(1, era), slot(2, era), slot(3, era)]) for [`ERAS`].
        slots: [(u64, [u64; 3]); 2],
    }

    /// The literals below were produced by this module's own code when it
    /// was written, from the zero-entropy mnemonic, and pin it against any
    /// change: a new label, another byte order, another kind byte, another
    /// genesis or another seed step each alter at least one line, though
    /// not every line. Each line pins only the steps it passes through: R
    /// is made from W, G and the root's context alone, so a new key or slot
    /// label leaves R's line as it was; a new slot label leaves the key
    /// rows as they were, and a key's new kind byte the slot rows. Era 0 has
    /// the same bytes in either order, so a byte-order slip in the era
    /// changes only the rows at era 123 (the second presence and slot rows,
    /// and the knock), which is why `ERAS` and `KNOCK_ERA` hold 123. The
    /// literals are not an independent implementation's vectors;
    /// `the_derivation_is_the_designs_lines_recomputed_from_their_parts`
    /// checks the lines themselves.
    ///
    /// The network tag (stage 4 design §3.5, PR 6) moved mainnet's P and K
    /// rows and nothing else: P(e) is derived under the listing hint and K(h)
    /// is taken under the inbox hint, and on mainnet both hints now carry G.
    /// Mainnet's P and K rows were printed again by this module's code once
    /// the tag came in; its R and slot rows, and every testnet11 row, are the
    /// literals this module was written with. That only the hints moved them
    /// is `mainnets_keys_moved_only_because_its_hints_carry_the_network_tag`,
    /// which still gives the rows written before the tag from the untagged
    /// hints.
    const PINNED: [Pinned; 2] = [
        Pinned {
            net: ChiaNet::Testnet11,
            root_blake3: "dcca8a816b217d6ff1af841ff8ddfd56dafb223c9bbf72f7b529835d0ec07ab7",
            presence: [
                (
                    0,
                    "abf8bdc90a8eb564f6ac735fb7bd7e9ba496e4f0d644421f135ee5d1c2aca021becff0a888a567e17ab24d5451b5b634",
                    "d37b327279ed142bba54f7e6745d51ea4974f99981ade9a5b228d3360b785eb8",
                ),
                (
                    123,
                    "a248ea255b5ed62dc28aa976fd21c8569f5f1d6c3f740430ea7589d70a0c90a7ed0a55d250b86c1efa5fa32d4620698f",
                    "4bb3302cf8c31f99d47f630dc39b4616ffee1110d9d7265cd7b5956fccfae455",
                ),
            ],
            knock: (
                "b26b159d4dac49021ef3708e1606c0d4238a7100c6054773a89a115e7beaeae7c1695adfe064e0f2a1f1e264c73fe59c",
                "90f96688b85d2675fa7c1b4d04ff5d07d534df58ebc433753f3c87439e445249",
            ),
            slots: [(0, [4522, 2194, 411]), (123, [4394, 350, 1711])],
        },
        Pinned {
            net: ChiaNet::Mainnet,
            root_blake3: "71806cb0747946152a6068a72c465f567c5ac92b2e024d6739c1e4596f6fe6e0",
            presence: [
                (
                    0,
                    "b1f441cf2ae60c161254ad150a6bd68d158426e25396ca2e3f3f4b78a40ed4beb098e9c5320901f3cc0a90885a493615",
                    "0a6d148ba2fa55cecf0cd1a124d7a5fb1f6f00687b88911fe6237d8d897c1e14",
                ),
                (
                    123,
                    "84b0fe3ec28ae7db571cf8a26bea412e810d1c5ba437fd00238f2d3181251029bd8e44ac30173facf5a7ccbaa23623e3",
                    "7fec215c16e131ee5f174aed91763e02eacce94da771ea7a709184b1934cc568",
                ),
            ],
            knock: (
                "a94c0a50fe28625bdf2696c825759d685956e525d77b8b46b1be355d888e876ce75a9acd7f859cf08107e7b103ca39e4",
                "5b8e98594807ed4a9d43fd7a1d140c67dec1ee5faac819212f1b3547b567ddaf",
            ),
            slots: [(0, [2724, 2043, 571]), (123, [1011, 2818, 686])],
        },
    ];

    /// Mainnet's P(e) for [`ERAS`], as (era, public key, puzzle hash), as this
    /// module pinned them before the network tag: what its code gave when
    /// every network's hints were derived without one.
    const MAINNET_P_BEFORE_THE_TAG: [(u64, &str, &str); 2] = [
        (
            0,
            "b689fd04bffab3b6075333fa25deea09c35513be012e473cc3bf503027b57b8cdcef3ceb9b44dc3ca796585d48fd2538",
            "9ea5b8d2c121dce8f5821f8471882d8a2353d8d29418fd84ca1265608c5485da",
        ),
        (
            123,
            "922191345e4d74ecd765c3a5afd9ffd5157e5a1ecbdbab75a231f5bce72b99d71176fa3c7abb8ea59aec024f82be74b8",
            "275c95f3b55920e26e99dab5b7860706d6e0a9410842c172065ae37215e168c0",
        ),
    ];

    /// Mainnet's K(h) for [`KNOCK_ERA`], as (public key, puzzle hash), as this
    /// module pinned it before the network tag, like
    /// [`MAINNET_P_BEFORE_THE_TAG`].
    const MAINNET_K_BEFORE_THE_TAG: (&str, &str) = (
        "b13c599e4d0e320020570676c64ec3566f00ddaa6e632ec975990ee6eb459eeb705b564c84c4885c7c64c8efd943f2fa",
        "78cda1c3990cfde94eae79f40694acb27da1ecc539d4dad7e905a0f1034f8897",
    );

    // --- Derivation (design §12) ---------------------------------------------

    /// §12 Derivation: pinned vectors for R, P(e), K(h) and the slots from
    /// the zero-entropy mnemonic, on both networks.
    #[test]
    fn the_root_keys_and_slots_of_the_zero_mnemonic_match_the_pinned_vectors() {
        let money = zero_money();
        assert_eq!(PINNED.map(|p| p.net), ChiaNet::ALL, "one row per network");
        for p in &PINNED {
            let root = BurnerRoot::of(&money, p.net);
            assert_eq!(blake3::hash(&root.0).to_hex().as_str(), p.root_blake3, "{:?}: R", p.net);
            for (i, (era, pk, ph)) in p.presence.iter().enumerate() {
                assert_eq!(*era, ERAS[i]);
                let key = root.presence(&CK, *era);
                assert_eq!(pk_hex(&key.public_key()), *pk, "{:?}: P({era})'s public key", p.net);
                assert_eq!(ph_hex(key.puzzle_hash()), *ph, "{:?}: P({era})'s puzzle hash", p.net);
            }
            let key = root.knock(&inbox_hint(p.net, &CK_HOST, &ROOM_KEY, KNOCK_ERA), KNOCK_ERA);
            assert_eq!(pk_hex(&key.public_key()), p.knock.0, "{:?}: K(h)'s public key", p.net);
            assert_eq!(ph_hex(key.puzzle_hash()), p.knock.1, "{:?}: K(h)'s puzzle hash", p.net);
            for (i, (era, slots)) in p.slots.iter().enumerate() {
                assert_eq!(*era, ERAS[i]);
                let got = [KIND_PRESENCE, KIND_KNOCK, KIND_BEACON].map(|k| root.slot(k, *era));
                assert_eq!(got, *slots, "{:?}: slot(1..=3, {era})", p.net);
            }
        }
    }

    /// §3.5 moved mainnet's P(e) and K(h) through their hints alone: fed the
    /// hints as they were derived before the tag (the material without G,
    /// recomputed here from the design's contexts), mainnet's root still
    /// gives the keys this module pinned before the tag, so R, key(k, e, h)
    /// and the knock's derivation did not change. testnet11's hints never had
    /// a tag, so its rows in [`PINNED`] are the ones written before it.
    #[test]
    fn mainnets_keys_moved_only_because_its_hints_carry_the_network_tag() {
        let root = BurnerRoot::of(&zero_money(), ChiaNet::Mainnet);
        let untagged = |context: &str, parts: &[&[u8]]| -> [u8; 32] {
            let mut h = blake3::Hasher::new_derive_key(context);
            for p in parts {
                h.update(p);
            }
            h.finalize().into()
        };
        for (i, (era, pk, ph)) in MAINNET_P_BEFORE_THE_TAG.iter().enumerate() {
            assert_eq!(*era, ERAS[i]);
            let hint = untagged("ssf-chia-ck-hint-v1", &[&CK, &era.to_le_bytes()]);
            assert_ne!(hint, chia_lane::derive_ck_hint(ChiaNet::Mainnet, &CK, *era), "mainnet's listing hint carries the tag");
            let key = root.key(KIND_PRESENCE, *era, &hint);
            assert_eq!((pk_hex(&key.public_key()).as_str(), ph_hex(key.puzzle_hash()).as_str()), (*pk, *ph), "P({era}) at the untagged hint");
            assert_ne!(pk_hex(&root.presence(&CK, *era).public_key()).as_str(), *pk, "P({era}) moved with the hint");
        }
        let hint = untagged("ssf-chia-inbox-hint-v1", &[&CK_HOST, &derive_lane_token(&ROOM_KEY), &KNOCK_ERA.to_le_bytes()]);
        assert_ne!(hint, inbox_hint(ChiaNet::Mainnet, &CK_HOST, &ROOM_KEY, KNOCK_ERA), "mainnet's inbox hint carries the tag");
        let key = root.knock(&hint, KNOCK_ERA);
        assert_eq!((pk_hex(&key.public_key()).as_str(), ph_hex(key.puzzle_hash()).as_str()), MAINNET_K_BEFORE_THE_TAG, "K(h) at the untagged hint");
    }

    /// §3.2 line by line: R, key(k, e, h) and slot(k, e) recomputed from
    /// their parts with blake3's incremental hasher, the design's own label
    /// strings and the genesis challenge from the consensus constants, not
    /// from this module's buffers, so a slip in an offset, a length, a byte
    /// order or a label fails here as well as against the pinned literals.
    /// R is compared without being printed.
    #[test]
    fn the_derivation_is_the_designs_lines_recomputed_from_their_parts() {
        assert_eq!((KIND_PRESENCE, KIND_KNOCK, KIND_BEACON), (1, 2, 3), "the kind bytes of §3.2");
        let wallet = keys_from_mnemonic(&zero_words()).wallet;
        let money = MoneyKey::new(wallet.clone());
        for net in ChiaNet::ALL {
            let root = BurnerRoot::of(&money, net);
            let g: [u8; 32] = net.constants().genesis_challenge.to_bytes();
            let r: [u8; 32] =
                blake3::Hasher::new_derive_key("ssf-chia-burner-root-v1").update(&wallet.to_bytes()).update(&g).finalize().into();
            assert!(root.0 == r, "{net:?}: R is not derive_key(\"ssf-chia-burner-root-v1\", W ‖ G)");
            for era in [0u64, 1, 123, 1 << 40, u64::MAX] {
                let hints = [(KIND_PRESENCE, chia_lane::derive_ck_hint(net, &CK, era)), (KIND_KNOCK, inbox_hint(net, &CK_HOST, &ROOM_KEY, era))];
                for (kind, hint) in hints {
                    let seed: [u8; 32] = blake3::Hasher::new_keyed(&r)
                        .update(b"ssf-chia-burner-v1")
                        .update(&[kind])
                        .update(&era.to_le_bytes())
                        .update(&hint)
                        .finalize()
                        .into();
                    let want = SecretKey::from_seed(&seed).public_key();
                    assert_eq!(root.key(kind, era, &hint).public_key(), want, "{net:?}: key({kind}, {era}, h)");
                    let via = if kind == KIND_PRESENCE { root.presence(&CK, era) } else { root.knock(&hint, era) };
                    assert_eq!(via.public_key(), want, "{net:?}: P or K at era {era}");
                }
                for kind in [1u8, 2, 3] {
                    let out: [u8; 32] = blake3::Hasher::new_keyed(&r)
                        .update(b"ssf-chia-burner-slot-v1")
                        .update(&[kind])
                        .update(&era.to_le_bytes())
                        .finalize()
                        .into();
                    let mut first = [0u8; 8];
                    first.copy_from_slice(&out[..8]);
                    assert_eq!(root.slot(kind, era), u64::from_le_bytes(first) % 4_608, "{net:?}: slot({kind}, {era})");
                }
            }
        }
    }

    /// The puzzle hash a burner gives is ph(key) of §3.2: the standard puzzle
    /// of its synthetic key, the way every coin of ours is computed.
    #[test]
    fn a_burners_puzzle_hash_is_the_standard_puzzle_of_its_synthetic_key() {
        let root = BurnerRoot::of(&zero_money(), ChiaNet::Testnet11);
        let key = root.presence(&CK, 0);
        assert_eq!(key.puzzle_hash(), chia_publish::our_puzzle_hash(&key.0));
        let synthetic: Bytes32 = chia_puzzle_types::standard::StandardArgs::curry_tree_hash(key.public_key().derive_synthetic()).into();
        assert_eq!(key.puzzle_hash(), synthetic);
    }

    /// §12 Derivation: different per network, kind, era and hint. Every key
    /// of a small grid is distinct from every other: two networks, three
    /// eras, two contact keys (P), two inbox hints (K), and one hint taken by
    /// both kinds (the same h for kind 1 and kind 2 gives two keys).
    #[test]
    fn keys_differ_per_network_kind_era_and_hint() {
        let money = zero_money();
        let roots: Vec<BurnerRoot> = ChiaNet::ALL.iter().map(|net| BurnerRoot::of(&money, *net)).collect();
        assert!(roots[0].0 != roots[1].0, "a root per network");
        let mut seen: Vec<(String, String)> = Vec::new();
        for (net, root) in ChiaNet::ALL.iter().zip(&roots) {
            for era in [0u64, 1, 2] {
                for ck in [CK, [0x12; 32]] {
                    seen.push((format!("{net:?} P(ck {:02x}, era {era})", ck[0]), pk_hex(&root.presence(&ck, era).public_key())));
                    // The same hint under the other kind.
                    let h = chia_lane::derive_ck_hint(*net, &ck, era);
                    seen.push((format!("{net:?} K(ck hint {:02x}, era {era})", ck[0]), pk_hex(&root.knock(&h, era).public_key())));
                }
                for room in [ROOM_KEY, [0x34; 32]] {
                    let h = inbox_hint(*net, &CK_HOST, &room, era);
                    seen.push((format!("{net:?} K(room {:02x}, era {era})", room[0]), pk_hex(&root.knock(&h, era).public_key())));
                    // The same hint under the other kind, through the private key(k, e, h).
                    seen.push((format!("{net:?} key(1, room {:02x}, era {era})", room[0]), pk_hex(&root.key(KIND_PRESENCE, era, &h).public_key())));
                }
            }
        }
        assert_eq!(seen.len(), 2 * 3 * 8);
        for (i, (a_name, a)) in seen.iter().enumerate() {
            for (b_name, b) in &seen[i + 1..] {
                assert_ne!(a, b, "{a_name} and {b_name} share a key");
            }
        }
    }

    /// §3.3 and §12 Derivation: off m/12381/8444/2/{0..=1000}, hardened and
    /// unhardened, and off the master key, so Sage and the Chia wallet
    /// restoring the same words never list or co-spend a burner coin. A few
    /// P(e) and K(h) on both networks are checked against all 2,002 path keys
    /// and the master, by public key and by puzzle hash (the address Sage
    /// would list). The path keys are made once. The unhardened ones and the
    /// master come from the calls `beacon_key_is_off_the_wallet_path`
    /// (chia_wallet.rs) makes: `master_of`, `master_to_wallet_unhardened`.
    /// The hardened ones come from chia-bls's own intermediate key
    /// (m/12381'/8444'/2', `master_to_wallet_hardened_intermediate`) and one
    /// `derive_hardened` each, which is what `master_to_wallet_hardened` does
    /// after the same three steps; that call is checked to give the same key
    /// at the first four indices and the last two. Each hardened step runs
    /// Chia's Lamport KeyGen, about 13 ms in a debug build, so this keeps the
    /// test near 15 s instead of near a minute.
    #[test]
    fn burner_keys_are_off_every_wallet_path_and_off_the_master() {
        let m = zero_words();
        let master = master_of(&m);
        let hardened_intermediate = master_to_wallet_hardened_intermediate(&master);
        for idx in [0u32, 1, 2, 3, 999, 1000] {
            assert!(
                hardened_intermediate.derive_hardened(idx) == master_to_wallet_hardened(&master, idx),
                "hardened index {idx}: the intermediate key gives master_to_wallet_hardened's key"
            );
        }
        let mut path_pks: HashSet<[u8; 48]> = HashSet::new();
        let mut path_phs: HashSet<Bytes32> = HashSet::new();
        let mut add = |sk: &SecretKey| {
            path_pks.insert(sk.public_key().to_bytes());
            path_phs.insert(chia_publish::our_puzzle_hash(sk));
        };
        add(&master);
        for idx in 0..=1000u32 {
            add(&master_to_wallet_unhardened(&master, idx));
            add(&hardened_intermediate.derive_hardened(idx));
        }
        assert_eq!(path_pks.len(), 1 + 2 * 1001, "the master and 2,002 path keys, all distinct");
        assert_eq!(path_phs.len(), 1 + 2 * 1001);
        let wallet = keys_from_mnemonic(&m).wallet;
        assert!(path_pks.contains(&wallet.public_key().to_bytes()), "the wallet key is index 0, unhardened: the set is the real path");

        let money = MoneyKey::new(wallet);
        let mut checked = 0;
        for net in ChiaNet::ALL {
            let root = BurnerRoot::of(&money, net);
            let mut burners: Vec<(String, BurnerKey)> = Vec::new();
            for era in [0u64, 1, 123, 10_000] {
                burners.push((format!("{net:?} P({era})"), root.presence(&CK, era)));
                for room in [ROOM_KEY, [0x34; 32]] {
                    burners.push((format!("{net:?} K(room {:02x}, {era})", room[0]), root.knock(&inbox_hint(net, &CK_HOST, &room, era), era)));
                }
            }
            for (name, key) in &burners {
                assert!(!path_pks.contains(&key.public_key().to_bytes()), "{name} is a wallet path key or the master");
                assert!(!path_phs.contains(&key.puzzle_hash()), "{name}'s address is a wallet path address");
                checked += 1;
            }
        }
        assert_eq!(checked, 2 * 4 * 3);
    }

    /// §12 Derivation: no burner is the beacon key, and the beacon key is
    /// unchanged: `beacon_wallet_key` of the zero mnemonic's wallet key still
    /// gives the address chia_wallet.rs's `beacon_key_is_off_the_wallet_path`
    /// pinned.
    #[test]
    fn no_burner_is_the_beacon_key_and_the_beacon_key_is_unchanged() {
        let wallet = keys_from_mnemonic(&zero_words()).wallet;
        let beacon = beacon_wallet_key(&wallet);
        assert_eq!(
            receive_address(ChiaNet::Testnet11, &beacon),
            "txch1jmfqazsfj4fh6vldzjnwas0wudfv8fy5d6w7tcd5v3deddmhm9yqravp4u",
            "the value chia_wallet.rs pinned for the beacon key"
        );
        let money = MoneyKey::new(wallet);
        for net in ChiaNet::ALL {
            let root = BurnerRoot::of(&money, net);
            for era in [0u64, 1, 123] {
                for key in [root.presence(&CK, era), root.knock(&inbox_hint(net, &CK_HOST, &ROOM_KEY, era), era)] {
                    assert_ne!(key.public_key(), beacon.public_key(), "{net:?}, era {era}");
                    assert_ne!(key.puzzle_hash(), chia_publish::our_puzzle_hash(&beacon), "{net:?}, era {era}");
                }
            }
        }
        assert_eq!(beacon.public_key(), beacon_wallet_key(money.secret_key()).public_key(), "the money key still gives the same beacon");
    }

    // --- Slots (design §12) --------------------------------------------------

    /// §12 Slots, stable across restarts: a root made again from the same
    /// words, as after a restart, gives the same slots and the same keys.
    #[test]
    fn a_root_made_again_from_the_same_words_gives_the_same_slots_and_keys() {
        for net in ChiaNet::ALL {
            let before = BurnerRoot::of(&zero_money(), net);
            let after = BurnerRoot::of(&zero_money(), net);
            for era in [0u64, 1, 123, 9_999, u64::MAX] {
                for kind in [KIND_PRESENCE, KIND_KNOCK, KIND_BEACON] {
                    assert_eq!(before.slot(kind, era), after.slot(kind, era), "{net:?}: slot({kind}, {era})");
                }
                assert_eq!(before.presence(&CK, era).public_key(), after.presence(&CK, era).public_key(), "{net:?}: P({era})");
                let h = inbox_hint(net, &CK_HOST, &ROOM_KEY, era);
                assert_eq!(before.knock(&h, era).public_key(), after.knock(&h, era).public_key(), "{net:?}: K(h, {era})");
            }
        }
    }

    /// §12 Slots: inside 0 to 4,607 over 10,000 eras, for each kind and both
    /// networks, and spread over the day, not all one value: at least 1,000
    /// distinct slots in 10,000 eras (about 4,080 are expected), and each
    /// eighth of the day holds at least 1,000 of the 10,000 (1,250 are
    /// expected). The sequences also differ per kind and per network.
    #[test]
    fn slots_stay_inside_one_day_of_blocks_and_spread_over_it() {
        assert_eq!(u64::from(ERA_BLOCKS), 7 * SLOT_BLOCKS, "an era is seven slot spans");
        let money = zero_money();
        let mut sequences: Vec<Vec<u64>> = Vec::new();
        for net in ChiaNet::ALL {
            let root = BurnerRoot::of(&money, net);
            for kind in [KIND_PRESENCE, KIND_KNOCK, KIND_BEACON] {
                let slots: Vec<u64> = (0..10_000u64).map(|era| root.slot(kind, era)).collect();
                assert!(slots.iter().all(|s| *s < SLOT_BLOCKS), "{net:?}, kind {kind}: a slot past the day");
                let distinct: HashSet<u64> = slots.iter().copied().collect();
                assert!(distinct.len() >= 1_000, "{net:?}, kind {kind}: only {} distinct slots", distinct.len());
                let mut eighths = [0u32; 8];
                for s in &slots {
                    eighths[(*s * 8 / SLOT_BLOCKS) as usize] += 1;
                }
                assert!(eighths.iter().all(|n| *n >= 1_000), "{net:?}, kind {kind}: {eighths:?}");
                sequences.push(slots);
            }
        }
        for (i, a) in sequences.iter().enumerate() {
            for b in &sequences[i + 1..] {
                assert_ne!(a, b, "two (network, kind) pairs share their slots");
            }
        }
    }

    // --- Types (design §12) --------------------------------------------------

    /// Whether type `$ty` implements trait `$tr`, as a `const bool`, on stable
    /// Rust. A path to an associated const resolves to an inherent impl's
    /// const before a trait's, and the inherent impl below applies only where
    /// the bound holds; where it does not, the blanket trait's `false`
    /// answers. The answer is fixed at compile time, so a `const` assertion
    /// on it fails the build, not a run.
    macro_rules! implements {
        ($ty:ty: $($tr:tt)+) => {{
            #[allow(dead_code)]
            trait DoesNotImplement {
                const IMPLEMENTS: bool = false;
            }
            impl<T: ?Sized> DoesNotImplement for T {}
            #[allow(dead_code)]
            struct Probe<T: ?Sized>(std::marker::PhantomData<T>);
            #[allow(dead_code)]
            impl<T: ?Sized + $($tr)+> Probe<T> {
                const IMPLEMENTS: bool = true;
            }
            <Probe<$ty>>::IMPLEMENTS
        }};
    }

    /// A build-time proof that `$ty` does not implement `$tr`.
    macro_rules! refuted {
        ($ty:ty: $($tr:tt)+) => {
            const _: () = assert!(!implements!($ty: $($tr)+), concat!(stringify!($ty), " must not implement ", stringify!($($tr)+)));
        };
    }

    /// A build-time proof that `$ty` implements `$tr`: the positive controls.
    macro_rules! holds {
        ($ty:ty: $($tr:tt)+) => {
            const _: () = assert!(implements!($ty: $($tr)+), concat!(stringify!($ty), " must implement ", stringify!($($tr)+)));
        };
    }

    /// §3.4 and §12 Types: a `MoneyKey` cannot reach the publisher, whose
    /// entry points take a `BurnerKey` from PR 10, and a `BurnerKey` comes
    /// only from a root. The design asks for a compile-fail doc test. This
    /// crate is a binary with no library target, so rustdoc runs no doc
    /// tests for it, and its lockfile has neither `trybuild` nor
    /// `static_assertions` (no dependency is added for this). So the proof
    /// is made at compile time on stable Rust instead: each line below is a
    /// `const` assertion on the `implements!` probe, and an impl of a form
    /// it lists makes this module fail to build. What it proves is that
    /// list and no more: `From`, `TryFrom`, `Into`, `AsRef`, `Borrow` and
    /// `Deref` between the key types, `SecretKey` and raw bytes, in the
    /// directions and the owned or borrowed forms written below; `FromStr`;
    /// `Default`; the `serde` impls that would read or write a key; `Clone`
    /// and `Copy` of the root; and `Display`. The positive controls show
    /// that the probe answers true where an impl exists, for every trait
    /// form used, so the false answers are not vacuous. No trait bound sees
    /// an inherent constructor, an accessor method or a field's visibility:
    /// `every_line_that_builds_a_key_or_reads_its_secret_is_pinned` covers
    /// those.
    #[test]
    fn a_money_key_cannot_reach_the_publisher() {
        // A money key does not become a burner key, nor give a borrow of one,
        // nor give its SecretKey up through a trait.
        refuted!(BurnerKey: From<MoneyKey>);
        refuted!(BurnerKey: From<&'static MoneyKey>);
        refuted!(BurnerKey: TryFrom<MoneyKey>);
        refuted!(BurnerKey: TryFrom<&'static MoneyKey>);
        refuted!(MoneyKey: Into<BurnerKey>);
        refuted!(&'static MoneyKey: Into<BurnerKey>);
        refuted!(MoneyKey: AsRef<BurnerKey>);
        refuted!(MoneyKey: std::borrow::Borrow<BurnerKey>);
        refuted!(MoneyKey: std::ops::Deref);
        refuted!(MoneyKey: AsRef<SecretKey>);
        refuted!(MoneyKey: std::borrow::Borrow<SecretKey>);
        refuted!(MoneyKey: Into<SecretKey>);
        refuted!(&'static MoneyKey: Into<SecretKey>);
        // Nor the other way, and a burner key gives no SecretKey, owned or
        // borrowed: `From<&BurnerKey> for SecretKey` would let a burner's
        // secret become a `MoneyKey` through `MoneyKey::new`, or reach
        // today's `&SecretKey` signers.
        refuted!(MoneyKey: From<BurnerKey>);
        refuted!(MoneyKey: From<&'static BurnerKey>);
        refuted!(MoneyKey: TryFrom<BurnerKey>);
        refuted!(MoneyKey: TryFrom<&'static BurnerKey>);
        refuted!(BurnerKey: Into<MoneyKey>);
        refuted!(&'static BurnerKey: Into<MoneyKey>);
        refuted!(BurnerKey: AsRef<MoneyKey>);
        refuted!(BurnerKey: std::borrow::Borrow<MoneyKey>);
        refuted!(BurnerKey: std::ops::Deref);
        refuted!(BurnerKey: AsRef<SecretKey>);
        refuted!(BurnerKey: std::borrow::Borrow<SecretKey>);
        refuted!(BurnerKey: Into<SecretKey>);
        refuted!(&'static BurnerKey: Into<SecretKey>);
        refuted!(SecretKey: TryFrom<&'static BurnerKey>);
        // A burner key is made by a root's derivations only: not from a
        // SecretKey, raw bytes, text or a root by conversion.
        refuted!(BurnerKey: From<SecretKey>);
        refuted!(BurnerKey: From<&'static SecretKey>);
        refuted!(BurnerKey: TryFrom<SecretKey>);
        refuted!(BurnerKey: TryFrom<&'static SecretKey>);
        refuted!(BurnerKey: From<[u8; 32]>);
        refuted!(BurnerKey: TryFrom<[u8; 32]>);
        refuted!(BurnerKey: TryFrom<&'static [u8]>);
        refuted!(BurnerKey: std::str::FromStr);
        refuted!(BurnerKey: From<BurnerRoot>);
        refuted!(BurnerKey: Default);
        refuted!(BurnerKey: serde::de::DeserializeOwned);
        refuted!(BurnerKey: serde::Serialize);
        // The root is made from a money key and a network only, is not copied,
        // and gives no accessor of its bytes, owned or borrowed.
        refuted!(BurnerRoot: From<MoneyKey>);
        refuted!(BurnerRoot: From<&'static MoneyKey>);
        refuted!(BurnerRoot: From<[u8; 32]>);
        refuted!(BurnerRoot: TryFrom<[u8; 32]>);
        refuted!(BurnerRoot: TryFrom<&'static [u8]>);
        refuted!(BurnerRoot: std::str::FromStr);
        refuted!(BurnerRoot: Default);
        refuted!(BurnerRoot: Clone);
        refuted!(BurnerRoot: Copy);
        refuted!(BurnerRoot: AsRef<[u8; 32]>);
        refuted!(BurnerRoot: AsRef<[u8]>);
        refuted!(BurnerRoot: std::borrow::Borrow<[u8; 32]>);
        refuted!(BurnerRoot: Into<[u8; 32]>);
        refuted!(&'static BurnerRoot: Into<[u8; 32]>);
        refuted!(BurnerRoot: std::ops::Deref);
        refuted!(BurnerRoot: serde::de::DeserializeOwned);
        refuted!(BurnerRoot: serde::Serialize);
        refuted!(MoneyKey: serde::Serialize);
        // No Display: a key is never shown, only redacted by Debug.
        refuted!(MoneyKey: std::fmt::Display);
        refuted!(BurnerRoot: std::fmt::Display);
        refuted!(BurnerKey: std::fmt::Display);

        // Positive controls: the probe says true where an impl exists, for
        // each trait form above, including on these types themselves.
        holds!(SecretKey: From<SecretKey>);
        holds!(String: From<&'static str>);
        holds!(u8: TryFrom<u32>);
        holds!([u8; 32]: TryFrom<&'static [u8]>);
        holds!(SecretKey: Into<SecretKey>);
        holds!(&'static str: Into<String>);
        holds!(u64: std::str::FromStr);
        holds!(Vec<u8>: AsRef<[u8]>);
        holds!(String: std::borrow::Borrow<str>);
        holds!(Zeroizing<[u8; 32]>: std::ops::Deref);
        holds!([u8; 32]: Default);
        holds!(SecretKey: Clone);
        holds!(ChiaNet: Copy);
        holds!(PublicKey: serde::Serialize);
        holds!(PublicKey: serde::de::DeserializeOwned);
        holds!(u64: std::fmt::Display);
        holds!(MoneyKey: std::fmt::Debug);
        holds!(BurnerRoot: std::fmt::Debug);
        holds!(BurnerKey: std::fmt::Debug);

        // The same answers at run time, so the report shows the test ran.
        assert!(!implements!(BurnerKey: From<MoneyKey>));
        assert!(!implements!(MoneyKey: Into<BurnerKey>));
        assert!(implements!(SecretKey: Into<SecretKey>));
    }

    /// Where this file's test module starts, which the pin scan stops at. In
    /// the file, this literal's `\n` is a backslash and an `n`, not a line
    /// break, so the literal does not match itself.
    const TESTS_START: &str = "\n#[cfg(test)]\nmod tests {";

    /// The lines of `file`, this file's text, that
    /// `every_line_that_builds_a_key_or_reads_its_secret_is_pinned` pins,
    /// each with the impl and fn it sits in, in file order. The line ends
    /// are made LF before anything is matched: Git for Windows with
    /// `core.autocrlf=true` checks this file out with CRLF ends (the repo
    /// has no `.gitattributes`), `include_str!` keeps them, and
    /// `TESTS_START` and the pinned lines are LF text, so every comparison
    /// here sees LF text on either checkout.
    fn lines_that_build_a_key_or_read_its_secret(file: &str) -> Vec<(String, String)> {
        const MARKS: [&str; 12] =
            ["SecretKey", "MoneyKey(", "MoneyKey)", "BurnerRoot(", "BurnerRoot)", "BurnerKey(", "BurnerKey)", "Self(", "Self {", "0:", ".0", "unsafe"];
        let file = file.replace("\r\n", "\n");
        assert_eq!(file.matches(TESTS_START).count(), 1, "one test module, after the code it scans");
        let (code, _) = file.split_once(TESTS_START).unwrap();

        // An item is a line that starts at the first column; a fn is the
        // last `fn` line seen inside it.
        let (mut item, mut func) = (String::new(), String::new());
        let mut found: Vec<(String, String)> = Vec::new();
        for raw in code.lines() {
            let line = raw.split("//").next().unwrap_or("");
            let text = line.trim();
            if text.is_empty() {
                continue;
            }
            if !line.starts_with(char::is_whitespace) && text != "}" {
                item = text.trim_end_matches(" {").to_string();
                func.clear();
            }
            for head in ["fn ", "pub fn ", "pub(crate) fn "] {
                if let Some(rest) = text.strip_prefix(head) {
                    func = rest.split(['(', '<']).next().unwrap_or("").to_string();
                }
            }
            if MARKS.iter().any(|m| text.contains(m)) {
                let place = if func.is_empty() { String::new() } else { format!("{item}, fn {func}") };
                found.push((place, text.to_string()));
            }
        }
        found
    }

    /// §3.4 and §12 Types, the half no trait bound can see. The fields of
    /// `MoneyKey`, `BurnerRoot` and `BurnerKey` are private, so outside this
    /// file safe code can build one only through the functions here, and
    /// cannot read its secret. This test reads this file's own text before
    /// its tests, with its line ends made LF and its comments dropped
    /// (`lines_that_build_a_key_or_read_its_secret`), and pins each line
    /// that could build a key or let a secret out, with the impl and fn it
    /// sits in: a line that names `SecretKey`; names a key type before `(`
    /// or `)` (a tuple struct's name is also its constructor, as in
    /// `BurnerKey(sk)` or `.map(BurnerKey)`); builds through `Self` or a
    /// `0:` field; reads a `.0` field; or uses `unsafe` (a `transmute`
    /// builds anything). So the three fields stay private, a `BurnerKey` is
    /// built only in
    /// `BurnerRoot::key`, a root only in `BurnerRoot::of` and a `MoneyKey`
    /// only in `MoneyKey::new`, and a secret is read only by those two
    /// derivations, `MoneyKey::secret_key`, the burner's public key, puzzle
    /// hash and signer, the redacted Debug and the wipe. A new constructor,
    /// accessor or field visibility changes the list and fails here until it
    /// is pinned on purpose. The beacon's
    /// `BurnerKey` (§3.4, PR 10) will be such a line: B is
    /// `beacon_wallet_key(W)` (§3.2), a derivation from the `MoneyKey`, not
    /// a constructor from any `SecretKey`. The scan reads text, not the
    /// parsed program: it pins what is written here, for a reviewer to check
    /// against the design, and would not see a name a macro pastes together.
    #[test]
    fn every_line_that_builds_a_key_or_reads_its_secret_is_pinned() {
        const PINNED_LINES: [(&str, &str); 20] = [
            ("", "use chia_bls::{PublicKey, SecretKey};"),
            ("", "pub struct MoneyKey(SecretKey);"),
            ("impl MoneyKey, fn new", "pub(crate) fn new(wallet: SecretKey) -> MoneyKey {"),
            ("impl MoneyKey, fn new", "MoneyKey(wallet)"),
            ("impl MoneyKey, fn secret_key", "pub(crate) fn secret_key(&self) -> &SecretKey {"),
            ("impl MoneyKey, fn secret_key", "&self.0"),
            ("impl fmt::Debug for MoneyKey, fn fmt", "f.write_str(\"MoneyKey(..)\")"),
            ("", "pub struct BurnerRoot([u8; 32], ChiaNet);"),
            ("impl BurnerRoot, fn of", "let w = Zeroizing::new(money.0.to_bytes());"),
            ("impl BurnerRoot, fn of", "BurnerRoot(blake3::derive_key(CTX_ROOT, &material[..]), net)"),
            ("impl BurnerRoot, fn key", "let seed = Zeroizing::new(blake3::keyed_hash(&self.0, &msg));"),
            ("impl BurnerRoot, fn key", "BurnerKey(SecretKey::from_seed(seed.as_bytes()))"),
            ("impl BurnerRoot, fn slot", "let out = Zeroizing::new(blake3::keyed_hash(&self.0, &msg));"),
            ("impl Drop for BurnerRoot, fn drop", "self.0.zeroize();"),
            ("impl fmt::Debug for BurnerRoot, fn fmt", "f.write_str(\"BurnerRoot(..)\")"),
            ("", "pub struct BurnerKey(SecretKey);"),
            ("impl BurnerKey, fn public_key", "self.0.public_key()"),
            ("impl BurnerKey, fn puzzle_hash", "chia_publish::our_puzzle_hash(&self.0)"),
            ("impl BurnerKey, fn sign_spends", "chia_publish::sign_standard_spends(net, &self.0, coin_spends)"),
            (
                "impl fmt::Debug for BurnerKey, fn fmt",
                "f.debug_struct(\"BurnerKey\").field(\"fingerprint\", &self.0.public_key().get_fingerprint()).finish_non_exhaustive()",
            ),
        ];
        let found = lines_that_build_a_key_or_read_its_secret(include_str!("chia_burner.rs"));
        let found: Vec<(&str, &str)> = found.iter().map(|(p, t)| (p.as_str(), t.as_str())).collect();
        let new: Vec<_> = found.iter().filter(|l| !PINNED_LINES.contains(l)).collect();
        let gone: Vec<_> = PINNED_LINES.iter().filter(|l| !found.contains(l)).collect();
        assert!(
            new.is_empty() && gone.is_empty(),
            "the lines that build a key or read its secret changed: pin the new list only once a review agrees \
             that no money key becomes a BurnerKey and no burner secret leaves one (§3.4)\nnew: {new:#?}\ngone: {gone:#?}"
        );
        assert_eq!(found, PINNED_LINES.to_vec(), "the pinned lines, in another order or another number");
    }

    /// The pin scan on a Windows checkout: this file's text with CRLF line
    /// ends, as Git for Windows with `core.autocrlf=true` writes it, gives
    /// the same lines as with LF ends, so the pin test above passes on
    /// either checkout. The CRLF text is made here from the file's own
    /// text, so this runs on every platform. The control: the CRLF text
    /// does not hold `TESTS_START` as it stands, so matching it unchanged
    /// would find no test module.
    #[test]
    fn the_pinned_lines_are_the_same_with_crlf_line_ends() {
        let file = include_str!("chia_burner.rs");
        let lf = file.replace("\r\n", "\n");
        let crlf = lf.replace('\n', "\r\n");
        assert!(crlf.contains("\r\n") && !crlf.contains(TESTS_START), "the control: the CRLF text does not hold the LF marker");
        let from_lf = lines_that_build_a_key_or_read_its_secret(&lf);
        assert!(!from_lf.is_empty(), "the scan finds the pinned lines");
        assert_eq!(lines_that_build_a_key_or_read_its_secret(file), from_lf, "the checkout's own text and its LF form");
        assert_eq!(lines_that_build_a_key_or_read_its_secret(&crlf), from_lf, "CRLF line ends change the pinned lines");
    }

    /// §12 Types: a burner signs a spend of its own coin, for each network,
    /// and the signature verifies under that network's constants; a spend
    /// of a money coin, which asks for the money key's signature, is refused.
    #[test]
    fn a_burner_signs_its_own_coins_spend_and_refuses_a_money_coins() {
        let money = zero_money();
        for net in ChiaNet::ALL {
            let root = BurnerRoot::of(&money, net);
            let key = root.presence(&CK, 0);
            let spend_of = |pk: PublicKey, ph: Bytes32| {
                let mut ctx = SpendContext::new();
                let coin = Coin::new(Bytes32::new([3u8; 32]), ph, 1);
                let memos = ctx.memos(&(Bytes32::new([4u8; 32]), (Bytes::new(vec![1, 2, 3]), ()))).unwrap();
                let conditions = Conditions::new().create_coin(ph, 1, memos);
                StandardLayer::new(pk.derive_synthetic()).spend(&mut ctx, coin, conditions).unwrap();
                ctx.take()
            };
            let bundle = key.sign_spends(net, spend_of(key.public_key(), key.puzzle_hash())).unwrap();
            let mut a = Allocator::new();
            let required = RequiredSignature::from_coin_spends(&mut a, &bundle.coin_spends, &AggSigConstants::from(net.constants())).unwrap();
            let pairs: Vec<(PublicKey, Vec<u8>)> = required
                .iter()
                .map(|r| match r {
                    RequiredSignature::Bls(bls) => (bls.public_key, bls.message()),
                    RequiredSignature::Secp(_) => panic!("no secp on a standard spend"),
                })
                .collect();
            assert_eq!(pairs.len(), 1, "{net:?}: one signature, the burner's");
            assert_eq!(pairs[0].0, key.public_key().derive_synthetic(), "{net:?}");
            assert!(chia_bls::aggregate_verify(&bundle.aggregated_signature, pairs), "{net:?}: the signature verifies");

            let wallet = money.secret_key();
            let refused = key.sign_spends(net, spend_of(wallet.public_key(), chia_publish::our_puzzle_hash(wallet)));
            assert!(refused.is_err(), "{net:?}: a burner signed for a money coin");
        }
    }

    /// §3.4: Debug is redacted for all three types. Each one's Debug is the
    /// fixed text below, holds neither the secret's hex (either case) nor its
    /// bytes as an array, and has no run of 64 hex digits at all (32 bytes
    /// in hex, whatever their order). The secret is read from the private
    /// field, which only this module's tests can reach. `SecretKey`'s own
    /// Debug, which prints its key, is the control that the checks see a leak.
    #[test]
    fn debug_of_every_key_type_is_redacted() {
        fn longest_hex_run(s: &str) -> usize {
            s.split(|c: char| !c.is_ascii_hexdigit()).map(str::len).max().unwrap_or(0)
        }
        fn assert_redacted(dbg: &str, secret: &[u8; 32], what: &str) {
            assert!(!dbg.contains(&hex::encode(secret)), "{what}: Debug shows the secret's hex");
            assert!(!dbg.contains(&hex::encode_upper(secret)), "{what}: Debug shows the secret's hex");
            assert!(!dbg.contains(&format!("{secret:?}")), "{what}: Debug shows the secret's bytes");
            assert!(longest_hex_run(dbg) < 64, "{what}: Debug holds a 64-hex-digit run");
        }
        let money = zero_money();
        assert!(format!("{:?}", money.0).contains(&hex::encode(money.0.to_bytes())), "the control: SecretKey's own Debug prints its key");
        assert!(longest_hex_run(&format!("{:?}", money.0)) >= 64, "the control: the run check sees it");

        assert_eq!(format!("{money:?}"), "MoneyKey(..)");
        assert_redacted(&format!("{money:?}"), &money.0.to_bytes(), "MoneyKey");
        for net in ChiaNet::ALL {
            let root = BurnerRoot::of(&money, net);
            assert_eq!(format!("{root:?}"), "BurnerRoot(..)");
            assert_eq!(format!("{root:#?}"), "BurnerRoot(..)");
            assert_redacted(&format!("{root:?}"), &root.0, "BurnerRoot");
            for key in [root.presence(&CK, 0), root.knock(&inbox_hint(net, &CK_HOST, &ROOM_KEY, 0), 0)] {
                let dbg = format!("{key:?}");
                assert_eq!(dbg, format!("BurnerKey {{ fingerprint: {}, .. }}", key.public_key().get_fingerprint()));
                assert_redacted(&dbg, &key.0.to_bytes(), "BurnerKey");
                assert_redacted(&format!("{key:#?}"), &key.0.to_bytes(), "BurnerKey, pretty");
            }
        }
    }

    /// §3.2 ("memory only") and §3.4: a dropped root is wiped. The root's
    /// destructor is run in place through `ManuallyDrop`, and its bytes are
    /// read afterwards: all zero. This is defined behaviour, not a read of
    /// freed memory: `ManuallyDrop::drop` leaves the value's memory where it
    /// was, changed only by the destructor, and `[u8; 32]` has no invalid
    /// bit pattern. The root is never dropped a second time, nor used as a
    /// root again.
    #[test]
    fn a_dropped_root_is_wiped() {
        assert!(std::mem::needs_drop::<BurnerRoot>(), "the root has a destructor");
        let mut root = std::mem::ManuallyDrop::new(BurnerRoot::of(&zero_money(), ChiaNet::Testnet11));
        assert!(root.0 != [0u8; 32], "a root is not all zero before it is dropped");
        // SAFETY: `root` is dropped exactly once, here; `ManuallyDrop` keeps it
        // from being dropped again at the end of scope. After the destructor
        // its memory is still this frame's and still initialised (the
        // destructor only writes zeros), so reading the bytes is defined.
        unsafe { std::mem::ManuallyDrop::drop(&mut root) };
        assert!(root.0 == [0u8; 32], "the destructor left R's bytes behind");
    }
}
