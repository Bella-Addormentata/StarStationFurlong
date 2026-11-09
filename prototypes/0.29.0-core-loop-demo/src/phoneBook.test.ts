/**
 * 📖 The Phone Book icon in the top bar: green while the node's current
 * addresses are listed, grey once a listing has gone stale, hidden while the
 * node does not publish presence at all.
 */
import { describe, expect, it } from 'vitest';
import { MAINNET, TESTNET11 } from './chiaNetwork';
import type { ChiaLane, ChiaPresence, ChiaWalletSwitch, LocalFingerprint } from './nodeFingerprint';
import { PHONE_BOOK_GREEN, PHONE_BOOK_GREY, phoneBookIconSvg, phoneBookIndicator } from './phoneBook';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443, chia_net: TESTNET11 };
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
    expect(off.row.value).toBe('OFF — this node does not publish presence (a read-only build, no SSF wallet, or SSF_CHIA_FINDABLE=0)');
    // 🏦 The SSF wallet switch names the reason when it is the reason, and never shows the icon for it.
    const why = (state: 'ready' | 'off' | 'unbuilt' | 'on') => phoneBookIndicator({ ...BASE, chia_wallet: { state } });
    expect(why('ready').row.value).toBe("OFF — this node's SSF wallet is not on yet (turn it on in the SpacePhone's 🏦 BANK)");
    expect(why('off').row.value).toBe("OFF — SSF_CHIA_LANE in the node's environment holds its SSF wallet off");
    expect(why('unbuilt').row.value).toBe('OFF — this build of the node only reads the chain');
    expect(why('on').row.value).toBe('Not in the Phone Book yet — the SSF wallet is on, and the node checks its listing within a minute or two (it never lists itself with SSF_CHIA_FINDABLE=0 or without a durable contact key)');
    for (const s of ['ready', 'off', 'unbuilt', 'on'] as const) expect(why(s).visible).toBe(false);
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

  it("reads last week's listing as listed while this week's waits for its slot, in the node's words", () => {
    // A node writing from burner keys (stage 4 design §4.3) holds last
    // edition's listing in force until this edition's slot or late start.
    const held = phoneBookIndicator(withPresence({ era: 8, listed_era: 7 }));
    expect(held).toMatchObject({ visible: true, state: 'listed', colour: PHONE_BOOK_GREEN, filled: true, opens: 'setnet' });
    const lastWeek = "Listed in last week's Phone Book: your node's 2 public addresses are on chain (edition 7)";
    expect(held.title).toBe(lastWeek);
    expect(held.row).toEqual({ value: lastWeek, colour: PHONE_BOOK_GREEN });
    // The node's words for when this week's goes out (chia_publish.rs
    // LISTING_SLOT_WORDS, LISTING_LATE_WORDS) follow, whole.
    for (const words of [
      "this edition's listing goes out at a random time in its first day",
      "this edition's listing goes out at a random time within about an hour",
    ]) {
      const ind = phoneBookIndicator(withPresence({ era: 8, listed_era: 7, error: words }));
      expect(ind.title).toBe(`${lastWeek} · ${words}`);
      expect(ind.opens).toBe('setnet');
    }
    expect(phoneBookIndicator(withPresence({ era: 8, listed_era: 7, public_addrs: 1 })).title)
      .toBe("Listed in last week's Phone Book: your node's public address is on chain (edition 7)");
    // This week's listing reads as it always did, and so does a listing whose
    // edition the node does not report.
    expect(phoneBookIndicator(withPresence({ era: 8, listed_era: 8 })).title)
      .toBe("Listed in this week's Phone Book: your node's 2 public addresses are on chain (edition 8)");
    expect(phoneBookIndicator(withPresence({ era: 8, listed_era: 0 })).title)
      .toBe("Listed in this week's Phone Book: your node's 2 public addresses are on chain (edition 8)");
  });

  it('is a green outline while the listing is sent and not yet read back', () => {
    const ind = phoneBookIndicator(withPresence({ state: 'sent', confirmed: false }));
    expect(ind).toMatchObject({ visible: true, state: 'sent', colour: PHONE_BOOK_GREEN, filled: false, opens: 'setnet' });
    // The parenthesis is the node's next step, not a deadline for the chain.
    expect(ind.title).toBe('Listing sent to the Phone Book, awaiting confirmation from the chain (the node writes it again if none comes within 30 min)');
    expect(phoneBookIndicator(withPresence({ state: 'sent', confirmed: false, error: 'peers refused the spend' })).title)
      .toBe('Listing sent to the Phone Book, awaiting confirmation from the chain · peers refused the spend');
    // The node's own words replace the retry note whatever they say.
    const noPeers = 'no full-node peer answered, so the listing could not be looked up';
    expect(phoneBookIndicator(withPresence({ state: 'sent', confirmed: false, error: noPeers })).title)
      .toBe(`Listing sent to the Phone Book, awaiting confirmation from the chain · ${noPeers}`);
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

  it("says the burner listing's waits after an outdated listing in the node's words, and never sends them to the Bank", () => {
    const stale = (p: Partial<ChiaPresence>) => phoneBookIndicator(withPresence({ state: 'outdated', current: false, ...p }));
    const lastEdition = 'Phone Book listing outdated: it is from edition 7 and this is edition 8';
    // The node's words (chia_publish.rs: LISTING_CHANGE_WORDS, and stage 4
    // design §10's sentences in listing_failure_words) replace the promise.
    const rows: [string, string][] = [
      ['change', 'the new listing goes out at a random time within about 20 minutes'],
      ['busy', "The chain is busy. Your listing waits for room. Waiting costs nothing, and last week's listing still works."],
      ['dish', "The lobby dish has no mojo ready. Your station tries again every few minutes. Last week's listing still works."],
      ['in flight', "A spend from the SSF wallet is still on its way. Your listing goes out once it lands. Last week's listing still works."],
    ];
    for (const [what, words] of rows) {
      const ind = stale({ era: 8, listed_era: 7, error: words });
      expect(ind.title, what).toBe(`${lastEdition} · ${words}`);
      expect(ind).toMatchObject({ state: 'outdated', colour: PHONE_BOOK_GREY, filled: true, opens: 'setnet' });
    }
    // A hold of the hint rule (chia_publish.rs listing_wait_words) is shown
    // whole: every one fits the tooltip.
    for (const words of [
      "this edition's listing was paid by the SSF wallet and stays as it is: one hint never has two payers; the next edition's listing goes out from its own key",
      "this edition's listing was paid by another key and stays as it is: one hint never has two payers; the next edition's listing goes out from its own key",
    ]) {
      const ind = stale({ error: words });
      expect(ind.title).toBe(`Phone Book listing outdated: your addresses changed · ${words}`);
      expect(ind.title.endsWith('…')).toBe(false);
      expect(ind.opens).toBe('setnet');
    }
    // A listing of this edition with these addresses that did not make it
    // into the book, held by the hint rule (chia_publish.rs
    // unlanded_hold_words): the node's words alone, since neither the
    // edition nor the addresses changed, and whole.
    for (const words of [
      "this edition's listing, paid by the SSF wallet, did not make it into the book; one hint never has two payers, so the next edition's goes out from its own key",
      "this edition's listing, paid by another key, did not make it into the book; one hint never has two payers, so the next edition's goes out from its own key",
      "this edition's listing, paid by another key, did not make it into the book; one hint never has two payers, so the SSF wallet writes the next edition's",
    ]) {
      const ind = stale({ era: 8, listed_era: 8, unlanded: true, error: words });
      expect(ind.title).toBe(`Phone Book listing outdated: ${words}`);
      expect(ind.title.endsWith('…')).toBe(false);
      expect(ind).toMatchObject({ state: 'outdated', colour: PHONE_BOOK_GREY, filled: true, opens: 'setnet' });
    }
    expect(stale({ era: 8, listed_era: 8, unlanded: true }).title).toBe("Phone Book listing outdated: this edition's listing did not make it into the book");
    // The burner path's budget and spend words, the same way.
    const spent = "this edition's write budget is spent; the next listing goes out in the next edition";
    expect(stale({ error: spent }).title).toBe(`Phone Book listing outdated: your addresses changed · ${spent}`);
    const inFlight = "the listing's last spend is still in flight, so it is not written again; the chain settles it";
    expect(stale({ era: 8, listed_era: 7, error: inFlight }).title).toBe(`${lastEdition} · ${inFlight}`);
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

  it("reads true in every state beside mainnet's refusal to pay for a write", () => {
    // The node's text off a test network (chia_publish.rs money_memo_refusal).
    // A listing an older build wrote there can still be listed, sent or
    // outdated, so the text says what stops, never whether this node is listed.
    const refused = 'on Chia mainnet the SSF wallet pays for no Phone Book write, so this node writes no new listing there yet';
    const on = (p: Partial<ChiaPresence>) => phoneBookIndicator({ ...BASE, chia_net: MAINNET, chia_presence: { ...listed, ...p, error: refused } });
    expect(on({}).title).toBe(`Listed in this week's Phone Book: your node's 2 public addresses are on chain (edition 7) · ${refused}`);
    expect(on({ state: 'sent', confirmed: false }).title).toBe(`Listing sent to the Phone Book, awaiting confirmation from the chain · ${refused}`);
    expect(on({ state: 'outdated', era: 8, listed_era: 7, current: false }).title)
      .toBe(`Phone Book listing outdated: it is from edition 7 and this is edition 8 · ${refused}`);
    expect(on({ state: 'unlisted', listed_era: 0, last_at: 0, confirmed: false, current: false }).title).toBe(`Not in the Phone Book yet: ${refused}`);
    for (const state of ['listed', 'sent', 'outdated', 'unlisted'] as const) {
      // Nothing to fund: the tap goes to the network row, not the Bank.
      expect(on({ state }).opens).toBe('setnet');
    }
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

describe.each([TESTNET11, MAINNET])('phoneBookIndicator on $name', (net) => {
  const fp = (over: Partial<LocalFingerprint>): LocalFingerprint => ({ ...BASE, chia_net: net, ...over });

  it('sends the player to the Bank only where the SSF wallet pays for a listing', () => {
    const bank = "OFF — this node's SSF wallet is not on yet (turn it on in the SpacePhone's 🏦 BANK)";
    const noWrite = 'OFF — on Chia mainnet the SSF wallet pays for no Phone Book write yet, so this node writes no listing there';
    // No chia_presence yet: the wallet is off, not made, or on before the
    // heartbeat's first round, so the node's own refusal has not come.
    const ready: ChiaWalletSwitch[] = [
      { state: 'ready', backup: 'native' },
      { state: 'ready', seed: true },
      ...(['page', 'none', undefined] as const).map((backup): ChiaWalletSwitch => ({ state: 'ready', ...(backup ? { backup } : {}) })),
    ];
    for (const chia_wallet of ready) {
      const row = phoneBookIndicator(fp({ chia_wallet })).row.value;
      if (net.test) expect(row).toBe(bank);
      else {
        expect(row).toBe(noWrite);
        expect(row).not.toContain('BANK');
      }
    }
    const on = phoneBookIndicator(fp({ chia_wallet: { state: 'on' } })).row.value;
    const none = phoneBookIndicator(fp({})).row.value;
    if (net.test) {
      expect(on).toContain('the SSF wallet is on');
      expect(none).toContain('does not publish presence');
    } else {
      expect(on).toBe(noWrite);
      expect(none).toBe(noWrite);
    }
    // What holds the node off says so on either network.
    for (const state of ['unbuilt', 'off'] as const) {
      expect(phoneBookIndicator(fp({ chia_wallet: { state } })).row.value).not.toContain('mainnet');
    }
    // A network this page does not know keeps the old rows.
    expect(phoneBookIndicator({ ...BASE, chia_net: null, chia_wallet: { state: 'ready' } }).row.value).toBe(bank);
  });

  it('reads a listing the same way on either network', () => {
    expect(phoneBookIndicator(fp({ chia_presence: listed })).title).toBe(phoneBookIndicator(withPresence({})).title);
  });

  it('hides the icon while Chia is off on this computer, whatever listing the node reported before, and says why', () => {
    const rows: [ChiaLane, string][] = [
      [{ off: true, source: 'env', setting: 'on' }, "OFF — Chia is off on this computer (SSF_NO_CHIA_LANE in your node's environment), so this node neither reads nor writes the Phone Book"],
      [{ off: true, source: 'setting', setting: 'off' }, "OFF — Chia is off on this computer (turned off in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK), so this node neither reads nor writes the Phone Book"],
      [{ off: true, source: 'setting', setting: 'off', damaged: true }, "OFF — Chia is off on this computer (its saved switch in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK could not be read, and a switch that cannot be read counts as off), so this node neither reads nor writes the Phone Book"],
      [{ off: true, source: 'setting', setting: 'on' }, "OFF — Chia is off on this computer for the rest of this run (its switch in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK is on for your node's next start), so this node neither reads nor writes the Phone Book"],
      [{ off: true }, 'OFF — Chia is off on this computer, so this node neither reads nor writes the Phone Book'],
    ];
    const presences: (ChiaPresence | undefined)[] = [listed, { ...listed, state: 'sent', confirmed: false }, { ...listed, state: 'outdated', current: false }, { ...listed, error: 'unfunded: the wallet holds no coin' }, undefined];
    const wallets: (ChiaWalletSwitch | undefined)[] = [{ state: 'on', stays: true }, { state: 'ready' }, { state: 'unbuilt' }, undefined];
    for (const [chia_lane, value] of rows) {
      for (const chia_presence of presences) {
        for (const chia_wallet of wallets) {
          const ind = phoneBookIndicator(fp({ chia_lane, ...(chia_presence ? { chia_presence } : {}), ...(chia_wallet ? { chia_wallet } : {}) }));
          expect(ind.visible).toBe(false);
          expect(ind.opens).toBeNull();
          expect(ind.row).toEqual({ value, colour: 'rgba(224, 226, 238, 0.6)' });
          expect(ind.row.value).not.toContain('mainnet');
          expect(ind.row.value).not.toContain('BANK');
        }
      }
    }
    // Chia on: the listing as before.
    for (const chia_lane of [{ off: false, setting: 'on' }, { off: false }] as ChiaLane[]) {
      expect(phoneBookIndicator(fp({ chia_lane, chia_presence: listed }))).toEqual(phoneBookIndicator(fp({ chia_presence: listed })));
      expect(phoneBookIndicator(fp({ chia_lane, chia_wallet: { state: 'ready' } }))).toEqual(phoneBookIndicator(fp({ chia_wallet: { state: 'ready' } })));
    }
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
