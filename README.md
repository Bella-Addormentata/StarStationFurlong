# StarStationFurlong
Decentralized hangout game.

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


opensource tech (current stack — see [STUDY-Architecture v006](brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md) and the [Browser Support Matrix](docs/TDD/BrowserSupportMatrix.md)):
* https://github.com/BiagioFesta/wtransport — WebTransport server (browser↔node pipe, cert-hash pinned)
* https://github.com/n0-computer/iroh — QUIC hole-punching, relays, blobs (native swarm)
* https://github.com/p2panda/p2panda — signed append-only logs, groups, encryption (RoomLog)
* https://github.com/y-crdt/y-crdt + https://github.com/yjs/yjs — CRDT room state (yrs on the node, Yjs in the browser)
* https://github.com/xch-dev/chia-wallet-sdk + https://github.com/Chia-Network/chia-gaming — deeds, offers, settlement
* https://github.com/mrdoob/three.js/ — rendering
* https://github.com/tauri-apps/tauri — desktop + Android shell
* https://github.com/yacy

earlier explorations (superseded by the studies in [brainstorming/](brainstorming/AI%20BRAINSTORMING/), kept for the ideas they contributed):
* https://github.com/feross/simple-peer · https://github.com/webtorrent/webtorrent · https://github.com/cabal-club · https://retroshare.cc/ · https://github.com/Tribler/tribler
* https://github.com/Kaetram · https://worldofclaudecraft.com/

## Quickstart: Try the Playable Demo

The current playable prototype is the Phase 1 core loop demo.

```bash
cd prototypes/0.24.0-core-loop-demo
npm install
npm run dev
```

Full setup instructions: [prototypes/0.24.0-core-loop-demo/README.md](prototypes/0.24.0-core-loop-demo/README.md)

---

## Repository Structure

The project is structured according to game development industry standards to maintain a clean separation between design, technical architecture, and implementation:

* **[`TODO.md`](TODO.md)**: The live work tracker — critical path, spike backlog, and a dated Done log.
* **`docs/GDD/` (Game Design Document)**: Contains all high-level game design concepts, storylines, core gameplay loops, crafting systems, and economy balance.
* **`docs/TDD/` (Technical Design Document)**: Contains system architecture, data structures, and technical specifications for how the game operates under the hood.
* **`docs/API/`**: External code references, code links, and API standards.
* **`brainstorming/`**: Unstructured ideation, AI notes, and raw concepts before they are formalized into the GDD or TDD.
* **`src/`**: Source code for the actual game client and server (to be populated).
* **`prototypes/`**: Quick throwaway code, proof-of-concepts, and playable demos to test game mechanics and technical feasibility.
