/**
 * 🗂️ Furniture drive-handle registration — the ONE list of handle kinds a
 * furniture mesh can carry on `userData`, and the sink World files each into.
 *
 * Two paths register a furniture item's group into World:
 *  - `World.registerFurnitureGroup` — the lobby build and the E4 reconcile
 *    (a synced item landing at runtime), and
 *  - devMenu's `registerSpawnedGroup` — the DEV-menu runtime spawn, which
 *    reaches into World's private collections on purpose.
 * Each used to carry its own copy of this list, and the copies drifted:
 * devMenu never filed `slotMachineVisual`, so a DEV-spawned slot machine had
 * no reel drive (#117). Both paths now call `registerFurnitureHandles`, so a
 * new handle kind cannot land in one path only — add the `userData` key to
 * the function below and its sink to `FurnitureHandleSinks`; `tsc` then fails
 * wherever a sink is missing (World's `furnitureHandleSinks()` literal), and
 * `furnitureHandles.test.ts` fails if either path grows a private copy again.
 *
 * Scope: filing only. The mesh list, reveal/opacity and light fades stay with
 * the callers — the two paths differ there by design (the lobby build rides
 * the morph fade-in; a runtime spawn reveals immediately).
 *
 * Lifecycle: registration is two-path, removal is one-path —
 * `World.removeFurnitureVisuals` must delete from EVERY sink below, or a
 * removed item leaves a live driven handle (#45 F1). A kind added here
 * without its inverse delete there is a leak; the test pins that mirror too.
 */
import type * as THREE from 'three';
import type {
  WallScreenHandle,
  TrunkLidHandle,
  GameTableTopHandle,
  CloneVatHandle,
  SlotMachineVisualHandle,
} from './devices';

/**
 * The per-item drive collections World owns, seen as the sinks the handle
 * list files into. World's fields are private, so World cannot satisfy this
 * interface structurally; `World.furnitureHandleSinks()` hands out the live
 * collections (not copies) under these names. Filing into the result IS
 * filing into World.
 */
export interface FurnitureHandleSinks {
  /** Live wall-computer screens, keyed by item id (M1 — driven at ~1 Hz). */
  wallScreens: Map<string, WallScreenHandle>;
  /** Holo-ring spinners (M4 map table) — one entry PER MESH tagged
   *  `userData.holoSpin` (a table may carry several rings), not per item. */
  holoSpinners: Array<{ mesh: THREE.Mesh; speed: number }>;
  /** Animated trunk lids, keyed by item id (TR2 — driven every frame). */
  trunkLids: Map<string, TrunkLidHandle>;
  /** Flippable game-table tops, keyed by item id (#45 — driven every frame). */
  gameTableTops: Map<string, GameTableTopHandle>;
  /** 🧬 Clone-vat tanks, keyed by item id (driven every frame like the lids). */
  cloneVats: Map<string, CloneVatHandle>;
  /** 🎰 Slot-machine cabinet visuals (reels/lamps), keyed by item id. */
  slotMachineVisuals: Map<string, SlotMachineVisualHandle>;
}

/**
 * File every drive handle `mesh.userData` carries into its sink under
 * `itemId`. Called for each Mesh of a freshly built item group (the callers
 * traverse and narrow to `THREE.Mesh` — a spinner entry stores the Mesh).
 *
 * The checks mirror how the builders stow handles (furniture.ts): handle
 * objects file by truthiness; `holoSpin` is a bare number (the spin speed), so
 * it files by type — a 0-speed ring is still a registered ring. Per-item maps
 * take the last carrier mesh seen (Map.set); the builders stow one carrier
 * per kind per item, so in practice there is exactly one.
 */
export function registerFurnitureHandles(
  sinks: FurnitureHandleSinks,
  itemId: string,
  mesh: THREE.Mesh,
): void {
  const d = mesh.userData;
  if (d.wallScreen) sinks.wallScreens.set(itemId, d.wallScreen as WallScreenHandle);
  if (typeof d.holoSpin === 'number') sinks.holoSpinners.push({ mesh, speed: d.holoSpin });
  if (d.trunkLid) sinks.trunkLids.set(itemId, d.trunkLid as TrunkLidHandle);
  if (d.gameTableTop) sinks.gameTableTops.set(itemId, d.gameTableTop as GameTableTopHandle);
  if (d.cloneVat) sinks.cloneVats.set(itemId, d.cloneVat as CloneVatHandle);
  if (d.slotMachineVisual) {
    sinks.slotMachineVisuals.set(itemId, d.slotMachineVisual as SlotMachineVisualHandle);
  }
}
