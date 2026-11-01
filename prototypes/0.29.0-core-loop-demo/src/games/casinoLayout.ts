/**
 * 🎲🎡 The 3D felts (#226) — the ONE description of where every bet sits on
 * the craps and roulette tables, shared by the felt painter (casinoTable3d.ts),
 * the click hit-test and the chip placement (casinoTableSession.ts).
 *
 * PURE: no DOM, no THREE. Every coordinate is in metres in the table's LOCAL
 * frame at rot 0 — x along the table's length, z across it (−z is the side the
 * focus camera has always looked from), origin at the table centre. The felt
 * plane is the table top; heights live with the renderer.
 *
 * THE CRAPS FELT is the real bank-craps layout, scaled to the 3×1 table: two
 * mirrored ends, each with the PASS LINE wrapping its rail, the DON'T PASS
 * bar, the FIELD, BIG 6/8 in the corner, the COME box and the six number boxes
 * with the DON'T COME bar beside them; the proposition box sits in the middle,
 * in front of the stickman (+z rail), with the ⚙️ table-settings button above
 * it. Both ends take the same bets — a chip lands on the end nearer its owner.
 *
 * THE ROULETTE FELT is the classic single-zero layout beside the wheel: 0 at
 * the wheel end, the 3×12 number grid, the 2:1 columns at the far end, the
 * dozens and the even-money boxes along the −z player rail.
 */

import { HARD_NUMBERS } from './craps';
import type { CrapsBet } from './craps';
import { pocketColor } from './roulette';
import type { RouletteBet } from './roulette';

/** An axis-aligned felt area (x0 < x1, z0 < z1). */
export interface FeltRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface FeltPoint {
  x: number;
  z: number;
}

/** One printed, clickable betting area. */
export interface FeltRegion<B> {
  /** Stable id, unique per felt (e.g. `pass@+`, `place:6@-`, `straight:17`). */
  id: string;
  /** The bet a chip dropped here makes (amount comes from the hand). */
  bet: B;
  /** Paint + hit area (a bet can span several rectangles — the pass line's L). */
  rects: FeltRect[];
  /** Printed caption. */
  label: string;
  /** Smaller second line (the payout), optional. */
  sub?: string;
  /** Fill colour, or null for plain felt. */
  fill: string | null;
  /** Text colour override (default cream). */
  ink?: string;
  /** Caption size in metres (cap height). */
  textSize: number;
  /** Caption rotation (radians, counter-clockwise seen from above). */
  textRot?: number;
  /** A painted diamond in this colour instead of a caption (red / black). */
  diamond?: string;
  /** Where chips for this bet stack. */
  chipRect: FeltRect;
  /** Which of `rects` carries the caption and the keyboard anchor (default:
   *  the largest). */
  caption?: number;
  /** Paint this outline instead of `rects` (a number box drawn whole while
   *  its odds bands take the clicks at its top and bottom). */
  frame?: FeltRect;
  /** A band inside another box (odds): a dashed hairline, not a printed box. */
  faint?: boolean;
  /** Which end of the craps table (−1 / +1); 0 for the centre and roulette. */
  side: -1 | 0 | 1;
}

/** A round button printed on the felt (⚙️ settings). */
export interface FeltButton {
  x: number;
  z: number;
  r: number;
}

/** The felt's outline plus everything printed on it. */
export interface FeltLayout<B> {
  felt: FeltRect;
  regions: FeltRegion<B>[];
  settings: FeltButton;
}

export type CrapsSpot = { type: CrapsBet['type']; pick?: number };
export type RouletteSpot = { type: RouletteBet['type']; pick?: number };

/** Grouping key for a bet's chips — one stack per player per key. */
export function spotKey(b: { type: string; pick?: number }): string {
  return `${b.type}:${b.pick ?? ''}`;
}

const rect = (x0: number, z0: number, x1: number, z1: number): FeltRect => ({
  x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1),
});

export function inRect(r: FeltRect, p: FeltPoint): boolean {
  return p.x >= r.x0 && p.x < r.x1 && p.z >= r.z0 && p.z < r.z1;
}

