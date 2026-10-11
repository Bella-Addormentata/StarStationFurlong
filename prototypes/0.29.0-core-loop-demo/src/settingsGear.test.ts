/**
 * The gear card's one-card-in-the-corner rule with the arcade cabinet's
 * card: any gear card that opens closes it first, so the card on show is
 * the one that takes Esc.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Fake {
  innerHTML: string;
  style: { cssText: string };
  removed: boolean;
  setAttribute: () => void;
  addEventListener: () => void;
  appendChild: (el: Fake) => void;
  remove: () => void;
  querySelector: () => null;
  contains: () => boolean;
}
const fake = (): Fake => {
  const el: Fake = {
    innerHTML: '', style: { cssText: '' }, removed: false,
    setAttribute: () => undefined,
    addEventListener: () => undefined,
    appendChild: () => undefined,
    remove: () => void (el.removed = true),
    querySelector: () => null,
    contains: () => false,
  };
  return el;
};

const spec = (itemId: string) => ({
  itemId, title: 'AIR HOCKEY TABLE', noun: 'TABLE', isHouse: () => false, body: () => '',
});

describe('gear cards and the arcade card share a corner', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', { createElement: fake, body: fake(), activeElement: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a gear card opening from anywhere closes the arcade card first', async () => {
    // Air hockey and alligators open theirs straight from a focused game.
    const { closeGearCard, setGearCardNeighbour, toggleGearCard } = await import('./settingsGear');
    const closeArcadeCard = vi.fn();
    setGearCardNeighbour(closeArcadeCard);
    toggleGearCard(spec('air-hockey-1'));
    expect(closeArcadeCard).toHaveBeenCalledTimes(1);
    toggleGearCard(spec('alligators-1')); // another gear: opens, so closes it again
    expect(closeArcadeCard).toHaveBeenCalledTimes(2);
    toggleGearCard(spec('alligators-1')); // the same gear: only closes its own card
    expect(closeArcadeCard).toHaveBeenCalledTimes(2);
    closeGearCard();
    setGearCardNeighbour(null);
  });
});
