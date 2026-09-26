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
 * THE ROOM'S STRUCTURE IS NEVER A TEMPLATE'S TO CHANGE (owner ruling
 * 2026-09-20). A module's envelope, walls and doors are fixed when it is born;
 * every room carries its own base furnishing (Alluxia's Home keeps its stock
 * lounge, an Empty Room its one terminal), and a set is something you put ON
 * TOP of that. So templates never write floorPlan, and the additive path —
 * addRoomTemplateItems, fitted to the room's real extents — is the one to
 * reach for. A resize-carrying `dims` field was tried and removed.
 */

import type { Box, FurnitureItem, FurnitureKind, RoomTheme, Rot } from "./furniture";
import {
  DEFAULT_LOBBY_FURNITURE, OUTDOOR_FURNITURE, CASINO_FURNITURE, FURNITURE, buildObstacleList,
  seaCorner, roomDoorPoints,
} from "./furniture";
import { replaceAllFurniture, readAllFurniture, addFurniture } from "./furnitureDoc";
import { roomHalfExtents } from "./floorPlanDoc";

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
  /**
   * 🧩 A layout GENERATED for the room it is going into, instead of the fixed
   * `items` list. A room's structure is fixed once it is built — you cannot
   * resize it, you can only put things in it — so a set that is worth adding
   * to somebody's existing room has to fit the room they actually have. The
   * generator is handed the real half-extents and places what fits, in
   * priority order, skipping what does not. See layoutBeachParty.
   */
  layout?: (half: { halfX: number; halfZ: number }, seed?: readonly Box[]) => FurnitureItem[];
}

// ── 🧩 Fitted layouts ────────────────────────────────────────────────────────

/** One thing to try to place, at a position given as a FRACTION of the room's
 *  half-extents so the same recipe works in a 12 m room and a 30 m one. */
