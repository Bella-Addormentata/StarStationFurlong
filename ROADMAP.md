# High-Level Roadmap: StarStationFurlong

This roadmap outlines the milestones from initial prototyping to a fully playable decentralized hangout game. It bridges our high-level game design (GDD) with the technical architecture (TDD).

## Review Summary

After comparing the roadmap against the GDD, the overall direction makes sense, but the original roadmap underrepresented three important design pillars:

* The early-game fantasy of waking up as a clone-born station citizen and learning the world through hands-on station work.
* The survival simulation loop of power, repairs, food, fuel, medicine, and fragile infrastructure.
* The colony-scale arc of outposts, supply lines, specialization, and civilization recovery.

The roadmap below adds those missing beats so the game grows from a strong first playable slice instead of jumping too quickly to late-stage features.

## Design Pillars

* `Social Hangout`: proximity chat, SpacePhone, room presence, player-run spaces.
* `Station Survival`: maintenance, scarcity, fuel, crafting, medical and food support.
* `Player Careers`: engineering, trade, crafting, exploration, station jobs.
* `Colony Expansion`: maps, outposts, logistics, automation, frontier growth.

## 🗺️ Visual Roadmap Tracker

```mermaid
flowchart LR
    classDef current fill:#dff4ff,stroke:#1d70b8,stroke-width:3px,color:#12344d,rx:12px,ry:12px
    classDef future fill:#f7fbff,stroke:#9bb8d3,stroke-width:2px,color:#234,rx:12px,ry:12px
    classDef milestone fill:#cce4ff,stroke:#4a90e2,stroke-width:4px,color:#12344d,rx:18px,ry:18px

    A([Phase 1<br/>First Playable Slice]):::current --> B([Phase 2<br/>Survival Core]):::future
    B --> C([Phase 3<br/>Economy + Social]):::future
    C --> D([Phase 4<br/>Frontier Expansion]):::future
    D --> E([Phase 5<br/>Automation + Launch]):::future
    E --> F(((V1.0))):::milestone
```

Priority flow: `learn the station -> keep it alive -> trade and specialize -> expand the frontier -> automate at scale`

## Phase 1: Foundation & Prototyping (Current)
**Goal:** Prove the technical viability of a decentralized, browser-based spatial environment.

```mermaid
flowchart LR
    classDef current fill:#dff4ff,stroke:#1d70b8,stroke-width:3px,color:#12344d,rx:10px,ry:10px
    A([Tech Scaffold]):::current --> B([Small-Room Multiplayer]):::current
    B --> C([Basic Movement and Presence]):::current
    C --> D([Station Chores Tutorial Slice]):::current
    D --> E([Communication Prototype]):::current
```

* [ ] **Tech Scaffold:** Initialize the prototype stack in `prototypes/` with a web client, rendering layer, and simple world state.
* [ ] **Small-Room Multiplayer:** Prototype WebRTC or equivalent P2P connectivity for 2-4 players in a single room.
* [ ] **Basic Movement and Presence:** Implement avatar rendering, movement, and clear nearby player presence.
* [ ] **Station Chores Tutorial Slice:** Add one short loop where a new player completes a simple delivery, repair, or maintenance task.
* [ ] **Communication Prototype:** Add proximity-based text chat before voice and SpacePhone features.

## Phase 2: Core Loop & Spatial Expansion (Pre-Alpha)
**Goal:** Establish the station survival loop and the player's first career progression.

```mermaid
flowchart LR
    classDef future fill:#f7fbff,stroke:#9bb8d3,stroke-width:2px,color:#234,rx:10px,ry:10px
    A([Inventory and Elements]):::future --> B([Crafting and Processing]):::future
    B --> C([Skill Progression]):::future
    C --> D([Station Survival Systems]):::future
    D --> E([Local Maps and Fog of War]):::future
```

