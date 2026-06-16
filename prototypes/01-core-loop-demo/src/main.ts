/**
 * StarStation Furlong - Core Loop Demo
 * Main entry point
 */

import './style.css';
import { initRenderer } from './renderer';
import { World } from './world';
import { InputManager } from './input';

// Game state
let world: World;
let inputManager: InputManager;
let lastTime = performance.now();
let frameCount = 0;
let fpsUpdateTime = 0;

/**
 * Initialize the game
 */
async function init() {
  console.log('🚀 StarStation Furlong - Initializing...');
  
  // Initialize renderer
  const { renderer, camera, scene } = initRenderer();
  
  // Create world
  world = new World(scene);
  
  // Initialize input manager
  inputManager = new InputManager();
  
  console.log('✅ Initialization complete');
  
  // Start game loop
  animate();
}

/**
 * Main game loop
 */
function animate() {
  requestAnimationFrame(animate);
  
  const currentTime = performance.now();
  const deltaTime = (currentTime - lastTime) / 1000; // Convert to seconds
  lastTime = currentTime;
  
  // Update FPS counter
  frameCount++;
  fpsUpdateTime += deltaTime;
  if (fpsUpdateTime >= 0.5) { // Update every 0.5 seconds
    const fps = Math.round(frameCount / fpsUpdateTime);
    updateDebugHUD('fps', fps.toString());
    frameCount = 0;
    fpsUpdateTime = 0;
  }
  
  // Update game systems
  if (world) {
    world.update(deltaTime, inputManager);
  }
  
  // Render
  const { renderer, camera, scene } = window.gameRenderer;
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
