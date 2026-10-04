/**
 * 📺 tvConsent — which media origins THIS viewer's browser will fetch for the
 * room's TV. The viewer decides, never whoever wrote the record.
 *
 * The `tv` map is peer-writable and every read is shape-checked, but a
 * shape-valid http(s) source still makes every open theatre's browser FETCH
 * it: a <video> preloads the moment it is mounted. Without a gate a peer
 * could point every viewer's webview at a URL of its choosing — a loopback
 * service, a private-network address, a 10 GB file. So the theatre mounts a
 * source only when its origin is
 *   - one of the product's own lanes (youtube-nocookie.com, archive.org —
 *     the tiles the start screen offers, labelled as such),
 *   - this page's own origin or its node's (registered by main.ts: the
 *     viewer's own machine serving the viewer), or
 *   - one this viewer accepted, this session, by pressing PLAY FROM <host>;
 * and a loopback, link-local or private-network host that is not the
 * viewer's own node is refused outright — no button can make a browser poke
 * its owner's LAN for someone else.
 *
 * CONSENT, NOT VALIDATION: a host the viewer accepted can redirect the
 * request, or resolve, into the viewer's own network, and a browser <video>
 * can see neither — so the ask says so, and the node's media proxy (plan
 * §3.4, TODO) is where destinations are checked after DNS and on every
 * redirect. Until it lands, a direct URL is the viewer's own trust decision,
 * made per origin, per session.
 *
 * DOM-free: the theatre asks, this answers, and vitest covers the answers.
 */

import type { TvSource } from './tvDoc';
import { convenienceLanesEnabled, sourceKindAllowed } from './sovereignty';

export type MediaConsent = 'ok' | 'ask' | 'refuse';

/** Why a 'refuse' is a refuse, for the words on the screen: the lane is
 *  off in this build; the link is on another server and this build plays
 *  serverless sources only; the host is inside a private network; or the
 *  link is not a URL at all. */
export type ConsentRefusal = 'lane-off' | 'server-off' | 'private' | 'bad';

/** The product's own lanes: where the start screen's tiles fetch from. */
const PRODUCT_ORIGINS: ReadonlySet<string> = new Set([
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
  'https://archive.org',
]);

let ownOrigins: ReadonlySet<string> = new Set();
const accepted = new Set<string>();

