/**
 * 🕹 arcadeDoc — the arcade cabinet's shared records (#193).
 *
 * Three kinds of key per cabinet in the room doc's `arcade` map, plain JSON,
 * whole-value transacted writes, LWW per key (the tvDoc / partyDoc
 * discipline):
 *   arcade:<itemId>     → the curation   the ONE game on the cabinet and the
 *                                        emulator-files choice (the owner's)
 *   seat:<itemId>       → SeatRecord     who is at the controls — PLAYER ONE —
 *                                        as a lease (the TV remote's shape)
 *   seat:<itemId>:<n>   → SeatRecord     players two to four (n = 1–3), on the
 *                                        double-wide cabinet: a lease each
 *   plays:<itemId>      → PlaysRecord    the attract card's tally, a player's
 *                                        write
 *   scores:<itemId>:<game> → ScoresRecord a cabinet's own game's high scores
 *                                        (arcadeNativeGames.ts): its host's
 *                                        write, the owner's CLEAR
 * One key per writer: a seat renewal never collides with a change of game, and
 * a play counted the moment the owner changes the game never reverts the
 * change (nor the change the count) — whole-value LWW keeps one of two writes
 * to a key, so each thing that changes on its own has a key of its own.
 * readCabinet joins the tally on read.
 *
 * PLAYER ONE IS THE SOURCE (plan §9, brainstorming/smart-tv-arcade-media-
 * plan.md): one player holds the cabinet's P1 panel; their emulator, running
 * in THEIR page, is the picture. This slice carries no spectator video yet:
 * the in-world screen shows the attract card and "P1 · <name>"; the media
 * lane (TODO.md spike #21) adds the live picture. On the DOUBLE-WIDE cabinet
 * every seated player runs the game in their own page, in step with the
 * others (arcadeLockstep.ts): four seats, a lease each, one game.
 *
 * THE SEAT IS A LEASE, BOUND TO A PAGE: whoever inserts the coin holds the
 * seat from the page that did it — the same identity in a second tab is not
 * at the controls, because the emulator runs in exactly one page, and a page
 * holds one seat of a cabinet at a time. The holder's
 * page renews every ARCADE_SEAT_RENEW_MS; the seat lapses
 * ARCADE_SEAT_LAPSE_MS after the last renewal THIS page saw (never by the
 * holder's clock — the pusherCroupier.ts CLOCKS rule). Standing up, leaving
 * the room, or the room's DEED holder (the eject predicate) frees it.
 *
 * TWO AUTHORITIES, NOT ONE (main.ts's #142 split): the HOST predicate is the
 * shareholder-extended edit gate and curates — a peer-written venture
 * record can satisfy it, which is acceptable reach for a game. The EJECT
 * predicate is the raw deed holder and is the only one that unseats P1
 * (EJECT, or sitting down over a held seat): nobody is taken off the
 * controls on the strength of a record any peer could have written.
 *
 * ONE GAME PER CABINET, THE OWNER'S PICK: players walk up and press play;
 * only the owner changes the game, in the cabinet's ⚙️ settings. Two kinds:
 *  - a BUILT-IN game (`bundled`: an arcadeLibrary id — the free NES games
 *    this app ships) runs on the built-in emulator ON the cabinet's screen,
 *    shared with the room (arcadeNesSession.ts), two players at the
 *    two-player cabinet. A cabinet nobody has set yet plays the first one.
 *  - the owner's OWN game — any console or arcade board EmulatorJS runs —
 *    in P1's play window (arcadeStage.ts), from an http(s) URL any P1 can
 *    fetch, or a file on the owner's disk (url ''): then every P1 brings
 *    their own copy, until the blob lane (spike #18) carries it.
 * And where EmulatorJS's own files come from — this station's /emulatorjs/
 * (SOVEREIGN, fetched by scripts/fetch-emulatorjs.mjs) or cdn.emulatorjs.org
 * (CONVENIENCE, an opt-in per cabinet that exists only in a build with the
 * convenience lanes on: sovereignty.ts).
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
import { ARCADE_GAMES as BUILT_IN_GAMES, type ArcadeGame as BuiltInGame } from './arcadeLibrary';
import { nativeGameById, type NativeGame } from './arcadeNativeGames';
import { convenienceLanesEnabled, SERVERLESS_ONLY } from './sovereignty';
import { ownMediaOrigins } from './tvConsent';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** How often a seated page renews its seat. */
export const ARCADE_SEAT_RENEW_MS = 3_000;
/** A seat not renewed for this long (as THIS page saw it) is free again. */
export const ARCADE_SEAT_LAPSE_MS = 8_000;
export const ARCADE_MAX_NAME = 80;
export const ARCADE_MAX_URL = 2048;
export const ARCADE_MAX_PLAYER = 32;
/** The attract card's INSERT COIN blink period. */
export const ARCADE_BLINK_MS = 800;
/** The most players a cabinet seats: the double-wide cabinet's four. */
export const ARCADE_SEATS_MAX = 4;
/** Lines on a cabinet's high-score table. */
export const ARCADE_SCORES_MAX = 10;
/** The highest score a table shows (a peer's record is clamped to it). */
export const ARCADE_SCORE_TOP = 99_999_999;

