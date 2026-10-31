/**
 * 📌 Room boards (#315): the CORKBOARD anyone in the room may post a note on,
 * and the NOTICE CASE behind locked glass where only the room's owner posts
 * official notices and announcements (Dorkmo 2026-10-31).
 *
 * ─── The record ──────────────────────────────────────────────────────────────
 *
 * One room-doc map, `boardNotes`, keyed `<itemId>|<noteId>` (the departures
 * board's per-item pattern: never a top-level type per board, which Yjs can
 * never remove). Each value is a note its AUTHOR signed with their identity
 * key (keypair.ts), the direct-message signing idiom (directMessages.ts) with
 * its own domain tag:
 *
 *   { v: 1, author, authorName, text, colour, x, y, ts, sig, attach? }
 *
 * The signed bytes bind the room and the board too, so a note can't be copied
 * onto another board or into another room. The note id is a hash of those
 * bytes, and a reader requires the key to name it, so a note can't be filed
 * twice under two ids to dodge the caps.
 *
 * ─── Who may post ────────────────────────────────────────────────────────────
 *
 * The furniture kind says it, never a stored setting:
 *  - 'open'  (the corkboard): anyone in the room, with no list. A pass is a
 *    bearer link with no key in it, so "pass holders only" is not something a
 *    reader could check; getting into the room is the gate.
 *  - 'owner' (the notice case): only the room's owner. Every reader drops a
 *    note whose author is not the owner's key, so a modified client can't fake
 *    an announcement. The owner's key comes from main.ts (roomOwnerInfo), today
 *    looked up through the peer-written `players` map (the #141 weak spot); the
 *    pass v3 owner key in TODO.md makes this check solid. An unknown owner key
 *    shows nothing on the case (fail closed).
 *
 * ─── Caps ────────────────────────────────────────────────────────────────────
 *
 * A board shows its newest MAX_BOARD_NOTES verified notes, at most
 * MAX_NOTES_PER_AUTHOR from any one author, so one visitor can't push everyone
 * else's notes off before the owner reads them. Junk that fails verification
 * never counts. Readers visit at most MAX_KEYS_VISITED keys and verify at most
 * MAX_VERIFIED_PER_BOARD notes a board (the DM render cap idiom), and keep
 * verdicts by signature so the face's 1 Hz redraw doesn't re-verify.
 *
 * Trimming the doc (`trimBoard`): deletes what a reader would never show
 * (malformed, unverifiable, past the caps, stamped far in the future). It runs
 * only when the caller says the host's own state has arrived (routeRoomReady),
 * the durability plan's do-not-clean rule (room-durability-plan.md §2); it is
 * safe even on a stale copy, because a note outside the newest 24 of a partial
 * view is outside them in the full one too.
 *
 * ─── Take-downs ──────────────────────────────────────────────────────────────
 *
 * Unpinning a note deletes it AND files a signed take-down beside it in
 * `boardDown` (same key; `<itemId>|*` for the owner's CLEAR, which covers
 * every note stamped at or before it). Needed since board bundles (#315's
 * second PR, ssf-p2p-node board_bundles.rs) carry notes between copies of
 * the room: a copy that had not yet seen a note merges it as a new Yjs item,
 * and a take-down elsewhere deletes only the item IT held, so the merged one
 * could win the key and bring the note back. Every reader drops a note with
 * a valid take-down (by its author, or by the owner), and a merge never
 * brings back a note one names or one this copy already deleted.
 *
 * ─── Board bundles ───────────────────────────────────────────────────────────
 *
 * The local node hands its tabs what other nodes sealed for this room (local
 * lane `board`): their copies' notes and take-downs. `mergeBoardView` checks
 * every one as a reader would and writes only what is new to this copy: on a
 * board the room has, never deleted here, signed, bound and not taken down.
 * It waits for the host's state (routeRoomReady) as a trim does.
 *
 * ─── What this is not ────────────────────────────────────────────────────────
 *
 * Nothing authorizes a write to a room doc today (roomOwner.ts), so a modified
 * client can still DELETE notes, as it can delete furniture. Signatures stop
 * forgery and tampering, not removal; node-enforced write rights (the keyed
 * room id step in TODO.md) close that for every room feature at once.
 *
 * Per-player state stays on the player's machine: which notes they have seen
 * (the glow) and whose notes they hide. Nothing about either is synced.
 *
 * Pure parts (sign bytes, the read rule, the trim plan) take their inputs as
 * arguments and are pinned by boardDoc.test.ts.
 */

import * as Y from 'yjs';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex } from '@noble/hashes/utils';
import { getIdentityPub, signIdentity, verifyIdentityStrict } from './keypair';

// ── Shapes and limits ────────────────────────────────────────────────────────

export const BOARD_NOTES_MAP = 'boardNotes';
/** Signed take-downs, keyed like the notes they take down. */
export const BOARD_DOWN_MAP = 'boardDown';
/** The take-down target of the owner's CLEAR: every note up to its stamp.
 *  Each CLEAR is filed under its own stamp, `<itemId>|*<ts>` (clearKey), so
 *  two copies' CLEARs never race for one key (#332 review: under a shared
 *  key, an older CLEAR merged from a bundle could win it back by client id
 *  and bring back what a newer one cleared). Its signature names `*`. */
export const CLEAR_TARGET = '*';
/** Take-downs a board keeps (the newest valid ones; a CLEAR besides). */
export const MAX_DOWN_PER_BOARD = 128;
/** Characters a note's text may hold (DMs take 500; a sticky note is smaller). */
export const MAX_NOTE_TEXT = 280;
/** Notes a board shows; the oldest falls off. */
export const MAX_BOARD_NOTES = 24;
/** Live notes one author keeps on one board; a fourth replaces their oldest. */
export const MAX_NOTES_PER_AUTHOR = 3;
/** Signatures checked per board per read: newest first, so the shown set is
 *  always reached long before this unless the board is being flooded. */
export const MAX_VERIFIED_PER_BOARD = 64;
/** Keys a reader visits in the map (four boards' worth of notes and junk). */
export const MAX_KEYS_VISITED = 512;
/** How far ahead of the reader's clock a note's stamp may sit and still show. */
export const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
/** Past this, a future stamp is junk a trim removes (it would wait forever). */
export const TRIM_FUTURE_MS = 24 * 3600 * 1000;
const MAX_NAME = 32;
const MAX_ID = 128;
/** A photo reference's caption, and its declared size cap (issue 319's shots
 *  are ~40–60 KB JPEGs; this only bounds what a record may claim). */
/** Boards a room may hold (the dev menu's placement refuses a fifth), which
 *  keeps a room's notes far under roomCache.ts's 1 MB per-room cap. */
export const MAX_BOARDS_PER_ROOM = 4;
/** A take-down is kept at least this long, past the count above (#332
 *  review): longer than a bundle lives (14 days), so no bundle sealed before
 *  it, and no copy offline for less than this, can bring its note back. */
export const DOWN_KEEP_MS = 30 * 24 * 3600 * 1000;
/** Take-downs a board keeps at most, however young: the newest verified. */
export const MAX_DOWN_RETAINED = 256;
/** Signatures a take-down trim checks per board: past them, the rest wait
 *  for a later trim, neither kept nor trimmed. */
