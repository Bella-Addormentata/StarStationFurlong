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
   *  berth; an empty list means known to have none. `berthDoor` stays for older builds: listStations sets it to the
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
  if (typeof b.doorId !== 'string' || !isAcceptableDoorKey(b.doorId)) return null;
  const out: StationBerthRecord = { roomId: b.roomId, doorId: b.doorId };
  if (typeof b.gate === 'number' && Number.isInteger(b.gate) && b.gate >= 1 && b.gate <= 99) out.gate = b.gate;
  if (b.access === 'pass' || b.access === 'closed') out.access = b.access;
  else if (b.access === 'reserved' && typeof b.reservedFor === 'string'
    && b.reservedFor.length > 0 && b.reservedFor.length <= MAX_ID_LENGTH) {
    out.access = 'reserved';
    out.reservedFor = b.reservedFor;
  }
  return out;
}

/** A list of berths, cleaned, deduplicated by port and capped. */
export function cleanBerths(v: unknown): StationBerthRecord[] {
  // A longer list than any station lists is junk, not a prefix to trust:
  // duplicates could otherwise push a real gate past the cut.
  if (!Array.isArray(v) || v.length > MAX_BERTHS * 4) return [];
  const valid: StationBerthRecord[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const b = cleanBerth(item);
    if (!b) continue;
    const key = `${b.roomId}\u0000${b.doorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(b);
  }
  // One slot per gate number first (as cleanGates): ports repeating a number,
  // or with none, only fill what is left, so they cannot crowd a gate out.
  const numbers = new Set<number>();
  const firsts: StationBerthRecord[] = [];
  const rest: StationBerthRecord[] = [];
  for (const b of valid) {
    if (b.gate !== undefined && !numbers.has(b.gate)) { numbers.add(b.gate); firsts.push(b); } else rest.push(b);
  }
  const out = [...firsts, ...rest].slice(0, MAX_BERTHS);
  // In gate order whatever order a peer sent (unnumbered berths last, then
  // by room and door), so arrivals try the lowest gate first.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return out.sort((x, y) => (x.gate ?? Infinity) - (y.gate ?? Infinity)
    || cmp(x.roomId, y.roomId) || cmp(x.doorId, y.doorId));
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
   *  towed by a tug (a torch flight that leaves at once). */
  mode: 'thrusters' | 'tug';
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

/** Where a station is listed at `nowMs` given its latest move: the move's
 *  destination once it has arrived, else where it left from (a move names
 *  where it leaves, so it supersedes any earlier one). */
function placeWithMove(
  r: { planetId: string; orbitSlot: number },
  move: StationMove | null,
  nowMs: number,
): { planetId: string; orbitSlot: number; move?: StationMove } {
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

function readArrivalOutcome(station: string, move: string): ArrivalOutcome | null {
  const e = readArrivalOutcomes().find((x) => x[0] === station);
  return e && e[1] === move ? e[2] : null;
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
const CORE_FIELDS = new Set(['id', 'name', 'planetId', 'orbitSlot', 'welcomeRoomId', 'berthDoor', 'berths', 'derived']);

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
 *  map body or a derived station id, one whose planet has no free orbit slot
 *  left (or would have none for a station already saved), or one whose
 *  welcome room is part of a station already listed. */
export function registerStation(record: Omit<StationRecord, 'derived'>): boolean {
  if (!isRecord(record) || record.id === DEFAULT_STATION_ID) return false;
  const saved = readStationRecords();
  const records = [...saved];
  // Replace IN PLACE: when two records name one place the earlier keeps it,
  // and the list keeps record order.
  const at = records.findIndex((r) => r.id === record.id);
  if (at >= 0) records[at] = clean(record);
  else if (records.length >= MAX_RECORDS) return false;
  else records.push(clean(record));
  // Refuse a record the list would drop (its planet has no free slot, or its
  // welcome room already belongs to a listed station), and one that would
  // drop a saved station instead: winning that station's slot on a full
  // planet, or taking its place.
  const atlas = readAtlas();
  const listed = new Set(listStations(atlas, records).map((s) => s.id));
  if (!listed.has(record.id)) return false;
  if (listStations(atlas, saved).some((s) => !s.derived && s.id !== record.id && !listed.has(s.id))) return false;
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
 * dropped. Orbit slots are unique per planet — a record that loses a clash
 * for its slot moves to the next free one, settled the same way on every
 * install whatever order it saved its records in, and derived stations fill
 * free slots in anchor order. This is the list ship destinations read from.
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
  const used = (planetId: string): Set<number> => {
    let slots = taken.get(planetId);
    if (!slots) taken.set(planetId, slots = new Set());
    return slots;
  };
  const claim = (planetId: string, wanted: number): number | null => {
    const slots = used(planetId);
    for (let i = 0; i < MAX_ORBIT_SLOTS; i++) {
      const slot = (wanted + i) % MAX_ORBIT_SLOTS;
      if (!slots.has(slot)) { slots.add(slot); return slot; }
    }
    return null;
  };
  // Every candidate first — records in list order (one per id, one per
  // place; an unknown planet reads as the default one), then one derived
  // station per unclaimed atlas component — each with its latest move read
  // once.
  interface Candidate {
    id: string;
    welcomeRoomId: string;
    base: { planetId: string; orbitSlot: number };
    move: StationMove | null;
    make: (planetId: string, orbitSlot: number, move: StationMove | undefined) => StationRecord;
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
    const { move: _stale, ...rest } = r;
    candidates.push({
      id: r.id,
      welcomeRoomId: r.welcomeRoomId,
      base: { planetId: planetById(r.planetId).id, orbitSlot: r.orbitSlot },
      move: moveOf(r),
      make: (planetId, orbitSlot, move) => ({ ...rest, planetId, orbitSlot, ...(move ? { move } : {}) }),
    });
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
      make: (planetId, orbitSlot, move) => ({
        id, name: d.name, planetId, orbitSlot, welcomeRoomId: d.anchor, derived: true, ...(move ? { move } : {}),
      }),
    });
  }

  // Where each candidate wants to be now: its record, or its move's end
  // once arrived (an arrival that found its new planet full stays where it
  // left from — see below).
  const settledAt = (c: Candidate) => (c.move && nowMs >= c.move.arriveAt ? c.move.arriveAt : -Infinity);
  const spots: Array<{ planetId: string; orbitSlot: number; move?: StationMove } | null> = candidates.map(() => null);
  const wantOf = candidates.map((c) => {
    const at = placeWithMove(c.base, c.move, nowMs);
    return { ...at, planetId: planetById(at.planetId).id };
  });

  // Slots are settled in one global order, never this install's record
  // order, so every install holding the same stations gives each the same
  // slot. The built-in default claims first, as it is the same everywhere;
  // then the stations that have been where they are longest: those that
  // never moved (or are still waiting or on their way), each wanted slot to
  // the smallest welcome room id, the clash losers after them to the next
  // free slot on; then arrivals in the order they arrived. A clash moves only
  // the station that lost it, and a newcomer never pushes out an incumbent.
  // Derived stations follow saved records among those that never moved.
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
  const inTransit = (i: number) => stationInTransit({ move: candidates[i].move ?? undefined }, nowMs);
  if (builtIn === 0 && inTransit(0)) settle(0, wantOf[0].planetId, wantOf[0].orbitSlot);
  else if (builtIn === 0) {
    const slot = claim(wantOf[0].planetId, wantOf[0].orbitSlot);
    if (slot !== null) settle(0, wantOf[0].planetId, slot);
  }
  for (const i of rest.filter(inTransit)) settle(i, wantOf[i].planetId, wantOf[i].orbitSlot);
  for (const group of [rest.filter((i) => i < firstDerived && !inTransit(i)), rest.filter((i) => i >= firstDerived && !inTransit(i))]) {
    const lost: number[] = [];
    for (const i of [...group].sort(globalOrder)) {
      const { planetId, orbitSlot } = wantOf[i];
      const slots = used(planetId);
      const free = Number.isInteger(orbitSlot) && orbitSlot >= 0 && orbitSlot < MAX_ORBIT_SLOTS && !slots.has(orbitSlot);
      if (free) { slots.add(orbitSlot); settle(i, planetId, orbitSlot); } else lost.push(i);
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
    const station = candidates[i].welcomeRoomId || candidates[i].id;
    const outcomeKey = [m.departAt, m.arriveAt, m.bookedAt ?? m.departAt, m.fromPlanetId, m.fromSlot,
      m.toPlanetId, m.toSlot, m.mode, m.tugRoomId ?? '', m.settles ? m.settles.departAt : ''].join('|');
    let outcome = readArrivalOutcome(station, outcomeKey);
    if (!outcome) {
      const dest = planetById(m.toPlanetId).id;
      // The slots taken there at T, not the stations: two that share a slot
      // (an arrival that found every planet full) leave the others free.
      const taken = new Set<number>();
      candidates.forEach((o, j) => {
        if (j === i) return;
        if (settledAt(o) <= T) {
          if (spots[j]?.planetId === dest) taken.add(spots[j]!.orbitSlot);
          return;
        }
        // One between planets at T held no slot anywhere.
        if (stationInTransit({ move: o.move ?? undefined }, T)) return;
        const place = placeWithMove(o.base, o.move, T);
        if (planetById(place.planetId).id === dest) taken.add(place.orbitSlot);
      });
      outcome = taken.size >= MAX_ORBIT_SLOTS ? 'bounced' : 'arrived';
      writeArrivalOutcome(station, outcomeKey, outcome);
    }
    if (outcome === 'bounced') at = { planetId: planetById(m.fromPlanetId).id, orbitSlot: m.fromSlot };
    const slot = claim(at.planetId, at.orbitSlot);
    // Its planet full (it left its old slot in transit): it stays where its
    // move put it, sharing that slot, rather than drop out of the list or
    // turn up at another planet no transfer took it to.
    settle(i, at.planetId, slot ?? at.orbitSlot);
  }

  // Listed in record order, derived stations last. A station that never
  // moved and finds no slot (its planet is full) is dropped.
  const out: StationRecord[] = [];
  candidates.forEach((c, i) => {
    const spot = spots[i];
    if (spot) out.push(c.make(spot.planetId, spot.orbitSlot, spot.move));
  });
  return out.map((st) => withBerths(st, atlas));
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
  const learned = (st.berths ?? []).filter((b) => unknown(b.roomId));
  if (gates.length > 0) {
    const seen: StationBerthRecord[] = gates.map((g) => ({
      roomId: g.roomId, doorId: g.doorId, gate: g.gate, ...(g.occupied ? { occupied: true } : {}),
      ...(g.access ? { access: g.access, ...(g.reservedFor ? { reservedFor: g.reservedFor } : {}) } : {}),
    }));
    berths = [...seen, ...learned]
      .map((b, i) => ({ b, i }))
      .sort((x, y) => (x.b.gate ?? MAX_BERTHS + 1) - (y.b.gate ?? MAX_BERTHS + 1) || x.i - y.i)
      .map((x) => x.b)
      .slice(0, MAX_BERTHS);
  } else {
    berths = learned;
    // An empty list means "known to have none" (a summary's, or this atlas's
    // own harvest of the welcome room): only an unknown station falls back.
    knownNone = Array.isArray(st.berths) || (!!st.welcomeRoomId && !unknown(st.welcomeRoomId));
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
  if (own && (!own.derived || atlasComponent(atlas, roomId).size > 1)) return null;
  const partners: string[] = [];
  for (const rec of doors) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    // Only an address that names a room is a pairing (as stationKeeping's
    // isBoltedIntoStation reads it): peer-written junk beside a real dock
    // neither bolts the room in nor hides that dock.
    let partner = '';
    try { partner = roomIdFromSeed(rec.connectedRoomAddress); } catch { partner = ''; }
    if (!partner) continue;
    if (!isBerthDoor(rec)) return null; // bolted into a station: the atlas places it
    if (partner !== roomId) partners.push(partner);
  }
  for (const partner of partners) {
    const there = atlasStationForRoom(partner, atlas, stations);
    if (!there || there.id === own?.id) continue;
    if (!there.derived || atlasComponent(atlas, there.welcomeRoomId).size > 1) return there.id;
  }
  return null;
}

/** The planet a room's station orbits — the default planet when unknown. */
/** Where a ship that missed a departed station waits: open orbit at the
 *  planet and slot that station left (`adrift:<planetId>:<slot>`). A place,
 *  never a station, so it follows no station anywhere; hops leave from it to
 *  the stations around that planet like from any orbit. */
export const ADRIFT_PREFIX = 'adrift:';

export function adriftAt(planetId: string, orbitSlot: number): string {
  return `${ADRIFT_PREFIX}${planetId}:${orbitSlot}`;
}

/** The planet and slot an adrift location names, or null for anything else. */
export function adriftPlace(id: string): { planetId: string; orbitSlot: number } | null {
  if (typeof id !== 'string' || !id.startsWith(ADRIFT_PREFIX)) return null;
  const rest = id.slice(ADRIFT_PREFIX.length);
  const cut = rest.lastIndexOf(':');
  const planetId = rest.slice(0, cut);
  const orbitSlot = Number(rest.slice(cut + 1));
  if (cut <= 0 || !Number.isInteger(orbitSlot) || orbitSlot < 0 || orbitSlot >= MAX_ORBIT_SLOTS) return null;
  return { planetId, orbitSlot };
}

/** Where the room resolver puts a room when that is open orbit (a ship
 *  adrift: its flight record's location), or null — a station, or unknown. */
export function roomAdriftPlace(roomId: string): { planetId: string; orbitSlot: number } | null {
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
