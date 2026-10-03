/**
 * 🏒 Air-hockey table themes (#184) — the COLOUR SKIN a table wears, and the
 * contrast rule that makes "the puck can be seen" a property instead of an
 * opinion.
 *
 * #184 reported that the puck is hard to see and asked for a lighter, maybe
 * white, table. The measurement behind that report: the shipped puck
 * (0x141a22) against the shipped felt (0x0d1622) is a WCAG contrast ratio of
 * **1.04 : 1** — two near-black surfaces, one on the other. The floor for a
 * graphic that carries meaning is 3 : 1, so the puck was ~65× short of it.
 *
 * Lightening the felt alone would have fixed the puck and broken the mallets:
 * the cyan/orange pair scores 9.16 / 7.50 against the dark felt and collapses
 * to 1.79 / 2.19 against a white one. So a theme is a WHOLE skin — felt, puck,
 * players, rink markings and scoreboard move together — and every one of them
 * is checked against the same floor by airHockeyThemeContrastIssues(), which
 * the test suite runs over every preset.
 *
 * Pure data + arithmetic on purpose: no THREE, no DOM, no doc. furniture.ts
 * turns a spec into materials and canvas fills; tableThemeDoc.ts replicates
 * WHICH id a table wears; this module only says what the ids mean and which
 * ones are legible.
 *
 * Colours are 0xRRGGBB ints — the form ctx.m() takes — with hexCss() for the
 * two canvas painters, which need '#rrggbb' strings.
 */

/** The themes a table can wear. `arctic` is the default (see the order below). */
export type AirHockeyThemeId = 'arctic' | 'sandstone' | 'mint' | 'midnight';

/**
 * Cycle order for the editor — `arctic` FIRST because it is the default, and
 * the default is the absence of a record in the doc (tableThemeDoc). This is
 * the wallpaper preset convention (`plain` first) applied to tables.
 */
export const AIR_HOCKEY_THEMES: AirHockeyThemeId[] = [
  'arctic',
  'sandstone',
  'mint',
  'midnight',
];

/**
 * The look a table has with no record stored for it — the #184 fix itself.
 * Every table in every existing room becomes `arctic` on load without any
 * migration, because no room has ever written a theme record.
 */
export const DEFAULT_AIR_HOCKEY_THEME: AirHockeyThemeId = 'arctic';

/** Human labels for the context-menu picker. */
export const AIR_HOCKEY_THEME_LABELS: Record<AirHockeyThemeId, string> = {
  arctic: 'Arctic white',
  sandstone: 'Sandstone',
  mint: 'Mint ice',
  midnight: 'Midnight (classic)',
};

/** Doc-read guard — theme records cross the peer trust boundary. */
export function isAirHockeyThemeId(v: unknown): v is AirHockeyThemeId {
  return typeof v === 'string' && (AIR_HOCKEY_THEMES as string[]).includes(v);
}

/**
 * Every colour buildAirHockeyTable paints, in one record.
 *
 * Grouped as the table is built: the cabinet it stands on, the playfield art,
 * the two pieces that move, and the scoreboard panel. `playerA` / `playerB`
 * deliberately serve THREE surfaces each — end band, mallet and scoreboard
 * digit — because the game has no left/right convention and relies on that
 * colour keying to say whose side is whose.
 */
export interface AirHockeyThemeSpec {
  // ── Cabinet ──
  /** Cabinet body under the playing surface. */
  cabinet: number;
  /** The four legs. */
  legs: number;
  /** Side and end rails around the playfield. */
  rail: number;
  /** Recessed slot under each goal mouth, so the gap reads as an opening. */
  catchSlot: number;
  /** Scoreboard mast rising off the +x long side. */
  scorePole: number;

  // ── Playfield (painted to a CanvasTexture) ──
  /** The felt itself. Everything on the table is measured against this. */
  feltBase: number;
  /**
   * Air-hole grid. Deliberately LOW contrast against the felt (~1.2 : 1) and
   * deliberately exempt from the 3 : 1 floor: it is surface texture, not a
   * mark that carries meaning, and raising it would turn the playfield into
   * noise the puck has to compete with.
   */
  feltHoles: number;
  /** Boundary, centre line, centre circle and goal creases. */
  feltLines: number;
  /** The heavier line across each goal mouth. */
  feltMouth: number;

