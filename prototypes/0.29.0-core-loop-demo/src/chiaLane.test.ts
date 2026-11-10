/**
 * ⛓️ The Chia switch in the SpacePhone's Network rows: what the CHIA row says
 * and offers from the node's fingerprint (`chia_lane`), why Chia is off in
 * the words the Bank, the Phone Book row and the dish carry on with, how the
 * page asks the node to turn Chia off or back on, and main.ts's wiring.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  CHIA_LANE_BUTTON_ID, LANE_ARMED_WARNING, LANE_DAMAGED_NOTE, LANE_ENV_DAMAGED_NOTE, LANE_ENV_NOTE, LANE_ENV_OLDER_NOTE,
  LANE_ENV_SAVED_NOTE, LANE_ENV_STUCK_NOTE, LANE_NO_NODE_COLOUR, LANE_OFF_COLOUR, LANE_OFF_UNKNOWN_NOTE, LANE_OLDER_NODE, LANE_ON_COLOUR,
  LANE_ON_NOTE, LANE_SAVING_NOTE, LANE_SETTING_OFF_NOTE, LANE_STUCK_NOTE, LANE_UNKNOWN_COLOUR, LANE_UNTIL_RESTART_NOTE, chiaBackOn,
  chiaLaneRow, chiaOffWhy, laneKeyRepeat, laneTurnOf, meshFeedback, shareCardFeedback, turnChiaLane, type ChiaLaneUi,
} from './chiaLane';
import { TESTNET11 } from './chiaNetwork';
import { isFlightKey } from './freeFlightStick';
import type { ChiaLane, LocalFingerprint } from './nodeFingerprint';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443, chia_net: TESTNET11 };
const IDLE: ChiaLaneUi = { armed: false, turning: null, error: null };
const node = (chia_lane?: ChiaLane): LocalFingerprint => ({ ...BASE, ...(chia_lane ? { chia_lane } : {}) });

const ON: ChiaLane = { off: false, setting: 'on' };
const SETTING_OFF: ChiaLane = { off: true, source: 'setting', setting: 'off' };
const DAMAGED: ChiaLane = { off: true, source: 'setting', setting: 'off', damaged: true };
const UNTIL_RESTART: ChiaLane = { off: true, source: 'setting', setting: 'on' };
const ENV: ChiaLane = { off: true, source: 'env', setting: 'on' };
const ENV_SAVED: ChiaLane = { off: true, source: 'env', setting: 'off' };
const ENV_DAMAGED: ChiaLane = { off: true, source: 'env', setting: 'off', damaged: true };
// A folder where the switch's file goes, which the node cannot remove.
const STUCK: ChiaLane = { off: true, source: 'setting', setting: 'off', damaged: true, stuck: true };
const ENV_STUCK: ChiaLane = { off: true, source: 'env', setting: 'off', damaged: true, stuck: true };

describe('chiaLaneRow', () => {
  it('says NO NODE, with no switch, while the node does not answer', () => {
    for (const none of [null, undefined]) {
      expect(chiaLaneRow(none, IDLE)).toEqual({ value: 'NO NODE', colour: LANE_NO_NODE_COLOUR, note: null, warning: null, error: null, button: null });
    }
  });

  it('offers no switch to a node older than it, and says what it can', () => {
    // Older than the strict lane: no chia_lane at all.
    expect(chiaLaneRow(node(), IDLE)).toEqual({ value: 'NO SWITCH', colour: LANE_UNKNOWN_COLOUR, note: LANE_OLDER_NODE, warning: null, error: null, button: null });
    // The lane, not the switch: no `setting`.
    expect(chiaLaneRow(node({ off: false }), IDLE)).toEqual({ value: 'ON', colour: LANE_ON_COLOUR, note: LANE_OLDER_NODE, warning: null, error: null, button: null });
    expect(chiaLaneRow(node({ off: true, source: 'env' }), IDLE)).toEqual({ value: 'OFF', colour: LANE_OFF_COLOUR, note: LANE_ENV_OLDER_NOTE, warning: null, error: null, button: null });
    expect(chiaLaneRow(node({ off: true }), IDLE)).toMatchObject({ value: 'OFF', note: LANE_OFF_UNKNOWN_NOTE, button: null });
    // Arming or a turn in flight changes nothing there: there is no route.
    expect(chiaLaneRow(node({ off: false }), { armed: true, turning: 'off', error: null }).button).toBeNull();
    expect(LANE_OLDER_NODE).toBe('Your station node is older than this switch: update Star Station to turn Chia off here.');
  });

  it('offers TURN CHIA OFF, then CONFIRM with what turning off means, then shows it turning', () => {
    const fresh = chiaLaneRow(node(ON), IDLE);
    expect(fresh).toEqual({ value: 'ON', colour: LANE_ON_COLOUR, note: LANE_ON_NOTE, warning: null, error: null, button: { act: 'arm', label: 'TURN CHIA OFF', danger: false, busy: false } });
    const armed = chiaLaneRow(node(ON), { ...IDLE, armed: true });
    expect(armed.button).toEqual({ act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false });
    expect(armed.warning).toBe(LANE_ARMED_WARNING);
    expect(armed.value).toBe('ON');
    // At once, every network, and back on only at the next start.
    expect(LANE_ARMED_WARNING).toContain('at once');
    expect(LANE_ARMED_WARNING).toContain('on every Chia network');
    expect(LANE_ARMED_WARNING).toContain('no Phone Book, no knocks, no faucet dish');
    expect(LANE_ARMED_WARNING).toContain("Turning Chia back on here takes effect at your node's next start.");
    expect(LANE_ARMED_WARNING.endsWith('Tap CONFIRM.')).toBe(true);
    const turning = chiaLaneRow(node(ON), { armed: false, turning: 'off', error: null });
    expect(turning.button).toEqual({ act: 'confirm', label: 'TURNING CHIA OFF…', danger: false, busy: true });
    expect(turning.warning).toBeNull();
    // A fingerprint read while the off is under way (the node holds Chia off
    // before it closes the lane) keeps the button saying what it does.
    expect(chiaLaneRow(node(SETTING_OFF), { armed: false, turning: 'off', error: null }).button).toEqual({ act: 'confirm', label: 'TURNING CHIA OFF…', danger: false, busy: true });
  });

  it('says what the in-game off holds, and offers it back on for the next start', () => {
    expect(chiaLaneRow(node(SETTING_OFF), IDLE)).toEqual({
      value: 'OFF', colour: LANE_OFF_COLOUR, note: LANE_SETTING_OFF_NOTE, warning: null, error: null,
      button: { act: 'on', label: 'TURN CHIA BACK ON', danger: false, busy: false },
    });
    expect(LANE_SETTING_OFF_NOTE).toContain("Turned back on, it comes on at your node's next start.");
    // Armed means nothing here: no CONFIRM for an on.
    expect(chiaLaneRow(node(SETTING_OFF), { ...IDLE, armed: true }).button?.act).toBe('on');
    expect(chiaLaneRow(node(SETTING_OFF), { armed: false, turning: 'on', error: null }).button).toEqual({ act: 'confirm', label: 'TURNING CHIA BACK ON…', danger: false, busy: true });
  });

  it('counts a switch it cannot read as off, and offers it back on', () => {
    expect(chiaLaneRow(node(DAMAGED), IDLE)).toEqual({
      value: 'OFF', colour: LANE_OFF_COLOUR, note: LANE_DAMAGED_NOTE, warning: null, error: null,
      button: { act: 'on', label: 'TURN CHIA BACK ON', danger: false, busy: false },
    });
    expect(LANE_DAMAGED_NOTE).toContain('could not be read');
    expect(LANE_DAMAGED_NOTE).toContain('counts as off');
  });

  it('offers no TURN CHIA BACK ON for a folder the node cannot remove, and says how Chia comes back', () => {
    expect(chiaLaneRow(node(STUCK), IDLE)).toEqual({ value: 'OFF', colour: LANE_OFF_COLOUR, note: LANE_STUCK_NOTE, warning: null, error: null, button: null });
    expect(chiaLaneRow(node(STUCK), { ...IDLE, armed: true }).button).toBeNull();
    expect(chiaLaneRow(node(ENV_STUCK), IDLE)).toEqual({ value: 'OFF', colour: LANE_OFF_COLOUR, note: LANE_ENV_STUCK_NOTE, warning: null, error: null, button: null });
    for (const note of [LANE_STUCK_NOTE, LANE_ENV_STUCK_NOTE]) {
      expect(note).toContain('counts as off');
      expect(note).toContain('the switch here cannot remove a folder');
      expect(note).toContain('once it is removed by hand');
      // Never the promise an on cannot keep.
      expect(note).not.toContain('Turned back on');
      expect(note).not.toContain('is removed and');
      expect(note).not.toContain('To turn the switch back on');
    }
    expect(LANE_STUCK_NOTE).toContain("Chia comes on at your node's next start");
    expect(LANE_ENV_STUCK_NOTE).toContain('Chia comes on at a start without SSF_NO_CHIA_LANE');
  });

  it('says off now, on at the next start, and offers to keep it off', () => {
    expect(chiaLaneRow(node(UNTIL_RESTART), IDLE)).toEqual({
      value: 'OFF until your node restarts', colour: LANE_OFF_COLOUR, note: LANE_UNTIL_RESTART_NOTE, warning: null, error: null,
      button: { act: 'keep', label: 'KEEP CHIA OFF', danger: false, busy: false },
    });
    expect(LANE_UNTIL_RESTART_NOTE).toBe("The switch here is on for your node's next start: Chia stays off until your node stops, and comes on at its next start (unless SSF_NO_CHIA_LANE is in its environment then).");
    expect(chiaLaneRow(node(UNTIL_RESTART), { armed: false, turning: 'keep', error: null }).button).toEqual({ act: 'confirm', label: 'KEEPING CHIA OFF…', danger: false, busy: true });
  });

  it('says what the switch is after an off whose save failed, never that it was turned back on', () => {
    // The node's 409 lane when the save failed and no switch is on disk
    // (chia_strict.rs after_failed_off): the same lane as after an on.
    const error = 'Chia is off now, but the switch could not be saved (No space left on device (os error 28)), so Chia comes back on at the next start';
    const failed = chiaLaneRow(node(UNTIL_RESTART), { ...IDLE, error });
    expect(failed).toMatchObject({ value: 'OFF until your node restarts', note: LANE_UNTIL_RESTART_NOTE, error, button: { act: 'keep', label: 'KEEP CHIA OFF' } });
    // The Network view opened again clears the error; the note still says only what the switch is.
    const later = chiaLaneRow(node(UNTIL_RESTART), IDLE);
    for (const words of [failed.note ?? '', later.note ?? '', chiaOffWhy(UNTIL_RESTART)]) {
      expect(words).not.toMatch(/turned back on|back on for/i);
      expect(words).toContain("on for your node's next start");
    }
  });

  it('says the environment holds Chia off, which the switch cannot change, and offers to save it off too', () => {
    expect(chiaLaneRow(node(ENV), IDLE)).toEqual({
      value: 'OFF', colour: LANE_OFF_COLOUR, note: LANE_ENV_NOTE, warning: null, error: null,
      button: { act: 'keep', label: 'TURN CHIA OFF HERE TOO', danger: false, busy: false },
    });
    // Saved off too: the node refuses an on while the environment holds it
    // off, so there is no button, and the note says how to get one.
    for (const [lane, note] of [[ENV_SAVED, LANE_ENV_SAVED_NOTE], [ENV_DAMAGED, LANE_ENV_DAMAGED_NOTE]] as const) {
      expect(chiaLaneRow(node(lane), IDLE)).toEqual({ value: 'OFF', colour: LANE_OFF_COLOUR, note, warning: null, error: null, button: null });
      expect(note).toContain('start your node without SSF_NO_CHIA_LANE');
    }
    expect(LANE_ENV_DAMAGED_NOTE).toContain('could not be read, which counts as off');
  });

  it('says only that Chia is off when the node names no source this page knows', () => {
    expect(chiaLaneRow(node({ off: true, setting: 'off' }), IDLE)).toEqual({ value: 'OFF', colour: LANE_OFF_COLOUR, note: LANE_OFF_UNKNOWN_NOTE, warning: null, error: null, button: null });
  });

  it('says the switch is saved off in the moment before the node holds Chia off', () => {
    expect(chiaLaneRow(node({ off: false, setting: 'off' }), IDLE)).toEqual({ value: 'ON', colour: LANE_ON_COLOUR, note: LANE_SAVING_NOTE, warning: null, error: null, button: null });
  });

  it('shows the last failure in every state, and never a button the state does not have', () => {
    const error = 'Chia is off now, but the switch could not be saved (disk full), so Chia comes back on at the next start';
    for (const fp of [null, node(), node({ off: false }), node(ON), node(SETTING_OFF), node(DAMAGED), node(STUCK), node(UNTIL_RESTART), node(ENV), node(ENV_SAVED), node(ENV_STUCK)]) {
      expect(chiaLaneRow(fp, { ...IDLE, error }).error).toBe(error);
      expect(chiaLaneRow(fp, IDLE).error).toBeNull();
    }
    const acts = (lane: ChiaLane | undefined) => [IDLE, { ...IDLE, armed: true }].map((ui) => chiaLaneRow(node(lane), ui).button?.act ?? null);
    expect(acts(ON)).toEqual(['arm', 'confirm']);
    expect(acts(SETTING_OFF)).toEqual(['on', 'on']);
    expect(acts(DAMAGED)).toEqual(['on', 'on']);
    expect(acts(UNTIL_RESTART)).toEqual(['keep', 'keep']);
    expect(acts(ENV)).toEqual(['keep', 'keep']);
    expect(acts(ENV_SAVED)).toEqual([null, null]);
    expect(acts(ENV_DAMAGED)).toEqual([null, null]);
    expect(acts(STUCK)).toEqual([null, null]);
    expect(acts(ENV_STUCK)).toEqual([null, null]);
    expect(acts(undefined)).toEqual([null, null]);
  });

  it('words every state for the player: no file names, no field names', () => {
    const lanes: (ChiaLane | undefined)[] = [undefined, { off: false }, { off: true, source: 'env' }, ON, SETTING_OFF, DAMAGED, STUCK, UNTIL_RESTART, ENV, ENV_SAVED, ENV_DAMAGED, ENV_STUCK];
    for (const lane of lanes) {
      for (const ui of [IDLE, { ...IDLE, armed: true }]) {
        const r = chiaLaneRow(node(lane), ui);
        const words = [r.value, r.note ?? '', r.warning ?? '', r.button?.label ?? ''].join(' ');
        expect(words).not.toMatch(/chia_lane|\.json|setting:|source/);
      }
    }
  });
});

describe('chiaOffWhy and chiaBackOn', () => {
  it('say why Chia is off, and how it comes back when the switch holds it off', () => {
    expect(chiaOffWhy(ENV)).toBe("Chia is off on this computer (SSF_NO_CHIA_LANE in your node's environment)");
    expect(chiaOffWhy(ENV_SAVED)).toBe(chiaOffWhy(ENV));
    expect(chiaOffWhy(SETTING_OFF)).toBe("Chia is off on this computer (turned off in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK)");
    expect(chiaOffWhy(DAMAGED)).toBe("Chia is off on this computer (its saved switch in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK could not be read, and a switch that cannot be read counts as off)");
    expect(chiaOffWhy(UNTIL_RESTART)).toBe("Chia is off on this computer for the rest of this run (its switch in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK is on for your node's next start)");
    expect(chiaOffWhy(STUCK)).toBe(chiaOffWhy(DAMAGED));
    expect(chiaOffWhy({ off: true })).toBe('Chia is off on this computer');
    const back = "Turning it back on there brings Chia back at your node's next start.";
    expect(chiaBackOn(SETTING_OFF)).toBe(back);
    expect(chiaBackOn(DAMAGED)).toBe(back);
    // A node with the switch always says what it says; one without it never names the switch as the source.
    expect(chiaBackOn({ off: true, source: 'setting' })).toBe(back);
    for (const lane of [UNTIL_RESTART, ENV, ENV_SAVED, { off: true } as ChiaLane]) expect(chiaBackOn(lane)).toBe('');
    // A folder the switch cannot remove: turning it back on there brings nothing back.
    for (const lane of [STUCK, ENV_STUCK]) expect(chiaBackOn(lane)).toBe('');
  });
});

describe('the Chia Mesh and Share Card feedback', () => {
  const MESH_ON = "Advanced Chia mesh mode ON for this room (experimental — the node publishes once its SSF wallet is on in the SpacePhone's 🏦 BANK and holds a coin; chain reads are on for every node, and public rooms never publish).";
  const MESH_OFF = 'Advanced Chia mesh mode OFF for this room.';
  const CARD_ON = 'Contact card shared in this room: its members can find this station by key and knock when every live route fails (private rooms only; public rooms never carry cards).';
  const CARD_OFF = 'Contact card not shared in this room: members get no key for this station, and the node reads no knocks for it.';
  const OFF_LANES = [ENV, ENV_SAVED, SETTING_OFF, DAMAGED, STUCK, UNTIL_RESTART, { off: true } as ChiaLane];

  it('say what they said before while Chia is on, or with no lane', () => {
    for (const lane of [undefined, null, ON, { off: false } as ChiaLane]) {
      expect(meshFeedback(true, lane)).toBe(MESH_ON);
      expect(meshFeedback(false, lane)).toBe(MESH_OFF);
      expect(shareCardFeedback(true, lane)).toBe(CARD_ON);
      expect(shareCardFeedback(false, lane)).toBe(CARD_OFF);
    }
  });

  it('say Chia is off, and why, when ticked on while it is', () => {
    for (const lane of OFF_LANES) {
      const mesh = meshFeedback(true, lane);
      const card = shareCardFeedback(true, lane);
      for (const words of [mesh, card]) {
        expect(words).toContain(chiaOffWhy(lane));
        expect(words).not.toContain('chain reads are on');
        expect(words).not.toContain('knock when every live route fails');
        const back = chiaBackOn(lane);
        if (back) expect(words.endsWith(` ${back}`)).toBe(true);
        else expect(words.endsWith('until Chia is back on.')).toBe(true);
      }
      expect(mesh).toBe(`Advanced Chia mesh mode ON for this room, but ${chiaOffWhy(lane)}, so your node reads and publishes nothing on the chain until Chia is back on.${chiaBackOn(lane) ? ` ${chiaBackOn(lane)}` : ''}`);
      expect(card).toContain('reads no knocks');
      // Ticked off, the words are true either way.
      expect(meshFeedback(false, lane)).toBe(MESH_OFF);
      expect(shareCardFeedback(false, lane)).toBe(CARD_OFF);
    }
    expect(shareCardFeedback(true, SETTING_OFF)).toBe(
      "Contact card shared in this room, but Chia is off on this computer (turned off in the SpacePhone's ⚙️ SETTINGS → 🌐 NETWORK), so your node publishes nothing members can find it by on the chain, and reads no knocks, until Chia is back on. Turning it back on there brings Chia back at your node's next start.",
    );
  });
});

describe('the switch\'s taps and keys', () => {
  it('sends the turn each act asks for, and none for arm', () => {
    expect(laneTurnOf('arm')).toBeNull();
    expect(laneTurnOf('confirm')).toBe('off');
    expect(laneTurnOf('keep')).toBe('keep');
    expect(laneTurnOf('on')).toBe('on');
    for (const junk of [undefined, '', 'off', 'ON']) expect(laneTurnOf(junk)).toBeNull();
  });

  it('takes no repeated Enter or Space', () => {
    expect(laneKeyRepeat({ repeat: true, key: 'Enter' })).toBe(true);
    expect(laneKeyRepeat({ repeat: true, key: ' ' })).toBe(true);
    expect(laneKeyRepeat({ repeat: false, key: 'Enter' })).toBe(false);
    expect(laneKeyRepeat({ repeat: true, key: 'ArrowDown' })).toBe(false);
  });
});

const answer = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('turnChiaLane', () => {
  it('POSTs a simple request to the node\'s own origin, refusing redirects', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { ok: true, lane: { off: true, source: 'setting', setting: 'off' }, note: 'Chia is off on this computer now.' }));
    await expect(turnChiaLane('http://127.0.0.1:8081', false, fetchImpl as unknown as typeof fetch)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8081/api/chia/lane?on=0');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    await turnChiaLane('http://127.0.0.1:8080', true, fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe('http://127.0.0.1:8080/api/chia/lane?on=1');
  });

  it('brings back the node\'s own refusal, or words what the page saw', async () => {
    const said = async (res: Response) => turnChiaLane('http://127.0.0.1:8080', true, (async () => res) as unknown as typeof fetch);
    const env = "SSF_NO_CHIA_LANE in the node's environment holds Chia off on this computer, so the SpacePhone cannot turn it on; start the node without it";
    expect(await said(answer(409, { ok: false, error: `  ${env}  `, lane: { off: true, source: 'env', setting: 'off' } }))).toEqual({ ok: false, error: env });
    expect(await said(answer(403, { ok: false, error: "only this computer's own Star Station page can turn Chia off or on" }))).toEqual({ ok: false, error: "only this computer's own Star Station page can turn Chia off or on" });
    expect(await said(answer(403, { ok: false }))).toEqual({ ok: false, error: 'your station node answered 403' });
    expect(await said(answer(500, 'not json'))).toEqual({ ok: false, error: 'your station node answered 500' });
    expect(await said(answer(200, { ok: 'yes' }))).toEqual({ ok: false, error: 'your station node answered 200' });
    expect((await said(answer(409, { ok: false, error: 'x'.repeat(900) })) as { error: string }).error).toHaveLength(400);
    expect(await said(new Response('', { status: 404 }))).toEqual({ ok: false, error: 'your station node is older than the Chia switch here: update Star Station' });
  });

  it('never throws: no origin, an unreachable node, or no answer in time', async () => {
    const never = vi.fn();
    expect(await turnChiaLane('', false, never as unknown as typeof fetch)).toEqual({ ok: false, error: 'your station node is not answering' });
    expect(never).not.toHaveBeenCalled();
    const unreachable = async () => { throw new TypeError('Failed to fetch'); };
    expect(await turnChiaLane('http://127.0.0.1:8080', false, unreachable as unknown as typeof fetch)).toEqual({ ok: false, error: 'your station node could not be reached' });
    const hangs = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    expect(await turnChiaLane('http://127.0.0.1:8080', false, hangs as unknown as typeof fetch, 20)).toEqual({
      ok: false, error: 'your station node did not answer in time; it may still be turning Chia off, so look again in a moment',
    });
    expect(await turnChiaLane('http://127.0.0.1:8080', true, hangs as unknown as typeof fetch, 20)).toEqual({
      ok: false, error: 'your station node did not answer in time; it may still be turning Chia back on, so look again in a moment',
    });
    // Headers in time, the body not: still a timeout, not "answered 200".
    const trickles = async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }) as unknown as Response;
    const slowBody = await turnChiaLane('http://127.0.0.1:8080', false, trickles as unknown as typeof fetch, 20);
    expect((slowBody as { error: string }).error).toContain('did not answer in time');
  });
});

describe('main.ts wires the CHIA row', () => {
  const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
  const body = (head: string): string => {
    const at = main.indexOf(head);
    expect(at, head).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n}\n', at));
  };

  it('draws the row from the node that answered, in both rounds of the fingerprint', () => {
    const render = body('function renderChiaLaneRow(): void {');
    expect(render).toContain('chiaLaneRow(localNodeLive ? localFingerprint : null,');
    expect(render).toContain('setNetworkRow("network-chia-lane", row.value, row.colour);');
    expect(render).toContain('getElementById(CHIA_LANE_BUTTON_ID)');
    expect(render).not.toContain('innerHTML');
    const refresh = body('async function refreshLocalFingerprint(');
    const gone = refresh.indexOf('renderPhoneBookIndicator(null);');
    const live = refresh.indexOf('renderPhoneBookIndicator(fingerprint);');
    expect(gone).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(gone);
    // Once after the node-gone round's Phone Book row, and once after the live one's.
    expect(refresh.indexOf('renderChiaLaneRow();', gone)).toBeLessThan(live);
    expect(refresh.indexOf('renderChiaLaneRow();', live)).toBeGreaterThan(live);
  });

  it('repaints the Bank when the lane changes', () => {
    const refresh = body('async function refreshLocalFingerprint(');
    expect(refresh).toContain('localFingerprint?.chia_wallet ?? null, localFingerprint?.chia_lane ?? null, ');
    expect(refresh).toContain('fingerprint.chia_wallet ?? null, fingerprint.chia_lane ?? null, ');
  });

  it('takes a fresh tap for every act but arm, and no held key', () => {
    const at = main.indexOf(`document.getElementById(CHIA_LANE_BUTTON_ID) as HTMLButtonElement | null;\n  if (laneBtn)`);
    expect(at).toBeGreaterThan(0);
    const wiring = main.slice(at, main.indexOf('// ChiaHub Slice 3b', at));
    expect(wiring).toContain('if (laneBtn.getAttribute("aria-disabled") === "true") return;');
    expect(wiring).toContain('if (act !== "arm" && !freshTap((e as MouseEvent).detail, performance.now(), chiaLaneChangedAt)) return;');
    expect(wiring).toContain('if (laneKeyRepeat(e)) e.preventDefault();');
    expect(wiring).toContain('void turnChiaLaneSwitch(turn)');
  });

  it('disarms the switch when the Network view opens, and when the node goes', () => {
    const at = main.indexOf('if (id === "setnet") {');
    expect(at).toBeGreaterThan(0);
    const open = main.slice(at, main.indexOf('\n    }\n', at));
    expect(open).toContain('chiaLaneArmed = false;');
    expect(open).toContain('if (!chiaLaneTurning) chiaLaneError = null;');
    expect(open).toContain('renderChiaLaneRow();');
    expect(body('async function refreshLocalFingerprint(')).toContain('bankWalletArmed = false;\n      chiaLaneArmed = false;');
  });

  it('words the Chia Mesh and Share Card feedback with the lane', () => {
    const at = main.indexOf('// ChiaHub Slice 3b: the "advanced Chia mesh mode" switch.');
    expect(at).toBeGreaterThan(0);
    const toggles = main.slice(at, main.indexOf('// ?seed= deep-link import', at));
    expect(toggles).toContain('feedback.textContent = meshFeedback(on, localNodeLive ? localFingerprint?.chia_lane : undefined);');
    expect(toggles).toContain('feedback.textContent = shareCardFeedback(on, localNodeLive ? localFingerprint?.chia_lane : undefined);');
    expect(toggles).not.toContain('chain reads are on for every node');
    expect(toggles).not.toContain('knock when every live route fails');
  });

  it('hands THE REGISTRY line the lane', () => {
    expect(main).toContain('registryChiaLine((localNodeLive ? localFingerprint : null)?.chia_net, (localNodeLive ? localFingerprint : null)?.chia_lane)');
  });

  it('reads the fingerprint again after a turn, and hands the dish the lane', () => {
    const turn = body('async function turnChiaLaneSwitch(turn: ChiaLaneTurn): Promise<void> {');
    expect(turn).toContain('if (chiaLaneTurning) return;');
    expect(turn).toContain('await turnChiaLane(localNodeOrigin, turn === "on");');
    expect(turn).toContain('await refreshLocalFingerprint();');
    expect(main).toContain('world.faucetChiaLane = () => localFingerprint?.chia_lane;');
    expect(CHIA_LANE_BUTTON_ID).toBe('chia-lane-switch');
  });
});


/** A stand-in for one element of the Network view: enough of the DOM for
 *  networkViewKeydown and wireNetworkViewStick to read (its tag, attributes,
 *  whether it is shown, focus, its data attributes and keydown listeners),
 *  with a selector match for the forms its stop list uses. */
