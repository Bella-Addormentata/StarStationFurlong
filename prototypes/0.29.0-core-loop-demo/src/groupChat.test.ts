// groupChat.ts unit tests: id derivation is deterministic + order-insensitive,
// shape guards reject junk (hostile-peer input), the pure filter/cap helpers
// respect ordering, and the thread map / message cap enforcement produces the
// exact indices/ids the caller needs to prune inside a Yjs transact.

import { describe, expect, it } from 'vitest';
import {
  buildGroupChatThread,
  deriveGroupChatId,
  excessGroupIndices,
  excessRoomIndices,
  excessThreadIds,
  filterMessagesForGroup,
  filterMessagesForRoom,
  GROUP_CHAT_CAP,
  GROUP_TITLE_MAX,
  isGroupChatMessage,
  isGroupChatThread,
  isValidThreadEntry,
  listMyGroupChats,
  MAX_GROUP_CHATS,
  MIN_GROUP_MEMBERS,
  normalizeMembers,
  type GroupChatMessage,
  type GroupChatThread,
} from './groupChat';

// ── Member normalization + id derivation ──────────────────────────────────────

describe('groupChat · normalizeMembers', () => {
  it('sorts, de-dupes, drops non-strings and empties', () => {
    const out = normalizeMembers(['b', 'a', 'b', '', 'c']);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for an all-empty input', () => {
    expect(normalizeMembers([])).toEqual([]);
    expect(normalizeMembers(['', '', ''])).toEqual([]);
  });
});

describe('groupChat · deriveGroupChatId', () => {
  it('is deterministic and order-insensitive', () => {
    const a = deriveGroupChatId(['pub-A', 'pub-B', 'pub-C']);
    const b = deriveGroupChatId(['pub-C', 'pub-A', 'pub-B']);
    const c = deriveGroupChatId(['pub-A', 'pub-B', 'pub-C', 'pub-A']); // dups
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a.startsWith('g-')).toBe(true);
    expect(a.length).toBeGreaterThan(4); // 'g-' + hex slice
  });

  it('yields different ids for different member sets', () => {
    const a = deriveGroupChatId(['pub-A', 'pub-B']);
    const b = deriveGroupChatId(['pub-A', 'pub-C']);
    expect(a).not.toBe(b);
  });

  it('rejects fewer than MIN_GROUP_MEMBERS distinct pubs', () => {
    expect(() => deriveGroupChatId([])).toThrow();
    expect(() => deriveGroupChatId(['pub-only'])).toThrow();
    expect(() => deriveGroupChatId(['pub-only', 'pub-only'])).toThrow();
    expect(MIN_GROUP_MEMBERS).toBe(2);
  });
});

// ── Shape guards ──────────────────────────────────────────────────────────────

describe('groupChat · isGroupChatThread', () => {
  const goodMembers = normalizeMembers(['pub-A', 'pub-B', 'pub-C']);
  const goodId = deriveGroupChatId(goodMembers);
  const good: GroupChatThread = {
    v: 1, kind: 'group-chat', id: goodId, title: 'Team', members: goodMembers,
    createdAt: 1000, createdBy: 'pub-A',
  };

  it('accepts a well-formed record', () => {
    expect(isGroupChatThread(good)).toBe(true);
  });

  it('rejects primitives and null', () => {
    expect(isGroupChatThread(null)).toBe(false);
    expect(isGroupChatThread(undefined)).toBe(false);
    expect(isGroupChatThread('str')).toBe(false);
    expect(isGroupChatThread(42)).toBe(false);
  });

  it('rejects wrong version / kind', () => {
    expect(isGroupChatThread({ ...good, v: 2 })).toBe(false);
    expect(isGroupChatThread({ ...good, kind: 'not-a-group' })).toBe(false);
  });

  it('rejects missing / malformed scalar fields', () => {
    expect(isGroupChatThread({ ...good, id: '' })).toBe(false);
    expect(isGroupChatThread({ ...good, title: 42 as unknown as string })).toBe(false);
    expect(isGroupChatThread({ ...good, createdAt: NaN })).toBe(false);
    expect(isGroupChatThread({ ...good, createdAt: 'now' as unknown as number })).toBe(false);
    expect(isGroupChatThread({ ...good, createdBy: '' })).toBe(false);
  });

  it('rejects too-long titles', () => {
    const tooLong = 'x'.repeat(GROUP_TITLE_MAX + 1);
    expect(isGroupChatThread({ ...good, title: tooLong })).toBe(false);
  });

  it('rejects too-few / malformed members', () => {
    expect(isGroupChatThread({ ...good, members: ['pub-A'] })).toBe(false);
    expect(isGroupChatThread({ ...good, members: ['pub-A', 42 as unknown as string] })).toBe(false);
    expect(isGroupChatThread({ ...good, members: 'not-an-array' as unknown as string[] })).toBe(false);
  });

  it('rejects duplicate or unsorted member arrays (non-canonical)', () => {
    const dupes: GroupChatThread = { ...good, members: ['pub-A', 'pub-A', 'pub-B'], id: deriveGroupChatId(['pub-A', 'pub-B']) };
    expect(isGroupChatThread(dupes)).toBe(false);
    const unsorted: GroupChatThread = { ...good, members: ['pub-C', 'pub-A', 'pub-B'] };
    expect(isGroupChatThread(unsorted)).toBe(false);
  });

  it('rejects an id that does not match the members (hijack attempt)', () => {
    const impersonator: GroupChatThread = { ...good, id: deriveGroupChatId(['pub-Z', 'pub-Y']) };
    expect(isGroupChatThread(impersonator)).toBe(false);
  });

  it('rejects a creator who is not a member', () => {
    const outside: GroupChatThread = { ...good, createdBy: 'pub-outsider' };
    expect(isGroupChatThread(outside)).toBe(false);
  });
});

