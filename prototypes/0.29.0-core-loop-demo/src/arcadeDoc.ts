/**
 * 🕹 arcadeDoc — the arcade cabinet's shared records (#193).
 *
 * Three keys per cabinet in the room doc's `arcade` map, plain JSON, whole-
 * value transacted writes, LWW per key (the tvDoc / partyDoc discipline):
 *   arcade:<itemId> → the curation   the shelf, the game on the cabinet, the
 *                                    emulator-files choice (the owner's, P1's
 *                                    pick from the shelf)
 *   seat:<itemId>   → SeatRecord     who is at the controls — PLAYER ONE — as
 *                                    a lease (the TV remote's shape)
 *   plays:<itemId>  → PlaysRecord    the attract card's tally, P1's write
 * One key per writer: a seat renewal never collides with a shelf edit, and
 * a play counted the moment the owner edits the shelf never reverts the
 * edit (nor the edit the count) — whole-value LWW keeps one of two writes
 * to a key, so each thing that changes on its own has a key of its own.
 * readCabinet joins the tally on read.
 *
 * PLAYER ONE IS THE SOURCE (plan §9, brainstorming/smart-tv-arcade-media-
 * plan.md): one player holds the cabinet's P1 panel; their emulator, running
 * in THEIR page, is the picture. This slice (P1, single player) carries no
 * spectator video yet: the in-world screen shows the attract card and
 * "P1 · <name>"; the media lane (TODO.md spike #21) adds the live picture.
 *
 * THE SEAT IS A LEASE, BOUND TO A PAGE: whoever inserts the coin holds P1
 * from the page that did it — the same identity in a second tab is not at
 * the controls, because the emulator runs in exactly one page. The holder's
 * page renews every ARCADE_SEAT_RENEW_MS; the seat lapses
 * ARCADE_SEAT_LAPSE_MS after the last renewal THIS page saw (never by the
 * holder's clock — the pusherCroupier.ts CLOCKS rule). Standing up, leaving
 * the room, or the room's DEED holder (the eject predicate) frees it.
 *
 * TWO AUTHORITIES, NOT ONE (main.ts's #142 split): the HOST predicate is the
 * shareholder-extended edit gate and curates — a peer-written venture
 * record can satisfy it, which is acceptable reach for a shelf. The EJECT
 * predicate is the raw deed holder and is the only one that unseats P1
 * (EJECT, or sitting down over a held seat): nobody is taken off the
 * controls on the strength of a record any peer could have written.
 *
 * THE OWNER CURATES: the shelf (the cabinet's menu), the game on the
 * cabinet, and where the emulator's own files come from — this station's
 * /emulatorjs/ (SOVEREIGN, fetched by scripts/fetch-emulatorjs.mjs) or
 * cdn.emulatorjs.org (CONVENIENCE, an opt-in per cabinet). A game is an
 * http(s) URL any P1 can fetch, or a file on the player's own disk (url '')
 * — then every P1 brings their own copy, until the blob lane (spike #18)
 * carries it. P1 may put a SHELF game on the cabinet; only the owner adds.
 *
 * ENFORCEMENT POSTURE (dev phase, the doorPolicy.ts rule): every write is
 * gated here and every read is shape-checked, so a peer running edited code
 * can at worst put a different game on the cabinet. Nothing here is worth
 * forging.
 *
 * REBIND PER JOIN (T0 seam): main.ts joinRoomAtEpoch calls bindArcadeDoc
 * beside bindTvDoc; the offline fallback mirrors partyDoc (a page-local doc
 * binds lazily so a solo room still works).
 */

import * as Y from 'yjs';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** How often the P1 page renews its seat. */
export const ARCADE_SEAT_RENEW_MS = 3_000;
/** A seat not renewed for this long (as THIS page saw it) is free again. */
export const ARCADE_SEAT_LAPSE_MS = 8_000;
export const ARCADE_SHELF_MAX = 12;
export const ARCADE_MAX_NAME = 80;
export const ARCADE_MAX_URL = 2048;
export const ARCADE_MAX_PLAYER = 32;
/** The attract card's INSERT COIN blink period. */
export const ARCADE_BLINK_MS = 800;

