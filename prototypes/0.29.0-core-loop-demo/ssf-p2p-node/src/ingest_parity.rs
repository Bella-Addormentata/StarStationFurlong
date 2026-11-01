//! 🛑 Refuse a v1 Yjs update that **every** page refuses, on the raw bytes,
//! BEFORE the node decodes it.
//!
//! `yrs` 0.27.2 builds strings with `from_utf8_unchecked`
//! (`encoding/read.rs:137`, `updates/decoder.rs:486`): a v1 update holding a
//! non-UTF-8 string crashes the whole process — `Update::decode_v1` →
//! `Item::len` → `SplittableString::utf16_len` walks `.chars()` over bytes that
//! are not UTF-8, reading past the buffer (SIGSEGV in release, abort in debug).
//! A page never hits this: lib0 decodes every string through
//! `TextDecoder('utf-8', { fatal: true })` (`lib0/string.js`), which throws, so
//! `Y.applyUpdate` rejects the update and the page's doc is untouched. Deep
//! `Any` nesting overflows yrs's worker stack (~5000) and a huge declared
//! length OOM-aborts it; a page's lib0 throws first in both cases too.
//!
//! The node relays a ysync frame to its mesh peers and local tabs *before* it
//! ever decodes it (`main.rs` iroh lane), so one frame from any page or peer
//! takes the owner's node — and its neighbours — down. [`pages_refuse`] runs on
//! the raw bytes at every ingress, ahead of relay/dedup/retain/merge, and
//! **never calls `Update::decode_v1`** itself (that is the crash surface).
//!
//! ## The one rule that must never break
//!
//! The node must never refuse an update a page accepts: that diverges the docs
//! exactly as accepting a page-refused one does (a page loading the node's
//! served diff would then hold content its peers don't, or miss content they
//! do). So every rule here mirrors a position where **every** page's lib0/Yjs
//! decoder throws, or a position where no page can hold the same bytes as yrs
//! regardless (yrs mis-decodes the tail) **and** the current page encoder never
//! emits those bytes. Under-refusing (letting a page-refused update through) is
//! the lesser evil — it only re-exposes the pre-existing divergence — so where a
//! rule is in doubt we under-refuse.
//!
//! Pinned behaviour: pages `yjs` 13.6.31 + `lib0` 0.2.117; node `yrs` 0.27.2.
//! The rules (R1, G1–G3, R3–R7) and the exact wire positions are documented at
//! each step below. R2 (the `__proto__` + typed-array-getter trap keys, an
//! exact V8 `[[Set]]` model) is a deliberate follow-up: this guard does not
//! refuse any `__proto__`/map-key case beyond R1, which never over-refuses
//! (it under-refuses the trap case, re-exposing the same read-time divergence
//! the house's `Clarity` already handles).

