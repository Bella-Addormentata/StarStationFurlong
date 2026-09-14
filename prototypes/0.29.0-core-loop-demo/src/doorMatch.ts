/**
 * 🚪🧲 Door matching — which door of an EXISTING module a connection lands on,
 * and which door a traveler comes IN through. Pure geometry + records, no DOM,
 * no Three: docking.ts (the CONNECT prompt) and world.ts (the arrival) both
 * call in here, and the octagon-closing cases are pinned by doorMatch.test.ts.
 *
 * Owner report (2026-09-14, v0.35.1): closing the octagon, the final vestibule
 * connected to the WRONG SIDE of the first room, which left two vestibules —
 * to two different rooms — on ONE door. Two defects, both here:
 *
 *   1. The matcher chose the far door by facing ANGLE alone, among four
 *      wall-centre hypotheticals it always offered — including a wall whose
 *      real door was already paired. Seven ring hops of composed layout carry
 *      enough angular error that the occupied adjacent wall can win. It now
 *      scores by POSITION of the door face against the chain's end (walls are
 *      metres apart; angle is the tie-break), and an OCCUPIED door is never a
 *      candidate: not the far room's own paired doors, not a door some other
 *      room's record already lands on, and no hypothetical on a wall centre a
 *      known door already sits near.
 *   2. The arrival trusted the record's `farDoor` by ID. For a hypothetical
 *      that id is a compass word, and the far room may hang that id on a
 *      different wall — so the traveler arrived at, and the exterior drew the
 *      tube into, whatever door happened to carry the name, paired or not. The
 *      arrival now prefers the record's WALL (+ lateral), and never resolves
 *      onto a door that is paired to a DIFFERENT room while a free door exists.
 *
 * ONE VESTIBULE PER DOOR is the invariant both halves enforce: a door already
 * connected to somewhere else is not a target for a new connection, on either
 * end, in the prompt, at INITIATE, and at arrival.
 */
import type { DoorWall } from './doorLayoutDoc';
import { LEGACY_ID_WALL } from './doorLayoutDoc';
import { MIN_DOOR_GAP } from './doorLayout';

/** Outward yaw of each wall in module-local frame — poseFromWall's values.
 *  Heading convention throughout: a yaw θ points along (sin θ, cos θ). */
export const WALL_YAW: Record<DoorWall, number> = {
  'y+': 0,
  'x+': Math.PI / 2,
  'y-': Math.PI,
  'x-': -Math.PI / 2,
};

/** The wall physically facing a wall — same axis, opposite sign. */
export function oppositeWallOf(wall: DoorWall): DoorWall {
  return wall === 'y-' ? 'y+' : wall === 'y+' ? 'y-' : wall === 'x+' ? 'x-' : 'x+';
}

/** Unsigned angular distance in radians, in [0, π]. */
export function angDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

/** Hypothetical wall-centre door ids — the compass names, the only ids a
 *  connection can carry for a door it has never seen (LEGACY_ID_WALL inverted). */
const WALL_LEGACY_ID: Record<DoorWall, string> = (() => {
  const out = {} as Record<DoorWall, string>;
  for (const [id, wall] of Object.entries(LEGACY_ID_WALL)) out[wall] = id;
  return out;
})();

/** Default module half-extent (a 2×2-tile room: walls at ±6) — used when a
 *  module's true size is not known. */
export const MODULE_FACE_HALF = 6;

/** A module's half-extents from its gossiped tile dims — TILE_SIZE / 2 per
 *  tile, the same mapping exteriorView renders neighbours with (cols → x,
 *  rows → z; unknown ⇒ the default 2×2). A 5×5 module's faces are at ±15, and
 *  a matcher that assumed ±6 could neither reach nor aim at them (review,
 *  round 7). */
export function moduleHalves(dims?: { cols: number; rows: number }): { halfX: number; halfZ: number } {
  return { halfX: (dims?.cols ?? 2) * 3, halfZ: (dims?.rows ?? 2) * 3 };
}

export interface ModulePose {
  x: number;
  z: number;
  rotY: number;
  /** Half-extents along the module's own x / z; absent ⇒ MODULE_FACE_HALF. */
  halfX?: number;
  halfZ?: number;
}

/** A door of the far module as the matcher sees it. `occupied` = a vestibule
 *  already lands on it (its own pairing, or another room's record naming it);
 *  `hypothetical` = a wall-centre guess, no door known there yet. */
export interface FarDoorCandidate {
  id: string;
  wall: DoorWall;
  lateral: number;
  occupied?: boolean;
  hypothetical?: boolean;
}

/** Where the chain ENDS, in the same frame as `ModulePose`: the exit point of
 *  the last connector (the door face it must meet) and the heading INTO the
 *  module there. */
export interface ChainArrival {
  x: number;
  z: number;
  heading: number;
}

