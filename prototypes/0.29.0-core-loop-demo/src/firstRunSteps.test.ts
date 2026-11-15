import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ENTER_PATIENCE_MS,
  REPORT_ECHO_MS,
  REPORT_LOG_MAX,
  STEP_COLOR,
  TITLE_BACKGROUND,
  enterMode,
  enterNote,
  firstRunSteps,
  isReportEcho,
  newDialTally,
  noFacts,
  noteDial,
  stepGlyph,
  type FirstRunFacts,
  type ReportLog,
  type StepKey,
  type StepLine,
} from './firstRunSteps';

const ROOM = 'SSF-WELCOME';
const up = (over: Partial<FirstRunFacts> = {}): FirstRunFacts => ({ ...noFacts(), node: 'up', ...over });
const line = (lines: StepLine[], key: StepKey): StepLine | undefined => lines.find((l) => l.key === key);
const keys = (lines: StepLine[]): StepKey[] => lines.map((l) => l.key);

describe('firstRunSteps: the node comes first', () => {
  it('says the node is starting before anything is known, and nothing of Chia or the wallet', () => {
    const lines = firstRunSteps(noFacts(), ROOM);
    expect(keys(lines)).toEqual(['node', 'dial', 'room']);
    expect(line(lines, 'node')).toMatchObject({ mark: 'busy' });
    expect(line(lines, 'dial')).toMatchObject({ mark: 'wait', text: 'Dialing SSF-WELCOME waits for the node.' });
    expect(line(lines, 'room')?.mark).toBe('wait');
  });

  it('says a silent node is waited for, and that the game keeps trying', () => {
    const lines = firstRunSteps({ ...noFacts(), node: 'down' }, ROOM);
    expect(line(lines, 'node')).toMatchObject({ mark: 'wait' });
    expect(line(lines, 'node')?.text).toContain('keeps trying');
    expect(keys(lines)).toEqual(['node', 'dial', 'room']);
  });

  it('says "your computer", never "station"', () => {
    const every: FirstRunFacts[] = [
      noFacts(),
      { ...noFacts(), node: 'down' },
      up({ chiaOff: false, wallet: 'on', dialing: 2 }),
      up({ chiaOff: false, wallet: 'ready', failed: 1 }),
      up({ chiaOff: false, wallet: 'off' }),
      up({ chiaOff: true }),
      up({ linked: true }),
      up({ linked: true, arrived: true }),
    ];
    for (const f of every) {
      for (const l of firstRunSteps(f, ROOM)) expect(l.text.toLowerCase()).not.toContain('station');
    }
  });
});

