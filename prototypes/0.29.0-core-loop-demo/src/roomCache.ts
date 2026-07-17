/**
 * 💾 Room-doc snapshot cache (durability Tier A — room-durability-plan.md §3)
 *
 * One IndexedDB database (`ssf-room-cache`), one store, key = roomId, value =
 * `{ update, savedAt, lastUsedAt, bytes, owned }` where `update` is a FULL
 * self-contained snapshot (`Y.encodeStateAsUpdate(doc)`), never an update log.
 * Hand-rolled instead of y-indexeddb on purpose: our docs are created per join
 * and destroyed on leave (y-indexeddb's long-lived-doc lifecycle races
 * `doc.destroy()` during room swaps), restore must be ONE awaitable read the
 * epoch guard can wrap, and the snapshot blob is byte-identical to what the
 * future sealed-snapshot layer (Tier D) seals and content-addresses.
 *
 * Restore is applied BEFORE `sync.start()` (see joinRoomAtEpoch): the opening
 * SyncStep1 then carries a real state vector (the host ships only the missing
 * delta), the restore is silent (no update-echo), and an owned room's cached
 * `owner` suppresses the claimRoomDefaults rename-revert race. CRDT idempotence
 * makes any cache/network interleaving safe; if the cache is AHEAD of the host
 * (host restarted), our SyncStep2 answer re-seeds the room — that is the
 * owner-restart recovery path.
 *
 * This is a CACHE, not durability: browsers may evict under pressure (we call
 * `navigator.storage.persist()` once, best-effort). LRU evicts non-owned rooms
 * first and NEVER owned ones — your copy of your own room may be the only one
 * in the universe (which is exactly why the co-host/sealed-snapshot tiers
 * exist). Every entry point is try/catch: privacy-mode IndexedDB failure
 * degrades to exactly today's no-cache behavior.
 */

import * as Y from 'yjs';

const DB_NAME = 'ssf-room-cache';
const STORE = 'rooms';
/** Per-room snapshot cap — beyond this the put is skipped with a warning
 *  (the chat cap at the push site keeps real rooms far under this). */
const PER_ROOM_CAP_BYTES = 1_000_000;
/** Total cache cap before LRU eviction of non-owned rooms. */
const TOTAL_CAP_BYTES = 50_000_000;
/** Trailing debounce for the doc-update writer. */
const DEBOUNCE_MS = 1_000;

interface CacheRow {
  update: Uint8Array;
  savedAt: number;
  lastUsedAt: number;
  bytes: number;
  owned: boolean;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Open at `version` (undefined = current), creating the store on upgrade. */
function openAt(version?: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(STORE); } catch { /* exists */ }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // privacy mode / no IDB — degrade to no-cache
    }
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    let db = await openAt();
    // Self-heal a store-less DB (e.g. some other opener created the name first):
    // a same-version open never fires upgradeneeded, so bump the version to
    // force one and (re)create the store. Without this, every transaction would
    // throw NotFoundError forever and the cache would be silently dead.
    if (db && !db.objectStoreNames.contains(STORE)) {
      const bumped = db.version + 1;
      db.close();
      db = await openAt(bumped);
    }
    return db;
  })();
  // Best-effort durable-storage request (once). Browsers may still evict.
  try { void navigator.storage?.persist?.(); } catch { /* unsupported */ }
  return dbPromise;
}

function idbGet(db: IDBDatabase, key: string): Promise<CacheRow | null> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as CacheRow) ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbPut(db: IDBDatabase, key: string, row: CacheRow): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(row, key);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}

function idbAllEntries(db: IDBDatabase): Promise<Array<[string, CacheRow]>> {
  return new Promise((resolve) => {
    const out: Array<[string, CacheRow]> = [];
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out.push([String(cur.key), cur.value as CacheRow]);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => resolve(out);
    } catch { resolve(out); }
  });
}

/** LRU sweep: evict oldest non-owned rooms until under the total cap. */
async function enforceCaps(db: IDBDatabase): Promise<void> {
  try {
    const entries = await idbAllEntries(db);
    let total = entries.reduce((sum, [, r]) => sum + (r.bytes || 0), 0);
    if (total <= TOTAL_CAP_BYTES) return;
    const evictable = entries
      .filter(([, r]) => !r.owned)
      .sort((a, b) => (a[1].lastUsedAt || 0) - (b[1].lastUsedAt || 0));
    for (const [key, row] of evictable) {
      if (total <= TOTAL_CAP_BYTES) break;
      await idbDelete(db, key);
      total -= row.bytes || 0;
    }
  } catch { /* cache-only concern — never fatal */ }
}

/**
 * Restore a cached snapshot into `doc` (call BEFORE sync.start()). Returns true
 * when a snapshot applied. A corrupt blob is deleted and reported false —
 * exactly today's no-cache behavior.
 */
export async function restoreRoomSnapshot(doc: Y.Doc, roomId: string): Promise<boolean> {
  try {
    const db = await openDb();
    if (!db) return false;
    const row = await idbGet(db, roomId);
    if (!row || !(row.update instanceof Uint8Array) || row.update.byteLength === 0) return false;
    try {
      Y.applyUpdate(doc, row.update, 'room-cache');
    } catch (err) {
      console.warn(`💾 room cache: corrupt snapshot for ${roomId} — discarding`, err);
      void idbDelete(db, roomId);
      return false;
    }
    // Touch LRU (fire-and-forget).
    void idbPut(db, roomId, { ...row, lastUsedAt: Date.now() });
    console.log(`💾 room cache: restored ${roomId} (${row.update.byteLength} bytes, saved ${new Date(row.savedAt).toLocaleString()})`);
    return true;
  } catch {
    return false;
  }
}

/** Handle returned by attachRoomCache — leaveRoom calls flushNow() BEFORE
 *  sync.stop() destroys the doc (encode is synchronous; the put is async). */
export interface RoomCacheHandle {
  flushNow: () => void;
  detach: () => void;
}

/**
 * Attach a debounced snapshot writer to `doc`. `owned()` is sampled at write
 * time (ownership can resolve after join). Writer listeners stack with the
 * ysync sender, and both guard against the destroyed-doc window.
 */
export function attachRoomCache(doc: Y.Doc, roomId: string, owned: () => boolean): RoomCacheHandle {
  let timer: number | null = null;
  let detached = false;

  const write = () => {
    timer = null;
    if (detached) return;
    try {
      if ((doc as { isDestroyed?: boolean }).isDestroyed) return;
      const update = Y.encodeStateAsUpdate(doc);
      if (update.byteLength > PER_ROOM_CAP_BYTES) {
        console.warn(`💾 room cache: ${roomId} snapshot ${update.byteLength} B exceeds cap — skipped`);
        return;
      }
      let isOwned = false;
      try { isOwned = owned(); } catch { /* ownership unresolved */ }
      void (async () => {
        const db = await openDb();
        if (!db) return;
        await idbPut(db, roomId, {
          update,
          savedAt: Date.now(),
          lastUsedAt: Date.now(),
          bytes: update.byteLength,
          owned: isOwned,
        });
        void enforceCaps(db);
      })();
    } catch { /* cache write is never fatal */ }
  };

  const onUpdate = () => {
    if (detached) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(write, DEBOUNCE_MS);
  };
  doc.on('update', onUpdate);

  return {
    flushNow: () => {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      write();
    },
    detach: () => {
      detached = true;
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      try { doc.off('update', onUpdate); } catch { /* doc already destroyed */ }
    },
  };
}
