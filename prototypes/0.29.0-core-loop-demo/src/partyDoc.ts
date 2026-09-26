/**
 * 🎂 `party` map binding — the birthday role and per-prop party state
 *
 * A party room is a room with a MOMENT in it: the cake is cut once, the gifts
 * are opened once, and one specific clone is the guest of honour. None of that
 * is furniture LAYOUT (furnitureDoc's job) — it is per-instance STATE that has
 * to look the same on every screen, so it lives in its own room-doc map beside
 * `casino` and follows that module's shape exactly.
 *
 * Key layout (plain JSON values, whole-value transacted writes, LWW):
 *   birthday            → string   the guest of honour's identity pubkey
 *                                  (base64url, keypair.ts). '' ⇒ nobody yet.
 *   cake:<itemId>       → CakeState    { lit, candles }
 *   gift:<itemId>       → GiftState    { opened, byName }
 *   speaker:<itemId>    → SpeakerState { on }
 *
 * WHY A PUBKEY AND NOT A PLAYER ID: player ids are per-session, so a birthday
 * person who reloads would lose the role mid-party. Identity keys survive
 * leave/rejoin and already gate door grants and venture shares — the role is
 * the same kind of thing, keyed the same way.
 *
 * ENFORCEMENT POSTURE (dev phase, the doorPolicy.ts rule): only the birthday
 * person may blow the candles, and `blowCandles` refuses for anyone else — but
 * this is a CRDT with no server, so a peer running edited code could write the
 * key anyway. Every READ therefore shape-checks (readCake / readGift), and the
 * role itself is owner-written. Signed party records would be the real fix and
 * are deliberately not in v1; nothing here is worth forging.
 *
 * REBIND PER JOIN (T0 seam): main.ts joinRoomAtEpoch calls bindPartyDoc beside
 * bindCasinoDoc. The offline fallback mirrors casinoDoc — a page-local doc
 * binds lazily so a solo room still works, and a later real join rebinds.
 */

import * as Y from 'yjs';

/** 🎂 The cake's two phases. `lit` false ⇒ the cake is a slice dispenser. */
export interface CakeState {
  lit: boolean;
  candles: number;
}

/** 🎁 One gift box. `byName` is a display copy for the "opened by" line.
 *  `wish` is the line written on the tag (owner request 2026-09-26): anyone
 *  may leave one on a box that has none; the writer (by pub) or the room
 *  owner may change it; it is read when the box is opened. */
export interface GiftState {
  opened: boolean;
  byName: string;
  wish: string;
  wishBy: string;
  wishByName: string;
}
export const MAX_WISH = 120;

/** 🔊 The speaker drives the dance floor's pulse, and plays one of the
 *  bundled recordings (partyAudio.ts TRACKS) — `track` is that track's id. */
export interface SpeakerState {
  on: boolean;
  track: string;
}

export const DEFAULT_CANDLES = 5;
const MAX_CANDLES = 12;

const CAKE_DEFAULT: CakeState = { lit: true, candles: DEFAULT_CANDLES };
const GIFT_DEFAULT: GiftState = { opened: false, byName: '', wish: '', wishBy: '', wishByName: '' };
export const DEFAULT_TRACK = 'sung';
const SPEAKER_DEFAULT: SpeakerState = { on: true, track: DEFAULT_TRACK };

let boundDoc: Y.Doc | null = null;
let partyMap: Y.Map<unknown> | null = null;
let bindingEpoch = 0;
const listeners = new Set<() => void>();
const keyListeners = new Map<string, Set<() => void>>();

function notify(changedKeys?: Set<string>): void {
  // Listener isolation, the casinoDoc rule: a throwing repaint must not
  // propagate out of the observer or starve the listeners queued behind it.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[party] listener threw during doc notify:', err);
    }
  }
  for (const [key, keyed] of keyListeners) {
    if (changedKeys && !changedKeys.has(key)) continue;
    for (const listener of [...keyed]) {
      try {
        listener();
      } catch (err) {
        console.error(`[party] listener for '${key}' threw during doc notify:`, err);
      }
    }
  }
}

function docAlive(): boolean {
  return boundDoc !== null
    && (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true;
}

export function bindPartyDoc(doc: Y.Doc): void {
  bindingEpoch += 1;
  boundDoc = doc;
  partyMap = doc.getMap('party');
  partyMap.observe((event) => notify(event.keysChanged));
  notify(); // repaint subscribers from the fresh doc
}

export function partyDocEpoch(): number {
  return bindingEpoch;
}

/** Bound map, lazily falling back to a page-local doc (offline solo room). */
function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !partyMap) bindPartyDoc(new Y.Doc());
  return partyMap!;
}

