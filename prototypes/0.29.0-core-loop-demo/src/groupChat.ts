/**
 * 👥💬 Group chats (issue #20 — group chat threads)
 *
 * A GROUP CHAT is a named thread with a fixed member set (base64url identity
 * pubs). Its messages ride the SAME room chat array as broadcast messages,
 * tagged with a `groupId`. The UI is the filter: the CHAT app has a thread
 * picker (🌐 ROOM vs each group thread the current identity is a member of),
 * and the write path stamps the active group's id onto every send.
 *
 * Rationale (aligns with brainstorming/phone-apps-breakdown.md S5): reusing
 * the existing chat lane means no new transport, no per-group NetworkProvider,
 * and the CRDT-safe 200-cap trim already in main.ts extends trivially to a
 * per-group variant. Group threads themselves live in the room doc's Yjs
 * `groupChats` map — one shape-guarded record per thread.
 *
 * Deterministic id (`deriveGroupChatId`): the id is a hash of the sorted,
 * de-duplicated member list. Same members always yield the same id, so an
 * accidental double-create by two members merges (LWW on the record) rather
 * than forking into two parallel histories.
 *
 * Bounded size (each lane trims IN-PLACE on its own membership so unrelated
 * lane activity cannot evict the other lane's history, THEN a global cap
 * runs as a safety net for anything the per-lane trims cannot see):
 *   - `GROUP_CHAT_CAP` (200) — max messages per thread. Enforced on send by
 *     `excessGroupIndices` — scans the array for THAT groupId and returns the
 *     oldest overflow indices; caller deletes DESC in a single Yjs transact.
 *   - Room lane: parallel per-lane cap (`main.ts::ROOM_CHAT_CAP` = 200,
 *     also matched to 200 by design). Enforced on send by `excessRoomIndices`
 *     — same pattern, filtered on non-group entries. The pre-fix trim was
 *     `sharedChat.length - 200` over the WHOLE array, which counted group
 *     messages toward the room budget and deleted from index 0 (typically an
 *     older group message), so a room-message burst silently ate a group's
 *     history before its own per-group cap fired.
 *   - `TOTAL_CHAT_CAP` (2000) — GLOBAL safety net. The per-lane trims only
 *     touch lanes THIS client recognizes (its own active groupId or the room
 *     lane). A hostile peer that writes N messages each tagged with a distinct
 *     fresh groupId ('junk-1', 'junk-2', …) escapes BOTH per-lane trims: no
 *     current active groupId matches, and the room-lane guard excludes non-
 *     empty string groupIds. The global cap catches that class of attack,
 *     evicting oldest entries regardless of lane, with a generous headroom
 *     (~10 active groups' worth) over the sum of per-lane caps so honest use
 *     never trips it. Enforced on send via `excessTotalIndices`.
 *   - `MAX_GROUP_CHATS` (64) — hard cap on the thread map so a hostile peer
 *     can't grow the doc without bound by writing thread records.
 *
 * Hostile-peer discipline (verify EVERY read of a shared map value; a room
 * peer can write junk into any shared map / array key):
 *   - Value shape: `isGroupChatThread` — kind + version, canonical member
 *     list, id-must-match-members-hash, creator-must-be-a-member.
 *   - Map entry: `isValidThreadEntry(key, value)` — chains the value guard
 *     AND requires the map KEY to equal `value.id`. Own writes always use
 *     `groupsMap.set(thread.id, thread)` so the invariant holds locally,
 *     but a hostile peer's mismatched-key write (`key='junk'`,
 *     `value.id='g-xyz'`) would produce a chip whose activation sets
 *     `activeChatThread='g-xyz'` — and every downstream `groupsMap.get('g-xyz')`
 *     misses (the actual key is 'junk'), so the send-path guard's
 *     `isGroupChatThread(groupsMap.get(threadTarget))` returns false and the
 *     message silently falls back to the ROOM lane. `isValidThreadEntry`
 *     drops the chip so no send is misrouted; both `listMyGroupChats` and
 *     `excessThreadIds` use this same entry guard for consistency.
 *
 * Privacy: v1 is private-by-UI, not private-by-crypto. Every room member
 * replicates the shared chat array, so anyone with the room doc can filter to
 * a group id and read its messages. E2E-sealed threads are RoomLog work
 * (Phase 2). The Chat app copy carries the honest limits note.
 */

