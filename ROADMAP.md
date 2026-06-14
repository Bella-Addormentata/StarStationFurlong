# High-Level Roadmap: StarStationFurlong

This roadmap outlines the milestones from initial prototyping to a fully playable decentralized hangout game. It bridges our high-level game design (GDD) with the technical architecture (TDD).

## 🗺️ Visual Roadmap Tracker

```mermaid
flowchart TB
    %% Color Palette & Styles
    classDef default fill:#f8f9fa,stroke:#dfe6e9,stroke-width:2px,color:#2d3436
    classDef currentPhase fill:#e1f5fe,stroke:#0984e3,stroke-width:3px,stroke-dasharray: 5 5
    classDef futurePhase fill:#f5f6fa,stroke:#b2bec3,stroke-width:2px
    classDef statusDoing fill:#fd79a8,stroke:#e84393,stroke-width:2px,color:#fff,rx:8px,ry:8px
    classDef statusTodo fill:#ffffff,stroke:#74b9ff,stroke-width:2px,color:#0984e3,rx:8px,ry:8px
    classDef statusGoal fill:#cce4ff,stroke:#74b9ff,stroke-width:4px,color:#0984e3,rx:20px,ry:20px

    subgraph Phase1 [🚀 Phase 1: Foundation & Prototyping]
        A1([🛠️ Tech Scaffold]):::statusDoing --> A2([🌐 P2P Networking]):::statusTodo
        A2 --> A3([🏃 Basic Movement]):::statusTodo
        A3 --> A4([💬 Chat Prototype]):::statusTodo
    end
    class Phase1 currentPhase

    subgraph Phase2 [🌍 Phase 2: Core Loop & Spatial Expansion]
        B1([📍 Map System V1]):::statusTodo --> B2([📦 Elements System]):::statusTodo
        B2 --> B3([🔬 Tech Trees]):::statusTodo
        B3 --> B4([🌫️ Fog of War]):::statusTodo
    end
    class Phase2 futurePhase

    subgraph Phase3 [💎 Phase 3: Economy & Social]
        C1([📞 SpacePhone & Voice]):::statusTodo --> C2([⛽ Economy & Spacefuel]):::statusTodo
        C2 --> C3([🪙 Crypto/Chia]):::statusTodo
    end
    class Phase3 futurePhase

    subgraph Phase4 [🌌 Phase 4: Grand Strategy]
        D1([🤖 AI Starships]):::statusTodo --> D2([📜 Contract System]):::statusTodo
        D2 --> D3([⚠️ Map Disruptions]):::statusTodo
    end
    class Phase4 futurePhase

    subgraph Phase5 [🎉 Phase 5: Launch]
        E1([⚖️ Balance Economy]):::statusTodo --> E2([✨ UI/UX Polish]):::statusTodo
        E2 --> E3(((🏆 V1.0 Release!))):::statusGoal
    end
    class Phase5 futurePhase

    Phase1 ===> Phase2 ===> Phase3 ===> Phase4 ===> Phase5
```

## Phase 1: Foundation & Prototyping (Current)
**Goal:** Prove the technical viability of a decentralized, browser-based spatial environment.
* [ ] **Tech Scaffold:** Initialize the `src/` directory with a 3D renderer (e.g., Three.js) or 2D canvas.
* [ ] **P2P Networking:** Prototype basic WebRTC/Simple-peer connectivity for 2-4 players in a single "Room".
* [ ] **Basic Movement:** Implement avatar rendering and movement in a local space.
* [ ] **Communication Prototype:** Add basic proximity-based text chat.

## Phase 2: Core Loop & Spatial Expansion (Pre-Alpha)
**Goal:** Implement the primary player interactions, inventory, and map systems.
* [ ] **Multi-scale Map System (V1):** Implement the local station/room scale map and transition logic between connected rooms.
* [ ] **Inventory & Elements:** Implement the foundational Element System (from `docs/TDD/02-Systems/ElementSystem.md`).
* [ ] **Crafting & Tech Trees (V1):** Basic UI to view tech requirements and combine elemental items.
* [ ] **Fog of War:** Basic visibility hiding for unexplored rooms/areas.

## Phase 3: Trade, Economy & Advanced Communication (Alpha)
**Goal:** Bring the universe to life with economy, resources, and deeper social bridging.
* [ ] **Advanced Communication:** Implement the "SpacePhone" (webcam -> pixelated avatar) and voice chat integration.
* [ ] **In-Game Economy:** Introduce Trade systems, "Spacefuel" for movement constraints, and deployable ATMs.
* [ ] **Crypto/Decentralized Tie-ins:** Integrate experimental Chia coin interactions or decentralized data persistence (e.g., WebTorrent/Tribler).
* [ ] **Macro Maps:** Implement solar system/galaxy scale maps (OpenTTD strategic view style).

## Phase 4: Automation & Grand Strategy (Beta)
**Goal:** Allow players to scale their presence across the galaxy without grinding.
* [ ] **Automation Systems:** Construct/buy robotic starships and AI captains to run trade routes.
* [ ] **Contract System:** Allow users to hire other real users to pilot ships or run stations.
* [ ] **Advanced Map Mechanics:** Damageable map systems, tech-tree dependent sensor arrays, and physical "Printed Maps" fallback.
* [ ] **Performance & P2P Scaling:** Stabilize peer discovery networks for larger galaxies.

## Phase 5: Polish, Balance & V1.0 Launch
**Goal:** Balance the tech tree, optimize network traffic, and prepare for public access.
* [ ] **Economy Balancing:** Adjust resource spawn rates, fuel costs, and crafting times.
* [ ] **UX/UI Polish:** Refine spatial UI, console interactions, and hologram projectors.
* [ ] **Security:** Ensure decentralized state reconciliation (preventing easy cheating in a P2P environment).
* [ ] **Public Release!**
