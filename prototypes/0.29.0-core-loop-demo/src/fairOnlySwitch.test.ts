/**
 * 🔒 The FAIR ONLY row in the SpacePhone's Network rows: what the row and the
 * lines under it say from the node's fingerprint (`fair_only`), how a turn is
 * armed and confirmed, how the page asks the node to turn it, how the
 * fingerprint is read, and main.ts's and index.html's wiring.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BEACON_BUTTON_ID } from './beaconSwitch';
import { LANE_NO_NODE_COLOUR, LANE_OFF_COLOUR, LANE_ON_COLOUR, LANE_UNKNOWN_COLOUR } from './chiaLane';
import { FAIR_ONLY_RV } from './computedFairOnly';
import {
  FAIR_ONLY_BUTTON_ID, FAIR_ONLY_DAMAGED_NOTE, FAIR_ONLY_DEFAULT_ON_NOTE, FAIR_ONLY_HELD_OFF_NOTE, FAIR_ONLY_HELD_ON_NOTE, FAIR_ONLY_NO_SWITCH, FAIR_ONLY_OFF_NOTE,
  FAIR_ONLY_OFF_WARNING, FAIR_ONLY_ON_NOTE, FAIR_ONLY_ON_WARNING, FAIR_ONLY_TIMEOUT_MS, fairOnlyArm, fairOnlyArmOf, fairOnlyCannotNote, fairOnlyRow, fairOnlyStands,
  fairOnlyStoppedNote, fairOnlyTurnOf, fairOnlyUnableWords, turnFairOnly, type FairOnlyUi,
} from './fairOnlySwitch';
import { parseFairOnly, parseNodeFingerprint, type FairOnlySwitchView, type FairOnlyUnable, type LocalFingerprint } from './nodeFingerprint';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443, iroh_node_id: 'node-a', chia_net: null };
const IDLE: FairOnlyUi = { armed: null, turning: null, error: null };
const with_ = (fair_only: FairOnlySwitchView | undefined): LocalFingerprint => ({ ...BASE, fair_only });

type Button = NonNullable<ReturnType<typeof fairOnlyRow>['button']>;
const TURN_ON: Button = { act: 'arm-on', label: 'TURN ON', danger: false, busy: false };
const TURN_OFF: Button = { act: 'arm-off', label: 'TURN OFF', danger: false, busy: false };
const CONFIRM_ON: Button = { act: 'on', label: '⚠ CONFIRM', danger: true, busy: false };
const CONFIRM_OFF: Button = { act: 'off', label: '⚠ CONFIRM', danger: true, busy: false };
const TURNING_ON: Button = { act: 'on', label: 'TURNING ON…', danger: false, busy: true };
const TURNING_OFF: Button = { act: 'off', label: 'TURNING OFF…', danger: false, busy: true };

/** On as it starts: the player never turned the switch. */
const ON_DEFAULT: FairOnlySwitchView = { on: true, chosen: false };
const OFF: FairOnlySwitchView = { on: false, chosen: true };
const ON: FairOnlySwitchView = { on: true, chosen: true };
const UNABLE: FairOnlyUnable[] = ['build', 'house', 'fold-env', 'fold-down', 'other'];

describe('fairOnlyRow, with no switch to show', () => {
  it('says NO NODE while the node does not answer, and nothing else', () => {
    for (const fp of [null, undefined]) {
      expect(fairOnlyRow(fp, { ...IDLE, error: 'old' })).toEqual({ value: 'NO NODE', colour: LANE_NO_NODE_COLOUR, note: null, warning: null, error: null, button: null });
    }
  });

  it('says NO SWITCH for a node older than the switch, and offers none', () => {
    expect(fairOnlyRow(BASE, { ...IDLE, error: 'x' })).toEqual({ value: 'NO SWITCH', colour: LANE_UNKNOWN_COLOUR, note: FAIR_ONLY_NO_SWITCH, warning: null, error: 'x', button: null });
  });
});

