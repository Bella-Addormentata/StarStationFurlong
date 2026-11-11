// 📖 LIST ME in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK (stage 4, PR 11 of
// the privacy gate).
//
// A station writes two things into the Phone Book: its listing, once an
// edition, and a knock on a host it holds a card for and cannot reach. On a
// network whose coins are real money neither is paid by the SSF wallet and
// neither names it. Even so a write shows that some Star Station node wrote,
// and when, and the Chia full nodes the station talks to see its IP address.
// So there the station writes neither until its player says so, here. On a
// test network the switch starts on, as the listing always was there, and
// the player can turn it off.
//
// The node keeps the switch per network (`chia_listing.json`), so a LIST ME
// on testnet11 says nothing about mainnet. A turn holds from the publisher's
// next round, within the run. Turned off, nothing more is written; what is
// on the chain already stays there. `SSF_CHIA_FINDABLE=0` in the node's
// environment still holds the listing off whatever the switch says, and Chia
// off on this computer (chiaLane.ts) holds everything off: the node refuses
// an on until Chia is back.
//
// A LIST ME is the player's word for one network on one station node: the
// ones whose warning stood on the page when CONFIRM was tapped. The page
// remembers which those were (`ListMeTarget`), shows CONFIRM only while the
// node that answers is still that node on that network, and sends both with
// the request, which the node refuses if it is another or runs elsewhere
// (started on mainnet at the same port, say, while a testnet11 confirmation
// stood open). An off names neither: it only stops writes.
//
// This module decides what the lines and the button under the PHONE BOOK row
// say, from the node's fingerprint (`chia_listing`, nodeFingerprint.ts) and
// the page's own state, and sends the request, so both are tested without
// main.ts. The row's own value is phoneBook.ts's. The node words its own
// refusals (Chia off, a save that failed); the page only says what it saw
// itself (no answer, a timeout, an older node).

import type { TurnResult } from './bankWallet';
import type { ChiaNetwork } from './chiaNetwork';
import type { LocalFingerprint } from './nodeFingerprint';

/** The switch's id in the Network rows' markup: one button whatever it says,
 *  so focus stays on it from LIST ME to CONFIRM to LISTING. */
export const LIST_ME_BUTTON_ID = 'list-me-switch';

/** How long the page waits for the node's answer: a turn saves one small
 *  file and reads nothing from the chain. */
export const LIST_ME_TIMEOUT_MS = 15_000;

/** The page's own part: LIST ME armed and waiting for CONFIRM, a turn in
 *  flight (`on` or `off`), and the last turn's failure in the page's or the
 *  node's words. */
export interface ListMeUi {
  armed: boolean;
  turning: 'on' | 'off' | null;
  error: string | null;
}

/** What a LIST ME was armed for: the network and the station node whose
 *  warning the player read. */
export interface ListMeTarget {
  /** The network's id, as the node names it (`ChiaNet::id()`). */
  net: string;
  /** The node's iroh node id. */
  node: string;
}

/** What a LIST ME tapped now would be for: none while no node answers, and
 *  none on a network this page does not know, which it cannot name to the
 *  node. */
export function listMeTarget(fp: LocalFingerprint | null | undefined): ListMeTarget | null {
  if (!fp?.chia_net) return null;
  return { net: fp.chia_net.id, node: fp.iroh_node_id ?? '' };
}

/** Whether a LIST ME armed for `armed` still stands: the node that answers
 *  now is the one it was armed on, on the same network. */
export function listMeStands(armed: ListMeTarget | null, fp: LocalFingerprint | null | undefined): boolean {
  const now = listMeTarget(fp);
  return !!armed && !!now && armed.net === now.net && armed.node === now.node;
}

/** Why no LIST ME is offered on a network this page does not know. */
export const LIST_ME_UNKNOWN_NETWORK = 'This page does not know that network, so LIST ME cannot be turned on from it: update Star Station.';

/** The page's refusal of an on with nothing it was confirmed for. */
export const LIST_ME_NOT_CONFIRMED = 'LIST ME was not confirmed for this station node and its network: tap LIST ME again';

/** What the switch does when tapped: `arm` shows CONFIRM, `confirm` turns
 *  LIST ME on, `off` turns it off (no CONFIRM: it only stops writes). */
export type ListMeAct = 'arm' | 'confirm' | 'off';

export interface ListMeRow {
  /** The line under the PHONE BOOK row: what the switch says and means. */
  note: string | null;
  /** What turning LIST ME on makes visible, before CONFIRM. */
  warning: string | null;
  /** Why the last turn failed. */
  error: string | null;
  /** The switch, or none. `busy` marks it inert while a turn is in flight
   *  (it keeps focus, unlike `disabled`). */
  button: { act: ListMeAct; label: string; danger: boolean; busy: boolean } | null;
}

