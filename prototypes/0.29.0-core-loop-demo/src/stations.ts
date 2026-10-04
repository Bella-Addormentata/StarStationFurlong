/**
 * 🪐 Stations — which planet each station orbits, and in which slot.
 *
 * A station is still not stored as a thing of its own: it is the set of rooms
 * joined by door pairings (stationAtlas.atlasComponents). This module puts a
 * small RECORD on top of each such set — id, name, planet, orbit slot and the
 * welcome (berth) room a ship docks at — so the holotable, the exterior view
 * and, later, ship destinations can all ask the same question: "what stations
 * orbit this planet, and which one am I in?"
 *
 * Where a record comes from, first match wins:
 *   1. The BUILT-IN default station (defaultStation.ts): 'furlong-station',
 *      orbiting Planet Sovereign in slot 0. Its id is the one the solar map
 *      has always used, so nothing that already names it changes.
 *   2. RECORDS saved on this install (localStorage 'ssf-stations', written by
 *      registerStation — the devtools hook in main.ts). A record claims the
 *      atlas component that holds its welcome room.
 *   3. DERIVED — every other atlas component becomes a station orbiting the
 *      default planet, named after its anchor room. The anchor is the
 *      component's smallest room id, so every client holding the same atlas
 *      derives the same id and slot. A derived id changes if two components
 *      are later joined by a pairing; save a record to pin one.
 *
 * Saved records are per-install for now, like the local atlas they sit on.
 * Carrying them in the room doc (so every visitor agrees on a station's
 * planet) is the natural next step once ship travel needs it.
 */

import { atlasComponent, atlasComponents, isBerthDoor, readAtlas, roomIdFromSeed, stationGates } from './stationAtlas';
import type { AtlasEntry } from './stationAtlas';
import { DEFAULT_STATION } from './defaultStation';
import { MIN_ALTITUDE_KM, isUsableOrbit, maxAltitudeKm, orbitForSlot } from './orbits';
import { isAcceptableDoorKey } from './doorsDoc';
import type { DoorRecord } from './doorsDoc';

export interface PlanetRecord {
  /** Matches the solar map's planet body id (map.ts). */
  id: string;
  name: string;
  /** Exterior-view backdrop colours (exteriorView.ts). */
  color: number;
  emissive: number;
  atmosphere: number;
  /** Surface radius, km — orbits.ts measures altitude from it. */
  radiusKm: number;
  /** Gravitational parameter GM, km³/s² — sets every orbit's period. */
  mu: number;
}

export const PLANETS: readonly PlanetRecord[] = [
  // Earth-sized terra world: a 400 km orbit takes ~92 orbital minutes.
  { id: 'planet-sovereign', name: 'SOVEREIGN II', color: 0x2a5a8f, emissive: 0x0c2038, atmosphere: 0x7fb8ff, radiusKm: 6371, mu: 398600.4418 },
  // Smaller, dense lava world.
  { id: 'planet-aris', name: 'ARIS PRIME', color: 0x8a3a1c, emissive: 0x3a0e04, atmosphere: 0xff9a66, radiusKm: 4800, mu: 250000 },
];

export const DEFAULT_PLANET_ID = 'planet-sovereign';

export function planetById(id: string | undefined): PlanetRecord {
  return PLANETS.find((p) => p.id === id) ?? PLANETS.find((p) => p.id === DEFAULT_PLANET_ID)!;
}

export interface StationRecord {
  id: string;
  name: string;
  /** A PLANETS id; unknown ids read as the default planet. */
  planetId: string;
  /** 0-based slot around the planet — unique per planet in listStations. It
   *  fixes the station's circular orbit (orbits.ts): slot 0 is 400 km up and
   *  each slot is a quarter farther from the planet's centre. */
  orbitSlot: number;
  /** The room a docking ship berths at. '' when unknown (a build shipping no
   *  default station). */
  welcomeRoomId: string;
  /** Optional door id of the berth port in the welcome room — a door key
   *  doorsDoc accepts (a record naming any other could never be docked at). */
  berthDoor?: string;
  /** ⚓🚦 Every gate an arriving ship may dock at, in gate order. listStations
   *  fills it from the station atlas (every dock port of the station, with its
   *  gate number); a record keeps a list it learned (a station whose rooms
   *  this install has not mapped), and a plain `berthDoor` reads as one
   *  berth; an empty list means known to have none. `berthDoor` stays for older builds: listStations sets it to the
   *  lowest gate in the welcome room when the record names none. */
  berths?: StationBerthRecord[];
  /** Set on stations derived from an atlas component with no record. */
  derived?: true;
  /** A move to another planet that is scheduled or under way (stationMove.ts).
   *  listStations fills it from the move resolver; once the move arrives the
   *  station is listed at its new planet and slot, and this is gone. */
  move?: StationMove;
  /** 🎚️ The orbit an ALTITUDE change left the station in, when it flies one
   *  other than its slot's (stationMove.ts, mode 'orbit'). listStations fills
   *  it from the station's latest move; never saved, as the move is what is
   *  shared. orbits.stationOrbit flies it in place of the slot's orbit, and
   *  the slot stays the station's place in the list. */
  orbit?: StationOrbit;
}

/** 🎚️ A station's own circular orbit around its planet, set by an altitude
 *  change: its radius from the planet's centre (km) and its angle at the
 *  orbital epoch (radians), the two numbers orbits.circularOrbit needs. */
export interface StationOrbit {
  radiusKm: number;
  phase0: number;
}

/** 🎚️ The orbits an altitude change connects (a StationMove with mode
 *  'orbit'): where the station left from, the trimmed orbit it flew when the
 *  helm booked it, and the one it settles into, half a transfer ellipse
 *  later. Both are kept whole, so anyone can draw the transfer from the
 *  record alone. */
export interface OrbitChange {
  fromRadiusKm: number;
  fromPhase0: number;
  toRadiusKm: number;
  toPhase0: number;
  /** When the custom orbit it leaves was claimed (orbitClaimedAt), so a
   *  change that loses still holds the orbit its station stays on, for
   *  installs that never saw the move before it; absent: the slot's own. */
  fromSince?: number;
  /** The base orbit it leaves (the station's StationRecord.orbit, or its
   *  slot's) when station keeping had trimmed it off that: the claim it
   *  holds and the orbit it stays on if aborted, the trim riding on top.
   *  Absent: the from orbit is the base. */
  fromBase?: StationOrbit;
}

/** 🎚️ The base orbit an altitude change leaves (OrbitChange.fromBase). */
export function orbitChangeBase(o: OrbitChange): StationOrbit {
  return o.fromBase ? { radiusKm: o.fromBase.radiusKm, phase0: o.fromBase.phase0 } : { radiusKm: o.fromRadiusKm, phase0: o.fromPhase0 };
}

/** ⚓🚦 One gate of a station: a dock port an arriving ship may berth at. */
export interface StationBerthRecord {
  roomId: string;
  doorId: string;
  /** The port's gate number (doorPolicy); absent for a berth that has none
   *  (a record's plain berthDoor, a port fitted before gates existed). */
  gate?: number;
  /** The atlas shows a ship docked there. Local knowledge: never stored or
   *  shared, only listed. */
  occupied?: boolean;
  /** Who the station lets dock there, when not every ship (doorPolicy
   *  gateAccess): pass holders, one reserved ship's room, or none. */
  access?: 'pass' | 'reserved' | 'closed';
  reservedFor?: string;
}

/** Gates a station lists at most: one per gate number. */
export const MAX_BERTHS = 99;

/** One berth, shape-checked (peer-written when it came through a summary),
 *  without the local `occupied` flag. Null when it is not one. */
export function cleanBerth(v: unknown): StationBerthRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as Record<string, unknown>;
  if (typeof b.roomId !== 'string' || !b.roomId || b.roomId.length > MAX_ID_LENGTH) return null;
  // Never '__proto__': each room's gates are stamped under its id in a plain
  // object (planetSummary's berthRoomsAt), which cannot hold that key.
  if (b.roomId === '__proto__') return null;
  if (typeof b.doorId !== 'string' || !isAcceptableDoorKey(b.doorId)) return null;
  const out: StationBerthRecord = { roomId: b.roomId, doorId: b.doorId };
  if (typeof b.gate === 'number' && Number.isInteger(b.gate) && b.gate >= 1 && b.gate <= 99) out.gate = b.gate;
  // Access that cannot be read closes the gate (as doorPolicy reads a port's):
  // only none, or an explicit 'open', leaves it open.
  if (b.access === undefined || b.access === 'open') return out;
  if (b.access === 'pass' || b.access === 'closed') out.access = b.access;
  else if (b.access === 'reserved' && typeof b.reservedFor === 'string'
    && b.reservedFor.length > 0 && b.reservedFor.length <= MAX_ID_LENGTH) {
    out.access = 'reserved';
    out.reservedFor = b.reservedFor;
  } else out.access = 'closed';
  return out;
}

const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Berths in gate order (unnumbered last), then by room and door, so
 *  arrivals try the lowest gate first. */
function berthOrder(x: StationBerthRecord, y: StationBerthRecord): number {
  return (x.gate ?? Infinity) - (y.gate ?? Infinity)
    || textOrder(x.roomId, y.roomId) || textOrder(x.doorId, y.doorId);
}

/** Which of two copies of one port stands (negative: `x`): the strictest
 *  access, whatever numbers the copies carry, so a list stays fail-closed
 *  as cleanBerth reads it; then the lower gate, then the ship reserved. */
