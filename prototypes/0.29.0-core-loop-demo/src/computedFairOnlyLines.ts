/**
 * 🔒 The words a FAIR ONLY table shows (design §8.3 "Display at p/q", §8.4
 * "The paused felt"; PR 6c-4c): the plaque, the felt's status line, and the
 * ⚙ card's rows, from what the page reads of the game (computedTable
 * computedFairOnlyView), and what the card says at the owner's press of FAIR
 * ONLY and of the way back. Pure, and display only: nothing counts by a line.
 */
import type { ComputedFairOnlyView, FairOnlyOffResult, FairOnlyOnResult } from './computedTable';

export interface FairOnlyLine { text: string; color: string }

const GREEN = '#7CF5B0';
const AMBER = '#F5C26B';
const RED = '#FF8A80';
const DIM = '#7C8794';
const GOLD_BRIGHT = '#F0C060';
const PINK = '#FF2D95';

/** The paused felt's line (§8.4). */
export const FAIR_ONLY_WAITS = 'THE TABLE WAITS FOR THE HOUSE · BETS STAY ON THE FELT';
/** The ⚙ card's FAIRNESS at a FAIR ONLY table (§8.1). */
export const FAIR_ONLY_SETTING = 'FAIR ONLY · THE TABLE WAITS FOR THE HOUSE';
/** A game whose rules this build does not know (§8.3 the name check). */
export const FAIR_ONLY_UPDATE = 'UPDATE TO PLAY THIS TABLE';

type Game = 'craps' | 'roulette';
const roundOf = (game: Game): string => (game === 'craps' ? 'ROLL' : 'ROUND');

/** The plaque: every round of a FAIR ONLY table takes the house's seed, so
 *  it never reads Friendly; it says when the table waits, has ended, or
 *  can't be played by this build. */
export function fairOnlyBadge(v: ComputedFairOnlyView): { text: string; color: string; fair: boolean } {
  if (v.newer) return { text: FAIR_ONLY_UPDATE, color: AMBER, fair: false };
  if (v.ended) return { text: 'FAIR ONLY · THIS GAME HAS ENDED', color: AMBER, fair: true };
  if (v.waits === 'ending') return { text: 'FAIR ONLY · THIS GAME IS ENDING', color: AMBER, fair: true };
  if (v.waits !== null) return { text: FAIR_ONLY_SETTING, color: AMBER, fair: true };
  return { text: '✔ FAIR ONLY · THE HOUSE AND EVERY BETTOR ADD A SEED', color: GREEN, fair: true };
}

/** The felt's status line while no round closes (null: rounds close, and the
 *  table's own line says how the round stands). */
export function fairOnlyFeltLine(v: ComputedFairOnlyView, game: Game): { line: string; color: string } | null {
  if (v.newer) return { line: FAIR_ONLY_UPDATE, color: GOLD_BRIGHT };
  if (v.waits === 'ending') return { line: `THIS GAME IS ENDING · NO NEW ${roundOf(game)} STARTS`, color: GOLD_BRIGHT };
  return v.waits === null ? null : { line: FAIR_ONLY_WAITS, color: GOLD_BRIGHT };
}

/** What a round closed and undecided waits on, as the status line says it
 *  (null: the bettors' seeds). No Friendly round follows a void here. */
export function fairOnlyClosedLine(v: ComputedFairOnlyView, game: Game): { line: string; color: string } | null {
  if (v.waiting === 'offline') {
    return { line: `⚠ THE HOUSE WENT OFFLINE · THIS ${roundOf(game)} GOES VOID UNLESS IT COMES BACK · THEN THE TABLE WAITS FOR IT`, color: GOLD_BRIGHT };
  }
  return v.waiting === 'house' ? { line: "✋ NO MORE BETS — WAITING FOR THE HOUSE'S SEED", color: PINK } : null;
}

/** The names the card's rows use, ready to show (escaped, in capitals): the
 *  game's holder (its player, else the start of its key), and the player the
 *  deed names when that is another (null: nobody). */
export interface FairOnlyNames { holder: string | null; deed: string | null }

/** The ⚙ card's rows at a FAIR ONLY table, in order. `riders`: how many
 *  players have bets riding at craps (0 at roulette). */