// ── Cores and games ──────────────────────────────────────────────────────────

export type ArcadeCore =
  | 'nes' | 'snes' | 'gb' | 'gbc' | 'gba' | 'segaMD' | 'segaMS' | 'n64'
  | 'arcade' | 'mame2003' | 'psx' | 'atari2600' | 'pce';

/** The cores this cabinet offers (EmulatorJS core ids) and the file
 *  extensions that pick them. Arcade ROMs are zips named after their romset,
 *  so .zip defaults to 'arcade' (FBNeo); the owner may switch to MAME 2003. */
export const ARCADE_CORES: ReadonlyArray<{ core: ArcadeCore; label: string; exts: readonly string[] }> = [
  { core: 'nes', label: 'NES', exts: ['nes', 'fds', 'unf', 'unif'] },
  { core: 'snes', label: 'SNES', exts: ['sfc', 'smc', 'fig', 'swc'] },
  { core: 'gb', label: 'GAME BOY', exts: ['gb'] },
  { core: 'gbc', label: 'GAME BOY COLOR', exts: ['gbc'] },
  { core: 'gba', label: 'GAME BOY ADVANCE', exts: ['gba'] },
  { core: 'segaMD', label: 'MEGA DRIVE', exts: ['md', 'gen', 'smd'] },
  { core: 'segaMS', label: 'MASTER SYSTEM', exts: ['sms'] },
  { core: 'n64', label: 'N64', exts: ['n64', 'z64', 'v64'] },
  { core: 'arcade', label: 'ARCADE (FBNEO)', exts: ['zip'] },
  { core: 'mame2003', label: 'ARCADE (MAME 2003)', exts: [] },
  { core: 'psx', label: 'PLAYSTATION', exts: ['cue', 'chd', 'pbp', 'iso'] },
  { core: 'atari2600', label: 'ATARI 2600', exts: ['a26'] },
  { core: 'pce', label: 'PC ENGINE', exts: ['pce'] },
];
const CORE_IDS: ReadonlySet<string> = new Set(ARCADE_CORES.map((c) => c.core));

export function isArcadeCore(v: unknown): v is ArcadeCore {
  return typeof v === 'string' && CORE_IDS.has(v);
}

export function coreLabel(core: ArcadeCore): string {
  return ARCADE_CORES.find((c) => c.core === core)?.label ?? core.toUpperCase();
}

/** The core a file name implies, or null (the owner then picks one). */
export function coreForName(name: string): ArcadeCore | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (!ext) return null;
  return ARCADE_CORES.find((c) => c.exts.includes(ext))?.core ?? null;
}

export interface ArcadeGame {
  /** Display name: the file's name, which arcade cores also need (the
   *  romset name is the zip's name). */
  name: string;
  core: ArcadeCore;
  /** An http(s) URL any P1 can fetch (same origin or CORS-clean), or ''
   *  when the game is a file on the player's own disk. */
  url: string;
  /** Bytes when known — a cheap "same file" check until the station
   *  library's BLAKE3 hash (plan §7). 0 = unknown. */
  size: number;
}

/** Where the emulator's own files (loader, engine, cores) come from. */
export type EmulatorData = 'station' | 'cdn';

export interface CabinetRecord {
  /** The game on the cabinet right now (the owner put it there, or P1 took
   *  it off the shelf). */
  game: ArcadeGame | null;
  /** The owner's curated shelf — the cabinet's menu. */
  shelf: ArcadeGame[];
  data: EmulatorData;
  /** Times a game started on this cabinet (the attract card's tally) —
   *  joined from its own key on read, never stored with the curation. */
  plays: number;
  /** The curation's revision: a lookup in flight is void past it. */
  seq: number;
}

/** What the `arcade:` key holds: the record without the tally. */
export type CabinetCuration = Omit<CabinetRecord, 'plays'>;

