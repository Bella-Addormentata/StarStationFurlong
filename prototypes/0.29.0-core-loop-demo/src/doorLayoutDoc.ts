/**
 * 🚪 Door LAYOUT sync (#28 doors decouple, slice 4)
 *
 * WHICH doors a room has — id → {wall, lateral, size, enabled} — lives in a
 * room-doc `doorLayout` Y.Map, so a joiner sees the host's door set on entry and
 * the owner's future add / remove / move (slice 5+) propagates to everyone.
 * Before this, doors were a fixed code constant (the 4 cardinals) instantiated
 * identically on every client with no way to add or remove one.
 *
 * DELIBERATELY SEPARATE from two neighbours that sound the same:
 *  - the door PAIRING store (doorsDoc.ts, the `doors` map) — which room a port
 *    is docked to. Untouched; keyed by the stable cardinal PORT.
 *  - the door SLIDE store (floorPlanDoc.ts `door:${id}`) — the owner's drag,
 *    applied ON TOP of a record's base lateral. Still separate, for now.
 *
 * 🚪 A record's `wall` + `lateral` are now the door's BASE POSITION, for every
 * door. That is what retired the door-LAYOUT KINDS: a cardinal's physical slot
 * used to come from a four-entry table chosen per room ("legacy" / the paired
 * arrangements), so `south` meant whatever the table said and a wall could hold
 * exactly one door of each name — it could express neither an empty wall nor a
 * wall with three doors on it. Owner's ruling: a wall carries zero or many
 * doors and they all run the same code. The tables survive only as the compat
 * shim below, translating records written before that. Runtime `enabled` is
 * still owned by the room (fireplace / casino force-enable / DEV toggle).
 *
 * Rebinds per join like furniture / games / roomInfo (main.ts T0 seam). Reads
 * cross the peer trust boundary → shape-guarded by isDoorLayoutRecord.
 */

import * as Y from 'yjs';
import { findDoor } from './doors';
import { doorSlideDelta } from './floorPlanDoc';

/**
 * 🧭 AXIS WALL LABELS (owner ruling 2026-08-09): the room's four sides named by
 * the PLAN-VIEW axes — x+/x- and y+/y-, with z+ the roof and z- the floor
 * (reserved; doors never sit on those). The room's CENTRE is the origin, so a
 * wall label is literally "the side where that coordinate is positive".
 *
 * These replace the compass words, which were lies twice over: they claimed a
 * world orientation modules no longer have (a module renders at any angle),
 * and they collided with the four LEGACY DOOR IDS ('north'…), which are names
 * of doors, not places. The mapping to the old words — and to the ENGINE's
 * axes, which are Y-up (three.js), so a plan-view y± wall sits on the engine's
 * Z axis — is stated once, here:
 *
 *   'x+' = old east  = engine +X      'y+' = old south = engine +Z
 *   'x-' = old west  = engine −X      'y-' = old north = engine −Z
 */
export type DoorWall = 'x+' | 'x-' | 'y+' | 'y-';

const WALLS: readonly DoorWall[] = ['x+', 'x-', 'y+', 'y-'];

/** Old compass wall values → axis labels. READ boundary only: stored rooms are
 *  full of 'north' walls, and dropping them would strip every door from every
 *  pre-rename room. Writes always emit axis labels. */
const LEGACY_WALL: Record<string, DoorWall> = {
  east: 'x+', west: 'x-', south: 'y+', north: 'y-',
};

/** A LEGACY DOOR ID's self-described wall — the four old ids were born on the
 *  wall of the same name. Ids are opaque names and stay as they are; only the
 *  geometry vocabulary changed. */
export const LEGACY_ID_WALL: Record<string, DoorWall> = {
  east: 'x+', west: 'x-', south: 'y+', north: 'y-',
};

/** Accept a stored wall value in either vocabulary; undefined for junk. */
export function normalizeWall(v: unknown): DoorWall | undefined {
  if (typeof v !== 'string') return undefined;
  if ((WALLS as readonly string[]).includes(v)) return v as DoorWall;
  return LEGACY_WALL[v];
}

/** Marker key in the doorLayout map — see the DOOR-SET MARKER block below. */
const META_KEY = '__meta';

