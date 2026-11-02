/**
 * ⛓️🥣 The faucet dish's focused screen (devices.ts createFaucetDishUI) on
 * each Chia network: on a test network the slot takes gifts and shows the
 * jar's address and QR code; on mainnet the game never asks for real XCH, so
 * there is no GIVE, no pay-in line and no QR code; on a network the page does
 * not know, no address shows and the screen says why. The status's network
 * counts only when the fingerprint's resolved network is the same row, and
 * before the first status the fingerprint's network draws the slot.
 *
 * The screen draws into one panel's innerHTML, so a stand-in document whose
 * elements keep their markup is all it needs here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAINNET, TESTNET11, addressOn, networkOfId, type ChiaNetwork } from './chiaNetwork';
import { createFaucetDishUI } from './devices';
import { clearFaucetRoom, openFaucetRoom, setFaucetReply, type FaucetStatus } from './faucetDish';

const ROOM = 'dish-screen-room';
const BODY = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);

const status = (net: ChiaNetwork | null, address: string): FaucetStatus => ({
  net,
  address,
  puzzleHash: '00'.repeat(32),
  gift: 1,
  gap: 32,
  peak: 140,
  totalMojos: 2_500_000_000_000n,
  coins: 2,
  ready: 1,
  nextReadyInBlocks: null,
  canClaim: true,
  // The node says GIVE is possible: the page still offers none off a test network.
  canGive: true,
  walletMojos: 5_000_000_000_000n,
  walletSpendableMojos: 5_000_000_000_000n,
  walletPartial: false,
  partial: false,
  note: '',
  spending: false,
  landing: false,
  snapshot: 0,
});

interface FakePanel { innerHTML: string; id: string; style: { cssText: string } }

/** Mount the screen with `st` on file (or none) and the fingerprint's
 *  resolved network `fpNet` (`undefined`: no fingerprint read), and return
 *  its markup. */
function screen(st: FaucetStatus | null, fpNet?: ChiaNetwork | null): string {
  clearFaucetRoom(ROOM);
  openFaucetRoom(ROOM);
  if (st) setFaucetReply(ROOM, { op: 'status', ok: true, status: st });
  let panel: FakePanel | null = null;
  vi.stubGlobal('document', {
    createElement: () => {
      panel = { innerHTML: '', id: '', style: { cssText: '' }, addEventListener() {}, querySelector: () => null, remove() {} } as FakePanel;
      return panel;
    },
  });
  const ui = createFaucetDishUI({ roomId: () => ROOM, request: () => ({ seq: 1, sent: new Promise<void>(() => {}) }), chiaNet: () => fpNet });
  ui.mount({ appendChild() {} } as unknown as HTMLElement);
  const html = (panel as FakePanel | null)?.innerHTML ?? '';
  ui.unmount();
  clearFaucetRoom(ROOM);
  return html;
}