/** The `plays:` key: P1's tally, apart from the owner's curation. */
export interface PlaysRecord {
  plays: number;
}

export interface SeatRecord {
  /** P1's identity pub (base64url), '' when the controls are free. */
  holder: string;
  /** Display copy of P1's name (never resolved — peers pick their own). */
  name: string;
  /** The page that inserted the coin: the emulator runs there and nowhere
   *  else, so another tab of the same identity is a spectator. */
  page: string;
  /** The holder's own clock at the last renewal: compared ONLY against
   *  earlier values from the same holder — never against ours. */
  leaseAt: number;
  /** Who wrote the record (the holder, or the owner on a kick). */
  by: string;
}

export const CABINET_DEFAULT: CabinetRecord = { game: null, shelf: [], data: 'station', plays: 0, seq: 0 };
export const SEAT_FREE: SeatRecord = { holder: '', name: '', page: '', leaseAt: 0, by: '' };
export const PLAYS_DEFAULT: PlaysRecord = { plays: 0 };

// ── Binding (the tvDoc shape) ────────────────────────────────────────────────

let boundDoc: Y.Doc | null = null;
let arcadeMap: Y.Map<unknown> | null = null;
let bindingEpoch = 0;
const listeners = new Set<() => void>();
const keyListeners = new Map<string, Set<() => void>>();

let clock: () => number = () => Date.now();
export function setArcadeClock(fn: () => number): void {
  clock = fn;
}

/** This page's tag on the seat it holds. A tab id, not a secret. */
let pageId = Math.random().toString(36).slice(2, 10);
export function setArcadePageId(id: string): void {
  pageId = id;
}
export function arcadePageId(): string {
  return pageId;
}

/** Seats as THIS page saw them: the record's holder/page/leaseAt and OUR
 *  clock when that triple first appeared (the pusherCroupier `seeLease` idea). */
interface SeenSeat {
  holder: string;
  page: string;
  leaseAt: number;
  at: number;
}
const seenSeats = new Map<string, SeenSeat>();

function notify(changedKeys?: Set<string>): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[arcade] listener threw during doc notify:', err);
    }
  }
  for (const [key, keyed] of keyListeners) {
    if (changedKeys && !changedKeys.has(key)) continue;
    for (const listener of [...keyed]) {
      try {
        listener();
      } catch (err) {
        console.error(`[arcade] listener for '${key}' threw during doc notify:`, err);
      }
    }
  }
}

function docAlive(): boolean {
  return boundDoc !== null && (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true;
}

/** A seat is "seen" when it lands, not when something first asks about it. */
function noteSeats(keys: Iterable<string>): void {
  if (!arcadeMap) return;
  const now = clock();
  for (const key of keys) {
    if (!key.startsWith('seat:')) continue;
    seeSeat(key.slice(5), readSeat(key.slice(5)), now);
  }
}

export function bindArcadeDoc(doc: Y.Doc): void {
  bindingEpoch += 1;
  boundDoc = doc;
  arcadeMap = doc.getMap('arcade');
  seenSeats.clear();
  arcadeMap.observe((event) => {
    noteSeats(event.keysChanged);
    notify(event.keysChanged);
  });
  noteSeats([...arcadeMap.keys()]);
  notify();
}

export function arcadeDocEpoch(): number {
  return bindingEpoch;
}

function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !arcadeMap) bindArcadeDoc(new Y.Doc());
  return arcadeMap!;
}

export function subscribeArcade(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeArcadeKey(key: string, listener: () => void): () => void {
  let keyed = keyListeners.get(key);
  if (!keyed) {
    keyed = new Set();
    keyListeners.set(key, keyed);
  }
  keyed.add(listener);
  return () => {
    keyed!.delete(listener);
    if (keyed!.size === 0) keyListeners.delete(key);
  };
}

function write(key: string, value: unknown): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(key, value);
  });
}

