/**
 * 🏮 Lantern Road: the double-wide cabinet's own four-player game. Up to
 * four friends walk a night street of an old castle town together, jump
 * barrels and rooftops, knock yokai over with a wooden staff, and reach the
 * shrine gate at the end of the road. An original game, inspired by the
 * co-op side-scrollers of the 16-bit years (the README names The Legend of
 * the Mystical Ninja): our own characters, art and level, nothing taken
 * from one.
 *
 * Pure and deterministic: no DOM, no Math.random, no clock, and no maths
 * that can differ between browsers (only integer + − × and shifts; no
 * Math.sin and friends, which JavaScriptCore and V8 may round apart). Every
 * page in the room runs the same frames on the same pads and gets the same
 * game (arcadeNativeSession.ts), and a page that joins late continues from
 * a save state, which is this module's plain-JSON state.
 *
 * THE PICTURE is 512×192 game pixels, 8:3: the double-wide cabinet's two
 * tubes side by side, 256×192 each (lanternRoadPaint.ts draws it). Positions
 * are kept in sixteenths of a pixel (SUB) so speeds can be fractional and
 * still integers.
 *
 * THE PADS are the NES pad bytes the arcade already speaks (arcadeNet
 * PAD_BIT): A jumps, B swings the staff, DOWN with A drops through a
 * bridge or roof. Bit 2 (SELECT's) is not a button here: the session sets
 * it on every seat somebody holds (PRESENT), so joining and leaving are
 * part of the frames like any press, and every copy agrees on who is in.
 * A player who steps up mid-game drops in beside the others in a puff of
 * smoke, at zero; one who steps away goes the same way.
 *
 * THE SHRINE is guarded: when the picture reaches the road's last stretch
 * the camera holds, the street's yokai flee, and the Great Lantern comes
 * down. It drifts over the group, spits fire, and slams down to send shock
 * waves along the street, then sits dazed for a while: that's when staffs
 * do the work. Only once it burns out does the gate open: its seal falls
 * away for a second first, so a group already under it sees it open.
 */

// ── The picture and the units ────────────────────────────────────────────────

export const LR_VIEW_W = 512;
export const LR_VIEW_H = 192;
/** Sixteenths of a pixel: positions and speeds are integers in these. */
export const SUB = 16;
export const LR_TILE = 16;
const TILE_SUB = LR_TILE * SUB;
export const LR_SEATS = 4;
/** The rules' revision, also the save format's. Bump it with any change
 *  that would make two copies of one match disagree: pages on different
 *  revisions never share a match (arcadeNativeGames nativeMatchGame). */
export const LR_REV = 3;

// ── Pad bits (arcadeNet PAD_BIT) ─────────────────────────────────────────────

export const PAD_A = 1 << 0;
export const PAD_B = 1 << 1;
/** SELECT's bit: set by the session on every seat somebody holds. */
export const PAD_PRESENT = 1 << 2;
export const PAD_UP = 1 << 4;
export const PAD_DOWN = 1 << 5;
export const PAD_LEFT = 1 << 6;
export const PAD_RIGHT = 1 << 7;

// ── Tuning (sub-pixels and frames, 60 a second) ─────────────────────────────

const PLAYER_W = 10 * SUB;
const PLAYER_H = 22 * SUB;
const WALK = 24;
const WALK_ACCEL = 4;
const GRAVITY = 4;
const FALL_MAX = 80;
/** Jump speed: about 55 px high, three and a half tiles. */
const JUMP = 84;
/** Let go of A while still rising faster than this and the jump is cut. */
const JUMP_CUT = 28;
/** The staff's swing, its reach, and the frames it can hit in. */
export const SWING_FRAMES = 16;
const SWING_HIT_FROM = 4;
const SWING_HIT_TO = 11;
const SWING_COOL = 6;
const STAFF_REACH = 18 * SUB;
export const MAX_HP = 3;
/** A beaten enemy's puff of smoke. */
export const DYING_FRAMES = 24;
const HURT_FRAMES = 90;
const REEL_FRAMES = 20;
const KO_FRAMES = 180;
const RESPAWN_SAFE = 120;
/** A seat must be empty this long before its player leaves the road (a
 *  pad that skips a frame or two must not pull someone out). */
const AWAY_FRAMES = 30;
const DROP_FRAMES = 12;
/** The camera's top speed, px a frame, and the margin players keep. */
const CAM_SPEED = 4;
const EDGE = 4;
/** Enemies only move within this many px of the picture. */
const WAKE_MARGIN = 64;
/** Frames the STAGE CLEAR card stays up before the road starts again. */
export const CLEAR_FRAMES = 360;
const CLEAR_BONUS = 1000;
/** Score popups (and puffs of smoke) kept at once. */
const MAX_FX = 24;
/** A puff of smoke where a player drops in or steps away. */
export const PUFF_FRAMES = 24;
/** Frames a player's seat tag shows over their head after they drop in. */
export const TAG_FRAMES = 90;

// ── The road ─────────────────────────────────────────────────────────────────
//
//  . empty          # ground (solid)     B barrel (solid)
//  = bridge         ^ roof               (both one-way: stand on, jump through)
//  c coin (mon)     o rice ball (heals)
//  w oni            g lantern ghost      h umbrella ghost
//  l hanging lantern   S stone lantern   G the shrine gate: the goal
//
// Six stretches of 32 columns, 12 rows each, ground on the bottom two.

const STRETCHES: readonly (readonly string[])[] = [
  // 1 · the town gate: a bridge to hop onto, the first oni.
  [
    '................................',
    '................................',
    '................................',
    '.........................l......',
    '................................',
    '................................',
    '...........c.c.c................',
    '................................',
    '..........======................',
    '....S..................c....w...',
    '################################',
    '################################',
  ],
  // 2 · barrels up to a rooftop, a lantern ghost.
  [
    '................................',
    '................................',
    '................................',
    '.....l..........................',
    '..................c.c.c.........',
    '................................',
    '................^^^^^^^^........',
    '.......g........................',
    '..............B.................',
    '...B......w...BB.......w...c....',
    '################################',
    '################################',
  ],
  // 3 · the river: a long bridge over it, umbrella ghosts either side.
  [
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '..........c...c...c.............',
    '................................',
    '..............g.................',
    '........==============..........',
    '...h.....................h...o..',
    '########..............##########',
    '########..............##########',
  ],
  // 4 · over the rooftops: the street drops away below.
  [
    '................................',
    '................................',
    '................c.c.............',
    '................................',
    '................................',
    '................^^^^^...........',
    '..........c.....................',
    '.........^^^^...................',
    '..............g.................',
    '..B......................w......',
    '######.................#########',
    '######.................#########',
  ],
  // 5 · the gauntlet.
  [
    '................................',
    '................................',
    '................................',
    '...l...........l...........l....',
    '................................',
    '...................g............',
    '.......g...........=====........',
    '................................',
    '..........c.c.c.........o.......',
    '.....w.....BB....w.....w....h...',
    '################################',
    '################################',
  ],
  // 6 · the shrine.
  [
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '..........g.....................',
    '................................',
    '....c.c.c...............G.......',
    '...=======......................',
    '.S.......w.....h..w.............',
    '################################',
    '################################',
  ],
];