describe('fairOnlyRow, off', () => {
  it('says what turning it on does, and arms CONFIRM before any turn', () => {
    expect(fairOnlyRow(with_(OFF), IDLE)).toEqual({ value: 'OFF', colour: LANE_UNKNOWN_COLOUR, note: FAIR_ONLY_OFF_NOTE, warning: null, error: null, button: TURN_ON });
    expect(FAIR_ONLY_OFF_NOTE).toContain('your tables do not offer SET FAIR ONLY');
    // A node that says off with nobody's word and no damage (none does today) reads as plainly off.
    expect(fairOnlyRow(with_({ on: false, chosen: false }), IDLE)).toMatchObject({ value: 'OFF', note: FAIR_ONLY_OFF_NOTE, button: TURN_ON });
    expect(fairOnlyRow(with_({ on: false, chosen: false, damaged: true }), IDLE)).toMatchObject({ value: 'OFF', note: FAIR_ONLY_DAMAGED_NOTE, button: TURN_ON });
    const armed = { ...IDLE, armed: fairOnlyArm(true, BASE) };
    expect(fairOnlyRow(with_(OFF), armed)).toEqual({ value: 'OFF', colour: LANE_UNKNOWN_COLOUR, note: FAIR_ONLY_OFF_NOTE, warning: FAIR_ONLY_ON_WARNING, error: null, button: CONFIRM_ON });
    expect(FAIR_ONLY_ON_WARNING).toMatch(/^Turn FAIR ONLY tables on\? /);
    expect(FAIR_ONLY_ON_WARNING).toContain("its house steps down there and serves that game no more: end it from the table's ⚙ card");
    expect(FAIR_ONLY_ON_WARNING).toContain('Turned off here, this page ends the games it holds itself.');
    expect(FAIR_ONLY_ON_WARNING).toMatch(/Tap CONFIRM\.$/);
    // An off armed (from before the node turned off) shows no CONFIRM for an on.
    expect(fairOnlyRow(with_(OFF), { ...IDLE, armed: fairOnlyArm(false, BASE) })).toMatchObject({ button: TURN_ON, warning: null });
  });

  it('offers no on while the node says its house cannot serve the games, or the environment holds it off', () => {
    for (const unable of UNABLE) {
      const row = fairOnlyRow(with_({ ...OFF, unable }), { ...IDLE, armed: fairOnlyArm(true, BASE) });
      expect(row, unable).toEqual({ value: 'OFF', colour: LANE_UNKNOWN_COLOUR, note: fairOnlyCannotNote(unable), warning: null, error: null, button: null });
      expect(row.note, unable).toBe(`FAIR ONLY tables are off. ${fairOnlyUnableWords(unable)}`);
    }
    expect(fairOnlyRow(with_({ on: false, chosen: true, held: true }), { ...IDLE, armed: fairOnlyArm(true, BASE) })).toEqual({
      value: 'OFF', colour: LANE_UNKNOWN_COLOUR, note: FAIR_ONLY_HELD_OFF_NOTE, warning: null, error: null, button: null,
    });
  });

  it('says each reason in its own words, and one it does not know as something in the way', () => {
    const words = UNABLE.map(fairOnlyUnableWords);
    expect(new Set(words).size).toBe(UNABLE.length);
    expect(fairOnlyUnableWords('fold-env')).toContain('SSF_HOUSE_FOLD');
    expect(fairOnlyUnableWords('fold-down')).toContain('until your node starts again');
    expect(fairOnlyUnableWords('other')).toBe('Your node says its house cannot serve FAIR ONLY games now.');
  });
});

