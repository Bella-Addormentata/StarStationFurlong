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
  
  // Create scene with NASA galaxy background
  const scene = new THREE.Scene();
  
  // Load NASA galaxy background texture with subtle overlay
  const textureLoader = new THREE.TextureLoader();
  textureLoader.load(
    '/assets/galaxy-background.png',
    (texture) => {
      // Create a subtle overlay to dim the background
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      canvas.width = texture.image.width;
      canvas.height = texture.image.height;
      
      // Draw the original texture
      ctx.drawImage(texture.image, 0, 0);
      
      // Add a subtle dark overlay to make it less prominent
      ctx.fillStyle = 'rgba(10, 15, 25, 0.45)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Create new texture from canvas
      const overlayTexture = new THREE.CanvasTexture(canvas);
      scene.background = overlayTexture;
      console.log('✅ NASA galaxy background loaded (dimmed for atmosphere)');
    },
    undefined,
    (_error) => {
      console.error('❌ Failed to load background');
      // Fallback to gradient color background
      scene.background = new THREE.Color(0x0f1520);
    }
  );
  
  // Add atmospheric fog for depth and blending
  scene.fog = new THREE.FogExp2(0x0f1520, 0.02);
  
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
  
  // Start from far away view (showing the station hanging in space)
  camera.position.set(20, 35, 20);
  camera.lookAt(0, -2, 0); // Look slightly below center where spiral arm is
  camera.zoom = 0.35; // Start zoomed out
  camera.updateProjectionMatrix();
  
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
  // Ambient light - balanced to work with galaxy background
  const ambientLight = new THREE.AmbientLight(0x8899bb, 0.5);
  scene.add(ambientLight);
  
  // Main directional light - bright overhead station lights
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
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
  
  // Cyan tech accent light (left corner) - softer to not overpower background
  const accentLight1 = new THREE.PointLight(0x00ccff, 0.4, 15);
  accentLight1.position.set(-4, 1.5, -4);
  scene.add(accentLight1);
  
  // Orange tech accent light (right corner) - softer
  const accentLight2 = new THREE.PointLight(0xff8800, 0.3, 15);
  accentLight2.position.set(4, 1.5, 4);
  scene.add(accentLight2);
  
  // Hemisphere light for overall illumination
  const hemisphereLight = new THREE.HemisphereLight(0xaaccff, 0x445566, 0.4);
  scene.add(hemisphereLight);
  
  console.log('✅ Lighting configured (NASA galaxy mode)');
}

/**
 * Camera animation state for cinematic zoom
 */
interface CameraAnimation {
  active: boolean;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startZoom: number;
  endZoom: number;
  progress: number;
  duration: number;
}

let cameraAnimation: CameraAnimation | null = null;

/**
 * Start cinematic zoom-in animation
 */
export function startCameraZoomIn(camera: THREE.OrthographicCamera) {
  cameraAnimation = {
    active: true,
    startPos: camera.position.clone(),
    endPos: new THREE.Vector3(10, 18, 10),
    startZoom: camera.zoom,
    endZoom: 0.8,
    progress: 0,
    duration: 2.5 // 2.5 seconds smooth animation
  };
  console.log('🎬 Starting zoom-in animation...');
}

/**
 * Update camera animation (call in main loop)
 */
export function updateCameraAnimation(camera: THREE.OrthographicCamera, deltaTime: number): boolean {
  if (!cameraAnimation || !cameraAnimation.active) return false;
  
  cameraAnimation.progress += deltaTime / cameraAnimation.duration;
  
  if (cameraAnimation.progress >= 1) {
    // Animation complete
    camera.position.copy(cameraAnimation.endPos);
    camera.zoom = cameraAnimation.endZoom;
    camera.lookAt(0, 0, 0); // Look at platform center
    camera.updateProjectionMatrix();
    cameraAnimation = null;
    console.log('✅ Zoom-in animation complete');
    return false;
  }
  
  // Smooth easing (ease-in-out cubic)
  const t = cameraAnimation.progress;
  const eased = t < 0.5 
    ? 4 * t * t * t 
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
  
  // Interpolate position
  camera.position.lerpVectors(
    cameraAnimation.startPos,
    cameraAnimation.endPos,
    eased
  );
  
  // Interpolate zoom
  camera.zoom = cameraAnimation.startZoom + 
    (cameraAnimation.endZoom - cameraAnimation.startZoom) * eased;
  
  // Smoothly transition lookAt from initial position to platform center
  const lookAtY = -2 + (2 * eased); // From -2 to 0
  camera.lookAt(0, lookAtY, 0);
  
  camera.updateProjectionMatrix();
  return true;
}

/**
 * Start final zoom for platform expansion
 */
export function startFinalZoom(camera: THREE.OrthographicCamera) {
  cameraAnimation = {
    active: true,
    startPos: camera.position.clone(),
    endPos: new THREE.Vector3(8, 15, 8),
    startZoom: camera.zoom,
    endZoom: 1.0,
    progress: 0,
    duration: 2.0
  };
  console.log('🎬 Starting final zoom for platform expansion...');
}