/// Why `pages_refuse` refuses an update (for the drop log / the vectors).
///
/// Each variant is a position where **every** page's lib0/Yjs decoder throws
/// (pure parity: R1, R4, R6, R7, and the `var_u64` cap of G1), or a structural
/// guard that refuses to keep the node alive where yrs would crash/OOM before
/// a page's lib0 does (G2, G3) — a narrow, deliberate over-refusal of nesting
/// and lengths no honest record carries. ContentJSON (ref 2) and XmlHook (type
/// ref 5) ARE refused (D1): yrs consumes a different number of bytes for each
/// than the page does (ContentJSON reads `len + 1` var-strings on yrs vs `len`
/// on the page; XmlHook reads no name on yrs vs a name on the page), so once
/// one appears the walk can no longer be sure its cursor matches yrs's — and a
/// byte the walk never reached, that yrs then decodes as a string, is the
/// crash. The game emits neither, so refusing them drops no real update. R2
/// (the `__proto__` + typed-array trap keys) is still deferred.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refuse {
    /// R1: a string that is not valid UTF-8, in any string position.
    NonUtf8 { at: &'static str },
    /// R4: a ContentType type ref with no reader on the page (not 0..=6).
    TypeRef(u64),
    /// R6: a ContentDoc whose opts is null or undefined (the page throws on
    /// `opts.shouldLoad`; any other opts the page reads without throwing).
    DocOpts,
    /// R7: a block content ref with no reader (`info & 0x1f` not in 1..=9,
    /// and not GC 0 / Skip 10), or an `Any` tag with no reader.
    ContentRef(u8),
    /// D1: a construct yrs consumes a different number of bytes for than the
    /// page does (ContentJSON, XmlHook), so past it the walk cannot keep its
    /// cursor aligned with yrs; refused so no byte the walk skipped ever
    /// reaches the decoder as a string. The game emits neither.
    Desync(&'static str),
    /// G1: a varuint past lib0's `Number.MAX_SAFE_INTEGER` cap, or a signed
    /// varint long enough (an 11th byte) that yrs's `read_var_i64` would shift
    /// past the 64-bit width — a structural bound no honest page reaches.
    VarTooLarge,
    /// G2: a declared length past the bytes remaining.
    LengthOverflow,
    /// G3: `Any`/array nesting past the depth cap.
    TooDeep,
    /// The bytes ran out mid-field (yrs would `Err` on decode anyway; refusing
    /// is free and keeps the walk total).
    Truncated,
}

/// lib0 `readVarUint` throws once the accumulated value passes this
/// (`number.MAX_SAFE_INTEGER`, `lib0/decoding.js`). yrs reads these fields as
/// `u64`/`u32` and accepts past it, so a page refuses where yrs would not.
const MAX_SAFE: u64 = (1u64 << 53) - 1;

/// `Any`/array nesting cap (G3). lib0's `readAny` recurses per level; yrs
/// overflows its 2 MiB worker stack at ~5000. A real page/record nests only a
/// handful deep, so a cap here refuses only where no page accepts and also
/// removes yrs's stack-overflow abort. Far below both limits.
const MAX_ANY_DEPTH: u32 = 256;

/// Info-byte bits (yjs `lib0/binary.js`). `BITS5` masks the content ref.
const BIT6: u8 = 0b0010_0000; // parentSub present
const BIT7: u8 = 0b0100_0000; // right origin present
const BIT8: u8 = 0b1000_0000; // origin present
const BITS5: u8 = 0b0001_1111;

/// A cursor over raw v1 bytes with lib0's exact read semantics. Every read is
/// fallible and total: it returns `Err` rather than panic on a short buffer.
struct Cur<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Cur<'a> {
    fn new(b: &'a [u8]) -> Self {
        Cur { b, i: 0 }
    }

    fn u8(&mut self) -> Result<u8, Refuse> {
        let v = *self.b.get(self.i).ok_or(Refuse::Truncated)?;
        self.i += 1;
        Ok(v)
    }

    /// lib0 `readVarUint`: 7 bits per byte, little-endian, continue while the
    /// high bit is set; throw once the value passes `MAX_SAFE` (G1).
    fn var_u64(&mut self) -> Result<u64, Refuse> {
        let mut num: u64 = 0;
        let mut mult: u64 = 1;
        loop {
            let r = self.u8()?;
            // num += (r & 0x7f) * mult, saturating so a wild run can't wrap.
            num = num.saturating_add(((r & 0x7f) as u64).saturating_mul(mult));
            if r & 0x80 == 0 {
                return Ok(num);
            }
            mult = mult.saturating_mul(128);
            // lib0 checks the cap only after a continuation byte, so a value
            // whose last byte clears the high bit returns above even if it is
            // over MAX_SAFE — matched: the check is here, not before the return.
            if num > MAX_SAFE {
                return Err(Refuse::VarTooLarge);
            }
        }
    }

    /// A declared length as a `usize`, refused (G2) when it exceeds the bytes
    /// left — so no reader allocates or walks past the buffer, and yrs's
    /// `with_capacity(len)` / `IdRanges::decode` OOM-abort is unreachable.
    fn len_within(&mut self) -> Result<usize, Refuse> {
        let n = self.var_u64()?;
        let n = usize::try_from(n).map_err(|_| Refuse::LengthOverflow)?;
        if n > self.b.len() - self.i {
            return Err(Refuse::LengthOverflow);
        }
        Ok(n)
    }

    /// Read `len` raw bytes (the slice's length already checked by the caller
    /// via `len_within`, or here for a fixed read).
    fn take(&mut self, len: usize) -> Result<&'a [u8], Refuse> {
        if len > self.b.len() - self.i {
            return Err(Refuse::Truncated);
        }
        let s = &self.b[self.i..self.i + len];
        self.i += len;
        Ok(s)
    }

    /// lib0 `readVarUint8Array`: a var length then that many bytes.
    fn var_bytes(&mut self) -> Result<&'a [u8], Refuse> {
        let len = self.len_within()?;
        self.take(len)
    }

    /// lib0 `readVarString` → `TextDecoder` fatal: a var byte-buffer that must
    /// be valid UTF-8 (R1). `std::str::from_utf8` accepts exactly what
    /// `TextDecoder('utf-8', { fatal: true })` accepts, so this is an exact
    /// oracle, not an over-approximation.
    fn var_str(&mut self, at: &'static str) -> Result<(), Refuse> {
        let buf = self.var_bytes()?;
        std::str::from_utf8(buf).map_err(|_| Refuse::NonUtf8 { at })?;
        Ok(())
    }

    fn skip(&mut self, len: usize) -> Result<(), Refuse> {
        self.take(len).map(|_| ())
    }

    /// The next byte without consuming it.
    fn peek(&self) -> Result<u8, Refuse> {
        self.b.get(self.i).copied().ok_or(Refuse::Truncated)
    }
}

