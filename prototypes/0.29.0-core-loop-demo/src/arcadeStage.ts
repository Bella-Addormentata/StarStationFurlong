/**
 * 🕹 arcadeStage — P1's stage (#193): the emulator frame in a 4:3 panel with
 * the CRT pass over it, opened by INSERT COIN from the cabinet's panel (the
 * device focus is released first, the TV theatre's posture) and closed by
 * Escape, the ✕, STAND UP, losing the seat, or the cabinet leaving the
 * room. Closing on P1's own account stands P1 up; closing because the seat
 * went to someone else never touches their seat.
 *
 * WHILE THE STAGE IS OPEN THE WORLD GETS NO KEYS. The world's InputManager
 * listens on the window with no target check, so W/A/S/D typed into the
 * parent page would walk the player; a capture-phase listener on the window
 * swallows every KEYDOWN that reaches the parent while the stage is up.
 * Keys typed into the focused frame never reach the parent at all — that is
 * the normal path; the swallow covers the moments the frame has not got
 * focus (a click on the chrome, the notices before a game runs). KEYUP is
 * never swallowed: a keyup starts nothing in the world, it only ends what a
 * keydown began — and a key held when the stage opened must still be
 * released to the InputManager, or the player walks on after the stage
 * closes until that key is pressed again. Escape, from either side, stands
 * P1 up. Because of the swallow, a stage whose seat is gone closes AT ONCE
 * rather than lingering behind a notice.
 *
 * What it shows before the game runs, honestly: CHECKING / LOADING /
 * STARTING, NOT PROVISIONED with the command when this station has no
 * emulator files, BRING YOUR COPY when the game is a file on its owner's
 * disk (the copy must be the same size as the shelf's), YOUR COPY WOULD
 * RUN UNDER CDN CODE when that file would be handed to engine code from
 * another origin (the player's consent, not a claim that it is safe), and
 * a RETRY on any fault.
 */

import { coreLabel, countPlay, gameId, gameLane, iAmP1, readCabinet, readSeat, standUp } from './arcadeDoc';
import type { ArcadeGame, EmulatorData } from './arcadeDoc';
import {
  allowLocalRomExposure, emulatorDataLane, emulatorDataPath, emulatorErrorText, emulatorIsolated,
  localRomExposureAllowed, localRomFor, mountEmulatorFrame, probeEmulatorData, rememberLocalRom,
  romAcceptList, EMULATOR_FETCH_COMMAND,
} from './arcadeEmulator';
import type { EmulatorHandle } from './arcadeEmulator';
import { acceptMediaOrigin, ownMediaOrigins, urlConsent, urlRefusal } from './tvConsent';
import type { MediaConsent } from './tvConsent';
import { convenienceLanesEnabled, SERVERLESS_ONLY } from './sovereignty';
import { escapeHtml } from './htmlEscape';
import { showHint } from './hud';

type Phase = 'checking' | 'loading' | 'starting' | 'in play' | 'waiting' | 'fault' | 'idle';

interface Stage {
  root: HTMLDivElement;
  itemId: string;
  head: HTMLDivElement;
  screen: HTMLDivElement;
  notice: HTMLDivElement;
  status: HTMLDivElement;
  controls: HTMLDivElement;
  frame: EmulatorHandle | null;
  /** `<gameId>@<data>` of what is mounted, 'waiting:…' for a file to bring,
   *  'consent:…' for a file the player has not yet agreed to hand to CDN
   *  code, 'failed:…' after a fault (RETRY clears it), '' for nothing. */
  mounted: string;
  phase: Phase;
  counted: boolean;
  timer: number;
  onKey: (e: KeyboardEvent) => void;
  lastHead: string;
  lastStatus: string;
  lastControls: string;
  /** A wrong file picked for BRING YOUR COPY: said once, under the notice. */
  fileNote: string;
  /** What had focus when the stage opened: focus goes back there on close. */
  opener: HTMLElement | null;
}

let stage: Stage | null = null;

export function isArcadeStageOpen(itemId?: string): boolean {
  return stage !== null && (itemId === undefined || stage.itemId === itemId);
}

