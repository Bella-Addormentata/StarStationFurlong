/**
 * 🕹 arcadeUI's two views (#193): PLAY at the cabinet, and SETTINGS from the
 * ⚙️ on its front — the cabinet's one game, readable by anyone, with the
 * owner's controls only for the owner (arcadeDoc gates the writes again).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setConvenienceLanesForTest } from './sovereignty';
import {
  bindArcadeDoc, putOnCabinet, takeOffCabinet, setArcadeClock, setArcadeEjectPredicate, setArcadeHostPredicate,
  setArcadeIdentity, setArcadePageId, setEmulatorData,
} from './arcadeDoc';
import type { ArcadeGame } from './arcadeDoc';
import { ARCADE_GAMES } from './arcadeLibrary';
import { renderArcadePanel, type ArcadeDeviceDeps } from './arcadeUI';

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