/** The network's name, or words for one this page does not know. */
const where = (net: ChiaNetwork | null): string => net?.name ?? 'the Chia network your node runs on';

/** What a station writes while LIST ME is on, and who can read it. Off a
 *  test network it also says who pays: a key of its own for each write,
 *  funded by the lobby dish, never the SSF wallet. On a test network it
 *  names no payer, since there the SSF wallet may be the one. */
const whatIsWritten = (net: ChiaNetwork | null): string =>
  net && !net.test
    ? 'its Phone Book listing there once an edition (about a week), and a knock on a host it holds a card for and cannot reach, each from a key of its own that the lobby dish pays for, never from your SSF wallet. Only holders of your contact card, and a host your node knocks on, can read your addresses.'
    : 'its Phone Book listing there once an edition (about a week), and a knock on a host it holds a card for and cannot reach. Only holders of your contact card, and a host your node knocks on, can read your addresses.';

export const listMeOnNote = (net: ChiaNetwork | null): string => `LIST ME is on for ${where(net)}: your station writes ${whatIsWritten(net)}`;

/** On, with no SSF wallet on: no publisher runs, so the switch waits. */
export const LIST_ME_NO_WALLET = "Nothing is written until the SSF wallet is on (the SpacePhone's 🏦 BANK).";

/** On, the listing held off by the node's environment, and no SSF wallet
 *  on: the knocks wait for the wallet as every write does. */
export const LIST_ME_HELD_NO_WALLET = "Its knocks are written once the SSF wallet is on (the SpacePhone's 🏦 BANK).";

/** `walletWaits`: no SSF wallet is on, so no publisher runs and no knock is
 *  written yet either. */
export const listMeHeldNote = (net: ChiaNetwork | null, walletWaits = false): string =>
  `LIST ME is on for ${where(net)}, but SSF_CHIA_FINDABLE=0 in your node's environment holds its listing off, and the switch here cannot change that. ${walletWaits ? LIST_ME_HELD_NO_WALLET : 'Its knocks are still written.'}`;

/** Off where the player never turned it: only where the coins are real. */
export const listMeDefaultOffNote = (net: ChiaNetwork | null): string =>
  `LIST ME is off for ${where(net)}, where it starts off: your station writes no Phone Book listing and no knock there until you turn it on here.`;

export const listMeOffNote = (net: ChiaNetwork | null): string =>
  `LIST ME is off for ${where(net)}: your station writes no Phone Book listing and no knock there. What it wrote before stays on the chain; readers stop finding a listing once its edition and the next have passed.`;

export const listMeDamagedNote = (net: ChiaNetwork | null): string =>
  `The saved LIST ME switch could not be read, and a switch that cannot be read counts as off: your station writes no Phone Book listing and no knock on ${where(net)}. Turned on here, it is saved anew.`;

export const listMeChiaOffOnNote = (net: ChiaNetwork | null): string =>
  `LIST ME is on for ${where(net)}, but Chia is off on this computer, so your station writes nothing to the Phone Book until Chia is back on.`;

export const listMeChiaOffNote = (net: ChiaNetwork | null): string =>
  `LIST ME is off for ${where(net)}. It can be turned on once Chia is back on on this computer.`;

/** What a LIST ME shows the world, before CONFIRM. `held`: the node's
 *  environment holds the listing off (`SSF_CHIA_FINDABLE=0`), so a turn on
 *  writes only the knocks, and the warning says so. */
export function listMeWarning(net: ChiaNetwork | null, held = false): string {
  const pays = net && !net.test
    ? ' Each is written from a key of its own that the lobby dish pays for, never from your SSF wallet.'
    : '';
  const wallet = !net || net.test ? ' (on a test network your SSF wallet may pay for a write, which shows its address)' : '';
  const heldOff = held ? " While SSF_CHIA_FINDABLE=0 in your node's environment holds its listing off, only the knocks are written." : '';
  return `List this station in the Phone Book on ${where(net)}? Your node then writes its listing there once an edition (about a week), and a knock on a host it holds a card for and cannot reach.${pays} Only holders of your contact card, and a host your node knocks on, can read your addresses. Anyone can see that some Star Station node wrote, and when${wallet}; the Chia full nodes your node talks to see its IP address; and what is written stays on the chain.${heldOff} Tap CONFIRM.`;
}

/** The turn an act sends: `true` for on, `false` for off, or none (`arm`
 *  only shows CONFIRM). */
