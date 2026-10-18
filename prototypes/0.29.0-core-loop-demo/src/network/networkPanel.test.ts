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
});
