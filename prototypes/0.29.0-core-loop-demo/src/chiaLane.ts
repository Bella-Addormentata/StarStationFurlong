// ⛓️ The Chia switch in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK (stage 4,
// PR 4 of the privacy gate).
//
// Desktop players never set environment variables, so `SSF_NO_CHIA_LANE` has
// an in-game form: the CHIA row of the Network rows turns Chia off on this
// computer, on every Chia network at once. Off takes effect at once (the node
// closes every connection to a Chia full node, answers once it has, and makes
// none from then on) and holds at every start until it is turned back on
// here; back on takes effect at the node's next start, never within a run. The
// node keeps the switch in `chia_lane_off.json` at its data root, and a file
// it cannot read counts as off. `SSF_NO_CHIA_LANE` in the node's environment
// holds Chia off whatever the switch says, and the switch cannot turn it on.
//
// This module decides what the row says and offers, from the node's
// fingerprint (`chia_lane`, nodeFingerprint.ts) and the page's own state, and
// sends the request, so both are tested without main.ts. It also words why
// Chia is off for the Bank (bankWallet.ts), the Phone Book row (phoneBook.ts)
// and the faucet dish (devices.ts). The node words its own refusals (the
// environment holding Chia off, a save that failed); the page only says what
// it saw itself (no answer, a timeout, an older node).

import type { TurnResult } from './bankWallet';
import type { ChiaLane, LocalFingerprint } from './nodeFingerprint';

/** The switch's id in the Network rows' markup: one button whatever it says,
 *  so focus stays on it from TURN CHIA OFF to CONFIRM to TURNING CHIA OFF. */
export const CHIA_LANE_BUTTON_ID = 'chia-lane-switch';

/** How long the page waits for the node's answer. An off answers once the
 *  lane is closed, which waits for a Chia request under way and for a turn
 *  of the SSF wallet under way to end: the wallet switch's wait. */
export const LANE_TURN_TIMEOUT_MS = 45_000;

/** What a turn asks the node: `off` turns Chia off now (after CONFIRM),
 *  `keep` saves the switch off while Chia is already off this run, `on`
 *  turns the switch back on for the next start. `off` and `keep` are both
 *  the node's `on=0`; they differ only in what the button says meanwhile. */
export type ChiaLaneTurn = 'off' | 'keep' | 'on';

/** The page's own part: TURN CHIA OFF armed and waiting for CONFIRM, a turn
 *  in flight, and the last turn's failure in the page's or the node's words. */
export interface ChiaLaneUi {
  armed: boolean;
  turning: ChiaLaneTurn | null;
  error: string | null;
}

/** What the switch does when tapped: `arm` shows CONFIRM, and the others
 *  send their turn (`laneTurnOf`). */
export type ChiaLaneAct = 'arm' | 'confirm' | 'keep' | 'on';

export interface ChiaLaneRow {
  /** The row's value, beside its CHIA label. */
  value: string;
  colour: string;
  /** The line under the row: what the state means and why. */
  note: string | null;
  /** What turning Chia off means, before CONFIRM. */
  warning: string | null;
  /** Why the last turn failed. */
  error: string | null;
  /** The switch, or none. `busy` marks it inert while a turn is in flight
   *  (it keeps focus, unlike `disabled`). */
  button: { act: ChiaLaneAct; label: string; danger: boolean; busy: boolean } | null;
}

export const LANE_ON_COLOUR = '#00e676';
export const LANE_OFF_COLOUR = '#ffb300';
/** The Phone Book row's text grey (phoneBook.ts ROW_GREY): 4.5:1 on the panel. */
export const LANE_UNKNOWN_COLOUR = 'rgba(224, 226, 238, 0.6)';
export const LANE_NO_NODE_COLOUR = '#ff1744';

/** Where the switch is, in the words the other apps use to send the player
 *  there. */
export const LANE_WHERE = "the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK";

/** A node with the strict lane but not the switch, or with neither. */
export const LANE_OLDER_NODE = 'Your station node is older than this switch: update Star Station to turn Chia off here.';

export const LANE_ON_NOTE =
  'Nothing holds Chia off on this computer. Turned off here, your node stops reading and writing the Chia chain at once, on every Chia network, and Chia stays off at every start until it is turned back on here.';
/** On now, with the switch saved off: the node holds Chia off a moment
 *  later in the same turn, so this shows only between the two. */
export const LANE_SAVING_NOTE = 'The switch here is saved off, so Chia goes off on this computer and stays off at every start until it is turned back on here.';
export const LANE_ARMED_WARNING =
  'Turn Chia off on this computer? Your node closes every connection to a Chia full node at once and makes none from then on, on every Chia network: no Phone Book, no knocks, no faucet dish, and an SSF wallet that is on writes nothing to the chain. Turning Chia back on here takes effect at your node\'s next start. Tap CONFIRM.';
export const LANE_SETTING_OFF_NOTE =
  'Turned off here: your node reads and writes nothing on the Chia chain, on any Chia network, and Chia stays off at every start until it is turned back on here. Turned back on, it comes on at your node\'s next start.';
