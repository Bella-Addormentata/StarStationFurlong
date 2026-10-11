/**
 * 🕹️ The arcade cabinet's emulator core: one jsnes NES (Apache-2.0), fed a
 * ROM, stepped on a fixed 60.1 Hz clock from whatever frame time the render
 * loop hands it, and pressed by buttons.
 *
 * No DOM here, so it runs in vitest: arcadeLibrary.test.ts boots every
 * bundled ROM through this class. The cabinet UI (arcadeCabinet.ts) owns
 * input, painting and sound.
 *
 * Two ways to drive it. A private game (your own cartridge) uses step() and
 * press()/release(): wall-clock paced, buttons as they happen. A shared game
 * (arcadeSession.ts) uses runFrame(), one frame at a time with both pads set
 * from bytes, because every copy in the room must see the same buttons on the
 * same frame. jsnes is deterministic: the same ROM and the same pad bytes per
 * frame give the same game on every machine, whatever its audio sample rate
 * (arcadeNet.test.ts pins this), and saveState()/loadState() carry a game to
 * a copy that joins late.
 */

import { Controller, NES } from 'jsnes';

export type NesButton = 'A' | 'B' | 'SELECT' | 'START' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
export type NesPlayer = 1 | 2;

const BUTTON: Record<NesButton, 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7> = {
  A: Controller.BUTTON_A,
  B: Controller.BUTTON_B,
  SELECT: Controller.BUTTON_SELECT,
  START: Controller.BUTTON_START,
  UP: Controller.BUTTON_UP,
  DOWN: Controller.BUTTON_DOWN,
  LEFT: Controller.BUTTON_LEFT,
  RIGHT: Controller.BUTTON_RIGHT,
};

/** The NES's NTSC frame rate. */
export const NES_FPS = 60.0988;
const FRAME_S = 1 / NES_FPS;
/** At most this many emulated frames per render frame: a hitch slows the
 *  game down for a moment instead of fast-forwarding it. */
const MAX_FRAMES_PER_STEP = 3;

export type LoadResult = { ok: true } | { ok: false; reason: string };

/** A saved console (jsnes's own save-state tree). */
export type MachineState = ReturnType<NES['toJSON']>;

/** The jsnes internals the netplay checks reach (not in its .d.ts). */
interface NesInternals {
  cpu: { mem: Uint8Array };
  ppu: { spriteMem: Uint8Array };
  papu: { sampleRate: number; sampleTimerMax: number };
}
const internals = (nes: NES): NesInternals => nes as unknown as NesInternals;

/** jsnes's NTSC CPU clock, for the audio sample timer (papu/index.js). */
const CPU_FREQ_NTSC = 1789772.5;

export interface ArcadeMachineOptions {
  /** Audio sample rate the emulator generates at (the speaker's rate). */
  sampleRate?: number;
  /** Each stereo sample, -1..1. Omit to run silent (tests, no AudioContext). */
  onAudioSample?: (left: number, right: number) => void;
}

export class ArcadeMachine {
  private nes: NES | null = null;
  private frame: Uint32Array | null = null;
  private acc = 0;
  private held = new Set<string>();

  constructor(private readonly opts: ArcadeMachineOptions = {}) {}

  /** Load a ROM into a fresh console. jsnes refuses what it can't run
   *  (bad header, unsupported mapper) by throwing; that becomes `reason`. */
  load(bytes: Uint8Array): LoadResult {
    this.stop();
    const nes = new NES({
      onFrame: (buffer) => {
        this.frame = buffer;
      },
      onAudioSample: this.opts.onAudioSample,
      emulateSound: !!this.opts.onAudioSample,
      sampleRate: this.opts.sampleRate ?? 48000,
    });
    try {
      nes.loadROM(bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: /mapper/i.test(message) ? 'THIS CARTRIDGE TYPE IS NOT SUPPORTED' : 'CARTRIDGE WOULD NOT LOAD' };
    }
    this.nes = nes;
    return { ok: true };
  }

  get running(): boolean {
    return this.nes !== null;
  }

