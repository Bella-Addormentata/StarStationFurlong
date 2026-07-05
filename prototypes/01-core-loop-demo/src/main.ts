/**
 * StarStation Furlong - Core Loop Demo
 * Main entry point
 */

import * as THREE from 'three';
import './style.css';
import type { World } from './world';
import type { InputManager } from './input';
import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import { packTick, unpackTick, type RoomBootstrap } from './network/protocol';

type RendererModule = typeof import('./renderer');

// Game state
let world: World;
let inputManager: InputManager;
let rendererApi: RendererModule | null = null;
let lastTime = performance.now();
let frameCount = 0;
let fpsUpdateTime = 0;
let hasZoomedIn = false;
let hasExpanded = false;
let welcomeShown = false;
let controlsHintShown = false;

// ── Raycasting (point-and-click navigation) ───────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

// Sovereign real-time networking state (Sprint 3)
const networkProvider = new NetworkProvider();
let yjsSync: YjsSync | null = null;
let localSeq = 0;
let lastTickSent = 0;
const seenPeers = new Set<string>();
let receivedTicks = 0;
let pendingBootstrapOverride: RoomBootstrap | null = null;
let activeBootstrap: RoomBootstrap | null = null;
let networkPanelInitialized = false;

async function bootstrapNetworking() {
  try {
    // Setup phone input behaviors, hooks, and date-stamps (Task 4.1)
    setupSpacePhoneOverlay();
    const boot = pendingBootstrapOverride ?? await fetchDefaultBootstrap();
    if (!boot) {
      console.warn('⚠️ No running Rust node found. Seamlessly falling back to offline mode.');
      updateHUDLink('OFFLINE', '#ff1744');
      return;
    }

    // 2. Connect Network link over WebTransport raw certhash (Task 3.2)
    await networkProvider.connect(boot);
    activeBootstrap = boot;
    syncShareLink();

    updateHUDLink('CONNECTED', '#00e676');

    // 3. Initiate yrs state document handshake over Stream (Task 3.3)
    const channel = await networkProvider.openChannel('ysync');
    yjsSync = new YjsSync({
      roomId: 'furlong-lobby',
      channel,
    });
    await yjsSync.start();

    // Bind shared chat array updates to SpacePhone interface (Task Task 3.3/4.1)
    const sharedChat = yjsSync.doc.getArray('chat');
    sharedChat.observe((_event) => {
      // Re-populate our scroll container whenever sync modifications occur
      const container = document.getElementById('chat-messages-container');
      if (container) {
        // Safe clear except original system greet is fine
        container.innerHTML = `<div class="chat-bubble system">📲 SpacePhone connection ready. Welcome to Furlong System Net!</div>`;
        const items: any[] = sharedChat.toArray();
        items.forEach(item => {
          const isMe = item.authorName === 'Local-Clone';
          const bubble = document.createElement('div');
          bubble.className = `chat-bubble ${isMe ? 'outbound' : 'inbound'}`;
          
          const nameSpan = document.createElement('span');
          nameSpan.className = 'chat-sender-name';
          nameSpan.textContent = item.authorName;
          
          const textNode = document.createTextNode(item.text);
          
          bubble.appendChild(nameSpan);
          bubble.appendChild(textNode);
          container.appendChild(bubble);
        });
        container.scrollTop = container.scrollHeight;
      }
    });

    // 4. Set up incoming real-time client movement tick handler
    networkProvider.onTick((buf) => {
      try {
        const tick = unpackTick(buf);
        // Identify fake/peer client ID from seq mapping
        const peerId = `peer-${tick.seq % 4}`;
        seenPeers.add(peerId);
        receivedTicks++;
        world.updateRemotePlayer(peerId, tick.x, tick.z);
      } catch (e) {
        console.warn('Error unpacking incoming remote peer datagram tick:', e);
      }
    });

  } catch (err) {
    console.warn('Failed to bootstrap connection link:', err);
    updateHUDLink('OFFLINE', '#ff1744');
  }
}

function setupSpacePhoneOverlay() {
  const container = document.getElementById('spacephone-container');
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  const chatForm = document.getElementById('chat-form');

  // Open/Close phone toggle binding 'P' key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'p' || e.key === 'P') {
      // Prioritise input fields focus bypasses
      if (document.activeElement === chatInput) return;
      
      if (container) {
        container.classList.toggle('active');
        if (container.classList.contains('active')) {
          chatInput?.focus();
          logToPhoneSystem('Entering SpacePhone net...');
        }
      }
    }
  });

  // Keep phone date-stamp live
  const updatePhoneTime = () => {
    const elTime = document.getElementById('phone-time');
    if (elTime) {
      elTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  };
  setInterval(updatePhoneTime, 10000);
  updatePhoneTime();

  // Inbound broadcast triggers
  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = chatInput.value.trim();
      if (!val) return;

      chatInput.value = '';

      if (yjsSync) {
        const sharedChat = yjsSync.doc.getArray('chat');
        // Transact safe transactional delta block append (Task 3.3 / 4.1)
        yjsSync.doc.transact(() => {
          sharedChat.push([{
            authorName: 'Local-Clone',
            text: val,
            atTick: localSeq,
            scope: 'global'
          }]);
        });
      } else {
        // Fallback offline simulator if no node serves connection
        simulateLocalMessage(val);
      }
    });
  }
}

