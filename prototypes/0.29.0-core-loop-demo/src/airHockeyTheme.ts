/**
 * 🏒 Air-hockey table themes (#184) — the COLOUR SKIN a table wears, and the
 * contrast rule that makes "the puck can be seen" a property instead of an
 * opinion.
 *
 * #184 reported that the puck is hard to see and asked for a lighter, maybe
 * white, table. The measurement behind that report: the shipped puck
 * (0x141a22) against the shipped felt (0x0d1622) is a WCAG contrast ratio of
 * **1.04 : 1** — two near-black surfaces, one on the other. The floor for a
 * graphic that carries meaning is 3 : 1, and 1 : 1 is no contrast at all, so
 * what the puck had was 0.04 of the 2.00 of separation the floor asks for:
 * about 2% of a visible edge, rather than a dim one.
 *
 * Lightening the felt alone would have fixed the puck and broken the mallets:
 * the cyan/orange pair scores 9.16 / 7.50 against the dark felt and collapses
 * to 1.79 / 2.19 against a white one. So a theme is a WHOLE skin — felt, puck,
 * players, rink markings and scoreboard move together — and every one of them
 * is checked against the same floor by airHockeyThemeContrastIssues(), which
 * the test suite runs over every preset.
 *
 * Review of this change caught a second instance of the same defect, in the
 * one place it matters most: the puck crosses the heavier goal-mouth line on
 * every shot on goal, and that pairing was missing from the contract. All four
 * presets failed it at 1.01-1.15 : 1 — the original bug, reproduced at the
 * moment of scoring. The goal mouth now wears the theme's goal red (see
 * `feltMouth`), which clears the floor against the puck AND the felt.
 *
 * That red cannot also clear `feltLines`, and no other colour could either —
 * the proof is in `feltMouth` below. The fix for that pairing is geometric and
 * lives in furniture.ts: the goal line is inset into the playfield rather than
 * painted over the boundary stroke, so the two marks are never adjacent and
 * each is read against the felt. Hence no 'goal mouth vs rink markings' row in
 * the contract below — not an exemption, a pairing that no longer exists.
 *
 * Contrast is only half the contract, because it is a LUMINANCE ratio and so
 * cannot see two marks that are equally bright and differ only in hue — which
 * is the one difference a red-green dichromat has already lost. That is what
 * `AIR_HOCKEY_MIN_DELTA_E` and `airHockeyThemeConfusionIssues()` are for, and
 * they are not decorative: on the palette this file shipped before, the
 * contrast gate was entirely green while the ΔE gate failed nine readings —
 * worst of them `arctic`'s mallet A at ΔE 4.4 from the rink markings it
 * crosses on every shot. The two gates also differ in how
 * they are run — contrast at the observers, ΔE swept across the severities
 * between them — and `feltMouth` has the proof that this asymmetry is forced
 * rather than chosen.
 *
 * Both gates measure in LINEAR light and never round an intermediate to 8
 * bits; `LinearRgb` explains why that is a correctness requirement and what
 * went wrong when this module did round.
 *
 * Pure data + arithmetic on purpose: no THREE, no DOM, no doc. furniture.ts
 * turns a spec into materials and canvas fills; airHockeyThemeDoc.ts
 * replicates WHICH id a table wears; this module only says what the ids mean
 * and which ones are legible.
 *
 * Colours are 0xRRGGBB ints — the form ctx.m() takes — with hexCss() for the
 * two canvas painters, which need '#rrggbb' strings.
 */

/** The themes a table can wear. `arctic` is the default (see the order below). */
export type AirHockeyThemeId = 'arctic' | 'sandstone' | 'mint' | 'midnight';