export function openArcadeStage(itemId: string): void {
  if (stage && stage.itemId !== itemId) closeArcadeStage();
  if (stage) return;
  const root = document.createElement('div');
  root.id = 'arcade-stage';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Arcade cabinet');
  // A modal, and said so: it takes focus, keeps Tab inside, and hands focus
  // back to whatever had it when it closes (the theatre's lifecycle).
  root.setAttribute('aria-modal', 'true');
  root.tabIndex = -1;
  root.innerHTML = `
    <div class="arcade-stage-panel">
      <div class="arcade-stage-head"></div>
      <div class="arcade-stage-screen"><div class="arcade-stage-notice" hidden></div><div class="arcade-crt"></div></div>
      <div class="arcade-stage-status"></div>
      <div class="arcade-stage-controls"></div>
    </div>`;
  // Clicks stay inside (the world's click-to-release must not see them); a
  // click on the picture hands the keyboard back to the frame.
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    const el = e.target as HTMLElement | null;
    if (el && !el.closest('button, input, label, select')) stage?.frame?.focus();
  });
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(root);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closeArcadeStage();
      return;
    }
    // Tab stays inside the dialog: cycle its controls (and the frame, which
    // takes focus itself), rather than letting focus walk the room behind.
    if (e.key === 'Tab') {
      const focusable = stageFocusable(root);
      e.preventDefault();
      e.stopPropagation();
      if (focusable.length === 0) return;
      const at = focusable.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? focusable[(at <= 0 ? focusable.length : at) - 1]!
        : focusable[(at + 1) % focusable.length]!;
      next.focus();
      return;
    }
    e.stopPropagation(); // at the controls: nothing walks the player
  };
  // Keydown only: a keyup must still reach the InputManager, so a key held
  // as the stage opened is let go of (see the header).
  window.addEventListener('keydown', onKey, true);
  stage = {
    root,
    itemId,
    head: root.querySelector<HTMLDivElement>('.arcade-stage-head')!,
    screen: root.querySelector<HTMLDivElement>('.arcade-stage-screen')!,
    notice: root.querySelector<HTMLDivElement>('.arcade-stage-notice')!,
    status: root.querySelector<HTMLDivElement>('.arcade-stage-status')!,
    controls: root.querySelector<HTMLDivElement>('.arcade-stage-controls')!,
    frame: null,
    mounted: '',
    phase: 'idle',
    counted: false,
    timer: 0,
    onKey,
    lastHead: '',
    lastStatus: '',
    lastControls: '',
    fileNote: '',
    opener,
  };
  root.focus();
  stage.timer = window.setInterval(stageTick, 500);
  stageTick();
}

/** The stage's controls in Tab order: its buttons, the file picker and the
 *  emulator frame itself (it takes focus, and the game's keys go to it). */
function stageFocusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), iframe')];
}

/** Close the stage; stand up only if this page still holds P1 (the owner
 *  closing a stage whose seat went to someone else must not kick them). */
export function closeArcadeStage(): void {
  if (!stage) return;
  const t = stage;
  teardown(t);
  if (iAmP1(t.itemId)) standUp(t.itemId);
}

function teardown(t: Stage): void {
  if (stage === t) stage = null;
  window.clearInterval(t.timer);
  window.removeEventListener('keydown', t.onKey, true);
  unmountFrame(t);
  t.root.remove();
  if (t.opener && t.opener.isConnected) t.opener.focus();
}

function unmountFrame(t: Stage): void {
  t.frame?.destroy();
  t.frame = null;
  t.mounted = '';
  t.phase = 'idle';
}

function showNotice(t: Stage, title: string, hint: string, retry = false): void {
  t.notice.innerHTML = `<div>${escapeHtml(title)}</div>
    <div class="arcade-stage-hint">${hint}</div>
    ${retry ? '<button type="button" data-arcade-retry="1">RETRY</button>' : ''}`;
  t.notice.hidden = false;
  t.notice.querySelector<HTMLButtonElement>('[data-arcade-retry]')?.addEventListener('click', () => {
    t.mounted = '';
    stageTick();
  });
}