import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex } from '@noble/hashes/utils';

// ── Constants ────────────────────────────────────────────────────────────────

/** Per-thread message cap. Kept identical to the room-chat cap in main.ts so
 *  a group thread and the broadcast lane share the same bound. */
export const GROUP_CHAT_CAP = 200;

/** Hard limit on the group-thread map. A cap here is not defensive alone — it
 *  also protects the CRDT (a peer flooding thread records is a DOS vector on
 *  every viewer's disk + observer fan-out). */
export const MAX_GROUP_CHATS = 64;

/** Minimum members for a coherent group chat. A one-member "group" is a
 *  notepad, not a chat — DMs cover the two-person case (directMessages.ts). */
export const MIN_GROUP_MEMBERS = 2;

/** Title bound. Deliberately LARGER than identity's PLAYER_NAME_MAX_LENGTH
 *  (24) — group titles read naturally longer than personal names ("Design
 *  Team Q3", "Engineering Standup Wednesday") — but still bounded so a
 *  hostile peer can't blow up the doc / UI with a multi-KB "title". Kept
 *  in-lockstep with the isGroupChatThread guard and the buildGroupChatThread
 *  factory: any title above this cap is rejected on read AND on write. */
export const GROUP_TITLE_MAX = 60;

/** Hard cap on the shared chat array as a WHOLE — a safety net over and
 *  above the per-lane caps. Rationale: the per-lane trims (excessRoomIndices,
 *  excessGroupIndices) only touch lanes THIS client recognizes — the room
 *  lane and the exact groupId the local send was for. A hostile peer that
 *  writes N messages each tagged with a distinct fresh groupId ('junk-1',
 *  'junk-2', …) escapes both: none of the current viewer's active groupIds
 *  ever match, and the room-lane guard excludes anything with a non-empty
 *  string groupId. Without a global bound the array grows without limit and
 *  every honest peer replicates the bloat to disk + memory.
 *
 *  The pre-audit trim `sharedChat.length - 200; delete(0, excess)` was WRONG
 *  for a different reason (it mixed the two lanes on one budget and evicted
 *  legitimate group history when the room lane burst) but it did enforce
 *  SOME global bound. Removing it fixed the mixing but opened the unbounded-
 *  growth attack. Reinstating a global cap ALONGSIDE the per-lane trims is
 *  the belt-and-braces fix the audit calls out.
 *
 *  Cap sized to cover legitimate mixed use — ROOM_CHAT_CAP + a handful of
 *  active groups at GROUP_CHAT_CAP each — while still catching sustained
 *  bloat well before it hurts. 2000 = 200 room + ~9 fully-primed groups
 *  worth of headroom, which is well past any realistic room's live activity
 *  window. Once exceeded, the trim evicts oldest entries regardless of lane:
 *  under a hostile-injection scenario the oldest entries ARE the injected
 *  junk (or, in a sustained attack, honest history that has already exceeded
 *  its lane cap and been trimmed there). */
export const TOTAL_CHAT_CAP = 2000;

// ── Types ────────────────────────────────────────────────────────────────────

/** A group-chat thread record in the room doc's `groupChats` map. Whole-value
 *  LWW write: never mutate nested fields in place (Yjs discipline in
 *  casinoDoc.ts header). Every field is present on every valid write, and the
 *  guard below is the ONLY way an entry enters app state — hostile peers can
 *  write junk. */
export interface GroupChatThread {
  v: 1;
  kind: 'group-chat';
  /** Derived from the sorted member list — see deriveGroupChatId. */
  id: string;
  /** Human title (may be empty; the UI falls back to a derived label). */
  title: string;
  /** Sorted, de-duplicated base64url pubs — the frozen membership. */
  members: string[];
  createdAt: number;
  /** Creator's base64url identity pub (denormalized for display / audit). */
  createdBy: string;
}

/** A chat entry that has been TAGGED with a group id — i.e. it belongs to a
 *  thread. `authorPub` is preferred (canonical); `authorId` (legacy players
 *  map key) is retained for pre-slice back-compat. */