export function rectCentre(r: FeltRect): FeltPoint {
  return { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
}

/** The region under a felt point, or null (the plain felt between boxes). */
export function hitRegion<B>(layout: FeltLayout<B>, p: FeltPoint): FeltRegion<B> | null {
  for (const rg of layout.regions) {
    if (rg.rects.some((r) => inRect(r, p))) return rg;
  }
  return null;
}

/** The rect a region's caption is printed in: `caption` when set, else its
 *  largest. */
export function captionRect<B>(rg: FeltRegion<B>): FeltRect {
  if (rg.caption !== undefined && rg.rects[rg.caption]) return rg.rects[rg.caption];
  return rg.rects.reduce((a, b) =>
    (b.x1 - b.x0) * (b.z1 - b.z0) > (a.x1 - a.x0) * (a.z1 - a.z0) ? b : a);
}

/** A region's anchor: the centre of its caption rect (where its caption is
 *  printed, and where keyboard play points at it). */
export function regionCenter<B>(rg: FeltRegion<B>): FeltPoint {
  const main = captionRect(rg);
  return { x: (main.x0 + main.x1) / 2, z: (main.z0 + main.z1) / 2 };
}

/**
 * Keyboard play's arrow keys: from point `from`, the nearest other point
 * lying in direction (dx, dy) — screen space, so ↑ is up on screen whichever
 * side of the table you stand. Points well off the arrow's axis cost more
 * than points straight along it. -1 when nothing lies that way.
 */
export function nearestInDirection(
  points: ReadonlyArray<{ x: number; y: number } | null>,
  from: number,
  dx: number,
  dy: number,
): number {
  const o = points[from];
  if (!o) return -1;
  let best = -1;
  let bestCost = Infinity;
  points.forEach((q, i) => {
    if (!q || i === from) return;
    const vx = q.x - o.x, vy = q.y - o.y;
    const along = vx * dx + vy * dy;
    if (along <= 1e-6) return;
    const across = Math.abs(vx * dy - vy * dx);
    const cost = along + across * 2.5;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  });
  return best;
}

export function hitSettings(layout: FeltLayout<unknown>, p: FeltPoint): boolean {
  const b = layout.settings;
  return Math.hypot(p.x - b.x, p.z - b.z) <= b.r;
}

// ── 🎲 Craps ─────────────────────────────────────────────────────────────────

/** Felt extent: the craps top inside its padded rail (see buildCrapsTable). */
export const CRAPS_FELT: FeltRect = rect(-1.37, -0.42, 1.37, 0.42);

const CR = {
  inner: 0.36,      // |x| where each end starts (the centre box is inside)
  passIn: -0.335,   // top edge of the pass line's long strip
  oddsIn: -0.382,   // top edge of the pass-odds band behind the line
  dpIn: -0.255,     // top edge of the don't pass bar
  fieldIn: -0.1,    // top edge of the field
  comeIn: 0.14,     // top edge of the come box (number boxes above)
  endIn: 1.285,     // |x| where the pass line's end strip starts
  bigIn: 1.06,      // |x| where big 6/8 start
  numIn: 0.52,      // |x| where the number boxes start (DC bar inside)
};

/** The six number boxes, left to right as the −z rail reads them. */
export const CRAPS_NUMBERS = [4, 5, 6, 8, 9, 10] as const;

const NUM_W = (CR.endIn - CR.numIn) / 6;

/** Where the stickman keeps the dice: beside the ⚙️ button, by the +z rail. */
export const CRAPS_DICE_SPOT: FeltPoint = { x: 0.17, z: 0.36 };

/** 💰 Where the house takes losing chips in and pays winners out, in front
 *  of the stickman: the other side of the ⚙️ from the dice, past the FAIR
 *  plaque, above the SEVEN box. */
export const CRAPS_HOUSE_SPOT: FeltPoint = { x: -0.26, z: 0.36 };

/** A number box (place / travelled come bets) on one end. */
export function crapsNumberBox(n: number, side: -1 | 1): FeltRect {
  const i = CRAPS_NUMBERS.indexOf(n as (typeof CRAPS_NUMBERS)[number]);
  // Both ends read 4 → 10 left to right (the real felt is not mirrored here)
  // for a player on the −z rail facing +z, whose left hand is +x.
  const j = CRAPS_NUMBERS.length - 1 - i;
  const x0 = side > 0 ? CR.numIn + j * NUM_W : -CR.endIn + j * NUM_W;
  return rect(x0, CR.comeIn, x0 + NUM_W, CRAPS_FELT.z1);
}

/** Depth of a number box's bottom (come) and top (don't come) bands. */
const NUM_BAND = 0.09;

/** A number box's bands: travelled come bets and their odds at the bottom,
 *  place bets in the middle, travelled don't come bets, their lay odds (and
 *  the puck) at the top. */
function numberBands(n: number, side: -1 | 1) {
  const box = crapsNumberBox(n, side);
  const bottom = rect(box.x0, box.z0, box.x1, box.z0 + NUM_BAND);
  const top = rect(box.x0, box.z1 - NUM_BAND, box.x1, box.z1);
  return {
    box,
    bottom,
    top,
    middle: rect(box.x0, bottom.z1, box.x1, top.z0),
    // Odds ride on top of the flat bet they back, so the flat bet and its
    // odds share one chip area.
    come: bottom,
    dontCome: top,
  };
}

/** The DON'T COME bar on one end (beside the number boxes, toward the middle). */
function dontComeBar(side: -1 | 1): FeltRect {
  return side > 0 ? rect(CR.inner, CR.comeIn, CR.numIn, CRAPS_FELT.z1)
    : rect(-CR.numIn, CR.comeIn, -CR.inner, CRAPS_FELT.z1);
}

const PLACE_PAYS: Record<number, string> = { 4: '9 TO 5', 5: '7 TO 5', 6: '7 TO 6', 8: '7 TO 6', 9: '7 TO 5', 10: '9 TO 5' };
/** True odds (come odds) and their inverse (don't come lay odds), as printed. */
export const ODDS_PAYS: Record<number, string> = { 4: '2 TO 1', 5: '3 TO 2', 6: '6 TO 5', 8: '6 TO 5', 9: '3 TO 2', 10: '2 TO 1' };
export const LAY_PAYS: Record<number, string> = { 4: '1 TO 2', 5: '2 TO 3', 6: '5 TO 6', 8: '5 TO 6', 9: '2 TO 3', 10: '1 TO 2' };
const NUMBER_WORD: Record<number, string> = { 4: '4', 5: '5', 6: 'SIX', 8: '8', 9: 'NINE', 10: '10' };

function crapsEnd(side: -1 | 1): FeltRegion<CrapsSpot>[] {
  const s = side;
  const tag = s > 0 ? '+' : '-';
  const X = (v: number) => v * s; // mirror an |x| onto this end
  const out: FeltRegion<CrapsSpot>[] = [];
  // The pass line's long strip, with the odds band behind it (toward the
  // player rail) — where a dealer sets odds, behind the flat bet.
  const passLong = rect(X(CR.inner), CR.oddsIn, X(CR.endIn), CR.passIn);
  const passCorner = rect(X(CR.endIn), CRAPS_FELT.z0, X(CRAPS_FELT.x1), CR.passIn);
  const passEnd = rect(X(CR.endIn), CR.passIn, X(CRAPS_FELT.x1), CRAPS_FELT.z1);
  out.push({
    id: `pass@${tag}`, bet: { type: 'pass' }, rects: [passLong, passCorner, passEnd], caption: 0,
    label: 'PASS LINE', fill: null, textSize: 0.038, side: s,
    chipRect: rect(X(CR.inner + 0.04), CR.oddsIn, X(CR.endIn), CR.passIn),
  });
  const passOdds = rect(X(CR.inner), CRAPS_FELT.z0, X(CR.endIn), CR.oddsIn);
  out.push({
    id: `passodds@${tag}`, bet: { type: 'passodds' }, rects: [passOdds],
    label: 'ODDS BEHIND THE LINE · TRUE ODDS', fill: null, textSize: 0.02, faint: true, side: s,
    chipRect: rect(X(CR.inner + 0.04), CRAPS_FELT.z0, X(CR.endIn), CR.oddsIn),
  });
  // The don't pass bar, its lay odds at the outer end by big 6 / 8.
  const dpSplit = CR.bigIn - 0.17;
  const dp = rect(X(CR.inner), CR.passIn, X(dpSplit), CR.dpIn);
  out.push({
    id: `dontpass@${tag}`, bet: { type: 'dontpass' }, rects: [dp],
    label: "DON'T PASS BAR ⚀⚀", fill: null, textSize: 0.034, side: s, chipRect: dp,
  });
  const dpOdds = rect(X(dpSplit), CR.passIn, X(CR.bigIn), CR.dpIn);
  out.push({
    id: `dontpassodds@${tag}`, bet: { type: 'dontpassodds' }, rects: [dpOdds],
    label: 'LAY ODDS', fill: null, textSize: 0.024, faint: true, side: s, chipRect: dpOdds,
  });
  const field = rect(X(CR.inner), CR.dpIn, X(CR.bigIn), CR.fieldIn);
  out.push({
    id: `field@${tag}`, bet: { type: 'field' }, rects: [field],
    label: '2 · 3 · 4 · 9 · 10 · 11 · 12', sub: 'FIELD · 2 AND 12 PAY DOUBLE',
    fill: null, ink: '#F6D365', textSize: 0.042, side: s, chipRect: field,
  });
  const bigMid = CR.bigIn + (CR.endIn - CR.bigIn) / 2;
  const big6 = rect(X(CR.bigIn), CR.passIn, X(bigMid), CR.fieldIn);
  const big8 = rect(X(bigMid), CR.passIn, X(CR.endIn), CR.fieldIn);
  out.push({
    id: `big6@${tag}`, bet: { type: 'big6' }, rects: [big6], label: '6',
    sub: 'BIG', fill: '#7A1E1E', textSize: 0.07, side: s, chipRect: big6,
  });
  out.push({
    id: `big8@${tag}`, bet: { type: 'big8' }, rects: [big8], label: '8',
    sub: 'BIG', fill: '#7A1E1E', textSize: 0.07, side: s, chipRect: big8,
  });
  const come = rect(X(CR.inner), CR.fieldIn, X(CR.endIn), CR.comeIn);
  out.push({
    id: `come@${tag}`, bet: { type: 'come' }, rects: [come],
    label: 'COME', fill: null, ink: '#E8584F', textSize: 0.1, side: s, chipRect: come,
  });
  const dc = dontComeBar(s);
  out.push({
    id: `dontcome@${tag}`, bet: { type: 'dontcome' }, rects: [dc],
    label: "DON'T COME", sub: 'BAR ⚅⚅', fill: null, textSize: 0.03,
    textRot: Math.PI / 2, side: s, chipRect: dc,
  });
  for (const n of CRAPS_NUMBERS) {
    const b = numberBands(n, s);
    // Place chips sit in the middle band of the box; the top band holds the
    // puck and travelled don't-come bets with their lay odds, the bottom band
    // travelled come bets with their odds. A click in a band backs that bet.
    out.push({
      id: `place:${n}@${tag}`, bet: { type: 'place', pick: n }, rects: [b.middle], frame: b.box,
      label: NUMBER_WORD[n], sub: PLACE_PAYS[n], fill: null,
      textSize: n === 6 || n === 9 ? 0.04 : 0.07, side: s,
      chipRect: b.middle,
    });
    out.push({
      id: `comeodds:${n}@${tag}`, bet: { type: 'comeodds', pick: n }, rects: [b.bottom],
      label: 'ODDS', fill: null, textSize: 0.022, faint: true, side: s, chipRect: b.come,
    });
    out.push({
      id: `dontcomeodds:${n}@${tag}`, bet: { type: 'dontcomeodds', pick: n }, rects: [b.top],
      label: 'LAY', fill: null, textSize: 0.022, faint: true, side: s, chipRect: b.dontCome,
    });
  }
  return out;
}

function crapsCentre(): FeltRegion<CrapsSpot>[] {
  const L = -0.34, R = 0.34, M = 0;
  const out: FeltRegion<CrapsSpot>[] = [];
  const seven = rect(L, 0.22, R, 0.3);
  out.push({
    id: 'anyseven', bet: { type: 'anyseven' }, rects: [seven], label: 'SEVEN',
    sub: '4 TO 1', fill: '#7A1E1E', textSize: 0.045, side: 0, chipRect: seven,
  });
  const hard = (n: number, x0: number, x1: number, z0: number, z1: number) => {
    const r = rect(x0, z0, x1, z1);
    out.push({
      id: `hard:${n}`, bet: { type: 'hard', pick: n }, rects: [r],
      label: `HARD ${n}`, sub: n === 6 || n === 8 ? '9 TO 1' : '7 TO 1',
      fill: null, textSize: 0.034, side: 0, chipRect: r,
    });
  };
  hard(6, L, M, 0.11, 0.22);
  hard(10, M, R, 0.11, 0.22);
  hard(8, L, M, 0, 0.11);
  hard(4, M, R, 0, 0.11);
  const prop = (type: CrapsSpot['type'], label: string, sub: string, x0: number, x1: number) => {
    const r = rect(x0, -0.11, x1, 0);
    out.push({
      id: type, bet: { type }, rects: [r], label, sub, fill: null,
      textSize: 0.03, side: 0, chipRect: r,
    });
  };
  prop('three', '⚀⚁', '15:1', L, -0.17);
  prop('two', '⚀⚀', '30:1', -0.17, M);
  prop('twelve', '⚅⚅', '30:1', M, 0.17);
  prop('yo', '⚄⚅', '15:1', 0.17, R);
  const craps = rect(L, -0.21, R, -0.11);
  out.push({
    id: 'anycraps', bet: { type: 'anycraps' }, rects: [craps], label: 'ANY CRAPS',
    sub: '7 TO 1', fill: '#7A1E1E', textSize: 0.034, side: 0, chipRect: craps,
  });
  return out;
}

export const CRAPS_LAYOUT: FeltLayout<CrapsSpot> = {
  felt: CRAPS_FELT,
  regions: [...crapsEnd(-1), ...crapsCentre(), ...crapsEnd(1)],
  // In front of the stickman (+z rail, centre), above the proposition box.
  settings: { x: 0, z: 0.36, r: 0.05 },
};

/** Where the ON/OFF puck rests on one end: in the DON'T COME bar when the
 *  point is off, on top of the point's number box when it is on. */
export function crapsPuckSpot(point: number | null, side: -1 | 1): FeltPoint {
  if (point === null || !CRAPS_NUMBERS.includes(point as (typeof CRAPS_NUMBERS)[number])) {
    const c = rectCentre(dontComeBar(side));
    return { x: c.x, z: CRAPS_FELT.z1 - 0.06 };
  }
  const box = crapsNumberBox(point, side);
  return { x: (box.x0 + box.x1) / 2, z: box.z1 - 0.05 };
}

/** The end of the table a player at local x plays on (the middle counts +). */
export function crapsSideFor(x: number): -1 | 1 {
  return x < 0 ? -1 : 1;
}

/** The chip area for a craps bet on one end of the felt. Travelled come and
 *  don't-come bets move into their number's box (bottom / top band). */
export function crapsChipRect(bet: CrapsSpot, side: -1 | 1): FeltRect | null {
  if ((bet.type === 'come' || bet.type === 'dontcome') && bet.pick !== undefined) {
    const b = numberBands(bet.pick, side);
    return bet.type === 'come' ? b.come : b.dontCome;
  }
  const key = spotKey(bet);
  const onEnd = CRAPS_LAYOUT.regions.find((r) => spotKey(r.bet) === key && (r.side === side || r.side === 0));
  return onEnd ? onEnd.chipRect : null;
}

/** True for the felt's spots every hardway uses (exported for the painter). */
export function isHardSpot(b: CrapsSpot): boolean {
  return b.type === 'hard' && b.pick !== undefined && HARD_NUMBERS.has(b.pick);
}

// ── 🎡 Roulette ──────────────────────────────────────────────────────────────

/** Felt extent: the roulette top inside its padded rail (see buildRouletteTable). */
export const ROULETTE_FELT: FeltRect = rect(-0.92, -0.42, 0.92, 0.42);

/** The wheel, sunk into the −x end of the table (the wheel head's side). */
export const ROULETTE_WHEEL = { x: -0.58, z: 0, r: 0.34 };

const RL = {
  zeroX0: -0.17,
  gridX0: -0.08,
  cellW: 0.07,
  rowZ0: -0.08,
  rowH: 0.14,
  dozenZ0: -0.2,
  evenZ0: -0.33,
};

/** A straight number's cell (1–36; 0 is the zero box). Row 0 (1, 4, 7 …) is
 *  nearest the −z rail, row 2 (3, 6, 9 …) the far one — the classic layout. */
export function rouletteCell(n: number): FeltRect {
  const top = RL.rowZ0 + 3 * RL.rowH;
  if (n === 0) return rect(RL.zeroX0, RL.rowZ0, RL.gridX0, top);
  const col = Math.floor((n - 1) / 3);
  const row = (n - 1) % 3;
  const x0 = RL.gridX0 + col * RL.cellW;
  const z0 = RL.rowZ0 + row * RL.rowH;
  return rect(x0, z0, x0 + RL.cellW, z0 + RL.rowH);
}

const RL_RED = '#C43C3C';
const RL_BLACK = '#23252E';
const RL_GREEN = '#1B6B3A';

function rouletteRegions(): FeltRegion<RouletteSpot>[] {
  const out: FeltRegion<RouletteSpot>[] = [];
  for (let n = 0; n <= 36; n++) {
    const cell = rouletteCell(n);
    const col = pocketColor(n);
    out.push({
      id: `straight:${n}`, bet: { type: 'straight', pick: n }, rects: [cell],
      label: String(n), fill: col === 'green' ? RL_GREEN : col === 'red' ? RL_RED : RL_BLACK,
      textSize: 0.034, textRot: n === 0 ? Math.PI / 2 : 0, side: 0,
      chipRect: n === 0 ? rect(cell.x0, cell.z0 + 0.12, cell.x1, cell.z1 - 0.12) : cell,
    });
  }
  const gridX1 = RL.gridX0 + 12 * RL.cellW;
  for (let c = 0; c < 3; c++) {
    const r = rect(gridX1, RL.rowZ0 + c * RL.rowH, gridX1 + 0.11, RL.rowZ0 + (c + 1) * RL.rowH);
    out.push({
      id: `column:${c}`, bet: { type: 'column', pick: c }, rects: [r], label: '2 TO 1',
      fill: null, textSize: 0.022, side: 0, chipRect: r,
    });
  }
  for (let d = 0; d < 3; d++) {
    const x0 = RL.gridX0 + d * 4 * RL.cellW;
    const r = rect(x0, RL.dozenZ0, x0 + 4 * RL.cellW, RL.rowZ0);
    out.push({
      id: `dozen:${d}`, bet: { type: 'dozen', pick: d }, rects: [r],
      label: ['1st 12', '2nd 12', '3rd 12'][d], fill: null, textSize: 0.04, side: 0, chipRect: r,
    });
  }
  const even: Array<[string, RouletteSpot['type'], string | null]> = [
    ['1–18', 'low', null], ['EVEN', 'even', null], ['RED', 'red', RL_RED],
    ['BLACK', 'black', RL_BLACK], ['ODD', 'odd', null], ['19–36', 'high', null],
  ];
  even.forEach(([label, type, fill], i) => {
    const x0 = RL.gridX0 + i * 2 * RL.cellW;
    const r = rect(x0, RL.evenZ0, x0 + 2 * RL.cellW, RL.dozenZ0);
    out.push({
      id: type, bet: { type }, rects: [r],
      // The red / black boxes carry a painted diamond in their colour.
      label: fill ? '' : label, fill: null, textSize: 0.034, side: 0, chipRect: r,
      ...(fill ? { diamond: fill } : {}),
    });
  });
  return out;
}

export const ROULETTE_LAYOUT: FeltLayout<RouletteSpot> = {
  felt: ROULETTE_FELT,
  regions: rouletteRegions(),
  // Beside the wheel, on the player side of the layout — in front of the
  // croupier's wheel head.
  settings: { x: -0.16, z: -0.25, r: 0.045 },
};

// ── Chip placement ───────────────────────────────────────────────────────────

/** Diameter of a chip on the felt (a little over real size, for the camera). */
export const CHIP_RADIUS = 0.021;
const SLOT_PITCH = CHIP_RADIUS * 2 + 0.008;

/** Stack positions inside a chip area, row-major from the −z / −x corner.
 *  Always at least one (the area's centre) however small the area is. */
export function chipSlots(r: FeltRect): FeltPoint[] {
  const w = r.x1 - r.x0;
  const d = r.z1 - r.z0;
  const cols = Math.max(1, Math.floor((w - 0.004) / SLOT_PITCH));
  const rows = Math.max(1, Math.floor((d - 0.004) / SLOT_PITCH));
  const ox = r.x0 + (w - (cols - 1) * SLOT_PITCH) / 2;
  const oz = r.z0 + (d - (rows - 1) * SLOT_PITCH) / 2;
  const out: FeltPoint[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) out.push({ x: ox + i * SLOT_PITCH, z: oz + j * SLOT_PITCH });
  }
  return out;
}