describe('groupChat · isGroupChatMessage', () => {
  it('accepts a minimal well-formed message', () => {
    expect(isGroupChatMessage({ text: 'hi', groupId: 'g-abc' })).toBe(true);
    expect(isGroupChatMessage({ text: '', groupId: 'g-abc' })).toBe(true); // empty text ok
  });

  it('rejects primitives, missing fields, wrong types', () => {
    expect(isGroupChatMessage(null)).toBe(false);
    expect(isGroupChatMessage({})).toBe(false);
    expect(isGroupChatMessage({ text: 'hi' })).toBe(false);
    expect(isGroupChatMessage({ groupId: 'g-abc' })).toBe(false);
    expect(isGroupChatMessage({ text: 42, groupId: 'g-abc' })).toBe(false);
    expect(isGroupChatMessage({ text: 'hi', groupId: '' })).toBe(false);
    expect(isGroupChatMessage({ text: 'hi', groupId: 42 })).toBe(false);
  });
});

// ── Filter helpers ────────────────────────────────────────────────────────────

describe('groupChat · filterMessagesForGroup', () => {
  const G1 = 'g-111';
  const G2 = 'g-222';
  const chat = [
    { text: 'room-1' },                              // room broadcast
    { text: 'g1-1', groupId: G1 },
    { text: 'room-2', groupId: '' },                 // empty groupId — room
    { text: 'g2-1', groupId: G2 },
    { text: 'g1-2', groupId: G1 },
    { text: 'bad-shape', groupId: 42 as unknown as string },
    { text: 'g1-3', groupId: G1 },
    null,
    'not-an-object',
  ];

  it('returns only messages tagged for that group, in order', () => {
    const out = filterMessagesForGroup(chat, G1);
    expect(out.map((m) => m.text)).toEqual(['g1-1', 'g1-2', 'g1-3']);
  });

  it('returns [] for empty / non-string groupId', () => {
    expect(filterMessagesForGroup(chat, '')).toEqual([]);
    expect(filterMessagesForGroup(chat, undefined as unknown as string)).toEqual([]);
  });
});

describe('groupChat · filterMessagesForRoom', () => {
  it('drops group-tagged messages, keeps everything else', () => {
    const chat = [
      { text: 'room-1' },
      { text: 'g1', groupId: 'g-111' },
      { text: 'room-2', groupId: '' },
      { text: 'room-3' },
      { text: 'g2', groupId: 'g-222' },
      { text: 'legacy-nogid', groupId: null },
    ];
    const out = filterMessagesForRoom(chat as unknown[]);
    expect((out as { text: string }[]).map((m) => m.text))
      .toEqual(['room-1', 'room-2', 'room-3', 'legacy-nogid']);
  });

  it('passes non-object entries through unchanged (defensive)', () => {
    const chat: unknown[] = [null, undefined, 'a', { text: 't' }, { text: 'g', groupId: 'g-1' }];
    const out = filterMessagesForRoom(chat);
    expect(out).toHaveLength(4);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBe('a');
    expect((out[3] as { text: string }).text).toBe('t');
  });
});