  // ── Moving pieces ──
  /** The puck. The colour #184 is about. */
  puck: number;
  /** Side 'a' — the -z end band, its mallet, and the left scoreboard digit. */
  playerA: number;
  /** Side 'b' — the +z end band, its mallet, and the right scoreboard digit. */
  playerB: number;
  /** Goal lamp over each mouth; flashGoal() strobes its emissive. */
  goalLamp: number;

  // ── Scoreboard panel ──
  /**
   * Panel background. It tracks the felt's lightness rather than staying dark,
   * so ONE pair of player colours can be legible on both the felt and the
   * board — which is what keeps the digits keyed to the mallets.
   */
  scoreBg: number;
  /** Panel border. Decorative; no contrast floor. */
  scoreBorder: number;
  /** "AIR HOCKEY" caption. */
  scoreTitle: number;
  /** The ':' between the digits. Decorative; no contrast floor. */
  scoreColon: number;
  /** The status line under the score. */
  scoreStatus: number;
}

/**
 * The presets.
 *
 * Three light skins answer #184's "lighter, maybe white"; `midnight` keeps the
 * shipped dark table available — but with a LIGHT puck, because the dark table
 * with a dark puck is the defect, and shipping it as a choosable option would
 * only make the bug opt-in. Every pairing below is checked by the test suite.
 */
export const AIR_HOCKEY_THEME_SPECS: Record<AirHockeyThemeId, AirHockeyThemeSpec> = {
  /** Near-white ice with a near-black puck: the highest-contrast skin here. */
  arctic: {
    cabinet: 0xc9d6e2,
    legs: 0x9fb0c0,
    rail: 0xe8eef4,
    catchSlot: 0x33414f,
    scorePole: 0xa8b8c8,
    feltBase: 0xeef4fa,
    feltHoles: 0xd8e4ef,
    feltLines: 0x4a7490,
    feltMouth: 0x1b2733,
    puck: 0x141a22,
    playerA: 0x0b6b82,
    playerB: 0xa85410,
    goalLamp: 0xd03848,
    scoreBg: 0xe4ecf4,
    scoreBorder: 0x8aa2b8,
    scoreTitle: 0x44606f,
    scoreColon: 0x7a8ea0,
    scoreStatus: 0x2b3a46,
  },
  /** Warm pale stone — the same legibility in a wood-and-sand room. */
  sandstone: {
    cabinet: 0xd8c8b0,
    legs: 0xaa9878,
    rail: 0xf0e8dc,
    catchSlot: 0x443827,
    scorePole: 0xbcaa90,
    feltBase: 0xf4ece0,
    feltHoles: 0xe6dac8,
    feltLines: 0x8a6a40,
    feltMouth: 0x332618,
    puck: 0x2a2018,
    playerA: 0x0f6476,
    playerB: 0xa04a08,
    goalLamp: 0xc8402e,
    scoreBg: 0xeee2d2,
    scoreBorder: 0xb09870,
    scoreTitle: 0x6a553a,
    scoreColon: 0x9a8465,
    scoreStatus: 0x3a2e1e,
  },
  /** Pale green ice, for the pool deck's palette. */
  mint: {
    cabinet: 0xc2d8cc,
    legs: 0x94b0a2,
    rail: 0xe4f0ea,
    catchSlot: 0x284034,
    scorePole: 0xa6c0b4,
    feltBase: 0xe6f3ec,
    feltHoles: 0xd2e6da,
    feltLines: 0x3e7f60,
    feltMouth: 0x14251c,
    puck: 0x15241c,
    playerA: 0x0a6a80,
    playerB: 0xa2500c,
    goalLamp: 0xc83a4e,
    scoreBg: 0xdcece4,
    scoreBorder: 0x7fa894,
    scoreTitle: 0x3c6252,
    scoreColon: 0x6e9080,
    scoreStatus: 0x1e3328,
  },
  /**
   * The shipped arcade look, kept for anyone who wants it — cabinet, felt,
   * rink markings and the cyan/orange pair are the original values. ONE colour
   * changes: the puck goes near-white (0x141a22 → 0xf0f6ff), 1.04 : 1 → 16.74 : 1.
   */
  midnight: {
    cabinet: 0x24303e,
    legs: 0x1a2430,
    rail: 0xb8c4d0,
    catchSlot: 0x0a0e14,
    scorePole: 0x2a3644,
    feltBase: 0x0d1622,
    feltHoles: 0x16283a,
    feltLines: 0x3a6a8a,
    feltMouth: 0xd8e8f8,
    puck: 0xf0f6ff,
    playerA: 0x35c8e8,
    playerB: 0xe8933a,
    goalLamp: 0xe84a5a,
    scoreBg: 0x0a1018,
    scoreBorder: 0x2a4a66,
    scoreTitle: 0x7a92aa,
    scoreColon: 0x526a82,
    scoreStatus: 0xd8e8f8,
  },
};

