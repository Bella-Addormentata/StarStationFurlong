// 🔒 The FAIR ONLY row in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK (PR 6c,
// node slice n-5b-1).
//
// A FAIR ONLY game is one the owner's node plays the house at, so a table
// can go on without the owner's page there. The node has served those games
// since its n-2 slice and kept them short since n-4c and n-5a, but nothing
// turned that on outside its tests, and a page offers SET FAIR ONLY only
// where its own node says it serves them (computedTable.ts
// `nodeRunsFairOnly`, from the fingerprint's `house_fold`). The node now
// starts with it on (the owner's word of 2026-11-17, for the first field
// run), and this row is the switch: TURN OFF, then a CONFIRM that says what
// stopping does, and TURN ON again the same way.
//
// The node keeps a turn in one file (`fair_only.json`), for every Chia
// network: the house is the node's. A turn holds from the house's next
// tick. Turned off, the house steps down at each FAIR ONLY game it served
// (it reveals a round whose seeds are in and lifts its next commitment) and
// serves none after, and this page, holding a game there, ends it once no
// round is in flight (computedTable.ts `fairOffDuty`), so the row warns
// before an off too. A turn names the node CONFIRM was armed on, and only
// that node takes it. The
// node's environment decides first: `SSF_FAIR_ONLY=1` holds the switch on
// and any other value holds it off. And the node says when its house cannot
// serve the games whatever the switch says (`unable`): then no on is
// offered, and an on saved before is shown as stopped.
//
// This module decides what the row, its lines and its button say, from the
// node's fingerprint (`fair_only`, nodeFingerprint.ts) and the page's own
// state, and sends the request, so both are tested without main.ts. The
// node words its own refusals; the page only says what it saw itself.

import type { TurnResult } from './bankWallet';
import { LANE_NO_NODE_COLOUR, LANE_OFF_COLOUR, LANE_ON_COLOUR, LANE_UNKNOWN_COLOUR } from './chiaLane';
import type { FairOnlyUnable, LocalFingerprint } from './nodeFingerprint';

/** The switch's id in the Network rows' markup: one button whatever it says,
 *  so focus stays on it from TURN ON to CONFIRM to TURNING ON. */
export const FAIR_ONLY_BUTTON_ID = 'fair-only-switch';

/** How long the page waits for the node's answer: a turn saves one small
 *  file. */
export const FAIR_ONLY_TIMEOUT_MS = 15_000;

/** What a CONFIRM was armed for: the turn, and the node whose warning the
 *  player read (its iroh node id). */
export interface FairOnlyArmed {
  on: boolean;
  node: string;
}

/** The page's own part: a turn armed and waiting for CONFIRM, a turn in
 *  flight, and the last turn's failure in the page's or the node's words. */
export interface FairOnlyUi {
  armed: FairOnlyArmed | null;
  turning: 'on' | 'off' | null;
  error: string | null;
}

/** What a TURN ON or TURN OFF tapped now would arm: none while no node
 *  answers, or one that says no node id. */
export function fairOnlyArm(on: boolean, fp: LocalFingerprint | null | undefined): FairOnlyArmed | null {
  const node = fp?.iroh_node_id;
  return node ? { on, node } : null;
}

/** Whether a CONFIRM armed for `armed` still stands: the node that answers
 *  now is the one it was armed on. */
export function fairOnlyStands(armed: FairOnlyArmed | null, fp: LocalFingerprint | null | undefined): boolean {
  return armed !== null && !!fp?.iroh_node_id && fp.iroh_node_id === armed.node;
}

/** What the switch does when tapped: `arm-on` and `arm-off` show CONFIRM,
 *  `on` and `off` send the turn. */
export type FairOnlyAct = 'arm-on' | 'arm-off' | 'on' | 'off';

export interface FairOnlyRow {
  /** The row's value, beside its FAIR ONLY label. */
  value: string;
  colour: string;
  /** The line under the row: what the switch says. */
  note: string | null;
  /** What a turn does, before CONFIRM. */
  warning: string | null;
  /** Why the last turn failed. */
  error: string | null;
  /** The switch, or none. `busy` marks it inert while a turn is in flight
   *  (it keeps focus, unlike `disabled`). */
  button: { act: FairOnlyAct; label: string; danger: boolean; busy: boolean } | null;
}

/** A node older than the switch. */
export const FAIR_ONLY_NO_SWITCH = 'Your node has no FAIR ONLY switch: it is older than the switch. Update Star Station.';

