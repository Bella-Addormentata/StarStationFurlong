/**
 * 🎲🤖 The robot stickman's calls at an owner-run craps table (World's
 * narration loop says them at every table with a fresh heartbeat). On their
 * own so that a players' table's robot (computedRobot) reuses the words
 * without crapsCroupier's module graph (the furniture, three).
 */

import type { CrapsTableState } from './games/craps';

/** The stickman's call for the current state, plus a once-per-round-per-phase
 *  `key` for edge-detection (so each beat pops exactly one bubble per client).
 *  null between beats (idle betting, mid-animation nothing-new). */
export function crapsBeatLine(
  s: CrapsTableState,
): { key: string; text: string } | null {
  if (s.phase === 'betting' && s.phaseDeadline != null) {
    const call = s.point == null
      ? '🎲 Coming out — place your bets!'
      : `🎲 The point is ${s.point} — place your bets!`;
    return { key: `${s.round}:open`, text: call };
  }
  if (s.phase === 'closing') {
    return { key: `${s.round}:close`, text: '✋ No more bets!' };
  }
  if (s.phase === 'settled' && s.dice != null && s.result != null) {
    const [a, b] = s.dice;
    const paid = s.payouts != null && Object.keys(s.payouts).length > 0;
    // sevenOut distinguishes a point-phase 7 (hand over) from a come-out 7
    // (natural — line WINS); the post-roll point is null for both.
    const tail = s.sevenOut ? ' — seven out, new shooter'
      : paid ? ' — winners paid!' : ' — house collects';
    return { key: `${s.round}:settle`, text: `🎲 ${a}+${b} = ${s.result}${tail}` };
  }
  return null;
}
