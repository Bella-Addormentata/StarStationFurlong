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
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // IPv4-mapped, as the URL parser writes it
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const dotted = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return isPrivateHost(dotted[1]!);
  return false;
}

/** May this viewer's browser fetch `source` now: yes, ask first, or never.
 *  The product's own lanes (YouTube, the archive embed) are fetched from
 *  their own origins by their own players: yes with the convenience lanes
 *  on, never with them off (sovereignty.ts). */
export function mediaConsent(source: TvSource): MediaConsent {
  if (source.kind !== 'url') return sourceKindAllowed(source.kind) ? 'ok' : 'refuse';
  const origin = normalizeOrigin(source.url);
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

/** The reason behind a 'refuse' from mediaConsent, for the words on the
 *  screen. */
export function consentRefusal(source: TvSource): ConsentRefusal {
  if (source.kind !== 'url') return 'lane-off';
  const origin = normalizeOrigin(source.url);
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
