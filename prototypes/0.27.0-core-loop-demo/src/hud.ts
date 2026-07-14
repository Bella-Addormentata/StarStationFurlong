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
