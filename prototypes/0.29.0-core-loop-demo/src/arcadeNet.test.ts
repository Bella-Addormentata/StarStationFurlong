/**
 * 🕹️ Arcade netplay: the tick wire, the pad runs a copy rebuilds from lossy
 * ticks, the guest's pad on the host, and compact save states, against the
 * real emulator and bundled ROMs.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARCADE_GAMES } from './arcadeLibrary';
import { ArcadeMachine } from './arcadeMachine';
import {
  GuestPad, PadLog, PadRuns, PAD_BIT, decodeSnapshot, encodeSnapshot, frameAdd, frameDiff,
  isArcadeTickFlags, packArcadeTick, padByte, unpackArcadeTick, type ArcadeTick,
} from './arcadeNet';
import { packTick, tickKind, unpackTick, TICK_KIND_AH_MALLET } from './network/protocol';
import { MAX_SNAPSHOT_BYTES } from './games/arcade';
import { malletToTick } from './games/airHockey';

const rom = (id: string) =>
  new Uint8Array(readFileSync(new URL(`../public${ARCADE_GAMES.find((g) => g.id === id)!.romUrl}`, import.meta.url)));

/** A seeded pad script, like two players: each pad pair is held at least
 *  four frames (a fast tap is about that), then changes now and then. */
function script(frames: number, seed: number): Uint16Array {
  const out = new Uint16Array(frames);
  let s = seed >>> 0;
  let cur = 0;
  let held = 0;
  for (let f = 0; f < frames; f++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    if (++held >= 4 && (s >>> 16) % 6 === 0) {
      cur = (s >>> 4) & 0xf3f3; // never Select/Start: stay in the game…
      if (f % 240 < 8) cur |= PAD_BIT.START; // …but do press Start now and then
      held = 0;
    }
    out[f] = cur;
  }
  return out;
}

const frameHash = (m: ArcadeMachine) => {
  const buf = m.frameBuffer()!;
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i], 16777619);
  return h >>> 0;
};

describe('pad bytes', () => {
  it('use jsnes button numbering', () => {
    expect(padByte(['A', 'START', 'RIGHT'])).toBe(0b1000_1001);
    expect(padByte([])).toBe(0);
  });
});

describe('the arcade tick', () => {
  const ticks: ArcadeTick[] = [
    { type: 'frames', match: 0xbeef, frame: 0xfffe, cur: 0x81ff, run0: 17, prev: 0x0010, run1: 255, check: 0x2a },
    { type: 'guest', match: 7, token: 0x1234, cur: 0x90, prev: 0x10, changes: 255, seq: 65535 },
    { type: 'sync', match: 65535, nonce: 42 },
  ];

  it.each(ticks.map((t) => [t.type, t] as const))('%s round-trips through 13 bytes', (_type, t) => {
    const bytes = packArcadeTick(t);
    expect(bytes.byteLength).toBe(13);
    expect(isArcadeTickFlags(bytes[0])).toBe(true);
    expect(unpackArcadeTick(bytes)).toEqual(t);
  });

  it('reads as a mallet tick with a NaN position to a client that predates it', () => {
    for (const t of ticks) {
      const old = unpackTick(packArcadeTick(t));
      expect(tickKind(old.flags)).toBe(TICK_KIND_AH_MALLET);
      // airHockeySession.routeAirHockeyTick drops any tick whose x isn't finite.
      expect(Number.isFinite(old.x)).toBe(false);
    }
  });

  it('is never confused with a real mallet tick', () => {
    for (const down of [false, true]) {
      const mallet = packTick(malletToTick({ x: 1.5, z: -2, down, seq: 9 }));
      expect(isArcadeTickFlags(mallet[0])).toBe(false);
      expect(unpackArcadeTick(mallet)).toBeNull();
    }
  });

  it('refuses a newer wire version, a broken NaN box and match 0', () => {
    const good = packArcadeTick(ticks[0]);
    const version = good.slice();
    version[0] |= 0x04;
    expect(unpackArcadeTick(version)).toBeNull();
    const finite = good.slice();
    finite[4] = 0x3f;
    expect(unpackArcadeTick(finite)).toBeNull();
    expect(unpackArcadeTick(packArcadeTick({ type: 'sync', match: 0, nonce: 1 }))).toBeNull();
    expect(unpackArcadeTick(good.subarray(0, 12))).toBeNull();
  });
});

describe('u16 frame clock', () => {
  it('compares and steps across the wrap', () => {
    expect(frameDiff(2, 65534)).toBe(4);
    expect(frameDiff(65534, 2)).toBe(-4);
    expect(frameAdd(65535, 1)).toBe(0);
    expect(frameAdd(0, -1)).toBe(65535);
  });
});

