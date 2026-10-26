/**
 * 🧭 First-person turning from the keyboard: Q turns the view left and E
 * turns it right, for as long as the key is held, alongside the mouse-look
 * (zoom.ts, level 1). Matched by e.code, so the keys sit in the same place
 * on any layout, like the helm's flight keys (freeFlightStick.ts).
 *
 * In the isometric room view the same keys turn the standing avatar in
 * place instead, one 45° facing per press (Player.turnInPlace).
 *
 * At a helm the stick takes Q and E for strafing before they reach the
 * window, so the view does not turn while flying.
 */

/** Radians per second while Q or E is held (about 115° a second). */
export const TURN_SPEED = 2;

const TURN_OF: Record<string, 1 | -1> = {
  KeyQ: 1, // left: the mouse-look yaw grows as the view swings left
  KeyE: -1, // right
};

export function isTurnKey(code: string): boolean {
  return code in TURN_OF;
}

/** Which way a turn key turns: 1 left, -1 right, 0 for any other key. */
export function turnKeyDirection(code: string): 1 | -1 | 0 {
  return TURN_OF[code] ?? 0;
}

/** The yaw change for `dt` seconds with `held` key codes down. Q and E
 *  together cancel out. */
export function turnYawStep(held: ReadonlySet<string>, dt: number): number {
  if (!(dt > 0)) return 0;
  let dir = 0;
  for (const code of held) dir += TURN_OF[code] ?? 0;
  return dir * TURN_SPEED * dt;
}
