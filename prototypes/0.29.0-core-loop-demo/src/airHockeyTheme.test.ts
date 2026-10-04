/**
 * 🎨 Air-hockey table themes (#184).
 *
 * The issue is a visibility bug reported in words — "make the table a lighter
 * color, maybe white, so the puck can be seen more easily". These cases turn
 * that into arithmetic: WCAG contrast against the 3:1 floor for graphics that
 * carry meaning, applied to every preset, so "the puck can be seen" is a
 * property the suite enforces rather than a judgement someone re-makes by eye.
 *
 * Three layers:
 *  - the pure palette module and its contrast rule;
 *  - the sync doc that replicates which table wears which skin;
 *  - the table AS BUILT, where the proof that the repaint path is complete is
 *    that repainting equals rebuilding, colour for colour.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import * as Y from 'yjs';
import {
  AIR_HOCKEY_CONTRAST_PAIRS,
  AIR_HOCKEY_DISTINCT_PAIRS,
  AIR_HOCKEY_MIN_CONTRAST,
  AIR_HOCKEY_MIN_DELTA_E,
  AIR_HOCKEY_SEVERITY_SWEEP,
  AIR_HOCKEY_THEMES,
  AIR_HOCKEY_THEME_LABELS,
  AIR_HOCKEY_THEME_SPECS,
  AIR_HOCKEY_VISIONS,
  DEFAULT_AIR_HOCKEY_THEME,
  airHockeyTheme,
  airHockeyThemeConfusionIssues,
  airHockeyThemeContrastIssues,
  contrastRatio,
  contrastRatioOf,
  deltaE2000,
  deltaE76,
  hexCss,
  isAirHockeyThemeId,
  labOf,
  perceptualDistance,
  relativeLuminance,
  simulateDichromacy,
  simulateDichromacyLinear,
  toLinearRgb,
  type AirHockeyThemeId,
  type AirHockeyThemeSpec,
} from './airHockeyTheme';
import {
  airHockeyThemeDocSize,
  bindAirHockeyThemeDoc,
  isAirHockeyThemeRecord,
  readAirHockeyTheme,
  readAllAirHockeyThemes,
  subscribeAirHockeyTheme,
  writeAirHockeyTheme,
} from './airHockeyThemeDoc';

/**
 * Everything painted onto a canvas, as `fillStyle=#rrggbb` / `fillText:TEXT`.
 *
 * The playfield and the scoreboard are MeshBasicMaterial + CanvasTexture, so
 * their colours exist ONLY in these calls — a material fingerprint cannot see
 * them, and the felt is the surface #184 is actually about. Shared by every
 * canvas in the file; clear it before the call under test.
 */
const paint: string[] = [];

/**
 * Every path call, tagged with the canvas it landed on and the lineWidth that
 * was live when it was made — enough to reconstruct the BAND each stroke
 * covers rather than just its centre line.
 *
 * Geometry, not pixels. The Proxy below answers every context call, so
 * drawFelt() really runs and its coordinates really are readable here; what
 * stays invisible is what the result LOOKS like, which is why the contrast
 * tests above work on the palette instead of on the texture.
 */
const strokes: Array<{
  op: string;
  args: number[];
  lineWidth: number;
  w: number;
  h: number;
}> = [];

/** The calls worth recording. `arc`'s trailing anticlockwise flag arrives as
 *  0 / 1 through Number(), which is all the test needs from it. */
const PATH_OPS = ['moveTo', 'lineTo', 'arc', 'strokeRect'];

/** A canvas that draws nothing but remembers what it was asked to draw
 *  (the airHockeyTable.test.ts stub, with a recorder on the two calls that
 *  carry the skin). */
function fakeCanvas() {
  const cv = { width: 0, height: 0, getContext: () => ctx };
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillText' || key === 'strokeText') {
        return (text: unknown) => { paint.push(`${String(key)}:${String(text)}`); };
      }
      if (PATH_OPS.includes(String(key))) {
        return (...args: unknown[]) => {
          strokes.push({
            op: String(key),
            args: args.map(Number),
            // Set before the path is built, so this is the width it gets.
            lineWidth: typeof target.lineWidth === 'number' ? target.lineWidth : 1,
            w: cv.width,
            h: cv.height,
          });
        };
      }
      return () => undefined;
    },
    set: (target, key, value) => {
      if (key === 'fillStyle' || key === 'strokeStyle') {
        paint.push(`${String(key)}=${String(value)}`);
      }
      target[key] = value;
      return true;
    },
  });
  return cv;
}

// furniture.ts reads the page's query string when it loads.
vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const { buildItemGroup } = await import('./furniture');

// ── The colours themselves ──────────────────────────────────────────────────