function hideNotice(t: Stage): void {
  t.notice.hidden = true;
  t.notice.innerHTML = '';
}

function fail(t: Stage, key: string, text: { title: string; hint: string }): void {
  unmountFrame(t);
  t.mounted = `failed:${key}`;
  t.phase = 'fault';
  showNotice(t, text.title, escapeHtml(text.hint).replace(/npm run fetch:emulatorjs/g, '<code>npm run fetch:emulatorjs</code>'), true);
  renderStageChrome(t);
}

function stageTick(): void {
  const t = stage;
  if (!t) return;
  if (!iAmP1(t.itemId)) {
    // Kicked by the owner, lapsed from another page's view and taken, or
    // stood up elsewhere: the stage goes down now — it swallows the world's
    // keys while it is up — and nobody's seat is touched.
    teardown(t);
    showHint('🕹 You are no longer at the controls.');
    return;
  }
  const rec = readCabinet(t.itemId);
  const game = rec.game;
  if (!game) {
    if (t.mounted !== 'nogame') {
      unmountFrame(t);
      t.mounted = 'nogame';
      showNotice(t, 'NO GAME ON THE CABINET', 'Pick one from the shelf at the cabinet, or ask the owner to load one.');
    }
    renderStageChrome(t);
    return;
  }
  const key = `${gameId(game)}@${rec.data}`;
  // A game's link is a peer-written URL this browser would fetch: asked of
  // every tick, as the theatre asks (tvConsent) — a mounted game whose
  // origin loses its consent (the node's origin losing its fingerprint
  // trust) comes down, so a RETRY or reload never fetches from a stranger.
  const consent = game.url && t.mounted === key ? urlConsent(game.url) : 'ok';
  if (consent !== 'ok') {
    unmountFrame(t);
    t.mounted = `consent:${key}`;
    t.phase = 'waiting';
    urlConsentNotice(t, game, consent);
  } else if (t.mounted !== key && t.mounted !== `failed:${key}` && t.mounted !== `waiting:${key}` && t.mounted !== `consent:${key}`) {
    void mountGame(t, game, rec.data, key);
  }
  renderStageChrome(t);
}

/** FETCH <game> FROM <host>? — or NOT FETCHED HERE for a host inside a
 *  private network, which no button can override, and for any other
 *  server in a serverless-only build. The TV's ask, for a ROM. */
function urlConsentNotice(t: Stage, game: ArcadeGame, consent: Exclude<MediaConsent, 'ok'>): void {
  let host = game.url;
  let origin = game.url;
  try {
    const u = new URL(game.url);
    host = u.host;
    origin = u.origin;
  } catch { /* shown as it is */ }
  if (consent === 'refuse') {
    const why = urlRefusal(game.url);
    const where = convenienceLanesEnabled() ? 'a link any player can reach, or on this station\'s own node' : 'this station\'s own node, or on this page\'s own origin';
    showNotice(t, 'NOT FETCHED HERE', why === 'server-off'
      ? `<b>${escapeHtml(host || 'this link')}</b> is another server, and ${escapeHtml(SERVERLESS_ONLY)}: a game on this station's node or this page's own origin plays here. The owner can put the game on ${where}, or bring the file.`
      : why === 'private'
        ? `<b>${escapeHtml(host || 'this link')}</b> is inside a private network — nobody in the room can ask your browser to fetch from there. The owner can put the game on ${where}.`
        : `<b>${escapeHtml(host || 'this link')}</b> is not a link this browser can fetch. The owner can put the game on ${where}.`);
    return;
  }
  showNotice(t, `FETCH ${game.name.toUpperCase()} FROM ${escapeHtml(host).toUpperCase()}?`,
    `<span class="arcade-stage-lane">CONVENIENCE LANE</span> — your browser would fetch this game from <b>${escapeHtml(host)}</b>, which could send the request anywhere, your own network included; whoever put it on the cabinet cannot decide that for you.<br>
    <button type="button" data-arcade-fetch="1">▶ FETCH FROM ${escapeHtml(host.toUpperCase())}</button>`);
  t.notice.querySelector<HTMLButtonElement>('[data-arcade-fetch]')?.addEventListener('click', () => {
    acceptMediaOrigin(origin);
    t.mounted = '';
    stageTick();
  });
}

