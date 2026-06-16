/**
 * World/Room Management
 * Handles room creation and game world state
 */

import * as THREE from 'three';
import { Player } from './player';
import { InputManager } from './input';

export class World {
  private scene: THREE.Scene;
  private player: Player;
  
  constructor(scene: THREE.Scene) {
    this.scene = scene;
    
    // Create the station room
    this.createRoom();
    
    // Create player
    this.player = new Player(this.scene);
    
    console.log('✅ World initialized');
  }
  
  /**
   * Create a 10x10m station room
   */
  private createRoom() {
    const roomSize = 10;
    const wallHeight = 3;
    
    // Floor
    const floorGeometry = new THREE.PlaneGeometry(roomSize, roomSize);
    const floorMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x2a2a2a,
      roughness: 0.8,
      metalness: 0.2
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2; // Rotate to horizontal
    floor.receiveShadow = true;
    this.scene.add(floor);
    
    // Walls (4 thin boxes)
    const wallMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x444444,
      roughness: 0.9,
      metalness: 0.1
    });
    
    const wallThickness = 0.2;
    
    // North wall
    const northWall = new THREE.Mesh(
      new THREE.BoxGeometry(roomSize, wallHeight, wallThickness),
      wallMaterial
    );
    northWall.position.set(0, wallHeight / 2, -roomSize / 2);
    northWall.castShadow = true;
    this.scene.add(northWall);
    
    // South wall
    const southWall = new THREE.Mesh(
      new THREE.BoxGeometry(roomSize, wallHeight, wallThickness),
      wallMaterial
    );
    southWall.position.set(0, wallHeight / 2, roomSize / 2);
    southWall.castShadow = true;
    this.scene.add(southWall);
    
    // East wall
    const eastWall = new THREE.Mesh(
      new THREE.BoxGeometry(wallThickness, wallHeight, roomSize),
      wallMaterial
    );
    eastWall.position.set(roomSize / 2, wallHeight / 2, 0);
    eastWall.castShadow = true;
    this.scene.add(eastWall);
    
    // West wall
    const westWall = new THREE.Mesh(
      new THREE.BoxGeometry(wallThickness, wallHeight, roomSize),
      wallMaterial
    );
    westWall.position.set(-roomSize / 2, wallHeight / 2, 0);
    westWall.castShadow = true;
    this.scene.add(westWall);
    
    // Grid helper (for development reference)
    const gridHelper = new THREE.GridHelper(roomSize, 10, 0x444444, 0x222222);
    gridHelper.position.y = 0.01; // Slightly above floor to prevent z-fighting
    this.scene.add(gridHelper);
    
    console.log('✅ Room created (10x10m)');
  }
  
  /**
   * Update world state each frame
   */
  update(deltaTime: number, inputManager: InputManager) {
    // Update player
    this.player.update(deltaTime, inputManager);
  }
}
