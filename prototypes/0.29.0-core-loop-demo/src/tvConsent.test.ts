/**
 * 📺 tvConsent — what a viewer's browser will fetch for the room's TV: the
 * product's lanes and the viewer's own machine without asking, a public host
 * after PLAY FROM <host>, a private-network host never.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptMediaOrigin, consentRefusal, forgetMediaConsent, isPrivateHost, mediaConsent, mediaOrigin, ownMediaOrigins,
  setOwnMediaOrigins, urlConsent, urlRefusal,
} from './tvConsent';
import type { TvSource } from './tvDoc';
import { setConvenienceLanesForTest } from './sovereignty';

const url = (u: string): TvSource => ({ kind: 'url', url: u });

beforeEach(() => {
  forgetMediaConsent();
  setOwnMediaOrigins(['http://localhost:4173', 'http://127.0.0.1:8080']);
  setConvenienceLanesForTest(true); // the full gate; the serverless-only default is its own block below
});
afterEach(() => { setConvenienceLanesForTest(null); });

describe('serverless only — the build default (sovereignty.ts)', () => {
  beforeEach(() => { setConvenienceLanesForTest(false); });

  it('refuses the product\'s own lanes, and says which reason', () => {
    expect(mediaConsent({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBe('refuse');
    expect(consentRefusal({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBe('lane-off');
    expect(mediaConsent({ kind: 'archive', identifier: 'metropolis', file: 'a film.mp4' })).toBe('refuse');
    expect(mediaConsent(url('https://archive.org/download/metropolis/a%20film.mp4'))).toBe('refuse');
    expect(consentRefusal(url('https://archive.org/download/metropolis/a%20film.mp4'))).toBe('server-off');
  });

  it('refuses any other server, accepted or not, and keeps the viewer\'s own origins', () => {
    expect(mediaConsent(url('https://example.org/a.mp4'))).toBe('refuse');
    expect(consentRefusal(url('https://example.org/a.mp4'))).toBe('server-off');
    acceptMediaOrigin('https://example.org');
    expect(mediaConsent(url('https://example.org/a.mp4'))).toBe('refuse');
    expect(mediaConsent(url('http://localhost:4173/film.mp4'))).toBe('ok');
    expect(mediaConsent(url('http://127.0.0.1:8080/blob/abc'))).toBe('ok');
    expect(mediaConsent(url('http://192.168.1.20/x'))).toBe('refuse');
    expect(consentRefusal(url('http://192.168.1.20/x'))).toBe('private');
    expect(consentRefusal(url('not a url'))).toBe('bad');
  });

  it('answers the cabinet the same way: a game on another server is not fetched here', () => {
    expect(urlConsent('http://localhost:4173/roms/pacman.zip')).toBe('ok');
    expect(urlConsent('http://127.0.0.1:8080/blob/abc')).toBe('ok');
    expect(urlConsent('https://archive.org/download/x/y.nes')).toBe('refuse');
    expect(urlRefusal('https://archive.org/download/x/y.nes')).toBe('server-off');
    expect(urlConsent('https://roms.example.org/pacman.zip')).toBe('refuse');
    acceptMediaOrigin('https://roms.example.org');
    expect(urlConsent('https://roms.example.org/pacman.zip')).toBe('refuse');
    expect(urlRefusal('https://roms.example.org/pacman.zip')).toBe('server-off');
    expect(urlRefusal('http://nas/pacman.zip')).toBe('private');
    expect(urlRefusal('not a url')).toBe('bad');
  });
});

describe('urlConsent — the one answer for any URL the room hands this browser (the cabinet asks it too)', () => {
  it('own origins and the product lanes without asking; a public host asks once; a private host never', () => {
    expect(urlConsent('http://localhost:4173/roms/pacman.zip')).toBe('ok');
    expect(urlConsent('http://127.0.0.1:8080/blob/abc')).toBe('ok'); // the identified node
    expect(urlConsent('http://127.0.0.1:8081/blob/abc')).toBe('refuse'); // a loopback port that is not the node's
    expect(urlConsent('https://archive.org/download/x/y.nes')).toBe('ok');
    expect(urlConsent('https://roms.example.org/pacman.zip')).toBe('ask');
    acceptMediaOrigin('https://roms.example.org');
    expect(urlConsent('https://roms.example.org/pacman.zip')).toBe('ok');
    expect(urlConsent('http://192.168.1.20/pacman.zip')).toBe('refuse');
    expect(urlConsent('http://nas/pacman.zip')).toBe('refuse');
    expect(urlConsent('not a url')).toBe('refuse');
    expect(mediaConsent(url('https://roms.example.org/film.mp4'))).toBe(urlConsent('https://roms.example.org/film.mp4'));
  });

  it('says why a refuse is a refuse, and only for a refuse', () => {
    expect(urlRefusal('http://192.168.1.20/pacman.zip')).toBe('private');
    expect(urlRefusal('http://127.0.0.1:8081/blob/abc')).toBe('private');
    expect(urlRefusal('not a url')).toBe('bad');
    expect(urlRefusal('https://roms.example.org/pacman.zip')).toBe('bad'); // lanes on: not a refuse at all
  });

  it('hands back the own origins it was given, normalized', () => {
    setOwnMediaOrigins(['http://localhost:4173/some/path', 'http://127.0.0.1:8080', 'not an origin']);
    expect(ownMediaOrigins().sort()).toEqual(['http://127.0.0.1:8080', 'http://localhost:4173']);
  });
});

describe('what a viewer\'s browser will fetch for the room\'s TV', () => {
  it('the product\'s own lanes need no asking', () => {
    expect(mediaConsent({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBe('ok');
    expect(mediaConsent({ kind: 'archive', identifier: 'metropolis', file: '' })).toBe('ok');
    expect(mediaConsent({ kind: 'archive', identifier: 'metropolis', file: 'a film.mp4' })).toBe('ok');
    expect(mediaConsent(url('https://archive.org/download/metropolis/a%20film.mp4'))).toBe('ok');
  });

  it('the viewer\'s own origin and node need no asking', () => {
    expect(mediaConsent(url('http://localhost:4173/film.mp4'))).toBe('ok');
    expect(mediaConsent(url('http://127.0.0.1:8080/blob/abc'))).toBe('ok');
  });

  it('a private-network host that is not the viewer\'s own node is refused — no button can change that', () => {
    const inside = [
      'http://127.0.0.1:9999/x', 'http://localhost:8080/x', 'http://10.0.0.5/x', 'http://192.168.1.20:8000/x',
      'http://172.16.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]:8080/x', 'http://[fe80::1]/x',
      'http://nas/film.mp4', 'http://nas.local/film.mp4', 'http://100.64.0.1/x', 'http://0.0.0.0/x',
      'http://[ff02::1]/x', 'http://[ff15::efc0:988f]:6771/x', 'http://224.0.0.1/x',
    ];
    for (const u of inside) {
      expect(mediaConsent(url(u)), u).toBe('refuse');
      acceptMediaOrigin(new URL(u).origin);
      expect(mediaConsent(url(u)), `${u} after an accept`).toBe('refuse');
    }
  });

  it('a public host is asked about, then fine for the session — per origin, scheme and port included', () => {
    expect(mediaConsent(url('https://example.org/a.mp4'))).toBe('ask');
    acceptMediaOrigin('https://example.org');
    expect(mediaConsent(url('https://example.org/b.mp4'))).toBe('ok');
    expect(mediaConsent(url('http://example.org/b.mp4'))).toBe('ask');
    expect(mediaConsent(url('https://example.org:8443/b.mp4'))).toBe('ask');
    expect(mediaConsent(url('https://cdn.example.org/b.mp4'))).toBe('ask');
    forgetMediaConsent();
    expect(mediaConsent(url('https://example.org/b.mp4'))).toBe('ask');
  });

  it('names the origin a source is fetched from', () => {
    expect(mediaOrigin(url('https://example.org:8443/a/b.mp4?x=1'))).toBe('https://example.org:8443');
    expect(mediaOrigin({ kind: 'youtube', videoId: 'uPwPecwX2zs' })).toBe('https://www.youtube-nocookie.com');
    expect(mediaOrigin({ kind: 'archive', identifier: 'x', file: '' })).toBe('https://archive.org');
  });

  it('knows the private ranges, IPv6 and intranet names included', () => {
    const inside = [
      '127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '0.0.0.0',
      '100.64.0.1', '224.0.0.1', '255.255.255.255', 'localhost', 'foo.localhost', 'nas', 'printer.local',
      'box.internal', 'tv.lan', 'pi.home.arpa', '[::1]', '[::]', '[fe80::1]', '[fd00::1]', '[fc00::1]',
      '[::ffff:7f00:1]', '[::ffff:c0a8:101]', '[::ffff:127.0.0.1]', '[ff02::1]', '[ff15::efc0:988f]', '[ff0e::1]',
      '[::7f00:1]', // IPv4-compatible 127.0.0.1
      '[2002:7f00:1::]', '[2002:c0a8:101::1]', '[2002:a9fe:a9fe::]', '[2002:a00:1:1:2:3:4:5]', // 6to4: loopback, private, the metadata address, 10/8
      '[2001:0:c0a8:101::]', '[2001:0:808:808::3f57:fffe]', '[2001::a9fe:a9fe:0:0:0:0]', // Teredo: a private server, a private client (inverted), the metadata server
    ];
    for (const h of inside) expect(isPrivateHost(h), h).toBe(true);
    const outside = [
      'example.org', 'archive.org', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '[2001:db8::1]', '[::ffff:808:808]',
      '[2002:808:808::]', '[2001:0:808:808::f7f7:f7f7]', '[2001:4860:4860::8888]', '[::808:808]', '[2002:808:808::1:2:3]',
    ];
    for (const h of outside) expect(isPrivateHost(h), h).toBe(false);
    for (const h of ['[2002::1::]', '[2002:zz::]', '[1:2:3:4:5:6:7:8:9]']) expect(isPrivateHost(h), h).toBe(false); // not addresses: nothing inside to judge
  });
});
