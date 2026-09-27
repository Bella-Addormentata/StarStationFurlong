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
   *  berth. `berthDoor` stays for older builds: listStations sets it to the
   *  lowest gate in the welcome room when the record names none. */
  berths?: StationBerthRecord[];
  /** Set on stations derived from an atlas component with no record. */
  derived?: true;
  /** A move to another planet that is scheduled or under way (stationMove.ts).
   *  listStations fills it from the move resolver; once the move arrives the
   *  station is listed at its new planet and slot, and this is gone. */
  move?: StationMove;
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
}

/** Gates a station lists at most. */
export const MAX_BERTHS = 16;

/** One berth, shape-checked (peer-written when it came through a summary),
 *  without the local `occupied` flag. Null when it is not one. */
export function cleanBerth(v: unknown): StationBerthRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as Record<string, unknown>;
  if (typeof b.roomId !== 'string' || !b.roomId || b.roomId.length > MAX_ID_LENGTH) return null;
  if (typeof b.doorId !== 'string' || !isAcceptableDoorKey(b.doorId)) return null;
  const out: StationBerthRecord = { roomId: b.roomId, doorId: b.doorId };
  if (typeof b.gate === 'number' && Number.isInteger(b.gate) && b.gate >= 1 && b.gate <= 99) out.gate = b.gate;
  return out;
}