// ── Cap enforcement ───────────────────────────────────────────────────────────

describe('groupChat · excessGroupIndices', () => {
  it('returns [] when count <= cap', () => {
    const chat = [
      { text: '1', groupId: 'g-1' },
      { text: 'room' },
      { text: '2', groupId: 'g-1' },
    ];
    expect(excessGroupIndices(chat, 'g-1', 5)).toEqual([]);
    expect(excessGroupIndices(chat, 'g-1', 2)).toEqual([]);
  });

  it('returns the oldest N indices when the group overflows', () => {
    const chat: GroupChatMessage[] = [
      { text: '1', groupId: 'g-1' },
      { text: '2', groupId: 'g-1' },
      { text: '3', groupId: 'g-1' },
      { text: '4', groupId: 'g-1' },
      { text: '5', groupId: 'g-1' },
    ];
    const idxs = excessGroupIndices(chat, 'g-1', 3);
    // 5 messages, cap 3 → drop indices [0, 1] (oldest two)
    expect(idxs).toEqual([0, 1]);
  });

  it('is not confused by interleaved room / other-group messages', () => {
    const chat: (GroupChatMessage | { text: string })[] = [
      { text: 'g1-a', groupId: 'g-1' },   // 0
      { text: 'room-a' },                  // 1 (room)
      { text: 'g2-a', groupId: 'g-2' },   // 2 (other group)
      { text: 'g1-b', groupId: 'g-1' },   // 3
      { text: 'g1-c', groupId: 'g-1' },   // 4
      { text: 'room-b' },                  // 5 (room)
      { text: 'g1-d', groupId: 'g-1' },   // 6
    ];
    // g-1 has 4 messages at positions [0, 3, 4, 6]; cap=2 → drop the two oldest → [0, 3]
    expect(excessGroupIndices(chat, 'g-1', 2)).toEqual([0, 3]);
  });

  it('defaults to GROUP_CHAT_CAP when cap omitted', () => {
    const count = GROUP_CHAT_CAP + 3;
    const chat: GroupChatMessage[] = [];
    for (let i = 0; i < count; i++) chat.push({ text: String(i), groupId: 'g-big' });
    const idxs = excessGroupIndices(chat, 'g-big');
    expect(idxs).toEqual([0, 1, 2]);
  });

  it('treats a negative cap as zero (drop all group messages)', () => {
    const chat: GroupChatMessage[] = [
      { text: 'a', groupId: 'g-1' },
      { text: 'b', groupId: 'g-1' },
    ];
    expect(excessGroupIndices(chat, 'g-1', -5)).toEqual([0, 1]);
  });
});

// ── Roster of my threads ──────────────────────────────────────────────────────

describe('groupChat · listMyGroupChats', () => {
  const t1: GroupChatThread = {
    v: 1, kind: 'group-chat',
    id: deriveGroupChatId(['pub-A', 'pub-B']),
    title: 'Older', members: normalizeMembers(['pub-A', 'pub-B']),
    createdAt: 1000, createdBy: 'pub-A',
  };
  const t2: GroupChatThread = {
    v: 1, kind: 'group-chat',
    id: deriveGroupChatId(['pub-A', 'pub-B', 'pub-C']),
    title: 'Newer', members: normalizeMembers(['pub-A', 'pub-B', 'pub-C']),
    createdAt: 2000, createdBy: 'pub-A',
  };
  const noMe: GroupChatThread = {
    v: 1, kind: 'group-chat',
    id: deriveGroupChatId(['pub-X', 'pub-Y']),
    title: 'Nope', members: normalizeMembers(['pub-X', 'pub-Y']),
    createdAt: 500, createdBy: 'pub-X',
  };

  it('filters to threads that include the caller, sorted by createdAt', () => {
    const entries: Array<readonly [string, unknown]> = [
      [t2.id, t2], [t1.id, t1], [noMe.id, noMe],
    ];
    const out = listMyGroupChats(entries, 'pub-A');
    expect(out.map((t) => t.title)).toEqual(['Older', 'Newer']);
  });

  it('silently drops malformed thread records', () => {
    const entries: Array<readonly [string, unknown]> = [
      [t1.id, t1],
      ['junk', { hijack: true }],
      ['also-junk', null],
      ['wrong-id', { ...t1, id: 'g-attacker' }], // shape-guard rejects
    ];
    const out = listMyGroupChats(entries, 'pub-A');
    expect(out.map((t) => t.title)).toEqual(['Older']);
  });

  it('returns [] for an empty / non-string myPub', () => {
    const entries: Array<readonly [string, unknown]> = [[t1.id, t1]];
    expect(listMyGroupChats(entries, '')).toEqual([]);
    expect(listMyGroupChats(entries, undefined as unknown as string)).toEqual([]);
  });
});

