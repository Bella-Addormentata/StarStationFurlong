/**
 * 🔳 QR codes for the station's own screens — the Bank app's receive address
 * and the faucet dish's jar address — drawn as inline SVG.
 *
 * Byte mode, error correction level M (about 15 % of the codewords may be
 * unreadable), model 2 symbols of versions 1 to 40, the mask chosen by the
 * four penalty rules of ISO/IEC 18004. Written here rather than taken as a
 * dependency: the station shows a QR seldom, wants nothing else of an
 * encoder, and keeps its runtime dependencies few. The tests decode every
 * code this file makes with an independent reader (jsQR, a dev dependency)
 * and check the tables against the standard's.
 *
 * What a code carries is the BARE address, never a URI scheme: wallet apps
 * and faucets read a bare address, while `chia:`-style schemes are parsed
 * inconsistently or refused (XOPTrader's Base wallet made the same call for
 * its deposit QR). The network warning belongs in the text beside the code,
 * where a person reads it, not in the payload.
 */

/** A rendered symbol: `size` modules a side, `modules[y * size + x]` is 1
 *  where the module is dark. `version` is the symbol version (1–40). */
export interface QrMatrix {
  size: number;
  version: number;
  modules: Uint8Array;
}

/** Level M block structure per version (ISO/IEC 18004 table 9):
 *  [ecc codewords per block, group-1 blocks, group-1 data codewords,
 *   group-2 blocks, group-2 data codewords]. Every block of a version has
 *  the same number of ecc codewords; group 2's blocks carry one data
 *  codeword more than group 1's. */
const EC_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0], // v1
  [16, 1, 28, 0, 0], // v2
  [26, 1, 44, 0, 0], // v3
  [18, 2, 32, 0, 0], // v4
  [24, 2, 43, 0, 0], // v5
  [16, 4, 27, 0, 0], // v6
  [18, 4, 31, 0, 0], // v7
  [22, 2, 38, 2, 39], // v8
  [22, 3, 36, 2, 37], // v9
  [26, 4, 43, 1, 44], // v10
  [30, 1, 50, 4, 51], // v11
  [22, 6, 36, 2, 37], // v12
  [22, 8, 37, 1, 38], // v13
  [24, 4, 40, 5, 41], // v14
  [24, 5, 41, 5, 42], // v15
  [28, 7, 45, 3, 46], // v16
  [28, 10, 46, 1, 47], // v17
  [26, 9, 43, 4, 44], // v18
  [26, 3, 44, 11, 45], // v19
  [26, 3, 41, 13, 42], // v20
  [26, 17, 42, 0, 0], // v21
  [28, 17, 46, 0, 0], // v22
  [28, 4, 47, 14, 48], // v23
  [28, 6, 45, 14, 46], // v24
  [28, 8, 47, 13, 48], // v25
  [28, 19, 46, 4, 47], // v26
  [28, 22, 45, 3, 46], // v27
  [28, 3, 45, 23, 46], // v28
  [28, 21, 45, 7, 46], // v29
  [28, 19, 47, 10, 48], // v30
  [28, 2, 46, 29, 47], // v31
  [28, 10, 46, 23, 47], // v32
  [28, 14, 46, 21, 47], // v33
  [28, 14, 46, 23, 47], // v34
  [28, 12, 47, 26, 48], // v35
  [28, 6, 47, 34, 48], // v36
  [28, 29, 46, 14, 47], // v37
  [28, 13, 46, 32, 47], // v38
  [28, 40, 47, 7, 48], // v39
  [28, 18, 47, 31, 48], // v40
];

/** The most bytes a version carries at level M in byte mode (its data
 *  codewords, less the mode indicator and the character count). */
export function byteCapacity(version: number): number {
  const [, g1, d1, g2, d2] = EC_M[version - 1];
  const dataBits = (g1 * d1 + g2 * d2) * 8;
  return Math.floor((dataBits - 4 - countBits(version)) / 8);
}

