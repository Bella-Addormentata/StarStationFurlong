/**
 * 🕹 arcadeDoc — the cabinet's records against a real Y.Doc: the owner's
 * one game (built in, or their own), the seats as page-bound leases (insert coin, renew,
 * lapse, stand up, the owner's kick; P1, and the double-wide cabinet's four), the shape-checked reads that survive
 * a peer's garbage, the parsing, and the attract card's view.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { setConvenienceLanesForTest } from './sovereignty';
import { setOwnMediaOrigins } from './tvConsent';
import {
  arcadePageId, arcadeScreenView, bindArcadeDoc, builtInEntry, builtInGame, cabinetKey, coreForName, coreLabel,
  countBuiltInPlay, countPlay, gameId, gameLane, gameTitle, iAmP1, insertCoin, mayEjectP1, maySit, parseRomUrl, putOnCabinet,
  playsKey, readCabinet, readPlays, readSeat, renewSeat, sanitizeGame, seatKey, seatLapsed, seatStatus,
  setArcadeClock, setArcadeEjectPredicate, setArcadeHostPredicate, setArcadeIdentity, setArcadePageId, setEmulatorData,
  standUp, subscribeArcadeKey, takeOffCabinet, ARCADE_BLINK_MS, ARCADE_COUNTER_MAX, ARCADE_DEFAULT_GAME, ARCADE_SEAT_LAPSE_MS,
  isSeatIndex, mySeat, seatHolders, ARCADE_SEATS_MAX, ARCADE_CORES, ejsCore,
  clearHighScores, clearKey, mergeHighScores, readHighScores, recordHighScores, scoreLineKey, scoresKey, subscribeHighScores,
  ARCADE_SCORE_TOP, ARCADE_SCORES_MAX,
} from './arcadeDoc';
import type { ArcadeGame, HighScore } from './arcadeDoc';
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

  it('a file keeps its SHA-256 (the room sends it by that); a link or a malformed hash does not', () => {
    const sha = 'ab'.repeat(32);
    expect(sanitizeGame({ ...TETRIS, sha256: sha })).toEqual({ ...TETRIS, sha256: sha });
    expect(sanitizeGame({ ...TETRIS, sha256: sha.toUpperCase() })).toEqual(TETRIS);
    expect(sanitizeGame({ ...TETRIS, sha256: `${sha}0` })).toEqual(TETRIS);
    expect(sanitizeGame({ ...PACMAN, sha256: sha })).toEqual(PACMAN);
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

  it('tells EmulatorJS a name that runs the core the fetch script fetches, as the right system', () => {
    // EmulatorJS 4.2.1's table (emulator.js getCores), in its order, and its
    // reading of EJS_core (getCore): a system's name runs the system's first
    // core; a core's name runs that core, as the first system listing it.
    const table: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['atari5200', ['a5200']], ['vb', ['beetle_vb']], ['nds', ['melonds', 'desmume', 'desmume2015']],
      ['arcade', ['fbneo', 'fbalpha2012_cps1', 'fbalpha2012_cps2']], ['nes', ['fceumm', 'nestopia']],
      ['gb', ['gambatte']], ['coleco', ['gearcoleco']], ['segaMS', ['smsplus', 'genesis_plus_gx', 'picodrive']],
      ['segaMD', ['genesis_plus_gx', 'picodrive']], ['segaGG', ['genesis_plus_gx']],
      ['segaCD', ['genesis_plus_gx', 'picodrive']], ['sega32x', ['picodrive']],
      ['sega', ['genesis_plus_gx', 'picodrive']], ['lynx', ['handy']], ['mame', ['mame2003_plus', 'mame2003']],
      ['ngp', ['mednafen_ngp']], ['pce', ['mednafen_pce']], ['pcfx', ['mednafen_pcfx']],
      ['psx', ['pcsx_rearmed', 'mednafen_psx_hw']], ['ws', ['mednafen_wswan']], ['gba', ['mgba']],
      ['n64', ['mupen64plus_next', 'parallel_n64']], ['3do', ['opera']], ['psp', ['ppsspp']],
      ['atari7800', ['prosystem']], ['snes', ['snes9x']], ['atari2600', ['stella2014']],
      ['jaguar', ['virtualjaguar']], ['segaSaturn', ['yabause']], ['amiga', ['puae']], ['c64', ['vice_x64sc']],
      ['c128', ['vice_x128']], ['pet', ['vice_xpet']], ['plus4', ['vice_xplus4']], ['vic20', ['vice_xvic']],
    ];
    const runs = (ejs: string) => ({
      system: table.find(([, cores]) => cores.includes(ejs))?.[0] ?? ejs,
      core: table.find(([name]) => name === ejs)?.[1][0] ?? ejs,
    });
    // The system each plays as (its controls, and how it takes a zip).
    const plays: Record<string, string> = {
      nes: 'nes', snes: 'snes', gb: 'gb', gbc: 'gb', gba: 'gba', segaMD: 'segaMD', segaMS: 'segaMS', n64: 'n64',
      arcade: 'arcade', mame2003: 'mame', psx: 'psx', atari2600: 'atari2600', pce: 'pce',
    };
    for (const c of ARCADE_CORES) {
      expect(ejsCore(c.core)).toBe(c.ejs);
      expect(runs(c.ejs), c.core).toEqual({ system: plays[c.core], core: c.libretro });
    }
    // What EmulatorJS would have done with the cabinet's own names.
    expect(runs('gbc').core).toBe('gbc'); // no such core
    expect(runs('segaMS').core).toBe('smsplus'); // not fetched
    expect(runs('mame2003').core).toBe('mame2003'); // not fetched
    // scripts/fetch-emulatorjs.mjs fetches exactly these, each pinned.
    const script = readFileSync(fileURLToPath(new URL('../scripts/fetch-emulatorjs.mjs', import.meta.url)), 'utf8');
    const list = script.match(/const DEFAULT_CORES = \[([^\]]*)\]/)?.[1] ?? '';
    const fetched = [...list.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect([...fetched].sort()).toEqual([...new Set(ARCADE_CORES.map((c) => c.libretro))].sort());
    const version = script.match(/process\.env\.EJS_VERSION \?\? '([0-9.]+)'/)?.[1];
    expect(version).toBeTruthy();
    for (const core of fetched) expect(script, core).toContain(`'@emulatorjs/core-${core}@${version}': 'sha512-`);
  });

  it('pins the commit every fetched core, the engine, RetroArch, the build scripts and the RAR unpacker were built from', () => {
    // scripts/emulatorjs-sources.json, which NOTICE.txt names and a release
    // packs (scripts/pack-emulatorjs-source.mjs).
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const sources = JSON.parse(read('../scripts/emulatorjs-sources.json')) as {
      version: string;
      engine: { repo: string; commit: string };
      frontend: { repo: string; commit: string };
      build: { repo: string; commit: string };
      cores: Record<string, { repo: string; commit: string }>;
      helpers: Record<string, { repo: string; commit: string }>;
    };
    const script = read('../scripts/fetch-emulatorjs.mjs');
    expect(sources.version).toBe(script.match(/process\.env\.EJS_VERSION \?\? '([0-9.]+)'/)?.[1]);
    expect(Object.keys(sources.cores).sort()).toEqual([...new Set(ARCADE_CORES.map((c) => c.libretro))].sort());
    for (const s of [sources.engine, sources.frontend, sources.build, ...Object.values(sources.cores)]) {
      expect(s.repo).toMatch(/^https:\/\/github\.com\/EmulatorJS\/[A-Za-z0-9._-]+$/);
      expect(s.commit, s.repo).toMatch(/^[0-9a-f]{40}$/);
    }
    // The engine's prebuilt unpacking helpers whose source is known: the RAR one.
    expect(Object.keys(sources.helpers)).toEqual(['libunrar']);
    for (const s of Object.values(sources.helpers)) {
      expect(s.repo).toMatch(/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
      expect(s.commit, s.repo).toMatch(/^[0-9a-f]{40}$/);
    }
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

describe('the double-wide cabinet\'s four seats', () => {
  it('each seat is a lease of its own, in a key of its own; player one keeps the cabinet\'s key', () => {
    expect(seatKey(CAB)).toBe(`seat:${CAB}`);
    expect(seatKey(CAB, 0)).toBe(`seat:${CAB}`);
    expect(seatKey(CAB, 3)).toBe(`seat:${CAB}:3`);
    expect(insertCoin(CAB, 2)).toEqual({ ok: true });
    expect(readSeat(CAB, 2)).toEqual({ holder: ALICE, name: 'Alice', page: 'tab-a', leaseAt: now, by: ALICE });
    expect(readSeat(CAB).holder).toBe('');
    expect(mySeat(CAB)).toBe(2);
    expect(iAmP1(CAB)).toBe(false);
    iAm(BOB, 'Bob');
    setArcadePageId('tab-b');
    expect(seatStatus(CAB, 2)).toBe('held');
    expect(insertCoin(CAB, 2)).toEqual({ ok: false, error: 'Alice is at the controls.' });
    expect(insertCoin(CAB, 0)).toEqual({ ok: true });
    expect(mySeat(CAB)).toBe(0);
    expect(seatHolders(CAB).map((r) => r?.name ?? null)).toEqual(['Bob', null, 'Alice', null]);
    expect(seatHolders(CAB, 1).map((r) => r?.name ?? null)).toEqual(['Bob']);
  });

  it('a page holds one seat of a cabinet: taking another gives up the first, in the same write', () => {
    insertCoin(CAB, 1);
    let updates = 0;
    doc.on('update', () => { updates++; });
    expect(insertCoin(CAB, 3)).toEqual({ ok: true });
    expect(updates).toBe(1);
    expect(readSeat(CAB, 1).holder).toBe('');
    expect(mySeat(CAB)).toBe(3);
    // A seat at another cabinet is another matter.
    insertCoin('arcade-cabinet-2', 1);
    expect(mySeat(CAB)).toBe(3);
    expect(mySeat('arcade-cabinet-2')).toBe(1);
  });

  it('no seat past the fourth, and none that is not a whole number', () => {
    expect(insertCoin(CAB, ARCADE_SEATS_MAX)).toEqual({ ok: false, error: 'The cabinet has no such seat.' });
    expect(insertCoin(CAB, -1).ok).toBe(false);
    expect(insertCoin(CAB, 1.5).ok).toBe(false);
    expect(maySit(CAB, ARCADE_SEATS_MAX)).toBe(false);
    expect(isSeatIndex(3)).toBe(true);
    expect(isSeatIndex(ARCADE_SEATS_MAX)).toBe(false);
    expect(isSeatIndex('1')).toBe(false);
    expect(mySeat(CAB)).toBeNull();
  });

  it('every seat lapses and renews on its own, and the deed holder may unseat any of them', () => {
    insertCoin(CAB, 3);
    iAm(BOB, 'Bob');
    setArcadePageId('tab-b');
    insertCoin(CAB, 1);
    tick(ARCADE_SEAT_LAPSE_MS - 1);
    renewSeat(CAB, 1);
    tick(1);
    expect(seatStatus(CAB, 3)).toBe('free'); // Alice's went quiet, as Bob's page saw it
    expect(seatStatus(CAB, 1)).toBe('mine');
    expect(standUp(CAB, 3)).toEqual({ ok: false, error: 'Alice is at the controls.' });
    deed = true;
    expect(standUp(CAB, 3)).toEqual({ ok: true });
    expect(readSeat(CAB, 3).holder).toBe('');
    deed = false;
    expect(standUp(CAB, 1)).toEqual({ ok: true });
    expect(mySeat(CAB)).toBeNull();
  });

  it('the screen names one player and counts more, with their seats', () => {
    owner = true;
    putOnCabinet(CAB, TETRIS);
    insertCoin(CAB, 1);
    expect(arcadeScreenView(CAB)).toMatchObject({ mode: 'inplay', line: 'P2 · Alice' });
    iAm(BOB, 'Bob');
    setArcadePageId('tab-b');
    insertCoin(CAB, 3);
    expect(arcadeScreenView(CAB)).toMatchObject({ mode: 'inplay', line: '2 PLAYERS · P2 P4' });
    tick(ARCADE_SEAT_LAPSE_MS);
    renewSeat(CAB, 3);
    expect(arcadeScreenView(CAB)).toMatchObject({ mode: 'inplay', line: 'P4 · Bob' }); // Alice's lapsed
  });

  it('a play counts under any seat; a seat a peer wrote garbage into reads as free', () => {
    insertCoin(CAB, 2);
    countPlay(CAB);
    expect(readPlays(CAB)).toBe(1);
    doc.getMap('arcade').set(seatKey(CAB, 1), 'nonsense');
    expect(readSeat(CAB, 1)).toEqual({ holder: '', name: '', page: '', leaseAt: 0, by: '' });
    expect(seatStatus(CAB, 1)).toBe('free');
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

describe('high scores', () => {
  const LR = 'lantern-road';
  const line = (run: string, score: number, name = run.toUpperCase(), at = 0): HighScore => ({ name, score, at, run });

  it('keeps the best ten, best first, a tie to whoever set it first', () => {
    const goes = Array.from({ length: 12 }, (_, i) => line(`go${i}`, (i + 1) * 100, `P${i}`, i));
    goes.push(line('late', 1200, 'LATE', 99));
    const table = mergeHighScores([], goes);
    expect(table).toHaveLength(ARCADE_SCORES_MAX);
    expect(table.map((l) => l.run).slice(0, 3)).toEqual(['go11', 'late', 'go10']);
    expect(table.at(-1)!.score).toBe(400);
  });

  it('a later, higher score from the same go replaces its line; a lower one or a zero changes nothing', () => {
    let table = mergeHighScores([], [line('a', 500), line('b', 300)]);
    table = mergeHighScores(table, [line('b', 800), line('a', 200), line('c', 0)]);
    expect(table.map((l) => [l.run, l.score])).toEqual([['b', 800], ['a', 500]]);
  });

  it('writes only the goes that change the table, a key each, one table per game', () => {
    const writes: string[] = [];
    doc.getMap('arcade').observe((e) => { for (const k of e.keysChanged) writes.push(k); });
    let heard = 0;
    subscribeHighScores(CAB, LR, () => heard++);
    expect(recordHighScores(CAB, LR, [line('a', 500, 'Alice')])).toBe(true);
    expect(recordHighScores(CAB, LR, [line('a', 500, 'Alice')])).toBe(false);
    expect(recordHighScores(CAB, LR, [line('a', 0, 'Alice')])).toBe(false);
    expect(recordHighScores(CAB, LR, [line('a', 500, 'Alice'), line('b', 300, 'Bob')])).toBe(true);
    expect(writes).toEqual([scoreLineKey(CAB, LR, 0, 'a'), scoreLineKey(CAB, LR, 0, 'b')]);
    expect(heard).toBe(2);
    expect(readHighScores(CAB, LR)).toEqual([line('a', 500, 'Alice'), line('b', 300, 'Bob')]);
    expect(readHighScores(CAB, 'another-game')).toEqual([]);
    expect(readHighScores('arcade-cabinet-2', LR)).toEqual([]);
  });

  it('lets go of the lines pushed off the table', () => {
    recordHighScores(CAB, LR, Array.from({ length: ARCADE_SCORES_MAX }, (_, i) => line(`go${i}`, (i + 1) * 100)));
    recordHighScores(CAB, LR, [line('best', 5000)]);
    const keys = [...doc.getMap('arcade').keys()].filter((k) => k.startsWith(`${scoresKey(CAB, LR)}:`));
    expect(keys).toHaveLength(ARCADE_SCORES_MAX);
    expect(keys).not.toContain(scoreLineKey(CAB, LR, 0, 'go0'));
    expect(readHighScores(CAB, LR)[0]!.run).toBe('best');
  });

  it('ranks every page\'s lines once they meet, however many came back together', () => {
    // Five hosts kept ten lines each apart; synced, the best is the last key.
    const arcade = doc.getMap('arcade');
    for (let i = 0; i < 49; i++) arcade.set(scoreLineKey(CAB, LR, 0, `go${i}`), line(`go${i}`, (i + 1) * 10));
    arcade.set(scoreLineKey(CAB, LR, 0, 'top'), line('top', 99_000));
    expect(readHighScores(CAB, LR)[0]!.run).toBe('top');
    // The next go entered trims the rest, and keeps the best.
    expect(recordHighScores(CAB, LR, [line('new', 1000)])).toBe(true);
    expect(readHighScores(CAB, LR).map((l) => l.run).slice(0, 2)).toEqual(['top', 'new']);
    expect([...arcade.keys()].filter((k) => k.startsWith(`${scoresKey(CAB, LR)}:`))).toHaveLength(ARCADE_SCORES_MAX);
  });

  it('reads a peer\'s garbage as no line, clamps a silly score, and keeps one line a go', () => {
    const lines: unknown[] = [
      null, 'x', { name: '', score: 5, at: 0, run: 'r0' }, { name: 'NaN', score: Number.NaN, at: 0, run: 'r1' },
      { name: 'neg', score: -4, at: 0, run: 'r2' }, { name: 'frac', score: 1.5, at: 0, run: 'r3' },
      { name: 'big', score: Number.MAX_SAFE_INTEGER, at: 0, run: 'r4' },
      { name: 'x'.repeat(200), score: 10, at: 'soon', run: 'r5' },
      { name: 'dup', score: 9, at: 0, run: 'r5' },
    ];
    lines.forEach((l, i) => doc.getMap('arcade').set(scoreLineKey(CAB, LR, 0, `k${i}`), l));
    const table = readHighScores(CAB, LR);
    expect(table.map((l) => l.run)).toEqual(['r4', 'r5']);
    expect(table[0]!.score).toBe(ARCADE_SCORE_TOP);
    expect(table[1]!.name).toHaveLength(32);
    expect(table[1]!.at).toBe(0);
    // A CLEAR key that names no count reads as no CLEAR.
    doc.getMap('arcade').set(`${clearKey(CAB, LR, 0).slice(0, -1)}many`, { clears: 9 });
    expect(readHighScores(CAB, LR)).toHaveLength(2);
  });

  it('only the owner clears a table', () => {
    recordHighScores(CAB, LR, [line('a', 500)]);
    expect(clearHighScores(CAB, LR)).toEqual({ ok: false, error: 'Only the room owner changes the cabinet.' });
    expect(readHighScores(CAB, LR)).toHaveLength(1);
    owner = true;
    expect(clearHighScores(CAB, LR)).toEqual({ ok: true });
    expect(readHighScores(CAB, LR)).toEqual([]);
    expect([...doc.getMap('arcade').keys()].filter((k) => k.startsWith(`${scoresKey(CAB, LR)}:`))).toEqual([]);
    // The same go scoring on goes back up: it's still being played.
    recordHighScores(CAB, LR, [line('a', 600)]);
    expect(readHighScores(CAB, LR).map((l) => l.score)).toEqual([600]);
  });

  it('keeps both goes when two pages enter theirs at once', () => {
    // The host lost the room a while and played on; another page took the
    // cabinet over meanwhile. Each enters its goes on its own doc, then the
    // two sync: both lines are on the table.
    recordHighScores(CAB, LR, [line('old', 100)]);
    const a = doc;
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    recordHighScores(CAB, LR, [line('a1', 900)]);
    bindArcadeDoc(b);
    recordHighScores(CAB, LR, [line('b1', 700)]);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) {
      bindArcadeDoc(d);
      expect(readHighScores(CAB, LR).map((l) => l.run)).toEqual(['a1', 'b1', 'old']);
    }
  });

  it('keeps a go entered after a CLEAR on a page that hears of the go first', () => {
    // The owner clears on o; a host that has heard enters a go on h; page t
    // gets h's go before o's CLEAR, and enters a go of its own meanwhile.
    recordHighScores(CAB, LR, [line('old', 100)]);
    const o = doc;
    const h = new Y.Doc();
    const t = new Y.Doc();
    for (const d of [h, t]) Y.applyUpdate(d, Y.encodeStateAsUpdate(o));
    owner = true;
    clearHighScores(CAB, LR);
    owner = false;
    Y.applyUpdate(h, Y.encodeStateAsUpdate(o));
    bindArcadeDoc(h);
    const fromH: Uint8Array[] = [];
    const onUpdate = (u: Uint8Array) => fromH.push(u);
    h.on('update', onUpdate);
    recordHighScores(CAB, LR, [line('h1', 900)]);
    h.off('update', onUpdate);
    for (const u of fromH) Y.applyUpdate(t, u);
    bindArcadeDoc(t);
    expect(recordHighScores(CAB, LR, [line('t1', 500)])).toBe(true);
    for (const a of [o, h, t]) for (const b of [o, h, t]) if (a !== b) Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [o, h, t]) {
      bindArcadeDoc(d);
      expect(readHighScores(CAB, LR).map((l) => l.run)).toEqual(['h1']);
    }
  });

  it('keeps the highest CLEAR when owner tabs apart clear different numbers of times', () => {
    // Tab a clears once; tab b, apart, clears twice and a go goes up after.
    // Whichever writes land, the table's count is b's: its go stays on.
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.clientID = 2;
    b.clientID = 1;
    owner = true;
    for (const [d, times] of [[a, 1], [b, 2]] as const) {
      bindArcadeDoc(d);
      for (let i = 0; i < times; i++) clearHighScores(CAB, LR);
    }
    recordHighScores(CAB, LR, [line('b2', 700)]);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) {
      bindArcadeDoc(d);
      expect(readHighScores(CAB, LR).map((l) => l.run)).toEqual(['b2']);
    }
    // The next CLEAR goes past both, and wipes the go.
    clearHighScores(CAB, LR);
    expect(readHighScores(CAB, LR)).toEqual([]);
  });

  it('keeps a CLEAR when a page that hadn\'t heard of it enters a go', () => {
    recordHighScores(CAB, LR, [line('old', 100)]);
    const a = doc;
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    recordHighScores(CAB, LR, [line('a1', 900)]); // a's host, offline
    bindArcadeDoc(b);
    owner = true;
    clearHighScores(CAB, LR); // the owner, on b
    recordHighScores(CAB, LR, [line('b1', 700)]); // a go after the CLEAR
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const d of [a, b]) {
      bindArcadeDoc(d);
      expect(readHighScores(CAB, LR).map((l) => l.run)).toEqual(['b1']);
    }
  });
});

describe('the screen view', () => {
  it('the default game → taken off (empty) → the owner\'s own: attract (blinking) → in play, from the records alone', () => {
    now = ARCADE_BLINK_MS * 10; // an even phase
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'attract', title: 'THWAITE', line: 'PRESS START', lane: 'SOVEREIGN', blink: true, plays: 0, game: 'thwaite',
    });
    owner = true;
    takeOffCabinet(CAB);
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'empty', title: 'FURLONG ARCADE', line: 'THE OWNER PICKS A GAME', lane: '', blink: false, plays: 0, game: '',
    });
    putOnCabinet(CAB, PACMAN);
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'attract', title: 'PACMAN', line: 'INSERT COIN', lane: 'CONVENIENCE', blink: true, plays: 0, game: '',
    });
    now += ARCADE_BLINK_MS;
    expect(arcadeScreenView(CAB).blink).toBe(false);
    insertCoin(CAB);
    expect(arcadeScreenView(CAB)).toEqual({
      mode: 'inplay', title: 'PACMAN', line: 'P1 · Alice', lane: 'CONVENIENCE', blink: false, plays: 0, game: '',
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