export function fairOnlyCardLines(v: ComputedFairOnlyView, game: Game, names: FairOnlyNames, riders: number): FairOnlyLine[] {
  if (v.newer) return [{ text: `${FAIR_ONLY_UPDATE} · ITS GAME USES RULES THIS VERSION DOES NOT KNOW`, color: AMBER }];
  const out: FairOnlyLine[] = [];
  if (names.holder !== null) {
    out.push(v.deedPid !== undefined
      ? { text: `THIS GAME IS ${names.holder}'S · THE DEED NAMES ${names.deed ?? 'NOBODY'}`, color: AMBER }
      : { text: `THE HOUSE OF ${names.holder}`, color: GOLD_BRIGHT });
    if (v.moved) out.push({ text: `🚩 THE TABLE'S GAME MOVED TO THE HOUSE OF ${names.holder}`, color: RED });
  }
  const state: FairOnlyLine = v.ended ? { text: 'THIS GAME HAS ENDED', color: AMBER }
    : v.waits === 'ending' ? { text: `THIS GAME IS ENDING · NO NEW ${roundOf(game)} STARTS`, color: AMBER }
      : v.waits === 'house' ? { text: FAIR_ONLY_WAITS, color: AMBER }
        : v.waits === 'full' ? { text: "THE TABLE WAITS FOR THE HOUSE'S CHECKPOINT · BETS STAY ON THE FELT", color: AMBER }
          : v.waiting === 'offline' ? { text: `THE HOUSE IS NOT HEARD · THIS ${roundOf(game)} GOES VOID UNLESS IT COMES BACK`, color: AMBER }
            : v.heard ? { text: 'THE HOUSE IS ONLINE', color: GREEN }
              : { text: 'THE HOUSE IS NOT HEARD', color: AMBER };
  out.push(state);
  out.push({ text: `FAIRNESS · ${FAIR_ONLY_SETTING}`, color: DIM });
  if (game === 'craps' && riders > 0 && (v.waits === 'house' || v.waits === 'full')) {
    out.push({ text: "RIDING BETS WAIT FOR THE OWNER'S HOUSE", color: AMBER });
  }
  if (v.round > 0 && v.o !== null) {
    const o = typeof v.o === 'number' ? `POCKET ${v.o}` : `DICE ${v.o[0]} AND ${v.o[1]}`;
    out.push({ text: `${roundOf(game)} ${v.round} · ${o} · SIGNED BY THE HOUSE`, color: DIM });
  }
  if (v.checking) out.push({ text: "CHECKING THIS GAME'S RECORDS", color: DIM });
  return out;
}

// ── The owner's presses (§8.1 the setting, §8.6 the end, §8.7) ────────────────

/** The button that offers FAIR ONLY at a house table, under FAIRNESS. */
export const FAIR_ONLY_ON_LABEL = 'SET FAIR ONLY';
/** What the card says before the move (the press asks first): what changes
 *  for the players, and who is left out. */
export const FAIR_ONLY_ON_CONFIRM: readonly string[] = [
  "FAIR ONLY: EVERY ROUND TAKES THE HOUSE'S SEED · WHILE THE HOUSE IS AWAY THE TABLE WAITS",
  'BETS ON THE FELT GO BACK TO THEIR PLAYERS',
  "PLAYERS ON OLDER BUILDS DON'T SEE THIS TABLE",
];
/** The button of the way back, for the page that holds the game. */
export const FAIR_ONLY_OFF_LABEL = 'END FAIR ONLY · BACK TO THE OWNER';

/** What the card says of a press of FAIR ONLY, for the answers that are its
 *  own (null: a switch's answer, said in the switch's words). */
export function fairOnlyOnNotice(r: FairOnlyOnResult): string | null {
  switch (r) {
    case 'ok': return 'THIS TABLE IS FAIR ONLY NOW · IT WAITS FOR THE HOUSE';
    case 'owner': return "ONLY THE ROOM'S OWNER SETS FAIR ONLY";
    case 'off': return "PLAYERS' TABLES ARE OFF ON THIS DEVICE";
    case 'no-house': return "THIS ROOM HAS NO HOUSE OF YOUR NODE'S YET";
    case 'no-engine': return 'YOUR NODE DOES NOT RUN FAIR ONLY TABLES · UPDATE IT';
    case 'not-house': return 'ONLY A HOUSE TABLE CAN GO FAIR ONLY';
    case 'theirs': return "THIS TABLE PLAYS ANOTHER HOLDER'S FAIR ONLY GAME";
    case 'house-away': return 'THE HOUSE IS OFFLINE · FAIR ONLY STARTS WHEN IT IS BACK';
    default: return null;
  }
}

/** …and of a press of the way back. */
export function fairOnlyOffNotice(r: FairOnlyOffResult, game: Game): string | null {
  switch (r) {
    case 'ok': return 'THIS FAIR ONLY GAME HAS ENDED · THE OWNER RUNS THIS TABLE AGAIN';
    case 'ending': return `THIS GAME ENDS ONCE ITS ${roundOf(game)} IS DECIDED · NO NEW ${roundOf(game)} STARTS`;
    case 'theirs': return "ONLY THE GAME'S HOLDER ENDS IT";
    default: return null;
  }
}

/** Where the keyboard's focus goes when the card is drawn again and the
 *  control it was on may be gone: the same control while it is there, else
 *  the one that took its place. A question opened puts it on CANCEL, never on
 *  CONFIRM (a second Enter must not confirm); a question answered or
 *  cancelled puts it back on the row's own press. Null: nowhere. */
const FOCUS_NEXT: Readonly<Record<string, readonly string[]>> = {
  'fair-only-on': ['fair-only-cancel'],
  'fair-only-cancel': ['fair-only-on'],
  'fair-only-confirm': ['fair-only-on', 'fair-only-off'],
  'computed-on': ['computed-cancel'],
  'computed-cancel': ['computed-on'],
  'computed-confirm': ['computed-off', 'computed-on'],
};
export function cardFocusAfter(act: string, has: (act: string) => boolean): string | null {
  return [act, ...(FOCUS_NEXT[act] ?? [])].find(has) ?? null;
}
