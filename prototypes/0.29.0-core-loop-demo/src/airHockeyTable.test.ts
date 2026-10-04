/**
 * 🏒 The air-hockey table as built (#116 review). Placement and collision
 * only know a piece's footprint, so every mesh must stay inside the table's
 * 2×3: a scoreboard poking past it lets a wall or another piece stand through
 * it. And each face of the dual scoreboard must read the right way round from
 * the end it faces.
 *
 * The table is built for real (buildItemGroup), with a stand-in canvas for
 * the felt and the scoreboard.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

/** A canvas whose 2-D context draws nothing: the felt and the scoreboard
 *  paint through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

// furniture.ts reads the page's query string when it loads.
vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const { buildItemGroup, FURNITURE_DEFS } = await import('./furniture');

function buildTable(): THREE.Group {
  const group = buildItemGroup({ id: 'air-hockey-table-1', kind: 'air-hockey-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  group.updateMatrixWorld(true);
  return group;
}

/** The scoreboard's faces: the canvas-textured planes above head height. */
function scoreboardFaces(group: THREE.Group): THREE.Mesh[] {
  const faces: THREE.Mesh[] = [];
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const map = (obj.material as THREE.MeshBasicMaterial).map;
    if (!(map instanceof THREE.CanvasTexture)) return;
    const centre = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    if (centre.y > 1.2) faces.push(obj);
  });
  return faces;
}

describe('the air-hockey table as built', () => {
  it('keeps every mesh inside its 2×3 footprint', () => {
    const { w, d } = FURNITURE_DEFS['air-hockey-table'].footprint!;
    const group = buildTable();
    const outside: string[] = [];
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const box = new THREE.Box3().setFromObject(obj);
      if (box.min.x < -w / 2 - 1e-9 || box.max.x > w / 2 + 1e-9
        || box.min.z < -d / 2 - 1e-9 || box.max.z > d / 2 + 1e-9) {
        outside.push(`${obj.geometry.type} x ${box.min.x.toFixed(2)}…${box.max.x.toFixed(2)}, z ${box.min.z.toFixed(2)}…${box.max.z.toFixed(2)}`);
      }
    });
    expect(outside).toEqual([]);
  });

  it('shows each end a scoreboard face that reads left to right', () => {
    const faces = scoreboardFaces(buildTable());
    expect(faces).toHaveLength(2);
    const facing = new Set<number>();
    for (const face of faces) {
      const geo = face.geometry;
      // Which end the face looks toward, and a player's eye at that end.
      const normal = new THREE.Vector3().fromBufferAttribute(geo.attributes.normal as THREE.BufferAttribute, 0)
        .transformDirection(face.matrixWorld);
      const end = Math.sign(normal.z);
      facing.add(end);
      const centre = new THREE.Box3().setFromObject(face).getCenter(new THREE.Vector3());
      const eye = new THREE.PerspectiveCamera(60, 1, 0.1, 50);
      eye.position.set(0, 1.62, end * 1.85);
      eye.lookAt(centre);
      eye.updateMatrixWorld();
      // Where the texture's left edge (u = 0) lands on screen, against its right.
      let uLeftX = 0;
      let uRightX = 0;
      for (let i = 0; i < geo.attributes.position.count; i++) {
        const x = new THREE.Vector3().fromBufferAttribute(geo.attributes.position as THREE.BufferAttribute, i)
          .applyMatrix4(face.matrixWorld).project(eye).x;
        if ((geo.attributes.uv as THREE.BufferAttribute).getX(i) === 0) uLeftX = x; else uRightX = x;
      }
      const map = (face.material as THREE.MeshBasicMaterial).map!;
      // A negative repeat samples the canvas right to left.
      const canvasLeftOnLeft = (uLeftX < uRightX) === (map.repeat.x > 0);
      expect(canvasLeftOnLeft, `the face toward ${end > 0 ? '+z (side b)' : '-z (side a)'} reads left to right`).toBe(true);
    }
    expect([...facing].sort()).toEqual([-1, 1]);
  });
});