export function cabinetKey(itemId: string): string {
  return `arcade:${itemId}`;
}
export function seatKey(itemId: string): string {
  return `seat:${itemId}`;
}
export function playsKey(itemId: string): string {
  return `plays:${itemId}`;
}

// ── Identity and authority seams (registered by main.ts, never asserted by a caller) ──

let identityProvider: () => { pub: string; name: string } = () => ({ pub: '', name: '' });
export function setArcadeIdentity(provider: () => { pub: string; name: string }): void {
  identityProvider = provider;
}
/** Curation: the shelf, the game, the emulator files — the room's edit
 *  gate (shareholder-extended, see main.ts's authority split). */
let hostPredicate: () => boolean = () => false;
export function setArcadeHostPredicate(predicate: () => boolean): void {
  hostPredicate = predicate;
}
/** Unseating P1 (EJECT, sitting down over a held seat): the room's DEED
 *  holder only — main.ts registers currentRoomDeedIsMine here, never the
 *  edit gate, which a peer-written venture record can satisfy. */
let ejectPredicate: () => boolean = () => false;
export function setArcadeEjectPredicate(predicate: () => boolean): void {
  ejectPredicate = predicate;
}
/** Whether this client may take P1 off the controls. The panel paints EJECT
 *  from here — the predicate the write itself checks — so no button is
 *  offered that standUp then refuses. */
export function mayEjectP1(): boolean {
  return ejectPredicate();
}

// ── Shape-checked reads ──────────────────────────────────────────────────────

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
/** One rule for the revision counter and the tally (the tvDoc rule): a
 *  reader compares `seq` for change and a writer moves it by one, so it
 *  must be a whole number that one more still moves — a peer's
 *  `Number.MAX_VALUE` is finite, and adding one to it changes nothing. A
 *  counter reads as a safe integer or as the floor, and the bump past the
 *  ceiling is the floor again. */
export const ARCADE_COUNTER_MAX = Number.MAX_SAFE_INTEGER;
const counter = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const bump = (v: number): number => (v >= ARCADE_COUNTER_MAX ? 0 : v + 1);

/** http(s) only, and never a URL carrying credentials: a game's link goes
 *  into the room-shared record and the shelf, where `user:password@host`
 *  would be read by every peer, not just the host serving the file. */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** A game as a peer may have written it, or null. An unknown core or a
 *  non-http(s) URL is dropped at the read boundary — a `javascript:` URL
 *  must never reach the emulator frame. */
export function sanitizeGame(raw: unknown): ArcadeGame | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, ARCADE_MAX_NAME).trim();
  if (!name || !isArcadeCore(r.core)) return null;
  const url = str(r.url, ARCADE_MAX_URL);
  if (url && !isHttpUrl(url)) return null;
  return { name, core: r.core, url, size: Math.max(0, Math.floor(num(r.size))) };
}

/** The `arcade:` key as a peer may have written it: the curation alone. */
export function readCuration(itemId: string): CabinetCuration {
  const raw = ensureMap().get(cabinetKey(itemId)) as Partial<CabinetCuration> | undefined;
  if (!raw || typeof raw !== 'object') return { game: null, shelf: [], data: 'station', seq: 0 };
  const shelf = Array.isArray(raw.shelf)
    ? raw.shelf.map(sanitizeGame).filter((g): g is ArcadeGame => g !== null).slice(0, ARCADE_SHELF_MAX)
    : [];
  return {
    game: sanitizeGame(raw.game),
    shelf,
    data: raw.data === 'cdn' ? 'cdn' : 'station',
    seq: counter(raw.seq),
  };
}

/** The tally, from its own key. */
export function readPlays(itemId: string): number {
  const raw = ensureMap().get(playsKey(itemId)) as Partial<PlaysRecord> | undefined;
  if (!raw || typeof raw !== 'object') return PLAYS_DEFAULT.plays;
  return counter(raw.plays);
}

/** What the panel, the stage and the screen show: the curation with the
 *  tally joined from its key. */
