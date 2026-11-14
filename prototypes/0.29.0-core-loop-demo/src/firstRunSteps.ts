/**
 * 🛰️ First run: what the title screen says while a new install looks for the
 * welcome room (welcomeOnly.ts).
 *
 * The game starts looking the moment the page loads, behind the title. A new
 * player used to see none of it: NEW PLAYER revealed the station at once, and
 * the room they walked into was an empty copy until some computer answered.
 * The title now shows where the search stands, one line per step, and holds
 * the reveal for a short while so the room has a chance to be there:
 *
 *  - the room answers: the station is revealed by itself;
 *  - it has not answered after {@link ENTER_PATIENCE_MS}: the ENTER button
 *    lights and the title says nobody answered yet;
 *  - at any moment: ENTER is there and reveals the station as it stands. The
 *    room fills in by itself when a computer answers (welcomeOnly.ts's seek).
 *
 * Pure: facts in, lines out. main.ts gathers the facts (its node's
 * fingerprint, the node's dial reports, the welcome room's arrival) and
 * paints the lines. Nothing here reads the network, a clock or the DOM.
 */

/** The SSF wallet switch as the node reports it (nodeFingerprint.ts
 *  `ChiaWalletState`), repeated here so this module imports nothing. */
export type WalletState = 'unbuilt' | 'off' | 'ready' | 'on';

/** What the title knows of the search. */
export interface FirstRunFacts {
  /** The player's own node: not asked yet, answering, or asked and silent. */
  node: 'unknown' | 'up' | 'down';
  /** Chia is off on this computer (the fingerprint's `chia_lane.off`).
   *  `undefined`: the node has not said (an older node, or none yet). */
  chiaOff?: boolean;
  /** The SSF wallet switch, when the node sends one. */
  wallet?: WalletState;
  /** Computers the node is dialing for the room now. */
  dialing: number;
  /** Computers whose dial has failed and is not running again. */
  failed: number;
  /** A computer answered: a link stands. */
  linked: boolean;
  /** The welcome room's own state is here (welcomeOnly.ts
   *  `welcomeStateHere`). */
  arrived: boolean;
}

/** How a step stands: finished, under way, waiting on something, or not
 *  available on this computer. */
export type StepMark = 'done' | 'busy' | 'wait' | 'off';

export type StepKey = 'node' | 'chia' | 'wallet' | 'dial' | 'room';

export interface StepLine {
  key: StepKey;
  mark: StepMark;
  text: string;
}

/** Facts before anything is known: the page has just loaded. */
export function noFacts(): FirstRunFacts {
  return { node: 'unknown', dialing: 0, failed: 0, linked: false, arrived: false };
}

function computers(n: number): string {
  return n === 1 ? '1 computer' : `${n} computers`;
}

/**
 * The title's lines, in the order the search runs. A step the node says
 * nothing about (an older node sends no Chia or wallet state) has no line:
 * the title never guesses.
 */
