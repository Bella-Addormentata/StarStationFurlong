/**
 * 📺 tvMenu — the set's own on-screen menu (#258, part 3) against a real
 * Y.Doc: the cells it shows stopped and paused, where each arrow takes the
 * highlight, the highlight as the room's record (one screen for everyone,
 * moved by anyone), and the presses that open a menu anew.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindTvDoc, menuKey, readMenuAt, setTvClock, setTvIdentity, setTvPageId, setTvPressesOpen, sourceId, tvPause, tvPlay,
  tvResume, tvSeek, tvSetLoop, tvSetMenuAt, tvStop, tvTogglePower,
} from './tvDoc';
import type { TvSource } from './tvDoc';
import { tvHomeShelf, tvMenu, tvMenuCellAt, tvMenuMove, tvMenuStep, TV_HOME_RECENT, TV_MENU_LIBRARY } from './tvMenu';
import type { TvMenuView } from './tvMenu';
import { setConvenienceLanesForTest } from './sovereignty';

const TV = 'smart-tv-1';
const film = (i: number, title = `Film ${i}`): TvSource => ({ kind: 'url', url: `https://example.org/${i}.mp4`, title });

let doc: Y.Doc;
let now = 1_000_000;
const tick = (ms: number) => { now += ms; };
/** The room's library, oldest first: each played, then the set back home. */
const watch = (n: number) => {
  for (let i = 0; i < n; i++) {
    tick(1);
    tvPlay(TV, film(i));
  }
  tvStop(TV);
};
const menu = (): TvMenuView => tvMenu(TV)!;
const ids = (m: TvMenuView) => m.cells.map((c) => c.id);

beforeEach(() => {
  doc = new Y.Doc();
  now = 1_000_000;
  setTvClock(() => now);
  setTvPageId('A');
  bindTvDoc(doc);
  setTvIdentity(() => ({ pub: 'AAAAalicepub', name: 'Alice' }));
  setTvPressesOpen(true);
  setConvenienceLanesForTest(false); // the build default: serverless only
});
afterEach(() => { setConvenienceLanesForTest(null); });