function copyOrder(x: StationBerthRecord, y: StationBerthRecord): number {
  const strictness = (b: StationBerthRecord) =>
    b.access === 'closed' ? 0 : b.access === 'reserved' ? 1 : b.access === 'pass' ? 2 : 3;
  return strictness(x) - strictness(y)
    || (x.gate ?? Infinity) - (y.gate ?? Infinity)
    || textOrder(x.reservedFor ?? '', y.reservedFor ?? '');
}

/** A list of berths, cleaned, deduplicated by port and capped. */
export function cleanBerths(v: unknown): StationBerthRecord[] {
  // A longer list than any station lists is junk, not a prefix to trust:
  // duplicates could otherwise push a real gate past the cut.
  if (!Array.isArray(v) || v.length > MAX_BERTHS * 4) return [];
  // One copy per port (copyOrder), then one canonical order before any port
  // is cut, so the same berths in any order keep the same ports: a merge of
  // two lists taken either way round (planetSummary newerBerths) settles
  // alike on every install.
  const byPort = new Map<string, StationBerthRecord>();
  for (const item of v) {
    const b = cleanBerth(item);
    if (!b) continue;
    const key = `${b.roomId}\u0000${b.doorId}`;
    const held = byPort.get(key);
    if (!held || copyOrder(b, held) < 0) byPort.set(key, b);
  }
  return capBerths([...byPort.values()].sort(berthOrder));
}

/** At most MAX_BERTHS of `sorted`, in its order: one slot per gate number
 *  first (as cleanGates), so ports repeating a number, or with none, only
 *  fill what is left and cannot crowd a gate out. */
function capBerths(sorted: readonly StationBerthRecord[]): StationBerthRecord[] {
  if (sorted.length <= MAX_BERTHS) return [...sorted];
  const numbers = new Set<number>();
  const keep = sorted.map(() => false);
  let kept = 0;
  sorted.forEach((b, i) => {
    if (kept < MAX_BERTHS && b.gate !== undefined && !numbers.has(b.gate)) { numbers.add(b.gate); keep[i] = true; kept++; }
  });
  for (let i = 0; i < sorted.length && kept < MAX_BERTHS; i++) if (!keep[i]) { keep[i] = true; kept++; }
  return sorted.filter((_, i) => keep[i]);
}

/**
 * 🚚 A station's move to another planet (stationMove.ts): the station, where
 * it leaves from and goes to, and the two burns' real times. Plain JSON, so
 * whatever shares station records can carry it as it is.
 */
export interface StationMove {
  /** The writer's id for the station — per install, so informational. */
  stationId: string;
  /** The station's welcome room: the same on every install, so this is what
   *  a move is matched to a station by ('' only for a station without one,
   *  then the id is used). */
  welcomeRoomId: string;
  fromPlanetId: string;
  fromSlot: number;
  toPlanetId: string;
  /** The slot it asked for there; listStations still resolves a clash. */
  toSlot: number;
  /** Real ms of the departure burn — a launch window. */
  departAt: number;
  /** Real ms of the capture burn at the new planet. */
  arriveAt: number;
  /** Under its own thrusters (a Hohmann transfer at a launch window), or
   *  towed by a tug (a torch flight that leaves at once), or 🎚️ an ALTITUDE
   *  change around the same planet (a Hohmann transfer that leaves at once;
   *  same planet and slot at both ends, the orbits in `orbit`). */
  mode: 'thrusters' | 'tug' | 'orbit';
  /** 🎚️ On an altitude change: the two orbits it connects. */
  orbit?: OrbitChange;
  /** 🎚️ On any other move: the altitude orbit the station flew when it was
   *  booked, which it keeps until it leaves (and for good if the move is
   *  cancelled). Absent: its slot's orbit. `since`: when that orbit was
   *  claimed (orbitClaimedAt), which ranks it among altitude claims. */
  fromOrbit?: StationOrbit & { since?: number };
  /** The tug's room, on a tow. */
  tugRoomId?: string;
  /** Real ms the helm booked it (departAt on records from before). A move is
   *  only booked once the last has arrived, so two moves are concurrent
   *  exactly when each was booked before the other arrived. */
  bookedAt?: number;
  /** On a pin (stationMove.pinSettledArrival): the move it settles. The pin
   *  ranks as that move, just after it, so a pin of a move that lost to a
   *  concurrent one loses with it. */
  settles?: StationMove;
  /** Propellant the move burns. */
  fuel: number;
  /** The tank's draw meter after paying for it (shipDoc.setFuelDrawMeter). */
  fuelDrawn: number;
}

/** What a move resolver is asked about: a station's id and welcome room. */
export type MovingStation = Pick<StationRecord, 'id' | 'welcomeRoomId'>;

let moveResolver: ((station: MovingStation) => StationMove | null) | null = null;

/** Install (or remove, with null) where listStations finds each station's
 *  latest move (stationMove.installStationMoveResolver). */
export function setStationMoveResolver(resolver: ((station: MovingStation) => StationMove | null) | null): void {
  moveResolver = resolver;
}

/** Does a move belong to this station? By welcome room — the same on every
 *  install — and by id only for a station without one. */
export function moveBelongsTo(move: Pick<StationMove, 'stationId' | 'welcomeRoomId'>, station: MovingStation): boolean {
  return station.welcomeRoomId
    ? move.welcomeRoomId === station.welcomeRoomId
    : !move.welcomeRoomId && move.stationId === station.id;
}

/** A station's latest move, scheduled, under way or finished. */
export function latestMoveOf(station: MovingStation): StationMove | null {
  return moveOf(station);
}

function moveOf(station: MovingStation): StationMove | null {
  if (!moveResolver) return null;
  try {
    const m = moveResolver(station);
    return m && moveBelongsTo(m, station) ? m : null;
  } catch {
    return null;
  }
}

/** 🎚️ Is this move an altitude change — or a pin settling one? It keeps the
 *  station around its planet, in its slot, the whole way. */
export function isOrbitChange(move: Pick<StationMove, 'mode' | 'settles'> | null | undefined): boolean {
  return !!move && (move.settles ?? move).mode === 'orbit';
}

/** 🎚️ What an altitude claim is known by: the same on every install. */
export function altitudeMoveKey(m: StationMove): string {
  const held = (m.settles ?? m).fromOrbit;
  return JSON.stringify([m.welcomeRoomId || m.stationId, m.mode, m.departAt, m.arriveAt, m.bookedAt ?? null,
    m.settles ? m.settles.departAt : null, m.orbit?.toRadiusKm ?? null, held?.radiusKm ?? null]);
}

/** 🎚️ When the orbit a station flies (`orbit`, by its latest move) was
 *  claimed: the altitude change that took it there's booking, or what the
 *  move keeping it carries; 0 (before any) when unknown. */
export function orbitClaimedAt(move: StationMove | null | undefined, orbit: StationOrbit | undefined): number {
  if (!move || !orbit) return 0;
  const m = move.settles ?? move;
  const same = (r: number) => Math.abs(r - orbit.radiusKm) < 1e-6;
  if (m.mode === 'orbit' && m.orbit && same(m.orbit.toRadiusKm)) return m.bookedAt ?? m.departAt;
  if (m.mode === 'orbit' && m.orbit && same(orbitChangeBase(m.orbit).radiusKm)) return m.orbit.fromSince ?? 0;
  if (m.mode !== 'orbit' && m.fromOrbit && same(m.fromOrbit.radiusKm)) return m.fromOrbit.since ?? 0;
  return 0;
}

/** 🎚️ Moves listStations weighs altitude claims among beside each station's
 *  latest: every move this install knows (stationMove.ts installs it), so a
 *  claim still counts after its station has booked something since. */
let altitudeHistory: (() => StationMove[]) | null = null;

export function setAltitudeHistory(source: (() => StationMove[]) | null): void {
  altitudeHistory = source;
}

/** 🎚️ The station's altitude changes, not aborted, that were still to come
 *  or under way at `sinceMs` (a ship's cast-off) and have begun by `nowMs`,
 *  earliest first. They keep the planet and slot, so only the moves this
 *  install knows tell: a later move booked since can hide one from the
 *  latest. */
export function altitudeChangesSince(station: MovingStation, sinceMs: number, nowMs: number): StationMove[] {
  let history: StationMove[] = [];
  try { history = altitudeHistory?.() ?? []; } catch { history = []; }
  const latest = moveOf(station);
  const known = latest ? [latest, ...history] : history;
  const changes = known.filter((m) => moveBelongsTo(m, station) && m.mode === 'orbit' && !m.settles && !!m.orbit
    && m.arriveAt > sinceMs && m.departAt <= nowMs);
  if (changes.length === 0) return [];
  const lost = lostAltitudeClaims(known);
  return changes.filter((m) => !lost.has(altitudeMoveKey(m))).sort((a, b) => a.departAt - b.departAt);
}

/** 🎚️ Has the station begun an altitude change since `sinceMs`
 *  (altitudeChangesSince)? */
