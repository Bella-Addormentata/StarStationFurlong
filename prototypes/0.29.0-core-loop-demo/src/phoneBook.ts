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
import { chiaOffWhy } from './chiaLane';
import type { ChiaNetwork } from './chiaNetwork';
import type { ChiaLane, ChiaListing, ChiaPresence, ChiaPresenceState, LocalFingerprint } from './nodeFingerprint';

/** The two colours Dorkmo asked for: green for a current listing, grey for a
 *  stale one (and for none yet). The grey sits a little above the signal bars'
 *  idle rungs so the glyph stays legible on the bar's dark background. */
export const PHONE_BOOK_GREEN = '#00e676';
export const PHONE_BOOK_GREY = 'rgba(224, 226, 238, 0.45)';

/** How the publisher paces itself, in the words the tooltip uses: a changed
 *  address set is written after a ten-minute debounce, and a sent listing is
 *  written again when the chain has not shown it back within thirty minutes
 *  (chia_publish.rs: ADDR_CHANGE_DEBOUNCE_SECS, PRESENCE_CONFIRM_TIMEOUT_SECS).
 *  Neither is a promise about the chain: they say what the node does next. */
const DEBOUNCE_MIN = 10;
const CONFIRM_MIN = 30;

/** The longest node text the tooltip repeats; the node's own log has the
 *  rest. The node's longest sentences of its own fit whole: the pause for
 *  another copy of this station (foreign_pause.rs PAUSED_TWO_HOURS_WORDS and
 *  PAUSED_NEXT_EDITION_WORDS, 163 and 170 characters), whose last words say
 *  when the station tries again. */
const ERROR_MAX = 180;

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
  /** The PHONE BOOK row of the Network rows: the same readout in words, for
   *  whoever reads the rows rather than the bar (keyboard and screen-reader
   *  users among them), and the reason when there is no icon at all. */
  row: { value: string; colour: string };
}

/** The row's grey. The icon's grey is for a 12 px glyph; as 12 px text on
 *  the panel's dark background it falls short of the 4.5:1 contrast the row
 *  needs, so grey rows (outdated, unlisted, none published) use this one. */
const ROW_GREY = 'rgba(224, 226, 238, 0.6)';
const ROW_RED = '#ff1744';

const NO_NODE: PhoneBookIndicator = {
  visible: false, state: null, colour: PHONE_BOOK_GREY, filled: false, title: '', opens: null,
  row: { value: 'NO NODE', colour: ROW_RED },
};
const notPublished = (value: string): PhoneBookIndicator => ({ ...NO_NODE, row: { value, colour: ROW_GREY } });
const NOT_PUBLISHED = notPublished('OFF — this node does not publish presence (a read-only build, no SSF wallet, or SSF_CHIA_FINDABLE=0)');
/** 🏦 The SSF wallet switch says why, when it is the reason (bankWallet.ts). */
const WALLET_NOT_ON = notPublished("OFF — this node's SSF wallet is not on yet (turn it on in the SpacePhone's 🏦 BANK)");
/** 🛑 Off a test network a node older than LIST ME writes no listing: the
 *  SSF wallet pays for no chain write there (stage 4 design §4.5 (1)), and
 *  the keys that do are opened by a switch it does not have. So turning the
 *  wallet on in the Bank lists nothing: the row says so instead of sending
 *  the player there. */
const olderThanListMe = (net: ChiaNetwork): PhoneBookIndicator =>
  notPublished(`OFF — on ${net.name} this node writes no Phone Book listing: it is older than LIST ME (update Star Station)`);
/** 📖 LIST ME is off (listMe.ts): the node writes no listing and no knock on
 *  its network, whatever its wallet does. The switch stands under this row,
 *  so the row says why and points at it. */
const listMeIsOff = (net: ChiaNetwork | null, listing: ChiaListing): PhoneBookIndicator => {
  const on = net ? ` on ${net.name}` : '';
  if (listing.damaged) {
    return notPublished(`OFF — the saved LIST ME switch could not be read, which counts as off: this node writes no listing and no knock${on} (LIST ME, below, saves it anew)`);
  }
  if (listing.chosen) return notPublished(`OFF — LIST ME is off${net ? ` for ${net.name}` : ''}: this node writes no listing and no knock there (LIST ME, below, turns it on)`);
  return notPublished(`OFF — LIST ME is off${net ? ` for ${net.name}, where it starts off` : ''}: this node writes no listing and no knock there until you turn it on (LIST ME, below)`);
};
/** 📖 LIST ME on, the listing held off by the node's environment. */
const FINDABLE_HELD_OFF = notPublished("OFF — SSF_CHIA_FINDABLE=0 in the node's environment holds its listing off (LIST ME is on, so its knocks are still written)");
const WALLET_HELD_OFF = notPublished("OFF — SSF_CHIA_LANE in the node's environment holds its SSF wallet off");
const READ_ONLY_BUILD = notPublished('OFF — this build of the node only reads the chain');
/** ⛓️ Chia off on this computer (chiaLane.ts): the node reads and writes no
 *  listing at all, whatever readout it kept from before an in-run off. */
const chiaIsOff = (lane: ChiaLane): PhoneBookIndicator =>
  notPublished(`OFF — ${chiaOffWhy(lane)}, so this node neither reads nor writes the Phone Book`);
/** On, with no listing reported yet: the publisher's first round runs about a
 *  minute after the wallet turns on, and a node that is not findable never
 *  reports one. */
const WALLET_ON_UNREPORTED = notPublished("Not in the Phone Book yet — the SSF wallet is on, and the node checks its listing within a minute or two (it never lists itself with SSF_CHIA_FINDABLE=0 or without a durable contact key)");