/// `Some(reason)` iff every page's lib0/Yjs decoder would refuse this v1
/// update; `None` iff a page would accept it (then `Update::decode_v1` is safe
/// to call). Total and panic-free on any bytes.
pub fn pages_refuse(update_v1: &[u8]) -> Option<Refuse> {
    verify_v1(&mut Cur::new(update_v1)).err()
}

/// Mirror yjs `readClientsStructRefs` + `readDeleteSet` (`utils/encoding.js`,
/// `utils/DeleteSet.js`). Trailing bytes after the delete set are ignored, as
/// on both sides.
fn verify_v1(c: &mut Cur) -> Result<(), Refuse> {
    // readClientsStructRefs
    let num_clients = c.var_u64()?;
    for _ in 0..num_clients {
        let num_structs = c.var_u64()?;
        let _client = c.var_u64()?; // readClient (G1 covers id >= 2^53)
        let _clock = c.var_u64()?;
        for _ in 0..num_structs {
            verify_struct(c)?;
        }
    }
    // readDeleteSet
    let ds_clients = c.var_u64()?;
    for _ in 0..ds_clients {
        let _client = c.var_u64()?;
        let num_deletes = c.var_u64()?;
        for _ in 0..num_deletes {
            let _clock = c.var_u64()?; // readDsClock
            let _len = c.var_u64()?; // readDsLen
        }
    }
    Ok(())
}

