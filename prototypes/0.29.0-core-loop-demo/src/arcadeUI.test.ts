/**
 * 🕹 arcadeUI's two views (#193): PLAY at the cabinet, and SETTINGS from the
 * ⚙️ on its front — the cabinet's one game, readable by anyone, with the
 * owner's controls only for the owner (arcadeDoc gates the writes again).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setConvenienceLanesForTest } from './sovereignty';
import {
  bindArcadeDoc, insertCoin, putOnCabinet, takeOffCabinet, setArcadeClock, setArcadeEjectPredicate, setArcadeHostPredicate,
  setArcadeIdentity, setArcadePageId, setEmulatorData, standUp,
} from './arcadeDoc';
import type { ArcadeGame } from './arcadeDoc';
import { ARCADE_GAMES } from './arcadeLibrary';
import { matchPlayers, renderArcadePanel, resetArcadeCabinet, type ArcadeDeviceDeps } from './arcadeUI';
import { newMatch, type ArcadeMatch } from './games/arcade';
import { bindGamesDoc, readArcade, writeArcade } from './games/gamesDoc';

const CAB = 'arcade-cabinet-1';
const LJ65: ArcadeGame = { name: 'lj65.nes', core: 'nes', url: '', size: 40_976 };

let owner = false;
const deps = (view: ArcadeDeviceDeps['view'], canEdit: boolean): ArcadeDeviceDeps => ({
  itemId: CAB, myPub: () => 'AAAAalicepub', myName: () => 'Alice', canEdit: () => canEdit, openStage: () => undefined, view,
});
/** The owner puts a game on; then the visitor looks. */
const ownerPuts = (game: ArcadeGame) => {
  owner = true;
  expect(putOnCabinet(CAB, game).ok).toBe(true);
  owner = false;
};

const OWNER_CONTROLS = ['data-arcade-builtin', 'data-arcade-put', 'data-arcade-takeoff', 'data-arcade-data', 'data-arcade-file', 'data-arcade-url'];

beforeEach(() => {
  owner = false;
  setArcadeClock(() => 1_000_000);
  setArcadeHostPredicate(() => owner);
  setArcadeEjectPredicate(() => false);
  setArcadePageId('tab-a');
  setArcadeIdentity(() => ({ pub: 'AAAAalicepub', name: 'Alice' }));
  bindArcadeDoc(new Y.Doc());
  const games = new Y.Doc();
  games.getMap('players').set('bob-id', { name: 'Bob <b>' });
  bindGamesDoc(games);
  setConvenienceLanesForTest(true);
  owner = true;
  expect(setEmulatorData(CAB, 'cdn').ok).toBe(true);
  owner = false;
});
afterEach(() => { setConvenienceLanesForTest(null); });

