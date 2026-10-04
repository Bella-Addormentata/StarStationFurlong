/**
 * 📺 tvConsent — what a viewer's browser will fetch for the room's TV: the
 * product's lanes and the viewer's own machine without asking, a public host
 * after PLAY FROM <host>, a private-network host never.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptMediaOrigin, forgetMediaConsent, isPrivateHost, mediaConsent, mediaOrigin, setOwnMediaOrigins, urlConsent,
} from './tvConsent';
import type { TvSource } from './tvDoc';

const url = (u: string): TvSource => ({ kind: 'url', url: u });

beforeEach(() => {
  forgetMediaConsent();
  setOwnMediaOrigins(['http://localhost:4173', 'http://127.0.0.1:8080']);
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
      '[::ffff:7f00:1]', '[::ffff:c0a8:101]', '[::ffff:127.0.0.1]',
    ];
    for (const h of inside) expect(isPrivateHost(h), h).toBe(true);
    const outside = ['example.org', 'archive.org', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '[2001:db8::1]', '[::ffff:808:808]'];
    for (const h of outside) expect(isPrivateHost(h), h).toBe(false);
  });
});