/// One struct. yrs dispatches on the **raw** info byte (`update.rs`
/// `read_item`): only `0` is a GC and only `10` is a Skip; every other byte is
/// an Item, whatever its low five bits. A page instead dispatches on
/// `info & 0x1f` (`yjs encoding.js:130`, `BITS5 & info`), so a byte like `0x20`
/// (low bits `0`, BIT6 set) is a GC to the page but an Item to yrs — the two
/// walks part, and yrs reads the Item's parentSub/content bytes as a string a
/// page never UTF-8-checked. No honest page emits such a byte (a GC is always
/// `0`, a Skip always `10`, an Item's content ref always `1..=9`), so mirroring
/// yrs's raw match refuses exactly those divergent bytes (R1/R7) and keeps the
/// walk on the same bytes as the decoder that could crash.
fn verify_struct(c: &mut Cur) -> Result<(), Refuse> {
    let info = c.u8()?;
    match info {
        0 => {
            let _len = c.var_u64()?; // readLen (GC)
            Ok(())
        }
        10 => {
            let _len = c.var_u64()?; // Skip
            Ok(())
        }
        info => {
            // Item. Content ref is the low 5 bits; cantCopyParentInfo == no
            // origin and no right origin.
            let content_ref = info & BITS5;
            let cant_copy = info & (BIT7 | BIT8) == 0;
            if info & BIT8 != 0 {
                c.var_u64()?; // origin: client
                c.var_u64()?; //         clock
            }
            if info & BIT7 != 0 {
                c.var_u64()?; // right origin: client
                c.var_u64()?; //              clock
            }
            if cant_copy {
                // yrs reads parentInfo as a **u32** varint and tests `== 1`
                // (`decoder.rs` `read_parent_info`). A value that wraps to 1 in
                // u32 (e.g. 2^32+1) sends yrs down the root-name branch while a
                // page — `readVarUint(...) === 1`, the full value — takes the
                // parent-id branch; the two branches consume a different number
                // of bytes, so the cursors part and yrs reads a later byte as an
                // unchecked string. Mirror yrs exactly: test the low 32 bits. An
                // honest page writes only 0 or 1 here (`writeParentInfo`), so
                // this changes the walk only on bytes no page emits, and a value
                // past MAX_SAFE is refused by `var_u64` before the cast (the
                // page throws there too).
                let has_parent_ykey = (c.var_u64()? as u32) == 1; // readParentInfo
                if has_parent_ykey {
                    c.var_str("parentYKey")?; // root name (R1)
                } else {
                    c.var_u64()?; // parent left id: client
                    c.var_u64()?; //                clock
                }
            }
            if cant_copy && info & BIT6 != 0 {
                c.var_str("parentSub")?; // (R1)
            }
            verify_content(content_ref, c)
        }
    }
}

/// `readItemContent`: `contentRefs[info & 0x1f]` (`structs/Item.js`). Refs with
/// no reader (R7) are unreachable here — the dispatch in `verify_struct`
/// already routed 0 and 10 — but a ref in 11..=25 lands in the `_` arm and is
/// refused by its number.
fn verify_content(content_ref: u8, c: &mut Cur) -> Result<(), Refuse> {
    match content_ref {
        1 => {
            // ContentDeleted: readLen.
            c.var_u64()?;
            Ok(())
        }
        2 => {
            // ContentJSON (D1): the page reads `len` var-strings; yrs reads
            // `len + 1` and so leaves its cursor one var-string ahead of ours.
            // We cannot UTF-8-check a byte we never walk, so a frame carrying a
            // ContentJSON could pass this walk and still hand yrs an unchecked
            // non-UTF-8 string — the crash. Refuse it. The game never emits a
            // ContentJSON (it uses ContentAny), so this drops no real update.
            Err(Refuse::Desync("ContentJSON"))
        }
        3 => {
            // ContentBinary: readBuf.
            c.var_bytes()?;
            Ok(())
        }
        4 => c.var_str("ContentString"), // R1
        5 => {
            // ContentEmbed: readJSON = one var-string (JSON.parse). Same byte
            // count on both sides; UTF-8 only, no JSON-parse (serde-vs-V8 JSON
            // mismatches are reverse divergences, out of scope).
            c.var_str("ContentEmbed")
        }
        6 => {
            // ContentFormat: readKey (R1) then readJSON (one var-string).
            c.var_str("ContentFormat.key")?;
            c.var_str("ContentFormat.value")
        }
        7 => verify_type_ref(c), // ContentType (R4)
        8 => {
            // ContentAny: readLen then that many readAny.
            let len = c.var_u64()?;
            for _ in 0..len {
                verify_any(c, 0)?;
            }
            Ok(())
        }
        9 => {
            // ContentDoc: readString (guid, R1) then readAny (opts).
            c.var_str("ContentDoc.guid")?;
            // createDocFromOpts reads `opts.shouldLoad || opts.autoLoad` — a
            // null or undefined opts throws (R6), but a number/string/bool/
            // object opts is read without throwing, so refuse ONLY null/
            // undefined. yrs ignores a non-Map opts and accepts either way.
            let tag = c.peek()?;
            verify_any(c, 0)?;
            if tag == 126 || tag == 127 {
                return Err(Refuse::DocOpts);
            }
            Ok(())
        }
        other => Err(Refuse::ContentRef(other)), // R7
    }
}

