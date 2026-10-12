/**
 * 🕹 arcadeUI — the panel at the cabinet (a DeviceUI, the TV panel's shell).
 * A cabinet plays ONE game, the owner's pick (arcadeDoc).
 *
 * Two views of one panel. PLAY, at the cabinet, for the owner's own game
 * (EmulatorJS): what is on it and PLAYER ONE (INSERT COIN · STAND UP · the
 * owner's EJECT) — or, at the double-wide cabinet, its four PLAYERS, each
 * playing on their own computer in step with the others (#242); the game
 * runs in the stage (arcadeStage.ts) that INSERT COIN opens. A built-in
 * game plays on the cabinet's screen instead (arcadeNesCabinet.ts), so
 * World opens that in place of PLAY.
 *
 * SETTINGS, from the ⚙️ low on the cabinet's front (or the ⚙️ at the
 * controls): the game on the cabinet, who is playing it at which stand, and
 * where EmulatorJS's files come from, readable by anyone, and changed there
 * by the owner alone, who can also RESET a stuck cabinet (the slot
 * machine's and the casino tables' ⚙️ card: THE OWNER SETS THIS · ANYONE
 * CAN LOOK). The owner picks one of two kinds of game: a FREE GAME the app
 * ships (the built-in emulator, on the cabinet's screen, for the room), or
 * THEIR OWN — a file from their disk (SOVEREIGN) or a link: one on this
 * station's node or this page's own origin (SOVEREIGN — all a
 * serverless-only build takes, the default: sovereignty.ts), or any server
 * a player's browser can reach (CONVENIENCE, with the lanes on) — and its
 * core, for EmulatorJS.
 *
 * Every state change goes through arcadeDoc; this module renders and asks.
 * Peer strings are escaped before they reach innerHTML (the #116 lesson).
 * The panel rebuilds only when something other than the clock changed, so a
 * tap never lands on a replaced button (the TV panel's rule).
 */

import type { DeviceUI } from './devices';
import {
  builtInEntry, builtInGame, cabinetKey, coreForName, coreLabel, gameLane, iAmP1, insertCoin, mayEjectP1, maySit,
  mySeat, parseRomUrl, putOnCabinet, readCabinet, readSeat, seatHolders, seatKey, seatLapsed,
  setEmulatorData, standUp, subscribeArcadeKey, takeOffCabinet, ARCADE_CORES, ARCADE_MAX_NAME,
  isArcadeCore,
} from './arcadeDoc';
import type { ArcadeCore, ArcadeGame } from './arcadeDoc';
import { ARCADE_GAMES as BUILT_IN_GAMES, LICENSE_LABEL } from './arcadeLibrary';
import { rememberLocalRom, romAcceptList, EMULATOR_FETCH_COMMAND } from './arcadeEmulator';
import { heldRom, holdRom, sha256Hex, ROM_SHARE_MAX_BYTES } from './arcadeRomShare';
import type { ArcadeMatch } from './games/arcade';
import { readArcade, readPlayerDisplayName, subscribeGames, writeArcade } from './games/gamesDoc';
import { getPlayerId } from './identity';
import { urlConsent, urlRefusal } from './tvConsent';
import { convenienceLanesEnabled, SERVERLESS_ONLY } from './sovereignty';
import { escapeHtml } from './htmlEscape';

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#4A5560';
const GREEN = '#2fe6a0';
const WARN = '#ff8a50';
const CYAN = '#00E5FF';
/** P1 to P4, the double-wide cabinet's panel colours (furniture.ts). */
const PLAYER_TONES = ['#ff3b3b', '#3b8bff', '#2fe6a0', '#ffd23b'];

const esc = escapeHtml;

export interface ArcadeDeviceDeps {
  itemId: string;
  myPub: () => string;
  myName: () => string;
  /** Room-owner gate — the game, the emulator files (curation).
   *  EJECT is the deed holder's and is asked of arcadeDoc (mayEjectP1), the
   *  predicate that gates the write. */
  canEdit: () => boolean;
  /** INSERT COIN taken with a game on: open the stage (the focus releases first). */
  openStage: () => void;
  /** Which view this panel shows (default 'play'). */
  view?: ArcadePanelView;
  /** Swap to the other view in place (the focus stays on the cabinet).
   *  openPlay also takes the PLAY view to the cabinet's screen when the
   *  owner puts a built-in game on (World picks the UI for the game). */
  openSettings?: () => void;
  openPlay?: () => void;
  /** The cabinet's stands: 2 for the two-player cabinet, 4 for the
   *  double-wide one, whose players play the owner's own game in step,
   *  each on their own computer (default 1). */
  seats?: 1 | 2 | 4;
  /** The stand stepped up to, of `seats`: the seat its INSERT COIN takes. */
  seat?: number;
}