describe('firstRunSteps: the Phone Book and its wallet', () => {
  it('has no Chia or wallet line for a node that says nothing of them', () => {
    expect(keys(firstRunSteps(up(), ROOM))).toEqual(['node', 'dial', 'room']);
  });

  it('says Chia is off, and then nothing of the wallet', () => {
    const lines = firstRunSteps(up({ chiaOff: true, wallet: 'on' }), ROOM);
    expect(line(lines, 'chia')).toMatchObject({ mark: 'off' });
    expect(line(lines, 'wallet')).toBeUndefined();
  });

  it('says Chia is on and the wallet is on', () => {
    const lines = firstRunSteps(up({ chiaOff: false, wallet: 'on' }), ROOM);
    expect(line(lines, 'chia')).toMatchObject({ mark: 'done' });
    expect(line(lines, 'wallet')).toMatchObject({ mark: 'done' });
  });

  it('claims for a wallet that is on only what LIST ME allows it to write', () => {
    const wallet = (listing?: FirstRunFacts['listing']) => line(firstRunSteps(up({ chiaOff: false, wallet: 'on', listing }), ROOM), 'wallet');
    // LIST ME on: the listing and the knocks.
    expect(wallet('all')).toEqual({ key: 'wallet', mark: 'done', text: 'The SSF wallet is on: your computer can knock and list itself.' });
    // On, with the listing held off by the node's environment: the knocks alone.
    expect(wallet('knocks')).toEqual({ key: 'wallet', mark: 'done', text: 'The SSF wallet is on: your computer can knock. Its listing is held off on this computer.' });
    // LIST ME off (as it starts where the coins are real money): no listing
    // and no knock. The beacon has its own switch, so the line never says
    // that nothing is written.
    const none = wallet('none');
    expect(none).toEqual({ key: 'wallet', mark: 'off', text: 'The SSF wallet is on, but LIST ME is off: your computer reads the Phone Book and writes no listing and no knock in it.' });
    expect(none?.text).not.toMatch(/nothing/i);
    // A node that says nothing of LIST ME: the wallet's state and no more.
    const bare = wallet(undefined);
    expect(bare).toEqual({ key: 'wallet', mark: 'done', text: 'The SSF wallet is on.' });
    expect(bare?.text).not.toMatch(/knock|list/i);
  });

  it('says a wallet that can be turned on is not on, and where to turn it on', () => {
    const l = line(firstRunSteps(up({ chiaOff: false, wallet: 'ready' }), ROOM), 'wallet');
    expect(l?.mark).toBe('off');
    expect(l?.text).toContain('Bank');
    expect(l?.text).toContain('read the Phone Book but not write');
  });

  it('promises no new wallet: `ready` is also a saved wallet that is off', () => {
    // The node says `ready` with a wallet on disk too (the Bank then offers
    // TURN ON, not CREATE), and the title is not told which.
    const text = line(firstRunSteps(up({ chiaOff: false, wallet: 'ready' }), ROOM), 'wallet')?.text ?? '';
    expect(text).not.toMatch(/No SSF wallet|makes one|\bnew\b|creat/i);
    expect(text).toContain('not on');
  });

  it('says a wallet held off is held off, with no way offered that is not there', () => {
    const l = line(firstRunSteps(up({ chiaOff: false, wallet: 'off' }), ROOM), 'wallet');
    expect(l?.mark).toBe('off');
    expect(l?.text).not.toContain('Bank');
  });

  it('has no wallet line for a build that holds none', () => {
    expect(line(firstRunSteps(up({ chiaOff: false, wallet: 'unbuilt' }), ROOM), 'wallet')).toBeUndefined();
    expect(line(firstRunSteps(up({ chiaOff: false }), ROOM), 'wallet')).toBeUndefined();
  });
});

describe('firstRunSteps: the dial and the room', () => {
  it('looks before it dials', () => {
    expect(line(firstRunSteps(up(), ROOM), 'dial')).toMatchObject({
      mark: 'busy',
      text: 'Looking for computers that hold SSF-WELCOME…',
    });
  });

  it('counts the computers it dials, one or several', () => {
    expect(line(firstRunSteps(up({ dialing: 1 }), ROOM), 'dial')?.text).toBe('Dialing 1 computer that holds SSF-WELCOME…');
    expect(line(firstRunSteps(up({ dialing: 3 }), ROOM), 'dial')?.text).toBe('Dialing 3 computers that hold SSF-WELCOME…');
  });

  it('a dial under way is said before the failures beside it', () => {
    expect(line(firstRunSteps(up({ dialing: 1, failed: 2 }), ROOM), 'dial')?.mark).toBe('busy');
  });

  it('says nobody answered yet and that it keeps trying', () => {
    const l = line(firstRunSteps(up({ failed: 2 }), ROOM), 'dial');
    expect(l).toMatchObject({ mark: 'wait', text: 'No answer from 2 computers yet. Your computer keeps trying.' });
  });

  it('a link is an answer, not the room', () => {
    const lines = firstRunSteps(up({ linked: true, failed: 1 }), ROOM);
    expect(line(lines, 'dial')).toMatchObject({ mark: 'done', text: 'A computer answered.' });
    expect(line(lines, 'room')).toMatchObject({ mark: 'busy', text: 'Asking it for SSF-WELCOME…' });
  });

  it('the room here is the last word, whatever the dial says', () => {
    const lines = firstRunSteps(up({ arrived: true, dialing: 2, failed: 1 }), ROOM);
    expect(line(lines, 'dial')?.mark).toBe('done');
    expect(line(lines, 'room')).toMatchObject({ mark: 'done', text: 'SSF-WELCOME is here.' });
  });

  it('promises no entry while nobody answered: the room fills in by itself', () => {
    expect(line(firstRunSteps(up({ failed: 1 }), ROOM), 'room')?.text).toBe(
      'SSF-WELCOME fills in by itself when a computer answers.',
    );
  });
});

