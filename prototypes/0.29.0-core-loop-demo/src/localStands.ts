/**
 * 🎲🧍 Where this page's own table sessions stand: `table:player` → the
 * craps stand its mounted table session heartbeats (crapsCroupier
 * markLocalSeat, from casinoTableSession's seat beat), or null for a seat
 * that is no player stand. Page-local by construction: a seat record in the
 * doc (`seat:<t>:<pid>`) is anyone's to write, or left behind by a closed
 * tab, so a computed craps slip takes its stand from here only
 * (computedTable localStandOf). No imports, so the fold's side of the game
 * can read it without the table's layout code.
 */

const stands = new Map<string, number | null>();

/** Mark (or, with `on` false, clear) this page's seat at a table; `stand`
 *  is its player stand, null for a seat that is none. */
export function setLocalStand(tableId: string, playerId: string, on: boolean, stand: number | null = null): void {
  if (on) stands.set(`${tableId}:${playerId}`, stand);
  else stands.delete(`${tableId}:${playerId}`);
}

/** Whether this page is writing that seat now (its own focused table). */
export function hasLocalStand(tableId: string, playerId: string): boolean {
  return stands.has(`${tableId}:${playerId}`);
}

/** The player stand this page's mounted table session stands at, or
 *  undefined when it has none there. */
export function localStandOf(tableId: string, playerId: string): number | undefined {
  return stands.get(`${tableId}:${playerId}`) ?? undefined;
}
