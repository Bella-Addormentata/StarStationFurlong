/**
 * 🏦 The SSF wallet switch in the Bank: what RECEIVE says and offers from the
 * node's fingerprint, and how the page asks the node to turn the wallet.
 */
import { describe, expect, it, vi } from 'vitest';
import { bankWalletView, turnSsfWallet, type BankWalletUi } from './bankWallet';
import type { ChiaWalletSwitch, LocalFingerprint } from './nodeFingerprint';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443 };
const ADDR = 'txch1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2).slice(0, 58);
const IDLE: BankWalletUi = { armed: false, turning: false, error: null };
const node = (chia_wallet?: ChiaWalletSwitch, chia_address?: string): LocalFingerprint => ({
  ...BASE,
  ...(chia_wallet ? { chia_wallet } : {}),
  ...(chia_address ? { chia_address } : {}),
});

describe('bankWalletView', () => {
  it('offers CREATE, then CONFIRM with what turning on means, then shows it turning', () => {
    const fresh = bankWalletView(node({ state: 'ready' }), IDLE);
    expect(fresh).toMatchObject({ showsAddress: false, warning: null, button: { act: 'arm', label: 'CREATE SSF WALLET', danger: false, busy: false } });
    expect(fresh.text).toContain('no SSF wallet yet');
    const armed = bankWalletView(node({ state: 'ready' }), { ...IDLE, armed: true });
    expect(armed.button).toEqual({ act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false });
    expect(armed.warning).toContain('new testnet11 key');
    expect(armed.warning).toContain('Phone Book');
    const turning = bankWalletView(node({ state: 'ready' }), { ...IDLE, armed: true, turning: true });
    expect(turning.button).toMatchObject({ label: 'TURNING ON…', busy: true });
    expect(turning.warning).toBeNull();
  });

  it('says TURN ON, not CREATE, when the node kept a wallet from before', () => {
    const v = bankWalletView(node({ state: 'ready', seed: true }), IDLE);
    expect(v.button?.label).toBe('TURN ON SSF WALLET');
    expect(v.text).toContain('wallet from before');
    expect(bankWalletView(node({ state: 'ready', seed: true }), { ...IDLE, armed: true }).warning).toContain('same address');
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
