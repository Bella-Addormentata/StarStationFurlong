import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CREAM_COLOURS, DEFAULT_LOOK, EAR_STYLES, EYE_COLOURS, EYE_SHAPES, FUR_COLOURS, SIZES, cleanLook, type FoxLook } from './foxLook';

// The chooser draws its preview with the game's rig, whose module paints a
// canvas as it loads: a canvas that draws nothing will do here.
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop: () => undefined }) }) }) });
vi.stubGlobal('window', { location: { search: '' } });
const { CHOICE_ROWS, arrowChoice, cssHex, focusInView, nextTabStop, startingLook, withChoice } = await import('./foxChooser');

describe('the chooser\'s rows', () => {
  it('set every choice of a look, each once', () => {
    expect(CHOICE_ROWS.map((r) => r.key).sort()).toEqual(Object.keys(DEFAULT_LOOK).sort());
  });

  it('offer each list of foxLook.ts in its own order, so an option\'s place is the look\'s index', () => {
    const lists: Record<keyof FoxLook, readonly { name: string }[]> = { fur: FUR_COLOURS, cream: CREAM_COLOURS, eyes: EYE_SHAPES, eyeColour: EYE_COLOURS, ears: EAR_STYLES, size: SIZES };
    for (const row of CHOICE_ROWS) {
      expect(row.options.map((o) => o.name), row.key).toEqual(lists[row.key].map((x) => x.name));
      expect(row.label.length, row.key).toBeGreaterThan(0);
    }
  });

  it('show each colour as the fox is drawn in it', () => {
    const row = (key: keyof FoxLook) => CHOICE_ROWS.find((r) => r.key === key)!;
    expect(row('fur').options.map((o) => o.swatch)).toEqual(FUR_COLOURS.map((c) => cssHex(c.fur)));
    expect(row('cream').options.map((o) => o.swatch)).toEqual(CREAM_COLOURS.map((c) => cssHex(c.cream)));
    expect(row('eyeColour').options.map((o) => o.swatch)).toEqual(EYE_COLOURS.map((c) => c.eye));
    for (const key of ['eyes', 'ears', 'size'] as const) expect(row(key).options.every((o) => o.swatch === undefined), key).toBe(true);
  });
});

describe('a choice', () => {
  it('changes that choice alone, and is cleaned like any look', () => {
    const look = { fur: 3, cream: 1, eyes: 2, eyeColour: 4, ears: 1, size: 0 };
    expect(withChoice(look, 'ears', 4)).toEqual({ ...look, ears: 4 });
    expect(withChoice(look, 'ears', EAR_STYLES.length)).toEqual({ ...look, ears: DEFAULT_LOOK.ears });
    expect(withChoice(look, 'size', -1)).toEqual({ ...look, size: DEFAULT_LOOK.size });
    expect(look.ears).toBe(1);
  });
});

describe('the look a new player starts from', () => {
  it('is the one saved on this computer, cleaned', () => {
    expect(startingLook({ fur: 5, cream: 2, eyes: 1, eyeColour: 0, ears: 3, size: 4 })).toEqual({ fur: 5, cream: 2, eyes: 1, eyeColour: 0, ears: 3, size: 4 });
    expect(startingLook({ ...DEFAULT_LOOK, fur: 99 })).toEqual(DEFAULT_LOOK);
  });

  it('is drawn at random when none is saved, and stays in range', () => {
    expect(startingLook(null, () => 0)).toEqual({ fur: 0, cream: 0, eyes: 0, eyeColour: 0, ears: 0, size: 0 });
    const look = startingLook(null, () => 0.999999);
    expect(cleanLook(look)).toEqual(look);
    expect(look.fur).toBe(FUR_COLOURS.length - 1);
  });
});

describe('a keyboard in the chooser', () => {
  it('chooses with the arrow keys within a row, round at either end', () => {
    expect(arrowChoice('ArrowRight', 0, 5)).toBe(1);
    expect(arrowChoice('ArrowDown', 4, 5)).toBe(0);
    expect(arrowChoice('ArrowLeft', 0, 5)).toBe(4);
    expect(arrowChoice('ArrowUp', 3, 5)).toBe(2);
    expect(arrowChoice('Home', 3, 5)).toBe(0);
    expect(arrowChoice('End', 1, 5)).toBe(4);
  });

  it('leaves every other key alone, Tab and Enter among them', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape']) expect(arrowChoice(key, 2, 5), key).toBeNull();
    expect(arrowChoice('ArrowRight', 0, 0)).toBeNull();
  });

  it('tabs round its stops both ways, and in from anywhere else', () => {
    expect(nextTabStop(8, 0, false)).toBe(1);
    expect(nextTabStop(8, 7, false)).toBe(0);
    expect(nextTabStop(8, 0, true)).toBe(7);
    expect(nextTabStop(8, 5, true)).toBe(4);
    expect(nextTabStop(8, -1, false)).toBe(0);
    expect(nextTabStop(8, -1, true)).toBe(7);
    expect(nextTabStop(0, -1, false)).toBe(-1);
  });
});

