/**
 * 🤖📜 robotScript — the ENGINE-PURE side of the owner-programmed robot (#77).
 *
 * Why it lives apart from robotDoc.ts and poolWaiter.ts:
 *   - robotDoc.ts owns the Y.js binding + LWW writes (I/O with the room doc).
 *   - poolWaiter.ts owns the THREE.js chassis (rendering + walkTo + tray).
 *   - THIS FILE owns SCRIPT VALIDATION + THE STEP-LOOP STATE MACHINE — no Y.js,
 *     no THREE, no DOM, no wall-clock. Everything is deterministic, dt-driven
 *     and console-testable, which is what the #77 scope directive asks for
 *     ("Engine-pure script parsing/scheduling with vitest tests").
 *
 * SECURITY POSTURE (documented in casinoDoc.ts header, echoed here):
 *   The robot's `script` field crosses the room-doc trust boundary — a hostile
 *   peer can write anything into it. This module refuses everything it does not
 *   recognise BY VALUE (no coercion of garbage into a `goto`), enforces hard
 *   BOUNDS on every field (payload size, coordinate magnitude, wait duration,
 *   say-text length), and never eval's / never dynamically executes anything.
 *   The scheduler steps a bounded discrete state machine; a malicious script
 *   at worst wastes cycles inside caps this file sets — never more.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** One bounded step of an owner-authored routine (a chip list, NOT a DSL). The
 *  robot loops the list: walk to a spot, say a line, or pause. The step kinds
 *  are frozen — any new mechanism ships as a new kind, so the validator's
 *  refusal remains a whitelist and stays cheap. */
export type RobotStep =
  | { kind: 'goto'; x: number; z: number }
  | { kind: 'say'; text: string }
  | { kind: 'wait'; secs: number };

/** Hard cap on a custom script — keeps the synced record small, the render
 *  loop cheap, and a malicious peer's payload bounded. 16 chips is enough for a
 *  short patrol with commentary and long enough for a full three-stop tour. */
export const MAX_SCRIPT_STEPS = 16;
/** Maximum absolute value of a goto coordinate. Rooms today max out at 5×5
 *  tiles (halfExtent 15 m) — 30 m of slack lets an author overshoot a wall
 *  without breaking the guard, while still rejecting nonsense like 1e9. */
export const MAX_COORD_ABS = 30;
/** Longest one-line utterance the bot will speak. Anything longer wraps ugly
 *  and would let a peer flood the chat bubble stack. */
export const MAX_SAY_LEN = 120;
/** Maximum seconds a WAIT step can pause the bot (a whole minute — enough for
 *  a scripted "stay dark" beat without letting the robot vanish for hours). */
export const MAX_WAIT_SECS = 60;
/** Seconds a SAY step keeps the bubble up before the loop advances. Fixed so
 *  the owner can pace by intercutting WAIT steps; a per-step duration would
 *  bloat the schema and doesn't earn its keep in playtesting. */
export const SAY_HOLD_SECS = 2.5;
/** Fail-safe on a GOTO the bot cannot reach (target behind a wall, or the A*
 *  fallback stalls). Advancing after this beat guarantees the loop never
 *  freezes — a hostile owner can't strand the robot at (0, 0) forever. */
export const GOTO_TIMEOUT_SECS = 20;
/** Position-arrival tolerance (metres). The bot's own walker uses 0.15 in
 *  render code; matching it here keeps the scheduler's "arrived" verdict in
 *  step with the render's stop-walking verdict. */
export const ARRIVE_DIST = 0.15;

/** Owner-configurable timing for the auto-croupier's roulette table. Fields
 *  are seconds (the wire format used by the console UI); croupier.ts converts
 *  to milliseconds. All three MUST be finite positive numbers within the
 *  bounds below — nothing bigger than a poker hand, nothing smaller than a
 *  human can react to. */
export interface WheelTiming {
  betSecs: number;
  closingSecs: number;
  showSecs: number;
}
/** Betting window bounds — long enough for a distant player to place a chip
 *  and short enough for a lively rhythm. */
export const BET_SECS_MIN = 6;
export const BET_SECS_MAX = 120;
/** "No more bets" ramp — visible but not lingering. */
export const CLOSING_SECS_MIN = 1;
export const CLOSING_SECS_MAX = 15;
/** Result display window — the wheel animation is ~4 s locally, so it must at
 *  least cover that; the ceiling keeps a settled table moving. */
export const SHOW_SECS_MIN = 4;
export const SHOW_SECS_MAX = 60;

