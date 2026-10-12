/**
 * 🕹🕹🕹🕹 The lockstep spike's harness (#193, the four-player cabinet) —
 * lockstep-spike.html, served by the dev server only.
 *
 * Up to four emulator frames, mounted as the cabinet mounts them, each one
 * SEAT of the same game (role 'peer', public/arcade/frame.html): every seat
 * runs the game, plays its own player's buttons a fixed `delay` frames late,
 * and runs a frame only once every other seat's buttons for it are in hand.
 * Every seat starts held; once every seat has started, seat 0 begins an
 * EPOCH — saves its state, which the others load — and lockstep begins at
 * that frame. With `reepoch`, every that many seconds the next seat in turn
 * begins a new epoch from where the game stands, the others loading it
 * again (what the room does when a player comes or goes). This page stands
 * in for the mesh between them: each batch is packed to the wire format and
 * unpacked again, per link, optionally late and jittered.
 *
 * What it measures: whether every seat's state hashes agree frame for frame
 * (the LockstepLedger), how often a seat had to hold a frame for another's
 * buttons (a stutter on screen) at a given delay and latency, and what each
 * seat sends.
 *
 * Query parameters (all optional): seats (4), delay (frames; 8), latency
 * and jitter (ms, one way per link; 0), batchFrames (3), hashEvery (60),
 * reepoch (seconds between epochs; 0, never), bot (0 turns the random
 * presses off), seed, core (nes), rom (/emulatorjs/roms/lj65.nes). Seats, delay, batchFrames and hashEvery
 * are whole numbers, clamped to seats 1–4, delay 1–600, batchFrames
 * 1–600 and hashEvery 10–3600 (a hash every frame or two, beside a batch
 * every frame, would pass a seat's message budget): the seats run with,
 * and the stats report, the same settings.
 *
 * window.__lockstepSpike.stats() returns the numbers
 * (scripts/arcade-replay-spike.mjs --page lockstep-spike.html prints them).
 */

import { emulatorDataPath, mountEmulatorFrame } from './arcadeEmulator';
import type { EmulatorEvent, EmulatorHandle, ReplayStatus } from './arcadeEmulator';
import type { ArcadeCore } from './arcadeDoc';
import { batchRows, LockstepLedger, packInputBatch, ReplayReassembler, unpackInputBatch } from './arcadeReplay';
import type { ReplayBatch, ReplaySnapshot } from './arcadeReplay';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? v : d;
};
/** A whole number within [min, max]. The frame would truncate a fraction
 *  and put its own default in for anything below 1, so the page settles
 *  them first rather than report settings no seat ran with. */
const int = (k: string, d: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(num(k, d))));
const seats = int('seats', 4, 1, 4);
const delay = int('delay', 8, 1, 600);
const latencyMs = num('latency', 0);
const jitterMs = num('jitter', 0);
const batchFrames = int('batchFrames', 3, 1, 600);
const hashEvery = int('hashEvery', 60, 10, 3600);
const reepochSeconds = Math.max(0, num('reepoch', 0));
const botOn = q.get('bot') !== '0';
const core = (q.get('core') ?? 'nes') as ArcadeCore;
const romUrl = q.get('rom') ?? '/emulatorjs/roms/lj65.nes';

/** mulberry32: presses repeat for a seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seed = num('seed', 193);
const netRandom = rng(seed ^ 0x5eed);

interface SeatStats {
  started: boolean;
  status: ReplayStatus | null;
  batches: number;
  inputs: number;
  wireBytes: number;
  messages: number;
  presses: number;
}

const ledger = new LockstepLedger(seats);
/** Hashes are compared per epoch: a seat that ran past where the next
 *  epoch began runs those frames again from its state. */
const EPOCH_FRAMES = 1e9;
const stats = {
  startedAt: 0,
  lockstepAt: 0,
  /** The frame lockstep began at (seat 0's save state). */
  lockFrame: 0,
  /** Epochs begun, and the seats that began them. */
  epochs: [] as Array<{ nonce: string; anchor: number; frame: number }>,
  reepochSeconds,
  seats,
  delay,
  latencyMs,
  jitterMs,
  batchFrames,
  snapshotBytes: 0,
  loads: [] as Array<{ seat: number; frame: number; matches: boolean | undefined; tries: number | undefined }>,
  perSeat: Array.from({ length: seats }, (): SeatStats => ({ started: false, status: null, batches: 0, inputs: 0, wireBytes: 0, messages: 0, presses: 0 })),
  /** The longest stretch, in ms, without a new comparison, from the moment
   *  every seat has started: seats that froze partway, or a lockstep that
   *  never got going, stop comparing, which no mismatch would show
   *  (stats() counts the stretch still running too). */
  longestGapMs: 0,
  errors: [] as string[],
};
/** When the current stretch without a comparison began: the moment every
 *  seat had started, then each comparison (0: not every seat has). */