const MAX_DOWN_CHECKS = 2 * MAX_DOWN_RETAINED;
/** CLEARs a reader checks per board, newest first (the trim keeps one). */
const MAX_CLEAR_CHECKS = 8;
/** Keys the take-down trim visits: every board's retained ones, and junk. */
const MAX_DOWN_KEYS_VISITED = MAX_BOARDS_PER_ROOM * MAX_DOWN_RETAINED + MAX_KEYS_VISITED;

export const MAX_PHOTO_CAPTION = 80;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const BOARD_COLOURS = ['yellow', 'pink', 'blue', 'green', 'orange', 'white'] as const;
export type BoardColour = (typeof BOARD_COLOURS)[number];

/** 'open' = the corkboard (anyone posts); 'owner' = the notice case. */
export type BoardKind = 'open' | 'owner';

/** The furniture kinds that are boards, and who may post on each. */
export const BOARD_KINDS: Readonly<Record<string, BoardKind>> = {
  corkboard: 'open',
  'notice-case': 'owner',
};

export function boardKindOf(furnitureKind: string | undefined): BoardKind | null {
  return furnitureKind !== undefined && Object.prototype.hasOwnProperty.call(BOARD_KINDS, furnitureKind)
    ? BOARD_KINDS[furnitureKind]
    : null;
}

/** 📷 A photo on a note (#319's CAMERA app): the TV's blob reference
 *  (tvDoc.ts sanitizeSource) plus the shot's own lines. The bytes never enter
 *  the doc; they stay on the blob lane (blobLane.ts). Signed with the note,
 *  so nobody can swap the photo on someone else's note. v1 posts only the
 *  author's own shots, so the signature vouches for "taken by". */
export interface BoardPhoto {
  kind: 'blob';
  hash: string;
  size: number;
  provider: string;
  mime: string;
  takenAt: number;
  caption?: string;
}

export interface BoardNote {
  v: 1;
  /** base64url Ed25519 public key of the author. */
  author: string;
  authorName: string;
  text: string;
  colour: BoardColour;
  /** Where the note sits on the board face, as fractions 0..1 of its width
   *  and height (the note's centre). */
  x: number;
  y: number;
  /** The author's clock when they posted. */
  ts: number;
  sig: string;
  attach?: BoardPhoto;
}

/** A note as a reader shows it: verified, with its id. */
export interface ShownNote extends BoardNote {
  id: string;
}

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
/** Printable text: newlines allowed, other control characters not. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** Clean a note's text for posting: trimmed, control characters out. */
export function cleanNoteText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
}

/** A name as a note can carry it: no control characters or line breaks
 *  (the shape check refuses them, and a saved name is only whitespace-
 *  normalized, so a pasted one can hold them), at most MAX_NAME units and
 *  never half of a surrogate pair. Empty becomes 'Clone'. */
export function cleanAuthorName(raw: string): string {
  let name = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (/[\ud800-\udbff]$/.test(name)) name = name.slice(0, -1);
  return name.trim() || 'Clone';
}

/** A photo reference as a record may carry it, or null. */
export function photoFromWire(raw: unknown): BoardPhoto | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'blob') return null;
  if (typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash)) return null;
  if (typeof r.provider !== 'string' || !/^[0-9a-f]{64}$/.test(r.provider)) return null;
  if (!Number.isSafeInteger(r.size) || (r.size as number) <= 0 || (r.size as number) > MAX_PHOTO_BYTES) return null;
  if (typeof r.mime !== 'string' || !PHOTO_MIMES.has(r.mime)) return null;
  if (!Number.isSafeInteger(r.takenAt) || (r.takenAt as number) <= 0) return null;
  const photo: BoardPhoto = {
    kind: 'blob',
    hash: r.hash,
    size: r.size as number,
    provider: r.provider,
    mime: r.mime,
    takenAt: r.takenAt as number,
  };
  if (r.caption !== undefined) {
    if (!isStr(r.caption, MAX_PHOTO_CAPTION) || CONTROL.test(r.caption) || r.caption.includes('\n')) return null;
    if (r.caption) photo.caption = r.caption;
  }
  return photo;
}

/** A stored value's note fields, shape-checked (signature NOT checked), or
 *  null. Fails closed: an unknown version, field or range reads as junk. */
export function noteFromWire(raw: unknown): BoardNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (!isStr(r.author, MAX_ID) || r.author.length === 0) return null;
  if (!isStr(r.authorName, MAX_NAME) || CONTROL.test(r.authorName) || r.authorName.includes('\n')) return null;
  if (!isStr(r.text, MAX_NOTE_TEXT) || CONTROL.test(r.text) || r.text.trim().length === 0) return null;
  if (typeof r.colour !== 'string' || !(BOARD_COLOURS as readonly string[]).includes(r.colour)) return null;
  if (!isUnit(r.x) || !isUnit(r.y)) return null;
  if (!Number.isSafeInteger(r.ts) || (r.ts as number) <= 0) return null;
  if (!isStr(r.sig, 128) || r.sig.length === 0) return null;
  const note: BoardNote = {
    v: 1,
    author: r.author,
    authorName: r.authorName,
    text: r.text,
    colour: r.colour as BoardColour,
    x: r.x,
    y: r.y,
    ts: r.ts as number,
    sig: r.sig,
  };
  if (r.attach !== undefined) {
    const photo = photoFromWire(r.attach);
    if (!photo) return null;
    note.attach = photo;
  }
  return note;
}

// ── Signing ──────────────────────────────────────────────────────────────────

type Unsigned = Omit<BoardNote, 'sig'>;

/** The canonical bytes an author signs: the note's fields with the room and
 *  board they were posted to, in one fixed order. */
export function noteSignBytes(roomId: string, itemId: string, n: Unsigned): Uint8Array {
  const a = n.attach;
  return new TextEncoder().encode(JSON.stringify({
    k: 'ssf-board-note:v1',
    roomId,
    itemId,
    author: n.author,
    authorName: n.authorName,
    text: n.text,
    colour: n.colour,
    x: n.x,
    y: n.y,
    ts: n.ts,
    attach: a
      ? { kind: a.kind, hash: a.hash, size: a.size, provider: a.provider, mime: a.mime, takenAt: a.takenAt, caption: a.caption ?? '' }
      : null,
  }));
}

/** A note's id: the first 32 hex of the hash of its signed bytes. */
export function noteIdOf(roomId: string, itemId: string, n: Unsigned): string {
  return bytesToHex(sha512(noteSignBytes(roomId, itemId, n))).slice(0, 32);
}

export function noteKey(itemId: string, noteId: string): string {
  return `${itemId}|${noteId}`;
}

/** A take-down: who took a note down (its author, or the room's owner) and
 *  when. Its signature binds the room, the board and the note id. */
export interface BoardDown {
  v: 1;
  by: string;
  ts: number;
  sig: string;
}

export function downSignBytes(roomId: string, itemId: string, target: string, by: string, ts: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ k: 'ssf-board-down:v1', roomId, itemId, target, by, ts }));
}

