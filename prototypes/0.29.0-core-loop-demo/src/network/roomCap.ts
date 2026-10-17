import type { ContactCard } from './protocol.ts';

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
 */
export interface RoomCapPayload {
  roomKeyB64: string;
  chiaMode: boolean;
  publicRoom: boolean;
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
}

/** Cards one cap carries at most (a room's roster, not an address book). */
export const MAX_CAP_MEMBER_CARDS = 64;

export function buildRoomCapPayload(
  roomKeyB64: string,
  chiaMode: boolean,
  publicRoom: boolean,
  seq: number,
  shareCard: boolean = true,
  memberCards: readonly ContactCard[] = [],
): RoomCapPayload {
  const payload: RoomCapPayload = {
    roomKeyB64,
    chiaMode: !!chiaMode,
    publicRoom: !!publicRoom,
    seq: Math.max(0, Math.floor(seq)) || 0,
    shareCard: shareCard !== false,
  };
  if (!payload.publicRoom && memberCards.length > 0) {
    payload.memberCards = memberCards.slice(0, MAX_CAP_MEMBER_CARDS);
  }
  return payload;
}

/** A contact card as it may arrive from a pass or from the node: every field
 *  present with its type, nothing more trusted than that (the node verifies the
 *  signature). `null` for anything else. */
export function normalizeContactCard(value: unknown): ContactCard | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.nodeId !== 'string' || c.nodeId.length === 0) return null;
  if (typeof c.ck !== 'string' || c.ck.length === 0) return null;
  if (typeof c.kxPk !== 'string' || c.kxPk.length === 0) return null;
  if (typeof c.sig !== 'string' || c.sig.length === 0) return null;
  if (typeof c.issuedAt !== 'number' || !Number.isFinite(c.issuedAt) || c.issuedAt < 0) return null;
  return { nodeId: c.nodeId, ck: c.ck, kxPk: c.kxPk, issuedAt: Math.floor(c.issuedAt), sig: c.sig };
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

/** The per-room "share my card" flag (`ssf-chia-share-card-<roomId>`): on
 *  unless the player turned it off; tolerant of privacy mode. */
export function readShareCard(roomId: string): boolean {
  try {
    return localStorage.getItem(`ssf-chia-share-card-${roomId}`) !== '0';
  } catch {
    return true;
  }
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
 *  private. */
export function roomIsPublicSpace(bundled: boolean, passagePublic: boolean | undefined): boolean {
  return bundled || passagePublic !== false;
}

/** The per-room chia-mode flag (`ssf-chia-mode-<roomId>`), tolerant of privacy
 *  mode where localStorage throws. */
export function readChiaMode(roomId: string): boolean {
  try {
    return localStorage.getItem(`ssf-chia-mode-${roomId}`) === '1';
  } catch {
    return false;
  }
}
