/**
 * 🦊 The fox chooser: the first-run title's step after NEW PLAYER (part 3 of
 * the avatar step; part 1 is peerLooks.ts, part 2 foxLook.ts).
 *
 * A new player picks their fox while the game looks for the welcome room
 * behind the title: fur, markings, eyes, eye colour, ears and size, with a
 * preview of the fox turning gently and a RANDOM button. The search's lines
 * stay under it (firstRunSteps.ts), and ENTER lights when the room answers
 * instead of pulling the player in mid-choice (main.ts).
 *
 * The rows are pure data (`CHOICE_ROWS`) over foxLook.ts's lists; the DOM
 * and the preview are built by `mountFoxChooser`, which keeps the chosen
 * look and hands it back. Nothing is saved here: main.ts saves and applies
 * the look when the player enters.
 *
 * A keyboard moves as through any set of radio buttons: each row is one tab
 * stop (its chosen option), the arrow keys choose within a row, and Tab goes
 * row to row, on to RANDOM and to ENTER (main.ts, `nextTabStop`), since the
 * game's own Tab is the phone's toggle.
 */

import * as THREE from 'three';
import { VoxelCharacter } from './voxelCharacter';
import {
  CREAM_COLOURS,
  EAR_STYLES,
  EYE_COLOURS,
  EYE_SHAPES,
  FUR_COLOURS,
  SIZES,
  cleanLook,
  lookParts,
  randomLook,
  type FoxLook,
} from './foxLook';

/** One choice in a row: its name, and a colour for a swatch row. */
export interface ChoiceOption {
  name: string;
  swatch?: string;
}

/** One row of the chooser: the look's key it sets, and its options in the
 *  order of foxLook.ts's list, so an option's place is the look's index. */
export interface ChoiceRow {
  key: keyof FoxLook;
  label: string;
  options: readonly ChoiceOption[];
}

/** A 0xRRGGBB colour as CSS. */
export function cssHex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

export const CHOICE_ROWS: readonly ChoiceRow[] = [
  { key: 'fur', label: 'FUR', options: FUR_COLOURS.map((c) => ({ name: c.name, swatch: cssHex(c.fur) })) },
  { key: 'cream', label: 'MARKINGS', options: CREAM_COLOURS.map((c) => ({ name: c.name, swatch: cssHex(c.cream) })) },
  { key: 'eyes', label: 'EYES', options: EYE_SHAPES.map((s) => ({ name: s.name })) },
  { key: 'eyeColour', label: 'EYE COLOUR', options: EYE_COLOURS.map((c) => ({ name: c.name, swatch: c.eye })) },
  { key: 'ears', label: 'EARS', options: EAR_STYLES.map((s) => ({ name: s.name })) },
  { key: 'size', label: 'SIZE', options: SIZES.map((s) => ({ name: s.name })) },
];

/** The look with one choice changed, cleaned like any other look. */
export function withChoice(look: FoxLook, key: keyof FoxLook, index: number): FoxLook {
  return cleanLook({ ...look, [key]: index });
}

/** The look a new player starts from: the one saved on this computer if
 *  any, else one drawn at random, so two players who enter at once don't
 *  look alike. */
export function startingLook(saved: FoxLook | null, rand: () => number = Math.random): FoxLook {
  return saved ? cleanLook(saved) : randomLook(rand);
}

/** The option an arrow key (or Home / End) chooses in a row of `count`,
 *  from the option at `at`; null for any other key. Round at either end. */