export function downFromWire(raw: unknown): BoardDown | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (!isStr(r.by, MAX_ID) || r.by.length === 0) return null;
  if (!Number.isSafeInteger(r.ts) || (r.ts as number) <= 0) return null;
  if (!isStr(r.sig, 128) || r.sig.length === 0) return null;
  return { v: 1, by: r.by, ts: r.ts as number, sig: r.sig };
}

/** A take-down's target from its key: a note id, or a CLEAR's `*<ts>`. */
const TARGET_RE = /^(?:[0-9a-f]{32}|\*[1-9][0-9]{0,15})$/;

/** The key a CLEAR stamped `ts` is filed under. */
export function clearKey(itemId: string, ts: number): string {
  return `${itemId}|${CLEAR_TARGET}${ts}`;
}

function isClearTarget(target: string): boolean {
  return target.startsWith(CLEAR_TARGET);
}

/** Who signs: the local identity by default; tests hand in their own. */
export interface NoteSigner {
  pub: string;
  sign(bytes: Uint8Array): string;
}

export const localSigner = (): NoteSigner => ({ pub: getIdentityPub(), sign: (b) => signIdentity(b) });

/** Build and sign a note. Positions are rounded to 1/1000 so the stored
 *  number is the signed one on every page. */
export function signNote(
  roomId: string,
  itemId: string,
  fields: { authorName: string; text: string; colour: BoardColour; x: number; y: number; ts: number; attach?: BoardPhoto },
  signer: NoteSigner,
): { id: string; note: BoardNote } {
  const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  const unsigned: Unsigned = {
    v: 1,
    author: signer.pub,
    authorName: cleanAuthorName(fields.authorName),
    text: fields.text,
    colour: fields.colour,
    x: round(fields.x),
    y: round(fields.y),
    ts: Math.floor(fields.ts),
  };
  if (fields.attach) unsigned.attach = fields.attach;
  const sig = signer.sign(noteSignBytes(roomId, itemId, unsigned));
  return { id: noteIdOf(roomId, itemId, unsigned), note: { ...unsigned, sig } };
}

export function signDown(roomId: string, itemId: string, target: string, ts: number, signer: NoteSigner): BoardDown {
  const at = Math.floor(ts);
  return { v: 1, by: signer.pub, ts: at, sig: signer.sign(downSignBytes(roomId, itemId, target, signer.pub, at)) };
}

// ── The read rule (pure) ─────────────────────────────────────────────────────

export interface ReadCtx {
  roomId: string;
  kind: BoardKind;
  now: number;
  /** The owner's identity key, needed for a notice case. */
  ownerPub?: string;
  /** Signature check (verifyIdentityStrict by default; cached by the store). */
  verify?: (pub: string, bytes: Uint8Array, sig: string) => boolean;
  /** The take-down filed under a key, if any (the `boardDown` map). */
  downOf?: (key: string) => unknown;
  /** The note filed under a key, if any (the `boardNotes` map): the trim
   *  judges a take-down of a note it holds by that note's author. */
  noteOf?: (key: string) => unknown;
  /** A board's CLEARs as filed (`[clearKey, record]`), any order. */
  clearsOf?: (itemId: string) => Iterable<[string, unknown]>;
}

/** The author a note filed under a key names, when it is filed under its own
 *  id. The id hashes the author, so this needs no signature check: whatever
 *  is filed under that id, it is that author's note or junk. */
function authorOf(raw: unknown, roomId: string, itemId: string, id: string): string | undefined {
  if (raw === undefined) return undefined;
  const note = noteFromWire(raw);
  return note && noteIdOf(roomId, itemId, note) === id ? note.author : undefined;
}

/** The owner's newest valid CLEAR on a board, or null: the owner's, filed
 *  under its own stamp, its signature checked newest first. */
export function newestClear(itemId: string, ctx: ReadCtx): BoardDown | null {
  if (!ctx.ownerPub) return null;
  const verify = ctx.verify ?? verifyIdentityStrict;
  const found: BoardDown[] = [];
  for (const [key, raw] of ctx.clearsOf?.(itemId) ?? []) {
    const d = downFromWire(raw);
    if (d && d.by === ctx.ownerPub && key === clearKey(itemId, d.ts)) found.push(d);
  }
  found.sort((a, b) => b.ts - a.ts);
  for (const d of found.slice(0, MAX_CLEAR_CHECKS)) {
    if (verify(d.by, downSignBytes(ctx.roomId, itemId, CLEAR_TARGET, d.by, d.ts), d.sig)) return d;
  }
  return null;
}

/** The stamp up to which the owner's CLEAR covers a board's notes, or -1.
 *  Only the owner's signed CLEAR counts, the newest of them, and never
 *  further ahead than a note may sit: a CLEAR far in the future would hide
 *  every note until then. */
export function clearStampOf(itemId: string, ctx: ReadCtx): number {
  const d = newestClear(itemId, ctx);
  return d ? Math.min(d.ts, ctx.now + MAX_FUTURE_SKEW_MS) : -1;
}

/** Whether a note has a valid take-down: signed by its author, or by the
 *  owner. Costs a signature check when one is filed. */
export function isTakenDown(key: string, itemId: string, id: string, note: BoardNote, ctx: ReadCtx): boolean {
  const raw = ctx.downOf?.(key);
  if (raw === undefined) return false;
  const d = downFromWire(raw);
  if (!d || !(d.by === note.author || (!!ctx.ownerPub && d.by === ctx.ownerPub))) return false;
  const verify = ctx.verify ?? verifyIdentityStrict;
  return verify(d.by, downSignBytes(ctx.roomId, itemId, id, d.by, d.ts), d.sig);
}

export interface BoardRead {
  /** What the board shows, newest first. */
  shown: ShownNote[];
  /** Keys a trim may delete: junk, unverifiable, past the caps, or stamped
   *  far in the future. Never a note that is only a little ahead. */
  trimmable: string[];
}

/**
 * The board's notes from a map's entries. Shape check, id check, the post
 * rule, then signatures newest first until the caps are met.
 */