export function readCabinet(itemId: string): CabinetRecord {
  return { ...readCuration(itemId), plays: readPlays(itemId) };
}

export function readSeat(itemId: string): SeatRecord {
  const raw = ensureMap().get(seatKey(itemId)) as Partial<SeatRecord> | undefined;
  if (!raw || typeof raw !== 'object') return { ...SEAT_FREE };
  const holder = str(raw.holder, 128);
  return {
    holder,
    name: holder ? str(raw.name, ARCADE_MAX_PLAYER) : '',
    page: holder ? str(raw.page, 32) : '',
    leaseAt: num(raw.leaseAt),
    by: str(raw.by, 128),
  };
}

// ── Player one: the seat ─────────────────────────────────────────────────────

export type SeatStatus = 'free' | 'mine' | 'held';
export type ArcadeAction = { ok: true } | { ok: false; error: string };

function seeSeat(itemId: string, rec: SeatRecord, now: number): SeenSeat {
  const seen = seenSeats.get(itemId);
  if (seen && seen.holder === rec.holder && seen.page === rec.page && seen.leaseAt === rec.leaseAt) return seen;
  const fresh = { holder: rec.holder, page: rec.page, leaseAt: rec.leaseAt, at: now };
  seenSeats.set(itemId, fresh);
  return fresh;
}

/** Whether a held seat has gone quiet long enough to count as left —
 *  judged by the renewals THIS page saw, never by the holder's clock. */
export function seatLapsed(itemId: string, now = clock()): boolean {
  const rec = readSeat(itemId);
  if (!rec.holder) return true;
  const seen = seeSeat(itemId, rec, now);
  return now - seen.at >= ARCADE_SEAT_LAPSE_MS;
}

/** 'mine' only from the page that inserted the coin. */
export function seatStatus(itemId: string, now = clock()): SeatStatus {
  const rec = readSeat(itemId);
  if (!rec.holder) return 'free';
  if (rec.holder === identityProvider().pub && rec.page === pageId) return 'mine';
  return seatLapsed(itemId, now) ? 'free' : 'held';
}

export function iAmP1(itemId: string): boolean {
  return seatStatus(itemId) === 'mine';
}

/** May this page take the controls now: free, lapsed, already mine — or
 *  held, and I hold the room's deed (sitting down over someone unseats
 *  them: the eject predicate, never the edit gate). */
export function maySit(itemId: string, now = clock()): boolean {
  return seatStatus(itemId, now) !== 'held' || ejectPredicate();
}

/** INSERT COIN: take P1 from this page. */
export function insertCoin(itemId: string, now = clock()): ArcadeAction {
  const { pub, name } = identityProvider();
  if (!pub) return { ok: false, error: 'No identity on this device yet.' };
  const rec = readSeat(itemId);
  if (!maySit(itemId, now)) {
    return { ok: false, error: `${rec.name || 'Someone'} is at the controls.` };
  }
  write(seatKey(itemId), {
    holder: pub, name: name.slice(0, ARCADE_MAX_PLAYER), page: pageId, leaseAt: now, by: pub,
  } satisfies SeatRecord);
  return { ok: true };
}

/** Renew my seat (the P1 page's tick calls this every ARCADE_SEAT_RENEW_MS). */
export function renewSeat(itemId: string, now = clock()): void {
  const { pub, name } = identityProvider();
  if (!pub) return;
  const rec = readSeat(itemId);
  if (rec.holder !== pub || rec.page !== pageId) return;
  write(seatKey(itemId), {
    holder: pub, name: name.slice(0, ARCADE_MAX_PLAYER), page: pageId, leaseAt: now, by: pub,
  } satisfies SeatRecord);
}

/** Stand up. The holder's page may; so may the room's deed holder (EJECT —
 *  the one authority that unseats people, #142). */