describe('the SETTINGS view (the ⚙️)', () => {
  it('shows a visitor the one game and its credits, with nothing to change it', () => {
    const html = renderArcadePanel(CAB, deps('settings', false));
    expect(html).toContain('⚙️ ARCADE CABINET');
    expect(html).toContain('THE OWNER SETS THIS CABINET · ANYONE CAN LOOK');
    expect(html).toContain('ON THE CABINET · ONE GAME');
    expect(html).toContain('THWAITE'); // the default: the first built-in game
    expect(html).toContain('NES · BUILT-IN');
    expect(html).toContain(ARCADE_GAMES[0].author);
    expect(html).toContain(ARCADE_GAMES[0].sourceUrl);
    expect(html).toContain('EMULATORJS FILES');
    expect(html).toContain('cdn.emulatorjs.org'); // where the files come from, as text
    for (const control of OWNER_CONTROLS) expect(html).not.toContain(control);
    expect(html).not.toContain('FREE GAMES');
    expect(html).toContain('data-arcade-play'); // back to the cabinet
  });

  it('gives the owner both kinds of game to pick from, in the same card', () => {
    const html = renderArcadePanel(CAB, deps('settings', true));
    expect(html).toContain('YOU RUN THIS CABINET');
    expect(html).toContain('FREE GAMES · BUILT-IN EMULATOR');
    expect(html).toContain('YOUR OWN GAME · EMULATORJS');
    for (const control of [...OWNER_CONTROLS, 'data-arcade-data="station"', 'data-arcade-data="cdn"']) {
      expect(html).toContain(control);
    }
    // Every free game, the one on the cabinet marked and not offered again.
    for (const lib of ARCADE_GAMES) expect(html).toContain(`data-arcade-builtin="${lib.id}"`);
    expect(html).toMatch(/data-arcade-builtin="thwaite" disabled[\s\S]*✓ ON/);
    expect(html).not.toContain('SHELF');
  });

  it('shows the owner\'s own game as their file, for EmulatorJS', () => {
    ownerPuts(LJ65);
    const html = renderArcadePanel(CAB, deps('settings', false));
    expect(html).toContain('lj65.nes');
    expect(html).not.toContain('NES · BUILT-IN');
    expect(html).toContain('EmulatorJS window');
  });

  it('says who sends the owner\'s file to the players', () => {
    ownerPuts({ ...LJ65, sha256: 'cd'.repeat(32) });
    expect(renderArcadePanel(CAB, deps('settings', false))).toContain('Sent to each player who presses play');
    // The owner's page lost the file (a reload): it says how to send it again.
    expect(renderArcadePanel(CAB, deps('settings', true))).toContain('pick it again below');
    ownerPuts(LJ65); // no hash: from a build before sending
    expect(renderArcadePanel(CAB, deps('settings', false))).toContain('Not sent to players');
    ownerPuts({ ...LJ65, size: 9 * 1024 * 1024, sha256: 'cd'.repeat(32) });
    expect(renderArcadePanel(CAB, deps('settings', false))).toContain('Not sent to players (over 8 MB)');
  });

  it('escapes a peer\'s game name', () => {
    ownerPuts({ ...LJ65, name: '<img src=x onerror=alert(1)>.nes' });
    const html = renderArcadePanel(CAB, deps('settings', false));
    expect(html).not.toContain('<img');
  });
});

describe('NOW PLAYING and the owner\'s RESET (#246\'s card)', () => {
  const match = (over: Partial<ArcadeMatch> = {}): ArcadeMatch => ({
    ...newMatch({ game: 'thwaite', host: 'bob-id', hostPage: 'tab-b', hostSeat: 0, now: 1 }), ...over,
  });

  it('names who holds each player of a built-in game, and what the other stand is', () => {
    expect(matchPlayers(match(), 2, 'me')).toEqual([
      { player: 1, who: 'BOB <B>' },
      { player: 2, who: 'OPEN · STEP UP TO THE RIGHT STAND' },
    ]);
    expect(matchPlayers(match({ hostSeat: 1 }), 2, 'bob-id')).toEqual([
      { player: 1, who: 'OPEN · STEP UP TO THE LEFT STAND' },
      { player: 2, who: 'YOU' },
    ]);
    expect(matchPlayers(match(), 1, 'me')[1].who).toBe("A SECOND GAMEPAD ON PLAYER 1'S COMPUTER");

    writeArcade(CAB, match());
    const html = renderArcadePanel(CAB, { ...deps('settings', false), seats: 2 });
    expect(html).toContain('NOW PLAYING');
    expect(html).toContain('PLAYER 1 · BOB &lt;B&gt;'); // a peer's name, escaped
    expect(html).toContain('PLAYER 2 · OPEN · STEP UP TO THE RIGHT STAND');
    expect(html).not.toContain('data-arcade-reset'); // a visitor reads it
  });

  it('lets the owner end a built-in game for everyone, and nobody else', () => {
    writeArcade(CAB, match());
    const html = renderArcadePanel(CAB, deps('settings', true));
    expect(html).toContain('data-arcade-reset="1"');
    expect(html).not.toContain('data-arcade-reset="1" disabled');
    expect(resetArcadeCabinet(CAB, false)).toBeNull();
    expect(readArcade(CAB)).not.toBeNull();
    expect(resetArcadeCabinet(CAB, true)).toBe('The game ended · the cabinet is free.');
    expect(readArcade(CAB)).toBeNull();
    const after = renderArcadePanel(CAB, deps('settings', true));
    expect(after).toContain('Nobody · step up and press Enter to play.');
    expect(after).toContain('data-arcade-reset="1" disabled');
  });

  it('frees player one\'s seat at the owner\'s own game, when this page may eject', () => {
    ownerPuts(LJ65);
    setArcadeIdentity(() => ({ pub: 'BBBBbobpub', name: 'Bob' }));
    setArcadePageId('tab-b');
    expect(insertCoin(CAB).ok).toBe(true);
    setArcadeIdentity(() => ({ pub: 'AAAAalicepub', name: 'Alice' }));
    setArcadePageId('tab-a');
    const html = renderArcadePanel(CAB, deps('settings', true));
    expect(html).toContain('PLAYER 1 · BOB');
    expect(html).toContain('data-arcade-reset="1" disabled'); // no EJECT here (not the deed holder)
    setArcadeEjectPredicate(() => true);
    expect(resetArcadeCabinet(CAB, true)).toBe('Player one stood up · the cabinet is free.');
    expect(renderArcadePanel(CAB, deps('settings', false))).toContain('Nobody · step up and INSERT COIN to play.');
  });
});

