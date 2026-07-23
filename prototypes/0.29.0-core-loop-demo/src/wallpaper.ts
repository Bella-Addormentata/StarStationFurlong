/**
 * 🖼️ Wallpaper presets (#80 S6) — the WALL-COVERING looks a player paints onto
 * an octagon hull surface, reborn from the retired freestanding wall furniture
 * (brick / blue-tile / casino-gold / pool-tile). Each preset resolves to a
 * MeshStandardMaterial SPEC (map + colour + finish) that the hull's `mkMat`
 * layers onto a strip's face — so a wallpapered wall STILL fades with the
 * one-way iso cutaway (updateFacing only touches opacity / visible / transparent,
 * never map / colour). `plain` = no covering (the bare hull colour).
 *
 * Textures are built ONCE and CACHED at module scope: the hull rebuilds on every
 * window / wallpaper edit, so regenerating canvases each time would thrash. They
 * are SHARED and never disposed with a hull (OctagonHull.dispose disposes the
 * per-hull materials only; a material's `.map` texture is left alone).
 *
 * UV convention: the hull's strip geometry carries STRIP-LOCAL UVs in METRES
 * (u = along-extrude metres, v = across-edge metres), so a preset's `repeat` is
 * "tiles per metre" and a wall reads at the same tile scale for any room size.
 */

import * as THREE from 'three';

export type WallpaperPresetId =
  | 'plain'
  | 'blue-tile'
  | 'casino-gold'
  | 'brick'
  | 'pool-tile';

/** Cycle order for the editor — `plain` first (the default / "remove covering"). */
export const WALLPAPER_PRESETS: WallpaperPresetId[] = [
  'plain',
  'blue-tile',
  'casino-gold',
  'brick',
  'pool-tile',
];

/** Human labels for the editor chip. */
export const WALLPAPER_LABELS: Record<WallpaperPresetId, string> = {
  plain: 'Plain hull',
  'blue-tile': 'Blue tile',
  'casino-gold': 'Casino gold',
  brick: 'Brick',
  'pool-tile': 'Pool tile',
};

/** Doc-read guard (wallpaper records cross the peer trust boundary). */
export function isWallpaperPreset(v: unknown): v is WallpaperPresetId {
  return typeof v === 'string' && (WALLPAPER_PRESETS as string[]).includes(v);
}

/**
 * A resolved wallpaper look → the material knobs the hull applies over a strip
 * face. `map` tiles in strip-local metres (see the UV note above). `plain`
 * resolves to `null` (the hull keeps its own colour).
 */
export interface WallpaperSpec {
  map: THREE.Texture;
  color: number;
  roughness: number;
  metalness: number;
}

// ── shared texture cache (never disposed with a hull) ───────────────────────
const texCache = new Map<WallpaperPresetId, THREE.Texture>();

/** Wrap a finished canvas as a repeating, crisp (nearest-filter) tile texture.
 *  `perMetre` = texture repeats per metre of wall (UVs are in metres). */
function tileTexture(cv: HTMLCanvasElement, perMetre: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(perMetre, perMetre);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function newCanvas(w: number, h: number): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return { cv, ctx: cv.getContext('2d')! };
}

// ── canvas art ──────────────────────────────────────────────────────────────

/** 🧊 Calippo-Lido wall: pale sky-blue tiles on white grout (the old octagon-
 *  fallback side-wall look — world.addSideWalls makeBrickTexture). 2×2 cell. */
function makeBlueTileCanvas(): HTMLCanvasElement {
  const { cv, ctx } = newCanvas(64, 64);
  ctx.fillStyle = '#FFFFFF'; // grout
  ctx.fillRect(0, 0, 64, 64);
  const cols = ['#A9CBE9', '#9FC4E5', '#B2D1EC', '#A4C8E7'];
  const cells: Array<[number, number, number]> = [
    [0, 0, 0],
    [32, 0, 1],
    [0, 32, 3],
    [32, 32, 2],
  ];
  for (const [x, y, ci] of cells) {
    ctx.fillStyle = cols[ci];
    ctx.fillRect(x + 2, y + 2, 28, 28);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; // top-left sheen
    ctx.fillRect(x + 2, y + 2, 28, 2);
    ctx.fillRect(x + 2, y + 2, 2, 28);
  }
  return cv;
}

/** 🏊 Pool deck: white / blue-white checker on a whisper-blue grout (the old
 *  furniture.makePoolTileTex deck look). 2×2 cell. */