describe('air-hockey theme palette', () => {
  it('reproduces the defect #184 reported', () => {
    // The shipped table, measured: a near-black puck on a near-black felt.
    // Pinned as a REGRESSION guard — if a future palette drifts back here,
    // the contrast cases below stop being an abstraction and start failing
    // for the original reason.
    const SHIPPED_PUCK = 0x141a22;
    const SHIPPED_FELT = 0x0d1622;
    expect(contrastRatio(SHIPPED_PUCK, SHIPPED_FELT)).toBeCloseTo(1.04, 2);
    expect(contrastRatio(SHIPPED_PUCK, SHIPPED_FELT)).toBeLessThan(AIR_HOCKEY_MIN_CONTRAST);
  });

  it('gives every preset a visible puck, and visible everything else', () => {
    // The whole point of the issue. Reported per theme so a failure names the
    // offending pairing and its ratio instead of just going red.
    const issues = AIR_HOCKEY_THEMES.flatMap((id) => airHockeyThemeContrastIssues(id));
    // Joined into ONE string on purpose: vitest elides an array diff down to
    // `[ Array(1) ]`, which would hide the very sentence this function exists
    // to produce. As a string, a failure prints the pairing and its ratio.
    expect(issues.join('\n')).toBe('');
  });

  it('defaults to a LIGHT table, which is what the issue asked for', () => {
    expect(DEFAULT_AIR_HOCKEY_THEME).toBe('arctic');
    // Luminance, not a hex eyeball: "lighter, maybe white" is a measurable claim.
    const felt = airHockeyTheme(DEFAULT_AIR_HOCKEY_THEME).feltBase;
    expect(relativeLuminance(felt)).toBeGreaterThan(0.8);
    // And it must beat the felt it replaces by a wide margin.
    expect(relativeLuminance(felt)).toBeGreaterThan(relativeLuminance(0x0d1622) * 50);
  });

  it('keeps the dark table available, but not the dark-on-dark puck', () => {
    // Shipping the old look as a choosable preset would make the bug opt-in.
    // `midnight` is the original table with TWO colours changed — the puck,
    // and the goal mouth that the lightened puck then collided with.
    const midnight = AIR_HOCKEY_THEME_SPECS.midnight;
    expect(midnight.feltBase).toBe(0x0d1622); // original felt
    expect(midnight.cabinet).toBe(0x24303e); // original cabinet
    expect(midnight.playerA).toBe(0x35c8e8); // original AH_CYAN
    expect(midnight.playerB).toBe(0xe8933a); // original AH_ORANGE
    expect(midnight.puck).not.toBe(0x141a22); // the one that had to move
    expect(contrastRatio(midnight.puck, midnight.feltBase)).toBeGreaterThan(AIR_HOCKEY_MIN_CONTRAST);
  });

  it('orders the cycle with the default first (the wallpaper convention)', () => {
    expect(AIR_HOCKEY_THEMES[0]).toBe(DEFAULT_AIR_HOCKEY_THEME);
    expect(new Set(AIR_HOCKEY_THEMES).size).toBe(AIR_HOCKEY_THEMES.length);
  });

  it('describes every preset exactly once, with a label and a spec', () => {
    const specIds = Object.keys(AIR_HOCKEY_THEME_SPECS).sort();
    const labelIds = Object.keys(AIR_HOCKEY_THEME_LABELS).sort();
    expect(specIds).toEqual([...AIR_HOCKEY_THEMES].sort());
    expect(labelIds).toEqual([...AIR_HOCKEY_THEMES].sort());
  });

  it('gives every spec the same fields, each a real 24-bit colour', () => {
    // Catches a field added to one preset and forgotten in the others — the
    // builder would then paint `undefined` into a THREE colour.
    const keys = Object.keys(AIR_HOCKEY_THEME_SPECS.arctic).sort();
    for (const id of AIR_HOCKEY_THEMES) {
      const spec = AIR_HOCKEY_THEME_SPECS[id];
      expect(Object.keys(spec).sort()).toEqual(keys);
      for (const [field, value] of Object.entries(spec)) {
        expect(Number.isInteger(value), `${id}.${field}`).toBe(true);
        expect(value, `${id}.${field}`).toBeGreaterThanOrEqual(0);
        expect(value, `${id}.${field}`).toBeLessThanOrEqual(0xffffff);
      }
    }
  });

  it('checks the pairings a player actually has to tell apart', () => {
    // The pair list is the contract; a typo'd key would silently check nothing.
    const fields = new Set(Object.keys(AIR_HOCKEY_THEME_SPECS.arctic));
    for (const [label, a, b] of AIR_HOCKEY_CONTRAST_PAIRS) {
      expect(fields.has(a), `${label}: ${a}`).toBe(true);
      expect(fields.has(b), `${label}: ${b}`).toBe(true);
    }
    // The issue's own pairing must be among them.
    expect(AIR_HOCKEY_CONTRAST_PAIRS.some(([, a, b]) => a === 'puck' && b === 'feltBase')).toBe(true);
    // The goal-mouth pairing was missing from the first cut of this contract
    // and every preset failed it at 1.01-1.15 : 1. Pinned so it stays.
    expect(AIR_HOCKEY_CONTRAST_PAIRS.some(([, a, b]) => a === 'puck' && b === 'feltMouth')).toBe(true);
  });

  it('keeps each goal lamp the same red as the line it hangs over', () => {
    // The lamp has no floor of its own — it is an emissive mesh, not a mark on
    // the felt — so nothing else would catch it drifting off `feltMouth`,
    // which IS floored. Pinned because the two are one signal to a player: a
    // retune of the lamp alone would quietly split them.
    for (const id of AIR_HOCKEY_THEMES) {
      const spec = AIR_HOCKEY_THEME_SPECS[id];
      expect(spec.goalLamp, id).toBe(spec.feltMouth);
    }
  });

  it('exempts the air-hole texture on purpose', () => {
    // Deliberately low contrast: it is surface texture, not a mark that
    // carries meaning, and raising it would give the puck something to get
    // lost in. Pinned so the exemption stays a decision, not an oversight.
    for (const id of AIR_HOCKEY_THEMES) {
      const spec = AIR_HOCKEY_THEME_SPECS[id];
      expect(contrastRatio(spec.feltHoles, spec.feltBase)).toBeLessThan(1.5);
    }
    expect(AIR_HOCKEY_CONTRAST_PAIRS.some(([, a, b]) => a === 'feltHoles' || b === 'feltHoles')).toBe(false);
  });

  it('computes WCAG luminance and ratios correctly', () => {
    expect(relativeLuminance(0x000000)).toBeCloseTo(0, 6);
    expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 6);
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 4);
    expect(contrastRatio(0x7f7f7f, 0x7f7f7f)).toBeCloseTo(1, 6);
    expect(contrastRatio(0x000000, 0xffffff)).toBe(contrastRatio(0xffffff, 0x000000)); // symmetric
  });

  it('resolves unknown ids to the legible default rather than throwing', () => {
    // Ids reach this from doc reads, which cross the peer trust boundary.
    expect(airHockeyTheme(undefined)).toBe(AIR_HOCKEY_THEME_SPECS[DEFAULT_AIR_HOCKEY_THEME]);
    expect(airHockeyTheme('nonsense' as AirHockeyThemeId)).toBe(
      AIR_HOCKEY_THEME_SPECS[DEFAULT_AIR_HOCKEY_THEME],
    );
    // Identity, not a copy — World's repaint short-circuits on it.
    expect(airHockeyTheme('midnight')).toBe(airHockeyTheme('midnight'));
  });

  it('guards theme ids', () => {
    for (const id of AIR_HOCKEY_THEMES) expect(isAirHockeyThemeId(id)).toBe(true);
    for (const junk of [undefined, null, 42, '', 'ARCTIC', 'plain', {}, ['arctic']]) {
      expect(isAirHockeyThemeId(junk)).toBe(false);
    }
  });

  it('formats colours for the canvas painters', () => {
    expect(hexCss(0x000000)).toBe('#000000');
    expect(hexCss(0xeef4fa)).toBe('#eef4fa');
    // Two leading zeros, and a colour actually in the palette: arctic's
    // mallet A. A naive toString(16) emits '4563' here and the canvas
    // silently paints the wrong thing.
    expect(hexCss(0x004563)).toBe('#004563');
  });
});

