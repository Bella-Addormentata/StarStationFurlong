/**
 * 🕹 arcadeDoc — the cabinet's records against a real Y.Doc: the owner's
 * shelf and game, the P1 seat as a page-bound lease (insert coin, renew,
 * lapse, stand up, the owner's kick), the shape-checked reads that survive
 * a peer's garbage, the parsing, and the attract card's view.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addToShelf, arcadePageId, arcadeScreenView, bindArcadeDoc, cabinetKey, coreForName, coreLabel,
  countPlay, gameId, gameLane, iAmP1, insertCoin, maySit, parseRomUrl, pickFromShelf, putOnCabinet,
  readCabinet, readSeat, removeFromShelf, renewSeat, sanitizeGame, seatKey, seatLapsed, seatStatus,
  setArcadeClock, setArcadeHostPredicate, setArcadeIdentity, setArcadePageId, setEmulatorData,
  standUp, subscribeArcadeKey, takeOffCabinet, ARCADE_BLINK_MS, ARCADE_SEAT_LAPSE_MS, ARCADE_SHELF_MAX,
} from './arcadeDoc';
import type { ArcadeGame } from './arcadeDoc';

const CAB = 'arcade-cabinet-1';
const ALICE = 'AAAAalicepub';
const BOB = 'BBBBbobpub';
const PACMAN: ArcadeGame = { name: 'pacman.zip', core: 'arcade', url: 'https://example.org/roms/pacman.zip', size: 0 };
const TETRIS: ArcadeGame = { name: 'tetris.nes', core: 'nes', url: '', size: 40_976 };

let doc: Y.Doc;
let now = 1_000_000;
let owner = false;
const iAm = (pub: string, name = '') => setArcadeIdentity(() => ({ pub, name }));
const tick = (ms: number) => { now += ms; };

beforeEach(() => {
  doc = new Y.Doc();
  now = 1_000_000;
  owner = false;
  setArcadeClock(() => now);
  setArcadeHostPredicate(() => owner);
  setArcadePageId('tab-a');
  iAm(ALICE, 'Alice');
  bindArcadeDoc(doc);
});

describe('reads', () => {
  it('defaults when nothing is written, and survives a peer\'s garbage', () => {
    expect(readCabinet(CAB)).toEqual({ game: null, shelf: [], data: 'station', plays: 0, seq: 0 });
    expect(readSeat(CAB)).toEqual({ holder: '', name: '', page: '', leaseAt: 0, by: '' });
    const map = doc.getMap('arcade');
    map.set(cabinetKey(CAB), 'nonsense');
    expect(readCabinet(CAB).game).toBeNull();
    map.set(cabinetKey(CAB), {
      game: { name: 'x.nes', core: 'nes', url: 'javascript:alert(1)' },
      shelf: [PACMAN, { name: '', core: 'nes', url: '' }, { name: 'y.gb', core: 'commodore', url: '' }, ...Array<ArcadeGame>(20).fill(TETRIS)],
      data: 'elsewhere',
      plays: -3,
      seq: 'x',
    });
    const rec = readCabinet(CAB);
    expect(rec.game).toBeNull(); // a javascript: URL never reaches the frame
    expect(rec.shelf.map((g) => g.name)).toEqual(['pacman.zip', ...Array<string>(ARCADE_SHELF_MAX - 1).fill('tetris.nes')]);
    expect(rec.data).toBe('station');
    expect(rec.plays).toBe(0);
    expect(rec.seq).toBe(0);
    map.set(seatKey(CAB), { holder: 42, name: 'x', page: 'p', leaseAt: 'soon' });
    expect(readSeat(CAB)).toEqual({ holder: '', name: '', page: '', leaseAt: 0, by: '' });
  });

  it('sanitizeGame keeps http(s) and own-disk games and drops the rest', () => {
    expect(sanitizeGame(PACMAN)).toEqual(PACMAN);
    expect(sanitizeGame(TETRIS)).toEqual(TETRIS);
    expect(sanitizeGame({ ...PACMAN, url: 'ftp://x/y.zip' })).toBeNull();
    // user:password@host would be read by every peer, not just the file's host.
    expect(sanitizeGame({ ...PACMAN, url: 'https://user:secret@example.org/pacman.zip' })).toBeNull();
    expect(parseRomUrl('https://user:secret@example.org/x.nes')).toBeNull();
    expect(sanitizeGame({ ...PACMAN, core: 'ps5' })).toBeNull();
    expect(sanitizeGame({ ...PACMAN, name: '   ' })).toBeNull();
    expect(sanitizeGame({ ...PACMAN, size: -5 })?.size).toBe(0);
    expect(sanitizeGame(null)).toBeNull();
  });
});

describe('games', () => {
  it('coreForName follows the extension; a .zip is an arcade romset', () => {
    expect(coreForName('Super Game.sfc')).toBe('snes');
    expect(coreForName('x.NES')).toBe('nes');
    expect(coreForName('pacman.zip')).toBe('arcade');
    expect(coreForName('film.mp3')).toBeNull();
    expect(coreForName('noext')).toBeNull();
    expect(coreLabel('segaMD')).toBe('MEGA DRIVE');
  });

  it('parseRomUrl takes an http(s) link, names it by the file, and refuses the rest', () => {
    expect(parseRomUrl('https://example.org/roms/Space%20Game.gba?x=1')).toEqual({
      name: 'Space Game.gba', url: 'https://example.org/roms/Space%20Game.gba?x=1', core: 'gba',
    });
    expect(parseRomUrl('example.org/a/b.unknown')).toEqual({ name: 'b.unknown', url: 'https://example.org/a/b.unknown', core: null });
    expect(parseRomUrl('ftp://example.org/x.nes')).toBeNull();
    expect(parseRomUrl('   ')).toBeNull();
    expect(parseRomUrl('https://example.org/')?.name).toBe('example.org');
  });

  it('gameId: a link is itself; a file on a disk is its name AND its size', () => {
    expect(gameId(PACMAN)).toBe('arcade:https://example.org/roms/pacman.zip');
    expect(gameId(TETRIS)).toBe('nes:file:tetris.nes:40976');
    expect(gameId({ ...TETRIS, size: 40_977 })).not.toBe(gameId(TETRIS));
  });

  it('gameLane: the player\'s own disk and loopback are sovereign, the web is convenience', () => {
    expect(gameLane(TETRIS)).toBe('SOVEREIGN');
    expect(gameLane({ ...PACMAN, url: 'http://127.0.0.1:8080/blob/abc' })).toBe('SOVEREIGN');
    expect(gameLane(PACMAN)).toBe('CONVENIENCE');
  });
});

describe('the owner curates', () => {
  it('only the owner puts a game on, adds to the shelf, or picks where the emulator files come from', () => {
    expect(putOnCabinet(CAB, PACMAN)).toEqual({ ok: false, error: 'Only the room owner changes the cabinet.' });
    expect(addToShelf(CAB, PACMAN).ok).toBe(false);
    expect(setEmulatorData(CAB, 'cdn').ok).toBe(false);
    expect(takeOffCabinet(CAB).ok).toBe(false);
    owner = true;
    expect(putOnCabinet(CAB, PACMAN)).toEqual({ ok: true });
    expect(readCabinet(CAB).game).toEqual(PACMAN);
    expect(setEmulatorData(CAB, 'cdn')).toEqual({ ok: true });
    expect(readCabinet(CAB).data).toBe('cdn');
    expect(putOnCabinet(CAB, { ...PACMAN, url: 'javascript:x' })).toEqual({ ok: false, error: 'That is not a game the cabinet can run.' });
    expect(takeOffCabinet(CAB)).toEqual({ ok: true });
    expect(readCabinet(CAB).game).toBeNull();
    expect(readCabinet(CAB).seq).toBe(3);
  });

  it('the shelf dedupes, keeps the newest on top, and holds ARCADE_SHELF_MAX', () => {
    owner = true;
    expect(addToShelf(CAB, PACMAN)).toEqual({ ok: true });
    expect(addToShelf(CAB, TETRIS)).toEqual({ ok: true });
    expect(addToShelf(CAB, PACMAN)).toEqual({ ok: true }); // moved up, not doubled
    expect(readCabinet(CAB).shelf.map((g) => g.name)).toEqual(['pacman.zip', 'tetris.nes']);
    for (let i = 0; i < ARCADE_SHELF_MAX; i++) addToShelf(CAB, { ...TETRIS, name: `game-${i}.nes` });
    expect(readCabinet(CAB).shelf).toHaveLength(ARCADE_SHELF_MAX);
    expect(addToShelf(CAB, { ...TETRIS, name: 'one-more.nes' })).toEqual({ ok: false, error: `The shelf holds ${ARCADE_SHELF_MAX} games.` });
    expect(removeFromShelf(CAB, 0)).toEqual({ ok: true });
    expect(readCabinet(CAB).shelf).toHaveLength(ARCADE_SHELF_MAX - 1);
    expect(removeFromShelf(CAB, 99)).toEqual({ ok: false, error: 'Nothing on that shelf.' });
  });
});

describe('player one', () => {
  it('insert coin takes the seat from this page; the same identity in another tab is a spectator', () => {
    expect(seatStatus(CAB)).toBe('free');
    expect(insertCoin(CAB)).toEqual({ ok: true });
    expect(readSeat(CAB)).toEqual({ holder: ALICE, name: 'Alice', page: 'tab-a', leaseAt: now, by: ALICE });
    expect(iAmP1(CAB)).toBe(true);
    setArcadePageId('tab-b');
    expect(seatStatus(CAB)).toBe('held');
    expect(iAmP1(CAB)).toBe(false);
    expect(insertCoin(CAB)).toEqual({ ok: false, error: 'Alice is at the controls.' });
    setArcadePageId('tab-a');
    expect(insertCoin(CAB)).toEqual({ ok: true }); // sitting down again is fine
  });

  it('needs an identity', () => {
    iAm('');
    expect(insertCoin(CAB)).toEqual({ ok: false, error: 'No identity on this device yet.' });
  });

  it('lapses by the renewals this page saw, and a renewal restarts the clock', () => {
    insertCoin(CAB);
    iAm(BOB, 'Bob');
    tick(ARCADE_SEAT_LAPSE_MS - 1);
    expect(seatLapsed(CAB)).toBe(false);
    expect(seatStatus(CAB)).toBe('held');
    expect(maySit(CAB)).toBe(false);
    tick(1);
    expect(seatLapsed(CAB)).toBe(true);
    expect(seatStatus(CAB)).toBe('free');
    expect(insertCoin(CAB)).toEqual({ ok: true });
    expect(readSeat(CAB).holder).toBe(BOB);
    // Bob renews at 5 s: the lapse is judged from that arrival.
    tick(5_000);
    renewSeat(CAB);
    tick(ARCADE_SEAT_LAPSE_MS - 1);
    iAm(ALICE, 'Alice');
    expect(seatStatus(CAB)).toBe('held');
    tick(1);
    expect(seatStatus(CAB)).toBe('free');
  });

  it('a renewal from the wrong page or identity changes nothing', () => {
    insertCoin(CAB);
    const before = readSeat(CAB);
    tick(1000);
    setArcadePageId('tab-b');
    renewSeat(CAB);
    expect(readSeat(CAB)).toEqual(before);
    setArcadePageId('tab-a');
    iAm(BOB, 'Bob');
    renewSeat(CAB);
    expect(readSeat(CAB)).toEqual(before);
  });

  it('standing up frees the seat; a stranger cannot; the owner can kick', () => {
    insertCoin(CAB);
    iAm(BOB, 'Bob');
    expect(standUp(CAB)).toEqual({ ok: false, error: 'Alice is at the controls.' });
    owner = true;
    expect(standUp(CAB)).toEqual({ ok: true });
    expect(readSeat(CAB)).toEqual({ holder: '', name: '', page: '', leaseAt: now, by: BOB });
    owner = false;
    expect(standUp(CAB)).toEqual({ ok: true }); // nothing to do
    iAm(ALICE, 'Alice');
    insertCoin(CAB);
    expect(standUp(CAB)).toEqual({ ok: true });
    expect(seatStatus(CAB)).toBe('free');
  });

  it('the owner may sit even while someone holds the seat', () => {
    insertCoin(CAB);
    iAm(BOB, 'Bob');
    owner = true;
    expect(maySit(CAB)).toBe(true);
    expect(insertCoin(CAB)).toEqual({ ok: true });
    expect(readSeat(CAB).holder).toBe(BOB);
  });
});

describe('the menu and the tally', () => {
  it('P1 (or the owner) puts a shelf game on the cabinet; nobody else', () => {
    owner = true;
    addToShelf(CAB, PACMAN);
    addToShelf(CAB, TETRIS); // shelf: [TETRIS, PACMAN]
    owner = false;
    expect(pickFromShelf(CAB, 1)).toEqual({ ok: false, error: 'Insert a coin first.' });
    insertCoin(CAB);
    expect(pickFromShelf(CAB, 1)).toEqual({ ok: true });
    expect(readCabinet(CAB).game).toEqual(PACMAN);
    expect(pickFromShelf(CAB, 5)).toEqual({ ok: false, error: 'Nothing on that shelf.' });
    standUp(CAB);
    owner = true;
    expect(pickFromShelf(CAB, 0)).toEqual({ ok: true });
    expect(readCabinet(CAB).game).toEqual(TETRIS);
  });

  it('countPlay counts only under P1', () => {
    countPlay(CAB);
    expect(readCabinet(CAB).plays).toBe(0);
    insertCoin(CAB);
    countPlay(CAB);
    countPlay(CAB);
    expect(readCabinet(CAB).plays).toBe(2);
  });
});

describe('the screen view', () => {
  it('empty → attract (blinking) → in play, from the records alone', () => {
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'empty', title: 'FURLONG ARCADE', line: 'THE OWNER LOADS A GAME', lane: '', blink: false, plays: 0,
    });
    owner = true;
    addToShelf(CAB, TETRIS);
    expect(arcadeScreenView(CAB).title).toBe('1 GAME ON THE SHELF');
    addToShelf(CAB, PACMAN);
    expect(arcadeScreenView(CAB).title).toBe('2 GAMES ON THE SHELF');
    putOnCabinet(CAB, PACMAN);
    now = ARCADE_BLINK_MS * 10; // an even phase
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'attract', title: 'PACMAN.ZIP', line: 'INSERT COIN', lane: 'CONVENIENCE', blink: true, plays: 0,
    });
    now += ARCADE_BLINK_MS;
    expect(arcadeScreenView(CAB).blink).toBe(false);
    insertCoin(CAB);
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'inplay', title: 'PACMAN.ZIP', line: 'P1 · Alice', lane: 'CONVENIENCE', blink: false, plays: 0,
    });
    now += ARCADE_SEAT_LAPSE_MS;
    expect(arcadeScreenView(CAB).mode).toBe('attract'); // the seat lapsed
  });
});

describe('subscriptions', () => {
  it('fire per key', () => {
    let cab = 0;
    let seat = 0;
    const offA = subscribeArcadeKey(cabinetKey(CAB), () => { cab++; });
    const offB = subscribeArcadeKey(seatKey(CAB), () => { seat++; });
    owner = true;
    putOnCabinet(CAB, PACMAN);
    expect([cab, seat]).toEqual([1, 0]);
    insertCoin(CAB);
    expect([cab, seat]).toEqual([1, 1]);
    offA();
    offB();
    standUp(CAB);
    expect([cab, seat]).toEqual([1, 1]);
    expect(arcadePageId()).toBe('tab-a');
  });
});