function waitingNotice(t: Stage, game: ArcadeGame): void {
  const size = game.size > 0 ? ` (${game.size.toLocaleString()} bytes)` : '';
  showNotice(t, `BRING YOUR COPY OF ${game.name.toUpperCase()}`,
    `This game is a file on its owner's disk, not a link. Pick the same file${escapeHtml(size)} from yours below — the blob lane will carry it between players later.${t.fileNote ? `<br><span style="color:#ff8a50;">${escapeHtml(t.fileNote)}</span>` : ''}`);
}

/** The player's file would be handed to engine code from another origin:
 *  said plainly, and run only on their word. The sandbox is no answer here —
 *  it keeps that code off this page, not off the file it is given. */
function consentNotice(t: Stage, game: ArcadeGame, path: string): void {
  let host = path;
  try { host = new URL(path).host; } catch { /* shown as it is */ }
  showNotice(t, 'YOUR COPY WOULD RUN UNDER CDN CODE',
    `This cabinet loads its emulator from <b>${escapeHtml(host)}</b> (the CONVENIENCE lane). That code runs in an isolated frame that cannot touch this page — but it can read the file you bring, <b>${escapeHtml(game.name)}</b>, and send it anywhere. Your file stays on this machine only with THIS STATION's emulator files (the owner's call: <code>${escapeHtml(EMULATOR_FETCH_COMMAND)}</code>, then rebuild).<br>
    <button type="button" data-arcade-expose="1">▶ RUN MY COPY UNDER ${escapeHtml(host.toUpperCase())} ANYWAY</button>`);
  t.notice.querySelector<HTMLButtonElement>('[data-arcade-expose]')?.addEventListener('click', () => {
    allowLocalRomExposure(game, path);
    t.mounted = '';
    stageTick();
  });
}

async function mountGame(t: Stage, game: ArcadeGame, data: EmulatorData, key: string): Promise<void> {
  unmountFrame(t);
  t.mounted = key;
  t.phase = 'checking';
  t.counted = false;
  // This viewer's browser fetches a game's link only with this viewer's
  // consent (tvConsent, the theatre's rule): the record is peer-writable,
  // and a link into the viewer's own network is never fetched, whatever
  // lane the emulator's own files come from.
  if (game.url) {
    const consent = urlConsent(game.url);
    if (consent !== 'ok') {
      t.mounted = `consent:${key}`;
      t.phase = 'waiting';
      urlConsentNotice(t, game, consent);
      renderStageChrome(t);
      return;
    }
  }
  const path = emulatorDataPath(data);
  showNotice(t, 'CHECKING THE EMULATOR FILES…', `<span class="arcade-stage-lane">${emulatorDataLane(data)} LANE · ${escapeHtml(path)}</span>`);
  renderStageChrome(t);
  const probe = await probeEmulatorData(path);
  if (stage !== t || t.mounted !== key) return;
  if (probe === 'missing' || probe === 'unreachable') {
    fail(t, key, emulatorErrorText(probe === 'missing' ? 'loader' : 'unreachable', data));
    return;
  }
  let file: File | null = null;
  if (!game.url) {
    file = localRomFor(game);
    if (!file) {
      t.mounted = `waiting:${key}`;
      t.phase = 'waiting';
      waitingNotice(t, game);
      renderStageChrome(t);
      return;
    }
    // A file from the player's disk goes to engine code from another
    // origin only on the player's word (arcadeEmulator: the sandbox keeps
    // that code off this page, not off the file it is handed).
    if (!localRomExposureAllowed(game, path)) {
      t.mounted = `consent:${key}`;
      t.phase = 'waiting';
      consentNotice(t, game, path);
      renderStageChrome(t);
      return;
    }
  }
  hideNotice(t);
  t.phase = 'loading';
  t.frame = mountEmulatorFrame(t.screen, {
    core: game.core,
    gameUrl: game.url,
    file,
    gameName: game.name,
    pathToData: path,
    volume: 0.7,
    isolated: emulatorIsolated(path),
    // The station lane's policy: this origin and the viewer's own node.
    allowOrigins: ownMediaOrigins(),
  }, (ev) => {
    if (stage !== t || t.mounted !== key) return;
    if (ev.type === 'frame-ready') t.phase = 'loading';
    else if (ev.type === 'ready') {
      t.phase = 'starting';
      t.frame?.focus();
    } else if (ev.type === 'started') {
      t.phase = 'in play';
      if (!t.counted) {
        t.counted = true;
        countPlay(t.itemId);
      }
      t.frame?.focus();
    } else if (ev.type === 'exit') closeArcadeStage();
    else if (ev.type === 'error') fail(t, key, emulatorErrorText(ev.why, data));
    if (stage === t) renderStageChrome(t);
  });
  // The CRT overlay must stay above the frame.
  const crt = t.screen.querySelector('.arcade-crt');
  if (crt) t.screen.appendChild(crt);
  t.frame.focus();
}