export function standUp(itemId: string, now = clock()): ArcadeAction {
  const { pub } = identityProvider();
  const rec = readSeat(itemId);
  if (!rec.holder) return { ok: true };
  const mine = rec.holder === pub && rec.page === pageId;
  if (!mine && !ejectPredicate()) {
    return { ok: false, error: `${rec.name || 'Someone'} is at the controls.` };
  }
  write(seatKey(itemId), { holder: '', name: '', page: '', leaseAt: now, by: pub } satisfies SeatRecord);
  return { ok: true };
}

// ── The cabinet: the owner curates, P1 chooses from the shelf ───────────────

function ownerGate(): ArcadeAction {
  return hostPredicate() ? { ok: true } : { ok: false, error: 'Only the room owner changes the cabinet.' };
}

/** Put a game on the cabinet (the owner, any game). */
export function putOnCabinet(itemId: string, game: ArcadeGame): ArcadeAction {
  const gate = ownerGate();
  if (!gate.ok) return gate;
  const clean = sanitizeGame(game);
  if (!clean) return { ok: false, error: 'That is not a game the cabinet can run.' };
  const rec = readCuration(itemId);
  write(cabinetKey(itemId), { ...rec, game: clean, seq: bump(rec.seq) } satisfies CabinetCuration);
  return { ok: true };
}

/** Take the game off (the owner). */
export function takeOffCabinet(itemId: string): ArcadeAction {
  const gate = ownerGate();
  if (!gate.ok) return gate;
  const rec = readCuration(itemId);
  write(cabinetKey(itemId), { ...rec, game: null, seq: bump(rec.seq) } satisfies CabinetCuration);
  return { ok: true };
}

/** P1 (or the owner) puts a SHELF game on the cabinet — the menu. */
export function pickFromShelf(itemId: string, index: number): ArcadeAction {
  if (!iAmP1(itemId) && !hostPredicate()) return { ok: false, error: 'Insert a coin first.' };
  const rec = readCuration(itemId);
  const game = rec.shelf[index];
  if (!game) return { ok: false, error: 'Nothing on that shelf.' };
  write(cabinetKey(itemId), { ...rec, game, seq: bump(rec.seq) } satisfies CabinetCuration);
  return { ok: true };
}

/** Add to the shelf (the owner). A game already there is moved to the top. */
export function addToShelf(itemId: string, game: ArcadeGame): ArcadeAction {
  const gate = ownerGate();
  if (!gate.ok) return gate;
  const clean = sanitizeGame(game);
  if (!clean) return { ok: false, error: 'That is not a game the cabinet can run.' };
  const rec = readCuration(itemId);
  const rest = rec.shelf.filter((g) => gameId(g) !== gameId(clean));
  if (rest.length >= ARCADE_SHELF_MAX) return { ok: false, error: `The shelf holds ${ARCADE_SHELF_MAX} games.` };
  write(cabinetKey(itemId), { ...rec, shelf: [clean, ...rest], seq: bump(rec.seq) } satisfies CabinetCuration);
  return { ok: true };
}

export function removeFromShelf(itemId: string, index: number): ArcadeAction {
  const gate = ownerGate();
  if (!gate.ok) return gate;
  const rec = readCuration(itemId);
  if (!rec.shelf[index]) return { ok: false, error: 'Nothing on that shelf.' };
  write(cabinetKey(itemId), {
    ...rec, shelf: rec.shelf.filter((_, i) => i !== index), seq: bump(rec.seq),
  } satisfies CabinetCuration);
  return { ok: true };
}

/** Where the emulator's own files come from (the owner's call, per cabinet). */
export function setEmulatorData(itemId: string, data: EmulatorData): ArcadeAction {
  const gate = ownerGate();
  if (!gate.ok) return gate;
  const rec = readCuration(itemId);
  write(cabinetKey(itemId), { ...rec, data: data === 'cdn' ? 'cdn' : 'station', seq: bump(rec.seq) } satisfies CabinetCuration);
  return { ok: true };
}

/** A game started under P1: one more on the tally — its own key, so a
 *  play counted as the owner edits the shelf reverts neither the edit nor
 *  the count. */
