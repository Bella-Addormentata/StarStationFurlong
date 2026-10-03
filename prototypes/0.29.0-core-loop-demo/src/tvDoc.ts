/**
 * 📺 tvDoc — the smart TV's shared records (#186): what is on, where the
 * playback is, and who holds the remote.
 *
 * Three keys per TV in the room doc's `tv` map, plain JSON, whole-value
 * transacted writes, LWW per key (the partyDoc discipline):
 *   tv:<itemId>     → TvProgramme  the programme and the playback clock
 *   remote:<itemId> → RemoteRecord the remote control's holder (a lease)
 *   volume:<itemId> → { volume }   the set's volume, a body button
 *   power:<itemId>  → { on, seq }  the set's switch, a body button
 * They are SEPARATE keys so renewing the remote's lease never collides with
 * a playback write (the `giftwish:` precedent in partyDoc.ts), and so a
 * viewer turning the sound down while the holder seeks can never carry a
 * stale programme back over the holder's write: whole-value LWW keeps one
 * writer per key, so each thing that changes on its own has a key of its
 * own. readTv joins the programme and the volume for the readers.
 *
 * THE SYNC RULE (plan §3.1, brainstorming/smart-tv-arcade-media-plan.md):
 * the holder writes `{positionMs, seq}` every TV_HEARTBEAT_MS while playing.
 * A receiver notes its OWN clock when a new `seq` lands (`readSample`) and
 * extrapolates from that — `expected = positionMs + (now − receivedAt)`. No
 * device ever compares its clock with another's (the croupier.ts rule).
 * `startAt` (UTC) drives only the countdown display and the first second
 * after T0, until the holder's first heartbeat lands.
 *
 * THE REMOTE IS POSSESSION, NOT A ROLE (owner ruling 2026-10-03): whoever
 * holds it controls the TV. Anyone may pick a free remote up, hand it to
 * another player, or put it down; a holder renews it every
 * TV_LEASE_RENEW_MS, and it lapses TV_LEASE_LAPSE_MS after the last renewal
 * THIS PAGE SAW (never by the holder's clock — the pusherCroupier.ts
 * CLOCKS rule); the room owner (the registered host predicate) may take it
 * from anyone. The set's body buttons — power and volume — need no remote,
 * like a real one. A remote is held by a PAGE, never a key: two tabs of one
 * browser share the key (the seed lives in localStorage), and only the page
 * that picked the remote up renews it, beats the clock and lets go on leave;
 * the other tab is a viewer that may take it over, as the same person.
 *
 * ENFORCEMENT POSTURE (dev phase, the doorPolicy.ts rule): every write is
 * gated here and every read is shape-checked, so a peer running edited code
 * can at worst switch the TV off. Nothing here is worth forging.
 *
 * REBIND PER JOIN (T0 seam): main.ts joinRoomAtEpoch calls bindTvDoc beside
 * bindPartyDoc; the offline fallback mirrors partyDoc (a page-local doc binds
 * lazily so a solo room still works).
 */

import * as Y from 'yjs';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** The holder's playback heartbeat cadence while playing. */
export const TV_HEARTBEAT_MS = 3_000;
/** How often a holder renews the remote's lease. */
export const TV_LEASE_RENEW_MS = 3_000;
/** A remote not renewed for this long (as THIS page saw it) is free again. */
export const TV_LEASE_LAPSE_MS = 8_000;
/** A viewer further than this from the holder's clock SEEKS… */
export const TV_SEEK_OVER_MS = 1_500;
/** …and nearer than that but further than this nudges the playback rate. */
export const TV_NUDGE_OVER_MS = 250;
/** The playback-rate nudge (±3 %) for players that can change rate finely. */
export const TV_NUDGE_RATE = 0.03;
export const TV_HISTORY_MAX = 20;
export const TV_MAX_TITLE = 80;
export const TV_MAX_URL = 2048;
export const TV_MAX_NAME = 32;

// ── Records ──────────────────────────────────────────────────────────────────

/** Where the bytes come from. The class the plan's §3.3 badges name rides
 *  with the kind: youtube/archive/url are convenience lanes; everything that
 *  later arrives over our own node (blob, torrent, karaoke) is sovereign. */
export type TvSource =
  | { kind: 'youtube'; videoId: string; title?: string }
  | { kind: 'archive'; identifier: string; file: string; title?: string }
  | { kind: 'url'; url: string; title?: string };

export type TvState = 'off' | 'home' | 'scheduled' | 'playing' | 'paused';

export interface TvHistoryEntry {
  source: TvSource;
  title: string;
  playedAt: number;
}

/** The `tv:` key: what is on and where the playback is. The set's volume is
 *  NOT here (its own key, below), so a volume press can never overwrite a
 *  transport write. */
