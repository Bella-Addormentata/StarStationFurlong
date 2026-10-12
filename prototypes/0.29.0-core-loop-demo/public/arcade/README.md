# 🕹️ SSF Arcade: games, credits and licenses

The arcade cabinet ships only NES homebrew games whose authors released them
under licenses that allow redistribution. Each ROM below was built, unmodified,
from the author's published source at the commit named, using cc65 2.19.
Nothing here is a commercial ROM, and none came from archive.org.

The emulator is [jsnes](https://github.com/bfirsh/jsnes) by Ben Firshman and
contributors (Apache-2.0, license text in
[`licenses/Apache-2.0-jsnes.txt`](licenses/Apache-2.0-jsnes.txt)), bundled from
npm.

| Game | Author | License | Source (commit) |
|---|---|---|---|
| Thwaite (`roms/thwaite.nes`) | Damian Yerrick, © 2011, 2012, 2018 | GPL-3.0-or-later | [pinobatch/thwaite-nes](https://github.com/pinobatch/thwaite-nes) @ `00e36745188bc165990f60eed6b093c3ce6ad0e3` |
| Concentration Room (`roms/concentration-room.nes`) | Damian Yerrick, © 2010 | GPL-3.0-or-later | [pinobatch/croom-nes](https://github.com/pinobatch/croom-nes) @ `ed19c3c07ca389b70cf2e0dd2ce0320df28d511d` |
| robotfindskitten (`roms/robotfindskitten.nes`) | Damian Yerrick, © 2014 (original game by Leonard Richardson, 1997) | zlib | [pinobatch/rfk-nes](https://github.com/pinobatch/rfk-nes) @ `b9764cefd54aca09018e0a8f120f6c538668d76b` |
| NESert Golfing (`roms/nesert-golfing.nes`) | Brad Smith, 2019 | CC BY 4.0 | [bbbradsmith/NESertGolfing](https://github.com/bbbradsmith/NESertGolfing) @ `1947a966403a9b0d05641a316df7d7bb209429e6` |

## License texts

- **GPL-3.0** (Thwaite, Concentration Room): [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt).
  These programs are free software: you can redistribute them and/or modify
  them under the terms of the GNU General Public License as published by the
  Free Software Foundation, either version 3 of the License, or (at your
  option) any later version. They are distributed WITHOUT ANY WARRANTY. The
  complete corresponding source for each ROM ships with it, a `git archive`
  of the commit above: Thwaite in
  [`source/thwaite-nes-00e3674.tar.gz`](source/thwaite-nes-00e3674.tar.gz) and
  Concentration Room in
  [`source/croom-nes-ed19c3c.tar.gz`](source/croom-nes-ed19c3c.tar.gz), so
  the source travels with every copy of the app.
- **zlib** (robotfindskitten): [`licenses/zlib-robotfindskitten.txt`](licenses/zlib-robotfindskitten.txt).
- **CC BY 4.0** (NESert Golfing): [`licenses/CC-BY-4.0.txt`](licenses/CC-BY-4.0.txt)
  (also at <https://creativecommons.org/licenses/by/4.0/>).
  NESert Golfing by Brad Smith (<https://rainwarrior.itch.io/nesert-golfing>),
  built without changes from the source linked above.

## One game per cabinet

A cabinet plays one game, picked by the room's owner in the cabinet's ⚙️
settings: one of the games above on the built-in emulator (it plays on the
cabinet's screen and the room watches), or the owner's own game in EmulatorJS.
Players don't pick games; they walk up and press play.

## EmulatorJS, for the owner's own game

The owner's own game runs in [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS)
inside a sandboxed frame. It isn't in this repository:
`npm run fetch:emulatorjs` puts it under `public/emulatorjs/`, the engine and
its cores as npm packages at one pinned version, and release builds carry the
engine and all eleven cores. Each core's archive holds its own license
(`license.txt`); the texts are here too, and
`emulatorjs/data/NOTICE.txt` names each package fetched, its sha512 and the
commit it was built from.

| Part | Systems | License | Text |
|---|---|---|---|
| EmulatorJS (the engine) | all | GPL-3.0 | [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt); its own `LICENSE` lands beside the engine |
| RetroArch (EmulatorJS's fork), linked into every core's file | all | GPL-3.0 | [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt) |
| fceumm | NES | GPL-2.0 | [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt) |
| gambatte | Game Boy, Game Boy Color | GPL-2.0 | [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt) |
| mupen64plus_next | Nintendo 64 | GPL-2.0 | [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt) |
| pcsx_rearmed | PlayStation | GPL-2.0 | [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt) |
| mednafen_pce | PC Engine | GPL-2.0 | [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt) |
| mgba | Game Boy Advance | MPL-2.0 | [`licenses/MPL-2.0-mgba.txt`](licenses/MPL-2.0-mgba.txt) |
| stella2014 | Atari 2600 | GPL-2.0 (its archive holds no license text; its source has Stella's, `stella/license.txt`) | [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt) |
| genesis_plus_gx | Mega Drive, Master System | Genesis Plus GX, **non-commercial** | [`licenses/Genesis-Plus-GX.txt`](licenses/Genesis-Plus-GX.txt) |
| snes9x | SNES | Snes9x, **non-commercial** | [`licenses/Snes9x.txt`](licenses/Snes9x.txt) |
| fbneo | Arcade (FBNeo) | FBNeo, **non-commercial**, and no asking for donations for a project that uses it | [`licenses/FBNeo.txt`](licenses/FBNeo.txt) |
| mame2003_plus | Arcade (MAME 2003-Plus) | MAME 0.78, **non-commercial** | [`licenses/MAME-2003-Plus.txt`](licenses/MAME-2003-Plus.txt) |
| libunrar (EmulatorJS's RAR unpacker), RARLAB's UnRAR 5.9.2 | RAR files | UnRAR's own (free to use and pass on; not for making a RAR archiver) | [`licenses/UnRAR.txt`](licenses/UnRAR.txt) |

The four non-commercial cores are in release builds because Star Station
Furlong is non-commercial (the owner, 2026-10-12). FBNeo's license also forbids
asking for donations to support work on any project that uses it, and this one
asks for none. A build that is sold, or that asks for donations, would have to
leave those cores out, and the systems they run with them: take those systems
out of `ARCADE_CORES` (`src/arcadeDoc.ts`) and the cores out of the fetch
script's `DEFAULT_CORES` and `scripts/emulatorjs-sources.json`. The tests hold
the three together, and a release then offers, fetches and packs the source of
only the rest. `EJS_CORES` alone would leave the cores' files out but still
offer their systems, which then wouldn't start.

EmulatorJS's own scripts travel with it unminified. The cores are compiled
builds, too big to carry their source inside the app the way the built-in
games do, so every release carries it beside the installers:
`emulatorjs-4.2.1-source.tar.xz` (about 123 MB) holds the engine, the eleven
cores, the RetroArch they are linked with and the scripts that built them, each
at the commit it was built from. EmulatorJS doesn't say which commits those
were; each core's own version string names its commit, and
`scripts/emulatorjs-sources.json` pins them all by full hash
(`scripts/pack-emulatorjs-source.mjs` says how each was found, and packs the
archive). `NOTICE.txt` names each commit, and the archive's `README.txt` lists
them with the submodules left out, which the cores' web builds don't compile.

EmulatorJS's unpacking helpers under `data/compression/` open 7z, zip and RAR
files, each in a worker of its own; every core arrives as a 7z archive. They are
prebuilt files EmulatorJS has carried since 2021. The RAR one (`libunrar.js`,
`libunrar.wasm`) is [libunrar-js](https://github.com/tnikolai2/libunrar-js),
RARLAB's UnRAR 5.9.2 built for the web: its `libunrar.wasm` is EmulatorJS's byte
for byte, so the archive carries its source too, UnRAR's included. Nothing says
what `extract7z.js` and `extractzip.js` were built from, EmulatorJS included, so
theirs is the one source the archive can't carry; it holds them as EmulatorJS
ships them.

## Adding a game

Only add a ROM whose author has released it under a license that allows
redistribution (GPL, MIT, zlib, BSD, CC BY or CC BY-SA, or public domain).
Non-commercial licenses (CC BY-NC, the MAME "free ROMs") don't qualify, because
they can't be bundled with the app. Add the ROM under `roms/`, its license
under `licenses/`, its source under `source/` if the license is copyleft, a row
in the table above, and an entry in `src/arcadeLibrary.ts`.
`arcadeLibrary.test.ts` checks that each entry's files exist and that the ROM
boots in the emulator.
