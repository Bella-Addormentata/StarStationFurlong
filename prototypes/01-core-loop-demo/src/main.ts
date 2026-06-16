/**
 * StarStation Furlong - Core Loop Demo
 * Main entry point
 */

import './style.css';
import { initRenderer, startCameraZoomIn, startFinalZoom, updateCameraAnimation } from './renderer';
import { World } from './world';
import { InputManager } from './input';

// Game state
let world: World;
let inputManager: InputManager;
let lastTime = performance.now();
let frameCount = 0;
let fpsUpdateTime = 0;
let hasZoomedIn = false;
let hasExpanded = false;
let welcomeShown = false;
let controlsHintShown = false;

/**
 * Initialize the game
 */
async function init() {
  console.log('🚀 StarStation Furlong - Initializing...');
  
  // Initialize renderer
  const { scene } = initRenderer();
  
  // Create world
  world = new World(scene);
  
  // Initialize input manager
  inputManager = new InputManager();
  
  // Setup click-to-zoom interaction
  setupClickToZoom();
  
  console.log('✅ Initialization complete');
  console.log('👆 Click to Enter');
  
  // Start game loop
  animate();
}

/**
 * Setup click-to-zoom interaction
 */
function setupClickToZoom() {
  const handleClick = () => {
    // First click: Zoom into the station planet
    if (!hasZoomedIn) {
      hasZoomedIn = true;
      const { camera } = window.gameRenderer;
      
      // Start camera zoom animation only
      startCameraZoomIn(camera);
      
      // Hide welcome message
      const welcome = document.getElementById('welcome');
      if (welcome) {
        welcome.style.opacity = '0';
        setTimeout(() => {
          welcome.style.display = 'none';
        }, 500);
      }
      
      return;
    }
    
    // Second click: Expand platform
    if (!hasExpanded) {
      hasExpanded = true;
      const { camera } = window.gameRenderer;
      
      // Start final zoom to gameplay view
      startFinalZoom(camera);
      
      // Start planet-to-platform morph
      world.startMorph();
      
      // Hide expand hint
      const welcome = document.getElementById('welcome');
      if (welcome) {
        welcome.style.opacity = '0';
        setTimeout(() => {
          welcome.style.display = 'none';
        }, 500);
      }
      
      // Remove click handler after expansion
      window.removeEventListener('click', handleClick);
    }
  };
  
  window.addEventListener('click', handleClick);
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
  
  // Get renderer state
  const { renderer, camera, scene } = window.gameRenderer;
  
  // Update camera animation if active
  const isCameraAnimating = updateCameraAnimation(camera, deltaTime);
  
  // Update game systems
  if (world) {
    world.update(deltaTime, inputManager);
  }

  if (hasZoomedIn && !hasExpanded && !isCameraAnimating && !welcomeShown) {
    showWelcomeOverlay();
    welcomeShown = true;
  }

  if (hasExpanded && !controlsHintShown && world.isPlayerActive()) {
    const controls = document.getElementById('controls');
    if (controls) {
      controls.style.animation = 'pulse 1s ease-in-out 3';
    }
    controlsHintShown = true;
  }
  
  // Render
  renderer.render(scene, camera);
}

function showWelcomeOverlay() {
  const welcome = document.getElementById('welcome');
  if (!welcome) {
    return;
  }

  welcome.innerHTML = `
    <div id="welcome-content">
      <div class="hint" style="font-size: 18px; animation: pulse 2s ease-in-out infinite;">
        ✨ Welcome
      </div>
    </div>
  `;
  welcome.style.background = 'rgba(10, 15, 25, 0.2)';
  welcome.style.backdropFilter = 'blur(3px)';
  welcome.style.display = 'flex';
  welcome.style.opacity = '1';
  welcome.style.cursor = 'pointer';
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