describe('enterMode: ENTER is always there', () => {
  it('says the room is here once it is, however short the wait', () => {
    expect(enterMode(true, 0)).toBe('here');
    expect(enterMode(true, ENTER_PATIENCE_MS * 10)).toBe('here');
  });

  it('is quiet inside the patience and lit from its end on', () => {
    expect(enterMode(false, 0)).toBe('quiet');
    expect(enterMode(false, ENTER_PATIENCE_MS - 1)).toBe('quiet');
    expect(enterMode(false, ENTER_PATIENCE_MS)).toBe('lit');
    expect(enterMode(false, ENTER_PATIENCE_MS * 100)).toBe('lit');
  });

  it('has no mode in which the player cannot enter', () => {
    // Each is the ENTER button, lit or quiet. Nothing else.
    const modes = new Set([enterMode(true, 0), enterMode(false, 0), enterMode(false, ENTER_PATIENCE_MS)]);
    expect([...modes].sort()).toEqual(['here', 'lit', 'quiet']);
  });

  it('says in each mode what entering now means', () => {
    expect(enterNote('quiet', ROOM)).toContain('You can enter at any time');
    expect(enterNote('lit', ROOM)).toContain('SSF-WELCOME is not here yet');
    expect(enterNote('lit', ROOM)).toContain('fills in by itself');
    expect(enterNote('here', ROOM)).toBe('SSF-WELCOME is here. Enter when your fox is ready.');
  });

  it('never says nobody answered: a computer that answered may not hold the room yet', () => {
    // Two installs that both wait for the room link to each other: the steps
    // then say "A computer answered." and the note under ENTER must not say
    // the opposite once the patience is over.
    const lines = firstRunSteps(up({ linked: true }), ROOM);
    expect(line(lines, 'dial')?.text).toBe('A computer answered.');
    expect(line(lines, 'room')).toMatchObject({ mark: 'busy' });
    for (const mode of ['quiet', 'lit'] as const) {
      const note = enterNote(mode, ROOM);
      expect(note).not.toMatch(/nobody|no one|has answered/i);
      expect(note).toContain('a computer that holds it answers');
    }
  });
});

describe('noteDial: one computer, one place', () => {
  it('counts a computer once, however often it is dialed', () => {
    const t = newDialTally();
    noteDial(t, 'aaaa', 'dialing');
    noteDial(t, 'aaaa', 'dialing');
    noteDial(t, 'bbbb', 'dialing');
    expect(t.dialing.size).toBe(2);
    expect(t.failed.size).toBe(0);
    expect(t.linked).toBe(false);
  });

  it('moves a computer from dialing to failed and back', () => {
    const t = newDialTally();
    noteDial(t, 'aaaa', 'dialing');
    noteDial(t, 'aaaa', 'failed');
    expect([t.dialing.size, t.failed.size]).toEqual([0, 1]);
    noteDial(t, 'aaaa', 'dialing');
    expect([t.dialing.size, t.failed.size]).toEqual([1, 0]);
  });

  it('an answer takes the computer out of both and marks the link', () => {
    const t = newDialTally();
    noteDial(t, 'aaaa', 'dialing');
    noteDial(t, 'bbbb', 'failed');
    noteDial(t, 'aaaa', 'connected');
    expect([t.dialing.size, t.failed.size, t.linked]).toEqual([0, 1, true]);
  });

  it('ignores a report that names nobody, and a status it does not know', () => {
    const t = newDialTally();
    noteDial(t, undefined, 'dialing');
    noteDial(t, '', 'failed');
    noteDial(t, 'aaaa', 'something-new');
    noteDial(t, 'aaaa', undefined);
    expect([t.dialing.size, t.failed.size, t.linked]).toEqual([0, 0, false]);
  });
});