export function readBoardEntries(
  entries: Iterable<[string, unknown]>,
  itemId: string,
  ctx: ReadCtx,
): BoardRead {
  const verify = ctx.verify ?? verifyIdentityStrict;
  const prefix = `${itemId}|`;
  const trimmable: string[] = [];
  const candidates: Array<{ key: string; id: string; note: BoardNote }> = [];
  let visited = 0;
  for (const [key, value] of entries) {
    if (++visited > MAX_KEYS_VISITED) break;
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    const note = noteFromWire(value);
    if (!note || noteIdOf(ctx.roomId, itemId, note) !== id) {
      trimmable.push(key);
      continue;
    }
    if (note.ts > ctx.now + MAX_FUTURE_SKEW_MS) {
      if (note.ts > ctx.now + TRIM_FUTURE_MS) trimmable.push(key);
      continue;
    }
    if (ctx.kind === 'owner') {
      // Fail closed: no owner key, no notices (and nothing trimmed for it —
      // the key may simply not have synced yet).
      if (!ctx.ownerPub) continue;
      if (note.author !== ctx.ownerPub) {
        trimmable.push(key);
        continue;
      }
    }
    candidates.push({ key, id, note });
  }
  // Newest first; ties broken by id so every page orders them the same.
  candidates.sort((a, b) => b.note.ts - a.note.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const shown: ShownNote[] = [];
  const perAuthor = new Map<string, number>();
  const cleared = clearStampOf(itemId, { ...ctx, verify });
  let checked = cleared >= 0 ? 1 : 0;
  for (const c of candidates) {
    if (c.note.ts <= cleared) {
      trimmable.push(c.key); // the owner cleared the board after it
      continue;
    }
    if (shown.length >= MAX_BOARD_NOTES) {
      trimmable.push(c.key);
      continue;
    }
    const count = perAuthor.get(c.note.author) ?? 0;
    if (count >= MAX_NOTES_PER_AUTHOR) {
      trimmable.push(c.key);
      continue;
    }
    if (checked >= MAX_VERIFIED_PER_BOARD) continue; // unchecked: neither shown nor trimmed
    if (ctx.downOf?.(c.key) !== undefined) {
      checked++;
      if (isTakenDown(c.key, itemId, c.id, c.note, { ...ctx, verify })) {
        trimmable.push(c.key);
        continue;
      }
      if (checked >= MAX_VERIFIED_PER_BOARD) continue;
    }
    checked++;
    const { sig, ...unsigned } = c.note;
    if (!verify(c.note.author, noteSignBytes(ctx.roomId, itemId, unsigned), sig)) {
      trimmable.push(c.key);
      continue;
    }
    perAuthor.set(c.note.author, count + 1);
    shown.push({ ...c.note, id: c.id });
  }
  return { shown, trimmable };
}

/** The take-downs a trim may delete on a board: junk, a CLEAR not the
 *  owner's or older than the newest valid one, a bad signature, one of a note this copy holds by neither its
 *  author nor the owner, or one past the newest MAX_DOWN_PER_BOARD that is
 *  also older than DOWN_KEEP_MS (and any past MAX_DOWN_RETAINED). A
 *  take-down whose note is gone is KEPT: it is what stops a copy that never
 *  saw the take-down from bringing the note back. */
export function planDownTrim(entries: Iterable<[string, unknown]>, itemId: string, ctx: ReadCtx): string[] {
  const verify = ctx.verify ?? verifyIdentityStrict;
  const prefix = `${itemId}|`;
  const trimmable: string[] = [];
  const valid: Array<{ key: string; d: BoardDown }> = [];
  const clears: Array<{ key: string; d: BoardDown }> = [];
  let visited = 0;
  for (const [key, value] of entries) {
    if (++visited > MAX_DOWN_KEYS_VISITED) break;
    if (!key.startsWith(prefix)) continue;
    const target = key.slice(prefix.length);
    const d = downFromWire(value);
    if (!d || !TARGET_RE.test(target)) {
      trimmable.push(key);
      continue;
    }
    if (isClearTarget(target)) {
      if (key !== clearKey(itemId, d.ts)) trimmable.push(key); // filed under another stamp
      else clears.push({ key, d });
      continue;
    }
    // A take-down of a note this copy holds counts only by its author or the
    // owner (#332 review): anyone else's would sit on the key for nothing.
    if (ctx.ownerPub) {
      const author = authorOf(ctx.noteOf?.(key), ctx.roomId, itemId, target);
      if (author !== undefined && d.by !== author && d.by !== ctx.ownerPub) {
        trimmable.push(key);
        continue;
      }
    }
    valid.push({ key, d });
  }
  // Newest first; a stamp ahead of the clock counts as now, so a take-down
  // stamped far ahead can't push the real ones out.
  const at = (d: BoardDown) => Math.min(d.ts, ctx.now);
  valid.sort((a, b) => at(b.d) - at(a.d) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Only verified take-downs count toward either limit (#332 review): junk
  // stamped ahead of a real take-down can't push it out.
  let kept = 0;
  let checked = 0;
  for (const { key, d } of valid) {
    if (kept >= MAX_DOWN_RETAINED || (kept >= MAX_DOWN_PER_BOARD && ctx.now - d.ts >= DOWN_KEEP_MS)) {
      trimmable.push(key);
      continue;
    }
    if (checked >= MAX_DOWN_CHECKS) continue; // unchecked: neither kept nor trimmed
    checked++;
    const target = key.slice(prefix.length);
    if (verify(d.by, downSignBytes(ctx.roomId, itemId, target, d.by, d.ts), d.sig)) kept++;
    else trimmable.push(key);
  }
  // A board keeps its newest valid CLEAR, which covers all an older one
  // did. Judged only once the owner's key is known.
  if (ctx.ownerPub) {
    clears.sort((a, b) => b.d.ts - a.d.ts);
    let found = false;
    let checks = 0;
    for (const { key, d } of clears) {
      if (found || d.by !== ctx.ownerPub) {
        trimmable.push(key);
        continue;
      }
      if (checks++ >= MAX_CLEAR_CHECKS) continue; // unchecked: neither kept nor trimmed
      if (verify(d.by, downSignBytes(ctx.roomId, itemId, CLEAR_TARGET, d.by, d.ts), d.sig)) found = true;
      else trimmable.push(key);
    }
  }
  return trimmable;
}

/** A free spot for a new note on the face: the first of 24 slots (6 × 4)
 *  whose centre no shown note sits near, else a slot by count. A little jitter
 *  so the board looks pinned by hand. Pure: `rand` is in [0, 1). */
export function freeSpot(shown: readonly { x: number; y: number }[], rand: () => number): { x: number; y: number } {
  const COLS = 6;
  const ROWS = 4;
  const slots: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) slots.push({ x: (c + 0.5) / COLS, y: (r + 0.5) / ROWS });
  const taken = (s: { x: number; y: number }) =>
    shown.some((n) => Math.abs(n.x - s.x) < 0.5 / COLS && Math.abs(n.y - s.y) < 0.5 / ROWS);
  const slot = slots.find((s) => !taken(s)) ?? slots[shown.length % slots.length];
  const jitter = (span: number) => (rand() - 0.5) * span;
  return {
    x: Math.min(1, Math.max(0, slot.x + jitter(0.3 / COLS))),
    y: Math.min(1, Math.max(0, slot.y + jitter(0.3 / ROWS))),
  };
}

// ── The bound store ──────────────────────────────────────────────────────────

export interface BoardDeps {
  /** The current room's id (what notes are signed into). */
  roomId: () => string;
  /** The room owner's identity key, when known. */
  ownerPub: () => string | undefined;
  /** The local player holds the room's deed (owner controls). */
  isOwner: () => boolean;
  /** Our display name. */
  myName: () => string;
  /** The host's own state has arrived (routeKeeper.routeRoomReady: a frame
   *  from the live host, or this machine's node for a room it hosts): trims
   *  and bundle merges may run. */
  canTrim: () => boolean;
  /** Which board an item of the room's furniture is, if it is one (bundle
   *  merges write only to boards the room has). */
  boardOfItem?: (itemId: string) => BoardKind | null;
}

let deps: BoardDeps | null = null;
let boundDoc: Y.Doc | null = null;
let notesMap: Y.Map<unknown> | null = null;
let downMap: Y.Map<unknown> | null = null;
let version = 0;
const listeners = new Set<() => void>();
/** Signature verdicts, by key, signature AND a hash of the signed bytes:
 *  the face redraws every second. The bytes belong in the key (#330 review):
 *  keyed by signature alone, a peer could change a note's text, re-file it
 *  under the id its new bytes hash to, keep the old signature and be handed
 *  the genuine note's cached `true`. */
const verdicts = new Map<string, boolean>();
const MAX_VERDICTS = 2048;

export function setBoardDeps(d: BoardDeps | null): void {
  deps = d;
  notify();
}

function notify(): void {
  version++;
  for (const l of [...listeners]) {
    try { l(); } catch (e) { console.error('[boards] listener threw:', e); }
  }
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && notesMap !== null && downMap !== null;
}

/** Bind the room doc: main.ts's room-join seam, beside bindDeparturesDoc. */
export function bindBoardDoc(doc: Y.Doc): void {
  boundDoc = doc;
  notesMap = doc.getMap(BOARD_NOTES_MAP);
  downMap = doc.getMap(BOARD_DOWN_MAP);
  notesMap.observe(() => notify());
  downMap.observe(() => notify());
  pendingView = null;
  cancelRetry();
  notify();
}

/** Something a board's read depends on changed outside the map (the owner's
 *  key arrived, the deed moved): drop the cached reads. */
export function refreshBoards(): void {
  readCache = null;
  notify();
  // Entries that waited for the owner's key may be judged now. On a timer,
  // never here: this runs inside the doc's own observers.
  if (pendingView) scheduleRetry();
}

export function subscribeBoards(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bumps whenever any board, the deps or the local seen/hidden state change. */
export function boardsVersion(): number {
  return version;
}

const cachedVerify = (pub: string, bytes: Uint8Array, sig: string): boolean => {
  const key = `${pub}|${sig}|${bytesToHex(sha512(bytes)).slice(0, 32)}`;
  const hit = verdicts.get(key);
  if (hit !== undefined) return hit;
  const ok = verifyIdentityStrict(pub, bytes, sig);
  verdicts.set(key, ok);
  while (verdicts.size > MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value as string);
  return ok;
};

let readCache: { version: number; doc: Y.Doc | null; at: number; reads: Map<string, BoardRead> } | null = null;

/** A board's read (shown notes and trimmable keys), cached until the map
 *  changes or a few seconds pass (the future-skew window moves with time). */
export function readBoard(itemId: string, kind: BoardKind): BoardRead {
  if (!docAlive() || !deps) return { shown: [], trimmable: [] };
  const now = Date.now();
  if (!readCache || readCache.version !== version || readCache.doc !== boundDoc || now - readCache.at > 5_000) {
    readCache = { version, doc: boundDoc, at: now, reads: new Map() };
  }
  const cacheKey = `${kind}|${itemId}`;
  const hit = readCache.reads.get(cacheKey);
  if (hit) return hit;
  const read = readBoardEntries(notesMap!.entries(), itemId, readCtx(kind, now));
  readCache.reads.set(cacheKey, read);
  return read;
}

function readCtx(kind: BoardKind, now: number): ReadCtx {
  const down = downMap!;
  const notes = notesMap!;
  return {
    roomId: deps!.roomId(), kind, now, ownerPub: deps!.ownerPub(), verify: cachedVerify,
    downOf: (k) => down.get(k), noteOf: (k) => notes.get(k), clearsOf: (itemId) => clearEntriesIn(down, itemId),
  };
}

/** A board's CLEARs in a take-down map, as filed. */
function clearEntriesIn(map: Y.Map<unknown>, itemId: string): Array<[string, unknown]> {
  const prefix = `${itemId}|${CLEAR_TARGET}`;
  const out: Array<[string, unknown]> = [];
  let visited = 0;
  for (const [key, value] of map.entries()) {
    if (++visited > MAX_DOWN_KEYS_VISITED) break;
    if (key.startsWith(prefix)) out.push([key, value]);
  }
  return out;
}

/** Whether the local player may post on a board of this kind. */
export function canPost(kind: BoardKind): boolean {
  if (!deps || !docAlive()) return false;
  return kind === 'open' || deps.isOwner();
}

/** Whether the local player may unpin anyone's note and clear the board. */
export function canModerate(): boolean {
  return !!deps && docAlive() && deps.isOwner();
}

export type PostResult = { ok: true; id: string } | { ok: false; why: string };

/** Post a note. Keeps the author's own count under the cap by taking down
 *  their oldest note on this board, then trims when the host has answered. */
export function postNote(
  itemId: string,
  kind: BoardKind,
  input: { text: string; colour: BoardColour; attach?: BoardPhoto },
  signer: NoteSigner = localSigner(),
  rand: () => number = Math.random,
): PostResult {
  if (!deps || !docAlive()) return { ok: false, why: 'This board is not loaded yet.' };
  if (!canPost(kind)) return { ok: false, why: 'Only the room owner can post in the notice case.' };
  if (itemId.length === 0 || itemId.length > MAX_ID || itemId.includes('|')) return { ok: false, why: 'This board has no id.' };
  const text = cleanNoteText(input.text);
  if (!text) return { ok: false, why: 'Write something first.' };
  if (text.length > MAX_NOTE_TEXT) return { ok: false, why: `A note holds up to ${MAX_NOTE_TEXT} characters.` };
  if (!(BOARD_COLOURS as readonly string[]).includes(input.colour)) return { ok: false, why: 'Pick a colour.' };
  const photo = input.attach ? photoFromWire(input.attach) : null;
  if (input.attach && !photo) return { ok: false, why: 'That photo can’t be pinned.' };
  const before = readBoard(itemId, kind);
  const spot = freeSpot(before.shown, rand);
  // Never at or before the owner's last CLEAR, which a clock a little
  // behind theirs would otherwise put the new note under.
  const ts = Math.max(Date.now(), clearStampOf(itemId, readCtx(kind, Date.now())) + 1);
  const { id, note } = signNote(
    deps.roomId(),
    itemId,
    { authorName: deps.myName(), text, colour: input.colour, x: spot.x, y: spot.y, ts, ...(photo ? { attach: photo } : {}) },
    signer,
  );
  const mine = before.shown.filter((n) => n.author === signer.pub).sort((a, b) => a.ts - b.ts);
  const excess = mine.length + 1 - MAX_NOTES_PER_AUTHOR;
  boundDoc!.transact(() => {
    notesMap!.set(noteKey(itemId, id), note);
    for (let i = 0; i < excess; i++) notesMap!.delete(noteKey(itemId, mine[i].id));
  });
  trimBoard(itemId, kind);
  return { ok: true, id };
}

/** Take a note down: the author's own, or any note for the owner. Files a
 *  signed take-down beside the deletion, so no copy of the room brings it
 *  back. */
export function takeDownNote(itemId: string, noteId: string, kind: BoardKind, signer: NoteSigner = localSigner()): boolean {
  if (!deps || !docAlive()) return false;
  const note = readBoard(itemId, kind).shown.find((n) => n.id === noteId);
  if (!note) return false;
  if (note.author !== signer.pub && !canModerate()) return false;
  const key = noteKey(itemId, noteId);
  const down = signDown(deps.roomId(), itemId, noteId, Date.now(), signer);
  boundDoc!.transact(() => {
    downMap!.set(key, down);
    notesMap!.delete(key);
  });
  return true;
}

/** The owner clears a board: every key filed under it, and a signed CLEAR
 *  stamped after the newest of them so it covers each copy's notes too. */
export function clearBoard(itemId: string, signer: NoteSigner = localSigner()): boolean {
  if (!deps || !canModerate()) return false;
  const prefix = `${itemId}|`;
  const keys: string[] = [];
  let newest = 0;
  let visited = 0;
  for (const [key, value] of notesMap!.entries()) {
    if (++visited > 4 * MAX_KEYS_VISITED) break;
    if (!key.startsWith(prefix)) continue;
    keys.push(key);
    newest = Math.max(newest, noteFromWire(value)?.ts ?? 0);
  }
  if (keys.length === 0) return false;
  const now = Date.now();
  const clear = signDown(deps.roomId(), itemId, CLEAR_TARGET, Math.max(now, Math.min(newest, now + MAX_FUTURE_SKEW_MS)), signer);
  const older = clearEntriesIn(downMap!, itemId).map(([k]) => k);
  boundDoc!.transact(() => {
    downMap!.set(clearKey(itemId, clear.ts), clear);
    for (const k of older) if (k !== clearKey(itemId, clear.ts)) downMap!.delete(k); // the new one covers them
    for (const k of keys) notesMap!.delete(k);
  });
  return true;
}

/** A board was taken off the wall (edit mode's REMOVE, already owner-gated):
 *  its notes go with it, so a removed board leaves nothing in the doc. */
export function forgetBoard(itemId: string): number {
  if (!docAlive()) return 0;
  const prefix = `${itemId}|`;
  const keys = [...notesMap!.keys()].filter((k) => k.startsWith(prefix));
  const downs = [...downMap!.keys()].filter((k) => k.startsWith(prefix));
  if (keys.length === 0 && downs.length === 0) return 0;
  boundDoc!.transact(() => {
    for (const k of keys) notesMap!.delete(k);
    for (const k of downs) downMap!.delete(k);
  });
  return keys.length;
}

/** How many boards a set of furniture holds (for MAX_BOARDS_PER_ROOM). */
export function countBoards(items: readonly { kind: string }[]): number {
  return items.filter((i) => boardKindOf(i.kind) !== null).length;
}

/** Delete what no reader would show, once the host's state has arrived. */
export function trimBoard(itemId: string, kind: BoardKind): number {
  if (!deps || !docAlive() || !deps.canTrim()) return 0;
  // An unknown owner key reads as "show nothing" on a case; that must not
  // become "delete everything".
  if (kind === 'owner' && !deps.ownerPub()) return 0;
  const { trimmable } = readBoard(itemId, kind);
  const downs = planDownTrim(downMap!.entries(), itemId, readCtx(kind, Date.now()));
  if (trimmable.length === 0 && downs.length === 0) return 0;
  boundDoc!.transact(() => {
    for (const k of trimmable) notesMap!.delete(k);
    for (const k of downs) downMap!.delete(k);
  });
  return trimmable.length + downs.length;
}

// ── Board bundles: what other copies of the room sealed ──────────────────────

/** Entries a merge looks at, at most (the node sends up to 512 notes and
 *  1024 take-downs). */
const MAX_MERGE_NOTES = 512;
const MAX_MERGE_DOWN = 1024;

export interface BoardView {
  room: string;
  notes: Array<[string, unknown]>;
  down: Array<[string, unknown]>;
}

/** What a merge left for later: a view the node sent before the host's state
 *  arrived, entries past a board's verify budget, and entries only the
 *  owner's key can judge. */
let pendingView: BoardView | null = null;
/** A merge left entries past a budget: the next round runs on a timer, so a
 *  long view (or one led by junk) is merged in rounds, never dropped (#332
 *  review; the node sends a view only when it changes). */
const RETRY_MS = 1500;
/** The longest a kept note stamped ahead waits for its next look. */
const MAX_RETRY_WAIT_MS = 10 * 60 * 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAt = 0;

/** The next round in `delayMs` (sooner than one already set, never later). */
function scheduleRetry(delayMs: number = RETRY_MS): void {
  if (!pendingView) return;
  const at = Date.now() + delayMs;
  if (retryTimer !== null && retryAt <= at) return;
  cancelRetry();
  retryAt = at;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryBoardView();
  }, delayMs);
}

function cancelRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Entries a merge left for later (tests, and the dev console). */
export function pendingBoardEntries(): number {
  return pendingView ? pendingView.notes.length + pendingView.down.length : 0;
}

/** The node's `board` envelope body, shape-checked, or null. */
export function boardViewFromWire(raw: unknown): BoardView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.room !== 'string' || !Array.isArray(r.notes) || !Array.isArray(r.down)) return null;
  const pairs = (list: unknown[], max: number): Array<[string, unknown]> =>
    list.slice(0, max).filter((e): e is [string, unknown] => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && e[0].length <= 2 * MAX_ID + 1);
  return { room: r.room, notes: pairs(r.notes, MAX_MERGE_NOTES), down: pairs(r.down, MAX_MERGE_DOWN) };
}