/** The page's refusal of a CONFIRM with nothing it was armed for. */
export const FAIR_ONLY_NOT_CONFIRMED = 'The turn was not confirmed for this node: tap the switch again';

/** What the house does while the switch is on, in one sentence the notes
 *  and the warning share. */
const WHAT_IT_DOES = "your node's house serves the FAIR ONLY games at your tables while your node runs: it deals their rounds and keeps each game short, so a game goes on without your page at the table";

/** On where the player never turned it: nobody tapped CONFIRM under the
 *  warning, so the note itself says what it does and how to stop it. */
export const FAIR_ONLY_DEFAULT_ON_NOTE = `FAIR ONLY tables are on, as they start: ${WHAT_IT_DOES}. Your tables offer SET FAIR ONLY. TURN OFF stops it; a game on when it stops is ended by the page that holds it once no round is in flight.`;

export const FAIR_ONLY_OFF_NOTE = "FAIR ONLY tables are off: your node's house serves no FAIR ONLY game, and your tables do not offer SET FAIR ONLY.";

export const FAIR_ONLY_DAMAGED_NOTE = "The saved FAIR ONLY switch could not be read, and a switch that cannot be read counts as off: your node's house serves no FAIR ONLY game. Turned on here, it is saved anew.";

export const FAIR_ONLY_ON_NOTE = `FAIR ONLY tables are on: ${WHAT_IT_DOES}. Your tables offer SET FAIR ONLY.`;

export const FAIR_ONLY_HELD_ON_NOTE = `SSF_FAIR_ONLY=1 in your node's environment holds FAIR ONLY tables on, and the switch here cannot turn them off: ${WHAT_IT_DOES}.`;

export const FAIR_ONLY_HELD_OFF_NOTE = "SSF_FAIR_ONLY in your node's environment holds FAIR ONLY tables off, and the switch here cannot turn them on.";

/** Why the house cannot serve the games now, as a sentence. */
export function fairOnlyUnableWords(unable: FairOnlyUnable): string {
  switch (unable) {
    case 'build': return 'Your node is a build without the fold of the tables, so its house cannot serve FAIR ONLY games.';
    case 'house': return "Your node's house is off (its saved state could not be read), so it cannot serve FAIR ONLY games.";
    case 'fold-env': return "SSF_HOUSE_FOLD in your node's environment turns the fold of the tables off, so its house cannot serve FAIR ONLY games: start your node without it.";
    case 'fold-down': return "The fold of the tables stopped after its worker failed too often, so your node's house cannot serve FAIR ONLY games until your node starts again.";
    default: return "Your node says its house cannot serve FAIR ONLY games now.";
  }
}

/** On, but nothing serves the games. */
export const fairOnlyStoppedNote = (unable: FairOnlyUnable): string =>
  `FAIR ONLY tables are on, but nothing serves them now. ${fairOnlyUnableWords(unable)} Your tables do not offer SET FAIR ONLY meanwhile, and this page ends each FAIR ONLY game it holds once no round is in flight.`;

/** Off, and they could not be turned on now. */
export const fairOnlyCannotNote = (unable: FairOnlyUnable): string => `FAIR ONLY tables are off. ${fairOnlyUnableWords(unable)}`;

/** What a turn to on does, before CONFIRM. */
export const FAIR_ONLY_ON_WARNING = `Turn FAIR ONLY tables on? Then ${WHAT_IT_DOES}, and your tables offer SET FAIR ONLY. This is the first test of FAIR ONLY tables. If your node stops while a game is on, the game waits for it and plays on when your node is back. Turned off here, this page ends the games it holds itself. Tap CONFIRM.`;

/** What a turn to off does, before CONFIRM. */
export const FAIR_ONLY_OFF_WARNING = "Turn FAIR ONLY tables off? Your node's house stops serving them: at each FAIR ONLY game it reveals a round whose seeds are in and starts no new one, and this page ends each game it holds once no round is in flight (a bet riding a craps point goes back to its player). Your tables stop offering SET FAIR ONLY. Tap CONFIRM.";

/** The turn an act sends: `true` to turn on, `false` to turn off, or none
 *  (`arm-on` and `arm-off` only show CONFIRM). */
export function fairOnlyTurnOf(act: string | undefined): boolean | null {
  switch (act) {
    case 'on': return true;
    case 'off': return false;
    default: return null;
  }
}

/** What an arming act arms: `true` for TURN ON, `false` for TURN OFF, or
 *  none for any other act. */