export function altitudeChangedSince(station: MovingStation, sinceMs: number, nowMs: number): boolean {
  if (altitudeChangesSince(station, sinceMs, nowMs).length > 0) return true;
  // A later move records when the orbit it leaves was claimed (fromOrbit /
  // orbit.fromSince): one claimed after cast-off was flown to since, even
  // where only that latest move is known (a planet summary carries no more).
  let history: StationMove[] = [];
  try { history = altitudeHistory?.() ?? []; } catch { history = []; }
  const latest = moveOf(station);
  const known = latest ? [latest, ...history] : history;
  const claimedSince = known.filter((m) => {
    if (!moveBelongsTo(m, station)) return false;
    const src = m.settles ?? m;
    const since = src.mode === 'orbit' ? src.orbit?.fromSince : src.fromOrbit?.since;
    return since !== undefined && since >= sinceMs && since <= nowMs;
  });
  if (claimedSince.length === 0) return false;
  // Unless that orbit lost its claim (the station never kept it).
  const lost = lostAltitudeClaims(known);
  return claimedSince.some((m) => !lost.has(m.mode === 'orbit' ? `${altitudeMoveKey(m)}|from` : altitudeMoveKey(m)));
}

/**
 * 🎚️ Which of `moves` lose the orbit they claim, by their altitudeMoveKey.
 * A claim is an altitude change's destination (from its booking until its
 * station's next move leaves) or the custom orbit a later move keeps
 * (fromOrbit: until it leaves, or for good once cancelled). Claims are taken
 * in the order they were made (then by station): one is accepted unless an
 * accepted claim of another station around the same planet, still held when
 * it was made, lies within MIN_ORBIT_SEPARATION_KM. Only accepted claims
 * defeat later ones, so the outcome is the same on every install that knows
 * the same moves, whenever and however offline each was booked. Every
 * other slot's own orbit is kept clear by the move guard.
 */
export function lostAltitudeClaims(moves: readonly StationMove[]): Set<string> {
  const byStation = new Map<string, StationMove[]>();
  const seen = new Set<string>();
  for (const m of moves) {
    const key = altitudeMoveKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    const station = m.welcomeRoomId || m.stationId;
    const list = byStation.get(station);
    if (list) list.push(m); else byStation.set(station, [m]);
  }
  const bookedOf = (m: StationMove) => (m.settles ?? m).bookedAt ?? (m.settles ?? m).departAt;
  const isChange = (m: StationMove) => m.mode === 'orbit' && !m.settles && !!m.orbit;
  interface Claim {
    key: string; station: string; planet: string; radiusKm: number; at: number; held: (t: number) => boolean;
    /** A claim this one stands on: a change's destination falls with its source. */
    needs?: string;
  }
  const accepted = new Set<string>();
  // A claim ends when a later move of its station leaves: any other move,
  // or an altitude change that was itself accepted. One that lost never
  // flew, so the orbit before it is still held.
  const endedBy = (list: StationMove[], after: number, t: number) => list.some((o) => bookedOf(o) > after
    && o.departAt <= t && (!isChange(o) || accepted.has(altitudeMoveKey(o))));
  const claims: Claim[] = [];
  for (const [station, list] of byStation) {
    for (const m of list) {
      const key = altitudeMoveKey(m);
      const booked = bookedOf(m);
      if (isChange(m)) {
        const planet = planetById(m.toPlanetId).id;
        // The custom orbit it leaves, held until a move from this one on
        // flies (this one, unless it loses), whether or not the change that
        // took the station there is known here. Weighed no later than the
        // destination, which can't fly from an orbit the station never held.
        const since = m.orbit!.fromSince;
        const from = since !== undefined ? `${key}|from` : undefined;
        claims.push({
          key, station, planet, radiusKm: m.orbit!.toRadiusKm, at: booked, held: (t) => !endedBy(list, booked, t),
          ...(from ? { needs: from } : {}),
        });
        if (from) {
          claims.push({
            key: from, station, planet, radiusKm: orbitChangeBase(m.orbit!).radiusKm, at: Math.min(since!, booked),
            held: (t) => !endedBy(list, booked - 1, t),
          });
        }
        continue;
      }
      const src = m.settles ?? m;
      if (src.mode === 'orbit' || !src.fromOrbit) continue;
      const cancelled = !!m.settles && m.departAt < m.settles.arriveAt;
      claims.push({
        key, station, planet: planetById(src.fromPlanetId).id, radiusKm: src.fromOrbit.radiusKm,
        at: src.fromOrbit.since ?? 0, held: cancelled ? (t) => !endedBy(list, booked, t) : (t) => t < src.departAt,
      });
    }
  }
  // In claim order, so every altitude change that could end an earlier claim
  // by a given time (booked no later than it leaves) is settled before any
  // claim made at that time is weighed.
  claims.sort((a, b) => a.at - b.at || (a.station < b.station ? -1 : a.station > b.station ? 1 : 0)
    || (a.needs === b.key ? 1 : b.needs === a.key ? -1 : 0)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const kept: Claim[] = [];
  const lost = new Set<string>();
  for (const c of claims) {
    const beaten = (!!c.needs && lost.has(c.needs)) || kept.some((a) => a.station !== c.station && a.planet === c.planet
      && Math.abs(a.radiusKm - c.radiusKm) < MIN_ORBIT_SEPARATION_KM && a.held(c.at));
    if (beaten) lost.add(c.key);
    else { kept.push(c); accepted.add(c.key); }
  }
  return lost;
}

/** 🎚️ The orbit a station flies at `nowMs` by its latest move: an altitude
 *  change's new orbit once it has arrived, the one it left until then; none
 *  (its slot's orbit) for any other move. */
export function orbitAfterMove(move: StationMove | null | undefined, nowMs: number): StationOrbit | undefined {
  if (!move) return undefined;
  const m = move.settles ?? move;
  if (!isOrbitChange(move)) {
    // Any other move keeps the altitude it left from until it leaves, and
    // for good when a pin cancels it (it leaves before the move arrives).
    const cancelled = !!move.settles && move.departAt < move.settles.arriveAt;
    return (cancelled || nowMs < m.departAt) && m.fromOrbit
      ? { radiusKm: m.fromOrbit.radiusKm, phase0: m.fromOrbit.phase0 } : undefined;
  }
  const o = m.orbit;
  if (!o) return undefined;
  return nowMs >= m.arriveAt
    ? { radiusKm: o.toRadiusKm, phase0: o.toPhase0 }
    : orbitChangeBase(o);
}

/** Where a station is listed at `nowMs` given its latest move: the move's
 *  destination once it has arrived, else where it left from (a move names
 *  where it leaves, so it supersedes any earlier one). An altitude change
 *  goes nowhere in the list, but sets the orbit the station flies. */
function placeWithMove(
  r: { planetId: string; orbitSlot: number },
  move: StationMove | null,
  nowMs: number,
): { planetId: string; orbitSlot: number; move?: StationMove; orbit?: StationOrbit } {
  if (!move) return { planetId: r.planetId, orbitSlot: r.orbitSlot };
  const orbit = orbitAfterMove(move, nowMs);
  const withOrbit = orbit ? { orbit } : {};
  if (nowMs >= move.arriveAt) return { planetId: move.toPlanetId, orbitSlot: move.toSlot, ...withOrbit };
  return { planetId: move.fromPlanetId, orbitSlot: move.fromSlot, move, ...withOrbit };
}

/** Is the station between its departure and capture burns — gone from every
 *  planet's orbits, so no ship can reach it? Never by a move that goes
 *  nowhere (a pin: an arrival settled, a tow cancelled), which holds its
 *  station where it is for its one millisecond too. */
export function stationInTransit(station: Pick<StationRecord, 'move'>, nowMs: number = Date.now()): boolean {
  const m = station.move;
  return !!m && nowMs >= m.departAt && nowMs < m.arriveAt
    // 🎚️ An altitude change stays in its slot, yet is a transfer all the same.
    && (m.fromPlanetId !== m.toPlanetId || m.fromSlot !== m.toSlot || (m.mode === 'orbit' && !m.settles));
}

// ── Stations heard of but not listed ─────────────────────────────────────────

/** A station this install has heard of (a planet summary, from around
 *  another planet, say) but does not list: its record's planet and slot,
 *  and its latest move. The orbit it holds counts as taken, and the slot its
 *  move is bound for as reserved, wherever a slot is chosen or an arrival
 *  settled; it never becomes a ship's destination, unless the atlas knows
 *  its rooms (then it is listed: placeStations). */
export interface KnownPlace { welcomeRoomId: string; planetId: string; orbitSlot: number; move?: StationMove }

let knownPlacesResolver: (() => KnownPlace[]) | null = null;

/** Install (or remove, with null) where the stations heard of come from
 *  (planetSummary.installKnownPlacesResolver). */
export function setKnownPlacesResolver(resolver: (() => KnownPlace[]) | null): void {
  knownPlacesResolver = resolver;
}

/** The stations heard of whose welcome room is none of `listedRooms`, each once. */
function knownPlaces(listedRooms: Iterable<string>): KnownPlace[] {
  if (!knownPlacesResolver) return [];
  let all: KnownPlace[];
  try { all = knownPlacesResolver(); } catch { return []; }
  const seen = new Set(listedRooms);
  const out: KnownPlace[] = [];
  for (const p of all) {
    if (!p || typeof p.welcomeRoomId !== 'string' || !p.welcomeRoomId || seen.has(p.welcomeRoomId)) continue;
    seen.add(p.welcomeRoomId);
    out.push(p);
  }
  return out;
}

/** Does a move still hold the slot it is bound for at `nowMs`: booked, not
 *  yet arrived, and going somewhere (a pin goes nowhere)? */
function reservesSlot(m: StationMove | null | undefined, nowMs: number): m is StationMove {
  return !!m && nowMs < m.arriveAt && !m.settles
    && !(planetById(m.fromPlanetId).id === planetById(m.toPlanetId).id && m.fromSlot === m.toSlot);
}

/** Around `planetId` at `nowMs`, by the stations heard of whose welcome room
 *  is none of `listedRooms` nor a room of `atlas`: the slots they hold where
 *  the station list settles them (none while between planets), and the slots
 *  their moves are bound for. Settled with this install's records as
 *  listStations settles them, every clash included, so two heard of in one
 *  slot hold two, as on an install that lists them. */
export function knownSlotsAround(
  planetId: string,
  listedRooms: Iterable<string>,
  nowMs: number = Date.now(),
  atlas: Record<string, AtlasEntry> = readAtlas(),
): { taken: Set<number>; reserved: Set<number> } {
  const id = planetById(planetId).id;
  const taken = new Set<number>();
  const reserved = new Set<number>();
  const listed = new Set(listedRooms);
  for (const st of placeStations(atlas, readStationRecords(), nowMs).heard) {
    if (listed.has(st.welcomeRoomId)) continue;
    if (!stationLeftPlanet(st, nowMs) && planetById(st.planetId).id === id) taken.add(st.orbitSlot);
    if (reservesSlot(st.move, nowMs) && planetById(st.move.toPlanetId).id === id) reserved.add(st.move.toSlot);
  }
  return { taken, reserved };
}

/** 🎚️ Is the station between planets — in transit (stationInTransit) on a
 *  move that leaves its planet? It holds no slot there until it is back. A
 *  station changing ALTITUDE is in transit too (no ship can reach it, no
 *  dock moves) but never leaves its planet or its slot. */
export function stationLeftPlanet(station: Pick<StationRecord, 'move'>, nowMs: number = Date.now()): boolean {
  return stationInTransit(station, nowMs) && !isOrbitChange(station.move);
}

/** 🎚️ Two stations' base orbits around one planet stay at least this far
 *  apart in radius: past both their station-keeping bands (±20 km each), so
 *  trimming never brings two stations within 10 km of each other's orbit. */
export const MIN_ORBIT_SEPARATION_KM = 50;

/** Slots per planet. orbits.ts spaces slots geometrically, so this also
 *  bounds how far out a station can orbit (slot 15 ≈ 190,000 km for
 *  Sovereign II — about half the distance to a moon). */
export const MAX_ORBIT_SLOTS = 16;

export const DEFAULT_STATION_ID = 'furlong-station';

export const DEFAULT_STATION_RECORD: StationRecord = {
  id: DEFAULT_STATION_ID,
  name: 'FURLONG LOBBY STATION',
  planetId: DEFAULT_PLANET_ID,
  orbitSlot: 0,
  welcomeRoomId: DEFAULT_STATION.welcomeRoomId,
};

// ── Saved records ────────────────────────────────────────────────────────────

const KEY = 'ssf-stations';
const MAX_RECORDS = 32;

/** Prefix of derived station ids — never accepted on a saved record, nor is
 *  ADRIFT_PREFIX: a location that reads as open orbit is never a station. A
 *  record saved by hand under it before it was reserved reads as invalid and
 *  drops; its rooms still list, as the station the atlas derives for them. */
const DERIVED_PREFIX = 'station:';
/** Prefix of the id a station heard of goes by inside listStations (never
 *  listed, so never seen outside it). */
const HEARD_PREFIX = 'heard:';

/** Length limits on every station id and name, saved or derived. */
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 64;

/** Solar-map body ids a station may not take (map.ts initializeBodies): a
 *  station sharing an id with a planet would confuse selection and travel. */
const RESERVED_BODY_IDS = new Set([
  'star-sol', 'lagrange-l4', 'lagrange-l5', 'belt-ring', ...PLANETS.map((p) => p.id),
]);

function isRecord(v: unknown): v is StationRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0 && r.id.length <= MAX_ID_LENGTH
    && !r.id.startsWith(DERIVED_PREFIX) && !r.id.startsWith(ADRIFT_PREFIX) && !RESERVED_BODY_IDS.has(r.id)
    && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= MAX_NAME_LENGTH
    && typeof r.planetId === 'string'
    && Number.isInteger(r.orbitSlot) && (r.orbitSlot as number) >= 0 && (r.orbitSlot as number) < MAX_ORBIT_SLOTS
    && typeof r.welcomeRoomId === 'string' && r.welcomeRoomId.length > 0
    && (r.berthDoor === undefined || (typeof r.berthDoor === 'string' && isAcceptableDoorKey(r.berthDoor)));
}

