//! 🧮📨 The frames between the node and its fold worker (PR 6b-1b of "Computed
//! casino tables").
//!
//! The node runs the pages' fold in a child process of its own binary
//! (`ssf-p2p-node --fold-worker`, `fold_worker.rs`), which has no keys, no
//! docs and no network. They talk over the child's stdin and stdout in frames:
//! a u32 (little-endian) byte count, then that many bytes. Each frame is one
//! [`Req`] (node to worker) or one [`Resp`] (worker to node), in a binary
//! encoding of its fields where a record's value is a [`CVal`], the node's own
//! view of it, so a value is encoded once on one side and decoded once on the
//! other, and nothing round-trips through JSON text.
//!
//! The worker answers every `Cold` and `Warm` with exactly one `Resp`, in the
//! order it got them; a `Forget` has no answer. Every answer names its table
//! (room, table and incarnation ids of at most [`MAX_CTX_FIELD`] bytes, both
//! ways), so that a `Dirty` answer, whose reason is cut short by the worker, is
//! a few KiB and fits a frame whatever the request that named the table held.
//!
//! The decoder is for bytes from another process, so it takes nothing on trust:
//! a frame past [`MAX_FRAME`] is refused before it is read, nothing is
//! allocated for a count (a vector grows only as its items are read, and each
//! item takes at least a byte, so a count of 4 billion in a short frame fails
//! at the first item the bytes cannot pay for), nesting is bounded, strings
//! must be UTF-8 and nothing may follow the last field. A frame it refuses is
//! an error for the caller to treat as a dead peer; it never panics.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::fmt;
use std::io::{self, Read, Write};

use crate::house_bytes::{CVal, Ctx, MAX_DEPTH};

/// The most bytes one frame may hold. The fold's memory limit is 64 MiB, so a
/// request near this is already one the fold would refuse; the node splits a
/// big cold read over several frames (a `Cold` and `Warm`s: adding records
/// one batch at a time folds as adding them all at once).
pub const MAX_FRAME: usize = 32 << 20;

/// The longest a room, table or incarnation id may be in a frame. The node's are short; the limit
/// makes sure that an answer naming a table, with a reason it is dirty, fits a frame however full
/// the request that named it was (a table's ids come back in every answer).
pub const MAX_CTX_FIELD: usize = 4 << 10;

/// How deep a value may nest. The node's [`CVal`]s never pass `MAX_DEPTH`.
const WIRE_DEPTH: usize = MAX_DEPTH + 4;

/// A fold to start from scratch, or a restart of one: the table's checkpoint
/// (what `sum:` holds, none if it has none), the room's houses, the key pinned
/// for each player, and the live session's records (more of them may follow in
/// `Warm`s).
#[derive(Clone, Debug, PartialEq)]
pub struct Cold {
    pub ctx: Ctx,
    /// The node's own number for this state of the table; the answer carries it back.
    pub version: u64,
    pub base: Option<CVal>,
    pub houses: Vec<String>,
    pub pins: Vec<(String, String)>,
    pub records: Vec<(String, CVal)>,
}

/// Changes to a table the worker already holds: the houses and pins as they
/// now stand, and the records that changed (`None`: deleted).
#[derive(Clone, Debug, PartialEq)]
pub struct Warm {
    pub ctx: Ctx,
    pub version: u64,
    pub houses: Vec<String>,
    pub pins: Vec<(String, String)>,
    pub changes: Vec<(String, Option<CVal>)>,
}

/// Node to worker.
#[derive(Clone, Debug, PartialEq)]
pub enum Req {
    Cold(Cold),
    Warm(Warm),
    /// The table is gone; drop its context. No answer.
    Forget { ctx: Ctx },
}

/// Worker to node: the answer to one `Cold` or `Warm`.
#[derive(Clone, Debug, PartialEq)]
pub enum Resp {
    /// The fold's result as the JSON text the bundle made (`FoldSummary`).
    Result { ctx: Ctx, version: u64, text: String },
    /// The table is dirty (the worker holds no context for it): send a `Cold`.
    Dirty { ctx: Ctx, version: u64, reason: String },
}

impl Resp {
    pub fn ctx(&self) -> &Ctx {
        match self {
            Resp::Result { ctx, .. } | Resp::Dirty { ctx, .. } => ctx,
        }
    }

