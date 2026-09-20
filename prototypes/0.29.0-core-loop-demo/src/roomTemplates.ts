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

import type { Box, FurnitureItem, FurnitureKind, RoomTheme, Rot } from "./furniture";
import {
  FURNITURE, OUTDOOR_FURNITURE, CASINO_FURNITURE, buildObstacleList,
} from "./furniture";
import { replaceAllFurniture, readAllFurniture, addFurniture } from "./furnitureDoc";
import { writeRoomDims, roomHalfExtents, type RoomDims } from "./floorPlanDoc";

/** 🌌 Injected by main.ts (same idiom as the exterior-view hooks): writes the
 *  room's theme into its own roomInfo doc, so "this module is a casino now"
 *  survives a reload and reaches every peer. Absent until init. */
let roomThemeWriter: ((theme: RoomTheme) => void) | null = null;
export function setRoomThemeWriter(cb: (theme: RoomTheme) => void): void {
  roomThemeWriter = cb;
}

/**
 * 📐 Write a template's envelope into the room doc.
 *
 * ⚠️ THE SHELL DOES NOT REBUILD IN PLACE. The floor, the walls, the walkable
 * bounds and the octagon hull are all built ONCE by World.createPlatform from
 * roomHalfExtents(), and nothing in the engine tears a built platform down —
 * createPlatform only ADDS to platformGroup. Calling it again (via startMorph)
 * leaves the old floor and a duplicate of every furniture group behind, which
 * is exactly what it did when this was first wired that way.
 *
 * So: at room BIRTH (seedRoomTemplate) the dims land before the platform is
 * ever built and everything is correct. On an EXISTING room the dims are
 * written and persist, but the player has to leave and re-enter for the shell
 * to come back at the new size — applyRoomTemplate says so in its return value
 * and the dev menu passes that on.
 *
 * Doing better means a real platform teardown, which is its own change.
 */
function writeEnvelope(dims: RoomDims): void {
  writeRoomDims(dims.cols, dims.rows);
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
  /**
   * 🧩 A layout GENERATED for the room it is going into, instead of the fixed
   * `items` list. A room's structure is fixed once it is built — you cannot
   * resize it, you can only put things in it — so a set that is worth adding
   * to somebody's existing room has to fit the room they actually have. The
   * generator is handed the real half-extents and places what fits, in
   * priority order, skipping what does not. See layoutBeachParty.
   */
  layout?: (half: { halfX: number; halfZ: number }) => FurnitureItem[];
}

// ── 🧩 Fitted layouts ────────────────────────────────────────────────────────

/** One thing to try to place, at a position given as a FRACTION of the room's
 *  half-extents so the same recipe works in a 12 m room and a 30 m one. */
interface PlacementSpec {
  kind: FurnitureKind;
  /** Target, in room-fractions: [-1, 1] on each axis. */
  at: [number, number];
  rot?: Rot;
  /** Spans the room on purpose (the river) — skip the bounds check. */
  spanning?: boolean;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
}

function pointInAny(x: number, z: number, boxes: Box[]): boolean {
  return boxes.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);
}

/**
 * Place a list of specs into a room of the given half-extents, in order,
 * keeping only what fits. Later specs lose to earlier ones, so the list IS the
 * priority order: the cake before the parasols, always.
 *
 * Each candidate gets a few tries — its target, then nudged toward the room's
 * centre — because in a small room a target derived from fractions can land a
 * little inside a wall while a metre in would have been fine.
 */
