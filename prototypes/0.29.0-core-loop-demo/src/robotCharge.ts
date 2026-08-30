/**
 * 🔋 robotCharge — the ENGINE-PURE charge model for the humanoid robot (#77).
 *
 * The charging-dock furniture and the "walks home to charge when idle" beat
 * already live on the branch. This module adds the OWNER-VISIBLE charge
 * PERCENTAGE the dock's console displays, the low-charge override the render
 * layer honours, and the deterministic time-in-dock accumulator that derives
 * both — same purity discipline as robotScript.ts:
 *
 *   • No THREE, no Y.js, no DOM, no wall clock. Every "time" input is a `dt`
 *     PARAMETER injected by the render binding. Same dt + docked sequence ⇒
 *     the same reading on every replay / every client, so a viewer showing the
 *     dock's console sees the same figure the owner did on the same tick.
 *   • Every field the owner can tune (discharge/charge seconds, low
 *     percentage) is bounded on the room-doc trust boundary — a hostile peer
 *     cannot push the battery to seconds or hours; ChargeParams outside the
 *     envelope is refused and DEFAULT_CHARGE_PARAMS take over.
 *   • dt is clamped to DT_CEILING so a tab-freeze restore cannot jump the
 *     battery from full to zero (or zero to full) in one tick. `advance` is
 *     safe to call every render frame with the frame's real dt.
 */

// ── Owner-tuneable rate params ────────────────────────────────────────────────

/** Owner-tuneable envelope for the charge model. Held in RobotConfig so every
 *  peer's derivation agrees on the same rates — the "programmable pacing"
 *  discipline the branch already uses for wheelTiming. */
export interface ChargeParams {
  /** Seconds from 100 → 0 while UNDOCKED. Long enough that a robot isn't
   *  perpetually low; short enough that "goes to charge" is visible during
   *  playtesting (default ≈ 5 min undocked). */
  dischargeSecs: number;
  /** Seconds from 0 → 100 while DOCKED. Faster than discharge so a docked
   *  robot visibly rebounds (default ≈ 1 min to full from empty). */
  chargeSecs: number;
  /** Percentage below which the render layer forces the robot home to charge
   *  (interrupting patrol/serve) and the console flags LOW. */
  lowPercent: number;
}

/** Discharge floor (a battery that drops in seconds is unusable) and ceiling
 *  (a battery that lasts an hour is invisible). One minute → one hour band. */
export const DISCHARGE_SECS_MIN = 60;
export const DISCHARGE_SECS_MAX = 3600;
/** Charging bounds — 30 s minimum keeps the "still charging" window meaningful
 *  in playtest; 30 min ceiling keeps a low bot from stranding forever. */
export const CHARGE_SECS_MIN = 30;
export const CHARGE_SECS_MAX = 1800;
/** Low threshold — kept ≥ 5 so "low" actually triggers, ≤ 90 so the robot
 *  doesn't idle-dock on the tiniest scratch. */
export const LOW_PERCENT_MIN = 5;
export const LOW_PERCENT_MAX = 90;

/** Playtesting-tuned defaults. A quiet-lobby robot ambles for ~5 min undocked
 *  and refills in ~1 min on the dock; below 20 % it heads home. Values must
 *  survive isChargeParams — bumping them is a schema decision, not a hotfix. */
export const DEFAULT_CHARGE_PARAMS: ChargeParams = {
  dischargeSecs: 300,
  chargeSecs: 60,
  lowPercent: 20,
};

/** One-line finite-range guard — shared by the field validators below. */
function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** Strict shape + bounds check on a stored/received ChargeParams. Mirrors the
 *  posture of isRobotStep / isWheelTiming — coerces nothing, refuses anything
 *  outside its envelope, and runs on every doc read of `chargeParams`. */
export function isChargeParams(value: unknown): value is ChargeParams {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<ChargeParams>;
  return (
    inRange(p.dischargeSecs, DISCHARGE_SECS_MIN, DISCHARGE_SECS_MAX) &&
    inRange(p.chargeSecs, CHARGE_SECS_MIN, CHARGE_SECS_MAX) &&
    inRange(p.lowPercent, LOW_PERCENT_MIN, LOW_PERCENT_MAX)
  );
}

// ── Reading (owner-visible snapshot) ─────────────────────────────────────────

/** Plain-value snapshot the dock console reads. `charging` and `full` are
 *  derived so a UI can render "⚡ CHARGING" / "✅ FULL" / "🔻 LOW" without
 *  re-computing the state machine. */
export interface ChargeReading {
  /** Integer 0..100 for a stable display (the raw float lives internally). */
  percent: number;
  /** Docked AND under 100 — battery is climbing this frame. */
  charging: boolean;
  /** Docked AND at 100 — nothing to charge; the dock LED stays green. */
  full: boolean;
  /** percent < params.lowPercent — the render layer forces docking. */
  low: boolean;
}

// ── Tracker ──────────────────────────────────────────────────────────────────

/** RobotChargeTracker — pure per-robot charge accumulator, one per PoolWaiter.
 *  The render layer ticks it every frame with `dt` + the robot's current
 *  docked flag; the dock console reads `.reading()` to display CHARGE %.
 *
 *  Design constraints (same as RobotScriptScheduler in robotScript.ts):
 *    • Deterministic — same dt + docked sequence ⇒ same percent, always.
 *    • Bounded — dt clamped to DT_CEILING so a huge frame gap can't slew
 *      the battery through its whole range.
 *    • Fail-safe — a bad ChargeParams (hostile peer, corrupted doc, etc.) is
 *      refused; the tracker uses DEFAULT_CHARGE_PARAMS instead of stranding.
 */