    pub fn version(&self) -> u64 {
        match self {
            Resp::Result { version, .. } | Resp::Dirty { version, .. } => *version,
        }
    }
}

/// Why a frame was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// The bytes ended inside a field.
    Truncated,
    /// A frame (or one to be sent) past [`MAX_FRAME`], or of no bytes; or a room, table or
    /// incarnation id past [`MAX_CTX_FIELD`].
    BadSize(usize),
    /// A tag that names nothing.
    BadTag(u8),
    /// A string that is not UTF-8.
    BadUtf8,
    /// A value nested deeper than [`WIRE_DEPTH`].
    TooDeep,
    /// Bytes after the last field.
    Trailing,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WireError::Truncated => write!(f, "frame ends inside a field"),
            WireError::BadSize(n) => write!(f, "frame of {n} bytes"),
            WireError::BadTag(t) => write!(f, "unknown tag {t:#04x}"),
            WireError::BadUtf8 => write!(f, "string is not UTF-8"),
            WireError::TooDeep => write!(f, "value nests too deep"),
            WireError::Trailing => write!(f, "bytes after the last field"),
        }
    }
}

impl std::error::Error for WireError {}

impl From<WireError> for io::Error {
    fn from(e: WireError) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, e)
    }
}

const REQ_COLD: u8 = 1;
const REQ_WARM: u8 = 2;
const REQ_FORGET: u8 = 3;
const RESP_RESULT: u8 = 0x81;
const RESP_DIRTY: u8 = 0x82;

const V_STR: u8 = 0;
const V_INT: u8 = 1;
const V_ARR: u8 = 2;
const V_OBJ: u8 = 3;
const V_UNDEF: u8 = 4;
const V_JUNK: u8 = 5;

// ── Encoding ────────────────────────────────────────────────────────────────

/// A frame being written. It never grows past the frame limit: once a write would pass it the
/// frame is over, nothing more is copied, and the size it would have had is still counted, so
/// the caller is told how big it was. (A batch of records is not copied twice in the node's
/// memory just to be refused.)
struct Out {
    b: Vec<u8>,
    /// The size the frame would have, copied or not.
    total: usize,
    /// A field that may not be sent, the first found: `finish` refuses the frame for it.
    bad: Option<WireError>,
}

/// The byte count and the most a body may be.
const FRAME_CAP: usize = 4 + MAX_FRAME;