// ── Cores and games ──────────────────────────────────────────────────────────

export type ArcadeCore =
  | 'nes' | 'snes' | 'gb' | 'gbc' | 'gba' | 'segaMD' | 'segaMS' | 'n64'
  | 'arcade' | 'mame2003' | 'psx' | 'atari2600' | 'pce';

/** The cores this cabinet offers and the file extensions that pick them.
 *  Arcade ROMs are zips named after their romset, so .zip defaults to
 *  'arcade' (FBNeo); the owner may switch to MAME 2003-Plus. `ejs` is what
 *  EmulatorJS is told (EJS_core) and `libretro` the core that then runs.
 *  EmulatorJS takes a system's name, and runs that system's first core, or
 *  a core's name, and runs that core. Where the cabinet's own id would run
 *  a core no station fetches, it is told another: 'gbc' names nothing
 *  there, 'mame2003' is plain MAME 2003, and its first pick for the Master
 *  System is smsplus (for the N64 on an iPhone, parallel_n64).
 *  scripts/fetch-emulatorjs.mjs fetches exactly these cores
 *  (arcadeDoc.test.ts holds the two together, and the names to EmulatorJS
 *  4.2.1's own table). */
export const ARCADE_CORES: ReadonlyArray<{
  core: ArcadeCore; label: string; exts: readonly string[]; ejs: string; libretro: string;
}> = [
  { core: 'nes', label: 'NES', exts: ['nes', 'fds', 'unf', 'unif'], ejs: 'nes', libretro: 'fceumm' },
  { core: 'snes', label: 'SNES', exts: ['sfc', 'smc', 'fig', 'swc'], ejs: 'snes', libretro: 'snes9x' },
  { core: 'gb', label: 'GAME BOY', exts: ['gb'], ejs: 'gb', libretro: 'gambatte' },
  { core: 'gbc', label: 'GAME BOY COLOR', exts: ['gbc'], ejs: 'gb', libretro: 'gambatte' },
  { core: 'gba', label: 'GAME BOY ADVANCE', exts: ['gba'], ejs: 'gba', libretro: 'mgba' },
  { core: 'segaMD', label: 'MEGA DRIVE', exts: ['md', 'gen', 'smd'], ejs: 'segaMD', libretro: 'genesis_plus_gx' },
  { core: 'segaMS', label: 'MASTER SYSTEM', exts: ['sms'], ejs: 'genesis_plus_gx', libretro: 'genesis_plus_gx' },
  { core: 'n64', label: 'N64', exts: ['n64', 'z64', 'v64'], ejs: 'mupen64plus_next', libretro: 'mupen64plus_next' },
  { core: 'arcade', label: 'ARCADE (FBNEO)', exts: ['zip'], ejs: 'arcade', libretro: 'fbneo' },
  { core: 'mame2003', label: 'ARCADE (MAME 2003-PLUS)', exts: [], ejs: 'mame', libretro: 'mame2003_plus' },
  { core: 'psx', label: 'PLAYSTATION', exts: ['cue', 'chd', 'pbp', 'iso'], ejs: 'psx', libretro: 'pcsx_rearmed' },
  { core: 'atari2600', label: 'ATARI 2600', exts: ['a26'], ejs: 'atari2600', libretro: 'stella2014' },
  { core: 'pce', label: 'PC ENGINE', exts: ['pce'], ejs: 'pce', libretro: 'mednafen_pce' },
];
const CORE_IDS: ReadonlySet<string> = new Set(ARCADE_CORES.map((c) => c.core));