function placeFitting(
  specs: PlacementSpec[],
  halfX: number,
  halfZ: number,
  idPrefix: string,
): FurnitureItem[] {
  const out: FurnitureItem[] = [];
  const occupied: Box[] = [];
  const MARGIN = 0.6; // keep furniture off the walls
  let n = 0;

  for (const spec of specs) {
    const tx = spec.at[0] * halfX;
    const tz = spec.at[1] * halfZ;
    // Nudges pull toward the centre, which is where the room is.
    const tries: Array<[number, number]> = [
      [tx, tz],
      [tx * 0.88, tz * 0.88],
      [tx * 0.76, tz * 0.92],
      [tx * 0.92, tz * 0.76],
      [tx * 0.62, tz * 0.82],
    ];
    for (const [x, z] of tries) {
      const item: FurnitureItem = {
        id: `${idPrefix}-${spec.kind}-${++n}`,
        kind: spec.kind,
        pos: { x: +x.toFixed(2), z: +z.toFixed(2) },
        rot: spec.rot ?? 0,
        movable: !spec.spanning,
      };
      const boxes = buildObstacleList([item]);
      if (boxes.length > 0) {
        const outside =
          !spec.spanning &&
          boxes.some(
            (b) =>
              b.x0 < -halfX + MARGIN || b.x1 > halfX - MARGIN ||
              b.z0 < -halfZ + MARGIN || b.z1 > halfZ - MARGIN,
          );
        if (outside) continue;
        if (boxes.some((b) => occupied.some((o) => boxesOverlap(b, o)))) continue;
        occupied.push(...boxes);
      } else {
        // Decoration with no footprint (banner, balloons, towel, ball, the
        // dance floor, the pergola roof). It cannot COLLIDE, but it must not
        // be standing in the river either, and it still has to be in the room.
        if (Math.abs(x) > halfX - MARGIN || Math.abs(z) > halfZ - MARGIN) continue;
        if (pointInAny(x, z, occupied)) continue;
      }
      out.push(item);
      break;
    }
  }
  return out;
}

/**
 * 🏝️ The beach birthday party, fitted to whatever room it is going into.
 *
 * Zone fractions, not metres: water across the FRONT, the bar in the far
 * corner, the cake cluster beside it along the back facing in, the dance floor
 * off to one side, and the middle left alone because in a multiplayer room the
 * crowd needs somewhere to stand.
 *
 * Priority order is the point. A small room gets the river, the cake and a
 * couple of palms and stops; a big one keeps going all the way to the towels.
 * Nothing is scaled — a bar counter is 4 m wide wherever it is — so the set
 * thins out rather than shrinking.
 */
