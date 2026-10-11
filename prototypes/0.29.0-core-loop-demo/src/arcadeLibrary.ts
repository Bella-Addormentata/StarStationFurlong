/**
 * 🕹️ The arcade cabinet's game library: the NES homebrew ROMs the app ships,
 * with who made each one and the license that lets us hand it out.
 *
 * Every entry is a game its author released under a license that allows
 * redistribution (GPL, zlib, CC BY). Commercial ROMs and archive.org's arcade
 * sets are NOT open source and must never be added here; neither can
 * non-commercial ROMs (CC BY-NC, MAME's "free ROMs"), since those may not be
 * bundled with someone else's software. public/arcade/README.md is the
 * human-readable credits page and says how to add a game;
 * arcadeLibrary.test.ts checks every entry's files exist and its ROM boots.
 *
 * Pure data + the iNES header check — no DOM, no emulator.
 */

export type ArcadeLicense = 'GPL-3.0-or-later' | 'zlib' | 'CC-BY-4.0';

export interface ArcadeGame {
  /** Stable id (the ROM's file stem). */
  id: string;
  title: string;
  author: string;
  year: number;
  license: ArcadeLicense;
  /** Served path of the ROM (public/arcade/roms). */
  romUrl: string;
  /** Upstream source repository the ROM was built from. */
  sourceUrl: string;
  /** Upstream commit the bundled ROM was built from. */
  sourceCommit: string;
  /** Served path of the bundled corresponding source (copyleft games). */
  bundledSource?: string;
  /** Served path of the license text. */
  licenseUrl: string;
  /** One line for the cabinet menu: what you do. */
  blurb: string;
  /** One line for the cabinet menu: which buttons. */
  controls: string;
}

export const ARCADE_GAMES: readonly ArcadeGame[] = [
  {
    id: 'thwaite',
    title: 'THWAITE',
    author: 'Damian Yerrick',
    year: 2011,
    license: 'GPL-3.0-or-later',
    romUrl: '/arcade/roms/thwaite.nes',
    sourceUrl: 'https://github.com/pinobatch/thwaite-nes',
    sourceCommit: '00e36745188bc165990f60eed6b093c3ce6ad0e3',
    bundledSource: '/arcade/source/thwaite-nes-00e3674.tar.gz',
    licenseUrl: '/arcade/licenses/GPL-3.0.txt',
    blurb: 'Missiles at night. Shoot them down, save the town.',
    controls: 'D-PAD AIM  B LEFT SILO  A RIGHT SILO',
  },
  {
    id: 'concentration-room',
    title: 'CONCENTRATION ROOM',
    author: 'Damian Yerrick',
    year: 2010,
    license: 'GPL-3.0-or-later',
    romUrl: '/arcade/roms/concentration-room.nes',
    sourceUrl: 'https://github.com/pinobatch/croom-nes',
    sourceCommit: 'ed19c3c07ca389b70cf2e0dd2ce0320df28d511d',
    bundledSource: '/arcade/source/croom-nes-ed19c3c.tar.gz',
    licenseUrl: '/arcade/licenses/GPL-3.0.txt',
    blurb: 'Flip cards, find the pairs. Solo, 2P or vs CPU.',
    controls: 'D-PAD MOVE  A FLIP  START BEGIN',
  },
  {
    id: 'nesert-golfing',
    title: 'NESERT GOLFING',
    author: 'Brad Smith',
    year: 2019,
    license: 'CC-BY-4.0',
    romUrl: '/arcade/roms/nesert-golfing.nes',
    sourceUrl: 'https://github.com/bbbradsmith/NESertGolfing',
    sourceCommit: '1947a966403a9b0d05641a316df7d7bb209429e6',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    blurb: 'One endless desert course. One stroke at a time.',
    controls: 'SEE HELP ON THE TITLE SCREEN',
  },
  {
    id: 'robotfindskitten',
    title: 'ROBOTFINDSKITTEN',
    author: 'Damian Yerrick',
    year: 2014,
    license: 'zlib',
    romUrl: '/arcade/roms/robotfindskitten.nes',
    sourceUrl: 'https://github.com/pinobatch/rfk-nes',
    sourceCommit: 'b9764cefd54aca09018e0a8f120f6c538668d76b',
    licenseUrl: '/arcade/licenses/zlib-robotfindskitten.txt',
    blurb: 'You are robot. Find kitten. A zen simulation.',
    controls: 'D-PAD MOVE  BUMP THINGS TO LOOK',
  },
];

/** Short license names for the cabinet screen. */
export const LICENSE_LABEL: Record<ArcadeLicense, string> = {
  'GPL-3.0-or-later': 'GPL-3.0',
  zlib: 'ZLIB',
  'CC-BY-4.0': 'CC BY 4.0',
};

/** A player's own cartridge larger than this is refused before it is parsed.
 *  The biggest licensed NES boards top out around 1 MiB; 4 MiB leaves room
 *  for oddities without letting a stray video file into the emulator. */
export const MAX_ROM_BYTES = 4 * 1024 * 1024;

export type InesHeader =
  | { ok: true; mapper: number; prgBanks: number; chrBanks: number }
  | { ok: false; reason: string };

/**
 * Read an iNES / NES 2.0 header. Only the checks that keep junk out of the
 * emulator: the magic, a non-empty PRG, and a file long enough for the banks
 * it declares. Whether jsnes supports the mapper is jsnes's call (loadROM
 * throws), so the cabinet asks it rather than keeping a copy of its list.
 */
export function parseInesHeader(bytes: Uint8Array): InesHeader {
  if (bytes.length < 16) return { ok: false, reason: 'FILE TOO SMALL' };
  if (bytes.length > MAX_ROM_BYTES) return { ok: false, reason: 'FILE TOO LARGE' };
  if (bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
    return { ok: false, reason: 'NOT AN NES ROM' };
  }
  const prgBanks = bytes[4];
  const chrBanks = bytes[5];
  if (prgBanks === 0) return { ok: false, reason: 'NO PROGRAM DATA' };
  const trainer = bytes[6] & 0x04 ? 512 : 0;
  const need = 16 + trainer + prgBanks * 16384 + chrBanks * 8192;
  if (bytes.length < need) return { ok: false, reason: 'ROM IS TRUNCATED' };
  const mapper = (bytes[6] >> 4) | (bytes[7] & 0xf0);
  return { ok: true, mapper, prgBanks, chrBanks };
}