/** Serializable door-membership record — one per door id. Plain JSON, the same
 *  discipline as the furniture map. */
export interface DoorLayoutRecord {
  id: string;
  wall: DoorWall;
  /** The door's BASE centre along `wall`. Authoritative (see `placed`); the
   *  owner's floor-plan slide is added on top by the caller. */
  lateral: number;
  /** Leaf-width class. #91 collapsed doors to ONE size: this is still accepted
   *  (and still written) for backward/forward compat, but readAllDoorLayout
   *  normalizes every record to 'large' — nothing downstream branches on it. */
  size?: 'small' | 'large';
  /** SEED walkability only — runtime `enabled` is owned by the room
   *  (updateNorthDoorForFireplace / casino force-enable / DEV toggle). */
  enabled?: boolean;
  /**
   * 🪧 Wayfinding label — what is on the OTHER side of this door, authored by
   * the room owner in the door panel ("POOL", "CASINO", "LOBBY", "DOCK 3").
   *
   * This is what replaces hanging signs off a door's cardinal ID. The wayfinding
   * signs used to be pinned to literal ids — the pool sign on the door called
   * "south", the casino sign on "east" (world.refreshDoorSigns) — which meant a
   * sign could not follow a door that moved, could not exist at all on a
   * user-placed `d:` door (they were force-hidden), and encoded the room author's
   * intent in a field that also claims to be a compass direction.
   *
   * Trimmed and length-capped at the write boundary; absent or empty ⇒ no sign.
   */
  label?: string;
  /**
   * 🚪 This record's `wall`/`lateral` are AUTHORITATIVE — pose the door from
   * them and nothing else.
   *
   * Free `d:` doors have always been authoritative; they had no other store to
   * be overridden by. The four cardinals did: their physical slot came from a
   * per-room LAYOUT KIND ("legacy" put each on its own wall centred, the paired
   * kinds put logical south on the NORTH wall and east on the WEST wall,
   * ±PAIR_OFFSET), so a room's `south` door was wherever the table said, and
   * this record's wall said "south" while the door stood on the north wall.
   *
   * The owner's ruling is that a wall may carry zero or many doors and all of
   * them run the same code, which a four-slot table cannot express. So the
   * table is now a READ-TIME COMPAT SHIM (below) that fires only for a cardinal
   * record WITHOUT this flag — i.e. one written before the migration, in a room
   * whose owner has not re-seeded it. Every fresh write sets it, and when no
   * stale rooms remain the shim deletes in one file.
   */
  placed?: boolean;
}

// ── 🚪 COMPAT SHIM: the retired door-LAYOUT KINDS ────────────────────────────
// Everything below exists ONLY to translate records written before doors became
// individually placeable. No other module may read it: the rest of the app sees
// a door as {wall, lateral} and nothing else. Delete the whole block once no
// un-migrated room docs remain in the wild.

/** The one paired arrangement, under both of its old names. */
export type LegacyLayoutKind = 'legacy' | 'casino-pairs' | 'pool-pairs';

/** Spacing between the two doors that shared a wall in the paired kinds. */
const PAIR_OFFSET = 3.0;

/** Where a LEGACY DOOR ID physically stood under each retired kind. The
 *  parameter was typed as a wall before the axis rename, which was exactly the
 *  id/wall conflation the rename splits: this takes the ID ('north'…), and
 *  answers in axis walls. */
function legacySlotFor(
  id: string,
  kind: LegacyLayoutKind,
): { wall: DoorWall; lateral: number } {
  if (kind === 'legacy')
    return { wall: LEGACY_ID_WALL[id] ?? 'y-', lateral: 0 };
  switch (id) {
    case 'north': return { wall: 'y-', lateral: -PAIR_OFFSET };
    case 'south': return { wall: 'y-', lateral: PAIR_OFFSET };
    case 'west': return { wall: 'x-', lateral: -PAIR_OFFSET };
    default: return { wall: 'x-', lateral: PAIR_OFFSET }; // 'east'
  }
}

/**
 * Which retired kind the CURRENT room was authored under. Set from roomInfo by
 * world.applyRoomVisuals — the same single call site the old
 * `setActiveDoorLayout` had, so the ordering characteristics are unchanged
 * (notably: it runs after an adapter arrival completes, exactly as before).
 *
 * 'legacy' is the boot default because that is what the retired module global
 * defaulted to, which keeps pre-first-room poses bit-identical.
 */
