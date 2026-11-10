/**
 * 🪑 furnitureDoc.layoutRemoved: how World tells a table this room's layout
 * took out (a removal heard from the room) from a table of the room this
 * page left, which the doc it joined never had. The first marks the table's
 * incarnation ended when nothing else did (casinoDoc clearTableKeys); the
 * second writes nothing to the new room's doc.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindFurnitureDoc, layoutKeeps, layoutRemoved, layoutRemovedHere, readAllFurniture } from './furnitureDoc';

const TABLE = 'casino-roulette';
const record = { kind: 'roulette-table', x: 0, z: 0, rot: 0, movable: true };

describe('layoutRemoved', () => {
  it("says so of an item the bound layout held and a change took out, and of nothing else", () => {
    const doc = new Y.Doc();
    doc.getMap('furniture').set(TABLE, record);
    bindFurnitureDoc(doc);
    expect(layoutRemoved(TABLE)).toBe(false);
    doc.getMap('furniture').delete(TABLE);
    expect(layoutRemoved(TABLE)).toBe(true);
    expect(layoutRemoved('casino-roulette-elsewhere')).toBe(false);
    doc.getMap('furniture').set(TABLE, record); // put back
    expect(layoutRemoved(TABLE)).toBe(false);
  });

  it('hears a removal another page made', () => {
    const peer = new Y.Doc();
    peer.getMap('furniture').set(TABLE, record);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    bindFurnitureDoc(doc);
    peer.getMap('furniture').delete(TABLE);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    expect(layoutRemoved(TABLE)).toBe(true);
    expect(layoutRemovedHere(TABLE)).toBe(false);
  });

  it("tells this page's own removal (a room template applied here) from one it heard", () => {
    const doc = new Y.Doc();
    doc.getMap('furniture').set(TABLE, record);
    bindFurnitureDoc(doc);
    expect(layoutRemovedHere(TABLE)).toBe(false);
    doc.transact(() => {
      doc.getMap('furniture').delete(TABLE); // replaceAllFurniture's clear, as a template applies
      doc.getMap('furniture').set('casino-craps', record);
    });
    expect(layoutRemovedHere(TABLE)).toBe(true);
    // Put back and taken out again by another page: heard.
    doc.getMap('furniture').set(TABLE, record);
    expect(layoutRemovedHere(TABLE)).toBe(false);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getMap('furniture').delete(TABLE);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    expect(layoutRemoved(TABLE)).toBe(true);
    expect(layoutRemovedHere(TABLE)).toBe(false);
  });

  it('says so of an item written over by one of another kind, or by what is no record: what stood under the id was taken out, by this page or by another', () => {
    const SOFA = { ...record, kind: 'sofa-back' };
    const doc = new Y.Doc();
    const layout = doc.getMap<unknown>('furniture');
    layout.set(TABLE, record);
    bindFurnitureDoc(doc);
    /** A write another page makes of the table's id, heard here. */
    const heard = (value: unknown): void => {
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      peer.getMap<unknown>('furniture').set(TABLE, value);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    };
    // moved, the same kind: it stands
    layout.set(TABLE, { ...record, x: 3 });
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([false, false]);
    // a sofa written under its id by this page: the table was taken out, here
    layout.set(TABLE, SOFA);
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([true, true]);
    // the table written over the sofa by another page: the sofa was taken out, heard
    heard(record);
    expect(layout.get(TABLE)).toEqual(record);
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([true, false]);
    // moved again: what stands there was not taken out
    layout.set(TABLE, { ...record, x: 5 });
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([false, false]);
    // junk over the table, heard, and by this page
    heard('junk');
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([true, false]);
    layout.set(TABLE, record);
    // (the table over junk: nothing stood there to take out)
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([false, false]);
    layout.set(TABLE, { ...record, rot: 9 });
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([true, true]);
  });

  it('a page that came in while a sofa lay under a table\'s id does not keep the sofa when the table is put back: the sofa goes as an item a removal it heard took out, and the table is built', () => {
    const SOFA = { ...record, kind: 'sofa-back' };
    // the room as the page found it: a sofa under the table's id
    const room = new Y.Doc();
    room.getMap<unknown>('furniture').set(TABLE, SOFA);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
    bindFurnitureDoc(doc);
    const shown = { id: TABLE, kind: 'sofa-back' as const };
    expect(layoutKeeps(shown, readAllFurniture())).toBe(true);
    // (moved: kept)
    room.getMap<unknown>('furniture').set(TABLE, { ...SOFA, x: 4, rot: 2 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room, Y.encodeStateVector(doc)));
    expect(layoutKeeps(shown, readAllFurniture())).toBe(true);
    expect(layoutRemoved(TABLE)).toBe(false);
    // another page puts the table back
    room.getMap<unknown>('furniture').set(TABLE, record);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room, Y.encodeStateVector(doc)));
    expect(layoutKeeps(shown, readAllFurniture())).toBe(false);
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([true, false]);
    // (what is built from then is the layout's record, and that one is kept)
    expect(readAllFurniture().get(TABLE)).toMatchObject({ kind: 'roulette-table' });
    expect(layoutKeeps({ id: TABLE, kind: 'roulette-table' }, readAllFurniture())).toBe(true);
    // junk under the id, or nothing: no item is kept there
    room.getMap<unknown>('furniture').set(TABLE, 'junk');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room, Y.encodeStateVector(doc)));
    expect(layoutKeeps({ id: TABLE, kind: 'roulette-table' }, readAllFurniture())).toBe(false);
    room.getMap<unknown>('furniture').delete(TABLE);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room, Y.encodeStateVector(doc)));
    expect(layoutKeeps({ id: TABLE, kind: 'roulette-table' }, readAllFurniture())).toBe(false);
  });

  it('an item the page brought from the room it left stays where the room it joined holds another kind under its id: nothing here took it out, and its teardown would write to what the item that stands here keeps in the doc; it goes once a change here writes over what stands there', () => {
    const CRAPS = { ...record, kind: 'craps-table' };
    const SOFA = { ...record, kind: 'sofa-back' };
    // the room left: a craps table under the id, shown by this page
    const left = new Y.Doc();
    left.getMap<unknown>('furniture').set(TABLE, CRAPS);
    bindFurnitureDoc(left);
    const shown = { id: TABLE, kind: 'craps-table' as const };
    expect(layoutKeeps(shown, readAllFurniture())).toBe(true);
    // the room joined holds a roulette table there, whether its content comes after the binding or was there at it
    const room = new Y.Doc();
    room.getMap<unknown>('furniture').set(TABLE, record);
    for (const late of [true, false]) {
      const doc = new Y.Doc();
      if (!late) Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
      bindFurnitureDoc(doc);
      if (late) Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
      expect(readAllFurniture().get(TABLE)).toMatchObject({ kind: 'roulette-table' });
      expect(layoutRemoved(TABLE)).toBe(false);
      expect(layoutKeeps(shown, readAllFurniture()), `content ${late ? 'after' : 'at'} the binding`).toBe(true);
      // (an id the room joined does not hold: that item goes, as a table of the room left)
      expect(layoutKeeps({ id: 'casino-craps-left', kind: 'craps-table' }, readAllFurniture())).toBe(false);
    }
    // the table that stands here is moved: still nothing took out what this page shows
    const doc = new Y.Doc();
    bindFurnitureDoc(doc);
    const hear = (): void => Y.applyUpdate(doc, Y.encodeStateAsUpdate(room, Y.encodeStateVector(doc)));
    hear();
    room.getMap<unknown>('furniture').set(TABLE, { ...record, x: 6 });
    hear();
    expect(layoutKeeps(shown, readAllFurniture())).toBe(true);
    // a sofa written over it here: what stood under the id was taken out, and what this page shows goes with it
    room.getMap<unknown>('furniture').set(TABLE, SOFA);
    hear();
    expect([layoutRemoved(TABLE), layoutRemovedHere(TABLE)]).toEqual([true, false]);
    expect(layoutKeeps(shown, readAllFurniture())).toBe(false);
    // (and the sofa built in its place is kept)
    expect(layoutKeeps({ id: TABLE, kind: 'sofa-back' }, readAllFurniture())).toBe(true);
  });

  it('starts over with the next room', () => {
    const doc = new Y.Doc();
    doc.getMap('furniture').set(TABLE, record);
    bindFurnitureDoc(doc);
    doc.getMap('furniture').delete(TABLE);
    const next = new Y.Doc();
    bindFurnitureDoc(next);
    expect(layoutRemoved(TABLE)).toBe(false);
    doc.getMap('furniture').set(TABLE, record); // the room left, changing on
    doc.getMap('furniture').delete(TABLE);
    expect(layoutRemoved(TABLE)).toBe(false);
  });
});