describe('the PLAY view (the owner\'s own game, at the cabinet)', () => {
  it('keeps the coin, and moves the owner\'s settings behind ⚙️', () => {
    ownerPuts(LJ65);
    for (const canEdit of [false, true]) {
      const html = renderArcadePanel(CAB, deps(undefined, canEdit));
      expect(html).toContain('🕹 ARCADE CABINET');
      expect(html).toContain('data-arcade-coin');
      expect(html).toContain('data-arcade-settings');
      for (const control of OWNER_CONTROLS) expect(html).not.toContain(control);
      expect(html).not.toContain('SHELF');
    }
  });

  it('says where the game is picked when the owner took it off, with no coin to take', () => {
    owner = true;
    expect(takeOffCabinet(CAB).ok).toBe(true);
    owner = false;
    const html = renderArcadePanel(CAB, deps(undefined, false));
    expect(html).toContain('the owner picks a game in ⚙️ SETTINGS');
    expect(html).not.toContain('data-arcade-coin');
  });
});

describe('the double-wide cabinet\'s four players (#242)', () => {
  const wide = (view: ArcadeDeviceDeps['view'], canEdit: boolean, seat?: number): ArcadeDeviceDeps => ({ ...deps(view, canEdit), seats: 4, seat });
  /** Another player's page takes a seat. */
  const sits = (pub: string, name: string, page: string, seat: number) => {
    setArcadeIdentity(() => ({ pub, name }));
    setArcadePageId(page);
    expect(insertCoin(CAB, seat).ok).toBe(true);
    setArcadeIdentity(() => ({ pub: 'AAAAalicepub', name: 'Alice' }));
    setArcadePageId('tab-a');
  };

  it('lists the four seats, a coin at each free one, the big one at the stand stepped up to', () => {
    ownerPuts(LJ65);
    sits('BBBBbobpub', 'Bob <b>', 'tab-b', 0);
    const html = renderArcadePanel(CAB, wide(undefined, false, 2));
    expect(html).toContain('PLAYERS · UP TO FOUR, EACH ON THEIR OWN COMPUTER');
    expect(html).toMatch(/P1<\/span>\s*<span[^>]*>BOB &lt;B&gt;<\/span>/); // a peer's name, escaped
    for (const n of [1, 2, 3]) expect(html).toContain(`data-arcade-coin="${n}"`);
    expect(html).not.toContain('data-arcade-coin="0"');
    expect(html).toContain('INSERT COIN · PLAY AS P3');
    expect(html).not.toContain('data-arcade-eject'); // not the deed holder
    expect(html).not.toContain('PLAYER ONE');
    setArcadeEjectPredicate(() => true);
    expect(renderArcadePanel(CAB, wide(undefined, false))).toContain('data-arcade-eject="0"');
  });

  it('gives a seated player the way back to the controls and STAND UP, and no second seat', () => {
    ownerPuts(LJ65);
    expect(insertCoin(CAB, 1).ok).toBe(true);
    const html = renderArcadePanel(CAB, wide(undefined, false, 1));
    expect(html).toMatch(/P2<\/span>\s*<span[^>]*>YOU<\/span>/);
    expect(html).toContain('data-arcade-standup="1"');
    expect(html).toContain('BACK TO THE CONTROLS');
    expect(html).not.toContain('data-arcade-coin');
  });

  it('says so when every seat is taken', () => {
    ownerPuts(LJ65);
    for (const n of [0, 1, 2, 3]) sits(`P${n}pub`, `Player ${n}`, `tab-${n}`, n);
    const html = renderArcadePanel(CAB, wide(undefined, false));
    expect(html).toContain('All four seats are taken.');
    expect(html).not.toContain('data-arcade-coin');
  });

  it('names every player in NOW PLAYING, and the deed holder\'s RESET stands them all up', () => {
    ownerPuts(LJ65);
    sits('BBBBbobpub', 'Bob', 'tab-b', 0);
    sits('CCCCcarolpub', 'Carol', 'tab-c', 3);
    const html = renderArcadePanel(CAB, wide('settings', true));
    expect(html).toContain('PLAYER 1 · BOB');
    expect(html).toContain('PLAYER 4 · CAROL');
    expect(html).toContain('for up to four players, each on their own computer');
    expect(html).toContain('data-arcade-reset="1" disabled'); // seated nowhere, and no EJECT
    setArcadeEjectPredicate(() => true);
    expect(resetArcadeCabinet(CAB, true, 4)).toBe('The players stood up · the cabinet is free.');
    expect(renderArcadePanel(CAB, wide('settings', false))).toContain('Nobody · step up and INSERT COIN to play.');
  });

  it('frees every stand or none: an editor without the deed resets only while the seats held are all theirs', () => {
    ownerPuts(LJ65);
    sits('BBBBbobpub', 'Bob', 'tab-b', 0);
    expect(insertCoin(CAB, 2).ok).toBe(true); // this page (an editor, say a venture's shareholder) sits too
    expect(renderArcadePanel(CAB, wide('settings', true, 2))).toContain('data-arcade-reset="1" disabled');
    expect(resetArcadeCabinet(CAB, true, 4)).toBe('Bob is at the controls.'); // a panel painted before Bob sat
    let html = renderArcadePanel(CAB, wide('settings', true, 2));
    expect(html).toContain('PLAYER 1 · BOB');
    expect(html).toContain('PLAYER 3 · YOU'); // nobody stood up
    // Bob goes: the only seat held is this page's, and RESET frees it.
    setArcadeIdentity(() => ({ pub: 'BBBBbobpub', name: 'Bob' }));
    setArcadePageId('tab-b');
    expect(standUp(CAB, 0).ok).toBe(true);
    setArcadeIdentity(() => ({ pub: 'AAAAalicepub', name: 'Alice' }));
    setArcadePageId('tab-a');
    html = renderArcadePanel(CAB, wide('settings', true, 2));
    expect(html).toContain('data-arcade-reset="1"');
    expect(html).not.toContain('data-arcade-reset="1" disabled');
    expect(resetArcadeCabinet(CAB, true, 4)).toBe('The players stood up · the cabinet is free.');
  });
});