* [ ] **Inventory & Elements:** Implement the foundational Element System from the TDD as the basis for items, materials, and resources.
* [ ] **Crafting & Processing:** Support basic refining, workbench crafting, and multi-stage item assembly.
* [ ] **Skill Progression:** Add early specialization tracks such as survival, engineering, crafting, trade, or exploration.
* [ ] **Station Survival Systems:** Model power, food, fuel, repairs, and medical supply pressure at a simple but playable level.
* [ ] **Local Maps & Fog of War:** Implement station or room-scale map access, visibility limits, and traversal between connected spaces.

## Phase 3: Trade, Economy & Advanced Communication (Alpha)
**Goal:** Turn the station into a social economy with meaningful player roles and trade friction.

```mermaid
flowchart LR
    classDef future fill:#f7fbff,stroke:#9bb8d3,stroke-width:2px,color:#234,rx:10px,ry:10px
    A([In-Game Economy]):::future --> B([Player Jobs and Roles]):::future
    B --> C([Advanced Communication]):::future
    C --> D([Station Identity]):::future
    D --> E([Crypto and Decentralized Tie-Ins]):::future
```

* [ ] **In-Game Economy:** Introduce trade systems, pricing pressure, Spacefuel constraints, and deployable ATMs.
* [ ] **Player Jobs and Roles:** Add repeatable station work, hauling, repair, medical, trade, or admin-like responsibilities.
* [ ] **Advanced Communication:** Implement voice chat and the SpacePhone concept with pixelated live-avatar identity.
* [ ] **Station Identity:** Add clearer ownership, room personalization, and visible social status through spaces and equipment.
* [ ] **Crypto / Decentralized Tie-Ins:** Integrate experimental Chia or decentralized persistence only after the core economy feels good without it.

## Phase 4: Automation & Grand Strategy (Beta)
**Goal:** Expand beyond a single station into a fragile network of outposts, routes, and shared infrastructure.

```mermaid
flowchart LR
    classDef future fill:#f7fbff,stroke:#9bb8d3,stroke-width:2px,color:#234,rx:10px,ry:10px
    A([Macro Maps]):::future --> B([Outposts and Supply Lines]):::future
    B --> C([Contract System]):::future
    C --> D([Advanced Map Mechanics]):::future
    D --> E([Performance and P2P Scaling]):::future
```

* [ ] **Macro Maps:** Implement planet, system, and galaxy map layers with different interaction styles.
* [ ] **Outposts and Supply Lines:** Let players establish or support remote settlements that depend on logistics.
* [ ] **Contract System:** Allow users to hire real players to pilot ships, move cargo, or maintain remote locations.
* [ ] **Advanced Map Mechanics:** Support damageable map systems, sensor authority, and physical printed fallback maps.
* [ ] **Performance & P2P Scaling:** Stabilize networking and discovery for larger sectors of the frontier.

## Phase 5: Polish, Balance & V1.0 Launch
**Goal:** Make the expanding colony stable, readable, and worth returning to.

```mermaid
flowchart LR
    classDef future fill:#f7fbff,stroke:#9bb8d3,stroke-width:2px,color:#234,rx:10px,ry:10px
    classDef milestone fill:#cce4ff,stroke:#4a90e2,stroke-width:4px,color:#12344d,rx:18px,ry:18px
    A([Automation Systems]):::future --> B([Economy Balancing]):::future
    B --> C([UX and UI Polish]):::future
    C --> D([Security and Trust]):::future
    D --> E(((Public Release))):::milestone
```

* [ ] **Automation Systems:** Add robotic starships and AI captains to scale trade and mining without pure grind.
* [ ] **Economy Balancing:** Tune scarcity, route profitability, fuel costs, item quality, and crafting times.
* [ ] **UX/UI Polish:** Refine spatial UI, terminals, maps, console interactions, and onboarding clarity.
* [ ] **Security and Trust:** Harden decentralized state reconciliation and reduce obvious cheating vectors.
* [ ] **Public Release:** Ship a version that delivers the fantasy of social survival on a growing frontier.