let gapFrom = 0;

const frames: Array<EmulatorHandle | null> = Array.from({ length: seats }, () => null);
const allSeats = Array.from({ length: seats }, (_, k) => k);
/** One reassembler per link (from → to) for the epoch running: batches
 *  back in frame order, from the frame it began at. */
const freshLinks = () => Array.from({ length: seats }, () => Array.from({ length: seats }, () => new ReplayReassembler()));
let links = freshLinks();

/** The epoch running: its tag, its number, and the seat that began it. */
let epoch = { nonce: '', index: 0, anchor: 0 };

function forward(from: number, to: number, batches: ReplayBatch[]): void {
  const nonce = epoch.nonce;
  for (const b of batches) frames[to]?.send({ type: 'arcade-replay-inputs', nonce, seat: from, from: b.from, through: b.through, inputs: batchRows(b) });
}

/** The save state the epoch began from. Every seat waits for every other,
 *  so a seat whose load never landed can still start from it. */
let begun: ReplaySnapshot | null = null;
function sendBegun(to: number): void {
  const s = begun;
  if (!s) return;
  const state = s.state.slice();
  const nonce = epoch.nonce;
  deliver(() => frames[to]?.send({ type: 'arcade-replay-snapshot', nonce, seats: allSeats, frame: s.frame, state, held: s.held, hash: s.hash }, [state.buffer]));
}

/** Begin an epoch at `anchor`: its frame saves its state where it stands. */
function beginEpoch(anchor: number): void {
  epoch = { nonce: `e${epoch.index + 1}`, index: epoch.index + 1, anchor };
  links = freshLinks();
  begun = null;
  frames[anchor]?.send({ type: 'arcade-replay-begin', nonce: epoch.nonce, seats: allSeats });
}

function deliver(fn: () => void): void {
  const ms = Math.max(0, latencyMs + (netRandom() * 2 - 1) * jitterMs);
  if (ms === 0) fn();
  else window.setTimeout(fn, ms);
}

async function fetchRom(): Promise<Blob> {
  const res = await fetch(romUrl);
  if (!res.ok) throw new Error(`${romUrl}: HTTP ${res.status}`);
  return res.blob();
}

function onSeat(seat: number, ev: EmulatorEvent): void {
  const me = stats.perSeat[seat]!;
  if (ev.type !== 'frame-ready' && ev.type !== 'ready') me.messages += 1;
  switch (ev.type) {
    case 'started':
      me.started = true;
      if (seat === 0) stats.startedAt = performance.now();
      if (botOn) startBot(seat);
      // Every seat in: seat 0 begins the first epoch, and lockstep begins there.
      if (stats.perSeat.every((s) => s.started)) {
        if (!gapFrom) gapFrom = performance.now();
        beginEpoch(0);
        if (reepochSeconds > 0) {
          window.setInterval(() => beginEpoch((epoch.anchor + 1) % seats), reepochSeconds * 1000);
        }
      }
      break;
    case 'replay-inputs': {
      // A batch of an epoch since replaced is nobody's now.
      if (ev.nonce !== epoch.nonce) break;
      const bytes = packInputBatch(ev.batch);
      me.batches += 1;
      me.inputs += ev.batch.inputs.length;
      me.wireBytes += bytes.byteLength;
      for (let to = 0; to < seats; to++) {
        if (to === seat) continue;
        const nonce = epoch.nonce;
        deliver(() => {
          const batch = unpackInputBatch(bytes);
          if (!batch || nonce !== epoch.nonce) return;
          forward(seat, to, links[seat]![to]!.push(batch));
        });
      }
      break;
    }
    case 'replay-snapshot': {
      if (ev.nonce !== epoch.nonce || seat !== epoch.anchor) break;
      const s = ev.snapshot;
      if (!stats.lockstepAt) stats.lockstepAt = performance.now();
      if (stats.epochs.length === 0) stats.lockFrame = s.frame; // the first epoch's, which may be frame 0
      stats.snapshotBytes = s.state.byteLength;
      stats.epochs.push({ nonce: epoch.nonce, anchor: seat, frame: s.frame });
      // Every seat's batches start at this frame.
      for (let from = 0; from < seats; from++) {
        for (let to = 0; to < seats; to++) if (to !== from) forward(from, to, links[from]![to]!.start(s.frame));
      }
      begun = s;
      for (let to = 0; to < seats; to++) if (to !== seat) sendBegun(to);
      break;
    }
    case 'replay-hash': {
      // Compared within an epoch (EPOCH_FRAMES): a seat that ran past where
      // the next one began runs those frames again, on other buttons.
      if (ev.nonce !== epoch.nonce) break;
      if (ledger.record(seat, epoch.index * EPOCH_FRAMES + ev.hash.frame, ev.hash.hash) !== null) {
        const now = performance.now();
        stats.longestGapMs = Math.max(stats.longestGapMs, now - (gapFrom || now));
        gapFrom = now;
      }
      break;
    }
    case 'replay-status': {
      const st = ev.status;
      if (st.phase === 'unsupported') stats.errors.push(`seat ${seat}: cannot replay (no save states)`);
      if (st.loaded !== undefined) stats.loads.push({ seat, frame: st.loaded, matches: st.matches, tries: st.tries });
      // A load that never landed: the seat holds; hand it the save state again.
      if (st.loaded !== undefined && st.matches === false && st.nonce === epoch.nonce) sendBegun(seat);
      me.status = st;
      break;
    }
    case 'error':
      stats.errors.push(`seat ${seat}: ${ev.why}`);
      break;
    default:
      break;
  }
}