describe('a choice brought into view', () => {
  /** An element at `top`..`bottom` on screen, in a box at 100..300 scrolled
   *  `scrollTop`, or in no scrolling box. */
  const at = (top: number, bottom: number, inBox = true) => {
    const box = { getBoundingClientRect: () => ({ top: 100, bottom: 300 }), scrollTop: 50 };
    const focused: FocusOptions[] = [];
    const el = {
      focus: (o?: FocusOptions) => void focused.push(o ?? {}),
      getBoundingClientRect: () => ({ top, bottom }),
      closest: (sel: string) => (inBox && sel === '#welcome-content' ? box : null),
    };
    focusInView(el);
    return { box, focused };
  };

  it('is focused without scrolling the page behind the title', () => {
    expect(at(150, 170).focused).toEqual([{ preventScroll: true }]);
    expect(at(150, 170, false).focused).toEqual([{ preventScroll: true }]);
  });

  it('scrolls the title\'s box just enough to show it, with a little room, and not when it shows', () => {
    expect(at(150, 170).box.scrollTop).toBe(50);
    expect(at(320, 340).box.scrollTop).toBe(50 + 340 - 292);
    expect(at(60, 80).box.scrollTop).toBe(50 - (108 - 60));
  });
});

describe('cssHex', () => {
  it('writes a colour as six hex digits', () => {
    expect(cssHex(0x0a0b0c)).toBe('#0a0b0c');
    expect(cssHex(0xffffff)).toBe('#ffffff');
    expect(cssHex(0)).toBe('#000000');
  });
});

describe('the chooser on the title (main.ts)', () => {
  const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
  const chooser = readFileSync(fileURLToPath(new URL('./foxChooser.ts', import.meta.url)), 'utf8');
  const between = (from: string, to: string): string => {
    const a = main.indexOf(from);
    expect(a, `main.ts has "${from}"`).toBeGreaterThan(-1);
    const b = main.indexOf(to, a + from.length);
    expect(b, `main.ts has "${to}" after "${from}"`).toBeGreaterThan(a);
    return main.slice(a, b);
  };

  it('opens on NEW PLAYER, from the saved look or a random one, above ENTER', () => {
    const handler = between('btnNew.addEventListener("click"', 'btnEnter.addEventListener("click"');
    expect(handler).toContain('chooser = mountFoxChooser(startingLook(loadSavedLook()));');
    expect(handler).toContain('wrap.insertBefore(chooser.element, btnEnter);');
    expect(handler).toContain('btnEnter.style.display = "";');
  });

  it('gives the chosen look to our fox when the player enters, and frees the preview', () => {
    const proceed = between('const proceed = () => {', 'maybeFade();');
    expect(proceed).toContain('applyOwnLook(chooser.look());');
    expect(proceed).toContain('chooser.dispose();');
    const own = between('function applyOwnLook(raw: unknown): FoxLook {', '\n}\n');
    expect(own).toContain('saveLook(look);');
    expect(own).toContain('.character.setLook(lookParts(look));');
    expect(own).toContain('updateLocalPlayerEntry();');
  });

  it('never pulls the player in mid-choice: the search only lights ENTER', () => {
    const paint = between('const paintSteps = () => {', 'btnNew.addEventListener("click"');
    expect(paint).not.toContain('proceed()');
    expect(paint).toContain('lightEnter(mode, enterNote(mode, DEFAULT_STATION.name));');
  });

  it('puts the focus on the first row\'s chosen option', () => {
    const focus = chooser.slice(chooser.indexOf('focus: () => {'), chooser.indexOf('dispose: () => {'));
    expect(focus).toContain('const first = buttons.get(CHOICE_ROWS[0].key)?.[look[CHOICE_ROWS[0].key]];');
    expect(focus).toContain('if (first) focusInView(first);');
  });

  it('lets Tab go round the chooser and ENTER, not the phone, while it is open', () => {
    const tab = between('wrap.addEventListener("keydown"', '});');
    expect(tab).toContain('if (e.key !== "Tab" || !chooser) return;');
    expect(tab).toContain('e.stopPropagation();');
    expect(tab).toContain('const stops = [...chooser.tabStops(), btnEnter];');
    expect(tab).toContain('if (to) focusInView(to);');
    // The listener is on the title, so it runs before the window's Tab.
    expect(main.indexOf('wrap.addEventListener("keydown"')).toBeGreaterThan(main.indexOf('const wrap = document.createElement("div");'));
  });

  it('makes each row one tab stop, chosen with the arrow keys', () => {
    expect(chooser).toContain("choices.setAttribute('role', 'radiogroup');");
    expect(chooser).toContain("b.setAttribute('role', 'radio');");
    expect(chooser).toContain('b.tabIndex = on ? 0 : -1;');
    expect(chooser).toContain('const to = arrowChoice(e.key, look[row.key], list.length);');
    // Each focus is brought into the title's view: a short window scrolls it.
    expect(chooser).toContain('focusInView(list[to]);');
    expect(chooser).toContain('if (first) focusInView(first);');
    expect(chooser.slice(chooser.indexOf('export function mountFoxChooser'))).not.toContain('preventScroll');
  });

  it('sways the preview after the rig\'s update, which sets the same rotation', () => {
    const loop = chooser.slice(chooser.indexOf('renderer.setAnimationLoop(() => {'));
    expect(loop.indexOf('r.update();')).toBeGreaterThan(-1);
    expect(loop.indexOf('r.masterGroup.rotation.y =')).toBeGreaterThan(loop.indexOf('r.update();'));
    expect(loop.indexOf('gl.render(scene, camera);')).toBeGreaterThan(loop.indexOf('r.masterGroup.rotation.y ='));
  });

  it('frees its drawing context when it is done', () => {
    const dispose = chooser.slice(chooser.indexOf('dispose: () => {'));
    expect(dispose).toContain('renderer.setAnimationLoop(null);');
    expect(dispose).toContain('renderer.forceContextLoss();');
  });
});