/** A key this copy held and deleted (Yjs keeps the deleted item as the
 *  key's last value): a trim, an unpin or a REMOVE here, never undone by a
 *  bundle sealed before it. */
function deletedHere(map: Y.Map<unknown>, key: string): boolean {
  const item = (map as unknown as { _map?: Map<string, { deleted?: boolean }> })._map?.get(key);
  return !!item && item.deleted === true;
}

function splitKey(key: string): { itemId: string; target: string } | null {
  const bar = key.lastIndexOf('|');
  if (bar <= 0) return null;
  return { itemId: key.slice(0, bar), target: key.slice(bar + 1) };
}

const NOTE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Merge what other copies of this room sealed (the local node's `board`
 * lane): take-downs first, then notes, each checked as a reader checks the
 * doc. Writes only what this copy has never held, onto boards the room has.
 * The view may hold competing records under one key (the node keeps a few):
 * a take-down by the note's author or the owner wins over one that can't be
 * judged, the newest valid CLEAR wins, and a record already filed here is
 * replaced only by one that outranks it. What can't be merged yet is kept:
 * before the host's state arrives, the whole view (`retryBoardView`); past a
 * board's verify budget, the rest, in rounds on a timer; and while the
 * owner's key is unknown, what only it can judge (until `refreshBoards`).
 * Returns what was written, or null when nothing ran.
 */