export function countPlay(itemId: string): void {
  if (!iAmP1(itemId)) return;
  write(playsKey(itemId), { plays: bump(readPlays(itemId)) } satisfies PlaysRecord);
}

// ── Games: identity, lanes, parsing (pure) ───────────────────────────────────

/** Stable identity of a game: the link, or — for a file on a player's disk —
 *  its name AND size, so two different ROMs that happen to share a name do
 *  not share an identity (the page keeps local files by this id). */
export function gameId(g: ArcadeGame): string {
  return `${g.core}:${g.url || `file:${g.name}:${g.size}`}`;
}

export type ArcadeLane = 'SOVEREIGN' | 'CONVENIENCE';

/** The lane badge: a file on the player's own disk, or a loopback URL (the
 *  node's own listener), is sovereign; anything fetched from the web is a
 *  convenience lane. */
export function gameLane(g: ArcadeGame): ArcadeLane {
  if (!g.url) return 'SOVEREIGN';
  try {
    const h = new URL(g.url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' ? 'SOVEREIGN' : 'CONVENIENCE';
  } catch {
    return 'CONVENIENCE';
  }
}

export interface ParsedRom {
  name: string;
  url: string;
  /** null when the extension names no core: the owner picks one. */
  core: ArcadeCore | null;
}

/** What the owner's URL box accepts: an http(s) link to a ROM file. The
 *  name is the link's last path segment; the core follows its extension. */
export function parseRomUrl(text: string): ParsedRom | null {
  const t = text.trim();
  if (!t) return null;
  let u: URL;
  try {
    // A bare host gets https://; anything with a scheme of its own keeps it
    // (and a scheme that is not http(s) is refused below, not rewritten).
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (!isHttpUrl(u.href)) return null; // http(s) only, and no credentials for the room to read
  const tail = u.pathname.split('/').filter(Boolean).pop() ?? '';
  let name = '';
  try {
    name = decodeURIComponent(tail);
  } catch {
    name = tail;
  }
  name = name.trim().slice(0, ARCADE_MAX_NAME) || u.hostname;
  return { name, url: u.href.slice(0, ARCADE_MAX_URL), core: coreForName(name) };
}

// ── The in-world screen's view (pure; World draws it) ────────────────────────

export interface ArcadeScreenView {
  mode: 'empty' | 'attract' | 'inplay';
  /** Big line: the game's name, or the cabinet's own name. */
  title: string;
  /** Under it: INSERT COIN, "P1 · <name>", or what the owner must do. */
  line: string;
  lane: ArcadeLane | '';
  /** The attract card's INSERT COIN blink phase. */
  blink: boolean;
  plays: number;
}

/** Derive what the cabinet's screen shows from the records alone, so every
 *  client's prop agrees and the drawing code has nothing to decide. */
export function arcadeScreenView(itemId: string, now = clock()): ArcadeScreenView {
  const rec = readCabinet(itemId);
  const seat = readSeat(itemId);
  const inPlay = seat.holder !== '' && !seatLapsed(itemId, now);
  if (inPlay && rec.game) {
    return {
      mode: 'inplay', title: rec.game.name.toUpperCase(), line: `P1 · ${seat.name || 'a clone'}`,
      lane: gameLane(rec.game), blink: false, plays: rec.plays,
    };
  }
  if (!rec.game && rec.shelf.length === 0) {
    return { mode: 'empty', title: 'FURLONG ARCADE', line: 'THE OWNER LOADS A GAME', lane: '', blink: false, plays: rec.plays };
  }
  const blink = Math.floor(now / ARCADE_BLINK_MS) % 2 === 0;
  return {
    mode: 'attract',
    title: rec.game ? rec.game.name.toUpperCase() : `${rec.shelf.length} GAME${rec.shelf.length === 1 ? '' : 'S'} ON THE SHELF`,
    line: 'INSERT COIN',
    lane: rec.game ? gameLane(rec.game) : '',
    blink,
    plays: rec.plays,
  };
}
