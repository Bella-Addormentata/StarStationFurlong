/**
 * 🏗️ Room templates — RollerCoaster-Tycoon-style one-click room presets.
 *
 * Each template is a FULL room design: a furniture layout plus the visual
 * theme it was authored for. Placing one REPLACES the current room's furniture
 * and stamps its theme; the room's DOORS are left exactly as they are, because
 * doors belong to the station's shape, not to the furniture in a room. Build
 * piece-by-piece with the dev menu's furniture spawner instead when you want to
 * compose your own room.
 *
 * Templates are how a module BECOMES something. There are no room types in the
 * mechanics (owner ruling 2026-08-13) — a room is a casino because it holds
 * casino furniture, a pool because it holds a pool, and it can hold both. This
 * registry is the one-click way to get that furniture in, and applying one
 * STAMPS the room's theme so the choice persists like any other room setting.
 * The lobby / casino / pool built-ins reuse the EXACT manifests the two
 * originally-authored rooms shipped, so provisioning one reproduces them.
 *
 * Not yet: R2 room-size presets.
 */

import type { FurnitureItem, RoomTheme } from "./furniture";
import { FURNITURE, OUTDOOR_FURNITURE, CASINO_FURNITURE } from "./furniture";
import { replaceAllFurniture, readAllFurniture } from "./furnitureDoc";

/** 🌌 Injected by main.ts (same idiom as the exterior-view hooks): writes the
 *  room's theme into its own roomInfo doc, so "this module is a casino now"
 *  survives a reload and reaches every peer. Absent until init. */
let roomThemeWriter: ((theme: RoomTheme) => void) | null = null;
export function setRoomThemeWriter(cb: (theme: RoomTheme) => void): void {
  roomThemeWriter = cb;
}

/** The room "type"; each can have multiple design variants (casino-1, -2, …).
 *  "blank" is the empty starting point (folds in empty-by-default); "deck" is
 *  an open-air sky terrace (outdoor-deck theme without a pool). */