async function fetchDefaultBootstrap(): Promise<RoomBootstrap | null> {
  let fingerprint = { hex: "", base64: "", port: 4443 };
  try {
    const res = await fetch('http://127.0.0.1:8080/api/fingerprint');
    fingerprint = await res.json();
  } catch {
    const res = await fetch('http://127.0.0.1:8081/api/fingerprint').catch(() => null);
    if (res) {
      fingerprint = await res.json();
    }
  }
  if (!fingerprint.hex) {
    return null;
  }
  return {
    roomId: 'furlong-lobby',
    wtUrl: `https://127.0.0.1:${fingerprint.port}`,
    certHashesB64: [fingerprint.base64],
  };
}

function setupNetworkDetailsPanel() {
  if (networkPanelInitialized) return;
  networkPanelInitialized = true;

  const panel = document.getElementById('network-details-hud');
  const toggle = document.getElementById('network-details-toggle');
  const copyBtn = document.getElementById('network-copy-link-btn');
  const useBtn = document.getElementById('network-use-link-btn');
  const importInput = document.getElementById('network-import-link') as HTMLInputElement | null;
  const feedback = document.getElementById('network-link-feedback');

  if (panel && toggle) {
    toggle.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      toggle.textContent = panel.classList.contains('collapsed') ? '▼' : '▲';
      toggle.setAttribute('aria-label', panel.classList.contains('collapsed') ? 'Expand network details' : 'Collapse network details');
    });
  }

  const urlSeed = new URL(window.location.href).searchParams.get('seed');
  if (urlSeed) {
    const imported = decodeBootstrapSeed(urlSeed);
    if (imported) {
      pendingBootstrapOverride = imported;
      if (feedback) {
        feedback.textContent = 'Seed loaded from URL. Connect to use it.';
      }
      if (importInput) {
        importInput.value = window.location.href;
      }
    }
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const shareLink = buildShareLink();
      if (!shareLink) {
        if (feedback) feedback.textContent = 'No active link yet. Connect first.';
        return;
      }
      const shareEl = document.getElementById('network-share-link') as HTMLInputElement | null;
      if (shareEl) {
        shareEl.value = shareLink;
      }
      try {
        await navigator.clipboard.writeText(shareLink);
        if (feedback) feedback.textContent = 'Share link copied.';
      } catch {
        if (feedback) feedback.textContent = 'Share link generated in field.';
      }
    });
  }

  if (useBtn && importInput) {
    useBtn.addEventListener('click', () => {
      const imported = decodeBootstrapInput(importInput.value.trim());
      if (!imported) {
        if (feedback) feedback.textContent = 'Invalid seed link.';
        return;
      }
      pendingBootstrapOverride = imported;
      if (feedback) feedback.textContent = 'Seed accepted. Connect to use it.';
    });
  }
}

function buildShareLink(): string | null {
  if (!activeBootstrap) return null;
  return `${window.location.origin}${window.location.pathname}?seed=${encodeURIComponent(encodeBootstrapSeed(activeBootstrap))}`;
}

function syncShareLink() {
  const shareEl = document.getElementById('network-share-link') as HTMLInputElement | null;
  const link = buildShareLink();
  if (shareEl && link) {
    shareEl.value = link;
  }
}

function encodeBootstrapSeed(boot: RoomBootstrap): string {
  return btoa(JSON.stringify(boot));
}

function decodeBootstrapSeed(seed: string): RoomBootstrap | null {
  try {
    const parsed = JSON.parse(atob(seed));
    if (typeof parsed.wtUrl !== 'string' || !Array.isArray(parsed.certHashesB64)) {
      return null;
    }
    const certHashesB64 = parsed.certHashesB64.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
    if (certHashesB64.length === 0) {
      return null;
    }
    return {
      roomId: typeof parsed.roomId === 'string' ? parsed.roomId : 'furlong-lobby',
      wtUrl: parsed.wtUrl,
      certHashesB64,
    };
  } catch {
    return null;
  }
}

function decodeBootstrapInput(input: string): RoomBootstrap | null {
  if (!input) return null;
  try {
    const parsedUrl = new URL(input);
    const seed = parsedUrl.searchParams.get('seed');
    if (seed) {
      return decodeBootstrapSeed(seed);
    }
  } catch {
    // Not a URL; try raw base64 seed.
  }
  return decodeBootstrapSeed(input);
}

function logToPhoneSystem(msg: string) {
  const container = document.getElementById('chat-messages-container');
  if (container) {
    const div = document.createElement('div');
    div.className = 'chat-bubble system';
    div.textContent = msg;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }
}

