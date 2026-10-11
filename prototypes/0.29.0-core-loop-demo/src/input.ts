/**
 * Input Manager
 * Handles keyboard input for player controls
 */

import * as THREE from 'three';
import { getCameraYaw } from './cameraRig';
import { isTextEntryTarget, type TextEntryTarget } from './typingFocus';

// World up axis — WASD vectors rotate around this by the camera-rig yaw.
const UP = new THREE.Vector3(0, 1, 0);

export class InputManager {
  private keys: Set<string> = new Set();
  
  constructor() {
    // Listen for keyboard events
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));

    // Focus ARRIVING in a text surface drops whatever is already held (#188).
    // The keydown guard below only stops NEW presses: a key still down when
    // the player clicks into the chat box would otherwise stay in the set for
    // as long as they typed, so the walk already under way would never end.
    // `focusin` rather than `focus` because only the former bubbles to window.
    window.addEventListener('focusin', (e) => {
      if (isTextEntryTarget(e.target as TextEntryTarget | null)) this.keys.clear();
    });

    // Leaving the window entirely (alt-tab, a native dialog, the OS taking
    // focus) delivers no keyup, so anything held sticks down and the avatar
    // is still walking when the player comes back. Same stuck-key class as
    // the chat case above, so it is closed in the same place.
    window.addEventListener('blur', () => this.keys.clear());

    console.log('✅ Input manager initialized');
  }

  /**
   * Handle key down event
   *
   * Keys typed into a chat box, a rename field or any other text surface are
   * not world input (#188): recording them walked the avatar across the room
   * — and stood it up out of a seat — while the player was only writing a
   * message.
   *
   * Guarded at capture rather than inside getMoveDirection() so that
   * isKeyPressed() and isInteracting() fall silent too; 'e' would otherwise
   * fire an interaction in the middle of a word.
   */
  private onKeyDown(event: KeyboardEvent) {
    if (isTextEntryTarget(event.target as TextEntryTarget | null)) return;
    this.keys.add(event.key.toLowerCase());
  }

  /**
   * Handle key up event
   *
   * Deliberately UNGUARDED, unlike onKeyDown. A key pressed in the world and
   * only released after focus moved into a text field must still be cleared,
   * or it sticks down forever. Releasing a key that was never recorded is a
   * harmless no-op, so the guard would buy nothing and cost that.
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