// ── The sync doc ────────────────────────────────────────────────────────────

describe('air-hockey theme doc', () => {
  const TABLE = 'air-hockey-table-1';
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    bindAirHockeyThemeDoc(doc);
  });

  it('starts empty, and an unrecorded table wears the default', () => {
    // This is the migration story: no room has ever stored a theme, so every
    // existing table picks up the #184 fix with no seeding at all.
    expect(airHockeyThemeDocSize()).toBe(0);
    expect(readAirHockeyTheme(TABLE)).toBe(DEFAULT_AIR_HOCKEY_THEME);
    expect(readAllAirHockeyThemes().size).toBe(0);
  });

  it('round-trips a recolour', () => {
    writeAirHockeyTheme(TABLE, 'midnight');
    expect(readAirHockeyTheme(TABLE)).toBe('midnight');
    expect(readAllAirHockeyThemes().get(TABLE)).toBe('midnight');
    expect(airHockeyThemeDocSize()).toBe(1);
  });

  it('stores the default as the ABSENCE of a record', () => {
    writeAirHockeyTheme(TABLE, 'mint');
    expect(airHockeyThemeDocSize()).toBe(1);
    writeAirHockeyTheme(TABLE, DEFAULT_AIR_HOCKEY_THEME);
    expect(airHockeyThemeDocSize()).toBe(0); // deleted, not stored
    expect(readAirHockeyTheme(TABLE)).toBe(DEFAULT_AIR_HOCKEY_THEME);
  });

  it('keys by item id, so two tables recolour independently', () => {
    writeAirHockeyTheme('table-a', 'midnight');
    writeAirHockeyTheme('table-b', 'sandstone');
    expect(readAirHockeyTheme('table-a')).toBe('midnight');
    expect(readAirHockeyTheme('table-b')).toBe('sandstone');
  });

  it('rejects hostile and malformed records written straight to the map', () => {
    // The path a peer running edited code actually takes.
    const map = doc.getMap('airHockeyTheme');
    map.set(TABLE, { itemId: TABLE, theme: 'neon-pink' }); // unknown theme
    expect(readAirHockeyTheme(TABLE)).toBe(DEFAULT_AIR_HOCKEY_THEME);
    map.set(TABLE, { itemId: 'someone-else', theme: 'midnight' }); // mis-keyed
    expect(readAirHockeyTheme(TABLE)).toBe(DEFAULT_AIR_HOCKEY_THEME);
    expect(readAllAirHockeyThemes().size).toBe(0);
    map.set(TABLE, 'midnight'); // not even an object
    expect(readAirHockeyTheme(TABLE)).toBe(DEFAULT_AIR_HOCKEY_THEME);
  });

  it('guards record shape', () => {
    expect(isAirHockeyThemeRecord({ itemId: 'x', theme: 'midnight' })).toBe(true);
    expect(isAirHockeyThemeRecord({ itemId: '', theme: 'midnight' })).toBe(false);
    expect(isAirHockeyThemeRecord({ itemId: 'x', theme: 'nope' })).toBe(false);
    expect(isAirHockeyThemeRecord({ itemId: 'x' })).toBe(false);
    expect(isAirHockeyThemeRecord(null)).toBe(false);
    // The default is never a stored record.
    expect(isAirHockeyThemeRecord({ itemId: 'x', theme: DEFAULT_AIR_HOCKEY_THEME })).toBe(false);
  });

  it('notifies subscribers, and stops after unsubscribe', () => {
    let hits = 0;
    const off = subscribeAirHockeyTheme(() => { hits += 1; });
    writeAirHockeyTheme(TABLE, 'midnight');
    expect(hits).toBeGreaterThan(0);
    const settled = hits;
    off();
    writeAirHockeyTheme(TABLE, 'mint');
    expect(hits).toBe(settled);
  });

  it('survives a listener that throws', () => {
    // One bad subscriber must not stop World from repainting.
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let reached = false;
    const offBad = subscribeAirHockeyTheme(() => { throw new Error('boom'); });
    const offGood = subscribeAirHockeyTheme(() => { reached = true; });
    writeAirHockeyTheme(TABLE, 'midnight');
    expect(reached).toBe(true);
    offBad();
    offGood();
    err.mockRestore();
  });
});

// ── The table as built ──────────────────────────────────────────────────────

/** Every standard material in the group, as [colour, emissive] pairs, sorted —
 *  the table's full colour fingerprint, independent of traversal order. */
function colourFingerprint(group: THREE.Group): string[] {
  const out: string[] = [];
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material;
    if (mat instanceof THREE.MeshStandardMaterial) {
      out.push(`${mat.color.getHexString()}/${mat.emissive.getHexString()}`);
    }
  });
  return out.sort();
}

/** Every CanvasTexture on the table, with its upload version. A repaint that
 *  forgets `needsUpdate` never reaches the screen, which looks exactly like a
 *  repaint that never happened. */
function textureVersions(group: THREE.Group): number[] {
  const out: number[] = [];
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const map = (obj.material as THREE.Material & { map?: THREE.Texture }).map;
    if (map) out.push(map.version);
  });
  return out;
}

interface TableHandle {
  setTheme(theme: AirHockeyThemeSpec): void;
  setScore(a: number, b: number, statusLine: string): void;
}

/** The table's repaint handle, stowed on the felt by the builder. */
function tableHandle(group: THREE.Group): TableHandle {
  let found: TableHandle | null = null;
  group.traverse((obj) => {
    const h = obj.userData?.airHockey;
    if (h) found = h as TableHandle;
  });
  if (!found) throw new Error('no air-hockey handle on the built table');
  return found;
}

