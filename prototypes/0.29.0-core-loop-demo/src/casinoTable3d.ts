/**
 * 🎲🎡 The 3D table pieces (#226) — everything that moves on the craps and
 * roulette tables now that the 2D popups are gone: the live felt (painted
 * from games/casinoLayout.ts, so the print and the click areas are one list),
 * the chips on it, the chips in your rail and in your hand, the oversized
 * dice, the ON/OFF pucks, the roulette wheel and ball, and the ⚙️ button.
 *
 * The furniture builders (furniture.ts) call buildCrapsPieces /
 * buildRoulettePieces and stow the returned handle on the felt mesh's
 * userData.casinoTable; World files it (furnitureHandles.ts) and the session
 * layer (casinoTableSession.ts) drives it from the casino doc every frame —
 * for EVERY client, so spectators see the same chips and dice the players do.
 *
 * VISIBILITY: World resets `mesh.visible` on every furniture mesh each frame
 * (the zoom hide/restore pass), so nothing here hides a MESH. Pieces that come
 * and go sit in their own Group and toggle the GROUP; the chip pools are
 * InstancedMeshes that hide by instance count. Every material starts
 * transparent at opacity 0 like all furniture, so the morph fade raises it.
 *
 * Coordinates are the table's LOCAL frame (x along, z across, y up from the
 * floor) — the pieces are children of the item group, so rotation is free.
 */

import * as THREE from 'three';
import { CHIP_STYLE } from './chipDisplay';
import {
  captionRect, CHIP_RADIUS, CRAPS_DICE_SPOT, crapsPuckSpot, CRAPS_LAYOUT, ROULETTE_LAYOUT, ROULETTE_WHEEL,
} from './games/casinoLayout';
import type {
  CrapsSpot, FeltLayout, FeltPoint, FeltRect, FeltRegion, RouletteSpot,
} from './games/casinoLayout';
import { pocketColor, WHEEL_ORDER } from './games/roulette';

// ── Public handle ────────────────────────────────────────────────────────────

/** What a pointer ray hit on a table, nearest first. */
export type TablePick =
  | { kind: 'felt'; p: FeltPoint }
  | { kind: 'rail'; p: FeltPoint }
  | { kind: 'dice' }
  | { kind: 'settings' }
  | { kind: 'takedown' };

/** One stack of chips on the felt, bottom chip first. */
export interface FeltStack {
  x: number;
  z: number;
  chips: number[];
  /** Another player's chips: drawn a little darker so yours stand out
   *  (value chips only — colour chips already say whose they are). */
  dim: boolean;
  /** Chips already under this stack (odds riding on a flat bet). */
  lift?: number;
  /** Roulette colour chips: the owner's colour (the value stays printed). */
  color?: string;
  /** Whose chips these are and the bet they stand for (its spotKey), for the
   *  settle's sweeps and payouts (crapsSettleShow). Drawing ignores them. */
  pid?: string;
  spot?: string;
}

/** 💰 A settled roll's chips on the move, as the crew moves them
 *  (settleChips): the losing stacks swept into the house first, then each
 *  winner paid out of it onto their rail, with the stakes that come down. */
export interface SettleMoves {
  /** Where the house takes chips in and pays them out: in front of the
   *  stickman. */
  house: FeltPoint;
  /** Losing chips, from where they stood, into the house. */
  lost: FeltStack[];
  /** Stakes coming back (a win that comes down, a push), from where they
   *  stood to `to` on their bettor's rail. `order`: the bettor's place in
   *  the pay-out (one after another, as a dealer pays round the table);
   *  `mine`: the rail is the viewer's. */
  back: Array<{ s: FeltStack; to: FeltPoint; order: number; mine: boolean }>;
  /** Winnings out of the house to `to` on each winner's rail, bottom chip
   *  first. */
  paid: Array<{ chips: number[]; to: FeltPoint; order: number; mine: boolean; dim: boolean; color?: string }>;
}

/** Where a player's chip rail runs: centred at (x, z), along one axis. */
export interface RailSpec {
  x: number;
  z: number;
  axis: 'x' | 'z';
  len: number;
}

/** One stack in the rail (for the drag-across pickup). */
export interface RailStack {
  x: number;
  z: number;
  denom: number;
  count: number;
}

export interface CasinoTableVisualHandle {
  readonly game: 'craps' | 'roulette';
  /** Felt half-extents of the table top's rail (for rails and the camera). */
  readonly halfX: number;
  readonly halfZ: number;
  /** Nearest table piece under the ray (dice only while grabbable). */
  pick(ray: THREE.Raycaster, diceGrabbable: boolean): TablePick | null;
  /** Where the ray crosses the felt's plane (even off the felt), or null. */
  projectToFelt(ray: THREE.Raycaster): FeltPoint | null;
  /** Every stack on the felt (replaces the last set). */
  setFeltChips(stacks: readonly FeltStack[]): void;
  /** The stacks in your rail (laid out by railStacks; [] hides them). */
  setRailStacks(stacks: readonly RailStack[]): void;
  /** Chips you are holding, floating over the felt at `p` (null / [] hides). */
  setHand(p: FeltPoint | null, chips: readonly number[]): void;
  /** Draw your rail and hand as colour chips of this colour (roulette), or
   *  as value chips (null). */
  setOwnChipColor(color: string | null): void;
  /** Light up felt regions by id (winners, the rolled number). */
  setHighlight(ids: ReadonlySet<string>): void;
  /** Glow the ⚙️ button (pointer over it). */
  setSettingsHot(hot: boolean): void;
  /** ↶ Your take-down button on the rail beside your chips, its arrow
   *  pointing back at you along `toward` (null hides it). `ready`: you have
   *  bets that may come down right now (dimmed otherwise). */
  setTakeDown(at: { p: FeltPoint; toward: FeltPoint } | null, ready: boolean): void;
  /** Glow the take-down button (pointer over it). */
  setTakeDownHot(hot: boolean): void;
  /** Sink the take-down button for a moment (it was pressed). */
  pressTakeDown(): void;
  /** Your chips about to leave the felt (a take-down) slide back to `to` on
   *  your rail: the next felt update that drops chips of yours from a stack
   *  sends those chips across, the way a dealer pushes them back. */
  sweepToRail(to: FeltPoint): void;
  /** 💰 Play a settled roll's chip moves (every client: from the shared
   *  settled state, so everyone sees the same sweep and pay-out). Call it
   *  before the felt update that drops the moved chips. */
  settleChips(moves: SettleMoves): void;
  /** Are chips still on their way to the viewer's own rail? */
  payingMe(): boolean;
  /** ⚖️ The plaque beside the ⚙️: a green-circled F (FAIR) or a red-circled F (FRIENDLY). */
  setFairBadge(fair: boolean): void;
  // 🎲 craps
  /** Move both pucks: OFF in the don't come bar, ON on the point. */
  setPuck(point: number | null): void;
  /** Slide the dice to `p` and rest there (values: the faces to show). */
  diceRestAt(p: FeltPoint, values?: [number, number]): void;
  /** The shooter has the dice in hand at `p` (raised, following the cursor). */
  diceHold(p: FeltPoint): void;
  /** Throw from `from` along unit `dir` with `power` 0..1; `seed` keeps the
   *  tumble the same on every client. Faces settle once diceLand arrives. */
  diceThrow(from: FeltPoint, dir: FeltPoint, power: number, seed: number): void;
  /** The settled roll: the flying dice come to rest showing these faces. */
  diceLand(values: [number, number]): void;
  /** A throw that will get no faces (a void roll, or one the table took back
   *  to betting): the dice stop where they are, and the next diceRestAt
   *  slides them home. */
  diceCancel(): void;
  /** 'rest' | 'held' | 'flying' (no faces yet) | 'settling'. */
  diceState(): 'rest' | 'held' | 'flying' | 'settling';
  // 🎡 roulette
  /** Spin the wheel and drop the ball into `result`'s pocket. */
  wheelSpin(result: number, seed: number): void;
  /** Ball resting in `result` (null: ball off the wheel, betting open). */
  wheelRest(result: number | null): void;
  wheelSpinning(): boolean;
  /** Keyboard play's selected box, ringed on the felt (null: none). */
  setFocusRegion(id: string | null): void;
  /** Where a felt point appears on screen, in normalised device coords
   *  (x right, y up, both −1..1), or null when the table isn't placed. */
  toScreen(p: FeltPoint, camera: THREE.Camera): { x: number; y: number } | null;
  /** Is `p` on one of the local player's own stacks on the felt? */
  onMyStack(ray: THREE.Raycaster, p: FeltPoint): FeltPoint | null;
  /** Back to an empty table: no chips, nothing lit, puck off, any throw or
   *  spin dropped — for a room rebind, so nothing carries over. */
  reset(): void;
  /** Per-frame animation; World drives it. */
  update(dt: number): void;
}

/** The slice of furniture.ts's BuildCtx the pieces need. */
export interface PiecesCtx {
  m: (color: number, rough?: number, metal?: number, em?: number, emI?: number) => THREE.MeshStandardMaterial;
  place: (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry?: number) => THREE.Mesh;
  attach: (obj: THREE.Object3D) => void;
}

// ── Shared look ──────────────────────────────────────────────────────────────

/** Felt surface height (both tables). */
export const FELT_Y = 0.812;
/** Top of the padded rail where your chips sit. */
const RAIL_Y = 0.855;
const CHIP_H = 0.0072;
/** Oversized dice (#226) — about five times a real die, so the whole room
 *  can read the roll from across the floor. */
export const DIE_SIZE = 0.085;
const PUCK_R = 0.04;

const FELT_GREEN = '#14532D';
const FELT_LIGHT = '#1B6B3A';
const INK = 'rgba(244, 236, 214, 0.92)';
const LINE = 'rgba(244, 236, 214, 0.78)';

function canvasTexture(cv: HTMLCanvasElement, flipY: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = flipY;
  tex.anisotropy = 4;
  return tex;
}

/** Basic (unlit) canvas-textured material that rides the morph fade. */
function canvasMaterial(cv: HTMLCanvasElement, flipY = true): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map: canvasTexture(cv, flipY), transparent: true, opacity: 0 });
}

