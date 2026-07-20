# Room Templates — RollerCoaster-Tycoon-style room presets

*Owner direction 2026-07-20: "select a full pool deck / casino and place with one click, OR build
piece-by-piece. Plan for multiple variants per type (casino-1/2/3, pool-2 = hot tub in the middle of
the pool). Should provisioning a new room at the door-panel computer offer a template dropdown?"*

## Vision

A **room template** is a full room design — a furniture layout **+ the door arrangement it was authored
for** (later: + lighting theme + room size). Two ways to build a room:
- **One-click a preset** (Grand Lobby / Luxury Casino / Infinity Pool …), or
- **build piece-by-piece** with the furniture spawner.

Each room *type* has multiple **variants** (`casino-1`, `casino-2`, `pool-2` …). The three built-ins
reuse the exact manifests the authored rooms already ship, so a template always matches its room.

## Data model (`roomTemplates.ts` — shipped)

```ts
type TemplateCategory = "lobby" | "casino" | "pool";
interface RoomTemplate { id: "casino-1"|…; category; name; description; items: FurnitureItem[]; doorLayout; }
// future fields: roomSize?: {cols,rows} (R2 presets); theme?: "lobby"|"casino"|"pool" (lighting+waiter)
```
Helpers: `templateCategories()`, `templatesByCategory(cat)`, `findTemplate(id)`,
`applyRoomTemplate(id)` (atomic `replaceAllFurniture` + `setActiveDoorLayout`),
`exportCurrentRoomAsTemplate()` (prints the current room's manifest to the console).

## Authoring variants — the key workflow

The **EXPORT** button closes the loop: arrange a room by hand in-game → press EXPORT → paste the printed
manifest into `ROOM_TEMPLATES` as `casino-2` / `pool-2`. So "casino-1/2/3" is **content authored in-game**,
not code — `pool-2` (hot tub centred in the water) is: place a pool, drag the hot tub to the middle,
EXPORT, paste. (Next: promote EXPORT to a proper "Save as template" with a name + an in-session list.)

## Two placement surfaces

1. **Dev menu — SHIPPED (T1).** ROOM TEMPLATES section: a PLACE button per variant (REPLACES the current
   room) + EXPORT. For testing + authoring. Verified: PLACE Luxury Casino swaps 35 lobby → 26 casino
   pieces, moves the doors, rebuilds; restore works.
2. **Provisioning dropdown — RECOMMENDED NEXT (T2).** ✅ **Yes, do this.** It's the *productized* home for
   templates. At the door-panel room terminal's **PROVISION NEW MODULE**, add a `<select>`:
   `Empty · Grand Lobby · Luxury Casino · Infinity Pool · Hot-Tub Island · …` → the newly-minted module is
   **born with that preset**. This unifies three threads:
   - **Templates** get a real player-facing home (not just the dev menu).
   - **Empty-by-default rooms** (the held item) becomes just the **"Empty"** choice — no special-casing.
   - **R2 room sizes** slot in as a second dropdown (Size × Template) once bigger rooms render.
   Wiring: the room terminal's `onProvisionModule` carries the chosen template id → `provisionModuleSeed`
   stamps it on the minted room → first claim seeds that template (via `replaceAllFurniture` + door
   layout) instead of the lobby default. "Empty" seeds only the wall-computer (keeps the edit entry).

## Slices

| # | Slice | State |
|---|---|---|
| **T1** | Dev-menu templates (PLACE + EXPORT), variant-ready registry | ✅ shipped |
| **T2** | **Provisioning dropdown** at the door panel (+ "Empty" = the held empty-rooms item) | recommended next |
| **T3** | Author variant content: `casino-2/3`, `pool-2` (hot-tub island), `lobby-2` — via EXPORT | incremental |
| **T4** | Template also swaps **theme** (lighting + waiter) — refactor `applyRoomVisuals` from roomId-keyed to room-type-driven | follow-up |
| **T5** | **Size presets** — a template declares `roomSize`; provisioning sets the room dimensions (#66 R2) | after R2 |
| **T6** | **Sub-assemblies / kits** — smaller placeable groups (roulette pit, cabana, bar cluster) dropped at a clicked anchor: the RCT middle-ground between whole-room and single-item | later |

## More ideas
- **Preview** — thumbnail (or a top-down mini-map) of the variant in the picker before committing.
- **Confirm the destructive replace** in-game (the dev PLACE clears the room); provisioning is naturally
  non-destructive (brand-new room).
- **"Surprise me"** — pick a random variant of a category.
- **Custom/shared templates** — persist saved templates (localStorage, or a station-doc so a design can
  be shared like a room pass). Turns templates into user-generated content.
- **Keep the wall-computer** in every non-empty template so the room stays editable in-world.

*Design doc; T1 shipped. Grounded in the live manifests (FURNITURE / CASINO_FURNITURE / OUTDOOR_FURNITURE)
and the provision flow (main.ts `provisionModuleSeed`, devices.ts `createRoomTerminalUI` → onProvisionModule).*