function buildTable(id: string): THREE.Group {
  return buildItemGroup({ id, kind: 'air-hockey-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
}

// ── Observers other than the standard one ────────────────────────────

/**
 * CIE76 ΔE from a 0xRRGGBB pair, written out here independently of the
 * module's own sRGB → L*a*b* → distance chain.
 *
 * What this is worth, stated honestly: it is a TRANSCRIPTION check, not an
 * independent implementation. Both copies came from the same definition, so
 * a shared misreading of CIE 15:2004 would show up in neither; what it
 * catches is a typo'd matrix coefficient or a dropped term in one of them.
 * That is worth having — the module's chain is now three functions deep and
 * this one is flat — but it is not an oracle.
 *
 * The oracle is SHARMA_CIEDE2000_VECTORS below, which is a published
 * known-answer set this file could not have produced for itself.
 */
function deltaE(a: number, b: number): number {
  const lab = (c: number) => {
    const ch = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const r = ch(((c >> 16) & 0xff) / 255);
    const g = ch(((c >> 8) & 0xff) / 255);
    const bl = ch((c & 0xff) / 255);
    const t = [
      (0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) * 100 / 95.047,
      (0.2126729 * r + 0.7151522 * g + 0.0721750 * bl) * 100 / 100,
      (0.0193339 * r + 0.1191920 * g + 0.9503041 * bl) * 100 / 108.883,
    ].map((v) => (v > 216 / 24389 ? Math.cbrt(v) : (841 / 108) * v + 4 / 29));
    return [116 * t[1] - 16, 500 * (t[0] - t[1]), 200 * (t[1] - t[2])];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * The CIEDE2000 known-answer set: Sharma, Wu & Dalal (2005), "The CIEDE2000
 * Color-Difference Formula: Implementation Notes, Supplementary Test Data,
 * and Mathematical Observations", Color Research & Application 30(1), 21–30.
 *
 * Columns: L1 a1 b1 L2 a2 b2 ΔE00, the published values to four decimals.
 *
 * These 34 pairs are not a random sample. The authors chose them to sit on
 * the discontinuities implementations get wrong — pairs straddling the
 * 0°/360° hue wrap, pairs with one neutral colour where hue is undefined,
 * and pairs in the blue region where the rotation term bites. An
 * implementation can be wrong in exactly those places and still look right
 * on ordinary colours, which is why a hand-rolled CIEDE2000 needs this and
 * not a round-trip test.
 *
 * Source: the authors' own ciede2000testdata.txt. The live copy at
 * www2.ece.rochester.edu/~gsharma/ciede2000/dataNprograms/ now 404s; this is
 * the Internet Archive capture 20211016000323 of that URL.
 */
const SHARMA_CIEDE2000_VECTORS: readonly (readonly number[])[] = [
  [50.0000, 2.6772, -79.7751, 50.0000, 0.0000, -82.7485, 2.0425],
  [50.0000, 3.1571, -77.2803, 50.0000, 0.0000, -82.7485, 2.8615],
  [50.0000, 2.8361, -74.0200, 50.0000, 0.0000, -82.7485, 3.4412],
  [50.0000, -1.3802, -84.2814, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, -1.1848, -84.8006, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, -0.9009, -85.5211, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, 0.0000, 0.0000, 50.0000, -1.0000, 2.0000, 2.3669],
  [50.0000, -1.0000, 2.0000, 50.0000, 0.0000, 0.0000, 2.3669],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0009, 7.1792],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0010, 7.1792],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0011, 7.2195],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0012, 7.2195],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0009, -2.4900, 4.8045],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0010, -2.4900, 4.8045],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0011, -2.4900, 4.7461],
  [50.0000, 2.5000, 0.0000, 50.0000, 0.0000, -2.5000, 4.3065],
  [50.0000, 2.5000, 0.0000, 73.0000, 25.0000, -18.0000, 27.1492],
  [50.0000, 2.5000, 0.0000, 61.0000, -5.0000, 29.0000, 22.8977],
  [50.0000, 2.5000, 0.0000, 56.0000, -27.0000, -3.0000, 31.9030],
  [50.0000, 2.5000, 0.0000, 58.0000, 24.0000, 15.0000, 19.4535],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.1736, 0.5854, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.2972, 0.0000, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 1.8634, 0.5757, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.2592, 0.3350, 1.0000],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.2630],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.2480, -4.9620, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.6940, 23.0331, 14.9730, -42.5619, 2.0373],
  [36.4612, 47.8580, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.4410, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.1350, 0.9033, -0.0636, -0.5514, 0.9082],
];