/** A door face in world frame: centre point + the wall's outward yaw. Same
 *  rotation convention atlasLayout composes with. */
export function doorFaceWorld(
  mod: ModulePose,
  wall: DoorWall,
  lateral: number,
): { x: number; z: number; outwardYaw: number } {
  const hx = mod.halfX ?? MODULE_FACE_HALF;
  const hz = mod.halfZ ?? MODULE_FACE_HALF;
  const local =
    wall === 'y-' ? { x: lateral, z: -hz }
    : wall === 'y+' ? { x: lateral, z: hz }
    : wall === 'x+' ? { x: hx, z: lateral }
    : { x: -hx, z: lateral };
  const c = Math.cos(mod.rotY), s = Math.sin(mod.rotY);
  return {
    x: mod.x + local.x * c + local.z * s,
    z: mod.z - local.x * s + local.z * c,
    outwardYaw: mod.rotY + WALL_YAW[wall],
  };
}

/**
 * The candidate set for a module: every KNOWN door (occupied ones kept, and
 * flagged, so they can block), plus a wall-centre hypothetical for each wall
 * where no known door sits within MIN_DOOR_GAP of the centre — a hypothetical
 * is a promise that a door can be grown there, and the editor would refuse one
 * that close to an existing door. A known door without geometry contributes
 * nothing (we cannot place it), which is the pre-existing behaviour.
 */
export function candidateFarDoors(
  known: Array<{ id: string; wall?: DoorWall; lateral?: number; occupied: boolean }>,
  opts?: { minGap?: number },
): FarDoorCandidate[] {
  const minGap = opts?.minGap ?? MIN_DOOR_GAP;
  const out: FarDoorCandidate[] = [];
  const seen = new Set<string>();
  for (const k of known) {
    if (!k.wall || seen.has(k.id)) continue;
    seen.add(k.id);
    out.push({ id: k.id, wall: k.wall, lateral: k.lateral ?? 0, occupied: k.occupied });
  }
  for (const wall of Object.keys(WALL_YAW) as DoorWall[]) {
    const crowded = out.some((d) => d.wall === wall && Math.abs(d.lateral) < minGap);
    if (crowded) continue;
    const id = WALL_LEGACY_ID[wall];
    // A known door may already carry the compass id (a cardinal berth living
    // off its legacy wall); the hypothetical then needs a distinct key — in a
    // shape the pairing wire ACCEPTS. The pick's id is published as the
    // record's farDoor, and doorsDoc.isAcceptableDoorKey admits only cardinal,
    // axis and `d:` ids; anything else is silently stripped on the next read
    // (review F2). The arrival never needs this id to EXIST: it prefers the
    // record's wall, and a miss on the id falls through to that tier.
    out.push({ id: seen.has(id) ? `d:${id}-centre` : id, wall, lateral: 0, hypothetical: true });
  }
  return out;
}

export interface FacingDoorPick {
  door: FarDoorCandidate;
  /** Metres between the chain's end and the door face. */
  posErr: number;
  /** Radians between the chain's heading and straight-into-the-door. */
  angErr: number;
  /** An OCCUPIED door that fit better than the pick — the UI can say so. */
  blockedBetter?: FarDoorCandidate;
}

/**
 * Pick the door of `mod` a chain ending at `arrival` connects to: the free
 * candidate whose face is nearest the chain's end, provided the chain points
 * roughly into it. Position first (adjacent walls of a module are metres
 * apart, so a few tens of degrees of accumulated layout error cannot flip the
 * choice the way the old angle-only test could); angle breaks near-ties and
 * fences off doors the chain would enter sideways. Occupied doors never win;
 * if one would have, it is reported so the prompt can explain the refusal.
 */
export function pickFacingDoor(
  mod: ModulePose,
  candidates: FarDoorCandidate[],
  arrival: ChainArrival,
  opts?: { maxPosErr?: number; maxAngErr?: number },
): FacingDoorPick | null {
  const maxPos = opts?.maxPosErr ?? 4.5; // the module match radius
  const maxAng = opts?.maxAngErr ?? Math.PI / 3;
  // Metres per radian for the tie-break: a full maxAng costs ~2 m.
  const ANG_WEIGHT = 2 / maxAng;
  const into = arrival.heading + Math.PI; // the face we enter points back at us
  let best: FacingDoorPick | null = null;
  let bestScore = Infinity;
  let blocked: { door: FarDoorCandidate; score: number } | null = null;
  for (const d of candidates) {
    const face = doorFaceWorld(mod, d.wall, d.lateral);
    const posErr = Math.hypot(face.x - arrival.x, face.z - arrival.z);
    const angErr = angDiff(face.outwardYaw, into);
    if (posErr > maxPos || angErr > maxAng) continue;
    const score = posErr + angErr * ANG_WEIGHT;
    if (d.occupied) {
      if (!blocked || score < blocked.score) blocked = { door: d, score };
      continue;
    }
    if (score < bestScore) {
      bestScore = score;
      best = { door: d, posErr, angErr };
    }
  }
  if (best && blocked && blocked.score < bestScore) best.blockedBetter = blocked.door;
  return best;
}