export type ArcadePanelView = 'play' | 'settings';

const PANEL_CSS = `
  position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
  width: 340px; max-height: 90vh; overflow-y: auto;
  background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
  border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
  padding: 18px; display: flex; flex-direction: column; gap: 12px;
  color: ${GOLD}; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  box-sizing: border-box; pointer-events: auto;
`;

function bigButton(attr: string, label: string, tone: string, enabled = true): string {
  return `<button type="button" ${attr} ${enabled ? '' : 'disabled'} style="
    display:flex; justify-content:center; align-items:center;
    padding:10px 12px; width:100%;
    background:${enabled ? `rgba(${tone},0.14)` : 'rgba(212,168,75,0.05)'};
    border:1px solid ${enabled ? `rgba(${tone},0.75)` : 'rgba(212,168,75,0.2)'};
    border-radius:7px; color:${enabled ? GOLD_BRIGHT : DIM};
    font-family:inherit; font-size:12px; font-weight:800; letter-spacing:0.5px;
    cursor:${enabled ? 'pointer' : 'default'};
  ">${label}</button>`;
}

function smallButton(attr: string, label: string, enabled = true, active = false): string {
  return `<button type="button" ${attr} ${enabled ? '' : 'disabled'} style="
    padding:6px 9px; background:${active ? 'rgba(0,229,255,0.14)' : 'rgba(212,168,75,0.12)'};
    border:1px solid ${active ? CYAN : `rgba(212,168,75,${enabled ? 0.4 : 0.15})`};
    border-radius:6px; color:${enabled ? GOLD : DIM}; font-family:inherit; font-size:10px; font-weight:800;
    cursor:${enabled ? 'pointer' : 'default'}; white-space:nowrap;">${label}</button>`;
}

function laneBadge(lane: string): string {
  const tone = lane === 'SOVEREIGN' ? GREEN : lane === 'PLAYER-RUN' ? CYAN : WARN;
  return `<span style="font-size:8px; letter-spacing:1px; padding:1px 5px; border:1px solid ${tone}; color:${tone}; border-radius:3px; white-space:nowrap;">${esc(lane)}</span>`;
}

function section(label: string, body: string): string {
  return `<div style="border-top:1px solid rgba(212,168,75,0.12); padding-top:10px; display:flex; flex-direction:column; gap:8px;">
    <div style="font-size:9px; color:${DIM}; letter-spacing:1.5px;">${label}</div>
    ${body}
  </div>`;
}

const INPUT_CSS = `width:100%; box-sizing:border-box; background:rgba(0,0,0,0.35); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:${GOLD_BRIGHT}; font-family:inherit; font-size:10px; padding:6px 7px;`;

/** What the cabinet is doing, in one line (plain text, set with textContent). */
function statusText(itemId: string, seats = 1): string {
  const rec = readCabinet(itemId);
  const seat = readSeat(itemId);
  const held = seat.holder !== '' && !seatLapsed(itemId);
  if (!rec.game) return 'nothing on the cabinet';
  if (rec.game.bundled) return `${rec.game.name} · on the cabinet's screen`;
  if (seats === 4) {
    const playing = seatHolders(itemId, 4).filter((r) => r !== null).length;
    return playing > 0 ? `${rec.game.name} · ${playing} PLAYING` : `${rec.game.name} · INSERT COIN`;
  }
  return held ? `${rec.game.name} · P1 · ${seat.name || 'a clone'}` : `${rec.game.name} · INSERT COIN`;
}

function refreshStatus(root: HTMLElement, itemId: string, seats = 1): void {
  const el = root.querySelector<HTMLElement>('[data-arcade-status]');
  if (!el) return;
  const text = statusText(itemId, seats);
  if (el.textContent !== text) el.textContent = text;
}

function showNote(panel: HTMLElement, text: string): void {
  let note = panel.querySelector<HTMLDivElement>('.arcade-note');
  if (!note) {
    note = document.createElement('div');
    note.className = 'arcade-note';
    note.style.cssText = `font-size:10px; color:${WARN}; line-height:1.4;`;
    panel.appendChild(note);
  }
  note.textContent = text;
}

// ── The owner's YOUR OWN GAME draft, kept across repaints ────────────────────
// (A File cannot be put back into an <input>, so the panel shows the name.)

let draftFile: File | null = null;
let draftUrl = '';
let draftCore: ArcadeCore | '' = '';

