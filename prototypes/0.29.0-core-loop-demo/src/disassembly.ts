/**
 * 🔧 Module disassembly — the Disassemble robot job (#192)
 *
 * Disconnecting a module is quick (UNDOCK on its door panel); taking one
 * apart takes labor hours. Dorkmo's pick (2026-10-03): a robot job. A
 * charging dock's robot programmed "Disassemble module" works at the door
 * to a neighbouring module, the labor runs on the orbital clock (60x, so one
 * labor hour is one real minute of one robot's work), more robots on the
 * same module finish it sooner, and when the hours are done the module comes
 * off the station and out of every map.
 *
 * The job lives in the room doc's `robot` map beside the robots' configs
 * (robotDoc.ts), one record per module being taken apart. Its crew is not
 * stored in it: the crew is every robot whose config is set to the module
 * and not stopped, so each robot's membership rides on its own config key
 * and concurrent edits to different robots never overwrite each other. Its
 * progress is a pure function of the clock: the labor done as of `asOf`,
 * plus the crew working since then. Every change to the crew settles the
 * progress first, so the clock is never read backwards and nothing has to
 * be written while the robots simply work.
 *
 * Pure: no DOM, no docs. Pinned by disassembly.test.ts.
 */

import type { AtlasEntry } from './stationAtlas';
import { berthDoorIds, isSaneDims, roomIdFromSeed } from './stationAtlas';
import type { DoorRecord } from './doorsDoc';
import { isDockChain } from './adapter';
import { realMsFor } from './orbits';
import { legacyOwnerMarker } from './roomOwner';

/** Labor hours per floor tile: a default 2 × 2 module is 24 labor hours,
 *  24 real minutes for one robot; the largest, 5 × 5, is 150. */
export const LABOR_HOURS_PER_TILE = 6;

/** A module whose size the atlas never learned (or holds out of range) is
 *  costed as the default room. */
const FALLBACK_DIMS = { cols: 2, rows: 2 };

/** Most robots one job counts (a room holds few docks; a peer's junk list
 *  must not multiply the pace). */
export const MAX_CREW = 16;

const MAX_ID = 128;
const MAX_NAME = 64;
const MAX_DOOR_ID = 64;
/** The largest module's labor, with room to spare: 5 × 5 tiles at the rate. */
const MAX_LABOR_HOURS = 1000;

/** The module a robot can be set to take apart. */
export interface DisassemblyTarget {
  /** The module's room id. */
  roomId: string;
  /** Its name when the job began (a label only). */
  name: string;
  /** This room's door to it, where the robots work. */
  doorId: string;
  laborHours: number;
}

/** A job as the room doc stores it. */
export interface DisassemblyJobRecord extends DisassemblyTarget {
  startedAt: number;
  /** Labor done as of `asOf`, in real ms of one robot's work. */
  doneMs: number;
  asOf: number;
  /** When the labor ran out and the job ended (absent: still open). */
  finishedAt?: number;
  /** removed: the module came off the station. detached: it was no longer
   *  joined to this room when the labor ran out, so nothing was removed. */
  outcome?: 'removed' | 'detached';
}

/** A job as read: its record, and its crew, the charging docks whose robots
 *  are set to the module and not stopped (robotDoc.ts reads it from their
 *  configs, sorted, at most MAX_CREW). */
export interface DisassemblyJob extends DisassemblyJobRecord {
  crew: string[];
}

/** Labor hours to take apart a module of this size. */
export function laborHoursFor(dims?: { cols: number; rows: number }): number {
  const d = dims && isSaneDims(dims) ? dims : FALLBACK_DIMS;
  return LABOR_HOURS_PER_TILE * d.cols * d.rows;
}

/** Real ms one robot works for `hours` labor hours (the orbital clock). */
export function laborMsFor(hours: number): number {
  return realMsFor(hours * 3600);
}

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Shape guard: a job record crosses the room-doc trust boundary (peer
 *  writes). Its labor can't be more than a full crew could have done since
 *  it started, nor more than the job takes. */