export function firstRunSteps(f: FirstRunFacts, roomName: string): StepLine[] {
  const lines: StepLine[] = [];

  // 1. The player's own node: everything else goes through it.
  if (f.node === 'up') {
    lines.push({ key: 'node', mark: 'done', text: "Your computer's node is running." });
  } else if (f.node === 'down') {
    lines.push({
      key: 'node',
      mark: 'wait',
      text: "Your computer's node is not answering yet. The game keeps trying.",
    });
  } else {
    lines.push({ key: 'node', mark: 'busy', text: "Starting your computer's node…" });
  }

  // 2 and 3. The Phone Book and its wallet, only once the node has spoken.
  if (f.node === 'up') {
    if (f.chiaOff === true) {
      lines.push({
        key: 'chia',
        mark: 'off',
        text: 'The Phone Book (Chia) is off on this computer, so it reads no beacons.',
      });
    } else if (f.chiaOff === false) {
      lines.push({
        key: 'chia',
        mark: 'done',
        text: 'The Phone Book (Chia) is on: your computer can read the beacons other players lit.',
      });
      if (f.wallet === 'on') {
        lines.push({
          key: 'wallet',
          mark: 'done',
          text: 'The SSF wallet is on: your computer can knock and list itself.',
        });
      } else if (f.wallet === 'ready') {
        lines.push({
          key: 'wallet',
          mark: 'off',
          text: 'No SSF wallet yet: your computer can read the Phone Book but not write in it. The Bank app makes one.',
        });
      } else if (f.wallet === 'off') {
        lines.push({
          key: 'wallet',
          mark: 'off',
          text: 'The SSF wallet is held off on this computer: it can read the Phone Book but not write in it.',
        });
      }
    }
  }

  // 4. The dial. Arrival and a link say more than any count does.
  if (f.arrived || f.linked) {
    lines.push({ key: 'dial', mark: 'done', text: 'A computer answered.' });
  } else if (f.node !== 'up') {
    lines.push({ key: 'dial', mark: 'wait', text: `Dialing ${roomName} waits for the node.` });
  } else if (f.dialing > 0) {
    lines.push({
      key: 'dial',
      mark: 'busy',
      text: `Dialing ${computers(f.dialing)} that ${f.dialing === 1 ? 'holds' : 'hold'} ${roomName}…`,
    });
  } else if (f.failed > 0) {
    lines.push({
      key: 'dial',
      mark: 'wait',
      text: `No answer from ${computers(f.failed)} yet. Your computer keeps trying.`,
    });
  } else {
    lines.push({ key: 'dial', mark: 'busy', text: `Looking for computers that hold ${roomName}…` });
  }

  // 5. The room itself.
  if (f.arrived) {
    lines.push({ key: 'room', mark: 'done', text: `${roomName} is here.` });
  } else if (f.linked) {
    // The computer that answered may be another install still waiting for the
    // room (welcomeOnly.ts): a link is not the room.
    lines.push({ key: 'room', mark: 'busy', text: `Asking it for ${roomName}…` });
  } else {
    lines.push({
      key: 'room',
      mark: 'wait',
      text: `${roomName} fills in by itself when a computer answers.`,
    });
  }

  return lines;
}

/** How long the title holds the reveal for the room after NEW PLAYER, before
 *  it lights ENTER and says nobody answered yet. ENTER is there throughout. */
export const ENTER_PATIENCE_MS = 45_000;

/**
 * What the title does about entering:
 *  - `reveal`: the room is here, the station is revealed by itself;
 *  - `lit`: the patience is over, ENTER is the lit button;
 *  - `quiet`: still inside the patience, ENTER is there but quiet.
 */
export type EnterMode = 'reveal' | 'lit' | 'quiet';

export function enterMode(arrived: boolean, waitedMs: number): EnterMode {
  if (arrived) return 'reveal';
  return waitedMs >= ENTER_PATIENCE_MS ? 'lit' : 'quiet';
}

/** The line under the ENTER button. */
export function enterNote(mode: EnterMode, roomName: string): string {
  if (mode === 'reveal') return `${roomName} is here.`;
  if (mode === 'lit') {
    return `Nobody has answered yet. Enter now: ${roomName} fills in by itself when a computer answers.`;
  }
  return `Finding ${roomName}. You can enter at any time; the room fills in by itself when a computer answers.`;
}

/** The mark drawn before a line. */
export function stepGlyph(mark: StepMark): string {
  if (mark === 'done') return '✓';
  if (mark === 'busy') return '…';
  if (mark === 'off') return '–';
  return '○';
}

/** Dial reports the node sends for one computer (the `bridge` envelope's
 *  `status`). Anything else is ignored. */
export type DialReport = 'dialing' | 'connected' | 'failed';

/** The dial state the title keeps: who is being dialed, who failed, and
 *  whether anyone answered. Keyed by the node id the report names. */
export interface DialTally {
  dialing: Set<string>;
  failed: Set<string>;
  linked: boolean;
}

export function newDialTally(): DialTally {
  return { dialing: new Set(), failed: new Set(), linked: false };
}

/**
 * Note one dial report. A computer is in one place at a time: dialing again
 * takes it out of the failed ones, failing takes it out of the dialing ones,
 * and an answer takes it out of both. A report that names nobody is ignored.
 */
export function noteDial(t: DialTally, target: string | undefined, status: string | undefined): void {
  if (!target) return;
  if (status === 'dialing') {
    t.failed.delete(target);
    t.dialing.add(target);
  } else if (status === 'failed') {
    t.dialing.delete(target);
    t.failed.add(target);
  } else if (status === 'connected') {
    t.dialing.delete(target);
    t.failed.delete(target);
    t.linked = true;
  }
}
