/**
 * 🏦 The SSF wallet switch in the Bank: what RECEIVE says and offers from the
 * node's fingerprint, and how the page asks the node to turn the wallet.
 */
import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN_NETWORK_TEXT, bankWalletView, createInAppText, olderNodeText, receiveNote, turnSsfWallet, type BankWalletUi } from './bankWallet';
import { MAINNET, TESTNET11, addressOn, type ChiaNetwork } from './chiaNetwork';
import type { ChiaWalletSwitch, LocalFingerprint } from './nodeFingerprint';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443, chia_net: TESTNET11 };
const ADDR = 'txch1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);
const IDLE: BankWalletUi = { armed: false, turning: false, error: null };
const node = (chia_wallet?: ChiaWalletSwitch, chia_address?: string): LocalFingerprint => ({
  ...BASE,
  ...(chia_wallet ? { chia_wallet } : {}),
  ...(chia_address ? { chia_address } : {}),
});

describe('bankWalletView', () => {
  it('offers CREATE, then CONFIRM with what turning on means, then shows it turning', () => {
    const ready = node({ state: 'ready', mnemonic: true });
    const fresh = bankWalletView(ready, IDLE);
    expect(fresh).toMatchObject({ showsAddress: false, warning: null, button: { act: 'arm', label: 'CREATE SSF WALLET', danger: false, busy: false } });
    expect(fresh.text).toContain('no SSF wallet yet');
    const armed = bankWalletView(ready, { ...IDLE, armed: true });
    expect(armed.button).toEqual({ act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false });
    expect(armed.warning).toContain('new testnet11 key');
    expect(armed.warning).toContain('Phone Book');
    // The key is made from 24 words, and the Bank shows them to write down.
    expect(armed.warning).toContain('24 words');
    expect(armed.warning).toContain('write down');
    expect(armed.warning).not.toContain('retires');
    const turning = bankWalletView(ready, { ...IDLE, armed: true, turning: true });
    expect(turning.button).toMatchObject({ label: 'TURNING ON…', busy: true });
    expect(turning.warning).toBeNull();
  });

  it('promises no 24 words on CREATE for a node older than them, and says to update first', () => {
    const older = node({ state: 'ready' });
    expect(bankWalletView(older, IDLE).button).toMatchObject({ act: 'arm', label: 'CREATE SSF WALLET' });
    const armed = bankWalletView(older, { ...IDLE, armed: true });
    expect(armed.button).toEqual({ act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false });
    for (const said of ['older than', 'cannot write down', 'new address', 'Update Star Station first']) {
      expect(armed.warning).toContain(said);
    }
    expect(armed.warning).not.toContain('shows you the words');
    // TURN ON of the wallet an older node kept loads that wallet, as before.
    expect(bankWalletView(node({ state: 'ready', seed: true }), { ...IDLE, armed: true }).warning).toContain('same address');
  });

  it('says TURN ON, not CREATE, when the node kept a wallet from before', () => {
    const v = bankWalletView(node({ state: 'ready', seed: true }), IDLE);
    expect(v.button?.label).toBe('TURN ON SSF WALLET');
    expect(v.text).toContain('wallet from before');
    expect(bankWalletView(node({ state: 'ready', seed: true }), { ...IDLE, armed: true }).warning).toContain('same address');
  });

  it('says CREATE, not TURN ON, for a raw-seed wallet from before the 24 words, and what happens to it', () => {
    const v = bankWalletView(node({ state: 'ready', legacy: true }), IDLE);
    expect(v).toMatchObject({ showsAddress: false, warning: null, notice: null, button: { act: 'arm', label: 'CREATE SSF WALLET', danger: false, busy: false } });
    expect(v.text).toContain('from before the 24 words');
    expect(v.text).toContain('replaces it with a new one');
    expect(v.text).not.toContain('same address');
    const armed = bankWalletView(node({ state: 'ready', legacy: true }), { ...IDLE, armed: true });
    expect(armed.button).toEqual({ act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false });
    for (const said of ['not made from 24 words', 'retires it', 'old address', 'new address', 'new testnet11 key from 24 words', 'write down', 'Phone Book']) {
      expect(armed.warning).toContain(said);
    }
    expect(armed.warning).not.toContain('same address');
    // A node that has the 24-word identity loads it: the raw seed beside it changes nothing.
    expect(bankWalletView(node({ state: 'ready', seed: true, legacy: true }), { ...IDLE, armed: true }).warning).toContain('same address');
  });

  it('says once, above the address, that a re-minted wallet is new and not yet listed', () => {
    for (const w of [{ state: 'on', stays: true, mnemonic: true, reminted: true }, { state: 'on', mnemonic: true, reminted: true }, { state: 'on', stays: true, held: true, reminted: true }] as ChiaWalletSwitch[]) {
      const v = bankWalletView(node(w, ADDR), IDLE);
      expect(v.showsAddress).toBe(true);
      expect(v.notice).toContain('new one made from 24 words, at a new address');
      expect(v.notice).toContain('old address');
      expect(v.notice).toContain('not listed in the Phone Book');
    }
    expect(bankWalletView(node({ state: 'on', stays: true, mnemonic: true }, ADDR), IDLE).notice).toBeNull();
    // Only an on wallet with an address has one: a ready node is not re-minted yet.
    expect(bankWalletView(node({ state: 'ready', reminted: true }), IDLE).notice).toBeNull();
  });

  it('shows the address once the wallet is on, with the switch that fits how it stays on', () => {
    const stays = bankWalletView(node({ state: 'on', stays: true }, ADDR), IDLE);
    expect(stays).toMatchObject({ showsAddress: true, button: { act: 'off', label: 'TURN OFF' } });
    expect(stays.text).toContain('whenever your node starts');
    const leaving = bankWalletView(node({ state: 'on' }, ADDR), IDLE);
    expect(leaving).toMatchObject({ showsAddress: true, button: { act: 'keep', label: 'KEEP IT ON' } });
    expect(leaving.text).toContain('does not come back at the next start');
    expect(bankWalletView(node({ state: 'on' }, ADDR), { ...IDLE, turning: true }).button).toMatchObject({ label: 'KEEPING ON…', busy: true });
    const held = bankWalletView(node({ state: 'on', stays: true, held: true }, ADDR), IDLE);
    expect(held).toMatchObject({ showsAddress: true, button: null });
    expect(held.text).toContain('SSF_CHIA_LANE=1');
  });

  it('offers nothing a node would refuse: no node, an older node, a read-only build, a hard off', () => {
    for (const fp of [null, undefined]) {
      const v = bankWalletView(fp, IDLE);
      expect(v).toMatchObject({ button: null, showsAddress: false });
      expect(v.text).toContain('not answering');
    }
    const older = bankWalletView(node(), IDLE);
    expect(older).toMatchObject({ button: null, showsAddress: false });
    expect(older.text).toContain('older than the Bank');
    // An older node with a wallet (started with SSF_CHIA_LANE=1) shows its address as before.
    expect(bankWalletView(node(undefined, ADDR), IDLE)).toMatchObject({ showsAddress: true, button: null, text: '' });
    const unbuilt = bankWalletView(node({ state: 'unbuilt' }), { ...IDLE, armed: true });
    expect(unbuilt).toMatchObject({ button: null, showsAddress: false });
    expect(unbuilt.text).toContain('only reads the chain');
    const off = bankWalletView(node({ state: 'off' }), { ...IDLE, armed: true });
    expect(off).toMatchObject({ button: null, showsAddress: false });
    expect(off.text).toContain('SSF_CHIA_LANE');
    // On, but an address that did not parse: nothing to pay, and it says so.
    expect(bankWalletView(node({ state: 'on' }), IDLE)).toMatchObject({ button: null, showsAddress: false });
  });

  it('says why the last turn failed, the page\'s words over the node\'s', () => {
    expect(bankWalletView(node({ state: 'ready', error: 'disk full' }), IDLE).error).toBe('disk full');
    expect(bankWalletView(node({ state: 'ready', error: 'disk full' }), { ...IDLE, error: 'no answer' }).error).toBe('no answer');
    expect(bankWalletView(node({ state: 'on', error: 'not saved' }, ADDR), IDLE).error).toBe('not saved');
    expect(bankWalletView(node({ state: 'off' }), { ...IDLE, error: 'x' }).error).toBeNull();
  });
});