describe('fairOnlyRow, on', () => {
  it('starts on, and says what it does and how to stop it, since nobody read a warning', () => {
    expect(fairOnlyRow(with_(ON_DEFAULT), IDLE)).toEqual({ value: 'ON', colour: LANE_ON_COLOUR, note: FAIR_ONLY_DEFAULT_ON_NOTE, warning: null, error: null, button: TURN_OFF });
    expect(FAIR_ONLY_DEFAULT_ON_NOTE).toMatch(/^FAIR ONLY tables are on, as they start: /);
    expect(FAIR_ONLY_DEFAULT_ON_NOTE).toContain('goes on without your page at the table');
    expect(FAIR_ONLY_DEFAULT_ON_NOTE).toContain('Your tables offer SET FAIR ONLY. TURN OFF stops it;');
    expect(FAIR_ONLY_DEFAULT_ON_NOTE).toContain('ended by the page that holds it once no round is in flight');
    expect(fairOnlyRow(with_(ON_DEFAULT), { ...IDLE, armed: fairOnlyArm(false, BASE) })).toEqual({
      value: 'ON', colour: LANE_ON_COLOUR, note: FAIR_ONLY_DEFAULT_ON_NOTE, warning: FAIR_ONLY_OFF_WARNING, error: null, button: CONFIRM_OFF,
    });
    // Something in the way: STOPPED says why, whoever's word it is on by.
    expect(fairOnlyRow(with_({ ...ON_DEFAULT, unable: 'fold-down' }), IDLE)).toMatchObject({ value: 'STOPPED', note: fairOnlyStoppedNote('fold-down'), button: TURN_OFF });
  });

  it('says ON while the house serves the games, and arms CONFIRM with a warning before an off', () => {
    expect(fairOnlyRow(with_(ON), IDLE)).toEqual({ value: 'ON', colour: LANE_ON_COLOUR, note: FAIR_ONLY_ON_NOTE, warning: null, error: null, button: TURN_OFF });
    expect(FAIR_ONLY_ON_NOTE).toContain('Your tables offer SET FAIR ONLY.');
    const armed = { ...IDLE, armed: fairOnlyArm(false, BASE) };
    expect(fairOnlyRow(with_(ON), armed)).toEqual({ value: 'ON', colour: LANE_ON_COLOUR, note: FAIR_ONLY_ON_NOTE, warning: FAIR_ONLY_OFF_WARNING, error: null, button: CONFIRM_OFF });
    expect(FAIR_ONLY_OFF_WARNING).toMatch(/^Turn FAIR ONLY tables off\? /);
    // (What the off does, as it does it: the node's house steps down at each game, and this page ends the ones it holds.)
    expect(FAIR_ONLY_OFF_WARNING).toContain('reveals a round whose seeds are in and starts no new one');
    expect(FAIR_ONLY_OFF_WARNING).toContain('this page ends each game it holds once no round is in flight');
    // An on armed shows no CONFIRM for an off.
    expect(fairOnlyRow(with_(ON), { ...IDLE, armed: fairOnlyArm(true, BASE) })).toMatchObject({ button: TURN_OFF, warning: null });
  });

  it('says STOPPED when nothing serves an on, and still lets it be turned off', () => {
    for (const unable of UNABLE) {
      expect(fairOnlyRow(with_({ ...ON, unable }), IDLE), unable).toEqual({
        value: 'STOPPED', colour: LANE_OFF_COLOUR, note: fairOnlyStoppedNote(unable), warning: null, error: null, button: TURN_OFF,
      });
      // Armed, the note still says why nothing serves it, under the off's warning.
      expect(fairOnlyRow(with_({ ...ON, unable }), { ...IDLE, armed: fairOnlyArm(false, BASE) }), unable).toEqual({
        value: 'STOPPED', colour: LANE_OFF_COLOUR, note: fairOnlyStoppedNote(unable), warning: FAIR_ONLY_OFF_WARNING, error: null, button: CONFIRM_OFF,
      });
      expect(fairOnlyStoppedNote(unable)).toContain(fairOnlyUnableWords(unable));
      // (Nothing serves them, so this page ends the ones it holds: computedTable fairOffDuty.)
      expect(fairOnlyStoppedNote(unable)).toMatch(/this page ends each FAIR ONLY game it holds once no round is in flight\.$/);
      expect(fairOnlyStoppedNote(unable)).toContain('Your tables do not offer SET FAIR ONLY meanwhile, ');
    }
  });

  it('offers no off while the environment holds it on, and says so', () => {
    const held: FairOnlySwitchView = { on: true, chosen: false, held: true };
    expect(fairOnlyRow(with_(held), { ...IDLE, armed: fairOnlyArm(false, BASE) })).toEqual({
      value: 'ON', colour: LANE_ON_COLOUR, note: FAIR_ONLY_HELD_ON_NOTE, warning: null, error: null, button: null,
    });
    expect(fairOnlyRow(with_({ ...held, unable: 'house' }), IDLE)).toEqual({
      value: 'STOPPED', colour: LANE_OFF_COLOUR, note: `${FAIR_ONLY_HELD_ON_NOTE} ${fairOnlyStoppedNote('house')}`, warning: null, error: null, button: null,
    });
  });
});

