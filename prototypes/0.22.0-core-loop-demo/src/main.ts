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
import { packTick, unpackTick, type RoomBootstrap, type RoomMemberHint } from './network/protocol';
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
interface LocalFingerprint {
  hex: string;
  base64: string;
  port: number;
  iroh_node_id?: string;
  iroh_relay_urls?: string[];
  iroh_direct_addrs?: string[];
}
let localFingerprint: LocalFingerprint | null = null;
const BOOTSTRAP_ADDRESS_STORAGE_KEY = 'ssf-bootstrap-address';
const LEGACY_BOOTSTRAP_ADDRESS_KEY = 'ssf-host-address';
const ROOM_KEY_STORAGE_PREFIX = 'ssf-roomkey:';

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function generateRoomKeyB64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function getOrCreateRoomKeyB64(roomId: string): string {
  const storageKey = `${ROOM_KEY_STORAGE_PREFIX}${roomId}`;
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) {
      return existing;
    }
    const generated = generateRoomKeyB64();
    localStorage.setItem(storageKey, generated);
    return generated;
  } catch {
    return generateRoomKeyB64();
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function normalizeMemberHint(value: unknown): RoomMemberHint | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.irohNodeId !== 'string' || entry.irohNodeId.length === 0) {
    return null;
  }
  const relayHints = normalizeStringArray(entry.irohRelayUrls);
  const directHints = normalizeStringArray(entry.irohDirectAddrs);
  return {
    irohNodeId: entry.irohNodeId,
    irohRelayUrls: relayHints.length ? relayHints : undefined,
    irohDirectAddrs: directHints.length ? directHints : undefined,
  };
}

function collectMemberHints(boot: RoomBootstrap | null | undefined): RoomMemberHint[] {
  if (!boot) return [];
  const hints: RoomMemberHint[] = [];

  if (Array.isArray(boot.memberHints)) {
    for (const hint of boot.memberHints) {
      const normalized = normalizeMemberHint(hint);
      if (normalized) {
        hints.push(normalized);
      }
    }
  }

  if (boot.irohNodeId) {
    hints.push({
      irohNodeId: boot.irohNodeId,
      irohRelayUrls: boot.irohRelayUrls ?? boot.relays,
      irohDirectAddrs: boot.irohDirectAddrs,
    });
  }

  return hints;
}

function mergeMemberHints(...hintLists: RoomMemberHint[][]): RoomMemberHint[] {
  const merged = new Map<string, RoomMemberHint>();
  for (const list of hintLists) {
    for (const hint of list) {
      const existing = merged.get(hint.irohNodeId);
      if (!existing) {
        merged.set(hint.irohNodeId, {
          irohNodeId: hint.irohNodeId,
          irohRelayUrls: hint.irohRelayUrls ? [...hint.irohRelayUrls] : undefined,
          irohDirectAddrs: hint.irohDirectAddrs ? [...hint.irohDirectAddrs] : undefined,
        });
        continue;
      }

      const relays = new Set([...(existing.irohRelayUrls ?? []), ...(hint.irohRelayUrls ?? [])]);
      const addrs = new Set([...(existing.irohDirectAddrs ?? []), ...(hint.irohDirectAddrs ?? [])]);
      existing.irohRelayUrls = relays.size ? Array.from(relays) : undefined;
      existing.irohDirectAddrs = addrs.size ? Array.from(addrs) : undefined;
    }
  }
  return Array.from(merged.values());
}