describe('groupChat · excessThreadIds', () => {
  it('returns [] when the map is within cap', () => {
    const t: GroupChatThread = {
      v: 1, kind: 'group-chat',
      id: deriveGroupChatId(['pub-A', 'pub-B']),
      title: 't', members: normalizeMembers(['pub-A', 'pub-B']),
      createdAt: 1, createdBy: 'pub-A',
    };
    const entries: Array<readonly [string, unknown]> = [[t.id, t]];
    expect(excessThreadIds(entries, 10)).toEqual([]);
  });

  it('returns oldest ids when over cap, only counting valid entries', () => {
    const mk = (members: string[], ts: number): GroupChatThread => {
      const n = normalizeMembers(members);
      return {
        v: 1, kind: 'group-chat', id: deriveGroupChatId(n),
        title: `t${ts}`, members: n, createdAt: ts, createdBy: n[0],
      };
    };
    const a = mk(['pub-A', 'pub-B'], 1000);
    const b = mk(['pub-A', 'pub-C'], 2000);
    const c = mk(['pub-A', 'pub-D'], 3000);
    const junk = { not: 'a thread' };
    const entries: Array<readonly [string, unknown]> = [
      [a.id, a], [b.id, b], [c.id, c], ['junk-id', junk],
    ];
    // 3 valid + 1 junk. Cap=2 valid → oldest is `a`.
    expect(excessThreadIds(entries, 2)).toEqual([a.id]);
    // Cap=1 → drop the two oldest valid entries (a, b), keep newest (c).
    expect(excessThreadIds(entries, 1)).toEqual([a.id, b.id]);
  });

  it('defaults to MAX_GROUP_CHATS when cap omitted', () => {
    const mk = (i: number): GroupChatThread => {
      const members = normalizeMembers([`pub-${i}-A`, `pub-${i}-B`]);
      return {
        v: 1, kind: 'group-chat', id: deriveGroupChatId(members),
        title: `t${i}`, members, createdAt: i, createdBy: members[0],
      };
    };
    const entries: Array<readonly [string, unknown]> = [];
    for (let i = 0; i < MAX_GROUP_CHATS + 3; i++) {
      const t = mk(i);
      entries.push([t.id, t]);
    }
    expect(excessThreadIds(entries)).toHaveLength(3);
  });
});

// ── Factory ───────────────────────────────────────────────────────────────────

describe('groupChat · buildGroupChatThread', () => {
  it('produces a shape-guard-passing record', () => {
    const t = buildGroupChatThread({
      members: ['pub-B', 'pub-C'],
      title: 'The Trio',
      createdBy: 'pub-A',
      createdAt: 12345,
    });
    expect(isGroupChatThread(t)).toBe(true);
    expect(t.title).toBe('The Trio');
    expect(t.createdAt).toBe(12345);
    expect(t.members).toEqual(['pub-A', 'pub-B', 'pub-C']);
    expect(t.id).toBe(deriveGroupChatId(['pub-A', 'pub-B', 'pub-C']));
  });

  it('injects the creator into the member set (so a caller need not include self)', () => {
    const t = buildGroupChatThread({
      members: ['pub-B'],
      createdBy: 'pub-A',
      createdAt: 1,
    });
    expect(t.members).toContain('pub-A');
    expect(t.members).toContain('pub-B');
  });

  it('trims and de-fangs a title', () => {
    const t = buildGroupChatThread({
      members: ['pub-B'], createdBy: 'pub-A', createdAt: 1, title: '   hello   ',
    });
    expect(t.title).toBe('hello');
  });

  it('rejects an empty createdBy', () => {
    expect(() => buildGroupChatThread({
      members: ['pub-B'], createdBy: '', createdAt: 1,
    })).toThrow();
  });

  it('rejects fewer than MIN_GROUP_MEMBERS distinct members', () => {
    // just the creator = 1 member
    expect(() => buildGroupChatThread({
      members: ['pub-A'], createdBy: 'pub-A', createdAt: 1,
    })).toThrow();
    // empty member list, only self → 1 → too few
    expect(() => buildGroupChatThread({
      members: [], createdBy: 'pub-A', createdAt: 1,
    })).toThrow();
  });

  it('rejects an over-long title', () => {
    expect(() => buildGroupChatThread({
      members: ['pub-B'], createdBy: 'pub-A', createdAt: 1,
      title: 'x'.repeat(GROUP_TITLE_MAX + 1),
    })).toThrow();
  });

  it('defaults createdAt to Date.now() when omitted or non-finite', () => {
    const before = Date.now();
    const t = buildGroupChatThread({
      members: ['pub-B'], createdBy: 'pub-A',
    });
    const after = Date.now();
    expect(t.createdAt).toBeGreaterThanOrEqual(before);
    expect(t.createdAt).toBeLessThanOrEqual(after);
    const t2 = buildGroupChatThread({
      members: ['pub-B'], createdBy: 'pub-A', createdAt: NaN,
    });
    expect(Number.isFinite(t2.createdAt)).toBe(true);
  });
});

