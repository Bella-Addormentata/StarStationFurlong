//! 🏠 The house's bytes (PR 5 of "Computed casino tables").
//!
//! What the pages' computed-table fold (src/computedFold.ts) and the house's
//! room records (src/computedHouse.ts) compute, byte for byte, so the node's
//! house job (`house.rs`) reads a house table's records as every page reads
//! them and writes its own as every page expects: canonical JSON, record
//! hashes, signed bytes, session ids, close ranks, seed commitments, and the
//! house's own key, seeds and signatures. Checked against
//! `test-vectors/computed-house-v1.json`, which the TypeScript side writes
//! (src/computedHouseVectors.test.ts) and checks too.

use base64::Engine;
use iroh::{PublicKey, SecretKey, Signature};
use sha2::{Digest, Sha256};

/// A record value as canon reads it: a string, a SAFE integer, an array, a
/// plain object, an undefined field (skipped), or anything else (`Junk`: a
/// float, a boolean, null, a bigint, a buffer), which makes the whole value
/// junk, as computedFold canon's `null` does.
#[derive(Clone, Debug, PartialEq)]
pub enum CVal {
    Str(String),
    Int(i64),
    Arr(Vec<CVal>),
    Obj(Vec<(String, CVal)>),
    Undef,
    Junk,
}

/// Number.MAX_SAFE_INTEGER.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn number(f: f64) -> CVal {
    if f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE {
        CVal::Int(f as i64)
    } else {
        CVal::Junk
    }
}