export interface GroupChatMessage {
  authorId?: string;
  authorPub?: string;
  authorName?: string;
  text: string;
  groupId: string;
  ts?: number;
  /** Legacy tick counter (main.ts writes it for room-chat) — retained on
   *  group messages so the shape stays a superset of the broadcast entry. */
  atTick?: number;
  scope?: string;
  atX?: number;
  atZ?: number;
}

// ── Membership normalization + id derivation ─────────────────────────────────

/** Sort + de-dupe + strip empties. The invariant every id-deriving and guard
 *  path relies on: `members` is exactly the canonical set for its identity. */
export function normalizeMembers(members: readonly string[]): string[] {
  const s = new Set<string>();
  for (const m of members) {
    if (typeof m === 'string' && m) s.add(m);
  }
  return [...s].sort();
}

/** Deterministic thread id from a member list (order- and dup-insensitive).
 *  Two clients naming the exact same member set always agree on the id — an
 *  accidental double-create merges via LWW on the record instead of forking. */
export function deriveGroupChatId(members: readonly string[]): string {
  const sorted = normalizeMembers(members);
  if (sorted.length < MIN_GROUP_MEMBERS) {
    throw new Error(`group chat needs at least ${MIN_GROUP_MEMBERS} distinct members`);
  }
  // Domain-tag + version the hash input — same discipline as keypair
  // nameCertBytes / contacts cardSignBytes: prevents cross-domain collisions.
  const bytes = new TextEncoder().encode(`ssf-group-chat:v1:${sorted.join('|')}`);
  return `g-${bytesToHex(sha512(bytes)).slice(0, 24)}`;
}

// ── Shape guards (verify-on-read) ────────────────────────────────────────────

/** True iff `x` is a well-formed thread record whose id matches its members.
 *  Rejects wrong kind, missing/malformed fields, non-canonical member order,
 *  and an id that doesn't match the members (a peer trying to hijack a well-
 *  known id with a different member list is rejected here). */
export function isGroupChatThread(x: unknown): x is GroupChatThread {
  if (!x || typeof x !== 'object') return false;
  const o = x as Partial<GroupChatThread>;
  if (o.v !== 1 || o.kind !== 'group-chat') return false;
  if (typeof o.id !== 'string' || !o.id) return false;
  if (typeof o.title !== 'string') return false;
  if (o.title.length > GROUP_TITLE_MAX) return false;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return false;
  if (typeof o.createdBy !== 'string' || !o.createdBy) return false;
  if (!Array.isArray(o.members) || o.members.length < MIN_GROUP_MEMBERS) return false;
  for (const m of o.members) if (typeof m !== 'string' || !m) return false;
  // Members must be canonical (sorted + unique) so the id derivation is
  // reproducible from the record as stored.
  const canonical = normalizeMembers(o.members);
  if (canonical.length !== o.members.length) return false;
  for (let i = 0; i < canonical.length; i++) if (canonical[i] !== o.members[i]) return false;
  if (deriveGroupChatId(canonical) !== o.id) return false;
  // Creator must be a member (or the record is nonsense).
  if (!o.members.includes(o.createdBy)) return false;
  return true;
}

/** True iff the map entry `(key, value)` is a well-formed thread record whose
 *  map KEY equals `value.id`. Own writes go through `groupsMap.set(thread.id,
 *  thread)` so the invariant always holds locally — but a hostile peer can
 *  freely write both fields, e.g. `key='junk'` with `value.id='g-xyz'`. That
 *  value alone would pass `isGroupChatThread`, so `listMyGroupChats` would
 *  surface it as a chip whose `dataset.thread = 'g-xyz'`. Every downstream
 *  send-path lookup then reads `groupsMap.get('g-xyz')` — which misses (the
 *  actual map key is 'junk') — and silently falls back to the ROOM lane. The
 *  user thinks they are sending into a group, but their message goes to room
 *  broadcast. Failing the guard here means the chip never appears, so no send
 *  can be misrouted. */
export function isValidThreadEntry(
  key: unknown,
  value: unknown,
): value is GroupChatThread {
  if (typeof key !== 'string' || !key) return false;
  if (!isGroupChatThread(value)) return false;
  return value.id === key;
}

