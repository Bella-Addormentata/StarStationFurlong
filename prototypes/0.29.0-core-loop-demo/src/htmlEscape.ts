/**
 * HTML escaper for peer-authored strings that reach the DOM via
 * innerHTML — the standard 5-character replacement (& < > " ').
 *
 * Extracted to its own module so it can be unit-tested without pulling
 * in DOM-touching siblings (airHockeySession.ts imports chipDisplay.ts,
 * which reaches `window` at module load and is unavailable in the
 * pure-Node vitest environment). The single-pass regex/lookup form
 * encodes `&` first, so a literal `&lt;` in the input becomes
 * `&amp;lt;` rather than being double-decoded downstream.
 *
 * Callers in this codebase: airHockeySession.ts (seat-row display
 * name in the focused HUD — #116 review remediation). Other historic
 * escape sites (devices.ts:1963, docking.ts, main.ts) are inline
 * regexes with the SAME semantics; keep this module ready to
 * consolidate them if a follow-up unifies the pattern.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;'
    : ch === '<' ? '&lt;'
    : ch === '>' ? '&gt;'
    : ch === '"' ? '&quot;'
    : '&#39;',
  );
}
