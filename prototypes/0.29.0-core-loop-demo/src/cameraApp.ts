/**
 * 📷 The SpacePhone's CAMERA app (#319): 📷 TAKE A PHOTO brings up the
 * viewfinder, and the shot prints onto the film roll (filmRoll.ts) as a
 * Polaroid with its date, the room's name and a caption the player types.
 *
 * The viewfinder works like the IR blaster's AIM (irBlaster.ts): the phone
 * slides down to its tip, frame marks go up over the room, and a click on
 * the room, Space, Enter or the round shutter takes the shot (main.ts reads
 * the frame: cameraShot.ts). Escape, or the phone opened by any other path,
 * puts the camera down. The flash and the shutter's sound are the screen's
 * own, never in the picture.
 *
 * DOM only: the roll is filmRoll's, the frame cameraShot's. Captions and
 * room names are escaped before they reach innerHTML.
 */

import { escapeHtml } from './htmlEscape';
import { cleanCaption, listShots, MAX_CAPTION, onRollChange, removeShot, rollIsLasting, ROLL_MAX, setCaption, shotLabel, type FilmShot } from './filmRoll';

const PHONE_ID = 'spacephone-container';
const SUBTITLE_ID = 'phone-app-subtitle';
const VIEWFINDER_ID = 'camera-viewfinder';
const FLASH_ID = 'camera-flash';
const VIEWFINDER_LINE = 'VIEWFINDER · CLICK OR SPACE SHOOTS · ESC STOPS';

// ── The viewfinder ──────────────────────────────────────────────────────────

let viewfinding = false;
let busy = false;
let onShoot: (() => Promise<void> | void) | null = null;
let subtitleBefore: string | null = null;
let watcher: MutationObserver | null = null;

export function isViewfinding(): boolean {
  return viewfinding;
}

function viewfinderEl(): HTMLElement {
  let el = document.getElementById(VIEWFINDER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = VIEWFINDER_ID;
  el.innerHTML =
    '<span class="vf-corner vf-tl"></span><span class="vf-corner vf-tr"></span>' +
    '<span class="vf-corner vf-bl"></span><span class="vf-corner vf-br"></span>' +
    '<span class="vf-cross"></span>' +
    '<button type="button" id="camera-shutter" aria-label="Take the photo" title="Take the photo"></button>';
  el.querySelector('#camera-shutter')?.addEventListener('click', (e) => {
    e.stopPropagation();
    shootViewfinder();
  });
  document.body.appendChild(el);
  return el;
}

const onKey = (e: KeyboardEvent): void => {
  if (!viewfinding) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    stopViewfinder();
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) shootViewfinder();
  }
};

/** 📷 The phone down to its tip and the frame marks up; `shoot` takes the
 *  picture when the player presses. */
export function startViewfinder(shoot: () => Promise<void> | void): void {
  const phone = document.getElementById(PHONE_ID);
  if (!phone) return;
  // A control left focused in a phone slid away would take the next key.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && phone.contains(focused)) focused.blur();
  onShoot = shoot;
  viewfinding = true;
  viewfinderEl();
  phone.classList.remove('active');
  phone.classList.add('viewfinding');
  document.body.classList.add('camera-viewfinding');
  const subtitle = document.getElementById(SUBTITLE_ID);
  if (subtitle) {
    subtitleBefore ??= subtitle.textContent;
    subtitle.textContent = VIEWFINDER_LINE;
  }
  window.addEventListener('keydown', onKey, true);
  // Opened again by any path (Tab, the bezel, a TV clicked, the quick chat
  // raising it a sliver): the camera goes down.
  watcher ??= new MutationObserver(() => {
    if (viewfinding && !busy && (phone.classList.contains('active') || phone.classList.contains('peek'))) stopViewfinder();
  });
  watcher.observe(phone, { attributes: true, attributeFilter: ['class'] });
}

