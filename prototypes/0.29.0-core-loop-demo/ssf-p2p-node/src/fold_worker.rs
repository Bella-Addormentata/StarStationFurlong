//! 🧮🧱 The fold worker: the node's own binary, started as `ssf-p2p-node
//! --fold-worker` (PR 6b-1b of "Computed casino tables").
//!
//! It holds the QuickJS runtime and the tables' contexts (`house_fold.rs`) and
//! nothing else: no keys, no docs, no network, no files. The node talks to it
//! over its stdin and stdout in frames (`fold_wire.rs`) and it answers each
//! `Cold` and `Warm` with one frame, in order. The node's supervisor
//! (`fold_supervisor.rs`) starts it, watches it and restarts it.
//!
//! Why a process and not a thread of the node: the engine is a C library
//! running pages' code over a peer's records. A bug or a hang in it, an
//! out-of-memory in the process, a stack overflow, must cost the fold, never
//! the reveal path or the relay; a process can be killed and started again
//! and a thread cannot.
//!
//! The worker never prints: stdout is the frame channel (it starts before the
//! node prints anything, and nothing here uses `println!`). It leaves when its
//! stdin closes, which is how it learns the node is gone, however the node
//! went.
//!
//! ANY ERROR MAKES THE TABLE DIRTY (see `house_fold.rs`): the answer is
//! `Dirty` and the table has no context until the node sends a `Cold` again.
//! A panic anywhere in a call is caught: the worker starts its engine over
//! (every table dirty, since after a panic nothing in the old runtime can be
//! trusted) and answers `Dirty` for the table it was folding.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::fold_wire::{decode_req, encode_resp, read_frame, result_too_big, write_frame, Cold, Req, Resp, Warm, WireError};
use crate::house_bytes::Ctx;
use crate::house_fold::{strict_check, CheckFn, FoldEngine, FoldError};

/// The argument that makes the node binary a fold worker.
pub const WORKER_ARG: &str = "--fold-worker";

/// Whether this process was started as a fold worker.
pub fn is_worker_invocation() -> bool {
    std::env::args_os().nth(1).is_some_and(|a| a == WORKER_ARG)
}

/// What the worker folds with: the engine, or a stand-in in tests.
pub trait Folder {
    /// Fold the table from scratch; the result text, or why it is dirty.
    fn cold(&mut self, c: &Cold) -> Result<String, String>;
    /// Fold what changed in a table already held; the result text, or why it is dirty.
    fn warm(&mut self, w: &Warm) -> Result<String, String>;
    /// Drop a table.
    fn forget(&mut self, ctx: &Ctx);
    /// After a panic: start over with nothing held. `false`: it cannot.
    fn recover(&mut self) -> bool;
}

/// A table: the room, its id and the incarnation.
type Key = (String, String, String);

fn key(ctx: &Ctx) -> Key {
    (ctx.room.clone(), ctx.t.clone(), ctx.inc.clone())
}

/// The houses and pins a table was last given, so a `Warm` that repeats them
/// costs nothing.
type Given = (Vec<String>, Vec<(String, String)>);

/// The real one: a [`FoldEngine`].
pub struct EngineFolder {
    engine: FoldEngine,
    new_check: Box<dyn Fn() -> CheckFn>,
    given: HashMap<Key, Given>,
}

impl EngineFolder {
    /// An engine whose signatures are checked by `new_check()` (the node's: [`strict_check`]).
    pub fn new(new_check: Box<dyn Fn() -> CheckFn>) -> Result<EngineFolder, FoldError> {
        Ok(EngineFolder { engine: FoldEngine::new(new_check())?, new_check, given: HashMap::new() })
    }

    /// The worker's: the pages' strict signature check.
    pub fn strict() -> Result<EngineFolder, FoldError> {
        EngineFolder::new(Box::new(strict_check))
    }

    /// An error is the table's: its context is gone (the engine dropped it) and so is what we knew of it.
    fn fail(&mut self, ctx: &Ctx, e: FoldError) -> String {
        self.given.remove(&key(ctx));
        e.to_string()
    }

    /// Forget what was given for tables the engine no longer holds: it lets the least recently
    /// used go to make room, and says nothing.
    fn prune(&mut self) {
        let engine = &self.engine;
        self.given.retain(|k, _| engine.is_open(&Ctx { room: k.0.clone(), t: k.1.clone(), inc: k.2.clone() }));
    }
}

impl Folder for EngineFolder {
    fn cold(&mut self, c: &Cold) -> Result<String, String> {
        let run = |e: &mut FoldEngine| -> Result<String, FoldError> {
            e.open(&c.ctx, c.base.as_ref(), &c.houses, &c.pins)?;
            e.reset(&c.ctx, &c.records)?;
            e.result_text(&c.ctx)
        };
        let done = match run(&mut self.engine) {
            Ok(text) => {
                self.given.insert(key(&c.ctx), (c.houses.clone(), c.pins.clone()));
                Ok(text)
            }
            Err(e) => Err(self.fail(&c.ctx, e)),
        };
        // Opening a table may have put another out, whether or not this one folded.
        self.prune();
        done
    }