export interface TvProgramme {
  source: TvSource | null;
  state: TvState;
  /** UTC ms — the countdown, 'scheduled' only (0 otherwise). */
  startAt: number;
  /** The holder's last reported position… */
  positionMs: number;
  /** …stamped with a per-write counter: a NEW seq is a new sample, which is
   *  what a receiver anchors its own clock to. Never a wall-clock time. */
  seq: number;
  /** The seq of the write that STARTED the current programme (PLAY NOW, a
   *  schedule): a replay of the same source is a new start, which a player
   *  that cannot seek (the archive embed) needs to know. */
  started: number;
  /** The programme-ACTION revision: bumped by every transport write (play,
   *  schedule, pause, resume, seek, stop, power) and never by a heartbeat.
   *  The holder follows a new revision exactly once and otherwise only ever
   *  publishes where its own player is; a lookup started under an older
   *  revision is void. */
  jump: number;
  /** The holder's name on the sample, for the screen's "with <name>" line. */
  history: TvHistoryEntry[];
}

/** What a reader sees: the programme joined with the set's volume. */
export interface TvRecord extends TvProgramme {
  /** 0–100, a body button: anyone may change it (it is the SET's volume,
   *  every client scales its own output by it). Read from `volume:<itemId>`. */
  volume: number;
}

export interface RemoteRecord {
  /** The holder's identity pub (base64url), '' when the remote is on the TV. */
  holder: string;
  /** Display copy of the holder's name (never resolved — peers pick their own). */
  name: string;
  /** The holder's own clock at the last renewal: compared ONLY against earlier
   *  values from the same holder to detect a renewal — never against ours. */
  leaseAt: number;
  /** Who wrote the record: the holder on a pick-up or renewal, the GIVER on
   *  a hand-over — which is how a phone knows to pop open on receipt. */
  by: string;
  /** The holder's PAGE — a per-page-load id, never the identity: two tabs
   *  with one key are two pages, and only the one that picked the remote up
   *  renews it, beats the clock and lets go on leave. '' on a hand-over,
   *  until the first of the receiver's pages claims it (claimRemote). */
  page: string;
}

export const TV_DEFAULT_PROGRAMME: TvProgramme = {
  source: null,
  state: 'off',
  startAt: 0,
  positionMs: 0,
  seq: 0,
  started: 0,
  jump: 0,
  history: [],
};

export const TV_DEFAULT: TvRecord = { ...TV_DEFAULT_PROGRAMME, volume: 70 };

export const REMOTE_FREE: RemoteRecord = { holder: '', name: '', leaseAt: 0, by: '', page: '' };

/** The `power:` key: the set's switch, a body button anyone may press. Its
 *  own key, like the volume, so a press never races the holder's heartbeat
 *  in the programme's LWW slot. Off keeps the programme, like a real TV; on
 *  brings it back — the holder's tick parks a programme that was playing
 *  where it was (tvSession), and a set with nothing on shows the home
 *  screen. `seq` is a revision: a lookup in flight is void past it. */
export interface PowerRecord {
  on: boolean;
  seq: number;
}

export const POWER_DEFAULT: PowerRecord = { on: false, seq: 0 };

// ── Binding (the partyDoc shape) ─────────────────────────────────────────────

let boundDoc: Y.Doc | null = null;
let tvMap: Y.Map<unknown> | null = null;
let bindingEpoch = 0;
const listeners = new Set<() => void>();
const keyListeners = new Map<string, Set<() => void>>();

/** The receipt clock — injectable so the sync maths can be tested against a
 *  fake clock. Production: Date.now. */
let clock: () => number = () => Date.now();
export function setTvClock(fn: () => number): void {
  clock = fn;
}
export function tvNow(): number {
  return clock();
}

/** Playback samples as THIS page received them: the record's seq, its
 *  positionMs, and OUR clock when it landed. Keyed by TV item id. */
interface Sample {
  seq: number;
  positionMs: number;
  receivedAt: number;
}
const samples = new Map<string, Sample>();

/** Remote leases as THIS page saw them: the record's holder/leaseAt and OUR
 *  clock when that pair first appeared (the pusherCroupier `seeLease` idea). */
interface SeenLease {
  holder: string;
  page: string;
  leaseAt: number;
  at: number;
}
const seenLeases = new Map<string, SeenLease>();

function notify(changedKeys?: Set<string>): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[tv] listener threw during doc notify:', err);
    }
  }
  for (const [key, keyed] of keyListeners) {
    if (changedKeys && !changedKeys.has(key)) continue;
    for (const listener of [...keyed]) {
      try {
        listener();
      } catch (err) {
        console.error(`[tv] listener for '${key}' threw during doc notify:`, err);
      }
    }
  }
}