describe('fairOnlyRow, arming and turning', () => {
  it('arms for the node that answers, and drops the arm when another node answers', () => {
    expect(fairOnlyArm(true, BASE)).toEqual({ on: true, node: 'node-a' });
    expect(fairOnlyArm(false, null)).toBeNull();
    expect(fairOnlyArm(true, { ...BASE, iroh_node_id: '' })).toBeNull();
    const armed = fairOnlyArm(true, BASE);
    expect(fairOnlyStands(armed, BASE)).toBe(true);
    expect(fairOnlyStands(armed, { ...BASE, iroh_node_id: 'node-b' })).toBe(false);
    expect(fairOnlyStands(armed, null)).toBe(false);
    expect(fairOnlyStands(null, BASE)).toBe(false);
    // Armed on node-a, a fingerprint from node-b shows TURN ON, not CONFIRM.
    expect(fairOnlyRow({ ...with_(OFF), iroh_node_id: 'node-b' }, { ...IDLE, armed })).toMatchObject({ button: TURN_ON, warning: null });
  });

  it('says what a turn in flight is doing, whatever the fingerprint read meanwhile, with no warning', () => {
    expect(fairOnlyRow(with_(OFF), { ...IDLE, turning: 'on' })).toMatchObject({ value: 'OFF', button: TURNING_ON, warning: null });
    expect(fairOnlyRow(with_(ON), { ...IDLE, turning: 'on' })).toMatchObject({ value: 'ON', button: TURNING_ON });
    expect(fairOnlyRow(with_(ON), { ...IDLE, turning: 'off', armed: fairOnlyArm(false, BASE) })).toMatchObject({ value: 'ON', button: TURNING_OFF, warning: null });
    expect(fairOnlyRow(with_({ ...ON, held: true }), { ...IDLE, turning: 'off' })).toMatchObject({ button: TURNING_OFF });
    expect(fairOnlyRow(with_(OFF), { ...IDLE, error: 'the node said no' })).toMatchObject({ error: 'the node said no', button: TURN_ON });
  });

  it('maps each act to what it does: the arming acts send nothing', () => {
    expect([fairOnlyTurnOf('on'), fairOnlyTurnOf('off'), fairOnlyTurnOf('arm-on'), fairOnlyTurnOf('arm-off'), fairOnlyTurnOf(''), fairOnlyTurnOf(undefined)]).toEqual([true, false, null, null, null, null]);
    expect([fairOnlyArmOf('arm-on'), fairOnlyArmOf('arm-off'), fairOnlyArmOf('on'), fairOnlyArmOf('off'), fairOnlyArmOf(undefined)]).toEqual([true, false, null, null, null]);
  });
});

describe('parseFairOnly', () => {
  it("keeps the node's view in its own shape", () => {
    expect(parseFairOnly({ on: true, chosen: true })).toEqual({ on: true, chosen: true });
    expect(parseFairOnly({ on: false, chosen: false, held: true, unable: 'fold-env' })).toEqual({ on: false, chosen: false, held: true, unable: 'fold-env' });
    for (const unable of ['build', 'house', 'fold-env', 'fold-down']) expect(parseFairOnly({ on: true, chosen: true, unable })?.unable).toBe(unable);
    // Only true flags are kept, and nothing else is copied.
    expect(parseFairOnly({ on: false, chosen: true, held: false, damaged: false, extra: 1 })).toEqual({ on: false, chosen: true });
  });

  it('reads no switch where on or chosen is not a boolean', () => {
    for (const v of [null, undefined, 1, 'on', [], [true], {}, { on: true }, { chosen: true }, { on: 1, chosen: true }, { on: true, chosen: 'yes' }]) {
      expect(parseFairOnly(v), JSON.stringify(v)).toBeUndefined();
    }
  });

  it('never reads a damaged switch as on unless the environment holds it, and never reads a reason as none', () => {
    expect(parseFairOnly({ on: true, chosen: false, damaged: true })).toEqual({ on: false, chosen: false, damaged: true });
    expect(parseFairOnly({ on: true, chosen: false, damaged: true, held: true })).toEqual({ on: true, chosen: false, held: true, damaged: true });
    for (const unable of ['crashes', '', 7, true, {}]) expect(parseFairOnly({ on: true, chosen: true, unable })?.unable, JSON.stringify(unable)).toBe('other');
    expect(parseFairOnly({ on: true, chosen: true, unable: null })).toEqual({ on: true, chosen: true });
  });

  it('rides in the fingerprint, beside the fold that says p and q while the house serves the games', () => {
    const raw = {
      hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443, iroh_node_id: 'node-a',
      fair_only: { on: true, chosen: true },
      house_fold: { letters: 'rdpq', rv: ['f1'], rules: { r: 'h1', d: 'h1' }, attest: false },
    };
    const fp = parseNodeFingerprint(raw);
    expect(fp?.fair_only).toEqual({ on: true, chosen: true });
    // The node names p and q with the rules version exactly while it serves
    // the games (fair_only_switch.rs `advertise`): the fold the tables read to
    // offer SET FAIR ONLY (computedTable nodeRunsFairOnly; the FAIR ONLY specs
    // open games with this fold).
    expect(fp?.house_fold).toEqual({ letters: 'rdpq', rv: [FAIR_ONLY_RV] });
    expect(parseNodeFingerprint({ ...raw, fair_only: { on: false, chosen: true }, house_fold: { letters: 'rd', rules: {}, attest: false } })?.house_fold).toEqual({ letters: 'rd', rv: [] });
    expect(parseNodeFingerprint({ ...raw, fair_only: { on: 'yes' } })?.fair_only).toBeUndefined();
  });
});

