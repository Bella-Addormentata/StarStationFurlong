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
 * made per origin, per session. What this page CAN do before mounting a
 * consented third-party URL is ask the host once, with a CORS HEAD that
 * follows no redirect (probeRedirect, below): a host that answers it plays,
 * one that answers with a redirect does not, and one that does not answer
 * it — no CORS, or down — does not either. That is a check of one answer
 * at one moment, not validation of the <video>'s later GET, which the host
 * may answer differently; it narrows the URL tile to CORS-clean hosts, which
 * is what the plan names for it (a VideoTexture needs CORS too).
 *
 * DOM-free: the theatre asks, this answers, and vitest covers the answers.
 */

import type { TvSource } from './tvDoc';
import { tvNow, tvWallNow } from './tvDoc';
import { convenienceLanesEnabled, sourceKindAllowed } from './sovereignty';

export type MediaConsent = 'ok' | 'ask' | 'refuse';

/** Why a 'refuse' is a refuse, for the words on the screen: the lane is
 *  off in this build; the link is on another server and this build plays
 *  serverless sources only; the link is on the node's origin but the node's
 *  trust has run out (no fingerprint answer lately); the host is inside a
 *  private network; or the link is not a URL at all. */
export type ConsentRefusal = 'lane-off' | 'server-off' | 'node-stale' | 'private' | 'bad';

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

/** This page's own origin(s). Media from there is the viewer's own machine
 *  serving the viewer: no asking, and no expiry — the page is where it is. */
export function setOwnMediaOrigins(origins: readonly string[]): void {
  ownOrigins = new Set(origins.map(normalizeOrigin).filter((o): o is string => o !== null));
}

/** How long the node's origin stays trusted after a fingerprint probe said
 *  it was the node's: one probe interval (main.ts refreshes every 60 s) and
 *  a margin. The node's port is a loopback port like any other: if the node
 *  exits and another local service binds its port between probes, a
 *  peer-written URL on that origin must not go on passing without asking
 *  until the next probe happens to run (a throttled tab's may not). So the
 *  trust has a lifetime of its own, separate from the cached fingerprint,
 *  and a successful probe is what renews it; past it, the origin is refused
 *  like any loopback host ('node-stale') until the node answers again. This
 *  bounds stale trust; it does not see a service impersonating the node. */
export const TV_NODE_TRUST_MS = 90_000;

let nodeOrigin: string | null = null;
/** Two deadlines, both must hold: the monotonic clock may stop through an
 *  OS sleep (trust earned a minute before an hour's sleep would still read
 *  as a minute old on waking, with whatever bound the node's port meanwhile
 *  trusted at once), and the wall clock may step; the earlier of the two
 *  ends the trust, so a sleep cannot extend it and a clock step cannot. */
let nodeTrustUntil = -Infinity;
let nodeTrustWallUntil = -Infinity;

/** The node's HTTP origin as the fingerprint probe identified it (main.ts),
 *  trusted from `now` (monotonic) and `wall` for TV_NODE_TRUST_MS; null
 *  withdraws it (a probe the node did not answer). */
export function setNodeMediaOrigin(origin: string | null, now: number, wall = tvWallNow()): void {
  nodeOrigin = origin ? normalizeOrigin(origin) : null;
  nodeTrustUntil = nodeOrigin ? now + TV_NODE_TRUST_MS : -Infinity;
  nodeTrustWallUntil = nodeOrigin ? wall + TV_NODE_TRUST_MS : -Infinity;
}

/** The node's origin while its trust is live at `now` and `wall`, else null. */
export function trustedNodeMediaOrigin(now = tvNow(), wall = tvWallNow()): string | null {
  return nodeOrigin && now < nodeTrustUntil && wall < nodeTrustWallUntil ? nodeOrigin : null;
}

/** The viewer pressed PLAY FROM <host>: that origin is fine for the rest of
 *  this session (the scheme and the port are part of it). */
export function acceptMediaOrigin(origin: string): void {
  const o = normalizeOrigin(origin);
  if (o) accepted.add(o);
}

export function forgetMediaConsent(): void {
  accepted.clear();
  redirectVerdicts.clear();
  forgetMountBudget();
}

