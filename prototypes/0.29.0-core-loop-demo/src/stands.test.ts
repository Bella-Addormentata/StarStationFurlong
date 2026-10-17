import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 🎰 Stands are a derived list (stands.ts), rebuilt beside the seats after
 * every furniture change. A path that rebuilds the seats but not the stands
 * leaves a fresh craps / roulette table with no croupier post, so no robot
 * ever walks to it: the dev menu's spawn did exactly that.
 */
describe('stands follow every furniture rebuild', () => {
  const dir = new URL('./', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'seats.ts');

  it('every file that calls rebuildSeats() calls rebuildStands() as often', () => {
    const callers = files.filter((f) => /\brebuildSeats\(\);/.test(readFileSync(new URL(f, dir), 'utf8')));
    expect(callers).toContain('devMenu.ts');
    for (const f of callers) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      const seats = text.match(/\brebuildSeats\(\);/g)!.length;
      const stands = (text.match(/\brebuildStands\(\);/g) ?? []).length;
      expect(stands, `${f}: ${seats} rebuildSeats() but ${stands} rebuildStands()`).toBeGreaterThanOrEqual(seats);
    }
  });
});
