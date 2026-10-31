/**
 * 📖 The Phone Book icon in the SpacePhone's top bar: is this node's latest
 * connection information listed on Chia?
 *
 * The node publishes one presence record per era (an "edition" of the Phone
 * Book, about a week of blocks) carrying its public addresses, and tells this
 * page how that listing stands through the loopback fingerprint
 * (`chia_presence`, nodeFingerprint.ts), refreshed each minute. This module
 * turns that readout into the icon: a custom phone book glyph, GREEN when the
 * current addresses are listed, GREY when the node once stood in the book but
 * the listing is out of date (a new edition, changed addresses, no chain peak
 * to judge by). Filled means the listing is confirmed on chain or stale for
 * sure; an outline means the listing is on its way (sent, or not yet written).
 *
 * Nothing here is drawn per frame: the fingerprint poll drives it.
 */
import type { ChiaPresence, ChiaPresenceState, LocalFingerprint } from './nodeFingerprint';

/** The two colours Dorkmo asked for: green for a current listing, grey for a
 *  stale one (and for none yet). The grey sits a little above the signal bars'
 *  idle rungs so the glyph stays legible on the bar's dark background. */
export const PHONE_BOOK_GREEN = '#00e676';
export const PHONE_BOOK_GREY = 'rgba(224, 226, 238, 0.45)';

/** How the publisher paces itself, in the words the tooltip uses: a changed
 *  address set is written after a ten-minute debounce, and a sent listing is
 *  retried when the chain has not shown it back within thirty minutes
 *  (chia_publish.rs: ADDR_CHANGE_DEBOUNCE_SECS, PRESENCE_CONFIRM_TIMEOUT_SECS). */
const DEBOUNCE_MIN = 10;
const CONFIRM_MIN = 30;

/** The longest node text the tooltip repeats; the node's own log has the rest. */
const ERROR_MAX = 160;

export interface PhoneBookIndicator {
  /** Draw the icon at all: the node publishes presence and has reported once. */
  visible: boolean;
  state: ChiaPresenceState | null;
  colour: string;
  /** A solid book (listed, outdated) or an outline (sent, unlisted). */
  filled: boolean;
  /** The tooltip and accessible name, one line. The node's own words (the
   *  last failed attempt, a spent write budget) follow a `·` when it has any. */
  title: string;
  /** Where a tap goes: the Bank app when the listing fails for want of a
   *  coin (its RECEIVE section is the fix), else the Network rows. */
  opens: 'bank' | 'setnet' | null;
}

const HIDDEN: PhoneBookIndicator = { visible: false, state: null, colour: PHONE_BOOK_GREY, filled: false, title: '', opens: null };

/** The icon for a fingerprint round, or hidden when the node does not publish
 *  presence (a read-only build, no wallet, `SSF_CHIA_FINDABLE=0`, no durable
 *  contact key) or has not answered yet. */
export function phoneBookIndicator(fp: LocalFingerprint | null | undefined): PhoneBookIndicator {
  const p = fp?.chia_presence;
  if (!p) return HIDDEN;
  const error = trimError(p.error);
  const opens: PhoneBookIndicator['opens'] = /unfunded/i.test(error ?? '') ? 'bank' : 'setnet';
  switch (p.state) {
    case 'listed':
      return { visible: true, state: p.state, colour: PHONE_BOOK_GREEN, filled: true, title: listedTitle(p), opens };
    case 'sent':
      return {
        visible: true,
        state: p.state,
        colour: PHONE_BOOK_GREEN,
        filled: false,
        title: `Listing sent to the Phone Book, awaiting confirmation (up to ${CONFIRM_MIN} min)` + (error ? ` · ${error}` : ''),
        opens,
      };
    case 'outdated':
      return {
        visible: true,
        state: p.state,
        colour: PHONE_BOOK_GREY,
        filled: true,
        title: `Phone Book listing outdated: ${outdatedReason(p, error)}`,
        opens,
      };
    case 'unlisted':
      return {
        visible: true,
        state: p.state,
        colour: PHONE_BOOK_GREY,
        filled: false,
        title: 'Not in the Phone Book yet: ' + (error ?? (p.era === 0 ? 'waiting for a chain peak to date the edition' : 'the first listing goes out shortly')),
        opens,
      };
  }
}

function listedTitle(p: ChiaPresence): string {
  const n = p.public_addrs;
  const addrs = n === 0
    ? 'your node has no public address right now, and the book says so'
    : n === 1
      ? "your node's public address is on chain"
      : `your node's ${n} public addresses are on chain`;
  return `Listed in this week's Phone Book: ${addrs} (edition ${p.era})`;
}

/** Why the listing is stale, and what happens next: the publisher's promise
 *  when the node reports nothing in the way, else the node's own words. */
function outdatedReason(p: ChiaPresence, error: string | undefined): string {
  if (p.era === 0) return "no chain peak agreed yet, so this week's edition is unknown" + (error ? ` · ${error}` : '');
  if (p.listed_era !== p.era) {
    return `it is from edition ${p.listed_era} and this is edition ${p.era}` + (error ? ` · ${error}` : '; the new listing goes out shortly');
  }
  return 'your addresses changed' + (error ? ` · ${error}` : `; the new listing goes out within ${DEBOUNCE_MIN} min`);
}

function trimError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const flat = error.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > ERROR_MAX ? flat.slice(0, ERROR_MAX - 1) + '…' : flat;
}

/** The custom phone book glyph: a closed book with its spine and two lines of
 *  listings on the cover, in `colour`, solid or outlined. A 16-unit square the
 *  status bar sizes with CSS; the strokes stay legible down to 12 px. The
 *  `aria-hidden` is right because the button carrying it has the label. */
export function phoneBookIconSvg(colour: string, filled: boolean): string {
  const cover = 'M3.5 2h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2z';
  const spine = 'M5.5 2v12';
  const lines = 'M8 6h3.5M8 8.5h3.5';
  const ink = filled ? 'rgba(8, 12, 30, 0.75)' : colour;
  const body = filled
    ? `<path d="${cover}" fill="${colour}"/>`
    : `<path d="${cover}" fill="none" stroke="${colour}" stroke-width="1.3"/>`;
  return `<svg viewBox="0 0 16 16" width="100%" height="100%" aria-hidden="true" focusable="false">`
    + body
    + `<path d="${spine}" stroke="${ink}" stroke-width="1.3"/>`
    + `<path d="${lines}" stroke="${ink}" stroke-width="1.1" stroke-linecap="round"/>`
    + `</svg>`;
}