impl CVal {
    /// From a JSON value (the test vectors, the house's state file).
    pub fn from_json(v: &serde_json::Value) -> CVal {
        use serde_json::Value;
        match v {
            Value::String(s) => CVal::Str(s.clone()),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    if (i as f64).abs() <= MAX_SAFE { CVal::Int(i) } else { CVal::Junk }
                } else if n.as_u64().is_some() {
                    CVal::Junk
                } else {
                    number(n.as_f64().unwrap_or(f64::NAN))
                }
            }
            Value::Array(a) => CVal::Arr(a.iter().map(CVal::from_json).collect()),
            Value::Object(o) => CVal::Obj(o.iter().map(|(k, v)| (k.clone(), CVal::from_json(v))).collect()),
            Value::Bool(_) | Value::Null => CVal::Junk,
        }
    }

    /// From a Yjs value (a record as the room's doc holds it). Yjs writes a
    /// JS number as an integer or a float, and either reads back as
    /// `Number`; a JS bigint is `BigInt`, which canon refuses.
    pub fn from_any(v: &yrs::Any) -> CVal {
        use yrs::Any;
        match v {
            Any::String(s) => CVal::Str(s.to_string()),
            Any::Number(f) => number(*f),
            Any::Array(a) => CVal::Arr(a.iter().map(CVal::from_any).collect()),
            Any::Map(m) => CVal::Obj(m.iter().map(|(k, v)| (k.clone(), CVal::from_any(v))).collect()),
            Any::Undefined => CVal::Undef,
            Any::Null | Any::Bool(_) | Any::BigInt(_) | Any::Buffer(_) => CVal::Junk,
        }
    }

    /// The field `k` of an object (None for another value, or no such field).
    pub fn get(&self, k: &str) -> Option<&CVal> {
        match self {
            CVal::Obj(fields) => fields.iter().find(|(name, v)| name == k && *v != CVal::Undef).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            CVal::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            CVal::Int(i) => Some(*i),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[CVal]> {
        match self {
            CVal::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// The object's own fields that aren't undefined.
    pub fn fields(&self) -> Option<Vec<&(String, CVal)>> {
        match self {
            CVal::Obj(fields) => Some(fields.iter().filter(|(_, v)| *v != CVal::Undef).collect()),
            _ => None,
        }
    }

    /// The same object without field `k` (what a signature covers: all but `g`).
    pub fn without(&self, k: &str) -> CVal {
        match self {
            CVal::Obj(fields) => CVal::Obj(fields.iter().filter(|(name, _)| name != k).cloned().collect()),
            other => other.clone(),
        }
    }
}

/// JSON.stringify of a string: `"` and `\` escaped, \b \t \n \f \r short, any
/// other control character as \u00xx (lowercase), everything else as it is.
fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn canon_into(out: &mut String, v: &CVal) -> bool {
    match v {
        CVal::Str(s) => json_str(out, s),
        CVal::Int(i) => out.push_str(&i.to_string()),
        CVal::Arr(items) => {
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                // An undefined array entry is junk (JSON has no hole).
                if *item == CVal::Undef || !canon_into(out, item) {
                    return false;
                }
            }
            out.push(']');
        }
        CVal::Obj(fields) => {
            // Object.keys(v).sort(): by UTF-16 code units, not bytes.
            let mut keys: Vec<&(String, CVal)> = fields.iter().filter(|(_, v)| *v != CVal::Undef).collect();
            keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (n, (k, item)) in keys.into_iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                json_str(out, k);
                out.push(':');
                if !canon_into(out, item) {
                    return false;
                }
            }
            out.push('}');
        }
        CVal::Undef | CVal::Junk => return false,
    }
    true
}

/// computedFold canon: sorted-key JSON, or None for junk.
pub fn canon(v: &CVal) -> Option<String> {
    let mut out = String::new();
    canon_into(&mut out, v).then_some(out)
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn sha256_hex(s: &str) -> String {
    hex::encode(sha256(s.as_bytes()))
}

/// computedFold recHash: the first 32 hex of sha256('ssf-ct-rec-v1|' + canon).
pub fn rec_hash(v: &CVal) -> Option<String> {
    canon(v).map(|c| hash_of_canon(&c))
}

pub fn hash_of_canon(c: &str) -> String {
    sha256_hex(&format!("ssf-ct-rec-v1|{c}"))[..32].to_string()
}

/// One computed table: the room, the table's id, the incarnation.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Ctx {
    pub room: String,
    pub t: String,
    pub inc: String,
}

impl Ctx {
    /// computedFold seedTable: `ct:<t>:<inc>`.
    pub fn seed_table(&self) -> String {
        format!("ct:{}:{}", self.t, self.inc)
    }
}

/// computedFold signBytes: sha256(`ssf-ct-v1|<kind>|<room>|<t>|<inc>|` +
/// canon(body without g)); None for a body canon refuses.
pub fn sign_bytes(kind: &str, ctx: &Ctx, body: &CVal) -> Option<[u8; 32]> {
    let c = canon(&body.without("g"))?;
    Some(sha256(format!("ssf-ct-v1|{kind}|{}|{}|{}|{c}", ctx.room, ctx.t, ctx.inc).as_bytes()))
}

/// computedHouse roomSignBytes: sha256(`ssf-ct-v1|<kind>|<room>|<t>|` +
/// canon(body without g)).
pub fn room_sign_bytes(kind: &str, room: &str, t: &str, body: &CVal) -> Option<[u8; 32]> {
    let c = canon(&body.without("g"))?;
    Some(sha256(format!("ssf-ct-v1|{kind}|{room}|{t}|{c}").as_bytes()))
}

/// computedFold nextSid: 'g' with no checkpoint, else the first 24 hex of
/// sha256('ssf-ct-sid-v1|' + canon({t, inc, b, u, l, n, e, s, h})).
pub fn next_sid(ctx: &Ctx, cp: Option<&CVal>) -> Option<String> {
    let Some(cp) = cp else { return Some("g".into()) };
    let mut fields = vec![("t".to_string(), CVal::Str(ctx.t.clone())), ("inc".to_string(), CVal::Str(ctx.inc.clone()))];
    for k in ["b", "u", "l", "n", "e", "s", "h"] {
        if let Some(v) = cp.get(k) {
            fields.push((k.to_string(), v.clone()));
        }
    }
    let c = canon(&CVal::Obj(fields))?;
    Some(sha256_hex(&format!("ssf-ct-sid-v1|{c}"))[..24].to_string())
}

/// computedFold dutyRank: sha256 hex of `ssf-ct-rank-v1|<duty>|<room>|<t>|<inc>|<round>|<pub>`.
pub fn duty_rank(duty: &str, ctx: &Ctx, round: i64, pub_key: &str) -> String {
    sha256_hex(&format!("ssf-ct-rank-v1|{duty}|{}|{}|{}|{round}|{pub_key}", ctx.room, ctx.t, ctx.inc))
}

/// computedFold slipCommit: sha256 hex of diceFairness tableCommitMessage
/// (`ssf-table-commit-v3|room|table|round|party|house|seed`, house '').
pub fn slip_commit(ctx: &Ctx, r: i64, party: &str, seed: &str) -> String {
    sha256_hex(&format!("ssf-table-commit-v3|{}|{}|{r}|{party}||{seed}", ctx.room, ctx.seed_table()))
}

/// computedFold houseCommitOf: the slip commitment with an empty party.
pub fn house_commit(ctx: &Ctx, r: i64, seed: &str) -> String {
    slip_commit(ctx, r, "", seed)
}

// ── Keys and signatures ──────────────────────────────────────────────────────

/// blake3 derive_key contexts (computedHouse.ts uses the same strings).
pub const HOUSE_KEY_CONTEXT: &str = "ssf-house-key-v1";
pub const HOUSE_SEED_KEY_CONTEXT: &str = "ssf-house-seed-key-v1";

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// base64url as the pages spell it (keypair.ts strictB64): exactly `len`
/// bytes and the one canonical spelling of them, else None.
pub fn b64url_strict(s: &str, len: usize) -> Option<Vec<u8>> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()?;
    (bytes.len() == len && b64url(&bytes) == s).then_some(bytes)
}