// ── Audit fix (issue #20 remediation): map-entry key/value.id consistency ────

describe('groupChat · isValidThreadEntry', () => {
  const goodMembers = normalizeMembers(['pub-A', 'pub-B']);
  const goodId = deriveGroupChatId(goodMembers);
  const good: GroupChatThread = {
    v: 1, kind: 'group-chat', id: goodId, title: 'ok',
    members: goodMembers, createdAt: 1, createdBy: 'pub-A',
  };

  it('accepts a matched (key, value) pair', () => {
    expect(isValidThreadEntry(goodId, good)).toBe(true);
  });

  it('rejects an entry whose map key does not equal value.id', () => {
    // A hostile peer's write: `key='junk'`, `value.id='g-xyz'`. The value
    // alone passes isGroupChatThread, but the mismatch would silently
    // reroute sends through activeChatThread='g-xyz' → groupsMap.get('g-xyz')
    // → undefined → ROOM lane. This entry-level guard blocks it.
    expect(isValidThreadEntry('junk', good)).toBe(false);
  });

  it('rejects non-string / empty map keys', () => {
    expect(isValidThreadEntry('', good)).toBe(false);
    expect(isValidThreadEntry(42 as unknown as string, good)).toBe(false);
    expect(isValidThreadEntry(null as unknown as string, good)).toBe(false);
    expect(isValidThreadEntry(undefined as unknown as string, good)).toBe(false);
  });

  it('rejects when the value fails isGroupChatThread (chained guard)', () => {
    expect(isValidThreadEntry(goodId, { not: 'a thread' })).toBe(false);
    expect(isValidThreadEntry(goodId, null)).toBe(false);
    // A wrong-members entry that also happens to name a valid-looking id
    // is rejected because isGroupChatThread's members↔id derivation fails.
    expect(isValidThreadEntry(goodId, { ...good, members: normalizeMembers(['pub-Z', 'pub-Y']) })).toBe(false);
  });
});

describe('groupChat · listMyGroupChats rejects mismatched-key entries (audit fix)', () => {
  it('omits a hostile entry whose key !== value.id — the chip would misroute sends', () => {
    const members = normalizeMembers(['pub-A', 'pub-B']);
    const good: GroupChatThread = {
      v: 1, kind: 'group-chat', id: deriveGroupChatId(members),
      title: 'Valid', members, createdAt: 1000, createdBy: 'pub-A',
    };
    // Hostile write pattern: map key ≠ value.id. The value alone is well-formed
    // and would pass isGroupChatThread, so the pre-fix listMyGroupChats returned
    // it and the chip fell into activeChatThread='g-xyz' → sends misrouted to
    // ROOM (see isValidThreadEntry docstring for the misrouting scenario).
    const entries: Array<readonly [string, unknown]> = [
      [good.id, good],
      ['junk-key', good], // key mismatch — value.id says good.id
    ];
    const out = listMyGroupChats(entries, 'pub-A');
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(good);
  });
});