describe('what the set\'s menu shows', () => {
  it('no menu while the set is off or a programme plays or counts down', () => {
    expect(tvMenu(TV)).toBeNull(); // off, as delivered
    tvPlay(TV, film(1));
    expect(tvMenu(TV)).toBeNull();
    tvTogglePower(TV);
    expect(tvMenu(TV)).toBeNull();
  });

  it('home with no library: the tiles this build offers, three to a row, the first lit', () => {
    tvTogglePower(TV);
    expect(menu().kind).toBe('home');
    expect(menu().cells.map((c) => [c.id, c.col, c.row, c.live])).toEqual([
      ['tile:url', 0, 0, true], ['tile:file', 1, 0, true], ['tile:magnet', 2, 0, true], ['tile:karaoke', 0, 1, false],
    ]);
    expect(menu().at).toBe('tile:url');
    setConvenienceLanesForTest(true);
    expect(ids(menu()).slice(0, 2)).toEqual(['tile:youtube', 'tile:archive']);
    expect(menu().at).toBe('tile:youtube');
  });

  it('home with a library: the tiles two to a row, the newest titles in the third column, the newest lit', () => {
    watch(3);
    const m = menu();
    expect(m.cells.filter((c) => c.id.startsWith('tile:')).map((c) => [c.col, c.row])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
    expect(m.cells.filter((c) => c.id.startsWith('lib:')).map((c) => [c.label, c.col, c.row])).toEqual([
      ['Film 2', 2, 0], ['Film 1', 2, 1], ['Film 0', 2, 2],
    ]);
    expect(m.at).toBe(`lib:${sourceId(film(2))}`);
  });

  it('holds at most TV_MENU_LIBRARY titles, and shows them TV_HOME_RECENT a page', () => {
    watch(TV_MENU_LIBRARY + 3);
    const lib = menu().cells.filter((c) => c.id.startsWith('lib:'));
    expect(lib).toHaveLength(TV_MENU_LIBRARY);
    expect(TV_HOME_RECENT).toBe(4);
    expect(tvHomeShelf(menu())).toMatchObject({ above: false, below: true });
    expect(tvHomeShelf(menu()).cells.map((c) => c.label)).toEqual(lib.slice(0, 4).map((c) => c.label));
    // The highlight past the page's foot turns the page.
    tvSetMenuAt(TV, lib[5]!.id);
    expect(tvHomeShelf(menu()).cells.map((c) => c.id)).toEqual(lib.slice(4, 8).map((c) => c.id));
    expect(tvHomeShelf(menu())).toMatchObject({ above: true, below: true });
    tvSetMenuAt(TV, lib[TV_MENU_LIBRARY - 1]!.id);
    expect(tvHomeShelf(menu())).toMatchObject({ above: true, below: false });
    // On a tile, the first page.
    tvSetMenuAt(TV, 'tile:file');
    expect(tvHomeShelf(menu()).cells[0]!.id).toBe(lib[0]!.id);
  });

  it('paused: PLAY lit, STOP, 10 s back and on, FROM START, and LOOP as the set has it', () => {
    tvPlay(TV, film(1));
    tvPause(TV, 30_000);
    expect(menu()).toMatchObject({ kind: 'paused', at: 'play' });
    expect(menu().cells.map((c) => [c.id, c.label])).toEqual([
      ['play', '▶ PLAY'], ['stop', '■ STOP'], ['back', '« 10 S'], ['on', '10 S »'], ['start', 'FROM START'], ['loop', 'LOOP: OFF'],
    ]);
    tvSetLoop(TV, true);
    expect(tvMenuCellAt({ ...menu(), at: 'loop' }).label).toBe('LOOP: ON');
  });
});

describe('the D-pad on the menu', () => {
  it('▲ ▼ go along a column, ◀ ▶ to the nearest column with a live cell at the nearest row, and nowhere past an edge', () => {
    watch(6);
    const lib = menu().cells.filter((c) => c.id.startsWith('lib:')).map((c) => c.id);
    const from = (at: string) => ({ ...menu(), at });
    // The tiles, serverless: URL FILE / TORRENT (KARAOKE), then the titles.
    expect(tvMenuStep(from(lib[0]!), 'up')).toBeNull();
    expect(tvMenuStep(from(lib[0]!), 'down')).toBe(lib[1]);
    expect(tvMenuStep(from(lib[5]!), 'down')).toBeNull();
    expect(tvMenuStep(from(lib[0]!), 'right')).toBeNull();
    expect(tvMenuStep(from(lib[0]!), 'left')).toBe('tile:file');
    // KARAOKE, a lane still to come, is never lit: FILE is the nearest live cell that way.
    expect(tvMenuStep(from(lib[5]!), 'left')).toBe('tile:file');
    expect(tvMenuStep(from('tile:file'), 'down')).toBeNull();
    expect(tvMenuStep(from('tile:file'), 'right')).toBe(lib[0]);
    expect(tvMenuStep(from('tile:url'), 'down')).toBe('tile:magnet');
    expect(tvMenuStep(from('tile:magnet'), 'right')).toBe('tile:file');
    expect(tvMenuStep(from('tile:magnet'), 'up')).toBe('tile:url');
    expect(tvMenuStep(from('tile:url'), 'left')).toBeNull();
  });

  it('paused, the six cells are a grid of two columns', () => {
    tvPlay(TV, film(1));
    tvPause(TV, 30_000);
    const from = (at: string) => ({ ...menu(), at });
    expect(tvMenuStep(from('play'), 'right')).toBe('stop');
    expect(tvMenuStep(from('play'), 'down')).toBe('back');
    expect(tvMenuStep(from('back'), 'right')).toBe('on');
    expect(tvMenuStep(from('on'), 'down')).toBe('loop');
    expect(tvMenuStep(from('loop'), 'left')).toBe('start');
    expect(tvMenuStep(from('start'), 'down')).toBeNull();
    expect(tvMenuStep(from('stop'), 'up')).toBeNull();
  });

  it('a move is the room\'s: written once, seen by every page, and a move to nowhere writes nothing', () => {
    tvPlay(TV, film(1));
    tvPause(TV, 30_000);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    doc.on('update', (u: Uint8Array) => Y.applyUpdate(peer, u));
    let writes = 0;
    doc.on('update', () => { writes++; });
    expect(tvMenuMove(TV, 'down')).toBe(true);
    expect(tvMenuMove(TV, 'right')).toBe(true);
    expect(writes).toBe(2);
    expect(tvMenuMove(TV, 'right')).toBe(false); // the edge
    expect(writes).toBe(2);
    expect(peer.getMap('tv').get(menuKey(TV))).toEqual({ at: 'on' });
    // The other page draws the same highlight.
    bindTvDoc(peer);
    expect(menu().at).toBe('on');
  });

  it('moves no clock: the page that pressed last keeps it', () => {
    tvPlay(TV, film(1));
    tvPause(TV, 30_000);
    setTvIdentity(() => ({ pub: 'BBBBbobpub', name: 'Bob' }));
    setTvPageId('B');
    expect(tvMenuMove(TV, 'down')).toBe(true);
    expect(doc.getMap('tv').get('remote:smart-tv-1')).toMatchObject({ holder: 'AAAAalicepub', page: 'A' });
  });

  it('nothing to move while no menu is up, or while this page leaves the room', () => {
    expect(tvSetMenuAt(TV, 'tile:url')).toEqual({ ok: false, error: 'The set shows no menu now.' }); // off
    tvPlay(TV, film(1));
    expect(tvMenuMove(TV, 'down')).toBe(false);
    expect(tvSetMenuAt(TV, 'stop')).toEqual({ ok: false, error: 'The set shows no menu now.' });
    tvPause(TV, 1_000);
    setTvPressesOpen(false);
    expect(tvSetMenuAt(TV, 'stop')).toEqual({ ok: false, error: 'Leaving this room.' });
    expect(readMenuAt(TV)).toBe('');
  });
});

describe('the highlight as the room keeps it', () => {
  it('a PAUSE, a STOP and the switch open the menu anew, on its first cell', () => {
    tvPlay(TV, film(1));
    tvPause(TV, 30_000);
    tvSetMenuAt(TV, 'stop');
    tvResume(TV);
    tvPause(TV, 31_000);
    expect(menu().at).toBe('play'); // not STOP: a menu left on it last time
    tvSetMenuAt(TV, 'loop');
    tvStop(TV);
    expect(readMenuAt(TV)).toBe('');
    tvSetMenuAt(TV, 'tile:magnet');
    tvTogglePower(TV);
    tvTogglePower(TV);
    expect(menu().at).toBe(`lib:${sourceId(film(1))}`);
  });

  it('LOOP and a seek, picked on the menu, leave the highlight where it is', () => {
    tvPlay(TV, film(1));
    tvPause(TV, 30_000);
    tvSetMenuAt(TV, 'loop');
    tvSetLoop(TV, true);
    expect(menu().at).toBe('loop');
    tvSetMenuAt(TV, 'on');
    tvSeek(TV, 40_000);
    expect(menu().at).toBe('on');
  });

  it('a highlight on a cell this page does not show, or a peer\'s garbage, lights the first', () => {
    watch(2);
    tvSetMenuAt(TV, 'tile:youtube'); // a build with the convenience lanes on wrote it
    expect(menu().at).toBe(`lib:${sourceId(film(1))}`);
    setConvenienceLanesForTest(true);
    expect(menu().at).toBe('tile:youtube');
    doc.getMap('tv').set(menuKey(TV), { at: 42 });
    expect(menu().at).toBe(`lib:${sourceId(film(1))}`);
    doc.getMap('tv').set(menuKey(TV), 'stop');
    expect(readMenuAt(TV)).toBe('');
    tvSetMenuAt(TV, 'tile:karaoke'); // a cell drawn dimmed is never lit
    expect(menu().at).toBe(`lib:${sourceId(film(1))}`);
  });
});
