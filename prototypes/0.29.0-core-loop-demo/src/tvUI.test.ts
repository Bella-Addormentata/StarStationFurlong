/**
 * 📺 tvUI — the remote's gate on what this build writes into the room: a
 * source this build would refuse to play is said no to with the reason, and
 * never written — from the paste box and from PREVIOUSLY ON alike.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { playRefusal, tvNavIndex } from './tvUI';
import { forgetMediaConsent, setOwnMediaOrigins } from './tvConsent';
import { setConvenienceLanesForTest } from './sovereignty';

beforeEach(() => {
  forgetMediaConsent();
  setOwnMediaOrigins(['http://localhost:4173', 'http://127.0.0.1:8080']);
});
afterEach(() => { setConvenienceLanesForTest(null); });

describe('what the remote refuses to write, serverless only (the build default)', () => {
  beforeEach(() => { setConvenienceLanesForTest(false); });

  it('a lane this build does not offer, a link on another server, a private host, a non-link — each with its reason', () => {
    expect(playRefusal({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toMatch(/YouTube is off here/);
    expect(playRefusal({ kind: 'archive', identifier: 'metropolis', file: '' })).toMatch(/archive\.org is off here/);
    expect(playRefusal({ kind: 'url', url: 'https://archive.org/download/metropolis/a%20film.mp4' })).toMatch(/on another server/);
    expect(playRefusal({ kind: 'url', url: 'https://example.org/a.mp4' })).toMatch(/on another server/);
    expect(playRefusal({ kind: 'url', url: 'http://192.168.1.20/x.mp4' })).toMatch(/private network/);
    expect(playRefusal({ kind: 'url', url: 'not a url' })).toMatch(/not a link/);
  });

  it('a link on this page\'s own origin or its node plays here: nothing to refuse', () => {
    expect(playRefusal({ kind: 'url', url: 'http://localhost:4173/film.mp4' })).toBeNull();
    expect(playRefusal({ kind: 'url', url: 'http://127.0.0.1:8080/blob/abc' })).toBeNull();
  });
});

describe('the remote by keyboard: ↑/↓ step through the visible controls and wrap', () => {
  it('steps and wraps at both ends, lands on the first from nowhere, and has nowhere to go with no control', () => {
    expect(tvNavIndex(5, 0, 1)).toBe(1);
    expect(tvNavIndex(5, 4, 1)).toBe(0); // ↓ from the last wraps to the first
    expect(tvNavIndex(5, 0, -1)).toBe(4); // ↑ from the first wraps to the last
    expect(tvNavIndex(5, 2, -1)).toBe(1);
    expect(tvNavIndex(5, -1, 1)).toBe(0); // focus on the view itself: the first control
    expect(tvNavIndex(5, -1, -1)).toBe(0);
    expect(tvNavIndex(5, 9, 1)).toBe(0); // a control that just left the list (a repaint): the first
    expect(tvNavIndex(1, 0, 1)).toBe(0); // one control: it stays
    expect(tvNavIndex(1, 0, -1)).toBe(0);
    expect(tvNavIndex(0, -1, 1)).toBe(-1); // nothing visible: nowhere to go
  });
});

describe('with the convenience lanes on', () => {
  beforeEach(() => { setConvenienceLanesForTest(true); });

  it('the product\'s lanes and a public host pass (the theatre asks the viewer); a private host never', () => {
    expect(playRefusal({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBeNull();
    expect(playRefusal({ kind: 'archive', identifier: 'metropolis', file: '' })).toBeNull();
    expect(playRefusal({ kind: 'url', url: 'https://example.org/a.mp4' })).toBeNull();
    expect(playRefusal({ kind: 'url', url: 'http://nas.local/a.mp4' })).toMatch(/private network/);
    expect(playRefusal({ kind: 'url', url: 'http://[fe80::1]/a.mp4' })).toMatch(/private network/);
  });
});
