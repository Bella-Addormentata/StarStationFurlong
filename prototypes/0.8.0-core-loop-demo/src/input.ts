/**
 * Input Manager
 * Handles keyboard input for player controls
 */

import * as THREE from 'three';

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
    
    // WASD controls
    if (this.keys.has('w')) direction.z -= 1;
    if (this.keys.has('s')) direction.z += 1;
    if (this.keys.has('a')) direction.x -= 1;
    if (this.keys.has('d')) direction.x += 1;
    
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
