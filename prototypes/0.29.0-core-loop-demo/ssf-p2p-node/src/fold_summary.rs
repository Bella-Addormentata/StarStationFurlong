//! What the bundled fold says of a table (foldEntry.ts `result`), as the node reads it: the engine's answer
//! ([`crate::house_fold`]), the worker's (`--fold-worker`), the shadow's latest answer for a FAIR ONLY game, and what
//! the house signs a game's checkpoint from. Built in every build: the house reads it whether or not the node can fold.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

/// What the bundle's `result()` says of a table (foldEntry.ts `result`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FoldSummary {
    pub v: i64,
    /// The rule set the table was folded by (`house_fold::rules_id`).
    pub rules: Option<String>,
    pub base: BaseSummary,
    pub rounds: Vec<RoundSummary>,
    /// The round of the undecided chosen close, if any.
    pub tip: Option<i64>,
    pub open: i64,
    pub parent: String,
    #[serde(rename = "houseTable")]
    pub house_table: bool,
    /// The house commitment a close of the open round must name.
    pub required: Option<String>,
    pub joins: Vec<String>,
    /// pid → net, decimal, sorted by pid.
    pub nets: Vec<(String, String)>,
    pub held: Vec<(String, String)>,
    /// The game's carried state after the last decided round (null at roulette).
    pub carry: serde_json::Value,
    pub pending: bool,
    pub records: i64,
    pub bytes: i64,
    #[serde(rename = "rawBytes")]
    pub raw_bytes: i64,
    /// 🔒 A FAIR ONLY game's only (none elsewhere): the weight of the records
    /// the fold used, and of the open round's felts among them.
    #[serde(default)]
    pub kept: Option<i64>,
    #[serde(default, rename = "feltBytes")]
    pub felt_bytes: Option<i64>,
    /// 🔒 How many felts the open round has.
    #[serde(default)]
    pub felts: Option<i64>,
    /// 🔒 The keys of the open round's felts whose seed is not out: what a trim
    /// or a sweep carries into the session it opens. Sorted.
    #[serde(default, rename = "carryFelts")]
    pub carry_felts: Option<Vec<String>>,
    /// 🔒 The closes of the open round that are not invalid, by hash.
    #[serde(default, rename = "openCloses")]
    pub open_closes: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BaseSummary {
    pub sid: String,
    pub u: i64,
    pub l: Option<String>,
    pub n: Vec<(String, String)>,
    pub ended: bool,
    pub h: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoundSummary {
    pub r: i64,
    pub close: String,
    /// "reveals", "forfeit", "house" or "void"; null while undecided.
    pub decided: Option<String>,
    pub counted: Vec<String>,
    pub pocket: Option<i64>,
    pub deltas: Vec<(String, String)>,
    pub house: Option<String>,
    pub forfeit: Option<String>,
    pub abandon: Option<String>,
    pub copies: Option<Vec<String>>,
    pub dice: Option<[i64; 2]>,
    /// 🔒 A FAIR ONLY game's only: the frozen slips the round is missing (sorted).
    #[serde(default)]
    pub missing: Option<Vec<String>>,
    /// 🔒 A FAIR ONLY craps game's only: the roll ended the hand.
    #[serde(default, rename = "sevenOut")]
    pub seven_out: Option<bool>,
}

/// 🔒 The latest answer of the fold for a FAIR ONLY game that was the game as the mirror had last read it: of the last
/// frame sent, which carried the houses by round of the plan of its tick, with nothing left to send or to read, on the
/// plan's base, and finished (no signature left unchecked). What the house's trim of the game goes by.
#[derive(Clone, Debug, PartialEq)]
pub struct GameAnswer {
    /// The base it was folded on (the doc key of its checkpoint) and the id of the session that follows it.
    pub base_key: String,
    pub sid: String,
    /// The houses by round it was folded under (the plan's of its tick): a trim goes by an answer under the houses
    /// it would sign under.
    pub spans: Vec<(String, i64, Option<i64>)>,
    /// The session's records it was folded from ([`records_digest`] of their keys): the house signs from it only while
    /// its own read of the session holds the same.
    pub digest: String,
    /// Which taking up of the game by the mirror, and which frame of the worker's, it is the answer of.
    pub born: u64,
    pub frame: u64,
    pub summary: FoldSummary,
}

/// 🔒 The digest of a session's records, by their keys, given in order (sorted, no repeats): a record of a FAIR ONLY game's
/// session sits under a key that names its round, its player where it has one, and the hash of its body
/// (`house::own_record`), so two sessions with the same keys under which each holds its own record hold the same records.
/// Sorted keys hashed whole, each with a line end: no set of keys added can leave it as it was.
pub fn records_digest<'a>(keys: impl IntoIterator<Item = &'a str>) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for k in keys {
        h.update(k.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

/// 🔒 The shadow's latest answer for each FAIR ONLY game, by room, table and incarnation, where the house reads it: the
/// shadow puts its answers here after each pass, the house takes what it signs from. Its own lock, under which no other
/// is taken (the shadow's pass locks the house inside its own: the house never locks the shadow).
pub type GameAnswers = Arc<Mutex<BTreeMap<(String, String, String), GameAnswer>>>;
