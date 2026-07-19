/**
 * 🪙 Physical chip display (#69 — owner request 2026-07-19).
 *
 * The casino's fiction: OUTSIDE the cashier ATM, nobody is shown a numeric
 * chip balance — you see the PHYSICAL chips and count them. This module is
 * the one renderer behind that rule: given a balance (or an explicit list of
 * placed chips), it draws side-view stacks that are EXACTLY countable —
 * stacks of at most 10, standard casino denomination colors with edge
 * stripes, and the face value printed under each denomination group (a
 * chip's printed value is part of the chip; only the TOTAL is never shown).
 *
 * Two kinds of accuracy:
 *  - RACKS (your balance, a payout) decompose the number greedily into
 *    denominations — Σ chips always equals the balance exactly.
 *  - FELT stacks draw the chips AS PLACED: every bet record is one physical
 *    chip of its denomination, stacked in placement order.
 */

/** Largest-first — greedy decomposition uses this order. */
export const CHIP_DENOMS = [1000, 500, 100, 25, 5, 1] as const;

/** Standard casino colors (body / edge-stripe / face text). */
export const CHIP_STYLE: Record<number, { body: string; stripe: string; text: string }> = {
  1:    { body: '#E8E2D2', stripe: '#3E6FB8', text: '#2A2A2A' },
  5:    { body: '#C43C3C', stripe: '#F0E6D0', text: '#FFF4E0' },
  25:   { body: '#2E7D46', stripe: '#F0E6D0', text: '#FFF4E0' },
  100:  { body: '#23252E', stripe: '#D4A84B', text: '#F0C060' },
  500:  { body: '#6E3FA0', stripe: '#F0E6D0', text: '#FFF4E0' },
  1000: { body: '#E8971E', stripe: '#23252E', text: '#231A08' },
};

/** Greedy balance → flat list of chip denominations (largest first).
 *  Σ result === balance for every non-negative integer. */
export function chipsFor(balance: number): number[] {
  const chips: number[] = [];
  let left = Math.max(0, Math.floor(balance));
  for (const d of CHIP_DENOMS) {
    while (left >= d) {
      chips.push(d);
      left -= d;
    }
  }
  return chips;
}

/** Group a flat chip list by denomination, largest first. */
export function groupChips(chips: number[]): Array<{ denom: number; count: number }> {
  const counts = new Map<number, number>();
  for (const c of chips) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([denom, count]) => ({ denom, count }));
}