function layoutBeachParty(half: { halfX: number; halfZ: number }): FurnitureItem[] {
  const { halfX, halfZ } = half;
  const specs: PlacementSpec[] = [
    // 🌊 First, because everything else has to avoid it. It spans the room by
    // design and sizes itself from the room (furniture.ts riverMetrics).
    { kind: "beach-river", at: [0, 0.45], spanning: true },
    { kind: "plank-bridge", at: [0.36, 0.45], spanning: true },

    // 🎂 The anchor and its cluster, along the back.
    { kind: "cake-table", at: [0.14, -0.78] },
    { kind: "birthday-banner", at: [0.14, -0.9] },
    { kind: "gift-box", at: [-0.05, -0.76] },
    { kind: "gift-box", at: [-0.2, -0.84] },
    { kind: "birthday-balloons", at: [0.36, -0.82] },
    { kind: "birthday-balloons", at: [-0.34, -0.86] },

    // 💃 Somewhere to dance, and the switch for it.
    { kind: "dance-floor", at: [0.68, -0.34] },
    { kind: "party-speaker", at: [0.68, -0.6] },

    // 🍹 The bar, far corner: shelf at the back, counter in front of it,
    // stools on the camera side. Never mirrored — see the checklist.
    { kind: "tiki-back-bar", at: [-0.58, -0.86] },
    { kind: "tiki-bar-counter", at: [-0.58, -0.72] },
    { kind: "tiki-bar-stool", at: [-0.72, -0.6] },
    { kind: "tiki-bar-stool", at: [-0.58, -0.6] },
    { kind: "tiki-bar-stool", at: [-0.44, -0.6] },

    // 🌴 The banks. Tall things at the back, in odd groups with gaps.
    { kind: "palm-tree", at: [-0.84, 0.1] },
    { kind: "palm-tree", at: [0.86, 0.06] },
    { kind: "palm-tree", at: [-0.88, -0.44] },
    { kind: "tiki-torch", at: [-0.2, -0.66] },
    { kind: "tiki-torch", at: [-0.9, -0.66] },

    // 🏝️ The far bank — the reason the bridge is worth walking.
    { kind: "palm-tree", at: [-0.5, 0.9] },
    { kind: "palm-tree", at: [0.74, 0.88] },
    { kind: "sun-lounger", at: [-0.28, 0.9] },
    { kind: "parasol", at: [-0.14, 0.88] },
    { kind: "sun-lounger", at: [0.58, 0.9] },

    // Everything past here is expansion — it lands only if there is room.
    { kind: "party-standing-table", at: [-0.34, -0.3] },
    { kind: "party-standing-table", at: [0.42, -0.62] },
    { kind: "cooler", at: [-0.78, -0.86] },
    { kind: "beach-crate", at: [-0.88, -0.78] },
    { kind: "pergola-post", at: [-0.82, -0.92] },
    { kind: "pergola-post", at: [-0.34, -0.92] },
    { kind: "pergola-post", at: [-0.82, -0.52] },
    { kind: "pergola-post", at: [-0.34, -0.52] },
    { kind: "pergola-roof", at: [-0.58, -0.72] },
    { kind: "gift-box", at: [0.3, -0.72] },
    { kind: "surfboard", at: [-0.94, 0.3] },
    { kind: "beach-ball", at: [-0.42, 0.14] },
    { kind: "beach-ball", at: [0.3, 0.9] },
    { kind: "beach-towel", at: [0.1, 0.92] },
    { kind: "beach-towel", at: [-0.72, 0.9] },
  ];
  return placeFitting(specs, halfX, halfZ, "beach");
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
      "A winding river across the front with a plank bridge to the far bank, palms along both banks, a tiki bar under a lantern-strung pergola, cake and gifts along the back, a lit dance floor — and an empty middle.",
    // 📐 5×5 (30×30 m), the largest envelope there is, and this layout needs it:
    // the river spans bank to bank, the pergola is 6.6×3.6, and the middle has
    // to stay empty. At 4×4 the far bank disappears; at 2×2 so does everything.
    dims: { cols: 5, rows: 5 },
    //
    // ── ZONES ──────────────────────────────────────────────────────────────
    //  z -15 ┌────────────────────────────────────────────────┐
    //        │ BAR + PERGOLA      CAKE · GIFTS · BANNER        │ ← back, tallest
    //   z -5 │                                      DANCE ▓▓   │
    //        │              ·  E M P T Y  ·                     │ ← the crowd
    //    z 2 │ ~~~~~~~~~~~~~ THE RIVER ~~~~~╫~~~~~~~~~~~~~~~~~ │ ← front, winding
    //   z 12 │        far bank: loungers, parasol, towel   ╫    │   ╫ = the bridge
    //   z 15 └────────────────────────────────────────────────┘
    //
    //  The river's centre line runs z = 7 + 1.8·sin(0.38x + 0.6), so the water
    //  spans roughly z 2.6 → 11.4 and wanders by ±1.8 along the way. Its banks
    //  are walkable — the obstacle is per-column strips, not one box — and the
    //  bridge at x 5.5 cuts a walkable lane straight through them.
    items: [
      { id: "beach-computer", kind: "wall-computer", pos: { x: -2.8, z: -14.9 }, rot: 0, movable: true },

      // 🌊 THE RIVER, and the way across. The bridge is axis-aligned because
      // the pathfinder forbids corner-cutting — a diagonal bridge is a bridge
      // nobody can walk.
      { id: "beach-river", kind: "beach-river", pos: { x: 0, z: 7.0 }, rot: 0, movable: false },
      { id: "beach-bridge", kind: "plank-bridge", pos: { x: 5.5, z: 7.8 }, rot: 0, movable: false },

      // 🍹 THE BAR — far corner, under its own lanterns.
      { id: "beach-backbar", kind: "tiki-back-bar", pos: { x: -9.0, z: -12.8 }, rot: 0, movable: true },
      { id: "beach-counter", kind: "tiki-bar-counter", pos: { x: -9.0, z: -11.0 }, rot: 0, movable: true },
      { id: "beach-stool-1", kind: "tiki-bar-stool", pos: { x: -10.6, z: -9.9 }, rot: 0, movable: true },
      { id: "beach-stool-2", kind: "tiki-bar-stool", pos: { x: -9.0, z: -9.9 }, rot: 0, movable: true },
      { id: "beach-stool-3", kind: "tiki-bar-stool", pos: { x: -7.4, z: -9.9 }, rot: 0, movable: true },
      { id: "beach-post-nw", kind: "pergola-post", pos: { x: -12.4, z: -13.6 }, rot: 0, movable: true },
      { id: "beach-post-ne", kind: "pergola-post", pos: { x: -5.6, z: -13.6 }, rot: 0, movable: true },
      { id: "beach-post-sw", kind: "pergola-post", pos: { x: -12.4, z: -9.2 }, rot: 0, movable: true },
      { id: "beach-post-se", kind: "pergola-post", pos: { x: -5.6, z: -9.2 }, rot: 0, movable: true },
      { id: "beach-pergola", kind: "pergola-roof", pos: { x: -9.0, z: -11.4 }, rot: 0, movable: true },
      // Behind the shelf, not across the approach — the bartender row stays open.
      { id: "beach-cooler", kind: "cooler", pos: { x: -11.8, z: -12.9 }, rot: 0, movable: true },
      { id: "beach-crate-1", kind: "beach-crate", pos: { x: -12.5, z: -12.0 }, rot: 0, movable: true },
      { id: "beach-torch-1", kind: "tiki-torch", pos: { x: -4.6, z: -13.2 }, rot: 0, movable: true },
      { id: "beach-torch-2", kind: "tiki-torch", pos: { x: -4.6, z: -8.6 }, rot: 0, movable: true },

      // 🎂 THE PARTY CLUSTER — beside the bar, facing the empty middle.
      { id: "beach-cake", kind: "cake-table", pos: { x: 2.2, z: -11.8 }, rot: 0, movable: true },
      { id: "beach-banner", kind: "birthday-banner", pos: { x: 2.2, z: -13.3 }, rot: 0, movable: true },
      { id: "beach-gift-1", kind: "gift-box", pos: { x: 0.5, z: -11.6 }, rot: 0, movable: true },
      { id: "beach-gift-2", kind: "gift-box", pos: { x: -0.3, z: -12.4 }, rot: 0, movable: true },
      { id: "beach-gift-3", kind: "gift-box", pos: { x: 3.9, z: -12.0 }, rot: 0, movable: true },
      { id: "beach-balloons-1", kind: "birthday-balloons", pos: { x: 5.4, z: -12.4 }, rot: 0, movable: true },
      { id: "beach-balloons-2", kind: "birthday-balloons", pos: { x: -1.3, z: -13.0 }, rot: 0, movable: true },

      // 💃 THE DANCE FLOOR — east, speaker on its back edge.
      { id: "beach-floor", kind: "dance-floor", pos: { x: 10.4, z: -5.6 }, rot: 0, movable: true },
      { id: "beach-speaker", kind: "party-speaker", pos: { x: 10.4, z: -8.2 }, rot: 0, movable: true },

      { id: "beach-stand-1", kind: "party-standing-table", pos: { x: -5.4, z: -5.2 }, rot: 0, movable: true },
      { id: "beach-stand-2", kind: "party-standing-table", pos: { x: 6.6, z: -8.4 }, rot: 0, movable: true },

      // 🌴 THE NEAR BANK — palms and boards in odd groups, gaps between, never
      // in a line and never between the camera and the cake.
      { id: "beach-palm-1", kind: "palm-tree", pos: { x: -12.6, z: 1.0 }, rot: 0, movable: true },
      { id: "beach-palm-2", kind: "palm-tree", pos: { x: -10.8, z: -1.4 }, rot: 0, movable: true },
      { id: "beach-palm-3", kind: "palm-tree", pos: { x: 12.8, z: 0.4 }, rot: 0, movable: true },
      { id: "beach-palm-4", kind: "palm-tree", pos: { x: -13.2, z: -7.0 }, rot: 0, movable: true },
      { id: "beach-board-1", kind: "surfboard", pos: { x: -13.6, z: 2.4 }, rot: 0, movable: true },
      { id: "beach-ball-1", kind: "beach-ball", pos: { x: -6.4, z: 1.2 }, rot: 0, movable: true },
      { id: "beach-crate-2", kind: "beach-crate", pos: { x: 13.4, z: -2.2 }, rot: 0, movable: true },

      // 🏝️ THE FAR BANK — the cheapest way to make a room feel bigger than it
      // is, and the reason the bridge is worth walking.
      { id: "beach-palm-5", kind: "palm-tree", pos: { x: -8.0, z: 13.4 }, rot: 0, movable: true },
      { id: "beach-palm-6", kind: "palm-tree", pos: { x: 11.6, z: 13.2 }, rot: 0, movable: true },
      { id: "beach-parasol-1", kind: "parasol", pos: { x: -3.2, z: 13.4 }, rot: 0, movable: true },
      { id: "beach-lounger-1", kind: "sun-lounger", pos: { x: -4.6, z: 13.5 }, rot: 0, movable: true },
      { id: "beach-lounger-2", kind: "sun-lounger", pos: { x: -1.8, z: 13.6 }, rot: 0, movable: true },
      { id: "beach-towel-1", kind: "beach-towel", pos: { x: 1.6, z: 13.8 }, rot: 0, movable: true },
      { id: "beach-parasol-2", kind: "parasol", pos: { x: 8.4, z: 13.5 }, rot: 0, movable: true },
      { id: "beach-lounger-3", kind: "sun-lounger", pos: { x: 9.6, z: 13.6 }, rot: 0, movable: true },
      { id: "beach-board-2", kind: "surfboard", pos: { x: 13.6, z: 12.6 }, rot: 0, movable: true },
      { id: "beach-ball-2", kind: "beach-ball", pos: { x: 3.4, z: 13.2 }, rot: 0, movable: true },
      { id: "beach-towel-2", kind: "beach-towel", pos: { x: -11.0, z: 13.6 }, rot: 0, movable: true },
    ],

    // 🧩 …and the version that FITS: ADD SET runs this against the room's real
    // extents instead of the fixed list above, which was drawn for a 5×5.
    layout: layoutBeachParty,

    // Open to the real space backdrop — a beach under a ceiling is a swimming hall.
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
  if (t.dims) writeEnvelope(t.dims);
  replaceAllFurniture(cloneItems(t.items));
  // 🌌 …and the room IS this now: stamping the theme makes the change
  // persistent and shared, instead of a look that lasted until the next
  // reload re-resolved it from nothing.
  roomThemeWriter?.(t.theme);
  return t;
}

/**
 * ➕ ADD a template's set to the CURRENT room without replacing anything.
 *
 * This is the one to reach for. A room's structure — its size, its walls, its
 * doors — is fixed when the module is born and cannot be changed afterwards,
 * so the useful operation on somebody's existing room is "put this set in it",
 * not "make it a different room". Nothing is deleted, the envelope and the
 * theme are left alone, and a template with a `layout` generator fits itself
 * to the room's real extents: it places what fits in priority order and skips
 * the rest, so the same set gives a small room its cake and a big room its
 * whole beach.
 *
 * Returns what actually landed, and how much of the set did not.
 */
export function addRoomTemplateItems(
  id: string,
): { name: string; placed: number; skipped: number } | null {
  const t = findTemplate(id);
  if (!t) return null;
  const wanted = t.layout
    ? t.layout(roomHalfExtents())
    : cloneItems(t.items).filter((i) => i.kind !== "wall-computer");
  const written = addFurniture(wanted);
  const total = t.layout ? t.layout({ halfX: 15, halfZ: 15 }).length : wanted.length;
  return { name: t.name, placed: written.length, skipped: Math.max(0, total - written.length) };
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
  if (t.dims) writeEnvelope(t.dims);
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