/** How each station's latest arrival went on this install: 'bounced' (its
 *  new planet was full the moment it got there, so it stayed where it left
 *  from) or 'arrived'. One entry per station (its welcome room), for the move
 *  it is for (keyed by the whole move: times, ends, mode, tug), so two moves
 *  leaving the same millisecond never share an outcome, and other stations'
 *  arrivals never push out an idle station's. Worked out again from the
 *  stations known now, a bounce could flip once the station that filled the
 *  planet moves on, pulling a station across without a transfer. Until a
 *  shared pin (stationMove.pinSettledArrival) takes over, this holds it. */
const OUTCOME_KEY = 'ssf-station-arrivals';
/** Well above the 64 stations the atlas and the planet summaries carry. */
const MAX_OUTCOMES = 256;
type ArrivalOutcome = 'bounced' | 'arrived';
type OutcomeEntry = [station: string, move: string, outcome: ArrivalOutcome];

function readArrivalOutcomes(): OutcomeEntry[] {
  try {
    const raw = localStorage.getItem(OUTCOME_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((e): e is OutcomeEntry => Array.isArray(e) && typeof e[0] === 'string'
      && typeof e[1] === 'string' && (e[2] === 'bounced' || e[2] === 'arrived')).slice(-MAX_OUTCOMES);
  } catch { return []; }
}

function writeArrivalOutcome(station: string, move: string, outcome: ArrivalOutcome): void {
  const list = readArrivalOutcomes().filter((e) => e[0] !== station);
  list.push([station, move, outcome]);
  try { localStorage.setItem(OUTCOME_KEY, JSON.stringify(list.slice(-MAX_OUTCOMES))); } catch { /* quota */ }
}

export function readStationRecords(): StationRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isRecord).slice(0, MAX_RECORDS).map(clean);
  } catch { return []; }
}

/** Most JSON a record's extra fields may take (a newer build's, or a peer's
 *  carried by the shared planet summary); past it they are dropped. */
const MAX_EXTRA_JSON = 1024;
const CORE_FIELDS = new Set(['id', 'name', 'planetId', 'orbitSlot', 'welcomeRoomId', 'berthDoor', 'berths', 'derived', 'orbit']);

/** The record's fields this build does not know, kept as they are while
 *  they are plain JSON within MAX_EXTRA_JSON, so a newer build's (or a
 *  learned station's) survive a save here. */
function extraFields(r: StationRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!CORE_FIELDS.has(k) && k !== '__proto__') out[k] = v;
  if (Object.keys(out).length === 0) return out;
  try {
    const json = JSON.stringify(out);
    return json.length <= MAX_EXTRA_JSON ? JSON.parse(json) as Record<string, unknown> : {};
  } catch { return {}; }
}

function clean(r: StationRecord): StationRecord {
  return {
    ...extraFields(r),
    id: r.id,
    name: r.name,
    planetId: planetById(r.planetId).id,
    orbitSlot: r.orbitSlot,
    welcomeRoomId: r.welcomeRoomId,
    ...(r.berthDoor ? { berthDoor: r.berthDoor } : {}),
    // An empty list is kept: it says the station is known to have no gates.
    ...(Array.isArray(r.berths) && (r.berths.length === 0 || cleanBerths(r.berths).length > 0)
      ? { berths: cleanBerths(r.berths) } : {}),
  };
}

/** Save (or replace, by id) a station record on this install. Returns false
 *  for an invalid record, one that would shadow the built-in default, a solar
 *  map body, a derived station id or an open-orbit place (adriftAt), one
 *  whose planet has no free orbit slot left (or would have none for a
 *  station already saved), one whose welcome room is part of a station
 *  already listed, or one taking a slot another station's move is bound for
 *  (reservations: a record that already had that planet and slot keeps
 *  them; a record mirrored from a peer passes false, as it stands where its
 *  own install put it). */
export function registerStation(
  record: Omit<StationRecord, 'derived'>,
  opts: { reservations?: boolean } = {},
): boolean {
  if (!isRecord(record) || record.id === DEFAULT_STATION_ID) return false;
  const saved = readStationRecords();
  if (opts.reservations !== false && slotReservedFor(record, saved)) return false;
  const records = [...saved];
  // Replace IN PLACE: when two records name one place the earlier keeps it,
  // and the list keeps record order.
  const at = records.findIndex((r) => r.id === record.id);
  if (at >= 0) records[at] = clean(record);
  else if (records.length >= MAX_RECORDS) return false;
  else records.push(clean(record));
  // Refuse a record the list would drop (its planet has no free slot, or its
  // welcome room already belongs to a listed station), one that would drop a
  // saved station instead (winning that station's slot on a full planet, or
  // taking its place), and one that would crowd a full planet: an arrival
  // that loses its slot keeps its place by sharing it (placeStations), so
  // that planet would hold more stations than slots. The list as it stands
  // goes first, and the one with the record is only tried: an arrival is
  // settled for good by stations that are there, never by a record that
  // may be refused.
  const atlas = readAtlas();
  const now = Date.now();
  const before = placeStations(atlas, saved, now);
  const after = placeStations(atlas, records, now, false);
  const listed = new Set(after.listed.map((s) => s.id));
  if (!listed.has(record.id)) return false;
  if (before.listed.some((s) => !s.derived && s.id !== record.id && !listed.has(s.id))) return false;
  if (crowding(after, now) > crowding(before, now)) return false;
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { return false; }
  return true;
}

