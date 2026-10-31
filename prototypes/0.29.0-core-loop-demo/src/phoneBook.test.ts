/**
 * 📖 The Phone Book icon in the top bar: green while the node's current
 * addresses are listed, grey once a listing has gone stale, hidden while the
 * node does not publish presence at all.
 */
import { describe, expect, it } from 'vitest';
import type { ChiaPresence, LocalFingerprint } from './nodeFingerprint';
import { PHONE_BOOK_GREEN, PHONE_BOOK_GREY, phoneBookIconSvg, phoneBookIndicator } from './phoneBook';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443 };
const listed: ChiaPresence = { state: 'listed', era: 7, listed_era: 7, last_at: 1_700_000_000, confirmed: true, current: true, public_addrs: 2 };
const withPresence = (p: Partial<ChiaPresence>): LocalFingerprint => ({ ...BASE, chia_presence: { ...listed, ...p } });

describe('phoneBookIndicator', () => {
  it('stays hidden while the node does not publish presence, or did not answer, and the Network row says which', () => {
    for (const none of [null, undefined]) {
      const ind = phoneBookIndicator(none);
      expect(ind.visible).toBe(false);
      expect(ind.row).toEqual({ value: 'NO NODE', colour: '#ff1744' });
    }
    const off = phoneBookIndicator(BASE);
    expect(off.visible).toBe(false);
    expect(off.row.value).toBe('OFF — this node does not publish presence (a read-only build, no wallet, or SSF_CHIA_FINDABLE=0)');
    // The row carries the icon's own words and colour whenever there is an icon.
    const listedInd = phoneBookIndicator(withPresence({}));
    expect(listedInd.row).toEqual({ value: listedInd.title, colour: PHONE_BOOK_GREEN });
    // A grey row reads in a text grey, not the glyph's: 12 px text needs more contrast than a 12 px book.
    const stale = phoneBookIndicator(withPresence({ state: 'outdated', current: false }));
    expect(stale.row).toEqual({ value: stale.title, colour: 'rgba(224, 226, 238, 0.6)' });
    expect(stale.colour).toBe(PHONE_BOOK_GREY);
  });

  it('is a solid green book while this edition lists the current addresses', () => {
    const ind = phoneBookIndicator(withPresence({}));
    expect(ind).toMatchObject({ visible: true, state: 'listed', colour: PHONE_BOOK_GREEN, filled: true, opens: 'setnet' });
    expect(ind.title).toBe("Listed in this week's Phone Book: your node's 2 public addresses are on chain (edition 7)");
    expect(phoneBookIndicator(withPresence({ public_addrs: 1 })).title).toContain("your node's public address is on chain");
    expect(phoneBookIndicator(withPresence({ public_addrs: 0 })).title).toContain('no public address right now, and the book says so');
    // Listed again after a failed change in between: the failure still shows,
    // and still sends an unfunded node to the Bank app.
    const relisted = phoneBookIndicator(withPresence({ error: 'chia wallet unfunded — no unspent coin at puzzle hash ab12' }));
    expect(relisted.title).toBe("Listed in this week's Phone Book: your node's 2 public addresses are on chain (edition 7) · chia wallet unfunded — no unspent coin at puzzle hash ab12");
    expect(relisted.opens).toBe('bank');
  });

  it('is a green outline while the listing is sent and not yet read back', () => {
    const ind = phoneBookIndicator(withPresence({ state: 'sent', confirmed: false }));
    expect(ind).toMatchObject({ visible: true, state: 'sent', colour: PHONE_BOOK_GREEN, filled: false, opens: 'setnet' });
    // The parenthesis is the node's next step, not a deadline for the chain.
    expect(ind.title).toBe('Listing sent to the Phone Book, awaiting confirmation from the chain (the node writes it again if none comes within 30 min)');
    expect(phoneBookIndicator(withPresence({ state: 'sent', confirmed: false, error: 'peers refused the spend' })).title)
      .toBe('Listing sent to the Phone Book, awaiting confirmation from the chain · peers refused the spend');
    // A node with the chain watcher off never gets past sent and never writes again
    // for confirmation's sake; its own words replace the retry note.
    const watcherOff = 'the chain watcher is off (SSF_CHIA_WATCH=0), so the listing is never read back';
    expect(phoneBookIndicator(withPresence({ state: 'sent', confirmed: false, error: watcherOff })).title)
      .toBe(`Listing sent to the Phone Book, awaiting confirmation from the chain · ${watcherOff}`);
  });

  it('is a solid grey book once a listing of ours has gone stale, and says why', () => {
    const newEdition = phoneBookIndicator(withPresence({ state: 'outdated', era: 8, listed_era: 7, current: false }));
    expect(newEdition).toMatchObject({ visible: true, state: 'outdated', colour: PHONE_BOOK_GREY, filled: true });
    expect(newEdition.title).toBe('Phone Book listing outdated: it is from edition 7 and this is edition 8; the new listing goes out shortly');
    const changed = phoneBookIndicator(withPresence({ state: 'outdated', current: false }));
    expect(changed.title).toBe('Phone Book listing outdated: your addresses changed; the new listing goes out within 10 min');
    const noPeak = phoneBookIndicator(withPresence({ state: 'outdated', era: 0, current: false }));
    expect(noPeak.title).toBe("Phone Book listing outdated: no chain peak agreed yet, so this week's edition is unknown");
    // The node's own words replace the promise: a spent write budget, a failed attempt.
    const spent = phoneBookIndicator(withPresence({ state: 'outdated', current: false, error: "this era's write budget is spent; the next listing goes out with the new era" }));
    expect(spent.title).toBe("Phone Book listing outdated: your addresses changed · this era's write budget is spent; the next listing goes out with the new era");
    const failed = phoneBookIndicator(withPresence({ state: 'outdated', era: 8, listed_era: 7, current: false, error: 'peers refused the spend' }));
    expect(failed.title).toBe('Phone Book listing outdated: it is from edition 7 and this is edition 8 · peers refused the spend');
  });

  it('is a grey outline while nothing of ours is listed, and sends an unfunded node to the Bank app', () => {
    const fresh = phoneBookIndicator(withPresence({ state: 'unlisted', listed_era: 0, last_at: 0, confirmed: false, current: false }));
    expect(fresh).toMatchObject({ visible: true, state: 'unlisted', colour: PHONE_BOOK_GREY, filled: false, opens: 'setnet' });
    expect(fresh.title).toBe('Not in the Phone Book yet: the first listing goes out shortly');
    expect(phoneBookIndicator(withPresence({ state: 'unlisted', era: 0, listed_era: 0, last_at: 0, confirmed: false, current: false })).title)
      .toBe('Not in the Phone Book yet: waiting for a chain peak to date the edition');
    const unfunded = phoneBookIndicator(withPresence({
      state: 'unlisted', listed_era: 0, last_at: 0, confirmed: false, current: false,
      error: 'chia wallet unfunded — no unspent coin at puzzle hash ab12',
    }));
    expect(unfunded.opens).toBe('bank');
    expect(unfunded.title).toBe('Not in the Phone Book yet: chia wallet unfunded — no unspent coin at puzzle hash ab12');
    // A stale listing that now fails for want of a coin goes to the Bank app too.
    expect(phoneBookIndicator(withPresence({ state: 'outdated', current: false, error: 'chia wallet UNFUNDED' })).opens).toBe('bank');
  });

  it('keeps the tooltip to one line: whitespace flattened, a long error cut', () => {
    const long = 'x'.repeat(400);
    const ind = phoneBookIndicator(withPresence({ state: 'unlisted', error: `  spend\n failed:  ${long}` }));
    expect(ind.title).toContain('spend failed: ');
    expect(ind.title.length).toBeLessThan(200);
    expect(ind.title.endsWith('…')).toBe(true);
    // An error of nothing but whitespace is no error.
    expect(phoneBookIndicator(withPresence({ state: 'unlisted', error: '  \n ' })).title).toBe('Not in the Phone Book yet: the first listing goes out shortly');
  });
});

describe('phoneBookIconSvg', () => {
  it('draws a solid or outlined book in the colour asked for, decorative to assistive tech', () => {
    const solid = phoneBookIconSvg(PHONE_BOOK_GREEN, true);
    expect(solid.startsWith('<svg viewBox="0 0 16 16"')).toBe(true);
    expect(solid).toContain('aria-hidden="true"');
    expect(solid).toContain(`fill="${PHONE_BOOK_GREEN}"`);
    expect(solid).not.toContain('fill="none"');
    const outline = phoneBookIconSvg(PHONE_BOOK_GREY, false);
    expect(outline).toContain('fill="none"');
    expect(outline).toContain(`stroke="${PHONE_BOOK_GREY}"`);
    expect(outline).not.toContain(`fill="${PHONE_BOOK_GREY}"`);
    // Three strokes a side: cover, spine, the listing lines.
    expect(outline.match(/<path /g)?.length).toBe(3);
    expect(solid.match(/<path /g)?.length).toBe(3);
  });
});
