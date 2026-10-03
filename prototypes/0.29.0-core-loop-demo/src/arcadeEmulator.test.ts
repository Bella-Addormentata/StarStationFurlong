/**
 * 🕹 arcadeEmulator — the pure half of the seam: where the emulator files
 * come from and what lane that is, the probe that keeps a fresh checkout from
 * showing a blank screen, the words for each failure, and the page's memory
 * of the player's own files.
 */
import { describe, expect, it } from 'vitest';
import {
  arcadeFrameUrl, emulatorDataLane, emulatorDataPath, emulatorErrorText, emulatorIsolated, localRomFor,
  probeEmulatorData, rememberLocalRom, romAcceptList, EMULATOR_CDN_DATA, EMULATOR_FETCH_COMMAND,
} from './arcadeEmulator';

const res = (status: number, type = 'application/javascript'): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? type : null) },
  }) as unknown as Response;
const answering = (r: Response | Error, calls: string[] = []): typeof fetch =>
  (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;

describe('where the emulator files come from', () => {
  it('the station path sits under the base, the CDN is itself; each has its lane', () => {
    expect(emulatorDataPath('station', '/')).toBe('/emulatorjs/data/');
    expect(emulatorDataPath('station', '/furlong')).toBe('/furlong/emulatorjs/data/');
    expect(emulatorDataPath('cdn', '/')).toBe(EMULATOR_CDN_DATA);
    expect(arcadeFrameUrl('/')).toBe('/arcade/frame.html');
    expect(arcadeFrameUrl('/furlong/')).toBe('/furlong/arcade/frame.html');
    expect(emulatorDataLane('station')).toBe('SOVEREIGN');
    expect(emulatorDataLane('cdn')).toBe('CONVENIENCE');
  });

  it('runs engine code from another origin isolated, and the station\'s own with the app', () => {
    expect(emulatorIsolated('/emulatorjs/data/', 'http://localhost:4173')).toBe(false);
    expect(emulatorIsolated('http://localhost:4173/emulatorjs/data/', 'http://localhost:4173')).toBe(false);
    expect(emulatorIsolated(EMULATOR_CDN_DATA, 'http://localhost:4173')).toBe(true);
    expect(emulatorIsolated(EMULATOR_CDN_DATA, 'tauri://localhost')).toBe(true);
    expect(emulatorIsolated('http://[bad', 'http://localhost')).toBe(true);
  });

  it('probes the station path for loader.js and leaves a cross-origin CDN to the loader', async () => {
    const calls: string[] = [];
    expect(await probeEmulatorData('/emulatorjs/data/', answering(res(200), calls), 'http://localhost:4173')).toBe('ok');
    expect(calls).toEqual(['/emulatorjs/data/loader.js']);
    // A dev server's SPA fallback answers 200 with index.html: not the loader.
    expect(await probeEmulatorData('/emulatorjs/data/', answering(res(200, 'text/html; charset=utf-8')), 'http://localhost')).toBe('missing');
    expect(await probeEmulatorData('/x/', answering(res(404)), 'http://localhost')).toBe('missing');
    expect(await probeEmulatorData('/x/', answering(res(503)), 'http://localhost')).toBe('unreachable');
    expect(await probeEmulatorData('/x/', answering(new Error('net')), 'http://localhost')).toBe('unreachable');
    expect(await probeEmulatorData(EMULATOR_CDN_DATA, answering(res(200)), 'http://localhost')).toBe('unknown');
    expect(await probeEmulatorData('http://localhost/emulatorjs/data/', answering(res(200)), 'http://localhost')).toBe('ok');
  });

  it('says what to do about each failure', () => {
    expect(emulatorErrorText('loader', 'station').hint).toContain(EMULATOR_FETCH_COMMAND);
    expect(emulatorErrorText('timeout', 'station').title).toBe('EMULATOR FILES NOT PROVISIONED');
    expect(emulatorErrorText('loader', 'cdn').title).toContain('CDN');
    expect(emulatorErrorText('unreachable', 'station').title).toContain('UNREACHABLE');
    expect(emulatorErrorText('frame', 'station').title).toContain('FRAME');
    expect(emulatorErrorText('game', 'station').title).toContain('GAME');
    expect(emulatorErrorText('something odd', 'station')).toEqual({ title: 'THE CABINET FAULTED', hint: 'something odd' });
  });

  it('remembers the player\'s own files by game, and lists every extension a core takes', () => {
    const file = { name: 'tetris.nes', size: 40_976 } as unknown as File;
    const game = { name: 'tetris.nes', core: 'nes' as const, url: '', size: 40_976 };
    expect(localRomFor(game)).toBeNull();
    rememberLocalRom(game, file);
    expect(localRomFor(game)).toBe(file);
    expect(localRomFor({ ...game, core: 'snes' })).toBeNull();
    expect(localRomFor({ ...game, size: 1 })).toBeNull(); // another size is another file, whatever its name
    expect(romAcceptList()).toContain('.nes');
    expect(romAcceptList()).toContain('.zip');
    expect(romAcceptList().startsWith('.')).toBe(true);
  });
});
