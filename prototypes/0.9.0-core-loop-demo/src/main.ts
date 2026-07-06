/**
 * StarStation Furlong - Core Loop Demo
 * Main entry point — orthographic camera + hybrid WASD / point-and-click nav.
 */

import * as THREE from 'three';
import './style.css';
import { updateDebugHUD } from './hud';
import type { World } from './world';
import type { InputManager } from './input';
import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import { packTick, unpackTick, type RoomBootstrap } from './network/protocol';
import { SolarSystemMap } from './map';
import { MultiScaleZoomView } from './zoom';

type RendererModule = typeof import('./renderer');

// Game state
let world: World;
let inputManager: InputManager;
let rendererApi: RendererModule | null = null;
let lastTime = performance.now();
let frameCount = 0;
let fpsUpdateTime = 0;
let hasEntered = false;
let controlsHintShown = false;
let solarSystemMap: SolarSystemMap;
let isMapOpen = false;
let multiScaleZoom: MultiScaleZoomView;

// ── Raycasting (point-and-click navigation) ───────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

// Sovereign real-time networking state (Sprint 3)
const networkProvider = new NetworkProvider();
(window as any).networkProvider = networkProvider;
let yjsSync: YjsSync | null = null;
let localSeq = 0;
let lastTickSent = 0;
const seenPeers = new Set<string>();
let receivedTicks = 0;
let pendingBootstrapOverride: RoomBootstrap | null = null;
let activeBootstrap: RoomBootstrap | null = null;
let networkPanelInitialized = false;

// Local node identity (fetched from the Rust node's fingerprint endpoint).
// Kept so the user can mint bootstrap links for friends even before any peer
// connection exists — this is how the first node of a sovereign network
// comes online: there is no server, only peers. Every player's node seeds
// for the network by default; only their connection can prevent it.
interface LocalFingerprint { hex: string; base64: string; port: number; iroh_node_id?: string }
let localFingerprint: LocalFingerprint | null = null;
const BOOTSTRAP_ADDRESS_STORAGE_KEY = 'ssf-bootstrap-address';
const LEGACY_BOOTSTRAP_ADDRESS_KEY = 'ssf-host-address';

// ── Network status rows (network details panel) ──────────────────────────────
function setNetworkRow(id: string, value: string, color?: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
    if (color) (el as HTMLElement).style.color = color;
  }
}

