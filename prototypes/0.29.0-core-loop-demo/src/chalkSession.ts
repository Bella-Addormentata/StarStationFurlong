/**
 * 🖍 Using the chalkboard (Dorkmo 2026-11-01): no menus. Once the player has
 * stepped up to the board (the focus camera), a transparent layer over the
 * view takes the pointer and aims it at the board, the chess table's idiom
 * (chessSession.ts):
 *
 *  - click the chalk or the eraser on the tray to pick it up (clicking the
 *    other one swaps them);
 *  - with a tool in hand, press and hold on the slate to write or wipe; the
 *    tool follows the pointer, and the line breaks where it leaves the slate;
 *  - click the tray to put the tool back down;
 *  - click off the board to step back (a tool in hand goes back on the
 *    tray first), as every focused device does; Esc and WASD too.
 *
 * Marks go through chalkDoc.ts's pen, which paints at once and shares them
 * through the room doc. What the player holds is theirs alone.
 */

import * as THREE from 'three';
import type { DeviceUI } from './devices';
import { deviceFocus } from './deviceFocus';
import { chalkPenClose, chalkPenDown, chalkPenMove, chalkPenUp } from './chalkDoc';
import type { ChalkboardHandle, ChalkPick } from './chalkboardBuild';
import type { ChalkTool } from './chalkRender';
import { showHint } from './hud';

export interface ChalkboardUIDeps {
  itemId: string;
  handle: ChalkboardHandle | null;
}

/** What a press does, from what the hand holds and what the pointer is on
 *  (pure: chalkSession.test.ts). */
export type ChalkPress =
  | { act: 'take'; tool: ChalkTool }
  | { act: 'put-down' }
  | { act: 'draw' }
  | { act: 'wait' }
  | { act: 'hint' }
  | { act: 'leave' };

export function pressAction(hand: ChalkTool | null, pick: ChalkPick | null): ChalkPress {
  if (!pick) return { act: 'leave' };
  switch (pick.what) {
    case 'chalk':
    case 'eraser':
      return hand === pick.what ? { act: 'put-down' } : { act: 'take', tool: pick.what };
    case 'tray':
      return hand ? { act: 'put-down' } : { act: 'wait' };
    case 'board':
      return hand ? { act: 'draw' } : { act: 'hint' };
    case 'frame':
      // Pressed on the frame: the line starts once the pointer is on the slate.
      return hand ? { act: 'draw' } : { act: 'wait' };
  }
}

export function createChalkboardUI(deps: ChalkboardUIDeps): DeviceUI {
  const { itemId, handle } = deps;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let capture: HTMLDivElement | null = null;
  let hand: ChalkTool | null = null;
  /** The pointer is held down for a line (the pointer id). */
  let drawing: number | null = null;
  /** A stroke is open on the slate (the pointer is on it while drawing). */
  let stroke = false;
  let hinted = false;

  /** Aim the ray from the live (focus) camera through a pointer. */
  const aim = (e: { clientX: number; clientY: number }): boolean => {
    const cam = deviceFocus.getCamera() ?? window.gameRenderer?.camera;
    if (!cam) return false;
    const el = window.gameRenderer?.renderer?.domElement;
    const rect = el?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    if (rect.width <= 0 || rect.height <= 0) return false;
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    return true;
  };

  const lift = (): void => {
    if (stroke) chalkPenUp(itemId);
    stroke = false;
  };

  const take = (tool: ChalkTool | null): void => {
    lift();
    if (hand !== tool) chalkPenClose(itemId);
    hand = tool;
    handle?.setHeld(tool);
  };

  /** Follow the pointer: the tool in hand, the line while held, the cursor. */
  const follow = (e: PointerEvent): void => {
    if (!handle || !capture) return;
    const points = drawing !== null && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const c of points.length > 0 ? points : [e]) {
      if (!aim(c)) continue;
      const at = handle.planePoint(ray);
      if (drawing !== null && hand) {
        if (at?.inside) {
          if (stroke) chalkPenMove(itemId, at.point);
          else {
            chalkPenDown(itemId, hand, at.point);
            stroke = true;
          }
        } else lift();
      }
    }
    if (!aim(e)) return;
    const at = handle.planePoint(ray);
    handle.setHand(hand ? at : null, stroke);
    if (hand) capture.style.cursor = at?.inside ? 'none' : 'default';
    else {
      const over = handle.pick(ray)?.what;
      capture.style.cursor = over === 'chalk' || over === 'eraser' ? 'grab' : 'default';
    }
  };

  const onDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0 || !handle || !capture || !aim(e)) return;
    const press = pressAction(hand, handle.pick(ray));
    switch (press.act) {
      case 'take':
        take(press.tool);
        break;
      case 'put-down':
        take(null);
        break;
      case 'draw':
        drawing = e.pointerId;
        capture.setPointerCapture?.(e.pointerId);
        follow(e);
        return;
      case 'hint':
        if (!hinted) showHint('Pick up the chalk or the eraser from the tray.', 2400);
        hinted = true;
        break;
      case 'wait':
        break;
      case 'leave':
        take(null);
        deviceFocus.release();
        return;
    }
    follow(e);
  };

  const onUp = (e: PointerEvent): void => {
    e.stopPropagation();
    if (drawing === null || e.pointerId !== drawing) return;
    drawing = null;
    lift();
    capture?.releasePointerCapture?.(e.pointerId);
    follow(e);
  };

  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    mount(host: HTMLElement): void {
      hand = null;
      drawing = null;
      stroke = false;
      hinted = false;
      handle?.setHeld(null);
      capture = document.createElement('div');
      capture.id = 'chalkboard-capture';
      capture.style.cssText = 'position:absolute; inset:0; pointer-events:auto; background:transparent; touch-action:none;';
      capture.addEventListener('pointerdown', onDown);
      capture.addEventListener('pointermove', follow);
      capture.addEventListener('pointerup', onUp);
      capture.addEventListener('pointercancel', onUp);
      capture.addEventListener('pointerleave', () => handle?.setHand(null, false));
      // The canvas's own click (release the focus) and menus stay out.
      capture.addEventListener('click', swallow);
      capture.addEventListener('contextmenu', swallow);
      host.append(capture);
    },

    unmount(): void {
      drawing = null;
      take(null);
      capture?.remove();
      capture = null;
    },

    update(): void {
      // The board's face and timers run from its own handle (World drives
      // it every frame, focused or not).
    },
  };
}
