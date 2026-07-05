/**
 * StarStation Furlong - Navigation Demo
 * Main entry point — orthographic camera + hybrid WASD / point-and-click nav.
 */

import './style.css';
import * as THREE from 'three';
import { updateDebugHUD } from './hud';
import type { World } from './world';
import type { InputManager } from './input';

type RendererModule = typeof import('./renderer');

// Game state
let world: World;
let inputManager: InputManager;
let rendererApi: RendererModule | null = null;
let lastTime = performance.now();
let frameCount = 0;
let fpsUpdateTime = 0;
let hasEntered = false;

// ── Raycasting (point-and-click navigation) ───────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

/**
 * Handle canvas click: cast a ray through the scene and, if it hits the
 * clickable floor plane, request waypoint navigation to that position.
 */
function onCanvasClick(event: MouseEvent): void {
  if (!hasEntered || !rendererApi) return;

  const { camera } = window.gameRenderer;
  const clickPlane = world.getClickPlane();
  if (!clickPlane) return;

  // Normalised device coordinates
  mouse.x =  (event.clientX / window.innerWidth)  * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(clickPlane, false);

  for (const hit of hits) {
    if (hit.object.userData.isTile) {
      world.navigateTo(hit.point.x, hit.point.z);
      break;
    }
  }
}

/**
 * Initialize the game
 */
async function init() {
  console.log('🚀 StarStation Furlong (Navigation Demo) - Initializing...');

  const [rendererModule, worldModule, inputModule] = await Promise.all([
    import('./renderer'),
    import('./world'),
    import('./input'),
  ]);
  rendererApi = rendererModule;

  // Initialize renderer (orthographic camera, locked)
  const { scene } = rendererModule.initRenderer();

  // Create world
  world = new worldModule.World(scene);

  // Initialize input manager
  inputManager = new inputModule.InputManager();

  // Single click: expand the platform and enter the lobby
  setupClickToEnter();

  console.log('✅ Initialization complete');
  console.log('👆 Click to Enter');

  // Start game loop
  animate();
}

/**
 * One-click entry: expand the platform immediately (no camera zoom).
 * Subsequent clicks are routed to the navigation handler.
 */
function setupClickToEnter() {
  const handleEnterClick = () => {
    if (hasEntered) return;
    hasEntered = true;

    // Expand platform (planet → lobby morph)
    world.startMorph();

    // Hide welcome overlay
    const welcome = document.getElementById('welcome');
    if (welcome) {
      welcome.style.opacity = '0';
      setTimeout(() => { welcome.style.display = 'none'; }, 500);
    }

    window.removeEventListener('click', handleEnterClick);
    // Now register the navigation click handler
    window.addEventListener('click', onCanvasClick);
  };

  window.addEventListener('click', handleEnterClick);
}

/**
 * Main game loop
 */
function animate() {
  requestAnimationFrame(animate);

  if (!rendererApi) {
    return;
  }

  const currentTime = performance.now();
  const deltaTime = (currentTime - lastTime) / 1000; // seconds
  lastTime = currentTime;

  // Update FPS counter
  frameCount++;
  fpsUpdateTime += deltaTime;
  if (fpsUpdateTime >= 0.5) {
    const fps = Math.round(frameCount / fpsUpdateTime);
    updateDebugHUD('fps', fps.toString());
    frameCount = 0;
    fpsUpdateTime = 0;
  }

  // Get renderer state
  const { renderer, camera, scene } = window.gameRenderer;

  // Animate the nebula skysphere
  rendererApi.updateNebulaBackground(currentTime / 1000);

  // Update game systems
  if (world) {
    world.update(deltaTime, inputManager);
  }

  // Render — camera position/angle never changes
  renderer.render(scene, camera);
}

/**
 * Export debug HUD updater for other modules
 */
export { updateDebugHUD };

// Start the game
init().catch(console.error);
