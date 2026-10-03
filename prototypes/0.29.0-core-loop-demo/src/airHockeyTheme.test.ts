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
  AIR_HOCKEY_MIN_CONTRAST,
  AIR_HOCKEY_THEME_LABELS,
  AIR_HOCKEY_THEME_SPECS,
  AIR_HOCKEY_THEMES,
  DEFAULT_AIR_HOCKEY_THEME,
  airHockeyTheme,
  airHockeyThemeContrastIssues,
  contrastRatio,
  hexCss,
  isAirHockeyThemeId,
  relativeLuminance,
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

/** A canvas that draws nothing but remembers what it was asked to draw
 *  (the airHockeyTable.test.ts stub, with a recorder on the two calls that
 *  carry the skin). */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillText' || key === 'strokeText') {
        return (text: unknown) => { paint.push(`${String(key)}:${String(text)}`); };
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
  return { width: 0, height: 0, getContext: () => ctx };
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
    // `midnight` is the original table with ONE colour changed.
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
    expect(hexCss(0x0b6b82)).toBe('#0b6b82'); // leading zero kept
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