const BODY = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);

describe.each([TESTNET11, MAINNET])('bankWalletView on $name', (net) => {
  const on = (chia_wallet?: ChiaWalletSwitch, chia_address?: string, chia_net: ChiaNetwork | null = net): LocalFingerprint => ({
    ...node(chia_wallet, chia_address),
    chia_net,
  });
  const addr = addressOn(net, BODY);

  it('says which network the node is on, amber only where the coins are real money', () => {
    for (const fp of [on({ state: 'ready', mnemonic: true }), on({ state: 'on', stays: true }, addr), on({ state: 'unbuilt' }), on()]) {
      const v = bankWalletView(fp, IDLE);
      expect(v.network?.warn).toBe(!net.test);
      expect(v.network?.text).toContain(`Network: ${net.name}.`);
      expect(v.network?.text).toContain(`(${net.ticker})`);
    }
    if (!net.test) expect(bankWalletView(on(), IDLE).network?.text).toBe('Network: Chia mainnet. Its coins (XCH) are real money.');
    // No node: no network to name.
    expect(bankWalletView(null, IDLE).network).toBeNull();
  });

  it('names the network in what turning on means', () => {
    // A node the desktop app started (`backup: native`): the one that may
    // make a new wallet on mainnet. On testnet11 `backup` changes nothing here.
    const armed = (w: ChiaWalletSwitch) => bankWalletView(on({ ...w, backup: 'native' }), { ...IDLE, armed: true }).warning ?? '';
    expect(armed({ state: 'ready', mnemonic: true })).toContain(`new ${net.name} key from 24 words`);
    expect(armed({ state: 'ready', mnemonic: true })).toContain(`Phone Book on ${net.chain}.`);
    expect(armed({ state: 'ready' })).toContain(`a ${net.name} key you cannot write down`);
    expect(armed({ state: 'ready', legacy: true })).toContain(`its ${net.coins} stay at its old address`);
    expect(armed({ state: 'ready', seed: true })).toContain(`Phone Book on ${net.chain}.`);
    expect(bankWalletView(on({ state: 'on', reminted: true }, addr), IDLE).notice).toContain(`old wallet's ${net.coins}`);
    expect(bankWalletView(on({ state: 'on' }), IDLE).text).toContain(`did not read as a ${net.name} address`);
  });

  it('shows the address of an on wallet with its own prefix', () => {
    expect(bankWalletView(on({ state: 'on', stays: true }, addr), IDLE)).toMatchObject({ showsAddress: true, button: { act: 'off' } });
  });

  it('offers CREATE where the node may make a new wallet: on a test network, or for the desktop app that started it', () => {
    for (const backup of ['native', 'page', 'none', undefined] as const) {
      const w: ChiaWalletSwitch = { state: 'ready', mnemonic: true, ...(backup ? { backup } : {}) };
      const mints = net.test || backup === 'native';
      for (const ui of [IDLE, { ...IDLE, armed: true }]) {
        const v = bankWalletView(on(w), ui);
        if (mints) {
          expect(v.button?.act).toBe(ui.armed ? 'confirm' : 'arm');
        } else {
          // Mainnet, the app's channel off: the node would refuse the mint.
          expect(v).toMatchObject({ button: null, showsAddress: false, warning: null, text: createInAppText(net) });
          expect(v.network?.warn).toBe(true);
        }
      }
      // A wallet already on disk loads on any network, whoever started the node.
      expect(bankWalletView(on({ state: 'ready', mnemonic: true, seed: true, ...(backup ? { backup } : {}) }), IDLE).button).toMatchObject({ act: 'arm', label: 'TURN ON SSF WALLET' });
    }
    expect(createInAppText(MAINNET)).toBe('On Chia mainnet your station node makes a new SSF wallet only when the Star Station desktop app started it, so the app can show its 24 words.');
    // The node's own refusal of a turn still shows under the line.
    if (!net.test) expect(bankWalletView(on({ state: 'ready', mnemonic: true, backup: 'none', error: 'x' }), IDLE).error).toBe('x');
  });

  it('promises a mojo from the faucet dish only on a test network', () => {
    const warning = bankWalletView(on({ state: 'ready', mnemonic: true, backup: 'native' }), { ...IDLE, armed: true }).warning ?? '';
    expect(warning.includes('faucet')).toBe(net.test);
  });

  it('reads an older mainnet node, which sent `gated`, as an older node with no switch', () => {
    // The fingerprint parse drops `gated` (nodeFingerprint.ts), so the Bank
    // sees no switch at all.
    const v = bankWalletView(on(), IDLE);
    expect(v).toMatchObject({ button: null, showsAddress: false, warning: null });
    if (net.test) {
      expect(v.text).toContain('SSF_CHIA_LANE=1');
    } else {
      expect(v.text).toBe(olderNodeText(net));
      expect(v.text).toBe('Your station node is older than this page and makes no SSF wallet on Chia mainnet: update Star Station.');
      expect(v.text).not.toContain('SSF_CHIA_LANE');
    }
  });

  it('shows a mainnet wallet that is on, with its address, as on testnet11', () => {
    for (const backup of ['native', 'none'] as const) {
      const v = bankWalletView(on({ state: 'on', stays: true, mnemonic: true, backup }, addr), IDLE);
      expect(v).toMatchObject({ showsAddress: true, button: { act: 'off', label: 'TURN OFF' } });
      expect(v.text).toBe('SSF wallet on — it comes back on whenever your node starts.');
    }
  });

  it('shows no address and no switch on a network the page does not know', () => {
    for (const w of [{ state: 'on', stays: true }, { state: 'ready', mnemonic: true }, undefined] as (ChiaWalletSwitch | undefined)[]) {
      const v = bankWalletView(on(w, addr, null), { ...IDLE, armed: true });
      expect(v).toMatchObject({ button: null, showsAddress: false, warning: null, network: null, text: UNKNOWN_NETWORK_TEXT });
    }
    expect(UNKNOWN_NETWORK_TEXT).toBe('Your node runs on a Chia network this page does not know, so the Bank shows no address.');
  });

  it('writes the note under the address for this network, with no em-dash', () => {
    const note = receiveNote(net);
    expect(`${note.lead} ${note.text}`).not.toContain('—');
    if (net.test) {
      expect(note.lead).toBe('testnet11 only.');
      expect(note.text).toContain('a testnet faucet gives TXCH for free');
      expect(note.text).toContain('for good');
    } else {
      expect(note.lead).toBe('Real XCH.');
      expect(note.text).toContain('real XCH');
      // Zero-fee spends may stall on mainnet: no promise that one coin lasts.
      expect(note.text).not.toContain('for good');
      expect(note.text).not.toContain('faucet');
    }
  });
});