interface PlacementSpec {
  kind: FurnitureKind;
  /** Target, in room-fractions: [-1, 1] on each axis. */
  at: [number, number];
  /** Metres added AFTER the fraction — for rigid clusters. A bar counter and
   *  the shelf behind it are a fixed distance apart in any room; fractions
   *  would squeeze them together in a small one and tear them apart in a big
   *  one. Anchor the cluster with `at`, lay it out with `off`. */
  off?: [number, number];
  rot?: Rot;
  /** Spans the room on purpose (the sea, a bridge) — skip the bounds check;
   *  crossing the room is the point. It still yields to furniture already
   *  standing where it would go. */
  spanning?: boolean;
  /** Rigid group: if any member fails to place, the whole group is dropped.
   *  A pergola roof with two of its four posts is not a pergola. */
  group?: string;
  /** Stands AGAINST the wall (a hedge): its box may run into the wall line
   *  (the part beyond it is inside the wall, harmless), and it is never
   *  nudged toward the centre — off the wall it is not a hedge. */
  hugWall?: boolean;
  /** Hangs ABOVE the furniture it is placed over (the banner strung over the
   *  cake, the pergola roof over its posts and the bar): a footprintless
   *  item is otherwise refused wherever its centre is inside an occupied
   *  box, which nudged the banner off the cake (Copilot review, PR #169). */
  overhead?: boolean;
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
  /** What already stands in the room — a set ADDED to a furnished room fits
   *  around it instead of through it (Copilot review, PR #169). */
  seed: readonly Box[] = [],
): FurnitureItem[] {
  const out: FurnitureItem[] = [];
  const occupied: Box[] = [...seed];
  const MARGIN = 0.6; // keep furniture off the walls
  let n = 0;

  const groupMembers = new Map<string, FurnitureItem[]>();
  const groupFailed = new Set<string>();
  /** Obstacle boxes each rigid group has claimed so far — handed back if it fails. */
  const groupBoxes = new Map<string, Box[]>();
  for (const spec of specs) {
    // A rigid group that already lost a member places nothing more.
    if (spec.group && groupFailed.has(spec.group)) continue;
    const tx = spec.at[0] * halfX + (spec.off?.[0] ?? 0);
    const tz = spec.at[1] * halfZ + (spec.off?.[1] ?? 0);
    // Nudges pull toward the centre, which is where the room is. A rigid
    // group gets no nudge — moving one member relative to the others is
    // exactly what `off` exists to prevent.
    const tries: Array<[number, number]> = spec.group || spec.hugWall
      ? [[tx, tz]]
      : [
          [tx, tz],
          [tx * 0.88, tz * 0.88],
          [tx * 0.76, tz * 0.92],
          [tx * 0.92, tz * 0.76],
          [tx * 0.62, tz * 0.82],
        ];
    let placed: FurnitureItem | null = null;
    for (const [x, z] of tries) {
      const item: FurnitureItem = {
        id: `${idPrefix}-${spec.kind}-${++n}`,
        kind: spec.kind,
        pos: { x: +x.toFixed(2), z: +z.toFixed(2) },
        rot: spec.rot ?? 0,
        // Everything a set puts in a room is the owner's to move or stow —
        // the river and its bridge included, the same ruling that made the
        // pool movable (furnitureDoc MOVABLE_KIND_OVERRIDE, 2026-07-20).
        movable: true,
      };
      const boxes = buildObstacleList([item]);
      if (spec.spanning) {
        // Spanning skips the BOUNDS check (crossing the room is the point),
        // not the collision one: the sea must not be laid through furniture
        // already standing in its corner (Copilot review, PR #169). Its own
        // set's later pieces then keep clear of it as before.
        if (boxes.some((b) => occupied.some((o) => boxesOverlap(b, o)))) continue;
        occupied.push(...boxes);
        if (spec.group) groupBoxes.set(spec.group, [...(groupBoxes.get(spec.group) ?? []), ...boxes]);
        placed = item;
        break;
      }
      if (boxes.length > 0) {
        const margin = spec.hugWall ? -0.6 : MARGIN;
        const outside =
          !spec.spanning &&
          boxes.some(
            (b) =>
              b.x0 < -halfX + margin || b.x1 > halfX - margin ||
              b.z0 < -halfZ + margin || b.z1 > halfZ - margin,
          );
        if (outside) continue;
        if (boxes.some((b) => occupied.some((o) => boxesOverlap(b, o)))) continue;
        occupied.push(...boxes);
        if (spec.group) groupBoxes.set(spec.group, [...(groupBoxes.get(spec.group) ?? []), ...boxes]);
      } else {
        // Decoration with no footprint (banner, balloons, towel, ball, the
        // dance floor, the pergola roof). It cannot COLLIDE, but it must not
        // be standing in the river either, and it still has to be in the room.
        if (Math.abs(x) > halfX - MARGIN || Math.abs(z) > halfZ - MARGIN) continue;
        if (!spec.overhead && pointInAny(x, z, occupied)) continue;
      }
      placed = item;
      break;
    }
    if (spec.group) {
      if (!placed) {
        // The group is out — and so are the boxes its earlier members
        // claimed, or invisible furniture would keep blocking every later
        // expansion item (Copilot review, PR #169).
        groupFailed.add(spec.group);
        const mine = new Set(groupBoxes.get(spec.group) ?? []);
        if (mine.size) {
          for (let i = occupied.length - 1; i >= 0; i--) if (mine.has(occupied[i])) occupied.splice(i, 1);
          groupBoxes.delete(spec.group);
        }
      } else {
        groupMembers.set(spec.group, [...(groupMembers.get(spec.group) ?? []), placed]);
      }
      continue;
    }
    if (placed) out.push(placed);
  }
  // Rigid groups land whole or not at all.
  for (const [g, members] of groupMembers) {
    if (!groupFailed.has(g)) out.push(...members);
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
function layoutBeachParty(half: { halfX: number; halfZ: number }, seed: readonly Box[] = []): FurnitureItem[] {
  const { halfX, halfZ } = half;
  const specs: PlacementSpec[] = [
    // 🌊 THE SEA first: flat water in the west-south corner of the sand, with
    // a staircase shoreline (furniture.ts seaWaterTiles). Everything after
    // avoids it. (The river was tried and never looked right inside a room.)
    { kind: "beach-sea", at: [0, 0], spanning: true },
    // 🛶 A raft ON the water — spanning so the occupancy check lets it float —
    // in whichever front corner the sea chose (furniture.ts seaCorner).
    { kind: "beach-raft", at: [seaCorner() === "SE" ? 0.72 : -0.72, 0.72], spanning: true },

    // 🎂 The anchor and its cluster, along the back.
    // Right of centre along the back, clear of the bar's shelf in the corner.
    { kind: "cake-table", at: [0.42, -0.78] },
    // Strung OVER the cake table (same spot; the poles stand just past its
    // ends and the cloth hangs well above the cake) — behind it is the hedge.
    { kind: "birthday-banner", at: [0.42, -0.78], overhead: true },
    // Gifts in METRES from the cake — one each side — so they sit beside it
    // in any room instead of drifting into the bar in a small one.
    { kind: "gift-box", at: [0.42, -0.78], off: [-1.6, 0.3] },
    { kind: "gift-box", at: [0.42, -0.78], off: [1.6, 0.3] },
    { kind: "birthday-balloons", at: [0.72, -0.82] },
    { kind: "birthday-balloons", at: [0.06, -0.86] },

    // 💃 Somewhere to dance, and the switch for it.
    { kind: "dance-floor", at: [0.68, -0.34] },
    // On the floor's near edge: its back edge is where the cake cluster ends.
    { kind: "party-speaker", at: [0.68, -0.05] },

    // 🍹 The bar, anchored in the FAR CORNER and laid out in metres from it so
    // the shelf, counter and stools keep their spacing in any room: shelf at
    // the back, counter in front, stools on the camera side. Never mirrored.
    { kind: "tiki-back-bar", at: [-1, -1], off: [4.6, 1.7] },
    { kind: "tiki-bar-counter", at: [-1, -1], off: [4.6, 3.3] },
    { kind: "tiki-bar-stool", at: [-1, -1], off: [3.1, 4.4] },
    { kind: "tiki-bar-stool", at: [-1, -1], off: [4.6, 4.4] },
    { kind: "tiki-bar-stool", at: [-1, -1], off: [6.1, 4.4] },

    // 🏖️ THE BEACH — the whole front of the room: loungers under parasols in
    // two small groups, palms at the sides where they frame rather than
    // occlude, and the middle still left for the crowd.
    { kind: "sun-lounger", at: [-0.28, 0.62] },
    { kind: "tiki-parasol", at: [-0.1, 0.5] },
    { kind: "sun-lounger", at: [0.48, 0.64] },
    { kind: "tiki-parasol", at: [0.66, 0.5] },
    { kind: "palm-tree", at: [-0.86, 0.3] },
    // Clear of the speaker's front (a palm at 0.26 wedged it shut).
    { kind: "palm-tree", at: [0.86, 0.5] },
    { kind: "palm-tree", at: [-0.88, -0.44] },
    { kind: "tiki-torch", at: [-0.2, -0.66] },
    { kind: "tiki-torch", at: [-0.9, -0.66] },
    { kind: "tiki-parasol", at: [0.86, -0.86] },
    { kind: "palm-tree", at: [0.74, 0.88] },

    // Everything past here is expansion — it lands only if there is room.
    { kind: "party-standing-table", at: [-0.34, -0.3] },
    // Beside the cake, not on its front point.
    { kind: "party-standing-table", at: [0.16, -0.55] },
    { kind: "cooler", at: [-1, -1], off: [1.3, 3.4] },
    { kind: "beach-crate", at: [-1, -1], off: [2.3, 0.9] },
    // The pergola is a RIGID GROUP: four posts 6.6 × 3.6 apart (the roof's
    // size) or nothing — a roof floating over two posts is worse than no roof.
    { kind: "pergola-post", at: [-1, -1], off: [1.3, 1.7], group: "pergola" },
    { kind: "pergola-post", at: [-1, -1], off: [7.9, 1.7], group: "pergola" },
    { kind: "pergola-post", at: [-1, -1], off: [1.3, 5.3], group: "pergola" },
    { kind: "pergola-post", at: [-1, -1], off: [7.9, 5.3], group: "pergola" },
    { kind: "pergola-roof", at: [-1, -1], off: [4.6, 3.5], group: "pergola", overhead: true },
    { kind: "gift-box", at: [0.86, -0.72] },
    { kind: "surfboard", at: [-0.94, 0.62] },
    { kind: "beach-ball", at: [-0.42, 0.3] },
    { kind: "beach-ball", at: [0.3, 0.86] },
    { kind: "beach-towel", at: [0.1, 0.72] },
    { kind: "beach-towel", at: [-0.72, 0.86] },
  ];
  // 🌿 THE HEDGE: one jungle plant per tile along BOTH back walls (the −x and
  // −z walls, the two the camera looks at), the way the reference fences its
  // beach in with greenery in its last twelve seconds. Doors keep a lane;
  // anything already standing against those walls (the bar, the cake) simply
  // interrupts the row — placeFitting skips the collisions.
  const doors = roomDoorPoints();
  const clearOfDoors = (x: number, z: number) =>
    doors.every((d) => Math.hypot(d.x - x, d.z - z) >= 1.6);
  const hedge: PlacementSpec[] = [];
  const inset = 0.28; // stems right up against the wall (owner spec), fronds into it
  for (let x = -halfX + inset; x < halfX; x += 1) {
    if (clearOfDoors(x, -halfZ + inset)) hedge.push({ kind: "jungle-plant", at: [x / halfX, (-halfZ + inset) / halfZ], hugWall: true });
  }
  for (let z = -halfZ + inset + 1; z < halfZ - 1; z += 1) {
    if (clearOfDoors(-halfX + inset, z)) hedge.push({ kind: "jungle-plant", at: [(-halfX + inset) / halfX, z / halfZ], hugWall: true });
  }
  // The hedge goes AFTER the bar and the cake cluster (they win the wall) and
  // BEFORE the beach dressing, which has the whole front to itself anyway.
  const expansionAt = specs.findIndex((sp) => sp.kind === "party-standing-table");
  const ordered = [...specs.slice(0, expansionAt), ...hedge, ...specs.slice(expansionAt)];
  return placeFitting(ordered, halfX, halfZ, "beach", seed);
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
    // The FROZEN manifest. `FURNITURE` itself mirrors the live room (World
    // splices it on every reconcile), so `items: FURNITURE` placed "whatever
    // is here already" — nothing, in an empty room.
    items: [...DEFAULT_LOBBY_FURNITURE],

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
      { id: "party-banner", kind: "birthday-banner", pos: { x: -1.0, z: -4.2 }, rot: 0, movable: true },
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
      "Sand underfoot and a flat sea in the corner, thatched parasols with party bulbs, a tiki bar in the far corner, cake and gifts along the back, a lit dance floor — and an empty middle.",
    // PLACE and ADD share one source: the fitted layout, here at the DEFAULT
    // 2×2 envelope every room is born with. A hand-authored 5×5 list lived
    // here before and put every piece outside the walls of a real room.
    // The Empty Room's own terminal rides along so PLACE never strands a room
    // without its edit-mode entry (id ≠ the reserved "wall-computer").
    items: [
      { id: "beach-computer", kind: "wall-computer", pos: { x: 1.8, z: 5.97 }, rot: 2, movable: true },
      ...layoutBeachParty({ halfX: 6, halfZ: 6 }),
    ],

    // 🧩 …and the version that FITS: ADD SET runs this against the room's real
    // extents instead of the fixed list above, which was drawn for a 5×5.
    layout: layoutBeachParty,

    // 🏖️ The beach theme: the deck's open sky and sunward light over a SAND
    // floor (world.ts applyRoomVisuals) — the reference build's whole look is
    // sand under your feet and a flat sea in the corner.
    theme: "beach",
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
  // Only a FITTED set can be added: a fixed manifest knows nothing about the
  // room it lands in or what is already there — it would write its items at
  // their authored coordinates straight through the furniture (Copilot
  // review, PR #169). Those templates PLACE (replace everything) only.
  if (!t || !t.layout) return null;
  const wanted = t.layout(roomHalfExtents(), buildObstacleList(FURNITURE));
  const written = addFurniture(wanted);
  const total = t.layout({ halfX: 15, halfZ: 15 }).length;
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
