/**
 * 📺 tvConsent — what a viewer's browser will fetch for the room's TV: the
 * product's lanes and the viewer's own machine without asking, a public host
 * after PLAY FROM <host>, a private-network host never.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptMediaOrigin, allowMount, consentRefusal, forgetMediaConsent, isPrivateHost, mayMountNow, mediaConsent, mediaOrigin,
  setNodeMediaOrigin, setOwnMediaOrigins, trustedNodeMediaOrigin, TV_MOUNT_BUDGET, TV_MOUNT_WINDOW_MS, TV_NODE_TRUST_MS,
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
      '[2001:db8::5efe:7f00:1]', '[2001:db8::200:5efe:c0a8:101]', '[2001:db8:1:2:0:5efe:a9fe:a9fe]', '[2001:db8::5efe:a00:1]', // ISATAP under a global prefix: loopback, private (the u/l form), the metadata address, 10/8
      '[2002:808:808::5efe:c0a8:101]', // a public 6to4 prefix over a private ISATAP identifier: every IPv4 inside is judged
    ];
    for (const h of inside) expect(isPrivateHost(h), h).toBe(true);
    const outside = [
      'example.org', 'archive.org', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '[2001:db8::1]', '[::ffff:808:808]',
      '[2002:808:808::]', '[2001:0:808:808::f7f7:f7f7]', '[2001:4860:4860::8888]', '[::808:808]', '[2002:808:808::1:2:3]',
      '[2001:db8::5efe:808:808]', '[2001:db8::1:5efe:7f00:1]', // ISATAP naming a public host; an identifier that is not ISATAP's (1:5efe)
    ];
    for (const h of outside) expect(isPrivateHost(h), h).toBe(false);
    for (const h of ['[2002::1::]', '[2002:zz::]', '[1:2:3:4:5:6:7:8:9]']) expect(isPrivateHost(h), h).toBe(false); // not addresses: nothing inside to judge
  });
});

describe('the mount budget: consent per origin bounds nothing cumulative', () => {
  it('lets a set mount six sources a minute on its own, then waits for PLAY or for a mount to age out — per set, and forgotten with the consents', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < TV_MOUNT_BUDGET; i++) expect(mayMountNow('tv-1', t0 + i * 1_000)).toBe(true);
    expect(mayMountNow('tv-1', t0 + 7_000)).toBe(false); // a seventh programme inside the minute: PLAY, not a fetch
    expect(mayMountNow('tv-1', t0 + 8_000)).toBe(false); // asked every tick: still no, and nothing counted
    expect(mayMountNow('tv-2', t0 + 8_000)).toBe(true); // another set has a budget of its own
    allowMount('tv-1'); // PLAY: the next mount is the viewer's, and the window starts over
    expect(mayMountNow('tv-1', t0 + 9_000)).toBe(true);
    for (let i = 1; i < TV_MOUNT_BUDGET; i++) expect(mayMountNow('tv-1', t0 + 9_000 + i)).toBe(true);
    expect(mayMountNow('tv-1', t0 + 10_000)).toBe(false);
    // A rate, never a lock: as the window's mounts age out the budget refills.
    expect(mayMountNow('tv-1', t0 + 9_000 + TV_MOUNT_WINDOW_MS)).toBe(true);
    forgetMediaConsent(); // leaving the room forgets the budget with the consents
    expect(mayMountNow('tv-1', t0 + 9_001 + TV_MOUNT_WINDOW_MS)).toBe(true);
  });
});

describe('the node origin\'s trust has a lifetime of its own', () => {
  it('holds for TV_NODE_TRUST_MS from the probe, lapses to node-stale, is renewed by the next probe and withdrawn by a probe the node did not answer; the other candidate port is a stranger throughout', () => {
    setOwnMediaOrigins(['http://localhost:4173']); // the page alone: the node is registered by the probe
    const t0 = 5_000_000;
    const node = url('http://127.0.0.1:8081/blob/abc');
    const other = url('http://127.0.0.1:8080/blob/abc');
    expect(mediaConsent(node, t0)).toBe('refuse'); // nothing identified yet
    setNodeMediaOrigin('http://127.0.0.1:8081', t0);
    expect(trustedNodeMediaOrigin(t0)).toBe('http://127.0.0.1:8081');
    expect(mediaConsent(node, t0)).toBe('ok');
    expect(mediaConsent(node, t0 + TV_NODE_TRUST_MS - 1)).toBe('ok');
    expect(mediaConsent(other, t0)).toBe('refuse'); // 8080 answered as a stranger (or not at all)
    expect(consentRefusal(other, t0)).toBe('private');
    // No probe ran (a throttled tab): the trust lapses by itself.
    expect(trustedNodeMediaOrigin(t0 + TV_NODE_TRUST_MS)).toBeNull();
    expect(mediaConsent(node, t0 + TV_NODE_TRUST_MS)).toBe('refuse');
    expect(consentRefusal(node, t0 + TV_NODE_TRUST_MS)).toBe('node-stale'); // the node, not "a private network"
    // The next probe the node answers renews it.
    setNodeMediaOrigin('http://127.0.0.1:8081', t0 + TV_NODE_TRUST_MS + 10);
    expect(mediaConsent(node, t0 + TV_NODE_TRUST_MS + 10)).toBe('ok');
    // A probe the node did not answer withdraws it at once, and the port is
    // then a loopback port like any other.
    setNodeMediaOrigin(null, t0 + TV_NODE_TRUST_MS + 20);
    expect(mediaConsent(node, t0 + TV_NODE_TRUST_MS + 20)).toBe('refuse');
    expect(consentRefusal(node, t0 + TV_NODE_TRUST_MS + 20)).toBe('private');
  });
});
