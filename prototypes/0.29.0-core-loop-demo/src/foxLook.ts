/**
 * 🦊 The fox's own look: fur and marking colours, eyes, ears and size.
 *
 * Where an outfit is what the fox wears (outfits.ts: an accessory and the
 * colour of its paws), the look is the fox itself. It is chosen once by the
 * player, saved on this computer (`ssf-fox-look`), written into the player's
 * entry in the room doc (`look`), and read by the room's other pages to draw
 * that player's fox (peerLooks.ts).
 *
 * A look is a handful of small numbers, each an index into one of the lists
 * below (the pattern Veloren's character creator uses: every choice a small
 * index, and every reader clamps it to what it knows). A players entry is
 * anyone's to write, so `cleanLook` turns anything at all into a look this
 * game can draw: a number that is not a whole number in range takes the
 * default for that choice. A newer game's extra choices read as defaults.
 *
 * Index 0 of every list is the fox as it was drawn before there was a look
 * (voxelCharacter.ts PAL and the face decal), so the default look changes
 * nothing.
 */

/** A fur colour: the body fur, and the inner ear drawn beside it. */
export interface FurSwatch {
  id: string;
  name: string;
  fur: number;
}

/** A marking colour: muzzle, chest bib and tail tip, and the inner ear. */
export interface CreamSwatch {
  id: string;
  name: string;
  cream: number;
  /** The inner-ear cavity (palette role `furDeep`), a shade under `cream`. */
  innerEar: number;
}

export const FUR_COLOURS: readonly FurSwatch[] = [
  { id: 'fox', name: 'Fox', fur: 0xe07a2c },
  { id: 'snow', name: 'Snow', fur: 0xf3efe6 },
  { id: 'golden', name: 'Golden', fur: 0xe9ad45 },
  { id: 'russet', name: 'Russet', fur: 0xa9431f },
  { id: 'sand', name: 'Sand', fur: 0xd6b88a },
  { id: 'silver', name: 'Silver', fur: 0xa7aeb8 },
  { id: 'charcoal', name: 'Charcoal', fur: 0x4b4752 },
  { id: 'cocoa', name: 'Cocoa', fur: 0x6c4028 },
  { id: 'midnight', name: 'Midnight', fur: 0x35425c },
  { id: 'rose', name: 'Rose', fur: 0xd98c9b },
  { id: 'mint', name: 'Mint', fur: 0x7ec3a6 },
  { id: 'lilac', name: 'Lilac', fur: 0xa58dca },
];

export const CREAM_COLOURS: readonly CreamSwatch[] = [
  { id: 'cream', name: 'Cream', cream: 0xfaf1d8, innerEar: 0xf2e6cd },
  { id: 'white', name: 'White', cream: 0xffffff, innerEar: 0xf1f1f3 },
  { id: 'grey', name: 'Grey', cream: 0xc9ccd3, innerEar: 0xbcc0c8 },
  { id: 'tan', name: 'Tan', cream: 0xe3c49b, innerEar: 0xd7b78c },
  { id: 'smoke', name: 'Smoke', cream: 0x5c5862, innerEar: 0x6a6670 },
  { id: 'blush', name: 'Blush', cream: 0xf6d5d9, innerEar: 0xefc4ca },
];

/** How the eyes are drawn on the face decal (voxelCharacter.ts). */
export type EyeShape = 'round' | 'big' | 'narrow' | 'sleepy' | 'happy';
export const EYE_SHAPES: readonly { id: EyeShape; name: string }[] = [
  { id: 'round', name: 'Round' },
  { id: 'big', name: 'Big' },
  { id: 'narrow', name: 'Narrow' },
  { id: 'sleepy', name: 'Sleepy' },
  { id: 'happy', name: 'Happy' },
];

/** An eye colour: the eye and its lighter lower sheen, as CSS colours. */
export const EYE_COLOURS: readonly { id: string; name: string; eye: string; sheen: string }[] = [
  { id: 'blue', name: 'Blue', eye: '#2f5fa8', sheen: '#4a80c8' },
  { id: 'green', name: 'Green', eye: '#2c7d4f', sheen: '#46a06b' },
  { id: 'amber', name: 'Amber', eye: '#b8701a', sheen: '#d9922f' },
  { id: 'brown', name: 'Brown', eye: '#5e3a22', sheen: '#7e5434' },
  { id: 'violet', name: 'Violet', eye: '#6a43a3', sheen: '#8a62c4' },
  { id: 'charcoal', name: 'Charcoal', eye: '#35333a', sheen: '#4a4852' },
];

