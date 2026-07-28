/**
 * 🤖🔊 Robot voice — robot lines speak ALOUD through the device speakers via
 * the browser's built-in SpeechSynthesis, alongside the existing overhead
 * bubbles (#77 small talk). Zero dependencies, fully offline.
 *
 * ONE seam: every robot line flows through World.robotSay (world.ts), which
 * pairs the overhead bubble with a speakRobotLine call — new speech sources
 * (small talk, drink offers, future narrators) wire there once and inherit
 * bubble + voice together.
 *
 * THE voice (owner ruling: one style, ENGLISH, soft): a female English voice
 * pitched up and slowed a touch. (JP/KR engines were tried and rejected —
 * they read English loanword-style, which hears as the wrong language.)
 * Resolution: preferred names → any en-* voice → platform default. The dock
 * console's VOICE row is a plain ON/OFF.
 *
 * SPATIALITY without WebAudio: SpeechSynthesis gives no AudioNode to pan, so
 * distance is expressed through utterance.volume alone — full within
 * NEAR_RANGE of the local player, fading linearly to silence at FAR_RANGE
 * (lines beyond it are skipped, the bubble still shows). Volume is sampled at
 * speak time; a 6 s utterance doesn't track a walking player, which reads
 * fine at these ranges.
 *
 * QUEUE DISCIPLINE: SpeechSynthesis is one global FIFO — with the croupier
 * beating every few seconds a burst would back the queue up and lines would
 * play long after their bubble faded. So at most ONE utterance may be waiting
 * behind the current one; busier moments drop the line (bubble-only), never
 * queue it.
 *
 * The toggle persists per-install (localStorage, like the bootstrap address).
 * Browsers gate audio behind a first user gesture — any click in the session
 * satisfies it, so the game never hits the block in practice.
 */

import { clamp } from './utils';

const NEAR_RANGE = 4; // full volume within this distance (m)
const FAR_RANGE = 14; // silent beyond this (m) — a bit over a room's span
/** Soft delivery: pitched up, unhurried. */
const PITCH = 1.45;
const RATE = 0.92;
const STORAGE_KEY = 'ssf-robot-voice';
/** Soft English female voices, best first (macOS names; other OSes fall
 *  through to any en-* voice below). */
const PREFERRED_NAMES = ['Samantha', 'Karen', 'Moira', 'Martha', 'Tessa'];
/** Bubbles keep their emoji (🎲 Place your bets!) but the engine must not
 *  read them aloud ("game die place your bets") — spoken form only. */
const PICTOGRAPH_RE = /[\p{Extended_Pictographic}️]/gu;

interface VoiceDeps {
  /** Local player world position (null while no world — line is skipped). */
  localPos: () => { x: number; z: number } | null;
}

let deps: VoiceDeps | null = null;
let enabled = true;
let cachedVoice: SpeechSynthesisVoice | null = null;
/** True once resolution ran against a LOADED voice list — caches the null
 *  outcome too (no en-* voice installed), so lines don't rescan per call. */
let voiceResolved = false;

try {
  enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
} catch {
  // Privacy mode — session-scoped default stays on.
}

export function initRobotVoice(d: VoiceDeps): void {
  deps = d;
}

export function isRobotVoiceEnabled(): boolean {
  return enabled;
}

export function setRobotVoiceEnabled(on: boolean): void {
  enabled = on;
  if (!on && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Session-scoped is fine.
  }
}

/** Lazily resolve the voice (voice lists load async and differ per OS). An
 *  empty list means "not loaded yet" — the only case worth retrying. */
function pickVoice(): SpeechSynthesisVoice | null {
  if (voiceResolved) return cachedVoice;
  const all = window.speechSynthesis.getVoices();
  if (!all.length) return null;
  cachedVoice =
    all.find((v) => PREFERRED_NAMES.includes(v.name)) ??
    all.find((v) => v.lang.startsWith('en')) ??
    null;
  voiceResolved = true;
  return cachedVoice;
}

/** Speak a robot line from world point (x, z). Call it right beside the
 *  line's spawnFixedBubble — the bubble is the source of truth, the voice is
 *  best-effort (off / out of range / queue-full lines drop silently). */
export function speakRobotLine(text: string, x: number, z: number): void {
  if (!enabled || !('speechSynthesis' in window)) return;
  const p = deps?.localPos();
  if (!p) return;
  const dist = Math.hypot(x - p.x, z - p.z);
  if (dist >= FAR_RANGE) return;
  const synth = window.speechSynthesis;
  // `pending` counts only utterances queued BEHIND the one being spoken — a
  // speaking synth with an empty queue reports pending=false (verified in
  // Chromium). So this admits exactly ONE waiter: a line may queue behind the
  // current utterance, and drops once that waiter slot is taken.
  if (synth.pending) return;

  const spoken = text.replace(PICTOGRAPH_RE, '').trim();
  if (!spoken) return;
  const u = new SpeechSynthesisUtterance(spoken);
  const v = pickVoice();
  if (v) u.voice = v;
  // The text is English — pin the lang so a non-default voice never guesses.
  u.lang = 'en-US';
  u.pitch = PITCH;
  u.rate = RATE;
  u.volume = clamp(1 - (dist - NEAR_RANGE) / (FAR_RANGE - NEAR_RANGE), 0, 1);
  synth.speak(u);
}