export const LANE_DAMAGED_NOTE =
  'The saved switch could not be read, and a switch that cannot be read counts as off: your node reads and writes nothing on the Chia chain, on any Chia network. Turned back on, the saved switch is removed and Chia comes on at your node\'s next start.';
/** A folder where the switch's file goes: the node cannot remove it, so
 *  there is no TURN CHIA BACK ON (the node's startup line names the path). */
export const LANE_STUCK_NOTE =
  'The saved switch could not be read, and a switch that cannot be read counts as off: your node reads and writes nothing on the Chia chain, on any Chia network. A folder stands where your node keeps the switch, and the switch here cannot remove a folder: once it is removed by hand (your node\'s log names it), Chia comes on at your node\'s next start.';
/** Off for this run, the switch on for the next start: after TURN CHIA BACK
 *  ON, and after an off whose save failed with no switch left on disk, so
 *  it says what the switch is, never what was done to it. */
export const LANE_UNTIL_RESTART_NOTE =
  'The switch here is on for your node\'s next start: Chia stays off until your node stops, and comes on at its next start (unless SSF_NO_CHIA_LANE is in its environment then).';
export const LANE_ENV_NOTE =
  'SSF_NO_CHIA_LANE in your node\'s environment holds Chia off on this computer, and the switch here cannot change that. Turned off here too, Chia stays off once that is gone.';
export const LANE_ENV_SAVED_NOTE =
  'SSF_NO_CHIA_LANE in your node\'s environment holds Chia off on this computer, and the switch here is off too, so Chia stays off once that is gone. To turn the switch back on, start your node without SSF_NO_CHIA_LANE.';
export const LANE_ENV_DAMAGED_NOTE =
  'SSF_NO_CHIA_LANE in your node\'s environment holds Chia off on this computer, and the saved switch here could not be read, which counts as off, so Chia stays off once that is gone. To turn the switch back on, start your node without SSF_NO_CHIA_LANE.';
export const LANE_ENV_STUCK_NOTE =
  'SSF_NO_CHIA_LANE in your node\'s environment holds Chia off on this computer, and the saved switch here could not be read, which counts as off, so Chia stays off once that is gone. A folder stands where your node keeps the switch, and the switch here cannot remove a folder: once it is removed by hand (your node\'s log names it), Chia comes on at a start without SSF_NO_CHIA_LANE.';
/** A node with the lane but not the switch, held off by the environment. */
export const LANE_ENV_OLDER_NOTE = 'SSF_NO_CHIA_LANE in your node\'s environment holds Chia off on this computer. ' + LANE_OLDER_NODE;
export const LANE_OFF_UNKNOWN_NOTE = 'Chia is off on this computer.';

/** Why Chia is off, as one clause the Bank, the Phone Book row and the dish
 *  carry on with. */
export function chiaOffWhy(lane: ChiaLane): string {
  if (lane.source === 'env') return "Chia is off on this computer (SSF_NO_CHIA_LANE in your node's environment)";
  if (lane.source === 'setting') {
    if (lane.setting === 'on') return `Chia is off on this computer for the rest of this run (its switch in ${LANE_WHERE} is on for your node's next start)`;
    if (lane.damaged) return `Chia is off on this computer (its saved switch in ${LANE_WHERE} could not be read, and a switch that cannot be read counts as off)`;
    return `Chia is off on this computer (turned off in ${LANE_WHERE})`;
  }
  return 'Chia is off on this computer';
}

/** The sentence after `chiaOffWhy` that says how Chia comes back, when the
 *  switch is what holds it off for the next start too; empty otherwise (the
 *  environment's off, a switch already on for the next start, which the
 *  clause says, or a folder the switch cannot remove, which the CHIA row
 *  says). */
export function chiaBackOn(lane: ChiaLane): string {
  return lane.source === 'setting' && lane.setting !== 'on' && !lane.stuck
    ? "Turning it back on there brings Chia back at your node's next start."
    : '';
}

/** `text`, then the back-on sentence when there is one. */
const withBackOn = (text: string, lane: ChiaLane): string => {
  const back = chiaBackOn(lane);
  return back ? `${text} ${back}` : text;
};

/** The Network rows' feedback when the Share Card row is ticked on or off,
 *  with the node's lane (`lane`): while Chia is off the node publishes
 *  nothing members can find it by on the chain, and reads no knocks. */
export function shareCardFeedback(on: boolean, lane: ChiaLane | null | undefined): string {
  if (!on) return 'Contact card not shared in this room: members get no key for this station, and the node reads no knocks for it.';
  if (lane?.off) return withBackOn(`Contact card shared in this room, but ${chiaOffWhy(lane)}, so your node publishes nothing members can find it by on the chain, and reads no knocks, until Chia is back on.`, lane);
  return 'Contact card shared in this room: its members can find this station by key and knock when every live route fails (private rooms only; public rooms never carry cards).';
}

/** The turn an act sends, or none (`arm` only shows CONFIRM). */
export function laneTurnOf(act: string | undefined): ChiaLaneTurn | null {
  switch (act) {
    case 'confirm': return 'off';
    case 'keep': return 'keep';
    case 'on': return 'on';
    default: return null;
  }
}

