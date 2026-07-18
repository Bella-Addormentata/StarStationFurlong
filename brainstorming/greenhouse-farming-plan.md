# Greenhouse, Farming & The Good Life — food, fiber, and drink aboard Furlong

*Owner's vision (2026-07-18), design synthesis. Not scheduled for implementation — this document exists so the ideas are ready when we are.*

> **Companions:** [module-transform-docking-adapters-plan.md](module-transform-docking-adapters-plan.md) (#30 — ships and deep-space travel, where provisioning matters) · [chia-ventures-shared-ownership.md](chia-ventures-shared-ownership.md) (#68 — venture-owned farms, produce on the trading floor) · #69 (casino — the bar wants the distillery) · the trunk/outfit system (#35 — where shirts go) · the robot-arm staging fiction (#62 — where crop robots come from).

---

## 1. The one rule that shapes everything: food is FUN, not a chore

The owner's ruling, stated as a design invariant: **eating requirements are extremely lax — nobody should ever have to worry about food.** Furlong is a hangout game. Farming exists because growing things is satisfying, cooking and sharing meals is social, and a farm module full of green under grow-lights is a beautiful place to hang out — not because a hunger bar is nagging.

Concretely:

- **No starvation. No health loss. No death.** Ever, anywhere, from food.
- **The slop guarantee:** the main StarStation Furlong (and any room that installs one) has a **free SLOP DISPENSER** — an endless nutrient paste tap. It always works, costs nothing, and needs no supply chain. Slop keeps your clone fed, full stop.
- Being "unfed" (only possible in deep space with no dispenser, no supplies, and no farm — see §6) produces at most *cosmetic grumbles*: a stomach-growl emote, a chat sigh, maybe a droopy walk animation. It never blocks gameplay.
- Real food's job is to be **better than slop, not necessary**: small fun buffs (a sprint of speed after coffee, a glow after a shared stew), emotes, and the social ritual of a table with actual plates on it.

Everything below hangs off that rule.

## 2. The greenhouse

A **greenhouse** is a furniture-and-fixtures package, not a special module type — any module can become a farm by installing the pieces (edit mode), which keeps it compatible with everything: door policies, ventures (a co-op farm!), the exterior view (glass roof panels would look wonderful from space), and eventually ships.

**Space-honest growing tech** (the fiction leans on real controlled-environment agriculture):

- **Hydroponic racks** — the workhorse. Stacked NFT (nutrient-film) channels under amber-white grow-lights; each rack holds a few plant slots. Water + nutrient solution, no soil (soil is mass; mass is expensive in orbit).
- **Aquaponic loop** — the deluxe centerpiece: a fish tank (visible fish!) plumbed to grow beds; fish waste feeds the plants, plants clean the water. One item, one closed loop, extremely Furlong to look at. Fish are pets-with-benefits: they can *also* be a food crop, but nobody has to harvest the fish. (Most people will name them.)
- **Compact fixtures**: seed cabinet, nutrient tank, a small work counter (threshing/spinning for fiber, prep for food). A "greenhouse glass" roof/wall skin as a cosmetic hull option later (S-slice of the exterior work).

## 3. Crops

Three families, all deliberately short lists to start:

| Family | Crops (v1) | Feeds into |
|---|---|---|
| **Food** | tomato, potato, leafy greens, coffee bush | meals, buffs, the social table |
| **Fiber** | cotton, flax (→ linen) | the crafting workflow → **shirts** (§7) |
| **Brew** | barley, hops, grapes, potatoes (dual-use) | the drinks path (§8) |

Crops are per-slot records in a room-doc map (`crops`: slotId → `{ kind, plantedAt, tendedAt?, harvestedAt? }`), same discipline as furniture/doors/ventures.

## 4. Growth: derived from timestamps, never ticked

The P2P architecture makes this choice for us, and it's a good one: **growth state is a pure function of `plantedAt` and the current clock** — `stage(now − plantedAt)`. No growth ticks, no host that must stay online to advance plants, no CRDT churn. A plant seeded Tuesday *is* mature Thursday on every client that looks at it, even if the room doc slept in a cache the whole time. (This also means an away farm grows while the room is empty — durability-friendly, and honestly more like real plants.)

- Growth times tuned for a hangout cadence: fast crops in ~1 real-time hour, showpieces (grapes) a day or two. Nothing punishes absence; nothing *requires* presence.
- **Tending is optional and positive-only:** watering/pruning interactions (fun little animations) advance `tendedAt` and grant a quality bonus at harvest — better produce, never a dead plant. Untended crops still mature; they just yield standard quality. *Plants cannot die.* (The one rule, applied to the plants too.)
- Harvest writes `harvestedAt` + drops items to the room inventory; the slot replants from the seed cabinet with one click.

## 5. Robots tend the crops (if you want)

The **CROP TENDER** — a small wheeled robot (sibling fiction to the #62 robot arm: another physical requirement item, dev-granted now, EVA-sourced later) that you place in the greenhouse. What it does: automatically counts as "tending" for every slot in its room (the quality bonus without the chores), and putters around watering things for ambiance. What it deliberately does NOT do: harvest, plant, or decide anything — the fun parts stay yours. One robot per room, venture-ownable like any item. If the fireplace taught us anything, people will also move it around for fun.

## 6. Deep space: provisioning as light expedition flavor (#30 tie-in)

When modules become ships and travel away from the station (#30), the slop guarantee stays home — the station's dispenser doesn't stretch across space. A traveling ship should carry **either a pantry (stocked food supplies) or a small onboard farm** — this is the one place food becomes a *system*, and even here it stays lax:

- Provisioning is a **pre-flight checklist item, not a survival clock**: the flight console shows "PROVISIONS: 12 meals · ~6 days" the way it shows fuel. Packing is part of the expedition fantasy.
- Running out means **sad meals, not danger**: clones grumble, the cook emote gets replaced by a ration-bar chew, morale-flavored cosmetics kick in (droopy antenna on the suit?). The ship still flies; nobody dies; turning back or rationing is a story beat, not a fail state.
- A one-rack onboard farm can sustain a small crew indefinitely — which makes the farm rack a genuinely *meaningful* ship fitting (the #30 outfitting list grows: fuel tank, engine, cockpit, **farm rack or pantry**), and makes the aquaponics loop the luxury long-hauler choice.

## 7. Fiber → cloth → shirts (the crafting workflow)

The material path the owner asked for, kept to one clean chain:

**cotton/flax → (work counter: spin) → thread → (loom: weave) → cloth bolt → (tailor bench: sew) → SHIRT**

- Output lands as **outfit items in the trunk system** (#35) — the existing outfit/equip machinery is the payoff surface, no new wardrobe tech needed. Cloth color follows the crop (natural cotton, linen beige) with dye as an obvious later add (another crop family!).
- Benches are furniture (edit mode, venture-ownable). A tailor shop venture selling shirts on the trading floor (#68 offers) is exactly the kind of emergent shop the market design wants.
- Scope honesty: v1 is shirts only — one garment, whole chain proven — before hats/pants/etc.

## 8. The drinks path 🍺 (brewing & distilling)

Grown crops brew into drinks with **funny, harmless, temporary effects** — the alcohol path is a comedy system, and the same lax-rule applies (no addiction mechanics, no penalties that outlast the giggle, instant sober-up available):

- **BREWERY VAT** (furniture): barley+hops → beer · grapes → wine · anything+time → "hooch" (proudly unlabeled).
- **STILL** (furniture, gloriously copper): potatoes → vodka-class · grain → whiskey-class. Distilling doubles the wobble.
- **Effects, all cosmetic and time-limited (~2–5 min):** wobbly walk interpolation, the chat input gaining a slur filter ("hello frendss"), hiccup emotes popping as overhead bubbles (💬 the bubble system is *right there*), rosy-cheek tint on the avatar, an exaggerated ragdoll sit-down. Multiplayer comedy is the point — your friends see all of it.
- **Sober instantly** with slop or coffee (the coffee bush earns its slot). Nothing to wait out unless you're enjoying it.
- The casino bar (#69) is the natural venue: drinks as chip-priced menu items, the bartender station as the serving UI. A venture that owns the farm, the still, AND the casino is a whole economy in three rooms.
- Age-rating note for later: keep the presentation cartoon-silly (it already is), and revisit if the game ever targets younger ratings.

## 9. Economy hooks (all later, all natural)

- Produce, cloth, and bottles are **tradeable items** → offer slips on the trading floor (#68's market machinery, no new tech).
- **Venture farms**: a greenhouse module owned by a venture — shareholders all tend, harvest splits by convention (or by vote, once managers land).
- The slop dispenser stays free forever — the economy is for *nice* things, never for survival.

## 10. Sync design (nothing new to invent)

Every piece rides existing, proven patterns: `crops` map (per-slot records, T0 rebind, shape-guarded reads), items through the existing inventory/trunk paths, benches as furniture records, effects as short-lived presence flags (the seated-pose bit pattern), robots as furniture with a behavior flag. Growth needs **no wire at all** (§4). Plain-language rule throughout: players see seeds, crops, slop, hooch — never "records" or "timestamps."

## 11. Suggested slices (when we get here)

| # | Slice | Delivers |
|---|---|---|
| F1 | Hydroponic rack + 2 food crops + slop dispenser + eat action (buff + emote) | growing works; the one rule is live |
| F2 | Aquaponics loop + tending + quality + coffee | the beautiful centerpiece + the sober button |
| F3 | Fiber chain: cotton/flax → spin → weave → sew → SHIRT (trunk item) | the crafting workflow, end-to-end |
| F4 | Brewery + still + 3 drink effects | the comedy system |
| F5 | CROP TENDER robot | automation-as-ambiance |
| F6 | Ship provisioning (with #30's flight slices) | the expedition pantry |
| F7 | Market hooks: produce/bottles as offer-slip items | farms meet the trading floor |

## 12. Open questions (parked deliberately)

1. Do meals want a tiny cooking mini-game (plating at a stove) or is "combine at the counter" enough? (Lean simple; the social table is the feature, not the cooking skill.)
2. Fish naming/petting interactions — worth a tiny slice of their own? (Almost certainly yes.)
3. Dye crops and garment variety timing (after F3 proves the chain).
4. Should drink effects be visible in the exterior view? (A module full of hiccuping clones from space… probably yes.)
5. Whether hull-tile greenhouses (#66 S3 glass tiles) replace or complement rack furniture.