function docAlive(): boolean {
  return boundDoc !== null && (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true;
}

/** Note a fresh playback sample for every tv: key that changed, and the
 *  arrival of every remote: lease. Runs inside the observer so `receivedAt`
 *  (and a lease's `at`) is the moment the update applied HERE — a lease is
 *  "seen" when it lands, not when something first asks about it. */
function noteSamples(keys: Iterable<string>): void {
  if (!tvMap) return;
  const now = clock();
  for (const key of keys) {
    if (key.startsWith('remote:')) {
      const itemId = key.slice(7);
      seeLease(itemId, readRemote(itemId), now);
      continue;
    }
    if (!key.startsWith('tv:')) continue;
    const itemId = key.slice(3);
    const rec = readProgramme(itemId);
    const prev = samples.get(itemId);
    if (!prev || prev.seq !== rec.seq) {
      samples.set(itemId, { seq: rec.seq, positionMs: rec.positionMs, receivedAt: now });
    }
  }
}

export function bindTvDoc(doc: Y.Doc): void {
  bindingEpoch += 1;
  boundDoc = doc;
  tvMap = doc.getMap('tv');
  samples.clear();
  seenLeases.clear();
  tvMap.observe((event) => {
    noteSamples(event.keysChanged);
    notify(event.keysChanged);
  });
  // A fresh doc's existing records are samples too (a late joiner's first
  // read anchors to NOW: it cannot know how old the holder's position is,
  // which is why the holder's next heartbeat corrects it within 3 s).
  noteSamples([...tvMap.keys()]);
  notify();
}

export function tvDocEpoch(): number {
  return bindingEpoch;
}

function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !tvMap) bindTvDoc(new Y.Doc());
  return tvMap!;
}

export function subscribeTv(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeTvKey(key: string, listener: () => void): () => void {
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

export function tvKey(itemId: string): string {
  return `tv:${itemId}`;
}
export function remoteKey(itemId: string): string {
  return `remote:${itemId}`;
}
export function volumeKey(itemId: string): string {
  return `volume:${itemId}`;
}
export function powerKey(itemId: string): string {
  return `power:${itemId}`;
}

// ── Identity and host seams (registered by main.ts, never asserted by a caller) ──

let identityProvider: () => { pub: string; name: string } = () => ({ pub: '', name: '' });
export function setTvIdentity(provider: () => { pub: string; name: string }): void {
  identityProvider = provider;
}
let hostPredicate: () => boolean = () => false;
export function setTvHostPredicate(predicate: () => boolean): void {
  hostPredicate = predicate;
}
/** This page's id for the lease: a page LOAD, not a device and not a key
 *  (the pusherCroupier sessionId idea). main.ts sets a fresh one per load. */
let pageId = `page-${Math.random().toString(36).slice(2, 12)}`;
export function setTvPageId(id: string): void {
  pageId = id.slice(0, 128);
}
export function tvPageId(): string {
  return pageId;
}

// ── Shape-checked reads ──────────────────────────────────────────────────────

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
/** One rule for every revision counter (`seq`, `started`, `jump`, the
 *  switch's `seq`): a reader compares it for CHANGE, never for order, and a
 *  writer moves it by one, so it must be a whole number that one more still
 *  moves. A peer's `Number.MAX_VALUE` passes as a finite number, yet adding
 *  one to it changes nothing — and a `seq` that cannot move is a sample
 *  nobody re-anchors to, a `jump` no holder follows, a power press that
 *  voids no lookup. So a counter reads as a safe integer or as the floor,
 *  and the bump past the ceiling is the floor again: a wrap costs a
 *  change-only comparison nothing, and no counter can ever stop moving. */
export const TV_COUNTER_MAX = Number.MAX_SAFE_INTEGER;
const counter = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const bump = (v: number): number => (v >= TV_COUNTER_MAX ? 0 : v + 1);

/** A source as a peer may have written it, or null. Unknown kinds and
 *  non-http(s) URLs are dropped at the read boundary — a `javascript:` URL
 *  must never reach a <video> or an iframe. */
export function sanitizeSource(raw: unknown): TvSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, TV_MAX_TITLE);
  const withTitle = <T extends TvSource>(s: T): T => (title ? { ...s, title } : s);
  if (r.kind === 'youtube') {
    const videoId = str(r.videoId, 20);
    return /^[A-Za-z0-9_-]{11}$/.test(videoId) ? withTitle({ kind: 'youtube', videoId }) : null;
  }
  if (r.kind === 'archive') {
    const identifier = str(r.identifier, 120);
    const file = str(r.file, 400);
    if (!/^[A-Za-z0-9._-]+$/.test(identifier)) return null;
    // Archive filenames carry spaces as a rule ("a film.mp4"): sourceFileUrl
    // percent-encodes each segment, so only a leading separator or blank and
    // control characters are refused here.
    if (file && !/^[^\s/\\][^\x00-\x1f\x7f]*$/.test(file)) return null;
    return withTitle({ kind: 'archive', identifier, file });
  }
  if (r.kind === 'url') {
    const url = str(r.url, TV_MAX_URL);
    return isHttpUrl(url) ? withTitle({ kind: 'url', url }) : null;
  }
  return null;
}

/** http(s) only, and never a URL carrying credentials: a source goes into
 *  the room-shared record and its history, where `user:password@host` would
 *  be read by every peer, not just the media host. */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

const STATES: ReadonlySet<string> = new Set(['off', 'home', 'scheduled', 'playing', 'paused']);