let compatKind: LegacyLayoutKind = 'legacy';

/** A room states its retired arrangement in its own doc, or states nothing —
 *  in which case 'legacy' (the boot default) reads its records. The caller
 *  used to substitute a kind based on WHICH ROOM this was; that was
 *  room-typing in the one place that decides how a stored door is read
 *  (owner ruling 2026-08-13: no room types). */
export function setLegacyRoomDoorLayout(kind?: LegacyLayoutKind): void {
  compatKind = kind ?? 'legacy';
}

export function isLegacyDoorLayoutKind(v: unknown): v is LegacyLayoutKind {
  return v === 'legacy' || v === 'casino-pairs' || v === 'pool-pairs';
}

/** Apply the shim to one record: an un-migrated CARDINAL gets the wall and
 *  lateral its retired kind put it at, so a visitor to somebody else's stale
 *  room sees exactly the doors that room's owner sees. Free doors and migrated
 *  cardinals pass through untouched. */
function withCompatSlot(rec: DoorLayoutRecord): DoorLayoutRecord {
  if (rec.placed) return rec;
  if (!(rec.id in LEGACY_ID_WALL)) return rec; // free door — already authoritative
  const slot = legacySlotFor(rec.id, compatKind);
  return { ...rec, wall: slot.wall, lateral: slot.lateral };
}

/**
 * 🚪 The door set an UNSEEDED room presents — the four cardinal berths, posed
 * through the shim so an un-migrated room's defaults match what its owner had.
 * (Lived in world.ts; moved here so the defaults and the stored records go
 * through one normalizer rather than two that can drift.)
 */
export function defaultDoorLayoutRecords(): Map<string, DoorLayoutRecord> {
  const out = new Map<string, DoorLayoutRecord>();
  for (const id of Object.keys(LEGACY_ID_WALL)) {
    const rec = withCompatSlot({
      id, wall: LEGACY_ID_WALL[id], lateral: 0, size: 'large', enabled: true,
    });
    // 🚪 #18: an un-migrated room's slid doors keep their slide (same fold as
    // readAllDoorLayout — the synthesized defaults are that room's truth).
    rec.lateral += doorSlideDelta(id);
    out.set(id, rec);
  }
  return out;
}

/** The wall + lateral a cardinal should be MIGRATED to — its current physical
 *  slot, so writing it moves nothing. */
export function migratedCardinalSlot(id: string): { wall: DoorWall; lateral: number } {
  return legacySlotFor(id, compatKind);
}
// ── end compat shim ─────────────────────────────────────────────────────────

/** 🪧 Longest wayfinding label we will store or render. Long enough for
 *  "OBSERVATION DECK", short enough to stay legible on a door plaque. */
export const DOOR_LABEL_MAX = 18;

/**
 * 🪧 What to CALL a door in front of a user. The authored label wins; a door
 * without one gets a name generated from its CURRENT position — "WEST DOOR",
 * or "WEST DOOR 2" when the wall carries several, ordered along the wall.
 *
 * Display only, recomputed at render time, never stored — deliberately. A
 * name derived from position adapts when the door moves or its wall-mates
 * change, precisely BECAUSE it is not the door's identity. Identity stays the
 * opaque id, which is what lets a door keep its sign, its policy, its grants
 * and its pairing while the owner slides it (owner question 2026-08-09:
 * coordinate-derived IDS would re-fuse name to position — the cardinal
 * disease this branch just cured — and let a new door inherit a dead door's
 * tombstone and PIN by standing in the same spot).
 */