function normalizeOrigin(s: string): string | null {
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

/** This page's own origin and its node's HTTP origin(s). Media from there
 *  is the viewer's own machine serving the viewer: no asking. */
export function setOwnMediaOrigins(origins: readonly string[]): void {
  ownOrigins = new Set(origins.map(normalizeOrigin).filter((o): o is string => o !== null));
}

/** The origins setOwnMediaOrigins registered, normalized — for an allow-list
 *  handed to a frame that fetches on the viewer's behalf (the cabinet's). */
export function ownMediaOrigins(): string[] {
  return [...ownOrigins];
}

/** The viewer pressed PLAY FROM <host>: that origin is fine for the rest of
 *  this session (the scheme and the port are part of it). */
export function acceptMediaOrigin(origin: string): void {
  const o = normalizeOrigin(origin);
  if (o) accepted.add(o);
}

export function forgetMediaConsent(): void {
  accepted.clear();
}

/** The origin a source's bytes come from. */
export function mediaOrigin(source: TvSource): string | null {
  if (source.kind === 'youtube') return 'https://www.youtube-nocookie.com';
  if (source.kind === 'archive') return 'https://archive.org';
  return normalizeOrigin(source.url);
}

/** A host on this machine or its networks: loopback, link-local, the
 *  private and CGNAT ranges, multicast, IPv4-mapped IPv6 of the same, and
 *  intranet names (no dot, `.local`, `.internal`, `.lan`, `.home.arpa`).
 *  Conservative on purpose: a miss here costs a viewer a button press; a
 *  miss the other way costs them a request into their own LAN. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h.startsWith('[')) return isPrivateIPv6(h.slice(1, -1));
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/\.(local|internal|lan|home\.arpa)$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  return !h.includes('.'); // a bare intranet name: "nas", "printer"
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (/^fe[89ab]/.test(s)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(s)) return true; // unique local fc00::/7
  if (/^ff/.test(s)) return true; // multicast ff00::/8, every scope — the LSD groups included
  const dotted = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); // IPv4-mapped with the quad spelt out
  if (dotted) return isPrivateHost(dotted[1]!);
  // An IPv6 address that carries an IPv4 inside is judged by the IPv4:
  // IPv4-mapped (::ffff:a.b.c.d, which the URL parser writes as hex) and
  // IPv4-compatible (::a.b.c.d), 6to4 (2002::/16, the IPv4 in bits 16–47)
  // and Teredo (2001:0::/32, the server's IPv4 in bits 32–63 and the
  // client's in the last 32, inverted) — the last two read as global
  // unicast on paper, and 2002:7f00:1:: is loopback in fact.
  const g = expandIPv6(s);
  if (!g) return false;
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && g[5] === 0xffff) return isPrivateHost(quad(g[6]!, g[7]!)); // mapped
  if (zeroTo(6)) return isPrivateHost(quad(g[6]!, g[7]!)); // compatible (deprecated, still parsed)
  if (g[0] === 0x2002) return isPrivateHost(quad(g[1]!, g[2]!)); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) { // Teredo
    return isPrivateHost(quad(g[2]!, g[3]!)) || isPrivateHost(quad(g[6]! ^ 0xffff, g[7]! ^ 0xffff));
  }
  return false;
}

/** The eight 16-bit groups of an IPv6 address, `::` expanded; null for
 *  anything that is not one (the URL parser hands us canonical forms, but
 *  the check must not trust its caller). */
function expandIPv6(ip: string): number[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] => (part === '' ? [] : part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (head.some(Number.isNaN) || tail.some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** May this viewer's browser fetch `url` now — the one answer for any
 *  peer-written http(s) URL the room can hand this browser (a TV source, an
 *  arcade game's link): yes for the page's own origin and its identified
 *  node; never for a host inside this viewer's own networks; and for any
 *  other server, yes for the product's lanes and ask first for the rest
 *  with the convenience lanes on, never with them off — the build default
 *  (sovereignty.ts): serverless sources only. */
export function urlConsent(url: string): MediaConsent {
  const origin = normalizeOrigin(url);
  if (!origin) return 'refuse';
  if (ownOrigins.has(origin)) return 'ok';
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return 'refuse';
  }
  if (isPrivateHost(host)) return 'refuse';
  // Serverless only: a third-party server is a server, whoever runs it.
  // The product's origins and PLAY FROM <host> exist only with the
  // convenience lanes on.
  if (!convenienceLanesEnabled()) return 'refuse';
  if (PRODUCT_ORIGINS.has(origin) || accepted.has(origin)) return 'ok';
  return 'ask';
}

/** The reason behind a 'refuse' from urlConsent, for the words on the
 *  screen. */
export function urlRefusal(url: string): ConsentRefusal {
  const origin = normalizeOrigin(url);
  if (!origin) return 'bad';
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return 'bad';
  }
  if (isPrivateHost(host)) return 'private';
  return convenienceLanesEnabled() ? 'bad' : 'server-off';
}

/** May this viewer's browser fetch `source` now: yes, ask first, or never.
 *  The product's own lanes (YouTube, the archive embed) are fetched from
 *  their own origins by their own players: yes with the convenience lanes
 *  on, never with them off (sovereignty.ts). */
export function mediaConsent(source: TvSource): MediaConsent {
  if (source.kind !== 'url') return sourceKindAllowed(source.kind) ? 'ok' : 'refuse';
  return urlConsent(source.url);
}

/** The reason behind a 'refuse' from mediaConsent, for the words on the
 *  screen. */
export function consentRefusal(source: TvSource): ConsentRefusal {
  if (source.kind !== 'url') return 'lane-off';
  return urlRefusal(source.url);
}