export function mergeBoardView(raw: unknown): { notes: number; down: number } | null {
  const view = boardViewFromWire(raw);
  if (!view || !deps || !docAlive() || view.room !== deps.roomId()) return null;
  if (!deps.canTrim()) {
    pendingView = view;
    return null;
  }
  pendingView = null;
  cancelRetry();
  const boardOf = deps.boardOfItem ?? (() => null);
  const now = Date.now();
  const roomId = deps.roomId();
  const ownerPub = deps.ownerPub();
  const rest: BoardView = { room: view.room, notes: [], down: [] };
  let overBudget = false;
  const touched = new Map<string, BoardKind>();
  const budget = new Map<string, number>();
  const spend = (itemId: string): boolean => {
    const used = budget.get(itemId) ?? 0;
    if (used >= MAX_VERIFIED_PER_BOARD) return false;
    budget.set(itemId, used + 1);
    return true;
  };
  const verifyDown = (itemId: string, target: string, d: BoardDown): boolean =>
    cachedVerify(d.by, downSignBytes(roomId, itemId, target, d.by, d.ts), d.sig);
  // The note each key names, from this copy or from the view (its id binds
  // its author, so no signature is needed to know whose it is).
  const viewNotes = new Map<string, BoardNote>();
  for (const [key, value] of view.notes) {
    const k = splitKey(key);
    if (!k || viewNotes.has(key) || !NOTE_ID_RE.test(k.target)) continue;
    const note = noteFromWire(value);
    if (note && noteIdOf(roomId, k.itemId, note) === k.target) viewNotes.set(key, note);
  }
  const authorFor = (key: string, itemId: string, target: string): string | undefined =>
    authorOf(notesMap!.get(key), roomId, itemId, target) ?? viewNotes.get(key)?.author;
  // 2: by the note's author or the owner. 1: the note is unknown here, so
  // it can't be judged yet (kept to stop that note if it comes). 0: neither.
  const rankOf = (d: BoardDown, author: string | undefined): number =>
    d.by === ownerPub || (author !== undefined && d.by === author) ? 2 : author === undefined ? 1 : 0;

  // Each key's chosen take-down, verified; each board's newest CLEAR.
  const filed = new Map<string, BoardDown>();
  const bestClear = new Map<string, BoardDown>();
  const waitsForOwner = new Set<string>(); // take-down keys put off
  const clearWaits = new Set<string>(); // boards whose CLEARs were put off
  const docClears = new Map<string, BoardDown | null>();
  const docClear = (itemId: string): BoardDown | null => {
    if (!docClears.has(itemId)) {
      docClears.set(itemId, newestClear(itemId, { roomId, kind: 'open', now, ownerPub, verify: cachedVerify, clearsOf: (i) => clearEntriesIn(downMap!, i) }));
    }
    return docClears.get(itemId)!;
  };
  for (const [key, value] of view.down) {
    const k = splitKey(key);
    if (!k || !TARGET_RE.test(k.target)) continue;
    const kind = boardOf(k.itemId);
    if (!kind) continue;
    const d = downFromWire(value);
    if (!d) continue;
    if (isClearTarget(k.target)) {
      // Each CLEAR under its own stamp; the board's newest valid one is
      // what counts, so only one newer than that is taken.
      if (!ownerPub) {
        rest.down.push([key, value]);
        clearWaits.add(k.itemId);
        continue;
      }
      if (d.by !== ownerPub || key !== clearKey(k.itemId, d.ts)) continue;
      const best = bestClear.get(k.itemId) ?? docClear(k.itemId);
      if (best && best.ts >= d.ts) continue;
      if (!spend(k.itemId)) {
        rest.down.push([key, value]);
        overBudget = true;
        continue;
      }
      if (!verifyDown(k.itemId, CLEAR_TARGET, d)) continue;
      bestClear.set(k.itemId, d);
      touched.set(k.itemId, kind);
      continue;
    } else {
      const author = authorFor(key, k.itemId, k.target);
      const rank = rankOf(d, author);
      if (rank === 0) {
        // Neither the author's nor the owner's, unless it is the owner's
        // and their key hasn't arrived.
        if (!ownerPub) {
          rest.down.push([key, value]);
          waitsForOwner.add(key);
        }
        continue;
      }
      const best = filed.get(key);
      if (best && rankOf(best, author) >= rank) continue;
      const mine = best ? null : downFromWire(downMap!.get(key));
      if (mine && rankOf(mine, author) >= rank) {
        if (!spend(k.itemId)) {
          rest.down.push([key, value]);
          overBudget = true;
          continue;
        }
        if (verifyDown(k.itemId, k.target, mine)) continue; // ours stands
      }
      // A take-down this copy trimmed stays gone, unless this one is the
      // author's or the owner's and young: the trim may have taken one that
      // sat on the key for nothing, which must not lock the real one out.
      if (!downMap!.has(key) && deletedHere(downMap!, key) && !(rank === 2 && now - d.ts < DOWN_KEEP_MS)) continue;
    }
    if (!spend(k.itemId)) {
      rest.down.push([key, value]);
      overBudget = true;
      continue;
    }
    if (!verifyDown(k.itemId, k.target, d)) continue;
    filed.set(key, d);
    touched.set(k.itemId, kind);
  }
  const ctxFor = (kind: BoardKind): ReadCtx => ({
    roomId, kind, now, ownerPub, verify: cachedVerify,
    downOf: (k) => (filed.has(k) ? filed.get(k) : downMap!.get(k)),
    clearsOf: (itemId) => {
      const mine = clearEntriesIn(downMap!, itemId);
      const taken = bestClear.get(itemId);
      return taken ? [...mine, [clearKey(itemId, taken.ts), taken]] : mine;
    },
  });
  let dueAt = Infinity; // when the first note kept for being ahead may show
  const clears = new Map<string, number>();
  const merged = new Map<string, BoardNote>();
  for (const [key, value] of view.notes) {
    const k = splitKey(key);
    if (!k || !NOTE_ID_RE.test(k.target)) continue;
    const kind = boardOf(k.itemId);
    if (!kind || merged.has(key) || notesMap!.has(key) || deletedHere(notesMap!, key)) continue;
    const note = noteFromWire(value);
    if (!note || noteIdOf(roomId, k.itemId, note) !== k.target) continue;
    if (note.ts > now + MAX_FUTURE_SKEW_MS) {
      // Ahead of this clock (another node's runs ahead): kept until it may
      // show, as the doc's reader keeps one (#332 review), unless it is
      // stamped so far ahead the trim would take it.
      if (note.ts <= now + TRIM_FUTURE_MS) {
        rest.notes.push([key, value]);
        dueAt = Math.min(dueAt, note.ts - MAX_FUTURE_SKEW_MS);
      }
      continue;
    }
    const ctx = ctxFor(kind);
    const downHere = ctx.downOf!(key);
    if (!ownerPub) {
      // What only the owner's key can judge waits for it: a notice, a note
      // a CLEAR may cover, one taken down by someone other than its author.
      const byOther = downHere !== undefined && downFromWire(downHere)?.by !== note.author;
      const cleared = clearWaits.has(k.itemId) || clearEntriesIn(downMap!, k.itemId).length > 0;
      if (kind === 'owner' || cleared || waitsForOwner.has(key) || byOther) {
        rest.notes.push([key, value]);
        continue;
      }
    }
    if (kind === 'owner' && note.author !== ownerPub) continue;
    if (!clears.has(k.itemId)) clears.set(k.itemId, clearStampOf(k.itemId, ctx));
    if (note.ts <= clears.get(k.itemId)!) continue;
    if (downHere !== undefined) {
      if (!spend(k.itemId)) {
        rest.notes.push([key, value]);
        overBudget = true;
        continue;
      }
      if (isTakenDown(key, k.itemId, k.target, note, ctx)) continue;
    }
    if (!spend(k.itemId)) {
      rest.notes.push([key, value]);
      overBudget = true;
      continue;
    }
    const { sig, ...unsigned } = note;
    if (!cachedVerify(note.author, noteSignBytes(roomId, k.itemId, unsigned), sig)) continue;
    merged.set(key, note);
    touched.set(k.itemId, kind);
  }
  if (rest.notes.length > 0 || rest.down.length > 0) {
    pendingView = rest;
    if (overBudget) scheduleRetry();
    else if (dueAt !== Infinity) scheduleRetry(Math.min(MAX_RETRY_WAIT_MS, Math.max(RETRY_MS, dueAt - now)));
  }
  if (filed.size === 0 && bestClear.size === 0 && merged.size === 0) return { notes: 0, down: 0 };
  boundDoc!.transact(() => {
    for (const [key, d] of filed) {
      downMap!.set(key, d);
      notesMap!.delete(key); // the note it takes down goes
    }
    for (const [itemId, d] of bestClear) downMap!.set(clearKey(itemId, d.ts), d);
    for (const [key, note] of merged) notesMap!.set(key, note);
  });
  // What the merge pushed past a board's caps comes off again here (and a
  // CLEAR it took makes the board's older ones redundant).
  for (const [itemId, kind] of touched) trimBoard(itemId, kind);
  return { notes: merged.size, down: filed.size + bestClear.size };
}