describe('air-hockey theme palette, to a colour-blind player', () => {
  it('simulates the two anchors the maths has to get right', () => {
    // A wrong matrix still returns plausible-looking colours, so check the
    // two values whose answers are known from outside this file.
    for (const vision of AIR_HOCKEY_VISIONS) {
      // Dichromacy is a loss of hue discrimination, not of lightness: a
      // neutral has no hue to lose and must come back untouched.
      for (const grey of [0x000000, 0x808080, 0xffffff]) {
        expect(simulateDichromacy(grey, vision), `${vision} moved a neutral`).toBe(grey);
      }
    }
    // What red-green blindness MEANS: red stops being distinguishable from
    // green, so it lands on the axis between them — the yellow axis, R
    // channel equal to G. This is the assertion the circulating tritanopia
    // matrix also passes, which is how it was caught: tritanopes keep their
    // L and M cones and discriminate red from green normally, so a tritan
    // simulation that did this to red would be wrong. Hence no tritanopia
    // in AIR_HOCKEY_VISIONS at all (VISION_PLANES explains the rest).
    for (const vision of ['protanopia', 'deuteranopia'] as const) {
      const seen = simulateDichromacy(0xff0000, vision);
      expect((seen >> 16) & 0xff, `${vision} left red off the neutral axis`)
        .toBe((seen >> 8) & 0xff);
    }
    // And the asymmetry between the two, which is real and not a rounding
    // artefact: the L cone carries most of the luminous efficiency at long
    // wavelengths, so protanopes lose brightness on red where deuteranopes
    // essentially do not. 0.2126 is pure red's share of white by definition.
    expect(relativeLuminance(0xff0000)).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance(simulateDichromacy(0xff0000, 'protanopia'))).toBeCloseTo(0.1041, 3);
    expect(relativeLuminance(simulateDichromacy(0xff0000, 'deuteranopia'))).toBeCloseTo(0.2707, 3);
    // And the standard observer is a no-op, not a round trip that quantises.
    for (const id of AIR_HOCKEY_THEMES) {
      const spec = AIR_HOCKEY_THEME_SPECS[id];
      expect(simulateDichromacy(spec.feltMouth, 'normal')).toBe(spec.feltMouth);
    }
  });

  it('matches the published CIEDE2000 answers, including the awkward ones', () => {
    // deltaE2000 is forty lines of trigonometry with three documented traps
    // in it, hand-written in this repo. Nothing else here can tell whether
    // it is right: every other test in this file consumes it, so they all
    // move together if it is wrong. This is the one check with an outside
    // answer, and the authors chose these pairs to land on the traps.
    let worst = 0;
    for (const [l1, a1, b1, l2, a2, b2, published] of SHARMA_CIEDE2000_VECTORS) {
      const got = deltaE2000([l1, a1, b1], [l2, a2, b2]);
      worst = Math.max(worst, Math.abs(got - published));
      expect(got, `CIEDE2000 (${l1},${a1},${b1}) -> (${l2},${a2},${b2})`)
        .toBeCloseTo(published, 3);
      // ΔE is a metric, so it cannot depend on which colour is named first.
      // The hue-wrap branch is exactly where a sloppy implementation stops
      // being symmetric, and four of these pairs straddle it. Today this
      // holds to the last bit, but it is asserted loosely on purpose: a
      // real wrap bug is asymmetric by order 1, not by an ULP, and pinning
      // bit-equality would fire on a refactor that changed nothing.
      expect(deltaE2000([l2, a2, b2], [l1, a1, b1]), 'asymmetric').toBeCloseTo(got, 10);
    }
    // The published values are quoted to four decimals, so agreement can
    // only be asserted to about 5e-5; pinning the figure keeps a future
    // "harmless" refactor of the formula from quietly costing accuracy.
    expect(worst, 'worst deviation from the published answers').toBeLessThan(5e-5);
    expect(SHARMA_CIEDE2000_VECTORS, 'the published set is 34 pairs').toHaveLength(34);
    // And the degenerate case the test data does not cover: a colour is at
    // no distance from itself, under either formula.
    for (const id of AIR_HOCKEY_THEMES) {
      const lab = labOf(toLinearRgb(AIR_HOCKEY_THEME_SPECS[id].puck));
      expect(deltaE2000(lab, lab)).toBe(0);
      expect(deltaE76(lab, lab)).toBe(0);
    }
  });

  it('gates on whichever of the two formulae is less generous', () => {
    // perceptualDistance takes the MINIMUM of CIE76 and CIEDE2000 rather
    // than picking one. The reason is that neither is authoritative here:
    // CIEDE2000 was fitted on pairs below ΔE 5 and this gate's floor is 15,
    // while CIE76 overstates differences between saturated colours — which
    // is precisely what CIEDE2000's S_C and S_H chroma weighting was added
    // to correct. Taking the smaller means a colour has to satisfy the
    // stricter reading, whichever that turns out to be.
    for (const id of AIR_HOCKEY_THEMES) {
      const spec = AIR_HOCKEY_THEME_SPECS[id];
      for (const [label, a, b] of AIR_HOCKEY_DISTINCT_PAIRS) {
        const p = toLinearRgb(spec[a]);
        const q = toLinearRgb(spec[b]);
        const both = [deltaE76(labOf(p), labOf(q)), deltaE2000(labOf(p), labOf(q))];
        const got = perceptualDistance(p, q);
        expect(got, `${id}: ${label} is not the smaller reading`).toBe(Math.min(...both));
      }
    }
    // On the palette as it stands CIEDE2000 is the binding one in all 10836
    // readings the ΔE gate takes, so the min currently resolves to it every
    // time. That is an observation about these colours, not a property of
    // the formulae, and it is deliberately not asserted: a future palette
    // may well reach a region where CIE76 is the stricter of the two, and
    // that is the case the min is here to cover.
  });

  it('clears the floor for protanopia and deuteranopia, every pair, every preset', () => {
    // The gate the goal reds were actually chosen against. Not required by
    // WCAG 2.1 §1.4.11, which is specified for the standard observer — this
    // module goes further, and the margin is thin enough (3.035 : 1 at
    // worst, on midnight's rink markings against its felt under
    // deuteranopia) that it has to be enforced rather than remembered.
    const issues = AIR_HOCKEY_THEMES.flatMap((id) => [
      ...airHockeyThemeContrastIssues(id, 'protanopia'),
      ...airHockeyThemeContrastIssues(id, 'deuteranopia'),
    ]);
    expect(issues).toEqual([]);
  });

  it('needs no severity sweep for contrast, and proves it rather than assuming', () => {
    // The asymmetry between the two gates: ΔE is swept across the severities
    // between the standard observer and the dichromat, contrast is not. That
    // is not an oversight and not a performance trade — contrast PROVABLY
    // has no interior minimum to find. The LMS blend is linear in severity
    // and luminance is linear in linear light, so each simulated luminance
    // is affine in severity and the ratio (La + 0.05) / (Lb + 0.05) is a
    // Möbius function of it, which is monotone. Gamut clipping is the only
    // escape and it is piecewise-linear, so it cannot manufacture one either.
    //
    // A proof that is only in a comment is a proof nobody re-runs. This
    // sweeps anyway and asserts the sweep finds nothing the ends did not:
    // if someone later makes the simulation non-linear in severity, this
    // fails and the comment above stops being a lie.
    for (const vision of ['protanopia', 'deuteranopia'] as const) {
      for (const id of AIR_HOCKEY_THEMES) {
        const spec = AIR_HOCKEY_THEME_SPECS[id];
        for (const [label, a, b] of AIR_HOCKEY_CONTRAST_PAIRS) {
          const at = (s: number) => contrastRatioOf(
            simulateDichromacyLinear(spec[a], vision, s),
            simulateDichromacyLinear(spec[b], vision, s),
          );
          const swept = Math.min(...AIR_HOCKEY_SEVERITY_SWEEP.map(at));
          // Exact equality, not toBeCloseTo: the minimum is AT an endpoint,
          // so the swept value is the very same float, not a near one.
          expect(swept, `${id}: ${label} under ${vision} dips between its ends`)
            .toBe(Math.min(at(0), at(1)));
        }
      }
    }
  });

  it('never loses the puck itself, to any observer this module can measure', () => {
    // The actual subject of #184, as opposed to the markings around it. The
    // pair above covers it too, but only as one row among eleven; it is
    // called out here because it is the one that must never come back, and a
    // failure named 'puck vs felt' says that where a list of issues does
    // not.
    for (const id of AIR_HOCKEY_THEMES) {
      const spec = AIR_HOCKEY_THEME_SPECS[id];
      for (const vision of AIR_HOCKEY_VISIONS) {
        const ratio = contrastRatio(
          simulateDichromacy(spec.puck, vision),
          simulateDichromacy(spec.feltBase, vision),
        );
        expect(ratio, `${id}: puck vs felt under ${vision}`)
          .toBeGreaterThanOrEqual(AIR_HOCKEY_MIN_CONTRAST);
      }
    }
  });

  it('keeps the marks on the table apart, not just visible', () => {
    // The gate AIR_HOCKEY_MIN_DELTA_E exists for, run at the observers.
    // Thinner than the contrast gate: ΔE 15.65 against a floor of 15, on
    // midnight's goal line against its orange mallet under deuteranopia.
    const issues = AIR_HOCKEY_VISIONS.flatMap((vision) =>
      AIR_HOCKEY_THEMES.flatMap((id) => airHockeyThemeConfusionIssues(id, vision)));
    expect(issues).toEqual([]);

    // And across every severity between them, which the contrast gate does
    // not need and this one does: 45 of the 56 ΔE curves have a strictly
    // interior minimum, the deepest of them 8.3 below both of its ends.
    // Checking only the ends would therefore pass a palette that fails in
    // the middle — and most real red-green deficiency IS in the middle,
    // anomalous trichromacy being roughly two and a half times as common
    // as the full dichromacy the endpoints model.
    const swept = AIR_HOCKEY_VISIONS.flatMap((vision) =>
      AIR_HOCKEY_THEMES.flatMap((id) =>
        AIR_HOCKEY_SEVERITY_SWEEP.flatMap((s) => airHockeyThemeConfusionIssues(id, vision, s))));
    expect(swept).toEqual([]);

    // And the same question asked with the ΔE written out above, so the two
    // implementations have to agree rather than just the one being run
    // twice. This one reads the QUANTISED simulation on purpose: it is the
    // old measurement path, kept as a second opinion, and the floor it
    // clears is lower (19.6, on arctic's mallet A against the rink markings
    // under protanopia) because CIE76 and 8-bit rounding both move the
    // numbers. It is a cross-check on the maths, not a second gate.
    for (const vision of AIR_HOCKEY_VISIONS) {
      for (const id of AIR_HOCKEY_THEMES) {
        const spec = AIR_HOCKEY_THEME_SPECS[id];
        for (const [label, a, b] of AIR_HOCKEY_DISTINCT_PAIRS) {
          const seen = deltaE(
            simulateDichromacy(spec[a], vision),
            simulateDichromacy(spec[b], vision),
          );
          expect(seen, `${id}: ${label} under ${vision}`)
            .toBeGreaterThanOrEqual(AIR_HOCKEY_MIN_DELTA_E);
        }
      }
    }
  });

  it('measures in linear light, and does not round the answer to 8 bits', () => {
    // Both gates run on simulateDichromacyLinear, not on the packed
    // 24-bit simulateDichromacy, and that is a correctness requirement
    // rather than a preference. Rounding a simulated colour back to 8 bits
    // models nothing — the eye is not quantised — and it moved a contrast
    // ratio by up to 0.103 where the tightest row clears its floor by
    // 0.035. The old gate reported a midnight goal red dipping below the
    // floor between its ends; that dip was entirely the rounding.
    const partial = simulateDichromacyLinear(0xd2535c, 'deuteranopia', 0.5);
    const encoded = partial.map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
    for (const channel of encoded) {
      expect(Math.abs(channel - Math.round(channel)), 'landed on the 8-bit grid')
        .toBeGreaterThan(0.01);
    }

    // And colours outside sRGB are kept rather than clamped. A dichromat
    // simulation routinely lands outside the display gamut; clamping would
    // compress exactly the extremes the gates are measuring, flattering
    // the palette. labOf uses Math.cbrt rather than ** (1/3) so these stay
    // real numbers instead of becoming NaN on a negative channel.
    const beyond = simulateDichromacyLinear(AIR_HOCKEY_THEME_SPECS.midnight.puck, 'deuteranopia');
    expect(beyond.some((v) => v > 1 || v < 0), 'the gamut escape was clamped away').toBe(true);
    for (const component of labOf(beyond)) expect(Number.isFinite(component)).toBe(true);

    // The packing wrapper is the one place that may round, because a
    // THREE.Color needs 24 bits — but it must agree with the linear core
    // it wraps, or the two paths have drifted.
    for (const id of AIR_HOCKEY_THEMES) {
      const spec = AIR_HOCKEY_THEME_SPECS[id];
      for (const vision of AIR_HOCKEY_VISIONS) {
        const packed = simulateDichromacy(spec.playerA, vision);
        const direct = simulateDichromacyLinear(spec.playerA, vision);
        // Written the way channelFromLinear is written, including where it
        // clamps: the floor is inside the power (a negative base would be
        // NaN) and the 0..255 clamp is applied after rounding, not before
        // the transfer function. Clamping in the wrong place is a one-bit
        // difference at the gamut edge, which is where the escapes live.
        const expected = direct.map((v) => Math.max(0, Math.min(255, Math.round(
          (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055) * 255,
        ))));
        expect([(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff],
          `${id} mallet A under ${vision}: packed and linear disagree`).toEqual(expected);
      }
    }
  });

  it('measures what the contrast rows cannot, and says so about the mallets', () => {
    // Why this is a second gate and not a redundant one, shown on the real
    // palette. The mallets are cyan and orange — the standard colourblind-safe
    // pair — which makes them unmistakable as COLOURS and all but identical in
    // BRIGHTNESS. Both halves hold at every severity, not just at the ends.
    //
    // 30 and not 50. An earlier revision asserted ΔE > 50, which passes —
    // but only because it read CIE76 on the quantised output at three
    // discrete observers, where the worst reading is 50.46. Measured the
    // way the gate measures, swept and on the stricter of the two
    // formulae, the mallets come within 33.2 of each other (sandstone
    // under protanopia, around severity 0.69). The old number was never
    // wrong; it was describing a different and more flattering
    // measurement, and it cleared by 0.46, which is luck rather than
    // margin. This asserts the same claim about the same palette with
    // room that reflects what was actually measured.
    for (const vision of AIR_HOCKEY_VISIONS) {
      for (const id of AIR_HOCKEY_THEMES) {
        const spec = AIR_HOCKEY_THEME_SPECS[id];
        for (const severity of AIR_HOCKEY_SEVERITY_SWEEP) {
          const a = simulateDichromacyLinear(spec.playerA, vision, severity);
          const b = simulateDichromacyLinear(spec.playerB, vision, severity);
          const where = `${id} mallets under ${vision} at severity ${severity.toFixed(3)}`;
          expect(perceptualDistance(a, b), where).toBeGreaterThan(30);
          expect(contrastRatioOf(a, b), where).toBeLessThan(AIR_HOCKEY_MIN_CONTRAST);
        }
      }
    }
    // The second half of that is the whole point, so pin how little room
    // it has: the mallets reach 1.81 : 1 at their most separated, barely
    // past half the 3 : 1 a contrast row would demand. There is no paint
    // that fixes this — two colours a dichromat can tell apart by hue are
    // by construction close in luminance — so the gate has to be ΔE.
    const brightest = Math.max(...AIR_HOCKEY_THEMES.flatMap((id) =>
      AIR_HOCKEY_VISIONS.flatMap((vision) => AIR_HOCKEY_SEVERITY_SWEEP.map((severity) =>
        contrastRatioOf(
          simulateDichromacyLinear(AIR_HOCKEY_THEME_SPECS[id].playerA, vision, severity),
          simulateDichromacyLinear(AIR_HOCKEY_THEME_SPECS[id].playerB, vision, severity),
        )))));
    expect(brightest, 'the mallets got far enough apart to pass a contrast gate')
      .toBeLessThan(2);
    // So a contrast row for the mallets would fail permanently while being
    // wrong about them, which is why there is not one. Asserted rather than
    // left to a comment, because the gap looks like an oversight.
    expect(
      AIR_HOCKEY_CONTRAST_PAIRS.some(
        ([, a, b]) => (a === 'playerA' && b === 'playerB') || (a === 'playerB' && b === 'playerA'),
      ),
      'the mallets are a \u0394E pair, not a contrast pair — see AIR_HOCKEY_MIN_DELTA_E',
    ).toBe(false);
  });

});