function renderStageChrome(t: Stage): void {
  const rec = readCabinet(t.itemId);
  const seat = readSeat(t.itemId);
  const game = rec.game;
  const lane = game ? gameLane(game) : '';
  const head = `<span class="arcade-stage-title">🕹 ${game ? `${escapeHtml(game.name)} · ${escapeHtml(coreLabel(game.core))}` : 'ARCADE CABINET'}</span>
    ${lane ? `<span class="tv-lane-badge tv-lane-${lane.toLowerCase()}">${lane}</span>` : ''}
    <button type="button" class="arcade-stage-close" data-arcade-close="1" aria-label="Stand up and close">✕</button>`;
  if (head !== t.lastHead) {
    t.head.innerHTML = head;
    t.lastHead = head;
    t.head.querySelector<HTMLButtonElement>('[data-arcade-close]')?.addEventListener('click', () => closeArcadeStage());
  }
  // Plain text, set with textContent: the raw name, never an escaped one.
  const who = seat.holder ? `P1 · ${seat.name || 'a clone'}` : 'NOBODY AT THE CONTROLS';
  const status = `${who} · ${t.phase.toUpperCase()} · EMULATOR FILES: ${emulatorDataLane(rec.data)}`;
  if (status !== t.lastStatus) {
    t.status.textContent = status;
    t.lastStatus = status;
  }
  const waiting = t.mounted.startsWith('waiting:');
  const controls = `<button type="button" data-arcade-standup="1">🪑 STAND UP</button>
    ${waiting ? `<label>📁 PICK YOUR COPY <input type="file" data-arcade-stage-file="1" accept="${romAcceptList()}" aria-label="Pick your copy of the game"></label>` : ''}
    <span class="arcade-stage-lane">arrows + Z X A S · ENTER start · SHIFT select · gamepads plug in · ESC stands up</span>`;
  if (controls !== t.lastControls) {
    t.controls.innerHTML = controls;
    t.lastControls = controls;
    t.controls.querySelector<HTMLButtonElement>('[data-arcade-standup]')?.addEventListener('click', () => closeArcadeStage());
    t.controls.querySelector<HTMLInputElement>('[data-arcade-stage-file]')?.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      const g = readCabinet(t.itemId).game;
      if (!file || !g) return;
      // The shelf's copy has a size: a file of another size is another file,
      // whatever its name says — it is not launched under this game's name.
      if (g.size > 0 && file.size !== g.size) {
        t.fileNote = `${file.name} is ${file.size.toLocaleString()} bytes; the shelf's ${g.name} is ${g.size.toLocaleString()}. Not the same file.`;
        input.value = '';
        waitingNotice(t, g);
        return;
      }
      t.fileNote = '';
      rememberLocalRom(g, file);
      t.mounted = '';
      stageTick();
    });
  }
}
