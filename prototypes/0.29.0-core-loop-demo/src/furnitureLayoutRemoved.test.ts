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
import { bindFurnitureDoc, layoutRemoved, layoutRemovedHere } from './furnitureDoc';

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

  it("and its own edit's removal as this page's", () => {
    const start = world.indexOf('public removeFurnitureVisuals(');
    const body = world.slice(start, world.indexOf('\n  }\n', start));
    expect(world.slice(start, start + 120)).toContain('closing: TableClosing = "local"');
    expect(body).toContain('closeTable(itemId, closing);');
    expect(body).toContain('closeCrapsTable(itemId, closing);');
  });
});
