# StarStationFurlong
Decentalized hangout game.

Inspired by:
* Habbo Hotel
* Workadventure
* Star Craft
* EverQuest
* Space Trader - https://en.wikipedia.org/wiki/Space_Trader_(Palm_OS)
* Second Life
* Minecraft
* https://en.wikipedia.org/wiki/Star_Wars_Galaxies
* OpenTTD
* Outpost - https://en.wikipedia.org/wiki/Outpost_(1994_video_game)
* Mystical Ninja SNES https://en.wikipedia.org/wiki/The_Legend_of_the_Mystical_Ninja


opensource tech:
* https://github.com/feross/simple-peer
* https://github.com/webtorrent/webtorrent
* https://github.com/cabal-club
* https://retroshare.cc/
* https://github.com/Chia-Network/chia-gaming
* https://github.com/mrdoob/three.js/
* https://github.com/Kaetram
* https://github.com/Tribler/tribler
* https://worldofclaudecraft.com/

## Quickstart: Try the Playable Demo

The current playable prototype is the Phase 1 core loop demo.

```bash
cd prototypes/01-core-loop-demo
npm install
npm run dev
```

Full setup instructions: [prototypes/01-core-loop-demo/README.md](prototypes/01-core-loop-demo/README.md)

---

## Repository Structure

The project is structured according to game development industry standards to maintain a clean separation between design, technical architecture, and implementation:

* **`docs/GDD/` (Game Design Document)**: Contains all high-level game design concepts, storylines, core gameplay loops, crafting systems, and economy balance.
* **`docs/TDD/` (Technical Design Document)**: Contains system architecture, data structures, and technical specifications for how the game operates under the hood.
* **`docs/API/`**: External code references, code links, and API standards.
* **`brainstorming/`**: Unstructured ideation, AI notes, and raw concepts before they are formalized into the GDD or TDD.
* **`src/`**: Source code for the actual game client and server (to be populated).
* **`prototypes/`**: Quick throwaway code, proof-of-concepts, and playable demos to test game mechanics and technical feasibility.
