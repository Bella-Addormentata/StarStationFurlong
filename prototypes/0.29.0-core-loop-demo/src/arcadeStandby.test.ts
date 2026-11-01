/**
 * 🕹️ The standby pictures (#333): each bundled game's picture in
 * public/arcade/standby is exactly the frame its standby recipe runs the
 * ROM to, as the cabinet's screen draws it (writeFrameRgba's lifted black).
 * The idle cabinet shows the picture; a game started there carries on from
 * that very frame (arcadeNesSession), so the two must never drift apart.
 *
 * This file also WRITES them. After changing a ROM, a recipe or jsnes:
 *
 *   ARCADE_STANDBY_WRITE=1 npx vitest run src/arcadeStandby.test.ts
 *
 * The PNG reading and writing here is the plain kind only (8-bit RGB, one
 * IDAT run): enough for pictures this file wrote, with every row filter
 * read back in case another tool re-saves them.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { ARCADE_GAMES, STANDBY_START_FRAMES, type ArcadeGame } from './arcadeLibrary';
import { ArcadeMachine } from './arcadeMachine';
import { NES_H, NES_W, writeFrameRgba } from './arcadeScreen';
import { ARCADE_SIGNS } from './arcadeSigns';

const publicFile = (url: string): string => fileURLToPath(new URL(`../public${url}`, import.meta.url));
const WRITE = process.env.ARCADE_STANDBY_WRITE === '1';

/** The standby frame as RGB bytes, the way the cabinet's screen paints it. */
function standbyRgb(game: ArcadeGame): Buffer {
  const machine = new ArcadeMachine();
  expect(machine.load(new Uint8Array(readFileSync(publicFile(game.romUrl))))).toEqual({ ok: true });
  machine.toStandby(game.standby);
  const frame = machine.frameBuffer();
  expect(frame, `${game.id} drew no frame`).not.toBeNull();
  const rgba = new Uint8ClampedArray(NES_W * NES_H * 4);
  writeFrameRgba(frame!, rgba);
  const rgb = Buffer.alloc(NES_W * NES_H * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    rgb[o] = rgba[i]!;
    rgb[o + 1] = rgba[i + 1]!;
    rgb[o + 2] = rgba[i + 2]!;
  }
  return rgb;
}

// ── PNG, the plain kind ──────────────────────────────────────────────────────

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w: number, h: number, rgb: Buffer): Buffer {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function decodePng(png: Buffer): { w: number; h: number; rgb: Buffer } {
  expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  let at = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]], 'an 8-bit RGB picture, not interlaced').toEqual([8, 2, 0]);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 3;
  const rgb = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 3 ? rgb[y * stride + x - 3]! : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x]! : 0;
      const c = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3]! : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgb[y * stride + x] = (v + p) & 0xff;
    }
  }
  return { w, h, rgb };
}

// ── The pictures ─────────────────────────────────────────────────────────────

describe('standby pictures', () => {
  it.each(ARCADE_GAMES.map((g) => [g.id, g] as const))('%s: its recipe lets go of START before its last frame', (_id, game) => {
    expect(game.standby.frames).toBeGreaterThan(0);
    if (game.standby.start !== undefined) {
      expect(game.standby.start + STANDBY_START_FRAMES).toBeLessThan(game.standby.frames);
    }
    expect(game.standbyUrl).toBe(`/arcade/standby/${game.id}.png`);
  });

  it.each(ARCADE_GAMES.map((g) => [g.id, g] as const))('%s: the picture is the frame its recipe reaches', (_id, game) => {
    const rgb = standbyRgb(game);
    const file = publicFile(game.standbyUrl);
    if (WRITE) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, encodePng(NES_W, NES_H, rgb));
    }
    expect(existsSync(file), `${game.standbyUrl} is missing: ARCADE_STANDBY_WRITE=1 writes it`).toBe(true);
    const png = decodePng(readFileSync(file));
    expect([png.w, png.h]).toEqual([NES_W, NES_H]);
    expect(png.rgb.equals(rgb), `${game.standbyUrl} is stale: ARCADE_STANDBY_WRITE=1 rewrites it`).toBe(true);
  });

  it.each(ARCADE_GAMES.map((g) => [g.id, g] as const))('%s: the standby is a picture, not a blank screen', (_id, game) => {
    const rgb = standbyRgb(game);
    const colours = new Set<number>();
    for (let i = 0; i < rgb.length; i += 3) colours.add((rgb[i]! << 16) | (rgb[i + 1]! << 8) | rgb[i + 2]!);
    expect(colours.size).toBeGreaterThan(1);
  });

  it('running to standby is the same on every machine, and silent', () => {
    for (const game of ARCADE_GAMES) {
      const rom = new Uint8Array(readFileSync(publicFile(game.romUrl)));
      const samples: number[] = [];
      const loud = new ArcadeMachine({ sampleRate: 44100, onAudioSample: (l) => samples.push(l) });
      const plain = new ArcadeMachine();
      loud.load(rom);
      plain.load(rom);
      loud.toStandby(game.standby);
      plain.toStandby(game.standby);
      expect(samples, `${game.id} played its run-up`).toEqual([]);
      expect(loud.check(), game.id).toBe(plain.check());
      expect([...loud.frameBuffer()!]).toEqual([...plain.frameBuffer()!]);
      // …and it plays its sound again once it is there.
      loud.runFrame(0, 0);
      expect(samples.length, game.id).toBeGreaterThan(0);
    }
  });

  it("Thwaite's standby is past its licence notice: its title and menu", () => {
    const thwaite = ARCADE_GAMES.find((g) => g.id === 'thwaite')!;
    const rom = new Uint8Array(readFileSync(publicFile(thwaite.romUrl)));
    const frameAfter = (recipe: ArcadeGame['standby']) => {
      const m = new ArcadeMachine();
      m.load(rom);
      m.toStandby(recipe);
      return [...m.frameBuffer()!];
    };
    expect(thwaite.standby.start).toBeDefined();
    // Without the Start the same frames stay on the notice page.
    expect(frameAfter(thwaite.standby)).not.toEqual(frameAfter({ frames: thwaite.standby.frames }));
  });

  it("a sign's logo is cut from inside its game's picture", () => {
    for (const game of ARCADE_GAMES) {
      const logo = ARCADE_SIGNS[game.id]?.logo;
      if (!logo) continue;
      const [x, y, w, h] = logo;
      expect(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= NES_W && y + h <= NES_H, game.id).toBe(true);
    }
  });

  it('the README lists the pictures with their games', () => {
    const readme = readFileSync(publicFile('/arcade/README.md'), 'utf8');
    for (const game of ARCADE_GAMES) expect(readme).toContain(game.standbyUrl.replace('/arcade/', ''));
  });
});