  /**
   * Advance by `dt` seconds of wall time. Returns how many NES frames ran
   * (0 while nothing is loaded). A throw from the emulator mid-frame stops
   * the machine and is rethrown for the cabinet to report.
   */
  step(dt: number): number {
    const nes = this.nes;
    if (!nes) return 0;
    this.acc += Number.isFinite(dt) && dt > 0 ? dt : 0;
    let frames = 0;
    while (this.acc >= FRAME_S && frames < MAX_FRAMES_PER_STEP) {
      try {
        nes.frame();
      } catch (err) {
        this.stop();
        throw err;
      }
      this.acc -= FRAME_S;
      frames++;
    }
    // Still behind after the cap: drop the backlog rather than chase it.
    if (this.acc >= FRAME_S) this.acc = 0;
    return frames;
  }

  /** The latest finished frame (256×240, 0xBBGGRR), or null before one. */
  frameBuffer(): Uint32Array | null {
    return this.frame;
  }

  press(player: NesPlayer, button: NesButton): void {
    const key = `${player}:${button}`;
    if (!this.nes || this.held.has(key)) return;
    this.held.add(key);
    this.nes.buttonDown(player, BUTTON[button]);
  }

  release(player: NesPlayer, button: NesButton): void {
    const key = `${player}:${button}`;
    if (!this.held.delete(key)) return;
    this.nes?.buttonUp(player, BUTTON[button]);
  }

  /** Let go of everything (window blur, back to the menu). */
  releaseAll(): void {
    for (const key of [...this.held]) {
      const [player, button] = key.split(':') as [string, NesButton];
      this.release(Number(player) as NesPlayer, button);
    }
  }

  // ── Shared games (arcadeSession.ts) ───────────────────────────────────────

  /**
   * Run exactly one frame with both pads set from bytes (bit n = jsnes
   * button n: A, B, SELECT, START, UP, DOWN, LEFT, RIGHT). Every bit is set
   * every frame, so the pads depend only on these bytes, never on what was
   * pressed before or on a loaded state. Throws like step() does.
   */
  runFrame(p1: number, p2: number): void {
    const nes = this.nes;
    if (!nes) return;
    for (let bit = 0; bit < 8; bit++) {
      const button = bit as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
      if (p1 & (1 << bit)) nes.buttonDown(1, button);
      else nes.buttonUp(1, button);
      if (p2 & (1 << bit)) nes.buttonDown(2, button);
      else nes.buttonUp(2, button);
    }
    try {
      nes.frame();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  /** The whole console as a jsnes save state, or null with nothing loaded. */
  saveState(): MachineState | null {
    return this.nes ? this.nes.toJSON() : null;
  }

  /**
   * Continue from a save state (the same ROM must be loaded). The audio
   * sample rate is this machine's own, not the saver's: it only paces the
   * sound, never the game.
   */
  loadState(state: MachineState): void {
    const nes = this.nes;
    if (!nes) return;
    const rate = internals(nes).papu.sampleRate;
    nes.fromJSON(state);
    this.applySampleRate(nes, rate);
    this.acc = 0;
    this.frame = null; // the old picture isn't this state's: wait for its first frame
  }

  /** Re-time the sound for another output rate (a speaker that came later). */
  setSampleRate(rate: number): void {
    if (this.nes && Number.isFinite(rate) && rate > 0) this.applySampleRate(this.nes, rate);
  }

  private applySampleRate(nes: NES, rate: number): void {
    const papu = internals(nes).papu;
    papu.sampleRate = rate;
    papu.sampleTimerMax = Math.floor((1024.0 * CPU_FREQ_NTSC) / rate);
  }

  /**
   * A 6-bit fingerprint of the game's state: work RAM and sprite memory.
   * Copies in step compare these to catch a copy that has drifted.
   */
  check(): number {
    const nes = this.nes;
    if (!nes) return 0;
    const { cpu, ppu } = internals(nes);
    let h = 0x811c9dc5;
    for (let i = 0; i < 0x800; i++) h = Math.imul(h ^ cpu.mem[i], 0x01000193);
    for (let i = 0; i < 0x100; i++) h = Math.imul(h ^ ppu.spriteMem[i], 0x01000193);
    return (h ^ (h >>> 6) ^ (h >>> 12) ^ (h >>> 18) ^ (h >>> 24)) & 0x3f;
  }

  /** A ROM's power-on state: what a compact save state is measured against. */
  static bootState(bytes: Uint8Array): MachineState | null {
    const machine = new ArcadeMachine();
    return machine.load(bytes).ok ? machine.saveState() : null;
  }

  /** Power off: the next load starts a fresh console. */
  stop(): void {
    this.held.clear();
    this.nes = null;
    this.frame = null;
    this.acc = 0;
  }
}