export function isArcadeCore(v: unknown): v is ArcadeCore {
  return typeof v === 'string' && CORE_IDS.has(v);
}

export function coreLabel(core: ArcadeCore): string {
  return ARCADE_CORES.find((c) => c.core === core)?.label ?? core.toUpperCase();
}

/** What EmulatorJS is told for a core (EJS_core; ARCADE_CORES). Every
 *  ArcadeCore has its row; anything else goes as itself. */
export function ejsCore(core: ArcadeCore): string {
  return ARCADE_CORES.find((c) => c.core === core)?.ejs ?? core;
}

/** The core a file name implies, or null (the owner then picks one). */
export function coreForName(name: string): ArcadeCore | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (!ext) return null;
  return ARCADE_CORES.find((c) => c.exts.includes(ext))?.core ?? null;
}

export interface ArcadeGame {
  /** Display name: the file's name, which arcade cores also need (the
   *  romset name is the zip's name); a built-in game's title. */
  name: string;
  core: ArcadeCore;
  /** An http(s) URL any P1 can fetch (same origin or CORS-clean), or ''
   *  when the game is a file on the player's own disk (or built in). */
  url: string;
  /** Bytes when known — a cheap "same file" check until the station
   *  library's BLAKE3 hash (plan §7). 0 = unknown. */
  size: number;
  /** A built-in game's arcadeLibrary id: it runs on the built-in emulator,
   *  on the cabinet's screen, for the room. Absent: the owner's own game,
   *  in EmulatorJS. */
  bundled?: string;
  /** A file from the owner's disk: its SHA-256 (hex). The owner's page —
   *  and every page that got it since — sends the bytes to a player who
   *  presses play (arcadeRomShare), checked against this. */
  sha256?: string;
}

/** A built-in game as it goes on a cabinet — always rebuilt from the
 *  library, so a peer's record can name one and nothing else about it. A
 *  cabinet's own game (arcadeNativeGames.ts) goes on the same way: `core`
 *  is only a placeholder there, since no emulator runs it. */
export function builtInGame(id: string): ArcadeGame | null {
  const lib = BUILT_IN_GAMES.find((g) => g.id === id);
  if (lib) return { name: lib.title, core: 'nes', url: '', size: 0, bundled: lib.id };
  const own = nativeGameById(id);
  return own ? { name: own.title, core: 'nes', url: '', size: 0, bundled: own.id } : null;
}

/** The library entry behind a cabinet's game, or null for the owner's own
 *  (and for a cabinet's own game: nativeEntry). */
export function builtInEntry(g: ArcadeGame | null): BuiltInGame | null {
  return (g?.bundled && BUILT_IN_GAMES.find((b) => b.id === g.bundled)) || null;
}

/** The cabinet's own game behind a cabinet's game, or null. */
export function nativeEntry(g: ArcadeGame | null): NativeGame | null {
  return nativeGameById(g?.bundled);
}

/** What a cabinet nobody has set up plays: walk up and press play. */
export const ARCADE_DEFAULT_GAME: ArcadeGame | null = BUILT_IN_GAMES[0] ? builtInGame(BUILT_IN_GAMES[0].id) : null;