export type TemplateCategory =
  | "blank"
  | "lobby"
  | "casino"
  | "pool"
  | "deck";

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
  /** 🌌 Visual theme stamped into the room's roomInfo on provision — an
   *  'outdoor-deck' opens the room to the real space backdrop + warm bright
   *  light. Absent handling defaults to 'interior' at the call site. */
  theme: RoomTheme;
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
    id: "empty",
    category: "blank",
    name: "Empty Room",
    description:
      "A blank slate — just the wall-computer to edit from. Build it yourself, piece by piece.",
    // Doors are structural (always present); the wall-computer is the in-world
    // edit-mode entry, so an empty room stays furnishable.
    items: [
      // NOT the id "wall-computer": main.ts purges that reserved default id
      // from every already-seeded doc on load (the retired lobby terminal), and
      // this template's terminal is the room's ONLY item — losing it leaves no
      // in-world way back into EDIT ROOM. Latent before, reachable now that the
      // panel is movable and therefore written to the doc under its own id.
      // The deck-1 template already avoids the collision the same way.
      { id: "empty-computer", kind: "wall-computer", pos: { x: 1.8, z: 5.97 }, rot: 2, movable: true },
    ],

    theme: "interior",
  },
  {
    id: "lobby-1",
    category: "lobby",
    name: "Grand Lobby",
    description:
      "Clone-vat lounge — centre sofa cluster, map table, bunk, storage, paired doors.",
    items: FURNITURE,

    theme: "interior",
  },
  {
    id: "casino-1",
    category: "casino",
    name: "Luxury Casino",
    description:
      "Roulette + game tables, two cashiers, lounge seating, gold trim, paired doors.",
    items: CASINO_FURNITURE,

    theme: "casino",
  },
  {
    id: "pool-1",
    category: "pool",
    name: "Infinity Pool Deck",
    description:
      "Infinity pool, bridge to the hot tub, dive tower between the twin doors, beach cafés — under open space with skylights.",
    // OUTDOOR_FURNITURE already carries the pool + its ceiling skylights.
    items: OUTDOOR_FURNITURE,

    theme: "outdoor-deck",
  },
  {
    id: "pool-2",
    category: "pool",
    name: "Classic Lido Pool",
    description:
      "PR #70's original — corner dive tower, corner hot tub, terrace bench, sun loungers, parasol cafés, glass-ceiling skylights.",
    items: [
      // 🪟☀️ Ceiling glass + a sun-lamp so the deck reads sunlit under real space
      // even when dropped into a windowless module.
      { id: "pool-skylight-n", kind: "skylight", pos: { x: 0, z: -3 }, rot: 0, movable: true },
      { id: "pool-skylight-s", kind: "skylight", pos: { x: 0, z: 3 }, rot: 0, movable: true },
      { id: "pool-sun-lamp", kind: "sun-lamp", pos: { x: 0, z: 0 }, rot: 0, movable: true },
      // 🕳️ #80: same water footprint as the lazy pool, so the same obstacle
      // override — it must CONTAIN the rectangular floor hole (poolHoleCells) so
      // a walker can never stand on a cut cell ("swim, not walk").
      {
        id: "pool-main",
        kind: "classic-pool",
        pos: { x: 0, z: 0 },
        rot: 0,
        movable: false,
        footprintOverride: { x0: -5.4, z0: -3, x1: 3.5, z1: 3 },
      },
      { id: "pool-hot-tub", kind: "classic-hot-tub", pos: { x: -3.7, z: -3.7 }, rot: 0, movable: false },
      { id: "otree-sw", kind: "cherry-tree", pos: { x: -4.5, z: 4.5 }, rot: 0, movable: true },
      { id: "otree-se", kind: "cherry-tree", pos: { x: 4.5, z: 4.5 }, rot: 0, movable: true },
      { id: "opot-1", kind: "blossom-pot", pos: { x: 2.55, z: 4.75 }, rot: 0, movable: true },
      { id: "opot-2", kind: "blossom-pot", pos: { x: 4.6, z: 2.6 }, rot: 0, movable: true },
    ],

    theme: "outdoor-deck",
  },
  {
    id: "deck-1",
    category: "deck",
    name: "Sky Deck",
    description:
      "An open-air sky terrace — glass-ceiling skylights over the orbiting ocean-planet, sun-lamp, cherry trees and planters. Bright, airy, no pool.",
    items: [
      { id: "deck-skylight-n", kind: "skylight", pos: { x: 0, z: -2.6 }, rot: 0, movable: true },
      { id: "deck-skylight-s", kind: "skylight", pos: { x: 0, z: 2.6 }, rot: 0, movable: true },
      { id: "deck-sun-lamp", kind: "sun-lamp", pos: { x: 0, z: 0 }, rot: 0, movable: true },
      { id: "deck-computer", kind: "wall-computer", pos: { x: 1.8, z: 5.97 }, rot: 2, movable: true },
      { id: "deck-tree-sw", kind: "cherry-tree", pos: { x: -4.5, z: 4.5 }, rot: 0, movable: true },
      { id: "deck-tree-se", kind: "cherry-tree", pos: { x: 4.5, z: 4.5 }, rot: 0, movable: true },
      { id: "deck-tree-nw", kind: "cherry-tree", pos: { x: -4.5, z: -4.5 }, rot: 0, movable: true },
      { id: "deck-pot-1", kind: "blossom-pot", pos: { x: 3, z: -2 }, rot: 0, movable: true },
      { id: "deck-pot-2", kind: "blossom-pot", pos: { x: -3, z: 2 }, rot: 0, movable: true },
    ],

    theme: "outdoor-deck",
  },
  // Planned variants (author via EXPORT, then paste here):
  //   casino-2 "Neon Slots Hall", casino-3 "High-Roller Salon",
  //   pool-3 "Lap Lanes", lobby-2 "Minimal Atrium".
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
 * the template's layout and stamp its theme into the room's roomInfo doc. The
 * room's DOORS are deliberately left untouched — a template furnishes a room,
 * it does not re-cut the station's connections (no room types; doors belong to
 * the station's shape, not to the furniture in a room). Returns the applied
 * template (or null for an unknown id). The caller re-derives door anchors and
 * wall coverage afterwards (world.reconcileDoorPlacements) so the geometry
 * matches the (unchanged) door set against the new layout.
 */
export function applyRoomTemplate(id: string): RoomTemplate | null {
  const t = findTemplate(id);
  if (!t) return null;
  replaceAllFurniture(cloneItems(t.items));
  // 🌌 …and the room IS this now: stamping the theme makes the change
  // persistent and shared, instead of a look that lasted until the next
  // reload re-resolved it from nothing.
  roomThemeWriter?.(t.theme);
  return t;
}

/**
 * Seed a freshly-minted room with a template's FURNITURE. Only the furniture
 * is placed — the room's doors are left untouched (a template furnishes a
 * room, it does not re-cut the station's connections: no room types). Used by
 * the door-panel provisioning flow. Returns false for an unknown id.
 */
export function seedRoomTemplate(id: string): boolean {
  const t = findTemplate(id);
  if (!t) return false;
  replaceAllFurniture(cloneItems(t.items));
  return true;
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