/** Resolve an id to its spec. Unknown ids fall back to the default rather than
 *  throwing — callers include doc reads, which cross the peer trust boundary. */
export function airHockeyTheme(id: AirHockeyThemeId | undefined): AirHockeyThemeSpec {
  return AIR_HOCKEY_THEME_SPECS[id ?? DEFAULT_AIR_HOCKEY_THEME]
    ?? AIR_HOCKEY_THEME_SPECS[DEFAULT_AIR_HOCKEY_THEME];
}

/** 0xRRGGBB → '#rrggbb', for the two CanvasRenderingContext2D painters. */
export function hexCss(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

// ── Legibility arithmetic (WCAG 2.1 §1.4.11 non-text contrast) ──────────────

/** sRGB channel → linear light. WCAG 2.1 relative-luminance definition. */
function channelToLinear(srgb: number): number {
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a 0xRRGGBB colour, 0 (black) … 1 (white). */
export function relativeLuminance(color: number): number {
  const r = channelToLinear(((color >> 16) & 0xff) / 255);
  const g = channelToLinear(((color >> 8) & 0xff) / 255);
  const b = channelToLinear((color & 0xff) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 (identical) … 21 (black/white). */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * WCAG 2.1's floor for a graphic that carries meaning. The puck, the mallets
 * and the rink markings all carry meaning; the air-hole texture and the
 * scoreboard's border and colon do not, and are exempt by omission below.
 *
 * The scoreboard's text clears the same 3 : 1 rather than the 4.5 : 1 for body
 * copy, which is the correct threshold here: the digits are 108 px bold and
 * the caption 34 px bold on a 512 px canvas — large text by WCAG's definition.
 */
export const AIR_HOCKEY_MIN_CONTRAST = 3;

/**
 * Every pairing a player actually has to tell apart, and against what.
 *
 * Exported so the test suite and this module agree on one list — a colour
 * added to a spec without a line here would silently escape checking.
 */
export const AIR_HOCKEY_CONTRAST_PAIRS: ReadonlyArray<
  readonly [label: string, a: keyof AirHockeyThemeSpec, b: keyof AirHockeyThemeSpec]
> = [
  // The issue itself: the puck against what it slides on, and against the
  // markings it slides over (a puck lost on the centre circle is still lost).
  ['puck vs felt', 'puck', 'feltBase'],
  ['puck vs rink markings', 'puck', 'feltLines'],
  // Whose mallet is whose, and the end bands that say which end is whose.
  ['player A vs felt', 'playerA', 'feltBase'],
  ['player B vs felt', 'playerB', 'feltBase'],
  // The rink markings themselves.
  ['rink markings vs felt', 'feltLines', 'feltBase'],
  ['goal mouth vs felt', 'feltMouth', 'feltBase'],
  // The scoreboard, which is read at distance from both sides.
  ['score A vs panel', 'playerA', 'scoreBg'],
  ['score B vs panel', 'playerB', 'scoreBg'],
  ['title vs panel', 'scoreTitle', 'scoreBg'],
  ['status vs panel', 'scoreStatus', 'scoreBg'],
];

/**
 * Check one theme against the floor. Returns a human-readable line per
 * failing pair, empty when the theme is legible — the shape a test can assert
 * on and print usefully when it breaks.
 */
export function airHockeyThemeContrastIssues(id: AirHockeyThemeId): string[] {
  const spec = airHockeyTheme(id);
  const issues: string[] = [];
  for (const [label, a, b] of AIR_HOCKEY_CONTRAST_PAIRS) {
    const ratio = contrastRatio(spec[a], spec[b]);
    if (ratio < AIR_HOCKEY_MIN_CONTRAST) {
      issues.push(
        `${id}: ${label} is ${ratio.toFixed(2)}:1, below the ${AIR_HOCKEY_MIN_CONTRAST}:1 floor`,
      );
    }
  }
  return issues;
}
