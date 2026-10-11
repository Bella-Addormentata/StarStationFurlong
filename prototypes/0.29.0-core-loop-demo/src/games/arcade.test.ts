/**
 * 🕹️ The arcade match record: a guest takes and gives back the second seat,
 * and a record whose guest is half there is refused.
 */

import { describe, expect, it } from 'vitest';
import { freshMatchId, isArcadeMatch, newMatch, withGuest, withoutGuest, yieldsMatchId } from './arcade';

const match = () => newMatch({ game: 'thwaite', host: 'p1', hostPage: 'page-1', hostSeat: 0, now: 1, random: () => 0.5 });

describe('arcade match', () => {
  it('seats one guest page at a time, never the host page', () => {
    const m = withGuest(match(), 'p2', 'page-2', () => 0.25)!;
    expect(m).toMatchObject({ guest: 'p2', guestPage: 'page-2' });
    expect(m.guestToken).not.toBe(0);
    expect(withGuest(m, 'p2', 'page-2')).toBe(m); // already there
    expect(withGuest(m, 'p3', 'page-3')).toBeNull(); // taken
    expect(withGuest(match(), 'p1', 'page-1')).toBeNull(); // the host's own page
    expect(withoutGuest(m, 'page-3')).toBe(m); // only the holder gives it back
    expect(withoutGuest(m, 'page-2')).toMatchObject({ guest: null, guestPage: null, guestToken: 0 });
  });

  it('accepts a guest only all there or not there at all', () => {
    const m = match();
    const seated = withGuest(m, 'p2', 'page-2')!;
    expect(isArcadeMatch(m)).toBe(true);
    expect(isArcadeMatch(seated)).toBe(true);
    expect(isArcadeMatch({ ...m, guestPage: 'page-2' })).toBe(false); // a seat no tick can drive
    expect(isArcadeMatch({ ...m, guestToken: 7 })).toBe(false); // a token with nobody behind it
    expect(isArcadeMatch({ ...seated, guestToken: 0 })).toBe(false);
    expect(isArcadeMatch({ ...seated, guest: null })).toBe(false);
  });

  it("picks an id no other cabinet's match holds", () => {
    const half = () => 0.5;
    const id = freshMatchId(new Set(), half);
    expect(freshMatchId(new Set([id]), half)).toBe(id + 1);
    expect(freshMatchId(new Set([id, id + 1]), half)).toBe(id + 2);
    // From the top it wraps to 1, never 0.
    expect(freshMatchId(new Set([0xffff]), () => 0.99999999)).toBe(1);
    expect(newMatch({ game: 'g', host: 'h', hostPage: 'p', hostSeat: 0, now: 1, taken: new Set([id]), random: half }).id)
      .toBe(id + 1);
  });

  it('of two cabinets that claimed one id at once, exactly the later claim moves', () => {
    const early = { cabinet: 'b', match: { ...match(), startedAt: 1 } };
    const late = { cabinet: 'a', match: { ...match(), startedAt: 2 } };
    expect(yieldsMatchId(late, early)).toBe(true);
    expect(yieldsMatchId(early, late)).toBe(false);
    // Started together: the larger cabinet id moves.
    const x = { cabinet: 'x', match: match() };
    const y = { cabinet: 'y', match: match() };
    expect(yieldsMatchId(y, x)).toBe(true);
    expect(yieldsMatchId(x, y)).toBe(false);
    // Different ids, or the same cabinet: nothing to do.
    expect(yieldsMatchId(late, { cabinet: 'b', match: { ...early.match, id: early.match.id + 1 } })).toBe(false);
    expect(yieldsMatchId(late, { cabinet: 'a', match: early.match })).toBe(false);
  });
});

describe("the room's matches, as the doc holds them", () => {
  it('are read once per change to the games map, and follow every change, local or from a peer', async () => {
    const Y = await import('yjs');
    const { bindGamesDoc, readArcadeMatches, writeArcade } = await import('./gamesDoc');
    const doc = new Y.Doc();
    bindGamesDoc(doc);
    const m = newMatch({ game: 'thwaite', host: 'h', hostPage: 'p', hostSeat: 0, now: 1 });
    writeArcade('arcade-1', m);
    const first = readArcadeMatches();
    expect([...first.keys()]).toEqual(['arcade-1']);
    expect(readArcadeMatches()).toBe(first); // no change: the same answer, not a new scan

    // A peer's write lands as a doc update.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getMap('games').set('arcade-2', { ...m, id: (m.id % 65535) + 1 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect([...readArcadeMatches().keys()].sort()).toEqual(['arcade-1', 'arcade-2']);

    writeArcade('arcade-1', null);
    expect([...readArcadeMatches().keys()]).toEqual(['arcade-2']);
    bindGamesDoc(new Y.Doc()); // another room
    expect(readArcadeMatches().size).toBe(0);
  });
});