/** How many stations share an orbit slot with another (listed or heard of;
 *  one between planets holds none). */
function crowding(placed: { listed: StationRecord[]; heard: StationRecord[] }, nowMs: number): number {
  const holding = [...placed.listed, ...placed.heard].filter((s) => !stationLeftPlanet(s, nowMs));
  return holding.length - new Set(holding.map((s) => `${planetById(s.planetId).id}:${s.orbitSlot}`)).size;
}

/** Is the slot a record asks for one another station's move is bound for:
 *  a listed station's, or one heard of? Not when the record already had it. */
function slotReservedFor(record: Omit<StationRecord, 'derived'>, saved: StationRecord[], nowMs: number = Date.now()): boolean {
  const planet = planetById(record.planetId).id;
  const had = saved.find((r) => r.id === record.id);
  if (had && planetById(had.planetId).id === planet && had.orbitSlot === record.orbitSlot) return false;
  const listed = listStations(readAtlas(), saved, nowMs);
  const bound = listed.some((st) => st.welcomeRoomId !== record.welcomeRoomId && reservesSlot(st.move, nowMs)
    && planetById(st.move.toPlanetId).id === planet && st.move.toSlot === record.orbitSlot);
  return bound || knownSlotsAround(planet, [...listed.map((st) => st.welcomeRoomId), record.welcomeRoomId], nowMs)
    .reserved.has(record.orbitSlot);
}

export function removeStation(id: string): void {
  const records = readStationRecords().filter((r) => r.id !== id);
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* quota */ }
}

// ── The station list ─────────────────────────────────────────────────────────

/**
 * Every station this install knows: the built-in default, saved records, and
 * one derived station per unclaimed atlas component. One place is one
 * station — a record whose welcome room lies in a station already listed is
 * dropped. Orbit slots are unique per planet — a record that loses a clash
 * for its slot moves to the next free one, settled the same way on every
 * install whatever order it saved its records in, and derived stations fill
 * free slots in anchor order; both pass over a slot a move is bound for, or
 * one a station heard of holds. This is the list ship destinations read
 * from.
 */
export function listStations(
  atlas: Record<string, AtlasEntry> = readAtlas(),
  records: StationRecord[] = readStationRecords(),
  nowMs: number = Date.now(),
): StationRecord[] {
  return placeStations(atlas, records, nowMs).listed.map((st) => withBerths(st, atlas));
}

/** listStations, with where it settled the stations heard of (`heard`:
 *  never listed, but holding their slots all the same). */
