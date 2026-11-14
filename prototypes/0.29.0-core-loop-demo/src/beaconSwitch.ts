// 🔦 The BEACON row in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK (#231 D7).
//
// Every newcomer starts at the welcome room, so the welcome room needs more
// doors than the one computer its bundled pass names. A beacon is such a
// door: once an edition (about a week) a node that can be reached from
// outside and serves the welcome room writes its node id in the clear, under
// a tag anyone can compute, and a newcomer whose game has nobody else to
// load the welcome room from reads those ids and dials them.
//
// That makes a lit beacon a public line in a weekly list of nodes, so it is
// the player's choice (D7 keeps the role opt-in): out on every network until
// they light it here, after a warning that says what a beacon shows. Until
// this switch the only way in was `SSF_CHIA_BEACON=1` in the node's
// environment, which a player of the desktop app never sees.
//
// The node keeps the switch per network (`chia_beacon.json`), so a beacon
// lit on testnet11 says nothing about mainnet. A turn holds from the
// publisher's next round, within the run. Put out, no more beacons are
// written; one already written stays on the chain. The node's environment
// still decides first: `SSF_CHIA_BEACON=1` holds the beacon lit and any
// other value holds it out, whatever the switch says, and Chia off on this
// computer (chiaLane.ts) holds everything off.
//
// Lighting is the player's word for one network on one node, the ones whose
// warning stood on the page at CONFIRM, as a LIST ME is (listMe.ts): the
// page remembers which those were, shows CONFIRM only while the node that
// answers is still that node on that network, and sends both with the
// request. Putting out names neither: it only stops writes.
//
// A lit switch says the beacon may be written, not that it is. The node
// sends what its publisher found at its last look (`status`), and the row
// says it: sent, read back from the chain, or what it still waits for.
//
// This module decides what the row, its lines and its button say, from the
// node's fingerprint (`chia_beacon`, nodeFingerprint.ts) and the page's own
// state, and sends the request, so both are tested without main.ts. The
// node words its own refusals; the page only says what it saw itself.

import type { TurnResult } from './bankWallet';
import { LANE_NO_NODE_COLOUR, LANE_OFF_COLOUR, LANE_ON_COLOUR, LANE_UNKNOWN_COLOUR } from './chiaLane';
import type { ChiaNetwork } from './chiaNetwork';
import { listMeStands, listMeTarget, type ListMeTarget } from './listMe';
import type { ChiaBeaconStatus, LocalFingerprint } from './nodeFingerprint';

/** The switch's id in the Network rows' markup: one button whatever it says,
 *  so focus stays on it from LIGHT BEACON to CONFIRM to LIGHTING. */
export const BEACON_BUTTON_ID = 'beacon-switch';

/** How long the page waits for the node's answer: a turn saves one small
 *  file and reads nothing from the chain. */
export const BEACON_TIMEOUT_MS = 15_000;

/** The page's own part: LIGHT BEACON armed and waiting for CONFIRM, a turn
 *  in flight, and the last turn's failure in the page's or the node's
 *  words. */
export interface BeaconUi {
  armed: boolean;
  turning: 'on' | 'off' | null;
  error: string | null;
}

/** What a beacon was armed for: the network and the node whose warning the
 *  player read. The same pair a LIST ME names. */
export type BeaconTarget = ListMeTarget;

/** What a LIGHT BEACON tapped now would be for: none while no node answers,
 *  and none on a network this page does not know. */
export const beaconTarget = (fp: LocalFingerprint | null | undefined): BeaconTarget | null => listMeTarget(fp);

/** Whether a beacon armed for `armed` still stands: the node that answers
 *  now is the one it was armed on, on the same network. */
export const beaconStands = (armed: BeaconTarget | null, fp: LocalFingerprint | null | undefined): boolean => listMeStands(armed, fp);

/** What the switch does when tapped: `arm` shows CONFIRM, `confirm` lights
 *  the beacon, `off` puts it out (no CONFIRM: it only stops writes). */
export type BeaconAct = 'arm' | 'confirm' | 'off';

export interface BeaconRow {
  /** The row's value, beside its BEACON label. */
  value: string;
  colour: string;
  /** The line under the row: what the switch says and what it waits for. */
  note: string | null;
  /** What a lit beacon shows the world, before CONFIRM. */
  warning: string | null;
  /** Why the last turn failed. */
  error: string | null;
  /** The switch, or none. `busy` marks it inert while a turn is in flight
   *  (it keeps focus, unlike `disabled`). */
  button: { act: BeaconAct; label: string; danger: boolean; busy: boolean } | null;
}

/** The network's name, or words for one this page does not know. */
const where = (net: ChiaNetwork | null): string => net?.name ?? 'the Chia network your node runs on';

/** A node older than the switch, or a build that only reads the chain. */
export const BEACON_NO_SWITCH = 'Your node has no beacon switch: it is older than the switch, or it is a build that only reads the chain.';

/** Why no beacon can be lit on a network this page does not know. */
export const BEACON_UNKNOWN_NETWORK = 'This page does not know that network, so a beacon cannot be lit from it: update Star Station.';

