/**
 * 🕹️ Reading every cabinet's match: a hosting cabinet asks every frame, so
 * the shared map (any peer can fill it) is walked once per change, not once
 * per frame, and a change from either side is seen at once.
 */

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { newMatch } from './arcade';
import { bindGamesDoc, readArcadeMatches, writeArcade } from './gamesDoc';

const match = (id: number) =>
  ({ ...newMatch({ game: 'thwaite', host: 'p1', hostPage: 'page-1', hostSeat: 0, now: 1 }), id });

describe('readArcadeMatches', () => {
  it('walks the map once per change, and sees every change', () => {
    const doc = new Y.Doc();
    const peer = new Y.Doc();
    doc.on('update', (u: Uint8Array) => Y.applyUpdate(peer, u));
    peer.on('update', (u: Uint8Array) => Y.applyUpdate(doc, u));
    bindGamesDoc(doc);
    const map = doc.getMap('games');
    for (let i = 0; i < 500; i++) peer.getMap('games').set(`junk-${i}`, { i });
    writeArcade('cab-a', match(11));

    const walk = vi.spyOn(map, 'forEach');
    const first = readArcadeMatches();
    expect([...first.keys()]).toEqual(['cab-a']);
    for (let frame = 0; frame < 60; frame++) readArcadeMatches();
    expect(walk).toHaveBeenCalledTimes(1);

    writeArcade('cab-b', match(12)); // this page's write
    expect([...readArcadeMatches().keys()].sort()).toEqual(['cab-a', 'cab-b']);
    peer.getMap('games').delete('cab-a'); // a peer's
    expect([...readArcadeMatches().keys()]).toEqual(['cab-b']);
    expect(walk).toHaveBeenCalledTimes(3);

    bindGamesDoc(new Y.Doc()); // another room
    expect(readArcadeMatches().size).toBe(0);
  });
});