export function isDisassemblyJobRecord(v: unknown): v is DisassemblyJobRecord {
  if (typeof v !== 'object' || v === null) return false;
  const j = v as Partial<DisassemblyJobRecord>;
  return isStr(j.roomId, MAX_ID)
    && typeof j.name === 'string' && j.name.length <= MAX_NAME
    && isStr(j.doorId, MAX_DOOR_ID)
    && typeof j.laborHours === 'number' && Number.isFinite(j.laborHours)
    && j.laborHours > 0 && j.laborHours <= MAX_LABOR_HOURS
    && isTime(j.startedAt) && isTime(j.doneMs) && isTime(j.asOf)
    && j.asOf >= j.startedAt
    && j.doneMs <= laborMsFor(j.laborHours)
    && j.doneMs <= MAX_CREW * (j.asOf - j.startedAt)
    && (j.finishedAt === undefined || isTime(j.finishedAt))
    && (j.outcome === undefined || j.outcome === 'removed' || j.outcome === 'detached');
}

/** Labor the job takes, in real ms of one robot's work. */
export function jobLaborMs(job: Pick<DisassemblyJob, 'laborHours'>): number {
  return laborMsFor(job.laborHours);
}

/** Labor done by `now` (real ms of one robot's work), never past the total. */
export function workedMs(job: DisassemblyJob, now: number): number {
  const total = jobLaborMs(job);
  if (job.finishedAt !== undefined) return total;
  return Math.min(total, job.doneMs + job.crew.length * Math.max(0, now - job.asOf));
}

/** The job's record with its progress folded in at `now`, as worked by its
 *  crew until then: what a crew change writes first. A clock behind `asOf`
 *  (another writer's ran ahead) changes nothing. */
export function settleJob(job: DisassemblyJob, now: number): DisassemblyJobRecord {
  const { crew: _crew, ...record } = job;
  if (now <= job.asOf) return record;
  return { ...record, doneMs: workedMs(job, now), asOf: now };
}

/** When the labor runs out at the current crew, or null (nobody working, or
 *  already finished). Deterministic, so every client finishing the job
 *  writes the same time. */
export function jobDueAt(job: DisassemblyJob): number | null {
  if (job.finishedAt !== undefined || job.crew.length === 0) return null;
  const left = jobLaborMs(job) - job.doneMs;
  return left <= 0 ? job.asOf : job.asOf + Math.ceil(left / job.crew.length);
}

/** Fraction of the labor done by `now`, 0 to 1. */
export function jobFraction(job: DisassemblyJob, now: number): number {
  const total = jobLaborMs(job);
  return total > 0 ? Math.min(1, workedMs(job, now) / total) : 1;
}

/** Labor hours still to do at `now`. */
export function laborHoursLeft(job: DisassemblyJob, now: number): number {
  return Math.max(0, job.laborHours * (1 - jobFraction(job, now)));
}

/** One line on where the job stands, for the console and the holotable. */
export function jobStatusText(job: DisassemblyJob, now: number, blocked: string | null = null): string {
  if (job.finishedAt !== undefined) {
    return job.outcome === 'detached'
      ? `${job.name} was disconnected before the work was done; nothing was taken apart.`
      : `${job.name} was taken apart and is off the station.`;
  }
  const pct = Math.floor(jobFraction(job, now) * 100);
  const left = laborHoursLeft(job, now);
  if (left <= 0) {
    // The room's owner's game takes it off (world.ts), at once when they are here.
    return blocked ? `Work done, but it can't come off yet: ${blocked}.` : "Work done; it comes off once the room's owner is here.";
  }
  const hours = `${Math.ceil(left)} labor hour${Math.ceil(left) === 1 ? '' : 's'} left`;
  if (job.crew.length === 0) return `${pct}% · ${hours} · paused, no robot working on it`;
  const realMin = Math.ceil(laborMsFor(left) / job.crew.length / 60_000);
  const robots = `${job.crew.length} robot${job.crew.length === 1 ? '' : 's'}`;
  return `${pct}% · ${hours} · ${robots} · about ${realMin} min at this pace`;
}

// ── What can be taken apart ──────────────────────────────────────────────────

export interface DisassemblyCandidate extends DisassemblyTarget {
  /** Every door of this room joined to it (all are sealed at the end). */
  doorIds: string[];
  /** Why it can't be taken apart now, or null. */
  blocked: string | null;
}

export interface CandidateInput {
  /** The station atlas as the maps see it (readAtlas). */
  atlas: Record<string, AtlasEntry>;
  /** The room the robots are in. */
  hereRoomId: string;
  /** That room's door records (doorsDoc readAllDoors). */
  doors: ReadonlyMap<string, DoorRecord>;
  /** The local player's id (roomInfo.owner's vocabulary). */
  playerId: string;
  /** The station's welcome room: its front door, never taken apart. */
  welcomeRoomId?: string | null;
  /** True for rooms this install minted (stationParts ledger): its own
   *  modules, whose owner the atlas may not have learned yet. */
  minted?: (roomId: string) => boolean;
}

