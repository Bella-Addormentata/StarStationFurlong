import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { pickSettingsGear } from './gearCardParts';

/** A 0.1 m gear facing +z at `z`, tagged for `itemId` (or untagged). */
function gear(z: number, itemId?: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), new THREE.MeshBasicMaterial());
  mesh.position.z = z;
  if (itemId) mesh.userData.settingsGear = itemId;
  mesh.updateMatrixWorld();
  return mesh;
}

const rayDownZ = (): THREE.Raycaster =>
  new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));

describe('pickSettingsGear', () => {
  it('returns the item of the nearest gear the ray hits', () => {
    const scene = new THREE.Scene();
    scene.add(gear(0, 'far-table'), gear(1, 'near-table'));
    scene.updateMatrixWorld();
    expect(pickSettingsGear(scene, rayDownZ())).toBe('near-table');
  });

  it('ignores untagged meshes, hidden gears and misses', () => {
    const scene = new THREE.Scene();
    const hidden = gear(0, 'hidden-table');
    hidden.visible = false;
    scene.add(gear(1), hidden);
    scene.updateMatrixWorld();
    expect(pickSettingsGear(scene, rayDownZ())).toBeNull();
    const miss = new THREE.Raycaster(new THREE.Vector3(3, 0, 5), new THREE.Vector3(0, 0, -1));
    scene.add(gear(0, 'table'));
    scene.updateMatrixWorld();
    expect(pickSettingsGear(scene, miss)).toBeNull();
  });
});