describe('pad runs over a lossy lane', () => {
  /** Host runs `pads` from `start`, sending a FRAMES tick after each frame;
   *  `lose(i)` drops tick i. Returns the copy's log. */
  function relay(pads: Uint16Array, lose: (i: number) => boolean, start = 0): PadLog {
    const runs = new PadRuns();
    const log = new PadLog();
    pads.forEach((p, i) => {
      runs.record(frameAdd(start, i), p);
      if (!lose(i)) log.addTick(runs.tick()!);
    });
    return log;
  }

  it('rebuilds every frame from the runs, even with a quarter of the ticks lost', () => {
    const pads = script(3000, 3);
    let s = 99;
    const log = relay(pads, () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) % 4 === 0);
    expect(log.run(0)).toBe(3000);
    pads.forEach((p, f) => expect(log.get(f)).toBe(p));
  });

  it('leaves a gap it cannot fill (a burst longer than two runs) unknown', () => {
    const pads = new Uint16Array(60);
    for (let f = 0; f < 60; f++) pads[f] = f < 10 ? 0 : f < 12 ? 1 : f < 14 ? 2 : f < 16 ? 3 : 4;
    // Lose ticks 9–40: the runs of 1 and 2 are never heard.
    const log = relay(pads, (i) => i >= 9 && i <= 40);
    expect(log.run(0)).toBe(9); // frames 0–8 known (frame 9 was only ever in lost ticks)…
    expect(log.has(10)).toBe(false); // …the 1-run is lost…
    expect(log.get(14)).toBe(3); // …the 3-run came back as the previous run
    expect(log.get(59)).toBe(4);
  });

  it('places a run longer than 255 frames only as far back as the tick can say', () => {
    const pads = new Uint16Array(600);
    pads.fill(1, 300);
    const log = relay(pads, (i) => i !== 599);
    expect(log.has(343)).toBe(false);
    expect(log.run(344)).toBe(256);
    expect(log.has(299)).toBe(false); // the earlier run's place isn't known
  });

  it('a pad held for over half the u16 clock still reaches every frame', () => {
    // Nobody touched the pad for ~10 minutes (32768+ frames): the run's
    // length must not read as negative, or the tick would say only its own
    // frame, and with every other tick sent the frames between go unknown.
    const pads = new Uint16Array(40_000);
    pads.fill(PAD_BIT.A, 0, 5);
    const log = relay(pads, (i) => i % 2 === 0 || (i > 1000 && i < 39_000));
    expect(log.run(39_000)).toBe(1000);
    const runs = new PadRuns();
    for (let f = 0; f < 34_000; f++) runs.record(f, 0);
    expect(runs.tick()).toMatchObject({ frame: 33_999, run0: 255 });
  });

  it('keeps counting across the u16 wrap', () => {
    const pads = script(400, 5);
    const log = relay(pads, (i) => i % 4 === 1, 65400);
    expect(log.run(65400)).toBe(400);
    expect(log.get(frameAdd(65400, 399))).toBe(pads[399]);
  });

  it('across the wrap, a pad change on frame 0 still places the run before it', () => {
    // Every other tick lost, so frame 65535 is only in frame 0's tick, as
    // the earlier run.
    const pads = new Uint16Array(100).map((_, i) => (i < 36 ? 1 : 2));
    const log = relay(pads, (i) => i % 2 === 1, 65500);
    expect(frameAdd(65500, 36)).toBe(0);
    expect(log.get(65535)).toBe(1);
    expect(log.run(65500)).toBe(99);
  });

  it('a burst of changes between ticks makes the host send early, so no run goes unsent', () => {
    // Pads change on every frame; the host means to send every third frame
    // (a slow update), and sends sooner whenever a change would push out a
    // run no tick has carried.
    const pads = new Uint16Array(300).map((_, i) => (i * 7) % 5);
    const runs = new PadRuns();
    const log = new PadLog();
    let early = 0;
    pads.forEach((p, i) => {
      if (runs.needsTickBefore(p)) {
        log.addTick(runs.tick()!);
        early++;
      }
      runs.record(i, p);
      if (i % 3 === 2) log.addTick(runs.tick()!);
    });
    expect(early).toBeGreaterThan(0);
    expect(log.run(0)).toBe(300);
    pads.forEach((p, f) => expect(log.get(f)).toBe(p));
  });

  it('places nothing before the first frame of a match', () => {
    const runs = new PadRuns();
    const log = new PadLog();
    runs.record(0, 5);
    runs.record(1, 5);
    log.addTick(runs.tick()!);
    expect(log.has(65535)).toBe(false);
    expect(log.run(0)).toBe(2);
  });
});