/** True iff `x` is a chat entry that is a well-formed group message (has a
 *  non-empty groupId and a string text). Deliberately does NOT verify the
 *  groupId names an existing thread — the caller decides the resolution
 *  policy (a valid message may arrive before its thread record, or the
 *  record may have aged out beyond the map cap). */
export function isGroupChatMessage(x: unknown): x is GroupChatMessage {
  if (!x || typeof x !== 'object') return false;
  const o = x as Partial<GroupChatMessage>;
  if (typeof o.text !== 'string') return false;
  if (typeof o.groupId !== 'string' || !o.groupId) return false;
  return true;
}

// ── Filtering / cap helpers (pure) ───────────────────────────────────────────

/** Every message in `all` tagged for exactly one groupId, guarded. */
export function filterMessagesForGroup(
  all: readonly unknown[],
  groupId: string,
): GroupChatMessage[] {
  if (typeof groupId !== 'string' || !groupId) return [];
  const out: GroupChatMessage[] = [];
  for (const item of all) {
    if (!isGroupChatMessage(item)) continue;
    if (item.groupId !== groupId) continue;
    out.push(item);
  }
  return out;
}

/** Every message in `all` that is NOT a group message (i.e. the broadcast
 *  room chat). Deliberately keeps legacy entries whose `groupId` field is
 *  absent, null, empty, or of the wrong type — those all count as ROOM. */
export function filterMessagesForRoom<T>(all: readonly T[]): T[] {
  return all.filter((m) => {
    if (!m || typeof m !== 'object') return true;
    const g = (m as { groupId?: unknown }).groupId;
    return !(typeof g === 'string' && g);
  });
}

/** Indices (into the FULL chat array) of the OLDEST group-messages that must
 *  be removed to bring `groupId`'s count down to `cap`. Returned in ASCENDING
 *  order — the caller should delete DESC (highest index first) so intermediate
 *  indices stay valid inside the Yjs transaction. */
export function excessGroupIndices(
  all: readonly unknown[],
  groupId: string,
  cap: number = GROUP_CHAT_CAP,
): number[] {
  if (cap < 0) cap = 0;
  const idxs: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (isGroupChatMessage(m) && m.groupId === groupId) idxs.push(i);
  }
  const excess = idxs.length - cap;
  if (excess <= 0) return [];
  return idxs.slice(0, excess); // OLDEST first — matches array position order
}

/** Indices (into the FULL chat array) of the OLDEST ROOM messages that must
 *  be removed to bring the room-lane count down to `cap`. Mirror of
 *  `excessGroupIndices` for the room broadcast lane — the room and group
 *  lanes must trim INDEPENDENTLY (each keyed on its own inclusion rule),
 *  otherwise a burst of room activity would push the room-only cap `excess`
 *  positive on the WHOLE array and evict from index 0 — usually the oldest
 *  group message, not the oldest room message.
 *
 *  Returned ASCENDING (same convention as `excessGroupIndices`), so the
 *  caller deletes DESC inside a Yjs transact to keep intermediate indices
 *  valid.
 *
 *  "ROOM" mirrors `filterMessagesForRoom`'s inclusion rule exactly: anything
 *  that is not an object with a valid (string + non-empty) `groupId` is ROOM.
 *  Legacy pre-slice entries and any defensive non-object entries fall here. */
export function excessRoomIndices(
  all: readonly unknown[],
  cap: number,
): number[] {
  if (cap < 0) cap = 0;
  const idxs: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (!m || typeof m !== 'object') {
      // Non-object entries are ROOM by fallback (matches filterMessagesForRoom).
      idxs.push(i);
      continue;
    }
    const g = (m as { groupId?: unknown }).groupId;
    if (!(typeof g === 'string' && g)) idxs.push(i);
  }
  const excess = idxs.length - cap;
  if (excess <= 0) return [];
  return idxs.slice(0, excess); // OLDEST first — matches array position order
}

/** Indices (into the FULL chat array) of the OLDEST entries that must be
 *  removed to bring the whole-array size down to `cap`. Runs AFTER the per-
 *  lane trims as a safety net: any entry the per-lane trims failed to catch
 *  (unrecognized-groupId injections from a hostile peer) still gets bounded
 *  here. Trims oldest-first regardless of lane — under a hostile-injection
 *  scenario the oldest entries ARE the injected junk; under a legitimate
 *  scenario the per-lane trims already fired first, so this helper returns
 *  [] until real activity crosses the (deliberately generous) global bound.
 *
 *  Returned ASCENDING (same convention as the per-lane helpers), so the
 *  caller deletes DESC inside a Yjs transact to keep intermediate indices
 *  valid. Deliberately does NOT peek at message shapes — the whole point of
 *  a global bound is that it doesn't trust the lane taxonomy at all. */