function draftGame(): { game: ArcadeGame; file: File | null } | { error: string } {
  if (draftFile) {
    const core = draftCore || coreForName(draftFile.name);
    if (!core) return { error: 'Pick a core for this file.' };
    return { game: { name: draftFile.name.slice(0, ARCADE_MAX_NAME), core, url: '', size: draftFile.size }, file: draftFile };
  }
  const parsed = parseRomUrl(draftUrl);
  if (!parsed) return { error: draftUrl.trim() ? 'That is not a link the cabinet can fetch.' : 'Pick a file, or paste a link.' };
  // A link no player's browser would fetch does not go on: another server,
  // in a serverless-only build (tvConsent's rule, the TV's). A private
  // host is each viewer's own call at the stage — the owner's node may be
  // another player's too.
  if (urlConsent(parsed.url) === 'refuse' && urlRefusal(parsed.url) === 'server-off') {
    return { error: `That link is on another server — ${SERVERLESS_ONLY}: a link on this station's node or this page's own origin goes on the cabinet.` };
  }
  const core = draftCore || parsed.core;
  if (!core) return { error: 'Pick a core for this link.' };
  return { game: { name: parsed.name, core, url: parsed.url, size: 0 }, file: null };
}

// ── Render ───────────────────────────────────────────────────────────────────

function gameRow(g: ArcadeGame): string {
  return `<span style="color:${GOLD_BRIGHT}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${esc(g.name)}</span>
    <span style="font-size:9px; color:${DIM}; white-space:nowrap;">${g.bundled ? 'NES · BUILT-IN' : esc(coreLabel(g.core))}</span>
    ${laneBadge(gameLane(g))}`;
}

/** Under a game: where it plays, and a built-in game's credits. */
function gameNote(g: ArcadeGame, seats = 1): string {
  const lib = builtInEntry(g);
  const where = lib
    ? 'Plays on the cabinet\'s screen with the built-in emulator; the room watches, and the two-player cabinet seats two.'
    : seats === 4
      ? 'Plays in the EmulatorJS window that INSERT COIN opens, for up to four players, each on their own computer.'
      : 'Plays in the EmulatorJS window that INSERT COIN opens, for player one.';
  const credits = lib
    ? `<br>${esc(lib.author)}, ${lib.year} · ${esc(LICENSE_LABEL[lib.license])} · <a href="${esc(lib.sourceUrl)}" target="_blank" rel="noopener noreferrer" style="color:${CYAN};">source</a>`
    : '';
  return `<div style="font-size:9px; color:${DIM}; line-height:1.4;">${where}${credits}</div>`;
}

function emulatorFilesText(lanesOn: boolean): string {
  return lanesOn
    ? `For your own games. This station's own copy (<span style="color:${GREEN};">${esc(EMULATOR_FETCH_COMMAND)}</span>, then rebuild) or the public CDN. Under the CDN the emulator's own code reads the game file, so each player is asked before it goes to it; THIS STATION's files keep it on their machine.`
    : `For your own games. This station's own copy (<span style="color:${GREEN};">${esc(EMULATOR_FETCH_COMMAND)}</span>, then rebuild) — ${esc(SERVERLESS_ONLY)}, so the public CDN is not offered, and the emulator runs under a policy that reaches this origin and the player's own node, nothing else.`;
}

/** Under the owner's own file: who sends it to the players. */
function fileNote(g: ArcadeGame, owner: boolean): string {
  if (g.url || g.bundled) return '';
  const mb = ROM_SHARE_MAX_BYTES / (1024 * 1024);
  if (!g.sha256 || g.size > ROM_SHARE_MAX_BYTES) {
    return `<div style="font-size:9px; color:${WARN}; line-height:1.4;">Not sent to players${g.size > ROM_SHARE_MAX_BYTES ? ` (over ${mb} MB)` : ''}: each brings their own copy.</div>`;
  }
  const here = heldRom(g.sha256)
    ? 'This page has it and sends it.'
    : owner ? 'This page no longer has it (reloaded?): pick it again below to send it, unless a player who has it is here.' : '';
  return `<div style="font-size:9px; color:${DIM}; line-height:1.4;">Sent to each player who presses play, through the room, from whoever has it here: the owner's computer, or a player who got it. ${here}</div>`;
}

/** Who holds player 1 and player 2 of a built-in game's match, in words
 *  (#246's card): YOU for this player, an open stand on the two-player
 *  cabinet, or a second gamepad on player one's computer on the other. */
