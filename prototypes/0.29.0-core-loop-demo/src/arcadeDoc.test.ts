/**
 * 🕹 arcadeDoc — the cabinet's records against a real Y.Doc: the owner's
 * one game (built in, or their own), the P1 seat as a page-bound lease (insert coin, renew,
 * lapse, stand up, the owner's kick), the shape-checked reads that survive
 * a peer's garbage, the parsing, and the attract card's view.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { setConvenienceLanesForTest } from './sovereignty';
import { setOwnMediaOrigins } from './tvConsent';
import {
  arcadePageId, arcadeScreenView, bindArcadeDoc, builtInEntry, builtInGame, cabinetKey, coreForName, coreLabel,
  countBuiltInPlay, countPlay, gameId, gameLane, gameTitle, iAmP1, insertCoin, mayEjectP1, maySit, parseRomUrl, putOnCabinet,
  playsKey, readCabinet, readPlays, readSeat, renewSeat, sanitizeGame, seatKey, seatLapsed, seatStatus,
  setArcadeClock, setArcadeEjectPredicate, setArcadeHostPredicate, setArcadeIdentity, setArcadePageId, setEmulatorData,
  standUp, subscribeArcadeKey, takeOffCabinet, ARCADE_BLINK_MS, ARCADE_COUNTER_MAX, ARCADE_DEFAULT_GAME, ARCADE_SEAT_LAPSE_MS,
} from './arcadeDoc';
import type { ArcadeGame } from './arcadeDoc';
import { ARCADE_GAMES } from './arcadeLibrary';

const CAB = 'arcade-cabinet-1';
const ALICE = 'AAAAalicepub';
const BOB = 'BBBBbobpub';
const PACMAN: ArcadeGame = { name: 'pacman.zip', core: 'arcade', url: 'https://example.org/roms/pacman.zip', size: 0 };
const TETRIS: ArcadeGame = { name: 'tetris.nes', core: 'nes', url: '', size: 40_976 };
const THWAITE: ArcadeGame = { name: 'THWAITE', core: 'nes', url: '', size: 0, bundled: 'thwaite' };

let doc: Y.Doc;
let now = 1_000_000;
/** The edit gate (curation) and the deed (ejecting), registered apart. */
let owner = false;
let deed = false;
const iAm = (pub: string, name = '') => setArcadeIdentity(() => ({ pub, name }));
const tick = (ms: number) => { now += ms; };

beforeEach(() => {
  doc = new Y.Doc();
  now = 1_000_000;
  owner = false;
  deed = false;
  setArcadeClock(() => now);
  setArcadeHostPredicate(() => owner);
  setArcadeEjectPredicate(() => deed);
  setArcadePageId('tab-a');
  iAm(ALICE, 'Alice');
  bindArcadeDoc(doc);
  setConvenienceLanesForTest(true); // the full gate; the serverless-only default has its own case below
});
afterEach(() => { setConvenienceLanesForTest(null); });