function getLocalNodeHint(fingerprint: LocalFingerprint): RoomMemberHint | null {
  if (!fingerprint.iroh_node_id) return null;
  const relayHints = normalizeStringArray(fingerprint.iroh_relay_urls);
  const directHints = normalizeStringArray(fingerprint.iroh_direct_addrs);
  return {
    irohNodeId: fingerprint.iroh_node_id,
    irohRelayUrls: relayHints.length ? relayHints : undefined,
    irohDirectAddrs: directHints.length ? directHints : undefined,
  };
}

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
      updateHUDNode('OFFLINE', '#ff1744');
      updateHUDP2P('OFFLINE', '#ff1744');
      setNetworkRow('network-seeding-status', 'BASIC · join-only (no local node)', '#ffb300');
      return;
    }

    // 2. Connect Network link over WebTransport raw certhash (Task 3.2)
    seenPeers.clear();
    receivedTicks = 0;
    updateHUDNode('ONLINE', '#00e676');
    await networkProvider.connect(boot);
    activeBootstrap = boot;
    await syncShareLink();

    updateHUDP2P('CONNECTED', '#00e676');

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

    // 3b. Route NODE-INITIATED envelopes (🐛 0.16.0 blocker fix): remote peers'
    // updates are bridged to us on node-opened streams — feed ysync frames into
    // the shared doc and surface bridge dial-status instead of failing silently.
    networkProvider.onEnvelope((env: { kind?: string; payload?: string; room?: string }) => {
      if (env.kind === 'ysync') {
        yjsSync?.ingestEnvelope(env);
        return;
      }
      if (env.kind === 'bridge' && typeof env.payload === 'string') {
        try {
          const status = JSON.parse(atob(env.payload)) as { target?: string; status?: string; detail?: string };
          const shortTarget = (status.target ?? '').slice(0, 8);
          if (status.status === 'dialing') {
            setNetworkRow('network-bridge-status', `DIALING → ${shortTarget}…`, '#d4a84b');
          } else if (status.status === 'connected') {
            setNetworkRow('network-bridge-status', `LINKED ↔ ${shortTarget}`, '#00e676');
            logToPhoneSystem(`🎉 P2P bridge linked to station ${shortTarget}…`);
          } else if (status.status === 'failed') {
            setNetworkRow('network-bridge-status', `FAILED → ${shortTarget} (see node log)`, '#ff1744');
            logToPhoneSystem(`⚠️ P2P dial to ${shortTarget}… failed: ${status.detail ?? 'unknown error'}. If both stations are behind home routers, one side needs to forward UDP 44442 on their router (the node's default pinned port; SSF_IROH_PORT overrides) or use a relay (SSF_RELAYS).`);
          }
        } catch (e) {
          console.warn('Unparseable bridge status envelope:', e);
        }
      }
    });

    // Bind shared room info map updates (Task: Room Name & Room Owner)
    const roomMap = yjsSync.doc.getMap('roomInfo');
    if (!roomMap.has('owner')) {
      yjsSync.doc.transact(() => {
        roomMap.set('owner', 'Local-Clone');
        roomMap.set('name', boot.roomId || 'Lobby');
      });
    }

    const updateRoomUI = () => {
      const nameVal = roomMap.get('name') as string || 'Lobby';
      const ownerVal = roomMap.get('owner') as string || 'Local-Clone';
      
      const nameEl = document.getElementById('room-name-display');
      const ownerEl = document.getElementById('room-owner-display');
      
      if (nameEl && !document.getElementById('room-name-input')) {
        nameEl.textContent = nameVal;
      }
      if (ownerEl) {
        ownerEl.textContent = ownerVal;
      }
    };

    roomMap.observe((_event) => {
      updateRoomUI();
    });

    updateRoomUI();

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
    updateHUDP2P('OFFLINE', '#ff1744');
    const fp = await fetchLocalFingerprint();
    if (fp) {
      updateHUDNode('ONLINE', '#00e676');
    } else {
      updateHUDNode('OFFLINE', '#ff1744');
    }
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
  const tipIndicator = document.getElementById('phone-tip-indicator');

  // 📱 Phone shell view router (issue #20 S1) — home screen + per-app views.
  // Policy: Tab always opens the phone to the HOME screen (deterministic,
  // one tap to any app) rather than restoring the last open view.
  type PhoneViewId = 'home' | 'chat' | 'contacts' | 'bank';
  const phoneViewMeta: Record<PhoneViewId, { elId: string; title: string; subtitle: string }> = {
    home:     { elId: 'phone-home-screen',   title: '📱 HOME',        subtitle: 'FurlongOS · Select App' },
    chat:     { elId: 'phone-app-chat',      title: '👨‍🚀 CLONE CHAT', subtitle: 'Room: Furlong Lobby' },
    contacts: { elId: 'phone-app-contacts',  title: '👥 CONTACTS',    subtitle: 'FurlongNet Directory' },
    bank:     { elId: 'phone-app-bank',      title: '🏦 BANK',        subtitle: 'Furlong Credit Union' },
  };
  let currentPhoneView: PhoneViewId = 'home';
  const backBtn = document.getElementById('phone-back-btn');
  const appTitle = document.getElementById('phone-app-title');
  const appSubtitle = document.getElementById('phone-app-subtitle');

  const showPhoneView = (id: PhoneViewId) => {
    currentPhoneView = id;
    (Object.keys(phoneViewMeta) as PhoneViewId[]).forEach((viewId) => {
      const el = document.getElementById(phoneViewMeta[viewId].elId);
      if (el) el.classList.toggle('active', viewId === id);
    });
    if (appTitle) appTitle.textContent = phoneViewMeta[id].title;
    if (appSubtitle) appSubtitle.textContent = phoneViewMeta[id].subtitle;
    // Back chevron only makes sense inside an app view
    if (backBtn) backBtn.style.display = id === 'home' ? 'none' : 'flex';
    // Chat input focus lives in the chat-view-open path (was: on phone open)
    if (id === 'chat') {
      chatInput?.focus();
      // Hidden views report scrollHeight 0 — restore tail-scroll on re-entry
      const messages = document.getElementById('chat-messages-container');
      if (messages) messages.scrollTop = messages.scrollHeight;
    } else {
      chatInput?.blur();
    }
  };

  // App tiles on the home screen route into their views
  document.querySelectorAll<HTMLButtonElement>('.phone-app-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const target = tile.dataset.phoneApp as PhoneViewId | undefined;
      if (target && target in phoneViewMeta) {
        showPhoneView(target);
      }
    });
  });

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showPhoneView('home');
    });
  }

  // Esc returns to home while the phone is open and inside an app view.
  // (Esc is otherwise only used by the room-name inline editor input, which
  // we exclude via the non-chat input guard below.)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!container || !container.classList.contains('active')) return;
    const active = document.activeElement;
    if (
      active && active !== chatInput &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
    ) {
      return; // e.g. room-name editor owns Escape for cancel
    }
    if (currentPhoneView !== 'home') {
      e.preventDefault();
      showPhoneView('home');
    }
  });

  const removeTipIndicator = () => {
    if (tipIndicator) {
      tipIndicator.style.opacity = '0';
      setTimeout(() => {
        tipIndicator.remove();
      }, 500);
      try {
        localStorage.setItem('ssf-spacephone-tipped', 'true');
      } catch {}
    }
  };

  // Check if tip has been closed globally before
  try {
    if (localStorage.getItem('ssf-spacephone-tipped') === 'true' && tipIndicator) {
      tipIndicator.remove();
    }
  } catch {}

  if (tipIndicator) {
    // Permit clicking on the indicator itself to pop the SpacePhone as a fallback
    tipIndicator.style.cursor = 'pointer';
    tipIndicator.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTipIndicator();
      if (container) {
        container.classList.add('active');
        showPhoneView('home');
        logToPhoneSystem('Entering SpacePhone net...');
      }
    });
  }

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

      if (tipIndicator) {
        removeTipIndicator();
      }

      if (container) {
        container.classList.toggle('active');
        if (container.classList.contains('active')) {
          // Always land on the home screen (see view-router policy note above)
          showPhoneView('home');
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
  fingerprint.iroh_relay_urls = normalizeStringArray(fingerprint.iroh_relay_urls);
  fingerprint.iroh_direct_addrs = normalizeStringArray(fingerprint.iroh_direct_addrs);
  localFingerprint = fingerprint;
  return fingerprint;
}

async function fetchDefaultBootstrap(): Promise<RoomBootstrap | null> {
  const fingerprint = await fetchLocalFingerprint();
  if (!fingerprint) {
    return null;
  }
  const roomId = activeBootstrap?.roomId ?? 'furlong-lobby';
  const roomKeyB64 = activeBootstrap?.roomKeyB64 ?? getOrCreateRoomKeyB64(roomId);
  const localHint = getLocalNodeHint(fingerprint);
  return {
    v: 2,
    roomId,
    roomKeyB64,
    wtUrl: `https://127.0.0.1:${fingerprint.port}`,
    certHashesB64: [fingerprint.base64],
    memberHints: localHint ? [localHint] : undefined,
    irohNodeId: localHint?.irohNodeId,
    irohRelayUrls: localHint?.irohRelayUrls,
    irohDirectAddrs: localHint?.irohDirectAddrs,
  };
}

function buildOutgoingBootstrap(parsedWtUrl: string, fingerprint: LocalFingerprint): RoomBootstrap {
  const roomId = activeBootstrap?.roomId ?? 'furlong-lobby';
  const roomKeyB64 = activeBootstrap?.roomKeyB64 ?? getOrCreateRoomKeyB64(roomId);

  const localHint = getLocalNodeHint(fingerprint);
  const mergedHints = mergeMemberHints(
    localHint ? [localHint] : [],
    collectMemberHints(activeBootstrap),
  );
  const primaryHint = localHint ?? mergedHints[0];

  return {
    v: 2,
    roomId,
    roomKeyB64,
    wtUrl: parsedWtUrl,
    certHashesB64: [fingerprint.base64],
    memberHints: mergedHints.length ? mergedHints : undefined,
    irohNodeId: primaryHint?.irohNodeId,
    irohRelayUrls: primaryHint?.irohRelayUrls,
    irohDirectAddrs: primaryHint?.irohDirectAddrs,
    issuedAt: Date.now(),
  };
}

async function mintBootstrapLink(rawAddress?: string): Promise<{ link?: string; error?: string; scope?: ReturnType<typeof classifyAddress> }> {
  const fingerprint = await fetchLocalFingerprint();
  if (!fingerprint) {
    return { error: 'Local node not reachable — launch the app (or Rust node) first.' };
  }

  const override = (rawAddress ?? '').trim();
  let wtUrl = `https://127.0.0.1:${fingerprint.port}`;
  let scope: ReturnType<typeof classifyAddress> = 'loopback';

  if (override) {
    const parsed = parseHostAddress(override, fingerprint.port);
    if (!parsed) {
      return { error: 'Enter a valid override address (LAN IP, public IP, or DNS name).' };
    }
    wtUrl = parsed.wtUrl;
    scope = classifyAddress(new URL(parsed.wtUrl).hostname);
    setNetworkRow('network-address-type', ADDRESS_TYPE_LABEL[scope]);
    try {
      localStorage.setItem(BOOTSTRAP_ADDRESS_STORAGE_KEY, override);
    } catch {
      // Storage is optional for this flow.
    }
  } else {
    setNetworkRow('network-address-type', 'AUTO (node hints)');
  }

  const boot = buildOutgoingBootstrap(wtUrl, fingerprint);
  // 🐛 0.16.0: links minted inside the packaged app carried the origin
  // http://tauri.localhost — a WebView-internal host that resolves NOWHERE
  // outside the app, so shared links silently went nowhere when opened in a
  // browser. Mint a scheme-neutral ssf:// carrier instead (the import box
  // parses any URL with a ?seed= param); dev-server origins stay clickable.
  const origin = window.location.origin;
  const isShareableHttpOrigin = origin.startsWith('http')
    && !origin.includes('tauri.localhost')
    && !origin.startsWith('tauri://');
  const seedParam = `seed=${encodeURIComponent(encodeBootstrapSeed(boot))}`;
  return {
    link: isShareableHttpOrigin
      ? `${origin}${window.location.pathname}?${seedParam}`
      : `ssf://room?${seedParam}`,
    scope,
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
 * Sovereign bootstrap: build a share link for OUR OWN node — no existing peer
 * connection required. Primary flow is zero-typing and relies on node hints.
 * Manual address override remains available in diagnostics only.
 */
export async function generateBootstrapLink(): Promise<{ link?: string; error?: string }> {
  return mintBootstrapLink();
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

async function resolveBridgeBootstrap(imported: RoomBootstrap): Promise<RoomBootstrap> {
  const localBoot = await fetchDefaultBootstrap();
  if (!localBoot) {
    return imported;
  }

  const roomId = imported.roomId || localBoot.roomId || 'furlong-lobby';
  const importedHints = collectMemberHints(imported);
  const mergedHints = mergeMemberHints(importedHints, collectMemberHints(localBoot));
  const remoteHint = importedHints[0];

  return {
    ...localBoot,
    v: 2,
    roomId,
    roomKeyB64: imported.roomKeyB64 || localBoot.roomKeyB64 || getOrCreateRoomKeyB64(roomId),
    challenge: imported.challenge ?? localBoot.challenge,
    memberHints: mergedHints.length ? mergedHints : undefined,
    irohNodeId: remoteHint?.irohNodeId,
    irohRelayUrls: remoteHint?.irohRelayUrls,
    irohDirectAddrs: remoteHint?.irohDirectAddrs,
    issuedAt: imported.issuedAt,
    expiresAt: imported.expiresAt,
    sigB64: imported.sigB64,
  };
}

function setupNetworkDetailsPanel() {
  if (networkPanelInitialized) return;
  networkPanelInitialized = true;

  const panel = document.getElementById('network-details-hud');
  const toggle = document.getElementById('network-details-toggle');
  const copyInviteBtn = document.getElementById('network-copy-invite-btn');
  const sharePrimaryInput = document.getElementById('network-share-link-primary') as HTMLInputElement | null;
  const useBtn = document.getElementById('network-use-link-btn');
  const retryBtn = document.getElementById('network-retry-node-btn');
  const importInput = document.getElementById('network-import-link') as HTMLInputElement | null;
  const feedback = document.getElementById('network-link-feedback');

  if (retryBtn) {
    retryBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      localFingerprint = null;
      if (feedback) feedback.textContent = 'Retrying local node handshake...';
      try {
        await networkProvider.disconnect();
      } catch {}
      await bootstrapNetworking();
    });
  }

  // Room Name editing flow (Task: Edit Room Name)
  const nameEl = document.getElementById('room-name-display');
  if (nameEl) {
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const inputExists = document.getElementById('room-name-input');
      if (inputExists) return;

      const currentName = nameEl.textContent || 'Lobby';
      
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'room-name-input';
      input.value = currentName;
      input.maxLength = 24;

      nameEl.replaceWith(input);
      input.focus();

      const saveChanges = () => {
        const newVal = input.value.trim();
        if (newVal) {
          if (yjsSync) {
            const rMap = yjsSync.doc.getMap('roomInfo');
            const ownerVal = rMap.get('owner') as string || 'Local-Clone';
            if (ownerVal === 'Local-Clone') {
              yjsSync.doc.transact(() => {
                rMap.set('name', newVal);
              });
            } else {
              if (feedback) feedback.textContent = `Only the owner (${ownerVal}) can edit the room name.`;
              setTimeout(() => { if (feedback) feedback.textContent = ''; }, 4000);
            }
          } else {
            nameEl.textContent = newVal;
          }
        }
        input.replaceWith(nameEl);
      };

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          saveChanges();
        } else if (ev.key === 'Escape') {
          input.replaceWith(nameEl);
        }
      });

      input.addEventListener('blur', () => {
        saveChanges();
      });
    });
  }

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
      resolveBridgeBootstrap(imported).then(resolved => {
        pendingBootstrapOverride = resolved;
        if (feedback) {
          feedback.textContent = 'Zero-config P2P Seed loaded from URL. Entering lobby...';
        }
      });
      if (importInput) {
        importInput.value = window.location.href;
      }
    }
  }

  if (copyInviteBtn) {
    copyInviteBtn.addEventListener('click', async () => {
      const minted = await mintBootstrapLink();
      if (!minted.link) {
        if (feedback) feedback.textContent = minted.error ?? 'Invite link is not available yet.';
        return;
      }

      if (sharePrimaryInput) {
        sharePrimaryInput.value = minted.link;
      }

      try {
        await navigator.clipboard.writeText(minted.link);
        if (feedback) feedback.textContent = 'Invite copied. Share this one link with everyone.';
      } catch {
        if (feedback) feedback.textContent = 'Invite ready below. Clipboard permission was denied.';
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
      const minted = await mintBootstrapLink(bootstrapAddrInput?.value ?? '');
      if (!minted.link) {
        if (feedback) feedback.textContent = minted.error ?? 'Override invite generation failed.';
        return;
      }

      if (sharePrimaryInput) {
        sharePrimaryInput.value = minted.link;
      }

      if (feedback) {
        feedback.textContent = 'Override invite generated below (diagnostics mode).';
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
      
      const resolved = await resolveBridgeBootstrap(imported);
      pendingBootstrapOverride = resolved;

      if (feedback) feedback.textContent = 'Zero-config P2P seed accepted. Establishing hole-punched link...';
      try {
        await networkProvider.disconnect();
      } catch (err) {
        console.warn('Error disconnecting prior network link:', err);
      }
      await bootstrapNetworking();
    });
  }
}

async function syncShareLink(): Promise<void> {
  const sharePrimaryInput = document.getElementById('network-share-link-primary') as HTMLInputElement | null;
  if (!sharePrimaryInput) {
    return;
  }

  const minted = await mintBootstrapLink();
  if (minted.link) {
    sharePrimaryInput.value = minted.link;
  } else {
    sharePrimaryInput.value = minted.error ?? 'Local node not reachable — launch the app (or Rust node) first.';
  }
}

function encodeBootstrapSeed(boot: RoomBootstrap): string {
  return btoa(JSON.stringify(boot));
}

function decodeBootstrapSeed(seed: string): RoomBootstrap | null {
  try {
    const parsed = JSON.parse(atob(seed));

    const roomId = typeof parsed.roomId === 'string' && parsed.roomId.length > 0
      ? parsed.roomId
      : 'furlong-lobby';

    const rawWtUrl = typeof parsed.wtUrl === 'string' ? parsed.wtUrl : '';
    const certHashesB64 = normalizeStringArray(parsed.certHashesB64);

    const parsedHints: RoomMemberHint[] = [];
    if (Array.isArray(parsed.memberHints)) {
      for (const hint of parsed.memberHints) {
        const normalized = normalizeMemberHint(hint);
        if (normalized) {
          parsedHints.push(normalized);
        }
      }
    }

    if (typeof parsed.irohNodeId === 'string' && parsed.irohNodeId.length > 0) {
      parsedHints.push({
        irohNodeId: parsed.irohNodeId,
        irohRelayUrls: normalizeStringArray(parsed.irohRelayUrls ?? parsed.relays),
        irohDirectAddrs: normalizeStringArray(parsed.irohDirectAddrs),
      });
    }

    const memberHints = mergeMemberHints(parsedHints);
    const inferredV2 = parsed.v === 2
      || (typeof parsed.roomKeyB64 === 'string' && parsed.roomKeyB64.length > 0)
      || memberHints.length > 0;

    let wtUrl = rawWtUrl;
    if (wtUrl) {
      let parsedWtUrl: URL;
      try {
        parsedWtUrl = new URL(wtUrl);
      } catch {
        return null;
      }
      if (parsedWtUrl.protocol !== 'https:') {
        return null;
      }
    } else if (!inferredV2) {
      return null;
    }

    if (!wtUrl) {
      // v2 room-key-first invites can omit transport details and rely on always-bridge.
      wtUrl = 'https://127.0.0.1:4443';
    }

    if (!inferredV2 && certHashesB64.length === 0) {
      return null;
    }

    const primaryHint = memberHints[0];
    const roomKeyB64 = typeof parsed.roomKeyB64 === 'string' && parsed.roomKeyB64.length > 0
      ? parsed.roomKeyB64
      : inferredV2
        ? getOrCreateRoomKeyB64(roomId)
        : undefined;

    return {
      v: inferredV2 ? 2 : 1,
      roomId,
      roomKeyB64,
      wtUrl,
      certHashesB64,
      memberHints: memberHints.length ? memberHints : undefined,
      irohNodeId: primaryHint?.irohNodeId,
      irohRelayUrls: primaryHint?.irohRelayUrls,
      irohDirectAddrs: primaryHint?.irohDirectAddrs,
      issuedAt: typeof parsed.issuedAt === 'number' ? parsed.issuedAt : undefined,
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
      sigB64: typeof parsed.sigB64 === 'string' && parsed.sigB64.length > 0 ? parsed.sigB64 : undefined,
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

function updateHUDNode(status: string, color: string) {
  const nodeEl = document.getElementById('node-status');
  if (nodeEl) {
    nodeEl.textContent = status;
    nodeEl.style.color = color;
  }
}

function updateHUDP2P(status: string, color: string) {
  const p2pEl = document.getElementById('p2p-status');
  if (p2pEl) {
    p2pEl.textContent = status;
    p2pEl.style.color = color;
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
  const zoomInBtn = document.getElementById('map-zoom-in-btn');
  const zoomOutBtn = document.getElementById('map-zoom-out-btn');

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

  if (zoomInBtn) {
    zoomInBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (multiScaleZoom) {
        // Invoke standard zoom-in action via Keyboard Zoom View APIs
        (multiScaleZoom as any).zoomIn();
      }
    });
  }

  if (zoomOutBtn) {
    zoomOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (multiScaleZoom) {
        // Invoke standard zoom-out action via Keyboard Zoom View APIs
        (multiScaleZoom as any).zoomOut();
      }
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

  const { camera, scene } = window.gameRenderer;
  const clickPlane = world.getClickPlane();
  if (!clickPlane) return;

  // Normalised device coordinates
  mouse.x =  (event.clientX / window.innerWidth)  * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // ── Intercept Golden Keypad Clicks for our Docking System
  if (world.dockingSystem) {
    const interactables: THREE.Object3D[] = [];
    scene.traverse((child) => {
      if (child.userData && child.userData.isControlPanel) {
        interactables.push(child);
      }
    });

    const keypadHits = raycaster.intersectObjects(interactables, true);
    if (keypadHits.length > 0) {
      const hit = keypadHits[0];
      const doorId = hit.object.userData.doorId as 'north' | 'south' | 'east' | 'west';
      if (doorId) {
        console.log(`[Raycast Intercept] Golden Terminal Keypad Click on: ${doorId.toUpperCase()}`);
        world.dockingSystem.handlePanelRaycast(doorId);
        return; // Halt navigation routing so player does not walk into the door
      }
    }
  }

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