export function matchPlayers(m: ArcadeMatch, seats: 1 | 2, me: string): Array<{ player: 1 | 2; who: string }> {
  const name = (id: string) => (id === me ? 'YOU' : readPlayerDisplayName(id).toUpperCase());
  const hostPlayer: 1 | 2 = m.hostSeat === 0 ? 1 : 2;
  const other: 1 | 2 = hostPlayer === 1 ? 2 : 1;
  const players = [{ player: hostPlayer, who: name(m.host) }];
  if (m.guest) players.push({ player: other, who: name(m.guest) });
  else if (seats === 2) players.push({ player: other, who: `OPEN · STEP UP TO THE ${other === 1 ? 'LEFT' : 'RIGHT'} STAND` });
  else players.push({ player: other, who: "A SECOND GAMEPAD ON PLAYER 1'S COMPUTER" });
  return players.sort((a, b) => a.player - b.player);
}

/** What RESET would end on the cabinet now: a built-in game's match (for
 *  everyone watching or playing), player one's seat at the owner's own game
 *  (when this page may free it: the deed holder's EJECT), or nothing. */
function resettable(itemId: string, seats = 1): 'match' | 'seat' | null {
  const game = readCabinet(itemId).game;
  if (game?.bundled) return readArcade(itemId) ? 'match' : null;
  if (seats === 4) {
    const anyone = seatHolders(itemId, 4).some((r) => r !== null);
    return anyone && (mySeat(itemId, 4) !== null || mayEjectP1()) ? 'seat' : null;
  }
  const seat = readSeat(itemId);
  const held = seat.holder !== '' && !seatLapsed(itemId);
  return held && (iAmP1(itemId) || mayEjectP1()) ? 'seat' : null;
}

/** SETTINGS' NOW PLAYING: who is at which stand, and the owner's RESET. */
function nowPlaying(itemId: string, deps: ArcadeDeviceDeps, owner: boolean): string {
  const game = readCabinet(itemId).game;
  const line = (text: string) => `<div style="font-size:10px; color:${GOLD_BRIGHT}; line-height:1.5;">${text}</div>`;
  let lines: string;
  if (game?.bundled) {
    const m = readArcade(itemId);
    lines = m
      // A built-in game seats two at the two-player cabinet; elsewhere its
      // second player is a second gamepad (the double-wide's stands are its
      // own game's four).
      ? matchPlayers(m, deps.seats === 2 ? 2 : 1, getPlayerId()).map((p) => line(`PLAYER ${p.player} · ${esc(p.who)}`)).join('')
      : line('Nobody · step up and press Enter to play.');
  } else if (game && deps.seats === 4) {
    const mine = mySeat(itemId, 4);
    lines = seatHolders(itemId, 4)
      .map((r, n) => (r ? line(`PLAYER ${n + 1} · ${n === mine ? 'YOU' : esc((r.name || 'a clone').toUpperCase())}`) : ''))
      .join('') || line('Nobody · step up and INSERT COIN to play.');
  } else if (game) {
    const seat = readSeat(itemId);
    const held = seat.holder !== '' && !seatLapsed(itemId);
    lines = held
      ? line(`PLAYER 1 · ${iAmP1(itemId) ? 'YOU' : esc((seat.name || 'a clone').toUpperCase())}`)
      : line('Nobody · step up and INSERT COIN to play.');
  } else {
    lines = line('Nothing is on the cabinet.');
  }
  const reset = owner
    ? `<div style="display:flex; gap:6px; align-items:center; justify-content:space-between;">
        <span style="font-size:9px; color:${DIM}; line-height:1.4;">RESET ends the game running here for everyone and frees the stands.</span>
        ${smallButton('data-arcade-reset="1"', '↺ RESET', resettable(itemId, deps.seats) !== null)}
      </div>`
    : '';
  return section('NOW PLAYING', `${lines}${reset}`);
}

/** The owner's RESET: end the match or free the players' seats (player
 *  one's, or the double-wide cabinet's four). The note (null: not the
 *  owner's press). Exported for its tests. */
export function resetArcadeCabinet(itemId: string, owner: boolean, seats = 1): string | null {
  if (!owner) return null;
  const what = resettable(itemId, seats);
  if (what === 'match') {
    writeArcade(itemId, null);
    return 'The game ended · the cabinet is free.';
  }
  if (what === 'seat' && seats === 4) {
    const held = seatHolders(itemId, 4).map((r, n) => (r ? n : -1)).filter((n) => n >= 0);
    const failed = held.map((n) => standUp(itemId, n)).find((r) => !r.ok);
    return failed && !failed.ok ? failed.error : 'The players stood up · the cabinet is free.';
  }
  if (what === 'seat') {
    const r = standUp(itemId);
    return r.ok ? 'Player one stood up · the cabinet is free.' : r.error;
  }
  return 'Nothing is running here.';
}