describe("the guest's pad on the host", () => {
  it('holds each reported pad for a frame, and replays a tap whose tick was lost', () => {
    const pad = new GuestPad();
    pad.onTick({ cur: 0, prev: 0, changes: 0, seq: 1 });
    expect(pad.next()).toBe(0);
    // A pressed (change 1), released (change 2): the change-1 tick was lost.
    pad.onTick({ cur: 0, prev: PAD_BIT.A, changes: 2, seq: 3 });
    expect(pad.next()).toBe(PAD_BIT.A);
    expect(pad.next()).toBe(0);
    // A late copy of an old tick changes nothing.
    pad.onTick({ cur: PAD_BIT.A, prev: 0, changes: 1, seq: 2 });
    expect(pad.next()).toBe(0);
    // Heartbeats with no change hold the pad.
    pad.onTick({ cur: PAD_BIT.B, prev: 0, changes: 3, seq: 4 });
    pad.onTick({ cur: PAD_BIT.B, prev: 0, changes: 3, seq: 5 });
    expect([pad.next(), pad.next(), pad.next()]).toEqual([PAD_BIT.B, PAD_BIT.B, PAD_BIT.B]);
    pad.reset();
    expect(pad.next()).toBe(0);
  });

  it("replays a new guest's tap whose first tick was lost: its changes count from none", () => {
    const pad = new GuestPad();
    // A pressed (change 1), released (change 2): the guest's first tick lost.
    pad.onTick({ cur: 0, prev: PAD_BIT.A, changes: 2, seq: 2 });
    expect([pad.next(), pad.next()]).toEqual([PAD_BIT.A, 0]);
    // The next guest (or the same one, back on the seat) counts from none
    // again, its sequence wherever its own is.
    pad.onTick({ cur: PAD_BIT.B, prev: 0, changes: 3, seq: 3 });
    pad.reset();
    expect(pad.next()).toBe(0);
    pad.onTick({ cur: PAD_BIT.LEFT, prev: PAD_BIT.UP, changes: 2, seq: 1 });
    expect([pad.next(), pad.next(), pad.next()]).toEqual([PAD_BIT.UP, PAD_BIT.LEFT, PAD_BIT.LEFT]);
    // Standing there with nothing pressed changes nothing.
    pad.reset();
    pad.onTick({ cur: 0, prev: 0, changes: 0, seq: 40 });
    expect(pad.next()).toBe(0);
  });

  it('after a silence, lets go, and takes the next pad as it is', () => {
    const pad = new GuestPad();
    pad.onTick({ cur: PAD_BIT.RIGHT, prev: 0, changes: 1, seq: 1 });
    expect(pad.next()).toBe(PAD_BIT.RIGHT);
    pad.lapse();
    expect(pad.next()).toBe(0);
    // What it changed meanwhile went unheard: no replay of `prev`.
    pad.onTick({ cur: PAD_BIT.UP, prev: PAD_BIT.A, changes: 9, seq: 30 });
    expect([pad.next(), pad.next()]).toEqual([PAD_BIT.UP, PAD_BIT.UP]);
    // A guest not heard from yet still counts from none, however long it took.
    const fresh = new GuestPad();
    fresh.lapse();
    fresh.onTick({ cur: 0, prev: PAD_BIT.B, changes: 2, seq: 7 });
    expect([fresh.next(), fresh.next()]).toEqual([PAD_BIT.B, 0]);
  });
});