/** Merge what an earlier merge left: once the host's state has arrived, the
 *  next round past a budget, or once the owner's key is known. */
export function retryBoardView(): void {
  if (pendingView) mergeBoardView(pendingView);
}

// ── Local state: seen notes and hidden authors ───────────────────────────────

const SEEN_KEY = 'ssf-board-seen';
const HIDDEN_KEY = 'ssf-board-hidden';
/** Boards whose seen notes are remembered (the newest-opened kept). */
const MAX_SEEN = 100;
/** Note ids remembered per board: twice what a board shows, so a note that
 *  drops off and comes back within a few posts stays seen. */
const MAX_SEEN_IDS = 2 * MAX_BOARD_NOTES;
const MAX_HIDDEN = 256;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privacy mode: this session only */ }
}

let seenMemo: Record<string, string[]> | null = null;
let hiddenMemo: string[] | null = null;

function seenMap(): Record<string, string[]> {
  if (!seenMemo) {
    const raw = loadJson<unknown>(SEEN_KEY, {});
    seenMemo = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          seenMemo[k] = v.filter((id): id is string => typeof id === 'string' && id.length <= MAX_ID).slice(0, MAX_SEEN_IDS);
        }
      }
    }
  }
  return seenMemo;
}

function hiddenList(): string[] {
  if (!hiddenMemo) {
    const raw = loadJson<unknown>(HIDDEN_KEY, []);
    hiddenMemo = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.length <= MAX_ID) : [];
  }
  return hiddenMemo;
}