// ── Validators (used by robotDoc.ts + croupier.ts + this module's tests) ──────

/** One-liner text guards — reject non-strings up front so downstream length
 *  checks are safe. `.length` on a JS string is UTF-16 code units, which is a
 *  little over-strict for surrogate pairs; that's fine for a chat limit. */
function isBoundedString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

/** Number guard — must be finite and within [-max, +max]. Rejects NaN, ±Infinity,
 *  and anything outside the sanity window. */
function isBoundedNumber(v: unknown, absMax: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= absMax;
}

/** Non-negative bounded number — used for the wait/timing fields. */
function isBoundedNonNegative(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** Strict shape + bounds check on ONE step. The `kind` is a whitelisted string
 *  literal and every field has an explicit range. Runs on every doc READ (the
 *  scheduler consumes only steps that survive this guard), so cost matters —
 *  it is O(1) per step. */
export function isRobotStep(value: unknown): value is RobotStep {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as { kind?: unknown; x?: unknown; z?: unknown; text?: unknown; secs?: unknown };
  if (s.kind === 'goto') {
    return isBoundedNumber(s.x, MAX_COORD_ABS) && isBoundedNumber(s.z, MAX_COORD_ABS);
  }
  if (s.kind === 'say') {
    return isBoundedString(s.text, MAX_SAY_LEN);
  }
  if (s.kind === 'wait') {
    return isBoundedNonNegative(s.secs, 0, MAX_WAIT_SECS);
  }
  return false;
}

/** Strict WheelTiming guard — all three seconds fields present and in range,
 *  no extras trusted, no coercion. */
export function isWheelTiming(value: unknown): value is WheelTiming {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Partial<WheelTiming>;
  return (
    isBoundedNonNegative(w.betSecs, BET_SECS_MIN, BET_SECS_MAX) &&
    isBoundedNonNegative(w.closingSecs, CLOSING_SECS_MIN, CLOSING_SECS_MAX) &&
    isBoundedNonNegative(w.showSecs, SHOW_SECS_MIN, SHOW_SECS_MAX)
  );
}

/** Human-readable diagnostic returned by parseRobotScript, so the console UI
 *  can surface WHY a script dropped a step (helps the owner debug). */
export interface ParseIssue {
  index: number;
  reason: string;
}

/** parseRobotScript(input) — sanitize an untrusted array-of-anything into a
 *  bounded RobotStep[]. Non-array input, oversized arrays, and any step that
 *  fails the guard is DROPPED with a diagnostic; the returned `steps` array is
 *  safe to hand to the scheduler unchanged. This is the choke point between
 *  the doc read and everything downstream. */
export function parseRobotScript(input: unknown): { steps: RobotStep[]; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  if (!Array.isArray(input)) {
    if (input !== undefined) issues.push({ index: -1, reason: 'script is not an array' });
    return { steps: [], issues };
  }
  const raw = input;
  const overflow = raw.length > MAX_SCRIPT_STEPS;
  if (overflow) issues.push({ index: MAX_SCRIPT_STEPS, reason: `truncated: max ${MAX_SCRIPT_STEPS} steps` });
  const bounded = overflow ? raw.slice(0, MAX_SCRIPT_STEPS) : raw;
  const steps: RobotStep[] = [];
  bounded.forEach((v, i) => {
    if (isRobotStep(v)) {
      steps.push(v);
    } else {
      issues.push({ index: i, reason: 'malformed step' });
    }
  });
  return { steps, issues };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/** What the scheduler asks the render layer to do this frame. The scheduler
 *  never touches THREE; the caller reads this and drives its chassis. */
export type SchedulerAction =
  /** Walk toward (x, z) and report the current distance at the next tick. */
  | { kind: 'goto'; x: number; z: number }
  /** Emit `text` exactly once (on the SAY_START edge); hold pose otherwise. */
  | { kind: 'say'; text: string; started: boolean }
  /** Hold pose; the caller can idle-animate. */
  | { kind: 'wait' }
  /** No script → no request; the caller idles freely. */
  | { kind: 'none' };

/** RobotScriptScheduler — the pure state machine driving one robot's custom
 *  routine. The render layer feeds it dt + the bot's current world position;
 *  it returns the next SchedulerAction and advances the cursor when a step
 *  completes (goto arrival OR GOTO_TIMEOUT, say hold done, wait done). Loop is
 *  built-in — the cursor modulos back to 0.
 *
 *  Design constraints:
 *   • Deterministic — no random, no wall clock. Same dt sequence + start pos
 *     ⇒ same transitions on every client (playback replayable).
 *   • Bounded — dt is clamped to [0, 5] s so a huge tab-freeze doesn't blow
 *     through many steps at once.
 *   • Safe on empty/malformed input — a null / undefined / [] script yields
 *     `none` forever, the caller just idlePoses.
 *   • setSteps(new) resets cursor + timers only when the script CONTENT
 *     changed — a same-value re-apply doesn't jerk the loop.
 */
export class RobotScriptScheduler {
  private steps: RobotStep[] = [];
  private index = 0;
  private timer = 0;
  /** Edge-flag for SAY: true on the first tick of a SAY step, false thereafter.
   *  The caller pops one bubble on `started`, then leaves the bubble alone
   *  while the SAY holds. Reset when the step advances. */
  private sayStarted = false;
  /** JSON-serialised current steps — cheap fingerprint for setSteps() dedup. */
  private stepsKey = '[]';

  /** Max dt the scheduler will honour in one tick — protects against a huge
   *  freeze (e.g. inactive tab restore) burning through the whole loop at once. */
  public static readonly DT_CEILING = 5;

  constructor(initialSteps: readonly RobotStep[] = []) {
    this.setSteps(initialSteps);
  }

  /** Install a new step list. NO-OP when the content is identical to the
   *  current script (owner keeps editing an unrelated field — the cursor
   *  shouldn't jump). Otherwise resets cursor + timers + edge flags. */
  setSteps(next: readonly RobotStep[]): void {
    // Clone into a plain array so external mutation cannot desync the loop.
    const cleaned: RobotStep[] = [];
    for (const s of next) {
      if (isRobotStep(s)) cleaned.push(s);
    }
    const key = JSON.stringify(cleaned);
    if (key === this.stepsKey) return;
    this.steps = cleaned;
    this.stepsKey = key;
    this.index = 0;
    this.timer = 0;
    this.sayStarted = false;
  }

  /** Introspection — the number of loop items the scheduler currently holds
   *  (post-validation). Useful for the tests and the console diagnostics. */
  size(): number {
    return this.steps.length;
  }

  /** Introspection — the current cursor (modulo size), useful for tests. */
  cursor(): number {
    return this.steps.length === 0 ? 0 : this.index % this.steps.length;
  }

  /** One step of the state machine. Returns the SchedulerAction the render
   *  layer should honour THIS frame. The caller passes the bot's current world
   *  (x, z) so goto-arrival can be judged here (the arrival predicate lives
   *  next to the state machine, not scattered across the render code).
   *
   *  `pos` is optional so a caller without a chassis (a test) can also drive
   *  the scheduler with only `advance(dt)` for say/wait timing. In that case
   *  goto steps only advance via GOTO_TIMEOUT_SECS. */
  advance(dt: number, pos?: { x: number; z: number }): SchedulerAction {
    if (this.steps.length === 0) return { kind: 'none' };
    // Clamp dt into a sane band. Negative dt is a caller bug — treat as zero.
    const stepDt = Math.max(0, Math.min(dt, RobotScriptScheduler.DT_CEILING));
    const step = this.steps[this.index % this.steps.length];
    this.timer += stepDt;

    if (step.kind === 'goto') {
      const arrived =
        pos != null && Math.hypot(pos.x - step.x, pos.z - step.z) <= ARRIVE_DIST;
      const timedOut = this.timer >= GOTO_TIMEOUT_SECS;
      if (arrived || timedOut) {
        this.advanceCursor();
        // Fall through to whatever the next step is (it starts on the very
        // next call; this call still returns the completed action so the
        // caller can, e.g., mark arrival before switching commands).
      }
      return { kind: 'goto', x: step.x, z: step.z };
    }

    if (step.kind === 'say') {
      const started = !this.sayStarted;
      if (started) this.sayStarted = true;
      if (this.timer >= SAY_HOLD_SECS) this.advanceCursor();
      return { kind: 'say', text: step.text, started };
    }

    // wait
    if (this.timer >= step.secs) this.advanceCursor();
    return { kind: 'wait' };
  }

  /** Force the cursor to the next step — used internally, exported for tests
   *  that want to skip a goto without simulating movement. */
  skipStep(): void {
    if (this.steps.length === 0) return;
    this.advanceCursor();
  }

  /** Internal — modulo advance + reset per-step edge flags. */
  private advanceCursor(): void {
    if (this.steps.length === 0) return;
    this.index = (this.index + 1) % this.steps.length;
    this.timer = 0;
    this.sayStarted = false;
  }
}