/** One side-view chip: rounded slab with two edge stripes. */
function drawChipSide(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  denom: number, dim: boolean,
): void {
  const s = CHIP_STYLE[denom] ?? CHIP_STYLE[1];
  ctx.globalAlpha = dim ? 0.55 : 1;
  ctx.fillStyle = s.body;
  const r = Math.min(3, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  // Edge stripes (the countability cue — real chips carry them).
  ctx.fillStyle = s.stripe;
  const sw = Math.max(2, w * 0.14);
  ctx.fillRect(x + w * 0.22 - sw / 2, y + 1, sw, h - 2);
  ctx.fillRect(x + w * 0.78 - sw / 2, y + 1, sw, h - 2);
  ctx.globalAlpha = 1;
}

export interface ChipDrawOpts {
  /** Dim the whole drawing (another player's chips). */
  dim?: boolean;
  /** Print the face value under each denomination group (default true). */
  labels?: boolean;
  /** Text drawn when there are no chips (default none). */
  emptyText?: string;
}

/**
 * Draw a chip list as countable side-view stacks inside (x, y, w, h):
 * per denomination, stacks of at most 10 chips grow up from the baseline;
 * the denomination's FACE VALUE (never a total) sits under its group.
 * Chip size auto-shrinks to fit the width; the stack layout never lies —
 * every chip in `chips` is drawn exactly once.
 */
export function drawChips(
  ctx: CanvasRenderingContext2D,
  chips: number[],
  x: number, y: number, w: number, h: number,
  opts: ChipDrawOpts = {},
): void {
  const labels = opts.labels !== false;
  const labelH = labels ? 12 : 0;
  const baseline = y + h - labelH;
  if (chips.length === 0) {
    if (opts.emptyText) {
      ctx.fillStyle = 'rgba(212, 168, 75, 0.4)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.emptyText, x + 2, y + h / 2);
    }
    return;
  }
  const groups = groupChips(chips);
  const stacks: Array<{ denom: number; count: number; groupStart: boolean }> = [];
  for (const g of groups) {
    let left = g.count;
    let first = true;
    while (left > 0) {
      stacks.push({ denom: g.denom, count: Math.min(10, left), groupStart: first });
      left -= Math.min(10, left);
      first = false;
    }
  }
  // Fit: chip width from available width; height from tallest stack.
  const GROUP_GAP = 8, STACK_GAP = 3;
  const gaps = (stacks.length - 1) * STACK_GAP + (groups.length - 1) * (GROUP_GAP - STACK_GAP);
  const chipW = Math.max(10, Math.min(26, Math.floor((w - gaps) / stacks.length)));
  const tallest = Math.max(...stacks.map((s) => s.count));
  const chipH = Math.max(3, Math.min(7, Math.floor((h - labelH - 2) / tallest)));
  let cx = x;
  let groupLabelStart = x;
  for (let i = 0; i < stacks.length; i++) {
    const st = stacks[i];
    if (st.groupStart) groupLabelStart = cx;
    for (let c = 0; c < st.count; c++) {
      drawChipSide(ctx, cx, baseline - (c + 1) * (chipH + 1), chipW, chipH, st.denom, !!opts.dim);
    }
    const next = stacks[i + 1];
    if (labels && (!next || next.groupStart)) {
      ctx.fillStyle = opts.dim ? 'rgba(212,168,75,0.35)' : 'rgba(212,168,75,0.7)';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(st.denom), (groupLabelStart + cx + chipW) / 2, baseline + 3);
    }
    cx += chipW + (next && next.groupStart ? GROUP_GAP : STACK_GAP);
  }
}

/**
 * Tiny felt stack: the chips of ONE betting region, drawn bottom→top in
 * placement order (each bet record is one physical chip). Anchored so the
 * stack grows UP from (x, yBase). Splits into side-by-side columns of 8
 * so tall stacks stay countable inside a board cell.
 */
export function drawFeltStack(
  ctx: CanvasRenderingContext2D,
  chips: number[],
  x: number, yBase: number,
  dim: boolean,
): void {
  const CW = 15, CH = 4, COL = 8;
  for (let i = 0; i < chips.length; i++) {
    const col = Math.floor(i / COL);
    const row = i % COL;
    drawChipSide(ctx, x + col * (CW + 2), yBase - (row + 1) * (CH + 1), CW, CH, chips[i], dim);
  }
}

/**
 * DOM chips for HTML surfaces (the BANK app): one small top-down disc per
 * chip, grouped by denomination — countable, never a total. Returns '' for
 * an empty balance.
 */
export function chipDotsHtml(balance: number): string {
  const groups = groupChips(chipsFor(balance));
  if (groups.length === 0) return '';
  const dot = (denom: number) => {
    const s = CHIP_STYLE[denom] ?? CHIP_STYLE[1];
    return `<span style="display:inline-block; width:11px; height:11px; border-radius:50%;
      background:${s.body}; border:2px dashed ${s.stripe}; box-sizing:border-box;
      margin:0 1px 1px 0; vertical-align:middle;"></span>`;
  };
  return groups.map((g) => `
    <span style="white-space:normal; margin-right:8px; line-height:15px;">
      ${dot(g.denom).repeat(g.count)}<span style="font-size:8px; color:rgba(212,168,75,0.6); margin-left:2px;">×${g.denom}</span>
    </span>`).join('');
}

// Debug handle (the __ssfGames/__ssfCasino precedent): decomposition
// accuracy is console-checkable without UI plumbing.
(window as unknown as { __ssfChips: unknown }).__ssfChips = { chipsFor, groupChips };