/** Classify a hostname/IP into loopback / private (LAN) / public. */
function classifyAddress(hostname: string): 'loopback' | 'private' | 'public' {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return 'loopback';
  const isV6 = h.includes(':');
  if (isV6 && (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'))) return 'private';
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
      || /^169\.254\./.test(h) || h.endsWith('.local')) return 'private';
  return 'public';
}

const ADDRESS_TYPE_LABEL: Record<ReturnType<typeof classifyAddress>, string> = {
  loopback: 'LOOPBACK (this device only)',
  private: 'LAN (private range)',
  public: 'PUBLIC (internet)',
};

/** Best-effort physical connection type (Network Information API, Chromium). */
function detectConnectionType(): string {
  const conn = (navigator as { connection?: { type?: string; effectiveType?: string } }).connection;
  if (!conn) return '--';
  const parts = [conn.type, conn.effectiveType].filter(Boolean);
  return parts.length ? parts.join(' · ') : '--';
}

function refreshConnectionTypeRow(): void {
  const label = detectConnectionType();
  setNetworkRow('network-connection-type', label);
  if (label.includes('cellular')) {
    setNetworkRow('network-seeding-status', 'LIKELY CGNAT · LAN seeding only', '#ffb300');
  }
}

async function bootstrapNetworking() {
  try {
    // Setup phone input behaviors, hooks, and date-stamps (Task 4.1)
    setupSpacePhoneOverlay();
    const boot = pendingBootstrapOverride ?? await fetchDefaultBootstrap();
    if (!boot) {
      console.warn('⚠️ No running Rust node found. Seamlessly falling back to offline mode.');
      updateHUDLink('OFFLINE', '#ff1744');
      setNetworkRow('network-seeding-status', 'BASIC · join-only (no local node)', '#ffb300');
      return;
    }

    // 2. Connect Network link over WebTransport raw certhash (Task 3.2)
    seenPeers.clear();
    receivedTicks = 0;
    await networkProvider.connect(boot);
    activeBootstrap = boot;
    syncShareLink();

    updateHUDLink('CONNECTED', '#00e676');

    // Seeding readout: our own node serves on 0.0.0.0 whenever it runs —
    // every player is part of the hosting fabric unless their connection
    // blocks it. "Untested" until the self-test (or a real peer) proves it.
    if (await fetchLocalFingerprint()) {
      setNetworkRow('network-seeding-status', 'SEEDING · untested — run Self-Test', '#d4a84b');
    } else {
      setNetworkRow('network-seeding-status', 'BASIC · join-only (no local node)', '#ffb300');
    }

    // 3. Initiate yrs state document handshake over Stream (Task 3.3)
    const channel = await networkProvider.openChannel('ysync');
    yjsSync = new YjsSync({
      roomId: boot.roomId,
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
    // Distinguish "couldn't reach a REMOTE seed" — the classic locked-down
    // network signature (campus/corporate firewalls drop outbound UDP/QUIC
    // while normal web traffic still works).
    try {
      const attempted = pendingBootstrapOverride ?? activeBootstrap;
      if (attempted && classifyAddress(new URL(attempted.wtUrl).hostname) !== 'loopback') {
        setNetworkRow('network-seeding-status', 'RESTRICTED? · UDP/QUIC dial failed', '#ff1744');
        const feedback = document.getElementById('network-link-feedback');
        if (feedback) feedback.textContent = 'Could not dial the peer. Networks like universities/offices often block UDP — web pages load, but QUIC games cannot connect.';
      }
    } catch { /* diagnostic only */ }
  }
}

function setupSpacePhoneOverlay() {
  const container = document.getElementById('spacephone-container');
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  const chatForm = document.getElementById('chat-form');

  if (container) {
    container.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // Open/Close phone toggle binding Tab key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      // Suppress the browser's focus-cycling so Tab acts as a pure toggle,
      // and let it close the phone even while the chat input has focus.
      e.preventDefault();

      if (container) {
        container.classList.toggle('active');
        if (container.classList.contains('active')) {
          chatInput?.focus();
          logToPhoneSystem('Entering SpacePhone net...');
        } else {
          chatInput?.blur();
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
    // Standardize behavior and prevent focused inputs from scrolling/shifting window viewports
    chatInput.addEventListener('focus', () => {
      setTimeout(() => {
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
      }, 0);
    });

    chatInput.addEventListener('blur', () => {
      setTimeout(() => {
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
      }, 0);
    });

    // Window scroll reset guard: absolute prevention of focus shifts or keyboard offsets
    window.addEventListener('scroll', () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
    }, { passive: true });

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

async function fetchLocalFingerprint(): Promise<LocalFingerprint | null> {
  if (localFingerprint) return localFingerprint;
  let fingerprint: LocalFingerprint = { hex: '', base64: '', port: 4443 };
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
  localFingerprint = fingerprint;
  return fingerprint;
}

async function fetchDefaultBootstrap(): Promise<RoomBootstrap | null> {
  const fingerprint = await fetchLocalFingerprint();
  if (!fingerprint) {
    return null;
  }
  return {
    roomId: 'furlong-lobby',
    wtUrl: `https://127.0.0.1:${fingerprint.port}`,
    certHashesB64: [fingerprint.base64],
  };
}

/**
 * Normalise a user-entered host ("192.168.1.20", "my.ddns.net:5000", "::1")
 * into a WebTransport URL, defaulting to the local node's port.
 */
function parseHostAddress(raw: string, defaultPort: number): { wtUrl: string } | null {
  let input = raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!input) return null;
  // Bare IPv6 literals (more than one ':' and no brackets) need bracketing.
  if (input.split(':').length > 2 && !input.includes('[')) {
    input = `[${input}]`;
  }
  try {
    const url = new URL(`https://${input}`);
    if (!url.hostname) return null;
    const port = url.port ? Number(url.port) : defaultPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { wtUrl: `https://${url.hostname}:${port}` };
  } catch {
    return null;
  }
}

/**
 * Sovereign bootstrap: build a share link for OUR OWN node — no existing
 * peer connection required. The link carries the reachable address the user
 * entered plus this node's certificate hash, so the first friend can dial
 * directly. (Until on-chain peer publishing lands, this is the origin story
 * of every Furlong network.)
 */
async function generateBootstrapLink(): Promise<{ link?: string; error?: string }> {
  const fingerprint = await fetchLocalFingerprint();
  if (!fingerprint) {
    return { error: 'Local node not reachable — launch the app (or Rust node) first.' };
  }
  const addressInput = document.getElementById('network-bootstrap-address') as HTMLInputElement | null;
  const raw = addressInput?.value ?? '';
  const parsed = parseHostAddress(raw, fingerprint.port);
  if (!parsed) {
    return { error: 'Enter the address friends can reach you at (LAN IP, public IP, or DNS name).' };
  }
  try {
    localStorage.setItem(BOOTSTRAP_ADDRESS_STORAGE_KEY, raw.trim());
  } catch { /* storage unavailable — non-fatal */ }
  const scope = classifyAddress(new URL(parsed.wtUrl).hostname);
  setNetworkRow('network-address-type', ADDRESS_TYPE_LABEL[scope]);
  const boot: RoomBootstrap = {
    roomId: 'furlong-lobby',
    wtUrl: parsed.wtUrl,
    certHashesB64: [fingerprint.base64],
    irohNodeId: fingerprint.iroh_node_id, // Embed our Iroh Node ID for automatic hole-punching back-dial!
  };
  return { link: `${window.location.origin}${window.location.pathname}?seed=${encodeURIComponent(encodeBootstrapSeed(boot))}` };
}

/**
 * Serverless reachability self-test: dial our own node at the address the
 * user entered, from this browser, with the pinned cert hash. Proves LAN
 * reachability directly; public addresses are only a heuristic because many
 * routers refuse hairpin dials from inside the network.
 */
async function testOwnReachability(): Promise<{ ok: boolean; scope: 'loopback' | 'private' | 'public'; error?: string }> {
  const fingerprint = await fetchLocalFingerprint();
  if (!fingerprint) {
    return { ok: false, scope: 'public', error: 'Local node not reachable — launch the app (or Rust node) first.' };
  }
  const addressInput = document.getElementById('network-bootstrap-address') as HTMLInputElement | null;
  const parsed = parseHostAddress(addressInput?.value ?? '', fingerprint.port);
  if (!parsed) {
    return { ok: false, scope: 'public', error: 'Enter your reachable address first.' };
  }
  const scope = classifyAddress(new URL(parsed.wtUrl).hostname);
  setNetworkRow('network-address-type', ADDRESS_TYPE_LABEL[scope]);
  let wt: { ready: Promise<void>; close: () => void } | null = null;
  try {
    const hashes = [{
      algorithm: 'sha-256',
      value: Uint8Array.from(atob(fingerprint.base64), c => c.charCodeAt(0)),
    }];
    // @ts-ignore — WebTransport types not in lib.dom for this TS config
    wt = new WebTransport(parsed.wtUrl, { serverCertificateHashes: hashes });
    await Promise.race([
      wt!.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 4s')), 4000)),
    ]);
    return { ok: true, scope };
  } catch (err) {
    return { ok: false, scope, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { wt?.close(); } catch { /* already closed */ }
  }
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

  if (panel) {
    panel.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

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
        if (feedback) feedback.textContent = 'Not connected yet — use "Bootstrap Link" to start your own network.';
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

  // — Bootstrap-a-network controls (sovereign origin; every node seeds) —
  const bootstrapBtn = document.getElementById('network-bootstrap-link-btn');
  const bootstrapAddrInput = document.getElementById('network-bootstrap-address') as HTMLInputElement | null;
  if (bootstrapAddrInput) {
    try {
      const saved = localStorage.getItem(BOOTSTRAP_ADDRESS_STORAGE_KEY)
        ?? localStorage.getItem(LEGACY_BOOTSTRAP_ADDRESS_KEY);
      if (saved && !bootstrapAddrInput.value) {
        bootstrapAddrInput.value = saved;
      }
    } catch { /* storage unavailable — non-fatal */ }
  }
  if (bootstrapBtn) {
    bootstrapBtn.addEventListener('click', async () => {
      const { link, error } = await generateBootstrapLink();
      if (!link) {
        if (feedback) feedback.textContent = error ?? 'Could not generate bootstrap link.';
        return;
      }
      const shareEl = document.getElementById('network-share-link') as HTMLInputElement | null;
      if (shareEl) {
        shareEl.value = link;
      }
      try {
        await navigator.clipboard.writeText(link);
        if (feedback) feedback.textContent = 'Bootstrap link copied — anyone opening it dials your node directly.';
      } catch {
        if (feedback) feedback.textContent = 'Bootstrap link generated in the share field.';
      }
    });
  }

  const testBtn = document.getElementById('network-test-reach-btn');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      if (feedback) feedback.textContent = 'Self-testing reachability…';
      setNetworkRow('network-seeding-status', 'TESTING…', '#d4a84b');
      const { ok, scope, error } = await testOwnReachability();
      if (ok && scope === 'private') {
        setNetworkRow('network-seeding-status', 'SEEDING · verified on LAN', '#00e676');
        if (feedback) feedback.textContent = 'Reachable on your LAN. Friends outside your network need a public address or port-forward (UDP 4443).';
      } else if (ok && scope === 'public') {
        setNetworkRow('network-seeding-status', 'SEEDING · verified (internet)', '#00e676');
        if (feedback) feedback.textContent = 'Self-test reached your node via the public address — internet peers should too.';
      } else if (ok) {
        setNetworkRow('network-seeding-status', 'NODE UP · loopback only', '#d4a84b');
        if (feedback) feedback.textContent = 'That address only works on this device — enter your LAN or public address.';
      } else if (scope === 'public') {
        setNetworkRow('network-seeding-status', 'UNVERIFIED · self-test inconclusive', '#ffb300');
        if (feedback) feedback.textContent = `Could not reach your public address from inside (${error ?? 'no response'}). Many routers block hairpin dials — ask a friend to try the link, and check UDP 4443 forwarding.`;
      } else {
        setNetworkRow('network-seeding-status', 'BLOCKED · not reachable', '#ff1744');
        if (feedback) feedback.textContent = `Self-test failed (${error ?? 'no response'}). Check the address and that your firewall allows UDP 4443 in.`;
      }
    });
  }

  // Passive network-type readout (Network Information API where available)
  refreshConnectionTypeRow();
  const conn = (navigator as { connection?: EventTarget }).connection;
  conn?.addEventListener?.('change', refreshConnectionTypeRow);

  if (useBtn && importInput) {
    useBtn.addEventListener('click', async () => {
      const imported = decodeBootstrapInput(importInput.value.trim());
      if (!imported) {
        if (feedback) feedback.textContent = 'Invalid seed link.';
        return;
      }
      pendingBootstrapOverride = imported;
      if (feedback) feedback.textContent = 'Seed accepted. Connecting to new peer...';
      try {
        await networkProvider.disconnect();
      } catch (err) {
        console.warn('Error disconnecting prior network link:', err);
      }
      await bootstrapNetworking();
    });
  }
}

function buildShareLink(): string | null {
  if (!activeBootstrap) return null;
  let boot = activeBootstrap;
  // Self-seeding: our "active" bootstrap points at our own loopback node,
  // which is meaningless to a friend. Substitute the reachable bootstrap
  // address when the user has provided one.
  try {
    const url = new URL(boot.wtUrl);
    const isLoopback = classifyAddress(url.hostname) === 'loopback';
    if (isLoopback) {
      const addressInput = document.getElementById('network-bootstrap-address') as HTMLInputElement | null;
      const parsed = parseHostAddress(addressInput?.value ?? '', Number(url.port) || 4443);
      if (parsed) {
        boot = { ...boot, wtUrl: parsed.wtUrl };
      }
    }
  } catch { /* keep original bootstrap */ }
  return `${window.location.origin}${window.location.pathname}?seed=${encodeURIComponent(encodeBootstrapSeed(boot))}`;
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
    // Validate wtUrl is a well-formed https: URL (WebTransport requirement)
    let parsedWtUrl: URL;
    try {
      parsedWtUrl = new URL(parsed.wtUrl);
    } catch {
      return null;
    }
    if (parsedWtUrl.protocol !== 'https:') {
      return null;
    }
    const certHashesB64 = parsed.certHashesB64.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
    if (certHashesB64.length === 0) {
      return null;
    }
    const roomId = typeof parsed.roomId === 'string' && parsed.roomId.length > 0
      ? parsed.roomId
      : 'furlong-lobby';
    const irohNodeId = typeof parsed.irohNodeId === 'string' && parsed.irohNodeId.length > 0
      ? parsed.irohNodeId
      : undefined;
    return {
      roomId,
      wtUrl: parsed.wtUrl,
      certHashesB64,
      irohNodeId,
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

function setupSolarMap() {
  solarSystemMap = new SolarSystemMap();
  solarSystemMap.mount(document.body);
  (window as any).solarSystemMap = solarSystemMap;

  // Mount Multiscale Keyboard Zoom manager
  multiScaleZoom = new MultiScaleZoomView();
  multiScaleZoom.mount(document.body);
  (window as any).multiScaleZoom = multiScaleZoom;

  const toggleBtn = document.getElementById('solarmap-toggle-btn');

  const toggleMap = () => {
    isMapOpen = !isMapOpen;
    if (isMapOpen) {
      solarSystemMap.show();
    } else {
      solarSystemMap.hide();
    }
  };

  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMap();
    });
  }

  window.addEventListener('keydown', (e) => {
    // Check if player is focused in chat input before toggling map via M/m
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      return;
    }

    if (e.key === 'm' || e.key === 'M') {
      toggleMap();
    }
  });

  solarSystemMap.onTravelComplete((destinationId) => {
    console.log(`[Sharding Node] Swapping direct channel to room zone: ${destinationId}`);
    // Simulated multi-room zone sharding (v006 §8.5/§15.2)
    logToPhoneSystem(`🛰️ Transit Complete. Connected to Zone: ${destinationId.toUpperCase()}`);
  });
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
  (window as any).world = world;
  
  // Initialize input manager
  inputManager = new inputModule.InputManager();
  setupNetworkDetailsPanel();
  setupSolarMap();
  
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

    // Expand platform (planet → lobby morph) and bring networking up
    world.startMorph();
    bootstrapNetworking();

    // Hide welcome overlay
    const welcome = document.getElementById('welcome');
    if (welcome) {
      welcome.style.opacity = '0';
      setTimeout(() => { welcome.style.display = 'none'; }, 500);
    }

    window.removeEventListener('click', handleEnterClick);
    // Now register the point-and-click navigation handler
    window.addEventListener('click', onCanvasClick);
  };

  window.addEventListener('click', handleEnterClick);
}

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

  // Update game systems
  if (world) {
    world.update(deltaTime, inputManager);
  }

  if (solarSystemMap) {
    solarSystemMap.tick();
  }

  if (multiScaleZoom) {
    multiScaleZoom.tick();
  }

  if (hasEntered && !controlsHintShown && world.isPlayerActive()) {
    const controls = document.getElementById('controls');
    if (controls) {
      controls.style.animation = 'pulse 1s ease-in-out 3';
    }
    controlsHintShown = true;
  }

  // ── Datagram tick sender & stats HUD (Task 3.2 / 3.4)
  const elProvider = document.getElementById('phone-provider');
  const elSignalBars = document.getElementById('phone-signal-bars');

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

    // Expose the active Iroh Dial Key in the informational rows
    const keyRow = document.getElementById('net-iroh-key');
    if (keyRow) {
      const fullId = localFingerprint?.iroh_node_id || '--';
      keyRow.textContent = fullId.length > 20 ? `${fullId.slice(0, 10)}...${fullId.slice(-10)}` : fullId;
      keyRow.title = fullId; // hovering shows full robust public key
    }

    // Dynamic SpacePhone connection tier + signal bars indicator (LTE vs 3G, No Signal fallback)
    const seedingSpan = document.getElementById('network-seeding-status');
    const seedingStatus = seedingSpan?.textContent || '';
    const hasOpenPorts = seedingStatus.includes('verified') || seedingStatus.includes('PUBLIC');

    if (elProvider) {
      elProvider.textContent = hasOpenPorts ? 'FurlongNet LTE' : 'FurlongNet 3G';
    }

    if (elSignalBars) {
      // Calculate active signal bar colors as a function of peers or latency
      // RTT < 20ms = 5 bars, RTT < 100ms = 4 bars, RTT < 250ms = 3 bars, etc.
      let activeBars = 1;
      const rtt = stats.rttMs;
      if (!isNaN(rtt)) {
        if (rtt < 15) activeBars = 5;
        else if (rtt < 60) activeBars = 4;
        else if (rtt < 150) activeBars = 3;
        else if (rtt < 300) activeBars = 2;
      }
      
      const barsDivs = elSignalBars.children;
      for (let i = 0; i < barsDivs.length; i++) {
        const bar = barsDivs[i] as HTMLElement;
        if (i < activeBars) {
          bar.style.backgroundColor = '#00e676'; // vibrant green active bars
        } else {
          bar.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'; // dimmed background bars
        }
      }
    }
    
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
    updateDebugHUD('rtt', '--');
    updateDebugHUD('loss', '--');
    updateDebugHUD('net-peers-seen', '--');
    updateDebugHUD('net-ticks-recv', '--');
    updateDebugHUD('net-ping-pong', '--');
    updateDebugHUD('net-datagrams', '--');

    const keyRow = document.getElementById('net-iroh-key');
    if (keyRow) {
      keyRow.textContent = '--';
    }

    // Offline / No Signal fallback representation
    if (elProvider) {
      elProvider.textContent = 'NO SIGNAL';
    }

    if (elSignalBars) {
      const barsDivs = elSignalBars.children;
      for (let i = 0; i < barsDivs.length; i++) {
        const bar = barsDivs[i] as HTMLElement;
        bar.style.backgroundColor = 'rgba(255, 255, 255, 0.15)'; // all bars faded on offline
      }
    }
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