describe('every copy runs the same game', () => {
  it('two machines with different sample rates stay frame-identical on the same pads', () => {
    const bytes = rom('thwaite');
    const a = new ArcadeMachine({ sampleRate: 48000, onAudioSample: () => undefined });
    const b = new ArcadeMachine({ sampleRate: 44100 });
    a.load(bytes);
    b.load(bytes);
    const pads = script(1200, 11);
    for (let f = 0; f < pads.length; f++) {
      if (f === 600) b.setSampleRate(22050); // a speaker that turned up late
      a.runFrame(pads[f] & 0xff, pads[f] >> 8);
      b.runFrame(pads[f] & 0xff, pads[f] >> 8);
      if (f % 100 === 99) {
        expect(frameHash(b), `frame ${f}`).toBe(frameHash(a));
        expect(b.check()).toBe(a.check());
      }
    }
  }, 30_000);

  it.each(ARCADE_GAMES.map((g) => [g.id] as const))(
    '%s: a compact save state carries the game to a late copy',
    async (id) => {
      const bytes = rom(id);
      const host = new ArcadeMachine();
      host.load(bytes);
      const pads = script(1500, 21);
      for (let f = 0; f < 900; f++) host.runFrame(pads[f] & 0xff, pads[f] >> 8);

      const data = await encodeSnapshot(host.saveState()!, ArcadeMachine.bootState(bytes)!);
      expect(data.byteLength).toBeLessThan(40 * 1024);

      const late = new ArcadeMachine({ sampleRate: 44100 });
      late.load(bytes);
      late.loadState(await decodeSnapshot(data, ArcadeMachine.bootState(bytes)!));
      expect(late.check()).toBe(host.check());
      for (let f = 900; f < 1500; f++) {
        host.runFrame(pads[f] & 0xff, pads[f] >> 8);
        late.runFrame(pads[f] & 0xff, pads[f] >> 8);
      }
      expect(frameHash(late)).toBe(frameHash(host));
      expect(late.check()).toBe(host.check());
    },
    30_000,
  );

  it('gives up on a save state that inflates past the limit, without inflating all of it', async () => {
    const boot = ArcadeMachine.bootState(rom('thwaite'))!;
    // 64 MiB of zeros deflates to about 64 KB: under the doc's size limit.
    const zeros = new Blob([new Uint8Array(64 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('deflate'));
    const bomb = new Uint8Array(await new Response(zeros).arrayBuffer());
    expect(bomb.byteLength).toBeLessThan(MAX_SNAPSHOT_BYTES);
    await expect(decodeSnapshot(bomb, boot)).rejects.toThrow('too large');
  }, 30_000);

  it('refuses a save state that is not one', async () => {
    const boot = ArcadeMachine.bootState(rom('thwaite'))!;
    await expect(decodeSnapshot(new Uint8Array([1, 2, 3]), boot)).rejects.toThrow();
    const notState = await encodeSnapshot({ hello: 1 } as never, boot);
    await expect(decodeSnapshot(notState, boot)).rejects.toThrow('not a save state');
  });

  it("takes every bundled game's running state, and refuses one bent out of the power-on shape", async () => {
    type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const game of ARCADE_GAMES) {
      const bytes = rom(game.id);
      const boot = ArcadeMachine.bootState(bytes)!;
      const m = new ArcadeMachine();
      m.load(bytes);
      const pads = script(600, 3);
      for (let f = 0; f < pads.length; f++) m.runFrame(pads[f] & 0xff, pads[f] >> 8);
      const state = m.saveState()!;
      // Running fills in what power-on leaves null (PPU registers, the tile
      // cache): still a save state.
      await expect(decodeSnapshot(await encodeSnapshot(state, boot), boot)).resolves.toBeTruthy();

      const bent = async (bend: (s: Json) => void) => {
        const s = JSON.parse(JSON.stringify(state)) as Json;
        bend(s);
        return decodeSnapshot(await encodeSnapshot(s as never, boot), boot);
      };
      const hostile: Array<[string, (s: Json) => void]> = [
        ['the four parts, empty', (s) => { for (const k of Object.keys(s)) delete s[k]; Object.assign(s, { cpu: {}, mmap: {}, ppu: {}, papu: {} }); }],
        ['a part missing', (s) => delete s.papu],
        ['an extra part', (s) => (s.extra = 1)],
        ['work RAM cut short', (s) => (s.cpu.mem = s.cpu.mem.slice(0, 16))],
        ['work RAM as an object', (s) => (s.cpu.mem = { 0: 1 })],
        ['a register as text', (s) => (s.cpu.REG_PC = 'x')],
        ['a register out of range', (s) => (s.cpu.REG_PC = 1e400)],
        ['a pattern tile missing', (s) => s.ppu.ptTile.pop()],
        ['a cached tile as a number', (s) => (s.ppu.scantile[0] = 7)],
        ['a cached tile without its pixels', (s) => (s.ppu.scantile[0] = { opaque: [0, 0, 0, 0, 0, 0, 0, 0], pix: [] })],
        ['a null register as an object', (s) => (s.ppu.curNt = {})],
      ];
      for (const [what, bend] of hostile) {
        await expect(bent(bend), `${game.id}: ${what}`).rejects.toThrow('not a save state');
      }
    }
  }, 60_000);

  it('a different pad on one frame shows up in the check soon after', () => {
    const bytes = rom('thwaite');
    const a = new ArcadeMachine();
    const b = new ArcadeMachine();
    a.load(bytes);
    b.load(bytes);
    const pads = script(1200, 4);
    let differed = false;
    for (let f = 0; f < 1200; f++) {
      a.runFrame(pads[f] & 0xff, pads[f] >> 8);
      b.runFrame(f === 600 ? 0 : pads[f] & 0xff, f === 600 ? 0 : pads[f] >> 8);
      if (f > 600 && a.check() !== b.check()) differed = true;
    }
    expect(differed).toBe(true);
  }, 30_000);
});