const answer = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('turnSsfWallet', () => {
  it('POSTs a simple request to the node\'s own origin, refusing redirects', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { ok: true, wallet: { state: 'on' } }));
    await expect(turnSsfWallet('http://127.0.0.1:8081', true, fetchImpl as unknown as typeof fetch)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8081/api/chia/wallet?on=1');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    await turnSsfWallet('http://127.0.0.1:8080', false, fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe('http://127.0.0.1:8080/api/chia/wallet?on=0');
  });

  it('brings back the node\'s own refusal, or words what the page saw', async () => {
    const said = async (res: Response) => turnSsfWallet('http://127.0.0.1:8080', true, (async () => res) as unknown as typeof fetch);
    expect(await said(answer(409, { ok: false, error: '  the SSF wallet is switched off  ' }))).toEqual({ ok: false, error: 'the SSF wallet is switched off' });
    expect(await said(answer(403, { ok: false }))).toEqual({ ok: false, error: 'your station node answered 403' });
    expect(await said(answer(500, 'not json'))).toEqual({ ok: false, error: 'your station node answered 500' });
    expect(await said(answer(200, { ok: 'yes' }))).toEqual({ ok: false, error: 'your station node answered 200' });
    expect((await said(answer(409, { ok: false, error: 'x'.repeat(900) })) as { error: string }).error).toHaveLength(400);
    const older = await said(new Response('', { status: 404 }));
    expect(older).toEqual({ ok: false, error: "your station node is older than the Bank's wallet switch: update Star Station" });
  });

  it('never throws: no origin, an unreachable node, or no answer in time', async () => {
    const never = vi.fn();
    expect(await turnSsfWallet('', true, never as unknown as typeof fetch)).toEqual({ ok: false, error: 'your station node is not answering' });
    expect(never).not.toHaveBeenCalled();
    const unreachable = async () => { throw new TypeError('Failed to fetch'); };
    expect(await turnSsfWallet('http://127.0.0.1:8080', true, unreachable as unknown as typeof fetch)).toEqual({ ok: false, error: 'your station node could not be reached' });
    const hangs = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const late = await turnSsfWallet('http://127.0.0.1:8080', true, hangs as unknown as typeof fetch, 20);
    expect(late.ok).toBe(false);
    expect((late as { error: string }).error).toContain('did not answer in time');
    // Headers in time, the body not: still a timeout, not "answered 200".
    const trickles = async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }) as unknown as Response;
    const slowBody = await turnSsfWallet('http://127.0.0.1:8080', true, trickles as unknown as typeof fetch, 20);
    expect((slowBody as { error: string }).error).toContain('did not answer in time');
  });
});
