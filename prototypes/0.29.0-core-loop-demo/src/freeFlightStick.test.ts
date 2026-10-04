/**
 * 🕹️ freeFlightStick — the flight keys and a gamepad or joystick (issue 203).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStick, releaseStickKeys, stickKeysTaken, stickPadName, takeStickKeys } from './freeFlightStick';

type Listener = (e: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
let pads: Array<Partial<Gamepad> | null> = [];

beforeEach(() => {
  listeners.clear();
  pads = [];
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => { listeners.get(type)?.delete(fn); },
  });
  vi.stubGlobal('navigator', { getGamepads: () => pads });
});

afterEach(() => {
  releaseStickKeys();
  vi.unstubAllGlobals();
});

/** A key event as the window's listeners see it; says whether it was swallowed. */
function key(type: 'keydown' | 'keyup', code: string, target: unknown = null): boolean {
  let swallowed = false;
  const e = { code, target, preventDefault: () => { swallowed = true; }, stopImmediatePropagation: () => {} };
  for (const fn of listeners.get(type) ?? []) fn(e);
  return swallowed;
}

function gamepad(axes: number[], brake = false): Partial<Gamepad> {
  return { id: 'Test Stick', connected: true, axes, buttons: [{ pressed: brake, touched: brake, value: brake ? 1 : 0 }] as unknown as GamepadButton[] };
}

describe('the flight keys', () => {
  it('belong to the stick only while it is taken, and are swallowed then', () => {
    expect(key('keydown', 'KeyW')).toBe(false);
    expect(readStick().thrust).toBe(0);
    takeStickKeys();
    expect(stickKeysTaken()).toBe(true);
    expect(key('keydown', 'KeyW')).toBe(true);
    expect(key('keydown', 'KeyA')).toBe(true);
    expect(key('keydown', 'KeyE')).toBe(true);
    expect(readStick()).toEqual({ thrust: 1, yaw: -1, strafe: 1, brake: false });
    // Not a flight key: passes through.
    expect(key('keydown', 'KeyF')).toBe(false);
    key('keyup', 'KeyW');
    expect(readStick().thrust).toBe(0);
    expect(key('keydown', 'Space')).toBe(true);
    expect(readStick().brake).toBe(true);
    releaseStickKeys();
    expect(stickKeysTaken()).toBe(false);
    expect(listeners.get('keydown')?.size ?? 0).toBe(0);
    expect(readStick()).toEqual({ thrust: 0, yaw: 0, strafe: 0, brake: false });
  });

  it('leave a text field alone, and are all let go when the window loses focus', () => {
    takeStickKeys();
    expect(key('keydown', 'KeyW', { tagName: 'INPUT' })).toBe(false);
    expect(readStick().thrust).toBe(0);
    key('keydown', 'ArrowUp');
    key('keydown', 'ArrowRight');
    expect(readStick()).toMatchObject({ thrust: 1, yaw: 1 });
    for (const fn of listeners.get('blur') ?? []) fn({});
    expect(readStick()).toMatchObject({ thrust: 0, yaw: 0 });
  });
});

describe('a gamepad or joystick', () => {
  it('turns on X, thrusts on Y pushed forward, slides on the second X, and brakes on the first button', () => {
    expect(stickPadName()).toBeNull();
    pads = [null, gamepad([1, -1, -1], true)];
    expect(stickPadName()).toBe('Test Stick');
    expect(readStick()).toEqual({ thrust: 1, yaw: 1, strafe: -1, brake: true });
  });

  it('reads a centred stick inside the deadzone as still, and still reaches full deflection past it', () => {
    pads = [gamepad([0.1, -0.14, 0.05])];
    expect(readStick()).toEqual({ thrust: 0, yaw: 0, strafe: 0, brake: false });
    pads = [gamepad([0.575, 0, 0])];
    expect(readStick().yaw).toBeCloseTo(0.5, 9);
  });

  it('adds to the keys, clamped to full deflection', () => {
    takeStickKeys();
    key('keydown', 'KeyD');
    pads = [gamepad([1, 0, 0])];
    expect(readStick().yaw).toBe(1);
    pads = [gamepad([-1, 0, 0])];
    expect(readStick().yaw).toBe(0);
  });

  it('is skipped when disconnected, or when the browser has no Gamepad API', () => {
    pads = [{ ...gamepad([1, 1, 1], true), connected: false }];
    expect(readStick()).toEqual({ thrust: 0, yaw: 0, strafe: 0, brake: false });
    vi.stubGlobal('navigator', {});
    expect(stickPadName()).toBeNull();
    vi.stubGlobal('navigator', { getGamepads: () => { throw new Error('blocked'); } });
    expect(readStick().brake).toBe(false);
  });
});
