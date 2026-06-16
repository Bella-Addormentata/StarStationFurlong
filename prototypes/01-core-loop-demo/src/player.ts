/**
 * Player Entity
 * Handles player representation and movement
 */

import * as THREE from 'three';
import { InputManager } from './input';
import { updateDebugHUD } from './main';

export class Player {
  private mesh: THREE.Mesh;
  private velocity = new THREE.Vector3();
  private readonly moveSpeed = 3.0; // meters per second
  private readonly roomBounds = 4.5; // Keep 0.5m buffer from 10m room walls
  
  constructor(scene: THREE.Scene) {
    // Create player capsule (simple cylinder for now)
    const capsuleGeometry = new THREE.CapsuleGeometry(0.3, 1.0, 8, 16);
    const capsuleMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x00ff00, // Green for local player
      roughness: 0.5,
      metalness: 0.3
    });
    
    this.mesh = new THREE.Mesh(capsuleGeometry, capsuleMaterial);
    this.mesh.position.set(0, 0.8, 0); // Y=0.8m (capsule bottom at ground)
    this.mesh.castShadow = true;
    
    scene.add(this.mesh);
    
    console.log('✅ Player created');
  }
  
  /**
   * Update player state each frame
   */
  update(deltaTime: number, inputManager: InputManager) {
    // Get input direction
    const moveDir = inputManager.getMoveDirection();
    
    // Calculate velocity
    this.velocity.set(moveDir.x, 0, moveDir.z);
    
    // Normalize diagonal movement to prevent speed boost
    if (this.velocity.length() > 0) {
      this.velocity.normalize();
      this.velocity.multiplyScalar(this.moveSpeed * deltaTime);
      
      // Apply movement
      this.mesh.position.add(this.velocity);
      
      // Apply boundary constraints
      this.mesh.position.x = Math.max(-this.roomBounds, Math.min(this.roomBounds, this.mesh.position.x));
      this.mesh.position.z = Math.max(-this.roomBounds, Math.min(this.roomBounds, this.mesh.position.z));
    }
    
    // Update debug HUD with position
    const pos = this.mesh.position;
    updateDebugHUD('position', `X: ${pos.x.toFixed(2)}, Z: ${pos.z.toFixed(2)}`);
  }
  
  /**
   * Get player position
   */
  getPosition(): THREE.Vector3 {
    return this.mesh.position.clone();
  }
}
