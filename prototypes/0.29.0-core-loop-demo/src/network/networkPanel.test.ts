/**
 * The management computer's network panel (index.html): the switches a screen
 * reader must be able to name (#272 review round 4). Each sits in a label whose
 * only text is its state word (ON/OFF), which names nothing, so the control
 * carries its own name.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('network panel switches', () => {
  it('the Share Card and Chia Mesh checkboxes carry a descriptive accessible name', () => {
    const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
    for (const id of ['share-card-toggle', 'chia-mode-toggle']) {
      const tag = html.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`));
      expect(tag, `index.html has #${id}`).not.toBeNull();
      expect(tag![0]).toMatch(/\baria-label="[^"]{12,}"/);
    }
  });

  it('⛓️ the CHIA row sits above the Phone Book row, with its note, switch, warning and error', () => {
    const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
    const row = html.indexOf('id="chia-lane-row"');
    expect(row).toBeGreaterThan(0);
    expect(html.indexOf('id="network-chia-lane"')).toBeGreaterThan(row);
    expect(html.indexOf('id="network-phone-book"')).toBeGreaterThan(html.indexOf('id="chia-lane-error"'));
    // Inside the Network rows, which move into the SpacePhone's NETWORK view.
    expect(row).toBeGreaterThan(html.indexOf('id="network-details-hud"'));
    expect(html.slice(row - 60, row)).toContain('class="network-row"');
    expect(html).toMatch(/<span class="label">Chia<\/span>\s*<span class="value" id="network-chia-lane">/);
    // One button, never a submit, named by its label and described by the
    // note and the warning; hidden until the node's fingerprint says what it does.
    const button = html.match(/<button[^>]*\bid="chia-lane-switch"[^>]*>/);
    expect(button, 'index.html has #chia-lane-switch').not.toBeNull();
    expect(button![0]).toContain('type="button"');
    expect(button![0]).toContain('aria-describedby="chia-lane-note chia-lane-warning"');
    expect(button![0]).toMatch(/\bhidden\b/);
    for (const id of ['chia-lane-note', 'chia-lane-warning']) expect(html).toMatch(new RegExp(`<div id="${id}" hidden></div>`));
    // The failure is announced.
    expect(html).toContain('<div id="chia-lane-error" role="status" hidden></div>');
  });
});
