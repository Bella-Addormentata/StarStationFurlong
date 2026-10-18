import type { ContactCard, RoomMemberHint } from './protocol.ts';

/**
 * The `cap` envelope payload the browser hands its LOCAL node over loopback
 * (ChiaHub Slice 3; #231 N8 + D3). The node needs the room key to derive the
 * room's chain lookup hint and to seal presence records; the two flags say what
 * it may do with it.
 *
 *  - `chiaMode`   the per-room "publish my presence here" toggle. Publishing
 *                 only; the node reads the chain for every room regardless (D3).
 *  - `publicRoom` N8: this room is PUBLIC SPACE — its seed ships inside every
 *                 build (the welcome room) or its passage policy lets anyone walk
 *                 in, so anyone can derive its hint. The node never publishes an
 *                 address under such a key, armed or not, and never reads under
 *                 it either (D6). The node also recognises the bundled key on its
 *                 own (`chia_rooms.rs`), so this flag is belt, that is braces.
 *                 `null`: not known YET — the first cap of a join goes out before
 *                 the room's door documents are bound (#272 review round 3); the
 *                 node then publishes nothing under the key, as for PUBLIC, but
 *                 may use the cards a private pass brought (`passPrivate`).
 */
export interface RoomCapPayload {
  roomKeyB64: string;
  chiaMode: boolean;
  publicRoom: boolean | null;
  /** Monotonic within a browser session (the ms clock, bumped past the last
   *  one sent). Every cap rides its own stream and streams may land out of
   *  order, so the node keeps the highest `seq` it has seen per room and drops
   *  anything older; a stale PRIVATE can then never overwrite a fresh PUBLIC. */
  seq: number;
  /** #231 P6b: the per-room "share my card in this room" toggle (default on).
   *  Off, the node hands no card to the room's members, files none of theirs
   *  and reads no inbox for the room. */
  shareCard: boolean;
  /** #231 P6b: the node-signed contact cards this room's pass carries for its
   *  members, so the node can find and knock on them by key before it meets
   *  them. Never sent for a public room (N8 extends to `ck`); the node verifies
   *  every card and files them only where the room's posture allows cards. */
  memberCards?: ContactCard[];
  /** #231 P6b (#272 review round 3): this session joined by a pass that
   *  carried member cards. A pass to a public room carries none (its minter
   *  strips them), so while the posture is not yet known the node may USE the
   *  pass's cards — file them, knock on the host — though it hands out none of
   *  its own until the room is known private. Sent only with `memberCards`. */
  passPrivate?: boolean;
  /** #272 review round 9: sent by a background PASS PREFETCH (the room list
   *  warming a room the player holds a pass to, roomPasses.ts), not by the
   *  primary session. The prefetch cannot read the room's posture, so the cap
   *  says unknown and arms nothing: the node may use the pass's cards — file
   *  them, knock on the host when every live route fails, which is what makes
   *  an unreachable room's prefetch ready at all — and knows the room's key
   *  (the bundled one, for the welcome room's beacon fall-through); it
   *  publishes nothing and hands out no card of ours. The node never lets it
   *  replace a cap the primary session sent. */
  prefetch?: boolean;
}

/** Cards one cap carries at most (a room's roster, not an address book). */
export const MAX_CAP_MEMBER_CARDS = 64;

export function buildRoomCapPayload(
  roomKeyB64: string,
  chiaMode: boolean,
  publicRoom: boolean | null | undefined,
  seq: number,
  shareCard: boolean = true,
  memberCards: readonly ContactCard[] = [],
  prefetch: boolean = false,
): RoomCapPayload {
  const payload: RoomCapPayload = {
    roomKeyB64,
    chiaMode: !prefetch && !!chiaMode,
    publicRoom: prefetch || publicRoom === undefined || publicRoom === null ? null : !!publicRoom,
    seq: Math.max(0, Math.floor(seq)) || 0,
    shareCard: shareCard !== false,
  };
  if (prefetch) payload.prefetch = true;
  if (payload.publicRoom !== true && memberCards.length > 0) {
    payload.memberCards = memberCards.slice(0, MAX_CAP_MEMBER_CARDS);
    payload.passPrivate = true;
  }
  return payload;
}

