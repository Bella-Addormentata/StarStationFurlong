import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  CREAM_COLOURS,
  DEFAULT_LOOK,
  EAR_STYLES,
  EYE_COLOURS,
  EYE_SHAPES,
  FUR_COLOURS,
  SIZES,
  cleanLook,
  lookParts,
  randomLook,
  sameLook,
  type FoxLook,
} from './foxLook';
import { OUTFITS, getOutfitById, tintFur } from './outfits';

/** Every colour the fake face canvas was handed, in order. */
const painted: string[] = [];
/** A canvas whose 2-D context draws nothing, and notes its fill colours. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ width: 40 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set: (target, key, value) => {
      if (key === 'fillStyle' || key === 'strokeStyle') painted.push(String(value));
      target[key] = value;
      return true;
    },
  });
  return { width: 0, height: 0, style: {}, getContext: () => ctx };
}
vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const { VoxelCharacter, shadeOf } = await import('./voxelCharacter');

const LISTS = { fur: FUR_COLOURS, cream: CREAM_COLOURS, eyes: EYE_SHAPES, eyeColour: EYE_COLOURS, ears: EAR_STYLES, size: SIZES } as const;

describe('a look', () => {
  it('is cleaned from anything: each choice a whole number in range, else its default', () => {
    expect(cleanLook(undefined)).toEqual(DEFAULT_LOOK);
    expect(cleanLook(null)).toEqual(DEFAULT_LOOK);
    expect(cleanLook('fur=3')).toEqual(DEFAULT_LOOK);
    expect(cleanLook({ fur: 3, cream: 1, eyes: 4, eyeColour: 5, ears: 2, size: 0 })).toEqual({ fur: 3, cream: 1, eyes: 4, eyeColour: 5, ears: 2, size: 0 });
    const junk = cleanLook({ fur: 1.5, cream: -1, eyes: 99, eyeColour: '2', ears: NaN, size: Infinity, extra: 7 });
    expect(junk).toEqual(DEFAULT_LOOK);
    expect(Object.keys(junk).sort()).toEqual(Object.keys(DEFAULT_LOOK).sort());
    // The last of each list is in range; one past it is not.
    for (const [key, list] of Object.entries(LISTS) as [keyof FoxLook, readonly unknown[]][]) {
      expect(cleanLook({ [key]: list.length - 1 })[key], key).toBe(list.length - 1);
      expect(cleanLook({ [key]: list.length })[key], key).toBe(DEFAULT_LOOK[key]);
    }
  });

  it('by default is the fox as it was first drawn', () => {
    const parts = lookParts(DEFAULT_LOOK);
    const rig = readFileSync(fileURLToPath(new URL('./voxelCharacter.ts', import.meta.url)), 'utf8');
    const pal = (name: string) => Number(new RegExp(`\\n  ${name}:\\s+(0x[0-9a-f]{6}),`).exec(rig)![1]);
    expect(parts.fur).toBe(pal('fur'));
    expect(parts.cream).toBe(pal('cream'));
    expect(parts.innerEar).toBe(pal('furShade'));
    expect(rig).toContain(`private faceDrawn = { shape: 'round' as EyeShape, eye: '${parts.eye}', sheen: '${parts.eyeSheen}' };`);
    expect(parts.eyeShape).toBe('round');
    expect([parts.earScale, parts.earHeight, parts.earLean, parts.size]).toEqual([1, 1, 0, 1]);
  });

  it('has a name and an id of its own for every choice', () => {
    for (const list of Object.values(LISTS)) {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const x of list) expect(x.name.length).toBeGreaterThan(0);
    }
  });

  it('drawn at random stays in range', () => {
    expect(randomLook(() => 0)).toEqual({ fur: 0, cream: 0, eyes: 0, eyeColour: 0, ears: 0, size: 0 });
    const last = randomLook(() => 0.999999);
    for (const [key, list] of Object.entries(LISTS) as [keyof FoxLook, readonly unknown[]][]) expect(last[key]).toBe(list.length - 1);
    for (let i = 0; i < 50; i++) {
      const look = randomLook();
      expect(sameLook(cleanLook(look), look)).toBe(true);
    }
  });

  describe('saved on this computer', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.stubGlobal('document', { createElement: fakeCanvas });
      vi.stubGlobal('window', { location: { search: '' } });
    });

    /** foxLook.ts as a page that just loaded has it: nothing kept yet. */
    const freshPage = async () => {
      vi.resetModules();
      return import('./foxLook');
    };

    it('comes back as it was saved, and as none when nothing was', async () => {
      const store = new Map<string, string>();
      vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
      const page = await freshPage();
      expect(page.loadSavedLook()).toBeNull();
      page.saveLook({ fur: 4, cream: 2, eyes: 1, eyeColour: 3, ears: 4, size: 1 });
      expect(store.get('ssf-fox-look')).toBe(JSON.stringify({ fur: 4, cream: 2, eyes: 1, eyeColour: 3, ears: 4, size: 1 }));
      expect(page.loadSavedLook()).toEqual({ fur: 4, cream: 2, eyes: 1, eyeColour: 3, ears: 4, size: 1 });
      // The next page load reads it from the computer; a broken value is none.
      expect((await freshPage()).loadSavedLook()).toEqual({ fur: 4, cream: 2, eyes: 1, eyeColour: 3, ears: 4, size: 1 });
      store.set('ssf-fox-look', '{not json');
      expect((await freshPage()).loadSavedLook()).toBeNull();
    });

    it('is none until chosen, and then this page\'s choice, where the browser keeps nothing', async () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      });
      const page = await freshPage();
      expect(page.loadSavedLook()).toBeNull();
      expect(() => page.saveLook({ ...DEFAULT_LOOK, fur: 7, ears: 2 })).not.toThrow();
      // Still there to draw and to write into the players entry.
      expect(page.loadSavedLook()).toEqual({ ...DEFAULT_LOOK, fur: 7, ears: 2 });
    });

    it('is this page\'s latest choice even where an older one is on the computer and the save fails', async () => {
      const store = new Map<string, string>([['ssf-fox-look', JSON.stringify({ ...DEFAULT_LOOK, fur: 2 })]]);
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new Error('full');
        },
      });
      const page = await freshPage();
      expect(page.loadSavedLook()).toEqual({ ...DEFAULT_LOOK, fur: 2 });
      page.saveLook({ ...DEFAULT_LOOK, fur: 9 });
      expect(page.loadSavedLook()).toEqual({ ...DEFAULT_LOOK, fur: 9 });
    });
  });
});

