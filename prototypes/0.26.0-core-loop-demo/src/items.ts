/**
 * Items — item model v1 + trunk slot state (TR2 of issue #35,
 * brainstorming/device-focus-and-storage-trunk-plan.md §3).
 *
 * No item model existed before this file. v1 is deliberately tiny:
 *  - ItemDef        : static catalogue entry (tools + outfit items). Outfit
 *                     items reference an OutfitDef by ID (outfits.ts OUTFITS)
 *                     — the trunk UI's EQUIP button routes that id into the
 *                     TR3 rig path (setOutfit + 'ssf-outfit' persistence).
 *  - TrunkState     : the slot layout of ONE trunk — 8 tool slots followed by
 *                     4 outfit slots, each holding an item id or null.
 *  - localStorage   : `ssf-trunk:<roomId>:<itemId>`, seeded with starter
 *                     contents on first open. LOCAL ONLY (plan honesty rule:
 *                     the trunk UI is labelled 'LOCAL STOWAGE — not yet
 *                     synced'); the Yjs `trunks` map arrives with TR-sync.
 *
 * Deferred by the plan (do NOT add here): cross-trunk transfer, world drops,
 * item stacking, per-slot CRDTs.
 */

export type ItemKind = 'tool' | 'outfit';

export interface ItemDef {
  id: string;
  name: string;
  /** Tile glyph — emoji is fine for v1. */
  icon: string;
  kind: ItemKind;
  /** For kind 'outfit': the OutfitDef id in outfits.ts OUTFITS. */
  outfit?: string;
  /** One-line inspect-card flavor text. */
  flavor: string;
}

/** Static catalogue — every item the v1 trunk can hold. */
export const ITEM_DEFS: ItemDef[] = [
  // ── Tools ────────────────────────────────────────────────────────────────
  {
    id: 'wrench',
    name: 'Hex Wrench',
    icon: '🔧',
    kind: 'tool',
    flavor: 'Station-issue spanner. Fits every bolt except the one you need.',
  },
  {
    id: 'scanner',
    name: 'Hull Scanner',
    icon: '📡',
    kind: 'tool',
    flavor: 'Reads micro-fractures through 40cm of plating. Battery at 62%.',
  },
  {
    id: 'multitool',
    name: 'Multitool',
    icon: '🛠️',
    kind: 'tool',
    flavor: 'Eleven functions. Nine of them are "pry".',
  },
  // ── Outfits (each maps to an outfits.ts OUTFITS id, incl. its accessory) ──
  {
    id: 'outfit-default',
    name: 'Station Standard',
    icon: '🦊',
    kind: 'outfit',
    outfit: 'default',
    flavor: 'The pristine fox. No overrides, no accessory, no nonsense.',
  },
  {
    id: 'outfit-midnight',
    name: 'Midnight Courier',
    icon: '🧢',
    kind: 'outfit',
    outfit: 'midnight',
    flavor: 'Silver-blue arctic courier kit with a snap-brim cap.',
  },
  {
    id: 'outfit-ember',
    name: 'Ember Flightcrew',
    icon: '🧣',
    kind: 'outfit',
    outfit: 'ember',
    flavor: 'Deep-red flight-deck fur and a knitted scarf. Smells of ozone.',
  },
  {
    id: 'outfit-snowdrift',
    name: 'Snowdrift Scout',
    icon: '🥽',
    kind: 'outfit',
    outfit: 'snowdrift',
    flavor: 'Arctic-white scout coat with a tinted recon visor.',
  },
];

export function getItemDef(id: string): ItemDef | undefined {
  return ITEM_DEFS.find((d) => d.id === id);
}

// ── Trunk slot state ─────────────────────────────────────────────────────────

/** Tool-tray capacity (slot indices 0 .. TOOL_SLOT_COUNT-1). */
export const TOOL_SLOT_COUNT = 8;
/** Wardrobe capacity (slot indices TOOL_SLOT_COUNT .. TOTAL_SLOT_COUNT-1). */
export const OUTFIT_SLOT_COUNT = 4;
export const TOTAL_SLOT_COUNT = TOOL_SLOT_COUNT + OUTFIT_SLOT_COUNT;

/** Slot layout of one trunk: 8 tool slots then 4 outfit slots (plan §TR2). */
export interface TrunkState {
  slots: (string | null)[];
}

/** Starter contents seeded on first open: the tools + every outfit item. */
function seedTrunkState(): TrunkState {
  const slots: (string | null)[] = new Array(TOTAL_SLOT_COUNT).fill(null);
  slots[0] = 'wrench';
  slots[1] = 'scanner';
  slots[2] = 'multitool';
  slots[TOOL_SLOT_COUNT + 0] = 'outfit-default';
  slots[TOOL_SLOT_COUNT + 1] = 'outfit-midnight';
  slots[TOOL_SLOT_COUNT + 2] = 'outfit-ember';
  slots[TOOL_SLOT_COUNT + 3] = 'outfit-snowdrift';
  return { slots };
}

/** One key per (room, trunk item) — plan §TR2. */
export function trunkStorageKey(roomId: string, itemId: string): string {
  return `ssf-trunk:${roomId}:${itemId}`;
}

/**
 * Load a trunk's slot state, seeding (and persisting) starter contents when
 * the key is absent or unparseable. Unknown item ids are dropped to null so a
 * catalogue rename can never wedge the UI. try/catch throughout: localStorage
 * throws in some privacy modes and stowage must never take the app down.
 */
export function loadTrunkState(roomId: string, itemId: string): TrunkState {
  try {
    const raw = localStorage.getItem(trunkStorageKey(roomId, itemId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TrunkState>;
      if (Array.isArray(parsed.slots)) {
        const slots: (string | null)[] = new Array(TOTAL_SLOT_COUNT).fill(null);
        for (let i = 0; i < TOTAL_SLOT_COUNT; i++) {
          const v = parsed.slots[i];
          slots[i] = typeof v === 'string' && getItemDef(v) ? v : null;
        }
        return { slots };
      }
    }
  } catch {
    /* fall through to reseed */
  }
  const seeded = seedTrunkState();
  saveTrunkState(roomId, itemId, seeded);
  return seeded;
}

export function saveTrunkState(roomId: string, itemId: string, state: TrunkState): void {
  try {
    localStorage.setItem(trunkStorageKey(roomId, itemId), JSON.stringify(state));
  } catch {
    /* local stowage is best-effort */
  }
}