export const LR_ROWS = 12;
/** The road as rows of characters, the stretches side by side. */
export const LR_MAP: readonly string[] = Array.from({ length: LR_ROWS }, (_, r) => STRETCHES.map((s) => s[r]).join(''));
export const LR_COLS = LR_MAP[0]!.length;
export const LR_LEVEL_W = LR_COLS * LR_TILE;

const at = (col: number, row: number): string => LR_MAP[row]?.[col] ?? '.';

/** Walls and the ground: nothing passes. Off either end of the road too. */
export function isSolid(col: number, row: number): boolean {
  if (col < 0 || col >= LR_COLS) return true;
  const c = at(col, row);
  return c === '#' || c === 'B';
}

/** Bridges and roofs: stood on from above, jumped through from below. */
export function isLedge(col: number, row: number): boolean {
  const c = at(col, row);
  return c === '=' || c === '^';
}

function findGateCol(): number {
  for (let col = 0; col < LR_COLS; col++) {
    for (let row = 0; row < LR_ROWS; row++) if (at(col, row) === 'G') return col;
  }
  return LR_COLS - 4;
}
/** The shrine gate's column: whoever walks through it clears the road. */
export const LR_GATE_COL = findGateCol();

// ── State ────────────────────────────────────────────────────────────────────

export interface LrPlayer {
  /** On the road (the seat is held). */
  on: boolean;
  /** Top-left of the body, in SUB. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: 1 | -1;
  ground: boolean;
  hp: number;
  /** Frames left of not being hurt again (blinking). */
  hurt: number;
  /** Frames left of reeling from a hit: no walking, jumping or swinging. */
  reel: number;
  /** Frames left of the staff's swing (0: not swinging). */
  swing: number;
  cool: number;
  /** Knocked out: frames until back on their feet (0: up). */
  ko: number;
  /** Frames the seat has been empty. */
  away: number;
  /** Frames left of dropping through ledges. */
  drop: number;
  /** Walk cycle, frames of walking. */
  step: number;
  score: number;
  /** Last frame's pad: presses count on the frame they start. */
  pad: number;
  /** Frames left of their seat's tag over their head (just dropped in). */
  tag: number;
}

export type LrEnemyKind = 'oni' | 'lantern' | 'kasa';

export interface LrEnemy {
  kind: LrEnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: 1 | -1;
  ground: boolean;
  hp: number;
  /** Frames of being knocked back after a hit (no walking, no hitting). */
  stun: number;
  /** Frames left of going up in smoke (0: alive). */
  dying: number;
  gone: boolean;
  /** A per-enemy timer: the ghost's bob, the umbrella's hop. */
  t: number;
  /** Where a lantern ghost floats around (SUB). */
  homeY: number;
}

export interface LrItem {
  kind: 'coin' | 'rice';
  /** Centre, in SUB. */
  x: number;
  y: number;
  taken: boolean;
}

/** A score rising off whatever earned it. */
export interface LrPop {
  x: number;
  y: number;
  points: number;
  seat: number;
  t: number;
}

/** Where a player dropped in or stepped away: a puff in their colour. */
export interface LrPuff {
  /** Centre, in SUB. */
  x: number;
  y: number;
  seat: number;
  t: number;
}

export type LrBossStage = 'wait' | 'enter' | 'fight' | 'dying' | 'done';
export type LrBossMove = 'drift' | 'spit' | 'shake' | 'fall' | 'dazed' | 'rise';

/** The Great Lantern, the shrine's guardian. */
export interface LrBoss {
  /** Waiting for the group, coming down, fighting, burning out, gone. */
  stage: LrBossStage;
  move: LrBossMove;
  /** Top-left, in SUB. */
  x: number;
  y: number;
  vy: number;
  hp: number;
  maxHp: number;
  /** Frames left of the stage (enter, dying, the gate opening once done)
   *  or of the move. */
  t: number;
  /** Frames until a staff can hit it again (it flashes). */
  hurt: number;
  face: 1 | -1;
  /** Its float's bob, frames. */
  wob: number;
  /** Drifts so far: odd ones end in fire, even ones in a slam. */
  round: number;
}

/** Its fire in the air, the flames where it lands, a slam's shock waves. */
export interface LrShot {
  kind: 'fire' | 'flame' | 'wave';
  /** Top-left, in SUB. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Frames left (flames and waves); a fire that hits someone is spent. */
  t: number;
}

export interface LrState {
  v: typeof LR_REV;
  frame: number;
  phase: 'play' | 'clear';
  /** Frames left of the STAGE CLEAR card. */
  phaseT: number;
  /** Times the road has been cleared. */
  laps: number;
  /** The camera's left edge, in px. */
  cam: number;
  rng: number;
  players: LrPlayer[];
  enemies: LrEnemy[];
  items: LrItem[];
  pops: LrPop[];
  puffs: LrPuff[];
  boss: LrBoss;
  shots: LrShot[];
}

// ── Bodies ───────────────────────────────────────────────────────────────────

const ENEMY_BOX: Readonly<Record<LrEnemyKind, { w: number; h: number; hp: number; points: number }>> = {
  oni: { w: 12 * SUB, h: 16 * SUB, hp: 2, points: 100 },
  lantern: { w: 12 * SUB, h: 14 * SUB, hp: 1, points: 150 },
  kasa: { w: 12 * SUB, h: 18 * SUB, hp: 2, points: 200 },
};

export function enemyBox(kind: LrEnemyKind): { w: number; h: number } {
  return ENEMY_BOX[kind];
}

export const LR_PLAYER_W = PLAYER_W;
export const LR_PLAYER_H = PLAYER_H;

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ground: boolean;
}

/** Move across, stopping at walls. True if it hit one. */
function moveX(b: Body, w: number, h: number, dx: number): boolean {
  if (dx === 0) return false;
  b.x += dx;
  const top = b.y >> 8;
  const bottom = (b.y + h - 1) >> 8;
  if (dx > 0) {
    const col = (b.x + w - 1) >> 8;
    for (let row = top; row <= bottom; row++) {
      if (isSolid(col, row)) {
        b.x = col * TILE_SUB - w;
        return true;
      }
    }
  } else {
    const col = b.x >> 8;
    for (let row = top; row <= bottom; row++) {
      if (isSolid(col, row)) {
        b.x = (col + 1) * TILE_SUB;
        return true;
      }
    }
  }
  return false;
}