export function subscribeParty(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to ONE party key — a cake repaint should not fire for every gift. */
export function subscribePartyKey(key: string, listener: () => void): () => void {
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

// ── 🎉 The birthday role ─────────────────────────────────────────────────────

export function birthdayKey(): string {
  return 'birthday';
}

/** The guest of honour's identity pubkey, '' when the host has not named one. */
export function readBirthdayPub(): string {
  const v = ensureMap().get('birthday');
  return typeof v === 'string' ? v : '';
}

/** Name the guest of honour. Owner-gated at the CALL SITE (the room-owner
 *  check every other write in this codebase uses); '' clears the role. */
export function setBirthdayPub(pub: string): void {
  write('birthday', typeof pub === 'string' ? pub : '');
}

export function isBirthdayPerson(pub: string): boolean {
  const birthday = readBirthdayPub();
  return birthday !== '' && birthday === pub;
}

// ── 🎂 The cake ──────────────────────────────────────────────────────────────

export function cakeKey(itemId: string): string {
  return `cake:${itemId}`;
}

/** Shape-checked read — a peer could have written anything into the map. */
export function readCake(itemId: string): CakeState {
  const raw = ensureMap().get(cakeKey(itemId)) as Partial<CakeState> | undefined;
  if (!raw || typeof raw !== 'object') return { ...CAKE_DEFAULT };
  const candles = Number.isInteger(raw.candles)
    ? Math.min(MAX_CANDLES, Math.max(0, raw.candles as number))
    : DEFAULT_CANDLES;
  return { lit: raw.lit !== false, candles };
}

export type PartyAction = { ok: true } | { ok: false; error: string };

/**
 * 🎂 THE MOMENT. Only the birthday person may blow the candles out; everyone
 * else gets a sentence naming whose job it is, because a click that does
 * nothing reads as broken while a click that answers reads as a rule.
 *
 * `honoureeName` is only for that refusal line — the gate itself is the key.
 */
export function blowCandles(
  itemId: string,
  myPub: string,
  honoureeName: string,
): PartyAction {
  const birthday = readBirthdayPub();
  if (birthday === '') {
    return { ok: false, error: 'No guest of honour yet — the host names one from CONTACTS.' };
  }
  if (birthday !== myPub) {
    const who = honoureeName.trim() || 'the guest of honour';
    return { ok: false, error: `Waiting for ${who} to blow out the candles!` };
  }
  const cake = readCake(itemId);
  if (!cake.lit) return { ok: false, error: 'The candles are already out.' };
  write(cakeKey(itemId), { lit: false, candles: cake.candles } satisfies CakeState);
  return { ok: true };
}

/** Re-light for the next party — the host's reset (owner-gated at the call site). */
export function relightCandles(itemId: string, candles = DEFAULT_CANDLES): void {
  write(cakeKey(itemId), {
    lit: true,
    candles: Math.min(MAX_CANDLES, Math.max(0, Math.floor(candles))),
  } satisfies CakeState);
}

// ── 🎁 Gifts ─────────────────────────────────────────────────────────────────

export function giftKey(itemId: string): string {
  return `gift:${itemId}`;
}

export function readGift(itemId: string): GiftState {
  const raw = ensureMap().get(giftKey(itemId)) as Partial<GiftState> | undefined;
  if (!raw || typeof raw !== 'object') return { ...GIFT_DEFAULT };
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    opened: raw.opened === true,
    byName: str(raw.byName, 32),
    wish: str(raw.wish, MAX_WISH),
    wishBy: str(raw.wishBy, 128),
    wishByName: str(raw.wishByName, 32),
  };
}

/** Anyone may open a gift — it is the small, ungated echo of the cake moment.
 *  The wish on the tag survives the opening: that is when it gets read. */
export function openGift(itemId: string, myName: string): PartyAction {
  const cur = readGift(itemId);
  if (cur.opened) return { ok: false, error: 'Already opened.' };
  write(giftKey(itemId), {
    ...cur,
    opened: true,
    byName: (myName || 'A clone').slice(0, 32),
  } satisfies GiftState);
  return { ok: true };
}

/** Wrap it again (owner): closed, nobody's — the wish stays on the tag. */
export function closeGift(itemId: string): void {
  const cur = readGift(itemId);
  write(giftKey(itemId), { ...GIFT_DEFAULT, wish: cur.wish, wishBy: cur.wishBy, wishByName: cur.wishByName });
}

/**
 * 💌 Write the wish on a gift's tag. A box with no wish takes anyone's; a
 * box that has one is changed only by its writer or the room owner (the
 * host may tidy a tag, a guest may not overwrite another guest's). An empty
 * text, by someone allowed, takes the wish off. Gated HERE, not only in the
 * panel, so an edited client cannot scribble over the others' tags.
 */
export function writeGiftWish(
  itemId: string,
  text: string,
  myPub: string,
  myName: string,
  isOwner: boolean,
): PartyAction {
  const cur = readGift(itemId);
  const wish = text.replace(/\s+/g, ' ').trim().slice(0, MAX_WISH);
  if (cur.wish && cur.wishBy !== myPub && !isOwner) {
    return { ok: false, error: `${cur.wishByName || 'Someone'} already wrote on this one.` };
  }
  if (!wish && !cur.wish) return { ok: false, error: 'Write a few words first.' };
  write(giftKey(itemId), {
    ...cur,
    wish,
    wishBy: wish ? myPub : '',
    wishByName: wish ? (myName || 'A clone').slice(0, 32) : '',
  } satisfies GiftState);
  return { ok: true };
}

// ── 🔊 The speaker ───────────────────────────────────────────────────────────

export function speakerKey(itemId: string): string {
  return `speaker:${itemId}`;
}

export function readSpeaker(itemId: string): SpeakerState {
  const raw = ensureMap().get(speakerKey(itemId)) as Partial<SpeakerState> | undefined;
  if (!raw || typeof raw !== 'object') return { ...SPEAKER_DEFAULT };
  return { on: raw.on !== false, track: typeof raw.track === 'string' && raw.track ? raw.track : DEFAULT_TRACK };
}

/** Anyone may kill the music. Parties are like that. */
export function toggleSpeaker(itemId: string): boolean {
  const cur = readSpeaker(itemId);
  write(speakerKey(itemId), { on: !cur.on, track: cur.track } satisfies SpeakerState);
  return !cur.on;
}

/** 🎵 Pick the recording the speaker plays — shared, like the switch. */
export function setSpeakerTrack(itemId: string, track: string): void {
  const cur = readSpeaker(itemId);
  write(speakerKey(itemId), { on: cur.on, track } satisfies SpeakerState);
}
