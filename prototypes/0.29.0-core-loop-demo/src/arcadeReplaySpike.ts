/**
 * 🕹👀 The input-replay spike's harness (#193) — replay-spike.html, served by
 * the dev server only (it is not an entry of the production build).
 *
 * It mounts two emulator frames exactly as the cabinet does
 * (mountEmulatorFrame: a sandboxed opaque-origin frame inside its wall):
 * player one's ('source') and a spectator's ('follower'), and stands in for
 * the network between them — every batch is packed to the wire format and
 * unpacked again, optionally late and jittered — so what it measures is
 * what a spectator in the room would see:
 *
 *  - whether the follower's state hashes match player one's, frame for
 *    frame, over a long session (the DriftLedger);
 *  - what the input lane costs on the wire, and what a late joiner's save
 *    state costs;
 *  - how often the follower stalls waiting for input, and how far behind it
 *    runs.
 *
 * Query parameters (all optional): core (nes), rom (a same-origin URL;
 * default /emulatorjs/roms/lj65.nes, which nothing in the repository
 * provides), join (ms after player one starts before the spectator joins;
 * 3000), latency and jitter (ms, one way; 0), bot (0 turns the random
 * presses off), seed, hashEvery (60), lead (12), resync (1: on a mismatch,
 * hand the spectator a fresh save state), drop (the spectator never gets
 * player one's Nth input: the negative control, the ledger has to catch it).
 *
 * window.__replaySpike.stats() returns the numbers (scripts/arcade-replay-spike.mjs
 * drives this page in a headless browser and prints them).
 */

import { emulatorDataPath, mountEmulatorFrame } from './arcadeEmulator';
import type { EmulatorEvent, EmulatorHandle, ReplayStatus } from './arcadeEmulator';
import type { ArcadeCore } from './arcadeDoc';
import { batchRows, DriftLedger, packInputBatch, ReplayReassembler, unpackInputBatch } from './arcadeReplay';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? v : d;
};
const core = (q.get('core') ?? 'nes') as ArcadeCore;
const romUrl = q.get('rom') ?? '/emulatorjs/roms/lj65.nes';
const joinMs = num('join', 3000);
const latencyMs = num('latency', 0);
const jitterMs = num('jitter', 0);
const botOn = q.get('bot') !== '0';
const hashEvery = num('hashEvery', 60);
const lead = num('lead', 12);
const resync = q.get('resync') === '1';
const dropAt = num('drop', 0);

/** mulberry32: the bot's presses repeat for a seed. */
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
const random = rng(num('seed', 193));

const ledger = new DriftLedger();
/** The spectator's side of the lane: batches back in frame order. */
const reassembler = new ReplayReassembler();
const stats = {
  startedAt: 0,
  sourceStarted: false,
  followerStarted: false,
  batches: 0,
  inputs: 0,
  wireBytes: 0,
  snapshots: 0,
  snapshotBytes: 0,
  loads: [] as Array<{ frame: number; matches: boolean | undefined; tries: number | undefined; atMs: number }>,
  stalls: 0,
  presses: 0,
  sourceFrame: 0,
  follower: null as ReplayStatus | null,
  lagFrames: [] as number[],
  /** Distinct state hashes player one posted: a ledger that matched a
   *  handful of identical hashes would prove nothing. */
  distinctHashes: 0,
  dropped: null as { frame: number; index: number; value: number } | null,
  errors: [] as string[],
};
const seenHashes = new Set<string>();
/** Inputs delivered so far, for `drop`. */
let delivered = 0;

const el = (id: string) => document.getElementById(id) as HTMLElement;
let source: EmulatorHandle | null = null;
let follower: EmulatorHandle | null = null;

/** The network between them: after latency ± jitter, in order of arrival. */
function deliver(fn: () => void): void {
  const delay = Math.max(0, latencyMs + (random() * 2 - 1) * jitterMs);
  if (delay === 0) fn();
  else window.setTimeout(fn, delay);
}

async function fetchRom(): Promise<Blob> {
  const res = await fetch(romUrl);
  if (!res.ok) throw new Error(`${romUrl}: HTTP ${res.status}`);
  return res.blob();
}

function onSource(ev: EmulatorEvent): void {
  switch (ev.type) {
    case 'started':
      stats.sourceStarted = true;
      stats.startedAt = performance.now();
      if (botOn) startBot();
      window.setTimeout(mountFollower, joinMs);
      break;
    case 'replay-inputs': {
      const bytes = packInputBatch(ev.batch);
      stats.batches += 1;
      stats.inputs += ev.batch.inputs.length;
      stats.wireBytes += bytes.byteLength;
      stats.sourceFrame = ev.batch.through + 1;
      deliver(() => {
        const batch = unpackInputBatch(bytes);
        if (!batch) return;
        if (dropAt > 0 && delivered < dropAt && delivered + batch.inputs.length >= dropAt) {
          const [gone] = batch.inputs.splice(dropAt - delivered - 1, 1);
          if (gone) stats.dropped = { frame: gone.frame, index: gone.index, value: gone.value };
          delivered += 1;
        }
        delivered += batch.inputs.length;
        for (const b of reassembler.push(batch)) {
          follower?.send({ type: 'arcade-replay-inputs', from: b.from, through: b.through, inputs: batchRows(b) });
        }
      });
      break;
    }
    case 'replay-hash':
      ledger.sourceHash(ev.hash.frame, ev.hash.hash);
      if (seenHashes.size < 100_000) seenHashes.add(ev.hash.hash);
      stats.distinctHashes = seenHashes.size;
      break;
    case 'replay-snapshot': {
      const s = ev.snapshot;
      stats.snapshots += 1;
      stats.snapshotBytes += s.state.byteLength;
      // Late joiner: the save state goes first, then every batch after it
      // (the follower drops inputs stamped before the state's frame).
      deliver(() => follower?.send({ type: 'arcade-replay-snapshot', frame: s.frame, state: s.state, held: s.held, hash: s.hash }, [s.state.buffer]));
      break;
    }
    case 'error':
      stats.errors.push(`source: ${ev.why}`);
      break;
    default:
      break;
  }
  render();
}