/** Move up or down, landing on the ground and on ledges (unless dropping
 *  through them) and bumping heads on the solid. */
function moveY(b: Body, w: number, h: number, dy: number, dropping: boolean): void {
  const left = b.x >> 8;
  const right = (b.x + w - 1) >> 8;
  if (dy > 0) {
    const before = (b.y + h - 1) >> 8;
    b.y += dy;
    const row = (b.y + h - 1) >> 8;
    b.ground = false;
    for (let col = left; col <= right; col++) {
      if (isSolid(col, row) || (!dropping && row > before && isLedge(col, row) && !isSolid(col, row))) {
        b.y = row * TILE_SUB - h;
        b.vy = 0;
        b.ground = true;
        return;
      }
    }
  } else if (dy < 0) {
    b.y += dy;
    b.ground = false;
    const row = b.y >> 8;
    if (row < 0) return;
    for (let col = left; col <= right; col++) {
      if (isSolid(col, row)) {
        b.y = (row + 1) * TILE_SUB;
        b.vy = 0;
        return;
      }
    }
  }
}

/** Is there floor (ground or a ledge) right under this spot (SUB)? */
function floorAt(x: number, feetY: number): boolean {
  const col = x >> 8;
  const row = feetY >> 8;
  return isSolid(col, row) || isLedge(col, row);
}

const overlaps = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean =>
  ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

// ── Randomness (seeded, integer: mulberry32) ─────────────────────────────────

function nextRandom(s: LrState): number {
  s.rng = (s.rng + 0x6d2b79f5) | 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

// ── A new road ───────────────────────────────────────────────────────────────

function spawnEnemies(): LrEnemy[] {
  const out: LrEnemy[] = [];
  for (let row = 0; row < LR_ROWS; row++) {
    for (let col = 0; col < LR_COLS; col++) {
      const c = at(col, row);
      const kind: LrEnemyKind | null = c === 'w' ? 'oni' : c === 'g' ? 'lantern' : c === 'h' ? 'kasa' : null;
      if (!kind) continue;
      const box = ENEMY_BOX[kind];
      const x = col * TILE_SUB + ((TILE_SUB - box.w) >> 1);
      const y = (row + 1) * TILE_SUB - box.h;
      out.push({
        kind, x, y, vx: 0, vy: 0, face: -1, ground: false, hp: box.hp, stun: 0, dying: 0, gone: false,
        t: (col * 7 + row * 13) & 63, homeY: y,
      });
    }
  }
  // Left to right, so every copy updates them in the same order.
  out.sort((a, b) => a.x - b.x || a.y - b.y);
  return out;
}

function spawnItems(): LrItem[] {
  const out: LrItem[] = [];
  for (let col = 0; col < LR_COLS; col++) {
    for (let row = 0; row < LR_ROWS; row++) {
      const c = at(col, row);
      if (c !== 'c' && c !== 'o') continue;
      out.push({ kind: c === 'c' ? 'coin' : 'rice', x: col * TILE_SUB + (TILE_SUB >> 1), y: row * TILE_SUB + (TILE_SUB >> 1), taken: false });
    }
  }
  return out;
}

function newPlayer(): LrPlayer {
  return {
    on: false, x: 0, y: 0, vx: 0, vy: 0, face: 1, ground: false, hp: MAX_HP, hurt: 0, reel: 0, swing: 0, cool: 0,
    ko: 0, away: 0, drop: 0, step: 0, score: 0, pad: 0, tag: 0,
  };
}

/** The road at its first frame. `seed` is the match's (every copy uses the
 *  same one). */
export function createLanternRoad(seed: number): LrState {
  return {
    v: LR_REV, frame: 0, phase: 'play', phaseT: 0, laps: 0, cam: 0, rng: seed | 0,
    players: Array.from({ length: LR_SEATS }, newPlayer),
    enemies: spawnEnemies(),
    items: spawnItems(),
    pops: [],
    puffs: [],
    boss: newBoss(),
    shots: [],
  };
}

// ── Players ──────────────────────────────────────────────────────────────────

/** A place to stand near `px` (a column with floor and room above it),
 *  searched outward from there; the body's top-left in SUB. */
export function safeSpot(px: number): { x: number; y: number } {
  const start = Math.max(0, Math.min(LR_COLS - 1, (px / LR_TILE) | 0));
  for (let k = 0; k < LR_COLS; k++) {
    const col = start + (k & 1 ? (k + 1) >> 1 : -(k >> 1));
    if (col < 0 || col >= LR_COLS) continue;
    for (let row = 2; row < LR_ROWS; row++) {
      if ((isSolid(col, row) || isLedge(col, row)) && !isSolid(col, row - 1) && !isSolid(col, row - 2)
        && !isLedge(col, row - 1)) {
        return { x: col * TILE_SUB + ((TILE_SUB - PLAYER_W) >> 1), y: row * TILE_SUB - PLAYER_H };
      }
    }
  }
  return { x: start * TILE_SUB, y: 0 };
}

/** Where a player comes back on the road, px: at the town gate (a step
 *  apart by seat) while the picture is still there, else beside the others
 *  who are up, else the middle of the picture. */
function placeX(s: LrState, seat: number): number {
  if (s.cam === 0) return 40 + seat * 20;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < LR_SEATS; k++) {
    const o = s.players[k]!;
    if (k === seat || !isUp(o)) continue;
    sum += (o.x + (PLAYER_W >> 1)) >> 4;
    n++;
  }
  const at = n > 0 ? ((sum / n) | 0) + (seat * 2 - 3) * 10 : s.cam + (LR_VIEW_W >> 1) + (seat - 2) * 24 + 12;
  return Math.max(s.cam + 24, Math.min(s.cam + LR_VIEW_W - 24, at));
}

/** Back on the road, in a puff of smoke, with their seat's tag over them. */
function placePlayer(s: LrState, seat: number): void {
  const p = s.players[seat]!;
  const spot = safeSpot(placeX(s, seat));
  p.x = spot.x;
  p.y = spot.y;
  p.vx = 0;
  p.vy = 0;
  p.ground = false;
  p.swing = 0;
  p.cool = 0;
  p.drop = 0;
  p.reel = 0;
  p.tag = TAG_FRAMES;
  addPuff(s, p, seat);
}

/** Someone stepped up to the seat: a new player, from zero. */
function startPlayer(s: LrState, seat: number): void {
  const p = s.players[seat]!;
  p.on = true;
  p.score = 0;
  p.hp = MAX_HP;
  p.ko = 0;
  p.away = 0;
  p.hurt = RESPAWN_SAFE;
  p.face = 1;
  placePlayer(s, seat);
}