/** The page's refusal of an on with nothing it was confirmed for. */
export const BEACON_NOT_CONFIRMED = 'The beacon was not confirmed for this node and its network: tap LIGHT BEACON again';

/** What a beacon is for, in one sentence the notes share. */
const WHAT_FOR = "when a new player's game has nobody else to load the welcome room from, it dials your node";

/** Out where the player never turned it: every network. */
export const beaconDefaultOutNote = (net: ChiaNetwork | null): string =>
  `The beacon is out for ${where(net)}, where it starts out. Lit, your node becomes a public door into the welcome room: ${WHAT_FOR}.`;

export const beaconOutNote = (net: ChiaNetwork | null): string =>
  `The beacon is out for ${where(net)}: your node starts no new beacon there. One it wrote before stays on the chain, and one already sent when it was put out may still land there; readers stop finding it once its edition and the next have passed.`;

export const beaconDamagedNote = (net: ChiaNetwork | null): string =>
  `The saved beacon switch could not be read, and a switch that cannot be read counts as off: your node writes no beacon on ${where(net)}. Lit here, it is saved anew.`;

/** Out, and the node's environment holds it out. */
export const beaconHeldOutNote = (net: ChiaNetwork | null): string =>
  `SSF_CHIA_BEACON in your node's environment holds the beacon out for ${where(net)}, and the switch here cannot light it.`;

/** Lit by the player: `state` is what the publisher found (`beaconState`). */
export const beaconLitNote = (net: ChiaNetwork | null, state: string): string =>
  `The beacon is lit for ${where(net)}. Your node is a public door into the welcome room: ${WHAT_FOR}. ${state}`;

/** Lit, and the node's environment holds it lit. */
export const beaconHeldLitNote = (net: ChiaNetwork | null, state: string): string =>
  `SSF_CHIA_BEACON=1 in your node's environment holds the beacon lit for ${where(net)}, and the switch here cannot put it out. ${state}`;

export const beaconChiaOffLitNote = (net: ChiaNetwork | null): string =>
  `The beacon is lit for ${where(net)}, but Chia is off on this computer, so your node writes no beacon until Chia is back on.`;

export const beaconChiaOffNote = (net: ChiaNetwork | null): string =>
  `The beacon is out for ${where(net)}. It can be lit once Chia is back on on this computer.`;

/** Lit, with no SSF wallet on: no publisher runs, so the beacon waits. */
export const BEACON_NO_WALLET = "No beacon is written until the SSF wallet is on (the SpacePhone's 🏦 BANK): it pays for no beacon, but your node writes to the chain only while it is on.";

/** Lit, the wallet on, and the publisher has not looked yet. */
export const BEACON_NOT_LOOKED = 'Your node has not looked at this edition yet.';

export const BEACON_ON_CHAIN = "This edition's beacon is on the chain.";

export const BEACON_SENT = "This edition's beacon is sent, and your node waits to read it back from the chain.";

/** Both conditions hold and nothing is sent: the node's turn in the edition
 *  has not come, or the lobby dish has not paid yet. */
export const BEACON_AT_ITS_TURN = 'No beacon is written yet this edition: your node writes it at its turn in the edition, from a key of its own that the lobby dish pays for.';

/** Why nothing is written while a condition is missing. */
export function beaconWaitsFor(status: Pick<ChiaBeaconStatus, 'reachable' | 'serves_welcome'>): string {
  const lacks: string[] = [];
  if (!status.reachable) lacks.push('it has not taken a direct connection from outside in this edition');
  if (!status.serves_welcome) lacks.push('it is not serving the welcome room now');
  if (!lacks.length) return BEACON_AT_ITS_TURN;
  return `No beacon is written yet this edition: ${lacks.join(', and ')}. A beacon that leads nowhere helps nobody, so your node writes one only while it can be reached and serves the welcome room.`;
}

/** What a lit beacon is doing, as the row's value and the note's last
 *  sentence, from the wallet and the publisher's last look. */
export function beaconState(fp: LocalFingerprint): { value: string; colour: string; words: string } {
  const waiting = (words: string) => ({ value: 'WAITING', colour: LANE_OFF_COLOUR, words });
  if (fp.chia_wallet && fp.chia_wallet.state !== 'on') return waiting(BEACON_NO_WALLET);
  const status = fp.chia_beacon?.status;
  if (!status) return waiting(BEACON_NOT_LOOKED);
  if (status.confirmed) return { value: 'ON THE CHAIN', colour: LANE_ON_COLOUR, words: BEACON_ON_CHAIN };
  if (status.sent) return { value: 'SENT', colour: LANE_ON_COLOUR, words: BEACON_SENT };
  return waiting(beaconWaitsFor(status));
}

