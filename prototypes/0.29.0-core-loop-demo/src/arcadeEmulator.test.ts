/**
 * 🕹 arcadeEmulator — the pure half of the seam: where the emulator files
 * come from and what lane that is, the probe that keeps a fresh checkout from
 * showing a blank screen, the words for each failure, and the page's memory
 * of the player's own files.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowLocalRomExposure, arcadeFrameUrl, emulatorDataLane, emulatorDataPath, emulatorErrorText, emulatorFrameUrl,
  emulatorIsolated, localRomExposureAllowed, localRomFor, probeEmulatorData, rememberLocalRom, romAcceptList,
  EMULATOR_CDN_DATA, EMULATOR_FETCH_COMMAND, EMULATOR_SANDBOX,
} from './arcadeEmulator';
import { setConvenienceLanesForTest } from './sovereignty';

afterEach(() => { setConvenienceLanesForTest(null); });

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

  it('knows engine code from another origin (the CDN) for what it is, and the station\'s own for the station\'s — the frame is an opaque origin either way', () => {
    expect(emulatorIsolated('/emulatorjs/data/', 'http://localhost:4173')).toBe(false);
    expect(emulatorIsolated('http://localhost:4173/emulatorjs/data/', 'http://localhost:4173')).toBe(false);
    expect(emulatorIsolated(EMULATOR_CDN_DATA, 'http://localhost:4173')).toBe(true);
    expect(emulatorIsolated(EMULATOR_CDN_DATA, 'tauri://localhost')).toBe(true);
    expect(emulatorIsolated('http://[bad', 'http://localhost')).toBe(true);
  });

  it('sandboxes the frame to scripts and pointer lock: never the same origin, and no form, popup or download — each a request no policy governs', () => {
    expect(EMULATOR_SANDBOX.split(' ').sort()).toEqual(['allow-pointer-lock', 'allow-scripts']);
    expect(emulatorErrorText('navigated', 'station').title).toContain('LEFT THE CABINET');
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

  it('says what to do about each failure — and offers the CDN only in a build that has it', () => {
    expect(emulatorErrorText('loader', 'station').hint).toContain(EMULATOR_FETCH_COMMAND);
    expect(emulatorErrorText('timeout', 'station').title).toBe('EMULATOR FILES NOT PROVISIONED');
    setConvenienceLanesForTest(true);
    expect(emulatorErrorText('loader', 'station').hint).toContain('CDN');
    setConvenienceLanesForTest(false);
    expect(emulatorErrorText('loader', 'station').hint).not.toContain('CDN');
    expect(emulatorErrorText('loader', 'cdn').title).toContain('CDN');
    expect(emulatorErrorText('unreachable', 'station').title).toContain('UNREACHABLE');
    expect(emulatorErrorText('frame', 'station').title).toContain('FRAME');
    expect(emulatorErrorText('game', 'station').title).toContain('GAME');
    expect(emulatorErrorText('something odd', 'station')).toEqual({ title: 'THE CABINET FAULTED', hint: 'something odd' });
  });

  it('tells the frame its lane and, on the station lane, the origins its policy may reach — http(s) origins only', () => {
    expect(emulatorFrameUrl({ isolated: true, allowOrigins: ['http://127.0.0.1:8080'] }, '/arcade/frame.html')).toBe('/arcade/frame.html');
    expect(emulatorFrameUrl({ isolated: false, allowOrigins: [] }, '/arcade/frame.html')).toBe('/arcade/frame.html?lane=station&allow=');
    expect(emulatorFrameUrl({ isolated: false, allowOrigins: [] }, '/f.html?x=1')).toBe('/f.html?x=1&lane=station&allow=');
    const offered = [
      'http://localhost:4173', 'http://127.0.0.1:8080/blob/x', 'http://127.0.0.1:8080', 'tauri://localhost',
      'javascript:alert(1)', 'not an origin', "http://evil;script-src 'unsafe-inline'", 'http://evil;x', 'ws://x',
    ];
    const u = new URL(emulatorFrameUrl({ isolated: false, allowOrigins: offered }, 'http://localhost:4173/arcade/frame.html'));
    expect(u.searchParams.get('lane')).toBe('station');
    expect(u.searchParams.get('allow')).toBe('http://localhost:4173 http://127.0.0.1:8080');
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

  it('hands the player\'s own file to engine code from another origin only on their word, per game and per engine path', () => {
    const game = { name: 'tetris.nes', core: 'nes' as const, url: '', size: 40_976 };
    const origin = 'http://localhost:4173';
    // The station's own files are the station's own code: nothing to consent to.
    expect(localRomExposureAllowed(game, '/emulatorjs/data/', origin)).toBe(true);
    expect(localRomExposureAllowed(game, `${origin}/emulatorjs/data/`, origin)).toBe(true);
    // The CDN's code is another origin's: not until the player says so.
    expect(localRomExposureAllowed(game, EMULATOR_CDN_DATA, origin)).toBe(false);
    allowLocalRomExposure(game, EMULATOR_CDN_DATA);
    expect(localRomExposureAllowed(game, EMULATOR_CDN_DATA, origin)).toBe(true);
    expect(localRomExposureAllowed({ ...game, size: 1 }, EMULATOR_CDN_DATA, origin)).toBe(false); // another file: its own ask
    expect(localRomExposureAllowed(game, 'https://mirror.example/data/', origin)).toBe(false); // another engine origin: its own ask
  });
});