/** Up: on the road and not knocked out. */
export const isUp = (p: LrPlayer): boolean => p.on && p.ko === 0;

function hurtPlayer(p: LrPlayer, fromLeft: boolean): void {
  p.hp -= 1;
  p.hurt = HURT_FRAMES;
  p.reel = REEL_FRAMES;
  p.swing = 0;
  p.vx = fromLeft ? 32 : -32;
  p.vy = -48;
  p.ground = false;
  if (p.hp <= 0) {
    p.hp = 0;
    p.ko = KO_FRAMES;
    p.vx = 0;
  }
}

function addPop(s: LrState, x: number, y: number, points: number, seat: number): void {
  s.pops.push({ x, y, points, seat, t: 40 });
  if (s.pops.length > MAX_FX) s.pops.splice(0, s.pops.length - MAX_FX);
}

function addPuff(s: LrState, p: LrPlayer, seat: number): void {
  s.puffs.push({ x: p.x + (PLAYER_W >> 1), y: p.y + (PLAYER_H >> 1), seat, t: PUFF_FRAMES });
  if (s.puffs.length > MAX_FX) s.puffs.splice(0, s.puffs.length - MAX_FX);
}

/** The seat's PRESENT bit: in when it's held, out (in a puff) once it has
 *  been empty a moment. True while the player is on the road. */
function presence(s: LrState, seat: number, pad: number): boolean {
  const p = s.players[seat]!;
  if (pad & PAD_PRESENT) {
    p.away = 0;
    if (!p.on) startPlayer(s, seat);
  } else if (p.on && ++p.away >= AWAY_FRAMES) {
    p.on = false;
    if (p.ko === 0) addPuff(s, p, seat);
  }
  return p.on;
}

function stepPlayer(s: LrState, seat: number, pad: number): void {
  const p = s.players[seat]!;
  const pressed = pad & ~p.pad;
  p.pad = pad;
  if (!presence(s, seat, pad)) return;
  if (p.tag > 0) p.tag--;
  if (p.ko > 0) {
    if (--p.ko === 0) {
      p.hp = MAX_HP;
      p.hurt = RESPAWN_SAFE;
      placePlayer(s, seat);
    }
    return;
  }
  if (p.hurt > 0) p.hurt--;
  if (p.reel > 0) p.reel--;
  if (p.cool > 0) p.cool--;
  if (p.drop > 0) p.drop--;

  // Walk: accelerate toward the pad's direction (slower mid-swing on the ground).
  const dir = (pad & PAD_RIGHT ? 1 : 0) - (pad & PAD_LEFT ? 1 : 0);
  const knocked = p.reel > 0;
  if (!knocked) {
    const top = p.swing > 0 && p.ground ? WALK >> 1 : WALK;
    const target = dir * top;
    if (p.vx < target) p.vx = Math.min(target, p.vx + WALK_ACCEL);
    else if (p.vx > target) p.vx = Math.max(target, p.vx - WALK_ACCEL);
    if (dir !== 0 && p.swing === 0) p.face = dir > 0 ? 1 : -1;
  }
  p.step = p.ground && p.vx !== 0 ? p.step + 1 : 0;

  // Jump, or drop through a ledge with DOWN held.
  if (pressed & PAD_A && p.ground && !knocked) {
    if (pad & PAD_DOWN && standsOnLedge(p)) {
      p.drop = DROP_FRAMES;
      p.ground = false;
    } else {
      p.vy = -JUMP;
      p.ground = false;
    }
  }
  if (!(pad & PAD_A) && p.vy < -JUMP_CUT) p.vy = -JUMP_CUT;
  // The staff.
  if (pressed & PAD_B && p.swing === 0 && p.cool === 0 && !knocked) p.swing = SWING_FRAMES;
  else if (p.swing > 0 && --p.swing === 0) p.cool = SWING_COOL;

  p.vy = Math.min(FALL_MAX, p.vy + GRAVITY);
  if (moveX(p, PLAYER_W, PLAYER_H, p.vx)) p.vx = 0;
  moveY(p, PLAYER_W, PLAYER_H, p.vy, p.drop > 0);
  // Everyone stays in the picture: its edges are walls.
  const minX = (s.cam + EDGE) * SUB;
  const maxX = (s.cam + LR_VIEW_W - EDGE) * SUB - PLAYER_W;
  if (p.x < minX) {
    p.x = minX;
    if (p.vx < 0) p.vx = 0;
  } else if (p.x > maxX) {
    p.x = maxX;
    if (p.vx > 0) p.vx = 0;
  }
  // Into the river or a gap between roofs: a heart, and back on solid ground.
  if (p.y > LR_ROWS * TILE_SUB) {
    p.hp -= 1;
    p.hurt = HURT_FRAMES;
    if (p.hp <= 0) {
      p.hp = 0;
      p.ko = KO_FRAMES;
    }
    placePlayer(s, seat);
  }
}

function standsOnLedge(p: LrPlayer): boolean {
  const feet = p.y + PLAYER_H;
  const row = feet >> 8;
  const l = p.x >> 8;
  const r = (p.x + PLAYER_W - 1) >> 8;
  let ledge = false;
  for (let col = l; col <= r; col++) {
    if (isSolid(col, row)) return false;
    if (isLedge(col, row)) ledge = true;
  }
  return ledge;
}

/** The staff's reach while it can hit, or null. */
export function staffBox(p: LrPlayer): { x: number; y: number; w: number; h: number } | null {
  if (!isUp(p) || p.swing === 0) return null;
  const into = SWING_FRAMES - p.swing;
  if (into < SWING_HIT_FROM || into > SWING_HIT_TO) return null;
  const y = p.y + 4 * SUB;
  const h = 14 * SUB;
  return p.face > 0
    ? { x: p.x + PLAYER_W - 2 * SUB, y, w: STAFF_REACH, h }
    : { x: p.x - STAFF_REACH + 2 * SUB, y, w: STAFF_REACH, h };
}

// ── The camera ───────────────────────────────────────────────────────────────

function stepCamera(s: LrState): void {
  // The Great Lantern's fight slides the picture onto the shrine and holds
  // it there (stragglers are walked along by its left edge).
  const stage = s.boss.stage;
  if (stage === 'enter' || stage === 'fight' || stage === 'dying') {
    s.cam = Math.min(LR_ARENA_CAM, s.cam + CAM_SPEED);
    return;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of s.players) {
    if (!isUp(p)) continue;
    const cx = (p.x + (PLAYER_W >> 1)) >> 4;
    if (cx < lo) lo = cx;
    if (cx > hi) hi = cx;
  }
  if (lo === Infinity) return;
  let target = ((lo + hi) >> 1) - (LR_VIEW_W >> 1);
  target = Math.max(0, Math.min(LR_LEVEL_W - LR_VIEW_W, target));
  // Never so far that someone ends up outside the picture.
  target = Math.min(target, lo - (PLAYER_W >> 5) - EDGE);
  target = Math.max(target, hi + (PLAYER_W >> 5) + EDGE - LR_VIEW_W);
  target = Math.max(0, Math.min(LR_LEVEL_W - LR_VIEW_W, target));
  if (target > s.cam) s.cam = Math.min(target, s.cam + CAM_SPEED);
  else if (target < s.cam) s.cam = Math.max(target, s.cam - CAM_SPEED);
}

