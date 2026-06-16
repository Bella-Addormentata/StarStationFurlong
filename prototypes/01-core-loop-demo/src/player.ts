/**
 * Player Entity
 * Handles player representation and movement
 */

import * as THREE from 'three';
import { InputManager } from './input';
import { updateDebugHUD } from './main';

export class Player {
  public mesh: THREE.Group;
  private planet: THREE.Mesh;
  private glow: THREE.Mesh;
  private velocity = new THREE.Vector3();
  private readonly moveSpeed = 3.0; // meters per second
  private readonly roomBounds = 5.5; // Keep 0.5m buffer from 12m platform edges
  private time = 0; // Elapsed time for animations (seconds)
  
  constructor(scene: THREE.Scene) {
    // Create a group to hold planet and effects
    this.mesh = new THREE.Group();
    
    // Load Mars texture
    const textureLoader = new THREE.TextureLoader();
    
    // Create the main planet sphere (Mars-style)
    const planetGeometry = new THREE.SphereGeometry(0.6, 64, 64);
    
    // Create planet material (Mars colors)
    const planetMaterial = new THREE.MeshStandardMaterial({ 
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.1,
      emissive: 0x331100,
      emissiveIntensity: 0.2
    });
    
    // Load Mars texture asynchronously
    textureLoader.load(
      '/assets/mars.png',
      (texture) => {
        planetMaterial.map = texture;
        planetMaterial.needsUpdate = true;
        console.log('✅ Player Mars texture loaded');
      },
      undefined,
      (_error) => {
        console.warn('⚠️ Player Mars texture not found, using fallback color');
        planetMaterial.color.setHex(0xd84315);
      }
    );
    
    this.planet = new THREE.Mesh(planetGeometry, planetMaterial);
    this.planet.castShadow = true;
    
    // Add surface details with a simple shader-like effect
    this.addPlanetDetails();
    
    // Create outer glow effect (Mars-like atmosphere)
    const glowGeometry = new THREE.SphereGeometry(0.7, 32, 32);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6644,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide
    });
    this.glow = new THREE.Mesh(glowGeometry, glowMaterial);
    
    // Create atmosphere ring (station orbit ring)
    const ringGeometry = new THREE.RingGeometry(0.75, 0.85, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x00aaff,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2; // Make it horizontal
    
    // Add point light for planet glow (Mars-style)
    const planetLight = new THREE.PointLight(0xff6633, 0.3, 3);
    planetLight.position.set(0, 0, 0);
    
    // Assemble the player
    this.mesh.add(this.planet);
    this.mesh.add(this.glow);
    this.mesh.add(ring);
    this.mesh.add(planetLight);
    
    this.mesh.position.set(0, 1.0, 0); // Hover higher above ground
    
    scene.add(this.mesh);
    
    console.log('✅ Player created (Mars planetary form)');
  }
  
  /**
   * Add procedural surface details to planet
   */
  private addPlanetDetails() {
    // Add small detail spheres to simulate Mars surface features (craters, mountains)
    const detailCount = 8;
    for (let i = 0; i < detailCount; i++) {
      const detailGeometry = new THREE.SphereGeometry(0.08, 8, 8);
      const detailMaterial = new THREE.MeshStandardMaterial({
        color: 0x993311,
        roughness: 0.95,
        metalness: 0.05,
        emissive: 0x220000,
        emissiveIntensity: 0.1
      });
      const detail = new THREE.Mesh(detailGeometry, detailMaterial);
      
      // Random position on sphere surface
      const phi = Math.random() * Math.PI * 2;
      const theta = Math.random() * Math.PI;
      const radius = 0.38;
      
      detail.position.set(
        radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.sin(theta) * Math.sin(phi),
        radius * Math.cos(theta)
      );
      
      this.planet.add(detail);
    }
  }
  
  /**
   * Update player state each frame
   */
  update(deltaTime: number, inputManager: InputManager) {
    this.time += deltaTime;

    // Rotate planet for animation
    this.planet.rotation.y += deltaTime * 0.5; // Slow rotation
    this.glow.rotation.y -= deltaTime * 0.3; // Counter-rotate glow
    
    // Gentle floating animation (use accumulated time, consistent with rest of codebase)
    this.mesh.position.y = 1.0 + Math.sin(this.time * 2) * 0.08;
    
    // Get input direction
    const moveDir = inputManager.getMoveDirection();
    
    // Calculate velocity
    this.velocity.set(moveDir.x, 0, moveDir.z);
    
    // Normalize diagonal movement to prevent speed boost
    if (this.velocity.length() > 0) {
      this.velocity.normalize();
      this.velocity.multiplyScalar(this.moveSpeed * deltaTime);
      
      // Apply movement
      this.mesh.position.x += this.velocity.x;
      this.mesh.position.z += this.velocity.z;
      
      // Tilt planet in movement direction for dynamic feel
      this.planet.rotation.z = -moveDir.x * 0.3;
      this.planet.rotation.x = moveDir.z * 0.3;
      
      // Apply boundary constraints
      this.mesh.position.x = Math.max(-this.roomBounds, Math.min(this.roomBounds, this.mesh.position.x));
      this.mesh.position.z = Math.max(-this.roomBounds, Math.min(this.roomBounds, this.mesh.position.z));
    } else {
      // Return to neutral rotation when not moving
      this.planet.rotation.z *= 0.9;
      this.planet.rotation.x *= 0.9;
    }
    
    // Update debug HUD with position
    const pos = this.mesh.position;
    updateDebugHUD('position', `${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}`);
  }
  
  /**
   * Get player position
   */
  getPosition(): THREE.Vector3 {
    return this.mesh.position.clone();
  }
}