export function listMeTurnOf(act: string | undefined): boolean | null {
  switch (act) {
    case 'confirm': return true;
    case 'off': return false;
    default: return null;
  }
}

const NONE: ListMeRow = { note: null, warning: null, error: null, button: null };

/** What stands under the PHONE BOOK row of the Network rows. Nothing while
 *  the node does not answer, and nothing but a failed turn's words for a
 *  node with no switch (an older node, or a build that only reads the
 *  chain): the row itself says why nothing is listed. */
export function listMeRow(fp: LocalFingerprint | null | undefined, ui: ListMeUi): ListMeRow {
  if (!fp) return NONE;
  const error = ui.error ?? null;
  const listing = fp.chia_listing;
  if (!listing) return { ...NONE, error };
  const net = fp.chia_net;
  // While a turn is in flight the button says what it is doing, whatever
  // the fingerprint read meanwhile.
  const busy = ui.turning
    ? { act: 'confirm' as const, label: ui.turning === 'on' ? 'LISTING…' : 'UNLISTING…', danger: false, busy: true }
    : null;
  const row = (note: string, button: ListMeRow['button'], warning: string | null = null): ListMeRow => ({ note, warning, error, button: busy ?? button });
  const unlist: ListMeRow['button'] = { act: 'off', label: 'UNLIST ME', danger: false, busy: false };
  // ⛓️ Chia off on this computer: nothing is written whatever the switch
  // says. An off is still taken; the node refuses an on, so none is offered.
  if (fp.chia_lane?.off) {
    return listing.on ? row(listMeChiaOffOnNote(net), unlist) : row(listMeChiaOffNote(net), null);
  }
  if (listing.on) {
    // No publisher runs until the SSF wallet is on: nothing is written yet,
    // the knocks included where the environment holds the listing off.
    const waits = !!fp.chia_wallet && fp.chia_wallet.state !== 'on';
    if (listing.held) return row(listMeHeldNote(net, waits), unlist);
    return row(listMeOnNote(net) + (waits ? ` ${LIST_ME_NO_WALLET}` : ''), unlist);
  }
  const note = listing.damaged ? listMeDamagedNote(net) : listing.chosen ? listMeOffNote(net) : listMeDefaultOffNote(net);
  // A LIST ME names its network to the node, and this page has no name for
  // one it does not know: none is offered there.
  if (!net) return row(`${note} ${LIST_ME_UNKNOWN_NETWORK}`, null);
  if (ui.armed && !busy) return row(note, { act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false }, listMeWarning(net, listing.held === true));
  return row(note, { act: 'arm', label: 'LIST ME', danger: false, busy: false });
}

/** Ask the node at `origin` to turn LIST ME on or off. An on is for
 *  `target`, the network and the node it was confirmed for, and the node
 *  takes it only if it is that node on that network; an off names nothing
 *  (`target` is not read). Never throws: a refusal comes back in the node's
 *  words, anything else in the page's. */
export async function turnListMe(
  origin: string,
  on: boolean,
  target: ListMeTarget | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = LIST_ME_TIMEOUT_MS,
): Promise<TurnResult> {
  if (!origin) return { ok: false, error: 'your station node is not answering' };
  if (on && !target) return { ok: false, error: LIST_ME_NOT_CONFIRMED };
  const query = on && target ? `on=1&net=${encodeURIComponent(target.net)}&node=${encodeURIComponent(target.node)}` : 'on=0';
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // No redirect: the answer must be the node's own (the fingerprint probe's
    // rule). No body and no custom header: a simple request, no preflight.
    const res = await fetchImpl(`${origin}/api/chia/listing?${query}`, { method: 'POST', signal: ctl.signal, redirect: 'error' });
    if (res.status === 404) {
      return { ok: false, error: 'your station node is older than LIST ME: update Star Station' };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (e) {
      // The deadline can land while the body is read: that is a timeout,
      // worded below, not an answer.
      if (ctl.signal.aborted) throw e;
      // not JSON: worded from the status below
    }
    const r = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (res.ok && r.ok === true) return { ok: true };
    const said = typeof r.error === 'string' && r.error.trim() ? r.error.trim().slice(0, 400) : '';
    return { ok: false, error: said || `your station node answered ${res.status}` };
  } catch {
    return {
      ok: false,
      error: ctl.signal.aborted
        ? `your station node did not answer in time; it may still be turning LIST ME ${on ? 'on' : 'off'}, so look again in a moment`
        : 'your station node could not be reached',
    };
  } finally {
    clearTimeout(deadline);
  }
}