const answer = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A turn on armed on node `node-a`. */
const ARM_ON = { on: true, node: 'node-a' } as const;

describe('turnFairOnly', () => {
  it("POSTs a simple request to the node's own origin, naming the node it was armed on, refusing redirects", async () => {
    const fetchImpl = vi.fn(async () => answer(200, { ok: true, fair_only: { on: true, chosen: true } }));
    await expect(turnFairOnly('http://127.0.0.1:8081', ARM_ON, fetchImpl as unknown as typeof fetch)).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8081/api/house/fair-only?on=1&node=node-a');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    // An off names it too, and a node id is sent as a query value.
    await turnFairOnly('http://127.0.0.1:8080', { on: false, node: 'a b&c' }, fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe('http://127.0.0.1:8080/api/house/fair-only?on=0&node=a%20b%26c');
    expect(FAIR_ONLY_TIMEOUT_MS).toBe(15_000);
  });

  it("brings back the node's own refusal, or words what the page saw", async () => {
    const said = async (res: Response) => turnFairOnly('http://127.0.0.1:8080', ARM_ON, (async () => res) as unknown as typeof fetch);
    // The node's words, as fair_only_switch.rs says them.
    const fold = 'FAIR ONLY tables were not turned on: the fold of the tables is turned off by SSF_HOUSE_FOLD in this node\'s environment, so its house cannot serve FAIR ONLY games; start the node without it';
    expect(await said(answer(409, { ok: false, error: `  ${fold}  `, fair_only: { on: false, chosen: false, unable: 'fold-env' } }))).toEqual({ ok: false, error: fold });
    const pageOnly = "only this computer's own Star Station page can turn FAIR ONLY tables on or off";
    const otherNode = 'FAIR ONLY tables were not turned: the turn was confirmed for another node than the one that answers now. Look at the Network settings again';
    expect(await said(answer(409, { ok: false, error: otherNode }))).toEqual({ ok: false, error: otherNode });
    expect(await said(answer(403, { ok: false, error: pageOnly }))).toEqual({ ok: false, error: pageOnly });
    expect(await said(answer(403, { ok: false }))).toEqual({ ok: false, error: 'your node answered 403' });
    expect(await said(answer(500, 'not json'))).toEqual({ ok: false, error: 'your node answered 500' });
    expect(await said(answer(200, { ok: 'yes' }))).toEqual({ ok: false, error: 'your node answered 200' });
    expect((await said(answer(409, { ok: false, error: 'x'.repeat(900) })) as { error: string }).error).toHaveLength(400);
    expect(await said(new Response('', { status: 404 }))).toEqual({ ok: false, error: 'your node is older than the FAIR ONLY switch: update Star Station' });
  });

  it('never throws: no origin, an unreachable node, or no answer in time', async () => {
    const never = vi.fn();
    expect(await turnFairOnly('', ARM_ON, never as unknown as typeof fetch)).toEqual({ ok: false, error: 'your node is not answering' });
    expect(never).not.toHaveBeenCalled();
    const unreachable = async () => { throw new TypeError('Failed to fetch'); };
    expect(await turnFairOnly('http://127.0.0.1:8080', ARM_ON, unreachable as unknown as typeof fetch)).toEqual({ ok: false, error: 'your node could not be reached' });
    const hangs = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    expect(await turnFairOnly('http://127.0.0.1:8080', ARM_ON, hangs as unknown as typeof fetch, 20)).toEqual({
      ok: false, error: 'your node did not answer in time; it may still be turning FAIR ONLY tables on, so look again in a moment',
    });
    expect(await turnFairOnly('http://127.0.0.1:8080', { on: false, node: 'node-a' }, hangs as unknown as typeof fetch, 20)).toEqual({
      ok: false, error: 'your node did not answer in time; it may still be turning FAIR ONLY tables off, so look again in a moment',
    });
    const trickles = async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }) as unknown as Response;
    expect(((await turnFairOnly('http://127.0.0.1:8080', ARM_ON, trickles as unknown as typeof fetch, 20)) as { error: string }).error).toContain('did not answer in time');
  });
});