impl Out {
    fn bytes(&mut self, x: &[u8]) {
        self.total = self.total.saturating_add(x.len());
        if self.total <= FRAME_CAP {
            self.b.extend_from_slice(x);
        }
    }
    fn u8(&mut self, v: u8) {
        self.bytes(&[v]);
    }
    fn u32(&mut self, v: usize) {
        // A length past u32 is past MAX_FRAME, which `finish` refuses.
        self.bytes(&(v.min(u32::MAX as usize) as u32).to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.bytes(&v.to_le_bytes());
    }
    fn str(&mut self, s: &str) {
        self.u32(s.len());
        self.bytes(s.as_bytes());
    }
    fn ctx(&mut self, c: &Ctx) {
        for id in [&c.room, &c.t, &c.inc] {
            if id.len() > MAX_CTX_FIELD && self.bad.is_none() {
                self.bad = Some(WireError::BadSize(id.len()));
            }
            self.str(id);
        }
    }
    fn strs(&mut self, v: &[String]) {
        self.u32(v.len());
        for s in v {
            self.str(s);
        }
    }
    fn pairs(&mut self, v: &[(String, String)]) {
        self.u32(v.len());
        for (a, b) in v {
            self.str(a);
            self.str(b);
        }
    }
    fn val(&mut self, v: &CVal, depth: usize) -> Result<(), WireError> {
        if depth > WIRE_DEPTH {
            return Err(WireError::TooDeep);
        }
        match v {
            CVal::Str(s) => {
                self.u8(V_STR);
                self.str(s);
            }
            CVal::Int(n) => {
                self.u8(V_INT);
                self.bytes(&n.to_le_bytes());
            }
            CVal::Arr(a) => {
                self.u8(V_ARR);
                self.u32(a.len());
                for x in a {
                    self.val(x, depth + 1)?;
                }
            }
            CVal::Obj(f) => {
                self.u8(V_OBJ);
                self.u32(f.len());
                for (k, x) in f {
                    self.str(k);
                    self.val(x, depth + 1)?;
                }
            }
            CVal::Undef => self.u8(V_UNDEF),
            CVal::Junk => self.u8(V_JUNK),
        }
        Ok(())
    }
    /// The whole frame: the byte count, then the body.
    fn finish(self) -> Result<Vec<u8>, WireError> {
        if let Some(e) = self.bad {
            return Err(e);
        }
        let body = self.total - 4;
        if body == 0 || body > MAX_FRAME {
            return Err(WireError::BadSize(body));
        }
        let mut b = self.b;
        b[..4].copy_from_slice(&(body as u32).to_le_bytes());
        Ok(b)
    }
}

fn out() -> Out {
    // Room for the byte count, filled in by `finish`.
    Out { b: vec![0; 4], total: 4, bad: None }
}

/// A request as a whole frame, the byte count included.
pub fn encode_req(req: &Req) -> Result<Vec<u8>, WireError> {
    let mut o = out();
    match req {
        Req::Cold(c) => {
            o.u8(REQ_COLD);
            o.ctx(&c.ctx);
            o.u64(c.version);
            match &c.base {
                Some(v) => {
                    o.u8(1);
                    o.val(v, 0)?;
                }
                None => o.u8(0),
            }
            o.strs(&c.houses);
            o.pairs(&c.pins);
            o.u32(c.records.len());
            for (k, v) in &c.records {
                o.str(k);
                o.val(v, 0)?;
            }
        }
        Req::Warm(w) => {
            o.u8(REQ_WARM);
            o.ctx(&w.ctx);
            o.u64(w.version);
            o.strs(&w.houses);
            o.pairs(&w.pins);
            o.u32(w.changes.len());
            for (k, v) in &w.changes {
                o.str(k);
                match v {
                    Some(v) => {
                        o.u8(1);
                        o.val(v, 0)?;
                    }
                    None => o.u8(0),
                }
            }
        }
        Req::Forget { ctx } => {
            o.u8(REQ_FORGET);
            o.ctx(ctx);
        }
    }
    o.finish()
}

/// A response as a whole frame, the byte count included.
pub fn encode_resp(resp: &Resp) -> Result<Vec<u8>, WireError> {
    let mut o = out();
    match resp {
        Resp::Result { ctx, version, text } => {
            o.u8(RESP_RESULT);
            o.ctx(ctx);
            o.u64(*version);
            o.str(text);
        }
        Resp::Dirty { ctx, version, reason } => {
            o.u8(RESP_DIRTY);
            o.ctx(ctx);
            o.u64(*version);
            o.str(reason);
        }
    }
    o.finish()
}

// ── Decoding ────────────────────────────────────────────────────────────────

struct In<'a> {
    b: &'a [u8],
}

impl<'a> In<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        if self.b.len() < n {
            return Err(WireError::Truncated);
        }
        let (head, rest) = self.b.split_at(n);
        self.b = rest;
        Ok(head)
    }
    fn u8(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<usize, WireError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().expect("4 bytes")) as usize)
    }
    fn u64(&mut self) -> Result<u64, WireError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().expect("8 bytes")))
    }
    fn i64(&mut self) -> Result<i64, WireError> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().expect("8 bytes")))
    }
    fn str(&mut self) -> Result<String, WireError> {
        let n = self.u32()?;
        let bytes = self.take(n)?;
        std::str::from_utf8(bytes).map(str::to_owned).map_err(|_| WireError::BadUtf8)
    }
    fn ctx(&mut self) -> Result<Ctx, WireError> {
        Ok(Ctx { room: self.id()?, t: self.id()?, inc: self.id()? })
    }
    /// A room, table or incarnation id: no longer than [`MAX_CTX_FIELD`], said before it is read.
    fn id(&mut self) -> Result<String, WireError> {
        let n = self.u32()?;
        if n > MAX_CTX_FIELD {
            return Err(WireError::BadSize(n));
        }
        let bytes = self.take(n)?;
        std::str::from_utf8(bytes).map(str::to_owned).map_err(|_| WireError::BadUtf8)
    }
    fn strs(&mut self) -> Result<Vec<String>, WireError> {
        let n = self.u32()?;
        (0..n).map(|_| self.str()).collect()
    }
    fn pairs(&mut self) -> Result<Vec<(String, String)>, WireError> {
        let n = self.u32()?;
        (0..n).map(|_| Ok((self.str()?, self.str()?))).collect()
    }
    fn val(&mut self, depth: usize) -> Result<CVal, WireError> {
        if depth > WIRE_DEPTH {
            return Err(WireError::TooDeep);
        }
        Ok(match self.u8()? {
            V_STR => CVal::Str(self.str()?),
            V_INT => CVal::Int(self.i64()?),
            V_ARR => {
                let n = self.u32()?;
                CVal::Arr((0..n).map(|_| self.val(depth + 1)).collect::<Result<_, _>>()?)
            }
            V_OBJ => {
                let n = self.u32()?;
                CVal::Obj((0..n).map(|_| Ok((self.str()?, self.val(depth + 1)?))).collect::<Result<_, WireError>>()?)
            }
            V_UNDEF => CVal::Undef,
            V_JUNK => CVal::Junk,
            t => return Err(WireError::BadTag(t)),
        })
    }
    fn done(self) -> Result<(), WireError> {
        if self.b.is_empty() {
            Ok(())
        } else {
            Err(WireError::Trailing)
        }
    }
}

