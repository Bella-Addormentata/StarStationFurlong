/**
 * 🔳 The station's QR encoder, read back by an independent decoder (jsQR) and
 * checked against the standard's tables (ISO/IEC 18004: alignment positions,
 * data capacities, format and version information), so a code the Bank app
 * or the faucet dish shows is one a phone's wallet reads.
 */
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import {
  alignmentPositions,
  byteCapacity,
  formatInformation,
  qrMatrix,
  qrSvg,
  sizeOf,
  versionInformation,
  type QrMatrix,
} from './qrCode';

/** Alignment pattern centres per version 2–40 (annex E). */
const ALIGN: number[][] = [
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
  [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
  [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

/** Data bits per version at level M (table 7). */
const DATA_BITS_M = [
  128, 224, 352, 512, 688, 864, 992, 1232, 1456, 1728, 2032, 2320, 2672, 2920, 3320, 3624, 4056, 4504, 5016, 5352,
  5712, 6256, 6880, 7312, 8000, 8496, 9024, 9544, 10136, 10984, 11640, 12328, 13048, 13800, 14496, 15312, 15936, 16816,
  17728, 18672,
];

/** Format information for level M, masks 0–7 (table C.1). */
const FORMAT_M = [21522, 20773, 24188, 23371, 17913, 16590, 20375, 19104];

/** Version information for versions 7–40 (table D.1). */
const VERSION_INFO = [
  31892, 34236, 39577, 42195, 48118, 51042, 55367, 58893, 63784, 68472, 70749, 76311, 79154, 84390, 87683, 92361,
  96236, 102084, 102881, 110507, 110734, 117786, 119615, 126325, 127568, 133589, 136944, 141498, 145311, 150283, 152622,
  158308, 161089, 167017,
];

/** The matrix as the RGBA image a camera would hand a decoder: `scale`
 *  pixels per module, a quiet zone of four modules, black on white. */
function raster(m: QrMatrix, scale = 4, quiet = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const side = (m.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.modules[y * m.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx;
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

function decode(m: QrMatrix): Uint8Array {
  const img = raster(m);
  const read = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (!read) throw new Error(`jsQR read nothing from a version ${m.version} code`);
  return Uint8Array.from(read.binaryData);
}

/** A deterministic printable payload of `n` bytes. */
function payload(n: number, seed = 7): string {
  let s = '';
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += String.fromCharCode(33 + (x % 94));
  }
  return s;
}

const ADDRESS = 'txch1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);

describe('qrMatrix', () => {
  it('encodes a testnet11 address that an independent reader decodes back', () => {
    const m = qrMatrix(ADDRESS);
    expect(m.version).toBe(5); // 63 bytes: version 4 holds 48, version 5 holds 84
    expect(m.size).toBe(37);
    expect(new TextDecoder().decode(decode(m))).toBe(ADDRESS);
  });

  it('decodes at the smallest and the largest payload of each version it may choose', () => {
    // Every version's block structure, interleaving, alignment and version
    // information is exercised at its two capacity edges; the sweep covers
    // each distinct table shape (one group, two groups, 8- and 16-bit counts,
    // version information from 7 on) and the largest symbol.
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 20, 21, 27, 32, 40]) {
      const smallest = v === 1 ? 1 : byteCapacity(v - 1) + 1;
      for (const n of [smallest, byteCapacity(v)]) {
        const text = payload(n, v);
        const m = qrMatrix(text);
        expect(m.version, `${n} bytes`).toBe(v);
        expect(new TextDecoder().decode(decode(m)), `version ${v}, ${n} bytes`).toBe(text);
      }
    }
  });

  it('carries bytes as bytes: UTF-8 text comes back as the same bytes', () => {
    const text = 'ünïcödé ☕ 🔳';
    const bytes = new TextEncoder().encode(text);
    const m = qrMatrix(text);
    expect(decode(m)).toEqual(bytes);
    expect(qrMatrix(bytes).modules).toEqual(m.modules);
  });

  it('is deterministic and picks the smallest version that holds the bytes', () => {
    expect(qrMatrix('hello').modules).toEqual(qrMatrix('hello').modules);
    expect(qrMatrix(payload(14)).version).toBe(1);
    expect(qrMatrix(payload(15)).version).toBe(2);
    expect(qrMatrix(payload(84)).version).toBe(5);
    expect(qrMatrix(payload(85)).version).toBe(6);
    expect(qrMatrix(payload(2331)).version).toBe(40);
  });

  it('refuses nothing and refuses more than version 40 holds', () => {
    expect(() => qrMatrix('')).toThrow(/nothing/);
    expect(() => qrMatrix(new Uint8Array(0))).toThrow(/nothing/);
    expect(() => qrMatrix(payload(2332))).toThrow(/too long/);
  });

  it('has the standard\'s tables: sizes, alignment centres, capacities, format and version information', () => {
    expect(sizeOf(1)).toBe(21);
    expect(sizeOf(40)).toBe(177);
    expect(alignmentPositions(1)).toEqual([]);
    for (let v = 2; v <= 40; v++) expect(alignmentPositions(v), `version ${v}`).toEqual(ALIGN[v - 2]);
    for (let v = 1; v <= 40; v++) {
      const countBits = v <= 9 ? 8 : 16;
      expect(byteCapacity(v), `version ${v}`).toBe(Math.floor((DATA_BITS_M[v - 1] - 4 - countBits) / 8));
    }
    for (let mask = 0; mask < 8; mask++) expect(formatInformation(mask)).toBe(FORMAT_M[mask]);
    for (let v = 7; v <= 40; v++) expect(versionInformation(v), `version ${v}`).toBe(VERSION_INFO[v - 7]);
  });

  it('places the function patterns where the standard puts them', () => {
    const m = qrMatrix('x');
    const at = (x: number, y: number) => m.modules[y * m.size + x];
    // Finder centres dark, their light rings, the separators.
    for (const [cx, cy] of [[3, 3], [17, 3], [3, 17]]) {
      expect(at(cx, cy)).toBe(1);
      expect(at(cx + 2, cy)).toBe(0);
      expect(at(cx + 3, cy)).toBe(1);
    }
    expect(at(7, 7)).toBe(0);
    // The timing patterns alternate, dark on even indices.
    for (let i = 8; i < 13; i++) {
      expect(at(6, i)).toBe(i % 2 === 0 ? 1 : 0);
      expect(at(i, 6)).toBe(i % 2 === 0 ? 1 : 0);
    }
    // The dark module beside the lower-left finder.
    expect(at(8, m.size - 8)).toBe(1);
  });
});

describe('qrSvg', () => {
  it('draws the code as one path on a light square, in modules, with a quiet zone of four', () => {
    const svg = qrSvg('x');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" width="116" height="116"')).toBe(true);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('<rect width="29" height="29" fill="#fff"/>');
    expect(svg).toMatch(/<path d="M\d+ \d+h\d+v1h-\d+z/);
    expect(svg).toContain('fill="#000"/></svg>');
    // Hidden from screen readers unless given a label.
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).not.toContain('role="img"');
    expect(qrSvg('x')).toBe(svg);
  });

  it('takes a size, colours, a class and a label, escaped', () => {
    const svg = qrSvg(ADDRESS, { module: 3, quiet: 2, dark: '#f0c060', light: '#040816', className: 'bank-qr', label: 'QR code of the "receive" address' });
    expect(svg).toContain('viewBox="0 0 41 41" width="123" height="123"');
    expect(svg).toContain('fill="#040816"/>');
    expect(svg).toContain('fill="#f0c060"/></svg>');
    expect(svg).toContain(' class="bank-qr"');
    expect(svg).toContain(' role="img" aria-label="QR code of the &quot;receive&quot; address"');
    expect(svg).not.toContain('aria-hidden');
  });

  it('draws exactly the dark modules of the matrix', () => {
    const m = qrMatrix(ADDRESS);
    const svg = qrSvg(ADDRESS, { quiet: 0 });
    let drawn = 0;
    for (const run of svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const x = Number(run[1]);
      const y = Number(run[2]);
      const len = Number(run[3]);
      for (let i = 0; i < len; i++) expect(m.modules[y * m.size + x + i], `(${x + i}, ${y})`).toBe(1);
      drawn += len;
    }
    expect(drawn).toBe(m.modules.reduce((a, b) => a + b, 0));
  });
});