/** The icon for a fingerprint round. Hidden, with the row saying why, when
 *  the node did not answer this round (`null`: a cached green must not
 *  outlive the node), when Chia is off on this computer or LIST ME is off
 *  for the node's network (a listing the node reported before an in-run off
 *  is no longer kept up), or when the node does not publish presence at all
 *  (a read-only build, no wallet, `SSF_CHIA_FINDABLE=0`, no durable contact
 *  key, or a node older than LIST ME off a test network). */
export function phoneBookIndicator(fp: LocalFingerprint | null | undefined): PhoneBookIndicator {
  if (!fp) return NO_NODE;
  if (fp.chia_lane?.off) return chiaIsOff(fp.chia_lane);
  const listing = fp.chia_listing;
  const state = fp.chia_wallet?.state;
  // 📖 LIST ME off: the switch's word is the newest there is. A readout the
  // node still carries from before the turn (it drops it at its publisher's
  // next round) is of a listing it no longer keeps up. A wallet the
  // environment holds off, or a build with none, is said first: turning
  // LIST ME on would change nothing there.
  const listed = !listing || listing.on;
  const p = listed ? fp.chia_presence : undefined;
  if (!p) {
    if (state === 'off') return WALLET_HELD_OFF;
    if (state === 'unbuilt') return READ_ONLY_BUILD;
    if (listing && !listing.on) return listMeIsOff(fp.chia_net, listing);
    // A node with no LIST ME, off a test network: it writes no listing there
    // whatever its wallet does.
    if (!listing && fp.chia_net && !fp.chia_net.test) return olderThanListMe(fp.chia_net);
    switch (state) {
      case 'ready': return WALLET_NOT_ON;
      // The node never reports a listing it is told not to keep.
      case 'on': return listing?.held ? FINDABLE_HELD_OFF : WALLET_ON_UNREPORTED;
      default: return NOT_PUBLISHED;
    }
  }
  const error = trimError(p.error);
  const opens: PhoneBookIndicator['opens'] = /unfunded/i.test(error ?? '') ? 'bank' : 'setnet';
  const shown = (colour: string, filled: boolean, title: string): PhoneBookIndicator =>
    ({ visible: true, state: p.state, colour, filled, title, opens, row: { value: title, colour: colour === PHONE_BOOK_GREY ? ROW_GREY : colour } });
  switch (p.state) {
    case 'listed':
      // A listing back in force (the addresses changed and changed back) can
      // carry the failed attempt in between: the node keeps that text until a
      // write succeeds, and it is the reason a tap goes to the Bank app. Last
      // week's listing held in force while this week's waits for its slot
      // carries the node's words for when this week's goes out.
      return shown(PHONE_BOOK_GREEN, true, listedTitle(p) + (error ? ` · ${error}` : ''));
    case 'sent':
      // What the node does if the chain stays silent, not how long the chain
      // takes: a zero-fee spend can wait longer, and a node with the watcher
      // off says so in its own words instead.
      return shown(
        PHONE_BOOK_GREEN,
        false,
        'Listing sent to the Phone Book, awaiting confirmation from the chain'
          + (error ? ` · ${error}` : ` (the node writes it again if none comes within ${CONFIRM_MIN} min)`),
      );
    case 'outdated':
      return shown(PHONE_BOOK_GREY, true, `Phone Book listing outdated: ${outdatedReason(p, error)}`);
    case 'unlisted':
      return shown(
        PHONE_BOOK_GREY,
        false,
        'Not in the Phone Book yet: ' + (error ?? (p.era === 0 ? 'waiting for a chain peak to date the edition' : 'the first listing goes out shortly')),
      );
  }
}

/** The listed title names the edition the listing is in. With burner keys
 *  on (always off a test network, and on one unless the node was started
 *  with SSF_CHIA_BURNERS=0; stage 4 design §4.3), a node
 *  keeps last week's listing listed while this week's waits for its slot or
 *  its late start: readers scan this edition and the one before, so last
 *  week's is the listing they find. The node then sends `listed_era` as the
 *  edition before `era`, edition 0 included. A node that pays from its SSF
 *  wallet never does, so its title is this week's, as is any other edition
 *  a readout names. */
function listedTitle(p: ChiaPresence): string {
  const n = p.public_addrs;
  const addrs = n === 0
    ? 'your node has no public address right now, and the book says so'
    : n === 1
      ? "your node's public address is on chain"
      : `your node's ${n} public addresses are on chain`;
  if (p.era > 0 && p.listed_era === p.era - 1) return `Listed in last week's Phone Book: ${addrs} (edition ${p.listed_era})`;
  return `Listed in this week's Phone Book: ${addrs} (edition ${p.era})`;
}

/** Why the listing is stale, and what happens next: the publisher's promise
 *  when the node reports nothing in the way, else the node's own words. A
 *  listing of this edition with these addresses that did not make it into
 *  the book, held by the hint rule until the next edition (`unlanded`), has
 *  only the node's words: neither its edition nor its addresses changed. A
 *  node that writes its listing from burner keys says in its own words what
 *  its listing waits for: when this edition's goes out (at a random time in
 *  its first day, within about an hour, or within about 20 minutes of a
 *  change), that the chain is busy or the lobby dish has no mojo ready (and,
 *  where it holds, that last week's listing still works), or that the hint
 *  rule holds a rewrite until the next edition. The promise shows only when
 *  the node reports nothing in the way, which on that path means the write
 *  is due now. */
function outdatedReason(p: ChiaPresence, error: string | undefined): string {
  if (p.unlanded) return error ?? "this edition's listing did not make it into the book";
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