// ── The redirect probe ───────────────────────────────────────────────────────
//
// A host the viewer accepted can answer the media request with a redirect
// into the viewer's own network, and a <video> element follows it blind. A
// media element shows nothing of the chain. A fetch can show a little, and
// only in CORS mode: with `redirect: 'manual'` a redirect comes back as an
// opaque-redirect (type 'opaqueredirect') BEFORE any CORS check — the fetch
// standard files the manual-redirect response before the tainting check in
// HTTP fetch — while a direct answer passes only when the host sends CORS
// headers, and everything else is a network error. (`no-cors` with any
// redirect mode but 'follow' is a network error outright: the standard's
// main fetch refuses it, so a no-cors probe learns nothing at all.) So the
// probe is a CORS HEAD, and it FAILS CLOSED: a direct CORS answer plays, a
// redirect does not, and no answer — a host without CORS, or one that is
// down — does not either, since nothing that could not be asked may
// authorise a mount. That narrows the URL tile to CORS-clean hosts, which
// is what the plan names for it. It remains a check of one answer at one
// moment: the <video>'s GET may be answered differently, and a hostname
// that RESOLVES into the viewer's network is not seen at all. Destination
// validation is the node proxy's (plan §3.4).

export type RedirectVerdict = 'direct' | 'redirects' | 'unknown';

/** What the probe found, per URL, for the session — 'direct' and
 *  'redirects' only: an 'unknown' (no answer) is not kept, so a RETRY asks
 *  again. */
const redirectVerdicts = new Map<string, Exclude<RedirectVerdict, 'unknown'>>();

/** Whether the theatre owes `source` a redirect probe before mounting it: a
 *  direct URL on an origin the VIEWER accepted (PLAY FROM <host>) — never
 *  the viewer's own origin, the node's (this machine serving this viewer),
 *  or a product lane (archive.org's permalinks 302 to its file servers by
 *  design, and its own origin is the lane). */
export function needsRedirectProbe(source: TvSource, now = tvNow(), wall = tvWallNow()): boolean {
  if (source.kind !== 'url') return false;
  const origin = normalizeOrigin(source.url);
  if (!origin) return false;
  if (ownOrigins.has(origin) || origin === trustedNodeMediaOrigin(now, wall) || PRODUCT_ORIGINS.has(origin)) return false;
  return accepted.has(origin);
}

/** The probe's kept verdict for `url`, or null when it has none (never
 *  probed, or the probe got no answer). */
export function redirectVerdict(url: string): Exclude<RedirectVerdict, 'unknown'> | null {
  return redirectVerdicts.get(url) ?? null;
}

/** Probe `url` with a CORS HEAD that follows no redirect and reads no body.
 *  An opaque-redirect answer is 'redirects'; any answer that came through
 *  (the host sends CORS headers — a 200, a 405 for the HEAD, a 404) is
 *  'direct'; a network error — a host without CORS headers, one that is
 *  down, the deadline — is 'unknown', which authorises nothing and is not
 *  kept, so a RETRY asks again. `fetchImpl` is injectable for the tests;
 *  the request options are the ones the fetch standard allows together
 *  (cors + manual), where no-cors + manual would be an error on every call. */
export async function probeRedirect(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): Promise<RedirectVerdict> {
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), timeoutMs);
  let verdict: RedirectVerdict = 'unknown';
  try {
    const res = await fetchImpl(url, {
      method: 'HEAD', mode: 'cors', redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: ctl.signal,
    });
    verdict = res.type === 'opaqueredirect' ? 'redirects' : 'direct';
  } catch {
    // a host without CORS, unreachable, or the deadline: nothing learnt, nothing authorised
  } finally {
    clearTimeout(deadline);
  }
  if (verdict !== 'unknown') redirectVerdicts.set(url, verdict);
  return verdict;
}

/** Automatic mounts the theatre may make on its own, per set, within the
 *  window: consent per origin bounds nothing cumulative — a modified client
 *  could rotate shape-valid sources on the viewer's own node, or a product
 *  lane, and have every open theatre fetch each in turn without end, and no
 *  cap on one request bounds that. Six in a minute is a holder flipping
 *  through films, never a script: past it the theatre mounts nothing more
 *  by itself, shows what is on with PLAY, and the press is the consent that
 *  mounts it and opens the next window (allowMount). The window refills as
 *  its mounts age out, so the budget is a rate and never a lock. */
