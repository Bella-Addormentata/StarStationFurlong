/**
 * 📺 tvMenu — the set's own on-screen menu (#258, part 3): what the set
 * shows while it is stopped (its home screen) or paused, and what the
 * IR blaster's D-pad does there (tvUI): the arrows move the highlight, OK
 * picks the cell under it. While a programme plays there is no menu, and
 * the D-pad seeks, sets the volume and pauses.
 *
 * HOME: the source tiles (what the blaster's link box takes) and, beside
 * them, the room's library, newest first (RECENTLY ON). OK on a title
 * plays it again; OK on a tile readies the presser's blaster for it (its
 * link box, or the file chooser). PAUSED: PLAY, STOP, 10 s back and on,
 * FROM START and LOOP, over the still picture.
 *
 * ONE SCREEN FOR THE ROOM: the highlight is a room record (tvDoc `menu:`),
 * so every page draws the set as every other does, and anyone's blaster
 * moves it, as anyone's press goes through. The cells are worked out here
 * from the records and this build's lanes (sovereignty.ts); the record
 * names a cell, never a place, so a page whose build draws another shelf
 * still finds it, or highlights its own first cell.
 */

import { sourceKindAllowed } from './sovereignty';
import { readLibrary, readMenuAt, readTv, sourceId, tvSetMenuAt } from './tvDoc';

export type TvMenuDir = 'up' | 'down' | 'left' | 'right';

export interface TvMenuCell {
  /** `tile:<kind>`, `lib:<sourceId>`, or one of the paused menu's
   *  TvPausedCell ids. */
  id: string;
  label: string;
  col: number;
  row: number;
  /** false ⇒ drawn dimmed and never highlighted (a lane still to come). */
  live: boolean;
}

export interface TvMenuView {
  kind: 'home' | 'paused';
  cells: TvMenuCell[];
  /** The highlighted cell: always a live one. */
  at: string;
}

export type TvPausedCell = 'play' | 'stop' | 'back' | 'on' | 'start' | 'loop';

/** The home screen's source tiles, in the blaster's order (tvUI TILES): the
 *  source kind each stands for (sovereignty.ts decides which this build
 *  offers) and whether its lane exists yet (`live`; KARAOKE is plan §3.3's
 *  later tile, drawn dimmed — FILE arrived with the blob lane, blobLane.ts,
 *  and TORRENT with the torrent lane, torrentLane.ts). */
export const TV_HOME_TILES: ReadonlyArray<{ label: string; kind: string; live: boolean }> = [
  { label: '▶ YOUTUBE', kind: 'youtube', live: true },
  { label: 'ARCHIVE', kind: 'archive', live: true },
  { label: 'URL', kind: 'url', live: true },
  { label: 'FILE', kind: 'file', live: true },
  { label: 'TORRENT', kind: 'magnet', live: true },
  { label: 'KARAOKE', kind: 'karaoke', live: false },
];

/** How many library titles the home menu holds (the blaster's 📚 LIBRARY
 *  has the rest)… */
export const TV_MENU_LIBRARY = 12;
/** …and how many the set shows at once: the column turns a page as the
 *  highlight goes past its foot. */
export const TV_HOME_RECENT = 4;

/** The menu the set shows now, or null for none (off, a countdown, a
 *  programme playing). */
export function tvMenu(itemId: string): TvMenuView | null {
  const rec = readTv(itemId);
  let kind: TvMenuView['kind'];
  let cells: TvMenuCell[];
  if (rec.state === 'home') {
    kind = 'home';
    const tiles = TV_HOME_TILES.filter((t) => sourceKindAllowed(t.kind));
    const lib = readLibrary().slice(0, TV_MENU_LIBRARY);
    // With a library, the tiles take two columns and the titles the third.
    const cols = lib.length ? 2 : 3;
    cells = tiles.map((t, i) => ({ id: `tile:${t.kind}`, label: t.label, col: i % cols, row: Math.floor(i / cols), live: t.live }));
    lib.forEach((e, i) => cells.push({ id: `lib:${sourceId(e.source)}`, label: e.title, col: cols, row: i, live: true }));
  } else if (rec.state === 'paused' && rec.source) {
    kind = 'paused';
    const cell = (id: TvPausedCell, label: string, col: number, row: number): TvMenuCell => ({ id, label, col, row, live: true });
    cells = [
      cell('play', '▶ PLAY', 0, 0), cell('stop', '■ STOP', 1, 0),
      cell('back', '« 10 S', 0, 1), cell('on', '10 S »', 1, 1),
      cell('start', 'FROM START', 0, 2), cell('loop', rec.loop ? 'LOOP: ON' : 'LOOP: OFF', 1, 2),
    ];
  } else {
    return null;
  }
  const live = cells.filter((c) => c.live);
  if (!live.length) return null;
  // Home opens on the newest title (OK plays it again), paused on PLAY.
  const first = (kind === 'home' ? live.find((c) => c.id.startsWith('lib:')) : undefined) ?? live[0]!;
  const want = readMenuAt(itemId);
  return { kind, cells, at: live.some((c) => c.id === want) ? want : first.id };
}

/** The highlighted cell. */
export function tvMenuCellAt(menu: TvMenuView): TvMenuCell {
  return menu.cells.find((c) => c.id === menu.at)!;
}

/** Where an arrow takes the highlight: ▲ ▼ the nearest live cell above or
 *  below in its column; ◀ ▶ the nearest column that way with a live cell,
 *  at the row nearest its own (the higher on a tie). Null: nowhere. */
export function tvMenuStep(menu: TvMenuView, dir: TvMenuDir): string | null {
  const here = tvMenuCellAt(menu);
  const across = dir === 'left' || dir === 'right';
  const sign = dir === 'up' || dir === 'left' ? -1 : 1;
  let best: TvMenuCell | null = null;
  for (const c of menu.cells) {
    if (!c.live || c === here) continue;
    if (across ? Math.sign(c.col - here.col) !== sign : c.col !== here.col || Math.sign(c.row - here.row) !== sign) continue;
    if (!best) {
      best = c;
      continue;
    }
    const dc = Math.abs(c.col - here.col) - Math.abs(best.col - here.col);
    const dr = Math.abs(c.row - here.row) - Math.abs(best.row - here.row);
    if (dc < 0 || (dc === 0 && (dr < 0 || (dr === 0 && c.row < best.row)))) best = c;
  }
  return best?.id ?? null;
}

/** An arrow on the blaster, with the set's menu up: the highlight moves
 *  for the whole room. False: no menu, or nowhere that way. */
export function tvMenuMove(itemId: string, dir: TvMenuDir): boolean {
  const menu = tvMenu(itemId);
  const to = menu ? tvMenuStep(menu, dir) : null;
  return to !== null && tvSetMenuAt(itemId, to).ok;
}

/** The library titles the home screen shows now: the page of
 *  TV_HOME_RECENT the highlight is on (the first while it is on a tile),
 *  and whether there are more above or below it. */
export function tvHomeShelf(menu: TvMenuView): { cells: TvMenuCell[]; above: boolean; below: boolean } {
  const lib = menu.cells.filter((c) => c.id.startsWith('lib:'));
  const at = lib.findIndex((c) => c.id === menu.at);
  const from = at < 0 ? 0 : Math.floor(at / TV_HOME_RECENT) * TV_HOME_RECENT;
  return { cells: lib.slice(from, from + TV_HOME_RECENT), above: from > 0, below: from + TV_HOME_RECENT < lib.length };
}