function onFollower(ev: EmulatorEvent): void {
  switch (ev.type) {
    case 'started':
      stats.followerStarted = true;
      source?.send({ type: 'arcade-replay-want-snapshot' });
      break;
    case 'replay-hash': {
      const ok = ledger.followerHash(ev.hash.frame, ev.hash.hash);
      if (ok === false && resync) source?.send({ type: 'arcade-replay-want-snapshot' });
      break;
    }
    case 'replay-status': {
      const st = ev.status;
      if (st.phase === 'stalled' && stats.follower?.phase === 'running') stats.stalls += 1;
      if (st.loaded !== undefined) stats.loads.push({ frame: st.loaded, matches: st.matches, tries: st.tries, atMs: Math.round(performance.now() - stats.startedAt) });
      if (st.phase === 'running' && st.frame !== undefined) stats.lagFrames.push(stats.sourceFrame - st.frame);
      stats.follower = st;
      break;
    }
    case 'error':
      stats.errors.push(`follower: ${ev.why}`);
      break;
    default:
      break;
  }
  render();
}

/** NES-shaped presses: the d-pad, A and B at random. START has a schedule
 *  of its own (a random START mostly pauses the game, and a paused game is
 *  a weak test): a few through the title and menus, then a pair now and
 *  then — pause and resume in play, or out of a game-over screen. */
const BOT_BUTTONS = [4, 5, 6, 7, 8, 0, 8, 0];
const START = 3;
function startBot(): void {
  const tap = (index: number, holdMs: number) => {
    source?.send({ type: 'arcade-replay-press', player: 0, index, value: 1 });
    stats.presses += 1;
    window.setTimeout(() => source?.send({ type: 'arcade-replay-press', player: 0, index, value: 0 }), holdMs);
  };
  const press = () => {
    if (!source) return;
    tap(BOT_BUTTONS[Math.floor(random() * BOT_BUTTONS.length)]!, 40 + random() * 260);
    window.setTimeout(press, 60 + random() * 500);
  };
  for (const at of [1_500, 3_000, 4_500]) window.setTimeout(() => tap(START, 100), at);
  window.setInterval(() => {
    tap(START, 100);
    window.setTimeout(() => tap(START, 100), 700);
  }, 25_000);
  window.setTimeout(press, 6_000);
}

async function config(role: 'source' | 'follower') {
  return {
    core,
    game: await fetchRom(),
    gameName: romUrl.split('/').pop() ?? 'game',
    pathToData: emulatorDataPath('station'),
    volume: 0,
    isolated: false,
    allowOrigins: [],
    replay: { role, hashEvery, lead },
  };
}

async function mountFollower(): Promise<void> {
  follower = mountEmulatorFrame(el('follower'), await config('follower'), onFollower);
}

function render(): void {
  const d = ledger.read();
  const elapsed = stats.startedAt ? (performance.now() - stats.startedAt) / 1000 : 0;
  const lag = stats.lagFrames.slice(-20);
  el('stats').textContent = [
    `elapsed ${elapsed.toFixed(0)} s · source frame ${stats.sourceFrame} · follower ${stats.follower?.phase ?? '—'} @ ${stats.follower?.frame ?? '—'}`,
    `hashes compared ${d.compared} · matched ${d.matched} · mismatched ${d.mismatched}${d.firstMismatch !== null ? ` (first at frame ${d.firstMismatch})` : ''}`,
    `inputs ${stats.inputs} in ${stats.batches} batches · ${(stats.wireBytes / Math.max(1, elapsed)).toFixed(0)} B/s on the wire`,
    `save states ${stats.snapshots} · ${stats.snapshotBytes} B · loads ${stats.loads.map((l) => `${l.frame}${l.matches ? '✓' : '✗'}`).join(' ')}`,
    `stalls ${stats.stalls} · lag (frames, last ${lag.length}) ${lag.join(' ')}`,
    stats.dropped ? `dropped input: frame ${stats.dropped.frame}, index ${stats.dropped.index} = ${stats.dropped.value}` : '',
    stats.errors.length ? `errors: ${stats.errors.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

(window as unknown as { __replaySpike: unknown }).__replaySpike = {
  stats: () => ({ ...stats, drift: ledger.read(), lagFrames: stats.lagFrames.slice(-600) }),
};

void (async () => {
  try {
    source = mountEmulatorFrame(el('source'), await config('source'), onSource);
  } catch (err) {
    stats.errors.push(String(err));
    render();
  }
})();
window.setInterval(render, 1000);