beforeEach(() => {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([TESTNET11, MAINNET])('the faucet dish screen on $name', (net) => {
  const address = addressOn(net, BODY);
  const html = () => screen(status(net, address), net);

  it('shows the jar and the wallet in the network\'s own coin', () => {
    const h = html();
    expect(h).toContain(`(2.500 ${net.ticker})`);
    expect(h).toContain(`Your wallet: 5,000,000,000,000 mojos (5.000 ${net.ticker})`);
    expect(h).toContain(`· ${net.name}`);
    // TAKE is the node's to allow, on either network.
    expect(h).toContain('TAKE A MOJO');
  });

  it(net.test ? 'takes gifts, and shows the pay-in line, the QR code and the address' : 'has no GIVE, no pay-in line and no QR code', () => {
    const h = html();
    if (net.test) {
      expect(h).toContain('faucet-give-0');
      expect(h).toContain(`+0.001 ${net.ticker}`);
      expect(h).toContain(`Or pay into the jar from any Chia wallet (${net.name}): scan the code or copy the address.`);
      expect(h).toContain('<svg');
      expect(h).toContain(`QR code of the jar's ${net.name} address`);
      expect(h).toContain(address);
    } else {
      expect(h).not.toContain('faucet-give');
      expect(h).not.toContain('GIVE');
      expect(h).not.toContain('pay into');
      expect(h).not.toContain('<svg');
      expect(h).not.toContain(address);
      expect(h).not.toContain('faucet-copy');
      expect(h).toContain('On Chia mainnet the dish takes no gifts.');
      expect(h).not.toContain('TXCH');
      expect(h).not.toContain('testnet');
    }
  });
});

describe('the faucet dish screen off a known network', () => {
  it('shows no address, no QR code and no GIVE on a network the page does not know, and says why', () => {
    const h = screen(status(null, addressOn(TESTNET11, BODY)));
    expect(h).toContain('Your node runs on a Chia network this page does not know, so the dish shows no address.');
    expect(h).not.toContain(BODY);
    expect(h).not.toContain('<svg');
    expect(h).not.toContain('faucet-give');
    expect(h).not.toMatch(/\bT?XCH\b/);
    expect(h).toContain('2,500,000,000,000 mojos');
  });

  it('follows the status alone while no fingerprint has been read', () => {
    const address = addressOn(TESTNET11, BODY);
    const h = screen(status(TESTNET11, address));
    expect(h).toContain('faucet-give-0');
    expect(h).toContain(address);
    expect(h).toContain('· testnet11');
  });

  it('offers no slot and names no network before the first status or fingerprint', () => {
    const h = screen(null);
    expect(h).toContain('READING THE CHAIN…');
    expect(h).not.toContain('faucet-give');
    expect(h).not.toContain('pay into');
    expect(h).not.toContain('faucet-no-slot');
    expect(h).not.toContain('testnet11');
    expect(h).not.toContain('mainnet');
  });
});

describe('the faucet dish screen before the first status', () => {
  // A fingerprint with no chia_network field resolves to testnet11
  // (nodeFingerprint.ts), so today's nodes take this path too.
  it('draws the testnet11 slot with its buttons disabled and no address yet', () => {
    const h = screen(null, TESTNET11);
    expect(h).toContain('THE SLOT — GIVE');
    for (const i of [0, 1, 2]) expect(h).toMatch(new RegExp(`id="faucet-give-${i}" disabled`));
    expect(h).toContain('+0.001 TXCH');
    expect(h).toContain('Or pay into the jar from any Chia wallet (testnet11): scan the code or copy the address.');
    expect(h).toMatch(/<code id="faucet-address"[^>]*>…<\/code>/);
    expect(h).toMatch(/id="faucet-copy" disabled/);
    expect(h).not.toContain('<svg');
    expect(h).toContain('one gift per coin per 32 blocks · testnet11');
  });

  it('offers no GIVE and no pay-in line on mainnet', () => {
    const h = screen(null, MAINNET);
    expect(h).not.toContain('faucet-give');
    expect(h).not.toContain('pay into');
    expect(h).not.toContain('faucet-address');
    expect(h).not.toContain('faucet-copy');
    expect(h).not.toContain('<svg');
    expect(h).not.toContain('TXCH');
    expect(h).not.toContain('testnet');
    expect(h).toContain('On Chia mainnet the dish takes no gifts.');
  });

  it('offers no GIVE and names no network on a network the page does not know', () => {
    const h = screen(null, null);
    expect(h).not.toContain('faucet-give');
    expect(h).not.toContain('pay into');
    expect(h).not.toContain('faucet-address');
    expect(h).not.toContain('testnet11');
    expect(h).not.toContain('mainnet');
    expect(h).toContain('Your node runs on a Chia network this page does not know, so the dish shows no address.');
  });
});

describe.each([TESTNET11, MAINNET])('the faucet dish screen when the fingerprint does not know a $name status', (net) => {
  // The node's chia_network had the right id with another genesis, so the
  // fingerprint resolved no row (chia_net null); the status still says the id.
  for (const [label, wire] of [['names it', net], ['names none', undefined]] as const) {
    if (wire === undefined && net !== TESTNET11) continue; // an absent network is testnet11
    it(`shows no address, QR code or GIVE when the status ${label}`, () => {
      const address = addressOn(net, BODY);
      const h = screen(status(networkOfId(wire?.id), address), null);
      expect(h).not.toContain('faucet-give');
      expect(h).not.toContain('pay into');
      expect(h).not.toContain('<svg');
      expect(h).not.toContain(address);
      expect(h).not.toContain('faucet-address');
      expect(h).not.toContain('faucet-copy');
      expect(h).toContain('id="faucet-no-slot"');
      expect(h).toContain('Your node runs on a Chia network this page does not know, so the dish shows no address.');
      expect(h).not.toMatch(/\bT?XCH\b/);
    });
  }

  it('shows no address when the fingerprint names the other network', () => {
    const other = net === TESTNET11 ? MAINNET : TESTNET11;
    const h = screen(status(net, addressOn(net, BODY)), other);
    expect(h).not.toContain('faucet-give');
    expect(h).not.toContain('<svg');
    expect(h).not.toContain(BODY);
    expect(h).toContain('id="faucet-no-slot"');
  });
});

describe.each([
  { net: TESTNET11, other: MAINNET },
  { net: MAINNET, other: TESTNET11 },
])('the faucet dish screen with a $net.name status and a jar address on $other.name', ({ net, other }) => {
  // A node bug or a stranger on the port: the address is not on the status's network.
  const address = addressOn(other, BODY);
  it('shows no address, no COPY, no QR code and no pay-in line', () => {
    const h = screen(status(net, address), net);
    expect(h).not.toContain('id="faucet-address"');
    expect(h).not.toContain('id="faucet-copy"');
    expect(h).not.toContain('pay into');
    expect(h).not.toContain('<svg');
    expect(h).not.toContain(address);
    if (net.test) expect(h).toContain(`The node sent a jar address that is not on ${net.name}, so the dish shows no address.`);
  });

  it(net.test ? 'draws every GIVE button disabled, though the node says GIVE is possible and the wallet is funded' : 'draws no GIVE button', () => {
    const h = screen(status(net, address), net);
    const gives = h.match(/id="faucet-give-\d+"/g) ?? [];
    if (!net.test) {
      expect(gives).toEqual([]);
      return;
    }
    expect(gives.length).toBeGreaterThan(0);
    for (const id of gives) expect(h).toContain(`${id} disabled`);
  });
});

describe('the faucet dish screen when the empty jar takes no gifts', () => {
  it.each([['Chia mainnet', MAINNET], ['a network the page does not know', null]] as const)('does not ask for a gift when the jar is empty on %s', (_label, net) => {
    const st = { ...status(net, addressOn(net ?? TESTNET11, BODY)), coins: 0, ready: 0, totalMojos: 0n };
    const h = screen(st, net);
    expect(h).toContain('THE JAR IS EMPTY');
    expect(h).not.toContain('DROP SOMETHING IN THE SLOT');
  });

  it('still asks for a gift on a test network', () => {
    const st = { ...status(TESTNET11, addressOn(TESTNET11, BODY)), coins: 0, ready: 0, totalMojos: 0n };
    expect(screen(st, TESTNET11)).toContain('THE JAR IS EMPTY — DROP SOMETHING IN THE SLOT');
  });
});

describe('the faucet dish screen when the fingerprint changes network while it is open', () => {
  /** Mount the screen and keep it open: the fingerprint's network can be
   *  changed between draws, buttons' click handlers are kept by selector,
   *  and the requests the screen sends are recorded. */
  function openScreen(st: FaucetStatus) {
    clearFaucetRoom(ROOM);
    openFaucetRoom(ROOM);
    setFaucetReply(ROOM, { op: 'status', ok: true, status: st });
    let fpNet: ChiaNetwork | null | undefined = st.net;
    const clicks = new Map<string, () => void>();
    const sent: string[] = [];
    const writes: string[] = [];
    const panel = {
      innerHTML: '',
      id: '',
      style: { cssText: '' },
      addEventListener() {},
      querySelector: (sel: string) => ({ addEventListener: (_e: string, fn: () => void) => clicks.set(sel, fn) }),
      remove() {},
    };
    vi.stubGlobal('document', { createElement: () => panel });
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => { writes.push(t); return new Promise<void>(() => {}); } } });
    const ui = createFaucetDishUI({
      roomId: () => ROOM,
      request: (op: string) => {
        sent.push(op);
        return { seq: sent.length, sent: new Promise<void>(() => {}) };
      },
      chiaNet: () => fpNet,
    });
    ui.mount({ appendChild() {} } as unknown as HTMLElement);
    return {
      ui,
      html: () => panel.innerHTML,
      setNet: (n: ChiaNetwork | null | undefined) => { fpNet = n; },
      click: (sel: string) => clicks.get(sel)?.(),
      sent,
      writes,
      close: () => { ui.unmount(); clearFaucetRoom(ROOM); },
    };
  }

  it.each([['Chia mainnet', MAINNET], ['a network the page does not know', null]] as const)('redraws with no GIVE, QR code or address once the fingerprint says %s', (_label, to) => {
    const address = addressOn(TESTNET11, BODY);
    const s = openScreen(status(TESTNET11, address));
    expect(s.html()).toContain('faucet-give-0');
    expect(s.html()).toContain(address);
    s.setNet(to);
    s.ui.update(0.016);
    expect(s.html()).not.toContain('faucet-give');
    expect(s.html()).not.toContain('<svg');
    expect(s.html()).not.toContain(address);
    expect(s.html()).toContain('id="faucet-no-slot"');
    s.close();
  });

  it('does not redraw while the network stays the same', () => {
    const s = openScreen(status(TESTNET11, addressOn(TESTNET11, BODY)));
    const before = s.html();
    s.click('#faucet-take'); // a TAKE marks the room pending; no redraw follows from update()
    const pendingDraw = s.html();
    s.ui.update(0.016);
    expect(s.html()).toBe(pendingDraw);
    expect(before).toContain('faucet-give-0');
    s.close();
  });

  it('sends no GIVE and copies nothing when the network moved off a test one before the click', () => {
    const address = addressOn(TESTNET11, BODY);
    const s = openScreen(status(TESTNET11, address));
    s.setNet(MAINNET);
    // The click lands before the next frame's update() redraws the screen.
    s.click('#faucet-give-0');
    s.click('#faucet-copy');
    expect(s.sent.filter((op) => op === 'give')).toEqual([]);
    expect(s.writes).toEqual([]);
    expect(s.html()).not.toContain('faucet-give');
    s.close();
  });

  it('sends no GIVE and copies nothing when the jar address is not on the test network', () => {
    // The buttons are drawn disabled; the click-time check is the second guard.
    const s = openScreen(status(TESTNET11, addressOn(MAINNET, BODY)));
    s.click('#faucet-give-0');
    s.click('#faucet-copy');
    expect(s.sent.filter((op) => op === 'give')).toEqual([]);
    expect(s.writes).toEqual([]);
    s.close();
  });

  it('still sends a GIVE on the same test network', () => {
    const s = openScreen(status(TESTNET11, addressOn(TESTNET11, BODY)));
    s.click('#faucet-give-0');
    expect(s.sent).toContain('give');
    s.close();
  });
});