/**
 * Cycle order for the editor — `arctic` FIRST because it is the default, and
 * the default is the absence of a record in the doc (airHockeyThemeDoc). This
 * is the wallpaper preset convention (`plain` first) applied to tables.
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
  /**
   * The heavier line across each goal mouth — the theme's goal red, the same
   * value as `goalLamp`. It is deliberately NOT a darker `feltLines`: the puck
   * is near-black on the three light skins and near-white on `midnight`, so a
   * mouth line that tracks the felt's extremes collides with the puck exactly
   * where a goal is decided. A mid-luminance red clears 3 : 1 against both the
   * puck and the felt in every preset, and matches the red goal line of ice
   * hockey. Checked by 'puck vs goal mouth' and 'goal mouth vs felt'.
   *
   * It cannot ALSO clear `feltLines`, and neither can anything else. Clearing
   * the puck puts a floor under its luminance; clearing the felt puts a
   * ceiling over it; on all four presets `feltLines` sits between those two,
   * and a colour cannot be 3 : 1 from a value it has to straddle. Retuning
   * `feltLines` only moves the problem — four mutually-3 : 1 levels on one
   * surface is past what sRGB offers. furniture.ts resolves it by moving the
   * line instead of the colour, so do not go hunting for a hue here.
   *
   * These reds clear 3 : 1 against puck AND felt under PROTANOPIA and
   * DEUTERANOPIA as well as for the standard observer (Viénot/Brettel/Mollon
   * 1999, via `simulateDichromacy`): worst case across all four presets is
   * 3.10 : 1, and `airHockeyThemeContrastIssues` takes the observer as an
   * argument so the suite checks it on every build rather than here.
   *
   * The reason they are not tuned tighter than that is the gap BETWEEN the
   * observers, which is where most affected players actually are. Dichromacy
   * is ~2.4% of men; anomalous trichromacy — the same confusion, partial
   * rather than total — is another ~6.3%, and it lies on the path from the
   * standard observer to the dichromat. `severity` parameterises that path.
   *
   * The two gates behave DIFFERENTLY along it, and the difference is provable
   * rather than merely observed. Contrast cannot dip between its ends: the
   * LMS blend is linear in `severity` and luminance is linear in linear
   * light, so each simulated luminance is affine in `severity` and the ratio
   * (La + 0.05) / (Lb + 0.05) is a Möbius function of it — monotone, so its
   * minimum sits at an end. Clipping to the gamut is the only way out of that
   * and it is piecewise-linear, so it cannot manufacture an interior minimum
   * either. Measured over 2001 steps: 0 of 88 contrast rows dip, and the
   * swept floor equals the endpoint floor to the last bit, 3.0352.
   *
   * ΔE has no such guarantee — L*a*b* takes a cube root and CIEDE2000 adds
   * trigonometry on top — and it genuinely does dip: 45 of 56 rows have a
   * strictly interior minimum, deepest `arctic`'s goal line against mallet A
   * under deuteranopia, ΔE 48.4 at both ends and 40.1 at severity 0.575, with
   * nothing leaving the gamut anywhere along that path. So the ΔE gate is
   * SWEPT over `AIR_HOCKEY_SEVERITY_SWEEP` and the contrast gate is not, and
   * neither choice is arbitrary.
   *
   * The shipped sweep resolves 44 of those 45. The one it misses is
   * `arctic`'s goal line against mallet B under protanopia, which dips by
   * 0.0012 — below the sweep's own resolution, and four hundred times
   * smaller than the 0.649 the tightest row clears the floor by. The sweep
   * is there to find the floor, not to characterise the shape of every
   * curve, and a dip that shallow cannot move a floor.
   *
   * An earlier revision of this comment said contrast dips too, citing a
   * `midnight` goal red at 3.015 at both ends and 2.997 between them. That
   * was an artefact of the measurement rather than a property of the paint:
   * the simulation used to round its output back to 8 bits, which models
   * nothing — the eye is not quantised — and moves a ratio by up to 0.103,
   * where the tightest row clears the floor by only 0.035. Both gates now
   * measure in linear light and never round.
   *
   * (A linear interpolation of the projection is still not a validated model
   * of anomalous trichromacy — Machado et al. 2009 is the tool for that, and
   * is not implemented here. It is used only as a continuous path between two
   * gated points, so a dip on it is a real warning about the gate whatever
   * the exact depth. Over that whole path the goal reds' worst is 3.10.)
   *
   * Those two are the dichromacies this module can honestly measure.
   * TRITANOPIA is not simulated at all, deliberately — see `VISION_PLANES`
   * for why the obvious matrix is the wrong tool and what doing it properly
   * would take. No tritan figure is quoted here, because the one this module
   * could produce would be measuring the method rather than the paint.
   *
   * Legibility is only half of it: a goal line can clear every contrast row
   * and still be the colour of somebody's mallet, because contrast is a
   * luminance measure and cannot see that. `AIR_HOCKEY_MIN_DELTA_E` is the
   * other half, and `sandstone` is why it exists.
   *
   * Red is also the right FAMILY and not just a legible one: the mallets are
   * cyan and orange, the standard colourblind-safe pair, and orange owns the
   * warm end of the gamut. A goal line that is warm has to keep its distance
   * from `playerB` or it reads as somebody's mallet crossing the crease.
   * These sit ΔE 15.6-32.7 from it over the whole severity path. (The search
   * that said there was a trade here sampled every second value per channel
   * and filtered on g >= b, which excludes crimson entirely: both halves of
   * this comment used to say the opposite.)
   *
   * That 15.6 is the tightest row in the ENTIRE ΔE gate — `midnight`'s goal
   * line against its orange mallet under deuteranopia — and it clears the
   * floor by 0.649, which is thin. It is deliberately not padded. Both
   * `midnight` and `mint` could be lifted to ~16.5 by moving their mallet
   * orange a ΔE of 1.5-2.0, which is invisible, and that was tried and
   * reverted: `midnight`'s entire purpose is the original table with the
   * minimum changed, its `playerB` is the original AH_ORANGE and a test pins
   * it as such, and tuning paint to pad a row that already passes makes the
   * floor mean nothing. If 15 is the wrong floor then 15 should change, not
   * the palette. The margin is small, measured, and real.
   */
  feltMouth: number;

  // ── Moving pieces ──
  /** The puck. The colour #184 is about. */
  puck: number;
  /** Side 'a' — the -z end band, its mallet, and the left scoreboard digit. */
  playerA: number;
  /** Side 'b' — the +z end band, its mallet, and the right scoreboard digit. */
  playerB: number;
  /**
   * Goal lamp over each mouth; flashGoal() strobes its emissive. Shares the
   * theme's goal red with `feltMouth` so the lamp and the line it hangs over
   * read as one signal. No contrast floor of its own — it is an emissive mesh,
   * not a mark on the felt — but it must stay equal to `feltMouth`, which IS
   * floored, so do not retune it alone.
   */
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
    feltMouth: 0xd2535c, // goal red — 4.27 : 1 vs puck, 3.69 : 1 vs felt (3.25 worst)
    puck: 0x141a22,
    playerA: 0x004563,
    playerB: 0x954500,
    goalLamp: 0xd2535c, // == feltMouth
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
    feltMouth: 0xce5948, // goal red — 3.90 : 1 vs puck, 3.48 : 1 vs felt (3.10 worst)
    puck: 0x2a2018,
    playerA: 0x0f6476,
    playerB: 0x653500,
    goalLamp: 0xce5948, // == feltMouth
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
    // The worst of the four before review: a near-black mouth line under a
    // near-black puck, 1.01 : 1 — invisible at the only moment that scores.
    feltMouth: 0xce5965, // goal red — 4.03 : 1 vs puck, 3.51 : 1 vs felt (3.12 worst)
    puck: 0x15241c,
    playerA: 0x0a6a80,
    playerB: 0xa2500c,
    goalLamp: 0xce5965, // == feltMouth
    scoreBg: 0xdcece4,
    scoreBorder: 0x7fa894,
    scoreTitle: 0x3c6252,
    scoreColon: 0x6e9080,
    scoreStatus: 0x1e3328,
  },
  /**
   * The shipped arcade look, kept for anyone who wants it — cabinet, felt,
   * rink markings and the cyan/orange pair are the original values. TWO
   * colours change, both for the same reason:
   *   • the puck goes near-white (0x141a22 → 0xf0f6ff), 1.04 : 1 → 16.74 : 1;
   *   • the goal mouth goes red (0xd8e8f8 → 0xe84a5a), because a near-white
   *     mouth line against a now near-white puck scored 1.15 : 1 — the first
   *     fix had simply moved the collision from the felt to the goal.
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
    feltMouth: 0xd84e58, // goal red — 3.75 : 1 vs puck, 4.46 : 1 vs felt (3.29 worst)
    puck: 0xf0f6ff,
    playerA: 0x35c8e8,
    playerB: 0xe8933a,
    goalLamp: 0xd84e58, // == feltMouth, a retune of this theme's old lamp red
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

/**
 * A colour in LINEAR light — one value per channel, nominally 0 … 1, but not
 * clamped and not rounded.
 *
 * Every measurement in this module runs on these rather than on packed
 * 0xRRGGBB integers, and that is a correctness requirement, not a style
 * choice. A simulated colour is an intermediate: it is the answer to "what
 * would this player see", and nothing ever paints it. Rounding it back to
 * 8 bits models nothing — the eye is not quantised — but it does move a
 * contrast ratio by up to 0.103 and a ΔE by up to 0.523, and the tightest
 * row this module gates clears its floor by 0.035. An earlier revision did
 * round, and the noise was large enough to be mistaken for a real effect;
 * see `feltMouth` for the dip that turned out not to exist.
 *
 * Values that leave 0 … 1 are kept. They are out of the sRGB gamut, i.e. a
 * colour the display cannot show, and the honest thing to do with one is
 * carry it into the metric rather than silently pretend the player sees the
 * nearest displayable colour instead.
 */