describe('the built table wears its skin', () => {
  beforeEach(() => {
    bindAirHockeyThemeDoc(new Y.Doc());
  });

  it('builds in the default skin when nothing is recorded', () => {
    const fingerprint = colourFingerprint(buildTable('table-default'));
    const arctic = AIR_HOCKEY_THEME_SPECS.arctic;
    expect(fingerprint).toContain(`${new THREE.Color(arctic.cabinet).getHexString()}/000000`);
    // And NOT in the old dark cabinet.
    expect(fingerprint).not.toContain(`${new THREE.Color(0x24303e).getHexString()}/000000`);
  });

  it('builds in the recorded skin, by item id', () => {
    // Proves the ctx.itemId wiring: two tables in one room, one recoloured.
    writeAirHockeyTheme('table-dark', 'midnight');
    const dark = colourFingerprint(buildTable('table-dark'));
    const light = colourFingerprint(buildTable('table-light'));
    expect(dark).not.toEqual(light);
    expect(dark).toContain(`${new THREE.Color(0x24303e).getHexString()}/000000`); // midnight cabinet
    expect(light).toContain(
      `${new THREE.Color(AIR_HOCKEY_THEME_SPECS.arctic.cabinet).getHexString()}/000000`,
    );
  });

  it('repaints to EXACTLY what a rebuild would have produced', () => {
    // The completeness proof. If any themed material were left out of the
    // repaint registry, the repainted table would keep a stale colour and
    // these fingerprints would diverge — which is the failure mode a
    // hand-written list of materials invites.
    for (const id of AIR_HOCKEY_THEMES) {
      bindAirHockeyThemeDoc(new Y.Doc());
      const repainted = buildTable('table-repaint');
      tableHandle(repainted).setTheme(AIR_HOCKEY_THEME_SPECS[id]);

      writeAirHockeyTheme('table-fresh', id);
      const fresh = buildTable('table-fresh');

      expect(colourFingerprint(repainted), `repaint to ${id}`).toEqual(colourFingerprint(fresh));
    }
  });

  it('paints the goal line clear of the boundary and inside its own crease', () => {
    // The GEOMETRIC half of the #184 fix, which until now had nothing
    // watching it. The mouth cannot clear feltLines on any hue — clearing
    // the puck floors its luminance, clearing the felt caps it, and every
    // preset's feltLines sits between the two (the arithmetic is in
    // airHockeyTheme.ts) — so the two marks are told apart by a strip of
    // bare felt instead of by colour. Repaint them colinear and every other
    // test in this file stays green, which is exactly the regression this
    // one exists to catch.
    //
    // Bands, not centre lines: a 6 px stroke centred on y covers y +- 3, so
    // two marks touch once their centres are closer than half their widths
    // summed. Units are texture px on the 512 x 848 felt, where 1 px is
    // about 0.297 cm of table.
    strokes.length = 0;
    buildTable('table-geometry');

    // 512 x 848 is the air-hockey playfield and no other canvas in
    // furniture.ts, so this picks out the felt without naming a draw order.
    const felt = strokes.filter((s) => s.w === 512 && s.h === 848);
    const rect = felt.find((s) => s.op === 'strokeRect');
    const creases = felt.filter((s) => s.op === 'arc' && s.args[2] === 120);
    const starts = felt.filter((s) => s.op === 'moveTo' && s.lineWidth === 8);
    const ends = felt.filter((s) => s.op === 'lineTo' && s.lineWidth === 8);

    expect(rect, 'the felt has no boundary stroke to measure against').toBeDefined();
    expect(creases, 'expected one crease arc per end').toHaveLength(2);
    expect(starts, 'the goal line is the only 8 px stroke, one per end').toHaveLength(2);
    expect(ends).toHaveLength(2);

    const [, rectY, , rectH] = rect!.args;
    const rails = [rectY, rectY + rectH]; // boundary centre lines, near and far
    const halfRail = rect!.lineWidth / 2;

    for (const end of [0, 1]) {
      const [ax, goalY] = starts[end].args;
      const [bx, endY] = ends[end].args;
      const halfMouth = starts[end].lineWidth / 2;
      expect(endY, `end ${end}: the goal line should be horizontal`).toBe(goalY);

      // 1. It no longer touches the rail it used to be painted on top of.
      const rail = rails.reduce((m, r) => (Math.abs(r - goalY) < Math.abs(m - goalY) ? r : m));
      const bareFelt = Math.abs(goalY - rail) - halfMouth - halfRail;
      expect(bareFelt, `end ${end}: goal line touches the boundary`).toBeGreaterThan(0);

      // 2. ...and it moved INBOARD to get there, not out past the rail.
      expect(goalY, `end ${end}: goal line left the playfield`).toBeGreaterThan(rails[0]);
      expect(goalY, `end ${end}: goal line left the playfield`).toBeLessThan(rails[1]);

      // 3. ...and the whole stroke still fits inside its crease, so the inset
      //    did not push the mark out through the semicircle at the corners.
      //    Worst point is a corner of the butt-capped band.
      const [cx, cy, radius] = creases[end].args;
      const reach = Math.hypot(
        Math.max(Math.abs(ax - cx), Math.abs(bx - cx)),
        Math.abs(goalY - cy) + halfMouth,
      );
      expect(reach, `end ${end}: goal line pokes through the crease arc`)
        .toBeLessThan(radius - creases[end].lineWidth / 2);
    }

    // Both ends inset by the same amount, so one cannot drift on its own.
    expect(starts[0].args[1] + starts[1].args[1], 'the two ends are not symmetric').toBe(848);
  });

  it('leaves the morph fade alone when it repaints', () => {
    // Materials start at opacity 0 and World tweens them up. A recolour that
    // reset opacity would make a table flash back to invisible mid-fade.
    const group = buildTable('table-fade');
    const opacities: number[] = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
        obj.material.opacity = 0.42; // mid-fade
        opacities.push(0.42);
      }
    });
    tableHandle(group).setTheme(AIR_HOCKEY_THEME_SPECS.midnight);
    const after: number[] = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
        after.push(obj.material.opacity);
      }
    });
    expect(after).toEqual(opacities);
    expect(after.length).toBeGreaterThan(0);
  });

  it('repaints the goal lamps without lighting them', () => {
    // The lamps carry emissive at intensity 0 until flashGoal strobes them.
    // The skin owns the hue; update() owns the intensity.
    const group = buildTable('table-lamps');
    tableHandle(group).setTheme(AIR_HOCKEY_THEME_SPECS.midnight);
    const lamps: THREE.MeshStandardMaterial[] = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial
        && obj.material.emissive.getHex() !== 0) {
        lamps.push(obj.material);
      }
    });
    expect(lamps.length).toBe(2);
    for (const lamp of lamps) {
      expect(lamp.emissive.getHex()).toBe(AIR_HOCKEY_THEME_SPECS.midnight.goalLamp);
      expect(lamp.emissiveIntensity).toBe(0);
    }
  });

  it('repaints the FELT, which is where the lighter table actually lives', () => {
    // The material fingerprint above cannot see this: the playfield is a
    // CanvasTexture, so forgetting to re-run the felt painter would leave the
    // table's single most visible surface in the old colours while every
    // solid part changed around it.
    const group = buildTable('table-felt');
    paint.length = 0;
    tableHandle(group).setTheme(AIR_HOCKEY_THEME_SPECS.midnight);
    const midnight = AIR_HOCKEY_THEME_SPECS.midnight;
    expect(paint).toContain(`fillStyle=${hexCss(midnight.feltBase)}`);
    expect(paint).toContain(`strokeStyle=${hexCss(midnight.feltLines)}`);
    expect(paint).toContain(`fillStyle=${hexCss(midnight.scoreBg)}`); // and the board
  });

  it('re-uploads both canvases, or the repaint never reaches the screen', () => {
    const group = buildTable('table-upload');
    const before = textureVersions(group);
    expect(before.length).toBeGreaterThan(0);
    tableHandle(group).setTheme(AIR_HOCKEY_THEME_SPECS.midnight);
    const after = textureVersions(group);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < after.length; i += 1) {
      expect(after[i], `texture ${i}`).toBeGreaterThan(before[i]);
    }
  });

  it('replays the live score instead of resetting the board to 0:0', () => {
    // A recolour must not look like a restart to the two people playing.
    const group = buildTable('table-midmatch');
    const handle = tableHandle(group);
    handle.setScore(3, 2, 'match point');
    paint.length = 0;
    handle.setTheme(AIR_HOCKEY_THEME_SPECS.midnight);
    expect(paint).toContain('fillText:3');
    expect(paint).toContain('fillText:2');
    expect(paint).toContain('fillText:MATCH POINT');
    expect(paint).not.toContain('fillText:0');
  });

  it('is a no-op when the skin did not change', () => {
    // World calls this on every doc notify, including every join — so the
    // cheap path has to be genuinely cheap: no canvas work at all.
    const group = buildTable('table-noop');
    const before = colourFingerprint(group);
    const versions = textureVersions(group);
    paint.length = 0;
    tableHandle(group).setTheme(AIR_HOCKEY_THEME_SPECS[DEFAULT_AIR_HOCKEY_THEME]);
    expect(colourFingerprint(group)).toEqual(before);
    expect(textureVersions(group)).toEqual(versions);
    expect(paint).toEqual([]);
  });
});
