/**
 * 🏮 Lantern Road's picture (games/lanternRoad.ts): the night street, the
 * four players, the yokai, and the score panel, drawn with Canvas2D onto
 * the double-wide cabinet's screen.
 *
 * The game is 512×192 game pixels (8:3), the two tubes side by side; the
 * screen canvas is twice that, so every game pixel is a 2×2 block, and the
 * tube's CRT pass (arcadeCrt.ts) draws one scanline per game row. The
 * picture is only ever read off the state, never written back: every page
 * draws the same frame the same way, and a far-off watcher can skip frames.
 *
 * Sprites are tiny pixel maps in strings (one character per pixel, a
 * palette per character), each drawn once into a sprite sheet canvas per
 * colourway and blitted after that. The sky, the far hills and the town
 * behind the street are drawn once too and scrolled at their own pace.
 */

import {
  DYING_FRAMES, LR_COLS, LR_GATE_COL, LR_MAP, LR_PLAYER_H, LR_PLAYER_W, LR_ROWS, LR_SEATS, LR_TILE, LR_VIEW_H,
  LR_VIEW_W, MAX_HP, SUB, SWING_FRAMES, enemyBox, isLedge, isSolid, type LrEnemy, type LrPlayer, type LrState,
} from './games/lanternRoad';

/** The screen canvas the picture is drawn for (2× the game). */
export const LR_CANVAS_W = LR_VIEW_W * 2;
export const LR_CANVAS_H = LR_VIEW_H * 2;

/** The four seats' colours: the double-wide cabinet's panels, left to right. */
export const SEAT_COLOURS: readonly { main: string; dark: string; light: string }[] = [
  { main: '#ff3b3b', dark: '#a3162a', light: '#ff9a8a' },
  { main: '#3b8bff', dark: '#1d4fa8', light: '#9cc4ff' },
  { main: '#2fe6a0', dark: '#138a5c', light: '#a6f5d6' },
  { main: '#ffd23b', dark: '#b88a10', light: '#fff0a8' },
];

const FONT = "'SF Mono','Consolas','Monaco',monospace";
const INK = '#160c1e';

// ── Sprites ──────────────────────────────────────────────────────────────────

/** A player, facing right, 16×24: the head and body, then the legs. */
const PLAYER_TOP = [
  '................',
  '.....kkkkkk.....',
  '....kccccccck...',
  '...kccccccccck..',
  '.wwkwwwwwwwwwk..',
  'w..kcsssssssck..',
  '...kcssskssskck.',
  '...kcsssssssck..',
  '....kcsssssck...',
  '.....kkkkkkk....',
  '....kdcccccdk...',
  '...kdccccccdsk..',
  '..ksdccccccdssk.',
  '..kskbbbbbbkkk..',
  '...kdccccccdk...',
  '...kddcccdddk...',
];
const LEGS: Readonly<Record<'stand' | 'stride' | 'pass' | 'jump', readonly string[]>> = {
  stand: [
    '....kdddkdddk...',
    '....kddk.kddk...',
    '....kddk.kddk...',
    '....kddk.kddk...',
    '....kffk.kffk...',
    '...kfffk.kfffk..',
    '...kkkkk.kkkkk..',
    '................',
  ],
  stride: [
    '....kdddkdddk...',
    '...kddk...kddk..',
    '...kddk...kddk..',
    '..kddk.....kddk.',
    '..kffk.....kffk.',
    '.kfffk.....kfffk',
    '.kkkkk.....kkkkk',
    '................',
  ],
  pass: [
    '....kdddkdddk...',
    '.....kddddk.....',
    '.....kddddk.....',
    '....kddkkddk....',
    '....kffk.kffk...',
    '...kfffk.kfffk..',
    '...kkkkk.kkkkk..',
    '................',
  ],
  jump: [
    '....kddddddk....',
    '...kddk..kddk...',
    '..kddk....kffk..',
    '..kffk....kkkk..',
    '..kkkk..........',
    '................',
    '................',
    '................',
  ],
};

const ONI_TOP = [
  '..k.........k...',
  '.kwk.......kwk..',
  '.kwkkkkkkkkkwk..',
  '..krrrrrrrrrk...',
  '.krrrrrrrrrrrk..',
  '.krrrwwkrrwwkrk.',
  '.krrrwkkrrwkkrk.',
  '.krrrrrrrrrrrk..',
  '.krrkwkwkwkwrk..',
  '..krrkkkkkkrrk..',
  '...kyyyyyyyyk...',
  '...kykykykyk....',
];
const ONI_LEGS = [
  [
    '...krrk..krrk...',
    '...krrk..krrk...',
    '..krrrk..krrrk..',
    '..kkkkk..kkkkk..',
  ],
  [
    '...krrkkrrk.....',
    '...krrkkrrk.....',
    '..krrrkkrrrk....',
    '..kkkkkkkkkk....',
  ],
];