/** A contact card as it may arrive from a pass or from the node: every field
 *  present with its type, the timestamp one the node can read, nothing more
 *  trusted than that (the node verifies the signature). `null` for anything
 *  else. */
export function normalizeContactCard(value: unknown): ContactCard | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.nodeId !== 'string' || c.nodeId.length === 0) return null;
  if (typeof c.ck !== 'string' || c.ck.length === 0) return null;
  if (typeof c.kxPk !== 'string' || c.kxPk.length === 0) return null;
  if (typeof c.sig !== 'string' || c.sig.length === 0) return null;
  // A timestamp the node reads as a u64: a safe integer. A card saying `1e100`
  // (or anything past 2^53) is left out HERE, since the node refuses a cap it
  // cannot read whole — the room's key and posture, and a later Share Card
  // OFF, with it (#272 review round 13). A fraction is floored, as before.
  const issuedAt = typeof c.issuedAt === 'number' ? Math.floor(c.issuedAt) : Number.NaN;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  return { nodeId: c.nodeId, ck: c.ck, kxPk: c.kxPk, issuedAt, sig: c.sig };
}

/** Of two cards for one node, the one issued later (a rotated key wins). */
export function newerCard(a: ContactCard | undefined, b: ContactCard | undefined): ContactCard | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.issuedAt > a.issuedAt ? b : a;
}

/** The cards a room's member hints carry, one per node, for the cap. */
export function memberCardsOf(hints: readonly { irohNodeId: string; nodeCard?: ContactCard }[] | undefined): ContactCard[] {
  const out: ContactCard[] = [];
  const seen = new Set<string>();
  for (const h of hints ?? []) {
    const card = normalizeContactCard(h.nodeCard);
    if (!card || card.nodeId !== h.irohNodeId || seen.has(card.nodeId)) continue;
    seen.add(card.nodeId);
    out.push(card);
  }
  return out;
}

/** The switches flipped THIS session that the browser REFUSED to store, per
 *  room, consulted before storage (#272 review round 6): a browser that refuses
 *  the write (privacy mode, a full quota) must not leave the panel saying OFF
 *  while the cap, the pass builders and the node keep reading the stored ON.
 *  The choice is recorded here first and persisted on top; once stored, the
 *  copy here goes (round 7): storage is the one word every tab of this
 *  station reads, and a copy kept would hide a later OFF another tab stored. */
const sessionFlags = new Map<string, boolean>();

function readFlag(key: string, fromStored: (stored: string | null) => boolean): boolean {
  const live = sessionFlags.get(key);
  if (live !== undefined) return live;
  try {
    return fromStored(localStorage.getItem(key));
  } catch {
    return fromStored(null);
  }
}

function writeFlag(key: string, on: boolean): void {
  sessionFlags.set(key, on);
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    return; /* privacy mode: the choice holds for this session all the same */
  }
  sessionFlags.delete(key); // stored: every tab reads it from there now
}

/** Tests: forget this session's choices. */
export function forgetSessionFlags(): void {
  sessionFlags.clear();
}

const shareCardKey = (roomId: string) => `ssf-chia-share-card-${roomId}`;
const chiaModeKey = (roomId: string) => `ssf-chia-mode-${roomId}`;

/** The per-room "share my card" flag (`ssf-chia-share-card-<roomId>`): on
 *  unless the player turned it off — this session (`setShareCard`) or in a
 *  stored one; tolerant of privacy mode. */
export function readShareCard(roomId: string): boolean {
  return readFlag(shareCardKey(roomId), (stored) => stored !== '0');
}

/** The Share Card switch's word for `roomId`, effective at once for every
 *  reader, persisted when the browser allows. */
export function setShareCard(roomId: string, on: boolean): void {
  writeFlag(shareCardKey(roomId), on);
}

/** #231 P6b: a member hint as a ROUTE alone — node id, relays, direct
 *  addresses — and no contact card. What leaves the room-gated pass builders
 *  (the personal contact card a player hands a friend, and through it the
 *  friend-of-friend introductions it consents to) carries no card: a card is
 *  handed out in a private room's pass, by the room's and the node's switches,
 *  and nowhere else (#272 review round 7). */
