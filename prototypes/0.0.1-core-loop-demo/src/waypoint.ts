/**
 * WaypointReticle — Animated neon marker shown at the click destination.
 *
 * Visual behaviour:
 *  - Flat neon square sitting flush with the floor
 *  - Pulses in scale via a sine wave while the path is active
 *  - Automatically disposed when `remove()` is called
 */

import * as THREE from 'three';

export class WaypointReticle {
  private mesh: THREE.Mesh;
  private scene: THREE.Scene;
  private elapsed = 0;

  constructor(scene: THREE.Scene, x: number, z: number) {
    this.scene = scene;

    // Thin flat square sitting just above the floor
    const geo = new THREE.PlaneGeometry(0.7, 0.7);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(x, 0.02, z);
    scene.add(this.mesh);
  }

  /** Call every frame with deltaTime (seconds) to animate the pulse. */
  update(dt: number): void {
    this.elapsed += dt;
    // Sine-wave scale between 0.8× and 1.2× — gives a "breathing" neon ping
    const s = 1.0 + 0.2 * Math.sin(this.elapsed * 6);
    this.mesh.scale.set(s, 1, s);
    // Rotate slowly for a subtle spin
    this.mesh.rotation.y = this.elapsed * 1.2;
  }

  /** Remove the reticle from the scene and dispose GPU resources. */
  remove(): void {
    this.scene.remove(this.mesh);
    (this.mesh.material as THREE.MeshBasicMaterial).dispose();
    this.mesh.geometry.dispose();
  }
}