export function doorDisplayName(id: string): string {
  // 🧭 An UNSEEDED room presents the four synthesized defaults everywhere else
  // — number those too, or a cardinal id would fall through the ordinal miss
  // and reach the user VERBATIM ("north"), the exact word this function
  // exists to keep off the screen (sweep finding, 2026-08-09).
  const stored = readAllDoorLayout();
  const records = stored.size > 0 ? stored : defaultDoorLayoutRecords();
  const rec = records.get(id);
  const label = rec ? sanitizeDoorLabel(rec.label) : undefined;
  if (label) return label;
  // 🧭 NO COMPASS WORDS (owner ruling): a module renders at any angle now, so
  // "WEST DOOR" is meaningless the moment its module rotates. Doors are
  // NUMBERED — walked around the room's own perimeter, an ordering every
  // client derives identically and that survives any world rotation because
  // it never references one.
  const n = doorOrdinals([...records.values()]).get(id);
  if (n !== undefined) return `DOOR ${n}`;
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/**
 * 🔢 Stable 1-based numbering for a door set: walk the room's own perimeter —
 * the four sides in fixed local order, then along each side — so every client
 * numbers identically from the same records, with the id as the final
 * tie-break. Takes a plain array (not the doc) so the FAR room's gossiped
 * atlas doors can be numbered with the same rule the near room uses.
 * Display currency only; identity remains the opaque id.
 */
export function doorOrdinals(
  doors: Array<{ id: string; wall?: DoorWall; lateral?: number }>,
): Map<string, number> {
  // Axis labels — the compass keys this held before the wall rename made the
  // whole wall tier rank 9, silently demoting the perimeter walk to a plain
  // lateral sort (fold review, found in passing).
  const order: Record<string, number> = { 'y-': 0, 'x+': 1, 'y+': 2, 'x-': 3 };
  const sorted = [...doors].sort((a, b) =>
    (order[a.wall ?? ''] ?? 9) - (order[b.wall ?? ''] ?? 9)
    || (a.lateral ?? 0) - (b.lateral ?? 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const out = new Map<string, number>();
  sorted.forEach((d, i) => out.set(d.id, i + 1));
  return out;
}

/** Normalize a user-typed label: collapse whitespace, trim, cap length.
 *  Returns undefined for anything that should clear the label. */
export function sanitizeDoorLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = raw.replace(/\s+/g, ' ').trim().slice(0, DOOR_LABEL_MAX);
  return clean.length > 0 ? clean : undefined;
}

let boundDoc: Y.Doc | null = null;
let doorLayoutMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copy + isolate (the furnitureDoc guard): a listener may unsubscribe
  // mid-notify, and this runs inside Yjs's observe callback — one throwing
  // reconcile must not kill the others or Yjs's transaction cleanup.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[doorLayout] listener threw during doc notify:', err);
    }
  }
}

export function bindDoorLayoutDoc(doc: Y.Doc): void {
  boundDoc = doc;
  doorLayoutMap = doc.getMap('doorLayout');
  doorLayoutMap.observe(() => notify());
  notify(); // reconcile from the fresh doc (mirror of bindFurnitureDoc)
}

export function subscribeDoorLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the bound doc is usable (leaveRoom destroys the previous doc). */
function docAlive(): boolean {
  return (
    boundDoc !== null &&
    !(boundDoc as { isDestroyed?: boolean }).isDestroyed &&
    doorLayoutMap !== null
  );
}


/** Shape guard (doc reads cross a trust boundary — see module header). */
export function isDoorLayoutRecord(value: unknown): value is DoorLayoutRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<DoorLayoutRecord>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    normalizeWall(r.wall) !== undefined &&
    Number.isFinite(r.lateral) &&
    (r.size === undefined || r.size === 'small' || r.size === 'large') &&
    (r.enabled === undefined || typeof r.enabled === 'boolean') &&
    // 🪧 Accept any string (never reject stored data — the #91 discipline);
    // readAllDoorLayout normalizes it below so an over-long or whitespace-only
    // label from a hostile or older peer can never reach the renderer.
    (r.label === undefined || typeof r.label === 'string') &&
    (r.placed === undefined || typeof r.placed === 'boolean')
  );
}

/**
 * Snapshot the whole door set as id → validated record (malformed entries are
 * skipped — a bad peer write degrades to "that door is absent").
 *
 * 🚪 #91 READ-NORMALIZATION: every record is coerced to the one door size and
 * an on-grid centre here, at the read boundary. Rooms authored before #91 hold
 * `size:'small'` records at mid-cell laterals (n+0.5); rewriting them would
 * need owner write access in every room, so instead the whole app simply never
 * SEES the old shape — a visitor in someone else's stale room renders the same
 * on-grid doors the owner does. The shape guard still ACCEPTS 'small' (never
 * reject stored data); it just stops propagating past this line.
 */