/// `readContentType` = `typeRefs[readTypeRef()](decoder)`. `typeRefs` has 7
/// entries (0..=6); a type ref >= 7 is an undefined reader → TypeError on the
/// page (R4). yrs's `TypeRef::decode` additionally accepts 9 (SubDoc) and 15
/// (Undefined) — forward divergences, refused. 0/1/2/4/6 (YArray, YMap, YText,
/// YXmlFragment, YXmlText) read no name on both sides; 3 (YXmlElement) reads a
/// name on both. Type ref 5 (XmlHook) is refused (D1): the page reads a name
/// key and yrs reads none, so the cursors part — and the game never emits it.
fn verify_type_ref(c: &mut Cur) -> Result<(), Refuse> {
    let type_ref = c.var_u64()?;
    match type_ref {
        0 | 1 | 2 | 4 | 6 => Ok(()),        // YArray, YMap, YText, YXmlFragment, YXmlText: read no name
        3 => c.var_str("YXmlElement.name"), // readKey (R1) — yrs reads the name too
        5 => Err(Refuse::Desync("XmlHook")), // D1: page reads a name, yrs does not
        other => Err(Refuse::TypeRef(other)), // R4 (7, 8, 9, 15, …)
    }
}

/// Walk one `Any` value (`lib0/decoding.js` `readAnyLookupTable`), checking
/// every string (R1) and capping nesting (G3). Does not model the `__proto__`
/// trap keys (R2, deferred): it checks map keys for UTF-8 and recurses, which
/// never over-refuses.
fn verify_any(c: &mut Cur, depth: u32) -> Result<(), Refuse> {
    if depth > MAX_ANY_DEPTH {
        return Err(Refuse::TooDeep);
    }
    let tag = c.u8()?;
    match tag {
        127 | 126 => Ok(()),             // undefined, null
        125 => {
            c.var_i64()?;                // integer (readVarInt)
            Ok(())
        }
        124 => c.skip(4),                // float32
        123 => c.skip(8),                // float64
        122 => c.skip(8),                // bigint (readBigInt64)
        121 | 120 => Ok(()),             // false, true
        119 => c.var_str("Any.string"), // R1
        118 => {
            // object<string,any>
            let len = c.var_u64()?;
            for _ in 0..len {
                c.var_str("Any.key")?; // R1 on the key
                verify_any(c, depth + 1)?;
            }
            Ok(())
        }
        117 => {
            // array<any>
            let len = c.var_u64()?;
            for _ in 0..len {
                verify_any(c, depth + 1)?;
            }
            Ok(())
        }
        116 => {
            c.var_bytes()?; // Uint8Array
            Ok(())
        }
        // tag outside 116..=127: `readAnyLookupTable[127 - tag]` is out of
        // bounds on the page → throws. (The index is `127 - readUint8`, so a
        // byte >127 or <116 has no reader.)
        _ => Err(Refuse::ContentRef(tag)),
    }
}