/** Byte mode's character count indicator: 8 bits to version 9, 16 after. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Side length in modules: 21 for version 1, four more per version. */
export function sizeOf(version: number): number {
  return version * 4 + 17;
}

/** Centre coordinates of the alignment patterns along one axis (ISO/IEC
 *  18004 annex E): none for version 1, then evenly spaced from 6 to the far
 *  finder's edge, the spacing even and rounded up — version 32 is the one the
 *  rounding rule misplaces, so its 26 is given. The same list serves both
 *  axes; the three corners under the finders are skipped at placement. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = sizeOf(version);
  const step = version === 32 ? 26 : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ── Reed–Solomon over GF(2^8), the field polynomial x^8+x^4+x^3+x^2+1 ──────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** The generator polynomial of `degree` ecc codewords, highest power first,
 *  leading coefficient 1 left out: the product of (x − 2^i), i < degree. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly.subarray(1);
}

/** The `generator.length` ecc codewords of `data`: the remainder of
 *  data · x^degree divided by the generator. */
function rsRemainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const result = new Uint8Array(generator.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < generator.length; i++) result[i] ^= gfMul(generator[i], factor);
  }
  return result;
}

// ── Data: mode, count, bytes, terminator, padding, blocks, interleave ──────

class BitBuffer {
  readonly bits: number[] = [];

  push(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** The smallest version whose level-M capacity holds `n` bytes, or 0. */
function versionFor(n: number): number {
  for (let v = 1; v <= 40; v++) if (byteCapacity(v) >= n) return v;
  return 0;
}

/** The final codeword sequence for `bytes` at `version`: data codewords
 *  (mode, count, bytes, terminator, pad bytes), split into the version's
 *  blocks, each with its ecc, interleaved block by block as the symbol
 *  reads them. */
function codewords(bytes: Uint8Array, version: number): Uint8Array {
  const [ecc, g1, d1, g2, d2] = EC_M[version - 1];
  const dataLen = g1 * d1 + g2 * d2;
  const buf = new BitBuffer();
  buf.push(0b0100, 4); // byte mode
  buf.push(bytes.length, countBits(version));
  for (const b of bytes) buf.push(b, 8);
  const capacity = dataLen * 8;
  buf.push(0, Math.min(4, capacity - buf.bits.length)); // terminator
  buf.push(0, (8 - (buf.bits.length % 8)) % 8); // to a byte boundary
  for (let pad = 0xec; buf.bits.length < capacity; pad ^= 0xec ^ 0x11) buf.push(pad, 8);
  const data = new Uint8Array(dataLen);
  for (let i = 0; i < buf.bits.length; i++) data[i >> 3] |= buf.bits[i] << (7 - (i & 7));

  const generator = rsGenerator(ecc);
  const blocks: Uint8Array[] = [];
  const eccs: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < g1 + g2; b++) {
    const len = b < g1 ? d1 : d2;
    const block = data.subarray(offset, offset + len);
    offset += len;
    blocks.push(block);
    eccs.push(rsRemainder(block, generator));
  }
  const out = new Uint8Array(dataLen + (g1 + g2) * ecc);
  let k = 0;
  const longest = g2 > 0 ? d2 : d1;
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) out[k++] = block[i];
  }
  for (let i = 0; i < ecc; i++) {
    for (const e of eccs) out[k++] = e[i];
  }
  return out;
}

// ── The symbol ─────────────────────────────────────────────────────────────

/** The 15 format bits for level M and mask pattern `mask`: the five data
 *  bits (00 for level M, then the mask), their BCH(15,5) remainder, the
 *  whole XORed with 0x5412 so no pattern is all light. */
