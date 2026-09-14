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
cd prototypes/0.29.0-core-loop-demo
npm install
npm run dev
```

Full setup instructions: [prototypes/0.29.0-core-loop-demo/README.md](prototypes/0.29.0-core-loop-demo/README.md)

> **Which folder is current?** The one named by `RELEASE_FRONTEND` in
> [release.yml](.github/workflows/release.yml) — that is the demo a tagged release
> actually ships as the app. The folder's version prefix is the release line it was
> *started* on, not the current version: `0.29.0-core-loop-demo` is what v0.35.0
> ships. Earlier `0.2x` folders are frozen and kept for reference.

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

---

## Cutting a release

A `vX.Y.Z` tag triggers [release.yml](.github/workflows/release.yml), which builds the
Tauri app from `RELEASE_FRONTEND` and uploads the `ssf-p2p-node` binaries. Two things
have to be true **before** the tag is pushed. The workflow checks both on the tagged tree
(the *Release guard* step) and stops — no tag created on the manual path, no draft on
either — if one is off; it names the mismatch but does not fix it for you:

1. **`## Unreleased` must already be renamed to `## vX.Y.Z — <date>`.** The release body
   is extracted with `awk '/^## v/{n++; next} n==1{print}'` — the first `## v...`
   section, deliberately skipping `Unreleased`. Tag without doing this and the release
   ships the *previous* version's notes. Leave genuinely unshipped work under a fresh
   `## Unreleased` above it.
2. **The version is bumped in all NINE places.** `grep` for the old version finds seven
   and misses both `Cargo.lock` crate entries.
   [`src/version.ts`](prototypes/0.29.0-core-loop-demo/src/version.ts) carries the
   authoritative list and is itself the ninth — follow the note there, not a blind
   search-and-replace.

Pushing the tag is the usual trigger, not the only one. When `refs/tags` pushes are
refused from where you are (the environment that prepared v0.35.0 could push branches
but 403'd on tags), start the same workflow by hand — **Actions → 🚀 Publish Sovereign
Releases → Run workflow**, or

```bash
gh workflow run release.yml -f tag=vX.Y.Z -f target=<commit sha>
```

`target` is the commit to tag. Name it explicitly whenever `main` has moved past the
commit you smoke-tested; blank means the head of the ref you dispatched from. The
workflow runs the guard on that commit, creates the annotated tag itself, and then runs
the ordinary pipeline. A tag that already exists is reused exactly as it stands — never
moved — which also makes this the way to re-run a release whose earlier run failed.
Dispatch from `main` (the trigger lives there); the built tree still comes from the
tag's commit. The two conditions above are properties of that commit and are guarded
the same way on both paths; release runs are serialized, so a second start for the same
tag queues behind the first rather than disturbing its draft.

### CHANGELOG and TODO entries: add them at merge time

`CHANGELOG.md` and `TODO.md` are both prepend-at-the-top files, so **every** open branch
that edits them collides with whichever one merges first. With a deep PR queue that means
one merge can leave twenty branches conflicting on documentation alone.

So: **don't edit `CHANGELOG.md` or `TODO.md` in a feature branch.** Once the PR lands, add
the entry to `main` in a follow-up commit. The conflicts this avoids are pure overhead —
nobody ever disagreed about the code.

⚠️ **The follow-up commit is mandatory, not optional.** A squash-merge message is good
context and belongs in the history, but it is **not** a substitute: `release.yml` reads
`CHANGELOG.md` and nothing else — there is no step that imports commit messages. An entry
that exists only in a merge message is absent from the release body, which is the exact
failure this whole section exists to prevent. If you skip the follow-up, the change ships
undocumented.

*(If the queue grows enough that even this chafes, the standard fix is changelog
fragments — one `changelog.d/<pr>.md` per PR, concatenated at release. That needs a step
added to the release workflow, so it is a deliberate change rather than a convention.)*