function placeStations(
  atlas: Record<string, AtlasEntry>,
  records: StationRecord[],
  nowMs: number,
  /** False for a trial list (registerStation's): the arrivals it settles
   *  are not stored, so a record only tried never decides one for good. */
  persist = true,
): { listed: StationRecord[]; heard: StationRecord[] } {
  // Which PLACE a welcome room is: its atlas component, or the bare room when
  // the atlas does not know it. One place is one station — a second record
  // pointing into a station already listed is dropped, not listed twice.
  const components = atlasComponents(atlas);
  const componentOf = new Map<string, number>();
  components.forEach((c, i) => { for (const rid of c) componentOf.set(rid, i); });
  const placeOf = (roomId: string): string => {
    if (!roomId) return '';
    const c = componentOf.get(roomId);
    return c === undefined ? `room:${roomId}` : `component:${c}`;
  };

  const taken = new Map<string, Set<number>>();
  const used = (planetId: string): Set<number> => {
    let slots = taken.get(planetId);
    if (!slots) taken.set(planetId, slots = new Set());
    return slots;
  };
  // Slots kept for a station that is not in them yet, by planet: the slot
  // each move not yet arrived is bound for (reservesSlot), and the one each
  // arrival settles in (back home when it bounced). Filled once every
  // candidate is known (below). Only that station takes one: a clash loser
  // or a derived station passes over them, and goes unlisted when nothing
  // else is free, so a booked slot waits for its arrival.
  const held = new Map<string, Set<number>>();
  const hold = (planetId: string, slot: number) => {
    let slots = held.get(planetId);
    if (!slots) held.set(planetId, slots = new Set());
    slots.add(slot);
  };
  // A station's own slot (its record's, or the one its move put it in),
  // when it is in range and nobody has taken it.
  const takeOwn = (planetId: string, slot: number): boolean => {
    const slots = used(planetId);
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ORBIT_SLOTS || slots.has(slot)) return false;
    slots.add(slot);
    return true;
  };
  // The next slot on from `wanted` that nobody has taken or keeps, or null.
  const claim = (planetId: string, wanted: number): number | null => {
    const slots = used(planetId);
    const kept = held.get(planetId);
    for (let i = 0; i < MAX_ORBIT_SLOTS; i++) {
      const slot = (wanted + i) % MAX_ORBIT_SLOTS;
      if (!slots.has(slot) && !kept?.has(slot)) { slots.add(slot); return slot; }
    }
    return null;
  };
  // Every candidate first — records in list order (one per id, one per
  // place; an unknown planet reads as the default one), then the stations
  // heard of, then one derived station per unclaimed atlas component — each
  // with its latest move read once.
  interface Candidate {
    id: string;
    welcomeRoomId: string;
    base: { planetId: string; orbitSlot: number };
    move: StationMove | null;
    /** False for a station heard of whose rooms the atlas does not know (or
     *  whose welcome room is too long to anchor a derived record): it takes
     *  its slot, and is never listed. */
    listed: boolean;
    make: (planetId: string, orbitSlot: number, move: StationMove | undefined, orbit: StationOrbit | undefined) => StationRecord;
  }
  const candidates: Candidate[] = [];
  const ids = new Set<string>();
  const places = new Set<string>();
  for (const r of [DEFAULT_STATION_RECORD, ...records]) {
    if (ids.has(r.id)) continue;
    const where = placeOf(r.welcomeRoomId);
    if (where && places.has(where)) continue;
    ids.add(r.id);
    if (where) places.add(where);
    const { move: _stale, orbit: _derived, ...rest } = r;
    candidates.push({
      id: r.id,
      welcomeRoomId: r.welcomeRoomId,
      base: { planetId: planetById(r.planetId).id, orbitSlot: r.orbitSlot },
      move: moveOf(r),
      listed: true,
      make: (planetId, orbitSlot, move, orbit) => ({ ...rest, planetId, orbitSlot, ...(move ? { move } : {}), ...(orbit ? { orbit } : {}) }),
    });
  }

  // A room name is peer-written and not shape-checked on every path.
  const atlasName = (rid: string): string => {
    const name: unknown = atlas[rid]?.name;
    return (typeof name === 'string' && name ? name : 'STATION').slice(0, MAX_NAME_LENGTH);
  };

  // The stations heard of (planet summaries, around other planets mostly)
  // that nothing here lists: each takes part in the slots below as it does
  // on an install that lists it, so both settle every slot alike. One whose
  // rooms the atlas does not know is never listed (no ship flies to a
  // station this install cannot place). One whose rooms it knows, though no
  // record here claims them (a learned record pruned once it was at another
  // planet, say), is listed as the station derived for those rooms, but
  // where its summary has it and by its welcome room, so its slot and the
  // one its move is bound for stay its own. Its move is the installed
  // resolver's, as a listed station's is: that has heard the summary's move
  // too (planetSummary remembers it), so its answer is what stands, null
  // included (a tow outbid for its tug flies nowhere). Only with no resolver
  // does the summary's own move stand in. Taken in welcome room order, so
  // two summaries of one station's rooms pick the same one everywhere.
  const heardOf = [...knownPlaces(candidates.map((c) => c.welcomeRoomId))]
    .sort((a, b) => (a.welcomeRoomId < b.welcomeRoomId ? -1 : a.welcomeRoomId > b.welcomeRoomId ? 1 : 0));
  for (const p of heardOf) {
    const where = placeOf(p.welcomeRoomId);
    if (places.has(where)) continue;
    if (typeof p.planetId !== 'string' || !Number.isInteger(p.orbitSlot) || p.orbitSlot < 0 || p.orbitSlot >= MAX_ORBIT_SLOTS) continue;
    // Its rooms known, but too long a welcome room to anchor a derived
    // record: heard of only, as if the atlas did not know them, so it still
    // holds its slot (and its rooms derive as any others do).
    const inAtlas = !where.startsWith('room:') && DERIVED_PREFIX.length + p.welcomeRoomId.length <= MAX_ID_LENGTH;
    places.add(inAtlas ? where : `room:${p.welcomeRoomId}`);
    const stub = { id: `${inAtlas ? DERIVED_PREFIX : HEARD_PREFIX}${p.welcomeRoomId}`, welcomeRoomId: p.welcomeRoomId };
    const name = inAtlas ? atlasName(p.welcomeRoomId) : 'STATION';
    candidates.push({
      id: stub.id,
      welcomeRoomId: p.welcomeRoomId,
      base: { planetId: planetById(p.planetId).id, orbitSlot: p.orbitSlot },
      move: moveResolver ? moveOf(stub) : p.move && moveBelongsTo(p.move, stub) ? p.move : null,
      listed: inAtlas,
      make: (planetId, orbitSlot, move, orbit) => ({
        id: stub.id, name, planetId, orbitSlot, welcomeRoomId: p.welcomeRoomId,
        ...(inAtlas ? { derived: true } : {}), ...(move ? { move } : {}), ...(orbit ? { orbit } : {}),
      }),
    });
  }

  // Atlas ids and names can arrive from peers unbounded, so derived records
  // get the same limits a saved record must meet: an over-long room id cannot
  // anchor a station, and names are cut to length.
  const derived: Array<{ anchor: string; name: string }> = [];
  components.forEach((component, i) => {
    if (places.has(`component:${i}`)) return;
    // Only a room the atlas holds an entry of its own for: a door may name a
    // room `constructor` or `__proto__`, and what that name inherits is no entry.
    const known = [...component]
      .filter((rid) => Object.prototype.hasOwnProperty.call(atlas, rid) && atlas[rid]
        && DERIVED_PREFIX.length + rid.length <= MAX_ID_LENGTH)
      .sort();
    const anchor = known[0];
    if (!anchor) return;
    derived.push({ anchor, name: atlasName(anchor) });
  });
  derived.sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0));
  const firstDerived = candidates.length;
  for (const d of derived) {
    const id = `${DERIVED_PREFIX}${d.anchor}`;
    // A derived station that has moved is listed where its move put it; one
    // that has not takes the lowest free slot around the default planet.
    candidates.push({
      id,
      welcomeRoomId: d.anchor,
      base: { planetId: DEFAULT_PLANET_ID, orbitSlot: 0 },
      move: moveOf({ id, welcomeRoomId: d.anchor }),
      listed: true,
      make: (planetId, orbitSlot, move, orbit) => ({
        id, name: d.name, planetId, orbitSlot, welcomeRoomId: d.anchor, derived: true, ...(move ? { move } : {}),
        ...(orbit ? { orbit } : {}),
      }),
    });
  }

  // Where each candidate wants to be now: its record, or its move's end
  // once arrived (an arrival that found its new planet full stays where it
  // left from — see below). An altitude change keeps its station in its
  // slot: for the slots it is no move at all.
  const settledAt = (c: Candidate) =>
    (c.move && !isOrbitChange(c.move) && nowMs >= c.move.arriveAt ? c.move.arriveAt : -Infinity);
  const spots: Array<{ planetId: string; orbitSlot: number; move?: StationMove } | null> = candidates.map(() => null);
  const wantOf = candidates.map((c) => {
    const at = placeWithMove(c.base, c.move, nowMs);
    return { ...at, planetId: planetById(at.planetId).id };
  });
  // 🎚️ Altitude claims (lostAltitudeClaims), weighed among every station's
  // latest move and every move this install knows: an altitude change that
  // lost is aborted, its station staying on the orbit it left, listed with
  // no move; a custom orbit a later move keeps that lost gives way to the
  // slot's own. stationMove.ts holds the same aborted change out of the dock
  // lock and the fuel meter.
  let history: StationMove[] = [];
  try { history = altitudeHistory?.() ?? []; } catch { history = []; }
  const latest = candidates.flatMap((c) => (c.move ? [c.move] : []));
  const lostClaims = latest.some((m) => (m.settles ?? m).mode === 'orbit' || (m.settles ?? m).fromOrbit)
    ? lostAltitudeClaims([...latest, ...history]) : new Set<string>();
  candidates.forEach((c, i) => {
    const m = c.move;
    if (!m || !lostClaims.has(altitudeMoveKey(m))) return;
    const { planetId, orbitSlot } = wantOf[i];
    if (m.mode === 'orbit' && !m.settles && m.orbit && !lostClaims.has(`${altitudeMoveKey(m)}|from`)) {
      // It stays on the orbit it left: inside the altitude band, as the
      // orbit it left may sit a trim beyond its edge (baseOrbit flies only
      // the band).
      const planet = planetById(planetId);
      const low = planet.radiusKm + MIN_ALTITUDE_KM;
      const high = planet.radiusKm + maxAltitudeKm(planet.id);
      const base = orbitChangeBase(m.orbit);
      const radiusKm = Math.min(high, Math.max(low, base.radiusKm));
      wantOf[i] = { planetId, orbitSlot, orbit: { radiusKm, phase0: base.phase0 } };
    } else if (m.mode === 'orbit' && !m.settles && m.orbit) {
      // The orbit it left was lost too: its slot's own.
      wantOf[i] = { planetId, orbitSlot };
    } else {
      wantOf[i] = { planetId, orbitSlot, ...(wantOf[i].move ? { move: wantOf[i].move } : {}) };
    }
  });
  // How each arrival went (arrivalOutcome), read once for the whole list.
  const outcomes = new Map(readArrivalOutcomes().map((e) => [e[0], e] as const));
  const stationOf = (c: Candidate) => c.welcomeRoomId || c.id;
  const outcomeKeyOf = (m: StationMove) => [m.departAt, m.arriveAt, m.bookedAt ?? m.departAt, m.fromPlanetId, m.fromSlot,
    m.toPlanetId, m.toSlot, m.mode, m.tugRoomId ?? '', m.settles ? m.settles.departAt : ''].join('|');
  const outcomeOf = (c: Candidate, m: StationMove): ArrivalOutcome | null => {
    const e = outcomes.get(stationOf(c));
    return e && e[1] === outcomeKeyOf(m) ? e[2] : null;
  };
  for (const c of candidates) {
    const m = c.move;
    if (!m) continue;
    if (nowMs >= m.arriveAt) {
      const home = outcomeOf(c, m) === 'bounced';
      hold(planetById(home ? m.fromPlanetId : m.toPlanetId).id, home ? m.fromSlot : m.toSlot);
    } else if (reservesSlot(m, nowMs)) hold(planetById(m.toPlanetId).id, m.toSlot);
  }

  // Slots are settled in one global order, never this install's record
  // order, so every install holding the same stations gives each the same
  // slot. The built-in default claims first, as it is the same everywhere;
  // then the stations that have been where they are longest: those that
  // never moved (or are still waiting or on their way), each wanted slot to
  // the smallest welcome room id, the clash losers after them to the next
  // free slot on; then arrivals in the order they arrived. A clash moves only
  // the station that lost it, and a newcomer never pushes out an incumbent.
  // Derived stations follow saved records (and those heard of) among those
  // that never moved. A station waiting to depart goes before them all
  // (below).
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const globalOrder = (i: number, j: number) => byName(wantOf[i].planetId, wantOf[j].planetId)
    || wantOf[i].orbitSlot - wantOf[j].orbitSlot
    || byName(candidates[i].welcomeRoomId, candidates[j].welcomeRoomId) || byName(candidates[i].id, candidates[j].id);
  const settle = (i: number, planetId: string, slot: number) => {
    spots[i] = { planetId, orbitSlot: slot, ...(wantOf[i].move ? { move: wantOf[i].move } : {}) };
  };
  const stayers = candidates.map((_, i) => i).filter((i) => settledAt(candidates[i]) === -Infinity);
  const [builtIn, ...rest] = stayers[0] === 0 ? stayers : [-1, ...stayers];
  // A station between planets is listed where it left from (for the helm
  // and the holotable) but holds no slot there until it is back: its old
  // slot is free for others, and a bounce home claims one again.
  const inTransit = (i: number) => stationLeftPlanet({ move: candidates[i].move ?? undefined }, nowMs);
  if (builtIn === 0 && inTransit(0)) settle(0, wantOf[0].planetId, wantOf[0].orbitSlot);
  else if (builtIn === 0) {
    const slot = takeOwn(wantOf[0].planetId, wantOf[0].orbitSlot) ? wantOf[0].orbitSlot : claim(wantOf[0].planetId, wantOf[0].orbitSlot);
    if (slot !== null) settle(0, wantOf[0].planetId, slot);
  }
  for (const i of rest.filter(inTransit)) settle(i, wantOf[i].planetId, wantOf[i].orbitSlot);
  // 🚚 A station waiting for its launch window keeps the slot its move
  // leaves from: the move was priced from that orbit (its fuel, its course),
  // and is drawn leaving it, then listed leaving it. It takes that slot
  // before the other stayers, so a clash found meanwhile moves the other
  // station. Two waiting to leave one slot (booked by installs that had not
  // heard of each other) share it until each has left, as an arrival with
  // nowhere else to go shares one: neither waits anywhere its move does not
  // leave from.
  const waiting = (i: number) => {
    const m = candidates[i].move;
    return !!m && nowMs < m.departAt && reservesSlot(m, nowMs);
  };
  const kept = new Set<number>();
  for (const i of rest.filter((j) => !inTransit(j) && waiting(j)).sort(globalOrder)) {
    const { planetId, orbitSlot } = wantOf[i];
    if (!Number.isInteger(orbitSlot) || orbitSlot < 0 || orbitSlot >= MAX_ORBIT_SLOTS) continue;
    takeOwn(planetId, orbitSlot);
    settle(i, planetId, orbitSlot);
    kept.add(i);
  }
  const stay = (i: number) => !inTransit(i) && !kept.has(i);
  for (const group of [rest.filter((i) => i < firstDerived && stay(i)), rest.filter((i) => i >= firstDerived && stay(i))]) {
    const lost: number[] = [];
    for (const i of [...group].sort(globalOrder)) {
      const { planetId, orbitSlot } = wantOf[i];
      // A derived station that never moved has no slot of its own: it
      // claims the lowest free one, with the clash losers.
      const own = i < firstDerived || candidates[i].move !== null;
      if (own && takeOwn(planetId, orbitSlot)) settle(i, planetId, orbitSlot);
      else lost.push(i);
    }
    for (const i of lost) {
      const slot = claim(wantOf[i].planetId, wantOf[i].orbitSlot);
      if (slot !== null) settle(i, wantOf[i].planetId, slot);
    }
  }

  const arrivals = candidates.map((_, i) => i).filter((i) => settledAt(candidates[i]) !== -Infinity)
    .sort((i, j) => settledAt(candidates[i]) - settledAt(candidates[j]) || globalOrder(i, j));
  for (const i of arrivals) {
    const m = candidates[i].move!;
    let at: { planetId: string; orbitSlot: number } = wantOf[i];
    // An arrival finds its new planet as it was the moment it got there: if
    // every slot was already taken then, it stayed where it left from — for
    // good, so a later vacancy never pulls it across without a transfer.
    const T = m.arriveAt;
    // Where each other station was at T: its settled place when it had
    // already arrived (after any bounce of its own), else what its record
    // and move say for T.
    // Once decided here it stays decided: the others' later moves change
    // what "then" looks like from now, never where this one went.
    let outcome = outcomeOf(candidates[i], m);
    const fresh = !outcome;
    if (!outcome) {
      const dest = planetById(m.toPlanetId).id;
      // The slots taken there at T, not the stations: two that share a slot
      // (an arrival that found every planet full) leave the others free.
      const taken = new Set<number>();
      candidates.forEach((o, j) => {
        if (j === i) return;
        // An arrival pin names only the planet its journey got to: before
        // then, the journey says where the station was (still where it left
        // from, or between planets). A cancel pin (it leaves before the move
        // it settles arrives) says where its station stayed all along.
        const pinned = o.move?.settles;
        const om = pinned && o.move!.departAt >= pinned.arriveAt && T < pinned.arriveAt ? pinned : o.move;
        // One between planets at T held no slot anywhere: first, since one
        // still on its way now is listed where it left from.
        if (stationLeftPlanet({ move: om ?? undefined }, T)) return;
        if (settledAt(o) <= T) {
          if (spots[j]?.planetId === dest) taken.add(spots[j]!.orbitSlot);
          return;
        }
        const place = placeWithMove(o.base, om, T);
        if (planetById(place.planetId).id === dest) taken.add(place.orbitSlot);
      });
      outcome = taken.size >= MAX_ORBIT_SLOTS ? 'bounced' : 'arrived';
    }
    const home = { planetId: planetById(m.fromPlanetId).id, orbitSlot: m.fromSlot };
    if (outcome === 'bounced') at = home;
    let slot = takeOwn(at.planetId, at.orbitSlot) ? at.orbitSlot : claim(at.planetId, at.orbitSlot);
    if (slot === null && fresh && outcome === 'arrived') {
      // A slot was free there at T, but none it may take: its own went to
      // a station that did not know it was coming, and the rest are kept
      // for arrivals still on their way. It bounced, as off a full planet,
      // when where it left from has room.
      const back = takeOwn(home.planetId, home.orbitSlot) ? home.orbitSlot : claim(home.planetId, home.orbitSlot);
      if (back !== null) { outcome = 'bounced'; at = home; slot = back; }
    }
    if (fresh) {
      const entry: OutcomeEntry = [stationOf(candidates[i]), outcomeKeyOf(m), outcome];
      outcomes.set(entry[0], entry);
      if (persist) writeArrivalOutcome(...entry);
    }
    // No slot for it there (nor, just arrived, at home): it stays where its
    // move put it, sharing that slot, rather than drop out of the list or
    // turn up at another planet no transfer took it to.
    settle(i, at.planetId, slot ?? at.orbitSlot);
  }

  // Listed in record order, derived stations last. A station that never
  // moved and finds no slot (its planet is full) is dropped, and a station
  // only heard of is never listed.
  const listed: StationRecord[] = [];
  const heard: StationRecord[] = [];
  candidates.forEach((c, i) => {
    const spot = spots[i];
    if (spot) (c.listed ? listed : heard).push(c.make(spot.planetId, spot.orbitSlot, spot.move, wantOf[i].orbit));
  });
  return { listed, heard };
}

