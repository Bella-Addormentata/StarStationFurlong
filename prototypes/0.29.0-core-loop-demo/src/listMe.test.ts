/**
 * 📖 LIST ME in the SpacePhone's Network rows: what stands under the PHONE
 * BOOK row from the node's fingerprint (`chia_listing`), what turning it on
 * shows the world, how the page asks the node to turn it, and main.ts's and
 * index.html's wiring.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MAINNET, TESTNET11 } from './chiaNetwork';
import {
  LIST_ME_BUTTON_ID, LIST_ME_NO_WALLET, LIST_ME_TIMEOUT_MS, listMeChiaOffNote, listMeChiaOffOnNote, listMeDamagedNote, listMeDefaultOffNote,
  listMeHeldNote, listMeOffNote, listMeOnNote, listMeRow, listMeTurnOf, listMeWarning, turnListMe, type ListMeUi,
} from './listMe';
import type { ChiaLane, ChiaListing, ChiaWalletSwitch, LocalFingerprint } from './nodeFingerprint';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443, chia_net: TESTNET11 };
const IDLE: ListMeUi = { armed: false, turning: null, error: null };
const NOTHING = { note: null, warning: null, error: null, button: null };

const LIST: NonNullable<ReturnType<typeof listMeRow>['button']> = { act: 'arm', label: 'LIST ME', danger: false, busy: false };
const CONFIRM: typeof LIST = { act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false };
const UNLIST: typeof LIST = { act: 'off', label: 'UNLIST ME', danger: false, busy: false };
const LISTING: typeof LIST = { act: 'confirm', label: 'LISTING…', danger: false, busy: true };
const UNLISTING: typeof LIST = { act: 'confirm', label: 'UNLISTING…', danger: false, busy: true };

describe('listMeRow, with no switch to show', () => {
  it('shows nothing while the node does not answer', () => {
    for (const none of [null, undefined]) {
      expect(listMeRow(none, IDLE)).toEqual(NOTHING);
      // Nor a failure, nor a button for a turn that was in flight: there is no node to send one to.
      expect(listMeRow(none, { armed: true, turning: 'on', error: 'x' })).toEqual(NOTHING);
    }
  });

  it("shows only a failed turn's words for a node with no switch", () => {
    // An older node, or a build that only reads the chain: the PHONE BOOK row says why nothing is listed.
    for (const chia_net of [TESTNET11, MAINNET, null]) {
      expect(listMeRow({ ...BASE, chia_net }, IDLE)).toEqual(NOTHING);
      expect(listMeRow({ ...BASE, chia_net, chia_wallet: { state: 'on' } }, { armed: true, turning: 'on', error: null })).toEqual(NOTHING);
      expect(listMeRow({ ...BASE, chia_net }, { ...IDLE, error: 'your station node is older than LIST ME: update Star Station' }))
        .toEqual({ ...NOTHING, error: 'your station node is older than LIST ME: update Star Station' });
    }
  });
});

describe.each([TESTNET11, MAINNET])('listMeRow on $name', (net) => {
  const fp = (chia_listing: ChiaListing, over: Partial<LocalFingerprint> = {}): LocalFingerprint => ({ ...BASE, chia_net: net, chia_listing, ...over });
  const OFF_DEFAULT: ChiaListing = { on: false, chosen: false };
  const OFF: ChiaListing = { on: false, chosen: true };
  const ON: ChiaListing = { on: true, chosen: true };
  const DAMAGED: ChiaListing = { on: false, chosen: false, damaged: true };

  it('offers LIST ME where it is off, then CONFIRM with what a listing shows the world, then shows it listing', () => {
    const notes: [ChiaListing, string][] = [[OFF_DEFAULT, listMeDefaultOffNote(net)], [OFF, listMeOffNote(net)], [DAMAGED, listMeDamagedNote(net)]];
    for (const [listing, note] of notes) {
      expect(listMeRow(fp(listing), IDLE)).toEqual({ note, warning: null, error: null, button: LIST });
      expect(listMeRow(fp(listing), { ...IDLE, armed: true })).toEqual({ note, warning: listMeWarning(net), error: null, button: CONFIRM });
      // In flight: the button says so and is inert, and the warning is gone, armed or not.
      for (const armed of [false, true]) {
        expect(listMeRow(fp(listing), { armed, turning: 'on', error: null })).toEqual({ note, warning: null, error: null, button: LISTING });
      }
      // The wallet changes nothing of an off switch.
      for (const state of ['on', 'ready'] as const) {
        expect(listMeRow(fp(listing, { chia_wallet: { state } }), IDLE)).toEqual({ note, warning: null, error: null, button: LIST });
      }
    }
    // The environment holding the listing off: a turn on writes only the knocks, and CONFIRM says so first.
    const held = listMeRow(fp({ ...OFF, held: true }), { ...IDLE, armed: true });
    expect(held.warning).toBe(listMeWarning(net, true));
    expect(held.warning).toContain("While SSF_CHIA_FINDABLE=0 in your node's environment holds its listing off, only the knocks are written. Tap CONFIRM.");
    expect(listMeWarning(net)).not.toContain('SSF_CHIA_FINDABLE');
  });

  it('offers UNLIST ME where it is on, with no CONFIRM, and says what still waits', () => {
    const on = listMeRow(fp(ON), IDLE);
    expect(on).toEqual({ note: listMeOnNote(net), warning: null, error: null, button: UNLIST });
    // Turning off only stops writes: nothing to confirm, whatever was armed.
    expect(listMeRow(fp(ON), { ...IDLE, armed: true })).toEqual(on);
    // The network's default on reads the same as the player's word.
    expect(listMeRow(fp({ on: true, chosen: false }), IDLE)).toEqual(on);
    expect(listMeRow(fp(ON), { ...IDLE, turning: 'off' })).toEqual({ ...on, button: UNLISTING });
    // No publisher runs without the SSF wallet on, whoever pays.
    const waits: [ChiaWalletSwitch, boolean][] = [[{ state: 'ready' }, true], [{ state: 'ready', seed: true }, true], [{ state: 'off' }, true], [{ state: 'on' }, false], [{ state: 'on', stays: true }, false]];
    for (const [chia_wallet, waiting] of waits) {
      expect(listMeRow(fp(ON, { chia_wallet }), IDLE).note).toBe(waiting ? `${listMeOnNote(net)} ${LIST_ME_NO_WALLET}` : listMeOnNote(net));
    }
    // The environment holds the listing off: the switch cannot change that, and still turns off.
    for (const chia_wallet of [undefined, { state: 'ready' }, { state: 'on' }] as (ChiaWalletSwitch | undefined)[]) {
      expect(listMeRow(fp({ ...ON, held: true }, chia_wallet ? { chia_wallet } : {}), IDLE)).toEqual({ note: listMeHeldNote(net), warning: null, error: null, button: UNLIST });
    }
  });

  it('takes an off, and offers no on, while Chia is off on this computer', () => {
    const lanes: ChiaLane[] = [{ off: true, source: 'env', setting: 'on' }, { off: true, source: 'setting', setting: 'off' }, { off: true }];
    for (const chia_lane of lanes) {
      for (const listing of [ON, { ...ON, held: true as const }]) {
        expect(listMeRow(fp(listing, { chia_lane }), { ...IDLE, armed: true })).toEqual({ note: listMeChiaOffOnNote(net), warning: null, error: null, button: UNLIST });
        expect(listMeRow(fp(listing, { chia_lane }), { ...IDLE, turning: 'off' }).button).toEqual(UNLISTING);
      }
      // The node refuses an on until Chia is back, so none is offered, armed or not.
      for (const listing of [OFF_DEFAULT, OFF, DAMAGED]) {
        for (const armed of [false, true]) {
          expect(listMeRow(fp(listing, { chia_lane }), { ...IDLE, armed })).toEqual({ note: listMeChiaOffNote(net), warning: null, error: null, button: null });
        }
      }
    }
    // Chia on: the switch as before.
    expect(listMeRow(fp(OFF, { chia_lane: { off: false, setting: 'on' } }), IDLE)).toEqual(listMeRow(fp(OFF), IDLE));
  });

  it("carries a failed turn's words under every state", () => {
    const ui: ListMeUi = { ...IDLE, error: 'Chia is off on this computer, so LIST ME cannot be turned on; turn Chia back on first' };
    for (const listing of [OFF_DEFAULT, OFF, ON, DAMAGED, { ...ON, held: true as const }]) {
      expect(listMeRow(fp(listing), ui).error).toBe(ui.error);
      expect(listMeRow(fp(listing, { chia_lane: { off: true } }), ui).error).toBe(ui.error);
    }
  });

  it('names the network, and the payer only where the SSF wallet never is one', () => {
    const texts = [
      listMeOnNote(net), listMeHeldNote(net), listMeDefaultOffNote(net), listMeOffNote(net), listMeDamagedNote(net), listMeChiaOffOnNote(net),
      listMeChiaOffNote(net), listMeWarning(net), listMeWarning(net, true),
    ];
    for (const text of texts) {
      expect(text).toContain(net.name);
      expect(text).not.toContain('—');
      expect(text).not.toContain('the Chia network your node runs on');
    }
    // Off a test network each write has a key of its own that the lobby dish pays for.
    for (const text of [listMeOnNote(net), listMeWarning(net)]) {
      expect(text.includes('a key of its own that the lobby dish pays for, never from your SSF wallet')).toBe(!net.test);
      expect(text).toContain('Only holders of your contact card can read your addresses.');
      expect(text).toContain('once an edition (about a week)');
      expect(text).toContain('a knock on a host it holds a card for and cannot reach');
    }
    // On a test network the SSF wallet may be the payer, and the warning says what that shows.
    expect(listMeWarning(net).includes('(on a test network your SSF wallet may pay for a write, which shows its address)')).toBe(net.test);
    expect(listMeWarning(net)).toContain('Anyone can see that some Star Station node wrote, and when');
    expect(listMeWarning(net)).toContain('the Chia full nodes your node talks to see its IP address');
    expect(listMeWarning(net)).toContain('what is written stays on the chain');
    expect(listMeWarning(net).endsWith(' Tap CONFIRM.')).toBe(true);
    // Turned off, nothing is withdrawn, and the note says how long readers still find a listing.
    expect(listMeOffNote(net)).toContain('What it wrote before stays on the chain; readers stop finding a listing once its edition and the next have passed.');
  });
});

describe('the LIST ME texts, whole', () => {
  it('reads so on mainnet, where LIST ME starts off', () => {
    expect(listMeDefaultOffNote(MAINNET)).toBe('LIST ME is off for Chia mainnet, where it starts off: your station writes no Phone Book listing and no knock there until you turn it on here.');
    expect(listMeWarning(MAINNET)).toBe(
      'List this station in the Phone Book on Chia mainnet? Your node then writes its listing there once an edition (about a week), and a knock on a host it holds a card for and cannot reach. Each is written from a key of its own that the lobby dish pays for, never from your SSF wallet. Only holders of your contact card can read your addresses. Anyone can see that some Star Station node wrote, and when; the Chia full nodes your node talks to see its IP address; and what is written stays on the chain. Tap CONFIRM.',
    );
    expect(listMeOnNote(MAINNET)).toBe(
      'LIST ME is on for Chia mainnet: your station writes its Phone Book listing there once an edition (about a week), and a knock on a host it holds a card for and cannot reach, each from a key of its own that the lobby dish pays for, never from your SSF wallet. Only holders of your contact card can read your addresses.',
    );
  });

  it('reads so on testnet11, where it starts on', () => {
    expect(listMeOnNote(TESTNET11)).toBe(
      'LIST ME is on for testnet11: your station writes its Phone Book listing there once an edition (about a week), and a knock on a host it holds a card for and cannot reach. Only holders of your contact card can read your addresses.',
    );
    expect(listMeOffNote(TESTNET11)).toBe(
      'LIST ME is off for testnet11: your station writes no Phone Book listing and no knock there. What it wrote before stays on the chain; readers stop finding a listing once its edition and the next have passed.',
    );
    expect(listMeHeldNote(TESTNET11)).toBe("LIST ME is on for testnet11, but SSF_CHIA_FINDABLE=0 in your node's environment holds its listing off, and the switch here cannot change that. Its knocks are still written.");
    expect(listMeDamagedNote(TESTNET11)).toBe(
      'The saved LIST ME switch could not be read, and a switch that cannot be read counts as off: your station writes no Phone Book listing and no knock on testnet11. Turned on here, it is saved anew.',
    );
    expect(listMeChiaOffOnNote(TESTNET11)).toBe('LIST ME is on for testnet11, but Chia is off on this computer, so your station writes nothing to the Phone Book until Chia is back on.');
    expect(listMeChiaOffNote(TESTNET11)).toBe('LIST ME is off for testnet11. It can be turned on once Chia is back on on this computer.');
    expect(LIST_ME_NO_WALLET).toBe("Nothing is written until the SSF wallet is on (the SpacePhone's 🏦 BANK).");
  });

  it('names no network it does not know, and promises no payer there', () => {
    for (const text of [listMeOnNote(null), listMeDefaultOffNote(null), listMeWarning(null)]) {
      expect(text).toContain('the Chia network your node runs on');
      expect(text).not.toContain('lobby dish');
    }
    // An unknown network may be a test one: the wallet may pay there.
    expect(listMeWarning(null)).toContain('your SSF wallet may pay for a write');
    expect(listMeRow({ ...BASE, chia_net: null, chia_listing: { on: false, chosen: false } }, IDLE)).toEqual({ note: listMeDefaultOffNote(null), warning: null, error: null, button: LIST });
  });
});

describe('listMeTurnOf', () => {
  it('turns on only from CONFIRM, off from UNLIST ME, and nothing from LIST ME', () => {
    expect(listMeTurnOf('confirm')).toBe(true);
    expect(listMeTurnOf('off')).toBe(false);
    for (const act of ['arm', '', 'on', 'keep', 'CONFIRM', undefined]) expect(listMeTurnOf(act)).toBeNull();
  });
});

const answer = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('turnListMe', () => {
  it("POSTs a simple request to the node's own origin, refusing redirects", async () => {
    const fetchImpl = vi.fn(async () => answer(200, { ok: true, listing: { on: true, chosen: true } }));
    await expect(turnListMe('http://127.0.0.1:8081', true, fetchImpl as unknown as typeof fetch)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8081/api/chia/listing?on=1');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    await turnListMe('http://127.0.0.1:8080', false, fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe('http://127.0.0.1:8080/api/chia/listing?on=0');
    expect(LIST_ME_TIMEOUT_MS).toBe(15_000);
  });

  it("brings back the node's own refusal, or words what the page saw", async () => {
    const said = async (res: Response) => turnListMe('http://127.0.0.1:8080', true, (async () => res) as unknown as typeof fetch);
    const chiaOff = 'Chia is off on this computer, so LIST ME cannot be turned on; turn Chia back on first';
    expect(await said(answer(409, { ok: false, error: `  ${chiaOff}  `, listing: { on: false, chosen: false } }))).toEqual({ ok: false, error: chiaOff });
    const pageOnly = "only this computer's own Star Station page can turn LIST ME on or off";
    expect(await said(answer(403, { ok: false, error: pageOnly }))).toEqual({ ok: false, error: pageOnly });
    expect(await said(answer(403, { ok: false }))).toEqual({ ok: false, error: 'your station node answered 403' });
    expect(await said(answer(500, 'not json'))).toEqual({ ok: false, error: 'your station node answered 500' });
    // A 200 that does not say ok is no turn.
    expect(await said(answer(200, { ok: 'yes' }))).toEqual({ ok: false, error: 'your station node answered 200' });
    expect(await said(answer(200, { listing: { on: true, chosen: true } }))).toEqual({ ok: false, error: 'your station node answered 200' });
    expect((await said(answer(409, { ok: false, error: 'x'.repeat(900) })) as { error: string }).error).toHaveLength(400);
    expect(await said(new Response('', { status: 404 }))).toEqual({ ok: false, error: 'your station node is older than LIST ME: update Star Station' });
  });

  it('never throws: no origin, an unreachable node, or no answer in time', async () => {
    const never = vi.fn();
    expect(await turnListMe('', true, never as unknown as typeof fetch)).toEqual({ ok: false, error: 'your station node is not answering' });
    expect(never).not.toHaveBeenCalled();
    const unreachable = async () => { throw new TypeError('Failed to fetch'); };
    expect(await turnListMe('http://127.0.0.1:8080', true, unreachable as unknown as typeof fetch)).toEqual({ ok: false, error: 'your station node could not be reached' });
    const hangs = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    expect(await turnListMe('http://127.0.0.1:8080', true, hangs as unknown as typeof fetch, 20)).toEqual({
      ok: false, error: 'your station node did not answer in time; it may still be turning LIST ME on, so look again in a moment',
    });
    expect(await turnListMe('http://127.0.0.1:8080', false, hangs as unknown as typeof fetch, 20)).toEqual({
      ok: false, error: 'your station node did not answer in time; it may still be turning LIST ME off, so look again in a moment',
    });
    // Headers in time, the body not: still a timeout, not "answered 200".
    const trickles = async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }) as unknown as Response;
    const slowBody = await turnListMe('http://127.0.0.1:8080', true, trickles as unknown as typeof fetch, 20);
    expect((slowBody as { error: string }).error).toContain('did not answer in time');
  });
});

describe('main.ts and index.html wire LIST ME', () => {
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const main = read('./main.ts');
  const html = read('../index.html');
  const css = read('./index-inline.css');
  const body = (head: string): string => {
    const at = main.indexOf(head);
    expect(at, head).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n}\n', at));
  };

  it('draws the switch from the node that answered, in both rounds of the fingerprint, and never with innerHTML', () => {
    const render = body('function renderListMeRow(): void {');
    expect(render).toContain('listMeRow(localNodeLive ? localFingerprint : null, { armed: listMeArmed, turning: listMeTurning, error: listMeError });');
    expect(render).toContain('getElementById(LIST_ME_BUTTON_ID)');
    for (const id of ['list-me-note', 'list-me-warning', 'list-me-error']) expect(render).toContain(`line("${id}", `);
    expect(render).not.toContain('innerHTML');
    // An inert button keeps focus: aria-disabled, never disabled.
    expect(render).toContain('btn.setAttribute("aria-disabled", "true");');
    expect(render).not.toContain('.disabled');
    const refresh = body('async function refreshLocalFingerprint(');
    const gone = refresh.indexOf('renderPhoneBookIndicator(null);');
    const live = refresh.indexOf('renderPhoneBookIndicator(fingerprint);');
    expect(gone).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(gone);
    expect(refresh.indexOf('renderListMeRow();', gone)).toBeLessThan(live);
    expect(refresh.indexOf('renderListMeRow();', live)).toBeGreaterThan(live);
    // A node that went leaves no CONFIRM armed for the next one.
    expect(refresh.slice(0, gone)).toContain('listMeArmed = false;');
  });

  it('repaints the Bank when LIST ME turns', () => {
    const refresh = body('async function refreshLocalFingerprint(');
    expect(refresh).toContain('localFingerprint?.chia_lane ?? null, localFingerprint?.chia_listing ?? null]');
    expect(refresh).toContain('fingerprint.chia_lane ?? null, fingerprint.chia_listing ?? null]');
    // And the Bank draws its line through the escaper, under the network line.
    expect(main).toContain('${esc(wv.listing)}</div>`');
    expect(main).toContain('const switchHtml = `${networkHtml}${listingHtml}');
  });

  it('takes a fresh tap for CONFIRM and UNLIST ME, no held key, and no tap while a turn is in flight', () => {
    const at = main.indexOf('document.getElementById(LIST_ME_BUTTON_ID) as HTMLButtonElement | null;\n  if (listBtn)');
    expect(at).toBeGreaterThan(0);
    const wiring = main.slice(at, main.indexOf("// The view's own ↑/↓ traversal", at));
    expect(wiring).toContain('if (listBtn.getAttribute("aria-disabled") === "true") return;');
    expect(wiring).toContain('if (act !== "arm" && !freshTap((e as MouseEvent).detail, performance.now(), listMeChangedAt)) return;');
    expect(wiring).toContain('if (laneKeyRepeat(e)) e.preventDefault();');
    expect(wiring).toContain('const on = listMeTurnOf(act);\n      if (on !== null) void turnListMeSwitch(on);');
    // Arming sends nothing.
    const arm = wiring.slice(wiring.indexOf('if (act === "arm") {'), wiring.indexOf('const on = listMeTurnOf(act);'));
    expect(arm).toContain('listMeArmed = true;');
    expect(arm).toContain('return;');
    expect(arm).not.toContain('turnListMe');
  });

  it('reads the fingerprint again after a turn, and starts each visit to the view disarmed', () => {
    const turn = body('async function turnListMeSwitch(on: boolean): Promise<void> {');
    expect(turn).toContain('if (listMeTurning) return;');
    expect(turn).toContain('listMeArmed = false;');
    expect(turn).toContain('await turnListMe(localNodeOrigin, on);');
    expect(turn).toContain('listMeError = turned.ok ? null : turned.error;');
    expect(turn.indexOf('await refreshLocalFingerprint();')).toBeGreaterThan(turn.indexOf('await turnListMe('));
    const opened = main.indexOf('if (id === "setnet") {');
    expect(opened).toBeGreaterThan(0);
    const visit = main.slice(opened, main.indexOf('phone-app-settings-network', opened));
    expect(visit).toContain('listMeArmed = false;\n      if (!listMeTurning) listMeError = null;\n      renderListMeRow();');
  });

  it('stands under the PHONE BOOK row as one button whose words main.ts writes', () => {
    const row = html.indexOf('id="network-phone-book"');
    const detail = html.indexOf('<div class="chia-lane-detail" id="list-me-detail">');
    const bridge = html.indexOf('id="network-bridge-status"');
    expect(row).toBeGreaterThan(0);
    expect(detail).toBeGreaterThan(row);
    expect(bridge).toBeGreaterThan(detail);
    const block = html.slice(detail, html.indexOf('</div>\n        <div class="network-row">', detail));
    expect(LIST_ME_BUTTON_ID).toBe('list-me-switch');
    expect(block).toContain('<div id="list-me-note" hidden></div>');
    expect(block).toContain(`<button type="button" id="${LIST_ME_BUTTON_ID}" hidden aria-describedby="list-me-note list-me-warning"></button>`);
    expect(block).toContain('<div id="list-me-warning" hidden></div>');
    expect(block).toContain('<div id="list-me-error" role="status" hidden></div>');
    // One of each in the page.
    for (const id of ['list-me-note', 'list-me-switch', 'list-me-warning', 'list-me-error']) {
      expect(html.split(`id="${id}"`).length - 1, id).toBe(1);
    }
    // Styled as the CHIA switch is: danger and busy follow its attributes.
    for (const rule of ['#list-me-switch {', '#list-me-switch[hidden],', '#list-me-switch[data-danger="true"] {', '#list-me-switch[aria-busy="true"] {', '#list-me-warning {', '#list-me-error {']) {
      expect(css, rule).toContain(rule);
    }
  });
});