const LANTERN = [
  '......kkkk......',
  '.....kbbbbk.....',
  '...kkkkkkkkkk...',
  '..kppppppppppk..',
  '.kqqqqqqqqqqqqk.',
  '.kppkkkpppppppk.',
  '.kpkwwwkppppppk.',
  '.kqkwkwkqqqqqqk.',
  '.kpkwwwkppppppk.',
  '.kppkkkpppppppk.',
  '.kqqqqqqqkkkqqk.',
  '.kpppppppkttkpk.',
  '..kppppppkttkk..',
  '...kkkkkkkttk...',
  '.....kbbbbk.ttk.',
  '......kkkk..kk..',
];

const KASA = [
  '.......kk.......',
  '......kuuk......',
  '.....kuvuuk.....',
  '....kuuvuuuk....',
  '...kuuuvuuuuk...',
  '..kuuukkkuuuuk..',
  '.kuuukwwwkuuuuk.',
  '.kuuukwkwkuuuuk.',
  'kuuuukwwwkuuuuuk',
  'kuuuuukkkuuuuuuk',
  'kvvvvkttkvvvvvvk',
  'kkkkkkttkkkkkkkk',
  '......ktk.......',
  '.......kk.......',
  '.......kk.......',
  '.......ss.......',
  '.......ss.......',
  '......kssk......',
  '.....kggggk.....',
  '.....kkkkkk.....',
];

/** Every sprite map, for the tests: rows of one width, known characters. */
export const SPRITE_MAPS: Readonly<Record<string, readonly string[]>> = {
  player: [...PLAYER_TOP, ...LEGS.stand],
  playerStride: [...PLAYER_TOP, ...LEGS.stride],
  playerPass: [...PLAYER_TOP, ...LEGS.pass],
  playerJump: [...PLAYER_TOP, ...LEGS.jump],
  oni: [...ONI_TOP, ...ONI_LEGS[0]!],
  oniStep: [...ONI_TOP, ...ONI_LEGS[1]!],
  lantern: LANTERN,
  kasa: KASA,
};

type Palette = Readonly<Record<string, string>>;

const BASE: Palette = {
  k: INK,
  s: '#f7cfa6',
  w: '#fff4e0',
  b: '#6b4426',
  f: '#4a3324',
  r: '#e0453a',
  y: '#f2c230',
  p: '#ffd9a0',
  q: '#f0a860',
  t: '#ff4f6d',
  u: '#8a4bd6',
  v: '#5a2c99',
  g: '#a8743c',
};

/** One sprite drawn into its own small canvas, facing right and left. */
interface Sprite {
  right: HTMLCanvasElement;
  left: HTMLCanvasElement;
  w: number;
  h: number;
}

const spriteCache = new Map<string, Sprite>();

function sprite(key: string, rows: readonly string[], palette: Palette): Sprite {
  let s = spriteCache.get(key);
  if (s) return s;
  const w = rows[0]!.length;
  const h = rows.length;
  const make = (flip: boolean) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    for (let y = 0; y < h; y++) {
      const row = rows[y]!;
      for (let x = 0; x < w; x++) {
        const colour = palette[row[x]!];
        if (!colour) continue;
        g.fillStyle = colour;
        g.fillRect(flip ? w - 1 - x : x, y, 1, 1);
      }
    }
    return c;
  };
  s = { right: make(false), left: make(true), w, h };
  spriteCache.set(key, s);
  return s;
}

const seatPalette = (seat: number): Palette => {
  const c = SEAT_COLOURS[seat]!;
  return { ...BASE, c: c.main, d: c.dark };
};

// ── The backdrop: drawn once, scrolled ───────────────────────────────────────

interface Backdrop {
  sky: HTMLCanvasElement;
  hills: HTMLCanvasElement;
  town: HTMLCanvasElement;
}

let backdrop: Backdrop | null = null;