/** A note glows until its reader opens the board (never their own). Seen is
 *  remembered by note id, never by stamp (#330 review): stamps are the
 *  authors' clocks, so one note stamped ahead, or one that arrived late with
 *  an old stamp, would have put a watermark over notes nobody had opened. */
export function isUnseen(roomId: string, itemId: string, note: Pick<ShownNote, 'id' | 'author'>, me: string): boolean {
  return note.author !== me && !(seenMap()[`${roomId}|${itemId}`] ?? []).includes(note.id);
}

/** The ids of a board's notes this player has not seen yet (not their own):
 *  what the panel marks NEW. */
export function unseenIds(itemId: string, kind: BoardKind, me: string = getIdentityPub()): Set<string> {
  if (!deps || !docAlive()) return new Set();
  const roomId = deps.roomId();
  return new Set(readBoard(itemId, kind).shown.filter((n) => isUnseen(roomId, itemId, n, me)).map((n) => n.id));
}

/** The player opened the board: everything on it now counts as seen. */
export function markBoardSeen(itemId: string, kind: BoardKind): void {
  if (!deps || !docAlive()) return;
  const roomId = deps.roomId();
  const shown = readBoard(itemId, kind).shown.map((n) => n.id);
  const key = `${roomId}|${itemId}`;
  const map = seenMap();
  const before = map[key] ?? [];
  if (shown.every((id) => before.includes(id))) return;
  delete map[key];
  // Re-inserted last: the boards opened most lately survive the cap. The
  // board's own ids first, so the oldest remembered ones fall off.
  map[key] = [...shown, ...before.filter((id) => !shown.includes(id))].slice(0, MAX_SEEN_IDS);
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length - MAX_SEEN; i++) delete map[keys[i]];
  saveJson(SEEN_KEY, map);
  notify();
}

export function isHiddenAuthor(pub: string): boolean {
  return hiddenList().includes(pub);
}

export function hiddenAuthors(): readonly string[] {
  return hiddenList();
}

/** Hide (or show again) an author's notes on this player's own screen. */
export function setAuthorHidden(pub: string, hidden: boolean): void {
  if (!pub || pub.length > MAX_ID) return;
  const list = hiddenList().filter((p) => p !== pub);
  if (hidden) list.push(pub);
  hiddenMemo = list.slice(-MAX_HIDDEN);
  saveJson(HIDDEN_KEY, hiddenMemo);
  notify();
}

/** Tests: forget the in-memory copies of the local lists. */
export function resetBoardLocalStateForTest(): void {
  seenMemo = null;
  hiddenMemo = null;
  verdicts.clear();
  readCache = null;
  pendingView = null;
  cancelRetry();
}

// ── What a board's face draws ────────────────────────────────────────────────

export interface BoardFaceNote {
  id: string;
  text: string;
  authorName: string;
  colour: BoardColour;
  x: number;
  y: number;
  unseen: boolean;
  photo: boolean;
}

export interface BoardScreen {
  kind: BoardKind;
  notes: BoardFaceNote[];
  /** Notes hidden on this screen by the player's own choice. */
  hiddenCount: number;
  /** Nothing to show, and why. */
  empty?: string;
}

/** A board's face now, for the 1 Hz redraw (devices/world). */
export function readBoardScreen(itemId: string, kind: BoardKind): BoardScreen {
  const empty = kind === 'owner' ? 'NO NOTICES' : 'PIN A NOTE';
  if (!deps || !docAlive()) return { kind, notes: [], hiddenCount: 0, empty };
  if (kind === 'owner' && !deps.ownerPub()) return { kind, notes: [], hiddenCount: 0, empty: 'OWNER UNKNOWN' };
  const roomId = deps.roomId();
  const me = getIdentityPub();
  const { shown } = readBoard(itemId, kind);
  const visible = shown.filter((n) => !isHiddenAuthor(n.author));
  const notes = visible.map((n): BoardFaceNote => ({
    id: n.id,
    text: n.text,
    authorName: n.authorName,
    colour: n.colour,
    x: n.x,
    y: n.y,
    unseen: isUnseen(roomId, itemId, n, me),
    photo: !!n.attach,
  }));
  return {
    kind,
    notes,
    hiddenCount: shown.length - visible.length,
    ...(notes.length === 0 ? { empty } : {}),
  };
}

/** The room the board store is bound to now ('' when unbound): a panel
 *  checks it is still in the room it was opened in (an ACCESS beam rebinds
 *  the store before the panel comes down). */
export function boardRoomId(): string {
  return deps && docAlive() ? deps.roomId() : '';
}

/** The room owner's key as the boards read it (undefined: not known yet). */
export function boardOwnerPub(): string | undefined {
  return deps?.ownerPub();
}