// ── Arrival ──────────────────────────────────────────────────────────────────

/** One door of the ARRIVAL room, as the chooser needs it. `pairedTo` is the
 *  room id its own pairing record points at (null = unpaired/tombstone). */
export interface ArrivalDoor {
  id: string;
  wall: DoorWall;
  lateral: number;
  enabled: boolean;
  cardinal: boolean;
  pairedTo: string | null;
  /** The pairing record's description of ITS far door — for a back record,
   *  that is a door of the room the traveler just left, which is how one
   *  back record is told apart from another link to the same room. */
  pairedFarDoor?: string;
  pairedFarWall?: DoorWall;
  pairedFarLateral?: number;
}

export interface ArrivalIntent {
  departureDoorId: string;
  /** The wall the traveler departed through (captured before the swap). */
  departureWall?: DoorWall;
  /** …and where along it — the departure door's own lateral. */
  departureLateral?: number;
  /** The room we came from — the arrival room's own back-pointing record. */
  fromRoomId?: string;
  /** The departure record's far-side description of THIS room's door. */
  farDoor?: string;
  farWall?: DoorWall;
  farLateral?: number;
}

export interface ArrivalPick {
  id: string;
  /** Which rule chose it — for logs and tests. */
  tier: 'back' | 'far-wall' | 'far-door' | 'facing-wall' | 'id-opposite' | 'fallback';
  /** True only when NO free door existed and the pick is paired elsewhere —
   *  the last-resort legacy behaviour, surfaced so callers can warn. */
  conflict: boolean;
}

const ID_OPPOSITE: Record<string, string> = {
  north: 'south', south: 'north', east: 'west', west: 'east',
};

/**
 * The door a traveler comes in through. Tiers, first hit wins:
 *
 *   back        the arrival room's own record pointing back at the room we
 *               came from — the highest truth (owner's octagon findings); ties
 *               (same room docked twice) break on farDoor, then the facing wall.
 *   far-wall    the record's WALL: a free door on it, the named farDoor if it
 *               sits there, else the one nearest the record's lateral.
 *   far-door    the record's farDoor by id — only when free, and only when the
 *               record names no wall or the id's wall agrees (a compass id from
 *               a hypothetical is a guess about a name, the wall is the truth).
 *   facing-wall a free door on the wall opposite the departure wall.
 *   id-opposite the cardinal id-opposite of the departure door (fireplace-
 *               blocked departures under the pairs layouts).
 *   fallback    east, then any enabled door — FREE ones first; a door paired
 *               to another room is chosen only when nothing else exists, and
 *               the pick says so (`conflict`).
 *
 * "Free" = enabled and not paired to a room OTHER than the one we came from.
 * With an unknown origin every paired door counts as free (nothing to compare
 * against), which is exactly the pre-existing behaviour.
 */