describe('reads', () => {
  it('defaults when nothing is written, and survives a peer\'s garbage', () => {
    // A cabinet nobody has set up plays the first built-in game.
    expect(readCabinet(CAB)).toEqual({ game: THWAITE, data: 'station', plays: 0, seq: 0 });
    expect(ARCADE_DEFAULT_GAME).toEqual(THWAITE);
    expect(readSeat(CAB)).toEqual({ holder: '', name: '', page: '', leaseAt: 0, by: '' });
    const map = doc.getMap('arcade');
    map.set(cabinetKey(CAB), 'nonsense');
    expect(readCabinet(CAB).game).toEqual(THWAITE); // not a record: as if unset
    map.set(cabinetKey(CAB), {
      game: { name: 'x.nes', core: 'nes', url: 'javascript:alert(1)' },
      data: 'elsewhere',
      plays: 99, // a tally written into the curation's key is not the tally
      seq: 'x',
    });
    map.set(playsKey(CAB), { plays: -3 });
    const rec = readCabinet(CAB);
    expect(rec.game).toBeNull(); // a javascript: URL never reaches the frame
    expect(rec.data).toBe('station');
    expect(rec.plays).toBe(0);
    expect(rec.seq).toBe(0);
    map.set(playsKey(CAB), 'lots');
    expect(readPlays(CAB)).toBe(0);
    map.set(seatKey(CAB), { holder: 42, name: 'x', page: 'p', leaseAt: 'soon' });
    expect(readSeat(CAB)).toEqual({ holder: '', name: '', page: '', leaseAt: 0, by: '' });
  });

  it('a revision counter a peer wrote past moving reads as the floor, and every write after it still moves', () => {
    owner = true;
    const map = doc.getMap('arcade');
    for (const stuck of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1, 1.5, -1, 'x', null]) {
      map.set(cabinetKey(CAB), { game: null, data: 'station', seq: stuck });
      expect(readCabinet(CAB).seq).toBe(0);
      map.set(playsKey(CAB), { plays: stuck });
      expect(readPlays(CAB)).toBe(0);
    }
    map.set(cabinetKey(CAB), { game: null, data: 'station', seq: Number.MAX_VALUE });
    expect(putOnCabinet(CAB, PACMAN)).toEqual({ ok: true });
    expect(readCabinet(CAB).seq).toBe(1); // the floor, then one up: moved
    map.set(cabinetKey(CAB), { game: null, data: 'station', seq: ARCADE_COUNTER_MAX });
    expect(readCabinet(CAB).seq).toBe(ARCADE_COUNTER_MAX);
    expect(putOnCabinet(CAB, PACMAN)).toEqual({ ok: true });
    expect(readCabinet(CAB).seq).toBe(0); // round past the ceiling: moved, which is all a revision must do
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

  it('a built-in game is its id: rebuilt from the library, and one this build lacks is no game', () => {
    for (const lib of ARCADE_GAMES) {
      expect(builtInGame(lib.id)).toEqual({ name: lib.title, core: 'nes', url: '', size: 0, bundled: lib.id });
      expect(builtInEntry(builtInGame(lib.id))).toBe(lib);
    }
    // Whatever else a peer wrote beside the id is not read.
    expect(sanitizeGame({ name: '<b>x</b>', core: 'psx', url: 'javascript:x', size: 9, bundled: 'thwaite' })).toEqual(THWAITE);
    expect(sanitizeGame({ ...THWAITE, bundled: 'a-newer-game' })).toBeNull();
    expect(sanitizeGame({ ...THWAITE, bundled: 7 })).toBeNull();
    expect(builtInGame('nope')).toBeNull();
    expect(builtInEntry(PACMAN)).toBeNull();
    expect(builtInEntry(null)).toBeNull();
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

  it('gameId: a built-in game is its id, a link is itself; a file on a disk is its name AND its size', () => {
    expect(gameId(THWAITE)).toBe('built-in:thwaite');
    expect(gameId(PACMAN)).toBe('arcade:https://example.org/roms/pacman.zip');
    expect(gameId(TETRIS)).toBe('nes:file:tetris.nes:40976');
    expect(gameId({ ...TETRIS, size: 40_977 })).not.toBe(gameId(TETRIS));
  });

  it('gameTitle: the marquee\'s name — a built-in title, or the file\'s name without its extension', () => {
    expect(gameTitle(THWAITE)).toBe('THWAITE');
    expect(gameTitle(PACMAN)).toBe('PACMAN');
    expect(gameTitle({ ...TETRIS, name: 'Super Game (v1.1).sfc' })).toBe('SUPER GAME (V1.1)');
    expect(gameTitle({ ...TETRIS, name: '.nes' })).toBe('.NES');
  });

  it('gameLane: the player\'s own disk, loopback and this page\'s own origins are sovereign, the web is convenience', () => {
    expect(gameLane(TETRIS)).toBe('SOVEREIGN');
    expect(gameLane(THWAITE)).toBe('SOVEREIGN'); // this app's own files
    expect(gameLane({ ...PACMAN, url: 'http://127.0.0.1:8080/blob/abc' })).toBe('SOVEREIGN');
    expect(gameLane(PACMAN)).toBe('CONVENIENCE');
    expect(gameLane({ ...PACMAN, url: 'https://station.example/roms/pacman.zip' })).toBe('CONVENIENCE');
    setOwnMediaOrigins(['https://station.example']);
    try {
      expect(gameLane({ ...PACMAN, url: 'https://station.example/roms/pacman.zip' })).toBe('SOVEREIGN');
      expect(gameLane(PACMAN)).toBe('CONVENIENCE');
    } finally {
      setOwnMediaOrigins([]);
    }
  });
});

describe('the owner curates', () => {
  it('only the owner changes the one game, or picks where the emulator files come from', () => {
    expect(putOnCabinet(CAB, PACMAN)).toEqual({ ok: false, error: 'Only the room owner changes the cabinet.' });
    expect(putOnCabinet(CAB, builtInGame('nesert-golfing')!).ok).toBe(false);
    expect(setEmulatorData(CAB, 'cdn').ok).toBe(false);
    expect(takeOffCabinet(CAB).ok).toBe(false);
    owner = true;
    expect(putOnCabinet(CAB, builtInGame('nesert-golfing')!)).toEqual({ ok: true });
    expect(readCabinet(CAB).game?.bundled).toBe('nesert-golfing');
    expect(putOnCabinet(CAB, PACMAN)).toEqual({ ok: true }); // in its place: one game
    expect(readCabinet(CAB).game).toEqual(PACMAN);
    expect(setEmulatorData(CAB, 'cdn')).toEqual({ ok: true });
    expect(readCabinet(CAB).data).toBe('cdn');
    expect(putOnCabinet(CAB, { ...PACMAN, url: 'javascript:x' })).toEqual({ ok: false, error: 'That is not a game the cabinet can run.' });
    expect(takeOffCabinet(CAB)).toEqual({ ok: true });
    expect(readCabinet(CAB).game).toBeNull(); // taken off is off: not the default again
    expect(readCabinet(CAB).seq).toBe(4);
  });

  it('serverless only (the build default): the CDN is not offered, and a record that says so reads as the station', () => {
    owner = true;
    expect(setEmulatorData(CAB, 'cdn')).toEqual({ ok: true }); // written with the lanes on
    expect(readCabinet(CAB).data).toBe('cdn');
    setConvenienceLanesForTest(false);
    expect(readCabinet(CAB).data).toBe('station'); // the same record, read by a serverless-only build
    const r = setEmulatorData(CAB, 'cdn');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/serverless/);
    expect(setEmulatorData(CAB, 'station')).toEqual({ ok: true });
    setConvenienceLanesForTest(true);
    expect(readCabinet(CAB).data).toBe('station'); // the owner's write stands
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

  it('standing up frees the seat; a stranger cannot; the DEED holder can kick, and the edit gate alone cannot', () => {
    insertCoin(CAB);
    iAm(BOB, 'Bob');
    expect(standUp(CAB)).toEqual({ ok: false, error: 'Alice is at the controls.' });
    // The shareholder-extended edit gate curates; it unseats nobody — a
    // peer-written venture record can satisfy it.
    owner = true;
    expect(mayEjectP1()).toBe(false);
    expect(standUp(CAB)).toEqual({ ok: false, error: 'Alice is at the controls.' });
    expect(readSeat(CAB).holder).toBe(ALICE);
    deed = true;
    expect(mayEjectP1()).toBe(true);
    expect(standUp(CAB)).toEqual({ ok: true });
    expect(readSeat(CAB)).toEqual({ holder: '', name: '', page: '', leaseAt: now, by: BOB });
    owner = false;
    deed = false;
    expect(standUp(CAB)).toEqual({ ok: true }); // nothing to do
    iAm(ALICE, 'Alice');
    insertCoin(CAB);
    expect(standUp(CAB)).toEqual({ ok: true });
    expect(seatStatus(CAB)).toBe('free');
  });

  it('the deed holder may sit even while someone holds the seat; the edit gate may not', () => {
    insertCoin(CAB);
    iAm(BOB, 'Bob');
    owner = true;
    expect(maySit(CAB)).toBe(false);
    expect(insertCoin(CAB)).toEqual({ ok: false, error: 'Alice is at the controls.' });
    deed = true;
    expect(maySit(CAB)).toBe(true);
    expect(insertCoin(CAB)).toEqual({ ok: true });
    expect(readSeat(CAB).holder).toBe(BOB);
  });
});

describe('the tally', () => {
  it('countPlay counts only under P1, in the tally\'s own key', () => {
    countPlay(CAB);
    expect(readCabinet(CAB).plays).toBe(0);
    insertCoin(CAB);
    const curation = doc.getMap('arcade').get(cabinetKey(CAB));
    countPlay(CAB);
    countPlay(CAB);
    expect(readCabinet(CAB).plays).toBe(2);
    expect(doc.getMap('arcade').get(playsKey(CAB))).toEqual({ plays: 2 });
    expect(doc.getMap('arcade').get(cabinetKey(CAB))).toBe(curation); // the curation's key untouched
  });

  it('countBuiltInPlay counts a built-in game\'s start, by whichever page hosts it', () => {
    countBuiltInPlay(CAB); // the default game is built in
    expect(readPlays(CAB)).toBe(1);
    owner = true;
    putOnCabinet(CAB, PACMAN);
    countBuiltInPlay(CAB); // the owner's own game counts under P1 only
    expect(readPlays(CAB)).toBe(1);
  });

  it('a play counted as the owner changes the game reverts neither the change nor the count', () => {
    // Alice (P1) counts a play on her doc while Bob (the owner) changes the
    // game on his, offline; synced both ways, the cabinet has the game AND
    // the tally has the play — two keys, so the two writes never met.
    const alice = doc;
    insertCoin(CAB);
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    bindArcadeDoc(bob);
    iAm(BOB, 'Bob');
    owner = true;
    expect(putOnCabinet(CAB, PACMAN)).toEqual({ ok: true });
    bindArcadeDoc(alice);
    iAm(ALICE, 'Alice');
    owner = false;
    countPlay(CAB);
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    for (const d of [alice, bob]) {
      bindArcadeDoc(d);
      expect(readCabinet(CAB)).toMatchObject({ game: PACMAN, plays: 1 });
    }
  });
});

describe('the screen view', () => {
  it('the default game → taken off (empty) → the owner\'s own: attract (blinking) → in play, from the records alone', () => {
    now = ARCADE_BLINK_MS * 10; // an even phase
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'attract', title: 'THWAITE', line: 'PRESS START', lane: 'SOVEREIGN', blink: true, plays: 0,
    });
    owner = true;
    takeOffCabinet(CAB);
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'empty', title: 'FURLONG ARCADE', line: 'THE OWNER PICKS A GAME', lane: '', blink: false, plays: 0,
    });
    putOnCabinet(CAB, PACMAN);
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'attract', title: 'PACMAN', line: 'INSERT COIN', lane: 'CONVENIENCE', blink: true, plays: 0,
    });
    now += ARCADE_BLINK_MS;
    expect(arcadeScreenView(CAB).blink).toBe(false);
    insertCoin(CAB);
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'inplay', title: 'PACMAN', line: 'P1 · Alice', lane: 'CONVENIENCE', blink: false, plays: 0,
    });
    now += ARCADE_SEAT_LAPSE_MS;
    expect(arcadeScreenView(CAB).mode).toBe('attract'); // the seat lapsed
  });

  it('a built-in game stays on its attract card under a P1 seat: its picture is the shared game', () => {
    insertCoin(CAB);
    expect(arcadeScreenView(CAB).mode).toBe('attract');
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
