/**
 * 🕹️ Arcade library tests: every bundled game ships with its ROM, its license
 * and (for copyleft games) its source, is credited in public/arcade/README.md,
 * and actually boots in the emulator; and the cartridge checks refuse junk.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { ARCADE_GAMES, MAX_ROM_BYTES, parseInesHeader } from './arcadeLibrary';
import { ArcadeMachine } from './arcadeMachine';

const publicFile = (url: string): string => new URL(`../public${url}`, import.meta.url).pathname;
const romBytes = (url: string): Uint8Array => new Uint8Array(readFileSync(publicFile(url)));

/** A minimal iNES image: header + the PRG/CHR banks it declares. */
function ines(prg: number, chr: number, mapper = 0): Uint8Array {
  const bytes = new Uint8Array(16 + prg * 16384 + chr * 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, prg, chr, (mapper & 0x0f) << 4, mapper & 0xf0]);
  return bytes;
}

describe('arcade library', () => {
  it('has unique ids and titles', () => {
    expect(new Set(ARCADE_GAMES.map((g) => g.id)).size).toBe(ARCADE_GAMES.length);
    expect(new Set(ARCADE_GAMES.map((g) => g.title)).size).toBe(ARCADE_GAMES.length);
  });

  it.each(ARCADE_GAMES.map((g) => [g.id, g] as const))('%s ships its ROM, license and source', (_id, game) => {
    expect(existsSync(publicFile(game.romUrl)), game.romUrl).toBe(true);
    // The license text travels with the app too, so the credits hold offline.
    expect(game.licenseUrl).toMatch(/^\/arcade\/licenses\//);
    expect(existsSync(publicFile(game.licenseUrl)), game.licenseUrl).toBe(true);
    // Copyleft: the corresponding source travels with the binary.
    if (game.license.startsWith('GPL')) {
      expect(game.bundledSource, 'a GPL game must bundle its source').toBeTruthy();
      expect(existsSync(publicFile(game.bundledSource!))).toBe(true);
    }
    expect(game.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('credits every game, its license and its commit on the README page', () => {
    const readme = readFileSync(publicFile('/arcade/README.md'), 'utf8');
    for (const game of ARCADE_GAMES) {
      expect(readme).toContain(game.romUrl.replace('/arcade/', ''));
      expect(readme).toContain(game.sourceCommit);
      expect(readme).toContain(game.author);
    }
  });

  it('every file the README links to ships (license texts, sources)', () => {
    const readme = readFileSync(publicFile('/arcade/README.md'), 'utf8');
    const links = [...readme.matchAll(/\]\(((?:licenses|source|roms)\/[^)]+)\)/g)].map((m) => m[1]);
    expect(links).toContain('licenses/Apache-2.0-jsnes.txt');
    for (const link of links) expect(existsSync(publicFile(`/arcade/${link}`)), link).toBe(true);
  });

  it.each(ARCADE_GAMES.map((g) => [g.id, g] as const))('%s boots and draws in the emulator', (_id, game) => {
    const bytes = romBytes(game.romUrl);
    expect(parseInesHeader(bytes).ok).toBe(true);
    const machine = new ArcadeMachine();
    expect(machine.load(bytes)).toEqual({ ok: true });
    // ~4 s of attract/title, Start, then ~2 s more.
    for (let i = 0; i < 240; i++) machine.step(1 / 60);
    machine.press(1, 'START');
    for (let i = 0; i < 6; i++) machine.step(1 / 60);
    machine.release(1, 'START');
    for (let i = 0; i < 120; i++) machine.step(1 / 60);
    const frame = machine.frameBuffer();
    expect(frame).not.toBeNull();
    expect(frame!.length).toBe(256 * 240);
    // Something is on screen: more than one colour.
    expect(new Set(frame!).size).toBeGreaterThan(1);
  });
});

describe('parseInesHeader', () => {
  it('reads mapper and bank counts', () => {
    expect(parseInesHeader(ines(2, 1, 0))).toEqual({ ok: true, mapper: 0, prgBanks: 2, chrBanks: 1 });
    expect(parseInesHeader(ines(1, 0, 0x42))).toEqual({ ok: true, mapper: 0x42, prgBanks: 1, chrBanks: 0 });
  });

  it('refuses what is not a whole NES ROM', () => {
    expect(parseInesHeader(new Uint8Array(8))).toEqual({ ok: false, reason: 'FILE TOO SMALL' });
    expect(parseInesHeader(new TextEncoder().encode('<html>not a rom at all</html>'))).toEqual({
      ok: false,
      reason: 'NOT AN NES ROM',
    });
    expect(parseInesHeader(ines(0, 1))).toEqual({ ok: false, reason: 'NO PROGRAM DATA' });
    expect(parseInesHeader(ines(2, 1).subarray(0, 20000))).toEqual({ ok: false, reason: 'ROM IS TRUNCATED' });
    expect(parseInesHeader(new Uint8Array(MAX_ROM_BYTES + 1))).toEqual({ ok: false, reason: 'FILE TOO LARGE' });
  });

  it('reads NES 2.0 sizes, so a header cannot declare more than the file holds', () => {
    const nes2 = (bytes: Uint8Array, byte8: number, byte9: number) => {
      bytes[7] = (bytes[7] & 0xf0) | 0x08;
      bytes[8] = byte8;
      bytes[9] = byte9;
      return bytes;
    };
    // Plain NES 2.0: the high nibble of byte 8 extends the mapper number.
    expect(parseInesHeader(nes2(ines(2, 1, 0x42), 0x01, 0x00))).toEqual({
      ok: true,
      mapper: 0x142,
      prgBanks: 2,
      chrBanks: 1,
    });
    // Byte 9 adds 256 PRG banks (4 MiB) the 2-bank file doesn't hold.
    expect(parseInesHeader(nes2(ines(2, 1), 0, 0x01))).toEqual({ ok: false, reason: 'ROM IS TRUNCATED' });
    // Exponent mode: byte 4 = 0x80 declares 2^32 bytes (4 GiB) of PRG, though
    // the file is padded to the 128 banks byte 4 alone would mean.
    const huge = nes2(ines(0x80, 1), 0, 0x0f);
    expect(parseInesHeader(huge)).toEqual({ ok: false, reason: 'ROM IS TRUNCATED' });
    // Exponent mode that fits: 2^15 × 1 = 32 KiB of PRG, the same as 2 banks.
    const exact = nes2(ines(2, 1), 0, 0x0f);
    exact[4] = 15 << 2;
    expect(parseInesHeader(exact)).toEqual({ ok: true, mapper: 0, prgBanks: 2, chrBanks: 1 });
  });
});

describe('ArcadeMachine', () => {
  it('reports a mapper jsnes cannot run instead of throwing', () => {
    expect(new ArcadeMachine().load(ines(2, 1, 0xfe))).toEqual({
      ok: false,
      reason: 'THIS CARTRIDGE TYPE IS NOT SUPPORTED',
    });
  });

  it('runs at most three frames per step and drops a long backlog', () => {
    const machine = new ArcadeMachine();
    machine.load(romBytes(ARCADE_GAMES[0].romUrl));
    expect(machine.step(1 / 60)).toBe(1);
    expect(machine.step(1)).toBe(3);
    // The backlog from that 1 s hitch was dropped, not queued.
    expect(machine.step(0)).toBe(0);
    expect(machine.step(-5)).toBe(0);
    expect(machine.step(Number.NaN)).toBe(0);
  });

  it('does nothing before a ROM is loaded or after stop()', () => {
    const machine = new ArcadeMachine();
    expect(machine.running).toBe(false);
    expect(machine.step(1)).toBe(0);
    machine.press(1, 'A'); // no console: ignored, no throw
    machine.load(romBytes(ARCADE_GAMES[0].romUrl));
    expect(machine.running).toBe(true);
    machine.stop();
    expect(machine.running).toBe(false);
    expect(machine.frameBuffer()).toBeNull();
  });
});
