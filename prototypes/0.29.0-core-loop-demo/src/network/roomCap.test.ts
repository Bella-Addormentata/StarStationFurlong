import { describe, expect, it } from 'vitest';
import {
  MAX_CAP_MEMBER_CARDS,
  buildRoomCapPayload,
  memberCardsOf,
  newerCard,
  nextCapSeq,
  normalizeContactCard,
  roomIsPublicSpace,
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
