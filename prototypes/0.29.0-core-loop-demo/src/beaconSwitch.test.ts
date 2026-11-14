/**
 * 🔦 The BEACON row in the SpacePhone's Network rows: what the row and the
 * lines under it say from the node's fingerprint (`chia_beacon`), what
 * lighting a beacon shows the world, how the page asks the node to turn it,
 * and main.ts's and index.html's wiring.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  BEACON_AT_ITS_TURN, BEACON_BUTTON_ID, BEACON_NO_SWITCH, BEACON_NO_WALLET, BEACON_NOT_CONFIRMED, BEACON_NOT_LOOKED, BEACON_ON_CHAIN, BEACON_SENT, BEACON_TIMEOUT_MS,
  BEACON_UNKNOWN_NETWORK, beaconChiaOffLitNote, beaconChiaOffNote, beaconDamagedNote, beaconDefaultOutNote, beaconHeldLitNote, beaconHeldOutNote, beaconLitNote,
  beaconOutNote, beaconRow, beaconStands, beaconState, beaconTarget, beaconTurnOf, beaconWaitsFor, beaconWarning, turnBeacon, type BeaconUi,
} from './beaconSwitch';
import { LANE_NO_NODE_COLOUR, LANE_OFF_COLOUR, LANE_ON_COLOUR, LANE_UNKNOWN_COLOUR } from './chiaLane';
import { MAINNET, TESTNET11 } from './chiaNetwork';
import { LIST_ME_BUTTON_ID } from './listMe';
import type { ChiaBeacon, ChiaBeaconStatus, LocalFingerprint } from './nodeFingerprint';

const BASE: LocalFingerprint = { hex: '00'.repeat(32), base64: 'A'.repeat(43) + '=', port: 4443, iroh_node_id: 'node-a', chia_net: TESTNET11, chia_wallet: { state: 'on' } };
const FOR_T11 = { net: 'testnet11', node: 'node-a' };
const IDLE: BeaconUi = { armed: false, turning: null, error: null };

const LIGHT: NonNullable<ReturnType<typeof beaconRow>['button']> = { act: 'arm', label: 'LIGHT BEACON', danger: false, busy: false };
const CONFIRM: typeof LIGHT = { act: 'confirm', label: '⚠ CONFIRM', danger: true, busy: false };
const PUT_OUT: typeof LIGHT = { act: 'off', label: 'PUT OUT', danger: false, busy: false };
const LIGHTING: typeof LIGHT = { act: 'confirm', label: 'LIGHTING…', danger: false, busy: true };
const PUTTING_OUT: typeof LIGHT = { act: 'confirm', label: 'PUTTING OUT…', danger: false, busy: true };

const OUT_DEFAULT: ChiaBeacon = { on: false, chosen: false };
const OUT: ChiaBeacon = { on: false, chosen: true };
const LIT: ChiaBeacon = { on: true, chosen: true };
const DAMAGED: ChiaBeacon = { on: false, chosen: false, damaged: true };
const LOOKED: ChiaBeaconStatus = { era: 2900, reachable: true, serves_welcome: true, sent: false, confirmed: false };

describe('beaconRow, with no switch to show', () => {
  it('says NO NODE while the node does not answer, and nothing else', () => {
    for (const none of [null, undefined]) {
      const bare = { value: 'NO NODE', colour: LANE_NO_NODE_COLOUR, note: null, warning: null, error: null, button: null };
      expect(beaconRow(none, IDLE)).toEqual(bare);
      // Nor a failure, nor a button for a turn that was in flight: there is no node to send one to.
      expect(beaconRow(none, { armed: true, turning: 'on', error: 'x' })).toEqual(bare);
    }
  });

  it('says NO SWITCH for a node that has none, with why and a failed turn\'s words', () => {
    // An older node, or a build that only reads the chain.
    for (const chia_net of [TESTNET11, MAINNET, null]) {
      const bare = { value: 'NO SWITCH', colour: LANE_UNKNOWN_COLOUR, note: BEACON_NO_SWITCH, warning: null, error: null, button: null };
      expect(beaconRow({ ...BASE, chia_net }, IDLE)).toEqual(bare);
      expect(beaconRow({ ...BASE, chia_net }, { armed: true, turning: 'on', error: null })).toEqual(bare);
      expect(beaconRow({ ...BASE, chia_net }, { ...IDLE, error: 'your node is older than the beacon switch: update Star Station' }))
        .toEqual({ ...bare, error: 'your node is older than the beacon switch: update Star Station' });
    }
  });
});

describe.each([TESTNET11, MAINNET])('beaconRow on $name', (net) => {
  const fp = (chia_beacon: ChiaBeacon, over: Partial<LocalFingerprint> = {}): LocalFingerprint => ({ ...BASE, chia_net: net, chia_beacon, ...over });
  const out = { value: 'OUT', colour: LANE_UNKNOWN_COLOUR, warning: null, error: null };

  it('is out on every network until the player lights it: LIGHT BEACON, then CONFIRM with what a beacon shows, then LIGHTING', () => {
    // D7: opt-in, and the same on a test network as where the coins are real.
    expect(beaconRow(fp(OUT_DEFAULT), IDLE)).toEqual({ ...out, note: beaconDefaultOutNote(net), button: LIGHT });
    expect(beaconRow(fp(OUT), IDLE)).toEqual({ ...out, note: beaconOutNote(net), button: LIGHT });
    expect(beaconRow(fp(DAMAGED), IDLE)).toEqual({ ...out, note: beaconDamagedNote(net), button: LIGHT });
    for (const saved of [OUT_DEFAULT, OUT, DAMAGED]) {
      const armed = beaconRow(fp(saved), { ...IDLE, armed: true });
      expect(armed.button).toEqual(CONFIRM);
      expect(armed.warning).toBe(beaconWarning(net));
      expect(armed.value).toBe('OUT');
      // A turn in flight shows what it is doing and no warning to confirm again.
      expect(beaconRow(fp(saved), { armed: true, turning: 'on', error: null })).toMatchObject({ warning: null, button: LIGHTING });
    }
    // A failed turn's words stand under the switch.
    expect(beaconRow(fp(OUT_DEFAULT), { ...IDLE, error: 'your node could not be reached' }).error).toBe('your node could not be reached');
  });

  it('offers PUT OUT where it is lit, with no CONFIRM, and says what the publisher found', () => {
    const lit = (status?: ChiaBeaconStatus, over: Partial<LocalFingerprint> = {}) => beaconRow(fp(status ? { ...LIT, status } : LIT, over), IDLE);
    // No SSF wallet on: no publisher runs, so nothing is written yet.
    for (const state of ['ready', 'off'] as const) {
      expect(lit(undefined, { chia_wallet: { state } })).toEqual({ value: 'WAITING', colour: LANE_OFF_COLOUR, note: beaconLitNote(net, BEACON_NO_WALLET), warning: null, error: null, button: PUT_OUT });
    }
    // The wallet on, the publisher has not looked yet.
    expect(lit()).toEqual({ value: 'WAITING', colour: LANE_OFF_COLOUR, note: beaconLitNote(net, BEACON_NOT_LOOKED), warning: null, error: null, button: PUT_OUT });
    // It looked: what the beacon still waits for.
    expect(lit(LOOKED)).toMatchObject({ value: 'WAITING', colour: LANE_OFF_COLOUR, note: beaconLitNote(net, BEACON_AT_ITS_TURN), button: PUT_OUT });
    for (const lacks of [{ reachable: false }, { serves_welcome: false }, { reachable: false, serves_welcome: false }]) {
      const status = { ...LOOKED, ...lacks };
      expect(lit(status)).toMatchObject({ value: 'WAITING', colour: LANE_OFF_COLOUR, note: beaconLitNote(net, beaconWaitsFor(status)), button: PUT_OUT });
    }
    // Sent, then read back from the chain.
    expect(lit({ ...LOOKED, sent: true })).toMatchObject({ value: 'SENT', colour: LANE_ON_COLOUR, note: beaconLitNote(net, BEACON_SENT), button: PUT_OUT });
    expect(lit({ ...LOOKED, sent: true, confirmed: true })).toMatchObject({ value: 'ON THE CHAIN', colour: LANE_ON_COLOUR, note: beaconLitNote(net, BEACON_ON_CHAIN), button: PUT_OUT });
    // Armed is nothing to a lit beacon: PUT OUT takes no CONFIRM.
    expect(beaconRow(fp(LIT), { ...IDLE, armed: true })).toMatchObject({ warning: null, button: PUT_OUT });
    expect(beaconRow(fp(LIT), { armed: false, turning: 'off', error: null }).button).toEqual(PUTTING_OUT);
  });

  it("offers no button where the node's environment decides", () => {
    // SSF_CHIA_BEACON=1 holds it lit: the switch cannot put it out.
    const heldLit = beaconRow(fp({ on: true, chosen: false, held: true, status: { ...LOOKED, sent: true, confirmed: true } }), IDLE);
    expect(heldLit).toEqual({ value: 'ON THE CHAIN', colour: LANE_ON_COLOUR, note: beaconHeldLitNote(net, BEACON_ON_CHAIN), warning: null, error: null, button: null });
    expect(heldLit.note).toContain("SSF_CHIA_BEACON=1 in your node's environment holds the beacon lit");
    // Any other value holds it out: the switch cannot light it, armed or not.
    for (const saved of [{ on: false, chosen: false, held: true }, { on: false, chosen: true, held: true }] as ChiaBeacon[]) {
      for (const ui of [IDLE, { ...IDLE, armed: true }]) {
        expect(beaconRow(fp(saved), ui)).toEqual({ ...out, note: beaconHeldOutNote(net), button: null });
      }
    }
  });

  it('takes a put-out, and offers no light, while Chia is off on this computer', () => {
    const chia_lane = { off: true, source: 'setting', setting: 'off' } as const;
    expect(beaconRow(fp(LIT, { chia_lane }), IDLE)).toEqual({ value: 'WAITING', colour: LANE_OFF_COLOUR, note: beaconChiaOffLitNote(net), warning: null, error: null, button: PUT_OUT });
    // Held lit by the environment, the switch has nothing to offer.
    expect(beaconRow(fp({ ...LIT, held: true }, { chia_lane }), IDLE).button).toBeNull();
    for (const saved of [OUT_DEFAULT, OUT, DAMAGED]) {
      for (const ui of [IDLE, { ...IDLE, armed: true }]) {
        expect(beaconRow(fp(saved, { chia_lane }), ui)).toEqual({ ...out, note: beaconChiaOffNote(net), button: null });
      }
    }
  });
});

describe('what a lit beacon is doing', () => {
  const fp = (status?: ChiaBeaconStatus, over: Partial<LocalFingerprint> = {}): LocalFingerprint => ({ ...BASE, chia_beacon: status ? { ...LIT, status } : LIT, ...over });

  it('waits for the wallet first, then for the publisher, then says what it found', () => {
    // The wallet's word comes first: a status from before it went off says nothing now.
    expect(beaconState(fp({ ...LOOKED, sent: true, confirmed: true }, { chia_wallet: { state: 'ready' } })).words).toBe(BEACON_NO_WALLET);
    expect(beaconState(fp()).words).toBe(BEACON_NOT_LOOKED);
    expect(beaconState(fp({ ...LOOKED, sent: true })).value).toBe('SENT');
    expect(beaconState(fp({ ...LOOKED, sent: true, confirmed: true })).value).toBe('ON THE CHAIN');
  });

  it('names each thing a beacon still waits for, and only those', () => {
    const outside = 'it has not taken a direct connection from outside in this edition';
    const welcome = 'it is not serving the welcome room now';
    expect(beaconWaitsFor({ reachable: true, serves_welcome: true })).toBe(BEACON_AT_ITS_TURN);
    const unreachable = beaconWaitsFor({ reachable: false, serves_welcome: true });
    expect(unreachable).toContain(outside);
    expect(unreachable).not.toContain(welcome);
    const elsewhere = beaconWaitsFor({ reachable: true, serves_welcome: false });
    expect(elsewhere).toContain(welcome);
    expect(elsewhere).not.toContain(outside);
    expect(beaconWaitsFor({ reachable: false, serves_welcome: false })).toBe(
      `No beacon is written yet this edition: ${outside}, and ${welcome}. A beacon that leads nowhere helps nobody, so your node writes one only while it can be reached and serves the welcome room.`,
    );
  });
});

describe('the beacon texts, whole', () => {
  it('says before CONFIRM what a beacon shows, to whom, and that it stays', () => {
    expect(beaconWarning(MAINNET)).toBe(
      "Light a beacon on Chia mainnet? Once an edition (about a week), while your node can be reached from outside and serves the welcome room, it writes its node id in the clear where anyone can read it, from a key of its own that the lobby dish pays for, never from your SSF wallet. Anyone can then list the nodes that lit a beacon that week and look up this node's network addresses from its id; new players' games dial it to load the welcome room; and the Chia full nodes your node talks to see its IP address. Your node writes the same id on every Chia network, so one that lights a beacon on two of them can be linked across them. Putting the beacon out stops new ones; what is written stays on the chain. Tap CONFIRM.",
    );
    expect(beaconWarning(TESTNET11)).toBe(beaconWarning(MAINNET).replace('Chia mainnet', 'testnet11'));
    expect(beaconWarning(null)).toContain('Light a beacon on the Chia network your node runs on?');
  });

  it('reads so where it is out, and where it is lit', () => {
    expect(beaconDefaultOutNote(TESTNET11)).toBe(
      "The beacon is out for testnet11, where it starts out. Lit, your node becomes a public door into the welcome room: when a new player's game has nobody else to load the welcome room from, it dials your node.",
    );
    expect(beaconOutNote(MAINNET)).toBe(
      'The beacon is out for Chia mainnet: your node writes no beacon there. One it wrote before stays on the chain; readers stop finding it once its edition and the next have passed.',
    );
    expect(beaconLitNote(TESTNET11, BEACON_ON_CHAIN)).toBe(
      "The beacon is lit for testnet11. Your node is a public door into the welcome room: when a new player's game has nobody else to load the welcome room from, it dials your node. This edition's beacon is on the chain.",
    );
    expect(beaconHeldOutNote(MAINNET)).toBe("SSF_CHIA_BEACON in your node's environment holds the beacon out for Chia mainnet, and the switch here cannot light it.");
  });

  it('calls the player\'s machine their node or this computer, never a station', () => {
    // "Station" is the shared one in the game; the thing that lights a beacon is the player's own computer.
    const texts = [
      BEACON_NO_SWITCH, BEACON_NO_WALLET, BEACON_NOT_LOOKED, BEACON_ON_CHAIN, BEACON_SENT, BEACON_AT_ITS_TURN, BEACON_UNKNOWN_NETWORK, BEACON_NOT_CONFIRMED,
      beaconWaitsFor({ reachable: false, serves_welcome: false }),
      ...[TESTNET11, MAINNET, null].flatMap((net) => [
        beaconWarning(net), beaconDefaultOutNote(net), beaconOutNote(net), beaconDamagedNote(net), beaconHeldOutNote(net), beaconLitNote(net, ''), beaconHeldLitNote(net, ''),
        beaconChiaOffLitNote(net), beaconChiaOffNote(net),
      ]),
    ];
    // The game's own name aside ("update Star Station").
    for (const text of texts) expect(text.split('Star Station').join('').toLowerCase(), text).not.toContain('station');
  });

  it('names no network it does not know, and offers no light there', () => {
    const unknown: LocalFingerprint = { ...BASE, chia_net: null, chia_beacon: OUT_DEFAULT };
    for (const ui of [IDLE, { ...IDLE, armed: true }]) {
      expect(beaconRow(unknown, ui)).toEqual({
        value: 'OUT', colour: LANE_UNKNOWN_COLOUR, note: `${beaconDefaultOutNote(null)} ${BEACON_UNKNOWN_NETWORK}`, warning: null, error: null, button: null,
      });
    }
    // A beacon already lit there can still be put out: an off names no network.
    expect(beaconRow({ ...unknown, chia_beacon: LIT }, IDLE).button).toEqual(PUT_OUT);
  });
});

describe('what a beacon was armed for', () => {
  it('is the network and the node whose warning stood on the page', () => {
    expect(beaconTarget({ ...BASE, chia_beacon: OUT_DEFAULT })).toEqual(FOR_T11);
    expect(beaconTarget({ ...BASE, chia_net: MAINNET })).toEqual({ net: 'mainnet', node: 'node-a' });
    expect(beaconTarget({ ...BASE, chia_net: null })).toBeNull();
    expect(beaconTarget(null)).toBeNull();
  });

  it('stands only while the node that answers is that node on that network', () => {
    expect(beaconStands(FOR_T11, BASE)).toBe(true);
    expect(beaconStands(FOR_T11, { ...BASE, chia_net: MAINNET })).toBe(false);
    expect(beaconStands(FOR_T11, { ...BASE, iroh_node_id: 'node-b' })).toBe(false);
    expect(beaconStands(FOR_T11, null)).toBe(false);
    expect(beaconStands(null, BASE)).toBe(false);
  });
});

describe('beaconTurnOf', () => {
  it('lights only from CONFIRM, puts out from PUT OUT, and does nothing from LIGHT BEACON', () => {
    expect(beaconTurnOf('confirm')).toBe(true);
    expect(beaconTurnOf('off')).toBe(false);
    for (const none of ['arm', '', undefined, 'on', 'keep']) expect(beaconTurnOf(none)).toBeNull();
  });
});

const answer = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('turnBeacon', () => {
  it("POSTs a simple request to the node's own origin, refusing redirects", async () => {
    const fetchImpl = vi.fn(async () => answer(200, { ok: true, beacon: { on: true, chosen: true } }));
    await expect(turnBeacon('http://127.0.0.1:8081', true, FOR_T11, fetchImpl as unknown as typeof fetch)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8081/api/chia/beacon?on=1&net=testnet11&node=node-a');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    await turnBeacon('http://127.0.0.1:8080', false, null, fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe('http://127.0.0.1:8080/api/chia/beacon?on=0');
    expect(BEACON_TIMEOUT_MS).toBe(15_000);
  });

  it('lights for the network and the node it was confirmed for, and puts out for none', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { ok: true, beacon: { on: true, chosen: true } }));
    const asked = (): string => (fetchImpl.mock.calls.at(-1) as unknown as [string])[0];
    await turnBeacon('http://127.0.0.1:8080', true, { net: 'mainnet', node: 'a b&c=d' }, fetchImpl as unknown as typeof fetch);
    expect(asked()).toBe('http://127.0.0.1:8080/api/chia/beacon?on=1&net=mainnet&node=a%20b%26c%3Dd');
    // Putting out only stops writes: it names nothing, whatever it is handed.
    await turnBeacon('http://127.0.0.1:8080', false, { net: 'mainnet', node: 'node-a' }, fetchImpl as unknown as typeof fetch);
    expect(asked()).toBe('http://127.0.0.1:8080/api/chia/beacon?on=0');
    // An on with nothing it was confirmed for is not sent at all.
    expect(await turnBeacon('http://127.0.0.1:8080', true, null, fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, error: BEACON_NOT_CONFIRMED });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("brings back the node's own refusal, or words what the page saw", async () => {
    const said = async (res: Response) => turnBeacon('http://127.0.0.1:8080', true, FOR_T11, (async () => res) as unknown as typeof fetch);
    // The node's words, as chia_beacon_switch.rs says them.
    const chiaOff = 'Chia is off on this computer, so the beacon cannot be lit; turn Chia back on first';
    expect(await said(answer(409, { ok: false, error: `  ${chiaOff}  `, beacon: { on: false, chosen: false } }))).toEqual({ ok: false, error: chiaOff });
    const heldOff = 'the beacon is switched off on this node by SSF_CHIA_BEACON in its environment; the switch here cannot light it';
    expect(await said(answer(409, { ok: false, error: heldOff, beacon: { on: false, chosen: false, held: true } }))).toEqual({ ok: false, error: heldOff });
    const pageOnly = "only this computer's own Star Station page can light the beacon or put it out";
    expect(await said(answer(403, { ok: false, error: pageOnly }))).toEqual({ ok: false, error: pageOnly });
    expect(await said(answer(403, { ok: false }))).toEqual({ ok: false, error: 'your node answered 403' });
    expect(await said(answer(500, 'not json'))).toEqual({ ok: false, error: 'your node answered 500' });
    // A 200 that does not say ok is no turn.
    expect(await said(answer(200, { ok: 'yes' }))).toEqual({ ok: false, error: 'your node answered 200' });
    expect(await said(answer(200, { beacon: { on: true, chosen: true } }))).toEqual({ ok: false, error: 'your node answered 200' });
    expect((await said(answer(409, { ok: false, error: 'x'.repeat(900) })) as { error: string }).error).toHaveLength(400);
    expect(await said(new Response('', { status: 404 }))).toEqual({ ok: false, error: 'your node is older than the beacon switch: update Star Station' });
  });

  it('never throws: no origin, an unreachable node, or no answer in time', async () => {
    const never = vi.fn();
    expect(await turnBeacon('', true, FOR_T11, never as unknown as typeof fetch)).toEqual({ ok: false, error: 'your node is not answering' });
    expect(never).not.toHaveBeenCalled();
    const unreachable = async () => { throw new TypeError('Failed to fetch'); };
    expect(await turnBeacon('http://127.0.0.1:8080', true, FOR_T11, unreachable as unknown as typeof fetch)).toEqual({ ok: false, error: 'your node could not be reached' });
    const hangs = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    expect(await turnBeacon('http://127.0.0.1:8080', true, FOR_T11, hangs as unknown as typeof fetch, 20)).toEqual({
      ok: false, error: 'your node did not answer in time; it may still be lighting the beacon, so look again in a moment',
    });
    expect(await turnBeacon('http://127.0.0.1:8080', false, null, hangs as unknown as typeof fetch, 20)).toEqual({
      ok: false, error: 'your node did not answer in time; it may still be putting the beacon out, so look again in a moment',
    });
    // Headers in time, the body not: still a timeout, not "answered 200".
    const trickles = async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }) as unknown as Response;
    const slowBody = await turnBeacon('http://127.0.0.1:8080', true, FOR_T11, trickles as unknown as typeof fetch, 20);
    expect((slowBody as { error: string }).error).toContain('did not answer in time');
  });
});

describe('main.ts and index.html wire the beacon switch', () => {
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const main = read('./main.ts');
  const html = read('../index.html');
  const css = read('./index-inline.css');
  const body = (head: string): string => {
    const at = main.indexOf(head);
    expect(at, head).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n}\n', at));
  };

  it('draws the row from the node that answered, in both rounds of the fingerprint, and never with innerHTML', () => {
    const render = body('function renderBeaconRow(): void {');
    expect(render).toContain('const fp = localNodeLive ? localFingerprint : null;');
    expect(render).toContain('beaconRow(fp, { armed: beaconStands(beaconArmed, fp), turning: beaconTurning, error: beaconError });');
    expect(render).toContain('setNetworkRow("network-beacon", row.value, row.colour);');
    expect(render).toContain('getElementById(BEACON_BUTTON_ID)');
    for (const id of ['beacon-note', 'beacon-warning', 'beacon-error']) expect(render).toContain(`line("${id}", `);
    expect(render).not.toContain('innerHTML');
    // An inert button keeps focus: aria-disabled, never disabled.
    expect(render).toContain('btn.setAttribute("aria-disabled", "true");');
    expect(render).not.toContain('.disabled');
    const refresh = body('async function refreshLocalFingerprint(');
    const gone = refresh.indexOf('renderPhoneBookIndicator(null);');
    const live = refresh.indexOf('renderPhoneBookIndicator(fingerprint);');
    expect(gone).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(gone);
    expect(refresh.indexOf('renderBeaconRow();', gone)).toBeLessThan(live);
    expect(refresh.indexOf('renderBeaconRow();', live)).toBeGreaterThan(live);
    // A node that went leaves no CONFIRM armed for the next one.
    expect(refresh.slice(0, gone)).toContain('beaconArmed = null;');
    // A node that answers as another node, or on another network, disarms it too.
    expect(refresh.slice(gone)).toContain('if (!beaconStands(beaconArmed, fingerprint)) beaconArmed = null;');
  });

  it('takes a fresh tap for CONFIRM and PUT OUT, no held key, and no tap while a turn is in flight', () => {
    const at = main.indexOf('document.getElementById(BEACON_BUTTON_ID) as HTMLButtonElement | null;\n  if (beaconBtn)');
    expect(at).toBeGreaterThan(0);
    const wiring = main.slice(at, main.indexOf("// The view's own ↑/↓ traversal", at));
    expect(wiring).toContain('if (beaconBtn.getAttribute("aria-disabled") === "true") return;');
    expect(wiring).toContain('if (act !== "arm" && !freshTap((e as MouseEvent).detail, performance.now(), beaconChangedAt)) return;');
    expect(wiring).toContain('if (laneKeyRepeat(e)) e.preventDefault();');
    expect(wiring).toContain('const lit = beaconTurnOf(act);\n      if (lit !== null) void turnBeaconSwitch(lit);');
    // Arming sends nothing.
    const arm = wiring.slice(wiring.indexOf('if (act === "arm") {'), wiring.indexOf('const lit = beaconTurnOf(act);'));
    expect(arm).toContain('beaconArmed = beaconTarget(localNodeLive ? localFingerprint : null);');
    expect(arm).toContain('return;');
    expect(arm).not.toContain('turnBeacon');
  });

  it('reads the fingerprint again after a turn, and starts each visit to the view disarmed', () => {
    const turn = body('async function turnBeaconSwitch(on: boolean): Promise<void> {');
    expect(turn).toContain('if (beaconTurning) return;');
    expect(turn).toContain('const armedFor = beaconArmed;');
    expect(turn.indexOf('const armedFor = beaconArmed;')).toBeLessThan(turn.indexOf('beaconArmed = null;'));
    expect(turn).toContain('await turnBeacon(localNodeOrigin, on, on ? armedFor : null);');
    expect(turn).toContain('beaconError = turned.ok ? null : turned.error;');
    expect(turn.indexOf('await refreshLocalFingerprint();')).toBeGreaterThan(turn.indexOf('await turnBeacon('));
    const opened = main.indexOf('if (id === "setnet") {');
    expect(opened).toBeGreaterThan(0);
    const visit = main.slice(opened, main.indexOf('phone-app-settings-network', opened));
    expect(visit).toContain('beaconArmed = null;\n      if (!beaconTurning) beaconError = null;\n      renderBeaconRow();');
  });

  it('stands as its own row under LIST ME, as one button whose words main.ts writes', () => {
    const listMe = html.indexOf('id="list-me-detail"');
    const row = html.indexOf('<div class="network-row" id="beacon-row">');
    const detail = html.indexOf('<div class="chia-lane-detail" id="beacon-detail">');
    const bridge = html.indexOf('id="network-bridge-status"');
    expect(listMe).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(listMe);
    expect(detail).toBeGreaterThan(row);
    expect(bridge).toBeGreaterThan(detail);
    expect(html.slice(row, detail)).toContain('<span class="label">Beacon</span>');
    expect(html.slice(row, detail)).toContain('<span class="value" id="network-beacon">--</span>');
    const block = html.slice(detail, html.indexOf('</div>\n        <div class="network-row">', detail));
    expect(BEACON_BUTTON_ID).toBe('beacon-switch');
    expect(block).toContain('<div id="beacon-note" hidden></div>');
    expect(block).toContain(`<button type="button" id="${BEACON_BUTTON_ID}" hidden aria-describedby="beacon-note beacon-warning"></button>`);
    expect(block).toContain('<div id="beacon-warning" hidden></div>');
    expect(block).toContain('<div id="beacon-error" role="status" hidden></div>');
    // Its own button, not LIST ME's.
    expect(block).not.toContain(LIST_ME_BUTTON_ID);
    // One of each in the page.
    for (const id of ['beacon-row', 'network-beacon', 'beacon-note', 'beacon-switch', 'beacon-warning', 'beacon-error']) {
      expect(html.split(`id="${id}"`).length - 1, id).toBe(1);
    }
    // Styled as the CHIA switch is: danger and busy follow its attributes.
    for (const rule of ['#beacon-switch,', '#beacon-switch[hidden],', '#beacon-switch[data-danger="true"],', '#beacon-switch[aria-busy="true"],', '#beacon-warning,', '#beacon-error,']) {
      expect(css, rule).toContain(rule);
    }
  });
});