/** A repeatable pseudo-random number from a seed (for the scenery only). */
const hash = (n: number): number => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function buildBackdrop(): Backdrop {
  // The dusk sky, the stars and the moon: fixed behind everything.
  const [sky, s] = canvas(LR_VIEW_W, LR_VIEW_H);
  const grad = s.createLinearGradient(0, 0, 0, LR_VIEW_H);
  grad.addColorStop(0, '#0b0826');
  grad.addColorStop(0.45, '#2a1650');
  grad.addColorStop(0.75, '#6b2a5e');
  grad.addColorStop(1, '#c8586a');
  s.fillStyle = grad;
  s.fillRect(0, 0, LR_VIEW_W, LR_VIEW_H);
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(hash(i * 3 + 1) * LR_VIEW_W);
    const y = Math.floor(hash(i * 3 + 2) * LR_VIEW_H * 0.55);
    s.fillStyle = hash(i * 3 + 3) > 0.8 ? '#fff6d8' : 'rgba(255,240,220,0.55)';
    s.fillRect(x, y, 1, 1);
  }
  const moon = s.createRadialGradient(392, 44, 4, 392, 44, 46);
  moon.addColorStop(0, 'rgba(255,236,190,0.45)');
  moon.addColorStop(1, 'rgba(255,236,190,0)');
  s.fillStyle = moon;
  s.fillRect(330, 0, 130, 100);
  s.fillStyle = '#ffeec2';
  s.beginPath();
  s.arc(392, 44, 17, 0, Math.PI * 2);
  s.fill();
  s.fillStyle = 'rgba(214,190,150,0.55)';
  for (const [x, y, r] of [[386, 38, 4], [398, 50, 3], [395, 36, 2]] as const) {
    s.beginPath();
    s.arc(x, y, r, 0, Math.PI * 2);
    s.fill();
  }

  // Far hills with one snowy peak: 512 wide, repeating.
  const [hills, h] = canvas(LR_VIEW_W, LR_VIEW_H);
  h.fillStyle = '#3a1f5c';
  h.beginPath();
  h.moveTo(0, LR_VIEW_H);
  for (let x = 0; x <= LR_VIEW_W; x += 8) {
    const y = 118 - 14 * Math.sin((x / LR_VIEW_W) * Math.PI * 4) - 8 * Math.sin((x / LR_VIEW_W) * Math.PI * 10 + 1);
    h.lineTo(x, y);
  }
  h.lineTo(LR_VIEW_W, LR_VIEW_H);
  h.fill();
  // The big mountain.
  h.fillStyle = '#4b2a72';
  h.beginPath();
  h.moveTo(120, LR_VIEW_H);
  h.lineTo(228, 62);
  h.lineTo(250, 58);
  h.lineTo(272, 62);
  h.lineTo(390, LR_VIEW_H);
  h.fill();
  h.fillStyle = '#efe6ff';
  h.beginPath();
  h.moveTo(228, 62);
  h.lineTo(250, 58);
  h.lineTo(272, 62);
  h.lineTo(286, 80);
  h.lineTo(276, 76);
  h.lineTo(266, 84);
  h.lineTo(254, 76);
  h.lineTo(242, 85);
  h.lineTo(232, 76);
  h.lineTo(214, 80);
  h.fill();

  // The town behind the street: roofs, a pagoda, warm windows. Repeating.
  const [town, t] = canvas(LR_VIEW_W, LR_VIEW_H);
  const base = 160;
  let x = 0;
  let n = 0;
  while (x < LR_VIEW_W) {
    const w = 40 + Math.floor(hash(n * 7 + 11) * 36);
    const hgt = 26 + Math.floor(hash(n * 7 + 12) * 22);
    const top = base - hgt;
    t.fillStyle = '#24163d';
    t.fillRect(x, top, w, hgt);
    // A tiled roof with upturned ends.
    t.fillStyle = '#1a1030';
    t.beginPath();
    t.moveTo(x - 6, top + 2);
    t.lineTo(x + 4, top - 10);
    t.lineTo(x + w - 4, top - 10);
    t.lineTo(x + w + 6, top + 2);
    t.lineTo(x + w + 6, top);
    t.lineTo(x + w - 2, top - 6);
    t.lineTo(x + 2, top - 6);
    t.lineTo(x - 6, top);
    t.fill();
    // Paper windows, some lit.
    for (let wx = x + 5; wx + 8 < x + w - 4; wx += 13) {
      const lit = hash(n * 31 + wx) > 0.35;
      t.fillStyle = lit ? '#ffb85c' : '#3a2a52';
      t.fillRect(wx, top + 8, 8, 9);
      t.fillStyle = lit ? '#e08a3a' : '#2c1f42';
      t.fillRect(wx + 3, top + 8, 1, 9);
      t.fillRect(wx, top + 12, 8, 1);
    }
    x += w + 10;
    n++;
  }
  // A five-roofed pagoda.
  const px = 300;
  t.fillStyle = '#1e1234';
  t.fillRect(px - 3, 18, 6, 12);
  for (let i = 0; i < 5; i++) {
    const y = 30 + i * 22;
    const half = 14 + i * 4;
    t.fillStyle = '#24163d';
    t.fillRect(px - half + 6, y, (half - 6) * 2, 22);
    t.fillStyle = '#1a1030';
    t.beginPath();
    t.moveTo(px - half - 6, y + 4);
    t.lineTo(px - half + 2, y - 2);
    t.lineTo(px + half - 2, y - 2);
    t.lineTo(px + half + 6, y + 4);
    t.fill();
    t.fillStyle = '#ffb85c';
    t.fillRect(px - 2, y + 9, 4, 6);
  }
  t.fillStyle = '#24163d';
  t.fillRect(0, base, LR_VIEW_W, LR_VIEW_H - base);
  return { sky, hills, town };
}