describe("World's removal of a table", () => {
  const world = readFileSync(new URL('./world.ts', import.meta.url), 'utf8');

  it('closes it as its reconcile came to remove it: heard in this room, or a table of the room left', () => {
    const start = world.indexOf('public reconcileFurniture(');
    const body = world.slice(start, world.indexOf('\n  }\n', start));
    expect(body).toContain('layoutRemovedHere(item.id) ? "local" : layoutRemoved(item.id) ? "heard" : "elsewhere",');
  });

  it('takes down an item whose id holds a record of another kind, as one removed, and builds the one the layout holds', () => {
    const start = world.indexOf('public reconcileFurniture(');
    const body = world.slice(start, world.indexOf('\n  }\n', start));
    // (the removals go by layoutKeeps, and by nothing less than it: a record of another kind that a change here wrote keeps nothing)
    expect(body).toContain('if (layoutKeeps(item, records)) continue;');
    expect(body).not.toContain('if (records.has(item.id)) continue;');
    // (what is built is looked for after the removals, among the items left)
    expect(body.indexOf('// 1. Removals')).toBeLessThan(body.indexOf('// 2. Adds + moves.'));
    expect(body.indexOf('// 2. Adds + moves.')).toBeLessThan(body.indexOf('const existing = FURNITURE.find((i) => i.id === id);'));
  });

  it("and its own edit's removal as this page's", () => {
    const start = world.indexOf('public removeFurnitureVisuals(');
    const body = world.slice(start, world.indexOf('\n  }\n', start));
    expect(world.slice(start, start + 120)).toContain('closing: TableClosing = "local"');
    expect(body).toContain('closeTable(itemId, closing);');
    expect(body).toContain('closeCrapsTable(itemId, closing);');
  });

  it("each teardown says which game's table closes, and the editor takes an item down while the layout holds its record still: a FAIR ONLY game's switch is left only by the teardown of a table of the other game (casinoDoc clearTableKeys)", () => {
    const body = world.slice(world.indexOf('public removeFurnitureVisuals('));
    // (a roulette table's teardown is croupier closeTable, a craps table's crapsCroupier closeCrapsTable)
    expect(body.indexOf('if (removedKind === "roulette-table") {\n      closeTable(itemId, closing);')).toBeGreaterThan(-1);
    expect(body.indexOf('} else if (removedKind === "craps-table") {\n      closeCrapsTable(itemId, closing);')).toBeGreaterThan(-1);
    const croupier = readFileSync(new URL('./croupier.ts', import.meta.url), 'utf8');
    const craps = readFileSync(new URL('./crapsCroupier.ts', import.meta.url), 'utf8');
    expect(croupier).toContain("closeWhenWhole(tableId, () => transactCasino(() => refundAndClear(tableId, closing, { closes: 'roulette' })));");
    expect(craps).toContain("closeWhenWhole(tableId, () => transactCasino(() => refundAndClear(tableId, closing, { closes: 'craps' })));");
    expect(croupier).toContain('clearTableKeys(tableId, closing, opts);');
    // (EditMode.removeSelected: the visuals and the table's session first, the layout's record after)
    const edit = readFileSync(new URL('./editMode.ts', import.meta.url), 'utf8');
    const down = edit.indexOf('world.removeFurnitureVisuals(itemId);');
    const gone = edit.indexOf('deleteFurnitureItem(itemId);');
    expect(down).toBeGreaterThan(-1);
    expect(gone).toBeGreaterThan(down);
    expect(edit.indexOf('world.removeFurnitureVisuals(itemId);', down + 1)).toBe(-1);
    expect(edit.indexOf('deleteFurnitureItem(itemId);', gone + 1)).toBe(-1);
  });
});

describe("World's frame", () => {
  const world = readFileSync(new URL('./world.ts', import.meta.url), 'utf8');

  it('is marked as one that runs tables by computedTable tableFrame, which the specs\' frames go by too: with the room\'s last table out a page stays awake for what a FAIR ONLY game asks of it', () => {
    const start = world.indexOf('private updateCroupier(): void {');
    const body = world.slice(start, world.indexOf('\n  }\n', start));
    expect(body).toContain('if (tableFrame(tables.length)) noteTablesRunning();');
    expect(body.split('noteTablesRunning(').length).toBe(2);
    // (before the tick of the frame, which asks whether the page is awake)
    expect(body.indexOf('if (tableFrame(tables.length)) noteTablesRunning();')).toBeLessThan(body.indexOf('tickComputedTables('));
    const kit = readFileSync(new URL('./computedPageKit.ts', import.meta.url), 'utf8');
    expect(kit).toContain('if (p.table.tableFrame(tables.length)) p.croupier.noteTablesRunning(now);');
    const sim = readFileSync(new URL('./computedSim.ts', import.meta.url), 'utf8');
    expect(sim).toContain('if (table.tableFrame(tables.length)) croupier.noteTablesRunning(now);');
  });
});