export function chooseArrivalDoor(doors: ArrivalDoor[], intent: ArrivalIntent): ArrivalPick | null {
  const { fromRoomId, farDoor, farWall, departureWall } = intent;
  const occupiedByOther = (d: ArrivalDoor): boolean =>
    d.pairedTo !== null && fromRoomId !== undefined && d.pairedTo !== fromRoomId;
  const free = (d: ArrivalDoor): boolean => d.enabled && !occupiedByOther(d);
  // Deterministic preference within a tier: cardinals first (never map order).
  const rank = (a: ArrivalDoor, b: ArrivalDoor): number =>
    Number(b.cardinal) - Number(a.cardinal);
  const facingWall = departureWall ? oppositeWallOf(departureWall) : undefined;

  if (fromRoomId) {
    const backs = doors.filter((d) => d.enabled && d.pairedTo === fromRoomId);
    // A back record identifies the ORIGIN ROOM, not this particular link: two
    // rooms may be linked more than once, and a further link's mirror is not
    // written until its first walk-through. Each back record is therefore
    // tested for being THIS link before it is trusted (review, rounds 3, 6, 7):
    //   · its counterpart geometry — the record's own farWall / farLateral
    //     describe OUR departure door, which was captured exactly before the
    //     swap; a different wall, or the same wall MIN_DOOR_GAP or more away,
    //     is a different door of ours;
    //   · its counterpart id, only when BOTH ids are minted `d:` names — a
    //     compass name may be a hypothetical's guess for either door;
    //   · our own record's description of the far door — its wall, then its
    //     lateral (two doors on one wall are MIN_DOOR_GAP apart or more).
    // A legacy record carrying none of that offers no evidence against, and
    // is trusted exactly as before.
    const isThisLink = (b: ArrivalDoor): boolean => {
      if (b.pairedFarWall && departureWall && b.pairedFarWall !== departureWall) return false;
      if (
        b.pairedFarWall && departureWall && b.pairedFarWall === departureWall
        && b.pairedFarLateral !== undefined && intent.departureLateral !== undefined
        && Math.abs(b.pairedFarLateral - intent.departureLateral) >= MIN_DOOR_GAP
      ) return false;
      if (
        b.pairedFarDoor && b.pairedFarDoor.startsWith('d:')
        && intent.departureDoorId.startsWith('d:') && b.pairedFarDoor !== intent.departureDoorId
      ) return false;
      if (farWall && b.wall !== farWall) return false;
      if (farWall && intent.farLateral !== undefined
        && Math.abs(b.lateral - intent.farLateral) >= MIN_DOOR_GAP) return false;
      return true;
    };
    const want = intent.farLateral ?? 0;
    const byLateral = (a: ArrivalDoor, b: ArrivalDoor): number =>
      Math.abs(a.lateral - want) - Math.abs(b.lateral - want) || rank(a, b);
    // Truly unpaired — a further link's door cannot be another link's back door.
    const unpaired = (d: ArrivalDoor): boolean => d.enabled && d.pairedTo === null;

    const mine = backs.filter(isThisLink);
    if (mine.length === 1) return { id: mine[0].id, tier: 'back', conflict: false };
    if (mine.length > 1) {
      // Several back records could each be this link (legacy records without
      // geometry): nearest to the record's lateral on its wall, then the id
      // where its wall agrees, then the facing wall, then a stable first —
      // never map order.
      const onFarWall = farWall ? mine.filter((b) => b.wall === farWall).sort(byLateral) : [];
      const named = farDoor
        ? mine.find((b) => b.id === farDoor && (!farWall || b.wall === farWall))
        : undefined;
      const facing = facingWall ? mine.find((b) => b.wall === facingWall) : undefined;
      return { id: (onFarWall[0] ?? named ?? facing ?? mine[0]).id, tier: 'back', conflict: false };
    }
    if (backs.length > 0) {
      // Back records exist but none is this link — a further link between the
      // same rooms, mirror not yet written. Its door is an UNPAIRED one on the
      // wall our record names; failing that, a back record still answers (the
      // pre-existing behaviour, and never a door paired to a third room).
      if (farWall) {
        const openOnWall = doors.filter((d) => unpaired(d) && d.wall === farWall).sort(byLateral);
        if (openOnWall.length > 0) return { id: openOnWall[0].id, tier: 'far-wall', conflict: false };
      }
      const named = farDoor ? backs.find((b) => b.id === farDoor) : undefined;
      const facing = facingWall ? backs.find((b) => b.wall === facingWall) : undefined;
      return { id: (named ?? facing ?? backs[0]).id, tier: 'back', conflict: false };
    }
  }

  if (farWall) {
    const onWall = doors.filter((d) => free(d) && d.wall === farWall);
    if (onWall.length > 0) {
      const named = farDoor ? onWall.find((d) => d.id === farDoor) : undefined;
      if (named) return { id: named.id, tier: 'far-wall', conflict: false };
      const want = intent.farLateral ?? 0;
      const nearest = [...onWall].sort(
        (a, b) => Math.abs(a.lateral - want) - Math.abs(b.lateral - want) || rank(a, b),
      )[0];
      return { id: nearest.id, tier: 'far-wall', conflict: false };
    }
  }

  if (farDoor) {
    const d = doors.find((x) => x.id === farDoor);
    if (d && free(d) && (!farWall || d.wall === farWall))
      return { id: d.id, tier: 'far-door', conflict: false };
  }

  if (facingWall) {
    const onWall = doors.filter((d) => free(d) && d.wall === facingWall).sort(rank);
    if (onWall.length > 0) return { id: onWall[0].id, tier: 'facing-wall', conflict: false };
  }

  const opp = ID_OPPOSITE[intent.departureDoorId];
  if (opp) {
    const d = doors.find((x) => x.id === opp);
    if (d && free(d)) return { id: d.id, tier: 'id-opposite', conflict: false };
  }

  const east = doors.find((d) => d.id === 'east');
  if (east && free(east)) return { id: east.id, tier: 'fallback', conflict: false };
  const anyFree = doors.filter(free).sort(rank)[0];
  if (anyFree) return { id: anyFree.id, tier: 'fallback', conflict: false };
  // Nothing free: the legacy ladder, flagged.
  const legacy =
    (east?.enabled ? east : undefined) ?? doors.find((d) => d.enabled) ?? doors[0];
  return legacy ? { id: legacy.id, tier: 'fallback', conflict: true } : null;
}
