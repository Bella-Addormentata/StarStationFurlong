/**
 * Outfits — palette-swap presets + local persistence (TR3, issue #35).
 *
 * An outfit is a set of ABSOLUTE hex overrides for the fox rig's swappable
 * palette roles (see voxelCharacter.ts palette-role tagging) plus at most one
 * head accessory. Roles missing from `paletteOverrides` fall back to the
 * rig's original PAL colors, so switching outfits never leaves stale colors
 * behind and re-applying the same outfit is idempotent (no drift).
 *
 * LOCAL ONLY (sync honesty, plan §3 TR3): the saved outfit dresses the local
 * rig; remote avatars keep #27's per-peer hue tint until phone-plan S2 lands
 * an identity lane that can carry an outfit id.
 */

/** Swappable color slots on the fox rig. Mirrors the PAL entries that are
 *  safe to recolor: main fur, deep-fur shading, cream markings, and the dark
 *  sock/glove/paw accents. Face decal, paw pads, nose, eyes, and the shared
 *  outline material are deliberately NOT roles. */
export type PaletteRole = 'fur' | 'furDeep' | 'cream' | 'accent';

/** Procedural head-slot accessories built by VoxelCharacter. */
export type AccessoryKind = 'cap' | 'visor' | 'scarf';

export interface OutfitDef {
  id: string;
  name: string;
  /** Absolute hex per role. Missing roles restore the rig's original color. */
  paletteOverrides: Partial<Record<PaletteRole, number>>;
  accessory?: AccessoryKind;
}

/** Preset catalogue. 'default' = the pristine fox (no overrides, no accessory). */
export const OUTFITS: OutfitDef[] = [
  {
    id: 'default',
    name: 'Station Standard',
    paletteOverrides: {},
  },
  {
    // Silver-blue arctic courier — cool fur, near-white cream, deep navy socks.
    id: 'midnight',
    name: 'Midnight Courier',
    paletteOverrides: { fur: 0x4a5a70, furDeep: 0x323f52, cream: 0xe4ebf2, accent: 0x1a2430 },
    accessory: 'cap',
  },
  {
    // Deep red flight-crew fox — richer rust fur, warm parchment cream.
    id: 'ember',
    name: 'Ember Flightcrew',
    paletteOverrides: { fur: 0xb03a26, furDeep: 0x84271a, cream: 0xf2e2c4, accent: 0x461410 },
    accessory: 'scarf',
  },
  {
    // Arctic white scout — snow fur, pale-slate accents, tinted visor.
    id: 'snowdrift',
    name: 'Snowdrift Scout',
    paletteOverrides: { fur: 0xe9edf3, furDeep: 0xc3ccd9, cream: 0xffffff, accent: 0x808fa1 },
    accessory: 'visor',
  },
];

export function getOutfitById(id: string): OutfitDef | undefined {
  return OUTFITS.find((o) => o.id === id);
}

// ── Local persistence ───────────────────────────────────────────────────────
// One key, one string. try/catch: localStorage throws in some privacy modes,
// and a cosmetic preference must never take the app down.
const STORAGE_KEY = 'ssf-outfit';

export function loadSavedOutfitId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveOutfitId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* cosmetic preference — losing it is fine */
  }
}
