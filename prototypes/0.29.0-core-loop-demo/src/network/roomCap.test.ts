import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_CAP_MEMBER_CARDS,
  buildRoomCapPayload,
  cardsForPass,
  forgetSessionFlags,
  memberCardsOf,
  newerCard,
  nextCapSeq,
  nodeSharesCard,
  normalizeContactCard,
  passageReading,
  readChiaMode,
  readShareCard,
  roomIsPublicSpace,
  roomPosture,
  roomPostureProbe,
  routeHint,
  setChiaMode,
  setShareCard,
  type PostureSources,
} from './roomCap';

const card = (nodeId: string, issuedAt = 100) => ({ nodeId, ck: 'Y2s=', kxPk: 'ab', issuedAt, sig: 'ff' });

describe('room cap payload (N8 / D3)', () => {
  it('carries the key, both flags coerced to booleans, and the sequence number', () => {
    expect(buildRoomCapPayload('k', true, false, 7)).toEqual({ roomKeyB64: 'k', chiaMode: true, publicRoom: false, seq: 7, shareCard: true });
    expect(buildRoomCapPayload('k', 0 as unknown as boolean, 1 as unknown as boolean, 2.9)).toEqual({
      roomKeyB64: 'k',
      chiaMode: false,
      publicRoom: true,
      seq: 2,
      shareCard: true,
    });
    expect(buildRoomCapPayload('k', true, true, Number.NaN).seq).toBe(0);
  });

  it('P6b: carries the share toggle, and member cards only for a private room, capped', () => {
    expect(buildRoomCapPayload('k', false, false, 1, false).shareCard).toBe(false);
    expect(buildRoomCapPayload('k', false, false, 1, undefined as unknown as boolean).shareCard).toBe(true);
    const cards = [card('a'), card('b')];
    expect(buildRoomCapPayload('k', false, false, 1, true, cards).memberCards).toEqual(cards);
    expect(buildRoomCapPayload('k', false, true, 1, true, cards).memberCards).toBeUndefined();
    expect(buildRoomCapPayload('k', false, false, 1, true, []).memberCards).toBeUndefined();
    const many = Array.from({ length: MAX_CAP_MEMBER_CARDS + 5 }, (_, i) => card(`n${i}`));
    expect(buildRoomCapPayload('k', false, false, 1, true, many).memberCards).toHaveLength(MAX_CAP_MEMBER_CARDS);
  });

  it('P6b: a contact card needs every field with its type; the newer of two wins', () => {
    expect(normalizeContactCard(card('a', 5.7))).toEqual({ ...card('a', 5) });
    expect(normalizeContactCard({ ...card('a'), ck: '' })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), issuedAt: '100' })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), issuedAt: -1 })).toBeNull();
    expect(normalizeContactCard({ ...card('a'), sig: undefined })).toBeNull();
    expect(normalizeContactCard(null)).toBeNull();
    expect(normalizeContactCard('card')).toBeNull();
    expect(newerCard(card('a', 1), card('a', 2))).toEqual(card('a', 2));
    expect(newerCard(card('a', 3), card('a', 2))).toEqual(card('a', 3));
    expect(newerCard(undefined, card('a'))).toEqual(card('a'));
    expect(newerCard(card('a'), undefined)).toEqual(card('a'));
  });

  it('P6b: the cap takes each hint\'s card once, only when it names the hint\'s node', () => {
    const hints = [
      { irohNodeId: 'a', nodeCard: card('a') },
      { irohNodeId: 'b' },
      { irohNodeId: 'c', nodeCard: card('x') },
      { irohNodeId: 'a', nodeCard: card('a', 200) },
      { irohNodeId: 'd', nodeCard: { nodeId: 'd' } as never },
    ];
    expect(memberCardsOf(hints)).toEqual([card('a')]);
    expect(memberCardsOf(undefined)).toEqual([]);
  });

  it('P6b: a pass carries no card in a public room, and not ours while Share Card is off', () => {
    const hints = [
      { irohNodeId: 'me', nodeCard: card('me') },
      { irohNodeId: 'them', nodeCard: card('them') },
      { irohNodeId: 'bare' },
    ];
    expect(cardsForPass(hints, true, true, 'me').map((h) => h.nodeCard)).toEqual([undefined, undefined, undefined]);
    expect(cardsForPass(hints, false, true, 'me')).toEqual(hints);
    // The switch is off for this room: our own card stays home, the others
    // (shared into this room by their owners) still ride.
    const off = cardsForPass(hints, false, false, 'me');
    expect(off).toEqual([{ irohNodeId: 'me' }, { irohNodeId: 'them', nodeCard: card('them') }, { irohNodeId: 'bare' }]);
    expect(cardsForPass(hints, false, false, undefined)).toEqual(hints);
    expect(hints[0].nodeCard).toEqual(card('me'));
  });

  it('P6b: the cap says UNKNOWN (null) until the door docs are bound, and a private pass\'s cards ride with passPrivate', () => {
    // #272 review round 3: a first visit by a private pass, no room document
    // yet — the cap says "not known" rather than PUBLIC, and carries the
    // pass's cards with the pass's word, so the node can knock on the host
    // when every live route fails; the pass MINTER still treats unknown as
    // public (roomIsPublicSpace) and carries no card.
    expect(roomPosture(true, undefined)).toBe(true);
    expect(roomPosture(true, false)).toBe(true);
    expect(roomPosture(false, true)).toBe(true);
    expect(roomPosture(false, false)).toBe(false);
    expect(roomPosture(false, undefined)).toBeUndefined();
    const cards = [card('host')];
    const firstVisit = buildRoomCapPayload('k', false, undefined, 1, true, cards);
    expect(firstVisit.publicRoom).toBeNull();
    expect(firstVisit.memberCards).toEqual(cards);
    expect(firstVisit.passPrivate).toBe(true);
    expect(buildRoomCapPayload('k', false, null, 1, true, []).passPrivate).toBeUndefined();
    expect(buildRoomCapPayload('k', false, true, 1, true, cards)).toEqual({ roomKeyB64: 'k', chiaMode: false, publicRoom: true, seq: 1, shareCard: true });
    expect(buildRoomCapPayload('k', false, false, 1, true, cards).passPrivate).toBe(true);
  });

  it("P6b: a pass prefetch's cap says UNKNOWN whatever it was told, arms nothing and carries the pass's cards", () => {
    // #272 review round 9: USE PASS warms a room on a provider with no posture
    // probe; its cap must let the node use the pass's cards (knock on a host
    // every live route fails to reach) without claiming a posture, arming
    // publishing or sharing our own card.
    const cards = [card('host')];
    expect(buildRoomCapPayload('k', true, false, 3, true, cards, true)).toEqual({
      roomKeyB64: 'k', chiaMode: false, publicRoom: null, seq: 3, shareCard: true, prefetch: true, memberCards: cards, passPrivate: true,
    });
    expect(buildRoomCapPayload('k', true, true, 3, false, [], true)).toEqual({ roomKeyB64: 'k', chiaMode: false, publicRoom: null, seq: 3, shareCard: false, prefetch: true });
    expect(buildRoomCapPayload('k', true, false, 3, true, cards)).toMatchObject({ chiaMode: true, publicRoom: false });
    expect(buildRoomCapPayload('k', true, false, 3, true, cards).prefetch).toBeUndefined();
  });

  it('P6b: a first visit\'s cap says UNKNOWN until the room\'s state is usable, then what its doors say', () => {
    // #272 review round 4: the whole first-visit sequence. The door documents
    // are bound right after the sync starts, while the replica is still EMPTY
    // — and empty door documents read as the cardinal defaults, which are
    // public. Read then, the cap would say PUBLIC and the node would stop
    // using the private pass's cards before the host's state could land.
    const state = { docsBoundFor: null as string | null, stateUsable: false, passagePublic: true };
    const src: PostureSources = {
      bundled: (roomId) => roomId === 'welcome',
      docsBoundFor: () => state.docsBoundFor,
      stateUsable: () => state.stateUsable,
      passagePublic: () => state.passagePublic,
    };
    const probe = roomPostureProbe(src);
    const cards = [card('host')];
    const cap = () => buildRoomCapPayload('k', false, probe('r'), 1, true, cards);
    // 1. connect: no door documents are bound yet.
    expect(cap()).toMatchObject({ publicRoom: null, passPrivate: true, memberCards: cards });
    expect(roomIsPublicSpace(src.bundled('r'), passageReading(src, 'r'))).toBe(true); // a pass minted now carries no card
    // 2. the room's documents are bound, the replica is empty: its defaults
    //    read public, which is no reading at all.
    state.docsBoundFor = 'r';
    expect(passageReading(src, 'r')).toBeUndefined();
    expect(cap()).toMatchObject({ publicRoom: null, passPrivate: true, memberCards: cards });
    // 3. the host's state lands (or a kept replica seeded it): its doors speak.
    state.stateUsable = true;
    state.passagePublic = false;
    expect(cap()).toMatchObject({ publicRoom: false, passPrivate: true, memberCards: cards });
    expect(roomIsPublicSpace(src.bundled('r'), passageReading(src, 'r'))).toBe(false);
    state.passagePublic = true;
    expect(cap()).toEqual({ roomKeyB64: 'k', chiaMode: false, publicRoom: true, seq: 1, shareCard: true });
    // Another room's documents bound say nothing about this one; the bundled
    // room is public whatever is bound or synced.
    state.docsBoundFor = 'other';
    expect(probe('r')).toBeUndefined();
    expect(probe('welcome')).toBe(true);
  });

  it('P6b: a switch flipped while storage refuses the write still holds for the cap and the pass', () => {
    // #272 review round 6: Share Card OFF in a browser whose localStorage
    // throws on write (privacy mode, a full quota) used to update the panel
    // alone: the cap and the pass builders read storage, which still said ON.
    const kept = new Map<string, string>();
    const refusing = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k: string) => void kept.delete(k),
      clear: () => kept.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: refusing, configurable: true, writable: true });
    try {
      forgetSessionFlags();
      kept.set('ssf-chia-share-card-r', '1'); // a stored ON from an earlier session
      expect(readShareCard('r')).toBe(true);
      setShareCard('r', false);
      expect(kept.get('ssf-chia-share-card-r')).toBe('1'); // the write was refused…
      expect(readShareCard('r')).toBe(false); // …and the choice holds all the same
      // The cap the node reads, and the pass a member is handed, both see OFF.
      expect(buildRoomCapPayload('k', false, false, 1, readShareCard('r'), [card('host')]).shareCard).toBe(false);
      const hints = [{ irohNodeId: 'me', nodeCard: card('me') }, { irohNodeId: 'host', nodeCard: card('host') }];
      const pass = cardsForPass(hints, false, readShareCard('r'), 'me');
      expect(pass[0].nodeCard).toBeUndefined();
      expect(pass[1].nodeCard).toEqual(card('host'));
      setShareCard('r', true);
      expect(readShareCard('r')).toBe(true);
      // Another room is untouched; the Chia Mesh switch works the same way.
      expect(readShareCard('s')).toBe(true);
      expect(readChiaMode('r')).toBe(false);
      setChiaMode('r', true);
      expect(readChiaMode('r')).toBe(true);
      setChiaMode('r', false);
      expect(readChiaMode('r')).toBe(false);
      // A browser that allows the write persists it too.
      refusing.setItem = (k: string, v: string) => void kept.set(k, v);
      setShareCard('t', false);
      expect(kept.get('ssf-chia-share-card-t')).toBe('0');
    } finally {
      forgetSessionFlags();
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("P6b: a switch stored successfully is read back from storage, so another tab's later word is seen", () => {
    // #272 review round 7: the session copy a refused write leaves behind must
    // not outlive a write that WORKED — tab A's ON would hide the OFF tab B
    // stored afterwards, and A would hand our card out on its next pass.
    const kept = new Map<string, string>();
    const storage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
      clear: () => kept.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    try {
      forgetSessionFlags();
      setShareCard('r', true);
      expect(kept.get('ssf-chia-share-card-r')).toBe('1');
      kept.set('ssf-chia-share-card-r', '0'); // another tab turned it off
      expect(readShareCard('r')).toBe(false);
      setChiaMode('r', true);
      kept.set('ssf-chia-mode-r', '0');
      expect(readChiaMode('r')).toBe(false);
      // A refused write still holds for this tab…
      storage.setItem = () => {
        throw new Error('QuotaExceededError');
      };
      setShareCard('r', true);
      expect(kept.get('ssf-chia-share-card-r')).toBe('0');
      expect(readShareCard('r')).toBe(true);
      // …until a write works again, after which storage speaks.
      storage.setItem = (k: string, v: string) => void kept.set(k, v);
      setShareCard('r', false);
      expect(kept.get('ssf-chia-share-card-r')).toBe('0');
      kept.set('ssf-chia-share-card-r', '1');
      expect(readShareCard('r')).toBe(true);
    } finally {
      forgetSessionFlags();
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('P6b: the personal contact card carries the route alone, never the node card', () => {
    // #272 review round 7: a contact card goes wherever the player pastes it
    // and, with consent, on through friend-of-friend introductions, outside
    // any room; our node's card is handed out in a private room's pass alone.
    const hint = { irohNodeId: 'me', irohRelayUrls: ['https://relay'], irohDirectAddrs: ['198.51.100.7:4444'], nodeCard: card('me') };
    expect(routeHint(hint)).toEqual({ irohNodeId: 'me', irohRelayUrls: ['https://relay'], irohDirectAddrs: ['198.51.100.7:4444'] });
    expect('nodeCard' in routeHint(hint)).toBe(false);
    expect(routeHint({ irohNodeId: 'bare' })).toEqual({ irohNodeId: 'bare' });
    // And main.ts hands the contacts module that route, not the pass hint.
    const main = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8');
    const at = main.indexOf('initContacts({');
    expect(at).toBeGreaterThan(0);
    const block = main.slice(at, main.indexOf('});', at));
    expect(block).toContain('routeHint(');
  });

  it('P6b: a node that hands out no card keeps the cached one out of every pass', () => {
    // #272 review round 3: the node restarted with SSF_CHIA_SHARE_CARD=0; the
    // browser still holds the card it was handed before.
    expect(nodeSharesCard({ share_card: false })).toBe(false);
    expect(nodeSharesCard({ share_card: true })).toBe(true);
    expect(nodeSharesCard({})).toBe(true);
    expect(nodeSharesCard(null)).toBe(true);
    const hints = [
      { irohNodeId: 'me', nodeCard: card('me') },
      { irohNodeId: 'them', nodeCard: card('them') },
    ];
    const roomSwitch = true;
    expect(cardsForPass(hints, false, roomSwitch && nodeSharesCard({ share_card: false }), 'me')).toEqual([
      { irohNodeId: 'me' },
      { irohNodeId: 'them', nodeCard: card('them') },
    ]);
    expect(cardsForPass(hints, false, roomSwitch && nodeSharesCard({ share_card: true }), 'me')).toEqual(hints);
  });

  it('sequences caps by the clock but never at or below the last one', () => {
    expect(nextCapSeq(0, 1_000)).toBe(1_000);
    // Same millisecond still orders.
    expect(nextCapSeq(1_000, 1_000)).toBe(1_001);
    // A clock that went backwards cannot reorder caps.
    expect(nextCapSeq(5_000, 1_000)).toBe(5_001);
  });

  it('calls a room public space when bundled, when its passage is public, and when passage is unknown', () => {
    expect(roomIsPublicSpace(true, false)).toBe(true);
    expect(roomIsPublicSpace(false, true)).toBe(true);
    expect(roomIsPublicSpace(false, undefined)).toBe(true);
    expect(roomIsPublicSpace(false, false)).toBe(false);
  });
});