function makePoolTileCanvas(): HTMLCanvasElement {
  const { cv, ctx } = newCanvas(64, 64);
  ctx.fillStyle = '#D9E8F2'; // grout
  ctx.fillRect(0, 0, 64, 64);
  const cols = ['#FFFFFF', '#EDF5FB', '#FBFDFF', '#EFF6FB'];
  const cells: Array<[number, number, number]> = [
    [0, 0, 0],
    [32, 0, 1],
    [0, 32, 3],
    [32, 32, 2],
  ];
  for (const [x, y, ci] of cells) {
    ctx.fillStyle = cols[ci];
    ctx.fillRect(x + 1, y + 1, 30, 30);
  }
  return cv;
}

/** 🧱 Brick: running-bond brown brick with darker mortar (the old brick-wall /
 *  window-wall furniture colour 0x8a4a3a). 2 rows, offset bond. */
function makeBrickCanvas(): HTMLCanvasElement {
  const { cv, ctx } = newCanvas(64, 64);
  ctx.fillStyle = '#5a3226'; // mortar
  ctx.fillRect(0, 0, 64, 64);
  const brick = '#8a4a3a';
  const shade = '#7a3f31';
  const drawRow = (y: number, offset: number) => {
    for (let i = -1; i < 3; i++) {
      const x = i * 32 + offset;
      ctx.fillStyle = i % 2 === 0 ? brick : shade;
      ctx.fillRect(x + 2, y + 2, 28, 12);
      ctx.fillStyle = 'rgba(255,255,255,0.06)'; // faint top light
      ctx.fillRect(x + 2, y + 2, 28, 2);
    }
  };
  drawRow(0, 0);
  drawRow(16, 16); // half-brick offset (running bond)
  drawRow(32, 0);
  drawRow(48, 16);
  return cv;
}

/** 🎰 Casino gold: an ornate lacquer panel — emerald centre in a gold frame with
 *  pilaster edges and a crystal-gold accent — the flat echo of the retired
 *  casino-gold-wall furniture (palette: gold 0xf1bd4f, emerald 0x07563f,
 *  lacquer 0x140d12, light-gold 0xffdc82). 1 m panel. */
function makeCasinoGoldCanvas(): HTMLCanvasElement {
  const S = 128;
  const { cv, ctx } = newCanvas(S, S);
  ctx.fillStyle = '#140d12'; // lacquer ground
  ctx.fillRect(0, 0, S, S);
  // Gold pilasters down each edge.
  ctx.fillStyle = '#f1bd4f';
  ctx.fillRect(0, 0, 12, S);
  ctx.fillRect(S - 12, 0, 12, S);
  ctx.fillStyle = '#ffdc82';
  ctx.fillRect(3, 0, 3, S);
  ctx.fillRect(S - 6, 0, 3, S);
  // Emerald centre panel in a gold frame.
  ctx.fillStyle = '#f1bd4f';
  ctx.fillRect(24, 16, S - 48, S - 32);
  ctx.fillStyle = '#07563f';
  ctx.fillRect(30, 22, S - 60, S - 44);
  // Crystal-gold diamond accent, centred.
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#ffe8a8';
  ctx.fillRect(-14, -14, 28, 28);
  ctx.fillStyle = '#ffdc82';
  ctx.fillRect(-9, -9, 18, 18);
  ctx.restore();
  return cv;
}

function texFor(id: WallpaperPresetId): THREE.Texture {
  const cached = texCache.get(id);
  if (cached) return cached;
  let tex: THREE.Texture;
  switch (id) {
    case 'blue-tile':
      tex = tileTexture(makeBlueTileCanvas(), 2); // 2 cells/m → ~0.25 m tiles
      break;
    case 'pool-tile':
      tex = tileTexture(makePoolTileCanvas(), 2);
      break;
    case 'brick':
      tex = tileTexture(makeBrickCanvas(), 1.5); // ~0.44 m bricks
      break;
    case 'casino-gold':
      tex = tileTexture(makeCasinoGoldCanvas(), 1); // 1 m panels
      break;
    default:
      throw new Error(`wallpaper: no texture for '${id}'`);
  }
  texCache.set(id, tex);
  return tex;
}

/**
 * Resolve a preset id to its material spec, or `null` for `plain` (no covering →
 * the hull keeps its own colour). Textures are cached + shared. `color` is white
 * so the map's own colours show through unmodulated.
 */
export function resolveWallpaper(id: WallpaperPresetId): WallpaperSpec | null {
  if (id === 'plain') return null;
  switch (id) {
    case 'blue-tile':
      return { map: texFor(id), color: 0xffffff, roughness: 0.85, metalness: 0.03 };
    case 'pool-tile':
      return { map: texFor(id), color: 0xffffff, roughness: 0.86, metalness: 0.03 };
    case 'brick':
      return { map: texFor(id), color: 0xffffff, roughness: 0.92, metalness: 0.02 };
    case 'casino-gold':
      return { map: texFor(id), color: 0xffffff, roughness: 0.35, metalness: 0.55 };
    default:
      return null;
  }
}