/** The `tv:` key as a peer may have written it: the programme alone. */
export function readProgramme(itemId: string): TvProgramme {
  const raw = ensureMap().get(tvKey(itemId)) as Partial<TvProgramme> | undefined;
  if (!raw || typeof raw !== 'object') return { ...TV_DEFAULT_PROGRAMME };
  const source = sanitizeSource(raw.source);
  const state = typeof raw.state === 'string' && STATES.has(raw.state) ? (raw.state as TvState) : 'off';
  const history = Array.isArray(raw.history)
    ? raw.history
        .slice(0, TV_HISTORY_MAX) // bound the work before the shape check: a peer's array is not
        .map((h) => {
          const e = h as Partial<TvHistoryEntry> | null;
          const s = e && typeof e === 'object' ? sanitizeSource(e.source) : null;
          return s ? { source: s, title: str(e!.title, TV_MAX_TITLE), playedAt: num(e!.playedAt) } : null;
        })
        .filter((e): e is TvHistoryEntry => e !== null)
        .slice(0, TV_HISTORY_MAX)
    : [];
  return {
    source,
    // A programme-less record cannot be playing: it shows the home screen.
    state: source === null && (state === 'playing' || state === 'paused' || state === 'scheduled') ? 'home' : state,
    startAt: Math.max(0, num(raw.startAt)),
    positionMs: Math.max(0, num(raw.positionMs)),
    seq: counter(raw.seq),
    started: counter(raw.started),
    jump: counter(raw.jump),
    history,
  };
}

/** The set's volume, 0–100, from its own key; the default for anything a
 *  peer may have written there that is not a number. */
export function readVolume(itemId: string): number {
  const raw = ensureMap().get(volumeKey(itemId)) as { volume?: unknown } | undefined;
  const v = raw && typeof raw === 'object' ? num(raw.volume, TV_DEFAULT.volume) : TV_DEFAULT.volume;
  return Math.min(100, Math.max(0, Math.round(v)));
}

/** The set's switch, from its own key; off until someone turns it on. */
export function readPower(itemId: string): PowerRecord {
  const raw = ensureMap().get(powerKey(itemId)) as Partial<PowerRecord> | undefined;
  if (!raw || typeof raw !== 'object') return { ...POWER_DEFAULT };
  return { on: raw.on === true, seq: counter(raw.seq) };
}

/** What a screen, a phone or the theatre shows: the programme, the switch
 *  and the volume, joined from their keys. Off is off whatever the programme
 *  says; on with nothing on (or a legacy 'off' written into the programme)
 *  is the home screen. */
export function readTv(itemId: string): TvRecord {
  const programme = readProgramme(itemId);
  const state: TvState = !readPower(itemId).on ? 'off' : programme.state === 'off' ? 'home' : programme.state;
  return { ...programme, state, volume: readVolume(itemId) };
}

/** The revision a lookup in flight is checked against: any programme action
 *  (`jump`) or power press (`seq`) meanwhile voids it. */
export function tvRevision(itemId: string): string {
  return `${readProgramme(itemId).jump}:${readPower(itemId).seq}`;
}

export function readRemote(itemId: string): RemoteRecord {
  const raw = ensureMap().get(remoteKey(itemId)) as Partial<RemoteRecord> | undefined;
  if (!raw || typeof raw !== 'object') return { ...REMOTE_FREE };
  const holder = str(raw.holder, 128);
  return {
    holder,
    name: holder ? str(raw.name, TV_MAX_NAME) : '',
    leaseAt: num(raw.leaseAt),
    by: str(raw.by, 128),
    page: holder ? str(raw.page, 128) : '',
  };
}

// ── The remote: possession ───────────────────────────────────────────────────

export type RemoteStatus = 'free' | 'mine' | 'held';

/** Note the lease as this page sees it now; a changed holder/leaseAt pair
 *  restarts the page's own lapse clock. */
function seeLease(itemId: string, rec: RemoteRecord, now: number): SeenLease {
  const seen = seenLeases.get(itemId);
  if (seen && seen.holder === rec.holder && seen.page === rec.page && seen.leaseAt === rec.leaseAt) return seen;
  const fresh = { holder: rec.holder, page: rec.page, leaseAt: rec.leaseAt, at: now };
  seenLeases.set(itemId, fresh);
  return fresh;
}

/** Whether a held remote has gone quiet long enough to count as dropped —
 *  judged by the renewals THIS page saw, never by the holder's clock. */
export function remoteLapsed(itemId: string, now = clock()): boolean {
  const rec = readRemote(itemId);
  if (!rec.holder) return true;
  const seen = seeLease(itemId, rec, now);
  return now - seen.at >= TV_LEASE_LAPSE_MS;
}

export function remoteStatus(itemId: string, now = clock()): RemoteStatus {
  const rec = readRemote(itemId);
  if (!rec.holder) return 'free';
  // Mine only on the page that holds it: the same key in another tab reads
  // "held" (by me, elsewhere), and so does a hand-over not yet claimed.
  if (rec.holder === identityProvider().pub && rec.holder !== '' && rec.page === pageId) return 'mine';
  return remoteLapsed(itemId, now) ? 'free' : 'held';
}

