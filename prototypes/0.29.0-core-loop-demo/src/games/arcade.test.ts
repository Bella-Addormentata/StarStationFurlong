/**
 * 🕹️ The arcade match record: a guest takes and gives back the second seat,
 * and a record whose guest is half there is refused.
 */

import { describe, expect, it } from 'vitest';
import { isArcadeMatch, newMatch, withGuest, withoutGuest } from './arcade';

const match = () => newMatch({ game: 'thwaite', host: 'p1', hostPage: 'page-1', hostSeat: 0, now: 1, random: () => 0.5 });

describe('arcade match', () => {
  it('seats one guest page at a time, never the host page', () => {
    const m = withGuest(match(), 'p2', 'page-2', () => 0.25)!;
    expect(m).toMatchObject({ guest: 'p2', guestPage: 'page-2' });
    expect(m.guestToken).not.toBe(0);
    expect(withGuest(m, 'p2', 'page-2')).toBe(m); // already there
    expect(withGuest(m, 'p3', 'page-3')).toBeNull(); // taken
    expect(withGuest(match(), 'p1', 'page-1')).toBeNull(); // the host's own page
    expect(withoutGuest(m, 'page-3')).toBe(m); // only the holder gives it back
    expect(withoutGuest(m, 'page-2')).toMatchObject({ guest: null, guestPage: null, guestToken: 0 });
  });

  it('accepts a guest only all there or not there at all', () => {
    const m = match();
    const seated = withGuest(m, 'p2', 'page-2')!;
    expect(isArcadeMatch(m)).toBe(true);
    expect(isArcadeMatch(seated)).toBe(true);
    expect(isArcadeMatch({ ...m, guestPage: 'page-2' })).toBe(false); // a seat no tick can drive
    expect(isArcadeMatch({ ...m, guestToken: 7 })).toBe(false); // a token with nobody behind it
    expect(isArcadeMatch({ ...seated, guestToken: 0 })).toBe(false);
    expect(isArcadeMatch({ ...seated, guest: null })).toBe(false);
  });
});