/**
 * ⚓🚦 A listed station with its gates: the atlas's (every dock port of the
 * station, free or docked) together with the gates the record learned in
 * rooms the atlas has not harvested, else its plain berthDoor. A record
 * naming no berthDoor gets the lowest gate in its welcome room as one, for
 * builds that read only that; once the welcome room's gates are known, a
 * berthDoor that is not one of them is replaced the same way, or dropped.
 */
function withBerths(st: StationRecord, atlas: Record<string, AtlasEntry>): StationRecord {
  const gates = stationGates(atlas, st.welcomeRoomId);
  let berths: StationBerthRecord[];
  let knownNone = false;
  // A room this client's atlas has harvested with gates (even none) is
  // known: learned gates in it are gone, not merely unseen. Only rooms it
  // knows nothing of keep what the record learned, beside the atlas's own.
  const unknown = (roomId: string) => atlas[roomId]?.gates === undefined;
  // A room harvested with a port not numbered yet (gatesUnknown) lists no
  // gate at all: what the record learned there is out of date, and only the
  // plain berthDoor stands for its port.
  const unnumbered = (roomId: string) => atlas[roomId]?.gatesUnknown === true;
  const learned = (st.berths ?? []).filter((b) => unknown(b.roomId) && !unnumbered(b.roomId));
  if (gates.length > 0) {
    const seen: StationBerthRecord[] = gates.map((g) => ({
      roomId: g.roomId, doorId: g.doorId, gate: g.gate, ...(g.occupied ? { occupied: true } : {}),
      ...(g.access ? { access: g.access, ...(g.reservedFor ? { reservedFor: g.reservedFor } : {}) } : {}),
    }));
    // An older record names its welcome room's port by berthDoor alone: while
    // this atlas holds no number for that room, the port stands beside the
    // gates of the station's other rooms (as it stands alone without them).
    const legacy: StationBerthRecord[] = !Array.isArray(st.berths) && st.berthDoor && st.welcomeRoomId
      && (unknown(st.welcomeRoomId) || unnumbered(st.welcomeRoomId))
      ? [{ roomId: st.welcomeRoomId, doorId: st.berthDoor }] : [];
    berths = capBerths([...seen, ...learned, ...legacy]
      .map((b, i) => ({ b, i }))
      .sort((x, y) => (x.b.gate ?? MAX_BERTHS + 1) - (y.b.gate ?? MAX_BERTHS + 1) || x.i - y.i)
      .map((x) => x.b));
  } else {
    berths = learned;
    // An empty list means "known to have none" (a summary's, or this atlas's
    // own harvest of the welcome room): only an unknown station falls back,
    // or one whose welcome room has a port not numbered yet.
    knownNone = !unnumbered(st.welcomeRoomId)
      && (Array.isArray(st.berths) || (!!st.welcomeRoomId && !unknown(st.welcomeRoomId)));
    if (berths.length === 0 && !knownNone && st.berthDoor && st.welcomeRoomId) {
      berths = [{ roomId: st.welcomeRoomId, doorId: st.berthDoor }];
    }
  }
  const out: StationRecord = { ...st };
  if (berths.length > 0 || knownNone) out.berths = berths; else delete out.berths;
  const inWelcome = berths.filter((b) => b.roomId === st.welcomeRoomId);
  if (st.welcomeRoomId && !unknown(st.welcomeRoomId)) {
    // The welcome room's gates are known: a berthDoor that is no longer one of
    // them is stale, so it gives way to the lowest gate there, or to none.
    if (!inWelcome.some((b) => b.doorId === out.berthDoor)) {
      if (inWelcome.length > 0) out.berthDoor = inWelcome[0].doorId; else delete out.berthDoor;
    }
  } else if (!out.berthDoor && inWelcome.length > 0) {
    out.berthDoor = inWelcome[0].doorId;
  }
  return out;
}

/** The stations orbiting one planet, in slot order. */
export function stationsAroundPlanet(planetId: string, stations: StationRecord[] = listStations()): StationRecord[] {
  return stations.filter((s) => s.planetId === planetId).sort((a, b) => a.orbitSlot - b.orbitSlot);
}

// ── Rooms the atlas cannot place ─────────────────────────────────────────────

let roomStationResolver: ((roomId: string) => string | null) | null = null;
let resolvingRoom = false;

/** Install (or remove, with null) a resolver that names the station a room is
 *  at when the atlas cannot say: a DOCKED SHIP. Its berth is not structure,
 *  so the atlas keeps the ship apart from the station it is docked at; ship
 *  travel knows the station its live dock leads into. stationForRoom — and so
 *  planetForRoom and currentStation — asks it first. A null answer, a station
 *  that is not listed, or a throw falls back to the atlas, and so does any
 *  lookup the resolver makes itself. */
export function setRoomStationResolver(resolver: ((roomId: string) => string | null) | null): void {
  roomStationResolver = resolver;
}

/** The station a room belongs to: the one the room-station resolver names,
 *  else the one whose welcome room shares the room's atlas component, or null
 *  when neither knows the room. */
export function stationForRoom(
  roomId: string,
  atlas: Record<string, AtlasEntry> = readAtlas(),
  stations: StationRecord[] = listStations(atlas),
): StationRecord | null {
  if (!roomId) return null;
  if (roomStationResolver && !resolvingRoom) {
    let id: string | null = null;
    resolvingRoom = true;
    try {
      id = roomStationResolver(roomId);
    } catch {
      id = null;
    } finally {
      resolvingRoom = false;
    }
    const placed = id ? stations.find((s) => s.id === id) : undefined;
    if (placed) return placed;
  }
  return atlasStationForRoom(roomId, atlas, stations);
}

