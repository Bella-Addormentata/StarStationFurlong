/**
 * 💬 Overhead chat bubbles — a message sent through the phone's CHAT app pops
 * up above the sender's avatar for a few seconds (owner request).
 *
 * ANCHORING (the S3 identity gap, solved without new wire): chat records carry
 * the author's PLAYER id, but remote avatars are keyed by tick-LANE id, and no
 * lane↔player mapping exists yet. So the sender stamps their WORLD POSITION
 * into the message (additive `atX`/`atZ` fields — legacy readers ignore them),
 * and the bubble anchors to the avatar NEAREST that spot: exact at send time,
 * and interpolation drift is far under the match radius. Our own messages
 * anchor to the local player directly. Legacy messages (no position) or a
 * position with no avatar nearby get no bubble — the chat app still shows them.
 *
 * RENDERING: plain DOM divs in a pointer-events-none overlay, repositioned per
 * frame by projecting the anchor's head point through the live camera (works
 * for both the ortho room view and the first-person perspective camera). One
 * bubble per avatar (a newer message replaces the old); ~6 s lifetime with a
 * fade; hidden at zoom ≥ 3 and for the LOCAL player in first person (you don't
 * see your own bubble from inside your head).
 */

import * as THREE from 'three';

const LIFETIME_MS = 6_000;
const FADE_MS = 600;
/** Max distance between the stamped send-position and an avatar to claim it. */
const MATCH_RADIUS = 3.0;
/** World-space anchor height above the avatar root (just over the head). */
const HEAD_Y = 2.7;
const MAX_TEXT = 90;

interface BubbleDeps {
  camera: () => THREE.Camera | null | undefined;
  localPos: () => { x: number; z: number } | null;
  remotes: () => Array<{ id: string; x: number; z: number }>;
  zoomLevel: () => number;
}

interface LiveBubble {
  el: HTMLDivElement;
  /** 'local', a remote avatar id, or a caller-supplied key for a fixed anchor. */
  anchorId: string;
  bornAt: number;
  fading: boolean;
  /** 🤖 #77B: a FIXED world point (the robot croupier isn't an avatar, so it
   *  can't be resolved through remotes()) — the bubble hangs over this spot. */
  fixed?: { x: number; z: number };
}

let deps: BubbleDeps | null = null;
let container: HTMLDivElement | null = null;
const bubbles = new Map<string, LiveBubble>();
const projected = new THREE.Vector3();

/** One-time overlay + deps wiring (idempotent; getters are live closures). */
export function initChatBubbles(d: BubbleDeps): void {
  deps = d;
  if (container) return;
  container = document.createElement('div');
  container.id = 'chat-bubbles-overlay';
  container.style.cssText = `
    position: fixed; inset: 0; pointer-events: none; z-index: 900;
    overflow: hidden;
  `;
  document.body.appendChild(container);
}

function removeBubble(anchorId: string): void {
  const b = bubbles.get(anchorId);
  if (!b) return;
  bubbles.delete(anchorId);
  b.el.remove();
}

/**
 * Pop a bubble for a chat message. `isSelf` anchors to the local player;
 * otherwise `atX`/`atZ` (the stamped send position) picks the nearest remote
 * avatar within MATCH_RADIUS. No resolvable anchor → no bubble (never an error).
 */
export function spawnChatBubble(text: string, isSelf: boolean, atX?: number, atZ?: number): void {
  if (!deps || !container) return;
  const clean = String(text ?? '').trim();
  if (!clean) return;

  let anchorId: string | null = null;
  if (isSelf) {
    anchorId = 'local';
  } else if (typeof atX === 'number' && typeof atZ === 'number' && Number.isFinite(atX) && Number.isFinite(atZ)) {
    let best: { id: string; d: number } | null = null;
    for (const r of deps.remotes()) {
      const d = Math.hypot(r.x - atX, r.z - atZ);
      if (d <= MATCH_RADIUS && (!best || d < best.d)) best = { id: r.id, d };
    }
    anchorId = best?.id ?? null;
  }
  if (!anchorId) return;

  removeBubble(anchorId); // a newer message replaces the old bubble
  const el = document.createElement('div');
  el.className = 'overhead-chat-bubble';
  el.textContent = clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
  container.appendChild(el);
  bubbles.set(anchorId, { el, anchorId, bornAt: performance.now(), fading: false });
}

/**
 * 🤖 #77B: pop a bubble anchored to a FIXED world point (the robot croupier at
 * the wheel-head). Same lifetime/projection as a chat bubble, but the anchor is
 * a stationary spot rather than an avatar — so it survives in first person and
 * needs no lane↔player resolution. `anchorId` keys it (a newer call replaces).
 */
export function spawnFixedBubble(anchorId: string, text: string, x: number, z: number): void {
  if (!deps || !container) return;
  const clean = String(text ?? '').trim();
  if (!clean || !Number.isFinite(x) || !Number.isFinite(z)) return;
  removeBubble(anchorId);
  const el = document.createElement('div');
  el.className = 'overhead-chat-bubble';
  el.textContent = clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
  container.appendChild(el);
  bubbles.set(anchorId, { el, anchorId, bornAt: performance.now(), fading: false, fixed: { x, z } });
}

/** Per-frame: reposition every bubble over its avatar's head; age + fade. */
export function updateChatBubbles(): void {
  if (!deps || bubbles.size === 0) return;
  const camera = deps.camera();
  const zoom = deps.zoomLevel();
  const now = performance.now();

  for (const [anchorId, b] of [...bubbles]) {
    // Lifetime.
    const age = now - b.bornAt;
    if (age > LIFETIME_MS + FADE_MS) { removeBubble(anchorId); continue; }
    if (age > LIFETIME_MS && !b.fading) {
      b.fading = true;
      b.el.style.transition = `opacity ${FADE_MS}ms`;
      b.el.style.opacity = '0';
    }

    // Anchor position (avatar may have left; a fixed anchor never moves).
    let pos: { x: number; z: number } | null = null;
    if (b.fixed) {
      pos = b.fixed; // 🤖 #77B robot croupier — visible even in first person
    } else if (anchorId === 'local') {
      pos = deps.localPos();
      if (zoom === 1) { b.el.style.display = 'none'; continue; } // inside own head
    } else {
      pos = deps.remotes().find((r) => r.id === anchorId) ?? null;
    }
    if (!pos || !camera || zoom >= 3) { b.el.style.display = 'none'; continue; }

    // World → screen.
    projected.set(pos.x, HEAD_Y, pos.z).project(camera);
    if (projected.z > 1 || projected.z < -1) { b.el.style.display = 'none'; continue; }
    const sx = (projected.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-projected.y * 0.5 + 0.5) * window.innerHeight;
    b.el.style.display = 'block';
    b.el.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
  }
}

/** Room swap: drop every bubble (their avatars belong to the previous room). */
export function clearChatBubbles(): void {
  for (const id of [...bubbles.keys()]) removeBubble(id);
}