describe('a shade of a colour', () => {
  it('scales each channel as the shade is against its base', () => {
    expect(shadeOf(0x808080, 0xdfcfae, 0xdfcfae)).toBe(0x808080);
    expect(shadeOf(0xf2e6cd, 0xdfcfae, 0xf2e6cd)).toBe(0xdfcfae);
    expect(shadeOf(0x804020, 0x402010, 0x804020)).toBe(0x402010);
    expect(shadeOf(0x646464, 0x323232, 0x646464)).toBe(0x323232);
    // Never past full, and a zero base leaves the channel as it is.
    expect(shadeOf(0xffffff, 0xffffff, 0x808080)).toBe(0xffffff);
    expect(shadeOf(0x123456, 0x101010, 0x000000)).toBe(0x123456);
  });
});

describe('an outfit\'s fur tint', () => {
  it('moves each channel of the fur the asked way toward the tint', () => {
    const tint = (amount: number) => tintFur(0x204060, { color: 0x6080a0, amount });
    expect(tint(0)).toBe(0x204060);
    expect(tint(1)).toBe(0x6080a0);
    expect(tint(0.5)).toBe(0x406080);
    // Out of range, or not a number, it goes no further than either end.
    expect(tint(7)).toBe(0x6080a0);
    expect(tint(-1)).toBe(0x204060);
    expect(tint(NaN)).toBe(0x204060);
    expect(tintFur(0xff0000, { color: 0x000000, amount: 0.5 })).toBe(0x800000);
  });

  it('is asked for with a colour and an amount in range', () => {
    const tinted = OUTFITS.filter((o) => o.furTint);
    expect(tinted.map((o) => o.id)).toEqual(['midnight']);
    for (const o of tinted) {
      expect(o.furTint!.amount).toBeGreaterThan(0);
      expect(o.furTint!.amount).toBeLessThanOrEqual(1);
      expect(Number.isInteger(o.furTint!.color) && o.furTint!.color >= 0 && o.furTint!.color <= 0xffffff).toBe(true);
    }
  });
});