/// The house's key, derived from the node's own secret key: a key of its own
/// so the house signs nothing the node's identity would.
pub struct HouseKey {
    secret: SecretKey,
    seed_key: [u8; 32],
    pub public: String,
}

impl HouseKey {
    pub fn from_node_secret(node_secret: &[u8; 32]) -> Self {
        let secret = SecretKey::from_bytes(&blake3::derive_key(HOUSE_KEY_CONTEXT, node_secret));
        let public = b64url(secret.public().as_bytes());
        Self { secret, seed_key: blake3::derive_key(HOUSE_SEED_KEY_CONTEXT, node_secret), public }
    }

    /// computedHouse houseSeedOf: the house's seed for round r of a table.
    pub fn seed(&self, ctx: &Ctx, r: i64) -> String {
        let msg = format!("ssf-house-seed-v1|{}|{}|{}|{r}", ctx.room, ctx.t, ctx.inc);
        blake3::keyed_hash(&self.seed_key, msg.as_bytes()).to_hex().to_string()
    }

    /// An ed25519 signature (base64url) over signed bytes.
    pub fn sign(&self, bytes: &[u8]) -> String {
        b64url(&self.secret.sign(bytes).to_bytes())
    }
}

/// Whether `sig` (base64url) is `pub_key`'s (base64url) over `bytes`. Strict,
/// as the node verifies anything (ed25519 verify_strict); the pages' noble
/// check accepts a few signatures this refuses (a torsion component in R),
/// none of which an honest page writes.
pub fn verify(pub_key: &str, bytes: &[u8], sig: &str) -> bool {
    let (Some(pk), Some(sg)) = (b64url_strict(pub_key, 32), b64url_strict(sig, 64)) else { return false };
    let Ok(pk) = PublicKey::from_bytes(&pk.try_into().unwrap()) else { return false };
    let sg: [u8; 64] = sg.try_into().unwrap();
    pk.verify(bytes, &Signature::from_bytes(&sg)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors/computed-house-v1.json");

    fn load() -> Value {
        let raw = std::fs::read_to_string(VECTORS).unwrap_or_else(|e| panic!("cannot read {VECTORS}: {e}"));
        serde_json::from_str(&raw).expect("vector file is valid JSON")
    }

    fn ctx_of(v: &Value) -> Ctx {
        Ctx {
            room: v["room"].as_str().unwrap().into(),
            t: v["t"].as_str().unwrap().into(),
            inc: v["inc"].as_str().unwrap().into(),
        }
    }

    #[test]
    fn canon_and_hashes_match_typescript() {
        let v = load();
        let cases = v["canon"].as_array().unwrap();
        assert!(cases.len() >= 20);
        for case in cases {
            let val = CVal::from_json(&case["value"]);
            assert_eq!(canon(&val).as_deref(), case["canon"].as_str(), "canon of {}", case["value"]);
            assert_eq!(rec_hash(&val).as_deref(), case["hash"].as_str(), "hash of {}", case["value"]);
        }
    }

    #[test]
    fn signed_bytes_keys_and_ranks_match_typescript() {
        let v = load();
        for r in v["sessionRecords"].as_array().unwrap().iter().chain(v["houseRecords"].as_array().unwrap()) {
            let ctx = if r["ctx"].is_object() { ctx_of(&r["ctx"]) } else { ctx_of(&serde_json::json!({"room": "room-test", "t": "roulette-1", "inc": "r0123456789abcdef01234567"})) };
            let body = CVal::from_json(&r["value"]);
            let kind = r["kind"].as_str().unwrap();
            assert_eq!(hex::encode(sign_bytes(kind, &ctx, &body).unwrap()), r["bytes"].as_str().unwrap(), "{kind} bytes");
            let key = r["key"].as_str().unwrap();
            assert!(key.ends_with(&rec_hash(&body).unwrap()), "{key}");
            let k = body.get("k").and_then(CVal::as_str).unwrap();
            let g = body.get("g").and_then(CVal::as_str).unwrap();
            assert!(verify(k, &hex::decode(r["bytes"].as_str().unwrap()).unwrap(), g), "{kind} signature");
            if let Some(rank) = r["rank"].as_str() {
                assert_eq!(duty_rank("close", &ctx, body.get("r").and_then(CVal::as_int).unwrap(), k), rank);
            }
        }
        for r in v["roomRecords"].as_array().unwrap() {
            let body = CVal::from_json(&r["value"]);
            let (kind, t) = (r["kind"].as_str().unwrap(), r["t"].as_str().unwrap());
            let bytes = room_sign_bytes(kind, "room-test", t, &body).unwrap();
            assert_eq!(hex::encode(bytes), r["bytes"].as_str().unwrap(), "{kind} bytes");
            let k = body.get("k").and_then(CVal::as_str).unwrap();
            assert!(verify(k, &bytes, body.get("g").and_then(CVal::as_str).unwrap()), "{kind} signature");
        }
    }

    #[test]
    fn session_ids_and_commitments_match_typescript() {
        let v = load();
        for s in v["sids"].as_array().unwrap() {
            let cp = if s["cp"].is_null() { None } else { Some(CVal::from_json(&s["cp"])) };
            assert_eq!(next_sid(&ctx_of(&s["ctx"]), cp.as_ref()).unwrap(), s["sid"].as_str().unwrap());
        }
        for c in v["commits"].as_array().unwrap() {
            let (r, party, seed) = (c["r"].as_i64().unwrap(), c["party"].as_str().unwrap(), c["seed"].as_str().unwrap());
            assert_eq!(slip_commit(&ctx_of(&c["ctx"]), r, party, seed), c["commit"].as_str().unwrap());
        }
    }

    #[test]
    fn house_keys_seeds_and_signatures_match_typescript() {
        let v = load();
        for h in v["houses"].as_array().unwrap() {
            let secret: [u8; 32] = hex::decode(h["nodeSecret"].as_str().unwrap()).unwrap().try_into().unwrap();
            let key = HouseKey::from_node_secret(&secret);
            assert_eq!(key.public, h["pub"].as_str().unwrap());
            for s in h["seeds"].as_array().unwrap() {
                assert_eq!(key.seed(&ctx_of(&s["ctx"]), s["r"].as_i64().unwrap()), s["seed"].as_str().unwrap());
            }
            let msg = hex::decode(h["sign"]["bytes"].as_str().unwrap()).unwrap();
            assert_eq!(key.sign(&msg), h["sign"]["sig"].as_str().unwrap());
        }
        // The house records were signed by node "one": the same signatures here.
        let one: [u8; 32] = hex::decode(v["houses"][0]["nodeSecret"].as_str().unwrap()).unwrap().try_into().unwrap();
        let key = HouseKey::from_node_secret(&one);
        for r in v["houseRecords"].as_array().unwrap() {
            let bytes = hex::decode(r["bytes"].as_str().unwrap()).unwrap();
            assert_eq!(key.sign(&bytes), r["value"]["g"].as_str().unwrap());
        }
    }

    #[test]
    fn yjs_numbers_read_as_the_pages_read_them() {
        assert_eq!(CVal::from_any(&yrs::Any::Number(3.0)), CVal::Int(3));
        assert_eq!(CVal::from_any(&yrs::Any::Number(-0.0)), CVal::Int(0));
        assert_eq!(CVal::from_any(&yrs::Any::Number(2.5)), CVal::Junk);
        assert_eq!(CVal::from_any(&yrs::Any::Number(9_007_199_254_740_992.0)), CVal::Junk);
        assert_eq!(CVal::from_any(&yrs::Any::BigInt(3)), CVal::Junk);
        let m = yrs::Any::from(std::collections::HashMap::from([
            ("b".to_string(), yrs::Any::Number(1.0)),
            ("a".to_string(), yrs::Any::Undefined),
        ]));
        assert_eq!(canon(&CVal::from_any(&m)).unwrap(), "{\"b\":1}");
        assert_eq!(canon(&CVal::from_any(&yrs::Any::from(vec![yrs::Any::Undefined]))), None);
    }

    #[test]
    fn strict_base64_refuses_other_spellings() {
        let pk = "jSMUpc5n1K_BnnemC3YBpb3-tVEelCTKdBvNLVzmQ90";
        assert!(b64url_strict(pk, 32).is_some());
        assert!(b64url_strict(&format!("{pk}="), 32).is_none());
        assert!(b64url_strict(&pk[..42], 32).is_none());
        // The last character carries 2 spare bits: a non-zero one is another spelling.
        assert!(b64url_strict("jSMUpc5n1K_BnnemC3YBpb3-tVEelCTKdBvNLVzmQ91", 32).is_none());
    }
}
