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
  private time = 0; // Elapsed time for animations (seconds)
  
  constructor(scene: THREE.Scene) {
    // Create a group to hold planet and effects
    this.mesh = new THREE.Group();
    
    // Load Mars texture
    const textureLoader = new THREE.TextureLoader();
    
    // Create the main planet sphere (Mars-style)
    const planetGeometry = new THREE.SphereGeometry(0.9, 64, 64);
    
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
    
    // Add surface details with a simple shader-like effect
    this.addPlanetDetails();
    
    // Create outer glow effect (Mars-like atmosphere)
    const glowGeometry = new THREE.SphereGeometry(1.05, 32, 32);
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
    
    this.mesh.position.set(0, 7.5, 0); // Float above the room walls
    
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
      const radius = 0.58;
      
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
  update(deltaTime: number, _inputManager: InputManager) {
    this.time += deltaTime;

    // Slow self-rotation — stays fixed in the sky
    this.planet.rotation.y += deltaTime * 0.5;
    this.glow.rotation.y   -= deltaTime * 0.3;

    // Gentle floating bob, fixed position above the room
    this.mesh.position.set(
      0,
      7.5 + Math.sin(this.time * 2) * 0.08,
      0
    );

    // Update debug HUD with NPC position placeholder
    updateDebugHUD('position', `sky`);
  }
  
  /**
   * Get player position
   */
  getPosition(): THREE.Vector3 {
    return this.mesh.position.clone();
  }
}