export function routeHint(hint: RoomMemberHint): RoomMemberHint {
  const { nodeCard: _card, ...route } = hint;
  return route;
}

/** #231 P6b: the hints a PASS carries, card-wise. A pass to a PUBLIC room
 *  carries no card at all (N8 extends to `ck`). A pass to a private room
 *  carries every card known — except this station's own while the room's
 *  "Share Card" switch is off (#272 review): the switch is per room, the
 *  cached card is not, so a card received in another room, or before the
 *  switch went off, must not ride out of this one. Other members' cards stay:
 *  each came in with this room's pass, where its owner's own switch put it. */
export function cardsForPass(
  hints: readonly RoomMemberHint[],
  publicRoom: boolean,
  shareOwnCard: boolean,
  selfNodeId: string | null | undefined,
): RoomMemberHint[] {
  return hints.map((hint) => {
    if (!hint.nodeCard) return hint;
    if (publicRoom || (!shareOwnCard && hint.irohNodeId === selfNodeId)) {
      const { nodeCard: _card, ...rest } = hint;
      return rest;
    }
    return hint;
  });
}

/** JSON for `btoa`: every character beyond Latin-1 spelled as the `\\uXXXX`
 *  escape JSON allows, since `JSON.stringify` writes such characters as they
 *  are and `btoa` takes Latin-1 alone (#272 review round 13). Reads back the
 *  same; a surrogate pair becomes two escapes, as JSON spells one. */