export function iHoldRemote(itemId: string): boolean {
  return remoteStatus(itemId) === 'mine';
}

export type TvAction = { ok: true } | { ok: false; error: string };

/** May this client take the remote right now: it is free, it lapsed, I am
 *  the room's owner (the spare remote), I already hold it, or it is in my
 *  own other tab (one person, one place: the newer tab takes it). */
export function mayPickUpRemote(itemId: string, now = clock()): boolean {
  const status = remoteStatus(itemId, now);
  return status !== 'held' || hostPredicate() || readRemote(itemId).holder === identityProvider().pub;
}

export function pickUpRemote(itemId: string, now = clock()): TvAction {
  const { pub, name } = identityProvider();
  if (!pub) return { ok: false, error: 'No identity on this device yet.' };
  const rec = readRemote(itemId);
  if (!mayPickUpRemote(itemId, now)) {
    return { ok: false, error: `${rec.name || 'Someone'} is holding the remote.` };
  }
  write(remoteKey(itemId), { holder: pub, name: name.slice(0, TV_MAX_NAME), leaseAt: now, by: pub, page: pageId } satisfies RemoteRecord);
  return { ok: true };
}

/** Renew my hold (the holder's tick calls this every TV_LEASE_RENEW_MS) —
 *  from the page that holds it; my other tabs have nothing to renew. */
export function renewRemote(itemId: string, now = clock()): void {
  const { pub, name } = identityProvider();
  const rec = readRemote(itemId);
  if (!pub || rec.holder !== pub || rec.page !== pageId) return;
  write(remoteKey(itemId), { holder: pub, name: name.slice(0, TV_MAX_NAME), leaseAt: now, by: pub, page: pageId } satisfies RemoteRecord);
}

/** A remote handed to my identity is nobody's page yet: the first of my
 *  pages to see it takes it (two tabs, one key — the loser of the race sees
 *  another page on it and stays a viewer). False when there is nothing to
 *  claim. The giver stays in `by`, so the phone still pops open on receipt. */
export function claimRemote(itemId: string, now = clock()): boolean {
  const { pub, name } = identityProvider();
  const rec = readRemote(itemId);
  if (!pub || rec.holder !== pub || rec.page !== '') return false;
  write(remoteKey(itemId), { holder: pub, name: name.slice(0, TV_MAX_NAME), leaseAt: now, by: rec.by, page: pageId } satisfies RemoteRecord);
  return true;
}

/** Put it back on the TV. The holder may; so may the owner (taking it away). */
export function putDownRemote(itemId: string, now = clock()): TvAction {
  const { pub } = identityProvider();
  const rec = readRemote(itemId);
  if (!rec.holder) return { ok: true };
  if (rec.holder !== pub && !hostPredicate()) {
    return { ok: false, error: `${rec.name || 'Someone'} is holding the remote.` };
  }
  write(remoteKey(itemId), { holder: '', name: '', leaseAt: now, by: pub, page: '' } satisfies RemoteRecord);
  return { ok: true };
}

/** Hand the remote to another player. No accept step, as in life. The
 *  receiver's page is unknown here: `page` is '' until one of theirs claims it. */
export function handRemote(itemId: string, toPub: string, toName: string, now = clock()): TvAction {
  const { pub } = identityProvider();
  if (!toPub || toPub === pub) return { ok: false, error: 'Pick someone else.' };
  if (remoteStatus(itemId, now) !== 'mine' && !hostPredicate()) {
    return { ok: false, error: 'You are not holding the remote.' };
  }
  write(remoteKey(itemId), { holder: toPub, name: toName.slice(0, TV_MAX_NAME), leaseAt: now, by: pub, page: '' } satisfies RemoteRecord);
  return { ok: true };
}

/** Writes to the programme need the remote in hand. */
function mayControl(itemId: string): TvAction {
  const status = remoteStatus(itemId);
  if (status === 'mine') return { ok: true };
  const rec = readRemote(itemId);
  const elsewhere = rec.holder !== '' && rec.holder === identityProvider().pub;
  return {
    ok: false,
    error: status === 'held'
      ? (elsewhere ? 'You are holding the remote in another tab.' : `${rec.name || 'Someone'} has the remote.`)
      : 'Pick up the remote first.',
  };
}

// ── The programme ────────────────────────────────────────────────────────────

function titleOf(source: TvSource): string {
  return source.title || sourceLabel(source);
}

function withHistory(rec: TvProgramme, source: TvSource, now: number): TvHistoryEntry[] {
  const key = sourceId(source);
  const rest = rec.history.filter((h) => sourceId(h.source) !== key);
  return [{ source, title: titleOf(source), playedAt: now }, ...rest].slice(0, TV_HISTORY_MAX);
}