/** A list of berths, cleaned, deduplicated by port and capped. */
export function cleanBerths(v: unknown): StationBerthRecord[] {
  if (!Array.isArray(v)) return [];
  const out: StationBerthRecord[] = [];
  const seen = new Set<string>();
  for (const item of v.slice(0, MAX_BERTHS * 4)) {
    if (out.length >= MAX_BERTHS) break;
    const b = cleanBerth(item);
    if (!b) continue;
    const key = `${b.roomId}\u0000${b.doorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
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
  /** Under its own thrusters. ('tug' comes with tugs.) */
  mode: 'thrusters';
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

function moveOf(station: MovingStation): StationMove | null {
  if (!moveResolver) return null;
  try {
    const m = moveResolver(station);
    return m && moveBelongsTo(m, station) ? m : null;
  } catch {
    return null;
  }
}

/** Where a station is listed at `nowMs` given its latest move: the move's
 *  destination once it has arrived, else where it left from (a move names
 *  where it leaves, so it supersedes any earlier one). */
function placeWithMove(
  r: MovingStation & { planetId: string; orbitSlot: number },
  nowMs: number,
): { planetId: string; orbitSlot: number; move?: StationMove } {
  const move = moveOf(r);
  if (!move) return { planetId: r.planetId, orbitSlot: r.orbitSlot };
  if (nowMs >= move.arriveAt) return { planetId: move.toPlanetId, orbitSlot: move.toSlot };
  return { planetId: move.fromPlanetId, orbitSlot: move.fromSlot, move };
}

/** Is the station between its departure and capture burns — gone from every
 *  planet's orbits, so no ship can reach it? */
export function stationInTransit(station: Pick<StationRecord, 'move'>, nowMs: number = Date.now()): boolean {
  const m = station.move;
  return !!m && nowMs >= m.departAt && nowMs < m.arriveAt;
}

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

/** Prefix of derived station ids — never accepted on a saved record. */
const DERIVED_PREFIX = 'station:';

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
    && !r.id.startsWith(DERIVED_PREFIX) && !RESERVED_BODY_IDS.has(r.id)
    && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= MAX_NAME_LENGTH
    && typeof r.planetId === 'string'
    && Number.isInteger(r.orbitSlot) && (r.orbitSlot as number) >= 0 && (r.orbitSlot as number) < MAX_ORBIT_SLOTS
    && typeof r.welcomeRoomId === 'string' && r.welcomeRoomId.length > 0
    && (r.berthDoor === undefined || (typeof r.berthDoor === 'string' && isAcceptableDoorKey(r.berthDoor)));
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

function clean(r: StationRecord): StationRecord {
  return {
    id: r.id,
    name: r.name,
    planetId: planetById(r.planetId).id,
    orbitSlot: r.orbitSlot,
    welcomeRoomId: r.welcomeRoomId,
    ...(r.berthDoor ? { berthDoor: r.berthDoor } : {}),
    ...(cleanBerths(r.berths).length > 0 ? { berths: cleanBerths(r.berths) } : {}),
  };
}

/** Save (or replace, by id) a station record on this install. Returns false
 *  for an invalid record, one that would shadow the built-in default, a solar
 *  map body or a derived station id, one whose planet has no free orbit slot
 *  left, or one whose welcome room is part of a station already listed. */
export function registerStation(record: Omit<StationRecord, 'derived'>): boolean {
  if (!isRecord(record) || record.id === DEFAULT_STATION_ID) return false;
  const records = readStationRecords();
  // Replace IN PLACE: slot clashes go to the earlier record, so moving a
  // renamed record to the back would swap it out of its slot.
  const at = records.findIndex((r) => r.id === record.id);
  if (at >= 0) records[at] = clean(record);
  else if (records.length >= MAX_RECORDS) return false;
  else records.push(clean(record));
  // Refuse a record the list would drop: its planet has no free slot, or its
  // welcome room already belongs to a listed station.
  if (!listStations(readAtlas(), records).some((s) => s.id === record.id)) return false;
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { return false; }
  return true;
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
 * dropped. Orbit slots are unique per planet — a record whose slot is taken
 * moves to the next free one, and derived stations fill free slots in anchor
 * order. This is the list ship destinations read from.
 */
export function listStations(
  atlas: Record<string, AtlasEntry> = readAtlas(),
  records: StationRecord[] = readStationRecords(),
  nowMs: number = Date.now(),
): StationRecord[] {
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
  const claim = (planetId: string, wanted: number): number | null => {
    const used = taken.get(planetId) ?? new Set<number>();
    taken.set(planetId, used);
    for (let i = 0; i < MAX_ORBIT_SLOTS; i++) {
      const slot = (wanted + i) % MAX_ORBIT_SLOTS;
      if (!used.has(slot)) { used.add(slot); return slot; }
    }
    return null;
  };

  const out: StationRecord[] = [];
  const places = new Set<string>();
  for (const r of [DEFAULT_STATION_RECORD, ...records]) {
    if (out.some((e) => e.id === r.id)) continue;
    const place = placeOf(r.welcomeRoomId);
    if (place && places.has(place)) continue;
    const at = placeWithMove(r, nowMs);
    const slot = claim(at.planetId, at.orbitSlot);
    if (slot === null) continue;
    if (place) places.add(place);
    const { move: _stale, ...rest } = r;
    out.push({ ...rest, planetId: planetById(at.planetId).id, orbitSlot: slot, ...(at.move ? { move: at.move } : {}) });
  }

  // Atlas ids and names can arrive from peers unbounded, so derived records
  // get the same limits a saved record must meet: an over-long room id cannot
  // anchor a station, and names are cut to length.
  const derived: Array<{ anchor: string; name: string }> = [];
  components.forEach((component, i) => {
    if (places.has(`component:${i}`)) return;
    const known = [...component]
      .filter((rid) => atlas[rid] && DERIVED_PREFIX.length + rid.length <= MAX_ID_LENGTH)
      .sort();
    const anchor = known[0];
    if (!anchor) return;
    // A room name is peer-written and not shape-checked on every path.
    const name: unknown = atlas[anchor].name;
    derived.push({ anchor, name: (typeof name === 'string' && name ? name : 'STATION').slice(0, MAX_NAME_LENGTH) });
  });
  derived.sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0));
  for (const d of derived) {
    const id = `${DERIVED_PREFIX}${d.anchor}`;
    // A derived station that has moved is listed where its move put it; one
    // that has not takes the lowest free slot around the default planet.
    const at = placeWithMove({ id, welcomeRoomId: d.anchor, planetId: DEFAULT_PLANET_ID, orbitSlot: 0 }, nowMs);
    const slot = claim(at.planetId, at.orbitSlot);
    if (slot === null) continue;
    out.push({
      id,
      name: d.name,
      planetId: planetById(at.planetId).id,
      orbitSlot: slot,
      welcomeRoomId: d.anchor,
      derived: true,
      ...(at.move ? { move: at.move } : {}),
    });
  }
  return out.map((st) => withBerths(st, atlas));
}

/**
 * ⚓🚦 A listed station with its gates: the atlas's (every dock port of the
 * station, free or docked) when it knows any, else the list the record
 * carries, else its plain berthDoor. A record naming no berthDoor gets the
 * lowest gate in its welcome room as one, for builds that read only that.
 */
function withBerths(st: StationRecord, atlas: Record<string, AtlasEntry>): StationRecord {
  const gates = stationGates(atlas, st.welcomeRoomId);
  let berths: StationBerthRecord[];
  if (gates.length > 0) {
    berths = gates.slice(0, MAX_BERTHS).map((g) => ({
      roomId: g.roomId, doorId: g.doorId, gate: g.gate, ...(g.occupied ? { occupied: true } : {}),
    }));
  } else if (st.berths && st.berths.length > 0) {
    berths = st.berths;
  } else if (st.berthDoor && st.welcomeRoomId) {
    berths = [{ roomId: st.welcomeRoomId, doorId: st.berthDoor }];
  } else {
    berths = [];
  }
  const out: StationRecord = { ...st };
  if (berths.length > 0) out.berths = berths; else delete out.berths;
  if (!out.berthDoor) {
    const inWelcome = berths.find((b) => b.roomId === st.welcomeRoomId);
    if (inWelcome) out.berthDoor = inWelcome.doorId;
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
  if (own && (!own.derived || atlasComponent(atlas, roomId).size > 1)) return null;
  const partners: string[] = [];
  for (const rec of doors) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    if (!isBerthDoor(rec)) return null; // bolted into a station: the atlas places it
    const partner = roomIdFromSeed(rec.connectedRoomAddress);
    if (partner && partner !== roomId) partners.push(partner);
  }
  for (const partner of partners) {
    const there = atlasStationForRoom(partner, atlas, stations);
    if (!there || there.id === own?.id) continue;
    if (!there.derived || atlasComponent(atlas, there.welcomeRoomId).size > 1) return there.id;
  }
  return null;
}

/** The planet a room's station orbits — the default planet when unknown. */
export function planetForRoom(roomId: string, atlas: Record<string, AtlasEntry> = readAtlas()): PlanetRecord {
  return planetById(stationForRoom(roomId, atlas)?.planetId);
}

// ── The current station ──────────────────────────────────────────────────────

let currentRoomGetter: () => string = () => '';

/** main.ts injects the room the player is standing in (no import cycle). */
export function setStationRoomSource(cb: () => string): void {
  currentRoomGetter = cb;
}

/** The station the player is in now, or null before the atlas knows the room. */
export function currentStation(): StationRecord | null {
  return stationForRoom(currentRoomGetter());
}
