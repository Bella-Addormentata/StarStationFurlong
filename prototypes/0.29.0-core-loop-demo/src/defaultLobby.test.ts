/**
 * 🪑 DEFAULT_LOBBY_FURNITURE — the Grand Lobby manifest must not be the live
 * room. World mutates `FURNITURE` to mirror whatever room you are in; anything
 * that means "the default lobby" has to read the frozen copy, or an empty
 * room's GRAND LOBBY places nothing (the bug that motivated this).
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEFAULT_LOBBY_FURNITURE, FURNITURE } from './furniture';
import { bindFurnitureDoc, readAllFurniture, seedFurnitureDefaults } from './furnitureDoc';
import { bindDoorLayoutDoc, seedDoorLayoutSingle } from './doorLayoutDoc';
import { ROOM_TEMPLATES, applyRoomTemplate } from './roomTemplates';

describe('the frozen lobby manifest', () => {
  it('is the 34-piece lobby and does not follow FURNITURE', () => {
    expect(DEFAULT_LOBBY_FURNITURE).toHaveLength(34);
    const before = DEFAULT_LOBBY_FURNITURE.length;
    // Simulate World's reconcile emptying the live array for an empty room.
    const saved = FURNITURE.splice(0, FURNITURE.length);
    try {
      expect(FURNITURE).toHaveLength(0);
      expect(DEFAULT_LOBBY_FURNITURE).toHaveLength(before);
      // …and the Grand Lobby still places the whole lobby — an un-migrated
      // room (no door set of its own) keeps every piece, the lobby having
      // been drawn against the legacy four doors.
      bindDoorLayoutDoc(new Y.Doc());
      bindFurnitureDoc(new Y.Doc());
      expect(applyRoomTemplate('lobby-1')?.name).toBe('Grand Lobby');
      expect(readAllFurniture().size).toBe(34);
      // A room that has STATED its doors — one, mid south wall — loses the
      // two armchairs that flank that doorway to its lane; nothing else.
      bindDoorLayoutDoc(new Y.Doc());
      seedDoorLayoutSingle('y+', 0);
      bindFurnitureDoc(new Y.Doc());
      applyRoomTemplate('lobby-1');
      expect(readAllFurniture().size).toBe(32);
      const ids = [...readAllFurniture().keys()];
      expect(ids).not.toContain('armchair-left-3');
      expect(ids).not.toContain('armchair-right-0');
      expect(ids).toContain('map-table'); // the north wall has no door now
      // …and a new room is seeded with the lobby, not with "nothing".
      bindDoorLayoutDoc(new Y.Doc());
      bindFurnitureDoc(new Y.Doc());
      seedFurnitureDefaults();
      expect(readAllFurniture().size).toBe(34);
    } finally {
      FURNITURE.push(...saved);
    }
  });

  it('is a deep copy — a drag on a live item cannot reach it', () => {
    const tpl = ROOM_TEMPLATES.find((t) => t.id === 'lobby-1')!;
    const live = FURNITURE.find((i) => i.id === 'lobby-chandelier')!;
    const frozen = DEFAULT_LOBBY_FURNITURE.find((i) => i.id === 'lobby-chandelier')!;
    expect(frozen).not.toBe(live);
    expect(frozen.pos).not.toBe(live.pos);
    expect(tpl.items.find((i) => i.id === 'lobby-chandelier')).not.toBe(live);
  });
});