/** A layer that repeats every 512 px, scrolled to `offset`. */
function scrolled(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, offset: number, y = 0): void {
  const o = ((Math.floor(offset) % LR_VIEW_W) + LR_VIEW_W) % LR_VIEW_W;
  ctx.drawImage(layer, -o, y);
  ctx.drawImage(layer, LR_VIEW_W - o, y);
}

// ── Tiles ────────────────────────────────────────────────────────────────────

const tileCache = new Map<string, HTMLCanvasElement>();

function tile(kind: string): HTMLCanvasElement {
  let c = tileCache.get(kind);
  if (c) return c;
  const [cv, g] = canvas(LR_TILE, LR_TILE);
  c = cv;
  const T = LR_TILE;
  const dot = (x: number, y: number, colour: string) => {
    g.fillStyle = colour;
    g.fillRect(x, y, 1, 1);
  };
  if (kind === 'top' || kind === 'dirt') {
    g.fillStyle = '#5a3a2c';
    g.fillRect(0, 0, T, T);
    for (let i = 0; i < 10; i++) dot(Math.floor(hash(i + 99) * T), Math.floor(hash(i + 199) * T), '#6e4a36');
    for (let i = 0; i < 6; i++) dot(Math.floor(hash(i + 299) * T), Math.floor(hash(i + 399) * T), '#462c22');
    if (kind === 'top') {
      // A stone kerb along the street.
      g.fillStyle = '#9a8f9e';
      g.fillRect(0, 0, T, 4);
      g.fillStyle = '#c7bdc9';
      g.fillRect(0, 0, T, 1);
      g.fillStyle = '#6a5f70';
      g.fillRect(0, 4, T, 1);
      g.fillRect(7, 1, 1, 3);
      g.fillRect(15, 1, 1, 3);
    }
  } else if (kind === '=') {
    // A vermilion bridge: deck planks and a rail.
    g.fillStyle = '#7a3a24';
    g.fillRect(0, 0, T, 5);
    g.fillStyle = '#a65a34';
    g.fillRect(0, 0, T, 2);
    g.fillStyle = '#5a2a1a';
    g.fillRect(0, 5, T, 1);
    g.fillRect(4, 0, 1, 5);
    g.fillRect(12, 0, 1, 5);
    g.fillStyle = '#d23a2a';
    g.fillRect(0, 6, T, 2);
    g.fillRect(2, 8, 2, 8);
    g.fillRect(12, 8, 2, 8);
    g.fillStyle = 'rgba(0,0,0,0)';
  } else if (kind === '^') {
    // Kawara roof tiles: rows of round ends under a ridge.
    g.fillStyle = '#2e3a5e';
    g.fillRect(0, 0, T, T);
    g.fillStyle = '#4a5a86';
    g.fillRect(0, 0, T, 2);
    for (let y = 3; y < T; y += 4) {
      for (let x = (y >> 2) & 1 ? 0 : 2; x < T; x += 4) {
        g.fillStyle = '#3c4a74';
        g.fillRect(x, y, 3, 3);
        g.fillStyle = '#1e2640';
        g.fillRect(x, y + 3, 3, 1);
      }
    }
  } else if (kind === 'B') {
    // A sake barrel, bound with rope.
    g.fillStyle = '#b07a44';
    g.fillRect(1, 0, T - 2, T);
    g.fillStyle = '#8a5a30';
    g.fillRect(1, 0, 2, T);
    g.fillRect(T - 3, 0, 2, T);
    g.fillStyle = '#d8c09a';
    g.fillRect(1, 2, T - 2, 2);
    g.fillRect(1, T - 4, T - 2, 2);
    g.fillStyle = '#f2ecdf';
    g.fillRect(5, 6, 6, 5);
    g.fillStyle = INK;
    g.fillRect(7, 7, 2, 3);
    g.fillRect(0, 0, 1, T);
    g.fillRect(T - 1, 0, 1, T);
  }
  tileCache.set(kind, c);
  return c;
}

// ── Scenery on the street ────────────────────────────────────────────────────

