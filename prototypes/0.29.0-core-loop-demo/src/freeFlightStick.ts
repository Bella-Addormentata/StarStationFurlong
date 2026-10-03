/**
 * 🕹️ The flight stick (issue 203): keyboard and joystick input for a person
 * flying the ship by hand from the helm.
 *
 * While the stick is taken, the flight keys belong to it: a capture-phase
 * listener swallows their keydowns before the avatar's WASD (input.ts), the
 * camera rig's keys or the device focus see them, so flying never walks the
 * pilot away from the helm. Key-ups pass through, so nothing else is left
 * holding a key down. Esc still steps back from the helm as usual.
 *
 *   W / ↑  thrust forward        S / ↓  thrust back
 *   A / ←  turn left             D / →  turn right
 *   Q      slide left            E      slide right
 *   X / Space  brake (kill the ship's speed)
 *
 * A gamepad or joystick (the browser Gamepad API) adds to the keys: stick X
 * turns, stick Y thrusts (push forward to go forward), a second stick's X
 * (axis 2) slides, and the first button brakes.
 */

import type { StickInput } from './freeFlight';

const BINDINGS: Array<[string[], string]> = [
  [['KeyW', 'ArrowUp'], 'thrust+'],
  [['KeyS', 'ArrowDown'], 'thrust-'],
  [['KeyA', 'ArrowLeft'], 'yaw-'],
  [['KeyD', 'ArrowRight'], 'yaw+'],
  [['KeyQ'], 'strafe-'],
  [['KeyE'], 'strafe+'],
  [['KeyX', 'Space'], 'brake'],
];
const ACTION_OF = new Map<string, string>();
for (const [codes, action] of BINDINGS) for (const code of codes) ACTION_OF.set(code, action);

/** A stick axis this close to centre reads as centred. */
const DEADZONE = 0.15;

let taken = false;
const held = new Set<string>();

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true);
}

function onKeyDown(e: KeyboardEvent): void {
  if (!taken || isTyping(e.target)) return;
  const action = ACTION_OF.get(e.code);
  if (!action) return;
  held.add(e.code);
  e.preventDefault();
  e.stopImmediatePropagation();
}

function onKeyUp(e: KeyboardEvent): void {
  held.delete(e.code);
}

function onBlur(): void {
  held.clear();
}

/** Take the stick: the flight keys are the pilot's until releaseStickKeys. */
export function takeStickKeys(): void {
  if (taken) return;
  taken = true;
  held.clear();
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
}

export function releaseStickKeys(): void {
  if (!taken) return;
  taken = false;
  held.clear();
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onBlur);
}

export function stickKeysTaken(): boolean {
  return taken;
}

function axis(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) < DEADZONE) return 0;
  // Rescale past the deadzone so a stick still reaches full deflection.
  return Math.sign(v) * Math.min(1, (Math.abs(v) - DEADZONE) / (1 - DEADZONE));
}

/** The first connected gamepad or joystick, or null. */
function pad(): Gamepad | null {
  try {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads ?? []) if (p && p.connected) return p;
  } catch {
    /* no Gamepad API here */
  }
  return null;
}

/** Is a gamepad or joystick connected (the helm names it)? */
export function stickPadName(): string | null {
  const p = pad();
  return p ? p.id : null;
}

/** What the keys and the joystick ask for right now. */
export function readStick(): StickInput {
  const on = (action: string) => {
    for (const code of held) if (ACTION_OF.get(code) === action) return true;
    return false;
  };
  let thrust = (on('thrust+') ? 1 : 0) - (on('thrust-') ? 1 : 0);
  let yaw = (on('yaw+') ? 1 : 0) - (on('yaw-') ? 1 : 0);
  let strafe = (on('strafe+') ? 1 : 0) - (on('strafe-') ? 1 : 0);
  let brake = on('brake');
  const p = pad();
  if (p) {
    yaw += axis(p.axes[0]);
    thrust -= axis(p.axes[1]);
    strafe += axis(p.axes[2]);
    if (p.buttons[0]?.pressed) brake = true;
  }
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return { thrust: clamp(thrust), strafe: clamp(strafe), yaw: clamp(yaw), brake };
}