/** This room's structural doors, grouped by the module behind them: paired,
 *  not a visiting ship's berth (transient or a DOCK). */
function structuralNeighbours(input: CandidateInput): Map<string, Array<{ doorId: string; address: string }>> {
  const out = new Map<string, Array<{ doorId: string; address: string }>>();
  for (const [doorId, rec] of input.doors) {
    if (rec.paired !== true || !rec.connectedRoomAddress) continue;
    if (rec.transient === true || isDockChain(rec.segments)) continue;
    let roomId = '';
    try { roomId = roomIdFromSeed(rec.connectedRoomAddress); } catch { roomId = ''; }
    if (!roomId || roomId === input.hereRoomId) continue;
    const list = out.get(roomId) ?? [];
    list.push({ doorId, address: rec.connectedRoomAddress });
    out.set(roomId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.doorId.localeCompare(b.doorId));
  return out;
}

/**
 * Why `roomId` can't come off the station now, or null. Checked when a robot
 * is set to it and again when the labor runs out:
 *  - the station's welcome room stays (the station is known by it);
 *  - its own doors must be known (the atlas has its layout, seen from inside
 *    or gossiped): without them, what else it is joined to is unknown;
 *  - only its owner takes a module apart (one with no verified owner may be
 *    taken apart by this room's owner, as the console is owner-only; one
 *    this install minted, whose owner the atlas never learned, likewise);
 *  - it must hang only off this room: a module still joined to another, or
 *    with a ship docked at it, would leave that one cut off.
 */
export function removalBlocker(input: CandidateInput, roomId: string): string | null {
  const { atlas } = input;
  if (input.welcomeRoomId && roomId === input.welcomeRoomId) return "it is the station's welcome room";
  const entry = atlas[roomId];
  if (!entry || Object.keys(entry.doors ?? {}).length === 0) return "its layout isn't known yet; step inside it once";
  const owner = entry.owner;
  if (owner === undefined) {
    if (!input.minted?.(roomId)) return "its owner isn't known yet; step inside it once";
  } else if (owner !== null && !legacyOwnerMarker(owner.id) && owner.id !== input.playerId) {
    return `it belongs to ${owner.name || 'someone else'}`;
  }
  // Its other connections, as the atlas knows them: its own records and any
  // record pointing at it, berths included.
  const berths = berthDoorIds(atlas);
  const nameOf = (rid: string) => atlas[rid]?.name || 'another module';
  for (const [doorId, door] of Object.entries(entry.doors)) {
    const other = door?.targetRoomId;
    if (!other || other === input.hereRoomId || other === roomId) continue;
    return berths.get(roomId)?.has(doorId) ? 'a ship is docked at it' : `it is still joined to ${nameOf(other)}`;
  }
  for (const e of Object.values(atlas)) {
    if (!e?.roomId || e.roomId === roomId || e.roomId === input.hereRoomId) continue;
    for (const [doorId, door] of Object.entries(e.doors ?? {})) {
      if (door?.targetRoomId !== roomId) continue;
      return berths.get(e.roomId)?.has(doorId) ? 'a ship is docked at it' : `it is still joined to ${nameOf(e.roomId)}`;
    }
  }
  return null;
}

/** The modules this room's robots could take apart: every module joined to
 *  this room by a structural door, each with its labor and what blocks it. */
export function disassemblyCandidates(input: CandidateInput): DisassemblyCandidate[] {
  const out: DisassemblyCandidate[] = [];
  for (const [roomId, doors] of structuralNeighbours(input)) {
    const entry = input.atlas[roomId];
    out.push({
      roomId,
      name: (entry?.name || 'Module').slice(0, MAX_NAME),
      doorId: doors[0].doorId,
      doorIds: doors.map((d) => d.doorId),
      laborHours: laborHoursFor(entry?.dims),
      blocked: removalBlocker(input, roomId),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.roomId.localeCompare(b.roomId));
}

/** This room's structural doors joined to `roomId` now, with their
 *  addresses: what the end of a job seals. */
export function doorsJoinedTo(input: Pick<CandidateInput, 'doors' | 'hereRoomId'>, roomId: string): Array<{ doorId: string; address: string }> {
  return structuralNeighbours({ ...input, atlas: {}, playerId: '' }).get(roomId) ?? [];
}
