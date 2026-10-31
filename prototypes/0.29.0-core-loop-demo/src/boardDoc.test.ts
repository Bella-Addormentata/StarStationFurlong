/**
 * 📌 Room boards (#315): the signed note record, the read rule (shape, id,
 * post rule, signatures, caps), the trim plan, and the bound store's writes.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { utf8ToBytes } from '@noble/hashes/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  BOARD_NOTES_MAP,
  BOARD_DOWN_MAP,
  CLEAR_TARGET,
  MAX_DOWN_PER_BOARD,
  MAX_DOWN_RETAINED,
  DOWN_KEEP_MS,
  MAX_VERIFIED_PER_BOARD,
  mergeBoardView,
  pendingBoardEntries,
  refreshBoards,
  planDownTrim,
  retryBoardView,
  signDown,
  MAX_BOARD_NOTES,
  MAX_KEYS_VISITED,
  MAX_NOTE_TEXT,
  MAX_NOTES_PER_AUTHOR,
  bindBoardDoc,
  boardRoomId,
  boardKindOf,
  canPost,
  cleanAuthorName,
  cleanNoteText,
  clearBoard,
  freeSpot,
  isUnseen,
  unseenIds,
  markBoardSeen,
  noteFromWire,
  noteKey,
  photoFromWire,
  postNote,
  readBoard,
  readBoardEntries,
  readBoardScreen,
  resetBoardLocalStateForTest,
  setAuthorHidden,
  setBoardDeps,
  signNote,
  takeDownNote,
  trimBoard,
  countBoards,
  forgetBoard,
  MAX_BOARDS_PER_ROOM,
} from './boardDoc';
import type { BoardDeps, BoardNote, BoardPhoto, NoteSigner } from './boardDoc';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A real Ed25519 identity from a fixed seed. */
function signer(name: string): NoteSigner {
  const seed = sha256(utf8ToBytes(`ssf-board-test|${name}`));
  return { pub: b64url(ed.getPublicKey(seed)), sign: (bytes) => b64url(ed.sign(bytes, seed)) };
}

const ROOM = 'room-a';
const BOARD = 'corkboard-1';
const NOW = 1_800_000_000_000;
const CASE = 'notice-case-1';
const alice = signer('alice');
const bob = signer('bob');
const owner = signer('owner');

const PHOTO: BoardPhoto = {
  kind: 'blob',
  hash: 'a'.repeat(64),
  size: 48_000,
  provider: 'b'.repeat(64),
  mime: 'image/jpeg',
  takenAt: NOW - 60_000,
  caption: 'sofa night',
};

function note(by: NoteSigner, text: string, ts: number, opts: { room?: string; board?: string; attach?: BoardPhoto } = {}) {
  return signNote(opts.room ?? ROOM, opts.board ?? BOARD, { authorName: 'Clone', text, colour: 'yellow', x: 0.5, y: 0.5, ts, attach: opts.attach }, by);
}

const entry = (n: { id: string; note: BoardNote }, board = BOARD): [string, unknown] => [noteKey(board, n.id), n.note];