export function readAllDoorLayout(): Map<string, DoorLayoutRecord> {
  const out = new Map<string, DoorLayoutRecord>();
  if (!docAlive()) return out;
  for (const [id, value] of doorLayoutMap!.entries()) {
    if (isDoorLayoutRecord(value) && value.id === id) {
      // 🚪 withCompatSlot LAST: it substitutes the retired layout table's wall
      // and lateral for an un-migrated cardinal, and those are already on-grid,
      // so it must not be rounded back through the #91 normalization above.
      const norm = withCompatSlot({
        ...value,
        // 🧭 Stored walls may still speak compass — normalize to axis labels
        // at the read boundary, like every other legacy value.
        wall: normalizeWall(value.wall) ?? value.wall,
        size: 'large',
        lateral: Math.round(value.lateral),
      });
      // 🚪 #18 THE FOLD: the retired floorPlan slide store's residue joins the
      // record's lateral HERE, once, at the read boundary — after the compat
      // shim, whose substituted slot the old pose path also added the slide on
      // top of. Every consumer now poses from the record alone; nothing else
      // may read the slide store, or the door doubles its own drag.
      if (id in LEGACY_ID_WALL) norm.lateral += doorSlideDelta(id);
      // 🪧 …and the label, for the same reason the size and lateral are done
      // here: the shape guard accepts any string so stored data is never
      // rejected, which means an over-long, padded or whitespace-only label
      // from an older or hostile peer would otherwise reach the renderer
      // untouched. Normalizing at the read boundary makes every consumer safe
      // without each of them having to remember (PR #103 review).
      const label = sanitizeDoorLabel(norm.label);
      if (label) norm.label = label;
      else delete norm.label;
      out.set(id, norm);
    }
  }
  return out;
}

/** Number of entries (0 ⇒ unseeded — reconcile keeps the local cardinal defaults). */
export function doorLayoutDocSize(): number {
  return docAlive() ? doorLayoutMap!.size - (doorLayoutMap!.has(META_KEY) ? 1 : 0) : 0;
}

// ── 🚪 The DOOR-SET MARKER — what makes "no doors" sayable ───────────────────
//
// An empty map used to mean ONE thing: "this room predates the doorLayout
// store, fall back to the four cardinal defaults". That overloading is why a
// room could never have zero doors, and it reached a long way — the reconcile's
// default substitution, the editor's phantom door openings, the exterior collar
// loop, the sign existence test, the seed-visibility gate, and five SEED-FIRST
// defusals whose only job was to stop a single write looking like a wipe.
//
// The marker splits the two meanings apart. Present ⇒ this room's door set is
// AUTHORITATIVE, whatever its size, including zero. Absent ⇒ un-migrated, keep
// the old fallback. Every seed writes it, so the fallback is self-retiring.
//
// It lives in the same map (rather than roomInfo) so it lands in the SAME
// transaction as the records it describes — a joiner can never observe the
// records without the marker, or the marker without the records.

/** Declare this room's door set authoritative — including an EMPTY one. */
export function markDoorSetAuthoritative(): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorLayoutMap!.set(META_KEY, { v: 1 });
  });
}

/**
 * True once the room has stated its own door set.
 *
 * ANY record makes it authoritative — the un-migrated fallback only ever fired
 * on an EMPTY map, so a room with doors was already speaking for itself and
 * needs no marker to prove it. That matters for rooms seeded before the marker
 * existed: they carry records but no marker, and demanding one would have made
 * them un-migrated again.
 *
 * So the marker's only job is to disambiguate the empty case: empty + marker
 * means "this room has NO doors", a real and renderable state; empty without
 * one means "this room predates the store", keep the four defaults.
 */
export function doorSetIsAuthoritative(): boolean {
  if (!docAlive()) return false;
  if (doorLayoutDocSize() > 0) return true;
  const m = doorLayoutMap!.get(META_KEY);
  return typeof m === 'object' && m !== null && (m as { v?: unknown }).v === 1;
}

