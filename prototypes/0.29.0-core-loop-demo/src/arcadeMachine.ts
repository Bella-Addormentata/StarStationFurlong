/**
 * 🕹️ The arcade cabinet's emulator core: one jsnes NES (Apache-2.0), fed a
 * ROM, stepped on a fixed 60.1 Hz clock from whatever frame time the render
 * loop hands it, and pressed by buttons.
 *
 * No DOM here, so it runs in vitest: arcadeLibrary.test.ts boots every
 * bundled ROM through this class. The cabinet UI (arcadeCabinet.ts) owns
 * input, painting and sound.
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

  /** Power off: the next load starts a fresh console. */
  stop(): void {
    this.held.clear();
    this.nes = null;
    this.frame = null;
    this.acc = 0;
  }
}
