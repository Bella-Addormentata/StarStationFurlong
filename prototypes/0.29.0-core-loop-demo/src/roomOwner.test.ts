/**
 * 🔒 roomOwner — the central owner gate (#141)
 *
 * The wildcard cases are the point: `owner === 'Local-Clone'` used to return
 * true for EVERY caller, and every owner-gated surface funnels through this
 * predicate. Each of those cases fails if the clause comes back.
 */
import { describe, expect, it } from 'vitest';
import { isRoomOwner, legacyOwnerMarker, ownerGateRefusal } from './roomOwner';

const ME = 'player-me';
const THEM = 'player-them';

/** The ordinary case: a real player, holding no shares anywhere. */
const plain = { playerId: ME, isVentureShareholder: false };

describe('isRoomOwner — the retired wildcard (#141)', () => {
  it('grants when the owner is my player id', () => {
    expect(isRoomOwner(ME, plain)).toBe(true);
  });

  it('refuses another player’s room', () => {
    expect(isRoomOwner(THEM, plain)).toBe(false);
  });

  it('REFUSES the legacy Local-Clone marker', () => {
    // The whole of #141. This returned true for everyone.
    expect(isRoomOwner('Local-Clone', plain)).toBe(false);
  });

  it('refuses Local-Clone for EVERY player, not just a stranger', () => {
    // The bug was not "the wrong person passes" — it was "everyone passes".
    for (const playerId of [ME, THEM, 'player-third', '']) {
      expect(isRoomOwner('Local-Clone', { playerId, isVentureShareholder: false })).toBe(false);
    }
  });

  it('refuses an absent owner', () => {
    // An unset field must not be a grant either — several call sites used to
    // substitute the 'Local-Clone' marker for it, which made it one.
    expect(isRoomOwner('', plain)).toBe(false);
  });

  it('still grants to a venture shareholder — #68’s V1 owner rule is intact', () => {
    // Retiring the wildcard must not take joint ownership down with it.
    expect(isRoomOwner(THEM, { playerId: ME, isVentureShareholder: true })).toBe(true);
  });

  it('grants nothing to a shareholder of a DIFFERENT room’s venture', () => {
    // The flag means "of the venture registered HERE" — the caller resolves it
    // against the current room, so a false flag must not leak a grant.
    expect(isRoomOwner(THEM, { playerId: ME, isVentureShareholder: false })).toBe(false);
  });
});

describe('legacyOwnerMarker — explains, never grants', () => {
  it('recognises the marker and the empty value', () => {
    expect(legacyOwnerMarker('Local-Clone')).toBe(true);
    expect(legacyOwnerMarker('')).toBe(true);
  });

  it('does not claim a real player id is legacy', () => {
    expect(legacyOwnerMarker(ME)).toBe(false);
  });

  it('agrees with isRoomOwner: everything it calls legacy is refused', () => {
    for (const owner of ['Local-Clone', '']) {
      expect(legacyOwnerMarker(owner)).toBe(true);
      expect(isRoomOwner(owner, plain)).toBe(false);
    }
  });
});

describe('ownerGateRefusal — a legacy room reads as legacy', () => {
  const label = (o: string) => `NAME(${o})`;

  it('explains the legacy case instead of naming Local-Clone as the owner', () => {
    const msg = ownerGateRefusal('Local-Clone', 'edit', label);
    // The old text read "Only the owner (Local-Clone) can edit this room."
    expect(msg).not.toContain('Local-Clone');
    expect(msg).toContain('predates room ownership');
    expect(msg).toContain('#141');
  });

  it('names the real owner when there is one', () => {
    expect(ownerGateRefusal(THEM, 'edit', label)).toBe(
      `Only the owner (NAME(${THEM})) can edit this room.`,
    );
  });

  it('carries the action verb through both branches', () => {
    expect(ownerGateRefusal('Local-Clone', 'rename', label)).toContain('rename');
    expect(ownerGateRefusal(THEM, 'rename', label)).toContain('rename');
  });

  it('does not consult the label resolver for a legacy owner', () => {
    // Resolving 'Local-Clone' through the players map yields nothing useful;
    // calling it at all is what produced the baffling old message.
    let called = false;
    ownerGateRefusal('Local-Clone', 'edit', (o) => { called = true; return o; });
    expect(called).toBe(false);
  });
});