export function arrowChoice(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (at + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** The tab stop Tab (or Shift+Tab, `back`) moves to among `count` stops,
 *  from the one at `at` (-1 when the focus is on none of them). Round at
 *  either end, so the title keeps the focus. */
export function nextTabStop(count: number, at: number, back: boolean): number {
  if (count <= 0) return -1;
  if (at < 0 || at >= count) return back ? count - 1 : 0;
  return (at + (back ? count - 1 : 1)) % count;
}

/** What `focusInView` needs of an element: a focus and a place on screen. */
export interface Focusable {
  focus(options?: FocusOptions): void;
  getBoundingClientRect(): { top: number; bottom: number };
  closest(selector: string): Scrollable | null;
}
/** …and of the box it scrolls in. */
export interface Scrollable {
  getBoundingClientRect(): { top: number; bottom: number };
  scrollTop: number;
}

/** Room kept above or below an element brought into view (pixels). */
const IN_VIEW_MARGIN = 8;

/**
 * Focus `el` and bring it into view in the title's own scrolling box
 * (#welcome-content, which scrolls on a short or zoomed window), and only
 * there: a plain focus would also scroll the page behind the title, whose
 * overflow is hidden but still scrolls for a focus.
 */
export function focusInView(el: Focusable): void {
  el.focus({ preventScroll: true });
  const box = el.closest('#welcome-content');
  if (!box) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.top < b.top + IN_VIEW_MARGIN) box.scrollTop -= b.top + IN_VIEW_MARGIN - r.top;
  else if (r.bottom > b.bottom - IN_VIEW_MARGIN) box.scrollTop += r.bottom - (b.bottom - IN_VIEW_MARGIN);
}

export interface FoxChooser {
  /** The chooser's element, to put on the title. */
  element: HTMLElement;
  /** The look as chosen so far. */
  look(): FoxLook;
  /** Focus the selected choice of the first row (for a keyboard). */
  focus(): void;
  /** The chooser's tab stops in order: each row's chosen option, then
   *  RANDOM. */
  tabStops(): HTMLElement[];
  /** Stop the preview and free its drawing context. */
  dispose(): void;
}

const GOLD = '#f0b429';
const LABEL_COLOUR = 'rgba(220,175,90,0.85)';

/** Build the chooser: the preview, the six rows and RANDOM. */
export function mountFoxChooser(initial: FoxLook): FoxChooser {
  let look = cleanLook(initial);
  const root = document.createElement('div');
  root.id = 'fox-chooser';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Your fox');
  root.style.cssText =
    'display:flex; flex-wrap:wrap; gap:14px 18px; justify-content:center; align-items:center; ' +
    'max-width:min(720px, 94vw); margin:4px auto 2px;';

  // ── The preview: the game's own fox, turning gently ─────────────────────
  const W = 200;
  const H = 230;
  const preview = document.createElement('div');
  preview.style.cssText = `width:${W}px; height:${H}px; flex:0 0 auto; border-radius:14px; ` +
    'background:radial-gradient(ellipse at 50% 70%, rgba(240,180,41,0.16), rgba(10,14,24,0.0) 70%);';
  let renderer: THREE.WebGLRenderer | null = null;
  let rig: VoxelCharacter | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    preview.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    // The character viewer's three-point light (charview.ts).
    scene.add(new THREE.HemisphereLight(0xffffff, 0x39445a, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(3.5, 6.0, 4.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fb4d8, 0.45);
    fill.position.set(-4.0, 2.5, -1.0);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.15);
    rim.position.set(-2.5, 4.0, -4.5);
    scene.add(rim);
    rig = new VoxelCharacter(scene);
    rig.setState('idle', 0);
    rig.setLook(lookParts(look));
    const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 50);
    camera.position.set(0, 2.1, 7.6);
    camera.lookAt(0, 1.6, 0);
    const clock = new THREE.Clock();
    const r = rig;
    const gl = renderer;
    renderer.setAnimationLoop(() => {
      r.update();
      // A slow sway between three-quarter views, so ears and tail show. After
      // the rig's update, which sets this rotation from its own heading.
      r.masterGroup.rotation.y = Math.sin(clock.getElapsedTime() * 0.6) * 0.55;
      gl.render(scene, camera);
    });
  } catch {
    // No WebGL for a second context: the rows still choose, unseen.
    renderer = null;
    rig = null;
    preview.style.display = 'none';
  }
  root.appendChild(preview);

  // ── The rows ─────────────────────────────────────────────────────────────
  const rows = document.createElement('div');
  rows.style.cssText = 'display:flex; flex-direction:column; gap:7px; flex:1 1 300px; max-width:470px; text-align:left;';
  const buttons = new Map<keyof FoxLook, HTMLButtonElement[]>();
  const paint = () => {
    for (const [key, list] of buttons) {
      list.forEach((b, i) => {
        const on = look[key] === i;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        // One tab stop per row: its chosen option (the arrow keys do the rest).
        b.tabIndex = on ? 0 : -1;
        if (b.dataset.swatch) {
          b.style.boxShadow = on ? `0 0 0 2px #1a1206, 0 0 0 4px ${GOLD}` : '0 0 0 1px rgba(255,255,255,0.25)';
        } else {
          b.style.background = on ? `linear-gradient(180deg,#ffd879,${GOLD})` : 'rgba(20,14,6,0.55)';
          b.style.color = on ? '#1a1206' : '#f0d090';
        }
      });
    }
    rig?.setLook(lookParts(look));
  };
  for (const row of CHOICE_ROWS) {
    const line = document.createElement('div');
    line.dataset.row = row.key;
    line.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';
    const label = document.createElement('div');
    label.textContent = row.label;
    label.id = `fox-chooser-${row.key}`;
    label.style.cssText = `flex:0 0 84px; font-family:inherit; font-size:10px; font-weight:600; line-height:1.2; letter-spacing:1.5px; color:${LABEL_COLOUR};`;
    const choices = document.createElement('div');
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-labelledby', label.id);
    choices.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; flex:1 1 200px;';
    const list: HTMLButtonElement[] = [];
    row.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.title = opt.name;
      b.setAttribute('aria-label', `${row.label.toLowerCase()}: ${opt.name}`);
      if (opt.swatch) {
        b.dataset.swatch = opt.swatch;
        b.style.cssText = `width:22px; height:22px; padding:0; border-radius:50%; border:none; cursor:pointer; background:${opt.swatch};`;
      } else {
        b.textContent = opt.name;
        b.style.cssText =
          'padding:4px 9px; font-family:inherit; font-size:11px; font-weight:600; line-height:1.2; letter-spacing:0.5px; border-radius:8px; ' +
          'border:1px solid rgba(240,180,41,0.4); cursor:pointer;';
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        look = withChoice(look, row.key, i);
        paint();
      });
      list.push(b);
      choices.appendChild(b);
    });
    // The arrow keys choose within the row, as in any set of radio buttons.
    choices.addEventListener('keydown', (e) => {
      const to = arrowChoice(e.key, look[row.key], list.length);
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      look = withChoice(look, row.key, to);
      paint();
      focusInView(list[to]);
    });
    buttons.set(row.key, list);
    line.append(label, choices);
    rows.appendChild(line);
  }
  const random = document.createElement('button');
  random.type = 'button';
  random.id = 'fox-chooser-random';
  random.textContent = '🎲  RANDOM';
  random.style.cssText =
    'align-self:flex-start; margin-top:4px; padding:6px 16px; font-family:inherit; font-size:11px; font-weight:600; line-height:1; letter-spacing:1px; ' +
    'color:#f0d090; background:rgba(20,14,6,0.55); border:1px solid rgba(240,180,41,0.4); border-radius:10px; cursor:pointer;';
  random.addEventListener('click', (e) => {
    e.stopPropagation();
    look = randomLook();
    paint();
  });
  rows.appendChild(random);
  root.appendChild(rows);
  paint();

  return {
    element: root,
    look: () => ({ ...look }),
    focus: () => {
      const first = buttons.get(CHOICE_ROWS[0].key)?.[look[CHOICE_ROWS[0].key]];
      if (first) focusInView(first);
    },
    tabStops: () => [
      ...CHOICE_ROWS.map((row) => buttons.get(row.key)?.[look[row.key]]).filter((b): b is HTMLButtonElement => !!b),
      random,
    ],
    dispose: () => {
      if (renderer) {
        renderer.setAnimationLoop(null);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      }
      renderer = null;
      rig = null;
    },
  };
}