describe('main.ts and index.html wire the FAIR ONLY switch', () => {
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const main = read('./main.ts');
  const html = read('../index.html');
  const css = read('./index-inline.css');
  const body = (head: string): string => {
    const at = main.indexOf(head);
    expect(at, head).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n}\n', at));
  };
  const wiring = (): string => {
    const at = main.indexOf('document.getElementById(FAIR_ONLY_BUTTON_ID) as HTMLButtonElement | null;\n  if (fairOnlyBtn)');
    expect(at).toBeGreaterThan(0);
    return main.slice(at, main.indexOf("// The view's own ↑/↓ traversal", at));
  };

  it('draws the row from the node that answered, in both rounds of the fingerprint, and never with innerHTML', () => {
    const render = body('function renderFairOnlyRow(): void {');
    expect(render).toContain('const fp = localNodeLive ? localFingerprint : null;');
    expect(render).toContain('fairOnlyRow(fp, { armed: fairOnlyArmed, turning: fairOnlyTurning, error: fairOnlyError });');
    expect(render).toContain('setNetworkRow("network-fair-only", row.value, row.colour);');
    expect(render).toContain('getElementById(FAIR_ONLY_BUTTON_ID)');
    for (const id of ['fair-only-note', 'fair-only-warning', 'fair-only-error']) expect(render).toContain(`line("${id}", `);
    expect(render).not.toContain('innerHTML');
    expect(render).toContain('btn.setAttribute("aria-disabled", "true");');
    expect(render).not.toContain('.disabled');
    const refresh = body('async function refreshLocalFingerprint(');
    const gone = refresh.indexOf('renderPhoneBookIndicator(null);');
    const live = refresh.indexOf('renderPhoneBookIndicator(fingerprint);');
    expect(gone).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(gone);
    expect(refresh.indexOf('renderFairOnlyRow();', gone)).toBeLessThan(live);
    expect(refresh.indexOf('renderFairOnlyRow();', live)).toBeGreaterThan(live);
    expect(refresh.slice(0, gone)).toContain('fairOnlyArmed = null;');
    expect(refresh.slice(gone)).toContain('if (!fairOnlyStands(fairOnlyArmed, fingerprint)) fairOnlyArmed = null;');
    // The tables read the fold from the same fingerprint, so SET FAIR ONLY follows a turn.
    expect(refresh.slice(gone)).toContain('setLocalHouseFold(fingerprint.house_fold ?? null);');
    // …and whether its house serves none (switch off, or something in the way), so this page ends the games it holds there (computedTable fairOffDuty).
    expect(refresh.slice(gone)).toContain('setLocalFairOnlyStopped(fingerprint.fair_only !== undefined && (!fingerprint.fair_only.on || fingerprint.fair_only.unable !== undefined));');
  });

  it('arms each turn first, takes a fresh tap for CONFIRM, no held key, and no tap while a turn is in flight', () => {
    const w = wiring();
    expect(w).toContain('if (fairOnlyBtn.getAttribute("aria-disabled") === "true") return;');
    expect(w).toContain('if (arm === null && !freshTap((e as MouseEvent).detail, performance.now(), fairOnlyChangedAt)) return;');
    expect(w).toContain('if (laneKeyRepeat(e)) e.preventDefault();');
    expect(w).toContain('const on = fairOnlyTurnOf(act);\n      if (on !== null) void turnFairOnlySwitch(on);');
    const arm = w.slice(w.indexOf('if (arm !== null) {'), w.indexOf('const on = fairOnlyTurnOf(act);'));
    expect(arm).toContain('fairOnlyArmed = fairOnlyArm(arm, localNodeLive ? localFingerprint : null);');
    expect(arm).toContain('return;');
    expect(arm).not.toContain('turnFairOnly');
    const guard = w.indexOf('if (!networkViewOnScreen()) {\n        disarmFairOnly();\n        return;\n      }');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(w.indexOf('const act = fairOnlyBtn.dataset.act;'));
  });

  it('sends a turn only for the node and the turn CONFIRM was armed for, then reads the fingerprint again', () => {
    const turn = body('async function turnFairOnlySwitch(on: boolean): Promise<void> {');
    expect(turn).toContain('if (fairOnlyTurning) return;');
    expect(turn).toContain('if (!armedFor || armedFor.on !== on || !fairOnlyStands(armedFor, localNodeLive ? localFingerprint : null)) {');
    expect(turn.indexOf('fairOnlyError = FAIR_ONLY_NOT_CONFIRMED;')).toBeLessThan(turn.indexOf('await turnFairOnly('));
    // (The turn and the node it was armed for go out with it: the node takes it only if it is that node.)
    expect(turn).toContain('await turnFairOnly(localNodeOrigin, armedFor);');
    expect(turn).toContain('fairOnlyError = turned.ok ? null : turned.error;');
    expect(turn.indexOf('await refreshLocalFingerprint();')).toBeGreaterThan(turn.indexOf('await turnFairOnly('));
    const opened = main.indexOf('if (id === "setnet") {');
    const visit = main.slice(opened, main.indexOf('phone-app-settings-network', opened));
    expect(visit).toContain('fairOnlyArmed = null;\n      if (!fairOnlyTurning) fairOnlyError = null;\n      renderFairOnlyRow();');
  });

  it('drops an armed CONFIRM when the phone goes', () => {
    expect(body('function disarmFairOnly(): void {')).toContain('if (fairOnlyArmed === null) return;\n  fairOnlyArmed = null;\n  renderFairOnlyRow();');
    const auto = main.indexOf('// Auto-enter driver:');
    const away = main.slice(auto, main.indexOf('void enterRoomFromPass(seed);', auto));
    expect(away.indexOf('disarmFairOnly();')).toBeGreaterThan(0);
    expect(away.indexOf('disarmFairOnly();')).toBeLessThan(away.indexOf('container?.classList.remove("active");'));
    const toggle = main.indexOf('const togglePhone = (): void => {');
    expect(main.slice(toggle, main.indexOf('releasePhoneOpener();', toggle))).toContain('disarmFairOnly();');
  });

  it('stands as its own row under the beacon, as one button whose words main.ts writes', () => {
    const beacon = html.indexOf('id="beacon-detail"');
    const row = html.indexOf('<div class="network-row" id="fair-only-row">');
    const detail = html.indexOf('<div class="chia-lane-detail" id="fair-only-detail">');
    const bridge = html.indexOf('id="network-bridge-status"');
    expect(beacon).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(beacon);
    expect(detail).toBeGreaterThan(row);
    expect(bridge).toBeGreaterThan(detail);
    expect(html.slice(row, detail)).toContain('<span class="label">Fair Only</span>');
    expect(html.slice(row, detail)).toContain('<span class="value" id="network-fair-only">--</span>');
    const block = html.slice(detail, html.indexOf('</div>\n        <div class="network-row">', detail));
    expect(FAIR_ONLY_BUTTON_ID).toBe('fair-only-switch');
    expect(block).toContain('<div id="fair-only-note" hidden></div>');
    expect(block).toContain(`<button type="button" id="${FAIR_ONLY_BUTTON_ID}" hidden aria-describedby="fair-only-note fair-only-warning"></button>`);
    expect(block).toContain('<div id="fair-only-warning" hidden></div>');
    expect(block).toContain('<div id="fair-only-error" role="status" hidden></div>');
    expect(block).not.toContain(BEACON_BUTTON_ID);
    for (const id of ['fair-only-row', 'network-fair-only', 'fair-only-note', 'fair-only-switch', 'fair-only-warning', 'fair-only-error']) {
      expect(html.split(`id="${id}"`).length - 1, id).toBe(1);
    }
    for (const rule of ['#fair-only-switch,', '#fair-only-switch[hidden],', '#fair-only-switch[data-danger="true"],', '#fair-only-switch[aria-busy="true"],', '#fair-only-warning,', '#fair-only-error,']) {
      expect(css, rule).toContain(rule);
    }
  });
});