export type LinearRgb = readonly [r: number, g: number, b: number];

/** sRGB channel → linear light. WCAG 2.1 relative-luminance definition. */
function channelToLinear(srgb: number): number {
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

/** 0xRRGGBB → linear light. The entry point to every metric below. */
export function toLinearRgb(color: number): LinearRgb {
  return [
    channelToLinear(((color >> 16) & 0xff) / 255),
    channelToLinear(((color >> 8) & 0xff) / 255),
    channelToLinear((color & 0xff) / 255),
  ];
}

/** WCAG relative luminance of a linear-light triple, 0 (black) … 1 (white). */
export function luminanceOf(lin: LinearRgb): number {
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG relative luminance of a 0xRRGGBB colour, 0 (black) … 1 (white). */
export function relativeLuminance(color: number): number {
  return luminanceOf(toLinearRgb(color));
}

/** WCAG contrast ratio between two linear-light triples, 1 … 21. */
export function contrastRatioOf(a: LinearRgb, b: LinearRgb): number {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG contrast ratio between two colours, 1 (identical) … 21 (black/white). */
export function contrastRatio(a: number, b: number): number {
  return contrastRatioOf(toLinearRgb(a), toLinearRgb(b));
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
  // The goal mouth is a heavier line than the rest of the markings and the
  // puck crosses it on every shot on goal, so it needs its own row — losing
  // the puck here loses the one event the game is played for.
  ['puck vs goal mouth', 'puck', 'feltMouth'],
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
 * 👁 The standard observer, and the two red-green dichromacies, as
 * something the contrast check can be run AS rather than argued about in a
 * comment.
 *
 * Viénot, Brettel & Mollon (1999): convert to LMS cone response, project onto
 * the plane the missing cone leaves behind, convert back. It is the standard
 * cheap simulation and it is only an approximation of a dichromat's
 * experience — but it is a REPEATABLE one, which is the point. The palette
 * above was chosen against these numbers, so they belong in the build rather
 * than in a note saying they were checked once.
 *
 * Exported for the test suite, like the rest of the contrast apparatus in
 * this section; nothing in the running game calls it.
 */
export type AirHockeyVision = 'normal' | 'protanopia' | 'deuteranopia';

export const AIR_HOCKEY_VISIONS: readonly AirHockeyVision[] = [
  'normal',
  'protanopia',
  'deuteranopia',
];

/**
 * Linear light → sRGB channel, the inverse of channelToLinear, clamped and
 * quantised because that is what PAINTING a colour does to it.
 *
 * Only the packing wrapper `simulateDichromacy` goes through here, and only
 * so a caller that wants to display a simulated colour gets something a
 * display can accept. No gate calls it: the measurements run on `LinearRgb`,
 * for the reasons set out there. Rounding a number that is never painted is
 * noise, and this module was once wrong because it did.
 */
function channelFromLinear(linear: number): number {
  const v = linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * Math.pow(Math.max(linear, 0), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** sRGB → LMS (Hunt-Pointer-Estévez, in the scaling Viénot et al. use). */
const RGB_TO_LMS: readonly (readonly [number, number, number])[] = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
];

/** Its inverse, written out so the round trip is a constant of this file
 *  rather than a matrix inversion at call time. Recomposing it with the
 *  matrix above gives the identity to 1.3e-9. */
const LMS_TO_RGB: readonly (readonly [number, number, number])[] = [
  [8.094444790e-2, -1.305044092e-1, 1.167210664e-1],
  [-1.024853351e-2, 5.401932664e-2, -1.136147082e-1],
  [-3.652969379e-4, -4.121614686e-3, 6.935114049e-1],
];

/**
 * The plane each dichromacy collapses LMS onto. The missing cone's row is
 * rebuilt from the other two, which is exactly what "that cone contributes
 * nothing" means. 'normal' has no entry and is short-circuited below.
 *
 * There is deliberately no TRITANOPIA entry, and it is worth saying why so
 * the next person does not add the matrix that is easy to find. Viénot et al.
 * reduced Brettel, Viénot & Mollon (1997) to a single matrix for protanopia
 * and deuteranopia only; S-cone loss needs that paper's TWO half-planes
 * (anchored at 485 nm and 660 nm), because they are not coplanar and one
 * plane does not approximate them. The single-plane tritan matrix in
 * circulation shows the damage plainly: it turns pure red into rgb(186, 186,
 * 0), a yellow, destroying red-green information that a tritanope — whose L
 * and M cones are intact — discriminates normally. Measured through it, this
 * palette's goal reds appear to fail at 2.1-2.5 : 1; that number is an
 * artefact of the method and is not recorded anywhere in this file as if it
 * were a property of the colours. Doing it properly needs the Smith & Pokorny
 * LMS space and the monochromatic anchor coordinates, and is worth doing the
 * day those are in hand rather than approximated.
 */
const VISION_PLANES: Record<
  Exclude<AirHockeyVision, 'normal'>,
  readonly (readonly [number, number, number])[]
> = {
  protanopia: [[0, 2.02344, -2.52581], [0, 1, 0], [0, 0, 1]],
  deuteranopia: [[1, 0, 0], [0.494207, 0, 1.24827], [0, 0, 1]],
};

const applyMatrix = (
  m: readonly (readonly [number, number, number])[],
  v: readonly [number, number, number],
): [number, number, number] => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/**
 * What a 0xRRGGBB colour looks like to the given observer, in LINEAR light.
 * This is the one the gates call.
 *
 * `severity` walks the observer from the standard trichromat (0) to the full
 * dichromat (1) by blending in LMS, before the projection is undone. That is
 * where the blend belongs: LMS is the cone space, so interpolating there is
 * at least shaped like a partial cone defect, whereas interpolating the
 * OUTPUT would be mixing two display colours and would mean nothing. It is
 * still not a validated model of anomalous trichromacy — Machado et al. 2009
 * is — and the module does not claim otherwise; it is a continuous path
 * between two points the module does model, which is enough to catch a gate
 * that only holds at its ends. See `feltMouth` for which gate needs that and
 * which one provably does not.
 *
 * Sanity anchors, all asserted by the test suite: a neutral grey comes back
 * unchanged (dichromats see greys as greys); pure red lands on the
 * red-green-neutral axis, R channel equal to G, which is what red-green
 * blindness MEANS; and pure red loses luminance under protanopia
 * (0.2126 → 0.1041) but not under deuteranopia (0.2707), which is the real
 * asymmetry between them — protanopes have a luminosity defect at long
 * wavelengths, deuteranopes have near-normal luminous efficiency.
 */
export function simulateDichromacyLinear(
  color: number,
  vision: AirHockeyVision,
  severity = 1,
): LinearRgb {
  const linear = toLinearRgb(color);
  if (vision === 'normal' || severity === 0) return linear;
  const lms = applyMatrix(RGB_TO_LMS, linear);
  const projected = applyMatrix(VISION_PLANES[vision], lms);
  const blended: [number, number, number] = [
    lms[0] + (projected[0] - lms[0]) * severity,
    lms[1] + (projected[1] - lms[1]) * severity,
    lms[2] + (projected[2] - lms[2]) * severity,
  ];
  return applyMatrix(LMS_TO_RGB, blended);
}

/**
 * The same simulation packed back into a 0xRRGGBB colour, for callers that
 * want to SHOW the result — a preview swatch, a screenshot in an issue.
 *
 * Clamped and quantised, because that is what a display does. Do not measure
 * through this one; `simulateDichromacyLinear` is the measurable form, and
 * the difference between them is large enough to matter (see `LinearRgb`).
 */
export function simulateDichromacy(
  color: number,
  vision: AirHockeyVision,
  severity = 1,
): number {
  if (vision === 'normal' || severity === 0) return color;
  const seen = simulateDichromacyLinear(color, vision, severity);
  return (channelFromLinear(seen[0]) << 16)
    | (channelFromLinear(seen[1]) << 8)
    | channelFromLinear(seen[2]);
}

/**
 * Check one theme against the floor, as seen by one observer. Returns a
 * human-readable line per failing pair, empty when the theme is legible — the
 * shape a test can assert on and print usefully when it breaks.
 *
 * `vision` defaults to the standard observer, which is what WCAG 2.1 §1.4.11
 * is specified for and the only reading the floor is strictly owed. The
 * dichromat readings are this module going further than the standard: the
 * suite runs 'protanopia' and 'deuteranopia' as hard gates over every pair
 * and every preset. S-cone loss is not modelled — `VISION_PLANES` says why,
 * and why the matrix that looks like it would do the job does not.
 *
 * `severity` exists for symmetry with `airHockeyThemeConfusionIssues` and
 * for callers that want one specific observer. The suite does NOT sweep it
 * here, because for a contrast ratio it provably cannot find anything the
 * endpoints miss — `feltMouth` carries the argument and the measurement.
 */
export function airHockeyThemeContrastIssues(
  id: AirHockeyThemeId,
  vision: AirHockeyVision = 'normal',
  severity = 1,
): string[] {
  const spec = airHockeyTheme(id);
  const issues: string[] = [];
  const as = (c: number) => simulateDichromacyLinear(c, vision, severity);
  for (const [label, a, b] of AIR_HOCKEY_CONTRAST_PAIRS) {
    const ratio = contrastRatioOf(as(spec[a]), as(spec[b]));
    if (ratio < AIR_HOCKEY_MIN_CONTRAST) {
      issues.push(
        `${id}: ${label} is ${ratio.toFixed(2)}:1 under ${vision}` +
        `${severity === 1 ? '' : ` at severity ${severity.toFixed(3)}`}, ` +
        `below the ${AIR_HOCKEY_MIN_CONTRAST}:1 floor`,
      );
    }
  }
  return issues;
}

/**
 * ΔE below which two marks on the table read as each other.
 *
 * A separate floor from `AIR_HOCKEY_MIN_CONTRAST` because it answers a
 * different question. Contrast is a LUMINANCE ratio: it is blind to two
 * things that are equally bright and differ only in hue — which is exactly
 * the difference a dichromat cannot see. The eleven contrast rows were all
 * green while `sandstone`'s goal red sat ΔE 12.6 from the orange mallet
 * under deuteranopia and 11.6 under protanopia, a goal line the colour of a
 * mallet, because no row asks that question and none of them can. (This
 * comment used to say 14.8, which was the old metric's reading of the same
 * pair; the measurement below is stricter and the hole was deeper than the
 * number that justified plugging it.)
 *
 * 15 rather than the ~2.3 of a just-noticeable difference: these are marks
 * in motion on a textured surface being glanced at, not swatches compared
 * side by side, and the margin for "which one is mine" has to survive that.
 *
 * Measured as min(CIE76, CIEDE2000) — see `perceptualDistance`. An earlier
 * revision used CIE76 alone and justified it with the claim that CIE76
 * over-states saturated differences, "so a pair that clears 15 under CIE76
 * is not a pair this is being generous to". That has the conclusion exactly
 * backwards. Over-stating a difference is precisely how a gate gets fooled:
 * if CIE76 inflates, clearing 15 on CIE76 is the GENEROUS reading, not the
 * strict one. It inflates for a known reason — CIEDE2000 added the S_C and
 * S_H chroma weightings specifically to pull saturated pairs back down — and
 * these are saturated pairs, which is the case it was wrong about.
 *
 * Taking the minimum of both is the defensible answer rather than simply
 * switching to CIEDE2000, because neither metric is authoritative out here:
 * CIEDE2000 was fitted on pairs below ΔE 5 and this floor is 15, well
 * outside the data. Requiring both to clear costs nothing a palette cannot
 * pay (it cost five hex values, none of them visibly different) and removes
 * the need to be right about which formula to trust.
 */
export const AIR_HOCKEY_MIN_DELTA_E = 15;

/**
 * Marks that share the table and must not be mistaken for one another.
 *
 * Deliberately shorter than the contrast list: two things can be the same
 * colour without it mattering, if they are never in the same place or never
 * in motion. A score digit cannot be mistaken for a mallet. These seven can.
 * `goalLamp` is not listed separately because it is required to equal
 * `feltMouth`, so its rows would be copies of the goal line's.
 */
export const AIR_HOCKEY_DISTINCT_PAIRS: ReadonlyArray<
  readonly [label: string, a: keyof AirHockeyThemeSpec, b: keyof AirHockeyThemeSpec]
> = [
  // Whose mallet is whose — the one confusion that makes the game
  // unplayable rather than merely harder.
  ['the two mallets', 'playerA', 'playerB'],
  // A puck the colour of a mallet is a puck you stop tracking.
  ['puck vs mallet A', 'puck', 'playerA'],
  ['puck vs mallet B', 'puck', 'playerB'],
  // A goal line the colour of a mallet reads as somebody parked in the
  // crease. This is the row sandstone was failing.
  ['goal line vs mallet A', 'feltMouth', 'playerA'],
  ['goal line vs mallet B', 'feltMouth', 'playerB'],
  // A mallet the colour of the centre line or a face-off circle. The mallet
  // crosses those markings constantly, so this is the pair with the most
  // opportunities to be confused, and it had no row at all: both mallets
  // were gated against the puck, against each other and against the goal
  // line, and against the FELT by contrast — but never against the lines
  // drawn on the felt. On the old palette `arctic`'s mallet A sat ΔE 4.4
  // from the rink markings under deuteranopia with every test green.
  //
  // It has to be a ΔE row rather than a contrast row, and the geometry
  // forces that rather than taste. `arctic`'s felt has luminance 0.8978, so
  // anything clearing 3 : 1 against it must sit at L ≤ 0.2659; two such
  // marks that must also clear 3 : 1 against EACH OTHER force the darker to
  // L ≤ 0.0553, and the puck is already at 0.0100. A 3 : 1 mallet-vs-
  // markings rule would therefore put the mallet where the puck lives,
  // which is the confusion two rows above. Hue is the only axis with room
  // left on a near-white table.
  ['mallet A vs rink markings', 'playerA', 'feltLines'],
  ['mallet B vs rink markings', 'playerB', 'feltLines'],
];

/**
 * The severity steps the ΔE gate is checked at, standard observer (0) to
 * full dichromat (1) inclusive.
 *
 * A grid can always step over a dip, so the only honest way to choose its
 * density is to measure the resulting blind spot against the margin the
 * tightest row actually has, and that is how 129 was picked:
 *
 *   sampling    worst a row is overstated by, vs a 20001-point reference
 *   2 (ends)    8.304      ← what this module used to do
 *   17          0.598
 *   33          0.524
 *   65          0.217
 *   129         0.068
 *   513         0.032
 *
 * The tightest row in the gate clears the ΔE 15 floor by 0.649, so at 129
 * points the blind spot is an order of magnitude smaller than the margin it
 * would have to eat to matter. The whole sweep costs ~6 ms.
 *
 * Note that the column is NOT monotone — 33 points is worse than 17. That is
 * not noise in the measurement: the error is set by how far the worst row's
 * minimum happens to fall from a sample, which is a question of where the
 * grid lands rather than how fine it is. So this density is the measured
 * bound and not an extrapolation, and a future palette change should re-run
 * that measurement rather than assume a finer grid is a safer one.
 *
 * 129 = 2^7 + 1 also makes the step exactly 1/128: every sample is a dyadic
 * rational, so the grid is exact in binary and nests inside any coarser
 * power-of-two grid, which keeps a bisecting debug script honest.
 *
 * Only the ΔE gate uses this. Contrast provably has no interior minimum to
 * find — see `feltMouth`.
 */
export const AIR_HOCKEY_SEVERITY_SWEEP: readonly number[] =
  Array.from({ length: 129 }, (_, i) => i / 128);

/** A colour in CIE L*a*b* on the D65 white point. */
export type Lab = readonly [l: number, a: number, b: number];

/** Linear-light sRGB → CIE L*a*b* (sRGB primaries, D65 white). */
export function labOf(lin: LinearRgb): Lab {
  const [r, g, bl] = lin;
  // Linear sRGB → CIEXYZ (sRGB primaries, D65 white).
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) * 100;
  const y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * bl) * 100;
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * bl) * 100;
  // The cube-root transfer, with the linear segment near black that keeps
  // its slope finite (CIE 15:2004 δ = 6/29). Math.cbrt rather than
  // Math.pow(t, 1/3) so a negative t — an out-of-gamut simulation result,
  // which this module deliberately does not clamp — stays a real number
  // instead of becoming NaN and silently passing every comparison.
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x / 95.047), fy = f(y / 100), fz = f(z / 108.883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE: plain Euclidean distance in L*a*b*. */
export function deltaE76(p: Lab, q: Lab): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Degrees → radians, for the CIEDE2000 terms that are specified in degrees. */
const RAD = Math.PI / 180;

/**
 * CIEDE2000 ΔE, per Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-
 * Difference Formula: Implementation Notes, Supplementary Test Data, and
 * Mathematical Observations", Color Research & Application 30(1), 21–30.
 *
 * Written out rather than pulled in as a dependency: it is 30 lines, it has
 * no behaviour to configure, and it has a published known-answer set, so the
 * usual argument for taking the dependency does not apply. The test suite
 * runs all 34 of that paper's vectors against this function — those vectors
 * exist because the formula has three places implementations get it wrong,
 * and they are the ones this comment flags below.
 *
 * The hazards, in the order they appear:
 *   1. 25^7 is 6103515625, which is exactly representable as a double but is
 *      written as a literal here because `Math.pow(25, 7)` in a hot loop has
 *      been a source of drift in other implementations. Asserted in the
 *      suite rather than trusted.
 *   2. The mean hue `hBar` is NOT (hp1 + hp2) / 2. When the two hues
 *      straddle the 0°/360° wrap the naive mean lands on the opposite side
 *      of the wheel; this is the three-branch form from the paper, including
 *      the degenerate case where one colour is neutral (cp1 * cp2 === 0) and
 *      has no hue to average.
 *   3. ΔH′ uses a sine of the half-difference, not the hue difference
 *      itself, and is zero when either colour is neutral.
 */
export function deltaE2000(p: Lab, q: Lab): number {
  const [l1, a1, b1] = p;
  const [l2, a2, b2] = q;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const c7 = Math.pow(cBar, 7);
  // The a* stretch that pulls near-neutral colours away from the grey axis,
  // so two barely-chromatic colours are not treated as hugely different in
  // hue. 6103515625 is 25^7 — hazard 1.
  const g = 0.5 * (1 - Math.sqrt(c7 / (c7 + 6103515625)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hue = (a: number, b: number): number => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / RAD;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hue(ap1, b1);
  const hp2 = hue(ap2, b2);
  const dL = l2 - l1;
  const dC = cp2 - cp1;
  // Hazard 3: zero for a neutral colour, and wrapped into ±180° otherwise.
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * RAD);
  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  // Hazard 2: the three-branch mean hue.
  let hBar: number;
  if (cp1 * cp2 === 0) hBar = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hBar = (hp1 + hp2) / 2;
  else hBar = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  // The hue-dependent weighting: blues get a wider tolerance than yellows.
  const t = 1
    - 0.17 * Math.cos((hBar - 30) * RAD)
    + 0.24 * Math.cos(2 * hBar * RAD)
    + 0.32 * Math.cos((3 * hBar + 6) * RAD)
    - 0.20 * Math.cos((4 * hBar - 63) * RAD);
  const sL = 1 + (0.015 * Math.pow(lBar - 50, 2)) / Math.sqrt(20 + Math.pow(lBar - 50, 2));
  const sC = 1 + 0.045 * cpBar;
  const sH = 1 + 0.015 * cpBar * t;
  // The rotation term that handles the blue region, where chroma and hue
  // differences interact rather than adding in quadrature.
  const cp7 = Math.pow(cpBar, 7);
  const rT = -2 * Math.sqrt(cp7 / (cp7 + 6103515625))
    * Math.sin(60 * Math.exp(-Math.pow((hBar - 275) / 25, 2)) * RAD);
  return Math.sqrt(
    Math.pow(dL / sL, 2) + Math.pow(dC / sC, 2) + Math.pow(dH / sH, 2)
    + rT * (dC / sC) * (dH / sH),
  );
}

/**
 * How far apart two colours are, for gating purposes: the SMALLER of the two
 * ΔE readings.
 *
 * Taking the minimum means a pair has to look different under both formulae
 * to pass, which is the conservative reading and the one this module can
 * defend — `AIR_HOCKEY_MIN_DELTA_E` sets out why neither formula is
 * authoritative at a floor of 15 and why the cost of requiring both is low.
 */
export function perceptualDistance(a: LinearRgb, b: LinearRgb): number {
  const la = labOf(a);
  const lb = labOf(b);
  return Math.min(deltaE76(la, lb), deltaE2000(la, lb));
}

/**
 * Check one theme's confusable pairs, as seen by one observer. Same shape as
 * `airHockeyThemeContrastIssues` and the same reason for existing: the suite
 * runs it over every preset and every gated observer, so "these are far
 * enough apart" is a build step rather than a note.
 *
 * Unlike the contrast gate, this one has to be run at more than its ends —
 * ΔE really does dip in between, and the suite walks
 * `AIR_HOCKEY_SEVERITY_SWEEP`. `feltMouth` has the measurement.
 */
export function airHockeyThemeConfusionIssues(
  id: AirHockeyThemeId,
  vision: AirHockeyVision = 'normal',
  severity = 1,
): string[] {
  const spec = airHockeyTheme(id);
  const issues: string[] = [];
  for (const [label, a, b] of AIR_HOCKEY_DISTINCT_PAIRS) {
    const seen = perceptualDistance(
      simulateDichromacyLinear(spec[a], vision, severity),
      simulateDichromacyLinear(spec[b], vision, severity),
    );
    if (seen < AIR_HOCKEY_MIN_DELTA_E) {
      issues.push(
        `${id}: ${label} is ΔE ${seen.toFixed(1)} under ${vision}` +
        `${severity === 1 ? '' : ` at severity ${severity.toFixed(3)}`}, ` +
        `below the ΔE ${AIR_HOCKEY_MIN_DELTA_E} floor`,
      );
    }
  }
  return issues;
}

