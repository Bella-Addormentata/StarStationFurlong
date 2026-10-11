# 🕹️ SSF Arcade: games, credits and licenses

The arcade cabinet ships only NES homebrew games whose authors released them
under licenses that allow redistribution. Each ROM below was built, unmodified,
from the author's published source at the commit named, using cc65 2.19.
Nothing here is a commercial ROM, and none came from archive.org.

The emulator is [jsnes](https://github.com/bfirsh/jsnes) (Apache-2.0), bundled
from npm.

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
  complete corresponding source for each ROM ships next to it in
  [`source/`](source/) (a `git archive` of the commit above), so the source
  travels with every copy of the app.
- **zlib** (robotfindskitten): [`licenses/zlib-robotfindskitten.txt`](licenses/zlib-robotfindskitten.txt).
- **CC BY 4.0** (NESert Golfing): <https://creativecommons.org/licenses/by/4.0/>.
  NESert Golfing by Brad Smith (<https://rainwarrior.itch.io/nesert-golfing>),
  built without changes from the source linked above.

## Your own cartridge

The cabinet's INSERT YOUR OWN CARTRIDGE slot reads a `.nes` file from your own
device into memory for that play session only. It is never uploaded, stored or
shared with other players.

## Adding a game

Only add a ROM whose author has released it under a license that allows
redistribution (GPL, MIT, zlib, BSD, CC BY or CC BY-SA, or public domain).
Non-commercial licenses (CC BY-NC, the MAME "free ROMs") don't qualify, because
they can't be bundled with the app. Add the ROM under `roms/`, its license
under `licenses/`, its source under `source/` if the license is copyleft, a row
in the table above, and an entry in `src/arcadeLibrary.ts`.
`arcadeLibrary.test.ts` checks that each entry's files exist and that the ROM
boots in the emulator.
