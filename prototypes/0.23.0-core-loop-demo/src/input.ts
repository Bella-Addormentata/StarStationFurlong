/**
 * Input Manager
 * Handles keyboard input for player controls
 */

import * as THREE from 'three';
import { getCameraYaw } from './cameraRig';

// World up axis — WASD vectors rotate around this by the camera-rig yaw.
const UP = new THREE.Vector3(0, 1, 0);

export class InputManager {
  private keys: Set<string> = new Set();
  
  constructor() {
    // Listen for keyboard events
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    
    console.log('✅ Input manager initialized');
  }
  
  /**
   * Handle key down event
   */
  private onKeyDown(event: KeyboardEvent) {
    this.keys.add(event.key.toLowerCase());
  }
  
  /**
   * Handle key up event
   */
  private onKeyUp(event: KeyboardEvent) {
    this.keys.delete(event.key.toLowerCase());
  }
  
  /**
   * Get normalized movement direction from WASD input
   */
  getMoveDirection(): THREE.Vector3 {
    const direction = new THREE.Vector3(0, 0, 0);
    
    // Check if we are in Level 1 first-person view
    const zoomView = (window as any).multiScaleZoom;
    const isFirstPerson = zoomView && typeof zoomView.getLevel === 'function' && zoomView.getLevel() === 1;

    if (isFirstPerson) {
      // In First-Person view, WASD movement is oriented based on camera's view rotation vectors!
      const { camera } = window.gameRenderer;
      if (camera) {
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0; // lock to horizontal deck plane
        forward.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(forward, camera.up).normalize();

        if (this.keys.has('w')) direction.add(forward);
        if (this.keys.has('s')) direction.sub(forward);
        if (this.keys.has('a')) direction.sub(right);
        if (this.keys.has('d')) direction.add(right);

        if (direction.lengthSq() > 0) {
          direction.normalize();
        }
      }
    } else {
      // Standard isometric room controls
      if (this.keys.has('w')) direction.z -= 1;
      if (this.keys.has('s')) direction.z += 1;
      if (this.keys.has('a')) direction.x -= 1;
      if (this.keys.has('d')) direction.x += 1;

      // Keep WASD screen-relative when the camera rig is rotated: swing the
      // world-space vector by the same 45° detent the camera sits on, so
      // "W = up-screen" holds at every view angle. Yaw 0 preserves the
      // original mapping bit-for-bit.
      const camYaw = getCameraYaw();
      if (camYaw !== 0 && direction.lengthSq() > 0) {
        direction.applyAxisAngle(UP, camYaw);
      }
    }

    return direction;
  }
  
  /**
   * Check if a specific key is pressed
   */
  isKeyPressed(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }
  
  /**
   * Check if interaction key (E) is pressed
   */
  isInteracting(): boolean {
    return this.keys.has('e');
  }
}
