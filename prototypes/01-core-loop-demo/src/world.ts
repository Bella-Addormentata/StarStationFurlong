/**
 * World/Room Management
 * Handles room creation and game world state with planet-to-platform morphing
 */

import * as THREE from 'three';
import { Player } from './player';
import { InputManager } from './input';

export class World {
  private scene: THREE.Scene;
  private player: Player;
  private platformGroup: THREE.Group;
  private stationPlanet: THREE.Mesh | null = null;
  private platformFloor: THREE.Mesh | null = null;
  private platformGrid: THREE.GridHelper | null = null;
  private platformElements: THREE.Object3D[] = [];
  private morphProgress = 0;
  private isMorphing = false;
  private morphDuration = 2.0; // seconds
  private time = 0; // For animations
  
  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.platformGroup = new THREE.Group();
    // Position slightly off-center to align with galaxy spiral arm
    this.platformGroup.position.set(-1, -2, 0);
    this.scene.add(this.platformGroup);
    
    // Create the station as a mini planet initially
    this.createStationPlanet();
    
    // Create player (will be shown after morph)
    this.player = new Player(this.scene);
    this.player.mesh.visible = false;
    
    console.log('✅ World initialized - Station planet ready');
  }
  
  /**
   * Create station as a mini planet hanging on the galaxy spiral
   */
  private createStationPlanet() {
    // Load Mars texture
    const textureLoader = new THREE.TextureLoader();
    
    // Create a small glowing planet (Mars-style station)
    const planetGeometry = new THREE.SphereGeometry(2, 64, 64);
    const planetMaterial = new THREE.MeshStandardMaterial({
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
        console.log('✅ Mars texture loaded');
      },
      undefined,
      (_error) => {
        console.warn('⚠️ Mars texture not found, using fallback color');
        planetMaterial.color.setHex(0xd84315);
      }
    );
    
    this.stationPlanet = new THREE.Mesh(planetGeometry, planetMaterial);
    this.stationPlanet.position.set(0, 0, 0);
    this.stationPlanet.castShadow = true;
    this.platformGroup.add(this.stationPlanet);
    
    // Add subtle atmosphere glow (Mars-like)
    const glowGeometry = new THREE.SphereGeometry(2.15, 32, 32);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6644,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    this.stationPlanet.add(glow);
    
    // Add ring around planet (station orbit ring)
    const ringGeometry = new THREE.RingGeometry(2.5, 2.7, 64);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x00aaff,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2;
    this.stationPlanet.add(ring);
    
    // Add subtle point light (Mars doesn't emit much light)
    const planetLight = new THREE.PointLight(0xff6633, 0.3, 15);
    planetLight.position.set(0, 0, 0);
    this.stationPlanet.add(planetLight);
    
    console.log('✅ Station planet created (Mars-style) - hanging on galaxy spiral');
  }
  
  /**
   * Create the full platform (called during morph)
   */
  private createPlatform() {
    const platformSize = 12;
    
    // Floor - high-tech metallic platform
    const floorGeometry = new THREE.PlaneGeometry(platformSize, platformSize);
    const floorMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x1a2a3a,
      roughness: 0.7,
      metalness: 0.8,
      emissive: 0x0a1520,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0
    });
    this.platformFloor = new THREE.Mesh(floorGeometry, floorMaterial);
    this.platformFloor.rotation.x = -Math.PI / 2;
    this.platformFloor.receiveShadow = true;
    this.platformGroup.add(this.platformFloor);
    
    // Grid helper
    this.platformGrid = new THREE.GridHelper(platformSize, 12, 0x00aaff, 0x224466);
    this.platformGrid.position.y = 0.01;
    this.platformGrid.visible = false;
    this.platformGroup.add(this.platformGrid);
    
    // Add corner markers and edges
    this.addCornerMarkers();
    this.addPlatformEdgeLights();
  }
  
  /**
   * Start morphing from planet to platform
   */
  public startMorph() {
    if (this.isMorphing) return;
    
    this.isMorphing = true;
    this.morphProgress = 0;
    this.createPlatform();
    console.log('🔄 Morphing station planet into platform...');
  }
  
  /**
   * Add glowing corner markers for sci-fi feel
   */
  private addCornerMarkers() {
    const markerGeometry = new THREE.CylinderGeometry(0.08, 0.08, 0.4, 8);
    const markerMaterial = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 0.8,
      metalness: 0.8,
      roughness: 0.2,
      transparent: true,
      opacity: 0
    });
    
    const positions = [
      [-5.5, 0.2, -5.5],
      [5.5, 0.2, -5.5],
      [-5.5, 0.2, 5.5],
      [5.5, 0.2, 5.5]
    ];
    
    positions.forEach(([x, y, z]) => {
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(x, y, z);
      this.platformGroup.add(marker);
      this.platformElements.push(marker);
      
      // Add point light at each corner
      const cornerLight = new THREE.PointLight(0x00ffff, 0, 5);
      cornerLight.position.set(x, y, z);
      this.platformGroup.add(cornerLight);
      this.platformElements.push(cornerLight);
    });
  }
  
  /**
   * Add edge lights to mark platform boundaries
   */
  private addPlatformEdgeLights() {
    const edgeMaterial = new THREE.MeshBasicMaterial({
      color: 0x00aaff,
      transparent: true,
      opacity: 0
    });
    
    const edgeGeometry = new THREE.BoxGeometry(12, 0.05, 0.1);
    
    // North edge
    const northEdge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    northEdge.position.set(0, 0.03, -6);
    this.platformGroup.add(northEdge);
    this.platformElements.push(northEdge);
    
    // South edge
    const southEdge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    southEdge.position.set(0, 0.03, 6);
    this.platformGroup.add(southEdge);
    this.platformElements.push(southEdge);
    
    // East edge
    const eastEdgeGeometry = new THREE.BoxGeometry(0.1, 0.05, 12);
    const eastEdge = new THREE.Mesh(eastEdgeGeometry, edgeMaterial.clone());
    eastEdge.position.set(6, 0.03, 0);
    this.platformGroup.add(eastEdge);
    this.platformElements.push(eastEdge);
    
    // West edge
    const westEdge = new THREE.Mesh(eastEdgeGeometry, edgeMaterial.clone());
    westEdge.position.set(-6, 0.03, 0);
    this.platformGroup.add(westEdge);
    this.platformElements.push(westEdge);
  }
  
  /**
   * Update morph animation
   */
  private updateMorph(deltaTime: number) {
    if (!this.isMorphing) return;
    
    this.morphProgress += deltaTime / this.morphDuration;
    
    if (this.morphProgress >= 1) {
      this.morphProgress = 1;
      this.isMorphing = false;
      this.player.mesh.visible = true;
      this.platformGroup.position.set(0, 0, 0); // Final position at center
      console.log('✅ Morph complete - Platform active');
    }
    
    // Ease function (ease-out-cubic)
    const t = this.morphProgress;
    const eased = 1 - Math.pow(1 - t, 3);
    
    // Move platform group to center
    this.platformGroup.position.lerp(new THREE.Vector3(0, 0, 0), eased);
    
    // Shrink and fade planet
    if (this.stationPlanet) {
      const scale = 1 - eased;
      this.stationPlanet.scale.setScalar(scale);
      (this.stationPlanet.material as THREE.MeshStandardMaterial).opacity = scale;
      (this.stationPlanet.material as THREE.MeshStandardMaterial).transparent = true;
      
      if (this.morphProgress >= 1) {
        this.platformGroup.remove(this.stationPlanet);
        this.stationPlanet = null;
      }
    }
    
    // Fade in platform floor
    if (this.platformFloor) {
      (this.platformFloor.material as THREE.MeshStandardMaterial).opacity = eased * 0.9;
    }
    
    // Show grid
    if (this.platformGrid && eased > 0.5) {
      this.platformGrid.visible = true;
    }
    
    // Fade in all platform elements
    this.platformElements.forEach(element => {
      if (element instanceof THREE.Mesh && element.material) {
        const material = element.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        if ('opacity' in material) {
          material.opacity = eased * 0.6;
        }
      } else if (element instanceof THREE.PointLight) {
        element.intensity = eased * 0.5;
      }
    });
  }
  
  /**
   * Update world state each frame
   */
  update(deltaTime: number, inputManager: InputManager) {
    this.time += deltaTime;
    
    // Update morph animation
    this.updateMorph(deltaTime);
    
    // Animate station planet (rotation + gentle floating)
    if (this.stationPlanet) {
      this.stationPlanet.rotation.y += deltaTime * 0.3;
      this.stationPlanet.rotation.x = Math.sin(this.time * 0.5) * 0.05;
      
      // Gentle floating animation
      const floatOffset = Math.sin(this.time * 0.8) * 0.15;
      this.stationPlanet.position.y = floatOffset;
    }
    
    // Update player only after the platform is fully active.
    if (this.player.mesh.visible) {
      this.player.update(deltaTime, inputManager);
    }
  }

  isPlayerActive(): boolean {
    return this.player.mesh.visible && !this.isMorphing;
  }
}
