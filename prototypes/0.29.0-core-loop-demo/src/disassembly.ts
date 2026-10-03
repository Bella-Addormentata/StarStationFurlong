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
 * and not stopped, its dock placed in the room's layout, so each robot's
 * membership rides on its own config key and concurrent edits to different
 * robots never overwrite each other. Nor is its progress: each robot keeps
 * its own record of the labor it did on the job (DisassemblyWork), written
 * when that robot starts or stops working on it, and the job's progress is
 * the sum of them. So two clients changing two robots at once never write
 * the same value, and neither can credit one robot with time that only the
 * other knew it spent stopped. Progress is a pure function of the clock:
 * each robot's labor as of its last record, plus the time the working ones
 * have worked since, so the clock is never read backwards and nothing has
 * to be written while the robots simply work.
 *
 * Pure: no DOM, no docs. Pinned by disassembly.test.ts.
 */

import type { AtlasEntry } from './stationAtlas';
import { berthDoorIds, isSaneDims, ownValue, roomIdFromSeed } from './stationAtlas';
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

/** Most robots that work on one job at once (a room holds few docks): one
 *  set to it while that many work waits on its dock until one stops
 *  (workingCrew, robotDoc.ts). Nor can a job's own record claim more labor
 *  than that many robots could have done. */
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
  /** Labor done as of `asOf`, in real ms of one robot's work, besides its
   *  robots' own records: none while it is open (a job opens with 0 as of
   *  `startedAt`), all of it once it has ended. */
  doneMs: number;
  asOf: number;
  /** When the labor ran out and the job ended (absent: still open). */
  finishedAt?: number;
  /** removed: the module came off the station. detached: it was no longer
   *  joined to this room when the labor ran out, so nothing was removed. */
  outcome?: 'removed' | 'detached';
}

/** A job as read (jobFromWork): its record, with its robots' labor folded
 *  into `doneMs` as of `asOf`, and its crew, the placed charging docks whose
 *  robots are set to the module, not stopped, and working on it, sorted. */
export interface DisassemblyJob extends DisassemblyJobRecord {
  crew: string[];
}

/** 🔧 One robot's labor on one job, as the room doc stores it (robotDoc's
 *  `work:` keys): what it had done as of `asOf`, and whether it has been
 *  working since. Written only when that robot starts or stops working on
 *  the job, from its own config; a job opened again on the same module
 *  (another `startedAt`) counts none of the old job's. */
export interface DisassemblyWork {
  roomId: string;
  dockId: string;
  /** The `startedAt` of the job it was done on. */
  startedAt: number;
  /** Labor done as of `asOf`, in real ms of this robot's work. */
  ms: number;
  asOf: number;
  /** Working since `asOf`. */
  working: boolean;
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
 *  writes). An open job has no outcome, and no more labor of its own than a
 *  full crew could have done since it started, nor more than the job takes;
 *  an ended one says how it ended and has all its labor done, settled when
 *  it ended (as finishDisassemblyJob writes it, however many robots
 *  worked). */
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
    && (j.finishedAt === undefined
      ? j.outcome === undefined && j.doneMs <= MAX_CREW * (j.asOf - j.startedAt)
      : isTime(j.finishedAt)
        && (j.outcome === 'removed' || j.outcome === 'detached')
        && j.asOf === j.finishedAt
        && j.doneMs === laborMsFor(j.laborHours));
}

/** Shape guard for a robot's work record (peer writes, like the job's). A
 *  robot can't have worked longer than its job has been open. */
