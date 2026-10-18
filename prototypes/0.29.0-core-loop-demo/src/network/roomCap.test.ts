import { describe, expect, it } from 'vitest';
import {
  MAX_CAP_MEMBER_CARDS,
  buildRoomCapPayload,
  cardsForPass,
  memberCardsOf,
  newerCard,
  nextCapSeq,
  nodeSharesCard,
  normalizeContactCard,
  passageReading,
  roomIsPublicSpace,
  roomPosture,
  roomPostureProbe,
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