/** The ears: their size against the drawn ear, and how far they lean out. */
export const EAR_STYLES: readonly { id: string; name: string; scale: number; height: number; lean: number }[] = [
  { id: 'tall', name: 'Tall', scale: 1, height: 1, lean: 0 },
  { id: 'short', name: 'Short', scale: 0.92, height: 0.74, lean: 0 },
  { id: 'big', name: 'Big', scale: 1.14, height: 1.08, lean: 0.06 },
  { id: 'wide', name: 'Wide', scale: 1, height: 0.94, lean: 0.34 },
  { id: 'droopy', name: 'Droopy', scale: 0.96, height: 0.9, lean: 0.85 },
];

/** Body size: the whole drawn fox, from its feet. */
export const SIZES: readonly { id: string; name: string; scale: number }[] = [
  { id: 'tiny', name: 'Tiny', scale: 0.9 },
  { id: 'small', name: 'Small', scale: 0.95 },
  { id: 'standard', name: 'Standard', scale: 1 },
  { id: 'big', name: 'Big', scale: 1.05 },
  { id: 'tall', name: 'Tall', scale: 1.1 },
];

export interface FoxLook {
  fur: number;
  cream: number;
  eyes: number;
  eyeColour: number;
  ears: number;
  size: number;
}

/** The fox as it was drawn before there was a look. */
export const DEFAULT_LOOK: Readonly<FoxLook> = Object.freeze({ fur: 0, cream: 0, eyes: 0, eyeColour: 0, ears: 0, size: 2 });

const RANGES: Readonly<Record<keyof FoxLook, number>> = {
  fur: FUR_COLOURS.length,
  cream: CREAM_COLOURS.length,
  eyes: EYE_SHAPES.length,
  eyeColour: EYE_COLOURS.length,
  ears: EAR_STYLES.length,
  size: SIZES.length,
};

const KEYS = Object.keys(RANGES) as (keyof FoxLook)[];

/** Any value at all, as a look this game can draw (see the header). */
export function cleanLook(raw: unknown): FoxLook {
  const out: FoxLook = { ...DEFAULT_LOOK };
  if (!raw || typeof raw !== 'object') return out;
  const given = raw as Record<string, unknown>;
  for (const key of KEYS) {
    const v = given[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < RANGES[key]) out[key] = v;
  }
  return out;
}

export function sameLook(a: FoxLook, b: FoxLook): boolean {
  return KEYS.every((key) => a[key] === b[key]);
}

/** A look with every choice drawn at random (the RANDOM button of part 3). */
export function randomLook(rand: () => number = Math.random): FoxLook {
  const pick = (n: number) => Math.min(n - 1, Math.floor(rand() * n));
  const out = { ...DEFAULT_LOOK };
  for (const key of KEYS) out[key] = pick(RANGES[key]);
  return out;
}

/** The colours, shapes and sizes a look stands for, for the rig to draw. */
export interface FoxLookParts {
  fur: number;
  cream: number;
  innerEar: number;
  eyeShape: EyeShape;
  eye: string;
  eyeSheen: string;
  earScale: number;
  earHeight: number;
  earLean: number;
  size: number;
}

export function lookParts(look: FoxLook): FoxLookParts {
  const l = cleanLook(look);
  const cream = CREAM_COLOURS[l.cream];
  const eyes = EYE_COLOURS[l.eyeColour];
  const ears = EAR_STYLES[l.ears];
  return {
    fur: FUR_COLOURS[l.fur].fur,
    cream: cream.cream,
    innerEar: cream.innerEar,
    eyeShape: EYE_SHAPES[l.eyes].id,
    eye: eyes.eye,
    eyeSheen: eyes.sheen,
    earScale: ears.scale,
    earHeight: ears.height,
    earLean: ears.lean,
    size: SIZES[l.size].scale,
  };
}

// ── Saved on this computer ─────────────────────────────────────────────────

const LOOK_STORAGE_KEY = 'ssf-fox-look';

/** The look this page last saved, kept here too: a browser that keeps
 *  nothing (privacy mode, a full or denied store) still has this page's
 *  choice to draw and to write into the players entry. */
let lookThisPage: FoxLook | null = null;

/** The look this page saved, else the one saved on this computer, or null
 *  when none was ever chosen. */
export function loadSavedLook(): FoxLook | null {
  if (lookThisPage) return { ...lookThisPage };
  try {
    const raw = localStorage.getItem(LOOK_STORAGE_KEY);
    return raw ? cleanLook(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveLook(look: FoxLook): void {
  lookThisPage = cleanLook(look);
  try {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify(lookThisPage));
  } catch {
    /* privacy mode: the look holds for this page only */
  }
}
