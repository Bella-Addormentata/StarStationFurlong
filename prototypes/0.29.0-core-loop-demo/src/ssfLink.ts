/**
 * 🔗 SSF links — a film for anyone, from any room, long after it was on
 * (Dorkmo, 2026-10-24: "SSF links only"). Like a magnet, an SSF link
 * carries what finds and checks a file — its BLAKE3 hash, its size, its
 * title and type, and a few nodes that hold it:
 *
 *   ssf://film?h=<64 hex>&s=<bytes>&t=<title>&m=<type>&n=<node id>,<node id>
 *
 * Pasted in any IR blaster's link box and SENT, it asks that page's OWN
 * node to dial those nodes by id (found the way a room dial finds one) and
 * take the file, every byte checked against the hash; the film then goes on
 * the set from that node, as a FILE does (tvUI). A holder serves a file this
 * way only once its page marked it shareable (🔗 SSF LINK in the 📚 LIBRARY,
 * blob_lane.rs `share`), and STOP SHARING ends it. Nothing is seeded to a
 * public swarm and no port is opened: only a node the link reached can ask,
 * and a link names node ids, never an address.
 */

import { sanitizeSource, TV_MAX_TITLE } from './tvDoc';

export interface SsfFilmLink {
  /** The file's BLAKE3 hash, 64 hex digits. */
  hash: string;
  /** Its size in bytes: the node takes no byte past it. */
  size: number;
  title: string;
  /** `video/*` or `audio/*`, else ''. */
  mime: string;
  /** Node ids that hold it, the one that wrote the link first. */
  nodes: string[];
}

/** The most nodes a link names, and a FETCH dials (blob_lane.rs). */
export const SSF_LINK_NODES = 4;

const HEX_64 = /^[0-9a-f]{64}$/;
const PREFIX = /^ssf:\/\/film\?/i;

/** Text that is meant as an SSF film link, whole or not. */
export function isSsfFilmLink(text: string): boolean {
  return /^ssf:\/\/film(?:[?/]|$)/i.test(text.trim());
}

/** A pasted SSF film link, or null when it is not whole: its hash, a size
 *  the TV takes, and at least one node. The rest is shape-checked as a
 *  blob source in the room record is (tvDoc sanitizeSource). */
export function parseSsfLink(text: string): SsfFilmLink | null {
  const t = text.trim();
  if (!PREFIX.test(t)) return null;
  const q = new URLSearchParams(t.slice(t.indexOf('?') + 1));
  const nodes = [...new Set((q.get('n') ?? '').split(',').map((id) => id.trim().toLowerCase()))]
    .filter((id) => HEX_64.test(id))
    .slice(0, SSF_LINK_NODES);
  const s = q.get('s') ?? '';
  // The hash whole, before the record's own check (which cuts a field to
  // its length first): 64 digits and anything after them is no hash.
  const hash = (q.get('h') ?? '').trim().toLowerCase();
  if (!nodes.length || !HEX_64.test(hash) || !/^[1-9]\d{0,15}$/.test(s)) return null;
  const source = sanitizeSource({
    kind: 'blob', hash, size: Number(s), provider: nodes[0], mime: q.get('m') ?? '', title: q.get('t') ?? '',
  });
  if (source?.kind !== 'blob') return null;
  return { hash: source.hash, size: source.size, title: source.title ?? '', mime: source.mime ?? '', nodes };
}

/** The link for a file, naming at most SSF_LINK_NODES nodes. */
export function formatSsfLink(link: SsfFilmLink): string {
  const q = new URLSearchParams({ h: link.hash, s: String(link.size) });
  const title = link.title.trim().slice(0, TV_MAX_TITLE);
  if (title) q.set('t', title);
  if (link.mime) q.set('m', link.mime);
  // Commas left as they are: the node list reads as one, and URLSearchParams
  // takes either back.
  return `ssf://film?${q.toString()}&n=${[...new Set(link.nodes)].filter((id) => HEX_64.test(id)).slice(0, SSF_LINK_NODES).join(',')}`;
}