function drawLantern(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const sway = Math.sin(t / 40 + x) * 1.5;
  ctx.strokeStyle = '#2a1a1a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 8, 0);
  ctx.lineTo(x + 8 + sway, y);
  ctx.stroke();
  const glow = ctx.createRadialGradient(x + 8 + sway, y + 9, 2, x + 8 + sway, y + 9, 26);
  glow.addColorStop(0, 'rgba(255,170,80,0.45)');
  glow.addColorStop(1, 'rgba(255,170,80,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x - 20 + sway, y - 18, 56, 56);
  ctx.fillStyle = INK;
  ctx.fillRect(x + 4 + sway, y, 8, 2);
  ctx.fillRect(x + 4 + sway, y + 16, 8, 2);
  ctx.fillStyle = '#e8382a';
  ctx.fillRect(x + 2 + sway, y + 2, 12, 14);
  ctx.fillStyle = '#ff7a4a';
  ctx.fillRect(x + 4 + sway, y + 3, 4, 12);
  ctx.fillStyle = '#a81e1e';
  for (let r = 5; r < 16; r += 4) ctx.fillRect(x + 2 + sway, y + r, 12, 1);
}

function drawStoneLantern(ctx: CanvasRenderingContext2D, x: number, groundY: number): void {
  const grey = '#8a8296';
  const dark = '#5c5468';
  ctx.fillStyle = dark;
  ctx.fillRect(x + 3, groundY - 4, 10, 4);
  ctx.fillStyle = grey;
  ctx.fillRect(x + 6, groundY - 16, 4, 12);
  ctx.fillRect(x + 2, groundY - 20, 12, 4);
  ctx.fillStyle = '#ffcf70';
  ctx.fillRect(x + 4, groundY - 27, 8, 7);
  ctx.fillStyle = grey;
  ctx.fillRect(x + 3, groundY - 27, 2, 7);
  ctx.fillRect(x + 11, groundY - 27, 2, 7);
  ctx.fillStyle = dark;
  ctx.fillRect(x, groundY - 31, 16, 4);
  ctx.fillStyle = grey;
  ctx.fillRect(x + 6, groundY - 34, 4, 3);
}

/** The shrine gate (a torii) standing over column `col`. */
function drawGate(ctx: CanvasRenderingContext2D, x: number, groundY: number): void {
  const red = '#e0342a';
  const dark = '#9a1e1a';
  ctx.fillStyle = dark;
  ctx.fillRect(x - 26, groundY - 6, 10, 6);
  ctx.fillRect(x + 22, groundY - 6, 10, 6);
  ctx.fillStyle = red;
  ctx.fillRect(x - 24, groundY - 96, 6, 92);
  ctx.fillRect(x + 24, groundY - 96, 6, 92);
  ctx.fillRect(x - 32, groundY - 78, 68, 6);
  ctx.fillStyle = INK;
  ctx.fillRect(x - 40, groundY - 102, 84, 6);
  ctx.fillStyle = red;
  ctx.fillRect(x - 36, groundY - 96, 76, 6);
  // The tablet.
  ctx.fillStyle = '#2a1a1a';
  ctx.fillRect(x - 4, groundY - 90, 14, 12);
  ctx.fillStyle = '#ffd36a';
  ctx.fillRect(x - 2, groundY - 88, 10, 8);
}

function drawWater(ctx: CanvasRenderingContext2D, x: number, t: number): void {
  const top = (LR_ROWS - 2) * LR_TILE + 6;
  ctx.fillStyle = '#1c2a5a';
  ctx.fillRect(x, top, LR_TILE, LR_VIEW_H - top);
  ctx.fillStyle = '#2e4a8a';
  ctx.fillRect(x, top, LR_TILE, 2);
  ctx.fillStyle = 'rgba(255,214,140,0.5)';
  const k = Math.floor(t / 10 + x / 16) % 4;
  ctx.fillRect(x + k * 3, top + 5 + (k & 1) * 4, 5, 1);
}

// ── Players and enemies ──────────────────────────────────────────────────────

function legsFor(p: LrPlayer): keyof typeof LEGS {
  if (!p.ground) return 'jump';
  if (p.vx === 0) return 'stand';
  return (p.step >> 3) & 1 ? 'stride' : 'pass';
}

/** The staff: across the back at rest, then up, out and down in a swing. */
function drawStaff(ctx: CanvasRenderingContext2D, p: LrPlayer, sx: number, sy: number): void {
  const f = p.face;
  const hand = { x: sx + (f > 0 ? 12 : 3), y: sy + 12 };
  let ang: number; // radians from pointing forward, up is negative
  let len = 20;
  if (p.swing === 0) {
    ang = -2.2; // over the shoulder, pointing back and up
  } else {
    const into = SWING_FRAMES - p.swing;
    if (into < 4) ang = -2.2 + (into / 4) * 0.9;
    else if (into < 11) ang = -1.3 + ((into - 4) / 7) * 1.9;
    else ang = 0.6;
    len = into >= 4 && into < 11 ? 24 : 20;
  }
  const dx = Math.cos(ang) * len * f;
  const dy = Math.sin(ang) * len;
  ctx.strokeStyle = '#3a2414';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hand.x - dx * 0.25, hand.y - dy * 0.25);
  ctx.lineTo(hand.x + dx, hand.y + dy);
  ctx.stroke();
  ctx.strokeStyle = '#c08a4a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (p.swing > 0) {
    const into = SWING_FRAMES - p.swing;
    if (into >= 4 && into < 11) {
      // The swoosh.
      ctx.strokeStyle = 'rgba(255,250,230,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const cx = hand.x;
      const cy = hand.y;
      const a0 = -1.3;
      const a1 = -1.3 + ((into - 4) / 7) * 1.9;
      for (let i = 0; i <= 8; i++) {
        const a = a0 + ((a1 - a0) * i) / 8;
        const px = cx + Math.cos(a) * (len + 2) * f;
        const py = cy + Math.sin(a) * (len + 2);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, s: LrState, seat: number, cam: number): void {
  const p = s.players[seat]!;
  if (!p.on) return;
  const sx = Math.round(p.x / SUB) - cam - 3;
  const sy = Math.round(p.y / SUB) - 2;
  if (p.ko > 0) {
    // Knocked out: their spirit floats up, see-through, until they're back.
    const rise = Math.min(30, (180 - p.ko) / 3);
    ctx.globalAlpha = 0.35 + 0.15 * Math.sin(s.frame / 6);
    const spr = sprite(`p${seat}:jump`, SPRITE_MAPS.playerJump!, seatPalette(seat));
    ctx.drawImage(p.face > 0 ? spr.right : spr.left, sx, sy - rise);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff6c8';
    for (let i = 0; i < 3; i++) {
      const a = s.frame / 10 + (i * Math.PI * 2) / 3;
      ctx.fillRect(sx + 8 + Math.cos(a) * 9, sy - rise + 2 + Math.sin(a) * 3, 2, 2);
    }
    return;
  }
  if (p.hurt > 0 && (s.frame >> 2) & 1) return; // blinking
  const legs = legsFor(p);
  const key = legs === 'stand' ? 'player' : legs === 'stride' ? 'playerStride' : legs === 'pass' ? 'playerPass' : 'playerJump';
  const spr = sprite(`p${seat}:${key}`, SPRITE_MAPS[key]!, seatPalette(seat));
  if (p.swing === 0) drawStaff(ctx, p, sx, sy);
  ctx.drawImage(p.face > 0 ? spr.right : spr.left, sx, sy);
  if (p.swing > 0) drawStaff(ctx, p, sx, sy);
}

function drawEnemy(ctx: CanvasRenderingContext2D, e: LrEnemy, s: LrState, cam: number): void {
  if (e.gone) return;
  const box = enemyBox(e.kind);
  const bx = Math.round(e.x / SUB) - cam;
  const by = Math.round(e.y / SUB);
  if (bx < -32 || bx > LR_VIEW_W + 32) return;
  if (e.dying > 0) {
    // A puff of smoke.
    const k = DYING_FRAMES - e.dying;
    ctx.fillStyle = `rgba(240,230,255,${(e.dying / DYING_FRAMES) * 0.8})`;
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5;
      ctx.beginPath();
      ctx.arc(bx + box.w / 32 + Math.cos(a) * k * 0.6, by + box.h / 32 + Math.sin(a) * k * 0.4, 3 + k / 6, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (e.stun > 0 && (s.frame >> 1) & 1) ctx.globalAlpha = 0.5;
  let spr: Sprite;
  if (e.kind === 'oni') {
    const stepping = e.vx !== 0 && (e.t >> 4) & 1;
    spr = sprite(stepping ? 'oniStep' : 'oni', SPRITE_MAPS[stepping ? 'oniStep' : 'oni']!, BASE);
    ctx.drawImage(e.face > 0 ? spr.right : spr.left, bx - 2, by);
  } else if (e.kind === 'lantern') {
    const glow = ctx.createRadialGradient(bx + 6, by + 7, 2, bx + 6, by + 7, 22);
    glow.addColorStop(0, 'rgba(255,190,110,0.35)');
    glow.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(bx - 16, by - 15, 44, 44);
    spr = sprite('lantern', LANTERN, BASE);
    ctx.drawImage(e.face > 0 ? spr.left : spr.right, bx - 2, by - 1);
  } else {
    spr = sprite('kasa', KASA, BASE);
    ctx.drawImage(e.face > 0 ? spr.left : spr.right, bx - 2, by - 2);
  }
  ctx.globalAlpha = 1;
}

function drawItems(ctx: CanvasRenderingContext2D, s: LrState, cam: number): void {
  for (const it of s.items) {
    if (it.taken) continue;
    const x = it.x / SUB - cam;
    const y = it.y / SUB + Math.sin(s.frame / 12 + it.x) * 1.5;
    if (x < -10 || x > LR_VIEW_W + 10) continue;
    if (it.kind === 'coin') {
      // A mon: a round coin with a square hole.
      const squash = Math.abs(Math.cos(s.frame / 14 + it.x / 50));
      ctx.fillStyle = '#7a5a10';
      ctx.fillRect(x - 4 * squash - 1, y - 5, 8 * squash + 2, 10);
      ctx.fillStyle = '#ffd34a';
      ctx.fillRect(x - 4 * squash, y - 4, 8 * squash, 8);
      ctx.fillStyle = '#fff2a0';
      ctx.fillRect(x - 4 * squash, y - 4, Math.max(1, 2 * squash), 3);
      if (squash > 0.4) {
        ctx.fillStyle = '#5a3a08';
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    } else {
      // A rice ball with its nori.
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x + 7, y + 5);
      ctx.lineTo(x - 7, y + 5);
      ctx.fill();
      ctx.fillStyle = '#fbf8f0';
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y + 4);
      ctx.lineTo(x - 6, y + 4);
      ctx.fill();
      ctx.fillStyle = '#1c3a26';
      ctx.fillRect(x - 3, y, 6, 5);
    }
  }
}

// ── The score panel and the cards ────────────────────────────────────────────

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, colour: string, align: CanvasTextAlign = 'left'): void {
  ctx.font = `bold ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.fillText(s, x + 1, y + 1);
  ctx.fillStyle = colour;
  ctx.fillText(s, x, y);
}

function heart(ctx: CanvasRenderingContext2D, x: number, y: number, full: boolean): void {
  ctx.fillStyle = full ? '#ff4f6d' : 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, y + 1, 2, 2);
  ctx.fillRect(x + 3, y + 1, 2, 2);
  ctx.fillRect(x, y + 2, 5, 2);
  ctx.fillRect(x + 1, y + 4, 3, 1);
  ctx.fillRect(x + 2, y + 5, 1, 1);
  if (full) {
    ctx.fillStyle = '#ffc0cc';
    ctx.fillRect(x + 1, y + 1, 1, 1);
  }
}

function drawPanel(ctx: CanvasRenderingContext2D, s: LrState): void {
  ctx.fillStyle = 'rgba(8,4,18,0.55)';
  ctx.fillRect(0, 0, LR_VIEW_W, 13);
  for (let seat = 0; seat < LR_SEATS; seat++) {
    const p = s.players[seat]!;
    const c = SEAT_COLOURS[seat]!;
    const x = seat * 128 + 6;
    text(ctx, `${seat + 1}P`, x, 10, 9, c.main);
    if (!p.on) {
      if ((s.frame >> 5) & 1) text(ctx, 'STEP UP!', x + 22, 10, 8, 'rgba(255,240,220,0.7)');
      continue;
    }
    if (p.ko > 0) {
      text(ctx, `KO ${Math.ceil(p.ko / 60)}`, x + 22, 10, 8, '#ffc0cc');
    } else {
      for (let i = 0; i < MAX_HP; i++) heart(ctx, x + 22 + i * 7, 3, i < p.hp);
    }
    text(ctx, String(p.score).padStart(6, '0'), x + 116, 10, 9, '#fff4e0', 'right');
  }
}

function drawPops(ctx: CanvasRenderingContext2D, s: LrState, cam: number): void {
  for (const pop of s.pops) {
    ctx.globalAlpha = Math.min(1, pop.t / 12);
    text(ctx, `+${pop.points}`, pop.x / SUB - cam, pop.y / SUB, 8, SEAT_COLOURS[pop.seat]!.light, 'center');
  }
  ctx.globalAlpha = 1;
}

function drawClear(ctx: CanvasRenderingContext2D, s: LrState): void {
  ctx.fillStyle = 'rgba(10,4,24,0.6)';
  ctx.fillRect(0, 40, LR_VIEW_W, 100);
  text(ctx, 'STAGE CLEAR!', LR_VIEW_W / 2, 74, 22, '#ffd36a', 'center');
  text(ctx, `THE SHRINE GATE · LAP ${s.laps + 1}`, LR_VIEW_W / 2, 92, 9, '#fff4e0', 'center');
  const on = s.players.map((p, seat) => ({ p, seat })).filter(({ p }) => p.on);
  on.forEach(({ p, seat }, i) => {
    const x = LR_VIEW_W / 2 + (i - (on.length - 1) / 2) * 110;
    text(ctx, `${seat + 1}P ${String(p.score).padStart(6, '0')}`, x, 120, 10, SEAT_COLOURS[seat]!.main, 'center');
  });
}

// ── The frame ────────────────────────────────────────────────────────────────

/**
 * Draw the state onto a `w`×`h` canvas context (the cabinet's screen, 2×
 * the game). Leaves the context's transform as it found it.
 */
export function paintLanternRoad(ctx: CanvasRenderingContext2D, s: LrState, w = LR_CANVAS_W, h = LR_CANVAS_H): void {
  backdrop ??= buildBackdrop();
  ctx.save();
  ctx.setTransform(w / LR_VIEW_W, 0, 0, h / LR_VIEW_H, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const cam = s.cam;
  const t = s.frame;

  ctx.drawImage(backdrop.sky, 0, 0);
  scrolled(ctx, backdrop.hills, cam * 0.15);
  scrolled(ctx, backdrop.town, cam * 0.45);

  const c0 = Math.max(0, Math.floor(cam / LR_TILE) - 4);
  const c1 = Math.min(LR_COLS - 1, Math.ceil((cam + LR_VIEW_W) / LR_TILE) + 4);
  // Water wherever the street gives way.
  for (let col = c0; col <= c1; col++) {
    if (!isSolid(col, LR_ROWS - 1)) drawWater(ctx, col * LR_TILE - cam, t);
  }
  // Scenery behind the players.
  for (let col = c0; col <= c1; col++) {
    for (let row = 0; row < LR_ROWS; row++) {
      const ch = LR_MAP[row]![col];
      const x = col * LR_TILE - cam;
      if (ch === 'l') drawLantern(ctx, x, row * LR_TILE, t);
      else if (ch === 'S') drawStoneLantern(ctx, x, (row + 1) * LR_TILE);
    }
  }
  drawGate(ctx, LR_GATE_COL * LR_TILE - cam + 8, (LR_ROWS - 2) * LR_TILE);
  // The street, bridges, roofs and barrels.
  for (let col = c0; col <= c1; col++) {
    for (let row = 0; row < LR_ROWS; row++) {
      const x = col * LR_TILE - cam;
      const y = row * LR_TILE;
      if (isSolid(col, row)) {
        const ch = LR_MAP[row]![col];
        if (ch === 'B') ctx.drawImage(tile('B'), x, y);
        else ctx.drawImage(tile(isSolid(col, row - 1) && LR_MAP[row - 1]![col] !== 'B' ? 'dirt' : 'top'), x, y);
      } else if (isLedge(col, row)) {
        ctx.drawImage(tile(LR_MAP[row]![col]!), x, y);
      }
    }
  }

  drawItems(ctx, s, cam);
  for (const e of s.enemies) drawEnemy(ctx, e, s, cam);
  for (let seat = 0; seat < LR_SEATS; seat++) drawPlayer(ctx, s, seat, cam);
  drawPops(ctx, s, cam);
  drawPanel(ctx, s);
  if (s.phase === 'clear') drawClear(ctx, s);
  ctx.restore();
}

/** The idle cabinet's card while nobody plays: the title over the street. */
export function paintLanternRoadTitle(ctx: CanvasRenderingContext2D, line: string, blink: boolean, w = LR_CANVAS_W, h = LR_CANVAS_H): void {
  backdrop ??= buildBackdrop();
  ctx.save();
  ctx.setTransform(w / LR_VIEW_W, 0, 0, h / LR_VIEW_H, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(backdrop.sky, 0, 0);
  scrolled(ctx, backdrop.hills, 0);
  scrolled(ctx, backdrop.town, 0);
  for (let col = 0; col < LR_VIEW_W / LR_TILE; col++) {
    ctx.drawImage(tile('top'), col * LR_TILE, (LR_ROWS - 2) * LR_TILE);
    ctx.drawImage(tile('dirt'), col * LR_TILE, (LR_ROWS - 1) * LR_TILE);
  }
  drawLantern(ctx, 120, 30, 0);
  drawLantern(ctx, 376, 30, 0);
  // A dark band so the words read over the town's lit windows.
  const band = ctx.createLinearGradient(0, 52, 0, 142);
  band.addColorStop(0, 'rgba(10,4,24,0)');
  band.addColorStop(0.2, 'rgba(10,4,24,0.72)');
  band.addColorStop(0.8, 'rgba(10,4,24,0.72)');
  band.addColorStop(1, 'rgba(10,4,24,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 52, LR_VIEW_W, 90);
  text(ctx, 'LANTERN ROAD', LR_VIEW_W / 2, 84, 30, '#ffd36a', 'center');
  text(ctx, '1 TO 4 PLAYERS · TOGETHER TO THE SHRINE', LR_VIEW_W / 2, 104, 9, '#fff4e0', 'center');
  if (blink) text(ctx, line, LR_VIEW_W / 2, 132, 12, '#7CFFB0', 'center');
  for (let seat = 0; seat < LR_SEATS; seat++) {
    const spr = sprite(`p${seat}:player`, SPRITE_MAPS.player!, seatPalette(seat));
    ctx.drawImage(spr.right, 196 + seat * 30, (LR_ROWS - 2) * LR_TILE - LR_PLAYER_H / SUB - 2);
  }
  ctx.restore();
}

/** The size of a player's body in game pixels (for the tests). */
export const PLAYER_BOX_PX = { w: LR_PLAYER_W / SUB, h: LR_PLAYER_H / SUB };