// ── Enemies ──────────────────────────────────────────────────────────────────

function nearestUp(s: LrState, x: number): LrPlayer | null {
  let best: LrPlayer | null = null;
  let bestD = Infinity;
  for (const p of s.players) {
    if (!isUp(p)) continue;
    const d = Math.abs(p.x - x);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** A bob of ±`amp` over `period` frames (a power of two), integer only. */
function bob(t: number, period: number, amp: number): number {
  const half = period >> 1;
  const k = t & (period - 1);
  const tri = k < half ? k : period - k; // 0 → half → 0
  return ((tri * 2 - half) * amp) / half | 0;
}

function stepEnemy(s: LrState, e: LrEnemy): void {
  if (e.gone) return;
  if (e.dying > 0) {
    if (--e.dying === 0) e.gone = true;
    return;
  }
  const box = ENEMY_BOX[e.kind];
  const px = e.x >> 4;
  if (px < s.cam - WAKE_MARGIN || px > s.cam + LR_VIEW_W + WAKE_MARGIN) return;
  e.t = (e.t + 1) & 0xffff;
  if (e.stun > 0) e.stun--;

  if (e.kind === 'lantern') {
    // Floats through everything toward the nearest player, bobbing.
    const target = nearestUp(s, e.x);
    if (e.stun > 0) {
      e.x += e.vx;
      e.vx = (e.vx * 7) >> 3;
    } else if (target) {
      const dx = target.x - e.x;
      e.face = dx < 0 ? -1 : 1;
      if (Math.abs(dx) < 220 * SUB) e.x += e.face * 6;
    }
    e.y = e.homeY + bob(e.t, 128, 12 * SUB);
    return;
  }

  e.vy = Math.min(FALL_MAX, e.vy + GRAVITY);
  if (e.stun > 0) {
    e.vx = (e.vx * 7) >> 3;
  } else if (e.kind === 'oni') {
    e.vx = e.face * 8;
    // Turn round at a ledge's end, too.
    if (e.ground) {
      const ahead = e.face > 0 ? e.x + box.w + 2 * SUB : e.x - 2 * SUB;
      if (!floorAt(ahead, e.y + box.h + 2 * SUB)) e.face = e.face > 0 ? -1 : 1;
    }
  } else {
    // The umbrella hops at the nearest player, every second or so.
    if (e.ground) {
      e.vx = 0;
      if ((e.t & 63) === 0) {
        const target = nearestUp(s, e.x);
        if (target) e.face = target.x < e.x ? -1 : 1;
        e.vx = e.face * 16;
        e.vy = -64 - (nextRandom(s) & 15);
        e.ground = false;
      }
    }
  }
  if (moveX(e, box.w, box.h, e.vx) && e.stun === 0) e.face = e.face > 0 ? -1 : 1;
  moveY(e, box.w, box.h, e.vy, false);
  if (e.y > LR_ROWS * TILE_SUB) e.gone = true;
}

function hitEnemies(s: LrState): void {
  for (let seat = 0; seat < LR_SEATS; seat++) {
    const p = s.players[seat]!;
    const staff = staffBox(p);
    if (!staff) continue;
    for (const e of s.enemies) {
      if (e.gone || e.dying > 0 || e.stun > 0) continue;
      const box = ENEMY_BOX[e.kind];
      if (!overlaps(staff.x, staff.y, staff.w, staff.h, e.x, e.y, box.w, box.h)) continue;
      e.hp -= 1;
      e.stun = 18;
      e.vx = p.face * 40;
      if (e.kind !== 'lantern') {
        e.vy = -40;
        e.ground = false;
      }
      if (e.hp <= 0) {
        e.dying = DYING_FRAMES;
        p.score += box.points;
        addPop(s, e.x + (box.w >> 1), e.y, box.points, seat);
      }
    }
  }
}

function touchEnemies(s: LrState): void {
  for (const p of s.players) {
    if (!isUp(p) || p.hurt > 0) continue;
    for (const e of s.enemies) {
      if (e.gone || e.dying > 0 || e.stun > 0) continue;
      const box = ENEMY_BOX[e.kind];
      if (!overlaps(p.x, p.y, PLAYER_W, PLAYER_H, e.x + SUB * 2, e.y + SUB * 2, box.w - SUB * 4, box.h - SUB * 3)) continue;
      hurtPlayer(p, e.x + (box.w >> 1) < p.x + (PLAYER_W >> 1));
      break;
    }
  }
}

function collectItems(s: LrState): void {
  for (let seat = 0; seat < LR_SEATS; seat++) {
    const p = s.players[seat]!;
    if (!isUp(p)) continue;
    for (const it of s.items) {
      if (it.taken) continue;
      const r = (it.kind === 'coin' ? 5 : 6) * SUB;
      if (!overlaps(p.x, p.y, PLAYER_W, PLAYER_H, it.x - r, it.y - r, r * 2, r * 2)) continue;
      it.taken = true;
      if (it.kind === 'coin') {
        p.score += 50;
        addPop(s, it.x, it.y - r, 50, seat);
      } else if (p.hp < MAX_HP) {
        p.hp += 1;
      } else {
        p.score += 300;
        addPop(s, it.x, it.y - r, 300, seat);
      }
    }
  }
}

// ── The Great Lantern ────────────────────────────────────────────────────────

/** The picture the fight holds: the road's last. */
export const LR_ARENA_CAM = LR_LEVEL_W - LR_VIEW_W;
/** Anyone up who gets this far (px) brings it down. */
export const LR_ARENA_TRIGGER_X = LR_ARENA_CAM + 160;
const BOSS_W = 48 * SUB;
const BOSS_H = 56 * SUB;
/** The street's top, SUB: where it lands and where fire burns. */
const STREET_Y = (LR_ROWS - 2) * TILE_SUB;
/** Its top while it floats: low enough to reach with a jump and a swing. */
const BOSS_FLOAT_Y = 30 * SUB;
const BOSS_ENTER_FRAMES = 120;
/** Hits it takes: more for more players, more each lap (capped). */
const BOSS_HP = 16;
const BOSS_HP_PER_PLAYER = 4;
const BOSS_HP_PER_LAP = 4;
/** Frames after a hit before the next one lands (from anyone). */
const BOSS_HIT_GAP = 12;
const BOSS_HIT_POINTS = 50;
export const BOSS_DYING_FRAMES = 150;
/** Its seal falling away once it is gone: the gate opens before anyone
 *  can go through, even a group already standing under it. */
export const GATE_OPEN_FRAMES = 60;
/** Every player on the road gets this when it burns out. */
const BOSS_BONUS = 3000;
const DRIFT_FRAMES = 150;
const DRIFT_SPEED = 10;
const SPIT_FRAMES = 100;
const SHAKE_FRAMES = 40;
const FALL_ACCEL = 6;
const DAZED_FRAMES = 150;
const RISE_SPEED = 12;
const MAX_SHOTS = 16;
const FIRE_GRAVITY = 2;
export const FLAME_FRAMES = 50;
const WAVE_SPEED = 40;
export const WAVE_FRAMES = 110;

const SHOT_BOX: Readonly<Record<LrShot['kind'], { w: number; h: number }>> = {
  fire: { w: 8 * SUB, h: 8 * SUB },
  flame: { w: 10 * SUB, h: 12 * SUB },
  wave: { w: 14 * SUB, h: 10 * SUB },
};

export function bossBox(): { w: number; h: number } {
  return { w: BOSS_W, h: BOSS_H };
}

export function shotBox(kind: LrShot['kind']): { w: number; h: number } {
  return SHOT_BOX[kind];
}

function newBoss(): LrBoss {
  return {
    stage: 'wait', move: 'drift', x: (LR_ARENA_CAM + 360) * SUB, y: -BOSS_H, vy: 0, hp: 0, maxHp: 0, t: 0, hurt: 0,
    face: -1, wob: 0, round: 0,
  };
}

/** The middle of the players who are up, SUB, or null. */
function groupCentre(s: LrState): number | null {
  let sum = 0;
  let n = 0;
  for (const p of s.players) {
    if (!isUp(p)) continue;
    sum += p.x + (PLAYER_W >> 1);
    n++;
  }
  return n > 0 ? (sum / n) | 0 : null;
}

/** A player who is up, picked with the game's dice, or null. */
function randomUp(s: LrState): LrPlayer | null {
  const up = s.players.filter(isUp);
  return up.length ? up[nextRandom(s) % up.length]! : null;
}

function addShot(s: LrState, shot: LrShot): void {
  if (s.shots.length < MAX_SHOTS) s.shots.push(shot);
}

function spitFire(s: LrState, b: LrBoss): void {
  const target = randomUp(s);
  if (!target) return;
  const fire = SHOT_BOX.fire;
  const mx = b.x + (BOSS_W >> 1) - (fire.w >> 1);
  const my = b.y + BOSS_H - 14 * SUB;
  const vx = Math.max(-48, Math.min(48, ((target.x + (PLAYER_W >> 1) - mx) / 44) | 0));
  addShot(s, { kind: 'fire', x: mx, y: my, vx, vy: -20, t: 0 });
}

function startMove(b: LrBoss, move: LrBossMove, t: number): void {
  b.move = move;
  b.t = t;
}

function stepBoss(s: LrState): void {
  const b = s.boss;
  if (b.hurt > 0) b.hurt--;
  if (b.stage === 'wait') {
    if (!s.players.some((p) => isUp(p) && p.x + (PLAYER_W >> 1) >= LR_ARENA_TRIGGER_X * SUB)) return;
    // The group reached the shrine: the street's yokai flee, and down it comes.
    const on = s.players.filter((p) => p.on).length;
    b.stage = 'enter';
    b.t = BOSS_ENTER_FRAMES;
    b.maxHp = BOSS_HP + BOSS_HP_PER_PLAYER * Math.max(1, on) + BOSS_HP_PER_LAP * Math.min(4, s.laps);
    b.hp = b.maxHp;
    for (const e of s.enemies) if (!e.gone && e.dying === 0) e.dying = DYING_FRAMES;
    return;
  }
  if (b.stage === 'enter') {
    b.t--;
    b.y = BOSS_FLOAT_Y - (((BOSS_FLOAT_Y + BOSS_H) * b.t) / BOSS_ENTER_FRAMES | 0);
    if (b.t <= 0) {
      b.stage = 'fight';
      b.wob = 0;
      startMove(b, 'drift', DRIFT_FRAMES);
    }
    return;
  }
  if (b.stage === 'dying') {
    if (--b.t <= 0) {
      b.stage = 'done';
      b.t = GATE_OPEN_FRAMES;
    }
    return;
  }
  if (b.stage === 'done') {
    if (b.t > 0) b.t--;
    return;
  }
  if (b.stage !== 'fight') return;

  if (b.t > 0) b.t--;
  const minX = (LR_ARENA_CAM + 12) * SUB;
  const maxX = (LR_ARENA_CAM + LR_VIEW_W - 12) * SUB - BOSS_W;
  const float = () => {
    b.wob = (b.wob + 1) & 0xffff;
    b.y = BOSS_FLOAT_Y + bob(b.wob + 16, 64, 6 * SUB);
  };
  switch (b.move) {
    case 'drift': {
      // Over the middle of the group, bobbing.
      const centre = groupCentre(s);
      if (centre !== null) {
        const want = Math.max(minX, Math.min(maxX, centre - (BOSS_W >> 1)));
        const dx = Math.max(-DRIFT_SPEED, Math.min(DRIFT_SPEED, want - b.x));
        b.x += dx;
        if (dx !== 0) b.face = dx < 0 ? -1 : 1;
      }
      float();
      if (b.t === 0) {
        b.round = (b.round + 1) & 0xffff;
        if (b.round & 1) startMove(b, 'spit', SPIT_FRAMES);
        else startMove(b, 'shake', SHAKE_FRAMES);
      }
      break;
    }
    case 'spit':
      float();
      if (b.t === 75 || b.t === 50 || b.t === 25) spitFire(s, b);
      if (b.t === 0) startMove(b, 'drift', DRIFT_FRAMES);
      break;
    case 'shake':
      // It trembles (the painter shakes it): a slam is coming.
      if (b.t === 0) {
        b.vy = 0;
        startMove(b, 'fall', 0);
      }
      break;
    case 'fall':
      b.vy = Math.min(FALL_MAX + 40, b.vy + FALL_ACCEL);
      b.y += b.vy;
      if (b.y >= STREET_Y - BOSS_H) {
        // It lands: shock waves run out along the street both ways.
        b.y = STREET_Y - BOSS_H;
        b.vy = 0;
        const wave = SHOT_BOX.wave;
        const y = STREET_Y - wave.h;
        addShot(s, { kind: 'wave', x: b.x - wave.w, y, vx: -WAVE_SPEED, vy: 0, t: WAVE_FRAMES });
        addShot(s, { kind: 'wave', x: b.x + BOSS_W, y, vx: WAVE_SPEED, vy: 0, t: WAVE_FRAMES });
        startMove(b, 'dazed', DAZED_FRAMES);
      }
      break;
    case 'dazed':
      if (b.t === 0) startMove(b, 'rise', 0);
      break;
    case 'rise':
      b.y -= RISE_SPEED;
      if (b.y <= BOSS_FLOAT_Y) {
        b.y = BOSS_FLOAT_Y;
        b.wob = 0;
        startMove(b, 'drift', DRIFT_FRAMES);
      }
      break;
  }
}

function stepShots(s: LrState): void {
  if (s.shots.length === 0) return;
  const left = LR_ARENA_CAM * SUB - 32 * SUB;
  const right = (LR_ARENA_CAM + LR_VIEW_W) * SUB + 32 * SUB;
  for (const sh of s.shots) {
    if (sh.kind === 'fire') {
      // Spent on someone last frame: it goes, and never lands as a flame.
      if (sh.t < 0) continue;
      sh.vy = Math.min(FALL_MAX, sh.vy + FIRE_GRAVITY);
      sh.x += sh.vx;
      sh.y += sh.vy;
      if (sh.y + SHOT_BOX.fire.h >= STREET_Y) {
        // It lands and burns a while where it fell.
        const flame = SHOT_BOX.flame;
        sh.kind = 'flame';
        sh.x += (SHOT_BOX.fire.w - flame.w) >> 1;
        sh.y = STREET_Y - flame.h;
        sh.vx = 0;
        sh.vy = 0;
        sh.t = FLAME_FRAMES;
      }
    } else if (sh.kind === 'flame') {
      sh.t--;
    } else {
      sh.x += sh.vx;
      sh.t--;
    }
  }
  s.shots = s.shots.filter((sh) =>
    (sh.kind === 'fire' ? sh.t >= 0 : sh.t > 0) && sh.x > left && sh.x < right);
}

/** Staffs on the Great Lantern: one hit at a time, then it flashes. */
function hitBoss(s: LrState): void {
  const b = s.boss;
  if (b.stage !== 'fight' || b.hurt > 0) return;
  for (let seat = 0; seat < LR_SEATS; seat++) {
    const p = s.players[seat]!;
    const staff = staffBox(p);
    if (!staff || !overlaps(staff.x, staff.y, staff.w, staff.h, b.x, b.y, BOSS_W, BOSS_H)) continue;
    b.hp -= 1;
    b.hurt = BOSS_HIT_GAP;
    p.score += BOSS_HIT_POINTS;
    addPop(s, staff.x + (staff.w >> 1), staff.y, BOSS_HIT_POINTS, seat);
    if (b.hp <= 0) {
      // It burns out: the fire goes with it, and everyone on the road shares the win.
      b.hp = 0;
      b.stage = 'dying';
      b.t = BOSS_DYING_FRAMES;
      s.shots = [];
      for (let k = 0; k < LR_SEATS; k++) {
        const q = s.players[k]!;
        if (!q.on) continue;
        q.score += BOSS_BONUS;
        addPop(s, q.x + (PLAYER_W >> 1), q.y, BOSS_BONUS, k);
      }
    }
    return;
  }
}

/** Its body (unless it sits dazed), its fire and its waves hurt. */
function touchBoss(s: LrState): void {
  const b = s.boss;
  if (b.stage !== 'fight' && s.shots.length === 0) return;
  for (const p of s.players) {
    if (!isUp(p) || p.hurt > 0) continue;
    const mid = p.x + (PLAYER_W >> 1);
    if (b.stage === 'fight' && b.move !== 'dazed'
      && overlaps(p.x, p.y, PLAYER_W, PLAYER_H, b.x + 6 * SUB, b.y + 6 * SUB, BOSS_W - 12 * SUB, BOSS_H - 8 * SUB)) {
      hurtPlayer(p, b.x + (BOSS_W >> 1) < mid);
      continue;
    }
    for (const sh of s.shots) {
      const box = SHOT_BOX[sh.kind];
      if (sh.kind === 'fire' && sh.t < 0) continue;
      if (!overlaps(p.x, p.y, PLAYER_W, PLAYER_H, sh.x + SUB, sh.y + SUB, box.w - 2 * SUB, box.h - SUB)) continue;
      hurtPlayer(p, sh.x + (box.w >> 1) < mid);
      if (sh.kind === 'fire') sh.t = -1; // spent
      break;
    }
  }
}

// ── The frame ────────────────────────────────────────────────────────────────

/** Everyone back at the start of the road, scores kept. */
function newLap(s: LrState): void {
  s.laps += 1;
  s.cam = 0;
  s.enemies = spawnEnemies();
  s.items = spawnItems();
  s.pops = [];
  s.puffs = [];
  s.boss = newBoss();
  s.shots = [];
  for (let seat = 0; seat < LR_SEATS; seat++) {
    const p = s.players[seat]!;
    if (!p.on) continue;
    p.hp = MAX_HP;
    p.ko = 0;
    p.hurt = RESPAWN_SAFE;
    p.face = 1;
    placePlayer(s, seat);
  }
}

/**
 * Run one frame on the four seats' pads (seat 0 first). Mutates `s`.
 */
export function stepLanternRoad(s: LrState, pads: readonly number[]): void {
  s.frame = (s.frame + 1) >>> 0;
  for (const pop of s.pops) {
    pop.t -= 1;
    pop.y -= 8;
  }
  if (s.pops.length && s.pops[0]!.t <= 0) s.pops = s.pops.filter((p) => p.t > 0);
  for (const puff of s.puffs) puff.t -= 1;
  if (s.puffs.length && s.puffs[0]!.t <= 0) s.puffs = s.puffs.filter((p) => p.t > 0);

  if (s.phase === 'clear') {
    // The card is up: players come and go, nobody moves.
    for (let seat = 0; seat < LR_SEATS; seat++) {
      const pad = (pads[seat] ?? 0) & 0xff;
      s.players[seat]!.pad = pad;
      presence(s, seat, pad);
    }
    if (--s.phaseT <= 0) {
      s.phase = 'play';
      s.phaseT = 0;
      newLap(s);
    }
    return;
  }

  for (let seat = 0; seat < LR_SEATS; seat++) stepPlayer(s, seat, (pads[seat] ?? 0) & 0xff);
  stepCamera(s);
  for (const e of s.enemies) stepEnemy(s, e);
  stepBoss(s);
  stepShots(s);
  hitEnemies(s);
  hitBoss(s);
  touchEnemies(s);
  touchBoss(s);
  collectItems(s);
  if (s.enemies.length > 0 && s.enemies.every((e) => e.gone)) s.enemies = [];
  else if (s.frame % 600 === 0) s.enemies = s.enemies.filter((e) => !e.gone);

  // Through the shrine gate, once its guardian is gone and the gate is open:
  // the road is cleared.
  const gateX = (LR_GATE_COL * TILE_SUB) + (TILE_SUB >> 1);
  if (s.boss.stage === 'done' && s.boss.t === 0 && s.players.some((p) => isUp(p) && p.x + (PLAYER_W >> 1) >= gateX)) {
    s.phase = 'clear';
    s.phaseT = CLEAR_FRAMES;
    for (let seat = 0; seat < LR_SEATS; seat++) {
      const p = s.players[seat]!;
      if (!p.on) continue;
      p.score += CLEAR_BONUS;
      p.vx = 0;
      p.swing = 0;
    }
  }
}

// ── Checks and save states ───────────────────────────────────────────────────

/** A 6-bit fingerprint of the whole state: copies in step compare these. */
export function checkLanternRoad(s: LrState): number {
  const text = JSON.stringify(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h ^ (h >>> 6) ^ (h >>> 12) ^ (h >>> 18) ^ (h >>> 24)) & 0x3f;
}

const isInt = (v: unknown, lo = -0x7fffffff, hi = 0x7fffffff): v is number =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFace = (v: unknown): v is 1 | -1 => v === 1 || v === -1;
/** No more than this in a save state (the road has fewer of each). */
const MAX_LIST = 256;

function isPlayer(v: unknown): v is LrPlayer {
  if (!isObj(v)) return false;
  return isBool(v.on) && isInt(v.x) && isInt(v.y) && isInt(v.vx) && isInt(v.vy) && isFace(v.face)
    && isBool(v.ground) && isInt(v.hp, 0, MAX_HP) && isInt(v.hurt, 0, 0xffff) && isInt(v.reel, 0, 0xff)
    && isInt(v.swing, 0, SWING_FRAMES)
    && isInt(v.cool, 0, 0xff) && isInt(v.ko, 0, 0xffff) && isInt(v.away, 0, 0xffff) && isInt(v.drop, 0, 0xff)
    && isInt(v.step, 0, 0x7fffffff) && isInt(v.score, 0, Number.MAX_SAFE_INTEGER) && isInt(v.pad, 0, 0xff)
    && isInt(v.tag, 0, TAG_FRAMES);
}

function isEnemy(v: unknown): v is LrEnemy {
  if (!isObj(v)) return false;
  return (v.kind === 'oni' || v.kind === 'lantern' || v.kind === 'kasa')
    && isInt(v.x) && isInt(v.y) && isInt(v.vx) && isInt(v.vy) && isFace(v.face) && isBool(v.ground)
    && isInt(v.hp, -8, 8) && isInt(v.stun, 0, 0xff) && isInt(v.dying, 0, DYING_FRAMES) && isBool(v.gone)
    && isInt(v.t, 0, 0xffff) && isInt(v.homeY);
}

function isItem(v: unknown): v is LrItem {
  return isObj(v) && (v.kind === 'coin' || v.kind === 'rice') && isInt(v.x) && isInt(v.y) && isBool(v.taken);
}

function isPuff(v: unknown): v is LrPuff {
  return isObj(v) && isInt(v.x) && isInt(v.y) && isInt(v.seat, 0, LR_SEATS - 1) && isInt(v.t, 0, PUFF_FRAMES);
}

const BOSS_STAGES: readonly unknown[] = ['wait', 'enter', 'fight', 'dying', 'done'];
const BOSS_MOVES: readonly unknown[] = ['drift', 'spit', 'shake', 'fall', 'dazed', 'rise'];

function isBoss(v: unknown): v is LrBoss {
  if (!isObj(v)) return false;
  // Its timer's top depends on the stage: the painter reads it as a fraction.
  const tMax = v.stage === 'enter' ? BOSS_ENTER_FRAMES : v.stage === 'dying' ? BOSS_DYING_FRAMES
    : v.stage === 'done' ? GATE_OPEN_FRAMES : Math.max(DRIFT_FRAMES, SPIT_FRAMES, SHAKE_FRAMES, DAZED_FRAMES);
  return BOSS_STAGES.includes(v.stage) && BOSS_MOVES.includes(v.move)
    && isInt(v.x) && isInt(v.y) && isInt(v.vy) && isInt(v.maxHp, 0, 999) && isInt(v.hp, 0, v.maxHp as number)
    && isInt(v.t, 0, tMax) && isInt(v.hurt, 0, BOSS_HIT_GAP) && isFace(v.face) && isInt(v.wob, 0, 0xffff)
    && isInt(v.round, 0, 0xffff);
}

function isShot(v: unknown): v is LrShot {
  if (!isObj(v) || (v.kind !== 'fire' && v.kind !== 'flame' && v.kind !== 'wave')) return false;
  const tMax = v.kind === 'flame' ? FLAME_FRAMES : v.kind === 'wave' ? WAVE_FRAMES : 0;
  return isInt(v.x) && isInt(v.y) && isInt(v.vx, -0xffff, 0xffff) && isInt(v.vy, -0xffff, 0xffff)
    && isInt(v.t, -1, tMax);
}

function isPop(v: unknown): v is LrPop {
  return isObj(v) && isInt(v.x) && isInt(v.y) && isInt(v.points, 0, 1e9) && isInt(v.seat, 0, LR_SEATS - 1) && isInt(v.t, -1, 0xff);
}

const listOf = <T>(v: unknown, item: (x: unknown) => x is T, max = MAX_LIST): v is T[] =>
  Array.isArray(v) && v.length <= max && v.every(item);

/** A save state as a peer sent it: the state if it is one, else null. The
 *  shape is checked all the way down, so nothing else reaches a frame. */
export function restoreLanternRoad(raw: unknown): LrState | null {
  if (!isObj(raw)) return null;
  const s = raw;
  if (s.v !== LR_REV || !isInt(s.frame, 0, 0xffffffff) || (s.phase !== 'play' && s.phase !== 'clear')
    || !isInt(s.phaseT, 0, CLEAR_FRAMES) || !isInt(s.laps, 0, 0xffffff)
    || !isInt(s.cam, 0, LR_LEVEL_W - LR_VIEW_W) || !isInt(s.rng)) return null;
  if (!Array.isArray(s.players) || s.players.length !== LR_SEATS || !s.players.every(isPlayer)) return null;
  if (!listOf(s.enemies, isEnemy) || !listOf(s.items, isItem) || !listOf(s.pops, isPop, MAX_FX)) return null;
  if (!listOf(s.puffs, isPuff, MAX_FX) || !isBoss(s.boss) || !listOf(s.shots, isShot, MAX_SHOTS)) return null;
  return s as unknown as LrState;
}
