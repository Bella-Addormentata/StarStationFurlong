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
 * only when the caller says the host's own state has arrived (linkedSynced),
 * the durability plan's do-not-clean rule (room-durability-plan.md §2); it is
 * safe even on a stale copy, because a note outside the newest 24 of a partial
 * view is outside them in the full one too.
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
    authorName: fields.authorName.slice(0, MAX_NAME),
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

// ── The read rule (pure) ─────────────────────────────────────────────────────

export interface ReadCtx {
  roomId: string;
  kind: BoardKind;
  now: number;
  /** The owner's identity key, needed for a notice case. */
  ownerPub?: string;
  /** Signature check (verifyIdentityStrict by default; cached by the store). */
  verify?: (pub: string, bytes: Uint8Array, sig: string) => boolean;
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
  let checked = 0;
  for (const c of candidates) {
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
  /** The host's own state has arrived (YjsSync.linkedSynced): trims may run. */
  canTrim: () => boolean;
}

let deps: BoardDeps | null = null;
let boundDoc: Y.Doc | null = null;
let notesMap: Y.Map<unknown> | null = null;
let version = 0;
const listeners = new Set<() => void>();
/** Signature verdicts by the signature itself (a note's bytes are fixed by
 *  its id, and its id by its key): the face redraws every second. */
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
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed && notesMap !== null;
}

/** Bind the room doc: main.ts's room-join seam, beside bindDeparturesDoc. */
export function bindBoardDoc(doc: Y.Doc): void {
  boundDoc = doc;
  notesMap = doc.getMap(BOARD_NOTES_MAP);
  notesMap.observe(() => notify());
  notify();
}

/** Something a board's read depends on changed outside the map (the owner's
 *  key arrived, the deed moved): drop the cached reads. */
export function refreshBoards(): void {
  readCache = null;
  notify();
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
  const key = `${pub}|${sig}`;
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
  const read = readBoardEntries(notesMap!.entries(), itemId, {
    roomId: deps.roomId(),
    kind,
    now,
    ownerPub: deps.ownerPub(),
    verify: cachedVerify,
  });
  readCache.reads.set(cacheKey, read);
  return read;
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
  const { id, note } = signNote(
    deps.roomId(),
    itemId,
    { authorName: deps.myName() || 'Clone', text, colour: input.colour, x: spot.x, y: spot.y, ts: Date.now(), ...(photo ? { attach: photo } : {}) },
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

/** Take a note down: the author's own, or any note for the owner. */
export function takeDownNote(itemId: string, noteId: string, kind: BoardKind, me: string = getIdentityPub()): boolean {
  if (!deps || !docAlive()) return false;
  const note = readBoard(itemId, kind).shown.find((n) => n.id === noteId);
  if (!note) return false;
  if (note.author !== me && !canModerate()) return false;
  boundDoc!.transact(() => { notesMap!.delete(noteKey(itemId, noteId)); });
  return true;
}

/** The owner clears a board: every key filed under it. */
export function clearBoard(itemId: string): boolean {
  if (!canModerate()) return false;
  const prefix = `${itemId}|`;
  const keys: string[] = [];
  let visited = 0;
  for (const key of notesMap!.keys()) {
    if (++visited > 4 * MAX_KEYS_VISITED) break;
    if (key.startsWith(prefix)) keys.push(key);
  }
  if (keys.length === 0) return false;
  boundDoc!.transact(() => { for (const k of keys) notesMap!.delete(k); });
  return true;
}

/** A board was taken off the wall (edit mode's REMOVE, already owner-gated):
 *  its notes go with it, so a removed board leaves nothing in the doc. */
export function forgetBoard(itemId: string): number {
  if (!docAlive()) return 0;
  const prefix = `${itemId}|`;
  const keys = [...notesMap!.keys()].filter((k) => k.startsWith(prefix));
  if (keys.length === 0) return 0;
  boundDoc!.transact(() => { for (const k of keys) notesMap!.delete(k); });
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
  if (trimmable.length === 0) return 0;
  boundDoc!.transact(() => { for (const k of trimmable) notesMap!.delete(k); });
  return trimmable.length;
}

// ── Local state: seen notes and hidden authors ───────────────────────────────

const SEEN_KEY = 'ssf-board-seen';
const HIDDEN_KEY = 'ssf-board-hidden';
const MAX_SEEN = 200;
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

let seenMemo: Record<string, number> | null = null;
let hiddenMemo: string[] | null = null;

function seenMap(): Record<string, number> {
  if (!seenMemo) {
    const raw = loadJson<unknown>(SEEN_KEY, {});
    seenMemo = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) seenMemo[k] = v;
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

/** The newest note stamp this player has seen on a board (0: none). */
export function seenUpTo(roomId: string, itemId: string): number {
  return seenMap()[`${roomId}|${itemId}`] ?? 0;
}

/** A note glows until its reader opens the board (never their own). */
export function isUnseen(roomId: string, itemId: string, note: Pick<BoardNote, 'ts' | 'author'>, me: string): boolean {
  return note.author !== me && note.ts > seenUpTo(roomId, itemId);
}

/** The player opened the board: everything on it now counts as seen. */
export function markBoardSeen(itemId: string, kind: BoardKind): void {
  if (!deps || !docAlive()) return;
  const roomId = deps.roomId();
  const newest = readBoard(itemId, kind).shown.reduce((m, n) => Math.max(m, n.ts), 0);
  const key = `${roomId}|${itemId}`;
  const map = seenMap();
  if ((map[key] ?? 0) >= newest) return;
  delete map[key];
  map[key] = newest; // re-inserted last: the newest entries survive the cap
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

/** The current room's id as the board store has it ('' when unbound). */
export function boardRoomId(): string {
  return deps?.roomId() ?? '';
}

/** The room owner's key as the boards read it (undefined: not known yet). */
export function boardOwnerPub(): string | undefined {
  return deps?.ownerPub();
}
