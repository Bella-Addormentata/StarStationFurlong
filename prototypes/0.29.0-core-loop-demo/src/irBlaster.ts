/**
 * 📡 The SpacePhone's IR blaster (#258): the little glow at the phone's tip
 * on every press of the remote, and 🎯 AIM — the phone slides down until
 * only its tip shows, the pointer becomes a crosshair, and the next TV
 * clicked is the one the blaster drives (main.ts routes that click; a click
 * on a TV aims at it whether or not AIM was pressed). Escape, a click on
 * anything else, or the phone opened by any other path puts the blaster
 * down again.
 *
 * DOM only: what a press does is tvUI's and tvDoc's.
 */

const PHONE_ID = 'spacephone-container';
const EMITTER_ID = 'phone-ir-emitter';
const SUBTITLE_ID = 'phone-app-subtitle';
const AIMING_LINE = 'AIMING · CLICK A TV · ESC STOPS';

/** The glow at the tip, once per press: a press during the last glow
 *  starts it over. */
export function irBlink(): void {
  const el = document.getElementById(EMITTER_ID);
  if (!el) return;
  el.classList.remove('firing');
  void el.offsetWidth; // a new animation, not the one still running
  el.classList.add('firing');
}

let aiming = false;
let subtitleBefore: string | null = null;
let watcher: MutationObserver | null = null;

const onKey = (e: KeyboardEvent): void => {
  if (!aiming || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  stopAiming();
};

export function isAiming(): boolean {
  return aiming;
}

/** 🎯 AIM: the phone down to its tip, glowing, and a crosshair over the
 *  room until a TV is clicked. */
export function startAiming(): void {
  const phone = document.getElementById(PHONE_ID);
  if (!phone) return;
  // A control left focused in a phone slid away would take the next key.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && phone.contains(focused)) focused.blur();
  aiming = true;
  phone.classList.remove('active');
  phone.classList.add('aiming');
  document.body.classList.add('ir-aiming');
  const subtitle = document.getElementById(SUBTITLE_ID);
  if (subtitle) {
    subtitleBefore ??= subtitle.textContent;
    subtitle.textContent = AIMING_LINE;
  }
  window.addEventListener('keydown', onKey, true);
  // Opened again by any path (Tab, the bezel, a TV clicked, Enter's quick
  // chat raising it a sliver): done aiming.
  watcher ??= new MutationObserver(() => {
    if (aiming && (phone.classList.contains('active') || phone.classList.contains('peek'))) stopAiming();
  });
  watcher.observe(phone, { attributes: true, attributeFilter: ['class'] });
}

export function stopAiming(): void {
  if (!aiming) return;
  aiming = false;
  document.getElementById(PHONE_ID)?.classList.remove('aiming');
  document.body.classList.remove('ir-aiming');
  const subtitle = document.getElementById(SUBTITLE_ID);
  // Given back only if nothing wrote over it: a phone opened on another
  // view has that view's line by now.
  if (subtitle && subtitleBefore !== null && subtitle.textContent === AIMING_LINE) subtitle.textContent = subtitleBefore;
  subtitleBefore = null;
  window.removeEventListener('keydown', onKey, true);
  watcher?.disconnect();
}