describe('a dial that gave up is told to every page of the room', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it('a page that began no dial of its own leaves "Dialing" when the node says the dial failed', () => {
    // The page counted the computer from its session's record; another
    // page's dial was running, so no report came on this page's own stream.
    const t = newDialTally();
    noteDial(t, A, 'dialing');
    expect(line(firstRunSteps(up({ dialing: t.dialing.size, failed: t.failed.size, linked: t.linked }), ROOM), 'dial')?.text).toMatch(/^Dialing 1 computer\b/);
    // The node's word to every page of the room.
    noteDial(t, A, 'failed');
    const dial = line(firstRunSteps(up({ dialing: t.dialing.size, failed: t.failed.size, linked: t.linked }), ROOM), 'dial');
    expect(dial?.text).toContain('No answer from 1 computer yet');
    expect(dial?.text).not.toContain('Dialing');
  });

  it('the page that began the dial hears its end twice, and the second copy is known for one', () => {
    const log: ReportLog = new Map();
    expect(isReportEcho(log, A, 'failed', 'no route after 8 attempts', 1_000)).toBe(false);
    expect(isReportEcho(log, A, 'failed', 'no route after 8 attempts', 1_004)).toBe(true);
    // A third copy inside the window is one too: it is measured from the second.
    expect(isReportEcho(log, A, 'failed', 'no route after 8 attempts', 1_010)).toBe(true);
  });

  it('a later dial that fails the same way is a new report', () => {
    const log: ReportLog = new Map();
    expect(isReportEcho(log, A, 'failed', 'no route after 8 attempts', 0)).toBe(false);
    expect(isReportEcho(log, A, 'failed', 'no route after 8 attempts', REPORT_ECHO_MS)).toBe(false);
    // No dial gives up twice inside the window: the fastest takes seconds.
    expect(REPORT_ECHO_MS).toBeLessThanOrEqual(5_000);
    expect(REPORT_ECHO_MS).toBeGreaterThanOrEqual(500);
  });

  it('another computer, another status or another detail is never a copy', () => {
    const log: ReportLog = new Map();
    expect(isReportEcho(log, A, 'failed', 'no route after 8 attempts', 0)).toBe(false);
    expect(isReportEcho(log, B, 'failed', 'no route after 8 attempts', 1)).toBe(false);
    expect(isReportEcho(log, A, 'failed', 'no route; knocking through the chain', 2)).toBe(false);
    expect(isReportEcho(log, A, 'dialing', undefined, 3)).toBe(false);
    expect(isReportEcho(log, A, 'failed', undefined, 4)).toBe(false);
    expect(isReportEcho(log, A, 'failed', undefined, 5)).toBe(true);
  });

  it('a report that names nobody, or no status, is never a copy and is not noted; a clock that ran back is not one either', () => {
    const log: ReportLog = new Map();
    expect(isReportEcho(log, undefined, 'failed', 'x', 0)).toBe(false);
    expect(isReportEcho(log, undefined, 'failed', 'x', 1)).toBe(false);
    expect(isReportEcho(log, '', 'failed', 'x', 2)).toBe(false);
    expect(isReportEcho(log, A, undefined, 'x', 3)).toBe(false);
    expect(log.size).toBe(0);
    expect(isReportEcho(log, A, 'failed', 'x', 10_000)).toBe(false);
    expect(isReportEcho(log, A, 'failed', 'x', 9_000)).toBe(false);
  });

  it('remembers the most lately heard computers, and no more of them than the limit', () => {
    const log: ReportLog = new Map();
    for (let i = 0; i < REPORT_LOG_MAX + 10; i++) isReportEcho(log, `node-${i}`, 'failed', 'x', i);
    expect(log.size).toBe(REPORT_LOG_MAX);
    expect(log.has('node-0')).toBe(false);
    expect(log.has(`node-${REPORT_LOG_MAX + 9}`)).toBe(true);
    // Heard again, a computer is among the latest once more.
    isReportEcho(log, 'node-10', 'failed', 'x', 10_000);
    for (let i = 0; i < 5; i++) isReportEcho(log, `late-${i}`, 'failed', 'x', 10_001 + i);
    expect(log.has('node-10')).toBe(true);
  });
});

describe('stepGlyph', () => {
  it('has a mark of its own for each state', () => {
    const glyphs = (['done', 'busy', 'wait', 'off'] as const).map(stepGlyph);
    expect(new Set(glyphs).size).toBe(4);
  });
});