class StandIn {
  readonly classes = new Set<string>();
  readonly classList = { contains: (c: string): boolean => this.classes.has(c) };
  readonly dataset: Record<string, string> = {};
  readonly keydowns: Array<(e: unknown) => void> = [];
  /** Laid out, or not (display:none, [hidden]). */
  laidOut = true;
  /** Laid out but skipped, as Chromium skips a closed drawer's contents
   *  (`content-visibility: hidden`): it has an offsetParent, but is not
   *  shown and cannot take focus. */
  skipped = false;
  /** An engine's checkVisibility; left out to stand for one without it. */
  checkVisibility: (() => boolean) | undefined = () => this.laidOut && !this.skipped;
  constructor(readonly tagName: string, readonly attrs: Record<string, string> = {}) {}
  get offsetParent(): object | null {
    return this.laidOut ? {} : null;
  }
  get type(): string {
    return this.attrs.type ?? '';
  }
  /** As an engine does, a control that is not shown refuses focus. */
  focus(): void {
    if (this.laidOut && !this.skipped) focused = this;
  }
  addEventListener(type: string, listener: (e: unknown) => void): void {
    if (type === 'keydown') this.keydowns.push(listener);
  }
  matches(selector: string): boolean {
    return selector.split(',').some((one) => {
      const m = /^([a-z]+)((?:\[[a-z]+="[^"]*"\])*)((?::not\(\[[a-z]+\]\))*)$/.exec(one.trim());
      if (!m) throw new Error(`the stand-in reads no selector like ${one}`);
      if (m[1] !== this.tagName.toLowerCase()) return false;
      for (const [, k, v] of m[2].matchAll(/\[([a-z]+)="([^"]*)"\]/g)) if (this.attrs[k] !== v) return false;
      for (const [, k] of m[3].matchAll(/:not\(\[([a-z]+)\]\)/g)) if (k in this.attrs) return false;
      return true;
    });
  }
}
class StandInInput extends StandIn {}
class StandInSelect extends StandIn {}
let focused: StandIn | null = null;

/** A stand-in for MutationObserver: what each one watches, and a way to
 *  tell the watchers of an element that its class changed. */
class StandInObserver {
  static readonly all: StandInObserver[] = [];
  readonly watched: Array<{ target: unknown; options: unknown }> = [];
  constructor(readonly callback: () => void) {
    StandInObserver.all.push(this);
  }
  observe(target: unknown, options: unknown): void {
    this.watched.push({ target, options });
  }
  static classChanged(el: StandIn): void {
    for (const o of StandInObserver.all) if (o.watched.some((w) => w.target === el)) o.callback();
  }
}

describe('main.ts walks the Network view by keyboard', () => {
  const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');

  it('lands focus on the view as it opens, once the CHIA row is drawn', () => {
    const at = main.indexOf('if (id === "setnet") {');
    expect(at).toBeGreaterThan(0);
    const open = main.slice(at, main.indexOf('\n    }\n', at));
    const drawn = open.indexOf('renderChiaLaneRow();');
    expect(drawn).toBeGreaterThan(0);
    expect(open).toContain('const nv = document.getElementById("phone-app-settings-network");');
    expect(open.indexOf('nv.setAttribute("tabindex", "-1");')).toBeGreaterThan(drawn);
    expect(open.indexOf('nv.focus({ preventScroll: true });')).toBeGreaterThan(drawn);
  });

  it('wires the view\'s keys and its stand-aside from the flight stick once, beside the CHIA switch\'s', () => {
    const setup = main.indexOf('function setupNetworkDetailsPanel() {');
    const at = main.indexOf(`document.getElementById(CHIA_LANE_BUTTON_ID) as HTMLButtonElement | null;\n  if (laneBtn)`);
    expect(setup).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(setup);
    // The same function, which runs its body once.
    expect(main.slice(setup, at)).not.toContain('\n}\n');
    expect(main.slice(setup, at)).toContain('if (networkPanelInitialized) return;\n  networkPanelInitialized = true;');
    const wiring = main.slice(at, main.indexOf('// ChiaHub Slice 3b', at));
    expect(wiring).toContain('const netView = document.getElementById("phone-app-settings-network");');
    expect(wiring).toContain(
      'if (netView) {\n    netView.addEventListener("keydown", (e) => networkViewKeydown(netView, e));\n    wireNetworkViewStick(netView);\n  }',
    );
    expect(main).toContain('import { isFlightKey } from "./freeFlightStick";');
  });

  // The handlers themselves, taken out of main.ts by the compiler and run
  // against stand-ins for the view's controls: vitest has no DOM here, and
  // main.ts cannot be imported (it starts the game).
  const wanted = ['NETWORK_VIEW_STOPS', 'treasuryViewOnScreen', 'networkViewKeydown', 'networkStopShown', 'wireNetworkViewStick'];
  const handler = (() => {
    const file = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
    const parts = file.statements.filter((s) => {
      if (ts.isFunctionDeclaration(s)) return wanted.includes(s.name?.text ?? '');
      if (!ts.isVariableStatement(s)) return false;
      const name = s.declarationList.declarations[0]?.name;
      return name !== undefined && ts.isIdentifier(name) && wanted.includes(name.text);
    });
    const js = ts.transpileModule(parts.map((s) => s.getText(file)).join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const phone = new StandIn('div');
    const realm = vm.createContext({
      document: { getElementById: (id: string) => (id === 'spacephone-container' ? phone : null) },
      HTMLInputElement: StandInInput,
      HTMLSelectElement: StandInSelect,
      MutationObserver: StandInObserver,
      isFlightKey,
    });
    type Handlers = { networkViewKeydown: (view: unknown, e: unknown) => void; wireNetworkViewStick: (view: unknown) => void };
    const handlers = parts.length === wanted.length
      ? (vm.runInContext(`${js}\n({ networkViewKeydown, wireNetworkViewStick });`, realm) as Handlers)
      : null;
    return { found: parts.length, keydown: handlers?.networkViewKeydown, wireStick: handlers?.wireNetworkViewStick, phone };
  })();

  /** The view as index.html lays it out, in document order, on screen. */
  const networkView = () => {
    const button = (id: string) => new StandIn('BUTTON', { id });
    const c = {
      retry: button('network-retry-node-btn'),
      chevron: button('network-details-toggle'),
      chia: button('chia-lane-switch'),
      mesh: new StandInInput('INPUT', { type: 'checkbox', id: 'chia-mode-toggle' }),
      share: new StandInInput('INPUT', { type: 'checkbox', id: 'share-card-toggle' }),
      drawer: new StandIn('SUMMARY'),
      address: new StandInInput('INPUT', { type: 'text', id: 'network-bootstrap-address' }),
      override: button('network-bootstrap-link-btn'),
      selfTest: button('network-test-reach-btn'),
    };
    // The chevron is display:none in the phone. The drawer starts closed,
    // and Chromium skips its contents: laid out, not shown.
    c.chevron.laidOut = false;
    for (const el of [c.address, c.override, c.selfTest]) el.skipped = true;
    const all: StandIn[] = Object.values(c);
    const view = Object.assign(new StandIn('DIV', { id: 'phone-app-settings-network' }), {
      querySelectorAll: (selector: string) => all.filter((el) => el.matches(selector)),
    });
    view.classes.add('active');
    handler.phone.classes.add('active');
    focused = null;
    return { view, c, drawerContents: [c.address, c.override, c.selfTest], all };
  };

  /** One keydown on `target`: where focus went, and whether its default was kept. */
  const press = (view: StandIn, target: StandIn, key: string, held: Partial<KeyboardEvent> = {}) => {
    focused = target;
    let prevented = false;
    handler.keydown!(view, {
      key, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...held,
      preventDefault: () => { prevented = true; },
    });
    return { to: focused, prevented };
  };

  it('moves between the view\'s controls on ↑ and ↓, wrapping, and skips the hidden ones', () => {
    expect(handler.found).toBe(wanted.length);
    const { view, c, drawerContents } = networkView();
    // From the view itself, ↓ reaches the first control.
    expect(press(view, view, 'ArrowDown')).toEqual({ to: c.retry, prevented: true });
    // Past the chevron, which the phone hides.
    expect(press(view, c.retry, 'ArrowDown').to).toBe(c.chia);
    expect(press(view, c.chia, 'ArrowDown').to).toBe(c.mesh);
    expect(press(view, c.mesh, 'ArrowDown').to).toBe(c.share);
    expect(press(view, c.share, 'ArrowDown').to).toBe(c.drawer);
    // The closed drawer's text box and buttons are laid out but not shown,
    // so they cannot take focus: round to the top.
    expect(drawerContents.every((el) => el.offsetParent !== null)).toBe(true);
    expect(press(view, c.drawer, 'ArrowDown').to).toBe(c.retry);
    expect(press(view, c.retry, 'ArrowUp').to).toBe(c.drawer);
    expect(press(view, c.chia, 'ArrowUp').to).toBe(c.retry);
    // The drawer open: its text box and buttons are stops, and ↑/↓ leave the box.
    for (const el of drawerContents) el.skipped = false;
    expect(press(view, c.drawer, 'ArrowDown').to).toBe(c.address);
    expect(press(view, c.address, 'ArrowDown')).toEqual({ to: c.override, prevented: true });
    expect(press(view, c.address, 'ArrowUp')).toEqual({ to: c.drawer, prevented: true });
    expect(press(view, c.selfTest, 'ArrowDown').to).toBe(c.retry);
    // The CHIA switch hidden (it offers nothing), and a room switch disabled
    // (no room yet), cannot take focus: neither is a stop.
    c.chia.laidOut = false;
    c.share.attrs.disabled = '';
    expect(press(view, c.retry, 'ArrowDown').to).toBe(c.mesh);
    expect(press(view, c.mesh, 'ArrowDown').to).toBe(c.drawer);
  });

  it('skips a closed drawer\'s controls in an engine without checkVisibility, which lays them out not at all', () => {
    expect(handler.found).toBe(wanted.length);
    const { view, c, drawerContents, all } = networkView();
    for (const el of all) el.checkVisibility = undefined;
    for (const el of drawerContents) {
      el.skipped = false;
      el.laidOut = false;
    }
    expect(press(view, c.share, 'ArrowDown').to).toBe(c.drawer);
    expect(press(view, c.drawer, 'ArrowDown').to).toBe(c.retry);
    for (const el of drawerContents) el.laidOut = true;
    expect(press(view, c.drawer, 'ArrowDown').to).toBe(c.address);
  });

  it('moves nothing while the view is not on screen', () => {
    expect(handler.found).toBe(wanted.length);
    const { view, c } = networkView();
    // The phone put away (Tab only slides it offscreen; the view keeps its class).
    handler.phone.classes.delete('active');
    expect(press(view, c.retry, 'ArrowDown')).toEqual({ to: c.retry, prevented: false });
    expect(press(view, view, 'ArrowDown')).toEqual({ to: view, prevented: false });
    // The phone up on another view.
    handler.phone.classes.add('active');
    view.classes.delete('active');
    expect(press(view, c.retry, 'ArrowDown')).toEqual({ to: c.retry, prevented: false });
  });

  it('leaves every other key, a held modifier and a select\'s arrows to the control', () => {
    expect(handler.found).toBe(wanted.length);
    const { view, c } = networkView();
    // Enter and Space keep their own meaning: the click, the checkbox's toggle.
    expect(press(view, c.chia, 'Enter')).toEqual({ to: c.chia, prevented: false });
    expect(press(view, c.mesh, ' ')).toEqual({ to: c.mesh, prevented: false });
    expect(press(view, c.retry, 'ArrowLeft')).toEqual({ to: c.retry, prevented: false });
    for (const held of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(press(view, c.mesh, 'ArrowDown', held)).toEqual({ to: c.mesh, prevented: false });
    }
    const select = new StandInSelect('SELECT');
    expect(press(view, select, 'ArrowDown')).toEqual({ to: select, prevented: false });
  });

  it('stands the helm\'s flight stick aside only while the view is on screen, and keeps the flight keys it is given from the world', () => {
    expect(handler.found).toBe(wanted.length);
    const { view, c } = networkView();
    StandInObserver.all.length = 0;
    handler.wireStick!(view);
    // The view's class and the phone's are watched, since the phone closes by many paths.
    const watched = StandInObserver.all.flatMap((o) => o.watched);
    expect(watched).toEqual([
      { target: view, options: { attributes: true, attributeFilter: ['class'] } },
      { target: handler.phone, options: { attributes: true, attributeFilter: ['class'] } },
    ]);
    // On screen as it is wired: marked, so the stick lets a key pressed in it through.
    expect(view.dataset.stickAside).toBe('1');

    /** One keydown that reaches the view: whether it bubbles on to the world. */
    const reaches = (code: string, held: Partial<KeyboardEvent> = {}) => {
      let stopped = false;
      for (const listener of view.keydowns) {
        listener({ code, target: c.chia, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...held, stopPropagation: () => { stopped = true; } });
      }
      return !stopped;
    };
    // ↑/↓ and Space are the view's (its traversal, a button's press), and
    // WASD typed in it walks nobody: none goes on to input.ts or the camera rig.
    for (const code of ['ArrowUp', 'ArrowDown', 'Space', 'KeyW', 'KeyS', 'ArrowLeft']) expect(reaches(code)).toBe(false);
    // Tab and Escape are the phone's, and a shortcut with a modifier is not the view's.
    for (const code of ['Tab', 'Escape', 'Enter']) expect(reaches(code)).toBe(true);
    for (const held of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) expect(reaches('KeyW', held)).toBe(true);

    // The phone put away: the mark goes, and a key on a control left focused
    // in it is the stick's again, so nothing here holds it back.
    handler.phone.classes.delete('active');
    StandInObserver.classChanged(handler.phone);
    expect(view.dataset.stickAside).toBeUndefined();
    expect(reaches('ArrowDown')).toBe(true);
    handler.phone.classes.add('active');
    StandInObserver.classChanged(handler.phone);
    expect(view.dataset.stickAside).toBe('1');
    // The phone up on another view: the same.
    view.classes.delete('active');
    StandInObserver.classChanged(view);
    expect(view.dataset.stickAside).toBeUndefined();
    expect(reaches('KeyW')).toBe(true);
    view.classes.add('active');
    StandInObserver.classChanged(view);
    expect(view.dataset.stickAside).toBe('1');
  });
});