export class RobotChargeTracker {
  private _percent: number;
  private _docked = false;
  private params: ChargeParams;

  /** Matches RobotScriptScheduler.DT_CEILING so both engines agree on how much
   *  history a single tick may consume — a slot inactive-tab restore should
   *  not brick the battery. */
  public static readonly DT_CEILING = 5;

  constructor(
    params: ChargeParams | unknown = DEFAULT_CHARGE_PARAMS,
    startPercent = 100,
  ) {
    this.params = isChargeParams(params) ? params : DEFAULT_CHARGE_PARAMS;
    this._percent = clampPercent(startPercent);
  }

  /** Install fresh params (owner tuned them, or the doc's snapshot changed).
   *  A rejected value falls back to defaults so a hostile peer can't strand
   *  the tracker on undefined rates. Current percent is preserved — retuning
   *  the envelope does not wipe the battery. */
  setParams(next: unknown): void {
    this.params = isChargeParams(next) ? next : DEFAULT_CHARGE_PARAMS;
  }

  /** Advance the accumulator by `dt` seconds. `docked=true` adds charge at
   *  100/chargeSecs %/s; `docked=false` drains at 100/dischargeSecs %/s. Percent
   *  stays clamped to [0, 100] — a hostile dt cannot push it outside. */
  advance(dt: number, docked: boolean): void {
    this._docked = docked;
    // Negative dt is a caller bug — treat as zero (matches the scheduler's
    // defensive stance).
    const stepDt = Math.max(0, Math.min(dt, RobotChargeTracker.DT_CEILING));
    if (stepDt === 0) return;
    if (docked) {
      const delta = (100 * stepDt) / this.params.chargeSecs;
      this._percent = Math.min(100, this._percent + delta);
    } else {
      const delta = (100 * stepDt) / this.params.dischargeSecs;
      this._percent = Math.max(0, this._percent - delta);
    }
  }

  /** Raw percent (unrounded, exact). Used by tests that assert boundaries;
   *  the console reads `.reading()` instead for a stable display. */
  percent(): number {
    return this._percent;
  }

  /** True while the last advance was docked (mirrors the flag we were fed). */
  isDocked(): boolean {
    return this._docked;
  }

  /** True whenever `percent < params.lowPercent`. The render layer polls this
   *  each frame and, when true, overrides the current routine to head to dock
   *  — the honest "returns to dock and says it is charging" beat. */
  isLow(): boolean {
    return this._percent < this.params.lowPercent;
  }

  /** Owner-visible snapshot: rounded percent + derived flags. `low` uses the
   *  RAW percent (via isLow) so it agrees with the render layer's override
   *  predicate on the boundary — otherwise a raw 19.99 would round to 20 and
   *  report `low=false` while isLow() said `true`, and the override would
   *  fire without the pill showing it. */
  reading(): ChargeReading {
    const pct = Math.round(this._percent);
    return {
      percent: pct,
      charging: this._docked && pct < 100,
      full: this._docked && pct >= 100,
      low: this.isLow(),
    };
  }

  /** Test / reset helper — jump the accumulator to a specific state without
   *  simulating dt. NOT called by the render binding in normal play. */
  reset(percent = 100, docked = false): void {
    this._percent = clampPercent(percent);
    this._docked = docked;
  }
}

/** Percent clamp — kept out of hot advance() to keep that path branchless
 *  beyond its Math.min/max. */
function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 100;
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}

// ── Dock claim helper (multi-dock determinism) ───────────────────────────────

/** Read-only view of a dock's placed position. */
export interface DockCandidate {
  id: string;
  x: number;
  z: number;
}

/** Deterministic dock pick for a robot that needs to head to A dock:
 *   1. If `assignedId` matches a candidate, return THAT dock — the branch's
 *      1-per-dock robot binding stays authoritative.
 *   2. Otherwise return the NEAREST candidate to (fromX, fromZ).
 *   3. Ties broken by dock id (JS default lex order) so every client, given
 *      the same room doc, picks the same dock — no wall-clock, no random.
 *
 *  Returns null iff `candidates` is empty. `assignedId` is a hint, not a
 *  requirement, so a robot whose dock was just removed still docks somewhere. */
export function pickDockForRobot(
  fromX: number,
  fromZ: number,
  candidates: readonly DockCandidate[],
  assignedId?: string | null,
): DockCandidate | null {
  if (candidates.length === 0) return null;
  if (assignedId != null) {
    const own = candidates.find((c) => c.id === assignedId);
    if (own) return own;
  }
  // Stable sort key: (distance, id). We do a linear pass instead of .sort so
  // the tie-break is explicit and cheap; the winner's id is compared only when
  // distances are equal within a small epsilon.
  const EPS = 1e-6;
  let best: DockCandidate = candidates[0];
  let bestDist = Math.hypot(candidates[0].x - fromX, candidates[0].z - fromZ);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const d = Math.hypot(c.x - fromX, c.z - fromZ);
    if (d < bestDist - EPS) {
      best = c;
      bestDist = d;
    } else if (Math.abs(d - bestDist) <= EPS && c.id < best.id) {
      best = c;
    }
  }
  return best;
}