/** The double-wide cabinet's PLAYERS (#242): who is at each of the four
 *  seats, and this page's buttons — a coin for a free seat while it holds
 *  none (the stand it stepped up to the big one), its own seat's way back
 *  to the controls and STAND UP, the deed holder's EJECT. */
function playersSection(itemId: string, deps: ArcadeDeviceDeps, game: ArcadeGame | null): string {
  const holders = seatHolders(itemId, 4);
  const mine = mySeat(itemId, 4);
  const free = holders.map((r, n) => (r ? -1 : n)).filter((n) => n >= 0 && maySit(itemId, n));
  const rows = holders.map((rec, n) => {
    const who = n === mine ? 'YOU'
      : rec ? esc((rec.name || 'a clone').toUpperCase())
        : `<span style="color:${DIM};">free</span>`;
    const button = n === mine ? smallButton(`data-arcade-standup="${n}"`, '🪑 STAND UP')
      : !rec && mine === null && game && free.includes(n) ? smallButton(`data-arcade-coin="${n}"`, '🪙 INSERT COIN')
        : rec && mayEjectP1() ? smallButton(`data-arcade-eject="${n}"`, '⏏ EJECT')
          : '';
    return `<div style="display:flex; gap:8px; align-items:center; font-size:11px; color:${GOLD_BRIGHT};">
      <span style="color:${PLAYER_TONES[n]}; font-weight:800; min-width:22px;">P${n + 1}</span>
      <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${who}</span>${button}
    </div>`;
  }).join('');
  const pick = deps.seat !== undefined && free.includes(deps.seat) ? deps.seat : free[0];
  const big = mine !== null ? bigButton('data-arcade-stage="1"', '🕹 BACK TO THE CONTROLS', '47,230,160')
    : game && pick !== undefined ? bigButton(`data-arcade-coin="${pick}"`, `🪙 INSERT COIN · PLAY AS P${pick + 1}`, '212,168,75')
      : game ? `<div style="font-size:10px; color:${DIM};">All four seats are taken.</div>` : '';
  return section('PLAYERS · UP TO FOUR, EACH ON THEIR OWN COMPUTER', `${rows}${big}
    <div style="font-size:9px; color:${DIM}; line-height:1.4;">Everyone plays one game, in step: a player sitting down or standing up holds it for about a second.</div>`);
}

/** PLAY: at the cabinet — the owner's own game, and PLAYER ONE (or the
 *  double-wide cabinet's four players). */
function renderPlay(itemId: string, deps: ArcadeDeviceDeps): string {
  const rec = readCabinet(itemId);
  const seat = readSeat(itemId);
  const mine = iAmP1(itemId);
  const owner = deps.canEdit();
  const held = seat.holder !== '' && !seatLapsed(itemId);
  const game = rec.game;

  const onCabinet = game
    ? `<div style="display:flex; gap:6px; align-items:center; font-size:11px;">${gameRow(game)}</div>`
    : `<div style="font-size:10px; color:${DIM};">nothing — the owner picks a game in ⚙️ SETTINGS</div>`;

  const p1Line = mine ? 'You are at the controls.'
    : held ? `${esc(seat.name || 'A clone')} is at the controls.`
      : 'The controls are free.';
  const p1Buttons = [
    mine ? bigButton('data-arcade-stage="1"', '🕹 BACK TO THE CONTROLS', '47,230,160') : '',
    mine ? smallButton('data-arcade-standup="0"', '🪑 STAND UP') : '',
    !mine && maySit(itemId) && game ? bigButton('data-arcade-coin="0"', '🪙 INSERT COIN · PLAY', '212,168,75') : '',
    !mine && held && mayEjectP1() ? smallButton('data-arcade-eject="0"', '⏏ EJECT P1 (OWNER)') : '',
  ].join('');
  const players = deps.seats === 4
    ? playersSection(itemId, deps, game)
    : section('PLAYER ONE', `<div style="font-size:11px; color:${GOLD_BRIGHT}; line-height:1.4;">${p1Line}</div>${p1Buttons}`);

  return `
    <div>
      <div style="font-size:13px; font-weight:800; letter-spacing:1px; color:${GOLD_BRIGHT};">🕹 ARCADE CABINET</div>
      <div style="font-size:10px; color:${DIM}; margin-top:3px;"><span data-arcade-status="1"></span></div>
    </div>
    ${section('ON THE CABINET', onCabinet)}
    ${players}
    <div style="display:flex; gap:6px; align-items:center; justify-content:space-between;">
      <div style="font-size:9px; color:${DIM}; line-height:1.4;">At the controls: arrows + Z X A S · ENTER start · SHIFT select · gamepads plug straight in · ESC stands up.</div>
      ${smallButton('data-arcade-settings="1"', owner ? '⚙️ SETTINGS' : '⚙️ SEE SETTINGS')}
    </div>
  `;
}