impl<'a> Cur<'a> {
    /// lib0 `readVarInt`: sign in bit 6 of the first byte, 7 bits per byte
    /// after, same `MAX_SAFE` cap (G1). We only need it to advance the cursor;
    /// the value is discarded.
    ///
    /// yrs reads the signed varint with a plain `i64 << len` (`varint.rs`
    /// `read_var_i64`), where `len` climbs 6, 13, …, 69. The shift at 69 — the
    /// 11th byte — is past the 64-bit width, which a debug `yrs` panics on (a
    /// release `yrs` masks it to a wrong value); an overlong varint padded with
    /// zero-payload continuation bytes slips the `MAX_SAFE` cap (the running
    /// value stays small) and is the only way to reach it, since a genuine
    /// magnitude that big trips the cap first. An honest signed varint is at
    /// most 9 bytes (a magnitude <= MAX_SAFE), so a varint reaching an 11th
    /// byte is one no page emits; refuse it — a structural bound like G2/G3 — so
    /// yrs never shifts past the width. (yrs's other panic, `-i64::MIN`, needs a
    /// magnitude >= 2^63 > MAX_SAFE, which the cap already refuses.)
    fn var_i64(&mut self) -> Result<(), Refuse> {
        let r = self.u8()?;
        let mut num: u64 = (r & 0x3f) as u64; // BITS6
        let mut mult: u64 = 64;
        if r & 0x80 == 0 {
            return Ok(());
        }
        let mut bytes: u32 = 1;
        loop {
            let r = self.u8()?;
            bytes += 1;
            if bytes > 10 {
                // An 11th byte is where yrs shifts by 69 (>= the 64-bit width).
                return Err(Refuse::VarTooLarge);
            }
            num = num.saturating_add(((r & 0x7f) as u64).saturating_mul(mult));
            if r & 0x80 == 0 {
                return Ok(());
            }
            mult = mult.saturating_mul(128);
            if num > MAX_SAFE {
                return Err(Refuse::VarTooLarge);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use yrs::updates::decoder::Decode;
    use yrs::Update;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        #[serde(default)]
        group: String,
        update: String,
        refused: bool,
    }

    fn vectors(path: &str) -> Vec<Case> {
        let p = concat_root(path);
        let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {p}: {e}"));
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        // Both files put the cases under a top-level array key.
        let arr = v
            .get("cases")
            .or_else(|| v.get("yjs"))
            .and_then(|x| x.as_array())
            .expect("cases/yjs array");
        arr.iter()
            .map(|c| serde_json::from_value(c.clone()).unwrap())
            .collect()
    }

    fn concat_root(rel: &str) -> String {
        format!("{}/../{}", env!("CARGO_MANIFEST_DIR"), rel)
    }

    /// The guard agrees with the page oracle for every ingest-parity vector.
    /// The oracle `refused` is `Y.applyUpdate(new Doc, update)` throwing,
    /// recorded by the vitest that writes the file from the real yjs/lib0; the
    /// `parity` group holds only cases where the guard and the page must agree
    /// exactly (the structural guards G2/G3, the desync refusals D1, and the
    /// `divergence` cases where yrs and a page decode the same bytes along
    /// different paths — all of which the guard refuses on purpose though a page
    /// may accept — live in their own groups and are checked below without the
    /// page oracle).
    #[test]
    fn agrees_with_the_page_oracle() {
        let cases = vectors("test-vectors/ingest-parity-v1.json");
        assert!(cases.len() >= 20, "too few vectors: {}", cases.len());
        let mut parity = 0;
        for c in &cases {
            let bytes = hex::decode(&c.update).unwrap_or_else(|e| panic!("{}: {e}", c.name));
            let got = pages_refuse(&bytes).is_some();
            if c.group == "depth" || c.group == "length" || c.group == "desync" || c.group == "divergence" {
                // Structural / desync guard (G2/G3/D1): the guard refuses; the
                // page may accept a well-formed one.
                assert!(got, "{} [{}]: guard must refuse", c.name, c.group);
                continue;
            }
            parity += 1;
            assert_eq!(got, c.refused, "{} [{}]: pages_refuse={}", c.name, c.group, got);
        }
        assert!(parity >= 15, "too few parity vectors: {parity}");
    }

    /// For every vector the guard accepts, `Update::decode_v1` runs to
    /// completion without crashing — the whole point, since the accept path is
    /// what reaches the decoder. The guard accepts only constructs it walked
    /// with the same byte count yrs will (so every string yrs builds was
    /// UTF-8-checked); a construct whose counts could part — ContentJSON,
    /// XmlHook — is refused (D1), not accepted, so no unwalked byte ever reaches
    /// `from_utf8_unchecked`. The assertion is that the call *returns*: a crash
    /// vector wrongly accepted would abort this process at `decode_v1`, never
    /// returning `Ok` or `Err`. The `clean` group — well-formed updates a page
    /// emits, including a `YXmlText` (type ref 6) — must additionally decode to
    /// `Ok` on the node, so the accepted type refs are shown to be yrs-readable.
    #[test]
    fn accepts_never_crash_yrs() {
        let mut accepted = 0;
        for c in vectors("test-vectors/ingest-parity-v1.json") {
            let bytes = hex::decode(&c.update).unwrap();
            if pages_refuse(&bytes).is_some() {
                continue;
            }
            accepted += 1;
            // Reaching past this call is the no-crash assertion.
            let ok = Update::decode_v1(&bytes).is_ok();
            if c.group == "clean" {
                assert!(ok, "{}: a real page update must decode on the node", c.name);
            }
        }
        assert!(accepted >= 10, "too few accepted vectors exercised: {accepted}");
    }

    /// The crash vectors (a non-UTF-8 string that segfaults yrs 0.27.2) are
    /// refused — and refusing never calls `Update::decode_v1`, so this test
    /// can run them safely.
    #[test]
    fn refuses_the_crash_vectors() {
        for hex_s in [
            "010101000401017403ff626300",
            "0101010004010174066162636465c300",
            "0101010004010174066162636465ff00",
        ] {
            let bytes = hex::decode(hex_s).unwrap();
            assert_eq!(pages_refuse(&bytes), Some(Refuse::NonUtf8 { at: "ContentString" }), "{hex_s}");
        }
    }

    /// Copilot's cursor-shift vector (PR #350 review): a ContentJSON whose
    /// `len + 1` read on yrs leaves yrs decoding a lone `c2` as a ContentString
    /// (the crash). The old walk — which parsed ContentJSON the page's way and
    /// accepted — let it through; the guard now refuses at the ContentJSON
    /// (D1), before the decoder, so the trailing bytes never reach yrs.
    #[test]
    fn refuses_the_contentjson_cursor_shift() {
        let mut v = hex::decode("010201000201017201046e756c6c046e756c6c0401017401c2a9").unwrap();
        v.extend(std::iter::repeat(0x61).take(101));
        v.push(0x00);
        assert_eq!(pages_refuse(&v), Some(Refuse::Desync("ContentJSON")));
    }

    /// Copilot's raw-dispatch crash vector (PR #350 review): info byte 0x20 is a
    /// GC to a page (`BITS5 & info == 0`) but an Item to yrs (raw `match info`),
    /// and yrs reads the Item's parentSub as a string from a non-UTF-8 byte. The
    /// old masked dispatch walked it as a GC and accepted; the guard now mirrors
    /// yrs's raw match and refuses at the parentSub, before the decoder.
    #[test]
    fn refuses_the_raw_dispatch_crash_vector() {
        let bytes = hex::decode("0101010020010001ff").unwrap();
        assert_eq!(pages_refuse(&bytes), Some(Refuse::NonUtf8 { at: "parentSub" }));
    }

    /// Copilot's parentInfo u32-wrap crash vector: a parentInfo of 2^32+1, which
    /// yrs reads as a u32 (`== 1` → root-name branch) while a page reads the
    /// full value (`!== 1` → parent-id branch). Following yrs down the root-name
    /// branch leaves yrs reading a trailing non-UTF-8 ContentString; the guard
    /// now mirrors yrs's u32 test and refuses there. (A page walks the other
    /// branch over different bytes and does not crash — a node-only hole.)
    #[test]
    fn refuses_the_parentinfo_u32_wrap_crash_vector() {
        let bytes = hex::decode("01010100048180808010020108066162636465c3a900").unwrap();
        assert_eq!(pages_refuse(&bytes), Some(Refuse::NonUtf8 { at: "ContentString" }));
    }

    /// An overlong signed varint — an `Any` integer padded to 11 bytes with
    /// zero-payload continuation bytes. The payload stays 0 so the MAX_SAFE cap
    /// never trips, but yrs's `read_var_i64` would shift by 69 on the 11th byte,
    /// past the 64-bit width (a debug-build panic). The guard bounds the signed
    /// varint at 10 bytes and refuses before that byte.
    #[test]
    fn refuses_an_overlong_signed_varint() {
        let mut u = vec![1u8]; // numClients
        u.extend_from_slice(&[1, 0, 0]); // numStructs, client, clock
        u.push(8); // info: Item, ContentAny (ref 8), root parent
        u.push(1); // readParentInfo == 1
        u.extend_from_slice(&[1, b'r']); // parentYKey "r"
        u.push(1); // ContentAny len
        u.push(125); // Any: integer (readVarInt)
        u.extend(std::iter::repeat(0x80).take(10)); // 10 continuation bytes, payload 0
        u.push(0x00); // 11th byte — the guard refuses here, before yrs's shift
        u.push(0); // delete set: 0 clients
        assert_eq!(pages_refuse(&u), Some(Refuse::VarTooLarge));
    }

    /// G1 is exercised by the EXACT refusal reason, not merely "refused". lib0
    /// caps a varuint at `MAX_SAFE` only on a continuation byte, so both vectors
    /// are otherwise complete: the client == MAX_SAFE one (terminal byte) is
    /// accepted — the cap does not over-refuse the boundary — and the one past
    /// the cap (a continuation byte carrying the value to 2^56-1) is refused as
    /// `VarTooLarge`, not `Truncated`. Removing the G1 check in `var_u64` would
    /// let the over-cap update's complete body walk clean and be accepted, which
    /// `Some(VarTooLarge)` here would then catch.
    #[test]
    fn refuses_oversized_varuint() {
        let cases = vectors("test-vectors/ingest-parity-v1.json");
        let over = cases
            .iter()
            .find(|c| c.name == "client id over MAX_SAFE (continuation byte)")
            .expect("over-cap varint vector present");
        assert_eq!(
            pages_refuse(&hex::decode(&over.update).unwrap()),
            Some(Refuse::VarTooLarge),
            "a client varuint past the cap must refuse as VarTooLarge, not Truncated",
        );
        let edge = cases
            .iter()
            .find(|c| c.name == "client id = MAX_SAFE (terminal byte, accepted)")
            .expect("boundary varint vector present");
        assert_eq!(
            pages_refuse(&hex::decode(&edge.update).unwrap()),
            None,
            "client == MAX_SAFE (terminal byte) is accepted; the cap must not over-refuse",
        );
    }

    /// Total and panic-free on arbitrary/truncated bytes, and never calls into
    /// yrs. A deterministic xorshift fuzz — no clock, no rng dependency.
    #[test]
    fn total_on_random_bytes() {
        let mut x: u64 = 0x9E3779B97F4A7C15;
        for _ in 0..20_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let len = (x % 64) as usize;
            let mut b = Vec::with_capacity(len);
            let mut y = x;
            for _ in 0..len {
                y = y.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                b.push((y >> 33) as u8);
            }
            // Must not panic.
            let _ = pages_refuse(&b);
        }
    }

    /// Deep nesting past the cap is refused (and never overflows the stack).
    #[test]
    fn deep_any_is_refused() {
        // One client, one struct: an Item with a ContentAny of one array
        // nested MAX_ANY_DEPTH+2 deep, crafted at the v1 wire format.
        // numClients=1
        let mut u = vec![1u8];
        // numStructs=1, client=0, clock=0
        u.extend_from_slice(&[1, 0, 0]);
        // info: Item with content ref 8 (ContentAny), parent root, parentSub none.
        // cantCopyParentInfo true (no origin/right), hasParentYKey=1, name "r"
        u.push(8); // info & 0x1f == 8, no high bits
        u.push(1); // readParentInfo == 1
        u.extend_from_slice(&[1, b'r']); // parentYKey "r"
        // ContentAny: len 1, then one Any = nested arrays MAX_ANY_DEPTH+2 deep.
        u.push(1); // content any len
        let deep = (MAX_ANY_DEPTH + 2) as usize;
        for _ in 0..deep {
            u.push(117); // array
            u.push(1); // len 1
        }
        u.push(126); // null leaf
        // delete set: 0 clients
        u.push(0);
        assert_eq!(pages_refuse(&u), Some(Refuse::TooDeep));
    }
}