export function excessTotalIndices(
  totalLength: number,
  cap: number = TOTAL_CHAT_CAP,
): number[] {
  if (cap < 0) cap = 0;
  if (!Number.isFinite(totalLength) || totalLength <= cap) return [];
  const excess = totalLength - cap;
  const out: number[] = new Array(excess);
  for (let i = 0; i < excess; i++) out[i] = i; // oldest first
  return out;
}

/** Which threads is `myPub` a member of? Silently rejects any map entry that
 *  fails the entry guard (`isValidThreadEntry` — checks both the value shape
 *  AND that its `id` equals the map key). Hostile peers can't inject
 *  themselves into the picker, and they can't produce a chip whose id-labelled
 *  activation would misroute sends to the ROOM lane (see isValidThreadEntry
 *  for the misrouting scenario the key-vs-id check closes).
 *  Sorted by createdAt (stable oldest-first order for the UI). */
export function listMyGroupChats(
  threads: Iterable<readonly [string, unknown]>,
  myPub: string,
): GroupChatThread[] {
  if (typeof myPub !== 'string' || !myPub) return [];
  const out: GroupChatThread[] = [];
  for (const [k, v] of threads) {
    if (!isValidThreadEntry(k, v)) continue;
    if (!v.members.includes(myPub)) continue;
    out.push(v);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Ids of the oldest VALID thread records to evict when the map exceeds
 *  `cap`. The caller applies the deletion via a Yjs transact. Malformed
 *  entries (rejected by `isValidThreadEntry` — including mismatched key /
 *  value.id records a hostile peer could write) are NOT returned — pruning
 *  them belongs to a separate housekeeping pass so we don't confuse "over
 *  cap" with "corrupt". Same-guard as the picker (`listMyGroupChats`) so a
 *  record shown as a chip and a record counted toward the cap are the exact
 *  same set: an attacker cannot skew the cap arithmetic with mismatched
 *  entries to steer eviction of legitimate threads. */
export function excessThreadIds(
  threads: Iterable<readonly [string, unknown]>,
  cap: number = MAX_GROUP_CHATS,
): string[] {
  if (cap < 0) cap = 0;
  const valid: Array<{ id: string; createdAt: number }> = [];
  for (const [k, v] of threads) {
    if (!isValidThreadEntry(k, v)) continue;
    valid.push({ id: k, createdAt: v.createdAt });
  }
  const excess = valid.length - cap;
  if (excess <= 0) return [];
  valid.sort((a, b) => a.createdAt - b.createdAt);
  return valid.slice(0, excess).map((x) => x.id);
}

// ── Convenience: build a fresh thread record (client-side factory) ───────────

/** Build a canonical thread record from user input. Validates member count,
 *  normalizes the list, derives the id. Never persists — the caller does that
 *  in a Yjs transact. Throws on invalid input so a UI-level try/catch can
 *  surface the exact reason (matching the rest of the app's factories). */
export function buildGroupChatThread(input: {
  members: readonly string[];
  title?: string;
  createdBy: string;
  createdAt?: number;
}): GroupChatThread {
  if (typeof input.createdBy !== 'string' || !input.createdBy) {
    throw new Error('createdBy must be a base64url pub');
  }
  const members = normalizeMembers([...input.members, input.createdBy]);
  if (members.length < MIN_GROUP_MEMBERS) {
    throw new Error(`group chat needs at least ${MIN_GROUP_MEMBERS} distinct members`);
  }
  const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
  if (rawTitle.length > GROUP_TITLE_MAX) {
    throw new Error(`title must be at most ${GROUP_TITLE_MAX} characters`);
  }
  const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
    ? input.createdAt
    : Date.now();
  const id = deriveGroupChatId(members);
  return { v: 1, kind: 'group-chat', id, title: rawTitle, members, createdAt, createdBy: input.createdBy };
}