/**
 * True ONLY for an authoritative-EMPTY room: the marker is present and there
 * are no door records. This is the one case birth-door healing may repair —
 * the room has stated "I have no doors", and a connection's farDoor record is
 * the evidence that one was lost. A legacy UNMARKED empty room returns false
 * here: its missing marker means "un-migrated; render the four defaults", and
 * seeding it would convert that legacy fallback into an authoritative one-door
 * set (reaping the other three). Never heal the unmarked case.
 */
export function doorSetIsMarkedEmpty(): boolean {
  if (!docAlive()) return false;
  if (doorLayoutDocSize() > 0) return false;
  const m = doorLayoutMap!.get(META_KEY);
  return typeof m === 'object' && m !== null && (m as { v?: unknown }).v === 1;
}

/**
 * 🛰️ Claim a room as having NO doors at all — a fresh standalone station,
 * which is connected to nothing and so should present nothing to walk through
 * until its owner places one. Idempotent, and deliberately refuses to run over
 * a room that already has doors so it can never be a wipe.
 */
export function seedDoorLayoutEmpty(): void {
  if (!docAlive() || doorLayoutDocSize() > 0) return;
  markDoorSetAuthoritative();
}

/** Cheap membership test — no snapshot, no allocation. Some callers ask this
 *  per door per FRAME (the first-person auto-door pass reaches it through
 *  canPass → readDoorPolicy), so they must not build a whole Map to find out. */
export function hasDoorLayout(id: string): boolean {
  return docAlive() && doorLayoutMap!.has(id);
}

/** Publish one door's membership (add / move — slice 5+). Owner-only in practice. */
export function writeDoorLayout(rec: DoorLayoutRecord): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorLayoutMap!.set(rec.id, rec);
  });
}

/**
 * 🪧 Set (or clear, with undefined) ONE door's sign, touching nothing else.
 *
 * Deliberately not `writeDoorLayout({ ...readAllDoorLayout().get(id), label })`
 * (PR #103 review): `readAllDoorLayout` is a READ-NORMALIZER — it forces
 * size:'large', rounds `lateral`, and runs the compat shim that substitutes a
 * cardinal's physical wall. Round-tripping a record through it to change a
 * label would write all of that back as though the owner had edited the door's
 * POSITION. It happens to be idempotent today, but "renaming a sign rewrites
 * the door's geometry fields" is a bug waiting for its first non-idempotent
 * normalization. Read the RAW stored entry and set one key instead.
 */
export function writeDoorLabel(id: string, label: string | undefined): void {
  if (!docAlive()) return;
  const raw = doorLayoutMap!.get(id);
  if (!isDoorLayoutRecord(raw) || raw.id !== id) return; // door gone / malformed
  const clean = sanitizeDoorLabel(label);
  if (clean === raw.label) return; // no-op — do not churn the doc or peers
  const next: DoorLayoutRecord = { ...raw };
  if (clean) next.label = clean;
  else delete next.label;
  boundDoc!.transact(() => {
    doorLayoutMap!.set(id, next);
  });
}

/** Remove one door from the shared set (slice 6 editor). */
export function deleteDoorLayout(id: string): void {
  if (!docAlive()) return;
  boundDoc!.transact(() => {
    doorLayoutMap!.delete(id);
  });
}

/**
 * Owner-only seed: on the first claim of a room, publish the current cardinal
 * door set so joiners converge to it. Idempotent — a no-op once the map has any
 * entry, so re-entering an already-seeded room never clobbers live edits.
 *
 * 🚪 #91 QUAD-ADD FIX: seed only the cardinals that ACTUALLY EXIST right now
 * (`findDoor` non-null). This function is the SEED-FIRST partner of every
 * editor write, so it used to fire in rooms showing fewer than four doors and
 * publish all four anyway — the reconcile then materialized up to four extra
 * doors alongside the one the owner was placing ("adding a door adds 4 doors").
 * Publishing exactly the visible set makes the seed a visual no-op, which is
 * what seed-first always meant. `enabled` snapshots live door state (north sits
 * behind the hearth) — no force-true fallback, so a door can never come back
 * walkable that was not.
 */
