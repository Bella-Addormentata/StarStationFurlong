/**
 * 🏗️ Room templates — RollerCoaster-Tycoon-style one-click room presets.
 *
 * Each template is a FULL room design: a furniture layout plus the door
 * arrangement it was authored for. Placing one REPLACES the current room's
 * furniture and switches the door layout to match (so the camera-near edges
 * line up with the design). Build piece-by-piece with the dev menu's furniture
 * spawner instead when you want to compose your own room.
 *
 * The three built-ins reuse the EXACT manifests the authored rooms already ship
 * (lobby / casino / pool), so a template is guaranteed to match its room.
 *
 * Dev tool for now (wired into the DEV menu). Not yet: persisting a placed
 * layout's door arrangement across reload, the lighting/waiter theme swap
 * (still roomId-keyed in world.applyRoomVisuals), and R2 room-size presets.
 */

import type { FurnitureItem } from "./furniture";
import { FURNITURE, OUTDOOR_FURNITURE, CASINO_FURNITURE } from "./furniture";
import { replaceAllFurniture, readAllFurniture } from "./furnitureDoc";
import { setActiveDoorLayout, type DoorLayoutKind } from "./doorLayout";

/** The room "type"; each can have multiple design variants (casino-1, -2, …). */
export type TemplateCategory = "lobby" | "casino" | "pool";

export interface RoomTemplate {
  /** Unique variant id, `${category}-${n}` (e.g. "casino-1", "pool-2"). */
  id: string;
  /** Which room type this is a variant of — groups variants in the picker. */
  category: TemplateCategory;
  /** Human name of THIS variant (e.g. "Luxury Casino", "Hot-Tub Island Pool"). */
  name: string;
  /** One-line description shown on the picker. */
  description: string;
  /** The furniture layout to place (cloned on apply — the source is never mutated). */
  items: FurnitureItem[];
  /** The door arrangement the layout was designed for. */
  doorLayout: DoorLayoutKind;
}

/** Clone so applying a template never aliases the shared manifest arrays. */
function cloneItems(items: FurnitureItem[]): FurnitureItem[] {
  return items.map((i) => ({
    ...i,
    pos: { ...i.pos },
    ...(i.footprintOverride ? { footprintOverride: { ...i.footprintOverride } } : {}),
  }));
}

// One entry per DESIGN VARIANT. Author new variants by arranging a room in-game,
// pressing EXPORT (see exportCurrentRoomAsTemplate), and pasting the printed
// manifest here as e.g. `casino-2` / `pool-2` (hot tub in the pool's centre).
export const ROOM_TEMPLATES: RoomTemplate[] = [
  {
    id: "lobby-1",
    category: "lobby",
    name: "Grand Lobby",
    description:
      "Clone-vat lounge — centre sofa cluster, map table, bunk, storage, paired doors.",
    items: FURNITURE,
    doorLayout: "casino-pairs",
  },
  {
    id: "casino-1",
    category: "casino",
    name: "Luxury Casino",
    description:
      "Roulette + game tables, two cashiers, lounge seating, gold trim, paired doors.",
    items: CASINO_FURNITURE,
    doorLayout: "casino-pairs",
  },
  {
    id: "pool-1",
    category: "pool",
    name: "Infinity Pool Deck",
    description:
      "Infinity pool, bridge to the hot tub, dive tower between the north doors, beach cafés.",
    items: OUTDOOR_FURNITURE,
    doorLayout: "pool-pairs",
  },
  // Planned variants (author via EXPORT, then paste here):
  //   casino-2 "Neon Slots Hall", casino-3 "High-Roller Salon",
  //   pool-2   "Hot-Tub Island" (tub centred in the water), pool-3 "Lap Lanes",
  //   lobby-2  "Minimal Atrium".
];

/** Distinct room types present, in registry order (for a grouped picker). */
export function templateCategories(): TemplateCategory[] {
  const seen: TemplateCategory[] = [];
  for (const t of ROOM_TEMPLATES) if (!seen.includes(t.category)) seen.push(t.category);
  return seen;
}

/** All variants of one room type (casino-1, casino-2, …). */
export function templatesByCategory(category: TemplateCategory): RoomTemplate[] {
  return ROOM_TEMPLATES.filter((t) => t.category === category);
}

export function findTemplate(id: string): RoomTemplate | null {
  return ROOM_TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * Place a template into the CURRENT room: atomically replace all furniture with
 * the template's layout and switch to its door arrangement. Returns the applied
 * template (or null for an unknown id). The caller refreshes the door geometry
 * afterwards (world.reconcileDoorPlacements) so the doors move to the new slots.
 */
export function applyRoomTemplate(id: string): RoomTemplate | null {
  const t = findTemplate(id);
  if (!t) return null;
  replaceAllFurniture(cloneItems(t.items));
  setActiveDoorLayout(t.doorLayout);
  return t;
}

/**
 * Capture the CURRENT room's furniture as a copy-pasteable manifest and log it
 * to the console — the seed of "save your own room as a template". A dev can
 * arrange a room by hand, run this, and promote the printed array to a new
 * built-in template in code. Returns the captured item count.
 */
export function exportCurrentRoomAsTemplate(name = "custom"): number {
  const items: FurnitureItem[] = [];
  for (const [id, rec] of readAllFurniture()) {
    const item: FurnitureItem = {
      id,
      kind: rec.kind,
      pos: { x: rec.x, z: rec.z },
      rot: rec.rot,
      movable: rec.movable,
    };
    if (rec.mountParent !== undefined) item.mountParent = rec.mountParent;
    items.push(item);
  }
  console.log(
    `🏗️ Room template "${name}" — ${items.length} pieces. Paste into roomTemplates.ts:\n` +
      JSON.stringify(items, null, 2),
  );
  return items.length;
}