/** Play `source` now, from the top. */
export function tvPlay(itemId: string, source: TvSource, now = clock()): TvAction {
  const gate = mayControl(itemId);
  if (!gate.ok) return gate;
  const clean = sanitizeSource(source);
  if (!clean) return { ok: false, error: 'That is not something the TV can play.' };
  switchOn(itemId);
  const rec = readProgramme(itemId);
  write(tvKey(itemId), {
    ...rec,
    source: clean,
    state: 'playing',
    startAt: 0,
    positionMs: 0,
    seq: bump(rec.seq),
    started: bump(rec.seq),
    jump: bump(rec.jump),
    history: withHistory(rec, clean, now),
  } satisfies TvProgramme);
  return { ok: true };
}

/** Schedule `source` for a UTC start — the countdown everyone sees. */
export function tvSchedule(itemId: string, source: TvSource, startAt: number, now = clock()): TvAction {
  const gate = mayControl(itemId);
  if (!gate.ok) return gate;
  const clean = sanitizeSource(source);
  if (!clean) return { ok: false, error: 'That is not something the TV can play.' };
  if (!Number.isFinite(startAt) || startAt <= now) return { ok: false, error: 'Pick a time that is still ahead.' };
  switchOn(itemId);
  const rec = readProgramme(itemId);
  write(tvKey(itemId), {
    ...rec,
    source: clean,
    state: 'scheduled',
    startAt: Math.floor(startAt),
    positionMs: 0,
    seq: bump(rec.seq),
    started: bump(rec.seq),
    jump: bump(rec.jump),
    history: withHistory(rec, clean, now),
  } satisfies TvProgramme);
  return { ok: true };
}

/** The holder's heartbeat while playing, and the T0 flip from scheduled. */
export function tvHeartbeat(itemId: string, positionMs: number): TvAction {
  const gate = mayControl(itemId);
  if (!gate.ok) return gate;
  if (!readPower(itemId).on) return { ok: false, error: 'The set is off.' };
  const rec = readProgramme(itemId);
  if (rec.state !== 'playing' && rec.state !== 'scheduled') return { ok: false, error: 'Nothing is playing.' };
  write(tvKey(itemId), {
    ...rec,
    state: 'playing',
    startAt: 0,
    positionMs: Math.max(0, Math.floor(positionMs)),
    seq: bump(rec.seq),
  } satisfies TvProgramme);
  return { ok: true };
}

export function tvPause(itemId: string, positionMs: number): TvAction {
  const gate = mayControl(itemId);
  if (!gate.ok) return gate;
  const rec = readProgramme(itemId);
  if (rec.state !== 'playing') return { ok: false, error: 'Nothing is playing.' };
  write(tvKey(itemId), {
    ...rec,
    state: 'paused',
    positionMs: Math.max(0, Math.floor(positionMs)),
    seq: bump(rec.seq),
    jump: bump(rec.jump),
  } satisfies TvProgramme);
  return { ok: true };
}

export function tvResume(itemId: string): TvAction {
  const gate = mayControl(itemId);
  if (!gate.ok) return gate;
  const rec = readProgramme(itemId);
  if (rec.state !== 'paused' || !rec.source) return { ok: false, error: 'Nothing is paused.' };
  write(tvKey(itemId), { ...rec, state: 'playing', seq: bump(rec.seq), jump: bump(rec.jump) } satisfies TvProgramme);
  return { ok: true };
}

/** Jump to a position (the remote's ±10 s, or the scrubber). */
export function tvSeek(itemId: string, positionMs: number): TvAction {
  const gate = mayControl(itemId);
  if (!gate.ok) return gate;
  const rec = readProgramme(itemId);
  if (rec.state !== 'playing' && rec.state !== 'paused') return { ok: false, error: 'Nothing is playing.' };
  write(tvKey(itemId), {
    ...rec, positionMs: Math.max(0, Math.floor(positionMs)), seq: bump(rec.seq), jump: bump(rec.jump),
  } satisfies TvProgramme);
  return { ok: true };
}

/** Back to the home screen (the programme stays in history). */
export function tvStop(itemId: string): TvAction {
  const gate = mayControl(itemId);
  if (!gate.ok) return gate;
  const rec = readProgramme(itemId);
  write(tvKey(itemId), {
    ...rec, source: null, state: 'home', startAt: 0, positionMs: 0, seq: bump(rec.seq), jump: bump(rec.jump),
  } satisfies TvProgramme);
  return { ok: true };
}

// ── The body buttons: no remote needed ───────────────────────────────────────

/** POWER on the set — its own key, so a press never races the holder's
 *  heartbeat in the programme's slot (a viewer's press and the holder's beat
 *  used to meet there, and whichever won undid the other). Off keeps the
 *  programme, like a real TV; on brings it back: the holder's tick parks a
 *  programme that was playing where it was (tvSession), and a set with
 *  nothing on shows the home screen. Returns the new state of the switch. */
export function tvTogglePower(itemId: string): boolean {
  const power = readPower(itemId);
  write(powerKey(itemId), { on: !power.on, seq: bump(power.seq) } satisfies PowerRecord);
  return !power.on;
}