/** What the atlas alone says: the station whose welcome room shares the
 *  room's component. */
function atlasStationForRoom(
  roomId: string,
  atlas: Record<string, AtlasEntry>,
  stations: StationRecord[],
): StationRecord | null {
  if (!roomId) return null;
  const direct = stations.find((s) => s.welcomeRoomId === roomId);
  if (direct) return direct;
  const component = atlasComponents(atlas).find((c) => c.has(roomId));
  if (!component) return null;
  return stations.find((s) => s.welcomeRoomId !== '' && component.has(s.welcomeRoomId)) ?? null;
}

/**
 * ⚓ The station a DOCKED module is at, read from its live door records — what
 * main.ts installs as the room-station resolver for the room the player is in.
 * Only a lone module moves: no structural (non-berth) pairing, live or in the
 * atlas, and no station of its own beyond the one derived from it. It is at
 * the station on the far side of one of its docks, when that side is a real
 * station — a saved or built-in record, or structure of more than one room —
 * so two lone modules docked together stay where they are, and a station
 * never moves to the ship visiting it. null: the atlas places the room.
 */
export function dockedStationFor(
  roomId: string,
  doors: Iterable<DoorRecord>,
  atlas: Record<string, AtlasEntry> = readAtlas(),
  stations: StationRecord[] = listStations(atlas),
): string | null {
  const own = atlasStationForRoom(roomId, atlas, stations);
  // Structure stays put whether or not it is listed: a full planet lists no
  // station for it, but its rooms still are not a lone module.
  if ((own && !own.derived) || atlasComponent(atlas, roomId).size > 1) return null;
  const partners: string[] = [];
  for (const rec of doors) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    // Only an address that names another room is a pairing (as
    // stationRoomCause reads it): peer-written junk, or a pairing back to
    // this room, neither bolts the room in nor hides a real dock.
    let partner = '';
    try { partner = roomIdFromSeed(rec.connectedRoomAddress); } catch { partner = ''; }
    if (!partner || partner === roomId) continue;
    if (!isBerthDoor(rec)) return null; // bolted into a station: the atlas places it
    partners.push(partner);
  }
  for (const partner of partners) {
    const there = atlasStationForRoom(partner, atlas, stations);
    if (!there || there.id === own?.id) continue;
    if (!there.derived || atlasComponent(atlas, there.welcomeRoomId).size > 1) return there.id;
  }
  return null;
}

/** Why a room is a station's own (stationRoomCause). */
export type StationRoomCause = 'welcome-room' | 'lone-station' | 'bolted';

/** Why `roomId` is a station's own room, never a ship that DEPARTs: a saved
 *  or built-in station's welcome room ('lone-station' when no gangway joins
 *  it to another module: a one-module station, which may still fly by hand
 *  and PARK), or a module bolted into a station by structure (a paired door
 *  that is no berth: taking that gangway down frees it). Null for a ship.
 *  Such a room may wear engine, tank and helm for station keeping. */
export function stationRoomCause(
  roomId: string,
  doors: Iterable<DoorRecord>,
  stations: StationRecord[] = listStations(),
): StationRoomCause | null {
  if (!roomId) return null;
  let bolted = false;
  for (const rec of doors) {
    if (rec.paired === true && !isBerthDoor(rec) && joinsAnotherRoom(rec.connectedRoomAddress, roomId)) {
      bolted = true;
      break;
    }
  }
  if (stations.some((st) => !st.derived && st.welcomeRoomId === roomId)) {
    return bolted ? 'welcome-room' : 'lone-station';
  }
  return bolted ? 'bolted' : null;
}

/** Does a pairing's address name another room, as the atlas reads it? One
 *  naming no room (a peer's junk, or one the parser throws on) or naming
 *  `roomId` itself joins it to none. */
function joinsAnotherRoom(address: string | undefined, roomId: string): boolean {
  if (!address) return false;
  try {
    const target = roomIdFromSeed(address);
    return target !== '' && target !== roomId;
  } catch {
    return false;
  }
}

/** Is `roomId` a station's own room (stationRoomCause)? */
export function isStationRoom(
  roomId: string,
  doors: Iterable<DoorRecord>,
  stations: StationRecord[] = listStations(),
): boolean {
  return stationRoomCause(roomId, doors, stations) !== null;
}

/** The planet a room's station orbits — the default planet when unknown. */
/** Where a ship that missed a departed station waits: open orbit at the
 *  planet and slot that station left (`adrift:<planetId>:<slot>`), and 🎚️ at
 *  the altitude it flew there when that was its own, not the slot's
 *  (`adrift:<planetId>:<slot>@<radiusKm>,<phase0>`, the station's base
 *  orbit, untrimmed). A place, never a station, so it follows no station
 *  anywhere; hops leave from it to the stations around that planet like
 *  from any orbit. */
export const ADRIFT_PREFIX = 'adrift:';

/** An open-orbit place: a planet's slot, on the station's own orbit there
 *  when it flew one. */
export interface AdriftPlace {
  planetId: string;
  orbitSlot: number;
  orbit?: StationOrbit;
}

export function adriftAt(planetId: string, orbitSlot: number, orbit?: StationOrbit | null): string {
  const slotPart = `${ADRIFT_PREFIX}${planetId}:${orbitSlot}`;
  // The slot's own orbit is the slot: one place, one id.
  if (!orbit || !isUsableOrbit(planetById(planetId), orbit) || isSlotOrbit(planetId, orbitSlot, orbit)) return slotPart;
  const id = `${slotPart}@${orbit.radiusKm},${orbit.phase0}`;
  // An id longer than a flight record holds keeps the slot alone.
  return id.length <= MAX_ADRIFT_ID_LEN ? id : slotPart;
}

/** = shipDoc's location-id bound. */
const MAX_ADRIFT_ID_LEN = 128;

/** The planet, slot and own orbit an adrift location names, or null for
 *  anything else (an orbit its planet's stations can't fly too). */
export function adriftPlace(id: string): AdriftPlace | null {
  if (typeof id !== 'string' || !id.startsWith(ADRIFT_PREFIX)) return null;
  const body = id.slice(ADRIFT_PREFIX.length);
  const at = body.indexOf('@');
  const rest = at < 0 ? body : body.slice(0, at);
  const cut = rest.lastIndexOf(':');
  const planetId = rest.slice(0, cut);
  const orbitSlot = Number(rest.slice(cut + 1));
  if (cut <= 0 || !Number.isInteger(orbitSlot) || orbitSlot < 0 || orbitSlot >= MAX_ORBIT_SLOTS) return null;
  // The planet as every other reader names it (an unknown one reads as the
  // default planet, as in listStations), so destinations around it match.
  const planet = planetById(planetId);
  if (at < 0) return { planetId: planet.id, orbitSlot };
  const parts = body.slice(at + 1).split(',');
  if (parts.length !== 2 || parts.some((p) => p.trim() === '')) return null;
  const orbit = { radiusKm: Number(parts[0]), phase0: Number(parts[1]) };
  if (!isUsableOrbit(planet, orbit)) return null;
  return isSlotOrbit(planet.id, orbitSlot, orbit) ? { planetId: planet.id, orbitSlot } : { planetId: planet.id, orbitSlot, orbit };
}

/** 🎚️ Is `orbit` the slot's own (the same circle)? */
function isSlotOrbit(planetId: string, orbitSlot: number, orbit: StationOrbit): boolean {
  return onPlaceOrbit(orbit, orbitForSlot(planetId, orbitSlot));
}

/** 🎚️ Does a station flying `flies` (its base orbit, StationRecord.orbit)
 *  fly the open-orbit place's own orbit `at`: both its slot's, or the same
 *  circle? */
export function onPlaceOrbit(flies: StationOrbit | undefined, at: StationOrbit | undefined): boolean {
  if (!flies || !at) return !flies && !at;
  return Math.abs(flies.radiusKm - at.radiusKm) < 1e-6
    && Math.abs(Math.atan2(Math.sin(flies.phase0 - at.phase0), Math.cos(flies.phase0 - at.phase0))) < 1e-9;
}

/** Where the room resolver puts a room when that is open orbit (a ship
 *  adrift: its flight record's location), or null — a station, or unknown. */
export function roomAdriftPlace(roomId: string): AdriftPlace | null {
  if (!roomId || !roomStationResolver || resolvingRoom) return null;
  resolvingRoom = true;
  try {
    const id = roomStationResolver(roomId);
    return id ? adriftPlace(id) : null;
  } catch {
    return null;
  } finally {
    resolvingRoom = false;
  }
}

/** The planet a room is at: open orbit's own when it is adrift there, else
 *  its station's. */
export function planetForRoom(roomId: string, atlas: Record<string, AtlasEntry> = readAtlas()): PlanetRecord {
  const adrift = roomAdriftPlace(roomId);
  if (adrift) return planetById(adrift.planetId);
  return planetById(stationForRoom(roomId, atlas)?.planetId);
}

// ── The current station ──────────────────────────────────────────────────────

let currentRoomGetter: () => string = () => '';

/** main.ts injects the room the player is standing in (no import cycle). */
export function setStationRoomSource(cb: () => string): void {
  currentRoomGetter = cb;
}

/** The room the player is standing in ('' before main.ts wires it). */
export function currentRoomId(): string {
  return currentRoomGetter();
}

/** The station the player is in now, or null before the atlas knows the room. */
export function currentStation(): StationRecord | null {
  return stationForRoom(currentRoomGetter());
}