export function isDisassemblyWork(v: unknown): v is DisassemblyWork {
  if (typeof v !== 'object' || v === null) return false;
  const w = v as Partial<DisassemblyWork>;
  return isStr(w.roomId, MAX_ID) && isStr(w.dockId, MAX_ID)
    && isTime(w.startedAt) && isTime(w.ms) && isTime(w.asOf)
    && w.ms <= w.asOf - w.startedAt
    && typeof w.working === 'boolean';
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

/** 🔧 A robot's work record once it starts (or starts again) on `record`'s
 *  job at `now`: its labor there so far kept (none from a job opened before
 *  on the same module), its clock running from then. A clock behind its
 *  last record starts it at that record instead. */
export function startWork(
  record: Pick<DisassemblyJobRecord, 'roomId' | 'startedAt'>,
  dockId: string,
  prior: DisassemblyWork | undefined,
  now: number,
): DisassemblyWork {
  const same = prior?.roomId === record.roomId && prior.startedAt === record.startedAt;
  const ms = same ? prior.ms : 0;
  return {
    roomId: record.roomId, dockId, startedAt: record.startedAt, ms,
    asOf: Math.max(now, record.startedAt + ms, same ? prior.asOf : 0),
    working: true,
  };
}

/** 🔧 A working robot's record once it stops at `now`: the time since its
 *  last record is labor it did. A clock behind that record adds none. */
export function stopWork(work: DisassemblyWork, now: number): DisassemblyWork {
  const at = Math.max(now, work.asOf);
  return { ...work, ms: work.ms + (at - work.asOf), asOf: at, working: false };
}

/** 🔧 The job as read: `record` with the labor of its robots' records folded
 *  in as of the latest of them (or the record's own `asOf`), so workedMs and
 *  jobDueAt read it as one crew working since then. The crew is
 *  workingCrew's (its record says it works, it is still set to the job:
 *  in `active`, not stopped, its dock placed); a robot outside it adds what
 *  its record holds and no more. An ended job keeps its record's labor and
 *  has no crew. */
export function jobFromWork(
  record: DisassemblyJobRecord,
  work: Iterable<DisassemblyWork>,
  active: ReadonlySet<string>,
): DisassemblyJob {
  if (record.finishedAt !== undefined) return { ...record, crew: [] };
  const mine = [...work].filter((w) => w.roomId === record.roomId && w.startedAt === record.startedAt);
  const asOf = mine.reduce((t, w) => Math.max(t, w.asOf), record.asOf);
  const crew = workingCrew(mine, active);
  let done = record.doneMs;
  for (const w of mine) {
    done += w.ms;
    if (crew.has(w.dockId)) done += asOf - w.asOf;
  }
  return { ...record, doneMs: Math.min(jobLaborMs(record), done), asOf, crew: [...crew].sort() };
}

/** 🔧 Which robots work on a job, from its records (`work`, all of the one
 *  job): those whose record says they work and that are still set to it
 *  (`active`), at most MAX_CREW of them, the earliest started first (then
 *  by dock id), the same on every client. One past them (two clients each
 *  started a robot at once) is not counted, so its time is never labor:
 *  robotDoc stops its record uncredited and starts it again when a place
 *  in the crew frees. */
export function workingCrew(work: Iterable<DisassemblyWork>, active: ReadonlySet<string>): Set<string> {
  const working = [...work].filter((w) => w.working && active.has(w.dockId));
  working.sort((a, b) => a.asOf - b.asOf || (a.dockId < b.dockId ? -1 : a.dockId > b.dockId ? 1 : 0));
  return new Set(working.slice(0, MAX_CREW).map((w) => w.dockId));
}

/** When the labor runs out at the current crew, or null (already finished,
 *  or labor left and nobody working). A job whose labor is all done is due
 *  as of then, crew or not: its last robot may have been stopped or moved
 *  while it waited on a blocker or the room's owner. Deterministic, so every
 *  client finishing the job writes the same time. */
export function jobDueAt(job: DisassemblyJob): number | null {
  if (job.finishedAt !== undefined) return null;
  const left = jobLaborMs(job) - job.doneMs;
  if (left <= 0) return job.asOf;
  return job.crew.length === 0 ? null : job.asOf + Math.ceil(left / job.crew.length);
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
    // The deed holder's game takes it off (world.ts), at once when they are here.
    return blocked ? `Work done, but it can't come off yet: ${blocked}.` : "Work done; it comes off once the room's owner is here.";
  }
  const hours = `${Math.ceil(left)} labor hour${Math.ceil(left) === 1 ? '' : 's'} left`;
  if (job.crew.length === 0) return `${pct}% · ${hours} · paused, no robot working on it`;
  const realMin = Math.ceil(laborMsFor(left) / job.crew.length / 60_000);
  const robots = `${job.crew.length} robot${job.crew.length === 1 ? '' : 's'}`;
  return `${pct}% · ${hours} · ${robots} · about ${realMin} min at this pace`;
}

/** What a crew robot last said about its job: which job (its module, and
 *  when it was opened), and the tenth of the labor. */
export interface JobAnnouncement {
  roomId: string;
  startedAt: number;
  tenth: number;
}

/** The line a crew robot says now, `fraction` of the way through its job,
 *  and what it has then said; null when it has said it already. One line on
 *  starting on a job (a robot set to another module, or to a job opened
 *  again, starts over there) and one at each tenth of the labor. */
export function jobAnnouncement(
  job: Pick<DisassemblyJob, 'roomId' | 'startedAt' | 'name' | 'laborHours'>,
  fraction: number,
  said: JobAnnouncement | undefined,
): { text: string; said: JobAnnouncement } | null {
  const tenth = Math.floor(Math.min(1, Math.max(0, fraction)) * 10);
  const onIt = said !== undefined && said.roomId === job.roomId && said.startedAt === job.startedAt;
  if (onIt && said.tenth === tenth) return null;
  const text = onIt
    ? `🔧 ${job.name} is ${tenth * 10}% taken apart.`
    : `🔧 On it: taking ${job.name} apart, ${tenth === 0 ? `${job.laborHours} labor hours` : `${tenth * 10}% done`}.`;
  return { text, said: { roomId: job.roomId, startedAt: job.startedAt, tenth } };
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
 *    or gossiped): a stub, named only by a neighbour's door and never seen
 *    from inside, says nothing of what else it is joined to. A module seen
 *    from inside with no doors of its own is known: it is joined only by
 *    doors other rooms recorded;
 *  - only its owner takes a module apart (one with no verified owner may be
 *    taken apart by this room's deed holder, who alone sets robots to it).
 *    One whose owner the atlas never learned waits for someone to step
 *    inside: having minted it is no proof it is still ours, as its deed may
 *    have changed hands since;
 *  - it must hang only off this room: a module still joined to another, or
 *    with a ship docked at it, would leave that one cut off.
 */
export function removalBlocker(input: CandidateInput, roomId: string): string | null {
  const { atlas } = input;
  if (input.welcomeRoomId && roomId === input.welcomeRoomId) return "it is the station's welcome room";
  const entry = ownValue(atlas, roomId);
  const stub = !!entry && Object.keys(entry.doors ?? {}).length === 0 && entry.localSeenAt === undefined;
  if (!entry || stub) return "its layout isn't known yet; step inside it once";
  const owner = entry.owner;
  if (owner === undefined) return "its owner isn't known yet; step inside it once";
  if (owner !== null && !legacyOwnerMarker(owner.id) && owner.id !== input.playerId) {
    return `it belongs to ${owner.name || 'someone else'}`;
  }
  // Its other connections, as the atlas knows them: its own records and any
  // record pointing at it, berths included.
  const berths = berthDoorIds(atlas);
  const nameOf = (rid: string) => ownValue(atlas, rid)?.name || 'another module';
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
    const entry = ownValue(input.atlas, roomId);
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