/** The remote's PLAY and SCHEDULE turn the set on, like a real remote. */
function switchOn(itemId: string): void {
  const power = readPower(itemId);
  if (!power.on) write(powerKey(itemId), { on: true, seq: bump(power.seq) } satisfies PowerRecord);
}

/** VOLUME on the set: its own key, so a press here never carries a stale
 *  programme over a transport write the holder made at the same moment. */
export function tvSetVolume(itemId: string, volume: number): void {
  const v = Number.isFinite(volume) ? Math.round(volume) : TV_DEFAULT.volume;
  write(volumeKey(itemId), { volume: Math.min(100, Math.max(0, v)) });
}

// ── Sync maths (pure) ────────────────────────────────────────────────────────

export interface PlaybackNow {
  state: TvState;
  /** Where every client should be right now, in ms. */
  positionMs: number;
  /** Advancing (true) or holding (false). */
  running: boolean;
  /** 'scheduled': ms until T0 (≥ 0). */
  countdownMs: number;
}

/** The sample this page anchored the holder's last position to, or null
 *  before any sample landed for the TV. */
export function readSample(itemId: string): { positionMs: number; receivedAt: number; seq: number } | null {
  const s = samples.get(itemId);
  return s ? { ...s } : null;
}

/** The most a measured round trip may lead a sample by. A bad measurement
 *  must not drag the whole room off by seconds. */
export const TV_RTT_LEAD_CAP_MS = 1_000;

/** Position implied by a sample at `now`, plus half the measured round trip
 *  when the caller knows it (the sample is a transit old when it lands). A
 *  round trip that is not a finite number adds nothing: NetworkProvider
 *  reports NaN until its first pong, and NaN here would poison every drift
 *  decision downstream. */
export function expectedPositionMs(
  sample: { positionMs: number; receivedAt: number },
  now: number,
  rttMs = 0,
): number {
  const lead = Number.isFinite(rttMs) ? Math.min(TV_RTT_LEAD_CAP_MS, Math.max(0, rttMs) / 2) : 0;
  return Math.max(0, sample.positionMs + (now - sample.receivedAt) + lead);
}

/** What the room should be showing right now. */
export function readPlayback(itemId: string, now = clock(), rttMs = 0): PlaybackNow {
  const rec = readTv(itemId); // the composed state: a set that is off is off
  if (rec.state === 'scheduled') {
    const countdownMs = Math.max(0, rec.startAt - now);
    if (countdownMs > 0) return { state: 'scheduled', positionMs: 0, running: false, countdownMs };
    // Past T0. The HOLDER's clock says go: it reads playing, and its first
    // heartbeat (the theatre's or the headless one, within 3 s) flips the
    // record, so everyone else starts on receipt of THAT write — never on
    // their own clock's reading of startAt. A viewer waits ("STARTING…").
    // Only with nobody holding the remote does a viewer free-run from the
    // UTC start, best effort, until someone picks the remote up and beats.
    if (iHoldRemote(itemId) || remoteLapsed(itemId, now)) {
      return { state: 'playing', positionMs: now - rec.startAt, running: true, countdownMs: 0 };
    }
    return { state: 'scheduled', positionMs: 0, running: false, countdownMs: 0 };
  }
  if (rec.state === 'playing') {
    const sample = samples.get(itemId);
    const positionMs = sample ? expectedPositionMs(sample, now, rttMs) : rec.positionMs;
    return { state: 'playing', positionMs, running: true, countdownMs: 0 };
  }
  if (rec.state === 'paused') return { state: 'paused', positionMs: rec.positionMs, running: false, countdownMs: 0 };
  return { state: rec.state, positionMs: 0, running: false, countdownMs: 0 };
}

export type DriftAction = 'none' | 'seek' | 'speed-up' | 'slow-down';

/** What a viewer's player should do about being `actualMs` when the room is
 *  at `expectedMs`. Players with coarse rate steps (YouTube) pass
 *  canNudge=false and only ever seek, with the dead band keeping us from
 *  fighting their buffering. */
