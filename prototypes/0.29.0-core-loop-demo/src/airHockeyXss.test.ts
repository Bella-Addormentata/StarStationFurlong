/**
 * Air hockey HUD XSS-guard tests — PR #116 review (Copilot inline on
 * airHockeySession.ts:968).
 *
 * The focused-play HUD interpolates the OPPONENT's display name — a
 * peer-writable string on the room doc — into an HTML template that
 * lands via `card.innerHTML`. Before the fix, a hostile display name
 * such as `<img src=x onerror="alert(1)">` would inject markup or event
 * handlers into another player's overlay when they focused the same
 * table. The remediation escapes every peer-authored string before it
 * reaches the DOM by routing it through this module's `escapeHtml`.
 *
 * The DOM interpolation itself isn't exercised from the pure-Node vitest
 * environment (no JSDOM configured), so we pin the pure escaper directly
 * and assert the specific characters that make markup / event-handler
 * injection possible are all rewritten to entities.
 */

import { describe, expect, it } from 'vitest';
import { escapeHtml } from './htmlEscape';

describe('#116 XSS fix — escapeHtml on peer display names', () => {
  it('escapes the five markup-sensitive characters', () => {
    // The set that matters for HTML text + attribute contexts: & (or every
    // downstream entity double-decodes), <, > (element boundaries), "
    // (attribute delimiters), ' (single-quoted attributes / event handlers).
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('neutralises a script-tag payload', () => {
    // A raw `<script>` in an interpolated HUD template would execute the
    // moment the container's innerHTML was set (or the tag would render
    // as trusted markup, per the same host origin).
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('neutralises an image event-handler payload (the classic name attack)', () => {
    // The exact shape called out in the review comment. After escaping,
    // no `<`, `>`, or `"` remains raw, so `img onerror` cannot form.
    const attack = '<img src=x onerror="alert(1)">';
    const safe = escapeHtml(attack);
    expect(safe).not.toContain('<');
    expect(safe).not.toContain('>');
    expect(safe).not.toContain('"');
    expect(safe).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it("closes an attribute early with either quote style", () => {
    // Attribute-context injection: name interpolated inside a "…" attribute
    // must not be able to close the attribute and add a handler. Same for
    // single-quoted attributes (event-handler assignment via '  onerror=').
    const double = 'Alice" onmouseover="alert(1)';
    const single = "Bob' onclick='alert(1)";
    expect(escapeHtml(double)).not.toContain('"');
    expect(escapeHtml(single)).not.toContain("'");
  });

  it('leaves harmless names untouched', () => {
    expect(escapeHtml('Alice')).toBe('Alice');
    expect(escapeHtml('Player 7')).toBe('Player 7');
    expect(escapeHtml('SS_Furlong-42')).toBe('SS_Furlong-42');
  });

  it('is safe on empty and long inputs', () => {
    expect(escapeHtml('')).toBe('');
    const long = '<'.repeat(1024);
    expect(escapeHtml(long).length).toBe(1024 * '&lt;'.length);
    expect(escapeHtml(long)).not.toContain('<');
  });

  it('encodes ampersand first (no double-escape bug)', () => {
    // Order matters: & → &amp; must run before other rules would smuggle
    // an entity through. This regex-with-lookup construction is single-pass.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;'); // literal `&lt;` becomes `&amp;lt;`
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });
});