export function stopViewfinder(): void {
  if (!viewfinding) return;
  viewfinding = false;
  onShoot = null;
  document.getElementById(PHONE_ID)?.classList.remove('viewfinding');
  document.body.classList.remove('camera-viewfinding');
  const subtitle = document.getElementById(SUBTITLE_ID);
  // Given back only if nothing wrote over it.
  if (subtitle && subtitleBefore !== null && subtitle.textContent === VIEWFINDER_LINE) subtitle.textContent = subtitleBefore;
  subtitleBefore = null;
  window.removeEventListener('keydown', onKey, true);
  watcher?.disconnect();
}

/** The shutter: a click on the room while the viewfinder is up (main.ts
 *  onCanvasClick), Space, Enter or the round button. One shot at a time. */
export function shootViewfinder(): void {
  if (!viewfinding || busy || !onShoot) return;
  busy = true;
  cameraFlash();
  shutterSound();
  Promise.resolve()
    .then(() => onShoot?.())
    .catch(() => {})
    .finally(() => {
      busy = false;
    });
}

/** The screen's white flash (DOM, so never in the picture). */
export function cameraFlash(): void {
  let el = document.getElementById(FLASH_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = FLASH_ID;
    document.body.appendChild(el);
  }
  el.classList.remove('flashing');
  void el.offsetWidth; // a new animation, not the one still running
  el.classList.add('flashing');
}

let audio: AudioContext | null = null;

/** The shutter's click: a short burst of filtered noise, then a softer one
 *  as the blades open again. */
export function shutterSound(): void {
  try {
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audio ??= new AC();
    const ctx = audio;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const click = (at: number, gain: number, hz: number) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = hz;
      band.Q.value = 1.2;
      const env = ctx.createGain();
      env.gain.setValueAtTime(gain, at);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      src.connect(band).connect(env).connect(ctx.destination);
      src.start(at);
    };
    const t0 = ctx.currentTime + 0.005;
    click(t0, 0.5, 3200);
    click(t0 + 0.09, 0.25, 2200);
  } catch {
    /* no sound is fine */
  }
}

// ── The roll ────────────────────────────────────────────────────────────────

export interface CameraAppDeps {
  /** 📷 TAKE A PHOTO: put the viewfinder up. */
  shoot: () => void;
}

export interface CameraAppOpen {
  /** A shot just taken: its caption box gets the focus. */
  focusShot?: string;
  /** A line above the roll (a shot that didn't take). */
  notice?: string;
}

const urls = new Map<string, string>();
let appDeps: CameraAppDeps | null = null;
let wiredHost: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
let notice = '';
/** The discard button pressed once, which a second press confirms. */
let armedDiscard: string | null = null;
let paintSeq = 0;

function urlFor(shot: FilmShot): string {
  let url = urls.get(shot.id);
  if (!url) {
    url = URL.createObjectURL(shot.jpeg);
    urls.set(shot.id, url);
  }
  return url;
}

/** The roll's HTML for these shots (escaped; exported for tests). */
export function cameraAppHtml(shots: readonly FilmShot[], opts: { notice?: string; lasting: boolean; armed?: string | null; urlOf: (s: FilmShot) => string }): string {
  const parts: string[] = [];
  parts.push('<button type="button" class="camera-shoot" data-camera-shoot>📷 TAKE A PHOTO</button>');
  if (opts.notice) parts.push(`<div class="camera-notice" role="status">${escapeHtml(opts.notice)}</div>`);
  if (!opts.lasting) parts.push('<div class="camera-notice">This browser can’t keep photos: the roll empties when the page closes.</div>');
  if (shots.length === 0) {
    parts.push('<div class="camera-empty">No photos yet. Take one and it prints here.</div>');
  } else {
    parts.push('<div class="camera-roll">');
    for (const s of shots) {
      const id = escapeHtml(s.id);
      const armed = opts.armed === s.id;
      parts.push(
        `<figure class="polaroid" data-shot="${id}">` +
          `<button type="button" class="polaroid-photo" data-camera-zoom="${id}" aria-label="View this photo big">` +
          `<img src="${escapeHtml(opts.urlOf(s))}" width="${s.width}" height="${s.height}" alt="${escapeHtml(s.caption || 'A photo')}"></button>` +
          '<figcaption>' +
          `<input type="text" class="polaroid-caption" data-camera-caption="${id}" maxlength="${MAX_CAPTION}" placeholder="Write a caption" aria-label="Caption" value="${escapeHtml(s.caption)}">` +
          `<span class="polaroid-label">${escapeHtml(shotLabel(s))}</span>` +
          '</figcaption>' +
          `<button type="button" class="polaroid-discard${armed ? ' armed' : ''}" data-camera-discard="${id}">${armed ? 'THROW IT AWAY?' : '🗑'}</button>` +
          '</figure>',
      );
    }
    parts.push('</div>');
  }
  parts.push(`<div class="camera-count">${shots.length} of ${ROLL_MAX} · the oldest goes when the roll is full</div>`);
  return parts.join('');
}