export function fairOnlyArmOf(act: string | undefined): boolean | null {
  switch (act) {
    case 'arm-on': return true;
    case 'arm-off': return false;
    default: return null;
  }
}

/** The FAIR ONLY row of the Network rows and what stands under it. */
export function fairOnlyRow(fp: LocalFingerprint | null | undefined, ui: FairOnlyUi): FairOnlyRow {
  if (!fp) return { value: 'NO NODE', colour: LANE_NO_NODE_COLOUR, note: null, warning: null, error: null, button: null };
  const error = ui.error ?? null;
  const sw = fp.fair_only;
  if (!sw) return { value: 'NO SWITCH', colour: LANE_UNKNOWN_COLOUR, note: FAIR_ONLY_NO_SWITCH, warning: null, error, button: null };
  // While a turn is in flight the button says what it is doing, whatever
  // the fingerprint read meanwhile.
  const busy = ui.turning
    ? { act: (ui.turning === 'on' ? 'on' : 'off') as FairOnlyAct, label: ui.turning === 'on' ? 'TURNING ON…' : 'TURNING OFF…', danger: false, busy: true }
    : null;
  const armed = fairOnlyStands(ui.armed, fp) ? ui.armed : null;
  const row = (value: string, colour: string, note: string, button: FairOnlyRow['button'], warning: string | null = null): FairOnlyRow =>
    ({ value, colour, note, warning: busy ? null : warning, error, button: busy ?? button });
  if (sw.on) {
    const note = sw.held ? FAIR_ONLY_HELD_ON_NOTE : null;
    const stopped = sw.unable ? fairOnlyStoppedNote(sw.unable) : null;
    const [value, colour] = sw.unable ? ['STOPPED', LANE_OFF_COLOUR] : ['ON', LANE_ON_COLOUR];
    if (sw.held) return row(value, colour, stopped ? `${note} ${stopped}` : (note as string), null);
    // On by the player's word, or as it starts where they never turned it.
    const on = stopped ?? (sw.chosen ? FAIR_ONLY_ON_NOTE : FAIR_ONLY_DEFAULT_ON_NOTE);
    if (armed && !armed.on) return row(value, colour, on, { act: 'off', label: '⚠ CONFIRM', danger: true, busy: false }, FAIR_ONLY_OFF_WARNING);
    return row(value, colour, on, { act: 'arm-off', label: 'TURN OFF', danger: false, busy: false });
  }
  const off = (note: string, button: FairOnlyRow['button'], warning: string | null = null): FairOnlyRow => row('OFF', LANE_UNKNOWN_COLOUR, note, button, warning);
  if (sw.held) return off(FAIR_ONLY_HELD_OFF_NOTE, null);
  // The node refuses an on while something is in the way, so none is offered.
  if (sw.unable) return off(fairOnlyCannotNote(sw.unable), null);
  const note = sw.damaged ? FAIR_ONLY_DAMAGED_NOTE : FAIR_ONLY_OFF_NOTE;
  if (armed && armed.on) return off(note, { act: 'on', label: '⚠ CONFIRM', danger: true, busy: false }, FAIR_ONLY_ON_WARNING);
  return off(note, { act: 'arm-on', label: 'TURN ON', danger: false, busy: false });
}

/** Ask the node at `origin` to make the turn CONFIRM was armed for
 *  (`armed`): on or off, for the node whose warning was read, which takes it
 *  only if it is that node (another may have taken its port since). Never
 *  throws: a refusal comes back in the node's words, anything else in the
 *  page's. */
export async function turnFairOnly(
  origin: string,
  armed: FairOnlyArmed,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = FAIR_ONLY_TIMEOUT_MS,
): Promise<TurnResult> {
  if (!origin) return { ok: false, error: 'your node is not answering' };
  const { on, node } = armed;
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // No redirect: the answer must be the node's own (the fingerprint probe's
    // rule). No body and no custom header: a simple request, no preflight.
    const res = await fetchImpl(`${origin}/api/house/fair-only?on=${on ? 1 : 0}&node=${encodeURIComponent(node)}`, { method: 'POST', signal: ctl.signal, redirect: 'error' });
    if (res.status === 404) {
      return { ok: false, error: 'your node is older than the FAIR ONLY switch: update Star Station' };
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
        ? `your node did not answer in time; it may still be turning FAIR ONLY tables ${on ? 'on' : 'off'}, so look again in a moment`
        : 'your node could not be reached',
    };
  } finally {
    clearTimeout(deadline);
  }
}