/** A held Enter or Space repeats its keydown, and each one would tap the
 *  switch again: CONFIRM right after TURN CHIA OFF. Only a fresh press counts. */
export function laneKeyRepeat(e: { repeat: boolean; key: string }): boolean {
  return e.repeat && (e.key === 'Enter' || e.key === ' ');
}

const BUSY_LABEL: Record<ChiaLaneTurn, string> = {
  off: 'TURNING CHIA OFF…',
  keep: 'KEEPING CHIA OFF…',
  on: 'TURNING CHIA BACK ON…',
};

/** What the CHIA row of the Network rows shows. */
export function chiaLaneRow(fp: LocalFingerprint | null | undefined, ui: ChiaLaneUi): ChiaLaneRow {
  const error = ui.error ?? null;
  const row = (value: string, colour: string, note: string | null, button: ChiaLaneRow['button'] = null, warning: string | null = null): ChiaLaneRow =>
    ({ value, colour, note, warning, error, button });
  if (!fp) return row('NO NODE', LANE_NO_NODE_COLOUR, null);
  const lane = fp.chia_lane;
  if (!lane) return row('NO SWITCH', LANE_UNKNOWN_COLOUR, LANE_OLDER_NODE);
  // A node with the lane but not the switch (it sends no `setting`): its
  // state, and no button, since it has no route to send one to.
  if (lane.setting === undefined) {
    if (!lane.off) return row('ON', LANE_ON_COLOUR, LANE_OLDER_NODE);
    return row('OFF', LANE_OFF_COLOUR, lane.source === 'env' ? LANE_ENV_OLDER_NOTE : LANE_OFF_UNKNOWN_NOTE);
  }
  // While a turn is in flight the button says what it is doing, whatever
  // the fingerprint read meanwhile.
  const busy = ui.turning ? { act: 'confirm' as const, label: BUSY_LABEL[ui.turning], danger: false, busy: true } : null;
  const button = (act: ChiaLaneAct, label: string): ChiaLaneRow['button'] => busy ?? { act, label, danger: false, busy: false };
  if (!lane.off) {
    if (lane.setting === 'off') return row('ON', LANE_ON_COLOUR, LANE_SAVING_NOTE, busy);
    if (busy) return row('ON', LANE_ON_COLOUR, LANE_ON_NOTE, busy);
    if (ui.armed) return row('ON', LANE_ON_COLOUR, LANE_ON_NOTE, { act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false }, LANE_ARMED_WARNING);
    return row('ON', LANE_ON_COLOUR, LANE_ON_NOTE, button('arm', 'TURN CHIA OFF'));
  }
  switch (lane.source) {
    case 'env':
      // The node refuses an on while the environment holds Chia off, so a
      // switch saved off has no button here.
      if (lane.setting === 'off') return row('OFF', LANE_OFF_COLOUR, lane.stuck ? LANE_ENV_STUCK_NOTE : lane.damaged ? LANE_ENV_DAMAGED_NOTE : LANE_ENV_SAVED_NOTE, busy);
      return row('OFF', LANE_OFF_COLOUR, LANE_ENV_NOTE, button('keep', 'TURN CHIA OFF HERE TOO'));
    case 'setting':
      if (lane.setting === 'on') return row('OFF until your node restarts', LANE_OFF_COLOUR, LANE_UNTIL_RESTART_NOTE, button('keep', 'KEEP CHIA OFF'));
      // A folder the node cannot remove: an on would only fail, so none.
      if (lane.stuck) return row('OFF', LANE_OFF_COLOUR, LANE_STUCK_NOTE, busy);
      return row('OFF', LANE_OFF_COLOUR, lane.damaged ? LANE_DAMAGED_NOTE : LANE_SETTING_OFF_NOTE, button('on', 'TURN CHIA BACK ON'));
    default:
      return row('OFF', LANE_OFF_COLOUR, LANE_OFF_UNKNOWN_NOTE, busy);
  }
}

/** Ask the node at `origin` to turn Chia off (`on` false) or back on for its
 *  next start. Never throws: a refusal comes back in the node's words,
 *  anything else in the page's. */
export async function turnChiaLane(
  origin: string,
  on: boolean,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = LANE_TURN_TIMEOUT_MS,
): Promise<TurnResult> {
  if (!origin) return { ok: false, error: 'your station node is not answering' };
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // No redirect: the answer must be the node's own (the fingerprint probe's
    // rule). No body and no custom header: a simple request, no preflight.
    const res = await fetchImpl(`${origin}/api/chia/lane?on=${on ? 1 : 0}`, { method: 'POST', signal: ctl.signal, redirect: 'error' });
    if (res.status === 404) {
      return { ok: false, error: 'your station node is older than the Chia switch here: update Star Station' };
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
        ? `your station node did not answer in time; it may still be turning Chia ${on ? 'back on' : 'off'}, so look again in a moment`
        : 'your station node could not be reached',
    };
  } finally {
    clearTimeout(deadline);
  }
}