function simulateLocalMessage(val: string) {
  const container = document.getElementById('chat-messages-container');
  if (container) {
    const ourBubble = document.createElement('div');
    ourBubble.className = 'chat-bubble outbound';
    ourBubble.innerHTML = `<span class="chat-sender-name">Local-Clone</span>${val}`;
    container.appendChild(ourBubble);

    // Cute simulated server response after 1.5 seconds
    setTimeout(() => {
      const resp = document.createElement('div');
      resp.className = 'chat-bubble inbound';
      const hints = [
        "Furlong Station: Status clean. Carry on.",
        "Clone-42: Nice voxel suit! Where did you secure it?",
        "Oracle: Keep walking the path, clone. Reaching coordinates...",
        "System: Seeding allowlisted topics.",
        "Spacephone Net: High atmosphere density observed."
      ];
      const randomHint = hints[Math.floor(Math.random() * hints.length)];
      resp.innerHTML = `<span class="chat-sender-name">Remote-Clone</span>${randomHint}`;
      container.appendChild(resp);
      container.scrollTop = container.scrollHeight;
    }, 1500);

    container.scrollTop = container.scrollHeight;
  }
}

function updateHUDLink(status: string, color: string) {
  const linkEl = document.getElementById('link-status');
  if (linkEl) {
    linkEl.textContent = status;
    linkEl.style.color = color;
  }
}

/**
 * Initialize the game
 */
async function init() {
  console.log('🚀 StarStation Furlong - Initializing...');

  const [rendererModule, worldModule, inputModule] = await Promise.all([
    import('./renderer'),
    import('./world'),
    import('./input'),
  ]);
  rendererApi = rendererModule;
  
  // Initialize renderer
  const { scene } = rendererModule.initRenderer();
  
  // Create world
  world = new worldModule.World(scene);
  
  // Initialize input manager
  inputManager = new inputModule.InputManager();
  setupNetworkDetailsPanel();
  
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
    if (!rendererApi) {
      return;
    }

    // First click: Zoom into the station planet
    if (!hasZoomedIn) {
      hasZoomedIn = true;
      const { camera } = window.gameRenderer;
      
      // Start camera zoom animation only
      rendererApi.startCameraZoomIn(camera);
      
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
      rendererApi.startFinalZoom(camera);
      
      // Start planet-to-platform morph
      world.startMorph();
      bootstrapNetworking();
      
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
      
      // Register point-and-click pathfinding navigation (Task Issue 10)
      window.addEventListener('click', onCanvasClick);
    }
  };
  
  window.addEventListener('click', handleClick);
}

function onCanvasClick(event: MouseEvent): void {
  if (!hasExpanded || !rendererApi) return;

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
 * Main game loop
 */
function animate() {
  requestAnimationFrame(animate);

  if (!rendererApi) {
    return;
  }
  
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

  // Animate the nebula skysphere
  rendererApi.updateNebulaBackground(currentTime / 1000);

  // Update camera animation if active
  const isCameraAnimating = rendererApi.updateCameraAnimation(camera, deltaTime);
  
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

  // ── Datagram tick sender & stats HUD (Task 3.2 / 3.4)
  if (networkProvider.mode() !== 'offline') {
    const stats = networkProvider.stats();
    const debug = networkProvider.debugInfo();
    updateDebugHUD('rtt', `${isNaN(stats.rttMs) ? '--' : Math.round(stats.rttMs)} ms`);
    updateDebugHUD('loss', `${isNaN(stats.loss) ? '--' : Math.round(stats.loss * 100)} %`);
    updateDebugHUD('net-peers-seen', seenPeers.size.toString());
    updateDebugHUD('net-ticks-recv', receivedTicks.toString());
    updateDebugHUD('net-ping-pong', `${debug.pingSent}/${debug.pongRecv}`);
    updateDebugHUD('net-datagrams', debug.datagramsRecv.toString());
    updateDebugHUD('net-uptime', debug.connectedForMs > 0 ? `${Math.round(debug.connectedForMs / 1000)}s` : '--');
    updateDebugHUD('net-endpoint', debug.endpointUrl.replace('https://', ''));
    
    // Broadcast movement ticks at 20 Hz (50 ms interval) when moving
    if (world.isPlayerActive() && currentTime - lastTickSent >= 50) {
      const localPos = world.getPlayer().getPosition();
      const dir = inputManager.getMoveDirection();
      const tickData = {
        flags: (dir.x !== 0 || dir.z !== 0) ? 1 : 0,
        x: localPos.x,
        z: localPos.z,
        yaw: 0, // fixed direction for isometric rotation
        seq: localSeq++,
      };
      
      const packed = packTick(tickData);
      networkProvider.sendTick(packed);
      lastTickSent = currentTime;
    }
  } else {
    updateDebugHUD('net-uptime', '--');
    updateDebugHUD('net-endpoint', '--');
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
        ✨ LOBBY
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