/// A request from a frame's body (the bytes after its byte count).
pub fn decode_req(body: &[u8]) -> Result<Req, WireError> {
    let mut i = In { b: body };
    let req = match i.u8()? {
        REQ_COLD => {
            let ctx = i.ctx()?;
            let version = i.u64()?;
            let base = match i.u8()? {
                0 => None,
                1 => Some(i.val(0)?),
                t => return Err(WireError::BadTag(t)),
            };
            let houses = i.strs()?;
            let pins = i.pairs()?;
            let n = i.u32()?;
            let records = (0..n).map(|_| Ok((i.str()?, i.val(0)?))).collect::<Result<_, WireError>>()?;
            Req::Cold(Cold { ctx, version, base, houses, pins, records })
        }
        REQ_WARM => {
            let ctx = i.ctx()?;
            let version = i.u64()?;
            let houses = i.strs()?;
            let pins = i.pairs()?;
            let n = i.u32()?;
            let changes = (0..n)
                .map(|_| {
                    let k = i.str()?;
                    let v = match i.u8()? {
                        0 => None,
                        1 => Some(i.val(0)?),
                        t => return Err(WireError::BadTag(t)),
                    };
                    Ok((k, v))
                })
                .collect::<Result<_, WireError>>()?;
            Req::Warm(Warm { ctx, version, houses, pins, changes })
        }
        REQ_FORGET => Req::Forget { ctx: i.ctx()? },
        t => return Err(WireError::BadTag(t)),
    };
    i.done()?;
    Ok(req)
}

/// A response from a frame's body.
pub fn decode_resp(body: &[u8]) -> Result<Resp, WireError> {
    let mut i = In { b: body };
    let resp = match i.u8()? {
        RESP_RESULT => Resp::Result { ctx: i.ctx()?, version: i.u64()?, text: i.str()? },
        RESP_DIRTY => Resp::Dirty { ctx: i.ctx()?, version: i.u64()?, reason: i.str()? },
        t => return Err(WireError::BadTag(t)),
    };
    i.done()?;
    Ok(resp)
}

// ── On a pipe ───────────────────────────────────────────────────────────────

/// The next frame's body. `None`: the peer closed the pipe between frames,
/// which is how a peer says it is done. A pipe that ends inside a frame, a
/// frame of no bytes or past [`MAX_FRAME`] is an error.
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match r.read(&mut len[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let n = u32::from_le_bytes(len) as usize;
    if n == 0 || n > MAX_FRAME {
        return Err(WireError::BadSize(n).into());
    }
    // Not `vec![0; n]` up front: a peer that claims 32 MiB and sends nothing
    // costs only what it sends.
    let mut body = Vec::new();
    r.by_ref().take(n as u64).read_to_end(&mut body)?;
    if body.len() < n {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(Some(body))
}

/// A whole frame (from [`encode_req`] or [`encode_resp`]), flushed.
pub fn write_frame<W: Write>(w: &mut W, frame: &[u8]) -> io::Result<()> {
    w.write_all(frame)?;
    w.flush()
}

#[cfg(test)]
mod tests;
