# IDEAS Game Technology

> ⚠️ **Status note (2026-07-04):** original idea file, preserved as-is. The Cabal items below are realized as **RoomLog** — the Cabal *model* on Rust-native crates, not the Cabal stack ([STUDY-Architecture v006](../../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md) §5.4/§7). **"Cabal club for short term user position tracking" is formally deprecated** — positions are never written to logs or CRDTs (v006 §8.1 three-lane rule). The map-embedded network data idea lives on as room topic secrets (v005 §14). `simple-peer`/WebTorrent references are superseded by WebTransport + iroh-blobs (v006 §1).

* Communication
  * Cabal Club for short term chat message
  * Different physical game rooms saved as seperate chats

* Items
  * Store long term items in chia blockchain
  * Store game elements in simple-peer or webtorrent

* Physical Mechanics
  * Cabal club for short term user position tracking

* Community Bulletin Boards
  * Players should be able to read and edit bulletin boards by physically walking up to them and interacting with them in-world.
  * Bulletin boards can also exist as online or room-based boards, letting users post notices, jobs, trade offers, or station alerts.
  * These boards could be powered by Cabal technology so posts are local, persistent, and shared across related rooms or stations.
  * Important messages might appear in both physical station spaces and digital chat rooms, creating a shared public communication layer.

* Map-Embedded Network Data
  * WebRTC magnet links, Cabal keys, and other connection metadata could be hidden or encoded inside the game world map itself.
  * Players might discover access routes, chat rooms, or peer-to-peer channels by exploring map nodes, terminals, or station systems.
  * This makes the map feel like both a navigation tool and a secret technology layer for communication and coordination.

* Pixel Rendering
  * Game elements in 3D with Three.js, but represented as 2D parralel projection
  * When interacting with game elements, zoom in to view through 3d space.
    * Sit in desk chair for video chat etc
    * Sit in captain chair of space ship to drive
    * Sit down at casino table adn view table top

* Trade
  * Chia wallet integration for currency and special inventory items
  * Currency handled by chia
  * Spacefuel and basic inventory items act as game's House Edge
    * Can set prices for transport and give out awards for different gameplay tasks
    * Incentivize different actions with spacefuel proceeds
    * Orbital maintinance spacefuel could be used as a property tax
      * Docking or parking at other space stations could move oribital maintinance to a rental agreement with main station
      * large stations could be more efficient with maitinaance cost, incentive for group dynamics 

* Markets
  * Possible for company stocks to be traded on market
  * Bank Loads to buy ships and equipment
  * SpaceTrader-ish with House Edge funded trade routes
  * Companies can found markets and banks , transport companies etc
  * Default Station Furlong has a small automated market that prices items based on scarcity
    * Will buy supplies from freighter traders at market rates
    * Stored in space warehouse

* Crafting
  * Everquest style crafting?
  * Can incrase production with tools / machine shops

* Skill Tree slots
  * Craft furniture etc from different materials
  * Stores can sell items
  * Users can have a few skill slots that earn ranks the more they are used
    * sims style career

* Ownership
  * Spacestations should be able to be owned by individuals and comapnies
  * Can Leaseout space or rooms or machines
  * House will provide first infrastructure of spacestation etc

* Schools
  * Can speed up skill progress when taking a class from highly skilled user or AI robot teacher
  * Can be passively taught and learned when user is AFK
  * Only requires chairs, but white board and projector add speed

* AFK Activities
  * Sleep in bed
  * Sit at desk
  * Learn
  * Drive spaceship in autopilot
  * Craft repeatitive items

* Cloning
  * As a save point in case user dies
  * Users and companies can buy cloning machines
  * If users is out of money and has no credits with other cloning machines, get sent to Furlong
  * Users keep there assets after death
  * Partly lose their skill progress and memory

* Default Star Station Furlong
  * Starting station for users
  * Guided "Cloning" process on first start
  * New users get bunk bed in capsule with 12 others

* Blockchain Room Records
  * Room ownership and placement history can be anchored on-chain for tamper-resistant tracking.
  * When a module is loaded onto a freighter and later unloaded at a station, transfer records can be appended as ownership/location events.
  * This allows coins, shares, and room assets to share a common custody trail across station economies.