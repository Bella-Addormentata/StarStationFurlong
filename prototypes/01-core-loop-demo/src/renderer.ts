/**
 * Three.js Renderer Setup
 * Handles scene, camera, and renderer initialization
 */

import * as THREE from 'three';

// Global renderer state (accessible from main.ts)
declare global {
  interface Window {
    gameRenderer: {
      renderer: THREE.WebGLRenderer;
      camera: THREE.OrthographicCamera;
      scene: THREE.Scene;
    };
  }
}

/**
 * Initialize Three.js renderer with orthographic camera for 2.5D isometric view
 */
export function initRenderer() {
  // Get container
  const container = document.getElementById('app');
  if (!container) {
    throw new Error('App container not found');
  }
  
  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  
  // Setup orthographic camera for isometric view
  const aspect = window.innerWidth / window.innerHeight;
  const frustumSize = 15;
  const camera = new THREE.OrthographicCamera(
    frustumSize * aspect / -2,  // left
    frustumSize * aspect / 2,   // right
    frustumSize / 2,            // top
    frustumSize / -2,           // bottom
    0.1,                        // near
    1000                        // far
  );
  
  // Position camera for 45° isometric view (looking down)
  camera.position.set(10, 10, 10);
  camera.lookAt(0, 0, 0);
  
  // Create WebGL renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  
  container.appendChild(renderer.domElement);
  
  // Lighting setup
  setupLighting(scene);
  
  // Handle window resize
  window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = frustumSize * aspect / -2;
    camera.right = frustumSize * aspect / 2;
    camera.top = frustumSize / 2;
    camera.bottom = frustumSize / -2;
    camera.updateProjectionMatrix();
    
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  
  // Store globally for access from main loop
  window.gameRenderer = { renderer, camera, scene };
  
  console.log('✅ Renderer initialized');
  
  return { renderer, camera, scene };
}

/**
 * Setup scene lighting
 */
function setupLighting(scene: THREE.Scene) {
  // Ambient light - provides base illumination
  const ambientLight = new THREE.AmbientLight(0x666666);
  scene.add(ambientLight);
  
  // Directional light - simulates sun/station lighting
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 10, 5);
  directionalLight.castShadow = true;
  
  // Configure shadow properties
  directionalLight.shadow.camera.left = -20;
  directionalLight.shadow.camera.right = 20;
  directionalLight.shadow.camera.top = 20;
  directionalLight.shadow.camera.bottom = -20;
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;
  
  scene.add(directionalLight);
  
  console.log('✅ Lighting configured');
}
