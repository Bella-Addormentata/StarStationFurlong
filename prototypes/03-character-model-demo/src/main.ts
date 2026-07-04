/**
 * StarStation Furlong - Ortho Camera Demo
 * Main entry point — camera is locked (orthographic, fixed position/angle).
 */

import './style.css';
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

/**
 * Initialize the game
 */
async function init() {
  console.log('🚀 StarStation Furlong (Character Model Demo) - Initializing...');

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
 * The camera stays locked throughout.
 */
function setupClickToEnter() {
  const handleClick = () => {
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

    window.removeEventListener('click', handleClick);
  };

  window.addEventListener('click', handleClick);
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
 * Update debug HUD
 */
function updateDebugHUD(elementId: string, value: string) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = value;
  }
}

/**
 * Export debug HUD updater for other modules
 */
export { updateDebugHUD };

// Start the game
init().catch(console.error);
