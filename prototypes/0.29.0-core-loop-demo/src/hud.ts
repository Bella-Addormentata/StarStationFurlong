/**
 * Debug HUD updater — small utility shared by main.ts and player.ts
 * to avoid a circular-import chain (main → world → player → main).
 */
export function updateDebugHUD(elementId: string, value: string): void {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}

// ── Transient bottom-centre hint toast ────────────────────────────────────────
let hintEl: HTMLDivElement | null = null;
let hintTimer: number | null = null;

/**
 * Show a transient hint at the bottom-centre of the screen (door denials,
 * dock-status messages, …). Repeat calls replace the text and reset the
 * hide timer. Styled to match the golden docking-terminal palette.
 */
export function showHint(text: string, durationMs = 2600): void {
  if (!hintEl) {
    hintEl = document.createElement('div');
    hintEl.id = 'hud-hint';
    hintEl.style.cssText = `
      position: fixed;
      bottom: 48px;
      left: 50%;
      transform: translateX(-50%);
      max-width: 70vw;
      padding: 10px 18px;
      background: rgba(4, 8, 22, 0.95);
      border: 1px solid rgba(212, 168, 75, 0.28);
      border-radius: 8px;
      color: #d4a84b;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      font-size: 12px;
      letter-spacing: 0.5px;
      text-align: center;
      z-index: 6500;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.25s ease;
    `;
    document.body.appendChild(hintEl);
  }

  hintEl.textContent = text;
  hintEl.style.opacity = '1';

  if (hintTimer !== null) window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    if (hintEl) hintEl.style.opacity = '0';
    hintTimer = null;
  }, durationMs);
}

// ── 🔑 Recovery-key backup nudge banner (#79, PR #124 review) ────────────────
// Top-centre and persistent while armed — it asks for a decision, so unlike
// the hint it never auto-hides. Layout + palette live in index-inline.css
// (`#hud-recovery-nudge …`), the same stylesheet that gates the SpacePhone
// tip, and `display` is decided THERE: `data-armed="1"` says "the engine
// wants it shown"; body.in-room / body.pre-entry / body.exterior-active decide
// whether it is actually on screen. Nothing here sets an inline `display`,
// or it would beat the stylesheet's gating.

export interface RecoveryNudgeActions {
  /** BACK UP NOW — open the phone on the backup panel (never reveals the key itself). */
  onBackUp: () => void;
  /** LATER — silence the banner for a day. */
  onLater: () => void;
  /** DON'T ASK AGAIN — permanent for this identity. */
  onNever: () => void;
}

let nudgeEl: HTMLDivElement | null = null;

/**
 * Keep a click on the banner from reaching the window-level canvas handlers
 * (a click that bubbles to the window raycasts a walk-to under the button —
 * the SpacePhone container stops propagation for the same reason).
 */
function swallowPointer(e: Event): void {
  e.stopPropagation();
}

/**
 * Arm the banner with `message` and this call's three actions. Repeat calls
 * rebuild the buttons so they always carry the latest closures.
 */
export function showRecoveryNudgeBanner(message: string, actions: RecoveryNudgeActions): void {
  if (!nudgeEl) {
    nudgeEl = document.createElement('div');
    nudgeEl.id = 'hud-recovery-nudge';
    nudgeEl.setAttribute('role', 'status');
    nudgeEl.setAttribute('aria-live', 'polite');
    for (const type of ['click', 'pointerdown', 'mousedown'] as const) {
      nudgeEl.addEventListener(type, swallowPointer);
    }
    document.body.appendChild(nudgeEl);
  }

  const text = document.createElement('div');
  text.className = 'nudge-text';
  text.textContent = `🔑 ${message}`;

  const makeButton = (label: string, onClick: () => void, primary = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'nudge-btn primary' : 'nudge-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const row = document.createElement('div');
  row.className = 'nudge-actions';
  row.append(
    makeButton('BACK UP NOW', actions.onBackUp, true),
    makeButton('LATER', actions.onLater),
    makeButton("DON'T ASK AGAIN", actions.onNever),
  );

  nudgeEl.replaceChildren(text, row);
  nudgeEl.dataset.armed = '1';
}

/** Disarm the banner (the stylesheet hides an unarmed one). Safe before any show. */
export function hideRecoveryNudgeBanner(): void {
  if (nudgeEl) delete nudgeEl.dataset.armed;
}
