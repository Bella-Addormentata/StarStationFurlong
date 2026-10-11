/**
 * ⚙️ Settings gears for the games that have no table card of their own yet
 * (air hockey, Insatiable Alligators, the coin pusher), after #226's table
 * card and #241's slot-machine gears.
 *
 * The builders (furniture.ts) tag each gear mesh with
 * `userData.settingsGear = itemId`. A click on one opens that item's card:
 * the rules and who's playing for anyone ("THE OWNER SETS THIS … · ANYONE
 * CAN LOOK"), plus the owner's controls when the spec's isHouse() (World's
 * canEditRoom) says the viewer runs the room. One card is open at a time; ✕, Esc or the same gear closes
 * it. The card is page-level, so it opens the same from the room view and
 * from a focused game.
 */

import * as THREE from 'three';
import { deviceFocus } from './deviceFocus';
import { pickSettingsGear } from './gearCardParts';

const GOLD = '#D4A84B';
const GOLD_BRIGHT = '#F0C060';
const DIM = 'rgba(212,168,75,0.55)';

export interface GearCardSpec {
  /** The furniture item the card belongs to. */
  itemId: string;
  /** Heading after the ⚙️, e.g. "AIR HOCKEY TABLE". */
  title: string;
  /** What the owner runs, for the role line: "TABLE", "MACHINE". */
  noun: string;
  /** May the viewer edit the room (canEditRoom().ok)? */
  isHouse(): boolean;
  /** The card's rows below the role line. `house`: the viewer may edit the room. */
  body(house: boolean): string;
  /** A `data-act` button was pressed (never "close"). */
  onAct?(act: string, house: boolean): void;
  /** Repaint when the game's state changes; returns the unsubscribe. */
  subscribe?(repaint: () => void): () => void;
}

let open: {
  spec: GearCardSpec;
  card: HTMLDivElement;
  unsubscribe: (() => void) | null;
  onKey: (e: KeyboardEvent) => void;
} | null = null;

function render(): void {
  if (!open) return;
  const { spec, card } = open;
  const house = spec.isHouse();
  const act = (document.activeElement as HTMLElement | null)?.closest?.('[data-act]');
  const focusedAct = act && card.contains(act) ? (act as HTMLElement).dataset.act : null;
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:12px;font-weight:900;letter-spacing:1px;color:${GOLD_BRIGHT};">⚙️ ${spec.title}</span>
      <button data-act="close" aria-label="Close the card" style="background:none;border:none;color:${GOLD};font-size:16px;cursor:pointer;">✕</button>
    </div>
    <div style="font-size:9px;color:${DIM};letter-spacing:1px;">${
      house ? `YOU RUN THIS ${spec.noun}` : `THE OWNER SETS THIS ${spec.noun} · ANYONE CAN LOOK`
    }</div>
    ${spec.body(house)}`;
  if (focusedAct) card.querySelector<HTMLElement>(`[data-act="${focusedAct}"]`)?.focus();
}

/** Closes the other page-level card that opens in this corner (the arcade
 *  cabinet's, arcadeCard.ts), if one is set. */
let closeNeighbour: (() => void) | null = null;

/** Set what a gear card opening closes first, whichever path opened it (a
 *  room-view gear, or one inside a focused game): one card in the corner,
 *  and its Esc is the visible card's. */
export function setGearCardNeighbour(close: (() => void) | null): void {
  closeNeighbour = close;
}

/** Close the open card (only if it is `itemId`'s, when given). */
export function closeGearCard(itemId?: string): void {
  if (!open || (itemId !== undefined && open.spec.itemId !== itemId)) return;
  open.unsubscribe?.();
  window.removeEventListener('keydown', open.onKey, true);
  open.card.remove();
  open = null;
}

export function isGearCardOpen(itemId: string): boolean {
  return open?.spec.itemId === itemId;
}

/** Open `spec`'s card, or close it if it is already the one open. */
export function toggleGearCard(spec: GearCardSpec): void {
  const same = open?.spec.itemId === spec.itemId;
  closeGearCard();
  if (same) return;
  closeNeighbour?.();
  const card = document.createElement('div');
  card.id = 'settings-gear-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `${spec.title} card`);
  card.style.cssText = `
    position:fixed; top:76px; right:24px; width:340px; max-width:calc(100vw - 32px); max-height:80vh; overflow-y:auto;
    z-index:4600; background:rgba(4,8,22,0.94); border:1px solid rgba(212,168,75,0.3); border-radius:10px;
    box-shadow:0 10px 48px rgba(0,0,0,0.85); padding:14px; display:flex; flex-direction:column; gap:10px;
    font-family:'SF Mono','Monaco','Consolas',monospace; color:${GOLD}; pointer-events:auto; box-sizing:border-box;`;
  // z-index 4600: above the focused-device host (4500, whose games lay a
  // full-screen capture layer) and below the SpacePhone (5000).
  // The card owns its clicks: none reaches the canvas (a click-away release)
  // or a focused game's capture layer.
  for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup'] as const) {
    card.addEventListener(ev, (e) => e.stopPropagation());
  }
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') {
      closeGearCard();
      return;
    }
    spec.onAct?.(act, spec.isHouse());
    render();
  });
  // Esc closes the card first: a capture listener on window runs before the
  // window listeners that step back from a focused device, and stops them.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeGearCard();
  };
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(card);
  open = { spec, card, unsubscribe: null, onKey };
  open.unsubscribe = spec.subscribe?.(render) ?? null;
  render();
}

const ndc = new THREE.Vector2();
const ray = new THREE.Raycaster();

/** The item whose ⚙️ gear is under the pointer in the main view, or null. */
export function pickSettingsGearAt(e: MouseEvent): string | null {
  const renderer = window.gameRenderer;
  const cam = deviceFocus.getCamera() ?? renderer?.camera;
  if (!renderer || !cam) return null;
  const rect = renderer.renderer?.domElement?.getBoundingClientRect()
    ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  if (rect.width <= 0 || rect.height <= 0) return null;
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  return pickSettingsGear(renderer.scene, ray);
}