/**
 * Place stacks one at a time around stacks already standing (`taken`): in
 * `rank` then player-id order, each player takes the candidate nearest their
 * `anchor` (the first one, with no anchor) that clears every stack placed so
 * far by a chip's width. Candidates closer together than that can't both be
 * used. Only once no clear candidate is left does a player share the
 * nearest one, so a live bet is never left out.
 */
export function assignClearSlots(
  candidates: readonly FeltPoint[],
  taken: readonly FeltPoint[],
  players: ReadonlyArray<{ pid: string; anchor: FeltPoint | null; rank?: number }>,
): Map<string, FeltPoint> {
  const out = new Map<string, FeltPoint>();
  if (candidates.length === 0) return out;
  const placed = [...taken];
  const ordered = [...players].sort((a, b) =>
    (a.rank ?? Infinity) - (b.rank ?? Infinity) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
  const dist = (p: FeltPoint, q: FeltPoint) => Math.hypot(p.x - q.x, p.z - q.z);
  const pick = (from: readonly FeltPoint[], anchor: FeltPoint | null) =>
    anchor ? from.reduce((a, b) => (dist(b, anchor) < dist(a, anchor) ? b : a)) : from[0];
  for (const p of ordered) {
    const clear = candidates.filter((c) => placed.every((q) => dist(c, q) >= CHIP_RADIUS * 2 - 1e-9));
    const at = pick(clear.length > 0 ? clear : candidates, p.anchor);
    out.set(p.pid, at);
    placed.push(at);
  }
  return out;
}

// ── Dealer positions ─────────────────────────────────────────────────────────
//
// On a real craps table the dealers, not the players, set place bets and
// travelled come / don't come bets in the number boxes, and the stickman sets
// the centre bets. Each box is the table in miniature: a player's chips go at
// the spot in the box that matches where they stand at the rail, the same
// spot in every box, so the crew can tell whose chips are whose at a glance
// (value chips all look alike). Roulette gets the same job done with colour
// chips instead — see rouletteChipColor.

/** How far from the table centre the craps rail positions reach along the
 *  table (the long-rail corner stands at ±0.9, the end stands past ±1.8). */
const CRAPS_REACH_X = 1.8;
/** And across it (the long-rail stands at ±1.5). */
const CRAPS_REACH_Z = 1.5;

/** True for the craps bets the crew sets by player position (the number
 *  boxes and the centre), false for the ones a player sets in front of
 *  themselves (line, field, big 6/8, the come box itself). */
export function crapsDealerPlaced(bet: CrapsSpot): boolean {
  switch (bet.type) {
    case 'place':
    case 'comeodds':
    case 'dontcomeodds':
      return true;
    case 'come':
    case 'dontcome':
      return bet.pick !== undefined;
    default:
      return CRAPS_LAYOUT.regions.some((r) => r.side === 0 && spotKey(r.bet) === spotKey(bet));
  }
}

/**
 * Where a dealer sets a player's stack inside `r`: the player's stand
 * (table-local) scaled down into the box. Along the table the box runs from
 * the table centre (its inner edge) to the end (its outer edge) on the
 * player's own end (`side` ±1), or across the whole table for the centre
 * bets (`side` 0); across the table, the −z rail is the box's −z edge. The
 * stack stays wholly inside the box, and a box too small for that gets it
 * centred.
 */
export function dealerSpot(r: FeltRect, stand: FeltPoint, side: -1 | 0 | 1): FeltPoint {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const u = side === 0
    ? clamp01((stand.x / CRAPS_REACH_X + 1) / 2)
    : clamp01((stand.x * side) / CRAPS_REACH_X);
  const v = clamp01((stand.z / CRAPS_REACH_Z + 1) / 2);
  const along = (lo: number, hi: number, t: number) => {
    const a = lo + CHIP_RADIUS;
    const b = hi - CHIP_RADIUS;
    return a >= b ? (lo + hi) / 2 : a + (b - a) * t;
  };
  // The −1 end reads its box from the outer (−x) edge in, so mirror there.
  const ux = side < 0 ? 1 - u : u;
  return { x: along(r.x0, r.x1, ux), z: along(r.z0, r.z1, v) };
}

/** The chip area a travelled come / don't come bet's odds share with it. */
export function crapsOddsBaseRect(bet: CrapsSpot, side: -1 | 1): FeltRect | null {
  if ((bet.type !== 'comeodds' && bet.type !== 'dontcomeodds') || bet.pick === undefined) return null;
  return crapsChipRect({ type: bet.type === 'comeodds' ? 'come' : 'dontcome', pick: bet.pick }, side);
}

/** Roulette colour chips, one colour per standing position (the wheel head
 *  first), none of them the felt's red, black or green. */
export const ROULETTE_CHIP_COLORS = ['#F2C14E', '#4EA8F2', '#F25EB0', '#9B6BF2', '#F28C38', '#5EE0D0'] as const;

/** The colour of the chips a player at stand `stand` plays at roulette. */
export function rouletteChipColor(stand: number): string {
  const n = ROULETTE_CHIP_COLORS.length;
  return ROULETTE_CHIP_COLORS[((stand % n) + n) % n];
}

/**
 * Each seated roulette player's chip colour. A stand can hold two players
 * (with no free stand the table seats a newcomer at the nearest taken one),
 * so the first at a stand (player-id order) gets its colour and the rest get
 * the first colour nobody holds; only past six players do colours repeat.
 */
export function rouletteChipColors(seats: Record<string, { stand: number }>): Map<string, string> {
  const out = new Map<string, string>();
  const pids = Object.keys(seats).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const used = new Set<string>();
  const later: string[] = [];
  for (const pid of pids) {
    const c = rouletteChipColor(seats[pid].stand);
    if (used.has(c)) later.push(pid);
    else {
      out.set(pid, c);
      used.add(c);
    }
  }
  later.forEach((pid, i) => {
    const free = ROULETTE_CHIP_COLORS.filter((c) => !used.has(c));
    const c = free[0] ?? ROULETTE_CHIP_COLORS[i % ROULETTE_CHIP_COLORS.length];
    out.set(pid, c);
    used.add(c);
  });
  return out;
}