/** The name the marquee and the attract card show: a built-in game's title,
 *  or the file's name without its extension. */
export function gameTitle(g: ArcadeGame): string {
  const lib = builtInEntry(g);
  if (lib) return lib.title;
  return (g.name.replace(/\.[a-z0-9]{1,5}$/i, '').trim() || g.name).toUpperCase();
}

/** Where the emulator's own files (loader, engine, cores) come from. */
export type EmulatorData = 'station' | 'cdn';

export interface CabinetRecord {
  /** The one game on the cabinet (the owner's pick), or null when the owner
   *  took it off. */
  game: ArcadeGame | null;
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

/** One line of a cabinet's high-score table. */
export interface HighScore {
  /** Display copy of the player's name when the score was set. */
  name: string;
  score: number;
  /** The recording page's clock when the score was set (shown as a date). */
  at: number;
  /** One player's go in one match: a later, higher score from the same go
   *  replaces its line instead of adding another. */
  run: string;
}

/** The `scores:` key: the best ARCADE_SCORES_MAX, best first. */
export interface ScoresRecord {
  scores: HighScore[];
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

export const CABINET_DEFAULT: CabinetRecord = { game: ARCADE_DEFAULT_GAME, data: 'station', plays: 0, seq: 0 };
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

/** Seats as THIS page saw them, by seat key: the record's holder/page/
 *  leaseAt and OUR clock when that triple first appeared (the
 *  pusherCroupier `seeLease` idea). */
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
    seeSeat(key, readSeatAt(key), now);
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

/** Raw access for arcadeRomShare's own keys (`rom…:`), which carry the
 *  owner's game file to the players who press play, and arcadeLockstep's
 *  (`ls…:`), which carry the double-wide cabinet's players' buttons: their
 *  shapes are those modules' to check. Each write is its own transaction
 *  (one update each). */
export function arcadeRawGet(key: string): unknown {
  return ensureMap().get(key);
}
export function arcadeRawSet(key: string, value: unknown): void {
  write(key, value);
}
/** Several keys in one transaction (one update): a record and the pieces
 *  it names land together (arcadeLockstep). A value of undefined deletes
 *  its key. */
export function arcadeRawSetMany(entries: ReadonlyArray<readonly [string, unknown]>): void {
  if (entries.length === 0) return;
  const map = ensureMap();
  boundDoc!.transact(() => {
    for (const [k, v] of entries) {
      if (v === undefined) map.delete(k);
      else map.set(k, v);
    }
  });
}
export function arcadeRawDelete(keys: readonly string[]): void {
  const map = ensureMap();
  if (!keys.some((k) => map.has(k))) return;
  boundDoc!.transact(() => {
    for (const k of keys) map.delete(k);
  });
}
/** The keys under a prefix, at most `max` of them (a peer's keys are
 *  bounded before anything looks at them). */
export function arcadeRawKeys(prefix: string, max = 4096): string[] {
  const out: string[] = [];
  for (const k of ensureMap().keys()) {
    if (!k.startsWith(prefix)) continue;
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

export function cabinetKey(itemId: string): string {
  return `arcade:${itemId}`;
}
/** A seat's key: player one's is the cabinet's own (as before there were
 *  more), players two to four's carry their number. */
export function seatKey(itemId: string, seat = 0): string {
  return seat === 0 ? `seat:${itemId}` : `seat:${itemId}:${seat}`;
}
/** A seat number a caller may name: 0 (P1) to ARCADE_SEATS_MAX - 1. */
export function isSeatIndex(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < ARCADE_SEATS_MAX;
}
export function playsKey(itemId: string): string {
  return `plays:${itemId}`;
}
/** A cabinet's own game's high scores: one table per game, so putting
 *  another game on and back keeps each one's. */
export function scoresKey(itemId: string, gameId: string): string {
  return `scores:${itemId}:${gameId}`;
}

// ── Identity and authority seams (registered by main.ts, never asserted by a caller) ──

let identityProvider: () => { pub: string; name: string } = () => ({ pub: '', name: '' });
export function setArcadeIdentity(provider: () => { pub: string; name: string }): void {
  identityProvider = provider;
}
/** Curation: the game, the emulator files — the room's edit gate
 *  (shareholder-extended, see main.ts's authority split). */
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
/** Whether this client may take a player off the controls. The panel
 *  paints EJECT from here — the predicate the write itself checks — so no
 *  button is offered that standUp then refuses. */
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
 *  into the room-shared record, where `user:password@host`
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
  // A built-in game is its id and nothing else: one this build doesn't
  // ship (a newer client's) reads as no game.
  if (r.bundled !== undefined) return typeof r.bundled === 'string' ? builtInGame(r.bundled) : null;
  const name = str(r.name, ARCADE_MAX_NAME).trim();
  if (!name || !isArcadeCore(r.core)) return null;
  const url = str(r.url, ARCADE_MAX_URL);
  if (url && !isHttpUrl(url)) return null;
  const game: ArcadeGame = { name, core: r.core, url, size: Math.max(0, Math.floor(num(r.size))) };
  // A file's hash, for the copy the room sends (a link is fetched instead).
  if (!url && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256)) game.sha256 = r.sha256;
  return game;
}

/** The `arcade:` key as a peer may have written it: the curation alone. */
export function readCuration(itemId: string): CabinetCuration {
  const raw = ensureMap().get(cabinetKey(itemId)) as Partial<CabinetCuration> | undefined;
  if (!raw || typeof raw !== 'object') return { game: ARCADE_DEFAULT_GAME, data: 'station', seq: 0 };
  return {
    game: sanitizeGame(raw.game),
    // Serverless only (sovereignty.ts): a record that says `cdn` — written
    // by a build with the convenience lanes on, or by any peer — reads as
    // the station's own files here. The CDN is a server, whoever opted in.
    data: raw.data === 'cdn' && convenienceLanesEnabled() ? 'cdn' : 'station',
    seq: counter(raw.seq),
  };
}

/** The tally, from its own key. */
export function readPlays(itemId: string): number {
  const raw = ensureMap().get(playsKey(itemId)) as Partial<PlaysRecord> | undefined;
  if (!raw || typeof raw !== 'object') return PLAYS_DEFAULT.plays;
  return counter(raw.plays);
}

/** A high-score line as a peer may have written it, or null. */
function sanitizeScore(raw: unknown): HighScore | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, ARCADE_MAX_PLAYER).trim();
  const run = str(r.run, 160);
  if (!name || !run || !Number.isSafeInteger(r.score) || (r.score as number) <= 0) return null;
  return { name, score: Math.min(ARCADE_SCORE_TOP, r.score as number), at: Math.max(0, num(r.at)), run };
}