describe('the signed note', () => {
  it('reads back what its author posted', () => {
    const n = note(alice, 'hello from Alice', NOW - 1000);
    const read = readBoardEntries([entry(n)], BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(read.shown.map((s) => s.text)).toEqual(['hello from Alice']);
    expect(read.shown[0].id).toBe(n.id);
    expect(read.trimmable).toEqual([]);
  });

  it('drops a note whose text was changed after signing (and a trim may delete it)', () => {
    const n = note(alice, 'meet at 8', NOW - 1000);
    const forged = { ...n.note, text: 'meet at 9' };
    // Re-filed under the id the new bytes hash to, so only the signature fails.
    const id = signNote(ROOM, BOARD, { ...forged, ts: forged.ts }, alice).id;
    const read = readBoardEntries([[noteKey(BOARD, id), forged]], BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(read.shown).toEqual([]);
    expect(read.trimmable).toEqual([noteKey(BOARD, id)]);
  });

  it('drops a note filed under the wrong id, copied onto another board, or into another room', () => {
    const n = note(alice, 'hi', NOW - 1000);
    const wrongId: [string, unknown] = [noteKey(BOARD, 'f'.repeat(32)), n.note];
    expect(readBoardEntries([wrongId], BOARD, { roomId: ROOM, kind: 'open', now: NOW }).shown).toEqual([]);
    // The same value under another board's prefix: its id is the other board's hash.
    const copied: [string, unknown] = [noteKey('corkboard-2', n.id), n.note];
    expect(readBoardEntries([copied], 'corkboard-2', { roomId: ROOM, kind: 'open', now: NOW }).shown).toEqual([]);
    // Another room: the id no longer matches the bytes the reader rebuilds.
    expect(readBoardEntries([entry(n)], BOARD, { roomId: 'room-b', kind: 'open', now: NOW }).shown).toEqual([]);
  });

  it('carries a photo inside the signature, so it can not be swapped', () => {
    const n = note(alice, 'look', NOW - 1000, { attach: PHOTO });
    const ok = readBoardEntries([entry(n)], BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(ok.shown[0].attach).toEqual(PHOTO);
    const swapped = { ...n.note, attach: { ...PHOTO, hash: 'c'.repeat(64) } };
    const read = readBoardEntries([[noteKey(BOARD, n.id), swapped]], BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(read.shown).toEqual([]);
  });

  it('shape-checks every field and fails closed', () => {
    const good = note(alice, 'ok', NOW).note;
    expect(noteFromWire(good)).not.toBeNull();
    expect(noteFromWire({ ...good, v: 2 })).toBeNull();
    expect(noteFromWire({ ...good, text: '   ' })).toBeNull();
    expect(noteFromWire({ ...good, text: 'x'.repeat(MAX_NOTE_TEXT + 1) })).toBeNull();
    expect(noteFromWire({ ...good, text: 'bell\u0007' })).toBeNull();
    expect(noteFromWire({ ...good, text: 'two\nlines' })).not.toBeNull();
    expect(noteFromWire({ ...good, colour: 'purple' })).toBeNull();
    expect(noteFromWire({ ...good, x: 1.5 })).toBeNull();
    expect(noteFromWire({ ...good, ts: -1 })).toBeNull();
    expect(noteFromWire({ ...good, authorName: 'x'.repeat(40) })).toBeNull();
    expect(noteFromWire({ ...good, attach: { kind: 'url', url: 'https://example.com/a.jpg' } })).toBeNull();
    expect(noteFromWire(null)).toBeNull();
  });

  it('cleans the author name it signs, so a pasted name still makes a readable note (#330 review)', () => {
    const sign = (authorName: string) => signNote(ROOM, BOARD, { authorName, text: 'hi', colour: 'yellow', x: 0.5, y: 0.5, ts: NOW - 1000 }, alice);
    const readName = (n: { id: string; note: BoardNote }) =>
      readBoardEntries([entry(n)], BOARD, { roomId: ROOM, kind: 'open', now: NOW }).shown.map((s) => s.authorName);
    expect(readName(sign('Bo\u0007b\nby\t  Jr'))).toEqual(['Bo b by Jr']);
    expect(readName(sign('  \u0001 '))).toEqual(['Clone']);
    // 31 letters and a two-unit emoji: cut at 32 units, never half the pair.
    expect(readName(sign(`${'a'.repeat(31)}🚀tail`))).toEqual(['a'.repeat(31)]);
    expect(cleanAuthorName('Ada')).toBe('Ada');
  });

  it('takes only an image blob reference as a photo', () => {
    expect(photoFromWire(PHOTO)).toEqual(PHOTO);
    expect(photoFromWire({ ...PHOTO, mime: 'video/mp4' })).toBeNull();
    expect(photoFromWire({ ...PHOTO, hash: 'xyz' })).toBeNull();
    expect(photoFromWire({ ...PHOTO, provider: 'B'.repeat(64) })).toBeNull();
    expect(photoFromWire({ ...PHOTO, size: 0 })).toBeNull();
    expect(photoFromWire({ ...PHOTO, size: 3 * 1024 * 1024 })).toBeNull();
    expect(photoFromWire({ ...PHOTO, caption: 'a\nb' })).toBeNull();
    const { caption: _caption, ...noCaption } = PHOTO;
    expect(photoFromWire(noCaption)).toEqual(noCaption);
  });
});

describe('caps', () => {
  it('keeps the newest three notes per author on a board', () => {
    const notes = [1, 2, 3, 4].map((i) => note(alice, `note ${i}`, NOW - 10_000 + i));
    const read = readBoardEntries(notes.map((n) => entry(n)), BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(MAX_NOTES_PER_AUTHOR).toBe(3);
    expect(read.shown.map((s) => s.text)).toEqual(['note 4', 'note 3', 'note 2']);
    expect(read.trimmable).toEqual([noteKey(BOARD, notes[0].id)]);
  });

  it('shows the newest 24 and lets the oldest fall off', () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(signer(`p${i}`), `n${i}`, NOW - 100_000 + i));
    const read = readBoardEntries(notes.map((n) => entry(n)), BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(read.shown).toHaveLength(MAX_BOARD_NOTES);
    expect(read.shown[0].text).toBe('n29');
    expect(read.shown[MAX_BOARD_NOTES - 1].text).toBe('n6');
    expect(new Set(read.trimmable)).toEqual(new Set(notes.slice(0, 6).map((n) => noteKey(BOARD, n.id))));
  });

  it('never lets junk count toward the cap', () => {
    const real = [note(alice, 'real a', NOW - 5000), note(bob, 'real b', NOW - 4000)];
    const junk: Array<[string, unknown]> = Array.from({ length: 40 }, (_, i) => {
      const n = note(signer(`junk${i}`), `spam ${i}`, NOW - 100 + i);
      return [noteKey(BOARD, n.id), { ...n.note, sig: n.note.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }];
    });
    const read = readBoardEntries([...junk, ...real.map((n) => entry(n))], BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(read.shown.map((s) => s.text)).toEqual(['real b', 'real a']);
    expect(read.trimmable).toHaveLength(40);
  });

  it('visits a bounded number of keys', () => {
    let visited = 0;
    function* many(): Generator<[string, unknown]> {
      for (let i = 0; i < MAX_KEYS_VISITED * 4; i++) {
        visited++;
        yield [`other|${i}`, 'x'];
      }
    }
    readBoardEntries(many(), BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(visited).toBe(MAX_KEYS_VISITED + 1);
  });

  it('hides a note stamped a little ahead without trimming it; trims one stamped days ahead', () => {
    const soon = note(alice, 'soon', NOW + 20 * 60_000);
    const far = note(bob, 'far', NOW + 3 * 24 * 3600_000);
    const read = readBoardEntries([entry(soon), entry(far)], BOARD, { roomId: ROOM, kind: 'open', now: NOW });
    expect(read.shown).toEqual([]);
    expect(read.trimmable).toEqual([noteKey(BOARD, far.id)]);
  });
});

describe('the notice case', () => {
  it('shows only the owner’s notes and marks the rest for trimming', () => {
    const notice = note(owner, 'Pool closes at 10', NOW - 1000);
    const fake = note(alice, 'Free drinks!', NOW - 500);
    const read = readBoardEntries([entry(notice), entry(fake)], BOARD, { roomId: ROOM, kind: 'owner', now: NOW, ownerPub: owner.pub });
    expect(read.shown.map((s) => s.text)).toEqual(['Pool closes at 10']);
    expect(read.trimmable).toEqual([noteKey(BOARD, fake.id)]);
  });

  it('shows nothing, and trims nothing, while the owner’s key is unknown', () => {
    const notice = note(owner, 'Pool closes at 10', NOW - 1000);
    const read = readBoardEntries([entry(notice)], BOARD, { roomId: ROOM, kind: 'owner', now: NOW });
    expect(read).toEqual({ shown: [], trimmable: [] });
  });

  it('knows which furniture kinds are boards', () => {
    expect(boardKindOf('corkboard')).toBe('open');
    expect(boardKindOf('notice-case')).toBe('owner');
    expect(boardKindOf('smart-tv')).toBeNull();
    expect(boardKindOf('toString')).toBeNull();
    expect(boardKindOf(undefined)).toBeNull();
  });
});

describe('placing and cleaning', () => {
  it('puts a new note in the first free slot', () => {
    const spot = freeSpot([], () => 0.5);
    expect(spot).toEqual({ x: 1 / 12, y: 1 / 8 });
    const next = freeSpot([spot], () => 0.5);
    expect(next.x).toBeCloseTo(3 / 12);
    expect(next.y).toBeCloseTo(1 / 8);
  });

  it('cleans posted text', () => {
    expect(cleanNoteText('  hi\r\nthere\u0007  ')).toBe('hi\nthere');
  });
});

describe('the bound store', () => {
  let doc: Y.Doc;
  let state: { isOwner: boolean; canTrim: boolean; ownerPub: string | undefined };

  beforeEach(() => {
    resetBoardLocalStateForTest();
    doc = new Y.Doc();
    state = { isOwner: false, canTrim: true, ownerPub: owner.pub };
    const deps: BoardDeps = {
      roomId: () => ROOM,
      ownerPub: () => state.ownerPub,
      isOwner: () => state.isOwner,
      myName: () => 'Tester',
      canTrim: () => state.canTrim,
      boardOfItem: (id) => (id === BOARD || id === 'corkboard-2' ? 'open' : id === CASE ? 'owner' : null),
    };
    bindBoardDoc(doc);
    setBoardDeps(deps);
  });

  afterEach(() => {
    setBoardDeps(null);
  });

  it('posts a signed note anyone can read back', () => {
    const r = postNote(BOARD, 'open', { text: '  hello  ', colour: 'pink' }, alice);
    expect(r.ok).toBe(true);
    const shown = readBoard(BOARD, 'open').shown;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ text: 'hello', colour: 'pink', author: alice.pub, authorName: 'Tester' });
    expect(doc.getMap(BOARD_NOTES_MAP).size).toBe(1);
  });

  it('refuses empty, long and owner-only posts', () => {
    expect(postNote(BOARD, 'open', { text: '   ', colour: 'pink' }, alice).ok).toBe(false);
    expect(postNote(BOARD, 'open', { text: 'x'.repeat(MAX_NOTE_TEXT + 1), colour: 'pink' }, alice).ok).toBe(false);
    expect(canPost('owner')).toBe(false);
    expect(postNote(BOARD, 'owner', { text: 'notice', colour: 'white' }, alice).ok).toBe(false);
    state.isOwner = true;
    expect(postNote(BOARD, 'owner', { text: 'notice', colour: 'white' }, owner).ok).toBe(true);
    expect(readBoard(BOARD, 'owner').shown.map((n) => n.text)).toEqual(['notice']);
  });

  it('replaces the author’s oldest note when they post a fourth', () => {
    const map = doc.getMap(BOARD_NOTES_MAP);
    for (let i = 1; i <= 3; i++) {
      // Stamps must differ: set them apart by writing directly.
      const n = signNote(ROOM, BOARD, { authorName: 'A', text: `old ${i}`, colour: 'yellow', x: 0.1 * i, y: 0.2, ts: Date.now() - 10_000 + i }, alice);
      map.set(noteKey(BOARD, n.id), n.note);
    }
    expect(postNote(BOARD, 'open', { text: 'new', colour: 'yellow' }, alice).ok).toBe(true);
    expect(readBoard(BOARD, 'open').shown.map((n) => n.text)).toEqual(['new', 'old 3', 'old 2']);
    expect(map.size).toBe(3);
  });

  it('lets an author take down their own note, and only the owner take down others’', () => {
    const r = postNote(BOARD, 'open', { text: 'mine', colour: 'blue' }, alice);
    if (!r.ok) throw new Error(r.why);
    expect(takeDownNote(BOARD, r.id, 'open', bob)).toBe(false);
    expect(readBoard(BOARD, 'open').shown).toHaveLength(1);
    state.isOwner = true;
    expect(takeDownNote(BOARD, r.id, 'open', bob)).toBe(true);
    expect(readBoard(BOARD, 'open').shown).toHaveLength(0);
    const own = postNote(BOARD, 'open', { text: 'again', colour: 'blue' }, alice);
    if (!own.ok) throw new Error(own.why);
    state.isOwner = false;
    expect(takeDownNote(BOARD, own.id, 'open', alice)).toBe(true);
  });

  it('clears a board for the owner only', () => {
    postNote(BOARD, 'open', { text: 'a', colour: 'blue' }, alice);
    postNote('corkboard-2', 'open', { text: 'b', colour: 'blue' }, alice);
    expect(clearBoard(BOARD)).toBe(false);
    state.isOwner = true;
    expect(clearBoard(BOARD)).toBe(true);
    expect(readBoard(BOARD, 'open').shown).toHaveLength(0);
    expect(readBoard('corkboard-2', 'open').shown).toHaveLength(1);
  });

  it('forgets a removed board’s notes, and only that board’s', () => {
    postNote(BOARD, 'open', { text: 'a', colour: 'blue' }, alice);
    postNote(BOARD, 'open', { text: 'b', colour: 'blue' }, bob);
    postNote('corkboard-2', 'open', { text: 'c', colour: 'blue' }, alice);
    expect(forgetBoard(BOARD)).toBe(2);
    expect(readBoard(BOARD, 'open').shown).toHaveLength(0);
    expect(readBoard('corkboard-2', 'open').shown).toHaveLength(1);
    expect(forgetBoard(BOARD)).toBe(0);
  });

  it('counts the boards in a room against the cap', () => {
    const items = [{ kind: 'corkboard' }, { kind: 'notice-case' }, { kind: 'smart-tv' }, { kind: 'corkboard' }];
    expect(countBoards(items)).toBe(3);
    expect(MAX_BOARDS_PER_ROOM).toBe(4);
  });

  it('trims junk only once the host has answered, and never empties a case whose owner is unknown', () => {
    const map = doc.getMap(BOARD_NOTES_MAP);
    map.set(noteKey(BOARD, 'junk'), { v: 1, nonsense: true });
    state.canTrim = false;
    expect(trimBoard(BOARD, 'open')).toBe(0);
    expect(map.size).toBe(1);
    state.canTrim = true;
    expect(trimBoard(BOARD, 'open')).toBe(1);
    expect(map.size).toBe(0);

    state.isOwner = true;
    postNote(BOARD, 'owner', { text: 'notice', colour: 'white' }, owner);
    state.ownerPub = undefined;
    expect(trimBoard(BOARD, 'owner')).toBe(0);
    expect(map.size).toBe(1);
  });

  it('marks notes seen when the board is opened, never the reader’s own', () => {
    const r = postNote(BOARD, 'open', { text: 'for you', colour: 'green' }, alice);
    if (!r.ok) throw new Error(r.why);
    const n = readBoard(BOARD, 'open').shown[0];
    expect(isUnseen(ROOM, BOARD, n, bob.pub)).toBe(true);
    expect(isUnseen(ROOM, BOARD, n, alice.pub)).toBe(false);
    expect([...unseenIds(BOARD, 'open', bob.pub)]).toEqual([n.id]);
    markBoardSeen(BOARD, 'open');
    expect(isUnseen(ROOM, BOARD, n, bob.pub)).toBe(false);
    expect(unseenIds(BOARD, 'open', bob.pub).size).toBe(0);
  });

  it('remembers seen notes by id, so a note stamped ahead hides no later one (#330 review)', () => {
    const map = doc.getMap(BOARD_NOTES_MAP);
    const ahead = note(alice, 'my clock runs fast', Date.now() + 5 * 60_000);
    map.set(noteKey(BOARD, ahead.id), ahead.note);
    markBoardSeen(BOARD, 'open');
    // Posted after the board was opened, by a writer whose clock is right.
    const later = note(owner, 'posted afterwards', Date.now());
    map.set(noteKey(BOARD, later.id), later.note);
    const shown = readBoard(BOARD, 'open').shown;
    expect(shown.map((n) => n.text)).toEqual(['my clock runs fast', 'posted afterwards']);
    expect(isUnseen(ROOM, BOARD, shown[0], bob.pub)).toBe(false);
    expect(isUnseen(ROOM, BOARD, shown[1], bob.pub)).toBe(true);
    // And one that arrives late with an old stamp still glows.
    const late = note(signer('late'), 'sent from a slow link', Date.now() - 3600_000);
    map.set(noteKey(BOARD, late.id), late.note);
    expect(readBoardScreen(BOARD, 'open').notes.find((n) => n.text === 'sent from a slow link')?.unseen).toBe(true);
  });

  it('never lends a genuine note’s cached verdict to an altered copy (#330 review)', () => {
    const map = doc.getMap(BOARD_NOTES_MAP);
    state.isOwner = true;
    const r = postNote(BOARD, 'owner', { text: 'Rules: be kind', colour: 'white' }, owner);
    if (!r.ok) throw new Error(r.why);
    expect(readBoard(BOARD, 'owner').shown.map((n) => n.text)).toEqual(['Rules: be kind']); // warms the cache
    const genuine = map.get(noteKey(BOARD, r.id)) as BoardNote;
    // Same author and signature, new text, filed under the id its bytes hash to.
    const { sig: _sig, ...unsigned } = { ...genuine, text: 'Rules: send me your coins' };
    const forgedId = signNote(ROOM, BOARD, { ...unsigned }, { pub: owner.pub, sign: () => genuine.sig }).id;
    map.set(noteKey(BOARD, forgedId), { ...unsigned, sig: genuine.sig });
    expect(readBoard(BOARD, 'owner').shown.map((n) => n.text)).toEqual(['Rules: be kind']);
  });

  it('says which room it is bound to, so an open panel can tell it was beamed away (#330 review)', () => {
    expect(boardRoomId()).toBe(ROOM);
    setBoardDeps({ roomId: () => 'room-b', ownerPub: () => undefined, isOwner: () => false, myName: () => 'T', canTrim: () => true });
    expect(boardRoomId()).toBe('room-b');
    setBoardDeps(null);
    expect(boardRoomId()).toBe('');
  });

  it('hides an author on this screen only', () => {
    postNote(BOARD, 'open', { text: 'hi', colour: 'green' }, alice);
    postNote(BOARD, 'open', { text: 'yo', colour: 'green' }, bob);
    setAuthorHidden(alice.pub, true);
    const face = readBoardScreen(BOARD, 'open');
    expect(face.notes.map((n) => n.text)).toEqual(['yo']);
    expect(face.hiddenCount).toBe(1);
    expect(readBoard(BOARD, 'open').shown).toHaveLength(2); // the board itself still holds both
    setAuthorHidden(alice.pub, false);
    expect(readBoardScreen(BOARD, 'open').notes).toHaveLength(2);
  });

  // ── Take-downs (#315's second PR: bundles carry notes between copies) ──

  it('keeps a note down when a copy that never saw the take-down brings it back', () => {
    const notes = doc.getMap(BOARD_NOTES_MAP);
    const n = note(alice, 'spam spam spam', Date.now() - 1000);
    notes.set(noteKey(BOARD, n.id), n.note);
    state.isOwner = true;
    expect(takeDownNote(BOARD, n.id, 'open', owner)).toBe(true);
    expect(doc.getMap(BOARD_DOWN_MAP).has(noteKey(BOARD, n.id))).toBe(true);
    // Another copy's item for the same key wins it again.
    notes.set(noteKey(BOARD, n.id), n.note);
    expect(readBoard(BOARD, 'open').shown).toEqual([]);
    expect(trimBoard(BOARD, 'open')).toBe(1);
    expect(notes.has(noteKey(BOARD, n.id))).toBe(false);
    expect(doc.getMap(BOARD_DOWN_MAP).has(noteKey(BOARD, n.id))).toBe(true); // the take-down stays
  });

  it('honours a take-down only by the note’s author or the owner', () => {
    const notes = doc.getMap(BOARD_NOTES_MAP);
    const downs = doc.getMap(BOARD_DOWN_MAP);
    const n = note(alice, 'mine', Date.now() - 1000);
    notes.set(noteKey(BOARD, n.id), n.note);
    downs.set(noteKey(BOARD, n.id), signDown(ROOM, BOARD, n.id, Date.now(), bob));
    expect(readBoard(BOARD, 'open').shown.map((x) => x.text)).toEqual(['mine']);
    // A take-down copied from another note or board doesn't fit this one.
    const other = note(alice, 'other', Date.now() - 2000);
    downs.set(noteKey(BOARD, n.id), signDown(ROOM, BOARD, other.id, Date.now(), alice));
    expect(readBoard(BOARD, 'open').shown).toHaveLength(1);
    downs.set(noteKey(BOARD, n.id), signDown(ROOM, BOARD, n.id, Date.now(), alice));
    expect(readBoard(BOARD, 'open').shown).toEqual([]);
  });

  it('clears with a signed CLEAR that covers every copy’s notes, and posts after it still show', () => {
    const notes = doc.getMap(BOARD_NOTES_MAP);
    const early = note(alice, 'before the clear', Date.now() - 5000);
    notes.set(noteKey(BOARD, early.id), early.note);
    state.isOwner = true;
    expect(clearBoard(BOARD, owner)).toBe(true);
    expect(doc.getMap(BOARD_DOWN_MAP).has(`${BOARD}|${CLEAR_TARGET}`)).toBe(true);
    notes.set(noteKey(BOARD, early.id), early.note); // a copy that never saw the clear
    expect(readBoard(BOARD, 'open').shown).toEqual([]);
    const r = postNote(BOARD, 'open', { text: 'after the clear', colour: 'blue' }, bob);
    expect(r.ok).toBe(true);
    expect(readBoard(BOARD, 'open').shown.map((x) => x.text)).toEqual(['after the clear']);
  });

  it('ignores a CLEAR not signed by the owner', () => {
    const notes = doc.getMap(BOARD_NOTES_MAP);
    const n = note(alice, 'still here', Date.now() - 5000);
    notes.set(noteKey(BOARD, n.id), n.note);
    doc.getMap(BOARD_DOWN_MAP).set(`${BOARD}|${CLEAR_TARGET}`, signDown(ROOM, BOARD, CLEAR_TARGET, Date.now(), bob));
    expect(readBoard(BOARD, 'open').shown).toHaveLength(1);
    expect(trimBoard(BOARD, 'open')).toBe(1); // the false CLEAR itself
    expect(readBoard(BOARD, 'open').shown).toHaveLength(1);
  });

  it('trims junk take-downs, and keeps valid ones a month even past the newest 128 (#332 review)', () => {
    const entries: Array<[string, unknown]> = [];
    entries.push([`${BOARD}|nonsense`, { v: 1, by: 'x', ts: 1, sig: 's' }]);
    entries.push([`${BOARD}|${'a'.repeat(32)}`, { v: 9 }]);
    const forged = signDown(ROOM, BOARD, 'b'.repeat(32), NOW, alice);
    entries.push([`${BOARD}|${'b'.repeat(32)}`, { ...forged, ts: NOW + 1 }]);
    const idOf = (i: number) => i.toString(16).padStart(32, '0');
    // Young ones past the newest 128 stay (a copy offline for weeks, or a
    // bundle sealed before them, could still hold their notes)…
    for (let i = 0; i < MAX_DOWN_PER_BOARD + 2; i++) entries.push([`${BOARD}|${idOf(i)}`, signDown(ROOM, BOARD, idOf(i), NOW - i, alice)]);
    // …and only ones past both the count and the month go.
    const old = [1000, 1001].map((i) => {
      entries.push([`${BOARD}|${idOf(i)}`, signDown(ROOM, BOARD, idOf(i), NOW - DOWN_KEEP_MS - i, alice)]);
      return `${BOARD}|${idOf(i)}`;
    });
    // A take-down of a note this copy holds counts by its author or the
    // owner; a stranger's sits on the key for nothing. One of a note it
    // doesn't hold can't be judged, so it stays.
    const held = note(alice, 'held', NOW - 5000);
    const heldKey = noteKey(BOARD, held.id);
    entries.push([heldKey, signDown(ROOM, BOARD, held.id, NOW, bob)]);
    const ctx = { roomId: ROOM, kind: 'open' as const, now: NOW, ownerPub: owner.pub, noteOf: (k: string) => (k === heldKey ? held.note : undefined) };
    expect(new Set(planDownTrim(entries, BOARD, ctx))).toEqual(
      new Set([`${BOARD}|nonsense`, `${BOARD}|${'a'.repeat(32)}`, `${BOARD}|${'b'.repeat(32)}`, ...old, heldKey]),
    );
    // The owner's take-down of that note stays; with the owner unknown the
    // stranger's can't be judged and stays too.
    entries[entries.length - 1] = [heldKey, signDown(ROOM, BOARD, held.id, NOW, owner)];
    expect(planDownTrim(entries, BOARD, ctx)).not.toContain(heldKey);
    entries[entries.length - 1] = [heldKey, signDown(ROOM, BOARD, held.id, NOW, bob)];
    expect(planDownTrim(entries, BOARD, { ...ctx, ownerPub: undefined })).not.toContain(heldKey);
  });

  it('keeps at most MAX_DOWN_RETAINED take-downs a board, the newest', () => {
    const entries: Array<[string, unknown]> = [];
    const idOf = (i: number) => i.toString(16).padStart(32, '0');
    for (let i = 0; i <= MAX_DOWN_RETAINED; i++) entries.push([`${BOARD}|${idOf(i)}`, signDown(ROOM, BOARD, idOf(i), NOW - i, alice)]);
    expect(planDownTrim(entries, BOARD, { roomId: ROOM, kind: 'open', now: NOW, ownerPub: owner.pub })).toEqual([`${BOARD}|${idOf(MAX_DOWN_RETAINED)}`]);
  });

  // ── Merging what other copies sealed ──

  const view = (notes: Array<[string, unknown]>, down: Array<[string, unknown]> = []) => ({ room: ROOM, notes, down });

  it('merges another copy’s signed notes onto the room’s boards only', () => {
    const fromBob = note(bob, 'left while you were away', Date.now() - 60_000);
    const onRemoved = note(bob, 'on a board since removed', Date.now() - 60_000, { board: 'corkboard-9' });
    const forged = { ...note(bob, 'x', Date.now() - 1000).note, text: 'y' };
    const forgedId = signNote(ROOM, BOARD, { ...forged }, bob).id;
    const result = mergeBoardView(view([
      entry(fromBob),
      entry(onRemoved, 'corkboard-9'),
      [noteKey(BOARD, forgedId), { ...forged, sig: note(bob, 'x', Date.now() - 1000).note.sig }],
      [noteKey(BOARD, 'f'.repeat(32)), fromBob.note], // filed under the wrong id
    ]));
    expect(result).toEqual({ notes: 1, down: 0 });
    expect(readBoard(BOARD, 'open').shown.map((n) => n.text)).toEqual(['left while you were away']);
    expect(mergeBoardView(view([entry(fromBob)]))).toEqual({ notes: 0, down: 0 }); // already here
    expect(mergeBoardView({ ...view([entry(note(alice, 'z', Date.now()))]), room: 'room-b' })).toBeNull();
  });

  it('never brings back a note this copy deleted or one with a take-down', () => {
    const n = note(alice, 'trimmed here', Date.now() - 60_000);
    const notes = doc.getMap(BOARD_NOTES_MAP);
    notes.set(noteKey(BOARD, n.id), n.note);
    notes.delete(noteKey(BOARD, n.id));
    const m = note(alice, 'taken down elsewhere', Date.now() - 50_000);
    expect(mergeBoardView(view([entry(n), entry(m)], [[noteKey(BOARD, m.id), signDown(ROOM, BOARD, m.id, Date.now(), alice)]])))
      .toEqual({ notes: 0, down: 1 });
    expect(readBoard(BOARD, 'open').shown).toEqual([]);
  });

  it('merges take-downs and CLEARs, and only the owner’s CLEAR', () => {
    const notes = doc.getMap(BOARD_NOTES_MAP);
    const n = note(alice, 'held here', Date.now() - 60_000);
    notes.set(noteKey(BOARD, n.id), n.note);
    const strangers = signDown(ROOM, BOARD, CLEAR_TARGET, Date.now(), bob);
    expect(mergeBoardView(view([], [[`${BOARD}|${CLEAR_TARGET}`, strangers]]))).toEqual({ notes: 0, down: 0 });
    const byBob = signDown(ROOM, BOARD, n.id, Date.now(), bob);
    expect(mergeBoardView(view([], [[noteKey(BOARD, n.id), byBob]]))).toEqual({ notes: 0, down: 0 }); // not the author
    const clear = signDown(ROOM, BOARD, CLEAR_TARGET, Date.now(), owner);
    expect(mergeBoardView(view([], [[`${BOARD}|${CLEAR_TARGET}`, clear]]))).toEqual({ notes: 0, down: 1 });
    expect(readBoard(BOARD, 'open').shown).toEqual([]);
    expect(notes.has(noteKey(BOARD, n.id))).toBe(false); // the merge's trim took it off
    const older = signDown(ROOM, BOARD, CLEAR_TARGET, Date.now() - 10_000, owner);
    expect(mergeBoardView(view([], [[`${BOARD}|${CLEAR_TARGET}`, older]]))).toEqual({ notes: 0, down: 0 });
  });

  it('merges notice-case notes only by the owner, and waits for the host before writing', () => {
    const notice = note(owner, 'official', Date.now() - 1000, { board: CASE });
    const fake = note(bob, 'also official', Date.now() - 1000, { board: CASE });
    state.canTrim = false;
    expect(mergeBoardView(view([entry(notice, CASE), entry(fake, CASE)]))).toBeNull();
    expect(readBoard(CASE, 'owner').shown).toEqual([]);
    state.canTrim = true;
    retryBoardView();
    expect(readBoard(CASE, 'owner').shown.map((n) => n.text)).toEqual(['official']);
  });

  it('lets the author’s take-down replace a stranger’s, even one the trim took off (#332 review)', () => {
    const downs = doc.getMap(BOARD_DOWN_MAP);
    const n = note(alice, 'mine', Date.now() - 60_000);
    const key = noteKey(BOARD, n.id);
    const strangers = signDown(ROOM, BOARD, n.id, Date.now() - 30_000, bob);
    const hers = signDown(ROOM, BOARD, n.id, Date.now() - 20_000, alice);
    // A stranger's take-down filed before her note came: it can't hold the
    // key against hers, and the note stays down.
    downs.set(key, strangers);
    expect(mergeBoardView(view([entry(n)], [[key, hers]]))).toEqual({ notes: 0, down: 1 });
    expect((downs.get(key) as { by: string }).by).toBe(alice.pub);
    expect(readBoard(BOARD, 'open').shown).toEqual([]);
    // Or her note is here, the trim took the stranger's off, and hers then
    // arrives: a trimmed key must not lock it out.
    const m = note(alice, 'also mine', Date.now() - 60_000);
    const mKey = noteKey(BOARD, m.id);
    doc.getMap(BOARD_NOTES_MAP).set(mKey, m.note);
    downs.set(mKey, signDown(ROOM, BOARD, m.id, Date.now() - 30_000, bob));
    trimBoard(BOARD, 'open');
    expect(downs.has(mKey)).toBe(false);
    expect(readBoard(BOARD, 'open').shown.map((x) => x.text)).toEqual(['also mine']);
    expect(mergeBoardView(view([], [[mKey, signDown(ROOM, BOARD, m.id, Date.now(), alice)]]))).toEqual({ notes: 0, down: 1 });
    expect(readBoard(BOARD, 'open').shown).toEqual([]);
    // A stranger's never replaces hers.
    expect(mergeBoardView(view([entry(n)], [[key, signDown(ROOM, BOARD, n.id, Date.now(), bob)]]))).toEqual({ notes: 0, down: 0 });
    expect((downs.get(key) as { by: string }).by).toBe(alice.pub);
  });

  it('takes the newest valid CLEAR whatever order the view lists them in (#332 review)', () => {
    const clearKey = `${BOARD}|${CLEAR_TARGET}`;
    const t1 = Date.now() - 60_000;
    const t2 = Date.now() - 10_000;
    const between = note(bob, 'cleared at T2', t1 + 5_000);
    const after = note(bob, 'after both', t2 + 1_000);
    for (const order of [[t1, t2], [t2, t1]]) {
      doc = new Y.Doc();
      bindBoardDoc(doc);
      const clears = order.map((t) => [clearKey, signDown(ROOM, BOARD, CLEAR_TARGET, t, owner)] as [string, unknown]);
      // A forged CLEAR claiming the owner and a later stamp doesn't count.
      clears.push([clearKey, { ...signDown(ROOM, BOARD, CLEAR_TARGET, t1, owner), ts: t2 + 5_000 }]);
      expect(mergeBoardView(view([entry(between), entry(after)], clears))).toEqual({ notes: 1, down: 1 });
      expect((doc.getMap(BOARD_DOWN_MAP).get(clearKey) as { ts: number }).ts, `order ${order}`).toBe(t2);
      expect(readBoard(BOARD, 'open').shown.map((x) => x.text)).toEqual(['after both']);
    }
  });

  it('merges a long view in rounds, never dropping what a budget put off (#332 review)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A view led by a board's whole budget of bad signatures, then a
      // genuine note: the first round writes nothing, the next one has it.
      const junk: Array<[string, unknown]> = [];
      const real = signDown(ROOM, BOARD, 'f'.repeat(32), Date.now(), bob);
      for (let i = 0; i < MAX_VERIFIED_PER_BOARD; i++) {
        const id = i.toString(16).padStart(32, '0');
        junk.push([`${BOARD}|${id}`, { ...real }]); // another note's signature
      }
      const fromBob = note(bob, 'behind the junk', Date.now() - 1000);
      expect(mergeBoardView(view([entry(fromBob)], junk))).toEqual({ notes: 0, down: 0 });
      expect(pendingBoardEntries()).toBe(1);
      vi.advanceTimersByTime(2_000);
      expect(pendingBoardEntries()).toBe(0);
      expect(readBoard(BOARD, 'open').shown.map((n) => n.text)).toEqual(['behind the junk']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps what only the owner’s key can judge until it arrives (#332 review)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      state.ownerPub = undefined;
      const notice = note(owner, 'official', Date.now() - 1000, { board: CASE });
      const covered = note(alice, 'before the clear', Date.now() - 60_000);
      const elsewhere = note(bob, 'on the other board', Date.now() - 60_000, { board: 'corkboard-2' });
      const clear: [string, unknown] = [`${BOARD}|${CLEAR_TARGET}`, signDown(ROOM, BOARD, CLEAR_TARGET, Date.now() - 30_000, owner)];
      expect(mergeBoardView(view([entry(notice, CASE), entry(covered), entry(elsewhere, 'corkboard-2')], [clear]))).toEqual({ notes: 1, down: 0 });
      expect(pendingBoardEntries()).toBe(3);
      vi.advanceTimersByTime(10_000);
      expect(pendingBoardEntries()).toBe(3); // no timer spins while the key is missing
      state.ownerPub = owner.pub;
      refreshBoards();
      vi.advanceTimersByTime(2_000);
      expect(pendingBoardEntries()).toBe(0);
      expect(readBoard(CASE, 'owner').shown.map((n) => n.text)).toEqual(['official']);
      expect(doc.getMap(BOARD_DOWN_MAP).has(`${BOARD}|${CLEAR_TARGET}`)).toBe(true);
      expect(readBoard(BOARD, 'open').shown).toEqual([]);
      expect(readBoard('corkboard-2', 'open').shown.map((n) => n.text)).toEqual(['on the other board']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an unpin down across two copies whose Yjs items race for the key', () => {
    // The poster's copy (B) and the owner's copy (A) never meet until the
    // owner has merged B's note from a bundle and taken it down. Which copy's
    // item wins the key goes by client id, so both orders are tried: without
    // the take-down record, one of them brings the note back.
    for (const [idA, idB] of [[1, 2], [2, 1]]) {
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.clientID = idA;
      b.clientID = idB;
      state.isOwner = false;
      bindBoardDoc(b);
      const r = postNote(BOARD, 'open', { text: 'rude', colour: 'pink' }, alice);
      if (!r.ok) throw new Error(r.why);
      const sealed = [...b.getMap(BOARD_NOTES_MAP).entries()] as Array<[string, unknown]>;
      bindBoardDoc(a);
      expect(mergeBoardView(view(sealed))).toEqual({ notes: 1, down: 0 });
      state.isOwner = true;
      expect(takeDownNote(BOARD, r.id, 'open', owner)).toBe(true);
      // Now they sync, both ways.
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      for (const d of [a, b]) {
        bindBoardDoc(d);
        expect(readBoard(BOARD, 'open').shown, `client ids ${idA}/${idB}`).toEqual([]);
      }
    }
  });
});