describe('the fox rig in a look', () => {
  const rig = () => new VoxelCharacter(new THREE.Scene());
  /** The colour of the first material of each palette role. */
  const colours = (r: InstanceType<typeof VoxelCharacter>) => {
    const out: Record<string, number> = {};
    r.masterGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const role = mesh.userData?.paletteRole as string | undefined;
      if (mesh.isMesh && role && !(role in out)) out[role] = (mesh.material as THREE.MeshToonMaterial).color.getHex();
    });
    return out;
  };
  const ears = (r: InstanceType<typeof VoxelCharacter>) => {
    const any = r as unknown as { leftEar: THREE.Group; rightEar: THREE.Group };
    return [any.leftEar, any.rightEar];
  };
  const height = (r: InstanceType<typeof VoxelCharacter>) => {
    r.masterGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(r.masterGroup);
    return box.max.y - box.min.y;
  };
  /** Every colour each palette role is drawn in, each once, in order. */
  const allColours = (r: InstanceType<typeof VoxelCharacter>) => {
    const out: Record<string, number[]> = {};
    r.masterGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const role = mesh.userData?.paletteRole as string | undefined;
      if (!mesh.isMesh || !role) return;
      const hex = (mesh.material as THREE.MeshToonMaterial).color.getHex();
      if (!(out[role] ??= []).includes(hex)) out[role].push(hex);
    });
    return out;
  };
  const SNOW_SMOKE = { ...DEFAULT_LOOK, fur: 1, cream: 4 };

  it('takes the look\'s fur, markings and inner ears, and keeps its paws', () => {
    const r = rig();
    const before = colours(r);
    r.setLook(lookParts(SNOW_SMOKE));
    const after = colours(r);
    expect(after.fur).toBe(FUR_COLOURS[1].fur);
    expect(after.cream).toBe(CREAM_COLOURS[4].cream);
    expect(after.furDeep).toBe(CREAM_COLOURS[4].innerEar);
    expect(after.accent).toBe(before.accent);
    r.setLook(null);
    expect(colours(r)).toEqual(before);
  });

  it('in the default look is every material as first drawn, both ear-cavity shades too', () => {
    const r = rig();
    const before = allColours(r);
    expect(before.furDeep.length, 'the ear cavity is drawn in two shades').toBe(2);
    r.setLook(lookParts(DEFAULT_LOOK));
    expect(allColours(r)).toEqual(before);
    // Only the fur changed: the cavity keeps both its shades.
    r.setLook(lookParts({ ...DEFAULT_LOOK, fur: 6 }));
    expect(allColours(r).furDeep).toEqual(before.furDeep);
  });

  it('keeps the ear cavity\'s two shades, each in its place against the look\'s inner ear', () => {
    const r = rig();
    const [shade, shadeLo] = allColours(r).furDeep;
    r.setLook(lookParts(SNOW_SMOKE));
    const inner = CREAM_COLOURS[4].innerEar;
    expect(allColours(r).furDeep).toEqual([inner, shadeOf(inner, shadeLo, shade)]);
  });

  it('worn with an outfit keeps its own colours, and the outfit its paws and accessory, either way round', () => {
    const ember = getOutfitById('ember')!;
    const a = rig();
    a.setOutfit(ember);
    a.setLook(lookParts(SNOW_SMOKE));
    const b = rig();
    b.setLook(lookParts(SNOW_SMOKE));
    b.setOutfit(ember);
    for (const r of [a, b]) {
      const c = colours(r);
      expect(c.fur).toBe(FUR_COLOURS[1].fur);
      expect(c.cream).toBe(CREAM_COLOURS[4].cream);
      expect(c.furDeep).toBe(CREAM_COLOURS[4].innerEar);
      expect(c.accent).toBe(ember.paletteOverrides.accent);
      expect((r as unknown as { accessoryGroup: THREE.Group | null }).accessoryGroup).not.toBeNull();
    }
    // Out of the outfit, the look stays and the paws come back.
    const plain = colours(rig());
    b.clearOutfit();
    expect(colours(b)).toEqual({ ...plain, fur: FUR_COLOURS[1].fur, cream: CREAM_COLOURS[4].cream, furDeep: CREAM_COLOURS[4].innerEar });
  });

  it('with no look, an outfit recolours the whole fox as before', () => {
    const midnight = getOutfitById('midnight')!;
    const r = rig();
    r.setOutfit(midnight);
    const c = colours(r);
    for (const role of ['fur', 'furDeep', 'cream', 'accent'] as const) expect(c[role]).toBe(midnight.paletteOverrides[role]);
  });

  it('in an outfit that asks for a tint, lays it over its own fur and nowhere else', () => {
    const midnight = getOutfitById('midnight')!;
    expect(midnight.furTint).toBeDefined();
    for (const order of ['look first', 'outfit first']) {
      const r = rig();
      if (order === 'look first') r.setLook(lookParts(SNOW_SMOKE));
      r.setOutfit(midnight);
      if (order === 'outfit first') r.setLook(lookParts(SNOW_SMOKE));
      const c = colours(r);
      expect(c.fur, order).toBe(tintFur(FUR_COLOURS[1].fur, midnight.furTint!));
      expect(c.fur, order).not.toBe(FUR_COLOURS[1].fur);
      expect(c.cream, order).toBe(CREAM_COLOURS[4].cream);
      expect(c.furDeep, order).toBe(CREAM_COLOURS[4].innerEar);
      expect(c.accent, order).toBe(midnight.paletteOverrides.accent);
      // Out of the outfit, the fur is its own again.
      r.clearOutfit();
      expect(colours(r).fur, order).toBe(FUR_COLOURS[1].fur);
    }
  });

  it('comes out of the clone vat\'s pallor in its own colours', () => {
    const r = rig();
    r.setPallor(0.6);
    r.setLook(lookParts(SNOW_SMOKE));
    expect(colours(r).fur).not.toBe(FUR_COLOURS[1].fur);
    r.setPallor(0);
    expect(colours(r).fur).toBe(FUR_COLOURS[1].fur);
  });

  it('draws its eyes in their colour, and only when they change', () => {
    const r = rig();
    painted.length = 0;
    r.setLook(lookParts({ ...DEFAULT_LOOK, eyes: 1, eyeColour: 2 }));
    expect(painted).toContain(EYE_COLOURS[2].eye);
    expect(painted).toContain(EYE_COLOURS[2].sheen);
    expect(painted).not.toContain(EYE_COLOURS[0].eye);
    painted.length = 0;
    r.setLook(lookParts({ ...DEFAULT_LOOK, eyes: 1, eyeColour: 2, fur: 3 }));
    expect(painted).toEqual([]);
    for (let shape = 0; shape < EYE_SHAPES.length; shape++) {
      painted.length = 0;
      r.setLook(lookParts({ ...DEFAULT_LOOK, eyes: shape, eyeColour: 5 }));
      expect(painted.length, EYE_SHAPES[shape].id).toBeGreaterThan(0);
    }
  });

  it('sets its ears\' size and lean, both sides alike', () => {
    const r = rig();
    const [l0, r0] = ears(r).map((e) => ({ scale: e.scale.clone(), z: e.rotation.z }));
    const droopy = EAR_STYLES.findIndex((e) => e.id === 'droopy');
    r.setLook(lookParts({ ...DEFAULT_LOOK, ears: droopy }));
    const [left, right] = ears(r);
    const style = EAR_STYLES[droopy];
    expect(left.scale.x).toBeCloseTo(style.scale);
    expect(left.scale.y).toBeCloseTo(l0.scale.y * style.scale * style.height);
    expect(left.rotation.z).toBeCloseTo(l0.z + style.lean);
    expect(right.rotation.z).toBeCloseTo(r0.z - style.lean);
    r.setLook(null);
    expect(left.scale.toArray()).toEqual(l0.scale.toArray());
    expect(right.rotation.z).toBeCloseTo(r0.z);
  });

  it('grows or shrinks from its feet, and still squishes', () => {
    const r = rig();
    (r as unknown as { clock: { getDelta: () => number; getElapsedTime: () => number } }).clock = { getDelta: () => 0.02, getElapsedTime: () => 0 };
    r.update();
    const h0 = height(r);
    const tall = SIZES.findIndex((s) => s.id === 'tall');
    r.setLook(lookParts({ ...DEFAULT_LOOK, size: tall }));
    r.update();
    expect(height(r) / h0).toBeCloseTo(SIZES[tall].scale, 2);
    r.squishTo(0.6, 0);
    for (let i = 0; i < 80; i++) r.update();
    const visual = (r as unknown as { visualGroup: THREE.Group }).visualGroup;
    expect(visual.scale.x).toBeCloseTo(0.6 * SIZES[tall].scale, 2);
    expect(visual.scale.y).toBeCloseTo(SIZES[tall].scale);
    expect(r.masterGroup.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('is drawn as first drawn while the clone vat has it, then eases to its own size', () => {
    const r = rig();
    (r as unknown as { clock: { getDelta: () => number; getElapsedTime: () => number } }).clock = { getDelta: () => 0.02, getElapsedTime: () => 0 };
    const visual = (r as unknown as { visualGroup: THREE.Group }).visualGroup;
    const tall = SIZES[SIZES.findIndex((s) => s.id === 'tall')].scale;
    r.setLook(lookParts({ ...DEFAULT_LOOK, size: 4 }));
    expect(r.getDrawnSize()).toBe(tall);
    r.holdStandardSize(true);
    expect([r.getDrawnSize(), visual.scale.y]).toEqual([1, 1]);
    // A look put on in the vat waits for it to let go.
    r.setLook(lookParts({ ...DEFAULT_LOOK, size: 4, fur: 2 }));
    for (let i = 0; i < 20; i++) r.update();
    expect([r.getDrawnSize(), visual.scale.y]).toEqual([1, 1]);
    r.holdStandardSize(false);
    r.update();
    expect(r.getDrawnSize()).toBeGreaterThan(1);
    expect(r.getDrawnSize()).toBeLessThan(tall);
    for (let i = 0; i < 120; i++) r.update();
    expect([r.getDrawnSize(), visual.scale.y]).toEqual([tall, tall]);
  });
});

describe('the wiring', () => {
  const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
  const world = readFileSync(fileURLToPath(new URL('./world.ts', import.meta.url)), 'utf8');

  it('draws the saved look on our fox, and writes it into our players entry', () => {
    expect(main).toContain('const savedLook = loadSavedLook();\n    if (savedLook) (world.getPlayer() as any).character.setLook(lookParts(savedLook));');
    const writer = main.indexOf('function updateLocalPlayerEntry(): void {');
    const body = main.slice(writer, main.indexOf('\n}\n', writer));
    expect(body).toContain('const savedLook = loadSavedLook();');
    expect(body).toContain('...(savedLook ? { look: savedLook } : {}),');
    const apply = main.indexOf('const applyLook = (raw: unknown): FoxLook => {');
    const applied = main.slice(apply, apply + 400);
    expect(applied).toContain('const look = cleanLook(raw);');
    expect(applied).toContain('saveLook(look);');
    expect(applied).toContain('updateLocalPlayerEntry();');
  });

  it('holds our fox at the vat\'s size while the vat has it, and squishes every fox by its drawn size', () => {
    const player = readFileSync(fileURLToPath(new URL('./player.ts', import.meta.url)), 'utf8');
    expect(player).toContain('this.character.holdStandardSize(this.isVatBound());');
    const spawn = player.slice(player.indexOf('public beginVatSpawn('), player.indexOf('public walkOutOfVat('));
    expect(spawn).toContain('this.character.holdStandardSize(true);');
    expect(world).toContain('foxSquish(at, facing, foxes.filter((f) => f.rig !== rig), size);');
    expect(world).toContain('squishOf(null, me.position, this.player.getDrawnFacing(), this.player.getDrawnSize());');
    expect(world).toContain('squishOf(avatar.rig, pos, avatar.rig.getFacing(), avatar.rig.getDrawnSize());');
  });

  it('dresses a remote fox in the look its entry names, with or without an outfit this game knows', () => {
    const resolver = main.indexOf('world.setPeerLooks((peerId) => {');
    const body = main.slice(resolver, resolver + 400);
    expect(body).toContain('const look = found.look ? lookParts(found.look) : null;');
    expect(body).toContain('return outfit || look ? { outfit, look } : null;');
    const dress = world.indexOf('private dressPeer(avatar: RemoteAvatar, id: string): void {');
    const dressed = world.slice(dress, world.indexOf('\n  }\n', dress));
    expect(dressed).toContain('avatar.rig.setLook(dress.look);');
    expect(dressed).toContain('avatar.rig.setLook(null);');
  });
});