/** Best first; a tie goes to whoever set it first. */
const byScore = (a: HighScore, b: HighScore): number => b.score - a.score || a.at - b.at || (a.run < b.run ? -1 : 1);

/** A cabinet's high-score table for one of its own games, best first. */
export function readHighScores(itemId: string, gameId: string): HighScore[] {
  const raw = ensureMap().get(scoresKey(itemId, gameId)) as Partial<ScoresRecord> | undefined;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.scores)) return [];
  const seen = new Set<string>();
  const out: HighScore[] = [];
  for (const line of raw.scores.slice(0, ARCADE_SCORES_MAX * 4)) {
    const clean = sanitizeScore(line);
    if (!clean || seen.has(clean.run)) continue;
    seen.add(clean.run);
    out.push(clean);
  }
  return out.sort(byScore).slice(0, ARCADE_SCORES_MAX);
}

/** `table` with `goes` entered: a go already on it keeps its better score,
 *  a new one goes in where it ranks, and the table keeps its best
 *  ARCADE_SCORES_MAX. Pure (exported for its tests). */
export function mergeHighScores(table: readonly HighScore[], goes: readonly HighScore[]): HighScore[] {
  const byRun = new Map(table.map((line) => [line.run, line]));
  for (const go of goes) {
    const clean = sanitizeScore(go);
    if (!clean) continue;
    const had = byRun.get(clean.run);
    if (!had || clean.score > had.score) byRun.set(clean.run, clean);
  }
  return [...byRun.values()].sort(byScore).slice(0, ARCADE_SCORES_MAX);
}

