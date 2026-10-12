/**
 * 🪐 A room's first claim writes its name before the roomInfo observer that
 * republishes a ship's summary on a name change is installed, so the claim
 * publishes the summary itself: a ship's shared entry carries the claimed
 * name at once, not the "SHIP" stand-in until the heartbeat.
 *
 * ⚠️ Like roomOwner.test.ts, this SCANS the source: main.ts can't be loaded
 * by vitest. It pins the wiring, not a published entry.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe("a room's first claim (source scan)", () => {
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');

  it('publishes the planet summary right after writing the room name', () => {
    const claim = main.indexOf('roomMap.set("name", boot.roomId || "Lobby");');
    expect(claim, 'the claim\'s name write not found in main.ts').toBeGreaterThan(-1);
    const observer = main.indexOf('roomMap.observe(', claim);
    expect(observer, 'the roomInfo observer not found after the claim').toBeGreaterThan(claim);
    // In the claim itself: before the observer, and before the seeds that
    // wait on the server sync.
    const publish = main.indexOf('publishPlanetSummary();', claim);
    expect(publish).toBeGreaterThan(claim);
    expect(publish).toBeLessThan(observer);
    expect(publish).toBeLessThan(main.indexOf('sync.whenServerSynced', claim));
  });
});
