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
 * swallows every keydown/keyup that reaches the parent while the stage is
 * up. Keys typed into the focused frame never reach the parent at all —
 * that is the normal path; the swallow covers the moments the frame has
 * not got focus (a click on the chrome). Escape, from either side, stands
 * P1 up. Because of that swallow, a stage whose seat is gone closes AT ONCE
 * rather than lingering behind a notice.
 *
 * What it shows before the game runs, honestly: CHECKING / LOADING /
 * STARTING, NOT PROVISIONED with the command when this station has no
 * emulator files, BRING YOUR COPY when the game is a file on its owner's
 * disk (the copy must be the same size as the shelf's), and a RETRY on any
 * fault.
 */

import { coreLabel, countPlay, gameId, gameLane, iAmP1, readCabinet, readSeat, standUp } from './arcadeDoc';
import type { ArcadeGame, EmulatorData } from './arcadeDoc';
import {
  emulatorDataLane, emulatorDataPath, emulatorErrorText, emulatorIsolated, localRomFor,
  mountEmulatorFrame, probeEmulatorData, rememberLocalRom, romAcceptList,
} from './arcadeEmulator';
import type { EmulatorHandle } from './arcadeEmulator';
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
   *  'failed:…' after a fault (RETRY clears it), '' for nothing. */
  mounted: string;
  phase: Phase;
  counted: boolean;
  timer: number;
  onKey: (e: KeyboardEvent) => void;
  onKeyUp: (e: KeyboardEvent) => void;
  lastHead: string;
  lastStatus: string;
  lastControls: string;
  /** A wrong file picked for BRING YOUR COPY: said once, under the notice. */
  fileNote: string;
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
  document.body.appendChild(root);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closeArcadeStage();
      return;
    }
    e.stopPropagation(); // at the controls: nothing walks the player
  };
  const onKeyUp = (e: KeyboardEvent) => { e.stopPropagation(); };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
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
    onKeyUp,
    lastHead: '',
    lastStatus: '',
    lastControls: '',
    fileNote: '',
  };
  stage.timer = window.setInterval(stageTick, 500);
  stageTick();
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
  window.removeEventListener('keyup', t.onKeyUp, true);
  unmountFrame(t);
  t.root.remove();
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
  if (t.mounted !== key && t.mounted !== `failed:${key}` && t.mounted !== `waiting:${key}`) {
    void mountGame(t, game, rec.data, key);
  }
  renderStageChrome(t);
}

function waitingNotice(t: Stage, game: ArcadeGame): void {
  const size = game.size > 0 ? ` (${game.size.toLocaleString()} bytes)` : '';
  showNotice(t, `BRING YOUR COPY OF ${game.name.toUpperCase()}`,
    `This game is a file on its owner's disk, not a link. Pick the same file${escapeHtml(size)} from yours below — the blob lane will carry it between players later.${t.fileNote ? `<br><span style="color:#ff8a50;">${escapeHtml(t.fileNote)}</span>` : ''}`);
}

async function mountGame(t: Stage, game: ArcadeGame, data: EmulatorData, key: string): Promise<void> {
  unmountFrame(t);
  t.mounted = key;
  t.phase = 'checking';
  t.counted = false;
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