/**
 * 🛰️🚪 A freshly provisioned MODULE is born with exactly ONE door — the one
 * leading back to the room it was added from — centred on its wall (owner
 * ruling). Shares seedDoorLayoutDefaults' idempotency contract: a no-op once
 * the map has any entry, so it can never fight a live edit.
 *
 * `wall` must be one of the room's OCTAGON-cross-section walls (west/east on a
 * square room — see hullSection.narrowAxisFor); the caller picks it. The record
 * uses lateral 0 so the door sits dead-centre, which requires the room to run
 * the "legacy" door layout — the paired layouts park a cardinal ±PAIR_OFFSET
 * off-centre. main.ts stamps that on the module at claim time.
 */
export function seedDoorLayoutSingle(
  wall: DoorWall,
  lateral = 0,
  // 🧭 The door's ID, minted at PROVISION time (a d: uuid) so the near room's
  // pairing can name the exact far door from birth. Defaulting to the wall
  // label is what put ids like 'x-' on the wire after the axis rename — legal
  // keys now, but new doors get honest opaque ids.
  id: string = wall,
): void {
  if (!docAlive() || doorLayoutDocSize() > 0) return;
  boundDoc!.transact(() => {
    // 🚪 One transaction: the marker and the door land together, so no joiner
    // can see an authoritative-but-empty room that is really a one-door module.
    doorLayoutMap!.set(META_KEY, { v: 1 });
    doorLayoutMap!.set(id, {
      id,
      wall,
      // 🧭 The owner PICKED this spot in the provision placement editor —
      // it is no longer always the wall centre.
      lateral: Math.round(lateral),
      size: 'large',
      enabled: true,
      // 🚪 `placed`: this door means what it says — centred on `wall`. It used
      // to need the room stamped "legacy" for that to hold (the paired kinds
      // would have parked it ±PAIR_OFFSET off-centre, and for id 'south' on a
      // different wall entirely); main.ts did that stamping at claim time.
      // Being authoritative, it no longer cares what the room was authored as.
      placed: true,
    });
  });
}

/**
 * 🧭 Seed a NEWBORN room: one door per wall, CENTRED. Only for rooms with no
 * visual history (the caller proves it — e.g. minted this session), because a
 * room that has ever RENDERED the un-migrated defaults must be seeded at the
 * slots it physically shows (seedDoorLayoutDefaults below) or its doors jump.
 * This is what retires the paired arrangement for every room created from now
 * on — and with it the 3–4 m of drag travel every cardinal door lost to the
 * two-stores intersection, and (for new rooms) the arrival resolver's
 * id-opposite last resort: a centred set always has a facing-wall door.
 */
export function seedDoorLayoutCentred(): void {
  if (!docAlive() || doorLayoutDocSize() > 0) return;
  boundDoc!.transact(() => {
    doorLayoutMap!.set(META_KEY, { v: 1 });
    for (const [id, wall] of Object.entries(LEGACY_ID_WALL)) {
      doorLayoutMap!.set(id, {
        id,
        wall,
        lateral: 0,
        size: 'large',
        enabled: true,
        placed: true,
      });
    }
  });
}

export function seedDoorLayoutDefaults(): void {
  if (!docAlive()) return;
  if (doorLayoutDocSize() > 0) {
    // Already has doors, so there is nothing to seed — but STAMP it. A room
    // seeded before the marker existed holds records and no marker, and
    // without this its owner could delete every door and have four spring
    // back, because empty-and-unmarked still reads as un-migrated. Every door
    // edit runs seed-first, so this upgrades a room the first time anyone
    // touches its doors.
    markDoorSetAuthoritative();
    return;
  }
  boundDoc!.transact(() => {
    doorLayoutMap!.set(META_KEY, { v: 1 }); // same transaction as the records
    for (const id of Object.keys(LEGACY_ID_WALL)) {
      const door = findDoor(id);
      if (!door) continue;
      // 🚪 Seed each door at the slot it PHYSICALLY occupies right now, so the
      // room being seeded does not move a single door — then flag it
      // authoritative so the compat shim leaves it alone forever after.
      const slot = migratedCardinalSlot(id);
      doorLayoutMap!.set(id, {
        id,
        wall: slot.wall,
        lateral: slot.lateral,
        size: 'large',
        enabled: door.enabled,
        placed: true,
      });
    }
  });
}