export function latin1Json(value: unknown): string {
  return JSON.stringify(value).replace(/[^\u0000-\u00ff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** #231 P6b: a pass seed with every node card struck from its member hints —
 *  what may leave for a PUBLIC audience (#272 review round 11). A seed is the
 *  base64 JSON of a `RoomBootstrap`, bare or in a pass URL's `?seed=` param;
 *  one minted while the room was private carries the members' cards, and the
 *  station atlas publishes the room's stored seed into the room doc once its
 *  passage is public, so a public visitor would have read every member's
 *  contact key out of the older pass. The route stays (node ids, relays,
 *  direct addresses); only the cards go. A seed with no card, or one that is
 *  not such JSON (a bundled station's URL, a bare room fragment), is returned
 *  as it is. A seed whose JSON spells a character beyond Latin-1 is re-encoded
 *  the same way (`latin1Json`, round 13), never handed back with its cards. */
export function seedWithoutCards(seed: string): string {
  const strip = (b64: string): string | null => {
    let boot: unknown;
    try {
      boot = JSON.parse(atob(b64));
    } catch {
      return null;
    }
    if (!boot || typeof boot !== 'object') return null;
    const hints = (boot as { memberHints?: unknown }).memberHints;
    if (!Array.isArray(hints) || !hints.some((h) => !!h && typeof h === 'object' && 'nodeCard' in (h as object))) return null;
    const routes = hints.map((h) => {
      if (!h || typeof h !== 'object') return h;
      const { nodeCard: _card, ...route } = h as { nodeCard?: unknown };
      return route;
    });
    return btoa(latin1Json({ ...(boot as object), memberHints: routes }));
  };
  // A pass URL carries the seed in its `seed` param. Only the URL parse is
  // guarded: a seed that fails to strip is never returned with its cards.
  let url: URL | null = null;
  try {
    url = new URL(seed);
  } catch {
    url = null; // not a URL: a bare seed
  }
  const q = url?.searchParams.get('seed');
  if (url && q) {
    const stripped = strip(q);
    if (stripped === null) return seed;
    url.searchParams.set('seed', stripped);
    return url.toString();
  }
  return strip(seed) ?? seed;
}

/** Where the LOCAL node's own card is kept once it arrives over the `card`
 *  lane, so passes minted later can carry it. */
export const NODE_CARD_KEY = 'ssf-node-card';

export function readNodeCard(): ContactCard | null {
  try {
    const raw = localStorage.getItem(NODE_CARD_KEY);
    return raw ? normalizeContactCard(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeNodeCard(card: ContactCard): void {
  try {
    localStorage.setItem(NODE_CARD_KEY, JSON.stringify(card));
  } catch {
    /* privacy mode: the card still serves this session from memory */
  }
}

/** The next cap's `seq`: the clock, but never at or below the last one sent,
 *  so two caps in the same millisecond still order. */
export function nextCapSeq(last: number, nowMs: number = Date.now()): number {
  return Math.max(nowMs, last + 1);
}

/** N8's two reasons a room is public space, in one predicate. `bundled` is
 *  "this is the room whose pass ships in the build"; `passagePublic` is the
 *  door-policy reading main.ts already uses to decide whether a room's seed may
 *  ride in the shared atlas. Unknown (undefined) passage counts as PUBLIC: fail
 *  closed — a key is only ever published under once the doc has said it is
 *  private, and a pass minted before then carries no card. */
export function roomIsPublicSpace(bundled: boolean, passagePublic: boolean | undefined): boolean {
  return bundled || passagePublic !== false;
}

/** The posture the CAP carries (#272 review round 3): `true` public, `false`
 *  private, `undefined` not known yet — the bundled room is public whatever its
 *  doors say, any other room's posture is its doors', and until they are bound
 *  there is none. Unlike `roomIsPublicSpace`, which decides what a pass minted
 *  now may carry (nothing, until known), the cap says "unknown" so the node can
 *  tell "not yet" from "public" and let a private pass's cards work before the
 *  door documents have synced; publishing fails closed either way. */
export function roomPosture(bundled: boolean, passagePublic: boolean | undefined): boolean | undefined {
  return bundled ? true : passagePublic;
}

/** What the cap's probe, and the pass minter, read a room's passage from
 *  (#272 review round 4). The door documents are bound per join and, on a
 *  first visit with nothing cached, EMPTY until the room's state arrives — and
 *  empty door documents read as the four cardinal defaults, which are PUBLIC.
 *  So the passage is read only once the documents bound are this room's AND
 *  the room's state is usable: arrived from its host (or from the local node,
 *  for a room hosted here), or seeded from a replica this install kept. Until
 *  then the passage is not known: the cap says so (`roomPosture` → null) and a
 *  private pass's cards stay usable, instead of a public reading nothing backs
 *  overwriting them. main.ts wires the sources. */
export interface PostureSources {
  /** Is `roomId` the room whose pass ships in the build? */
  bundled: (roomId: string) => boolean;
  /** The room whose door documents are the ones bound, or null between a
   *  leave and the next join's binds. */
  docsBoundFor: () => string | null;
  /** Is the bound room's state usable: synced from its host, or seeded from a
   *  cached or warm replica? */
  stateUsable: () => boolean;
  /** The bound door documents' reading: does some door let anyone walk in? */
  passagePublic: () => boolean;
}

/** `roomId`'s passage as the sources allow it to be read: `undefined` until
 *  its own documents are bound and its state is usable. */
export function passageReading(src: PostureSources, roomId: string): boolean | undefined {
  return src.docsBoundFor() === roomId && src.stateUsable() ? src.passagePublic() : undefined;
}

/** The cap's posture probe over `src` — see `roomPosture`. */
export function roomPostureProbe(src: PostureSources): (roomId: string) => boolean | undefined {
  return (roomId) => roomPosture(src.bundled(roomId), passageReading(src, roomId));
}

/** #231 P6b (#272 review round 3): does the local node hand out its contact
 *  card at all? Its fingerprint says (`share_card`); a node that predates the
 *  flag never handed one out, so absent reads as sharing. Off, this station's
 *  cached card rides in no pass, whatever a room's own switch says. */
export function nodeSharesCard(fp: { share_card?: boolean } | null | undefined): boolean {
  return fp?.share_card !== false;
}

/** The per-room chia-mode flag (`ssf-chia-mode-<roomId>`): this session's
 *  word (`setChiaMode`) before the stored one; tolerant of privacy mode where
 *  localStorage throws. */
export function readChiaMode(roomId: string): boolean {
  return readFlag(chiaModeKey(roomId), (stored) => stored === '1');
}

/** The Chia Mesh switch's word for `roomId`, effective at once for every
 *  reader, persisted when the browser allows. */
export function setChiaMode(roomId: string, on: boolean): void {
  writeFlag(chiaModeKey(roomId), on);
}
