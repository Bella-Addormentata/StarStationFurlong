import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ENTER_PATIENCE_MS,
  enterMode,
  enterNote,
  firstRunSteps,
  newDialTally,
  noFacts,
  noteDial,
  stepGlyph,
  type FirstRunFacts,
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

  it('says where a wallet is made when there is none yet', () => {
    const l = line(firstRunSteps(up({ chiaOff: false, wallet: 'ready' }), ROOM), 'wallet');
    expect(l?.mark).toBe('off');
    expect(l?.text).toContain('Bank');
    expect(l?.text).toContain('read the Phone Book but not write');
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
  it('reveals by itself once the room is here, however short the wait', () => {
    expect(enterMode(true, 0)).toBe('reveal');
    expect(enterMode(true, ENTER_PATIENCE_MS * 10)).toBe('reveal');
  });

  it('is quiet inside the patience and lit from its end on', () => {
    expect(enterMode(false, 0)).toBe('quiet');
    expect(enterMode(false, ENTER_PATIENCE_MS - 1)).toBe('quiet');
    expect(enterMode(false, ENTER_PATIENCE_MS)).toBe('lit');
    expect(enterMode(false, ENTER_PATIENCE_MS * 100)).toBe('lit');
  });

  it('has no mode in which the player cannot enter', () => {
    // `reveal` enters by itself; the other two are a button. Nothing else.
    const modes = new Set([enterMode(true, 0), enterMode(false, 0), enterMode(false, ENTER_PATIENCE_MS)]);
    expect([...modes].sort()).toEqual(['lit', 'quiet', 'reveal']);
  });

  it('says in each mode what entering now means', () => {
    expect(enterNote('quiet', ROOM)).toContain('You can enter at any time');
    expect(enterNote('lit', ROOM)).toContain('Nobody has answered yet');
    expect(enterNote('lit', ROOM)).toContain('fills in by itself');
    expect(enterNote('reveal', ROOM)).toBe('SSF-WELCOME is here.');
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

describe('stepGlyph', () => {
  it('has a mark of its own for each state', () => {
    const glyphs = (['done', 'busy', 'wait', 'off'] as const).map(stepGlyph);
    expect(new Set(glyphs).size).toBe(4);
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

  it('NEW PLAYER holds only for the welcome room, and never once the room is here', () => {
    const handler = between('btnNew.addEventListener("click"', 'btnEnter.addEventListener("click"');
    expect(handler).toContain('if (!waitsForWelcome() || welcomeReachedThisPage) {');
    // ENTER is shown in the same step that hides the two choices.
    expect(handler).toContain('btnEnter.style.display = "";');
  });

  it('a title that was left stops hearing of the search', () => {
    const proceed = between('const proceed = () => {', 'maybeFade();');
    expect(proceed).toContain('firstRunRepaint = null;');
    expect(proceed).toContain('window.clearInterval(holdTimer)');
  });

  it('only the welcome room\'s dial reports are counted', () => {
    const counted = between('if (env.room === DEFAULT_STATION.welcomeRoomId) {\n            noteDial(', '}');
    expect(counted).toContain('firstRunDial');
  });

  it('the first dial is counted from the session\'s record, never this computer\'s own node', () => {
    const seeded = between('const own = localFingerprint?.iroh_node_id;\n    const record = withHeldWelcomeRoutes(', 'firstRunRepaint?.();');
    expect(seeded).toContain('hint.irohNodeId !== own');
    expect(seeded).toContain('noteDial(firstRunDial, hint.irohNodeId, "dialing");');
  });

  it('the title is told of the node, of a silent node, and of the arrival', () => {
    const told = between('if (!listMeStands(listMeArmed, fingerprint)) listMeArmed = null;', 'localNodeOrigin = nodeOrigin;');
    expect(told).toContain('firstRunNodeSilent = false;');
    expect(told).toContain('firstRunRepaint?.();');
    expect(between('No running Rust node found', 'updateHUDNode')).toContain('firstRunNodeSilent = true;');
    expect(between('welcomeReachedThisPage = true;\n', 'clearWelcomePending(welcomeStore());')).toContain('firstRunRepaint?.();');
  });
});
