/**
 * 🕹 arcadeUI's two views (#193): PLAY at the cabinet, and SETTINGS from the
 * ⚙️ on its front — what the owner set, readable by anyone, with the
 * owner's controls only for the owner (arcadeDoc gates the writes again).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setConvenienceLanesForTest } from './sovereignty';
import {
  addToShelf, bindArcadeDoc, putOnCabinet, setArcadeClock, setArcadeEjectPredicate, setArcadeHostPredicate,
  setArcadeIdentity, setArcadePageId, setEmulatorData,
} from './arcadeDoc';
import type { ArcadeGame } from './arcadeDoc';
import { renderArcadePanel, type ArcadeDeviceDeps } from './arcadeUI';

const CAB = 'arcade-cabinet-1';
const LJ65: ArcadeGame = { name: 'lj65.nes', core: 'nes', url: '', size: 40_976 };
const THWAITE: ArcadeGame = { name: 'thwaite.nes', core: 'nes', url: '', size: 40_976 };

let owner = false;
const deps = (view: ArcadeDeviceDeps['view'], canEdit: boolean): ArcadeDeviceDeps => ({
  itemId: CAB, myPub: () => 'AAAAalicepub', myName: () => 'Alice', canEdit: () => canEdit, openStage: () => undefined, view,
});

beforeEach(() => {
  owner = true;
  setArcadeClock(() => 1_000_000);
  setArcadeHostPredicate(() => owner);
  setArcadeEjectPredicate(() => false);
  setArcadePageId('tab-a');
  setArcadeIdentity(() => ({ pub: 'AAAAalicepub', name: 'Alice' }));
  bindArcadeDoc(new Y.Doc());
  setConvenienceLanesForTest(true);
  // The owner sets the cabinet up; then the visitor looks.
  expect(putOnCabinet(CAB, LJ65).ok).toBe(true);
  expect(addToShelf(CAB, THWAITE).ok).toBe(true);
  expect(setEmulatorData(CAB, 'cdn').ok).toBe(true);
  owner = false;
});
afterEach(() => { setConvenienceLanesForTest(null); });

describe('the SETTINGS view (the ⚙️)', () => {
  it('shows a visitor everything the owner set, with nothing to change it', () => {
    const html = renderArcadePanel(CAB, deps('settings', false));
    expect(html).toContain('⚙️ ARCADE CABINET');
    expect(html).toContain('THE OWNER SETS THIS CABINET · ANYONE CAN LOOK');
    expect(html).toContain('lj65.nes'); // on the cabinet
    expect(html).toContain('thwaite.nes'); // on the shelf
    expect(html).toContain('EMULATOR FILES');
    expect(html).toContain('cdn.emulatorjs.org'); // where the files come from, as text
    for (const control of ['data-arcade-put', 'data-arcade-shelve', 'data-arcade-takeoff', 'data-arcade-unshelve', 'data-arcade-pick', 'data-arcade-data', 'data-arcade-file', 'data-arcade-url']) {
      expect(html).not.toContain(control);
    }
    expect(html).toContain('data-arcade-play'); // back to the cabinet
  });

  it('gives the owner the controls, in the same card', () => {
    const html = renderArcadePanel(CAB, deps('settings', true));
    expect(html).toContain('YOU RUN THIS CABINET');
    for (const control of ['data-arcade-put', 'data-arcade-shelve', 'data-arcade-takeoff', 'data-arcade-unshelve', 'data-arcade-pick', 'data-arcade-data="station"', 'data-arcade-data="cdn"', 'data-arcade-file', 'data-arcade-url']) {
      expect(html).toContain(control);
    }
  });

  it('escapes a peer\'s game name', () => {
    owner = true;
    expect(putOnCabinet(CAB, { ...LJ65, name: '<img src=x onerror=alert(1)>.nes' }).ok).toBe(true);
    owner = false;
    const html = renderArcadePanel(CAB, deps('settings', false));
    expect(html).not.toContain('<img');
  });
});

describe('the PLAY view (at the cabinet)', () => {
  it('keeps the coin and the shelf, and moves the owner\'s settings behind ⚙️', () => {
    for (const canEdit of [false, true]) {
      const html = renderArcadePanel(CAB, deps(undefined, canEdit));
      expect(html).toContain('🕹 ARCADE CABINET');
      expect(html).toContain('data-arcade-coin');
      expect(html).toContain('data-arcade-settings');
      expect(html).not.toContain('LOAD A GAME');
      expect(html).not.toContain('data-arcade-data');
      expect(html).not.toContain('data-arcade-unshelve');
    }
  });
});