/** What a lit beacon shows the world, before CONFIRM. */
export function beaconWarning(net: ChiaNetwork | null): string {
  return `Light a beacon on ${where(net)}? Once an edition (about a week), while your node can be reached from outside and serves the welcome room, it writes its node id in the clear where anyone can read it, from a key of its own that the lobby dish pays for, never from your SSF wallet. Anyone can then list the nodes that lit a beacon that week and look up this node's network addresses from its id; new players' games dial it to load the welcome room; and the Chia full nodes your node talks to see its IP address. Your node writes the same id on every Chia network, so one that lights a beacon on two of them can be linked across them. Putting the beacon out stops new ones; what is written stays on the chain, and a beacon already sent when you put it out may still land there. Tap CONFIRM.`;
}

/** The turn an act sends: `true` to light, `false` to put out, or none
 *  (`arm` only shows CONFIRM). */
export function beaconTurnOf(act: string | undefined): boolean | null {
  switch (act) {
    case 'confirm': return true;
    case 'off': return false;
    default: return null;
  }
}

/** The BEACON row of the Network rows and what stands under it. */
export function beaconRow(fp: LocalFingerprint | null | undefined, ui: BeaconUi): BeaconRow {
  if (!fp) return { value: 'NO NODE', colour: LANE_NO_NODE_COLOUR, note: null, warning: null, error: null, button: null };
  const error = ui.error ?? null;
  const beacon = fp.chia_beacon;
  if (!beacon) return { value: 'NO SWITCH', colour: LANE_UNKNOWN_COLOUR, note: BEACON_NO_SWITCH, warning: null, error, button: null };
  const net = fp.chia_net;
  // While a turn is in flight the button says what it is doing, whatever
  // the fingerprint read meanwhile.
  const busy = ui.turning
    ? { act: 'confirm' as const, label: ui.turning === 'on' ? 'LIGHTING…' : 'PUTTING OUT…', danger: false, busy: true }
    : null;
  const row = (value: string, colour: string, note: string, button: BeaconRow['button'], warning: string | null = null): BeaconRow =>
    ({ value, colour, note, warning, error, button: busy ?? button });
  const out = (note: string, button: BeaconRow['button'], warning: string | null = null): BeaconRow => row('OUT', LANE_UNKNOWN_COLOUR, note, button, warning);
  const putOut: BeaconRow['button'] = { act: 'off', label: 'PUT OUT', danger: false, busy: false };
  // ⛓️ Chia off on this computer: nothing is written whatever the switch
  // says. An off is still taken, unless the environment holds the beacon
  // lit; the node refuses an on, so none is offered.
  if (fp.chia_lane?.off) {
    return beacon.on ? row('WAITING', LANE_OFF_COLOUR, beaconChiaOffLitNote(net), beacon.held ? null : putOut) : out(beaconChiaOffNote(net), null);
  }
  if (beacon.on) {
    const state = beaconState(fp);
    return beacon.held
      ? row(state.value, state.colour, beaconHeldLitNote(net, state.words), null)
      : row(state.value, state.colour, beaconLitNote(net, state.words), putOut);
  }
  if (beacon.held) return out(beaconHeldOutNote(net), null);
  const note = beacon.damaged ? beaconDamagedNote(net) : beacon.chosen ? beaconOutNote(net) : beaconDefaultOutNote(net);
  // Lighting names its network to the node, and this page has no name for
  // one it does not know: none is offered there.
  if (!net) return out(`${note} ${BEACON_UNKNOWN_NETWORK}`, null);
  if (ui.armed && !busy) return out(note, { act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false }, beaconWarning(net));
  return out(note, { act: 'arm', label: 'LIGHT BEACON', danger: false, busy: false });
}

/** Ask the node at `origin` to light the beacon or put it out. Lighting is
 *  for `target`, the network and the node it was confirmed for, and the node
 *  takes it only if it is that node on that network; putting out names
 *  nothing (`target` is not read). Never throws: a refusal comes back in the
 *  node's words, anything else in the page's. */
export async function turnBeacon(
  origin: string,
  on: boolean,
  target: BeaconTarget | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = BEACON_TIMEOUT_MS,
): Promise<TurnResult> {
  if (!origin) return { ok: false, error: 'your node is not answering' };
  if (on && !target) return { ok: false, error: BEACON_NOT_CONFIRMED };
  const query = on && target ? `on=1&net=${encodeURIComponent(target.net)}&node=${encodeURIComponent(target.node)}` : 'on=0';
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // No redirect: the answer must be the node's own (the fingerprint probe's
    // rule). No body and no custom header: a simple request, no preflight.
    const res = await fetchImpl(`${origin}/api/chia/beacon?${query}`, { method: 'POST', signal: ctl.signal, redirect: 'error' });
    if (res.status === 404) {
      return { ok: false, error: 'your node is older than the beacon switch: update Star Station' };
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
    return { ok: false, error: said || `your node answered ${res.status}` };
  } catch {
    return {
      ok: false,
      error: ctl.signal.aborted
        ? `your node did not answer in time; it may still be ${on ? 'lighting the beacon' : 'putting the beacon out'}, so look again in a moment`
        : 'your node could not be reached',
    };
  } finally {
    clearTimeout(deadline);
  }
}
