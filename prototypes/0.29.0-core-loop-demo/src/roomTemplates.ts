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
 * R2 room-size presets: a template MAY carry `dims`. Most do not — they were
 * authored for the default 2×2 envelope and resizing under a layout that fits
 * would be rude. A template whose furniture genuinely cannot fit (the beach
 * party: a river, a bar under a 7×4 pergola, a dance floor AND an empty middle)
 * declares the envelope it was drawn for, and applying it writes that too.
 */

import type { FurnitureItem, RoomTheme } from "./furniture";
import { FURNITURE, OUTDOOR_FURNITURE, CASINO_FURNITURE } from "./furniture";
import { replaceAllFurniture, readAllFurniture } from "./furnitureDoc";
import { writeRoomDims, type RoomDims } from "./floorPlanDoc";

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
  | "deck"
  | "party";

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
  /** 📐 R2: the room envelope this layout was drawn for, in 6 m tiles. Present
   *  ONLY where the furniture will not fit the 2×2 default — applying such a
   *  template resizes the room, because half a beach is not the design. */
  dims?: RoomDims;
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
    id: "party-1",
    category: "party",
    name: "Birthday Party",
    description:
      "Cake table and gifts along the back wall under the bunting, a lit dance floor with its speaker, the bar in the corner — and an empty middle for the crowd.",
    // ── LAYOUT NOTES (the element-checklist zoning rules, applied to a square
    //    12×12 m module rather than a beach):
    //
    //  · THE MIDDLE IS EMPTY ON PURPOSE. x ∈ [-2.5, 2.5], z ∈ [-2, 3] carries
    //    nothing. In a multiplayer room the crowd needs somewhere to be, and
    //    that is the zone every decoration was pushed out of.
    //  · THE PARTY CLUSTER IS AT THE BACK (north, z ≈ -4). Cake, gifts, banner
    //    and balloons together, all rot 0 so their approach side (local +z)
    //    faces the middle — guests turn toward the cake from the open floor
    //    instead of standing inside the cluster.
    //  · THE TALLEST THINGS FRAME THE SCENE. Banner (2.35 m) and the cherry
    //    trees sit on the back wall where they never occlude the cake.
    //  · TWO MORE PLACES TO BE. The dance floor east of centre and the bar in
    //    the far corner, so the room has three social zones, not one.
    //  · CORRIDORS. ≥ 2 m clear between the cluster (z ≤ -3.7) and the dance
    //    floor (z ≥ -1.8), and the banner is footprint-null so people walk
    //    under it rather than round it.
    //
    // Shipped DELIBERATELY SPARSE: more balloons, hats and tables are what
    // guests add in edit mode, and a room that arrives finished leaves them
    // nothing to do.
    items: [
      // Edit-mode entry. NOT the reserved id "wall-computer" (see "empty").
      { id: "party-computer", kind: "wall-computer", pos: { x: 1.8, z: 5.97 }, rot: 2, movable: true },

      // 🎂 The anchor, and the cluster around it.
      { id: "party-cake", kind: "cake-table", pos: { x: -1.0, z: -4.2 }, rot: 0, movable: true },
      { id: "party-banner", kind: "birthday-banner", pos: { x: -1.0, z: -5.3 }, rot: 0, movable: true },
      { id: "party-gift-1", kind: "gift-box", pos: { x: -2.7, z: -4.0 }, rot: 0, movable: true },
      { id: "party-gift-2", kind: "gift-box", pos: { x: -3.5, z: -4.7 }, rot: 0, movable: true },
      { id: "party-gift-3", kind: "gift-box", pos: { x: 0.7, z: -4.3 }, rot: 0, movable: true },
      { id: "party-balloons-w", kind: "birthday-balloons", pos: { x: -4.6, z: -4.2 }, rot: 0, movable: true },
      { id: "party-balloons-e", kind: "birthday-balloons", pos: { x: 2.2, z: -4.4 }, rot: 0, movable: true },

      // 💃 The floor and its switch. The speaker sits on the floor's north
      // edge so the walk to it is across the dance floor itself.
      { id: "party-floor", kind: "dance-floor", pos: { x: 2.6, z: 0.2 }, rot: 0, movable: true },
      { id: "party-speaker", kind: "party-speaker", pos: { x: 2.6, z: -2.2 }, rot: 0, movable: true },

      // 🍸 Somewhere to put a drink down, out at the edges.
      { id: "party-stand-1", kind: "party-standing-table", pos: { x: -4.4, z: 1.4 }, rot: 0, movable: true },
      { id: "party-stand-2", kind: "party-standing-table", pos: { x: -3.1, z: 3.6 }, rot: 0, movable: true },

      // 🍹 The second social zone — the lobby bar, in its usual corner.
      { id: "party-bar", kind: "bar-corner", pos: { x: 5.24, z: 3.1 }, rot: 0, movable: true },

      // 🌸 Back-wall greenery: tall, and therefore at the back.
      { id: "party-tree-nw", kind: "cherry-tree", pos: { x: -5.2, z: -5.2 }, rot: 0, movable: true },
      { id: "party-tree-ne", kind: "cherry-tree", pos: { x: 4.8, z: -5.2 }, rot: 0, movable: true },
      { id: "party-pot-s", kind: "blossom-pot", pos: { x: -5.3, z: 4.6 }, rot: 0, movable: true },

      // ✨ Light for the middle, so the empty floor still reads as a room.
      { id: "party-chandelier", kind: "chandelier", pos: { x: 0, z: 0.5 }, rot: 0, movable: true },
    ],

    theme: "interior",
  },
  {
    id: "party-2",
    category: "party",
    name: "Beach Birthday Party",
    description:
      "The lazy river down the front with palms along its banks, a tiki bar under a lantern-strung pergola in the far corner, cake and gifts along the back, a lit dance floor — and an empty middle.",
    // 📐 4×4 (24×24 m). The 2×2 default cannot hold this: the river alone is
    // ~10 m across and the pergola is 6.6×3.6, so at the default size the
    // "empty middle" — the one zone that matters most in a multiplayer room —
    // would be the only thing that did not fit.
    dims: { cols: 4, rows: 4 },
    //
    // ── ZONES (element-checklist), mapped onto this engine's axes ──────────
    //  +z is the camera side, so that is the FRONT and where the water goes;
    //  -z is the back, where the tall things live. Four zones, tellable apart
    //  at a glance:
    //
    //   z -12 ┌──────────────────────────────────────────────┐
    //         │  BAR + PERGOLA        CAKE · GIFTS · BANNER   │  ← back
    //         │  (far corner, lit)    (facing the middle)     │
    //    z -4 │                                    DANCE ▓▓   │
    //         │            ·  E M P T Y  ·                    │  ← the crowd
    //    z  3 │                                               │
    //         │   ~~~~~~  THE LAZY RIVER + BANKS  ~~~~~~      │  ← front
    //    z 12 └──────────────────────────────────────────────┘
    //
    //  · THE MIDDLE IS EMPTY: x ∈ [-4, 5], z ∈ [-2.5, 2.5] carries nothing.
    //    Every decoration was pushed outward; if something drifts back in,
    //    the room was built centre-out and should be re-laid edges-in.
    //  · THE BAR IS IN THE FAR CORNER and lit from its own pergola, so the
    //    tallest cluster frames the scene instead of covering it. Back bar
    //    against the back edge, then the counter, then stools on the camera
    //    side — never mirrored, or the shelf ends up in front of the counter.
    //  · PALMS AND SURFBOARDS string along the banks in odd groups with gaps,
    //    never in a line, and never between the camera and the cake.
    //  · CORRIDORS ≥ 2 m everywhere; the banner and the pergola roof are both
    //    footprint-null, so people walk under them rather than around.
    items: [
      // Edit-mode entry, on the back wall in the gap between the two clusters.
      { id: "beach-computer", kind: "wall-computer", pos: { x: -2.8, z: -11.9 }, rot: 0, movable: true },

      // 🌊 THE RIVER. The station's lazy pool IS a winding bezier channel
      // around a central island, sunk to -0.35 with basin walls to -0.95 and
      // two infinity edges — so it plays the reference's river, and unlike the
      // reference you can actually swim in it.
      { id: "beach-river", kind: "lazy-pool", pos: { x: 0, z: 6.4 }, rot: 0, movable: false },

      // 🍹 THE BAR — far corner, raised read via the pergola rather than a deck.
      { id: "beach-backbar", kind: "tiki-back-bar", pos: { x: -7.0, z: -9.8 }, rot: 0, movable: true },
      { id: "beach-counter", kind: "tiki-bar-counter", pos: { x: -7.0, z: -8.0 }, rot: 0, movable: true },
      { id: "beach-stool-1", kind: "tiki-bar-stool", pos: { x: -8.6, z: -6.9 }, rot: 0, movable: true },
      { id: "beach-stool-2", kind: "tiki-bar-stool", pos: { x: -7.0, z: -6.9 }, rot: 0, movable: true },
      { id: "beach-stool-3", kind: "tiki-bar-stool", pos: { x: -5.4, z: -6.9 }, rot: 0, movable: true },
      { id: "beach-post-nw", kind: "pergola-post", pos: { x: -10.4, z: -10.6 }, rot: 0, movable: true },
      { id: "beach-post-ne", kind: "pergola-post", pos: { x: -3.6, z: -10.6 }, rot: 0, movable: true },
      { id: "beach-post-sw", kind: "pergola-post", pos: { x: -10.4, z: -6.2 }, rot: 0, movable: true },
      { id: "beach-post-se", kind: "pergola-post", pos: { x: -3.6, z: -6.2 }, rot: 0, movable: true },
      { id: "beach-pergola", kind: "pergola-roof", pos: { x: -7.0, z: -8.4 }, rot: 0, movable: true },
      // Leave the lane onto the bartender row clear — cooler and crate go in
      // the corner BEHIND the shelf, not across the approach.
      { id: "beach-cooler", kind: "cooler", pos: { x: -9.8, z: -9.9 }, rot: 0, movable: true },
      { id: "beach-crate-1", kind: "beach-crate", pos: { x: -10.5, z: -9.0 }, rot: 0, movable: true },
      // Torches on the sand just off the bar, not under the roof.
      { id: "beach-torch-1", kind: "tiki-torch", pos: { x: -2.6, z: -10.2 }, rot: 0, movable: true },
      { id: "beach-torch-2", kind: "tiki-torch", pos: { x: -2.6, z: -5.6 }, rot: 0, movable: true },

      // 🎂 THE PARTY CLUSTER — beside the bar, along the back, facing the middle.
      { id: "beach-cake", kind: "cake-table", pos: { x: 1.8, z: -8.8 }, rot: 0, movable: true },
      { id: "beach-banner", kind: "birthday-banner", pos: { x: 1.8, z: -10.3 }, rot: 0, movable: true },
      { id: "beach-gift-1", kind: "gift-box", pos: { x: 0.1, z: -8.6 }, rot: 0, movable: true },
      { id: "beach-gift-2", kind: "gift-box", pos: { x: -0.7, z: -9.4 }, rot: 0, movable: true },
      { id: "beach-gift-3", kind: "gift-box", pos: { x: 3.5, z: -9.0 }, rot: 0, movable: true },
      { id: "beach-balloons-1", kind: "birthday-balloons", pos: { x: 5.0, z: -9.4 }, rot: 0, movable: true },
      { id: "beach-balloons-2", kind: "birthday-balloons", pos: { x: -1.7, z: -10.0 }, rot: 0, movable: true },

      // 💃 THE DANCE FLOOR — east side, speaker on its back edge.
      { id: "beach-floor", kind: "dance-floor", pos: { x: 7.8, z: -3.2 }, rot: 0, movable: true },
      { id: "beach-speaker", kind: "party-speaker", pos: { x: 7.8, z: -5.8 }, rot: 0, movable: true },

      // 🍸 Two more places to stand, at the edges of the empty middle.
      { id: "beach-stand-1", kind: "party-standing-table", pos: { x: -3.4, z: -3.0 }, rot: 0, movable: true },
      { id: "beach-stand-2", kind: "party-standing-table", pos: { x: 4.6, z: -5.4 }, rot: 0, movable: true },

      // 🌴 THE BANKS — palms and boards in odd groups with gaps between, the
      // tall ones toward the back where they frame rather than occlude.
      { id: "beach-palm-1", kind: "palm-tree", pos: { x: -10.2, z: 2.6 }, rot: 0, movable: true },
      { id: "beach-palm-2", kind: "palm-tree", pos: { x: -8.6, z: 4.8 }, rot: 0, movable: true },
      { id: "beach-palm-3", kind: "palm-tree", pos: { x: 9.8, z: 3.4 }, rot: 0, movable: true },
      { id: "beach-palm-4", kind: "palm-tree", pos: { x: -9.4, z: -3.8 }, rot: 0, movable: true },
      { id: "beach-palm-5", kind: "palm-tree", pos: { x: 10.4, z: -7.6 }, rot: 0, movable: true },
      { id: "beach-board-1", kind: "surfboard", pos: { x: -11.0, z: 0.4 }, rot: 0, movable: true },
      { id: "beach-board-2", kind: "surfboard", pos: { x: 10.8, z: 6.2 }, rot: 0, movable: true },

      // ⛱️ Loungers and parasols in two small groups, clear of the water.
      { id: "beach-parasol-1", kind: "parasol", pos: { x: -8.0, z: 8.2 }, rot: 0, movable: true },
      { id: "beach-lounger-1", kind: "sun-lounger", pos: { x: -9.4, z: 8.4 }, rot: 0, movable: true },
      { id: "beach-lounger-2", kind: "sun-lounger", pos: { x: -6.8, z: 8.6 }, rot: 0, movable: true },
      { id: "beach-parasol-2", kind: "parasol", pos: { x: 8.6, z: 8.4 }, rot: 0, movable: true },
      { id: "beach-lounger-3", kind: "sun-lounger", pos: { x: 9.8, z: 8.6 }, rot: 0, movable: true },
      { id: "beach-towel-1", kind: "beach-towel", pos: { x: 7.0, z: 9.4 }, rot: 0, movable: true },
      { id: "beach-towel-2", kind: "beach-towel", pos: { x: -10.6, z: 6.0 }, rot: 0, movable: true },

      // 🏐 Two balls, because a beach with nothing loose on it looks staged.
      { id: "beach-ball-1", kind: "beach-ball", pos: { x: -4.2, z: 4.4 }, rot: 0, movable: true },
      { id: "beach-ball-2", kind: "beach-ball", pos: { x: 6.2, z: 1.6 }, rot: 0, movable: true },
      { id: "beach-crate-2", kind: "beach-crate", pos: { x: 11.0, z: 0.8 }, rot: 0, movable: true },
    ],

    // Open to the real space backdrop, like the pool decks — a beach under a
    // ceiling is a swimming hall.
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
  // 📐 Size FIRST: placement validity and the walk bounds are derived from the
  // envelope, so growing the room before the furniture lands means nothing is
  // ever briefly out of bounds.
  if (t.dims) writeRoomDims(t.dims.cols, t.dims.rows);
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
  if (t.dims) writeRoomDims(t.dims.cols, t.dims.rows);
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