    fn warm(&mut self, w: &Warm) -> Result<String, String> {
        // The engine may have let the table go to make room for another.
        if !self.engine.is_open(&w.ctx) {
            return Err(self.fail(&w.ctx, FoldError::NoTable));
        }
        let given = self.given.get(&key(&w.ctx)).cloned().unwrap_or_default();
        let run = |e: &mut FoldEngine| -> Result<String, FoldError> {
            if given.0 != w.houses {
                e.set_houses(&w.ctx, &w.houses)?;
            }
            if given.1 != w.pins {
                e.set_pins(&w.ctx, &w.pins)?;
            }
            e.apply(&w.ctx, &w.changes)?;
            e.result_text(&w.ctx)
        };
        match run(&mut self.engine) {
            Ok(text) => {
                self.given.insert(key(&w.ctx), (w.houses.clone(), w.pins.clone()));
                Ok(text)
            }
            Err(e) => Err(self.fail(&w.ctx, e)),
        }
    }

    fn forget(&mut self, ctx: &Ctx) {
        self.engine.forget(ctx);
        self.given.remove(&key(ctx));
    }

    fn recover(&mut self) -> bool {
        match FoldEngine::new((self.new_check)()) {
            Ok(e) => {
                self.engine = e;
                self.given.clear();
                true
            }
            Err(_) => false,
        }
    }
}

/// The longest reason a table is dirty that is sent back. It is for the log; a long one would
/// push an answer past the frame it must always fit (with the ids of at most
/// [`MAX_CTX_FIELD`](crate::fold_wire::MAX_CTX_FIELD) bytes each, a `Dirty` is a few KiB).
pub const MAX_REASON: usize = 1 << 10;

/// `reason`, cut to [`MAX_REASON`] bytes at a character, with a mark where it was cut.
fn short_reason(mut reason: String) -> String {
    if reason.len() <= MAX_REASON {
        return reason;
    }
    let mut end = MAX_REASON;
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    reason.truncate(end);
    reason.push('…');
    reason
}

/// The text of a panic's payload.
fn panic_text(p: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "a panic".to_string()
    }
}

/// One request's answer (none for a `Forget`). A panic is caught here.
fn answer<F: Folder>(f: &mut F, req: Req) -> io::Result<Option<Resp>> {
    let (ctx, version, run): (Ctx, u64, Result<Result<String, String>, Box<dyn std::any::Any + Send>>) = match &req {
        Req::Forget { ctx } => {
            if let Err(p) = catch_unwind(AssertUnwindSafe(|| f.forget(ctx))) {
                return panic_recovery(f, panic_text(p)).map(|()| None);
            }
            return Ok(None);
        }
        Req::Cold(c) => (c.ctx.clone(), c.version, catch_unwind(AssertUnwindSafe(|| f.cold(c)))),
        Req::Warm(w) => (w.ctx.clone(), w.version, catch_unwind(AssertUnwindSafe(|| f.warm(w)))),
    };
    Ok(Some(match run {
        Ok(Ok(text)) => Resp::Result { ctx, version, text },
        Ok(Err(reason)) => Resp::Dirty { ctx, version, reason: short_reason(reason) },
        Err(p) => {
            let reason = short_reason(format!("panic: {}", panic_text(p)));
            panic_recovery(f, reason.clone())?;
            Resp::Dirty { ctx, version, reason }
        }
    }))
}

/// After a panic: start over, or give up (the process ends and the node restarts it).
fn panic_recovery<F: Folder>(f: &mut F, reason: String) -> io::Result<()> {
    if f.recover() {
        Ok(())
    } else {
        Err(io::Error::other(format!("fold worker cannot start its engine again after: {reason}")))
    }
}

/// Answer requests from `r` on `w` until the node closes the pipe (`Ok`) or
/// sends something that is not a frame (`Err`: the process ends, and the node,
/// which sent it, treats that as the worker's crash).
pub fn serve<R: Read, W: Write, F: Folder>(r: &mut R, w: &mut W, f: &mut F) -> io::Result<()> {
    while let Some(body) = read_frame(r)? {
        let req = decode_req(&body)?;
        if let Some(resp) = answer(f, req)? {
            let frame = match encode_resp(&resp) {
                Ok(frame) => frame,
                // A result past what a frame holds: the table is dirty, so it is dropped here
                // too (Dirty means no context is held until a new Cold), and the node asks
                // again from scratch, or gives up on the table.
                Err(WireError::BadSize(n)) => {
                    let ctx = resp.ctx().clone();
                    if let Err(p) = catch_unwind(AssertUnwindSafe(|| f.forget(&ctx))) {
                        panic_recovery(f, panic_text(p))?;
                    }
                    let reason = result_too_big(n);
                    encode_resp(&Resp::Dirty { ctx, version: resp.version(), reason })?
                }
                Err(e) => return Err(e.into()),
            };
            write_frame(w, &frame)?;
        }
    }
    Ok(())
}

/// The process: fold for the node on stdin and stdout until it goes. The exit
/// code: 0 when the node closed the pipe, 2 for a pipe or frame that failed, 3
/// when the engine would not start.
pub fn run_stdio() -> i32 {
    let mut folder = match EngineFolder::strict() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("fold worker: cannot start the engine ({e})");
            return 3;
        }
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    let (mut r, mut w) = (stdin.lock(), stdout.lock());
    match serve(&mut r, &mut w, &mut folder) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("fold worker: {e}");
            2
        }
    }
}

#[cfg(test)]
mod tests;
