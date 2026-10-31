/**
 * 🎞️ The CAMERA app's film roll (#319): the last ROLL_MAX shots this browser
 * took, each with its date, the room it was taken in and a caption the
 * player types. Local only: nothing here leaves the device. A shot is shared
 * only when the player pins it on a board (#315), which puts it on the blob
 * lane then.
 *
 * Kept in IndexedDB (`ssf-film-roll`), the JPEG as a Blob beside its fields.
 * Where IndexedDB can't open (a private window, blocked storage) the roll
 * lives in memory for the session and says so (`rollIsLasting`).
 */

/** Shots the roll keeps; the oldest goes when a new one would pass it. */
export const ROLL_MAX = 20;
/** A caption's length, at most (a board note's photo caption: boardDoc.ts
 *  MAX_PHOTO_CAPTION). */
export const MAX_CAPTION = 80;
/** A room name as a shot keeps it, at most. */
const MAX_ROOM_NAME = 48;

export interface FilmShot {
  id: string;
  /** When it was taken, Unix ms. */
  ts: number;
  roomId: string;
  roomName: string;
  caption: string;
  width: number;
  height: number;
  jpeg: Blob;
}

/** Where the roll keeps its shots. */
export interface RollStore {
  all(): Promise<FilmShot[]>;
  put(shot: FilmShot): Promise<void>;
  remove(id: string): Promise<void>;
  /** Whether it outlives a reload. */
  readonly lasting: boolean;
}

/** One line of text as a caption or a room name keeps it: no control
 *  characters or line breaks, spaces collapsed, at most `max` units and
 *  never half of a surrogate pair. */
export function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return text.trim();
}

export const cleanCaption = (raw: unknown): string => cleanLine(raw, MAX_CAPTION);

/** Newest first; one taken in the same millisecond by id. */
export function newestFirst(shots: readonly FilmShot[]): FilmShot[] {
  return [...shots].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The shots past the newest `max`, which go. */
export function overflowOf(shots: readonly FilmShot[], max = ROLL_MAX): string[] {
  return newestFirst(shots).slice(max).map((s) => s.id);
}

/** A shot's date line: "Oct 31 · 21:40 · Room name". */
export function shotLabel(shot: Pick<FilmShot, 'ts' | 'roomName'>, locale?: string): string {
  const d = new Date(shot.ts);
  const day = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return shot.roomName ? `${day} · ${time} · ${shot.roomName}` : `${day} · ${time}`;
}

/** A shot read back from storage, shape-checked, or null. */
function shotFromStore(raw: unknown): FilmShot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !Number.isSafeInteger(r.ts)) return null;
  if (!(typeof Blob !== 'undefined' && r.jpeg instanceof Blob)) return null;
  if (!Number.isSafeInteger(r.width) || !Number.isSafeInteger(r.height)) return null;
  return {
    id: r.id,
    ts: r.ts as number,
    roomId: typeof r.roomId === 'string' ? r.roomId : '',
    roomName: cleanLine(r.roomName, MAX_ROOM_NAME),
    caption: cleanCaption(r.caption),
    width: r.width as number,
    height: r.height as number,
    jpeg: r.jpeg,
  };
}

/** A roll kept in memory: the session's, or a test's. */
export function memoryRollStore(): RollStore {
  const shots = new Map<string, FilmShot>();
  return {
    lasting: false,
    all: async () => [...shots.values()],
    put: async (shot) => {
      shots.set(shot.id, shot);
    },
    remove: async (id) => {
      shots.delete(id);
    },
  };
}

const DB_NAME = 'ssf-film-roll';
const STORE = 'shots';

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The roll in IndexedDB, or null where there is none. If it fails to
 *  open, the session's memory roll stands in. */
function idbRollStore(): RollStore | null {
  if (typeof indexedDB === 'undefined') return null;
  let fallback: RollStore | null = null;
  const opened: Promise<IDBDatabase | null> = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  const db = async (): Promise<IDBDatabase | null> => {
    const d = await opened;
    if (!d) fallback ??= memoryRollStore();
    return d;
  };
  const store: RollStore = {
    get lasting() {
      return fallback === null;
    },
    all: async () => {
      const d = await db();
      if (!d) return fallback!.all();
      const rows = await idbRequest(d.transaction(STORE, 'readonly').objectStore(STORE).getAll());
      return rows.map(shotFromStore).filter((s): s is FilmShot => s !== null);
    },
    put: async (shot) => {
      const d = await db();
      if (!d) return fallback!.put(shot);
      await idbRequest(d.transaction(STORE, 'readwrite').objectStore(STORE).put(shot));
    },
    remove: async (id) => {
      const d = await db();
      if (!d) return fallback!.remove(id);
      await idbRequest(d.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
    },
  };
  return store;
}

let store: RollStore | null = null;
const rollStore = (): RollStore => (store ??= idbRollStore() ?? memoryRollStore());
const listeners = new Set<() => void>();
const changed = () => {
  for (const cb of listeners) cb();
};

/** Whether the roll outlives a reload (false in a private window). */
export function rollIsLasting(): boolean {
  return rollStore().lasting;
}

/** Called after every change to the roll. */
export function onRollChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The roll, newest first. */
export async function listShots(): Promise<FilmShot[]> {
  try {
    return newestFirst(await rollStore().all());
  } catch {
    return [];
  }
}

/** Print a shot onto the roll; the oldest past ROLL_MAX goes. */
export async function addShot(
  input: { jpeg: Blob; width: number; height: number; roomId: string; roomName: string },
  now = Date.now(),
): Promise<FilmShot> {
  const shot: FilmShot = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    ts: now,
    roomId: input.roomId,
    roomName: cleanLine(input.roomName, MAX_ROOM_NAME),
    caption: '',
    width: input.width,
    height: input.height,
    jpeg: input.jpeg,
  };
  const s = rollStore();
  await s.put(shot);
  for (const id of overflowOf(await s.all())) await s.remove(id);
  changed();
  return shot;
}

/** Write a shot's caption. False if the shot is gone. */
export async function setCaption(id: string, caption: string): Promise<boolean> {
  const s = rollStore();
  const shot = (await s.all()).find((x) => x.id === id);
  if (!shot) return false;
  const text = cleanCaption(caption);
  if (text === shot.caption) return true;
  await s.put({ ...shot, caption: text });
  changed();
  return true;
}

/** Throw a shot away. */
export async function removeShot(id: string): Promise<void> {
  await rollStore().remove(id);
  changed();
}

/** Test hook: use `next` as the roll (null: the default again). */
export function setRollStoreForTest(next: RollStore | null): void {
  store = next;
}