/** SETTINGS: what the owner set, for anyone to read; the owner changes it here. */
function renderSettings(itemId: string, deps: ArcadeDeviceDeps): string {
  const rec = readCabinet(itemId);
  const owner = deps.canEdit();
  const game = rec.game;
  const lanesOn = convenienceLanesEnabled();

  const onCabinet = `${game
    ? `<div style="display:flex; gap:6px; align-items:center; font-size:11px;">${gameRow(game)}</div>${gameNote(game, deps.seats)}${fileNote(game, owner)}`
    : `<div style="font-size:10px; color:${DIM};">nothing — the owner picks a game</div>`}
    <div style="display:flex; gap:6px; align-items:center; justify-content:space-between; font-size:10px; color:${DIM};">
      <span>PLAYED ${rec.plays} TIME${rec.plays === 1 ? '' : 'S'}</span>
      ${owner && game ? smallButton('data-arcade-takeoff="1"', '⏏ TAKE IT OFF') : ''}
    </div>`;

  // The owner's pick, one of two kinds: a free game the app ships, on the
  // built-in emulator…
  const builtIn = owner ? section('FREE GAMES · BUILT-IN EMULATOR', `
    <div style="font-size:9px; color:${DIM}; line-height:1.4;">Ship with the game, play on the cabinet's screen, and the room watches. Players just walk up and press play.</div>
    ${BUILT_IN_GAMES.map((lib) => {
      const on = game?.bundled === lib.id;
      return `<div style="display:flex; gap:6px; align-items:center; font-size:11px;">
        <span style="color:${GOLD_BRIGHT}; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(lib.title)}</span>
        <span style="font-size:9px; color:${DIM}; white-space:nowrap;">${esc(LICENSE_LABEL[lib.license])}</span>
        ${smallButton(`data-arcade-builtin="${esc(lib.id)}"`, on ? '✓ ON' : '▶ PUT ON', !on, on)}
      </div>`;
    }).join('')}
  `) : '';

  // Everyone reads where the emulator's files come from; the owner picks.
  const files = owner
    ? `<div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${smallButton('data-arcade-data="station"', `${rec.data === 'station' ? '✓ ' : ''}THIS STATION`, true, rec.data === 'station')} ${laneBadge('SOVEREIGN')}
        ${lanesOn ? `${smallButton('data-arcade-data="cdn"', `${rec.data === 'cdn' ? '✓ ' : ''}cdn.emulatorjs.org`, true, rec.data === 'cdn')} ${laneBadge('CONVENIENCE')}` : ''}
      </div>`
    : `<div style="display:flex; gap:6px; align-items:center; font-size:11px; color:${GOLD_BRIGHT};">
        ${rec.data === 'cdn' ? 'cdn.emulatorjs.org' : 'THIS STATION'} ${laneBadge(rec.data === 'cdn' ? 'CONVENIENCE' : 'SOVEREIGN')}
      </div>`;

  const cores = `<select data-arcade-core="1" aria-label="Core" style="${INPUT_CSS}">
    <option value="" ${draftCore ? '' : 'selected'}>CORE — picked from the file's extension</option>
    ${ARCADE_CORES.map((c) => `<option value="${c.core}" ${c.core === draftCore ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
  </select>`;
  // …or their own, in EmulatorJS. Serverless only, the build default: a
  // link is one on this station's node or this page's own origin, and the
  // CDN is not offered.
  const load = owner ? section('YOUR OWN GAME · EMULATORJS', `
    <div style="font-size:9px; color:${DIM}; line-height:1.4;">Any console or arcade board EmulatorJS runs. ${deps.seats === 4 ? 'Up to four players play it together, each in a window that INSERT COIN opens on their own computer.' : 'Player one plays it in a window that INSERT COIN opens.'} A file from your disk is sent to each player who presses play (up to ${ROM_SHARE_MAX_BYTES / (1024 * 1024)} MB).</div>
    <label style="display:flex; flex-direction:column; gap:4px; font-size:10px; color:${GOLD_BRIGHT};">
      <span>📁 YOUR OWN FILE ${laneBadge('SOVEREIGN')}</span>
      <input type="file" data-arcade-file="1" accept="${romAcceptList()}" style="font-size:10px; color:#8fa3b8;">
      ${draftFile ? `<span style="color:${GREEN};">✓ ${esc(draftFile.name)}</span>` : ''}
    </label>
    <label style="display:flex; flex-direction:column; gap:4px; font-size:10px; color:${GOLD_BRIGHT};">
      <span>🔗 ${lanesOn ? 'A LINK ANY PLAYER CAN FETCH' : 'A LINK ON THIS STATION\'S NODE OR THIS ORIGIN'} ${laneBadge(lanesOn ? 'CONVENIENCE' : 'SOVEREIGN')}</span>
      <input type="text" data-arcade-url="1" placeholder="${lanesOn ? 'https://…/game.nes (CORS-clean)' : 'http://127.0.0.1:…/blob/… or a path on this origin'}" autocomplete="off" value="${esc(draftUrl)}" style="${INPUT_CSS}">
    </label>
    ${cores}
    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      ${smallButton('data-arcade-put="1"', '▶ PUT ON THE CABINET')}
    </div>
  `) : '';

  return `
    <div>
      <div style="font-size:13px; font-weight:800; letter-spacing:1px; color:${GOLD_BRIGHT};">⚙️ ARCADE CABINET</div>
      <div data-arcade-role="1" style="font-size:9px; color:${DIM}; letter-spacing:1px; margin-top:3px;">${owner ? 'YOU RUN THIS CABINET' : 'THE OWNER SETS THIS CABINET · ANYONE CAN LOOK'}</div>
    </div>
    ${section('ON THE CABINET · ONE GAME', onCabinet)}
    ${nowPlaying(itemId, deps, owner)}
    ${builtIn}
    ${load}
    ${section('EMULATORJS FILES', `${files}<div style="font-size:9px; color:${DIM}; line-height:1.4;">${emulatorFilesText(lanesOn)}</div>`)}
    ${smallButton('data-arcade-play="1"', '🕹 BACK TO THE CABINET')}
  `;
}

/** The panel's markup for a view (exported for its tests). */
export function renderArcadePanel(itemId: string, deps: ArcadeDeviceDeps): string {
  return deps.view === 'settings' ? renderSettings(itemId, deps) : renderPlay(itemId, deps);
}

function wirePanel(panel: HTMLElement, itemId: string, deps: ArcadeDeviceDeps, rerender: () => void): void {
  const note = (text: string) => showNote(panel, text);
  const q = <T extends HTMLElement>(sel: string) => panel.querySelector<T>(sel);
  // A button's seat: P1 (0) but at the double-wide cabinet, whose rows name theirs.
  const seatOf = (raw: string | undefined) => {
    const n = Number(raw);
    return deps.seats === 4 && Number.isInteger(n) && n >= 0 && n < 4 ? n : 0;
  };
  panel.querySelectorAll<HTMLButtonElement>('[data-arcade-coin]').forEach((b) => b.addEventListener('click', () => {
    const r = insertCoin(itemId, seatOf(b.dataset.arcadeCoin));
    if (!r.ok) {
      note(r.error);
      return;
    }
    if (readCabinet(itemId).game) deps.openStage();
    else note('The owner has not picked a game yet.');
  }));
  q<HTMLButtonElement>('[data-arcade-stage]')?.addEventListener('click', () => deps.openStage());
  q<HTMLButtonElement>('[data-arcade-settings]')?.addEventListener('click', () => deps.openSettings?.());
  q<HTMLButtonElement>('[data-arcade-play]')?.addEventListener('click', () => deps.openPlay?.());
  panel.querySelectorAll<HTMLButtonElement>('[data-arcade-standup]').forEach((b) => b.addEventListener('click', () => {
    standUp(itemId, seatOf(b.dataset.arcadeStandup));
  }));
  panel.querySelectorAll<HTMLButtonElement>('[data-arcade-eject]').forEach((b) => b.addEventListener('click', () => {
    const r = standUp(itemId, seatOf(b.dataset.arcadeEject));
    if (!r.ok) note(r.error);
  }));
  panel.querySelectorAll<HTMLButtonElement>('[data-arcade-builtin]').forEach((b) => b.addEventListener('click', () => {
    const game = builtInGame(b.dataset.arcadeBuiltin ?? '');
    const r = game ? putOnCabinet(itemId, game) : { ok: false as const, error: 'That game is not in this build.' };
    note(r.ok ? `On the cabinet: ${game!.name}` : r.error);
  }));
  q<HTMLButtonElement>('[data-arcade-reset]')?.addEventListener('click', () => {
    const text = resetArcadeCabinet(itemId, deps.canEdit(), deps.seats);
    if (text) note(text);
  });
  q<HTMLButtonElement>('[data-arcade-takeoff]')?.addEventListener('click', () => {
    const r = takeOffCabinet(itemId);
    if (!r.ok) note(r.error);
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-arcade-data]').forEach((b) => b.addEventListener('click', () => {
    const r = setEmulatorData(itemId, b.dataset.arcadeData === 'cdn' ? 'cdn' : 'station');
    if (!r.ok) note(r.error);
  }));

  // The owner's draft.
  q<HTMLInputElement>('[data-arcade-file]')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (!file) return;
    draftFile = file;
    draftUrl = '';
    draftCore = coreForName(file.name) ?? draftCore;
    rerender();
  });
  const url = q<HTMLInputElement>('[data-arcade-url]');
  url?.addEventListener('keydown', (e) => { e.stopPropagation(); }); // typing must not walk the fox
  url?.addEventListener('keyup', (e) => { e.stopPropagation(); });
  url?.addEventListener('input', () => {
    draftUrl = url.value;
    if (draftUrl.trim()) draftFile = null;
    const parsed = parseRomUrl(draftUrl);
    const sel = q<HTMLSelectElement>('[data-arcade-core]');
    if (parsed?.core && !draftCore && sel) sel.value = parsed.core; // suggested, not yet chosen
  });
  q<HTMLSelectElement>('[data-arcade-core]')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    draftCore = isArcadeCore(v) ? v : '';
  });
  q<HTMLButtonElement>('[data-arcade-put]')?.addEventListener('click', () => {
    const sel = q<HTMLSelectElement>('[data-arcade-core]');
    if (sel && !draftCore && isArcadeCore(sel.value)) draftCore = sel.value;
    const d = draftGame();
    if ('error' in d) {
      note(d.error);
      return;
    }
    if (!d.file) {
      const r = putOnCabinet(itemId, d.game);
      note(r.ok ? `On the cabinet: ${d.game.name}` : r.error);
      return;
    }
    // A file from the owner's disk goes on with its hash, and this page
    // holds its bytes to send to each player who presses play.
    const file = d.file;
    note(`Reading ${file.name}…`);
    void putOnOwnFile(itemId, d.game, file).then(note);
  });
}

/** Put the owner's own file on the cabinet: hashed, so players who press
 *  play can be sent it and check it (arcadeRomShare). The note to show. */
async function putOnOwnFile(itemId: string, game: ArcadeGame, file: File): Promise<string> {
  let bytes: Uint8Array;
  let sha: string;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    sha = await sha256Hex(bytes);
  } catch {
    return `Could not read ${file.name}.`;
  }
  const withHash: ArcadeGame = { ...game, size: bytes.length, sha256: sha };
  const r = putOnCabinet(itemId, withHash);
  if (!r.ok) return r.error;
  rememberLocalRom(withHash, file);
  if (bytes.length > ROM_SHARE_MAX_BYTES) {
    return `On the cabinet: ${game.name}. It is over ${ROM_SHARE_MAX_BYTES / (1024 * 1024)} MB, so it is not sent: players bring their own copy.`;
  }
  holdRom(sha, bytes);
  return `On the cabinet: ${game.name}. Players who press play get it from your computer.`;
}

// ── The DeviceUI ─────────────────────────────────────────────────────────────

export function createArcadeCabinetUI(deps: ArcadeDeviceDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let clockTimer = 0;
  let lastHtml = '';

  const render = (): void => {
    if (!panel) return;
    // A built-in game plays on the cabinet's screen: PLAY hands over to it
    // (World builds that UI in this one's place, unmounting it; until the
    // focus has landed, the panel stays and the next repaint asks again).
    if (deps.view !== 'settings' && readCabinet(deps.itemId).game?.bundled && deps.openPlay) {
      deps.openPlay();
      if (!panel) return;
    }
    const html = renderArcadePanel(deps.itemId, deps);
    if (html !== lastHtml) {
      panel.innerHTML = html;
      lastHtml = html;
      wirePanel(panel, deps.itemId, deps, render);
    }
    refreshStatus(panel, deps.itemId, deps.seats);
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = `device-arcade-${deps.view === 'settings' ? 'settings-' : ''}${deps.itemId}`;
      panel.style.cssText = PANEL_CSS;
      panel.addEventListener('click', (e) => e.stopPropagation());
      lastHtml = '';
      host.appendChild(panel);
      const subs = [
        subscribeArcadeKey(cabinetKey(deps.itemId), render),
        ...Array.from({ length: deps.seats === 4 ? 4 : 1 }, (_, n) => subscribeArcadeKey(seatKey(deps.itemId, n), render)),
        subscribeGames(render), // a built-in game's match: who is at which stand
      ];
      unsubscribe = () => { for (const s of subs) s(); };
      // The seat lapses without a write; the status line moves with it.
      clockTimer = window.setInterval(render, 1000);
      render();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      window.clearInterval(clockTimer);
      panel?.remove();
      panel = null;
    },
    update(): void { /* doc-driven */ },
  };
}