/** Enter players' scores on the cabinet's table (the page hosting the game
 *  does, as each player's go ends and now and then while it lasts). Writes
 *  only when the table changes: a score that doesn't make it costs nothing.
 *  Whether it wrote. */
export function recordHighScores(itemId: string, gameId: string, goes: readonly HighScore[]): boolean {
  const table = readHighScores(itemId, gameId);
  const next = mergeHighScores(table, goes);
  const same = next.length === table.length
    && next.every((line, i) => line.run === table[i]!.run && line.score === table[i]!.score);
  if (same) return false;
  write(scoresKey(itemId, gameId), { scores: next } satisfies ScoresRecord);
  return true;
}

/** Wipe a game's table on this cabinet (the owner). */
export function clearHighScores(itemId: string, gameId: string): ArcadeAction {
  const gate = ownerGate();
  if (!gate.ok) return gate;
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.delete(scoresKey(itemId, gameId));
  });
  return { ok: true };
}

/** What the panel, the stage and the screen show: the curation with the
 *  tally joined from its key. */
export function readCabinet(itemId: string): CabinetRecord {
  return { ...readCuration(itemId), plays: readPlays(itemId) };
}

export function readSeat(itemId: string, seat = 0): SeatRecord {
  return readSeatAt(seatKey(itemId, seat));
}

