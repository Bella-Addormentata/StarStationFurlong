/**
 * 📌 Room boards (#315): the signed note record, the read rule (shape, id,
 * post rule, signatures, caps), the trim plan, and the bound store's writes.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { utf8ToBytes } from '@noble/hashes/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BOARD_NOTES_MAP,
  MAX_BOARD_NOTES,
  MAX_KEYS_VISITED,
  MAX_NOTE_TEXT,
  MAX_NOTES_PER_AUTHOR,
  bindBoardDoc,
  boardKindOf,
  canPost,
  cleanNoteText,
  clearBoard,
  freeSpot,
  isUnseen,
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
    expect(takeDownNote(BOARD, r.id, 'open', bob.pub)).toBe(false);
    expect(readBoard(BOARD, 'open').shown).toHaveLength(1);
    state.isOwner = true;
    expect(takeDownNote(BOARD, r.id, 'open', bob.pub)).toBe(true);
    expect(readBoard(BOARD, 'open').shown).toHaveLength(0);
    const own = postNote(BOARD, 'open', { text: 'again', colour: 'blue' }, alice);
    if (!own.ok) throw new Error(own.why);
    state.isOwner = false;
    expect(takeDownNote(BOARD, own.id, 'open', alice.pub)).toBe(true);
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
    markBoardSeen(BOARD, 'open');
    expect(isUnseen(ROOM, BOARD, n, bob.pub)).toBe(false);
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
});