/** NES-shaped presses on each seat's own pad. Seat 0 also works the menus
 *  (START through the title, then a pause-and-resume pair now and then). */
const BOT_BUTTONS = [4, 5, 6, 7, 8, 0, 8, 0];
const START = 3;
function startBot(seat: number): void {
  const random = rng(seed + seat * 7919);
  const tap = (index: number, holdMs: number) => {
    frames[seat]?.send({ type: 'arcade-replay-press', player: 0, index, value: 1 });
    stats.perSeat[seat]!.presses += 1;
    window.setTimeout(() => frames[seat]?.send({ type: 'arcade-replay-press', player: 0, index, value: 0 }), holdMs);
  };
  const press = () => {
    tap(BOT_BUTTONS[Math.floor(random() * BOT_BUTTONS.length)]!, 40 + random() * 260);
    window.setTimeout(press, 60 + random() * 500);
  };
  if (seat === 0) {
    for (const at of [1_500, 3_000, 4_500]) window.setTimeout(() => tap(START, 100), at);
    window.setInterval(() => {
      tap(START, 100);
      window.setTimeout(() => tap(START, 100), 700);
    }, 25_000);
  }
  window.setTimeout(press, 6_000);
}

async function mountSeat(seat: number, game: Blob): Promise<void> {
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `<p>SEAT ${seat + 1}${seat === 0 ? ' (begins the first epoch)' : ''}</p><div class="screen"></div>`;
  document.getElementById('seats')!.append(pane);
  frames[seat] = mountEmulatorFrame(pane.querySelector('.screen') as HTMLElement, {
    core,
    game,
    gameName: romUrl.split('/').pop() ?? 'game',
    pathToData: emulatorDataPath('station'),
    volume: 0,
    isolated: false,
    allowOrigins: [],
    replay: { role: 'peer', seat, seats, delay, batchFrames, hashEvery },
  }, (ev) => onSeat(seat, ev));
}

function render(): void {
  const d = ledger.read();
  const elapsed = stats.startedAt ? (performance.now() - stats.startedAt) / 1000 : 0;
  const lines = [
    `elapsed ${elapsed.toFixed(0)} s · ${seats} seats · delay ${delay} frames · latency ${latencyMs} ± ${jitterMs} ms · epoch ${epoch.index} (seat ${epoch.anchor + 1})`,
    `hashes compared ${d.compared} · matched ${d.matched} · mismatched ${d.mismatched}${d.firstMismatch !== null ? ` (first at frame ${d.firstMismatch})` : ''}`,
    ...stats.perSeat.map((p, i) => `seat ${i + 1}: ${p.status?.phase ?? '—'} @ ${p.status?.frame ?? '—'} · stalls ${p.status?.stalls ?? 0} · frames held ${p.status?.waits ?? 0} · ${p.inputs} inputs in ${p.batches} batches`),
    stats.errors.length ? `errors: ${stats.errors.join('; ')}` : '',
  ];
  document.getElementById('stats')!.textContent = lines.filter(Boolean).join('\n');
}

// The harness's own failures count against the run, as on the replay
// spike's page (the frames' windows are their own).
window.addEventListener('error', (e) => stats.errors.push(`page: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => stats.errors.push(`page: ${String(e.reason)}`));

(window as unknown as { __lockstepSpike: unknown }).__lockstepSpike = {
  stats: () => ({
    ...stats,
    hashEvery,
    longestGapMs: Math.round(Math.max(stats.longestGapMs, gapFrom ? performance.now() - gapFrom : 0)),
    lockSeconds: stats.lockstepAt ? (performance.now() - stats.lockstepAt) / 1000 : 0,
    drift: ledger.read(),
  }),
};

void (async () => {
  try {
    const game = await fetchRom();
    for (let seat = 0; seat < seats; seat++) await mountSeat(seat, game);
  } catch (err) {
    stats.errors.push(String(err));
  }
})();
window.setInterval(render, 1000);