export function driftAction(actualMs: number, expectedMs: number, canNudge: boolean): DriftAction {
  const drift = actualMs - expectedMs;
  // A position we cannot read is not a reason to touch the player.
  if (!Number.isFinite(drift)) return 'none';
  if (Math.abs(drift) > TV_SEEK_OVER_MS) return 'seek';
  if (!canNudge || Math.abs(drift) <= TV_NUDGE_OVER_MS) return 'none';
  return drift > 0 ? 'slow-down' : 'speed-up';
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** The countdown line: STARTS IN m:ss, then STARTING… while the holder's
 *  first heartbeat is on its way (readPlayback past T0). */
export function countdownText(countdownMs: number): string {
  return countdownMs > 0 ? `STARTS IN ${formatClock(countdownMs)}` : 'STARTING…';
}

/** A source the TV can only start, never drive: archive.org's own player
 *  (an archive item with no chosen file). No pause, no seek, no clock. */
export function isStartOnly(s: TvSource): boolean {
  return s.kind === 'archive' && !s.file;
}

// ── Sources: parsing and labels ──────────────────────────────────────────────

/** Stable identity of a source, for history dedupe. */
export function sourceId(s: TvSource): string {
  if (s.kind === 'youtube') return `youtube:${s.videoId}`;
  if (s.kind === 'archive') return `archive:${s.identifier}/${s.file}`;
  return `url:${s.url}`;
}

export function sourceLabel(s: TvSource): string {
  if (s.title) return s.title;
  if (s.kind === 'youtube') return `YouTube · ${s.videoId}`;
  if (s.kind === 'archive') return `archive.org · ${s.identifier}`;
  try {
    const u = new URL(s.url);
    const tail = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
    return `${u.hostname} · ${decodeURIComponent(tail)}`.slice(0, TV_MAX_TITLE);
  } catch {
    return s.url.slice(0, TV_MAX_TITLE);
  }
}

/** The lane badge the plan's §3.3 puts on every tile. */
export type TvLane = 'SOVEREIGN' | 'PLAYER-RUN' | 'PUBLIC SWARM' | 'CONVENIENCE';
export function sourceLane(s: TvSource): TvLane {
  // v1's three sources are all convenience lanes; the blob, torrent and
  // karaoke kinds that arrive with the node lanes are the sovereign ones.
  return s.kind === 'url' && isLoopback(s.url) ? 'SOVEREIGN' : 'CONVENIENCE';
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * What the remote's paste box accepts: a YouTube watch / short / embed link
 * or a bare 11-character id, an archive.org details / download / embed link,
 * or any http(s) URL (played as a file). Returns null for anything else.
 */
export function parseTvSource(text: string): TvSource | null {
  const t = text.trim();
  if (!t) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return { kind: 'youtube', videoId: t };
  let u: URL;
  try {
    // A bare host gets https://; anything with a scheme of its own keeps it
    // (and a scheme that is not http(s) is refused below, not rewritten).
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id = '';
    if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? '';
    else if (u.pathname === '/watch') id = u.searchParams.get('v') ?? '';
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      id = m?.[1] ?? '';
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? { kind: 'youtube', videoId: id } : null;
  }
  if (host === 'archive.org') {
    const m = u.pathname.match(/^\/(details|download|embed)\/([A-Za-z0-9._-]+)(?:\/(.+))?/);
    if (!m) return null;
    const identifier = m[2];
    let file = '';
    if (m[1] === 'download' && m[3]) {
      try {
        file = decodeURIComponent(m[3]).replace(/\/+$/, '');
      } catch {
        return null; // "%ZZ": not a link the TV can play, said the normal way
      }
    }
    return sanitizeSource({ kind: 'archive', identifier, file });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return sanitizeSource({ kind: 'url', url: u.href });
}

/** A playable file URL for a source, or null (YouTube is an iframe; an
 *  archive item with no chosen file is their embed). */
export function sourceFileUrl(s: TvSource): string | null {
  if (s.kind === 'url') return s.url;
  if (s.kind === 'archive' && s.file) {
    return `https://archive.org/download/${encodeURIComponent(s.identifier)}/${s.file.split('/').map(encodeURIComponent).join('/')}`;
  }
  return null;
}

// ── The in-world screen's view (pure; World draws it) ────────────────────────

export interface TvScreenView {
  state: TvState;
  /** Big line: the programme's title, or the home screen's heading. */
  title: string;
  /** Small line under it: who holds the remote, the countdown, the clock. */
  detail: string;
  /** 0–1 progress when known (a duration is a player fact, so usually 0). */
  lane: TvLane | '';
  clockText: string;
}

/** Derive what the in-world screen shows from the records alone, so every
 *  client's prop agrees and the drawing code has nothing to decide. */
export function tvScreenView(itemId: string, now = clock()): TvScreenView {
  const rec = readTv(itemId);
  const remote = readRemote(itemId);
  const holderLine = remote.holder && !remoteLapsed(itemId, now)
    ? `REMOTE · ${remote.name || 'a clone'}`
    : 'REMOTE ON THE SET';
  if (rec.state === 'off') return { state: 'off', title: '', detail: '', lane: '', clockText: '' };
  if (rec.state === 'home' || !rec.source) {
    return { state: 'home', title: 'FURLONG TV', detail: holderLine, lane: '', clockText: '' };
  }
  const label = sourceLabel(rec.source).toUpperCase();
  const lane = sourceLane(rec.source);
  const pb = readPlayback(itemId, now);
  if (pb.state === 'scheduled') {
    return { state: 'scheduled', title: label, detail: countdownText(pb.countdownMs), lane, clockText: '' };
  }
  if (pb.state === 'paused') {
    return { state: 'paused', title: label, detail: `PAUSED · ${holderLine}`, lane, clockText: formatClock(pb.positionMs) };
  }
  return { state: 'playing', title: label, detail: holderLine, lane, clockText: formatClock(pb.positionMs) };
}