function readSeatAt(key: string): SeatRecord {
  const raw = ensureMap().get(key) as Partial<SeatRecord> | undefined;
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

// ── The seats: player one, and two to four on the double-wide cabinet ──────

export type SeatStatus = 'free' | 'mine' | 'held';
export type ArcadeAction = { ok: true } | { ok: false; error: string };

function seeSeat(key: string, rec: SeatRecord, now: number): SeenSeat {
  const seen = seenSeats.get(key);
  if (seen && seen.holder === rec.holder && seen.page === rec.page && seen.leaseAt === rec.leaseAt) return seen;
  const fresh = { holder: rec.holder, page: rec.page, leaseAt: rec.leaseAt, at: now };
  seenSeats.set(key, fresh);
  return fresh;
}

/** Whether a held seat has gone quiet long enough to count as left —
 *  judged by the renewals THIS page saw, never by the holder's clock. */
export function seatLapsed(itemId: string, seat = 0, now = clock()): boolean {
  const key = seatKey(itemId, seat);
  const rec = readSeatAt(key);
  if (!rec.holder) return true;
  return now - seeSeat(key, rec, now).at >= ARCADE_SEAT_LAPSE_MS;
}

/** 'mine' only from the page that inserted the coin. */
export function seatStatus(itemId: string, seat = 0, now = clock()): SeatStatus {
  const rec = readSeat(itemId, seat);
  if (!rec.holder) return 'free';
  if (rec.holder === identityProvider().pub && rec.page === pageId) return 'mine';
  return seatLapsed(itemId, seat, now) ? 'free' : 'held';
}

export function iAmP1(itemId: string): boolean {
  return seatStatus(itemId, 0) === 'mine';
}

/** The seat this page holds at the cabinet (of its first `seats`), or null. */
export function mySeat(itemId: string, seats = ARCADE_SEATS_MAX): number | null {
  for (let n = 0; n < Math.min(seats, ARCADE_SEATS_MAX); n++) if (seatStatus(itemId, n) === 'mine') return n;
  return null;
}

/** Who holds each of the cabinet's first `seats` now (a lapsed lease is
 *  nobody's): the panel's and the screen's list of players. */
export function seatHolders(itemId: string, seats = ARCADE_SEATS_MAX, now = clock()): Array<SeatRecord | null> {
  const out: Array<SeatRecord | null> = [];
  for (let n = 0; n < Math.min(seats, ARCADE_SEATS_MAX); n++) {
    const rec = readSeat(itemId, n);
    out.push(rec.holder && seatStatus(itemId, n, now) !== 'free' ? rec : null);
  }
  return out;
}

/** May this page take the seat now: free, lapsed, already mine — or held,
 *  and I hold the room's deed (sitting down over someone unseats them: the
 *  eject predicate, never the edit gate). */
export function maySit(itemId: string, seat = 0, now = clock()): boolean {
  if (!isSeatIndex(seat)) return false;
  return seatStatus(itemId, seat, now) !== 'held' || ejectPredicate();
}

/** INSERT COIN: take the seat from this page — P1 unless another is named.
 *  A page holds one seat of a cabinet: taking another gives up the first,
 *  in the same write. */
export function insertCoin(itemId: string, seat = 0, now = clock()): ArcadeAction {
  const { pub, name } = identityProvider();
  if (!pub) return { ok: false, error: 'No identity on this device yet.' };
  if (!isSeatIndex(seat)) return { ok: false, error: 'The cabinet has no such seat.' };
  const rec = readSeat(itemId, seat);
  if (!maySit(itemId, seat, now)) {
    return { ok: false, error: `${rec.name || 'Someone'} is at the controls.` };
  }
  const map = ensureMap();
  boundDoc!.transact(() => {
    for (let n = 0; n < ARCADE_SEATS_MAX; n++) {
      if (n !== seat && seatStatus(itemId, n, now) === 'mine') {
        map.set(seatKey(itemId, n), { holder: '', name: '', page: '', leaseAt: now, by: pub } satisfies SeatRecord);
      }
    }
    map.set(seatKey(itemId, seat), {
      holder: pub, name: name.slice(0, ARCADE_MAX_PLAYER), page: pageId, leaseAt: now, by: pub,
    } satisfies SeatRecord);
  });
  return { ok: true };
}

/** Renew my seat (a seated page's tick calls this every ARCADE_SEAT_RENEW_MS). */
export function renewSeat(itemId: string, seat = 0, now = clock()): void {
  const { pub, name } = identityProvider();
  if (!pub || !isSeatIndex(seat)) return;
  const rec = readSeat(itemId, seat);
  if (rec.holder !== pub || rec.page !== pageId) return;
  write(seatKey(itemId, seat), {
    holder: pub, name: name.slice(0, ARCADE_MAX_PLAYER), page: pageId, leaseAt: now, by: pub,
  } satisfies SeatRecord);
}

/** Stand up from a seat (P1 unless another is named). The holder's page
 *  may; so may the room's deed holder (EJECT — the one authority that
 *  unseats people, #142). */
export function standUp(itemId: string, seat = 0, now = clock()): ArcadeAction {
  const { pub } = identityProvider();
  if (!isSeatIndex(seat)) return { ok: true };
  const rec = readSeat(itemId, seat);
  if (!rec.holder) return { ok: true };
  const mine = rec.holder === pub && rec.page === pageId;
  if (!mine && !ejectPredicate()) {
    return { ok: false, error: `${rec.name || 'Someone'} is at the controls.` };
  }
  write(seatKey(itemId, seat), { holder: '', name: '', page: '', leaseAt: now, by: pub } satisfies SeatRecord);
  return { ok: true };
}

// ── The cabinet: the owner picks its one game ───────────────────────────────

function ownerGate(): ArcadeAction {
  return hostPredicate() ? { ok: true } : { ok: false, error: 'Only the room owner changes the cabinet.' };
}

/** Put a game on the cabinet in place of the last (the owner, any game). */
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

/** Where the emulator's own files come from (the owner's call, per cabinet).
 *  The CDN is an opt-in the build has to allow (sovereignty.ts). */
export function setEmulatorData(itemId: string, data: EmulatorData): ArcadeAction {
  const gate = ownerGate();
  if (!gate.ok) return gate;
  if (data === 'cdn' && !convenienceLanesEnabled()) {
    return { ok: false, error: `The CDN lane is off in this build — ${SERVERLESS_ONLY}.` };
  }
  const rec = readCuration(itemId);
  write(cabinetKey(itemId), { ...rec, data: data === 'cdn' ? 'cdn' : 'station', seq: bump(rec.seq) } satisfies CabinetCuration);
  return { ok: true };
}

/** A game started by a seated player: one more on the tally — its own
 *  key, so a play counted as the owner changes the game reverts neither the
 *  change nor the count. */
export function countPlay(itemId: string): void {
  if (mySeat(itemId) === null) return;
  write(playsKey(itemId), { plays: bump(readPlays(itemId)) } satisfies PlaysRecord);
}

/** A built-in game started on the cabinet: the page that hosts it counts
 *  it (there is no P1 seat — the shared game is its host's). */
export function countBuiltInPlay(itemId: string): void {
  const game = readCuration(itemId).game;
  if (!builtInEntry(game) && !nativeEntry(game)) return;
  write(playsKey(itemId), { plays: bump(readPlays(itemId)) } satisfies PlaysRecord);
}

// ── Games: identity, lanes, parsing (pure) ───────────────────────────────────

/** Stable identity of a game: a built-in one's id, the link, or — for a
 *  file on a player's disk — its name AND size, so two different ROMs that
 *  happen to share a name do not share an identity (the page keeps local
 *  files by this id). */
export function gameId(g: ArcadeGame): string {
  if (g.bundled) return `built-in:${g.bundled}`;
  return `${g.core}:${g.url || `file:${g.name}:${g.size}`}`;
}

export type ArcadeLane = 'SOVEREIGN' | 'CONVENIENCE';

/** The lane badge: a built-in game (this app's own files), a file on the
 *  player's own disk, or a loopback URL (the node's own listener), is
 *  sovereign; anything fetched from the web is a convenience lane. */
export function gameLane(g: ArcadeGame): ArcadeLane {
  if (!g.url) return 'SOVEREIGN';
  try {
    const u = new URL(g.url);
    if (ownMediaOrigins().includes(u.origin)) return 'SOVEREIGN'; // this page's origin, or the viewer's own node
    const h = u.hostname;
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
  /** Under it: INSERT COIN, "P1 · <name>" (or, with more than one
   *  player, how many and at which seats), or what the owner must do. */
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
  if (!rec.game) {
    return { mode: 'empty', title: 'FURLONG ARCADE', line: 'THE OWNER PICKS A GAME', lane: '', blink: false, plays: rec.plays };
  }
  // A built-in game's picture is the shared game itself (arcadeNesSession
  // paints over this card while one runs); the seats are EmulatorJS's.
  const seated = rec.game.bundled ? [] : seatHolders(itemId, ARCADE_SEATS_MAX, now)
    .map((r, n) => (r && !seatLapsed(itemId, n, now) ? { n, name: r.name } : null))
    .filter((p): p is { n: number; name: string } => p !== null);
  if (seated.length > 0) {
    // One player is named; more are counted, with their seats (names do
    // not fit the card four at a time — the panel lists them).
    const line = seated.length === 1
      ? `P${seated[0]!.n + 1} · ${seated[0]!.name || 'a clone'}`
      : `${seated.length} PLAYERS · ${seated.map((p) => `P${p.n + 1}`).join(' ')}`;
    return { mode: 'inplay', title: gameTitle(rec.game), line, lane: gameLane(rec.game), blink: false, plays: rec.plays };
  }
  const blink = Math.floor(now / ARCADE_BLINK_MS) % 2 === 0;
  return {
    mode: 'attract',
    title: gameTitle(rec.game),
    line: rec.game.bundled ? 'PRESS START' : 'INSERT COIN',
    lane: gameLane(rec.game),
    blink,
    plays: rec.plays,
  };
}