export const TV_MOUNT_BUDGET = 6;
export const TV_MOUNT_WINDOW_MS = 60_000;

/** Per set: the monotonic times of the automatic mounts inside the window. */
const mounts = new Map<string, number[]>();

/** May the theatre mount a new source for `itemId` on its own at `now`? A
 *  yes is counted; a no counts nothing, so asking again every tick changes
 *  nothing until a mount ages out of the window or the viewer presses PLAY. */
export function mayMountNow(itemId: string, now: number): boolean {
  const recent = (mounts.get(itemId) ?? []).filter((t) => now - t < TV_MOUNT_WINDOW_MS);
  if (recent.length >= TV_MOUNT_BUDGET) {
    mounts.set(itemId, recent);
    return false;
  }
  recent.push(now);
  mounts.set(itemId, recent);
  return true;
}

/** The viewer pressed PLAY on a set past its budget: the next mount is
 *  theirs, and the window starts over. */
export function allowMount(itemId: string): void {
  mounts.delete(itemId);
}

export function forgetMountBudget(): void {
  mounts.clear();
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
  // IPv4-compatible (::a.b.c.d), 6to4 (2002::/16, the IPv4 in bits 16–47),
  // Teredo (2001:0::/32, the server's IPv4 in bits 32–63 and the client's
  // in the last 32, inverted) and ISATAP (RFC 5214: under ANY prefix, an
  // interface identifier of 0:5efe or 200:5efe in bits 64–95 and the IPv4
  // in the last 32) — the last three read as global unicast on paper, and
  // 2002:7f00:1:: is loopback in fact. Every IPv4 an address carries is
  // judged: a 6to4 or Teredo prefix over an ISATAP identifier names two.
  const g = expandIPv6(s);
  if (!g) return false;
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && g[5] === 0xffff) return isPrivateHost(quad(g[6]!, g[7]!)); // mapped
  if (zeroTo(6)) return isPrivateHost(quad(g[6]!, g[7]!)); // compatible (deprecated, still parsed)
  if (g[0] === 0x2002 && isPrivateHost(quad(g[1]!, g[2]!))) return true; // 6to4
  if (g[0] === 0x2001 && g[1] === 0 // Teredo
    && (isPrivateHost(quad(g[2]!, g[3]!)) || isPrivateHost(quad(g[6]! ^ 0xffff, g[7]! ^ 0xffff)))) return true;
  if ((g[4] === 0 || g[4] === 0x0200) && g[5] === 0x5efe) return isPrivateHost(quad(g[6]!, g[7]!)); // ISATAP
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

/** May this viewer's browser fetch `source` now: yes, ask first, or never.
 *  The product's own lanes (YouTube, the archive embed) are fetched from
 *  their own origins by their own players: yes with the convenience lanes
 *  on, never with them off (sovereignty.ts). */
export function mediaConsent(source: TvSource, now = tvNow(), wall = tvWallNow()): MediaConsent {
  if (source.kind !== 'url') return sourceKindAllowed(source.kind) ? 'ok' : 'refuse';
  const origin = normalizeOrigin(source.url);
  if (!origin) return 'refuse';
  if (ownOrigins.has(origin) || origin === trustedNodeMediaOrigin(now, wall)) return 'ok';
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
export function consentRefusal(source: TvSource, now = tvNow(), wall = tvWallNow()): ConsentRefusal {
  if (source.kind !== 'url') return 'lane-off';
  const origin = normalizeOrigin(source.url);
  if (!origin) return 'bad';
  // The node's own origin whose trust has run out: the node, not a stranger,
  // as far as this page last knew — said so, not "a private network".
  if (nodeOrigin !== null && origin === nodeOrigin && trustedNodeMediaOrigin(now, wall) === null) return 'node-stale';
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return 'bad';
  }
  if (isPrivateHost(host)) return 'private';
  return convenienceLanesEnabled() ? 'bad' : 'server-off';
}
