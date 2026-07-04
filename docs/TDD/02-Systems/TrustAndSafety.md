# DESIGN NOTE — Room Trust, Content Safety & SsfLog

> **Status:** 🔴 Approved as Hard Gate before UGC / Custom RoomLog Substrates land (v006 §7).  
> **Topic:** Sovereign-Immutable log safety, local-operator liability boundaries, and minors protection.  
> **Date:** 2026-07-04 · **Author:** Claude Fable 6 (GitHub Copilot)

In a serverless P2P MMO, **there is no global delete**. Once an append-only log op (chat message, bulletin board contract, modular edit) is written to a topic and gossiped, it cannot be physically wiped from remote replicas we do not control. While a powerful mechanism for censorship resistance, this raises catastrophic liabilities regarding illegal content (CSAM), extreme harassment, and minors protection in an open QR-joinable lounge (Habbo Hotel vibe).

This design note lays down **four sovereign mechanisms** built directly into the local-node and database boundaries to handle takedown-less content exposure securely.

---

## 1. Co-host Refusal (The Sovereign Room Takedown)

When a player walks up to our QR code, joins, and posts user-generated content (UGC), it resides inside the room's co-host replication set. 

* **The Problem:** A malicious user posts graphic or extreme content. Individual mutes protect personal views but **do not stop feed propagation**, violating local jurisdiction laws for other players and the host.
* **The Solution:** The room's moderation set can emit a signed `mod-flag` operation onto the RoomLog.
  * **Automated Cascade Drop:** Upon receiving a verified moderating signature, all co-host nodes in the room's authority block **immediately drop** the flagged content payload from their active cache, refuse to seed or relay its payload hash via `iroh-blobs`, and omit it from future epochal **Station Seals** (compaction).
  * **Result:** The author's device retains its own local log (their personal hardware/data remains intact), but the content is **physically pruned and blacklisted** from propagating inside the room's shared spatial timeline.

---

## 2. Local-Operator Hash Denylists (The Legal Valve)

Every player-run Tauri node acts as a sovereign micro-relay. To protect hosts from personal legal liabilities under local jurisdiction laws, every node maintains a **Local Denylist**.

* **Local Enforcement:** Local node operators can load list resources (e.g., local files or aggregated community moderation lists like `ssf-list://station-default`).
* **Seeding Policy Integration:** Re-enforces the v005 seeding safety construct:
  $$\text{Seed Object} \iff (\text{Allowlisted Room Signature} \land \neg \text{Local Denylist Hash})$$
* **Result:** If a node operator receives a legal order or chooses to censor certain hashes, their machine unilaterally refuses to store, host, or relay those assets, keeping local developers and players out of legal danger.

---

## 3. Capability-Gated Room Classes

To secure minors against "drive-by" harassment while maintaining open-doors cozy spaces, rooms enforce strict **Capabilities classes** embedded in invite tokens:

```typescript
type RoomClass =
  | 'open-drive-by'   // Public lobby / QR joins. Guests have strict rate-limits and guest-held queues.
  | 'member'         // Restricted access. Requires a signed group membership token.
  | 'private-capsule' // Single-owner capsule. Direct invitation challenges only.
```

### The "Guest-Held" Chokepoint (`open-drive-by`):
1. A drive-by guest joins Furlong Station Lobby via QR without possessing a cryptographic membership key.
2. In this class, the guest's writes are routed into a local **guest buffer log** rather than committing directly to the room's main timeline.
3. Guest actions (chat, posts) are **only replicated to other peers after a room co-host has approved them** (co-host relaying).
4. This creates a natural gateway: public lobbies remain highly interactive but cannot be flooded with malicious payloads.

---

## 4. `SsfLog` — The Safe Compact Log

Our custom lightweight log (`SsfLog`), designed as a backup to `p2panda`, incorporates these safety invariants natively into its local `sqlite` database structure.

### SQLite Schema (`ssf_log.db`):
```sql
CREATE TABLE ssf_ops (
    writer BLOB NOT NULL, -- Ed25519 public key (32 bytes)
    seq INTEGER NOT NULL, -- Strictly increasing per writer
    backlink BLOB,        -- BLAKE3 hash of previous operation
    payload_hash BLOB NOT NULL, -- BLAKE3 payload hash
    timestamp_tick INTEGER NOT NULL, -- Sim tick for determinism
    kind TEXT NOT NULL,   -- "chat", "board-post", "mod-flag", "report"
    signature BLOB NOT NULL, -- Core signature
    PRIMARY KEY (writer, seq)
);

CREATE TABLE payload_cache (
    payload_hash BLOB PRIMARY KEY,
    body BLOB NOT NULL,
    flagged INTEGER DEFAULT 0 -- 1 = dropped/blacklisted locally
);
```

### Invalidation Pipeline:
When a `mod-flag` or a local denylist update hits the node:
1. The operator's engine sets `flagged = 1` inside `payload_cache` for the targeted payload hash.
2. The `body` is completely deleted or zeroed out.
3. Raw queries for the log return empty values for flagged nodes, preventing rendering.
4. Gossip sync protocols automatically skip sharing flagged payload hashes, drying up propagation channels immediately.
