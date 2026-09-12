/**
 * 🚪 doorLayoutDoc — #66 S2 tests.
 *
 * Locks the four contracts the S2 "edit-mode STRUCTURE carry UX for doors"
 * pass promised:
 *
 *  1. **Carry-place / keypad slide SHAPE PARITY.** The edit-mode door drag
 *     (`editMode.commitDoorDrag`) and the keypad slide (`docking.ts`
 *     `slide-neg`/`slide-pos`) BOTH write through `writeDoorLayout({...rec,
 *     lateral, placed:true})` after the #18 fold retired the split store. The
 *     "one source of truth" invariant is that a keypad step and a drag place
 *     produce records the reader cannot distinguish — same keys, same types,
 *     same on-read normalization. A future refactor that resurrected two
 *     write paths would break this test before it could ship.
 *
 *  2. **Clamp-on-shrink (S2 read-side safety net).** The wall's slide limit
 *     `doorLateralLimitForWall` is DYNAMIC — it shrinks with the room. A door
 *     placed at lateral 4 on a 5×5 wall is legal there (limit 4) and stays
 *     recorded at 4 even after the owner shrinks the room to 1×1 (limit 1),
 *     because the reconcile re-poses from records rather than editing them.
 *     Without a read-side clamp, `reposeDoorTargets` renders that door 3 m past
 *     the wall corner. The clamp lives in `readAllDoorLayout` so every
 *     consumer (reposeDoorTargets, physicalDoorPose, paired vestibules) sees
 *     the door back on-wall on the next observe notify.
 *
 *  3. **Hostile placement junk fails safe.** Records that fail the shape guard
 *     (bad wall, missing id, non-finite lateral, entry keyed under a different
 *     id than it names, wrong types) are SKIPPED — never propagated to the
 *     renderer, never crash the reader, never mint a phantom door. Malformed
 *     labels are sanitized (over-length trimmed, whitespace-only dropped).
 *
 *  4. **Paired-door refusal contract.** The pairing gate that blocks a door
 *     move ("Unpair this door first — open its keypad") is enforced on TWO
 *     sides in `editMode.beginDoorDrag` and `docking.ts` (`slide-neg`/`slide-pos`
 *     both early-return when `pairedSuccessfully`). Both check
 *     `dockingSystem.isDoorPaired(doorId)` — those are behavioural tests that
 *     require wiring the docking system. The DOC layer here has no coupling
 *     to pairing (it just accepts writes), so the contract test here is the
 *     structural one: neither write path may bypass validation, and both write
 *     shapes must round-trip through the doc identically (covered by test 1).
 *
 * Discipline follows floorPlanDoc.test.ts: fresh Y.Doc per test,
 * `bindDoorLayoutDoc` and `bindFloorPlan` bound to the SAME doc so the door
 * layer's `doorLateralLimitForWall` sees the floor plan's live dims, hostile
 * writes exercised through `doc.getMap('doorLayout').set(...)` (the write-side
 * sanitizer never touched), and specific-value assertions on both the read
 * API and the raw map contents.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindDoorLayoutDoc,
  readAllDoorLayout,
  writeDoorLayout,
  isDoorLayoutRecord,
  defaultDoorLayoutRecords,
  type DoorLayoutRecord,
} from './doorLayoutDoc';
import {
  bindFloorPlan,
  writeRoomDims,
  doorLateralLimitForWall,
} from './floorPlanDoc';

let doc: Y.Doc;
let doorLayoutMap: Y.Map<unknown>;

beforeEach(() => {
  doc = new Y.Doc();
  // Bind BOTH docs to the same Y.Doc so the door layer's clamp reads the
  // floor plan's live dims — the production main.ts wiring binds them both to
  // the room doc on entry.
  bindDoorLayoutDoc(doc);
  bindFloorPlan(doc);
  doorLayoutMap = doc.getMap('doorLayout');
});

// ── 1. Carry-place / keypad slide shape parity ───────────────────────────────

describe('writeDoorLayout: drag place and keypad step produce identical record shape (#66 S2)', () => {
  it('a keypad slide and a drag commit write the same record fields for the same door', () => {
    // 🚪 The KEYPAD path (docking.ts:slide-neg/pos):
    //   const rec = readAllDoorLayout().get(doorId);
    //   writeDoorLayout({ ...rec, lateral: stepped, placed: true });
    // 🚪 The DRAG path (editMode.commitDoorDrag):
    //   const rec = readAllDoorLayout().get(doorId);
    //   writeDoorLayout({ ...(rec ?? defaults), id, wall, lateral, placed: true });
    // Both call writeDoorLayout with EVERY authoritative field set, `placed:
    // true`, and a caller-clamped lateral. Simulate both here.
    const drag: DoorLayoutRecord = {
      id: 'd:foo',
      wall: 'y-',
      lateral: 2,
      size: 'large',
      enabled: true,
      placed: true,
    };
    writeDoorLayout(drag);
    const afterDrag = readAllDoorLayout().get('d:foo');

    // Overwrite the SAME door with a keypad-shape write (spread of prior + new
    // lateral + placed:true — this is the exact template both call sites use).
    const keypad: DoorLayoutRecord = {
      ...(afterDrag as DoorLayoutRecord),
      lateral: 3,
      placed: true,
    };
    writeDoorLayout(keypad);
    const afterKeypad = readAllDoorLayout().get('d:foo');

    // Both round-trips give a record with the same set of keys and same types
    // — the doc reader cannot tell which writer produced it.
    expect(afterKeypad).toBeDefined();
    expect(new Set(Object.keys(afterKeypad!))).toEqual(new Set(Object.keys(afterDrag!)));
    expect(typeof afterKeypad!.wall).toBe(typeof afterDrag!.wall);
    expect(typeof afterKeypad!.lateral).toBe(typeof afterDrag!.lateral);
    expect(afterKeypad!.size).toBe(afterDrag!.size);
    expect(afterKeypad!.placed).toBe(afterDrag!.placed);
    expect(afterKeypad!.enabled).toBe(afterDrag!.enabled);
    // The one difference is the lateral value — that's the point of the slide.
    expect(afterKeypad!.lateral).toBe(3);
    expect(afterDrag!.lateral).toBe(2);
  });

  it('a keypad-style spread-then-overwrite preserves the label field (no accidental clear)', () => {
    // 🪧 The keypad flow does `{ ...rec, lateral: stepped, placed: true }` — a
    // full spread of the current record. If a future refactor changed that to
    // an incomplete spread ({ id, wall, lateral, placed }), the label would
    // silently vanish on every nudge. Lock the current shape.
    writeDoorLayout({
      id: 'd:signed',
      wall: 'x+',
      lateral: 0,
      size: 'large',
      enabled: true,
      label: 'CASINO',
      placed: true,
    });
    const before = readAllDoorLayout().get('d:signed');
    // Simulate the keypad's slide-pos step.
    writeDoorLayout({ ...(before as DoorLayoutRecord), lateral: 1, placed: true });
    const after = readAllDoorLayout().get('d:signed');
    expect(after!.label).toBe('CASINO');
    expect(after!.lateral).toBe(1);
  });

  it('lateral is normalized to an integer regardless of which writer called (#91 read-normalizer)', () => {
    // Both writers snap to an integer BEFORE calling writeDoorLayout, but the
    // read-side Math.round is the safety net for a stale record or a hostile
    // peer. Either way, no consumer ever sees a fractional lateral.
    doorLayoutMap.set('d:fractional', {
      id: 'd:fractional',
      wall: 'y-',
      lateral: 1.4,
      size: 'large',
      enabled: true,
      placed: true,
    });
    const rec = readAllDoorLayout().get('d:fractional');
    expect(rec).toBeDefined();
    expect(Number.isInteger(rec!.lateral)).toBe(true);
    expect(rec!.lateral).toBe(1);
  });
});

// ── 2. Clamp-on-shrink (S2 read-side safety net) ─────────────────────────────

describe('readAllDoorLayout: clamp-on-shrink safety net (#66 S2 ↔ S3)', () => {
  it('a door recorded at lateral 4 in a 5×5 room reads clamped to 1 in a 1×1 room', () => {
    // Grow the room to 5×5 so the wall slide limit is 4.0, then place a door
    // at the max legal lateral.
    writeRoomDims(5, 5);
    expect(doorLateralLimitForWall('y-')).toBe(4);
    writeDoorLayout({
      id: 'd:corner',
      wall: 'y-',
      lateral: 4,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().get('d:corner')!.lateral).toBe(4);

    // Shrink to 1×1 — the wall run is now 6 m and the slide limit is 1.0.
    // The record still says 4, but the reader must return the clamped value or
    // reposeDoorTargets would pose the door 3 m past the wall corner.
    writeRoomDims(1, 1);
    expect(doorLateralLimitForWall('y-')).toBe(1);
    const clamped = readAllDoorLayout().get('d:corner');
    expect(clamped).toBeDefined();
    expect(clamped!.lateral).toBe(1);
  });

  it('a door recorded at lateral -4 clamps to -1 on the same shrink (symmetric)', () => {
    writeRoomDims(5, 5);
    writeDoorLayout({
      id: 'd:negcorner',
      wall: 'x+',
      lateral: -4,
      size: 'large',
      enabled: true,
      placed: true,
    });
    writeRoomDims(1, 1);
    expect(readAllDoorLayout().get('d:negcorner')!.lateral).toBe(-1);
  });

  it('growing the room lets a formerly-clamped door move OUT to its authored lateral', () => {
    // Place at 4 on a 5×5 (allowed), shrink to 1×1 (reads clamped to 1), then
    // grow back to 5×5 — the STORED record was never edited, so the reader
    // returns the original 4 again. The clamp is a rendering safety net, not a
    // destructive rewrite.
    writeRoomDims(5, 5);
    writeDoorLayout({
      id: 'd:elastic',
      wall: 'y+',
      lateral: 4,
      size: 'large',
      enabled: true,
      placed: true,
    });
    writeRoomDims(1, 1);
    expect(readAllDoorLayout().get('d:elastic')!.lateral).toBe(1);
    writeRoomDims(5, 5);
    expect(readAllDoorLayout().get('d:elastic')!.lateral).toBe(4);
  });

  it('a door well inside the wall run is UNTOUCHED (clamp is inward-only)', () => {
    // Default 2×2 room ⇒ limit = 4. A door at lateral 2 reads as 2.
    writeDoorLayout({
      id: 'd:centred',
      wall: 'y-',
      lateral: 2,
      size: 'large',
      enabled: true,
      placed: true,
    });
    const rec = readAllDoorLayout().get('d:centred');
    expect(rec!.lateral).toBe(2);
  });

  it('a rectangular room clamps each wall to ITS OWN limit', () => {
    // 5×1 ⇒ halfX=15, halfZ=3. y-walls (top/bottom, run in x): limit = 4.
    // x-walls (left/right, run in z): limit = max(0, min(4, 3-2)) = 1.
    writeRoomDims(5, 1);
    // A door on y- at lateral 4 stays at 4 (long axis wall).
    writeDoorLayout({
      id: 'd:long',
      wall: 'y-',
      lateral: 4,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().get('d:long')!.lateral).toBe(4);
    // A door on x+ authored at 3 clamps to 1 (short axis wall).
    writeDoorLayout({
      id: 'd:short',
      wall: 'x+',
      lateral: 3,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().get('d:short')!.lateral).toBe(1);
  });

  it('defaultDoorLayoutRecords (unseeded-room fallback) also clamps to the shrunk wall', () => {
    // The un-migrated-room defaults synthesise four cardinal berths through
    // the compat shim. Under 'casino-pairs' / 'pool-pairs' the shim puts
    // cardinals at ±PAIR_OFFSET = ±3, which strands doors on a 1-tile axis.
    // The default records path applies the same clamp as readAllDoorLayout.
    writeRoomDims(1, 1);
    const defaults = defaultDoorLayoutRecords();
    for (const rec of defaults.values()) {
      const limit = doorLateralLimitForWall(rec.wall);
      expect(rec.lateral).toBeGreaterThanOrEqual(-limit);
      expect(rec.lateral).toBeLessThanOrEqual(limit);
    }
  });
});

// ── 3. Hostile placement junk fails safe ─────────────────────────────────────

describe('readAllDoorLayout: hostile / malformed records fail safe (#66 S2)', () => {
  it('an entry with a non-string wall is skipped (never rendered)', () => {
    doorLayoutMap.set('d:badwall', {
      id: 'd:badwall',
      wall: 42,
      lateral: 0,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().has('d:badwall')).toBe(false);
  });

  it('an entry with a non-finite lateral is skipped', () => {
    doorLayoutMap.set('d:naninf', {
      id: 'd:naninf',
      wall: 'y-',
      lateral: NaN,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().has('d:naninf')).toBe(false);
    doorLayoutMap.set('d:naninf', {
      id: 'd:naninf',
      wall: 'y-',
      lateral: Infinity,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().has('d:naninf')).toBe(false);
  });

  it('an entry with no id is skipped', () => {
    doorLayoutMap.set('d:nokey', {
      wall: 'y-',
      lateral: 0,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().has('d:nokey')).toBe(false);
  });

  it('an entry whose id disagrees with its map key is skipped', () => {
    // A hostile peer could try to smuggle a door under one key while claiming
    // a different id in the record. isDoorLayoutRecord + the value.id === id
    // gate in readAllDoorLayout rejects it — an id mismatch could otherwise
    // let a peer forge a name (e.g. claim the CASINO door on a different key).
    doorLayoutMap.set('d:realkey', {
      id: 'd:otherid',
      wall: 'y-',
      lateral: 0,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().has('d:realkey')).toBe(false);
    expect(readAllDoorLayout().has('d:otherid')).toBe(false);
  });

  it('an entry with a plain string / null / array / number is skipped', () => {
    doorLayoutMap.set('d:string', 'nope');
    doorLayoutMap.set('d:null', null);
    doorLayoutMap.set('d:array', ['not', 'a', 'record']);
    doorLayoutMap.set('d:number', 42);
    const out = readAllDoorLayout();
    expect(out.has('d:string')).toBe(false);
    expect(out.has('d:null')).toBe(false);
    expect(out.has('d:array')).toBe(false);
    expect(out.has('d:number')).toBe(false);
  });

  it('a stored label that is padded, over-long or whitespace-only is sanitized on read', () => {
    // The shape guard accepts ANY string (never reject stored data — the #91
    // discipline). readAllDoorLayout's sanitizeDoorLabel is what stops a
    // hostile or old peer from reaching the renderer with junk.
    doorLayoutMap.set('d:padded', {
      id: 'd:padded',
      wall: 'y-',
      lateral: 0,
      size: 'large',
      enabled: true,
      placed: true,
      label: '  LOBBY   \n\t ',
    });
    const rec = readAllDoorLayout().get('d:padded');
    expect(rec!.label).toBe('LOBBY');

    doorLayoutMap.set('d:blank', {
      id: 'd:blank',
      wall: 'y-',
      lateral: 0,
      size: 'large',
      enabled: true,
      placed: true,
      label: '     ',
    });
    const rec2 = readAllDoorLayout().get('d:blank');
    // Whitespace-only ⇒ no label at all (undefined / absent).
    expect(rec2!.label).toBeUndefined();

    doorLayoutMap.set('d:long', {
      id: 'd:long',
      wall: 'y-',
      lateral: 0,
      size: 'large',
      enabled: true,
      placed: true,
      label: 'THIS IS AN ABSURDLY LONG LABEL THAT NOBODY WOULD EVER AUTHOR',
    });
    const rec3 = readAllDoorLayout().get('d:long');
    // DOOR_LABEL_MAX = 18 — hostile long labels are truncated in place.
    expect(rec3!.label!.length).toBeLessThanOrEqual(18);
  });

  it('isDoorLayoutRecord itself rejects each malformed shape', () => {
    // The shape guard is called at the read boundary AND is exported so other
    // callers (writeDoorLabel, doorLayout tests) can trust it identically.
    expect(isDoorLayoutRecord(null)).toBe(false);
    expect(isDoorLayoutRecord(undefined)).toBe(false);
    expect(isDoorLayoutRecord('not-an-object')).toBe(false);
    expect(isDoorLayoutRecord({ id: '', wall: 'y-', lateral: 0 })).toBe(false);
    expect(isDoorLayoutRecord({ id: 'x', wall: 'noplace', lateral: 0 })).toBe(false);
    expect(isDoorLayoutRecord({ id: 'x', wall: 'y-', lateral: 'zero' })).toBe(false);
    expect(isDoorLayoutRecord({ id: 'x', wall: 'y-', lateral: NaN })).toBe(false);
    expect(isDoorLayoutRecord({ id: 'x', wall: 'y-', lateral: 0, size: 'huge' })).toBe(false);
    expect(isDoorLayoutRecord({ id: 'x', wall: 'y-', lateral: 0, enabled: 'yes' })).toBe(false);
    expect(isDoorLayoutRecord({ id: 'x', wall: 'y-', lateral: 0, placed: 1 })).toBe(false);
    // A minimal valid record.
    expect(isDoorLayoutRecord({ id: 'x', wall: 'y-', lateral: 0 })).toBe(true);
    // Legacy compass wall ('north'…) is accepted through normalizeWall — old
    // stored rooms must not be rejected wholesale.
    expect(isDoorLayoutRecord({ id: 'x', wall: 'north', lateral: 0 })).toBe(true);
  });
});

// ── 4. Paired-door refusal contract (documentation) ──────────────────────────

// The paired-door refusal is enforced at the WRITE-CALLER LAYER (editMode and
// docking.ts), not in the doc. Both call sites early-return when the door is
// paired; a scenario test that mocks the docking system would just re-prove
// the code that's already in place. This block documents the contract so a
// grep on 'paired' surfaces it here.
describe('paired-door refusal contract (#66 S2 — enforced at write-caller layer)', () => {
  it('the doc layer accepts any writeDoorLayout call — pairing gates live in editMode + docking.ts', () => {
    // If it becomes possible to smuggle a door move past the paired gate, the
    // regression fires in editMode's beginDoorDrag test (behavioral) or the
    // docking slide-neg/pos handler; NOT here. Documenting: the doc layer is
    // deliberately unaware of pairing to keep coupling minimal.
    writeDoorLayout({
      id: 'd:x',
      wall: 'y-',
      lateral: 0,
      size: 'large',
      enabled: true,
      placed: true,
    });
    expect(readAllDoorLayout().has('d:x')).toBe(true);
  });
});
