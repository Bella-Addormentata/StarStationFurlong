// directMessages.ts unit tests for the audit-remediation DM block filter.
// The transport / session lifecycle is a network-heavy path and stays out of
// scope here — this test file exercises ONLY the pure helper that keeps the
// BLOCK confirm()'s "DM messages will stop appearing on your screen" promise
// honest. Regression test for issue #20 (audit finding #1).

import { describe, expect, it } from 'vitest';
import { filterOutBlockedDms } from './directMessages';

// The helper accepts anything with an `author` string — mirror the real
// DirectMessage shape for readability without importing types the helper
// itself doesn't require.
type Msg = { author: string; text: string; ts: number };
const m = (author: string, text: string, ts: number): Msg => ({ author, text, ts });

describe('directMessages · filterOutBlockedDms', () => {
  it('returns everything (shallow copy) and hidden=0 when the block set is empty', () => {
    const msgs = [m('pub-A', 'hi', 1), m('pub-B', 'yo', 2)];
    const out = filterOutBlockedDms(msgs, new Set());
    expect(out.hidden).toBe(0);
    expect(out.visible).toEqual(msgs);
    // Shallow copy — the caller may mutate the returned array without
    // clobbering the source (matches the room-chat filter's convention).
    expect(out.visible).not.toBe(msgs);
  });

  it('drops messages whose author is on the block set, preserves order', () => {
    const msgs = [
      m('pub-A', 'from A #1', 1),
      m('pub-B', 'from B #1', 2), // blocked
      m('pub-A', 'from A #2', 3),
      m('pub-B', 'from B #2', 4), // blocked
      m('pub-C', 'from C', 5),
    ];
    const out = filterOutBlockedDms(msgs, new Set(['pub-B']));
    expect(out.hidden).toBe(2);
    expect(out.visible.map((x) => x.text)).toEqual(['from A #1', 'from A #2', 'from C']);
  });

  it('blocking the DM peer hides every remote message; our own outbound stays', () => {
    // The realistic DM shape: only two possible authors — us and the peer.
    // Blocking the peer must NOT hide our own messages (we do not block
    // ourselves). This is the exact scenario the BLOCK confirm() copy
    // promises to handle for the DM lane.
    const me = 'pub-me';
    const peer = 'pub-peer';
    const msgs = [
      m(peer, 'hey', 1),
      m(me, 'hi back', 2),
      m(peer, 'anyone home?', 3),
      m(me, 'still here', 4),
    ];
    const out = filterOutBlockedDms(msgs, new Set([peer]));
    expect(out.hidden).toBe(2);
    expect(out.visible.every((x) => x.author === me)).toBe(true);
    expect(out.visible.map((x) => x.text)).toEqual(['hi back', 'still here']);
  });

  it('ignores non-string / missing / empty author fields (defensive)', () => {
    // Should never happen for verified DM messages (verifyMessage guards),
    // but the filter must not crash on malformed input if a caller ever
    // hands it something unverified.
    const msgs: Array<{ author?: unknown; text: string }> = [
      { author: 'pub-A', text: 'ok' },
      { author: '', text: 'empty' },
      { author: null, text: 'null' },
      { author: 42, text: 'wrong type' },
      { text: 'missing' },
      { author: 'pub-B', text: 'blocked' },
    ];
    const out = filterOutBlockedDms(msgs, new Set(['pub-B']));
    expect(out.hidden).toBe(1);
    expect(out.visible.map((x) => x.text)).toEqual(['ok', 'empty', 'null', 'wrong type', 'missing']);
  });

  it('unblocking restores messages on the next call (no stateful cache)', () => {
    // The helper is pure — a subsequent call with a different set is a
    // fresh evaluation, which is what the DM overlay relies on when
    // subscribeBlockList fires a repaint after an UNBLOCK click.
    const msgs = [m('pub-A', '1', 1), m('pub-B', '2', 2)];
    const withBlock = filterOutBlockedDms(msgs, new Set(['pub-B']));
    expect(withBlock.visible.map((x) => x.text)).toEqual(['1']);
    const afterUnblock = filterOutBlockedDms(msgs, new Set());
    expect(afterUnblock.visible.map((x) => x.text)).toEqual(['1', '2']);
    expect(afterUnblock.hidden).toBe(0);
  });

  it('empty input yields empty output, hidden=0', () => {
    const out = filterOutBlockedDms([], new Set(['pub-A']));
    expect(out.visible).toEqual([]);
    expect(out.hidden).toBe(0);
  });

  it('everything hidden returns empty visible with matching hidden count', () => {
    // The renderDmMessages() branch that shows the "🚫 N hidden from a blocked
    // contact" prompt in the empty-pane state depends on this shape.
    const msgs = [m('pub-B', '1', 1), m('pub-B', '2', 2), m('pub-B', '3', 3)];
    const out = filterOutBlockedDms(msgs, new Set(['pub-B']));
    expect(out.visible).toEqual([]);
    expect(out.hidden).toBe(3);
  });
});