function fadeMaterial(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ ...params, transparent: true, opacity: 0 });
}

/** Materials for MULTI-material meshes (chips, dice, pucks, the ⚙️ button)
 *  are plain opaque: World's fade only reaches a mesh's single material, so
 *  an array member left at opacity 0 would never show. These pieces simply
 *  arrive with the table. */
function solidCanvas(cv: HTMLCanvasElement): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map: canvasTexture(cv, true) });
}

// ── Felt painting ────────────────────────────────────────────────────────────

const FELT_PX_PER_M = 760;

interface FeltCanvas {
  cv: HTMLCanvasElement;
  mat: THREE.MeshBasicMaterial;
  repaint(highlight: ReadonlySet<string>, focus?: string | null): void;
}

/** Canvas px for a felt point. The texture is NOT flipped, so canvas-up is +z
 *  (the far rail as seen from the −z side); canvas-left is +x, which is the
 *  left hand of a player on the −z rail facing +z. Captions so read the right
 *  way round, not mirrored, for the players on the −z rail. */
function feltToPx(f: FeltRect, W: number, H: number, x: number, z: number): [number, number] {
  return [((f.x1 - x) / (f.x1 - f.x0)) * W, ((f.z1 - z) / (f.z1 - f.z0)) * H];
}

/** A felt rect as a canvas rect with a positive width and height. */
function rectToPx(f: FeltRect, W: number, H: number, r: FeltRect): { x: number; y: number; w: number; h: number } {
  const [ax, ay] = feltToPx(f, W, H, r.x0, r.z0);
  const [bx, by] = feltToPx(f, W, H, r.x1, r.z1);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

function paintRegion<B>(
  c: CanvasRenderingContext2D, f: FeltRect, W: number, H: number,
  rg: FeltRegion<B>, lit: boolean, focused = false,
): void {
  const k = FELT_PX_PER_M;
  for (const r of rg.frame ? [rg.frame] : rg.rects) {
    const q = rectToPx(f, W, H, r);
    if (rg.fill) {
      c.fillStyle = rg.fill;
      c.fillRect(q.x, q.y, q.w, q.h);
    }
    if (lit) {
      c.fillStyle = 'rgba(255, 214, 102, 0.32)';
      c.fillRect(q.x, q.y, q.w, q.h);
    }
    if (rg.faint && !lit) {
      // An odds band: a dashed hairline inside the box it belongs to.
      c.save();
      c.setLineDash([6, 6]);
      c.lineWidth = 1.5;
      c.strokeStyle = 'rgba(244, 236, 214, 0.45)';
      c.strokeRect(q.x + 5, q.y + 5, q.w - 10, q.h - 10);
      c.restore();
    } else {
      c.lineWidth = lit ? 6 : 3;
      c.strokeStyle = lit ? '#FFD666' : LINE;
      c.strokeRect(q.x + 1.5, q.y + 1.5, q.w - 3, q.h - 3);
    }
    if (focused) {
      // Keyboard play's selected box: a bright dashed ring inside the line.
      c.save();
      c.setLineDash([14, 8]);
      c.lineWidth = 7;
      c.strokeStyle = '#7FE7FF';
      c.strokeRect(q.x + 8, q.y + 8, q.w - 16, q.h - 16);
      c.restore();
    }
  }
  // Caption at the centre of the region's caption rect (its largest, unless
  // the layout names one).
  const main = captionRect(rg);
  const [cx, cy] = feltToPx(f, W, H, (main.x0 + main.x1) / 2, (main.z0 + main.z1) / 2);
  c.save();
  c.translate(cx, cy);
  if (rg.textRot) c.rotate(-rg.textRot);
  if (rg.diamond) {
    const w = (main.x1 - main.x0) * k * 0.32;
    const h = (main.z1 - main.z0) * k * 0.36;
    c.beginPath();
    c.moveTo(0, -h);
    c.lineTo(w, 0);
    c.lineTo(0, h);
    c.lineTo(-w, 0);
    c.closePath();
    c.fillStyle = rg.diamond;
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = LINE;
    c.stroke();
  }
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const size = rg.textSize * k;
  const subSize = Math.max(14, size * 0.42);
  const lift = rg.sub ? subSize * 0.55 : 0;
  if (rg.label) {
    c.font = `900 ${size}px "Trebuchet MS", "Segoe UI", sans-serif`;
    c.fillStyle = rg.ink ?? (rg.faint ? 'rgba(244, 236, 214, 0.6)' : INK);
    c.fillText(rg.label, 0, -lift);
  }
  if (rg.sub) {
    c.font = `800 ${subSize}px "Trebuchet MS", "Segoe UI", sans-serif`;
    c.fillStyle = 'rgba(244, 236, 214, 0.75)';
    c.fillText(rg.sub, 0, rg.label ? size * 0.55 + lift * 0.2 : 0);
  }
  c.restore();
}

function makeFeltCanvas<B>(
  layout: FeltLayout<B>,
  decorate: (c: CanvasRenderingContext2D, px: (x: number, z: number) => [number, number]) => void,
): FeltCanvas {
  const f = layout.felt;
  const W = Math.round((f.x1 - f.x0) * FELT_PX_PER_M);
  const H = Math.round((f.z1 - f.z0) * FELT_PX_PER_M);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const mat = canvasMaterial(cv, false);
  // Mirror u so canvas-left lands on +x (see feltToPx): without it the felt
  // reads as if seen in a mirror from every side.
  if (mat.map) {
    mat.map.repeat.x = -1;
    mat.map.offset.x = 1;
  }
  const repaint = (highlight: ReadonlySet<string>, focus: string | null = null): void => {
    const c = cv.getContext('2d');
    if (!c) return;
    const px = (x: number, z: number) => feltToPx(f, W, H, x, z);
    c.fillStyle = FELT_GREEN;
    c.fillRect(0, 0, W, H);
    c.fillStyle = FELT_LIGHT;
    c.fillRect(10, 10, W - 20, H - 20);
    decorate(c, px);
    for (const rg of layout.regions) paintRegion(c, f, W, H, rg, highlight.has(rg.id), rg.id === focus);
    // The ⚙️ table-settings ring printed under the raised button.
    const b = layout.settings;
    const [bx, by] = px(b.x, b.z);
    c.beginPath();
    c.arc(bx, by, b.r * FELT_PX_PER_M * 1.18, 0, Math.PI * 2);
    c.lineWidth = 3;
    c.strokeStyle = LINE;
    c.stroke();
    const map = mat.map;
    if (map) map.needsUpdate = true;
  };
  repaint(new Set());
  return { cv, mat, repaint };
}

function crapsDecor(c: CanvasRenderingContext2D, px: (x: number, z: number) => [number, number]): void {
  // The centre proposition box outline and the table name in the dice area.
  const [x0, y0] = px(-0.345, 0.305);
  const [x1, y1] = px(0.345, -0.215);
  c.lineWidth = 4;
  c.strokeStyle = LINE;
  c.strokeRect(x0, y0, x1 - x0, y1 - y0);
  const [tx, ty] = px(0, -0.32);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = '900 34px "Trebuchet MS", sans-serif';
  c.fillStyle = 'rgba(244, 236, 214, 0.35)';
  c.fillText('★ STARSTATION CRAPS ★', tx, ty);
}

function rouletteDecor(c: CanvasRenderingContext2D, px: (x: number, z: number) => [number, number]): void {
  // The wheel's mahogany surround (the wheel itself is a 3D piece).
  const w = ROULETTE_WHEEL;
  const [cx, cy] = px(w.x, w.z);
  c.beginPath();
  c.arc(cx, cy, (w.r + 0.03) * FELT_PX_PER_M, 0, Math.PI * 2);
  c.fillStyle = '#3A2417';
  c.fill();
}

// ── Chips ────────────────────────────────────────────────────────────────────

const POOL_DENOMS = [1, 5, 25, 100, 500, 1000] as const;
/** Starting chips per denomination (felt + rail + hand together); a pool
 *  that fills doubles, so every chip on the table always renders. */
const CHIP_POOL = 360;
/** Colour chips start smaller: only roulette tables have them (and grow). */
const COLOR_CHIP_POOL = 120;
/** Colour ("wheel") chips are drawn white and tinted per instance with their
 *  owner's colour, so the stripes come out a shade darker than the body. */
const COLOR_CHIP_STYLE = { body: '#FFFFFF', stripe: '#A8A8A8', text: '#1A1A1A' };

function chipFaceCanvas(denom: number, s = CHIP_STYLE[denom] ?? CHIP_STYLE[1]): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d')!;
  c.fillStyle = s.body;
  c.fillRect(0, 0, 128, 128);
  // Edge inserts — the countability cue real chips carry.
  c.fillStyle = s.stripe;
  for (let i = 0; i < 6; i++) {
    c.save();
    c.translate(64, 64);
    c.rotate((i / 6) * Math.PI * 2);
    c.fillRect(-9, -64, 18, 20);
    c.restore();
  }
  c.beginPath();
  c.arc(64, 64, 36, 0, Math.PI * 2);
  c.lineWidth = 4;
  c.strokeStyle = s.stripe;
  c.stroke();
  c.fillStyle = s.text;
  c.font = `900 ${denom >= 100 ? 30 : 38}px "Trebuchet MS", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(denom), 64, 66);
  return cv;
}

function chipSideCanvas(denom: number, s = CHIP_STYLE[denom] ?? CHIP_STYLE[1]): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 8;
  const c = cv.getContext('2d')!;
  c.fillStyle = s.body;
  c.fillRect(0, 0, 128, 8);
  c.fillStyle = s.stripe;
  for (let i = 0; i < 6; i++) c.fillRect(i * (128 / 6) + 4, 0, 8, 8);
  return cv;
}

/** A pool's key: the denomination for value chips, its negative for colour
 *  chips. */
const colorPool = (d: number) => -d;

class ChipPools {
  private readonly meshes = new Map<number, THREE.InstancedMesh>();
  private readonly used = new Map<number, number>();
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly dim = new THREE.Color(0.62, 0.62, 0.62);
  private readonly lit = new THREE.Color(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly tint = new THREE.Color();

  /** `colorChips`: also make the colour-chip pools (roulette only). Every
   *  pool is made here, at build time, so World files it with the table. */
  constructor(ctx: PiecesCtx, colorChips = false) {
    const geo = new THREE.CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_H, 24);
    for (const d of POOL_DENOMS) {
      const side = solidCanvas(chipSideCanvas(d));
      const face = solidCanvas(chipFaceCanvas(d));
      // Lit materials would be nicer but the chips must read in the casino's
      // dim light from across the table: unlit faces, like the felt.
      const mesh = this.makeMesh(geo, [side, face, face], CHIP_POOL);
      ctx.attach(mesh);
      this.meshes.set(d, mesh);
      if (colorChips) {
        const cSide = solidCanvas(chipSideCanvas(d, COLOR_CHIP_STYLE));
        const cFace = solidCanvas(chipFaceCanvas(d, COLOR_CHIP_STYLE));
        const cMesh = this.makeMesh(geo, [cSide, cFace, cFace], COLOR_CHIP_POOL);
        ctx.attach(cMesh);
        this.meshes.set(colorPool(d), cMesh);
      }
    }
  }

  private makeMesh(geo: THREE.BufferGeometry, mats: THREE.Material[], capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mats, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    // World's furniture teardown runs every userData dispose* hook: free the
    // instance buffers (it disposes the shared geometry + materials itself).
    mesh.userData.disposeInstances = () => mesh.dispose();
    // setColorAt allocates instanceColor; prime it so dim/lit always works.
    mesh.setColorAt(0, this.lit);
    return mesh;
  }

  /** Double a full pool in place. The mesh object itself stays put — World
   *  registered it at placement for its zoom hide/show pass and its teardown
   *  — and only its instance buffers are swapped for ones twice the size,
   *  carrying over what's laid out so far. dispose() first frees the old GPU
   *  buffers; the renderer uploads the new ones on its next frame. */
  private grow(d: number): THREE.InstancedMesh {
    const mesh = this.meshes.get(d)!;
    const cap = mesh.instanceMatrix.count * 2;
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    matrix.setUsage(THREE.DynamicDrawUsage);
    matrix.array.set(mesh.instanceMatrix.array);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    if (mesh.instanceColor) color.array.set(mesh.instanceColor.array);
    mesh.dispose(); // the old instance buffers only; geometry + materials carry over
    mesh.instanceMatrix = matrix;
    mesh.instanceColor = color;
    return mesh;
  }

  begin(): void {
    for (const key of this.meshes.keys()) this.used.set(key, 0);
  }

  /** Add one chip lying flat at (x, y, z) — y is the chip's bottom face. A
   *  `color` draws it as that colour's chip instead of the value chip. */
  add(denom: number, x: number, y: number, z: number, spin: number, dim: boolean, color?: string): void {
    const d = (POOL_DENOMS as readonly number[]).includes(denom) ? denom : 1;
    const key = color && this.meshes.has(colorPool(d)) ? colorPool(d) : d;
    const i = this.used.get(key) ?? 0;
    let mesh = this.meshes.get(key)!;
    if (i >= mesh.instanceMatrix.count) mesh = this.grow(key);
    this.q.setFromAxisAngle(this.up, spin);
    this.pos.set(x, y + CHIP_H / 2, z);
    this.m4.compose(this.pos, this.q, this.one);
    mesh.setMatrixAt(i, this.m4);
    mesh.setColorAt(i, key < 0 ? this.tint.set(color!) : dim ? this.dim : this.lit);
    this.used.set(key, i + 1);
  }

  /** A stack, bottom chip first, starting at height y. */
  stack(chips: readonly number[], x: number, y: number, z: number, dim: boolean, seed: number, color?: string): void {
    chips.forEach((d, i) => {
      // A dealer's stack is never perfectly square: a hair of jitter.
      const jx = Math.sin((seed + i) * 12.9898) * 0.0012;
      const jz = Math.cos((seed + i) * 78.233) * 0.0012;
      this.add(d, x + jx, y + i * CHIP_H, z + jz, (seed * 0.7 + i * 1.3) % (Math.PI * 2), dim, color);
    });
  }

  commit(): void {
    for (const [d, mesh] of this.meshes) {
      mesh.count = this.used.get(d) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}

// ── Dice ─────────────────────────────────────────────────────────────────────

const PIPS: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [[-0.5, -0.5], [0.5, 0.5]],
  3: [[-0.5, -0.5], [0, 0], [0.5, 0.5]],
  4: [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]],
  5: [[-0.5, -0.5], [0.5, -0.5], [0, 0], [-0.5, 0.5], [0.5, 0.5]],
  6: [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0], [0.5, 0], [-0.5, 0.5], [0.5, 0.5]],
};

function dieFaceCanvas(value: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d')!;
  // Casino-red translucent-look dice with white pips (the classic stick dice).
  c.fillStyle = '#C8102E';
  c.fillRect(0, 0, 128, 128);
  c.strokeStyle = '#8E0B20';
  c.lineWidth = 6;
  c.strokeRect(3, 3, 122, 122);
  c.fillStyle = '#FFFFFF';
  for (const [x, y] of PIPS[value] ?? []) {
    c.beginPath();
    c.arc(64 + x * 64, 64 + y * 64, 12, 0, Math.PI * 2);
    c.fill();
  }
  return cv;
}

/** BoxGeometry material order: +x, −x, +y, −y, +z, −z. Opposite faces sum 7. */
const FACE_ORDER = [3, 4, 1, 6, 2, 5];

/** Orientation that puts `value` face up (before the yaw). */
function faceUpQuat(value: number): THREE.Quaternion {
  const q = new THREE.Quaternion();
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  switch (value) {
    case 6: return q.setFromAxisAngle(X, Math.PI);
    case 3: return q.setFromAxisAngle(Z, Math.PI / 2);
    case 4: return q.setFromAxisAngle(Z, -Math.PI / 2);
    case 2: return q.setFromAxisAngle(X, -Math.PI / 2);
    case 5: return q.setFromAxisAngle(X, Math.PI / 2);
    default: return q;
  }
}

/** How far two dice (cubes of half-size `half`) overlap, by the separating
 *  axis test: null when they don't touch, else the shortest push that parts
 *  them, as a vector from `pa` toward `pb`. Exported for the tests. */
export function diceOverlap(
  pa: THREE.Vector3, qa: THREE.Quaternion, pb: THREE.Vector3, qb: THREE.Quaternion, half: number,
): THREE.Vector3 | null {
  const A = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((v) => v.applyQuaternion(qa));
  const B = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((v) => v.applyQuaternion(qb));
  const axes = [...A, ...B];
  for (const a of A) for (const b of B) {
    const c = new THREE.Vector3().crossVectors(a, b);
    // Parallel edges give no new axis (the face axes already cover it).
    if (c.lengthSq() > 1e-6) axes.push(c.normalize());
  }
  const d = new THREE.Vector3().subVectors(pb, pa);
  let best = Infinity;
  let bestAxis: THREE.Vector3 | null = null;
  for (const L of axes) {
    const ra = half * (Math.abs(A[0].dot(L)) + Math.abs(A[1].dot(L)) + Math.abs(A[2].dot(L)));
    const rb = half * (Math.abs(B[0].dot(L)) + Math.abs(B[1].dot(L)) + Math.abs(B[2].dot(L)));
    const dl = d.dot(L);
    const overlap = ra + rb - Math.abs(dl);
    if (overlap <= 0) return null;
    if (overlap < best) {
      best = overlap;
      bestAxis = L.clone().multiplyScalar(dl < 0 ? -1 : 1);
    }
  }
  return bestAxis ? bestAxis.multiplyScalar(best) : null;
}

/** Small seeded PRNG (mulberry32) so a throw tumbles alike on every client. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DieBody {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  quat: THREE.Quaternion;
  from: THREE.Quaternion;
  to: THREE.Quaternion;
  slideFrom: THREE.Vector3;
  slideTo: THREE.Vector3;
}

/** The faces the dice show before any roll (and after a reset). */
const NEUTRAL_FACES: [number, number] = [5, 2];

class DicePair {
  readonly group = new THREE.Group();
  readonly bodies: DieBody[] = [];
  private mode: 'rest' | 'held' | 'flying' | 'settling' | 'sliding' = 'rest';
  private t = 0;
  private landing: [number, number] | null = null;
  private faces: [number, number] = [...NEUTRAL_FACES];
  private rand: () => number = prng(1);
  private slideDur = 0.55;
  private readonly half = DIE_SIZE / 2;

  constructor(private readonly felt: FeltRect) {
    const geo = new THREE.BoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE);
    const mats = FACE_ORDER.map((v) => solidCanvas(dieFaceCanvas(v)));
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(geo, mats);
      this.group.add(mesh);
      const q = faceUpQuat(this.faces[i]);
      this.bodies.push({
        mesh,
        pos: new THREE.Vector3(i ? 0.06 : -0.06, FELT_Y + this.half, 0.3),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        quat: q.clone(),
        from: q.clone(),
        to: q.clone(),
        slideFrom: new THREE.Vector3(),
        slideTo: new THREE.Vector3(),
      });
    }
    this.apply();
  }

  state(): 'rest' | 'held' | 'flying' | 'settling' {
    return this.mode === 'sliding' ? 'rest' : this.mode;
  }

  meshes(): THREE.Mesh[] {
    return this.bodies.map((b) => b.mesh);
  }

  private restQuat(value: number, yaw: number): THREE.Quaternion {
    const y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    return y.multiply(faceUpQuat(value));
  }

  /** Drop any throw in progress where it is (the next restAt slides home). */
  cancel(): void {
    this.mode = 'rest';
    this.landing = null;
  }

  restAt(p: FeltPoint, values?: [number, number]): void {
    if (this.mode === 'flying' || this.mode === 'settling') return;
    if (values) this.faces = values;
    const targets = [
      new THREE.Vector3(p.x - 0.055, FELT_Y + this.half, p.z),
      new THREE.Vector3(p.x + 0.055, FELT_Y + this.half, p.z),
    ];
    const faceChange = values !== undefined;
    // The frame driver asks again every frame: a slide already headed for
    // these spots carries on rather than starting over from where it is.
    if (this.mode === 'sliding' && !faceChange) {
      const same = (u: THREE.Vector3[]) => this.bodies.every((b, i) => b.slideTo.distanceTo(u[i]) < 1e-4);
      if (same(targets) || same([targets[1], targets[0]])) return;
    }
    // Each die goes to the nearer spot, so the pair never slides through itself.
    const [a, c] = this.bodies;
    if (a.pos.distanceTo(targets[1]) + c.pos.distanceTo(targets[0]) < a.pos.distanceTo(targets[0]) + c.pos.distanceTo(targets[1]) - 1e-6) {
      targets.reverse();
    }
    const far = this.bodies.some((b, i) => b.pos.distanceTo(targets[i]) > 0.01);
    if (!far && !faceChange && this.mode === 'rest') return;
    this.bodies.forEach((b, i) => {
      b.slideFrom.copy(b.pos);
      b.slideTo.copy(targets[i]);
      b.from.copy(b.quat);
      b.to.copy(this.restQuat(this.faces[i], i * 0.35));
    });
    // A short nudge is quick; a push across the table takes a beat longer,
    // so the stickman's stick reads as moving them.
    const dist = Math.max(...this.bodies.map((b, i) => b.pos.distanceTo(targets[i])));
    this.slideDur = Math.min(1.1, 0.35 + dist * 0.45);
    this.mode = 'sliding';
    this.t = 0;
  }

  hold(p: FeltPoint): void {
    if (this.mode === 'flying' || this.mode === 'settling') return;
    this.mode = 'held';
    this.bodies.forEach((b, i) => {
      b.pos.set(p.x + (i ? 0.05 : -0.05), FELT_Y + this.half + 0.07, p.z);
    });
    this.collide(false);
  }

  throwFrom(from: FeltPoint, dir: FeltPoint, power: number, seed: number): void {
    this.rand = prng(seed);
    const r = this.rand;
    const len = Math.hypot(dir.x, dir.z) || 1;
    const dx = dir.x / len, dz = dir.z / len;
    const speed = 1.4 + 2.0 * Math.max(0, Math.min(1, power));
    this.bodies.forEach((b, i) => {
      const side = i ? 1 : -1;
      b.pos.set(from.x + -dz * 0.04 * side, FELT_Y + this.half + 0.08, from.z + dx * 0.04 * side);
      const fan = (r() - 0.5) * 0.25 + side * 0.06;
      const c = Math.cos(fan), s = Math.sin(fan);
      b.vel.set((dx * c - dz * s) * speed * (0.92 + r() * 0.16), 0.9 + r() * 0.6, (dz * c + dx * s) * speed * (0.92 + r() * 0.16));
      b.spin.set((r() - 0.5) * 30, (r() - 0.5) * 18, (r() - 0.5) * 30);
    });
    this.landing = null;
    this.mode = 'flying';
    this.t = 0;
  }

  land(values: [number, number]): void {
    this.landing = values;
    this.faces = values;
    if (this.mode === 'rest' || this.mode === 'sliding' || this.mode === 'held') {
      // No throw seen (joined mid-roll): just show the faces where they lie
      // (where a pending slide was taking them, if one was).
      const sliding = this.mode === 'sliding';
      this.bodies.forEach((b, i) => {
        if (sliding) b.pos.copy(b.slideTo);
        b.quat.copy(this.restQuat(values[i], i * 0.35));
        b.pos.y = FELT_Y + this.half;
      });
      this.collide(false);
      this.mode = 'rest';
      this.apply();
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.t += dt;
    if (this.mode === 'sliding') {
      const k = Math.min(1, this.t / this.slideDur);
      const e = k * k * (3 - 2 * k);
      for (const b of this.bodies) {
        b.pos.lerpVectors(b.slideFrom, b.slideTo, e);
        b.quat.slerpQuaternions(b.from, b.to, e);
      }
      this.collide(false);
      if (k >= 1) this.mode = 'rest';
    } else if (this.mode === 'flying') {
      // Small steps, so a fast die can't jump clean through the other one.
      const step = Math.min(dt, 1 / 30);
      const n = Math.ceil(step / (1 / 120));
      for (let i = 0; i < n; i++) this.stepFlight(step / n);
      const slow = this.bodies.every((b) => Math.hypot(b.vel.x, b.vel.z) < 0.35 && b.pos.y < FELT_Y + this.half + 0.01);
      if (this.landing && (slow || this.t > 3.2) && this.t > 0.7) {
        this.bodies.forEach((b, i) => {
          b.from.copy(b.quat);
          const yaw = Math.atan2(b.vel.x, b.vel.z) + (this.rand() - 0.5);
          b.to.copy(this.restQuat(this.landing![i], yaw));
        });
        this.mode = 'settling';
        this.t = 0;
      }
    } else if (this.mode === 'settling') {
      const k = Math.min(1, this.t / 0.4);
      const e = 1 - Math.pow(1 - k, 3);
      for (const b of this.bodies) {
        b.vel.multiplyScalar(Math.max(0, 1 - dt * 8));
        b.pos.x += b.vel.x * dt;
        b.pos.z += b.vel.z * dt;
        b.pos.y = FELT_Y + this.half;
        this.clampToFelt(b);
        b.quat.slerpQuaternions(b.from, b.to, e);
      }
      this.collide(false);
      if (k >= 1) this.mode = 'rest';
    }
    this.apply();
  }

  private clampToFelt(b: DieBody): boolean {
    const m = this.half + 0.01;
    let hit = false;
    if (b.pos.x < this.felt.x0 + m) { b.pos.x = this.felt.x0 + m; b.vel.x = Math.abs(b.vel.x) * 0.55; hit = true; }
    if (b.pos.x > this.felt.x1 - m) { b.pos.x = this.felt.x1 - m; b.vel.x = -Math.abs(b.vel.x) * 0.55; hit = true; }
    if (b.pos.z < this.felt.z0 + m) { b.pos.z = this.felt.z0 + m; b.vel.z = Math.abs(b.vel.z) * 0.55; hit = true; }
    if (b.pos.z > this.felt.z1 - m) { b.pos.z = this.felt.z1 - m; b.vel.z = -Math.abs(b.vel.z) * 0.55; hit = true; }
    return hit;
  }

  private stepFlight(dt: number): void {
    const floor = FELT_Y + this.half;
    const tmp = new THREE.Quaternion();
    for (const b of this.bodies) {
      b.vel.y -= 9.8 * dt;
      b.pos.addScaledVector(b.vel, dt);
      if (b.pos.y < floor) {
        b.pos.y = floor;
        b.vel.y = Math.abs(b.vel.y) > 0.4 ? -b.vel.y * 0.38 : 0;
        // Felt drag on every bounce, and on the slide.
        b.vel.x *= 0.78;
        b.vel.z *= 0.78;
        b.spin.multiplyScalar(0.7);
      } else if (b.pos.y <= floor + 1e-4) {
        b.vel.x *= Math.max(0, 1 - dt * 2.2);
        b.vel.z *= Math.max(0, 1 - dt * 2.2);
      }
      if (this.clampToFelt(b)) {
        // The back wall's rubber pyramids kick the dice into a fresh tumble.
        b.spin.set((this.rand() - 0.5) * 26, (this.rand() - 0.5) * 14, (this.rand() - 0.5) * 26);
      }
      const ang = b.spin.length() * dt;
      if (ang > 1e-5) {
        tmp.setFromAxisAngle(b.spin.clone().normalize(), ang);
        b.quat.premultiply(tmp);
      }
    }
    this.collide(true);
  }

  /** The dice are solid: wherever they are and however they're turned, push
   *  them apart until their boxes no longer overlap (and, in flight, bounce
   *  them off each other). A push never sinks a die into the felt or through
   *  the rail, so it is repeated a few times for a die pinned on a wall. */
  private collide(bounce: boolean): void {
    const [a, c] = this.bodies;
    const floor = FELT_Y + this.half;
    for (let iter = 0; iter < 6; iter++) {
      let mtv = diceOverlap(a.pos, a.quat, c.pos, c.quat, this.half);
      if (!mtv) return;
      const low = a.pos.y <= floor + 0.02 && c.pos.y <= floor + 0.02;
      let push: THREE.Vector3;
      if (low) {
        // Both on the felt: part them across it, never into it, along the
        // line between them — just far enough (bisected) that they clear.
        const u = new THREE.Vector3(c.pos.x - a.pos.x, 0, c.pos.z - a.pos.z);
        if (u.lengthSq() < 1e-12) u.set(mtv.x, 0, mtv.z);
        if (u.lengthSq() < 1e-12) u.set(1, 0, 0);
        u.normalize();
        const pa = new THREE.Vector3(), pc = new THREE.Vector3();
        const clear = (t: number) => {
          pa.copy(a.pos).addScaledVector(u, -t / 2);
          pc.copy(c.pos).addScaledVector(u, t / 2);
          return !diceOverlap(pa, a.quat, pc, c.quat, this.half);
        };
        let lo = 0, hi = DIE_SIZE * 1.8;
        for (let k = 0; k < 18; k++) {
          const mid = (lo + hi) / 2;
          if (clear(mid)) hi = mid; else lo = mid;
        }
        push = u.multiplyScalar((hi + 0.001) / 2);
        mtv = push.clone();
      } else {
        // In the air: the shortest way apart, half each, plus a hair.
        push = mtv.clone().multiplyScalar(0.5).addScaledVector(mtv.clone().normalize(), 0.0005);
      }
      a.pos.sub(push);
      c.pos.add(push);
      for (const b of this.bodies) {
        if (b.pos.y < floor) b.pos.y = floor;
        this.clampToFelt(b);
      }
      if (bounce) {
        const n = mtv.clone().normalize();
        const vn = new THREE.Vector3().subVectors(c.vel, a.vel).dot(n);
        if (vn < 0) {
          // Equal masses, a fairly lively knock (restitution 0.5).
          const j = -(1 + 0.5) * vn / 2;
          a.vel.addScaledVector(n, -j);
          c.vel.addScaledVector(n, j);
          const kick = Math.min(1, -vn) * 12;
          a.spin.x += (this.rand() - 0.5) * kick; a.spin.z += (this.rand() - 0.5) * kick;
          c.spin.x += (this.rand() - 0.5) * kick; c.spin.z += (this.rand() - 0.5) * kick;
        }
      }
    }
  }

  private apply(): void {
    for (const b of this.bodies) {
      b.mesh.position.copy(b.pos);
      b.mesh.quaternion.copy(b.quat);
    }
  }
}

// ── Puck ─────────────────────────────────────────────────────────────────────

function puckFaceCanvas(on: boolean): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d')!;
  c.fillStyle = on ? '#F4EFE2' : '#14161D';
  c.fillRect(0, 0, 128, 128);
  c.beginPath();
  c.arc(64, 64, 56, 0, Math.PI * 2);
  c.lineWidth = 6;
  c.strokeStyle = on ? '#1B6B3A' : '#8894A2';
  c.stroke();
  c.fillStyle = on ? '#14161D' : '#F4EFE2';
  c.font = '900 46px "Trebuchet MS", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(on ? 'ON' : 'OFF', 64, 68);
  return cv;
}

class Puck {
  readonly mesh: THREE.Mesh;
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private fromFlip = 0;
  private toFlip = 0;
  private t = 1;
  private point: number | null | undefined = undefined;

  constructor(ctx: PiecesCtx, private readonly side: -1 | 1) {
    const geo = new THREE.CylinderGeometry(PUCK_R, PUCK_R, 0.014, 28);
    const edge = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6 });
    // CylinderGeometry groups: side, top (+y), bottom (−y). ON is the top.
    this.mesh = new THREE.Mesh(geo, [edge, solidCanvas(puckFaceCanvas(true)), solidCanvas(puckFaceCanvas(false))]);
    ctx.attach(this.mesh);
    this.set(null, true);
  }

  set(point: number | null, snap = false): void {
    if (point === this.point) return;
    this.point = point;
    const s = crapsPuckSpot(point, this.side);
    this.from.copy(this.mesh.position);
    this.to.set(s.x, FELT_Y + 0.007, s.z);
    this.fromFlip = this.mesh.rotation.z;
    // Face up: ON (top) when a point is on; flipped over to OFF otherwise.
    this.toFlip = point === null ? Math.PI : 0;
    this.t = snap ? 1 : 0;
    if (snap) {
      this.mesh.position.copy(this.to);
      this.mesh.rotation.set(0, Math.PI, this.toFlip);
    }
  }

  update(dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / 0.6);
    const e = this.t * this.t * (3 - 2 * this.t);
    this.mesh.position.lerpVectors(this.from, this.to, e);
    this.mesh.position.y += Math.sin(Math.PI * this.t) * 0.09; // lifted across
    this.mesh.rotation.z = this.fromFlip + (this.toFlip - this.fromFlip) * e;
  }
}

// ── ⚙️ settings button ───────────────────────────────────────────────────────

function gearCanvas(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#20262F';
  c.fillRect(0, 0, 128, 128);
  c.font = '84px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('⚙️', 64, 70);
  return cv;
}

function buildSettingsButton(ctx: PiecesCtx, b: { x: number; z: number; r: number }): {
  mesh: THREE.Mesh;
  setHot(hot: boolean): void;
} {
  const geo = new THREE.CylinderGeometry(b.r, b.r * 1.06, 0.018, 32);
  const rim = new THREE.MeshStandardMaterial({ color: 0xd4a84b, metalness: 0.6, roughness: 0.35, emissive: 0x000000 });
  const face = solidCanvas(gearCanvas());
  const mesh = new THREE.Mesh(geo, [rim, face, rim]);
  mesh.position.set(b.x, FELT_Y + 0.009, b.z);
  // The emoji reads upright for the players on the −z rail.
  mesh.rotation.y = Math.PI;
  ctx.attach(mesh);
  return {
    mesh,
    setHot(hot) {
      rim.emissive.setHex(hot ? 0x6f4a10 : 0x000000);
      mesh.position.y = FELT_Y + (hot ? 0.013 : 0.009);
    },
  };
}

// ── ↶ Take-down button ───────────────────────────────────────────────────────

/** Radius of the round take-down button on your rail (a little over a chip). */
export const TAKE_DOWN_R = 0.024;

function takeDownCanvas(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#5A1620';
  c.fillRect(0, 0, 128, 128);
  // A curved arrow sweeping round and down toward the bottom of the canvas
  // (the mesh turns that edge toward its owner): "bring my chips back".
  c.strokeStyle = '#F0C060';
  c.fillStyle = '#F0C060';
  c.lineWidth = 13;
  c.lineCap = 'round';
  // Three quarters of a ring, from the bottom round the left and over the
  // top, ending on the right where the head points down.
  c.beginPath();
  c.arc(60, 58, 30, Math.PI * 0.5, Math.PI * 0.02, false);
  c.stroke();
  c.beginPath();
  c.moveTo(72, 60);
  c.lineTo(108, 60);
  c.lineTo(90, 94);
  c.closePath();
  c.fill();
  return cv;
}

function buildTakeDownButton(ctx: PiecesCtx): {
  mesh: THREE.Mesh;
  /** Shown or hidden here: World sets every furniture mesh's own `visible`
   *  back to true each interior frame, so the mesh's parent carries it. */
  group: THREE.Group;
  place(at: { p: FeltPoint; toward: FeltPoint } | null, ready: boolean): void;
  setHot(hot: boolean): void;
  press(): void;
  update(dt: number): void;
} {
  const geo = new THREE.CylinderGeometry(TAKE_DOWN_R, TAKE_DOWN_R * 1.08, 0.012, 28);
  const rim = new THREE.MeshStandardMaterial({ color: 0xd4a84b, metalness: 0.6, roughness: 0.35, emissive: 0x000000 });
  const face = solidCanvas(takeDownCanvas());
  const mesh = new THREE.Mesh(geo, [rim, face, rim]);
  const group = new THREE.Group();
  group.visible = false;
  group.add(mesh);
  ctx.attach(group);
  let hot = false;
  let ready = false;
  let sink = 0;
  const lift = (): void => {
    mesh.position.y = RAIL_Y + 0.006 + (hot && ready ? 0.003 : 0) - sink * 0.005;
  };
  return {
    mesh,
    group,
    place(at, isReady) {
      group.visible = at !== null;
      ready = isReady;
      if (at) {
        mesh.position.x = at.p.x;
        mesh.position.z = at.p.z;
        // The canvas's bottom edge faces +z unturned: turn it to `toward`.
        mesh.rotation.y = Math.atan2(at.toward.x, at.toward.z);
      }
      face.color.setHex(ready ? 0xffffff : 0x5c5c5c);
      rim.color.setHex(ready ? 0xd4a84b : 0x6e6250);
      rim.emissive.setHex(hot && ready ? 0x6f4a10 : 0x000000);
      lift();
    },
    setHot(h) {
      if (h === hot) return;
      hot = h;
      rim.emissive.setHex(hot && ready ? 0x6f4a10 : 0x000000);
      lift();
    },
    press() {
      sink = 1;
      lift();
    },
    update(dt) {
      if (sink <= 0) return;
      sink = Math.max(0, sink - dt / 0.18);
      lift();
    },
  };
}

// ── ⚖️ Fair / Friendly plaque ────────────────────────────────────────────────

const PLAQUE_W = 0.12;
const PLAQUE_H = 0.032;

function plaqueCanvas(fair: boolean): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 384;
  cv.height = 102;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#14181F';
  c.fillRect(0, 0, cv.width, cv.height);
  const ring = fair ? '#3FBF7F' : '#D9534F';
  c.lineWidth = 6;
  c.strokeStyle = ring;
  c.strokeRect(3, 3, cv.width - 6, cv.height - 6);
  // The "F" medallion: a green circle on a Fair table, a red one on a
  // Friendly one. Both words start with F, so the word beside it says which
  // (and doesn't lean on red vs green alone).
  const r = 38;
  const cx = 14 + r;
  const cy = cv.height / 2;
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fillStyle = ring;
  c.fill();
  c.fillStyle = '#FFFFFF';
  c.font = '900 54px "Trebuchet MS", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('F', cx, cy + 3);
  c.fillStyle = fair ? '#7CF5B0' : '#F28B87';
  c.font = `900 ${fair ? 52 : 42}px "Trebuchet MS", sans-serif`;
  c.fillText(fair ? 'FAIR' : 'FRIENDLY', (cx + r + cv.width) / 2, cy + 3);
  return cv;
}

/** Where the plaque lies beside a ⚙️ at `b`: on its reader's right (craps,
 *  where the dice rest on its left), or just in front of it toward the −z rail
 *  (roulette, whose gear sits between the wheel and the layout). Clear felt
 *  either way — casinoTable3d.test.ts checks it against every betting box. */
export function fairPlaqueCentre(b: { x: number; z: number; r: number }, at: 'right' | 'front'): FeltPoint {
  return at === 'right'
    ? { x: b.x - (b.r + 0.012 + PLAQUE_W / 2), z: b.z }
    : { x: b.x, z: b.z - (b.r + 0.012 + PLAQUE_H / 2) };
}
export const FAIR_PLAQUE_SIZE = { w: PLAQUE_W, h: PLAQUE_H };

/** A small brass-edged plaque lying on the felt by the ⚙️, reading the same
 *  way as the gear (for the players on the −z rail). */
function buildFairPlaque(ctx: PiecesCtx, b: { x: number; z: number; r: number }, at: 'right' | 'front'): { set(fair: boolean): void } {
  const fairMat = solidCanvas(plaqueCanvas(true));
  const friendlyMat = solidCanvas(plaqueCanvas(false));
  const geo = new THREE.PlaneGeometry(PLAQUE_W, PLAQUE_H);
  geo.rotateX(-Math.PI / 2);
  // Rotated like the gear, so its reader's right is the table's −x.
  geo.rotateY(Math.PI);
  const c = fairPlaqueCentre(b, at);
  const mesh = ctx.place(geo, fairMat, c.x, FELT_Y + 0.002, c.z);
  let shown = true;
  // World's teardown frees the material on the mesh; free the spare too.
  mesh.userData.disposePlaqueSpare = () => {
    const spare = mesh.material === fairMat ? friendlyMat : fairMat;
    spare.map?.dispose();
    spare.dispose();
  };
  return {
    set(fair) {
      if (fair === shown) return;
      shown = fair;
      mesh.material = fair ? fairMat : friendlyMat;
    },
  };
}

// ── Roulette wheel ───────────────────────────────────────────────────────────

const POCKETS = WHEEL_ORDER.length;
/** Wheel-local angle (atan2(z, x) in the wheel's frame) of a pocket's centre:
 *  the pocket canvas draws pocket i from i/37 of a turn, and the disc's UVs
 *  map canvas angle α to that same XZ angle. */
function pocketAngle(n: number): number {
  const i = Math.max(0, WHEEL_ORDER.indexOf(n));
  return ((i + 0.5) / POCKETS) * Math.PI * 2;
}

function wheelCanvas(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c = cv.getContext('2d')!;
  const C = 256;
  c.fillStyle = '#2A1A10';
  c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < POCKETS; i++) {
    const a0 = (i / POCKETS) * Math.PI * 2;
    const a1 = ((i + 1) / POCKETS) * Math.PI * 2;
    const col = pocketColor(WHEEL_ORDER[i]);
    c.beginPath();
    c.moveTo(C, C);
    c.arc(C, C, 240, a0, a1);
    c.closePath();
    c.fillStyle = col === 'green' ? '#1B6B3A' : col === 'red' ? '#C43C3C' : '#23252E';
    c.fill();
    c.strokeStyle = '#D4A84B';
    c.lineWidth = 2;
    c.stroke();
    const mid = (a0 + a1) / 2;
    c.save();
    c.translate(C + Math.cos(mid) * 214, C + Math.sin(mid) * 214);
    c.rotate(mid + Math.PI / 2);
    c.fillStyle = '#F5EFDF';
    c.font = '900 22px "Trebuchet MS", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(WHEEL_ORDER[i]), 0, 0);
    c.restore();
  }
  // Pocket floor ring, then the cone.
  c.beginPath();
  c.arc(C, C, 160, 0, Math.PI * 2);
  c.fillStyle = '#5A3A22';
  c.fill();
  c.beginPath();
  c.arc(C, C, 120, 0, Math.PI * 2);
  c.fillStyle = '#4A2F1B';
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = '#D4A84B';
  c.stroke();
  return cv;
}

class RouletteWheel {
  readonly spinner = new THREE.Group();
  readonly ball: THREE.Mesh;
  private readonly ballGroup = new THREE.Group();
  private angle = 0;
  private readonly idleSpeed = 0.35;
  private spin: { t: number; T: number; result: number; w0: number; turns: number } | null = null;
  private rest: number | null = null;
  private readonly r: number;
  private readonly cx: number;
  private readonly cz: number;
  private readonly y: number;

  constructor(ctx: PiecesCtx) {
    const w = ROULETTE_WHEEL;
    this.r = w.r;
    this.cx = w.x;
    this.cz = w.z;
    this.y = FELT_Y;
    // Bowl.
    ctx.place(new THREE.CylinderGeometry(w.r + 0.02, w.r + 0.03, 0.07, 40), ctx.m(0x2a1a10, 0.5, 0.3), w.x, FELT_Y + 0.02, w.z);
    const rim = ctx.place(new THREE.TorusGeometry(w.r + 0.01, 0.016, 8, 48), ctx.m(0xd4a84b, 0.45, 0.5), w.x, FELT_Y + 0.058, w.z);
    rim.rotation.x = Math.PI / 2;
    // The spinning head: pocket disc + hub + turret.
    const discGeo = new THREE.CircleGeometry(w.r * 0.92, 74);
    discGeo.rotateX(-Math.PI / 2);
    const disc = new THREE.Mesh(discGeo, canvasMaterial(wheelCanvas()));
    disc.position.y = 0.06;
    this.spinner.add(disc);
    const hub = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.09, 16), fadeMaterial({ color: 0xd4a84b, roughness: 0.4, metalness: 0.6 }));
    hub.position.y = 0.1;
    this.spinner.add(hub);
    const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.06, 8), fadeMaterial({ color: 0xf0c060, roughness: 0.3, metalness: 0.7 }));
    turret.position.y = 0.16;
    this.spinner.add(turret);
    this.spinner.position.set(w.x, FELT_Y, w.z);
    ctx.attach(this.spinner);
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.011, 14, 10), fadeMaterial({ color: 0xffffff, roughness: 0.25 }));
    this.ballGroup.add(this.ball);
    this.ballGroup.visible = false;
    ctx.attach(this.ballGroup);
  }

  busy(): boolean {
    return this.spin !== null;
  }

  start(result: number, seed: number): void {
    const r = prng(seed);
    this.spin = { t: 0, T: 4.6 + r() * 0.8, result, w0: 5 + r() * 2, turns: 7 + Math.floor(r() * 3) };
    this.rest = null;
    this.ballGroup.visible = true;
  }

  /** Stop a spin in progress (the wheel idles on). */
  cancel(): void {
    this.spin = null;
  }

  restOn(result: number | null): void {
    if (this.spin) return;
    this.rest = result;
    this.ballGroup.visible = result !== null;
  }

  /** Place the ball at wheel-local polar (psi, radius) and height. */
  private putBall(psi: number, radius: number, lift: number): void {
    // spinner.rotation.y = angle turns wheel-local XZ angle psi to table angle psi − angle.
    const a = psi - this.angle;
    this.ball.position.set(this.cx + Math.cos(a) * radius, this.y + 0.072 + lift, this.cz + Math.sin(a) * radius);
  }

  update(dt: number): void {
    if (dt <= 0) return;
    if (this.spin) {
      const s = this.spin;
      s.t += dt;
      const k = Math.min(1, s.t / s.T);
      // The head slows from w0 to its idle drift.
      const extra = s.w0 * (1 - k) * (1 - k) * 0.5;
      this.angle += (this.idleSpeed + extra) * dt;
      const target = pocketAngle(s.result);
      // The ball laps the other way, losing speed, and drops at k = 1 exactly
      // into `target` — its wheel-relative angle ends there whatever the head did.
      const psi = target + s.turns * Math.PI * 2 * Math.pow(1 - k, 3);
      const outer = this.r * 0.98;
      const pocket = this.r * 0.6;
      const drop = k < 0.72 ? 0 : (k - 0.72) / 0.28;
      const radius = outer + (pocket - outer) * drop * drop;
      const bounce = drop > 0 && drop < 1 ? Math.abs(Math.sin(drop * Math.PI * 3)) * 0.012 * (1 - drop) : 0;
      this.putBall(psi, radius, 0.012 * (1 - drop) + bounce);
      if (k >= 1) {
        this.rest = s.result;
        this.spin = null;
      }
    } else {
      this.angle += this.idleSpeed * dt;
      if (this.rest !== null) this.putBall(pocketAngle(this.rest), this.r * 0.6, 0);
    }
    this.spinner.rotation.y = this.angle;
  }
}

// ── Assembly ─────────────────────────────────────────────────────────────────

interface Common {
  feltMesh: THREE.Mesh;
  felt: FeltCanvas;
  pools: ChipPools;
  railHit: THREE.Mesh;
  settings: { mesh: THREE.Mesh; setHot(hot: boolean): void };
  plaque: { set(fair: boolean): void };
  takeDown: ReturnType<typeof buildTakeDownButton>;
}

function buildCommon<B>(ctx: PiecesCtx, layout: FeltLayout<B>, halfX: number, halfZ: number, decor: Parameters<typeof makeFeltCanvas>[1], plaqueAt: 'right' | 'front', colorChips = false): Common {
  const felt = makeFeltCanvas(layout, decor);
  const f = layout.felt;
  const geo = new THREE.PlaneGeometry(f.x1 - f.x0, f.z1 - f.z0);
  geo.rotateX(-Math.PI / 2);
  const feltMesh = ctx.place(geo, felt.mat, (f.x0 + f.x1) / 2, FELT_Y, (f.z0 + f.z1) / 2);
  const pools = new ChipPools(ctx, colorChips);
  // An invisible collar over the whole padded rail: the pickup's hit box.
  const railGroup = new THREE.Group();
  railGroup.visible = false;
  const shape = new THREE.Shape();
  shape.moveTo(-halfX - 0.05, -halfZ - 0.05);
  shape.lineTo(halfX + 0.05, -halfZ - 0.05);
  shape.lineTo(halfX + 0.05, halfZ + 0.05);
  shape.lineTo(-halfX - 0.05, halfZ + 0.05);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-halfX + 0.05, -halfZ + 0.05);
  hole.lineTo(-halfX + 0.05, halfZ - 0.05);
  hole.lineTo(halfX - 0.05, halfZ - 0.05);
  hole.lineTo(halfX - 0.05, -halfZ + 0.05);
  hole.closePath();
  shape.holes.push(hole);
  const collarGeo = new THREE.ShapeGeometry(shape);
  collarGeo.rotateX(Math.PI / 2);
  const railHit = new THREE.Mesh(collarGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide }));
  railHit.position.y = RAIL_Y + 0.006;
  railGroup.add(railHit);
  ctx.attach(railGroup);
  const settings = buildSettingsButton(ctx, layout.settings);
  const plaque = buildFairPlaque(ctx, layout.settings, plaqueAt);
  const takeDown = buildTakeDownButton(ctx);
  return { feltMesh, felt, pools, railHit, settings, plaque, takeDown };
}

/** How long chips taken down take to slide back to your rail. */
const SWEEP_S = 0.5;
/** A take-down that hasn't reached the felt this long after the press
 *  (nothing came off) stops waiting. */
const SWEEP_ARM_S = 1;

/** The chips of mine that left the felt between two felt updates: each own
 *  stack's chips past what still stands at that spot and height (a stack
 *  that's gone gave all of them; odds riding on a flat bet share its spot
 *  and differ by `lift`). Others' stacks never count. */
export function departedChips(before: readonly FeltStack[], after: readonly FeltStack[]): FeltStack[] {
  const out: FeltStack[] = [];
  for (const s of before) {
    if (s.dim) continue;
    const still = after.find((a) => !a.dim && Math.abs(a.x - s.x) < 1e-4 && Math.abs(a.z - s.z) < 1e-4
      && (a.lift ?? 0) === (s.lift ?? 0));
    const left = still ? Math.max(0, s.chips.length - still.chips.length) : s.chips.length;
    if (left > 0) out.push({ ...s, chips: s.chips.slice(s.chips.length - left), lift: (s.lift ?? 0) + s.chips.length - left });
  }
  return out;
}

// ── 💰 The settle's chip moves ──────────────────────────────────────────────

/** A losing stack's slide into the house, and its drop out of sight there
 *  (a stack sinking into the bank, or into a rail, drops below the felt or
 *  the rail top, which hide it). */
const SWEEP_IN_S = 0.55;
const SINK_S = 0.16;
/** When the pay-out starts: once the losers are in, or almost at once when
 *  nothing lost. */
const PAY_AFTER_LOSS_S = SWEEP_IN_S + 0.1;
const PAY_NO_LOSS_S = 0.15;
/** Each bettor paid a beat after the one before, as the crew pays round the
 *  table (and no later than this many beats). */
const PAY_STAGGER_S = 0.18;
const PAY_STAGGER_MAX = 8;
/** A payout rising out of the house, then sliding to its winner's rail; a
 *  stake that comes down slides there with it. */
const RISE_S = 0.18;
const PAY_SLIDE_S = 0.7;
const BACK_SLIDE_S = 0.6;
/** How high a stack lifts over the felt on its way (it clears the stacks
 *  it passes; a dealer slides chips low). */
const SWEEP_ARC = 0.04;
const PAY_ARC = 0.08;

/** One leg of a moving stack: to (x, y, z) in `s` seconds, lifted `arc` at
 *  its middle. y is the stack's bottom face. */
interface ChipLeg {
  x: number;
  y: number;
  z: number;
  s: number;
  arc: number;
}

/** A stack on the move (settleChips): it waits `wait` seconds where it
 *  starts (out of sight while `hidden`: a payout still in the house), then
 *  runs its legs and is gone. `mine`: bound for the viewer's own rail. */
interface ChipRun {
  chips: readonly number[];
  dim: boolean;
  color?: string;
  at: { x: number; y: number; z: number };
  legs: ChipLeg[];
  wait: number;
  hidden: boolean;
  mine: boolean;
  seed: number;
  t: number;
}

const runLength = (r: ChipRun): number => r.wait + r.legs.reduce((a, l) => a + l.s, 0);

/** Where a moving stack's bottom chip is now, or null while it is out of
 *  sight (still in the house, or done). */
export function chipRunAt(r: Pick<ChipRun, 'at' | 'legs' | 'wait' | 'hidden' | 't'>): { x: number; y: number; z: number } | null {
  let t = r.t - r.wait;
  if (t < 0) return r.hidden ? null : r.at;
  let p = r.at;
  for (const leg of r.legs) {
    if (t < leg.s) {
      const k = leg.s > 0 ? t / leg.s : 1;
      const e = k * k * (3 - 2 * k);
      return {
        x: p.x + (leg.x - p.x) * e,
        y: p.y + (leg.y - p.y) * e + Math.sin(Math.PI * k) * leg.arc,
        z: p.z + (leg.z - p.z) * e,
      };
    }
    t -= leg.s;
    p = leg;
  }
  return null;
}

/** How deep a stack drops to sink out of sight. */
const sinkDepth = (chips: readonly unknown[]): number => chips.length * CHIP_H + 0.004;

/** The runs one settle plays (TableHandle.settleChips): the losers into the
 *  house first; then, bettor by bettor, each payout rising out of the house
 *  and sliding to its winner's rail, the stakes that come down sliding there
 *  with it. Every run drops out of sight where it ends. */
export function settleRuns(m: SettleMoves): ChipRun[] {
  const fy = FELT_Y + 0.001;
  const house = { x: m.house.x, y: fy, z: m.house.z };
  const runs: ChipRun[] = [];
  const seed = () => 401 + runs.length * 5;
  for (const s of m.lost) {
    runs.push({
      chips: s.chips, dim: s.dim, color: s.color, at: { x: s.x, y: fy + (s.lift ?? 0) * CHIP_H, z: s.z },
      legs: [{ ...house, s: SWEEP_IN_S, arc: SWEEP_ARC }, { ...house, y: fy - sinkDepth(s.chips), s: SINK_S, arc: 0 }],
      wait: 0, hidden: false, mine: false, seed: seed(), t: 0,
    });
  }
  const payAt = m.lost.length > 0 ? PAY_AFTER_LOSS_S : PAY_NO_LOSS_S;
  const turn = (order: number) => payAt + Math.min(Math.max(0, order), PAY_STAGGER_MAX) * PAY_STAGGER_S;
  for (const { s, to, order, mine } of m.back) {
    runs.push({
      chips: s.chips, dim: s.dim, color: s.color, at: { x: s.x, y: fy + (s.lift ?? 0) * CHIP_H, z: s.z },
      legs: [
        { x: to.x, y: RAIL_Y, z: to.z, s: BACK_SLIDE_S, arc: SWEEP_ARC },
        { x: to.x, y: RAIL_Y - sinkDepth(s.chips), z: to.z, s: SINK_S, arc: 0 },
      ],
      // (Leaving as its payout leaves the house: they reach the rail together.)
      wait: turn(order) + RISE_S + PAY_SLIDE_S - BACK_SLIDE_S, hidden: false, mine, seed: seed(), t: 0,
    });
  }
  for (const { chips, to, order, mine, dim, color } of m.paid) {
    if (chips.length === 0) continue;
    runs.push({
      chips, dim, color, at: { ...house, y: fy - sinkDepth(chips) },
      legs: [
        { ...house, s: RISE_S, arc: 0 },
        { x: to.x, y: RAIL_Y, z: to.z, s: PAY_SLIDE_S, arc: PAY_ARC },
        { x: to.x, y: RAIL_Y - sinkDepth(chips), z: to.z, s: SINK_S, arc: 0 },
      ],
      wait: turn(order), hidden: true, mine, seed: seed(), t: 0,
    });
  }
  return runs;
}

/** Pitch between rail stacks (a chip and a sliver of rail). */
export const RAIL_PITCH = CHIP_RADIUS * 2 + 0.006;

/** Lay a rail's chips out: stacks of up to 10 by denomination, along the rail
 *  (as many stacks as the rail's length holds — the rest stay off the table). */
export function railStacks(spec: RailSpec, counts: ReadonlyArray<{ denom: number; count: number }>): RailStack[] {
  const pitch = RAIL_PITCH;
  const fit = Math.max(1, Math.floor(spec.len / pitch));
  // Stacks of ten; never more of one denomination than the rail could show.
  const raw: Array<{ denom: number; count: number }> = [];
  for (const { denom, count } of [...counts].sort((a, b) => b.denom - a.denom)) {
    let left = count;
    for (let k = 0; left > 0 && k < fit; k++, left -= 10) raw.push({ denom, count: Math.min(10, left) });
  }
  // Too many stacks for the rail: keep one of every denomination first
  // (smallest first, so a rich player still has small chips to bet), then
  // as many of the rest as fit, largest first.
  const keep = new Set<number>();
  if (raw.length > fit) {
    for (let i = raw.length - 1; i >= 0 && keep.size < fit; i--) {
      if (i === raw.findIndex((r) => r.denom === raw[i].denom)) keep.add(i);
    }
  }
  for (let i = 0; i < raw.length && keep.size < fit; i++) keep.add(i);
  const shown = raw.filter((_, i) => keep.has(i));
  const start = -((shown.length - 1) * pitch) / 2;
  return shown.map((s, i) => {
    const off = start + i * pitch;
    return spec.axis === 'x'
      ? { x: spec.x + off, z: spec.z, denom: s.denom, count: s.count }
      : { x: spec.x, z: spec.z + off, denom: s.denom, count: s.count };
  });
}

class TableHandle implements CasinoTableVisualHandle {
  private feltStacks: readonly FeltStack[] = [];
  private rail: readonly RailStack[] = [];
  private hand: { p: FeltPoint; chips: readonly number[] } | null = null;
  private ownColor: string | undefined;
  /** A take-down waiting for its chips to leave the felt (seconds left). */
  private sweepArm: { to: FeltPoint; left: number } | null = null;
  /** Chips sliding back to the rail (t: seconds into the slide). */
  private sweeps: Array<{ s: FeltStack; to: FeltPoint; t: number }> = [];
  /** 💰 A settle's stacks on the move (settleChips). */
  private runs: ChipRun[] = [];
  private dirty = true;
  private highlightKey = '';
  private highlightIds: ReadonlySet<string> = new Set();
  private focusId: string | null = null;
  private readonly plane = new THREE.Plane();
  private readonly v = new THREE.Vector3();

  constructor(
    readonly game: 'craps' | 'roulette',
    readonly halfX: number,
    readonly halfZ: number,
    private readonly c: Common,
    private readonly dice: DicePair | null,
    private readonly pucks: Puck[],
    private readonly wheel: RouletteWheel | null,
  ) {}

  private group(): THREE.Object3D | null {
    return this.c.feltMesh.parent;
  }

  private toLocal(world: THREE.Vector3): FeltPoint | null {
    const g = this.group();
    if (!g) return null;
    const p = g.worldToLocal(world.clone());
    return { x: p.x, z: p.z };
  }

  pick(ray: THREE.Raycaster, diceGrabbable: boolean): TablePick | null {
    const targets: THREE.Object3D[] = [this.c.feltMesh, this.c.railHit, this.c.settings.mesh];
    if (this.c.takeDown.group.visible) targets.push(this.c.takeDown.mesh);
    if (diceGrabbable && this.dice) targets.push(...this.dice.meshes());
    const hits = ray.intersectObjects(targets, false);
    for (const h of hits) {
      if (h.object === this.c.settings.mesh) return { kind: 'settings' };
      if (h.object === this.c.takeDown.mesh) return { kind: 'takedown' };
      if (this.dice && this.dice.meshes().includes(h.object as THREE.Mesh)) return { kind: 'dice' };
      const p = this.toLocal(h.point);
      if (!p) continue;
      if (h.object === this.c.railHit) return { kind: 'rail', p };
      return { kind: 'felt', p };
    }
    return null;
  }

  projectToFelt(ray: THREE.Raycaster): FeltPoint | null {
    const g = this.group();
    if (!g) return null;
    g.updateMatrixWorld();
    const origin = g.localToWorld(new THREE.Vector3(0, FELT_Y, 0));
    this.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), origin);
    const hit = ray.ray.intersectPlane(this.plane, this.v);
    return hit ? this.toLocal(hit) : null;
  }

  setFeltChips(stacks: readonly FeltStack[]): void {
    if (this.sweepArm) {
      const gone = departedChips(this.feltStacks, stacks);
      if (gone.length > 0) {
        for (const s of gone) this.sweeps.push({ s, to: this.sweepArm.to, t: 0 });
        this.sweepArm = null;
      }
    }
    this.feltStacks = stacks;
    this.dirty = true;
  }

  sweepToRail(to: FeltPoint): void {
    this.sweepArm = { to, left: SWEEP_ARM_S };
  }

  settleChips(moves: SettleMoves): void {
    // (The settle moves these chips: a take-down still waiting for its
    // chips to leave would slide them a second time.)
    this.sweepArm = null;
    this.runs.push(...settleRuns(moves));
    this.dirty = true;
  }

  payingMe(): boolean {
    return this.runs.some((r) => r.mine);
  }

  setRailStacks(stacks: readonly RailStack[]): void {
    this.rail = stacks;
    this.dirty = true;
  }

  setHand(p: FeltPoint | null, chips: readonly number[]): void {
    this.hand = p && chips.length > 0 ? { p, chips } : null;
    this.dirty = true;
  }

  setOwnChipColor(color: string | null): void {
    if ((color ?? undefined) === this.ownColor) return;
    this.ownColor = color ?? undefined;
    this.dirty = true;
  }

  setHighlight(ids: ReadonlySet<string>): void {
    const key = [...ids].sort().join('|');
    if (key === this.highlightKey) return;
    this.highlightKey = key;
    this.highlightIds = ids;
    this.c.felt.repaint(ids, this.focusId);
  }

  setFocusRegion(id: string | null): void {
    if (id === this.focusId) return;
    this.focusId = id;
    this.c.felt.repaint(this.highlightIds, id);
  }

  toScreen(p: FeltPoint, camera: THREE.Camera): { x: number; y: number } | null {
    const g = this.group();
    if (!g) return null;
    g.updateMatrixWorld();
    const v = g.localToWorld(new THREE.Vector3(p.x, FELT_Y, p.z)).project(camera);
    return { x: v.x, y: v.y };
  }

  setSettingsHot(hot: boolean): void {
    this.c.settings.setHot(hot);
  }

  setTakeDown(at: { p: FeltPoint; toward: FeltPoint } | null, ready: boolean): void {
    this.c.takeDown.place(at, ready);
  }

  setTakeDownHot(hot: boolean): void {
    this.c.takeDown.setHot(hot);
  }

  pressTakeDown(): void {
    this.c.takeDown.press();
  }

  setFairBadge(fair: boolean): void {
    this.c.plaque.set(fair);
  }

  setPuck(point: number | null): void {
    for (const p of this.pucks) p.set(point);
  }

  /** The viewer's own (undimmed) stack the click is on, as its felt spot:
   *  the felt point under it, or the ray passing through a tall stack's
   *  column. null when the click is on none of them. */
  onMyStack(ray: THREE.Raycaster, p: FeltPoint): FeltPoint | null {
    const r = CHIP_RADIUS * 1.6;
    const g = this.group();
    if (g) g.updateMatrixWorld();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const hit = this.feltStacks.find((s) => {
      if (s.dim) return false;
      if (Math.hypot(s.x - p.x, s.z - p.z) <= r) return true;
      if (!g) return false;
      a.set(s.x, FELT_Y, s.z);
      b.set(s.x, FELT_Y + ((s.lift ?? 0) + s.chips.length) * CHIP_H, s.z);
      g.localToWorld(a);
      g.localToWorld(b);
      return ray.ray.distanceSqToSegment(a, b) <= CHIP_RADIUS * CHIP_RADIUS;
    });
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  reset(): void {
    this.setFeltChips([]);
    this.setHighlight(new Set());
    this.setPuck(null);
    if (this.dice) {
      this.dice.cancel();
      this.dice.restAt(CRAPS_DICE_SPOT, NEUTRAL_FACES);
    }
    this.wheel?.cancel();
    this.wheel?.restOn(null);
    this.setTakeDown(null, false);
    this.sweepArm = null;
    this.sweeps = [];
    this.runs = [];
  }

  diceRestAt(p: FeltPoint, values?: [number, number]): void {
    this.dice?.restAt(p, values);
  }

  diceHold(p: FeltPoint): void {
    this.dice?.hold(p);
  }

  diceThrow(from: FeltPoint, dir: FeltPoint, power: number, seed: number): void {
    this.dice?.throwFrom(from, dir, power, seed);
  }

  diceLand(values: [number, number]): void {
    this.dice?.land(values);
  }

  diceCancel(): void {
    this.dice?.cancel();
  }

  diceState(): 'rest' | 'held' | 'flying' | 'settling' {
    return this.dice?.state() ?? 'rest';
  }

  wheelSpin(result: number, seed: number): void {
    this.wheel?.start(result, seed);
  }

  wheelRest(result: number | null): void {
    this.wheel?.restOn(result);
  }

  wheelSpinning(): boolean {
    return this.wheel?.busy() ?? false;
  }

  private rebuildChips(): void {
    const pools = this.c.pools;
    pools.begin();
    this.feltStacks.forEach((s, i) =>
      pools.stack(s.chips, s.x, FELT_Y + 0.001 + (s.lift ?? 0) * CHIP_H, s.z, s.dim, i * 7 + 3, s.color));
    this.rail.forEach((s, i) => {
      if (s.count > 0) pools.stack(new Array(s.count).fill(s.denom), s.x, RAIL_Y, s.z, false, 101 + i, this.ownColor);
    });
    this.sweeps.forEach(({ s, to, t }, i) => {
      // Eased along the felt, lifted over the rail's lip on the way.
      const k = Math.min(1, t / SWEEP_S);
      const e = k * k * (3 - 2 * k);
      const x = s.x + (to.x - s.x) * e;
      const z = s.z + (to.z - s.z) * e;
      const y0 = FELT_Y + 0.001 + (s.lift ?? 0) * CHIP_H;
      const y = y0 + (RAIL_Y - y0) * e + Math.sin(Math.PI * k) * 0.03;
      pools.stack(s.chips, x, y, z, false, 307 + i * 5, s.color);
    });
    for (const r of this.runs) {
      const p = chipRunAt(r);
      if (p) pools.stack(r.chips, p.x, p.y, p.z, r.dim, r.seed, r.color);
    }
    if (this.hand) {
      const chips = [...this.hand.chips].sort((a, b) => b - a);
      pools.stack(chips, this.hand.p.x, FELT_Y + 0.05, this.hand.p.z, false, 211, this.ownColor);
    }
    pools.commit();
  }

  update(dt: number): void {
    if (this.dirty) {
      this.dirty = false;
      this.rebuildChips();
    }
    this.c.takeDown.update(dt);
    if (this.sweepArm) {
      this.sweepArm.left -= dt;
      if (this.sweepArm.left <= 0) this.sweepArm = null;
    }
    if (this.sweeps.length > 0) {
      for (const sw of this.sweeps) sw.t += dt;
      this.sweeps = this.sweeps.filter((sw) => sw.t < SWEEP_S);
      this.dirty = true;
    }
    if (this.runs.length > 0) {
      for (const r of this.runs) r.t += dt;
      this.runs = this.runs.filter((r) => r.t < runLength(r));
      this.dirty = true;
    }
    this.dice?.update(dt);
    for (const p of this.pucks) p.update(dt);
    this.wheel?.update(dt);
  }
}

/** The craps table's moving parts. Returns the handle (also stowed on the
 *  felt mesh's userData.casinoTable for World to file). */
export function buildCrapsPieces(ctx: PiecesCtx, halfX: number, halfZ: number): CasinoTableVisualHandle {
  const c = buildCommon(ctx, CRAPS_LAYOUT as FeltLayout<CrapsSpot>, halfX, halfZ, crapsDecor, 'right');
  const dice = new DicePair(CRAPS_LAYOUT.felt);
  ctx.attach(dice.group);
  const pucks = [new Puck(ctx, -1), new Puck(ctx, 1)];
  const handle = new TableHandle('craps', halfX, halfZ, c, dice, pucks, null);
  c.feltMesh.userData.casinoTable = handle;
  // Dice start at the stickman's spot, in front of the ⚙️ button.
  dice.restAt(CRAPS_DICE_SPOT);
  return handle;
}

/** The roulette table's moving parts (see buildCrapsPieces). */
export function buildRoulettePieces(ctx: PiecesCtx, halfX: number, halfZ: number): CasinoTableVisualHandle {
  const c = buildCommon(ctx, ROULETTE_LAYOUT as FeltLayout<RouletteSpot>, halfX, halfZ, rouletteDecor, 'front', true);
  const wheel = new RouletteWheel(ctx);
  const handle = new TableHandle('roulette', halfX, halfZ, c, null, [], wheel);
  c.feltMesh.userData.casinoTable = handle;
  return handle;
}