describe('STEP_COLOR: every line reads against the title', () => {
  // WCAG 2 relative luminance and contrast ratio.
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: readonly [number, number, number]): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const rgbOf = (hex: string): [number, number, number] => {
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  };
  const contrast = (hex: string): number => {
    const [hi, lo] = [luminance(rgbOf(hex)), luminance(TITLE_BACKGROUND)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('gives each mark an opaque colour at 4.5 to 1 or better, the off lines too', () => {
    for (const mark of ['done', 'busy', 'wait', 'off'] as const) {
      expect(contrast(STEP_COLOR[mark]), `${mark} ${STEP_COLOR[mark]}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the off lines the dimmest', () => {
    expect(contrast(STEP_COLOR.off)).toBeLessThan(contrast(STEP_COLOR.wait));
  });

  it('measures against the background the title really has', () => {
    const css = readFileSync(fileURLToPath(new URL('./index-inline.css', import.meta.url)), 'utf8');
    const a = css.indexOf('#welcome {');
    expect(a).toBeGreaterThan(-1);
    const rule = css.slice(a, css.indexOf('}', a));
    expect(rule).toContain(`background: rgb(${TITLE_BACKGROUND.join(', ')});`);
  });
});

describe('main.ts: the title is wired to the search', () => {
  const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
  const between = (from: string, to: string): string => {
    const a = main.indexOf(from);
    expect(a, `main.ts has "${from}"`).toBeGreaterThan(-1);
    const b = main.indexOf(to, a + from.length);
    expect(b, `main.ts has "${to}" after "${from}"`).toBeGreaterThan(a);
    return main.slice(a, b);
  };

  it('ENTER NOW reveals whatever the search says: its handler asks nothing', () => {
    const handler = between('btnEnter.addEventListener("click"', '});');
    expect(handler).toContain('proceed();');
    expect(handler).not.toMatch(/\bif\b/);
  });

  it('NEW PLAYER waits only for the welcome room, and lights ENTER at once for another', () => {
    const handler = between('btnNew.addEventListener("click"', 'btnEnter.addEventListener("click"');
    expect(handler).toContain('if (!waitsForWelcome()) {\n          // Not the welcome room (a pass to another): nothing to wait for.\n          lightEnter("ready", ENTER_READY_NOTE);');
    // ENTER is shown in the same step that hides the two choices.
    expect(handler).toContain('btnEnter.style.display = "";');
  });

  it('a title that was left stops hearing of the search', () => {
    const proceed = between('const proceed = () => {', 'maybeFade();');
    expect(proceed).toContain('firstRunRepaint = null;');
    expect(proceed).toContain('window.clearInterval(holdTimer)');
  });

  it('only the welcome room\'s dial reports are counted', () => {
    const counted = between('if (env.room === DEFAULT_STATION.welcomeRoomId) {\n      noteDial(', '}');
    expect(counted).toContain('firstRunDial');
  });

  it('the first dial is counted from the session\'s record, never this computer\'s own node', () => {
    const seeded = between('const own = localFingerprint?.iroh_node_id;\n    const record = withHeldWelcomeRoutes(', 'firstRunRepaint?.();');
    expect(seeded).toContain('hint.irohNodeId !== own');
    expect(seeded).toContain('noteDial(firstRunDial, hint.irohNodeId, "dialing");');
  });

  it('the record is counted before the first handshake leaves, so no report is overwritten by a late "dialing"', () => {
    const join = between('const sync = new YjsSync({\n    roomId: boot.roomId,\n    channel,', 'networkProvider.onEnvelope(');
    const seeded = join.indexOf('noteDial(firstRunDial, hint.irohNodeId, "dialing");');
    const started = join.indexOf('await sync.start();');
    expect(seeded).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(seeded);
    // And nowhere after it.
    expect(join.indexOf('noteDial(firstRunDial', started)).toBe(-1);
  });

  it('the dial reports of the session\'s own stream reach the same handler as the node\'s other reports', () => {
    // The node answers the handshake's dial (the record's first computer) on
    // the handshake's stream: YjsSync hands them over, and only `bridge`
    // ones, and only while that session is the page's.
    const made = between('const sync = new YjsSync({\n    roomId: boot.roomId,\n    channel,', '});');
    expect(made).toContain('onOtherEnvelope: (env) => {');
    expect(made).toContain('if (env.kind === "bridge" && yjsSync === sync) noteBridgeEnvelope(env);');
    // The node-opened streams end in that handler too, and it is the one
    // place that counts for the title.
    expect(between('networkProvider.onEnvelope(\n', '// Bind shared players map')).toContain('if (env.kind === "bridge") noteBridgeEnvelope(env);');
    expect(main.split('noteDial(firstRunDial, status.target, status.status);').length).toBe(2);
    const handler = between('function noteBridgeEnvelope(', '\n}\n');
    expect(handler).toContain('if (env.kind !== "bridge" || typeof env.payload !== "string") return;');
    expect(handler).toContain('noteDial(firstRunDial, status.target, status.status);');
  });

  it('a failed dial counts for the title whichever copy brings it, and its second copy is not said again on the phone', () => {
    const handler = main.slice(main.indexOf('function noteBridgeEnvelope('), main.indexOf('/** 🛰️ Where the welcome mark is kept'));
    const tally = handler.indexOf('noteDial(firstRunDial, status.target, status.status);');
    const failed = handler.indexOf('} else if (status.status === "failed") {');
    const echo = handler.indexOf('isReportEcho(', failed);
    const said = handler.indexOf('logToPhoneSystem(', failed);
    expect(tally).toBeGreaterThan(-1);
    // The tally is kept before any copy is told apart: both copies count the same.
    expect(tally).toBeLessThan(failed);
    expect(echo).toBeGreaterThan(failed);
    expect(said).toBeGreaterThan(echo);
    // Only a failure is told apart: a `connected` is acted on every time it
    // comes (it marks the link and asks the room again).
    const connected = handler.slice(handler.indexOf('} else if (status.status === "connected") {'), failed);
    expect(connected).toContain('yjsSync?.resync();');
    expect(connected).not.toContain('isReportEcho(');
  });

  it('the title reads only a node that answers now, and is told of one that stopped', () => {
    const facts = between('function firstRunFactsNow(): FirstRunFacts {', '\n}\n');
    expect(facts).toContain('const fp = localNodeLive ? localFingerprint : null;');
    expect(facts).not.toContain('const fp = localFingerprint;');
    // A probe the node did not answer: live no longer, then the title is told.
    const silent = between('if (!fingerprint) {', 'return localFingerprint;');
    const off = silent.indexOf('localNodeLive = false;');
    expect(off).toBeGreaterThan(-1);
    expect(silent.indexOf('firstRunNodeSilent = true;')).toBeGreaterThan(off);
    expect(silent.indexOf('firstRunRepaint?.();')).toBeGreaterThan(silent.indexOf('firstRunNodeSilent = true;'));
  });

  it('the title is told of the node once it counts as live, of a silent node, and of the arrival', () => {
    const told = between('localNodeOrigin = nodeOrigin;\n  localNodeLive = true;', 'const backupMoved');
    expect(told).toContain('firstRunNodeSilent = false;');
    expect(told).toContain('firstRunRepaint?.();');
    expect(between('No running Rust node found', 'updateHUDNode')).toContain('firstRunNodeSilent = true;');
    expect(between('welcomeReachedThisPage = true;\n', 'clearWelcomePending(welcomeStore());')).toContain('firstRunRepaint?.();');
  });

  it('the fox chooser takes the focus when it and ENTER NOW replace the two choices (Tab is the phone\'s key)', () => {
    const handler = between('btnNew.addEventListener("click"', 'btnEnter.addEventListener("click"');
    const shown = handler.indexOf('btnEnter.style.display = "";');
    expect(shown).toBeGreaterThan(handler.indexOf('btnNew.style.display = "none";'));
    expect(handler.indexOf('chooser.focus();')).toBeGreaterThan(shown);
    // ENTER follows the chooser, so Tab reaches it from the choices.
    expect(handler).toContain('wrap.insertBefore(chooser.element, btnEnter);');
  });
});