export function formatInformation(mask: number): number {
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits for versions 7 to 40: the version and its BCH(18,6)
 *  remainder. */
export function versionInformation(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

class QrSymbol {
  readonly size: number;
  readonly modules: Uint8Array;
  /** Function patterns and the format/version areas: never masked, never data. */
  readonly reserved: Uint8Array;

  constructor(readonly version: number) {
    this.size = sizeOf(version);
    this.modules = new Uint8Array(this.size * this.size);
    this.reserved = new Uint8Array(this.size * this.size);
  }

  get(x: number, y: number): number {
    return this.modules[y * this.size + x];
  }

  /** A function module: set and reserved. */
  fix(x: number, y: number, dark: boolean): void {
    const i = y * this.size + x;
    this.modules[i] = dark ? 1 : 0;
    this.reserved[i] = 1;
  }

  drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      // Timing patterns, alternating from the finders' corners.
      this.fix(6, i, i % 2 === 0);
      this.fix(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(n - 4, 3);
    this.drawFinder(3, n - 4);
    const align = alignmentPositions(this.version);
    const last = align.length - 1;
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.drawAlignment(align[i], align[j]);
      }
    }
    // Reserve the format areas (drawn per mask) and the version area.
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        // Rings: dark centre 3×3, light ring, dark ring, light separator.
        this.fix(x, y, d !== 2 && d !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.fix(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** Format information for level M and `mask`: 5 data bits, 10 BCH bits,
   *  masked with 0x5412, written twice around the finders. */
  drawFormatBits(mask: number): void {
    const bits = formatInformation(mask);
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.fix(8, i, bit(i));
    this.fix(8, 7, bit(6));
    this.fix(8, 8, bit(7));
    this.fix(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.fix(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.fix(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.fix(8, n - 15 + i, bit(i));
    this.fix(8, n - 8, true); // the dark module
  }

  /** Version information from version 7 on: 6 bits, 12 BCH bits, twice. */
  private drawVersion(): void {
    if (this.version < 7) return;
    const bits = versionInformation(this.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.fix(a, b, dark);
      this.fix(b, a, dark);
    }
  }

  /** Codewords into the free modules, two columns at a time, up then down,
   *  the timing column skipped; remainder bits stay light. */
  drawCodewords(words: Uint8Array): void {
    const n = this.size;
    let i = 0;
    const total = words.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          const k = y * n + x;
          if (this.reserved[k]) continue;
          if (i < total) {
            this.modules[k] = (words[i >> 3] >>> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
  }

  /** XOR the data modules with mask pattern `mask` (its own inverse). */
  applyMask(mask: number): void {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const k = y * n + x;
        if (this.reserved[k]) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[k] ^= 1;
      }
    }
  }

}

/** The standard's penalty score of a symbol — the four rules: runs of five or more alike
 *  modules (3, plus one per module beyond five), 2×2 blocks alike (3
 *  each), finder-like 1:1:3:1:1 runs with four light modules on one side
 *  (40 each), and the dark proportion's distance from a half (10 per 5 %
 *  step). The run history is newest first; the line's edges count as
 *  light. */
export function penaltyScore(matrix: QrMatrix): number {
  const n = matrix.size;
  const modules = matrix.modules;
  const get = (x: number, y: number): number => modules[y * n + x];
  let score = 0;
  const history = new Int32Array(7);
  const addHistory = (run: number): void => {
    if (history[0] === 0) run += n; // the first run borders the light edge
    history.copyWithin(1, 0);
    history[0] = run;
  };
  /** Finder-like patterns ending at the newest light run: history[1..5]
   *  spell dark 1, light 1, dark 3, light 1, dark 1 (in units), with a
   *  light run of four units or more on one side and at least one on the
   *  other — counted once per side that qualifies. */
  const countFinders = (): number => {
    const unit = history[1];
    const core = unit > 0 && history[2] === unit && history[3] === unit * 3 && history[4] === unit && history[5] === unit;
    if (!core) return 0;
    return (history[0] >= unit * 4 && history[6] >= unit ? 1 : 0) + (history[6] >= unit * 4 && history[0] >= unit ? 1 : 0);
  };
  const scan = (line: (i: number) => number): number => {
    let s = 0;
    history.fill(0);
    let color = 0;
    let run = 0;
    for (let i = 0; i < n; i++) {
      const c = line(i);
      if (c === color) {
        run++;
        if (run === 5) s += 3;
        else if (run > 5) s += 1;
      } else {
        addHistory(run);
        if (color === 0) s += countFinders() * 40;
        color = c;
        run = 1;
      }
    }
    if (color === 1) {
      addHistory(run);
      run = 0;
    }
    addHistory(run + n); // the far edge, light
    s += countFinders() * 40;
    return s;
  };
  for (let y = 0; y < n; y++) score += scan((x) => get(x, y));
  for (let x = 0; x < n; x++) score += scan((y) => get(x, y));
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = get(x, y);
      if (c === get(x + 1, y) && c === get(x, y + 1) && c === get(x + 1, y + 1)) score += 3;
    }
  }
  let dark = 0;
  for (const m of modules) dark += m;
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The symbol for `text` (UTF-8) or raw bytes: byte mode, level M, the
 *  smallest version that holds it, the mask with the lowest penalty score
 *  (`penaltyScore`) unless `mask` names one. Throws on nothing to encode or
 *  more than version 40 carries. */
export function qrMatrix(text: string | Uint8Array, opts: { mask?: number } = {}): QrMatrix {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  if (bytes.length === 0) throw new Error('nothing to encode');
  const version = versionFor(bytes.length);
  if (version === 0) throw new Error(`too long for a QR code: ${bytes.length} bytes, the most is ${byteCapacity(40)}`);
  const sym = new QrSymbol(version);
  sym.drawFunctionPatterns();
  sym.drawCodewords(codewords(bytes, version));
  let best = opts.mask ?? 0;
  if (opts.mask === undefined) {
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      sym.applyMask(mask);
      sym.drawFormatBits(mask);
      const score = penaltyScore({ size: sym.size, version, modules: sym.modules });
      if (score < bestScore) {
        bestScore = score;
        best = mask;
      }
      sym.applyMask(mask); // undo
    }
  } else if (!Number.isInteger(opts.mask) || opts.mask < 0 || opts.mask > 7) {
    throw new Error(`mask pattern ${opts.mask} is not 0 to 7`);
  }
  sym.applyMask(best);
  sym.drawFormatBits(best);
  return { size: sym.size, version, modules: sym.modules };
}

export interface QrSvgOptions {
  /** Pixels per module (the SVG's intrinsic size; it scales as any SVG). */
  module?: number;
  /** Quiet zone in modules on every side; the standard asks four. */
  quiet?: number;
  dark?: string;
  light?: string;
  /** A `class` for the `<svg>`, for the page's own sizing. */
  className?: string;
  /** What the code is, for screen readers; the payload is not read out. */
  label?: string;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** `text` as an inline SVG string: a light square with the dark modules as
 *  one path, `shape-rendering="crispEdges"` so modules stay square at any
 *  size. The viewBox is in modules, so `module` only sets the default size. */
export function qrSvg(text: string | Uint8Array, opts: QrSvgOptions = {}): string {
  const { size, modules } = qrMatrix(text);
  const module = opts.module ?? 4;
  const quiet = opts.quiet ?? 4;
  const dark = opts.dark ?? '#000';
  const light = opts.light ?? '#fff';
  const side = size + quiet * 2;
  const px = side * module;
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!modules[y * size + x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && modules[y * size + x + run]) run++;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const cls = opts.className ? ` class="${escapeAttr(opts.className)}"` : '';
  const label = opts.label ? ` role="img" aria-label="${escapeAttr(opts.label)}"` : ' aria-hidden="true"';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${px}" height="${px}"` +
    ` shape-rendering="crispEdges"${cls}${label}>` +
    `<rect width="${side}" height="${side}" fill="${escapeAttr(light)}"/>` +
    `<path d="${d}" fill="${escapeAttr(dark)}"/></svg>`
  );
}