async function paint(host: HTMLElement, focusShot?: string): Promise<void> {
  if (!host.classList.contains('active')) return;
  const seq = ++paintSeq;
  const shots = await listShots();
  if (seq !== paintSeq) return; // a newer paint is on its way
  // Object URLs only for the shots still on the roll.
  const live = new Set(shots.map((s) => s.id));
  for (const [id, url] of urls) {
    if (!live.has(id)) {
      URL.revokeObjectURL(url);
      urls.delete(id);
    }
  }
  if (armedDiscard && !live.has(armedDiscard)) armedDiscard = null;
  // Keep a caption being typed, and the caret, across the repaint.
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement && host.contains(active) && active.dataset.cameraCaption
    ? { id: active.dataset.cameraCaption, value: active.value, start: active.selectionStart, end: active.selectionEnd }
    : null;
  host.innerHTML = cameraAppHtml(shots, { notice, lasting: rollIsLasting(), armed: armedDiscard, urlOf: urlFor });
  const box = (id: string) =>
    [...host.querySelectorAll<HTMLInputElement>('input[data-camera-caption]')].find((el) => el.dataset.cameraCaption === id) ?? null;
  if (typing) {
    const el = box(typing.id);
    if (el) {
      el.value = typing.value;
      el.focus({ preventScroll: true });
      el.setSelectionRange(typing.start, typing.end);
    }
  } else if (focusShot) {
    const el = box(focusShot);
    el?.focus({ preventScroll: false });
  }
}

function saveCaption(input: HTMLInputElement): void {
  const id = input.dataset.cameraCaption;
  if (!id) return;
  const text = cleanCaption(input.value);
  void setCaption(id, text);
}

function wire(host: HTMLElement): void {
  if (wiredHost === host) return;
  wiredHost = host;
  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.closest('[data-camera-shoot]')) {
      // Kept from the phone's own click handler (main.ts), which would read
      // the phone slid away under the press as put away and bring it back
      // up (the IR blaster's AIM, tvUI.ts).
      e.stopPropagation();
      notice = '';
      appDeps?.shoot();
      return;
    }
    const zoom = t.closest<HTMLElement>('[data-camera-zoom]');
    if (zoom) {
      zoom.closest('figure')?.classList.toggle('big');
      return;
    }
    const discard = t.closest<HTMLElement>('[data-camera-discard]');
    if (discard?.dataset.cameraDiscard) {
      const id = discard.dataset.cameraDiscard;
      if (armedDiscard === id) {
        armedDiscard = null;
        void removeShot(id);
      } else {
        armedDiscard = id;
        void paint(host);
      }
    }
  });
  host.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.dataset.cameraCaption) saveCaption(t);
  });
  host.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.dataset.cameraCaption) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      saveCaption(t);
      t.blur();
    }
  });
}

/** Paint the CAMERA view, and keep it painted while it is open. */
export function renderCameraApp(host: HTMLElement, deps: CameraAppDeps, open: CameraAppOpen = {}): void {
  appDeps = deps;
  notice = open.notice ?? '';
  armedDiscard = null;
  wire(host);
  unsubscribe ??= onRollChange(() => {
    if (wiredHost) void paint(wiredHost);
  });
  void paint(host, open.focusShot);
}

/** Test hook. */
export function resetCameraForTest(): void {
  viewfinding = false;
  busy = false;
  onShoot = null;
}