describe('groupChat · excessThreadIds rejects mismatched-key entries (audit fix)', () => {
  it('does not count a mismatched-key entry toward the valid-cap arithmetic', () => {
    const mk = (members: string[], ts: number): GroupChatThread => {
      const n = normalizeMembers(members);
      return {
        v: 1, kind: 'group-chat', id: deriveGroupChatId(n),
        title: `t${ts}`, members: n, createdAt: ts, createdBy: n[0],
      };
    };
    const a = mk(['pub-A', 'pub-B'], 1000);
    const b = mk(['pub-A', 'pub-C'], 2000);
    // Hostile mismatched-key entry: uses `a`'s value under a bad key. The
    // pre-fix code counted this as valid and would evict `a` at cap=2 (three
    // "valid" entries → drop oldest). Post-fix: only `a` and `b` count, so
    // cap=2 returns [] and cap=1 evicts only `a`.
    const entries: Array<readonly [string, unknown]> = [
      [a.id, a],
      [b.id, b],
      ['junk-key', a],
    ];
    expect(excessThreadIds(entries, 2)).toEqual([]);
    expect(excessThreadIds(entries, 1)).toEqual([a.id]);
  });
});

// ── Audit fix (issue #20 remediation): room-lane trim is lane-independent ────

describe('groupChat · excessRoomIndices', () => {
  it('returns [] when the room lane is at/under cap', () => {
    const chat = [
      { text: 'r1' },
      { text: 'r2', groupId: '' },       // empty groupId → ROOM
      { text: 'g1', groupId: 'g-1' },
    ];
    expect(excessRoomIndices(chat, 2)).toEqual([]);
    expect(excessRoomIndices(chat, 5)).toEqual([]);
  });

  it('returns the oldest N ROOM indices when the room lane overflows', () => {
    const chat = [
      { text: 'r0' },                        // 0 ROOM
      { text: 'r1' },                        // 1 ROOM
      { text: 'g0', groupId: 'g-1' },       // 2 group — never counted here
      { text: 'r2' },                        // 3 ROOM
      { text: 'r3' },                        // 4 ROOM
    ];
    // 4 room messages at [0, 1, 3, 4], cap=2 → drop the two oldest → [0, 1].
    expect(excessRoomIndices(chat, 2)).toEqual([0, 1]);
  });

  it('does NOT count group-tagged messages toward the room cap (defect regression)', () => {
    // Simulates the audit-cited scenario: a group has 30 messages, then a
    // peer sends 200 room broadcasts. The pre-fix trim was `length - 200`
    // over the WHOLE array (30 + 200 = 230 → excess 30 → delete indices 0..29),
    // which deletes the group's entire history before its own per-group cap
    // ever fires. The lane-independent room trim leaves group messages alone.
    const chat: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i++) chat.push({ text: `g-${i}`, groupId: 'g-1' });
    for (let i = 0; i < 200; i++) chat.push({ text: `r-${i}` });
    // Room-lane count = 200 (exactly at cap) → no room trim.
    expect(excessRoomIndices(chat, 200)).toEqual([]);
    // Push one more room message → room-lane count = 201 → drop oldest room
    // message (index 30, the first r-N — indices 0..29 are the group messages
    // and MUST NOT be evicted by this lane's trim).
    chat.push({ text: 'r-200' });
    expect(excessRoomIndices(chat, 200)).toEqual([30]);
  });

  it('treats non-object + missing/empty/wrong-type groupId as ROOM (matches filterMessagesForRoom)', () => {
    const chat: unknown[] = [
      null,                                // 0 ROOM (non-object)
      'stringy',                            // 1 ROOM (non-object)
      { text: 'r0' },                      // 2 ROOM
      { text: 'r1', groupId: '' },         // 3 ROOM (empty)
      { text: 'r2', groupId: null },       // 4 ROOM (null → not string)
      { text: 'r3', groupId: 42 },         // 5 ROOM (wrong type)
      { text: 'g0', groupId: 'g-1' },      // 6 group
    ];
    // 6 room-lane entries at [0..5]; cap=3 → drop the 3 oldest ROOM → [0, 1, 2].
    expect(excessRoomIndices(chat, 3)).toEqual([0, 1, 2]);
  });

  it('treats a negative cap as zero (drop every ROOM entry)', () => {
    const chat = [
      { text: 'r' },
      { text: 'g', groupId: 'g-1' },
      { text: 'r2' },
    ];
    expect(excessRoomIndices(chat, -1)).toEqual([0, 2]);
  });
});
